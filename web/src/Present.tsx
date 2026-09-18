import { useCallback, useEffect, useRef, useState } from 'react';
import { FASTEST_MODELS, INSTRUCTION_SETS, NEXT_ACTIONS, PRESET_SCHEMA_VERSION, type ModelsView, type ArtifactKind, type ArtifactView, type PresentStage, type PresentState, type RunView, type StepType } from '../../shared/types.ts';
import { ALLOWED_ACTIONS, ApiError, api, mediaUrl, type RevealAction, type RunAction, type SourceCandidate } from './api.ts';
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

const ACTION_LABEL: Record<StepType, string> = {
  image_to_text: '📝 Describe it',
  image_to_video: '🎬 Animate it',
  text_to_image: '🎨 Draw it',
  text_to_text: '🔁 Retell it',
  text_to_video: '🎥 Film it',
};

/** Host-only: choose what an adventure starts from. Choosing costs nothing; the first action does. */
function AdventureStart({ onPick, onText, onFile, onClose, busy }: {
  onPick: (artifactId: string, kind: ArtifactKind) => void;
  onText: (text: string) => void;
  onFile: (file: File) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [sources, setSources] = useState<SourceCandidate[] | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    let alive = true;
    api.sources().then((r) => alive && setSources(r.sources), () => alive && setSources([]));
    return () => { alive = false; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-[4vw]" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-5xl flex-col gap-4 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl font-semibold text-neutral-100">Start an adventure</h2>
          <button type="button" className="pbtn" onClick={onClose}>Close</button>
        </div>
        <p className="text-sm text-neutral-400">Pick a starting image or sentence. Nothing is sent to a provider until you choose the first action.</p>
        <div className="flex gap-2">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 2000))}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && text.trim()) onText(text.trim()); }}
            placeholder="Type a starting sentence…"
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-base text-neutral-100 placeholder:text-neutral-600"
          />
          <button type="button" className="pbtn" disabled={busy || !text.trim()} onClick={() => onText(text.trim())}>Start from text</button>
          <label className={cx('pbtn cursor-pointer', busy && 'pointer-events-none opacity-50')}>
            Upload image…
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!sources ? (
            <p className="text-neutral-500">Loading earlier sources…</p>
          ) : sources.length === 0 ? (
            <p className="text-neutral-500">No earlier images or texts yet. Type a sentence or upload an image.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-5">
              {sources.map((c) => (
                <button key={c.artifact.id} type="button" disabled={busy} title={c.label} onClick={() => onPick(c.artifact.id, c.artifact.kind)}
                  className="flex flex-col gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-1.5 text-left hover:border-sky-500">
                  {c.artifact.kind === 'image' ? (
                    <img src={mediaUrl(c.artifact.id)} alt="" loading="lazy" className="aspect-video w-full rounded object-cover" />
                  ) : (
                    <div className="aspect-video w-full overflow-hidden rounded bg-neutral-950 p-2 text-[11px] leading-snug text-neutral-300">{c.artifact.text}</div>
                  )}
                  <span className="truncate text-[11px] text-neutral-400">{c.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
  const [startOpen, setStartOpen] = useState(false);
  const [twist, setTwist] = useState('');
  const [advSet, setAdvSet] = useState('faithful');
  // Model per action type for the NEXT step ('' = fastest tested). Remembered across reloads.
  const [models, setModels] = useState<ModelsView | null>(null);
  const [advModels, setAdvModels] = useState<Partial<Record<StepType, string>>>(() => {
    try { return JSON.parse(localStorage.getItem('tele.advModels') ?? '{}'); } catch { return {}; }
  });
  const pickModel = (type: StepType, id: string) => setAdvModels((m) => {
    const next = { ...m, [type]: id };
    localStorage.setItem('tele.advModels', JSON.stringify(next));
    return next;
  });
  useEffect(() => {
    if (!isHost) return;
    let alive = true;
    api.models().then((m) => alive && setModels(m), () => {});
    return () => { alive = false; };
  }, [isHost]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [bottomH, setBottomH] = useState(0);

  // The detail view must clear the bottom bars whatever their height (one row, two rows, wrapped).
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBottomH(el.offsetHeight));
    ro.observe(el);
    setBottomH(el.offsetHeight);
    return () => ro.disconnect();
  });

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

  const guarded = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  /** A fresh interactive run with no steps. Creating it is free; each chosen action is one provider call. */
  const newAdventure = async (artifactId: string, kind: ArtifactKind) => {
    await api.reveal({ action: 'auto', on: true }); // an adventure shows every result as it lands
    const v = await api.createRun({
      preset: { schemaVersion: PRESET_SCHEMA_VERSION, name: 'Adventure', startingKind: kind === 'text' ? 'text' : 'image', steps: [] },
      sourceArtifactId: artifactId, interactive: true, select: true,
    });
    setRun(v);
    setRunId(v.id);
    setDetailStage(null);
    setState(await api.presentState(token));
    return v;
  };
  const beginFrom = (artifactId: string, kind: ArtifactKind) => guarded(async () => { await newAdventure(artifactId, kind); setStartOpen(false); });
  const beginFromText = (text: string) => guarded(async () => {
    const ses = await api.sourceText(text);
    if (ses.source) await newAdventure(ses.source.id, 'text');
    setStartOpen(false);
  });
  const beginFromFile = (file: File) => guarded(async () => {
    const r = await api.desktopUpload(file);
    const up = r.session.uploads.find((u) => u.id === r.uploadId);
    if (up) await newAdventure(up.artifact.id, 'image');
    setStartOpen(false);
  });
  /** Take the current run off the projector (it stays in the run list) and return to the title screen. */
  const clearProjector = () => guarded(async () => {
    await api.selectRun(null, false);
    setRun(null);
    setRunId(null);
    setDetailStage(null);
    setTwist('');
    setState(await api.presentState(token));
  });
  const startChooser = startOpen && isHost ? <AdventureStart busy={busy} onPick={beginFrom} onText={beginFromText} onFile={beginFromFile} onClose={() => setStartOpen(false)} /> : null;

  // When the host moves the stage, the projector follows again.
  useEffect(() => setDetailStage(null), [state?.currentStage, state?.compare]);

  // ← / → flip through REVEALED stages locally; Esc returns to the host's stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state?.hasRun) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
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
        {isHost && (
          <button type="button" className="pbtn mt-[4vh]" style={{ fontSize: 'clamp(12px, 1.2vw, 22px)' }} onClick={() => setStartOpen(true)}>
            ✨ Start an adventure
          </button>
        )}
        {actionError && <p className="mt-3 text-sm text-red-300">{actionError}</p>}
        {startChooser}
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

  // Adventure: the chosen action applies to what is ON SCREEN. At the tip of an interactive run it extends
  // that run; anywhere else (an earlier step, or a preset run) it branches into a new adventure from there.
  const onScreen = state.compare ? null : (detail ?? (current?.revealed && current.artifact ? current : null));
  const runIdle = !!run && ['ready', 'paused', 'completed'].includes(run.status) && run.currentStepIndex >= run.steps.length;
  const atTip = !!run?.interactive && !!onScreen && onScreen.stage === stages.length - 1 && runIdle;
  const actions = onScreen ? NEXT_ACTIONS[onScreen.kind] : [];
  const choose = (type: StepType) => guarded(async () => {
    if (!onScreen?.artifact) return;
    const target = atTip && run ? run.id : (await newAdventure(onScreen.artifact.id, onScreen.kind)).id;
    setRun(await api.appendStep(target, type, { twist: twist.trim() || undefined, instructionSet: advSet, modelId: advModels[type] || undefined }));
    setTwist('');
    setDetailStage(null);
  });

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

      <div ref={bottomRef} className="relative z-30">
      {/* host-only controls: present only when this browser holds the host cookie */}
      {isHost && (
        <div
          className={cx(
            'relative z-30 bg-[#0a0a0a]/95 px-[2vw] transition-opacity duration-300',
            showControls || pinned || busy || run?.interactive ? 'opacity-100' : 'pointer-events-none opacity-0',
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
            <button
              type="button"
              className="pbtn pbtn-danger"
              disabled={busy || run?.status === 'running'}
              title="Take this run off the projector and return to the title screen. The run stays in the run list."
              onClick={() => void clearProjector()}
            >
              ⏏ Clear screen
            </button>

            <span className="ml-[1.5vw] tracking-widest text-neutral-500 uppercase">Run</span>
            {run ? (
              (['start', 'pause', 'resume', 'next', 'stop', 'retry'] as RunAction[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={cx('pbtn', a === 'stop' && 'pbtn-danger')}
                  // an adventure with no pending step has nothing to start; its actions live in the row below
                  disabled={busy || !ALLOWED_ACTIONS[run.status].includes(a) || (!!run.interactive && a !== 'stop' && a !== 'pause' && a !== 'retry' && run.currentStepIndex >= run.steps.length)}
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
          {/* adventure: pick the next action for whatever is on screen, as many times as you like */}
          <div className="flex flex-wrap items-center gap-[0.5vw] pb-[0.8vh]" style={{ fontSize: 'clamp(9px, 0.85vw, 15px)' }}>
            <span className="tracking-widest text-neutral-500 uppercase">Adventure</span>
            <button type="button" className="pbtn" disabled={busy} onClick={() => setStartOpen(true)}>✨ New…</button>
            {onScreen && actions.length > 0 && (
              <>
                <span className="ml-[1vw] text-neutral-500">next:</span>
                {actions.map((t) => {
                  const options = (models?.models ?? []).filter((m) => m.stepTypes.includes(t) && (m.favorite || m.id === advModels[t]));
                  const chosen = advModels[t] ?? '';
                  return (
                    <span key={t} className="inline-flex items-stretch">
                      <button type="button" className="pbtn pbtn-go rounded-r-none" disabled={busy || run?.status === 'running'} onClick={() => void choose(t)}>
                        {ACTION_LABEL[t]}
                      </button>
                      <select
                        value={chosen}
                        title={`Model for "${ACTION_LABEL[t]}"`}
                        onChange={(e) => {
                          if (e.target.value !== '__other') return pickModel(t, e.target.value);
                          const id = window.prompt('Model ID (checked against the catalog when the step is added):', chosen)?.trim();
                          if (id) pickModel(t, id);
                        }}
                        className="max-w-[11vw] rounded-r border border-l-0 border-sky-800 bg-neutral-900 px-[0.3vw] text-neutral-300"
                      >
                        <option value="">fastest · {FASTEST_MODELS[t].split('/').pop()}</option>
                        {options.filter((m) => m.id !== FASTEST_MODELS[t]).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id.split('/').slice(-1)[0]}{m.testState === 'failed' ? ' (failed test)' : m.testState === 'catalog-only' ? ' (untested)' : ''}
                          </option>
                        ))}
                        {chosen && !options.some((m) => m.id === chosen) && <option value={chosen}>{chosen}</option>}
                        <option value="__other">other…</option>
                      </select>
                    </span>
                  );
                })}
                <select
                  value={advSet}
                  onChange={(e) => setAdvSet(e.target.value)}
                  title="Instruction set used for the next action"
                  className="rounded border border-neutral-700 bg-neutral-900 px-[0.4vw] py-[0.45vh] text-neutral-100"
                >
                  {INSTRUCTION_SETS.map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
                <input
                  value={twist}
                  onChange={(e) => setTwist(e.target.value.slice(0, 500))}
                  placeholder="optional twist, e.g. as a watercolour"
                  className="min-w-[14vw] flex-1 rounded border border-neutral-700 bg-neutral-900 px-[0.6vw] py-[0.45vh] text-neutral-100 placeholder:text-neutral-600"
                />
                {!atTip && <span className="text-sky-300">starts a new branch from this step</span>}
              </>
            )}
            {onScreen?.kind === 'video' && <span className="ml-[1vw] text-neutral-400">A video ends this path. Open an earlier step below to branch from it.</span>}
            {run?.status === 'running' && <span className="ml-[1vw] animate-pulse text-sky-300">working…</span>}
          </div>
        </div>
      )}

      {/* step bar: always visible, above the detail view, for flipping through revealed steps */}
      <div className="relative z-30 flex items-stretch gap-[0.5vw] overflow-x-auto bg-[#0a0a0a] px-[2vw] pt-[0.8vh] pb-[1.6vh]">
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
              // long adventures scroll sideways: keep the step being shown in view
              ref={isViewing ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
              onClick={() => setDetailStage(detail?.stage === s.stage ? null : s.stage)}
              title={s.revealed ? `${s.label} — view with its exact instruction (←/→ to flip, Esc to return)` : 'not revealed yet'}
              className={cx('min-w-[7vw] flex-1 truncate rounded px-[0.4vw] py-[0.6vh] text-center transition-colors', tone, isViewing && 'ring-2 ring-sky-400', s.revealed && 'cursor-pointer')}
              style={{ fontSize: 'clamp(9px, 0.85vw, 16px)' }}
            >
              {s.stage === 0 ? 'Start' : `${s.stage} · ${s.label}`}
            </button>
          );
        })}
      </div>
      </div>

      {startChooser}

      {/* viewer-local detail overlay: only ever shows a revealed stage */}
      {detail && detail.artifact && (
        <div
          className="absolute inset-x-0 top-0 z-20 flex flex-col bg-[#050505] px-[3vw] pt-[3vh] pb-[1vh]"
          style={{ bottom: bottomH }} // measured: clears the step bar and any control rows
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
