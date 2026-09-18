import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, makeJpeg, post, uploadDesktop } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { PRESET_SCHEMA_VERSION, type PresetBody } from '../shared/types.ts';

afterEach(closeAll);

const pipeline: PresetBody = {
  schemaVersion: PRESET_SCHEMA_VERSION,
  name: 'three steps',
  startingKind: 'image',
  steps: [
    { id: 'a', type: 'image_to_text', modelId: 'google/gemini-2.5-flash', instruction: 'describe', params: {} },
    { id: 'b', type: 'text_to_image', modelId: 'google/gemini-3.1-flash-lite-image', instruction: 'draw', params: {} },
    { id: 'c', type: 'image_to_video', modelId: 'minimax/h3-max-turbo/image-to-video', instruction: 'animate', params: {} },
  ],
};

describe('choosing an older source', () => {
  it('re-selects an earlier upload after a newer one was accepted', async () => {
    const app = await makeApp();
    const first = (await uploadDesktop(app, await makeJpeg(200, 100), 'a.jpg')).json();
    const second = (await uploadDesktop(app, await makeJpeg(120, 120), 'b.jpg')).json();

    await post(app, `/api/session/uploads/${first.uploadId}/accept`);
    const afterFirst = (await get(app, '/api/session')).json();
    await post(app, `/api/session/uploads/${second.uploadId}/accept`);
    expect((await get(app, '/api/session')).json().source.id).not.toBe(afterFirst.source.id);

    // going back to the older one is allowed, and does not disturb the upload history
    const back = (await post(app, `/api/session/uploads/${first.uploadId}/accept`)).json();
    expect(back.source.id).toBe(afterFirst.source.id);
    expect(back.uploads).toHaveLength(2);
  });

  it('lists uploads and earlier run artifacts as candidates, newest first, without video', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
    const up = (await uploadDesktop(app, await makeJpeg(160, 120), 'src.jpg')).json();
    await post(app, `/api/session/uploads/${up.uploadId}/accept`);

    // an image → text → video run: its text output is a candidate, its video is not
    const created = await post(app, '/api/runs', { preset: pipeline });
    expect(created.statusCode, created.body).toBe(200);
    const run = created.json();
    await post(app, `/api/runs/${run.id}/actions`, { action: 'start' });
    await app.runner.idle();
    const finished = (await get(app, `/api/runs/${run.id}`)).json();
    expect(finished.status).toBe('completed');

    const { sources } = (await get(app, '/api/sources')).json();
    const byId = new Map<string, any>(sources.map((s: any) => [s.artifact.id, s]));
    expect(sources.every((s: any) => s.artifact.kind !== 'video')).toBe(true);
    expect(byId.get(finished.steps[0].artifact.id)?.label).toBe('step 1 of three steps');
    expect(byId.get(finished.steps[1].artifact.id)?.label).toBe('step 2 of three steps');
    expect(byId.get(finished.source.id)?.label).toMatch(/^upload · desktop$/);
    expect(byId.get(finished.source.id)?.isCurrent).toBe(true);
    expect(sources.map((s: any) => s.createdAt)).toEqual([...sources.map((s: any) => s.createdAt)].sort((a, b) => b - a));

    // pick the run's text output as the next run's source
    const session = (await post(app, '/api/session/source', { artifactId: finished.steps[0].artifact.id })).json();
    expect(session.source.id).toBe(finished.steps[0].artifact.id);
    expect(session.source.kind).toBe('text');

    // and a video cannot become a source, since no step accepts one
    const vid = await post(app, '/api/session/source', { artifactId: finished.steps[2].artifact.id });
    expect(vid.statusCode).toBe(400);
    expect(vid.json().error).toMatch(/video/i);
    expect((await get(app, '/api/session')).json().source.id).toBe(finished.steps[0].artifact.id); // unchanged
  });

  it('rejects unknown artifacts and non-host callers', async () => {
    const app = await makeApp();
    expect((await post(app, '/api/session/source', { artifactId: 'art_nope' })).statusCode).toBe(404);
    expect((await post(app, '/api/session/source', { artifactId: 'art_x' }, { cookie: null })).statusCode).toBe(401);
    expect((await get(app, '/api/sources', { cookie: null })).statusCode).toBe(401);

    const upToken = (await get(app, '/api/session')).json().uploadToken;
    expect((await get(app, '/api/sources', { cookie: null, headers: { 'x-upload-token': upToken } })).statusCode).toBe(401);
  });
});
