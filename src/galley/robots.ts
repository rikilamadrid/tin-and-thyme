// The robot crew, as parts (back → front) plus flat details. The approved
// designs (Basil, the six cooks, Dash) are ported from
// docs/art-concepts/galley-robots.html unchanged. Pinch (adversary) and the
// neutral crew bot are new silhouettes made to sit beside them.

import type { CharacterId } from "../data/crew";
import { INK, type Backend } from "./backend";

export const C = {
  white: "#e8eef6", light: "#c9d3e0", steel: "#8f9cb2", dark: "#3a4660", screen: "#1b2338", cyan: "#6fe3ff", gold: "#ffc93a",
  red: "#e2513f", blue: "#3f74c8", orange: "#ff8a3a", green: "#4fbf86", glass: "#bfeee6", pink: "#f2a0b8", cream: "#f6eedd",
  purple: "#7d58c2", yellow: "#f0b23a", teal: "#38d9c9", coral: "#e8664a",
} as const;

type Part = [kind: "b" | "e", x: number, y: number, w: number, h: number, colour: string, opts?: { r?: number; noShade?: boolean }];
type Detail = [x: number, y: number, w: number, h: number, colour: string];
interface RobotDef {
  w: number;
  h: number;
  parts: Part[];
  details: Detail[];
  eye?: [number, number];
}

export const ROBOTS: Record<CharacterId, RobotDef> = {
  basil: { w: 20, h: 34, parts: [
    ["b", 6, 26, 3, 6, C.steel], ["b", 11, 26, 3, 6, C.steel], ["b", 5, 31, 5, 3, C.dark, { r: 1 }], ["b", 10, 31, 5, 3, C.dark, { r: 1 }],
    ["b", 1, 15, 3, 9, C.light, { r: 1 }], ["b", 16, 15, 3, 9, C.light, { r: 1 }],
    ["b", 4, 14, 12, 13, C.white, { r: 2 }], ["b", 9, 12, 2, 2, C.steel, { noShade: true }],
    ["b", 5, 6, 10, 7, C.white, { r: 2 }],
    ["b", 5, 1, 10, 5, C.white, { r: 2 }], ["e", 10, 1.5, 4.5, 2.2, C.white],
    ["b", 16, 19, 5, 6, C.screen, { r: 1 }],
  ], details: [[6, 8, 8, 3, C.screen], [7, 9, 2, 1, C.cyan], [11, 9, 2, 1, C.cyan], [5, 5, 10, 1, C.steel], [13, -1, 1, 2, C.steel], [13, -2, 1, 1, C.gold], [6, 16, 8, 5, C.screen], [7, 17, 2, 1, C.gold], [10, 17, 3, 1, C.cyan], [7, 19, 6, 1, C.steel], [17, 20, 3, 4, C.cyan], [1, 24, 3, 2, C.dark], [16, 24, 2, 2, C.dark], [7, 3, 6, 1, C.light]] },
  pepper: { w: 22, h: 26, parts: [
    ["b", 3, 20, 14, 6, C.dark, { r: 2 }], ["b", 1, 13, 3, 6, C.steel, { r: 1 }], ["b", 16, 13, 3, 4, C.steel, { r: 1 }],
    ["b", 4, 11, 12, 10, C.light, { r: 2 }], ["b", 6, 3, 8, 8, C.light, { r: 2 }],
    ["b", 17, 7, 5, 7, "#eef3f8", { noShade: true }],
  ], details: [[6, 4, 8, 2, C.red], [14, 3, 2, 2, C.red], [15, 5, 2, 1, C.red], [7, 7, 6, 2, C.screen], [8, 7, 1, 1, C.cyan], [11, 7, 1, 1, C.cyan], [4, 12, 12, 1, C.red], [6, 14, 8, 4, C.screen], [7, 15, 3, 1, "#7fe08a"], [4, 22, 12, 1, "#5a6680"], [4, 24, 12, 1, "#5a6680"], [5, 21, 1, 4, "#5a6680"], [9, 21, 1, 4, "#5a6680"], [13, 21, 1, 4, "#5a6680"], [21, 7, 1, 7, C.steel], [17, 13, 2, 2, C.dark], [0, 18, 2, 2, C.dark], [3, 18, 1, 2, C.dark]] },
  roux: { w: 22, h: 26, parts: [
    ["b", 4, 21, 4, 4, C.dark, { r: 1 }], ["b", 12, 21, 4, 4, C.dark, { r: 1 }], ["b", 1, 14, 3, 4, C.steel, { r: 1 }], ["b", 16, 14, 3, 4, C.steel, { r: 1 }],
    ["e", 10, 16, 8, 6.5, C.blue], ["b", 5, 6, 10, 5, C.white, { r: 2 }], ["b", 4, 9, 12, 3, C.light, { r: 1 }],
  ], details: [[6, 6, 1, 4, C.light], [9, 6, 1, 4, C.light], [12, 6, 1, 4, C.light], [6, 13, 8, 3, C.screen], [7, 14, 2, 1, C.cyan], [11, 14, 2, 1, C.cyan], [5, 18, 10, 1, "#2f5a9e"], [18, 12, 1, 6, C.steel], [17, 6, 1, 6, C.steel], [20, 6, 1, 6, C.steel], [18, 5, 2, 1, C.steel], [18, 11, 2, 1, C.steel], [18, 8, 2, 1, C.steel], [0, 17, 2, 2, C.dark]] },
  ember: { w: 22, h: 26, parts: [
    ["e", 10, 23, 3, 3, C.dark], ["b", 14, 2, 3, 7, C.steel, { noShade: true }], ["b", 0, 12, 3, 5, C.orange, { r: 1 }], ["b", 17, 12, 2, 5, C.steel, { r: 1 }],
    ["b", 3, 8, 14, 13, "#55607e", { r: 2 }],
  ], details: [[5, 10, 10, 5, C.screen], [6, 12, 8, 1, C.orange], [7, 11, 6, 1, "#ff6a1a"], [4, 17, 12, 1, "#3a4462"], [6, 18, 2, 2, C.orange], [12, 18, 2, 2, "#3a4462"], [14, 1, 3, 1, C.dark], [15, -1, 1, 1, "#c9d3e0"], [16, -3, 1, 1, "#aab4c4"], [19, 6, 1, 8, C.steel], [21, 6, 1, 8, C.steel], [19, 5, 3, 1, C.steel], [10, 22, 1, 1, C.steel]] },
  sprig: { w: 20, h: 26, parts: [
    ["b", 3, 17, 1, 8, C.steel, { noShade: true }], ["b", 7, 18, 1, 7, C.steel, { noShade: true }], ["b", 12, 18, 1, 7, C.steel, { noShade: true }], ["b", 16, 17, 1, 8, C.steel, { noShade: true }],
    ["b", 1, 12, 2, 4, C.light, { r: 1 }], ["b", 17, 12, 2, 4, C.light, { r: 1 }],
    ["e", 10, 15.5, 7.5, 2.8, "#dfe8e4"], ["e", 10, 9, 5.5, 5, C.glass],
  ], details: [[9, 7, 1, 5, "#3f8f5a"], [7, 6, 2, 2, C.green], [10, 5, 3, 2, C.green], [8, 9, 2, 1, "#7fd08a"], [6, 12, 8, 1, C.steel], [8, 15, 4, 1, C.screen], [9, 15, 1, 1, C.cyan], [2, 24, 3, 1, C.dark], [6, 24, 3, 1, C.dark], [11, 24, 3, 1, C.dark], [15, 24, 3, 1, C.dark], [18, 10, 1, 2, C.steel], [19, 9, 1, 1, C.steel], [0, 16, 1, 1, "#7fd08a"], [1, 15, 1, 1, C.green]] },
  crumb: { w: 22, h: 26, parts: [
    ["b", 5, 20, 3, 5, C.steel, { r: 1 }], ["b", 12, 20, 3, 5, C.steel, { r: 1 }], ["b", 1, 14, 3, 5, C.cream, { r: 1 }], ["b", 16, 14, 3, 5, C.cream, { r: 1 }],
    ["e", 10, 15, 7.5, 6.5, C.cream], ["b", 4, 3, 13, 6, C.pink, { r: 2 }], ["b", 12, 8, 2, 4, C.steel, { noShade: true }],
  ], details: [[5, 5, 6, 2, C.screen], [6, 5, 1, 1, C.cyan], [9, 5, 1, 1, C.cyan], [14, 4, 2, 1, "#ffd0dc"], [11, 12, 4, 2, C.light], [6, 15, 8, 4, "#f7c6d4"], [0, 18, 6, 2, "#c9a06a"], [-1, 18, 1, 2, "#8a5a34"], [6, 1, 9, 2, "#e588a2"]] },
  mochi: { w: 22, h: 26, parts: [
    ["e", 10, 23.5, 2.8, 2.5, C.dark], ["b", 1, 13, 3, 4, C.steel, { r: 1 }], ["b", 16, 13, 2, 3, C.steel, { r: 1 }],
    ["b", 4, 11, 12, 11, C.purple, { r: 2 }], ["b", 5, 4, 10, 7, C.light, { r: 2 }], ["b", 5, 2, 10, 3, C.yellow, { r: 1 }],
  ], details: [[2, 3, 3, 1, C.yellow], [4, 5, 1, 3, C.steel], [15, 5, 1, 3, C.steel], [4, 4, 1, 1, C.gold], [15, 4, 1, 1, C.gold], [7, 7, 6, 2, C.screen], [8, 7, 1, 1, C.cyan], [11, 7, 1, 1, C.cyan], [6, 14, 8, 3, "#5d3f9a"], [7, 15, 2, 1, C.yellow], [17, 13, 5, 3, C.dark], [18, 14, 3, 1, "#55607e"]] },
  dash: { w: 22, h: 26, parts: [
    ["b", 8, 17, 6, 2, C.steel, { noShade: true }], ["e", 11, 13, 9.5, 3.5, C.light], ["e", 11, 11.5, 8.5, 3.5, C.white], ["e", 11, 7.5, 5, 4, C.white],
  ], details: [[18, 2, 1, 11, C.steel], [17, 3, 3, 2, "#ffffff"], [17, 6, 3, 2, "#fff6df"], [9, 19, 4, 1, C.teal], [10, 20, 2, 1, "#2a9a92"], [3, 12, 3, 1, C.teal], [16, 12, 3, 1, C.teal]], eye: [11, 7.5] },
  // Adversary · "Taster": a low, wide crab bot with two raised pincers and a tasting spoon.
  // Wide-and-low reads apart from Dash (round hover drone) and every upright cook.
  pinch: { w: 26, h: 24, parts: [
    ["b", 4, 18, 1, 5, C.steel, { noShade: true }], ["b", 8, 19, 1, 4, C.steel, { noShade: true }], ["b", 17, 19, 1, 4, C.steel, { noShade: true }], ["b", 21, 18, 1, 5, C.steel, { noShade: true }],
    ["b", 1, 8, 2, 8, C.steel, { r: 1 }], ["b", 23, 8, 2, 8, C.steel, { r: 1 }],
    ["e", 2.5, 6, 3.2, 2.8, C.coral], ["e", 23.5, 6, 3.2, 2.8, C.coral],
    ["e", 13, 15, 10, 5.5, C.coral], ["b", 8, 6, 2, 5, C.steel, { noShade: true }], ["b", 16, 6, 2, 5, C.steel, { noShade: true }],
    ["e", 9, 5, 2.4, 2.4, C.white], ["e", 17, 5, 2.4, 2.4, C.white],
  ], details: [[0, 5, 3, 1, INK], [23, 5, 3, 1, INK], [9, 5, 1, 1, INK], [17, 5, 1, 1, INK], [7, 13, 12, 4, C.screen], [8, 14, 3, 1, C.gold], [15, 14, 3, 1, C.gold], [5, 18, 16, 1, "#b8452f"], [11, 11, 4, 1, "#ff9c84"], [24, 9, 1, 6, C.light], [23, 15, 3, 2, C.light]] },
  // Neutral crew bot for roles without a kitchen design: a plain grey box bot.
  unit: { w: 18, h: 26, parts: [
    ["b", 4, 21, 3, 5, C.dark, { r: 1 }], ["b", 11, 21, 3, 5, C.dark, { r: 1 }], ["b", 0, 12, 3, 6, C.steel, { r: 1 }], ["b", 15, 12, 3, 6, C.steel, { r: 1 }],
    ["b", 3, 11, 12, 11, "#9aa6ba", { r: 2 }], ["b", 4, 3, 10, 8, "#b3bdcc", { r: 2 }],
  ], details: [[8, 0, 2, 3, C.steel], [8, -1, 2, 1, C.cyan], [5, 5, 8, 3, C.screen], [6, 6, 2, 1, C.cyan], [10, 6, 2, 1, C.cyan], [5, 14, 8, 5, "#6f7c94"], [6, 15, 6, 1, "#c9d3e0"], [6, 17, 4, 1, "#c9d3e0"]] },
};

function part(B: Backend, p: Part, x: number, y: number, o: { ink?: boolean; inkOnly?: boolean; shade?: boolean; hi?: boolean }) {
  const [k, px, py, w, h, c, po = {}] = p;
  if (k === "b") B.box(x + px, y + py, w, h, c, { r: po.r ?? 0, ...o });
  else B.ell(x + px, y + py, w, h, c, o);
}

/** Cel-only personality: inked tool lines and motion marks. */
function celFlair(B: Backend, id: CharacterId, x: number, y: number) {
  if (id === "roux") {
    B.path(`M${x + 18.5} ${y + 12} q-2.6 -3 0 -6.6 q2.6 3.6 0 6.6z`, "none", { stroke: INK, width: 0.6 });
    B.path(`M${x + 18.5} ${y + 12} q-1 -3 0 -6.6 q1 3.6 0 6.6z`, "none", { stroke: INK, width: 0.5 });
  }
  if (id === "dash") B.path(`M${x + 1} ${y + 18} q2 1 4 0 M${x + 17} ${y + 18} q2 1 4 0`, "none", { stroke: "#6fe3ff", width: 0.6 });
  if (id === "ember") B.path(`M${x + 15.5} ${y + 1} q-2 -2 0 -4 q2 -2 0 -4`, "none", { stroke: "#c9d3e0", width: 0.7 });
  if (id === "pepper") B.path(`M${x + 17} ${y + 7} h5 v7 h-5z`, "none", { stroke: INK, width: 0.6 });
  if (id === "pinch") B.path(`M${x + 0.5} ${y + 3} l2 2 M${x + 25.5} ${y + 3} l-2 2`, "none", { stroke: INK, width: 0.6 });
}

export interface RobotOpts {
  /** Draw a soft floor shadow (cel). */
  shadow?: boolean;
}

/** Draws a robot with its top-left at (x, y). */
export function drawRobot(B: Backend, id: CharacterId, x: number, y: number, o: RobotOpts = {}) {
  const R0 = ROBOTS[id];
  const cel = B.kind === "cel";
  const draw = () => {
    if (!cel) R0.parts.forEach((p) => part(B, p, x, y, { ink: true, inkOnly: true }));
    R0.parts.forEach((p) => part(B, p, x, y, { ink: cel, shade: !p[6]?.noShade, hi: true }));
    R0.details.forEach(([dx, dy, w, h, c]) => B.rect(x + dx, y + dy, w, h, c));
    if (R0.eye) {
      const [ex, ey] = R0.eye;
      B.ell(x + ex, y + ey, 3, 3, INK, { ink: cel });
      B.ell(x + ex, y + ey, 1.8, 1.8, C.teal);
      B.rect(x + ex - 1, y + ey - 1, 1, 1, "#ffffff");
    }
    if (cel) celFlair(B, id, x, y);
  };
  if (cel && o.shadow !== false) B.ell(x + R0.w / 2, y + R0.h + 0.5, R0.w * 0.42, 1.6, "#0b1022");
  draw();
}

export const robotSize = (id: CharacterId) => ({ w: ROBOTS[id].w, h: ROBOTS[id].h });

export type IconKind = "work" | "review" | "needs" | "wait" | "off" | "lock" | "idle" | "done";

/** State marks: shape, not colour, carries the meaning. */
export function icon(B: Backend, k: IconKind, x: number, y: number, sz: number, color: string, cut?: string) {
  const u = sz / 5;
  if (B.kind === "pixel") {
    const G: Record<IconKind, string[]> = {
      work: [".....", ".###.", ".###.", ".###.", "....."],
      idle: [".....", ".###.", ".#.#.", ".###.", "....."],
      review: [".##..", "#..#.", "#..#.", ".##..", "...##"],
      needs: ["..#..", ".###.", "##.##", ".###.", "..#.."],
      wait: ["#####", ".#.#.", "..#..", ".#.#.", "#####"],
      off: [".###.", "#....", "#..#.", "#....", ".###."],
      lock: [".###.", ".#.#.", "#####", "##.##", "#####"],
      done: [".....", "....#", "...#.", "#.#..", ".#..."],
    };
    const z = Math.max(1, Math.round(u));
    G[k].forEach((r, j) => [...r].forEach((ch, i) => ch === "#" && B.rect(Math.round(x) + i * z, Math.round(y) + j * z, z, z, color)));
    return;
  }
  if (k === "work") B.rect(x + u, y + u, u * 3, u * 3, color);
  if (k === "idle") B.path(`M${x + u * 1.4} ${y + u * 1.4} h${u * 2.2} v${u * 2.2} h${-u * 2.2}z`, "none", { stroke: color, width: u * 0.8 });
  if (k === "review") {
    B.path(`M${x + u * 2} ${y + u * 0.5} a${u * 1.5} ${u * 1.5} 0 1 0 .01 0z`, "none", { stroke: color, width: u * 0.9 });
    B.line(x + u * 3, y + u * 3, x + u * 4.6, y + u * 4.6, color, u * 1.1);
  }
  if (k === "needs") {
    B.path(`M${x + u * 2.5} ${y} L${x + u * 5} ${y + u * 2.5} L${x + u * 2.5} ${y + u * 5} L${x} ${y + u * 2.5} Z`, color);
    B.rect(x + u * 2.1, y + u, u * 0.8, u * 2, cut ?? "#fff");
    B.rect(x + u * 2.1, y + u * 3.4, u * 0.8, u * 0.8, cut ?? "#fff");
  }
  if (k === "wait") B.path(`M${x} ${y} H${x + sz} L${x + u * 3} ${y + u * 2.5} L${x + sz} ${y + sz} H${x} L${x + u * 2} ${y + u * 2.5} Z`, color);
  if (k === "off") B.path(`M${x + u * 3.5} ${y + u * 0.2} A${u * 2.4} ${u * 2.4} 0 1 0 ${x + u * 3.5} ${y + u * 4.8} A${u * 1.8} ${u * 1.8} 0 1 1 ${x + u * 3.5} ${y + u * 0.2} Z`, color);
  if (k === "lock") {
    B.path(`M${x + u * 1.3} ${y + u * 2.2} v${-u * 0.6} a${u * 1.2} ${u * 1.2} 0 0 1 ${u * 2.4} 0 v${u * 0.6}`, "none", { stroke: color, width: u * 0.8 });
    B.rect(x + u * 0.6, y + u * 2.2, u * 3.8, u * 2.6, color);
  }
  if (k === "done") B.path(`M${x + u * 0.5} ${y + u * 2.8} L${x + u * 1.9} ${y + u * 4.2} L${x + u * 4.6} ${y + u * 1}`, "none", { stroke: color, width: u * 1.1 });
}
