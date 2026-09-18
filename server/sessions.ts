import { type DB, newId, newToken, now, sha256 } from './db.ts';
import type { ArtifactStore } from './artifacts.ts';
import type { Runner } from './runner.ts';
import type { EventBus } from './events.ts';
import { STEP_TYPES, type PresentStage, type PresentState } from '../shared/types.ts';

const SESSION_TTL_MS = 12 * 3600_000;

export type SessionRow = {
  id: string; upload_token_hash: string | null; projector_token_hash: string | null; upload_token: string | null; projector_token: string | null;
  expires_at: number; source_artifact_id: string | null; selected_run_id: string | null; replay: number; auto_reveal: number;
  revealed: string; current_stage: number; compare: number; created_at: number;
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
    };
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
      case 'auto': return this.save(s.id, { auto: action.on });
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

  /** Projector payload. Unrevealed stages carry NO artifact id, text, or instruction. */
  presentState(s: SessionRow): PresentState {
    const base = { replay: !!s.replay, currentStage: s.current_stage, compare: !!s.compare, serverTime: now() };
    if (!s.selected_run_id) return { ...base, hasRun: false, stages: [] };
    const run = this.runner.view(s.selected_run_id);
    const revealed = new Set<number>(JSON.parse(s.revealed));
    const stages: PresentStage[] = [
      { stage: 0, label: 'Starting ' + run.source.kind, kind: run.source.kind, status: 'done', revealed: revealed.has(0), artifact: revealed.has(0) ? run.source : undefined },
      ...run.steps.map((st): PresentStage => {
        const isRevealed = revealed.has(st.index + 1) && !!st.artifact;
        return {
          stage: st.index + 1, label: STEP_TYPES[st.definition.type].label, kind: STEP_TYPES[st.definition.type].output, modelId: st.definition.modelId,
          status: st.status === 'succeeded' ? 'done' : st.status === 'running' ? 'running' : st.status === 'pending' ? 'pending' : 'failed',
          startedAt: st.status === 'running' ? st.startedAt : undefined, revealed: isRevealed,
          artifact: isRevealed ? st.artifact : undefined, instruction: isRevealed ? st.definition.instruction : undefined,
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
