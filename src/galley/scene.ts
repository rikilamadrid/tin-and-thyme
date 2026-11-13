// Tin & Thyme · the Space Galley room. One layout for both art styles: every
// position here is shared; the backend decides how a shape is painted.
//
// The room fills most of the centre column; space shows through its windows and a
// narrow margin. Areas explain themselves with furniture, not captions: the only
// words on the floor are ORDERS, MAIN, ticket IDs, names and alerts.
//
//   windows ▸ ORDERS rail │ HEAD CHEF office (glass) │ fridge │ windows ▸ co-op couch
//                                                     │ transporter tube
//   ─────────────── aisle ──────────────────────────────────────────────────────────
//   cooktop pods × 5                                  │ café: range, coffee, stools
//   ─────────────── aisle ──────────────────────────────────────────────────────────
//   subagent stations × 4          reviewer [scanner] reviewer        floor spot
//   ═══════════════════════════ belt ═══════════════════════════════▶ [MAIN hatch]

import type { CharacterId } from "../data/crew";
import { INK, type Backend } from "./backend";
import { COLUMN_NAMES, type CrewMember, type GalleyModel } from "./model";
import { C, drawRobot, icon, robotSize, type IconKind } from "./robots";

// ---------------------------------------------------------------- layout
//
// The room is a stack of horizontal bands, top to bottom. Each band's top is derived from the one above
// plus its gap, so a band can grow (or a new one be inserted) without hand-moving everything below it.
// Every position further down is written against these anchors, never as a bare room coordinate.
//
//   top band     windows, ORDERS, HEAD CHEF office, fridge, lounge     y 32 … TOP_BAND_END
//   GAP.top      open floor under the office
//   prep band    upper aisle, transporter, cooktop pods, café          AISLE_Y …
//   GAP.line     open floor between the prep line and the lower band
//   lower band   subagent stations (left), reviewers at the pass        SUBS_Y …
//   GAP.lower    open floor above the belt
//   belt band    belt, scanner, MAIN hatch                              BELT_Y …
//   GAP.foot     floor below the belt

/** Extra open floor between the bands, in logical units (the room grows by their sum). */
export const GAP = { top: 24, line: 32, lower: 24, foot: 8 };
const GROW = GAP.top + GAP.line + GAP.lower + GAP.foot;

/** Outer walls, and the floor inside them. */
const ROOM = { x: 24, y: 24, w: 512, h: 420 + GROW };
const FLOOR = { x: 32, y: 32, w: 496, h: 404 + GROW };
const FLOOR_BOTTOM = FLOOR.y + FLOOR.h;
/** What Fit frames: the room plus a narrow margin of space around its hull. */
export const VIEW = { x: 12, y: 12, w: ROOM.w + 24, h: ROOM.h + 24 };

/** Where the top band (office, board, lounge) ends. */
export const TOP_BAND_END = 200;
/** The upper aisle: the walking route along the top of the prep band. */
export const AISLE_Y = TOP_BAND_END + 14 + GAP.top;
/** The prep line (cooktop pods). */
export const LY = AISLE_Y + 10;
/** The lower band: the subagent stations. Anything at or below it is reached down the lane. */
export const SUBS_Y = LY + 76 + GAP.line;
/** The belt into MAIN. */
export const BELT_Y = SUBS_Y + 104 + GAP.lower;

/** Human alerts use one pink-red accent everywhere (galley, roster, Action items, toolbar). */
export const ALERT = "#ff4f7b";

const T = {
  panel: "#0c1226", fg: "#eef6ff", muted: "#a8b8d8", accent: "#ffc93a", alert: ALERT, tag: "#f4f8ff", tagSub: "#4b6182",
  plate: "#101a36", plateFg: "#eef6ff", plateSub: "#9fe7ff", zone: "#101a36", zoneFg: "#eef6ff", warm: "#ffb35c",
};

/** In-room robots are drawn a little larger than their design grid so each one reads at a glance. */
const BOT_K = 1.2;
/** Delegated helpers are smaller: assistants, not crew. */
const HELPER_K = 0.95;
const POD_W = 48;
/** Distance between pod left edges (POD_W plus the gap between neighbouring pods). */
const POD_PITCH = 58;
const PODS_X = [0, 1, 2, 3, 4].map((i) => 40 + i * POD_PITCH);
const BELT = { y: BELT_Y, x0: 34, x1: 488 };
/** MAIN sits at the end of the belt and reaches down to the floor's bottom edge. */
const HATCH = { x: 486, y: BELT_Y - 38, w: 42, h: FLOOR_BOTTOM - (BELT_Y - 38) };
const BOARD = { x: 40, y: 64, w: 136, h: 124 };
const OFFICE = { x: 186, y: 34, w: 144, h: 162, cx: 258 };
const LOUNGE = { x: 384, y: 66, w: 140, h: TOP_BAND_END - 66 };
/** The café opens onto the upper aisle and runs down beside the prep line. */
const CAFE = { x: 352, y: AISLE_Y, w: 176, h: 116 + GAP.line };
const SUBS = { x: 40, y: SUBS_Y, w: 272, h: 72 };
const SUB_X = [72, 138, 204, 270];
/** The review scanner: a compact hood over the belt. */
const SCAN = { cx: 395, w: 30 };
/** How far each reviewer stands from the scanner's centre: far enough that their name tags clear its hood. */
const PASS_DX = 46;
/**
 * The crew transporter: a glass tube on the upper aisle beside the prep line. Sessions beam in here when
 * they start and beam out when they end; work itself only travels by belt, scanner and the MAIN hatch.
 */
export const TUBE = { cx: 358, y: AISLE_Y - 2, w: 30, h: 46 };
/** Walking routes: the upper aisle (AISLE_Y), and the lane down past the prep line to the scanner. */
export const LANE_X = 336;
/** How long one beam lasts, and when several queue up. */
export const BEAM_MS = 520;
export const BEAM_BUSY_MS = 300;

/** Where each crew member stands (feet, centre). */
export const SPOTS = {
  island: { x: OFFICE.cx, y: 168 },
  pod: (i: number) => ({ x: PODS_X[i] + POD_W / 2, y: LY + 22 }),
  /** Either side of the scanner hood, just above the belt. */
  pass: [
    { x: SCAN.cx - PASS_DX, y: BELT_Y - 16 },
    { x: SCAN.cx + PASS_DX, y: BELT_Y - 16 },
  ],
  /** Where a reviewer with no free spot beside the scanner waits, on the lane. */
  passQueue: { x: LANE_X, y: BELT_Y - 44 },
  /** The door in the left wall, on the upper aisle. */
  door: { x: 38, y: AISLE_Y - 8 },
  /** Inside the transporter tube (feet). */
  tube: { x: TUBE.cx, y: TUBE.y - 2 },
  /** Beside the tube, for a session waiting its turn to beam out. */
  tubeQueue: { x: TUBE.cx - 20, y: AISLE_Y },
};

export type HangoutKind = "couch" | "stool" | "floor";

/**
 * Where off-shift crew spend their break: two couch seats, three café stools and two clear
 * floor spots. They roll between free ones now and then (decoration only: never workflow state).
 */
export const HANGOUTS: { x: number; y: number; kind: HangoutKind }[] = [
  { x: 432, y: 178, kind: "couch" },
  { x: 476, y: 178, kind: "couch" },
  { x: 400, y: CAFE.y + 90, kind: "stool" },
  { x: 448, y: CAFE.y + 90, kind: "stool" },
  { x: 496, y: CAFE.y + 90, kind: "stool" },
  { x: 357, y: AISLE_Y - 10, kind: "floor" },
  { x: 466, y: BELT_Y - 38, kind: "floor" },
];

export interface Beam {
  kind: "in" | "out";
  /** When it starts (performance.now()); a beam waiting its turn has a start in the future. */
  t0: number;
  dur: number;
}

export interface Actor {
  x: number;
  y: number;
  moving: boolean;
  /** Parked on a couch seat or a stool. */
  seated: boolean;
  alpha: number;
  /** Waypoints still to walk, last one the goal. */
  path?: { x: number; y: number }[];
  /** The goal the path was planned for. */
  goal?: string;
  /** Beaming in or out of the transporter (or waiting for its turn). */
  beam?: Beam | null;
}

/** True while an actor is in (or queued for) a transporter beam: the tube draws it, nothing else does. */
export const inBeam = (a: Actor | undefined, now: number) => !!a?.beam && now < a.beam.t0 + a.beam.dur;

export interface Delivery {
  ticket: string;
  t0: number;
}

export interface Hit {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "agent" | "board" | "needs" | "pass" | "main" | "helper" | "tube";
  id?: string;
  title: string;
  sub?: string;
}

export interface FrameState {
  now: number;
  actors: Map<string, Actor>;
  selected: string | null;
  hover: string | null;
  deliveries: Delivery[];
  /** Off-shift crew → index into HANGOUTS. */
  spotOf: Map<string, number>;
  reduce: boolean;
  /** The logical rectangle on screen (it can extend past VIEW). */
  view: { x: number; y: number; w: number; h: number };
}

// ---------------------------------------------------------------- labels and robots

function nameplate(B: Backend, cx: number, y: number, name: string, job: string, P: boolean, selected = false) {
  const w = Math.max(B.tw(name, 6.8, 800), B.tw(job, 5.2, 700)) + 8;
  const x = Math.round(cx - w / 2);
  if (selected) B.box(x - 1.5, y - 1.5, w + 3, 19, T.accent, { r: 3 });
  B.box(x, y, w, 16, T.plate, { r: 2, ink: !P });
  B.text(cx, y + 1.3, name, T.plateFg, 6.8, 800, { anchor: "middle" });
  B.text(cx, y + 9.2, job, T.plateSub, 5.2, 700, { anchor: "middle" });
  return { x, y, w, h: 16 };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a robot standing with its feet centred on (fx, fy) is drawn, at the room's robot scale. */
function botBox(B: Backend, id: CharacterId, fx: number, fy: number, scale = BOT_K): Box {
  const k = B.spriteK(scale);
  const { w, h } = robotSize(id);
  return { x: fx - (w * k) / 2, y: fy - h * k, w: w * k, h: h * k };
}

/** Draws a robot with its feet centred on (fx, fy): a floor shadow, then the sprite at the room's robot scale. */
function bot(B: Backend, id: CharacterId, fx: number, fy: number, alpha = 1, scale = BOT_K): Box {
  const box = botBox(B, id, fx, fy, scale);
  B.alpha(alpha, () => {
    if (B.kind === "pixel") B.ell(fx, fy, box.w * 0.42, 1.6, "#0b1022");
    B.sprite(box.x, box.y, B.spriteK(scale), (Z) => drawRobot(Z, id, 0, 0));
  });
  return box;
}

/** Selection: four gold corner marks around a robot. */
function brackets(B: Backend, b: Box) {
  const x0 = Math.round(b.x) - 3;
  const y0 = Math.round(b.y) - 3;
  const x1 = Math.round(b.x + b.w) + 2;
  const y1 = Math.round(b.y + b.h) + 2;
  for (const [x, y, dx, dy] of [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
  ]) {
    B.rect(dx > 0 ? x : x - 3, y, 4, 1, T.accent);
    B.rect(x, dy > 0 ? y : y - 3, 1, 4, T.accent);
  }
}

const agentHit = (b: Box, c: CrewMember, sub: string): Hit => ({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4, kind: "agent", id: c.id, title: `${c.name} · ${c.job}`, sub });

/**
 * A small tag with a state mark, an optional ticket and optional words. Alerts are pink-red and always
 * carry the needs mark (a diamond with "!"), so they read without colour.
 */
function badge(B: Backend, cx: number, y: number, kind: IconKind, id: string | null, status: string, o: { alert?: boolean } = {}) {
  const idW = id ? B.tw(id, 8, 900) : 0;
  const w = Math.round(10 + idW + (id ? 2.4 : 0) + (status ? B.tw(status, 5.2, 800) : 0) + 4);
  const x = Math.round(cx - w / 2);
  const bg = o.alert ? T.alert : T.tag;
  B.box(x, y, w, 12, bg, { r: 2, ink: true });
  icon(B, kind, x + 3, y + 3.6, 4.8, INK, bg);
  if (id) B.text(x + 10, y + 1.6, id, INK, 8, 900);
  if (status) B.text(x + 10 + idW + (id ? 2.4 : 0), y + 3.4, status, o.alert ? INK : T.tagSub, 5.2, 800);
  B.rect(Math.round(cx) - 1, y + 12, 3, 1, INK);
  B.rect(Math.round(cx), y + 13, 1, 1, INK);
  return { x, y, w, h: 14 };
}

function waitBadge(B: Backend, cx: number, y: number, id: string, t: string) {
  const w = Math.round(Math.max(B.tw(t, 4.6, 600), B.tw(id, 7, 900) + 8) + 9);
  const x = Math.round(cx - w / 2);
  B.rect(x, y, w, 17, "#1d2748");
  for (let i = 0; i < w; i += 3) {
    B.rect(x + i, y, 2, 1, T.muted);
    B.rect(x + i, y + 16, 2, 1, T.muted);
  }
  for (let j = 0; j < 17; j += 3) {
    B.rect(x, y + j, 1, 2, T.muted);
    B.rect(x + w - 1, y + j, 1, 2, T.muted);
  }
  icon(B, "wait", x + 3, y + 2.6, 4.6, T.muted);
  B.text(x + 10, y + 1.2, id, T.muted, 7, 900);
  B.text(x + 3, y + 10, t, T.muted, 4.6, 600);
}

/** A small name tag under a robot standing in the open (no room for a full plate). */
function floorTag(B: Backend, cx: number, y: number, c: CrewMember, gated: boolean, P: boolean, selected: boolean) {
  const t = `${c.name} · ${c.job}`;
  const tk = c.ticket ?? "";
  const w = Math.round(B.tw(t, 5.4, 800) + (tk ? B.tw(tk, 5.4, 900) + 12 : 0) + 8);
  const x = Math.round(cx - w / 2);
  if (selected) B.box(x - 1.5, y - 1.5, w + 3, 12, T.accent, { r: 3 });
  B.box(x, y, w, 9, T.plate, { r: 2, ink: !P });
  B.text(x + 4, y + 1.4, t, T.plateFg, 5.4, 800);
  if (tk) {
    const tx = x + 4 + B.tw(t, 5.4, 800) + 4;
    B.box(tx, y + 1, B.tw(tk, 5.4, 900) + 8, 7, gated ? T.alert : T.tag, { r: 1 });
    icon(B, gated ? "needs" : "off", tx + 1.4, y + 2.4, 4, INK, gated ? T.alert : T.tag);
    B.text(tx + 6.5, y + 1.6, tk, INK, 5.4, 900);
  }
  return { x, y, w, h: 9 };
}

function dish(B: Backend, cx: number, cy: number) {
  B.ell(cx, cy, 5, 3, "#ffffff", { ink: true });
  B.ell(cx, cy, 3.2, 1.8, "#dfe8f3");
  B.rect(cx - 2, cy - 1, 2, 2, C.red);
  B.rect(cx + 1, cy - 1, 1, 1, C.green);
}

// ---------------------------------------------------------------- room

/** Name and job on one small tag (reviewers beside the scanner, where a full plate won't fit). */
function nameTag(B: Backend, cx: number, y: number, c: CrewMember, P: boolean, selected: boolean) {
  const t = `${c.name} · ${c.job}`;
  const w = Math.round(B.tw(t, 5.4, 800) + 8);
  const x = Math.round(cx - w / 2);
  if (selected) B.box(x - 1.5, y - 1.5, w + 3, 12, T.accent, { r: 3 });
  B.box(x, y, w, 9, T.plate, { r: 2, ink: !P });
  B.text(cx, y + 1.4, t, T.plateFg, 5.4, 800, { anchor: "middle" });
  return { x, y, w, h: 9 };
}

/** A fixed star pattern per 48-unit cell, so panning is seamless. */
function stars(B: Backend, x: number, y: number, w: number, h: number, density = 3) {
  const cell = 48;
  for (let gx = Math.floor(x / cell); gx * cell < x + w; gx++) {
    for (let gy = Math.floor(y / cell); gy * cell < y + h; gy++) {
      let seed = (gx * 73856093) ^ (gy * 19349663);
      for (let k = 0; k < density; k++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const sx = gx * cell + (seed % cell);
        const sy = gy * cell + ((seed >> 8) % cell);
        if (sx >= x && sx < x + w && sy >= y && sy < y + h) B.rect(sx, sy, 1, 1, "#cfe0ff", seed % 3 ? 0.5 : 0.95);
      }
    }
  }
}

/** Space behind the room, across whatever is on screen. */
function space(B: Backend, v: FrameState["view"]) {
  B.rect(v.x - 1, v.y - 1, v.w + 2, v.h + 2, "#05070f");
  stars(B, v.x, v.y, v.w, v.h, 2);
}

/** A ship window: starfield inside a framed pane (space is mostly seen through these). */
function window(B: Backend, x: number, y: number, w: number, h: number, P: boolean, planet = false) {
  B.box(x - 2, y - 2, w + 4, h + 4, "#4a5876", { ink: true, r: 3 });
  B.box(x, y, w, h, "#060a1e", { r: 2 });
  stars(B, x + 1, y + 1, w - 2, h - 2, 9);
  if (planet) B.ell(x + w - 12, y + h - 8, 7, 7, "#e0784a", { ink: !P, shade: true });
  B.rect(x + Math.round(w / 2), y, 1.5, h, "#4a5876");
  B.rect(x + 2, y + 2, w - 4, 1, "#9fb4e8", 0.25);
}

function porthole(B: Backend, cx: number, cy: number, r: number, P: boolean) {
  B.ell(cx, cy, r + 2, r + 2, "#4a5876", { ink: true });
  B.ell(cx, cy, r, r, "#060a1e");
  stars(B, cx - r + 1, cy - r + 1, r * 2 - 2, r * 2 - 2, 12);
  if (!P) B.ell(cx - r / 3, cy - r / 3, r / 3, r / 4, "#9fb4e8");
}

function hull(B: Backend, P: boolean) {
  const { x, y, w, h } = ROOM;
  B.box(x, y, w, h, "#3a4766", { ink: true, r: 5 });
  B.box(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h, "#222c4a", { r: 2 });
  if (P) {
    for (let gx = FLOOR.x; gx < FLOOR.x + FLOOR.w; gx += 32) B.rect(gx, 62, 1, FLOOR.h - 30, "#1f2945");
    for (let gy = 94; gy < FLOOR.y + FLOOR.h; gy += 32) B.rect(FLOOR.x, gy, FLOOR.w, 1, "#1f2945");
  } else {
    B.path(`M${FLOOR.x} ${AISLE_Y - 4} H190 L120 ${FLOOR_BOTTOM} H${FLOOR.x} Z`, "#1c2542");
    B.path(`M528 62 V${FLOOR_BOTTOM} H430 L528 150 Z`, "#1c2542");
  }
  // back wall with windows
  B.rect(FLOOR.x, FLOOR.y, FLOOR.w, 30, "#2c3a5e");
  for (let gx = FLOOR.x; gx < FLOOR.x + FLOOR.w; gx += 38) B.rect(gx, FLOOR.y, 1, 30, "#22304f");
  B.rect(FLOOR.x, FLOOR.y + 30, FLOOR.w, 1, C.teal);
  window(B, 44, 36, 58, 20, P);
  window(B, 114, 36, 58, 20, P);
  window(B, 392, 36, 60, 22, P);
  window(B, 460, 36, 60, 22, P, true);
  // portholes along the right wall by the lounge, and one on the left aisle
  porthole(B, 524, 112, 6, P);
  porthole(B, 524, 150, 6, P);
  porthole(B, 36, LY + 38, 5, P);
  // the door in the left wall, on the upper aisle
  B.rect(x, AISLE_Y - 20, 8, 26, "#1a2340");
  B.rect(x + 2, AISLE_Y - 18, 4, 22, C.teal, 0.35);
}

/** ORDERS: a shipboard ticket rail. Slips hang from four rails: New, Cooking, Review, Served. */
function orderBoard(B: Backend, m: GalleyModel, P: boolean, hits: Hit[]) {
  const { x, y, w, h } = BOARD;
  B.box(x, y, w, h, "#3a4660", { ink: true, r: 3, shade: true });
  B.box(x + 3, y + 3, w - 6, h - 6, "#0a1430", { r: 2 });
  // header plate
  B.box(x + 3, y + 3, w - 6, 15, INK, { r: 2 });
  B.text(x + 8, y + 5.2, "ORDERS", T.accent, 10, 900);
  const open = m.columns[0].length + m.columns[1].length + m.columns[2].length;
  B.text(x + w - 8, y + 8.2, `${open} open`, "#9fe7ff", 5, 800, { anchor: "end" });
  const names = ["New", "Cooking", "Review", "Served"];
  const cw = (w - 8) / 4;
  const top = y + 22;
  const slipH = 12;
  const rows = Math.floor((h - 30 - 10) / (slipH + 2));
  COLUMN_NAMES.forEach((_, i) => {
    const cx = x + 4 + i * cw;
    // column header and the rail the slips hang from
    B.text(cx + cw / 2, top, names[i], i === 3 ? "#7fe0a8" : "#9fe7ff", 5, 900, { anchor: "middle" });
    B.rect(cx + 2, top + 7, cw - 4, 2, "#8f9cb2");
    B.rect(cx + 2, top + 7, cw - 4, 1, "#c9d3e0");
    const col = m.columns[i];
    const over = col.length > rows ? col.length - (rows - 1) : 0;
    const shown = over ? col.slice(0, rows - 1) : col;
    shown.forEach((s, k) => {
      const sx = cx + 3;
      const sy = top + 11 + k * (slipH + 2);
      const sw = cw - 6;
      const alert = s.mark === "needs";
      B.alpha(s.dim ? 0.55 : 1, () => {
        B.rect(sx + sw / 2 - 0.5, sy - 2, 1, 2, "#8f9cb2"); // clip
        B.box(sx, sy, sw, slipH, alert ? T.alert : i === 3 ? "#d9f2e3" : "#f4f1e6", { ink: !P, r: 1 });
        // The column says the stage; a slip only adds the needs mark (so the alert reads without colour too).
        if (alert) icon(B, "needs", sx + 1.6, sy + 3.6, 4.4, INK, T.alert);
        B.text(sx + (alert ? 7 : 2.2), sy + 2.4, s.id, INK, alert ? 6.6 : 7.2, 900);
      });
    });
    if (over) {
      const sy = top + 11 + (rows - 1) * (slipH + 2);
      B.box(cx + 3, sy, cw - 6, slipH, "#13285a", { r: 1 });
      B.text(cx + cw / 2, sy + 3, `+${over} more`, "#eef6ff", 5.2, 900, { anchor: "middle" });
    }
    if (!col.length) B.text(cx + cw / 2, top + 13, "—", "#56628a", 6, 800, { anchor: "middle" });
  });
  hits.push({ x, y, w, h, kind: "board", title: "Orders", sub: `${m.columns.map((c, i) => `${names[i]} ${c.length}`).join(" · ")} — click for the full board` });
}

/**
 * The Head Chef's office: a glass-fronted room with an open entrance, a screen wall, a big
 * command console and warm light, looking down over the prep line. The chef's-hat emblem on its
 * back wall marks where the orchestrator sits even without labels.
 */
function headChef(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  const { x, y, w, h, cx } = OFFICE;
  // floor, warm light, side walls
  B.box(x, y, w, h, "#3b2440", { r: 3 });
  B.box(x + 3, y + 26, w - 6, h - 30, "#4a2c48", { r: 2 });
  B.glow(cx, 140, 58, T.warm, P ? 0.2 : 0.14);
  B.box(x, y, 5, h, "#55607e", { ink: true, r: 1 });
  B.box(x + w - 5, y, 5, h, "#55607e", { ink: true, r: 1 });
  // screen wall with the chef's-hat emblem in the middle
  B.box(x + 10, y + 4, 40, 22, INK, { ink: true, r: 2 });
  B.rect(x + 12, y + 6, 36, 18, "#0f2a4a");
  for (let k = 0; k < 4; k++) B.rect(x + 14, y + 8 + k * 4, 12 + ((k * 7) % 18), 2, k % 2 ? C.teal : T.accent);
  B.box(x + w - 50, y + 4, 40, 22, INK, { ink: true, r: 2 });
  B.rect(x + w - 48, y + 6, 36, 18, "#0f2a4a");
  for (let k = 0; k < 6; k++) B.rect(x + w - 46 + k * 6, y + 20 - ((k * 5) % 12), 4, ((k * 5) % 12) + 2, k % 2 ? C.teal : "#7fe0a8");
  B.box(cx - 15, y + 3, 30, 24, "#2a1a2e", { ink: true, r: 3 });
  B.ell(cx, y + 11, 9, 6, "#ffffff", { ink: true });
  B.ell(cx - 6, y + 13, 4, 4, "#ffffff", { ink: !P });
  B.ell(cx + 6, y + 13, 4, 4, "#ffffff", { ink: !P });
  B.box(cx - 7, y + 15, 14, 7, "#ffffff", { ink: true, r: 1 });
  B.rect(cx - 7, y + 19, 14, 1, "#c9d3e0");
  B.rect(cx - 15, y + 26, 30, 1, T.accent);
  // the command console: a wide curved desk with screens and a ticket printer
  B.box(x + 16, 92, w - 32, 22, "#3a4660", { ink: true, r: 6, shade: true, hi: true });
  B.rect(x + 22, 96, w - 44, 2, C.teal);
  for (let k = 0; k < 4; k++) {
    const sx = x + 24 + k * 26;
    B.box(sx, 84, 20, 12, INK, { r: 1 });
    B.rect(sx + 1, 85, 18, 10, k === 1 ? "#1d3a5a" : "#0f2a4a");
    B.rect(sx + 3, 87 + (k % 3), 10, 1, k % 2 ? T.accent : C.teal);
  }
  B.box(x + w - 30, 98, 12, 10, "#c9d3e0", { ink: true, r: 1 });
  B.rect(x + w - 28, 106, 8, 6, "#f4f1e6");
  const coord = m.coordinator;
  let top = 124;
  if (coord) {
    const box = actorAt(B, coord, f, hits);
    if (box) top = box.y;
  }
  // the glass front, with the open entrance in the middle
  const gy = y + h - 10;
  const door = 34;
  for (const [gx0, gx1] of [
    [x + 5, cx - door / 2],
    [cx + door / 2, x + w - 5],
  ] as const) {
    B.box(gx0, gy, gx1 - gx0, 10, "#8fd8ff", { r: 1 });
    B.alpha(0.45, () => B.rect(gx0, gy, gx1 - gx0, 10, "#cdf0ff"));
    for (let mx = gx0 + 14; mx < gx1 - 2; mx += 14) B.rect(mx, gy, 1.5, 10, "#55607e");
    B.rect(gx0, gy, gx1 - gx0, 1.5, "#55607e");
  }
  B.rect(cx - door / 2 - 2, gy - 2, 3, 12, "#55607e");
  B.rect(cx + door / 2 - 1, gy - 2, 3, 12, "#55607e");
  // Human decisions waiting: compact pink-red tickets clipped to the glass either side of the entrance.
  const spots: [number, number][] = [
    [x + 9, gy - 22],
    [cx + door / 2 + 6, gy - 22],
    [x + 9, gy - 34],
    [cx + door / 2 + 6, gy - 34],
  ];
  const max = spots.length;
  const shown = m.gates.length > max ? m.gates.slice(0, max - 1) : m.gates;
  shown.forEach((id, i) => {
    const [gx, gy2] = spots[i];
    B.box(gx, gy2, 32, 10, T.alert, { r: 1, ink: true });
    icon(B, "needs", gx + 2, gy2 + 2.4, 4.8, INK, T.alert);
    B.text(gx + 8.4, gy2 + 1.4, id, INK, 6.6, 900);
    hits.push({ x: gx, y: gy2, w: 32, h: 10, kind: "needs", title: `${id} needs your decision`, sub: "Human gate · open Action items" });
  });
  if (m.gates.length > max) {
    const [gx, gy2] = spots[max - 1];
    B.box(gx, gy2, 32, 10, T.alert, { r: 1, ink: true });
    B.text(gx + 16, gy2 + 2.2, `+${m.gates.length - (max - 1)} more`, INK, 5, 900, { anchor: "middle" });
    hits.push({ x: gx, y: gy2, w: 32, h: 10, kind: "needs", title: "More decisions waiting", sub: "Open Action items" });
  }
  if (coord) {
    const plate = nameplate(B, cx, gy - 18, coord.name, coord.job, P, f.selected === coord.id);
    hits.push({ ...plate, kind: "agent", id: coord.id, title: `${coord.name} · ${coord.job}`, sub: `${coord.role} · ${coord.status}` });
    if (!coord.running) badge(B, cx, top - 16, "off", null, "not running");
    else if (coord.state === "needs") {
      const b = badge(B, cx, top - 16, "needs", null, "needs you", { alert: true });
      hits.push({ ...b, kind: "needs", title: `${coord.name} needs you`, sub: coord.agent.note ?? "Answer the coordinator in its terminal" });
    }
  }
}

/** Upper right, by the office: the fridge and the water cooler. */
function kitchen(B: Backend) {
  B.box(338, 36, 20, 44, "#d6dde8", { ink: true, r: 2, shade: true, hi: true });
  B.rect(340, 52, 16, 1, "#9aa6ba");
  B.rect(354, 42, 1, 6, "#6f7c94");
  B.rect(354, 56, 1, 10, "#6f7c94");
  B.box(364, 52, 13, 28, "#c9d3e0", { ink: true, r: 2, shade: true });
  B.box(366, 42, 9, 11, "#8fd8ff", { ink: true, r: 3 });
}

/** Off-shift crew parked at a hangout of this kind, with their actors. */
function parkedAt(m: GalleyModel, f: FrameState, kinds: HangoutKind[]) {
  const out: { c: CrewMember; a: Actor; spot: (typeof HANGOUTS)[number]; index: number }[] = [];
  for (const c of m.lounge) {
    const i = f.spotOf.get(c.id);
    const a = f.actors.get(c.id);
    if (i === undefined || !a || a.moving) continue;
    const spot = HANGOUTS[i];
    if (!kinds.includes(spot.kind) || Math.abs(a.x - spot.x) > 0.5 || Math.abs(a.y - spot.y) > 0.5) continue;
    out.push({ c, a, spot, index: i });
  }
  return out;
}

const breakSub = (c: CrewMember, gated: boolean) => `${c.role}${c.ticket ? ` · ${c.ticket}` : ""} · ${gated ? "finished · waiting at a handoff gate" : "finished · on break"}`;

/** A parked off-shift robot on a seat: ticket badge above, plate below. */
function seatedCrew(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[], c: CrewMember, a: Actor, controller: boolean, plateDrop = 0) {
  const box = bot(B, c.character, a.x, a.y);
  if (controller) {
    B.box(a.x - 5, a.y - 12, 10, 5, "#1b2338", { r: 1, ink: !P });
    B.rect(a.x - 3, a.y - 10, 2, 1, C.green);
    B.rect(a.x + 2, a.y - 11, 1, 1, C.red);
  }
  if (f.selected === c.id) brackets(B, box);
  const gated = !!c.ticket && m.gates.includes(c.ticket);
  const sub = breakSub(c, gated);
  if (c.ticket) {
    const b = badge(B, a.x, box.y - 16, gated ? "needs" : "off", c.ticket, "", { alert: gated });
    hits.push({ ...b, kind: "agent", id: c.id, title: `${c.name} · ${c.job}`, sub });
  }
  const plate = nameplate(B, a.x, a.y + 2 + plateDrop, c.name, c.job, P, f.selected === c.id);
  hits.push({ ...plate, kind: "agent", id: c.id, title: `${c.name} · ${c.job}`, sub });
  hits.push(agentHit(box, c, sub));
}

/** Upper right, under the windows: the co-op couch facing the room, the game on a screen behind it, warm lamp light. */
function lounge(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  const { x, y, w, h } = LOUNGE;
  B.box(x, y, w, h, "#3a2f5e", { r: 5 });
  B.box(x + 4, y + 4, w - 8, h - 8, "#46386e", { r: 4 });
  B.glow(x + w / 2, 160, 62, T.warm, P ? 0.2 : 0.13);
  const sx = 418;
  B.box(sx, 70, 72, 24, INK, { ink: true, r: 2 });
  B.box(sx + 2, 72, 68, 19, "#0f2a4a", { r: 1 });
  B.rect(sx + 2, 87, 68, 4, "#1b4a3a");
  for (let gx = sx + 4; gx < sx + 68; gx += 6) B.rect(gx, 86, 3, 1, C.green);
  const couch = parkedAt(m, f, ["couch"]);
  const playing = couch.length;
  const t = f.now / 1000;
  const bob = (k: number) => (playing && !f.reduce ? Math.round(Math.sin(t * 2 + k) * 2) : 0);
  B.box(sx + 14, 78 + bob(0), 7, 4, C.pink, { r: 1 });
  B.box(sx + 42, 76 + bob(1), 7, 4, C.yellow, { r: 1 });
  if (playing && !f.reduce) B.rect(sx + 27 + ((t * 18) % 14), 80, 4, 1, "#ffffff");
  B.ell(sx + 60, 81, 3, 3, C.red);
  B.rect(sx + 34, 94, 4, 6, "#3a4766");
  // floor lamps either side of the couch
  for (const lx of [398, 512]) {
    B.rect(lx, 118, 2, 40, "#5a4a3a");
    B.ell(lx + 1, 117, 5, 3, "#ffd59a", { ink: !P });
    B.glow(lx + 1, 126, 16, T.warm, 0.2);
  }
  // couch
  B.box(408, 150, 92, 18, "#c8743e", { ink: true, r: 4 });
  B.rect(454, 153, 1, 12, "#b9663a");
  B.box(406, 164, 96, 12, "#d9844e", { ink: true, r: 4, shade: true, hi: true });
  B.box(402, 154, 8, 24, "#c8743e", { ink: true, r: 3 });
  B.box(498, 154, 8, 24, "#c8743e", { ink: true, r: 3 });
  for (const { c, a } of couch) seatedCrew(B, m, f, P, hits, c, a, true);
}

/** Middle right: the café. A range with pots and a coffee machine on the back counter, three stools, warm light; open to the aisles. */
function cafe(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  const { x, y, w, h } = CAFE;
  B.box(x, y, w, h, "#2c3a58", { r: 4 });
  if (P) for (let gx = x; gx < x + w; gx += 8) for (let gy = y; gy < y + h; gy += 8) if (((gx - x) / 8 + (gy - y) / 8) % 2 === 0) B.rect(gx, gy, Math.min(8, x + w - gx), Math.min(8, y + h - gy), "#324264");
  B.glow(x + w / 2, y + 70, 70, T.warm, P ? 0.18 : 0.11);
  // pendant lights
  for (const lx of [x + 40, x + 88, x + 136]) {
    B.rect(lx, y, 1, 6, "#8f9cb2");
    B.ell(lx, y + 7, 5, 2.4, "#ffd59a", { ink: !P });
  }
  // back counter: range with pots, then the coffee machine and cups
  B.box(x + 6, y + 18, w - 12, 20, "#8a5a3a", { ink: true, r: 3, shade: true });
  B.rect(x + 7, y + 18, w - 14, 3, "#c9a06a");
  B.box(x + 12, y + 14, 44, 10, "#55607e", { ink: true, r: 2 });
  for (const bx of [x + 22, x + 46]) {
    B.ell(bx, y + 19, 6, 2.4, "#2a2f3d");
    B.ell(bx, y + 19, 4, 1.4, C.orange);
  }
  B.box(x + 15, y + 6, 14, 10, "#8f9cb2", { ink: true, r: 2, shade: true });
  B.rect(x + 16, y + 7, 12, 2, "#b5552f");
  B.ell(x + 46, y + 13, 7, 2.4, "#3a4660", { ink: true });
  B.rect(x + 52, y + 12, 7, 1, "#55607e");
  B.box(x + w - 30, y + 4, 16, 16, "#55607e", { ink: true, r: 2, shade: true });
  B.rect(x + w - 27, y + 7, 10, 3, INK);
  B.rect(x + w - 26, y + 8, 2, 1, C.green);
  B.box(x + w - 50, y + 12, 6, 7, "#f6eedd", { ink: true, r: 1 });
  B.box(x + w - 42, y + 12, 6, 7, C.teal, { ink: true, r: 1 });
  // stools, drawn before whoever sits on them
  for (const s of HANGOUTS.filter((hh) => hh.kind === "stool")) {
    B.rect(s.x - 1, s.y - 2, 2, 12, "#8f9cb2");
    B.ell(s.x, s.y + 10, 5, 1.6, "#3a4766");
    B.ell(s.x, s.y - 3, 7, 2.4, "#c0304a", { ink: !P });
  }
  // The stools sit close: the middle stool's plate drops a row so neighbours never overlap.
  for (const { c, a, index } of parkedAt(m, f, ["stool"])) seatedCrew(B, m, f, P, hits, c, a, false, index === 3 ? 18 : 0);
}

/** Off-shift crew stopped at a clear floor spot: robot plus a small tag at its feet. */
function floorCrew(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  for (const { c, a } of parkedAt(m, f, ["floor"])) {
    const box = bot(B, c.character, a.x, a.y);
    if (f.selected === c.id) brackets(B, box);
    const gated = !!c.ticket && m.gates.includes(c.ticket);
    const sub = breakSub(c, gated);
    const tag = floorTag(B, a.x, a.y + 2, c, gated, P, f.selected === c.id);
    hits.push({ ...tag, kind: "agent", id: c.id, title: `${c.name} · ${c.job}`, sub });
    hits.push(agentHit(box, c, sub));
  }
}

/**
 * Lower left: the subagent work area. Compact stations for the coordinator's delegated helpers
 * (searches, plans, checks), separate from the prep line. Empty when none are running.
 */
function subagents(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  const { x, y, w, h } = SUBS;
  B.box(x, y, w, h, "#1b2d3c", { r: 4 });
  B.box(x + 2, y + 2, w - 4, h - 4, "#203648", { r: 3 });
  // a relay trunk along the back of the area: the stations hang off it
  B.rect(x + 8, y + 8, w - 16, 2, "#3a5a6a");
  // Grouped by the session that launched them: the coordinator's first, then each worker's.
  const parentName = (id: string | undefined) => m.crew.find((c) => c.id === (id ?? "coordinator"))?.name ?? "the coordinator";
  const shown = [...m.helpers].sort((a, b) => (a.parent === b.parent ? 0 : (a.parent ?? "coordinator") === "coordinator" ? -1 : (b.parent ?? "coordinator") === "coordinator" ? 1 : (a.parent ?? "").localeCompare(b.parent ?? ""))).slice(0, SUB_X.length);
  SUB_X.forEach((cx, i) => {
    const hlp = shown[i];
    B.rect(cx, y + 9, 1, 12, "#3a5a6a");
    if (hlp) {
      const box = bot(B, "unit", cx, y + 42, 1, HELPER_K);
      const t = hlp.type.length > 14 ? hlp.type.slice(0, 13) + "…" : hlp.type;
      const tw = B.tw(t, 4.8, 800) + 6;
      B.box(cx - tw / 2, box.y - 9, tw, 7.5, T.plate, { r: 2, ink: !P });
      B.text(cx, box.y - 8.2, t, "#9fe7ff", 4.8, 800, { anchor: "middle" });
      hits.push({ x: box.x - 2, y: box.y - 10, w: box.w + 4, h: box.h + 12, kind: "helper", title: `Delegated subagent · ${hlp.type}`, sub: `${hlp.label} · launched by ${parentName(hlp.parent)}` });
    }
    // the station: a compact desk with a terminal, lit when someone works at it
    B.box(cx - 20, y + 42, 40, 11, "#55607e", { ink: true, r: 2, shade: true, hi: true });
    B.box(cx - 9, y + 46, 18, 5, INK, { r: 1 });
    B.rect(cx - 8, y + 47, 16, 3, hlp ? C.teal : "#26335c");
    if (hlp && !f.reduce && Math.floor(f.now / 500 + i) % 2) B.rect(cx - 6, y + 48, 6, 1, "#ffffff");
    B.rect(cx - 16, y + 53, 2, 8, "#3a4766");
    B.rect(cx + 14, y + 53, 2, 8, "#3a4766");
    // whose helper it is, under the desk (a name, like every other label on the floor)
    if (hlp) B.text(cx, y + 62, parentName(hlp.parent), "#9fb4d8", 4.6, 800, { anchor: "middle" });
  });
  if (m.helpers.length > SUB_X.length) {
    const t = `+${m.helpers.length - SUB_X.length}`;
    B.box(x + w - 18, y + h - 13, 14, 9, T.plate, { r: 2, ink: !P });
    B.text(x + w - 11, y + h - 12, t, "#9fe7ff", 5.2, 900, { anchor: "middle" });
  }
}

/** The belt runs straight along the bottom wall into MAIN; chevrons show the direction, and move only during a delivery. */
function belt(B: Backend, f: FrameState) {
  const { y, x0, x1 } = BELT;
  B.box(x0, y - 1, x1 - x0 + 4, 14, INK, { r: 3 });
  B.rect(x0 + 2, y + 1, x1 - x0, 10, "#1b2238");
  B.rect(x0 + 2, y + 1, x1 - x0, 1, T.accent);
  B.rect(x0 + 2, y + 10, x1 - x0, 1, T.accent);
  const moving = f.deliveries.length > 0 && !f.reduce;
  const off = moving ? Math.floor((f.now / 90) % 14) : 0;
  for (let cx = x0 + 8 + off; cx < x1 - 4; cx += 14) {
    B.rect(cx - 1, y + 3, 2, 1, C.teal);
    B.rect(cx, y + 4, 2, 1, C.teal);
    B.rect(cx + 1, y + 5, 2, 1, C.teal);
    B.rect(cx + 2, y + 6, 1, 1, C.teal);
    B.rect(cx + 1, y + 7, 2, 1, C.teal);
    B.rect(cx, y + 8, 2, 1, C.teal);
    B.rect(cx - 1, y + 9, 2, 1, C.teal);
  }
}

/**
 * MAIN: a galley service hatch at the end of the belt. A metal frame, a plate-sized opening the
 * belt runs into, a shutter, and a warm light inside. The shutter lifts only for a confirmed merge.
 */
function hatch(B: Backend, f: FrameState, served: number, hits: Hit[]) {
  const { x, y, w, h } = HATCH;
  const delivering = f.deliveries.some((d) => f.now - d.t0 > 2000 && f.now - d.t0 < 5200);
  B.box(x, y, w, h, "#55607e", { ink: true, r: 5, shade: true, hi: true });
  B.box(x + 3, y + 3, w - 6, 14, INK, { r: 2 });
  B.text(x + w / 2, y + 5, "MAIN", T.accent, 8.6, 900, { anchor: "middle" });
  // the opening, at belt height, with warm light inside
  const ox = x + 4;
  const oy = BELT.y - 8;
  const ow = w - 8;
  const oh = 22;
  B.box(ox, oy, ow, oh, "#1a0f08", { ink: true, r: 3 });
  B.glow(ox + ow / 2, oy + oh / 2, 16, T.warm, delivering ? 0.65 : 0.35);
  B.rect(ox + 2, oy + 2, ow - 4, oh - 4, delivering ? "#ffcf8a" : "#5a2f14", delivering ? 0.85 : 0.6);
  // shutter: down to just above the belt, lifted while a delivery goes through
  const lift = delivering ? 0 : 1;
  const sh = Math.round((oh - 12) * lift);
  if (sh > 0) {
    B.box(ox + 1, oy + 1, ow - 2, sh, "#8f9cb2", { r: 1 });
    for (let k = 0; k < sh; k += 3) B.rect(ox + 2, oy + 2 + k, ow - 4, 1, "#6f7c94");
  }
  // status lights and a hazard stripe under the opening
  B.ell(x + 8, y + h - 8, 2.2, 2.2, delivering ? "#4fe07a" : "#2f6a48", { ink: true });
  B.ell(x + w - 8, y + h - 8, 2.2, 2.2, T.warm, { ink: true });
  for (let k = 0; k < ow - 6; k += 6) B.rect(ox + 3 + k, oy + oh + 3, 3, 2, k % 12 ? INK : T.accent);
  hits.push({ x, y, w, h, kind: "main", title: "MAIN · service hatch", sub: `${served} tickets integrated (Pathfinder confirms each merge)` });
}

/** A confirmed merge rides the belt from the scanner into the MAIN hatch. Nothing else uses this animation. */
function deliveries(B: Backend, f: FrameState) {
  const sy = BELT.y + 6;
  const dist = HATCH.x + 10 - SCAN.cx;
  for (const d of f.deliveries) {
    const k = Math.min(1, (f.now - d.t0) / 3000);
    if (k >= 1) continue;
    const x = SCAN.cx + k * dist;
    dish(B, x, sy);
    badge(B, x, sy - 22, "done", d.ticket, "to MAIN");
  }
}

/**
 * The pass: a compact sci-fi scanner hood straddling the belt, so a plate passes under it. A status
 * light sits on top; its readout appears only while something is happening. The beam sweeps only while
 * a reviewer is really reviewing (live data or a labelled fixture). Reviewers stand either side.
 */
function scanner(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  const cx = SCAN.cx;
  const half = SCAN.w / 2;
  const reviewers = m.reviewers.slice(0, SPOTS.pass.length);
  const asking = reviewers.some((r) => r.state === "needs");
  const scanning = reviewers.some((r) => r.running && r.state !== "needs");
  const reviewed = new Set(reviewers.map((r) => r.ticket));
  const waiting = m.atPass.filter((t) => !reviewed.has(t));
  const onTray = reviewers[0]?.ticket ?? waiting[0] ?? null;
  if (scanning) B.glow(cx, BELT.y + 4, 30, C.teal, P ? 0.16 : 0.1);
  reviewers.forEach((r) => actorAt(B, r, f, hits));
  if (onTray) dish(B, cx, BELT.y + 5);
  B.box(cx - half, BELT.y - 12, 4, 28, "#3a4766", { ink: true, r: 1 });
  B.box(cx + half - 4, BELT.y - 12, 4, 28, "#3a4766", { ink: true, r: 1 });
  B.box(cx - half - 2, BELT.y - 16, SCAN.w + 4, 9, "#c9d3e0", { ink: true, r: 3, shade: true, hi: true });
  B.rect(cx - half + 3, BELT.y - 7, SCAN.w - 6, 1, scanning ? C.teal : "#56628a");
  if (scanning) {
    B.alpha(0.2, () => B.path(`M${cx - half + 4} ${BELT.y - 6} H${cx + half - 4} V${BELT.y + 11} H${cx - half + 4} Z`, C.teal));
    if (P) for (let yy = BELT.y - 6; yy < BELT.y + 11; yy += 2) B.rect(cx - half + 4, yy, SCAN.w - 8, 1, C.teal, 0.14);
    const phase = f.reduce ? 0.5 : (f.now % 3200) / 1000;
    if (phase <= 1) B.rect(cx - half + 4 + (SCAN.w - 8) * phase - 1, BELT.y - 6, 2, 17, "#bff8f2");
  }
  const light = asking ? T.alert : scanning ? T.accent : waiting.length ? C.teal : "#4fe07a";
  const blink = scanning && !f.reduce && Math.floor(f.now / 400) % 2 === 0;
  B.ell(cx, BELT.y - 19, 2.6, 2.6, blink ? "#fff2b0" : light, { ink: true });
  const word = asking ? "NEEDS YOU" : scanning ? "SCANNING" : waiting.length ? waiting[0] : "";
  if (word) {
    const ww = Math.round(B.tw(word, 4.6, 900) + 6);
    B.box(cx - ww / 2, BELT.y - 30, ww, 7, INK, { r: 1 });
    B.text(cx, BELT.y - 29.2, word, asking ? T.alert : scanning ? T.accent : "#9fe7ff", 4.6, 900, { anchor: "middle" });
  }
  hits.push({
    x: cx - half - 2, y: BELT.y - 32, w: SCAN.w + 4, h: 48, kind: "pass", title: "Review scanner · the pass",
    sub: scanning ? `Scanning: ${reviewers.map((r) => r.ticket).join(", ")}` : m.atPass.length ? `At the pass: ${m.atPass.join(", ")}` : "Nothing at the pass",
  });
  for (const r of reviewers) {
    const a = f.actors.get(r.id);
    // Not while it is still in (or queued at) the transporter: its tag belongs beside the scanner.
    if (!a || a.moving || inBeam(a, f.now)) continue;
    const tag = nameTag(B, a.x, a.y + 1, r, P, f.selected === r.id);
    hits.push({ ...tag, kind: "agent", id: r.id, title: `${r.name} · ${r.job}`, sub: `${r.role} · ${r.ticket ?? ""} · ${r.status}` });
  }
}

/** What each cook works on, set on its counter top beside it (pod-local units; never over the robot). */
const POD_PROPS: Partial<Record<CharacterId, (Z: Backend) => void>> = {
  pepper: (Z) => {
    Z.box(31, 24, 12, 5, "#eef3f8", { ink: true, r: 1 });
    Z.rect(33, 26, 3, 1, "#f08a2a");
    Z.rect(38, 26, 3, 1, "#f08a2a");
  },
  roux: (Z) => {
    Z.box(31, 21, 12, 9, "#55607e", { ink: true, r: 2, shade: true });
    Z.rect(32, 22, 10, 2, "#b5552f");
  },
  ember: (Z) => {
    Z.box(31, 24, 12, 7, "#2a2f3d", { ink: true, r: 1 });
    for (let k = 0; k < 3; k++) Z.rect(32, 25 + k * 2, 10, 1, C.orange);
  },
  sprig: (Z) => {
    Z.ell(37, 27, 6, 2.4, "#eef3f8", { ink: true });
    Z.rect(34, 26, 2, 2, C.green);
    Z.rect(37, 25, 2, 2, "#7fd08a");
  },
  crumb: (Z) => {
    Z.ell(37, 27, 6, 2.4, "#f6eedd", { ink: true });
    Z.rect(33, 25, 8, 2, "#f2a0b8");
  },
  mochi: (Z) => {
    Z.ell(37, 27, 6, 2.2, "#3a4660", { ink: true });
    Z.rect(35, 25, 4, 1, C.yellow);
  },
};

/** A small deterministic hash for sparkle positions. */
const hash = (n: number) => {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  return (x * 2246822519) >>> 0;
};

/**
 * The crew transporter. A glass tube on a pad, a cap with an emitter ring, and a quick teal beam when a
 * session arrives or leaves: a column of light, scan lines running through it, a few sparkles, and the robot
 * resolving (or dissolving) row by row. Brief by design; with reduced motion there is no beam at all.
 * Above it hang the tickets waiting for their next session, and those the plan holds for the next round.
 */
function transporter(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  const { cx, y: base, w, h } = TUBE;
  const x0 = cx - w / 2;
  const top = base - h;
  // who is beaming right now (oldest first)
  const beaming: { c: CrewMember; a: Actor; k: number }[] = [];
  for (const c of m.crew) {
    const a = f.actors.get(c.id);
    if (!a?.beam || f.now < a.beam.t0 || f.now >= a.beam.t0 + a.beam.dur) continue;
    beaming.push({ c, a, k: (f.now - a.beam.t0) / a.beam.dur });
  }
  const on = beaming.length > 0;
  // pad and rear glass
  B.ell(cx, base, w / 2 + 5, 5, "#3a4766", { ink: true });
  B.ell(cx, base, w / 2 + 1, 3.4, on ? C.teal : "#26506a", { ink: !P });
  B.box(x0, top + 4, w, h - 6, "#0d2a36", { r: 3 });
  B.glow(cx, base - h / 2, 24, C.teal, on ? (P ? 0.32 : 0.22) : P ? 0.1 : 0.06);
  for (const { c, a, k } of beaming) {
    const kind = a.beam!.kind;
    const vis = kind === "in" ? k : 1 - k;
    const swell = Math.sin(Math.PI * k);
    // the column of light
    B.alpha(0.25 + 0.45 * swell, () => B.rect(x0 + 3, top + 6, w - 6, h - 9, C.teal));
    // the robot resolves from the head down (in) or dissolves from the feet up (out)
    const box = botBox(B, c.character, a.x, a.y);
    const shown = Math.max(0, Math.min(1, vis));
    B.clip(box.x - 3, box.y - 3, box.w + 6, (box.h + 6) * shown, () => bot(B, c.character, a.x, a.y, 0.35 + 0.65 * shown));
    // scan lines running through the column
    for (let i = 0; i < 3; i++) {
      const yy = top + 6 + (((k * 2.2 + i / 3) % 1) * (h - 10));
      B.rect(x0 + 3, Math.round(yy), w - 6, 1, "#bff8f2", 0.85);
    }
    // sparkles
    const tick = Math.floor(f.now / 70);
    for (let i = 0; i < 7; i++) {
      const r = hash(tick * 31 + i * 7 + c.id.length);
      B.rect(x0 + 4 + (r % (w - 8)), top + 7 + ((r >>> 8) % (h - 12)), 1, 1, "#ffffff", 0.9);
    }
    hits.push({ ...box, kind: "agent", id: c.id, title: `${c.name} · ${c.job}`, sub: kind === "in" ? `beaming in · ${c.role}${c.ticket ? ` · ${c.ticket}` : ""}` : `beaming out · ${c.status}` });
  }
  // sessions waiting their turn to beam out stand beside the tube
  for (const c of m.crew) {
    const a = f.actors.get(c.id);
    if (a?.beam?.kind !== "out" || f.now >= a.beam.t0) continue;
    const box = bot(B, c.character, SPOTS.tubeQueue.x, SPOTS.tubeQueue.y);
    hits.push(agentHit(box, c, `about to beam out · ${c.status}`));
  }
  // front glass: a faint pane with two highlights, and the frame
  B.alpha(0.18, () => B.rect(x0, top + 4, w, h - 6, "#cdf0ff"));
  B.rect(x0 + 4, top + 7, 1.5, h - 14, "#e8fbff", 0.55);
  B.rect(x0 + w - 7, top + 9, 1, h - 18, "#e8fbff", 0.35);
  B.box(x0 - 1, top + 2, 3, h - 3, "#55607e", { ink: true, r: 1 });
  B.box(x0 + w - 2, top + 2, 3, h - 3, "#55607e", { ink: true, r: 1 });
  // the cap with its emitter ring
  B.box(x0 - 3, top - 4, w + 6, 8, "#c9d3e0", { ink: true, r: 3, shade: true, hi: true });
  B.rect(x0 + 1, top + 3, w - 2, 1, on ? "#bff8f2" : C.teal);
  B.ell(cx, top - 6, 2.4, 2.4, on ? "#bff8f2" : C.teal, { ink: true });
  hits.push({ x: x0 - 3, y: top - 8, w: w + 6, h: h + 12, kind: "tube", title: "Crew transporter", sub: on ? `Beaming: ${beaming.map((b) => `${b.c.name} ${b.a.beam!.kind}`).join(", ")}` : "Sessions beam in when they start and out when they end" });

  // Tickets waiting for their next session, then those held for the next round: dashed tags above the tube.
  const tags: { id: string; words: string; sub: string }[] = [
    ...m.waiting.map((t) => ({ id: t.key, words: `→ ${t.label.replace(/^Waiting for /, "")}`, sub: `${t.label} · ${t.title}` })),
    ...m.nextRound.map((id) => ({ id, words: "next round", sub: "Ready for next round: eligible, waiting for another approved dispatch" })),
  ];
  const max = 4;
  const shown = tags.length > max ? tags.slice(0, max - 1) : tags;
  shown.forEach((t, i) => {
    const ty = top - 26 - i * 20;
    waitBadge(B, cx, ty, t.id, t.words);
    hits.push({ x: cx - 30, y: ty, w: 60, h: 17, kind: "board", title: `${t.id} · ${t.words}`, sub: t.sub });
  });
  if (tags.length > max) {
    const ty = top - 26 - (max - 1) * 20;
    B.box(cx - 18, ty + 3, 36, 10, T.plate, { r: 2, ink: !P });
    B.text(cx, ty + 4.6, `+${tags.length - (max - 1)} more`, T.plateFg, 5.2, 900, { anchor: "middle" });
  }
}

/** The prep line: five cooktop pods with aisles. Burners glow while someone is cooking. */
function line(B: Backend, m: GalleyModel, f: FrameState, P: boolean, hits: Hit[]) {
  m.pods.forEach((pod, i) => {
    const x = PODS_X[i];
    const open = pod.kind !== "cook";
    B.box(x, LY, POD_W, 38, "#1d2748", { r: 4, ink: !P });
    if (P) B.rect(x, LY, POD_W, 1, open ? "#56628a" : C.teal);
    // hood light above the pod
    B.rect(x + 10, LY - 2, POD_W - 20, 2, open ? "#3a4870" : T.warm);
  });
  m.pods.forEach((pod, i) => {
    const x = PODS_X[i];
    const spot = SPOTS.pod(i);
    const cx = spot.x;
    const member = pod.kind === "cook" ? pod.member : null;
    const a = member ? f.actors.get(member.id) : null;
    const atPod = !!member && !!a && !a.moving && Math.abs(a.x - cx) < 1 && Math.abs(a.y - spot.y) < 1;
    // The cook stands at the counter's top edge: the cooktop sits below its feet and hides nothing.
    const box = member && atPod ? bot(B, member.character, cx, spot.y) : null;
    // cooktop: steel counter with two burners (lit when cooking)
    B.box(x + 3, LY + 22, POD_W - 6, 12, "#c9d3e0", { ink: true, r: 3, shade: true, hi: true });
    for (const bx of [x + 13, x + POD_W - 13]) {
      B.ell(bx, LY + 28, 5, 2.6, "#2a2f3d");
      B.ell(bx, LY + 28, 3.4, 1.6, member ? C.orange : "#3a4660");
    }
    if (member && atPod) {
      const prop = POD_PROPS[member.character];
      if (prop) B.sprite(x, LY, 1, prop);
    }
    if (member) {
      const sub = `${member.role} · ${member.ticket ?? "no ticket"} · ${member.status}`;
      if (box) {
        if (f.selected === member.id) brackets(B, box);
        const b = badge(B, cx, box.y - 16, member.state === "needs" ? "needs" : "work", member.ticket, "", { alert: member.state === "needs" });
        hits.push({ ...b, kind: "agent", id: member.id, title: `${member.name} · ${member.job}`, sub });
        hits.push(agentHit(box, member, sub));
      }
      const plate = nameplate(B, cx, LY + 38, member.name, member.job, P, f.selected === member.id);
      hits.push({ ...plate, kind: "agent", id: member.id, title: `${member.name} · ${member.job}`, sub });
    }
  });
  if (m.podOverflow) {
    // Under the last pod's plate, right-aligned to it: the lane and the café leave no room beside the line.
    const t = `+${m.podOverflow} cooking`;
    const tw = B.tw(t, 5.2, 900) + 6;
    const tx = PODS_X[4] + POD_W - tw;
    B.box(tx, LY + 58, tw, 9, T.plate, { r: 2, ink: !P });
    B.text(tx + 3, LY + 59.4, t, T.plateFg, 5.2, 900);
  }
}

/** A crew member wherever its actor currently is (walking, in the office, beside the scanner). */
function actorAt(B: Backend, c: CrewMember, f: FrameState, hits: Hit[]): Box | null {
  const a = f.actors.get(c.id);
  if (!a || a.x < 0 || inBeam(a, f.now)) return null;
  const bob = a.moving && !f.reduce ? (Math.floor(f.now / 160) % 2) * -1 : 0;
  const box = bot(B, c.character, a.x, a.y + bob, a.alpha);
  if (f.selected === c.id) brackets(B, box);
  hits.push(agentHit(box, c, `${c.role}${c.ticket ? ` · ${c.ticket}` : ""} · ${c.status}`));
  if (c.place === "pass" && !a.moving) {
    const needs = c.state === "needs";
    const b = badge(B, a.x, box.y - 16, needs ? "needs" : "review", c.ticket, needs ? "needs you" : "", { alert: needs });
    hits.push({ ...b, kind: "agent", id: c.id, title: `${c.name} · ${c.job}`, sub: `${c.role} · ${c.ticket ?? ""} · ${needs ? "needs you" : c.role === "adversary" ? "tasting" : "at the pass"}` });
  }
  return box;
}

/** Everyone in transit — drawn last, with a small name tag. */
function walkers(B: Backend, m: GalleyModel, f: FrameState, hits: Hit[], P: boolean) {
  for (const c of m.crew) {
    const a = f.actors.get(c.id);
    if (!a || a.x < 0 || c.place === "island" || c.place === "pass" || inBeam(a, f.now) || (!a.moving && c.place !== "gone")) continue;
    const box = actorAt(B, c, f, hits);
    if (!box) continue;
    const t = c.name;
    const tw = B.tw(t, 5.6, 800) + 6;
    B.box(a.x - tw / 2, box.y - 11, tw, 8.4, T.plate, { r: 2, ink: !P });
    B.text(a.x, box.y - 10, t, T.plateFg, 5.6, 800, { anchor: "middle" });
  }
}

export function drawGalley(B: Backend, m: GalleyModel, f: FrameState): Hit[] {
  const P = B.kind === "pixel";
  const hits: Hit[] = [];
  space(B, f.view);
  hull(B, P);
  orderBoard(B, m, P, hits);
  kitchen(B);
  lounge(B, m, f, P, hits);
  belt(B, f);
  hatch(B, f, m.served, hits);
  cafe(B, m, f, P, hits);
  line(B, m, f, P, hits);
  transporter(B, m, f, P, hits);
  subagents(B, m, f, P, hits);
  scanner(B, m, f, P, hits);
  floorCrew(B, m, f, P, hits);
  headChef(B, m, f, P, hits);
  deliveries(B, f);
  walkers(B, m, f, hits, P);
  return hits;
}

/** True while something in the room animates for a real reason (a review being scanned, a helper at work). */
export function sceneAnimating(m: GalleyModel): boolean {
  return m.reviewers.some((r) => r.running && r.state !== "needs") || m.helpers.length > 0;
}

/** The waypoints from `a` to `t`: along the upper aisle, and down the lane for the scanner. */
export function route(a: { x: number; y: number }, t: { x: number; y: number }): { x: number; y: number }[] {
  const low = (p: { y: number }) => p.y > SUBS_Y;
  const pts: { x: number; y: number }[] = [];
  if (low(a) && !low(t)) pts.push({ x: LANE_X, y: a.y }, { x: LANE_X, y: AISLE_Y }, { x: t.x, y: AISLE_Y });
  else if (!low(a) && low(t)) pts.push({ x: a.x, y: AISLE_Y }, { x: LANE_X, y: AISLE_Y }, { x: LANE_X, y: t.y });
  else if (!low(a) && !low(t) && (Math.abs(a.y - AISLE_Y) > 4 || Math.abs(t.y - AISLE_Y) > 4)) pts.push({ x: a.x, y: AISLE_Y }, { x: t.x, y: AISLE_Y });
  pts.push({ x: t.x, y: t.y });
  const out: { x: number; y: number }[] = [];
  let prev = a;
  for (const p of pts) {
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1) continue;
    out.push(p);
    prev = p;
  }
  return out.length ? out : [{ x: t.x, y: t.y }];
}

/** Where a crew member belongs right now. Off-shift crew go to their hangout (see HANGOUTS), or out of view. */
export function targetFor(m: GalleyModel, c: CrewMember, spotOf: Map<string, number>): { x: number; y: number; seated: boolean } {
  if (c.place === "island") return { ...SPOTS.island, seated: false };
  if (c.place === "gone") return { ...SPOTS.tube, seated: false };
  if (c.place === "pod") {
    const i = m.pods.findIndex((p) => p.kind === "cook" && p.member.id === c.id);
    return i >= 0 ? { ...SPOTS.pod(i), seated: false } : { ...SPOTS.tubeQueue, seated: false };
  }
  if (c.place === "pass") {
    const i = m.reviewers.findIndex((r) => r.id === c.id);
    return i >= 0 && i < SPOTS.pass.length ? { ...SPOTS.pass[i], seated: false } : { ...SPOTS.passQueue, seated: false };
  }
  const i = spotOf.get(c.id);
  if (i === undefined) return { x: -1, y: -1, seated: false };
  const s = HANGOUTS[i];
  return { x: s.x, y: s.y, seated: s.kind !== "floor" };
}
