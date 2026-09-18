import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, acceptSource, closeAll, createRun, makeApp, post, preset, step, waitFor } from './helpers.ts';
import { chatOk, fakeAdapters, makeFalFake, makeOpenRouterFake } from './fakes.ts';

afterEach(closeAll);

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const or = makeOpenRouterFake(async (_c, i) => {
    if (i === 0) await gate;
    return chatOk(`text ${i}`);
  });
  return { or, release: () => release() };
}

const chain = () =>
  preset('c', [
    step('image_to_text', MODELS.describe, 'D1', 'c1'),
    step('text_to_text', MODELS.describe, 'D2', 'c2'),
  ]);

describe('concurrency', () => {
  it('two simultaneous start actions produce exactly one 200 and one 409, and one provider call', async () => {
    const { or, release } = gated();
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await acceptSource(app);
    const id = (await createRun(app, { preset: chain() })).json().id;

    const [a, b] = await Promise.all([
      post(app, `/api/runs/${id}/actions`, { action: 'start' }),
      post(app, `/api/runs/${id}/actions`, { action: 'start' }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(or.calls).toHaveLength(1); // no duplicate submission

    release();
    await app.runner.idle();
    expect(app.runner.view(id).status).toBe('completed');
    expect(or.calls).toHaveLength(2); // exactly one call per step, ever
  });

  it('starting a second run while one is running is rejected with 409', async () => {
    const { or, release } = gated();
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await acceptSource(app);
    const first = (await createRun(app, { preset: chain() })).json().id;
    const second = (await createRun(app, { preset: chain(), select: false })).json().id;

    expect((await post(app, `/api/runs/${first}/actions`, { action: 'start' })).statusCode).toBe(200);
    await waitFor(() => or.calls.length === 1, 'the first run to be in flight');

    const res = await post(app, `/api/runs/${second}/actions`, { action: 'start' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/another run is already active/i);
    expect(app.runner.view(second).status).toBe('ready');
    expect(or.calls).toHaveLength(1);

    release();
    await app.runner.idle();
    expect(app.runner.view(first).status).toBe('completed');
  });
});
