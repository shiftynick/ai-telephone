import type { StepParams, StepType } from '../../shared/types.ts';

export type StepInput = { kind: 'text'; text: string } | { kind: 'image'; bytes: Buffer; mime: string };

export type StepRequest = {
  type: StepType;
  modelId: string;
  instruction: string;
  params: StepParams;
  /** ONLY the immediate predecessor's primary artifact. Adapters receive nothing else about the run. */
  input: StepInput;
  signal: AbortSignal;
  /** Called as soon as the provider has durably accepted an async job, before polling. */
  onSubmitted?: (info: { requestId: string; uploadRef?: string }) => void;
  onStatus?: (status: 'queued' | 'running') => void;
};

export type StepOutput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; bytes: Buffer }
  | { kind: 'video'; bytes: Buffer };

export type StepResult = {
  output: StepOutput;
  usage?: unknown;
  costUsd?: number | null;
  costStatus: 'actual' | 'estimated' | 'unknown';
  providerModel?: string;
  providerName?: string;
  providerRequestId?: string;
  expandedPrompt?: string | null;
  inferenceSec?: number | null;
  /** Exactly what was sent, minus secrets and with media replaced by a digest. */
  requestSnapshot: unknown;
};

export type ErrorKind =
  | 'auth'
  | 'credits'
  | 'bad_request'
  | 'rate_limited'
  | 'server_error'
  | 'ambiguous' // request may have reached the provider and may be billed
  | 'empty_output'
  | 'refusal'
  | 'safety'
  | 'corrupt_media'
  | 'expired_url'
  | 'disk'
  | 'cancelled'
  | 'unsupported'
  | 'other';

export class ProviderError extends Error {
  kind: ErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  providerRequestId?: string;
  constructor(kind: ErrorKind, message: string, opts: { retryable?: boolean; retryAfterMs?: number; providerRequestId?: string } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.providerRequestId = opts.providerRequestId;
  }
}

export interface StepAdapter {
  execute(req: StepRequest): Promise<StepResult>;
  /** Reconcile a previously submitted async job without resubmitting. */
  resume?(req: Omit<StepRequest, 'input'> & { requestId: string }): Promise<StepResult>;
  cancel?(modelId: string, requestId: string): Promise<void>;
}

export type Adapters = { openrouter: StepAdapter; fal: StepAdapter };

/** Never let a key reach logs, DB rows, or API responses. */
export function scrub(msg: string, secrets: string[]): string {
  let out = msg;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/Bearer\s+[A-Za-z0-9._:-]{8,}/gi, 'Bearer [redacted]').slice(0, 600);
}
