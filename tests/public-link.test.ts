import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeAll, get, login, makeJpeg, post, testConfig, uploadDesktop, noCatalog } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { buildApp, type PublicControl } from '../server/app.ts';

afterEach(closeAll);

/**
 * The public phone link (Tailscale Funnel in production) is a loopback listener whose requests are flagged
 * isPublic. Here a local HTTP server stands in for the funnel: same flags, a fake public Host name.
 */
async function publicSetup() {
  const mock = new MockAdapter('/tmp', 0);
  let active: ReturnType<PublicControl['active']> = null;
  const pub: PublicControl = { active: () => active, set: async (on) => { active = on ? { url: 'https://demo.example.ts.net', host: 'demo.example.ts.net', port: 0 } : null; } };
  const a = await buildApp(testConfig(), { adapters: { openrouter: mock, fal: mock }, pub, catalogFetch: noCatalog });
  const app = Object.assign(a, { cookie: await login(a) }) as any;
  await app.app.ready();
  const server = http.createServer((req, res) => { (req as any).isLan = true; (req as any).isPublic = true; app.app.routing(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  // every request carries the public Host header, as it would through the funnel
  const pubFetch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: 'demo.example.ts.net', ...(init.headers ?? {}) } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    });
  return { app, server, pubFetch };
}

describe('public phone link', () => {
  it('is off until the host turns it on; then only the phone routes answer, with no host powers even with a cookie', async () => {
    const { app, server, pubFetch } = await publicSetup();
    try {
      expect((await get(app, '/api/public')).json()).toEqual({ available: true, active: null });
      // before it is on, the public Host name is not allowed at all
      const session0 = (await get(app, '/api/session')).json();
      expect((await pubFetch(`/api/join/${session0.uploadToken}`)).status).toBe(421);

      const on = await post(app, '/api/public', { on: true });
      expect(on.json().active).toMatchObject({ url: 'https://demo.example.ts.net' });
      const session = (await get(app, '/api/session')).json();
      const cookie = app.cookie;

      // the phone can join and upload over https
      expect((await pubFetch(`/api/join/${session.uploadToken}`)).status).toBe(200);
      const page = await pubFetch(`/join/${session.uploadToken}`);
      expect([200, 404]).toContain(page.status); // 404 only when the frontend is not built in this checkout
      const text = await pubFetch(`/api/sessions/${session.id}/text`, {
        method: 'POST',
        headers: { origin: 'https://demo.example.ts.net', 'content-type': 'application/json', 'x-upload-token': session.uploadToken },
        body: JSON.stringify({ text: 'a duck on a book' }),
      });
      expect(text.status, text.body).toBe(200);

      // everything else is simply not there, cookie or not
      for (const url of ['/api/session', '/api/runs', '/api/presets', '/api/models', '/api/status', '/api/public', '/host', '/', `/present/${session.projectorToken}`, `/api/present/${session.projectorToken}/state`, '/api/events']) {
        const r = await pubFetch(url, { headers: { cookie } });
        expect(`${url} → ${r.status}`).toBe(`${url} → 404`);
      }
      const exchange = await pubFetch('/api/auth/exchange', { method: 'POST', headers: { cookie, origin: 'https://demo.example.ts.net', 'content-type': 'application/json' }, body: JSON.stringify({ code: app.issueHostCode() }) });
      expect(exchange.status).toBe(404);
      // a POST from another site is refused
      const csrf = await pubFetch(`/api/sessions/${session.id}/text`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-upload-token': session.uploadToken }, body: '{"text":"x"}' });
      expect(csrf.status).toBe(403);
      // a wrong upload token is refused
      const bad = await pubFetch(`/api/sessions/${session.id}/text`, { method: 'POST', headers: { origin: 'https://demo.example.ts.net', 'content-type': 'application/json', 'x-upload-token': 'nope-nope-nope' }, body: '{"text":"x"}' });
      expect(bad.status).toBe(401);

      // the upload waits for the host, like any phone upload
      expect((await get(app, '/api/session')).json().uploads[0]).toMatchObject({ status: 'pending', origin: 'phone-text' });

      // turning it off removes the public Host name again
      await post(app, '/api/public', { on: false });
      expect((await pubFetch(`/api/join/${session.uploadToken}`)).status).toBe(421);
    } finally {
      server.close();
      await app.app.close();
    }
  });

  it('host-only: the switch itself needs the host', async () => {
    const { app, server } = await publicSetup();
    try {
      expect((await post(app, '/api/public', { on: true }, { cookie: null })).statusCode).toBe(401);
      expect((await get(app, '/api/public', { cookie: null })).statusCode).toBe(401);
      // still works normally for the host on this computer
      expect((await uploadDesktop(app, await makeJpeg(64, 48), 'x.jpg')).statusCode).toBe(200);
    } finally {
      server.close();
      await app.app.close();
    }
  });
});
