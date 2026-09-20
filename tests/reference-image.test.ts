import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, makeJpeg, post, uploadDesktop } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { PRESET_SCHEMA_VERSION, REFERENCE_NOTE, type PresetBody, type StepDefinition } from '../shared/types.ts';

afterEach(closeAll);

const describeStep: StepDefinition = { id: 'd', type: 'image_to_text', modelId: 'google/gemini-2.5-flash', instruction: 'describe', params: {}, repeat: { span: 2, times: 2 } };
const draw = (params: StepDefinition['params']): StepDefinition => ({ id: 'w', type: 'text_to_image', modelId: 'google/gemini-3.1-flash-lite-image', instruction: 'draw', params });
const preset = (steps: StepDefinition[]): PresetBody => ({ schemaVersion: PRESET_SCHEMA_VERSION, name: 'p', startingKind: 'image', steps });

const runIt = async (body: Record<string, unknown>) => {
  const mock = new MockAdapter('/tmp', 0);
  const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
  const bytes = await makeJpeg(160, 120);
  const up = (await uploadDesktop(app, bytes, 'x.jpg')).json();
  await post(app, `/api/session/uploads/${up.uploadId}/accept`);
  const res = await post(app, '/api/runs', body);
  expect(res.statusCode, res.body).toBe(200);
  await post(app, `/api/runs/${res.json().id}/actions`, { action: 'start' });
  await app.runner.idle();
  expect((await get(app, `/api/runs/${res.json().id}`)).json().status).toBe('completed');
  return { mock, run: res.json() };
};

describe('reference image for text → image (opt-in)', () => {
  it('off by default: no step ever receives a reference', async () => {
    const { mock } = await runIt({ preset: preset([describeStep, draw({})]) });
    expect(mock.calls.every((c) => c.references === undefined)).toBe(true);
    expect(mock.calls.every((c) => !c.instruction.includes(REFERENCE_NOTE))).toBe(true);
  });

  it("'previous' sends the most recent image; 'first' always sends the source; only draw steps get one", async () => {
    const prev = await runIt({ preset: preset([describeStep, draw({ reference: 'previous' })]) });
    const [d1, w1, d2, w2] = prev.mock.calls;
    expect(d1.references).toBeUndefined();
    expect(d2.references).toBeUndefined();
    expect(w1.references).toHaveLength(1);
    expect(w1.instruction).toContain(REFERENCE_NOTE);
    expect(w1.input.kind).toBe('text'); // the predecessor is still the text
    // second draw references the image the first draw produced (= what the second describe saw)
    expect(w2.references![0].bytes.equals((d2.input as any).bytes)).toBe(true);
    expect(w2.references![0].bytes.equals(w1.references![0].bytes)).toBe(false);

    const first = await runIt({ preset: preset([describeStep, draw({ reference: 'first' })]) });
    expect(first.mock.calls[3].references![0].bytes.equals(first.mock.calls[1].references![0].bytes)).toBe(true);
  });

  it('the storyboard set turns it on for draw steps of that run only', async () => {
    const { mock, run } = await runIt({ preset: preset([describeStep, draw({})]), instructionSet: 'storyboard' });
    expect(run.steps.filter((s: any) => s.definition.type === 'text_to_image').every((s: any) => s.definition.params.reference === 'previous')).toBe(true);
    expect(mock.calls[1].references).toHaveLength(1);
  });

  it('is rejected on other step types before any call', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
    const up = (await uploadDesktop(app, await makeJpeg(160, 120), 'x.jpg')).json();
    await post(app, `/api/session/uploads/${up.uploadId}/accept`);
    const res = await post(app, '/api/runs', { preset: preset([{ ...describeStep, repeat: undefined, params: { reference: 'previous' } }]) });
    expect(res.statusCode).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });
});
