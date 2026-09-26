import { useEffect, useRef, useState } from 'react';
import { WORD_GAMES, type PresentStage, type StepType } from '../../shared/types.ts';
import { cx } from './util.tsx';
import { MascotDance } from './MascotDance.tsx';

/**
 * The projector's "while we wait" experience: what is happening in plain words, how far along it probably
 * is, and a playful soundtrack. Everything here is local to the projector window and sends nothing anywhere.
 */

// ---- what is happening -------------------------------------------------------------

const who = (modelId?: string) => {
  if (!modelId) return 'The model';
  if (modelId.startsWith('claude-cli/')) return `Claude ${modelId.split('/')[1].replace(/^\w/, (c) => c.toUpperCase())}`;
  if (modelId.startsWith('local/')) return 'The laptop’s own model';
  const name = modelId.split('/').pop()!;
  return name.replace(/-/g, ' ').replace(/\b(\w)/g, (c) => c.toUpperCase());
};

const DOING: Record<StepType, [string, string]> = {
  image_to_text: ['is looking at the picture', 'and writing down what it sees'],
  text_to_image: ['is painting the description', 'without ever seeing the picture before it'],
  text_to_text: ['is retelling it', 'in its own words'],
  image_to_video: ['is filming a short clip', 'video takes a minute: good time for a question'],
  text_to_video: ['is filming the scene', 'video takes a minute: good time for a question'],
  text_to_svg: ['is hand-writing SVG code', 'every shape is a line of code, then we render it'],
  image_to_svg: ['is tracing the picture in SVG code', 'rebuilding it shape by shape'],
  text_to_ascii: ['is typing ASCII art', 'one character at a time'],
  text_to_code_image: ['is building a 3D scene in three.js', 'writing the code, then we photograph it'],
  text_to_code_video: ['is coding an animation', 'writing the code, then we film it'],
  text_to_audio: ['is recording a voice-over', 'reading it aloud'],
  audio_to_text: ['is listening', 'and writing down what it hears'],
};

export function describeStage(s: PresentStage): { title: string; sub: string } {
  const name = who(s.modelId);
  if (s.game) {
    const g = WORD_GAMES[s.game];
    const verb: Record<string, string> = { emoji: 'is translating it into emoji', unemoji: 'is decoding the emoji', haiku: 'is squeezing it into a haiku', unhaiku: 'is unpacking the haiku', noir: 'is narrating it like a noir detective' };
    return { title: `${name} ${verb[s.game] ?? g.label.toLowerCase()}`, sub: g.label };
  }
  const [a, b] = s.type ? DOING[s.type] : ['is working', ''];
  return { title: `${name} ${a}`, sub: b };
}

const PATIENCE = ['Each player only sees the one before it.', 'No peeking at the original allowed.', 'Meaning is about to drift…', 'Place your bets: what survives?', 'This is the game of telephone, but every player is a model.'];

/** Big, friendly waiting card for the running stage. */
/** `compact`: the side-by-side layout next to the step's input. */
export function WaitingStage({ stage, elapsedSec, icon, mascot, compact }: { stage: PresentStage; elapsedSec: number; icon: string; mascot?: React.ReactNode; compact?: boolean }) {
  const { title, sub } = describeStage(stage);
  const eta = stage.etaSec;
  const pct = eta ? Math.min(0.96, elapsedSec / eta) : null;
  const late = eta ? elapsedSec > eta * 1.3 : false;
  const [line, setLine] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setLine((n) => n + 1), 6000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="relative flex items-center justify-center" style={{ height: compact ? '26vh' : '34vh', width: compact ? '26vh' : '34vh' }}>
        {mascot ?? <MascotDance clip={stage.type === 'image_to_text' || stage.type === 'audio_to_text' ? 'think' : 'dance'} />}
        <div className="absolute right-[4%] bottom-[6%] rounded-full bg-black/60 px-[0.6vw] py-[0.3vh] backdrop-blur" style={{ fontSize: 'clamp(14px, 2.2vh, 34px)' }}>{icon}</div>
      </div>
      <div className="mt-[2vh] font-medium text-neutral-100" style={{ fontSize: compact ? 'clamp(16px, 2vw, 40px)' : 'clamp(20px, 2.8vw, 54px)' }}>{title}…</div>
      {sub && <div className="mt-[0.8vh] text-neutral-400" style={{ fontSize: compact ? 'clamp(11px, 1.1vw, 22px)' : 'clamp(12px, 1.4vw, 26px)' }}>{sub}</div>}
      <div className={cx('mt-[3vh]', compact ? 'w-full max-w-[34vw]' : 'w-[min(46vw,760px)]')}>
        <div className="h-[0.9vh] overflow-hidden rounded-full bg-white/10">
          {pct !== null ? (
            <div className="h-full rounded-full bg-gradient-to-r from-sky-500 via-fuchsia-500 to-amber-400 transition-[width] duration-500" style={{ width: `${Math.round(pct * 100)}%` }} />
          ) : (
            <div className="h-full w-1/3 animate-[slide_1.6s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-sky-500 via-fuchsia-500 to-amber-400" />
          )}
        </div>
        <div className="mt-[1vh] flex justify-between font-mono text-neutral-500" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>
          <span>step {stage.stage} · {elapsedSec}s</span>
          <span>{late ? 'taking a little longer than usual…' : eta ? `usually ~${eta}s` : ''}</span>
        </div>
      </div>
      <div key={line} className="mt-[3vh] animate-[fadein_0.8s_ease] text-neutral-500 italic" style={{ fontSize: 'clamp(11px, 1.1vw, 20px)' }}>
        {PATIENCE[line % PATIENCE.length]}
      </div>
    </div>
  );
}

// ---- sound -------------------------------------------------------------------------------

/**
 * A tiny original chiptune, synthesized live with WebAudio (no files, nothing to license): a bouncy arpeggio,
 * a bass line and a hi-hat, looping while a step generates. `jingle()` plays a short fanfare when a step lands.
 */
class Chiptune {
  ctx: AudioContext;
  out: GainNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextAt = 0;
  private noise: AudioBuffer;
  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.0;
    this.out.connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.05, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private note(freq: number, at: number, dur: number, type: OscillatorType, vol: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.out);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private hat(at: number, vol: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
    s.connect(f).connect(g).connect(this.out);
    s.start(at);
  }

  // an original four-chord loop (C · Am · F · G), 16 sixteenths per chord
  private static CHORDS = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]];
  private static ARP = [0, 1, 2, 3, 2, 1, 0, 2, 3, 2, 1, 3, 2, 0, 1, 2];
  private static hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

  start() {
    if (this.timer) return;
    void this.ctx.resume();
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0.35, now, 0.4); // fade in
    this.nextAt = now + 0.05;
    const sixteenth = 60 / 132 / 4;
    this.timer = setInterval(() => {
      while (this.nextAt < this.ctx.currentTime + 0.25) {
        const bar = Math.floor(this.step / 16) % 4, i = this.step % 16;
        const chord = Chiptune.CHORDS[bar];
        this.note(Chiptune.hz(chord[Chiptune.ARP[i]] + 12), this.nextAt, sixteenth * 0.9, 'square', 0.05);
        if (i % 4 === 0) this.note(Chiptune.hz(chord[0] - 24), this.nextAt, sixteenth * 3.2, 'triangle', 0.22);
        if (i % 2 === 1) this.hat(this.nextAt, i % 4 === 3 ? 0.05 : 0.025);
        this.nextAt += sixteenth;
        this.step++;
      }
    }, 50);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.25); // fade out
  }

  jingle() {
    void this.ctx.resume();
    const now = this.ctx.currentTime + 0.02;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0.4, now);
    [72, 76, 79, 84].forEach((m, k) => this.note(Chiptune.hz(m), now + k * 0.08, 0.16, 'square', 0.08));
    this.note(Chiptune.hz(88), now + 0.34, 0.45, 'triangle', 0.15);
  }
}

/**
 * Drives the soundtrack: loops while `playing`, a jingle each time `landed` increases, silent when muted.
 * Browsers only start audio after a user gesture, so the context is created on the first click/key.
 */
export function useSoundtrack(playing: boolean, landed: number, muted: boolean) {
  const tune = useRef<Chiptune | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const unlock = () => { if (!tune.current) tune.current = new Chiptune(); void tune.current.ctx.resume(); setReady(true); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);
  useEffect(() => {
    const t = tune.current;
    if (!t) return;
    if (playing && !muted) t.start(); else t.stop();
  }, [playing, muted, ready]);
  const seen = useRef(landed);
  useEffect(() => {
    if (landed > seen.current && !muted) tune.current?.jingle();
    seen.current = landed;
  }, [landed, muted]);
  useEffect(() => () => { tune.current?.stop(); void tune.current?.ctx.close(); }, []);
  return ready;
}
