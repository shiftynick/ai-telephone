import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, post, testConfig } from './helpers.ts';

afterEach(closeAll);

const tokenOf = async (app: Awaited<ReturnType<typeof makeApp>>) => {
  const s = (await get(app, '/api/session')).json();
  return { id: s.id as string, token: s.uploadToken as string };
};

describe('phone starting text', () => {
  it('accepts a sentence from the phone and leaves it pending host approval', async () => {
    const app = await makeApp();
    const { id, token } = await tokenOf(app);
    const res = await post(app, `/api/sessions/${id}/text`, { text: '  a red bicycle leaning on a lighthouse  ' }, {
      cookie: null,
      headers: { 'x-upload-token': token },
    });
    expect(res.statusCode).toBe(200);

    const session = (await get(app, '/api/session')).json();
    expect(session.uploads).toHaveLength(1);
    expect(session.uploads[0]).toMatchObject({ origin: 'phone-text', status: 'pending' });
    expect(session.uploads[0].artifact.kind).toBe('text');
    expect(session.uploads[0].artifact.text).toBe('a red bicycle leaning on a lighthouse'); // trimmed
    expect(session.source).toBeNull(); // the phone cannot make itself the source

    await post(app, `/api/session/uploads/${session.uploads[0].id}/accept`);
    const after = (await get(app, '/api/session')).json();
    expect(after.source.kind).toBe('text');
    expect(after.source.text).toBe('a red bicycle leaning on a lighthouse');
  });

  it('rejects a missing, wrong, or rotated upload token', async () => {
    const app = await makeApp();
    const { id, token } = await tokenOf(app);
    const body = { text: 'hello' };
    expect((await post(app, `/api/sessions/${id}/text`, body, { cookie: null })).statusCode).toBe(401);
    expect((await post(app, `/api/sessions/${id}/text`, body, { cookie: null, headers: { 'x-upload-token': 'x'.repeat(43) } })).statusCode).toBe(401);
    // the projector token must not work here either
    const projector = (await get(app, '/api/session')).json().projectorToken;
    expect((await post(app, `/api/sessions/${id}/text`, body, { cookie: null, headers: { 'x-upload-token': projector } })).statusCode).toBe(401);

    await post(app, '/api/session/rotate', { which: 'upload' });
    expect((await post(app, `/api/sessions/${id}/text`, body, { cookie: null, headers: { 'x-upload-token': token } })).statusCode).toBe(401);
  });

  it('rejects empty or oversized text, and honours the per-session upload limit', async () => {
    const app = await makeApp({ cfg: testConfig({ maxUploadsPerSession: 2 }) });
    const { id, token } = await tokenOf(app);
    const send = (text: string) => post(app, `/api/sessions/${id}/text`, { text }, { cookie: null, headers: { 'x-upload-token': token } });

    expect((await send('   ')).statusCode).toBe(400);
    expect((await send('x'.repeat(2001))).statusCode).toBe(400);
    expect((await send('one')).statusCode).toBe(200);
    expect((await send('two')).statusCode).toBe(200);
    expect((await send('three')).statusCode).toBe(429);
    expect((await get(app, '/api/session')).json().uploads).toHaveLength(2);
  });

  it('gives an upload token no other powers', async () => {
    const app = await makeApp();
    const { token } = await tokenOf(app);
    const h = { 'x-upload-token': token };
    expect((await get(app, '/api/runs', { cookie: null, headers: h })).statusCode).toBe(401);
    expect((await post(app, '/api/session/select-run', { runId: null, replay: false }, { cookie: null, headers: h })).statusCode).toBe(401);
    expect((await post(app, '/api/session/source-text', { text: 'nope' }, { cookie: null, headers: h })).statusCode).toBe(401);
  });
});
