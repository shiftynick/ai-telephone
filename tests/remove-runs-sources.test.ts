import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptSource, closeAll, del, get, makeApp, post, quickChain, runToEnd, uploadDesktop, makeJpeg, waitFor } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';

afterEach(closeAll);

const mockApp = (delayMs = 0) => {
  const mock = new MockAdapter('/tmp', delayMs);
  return makeApp({ adapters: { openrouter: mock, fal: mock } });
};

async function finishedRun(app: Awaited<ReturnType<typeof makeApp>>) {
  const run = (await post(app, '/api/runs', { preset: quickChain() })).json();
  await runToEnd(app, run.id);
  const view = (await get(app, `/api/runs/${run.id}`)).json();
  expect(view.status).toBe('completed');
  return view;
}

describe('deleting a run', () => {
  it('removes the run, its steps and the files only it produced; keeps the source', async () => {
    const app = await mockApp();
    await acceptSource(app);
    const run = await finishedRun(app);
    await post(app, '/api/session/select-run', { runId: run.id, replay: false });
    const outputs = run.steps.map((s: any) => s.artifact.id);
    const files = outputs.map((id: string) => app.store.get(id)).filter((a: any) => a?.rel_path).map((a: any) => app.store.absPath(a));
    expect(files.length).toBeGreaterThan(0);

    const res = await del(app, `/api/runs/${run.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((await get(app, `/api/runs/${run.id}`)).statusCode).toBe(404);
    expect((await get(app, '/api/runs')).json().runs.map((r: any) => r.id)).not.toContain(run.id);
    for (const id of outputs) expect(app.store.get(id)).toBeNull();
    for (const f of files) expect(fs.existsSync(f)).toBe(false);
    expect(app.store.get(run.source.id)).not.toBeNull(); // the uploaded photo stays
    expect((await get(app, '/api/session')).json().selectedRunId).toBeNull(); // it was on the projector
    expect((await del(app, `/api/runs/${run.id}`)).statusCode).toBe(404);
  });

  it('keeps an output that another run started from', async () => {
    const app = await mockApp();
    await acceptSource(app);
    const first = await finishedRun(app);
    const reused = first.steps[0].artifact.id; // the first run's description…
    await post(app, '/api/session/source', { artifactId: reused }); // …starts the next run
    const second = (await post(app, '/api/runs', { preset: { ...quickChain(), startingKind: 'text', steps: quickChain().steps.slice(1) } })).json();
    expect(second.source.id).toBe(reused);

    expect((await del(app, `/api/runs/${first.id}`)).statusCode).toBe(200);
    expect(app.store.get(reused)).not.toBeNull();
    expect((await get(app, `/api/runs/${second.id}`)).statusCode).toBe(200);
  });

  it('refuses a running run, and non-hosts', async () => {
    const app = await mockApp(400);
    await acceptSource(app);
    const run = (await post(app, '/api/runs', { preset: quickChain() })).json();
    await post(app, `/api/runs/${run.id}/actions`, { action: 'start' });
    await waitFor(async () => (await get(app, `/api/runs/${run.id}`)).json().status === 'running', 'running');
    const res = await del(app, `/api/runs/${run.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/stop it first/i);
    expect((await del(app, `/api/runs/${run.id}`, { cookie: null })).statusCode).toBe(401);
    await post(app, `/api/runs/${run.id}/actions`, { action: 'stop' });
    await app.runner.idle();
    expect((await del(app, `/api/runs/${run.id}`)).statusCode).toBe(200);
  });
});

describe('removing sources', () => {
  it('hides one source from every list without touching runs', async () => {
    const app = await mockApp();
    const { session } = await acceptSource(app);
    const run = await finishedRun(app);
    const photo = session.source.id;

    const after = (await post(app, `/api/sources/${photo}/hide`)).json();
    expect(after.source).toBeNull();
    expect(after.uploads).toHaveLength(0);
    const ids = (await get(app, '/api/sources')).json().sources.map((s: any) => s.artifact.id);
    expect(ids).not.toContain(photo);
    expect(ids).toContain(run.steps[0].artifact.id); // other sources stay
    expect((await get(app, `/api/runs/${run.id}`)).json().source.id).toBe(photo); // the run still shows it
    expect((await post(app, '/api/sources/art_nope/hide')).statusCode).toBe(404);
  });

  it('clears all sources only when confirmed; later outputs show up again', async () => {
    const app = await mockApp();
    await acceptSource(app);
    await uploadDesktop(app, await makeJpeg(100, 80), 'second.jpg');
    await finishedRun(app);
    expect((await get(app, '/api/sources')).json().sources.length).toBeGreaterThan(2);

    expect((await post(app, '/api/sources/clear', {})).statusCode).toBe(400); // no confirmation
    expect((await post(app, '/api/sources/clear', { confirm: true }, { cookie: null })).statusCode).toBe(401);
    const res = (await post(app, '/api/sources/clear', { confirm: true })).json();
    expect(res.cleared).toBeGreaterThan(2);
    expect(res.session.source).toBeNull();
    expect(res.session.uploads).toHaveLength(0);
    expect((await get(app, '/api/sources')).json().sources).toHaveLength(0);
    expect((await get(app, '/api/runs')).json().runs).toHaveLength(1); // runs are kept

    // a new upload is listed again
    await acceptSource(app);
    expect((await get(app, '/api/sources')).json().sources).toHaveLength(1);
  });
});
