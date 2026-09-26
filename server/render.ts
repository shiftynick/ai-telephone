import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { MediaError } from './media.ts';

/**
 * Local renderers for code-drawn steps. A language model writes SVG, ASCII, or an HTML page; these turn it
 * into an ordinary image (PNG) or video (MP4) so the result chains into the next step like any other.
 * Generated code is untrusted: SVG is stripped of scripts and external references, HTML runs in headless
 * Chromium with every network request refused except the vendored three.js.
 */

const run = promisify(execFile);
export const STAGE_W = 1600;
export const STAGE_H = 900;

// ---- extracting code from a model reply ------------------------------------------

const unfence = (t: string) => {
  const m = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(t);
  return (m ? m[1] : t).replace(/^\n+|\s+$/g, '');
};

export function extractSvg(reply: string): string {
  const m = /<svg[\s\S]*<\/svg>/i.exec(reply);
  if (!m) throw new MediaError('corrupt_media', 'The model did not return an SVG document.');
  return m[0];
}

export function extractHtml(reply: string): string {
  const t = unfence(reply);
  const m = /(<!doctype html[\s\S]*<\/html>)|(<html[\s\S]*<\/html>)/i.exec(t);
  if (m) return m[0];
  if (/<(script|canvas|div|svg|style|body)\b/i.test(t)) return `<!doctype html><html><body>${t}</body></html>`;
  throw new MediaError('corrupt_media', 'The model did not return an HTML document.');
}

export function extractAscii(reply: string): string {
  const lines = unfence(reply).replace(/\t/g, '    ').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // drop a common left margin
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const out = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).slice(0, 80).map((l) => l.slice(0, 160));
  if (!out.some((l) => l.trim())) throw new MediaError('corrupt_media', 'The model returned empty ASCII art.');
  return out.join('\n');
}

// ---- SVG / ASCII → PNG (sharp / librsvg) ---------------------------------------

/** Remove anything that could execute or reach outside the document. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*(["'])(?!#)[\s\S]*?\1/gi, '')
    .replace(/url\(\s*(["']?)(?!#)[^)]*\1\s*\)/gi, 'none')
    .replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '');
}

/** Rasterize onto a 16:9 stage, letterboxed, keeping the drawing's own aspect ratio. */
export async function svgToPng(svg: string, bg = '#ffffff'): Promise<Buffer> {
  const clean = sanitizeSvg(svg);
  let img: Buffer;
  try {
    img = await sharp(Buffer.from(clean), { density: 144, limitInputPixels: 1e8 })
      .resize(STAGE_W, STAGE_H, { fit: 'contain', background: bg })
      .flatten({ background: bg })
      .png()
      .toBuffer();
  } catch (e: any) {
    throw new MediaError('corrupt_media', `The SVG could not be rendered (${String(e?.message ?? e).slice(0, 160)}).`);
  }
  return img;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Green-phosphor terminal look, sized so the art fills the stage. */
export async function asciiToPng(ascii: string): Promise<Buffer> {
  const lines = ascii.split('\n');
  const cols = Math.max(20, ...lines.map((l) => l.length));
  const rows = Math.max(8, lines.length);
  const cw = 0.6, lh = 1.18; // monospace advance and line height, in em
  const fs_ = Math.min((STAGE_W * 0.9) / (cols * cw), (STAGE_H * 0.88) / (rows * lh));
  const x0 = (STAGE_W - cols * cw * fs_) / 2;
  const y0 = (STAGE_H - rows * lh * fs_) / 2 + fs_;
  const text = lines
    .map((l, i) => `<text x="${x0.toFixed(1)}" y="${(y0 + i * lh * fs_).toFixed(1)}" xml:space="preserve">${xml(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STAGE_W}" height="${STAGE_H}">
    <defs><radialGradient id="g" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#0d1a10"/><stop offset="1" stop-color="#030604"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <g font-family="DejaVu Sans Mono, Noto Sans Mono, Liberation Mono, monospace" font-size="${fs_.toFixed(2)}" fill="#7dff9a">${text}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---- HTML → image / video (headless Chromium) -----------------------------------

const ORIGIN = 'http://render.local';
const req = createRequire(import.meta.url);
const threeDir = () => path.dirname(req.resolve('three'));
const IMPORT_MAP = `<script type="importmap">{"imports":{"three":"${ORIGIN}/three/three.module.js","three/addons/":"${ORIGIN}/three-addons/"}}</script>`;
const BASE_CSS = '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style>';

function withImportMap(html: string): string {
  const head = `${IMPORT_MAP}${BASE_CSS}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

type Browser = import('playwright').Browser;
type Page = import('playwright').Page;

export class HtmlRenderer {
  private browser: Promise<Browser> | null = null;
  tmpDir: string;
  constructor(tmpDir: string) {
    this.tmpDir = tmpDir;
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = import('playwright').then(({ chromium }) =>
        chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }),
      );
      this.browser.catch(() => { this.browser = null; });
    }
    return this.browser;
  }

  async close() {
    const b = await this.browser?.catch(() => null);
    this.browser = null;
    await b?.close();
  }

  /** Serve the page and three.js from a fake origin; refuse every other request. */
  private async route(page: Page, html: string, errors: string[]) {
    const three = threeDir();
    const addons = path.resolve(three, '..', 'examples', 'jsm');
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: withImportMap(html) });
      const serve = (root: string, rel: string) => {
        const f = path.resolve(root, rel);
        if (!f.startsWith(root + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(f) });
      };
      if (url.startsWith(`${ORIGIN}/three/`)) return serve(three, url.slice(`${ORIGIN}/three/`.length));
      if (url.startsWith(`${ORIGIN}/three-addons/`)) return serve(addons, url.slice(`${ORIGIN}/three-addons/`.length));
      if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      errors.push(`blocked network request: ${url.slice(0, 120)}`);
      return route.abort();
    });
    page.on('pageerror', (e) => errors.push(e.message));
  }

  /** Wait until the page says it is ready (window.__ready) or `ms` passes, whichever is first. */
  private async settle(page: Page, ms: number) {
    await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: ms }).catch(() => {});
  }

  async image(html: string, signal: AbortSignal): Promise<{ png: Buffer; errors: string[] }> {
    const browser = await this.launch();
    const ctx = await browser.newContext({ viewport: { width: STAGE_W, height: STAGE_H }, deviceScaleFactor: 1, offline: false });
    const abort = () => void ctx.close().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    const errors: string[] = [];
    try {
      const page = await ctx.newPage();
      await this.route(page, html, errors);
      await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 20_000 });
      await this.settle(page, 3000);
      await page.waitForTimeout(400);
      return { png: await page.screenshot({ type: 'png' }), errors };
    } catch (e: any) {
      if (signal.aborted) throw e;
      throw new MediaError('corrupt_media', `The generated page could not be rendered (${String(e?.message ?? e).slice(0, 200)}).`);
    } finally {
      signal.removeEventListener('abort', abort);
      await ctx.close().catch(() => {});
    }
  }

  /** Record `seconds` of the page as H.264 MP4 (skipping the first moments while it loads). */
  async video(html: string, seconds: number, signal: AbortSignal): Promise<{ mp4: Buffer; errors: string[] }> {
    const browser = await this.launch();
    const dir = path.join(this.tmpDir, `rec_${crypto.randomBytes(6).toString('hex')}`);
    const size = { width: 1280, height: 720 };
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir, size } });
    const abort = () => void ctx.close().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    const errors: string[] = [];
    let lead = 0;
    try {
      const page = await ctx.newPage();
      const t0 = Date.now();
      await this.route(page, html, errors);
      await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 20_000 });
      await this.settle(page, 2500);
      lead = (Date.now() - t0) / 1000 + 0.3;
      await page.waitForTimeout(seconds * 1000 + 300);
      const video = page.video();
      await ctx.close();
      const webm = await video!.path();
      const mp4 = path.join(dir, 'out.mp4');
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', lead.toFixed(2), '-i', webm, '-t', String(seconds), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', mp4], { timeout: 120_000 });
      return { mp4: fs.readFileSync(mp4), errors };
    } catch (e: any) {
      if (signal.aborted) throw e;
      throw new MediaError('corrupt_media', `The generated animation could not be recorded (${String(e?.message ?? e).slice(0, 200)}).`);
    } finally {
      signal.removeEventListener('abort', abort);
      await ctx.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
