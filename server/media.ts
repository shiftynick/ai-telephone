import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const run = promisify(execFile);

export class MediaError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

function isHeif(buf: Buffer) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  return /heic|heix|hevc|hevx|mif1|msf1|heim|heis/.test(buf.toString('latin1', 8, 12));
}

export type NormalizedImage = {
  bytes: Buffer;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  transformations: string[];
};

const MAX_EDGE = 2048;

/** Validate decoded bytes (not the extension), fix orientation, strip metadata, cap size. */
export async function normalizeImage(input: Buffer, tmpDir: string): Promise<NormalizedImage> {
  const transformations: string[] = [];
  let buf = input;
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(buf).metadata();
    if (isHeif(input) && meta.format === 'heif') {
      // sharp's prebuilt binaries usually decode AVIF only; force a real decode to find out.
      await sharp(buf).resize(8).toBuffer();
    }
  } catch (e) {
    if (!isHeif(input)) throw new MediaError('invalid_image', 'This file is not a readable image.');
    buf = await heicViaFfmpeg(input, tmpDir);
    transformations.push('heic-decoded-with-ffmpeg');
    meta = await sharp(buf).metadata();
  }
  if (!meta.width || !meta.height) throw new MediaError('invalid_image', 'This file is not a readable image.');
  if (!['jpeg', 'png', 'webp', 'heif', 'gif', 'tiff'].includes(meta.format ?? ''))
    throw new MediaError('invalid_image', `Unsupported image format: ${meta.format}`);

  let img = sharp(buf, { animated: false }).rotate(); // applies EXIF orientation; metadata is dropped on output
  if ((meta.orientation ?? 1) !== 1) transformations.push('exif-orientation-applied');
  if (Math.max(meta.width, meta.height) > MAX_EDGE) {
    img = img.resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true });
    transformations.push(`resized-long-edge-${MAX_EDGE}`);
  }
  const keepPng = meta.format === 'png';
  if (!keepPng && meta.format !== 'jpeg') transformations.push(`converted-${meta.format}-to-jpeg`);
  transformations.push('metadata-stripped');
  const out = keepPng
    ? await img.png().toBuffer({ resolveWithObject: true })
    : await img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  return {
    bytes: out.data,
    mime: keepPng ? 'image/png' : 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    transformations,
  };
}

async function heicViaFfmpeg(input: Buffer, tmpDir: string): Promise<Buffer> {
  const base = path.join(tmpDir, `heic_${crypto.randomBytes(6).toString('hex')}`);
  const src = `${base}.heic`;
  const dst = `${base}.png`;
  fs.writeFileSync(src, input);
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', dst], { timeout: 30_000 });
    return fs.readFileSync(dst);
  } catch {
    throw new MediaError(
      'heic_unsupported',
      'This HEIC photo could not be decoded on this computer. On iPhone choose Settings → Camera → Formats → Most Compatible, or share the photo as JPEG, then upload again.',
    );
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(dst, { force: true });
  }
}

/** Generated images: verify they decode; keep bytes as-is when already JPEG/PNG (no silent recompression). */
export async function inspectGeneratedImage(bytes: Buffer) {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(bytes).metadata();
    await sharp(bytes).resize(8).toBuffer();
  } catch {
    throw new MediaError('corrupt_media', 'Provider returned data that is not a decodable image.');
  }
  if (!meta.width || !meta.height) throw new MediaError('corrupt_media', 'Provider returned an empty image.');
  if (meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp') {
    return { bytes, mime: `image/${meta.format}` as string, width: meta.width, height: meta.height, transformations: [] as string[] };
  }
  const out = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
  return { bytes: out.data, mime: 'image/png', width: out.info.width, height: out.info.height, transformations: [`converted-${meta.format}-to-png`] };
}

export async function probeVideo(bytes: Buffer, tmpDir: string) {
  if (bytes.length < 12 || bytes.toString('latin1', 4, 8) !== 'ftyp')
    throw new MediaError('corrupt_media', 'Provider returned data that is not an MP4 video.');
  const f = path.join(tmpDir, `probe_${crypto.randomBytes(6).toString('hex')}.mp4`);
  fs.writeFileSync(f, bytes);
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', f],
      { timeout: 30_000 },
    );
    const j = JSON.parse(stdout);
    const s = j.streams?.[0];
    const durationSec = Number(j.format?.duration);
    if (!s?.width || !s?.height || !(durationSec > 0)) throw new Error('no video stream');
    return { width: s.width as number, height: s.height as number, durationSec, mime: 'video/mp4' };
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError('corrupt_media', 'Downloaded video is not playable (ffprobe could not read it).');
  } finally {
    fs.rmSync(f, { force: true });
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function assertPublicHttpsUrl(raw: string, lookup = dns.lookup) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MediaError('unsafe_url', 'Provider returned an invalid media URL.');
  }
  if (u.protocol !== 'https:') throw new MediaError('unsafe_url', `Refusing to fetch media over ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw new MediaError('unsafe_url', 'Refusing to fetch media from a local/private address.');
  return u;
}

/** Bounded download: https only, no private hosts, redirects re-validated, size capped. */
export async function safeDownload(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch; lookup?: typeof dns.lookup; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const f = opts.fetchImpl ?? fetch;
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicHttpsUrl(current, opts.lookup);
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 120_000)];
    if (opts.signal) signals.push(opts.signal);
    const res = await f(u, { redirect: 'manual', signal: AbortSignal.any(signals) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new MediaError('download_failed', 'Redirect without location.');
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new MediaError(res.status === 403 || res.status === 404 || res.status === 410 ? 'expired_url' : 'download_failed', `Media download failed with HTTP ${res.status} (the provider URL may have expired).`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new MediaError('too_large', 'Provider media exceeds the size limit.');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new MediaError('too_large', 'Provider media exceeds the size limit.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new MediaError('download_failed', 'Too many redirects.');
}
