import { useState } from 'react';
import { STEP_TYPES, type RunView } from '../../shared/types.ts';
import { api, type RevealAction, type SessionView } from './api.ts';
import { Banner, Pill, Section, cx } from './util.tsx';

export default function RevealControls({
  session,
  run,
  onChanged,
  onError,
}: {
  session: SessionView | null;
  run: RunView | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const send = async (action: RevealAction) => {
    setBusy(true);
    try {
      await api.reveal(action);
      onChanged();
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (!session?.selectedRunId)
    return (
      <Section title="Reveal">
        <Banner kind="info">No run is on the projector yet. Use “Show on projector” in the run list.</Banner>
      </Section>
    );

  const selectedIsOpen = run?.id === session.selectedRunId;
  const stages = selectedIsOpen && run
    ? [
        { stage: 0, label: `Starting ${run.source.kind}`, available: true },
        ...run.steps.map((s) => ({
          stage: s.index + 1,
          label: `${s.index + 1}. ${STEP_TYPES[s.definition.type]?.label ?? s.definition.type}`,
          available: !!s.artifact,
        })),
      ]
    : [];

  return (
    <Section
      title="Reveal"
      right={
        <>
          {session.replay && <Pill tone="warn">replay</Pill>}
          <Pill tone={session.autoReveal ? 'ok' : 'neutral'}>auto-reveal {session.autoReveal ? 'on' : 'off'}</Pill>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send({ action: 'auto', on: true })}>
          Live reveal
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            await send({ action: 'auto', on: false });
            await send({ action: 'reset' });
          }}
        >
          Final-result-first
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1 text-xs text-neutral-300">
          <input type="checkbox" checked={session.autoReveal} disabled={busy} onChange={(e) => send({ action: 'auto', on: e.target.checked })} />
          auto-reveal each completed step
        </label>
        <span className="w-2" />
        <button type="button" className="btn btn-xs" disabled={busy} onClick={() => send({ action: 'prev' })}>
          ◀ Prev
        </button>
        <button type="button" className="btn btn-xs" disabled={busy} onClick={() => send({ action: 'next' })}>
          Next ▶
        </button>
        <button type="button" className="btn btn-xs" disabled={busy} onClick={() => send({ action: 'final' })}>
          Reveal final
        </button>
        <button type="button" className="btn btn-xs" disabled={busy} onClick={() => send({ action: 'reset' })}>
          Reset (hide all)
        </button>
        <button
          type="button"
          className="btn btn-xs btn-danger"
          disabled={busy}
          title="Take this run off the projector and show the title screen. The run stays in the run list."
          onClick={async () => {
            setBusy(true);
            try {
              await api.selectRun(null, false);
              onChanged();
            } catch (e) {
              onError(String((e as Error).message));
            } finally {
              setBusy(false);
            }
          }}
        >
          Clear projector
        </button>
        <button
          type="button"
          className={cx('btn btn-xs', session.compare && 'btn-primary')}
          disabled={busy}
          onClick={() => send({ action: 'compare', on: !session.compare })}
        >
          Compare start vs final
        </button>
      </div>

      {stages.length === 0 ? (
        <p className="text-xs text-neutral-500">Open the selected run to see its stage strip.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {stages.map((s) => {
            const revealed = session.revealed.includes(s.stage);
            const current = session.currentStage === s.stage;
            return (
              <button
                key={s.stage}
                type="button"
                disabled={busy || !s.available}
                onClick={() => send({ action: 'show', stage: s.stage })}
                className={cx(
                  'rounded border px-2 py-1 text-[11px]',
                  current ? 'border-sky-500 bg-sky-900/60 text-sky-100' : revealed ? 'border-emerald-800 bg-emerald-950/50 text-emerald-200' : 'border-neutral-800 bg-neutral-900 text-neutral-400',
                  !s.available && 'cursor-not-allowed opacity-40',
                )}
                title={s.available ? (revealed ? 'revealed' : 'not revealed yet') : 'no output yet'}
              >
                {s.label}
                {current ? ' · on screen' : revealed ? ' · revealed' : ''}
              </button>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-neutral-500">
        The projector shows stage {session.currentStage}
        {session.compare ? ' (compare mode: start vs final)' : ''}. Unrevealed stages are never sent to the projector.
      </p>
    </Section>
  );
}
