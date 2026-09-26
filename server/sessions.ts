import { type DB, newId, newToken, now, sha256 } from './db.ts';
import type { ArtifactStore } from './artifacts.ts';
import type { Runner } from './runner.ts';
import type { EventBus } from './events.ts';
import { DEFAULT_DISPLAY, STEP_TYPES, WORD_GAMES, WORD_GAME_IDS, type PresentStage, type PresentState, type ProjectorDisplay } from '../shared/types.ts';

const SESSION_TTL_MS = 12 * 3600_000;

export type SessionRow = {
  id: string; upload_token_hash: string | null; projector_token_hash: string | null; upload_token: string | null; projector_token: string | null;
  expires_at: number; source_artifact_id: string | null; selected_run_id: string | null; replay: number; auto_reveal: number;
  revealed: string; current_stage: number; compare: number; created_at: number; display?: string;
};

export class Sessions {
  db: DB; store: ArtifactStore; runner: Runner; bus: EventBus;
  constructor(db: DB, store: ArtifactStore, runner: Runner, bus: EventBus) {
    this.db = db; this.store = store; this.runner = runner; this.bus = bus;
  }

  /** One session per meetup/app use; renewed when expired. */
  current(): SessionRow {
    const r = this.db.prepare('SELECT * FROM sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(now()) as SessionRow | undefined;
    if (r) return r;
    const id = newId('ses');
    const up = newToken(), pr = newToken();
    this.db.prepare('INSERT INTO sessions(id, upload_token_hash, projector_token_hash, upload_token, projector_token, expires_at, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, sha256(up), sha256(pr), up, pr, now() + SESSION_TTL_MS, now());
    return this.current();
  }

  rotate(which: 'upload' | 'projector' | 'both') {
    const s = this.current();
    if (which !== 'projector') { const t = newToken(); this.db.prepare('UPDATE sessions SET upload_token = ?, upload_token_hash = ? WHERE id = ?').run(t, sha256(t), s.id); }
    if (which !== 'upload') { const t = newToken(); this.db.prepare('UPDATE sessions SET projector_token = ?, projector_token_hash = ? WHERE id = ?').run(t, sha256(t), s.id); }
    this.bus.publish(null, 'session.changed');
  }

  byToken(kind: 'upload' | 'projector', token: string): SessionRow | null {
    if (!token || token.length < 20 || token.length > 100) return null;
    const col = kind === 'upload' ? 'upload_token_hash' : 'projector_token_hash';
    return (this.db.prepare(`SELECT * FROM sessions WHERE ${col} = ? AND expires_at > ?`).get(sha256(token), now()) as SessionRow | undefined) ?? null;
  }

  uploadCount(sessionId: string) {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM uploads WHERE session_id = ?').get(sessionId) as any).c as number;
  }

  addUpload(sessionId: string, artifactId: string, origin: 'phone' | 'phone-text' | 'desktop' | 'text', transformations: string[]) {
    const id = newId('upl');
    this.db.prepare('INSERT INTO uploads(id, session_id, artifact_id, origin, transformations, created_at) VALUES(?,?,?,?,?,?)').run(id, sessionId, artifactId, origin, JSON.stringify(transformations), now());
    this.bus.publish(null, 'upload.received', { uploadId: id, origin });
    return id;
  }

  /** Host-only. Accepting makes it the next run's source; it never starts a run. */
  decideUpload(uploadId: string, accept: boolean) {
    const s = this.current();
    const u = this.db.prepare('SELECT * FROM uploads WHERE id = ? AND session_id = ?').get(uploadId, s.id) as any;
    if (!u) return false;
    this.db.prepare('UPDATE uploads SET status = ? WHERE id = ?').run(accept ? 'accepted' : 'rejected', uploadId);
    if (accept) this.db.prepare('UPDATE sessions SET source_artifact_id = ? WHERE id = ?').run(u.artifact_id, s.id);
    this.bus.publish(null, 'session.changed');
    return true;
  }

  /** Host-only: make any earlier artifact the next run's source again. */
  setSource(artifactId: string) {
    this.db.prepare('UPDATE sessions SET source_artifact_id = ? WHERE id = ?').run(artifactId, this.current().id);
    this.bus.publish(null, 'session.changed');
  }

  /**
   * Everything the host may start a new run from: this session's uploads, and the source or any
   * output of any earlier run. Video is excluded because no step in this build accepts video input.
   */
  sourceCandidates(limit = 100) {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT a.id AS id, a.kind AS kind, a.created_at AS created_at,
          COALESCE(
            (SELECT 'upload · ' || u.origin FROM uploads u WHERE u.artifact_id = a.id ORDER BY u.created_at LIMIT 1),
            (SELECT 'start of ' || r.name FROM runs r WHERE r.source_artifact_id = a.id ORDER BY r.created_at LIMIT 1),
            (SELECT 'step ' || (s.step_index + 1) || ' of ' || r2.name
               FROM step_executions s JOIN runs r2 ON r2.id = s.run_id
              WHERE s.artifact_id = a.id ORDER BY r2.created_at LIMIT 1)
          ) AS label
        FROM artifacts a
        WHERE a.kind IN ('image', 'text')
      ) WHERE label IS NOT NULL
      ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
    const current = this.current().source_artifact_id;
    return rows.map((r) => ({
      artifact: this.store.view(this.store.get(r.id))!,
      label: r.label as string,
      createdAt: r.created_at as number,
      isCurrent: r.id === current,
    }));
  }

  hostView() {
    const s = this.current();
    const uploads = (this.db.prepare('SELECT * FROM uploads WHERE session_id = ? ORDER BY created_at DESC LIMIT 20').all(s.id) as any[]).map((u) => ({
      id: u.id, origin: u.origin as string, status: u.status as string, createdAt: u.created_at as number, transformations: JSON.parse(u.transformations) as string[],
      artifact: this.store.view(this.store.get(u.artifact_id))!,
    }));
    return {
      id: s.id, uploadToken: s.upload_token, projectorToken: s.projector_token, expiresAt: s.expires_at,
      source: this.store.view(s.source_artifact_id ? this.store.get(s.source_artifact_id) : null) ?? null,
      uploads, selectedRunId: s.selected_run_id, replay: !!s.replay, autoReveal: !!s.auto_reveal,
      revealed: JSON.parse(s.revealed) as number[], currentStage: s.current_stage, compare: !!s.compare,
      display: this.display(s),
    };
  }

  // ---- projector display (sound, phone QR, slideshow): one shared state for host console + projector ----

  display(s: SessionRow): ProjectorDisplay {
    let d: any = {};
    try { d = JSON.parse(s.display ?? '{}'); } catch { /* keep defaults */ }
    return { ...DEFAULT_DISPLAY, ...d, slideshow: { ...DEFAULT_DISPLAY.slideshow, ...(d.slideshow ?? {}) } };
  }

  setDisplay(patch: { muted?: boolean; qr?: boolean; slideshow?: Partial<ProjectorDisplay['slideshow']>; soundReady?: boolean | null }): ProjectorDisplay {
    const s = this.current();
    const cur = this.display(s);
    const next: ProjectorDisplay = { ...cur, ...patch, slideshow: { ...cur.slideshow, ...(patch.slideshow ?? {}) } } as ProjectorDisplay;
    if (JSON.stringify(next) === JSON.stringify(cur)) return cur; // no-op: no event, no refetch storm
    this.db.prepare('UPDATE sessions SET display = ? WHERE id = ?').run(JSON.stringify(next), s.id);
    this.bus.publish(null, 'present.changed');
    return next;
  }

  // ---- reveal state (server-side so the projector always follows the host) ----

  private save(id: string, patch: { revealed?: number[]; current?: number; compare?: boolean; auto?: boolean }) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow;
    this.db.prepare('UPDATE sessions SET revealed = ?, current_stage = ?, compare = ?, auto_reveal = ? WHERE id = ?').run(
      JSON.stringify(patch.revealed ? [...new Set(patch.revealed)].sort((a, b) => a - b) : JSON.parse(s.revealed)),
      patch.current ?? s.current_stage, Number(patch.compare ?? !!s.compare), Number(patch.auto ?? !!s.auto_reveal), id);
    this.bus.publish(null, 'present.changed');
  }

  selectRun(runId: string | null, replay: boolean) {
    const s = this.current();
    if (runId) this.runner.view(runId); // 404 if missing
    this.db.prepare('UPDATE sessions SET selected_run_id = ?, replay = ? WHERE id = ?').run(runId, Number(replay), s.id);
    this.save(s.id, { revealed: s.auto_reveal || replay ? [0] : [], current: 0, compare: false });
  }

  /** Highest stage that actually has an output (0 = source). */
  private available(runId: string): number {
    const v = this.runner.view(runId);
    let n = 0;
    for (const st of v.steps) { if (st.artifact) n = st.index + 1; else break; }
    return n;
  }

  reveal(action: { action: 'show'; stage: number } | { action: 'next' } | { action: 'prev' } | { action: 'final' } | { action: 'compare'; on: boolean } | { action: 'auto'; on: boolean } | { action: 'reset' }) {
    const s = this.current();
    if (action.action === 'auto') return this.save(s.id, { auto: action.on });
    if (!s.selected_run_id) return;
    const revealed: number[] = JSON.parse(s.revealed);
    const max = this.available(s.selected_run_id);
    const show = (stage: number) => {
      if (!Number.isInteger(stage) || stage < 0 || stage > max) return; // cannot reveal what does not exist yet
      this.save(s.id, { revealed: [...revealed, stage], current: stage, compare: false });
    };
    switch (action.action) {
      case 'show': return show(action.stage);
      case 'next': return show(Math.min(s.current_stage + 1, max));
      case 'prev': return show(Math.max(s.current_stage - 1, 0));
      case 'final': return show(max);
      case 'compare': {
        // comparing shows source and final side by side, so both become revealed
        return this.save(s.id, { compare: action.on, revealed: action.on ? [...revealed, 0, max] : revealed });
      }
      case 'reset': return this.save(s.id, { revealed: [], current: 0, compare: false });
    }
  }

  onStepSucceeded(runId: string, stepIndex: number) {
    const s = this.current();
    if (s.selected_run_id !== runId) return;
    if (s.auto_reveal && !s.replay) {
      const revealed: number[] = JSON.parse(s.revealed);
      this.save(s.id, { revealed: [...revealed, 0, stepIndex + 1], current: stepIndex + 1 });
    } else this.bus.publish(null, 'present.changed');
  }

  /** Typical seconds for a model on a step type, from the last successful live run (model_tests), if known. */
  private typicalSec(modelId: string, type: string): number | undefined {
    const r = this.db.prepare("SELECT elapsed_ms FROM model_tests WHERE model_id = ? AND step_type = ? AND state = 'tested-successfully' AND elapsed_ms IS NOT NULL").get(modelId, type) as any;
    return r ? Math.max(1, Math.round(r.elapsed_ms / 1000)) : undefined;
  }

  /** Projector payload. Unrevealed stages carry NO artifact id, text, or instruction. */
  presentState(s: SessionRow): PresentState {
    const base = { display: this.display(s), replay: !!s.replay, currentStage: s.current_stage, compare: !!s.compare, serverTime: now() };
    if (!s.selected_run_id) return { ...base, hasRun: false, stages: [] };
    const run = this.runner.view(s.selected_run_id);
    const revealed = new Set<number>(JSON.parse(s.revealed));
    const stages: PresentStage[] = [
      { stage: 0, label: 'Starting ' + run.source.kind, kind: run.source.kind, status: 'done', revealed: revealed.has(0), artifact: revealed.has(0) ? run.source : undefined, resemblance: revealed.has(0) ? { status: 'done', score: 100 } : undefined },
      ...run.steps.map((st): PresentStage => {
        const isRevealed = revealed.has(st.index + 1) && !!st.artifact;
        return {
          stage: st.index + 1, label: STEP_TYPES[st.definition.type].label, kind: STEP_TYPES[st.definition.type].output, modelId: st.definition.modelId, type: st.definition.type,
          game: st.definition.type === 'text_to_text' ? WORD_GAME_IDS.find((g) => st.definition.instruction.startsWith(WORD_GAMES[g].instruction)) : undefined,
          etaSec: st.status === 'running' ? this.typicalSec(st.definition.modelId, st.definition.type) : undefined,
          status: st.status === 'succeeded' ? 'done' : st.status === 'running' ? 'running' : st.status === 'pending' ? 'pending' : 'failed',
          startedAt: st.status === 'running' ? st.startedAt : undefined, revealed: isRevealed,
          artifact: isRevealed ? st.artifact : undefined, instruction: isRevealed ? st.definition.instruction : undefined,
          resemblance: isRevealed ? st.resemblance : undefined,
        };
      }),
    ];
    return { ...base, hasRun: true, runStatus: run.status, stages };
  }

  /** May this projector token read this artifact? Only if it is a revealed stage of the selected run. */
  projectorMayRead(s: SessionRow, artifactId: string): boolean {
    return this.presentState(s).stages.some((st) => st.revealed && st.artifact?.id === artifactId);
  }
}
