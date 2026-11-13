// Animated parts of the office, redrawn into a Pixi Graphics every frame.

import type { AgentState, Environment, PullRequest, ReviewState } from "../../data/types";
import { reviewStyle, stateStyle } from "../../theme/tokens";
import { fit, tag, text, textW } from "../engine/font";
import { C } from "../engine/palette";
import { box, disc, drawRows, line, type Pen } from "../engine/pen";
import type { DeskSpot, OfficeLayout, PxRect, Rack } from "../layout/layout";
import { RABBIT, RABBIT_BLINK, RABBIT_PAL, SCANNER, SCANNER_PAL } from "./robots";

const blink = (t: number, hz: number) => Math.floor(t * hz) % 2 === 1;

/** Tiny monitor content: code lines, or a status picture. */
export function drawScreen(p: Pen, sx: number, sy: number, state: AgentState, color: string, t: number, variant: number) {
  p.rect(sx, sy, 18, 11, C.screen);
  if (state === "needs-input") {
    if (blink(t, 4)) {
      p.rect(sx, sy, 18, 11, "#7e0f33");
      p.rect(sx + 8, sy + 2, 2, 5, C.white);
      p.rect(sx + 8, sy + 8, 2, 1, C.white);
    } else {
      p.rect(sx + 8, sy + 2, 2, 5, C.red);
      p.rect(sx + 8, sy + 8, 2, 1, C.red);
    }
  } else if (state === "in-review") {
    const c = C.orange;
    p.rect(sx + 6, sy + 2, 6, 1, c);
    p.rect(sx + 7, sy + 3, 4, 1, c);
    p.rect(sx + 8, sy + 4, 2, 2, c);
    p.rect(sx + 7, sy + 6, 4, 1, c);
    p.rect(sx + 6, sy + 7, 6, 1, c);
  } else if (state === "review-passed") {
    for (let i = 0; i < 8; i++) p.rect(sx + 5 + i, sy + (i < 3 ? 5 + i : 10 - i), 1, 1, C.green);
  } else if (state === "idle") {
    const bx = Math.floor(Math.abs(((t * 6 + variant * 5) % 32) - 16));
    const by = Math.floor(Math.abs(((t * 4 + variant * 3) % 18) - 9));
    p.rect(sx + Math.min(16, bx), sy + Math.min(9, by), 2, 2, color);
  } else {
    // scrolling code
    const step = Math.floor(t * 3);
    for (let i = 0; i < 5; i++) {
      const n = (step + i) * 7 + variant * 13;
      const indent = (n % 3) * 2;
      const len = 3 + ((n * 5) % 9);
      p.rect(sx + 1 + indent, sy + 1 + i * 2, len, 1, [C.blue, C.pink, C.green, "#c9b6ff", C.white][n % 5]);
    }
    if (blink(t, 3)) p.rect(sx + 1, sy + 11 - 1, 2, 1, C.white);
  }
}

/** Status light along the cubicle's top partition. */
export function drawDeskStrip(p: Pen, d: DeskSpot, ox: number, oy: number, state: AgentState, t: number) {
  const st = stateStyle[state];
  let col = st.color;
  if (state === "needs-input") col = blink(t, 6) ? C.red : st.dim;
  if (state === "idle") col = st.dim;
  const X = ox + d.x0 * 16;
  const Y = oy + d.y0 * 16;
  for (let tx = 0; tx < 7; tx++) if (tx !== 1) p.rect(X + tx * 16, Y, 16, 3, col);
  if (state === "working") p.rect(X + (Math.floor(t * 40) % 112), Y, 8, 3, "#bfe9ff");
}

export function drawLeadLamp(p: Pen, ox: number, oy: number, state: AgentState, t: number) {
  const st = stateStyle[state];
  p.rect(ox + 278, oy + 90, 6, 2, C.ink);
  p.rect(ox + 280, oy + 80, 1, 10, C.ink);
  box(p, ox + 277, oy + 76, 8, 5, state === "needs-input" && blink(t, 6) ? st.dim : st.color);
}

export function drawBelt(p: Pen, l: OfficeLayout, t: number) {
  const b = l.belt;
  const off = Math.floor(t * 26) % 6;
  const y = b.y - 9;
  const x1 = b.topY !== null ? b.x1 + 9 : b.x1;
  p.rect(b.x0 - 6, y, x1 - b.x0 + 6, 18, C.ink);
  p.rect(b.x0 - 4, y + 3, x1 - b.x0 + 2, 12, C.belt);
  for (let x = b.x0 - 4 + off; x < x1 - 2; x += 6) p.rect(x, y + 4, 1, 10, C.beltL);
  p.rect(b.x0 - 4, y + 2, x1 - b.x0 + 2, 1, C.rail);
  p.rect(b.x0 - 4, y + 15, x1 - b.x0 + 2, 1, C.rail);
  p.rect(b.x0 - 8, y + 1, 4, 16, C.metalD);
  if (b.topY !== null) {
    const vx = b.x1 - 9;
    p.rect(vx, b.topY, 18, b.y - b.topY + 9, C.ink);
    p.rect(vx + 3, b.topY + 2, 12, b.y - b.topY + 4, C.belt);
    for (let yy = b.y - off; yy > b.topY + 2; yy -= 6) p.rect(vx + 4, yy, 10, 1, C.beltL);
    p.rect(vx + 2, b.topY + 2, 1, b.y - b.topY, C.rail);
    p.rect(vx + 15, b.topY + 2, 1, b.y - b.topY, C.rail);
    p.rect(vx + 1, b.topY - 6, 16, 6, "#1f1d26");
  }
}

export type GateMode = "idle" | "reviewing" | "passed" | "changes";

export function drawGate(p: Pen, g: PxRect, mode: GateMode, since: number, t: number, label: string, rabbit: boolean) {
  const x0 = g.x;
  const x1 = g.x + g.w;
  const w = g.w;
  const cx = Math.round((x0 + x1) / 2);
  const top = g.y;
  p.rect(x0, top, w, 46, C.ink);
  p.rect(x0 + 1, top + 1, w - 2, 11, C.metal);
  p.rect(x0 + 1, top + 1, w - 2, 1, C.metalL);
  p.rect(x0 + 1, top + 12, w - 2, 33, C.metalD);
  p.rect(x0 + 1, top + 25, 3, 15, "#1f1d26");
  p.rect(x1 - 4, top + 25, 3, 15, "#1f1d26");
  p.rect(x0 + 12, top + 16, 44, 21, C.ink);
  p.rect(x0 + 13, top + 17, 42, 19, "#0f2a1f");
  for (let y = top + 19; y < top + 35; y += 4) p.rect(x0 + 14, y, 40, 1, "#163d2c");
  if (mode === "reviewing") {
    p.rect(cx - 5, top + 22, 10, 9, "#a8e72c");
    p.rect(cx - 4, top + 23, 8, 7, "#0f2a1f");
    p.rect(cx - 1, top + 23, 2, 7, "#a8e72c");
    p.rect(x0 + 13 + Math.floor((t * 30) % 42), top + 17, 1, 19, C.yellow);
  } else if (mode === "passed") text(p, "OK", cx - 3, top + 24, C.green);
  else if (mode === "changes") text(p, "FIX", cx - 5, top + 24, C.red);
  const lbl = fit(label.toUpperCase(), w - 4);
  text(p, lbl, cx - textW(lbl) / 2, top + 39, C.ink);
  [5, 15, w - 18, w - 8].forEach((lx, i) => {
    let col = "#5a5170";
    if (mode === "reviewing") col = i === Math.floor(t * 8) % 4 ? C.orange : "#7a4a10";
    else if (mode === "passed") col = blink(t, 8) ? C.green : "#00873a";
    else if (mode === "changes") col = blink(t, 8) ? C.red : "#7e0f33";
    p.rect(x0 + lx, top + 3, 6, 4, C.ink);
    p.rect(x0 + lx + 1, top + 3, 4, 3, col);
  });
  let hop = 0;
  if (mode === "reviewing") hop = Math.round(Math.abs(Math.sin(t * 8)) * 3);
  else if (mode === "passed") hop = Math.round(Math.sin(Math.min(1, since / 0.6) * Math.PI) * 8);
  disc(p, cx, top + 4, 4, C.ink, 0.25);
  if (rabbit) drawRows(p, Math.floor(t * 10) % 31 === 0 ? RABBIT_BLINK : RABBIT, RABBIT_PAL, cx - 4, top - 8 - hop);
  else drawRows(p, SCANNER, SCANNER_PAL, cx - 4, top - 6 - hop);
}

export function drawRacks(
  p: Pen, racks: Rack[], envs: Environment[], stateOf: (agentId: string | null) => AgentState | null,
  pulse: (name: string) => number, t: number,
) {
  for (const r of racks) {
    const env = envs.find((e) => e.name === r.name);
    const st = stateOf(r.agentId);
    const activity = env?.status === "sleeping" ? 0.03 : st ? { working: 0.8, "in-review": 0.45, "review-passed": 0.6, "needs-input": 0.12, waiting: 0.2, idle: 0.1 }[st] : 0.35;
    const seedT = Math.floor(t * 10);
    const pz = pulse(r.name);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 3; j++) {
        const h = Math.sin((seedT + 1) * 12.9898 + (i * 3 + j) * 78.233 + r.x) * 43758.5453;
        const rnd = h - Math.floor(h);
        let col = "#2e2b36";
        if (env?.status === "deploying") col = (i + Math.floor(t * 12)) % 3 === 0 ? "#3ee0d0" : "#1f5f66";
        else if (pz > 0.05) col = blink(t, 12) ? C.green : "#00873a";
        else if (rnd < activity) col = j === 2 && rnd < 0.08 ? C.orange : (i + j) % 3 ? C.green : C.blue;
        p.rect(r.x + 18 + j * 3, r.y + 15 + i * 10, 2, 1, col);
      }
    if (pz > 0.05) {
      p.rect(r.x, r.y - 1, 32, 2, C.green, pz);
      p.rect(r.x, r.y + r.h - 1, 32, 2, C.green, pz);
      p.rect(r.x, r.y - 1, 2, r.h, C.green, pz);
      p.rect(r.x + 30, r.y - 1, 2, r.h, C.green, pz);
    }
  }
}

export function drawPrBoard(p: Pen, b: PxRect, prs: PullRequest[], colorOf: (id: string) => string) {
  prs.slice(-6).forEach((pr, i) => {
    const x = b.x + 3 + (i % 3) * 20;
    const y = b.y + 11 + Math.floor(i / 3) * 14;
    const col = pr.merged ? "#00873a" : reviewStyle[pr.review].color;
    p.rect(x + 1, y + 1, 18, 12, C.ink, 0.3);
    p.rect(x, y, 18, 12, pr.merged ? "#e0dccf" : C.white);
    text(p, `#${pr.number % 1000}`, x + 2, y + 3, C.ink);
    p.rect(x + 2, y + 9, 14, 2, col);
    p.rect(x + 8, y - 1, 3, 2, colorOf(pr.authorId));
  });
}

export function drawCables(
  p: Pen, l: OfficeLayout, stateOf: (agentId: string) => AgentState | null, colorOf: (id: string) => string, t: number,
) {
  for (const cb of l.cables) {
    const st = stateOf(cb.agentId) ?? "idle";
    const speed = { working: 60, "in-review": 24, "review-passed": 40, "needs-input": 4, waiting: 12, idle: 8 }[st];
    const phase = (t * speed) % 14;
    let acc = 0;
    for (let i = 0; i < cb.pts.length - 1; i++) {
      const [x0, y0] = cb.pts[i];
      const [x1, y1] = cb.pts[i + 1];
      const len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
      for (let d = (14 - ((((acc - phase) % 14) + 14) % 14)) % 14; d < len; d += 14) {
        const f = d / len;
        const col = st === "needs-input" ? C.red : st === "idle" ? colorOf(cb.agentId) : C.white;
        p.rect(Math.round(x0 + (x1 - x0) * f) - 1, Math.round(y0 + (y1 - y0) * f) - 1, 3, 3, col, st === "idle" ? 0.5 : 0.9);
      }
      acc += len;
    }
  }
}

export function drawWindowAndClock(p: Pen, l: OfficeLayout, t: number) {
  const W = { x: l.ox + l.lounge.x0 * 16 + 66, y: l.oy + 22, w: 60, h: 28 };
  const hour = new Date().getHours();
  const night = hour < 7 || hour >= 19;
  p.rect(W.x, W.y, W.w, W.h, night ? C.skyN : C.sky);
  if (night) {
    for (const [sx, sy] of [[6, 5], [19, 12], [33, 4], [47, 9], [54, 18], [12, 20]]) p.rect(W.x + sx, W.y + sy, 1, 1, Math.sin(t * 2 + sx) > -0.3 ? C.white : C.lav);
    disc(p, W.x + 44, W.y + 8, 3, "#fff1c4");
  } else
    for (const [off, cy, w] of [[0, 7, 14], [37, 17, 10]]) {
      const cx = W.x + ((t * 3 + off) % (W.w - w)) ;
      p.rect(cx, W.y + cy, w, 3, C.cloud);
      p.rect(cx + 3, W.y + cy - 2, w - 6, 2, C.cloud);
    }
  p.rect(W.x + W.w / 2 - 1, W.y, 2, W.h, C.white);
  p.rect(W.x, W.y + W.h / 2 - 1, W.w, 2, C.white);
  const cx = l.ox + l.lounge.x0 * 16 - 8;
  const cy = l.oy + 36;
  const d = new Date();
  const m = d.getMinutes();
  const am = (m / 60) * Math.PI * 2 - Math.PI / 2;
  const ah = (((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2 - Math.PI / 2;
  line(p, cx, cy, cx + Math.cos(am) * 5, cy + Math.sin(am) * 5, C.ink);
  line(p, cx, cy, cx + Math.cos(ah) * 3, cy + Math.sin(ah) * 3, C.red);
}

export function drawParcel(p: Pen, cx: number, cy: number, num: number, color: string, showTag: boolean) {
  const x = Math.round(cx) - 4;
  const y = Math.round(cy) - 5;
  p.rect(x, y, 8, 7, C.ink);
  p.rect(x + 1, y + 1, 6, 2, "#f0c48a");
  p.rect(x + 1, y + 3, 6, 3, "#c98a4e");
  p.rect(x + 3, y + 1, 2, 2, C.white);
  p.rect(x + 2, y + 4, 3, 1, color);
  if (showTag) tag(p, `#${num}`, cx, y - 8, C.ink, C.yellow);
}

export function drawPlanTitle(p: Pen, l: OfficeLayout, title: string) {
  const b = l.plan.board;
  tag(p, fit(title.toUpperCase(), b.w), b.x + b.w / 2, b.y - 11, C.ink, C.yellow);
}

export const reviewColor = (r: ReviewState) => reviewStyle[r].color;
