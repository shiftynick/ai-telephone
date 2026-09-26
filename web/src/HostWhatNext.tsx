import { useEffect, useState } from 'react';
import { STEP_TYPES, type ArtifactKind, type ArtifactView, type ModelsView, type RunView } from '../../shared/types.ts';
import { api, type SessionView } from './api.ts';
import { WhatNextPanel, startAdventure, stepOptions, useAdventureSettings } from './Adventure.tsx';
import { Section } from './util.tsx';

type Choice = { stage: number; kind: ArtifactKind; artifact: ArtifactView; label: string };

/**
 * The projector's "What next?" controls on the host console, so the whole game can be driven from here
 * without reaching for the projector. It follows what the projector shows (the selected run's current stage);
 * pick another step to branch from there instead.
 */
export function HostWhatNext({ session, openRun, models, onChanged, onError }: {
  session: SessionView | null;
  openRun: RunView | null;
  models: ModelsView | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const s = useAdventureSettings();
  const [selected, setSelected] = useState<RunView | null>(null);
  const [from, setFrom] = useState<number | null>(null); // null = follow the projector
  const [busy, setBusy] = useState(false);
  const selId = session?.selectedRunId ?? null;

  // the projector's run: reuse the opened run when it is the same one, otherwise fetch it
  useEffect(() => {
    if (!selId) return setSelected(null);
    if (openRun?.id === selId) return setSelected(openRun);
    let alive = true;
    api.run(selId).then((v) => alive && setSelected(v), () => {});
    return () => { alive = false; };
  }, [selId, openRun]);
  useEffect(() => setFrom(null), [selId]);

  const choices: Choice[] = selected
    ? [
        { stage: 0, kind: selected.source.kind, artifact: selected.source, label: 'Start' },
        ...selected.steps.flatMap((st) => (st.artifact ? [{ stage: st.index + 1, kind: st.artifact.kind, artifact: st.artifact, label: `${st.index + 1} · ${STEP_TYPES[st.definition.type].label}` }] : [])),
      ]
    : [];
  const follow = session?.currentStage ?? 0;
  const stageNum = from ?? follow;
  const onScreen = choices.find((c) => c.stage === stageNum) ?? choices[choices.length - 1] ?? null;
  const runIdle = !!selected && ['ready', 'paused', 'completed'].includes(selected.status) && selected.currentStepIndex >= selected.steps.length;
  const atTip = !!selected?.interactive && !!onScreen && onScreen.stage === selected.steps.length && runIdle;

  const go = async (type: Parameters<typeof stepOptions>[1], game?: Parameters<typeof stepOptions>[2]) => {
    if (!onScreen) return;
    setBusy(true);
    try {
      const target = atTip && selected ? selected.id : (await startAdventure(onScreen.artifact.id, onScreen.kind)).id;
      await api.appendStep(target, type, stepOptions(s, type, game));
      s.setTwist('');
      s.setPick(null);
      setFrom(null);
      onChanged();
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const startFromSource = async () => {
    const src = session?.source;
    if (!src || (src.kind !== 'image' && src.kind !== 'text')) return;
    setBusy(true);
    try {
      await startAdventure(src.id, src.kind);
      onChanged();
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="What next"
      right={
        selected && choices.length > 0 ? (
          <select
            className="inp !w-auto py-0.5 text-xs"
            value={from === null ? '' : String(from)}
            onChange={(e) => setFrom(e.target.value === '' ? null : Number(e.target.value))}
            title="Which step the next action starts from"
          >
            <option value="">follow the projector ({follow === 0 ? 'start' : `step ${follow}`})</option>
            {choices.map((c) => (
              <option key={c.stage} value={c.stage}>from {c.label}</option>
            ))}
          </select>
        ) : undefined
      }
    >
      {!selected ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-400">
          <span>Nothing is on the projector yet.</span>
          {session?.source && (session.source.kind === 'image' || session.source.kind === 'text') && (
            <button type="button" className="btn btn-primary btn-xs" disabled={busy} onClick={() => void startFromSource()}>
              ✨ Start an adventure from the current source
            </button>
          )}
        </div>
      ) : !onScreen ? (
        <div className="text-sm text-neutral-400">This run has no results yet.</div>
      ) : (
        <WhatNextPanel inline onScreen={onScreen} atTip={atTip} working={selected.status === 'running'} busy={busy} models={models} s={s} onGo={(t, g) => void go(t, g)} />
      )}
    </Section>
  );
}
