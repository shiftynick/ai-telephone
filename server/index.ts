import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.ts';
import { buildApp, type LanControl } from './app.ts';
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

const built = await buildApp(cfg, { lan });
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

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await lan.set(null); await built.app.close(); process.exit(0); });
