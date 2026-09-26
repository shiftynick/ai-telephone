import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FASTEST_MODELS, INSTRUCTION_SETS, KEYFRAME_MODELS, MAX_KEYFRAMES, PIKAFRAMES, NEXT_ACTIONS, PRESET_SCHEMA_VERSION, keyframesCount, type ModelsView, type ArtifactKind, type ArtifactView, type PresentStage, type PresentState, type RunView, type StepType , WORD_GAMES, WORD_GAME_IDS, textForm, type WordGame , SPEECH_TONES } from '../../shared/types.ts';
import { ALLOWED_ACTIONS, ApiError, api, mediaUrl, type RevealAction, type RunAction, type SourceCandidate } from './api.ts';
import { cx, fmtDuration, fmtMoney } from './util.tsx';
import { WaitingStage, useSoundtrack } from './waiting.tsx';
import { ACTION_LABEL, WhatNextPanel, stepOptions, useAdventureSettings } from './Adventure.tsx';

function VideoStage({ src, poster, autoPlay }: { src: string; poster?: string; autoPlay?: boolean }) {
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
        // slideshow only: browsers allow autoplay when muted
        autoPlay={autoPlay}
        muted={autoPlay}
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

// Stage text at the usual size (clamp(20px, 2.8vw, 64px)), shrunk just enough that long
// descriptions fit the stage height instead of overflowing it.
function FitText({ text }: { text: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const para = useRef<HTMLParagraphElement | null>(null);
  useLayoutEffect(() => {
    const b = box.current, p = para.current;
    if (!b || !p) return;
    const fit = () => {
      const max = Math.min(64, Math.max(20, window.innerWidth * 0.028));
      const room = b.clientHeight * 0.94;
      p.style.maxWidth = `${max * 36}px`; // ~70ch at full size; stays put as the font shrinks, so long text wraps wider
      const fits = (px: number) => { p.style.fontSize = `${px}px`; return p.offsetHeight <= room; };
      if (fits(max)) return;
      let lo = 8, hi = max; // binary search the largest size that fits
      while (hi - lo > 0.5) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
      fits(lo);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={box} className="fade-in flex h-full w-full items-center justify-center overflow-hidden px-[4vw]">
      <p ref={para} className="text-center leading-[1.45] text-neutral-100">
        {text}
      </p>
    </div>
  );
}

/** Speech on the projector: a big live frequency ring drawn from the playing audio. */
function AudioStage({ src, autoPlay }: { src: string; autoPlay?: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const a = audio.current, c = canvas.current;
    if (!a || !c) return;
    let ctx: AudioContext | null = null, analyser: AnalyserNode | null = null, raf = 0;
    const setup = () => {
      if (ctx) return;
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaElementSource(a).connect(analyser);
      analyser.connect(ctx.destination);
    };
    const bins = new Uint8Array(128);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const g = c.getContext('2d')!;
      const w = (c.width = c.clientWidth * devicePixelRatio), h = (c.height = c.clientHeight * devicePixelRatio);
      g.clearRect(0, 0, w, h);
      if (analyser) analyser.getByteFrequencyData(bins); else bins.fill(0);
      const r0 = Math.min(w, h) * 0.22, n = 96;
      g.translate(w / 2, h / 2);
      for (let i = 0; i < n; i++) {
        const v = bins[Math.floor((i / n) * 96)] / 255;
        const len = r0 * 0.08 + v * r0 * 0.9;
        g.rotate((Math.PI * 2) / n);
        g.fillStyle = `hsla(${190 + v * 140}, 90%, ${55 + v * 20}%, ${0.35 + v * 0.65})`;
        g.fillRect(-Math.max(2, r0 * 0.02), r0, Math.max(4, r0 * 0.04), len);
      }
    };
    const onPlay = () => { setup(); void ctx?.resume(); setPlaying(true); };
    const onPause = () => setPlaying(false);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    draw();
    return () => {
      cancelAnimationFrame(raf);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.pause();
      void ctx?.close();
    };
  }, [src]);
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      <button
        type="button"
        onClick={() => (audio.current?.paused ? void audio.current.play() : audio.current?.pause())}
        aria-label={playing ? 'Pause speech' : 'Play speech'}
        className="relative flex items-center justify-center rounded-full bg-white/90 text-black shadow-lg"
        style={{ width: '12vmin', height: '12vmin', fontSize: '4.5vmin' }}
      >
        {playing ? '❚❚' : <span style={{ marginLeft: '0.8vmin' }}>▶</span>}
      </button>
      <audio ref={audio} src={src} autoPlay={autoPlay} preload="auto" />
    </div>
  );
}

function StageArtifact({ a, token, label, autoPlay }: { a: ArtifactView; token: string; label?: string; autoPlay?: boolean }) {
  if (a.kind === 'text') return <FitText text={a.text ?? ''} />;
  if (a.kind === 'video') return <VideoStage src={mediaUrl(a.id, token)} autoPlay={autoPlay} />;
  if (a.kind === 'audio') return <AudioStage src={mediaUrl(a.id, token)} autoPlay={autoPlay} />;
  return (
    <img
      key={a.id}
      src={mediaUrl(a.id, token)}
      alt={label ?? 'stage artifact'}
      className="fade-in h-full w-full object-contain"
    />
  );
}

const SPEEDS = [0.3, 0.5, 1, 2, 3, 5, 8];
type SlideFilter = 'all' | 'image' | 'text';


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

/** One glyph per step type, for the step strip. */
const STAGE_ICON: Record<StepType, string> = {
  image_to_text: '📝', text_to_image: '🎨', text_to_text: '🔁', image_to_video: '🎬', text_to_video: '🎥',
  text_to_svg: '✏️', image_to_svg: '✏️', text_to_ascii: '⌨️', text_to_code_image: '🧊', text_to_code_video: '🎞️',
  text_to_audio: '🔊', audio_to_text: '👂',
};
const stageIcon = (s: PresentStage) => (s.type ? STAGE_ICON[s.type] : s.kind === 'text' ? '✍️' : '📷');
const scoreOf = (s?: PresentStage | null): number | null =>
  s?.resemblance && (s.resemblance.status === 'done' || s.resemblance.status === 'carried') ? s.resemblance.score : null;
/** 0 = hot (orange-red, drifted away) … 100 = cool cyan (still the original) */
const scoreColor = (v: number) => `hsl(${Math.round(8 + v * 1.8)}, 85%, 60%)`;

/** The resemblance meter: how much of the ORIGINAL survives in the stage on screen, plus the drift so far. */
function Meter({ stages, shown }: { stages: PresentStage[]; shown: PresentStage | null }) {
  const pts = stages
    .filter((s) => s.revealed)
    .map((s) => ({ stage: s.stage, v: scoreOf(s) }))
    .filter((p): p is { stage: number; v: number } => p.v !== null);
  const r = shown?.resemblance;
  const v = scoreOf(shown);
  if (!shown || !r) return null;
  const W = 240, H = 48, last = Math.max(1, stages.length - 1);
  const x = (st: number) => 5 + (st / last) * (W - 10);
  const y = (val: number) => H - 5 - (val / 100) * (H - 10);
  const note = r.status === 'carried' ? 'spoken aloud: keeps what its text kept' : r.lost && !/^nothing/i.test(r.lost) ? `lost: ${r.lost}` : null;
  return (
    <div className="text-right" style={{ width: 'clamp(170px, 18vw, 360px)' }}>
      <div className="tracking-[0.22em] text-neutral-500 uppercase" style={{ fontSize: 'clamp(8px, 0.7vw, 13px)' }}>resemblance to original</div>
      <div className="mt-[0.3vh] leading-none" title={r.aspects ? Object.entries(r.aspects).map(([k, n]) => `${k} ${n}`).join(' · ') : r.error}>
        {r.status === 'scoring' ? (
          <span className="animate-pulse text-neutral-500" style={{ fontSize: 'clamp(14px, 1.6vw, 30px)' }}>judging…</span>
        ) : v !== null ? (
          <span className="font-semibold tabular-nums transition-colors" style={{ fontSize: 'clamp(26px, 3.4vw, 64px)', color: scoreColor(v) }}>{v}%</span>
        ) : (
          <span className="text-neutral-600" style={{ fontSize: 'clamp(12px, 1.2vw, 22px)' }}>no score</span>
        )}
      </div>
      {pts.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-[0.6vh] h-auto w-full overflow-visible">
          <line x1={5} x2={W - 5} y1={y(100)} y2={y(100)} stroke="rgba(255,255,255,.08)" />
          <polyline points={pts.map((p) => `${x(p.stage)},${y(p.v)}`).join(' ')} fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="1.5" />
          {pts.map((p) => (
            <circle key={p.stage} cx={x(p.stage)} cy={y(p.v)} r={p.stage === shown.stage ? 4.5 : 2.6} fill={scoreColor(p.v)} stroke={p.stage === shown.stage ? '#fff' : 'none'} strokeWidth="1.5" />
          ))}
        </svg>
      )}
      {note && <div className="mt-[0.3vh] truncate text-neutral-400 italic" style={{ fontSize: 'clamp(9px, 0.85vw, 16px)' }}>{note}</div>}
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
  // adventure settings (shared with the host console's What next panel)
  const adv = useAdventureSettings();
  const [models, setModels] = useState<ModelsView | null>(null);
  useEffect(() => {
    if (!isHost) return;
    let alive = true;
    api.models().then((m) => alive && setModels(m), () => {});
    return () => { alive = false; };
  }, [isHost]);
  // Autoplay: a viewer-local slideshow over the REVEALED stages. Nothing is sent to the server.
  const [autoOn, setAutoOn] = useState(false);
  const [autoFilter, setAutoFilter] = useState<SlideFilter>(() => (localStorage.getItem('tele.autoFilter') as SlideFilter) || 'image');
  const [autoSec, setAutoSec] = useState(() => Number(localStorage.getItem('tele.autoSec')) || 2);
  const [advOpen, setAdvOpen] = useState(false); // the "What next?" panel, opened by hand
  const [advClosed, setAdvClosed] = useState(false); // closed by hand: an idle adventure no longer pops it open
  const [menuOpen, setMenuOpen] = useState(false); // the ⋯ menu in the dock
  const [muted, setMuted] = useState(() => localStorage.getItem('tele.muted') === '1');
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripH, setStripH] = useState(0);

  // The detail view and the floating dock sit just above the step strip, whatever its height.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStripH(el.offsetHeight));
    ro.observe(el);
    setStripH(el.offsetHeight);
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
    setAdvClosed(false);
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
    adv.setTwist('');
    setState(await api.presentState(token));
  });
  const startChooser = startOpen && isHost ? <AdventureStart busy={busy} onPick={beginFrom} onText={beginFromText} onFile={beginFromFile} onClose={() => setStartOpen(false)} /> : null;

  // When the host moves the stage, the projector follows again.
  const autoRef = useRef(false);
  autoRef.current = autoOn;
  useEffect(() => { if (!autoRef.current) setDetailStage(null); }, [state?.currentStage, state?.compare]);

  const slides = (state?.stages ?? []).filter((s) => s.revealed && s.artifact && (autoFilter === 'all' || s.kind === autoFilter));
  const slidesKey = slides.map((s) => s.stage).join(',');
  useEffect(() => {
    if (!autoOn) return;
    if (!slides.length) return setAutoOn(false);
    const at = slides.find((s) => s.stage === detailStage);
    const next = (slides.find((s) => s.stage > (detailStage ?? -1)) ?? slides[0]).stage;
    // a video gets at least its own length; everything else the chosen speed
    const dwell = at ? Math.max(autoSec, at.kind === 'video' || at.kind === 'audio' ? (at.artifact?.durationSec ?? 0) : 0) * 1000 : 0;
    const t = setTimeout(() => setDetailStage(next), dwell);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, autoSec, slidesKey, detailStage]);
  // Fast speeds only look right when the images are already in the browser cache.
  useEffect(() => {
    if (!autoOn) return;
    for (const s of slides) if (s.kind === 'image' && s.artifact) new Image().src = mediaUrl(s.artifact.id, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, slidesKey, token]);
  const stopAuto = () => { setAutoOn(false); setDetailStage(null); };
  const speed = (dir: -1 | 1) => setAutoSec((cur) => {
    const i = SPEEDS.indexOf(cur);
    const v = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) - dir))]; // faster = shorter dwell
    localStorage.setItem('tele.autoSec', String(v));
    return v;
  });

  // ← / → flip through REVEALED stages locally; Esc returns to the host's stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state?.hasRun) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') { setMenuOpen(false); setAdvOpen(false); setAdvClosed(true); adv.setPick(null); return stopAuto(); }
      if (e.key === ' ') { e.preventDefault(); return autoOn ? stopAuto() : setAutoOn(true); }
      if (e.key === '+' || e.key === '=') return speed(1);
      if (e.key === '-') return speed(-1);
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
  }, [state, detailStage, isHost, reveal, autoOn]);

  const running = state?.stages.some((s) => s.status === 'running');
  // the soundtrack loops while a step generates and plays a jingle each time one lands
  const soundOn = useSoundtrack(!!running, state?.stages.filter((s) => s.status === 'done').length ?? 0, muted);
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
  const choose = (type: StepType, game?: WordGame) => guarded(async () => {
    if (!onScreen?.artifact) return;
    const target = atTip && run ? run.id : (await newAdventure(onScreen.artifact.id, onScreen.kind)).id;
    setRun(await api.appendStep(target, type, stepOptions(adv, type, game)));
    adv.setTwist('');
    adv.setPick(null);
    setDetailStage(null);
  });

  const elapsedOf = (s: PresentStage) => (s.startedAt ? Math.max(0, Math.floor((Date.now() - offset - s.startedAt) / 1000)) : 0);

  // Run control collapses to ONE contextual button (plus Next step and Stop).
  const allowed = (a: RunAction) =>
    !!run && ALLOWED_ACTIONS[run.status].includes(a) &&
    // an adventure with no pending step has nothing to start; its actions live in the What next panel
    !(run.interactive && a !== 'stop' && a !== 'pause' && a !== 'retry' && run.currentStepIndex >= run.steps.length);
  const primary: { a: RunAction; label: string } | null = !run ? null
    : run.status === 'running' ? { a: 'pause', label: '⏸ Pause' }
    : run.status === 'failed' ? { a: 'retry', label: '↻ Retry' }
    : run.status === 'paused' ? { a: 'resume', label: '▶ Resume' }
    : run.status === 'ready' ? { a: 'start', label: '▶ Start' }
    : null;
  const shown = detail ?? (state.compare ? finalRevealed : current);
  // an idle adventure opens the panel by itself, unless the host closed it; it can always be closed
  const panelShown = isHost && !!onScreen && (advOpen || (!!run?.interactive && runIdle && !advClosed));
  const closePanel = () => { setAdvOpen(false); setAdvClosed(true); adv.setPick(null); };
  const dockShown = showControls || pinned || busy || menuOpen || panelShown;
  const chip = 'rounded-lg px-[0.7vw] py-[0.55vh] transition-colors disabled:cursor-not-allowed disabled:opacity-35';
  const ghost = `${chip} text-neutral-200 hover:bg-white/10`;
  const divider = <span className="mx-[0.3vw] h-[2.4vh] w-px bg-white/10" />;

  return (
    <div className="relative flex h-full flex-col bg-[#0a0a0a] text-neutral-100">
      {/* top chrome: what is on screen (left), how much of the original survives (right) */}
      <div className="flex items-start justify-between gap-[2vw] px-[2vw] pt-[2vh]">
        <div className="min-w-0">
          <div className="font-medium text-neutral-200" style={{ fontSize: 'clamp(13px, 1.5vw, 26px)' }}>
            {state.compare ? 'Start vs final' : label}
          </div>
          <div className="font-mono text-neutral-500" style={{ fontSize: 'clamp(10px, 0.9vw, 16px)' }}>
            {state.compare ? `${total} transformations` : (current.modelId ?? '')}
          </div>
        </div>
        <div className="flex items-start gap-[1.2vw]">
          {state.replay && (
            <div className="rounded border border-amber-700 px-[0.8vw] py-[0.3vh] tracking-widest text-amber-300 uppercase" style={{ fontSize: 'clamp(9px, 0.8vw, 15px)' }}>
              Replay
            </div>
          )}
          <Meter stages={stages} shown={shown} />
        </div>
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
                  {scoreOf(s) !== null && name === 'Final' && <span className="ml-[0.6vw] tabular-nums" style={{ color: scoreColor(scoreOf(s)!) }}>{scoreOf(s)}%</span>}
                </div>
                <div className="min-h-0 flex-1">
                  {s?.artifact ? <StageArtifact key={s.artifact.id} a={s.artifact} token={token} label={name} /> : <div className="h-full" />}
                </div>
              </div>
            ))}
          </div>
        ) : current.revealed && current.artifact ? (
          runningStage && runningStage.stage > current.stage ? (
            // the next step is generating: show what it is working from next to the waiting card
            <div className="grid h-full grid-cols-[1.35fr_1fr] gap-[2.5vw]">
              <div className="flex min-h-0 flex-col">
                <div className="mb-[1vh] tracking-[0.2em] text-neutral-500 uppercase" style={{ fontSize: 'clamp(9px, 0.8vw, 15px)' }}>
                  {runningStage.stage === current.stage + 1 ? 'what it’s working from' : 'on screen'} · {current.stage === 0 ? 'the start' : `step ${current.stage}`}
                </div>
                <div className="min-h-0 flex-1 opacity-90">
                  <StageArtifact key={current.artifact.id} a={current.artifact} token={token} label={label} />
                </div>
              </div>
              <WaitingStage compact stage={runningStage} elapsedSec={elapsedOf(runningStage)} icon={stageIcon(runningStage)} />
            </div>
          ) : (
            <StageArtifact key={current.artifact.id} a={current.artifact} token={token} label={label} />
          )
        ) : runningStage ? (
          <WaitingStage stage={runningStage} elapsedSec={elapsedOf(runningStage)} icon={stageIcon(runningStage)} />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-700" style={{ fontSize: 'clamp(16px, 2vw, 36px)' }}>
            ·
          </div>
        )}
      </div>

      {/* step strip: always visible. One chip per stage: icon, number, and a bar coloured by its resemblance. */}
      <div ref={stripRef} className="relative z-30 flex items-stretch justify-center gap-[0.35vw] overflow-x-auto bg-[#0a0a0a] px-[2vw] pt-[0.6vh] pb-[1.4vh]">
        <button
          type="button"
          className={cx('flex shrink-0 flex-col items-center justify-center rounded-lg px-[0.7vw] text-neutral-300 hover:bg-white/10 disabled:opacity-30', autoOn && 'bg-sky-950 text-sky-200')}
          disabled={!autoOn && slides.length < 2}
          aria-label={autoOn ? 'Stop autoplay' : 'Autoplay'}
          title={`Autoplay the revealed ${autoFilter === 'all' ? 'steps' : `${autoFilter} steps`} (Space) · ${autoSec}s each (−/+). Local to this window.`}
          onClick={() => (autoOn ? stopAuto() : setAutoOn(true))}
          style={{ fontSize: 'clamp(9px, 0.8vw, 15px)' }}
        >
          <span style={{ fontSize: 'clamp(12px, 1.1vw, 20px)' }}>{autoOn ? '⏸' : '▶'}</span>
          <span className="font-mono text-neutral-500">{autoSec}s</span>
        </button>
        {stages.map((s) => {
          const isHostStage = s.stage === state.currentStage && !state.compare;
          const isViewing = detail ? detail.stage === s.stage : isHostStage;
          const v = s.revealed ? scoreOf(s) : null;
          return (
            <button
              key={s.stage}
              type="button"
              disabled={!s.revealed}
              // long runs scroll sideways: keep the step being shown in view
              ref={isViewing ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
              onClick={() => { setAutoOn(false); setDetailStage(detail?.stage === s.stage ? null : s.stage); }}
              title={s.revealed ? `${s.stage === 0 ? 'Start' : `${s.stage} · ${s.label}`}${s.modelId ? ` · ${s.modelId}` : ''}${v !== null ? ` · ${v}% of the original` : ''} (←/→ to flip, Esc to return)` : s.status === 'running' ? 'generating…' : 'not revealed yet'}
              className={cx(
                'relative flex max-w-[5.5vw] min-w-[3.2vw] flex-1 flex-col items-center rounded-lg px-[0.3vw] pt-[0.5vh] pb-[1vh] transition-colors',
                s.revealed ? 'cursor-pointer bg-white/[0.04] hover:bg-white/10' : 'bg-transparent',
                isViewing && 'bg-white/15 ring-1 ring-white/60',
                s.status === 'running' && 'animate-pulse bg-sky-950/60',
                s.status === 'failed' && 'bg-red-950/60',
              )}
            >
              <span className={cx(!s.revealed && 'opacity-25 grayscale')} style={{ fontSize: 'clamp(12px, 1.15vw, 22px)' }}>{stageIcon(s)}</span>
              <span className="font-mono text-neutral-500" style={{ fontSize: 'clamp(8px, 0.62vw, 12px)' }}>{s.stage === 0 ? 'start' : s.stage}</span>
              <span className="absolute inset-x-[18%] bottom-[0.45vh] h-[3px] overflow-hidden rounded-full bg-white/10">
                <i className="block h-full rounded-full transition-all duration-700" style={{ width: `${v ?? 0}%`, background: v !== null ? scoreColor(v) : 'transparent' }} />
              </span>
            </button>
          );
        })}
      </div>

      {/* host-only floating controls: present only when this browser holds the host cookie; fade when the mouse rests */}
      {isHost && (
        <div
          className={cx('pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-[0.8vh] px-[2vw] transition-opacity duration-300', dockShown ? 'opacity-100' : 'opacity-0')}
          style={{ bottom: stripH + 6, fontSize: 'clamp(9px, 0.85vw, 15px)' }}
        >
          {actionError && (
            <div className="pointer-events-auto max-w-[80vw] truncate rounded-full bg-red-950/90 px-[1vw] py-[0.4vh] text-red-200" title={actionError}>{actionError}</div>
          )}
          {run?.statusReason && (run.status === 'failed' || run.status === 'paused') && (
            <div className="max-w-[80vw] truncate rounded-full bg-amber-950/80 px-[1vw] py-[0.4vh] text-amber-200" title={run.statusReason}>{run.statusReason}</div>
          )}

          {/* What next? — the shared adventure panel (the host console shows the same one) */}
          {panelShown && onScreen && (
            <WhatNextPanel onScreen={onScreen} atTip={atTip} working={run?.status === 'running'} busy={busy} models={models} s={adv} onGo={(t, g) => void choose(t, g)} onClose={closePanel} className={dockShown ? 'pointer-events-auto' : undefined} />
          )}

          {/* the ⋯ menu: everything that is not needed every few seconds */}
          {menuOpen && (
            <div className={cx('flex flex-wrap items-center justify-center gap-[0.4vw] rounded-2xl border border-white/10 bg-neutral-950/90 px-[0.8vw] py-[0.7vh] shadow-2xl backdrop-blur', dockShown && 'pointer-events-auto')}>
              <button type="button" className={ghost} disabled={busy} onClick={() => { setMenuOpen(false); setStartOpen(true); }}>✨ New adventure…</button>
              <button type="button" className={ghost} disabled={busy} onClick={() => void reveal({ action: 'reset' })}>Hide all</button>
              {divider}
              <span className="text-neutral-500">autoplay</span>
              <select
                value={autoFilter}
                onChange={(e) => { localStorage.setItem('tele.autoFilter', e.target.value); setAutoFilter(e.target.value as SlideFilter); }}
                className="rounded border border-neutral-700 bg-neutral-900 px-[0.3vw] py-[0.2vh] text-neutral-200"
              >
                <option value="image">images only</option>
                <option value="text">text only</option>
                <option value="all">everything</option>
              </select>
              <button type="button" className={ghost} title="Slower (−)" onClick={() => speed(-1)}>−</button>
              <span className="font-mono text-neutral-300">{autoSec}s</span>
              <button type="button" className={ghost} title="Faster (+)" onClick={() => speed(1)}>+</button>
              {divider}
              <button type="button" className={cx(ghost, pinned && 'bg-white/10')} onClick={() => setPinned((p) => !p)}>📌 {pinned ? 'Unpin' : 'Pin'} controls (c)</button>
              <button
                type="button"
                className={cx(chip, 'text-red-300 hover:bg-red-950')}
                disabled={busy || run?.status === 'running'}
                title="Take this run off the projector and return to the title screen. The run stays in the run list."
                onClick={() => { setMenuOpen(false); void clearProjector(); }}
              >
                ⏏ Clear screen
              </button>
            </div>
          )}

          {/* the dock */}
          <div
            className={cx('flex max-w-[96vw] items-center gap-[0.25vw] rounded-2xl border border-white/10 bg-neutral-950/85 px-[0.6vw] py-[0.6vh] shadow-2xl backdrop-blur', dockShown && 'pointer-events-auto')}
            onMouseEnter={() => setShowControls(true)}
          >
            <button type="button" className={ghost} disabled={busy} title="Hide the latest step (←)" aria-label="Hide latest step" onClick={() => void reveal({ action: 'prev' })}>◀</button>
            <button type="button" className={ghost} disabled={busy} title="Reveal the next step (→)" aria-label="Reveal next step" onClick={() => void reveal({ action: 'next' })}>▶</button>
            <button type="button" className={ghost} disabled={busy} title="Reveal everything up to the final step" onClick={() => void reveal({ action: 'final' })}>Final</button>
            <button type="button" className={cx(ghost, state.compare && 'bg-sky-950 text-sky-200')} disabled={busy} title="Show the start and the final step side by side" onClick={() => void reveal({ action: 'compare', on: !state.compare })}>⇆ Compare</button>
            {divider}
            {run ? (
              <>
                {primary && (
                  <button type="button" className={cx(chip, 'bg-sky-600 font-medium text-white hover:bg-sky-500')} disabled={busy || !allowed(primary.a)} onClick={() => void act(primary.a)}>{primary.label}</button>
                )}
                {allowed('next') && <button type="button" className={ghost} disabled={busy} title="Run exactly one step, then pause" onClick={() => void act('next')}>Next step</button>}
                {allowed('stop') && <button type="button" className={cx(chip, 'text-red-300 hover:bg-red-950')} disabled={busy} onClick={() => void act('stop')}>■ Stop</button>}
                <span className="ml-[0.4vw] flex items-center gap-[0.6vw] whitespace-nowrap text-neutral-400">
                  <span className={cx(run.status === 'failed' ? 'text-red-400' : run.status === 'running' ? 'text-sky-300' : 'text-neutral-300')}>{run.status}</span>
                  <span className="font-mono">{Math.min(run.currentStepIndex + (run.status === 'running' ? 1 : 0), run.steps.length)}/{run.steps.length}</span>
                  {run.startedAt && <span className="font-mono">{fmtDuration((run.finishedAt ?? Date.now() - offset) - run.startedAt)}</span>}
                  <span className="font-mono" title={run.costUnknownCount > 0 ? `${run.costUnknownCount} step(s) of unknown cost not included` : undefined}>
                    {fmtMoney(run.costActualUsd + run.costEstimatedUsd)}{run.costUnknownCount > 0 ? '+' : ''}
                  </span>
                </span>
              </>
            ) : (
              <span className="px-[0.5vw] text-neutral-500">no run selected</span>
            )}
            {divider}
            <button
              type="button"
              className={cx(ghost, panelShown && 'bg-sky-950 text-sky-200')}
              disabled={!onScreen}
              title={onScreen ? `Choose what happens next to this ${onScreen.kind} (branches off if it is not the latest step)` : 'Show a step to branch from it'}
              onClick={() => (panelShown ? closePanel() : (setAdvOpen(true), setAdvClosed(false)))}
            >
              ✨ What next?
            </button>
            <button
              type="button"
              className={ghost}
              aria-label={muted ? 'Unmute sound' : 'Mute sound'}
              title={muted ? 'Sound is off: click to turn the waiting music and step jingles on' : 'Mute the waiting music and step jingles'}
              onClick={() => setMuted((m) => { localStorage.setItem('tele.muted', m ? '0' : '1'); return !m; })}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <button type="button" className={cx(ghost, menuOpen && 'bg-white/10')} title="More" onClick={() => setMenuOpen((m) => !m)}>⋯</button>
          </div>
        </div>
      )}

      {/* the browser is holding audio until this window gets a click or key press */}
      {!soundOn && !muted && (
        <div className="pointer-events-none absolute top-[2vh] left-1/2 z-40 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-[1vw] py-[0.5vh] text-neutral-300 backdrop-blur" style={{ fontSize: 'clamp(10px, 0.9vw, 16px)' }}>
          🔈 click anywhere on this window to turn on sound
        </div>
      )}

      {startChooser}

      {/* viewer-local detail overlay: only ever shows a revealed stage */}
      {detail && detail.artifact && (
        <div
          className="absolute inset-x-0 top-0 z-20 flex flex-col bg-[#050505] px-[3vw] pt-[3vh] pb-[1vh]"
          style={{ bottom: stripH }} // measured: clears the step strip
          onClick={stopAuto}
        >
          <div className="mb-[1.5vh] flex items-start gap-[1.5vw]">
            <div className="min-w-0">
              <div className="text-neutral-100" style={{ fontSize: 'clamp(14px, 1.6vw, 28px)' }}>
                {detail.stage === 0 ? `Starting ${detail.kind}` : `Step ${detail.stage} — ${detail.label}`}
              </div>
              <div className="font-mono text-neutral-500" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>{detail.modelId ?? ''}</div>
              <div className="mt-[0.4vh] text-neutral-600" style={{ fontSize: 'clamp(9px, 0.85vw, 15px)' }}>
                {autoOn ? `autoplay ${slides.findIndex((x) => x.stage === detail.stage) + 1}/${slides.length} · ${autoSec}s · Space or Esc to stop` : '←/→ flip · Esc or click to return to the live stage'}
              </div>
            </div>
            <div className="ml-auto"><Meter stages={stages} shown={detail} /></div>
          </div>
          <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
            <StageArtifact key={detail.artifact.id} a={detail.artifact} token={token} autoPlay={autoOn} />
          </div>
          {detail.instruction && !autoOn && (
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
