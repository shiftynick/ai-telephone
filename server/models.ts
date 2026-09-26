import { type DB, kvGet, kvSet, now } from './db.ts';
import { FAL_ENDPOINTS } from './providers/fal.ts';
import { LOCAL_MODELS, isOpenRouterClaude, KEYFRAME_MODELS, PIKAFRAMES, SPEECH_TONES, STEP_TYPES, keyframesCount, type ModelEntry, type ModelsView, type Provider, type StepDefinition, type StepType } from '../shared/types.ts';

export const FAVORITES: Record<StepType, string[]> = {
  image_to_text: ['google/gemini-3.8-flash', 'openai/gpt-4.1-mini', 'claude-cli/sonnet', 'google/gemini-2.5-flash'],
  text_to_text: ['google/gemini-3.8-flash', 'openai/gpt-4.1-mini', 'claude-cli/sonnet', 'local/qwen3.5-9b'],
  text_to_image: ['google/gemini-3.1-flash-lite-image', 'google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-flare', 'bytedance-seed/seedream-4.5'],
  image_to_video: [FAL_ENDPOINTS.image_to_video, PIKAFRAMES],
  text_to_video: [FAL_ENDPOINTS.text_to_video],
  text_to_svg: ['claude-cli/opus', 'claude-cli/sonnet'],
  image_to_svg: ['claude-cli/opus', 'claude-cli/sonnet'],
  text_to_ascii: ['claude-cli/opus', 'claude-cli/sonnet'],
  text_to_code_image: ['claude-cli/opus', 'claude-cli/sonnet'],
  text_to_code_video: ['claude-cli/opus', 'claude-cli/sonnet'],
  text_to_audio: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
  audio_to_text: ['gemini-3.8-flash'],
};

/** Any text model can write code; only vision models can trace an image. */
const CODE_FROM_TEXT: StepType[] = ['text_to_svg', 'text_to_ascii', 'text_to_code_image', 'text_to_code_video'];
const CLAUDE_CLI_MODELS: [string, string][] = [
  ['claude-cli/opus', 'Claude Opus (claude CLI · subscription)'],
  ['claude-cli/sonnet', 'Claude Sonnet (claude CLI · subscription)'],
  ['claude-cli/haiku', 'Claude Haiku (claude CLI · subscription)'],
];
export const TTS_VOICES = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Enceladus', 'Algieba', 'Sadachbia', 'Gacrux'];

type Catalog = { chat: any[]; image: any[]; imageParams: Record<string, { aspect_ratio?: string[]; resolution?: string[]; references?: number }> };
const STALE_MS = 24 * 3600_000;

const enumVals = (p: any): string[] | undefined => (p?.type === 'enum' && Array.isArray(p.values) ? p.values : undefined);

export class ModelCatalog {
  db: DB;
  fetchImpl: typeof fetch;
  lastError: string | undefined;
  constructor(db: DB, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.fetchImpl = fetchImpl;
  }

  private cached() {
    return kvGet<Catalog>(this.db, 'model_catalog');
  }

  /** Public catalogs; no key needed. On failure the previous cache is kept and flagged stale. */
  async refresh(): Promise<ModelsView> {
    try {
      const get = async (u: string) => {
        const r = await this.fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
        return (await r.json()).data as any[];
      };
      const [chat, image] = await Promise.all([
        get('https://openrouter.ai/api/v1/models?output_modalities=all'),
        get('https://openrouter.ai/api/v1/images/models'),
      ]);
      const prev = this.cached()?.value.imageParams ?? {};
      const imageParams: Catalog['imageParams'] = {};
      // Model-level capabilities are a union; intersect across concrete endpoints for favorites.
      await Promise.all(
        image.map(async (m) => {
          // absent = unknown (not judged); an explicit max of 0 = the model takes no reference images
          const refMax = m.supported_parameters?.input_references?.max;
          const references = typeof refMax === 'number' ? refMax : undefined;
          const model = { aspect_ratio: enumVals(m.supported_parameters?.aspect_ratio), resolution: enumVals(m.supported_parameters?.resolution), references };
          imageParams[m.id] = prev[m.id] ?? model;
          if (!FAVORITES.text_to_image.includes(m.id) || !m.endpoints) { imageParams[m.id] = model; return; }
          try {
            const r = await this.fetchImpl(`https://openrouter.ai${m.endpoints}`, { signal: AbortSignal.timeout(15_000) });
            const eps = ((await r.json()).endpoints ?? []) as any[];
            const inter = (key: 'aspect_ratio' | 'resolution') => {
              let acc = model[key];
              for (const ep of eps) {
                const v = enumVals(ep.supported_parameters?.[key]);
                acc = v && acc ? acc.filter((x) => v.includes(x)) : undefined;
              }
              return acc?.length ? acc : undefined;
            };
            imageParams[m.id] = eps.length ? { aspect_ratio: inter('aspect_ratio'), resolution: inter('resolution'), references } : model;
          } catch {
            imageParams[m.id] = model;
          }
        }),
      );
      const slim = (m: any) => ({ id: m.id, name: m.name, architecture: m.architecture });
      kvSet(this.db, 'model_catalog', { chat: chat.map(slim), image: image.map(slim), imageParams } satisfies Catalog);
      this.lastError = undefined;
    } catch (e: any) {
      this.lastError = `Catalog refresh failed: ${String(e?.message ?? e).slice(0, 200)}`;
    }
    return this.view();
  }

  view(): ModelsView {
    const c = this.cached();
    const tests = new Map<string, any>();
    for (const t of this.db.prepare('SELECT * FROM model_tests').all() as any[]) tests.set(`${t.model_id}|${t.step_type}`, t);
    const byId = new Map<string, ModelEntry>();
    const add = (id: string, name: string, provider: Provider, type: StepType, source: string, params?: ModelEntry['params']) => {
      let e = byId.get(id);
      if (!e) {
        e = { id, name, provider, stepTypes: [], favorite: false, hiddenByDefault: /:free$|:batch$|^openrouter\/|-batch\b/.test(id), source, params, testState: 'catalog-only' };
        byId.set(id, e);
      }
      e.stepTypes.push(type);
      if (FAVORITES[type].includes(id)) e.favorite = true;
      const t = tests.get(`${id}|${type}`);
      if (t && (e.testState === 'catalog-only' || t.state === 'failed')) {
        e.testState = t.state;
        e.testedAt = t.tested_at;
        e.testNote = t.note ?? undefined;
      }
    };
    if (c) {
      const imageIds = new Set(c.value.image.map((m) => m.id));
      for (const m of c.value.chat) {
        const i: string[] = m.architecture?.input_modalities ?? [];
        const o: string[] = m.architecture?.output_modalities ?? [];
        // Claude only ever runs through the local CLI (subscription), never billed per token via OpenRouter.
        if (!o.includes('text') || imageIds.has(m.id) || isOpenRouterClaude(m.id)) continue;
        if (i.includes('image')) add(m.id, m.name, 'openrouter', 'image_to_text', 'OpenRouter Models API');
        if (i.includes('text')) add(m.id, m.name, 'openrouter', 'text_to_text', 'OpenRouter Models API');
        // code steps: the model writes the code, the app renders it
        if (i.includes('image')) add(m.id, m.name, 'openrouter', 'image_to_svg', 'OpenRouter Models API');
        if (i.includes('text')) for (const t of CODE_FROM_TEXT) add(m.id, m.name, 'openrouter', t, 'OpenRouter Models API');
      }
      for (const m of c.value.image) add(m.id, m.name, 'openrouter', 'text_to_image', 'OpenRouter Image Models API', c.value.imageParams[m.id]);
    }
    const falParams = { resolution: ['480P', '768P'] };
    add(FAL_ENDPOINTS.image_to_video, 'MiniMax H3 Max Turbo (image → video)', 'fal', 'image_to_video', 'fal endpoint schema (built-in adapter)', falParams);
    add(PIKAFRAMES, 'Pika 2.2 Pikaframes (2–5 keyframes → video)', 'fal', 'image_to_video', 'fal endpoint schema (built-in adapter)', { resolution: ['720p', '1080p'] });
    add(FAL_ENDPOINTS.text_to_video, 'MiniMax H3 Max Turbo (text → video)', 'fal', 'text_to_video', 'fal endpoint schema (built-in adapter)', falParams);
    for (const [id, name] of CLAUDE_CLI_MODELS)
      for (const t of ['image_to_text', 'text_to_text', 'image_to_svg', ...CODE_FROM_TEXT] as StepType[]) add(id, name, 'claude', t, 'local claude CLI (built-in adapter)');
    // text → text only: the local gateway silently drops images
    for (const [id, m] of Object.entries(LOCAL_MODELS)) add(id, m.name, 'local', 'text_to_text', 'this laptop (Omarchy Local AI, built-in adapter)');
    const voices = { voice: TTS_VOICES };
    add('gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', 'gemini', 'text_to_audio', 'Gemini API (built-in adapter)', voices);
    add('gemini-3.8-flash-lite-tts', 'Gemini 3.8 Flash-Lite TTS', 'gemini', 'text_to_audio', 'Gemini API (built-in adapter)', voices);
    add('gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS (preview)', 'gemini', 'text_to_audio', 'Gemini API (built-in adapter)', voices);
    add('gemini-3.8-flash', 'Gemini 3.8 Flash (listens)', 'gemini', 'audio_to_text', 'Gemini API (built-in adapter)');
    add('gemini-2.5-flash', 'Gemini 2.5 Flash (listens)', 'gemini', 'audio_to_text', 'Gemini API (built-in adapter)');
    const models = [...byId.values()].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.id.localeCompare(b.id));
    return { refreshedAt: c?.updatedAt ?? null, stale: !c || now() - c.updatedAt > STALE_MS || !!this.lastError, error: this.lastError, models };
  }

  /** Manual IDs and imported presets go through the same gate: unknown or incompatible → explained rejection. */
  validateStep(def: StepDefinition): string | null {
    const v = this.view();
    const m = v.models.find((x) => x.id === def.modelId);
    const t = STEP_TYPES[def.type];
    if (def.params?.reference && def.type !== 'text_to_image') return 'A reference image only applies to text → image steps.';
    if (def.params?.voice !== undefined && def.type !== 'text_to_audio') return 'A voice only applies to text → speech steps.';
    if (def.type === 'text_to_audio' && def.instruction.trim() && !(SPEECH_TONES as readonly string[]).includes(def.instruction.trim()))
      return `A speech step's instruction is its tone: one of ${SPEECH_TONES.join(', ')}, or empty. Longer directions get read aloud by the voice model.`;
    if (isOpenRouterClaude(def.modelId)) return `"${def.modelId}" would bill per token through OpenRouter; Claude runs through the local claude CLI instead: use claude-cli/opus, claude-cli/sonnet, or claude-cli/haiku.`;
    if (!m) {
      const viaOpenRouter = t.provider === 'openrouter' || (t.provider === 'code' && !def.modelId.startsWith('claude-cli/'));
      if (!v.refreshedAt && viaOpenRouter) return null; // no catalog at all (offline first boot): cannot judge
      return `Model "${def.modelId}" is not in the ${t.provider === 'fal' ? 'supported fal endpoint list (a new endpoint needs an adapter)' : viaOpenRouter ? 'OpenRouter catalog' : `built-in ${t.provider} model list`}.`;
    }
    if (!m.stepTypes.includes(def.type)) return `Model "${def.modelId}" does not support ${t.label} according to the catalog.`;
    if (def.params?.voice !== undefined && !m.params?.voice?.includes(def.params.voice)) return `Voice "${def.params.voice}" is not one of ${m.params?.voice?.join(', ') ?? 'the known voices'}.`;
    for (const key of ['aspect_ratio', 'resolution'] as const) {
      const val = def.params?.[key];
      if (val === undefined) continue;
      const allowed = m.params?.[key];
      if (!allowed) return `Model "${def.modelId}" does not accept "${key}".`;
      if (!allowed.includes(val)) return `"${key}: ${val}" is not supported by ${def.modelId} (allowed: ${allowed.join(', ')}).`;
    }
    if (def.params?.reference) {
      if (m.params?.references === 0) return `${def.modelId} does not accept reference images according to the catalog.`;
    }
    const kf = def.params?.keyframes;
    const frames = keyframesCount(kf);
    if (kf !== undefined && frames > 1) {
      if (def.type !== 'image_to_video') return 'Keyframes only apply to image → video steps.';
      const max = KEYFRAME_MODELS[def.modelId] ?? 1;
      if (frames > max) return `${def.modelId} accepts at most ${max} keyframe image${max === 1 ? '' : 's'}${max < 5 ? `; use ${PIKAFRAMES} for up to 5` : ''}.`;
    }
    if (def.modelId === PIKAFRAMES && frames < 2) return 'Pikaframes needs "keyframes" set to 2–5.';
    if (t.provider !== 'fal' && (def.params?.duration !== undefined || def.params?.prompt_expansion_mode !== undefined)) return 'duration/prompt expansion only apply to video steps.';
    return null;
  }

  recordTest(modelId: string, stepType: StepType, state: 'tested-successfully' | 'failed', note: string | null, elapsedMs: number | null) {
    this.db.prepare('INSERT INTO model_tests(model_id, step_type, state, note, elapsed_ms, tested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(model_id, step_type) DO UPDATE SET state=excluded.state, note=excluded.note, elapsed_ms=excluded.elapsed_ms, tested_at=excluded.tested_at')
      .run(modelId, stepType, state, note, elapsedMs, now());
  }
}
