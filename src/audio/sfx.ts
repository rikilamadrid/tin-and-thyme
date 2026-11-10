// The Pass · sound effects, synthesized locally with Web Audio (no audio files, nothing fetched).
//
// Six short cues, each with its own character:
//   needs     — a clear rising two-note call (the loudest and easiest to recognise)
//   arrive    — a soft rising shimmer: a session beams in
//   handoff   — a falling shimmer and a chirp: a session handed off and beamed out
//   moved     — a short mechanical tick
//   milestone — a small three-note success chime
//   merged    — a delivery: a rail whoosh, a soft thump, then a bell
//
// Nothing plays unless Settings → Audio → Sound effects is on. The browser only
// lets audio start from a user action, so turning the setting on creates and
// resumes the audio context inside that click.

import { usePrefs } from "../store/prefs";

export type Cue = "needs" | "arrive" | "handoff" | "moved" | "milestone" | "merged";

export const CUES: { id: Cue; label: string; when: string }[] = [
  { id: "needs", label: "Needs you", when: "A new human decision opens (a gate or an agent asking)" },
  { id: "arrive", label: "Beam in", when: "A worker's session starts and it beams in through the transporter" },
  { id: "handoff", label: "Handed off", when: "A worker records its next stage and beams out (never an interrupted or failed stop)" },
  { id: "moved", label: "Ticket moved", when: "A ticket changes board columns" },
  { id: "milestone", label: "Milestone reached", when: "A confirmed workflow milestone, such as a review passing" },
  { id: "merged", label: "Merged into MAIN", when: "A merge is confirmed (never a local commit or an opened PR)" },
];

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): { c: AudioContext; out: GainNode } | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  return { c: ctx, out: master! };
}

/** Call from a user action (the settings toggle): creates and resumes the audio context. */
export function unlockAudio() {
  const a = audio();
  if (a && a.c.state !== "running") void a.c.resume();
}

// Sound saved as on from an earlier visit: the context can only start on the first click or key.
if (typeof window !== "undefined") {
  const wake = () => {
    if (usePrefs.getState().sound) unlockAudio();
  };
  window.addEventListener("pointerdown", wake, { capture: true });
  window.addEventListener("keydown", wake, { capture: true });
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  slideTo?: number;
}

function tone(c: AudioContext, out: AudioNode, t0: number, freq: number, dur: number, o: ToneOpts = {}) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
  const peak = o.gain ?? 0.2;
  const atk = o.attack ?? 0.006;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

let noiseBuf: AudioBuffer | null = null;
function noise(c: AudioContext, out: AudioNode, t0: number, dur: number, o: { gain: number; freq: number; q?: number; sweepTo?: number }) {
  if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = (seed / 2147483647) * 2 - 1;
    }
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = o.q ?? 1.4;
  bp.frequency.setValueAtTime(o.freq, t0);
  if (o.sweepTo) bp.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + Math.min(0.04, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const SYNTH: Record<Cue, (c: AudioContext, out: AudioNode, t: number) => void> = {
  // Rising fifth, E5 → B5, triangle with a soft octave under it: a call you notice.
  needs: (c, out, t) => {
    tone(c, out, t, 659.25, 0.16, { type: "triangle", gain: 0.34 });
    tone(c, out, t, 329.63, 0.16, { type: "sine", gain: 0.1 });
    tone(c, out, t + 0.18, 987.77, 0.3, { type: "triangle", gain: 0.36 });
    tone(c, out, t + 0.18, 493.88, 0.3, { type: "sine", gain: 0.1 });
  },
  // A quiet rising shimmer: filtered air sweeping up, with a soft sine glide under it.
  arrive: (c, out, t) => {
    noise(c, out, t, 0.32, { gain: 0.05, freq: 1800, q: 3, sweepTo: 6400 });
    tone(c, out, t, 520, 0.3, { type: "sine", gain: 0.06, slideTo: 1040 });
  },
  // The shimmer falling away, then a handheld console's "saved" chirp: work handed on.
  handoff: (c, out, t) => {
    noise(c, out, t, 0.28, { gain: 0.05, freq: 6000, q: 3, sweepTo: 1600 });
    tone(c, out, t + 0.22, 1200, 0.06, { type: "square", gain: 0.035, slideTo: 2200 });
    tone(c, out, t + 0.295, 1700, 0.07, { type: "square", gain: 0.03, slideTo: 2900 });
  },
  // A click of filtered noise and a falling blip: a relay or a ticket rail notch.
  moved: (c, out, t) => {
    noise(c, out, t, 0.018, { gain: 0.28, freq: 3200, q: 2.5 });
    tone(c, out, t, 1800, 0.03, { type: "sine", gain: 0.07, slideTo: 900 });
  },
  // C6 E6 G6, bell-like triangle notes overlapping.
  milestone: (c, out, t) => {
    [1046.5, 1318.5, 1568].forEach((f, i) => tone(c, out, t + i * 0.075, f, 0.42, { type: "triangle", gain: 0.13 }));
  },
  // Whoosh along the rail, a thump as it lands, then a bright two-partial bell.
  merged: (c, out, t) => {
    noise(c, out, t, 0.3, { gain: 0.12, freq: 500, q: 1.1, sweepTo: 3600 });
    tone(c, out, t + 0.28, 150, 0.16, { type: "sine", gain: 0.34, slideTo: 60 });
    tone(c, out, t + 0.33, 880, 0.95, { type: "sine", gain: 0.16 });
    tone(c, out, t + 0.33, 1320, 0.7, { type: "sine", gain: 0.08 });
    tone(c, out, t + 0.33, 2640, 0.35, { type: "sine", gain: 0.04 });
  },
};

/** Plays a cue if sound effects are on. Returns whether it played. */
export function playCue(cue: Cue): boolean {
  if (!usePrefs.getState().sound) return false;
  const a = audio();
  if (!a) return false;
  if (a.c.state !== "running") void a.c.resume();
  SYNTH[cue](a.c, a.out, a.c.currentTime + 0.01);
  return true;
}
