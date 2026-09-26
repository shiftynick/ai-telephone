import { useState } from 'react';
import {
  FASTEST_MODELS, INSTRUCTION_SETS, KEYFRAME_MODELS, MAX_KEYFRAMES, NEXT_ACTIONS, PIKAFRAMES, PRESET_SCHEMA_VERSION, SPEECH_TONES, WORD_GAMES, WORD_GAME_IDS,
  keyframesCount, textForm,
  type ArtifactKind, type ArtifactView, type ModelsView, type RunView, type StepType, type WordGame,
} from '../../shared/types.ts';
import { api } from './api.ts';
import { cx } from './util.tsx';

/**
 * The adventure ("What next?") controls, shared by the projector and the host console so both can drive
 * exactly the same actions: step 1 pick an action (a step type or a word game), step 2 that action's own
 * options, then Go. The instruction set and twist apply to whatever is picked, so they are always shown.
 */

export const ACTION_LABEL: Record<StepType, string> = {
  image_to_text: '📝 Describe it',
  image_to_video: '🎬 Animate it',
  text_to_image: '🎨 Draw it',
  text_to_text: '🔁 Retell it',
  text_to_video: '🎥 Film it',
  text_to_svg: '✏️ Draw it in SVG',
  image_to_svg: '✏️ Trace it in SVG',
  text_to_ascii: '⌨️ ASCII it',
  text_to_code_image: '🧊 Build it in 3D',
  text_to_code_video: '🎞️ Code an animation',
  text_to_audio: '🔊 Say it',
  audio_to_text: '👂 Hear it',
};

export type AdvPick = { type: StepType; game?: WordGame };

/** Adventure settings; model choices and the voice are remembered across reloads (per browser). */
export function useAdventureSettings() {
  const [twist, setTwist] = useState('');
  const [advSet, setAdvSet] = useState('faithful');
  const [advModels, setAdvModels] = useState<Partial<Record<StepType, string>>>(() => {
    try { return JSON.parse(localStorage.getItem('tele.advModels') ?? '{}'); } catch { return {}; }
  });
  const pickModel = (type: StepType, id: string) => setAdvModels((m) => {
    const next = { ...m, [type]: id };
    localStorage.setItem('tele.advModels', JSON.stringify(next));
    return next;
  });
  const [advFrames, setAdvFrames] = useState<number | 'first_last'>(1);
  const [advRef, setAdvRef] = useState<'' | 'previous' | 'first' | 'none'>(''); // '' = whatever the instruction set does
  const [pick, setPick] = useState<AdvPick | null>(null);
  const [advTone, setAdvTone] = useState(''); // speech: one of SPEECH_TONES, '' = plain reading
  const [advVoice, setVoice] = useState(() => localStorage.getItem('tele.advVoice') ?? '');
  const setAdvVoice = (v: string) => { setVoice(v); localStorage.setItem('tele.advVoice', v); };
  return { twist, setTwist, advSet, setAdvSet, advModels, pickModel, advFrames, setAdvFrames, advRef, setAdvRef, pick, setPick, advTone, setAdvTone, advVoice, setAdvVoice };
}
export type AdventureSettings = ReturnType<typeof useAdventureSettings>;

/** What can follow the artifact on screen: step types, plus word games for a text (decoders only when they fit). */
export function nextChoices(onScreen: { kind: ArtifactKind; artifact?: ArtifactView } | null) {
  const actions = onScreen ? NEXT_ACTIONS[onScreen.kind] : [];
  const form = onScreen?.kind === 'text' ? textForm(onScreen.artifact?.text ?? '') : null;
  const games = onScreen?.kind === 'text'
    ? WORD_GAME_IDS.filter((g) => { const f = (WORD_GAMES[g] as { for?: string }).for; return !f || f === form; })
    : [];
  return { actions, games };
}

/** The append-step options for an action under the current settings. */
export function stepOptions(s: AdventureSettings, type: StepType, game?: WordGame) {
  return {
    // speech takes a one-word tone instead of a twist (a longer direction would be read aloud)
    twist: type === 'text_to_audio' ? undefined : s.twist.trim() || undefined,
    tone: type === 'text_to_audio' ? s.advTone : undefined,
    voice: type === 'text_to_audio' ? s.advVoice || undefined : undefined,
    instructionSet: s.advSet,
    game,
    modelId: type === 'image_to_video' && keyframesCount(s.advFrames) > (KEYFRAME_MODELS[s.advModels[type] || FASTEST_MODELS[type]] ?? 1) ? PIKAFRAMES : s.advModels[type] || undefined,
    keyframes: type === 'image_to_video' ? s.advFrames : undefined,
    reference: type === 'text_to_image' && s.advRef ? s.advRef : undefined,
  };
}

/** A fresh interactive run from an artifact, selected on the projector. Free: each chosen action is one call. */
export async function startAdventure(artifactId: string, kind: ArtifactKind): Promise<RunView> {
  await api.reveal({ action: 'auto', on: true }); // an adventure shows every result as it lands
  return api.createRun({
    preset: { schemaVersion: PRESET_SCHEMA_VERSION, name: 'Adventure', startingKind: kind === 'text' ? 'text' : 'image', steps: [] },
    sourceArtifactId: artifactId, interactive: true, select: true,
  });
}

const chip = 'rounded-lg px-[0.7vw] py-[0.55vh] transition-colors disabled:cursor-not-allowed disabled:opacity-35';
const ghost = `${chip} text-neutral-200 hover:bg-white/10`;

/** `inline`: fills its container (the host console) instead of floating over the projector. */
export function WhatNextPanel({ onScreen, atTip, working, busy, models, s, onGo, onClose, className, inline }: {
  onScreen: { stage: number; kind: ArtifactKind; artifact?: ArtifactView };
  atTip: boolean;
  working: boolean;
  busy: boolean;
  models: ModelsView | null;
  s: AdventureSettings;
  onGo: (type: StepType, game?: WordGame) => void;
  onClose?: () => void;
  className?: string;
  inline?: boolean;
}) {
  const { actions, games } = nextChoices(onScreen);
  const pick = s.pick;
            const picked = pick && (pick.game ? games.includes(pick.game) : actions.includes(pick.type)) ? pick : null;
            const modelType: StepType | null = picked ? (picked.game ? 'text_to_text' : picked.type) : null;
            const tile = (key: string, icon: string, name: string, model: string, on: boolean, tone: 'sky' | 'fuchsia', onClick: () => void, title?: string) => (
              <button
                key={key}
                type="button"
                title={title}
                disabled={busy || working}
                onClick={onClick}
                className={cx(
                  'flex min-w-[7.5vw] flex-col items-center rounded-xl border px-[0.9vw] py-[0.8vh] transition-all disabled:opacity-35',
                  tone === 'sky' ? 'border-sky-800/70 bg-sky-950/60 text-sky-100 hover:border-sky-400 hover:bg-sky-900' : 'border-fuchsia-800/60 bg-fuchsia-950/40 text-fuchsia-100 hover:border-fuchsia-400 hover:bg-fuchsia-900/60',
                  on && (tone === 'sky' ? 'scale-[1.04] border-sky-300 bg-sky-800 ring-2 ring-sky-300/60' : 'scale-[1.04] border-fuchsia-300 bg-fuchsia-800/80 ring-2 ring-fuchsia-300/60'),
                  picked && !on && 'opacity-60',
                )}
              >
                <span style={{ fontSize: 'clamp(16px, 1.6vw, 30px)' }}>{icon}</span>
                <span>{name}</span>
                <span className={cx('max-w-[9vw] truncate font-mono', tone === 'sky' ? 'text-sky-300/60' : 'text-fuchsia-300/60')} style={{ fontSize: '0.8em' }}>{model}</span>
              </button>
            );
            const select = (t: { type: StepType; game?: WordGame }) => {
              // clicking the already-selected tile runs it
              if (picked && picked.type === t.type && picked.game === t.game) return void onGo(t.type, t.game);
              s.setPick(t);
            };
            const modelSelect = (t: StepType) => {
              const options = (models?.models ?? []).filter((m) => m.stepTypes.includes(t) && (m.favorite || m.id === s.advModels[t]));
              const chosen = s.advModels[t] ?? '';
              return (
                <label className="flex items-center gap-[0.4vw] text-neutral-400">
                  model
                  <select
                    value={chosen}
                    onChange={(e) => {
                      if (e.target.value !== '__other') return s.pickModel(t, e.target.value);
                      const id = window.prompt('Model ID (checked against the catalog when the step is added):', chosen)?.trim();
                      if (id) s.pickModel(t, id);
                    }}
                    className="max-w-[16vw] rounded border border-neutral-700 bg-neutral-900 px-[0.4vw] py-[0.3vh] text-neutral-100"
                  >
                    <option value="">fastest · {FASTEST_MODELS[t].split('/').pop()}</option>
                    {options.filter((m) => m.id !== FASTEST_MODELS[t]).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name && m.name !== m.id ? m.name : m.id.split('/').slice(-1)[0]}{m.testState === 'failed' ? ' (failed test)' : m.testState === 'catalog-only' ? ' (untested)' : ''}
                      </option>
                    ))}
                    {chosen && !options.some((m) => m.id === chosen) && <option value={chosen}>{chosen}</option>}
                    <option value="__other">other…</option>
                  </select>
                </label>
              );
            };
            const voices = models?.models.find((m) => m.id === (s.advModels.text_to_audio || FASTEST_MODELS.text_to_audio))?.params?.voice ?? [];
            const pickedName = picked ? (picked.game ? `${WORD_GAMES[picked.game].icon} ${WORD_GAMES[picked.game].label}` : ACTION_LABEL[picked.type]) : '';
            return (
              <div className={cx(inline ? 'w-full text-sm' : 'w-[min(1400px,94vw)]', 'rounded-2xl border border-sky-900/50 bg-neutral-950/95 p-[0.9vw] shadow-2xl backdrop-blur', className)}>
                {/* header */}
                <div className="mb-[0.8vh] flex items-center gap-[0.8vw]">
                  <span className="tracking-[0.2em] text-neutral-400 uppercase">What next with this {onScreen.kind}?</span>
                  {!atTip && <span className="rounded-full bg-sky-950 px-[0.6vw] py-[0.2vh] text-sky-300">branches from {onScreen.stage === 0 ? 'the start' : `step ${onScreen.stage}`}</span>}
                  {working && <span className="animate-pulse text-sky-300">working…</span>}
                  {onClose && <button type="button" className={cx(ghost, 'ml-auto')} title="Close (Esc)" aria-label="Close What next" onClick={onClose}>✕</button>}
                </div>

                {onScreen.kind === 'video' ? (
                  <div className="text-neutral-400">A video ends this path. Open an earlier step in the strip to branch from it.</div>
                ) : (
                  <>
                    {/* step 1: what happens next */}
                    <div className="flex flex-wrap gap-[0.5vw]">
                      {actions.map((t) => {
                        const [icon, ...words] = ACTION_LABEL[t].split(' ');
                        return tile(t, icon, words.join(' '), (s.advModels[t] || FASTEST_MODELS[t]).split('/').pop()!, picked?.type === t && !picked.game, 'sky', () => select({ type: t }));
                      })}
                      {games.length > 0 && <span className="mx-[0.2vw] w-px self-stretch bg-white/10" />}
                      {games.map((g) =>
                        tile(g, WORD_GAMES[g].icon, WORD_GAMES[g].label, (s.advModels.text_to_text || FASTEST_MODELS.text_to_text).split('/').pop()!, picked?.game === g, 'fuchsia', () => select({ type: 'text_to_text', game: g }), WORD_GAMES[g].instruction),
                      )}
                    </div>

                    {/* step 2: only the chosen action's options, then Go */}
                    {picked && modelType ? (
                      <div className={cx('mt-[1vh] flex flex-wrap items-center gap-[0.8vw] rounded-xl border px-[0.9vw] py-[0.8vh]', picked.game ? 'border-fuchsia-800/50 bg-fuchsia-950/20' : 'border-sky-800/50 bg-sky-950/30')}>
                        <span className="font-medium text-neutral-100">{pickedName}</span>
                        {modelSelect(modelType)}
                        {picked.type === 'text_to_image' && !picked.game && (
                          <label className="flex items-center gap-[0.4vw] text-neutral-400" title="Also show the model an earlier image of this run so characters and style stay consistent. A deliberate exception to the telephone rule.">
                            reference image
                            <select
                              value={s.advRef}
                              onChange={(e) => s.setAdvRef(e.target.value as typeof s.advRef)}
                              className={cx('rounded border bg-neutral-900 px-[0.4vw] py-[0.3vh]', s.advRef === 'previous' || s.advRef === 'first' ? 'border-amber-600 text-amber-200' : 'border-neutral-700 text-neutral-100')}
                            >
                              <option value="">per instruction set</option>
                              <option value="previous">previous image</option>
                              <option value="first">first image</option>
                              <option value="none">off</option>
                            </select>
                          </label>
                        )}
                        {picked.type === 'image_to_video' && (
                          <label className="flex items-center gap-[0.4vw] text-neutral-400" title="Also send earlier images of the run as keyframes. 3+ uses Pika Pikaframes. A deliberate exception to the telephone rule.">
                            keyframes
                            <select
                              value={s.advFrames}
                              onChange={(e) => s.setAdvFrames(e.target.value === 'first_last' ? 'first_last' : Number(e.target.value))}
                              className={cx('rounded border bg-neutral-900 px-[0.4vw] py-[0.3vh]', keyframesCount(s.advFrames) > 1 ? 'border-amber-600 text-amber-200' : 'border-neutral-700 text-neutral-100')}
                            >
                              {Array.from({ length: MAX_KEYFRAMES }, (_, k) => k + 1).map((n) => (
                                <option key={n} value={n}>{n === 1 ? '1 frame (classic)' : `${n} keyframes`}</option>
                              ))}
                              <option value="first_last">first + last frames</option>
                            </select>
                          </label>
                        )}
                        {picked.type === 'text_to_audio' && (
                          <>
                            {voices.length > 0 && (
                              <label className="flex items-center gap-[0.4vw] text-neutral-400">
                                voice
                                <select
                                  value={s.advVoice}
                                  onChange={(e) => s.setAdvVoice(e.target.value)}
                                  className="rounded border border-neutral-700 bg-neutral-900 px-[0.4vw] py-[0.3vh] text-neutral-100"
                                >
                                  <option value="">default (Charon)</option>
                                  {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                                </select>
                              </label>
                            )}
                            <span className="flex items-center gap-[0.3vw] text-neutral-400">
                              tone
                              {(['', ...SPEECH_TONES] as string[]).map((t) => (
                                <button key={t || 'plain'} type="button" className={cx(chip, 'border border-neutral-700', s.advTone === t ? 'border-sky-400 bg-sky-900 text-sky-100' : 'text-neutral-300 hover:bg-white/10')} onClick={() => s.setAdvTone(t)}>
                                  {t ? `[${t}]` : 'plain'}
                                </button>
                              ))}
                            </span>
                          </>
                        )}
                        {picked.game && <span className="text-neutral-500">the game is the instruction · uses Retell's model</span>}
                        <button
                          type="button"
                          disabled={busy || working}
                          onClick={() => void onGo(picked.type, picked.game)}
                          className="ml-auto rounded-xl bg-sky-500 px-[1.4vw] py-[0.7vh] font-semibold text-white shadow-lg transition-colors hover:bg-sky-400 disabled:opacity-40"
                        >
                          Go ▶
                        </button>
                      </div>
                    ) : (
                      <div className="mt-[0.8vh] text-neutral-500">Pick what happens next. Its options appear here.</div>
                    )}

                    {/* global: applies to whatever you pick */}
                    <div className="mt-[1vh] flex flex-wrap items-center gap-[0.8vw] border-t border-white/10 pt-[1vh]">
                      <label className="flex items-center gap-[0.4vw] text-neutral-400" title="Which family of instructions the next step uses (word games and speech keep their own)">
                        instructions
                        <select value={s.advSet} onChange={(e) => s.setAdvSet(e.target.value)} className="rounded border border-neutral-700 bg-neutral-900 px-[0.4vw] py-[0.3vh] text-neutral-100">
                          {INSTRUCTION_SETS.map((x) => (
                            <option key={x.id} value={x.id}>{x.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex min-w-[20vw] flex-1 items-center gap-[0.4vw] text-neutral-400">
                        twist
                        <input
                          value={s.twist}
                          onChange={(e) => s.setTwist(e.target.value.slice(0, 500))}
                          disabled={picked?.type === 'text_to_audio'}
                          placeholder={picked?.type === 'text_to_audio' ? 'speech uses a tone instead' : 'optional, e.g. as a watercolour'}
                          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-[0.6vw] py-[0.3vh] text-neutral-100 placeholder:text-neutral-600 disabled:opacity-50"
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            );
}
