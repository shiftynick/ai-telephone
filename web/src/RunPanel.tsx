import { useState } from 'react';
import type { ArtifactView, AttemptView, RunView, StepView } from '../../shared/types.ts';
import { STEP_TYPES } from '../../shared/types.ts';
import { ALLOWED_ACTIONS as ALLOWED, ApiError, api, mediaUrl, type RunAction, type RunListItem } from './api.ts';
import { Banner, Pill, Section, cx, fmtBytes, fmtDuration, fmtMoney, fmtTime, useNow } from './util.tsx';

const statusTone = (s: string) =>
  s === 'completed' || s === 'succeeded' ? 'ok' : s === 'failed' ? 'error' : s === 'running' ? 'accent' : s === 'paused' || s === 'unknown' ? 'warn' : 'neutral';

function Artifact({ a, big }: { a: ArtifactView; big?: boolean }) {
  if (a.kind === 'text')
    return <div className={cx('rounded bg-neutral-950 p-2 text-xs leading-relaxed text-neutral-200', big ? '' : 'max-h-40 overflow-y-auto')}>{a.text}</div>;
  if (a.kind === 'video')
    return (
      <video src={mediaUrl(a.id)} controls playsInline preload="metadata" className="max-h-56 w-full rounded bg-black" />
    );
  return <img src={mediaUrl(a.id)} alt="step output" className="max-h-56 rounded object-contain" />;
}

function Attempt({ a }: { a: AttemptView }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/60 p-1.5 text-[11px] text-neutral-400">
      <div className="flex flex-wrap items-center gap-1">
        <Pill tone={statusTone(a.status)}>{a.status}</Pill>
        <span>{fmtTime(a.submittedAt)}</span>
        {a.finishedAt && <span>· {fmtDuration(a.finishedAt - a.submittedAt)}</span>}
        <span>
          · cost {a.costStatus === 'unknown' ? 'unknown' : `${fmtMoney(a.costUsd)} (${a.costStatus})`}
        </span>
        {a.inferenceSec != null && <span>· inference {a.inferenceSec}s</span>}
      </div>
      {(a.providerModel || a.providerName) && (
        <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
          {a.providerName ?? ''} {a.providerModel ?? ''}
          {a.providerRequestId ? ` · ${a.providerRequestId}` : ''}
        </div>
      )}
      {a.expandedPrompt && (
        <details className="mt-1">
          <summary className="cursor-pointer text-neutral-400">provider-expanded prompt</summary>
          <div className="mt-1 rounded bg-neutral-900 p-1 text-neutral-300">{a.expandedPrompt}</div>
        </details>
      )}
      {a.error && (
        <div className="mt-1 rounded border border-red-900 bg-red-950/50 p-1 text-red-200">
          {a.errorKind ? <span className="font-semibold">[{a.errorKind}] </span> : null}
          {a.error}
        </div>
      )}
    </div>
  );
}

function StepRow({ step, now, onNewRun, busy }: { step: StepView; now: number; onNewRun: (artifactId: string) => void; busy: boolean }) {
  const t = STEP_TYPES[step.definition.type];
  const elapsed = step.status === 'running' && step.startedAt ? now - step.startedAt : step.finishedAt && step.startedAt ? step.finishedAt - step.startedAt : null;
  return (
    <div className={cx('rounded-lg border p-2', step.status === 'failed' ? 'border-red-900 bg-red-950/20' : 'border-neutral-800 bg-neutral-900/40')}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[11px]">{step.index + 1}</span>
        <Pill tone={statusTone(step.status)}>{step.status}</Pill>
        <span className="text-neutral-300">{t?.label ?? step.definition.type}</span>
        <span className="font-mono text-[11px] text-neutral-500">{step.definition.modelId}</span>
        {elapsed != null && <span className="text-neutral-400">{fmtDuration(elapsed)}</span>}
        {step.artifact && (
          <button type="button" className="btn btn-xs ml-auto" disabled={busy} onClick={() => onNewRun(step.artifact!.id)}>
            New run from this artifact
          </button>
        )}
      </div>
      {step.artifact && (
        <div className="mt-2 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <Artifact a={step.artifact} />
          </div>
          <div className="text-[11px] text-neutral-500">
            {step.artifact.kind}
            {step.artifact.width ? ` · ${step.artifact.width}×${step.artifact.height}` : ''}
            {step.artifact.durationSec ? ` · ${step.artifact.durationSec}s` : ''}
            {step.artifact.byteSize ? ` · ${fmtBytes(step.artifact.byteSize)}` : ''}
          </div>
        </div>
      )}
      {step.attempts.length > 0 && (
        <details className="mt-2" open={step.status === 'failed'}>
          <summary className="cursor-pointer text-[11px] text-neutral-400">
            {step.attempts.length} attempt{step.attempts.length === 1 ? '' : 's'}
          </summary>
          <div className="mt-1 space-y-1">
            {step.attempts.map((a) => (
              <Attempt key={a.id} a={a} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function RunPanel({
  run,
  runs,
  selectedRunId,
  replay,
  budget,
  setBudget,
  canCreate,
  createDisabledReason,
  onCreateRun,
  onOpenRun,
  onChanged,
  onError,
}: {
  run: RunView | null;
  runs: RunListItem[];
  selectedRunId: string | null;
  replay: boolean;
  budget: string;
  setBudget: (v: string) => void;
  canCreate: boolean;
  createDisabledReason: string | null;
  onCreateRun: (sourceArtifactId?: string) => void;
  onOpenRun: (id: string) => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const now = useNow(run?.status === 'running');

  const act = async (action: RunAction, acknowledgeBilling = false) => {
    if (!run) return;
    setBusy(true);
    try {
      await api.runAction(run.id, action, acknowledgeBilling);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 428 && action === 'retry') {
        if (window.confirm('The previous request may already have been billed. Submit again?')) {
          try {
            await api.runAction(run.id, 'retry', true);
            onChanged();
          } catch (e2) {
            onError(String((e2 as Error).message));
          }
        }
      } else {
        onError(String(err.message));
      }
    } finally {
      setBusy(false);
    }
  };

  const allowed = run ? ALLOWED[run.status] : [];
  const can = (a: RunAction) => !!run && allowed.includes(a) && !busy;
  const remaining = run ? run.steps.filter((s) => s.status === 'pending').length : 0;
  const elapsed = run?.startedAt ? (run.finishedAt ?? (run.status === 'running' ? now : run.startedAt)) - run.startedAt : 0;

  return (
    <Section
      title="Run"
      right={
        <div className="flex items-center gap-2">
          <label className="lbl">Budget $</label>
          <input
            className="inp w-24 py-1"
            placeholder="no limit"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="decimal"
          />
          <button type="button" className="btn btn-primary" disabled={!canCreate || busy} title={createDisabledReason ?? ''} onClick={() => onCreateRun()}>
            Create run
          </button>
        </div>
      }
    >
      {createDisabledReason && <Banner kind="warn">{createDisabledReason}</Banner>}
      <p className="text-[11px] text-neutral-500">
        A run takes an immutable snapshot of the pipeline above. Editing steps afterwards only affects the next run you create.
      </p>

      {/* --- run list ----------------------------------------------------- */}
      <details className="rounded border border-neutral-800 bg-neutral-900/40 p-2" open={!run}>
        <summary className="cursor-pointer text-xs text-neutral-300">Runs ({runs.length})</summary>
        <div className="mt-2 max-h-52 space-y-1 overflow-y-auto pr-1">
          {runs.length === 0 && <p className="text-xs text-neutral-500">No runs yet.</p>}
          {runs.map((r) => (
            <div
              key={r.id}
              className={cx(
                'flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs',
                r.id === run?.id ? 'border-sky-800 bg-sky-950/40' : 'border-neutral-800 bg-neutral-950/40',
              )}
            >
              <button type="button" className="min-w-0 flex-1 truncate text-left text-neutral-200 hover:underline" onClick={() => onOpenRun(r.id)}>
                {r.name}
              </button>
              <Pill tone={statusTone(r.status)}>{r.status}</Pill>
              <span className="text-neutral-500">{r.stepCount} steps · {fmtTime(r.createdAt)}</span>
              {r.imported && <Pill tone="warn">imported</Pill>}
              {r.id === selectedRunId && <Pill tone="accent">on projector{replay ? ' · replay' : ''}</Pill>}
              <button
                type="button"
                className="btn btn-xs"
                disabled={busy}
                onClick={async () => {
                  try {
                    await api.selectRun(r.id, false);
                    onOpenRun(r.id);
                    onChanged();
                  } catch (e) {
                    onError(String((e as Error).message));
                  }
                }}
              >
                Show on projector
              </button>
              <button
                type="button"
                className="btn btn-xs"
                disabled={busy}
                onClick={async () => {
                  try {
                    await api.selectRun(r.id, true);
                    onOpenRun(r.id);
                    onChanged();
                  } catch (e) {
                    onError(String((e as Error).message));
                  }
                }}
              >
                Replay on projector
              </button>
            </div>
          ))}
        </div>
      </details>

      {!run && <p className="text-sm text-neutral-500">No run open. Create one, or open an existing run above.</p>}

      {run && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-neutral-100">{run.name}</span>
            <Pill tone={statusTone(run.status)}>{run.status}</Pill>
            {run.imported && <Pill tone="warn">imported rehearsal</Pill>}
            <span className="font-mono text-[11px] text-neutral-500">{run.id}</span>
          </div>
          {run.statusReason && <Banner kind={run.status === 'failed' ? 'error' : 'warn'}>{run.statusReason}</Banner>}

          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-primary" disabled={!can('start')} onClick={() => act('start')}>
              Start
            </button>
            <button type="button" className="btn" disabled={!can('pause')} onClick={() => act('pause')}>
              Pause after current step
            </button>
            <button type="button" className="btn" disabled={!can('resume')} onClick={() => act('resume')}>
              Resume
            </button>
            <button type="button" className="btn" disabled={!can('next')} onClick={() => act('next')}>
              Run next step
            </button>
            <button type="button" className="btn btn-danger" disabled={!can('stop')} onClick={() => act('stop')}>
              Stop
            </button>
            <button type="button" className="btn" disabled={!can('retry')} onClick={() => act('retry')}>
              Retry failed step
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="card">
              <div className="lbl">Steps</div>
              <div className="text-neutral-100">
                {run.steps.length} total · {remaining} remaining
              </div>
            </div>
            <div className="card">
              <div className="lbl">Elapsed</div>
              <div className="text-neutral-100">{run.startedAt ? fmtDuration(elapsed) : 'not started'}</div>
            </div>
            <div className="card col-span-2">
              <div className="lbl">Cost</div>
              <div className="text-neutral-100">
                actual {fmtMoney(run.costActualUsd)} · estimated {fmtMoney(run.costEstimatedUsd)}
                {run.costUnknownCount > 0 ? ` · ${run.costUnknownCount} step(s) unknown cost` : ''}
              </div>
              <div className="text-[11px] text-neutral-500">
                budget {run.budgetUsd == null ? 'none' : fmtMoney(run.budgetUsd)} — a local limit is not an account-wide cap.
              </div>
            </div>
          </div>

          <div>
            <div className="lbl mb-1">Starting artifact</div>
            <div className="max-w-sm">
              <Artifact a={run.source} />
            </div>
          </div>

          <div className="space-y-2">
            {run.steps.map((s) => (
              <StepRow key={s.index} step={s} now={now} busy={busy} onNewRun={(id) => onCreateRun(id)} />
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
