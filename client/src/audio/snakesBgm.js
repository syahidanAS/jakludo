// Musik latar Ular Tangga "Jungle Marimba Adventure" (112 BPM, marimba tropis, bass akustik, shaker ringan).
// Berbeda dari musik Electro Pop Arena milik JakLudo; dibuat prosedural lewat Web Audio tanpa file mp3.
import { createSynth, makeImpulse, midi } from './synth';

const BPM = 112;
const STEP = 60 / BPM / 4; // 1/16 step
const LENGTH = 128; // 8 bar
const LOOKAHEAD = 0.15;
const OUTPUT_GAIN = 1.05;

// Progresi akor ceria: C - G - Am - F (dalam MIDI)
const CHORDS = [
  [60, 64, 67], // C
  [59, 62, 67], // G/B
  [57, 60, 64], // Am
  [57, 60, 65]  // F
];
const ROOTS = [36, 43, 45, 41]; // C2, G2, A2, F2

// Melodi marimba ceria & petualang (8 bar diulang dengan variasi oktaf)
const MELODY = new Map(
  [
    [0, 72, 2], [2, 76, 2], [4, 79, 2], [6, 76, 2], [8, 81, 3], [12, 79, 2], [14, 76, 2],
    [16, 74, 2], [18, 79, 2], [20, 83, 2], [22, 79, 2], [24, 77, 3], [28, 74, 2], [30, 71, 2],
    [32, 72, 2], [34, 76, 2], [36, 81, 2], [38, 79, 2], [40, 76, 3], [44, 74, 2], [46, 72, 2],
    [48, 77, 2], [50, 81, 2], [52, 84, 3], [56, 79, 2], [58, 77, 2], [60, 76, 4]
  ].map(([step, note, len]) => [step, [note, len]])
);

export class SnakesBgm {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.step = 0;
    this.volume = 0;
  }

  get playing() {
    return this.timer !== null;
  }

  attach(ctx) {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    this.synth = createSynth(ctx);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -15;
    comp.ratio.value = 3.5;
    comp.connect(ctx.destination);

    this.out = ctx.createGain();
    this.out.gain.value = this.volume * OUTPUT_GAIN;
    this.out.connect(comp);

    this.bus = ctx.createGain();
    this.bus.connect(this.out);

    this.dry = ctx.createGain();
    this.dry.connect(this.out);

    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx, 1.6, 2.5);
    const send = ctx.createGain();
    send.gain.value = 0.28;
    this.bus.connect(send);
    send.connect(verb);
    verb.connect(this.out);
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.out) this.out.gain.setTargetAtTime(volume * OUTPUT_GAIN, this.ctx.currentTime, 0.05);
  }

  start(ctx) {
    this.attach(ctx);
    if (this.timer) return;
    this.next = ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = this.ctx.currentTime;
    if (this.next < now - 0.05) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      this.playStep(this.step % LENGTH, this.next);
      this.next += STEP;
      this.step += 1;
    }
  }

  playStep(step, t) {
    const { tone, noise } = this.synth;
    const bar = Math.floor(step / 16) % 4;
    const b = step % 16;
    const secondHalf = step >= 64;

    // Kick lembut & hangat di ketukan 1 dan 3
    if (b === 0 || b === 8) {
      tone({ t, f: 110, f2: 46, dur: 0.22, gain: 0.52, out: this.dry });
    }

    // Clave / ketukan kayu sinkopasi ala bossa tropis
    if (b === 3 || b === 6 || b === 10 || b === 14) {
      tone({ t, f: 1450, f2: 1180, dur: 0.045, type: 'triangle', gain: 0.09, attack: 0.001, out: this.bus });
    }

    // Shaker ringan di setiap 1/8
    if (b % 2 === 0) {
      const accent = b % 4 === 2;
      noise({ t, dur: 0.03, gain: accent ? 0.038 : 0.02, type: 'highpass', f: 6800, out: this.bus });
    }

    // Bass petik hangat sinkopasi
    if (b === 0 || b === 6 || b === 8 || b === 14) {
      const interval = b === 6 || b === 14 ? 7 : 0;
      tone({
        t,
        f: midi(ROOTS[bar] + interval),
        dur: STEP * 2.4,
        type: 'triangle',
        gain: 0.34,
        attack: 0.004,
        filter: { f: 650, f2: 220, q: 1.5 },
        out: this.dry
      });
    }

    // Pad akor lembut di awal bar
    if (b === 0) {
      CHORDS[bar].forEach(n => {
        tone({
          t,
          f: midi(n),
          dur: STEP * 14,
          type: 'sine',
          gain: 0.04,
          attack: 0.06,
          out: this.bus
        });
      });
    }

    // Melodi marimba utama + harmoni kalimba di paruh kedua
    const note = MELODY.get(step % 64);
    if (note) {
      const f = midi(note[0]);
      const dur = Math.max(note[1] * STEP * 1.1, 0.18);
      tone({ t, f, dur, type: 'sine', gain: 0.16, attack: 0.002, out: this.bus });
      tone({ t, f: f * 2, dur: dur * 0.45, type: 'triangle', gain: 0.045, attack: 0.001, out: this.bus });
      if (secondHalf) {
        tone({ t, f: midi(note[0] + 12), dur: dur * 0.7, type: 'sine', gain: 0.06, attack: 0.002, out: this.bus });
      }
    } else if (b % 4 === 2) {
      // Arpeggio kalimba pengisi celah
      const arpNote = CHORDS[bar][(b / 2) % 3] + 12;
      tone({ t, f: midi(arpNote), dur: 0.16, type: 'sine', gain: 0.055, attack: 0.001, out: this.bus });
    }
  }
}
