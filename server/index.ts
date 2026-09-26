import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.ts';
import { buildApp, type LanControl, type PublicControl } from './app.ts';
import { importRunBundle } from './fixtures.ts';

const cfg = loadConfig();

for (const bin of ['ffmpeg', 'ffprobe']) {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); } catch { console.error(`✗ ${bin} not found on PATH. Install FFmpeg (needed to validate generated video).`); process.exit(1); }
}

let lanServer: http.Server | null = null;
let lanActive: { address: string; port: number } | null = null;

const lan: LanControl = {
  candidates: () =>
    Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) => (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address }))),
  active: () => lanActive,
  async set(address) {
    if (lanServer) { await new Promise((r) => { lanServer!.closeAllConnections(); lanServer!.close(() => r(null)); }); lanServer = null; lanActive = null; }
    if (!address) return;
    // A local interface address is bound directly; any other (manual override) address falls back to 0.0.0.0.
    const local = lan.candidates().some((c) => c.address === address);
    const srv = http.createServer((req, res) => { (req as any).isLan = true; built.app.routing(req, res); });
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(cfg.port, local ? address : '0.0.0.0', resolve); });
    lanServer = srv;
    lanActive = { address, port: cfg.port };
  },
};

// ---- public phone link: a loopback-only listener published by Tailscale Funnel ----
const run = promisify(execFile);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? cfg.port + 1);
let pubServer: http.Server | null = null;
let pubActive: { url: string; host: string; port: number } | null = null;
const closePub = async () => {
  if (pubServer) await new Promise((r) => { pubServer!.closeAllConnections(); pubServer!.close(() => r(null)); });
  pubServer = null;
};
const pub: PublicControl = {
  active: () => pubActive,
  async set(on) {
    if (pubActive) { await run('tailscale', ['funnel', '--https=443', 'off'], { timeout: 20_000 }).catch(() => {}); pubActive = null; }
    await closePub();
    if (!on) return;
    let host: string;
    try {
      const st = JSON.parse((await run('tailscale', ['status', '--json'], { timeout: 10_000 })).stdout);
      host = String(st?.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
      if (!host || st?.BackendState !== 'Running') throw new Error(`Tailscale is ${st?.BackendState ?? 'not running'}`);
    } catch (e: any) {
      throw new Error(`Tailscale is not available (${e?.code === 'ENOENT' ? 'not installed' : e?.message ?? e}). Install it and log in, or use LAN sharing instead.`);
    }
    const srv = http.createServer((req, res) => { (req as any).isLan = true; (req as any).isPublic = true; built.app.routing(req, res); });
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(PUBLIC_PORT, '127.0.0.1', resolve); });
    pubServer = srv;
    try {
      await run('tailscale', ['funnel', '--bg', String(PUBLIC_PORT)], { timeout: 30_000 });
    } catch (e: any) {
      await closePub();
      const msg = String(e?.stderr || e?.message || e);
      if (/denied|operator|root/i.test(msg)) throw new Error('Tailscale refused to publish the link. Run once in a terminal: sudo tailscale set --operator=$USER');
      if (/funnel.*not.*(enabled|allowed)|attribute/i.test(msg)) throw new Error(`Funnel is not enabled for this tailnet/device: ${msg.slice(0, 200)}`);
      throw new Error(`tailscale funnel failed: ${msg.slice(0, 300)}`);
    }
    pubActive = { url: `https://${host}`, host, port: PUBLIC_PORT };
  },
};

const built = await buildApp(cfg, { lan, pub });
await built.app.listen({ port: cfg.port, host: '127.0.0.1' }); // loopback only; LAN is an explicit host action

const fixtures = path.join(cfg.rootDir, 'fixtures');
if (fs.existsSync(fixtures)) for (const d of fs.readdirSync(fixtures)) {
  const id = importRunBundle(built.db, built.store, path.join(fixtures, d));
  if (id) console.log(`  imported saved rehearsal run from fixtures/${d}`);
}

void built.catalog.refresh().then((v) => v.error && console.warn(`  ⚠ ${v.error} (using ${v.refreshedAt ? 'stale cache' : 'no catalog'})`));

const webPort = cfg.devWebPort ?? cfg.port;
console.log(`\nAI Telephone${cfg.mock ? ' [MOCK PROVIDERS — no API calls]' : ''}`);
console.log(`  OpenRouter key: ${cfg.openrouterKey ? 'configured' : 'MISSING'}   fal key: ${cfg.falKey ? 'configured' : 'MISSING'}`);
console.log(`\n  Host console (one-time link, this computer only):\n  http://localhost:${webPort}/host?code=${built.issueHostCode()}\n`);
if (!cfg.devWebPort && !fs.existsSync(path.join(cfg.rootDir, 'dist/web/index.html'))) console.log('  ⚠ Frontend not built yet: run `npm run build` (or use `npm run dev`).');

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await pub.set(false).catch(() => {}); await lan.set(null); await built.app.close(); process.exit(0); });
