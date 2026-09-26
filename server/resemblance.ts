import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type DB, now } from './db.ts';
import type { ArtifactRow, ArtifactStore } from './artifacts.ts';
import type { Config } from './config.ts';
import type { EventBus } from './events.ts';
import { scrub } from './providers/types.ts';
import type { ResemblanceView } from '../shared/types.ts';

const run = promisify(execFile);

/**
 * The resemblance meter: after each step, a separate judge model compares that step's output with the run's
 * ORIGINAL source and scores how much of its content survives (0–100), whatever the medium.
 * Measurement only: scores are shown on the host console and projector and never reach any step, so the
 * telephone rule (a step sees only its predecessor + a static instruction) is untouched.
 * Speech is scored as the text it reads (the previous step's score), videos by their middle frame.
 */

export const JUDGE_PROMPT = `You are scoring a game of telephone. ORIGINAL is where the chain started. LATER is what it became after several hand-offs between AI models, possibly in a different medium (photo, illustration, SVG drawing, ASCII art, 3D render, written description, emoji, poem).

Judge how much of the ORIGINAL's CONTENT survives in LATER. Ignore medium and art style completely: an ASCII sketch or a string of emoji that keeps the same subjects and arrangement should score high; a beautiful picture of different things should score low.

Rate each from 0 to 100:
- subjects: the main things or beings that are present
- details: their colours, materials, counts, and any written text
- arrangement: where things are relative to each other
- setting: the place, background, lighting, time of day
- mood: the overall feeling

Then name, in at most 8 words, the most important thing that was lost or changed (or "nothing important").
Reply with JSON only: {"subjects":0,"details":0,"arrangement":0,"setting":0,"mood":0,"lost":"..."}`;

export const WEIGHTS = { subjects: 0.4, details: 0.2, arrangement: 0.15, setting: 0.15, mood: 0.1 } as const;

/** Weighted 0–100 score from the judge's reply, or null if it did not return usable JSON. */
export function parseVerdict(reply: string): { score: number; aspects: Record<string, number>; lost: string } | null {
  const m = /\{[\s\S]*\}/.exec(reply);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const aspects: Record<string, number> = {};
  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = Number(j[k]);
    if (!Number.isFinite(v)) return null;
    aspects[k] = Math.max(0, Math.min(100, v));
    score += aspects[k] * w;
  }
  return { score: Math.round(score), aspects, lost: String(j.lost ?? '').slice(0, 80) };
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
/** retryDelaysMs: waits before re-asking after a transient failure (upstream rate limit, 5xx). */
export type JudgeOpts = { fetchImpl?: typeof fetch; model?: string; mock?: boolean; retryDelaysMs?: number[] };

export class ResemblanceJudge {
  db: DB; store: ArtifactStore; cfg: Config; bus: EventBus; opts: JudgeOpts;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(db: DB, store: ArtifactStore, cfg: Config, bus: EventBus, opts: JudgeOpts = {}) {
    this.db = db; this.store = store; this.cfg = cfg; this.bus = bus; this.opts = opts;
  }

  get model() {
    return this.opts.model ?? process.env.RESEMBLANCE_MODEL ?? 'google/gemini-2.5-flash';
  }

  /** Scores run one at a time, in order, so a speech step can reuse the score of the text before it. */
  enqueue(runId: string, stepIndex: number): Promise<unknown> {
    this.set(runId, stepIndex, { status: 'scoring' });
    this.queue = this.queue.then(() => this.score(runId, stepIndex)).catch(() => {});
    return this.queue;
  }

  /** (Re)score every finished step of a run, e.g. one that ran before the meter existed. */
  scoreRun(runId: string, onlyMissing = true): Promise<unknown> {
    const done = new Set((this.db.prepare("SELECT step_index FROM resemblance WHERE run_id = ? AND status IN ('done','carried')").all(runId) as any[]).map((r) => r.step_index));
    const steps = this.db.prepare("SELECT step_index FROM step_executions WHERE run_id = ? AND status = 'succeeded' ORDER BY step_index").all(runId) as any[];
    for (const s of steps) if (!onlyMissing || !done.has(s.step_index)) this.enqueue(runId, s.step_index);
    return this.queue;
  }

  idle() {
    return this.queue;
  }

  view(runId: string): Map<number, ResemblanceView> {
    const out = new Map<number, ResemblanceView>();
    for (const r of this.db.prepare('SELECT * FROM resemblance WHERE run_id = ?').all(runId) as any[]) {
      const d = r.detail ? JSON.parse(r.detail) : {};
      out.set(r.step_index, { status: r.status, score: r.score ?? null, lost: d.lost, aspects: d.aspects, model: r.model ?? undefined, error: r.error ?? undefined });
    }
    return out;
  }

  private set(runId: string, i: number, v: { status: ResemblanceView['status']; score?: number | null; detail?: unknown; model?: string; costUsd?: number | null; error?: string }) {
    this.db.prepare(`INSERT INTO resemblance(run_id, step_index, status, score, detail, model, cost_usd, error, created_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, step_index) DO UPDATE SET status=excluded.status, score=excluded.score, detail=excluded.detail, model=excluded.model, cost_usd=excluded.cost_usd, error=excluded.error, created_at=excluded.created_at`)
      .run(runId, i, v.status, v.score ?? null, v.detail ? JSON.stringify(v.detail) : null, v.model ?? null, v.costUsd ?? null, v.error ?? null, now());
    this.bus.publish(runId, 'resemblance.changed', { index: i, status: v.status });
  }

  private async score(runId: string, i: number) {
    try {
      const runRow = this.db.prepare('SELECT source_artifact_id FROM runs WHERE id = ?').get(runId) as any;
      const stx = this.db.prepare('SELECT artifact_id FROM step_executions WHERE run_id = ? AND step_index = ?').get(runId, i) as any;
      const original = runRow && this.store.get(runRow.source_artifact_id);
      const later = stx?.artifact_id && this.store.get(stx.artifact_id);
      if (!original || !later) return this.set(runId, i, { status: 'failed', error: 'Nothing to score yet.' });
      if (later.kind === 'audio') {
        // speech reads its input text aloud: it keeps exactly what that text kept
        const prev = i === 0 ? { score: 100 } : (this.db.prepare("SELECT score FROM resemblance WHERE run_id = ? AND step_index = ? AND status IN ('done','carried')").get(runId, i - 1) as any);
        return this.set(runId, i, { status: 'carried', score: prev?.score ?? null, detail: { lost: 'spoken aloud: same content as the text before' } });
      }
      if (this.opts.mock) {
        const score = Math.max(5, 100 - 9 * (i + 1));
        return this.set(runId, i, { status: 'done', score, model: 'mock', costUsd: 0, detail: { aspects: {}, lost: `mock verdict for step ${i + 1}` } });
      }
      const content: Part[] = [{ type: 'text', text: JUDGE_PROMPT }, { type: 'text', text: 'ORIGINAL:' }, ...(await this.parts(original)), { type: 'text', text: 'LATER:' }, ...(await this.parts(later))];
      const r = await this.ask(content);
      const v = parseVerdict(r.text);
      if (!v) return this.set(runId, i, { status: 'failed', model: this.model, costUsd: r.cost, error: `Judge reply was not a verdict: ${r.text.slice(0, 120)}` });
      this.set(runId, i, { status: 'done', score: v.score, model: this.model, costUsd: r.cost, detail: { aspects: v.aspects, lost: v.lost } });
    } catch (e: any) {
      this.set(runId, i, { status: 'failed', model: this.model, error: scrub(String(e?.message ?? e), [this.cfg.openrouterKey]).slice(0, 200) });
    }
  }

  private async parts(a: ArtifactRow): Promise<Part[]> {
    if (a.kind === 'text') return [{ type: 'text', text: a.text ?? '' }];
    const bytes = a.kind === 'video' ? await this.middleFrame(a) : this.store.readBytes(a);
    const mime = a.kind === 'video' ? 'image/jpeg' : (a.mime ?? 'image/jpeg');
    return [{ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }];
  }

  private async middleFrame(a: ArtifactRow): Promise<Buffer> {
    const out = path.join(this.cfg.tmpDir, `frame_${crypto.randomBytes(6).toString('hex')}.jpg`);
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', String((a.duration_sec ?? 2) / 2), '-i', this.store.absPath(a), '-frames:v', '1', '-q:v', '3', out], { timeout: 30_000 });
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }

  /** Transient judge failures (e.g. "temporarily rate-limited upstream", seen live) are retried with backoff. */
  private async ask(content: Part[]): Promise<{ text: string; cost: number | null }> {
    const delays = this.opts.retryDelaysMs ?? [4000, 10000, 20000];
    for (let k = 0; ; k++) {
      try {
        return await this.askOnce(content);
      } catch (e: any) {
        if (k >= delays.length || !/rate.?limit|temporar|overload|\((429|500|502|503|504)\)/i.test(String(e?.message))) throw e;
        await new Promise((r) => setTimeout(r, delays[k]));
      }
    }
  }

  private async askOnce(content: Part[]): Promise<{ text: string; cost: number | null }> {
    if (!this.cfg.openrouterKey) throw new Error('OPENROUTER_API_KEY is not configured.');
    const res = await (this.opts.fetchImpl ?? fetch)('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.openrouterKey}`, 'Content-Type': 'application/json', 'X-Title': 'AI Telephone (local)' },
      body: JSON.stringify({ model: this.model, temperature: 0, messages: [{ role: 'user', content }], usage: { include: true } }),
      signal: AbortSignal.timeout(90_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.error || json?.choices?.[0]?.error) throw new Error(`Judge call failed (${res.status}): ${json?.error?.message ?? json?.choices?.[0]?.error?.message ?? res.statusText}`);
    const msg = json?.choices?.[0]?.message?.content;
    const text = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.map((p: any) => p?.text ?? '').join('') : '';
    const cost = typeof json?.usage?.cost === 'number' && json.usage.cost > 0 ? json.usage.cost : null;
    return { text, cost };
  }
}
