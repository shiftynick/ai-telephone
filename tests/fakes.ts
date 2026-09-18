import { OpenRouterAdapter } from '../server/providers/openrouter.ts';
import { FalAdapter, type FalLike } from '../server/providers/fal.ts';
import type { Adapters } from '../server/providers/types.ts';
import { FAL_KEY, OPENROUTER_KEY, makeMp4, makePng } from './helpers.ts';

export type RecordedCall = { url: string; body: any; headers: Record<string, string> };

export type FakeResponse = {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** throw instead of responding (network failure) */
  throws?: Error;
};

export type OpenRouterFake = {
  adapter: OpenRouterAdapter;
  calls: RecordedCall[];
  chatCalls: RecordedCall[];
  imageCalls: RecordedCall[];
  /** Called for each request; return a FakeResponse. */
  handler: (call: RecordedCall, index: number) => FakeResponse | Promise<FakeResponse>;
};

export function chatOk(content: string, extra: Record<string, unknown> = {}) {
  return {
    json: {
      id: 'gen-' + Math.random().toString(36).slice(2),
      model: 'fake/model',
      provider: 'FakeProvider',
      choices: [{ message: { content, role: 'assistant' }, finish_reason: 'stop' }],
      usage: { cost: 0.002, prompt_tokens: 10, completion_tokens: 20 },
      ...extra,
    },
  } satisfies FakeResponse;
}

export async function imageOk(png?: Buffer) {
  const bytes = png ?? (await makePng());
  return {
    json: {
      created: Date.now(),
      id: 'img-' + Math.random().toString(36).slice(2),
      model: 'fake/image-model',
      provider: 'FakeImageProvider',
      data: [{ b64_json: bytes.toString('base64') }],
      usage: { cost: 0.003 },
    },
  } satisfies FakeResponse;
}

export function makeOpenRouterFake(
  handler?: (call: RecordedCall, index: number) => FakeResponse | Promise<FakeResponse>,
): OpenRouterFake {
  const calls: RecordedCall[] = [];
  let defaultPng: Buffer | null = null;
  const fake: OpenRouterFake = {
    calls,
    get chatCalls() {
      return calls.filter((c) => c.url.includes('/chat/completions'));
    },
    get imageCalls() {
      return calls.filter((c) => c.url.endsWith('/images'));
    },
    handler:
      handler ??
      (async (call, i) => {
        if (call.url.endsWith('/images')) {
          defaultPng ??= await makePng();
          return imageOk(defaultPng);
        }
        return chatOk(`FAKE-TEXT-${i} generated description of the predecessor artifact.`);
      }),
    adapter: null as any,
  };
  const fetchImpl: typeof fetch = async (input: any, init: any) => {
    const url = String(input);
    let body: any = null;
    try {
      body = JSON.parse(String(init?.body ?? 'null'));
    } catch {
      body = init?.body;
    }
    const call: RecordedCall = { url, body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const r = await fake.handler(call, calls.length - 1);
    if (r.throws) throw r.throws;
    const payload = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(payload, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  fake.adapter = new OpenRouterAdapter({ apiKey: OPENROUTER_KEY, fetchImpl });
  return fake;
}

// ---- fal ------------------------------------------------------------

export type FalFakeOpts = {
  /** statuses returned in order; last one repeats. */
  statuses?: string[];
  result?: () => any;
  onSubmit?: (endpoint: string, input: Record<string, unknown>) => void;
  submitThrows?: () => unknown;
  statusThrows?: () => unknown;
  download?: (url: string, signal: AbortSignal) => Promise<Buffer>;
};

export type FalFake = {
  adapter: FalAdapter;
  client: FalLike;
  submits: { endpoint: string; input: Record<string, unknown> }[];
  statusCalls: { endpoint: string; requestId: string }[];
  resultCalls: { endpoint: string; requestId: string }[];
  uploads: { bytes: Buffer; mime: string }[];
  cancels: { endpoint: string; requestId: string }[];
  opts: FalFakeOpts;
};

export function makeFalFake(opts: FalFakeOpts = {}): FalFake {
  const fake: FalFake = {
    adapter: null as any,
    client: null as any,
    submits: [],
    statusCalls: [],
    resultCalls: [],
    uploads: [],
    cancels: [],
    opts,
  };
  let n = 0;
  const client: FalLike = {
    async upload(bytes, mime) {
      fake.uploads.push({ bytes, mime });
      return `https://fake.fal.media/upload/${fake.uploads.length}.jpg`;
    },
    async submit(endpoint, input) {
      fake.opts.onSubmit?.(endpoint, input);
      if (fake.opts.submitThrows) throw fake.opts.submitThrows();
      fake.submits.push({ endpoint, input });
      return { request_id: `fal-req-${fake.submits.length}` };
    },
    async status(endpoint, requestId) {
      fake.statusCalls.push({ endpoint, requestId });
      if (fake.opts.statusThrows) throw fake.opts.statusThrows();
      const list = fake.opts.statuses ?? ['COMPLETED'];
      const s = list[Math.min(n, list.length - 1)];
      n++;
      return { status: s };
    },
    async result(endpoint, requestId) {
      fake.resultCalls.push({ endpoint, requestId });
      return {
        data: fake.opts.result
          ? fake.opts.result()
          : { video: { url: 'https://fake.fal.media/out.mp4' }, expanded_prompt: 'FAKE expanded prompt', timings: { inference: 3.5 } },
      };
    },
    async cancel(endpoint, requestId) {
      fake.cancels.push({ endpoint, requestId });
    },
  };
  fake.client = client;
  fake.adapter = new FalAdapter({
    apiKey: FAL_KEY,
    client,
    pollMs: 5,
    download: opts.download ?? (async () => makeMp4()),
  });
  return fake;
}

export function fakeAdapters(or: OpenRouterFake, fal: FalFake): Adapters {
  return { openrouter: or.adapter, fal: fal.adapter };
}

export function httpError(status: number, message: string, headers: Record<string, string> = {}): FakeResponse {
  return { status, json: { error: { message, code: status } }, headers };
}
