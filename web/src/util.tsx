import { useEffect, useRef, useState } from 'react';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function fmtMoney(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function fmtDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function fmtTime(ts: number | undefined | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtBytes(n: number | undefined) {
  if (!n) return '';
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Re-renders roughly once a second; used for live elapsed timers. */
export function useNow(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

/** Value that only settles after `ms` of quiet. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  const tone = {
    info: 'border-sky-900 bg-sky-950/60 text-sky-200',
    warn: 'border-amber-900 bg-amber-950/50 text-amber-200',
    error: 'border-red-900 bg-red-950/60 text-red-200',
    ok: 'border-emerald-900 bg-emerald-950/50 text-emerald-200',
  }[kind];
  return <div className={cx('rounded-md border px-3 py-2 text-sm', tone)}>{children}</div>;
}

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950/70">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2">
        <h2 className="text-sm font-semibold tracking-wide text-neutral-200 uppercase">{title}</h2>
        <div className="flex items-center gap-2">{right}</div>
      </header>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent'; children: React.ReactNode }) {
  const tones = {
    neutral: 'border-neutral-700 bg-neutral-800 text-neutral-300',
    ok: 'border-emerald-800 bg-emerald-950 text-emerald-300',
    warn: 'border-amber-800 bg-amber-950 text-amber-300',
    error: 'border-red-800 bg-red-950 text-red-300',
    accent: 'border-sky-800 bg-sky-950 text-sky-300',
  };
  return <span className={cx('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] whitespace-nowrap', tones[tone])}>{children}</span>;
}

/** Copy-to-clipboard link text that still works when the clipboard API is unavailable. */
export function CopyText({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded bg-neutral-900 px-2 py-1 font-mono text-xs break-all text-neutral-200">{value}</code>
      <button
        type="button"
        className="btn btn-xs"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 1200);
            },
            () => undefined,
          );
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
