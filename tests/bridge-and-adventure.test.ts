import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, makeJpeg, post, quickChain, uploadDesktop } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { PRESET_SCHEMA_VERSION, type PresetBody } from '../shared/types.ts';

afterEach(closeAll);

const mockApp = async () => {
  const mock = new MockAdapter('/tmp', 0);
  const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
  return { app, mock };
};
const textSource = async (app: any, text = 'a red bicycle by a lighthouse') => (await post(app, '/api/session/source-text', { text })).json().source;
const imageSource = async (app: any) => {
  const up = (await uploadDesktop(app, await makeJpeg(160, 120), 'x.jpg')).json();
  return (await post(app, `/api/session/uploads/${up.uploadId}/accept`)).json().source;
};
const empty = (startingKind: 'image' | 'text'): PresetBody => ({ schemaVersion: PRESET_SCHEMA_VERSION, name: 'Adventure', startingKind, steps: [] });

describe('automatic bridge step', () => {
  it('prepends ONE visible text → image step when a sentence starts an image pipeline', async () => {
    const { app, mock } = await mockApp();
    await textSource(app);
    const res = await post(app, '/api/runs', { preset: quickChain() });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json();
    expect(run.steps).toHaveLength(6);
    expect(run.steps[0].definition).toMatchObject({ type: 'text_to_image', auto: true, modelId: 'google/gemini-3.1-flash-lite-image' });
    expect(run.steps.slice(1).every((s: any) => !s.definition.auto)).toBe(true);
    expect(run.steps.slice(1).map((s: any) => s.definition.id)).toEqual(['st1', 'st2', 'st3', 'st4', 'st5']); // pipeline untouched

    await post(app, `/api/runs/${run.id}/actions`, { action: 'start' });
    await app.runner.idle();
    expect((await get(app, `/api/runs/${run.id}`)).json().status).toBe('completed');
    // the bridge obeys the telephone rule like any step: it saw only the sentence
    expect(mock.calls[0].type).toBe('text_to_image');
    expect(mock.calls[0].input).toEqual({ kind: 'text', text: 'a red bicycle by a lighthouse' });
  });

  it('prepends image → text when a photo starts a text pipeline, and nothing when kinds already match', async () => {
    const { app } = await mockApp();
    await imageSource(app);
    const textFirst: PresetBody = { ...empty('text'), name: 'text first', steps: [{ id: 't1', type: 'text_to_image', modelId: 'google/gemini-3.1-flash-lite-image', instruction: 'draw', params: {} }] };
    const bridged = (await post(app, '/api/runs', { preset: textFirst })).json();
    expect(bridged.steps.map((s: any) => [s.definition.type, !!s.definition.auto])).toEqual([['image_to_text', true], ['text_to_image', false]]);

    const same = (await post(app, '/api/runs', { preset: quickChain() })).json();
    expect(same.steps).toHaveLength(5);
    expect(same.steps.some((s: any) => s.definition.auto)).toBe(false);
  });

  it('can be switched off, and never papers over a broken pipeline', async () => {
    const { app, mock } = await mockApp();
    await textSource(app);
    const off = await post(app, '/api/runs', { preset: quickChain(), autoBridge: false });
    expect(off.statusCode).toBe(400);

    // an internally inconsistent chain is still rejected; the bridge only fixes the source/pipeline seam
    const broken = quickChain();
    broken.steps.splice(1, 1); // image_to_text followed by image_to_text
    const res = await post(app, '/api/runs', { preset: broken });
    expect(res.statusCode).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('interactive (adventure) runs', () => {
  it('starts empty and runs exactly one chosen step at a time, as many times as wanted', async () => {
    const { app, mock } = await mockApp();
    const src = await imageSource(app);
    const created = await post(app, '/api/runs', { preset: empty('image'), interactive: true });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    expect(created.json()).toMatchObject({ interactive: true, status: 'ready', steps: [] });
    expect(mock.calls).toHaveLength(0); // creating an adventure costs nothing

    const chosen = ['image_to_text', 'text_to_image', 'image_to_text', 'text_to_text', 'text_to_image', 'image_to_video'];
    for (const [i, type] of chosen.entries()) {
      const res = await post(app, `/api/runs/${id}/steps`, { type });
      expect(res.statusCode, res.body).toBe(200);
      await app.runner.idle();
      const v = (await get(app, `/api/runs/${id}`)).json();
      expect(v.status).toBe('completed');
      expect(v.steps).toHaveLength(i + 1);
      expect(mock.calls).toHaveLength(i + 1); // one provider call per choice, never more
    }
    const v = (await get(app, `/api/runs/${id}`)).json();
    expect(v.source.id).toBe(src.id);
    expect(v.steps.map((s: any) => s.definition.type)).toEqual(chosen);
    // each step still saw only its predecessor
    expect(mock.calls[1].input).toEqual({ kind: 'text', text: v.steps[0].artifact.text });

    // a video ends the branch: nothing accepts video input
    const after = await post(app, `/api/runs/${id}/steps`, { type: 'image_to_text' });
    expect(after.statusCode).toBe(400);
    expect(mock.calls).toHaveLength(chosen.length);
  });

  it('rejects an action that does not fit what is on screen, before any provider call', async () => {
    const { app, mock } = await mockApp();
    await imageSource(app);
    const id = (await post(app, '/api/runs', { preset: empty('image'), interactive: true })).json().id;
    const res = await post(app, `/api/runs/${id}/steps`, { type: 'text_to_image' }); // source is an image
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/needs a text/);
    expect(mock.calls).toHaveLength(0);
    expect((await get(app, `/api/runs/${id}`)).json().steps).toHaveLength(0);
  });

  it('appends the twist to the static instruction and nothing else', async () => {
    const { app, mock } = await mockApp();
    await textSource(app, 'a quiet harbour');
    const id = (await post(app, '/api/runs', { preset: empty('text'), interactive: true })).json().id;
    await post(app, `/api/runs/${id}/steps`, { type: 'text_to_image', twist: 'as a watercolour' });
    await app.runner.idle();
    expect(mock.calls[0].instruction).toMatch(/^Create one image[\s\S]*Additional direction: as a watercolour$/);
    expect(mock.calls[0].input).toEqual({ kind: 'text', text: 'a quiet harbour' });
  });

  it('never lets steps be appended to a preset run, and needs the host', async () => {
    const { app } = await mockApp();
    await imageSource(app);
    const preset = (await post(app, '/api/runs', { preset: quickChain() })).json();
    expect((await post(app, `/api/runs/${preset.id}/steps`, { type: 'image_to_text' })).statusCode).toBe(400);
    expect((await get(app, `/api/runs/${preset.id}`)).json().steps).toHaveLength(5); // snapshot still immutable

    const adv = (await post(app, '/api/runs', { preset: empty('image'), interactive: true })).json();
    expect((await post(app, `/api/runs/${adv.id}/steps`, { type: 'image_to_text' }, { cookie: null })).statusCode).toBe(401);
    // an empty NON-interactive run is still refused
    expect((await post(app, '/api/runs', { preset: empty('image') })).statusCode).toBe(400);
  });

  it('branches: any earlier output can start a new adventure', async () => {
    const { app } = await mockApp();
    await imageSource(app);
    const id = (await post(app, '/api/runs', { preset: empty('image'), interactive: true })).json().id;
    await post(app, `/api/runs/${id}/steps`, { type: 'image_to_text' });
    await app.runner.idle();
    const first = (await get(app, `/api/runs/${id}`)).json();
    const branch = (await post(app, '/api/runs', { preset: empty('text'), interactive: true, sourceArtifactId: first.steps[0].artifact.id })).json();
    expect(branch.source.id).toBe(first.steps[0].artifact.id);
    expect((await post(app, `/api/runs/${branch.id}/steps`, { type: 'text_to_video' })).statusCode).toBe(200);
    await app.runner.idle();
    expect((await get(app, `/api/runs/${branch.id}`)).json().steps[0].artifact.kind).toBe('video');
    expect((await get(app, `/api/runs/${id}`)).json().steps).toHaveLength(1); // the original is untouched
  });
});

describe('adventure model choice and clearing the projector', () => {
  it('uses the chosen model for one step, the fastest otherwise, and rejects unusable models before any call', async () => {
    const { app, mock } = await mockApp();
    await imageSource(app);
    const id = (await post(app, '/api/runs', { preset: empty('image'), interactive: true })).json().id;

    await post(app, `/api/runs/${id}/steps`, { type: 'image_to_text' });
    await app.runner.idle();
    expect(mock.calls[0].modelId).toBe('google/gemini-2.5-flash'); // fastest tested default

    const res = await post(app, `/api/runs/${id}/steps`, { type: 'text_to_image', modelId: 'openai/gpt-image-2.5-flare' });
    expect(res.statusCode, res.body).toBe(200);
    await app.runner.idle();
    expect(mock.calls[1].modelId).toBe('openai/gpt-image-2.5-flare');

    // a fal endpoint the adapter does not know is refused, and no step is added
    const bad = await post(app, `/api/runs/${id}/steps`, { type: 'image_to_video', modelId: 'some/unknown-video-endpoint' });
    expect(bad.statusCode).toBe(400);
    expect(mock.calls).toHaveLength(2);
    expect((await get(app, `/api/runs/${id}`)).json().steps).toHaveLength(2);
  });

  it('clearing the projector shows the idle screen and keeps the run', async () => {
    const { app } = await mockApp();
    await imageSource(app);
    const id = (await post(app, '/api/runs', { preset: empty('image'), interactive: true })).json().id;
    const token = (await get(app, '/api/session')).json().projectorToken;
    expect((await get(app, `/api/present/${token}/state`, { cookie: null })).json().hasRun).toBe(true);

    const cleared = (await post(app, '/api/session/select-run', { runId: null, replay: false })).json();
    expect(cleared.selectedRunId).toBeNull();
    const state = (await get(app, `/api/present/${token}/state`, { cookie: null })).json();
    expect(state).toMatchObject({ hasRun: false, stages: [] });
    expect((await get(app, `/api/runs/${id}`)).statusCode).toBe(200); // still in the run list
    // and the projector token itself still cannot clear anything
    expect((await post(app, '/api/session/select-run', { runId: null, replay: false }, { cookie: null })).statusCode).toBe(401);
  });
});
