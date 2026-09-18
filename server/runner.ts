import { type DB, newId, now, tx } from './db.ts';
import type { ArtifactStore, ArtifactRow } from './artifacts.ts';
import type { Config } from './config.ts';
import { inspectGeneratedImage, probeVideo, MediaError } from './media.ts';
import { ProviderError, scrub, type Adapters, type StepInput, type StepResult } from './providers/types.ts';
import { STEP_TYPES, validateChain, type AttemptView, type PresetBody, type RunStatus, type RunView, type StepDefinition, type StepView } from '../shared/types.ts';
import type { EventBus } from './events.ts';

type RunRow = {
  id: string; name: string; snapshot: string; source_artifact_id: string; status: RunStatus; status_reason: string | null;
  current_step_index: number; single_step: number; pause_requested: number; budget_usd: number | null; imported: number;
  created_at: number; started_at: number | null; finished_at: number | null;
};

export class RunError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_AUTO_RETRIES = 2;

export class Runner {
  db: DB; store: ArtifactStore; cfg: Config; adapters: Adapters; bus: EventBus;
  private active: { runId: string; abort: AbortController; done: Promise<void> } | null = null;
  /** called after each successful step (used for auto-reveal and model test state) */
  onStepSucceeded: (runId: string, stepIndex: number, def: StepDefinition, elapsedMs: number) => void = () => {};
  onStepFailed: (def: StepDefinition, kind: string, message: string) => void = () => {};
  backoffMs = 1500;

  constructor(db: DB, store: ArtifactStore, cfg: Config, adapters: Adapters, bus: EventBus) {
    this.db = db; this.store = store; this.cfg = cfg; this.adapters = adapters; this.bus = bus;
  }

  // ---- creation ------------------------------------------------------

  createRun(opts: { preset: PresetBody; sourceArtifactId: string; budgetUsd: number | null; name?: string }): string {
    const src = this.store.get(opts.sourceArtifactId);
    if (!src) throw new RunError(400, 'Source artifact not found.');
    if (src.kind !== opts.preset.startingKind && !(opts.preset.steps[0] && STEP_TYPES[opts.preset.steps[0].type].input === src.kind))
      throw new RunError(400, `This pipeline starts from ${opts.preset.startingKind}, but the selected source is ${src.kind}.`);
    if (!opts.preset.steps.length) throw new RunError(400, 'Add at least one step.');
    const issues = validateChain(src.kind, opts.preset.steps);
    if (issues.length) throw new RunError(400, `Step ${issues[0].index + 1}: ${issues[0].message}`);
    const id = newId('run');
    // Immutable snapshot: later preset edits never affect this run.
    const snapshot: PresetBody = JSON.parse(JSON.stringify({ ...opts.preset, startingKind: src.kind }));
    tx(this.db, () => {
      this.db.prepare('INSERT INTO runs(id, name, snapshot, source_artifact_id, status, budget_usd, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, opts.name ?? opts.preset.name, JSON.stringify(snapshot), src.id, 'ready', opts.budgetUsd, now());
      snapshot.steps.forEach((s, i) =>
        this.db.prepare('INSERT INTO step_executions(id, run_id, step_index, definition_id) VALUES(?,?,?,?)').run(newId('stx'), id, i, s.id));
    });
    this.emit(id, 'run.created', {});
    return id;
  }

  // ---- control -------------------------------------------------------

  private row(id: string): RunRow {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!r) throw new RunError(404, 'Run not found.');
    return r;
  }

  /** Atomic status transition; returns false when another request got there first (double-click safe). */
  private transition(id: string, from: RunStatus[], to: RunStatus, extra: { singleStep?: boolean; reason?: string | null } = {}): boolean {
    return tx(this.db, () => {
      if (to === 'running') {
        const other = this.db.prepare("SELECT id FROM runs WHERE status = 'running' AND id != ?").get(id) as any;
        if (other) throw new RunError(409, 'Another run is already active. Stop or finish it first.');
      }
      const res = this.db
        .prepare(`UPDATE runs SET status = ?, status_reason = ?, single_step = ?, pause_requested = 0, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
        .run(to, extra.reason ?? null, extra.singleStep ? 1 : 0, now(), to === 'completed' || to === 'stopped' ? now() : null, id, ...from);
      return Number(res.changes) === 1;
    });
  }

  start(id: string, singleStep = false) {
    const r = this.row(id);
    if (r.imported) throw new RunError(400, 'Imported replay runs cannot be executed.');
    if (r.status === 'failed') throw new RunError(409, 'This run has a failed step. Use Retry failed step.');
    if (!this.transition(id, ['ready', 'paused'], 'running', { singleStep })) throw new RunError(409, `Run is ${this.row(id).status}; nothing started.`);
    this.emit(id, 'run.running', {});
    this.spawn(id);
  }

  pause(id: string) {
    const res = this.db.prepare("UPDATE runs SET pause_requested = 1 WHERE id = ? AND status = 'running'").run(id);
    if (!Number(res.changes)) throw new RunError(409, 'Run is not running.');
    this.emit(id, 'run.pause_requested', {});
  }

  async stop(id: string) {
    if (!this.transition(id, ['ready', 'running', 'paused', 'failed'], 'stopped', { reason: 'Stopped by host. Any in-flight provider request may still finish and be billed.' }))
      throw new RunError(409, 'Run is already finished.');
    if (this.active?.runId === id) {
      this.active.abort.abort();
      const att = this.db.prepare("SELECT a.provider_request_id AS rid, s.step_index AS idx FROM attempts a JOIN step_executions s ON s.id = a.step_execution_id WHERE s.run_id = ? AND a.status IN ('queued','running') AND a.provider_request_id IS NOT NULL").get(id) as any;
      if (att) {
        const def = this.snapshot(this.row(id)).steps[att.idx];
        void this.adapters[STEP_TYPES[def.type].provider].cancel?.(def.modelId, att.rid);
      }
    }
    this.emit(id, 'run.stopped', {});
  }

  /** Explicit host retry. `acknowledgeBilling` is required when the previous attempt's fate is unknown. */
  retry(id: string, acknowledgeBilling: boolean) {
    const r = this.row(id);
    if (r.status !== 'failed') throw new RunError(409, 'Only a failed run can be retried.');
    const last = this.lastAttempt(id, r.current_step_index);
    if (last?.status === 'unknown' && !last.provider_request_id && !acknowledgeBilling)
      throw new RunError(428, 'The previous request may already have been billed. Confirm to submit it again.');
    if (!this.transition(id, ['failed'], 'running', { singleStep: !!r.single_step })) throw new RunError(409, 'Retry already in progress.');
    this.emit(id, 'run.running', { retry: true });
    this.spawn(id);
  }

  private lastAttempt(runId: string, stepIndex: number) {
    return this.db.prepare('SELECT a.* FROM attempts a JOIN step_executions s ON s.id = a.step_execution_id WHERE s.run_id = ? AND s.step_index = ? ORDER BY a.submitted_at DESC, a.rowid DESC LIMIT 1').get(runId, stepIndex) as any;
  }

  async idle() {
    while (this.active) await this.active.done;
  }

  // ---- worker --------------------------------------------------------

  private spawn(runId: string) {
    const abort = new AbortController();
    const done = this.loop(runId, abort.signal)
      .catch((e) => {
        console.error('[runner] unexpected failure:', scrub(String(e?.stack ?? e), [this.cfg.openrouterKey, this.cfg.falKey]));
        this.transition(runId, ['running'], 'failed', { reason: 'Internal error; see server log.' });
        this.emit(runId, 'run.failed', {});
      })
      .finally(() => {
        if (this.active?.runId === runId) this.active = null;
      });
    this.active = { runId, abort, done };
  }

  private snapshot(r: RunRow): PresetBody {
    return JSON.parse(r.snapshot);
  }

  private async loop(runId: string, signal: AbortSignal) {
    for (;;) {
      const r = this.row(runId);
      if (r.status !== 'running') return;
      const steps = this.snapshot(r).steps;
      const i = r.current_step_index;
      if (i >= steps.length) {
        this.transition(runId, ['running'], 'completed');
        this.emit(runId, 'run.completed', {});
        return;
      }
      // Budget gate before every paid submission.
      const cost = this.costs(runId);
      if (r.budget_usd != null && cost.actual + cost.estimated >= r.budget_usd) {
        this.transition(runId, ['running'], 'paused', { reason: `Budget limit $${r.budget_usd.toFixed(2)} reached (known spend $${(cost.actual + cost.estimated).toFixed(3)}${cost.unknown ? `, plus ${cost.unknown} step(s) of unknown cost` : ''}). Raise the limit via a new run, or resume to override once.` });
        this.db.prepare('UPDATE runs SET budget_usd = NULL WHERE id = ?').run(runId); // resume = explicit override
        this.emit(runId, 'run.paused', { budget: true });
        return;
      }
      const ok = await this.executeStep(r, steps[i], i, signal);
      if (!ok) return;
      const after = this.row(runId);
      if (after.status !== 'running') return; // stopped while in flight: result kept, pipeline not continued
      if (after.current_step_index >= steps.length) continue;
      if (after.pause_requested || after.single_step) {
        this.transition(runId, ['running'], 'paused', { reason: after.single_step ? 'Ran one step.' : 'Paused by host.' });
        this.emit(runId, 'run.paused', {});
        return;
      }
    }
  }

  /** The ONLY place a step's input is assembled: predecessor primary artifact + static instruction. */
  private buildInput(pred: ArtifactRow): StepInput {
    if (pred.kind === 'text') return { kind: 'text', text: pred.text ?? '' };
    if (pred.kind === 'image') return { kind: 'image', bytes: this.store.readBytes(pred), mime: pred.mime ?? 'image/jpeg' };
    throw new ProviderError('unsupported', 'Video inputs are not supported in this build (video understanding was out of scope).');
  }

  private async executeStep(r: RunRow, def: StepDefinition, i: number, signal: AbortSignal): Promise<boolean> {
    const stx = this.db.prepare('SELECT * FROM step_executions WHERE run_id = ? AND step_index = ?').get(r.id, i) as any;
    const predId: string = i === 0 ? r.source_artifact_id : (this.db.prepare('SELECT artifact_id FROM step_executions WHERE run_id = ? AND step_index = ?').get(r.id, i - 1) as any).artifact_id;
    const pred = this.store.get(predId)!;
    const adapter = this.adapters[STEP_TYPES[def.type].provider];
    this.db.prepare("UPDATE step_executions SET status = 'running', predecessor_artifact_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ?").run(predId, now(), stx.id);

    // Reconcile a known async job instead of resubmitting.
    const prior = this.lastAttempt(r.id, i);
    const resumable = prior && prior.provider_request_id && adapter.resume &&
      (['queued', 'running', 'unknown'].includes(prior.status) || ['expired_url', 'corrupt_media', 'disk', 'other'].includes(prior.error_kind));

    for (let autoRetry = 0; ; autoRetry++) {
      let attemptId: string;
      if (resumable && autoRetry === 0) {
        attemptId = prior.id;
        this.db.prepare("UPDATE attempts SET status = 'running', error = NULL, error_kind = NULL, finished_at = NULL WHERE id = ?").run(attemptId);
      } else {
        attemptId = newId('att');
        this.db.prepare("INSERT INTO attempts(id, step_execution_id, status, submitted_at, request_snapshot) VALUES(?,?,'submitting',?,?)")
          .run(attemptId, stx.id, now(), JSON.stringify({ model: def.modelId, instruction: def.instruction, params: def.params }));
      }
      this.emit(r.id, 'step.started', { index: i });
      const started = Date.now();
      try {
        const common = {
          type: def.type, modelId: def.modelId, instruction: def.instruction, params: def.params ?? {}, signal,
          onSubmitted: (info: { requestId: string; uploadRef?: string }) => {
            this.db.prepare("UPDATE attempts SET provider_request_id = ?, provider_upload_ref = ?, status = 'queued' WHERE id = ?").run(info.requestId, info.uploadRef ?? null, attemptId);
            this.emit(r.id, 'attempt.queued', { index: i });
          },
          onStatus: (s: 'queued' | 'running') => {
            const res = this.db.prepare('UPDATE attempts SET status = ? WHERE id = ? AND status != ?').run(s, attemptId, s);
            if (Number(res.changes)) this.emit(r.id, 'attempt.status', { index: i, status: s });
          },
        };
        const result: StepResult = resumable && autoRetry === 0
          ? await adapter.resume!({ ...common, requestId: prior.provider_request_id })
          : await adapter.execute({ ...common, input: this.buildInput(pred) });
        const artifact = await this.persist(result, attemptId);
        tx(this.db, () => {
          this.db.prepare("UPDATE attempts SET status = 'succeeded', finished_at = ?, usage = ?, cost_usd = ?, cost_status = ?, provider_model = ?, provider_name = ?, provider_request_id = COALESCE(?, provider_request_id), expanded_prompt = ?, inference_sec = ?, request_snapshot = ? WHERE id = ?")
            .run(now(), JSON.stringify(result.usage ?? null), result.costUsd ?? null, result.costStatus, result.providerModel ?? null, result.providerName ?? null, result.providerRequestId ?? null, result.expandedPrompt ?? null, result.inferenceSec ?? null, JSON.stringify(result.requestSnapshot), attemptId);
          this.db.prepare("UPDATE step_executions SET status = 'succeeded', successful_attempt_id = ?, artifact_id = ?, finished_at = ? WHERE id = ?").run(attemptId, artifact.id, now(), stx.id);
          // A stopped run keeps its late result but never advances/restarts.
          this.db.prepare('UPDATE runs SET current_step_index = ? WHERE id = ?').run(i + 1, r.id);
        });
        this.onStepSucceeded(r.id, i, def, Date.now() - started);
        this.emit(r.id, 'step.succeeded', { index: i });
        return true;
      } catch (e: any) {
        const pe = this.toProviderError(e);
        const unknown = pe.kind === 'ambiguous';
        this.db.prepare('UPDATE attempts SET status = ?, finished_at = ?, error = ?, error_kind = ?, provider_request_id = COALESCE(?, provider_request_id) WHERE id = ?')
          .run(unknown ? 'unknown' : 'failed', now(), pe.message, pe.kind, pe.providerRequestId ?? null, attemptId);
        if (pe.retryable && autoRetry < MAX_AUTO_RETRIES && !signal.aborted && this.row(r.id).status === 'running') {
          this.emit(r.id, 'attempt.retrying', { index: i });
          await new Promise((res) => setTimeout(res, pe.retryAfterMs ?? this.backoffMs * 2 ** autoRetry));
          continue;
        }
        this.db.prepare('UPDATE step_executions SET status = ? WHERE id = ?').run(unknown ? 'unknown' : 'failed', stx.id);
        if (pe.kind !== 'cancelled') this.onStepFailed(def, pe.kind, pe.message);
        if (this.transition(r.id, ['running'], 'failed', { reason: pe.message })) this.emit(r.id, 'run.failed', { index: i });
        else this.emit(r.id, 'step.failed', { index: i });
        return false;
      }
    }
  }

  private toProviderError(e: any): ProviderError {
    if (e instanceof ProviderError) return e;
    if (e instanceof MediaError) return new ProviderError(e.kind === 'expired_url' ? 'expired_url' : 'corrupt_media', e.message);
    if (e?.code === 'ENOSPC' || e?.code === 'EACCES' || e?.code === 'EIO' || e?.code === 'EROFS')
      return new ProviderError('disk', `Could not save the result to disk (${e.code}). The provider call succeeded and was billed; free space and Retry.`);
    return new ProviderError('other', scrub(String(e?.message ?? e), [this.cfg.openrouterKey, this.cfg.falKey]));
  }

  private async persist(result: StepResult, attemptId: string): Promise<ArtifactRow> {
    const o = result.output;
    if (o.kind === 'text') return this.store.saveText(o.text, attemptId);
    if (o.kind === 'image') {
      const img = await inspectGeneratedImage(o.bytes);
      return this.store.saveMedia('image', img.bytes, img, attemptId);
    }
    const v = await probeVideo(o.bytes, this.cfg.tmpDir);
    return this.store.saveMedia('video', o.bytes, v, attemptId);
  }

  // ---- recovery ------------------------------------------------------

  /** After a restart nothing resumes billing by itself: in-flight work is reconciled or flagged. */
  recover() {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as RunRow[];
    for (const r of rows) {
      const att = this.lastAttempt(r.id, r.current_step_index);
      if (att && ['submitting', 'queued', 'running'].includes(att.status)) {
        if (att.provider_request_id) {
          // Known async job: mark paused; Resume reconciles by request ID without resubmitting.
          this.db.prepare("UPDATE runs SET status = 'paused', status_reason = ? WHERE id = ?").run('Server restarted while a fal job was in flight. Resume will reconcile the existing job by request ID (no resubmission).', r.id);
        } else {
          this.db.prepare("UPDATE attempts SET status = 'unknown', finished_at = ?, error = ?, error_kind = 'ambiguous' WHERE id = ?")
            .run(now(), 'Server restarted during this request. It may have completed and been billed.', att.id);
          this.db.prepare("UPDATE step_executions SET status = 'unknown' WHERE id = ?").run(att.step_execution_id);
          this.db.prepare("UPDATE runs SET status = 'failed', status_reason = ? WHERE id = ?").run('Server restarted during a provider request whose outcome is unknown. Retrying may bill again.', r.id);
        }
      } else {
        this.db.prepare("UPDATE runs SET status = 'paused', status_reason = 'Server restarted between steps.' WHERE id = ?").run(r.id);
      }
    }
    return rows.length;
  }

  // ---- views ---------------------------------------------------------

  costs(runId: string) {
    const rows = this.db.prepare("SELECT a.cost_usd AS c, a.cost_status AS s, a.status AS st FROM attempts a JOIN step_executions x ON x.id = a.step_execution_id WHERE x.run_id = ?").all(runId) as any[];
    let actual = 0, estimated = 0, unknown = 0;
    for (const a of rows) {
      if (a.st === 'succeeded' && a.s === 'actual' && a.c != null) actual += a.c;
      else if (a.st === 'succeeded' && a.s === 'estimated' && a.c != null) estimated += a.c;
      else if (a.st === 'succeeded' || a.st === 'unknown') unknown += 1; // never reported as zero
    }
    return { actual, estimated, unknown };
  }

  view(id: string): RunView {
    const r = this.row(id);
    const snap = this.snapshot(r);
    const stxs = this.db.prepare('SELECT * FROM step_executions WHERE run_id = ? ORDER BY step_index').all(id) as any[];
    const steps: StepView[] = stxs.map((s) => {
      const attempts = (this.db.prepare('SELECT * FROM attempts WHERE step_execution_id = ? ORDER BY submitted_at, rowid').all(s.id) as any[]).map(
        (a): AttemptView => ({
          id: a.id, status: a.status, submittedAt: a.submitted_at, finishedAt: a.finished_at ?? undefined, error: a.error ?? undefined, errorKind: a.error_kind ?? undefined,
          costUsd: a.cost_usd, costStatus: a.cost_status, providerModel: a.provider_model ?? undefined, providerName: a.provider_name ?? undefined,
          providerRequestId: a.provider_request_id ?? undefined, expandedPrompt: a.expanded_prompt, inferenceSec: a.inference_sec,
        }),
      );
      return { index: s.step_index, definition: snap.steps[s.step_index], status: s.status, startedAt: s.started_at ?? undefined, finishedAt: s.finished_at ?? undefined, artifact: this.store.view(s.artifact_id ? this.store.get(s.artifact_id) : null), attempts };
    });
    const c = this.costs(id);
    return {
      id: r.id, name: r.name, status: r.status, statusReason: r.status_reason ?? undefined, startingKind: snap.startingKind, source: this.store.view(this.store.get(r.source_artifact_id))!,
      steps, currentStepIndex: r.current_step_index, budgetUsd: r.budget_usd, costActualUsd: c.actual, costEstimatedUsd: c.estimated, costUnknownCount: c.unknown,
      createdAt: r.created_at, startedAt: r.started_at ?? undefined, finishedAt: r.finished_at ?? undefined, imported: !!r.imported,
    };
  }

  list() {
    return (this.db.prepare('SELECT id, name, status, created_at, imported, snapshot FROM runs ORDER BY created_at DESC LIMIT 100').all() as any[]).map((r) => ({
      id: r.id, name: r.name, status: r.status as RunStatus, createdAt: r.created_at, imported: !!r.imported, stepCount: JSON.parse(r.snapshot).steps.length,
    }));
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>) {
    this.bus.publish(runId, type, payload);
  }
}
