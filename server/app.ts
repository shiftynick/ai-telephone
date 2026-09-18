import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import { type DB, newToken, now, openDb, sha256 } from './db.ts';
import { ArtifactStore } from './artifacts.ts';
import { EventBus, type BusEvent } from './events.ts';
import { ModelCatalog } from './models.ts';
import { PresetStore } from './presets.ts';
import { Runner, RunError } from './runner.ts';
import { Sessions } from './sessions.ts';
import { MediaError, normalizeImage } from './media.ts';
import { OpenRouterAdapter } from './providers/openrouter.ts';
import { FalAdapter } from './providers/fal.ts';
import { MockAdapter } from './providers/mock.ts';
import type { Adapters } from './providers/types.ts';
import { PresetBody, StepDefinition, validateChain, type StepIssue } from '../shared/types.ts';

const HOST_COOKIE = 'tele_host';
const HOST_SESSION_MS = 12 * 3600_000;

export type LanControl = {
  candidates(): { name: string; address: string }[];
  active(): { address: string; port: number } | null;
  set(address: string | null): Promise<void>;
};

export type App = {
  app: FastifyInstance; db: DB; cfg: Config; store: ArtifactStore; bus: EventBus; catalog: ModelCatalog; presets: PresetStore; runner: Runner; sessions: Sessions;
  /** One-time bootstrap code → host session. */
  issueHostCode(): string;
  allowedHosts: Set<string>;
};

export async function buildApp(cfg: Config, opts: { adapters?: Adapters; lan?: LanControl; catalogFetch?: typeof fetch } = {}): Promise<App> {
  const db = openDb(cfg.dbPath);
  const store = new ArtifactStore(db, cfg);
  const bus = new EventBus(db);
  const catalog = new ModelCatalog(db, opts.catalogFetch);
  const presets = new PresetStore(db);
  presets.seed();
  let adapters = opts.adapters;
  if (!adapters) {
    if (cfg.mock) { const m = new MockAdapter(cfg.tmpDir); adapters = { openrouter: m, fal: m }; }
    else adapters = { openrouter: new OpenRouterAdapter({ apiKey: cfg.openrouterKey }), fal: new FalAdapter({ apiKey: cfg.falKey }) };
  }
  const runner = new Runner(db, store, cfg, adapters, bus);
  const sessions = new Sessions(db, store, runner, bus);
  runner.onStepSucceeded = (runId, idx, def, ms) => {
    if (!cfg.mock) catalog.recordTest(def.modelId, def.type, 'tested-successfully', 'Succeeded in a live run', ms);
    sessions.onStepSucceeded(runId, idx);
  };
  runner.onStepFailed = (def, kind, message) => {
    if (!cfg.mock && ['auth', 'bad_request', 'unsupported'].includes(kind)) catalog.recordTest(def.modelId, def.type, 'failed', message.slice(0, 200), null);
  };
  runner.recover();

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes, files: 1, fields: 4 } });

  const allowedHosts = new Set<string>([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`]);
  if (cfg.devWebPort) { allowedHosts.add(`localhost:${cfg.devWebPort}`); allowedHosts.add(`127.0.0.1:${cfg.devWebPort}`); }

  const hostCodes = new Set<string>();
  const issueHostCode = () => { const c = newToken(); hostCodes.add(sha256(c)); return c; };

  const isLan = (req: FastifyRequest) => (req.raw as any).isLan === true;
  const isHost = (req: FastifyRequest): boolean => {
    if (isLan(req)) return false; // the LAN listener never grants host powers, cookie or not
    const t = req.cookies[HOST_COOKIE];
    if (!t) return false;
    return !!db.prepare('SELECT 1 FROM host_sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(t), now());
  };
  const requireHost = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isHost(req)) return reply.code(401).send({ error: 'Host authentication required.' });
  };

  // Host allowlist + Origin/CSRF check on every request.
  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return reply.code(421).send({ error: 'Unrecognized Host header.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      let ok = false;
      try { ok = !!origin && allowedHosts.has(new URL(origin).host.toLowerCase()) && new URL(origin).protocol === 'http:'; } catch { ok = false; }
      if (!ok) return reply.code(403).send({ error: 'Cross-origin request rejected.' });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof RunError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof MediaError) return reply.code(415).send({ error: err.message, kind: err.kind });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request.', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `File is larger than ${Math.round(cfg.maxUploadBytes / 1048576)} MB.` });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error('[http] error:', String(err?.message ?? err).slice(0, 300));
    return reply.code(500).send({ error: 'Internal error.' });
  });

  // ---- auth / status -------------------------------------------------

  app.post('/api/auth/exchange', async (req, reply) => {
    if (isLan(req)) return reply.code(403).send({ error: 'Host login is only available on this computer.' });
    const { code } = z.object({ code: z.string().min(20).max(100) }).parse(req.body);
    const h = sha256(code);
    if (!hostCodes.delete(h)) return reply.code(401).send({ error: 'Invalid or already used code. Restart the server for a new link.' });
    const token = newToken();
    db.prepare('INSERT INTO host_sessions(token_hash, created_at, expires_at) VALUES(?,?,?)').run(sha256(token), now(), now() + HOST_SESSION_MS);
    reply.setCookie(HOST_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: HOST_SESSION_MS / 1000 });
    return { ok: true };
  });

  app.get('/api/status', async (req) => {
    if (!isHost(req)) return { host: false };
    return {
      host: true, mock: cfg.mock, port: cfg.port, defaultBudgetUsd: cfg.defaultBudgetUsd,
      keys: { openrouter: !!cfg.openrouterKey, fal: !!cfg.falKey }, // presence only, never values
    };
  });

  // ---- models / presets ----------------------------------------------

  app.get('/api/models', { preHandler: requireHost }, async () => {
    const v = catalog.view();
    return v.refreshedAt ? v : catalog.refresh();
  });
  app.post('/api/models/refresh', { preHandler: requireHost }, async () => catalog.refresh());

  const chainIssues = (body: { startingKind: 'image' | 'text'; steps: StepDefinition[] }): StepIssue[] => {
    const issues = validateChain(body.startingKind, body.steps);
    body.steps.forEach((s, index) => { const m = catalog.validateStep(s); if (m) issues.push({ index, message: m }); });
    return issues;
  };

  app.post('/api/presets/validate', { preHandler: requireHost }, async (req) => ({ issues: chainIssues(PresetBody.parse(req.body)) }));
  app.get('/api/presets', { preHandler: requireHost }, async () => ({ presets: presets.list() }));
  app.post('/api/presets', { preHandler: requireHost }, async (req) => presets.create(PresetBody.parse(req.body)));
  app.put('/api/presets/:id', { preHandler: requireHost }, async (req, reply) => {
    const { confirmReplace, preset } = z.object({ confirmReplace: z.boolean().optional(), preset: PresetBody }).parse(req.body);
    if (confirmReplace !== true) return reply.code(428).send({ error: 'Replacing an existing preset requires explicit confirmation.' });
    const p = presets.replace((req.params as any).id, preset);
    return p ?? reply.code(404).send({ error: 'Preset not found, or it is a read-only built-in (use Save as new).' });
  });
  app.delete('/api/presets/:id', { preHandler: requireHost }, async (req, reply) => (presets.remove((req.params as any).id) ? { ok: true } : reply.code(404).send({ error: 'Preset not found, or it is a read-only built-in.' })));

  // ---- session, uploads, reveal --------------------------------------

  app.get('/api/session', { preHandler: requireHost }, async () => sessions.hostView());
  app.post('/api/session/rotate', { preHandler: requireHost }, async (req) => {
    sessions.rotate(z.object({ which: z.enum(['upload', 'projector', 'both']) }).parse(req.body).which);
    return sessions.hostView();
  });

  async function ingestImage(req: FastifyRequest, sessionId: string, origin: 'phone' | 'desktop') {
    if (sessions.uploadCount(sessionId) >= cfg.maxUploadsPerSession) throw Object.assign(new Error('Upload limit for this session reached.'), { statusCode: 429 });
    const file = await req.file();
    if (!file) throw Object.assign(new Error('No file received.'), { statusCode: 400 });
    const buf = await file.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE beyond the limit
    // The client filename and declared MIME are ignored on purpose: bytes are sniffed, name is never stored.
    const img = await normalizeImage(buf, cfg.tmpDir);
    const art = store.saveMedia('image', img.bytes, img, null);
    const uploadId = sessions.addUpload(sessionId, art.id, origin, img.transformations);
    return { uploadId, width: img.width, height: img.height, transformations: img.transformations };
  }

  app.post('/api/session/uploads', { preHandler: requireHost }, async (req) => {
    const r = await ingestImage(req, sessions.current().id, 'desktop');
    return { ...r, session: sessions.hostView() };
  });
  app.post('/api/session/source-text', { preHandler: requireHost }, async (req) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const art = store.saveText(text, null);
    const id = sessions.addUpload(sessions.current().id, art.id, 'text', []);
    sessions.decideUpload(id, true);
    return sessions.hostView();
  });
  app.post('/api/session/uploads/:id/:decision', { preHandler: requireHost }, async (req, reply) => {
    const { id, decision } = req.params as any;
    if (decision !== 'accept' && decision !== 'reject') return reply.code(404).send({ error: 'Not found.' });
    if (!sessions.decideUpload(id, decision === 'accept')) return reply.code(404).send({ error: 'Upload not found.' });
    return sessions.hostView();
  });
  app.get('/api/sources', { preHandler: requireHost }, async () => ({ sources: sessions.sourceCandidates() }));
  app.post('/api/session/source', { preHandler: requireHost }, async (req, reply) => {
    const { artifactId } = z.object({ artifactId: z.string().min(1).max(64) }).parse(req.body);
    const a = store.get(artifactId);
    if (!a) return reply.code(404).send({ error: 'Artifact not found.' });
    if (a.kind === 'video') return reply.code(400).send({ error: 'No step in this build accepts a video as input, so a video cannot be a starting source.' });
    sessions.setSource(artifactId);
    return sessions.hostView();
  });
  app.post('/api/session/select-run', { preHandler: requireHost }, async (req) => {
    const b = z.object({ runId: z.string().nullable(), replay: z.boolean().default(false) }).parse(req.body);
    sessions.selectRun(b.runId, b.replay);
    return sessions.hostView();
  });
  app.post('/api/session/reveal', { preHandler: requireHost }, async (req) => {
    const a = z.discriminatedUnion('action', [
      z.object({ action: z.literal('show'), stage: z.number().int().min(0) }),
      z.object({ action: z.literal('next') }), z.object({ action: z.literal('prev') }), z.object({ action: z.literal('final') }), z.object({ action: z.literal('reset') }),
      z.object({ action: z.literal('compare'), on: z.boolean() }), z.object({ action: z.literal('auto'), on: z.boolean() }),
    ]).parse(req.body);
    sessions.reveal(a);
    return sessions.hostView();
  });

  // Phone: upload-token routes. They can upload and nothing else.
  app.get('/api/join/:token', async (req, reply) => {
    const s = sessions.byToken('upload', (req.params as any).token);
    if (!s) return reply.code(404).send({ error: 'This upload link is invalid or has expired. Ask the host for a new QR code.' });
    return { ok: true, sessionId: s.id, maxBytes: cfg.maxUploadBytes };
  });
  app.post('/api/sessions/:id/uploads', async (req, reply) => {
    const s = sessions.byToken('upload', String(req.headers['x-upload-token'] ?? ''));
    if (!s || s.id !== (req.params as any).id) return reply.code(401).send({ error: 'Invalid or expired upload token.' });
    const r = await ingestImage(req, s.id, 'phone');
    return { ok: true, width: r.width, height: r.height };
  });

  // The phone may also send starting TEXT. Like a photo, it only becomes a source once the host accepts it.
  app.post('/api/sessions/:id/text', async (req, reply) => {
    const s = sessions.byToken('upload', String(req.headers['x-upload-token'] ?? ''));
    if (!s || s.id !== (req.params as any).id) return reply.code(401).send({ error: 'Invalid or expired upload token.' });
    if (sessions.uploadCount(s.id) >= cfg.maxUploadsPerSession) return reply.code(429).send({ error: 'Upload limit for this session reached.' });
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
    const art = store.saveText(text, null);
    sessions.addUpload(s.id, art.id, 'phone-text', []);
    return { ok: true };
  });

  // ---- LAN -----------------------------------------------------------

  app.get('/api/lan', { preHandler: requireHost }, async () => ({
    candidates: opts.lan?.candidates() ?? [], active: opts.lan?.active() ?? null,
    firewallHint: fs.existsSync('/usr/bin/ufw') || fs.existsSync('/usr/sbin/ufw') ? `If the phone cannot connect, ufw may be blocking the port. Run: sudo ufw allow ${cfg.port}/tcp   (undo: sudo ufw delete allow ${cfg.port}/tcp)` : null,
    warning: 'LAN HTTP is not encrypted. Use only a trusted network and non-sensitive demo photos.',
  }));
  app.post('/api/lan', { preHandler: requireHost }, async (req, reply) => {
    if (!opts.lan) return reply.code(501).send({ error: 'LAN mode unavailable.' });
    const { address } = z.object({ address: z.union([z.ipv4(), z.null()]) }).parse(req.body);
    for (const h of [...allowedHosts]) if (!/^(localhost|127\.0\.0\.1|\[::1\]):/.test(h)) allowedHosts.delete(h);
    try { await opts.lan.set(address); } catch (e: any) { return reply.code(400).send({ error: `Could not listen on ${address}: ${e?.code ?? e?.message}` }); }
    if (address) allowedHosts.add(`${address}:${cfg.port}`);
    return { active: opts.lan.active() };
  });

  // ---- runs ----------------------------------------------------------

  app.get('/api/runs', { preHandler: requireHost }, async () => ({ runs: runner.list() }));
  app.post('/api/runs', { preHandler: requireHost }, async (req, reply) => {
    const b = z.object({ preset: PresetBody, sourceArtifactId: z.string().optional(), budgetUsd: z.number().positive().nullable().optional(), select: z.boolean().default(true) }).parse(req.body);
    const sourceId = b.sourceArtifactId ?? sessions.current().source_artifact_id;
    if (!sourceId) return reply.code(400).send({ error: 'Accept a source image (or enter starting text) first.' });
    const src = store.get(sourceId);
    if (!src) return reply.code(400).send({ error: 'Source artifact not found.' });
    const issues = chainIssues({ startingKind: src.kind as any, steps: b.preset.steps });
    if (issues.length) return reply.code(400).send({ error: `Step ${issues[0].index + 1}: ${issues[0].message}`, issues });
    const id = runner.createRun({ preset: b.preset, sourceArtifactId: sourceId, budgetUsd: b.budgetUsd === undefined ? cfg.defaultBudgetUsd : b.budgetUsd });
    if (b.select) sessions.selectRun(id, false);
    return runner.view(id);
  });
  app.get('/api/runs/:id', { preHandler: requireHost }, async (req) => runner.view((req.params as any).id));
  app.post('/api/runs/:id/actions', { preHandler: requireHost }, async (req) => {
    const id = (req.params as any).id;
    const b = z.object({ action: z.enum(['start', 'next', 'pause', 'resume', 'stop', 'retry']), acknowledgeBilling: z.boolean().default(false) }).parse(req.body);
    if (b.action === 'start' || b.action === 'resume') runner.start(id, false);
    else if (b.action === 'next') runner.start(id, true);
    else if (b.action === 'pause') runner.pause(id);
    else if (b.action === 'stop') await runner.stop(id);
    else runner.retry(id, b.acknowledgeBilling);
    return runner.view(id);
  });

  // ---- SSE -----------------------------------------------------------

  function sse(req: FastifyRequest, reply: FastifyReply, filter: (e: BusEvent) => { event: string; data: unknown; id?: number } | null, replay: BusEvent[] = []) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (e: BusEvent) => {
      const m = filter(e);
      if (m) res.write(`${m.id ? `id: ${m.id}\n` : ''}event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`);
    };
    res.write('retry: 1500\n\n');
    replay.forEach(send);
    const off = bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => { off(); clearInterval(ping); });
  }
  const hostEvent = (e: BusEvent) => ({ id: e.id, event: 'change', data: { type: e.type, runId: e.runId, ...e.payload } });

  app.get('/api/events', { preHandler: requireHost }, (req, reply) => sse(req, reply, hostEvent));
  app.get('/api/runs/:id/events', { preHandler: requireHost }, (req, reply) => {
    const id = (req.params as any).id;
    const last = Number(req.headers['last-event-id'] ?? 0) || 0;
    sse(req, reply, (e) => (e.runId === id ? hostEvent(e) : null), last ? bus.since(last, id) : []);
  });

  // Projector: read-only. Events are content-free pings; state is filtered server-side.
  app.get('/api/present/:token/state', async (req, reply) => {
    const s = sessions.byToken('projector', (req.params as any).token);
    return s ? sessions.presentState(s) : reply.code(404).send({ error: 'This projector link is invalid or has expired.' });
  });
  app.get('/api/present/:token/events', (req, reply) => {
    const s = sessions.byToken('projector', (req.params as any).token);
    if (!s) return reply.code(404).send({ error: 'Invalid projector link.' });
    sse(req, reply, () => ({ event: 'change', data: {} }));
  });

  // ---- media: opaque IDs, token-aware, never a directory listing ----

  app.get('/media/:artifactId', async (req, reply) => {
    const id = String((req.params as any).artifactId);
    if (!/^art_[A-Za-z0-9_-]{6,40}$/.test(id)) return reply.code(404).send({ error: 'Not found.' });
    let allowed = isHost(req);
    if (!allowed) {
      const s = sessions.byToken('projector', String((req.query as any)?.t ?? ''));
      allowed = !!s && sessions.projectorMayRead(s, id);
    }
    const row = allowed ? store.get(id) : null;
    if (!row || !row.rel_path) return reply.code(404).send({ error: 'Not found.' });
    const file = store.absPath(row);
    const size = fs.statSync(file).size;
    reply.header('Content-Type', row.mime ?? 'application/octet-stream').header('Cache-Control', 'private, max-age=3600').header('Accept-Ranges', 'bytes');
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0);
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(fs.createReadStream(file, { start, end }));
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(file));
  });

  // ---- built frontend ------------------------------------------------

  const webDir = path.join(cfg.rootDir, 'dist', 'web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fstatic, { root: webDir, index: false }); // wildcard lookup: rebuilt hashed assets are served without a restart
    const index = (_: FastifyRequest, reply: FastifyReply) => reply.header('Cache-Control', 'no-store').type('text/html').send(fs.readFileSync(path.join(webDir, 'index.html')));
    for (const p of ['/', '/host', '/join/:token', '/present/:token']) app.get(p, index);
  }
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found.' }));

  return { app, db, cfg, store, bus, catalog, presets, runner, sessions, issueHostCode, allowedHosts };
}
