import { afterEach, describe, expect, it } from 'vitest';
import {
  MODELS, acceptSource, closeAll, createRun, hangForever, makeApp, post, preset, step, testConfig, waitFor,
} from './helpers.ts';
import { fakeAdapters, makeFalFake, makeOpenRouterFake } from './fakes.ts';

afterEach(closeAll);

describe('restart recovery', () => {
  it('reconciles a known fal job after a crash instead of resubmitting', async () => {
    const cfg = testConfig();

    // --- first process: submits, then the "machine dies" while polling ---
    let statusCalls = 0;
    const fal1 = makeFalFake({});
    (fal1.client as any).status = async (endpoint: string, requestId: string) => {
      fal1.statusCalls.push({ endpoint, requestId });
      statusCalls++;
      if (statusCalls === 1) return { status: 'IN_QUEUE' };
      return hangForever<{ status: string }>(); // process is gone; nothing more is ever written
    };
    const app1 = await makeApp({ cfg, adapters: fakeAdapters(makeOpenRouterFake(), fal1) });
    await acceptSource(app1);
    const id = (await createRun(app1, { preset: preset('v', [step('image_to_video', MODELS.animate, 'ANIMATE', 'v1')]) })).json().id;
    await post(app1, `/api/runs/${id}/actions`, { action: 'start' });
    await waitFor(
      () => !!(app1.db.prepare('SELECT provider_request_id AS r FROM attempts').get() as any)?.r,
      'a provider_request_id to be persisted',
    );
    const requestId = (app1.db.prepare('SELECT provider_request_id AS r FROM attempts').get() as any).r;
    expect(fal1.submits).toHaveLength(1);
    expect((app1.db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as any).status).toBe('running');

    // --- second process on the same data dir: recover() runs inside buildApp ---
    const fal2 = makeFalFake({ statuses: ['COMPLETED'] });
    const app2 = await makeApp({ cfg, adapters: fakeAdapters(makeOpenRouterFake(), fal2) });
    let run = app2.runner.view(id);
    expect(run.status).toBe('paused');
    expect(run.statusReason).toMatch(/reconcile/i);
    expect(run.statusReason).toMatch(/no resubmission/i);

    const res = await post(app2, `/api/runs/${id}/actions`, { action: 'resume' });
    expect(res.statusCode).toBe(200);
    await app2.runner.idle();
    run = app2.runner.view(id);

    expect(run.status).toBe('completed');
    expect(fal2.submits).toHaveLength(0); // never submitted again
    expect(fal2.uploads).toHaveLength(0);
    expect(fal2.statusCalls.length).toBeGreaterThan(0);
    expect(fal2.statusCalls.every((c) => c.requestId === requestId)).toBe(true);
    expect(fal2.resultCalls.map((c) => c.requestId)).toEqual([requestId]);
    // the reconciled attempt is the same row, not a second submission
    expect(run.steps[0].attempts).toHaveLength(1);
    expect(run.steps[0].attempts[0].providerRequestId).toBe(requestId);
  });

  it('marks an interrupted synchronous OpenRouter attempt unknown and warns about billing', async () => {
    const cfg = testConfig();
    const or1 = makeOpenRouterFake(async () => hangForever());
    const app1 = await makeApp({ cfg, adapters: fakeAdapters(or1, makeFalFake()) });
    await acceptSource(app1);
    const id = (await createRun(app1, { preset: preset('t', [step('image_to_text', MODELS.describe, 'D', 't1')]) })).json().id;
    await post(app1, `/api/runs/${id}/actions`, { action: 'start' });
    await waitFor(() => or1.calls.length === 1, 'the chat request to be in flight');
    expect((app1.db.prepare('SELECT status FROM attempts').get() as any).status).toBe('submitting');

    const app2 = await makeApp({ cfg, adapters: fakeAdapters(makeOpenRouterFake(), makeFalFake()) });
    const run = app2.runner.view(id);
    expect(run.status).toBe('failed');
    expect(run.statusReason).toMatch(/unknown/i);
    expect(run.statusReason).toMatch(/bill/i);
    expect(run.steps[0].status).toBe('unknown');
    expect(run.steps[0].attempts[0].status).toBe('unknown');
    expect(run.steps[0].attempts[0].errorKind).toBe('ambiguous');
    expect(run.steps[0].attempts[0].providerRequestId).toBeUndefined();

    // and a retry still requires an explicit billing acknowledgement
    expect((await post(app2, `/api/runs/${id}/actions`, { action: 'retry' })).statusCode).toBe(428);
  });
});
