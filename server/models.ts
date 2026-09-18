import { type DB, kvGet, kvSet, now } from './db.ts';
import { FAL_ENDPOINTS } from './providers/fal.ts';
import { STEP_TYPES, type ModelEntry, type ModelsView, type StepDefinition, type StepType } from '../shared/types.ts';

export const FAVORITES: Record<StepType, string[]> = {
  image_to_text: ['google/gemini-3.8-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4.6', 'google/gemini-2.5-flash'],
  text_to_text: ['google/gemini-3.8-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4.6'],
  text_to_image: ['google/gemini-3.1-flash-lite-image', 'google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-flare', 'bytedance-seed/seedream-4.5'],
  image_to_video: [FAL_ENDPOINTS.image_to_video],
  text_to_video: [FAL_ENDPOINTS.text_to_video],
};

type Catalog = { chat: any[]; image: any[]; imageParams: Record<string, { aspect_ratio?: string[]; resolution?: string[] }> };
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
          const model = { aspect_ratio: enumVals(m.supported_parameters?.aspect_ratio), resolution: enumVals(m.supported_parameters?.resolution) };
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
            imageParams[m.id] = eps.length ? { aspect_ratio: inter('aspect_ratio'), resolution: inter('resolution') } : model;
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
    const add = (id: string, name: string, provider: 'openrouter' | 'fal', type: StepType, source: string, params?: ModelEntry['params']) => {
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
        if (!o.includes('text') || imageIds.has(m.id)) continue;
        if (i.includes('image')) add(m.id, m.name, 'openrouter', 'image_to_text', 'OpenRouter Models API');
        if (i.includes('text')) add(m.id, m.name, 'openrouter', 'text_to_text', 'OpenRouter Models API');
      }
      for (const m of c.value.image) add(m.id, m.name, 'openrouter', 'text_to_image', 'OpenRouter Image Models API', c.value.imageParams[m.id]);
    }
    const falParams = { resolution: ['480P', '768P'] };
    add(FAL_ENDPOINTS.image_to_video, 'MiniMax H3 Max Turbo (image → video)', 'fal', 'image_to_video', 'fal endpoint schema (built-in adapter)', falParams);
    add(FAL_ENDPOINTS.text_to_video, 'MiniMax H3 Max Turbo (text → video)', 'fal', 'text_to_video', 'fal endpoint schema (built-in adapter)', falParams);
    const models = [...byId.values()].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.id.localeCompare(b.id));
    return { refreshedAt: c?.updatedAt ?? null, stale: !c || now() - c.updatedAt > STALE_MS || !!this.lastError, error: this.lastError, models };
  }

  /** Manual IDs and imported presets go through the same gate: unknown or incompatible → explained rejection. */
  validateStep(def: StepDefinition): string | null {
    const v = this.view();
    const m = v.models.find((x) => x.id === def.modelId);
    const t = STEP_TYPES[def.type];
    if (!m) {
      if (!v.refreshedAt && t.provider === 'openrouter') return null; // no catalog at all (offline first boot): cannot judge
      return `Model "${def.modelId}" is not in the ${t.provider === 'fal' ? 'supported fal endpoint list (a new endpoint needs an adapter)' : 'OpenRouter catalog'}.`;
    }
    if (!m.stepTypes.includes(def.type)) return `Model "${def.modelId}" does not support ${t.label} according to the catalog.`;
    for (const key of ['aspect_ratio', 'resolution'] as const) {
      const val = def.params?.[key];
      if (val === undefined) continue;
      const allowed = m.params?.[key];
      if (!allowed) return `Model "${def.modelId}" does not accept "${key}".`;
      if (!allowed.includes(val)) return `"${key}: ${val}" is not supported by ${def.modelId} (allowed: ${allowed.join(', ')}).`;
    }
    if (t.provider !== 'fal' && (def.params?.duration !== undefined || def.params?.prompt_expansion_mode !== undefined)) return 'duration/prompt expansion only apply to video steps.';
    return null;
  }

  recordTest(modelId: string, stepType: StepType, state: 'tested-successfully' | 'failed', note: string | null, elapsedMs: number | null) {
    this.db.prepare('INSERT INTO model_tests(model_id, step_type, state, note, elapsed_ms, tested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(model_id, step_type) DO UPDATE SET state=excluded.state, note=excluded.note, elapsed_ms=excluded.elapsed_ms, tested_at=excluded.tested_at')
      .run(modelId, stepType, state, note, elapsedMs, now());
  }
}
