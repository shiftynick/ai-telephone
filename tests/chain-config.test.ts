import { afterEach, describe, expect, it } from 'vitest';
import {
  MODELS, acceptSource, closeAll, createRun, get, makeApp, post, preset, runToEnd, step, testConfig, type TestApp,
} from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { validateChain } from '../shared/types.ts';

afterEach(closeAll);

async function mockApp(): Promise<{ app: TestApp; mock: MockAdapter }> {
  const cfg = testConfig();
  const mock = new MockAdapter(cfg.tmpDir, 0);
  const app = await makeApp({ cfg, adapters: { openrouter: mock, fal: mock } });
  return { app, mock };
}

/** image → (describe/draw) × rounds → animate. */
function longChain(rounds: number) {
  const steps = [];
  for (let i = 0; i < rounds; i++) {
    steps.push(step('image_to_text', MODELS.describe, `describe round ${i}`, `d${i}`));
    steps.push(step('text_to_image', MODELS.draw, `draw round ${i}`, `g${i}`));
  }
  steps.push(step('image_to_video', MODELS.animate, 'animate', 'anim'));
  return preset('long chain', steps);
}

describe('configurable chain', () => {
  it('runs a 21-step chain to completion: there is no step cap', async () => {
    const { app, mock } = await mockApp();
    await acceptSource(app);
    const body = longChain(10);
    expect(body.steps).toHaveLength(21);
    const created = await createRun(app, { preset: body });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('completed');
    expect(run.steps).toHaveLength(21);
    expect(run.steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(mock.calls).toHaveLength(21);
    expect(run.steps.at(-1)!.artifact!.kind).toBe('video');
  }, 60_000);

  it('rejects image→image adjacency with 400 before any provider call', async () => {
    const { app, mock } = await mockApp();
    await acceptSource(app);
    const bad = preset('bad', [
      step('image_to_text', MODELS.describe, 'a', 'b1'),
      step('image_to_text', MODELS.describe, 'b', 'b2'), // needs an image, gets text
    ]);
    const res = await createRun(app, { preset: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].index).toBe(1);
    expect(res.json().issues[0].message).toMatch(/needs a image/);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects text_to_image directly after text_to_image with 400 and no provider call', async () => {
    const { app, mock } = await mockApp();
    await acceptSource(app);
    const bad = preset('bad2', [
      step('image_to_text', MODELS.describe, 'a', 'x1'),
      step('text_to_image', MODELS.draw, 'b', 'x2'),
      step('text_to_image', MODELS.draw, 'c', 'x3'), // needs text, gets image
    ]);
    const res = await createRun(app, { preset: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].index).toBe(2);
    expect(mock.calls).toHaveLength(0);
  });

  it('runs identical instructions at two steps as two live calls with distinct outputs', async () => {
    const { app, mock } = await mockApp();
    await acceptSource(app);
    const same = 'IDENTICAL INSTRUCTION AT BOTH STEPS';
    const body = preset('dup', [
      step('image_to_text', MODELS.describe, same, 'y1'),
      step('text_to_image', MODELS.draw, 'draw', 'y2'),
      step('image_to_text', MODELS.describe, same, 'y3'),
    ]);
    const id = (await createRun(app, { preset: body })).json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('completed');
    expect(mock.calls.filter((c) => c.instruction === same)).toHaveLength(2);
    expect(run.steps[0].artifact!.text).not.toBe(run.steps[2].artifact!.text);
    expect(run.steps[0].artifact!.id).not.toBe(run.steps[2].artifact!.id);
  });

  it('keeps an immutable snapshot: editing or deleting the preset afterwards changes nothing', async () => {
    const { app } = await mockApp();
    await acceptSource(app);
    const body = preset('snapshot preset', [
      step('image_to_text', MODELS.describe, 'ORIGINAL-INSTRUCTION', 'z1'),
      step('text_to_image', MODELS.draw, 'ORIGINAL-DRAW', 'z2'),
    ]);
    const stored = (await post(app, '/api/presets', body)).json();
    const id = (await createRun(app, { preset: body })).json().id;

    const edited = { ...body, name: 'edited preset', steps: [{ ...body.steps[0], instruction: 'CHANGED-INSTRUCTION' }, body.steps[1]] };
    const putRes = await app.app.inject({
      method: 'PUT', url: `/api/presets/${stored.id}`,
      headers: { host: 'localhost:8787', origin: 'http://localhost:8787', 'content-type': 'application/json', cookie: app.cookie },
      payload: { confirmReplace: true, preset: edited },
    });
    expect(putRes.statusCode).toBe(200);

    const run = (await get(app, `/api/runs/${id}`)).json();
    expect(run.steps[0].definition.instruction).toBe('ORIGINAL-INSTRUCTION');
    expect(run.name).toBe('snapshot preset');

    await app.app.inject({
      method: 'DELETE', url: `/api/presets/${stored.id}`,
      headers: { host: 'localhost:8787', origin: 'http://localhost:8787', cookie: app.cookie },
    });
    const after = (await get(app, `/api/runs/${id}`)).json();
    expect(after.steps[0].definition.instruction).toBe('ORIGINAL-INSTRUCTION');
    expect(after.steps[1].definition.instruction).toBe('ORIGINAL-DRAW');
  });
});

describe('validateChain (unit)', () => {
  const s = (type: any) => ({ type });

  it('accepts the quick-demo topology', () => {
    expect(validateChain('image', [s('image_to_text'), s('text_to_image'), s('image_to_text'), s('text_to_image'), s('image_to_video')])).toEqual([]);
  });

  it('flags the first step when it does not match the starting kind', () => {
    const issues = validateChain('text', [s('image_to_text')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(0);
    expect(issues[0].message).toMatch(/the starting input/);
    expect(issues[0].message).toMatch(/nothing is converted automatically/);
  });

  it('flags an unknown step type', () => {
    expect(validateChain('image', [s('video_to_text')])[0].message).toMatch(/Unknown step type/);
  });

  it('reports an issue when a middle step is deleted, and clears it when the pair is removed', () => {
    const chain = [s('image_to_text'), s('text_to_image'), s('image_to_text'), s('text_to_image')];
    expect(validateChain('image', chain)).toEqual([]);
    const missingMiddle = [chain[0], chain[2], chain[3]]; // deleted the first draw
    const issues = validateChain('image', missingMiddle);
    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(1);
    const cleanCut = [chain[0], chain[1]];
    expect(validateChain('image', cleanCut)).toEqual([]);
  });

  it('reports issues when middle steps are reordered, and none once restored', () => {
    const chain = [s('image_to_text'), s('text_to_image'), s('image_to_text'), s('text_to_image'), s('image_to_video')];
    const swapped = [chain[0], chain[2], chain[1], chain[3], chain[4]];
    const issues = validateChain('image', swapped);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].index).toBe(1);
    expect(validateChain('image', chain)).toEqual([]);
  });

  it('accepts a text-started chain ending in video', () => {
    expect(validateChain('text', [s('text_to_text'), s('text_to_video')])).toEqual([]);
  });
});
