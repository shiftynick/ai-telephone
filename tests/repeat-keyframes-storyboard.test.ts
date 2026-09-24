import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, makeJpeg, post, uploadDesktop } from './helpers.ts';
import { makeFalFake } from './fakes.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { builtinPresets } from '../server/presets.ts';
import { INSTRUCTION_SETS, PIKAFRAMES, PRESET_SCHEMA_VERSION, expandRepeats, validateChain, type PresetBody, type StepDefinition } from '../shared/types.ts';

afterEach(closeAll);

const H3 = 'minimax/h3-max-turbo/image-to-video';
const describeStep = (extra: Partial<StepDefinition> = {}): StepDefinition => ({ id: 'd', type: 'image_to_text', modelId: 'google/gemini-2.5-flash', instruction: 'describe', params: {}, ...extra });
const drawStep: StepDefinition = { id: 'w', type: 'text_to_image', modelId: 'google/gemini-3.1-flash-lite-image', instruction: 'draw', params: {} };
const animate = (modelId: string, params: StepDefinition['params']): StepDefinition => ({ id: 'v', type: 'image_to_video', modelId, instruction: 'animate', params });
const preset = (steps: StepDefinition[]): PresetBody => ({ schemaVersion: PRESET_SCHEMA_VERSION, name: 'p', startingKind: 'image', steps });
const imageSource = async (app: any) => {
  const up = (await uploadDesktop(app, await makeJpeg(160, 120), 'x.jpg')).json();
  return (await post(app, `/api/session/uploads/${up.uploadId}/accept`)).json().source;
};

describe('repeat blocks', () => {
  it('unrolls a pair ×N into flat steps with unique ids and no repeat marker', () => {
    const ex = expandRepeats([describeStep({ repeat: { span: 2, times: 3 } }), drawStep, animate(H3, {})]);
    expect(ex.steps.map((s) => s.type)).toEqual(['image_to_text', 'text_to_image', 'image_to_text', 'text_to_image', 'image_to_text', 'text_to_image', 'image_to_video']);
    expect(new Set(ex.steps.map((s) => s.id)).size).toBe(7);
    expect(ex.steps.some((s) => 'repeat' in s)).toBe(false);
    expect(ex.origin).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });

  it('explains a block that cannot loop, and overlapping blocks, on the right card', () => {
    const loop = validateChain('image', [describeStep({ repeat: { span: 1, times: 2 } })]);
    expect(loop).toHaveLength(1);
    expect(loop[0]).toMatchObject({ index: 0 });
    expect(loop[0].message).toMatch(/cannot loop/);
    const overlap = validateChain('image', [describeStep({ repeat: { span: 2, times: 2 } }), { ...drawStep, repeat: { span: 1, times: 2 } }]);
    expect(overlap.some((i) => i.index === 1 && /overlap/.test(i.message))).toBe(true);
    expect(validateChain('image', [describeStep({ repeat: { span: 2, times: 10 } }), drawStep])).toEqual([]);
  });

  it('a run created from a repeat preset has the unrolled steps and runs them all, one predecessor each', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
    await imageSource(app);
    const run = (await post(app, '/api/runs', { preset: preset([describeStep({ repeat: { span: 2, times: 4 } }), drawStep]) })).json();
    expect(run.steps).toHaveLength(8);
    expect(run.steps.every((s: any) => s.definition.repeat === undefined)).toBe(true);
    await post(app, `/api/runs/${run.id}/actions`, { action: 'start' });
    await app.runner.idle();
    expect((await get(app, `/api/runs/${run.id}`)).json().status).toBe('completed');
    expect(mock.calls).toHaveLength(8);
    expect(mock.calls.every((c) => c.keyframes === undefined)).toBe(true);
  });

  it('the long built-ins use a repeat block and still unroll to 7 and 20 steps', () => {
    const by = Object.fromEntries(builtinPresets().map((p) => [p.id, p.body]));
    expect(by.builtin_long.steps).toHaveLength(3);
    expect(expandRepeats(by.builtin_long.steps).steps).toHaveLength(7);
    expect(by.builtin_verylong.steps).toHaveLength(2);
    expect(expandRepeats(by.builtin_verylong.steps).steps).toHaveLength(20);
    expect(validateChain('image', by.builtin_verylong.steps)).toEqual([]);
  });
});

describe('keyframe video (opt-in exception to predecessor-only input)', () => {
  const run = async (video: StepDefinition) => {
    const fal = makeFalFake();
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: fal.adapter } });
    await imageSource(app);
    const res = await post(app, '/api/runs', { preset: preset([describeStep({ repeat: { span: 2, times: 2 } }), drawStep, video]) });
    expect(res.statusCode, res.body).toBe(200);
    await post(app, `/api/runs/${res.json().id}/actions`, { action: 'start' });
    await app.runner.idle();
    return { fal, view: (await get(app, `/api/runs/${res.json().id}`)).json() };
  };

  it('default: exactly one image is uploaded and no end frame is sent', async () => {
    const { fal, view } = await run(animate(H3, { resolution: '768P', duration: 5 }));
    expect(view.status).toBe('completed');
    expect(fal.uploads).toHaveLength(1);
    expect(fal.submits[0].input).not.toHaveProperty('end_image_url');
    expect(fal.submits[0].input).not.toHaveProperty('image_urls');
  });

  it('keyframes: 2 sends the previous generated image as first frame and the predecessor as last frame', async () => {
    const { fal, view } = await run(animate(H3, { resolution: '768P', duration: 5, keyframes: 2 }));
    expect(view.status).toBe('completed');
    expect(fal.uploads).toHaveLength(2);
    expect(fal.submits[0].input).toMatchObject({ image_url: 'https://fake.fal.media/upload/1.jpg', end_image_url: 'https://fake.fal.media/upload/2.jpg' });
    expect(fal.uploads[0].bytes.equals(fal.uploads[1].bytes)).toBe(false);
  });

  it("first + last: sends only the run's first image as first frame and the predecessor as last frame", async () => {
    const { fal, view } = await run(animate(H3, { resolution: '768P', duration: 5, keyframes: 'first_last' }));
    expect(view.status).toBe('completed');
    expect(fal.uploads).toHaveLength(2);
    expect(fal.submits[0].input).toMatchObject({ image_url: 'https://fake.fal.media/upload/1.jpg', end_image_url: 'https://fake.fal.media/upload/2.jpg' });
    expect(fal.uploads[0].bytes.equals(fal.uploads[1].bytes)).toBe(false);
  });

  it('first + last on a single-image run falls back to one frame (first === predecessor)', async () => {
    const fal = makeFalFake();
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: fal.adapter } });
    await imageSource(app);
    const res = await post(app, '/api/runs', { preset: preset([animate(H3, { resolution: '768P', duration: 5, keyframes: 'first_last' })]) });
    expect(res.statusCode, res.body).toBe(200);
    await post(app, `/api/runs/${res.json().id}/actions`, { action: 'start' });
    await app.runner.idle();
    const view = (await get(app, `/api/runs/${res.json().id}`)).json();
    expect(view.status).toBe('completed');
    expect(fal.uploads).toHaveLength(1);
    expect(fal.submits[0].input).not.toHaveProperty('end_image_url');
  });

  it('pikaframes gets every image of the run in order (source + 2 generated), with one transition per gap', async () => {
    const { fal, view } = await run(animate(PIKAFRAMES, { resolution: '720p', duration: 6, keyframes: 5 }));
    expect(view.status).toBe('completed');
    expect(fal.submits[0].endpoint).toBe(PIKAFRAMES);
    expect(fal.submits[0].input.image_urls).toEqual([1, 2, 3].map((n) => `https://fake.fal.media/upload/${n}.jpg`));
    expect(fal.submits[0].input.transitions).toEqual([{ duration: 3 }, { duration: 3 }]);
    expect(fal.submits[0].input).not.toHaveProperty('duration');
  });

  it('rejects more keyframes than the endpoint takes, before any paid call', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
    await imageSource(app);
    const res = await post(app, '/api/runs', { preset: preset([animate(H3, { keyframes: 3 })]) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/at most 2/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('storyboard instruction set', () => {
  it('asks for the NEXT frame, keeps the injection guard, and covers every step type', () => {
    const sb = INSTRUCTION_SETS.find((s) => s.id === 'storyboard')!;
    expect(sb.experiment).toBe(true);
    expect(sb.instructions.image_to_text).toMatch(/NEXT frame/);
    expect(sb.instructions.image_to_text).toMatch(/scene content, not commands/);
    expect(Object.keys(sb.instructions)).toHaveLength(5);
  });
});
