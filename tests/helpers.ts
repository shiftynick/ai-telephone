import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { loadConfig, type Config } from '../server/config.ts';
import { buildApp, type App } from '../server/app.ts';
import type { Adapters } from '../server/providers/types.ts';
import { PRESET_SCHEMA_VERSION, type PresetBody, type StepDefinition, type StepType } from '../shared/types.ts';

export const OPENROUTER_KEY = 'sk-or-test-SECRET123456';
export const FAL_KEY = 'fal-SECRET-654321';
export const HOST = 'localhost:8787';
export const ORIGIN = 'http://localhost:8787';

const tmpDirs: string[] = [];
const built: App[] = [];

export function makeDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-'));
  tmpDirs.push(d);
  return d;
}

/** A catalogFetch that never touches the network. */
export const noCatalog: typeof fetch = async () => {
  throw new Error('catalog fetch disabled in tests');
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    dataDir: makeDataDir(),
    port: 8787,
    mock: false,
    openrouterKey: OPENROUTER_KEY,
    falKey: FAL_KEY,
    defaultBudgetUsd: null,
    ...overrides,
  });
}

export type TestApp = App & { cfg: Config; cookie: string };

export async function makeApp(
  opts: { adapters?: Adapters; catalogFetch?: typeof fetch; cfg?: Config; login?: boolean } = {},
): Promise<TestApp> {
  const cfg = opts.cfg ?? testConfig();
  const a = await buildApp(cfg, { adapters: opts.adapters, catalogFetch: opts.catalogFetch ?? noCatalog });
  built.push(a);
  const t = a as TestApp;
  t.cookie = opts.login === false ? '' : await login(a);
  return t;
}

export async function login(a: App): Promise<string> {
  const code = a.issueHostCode();
  const res = await a.app.inject({
    method: 'POST',
    url: '/api/auth/exchange',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    payload: { code },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return raw.split(';')[0];
}

type InjectOpts = { headers?: Record<string, string>; payload?: unknown; cookie?: string | null };

export function get(a: TestApp, url: string, o: InjectOpts = {}) {
  const cookie = o.cookie === null ? undefined : (o.cookie ?? a.cookie);
  return a.app.inject({
    method: 'GET',
    url,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...o.headers },
  });
}

export function post(a: TestApp, url: string, payload?: unknown, o: InjectOpts = {}) {
  const cookie = o.cookie === null ? undefined : (o.cookie ?? a.cookie);
  return a.app.inject({
    method: 'POST',
    url,
    headers: {
      host: HOST,
      origin: ORIGIN,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...o.headers,
    },
    ...(payload !== undefined ? { payload: payload as any } : {}),
  });
}

export function del(a: TestApp, url: string, o: InjectOpts = {}) {
  const cookie = o.cookie === null ? undefined : (o.cookie ?? a.cookie);
  return a.app.inject({
    method: 'DELETE',
    url,
    headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie } : {}), ...o.headers },
  });
}

// ---- multipart ------------------------------------------------------

export function multipartBody(
  field: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----teleTestBoundary' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export function uploadDesktop(
  a: TestApp,
  bytes: Buffer,
  filename = 'unique-source-filename-ZZTOP.jpg',
  contentType = 'image/jpeg',
  o: InjectOpts = {},
) {
  const m = multipartBody('file', filename, contentType, bytes);
  const cookie = o.cookie === null ? undefined : (o.cookie ?? a.cookie);
  return a.app.inject({
    method: 'POST',
    url: '/api/session/uploads',
    headers: { host: HOST, origin: ORIGIN, ...m.headers, ...(cookie ? { cookie } : {}), ...o.headers },
    payload: m.body,
  });
}

// ---- media fixtures --------------------------------------------------

let jpegCache: Buffer | null = null;
export async function makeJpeg(width = 640, height = 480): Promise<Buffer> {
  if (width === 640 && height === 480 && jpegCache) return jpegCache;
  const b = await sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 140, b: 200 } },
  })
    .jpeg({ quality: 88 })
    .toBuffer();
  if (width === 640 && height === 480) jpegCache = b;
  return b;
}

export async function makePng(width = 64, height = 48): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png()
    .toBuffer();
}

let mp4Cache: Buffer | null = null;
export function makeMp4(): Buffer {
  if (mp4Cache) return mp4Cache;
  const dir = makeDataDir();
  const f = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=12',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f,
  ]);
  mp4Cache = fs.readFileSync(f);
  return mp4Cache;
}

// ---- preset builders -------------------------------------------------

export const MODELS = {
  describe: 'google/gemini-3.8-flash',
  draw: 'google/gemini-3.1-flash-lite-image',
  animate: 'minimax/h3-max-turbo/image-to-video',
  t2v: 'minimax/h3-max-turbo/text-to-video',
};

export function step(type: StepType, modelId: string, instruction: string, id?: string): StepDefinition {
  return { id: id ?? `s_${type}_${Math.random().toString(36).slice(2, 8)}`, type, modelId, instruction, params: {} };
}

export function preset(name: string, steps: StepDefinition[], startingKind: 'image' | 'text' = 'image'): PresetBody {
  return { schemaVersion: PRESET_SCHEMA_VERSION, name, startingKind, steps };
}

/** The five-step quick chain with distinctive instructions. */
export function quickChain(): PresetBody {
  return preset('DISTINCTIVE-RUN-NAME-QQ7', [
    step('image_to_text', MODELS.describe, 'INSTRUCTION-ALPHA describe the image', 'st1'),
    step('text_to_image', MODELS.draw, 'INSTRUCTION-BRAVO draw the scene', 'st2'),
    step('image_to_text', MODELS.describe, 'INSTRUCTION-CHARLIE describe the image', 'st3'),
    step('text_to_image', MODELS.draw, 'INSTRUCTION-DELTA draw the scene', 'st4'),
    step('image_to_video', MODELS.animate, 'INSTRUCTION-ECHO animate the scene', 'st5'),
  ]);
}

// ---- run helpers -----------------------------------------------------

export async function acceptSource(a: TestApp, bytes?: Buffer, filename?: string) {
  const b = bytes ?? (await makeJpeg());
  const up = await uploadDesktop(a, b, filename);
  if (up.statusCode !== 200) throw new Error(`upload failed ${up.statusCode} ${up.body}`);
  const uploadId = up.json().uploadId as string;
  const acc = await post(a, `/api/session/uploads/${uploadId}/accept`, {});
  if (acc.statusCode !== 200) throw new Error(`accept failed ${acc.statusCode} ${acc.body}`);
  return { uploadId, bytes: b, session: acc.json() };
}

export async function createRun(a: TestApp, body: Record<string, unknown>) {
  return post(a, '/api/runs', body);
}

export async function runToEnd(a: TestApp, runId: string) {
  const r = await post(a, `/api/runs/${runId}/actions`, { action: 'start' });
  await a.runner.idle();
  return r;
}

export async function waitFor(fn: () => boolean | Promise<boolean>, label = 'condition', timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A promise that never settles and keeps no timers (simulates a process that died mid-request). */
export const hangForever = <T>() => new Promise<T>(() => {});

// ---- cleanup ---------------------------------------------------------

export async function closeAll() {
  for (const a of built.splice(0)) {
    try {
      await a.app.close();
    } catch {
      /* already closed */
    }
    try {
      a.db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
