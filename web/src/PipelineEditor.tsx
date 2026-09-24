import { useRef } from 'react';
import {
  DEFAULT_INSTRUCTIONS,
  KEYFRAME_MODELS,
  PIKAFRAMES,
  expandRepeats,
  INSTRUCTION_SETS,
  PRESET_SCHEMA_VERSION,
  STEP_TYPES,
  bridgeType,
  keyframesCount,
  type ArtifactKind,
  type ModelsView,
  type Preset,
  type PresetBody,
  type StepDefinition,
  type StepIssue,
  type StepType,
} from '../../shared/types.ts';
import ModelPicker, { favoriteFor } from './ModelPicker.tsx';
import { Banner, Section, cx } from './util.tsx';

const STEP_TYPE_LIST = Object.keys(STEP_TYPES) as StepType[];

export const newStepId = () => crypto.randomUUID().slice(0, 8);

export function defaultParams(type: StepType, models: ModelsView | null, modelId: string): StepDefinition['params'] {
  if (type === 'text_to_image') {
    const m = models?.models.find((x) => x.id === modelId);
    return m?.params?.aspect_ratio?.includes('16:9') ? { aspect_ratio: '16:9' } : {};
  }
  if (type === 'image_to_video' || type === 'text_to_video') return { resolution: '768P', duration: 5, prompt_expansion_mode: 'balanced' };
  return {};
}

export function makeStep(type: StepType, models: ModelsView | null): StepDefinition {
  const modelId = favoriteFor(models, type);
  return { id: newStepId(), type, modelId, instruction: DEFAULT_INSTRUCTIONS[type], params: defaultParams(type, models, modelId) };
}

/** Output kind after `count` steps (used to pick a sensible type for a new step). */
export function kindAfter(startingKind: ArtifactKind, steps: StepDefinition[], count = steps.length): ArtifactKind {
  let kind = startingKind;
  for (let i = 0; i < count && i < steps.length; i++) kind = STEP_TYPES[steps[i].type]?.output ?? kind;
  return kind;
}

export function nextStepType(kind: ArtifactKind): StepType {
  if (kind === 'image') return 'image_to_text';
  if (kind === 'text') return 'text_to_image';
  return 'image_to_text'; // video has no built-in consumer step type yet
}

function ParamControls({
  step,
  models,
  onChange,
}: {
  step: StepDefinition;
  models: ModelsView | null;
  onChange: (params: StepDefinition['params']) => void;
}) {
  const entry = models?.models.find((m) => m.id === step.modelId);
  const set = (patch: Partial<StepDefinition['params']>) => {
    const next = { ...step.params, ...patch };
    for (const k of Object.keys(next) as (keyof StepDefinition['params'])[]) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(next);
  };

  if (step.type === 'text_to_image') {
    const ar = entry?.params?.aspect_ratio;
    const res = entry?.params?.resolution;
    return (
      <div className="grid grid-cols-2 gap-2">
        {entry?.params?.references !== 0 && (
          <div className="col-span-2">
            <label className="lbl">Reference image</label>
            <select className="inp mt-1" value={step.params.reference ?? ''} onChange={(e) => set({ reference: (e.target.value || undefined) as StepDefinition['params']['reference'] })}>
              <option value="">off — text only (classic telephone)</option>
              <option value="previous">previous image — keeps characters and style from frame to frame</option>
              <option value="first">first image — every frame anchored to the run's first image</option>
            </select>
            {step.params.reference && (
              <p className="mt-1 text-[11px] text-amber-300">Deliberate exception to the telephone rule: this step also sees an earlier image of the run.</p>
            )}
          </div>
        )}
        {!!ar?.length && (
          <div>
            <label className="lbl">Aspect ratio</label>
            <select className="inp mt-1" value={step.params.aspect_ratio ?? ''} onChange={(e) => set({ aspect_ratio: e.target.value || undefined })}>
              <option value="">(model default)</option>
              {ar.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )}
        {!!res?.length && (
          <div>
            <label className="lbl">Resolution</label>
            <select className="inp mt-1" value={step.params.resolution ?? ''} onChange={(e) => set({ resolution: e.target.value || undefined })}>
              <option value="">(model default)</option>
              {res.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  }

  if (step.type === 'image_to_video' || step.type === 'text_to_video') {
    const resolutions = entry?.params?.resolution ?? ['480P', '768P'];
    const maxFrames = step.type === 'image_to_video' ? (KEYFRAME_MODELS[step.modelId] ?? 1) : 1;
    return (
      <div className="grid grid-cols-3 gap-2">
        {maxFrames > 1 && (
          <div className="col-span-3">
            <label className="lbl">Keyframes</label>
            <select
              className="inp mt-1"
              value={step.params.keyframes ?? 1}
              onChange={(e) => set({ keyframes: e.target.value === 'first_last' ? 'first_last' : Number(e.target.value) > 1 ? Number(e.target.value) : undefined })}
            >
              <option value={1}>1 — previous image only (classic telephone)</option>
              <option value="first_last">First + last — the run's first image and the previous image (2 frames)</option>
              {Array.from({ length: maxFrames - 1 }, (_, k) => k + 2).map((n) => (
                <option key={n} value={n}>{n} — the run's last {n} images, oldest first</option>
              ))}
            </select>
            {keyframesCount(step.params.keyframes) > 1 && (
              <p className="mt-1 text-[11px] text-amber-300">
                Deliberate exception to the telephone rule: this step also sees earlier images of the run, as keyframes.
                {step.params.keyframes === 'first_last'
                  ? ' Only the run’s first image and the previous image are sent.'
                  : maxFrames === 2
                    ? ' For 3–5 keyframes pick the Pikaframes model.'
                    : ''}
              </p>
            )}
          </div>
        )}
        <div>
          <label className="lbl">Resolution</label>
          <select className="inp mt-1" value={step.params.resolution ?? ''} onChange={(e) => set({ resolution: e.target.value || undefined })}>
            <option value="">(model default)</option>
            {resolutions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="lbl">Duration (s)</label>
          <input
            type="number"
            min={5}
            max={15}
            className="inp mt-1"
            value={step.params.duration ?? ''}
            onChange={(e) => set({ duration: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="lbl">Prompt expansion</label>
          <select
            className="inp mt-1"
            value={step.params.prompt_expansion_mode ?? ''}
            onChange={(e) => set({ prompt_expansion_mode: (e.target.value || undefined) as StepDefinition['params']['prompt_expansion_mode'] })}
          >
            <option value="">(model default)</option>
            <option value="disabled">disabled</option>
            <option value="balanced">balanced</option>
            <option value="quality">quality</option>
          </select>
        </div>
      </div>
    );
  }

  return <p className="text-[11px] text-neutral-500">This step type takes no extra parameters.</p>;
}

function StepCard({
  step,
  index,
  total,
  inRepeat,
  inputKind,
  issues,
  models,
  refreshing,
  onRefreshModels,
  update,
  move,
  duplicate,
  remove,
}: {
  step: StepDefinition;
  index: number;
  total: number;
  /** times of the enclosing repeat block when this card is inside one started by an earlier card */
  inRepeat: number;
  inputKind: ArtifactKind;
  issues: StepIssue[];
  models: ModelsView | null;
  refreshing: boolean;
  onRefreshModels: () => void;
  update: (patch: Partial<StepDefinition>) => void;
  move: (dir: -1 | 1) => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const t = STEP_TYPES[step.type];
  const bad = issues.length > 0;
  return (
    <div className={cx('rounded-lg border p-2.5', bad ? 'border-red-800 bg-red-950/20' : 'border-neutral-800 bg-neutral-900/50')}>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs font-semibold text-neutral-300">
          {index + 1}
        </span>
        <select
          className="inp max-w-56"
          value={step.type}
          onChange={(e) => {
            const type = e.target.value as StepType;
            const modelId = favoriteFor(models, type);
            update({ type, modelId, instruction: DEFAULT_INSTRUCTIONS[type], params: defaultParams(type, models, modelId) });
          }}
        >
          {STEP_TYPE_LIST.map((k) => (
            <option key={k} value={k}>
              {STEP_TYPES[k].label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-neutral-500">
          in: {t.input} · out: {t.output} · {t.provider}
        </span>
        {inRepeat ? (
          <span className="rounded bg-violet-950 px-1.5 py-0.5 text-[11px] text-violet-300">↻ in repeat ×{inRepeat}</span>
        ) : (
          <label className="flex items-center gap-1 text-[11px] text-neutral-400" title="Run this step and the ones after it several times in a row, without adding cards. Unrolled into ordinary steps when the run is created.">
            ↻ repeat
            <select
              className="inp w-auto py-0.5"
              value={step.repeat?.span ?? 0}
              onChange={(e) => update({ repeat: Number(e.target.value) ? { span: Number(e.target.value), times: step.repeat?.times ?? 3 } : undefined })}
            >
              <option value={0}>off</option>
              {Array.from({ length: Math.min(10, total - index) }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>{n === 1 ? 'this step' : `this + next ${n - 1}`}</option>
              ))}
            </select>
            {step.repeat && (
              <>
                ×
                <input
                  type="number"
                  min={2}
                  max={50}
                  className="inp w-14 py-0.5"
                  value={step.repeat.times}
                  onChange={(e) => update({ repeat: { span: step.repeat!.span, times: Math.max(2, Math.min(50, Number(e.target.value) || 2)) } })}
                />
              </>
            )}
          </label>
        )}
        <div className="ml-auto flex gap-1">
          <button type="button" className="btn btn-xs" title="Move up" disabled={index === 0} onClick={() => move(-1)}>
            ↑
          </button>
          <button type="button" className="btn btn-xs" title="Move down" disabled={index === total - 1} onClick={() => move(1)}>
            ↓
          </button>
          <button type="button" className="btn btn-xs" title="Duplicate" onClick={duplicate}>
            Duplicate
          </button>
          <button type="button" className="btn btn-xs btn-danger" title="Delete" onClick={remove}>
            Delete
          </button>
        </div>
      </div>

      {bad && (
        <ul className="mt-2 space-y-1">
          {issues.map((i, n) => (
            <li key={n} className="rounded border border-red-900 bg-red-950/50 px-2 py-1 text-xs text-red-200">
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <div className="space-y-2">
          <ModelPicker type={step.type} value={step.modelId} models={models} onChange={(modelId) => {
            // keep video params valid for the newly chosen endpoint (resolutions and keyframe limits differ)
            const params = { ...step.params };
            const res = models?.models.find((m) => m.id === modelId)?.params?.resolution;
            if (params.resolution && res && !res.includes(params.resolution)) params.resolution = res[0];
            if (step.type === 'image_to_video') {
              const max = KEYFRAME_MODELS[modelId] ?? 1;
              if (params.keyframes === 'first_last') {
                if (max < 2) delete params.keyframes; // the endpoint takes no second image
              } else {
                const kf = Math.min(Math.max(params.keyframes ?? 1, modelId === PIKAFRAMES ? 2 : 1), max);
                if (kf > 1) params.keyframes = kf; else delete params.keyframes;
              }
            }
            update({ modelId, params });
          }} onRefresh={onRefreshModels} refreshing={refreshing} />
          <ParamControls step={step} models={models} onChange={(params) => update({ params })} />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="lbl">Instruction (sent with the {inputKind} from the previous stage only)</label>
            <button
              type="button"
              className="btn btn-xs"
              disabled={step.instruction === DEFAULT_INSTRUCTIONS[step.type]}
              onClick={() => update({ instruction: DEFAULT_INSTRUCTIONS[step.type] })}
            >
              Reset to default
            </button>
          </div>
          <textarea
            className="inp mt-1 h-28 resize-y font-mono text-xs leading-relaxed"
            value={step.instruction}
            onChange={(e) => update({ instruction: e.target.value })}
            placeholder={step.type === 'text_to_video' ? 'Optional: the preceding text is the prompt.' : ''}
          />
        </div>
      </div>
    </div>
  );
}

export default function PipelineEditor({
  editor,
  setEditor,
  models,
  issues,
  presets,
  loadedPresetId,
  setLoadedPresetId,
  refreshing,
  onRefreshModels,
  onSaveNew,
  onSaveReplace,
  onDuplicate,
  onDelete,
  onImport,
  importIssues,
  importError,
  sourceKind,
}: {
  editor: PresetBody;
  setEditor: (b: PresetBody) => void;
  models: ModelsView | null;
  issues: StepIssue[];
  presets: Preset[];
  loadedPresetId: string | null;
  setLoadedPresetId: (id: string | null) => void;
  refreshing: boolean;
  onRefreshModels: () => void;
  onSaveNew: () => void;
  onSaveReplace: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onImport: (file: File) => void;
  importIssues: StepIssue[] | null;
  importError: string | null;
  sourceKind: ArtifactKind | null;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const setSteps = (steps: StepDefinition[]) => setEditor({ ...editor, steps });

  const addStep = () => {
    const type = nextStepType(kindAfter(editor.startingKind, editor.steps));
    setSteps([...editor.steps, makeStep(type, models)]);
  };

  const exportJson = () => {
    const body: PresetBody = { schemaVersion: PRESET_SCHEMA_VERSION, name: editor.name, startingKind: editor.startingKind, steps: editor.steps };
    const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${editor.name.replace(/[^\w.-]+/g, '_') || 'preset'}.telephone-preset.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // For each card: the ×N of a repeat block opened by an EARLIER card that covers it (0 = none).
  const repeatOf: number[] = editor.steps.map(() => 0);
  for (let i = 0; i < editor.steps.length; ) {
    const rep = editor.steps[i].repeat;
    const span = rep ? Math.min(rep.span, editor.steps.length - i) : 1;
    for (let j = 1; j < span; j++) repeatOf[i + j] = rep!.times;
    i += span;
  }
  const expandedCount = expandRepeats(editor.steps).steps.length;
  const issuesFor = (index: number) => issues.filter((i) => i.index === index);
  const generalIssues = issues.filter((i) => i.index < 0 || i.index >= editor.steps.length);

  return (
    <Section
      title="Pipeline editor"
      right={
        <span className="text-[11px] text-neutral-500">
          {editor.steps.length} step{editor.steps.length === 1 ? '' : 's'}{expandedCount !== editor.steps.length ? ` → ${expandedCount} with repeats` : ''}
        </span>
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <label className="lbl">Preset</label>
          <select
            className="inp mt-1"
            value={loadedPresetId ?? ''}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              setLoadedPresetId(p ? p.id : null);
              if (p) setEditor({ schemaVersion: PRESET_SCHEMA_VERSION, name: p.name, startingKind: p.startingKind, steps: structuredClone(p.steps) });
            }}
          >
            <option value="">(unsaved pipeline)</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-48 flex-1">
          <label className="lbl">Name</label>
          <input className="inp mt-1" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
        </div>
        <div>
          <label className="lbl">Starting input</label>
          <select
            className="inp mt-1"
            value={editor.startingKind}
            onChange={(e) => setEditor({ ...editor, startingKind: e.target.value as 'image' | 'text' })}
          >
            <option value="image">image</option>
            <option value="text">text</option>
          </select>
          {sourceKind && editor.steps[0] && sourceKind !== STEP_TYPES[editor.steps[0].type].input && (
            <p className="mt-1 max-w-44 text-[11px] text-sky-300">
              {bridgeType(sourceKind, STEP_TYPES[editor.steps[0].type].input)
                ? `The accepted source is ${sourceKind}, so a visible “${STEP_TYPES[bridgeType(sourceKind, STEP_TYPES[editor.steps[0].type].input)!].label}” step is added automatically at the start of the run.`
                : `The accepted source is ${sourceKind}; this pipeline cannot start from it.`}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="btn btn-xs" onClick={onSaveNew}>
          Save as new
        </button>
        <button type="button" className="btn btn-xs" disabled={!loadedPresetId} onClick={onSaveReplace}>
          Save (replace)
        </button>
        <button type="button" className="btn btn-xs" onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="btn btn-xs btn-danger" disabled={!loadedPresetId} onClick={onDelete}>
          Delete
        </button>
        <span className="w-2" />
        <select
          className="inp w-auto py-0.5 text-xs"
          value=""
          title="Overwrite the instruction on every step card with this set (edits the pipeline; use the Run panel's selector to leave it untouched)."
          onChange={(e) => {
            const set = INSTRUCTION_SETS.find((x) => x.id === e.target.value);
            if (!set) return;
            if (window.confirm(`Replace the instruction on all ${editor.steps.length} step cards with the "${set.name}" set?`))
              setSteps(editor.steps.map((st) => ({ ...st, instruction: set.instructions[st.type] })));
          }}
        >
          <option value="">Fill cards from instruction set…</option>
          {INSTRUCTION_SETS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-xs" onClick={exportJson}>
          Export JSON
        </button>
        <button type="button" className="btn btn-xs" onClick={() => fileRef.current?.click()}>
          Import JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onImport(f);
          }}
        />
      </div>

      {importError && <Banner kind="error">Import: {importError}</Banner>}
      {importIssues && importIssues.length > 0 && (
        <Banner kind="warn">
          <div className="font-medium">The imported preset has problems. Nothing was changed automatically — fix them below.</div>
          <ul className="mt-1 list-disc pl-5">
            {importIssues.map((i, n) => (
              <li key={n}>
                Step {i.index + 1}: {i.message}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {importIssues && importIssues.length === 0 && <Banner kind="ok">Imported preset validated cleanly.</Banner>}

      {expandedCount > 8 && (
        <Banner kind="warn">
          {expandedCount} steps: long chains cost more and take longer. Image and video generation dominate the wall clock — keep a live demo
          short, or set a budget below.
        </Banner>
      )}
      {generalIssues.length > 0 && (
        <Banner kind="error">
          {generalIssues.map((i, n) => (
            <div key={n}>{i.message}</div>
          ))}
        </Banner>
      )}

      <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
        {editor.steps.length === 0 && <p className="text-sm text-neutral-500">No steps yet. Add one below.</p>}
        {editor.steps.map((s, i) => (
          <StepCard
            key={s.id}
            step={s}
            index={i}
            inRepeat={repeatOf[i]}
            total={editor.steps.length}
            inputKind={kindAfter(editor.startingKind, editor.steps, i)}
            issues={issuesFor(i)}
            models={models}
            refreshing={refreshing}
            onRefreshModels={onRefreshModels}
            update={(patch) => setSteps(editor.steps.map((x, n) => (n === i ? { ...x, ...patch } : x)))}
            move={(dir) => {
              const j = i + dir;
              if (j < 0 || j >= editor.steps.length) return;
              const next = [...editor.steps];
              [next[i], next[j]] = [next[j], next[i]];
              setSteps(next);
            }}
            duplicate={() => {
              const next = [...editor.steps];
              next.splice(i + 1, 0, { ...structuredClone(s), id: newStepId() });
              setSteps(next);
            }}
            remove={() => setSteps(editor.steps.filter((_, n) => n !== i))}
          />
        ))}
      </div>

      <button type="button" className="btn" onClick={addStep}>
        + Add step
      </button>
    </Section>
  );
}
