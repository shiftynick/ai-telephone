import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, get, makeApp } from './helpers.ts';
import { STEP_TYPES, expandRepeats, validateChain } from '../shared/types.ts';

afterEach(closeAll);

describe('built-in presets', () => {
  it('ships a 20-step video-free long game using the fastest tested model per step', async () => {
    const app = await makeApp();
    const presets = (await get(app, '/api/presets')).json().presets;
    const long = presets.find((p: any) => p.id === 'builtin_verylong');
    expect(long).toBeTruthy();
    expect(validateChain(long.startingKind, long.steps)).toEqual([]);
    // stored as one describe/draw pair with a ×10 repeat block; a run unrolls it to 20 flat steps
    expect(long.steps).toHaveLength(2);
    long.steps = expandRepeats(long.steps).steps;
    expect(long.steps).toHaveLength(20);

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

  it('lists the four talk demos first, in order, with no speech', async () => {
    const app = await makeApp();
    const presets = (await get(app, '/api/presets')).json().presets;
    expect(presets.slice(0, 4).map((p: any) => p.id)).toEqual(['builtin_demo1', 'builtin_demo2', 'builtin_demo3', 'builtin_demo4']);
    for (const p of presets.slice(0, 4)) {
      expect(p.startingKind).toBe('image');
      expect(p.steps.some((s: any) => s.type === 'text_to_audio' || s.type === 'audio_to_text')).toBe(false);
    }
    // Demo 1 passes the scene between three model families
    const d1 = presets[0].steps.filter((s: any) => s.type === 'image_to_text').map((s: any) => s.modelId.split('/')[0]);
    expect(new Set(d1).size).toBe(3);
    // Demo 2 uses noir, not haiku
    const d2 = presets[1].steps.map((s: any) => s.instruction).join(' ');
    expect(d2).toMatch(/noir/i);
    expect(d2).not.toMatch(/haiku/i);
    // Demo 4: four storyboard beats (next frame, drawn from the previous image), then a film through all five images
    const d4: any[] = expandRepeats(presets[3].steps).steps;
    expect(d4.map((s: any) => s.type)).toEqual([...Array.from({ length: 4 }, () => ['image_to_text', 'text_to_image']).flat(), 'image_to_video']);
    expect(d4[0].instruction).toMatch(/storyboard/i);
    expect(d4.filter((s: any) => s.type === 'text_to_image').every((s: any) => s.params.reference === 'previous')).toBe(true);
    expect(d4[8].params.keyframes).toBe(5);
  });

  it('every built-in preset is internally valid', async () => {
    const app = await makeApp();
    for (const p of (await get(app, '/api/presets')).json().presets) {
      expect(validateChain(p.startingKind, p.steps), `${p.id} is not a valid chain`).toEqual([]);
      expect(p.steps.length).toBeGreaterThan(0);
    }
  });
});
