import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp, type TestApp } from './helpers.ts';
import type { ModelsView } from '../shared/types.ts';

afterEach(closeAll);

const CHAT = [
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'textonly/writer-1', name: 'Writer 1', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'textonly/writer-1:free', name: 'Writer 1 (free)', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'openrouter/auto', name: 'Auto Router', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
];

const IMAGE = [
  {
    id: 'google/gemini-3.1-flash-lite-image',
    name: 'Nano Banana 2 Lite',
    endpoints: '/api/v1/models/google/gemini-3.1-flash-lite-image/endpoints',
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '16:9', '4:3'] },
      resolution: { type: 'enum', values: ['1K', '2K'] },
    },
  },
  { id: 'someone/other-image', name: 'Other Image', supported_parameters: {} },
];

/** Endpoint-level capabilities are narrower than the model-level union. */
const ENDPOINTS = {
  endpoints: [
    { supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] }, resolution: { type: 'enum', values: ['1K'] } } },
  ],
};

function catalogFetch(state = { fail: false, calls: 0 }): typeof fetch {
  return (async (url: any) => {
    state.calls++;
    const u = String(url);
    if (state.fail) throw new Error('ENOTFOUND openrouter.ai');
    if (u.includes('/images/models')) return new Response(JSON.stringify({ data: IMAGE }), { headers: { 'content-type': 'application/json' } });
    if (u.includes('/endpoints')) return new Response(JSON.stringify(ENDPOINTS), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ data: CHAT }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function catalogApp(state = { fail: false, calls: 0 }): Promise<{ app: TestApp; view: ModelsView }> {
  const app = await makeApp({ catalogFetch: catalogFetch(state) });
  const view = await app.catalog.refresh();
  return { app, view };
}

describe('model catalog', () => {
  it('flags favorites and hides :free / router variants by default', async () => {
    const { view } = await catalogApp();
    const byId = new Map(view.models.map((m) => [m.id, m]));

    expect(byId.get('google/gemini-3.8-flash')!.favorite).toBe(true);
    expect(byId.get('google/gemini-3.8-flash')!.stepTypes.sort()).toEqual(['image_to_text', 'text_to_text']);
    expect(byId.get('google/gemini-3.1-flash-lite-image')!.favorite).toBe(true);
    expect(byId.get('minimax/h3-max-turbo/image-to-video')!.favorite).toBe(true);

    expect(byId.get('textonly/writer-1')!.favorite).toBe(false);
    expect(byId.get('textonly/writer-1')!.hiddenByDefault).toBe(false);
    expect(byId.get('textonly/writer-1:free')!.hiddenByDefault).toBe(true);
    expect(byId.get('openrouter/auto')!.hiddenByDefault).toBe(true);

    // favorites are sorted first
    expect(view.models[0].favorite).toBe(true);
    expect(view.stale).toBe(false);
    expect(view.error).toBeUndefined();
  });

  it('intersects endpoint-level image params rather than trusting the model-level union', async () => {
    const { view } = await catalogApp();
    const lite = view.models.find((m) => m.id === 'google/gemini-3.1-flash-lite-image')!;
    expect(lite.params).toEqual({ aspect_ratio: ['1:1', '16:9'], resolution: ['1K'] });
  });

  it('validateStep rejects a text-only model for image_to_text', async () => {
    const { app } = await catalogApp();
    const msg = app.catalog.validateStep({ id: 's', type: 'image_to_text', modelId: 'textonly/writer-1', instruction: '', params: {} });
    expect(msg).toMatch(/does not support image → text/);
  });

  it('validateStep rejects an unknown model id', async () => {
    const { app } = await catalogApp();
    expect(app.catalog.validateStep({ id: 's', type: 'image_to_text', modelId: 'nope/not-real', instruction: '', params: {} })).toMatch(
      /not in the OpenRouter catalog/,
    );
    expect(app.catalog.validateStep({ id: 's', type: 'image_to_video', modelId: 'somebody/new-endpoint', instruction: '', params: {} })).toMatch(
      /supported fal endpoint list/,
    );
  });

  it('validateStep rejects unsupported aspect_ratio / resolution values', async () => {
    const { app } = await catalogApp();
    const draw = (params: any) => app.catalog.validateStep({ id: 's', type: 'text_to_image', modelId: 'google/gemini-3.1-flash-lite-image', instruction: '', params });
    expect(draw({ aspect_ratio: '16:9' })).toBeNull();
    expect(draw({ aspect_ratio: '21:9' })).toMatch(/not supported by google\/gemini-3.1-flash-lite-image/);
    expect(draw({ resolution: '4K' })).toMatch(/allowed: 1K/);
    expect(draw({ aspect_ratio: '1:1', resolution: '1K' })).toBeNull();
    // a model with no declared params accepts none
    expect(app.catalog.validateStep({ id: 's', type: 'text_to_image', modelId: 'someone/other-image', instruction: '', params: { aspect_ratio: '1:1' } })).toMatch(
      /does not accept "aspect_ratio"/,
    );
    // video-only params are rejected on non-video steps
    expect(app.catalog.validateStep({ id: 's', type: 'text_to_image', modelId: 'someone/other-image', instruction: '', params: { duration: 5 } })).toMatch(
      /only apply to video steps/,
    );
    // fal resolutions are enforced too
    expect(app.catalog.validateStep({ id: 's', type: 'image_to_video', modelId: 'minimax/h3-max-turbo/image-to-video', instruction: '', params: { resolution: '1080P' } })).toMatch(
      /allowed: 480P, 768P/,
    );
  });

  it('retains the old cache and flags stale + error when a later refresh fails; never substitutes models', async () => {
    const state = { fail: false, calls: 0 };
    const { app, view } = await catalogApp(state);
    const before = view.models.map((m) => m.id);
    expect(before).toContain('google/gemini-3.8-flash');

    state.fail = true;
    const stale = await app.catalog.refresh();
    expect(stale.stale).toBe(true);
    expect(stale.error).toMatch(/Catalog refresh failed/);
    expect(stale.refreshedAt).toBe(view.refreshedAt); // the old cache timestamp is kept
    expect(stale.models.map((m) => m.id)).toEqual(before);

    const viaApi = (await get(app, '/api/models')).json();
    expect(viaApi.models.map((m: any) => m.id)).toEqual(before);
    expect(viaApi.stale).toBe(true);
  });

  it('with no catalog at all, an unknown OpenRouter id cannot be judged but a fal id still can', async () => {
    const app = await makeApp(); // noCatalog: refresh always throws
    expect(app.catalog.view().refreshedAt).toBeNull();
    expect(app.catalog.validateStep({ id: 's', type: 'image_to_text', modelId: 'anything/at-all', instruction: '', params: {} })).toBeNull();
    expect(app.catalog.validateStep({ id: 's', type: 'text_to_video', modelId: 'anything/at-all', instruction: '', params: {} })).toMatch(/fal endpoint list/);
  });
});
