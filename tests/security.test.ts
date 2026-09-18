import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAL_KEY, HOST, MODELS, OPENROUTER_KEY, ORIGIN, acceptSource, closeAll, createRun, get, makeApp, multipartBody,
  post, preset, runToEnd, step, type TestApp,
} from './helpers.ts';
import { chatOk, fakeAdapters, httpError, imageOk, makeFalFake, makeOpenRouterFake } from './fakes.ts';

afterEach(closeAll);

const HOST_ROUTES: [string, string][] = [
  ['GET', '/api/models'],
  ['POST', '/api/models/refresh'],
  ['GET', '/api/presets'],
  ['POST', '/api/presets'],
  ['PUT', '/api/presets/builtin_quick'],
  ['DELETE', '/api/presets/builtin_quick'],
  ['POST', '/api/presets/validate'],
  ['GET', '/api/session'],
  ['POST', '/api/session/rotate'],
  ['POST', '/api/session/uploads'],
  ['POST', '/api/session/source-text'],
  ['POST', '/api/session/uploads/upl_x/accept'],
  ['POST', '/api/session/select-run'],
  ['POST', '/api/session/reveal'],
  ['GET', '/api/lan'],
  ['POST', '/api/lan'],
  ['GET', '/api/runs'],
  ['POST', '/api/runs'],
  ['GET', '/api/runs/run_x'],
  ['POST', '/api/runs/run_x/actions'],
  ['GET', '/api/events'],
  ['GET', '/api/runs/run_x/events'],
];

/** Boots an app, runs image_to_text → text_to_image, leaves auto-reveal off and nothing revealed. */
async function appWithRun() {
  const or = makeOpenRouterFake(async (c) => (c.url.endsWith('/images') ? imageOk() : chatOk('a description')));
  const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
  await acceptSource(app);
  const body = preset('secure run', [
    step('image_to_text', MODELS.describe, 'SECRET-INSTRUCTION-ONE', 's1'),
    step('text_to_image', MODELS.draw, 'SECRET-INSTRUCTION-TWO', 's2'),
  ]);
  const id = (await createRun(app, { preset: body })).json().id;
  await post(app, '/api/session/reveal', { action: 'auto', on: false });
  await runToEnd(app, id);
  await post(app, '/api/session/reveal', { action: 'reset' });
  const session = (await get(app, '/api/session')).json();
  return { app, or, id, session, run: app.runner.view(id) };
}

describe('security', () => {
  it('every host route returns 401 without the host cookie', async () => {
    const app = await makeApp();
    for (const [method, url] of HOST_ROUTES) {
      const res = await app.app.inject({
        method: method as any, url,
        headers: { host: HOST, ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }) },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(`${method} ${url} → ${res.statusCode}`).toBe(`${method} ${url} → 401`);
    }
    const status = await get(app, '/api/status', { cookie: null });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ host: false });
  });

  it('a one-time host code cannot be reused', async () => {
    const app = await makeApp({ login: false });
    const code = app.issueHostCode();
    const first = await post(app, '/api/auth/exchange', { code }, { cookie: null });
    expect(first.statusCode).toBe(200);
    const second = await post(app, '/api/auth/exchange', { code }, { cookie: null });
    expect(second.statusCode).toBe(401);
    expect((await post(app, '/api/auth/exchange', { code: 'x'.repeat(40) }, { cookie: null })).statusCode).toBe(401);
  });

  it('an upload token grants uploads only — not host routes, runs, or media', async () => {
    const { app, session, run } = await appWithRun();
    const token = session.uploadToken as string;

    // it can join and upload
    expect((await get(app, `/api/join/${token}`, { cookie: null })).statusCode).toBe(200);

    // it cannot read host routes or start runs
    for (const [method, url] of HOST_ROUTES.slice(0, 8)) {
      const res = await app.app.inject({
        method: method as any, url,
        headers: { host: HOST, 'x-upload-token': token, ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }) },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await post(app, `/api/runs/${run.id}/actions`, { action: 'start' }, { cookie: null, headers: { 'x-upload-token': token } })).statusCode).toBe(401);

    // and it cannot read media, even of a revealed artifact
    await post(app, '/api/session/reveal', { action: 'show', stage: 2 });
    const media = await get(app, `/media/${run.steps[1].artifact!.id}?t=${token}`, { cookie: null });
    expect(media.statusCode).toBe(404);
    // nor read the projector state
    expect((await get(app, `/api/present/${token}/state`, { cookie: null })).statusCode).toBe(404);
  });

  it('a projector token is read-only and cannot mutate anything', async () => {
    const { app, session, run } = await appWithRun();
    const t = session.projectorToken as string;
    const mutations: [string, string, unknown][] = [
      ['POST', `/api/runs/${run.id}/actions`, { action: 'start' }],
      ['POST', '/api/session/reveal', { action: 'next' }],
      ['POST', '/api/session/rotate', { which: 'upload' }],
      ['POST', '/api/presets', {}],
      ['POST', '/api/session/select-run', { runId: null }],
    ];
    for (const [method, url, payload] of mutations) {
      const res = await app.app.inject({
        method: method as any, url,
        headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-projector-token': t },
        payload: payload as any,
      });
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 401`);
    }
    expect(app.runner.view(run.id).status).toBe('completed'); // untouched
  });

  it('/media with a projector token is 404 for unrevealed artifacts and 200 once revealed', async () => {
    const { app, session, run } = await appWithRun();
    const t = session.projectorToken as string;
    const imageId = run.steps[1].artifact!.id;
    const sourceId = run.source.id;

    expect((await get(app, `/media/${imageId}?t=${t}`, { cookie: null })).statusCode).toBe(404);
    expect((await get(app, `/media/${sourceId}?t=${t}`, { cookie: null })).statusCode).toBe(404);

    await post(app, '/api/session/reveal', { action: 'show', stage: 2 });
    const ok = await get(app, `/media/${imageId}?t=${t}`, { cookie: null });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^image\//);
    // the still-unrevealed source stays hidden
    expect((await get(app, `/media/${sourceId}?t=${t}`, { cookie: null })).statusCode).toBe(404);
    // the host can always read it
    expect((await get(app, `/media/${sourceId}`)).statusCode).toBe(200);
  });

  it('present state exposes no artifact id, text, or instruction for unrevealed stages', async () => {
    const { app, session, run } = await appWithRun();
    const t = session.projectorToken as string;
    const state = (await get(app, `/api/present/${t}/state`, { cookie: null })).json();
    expect(state.hasRun).toBe(true);
    expect(state.stages).toHaveLength(3);
    expect(state.stages.every((s: any) => s.revealed === false)).toBe(true);
    for (const s of state.stages) {
      expect(s.artifact).toBeUndefined();
      expect(s.instruction).toBeUndefined();
    }
    const json = JSON.stringify(state);
    expect(json).not.toContain('SECRET-INSTRUCTION-ONE');
    expect(json).not.toContain('SECRET-INSTRUCTION-TWO');
    expect(json).not.toContain('a description');
    expect(json).not.toContain(run.steps[1].artifact!.id);
    expect(json).not.toContain(run.source.id);
    // model ids and labels are fine (they are the projector chrome)
    expect(state.stages[1].modelId).toBe(MODELS.describe);

    await post(app, '/api/session/reveal', { action: 'show', stage: 1 });
    const after = (await get(app, `/api/present/${t}/state`, { cookie: null })).json();
    expect(after.stages[1].revealed).toBe(true);
    expect(after.stages[1].artifact.text).toBe('a description');
    expect(after.stages[1].instruction).toBe('SECRET-INSTRUCTION-ONE');
    expect(after.stages[2].artifact).toBeUndefined();
  });

  it('rotated tokens stop working immediately', async () => {
    const { app, session } = await appWithRun();
    const oldUpload = session.uploadToken as string;
    const oldProjector = session.projectorToken as string;
    expect((await get(app, `/api/join/${oldUpload}`, { cookie: null })).statusCode).toBe(200);
    expect((await get(app, `/api/present/${oldProjector}/state`, { cookie: null })).statusCode).toBe(200);

    const rotated = (await post(app, '/api/session/rotate', { which: 'both' })).json();
    expect(rotated.uploadToken).not.toBe(oldUpload);
    expect(rotated.projectorToken).not.toBe(oldProjector);

    expect((await get(app, `/api/join/${oldUpload}`, { cookie: null })).statusCode).toBe(404);
    expect((await get(app, `/api/present/${oldProjector}/state`, { cookie: null })).statusCode).toBe(404);
    expect((await get(app, `/api/join/${rotated.uploadToken}`, { cookie: null })).statusCode).toBe(200);
  });

  it('rejects an unrecognized Host header with 421', async () => {
    const app = await makeApp();
    for (const host of ['evil.example.com', 'localhost:9999', 'localhost', '']) {
      const res = await app.app.inject({ method: 'GET', url: '/api/status', headers: { host, cookie: app.cookie } });
      expect(res.statusCode).toBe(421);
    }
    expect((await get(app, '/api/status')).statusCode).toBe(200);
  });

  it('rejects a missing or foreign Origin on non-GET requests with 403', async () => {
    const app = await makeApp();
    const bad = ['', 'http://evil.example.com', 'https://localhost:8787', 'null', 'http://localhost:9999'];
    for (const origin of bad) {
      const res = await app.app.inject({
        method: 'POST', url: '/api/presets/validate',
        headers: { host: HOST, cookie: app.cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        payload: {},
      });
      expect(`${origin || '(none)'} → ${res.statusCode}`).toBe(`${origin || '(none)'} → 403`);
    }
  });

  it('path traversal attempts on /media return 404', async () => {
    const { app, run } = await appWithRun();
    const attempts = [
      '/media/..%2f..%2fetc%2fpasswd',
      '/media/%2e%2e%2f%2e%2e%2ftelephone.sqlite',
      '/media/art_..%2f..%2ftelephone.sqlite',
      '/media/telephone.sqlite',
      `/media/${run.steps[1].artifact!.id}%2f..%2f..%2ftelephone.sqlite`,
      '/media/art_' + 'A'.repeat(60), // beyond the id length bound
      '/media/art_short',
    ];
    for (const url of attempts) {
      const res = await get(app, url);
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 404`);
    }
  });

  it('never leaks either API key into responses, run views, or the database', async () => {
    const or = makeOpenRouterFake(async () => httpError(401, `Invalid key ${OPENROUTER_KEY} supplied (Bearer ${OPENROUTER_KEY})`));
    const fal = makeFalFake({ submitThrows: () => Object.assign(new Error(`fal auth failed for ${FAL_KEY}`), { status: 401 }) });
    const app = await makeApp({ adapters: fakeAdapters(or, fal) });
    app.runner.backoffMs = 1;
    await acceptSource(app);

    const textRun = (await createRun(app, { preset: preset('leak', [step('image_to_text', MODELS.describe, 'D', 'l1')]) })).json().id;
    await runToEnd(app, textRun);
    const videoRun = (await createRun(app, { preset: preset('leak2', [step('image_to_video', MODELS.animate, 'A', 'l2')]), select: false })).json().id;
    await runToEnd(app, videoRun);

    expect(app.runner.view(textRun).steps[0].attempts[0].errorKind).toBe('auth');
    expect(app.runner.view(videoRun).steps[0].attempts[0].errorKind).toBe('auth');

    const blobs: string[] = [
      (await get(app, '/api/status')).body,
      (await get(app, `/api/runs/${textRun}`)).body,
      (await get(app, `/api/runs/${videoRun}`)).body,
      (await get(app, '/api/runs')).body,
      (await get(app, '/api/session')).body,
      JSON.stringify(app.db.prepare('SELECT * FROM attempts').all()),
      JSON.stringify(app.db.prepare('SELECT * FROM events').all()),
      JSON.stringify(app.db.prepare('SELECT * FROM runs').all()),
    ];
    for (const b of blobs) {
      expect(b).not.toContain(OPENROUTER_KEY);
      expect(b).not.toContain('SECRET123456');
      expect(b).not.toContain(FAL_KEY);
      expect(b).not.toContain('SECRET-654321');
    }
    // the error message survives, redacted
    expect((await get(app, `/api/runs/${textRun}`)).body).toContain('[redacted]');
    expect(JSON.parse((await get(app, '/api/status')).body).keys).toEqual({ openrouter: true, fal: true });
  });
});

describe('LAN listener', () => {
  it('never grants host powers even with a valid host cookie, but allows join/upload/present', async () => {
    const or = makeOpenRouterFake();
    const app: TestApp = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await app.app.ready();
    const server = http.createServer((req, res) => {
      (req as any).isLan = true;
      app.app.routing(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    app.allowedHosts.add(`127.0.0.1:${port}`);
    try {
      await acceptSource(app);
      const session = (await get(app, '/api/session')).json();
      const cookie = app.cookie;

      // host routes are denied over LAN even with the cookie
      for (const url of ['/api/session', '/api/runs', '/api/presets', '/api/models']) {
        const r = await fetch(base + url, { headers: { cookie } });
        expect(`${url} → ${r.status}`).toBe(`${url} → 401`);
      }
      const statusRes = await fetch(base + '/api/status', { headers: { cookie } });
      expect(await statusRes.json()).toEqual({ host: false });

      // host login is refused over LAN
      const exchange = await fetch(base + '/api/auth/exchange', {
        method: 'POST',
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ code: app.issueHostCode() }),
      });
      expect(exchange.status).toBe(403);

      // media is not readable with a host cookie over LAN
      const mediaRes = await fetch(`${base}/media/${session.source.id}`, { headers: { cookie } });
      expect(mediaRes.status).toBe(404);

      // join / upload / present still work
      const join = await fetch(`${base}/api/join/${session.uploadToken}`);
      expect(join.status).toBe(200);
      const present = await fetch(`${base}/api/present/${session.projectorToken}/state`);
      expect(present.status).toBe(200);

      const jpeg = app.store.readBytes(app.store.get(session.source.id)!);
      const m = multipartBody('file', 'phone.jpg', 'image/jpeg', jpeg);
      const up = await fetch(`${base}/api/sessions/${session.id}/uploads`, {
        method: 'POST',
        headers: { ...m.headers, origin: base, 'x-upload-token': session.uploadToken },
        body: new Uint8Array(m.body),
      });
      expect(up.status).toBe(200);
      expect((await up.json()).ok).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
