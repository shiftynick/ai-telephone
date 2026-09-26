import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_MODELS } from '../../shared/types.ts';
import { ProviderError, scrub, type StepAdapter, type StepRequest, type StepResult } from './types.ts';

/**
 * A model running on this laptop (Omarchy "Local AI" plugin: TabbyAPI behind an OpenAI-compatible gateway).
 * The only step that never leaves the machine, and free. Text → text only: the gateway silently drops image
 * parts (200 OK, "no image attached"), so image input is refused here rather than sent.
 * It is a thinking model: reasoning arrives in message.reasoning_content and can use the whole token budget,
 * leaving content null with finish_reason "length" — that is a failure, never an empty artifact.
 * It is not always running (stopped to free VRAM), so connection refused is a clear, non-retryable error.
 */
export type LocalOpts = { baseUrl?: string; keyFile?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxTokens?: number };

const DEFAULT_KEY_FILE = path.join(os.homedir(), '.local/state/omarchy/local-ai/gateway.key');
const NOT_RUNNING = 'Local model isn’t running — start Qwen3.5-9B from the Local AI button on the Omarchy bar, then Retry.';

export class LocalAdapter implements StepAdapter {
  opts: LocalOpts;
  constructor(opts: LocalOpts = {}) {
    this.opts = opts;
  }

  /** Read at request time (the plugin can rotate it); server-side only, never logged or sent to the browser. */
  private key(): string {
    try {
      return fs.readFileSync(this.opts.keyFile ?? DEFAULT_KEY_FILE, 'utf8').trim();
    } catch {
      throw new ProviderError('auth', 'Local AI gateway key not found (~/.local/state/omarchy/local-ai/gateway.key). Start the Local AI plugin once to create it.');
    }
  }

  async execute(req: StepRequest): Promise<StepResult> {
    const served = LOCAL_MODELS[req.modelId]?.served;
    if (!served) throw new ProviderError('bad_request', `Unknown local model "${req.modelId}".`);
    if (req.type !== 'text_to_text' || req.input.kind !== 'text')
      throw new ProviderError('unsupported', `${req.modelId} is text-only: it silently ignores images, so it only runs text → text steps.`);
    const key = this.key();
    const base = (this.opts.baseUrl ?? process.env.LOCAL_AI_BASE_URL ?? 'http://127.0.0.1:12434/v1').replace(/\/+$/, '');
    const body = { model: served, messages: [{ role: 'user', content: [{ type: 'text', text: req.instruction }, { type: 'text', text: req.input.text }] }], max_tokens: this.opts.maxTokens ?? 6000 };
    const t0 = Date.now();
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(this.opts.timeoutMs ?? 300_000)]),
      });
    } catch (e: any) {
      if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled by host.');
      if (e?.name === 'TimeoutError') throw new ProviderError('server_error', `The local model took longer than ${Math.round((this.opts.timeoutMs ?? 300_000) / 1000)}s (it thinks a lot at ~70 tok/s). Nothing is billed, so Retry is safe.`);
      const code = e?.cause?.code ?? e?.code;
      if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code) || /ECONNREFUSED/.test(String(e?.cause?.message ?? e?.message)))
        throw new ProviderError('unsupported', NOT_RUNNING);
      throw new ProviderError('server_error', `Local model request failed: ${scrub(String(e?.message ?? e), [key])}. Nothing is billed, so Retry is safe.`);
    }
    const raw = await res.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch { /* below */ }
    if (!res.ok || json?.error) {
      const msg = scrub(String(json?.error?.message ?? json?.detail ?? raw ?? res.statusText), [key]).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `Local AI gateway rejected the key (${res.status}): ${msg}`);
      if (res.status === 502 || res.status === 503) throw new ProviderError('unsupported', `${NOT_RUNNING} (${res.status}: ${msg})`);
      throw new ProviderError('server_error', `Local model error (${res.status}): ${msg}`);
    }
    const choice = json?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : null;
    if (!text) {
      throw new ProviderError('empty_output', choice?.finish_reason === 'length'
        ? `The local model spent its whole ${body.max_tokens}-token budget thinking and gave no answer. Retry, or use a shorter instruction.`
        : 'The local model returned no answer text.');
    }
    return {
      output: { kind: 'text', text },
      usage: json?.usage,
      costUsd: 0,
      costStatus: 'actual', // genuinely free: runs on this laptop
      providerModel: json?.model ?? served,
      providerName: 'local (this laptop)',
      inferenceSec: Math.round((Date.now() - t0) / 100) / 10,
      // reasoning is kept for inspection (shown like an expanded prompt), never used as the step output
      expandedPrompt: reasoning ? `[model reasoning, not passed on]\n${reasoning}` : null,
      requestSnapshot: { endpoint: `${base}/chat/completions`, model: served, instruction: req.instruction, input: { text: req.input.text }, max_tokens: body.max_tokens },
    };
  }
}
