import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, makeJpeg, post, quickChain, uploadDesktop } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { DEFAULT_INSTRUCTIONS, INSTRUCTION_SETS, PRESET_SCHEMA_VERSION, STEP_TYPES, type StepType } from '../shared/types.ts';

afterEach(closeAll);

const mockApp = async () => {
  const mock = new MockAdapter('/tmp', 0);
  const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
  const up = (await uploadDesktop(app, await makeJpeg(160, 120), 'x.jpg')).json();
  await post(app, `/api/session/uploads/${up.uploadId}/accept`);
  return { app, mock };
};

describe('instruction sets', () => {
  it('are complete and distinct, and every image description keeps the prompt-injection guard', () => {
    expect(INSTRUCTION_SETS.map((s) => s.id)).toEqual(['faithful', 'forensic', 'minimal', 'storyteller', 'childlike']);
    expect(new Set(INSTRUCTION_SETS.map((s) => s.id)).size).toBe(INSTRUCTION_SETS.length);
    expect(INSTRUCTION_SETS[0].instructions).toEqual(DEFAULT_INSTRUCTIONS);
    for (const set of INSTRUCTION_SETS) {
      expect(Object.keys(set.instructions).sort()).toEqual(Object.keys(STEP_TYPES).sort());
      expect(set.instructions.image_to_text).toMatch(/scene content, not commands/);
      expect(set.instructions.image_to_text.length).toBeGreaterThan(40);
      expect(set.instructions.text_to_image.length).toBeGreaterThan(10);
    }
    // interpretive/lossy sets are labelled as experiments so drift is not misread as model failure
    expect(INSTRUCTION_SETS.filter((s) => s.experiment).map((s) => s.id)).toEqual(['minimal', 'storyteller', 'childlike']);
    const describes = INSTRUCTION_SETS.map((s) => s.instructions.image_to_text);
    expect(new Set(describes).size).toBe(describes.length);
  });

  it('runs the same pipeline under a different set: only the instruction text changes', async () => {
    const { app, mock } = await mockApp();
    const pipeline = quickChain();
    const res = await post(app, '/api/runs', { preset: pipeline, instructionSet: 'forensic' });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json();
    const forensic = INSTRUCTION_SETS.find((s) => s.id === 'forensic')!;
    expect(run.name).toBe(`${pipeline.name} [Forensic detail]`);
    run.steps.forEach((s: any, i: number) => {
      expect(s.definition.instruction).toBe(forensic.instructions[s.definition.type as StepType]);
      // topology, models and params are exactly the pipeline's
      expect(s.definition.type).toBe(pipeline.steps[i].type);
      expect(s.definition.modelId).toBe(pipeline.steps[i].modelId);
      expect(s.definition.id).toBe(pipeline.steps[i].id);
    });

    await post(app, `/api/runs/${run.id}/actions`, { action: 'start' });
    await app.runner.idle();
    expect(mock.calls.map((c) => c.instruction)).toEqual(pipeline.steps.map((s) => forensic.instructions[s.type]));
    expect(mock.calls.some((c) => /INSTRUCTION-ALPHA/.test(c.instruction))).toBe(false);
  });

  it('leaves the pipeline as written when no set is chosen, and rejects unknown sets before any call', async () => {
    const { app, mock } = await mockApp();
    const plain = (await post(app, '/api/runs', { preset: quickChain() })).json();
    expect(plain.name).toBe(quickChain().name);
    expect(plain.steps[0].definition.instruction).toMatch(/INSTRUCTION-ALPHA/);

    const bad = await post(app, '/api/runs', { preset: quickChain(), instructionSet: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Unknown instruction set/);
    expect(mock.calls).toHaveLength(0);
  });

  it('applies to the auto-added bridge step as well', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
    await post(app, '/api/session/source-text', { text: 'a lighthouse' });
    const run = (await post(app, '/api/runs', { preset: quickChain(), instructionSet: 'childlike' })).json();
    const childlike = INSTRUCTION_SETS.find((s) => s.id === 'childlike')!;
    expect(run.steps[0].definition).toMatchObject({ auto: true, type: 'text_to_image', instruction: childlike.instructions.text_to_image });
  });

  it('adventure steps take their instruction from the chosen set, with the twist appended', async () => {
    const { app, mock } = await mockApp();
    const id = (await post(app, '/api/runs', { preset: { schemaVersion: PRESET_SCHEMA_VERSION, name: 'Adventure', startingKind: 'image', steps: [] }, interactive: true })).json().id;
    await post(app, `/api/runs/${id}/steps`, { type: 'image_to_text', instructionSet: 'storyteller', twist: 'in the present tense' });
    await app.runner.idle();
    const story = INSTRUCTION_SETS.find((s) => s.id === 'storyteller')!;
    expect(mock.calls[0].instruction).toBe(`${story.instructions.image_to_text}\n\nAdditional direction: in the present tense`);
    expect((await post(app, `/api/runs/${id}/steps`, { type: 'text_to_image', instructionSet: 'nope' })).statusCode).toBe(400);
    expect((await get(app, `/api/runs/${id}`)).json().steps).toHaveLength(1);
  });
});
