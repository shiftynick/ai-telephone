import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, acceptSource, closeAll, createRun, makeApp, post, preset, step, waitFor } from './helpers.ts';
import { chatOk, fakeAdapters, makeFalFake, makeOpenRouterFake } from './fakes.ts';

afterEach(closeAll);

const chain = () =>
  preset('p', [
    step('image_to_text', MODELS.describe, 'P1', 'p1'),
    step('text_to_text', MODELS.describe, 'P2', 'p2'),
    step('text_to_text', MODELS.describe, 'P3', 'p3'),
  ]);

async function setup(gateFirst = true) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const or = makeOpenRouterFake(async (_c, i) => {
    if (gateFirst && i === 0) await gate;
    return chatOk(`output ${i}`);
  });
  const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
  await acceptSource(app);
  const id = (await createRun(app, { preset: chain() })).json().id;
  return { app, or, id, release: () => release() };
}

describe('pause / next / stop', () => {
  it('pause finishes the in-flight step and schedules no successor', async () => {
    const { app, or, id, release } = await setup();
    await post(app, `/api/runs/${id}/actions`, { action: 'start' });
    await waitFor(() => or.calls.length === 1, 'step 1 in flight');

    const paused = await post(app, `/api/runs/${id}/actions`, { action: 'pause' });
    expect(paused.statusCode).toBe(200);
    release();
    await app.runner.idle();

    const run = app.runner.view(id);
    expect(run.status).toBe('paused');
    expect(run.steps[0].status).toBe('succeeded'); // the in-flight step was finished and persisted
    expect(run.steps[1].status).toBe('pending');
    expect(run.currentStepIndex).toBe(1);
    expect(or.calls).toHaveLength(1);

    // resuming continues from where it stopped
    await post(app, `/api/runs/${id}/actions`, { action: 'resume' });
    await app.runner.idle();
    expect(app.runner.view(id).status).toBe('completed');
    expect(or.calls).toHaveLength(3);
  });

  it('next runs exactly one step', async () => {
    const { app, or, id } = await setup(false);
    await post(app, `/api/runs/${id}/actions`, { action: 'next' });
    await app.runner.idle();
    let run = app.runner.view(id);
    expect(or.calls).toHaveLength(1);
    expect(run.status).toBe('paused');
    expect(run.statusReason).toMatch(/one step/i);
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'pending', 'pending']);

    await post(app, `/api/runs/${id}/actions`, { action: 'next' });
    await app.runner.idle();
    run = app.runner.view(id);
    expect(or.calls).toHaveLength(2);
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'pending']);
  });

  it('stop halts the pipeline; a late result may be stored but nothing further is submitted', async () => {
    const { app, or, id, release } = await setup();
    await post(app, `/api/runs/${id}/actions`, { action: 'start' });
    await waitFor(() => or.calls.length === 1, 'step 1 in flight');

    const stopped = await post(app, `/api/runs/${id}/actions`, { action: 'stop' });
    expect(stopped.statusCode).toBe(200);
    expect(app.runner.view(id).status).toBe('stopped');

    release();
    await app.runner.idle();
    const run = app.runner.view(id);
    expect(run.status).toBe('stopped');
    expect(run.statusReason).toMatch(/billed/i);
    expect(or.calls).toHaveLength(1); // no further provider calls after stop
    expect(run.steps[1].status).toBe('pending');

    // and a stopped run cannot be started again
    const again = await post(app, `/api/runs/${id}/actions`, { action: 'start' });
    expect(again.statusCode).toBe(409);
    expect(or.calls).toHaveLength(1);
  });
});
