// Deterministic checks for Feature 11 (kitchen delight, ticket 11.1).
//
//   npx tsx scripts/kitchen-delight-test.ts
//
// No browser, server or ~/.controlroom file: the scene is drawn into a recording backend (every drawing call
// logged as text) from the busy fixture's own snapshot, and the stores run against stand-in storage.
// Covers the ambient scheduler (frequency, one at a time, seeded), working cues only for working
// characters, reduced motion (static frames, no ambient object, no flourish), the transporter (beam timing,
// queueing, triggers, the pod's new place and the walk paths to it) and the crew panel's remembered state.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Backend } from "../src/galley/backend";

// The stores read localStorage when they load: give them a stand-in we can swap (memory, or one that throws).
type KeyStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const memory = (): KeyStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const throwing: KeyStore = {
  getItem() {
    throw new Error("SecurityError: storage blocked");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
};
let current: KeyStore | "throw-on-access" = memory();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  get() {
    if (current === "throw-on-access") throw new Error("SecurityError: access denied");
    return current;
  },
});

// The office store reads the page URL when it loads (as the other galley checks stub it).
Object.assign(globalThis, { location: { href: "http://127.0.0.1/" } });

const scene = await import("../src/galley/scene");
const { buildGalley } = await import("../src/galley/model");
const { busySnapshot } = await import("../src/data/fixture/busyFixture");
const uiStore = await import("../src/store/ui");
const {
  AMBIENT, AISLE_Y, BEAM_BUSY_MS, BEAM_MS, SPOTS, TOP_BAND_END, TUBE, VIEW, ambientInit, ambientStep, beamSlot, chefIdle, confettiAge, cueBeat, drawGalley,
  HANGOUTS, isWorking, marqueeChase, phaseOf, route, targetFor,
} = scene;
type GalleyModel = import("../src/galley/model").GalleyModel;
type FrameState = import("../src/galley/scene").FrameState;
type Actor = import("../src/galley/scene").Actor;
type AmbientPass = import("../src/galley/scene").AmbientPass;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const section = (t: string) => console.log(`\n${t}`);

// ---------------------------------------------------------------- a recording backend

function recorder(): Backend & { log: string[] } {
  const log: string[] = [];
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const B: Backend & { log: string[] } = {
    log,
    kind: "pixel",
    rect: (x, y, w, h, c, a) => void log.push(`rect ${n(x)} ${n(y)} ${n(w)} ${n(h)} ${c} ${a ?? 1}`),
    box: (x, y, w, h, c, o) => void log.push(`box ${n(x)} ${n(y)} ${n(w)} ${n(h)} ${c} ${JSON.stringify(o ?? {})}`),
    ell: (x, y, rx, ry, c, o) => void log.push(`ell ${n(x)} ${n(y)} ${n(rx)} ${n(ry)} ${c} ${JSON.stringify(o ?? {})}`),
    line: (a, b, c, d, col, w) => void log.push(`line ${n(a)} ${n(b)} ${n(c)} ${n(d)} ${col} ${w ?? 1}`),
    glow: (x, y, r, c, a) => void log.push(`glow ${n(x)} ${n(y)} ${n(r)} ${c} ${a ?? ""}`),
    path: (d, f) => void log.push(`path ${d} ${f}`),
    text: (x, y, t, c, size) => void log.push(`text ${n(x)} ${n(y)} ${t} ${c} ${size}`),
    tw: (t, size) => t.length * size * 0.55,
    clip(x, y, w, h, fn) {
      log.push(`clip ${n(x)} ${n(y)} ${n(w)} ${n(h)}`);
      fn();
      log.push("unclip");
    },
    alpha(a, fn) {
      log.push(`alpha ${n(a)}`);
      fn();
      log.push("unalpha");
    },
    spriteK: (k) => k,
    sprite(x, y, k, fn) {
      log.push(`sprite ${n(x)} ${n(y)} ${n(k)}`);
      fn(B);
      log.push("unsprite");
    },
  };
  return B;
}

/** Everyone standing where they belong (nobody walking or beaming). */
function standing(m: GalleyModel): Map<string, Actor> {
  const actors = new Map<string, Actor>();
  const spotOf = new Map<string, number>();
  for (const c of m.crew) {
    if (c.place === "gone") continue;
    const t = targetFor(m, c, spotOf);
    actors.set(c.id, { x: t.x, y: t.y, moving: false, seated: t.seated, alpha: 1 });
  }
  return actors;
}

function frame(m: GalleyModel, now: number, reduce: boolean, extra: Partial<FrameState> = {}): string[] {
  const B = recorder();
  const f: FrameState = { now, actors: standing(m), selected: null, hover: null, deliveries: [], spotOf: new Map(), reduce, view: { ...VIEW }, ambient: null, ...extra };
  drawGalley(B, m, f);
  return B.log;
}
const firstDiff = (a: string[], b: string[]) => {
  const i = a.findIndex((x, k) => x !== b[k]);
  return i < 0 && a.length === b.length ? null : `call ${i}: ${a[i]} ≠ ${b[i]}`;
};

const busy = buildGalley(busySnapshot());

// ---------------------------------------------------------------- ambient scheduler

section("Ambient scheduler (seeded)");
function run(seed: number, hours: number, stepMs = 100) {
  const s = ambientInit(seed, 0);
  const passes: AmbientPass[] = [];
  let cur: AmbientPass | null = null;
  let overlap = false;
  for (let t = 0; t <= hours * 3_600_000; t += stepMs) {
    const a = ambientStep(s, t, false);
    if (a && a !== cur) {
      if (cur && t < cur.t0 + cur.dur) overlap = true;
      passes.push(a);
    }
    cur = a;
  }
  return { passes, overlap };
}
const A = run(0xc0ffee, 4);
const gaps = A.passes.slice(1).map((p, i) => p.t0 - (A.passes[i].t0 + A.passes[i].dur));
check(`a 4-hour run shows a rare handful of objects (${A.passes.length}; ~${Math.round((4 * 60) / ((AMBIENT.gapMin + AMBIENT.gapMax) / 2 / 60000 + 0.15))} expected)`, A.passes.length >= 30 && A.passes.length <= 90, A.passes.length);
check("the first object waits a full gap (2–6 min)", A.passes[0].t0 >= AMBIENT.gapMin && A.passes[0].t0 <= AMBIENT.gapMax + 100, A.passes[0].t0);
check("every gap is 2–6 minutes", gaps.every((g) => g >= AMBIENT.gapMin && g <= AMBIENT.gapMax + 100), { min: Math.min(...gaps), max: Math.max(...gaps) });
check("every pass lasts 6–12 s", A.passes.every((p) => p.dur >= AMBIENT.passMin && p.dur <= AMBIENT.passMax), A.passes.map((p) => p.dur));
check("one at a time: a pass never starts before the last one ended", !A.overlap && gaps.every((g) => g > 0));
check("all four kinds and both lanes appear", new Set(A.passes.map((p) => p.kind)).size === 4 && new Set(A.passes.map((p) => p.lane)).size === 2);
check("window-lane objects stay inside the panes' height (y 41–49 in panes 37–55)", A.passes.filter((p) => p.lane === "windows").every((p) => p.y >= 41 && p.y <= 49));
check("space-lane objects stay above the hull (y < 24 − 4)", A.passes.filter((p) => p.lane === "space").every((p) => p.y + 4 < 24 && p.y - 4 >= VIEW.y - 1));
const A2 = run(0xc0ffee, 4);
check("the same seed gives the same sequence", JSON.stringify(A.passes) === JSON.stringify(A2.passes));
const B2 = run(42, 4);
check("another seed gives another sequence", JSON.stringify(A.passes) !== JSON.stringify(B2.passes));
{
  const s = ambientInit(7, 0);
  let any = false;
  for (let t = 0; t <= 3 * 3_600_000; t += 250) if (ambientStep(s, t, true)) any = true;
  check("reduced motion: no object in 3 hours", !any);
  const s2 = ambientInit(7, 0);
  let shown: AmbientPass | null = null;
  for (let t = 0; t <= 3_600_000 && !shown; t += 250) shown = ambientStep(s2, t, false);
  check("reduced motion switched on mid-pass removes the object at once", !!shown && ambientStep(s2, shown!.t0 + 100, true) === null && s2.cur === null);
}
{
  // drawn only in its lane, and never under reduced motion
  const pass: AmbientPass = { kind: "duck", lane: "windows", t0: 0, dur: 8000, y: 45, dir: 1 };
  // 600 ms in, the duck is at x ≈ 70: inside the first pane. 4 s in (x ≈ 280) it is behind the wall between panes.
  const withObj = frame(busy, 600, false, { ambient: pass });
  const extra = withObj.length - frame(busy, 600, false, { ambient: null }).length;
  check("the windows-lane object is drawn clipped to a window pane", extra > 0 && withObj.some((l) => /^clip 45 37 /.test(l)), extra);
  check("between panes it is hidden behind the wall (nothing drawn)", firstDiff(frame(busy, 4000, false, { ambient: pass }), frame(busy, 4000, false, { ambient: null })) === null);
  const reduced = frame(busy, 4000, true, { ambient: pass });
  check("reduced motion: an ambient pass handed to the frame is not drawn", firstDiff(reduced, frame(busy, 4000, true)) === null);
}

// ---------------------------------------------------------------- working cues

section("Working cues follow observed state only");
const working = busy.crew.filter(isWorking);
const notWorking = busy.crew.filter((c) => !isWorking(c));
check(`the busy fixture has working characters (${working.map((c) => c.name).join(", ")}) and others`, working.length >= 2 && notWorking.length >= 2);
check("working means a live session in state work", working.every((c) => c.running && c.state === "work") && notWorking.every((c) => !c.running || c.state !== "work"));
let cueOk = true;
for (let t = 0; t < 6000; t += 125) for (const c of busy.crew) if ((cueBeat(c, t, false) >= 0) !== isWorking(c)) cueOk = false;
check("a cue beat exists for working characters and never for needs, review, idle, waiting or off ones", cueOk);
check("phase offsets differ, so cooks never bob in step", new Set(working.map((c) => phaseOf(c.id))).size === working.length);
{
  const beats = new Set(working.map((c) => cueBeat(c, 10_000, false)));
  check("at one moment the working cooks are on different beats", beats.size > 1, [...beats]);
}
{
  // A scene with nothing working (no live scan, no helpers, chef not running, no cook at work) holds still.
  const still: GalleyModel = {
    ...busy,
    helpers: [],
    reviewers: [],
    crew: busy.crew.map((c) => ({ ...c, running: false, state: c.state === "work" ? "idle" : c.state })),
  };
  still.coordinator = still.crew.find((c) => c.place === "island") ?? null;
  still.pods = busy.pods.map((p) => (p.kind === "cook" ? { kind: "cook", member: still.crew.find((c) => c.id === p.member.id)! } : p));
  const d = firstDiff(frame(still, 1000, false), frame(still, 61_337, false));
  check("nothing working → the frame is identical a minute later (no motion runs on its own)", d === null, d);
  const one: GalleyModel = { ...still, crew: still.crew.map((c) => (c.id === "w-29-12" ? { ...c, running: true, state: "work" } : c)) };
  one.pods = still.pods.map((p) => (p.kind === "cook" && p.member.id === "w-29-12" ? { kind: "cook", member: one.crew.find((c) => c.id === "w-29-12")! } : p));
  const frames = new Set([0, 250, 500, 750, 1000, 1250].map((t) => frame(one, t, false).join("\n")));
  check("one cook working → its cue moves through beats", frames.size > 1, frames.size);
}
{
  const coord = busy.coordinator!;
  let still = true;
  for (let t = 0; t < 30_000; t += 250) {
    const i = chefIdle({ ...coord, running: false }, t, false, false);
    if (i.dx || i.dy || i.sip) still = false;
    const r = chefIdle(coord, t, true, false);
    if (r.dx || r.dy || r.sip) still = false;
  }
  check("the chef's idle is still when his session isn't running, and under reduced motion", still);
  const offsets = new Set<string>();
  for (let t = 0; t < 30_000; t += 250) {
    const i = chefIdle(coord, t, false, false);
    offsets.add(`${i.dx},${i.dy},${i.sip}`);
  }
  check("while he runs, he breathes, glances and sips", offsets.size >= 4, [...offsets]);
  // badges keep their place while he sways
  const needsCoord: GalleyModel = { ...busy, crew: busy.crew.map((c) => (c.isLead ? { ...c, state: "needs" as const } : c)) };
  needsCoord.coordinator = needsCoord.crew.find((c) => c.isLead) ?? null;
  const badgeAt = (t: number) => frame(needsCoord, t, false).filter((l) => l.startsWith("text") && l.includes("needs you")).join();
  const seen = new Set<string>();
  for (let t = 0; t < 20_000; t += 250) seen.add(badgeAt(t));
  check("the coordinator's needs-you badge never moves with the idle", seen.size === 1, [...seen]);
}

// ---------------------------------------------------------------- reduced motion

section("Reduced motion: static frames");
{
  const ts = [1000, 1250, 1700, 9_100, 61_000, 3_600_000];
  const amb: AmbientPass = { kind: "comet", lane: "space", t0: 0, dur: 1e12, y: 17, dir: 1 };
  const logs = ts.map((t) => frame(busy, t, true, { ambient: amb }));
  const diffs = logs.slice(1).map((l) => firstDiff(logs[0], l)).filter(Boolean);
  check("the busy scene (working cooks, chef, live scan, helpers) draws the same frame at every moment", diffs.length === 0, diffs[0]);
  const moving = new Set(ts.map((t) => frame(busy, t, false).join("\n")));
  check("…and without reduced motion it does move (the check can fail)", moving.size > 1);
  for (const c of working) {
    const beats = new Set([0, 333, 777, 5000].map((t) => cueBeat(c, t, true)));
    if (beats.size !== 1 || !beats.has(0)) check(`${c.name}'s cue is a single static pose`, false, [...beats]);
  }
  check("every working cue is one static pose under reduced motion", working.every((c) => [0, 333, 777, 5000].every((t) => cueBeat(c, t, true) === 0)));
}

// ---------------------------------------------------------------- MAIN flourish

section("MAIN: running lights and the flourish play only on a real delivery");
{
  const d = { ticket: "29.12", t0: 10_000 };
  const at = (now: number, reduce = false, deliveries = [d]) => ({ now, reduce, deliveries });
  check("no delivery: bulbs hold still and no confetti", marqueeChase(at(12_500, false, [])) === -1);
  check("a delivery with its shutter up: the bulbs chase", marqueeChase(at(12_500)) >= 0);
  check("before the shutter lifts and after it closes: still", marqueeChase(at(11_000)) === -1 && marqueeChase(at(15_300)) === -1);
  check("confetti only in its window (as the shutter lifts)", confettiAge(at(11_900), d) === -1 && confettiAge(at(12_100), d) >= 0 && confettiAge(at(13_500), d) === -1);
  check("reduced motion: no chase and no confetti", marqueeChase(at(12_500, true)) === -1 && confettiAge(at(12_100, true), d) === -1);
}

// ---------------------------------------------------------------- transporter

section("Transporter: same timing and triggers, new place");
check("beam lengths unchanged (520 ms, 300 ms when queued)", BEAM_MS === 520 && BEAM_BUSY_MS === 300);
{
  const q = { free: 0 };
  const a = beamSlot(q, 1000, "in");
  const b = beamSlot(q, 1100, "out");
  const c = beamSlot(q, 1200, "in");
  const d = beamSlot(q, 5000, "out");
  const got = [a, b, c, d].map((x) => [x.kind, x.t0, x.dur]);
  check("beams queue one at a time; a waiting beam runs short; a free pod runs full length", JSON.stringify(got) === JSON.stringify([["in", 1000, 520], ["out", 1520, 300], ["in", 1820, 300], ["out", 5000, 520]]), got);
}
{
  const src = readFileSync(join(ROOT, "src/galley/GalleyCanvas.tsx"), "utf8");
  check("trigger: an observed workflow session start beams in at the pod", src.includes(`} else if (workflow && c.running) {`) && src.includes(`actors.set(c.id, { x: SPOTS.tube.x, y: SPOTS.tube.y, moving: false, seated: false, alpha: 1, beam: slot(now, "in", c.id) });`));
  check("trigger: a finished session beams out only after it reached the pod (reduced motion: it just leaves)", src.includes(`if (c.place === "gone") {\n            if (reduce) actors.delete(c.id);\n            else a.beam = slot(now, "out", c.id);`));
  check("the pod's book is the only beam scheduler (beamSlot)", (src.match(/beamSlot\(/g) ?? []).length === 1 && !/BEAM_(BUSY_)?MS/.test(src));
}
{
  const gone = busy.crew.find((c) => c.running && !c.isLead)!;
  const t = targetFor(busy, { ...gone, place: "gone" }, new Map());
  check("a finished session's target is the pod", t.x === SPOTS.tube.x && t.y === SPOTS.tube.y);
  check("the pod stands in the top band, off the aisle", TUBE.y <= TOP_BAND_END && TUBE.y + 7 < AISLE_Y - 20 && SPOTS.tube.y < TOP_BAND_END);
  check("the pod (pad included) fits between the office (x ≤ 330) and the lounge (x ≥ 384)", TUBE.cx - TUBE.w / 2 - 7 > 330 && TUBE.cx + TUBE.w / 2 + 7 < 384);
  check(
    "the queue spot stands beside the pod (just right of its pad), under the top band and above the aisle",
    SPOTS.tubeQueue.x > TUBE.cx + TUBE.w / 2 && SPOTS.tubeQueue.x - TUBE.cx <= 40 && SPOTS.tubeQueue.y > TUBE.y + 6 && SPOTS.tubeQueue.y < AISLE_Y,
  );
  const stations: [string, { x: number; y: number }][] = [
    ["island", SPOTS.island], ["door", SPOTS.door], ["passQueue", SPOTS.passQueue], ["tubeQueue", SPOTS.tubeQueue],
    ...[0, 1, 2, 3, 4].map((i) => [`pod ${i}`, SPOTS.pod(i)] as [string, { x: number; y: number }]),
    ...SPOTS.pass.map((p, i) => [`pass ${i}`, p] as [string, { x: number; y: number }]),
    ...HANGOUTS.map((h, i) => [`hangout ${i}`, h] as [string, { x: number; y: number }]),
  ];
  const bad: string[] = [];
  for (const [name, p] of stations) {
    for (const [from, to] of [[p, SPOTS.tube], [SPOTS.tube, p]] as const) {
      const path = route(from, to);
      const end = path[path.length - 1];
      if (end.x !== to.x || end.y !== to.y) bad.push(`${name}: ends at ${end.x},${end.y}`);
      let prev = from;
      for (const q of path) {
        if (q.x !== prev.x && q.y !== prev.y) bad.push(`${name}: diagonal step ${prev.x},${prev.y} → ${q.x},${q.y}`);
        // Anything crossing the top band does so only up the pod's own column.
        if (q.x === prev.x && Math.min(q.y, prev.y) < TOP_BAND_END && q.x !== TUBE.cx && name !== "island" && name !== "door" && !name.startsWith("hangout")) bad.push(`${name}: crosses the top band at x ${q.x}`);
        prev = q;
      }
    }
  }
  check(`walk paths reach the pod from every station and back (${stations.length} stations, both ways), along the aisle and up its column`, bad.length === 0, bad.slice(0, 5));

  const toQueue: string[] = [];
  for (const [name, p] of stations) {
    if (name === "tubeQueue") continue;
    for (const [from, to] of [[p, SPOTS.tubeQueue], [SPOTS.tubeQueue, p]] as const) {
      const path = route(from, to);
      const end = path[path.length - 1];
      if (end.x !== to.x || end.y !== to.y) toQueue.push(`${name}: ends at ${end.x},${end.y}`);
      let prev = from;
      for (const q of path) {
        if (q.x !== prev.x && q.y !== prev.y) toQueue.push(`${name}: diagonal step ${prev.x},${prev.y} → ${q.x},${q.y}`);
        prev = q;
      }
    }
  }
  check(`walk paths reach the queue spot from every station and back (${stations.length - 1} stations, both ways), no diagonal steps`, toQueue.length === 0, toQueue.slice(0, 5));
}
{
  // A session queued to beam out never stands on a robot parked at a hangout (review of 546eac9, F1).
  // Every hangout taken and one robot queued, for every pair of robot sizes; boxes read from the drawn hits.
  const { CREW_CHARACTERS } = await import("../src/data/crew");
  const { robotSize } = await import("../src/galley/robots");
  type CrewMember = import("../src/galley/model").CrewMember;
  type Hit = import("../src/galley/scene").Hit;
  const bySize = new Map<string, CrewMember["character"]>();
  for (const id of Object.keys(CREW_CHARACTERS) as CrewMember["character"][]) {
    const s = robotSize(id);
    bySize.set(`${s.w}x${s.h}`, id);
  }
  const kinds = [...bySize.values()];
  const cook = busy.crew.find((c) => c.place === "pod")!;
  // agentHit pads the robot's box by 2 on every side
  const robot = (h: Hit) => ({ x: h.x + 2, y: h.y + 2, w: h.w - 4, h: h.h - 4 });
  const area = (a: Hit, b: Hit) => {
    const [p, q] = [robot(a), robot(b)];
    return Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
  };
  const bad: string[] = [];
  let pairs = 0;
  for (const parkedAs of kinds)
    for (const queuedAs of kinds) {
      const parked: CrewMember[] = HANGOUTS.map((_h, i) => ({ ...cook, id: `park-${i}`, place: "lounge", running: false, ticket: null, character: parkedAs }));
      const queued: CrewMember = { ...cook, id: "queued", character: queuedAs };
      const m: GalleyModel = { ...busy, lounge: parked, crew: [...busy.crew.filter((c) => c.place !== "lounge"), queued, ...parked] };
      const actors = standing(busy);
      const spotOf = new Map<string, number>();
      parked.forEach((c, i) => {
        spotOf.set(c.id, i);
        actors.set(c.id, { x: HANGOUTS[i].x, y: HANGOUTS[i].y, moving: false, seated: HANGOUTS[i].kind !== "floor", alpha: 1 });
      });
      actors.set(queued.id, { x: SPOTS.tube.x, y: SPOTS.tube.y, moving: false, seated: false, alpha: 1, beam: { kind: "out", t0: 99_999, dur: BEAM_BUSY_MS } });
      const hits = drawGalley(recorder(), m, { now: 1000, actors, selected: null, hover: null, deliveries: [], spotOf, reduce: false, view: { ...VIEW }, ambient: null });
      const q = hits.find((h) => h.id === queued.id && h.sub?.startsWith("about to beam out"));
      if (!q) {
        bad.push(`${queuedAs}: no queued robot drawn`);
        continue;
      }
      for (const c of parked) {
        // a parked robot's own box is the last hit it pushes (after its badge, plate or tag)
        const h = hits.filter((x) => x.id === c.id).pop();
        if (!h) {
          bad.push(`${c.id} (${parkedAs}): not drawn`);
          continue;
        }
        pairs++;
        const o = area(q, h);
        if (o > 0) bad.push(`queued ${queuedAs} overlaps ${parkedAs} at ${c.id} (${HANGOUTS[Number(c.id.slice(5))].kind}) by ${o.toFixed(1)}`);
      }
    }
  check(`the queue spot's robot box overlaps no hangout's (${kinds.length} robot sizes × ${HANGOUTS.length} hangouts, ${pairs} pairs)`, bad.length === 0 && pairs === kinds.length * kinds.length * HANGOUTS.length, bad.slice(0, 5));
}

// ---------------------------------------------------------------- the Master Prompter's corner (04.1)

section("Master Prompter: its own spot, clear of everything, reached through the pod");
{
  const { prompterSnapshot } = await import("../src/data/fixture/busyFixture");
  const { PROMPTER_ID } = await import("../src/data/prompter");
  const { BELT, BELT_Y, PROMPTER_TABLE, PROMPTER_TAGS_X, SUBS, SUBS_Y, prompterBadge } = scene;
  type Hit = import("../src/galley/scene").Hit;
  type CrewMember = import("../src/galley/model").CrewMember;
  const P = SPOTS.prompter;
  const withPrompter = buildGalley(prompterSnapshot("work"));
  const alien = withPrompter.prompter;
  check("the prompter fixture puts the alien in the model, at its own place", !!alien && alien.place === "prompter" && alien.character === "alien" && withPrompter.crew.filter((c) => c.place === "prompter").length === 1);
  check("its target is its own spot (P), in every state, running or not", ["work", "idle", "needs", "off"].every((ph) => {
    const m = buildGalley(prompterSnapshot(ph));
    const t = targetFor(m, m.prompter!, new Map());
    return t.x === P.x && t.y === P.y && m.prompter!.place === "prompter";
  }));
  check("a session ending never sends it to the pod (it stays at its table, dimmed and 'not running')", buildGalley(prompterSnapshot("off")).prompter!.place === "prompter" && prompterBadge(buildGalley(prompterSnapshot("off")).prompter!).words === "not running");
  check("the spot is in the open floor between the subagent stations and the belt, at the left", P.y > SUBS_Y + SUBS.h && P.y < BELT_Y - 1 && P.x > SUBS.x && P.x < SPOTS.passQueue.x - 40);

  // Walk paths: to and from the pod and its queue spot (the only walks it makes: it arrives and leaves through
  // the pod), and every upper-band station, along the aisle and down the lane, no diagonal steps. Walks between
  // two lower-band spots (the pass) are route()'s own straight line and the alien never makes one.
  const bad: string[] = [];
  for (const goal of [SPOTS.tube, SPOTS.tubeQueue, SPOTS.door, SPOTS.island, ...[0, 1, 2, 3, 4].map((i) => SPOTS.pod(i)), ...HANGOUTS.filter((h) => h.y < SUBS_Y)])
    for (const [from, to] of [[P, goal], [goal, P]] as const) {
      const path = route(from, to);
      const end = path[path.length - 1];
      if (end.x !== to.x || end.y !== to.y) bad.push(`→ ${to.x},${to.y}: ends at ${end.x},${end.y}`);
      let prev = from;
      for (const q of path) {
        if (q.x !== prev.x && q.y !== prev.y) bad.push(`diagonal ${prev.x},${prev.y} → ${q.x},${q.y}`);
        // As for every station: only the island, the door and the couch seats are themselves in the top band.
        const inTop = [SPOTS.island, SPOTS.door, ...HANGOUTS].some((s) => s === to || s === from);
        if (q.x === prev.x && Math.min(q.y, prev.y) < TOP_BAND_END && q.x !== TUBE.cx && !inTop) bad.push(`crosses the top band at x ${q.x}`);
        // Down in the lower band it walks only along its own row or the lane, never through the stations.
        if (q.y === prev.y && q.y > SUBS_Y && q.y < BELT_Y && q.y !== P.y && !SPOTS.pass.some((s) => s.y === q.y) && q.y !== SPOTS.passQueue.y) bad.push(`walks across the lower band at y ${q.y}`);
        prev = q;
      }
    }
  check("walk paths reach the alien's spot from the pod, its queue spot and every station, and back (no diagonals, top band only up the pod)", bad.length === 0, bad.slice(0, 5));
  const fromPod = route(SPOTS.tube, P);
  check("arriving from the pod it goes down the pod's column, along the aisle, down the lane, then along its own row", JSON.stringify(fromPod) === JSON.stringify([{ x: TUBE.cx, y: AISLE_Y }, { x: 336, y: AISLE_Y }, { x: 336, y: P.y }, { x: P.x, y: P.y }]), fromPod);

  // Overlap: the alien, its table, badge and plate against everything else drawn, in a full kitchen, at the
  // room's robot scale and at the largest scale pixel art rounds a sprite to (k × 1.15).
  const area = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const robotOf = (h: Hit) => ({ x: h.x + 2, y: h.y + 2, w: h.w - 4, h: h.h - 4 });
  const cook = withPrompter.crew.find((c) => c.place === "pod")!;
  const rev = withPrompter.crew.find((c) => c.place === "pass")!;
  const problems: string[] = [];
  let compared = 0;
  for (const grow of [1, 1.15])
    for (const phase of ["work", "idle", "needs", "off"]) {
      const base = buildGalley(prompterSnapshot(phase));
      // Every pod taken, every hangout taken, both pass spots and the pass queue, a queued beam-out, every helper station.
      const cooks: CrewMember[] = [0, 1, 2, 3, 4].map((i) => ({ ...cook, id: `cook-${i}`, ticket: `9${i}.10`, state: i === 1 ? "needs" : "work" }));
      const reviewers: CrewMember[] = [0, 1, 2].map((i) => ({ ...rev, id: `rev-${i}`, ticket: `8${i}.10`, state: i === 2 ? "needs" : "review" }));
      const parked: CrewMember[] = HANGOUTS.map((_h, i) => ({ ...cook, id: `park-${i}`, place: "lounge", running: false, ticket: `7${i}.1`, state: "off" }));
      const queued: CrewMember = { ...cook, id: "queued", ticket: "60.1" };
      const helpers = [0, 1, 2, 3, 4].map((i) => ({ ...(base.allHelpers[0] ?? { id: "h", type: "Explore", label: "search", parent: "coordinator", finished: false }), id: `helper-${i}`, type: "general-purpose", finished: false }));
      const m: GalleyModel = {
        ...base, pods: cooks.map((c) => ({ kind: "cook", member: c })), reviewers, lounge: parked, helpers, podOverflow: 2,
        crew: [...base.crew.filter((c) => c.place === "island" || c.place === "prompter"), ...cooks, ...reviewers, ...parked, queued],
      };
      const actors = new Map<string, Actor>();
      const spotOf = new Map<string, number>();
      for (const c of m.crew) {
        const t = targetFor(m, c, spotOf);
        actors.set(c.id, { x: t.x, y: t.y, moving: false, seated: t.seated, alpha: 1 });
      }
      parked.forEach((c, i) => (spotOf.set(c.id, i), actors.set(c.id, { x: HANGOUTS[i].x, y: HANGOUTS[i].y, moving: false, seated: HANGOUTS[i].kind !== "floor", alpha: 1 })));
      actors.set(queued.id, { x: SPOTS.tube.x, y: SPOTS.tube.y, moving: false, seated: false, alpha: 1, beam: { kind: "out", t0: 99_999, dur: BEAM_BUSY_MS } });
      const B = recorder();
      B.spriteK = (k) => k * grow;
      const hits = drawGalley(B, m, { now: 1000, actors, selected: null, hover: null, deliveries: [{ ticket: "29.12", t0: 0 }], spotOf, reduce: false, view: { ...VIEW }, ambient: null });
      const mine = hits.filter((h) => h.id === PROMPTER_ID);
      const body = mine.find((h) => h.kind === "agent" && h.sub?.includes("never takes a ticket") && h.w < 40 && h.h > 20);
      if (mine.length < 3 || !body) {
        problems.push(`${phase}×${grow}: the alien, its plate and its badge are not all drawn (${mine.length} hits)`);
        continue;
      }
      const tb = { x: PROMPTER_TABLE.cx - 14, y: PROMPTER_TABLE.y - 27, w: 28, h: 30 };
      const ours = [{ name: "robot", box: robotOf(body) }, { name: "table", box: tb }, ...mine.filter((h) => h !== body).map((h, i) => ({ name: `tag ${i}`, box: h }))];
      // Others: every other hit (robots, plates, badges, board, pass, MAIN, helpers, the pod), plus the belt and the stations area.
      const others = [
        ...hits.filter((h) => h.id !== PROMPTER_ID).map((h) => ({ name: `${h.kind}:${h.id ?? h.title}`, box: h.kind === "agent" && h.h > 20 && h.w < 40 ? robotOf(h) : h })),
        { name: "belt", box: { x: BELT.x0, y: BELT.y - 1, w: BELT.x1 - BELT.x0 + 4, h: 14 } },
        { name: "subagent stations", box: { x: SUBS.x, y: SUBS.y, w: SUBS.w, h: SUBS.h } },
        { name: "pass queue", box: { x: SPOTS.passQueue.x - 16, y: SPOTS.passQueue.y - 40, w: 32, h: 40 } },
        { name: "tube queue", box: { x: SPOTS.tubeQueue.x - 16, y: SPOTS.tubeQueue.y - 40, w: 32, h: 40 } },
      ];
      for (const o of ours)
        for (const x of others) {
          compared++;
          const a = area(o.box, x.box);
          if (a > 0) problems.push(`${phase}×${grow}: alien ${o.name} overlaps ${x.name} by ${a.toFixed(1)}`);
        }
      // Its own parts stay apart too: the robot never stands on its table or under its tags.
      for (const [i, o] of ours.entries()) for (const p of ours.slice(i + 1)) if (o.name === "robot" || p.name === "robot") if (area(o.box, p.box) > 0) problems.push(`${phase}×${grow}: robot overlaps its ${o.name === "robot" ? p.name : o.name}`);
      if (Math.min(...mine.filter((h) => h !== body).map((h) => h.x)) < PROMPTER_TAGS_X - 0.5) problems.push(`${phase}×${grow}: a tag starts left of PROMPTER_TAGS_X`);
    }
  check(`the alien, its table, badge and plate overlap nothing else in a full kitchen (4 states × 2 scales, ${compared} pairs)`, problems.length === 0 && compared > 400, problems.slice(0, 6));

  // A custom name is shortened so the plate never runs into the pass queue.
  {
    const long = buildGalley(prompterSnapshot("idle"));
    long.prompter = { ...long.prompter!, name: "Zorbo the Very Patient Al" };
    long.crew = long.crew.map((c) => (c.id === PROMPTER_ID ? long.prompter! : c));
    const hits = drawGalley(recorder(), long, { now: 1000, actors: standing(long), selected: null, hover: null, deliveries: [], spotOf: new Map(), reduce: false, view: { ...VIEW }, ambient: null });
    const right = Math.max(...hits.filter((h) => h.id === PROMPTER_ID).map((h) => h.x + h.w));
    check("a long custom name is shortened: its plate ends well before the pass queue", right < SPOTS.passQueue.x - 20, right);
  }

  // Cues: only for the observed working state; still under reduced motion.
  const still = (m: GalleyModel): GalleyModel => {
    const crew = m.crew.map((c) => (c.place === "prompter" ? c : { ...c, running: false, state: c.state === "work" ? ("idle" as const) : c.state }));
    const out: GalleyModel = { ...m, helpers: [], reviewers: [], crew, prompter: crew.find((c) => c.place === "prompter") ?? null };
    out.coordinator = crew.find((c) => c.place === "island") ?? null;
    out.pods = m.pods.map((p) => (p.kind === "cook" ? { kind: "cook", member: crew.find((c) => c.id === p.member.id)! } : p));
    return out;
  };
  for (const ph of ["idle", "needs", "off"]) {
    const m = still(buildGalley(prompterSnapshot(ph)));
    check(`prompter ${ph}: no working cue, and the scene holds still a minute later`, cueBeat(m.prompter!, 5000, false) === -1 && firstDiff(frame(m, 1000, false), frame(m, 61_337, false)) === null);
  }
  {
    const m = still(buildGalley(prompterSnapshot("work")));
    const frames = new Set([0, 250, 500, 750, 1000, 1250].map((t) => frame(m, t, false).join("\n")));
    check("prompter working: its table's cue moves through beats", isWorking(m.prompter!) && frames.size > 1, frames.size);
    const reduced = [0, 333, 1250, 61_000].map((t) => frame(m, t, true));
    check("prompter working, reduced motion: one still pose at every moment", reduced.slice(1).every((l) => firstDiff(reduced[0], l) === null));
  }

  // Arrivals and departures go through the pod; a session ending does not beam it out.
  const src = readFileSync(join(ROOT, "src/galley/GalleyCanvas.tsx"), "utf8");
  check("arrival: a newly added prompter beams in at the pod (not on a first paint or with reduced motion)", src.includes(`} else if (c.place === "prompter") {\n            // The Master Prompter was just added: it beams in through the transporter too, then floats to its table.\n            actors.set(c.id, { x: SPOTS.tube.x, y: SPOTS.tube.y, moving: false, seated: false, alpha: 1, beam: slot(now, "in", c.id) });`));
  check("departure: only a removed prompter walks to the pod and beams out (as a 'gone' member, then dropped)", src.includes(`if (c.place === "prompter" && actors.has(c.id) && !model.crew.some((x) => x.id === c.id)) leaving.set(c.id, { ...c, place: "gone"`) && src.includes(`if (first || reduce) leaving.clear();`));
}

// ---------------------------------------------------------------- crew panel collapse

section("Crew panel: collapse is remembered, and storage failures fall back safely");
{
  const { ui, useUi, readCrewCollapsed, writeCrewCollapsed } = uiStore;
  const store = memory();
  current = store;
  check("starts expanded when nothing is stored", useUi.getState().crewCollapsed === false && readCrewCollapsed(store) === false);
  ui.toggleCrew();
  check("collapsing stores it", useUi.getState().crewCollapsed === true && store.data.get("thepass.crewCollapsed") === "1");
  check("a later load reads it back", readCrewCollapsed(store) === true);
  ui.toggleCrew();
  check("expanding stores that too", useUi.getState().crewCollapsed === false && store.data.get("thepass.crewCollapsed") === "0" && readCrewCollapsed(store) === false);
  store.data.set("thepass.crewCollapsed", "banana");
  check("an unknown stored value reads as expanded", readCrewCollapsed(store) === false);
  let threw = false;
  try {
    current = throwing;
    ui.toggleCrew();
    check("getItem/setItem throwing: the toggle still works for this session", useUi.getState().crewCollapsed === true);
    check("…and reading falls back to expanded", readCrewCollapsed(throwing) === false);
    current = "throw-on-access";
    ui.toggleCrew();
    check("localStorage itself throwing on access: still toggles", useUi.getState().crewCollapsed === false);
    check("…and reads as expanded", readCrewCollapsed() === false);
    writeCrewCollapsed(true);
    writeCrewCollapsed(true, null);
  } catch (e) {
    threw = true;
    check("no storage failure escapes", false, (e as Error).message);
  }
  check("no storage failure escapes", !threw);
}

console.log(`\n${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
