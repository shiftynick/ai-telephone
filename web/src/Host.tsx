import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PRESET_SCHEMA_VERSION,
  STEP_TYPES,
  bridgeType,
  validateChain,
  type ModelsView,
  type Preset,
  type PresetBody,
  type RunView,
  type StepIssue,
} from '../../shared/types.ts';
import { ApiError, api, type LanView, type RunListItem, type SessionView, type StatusView } from './api.ts';
import PipelineEditor, { newStepId } from './PipelineEditor.tsx';
import { ProjectorPanel, SourcePanel } from './SourcePanel.tsx';
import RunPanel from './RunPanel.tsx';
import RevealControls from './RevealControls.tsx';
import { Banner, Pill, useDebounced } from './util.tsx';

const EMPTY_EDITOR: PresetBody = { schemaVersion: PRESET_SCHEMA_VERSION, name: 'Untitled pipeline', startingKind: 'image', steps: [] };

// The bootstrap code is single-use: StrictMode must not exchange it twice.
let exchangeStarted = false;

function LoginGate() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-2xl font-semibold text-neutral-100">AI Telephone</h1>
        <p className="text-neutral-300">Open the one-time link printed in the terminal.</p>
        <p className="text-sm text-neutral-500">
          It looks like <code className="rounded bg-neutral-900 px-1 font-mono">http://localhost:8787/host?code=…</code> and works once. Restart the
          server to print a new one.
        </p>
      </div>
    </div>
  );
}

export default function Host() {
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [lan, setLan] = useState<LanView | null>(null);
  const [models, setModels] = useState<ModelsView | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [run, setRun] = useState<RunView | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);

  const [editor, setEditor] = useState<PresetBody>(EMPTY_EDITOR);
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<StepIssue[]>([]);
  const [importIssues, setImportIssues] = useState<StepIssue[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  // '' = run the pipeline exactly as written; otherwise swap every step's instruction for this run only.
  const [runInstructionSet, setRunInstructionSet] = useState('');

  const openRunRef = useRef<string | null>(null);
  openRunRef.current = openRunId;

  const onError = useCallback((msg: string) => setError(msg), []);

  // ---- bootstrap: exchange ?code=, then load state ------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const url = new URL(location.href);
      const code = url.searchParams.get('code');
      if (code && !exchangeStarted) {
        exchangeStarted = true;
        try {
          await api.exchange(code);
        } catch (e) {
          if (alive) setError(String((e as Error).message));
        }
        url.searchParams.delete('code');
        history.replaceState(null, '', url.pathname + url.search);
      }
      try {
        const s = await api.status();
        if (!alive) return;
        setStatus(s);
      } catch (e) {
        if (alive) setError(String((e as Error).message));
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const host = status?.host === true;

  // ---- data refetch (pure reads; never triggers actions) ------------------
  const refreshAll = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.session(), api.runs()]);
      setSession(s);
      setRuns(r.runs);
      const id = openRunRef.current ?? s.selectedRunId;
      if (id) {
        const v = await api.run(id);
        setRun(v);
        setOpenRunId(v.id);
      } else {
        setRun(null);
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    if (!host) return;
    void refreshAll();
    void api.lan().then(setLan, () => undefined);
    void api.models().then(setModels, (e) => setError(String((e as Error).message)));
    void api.presets().then((p) => setPresets(p.presets), () => undefined);
  }, [host, refreshAll]);

  // Load a sensible default pipeline once presets arrive (no server mutation).
  useEffect(() => {
    if (loadedPresetId || editor.steps.length || presets.length === 0) return;
    const p = presets.find((x) => x.name === 'Quick demo') ?? presets[0];
    setLoadedPresetId(p.id);
    setEditor({ schemaVersion: PRESET_SCHEMA_VERSION, name: p.name, startingKind: p.startingKind, steps: structuredClone(p.steps) });
  }, [presets, loadedPresetId, editor.steps.length]);

  useEffect(() => {
    if (status?.host && status.defaultBudgetUsd != null) setBudget(String(status.defaultBudgetUsd));
  }, [status]);

  // ---- SSE: a single stream; every `change` is just an invalidation ping ---
  useEffect(() => {
    if (!host) return;
    let timer: number | undefined;
    const ping = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void refreshAll(), 150);
    };
    const es = new EventSource('/api/events');
    es.addEventListener('change', ping);
    es.addEventListener('open', ping);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [host, refreshAll]);

  // ---- validation --------------------------------------------------------
  const localIssues = useMemo(() => validateChain(editor.startingKind, editor.steps), [editor.startingKind, editor.steps]);
  const debouncedEditor = useDebounced(editor, 400);
  useEffect(() => {
    if (!host) return;
    let alive = true;
    api.validatePreset(debouncedEditor).then(
      (r) => alive && setServerIssues(r.issues),
      () => alive && setServerIssues([]),
    );
    return () => {
      alive = false;
    };
  }, [host, debouncedEditor]);

  const issues = useMemo(() => {
    const seen = new Set<string>();
    return [...localIssues, ...serverIssues].filter((i) => {
      const k = `${i.index}|${i.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [localIssues, serverIssues]);

  // ---- preset actions ----------------------------------------------------
  const reloadPresets = () => api.presets().then((p) => setPresets(p.presets), () => undefined);

  const savePresetNew = async () => {
    const name = window.prompt('Save pipeline as:', editor.name);
    if (!name) return;
    try {
      const p = await api.createPreset({ ...editor, name });
      setEditor({ ...editor, name });
      setLoadedPresetId(p.id);
      await reloadPresets();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const savePresetReplace = async () => {
    if (!loadedPresetId) return;
    const existing = presets.find((p) => p.id === loadedPresetId);
    if (!window.confirm(`Replace the saved preset “${existing?.name ?? loadedPresetId}” with the current pipeline?`)) return;
    try {
      await api.replacePreset(loadedPresetId, editor);
      await reloadPresets();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const duplicatePreset = async () => {
    try {
      const p = await api.createPreset({ ...editor, name: `${editor.name} (copy)` });
      setEditor({ ...editor, name: p.name });
      setLoadedPresetId(p.id);
      await reloadPresets();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const deletePreset = async () => {
    if (!loadedPresetId) return;
    const existing = presets.find((p) => p.id === loadedPresetId);
    if (!window.confirm(`Delete the preset “${existing?.name ?? loadedPresetId}”? This cannot be undone.`)) return;
    try {
      await api.deletePreset(loadedPresetId);
      setLoadedPresetId(null);
      await reloadPresets();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const importPreset = async (file: File) => {
    setImportError(null);
    setImportIssues(null);
    try {
      const raw: unknown = JSON.parse(await file.text());
      const body = raw as Partial<PresetBody>;
      if (!body || typeof body !== 'object' || !Array.isArray(body.steps)) throw new Error('Not a preset file (no steps array).');
      if (body.schemaVersion !== PRESET_SCHEMA_VERSION)
        throw new Error(`Unsupported schemaVersion ${String(body.schemaVersion)}; this app writes version ${PRESET_SCHEMA_VERSION}.`);
      const next: PresetBody = {
        schemaVersion: PRESET_SCHEMA_VERSION,
        name: String(body.name ?? file.name.replace(/\.json$/i, '')),
        startingKind: body.startingKind === 'text' ? 'text' : 'image',
        steps: body.steps.map((s) => ({
          id: String(s?.id ?? newStepId()),
          type: s?.type,
          modelId: String(s?.modelId ?? ''),
          instruction: String(s?.instruction ?? ''),
          params: s?.params ?? {},
        })) as PresetBody['steps'],
      };
      setEditor(next);
      setLoadedPresetId(null);
      // Nothing is repaired silently: the server explains every problem instead.
      try {
        const r = await api.validatePreset(next);
        setImportIssues(r.issues);
      } catch (e) {
        setImportIssues(null);
        setImportError(String((e as Error).message));
      }
    } catch (e) {
      setImportError(String((e as Error).message));
    }
  };

  // ---- run creation ------------------------------------------------------
  const budgetValue = budget.trim() === '' ? null : Number(budget);
  const budgetInvalid = budgetValue !== null && !(Number.isFinite(budgetValue) && budgetValue > 0);

  const createDisabledReason = issues.length
    ? 'Fix the pipeline problems above before creating a run.'
    : editor.steps.length === 0
      ? 'Add at least one step.'
      : budgetInvalid
        ? 'Budget must be a positive number, or blank for no limit.'
        : !session?.source
          ? 'Accept a source image (or enter starting text) first.'
          : null;

  const createRun = async (sourceArtifactId?: string) => {
    if (sourceArtifactId) {
      // "New run from this artifact": adjacency is judged against that artifact's kind.
      const kind = run?.steps.find((s) => s.artifact?.id === sourceArtifactId)?.artifact?.kind ?? editor.startingKind;
      // A one-step mismatch at the seam is bridged automatically by the server; only warn about the rest.
      const first = editor.steps[0] ? STEP_TYPES[editor.steps[0].type].input : kind;
      const adj = bridgeType(kind, first) ? [] : validateChain(kind, editor.steps);
      if (adj.length && !window.confirm(`This pipeline does not fit a ${kind} starting artifact:\n\n${adj[0].message}\n\nTry anyway?`)) return;
    } else if (createDisabledReason) {
      setError(createDisabledReason);
      return;
    }
    try {
      const v = await api.createRun({ preset: editor, sourceArtifactId, budgetUsd: budgetValue, select: true, instructionSet: runInstructionSet || undefined });
      setOpenRunId(v.id);
      setRun(v);
      await refreshAll();
    } catch (e) {
      const err = e as ApiError;
      const extra = Array.isArray(err.issues) ? ` ${err.issues.map((i) => (typeof i === 'string' ? i : i.message)).join(' ')}` : '';
      setError(err.message + extra);
    }
  };

  const refreshModels = async () => {
    setRefreshingModels(true);
    try {
      setModels(await api.refreshModels());
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRefreshingModels(false);
    }
  };

  if (booting) return <div className="p-8 text-neutral-400">Loading…</div>;
  if (!host) return <LoginGate />;
  const st = status as Extract<StatusView, { host: true }>;

  return (
    <div className="mx-auto max-w-[1600px] p-3">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-neutral-100">AI Telephone</h1>
        {st.mock && <Pill tone="warn">MOCK — no provider calls</Pill>}
        <span className="text-[11px] text-neutral-500">port {st.port}</span>
        {!st.keys.openrouter && <Pill tone="error">OPENROUTER_API_KEY missing</Pill>}
        {!st.keys.fal && <Pill tone="error">FAL_KEY missing</Pill>}
        {models?.stale && <Pill tone="warn">model catalog stale</Pill>}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn btn-xs" disabled={refreshingModels} onClick={refreshModels}>
            {refreshingModels ? 'Refreshing models…' : 'Refresh model catalog'}
          </button>
        </div>
      </header>

      {(!st.keys.openrouter || !st.keys.fal) && !st.mock && (
        <div className="mb-3">
          <Banner kind="warn">
            A provider key is missing; steps using that provider will fail. Add it to <code>.env</code> and restart the server.
          </Banner>
        </div>
      )}

      {error && (
        <div className="mb-3">
          <Banner kind="error">
            <div className="flex items-start gap-2">
              <span className="flex-1">{error}</span>
              <button type="button" className="btn btn-xs" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          </Banner>
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="space-y-3">
          <SourcePanel session={session} lan={lan} onChanged={() => void refreshAll().then(() => api.lan().then(setLan, () => undefined))} onError={onError} />
          <ProjectorPanel session={session} lan={lan} onChanged={() => void refreshAll()} onError={onError} />
          <RevealControls session={session} run={run} onChanged={() => void refreshAll()} onError={onError} />
        </div>
        <div className="space-y-3">
          <PipelineEditor
            editor={editor}
            setEditor={(b) => {
              setImportIssues(null);
              setImportError(null);
              setEditor(b);
            }}
            models={models}
            issues={issues}
            presets={presets}
            loadedPresetId={loadedPresetId}
            setLoadedPresetId={setLoadedPresetId}
            refreshing={refreshingModels}
            onRefreshModels={refreshModels}
            onSaveNew={savePresetNew}
            onSaveReplace={savePresetReplace}
            onDuplicate={duplicatePreset}
            onDelete={deletePreset}
            onImport={(f) => void importPreset(f)}
            importIssues={importIssues}
            importError={importError}
            sourceKind={session?.source?.kind ?? null}
          />
          <RunPanel
            run={run}
            runs={runs}
            selectedRunId={session?.selectedRunId ?? null}
            replay={!!session?.replay}
            budget={budget}
            setBudget={setBudget}
            instructionSetId={runInstructionSet}
            setInstructionSetId={setRunInstructionSet}
            canCreate={!createDisabledReason}
            createDisabledReason={createDisabledReason}
            onCreateRun={(id) => void createRun(id)}
            onOpenRun={(id) => {
              setOpenRunId(id);
              void api.run(id).then(setRun, (e) => setError(String((e as Error).message)));
            }}
            onChanged={() => void refreshAll()}
            onError={onError}
          />
        </div>
      </div>

      <footer className="mt-4 text-[11px] text-neutral-600">
        Every step receives only its immediate predecessor’s artifact plus the instruction shown on its card. Uploaded photos are sent to
        OpenRouter / fal.ai when a run runs.
      </footer>
    </div>
  );
}
