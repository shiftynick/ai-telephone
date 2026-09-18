import { afterEach, describe, expect, it } from 'vitest';
import { HOST, MODELS, ORIGIN, closeAll, del, get, makeApp, post, preset, step, type TestApp } from './helpers.ts';

afterEach(closeAll);

const put = (a: TestApp, url: string, payload: unknown) =>
  a.app.inject({
    method: 'PUT', url,
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', cookie: a.cookie },
    payload: payload as any,
  });

const body = (name = 'my preset') =>
  preset(name, [step('image_to_text', MODELS.describe, 'describe', 'p1'), step('text_to_image', MODELS.draw, 'draw', 'p2')]);

describe('presets API', () => {
  it('seeds the built-in presets and lists them', async () => {
    const app = await makeApp();
    const list = (await get(app, '/api/presets')).json().presets;
    expect(list.map((p: any) => p.id)).toEqual(
      expect.arrayContaining(['builtin_quick', 'builtin_cross', 'builtin_long', 'builtin_caption']),
    );
    const quick = list.find((p: any) => p.id === 'builtin_quick');
    expect(quick.steps).toHaveLength(5);
    expect(quick.startingKind).toBe('image');
  });

  it('creates, replaces (only with confirmReplace) and deletes a preset', async () => {
    const app = await makeApp();
    const created = (await post(app, '/api/presets', body())).json();
    expect(created.id).toMatch(/^pre_/);
    expect(created.name).toBe('my preset');

    const noConfirm = await put(app, `/api/presets/${created.id}`, { preset: body('renamed') });
    expect(noConfirm.statusCode).toBe(428);
    expect((await get(app, '/api/presets')).json().presets.find((p: any) => p.id === created.id).name).toBe('my preset');

    const falseConfirm = await put(app, `/api/presets/${created.id}`, { confirmReplace: false, preset: body('renamed') });
    expect(falseConfirm.statusCode).toBe(428);

    const ok = await put(app, `/api/presets/${created.id}`, { confirmReplace: true, preset: body('renamed') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('renamed');

    expect((await put(app, '/api/presets/pre_missing', { confirmReplace: true, preset: body() })).statusCode).toBe(404);

    expect((await del(app, `/api/presets/${created.id}`)).statusCode).toBe(200);
    expect((await del(app, `/api/presets/${created.id}`)).statusCode).toBe(404);
    expect((await get(app, '/api/presets')).json().presets.find((p: any) => p.id === created.id)).toBeUndefined();
  });

  it('rejects an unknown step type', async () => {
    const app = await makeApp();
    const bad = { ...body(), steps: [{ id: 'a', type: 'video_to_text', modelId: 'x', instruction: '', params: {} }] };
    const res = await post(app, '/api/presets', bad);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(/type/);
  });

  it('rejects unknown params and malformed bodies', async () => {
    const app = await makeApp();
    const unknownParam = { ...body(), steps: [{ ...body().steps[0], params: { made_up_param: 'nope' } }] };
    expect((await post(app, '/api/presets', unknownParam)).statusCode).toBe(400);

    const badVersion = { ...body(), schemaVersion: 99 };
    expect((await post(app, '/api/presets', badVersion)).statusCode).toBe(400);

    const badStartingKind = { ...body(), startingKind: 'video' };
    expect((await post(app, '/api/presets', badStartingKind)).statusCode).toBe(400);

    const emptyName = { ...body(), name: '' };
    expect((await post(app, '/api/presets', emptyName)).statusCode).toBe(400);

    const badDuration = { ...body(), steps: [{ ...body().steps[0], params: { duration: 99 } }] };
    expect((await post(app, '/api/presets', badDuration)).statusCode).toBe(400);
  });

  it('validates a chain without creating anything', async () => {
    const app = await makeApp();
    const bad = preset('bad', [
      step('image_to_text', MODELS.describe, 'a', 'v1'),
      step('image_to_text', MODELS.describe, 'b', 'v2'),
    ]);
    const res = await post(app, '/api/presets/validate', bad);
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toHaveLength(1);
    expect(res.json().issues[0].index).toBe(1);
    expect((await post(app, '/api/presets/validate', body())).json().issues).toEqual([]);
  });
});
