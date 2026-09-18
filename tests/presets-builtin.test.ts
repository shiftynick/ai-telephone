import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp } from './helpers.ts';
import { STEP_TYPES, validateChain } from '../shared/types.ts';

afterEach(closeAll);

describe('built-in presets', () => {
  it('ships a 20-step video-free long game using the fastest tested model per step', async () => {
    const app = await makeApp();
    const presets = (await get(app, '/api/presets')).json().presets;
    const long = presets.find((p: any) => p.id === 'builtin_verylong');
    expect(long).toBeTruthy();
    expect(long.steps).toHaveLength(20);
    expect(validateChain(long.startingKind, long.steps)).toEqual([]);

    // alternates describe/generate, starts from the uploaded image, ends on an image
    expect(long.steps.map((s: any) => s.type)).toEqual(
      Array.from({ length: 10 }, () => ['image_to_text', 'text_to_image']).flat(),
    );
    expect(long.steps.every((s: any) => STEP_TYPES[s.type as keyof typeof STEP_TYPES].output !== 'video')).toBe(true);

    // fastest measured models in the 2026-09-18 smoke run
    for (const s of long.steps) {
      expect(s.modelId).toBe(s.type === 'image_to_text' ? 'google/gemini-2.5-flash' : 'google/gemini-3.1-flash-lite-image');
    }
    expect(new Set(long.steps.map((s: any) => s.id)).size).toBe(20); // unique step ids
  });

  it('every built-in preset is internally valid', async () => {
    const app = await makeApp();
    for (const p of (await get(app, '/api/presets')).json().presets) {
      expect(validateChain(p.startingKind, p.steps), `${p.id} is not a valid chain`).toEqual([]);
      expect(p.steps.length).toBeGreaterThan(0);
    }
  });
});
