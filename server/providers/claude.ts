import { spawn } from 'node:child_process';
import { sha256 } from '../db.ts';
import { CLAUDE_CLI_PREFIX } from '../../shared/types.ts';
import { ProviderError, type StepAdapter, type StepRequest, type StepResult } from './types.ts';

/**
 * Runs Claude through the local Claude Code CLI (`claude -p`), so usage counts against the signed-in
 * subscription instead of an API key. Every call is a fresh, tool-less, settings-less session: the model
 * sees the instruction and the predecessor artifact, nothing else (the telephone rule).
 */

const REFUSAL_RE = /^\s*(i['’]?m sorry|i am sorry|sorry,|i can(?:['’]t|not)|i(?:['’]m| am) (?:unable|not able)|i won['’]t)\b/i;

/** effort: the CLI's --effort level. Default "low": about half the latency of "medium" with comparable art (2026-09-25). */
export type ClaudeCliOpts = { bin?: string; cwd: string; timeoutMs?: number; effort?: string };

export type ClaudeCall = {
  modelId: string; // claude-cli/<alias or full model id>
  prompt: string;
  image?: { bytes: Buffer; mime: string };
  system?: string;
  signal: AbortSignal;
};

export type ClaudeReply = { text: string; usage: unknown; model: string; listCostUsd: number | null; durationMs: number | null };

const DEFAULT_SYSTEM = 'You are one player in a game of telephone. Do exactly what the request asks and return only the requested output, with no preamble, commentary, or questions.';

export async function runClaude(opts: ClaudeCliOpts, call: ClaudeCall): Promise<ClaudeReply> {
  const model = call.modelId.slice(CLAUDE_CLI_PREFIX.length) || 'opus';
  const args = [
    '-p', '--model', model, '--effort', opts.effort ?? process.env.CLAUDE_CLI_EFFORT ?? 'low',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--no-session-persistence', '--disable-slash-commands',
    '--system-prompt', call.system ?? DEFAULT_SYSTEM,
  ];
  // Never let an API key in the environment silently switch the CLI to pay-per-token billing.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const content: unknown[] = [{ type: 'text', text: call.prompt }];
  if (call.image) content.push({ type: 'image', source: { type: 'base64', media_type: call.image.mime, data: call.image.bytes.toString('base64') } });
  const message = JSON.stringify({ type: 'user', message: { role: 'user', content } });

  return new Promise<ClaudeReply>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin ?? process.env.CLAUDE_BIN ?? 'claude', args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      return reject(new ProviderError('auth', `Could not start the claude CLI (${e?.message ?? e}). Install Claude Code and sign in, or set CLAUDE_BIN.`));
    }
    let out = '', err = '', settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); call.signal.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => { child.kill('SIGTERM'); finish(() => reject(new ProviderError('cancelled', 'Cancelled by host.'))); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(() => reject(new ProviderError('ambiguous', `claude CLI timed out after ${Math.round((opts.timeoutMs ?? 300_000) / 1000)}s.`))); }, opts.timeoutMs ?? 300_000);
    call.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: any) => finish(() => reject(new ProviderError('auth', e?.code === 'ENOENT' ? 'The claude CLI is not on PATH. Install Claude Code and sign in, or set CLAUDE_BIN.' : `claude CLI failed to start: ${e?.message ?? e}`))));
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    child.on('close', (code) => finish(() => {
      let result: any = null;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.type === 'result') result = j; } catch { /* non-JSON noise */ }
      }
      if (!result) return reject(new ProviderError('other', `claude CLI exited (${code}) without a result: ${(err || out).trim().slice(-400)}`));
      const text = String(result.result ?? '').trim();
      if (result.is_error) {
        const msg = text || String(result.subtype ?? 'error');
        if (/usage limit|rate.?limit|limit reached|quota/i.test(msg)) return reject(new ProviderError('rate_limited', `Claude subscription limit: ${msg.slice(0, 300)}`));
        if (/log ?in|auth|credential|api key/i.test(msg)) return reject(new ProviderError('auth', `claude CLI is not signed in: ${msg.slice(0, 300)}`));
        return reject(new ProviderError('server_error', `claude CLI error: ${msg.slice(0, 300)}`, { retryable: /overloaded|529|500/i.test(msg) }));
      }
      if (!text) return reject(new ProviderError('empty_output', 'Claude returned no text.'));
      const modelUsed = Object.keys(result.modelUsage ?? {}).find((k) => !k.includes('haiku') || model.includes('haiku')) ?? model;
      resolve({ text, usage: result.usage, model: modelUsed, listCostUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null, durationMs: result.duration_ms ?? null });
    }));
    child.stdin!.end(message + '\n');
  });
}

/** Describe/retell steps on a `claude-cli/…` model. */
export class ClaudeCliAdapter implements StepAdapter {
  opts: ClaudeCliOpts;
  constructor(opts: ClaudeCliOpts) {
    this.opts = opts;
  }

  async execute(req: StepRequest): Promise<StepResult> {
    if (req.type !== 'image_to_text' && req.type !== 'text_to_text') throw new ProviderError('unsupported', `The claude CLI adapter cannot run ${req.type}.`);
    let prompt = req.instruction;
    let image: ClaudeCall['image'];
    let snapshotInput: unknown;
    if (req.type === 'image_to_text') {
      if (req.input.kind !== 'image') throw new ProviderError('unsupported', 'image_to_text requires an image input');
      image = { bytes: req.input.bytes, mime: req.input.mime };
      snapshotInput = { image_sha256: sha256(req.input.bytes), mime: req.input.mime };
    } else {
      if (req.input.kind !== 'text') throw new ProviderError('unsupported', 'text_to_text requires a text input');
      prompt = `${req.instruction}\n\n${req.input.text}`;
      snapshotInput = { text: req.input.text };
    }
    const r = await runClaude(this.opts, { modelId: req.modelId, prompt, image, signal: req.signal });
    if (r.text.length < 400 && REFUSAL_RE.test(r.text)) throw new ProviderError('refusal', `Model appears to have refused: "${r.text.slice(0, 200)}"`);
    return {
      output: { kind: 'text', text: r.text },
      ...subscriptionCost(r),
      providerModel: r.model,
      providerName: 'claude-cli (subscription)',
      inferenceSec: r.durationMs != null ? Math.round(r.durationMs / 100) / 10 : null,
      requestSnapshot: { via: 'claude -p', model: req.modelId, instruction: req.instruction, input: snapshotInput },
    };
  }
}

/** Subscription usage has no per-call bill: record $0 as an estimate, and keep the list-price equivalent in usage. */
export function subscriptionCost(r: ClaudeReply) {
  return { costUsd: 0, costStatus: 'estimated' as const, usage: { ...(r.usage as object), list_price_equivalent_usd: r.listCostUsd } };
}
