import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../db.ts';
import { SPEECH_TONES } from '../../shared/types.ts';
import { ProviderError, scrub, type StepAdapter, type StepRequest, type StepResult } from './types.ts';

const run = promisify(execFile);
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Google Gemini API for the audio steps: text → speech (Gemini TTS) and speech → text (transcription).
 * TTS takes no system instruction; the step instruction is a one-word tone sent as "[tone] script" (see
 * SPEECH_TONES: longer directions in any layout tried — markdown notes, XML tags, "[long direction]",
 * "read this in the style of" — were often spoken aloud).
 */
/** verifyModel: listens back to each speech clip and retries when the direction was read aloud (null = off). */
export type GeminiOpts = { apiKey: string; tmpDir: string; fetchImpl?: typeof fetch; timeoutMs?: number; verifyModel?: string | null };

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
/**
 * True when the clip's opening strays into the performance direction instead of just reading the script.
 * Seen live: the direction read verbatim, or a made-up preamble ("A warm scene on a sill, fast and loud,
 * rising to a crescendo.") before the real reading starts over — so a repeated opening also counts.
 */
export function directionLeaked(transcript: string, direction: string, script: string): boolean {
  const head = words(transcript).slice(0, 40);
  const scriptWords = new Set(words(script));
  const dirOnly = new Set(words(direction).filter((w) => w.length > 3 && !scriptWords.has(w)));
  if (new Set(head.slice(0, 25).filter((w) => dirOnly.has(w))).size >= 2) return true;
  // a one-word tone ("whispering") spoken as the first word(s) — seen live on the Lite TTS model
  if (dirOnly.size === 1 && head.slice(0, 3).some((w) => dirOnly.has(w))) return true;
  const opening = words(script).slice(0, 5).join(' ');
  const text = head.join(' ');
  const first = text.indexOf(opening);
  return opening.split(' ').length === 5 && first >= 0 && text.indexOf(opening, first + 1) >= 0;
}

export class GeminiAdapter implements StepAdapter {
  opts: GeminiOpts;
  constructor(opts: GeminiOpts) {
    this.opts = opts;
  }

  async execute(req: StepRequest): Promise<StepResult> {
    if (req.type === 'text_to_audio') return this.speak(req);
    if (req.type === 'audio_to_text') return this.transcribe(req);
    throw new ProviderError('unsupported', `Gemini adapter cannot run ${req.type}`);
  }

  private async call(model: string, body: unknown, signal: AbortSignal): Promise<any> {
    if (!this.opts.apiKey) throw new ProviderError('auth', 'GEMINI_API_KEY is not configured in .env');
    if (!/^[a-z0-9.-]+$/i.test(model)) throw new ProviderError('bad_request', `Invalid Gemini model id "${model}".`);
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs ?? 180_000)]),
      });
    } catch (e: any) {
      if (signal.aborted) throw new ProviderError('cancelled', 'Cancelled by host.');
      throw new ProviderError('ambiguous', `Connection to Gemini failed or timed out (${scrub(String(e?.message ?? e), [this.opts.apiKey])}); the request may have been billed.`);
    }
    const raw = await res.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch { /* handled below */ }
    if (!res.ok || json?.error) {
      const msg = scrub(String(json?.error?.message ?? raw ?? res.statusText), [this.opts.apiKey]);
      const status = res.status;
      if (status === 401 || status === 403) throw new ProviderError('auth', `Gemini rejected the API key (${status}): ${msg}`);
      if (status === 429) {
        // A per-DAY quota (free tier: 100 TTS requests per model per day) will not clear by waiting a minute.
        const daily = (json?.error?.details ?? []).some((d: any) => (d?.violations ?? []).some((v: any) => /per_?day|PerDay/i.test(`${v?.quotaId} ${v?.quotaMetric}`)));
        if (daily) throw new ProviderError('credits', `Gemini daily quota for ${model} is used up (free tier). Switch this step to another model (each has its own daily quota, e.g. gemini-3.8-flash-lite-tts) or enable billing on the key.`);
        // Per-minute quota: Google says how long to wait (RetryInfo.retryDelay, e.g. "23s").
        const delay = (json?.error?.details ?? []).find((d: any) => d?.retryDelay)?.retryDelay;
        const retryAfterMs = delay ? Math.min(parseFloat(delay) * 1000 + 500, 60_000) : 20_000;
        throw new ProviderError('rate_limited', `Gemini rate limit (429): ${msg}`, { retryable: true, retryAfterMs });
      }
      if (status >= 500) throw new ProviderError('server_error', `Gemini error (${status}): ${msg}`, { retryable: status === 500 || status === 503 });
      throw new ProviderError('bad_request', `Gemini rejected the request (${status}): ${msg}`);
    }
    const cand = json?.candidates?.[0];
    if (json?.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT')
      throw new ProviderError('safety', `Gemini blocked this content (${json?.promptFeedback?.blockReason ?? cand?.finishReason}).`);
    return json;
  }

  private async speak(req: StepRequest): Promise<StepResult> {
    if (req.input.kind !== 'text') throw new ProviderError('unsupported', 'text_to_audio requires a text input');
    const direction = req.instruction.trim();
    if (direction && !(SPEECH_TONES as readonly string[]).includes(direction))
      throw new ProviderError('bad_request', `Speech tone must be one of ${SPEECH_TONES.join(', ')} (or empty); longer directions get read aloud.`);
    const prompt = direction ? `[${direction}] ${req.input.text}` : req.input.text;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.params.voice ?? 'Charon' } } } },
    };
    const json = await this.call(req.modelId, body, req.signal);
    const part = (json?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p?.inlineData?.data);
    if (!part) throw new ProviderError('empty_output', 'Gemini returned no audio.');
    const raw = Buffer.from(part.inlineData.data, 'base64');
    // Guard against a performance that skipped the script (e.g. spoke only the direction): real speech runs
    // at most ~6 words a second, so a clip far shorter than that is not a reading of this text.
    const seconds = pcmSeconds(raw, String(part.inlineData.mimeType ?? ''));
    const words = req.input.text.split(/\s+/).filter(Boolean).length;
    if (seconds != null && words >= 12 && seconds < words / 6)
      throw new ProviderError('empty_output', `Speech was ${seconds.toFixed(1)}s for ${words} words: the model did not read the script. Retrying.`, { retryable: true });
    const bytes = await toMp3(raw, String(part.inlineData.mimeType ?? ''), this.opts.tmpDir);
    // Style direction sometimes gets spoken (seen with every prompt layout tried). Listen back and retry if so.
    const verifier = this.opts.verifyModel === undefined ? 'gemini-3.8-flash' : this.opts.verifyModel; // 2.5 Flash misheard a leaked preamble in testing
    if (direction && verifier) {
      const heard = await this.call(verifier, { contents: [{ parts: [{ text: 'Transcribe the first two sentences of this audio exactly. Return only the transcript.' }, { inlineData: { mimeType: 'audio/mpeg', data: bytes.toString('base64') } }] }] }, req.signal)
        .then((j) => (j?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p?.text === 'string' && !p.thought).map((p: any) => p.text).join(''))
        .catch(() => ''); // the check is best-effort: never fail a good clip because the checker hiccupped
      if (heard && directionLeaked(heard, direction, req.input.text))
        throw new ProviderError('empty_output', `The voice read the performance direction aloud ("${heard.slice(0, 80)}…"). Retrying.`, { retryable: true });
    }
    return {
      output: { kind: 'audio', bytes },
      usage: json?.usageMetadata,
      costUsd: null,
      costStatus: 'unknown',
      providerModel: json?.modelVersion ?? req.modelId,
      providerName: 'google',
      providerRequestId: json?.responseId,
      requestSnapshot: { endpoint: 'generateContent', model: req.modelId, voice: req.params.voice ?? 'Charon', instruction: req.instruction, input: { text: req.input.text } },
    };
  }

  private async transcribe(req: StepRequest): Promise<StepResult> {
    if (req.input.kind !== 'audio') throw new ProviderError('unsupported', 'audio_to_text requires an audio input');
    const body = { contents: [{ parts: [{ text: req.instruction }, { inlineData: { mimeType: req.input.mime, data: req.input.bytes.toString('base64') } }] }] };
    const json = await this.call(req.modelId, body, req.signal);
    // Thinking models may return a thought part first; only final, non-thought text becomes the artifact.
    const parts = (json?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p?.text === 'string' && !p.thought);
    const text = parts.map((p: any) => p.text).join('').trim();
    if (!text) throw new ProviderError('empty_output', 'Gemini returned an empty transcript.');
    return {
      output: { kind: 'text', text },
      usage: json?.usageMetadata,
      costUsd: null,
      costStatus: 'unknown',
      providerModel: json?.modelVersion ?? req.modelId,
      providerName: 'google',
      providerRequestId: json?.responseId,
      requestSnapshot: { endpoint: 'generateContent', model: req.modelId, instruction: req.instruction, input: { audio_sha256: sha256(req.input.bytes), mime: req.input.mime } },
    };
  }
}

/** Length of 16-bit mono PCM audio (WAV or raw), or null when the format is unknown. */
export function pcmSeconds(bytes: Buffer, mime: string): number | null {
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.length > 44) {
    const rate = bytes.readUInt32LE(24), channels = bytes.readUInt16LE(22), bits = bytes.readUInt16LE(34);
    return rate && channels && bits ? (bytes.length - 44) / (rate * channels * (bits / 8)) : null;
  }
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1]);
  return /L16|pcm/i.test(mime) && rate ? bytes.length / (rate * 2) : null;
}

/** Gemini TTS returns WAV (or raw 24 kHz 16-bit PCM when unlabeled); store MP3 so browsers and the next step agree. */
export async function toMp3(bytes: Buffer, mime: string, tmpDir: string): Promise<Buffer> {
  const base = path.join(tmpDir, `tts_${crypto.randomBytes(6).toString('hex')}`);
  const isWav = bytes.toString('latin1', 0, 4) === 'RIFF';
  const src = `${base}.${isWav ? 'wav' : 'pcm'}`;
  const dst = `${base}.mp3`;
  fs.writeFileSync(src, bytes);
  try {
    const rate = /rate=(\d+)/.exec(mime)?.[1] ?? '24000';
    const input = isWav ? ['-i', src] : ['-f', 's16le', '-ar', rate, '-ac', '1', '-i', src];
    await run('ffmpeg', ['-v', 'error', '-y', ...input, '-c:a', 'libmp3lame', '-q:a', '3', dst], { timeout: 60_000 });
    return fs.readFileSync(dst);
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(dst, { force: true });
  }
}
