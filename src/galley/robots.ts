// The robot crew, as parts (back → front) plus flat details. The approved
// designs (Basil, the six cooks, Dash) are ported from
// docs/art-concepts/galley-robots.html unchanged. Pinch (adversary) and the
// neutral crew bot are new silhouettes made to sit beside them.
//
// The Feature 09 variants (VARIANTS below) are each built from a base def: the base parts with a
// few dropped, an accessory added and the palette accent from the crew catalogue. The base defs
// themselves are never edited.

import { CREW_VARIANTS, type CharacterId } from "../data/crew";
import { RESERVED_ACCENTS, type CrewCharacterId, type VariantCharacterId } from "../data/crewContract";
import { INK, shade, type Backend } from "./backend";

export const C = {
  white: "#e8eef6", light: "#c9d3e0", steel: "#8f9cb2", dark: "#3a4660", screen: "#1b2338", cyan: "#6fe3ff", gold: "#ffc93a",
  red: "#e2513f", blue: "#3f74c8", orange: "#ff8a3a", green: "#4fbf86", glass: "#bfeee6", pink: "#f2a0b8", cream: "#f6eedd",
  purple: "#7d58c2", yellow: "#f0b23a", teal: "#38d9c9", coral: "#e8664a",
} as const;

type Part = [kind: "b" | "e", x: number, y: number, w: number, h: number, colour: string, opts?: { r?: number; noShade?: boolean }];
type Detail = [x: number, y: number, w: number, h: number, colour: string];
/** A round scanner eye: centre, ink radius, pupil radius, pupil colour. */
type Eye = [x: number, y: number, r: number, pupil: number, colour: string];
interface RobotDef {
  w: number;
  h: number;
  parts: Part[];
  details: Detail[];
  /** Dash's single scanner eye. */
  eye?: [number, number];
  /** Variant eyes, drawn instead of `eye`. */
  eyes?: Eye[];
}

const BASE: Record<CharacterId, RobotDef> = {
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

// ---------------------------------------------------------------- Variants (Feature 09)

const WOOD = "#c9a06a";
const BROWN = "#8a5a34";

interface Variation {
  /** Recolour: exact base colour → new colour, in parts and details. */
  tint?: Record<string, string>;
  /** Base parts and details to leave out, by index in the base def. */
  dropParts?: number[];
  dropDetails?: number[];
  /** Parts drawn behind the base parts, and in front of them. */
  under?: Part[];
  parts?: Part[];
  /** Details drawn over the base details. */
  details?: Detail[];
  /** Replaces the base eye (an empty list removes it). */
  eyes?: Eye[];
}

/** A variant def: the base silhouette with an accessory. Width and height stay the base's, so a variant stands where its base would. */
function vary(base: CharacterId, v: Variation): RobotDef {
  const b = BASE[base];
  const t = (c: string) => v.tint?.[c] ?? c;
  const parts = b.parts.filter((_, i) => !v.dropParts?.includes(i)).map((p): Part => [p[0], p[1], p[2], p[3], p[4], t(p[5]), p[6]]);
  const details = b.details.filter((_, i) => !v.dropDetails?.includes(i)).map((d): Detail => [d[0], d[1], d[2], d[3], t(d[4])]);
  return {
    w: b.w,
    h: b.h,
    parts: [...(v.under ?? []), ...parts, ...(v.parts ?? [])],
    details: [...details, ...(v.details ?? [])],
    ...(v.eyes ? { eyes: v.eyes } : b.eye ? { eye: b.eye } : {}),
  };
}

const accent = (id: VariantCharacterId) => CREW_VARIANTS[id].accent;

/** Tester variants: Dash's hull with the lower saucer and running lights in the accent, and no ticket mast (details 0-2). */
const drone = (id: VariantCharacterId, v: Variation): RobotDef =>
  vary("dash", { ...v, tint: { [C.light]: accent(id), [C.teal]: accent(id), "#2a9a92": shade(accent(id), 0.7) }, dropDetails: [0, 1, 2] });

/** Adversary variants: Pinch's shell, belly line and highlight in the accent. */
const crab = (id: VariantCharacterId, v: Variation): RobotDef =>
  vary("pinch", { ...v, tint: { [C.coral]: accent(id), "#b8452f": shade(accent(id), 0.7), "#ff9c84": shade(accent(id), 1.3) } });

/** Box-bot variants: the Crew bot with its chest panel and antenna tip in the accent. */
const box = (id: VariantCharacterId, v: Variation): RobotDef =>
  vary("unit", { ...v, tint: { "#6f7c94": accent(id), "#c9d3e0": shade(accent(id), 0.55), [C.cyan]: accent(id), ...v.tint } });

// Index notes for the drops below.
//   dash  parts: 0 thruster, 1 lower saucer, 2 upper saucer, 3 dome
//   pinch parts: 0-3 legs, 4-5 arms, 6-7 claws, 8 shell, 9-10 eyestalks, 11-12 eyes
//         details: 0-1 claw slits, 2-3 pupils, 4-6 mouth, 7 belly line, 8 highlight, 9-10 tasting spoon
//   unit  parts: 0-1 feet, 2-3 arms, 4 body, 5 head
//         details: 0-1 antenna, 2-4 visor and eyes, 5-7 chest panel
const VARIANTS: Record<VariantCharacterId, RobotDef> = {
  // ---- tester family (base Dash)
  // Dot · twin scanner eyes + antenna.
  dot: drone("dot", {
    eyes: [[8.5, 7.5, 2, 1, accent("dot")], [13.5, 7.5, 2, 1, accent("dot")]],
    details: [[11, 0, 1, 4, C.steel], [10, -2, 3, 2, accent("dot")]],
  }),
  // Blip · magnifier lens (gold rim, handle) + a clipboard hanging under the rim.
  blip: drone("blip", {
    under: [["b", 1, 16, 5, 7, C.cream, { noShade: true }]],
    parts: [["e", 11, 7.5, 4.2, 4.2, C.gold, { noShade: true }]],
    eyes: [[11, 7.5, 3, 2.2, C.glass]],
    details: [[14, 10, 1, 1, BROWN], [15, 11, 2, 2, BROWN], [17, 13, 2, 2, BROWN], [2, 15, 3, 2, C.steel], [2, 18, 3, 1, C.steel], [2, 20, 2, 1, C.steel]],
  }),
  // Zest · visor band instead of an eye + an order spike on the left.
  zest: drone("zest", {
    eyes: [],
    details: [[6, 6, 10, 3, C.screen], [7, 7, 8, 1, accent("zest")], [3, 0, 1, 12, C.steel], [2, 2, 3, 2, "#ffffff"], [2, 5, 3, 2, accent("zest")], [2, 8, 3, 2, "#fff6df"]],
  }),

  // ---- adversary family (base Pinch)
  // Tang · monocle on the right eye + a notepad where the left claw was.
  tang: crab("tang", {
    dropParts: [6],
    dropDetails: [0, 9, 10],
    parts: [["b", 0, 2, 5, 7, C.cream, { noShade: true }], ["e", 17, 5, 3.6, 3.6, C.gold, { noShade: true }], ["e", 17, 5, 2.4, 2.4, C.white]],
    details: [[0, 2, 5, 1, C.steel], [1, 4, 3, 1, C.steel], [1, 6, 2, 1, C.steel], [17, 5, 1, 1, INK], [20, 8, 1, 2, C.gold], [21, 10, 1, 2, C.gold]],
  }),
  // Nib · tall eyestalks + a pepper mill where the right claw was.
  nib: crab("nib", {
    dropParts: [7, 9, 10, 11, 12],
    dropDetails: [1, 2, 3, 9, 10],
    parts: [
      ["b", 8, 2, 2, 9, C.steel, { noShade: true }], ["b", 16, 2, 2, 9, C.steel, { noShade: true }],
      ["e", 9, 1, 2.4, 2.4, C.white], ["e", 17, 1, 2.4, 2.4, C.white],
      ["b", 22, 1, 4, 8, BROWN, { r: 1 }],
    ],
    details: [[9, 1, 1, 1, INK], [17, 1, 1, 1, INK], [22, 4, 4, 1, C.cream], [23, -1, 2, 2, C.steel]],
  }),
  // Brine · a pickle jar on the shell + a dropper where the right claw was.
  brine: crab("brine", {
    dropParts: [7],
    dropDetails: [1, 9, 10],
    parts: [["b", 10, 4, 6, 9, C.glass, { r: 1 }], ["b", 23, 3, 2, 5, C.glass, { noShade: true }], ["e", 24, 1.5, 2, 2, C.dark]],
    details: [[10, 3, 6, 2, shade(accent("brine"), 0.7)], [11, 8, 2, 3, C.green], [13, 7, 2, 2, "#3f8f5a"], [24, 6, 1, 1, accent("brine")]],
  }),

  // ---- helper family (base Crew bot)
  // Whisk · a balloon whisk for an antenna + wheels for feet.
  whisk: box("whisk", {
    dropParts: [0, 1],
    dropDetails: [0, 1],
    under: [["e", 5.5, 23.5, 2.5, 2.5, C.dark], ["e", 12.5, 23.5, 2.5, 2.5, C.dark]],
    details: [
      [9, 2, 1, 1, C.steel], [7, -2, 5, 1, C.light], [6, -1, 1, 2, C.light], [12, -1, 1, 2, C.light], [7, 1, 5, 1, C.light], [8, -1, 1, 2, C.light], [10, -1, 1, 2, C.light],
      [5, 23, 1, 1, accent("whisk")], [12, 23, 1, 1, accent("whisk")], [3, 11, 12, 1, accent("whisk")],
    ],
  }),
  // Ladle · right arm raised with a ladle + a cream apron.
  ladle: box("ladle", {
    dropParts: [3],
    dropDetails: [5, 6, 7],
    parts: [["b", 15, 9, 3, 5, C.steel, { r: 1 }], ["e", 17, 1, 2.6, 2.2, C.light]],
    details: [
      [17, 3, 1, 6, C.steel], [16, 0, 2, 1, accent("ladle")],
      [5, 12, 8, 10, C.cream], [5, 11, 1, 1, C.cream], [12, 11, 1, 1, C.cream], [7, 16, 4, 3, accent("ladle")], [7, 16, 4, 1, shade(accent("ladle"), 0.7)],
    ],
  }),
  // Scoop · big scoop hands carrying a crate.
  scoop: box("scoop", {
    dropDetails: [5, 6, 7],
    parts: [["b", 2, 15, 14, 6, WOOD, { noShade: true }], ["b", -2, 16, 5, 5, accent("scoop"), { r: 1 }], ["b", 15, 16, 5, 5, accent("scoop"), { r: 1 }]],
    details: [[3, 17, 12, 1, BROWN], [3, 19, 12, 1, BROWN], [4, 12, 10, 1, accent("scoop")]],
  }),
  // Tongs · both arms raised as tongs + a satchel on a cross strap.
  tongs: box("tongs", {
    dropParts: [2, 3],
    dropDetails: [5, 6, 7],
    parts: [["b", 0, 8, 3, 6, C.steel, { r: 1 }], ["b", 15, 8, 3, 6, C.steel, { r: 1 }], ["b", 10, 16, 6, 5, BROWN, { r: 1 }]],
    details: [
      [0, 2, 1, 6, C.light], [2, 2, 1, 6, C.light], [15, 2, 1, 6, C.light], [17, 2, 1, 6, C.light], [0, 7, 3, 1, accent("tongs")], [15, 7, 3, 1, accent("tongs")],
      [4, 12, 2, 1, BROWN], [6, 13, 2, 1, BROWN], [8, 14, 2, 1, BROWN], [10, 15, 2, 1, BROWN], [10, 16, 6, 2, accent("tongs")], [12, 18, 2, 1, C.gold],
    ],
  }),

  // ---- planner and integrator
  // Sage · a menu board under the left arm + a pencil behind the head.
  sage: box("sage", {
    dropDetails: [0, 1],
    parts: [["b", -3, 11, 7, 9, C.screen, { noShade: true }]],
    details: [[-3, 11, 7, 1, accent("sage")], [-2, 13, 4, 1, "#ffffff"], [-2, 15, 5, 1, C.light], [-2, 17, 3, 1, C.light], [12, -1, 2, 4, C.yellow], [12, -2, 2, 1, C.cream], [3, 11, 12, 1, accent("sage")]],
  }),
  // Clove · a cloche for a hat + tweezers in the right hand.
  clove: box("clove", {
    dropDetails: [0, 1],
    under: [["e", 9, 3.5, 6, 4, C.light]],
    details: [[8, -2, 2, 2, accent("clove")], [3, 3, 12, 1, C.steel], [15, 18, 1, 5, C.light], [17, 18, 1, 5, C.light], [3, 11, 12, 1, accent("clove")]],
  }),

  // ---- unknown roles
  // Bolt · a question-mark panel, big side bolts and a brow band in the accent.
  bolt: box("bolt", {
    dropDetails: [0, 1, 5, 6, 7],
    parts: [["b", 1, 6, 3, 3, accent("bolt"), { r: 1 }], ["b", 14, 6, 3, 3, accent("bolt"), { r: 1 }]],
    details: [[5, 3, 8, 1, accent("bolt")], [5, 13, 8, 7, C.screen], [8, 14, 3, 1, accent("bolt")], [10, 15, 1, 1, accent("bolt")], [9, 16, 1, 1, accent("bolt")], [9, 18, 1, 1, accent("bolt")]],
  }),
  // Cog · a gear badge, a toothed crown, head in the accent.
  cog: box("cog", {
    tint: { "#b3bdcc": accent("cog"), "#6f7c94": "#6f7c94" },
    dropDetails: [0, 1, 6, 7],
    details: [
      [5, 2, 2, 1, C.steel], [8, 2, 2, 1, C.steel], [11, 2, 2, 1, C.steel],
      [8, 14, 1, 1, accent("cog")], [10, 14, 1, 1, accent("cog")], [7, 15, 5, 1, accent("cog")], [7, 16, 2, 1, accent("cog")], [10, 16, 2, 1, accent("cog")], [7, 17, 5, 1, accent("cog")], [8, 18, 1, 1, accent("cog")], [10, 18, 1, 1, accent("cog")],
    ],
  }),
};

/** Every crew character's sprite: the base designs and the variants. */
export const ROBOTS: Record<CrewCharacterId, RobotDef> = { ...BASE, ...VARIANTS };

// ---------------------------------------------------------------- Agent colour (Feature 01)

/**
 * The one accent part of each base design that takes an agent's colour: the base parts and details
 * it is made of (by index), every one of them `colour` in the approved design. Nothing else in a
 * design is ever recoloured. The variants are not listed: each keeps the accent it was designed
 * with (CREW_VARIANTS).
 */
export const ACCENT_PARTS: Record<CharacterId, { name: string; colour: string; parts?: number[]; details?: number[] }> = {
  basil: { name: "toque band", colour: C.steel, details: [3] },
  pepper: { name: "headband and its knot", colour: C.red, details: [0, 1, 2] },
  roux: { name: "pot band", colour: "#2f5a9e", details: [6] },
  ember: { name: "oven mitt", colour: C.orange, parts: [2] },
  sprig: { name: "dome collar", colour: C.steel, details: [4] },
  crumb: { name: "apron", colour: "#f7c6d4", details: [5] },
  mochi: { name: "cap and its brim", colour: C.yellow, parts: [5], details: [0] },
  dash: { name: "running lights", colour: C.teal, details: [5, 6] },
  pinch: { name: "belly band", colour: "#b8452f", details: [7] },
  unit: { name: "chest panel", colour: "#6f7c94", details: [5] },
};

/**
 * A colour that may be drawn as an accent, lower-cased, or null: it must be `#rrggbb` and never a
 * needs-you pink (RESERVED_ACCENTS, which holds the scene's ALERT). Null means "the design's own".
 */
export function usableAccent(colour: string | null | undefined): string | null {
  const c = colour?.trim().toLowerCase() ?? "";
  return /^#[0-9a-f]{6}$/.test(c) && !RESERVED_ACCENTS.includes(c) ? c : null;
}

const recoloured = new Map<string, RobotDef>();

/** The def to draw: the design, or (base characters only) the design with its accent part in `accent`. */
function defFor(id: CrewCharacterId, accent: string | null | undefined): RobotDef {
  const design = ROBOTS[id];
  const colour = Object.hasOwn(ACCENT_PARTS, id) ? usableAccent(accent) : null;
  if (!colour) return design;
  const slot = ACCENT_PARTS[id as CharacterId];
  if (colour === slot.colour) return design;
  const key = `${id} ${colour}`;
  let def = recoloured.get(key);
  if (!def) {
    def = {
      ...design,
      parts: design.parts.map((p, i): Part => (slot.parts?.includes(i) ? [p[0], p[1], p[2], p[3], p[4], colour, p[6]] : p)),
      details: design.details.map((d, i): Detail => (slot.details?.includes(i) ? [d[0], d[1], d[2], d[3], colour] : d)),
    };
    recoloured.set(key, def);
  }
  return def;
}

function part(B: Backend, p: Part, x: number, y: number, o: { ink?: boolean; inkOnly?: boolean; shade?: boolean; hi?: boolean }) {
  const [k, px, py, w, h, c, po = {}] = p;
  if (k === "b") B.box(x + px, y + py, w, h, c, { r: po.r ?? 0, ...o });
  else B.ell(x + px, y + py, w, h, c, o);
}

/** Cel-only personality: inked tool lines and motion marks. */
function celFlair(B: Backend, id: CrewCharacterId, x: number, y: number) {
  if (id === "roux") {
    B.path(`M${x + 18.5} ${y + 12} q-2.6 -3 0 -6.6 q2.6 3.6 0 6.6z`, "none", { stroke: INK, width: 0.6 });
    B.path(`M${x + 18.5} ${y + 12} q-1 -3 0 -6.6 q1 3.6 0 6.6z`, "none", { stroke: INK, width: 0.5 });
  }
  if (id === "dash") B.path(`M${x + 1} ${y + 18} q2 1 4 0 M${x + 17} ${y + 18} q2 1 4 0`, "none", { stroke: "#6fe3ff", width: 0.6 });
  if (id === "ember") B.path(`M${x + 15.5} ${y + 1} q-2 -2 0 -4 q2 -2 0 -4`, "none", { stroke: "#c9d3e0", width: 0.7 });
  if (id === "pepper") B.path(`M${x + 17} ${y + 7} h5 v7 h-5z`, "none", { stroke: INK, width: 0.6 });
  if (id === "pinch") B.path(`M${x + 0.5} ${y + 3} l2 2 M${x + 25.5} ${y + 3} l-2 2`, "none", { stroke: INK, width: 0.6 });
  // Variants: hover marks in the drone's own accent, and a mark over whichever claw a crab kept.
  if (id === "dot" || id === "blip" || id === "zest") B.path(`M${x + 1} ${y + 18} q2 1 4 0 M${x + 17} ${y + 18} q2 1 4 0`, "none", { stroke: accent(id), width: 0.6 });
  if (id === "nib" || id === "brine") B.path(`M${x + 0.5} ${y + 3} l2 2`, "none", { stroke: INK, width: 0.6 });
  if (id === "tang") B.path(`M${x + 25.5} ${y + 3} l-2 2`, "none", { stroke: INK, width: 0.6 });
}

export interface RobotOpts {
  /** Draw a soft floor shadow (cel). */
  shadow?: boolean;
  /**
   * The agent's colour for the design's one accent part (ACCENT_PARTS). Left out, unusable or
   * reserved (usableAccent), the robot is drawn exactly as designed; a variant always is.
   */
  accent?: string | null;
}

/** Draws a robot with its top-left at (x, y). */
export function drawRobot(B: Backend, id: CrewCharacterId, x: number, y: number, o: RobotOpts = {}) {
  const R0 = defFor(id, o.accent);
  const cel = B.kind === "cel";
  const draw = () => {
    if (!cel) R0.parts.forEach((p) => part(B, p, x, y, { ink: true, inkOnly: true }));
    R0.parts.forEach((p) => part(B, p, x, y, { ink: cel, shade: !p[6]?.noShade, hi: true }));
    R0.details.forEach(([dx, dy, w, h, c]) => B.rect(x + dx, y + dy, w, h, c));
    const eyes: Eye[] = R0.eyes ?? (R0.eye ? [[R0.eye[0], R0.eye[1], 3, 1.8, C.teal]] : []);
    for (const [ex, ey, r, pupil, colour] of eyes) {
      B.ell(x + ex, y + ey, r, r, INK, { ink: cel });
      B.ell(x + ex, y + ey, pupil, pupil, colour);
      // The glint would cover a small pixel-art pupil whole, so only cel draws it there.
      if (cel || r >= 3) B.rect(x + ex - 1, y + ey - 1, 1, 1, "#ffffff");
    }
    if (cel) celFlair(B, id, x, y);
  };
  if (cel && o.shadow !== false) B.ell(x + R0.w / 2, y + R0.h + 0.5, R0.w * 0.42, 1.6, "#0b1022");
  draw();
}

export const robotSize = (id: CrewCharacterId) => ({ w: ROBOTS[id].w, h: ROBOTS[id].h });

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
