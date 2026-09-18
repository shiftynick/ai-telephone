import { useMemo, useRef, useState, useEffect } from 'react';
import type { ModelEntry, ModelsView, StepType } from '../../shared/types.ts';
import { Pill, cx } from './util.tsx';

const testTone = (s: ModelEntry['testState']) => (s === 'tested-successfully' ? 'ok' : s === 'failed' ? 'error' : 'neutral');
const testLabel = (s: ModelEntry['testState']) => (s === 'tested-successfully' ? 'tested successfully' : s === 'failed' ? 'failed' : 'catalog-only');

export function modelsFor(models: ModelsView | null, type: StepType): ModelEntry[] {
  return (models?.models ?? []).filter((m) => m.stepTypes.includes(type));
}

export function favoriteFor(models: ModelsView | null, type: StepType): string {
  const list = modelsFor(models, type);
  return list.find((m) => m.favorite)?.id ?? list[0]?.id ?? '';
}

function Entry({ m, active, refreshedAt, onPick }: { m: ModelEntry; active: boolean; refreshedAt: number | null; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cx(
        'w-full rounded border px-2 py-1.5 text-left text-xs',
        active ? 'border-sky-600 bg-sky-950/60' : 'border-neutral-800 bg-neutral-900 hover:bg-neutral-800',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-neutral-100">{m.name}</span>
        <span className="flex shrink-0 gap-1">
          {m.favorite && <Pill tone="accent">favorite</Pill>}
          <Pill tone={testTone(m.testState)}>{testLabel(m.testState)}</Pill>
        </span>
      </div>
      <div className="truncate font-mono text-[11px] text-neutral-400">{m.id}</div>
      <div className="truncate text-[11px] text-neutral-500">
        {m.source}
        {refreshedAt ? ` · catalog refreshed ${new Date(refreshedAt).toLocaleString()}` : ' · catalog never refreshed'}
      </div>
    </button>
  );
}

export default function ModelPicker({
  type,
  value,
  models,
  onChange,
  onRefresh,
  refreshing,
}: {
  type: StepType;
  value: string;
  models: ModelsView | null;
  onChange: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [manual, setManual] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);

  const compatible = useMemo(() => modelsFor(models, type), [models, type]);
  const favorites = compatible.filter((m) => m.favorite);
  const rest = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return compatible
      .filter((m) => !m.favorite)
      .filter((m) => advanced || !m.hiddenByDefault)
      .filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))
      .slice(0, 150);
  }, [compatible, q, advanced]);

  const current = compatible.find((m) => m.id === value) ?? models?.models.find((m) => m.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <label className="lbl">Model</label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-left text-sm hover:bg-neutral-800"
      >
        <span className="min-w-0">
          <span className="block truncate text-neutral-100">{current?.name ?? value ?? '(none)'}</span>
          <span className="block truncate font-mono text-[11px] text-neutral-400">{value || 'choose a model'}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {current && <Pill tone={testTone(current.testState)}>{testLabel(current.testState)}</Pill>}
          <span className="text-neutral-500">▾</span>
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 max-h-96 w-full min-w-80 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-950 p-2 shadow-xl">
          {models?.stale && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded border border-amber-900 bg-amber-950/50 px-2 py-1 text-[11px] text-amber-200">
              <span>
                Stale catalog{models.error ? ` — ${models.error}` : ''}. Shown IDs may be out of date; nothing is substituted automatically.
              </span>
              <button type="button" className="btn btn-xs" disabled={refreshing} onClick={onRefresh}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          )}
          <div className="mb-1 text-[11px] tracking-wide text-neutral-500 uppercase">Favorites</div>
          <div className="space-y-1">
            {favorites.length === 0 && <div className="px-1 text-xs text-neutral-500">No favorites for this step type.</div>}
            {favorites.map((m) => (
              <Entry
                key={m.id}
                m={m}
                active={m.id === value}
                refreshedAt={models?.refreshedAt ?? null}
                onPick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>

          <div className="mt-3 mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] tracking-wide text-neutral-500 uppercase">All compatible models</span>
            <label className="flex items-center gap-1 text-[11px] text-neutral-400">
              <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> advanced
            </label>
          </div>
          <input className="inp mb-1" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="space-y-1">
            {rest.length === 0 && <div className="px-1 text-xs text-neutral-500">No matching models in the catalog.</div>}
            {rest.map((m) => (
              <Entry
                key={m.id}
                m={m}
                active={m.id === value}
                refreshedAt={models?.refreshedAt ?? null}
                onPick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>

          <div className="mt-3 border-t border-neutral-800 pt-2">
            <label className="lbl">Manual model ID</label>
            <div className="mt-1 flex gap-1">
              <input
                className="inp font-mono text-xs"
                placeholder="vendor/model-id"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-xs"
                disabled={!manual.trim()}
                onClick={() => {
                  onChange(manual.trim());
                  setManual('');
                  setOpen(false);
                }}
              >
                Use
              </button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">Manual IDs are checked by the server’s validator like any other model.</p>
          </div>
        </div>
      )}
    </div>
  );
}
