import { sha256 } from '../db.ts';
import { ProviderError, scrub, type StepAdapter, type StepRequest, type StepResult } from './types.ts';

const BASE = 'https://openrouter.ai/api/v1';

const REFUSAL_RE = /^\s*(i['’]?m sorry|i am sorry|sorry,|i can(?:['’]t|not)|i(?:['’]m| am) (?:unable|not able)|i won['’]t)\b/i;

export type OpenRouterOpts = { apiKey: string; fetchImpl?: typeof fetch; chatTimeoutMs?: number; imageTimeoutMs?: number };

export class OpenRouterAdapter implements StepAdapter {
  opts: OpenRouterOpts;
  constructor(opts: OpenRouterOpts) {
    this.opts = opts;
  }

  async execute(req: StepRequest): Promise<StepResult> {
    if (req.type === 'text_to_image') return this.generateImage(req);
    if (req.type === 'image_to_text' || req.type === 'text_to_text') return this.chat(req);
    throw new ProviderError('unsupported', `OpenRouter adapter cannot run ${req.type}`);
  }

  private async post(path: string, body: unknown, timeoutMs: number, signal: AbortSignal): Promise<any> {
    if (!this.opts.apiKey) throw new ProviderError('auth', 'OPENROUTER_API_KEY is not configured in .env');
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'AI Telephone (local)',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (e: any) {
      if (signal.aborted) throw new ProviderError('cancelled', 'Cancelled by host. The provider may still finish and bill this request.');
      // The request may or may not have reached the provider: never auto-retry.
      throw new ProviderError('ambiguous', `Connection to OpenRouter failed or timed out (${scrub(String(e?.message ?? e), [this.opts.apiKey])}). The request may already have been processed and billed.`);
    }
    let json: any = null;
    let raw = '';
    try {
      raw = await res.text();
      json = JSON.parse(raw);
    } catch {
      if (res.ok) throw new ProviderError('ambiguous', 'OpenRouter returned an unreadable response; the request may have been billed.');
    }
    if (!res.ok || json?.error) {
      const status = res.ok ? Number(json?.error?.code) || 500 : res.status;
      const msg = scrub(String(json?.error?.message ?? raw ?? res.statusText), [this.opts.apiKey]);
      const ra = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : undefined;
      if (status === 401 || status === 403) throw new ProviderError('auth', `OpenRouter rejected the API key or access to this model (${status}): ${msg}`);
      if (status === 402) throw new ProviderError('credits', `OpenRouter: insufficient credits (402): ${msg}`);
      if (status === 429) throw new ProviderError('rate_limited', `OpenRouter rate limit (429): ${msg}`, { retryable: true, retryAfterMs });
      if (status === 408 || status === 504) throw new ProviderError('ambiguous', `OpenRouter timed out upstream (${status}); the request may have been billed: ${msg}`);
      if (status >= 500) throw new ProviderError('server_error', `OpenRouter/provider error (${status}): ${msg}`, { retryable: status === 500 || status === 502 || status === 503, retryAfterMs });
      throw new ProviderError('bad_request', `OpenRouter rejected the request (${status}): ${msg}`);
    }
    return json;
  }

  private async chat(req: StepRequest): Promise<StepResult> {
    // A brand-new messages array per step: no history, no system prompt carrying run context.
    const content: any[] = [{ type: 'text', text: req.instruction }];
    let snapshotInput: unknown;
    if (req.type === 'image_to_text') {
      if (req.input.kind !== 'image') throw new ProviderError('unsupported', 'image_to_text requires an image input');
      content.push({ type: 'image_url', image_url: { url: `data:${req.input.mime};base64,${req.input.bytes.toString('base64')}` } });
      snapshotInput = { image_sha256: sha256(req.input.bytes), mime: req.input.mime };
    } else {
      if (req.input.kind !== 'text') throw new ProviderError('unsupported', 'text_to_text requires a text input');
      content.push({ type: 'text', text: req.input.text });
      snapshotInput = { text: req.input.text };
    }
    const body = { model: req.modelId, messages: [{ role: 'user', content }], usage: { include: true } };
    const json = await this.post('/chat/completions', body, this.opts.chatTimeoutMs ?? 120_000, req.signal);
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    // Only final user-facing content becomes the artifact. Reasoning/annotations are ignored.
    let text = '';
    if (typeof msg?.content === 'string') text = msg.content;
    else if (Array.isArray(msg?.content)) text = msg.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
    text = text.trim();
    const meta = {
      usage: json?.usage,
      costUsd: typeof json?.usage?.cost === 'number' ? json.usage.cost : null,
      providerModel: json?.model,
      providerName: json?.provider,
      providerRequestId: json?.id,
    };
    if (choice?.error) throw new ProviderError('server_error', scrub(`Provider error: ${choice.error?.message ?? 'unknown'}`, [this.opts.apiKey]), { providerRequestId: json?.id });
    if (msg?.refusal) throw new ProviderError('refusal', `Model refused: ${String(msg.refusal).slice(0, 300)}`, { providerRequestId: json?.id });
    if (choice?.finish_reason === 'content_filter' || choice?.native_finish_reason === 'SAFETY')
      throw new ProviderError('safety', 'The provider blocked this content (content filter).', { providerRequestId: json?.id });
    if (!text) throw new ProviderError('empty_output', 'Model returned empty text; the run is paused instead of passing nothing downstream.', { providerRequestId: json?.id });
    if (text.length < 400 && REFUSAL_RE.test(text)) throw new ProviderError('refusal', `Model appears to have refused: "${text.slice(0, 200)}"`, { providerRequestId: json?.id });
    return {
      output: { kind: 'text', text },
      ...meta,
      costStatus: meta.costUsd == null ? 'unknown' : 'actual',
      requestSnapshot: { endpoint: '/chat/completions', model: req.modelId, instruction: req.instruction, input: snapshotInput },
    };
  }

  private async generateImage(req: StepRequest): Promise<StepResult> {
    if (req.input.kind !== 'text') throw new ProviderError('unsupported', 'text_to_image requires a text input');
    const prompt = `${req.instruction.trim()}\n\n${req.input.text}`.trim();
    // input_references is omitted entirely: classic telephone never sends a reference image.
    const body: Record<string, unknown> = { model: req.modelId, prompt, n: 1 };
    if (req.params.aspect_ratio) body.aspect_ratio = req.params.aspect_ratio;
    if (req.params.resolution) body.resolution = req.params.resolution;
    const json = await this.post('/images', body, this.opts.imageTimeoutMs ?? 240_000, req.signal);
    const b64 = json?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || b64.length < 100) throw new ProviderError('empty_output', 'Image API returned no image data.');
    const bytes = Buffer.from(b64, 'base64');
    const cost = typeof json?.usage?.cost === 'number' ? json.usage.cost : null;
    return {
      output: { kind: 'image', bytes },
      usage: json?.usage,
      costUsd: cost,
      costStatus: cost == null ? 'unknown' : 'actual',
      providerModel: json?.model ?? req.modelId,
      providerName: json?.provider,
      providerRequestId: json?.id,
      requestSnapshot: { endpoint: '/images', ...body },
    };
  }
}
