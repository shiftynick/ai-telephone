import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, makeJpeg, post, uploadDesktop } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { JUDGE_PROMPT, parseVerdict } from '../server/resemblance.ts';
import { PRESET_SCHEMA_VERSION, type PresetBody, type StepDefinition, type StepType } from '../shared/types.ts';

afterEach(closeAll);

const verdict = (v: Record<string, unknown>) => JSON.stringify({ choices: [{ message: { content: 'Sure:\n```json\n' + JSON.stringify(v) + '\n```' } }], usage: { cost: 0.0004 } });

describe('resemblance meter', () => {
  it('weights the aspects into one 0–100 score and rejects non-verdicts', () => {
    expect(parseVerdict('{"subjects":100,"details":50,"arrangement":0,"setting":100,"mood":100,"lost":"the sign"}')).toEqual({
      score: Math.round(100 * 0.4 + 50 * 0.2 + 0 + 100 * 0.15 + 100 * 0.1), aspects: { subjects: 100, details: 50, arrangement: 0, setting: 100, mood: 100 }, lost: 'the sign',
    });
    expect(parseVerdict('{"subjects":140,"details":-5,"arrangement":50,"setting":50,"mood":50}')!.aspects).toMatchObject({ subjects: 100, details: 0 });
    expect(parseVerdict('I cannot compare these.')).toBeNull();
    expect(parseVerdict('{"subjects":"lots"}')).toBeNull();
  });

  it('scores each step against the ORIGINAL in the background, carries speech, samples video, and never feeds the chain', async () => {
    const judged: any[] = [];
    const judgeFetch = (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      judged.push(body);
      const n = judged.length;
      return new Response(verdict({ subjects: 100 - n * 20, details: 50, arrangement: 50, setting: 50, mood: 50, lost: `thing ${n}` }), { status: 200 });
    }) as unknown as typeof fetch;
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock, claude: mock, code: mock, gemini: mock } });
    // the helper supplies adapters, so the judge is off unless a test brings its own (never the network)
    expect(app.judge).toBeNull();
    const app2 = await (await import('../server/app.ts')).buildApp(app.cfg, { adapters: { openrouter: mock, fal: mock, claude: mock, code: mock, gemini: mock }, judge: { fetchImpl: judgeFetch }, catalogFetch: (async () => { throw new Error('offline'); }) as any });
    const cookie = await (await import('./helpers.ts')).login(app2);
    const t = Object.assign(app2, { cookie });
    const up = (await uploadDesktop(t as any, await makeJpeg(160, 120), 'x.jpg')).json();
    await post(t as any, `/api/session/uploads/${up.uploadId}/accept`);
    const s = (type: StepType, modelId: string, instruction = 'go'): StepDefinition => ({ id: type, type, modelId, instruction, params: {} });
    const preset: PresetBody = { schemaVersion: PRESET_SCHEMA_VERSION, name: 'm', startingKind: 'image', steps: [
      s('image_to_text', 'google/gemini-2.5-flash'), s('text_to_audio', 'gemini-3.8-flash-lite-tts', ''), s('audio_to_text', 'gemini-3.8-flash'), s('text_to_image', 'google/gemini-3.1-flash-lite-image'), s('image_to_video', 'minimax/h3-max-turbo/image-to-video'),
    ] };
    const run = (await post(t as any, '/api/runs', { preset })).json();
    await post(t as any, `/api/runs/${run.id}/actions`, { action: 'start' });
    await app2.runner.idle();
    await app2.judge!.idle();
    const v = (await get(t as any, `/api/runs/${run.id}`)).json();
    expect(v.status).toBe('completed');
    const r = v.steps.map((st: any) => st.resemblance);
    expect(r.map((x: any) => x.status)).toEqual(['done', 'carried', 'done', 'done', 'done']);
    expect(r[1].score).toBe(r[0].score); // speech keeps exactly what its text kept
    expect(r[0].lost).toBe('thing 1');
    // 4 judge calls (speech is not judged); every one compares against the ORIGINAL image
    expect(judged).toHaveLength(4);
    for (const b of judged) {
      const parts = b.messages[0].content;
      expect(parts[0].text).toBe(JUDGE_PROMPT);
      expect(parts[1].text).toBe('ORIGINAL:');
      expect(parts[2].type).toBe('image_url');
      expect(b.temperature).toBe(0);
    }
    expect(judged[0].messages[0].content[4]).toEqual({ type: 'text', text: expect.stringContaining('Mock description') }); // a text step is judged as text
    expect(judged[3].messages[0].content[4].image_url.url).toMatch(/^data:image\/jpeg/); // the video's middle frame
    // telephone rule: no step ever saw a score or the judge prompt
    expect(JSON.stringify(mock.calls.map((c) => [c.instruction, c.input.kind === 'text' ? c.input.text : '']))).not.toMatch(/telephone|subjects|ORIGINAL/);
    // projector: scores only for revealed stages; the source is 100 by definition
    await post(t as any, '/api/session/select-run', { runId: run.id, replay: true });
    const token = (await get(t as any, '/api/session')).json().projectorToken;
    const state = async () => (await app2.app.inject({ method: 'GET', url: `/api/present/${token}/state`, headers: { host: 'localhost:8787' } })).json().stages;
    expect((await state()).filter((x: any) => !x.revealed).every((x: any) => x.resemblance === undefined)).toBe(true);
    await post(t as any, '/api/session/reveal', { action: 'show', stage: 0 });
    await post(t as any, '/api/session/reveal', { action: 'show', stage: 1 });
    const shown = await state();
    expect(shown[0].resemblance).toEqual({ status: 'done', score: 100 });
    expect(shown[1].resemblance).toMatchObject({ status: 'done', score: r[0].score });
    for (const x of shown) if (!x.revealed) expect(x.resemblance).toBeUndefined();
    await app2.app.close();
  });

  it('retries a transient upstream rate limit, then scores', async () => {
    const { ResemblanceJudge } = await import('../server/resemblance.ts');
    let n = 0;
    const flaky = (async () => (++n === 1
      ? new Response(JSON.stringify({ choices: [{ error: { code: 429, message: 'temporarily rate-limited upstream' } }] }), { status: 200 })
      : new Response(verdict({ subjects: 80, details: 80, arrangement: 80, setting: 80, mood: 80, lost: 'x' }), { status: 200 }))) as unknown as typeof fetch;
    const j: any = new ResemblanceJudge(null as any, null as any, { openrouterKey: 'k' } as any, null as any, { fetchImpl: flaky, retryDelaysMs: [1] });
    const r = await j.ask([{ type: 'text', text: 'x' }]);
    expect(n).toBe(2);
    expect(parseVerdict(r.text)!.score).toBe(80);
  });

  it('mock mode scores without any network, and a failed judge call is recorded, not fatal', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const failing = (async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })) as unknown as typeof fetch;
    const { buildApp } = await import('../server/app.ts');
    const { testConfig, login } = await import('./helpers.ts');
    for (const judge of [{ mock: true }, { fetchImpl: failing, retryDelaysMs: [1, 1] }]) {
      const a = await buildApp(testConfig(), { adapters: { openrouter: mock, fal: mock }, judge, catalogFetch: (async () => { throw new Error('offline'); }) as any });
      const t = Object.assign(a, { cookie: await login(a) }) as any;
      const up = (await uploadDesktop(t, await makeJpeg(160, 120), 'x.jpg')).json();
      await post(t, `/api/session/uploads/${up.uploadId}/accept`);
      const run = (await post(t, '/api/runs', { preset: { schemaVersion: PRESET_SCHEMA_VERSION, name: 'm', startingKind: 'image', steps: [{ id: 'a', type: 'image_to_text', modelId: 'google/gemini-2.5-flash', instruction: 'go', params: {} }] } })).json();
      await post(t, `/api/runs/${run.id}/actions`, { action: 'start' });
      await a.runner.idle();
      await a.judge!.idle();
      const r = (await get(t, `/api/runs/${run.id}`)).json();
      expect(r.status).toBe('completed'); // the meter can never fail a run
      if ('mock' in judge) expect(r.steps[0].resemblance).toMatchObject({ status: 'done', score: 91 });
      else expect(r.steps[0].resemblance).toMatchObject({ status: 'failed', error: expect.stringMatching(/boom/) });
      await a.app.close();
    }
  });
});
