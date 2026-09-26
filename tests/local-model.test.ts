import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { closeAll, makeApp, post } from './helpers.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { LocalAdapter } from '../server/providers/local.ts';
import { PRESET_SCHEMA_VERSION, providerFor } from '../shared/types.ts';
import type { StepRequest } from '../server/providers/types.ts';

afterEach(closeAll);

const KEY = 'local-gateway-SECRET-abcdef123456';
const keyFile = () => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lk-')), 'gateway.key'); fs.writeFileSync(f, KEY + '\n'); return f; };
const req = (over: Partial<StepRequest> = {}): StepRequest => ({ type: 'text_to_text', modelId: 'local/qwen3.5-9b', instruction: 'Retell it.', params: {}, input: { kind: 'text', text: 'A duck on a book.' }, signal: new AbortController().signal, ...over });
const reply = (message: any, finish = 'stop', status = 200) => {
  const calls: any[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ model: 'Qwen3.5-9B-EXL3-6hb-4bpw', choices: [{ message, finish_reason: finish }], usage: { completion_tokens: 900 } }), { status }); }) as typeof fetch;
  return { calls, f };
};

describe('local model (this laptop)', () => {
  it('returns the answer (trimmed), keeps reasoning out of the output, costs an ACTUAL $0, and reads the key server-side', async () => {
    const { calls, f } = reply({ content: '\n\nA book wearing a duck.', reasoning_content: 'Let me think… '.repeat(50) });
    const r = await new LocalAdapter({ fetchImpl: f, keyFile: keyFile(), baseUrl: 'http://127.0.0.1:12999/v1/' }).execute(req());
    expect(r.output).toEqual({ kind: 'text', text: 'A book wearing a duck.' });
    expect([r.costUsd, r.costStatus]).toEqual([0, 'actual']);
    expect(r.expandedPrompt).toMatch(/^\[model reasoning, not passed on\]/);
    expect(calls[0].url).toBe('http://127.0.0.1:12999/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body.model).toBe('Qwen3.5-9B-EXL3-6hb-4bpw');
    expect(calls[0].body.max_tokens).toBeGreaterThanOrEqual(4000);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('a thinking-only reply (null content, finish_reason "length") is a clear failure, not an empty artifact', async () => {
    const { f } = reply({ content: null, reasoning_content: 'hmm '.repeat(500) }, 'length');
    await expect(new LocalAdapter({ fetchImpl: f, keyFile: keyFile() }).execute(req())).rejects.toMatchObject({ kind: 'empty_output', message: expect.stringMatching(/whole .*token budget thinking/) });
    const blank = reply({ content: '\n\n  ' });
    await expect(new LocalAdapter({ fetchImpl: blank.f, keyFile: keyFile() }).execute(req())).rejects.toMatchObject({ kind: 'empty_output' });
  });

  it('connection refused says to start it from the bar, and is not "ambiguous/may be billed" (real loopback + faked)', async () => {
    // a loopback port that was just free: a real ECONNREFUSED from Node's fetch
    const port = await new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
    const real = new LocalAdapter({ keyFile: keyFile(), baseUrl: `http://127.0.0.1:${port}/v1` });
    await expect(real.execute(req())).rejects.toMatchObject({ kind: 'unsupported', retryable: false, message: expect.stringMatching(/isn’t running.*Local AI button/) });
    const refused = (async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:12434'), { code: 'ECONNREFUSED' }) }); }) as unknown as typeof fetch;
    const e: any = await new LocalAdapter({ fetchImpl: refused, keyFile: keyFile() }).execute(req()).catch((x) => x);
    expect(e.kind).toBe('unsupported');
    expect(e.message).not.toMatch(/billed/i);
  });

  it('refuses image input instead of sending it (the gateway would silently drop it)', async () => {
    const { calls, f } = reply({ content: 'x' });
    await expect(new LocalAdapter({ fetchImpl: f, keyFile: keyFile() }).execute(req({ type: 'image_to_text', input: { kind: 'image', bytes: Buffer.from('x'), mime: 'image/png' } })))
      .rejects.toMatchObject({ kind: 'unsupported' });
    expect(calls).toHaveLength(0);
  });

  it('gateway errors never echo the key', async () => {
    const f = (async () => new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status: 401 })) as unknown as typeof fetch;
    const e: any = await new LocalAdapter({ fetchImpl: f, keyFile: keyFile() }).execute(req()).catch((x) => x);
    expect(e.kind).toBe('auth');
    expect(e.message).not.toContain(KEY);
  });

  it('is offered for text → text only, routed to the local adapter, and absent from presets', async () => {
    expect(providerFor({ type: 'text_to_text', modelId: 'local/qwen3.5-9b' })).toBe('local');
    const mock = new MockAdapter('/tmp', 0);
    const app = await makeApp({ adapters: { openrouter: mock, fal: mock } });
    const entry = (await post(app, '/api/models/refresh')).json().models.find((m: any) => m.id === 'local/qwen3.5-9b');
    expect(entry.stepTypes).toEqual(['text_to_text']);
    expect(entry.name).toMatch(/local · this laptop · free/);
    const bad = await post(app, '/api/presets/validate', { schemaVersion: PRESET_SCHEMA_VERSION, name: 'x', startingKind: 'image', steps: [{ id: 'a', type: 'image_to_text', modelId: 'local/qwen3.5-9b', instruction: 'x', params: {} }] });
    expect(bad.json().issues.map((i: any) => i.message).join()).toMatch(/does not support image → text/);
    const presets = (await app.app.inject({ method: 'GET', url: '/api/presets', headers: { host: 'localhost:8787', cookie: app.cookie } })).json().presets;
    expect(JSON.stringify(presets)).not.toContain('local/');
  });
});
