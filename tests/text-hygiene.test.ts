import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, acceptSource, closeAll, createRun, makeApp, preset, runToEnd, step, type TestApp } from './helpers.ts';
import { chatOk, fakeAdapters, makeFalFake, makeOpenRouterFake, type FakeResponse, type OpenRouterFake } from './fakes.ts';

afterEach(closeAll);

/** image_to_text → text_to_image: lets us prove nothing is passed downstream on failure. */
function twoStep() {
  return preset('hygiene', [
    step('image_to_text', MODELS.describe, 'DESCRIBE-IT', 'h1'),
    step('text_to_image', MODELS.draw, 'DRAW-IT', 'h2'),
  ]);
}

async function runWith(first: FakeResponse): Promise<{ app: TestApp; or: OpenRouterFake; run: any }> {
  const or = makeOpenRouterFake(async (call, i) => (i === 0 ? first : { json: {} }));
  const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
  await acceptSource(app);
  const created = await createRun(app, { preset: twoStep() });
  const id = created.json().id;
  await runToEnd(app, id);
  return { app, or, run: app.runner.view(id) };
}

describe('text output hygiene', () => {
  it('drops reasoning fields: only final content becomes the artifact', async () => {
    const or = makeOpenRouterFake(async (call, i) => {
      if (call.url.endsWith('/images')) return { json: {} };
      return {
        json: {
          id: 'gen-1', model: 'm', provider: 'P',
          choices: [
            {
              message: {
                content: 'FINAL-VISIBLE-CONTENT',
                reasoning: 'SECRET-REASONING-TRACE that must never be an artifact',
                reasoning_details: [{ text: 'SECRET-REASONING-TRACE' }],
              },
              finish_reason: 'stop',
            },
          ],
          usage: { cost: 0.001 },
        },
      };
    });
    const app = await makeApp({ adapters: fakeAdapters(or, makeFalFake()) });
    await acceptSource(app);
    const id = (await createRun(app, { preset: preset('r', [step('image_to_text', MODELS.describe, 'D', 'x1')]) })).json().id;
    await runToEnd(app, id);
    const run = app.runner.view(id);
    expect(run.status).toBe('completed');
    expect(run.steps[0].artifact!.text).toBe('FINAL-VISIBLE-CONTENT');
    expect(JSON.stringify(run)).not.toContain('SECRET-REASONING-TRACE');
  });

  it('empty content fails the run with empty_output and makes no downstream call', async () => {
    const { or, run } = await runWith(chatOk(''));
    expect(run.status).toBe('failed');
    expect(run.steps[0].attempts.at(-1)!.errorKind).toBe('empty_output');
    expect(run.steps[1].status).toBe('pending');
    expect(or.imageCalls).toHaveLength(0);
  });

  it('a refusal field stops the run with kind refusal and nothing downstream', async () => {
    const { or, run } = await runWith({
      json: {
        id: 'g', choices: [{ message: { content: null, refusal: 'I cannot help with that image.' }, finish_reason: 'stop' }],
      },
    });
    expect(run.status).toBe('failed');
    expect(run.steps[0].attempts.at(-1)!.errorKind).toBe('refusal');
    expect(run.steps[1].status).toBe('pending');
    expect(or.imageCalls).toHaveLength(0);
    expect(run.steps[1].artifact).toBeUndefined();
  });

  it('content_filter finish_reason stops the run with kind safety', async () => {
    const { or, run } = await runWith({
      json: { id: 'g', choices: [{ message: { content: 'partial' }, finish_reason: 'content_filter' }] },
    });
    expect(run.status).toBe('failed');
    expect(run.steps[0].attempts.at(-1)!.errorKind).toBe('safety');
    expect(or.imageCalls).toHaveLength(0);
  });

  it('a prose refusal ("I\'m sorry, I can\'t…") is detected as a refusal, not a description', async () => {
    const { or, run } = await runWith(chatOk("I'm sorry, I can't describe this image."));
    expect(run.status).toBe('failed');
    expect(run.steps[0].attempts.at(-1)!.errorKind).toBe('refusal');
    expect(run.steps[0].artifact).toBeUndefined();
    expect(or.imageCalls).toHaveLength(0);
  });
});
