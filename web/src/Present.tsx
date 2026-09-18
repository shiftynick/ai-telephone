import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactView, PresentStage, PresentState, RunView } from '../../shared/types.ts';
import { ALLOWED_ACTIONS, ApiError, api, mediaUrl, type RevealAction, type RunAction } from './api.ts';
import { cx, fmtDuration, fmtMoney } from './util.tsx';

function VideoStage({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // Detaching the element is not enough in every browser: pause it and drop the source so no
  // audio survives a step switch. Runs on unmount and whenever the source changes.
  useEffect(() => {
    setPlaying(false);
    return () => {
      const v = ref.current;
      if (!v) return;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [src]);
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <video
        ref={ref}
        src={src}
        poster={poster}
        controls
        loop
        playsInline
        preload="auto"
        className="h-full w-full object-contain"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {!playing && (
        <button
          type="button"
          onClick={() => void ref.current?.play()}
          aria-label="Play video"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <span className="flex items-center justify-center rounded-full bg-white/90 text-black shadow-lg" style={{ width: '10vmin', height: '10vmin' }}>
            <span style={{ fontSize: '4vmin', lineHeight: 1, marginLeft: '0.8vmin' }}>▶</span>
          </span>
        </button>
      )}
    </div>
  );
}

function StageArtifact({ a, token, label }: { a: ArtifactView; token: string; label?: string }) {
  if (a.kind === 'text')
    return (
      <div className="fade-in flex h-full w-full items-center justify-center px-[4vw]">
        <p
          className="text-center leading-[1.45] text-neutral-100"
          style={{ fontSize: 'clamp(20px, 2.8vw, 64px)', maxWidth: '70ch' }}
        >
          {a.text}
        </p>
      </div>
    );
  if (a.kind === 'video') return <VideoStage src={mediaUrl(a.id, token)} />;
  return (
    <img
      key={a.id}
      src={mediaUrl(a.id, token)}
      alt={label ?? 'stage artifact'}
      className="fade-in h-full w-full object-contain"
    />
  );
}

export default function Present({ token }: { token: string }) {
  const [state, setState] = useState<PresentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0); // local clock − server clock
  const [detailStage, setDetailStage] = useState<number | null>(null); // viewer-local browsing; never sent to the server
  const [tick, setTick] = useState(0);
  // Host controls appear only when this browser also holds the host cookie (i.e. the projector window
  // was opened on the host's own machine). The projector token itself still grants nothing.
  const [isHost, setIsHost] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api.presentState(token);
        if (!alive) return;
        setOffset(Date.now() - s.serverTime);
        setState(s);
        setError(null);
      } catch (e) {
        if (alive) setError(String((e as Error).message));
      }
    };
    const loadHost = async () => {
      try {
        const st = await api.status();
        if (!alive || !st.host) return;
        setIsHost(true);
        const ses = await api.session();
        if (!alive) return;
        setRunId(ses.selectedRunId);
        setRun(ses.selectedRunId ? await api.run(ses.selectedRunId) : null);
      } catch {
        /* not the host, or the session ended: stay a plain projector */
      }
    };
    void load();
    void loadHost();
    const es = new EventSource(`/api/present/${encodeURIComponent(token)}/events`);
    es.addEventListener('change', () => { void load(); void loadHost(); });
    es.addEventListener('open', () => { void load(); void loadHost(); });
    const iv = setInterval(() => { void load(); void loadHost(); }, 5000); // fallback if SSE is wedged
    return () => {
      alive = false;
      es.close();
      clearInterval(iv);
    };
  }, [token]);

  // Controls fade in on mouse movement and fade out again, so they never sit on the projection.
  useEffect(() => {
    if (!isHost) return;
    const wake = () => {
      setShowControls(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setShowControls(false), 3500);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('touchstart', wake);
    return () => {
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('touchstart', wake);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [isHost]);

  const reveal = useCallback(async (action: RevealAction) => {
    setBusy(true);
    setActionError(null);
    try {
      const ses = await api.reveal(action);
      setRunId(ses.selectedRunId);
      setState(await api.presentState(token));
      setDetailStage(null);
    } catch (e) {
      setActionError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }, [token]);

  const act = useCallback(async (action: RunAction) => {
    if (!runId) return;
    setBusy(true);
    setActionError(null);
    try {
      setRun(await api.runAction(runId, action));
    } catch (e) {
      // 428 = the previous attempt's fate is unknown; retrying may bill a second time.
      if (e instanceof ApiError && e.status === 428 && window.confirm(`${e.message}\n\nSubmit it again anyway?`)) {
        try {
          setRun(await api.runAction(runId, action, true));
        } catch (e2) {
          setActionError(String((e2 as Error).message));
        }
      } else setActionError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }, [runId]);

  // When the host moves the stage, the projector follows again.
  useEffect(() => setDetailStage(null), [state?.currentStage, state?.compare]);

  // ← / → flip through REVEALED stages locally; Esc returns to the host's stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state?.hasRun) return;
      if (e.key === 'Escape') return setDetailStage(null);
      if (e.key === 'c' && isHost) return setPinned((p) => !p);
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (isHost && detailStage === null) return void reveal({ action: e.key === 'ArrowRight' ? 'next' : 'prev' });
      const open = state.stages.filter((s) => s.revealed && s.artifact).map((s) => s.stage);
      if (!open.length) return;
      const from = detailStage ?? state.currentStage;
      const next = e.key === 'ArrowRight' ? open.find((n) => n > from) : [...open].reverse().find((n) => n < from);
      if (next !== undefined) setDetailStage(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, detailStage, isHost, reveal]);

  const running = state?.stages.some((s) => s.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);
  void tick;

  if (error && !state)
    return (
      <div className="flex h-full items-center justify-center bg-[#0a0a0a] p-8 text-center">
        <div>
          <div className="text-[3vw] text-neutral-200">Projector link not valid</div>
          <div className="mt-2 text-[1.4vw] text-neutral-500">{error}</div>
        </div>
      </div>
    );

  if (!state) return <div className="h-full bg-[#0a0a0a]" />;

  if (!state.hasRun)
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[#0a0a0a] text-center">
        <h1 className="font-semibold tracking-tight text-neutral-100" style={{ fontSize: 'clamp(32px, 7vw, 140px)' }}>
          AI Telephone
        </h1>
        <p className="mt-[2vh] text-neutral-500" style={{ fontSize: 'clamp(14px, 1.6vw, 28px)' }}>
          Waiting for the host…
        </p>
      </div>
    );

  const stages = state.stages;
  const total = stages.length - 1; // steps, excluding the source stage
  const current = stages.find((s) => s.stage === state.currentStage) ?? stages[0];
  const runningStage = stages.find((s) => s.status === 'running');
  const finalRevealed = [...stages].reverse().find((s) => s.revealed && s.stage > 0) ?? null;
  const source = stages[0];
  const found = detailStage === null ? null : (stages.find((s) => s.stage === detailStage) ?? null);
  const detail = found?.revealed && found.artifact ? found : null;

  const label =
    current.stage === 0
      ? `Starting ${current.kind === 'text' ? 'text' : 'image'}`
      : `Step ${current.stage} of ${total} — ${current.label}`;

  const elapsedOf = (s: PresentStage) => (s.startedAt ? Math.max(0, Math.floor((Date.now() - offset - s.startedAt) / 1000)) : 0);

  return (
    <div className="relative flex h-full flex-col bg-[#0a0a0a] text-neutral-100">
      {/* top-left chrome */}
      <div className="flex items-start justify-between px-[2vw] pt-[2vh]">
        <div>
          <div className="font-medium text-neutral-200" style={{ fontSize: 'clamp(13px, 1.5vw, 26px)' }}>
            {state.compare ? 'Start vs final' : label}
          </div>
          <div className="font-mono text-neutral-500" style={{ fontSize: 'clamp(10px, 0.9vw, 16px)' }}>
            {state.compare ? `${total} transformations` : (current.modelId ?? '')}
          </div>
        </div>
        {state.replay && (
          <div className="rounded border border-amber-700 px-[1vw] py-[0.4vh] tracking-widest text-amber-300 uppercase" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
            Replay
          </div>
        )}
      </div>

      {/* stage */}
      <div className="relative min-h-0 flex-1 px-[2vw] py-[2vh]">
        {detail ? null : state.compare ? (
          <div className="grid h-full grid-cols-2 gap-[2vw]">
            {[
              { s: source, name: 'Start' },
              { s: finalRevealed, name: 'Final' },
            ].map(({ s, name }) => (
              <div key={name} className="flex min-h-0 flex-col">
                <div className="mb-[1vh] text-center tracking-widest text-neutral-500 uppercase" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
                  {name}
                </div>
                <div className="min-h-0 flex-1">
                  {s?.artifact ? <StageArtifact key={s.artifact.id} a={s.artifact} token={token} label={name} /> : <div className="h-full" />}
                </div>
              </div>
            ))}
          </div>
        ) : current.revealed && current.artifact ? (
          <StageArtifact key={current.artifact.id} a={current.artifact} token={token} label={label} />
        ) : runningStage ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-neutral-400">
            <div style={{ fontSize: 'clamp(20px, 3vw, 56px)' }}>Generating step {runningStage.stage}…</div>
            <div className="mt-[1.5vh] font-mono text-neutral-500" style={{ fontSize: 'clamp(14px, 1.8vw, 32px)' }}>
              {elapsedOf(runningStage)}s
            </div>
            <div className="mt-[1vh] text-neutral-600" style={{ fontSize: 'clamp(11px, 1.1vw, 20px)' }}>
              {runningStage.label}
              {runningStage.modelId ? ` · ${runningStage.modelId}` : ''}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-700" style={{ fontSize: 'clamp(16px, 2vw, 36px)' }}>
            ·
          </div>
        )}
      </div>

      {/* host-only controls: present only when this browser holds the host cookie */}
      {isHost && (
        <div
          className={cx(
            'relative z-30 bg-[#0a0a0a]/95 px-[2vw] transition-opacity duration-300',
            showControls || pinned || busy ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onMouseEnter={() => setShowControls(true)}
        >
          {actionError && (
            <div className="mb-[0.6vh] truncate rounded bg-red-950 px-2 py-1 text-red-200" style={{ fontSize: 'clamp(9px, 0.85vw, 15px)' }}>
              {actionError}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-[0.5vw] pb-[0.8vh]" style={{ fontSize: 'clamp(9px, 0.85vw, 15px)' }}>
            <span className="tracking-widest text-neutral-500 uppercase">Reveal</span>
            <button type="button" className="pbtn" disabled={busy} onClick={() => void reveal({ action: 'prev' })}>◀ Prev</button>
            <button type="button" className="pbtn" disabled={busy} onClick={() => void reveal({ action: 'next' })}>Next ▶</button>
            <button type="button" className="pbtn" disabled={busy} onClick={() => void reveal({ action: 'final' })}>Final</button>
            <button type="button" className={cx('pbtn', state.compare && 'pbtn-on')} disabled={busy} onClick={() => void reveal({ action: 'compare', on: !state.compare })}>Compare</button>
            <button type="button" className="pbtn" disabled={busy} onClick={() => void reveal({ action: 'reset' })}>Hide all</button>

            <span className="ml-[1.5vw] tracking-widest text-neutral-500 uppercase">Run</span>
            {run ? (
              (['start', 'pause', 'resume', 'next', 'stop', 'retry'] as RunAction[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={cx('pbtn', a === 'stop' && 'pbtn-danger')}
                  disabled={busy || !ALLOWED_ACTIONS[run.status].includes(a)}
                  onClick={() => void act(a)}
                >
                  {a === 'next' ? 'Next step' : a === 'pause' ? 'Pause' : a[0].toUpperCase() + a.slice(1)}
                </button>
              ))
            ) : (
              <span className="text-neutral-600">no run selected — choose one in the host console</span>
            )}

            {run && (
              <span className="ml-auto flex items-center gap-[1vw] text-neutral-400">
                <span className={cx(run.status === 'failed' ? 'text-red-400' : run.status === 'running' ? 'text-sky-300' : 'text-neutral-300')}>{run.status}</span>
                <span>step {Math.min(run.currentStepIndex + (run.status === 'running' ? 1 : 0), run.steps.length)}/{run.steps.length}</span>
                {run.startedAt && <span>{fmtDuration((run.finishedAt ?? Date.now() - offset) - run.startedAt)}</span>}
                <span>
                  {fmtMoney(run.costActualUsd + run.costEstimatedUsd)}
                  {run.costUnknownCount > 0 ? ` +${run.costUnknownCount} unknown` : ''}
                </span>
                <span className="text-neutral-600">{pinned ? 'pinned (c)' : 'c = pin'}</span>
              </span>
            )}
          </div>
          {run?.statusReason && (
            <div className="truncate pb-[0.8vh] text-amber-300" style={{ fontSize: 'clamp(9px, 0.8vw, 14px)' }}>{run.statusReason}</div>
          )}
        </div>
      )}

      {/* step bar: always visible, above the detail view, for flipping through revealed steps */}
      <div className="relative z-30 flex items-stretch gap-[0.5vw] bg-[#0a0a0a] px-[2vw] pt-[0.8vh] pb-[1.6vh]">
        {stages.map((s) => {
          const isHostStage = s.stage === state.currentStage && !state.compare;
          const isViewing = detail ? detail.stage === s.stage : isHostStage;
          const tone = s.revealed
            ? 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700'
            : s.status === 'running'
              ? 'bg-sky-950 text-sky-300 animate-pulse'
              : s.status === 'failed'
                ? 'bg-red-950 text-red-300'
                : 'bg-neutral-900 text-neutral-600';
          return (
            <button
              key={s.stage}
              type="button"
              disabled={!s.revealed}
              onClick={() => setDetailStage(detail?.stage === s.stage ? null : s.stage)}
              title={s.revealed ? `${s.label} — view with its exact instruction (←/→ to flip, Esc to return)` : 'not revealed yet'}
              className={cx('min-w-0 flex-1 truncate rounded px-[0.4vw] py-[0.6vh] text-center transition-colors', tone, isViewing && 'ring-2 ring-sky-400', s.revealed && 'cursor-pointer')}
              style={{ fontSize: 'clamp(9px, 0.85vw, 16px)' }}
            >
              {s.stage === 0 ? 'Start' : `${s.stage} · ${s.label}`}
            </button>
          );
        })}
      </div>

      {/* viewer-local detail overlay: only ever shows a revealed stage */}
      {detail && detail.artifact && (
        <div
          className="absolute inset-x-0 top-0 z-20 flex flex-col bg-[#050505] px-[3vw] pt-[3vh] pb-[1vh]"
          style={{ bottom: isHost ? '10.5vh' : '6.5vh' }} // clears the step bar, plus the control bar when present
          onClick={() => setDetailStage(null)}
        >
          <div className="mb-[1.5vh] flex items-baseline gap-[1.5vw]">
            <span className="text-neutral-100" style={{ fontSize: 'clamp(14px, 1.6vw, 28px)' }}>
              {detail.stage === 0 ? `Starting ${detail.kind}` : `Step ${detail.stage} — ${detail.label}`}
            </span>
            <span className="font-mono text-neutral-500" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
              {detail.modelId ?? ''}
            </span>
            <span className="ml-auto text-neutral-500" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
              ←/→ flip · Esc or click to return to the live stage
            </span>
          </div>
          <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
            <StageArtifact key={detail.artifact.id} a={detail.artifact} token={token} />
          </div>
          {detail.instruction && (
            <div
              className="mt-[1.5vh] max-h-[22vh] overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-[1vw] text-neutral-300"
              style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 tracking-widest text-neutral-500 uppercase">Exact instruction</div>
              {detail.instruction}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
