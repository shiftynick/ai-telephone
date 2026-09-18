import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODELS, acceptSource, closeAll, createRun, get, makeApp, makeDataDir, post, preset, runToEnd, step, testConfig,
} from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { exportRun, importRunBundle } from '../server/fixtures.ts';

afterEach(closeAll);

async function completedMockRun() {
  const cfg = testConfig();
  const mock = new MockAdapter(cfg.tmpDir, 0);
  const app = await makeApp({ cfg, adapters: { openrouter: mock, fal: mock } });
  await acceptSource(app);
  const id = (await createRun(app, {
    preset: preset('rehearsal', [
      step('image_to_text', MODELS.describe, 'DESCRIBE', 'r1'),
      step('text_to_image', MODELS.draw, 'DRAW', 'r2'),
      step('image_to_video', MODELS.animate, 'ANIMATE', 'r3'),
    ]),
  })).json().id;
  await runToEnd(app, id);
  expect(app.runner.view(id).status).toBe('completed');
  return { app, mock, id };
}

describe('replay / export / import', () => {
  it('exports a completed run and imports it into a fresh app with zero provider calls', async () => {
    const { app, id } = await completedMockRun();
    const original = app.runner.view(id);
    const outDir = path.join(makeDataDir(), 'bundle');
    exportRun(app.runner, app.store, id, outDir);

    const bundle = JSON.parse(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8'));
    expect(bundle.bundleVersion).toBe(1);
    expect(bundle.steps).toHaveLength(3);
    expect(fs.readdirSync(outDir).filter((f) => f !== 'run.json').length).toBe(3); // source + image + video media

    // --- a completely fresh app, whose adapters must never be touched ---
    const cfg2 = testConfig();
    const mock2 = new MockAdapter(cfg2.tmpDir, 0);
    const app2 = await makeApp({ cfg: cfg2, adapters: { openrouter: mock2, fal: mock2 } });
    const importedId = importRunBundle(app2.db, app2.store, outDir)!;
    expect(importedId).toBeTruthy();
    expect(importRunBundle(app2.db, app2.store, outDir)).toBeNull(); // idempotent

    const imported = (await get(app2, `/api/runs/${importedId}`)).json();
    expect(imported.status).toBe('completed');
    expect(imported.imported).toBe(true);
    expect(imported.name).toMatch(/saved rehearsal/);
    expect(imported.steps).toHaveLength(3);
    expect(imported.steps.map((s: any) => s.definition.instruction)).toEqual(['DESCRIBE', 'DRAW', 'ANIMATE']);
    expect(imported.steps[0].artifact.text).toBe(original.steps[0].artifact!.text);
    expect(imported.steps[2].artifact.kind).toBe('video');

    // media is served from the imported copy
    const media = await get(app2, `/media/${imported.steps[1].artifact.id}`);
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toMatch(/^image\//);
    const video = await get(app2, `/media/${imported.steps[2].artifact.id}`);
    expect(video.statusCode).toBe(200);
    expect(video.headers['content-type']).toBe('video/mp4');

    // it cannot be executed
    const started = await post(app2, `/api/runs/${importedId}/actions`, { action: 'start' });
    expect(started.statusCode).toBe(400);
    expect(started.json().error).toMatch(/Imported replay runs cannot be executed/);

    // selecting it in replay mode gives a replay-labelled present state and still no provider calls
    const session = (await post(app2, '/api/session/select-run', { runId: importedId, replay: true })).json();
    expect(session.replay).toBe(true);
    const state = (await get(app2, `/api/present/${session.projectorToken}/state`, { cookie: null })).json();
    expect(state.replay).toBe(true);
    expect(state.hasRun).toBe(true);
    expect(state.runStatus).toBe('completed');
    expect(state.stages).toHaveLength(4);
    expect(mock2.calls).toHaveLength(0);
  }, 30_000);

  it('refuses to export a run that is not completed', async () => {
    const cfg = testConfig();
    const mock = new MockAdapter(cfg.tmpDir, 0);
    const app = await makeApp({ cfg, adapters: { openrouter: mock, fal: mock } });
    await acceptSource(app);
    const id = (await createRun(app, { preset: preset('unfinished', [step('image_to_text', MODELS.describe, 'D', 'q1')]) })).json().id;
    expect(() => exportRun(app.runner, app.store, id, path.join(makeDataDir(), 'x'))).toThrow(/Only completed runs/);
  });

  it('lists an imported run with its step count and imported flag', async () => {
    const { app, id } = await completedMockRun();
    const outDir = path.join(makeDataDir(), 'bundle2');
    exportRun(app.runner, app.store, id, outDir);
    const cfg2 = testConfig();
    const mock2 = new MockAdapter(cfg2.tmpDir, 0);
    const app2 = await makeApp({ cfg: cfg2, adapters: { openrouter: mock2, fal: mock2 } });
    importRunBundle(app2.db, app2.store, outDir);
    const runs = (await get(app2, '/api/runs')).json().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', imported: true, stepCount: 3 });
  }, 30_000);
});
