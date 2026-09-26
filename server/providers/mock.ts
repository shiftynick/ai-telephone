import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { StepAdapter, StepRequest, StepResult } from './types.ts';
import { STEP_TYPES } from '../../shared/types.ts';

/**
 * Offline stand-in for both providers (MOCK_PROVIDERS=1 and tests). Every call is recorded so tests
 * can prove what a step was — and was not — given. Output varies per call: no hidden memoization.
 */
export class MockAdapter implements StepAdapter {
  calls: StepRequest[] = [];
  delayMs: number;
  tmpDir: string;
  private videoCache: Buffer | null = null;
  private audioCache: Buffer | null = null;
  constructor(tmpDir: string, delayMs = Number(process.env.MOCK_DELAY_MS ?? 300)) {
    this.tmpDir = tmpDir;
    this.delayMs = delayMs;
  }

  async execute(req: StepRequest): Promise<StepResult> {
    this.calls.push(req);
    const n = this.calls.length;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (req.signal.aborted) throw new Error('aborted');
    const base = { costUsd: 0.001, costStatus: 'estimated' as const, providerModel: req.modelId, providerName: 'mock', requestSnapshot: { mock: true, model: req.modelId, instruction: req.instruction } };
    const out = STEP_TYPES[req.type].output;
    if (out === 'text') {
      const seen = req.input.kind === 'text' ? `text of ${req.input.text.length} chars` : `${req.input.kind} of ${req.input.bytes.length} bytes`;
      return { ...base, output: { kind: 'text', text: `Mock description #${n} by ${req.modelId}: a scene derived from ${seen}.` } };
    }
    if (out === 'audio') return { ...base, output: { kind: 'audio', bytes: this.audio() } };
    if (out === 'image') {
      const hue = (n * 67) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="hsl(${hue},55%,35%)"/><circle cx="${200 + ((n * 97) % 560)}" cy="270" r="120" fill="hsl(${(hue + 150) % 360},70%,60%)"/><text x="40" y="80" font-size="44" fill="white" font-family="sans-serif">mock image #${n}</text></svg>`;
      return { ...base, output: { kind: 'image', bytes: await sharp(Buffer.from(svg)).png().toBuffer() } };
    }
    req.onSubmitted?.({ requestId: `mock-req-${n}` });
    return { ...base, providerRequestId: `mock-req-${n}`, expandedPrompt: null, output: { kind: 'video', bytes: this.video() } };
  }

  private audio(): Buffer {
    if (!this.audioCache) {
      const f = path.join(this.tmpDir, `mock_${process.pid}.mp3`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-q:a', '6', f]);
      this.audioCache = fs.readFileSync(f);
      fs.rmSync(f, { force: true });
    }
    return this.audioCache;
  }

  private video(): Buffer {
    if (!this.videoCache) {
      const f = path.join(this.tmpDir, `mock_${process.pid}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f]);
      this.videoCache = fs.readFileSync(f);
      fs.rmSync(f, { force: true });
    }
    return this.videoCache;
  }
}
