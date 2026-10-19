// WebAudio sfx synth bank: a fixed set of named sounds built from oscillators and noise.
// No audio files, nothing to load, nothing for CSP to block.
//   const sfx = new Sfx();
//   addEventListener("pointerdown", () => sfx.unlock());   // browsers need one user gesture
//   sfx.play("pickup"); sfx.play("hit", { volume: 0.5, pitch: 1.2, pan: -0.3 });

export type SoundName =
  | "blip" | "click" | "coin" | "pickup" | "powerup" | "jump" | "laser" | "hit"
  | "hurt" | "explode" | "die" | "win" | "lose" | "whoosh" | "step";

type Wave = OscillatorType | "noise";

interface Voice {
  wave: Wave;
  // Start/end frequency, Hz (exponential slide). Noise: lowpass cutoff start/end.
  f0: number;
  f1?: number;
  dur: number;
  vol?: number;
  delay?: number;
  attack?: number;
}

const v = (wave: Wave, f0: number, f1: number | undefined, dur: number, vol = 0.3, delay = 0, attack = 0.005): Voice =>
  ({ wave, f0, f1, dur, vol, delay, attack });

// The bank. Fixed on purpose: games pick names, they do not ship synth code.
export const SOUNDS: Readonly<Record<SoundName, readonly Voice[]>> = {
  blip: [v("square", 880, undefined, 0.05, 0.15)],
  click: [v("triangle", 1200, 600, 0.03, 0.25)],
  coin: [v("square", 988, undefined, 0.07, 0.15), v("square", 1319, undefined, 0.18, 0.15, 0.07)],
  pickup: [v("sine", 660, 1320, 0.12, 0.3)],
  powerup: [v("square", 220, 880, 0.35, 0.12), v("triangle", 440, 1760, 0.3, 0.2, 0.05)],
  jump: [v("square", 300, 700, 0.15, 0.15)],
  laser: [v("sawtooth", 1400, 200, 0.15, 0.15)],
  hit: [v("noise", 3000, 800, 0.08, 0.4), v("square", 160, 60, 0.08, 0.2)],
  hurt: [v("sawtooth", 400, 120, 0.2, 0.2)],
  explode: [v("noise", 1200, 120, 0.6, 0.6), v("sine", 90, 30, 0.45, 0.5)],
  die: [v("square", 440, 55, 0.5, 0.15)],
  win: [v("triangle", 523, undefined, 0.12, 0.3), v("triangle", 659, undefined, 0.12, 0.3, 0.1), v("triangle", 784, undefined, 0.12, 0.3, 0.2), v("triangle", 1047, undefined, 0.35, 0.3, 0.3)],
  lose: [v("triangle", 392, undefined, 0.18, 0.3), v("triangle", 330, undefined, 0.18, 0.3, 0.18), v("triangle", 262, 196, 0.45, 0.3, 0.36)],
  whoosh: [v("noise", 400, 2400, 0.25, 0.3, 0, 0.1)],
  step: [v("noise", 600, 300, 0.03, 0.2)],
};

export const SOUND_NAMES = Object.keys(SOUNDS) as SoundName[];

export interface PlayOpts {
  // 0..1, multiplies the sound's own level.
  volume?: number;
  // Frequency multiplier: 2 = an octave up. Vary it a little (0.9..1.1) so repeats do not drone.
  pitch?: number;
  // -1 (left) .. 1 (right).
  pan?: number;
}

type AudioCtor = new () => AudioContext;

export class Sfx {
  ctx: AudioContext | null = null;
  // Minimum gap between two plays of the same sound, s. 100 players eating at once stays one sound.
  minGap = 0.03;
  // Concurrent voices cap.
  maxVoices = 24;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<SoundName, number>();
  private voices = 0;
  private _volume = 0.5;
  private _muted = false;

  constructor(private ctor: AudioCtor | undefined = (globalThis as { AudioContext?: AudioCtor }).AudioContext) {}

  get volume(): number { return this._volume; }
  set volume(x: number) { this._volume = Math.max(0, Math.min(1, x)); this.applyGain(); }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) { this._muted = m; this.applyGain(); }

  // Create/resume the AudioContext. Call from a user gesture (keydown, pointerdown).
  unlock(): void {
    if (!this.ensure()) return;
    if (this.ctx!.state === "suspended") this.ctx!.resume().catch(() => {});
  }

  play(name: SoundName, o: PlayOpts = {}): boolean {
    const voices = SOUNDS[name];
    if (!voices || this._muted || !this.ensure()) return false;
    const ctx = this.ctx!;
    if (ctx.state !== "running") return false;
    const now = ctx.currentTime;
    if (now - (this.last.get(name) ?? -Infinity) < this.minGap) return false;
    if (this.voices + voices.length > this.maxVoices) return false;
    this.last.set(name, now);
    let out: AudioNode = this.master!;
    if (o.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      p.connect(out);
      out = p;
    }
    for (const vc of voices) this.voice(vc, now, out, o.volume ?? 1, o.pitch ?? 1);
    return true;
  }

  private voice(vc: Voice, now: number, out: AudioNode, volume: number, pitch: number): void {
    const ctx = this.ctx!;
    const t0 = now + (vc.delay ?? 0);
    const t1 = t0 + vc.dur;
    const g = ctx.createGain();
    const peak = Math.max(0.0001, (vc.vol ?? 0.3) * volume);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (vc.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t1);
    g.connect(out);
    let src: AudioScheduledSourceNode;
    if (vc.wave === "noise") {
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer();
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(vc.f0 * pitch, t0);
      if (vc.f1) f.frequency.exponentialRampToValueAtTime(vc.f1 * pitch, t1);
      n.connect(f); f.connect(g);
      src = n;
    } else {
      const osc = ctx.createOscillator();
      osc.type = vc.wave;
      osc.frequency.setValueAtTime(vc.f0 * pitch, t0);
      if (vc.f1) osc.frequency.exponentialRampToValueAtTime(vc.f1 * pitch, t1);
      osc.connect(g);
      src = osc;
    }
    this.voices++;
    src.onended = () => { this.voices--; g.disconnect(); };
    src.start(t0);
    src.stop(t1 + 0.02);
  }

  private ensure(): boolean {
    if (this.ctx) return true;
    if (!this.ctor) return false;
    try { this.ctx = new this.ctor(); } catch { this.ctor = undefined; return false; }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.applyGain();
    return true;
  }

  private applyGain(): void {
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
  }

  // One second of white noise, shared by every noise voice. Seeded LCG: no Math.random.
  private noiseBuffer(): AudioBuffer {
    if (this.noise) return this.noise;
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < d.length; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; d[i] = (s >>> 16) / 32768 - 1; }
    return (this.noise = buf);
  }
}
