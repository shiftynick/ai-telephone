import { createFalClient } from '@fal-ai/client';
import { sha256 } from '../db.ts';
import { safeDownload, MediaError } from '../media.ts';
import { ProviderError, scrub, type StepAdapter, type StepRequest, type StepResult } from './types.ts';

export const FAL_ENDPOINTS = {
  image_to_video: 'minimax/h3-max-turbo/image-to-video',
  text_to_video: 'minimax/h3-max-turbo/text-to-video',
} as const;

/** Minimal surface of the fal client we depend on, so tests can substitute it. */
export interface FalLike {
  upload(bytes: Buffer, mime: string): Promise<string>;
  submit(endpoint: string, input: Record<string, unknown>): Promise<{ request_id: string }>;
  status(endpoint: string, requestId: string): Promise<{ status: string }>;
  result(endpoint: string, requestId: string): Promise<{ data: any }>;
  cancel(endpoint: string, requestId: string): Promise<void>;
}

export function realFal(apiKey: string): FalLike {
  const fal = createFalClient({ credentials: apiKey });
  return {
    upload: (bytes, mime) => fal.storage.upload(new Blob([new Uint8Array(bytes)], { type: mime })),
    submit: (endpoint, input) => fal.queue.submit(endpoint, { input }) as Promise<{ request_id: string }>,
    status: (endpoint, requestId) => fal.queue.status(endpoint, { requestId, logs: false }) as Promise<{ status: string }>,
    result: (endpoint, requestId) => fal.queue.result(endpoint, { requestId }) as Promise<{ data: any }>,
    cancel: (endpoint, requestId) => fal.queue.cancel(endpoint, { requestId }),
  };
}

export type FalOpts = {
  apiKey: string;
  client?: FalLike;
  pollMs?: number;
  maxWaitMs?: number;
  download?: (url: string, signal: AbortSignal) => Promise<Buffer>;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });

export class FalAdapter implements StepAdapter {
  opts: FalOpts;
  client: FalLike;
  constructor(opts: FalOpts) {
    this.opts = opts;
    this.client = opts.client ?? realFal(opts.apiKey);
  }

  private classify(e: any, phase: 'upload' | 'submit' | 'poll', requestId?: string): ProviderError {
    if (e instanceof ProviderError) return e;
    const status = Number(e?.status);
    const detail = e?.body?.detail;
    const msg = scrub(`${e?.message ?? e}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`, [this.opts.apiKey]);
    if (status === 401 || status === 403) return new ProviderError('auth', `fal rejected the API key or access (${status}): ${msg}`, { providerRequestId: requestId });
    if (status === 402) return new ProviderError('credits', `fal: insufficient balance: ${msg}`);
    if (status === 429) return new ProviderError('rate_limited', `fal rate limit: ${msg}`, { retryable: phase !== 'poll' });
    if (status === 422 || status === 400) {
      const safety = /safety|content_policy|nsfw/i.test(msg);
      return new ProviderError(safety ? 'safety' : 'bad_request', `fal rejected the request (${status}): ${msg}`, { providerRequestId: requestId });
    }
    if (status >= 500) return new ProviderError('server_error', `fal server error (${status}): ${msg}`, { retryable: phase === 'upload', providerRequestId: requestId });
    if (phase === 'submit') return new ProviderError('ambiguous', `Connection to fal failed during submission (${msg}). The job may have been accepted and billed.`);
    return new ProviderError('other', `fal ${phase} failed: ${msg}`, { retryable: phase === 'upload', providerRequestId: requestId });
  }

  async execute(req: StepRequest): Promise<StepResult> {
    if (!this.opts.apiKey && !this.opts.client) throw new ProviderError('auth', 'FAL_KEY is not configured in .env');
    const endpoint = req.modelId;
    const input: Record<string, unknown> = {
      duration: req.params.duration ?? 5,
      resolution: req.params.resolution ?? '768P',
      prompt_expansion_mode: req.params.prompt_expansion_mode ?? 'balanced',
      enable_safety_checker: true,
    };
    let uploadRef: string | undefined;
    let snapshotInput: unknown;
    if (req.type === 'image_to_video') {
      if (req.input.kind !== 'image') throw new ProviderError('unsupported', 'image_to_video requires an image input');
      input.prompt = req.instruction;
      try {
        uploadRef = await this.client.upload(req.input.bytes, req.input.mime);
      } catch (e) {
        throw this.classify(e, 'upload');
      }
      input.image_url = uploadRef;
      snapshotInput = { image_sha256: sha256(req.input.bytes), provider_upload_ref: uploadRef };
    } else if (req.type === 'text_to_video') {
      if (req.input.kind !== 'text') throw new ProviderError('unsupported', 'text_to_video requires a text input');
      input.prompt = [req.instruction.trim(), req.input.text].filter(Boolean).join('\n\n');
      snapshotInput = { text: req.input.text };
    } else throw new ProviderError('unsupported', `fal adapter cannot run ${req.type}`);

    if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled before submission.');
    let requestId: string;
    try {
      ({ request_id: requestId } = await this.client.submit(endpoint, input));
    } catch (e) {
      throw this.classify(e, 'submit');
    }
    req.onSubmitted?.({ requestId, uploadRef });
    const snapshot = { endpoint, ...input, image_url: undefined, input: snapshotInput };
    return this.await(endpoint, requestId, req, snapshot);
  }

  async resume(req: Omit<StepRequest, 'input'> & { requestId: string }): Promise<StepResult> {
    return this.await(req.modelId, req.requestId, req, { endpoint: req.modelId, resumed: true });
  }

  async cancel(modelId: string, requestId: string) {
    await this.client.cancel(modelId, requestId).catch(() => {});
  }

  private async await(endpoint: string, requestId: string, req: Pick<StepRequest, 'signal' | 'onStatus'>, requestSnapshot: unknown): Promise<StepResult> {
    const started = Date.now();
    const maxWait = this.opts.maxWaitMs ?? 15 * 60_000;
    let pollErrors = 0;
    for (;;) {
      if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled by host. The fal job may still finish and be billed.', { providerRequestId: requestId });
      let st: { status: string };
      try {
        st = await this.client.status(endpoint, requestId);
        pollErrors = 0;
      } catch (e) {
        const pe = this.classify(e, 'poll', requestId);
        if (pe.kind === 'auth' || pe.kind === 'bad_request' || ++pollErrors > 8) throw pe;
        st = { status: 'POLL_ERROR' };
      }
      if (st.status === 'COMPLETED') break;
      if (st.status === 'IN_PROGRESS') req.onStatus?.('running');
      else if (st.status === 'IN_QUEUE') req.onStatus?.('queued');
      if (Date.now() - started > maxWait)
        throw new ProviderError('ambiguous', 'fal job did not finish in time. It is still known by request ID; Retry will reconcile it rather than resubmit.', { providerRequestId: requestId });
      try {
        await sleep(this.opts.pollMs ?? 2000, req.signal);
      } catch {
        /* loop re-checks abort */
      }
    }
    let data: any;
    try {
      ({ data } = await this.client.result(endpoint, requestId));
    } catch (e) {
      throw this.classify(e, 'poll', requestId);
    }
    const url = data?.video?.url;
    if (typeof url !== 'string') throw new ProviderError('empty_output', 'fal finished without a video.', { providerRequestId: requestId });
    let bytes: Buffer;
    try {
      bytes = await (this.opts.download ?? ((u, s) => safeDownload(u, { signal: s })))(url, req.signal);
    } catch (e: any) {
      if (e instanceof MediaError) throw new ProviderError(e.kind === 'expired_url' ? 'expired_url' : 'corrupt_media', e.message, { providerRequestId: requestId });
      throw new ProviderError('other', `Video download failed: ${scrub(String(e?.message ?? e), [this.opts.apiKey])}`, { providerRequestId: requestId });
    }
    return {
      output: { kind: 'video', bytes },
      costUsd: null,
      costStatus: 'unknown',
      providerModel: endpoint,
      providerName: 'fal',
      providerRequestId: requestId,
      expandedPrompt: data?.expanded_prompt ?? null,
      inferenceSec: typeof data?.timings?.inference === 'number' ? data.timings.inference : null,
      usage: data?.timings ? { timings: data.timings } : undefined,
      requestSnapshot,
    };
  }
}
