import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, acceptSource, closeAll, createRun, get, makeApp, post, preset, runToEnd, step } from './helpers.ts';
import { chatOk, fakeAdapters, imageOk, makeFalFake, makeOpenRouterFake } from './fakes.ts';

afterEach(closeAll);

const costed = () =>
  makeOpenRouterFake(async (call, i) => (call.url.endsWith('/images') ? imageOk() : chatOk(`text ${i}`)));

const chain = () =>
  preset('budgeted', [
    step('image_to_text', MODELS.describe, 'D1', 'b1'), // cost 0.002
    step('text_to_image', MODELS.draw, 'G1', 'b2'), // cost 0.003 → 0.005 total
    step('image_to_text', MODELS.describe, 'D2', 'b3'),
    step('text_to_image', MODELS.draw, 'G2', 'b4'),
  ]);

describe('budget', () => {
  it('pauses before the next paid step once the limit is reached', async () => {
    const or = costed();
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await acceptSource(app);
    const id = (await createRun(app, { preset: chain(), budgetUsd: 0.004 })).json().id;
    await runToEnd(app, id);

    let run = app.runner.view(id);
    expect(run.status).toBe('paused');
    expect(run.statusReason).toMatch(/Budget limit \$0\.00 reached/);
    expect(run.currentStepIndex).toBe(2);
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'pending', 'pending']);
    expect(or.calls).toHaveLength(2); // stopped before the third paid submission
    expect(run.costActualUsd).toBeCloseTo(0.005, 6);
    expect(run.costEstimatedUsd).toBe(0);
    expect(run.costUnknownCount).toBe(0);

    // resume is an explicit one-time override: the limit is cleared
    expect(run.budgetUsd).toBeNull();
    await post(app, `/api/runs/${id}/actions`, { action: 'resume' });
    await app.runner.idle();
    run = app.runner.view(id);
    expect(run.status).toBe('completed');
    expect(or.calls).toHaveLength(4);
    expect(run.costActualUsd).toBeCloseTo(0.01, 6);
  });

  it('runs without a budget when none is configured', async () => {
    const or = costed();
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await acceptSource(app);
    const created = await createRun(app, { preset: chain() });
    expect(created.json().budgetUsd).toBeNull(); // cfg.defaultBudgetUsd
    await runToEnd(app, created.json().id);
    expect(app.runner.view(created.json().id).status).toBe('completed');
  });

  it('counts unknown-cost steps separately and never reports them as $0 actual', async () => {
    const or = costed();
    const fal = makeFalFake(); // fal reports costStatus 'unknown'
    const app = await makeApp({ adapters: fakeAdapters(or, fal) });
    await acceptSource(app);
    const id = (await createRun(app, {
      preset: preset('unknown cost', [
        step('image_to_text', MODELS.describe, 'D', 'u1'),
        step('text_to_image', MODELS.draw, 'G', 'u2'),
        step('image_to_video', MODELS.animate, 'A', 'u3'),
      ]),
    })).json().id;
    await runToEnd(app, id);

    const run = (await get(app, `/api/runs/${id}`)).json();
    expect(run.status).toBe('completed');
    expect(run.costUnknownCount).toBe(1);
    expect(run.costActualUsd).toBeCloseTo(0.005, 6);
    const videoAttempt = run.steps[2].attempts.at(-1);
    expect(videoAttempt.costStatus).toBe('unknown');
    expect(videoAttempt.costUsd).toBeNull(); // not 0
  });

  it('a step of unknown cost is mentioned in the budget pause reason', async () => {
    const or = makeOpenRouterFake(async (call, i) =>
      call.url.endsWith('/images')
        ? imageOk()
        : { json: { id: 'g', choices: [{ message: { content: `text ${i}` }, finish_reason: 'stop' }] } }, // no usage.cost
    );
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await acceptSource(app);
    const id = (await createRun(app, { preset: chain(), budgetUsd: 0.002 })).json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('paused');
    expect(run.statusReason).toMatch(/1 step\(s\) of unknown cost/);
    expect(run.costUnknownCount).toBe(1);
    expect(run.costActualUsd).toBeCloseTo(0.003, 6);
  });

  it('rejects a non-positive budget', async () => {
    const app = await makeApp({ adapters: fakeAdapters(costed(), makeFalFake()) });
    await acceptSource(app);
    expect((await createRun(app, { preset: chain(), budgetUsd: 0 })).statusCode).toBe(400);
    expect((await createRun(app, { preset: chain(), budgetUsd: -1 })).statusCode).toBe(400);
  });
});
