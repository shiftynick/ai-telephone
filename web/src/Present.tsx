import { useEffect, useRef, useState } from 'react';
import type { ArtifactView, PresentStage, PresentState } from '../../shared/types.ts';
import { api, mediaUrl } from './api.ts';
import { cx } from './util.tsx';

function VideoStage({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [src]);
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
  const [detail, setDetail] = useState<PresentStage | null>(null);
  const [tick, setTick] = useState(0);

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
    void load();
    const es = new EventSource(`/api/present/${encodeURIComponent(token)}/events`);
    es.addEventListener('change', () => void load());
    es.addEventListener('open', () => void load());
    const iv = setInterval(() => void load(), 5000); // fallback if SSE is wedged
    return () => {
      alive = false;
      es.close();
      clearInterval(iv);
    };
  }, [token]);

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
        {state.compare ? (
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
                  {s?.artifact ? <StageArtifact a={s.artifact} token={token} label={name} /> : <div className="h-full" />}
                </div>
              </div>
            ))}
          </div>
        ) : current.revealed && current.artifact ? (
          <StageArtifact a={current.artifact} token={token} label={label} />
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

      {/* progress strip */}
      <div className="flex items-center gap-[0.6vw] px-[2vw] pb-[2.2vh]">
        {stages.map((s) => {
          const isCurrent = s.stage === state.currentStage && !state.compare;
          const tone = s.revealed
            ? 'bg-neutral-300'
            : s.status === 'running'
              ? 'bg-sky-600 animate-pulse'
              : s.status === 'done'
                ? 'bg-neutral-600'
                : s.status === 'failed'
                  ? 'bg-red-800'
                  : 'bg-neutral-800';
          return (
            <button
              key={s.stage}
              type="button"
              disabled={!s.revealed}
              onClick={() => setDetail(s)}
              title={s.revealed ? `${s.label} — open details` : ''}
              className={cx('h-[0.9vh] min-h-[4px] flex-1 rounded-full transition-colors', tone, isCurrent && 'ring-2 ring-sky-400', s.revealed && 'cursor-pointer')}
            />
          );
        })}
      </div>

      {/* viewer-local detail overlay: only ever shows a revealed stage */}
      {detail && detail.revealed && detail.artifact && (
        <div className="fixed inset-0 z-20 flex flex-col bg-[#050505] p-[3vw]" onClick={() => setDetail(null)}>
          <div className="mb-[1.5vh] flex items-baseline gap-[1.5vw]">
            <span className="text-neutral-100" style={{ fontSize: 'clamp(14px, 1.6vw, 28px)' }}>
              {detail.stage === 0 ? `Starting ${detail.kind}` : `Step ${detail.stage} — ${detail.label}`}
            </span>
            <span className="font-mono text-neutral-500" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
              {detail.modelId ?? ''}
            </span>
            <span className="ml-auto text-neutral-500" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
              click anywhere to close
            </span>
          </div>
          <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
            <StageArtifact a={detail.artifact} token={token} />
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
