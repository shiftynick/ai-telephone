import { afterEach, describe, expect, it } from 'vitest';
import {
  MODELS, acceptSource, closeAll, createRun, makeApp, makeMp4, post, preset, runToEnd, step, type TestApp,
} from './helpers.ts';
import { chatOk, fakeAdapters, httpError, imageOk, makeFalFake, makeOpenRouterFake, type FakeResponse, type OpenRouterFake } from './fakes.ts';
import { MediaError } from '../server/media.ts';

afterEach(closeAll);

const describeOnly = () => preset('errs', [step('image_to_text', MODELS.describe, 'DESCRIBE', 'e1')]);
const drawOnly = () => preset('errs', [step('text_to_text', MODELS.describe, 'RETELL', 'e0'), step('text_to_image', MODELS.draw, 'DRAW', 'e1')]);

async function chatRun(handler: (call: any, i: number) => FakeResponse | Promise<FakeResponse>) {
  const or = makeOpenRouterFake(handler as any);
  const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
  app.runner.backoffMs = 1;
  await acceptSource(app);
  const id = (await createRun(app, { preset: describeOnly() })).json().id;
  await runToEnd(app, id);
  return { app, or, id, run: app.runner.view(id) };
}

describe('provider errors', () => {
  it('401 fails with kind auth and is never auto-retried', async () => {
    const { or, run } = await chatRun(async () => httpError(401, 'No auth credentials found'));
    expect(or.calls).toHaveLength(1);
    expect(run.status).toBe('failed');
    const a = run.steps[0].attempts;
    expect(a).toHaveLength(1);
    expect(a[0].status).toBe('failed');
    expect(a[0].errorKind).toBe('auth');
  });

  it('429 with Retry-After is auto-retried and then succeeds', async () => {
    const { or, run } = await chatRun(async (_c, i) =>
      i === 0 ? httpError(429, 'rate limited', { 'retry-after': '1' }) : chatOk('recovered'),
    );
    expect(or.calls).toHaveLength(2);
    expect(run.status).toBe('completed');
    expect(run.steps[0].attempts).toHaveLength(2);
    expect(run.steps[0].attempts[0].errorKind).toBe('rate_limited');
    expect(run.steps[0].attempts[1].status).toBe('succeeded');
  });

  it('persistent 429 retries a bounded number of times, each as a new attempt row', async () => {
    const { or, run } = await chatRun(async () => httpError(429, 'rate limited'));
    expect(or.calls.length).toBeLessThanOrEqual(3);
    expect(or.calls.length).toBe(3);
    const a = run.steps[0].attempts;
    expect(a).toHaveLength(3);
    expect(new Set(a.map((x) => x.id)).size).toBe(3); // history preserved, distinct attempts
    expect(a.every((x) => x.errorKind === 'rate_limited')).toBe(true);
    expect(run.status).toBe('failed');
  });

  it('503 is retried', async () => {
    const { or, run } = await chatRun(async (_c, i) => (i < 2 ? httpError(503, 'upstream down') : chatOk('back up')));
    expect(or.calls).toHaveLength(3);
    expect(run.status).toBe('completed');
    expect(run.steps[0].attempts[0].errorKind).toBe('server_error');
  });

  it('a network failure is ambiguous: attempt unknown, no auto retry, retry needs billing ack', async () => {
    const or = makeOpenRouterFake(async () => ({ throws: new TypeError('fetch failed') }));
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    app.runner.backoffMs = 1;
    await acceptSource(app);
    const id = (await createRun(app, { preset: describeOnly() })).json().id;
    await runToEnd(app, id);
    let run = app.runner.view(id);
    expect(or.calls).toHaveLength(1);
    expect(run.status).toBe('failed');
    expect(run.steps[0].status).toBe('unknown');
    expect(run.steps[0].attempts[0].status).toBe('unknown');
    expect(run.steps[0].attempts[0].errorKind).toBe('ambiguous');

    const blocked = await post(app, `/api/runs/${id}/actions`, { action: 'retry' });
    expect(blocked.statusCode).toBe(428);
    expect(or.calls).toHaveLength(1);

    or.handler = async () => chatOk('worked this time');
    const okRes = await post(app, `/api/runs/${id}/actions`, { action: 'retry', acknowledgeBilling: true });
    expect(okRes.statusCode).toBe(200);
    await app.runner.idle();
    run = app.runner.view(id);
    expect(run.status).toBe('completed');
    expect(or.calls).toHaveLength(2);
    expect(run.steps[0].attempts).toHaveLength(2); // history preserved
  });

  it('corrupt image bytes fail with corrupt_media', async () => {
    const or = makeOpenRouterFake(async (call) => {
      if (call.url.endsWith('/images')) {
        return { json: { created: 1, data: [{ b64_json: Buffer.alloc(400, 7).toString('base64') }], usage: { cost: 0.001 } } };
      }
      return chatOk('a description');
    });
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    app.runner.backoffMs = 1;
    await app.app.inject({ method: 'POST', url: '/api/session/source-text', headers: { host: 'localhost:8787', origin: 'http://localhost:8787', 'content-type': 'application/json', cookie: app.cookie }, payload: { text: 'a starting sentence' } });
    const id = (await createRun(app, { preset: { ...drawOnly(), startingKind: 'text' } })).json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('failed');
    expect(run.steps[1].attempts.at(-1)!.errorKind).toBe('corrupt_media');
    expect(run.steps[1].artifact).toBeUndefined();
  });

  it('a non-MP4 video download fails with corrupt_media', async () => {
    const or = makeOpenRouterFake();
    const fal = makeFalFake({ download: async () => Buffer.from('this is definitely not an mp4 file at all') });
    const app = await makeApp({ adapters: fakeAdapters(or, fal) });
    app.runner.backoffMs = 1;
    await acceptSource(app);
    const id = (await createRun(app, { preset: preset('v', [step('image_to_video', MODELS.animate, 'ANIMATE', 'v1')]) })).json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('failed');
    expect(run.steps[0].attempts.at(-1)!.errorKind).toBe('corrupt_media');
  });

  it('an expired provider URL fails, and retry reconciles the SAME request id without resubmitting', async () => {
    let downloads = 0;
    const fal = makeFalFake({
      download: async () => {
        downloads++;
        if (downloads === 1) throw new MediaError('expired_url', 'Media download failed with HTTP 403.');
        return makeMp4();
      },
    });
    const app = await makeApp({ adapters: fakeAdapters(makeOpenRouterFake(), fal) });
    app.runner.backoffMs = 1;
    await acceptSource(app);
    const id = (await createRun(app, { preset: preset('v', [step('image_to_video', MODELS.animate, 'ANIMATE', 'v1')]) })).json().id;
    await runToEnd(app, id);
    let run = app.runner.view(id);
    expect(run.status).toBe('failed');
    expect(run.steps[0].attempts.at(-1)!.errorKind).toBe('expired_url');
    const requestId = run.steps[0].attempts.at(-1)!.providerRequestId;
    expect(requestId).toBe('fal-req-1');
    expect(fal.submits).toHaveLength(1);

    const res = await post(app, `/api/runs/${id}/actions`, { action: 'retry' });
    expect(res.statusCode).toBe(200);
    await app.runner.idle();
    run = app.runner.view(id);
    expect(run.status).toBe('completed');
    expect(fal.submits).toHaveLength(1); // never resubmitted
    expect(fal.uploads).toHaveLength(1);
    expect(fal.resultCalls.every((c) => c.requestId === requestId)).toBe(true);
    expect(fal.statusCalls.every((c) => c.requestId === requestId)).toBe(true);
  });

  it('a disk-write failure yields kind disk and commits no artifact row', async () => {
    const or = makeOpenRouterFake(async (call) => (call.url.endsWith('/images') ? imageOk() : chatOk('text')));
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    app.runner.backoffMs = 1;
    await acceptSource(app);
    const before = (app.db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as any).c;
    app.store.failWrites = true;
    const id = (await createRun(app, {
      preset: preset('d', [step('image_to_text', MODELS.describe, 'D', 'd1'), step('text_to_image', MODELS.draw, 'DRAW', 'd2')]),
    })).json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('failed');
    expect(run.steps[1].status).toBe('failed');
    expect(run.steps[1].attempts.at(-1)!.errorKind).toBe('disk');
    expect(run.steps[1].artifact).toBeUndefined();
    const after = (app.db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as any).c;
    expect(after).toBe(before + 1); // only the step-1 text artifact
  });
});
