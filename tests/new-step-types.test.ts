import { afterAll, afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAll, get, makeApp, makeJpeg, post, uploadDesktop } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { CodeArtAdapter, FORMAT } from '../server/providers/code.ts';
import { runClaude } from '../server/providers/claude.ts';
import { HtmlRenderer, asciiToPng, extractAscii, extractHtml, extractSvg, sanitizeSvg, svgToPng } from '../server/render.ts';
import { NEXT_ACTIONS, PRESET_SCHEMA_VERSION, STEP_TYPES, bridgeType, providerFor, validateChain, type PresetBody, type StepDefinition, type StepType } from '../shared/types.ts';
import type { StepAdapter, StepRequest } from '../server/providers/types.ts';

afterEach(closeAll);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#123456"/><circle cx="80" cy="45" r="30" fill="#ff5b1f"/></svg>';

describe('code-drawn steps: extraction and rendering', () => {
  it('pulls the code out of chatty or fenced replies', () => {
    expect(extractSvg(`Sure! Here you go:\n\`\`\`svg\n${SVG}\n\`\`\`\nEnjoy`)).toBe(SVG);
    expect(extractHtml('```html\n<!doctype html><html><body>hi</body></html>\n```')).toBe('<!doctype html><html><body>hi</body></html>');
    expect(extractHtml('<canvas id=c></canvas><script>1</script>')).toContain('<body><canvas');
    expect(extractAscii('```\n    /\\\\\n   /  \\\\\n```')).toBe(' /\\\\\n/  \\\\');
    expect(() => extractSvg('no svg here')).toThrow(/did not return an SVG/);
    expect(() => extractHtml('just words')).toThrow(/did not return an HTML/);
  });

  it('strips anything that could execute or load from outside the SVG', () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><image href="file:///etc/passwd"/><use xlink:href="http://x/y.svg#a"/><rect fill="url(http://x/p.png)"/><use href="#ok"/><foreignObject><div/></foreignObject></svg>`;
    const clean = sanitizeSvg(evil);
    expect(clean).not.toMatch(/script|onload|passwd|http:\/\/x|foreignObject/);
    expect(clean).toContain('href="#ok"'); // internal references survive
  });

  it('rasterizes SVG and ASCII onto a 1600x900 stage', async () => {
    for (const png of [await svgToPng(SVG), await asciiToPng(' /\\_/\\\n( o.o )\n > ^ <')]) {
      const m = await sharp(png).metadata();
      expect([m.format, m.width, m.height]).toEqual(['png', 1600, 900]);
    }
  });
});

describe('code-drawn steps: the adapter', () => {
  const writer = (reply: string): StepAdapter & { calls: StepRequest[] } => {
    const calls: StepRequest[] = [];
    return { calls, async execute(req) { calls.push(req); return { output: { kind: 'text', text: reply }, costUsd: 0.001, costStatus: 'actual', providerModel: req.modelId, requestSnapshot: {} }; } };
  };
  const base = { modelId: 'openai/gpt-4.1-mini', params: {}, signal: new AbortController().signal };
  const renderer = new HtmlRenderer(os.tmpdir());
  afterAll(() => renderer.close());

  it('sends instruction + fixed format contract + ONLY the predecessor to the writer, and keeps the code', async () => {
    const w = writer(`Here:\n${SVG}`);
    const code = new CodeArtAdapter({ claude: { cwd: os.tmpdir() }, openrouter: w, renderer });
    const r = await code.execute({ ...base, type: 'text_to_svg', instruction: 'Draw it as a poster.', input: { kind: 'text', text: 'a red circle' } });
    expect(r.output.kind).toBe('image');
    expect(r.expandedPrompt).toContain('<svg');
    expect(w.calls[0].type).toBe('text_to_text');
    expect(w.calls[0].instruction).toBe(`Draw it as a poster.\n\n${FORMAT.text_to_svg}`);
    expect(w.calls[0].input).toEqual({ kind: 'text', text: 'a red circle' });
  });

  it('image → SVG trace uses a vision call with the image', async () => {
    const w = writer(SVG);
    const code = new CodeArtAdapter({ claude: { cwd: os.tmpdir() }, openrouter: w, renderer });
    const img = await makeJpeg(64, 48);
    await code.execute({ ...base, type: 'image_to_svg', instruction: 'trace', input: { kind: 'image', bytes: img, mime: 'image/jpeg' } });
    expect(w.calls[0].type).toBe('image_to_text');
    expect((w.calls[0].input as any).bytes.equals(img)).toBe(true);
  });

  it('renders generated HTML to an image and a video with the network blocked', async () => {
    const page = `<!doctype html><html><body><canvas id=c></canvas><script>
      fetch('https://example.com/leak').catch(() => {});
      const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight;
      const g = c.getContext('2d'); let t = 0;
      (function f() { g.fillStyle = '#0a0'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#ff0'; g.fillRect((t++ * 8) % c.width, 100, 80, 80); window.__ready = true; requestAnimationFrame(f); })();
    </script></body></html>`;
    const code = new CodeArtAdapter({ claude: { cwd: os.tmpdir() }, openrouter: writer(page), renderer, videoSeconds: 1 });
    const img = await code.execute({ ...base, type: 'text_to_code_image', instruction: 'x', input: { kind: 'text', text: 'y' } });
    expect(img.output.kind).toBe('image');
    const { dominant } = await sharp((img.output as any).bytes).stats();
    expect(dominant.g).toBeGreaterThan(dominant.r); // the green page really rendered
    expect(img.expandedPrompt).toContain('blocked network request: https://example.com/leak');
    const vid = await code.execute({ ...base, type: 'text_to_code_video', instruction: 'x', input: { kind: 'text', text: 'y' } });
    expect(vid.output.kind).toBe('video');
    expect((vid.output as any).bytes.toString('latin1', 4, 8)).toBe('ftyp');
  }, 60_000);

  it('three.js is served from the vendored copy (no CDN)', async () => {
    const page = `<!doctype html><html><body><script type="module">
      import * as THREE from 'three';
      document.body.style.background = THREE.REVISION ? '#00f' : '#f00'; window.__ready = true;
    </script></body></html>`;
    const r = await renderer.image(page, new AbortController().signal);
    expect(r.errors).toEqual([]);
    const { dominant } = await sharp(r.png).stats();
    expect(dominant.b).toBeGreaterThan(200);
  }, 30_000);
});

describe('claude CLI runner', () => {
  it('runs a tool-less, settings-less session, strips API keys, and reads the result event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeclaude-'));
    const bin = path.join(dir, 'claude');
    // a fake CLI that echoes its argv, stdin, and whether an API key leaked into its environment
    fs.writeFileSync(bin, `#!/usr/bin/env node
let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const msg = JSON.parse(input).message.content;
  console.log(JSON.stringify({ type: 'system' }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ argv: process.argv.slice(2), prompt: msg[0].text, image: !!msg[1], key: process.env.ANTHROPIC_API_KEY ?? null }), total_cost_usd: 0.01, duration_ms: 1234, usage: {}, modelUsage: { 'claude-opus-5-5': {} } }));
});`);
    fs.chmodSync(bin, 0o755);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    try {
      const r = await runClaude({ bin, cwd: dir }, { modelId: 'claude-cli/opus', prompt: 'hello', image: { bytes: Buffer.from('x'), mime: 'image/png' }, signal: new AbortController().signal });
      const echo = JSON.parse(r.text);
      expect(echo.key).toBeNull();
      expect(echo.prompt).toBe('hello');
      expect(echo.image).toBe(true);
      expect(echo.argv).toEqual(expect.arrayContaining(['-p', '--model', 'opus', '--effort', 'low', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence']));
      expect(r.model).toBe('claude-opus-5-5');
      expect(r.durationMs).toBe(1234);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('new step types in the chain', () => {
  it('every new step type chains: nothing but video is a dead end', () => {
    for (const [type, t] of Object.entries(STEP_TYPES)) {
      if (t.output === 'video') continue;
      expect(NEXT_ACTIONS[t.output].length, `${type} → ${t.output}`).toBeGreaterThan(0);
    }
    expect(bridgeType('audio', 'text')).toBe('audio_to_text');
    expect(providerFor({ type: 'image_to_text', modelId: 'claude-cli/opus' })).toBe('claude');
    expect(providerFor({ type: 'image_to_text', modelId: 'google/gemini-2.5-flash' })).toBe('openrouter');
    expect(providerFor({ type: 'text_to_svg', modelId: 'openai/gpt-4.1-mini' })).toBe('code');
    expect(validateChain('image', [{ type: 'image_to_text' }, { type: 'text_to_audio' }, { type: 'image_to_text' }])[0].message).toMatch(/needs a image, but step 2 produces a audio/);
  });

  it('runs a mixed chain end to end: speech, SVG, ASCII, 3D, and a code animation', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock, claude: mock, code: mock, gemini: mock } });
    const up = (await uploadDesktop(app, await makeJpeg(160, 120), 'x.jpg')).json();
    await post(app, `/api/session/uploads/${up.uploadId}/accept`);
    const s = (type: StepType, modelId: string, params: StepDefinition['params'] = {}): StepDefinition => ({ id: type, type, modelId, instruction: 'go', params });
    const preset: PresetBody = {
      schemaVersion: PRESET_SCHEMA_VERSION, name: 'mixed', startingKind: 'image',
      steps: [
        s('image_to_text', 'claude-cli/opus'),
        { ...s('text_to_audio', 'gemini-3.8-flash-tts', { voice: 'Kore' }), instruction: 'excited' },
        s('audio_to_text', 'gemini-3.8-flash'),
        s('text_to_svg', 'claude-cli/opus'),
        s('image_to_svg', 'claude-cli/sonnet'),
        s('image_to_text', 'google/gemini-2.5-flash'),
        s('text_to_ascii', 'claude-cli/opus'),
        s('image_to_text', 'google/gemini-2.5-flash'),
        s('text_to_code_image', 'claude-cli/opus'),
        s('image_to_text', 'google/gemini-2.5-flash'),
        s('text_to_code_video', 'claude-cli/opus'),
      ],
    };
    const res = await post(app, '/api/runs', { preset });
    expect(res.statusCode, res.body).toBe(200);
    await post(app, `/api/runs/${res.json().id}/actions`, { action: 'start' });
    await app.runner.idle();
    const run = (await get(app, `/api/runs/${res.json().id}`)).json();
    expect(run.status, run.statusReason).toBe('completed');
    expect(run.steps.map((x: any) => x.artifact.kind)).toEqual(['text', 'audio', 'text', 'image', 'image', 'text', 'image', 'text', 'image', 'text', 'video']);
    const audio = run.steps[1].artifact;
    expect(audio.mime).toBe('audio/mpeg');
    expect(audio.durationSec).toBeGreaterThan(0.5);
    // the transcriber was handed the speech, and nothing else
    expect(mock.calls[2].input.kind).toBe('audio');
    const media = await get(app, `/media/${audio.id}`);
    expect(media.headers['content-type']).toBe('audio/mpeg');
  });

  it('audio cannot be a run source, and an unknown voice is rejected', async () => {
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock, claude: mock, code: mock, gemini: mock } });
    const bad = { schemaVersion: PRESET_SCHEMA_VERSION, name: 'x', startingKind: 'text', steps: [{ id: 'a', type: 'text_to_audio', modelId: 'gemini-3.8-flash-tts', instruction: '', params: { voice: 'Nobody' } }] };
    const res = await post(app, '/api/presets/validate', bad);
    expect(res.json().issues.map((i: any) => i.message).join()).toMatch(/Voice "Nobody"/);
    const wordy = await post(app, '/api/presets/validate', { ...bad, steps: [{ ...bad.steps[0], instruction: 'Read it like a pirate', params: {} }] });
    expect(wordy.json().issues.map((i: any) => i.message).join()).toMatch(/instruction is its tone/);
    const audio = app.store.saveMedia('audio', Buffer.from('ID3fake'), { mime: 'audio/mpeg', durationSec: 1 }, null);
    const src = await post(app, '/api/session/source', { artifactId: audio.id });
    expect(src.statusCode).toBe(400);
    expect(src.body).toMatch(/cannot start from audio/);
  });
});

describe('Gemini audio adapter', () => {
  const wav = (seconds: number) => {
    const rate = 24000, data = Buffer.alloc(Math.round(seconds * rate) * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  };
  const fake = (reply: (body: any) => any) => {
    const bodies: any[] = [];
    const f = (async (_u: any, init: any) => { const b = JSON.parse(init.body); bodies.push(b); return new Response(JSON.stringify(reply(b)), { status: 200 }); }) as typeof fetch;
    return { bodies, f };
  };
  const script = 'A red mug and a blue duck sit on a yellow book beside a small cactus on a sunny wooden table by the window.';
  const req = (over: Partial<StepRequest>): StepRequest => ({ type: 'text_to_audio', modelId: 'gemini-3.8-flash-tts', instruction: 'whispering', params: { voice: 'Kore' }, input: { kind: 'text', text: script }, signal: new AbortController().signal, ...over });

  it('sends the direction as a leading [style tag] and returns MP3', async () => {
    const { GeminiAdapter } = await import('../server/providers/gemini.ts');
    const { bodies, f } = fake(() => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav(8).toString('base64') } }] } }] }));
    const r = await new GeminiAdapter({ apiKey: 'k', tmpDir: os.tmpdir(), fetchImpl: f, verifyModel: null }).execute(req({}));
    expect(bodies[0].contents[0].parts[0].text).toBe(`[whispering] ${script}`);
    expect(bodies[0].generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(r.output.kind).toBe('audio');
    expect((r.output as any).bytes.subarray(0, 3).toString('latin1')).toMatch(/^(ID3|\xff)/);
  });

  it('refuses a free-text direction (it would be read aloud)', async () => {
    const { GeminiAdapter } = await import('../server/providers/gemini.ts');
    const { bodies, f } = fake(() => ({}));
    await expect(new GeminiAdapter({ apiKey: 'k', tmpDir: os.tmpdir(), fetchImpl: f }).execute(req({ instruction: 'A hushed documentary narrator.' }))).rejects.toMatchObject({ kind: 'bad_request' });
    expect(bodies).toHaveLength(0);
  });

  it('rejects (retryably) a clip far too short to be a reading of the script', async () => {
    const { GeminiAdapter } = await import('../server/providers/gemini.ts');
    const { f } = fake(() => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav(1.5).toString('base64') } }] } }] }));
    await expect(new GeminiAdapter({ apiKey: 'k', tmpDir: os.tmpdir(), fetchImpl: f, verifyModel: null }).execute(req({}))).rejects.toMatchObject({ kind: 'empty_output', retryable: true });
  });

  it('a used-up DAILY quota fails fast with advice instead of retrying', async () => {
    const { GeminiAdapter } = await import('../server/providers/gemini.ts');
    const f = (async () => new Response(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }, { retryDelay: '44826s' }] } }), { status: 429 })) as unknown as typeof fetch;
    await expect(new GeminiAdapter({ apiKey: 'k', tmpDir: os.tmpdir(), fetchImpl: f }).execute(req({}))).rejects.toMatchObject({ kind: 'credits', retryable: false, message: expect.stringMatching(/daily quota.*lite-tts/) });
  });

  it('transcription keeps only final (non-thought) text', async () => {
    const { GeminiAdapter } = await import('../server/providers/gemini.ts');
    const { bodies, f } = fake(() => ({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: ' hello world ' }] } }] }));
    const r = await new GeminiAdapter({ apiKey: 'k', tmpDir: os.tmpdir(), fetchImpl: f, verifyModel: null }).execute(req({ type: 'audio_to_text', modelId: 'gemini-3.8-flash', instruction: 'Transcribe.', input: { kind: 'audio', bytes: Buffer.from('ID3x'), mime: 'audio/mpeg' } }));
    expect(r.output).toEqual({ kind: 'text', text: 'hello world' });
    expect(bodies[0].contents[0].parts[1].inlineData.mimeType).toBe('audio/mpeg');
  });
});

describe('speech direction leak check', () => {
  it('spots a transcript that opens with the direction, not the script', async () => {
    const { directionLeaked } = await import('../server/providers/gemini.ts');
    const dir = 'A hushed, reverent nature-documentary narrator, marvelling quietly at every detail, with gentle pauses.';
    const script = 'A rustic wooden table holds a red mug, a blue duck on a yellow book, and a cactus.';
    expect(directionLeaked('A hushed, reverent nature documentary narrator, marveling quietly at every detail. A rustic wooden table…', dir, script)).toBe(true);
    expect(directionLeaked('A rustic wooden table holds a red mug, a blue duck on a yellow book, and a cactus.', dir, script)).toBe(false);
    expect(directionLeaked('An over-excited sports commentator calling the most thrilling moment', 'An over-excited sports commentator calling the most thrilling moment of the championship.', script)).toBe(true);
    // a one-word tone spoken aloud (seen live on the Lite model), but not when the script itself starts with it
    expect(directionLeaked('Whispering. A still life composition featuring objects', 'whispering', 'A still life composition featuring objects')).toBe(true);
    expect(directionLeaked('Whispering winds sweep the valley', 'whispering', 'Whispering winds sweep the valley')).toBe(false);
    // a made-up preamble mixing script and direction, then the real reading starting over (seen live)
    const sports = 'An over-excited sports commentator calling the most thrilling moment of the championship, fast and loud, rising to a crescendo.';
    const sill = 'A warm, naturally lit scene on a rustic wooden windowsill features a line of objects.';
    expect(directionLeaked('A warm, naturally lit scene on a rustic wooden window sill. Fast and loud, rising to a crescendo.', sports, sill)).toBe(true);
    expect(directionLeaked('A warm, naturally lit scene on a rustic wooden window sill. A warm, naturally lit scene on a rustic wooden window sill features', sports, sill)).toBe(true);
    expect(directionLeaked('A warm, naturally lit scene on a rustic wooden windowsill features a line of objects. From left to right', sports, sill)).toBe(false);
  });
});

describe('OpenRouter upstream rate limit', () => {
  it('"temporarily rate-limited upstream" inside a 200 response is retryable', async () => {
    const { OpenRouterAdapter } = await import('../server/providers/openrouter.ts');
    const f = (async () => new Response(JSON.stringify({ id: 'gen-1', choices: [{ error: { code: 429, message: 'google/gemini-2.5-flash is temporarily rate-limited upstream. Please retry shortly' } }] }), { status: 200 })) as unknown as typeof fetch;
    const or = new OpenRouterAdapter({ apiKey: 'sk-or-x', fetchImpl: f });
    await expect(or.execute({ type: 'text_to_text', modelId: 'google/gemini-2.5-flash', instruction: 'x', params: {}, input: { kind: 'text', text: 'y' }, signal: new AbortController().signal }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryable: true });
  });
});

describe('Claude never bills through OpenRouter', () => {
  it('the OpenRouter adapter refuses anthropic/* before any request', async () => {
    const { OpenRouterAdapter } = await import('../server/providers/openrouter.ts');
    let called = false;
    const or = new OpenRouterAdapter({ apiKey: 'sk-or-x', fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch });
    await expect(or.execute({ type: 'text_to_text', modelId: 'anthropic/claude-sonnet-4.6', instruction: 'x', params: {}, input: { kind: 'text', text: 'y' }, signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(called).toBe(false);
  });

  it('anthropic/* is not offered in the catalog and is rejected by validation', async () => {
    const catalog = (async (u: any) => new Response(JSON.stringify({ data: String(u).includes('/images/') ? [] : [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'openai/gpt-4.1-mini', name: 'GPT', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    ] }))) as unknown as typeof fetch;
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock }, catalogFetch: catalog });
    const models = (await post(app, '/api/models/refresh')).json().models.map((m: any) => m.id);
    expect(models).toContain('openai/gpt-4.1-mini');
    expect(models.some((id: string) => id.startsWith('anthropic/'))).toBe(false);
    expect(models).toContain('claude-cli/sonnet');
    const v = await post(app, '/api/presets/validate', { schemaVersion: PRESET_SCHEMA_VERSION, name: 'x', startingKind: 'text', steps: [{ id: 'a', type: 'text_to_text', modelId: 'anthropic/claude-sonnet-4.6', instruction: 'x', params: {} }] });
    expect(v.json().issues.map((i: any) => i.message).join()).toMatch(/claude CLI/);
  });
});
