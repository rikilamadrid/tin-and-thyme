// Generates Tin & Thyme's brand SVGs from the app's own pixel renderer.
//
//   pnpm brand        (tsx scripts/brand/render-brand.ts)
//
// The robots are not redrawn: the real sprites (src/galley/robots.ts) are painted by the
// real pixel backend (src/galley/backend.ts) into a recording canvas, and every filled
// pixel becomes an SVG <rect>. Lettering is pixel lettering, drawn as rects too, so the
// banner reads the same everywhere and depends on no installed font.
//
// Writes brand/logo/mark.svg, brand/logo/mark-day.svg, brand/readme/header-night.svg and
// brand/readme/header-day.svg. Palette and rules: brand/IDENTITY.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pixelBackend } from "../../src/galley/backend";
import { drawRobot } from "../../src/galley/robots";
import type { CharacterId } from "../../src/data/crew";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The palette (brand/IDENTITY.md). Pink is reserved for attention states and never used here. */
export const P = {
  navy: "#0c1226", navyDeep: "#070b18", navyGlass: "#13204a", ink: "#141a2e",
  copper: "#e0773a", copperLight: "#ffa25a", copperDark: "#a8532a",
  cyan: "#38d9c9", cyanLight: "#9fe7ff", cyanDark: "#1c8f86",
  steel: "#55607e", steelLight: "#8f9cb2",
  paper: "#f4efe6", paperRule: "#d9cfbf", navyText: "#1d2748", mutedNight: "#a8b8d8", mutedDay: "#4b5a7a",
};

// ---------------------------------------------------------------- pixel grid

/** A grid of logical pixels, painted in order (later wins). */
class Grid {
  px = new Map<string, string>();
  set(x: number, y: number, c: string) {
    this.px.set(`${x},${y}`, c);
  }
  rect(x: number, y: number, w: number, h: number, c: string) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Paints another grid at an offset, optionally only where `keep(x, y)` holds. */
  stamp(g: Grid, ox: number, oy: number, keep: (x: number, y: number) => boolean = () => true) {
    for (const [k, c] of g.px) {
      const [x, y] = k.split(",").map(Number);
      if (keep(x + ox, y + oy)) this.set(x + ox, y + oy, c);
    }
  }
  /** Horizontal runs of one colour, as SVG rects. */
  svg(): string {
    const rows = new Map<number, [number, string][]>();
    for (const [k, c] of this.px) {
      const [x, y] = k.split(",").map(Number);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push([x, c]);
    }
    const out: string[] = [];
    for (const [y, cells] of [...rows].sort((a, b) => a[0] - b[0])) {
      cells.sort((a, b) => a[0] - b[0]);
      let i = 0;
      while (i < cells.length) {
        const [x0, c] = cells[i];
        let x = x0;
        while (i + 1 < cells.length && cells[i + 1][0] === x + 1 && cells[i + 1][1] === c) {
          i++;
          x++;
        }
        out.push(`<rect x="${x0}" y="${y}" width="${x - x0 + 1}" height="1" fill="${c}"/>`);
        i++;
      }
    }
    return out.join("");
  }
}

/** A canvas that records what the pixel backend fills, at one device pixel per logical pixel. */
function recorder(g: Grid) {
  let fill = "#000";
  let alpha = 1;
  const ctx = {
    setTransform() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillText() {},
    set imageSmoothingEnabled(_v: boolean) {},
    set fillStyle(v: string) {
      fill = v;
    },
    set globalAlpha(v: number) {
      alpha = v;
    },
    font: "",
    textBaseline: "",
    textAlign: "",
    fillRect(x: number, y: number, w: number, h: number) {
      if (alpha < 0.5) return; // the crisp brand keeps only solid pixels
      g.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), fill);
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** A real robot sprite, exactly as the kitchen paints it in Detailed pixel art. */
function robot(id: CharacterId): Grid {
  const g = new Grid();
  drawRobot(pixelBackend(recorder(g), 1, -2, -4), id, 0, 0, { shadow: false });
  return g;
}

// ---------------------------------------------------------------- pixel lettering

/** 5×7 capitals for small lettering. */
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  ";": ["...", ".#.", "...", "...", ".#.", ".#.", "#.."],
  ".": [".", ".", ".", ".", ".", ".", "#"],
  "·": [".", ".", ".", "#", ".", ".", "."],
  " ": ["...", "...", "...", "...", "...", "...", "..."],
};

/** Small lettering: one grid pixel per font pixel, one column between letters. */
function text(s: string, color: string): { g: Grid; w: number } {
  const g = new Grid();
  let x = 0;
  for (const ch of s.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
    glyph.forEach((row, y) => [...row].forEach((c, i) => c === "#" && g.set(x + i, y, color)));
    x += glyph[0].length + 1;
  }
  return { g, w: x - 1 };
}

/**
 * The wordmark: the same capitals doubled (two-pixel stems), with an ink outline, a lit top
 * edge and a shaded foot. Crafted pixel lettering, not a typeface.
 */
function wordmark(s: string): { g: Grid; w: number; h: number } {
  const body = new Grid();
  let x = 1;
  for (const ch of s.toUpperCase()) {
    const glyph = FONT[ch];
    const color = ch === "&" ? P.cyan : P.copper;
    glyph.forEach((row, y) =>
      [...row].forEach((c, i) => {
        if (c !== "#") return;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) body.set(x + i * 2 + dx, 1 + y * 2 + dy, color);
      }),
    );
    x += glyph[0].length * 2 + (ch === " " ? 0 : 3);
  }
  const w = x - 2;
  const h = 7 * 2 + 2;
  const g = new Grid();
  // ink outline (and a one-pixel drop to the lower right)
  for (const k of body.px.keys()) {
    const [px, py] = k.split(",").map(Number);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [2, 2], [1, 2], [2, 1]]) g.set(px + dx, py + dy, P.ink);
  }
  for (const [k, c] of body.px) {
    const [px, py] = k.split(",").map(Number);
    const above = body.px.has(`${px},${py - 1}`);
    const below = body.px.has(`${px},${py + 1}`);
    const lit = c === P.copper ? P.copperLight : P.cyanLight;
    const shade = c === P.copper ? P.copperDark : P.cyanDark;
    g.set(px, py, !above ? lit : !below ? shade : c);
  }
  return { g, w: w + 3, h: h + 2 };
}

// ---------------------------------------------------------------- the mark

/**
 * The mark: a galley porthole. A copper ring with four rivets, a star-flecked window, and
 * Basil (the Head Chef, the real sprite) looking out of it; a thyme sprig grows along the rim.
 */
function mark(night: boolean): Grid {
  const S = 48;
  const cx = 24;
  const cy = 24;
  const inR = 16.5;
  const ringR = 21.5;
  const g = new Grid();
  const d = (x: number, y: number) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const r = d(x, y);
      if (r < ringR + 1.2 && r >= ringR) g.set(x, y, P.ink);
      else if (r < ringR && r >= inR + 1) {
        // copper ring, lit from the top left
        const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
        const light = Math.cos(ang + Math.PI * 0.75);
        g.set(x, y, light > 0.55 ? P.copperLight : light < -0.45 ? P.copperDark : P.copper);
      } else if (r < inR + 1 && r >= inR) g.set(x, y, P.ink);
      else if (r < inR) g.set(x, y, night ? P.navyGlass : P.navy);
    }
  // stars in the window
  for (const [x, y, c] of [[15, 14, P.cyanLight], [31, 12, "#ffffff"], [34, 19, P.cyanLight], [13, 22, "#ffffff"], [36, 27, "#ffffff"]] as [number, number, string][]) g.set(x, y, c);
  // Basil, from the hat to the chest, inside the window only
  const basil = robot("basil");
  g.stamp(basil, 14, 9, (x, y) => d(x, y) < inR);
  // a glass glint over the window
  for (const [x, y] of [[17, 11], [16, 12], [15, 13]]) g.set(x, y, "#cfe9ff");
  // rivets at the four quarters
  for (const [x, y] of [[23, 4], [23, 42], [4, 23], [42, 23]]) {
    g.rect(x, y, 2, 2, P.steelLight);
    g.set(x + 1, y + 1, P.steel);
  }
  // a thyme sprig along the lower right of the rim
  const stem: [number, number][] = [[33, 44], [34, 43], [35, 42], [36, 41], [37, 40], [38, 39], [39, 38], [40, 36], [41, 35], [42, 33], [42, 32]];
  for (const [x, y] of stem) g.set(x, y, P.cyanDark);
  const leaves: [number, number][] = [[33, 42], [35, 44], [36, 39], [38, 41], [39, 36], [41, 38], [40, 33], [43, 35], [41, 30]];
  for (const [x, y] of leaves) {
    g.set(x, y, P.ink);
    g.set(x + 1, y, P.cyan);
    g.set(x, y + 1, P.cyan);
    g.set(x + 1, y + 1, P.cyanLight);
  }
  return g;
}

// ---------------------------------------------------------------- banner

function stars(g: Grid, w: number, h: number, color: string, density: number, avoid: (x: number, y: number) => boolean) {
  let seed = 47;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 10000) / 10000;
  for (let i = 0; i < density; i++) {
    const x = Math.floor(rnd() * w);
    const y = Math.floor(rnd() * h);
    if (!avoid(x, y)) g.set(x, y, rnd() > 0.85 ? P.cyanLight : color);
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svgDoc(o: { w: number; h: number; scale: number; title: string; desc: string; bg: string | null; body: string; comment: string }) {
  return `<!--
  ${o.comment}

  GENERATED, do not edit. Source: scripts/brand/render-brand.ts (the robots are the app's
  real sprites, painted by its real pixel renderer). Regenerate with: pnpm brand
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.w * o.scale} ${o.h * o.scale}" width="${o.w * o.scale}" height="${o.h * o.scale}" role="img" aria-labelledby="t d" shape-rendering="crispEdges">
<title id="t">${xml(o.title)}</title>
<desc id="d">${xml(o.desc)}</desc>
${o.bg ? `<rect width="${o.w * o.scale}" height="${o.h * o.scale}" fill="${o.bg}"/>` : ""}
<g transform="scale(${o.scale})">${o.body}</g>
</svg>
`;
}

function banner(night: boolean) {
  // Logical canvas 300 × 60 at 4× = 1200 × 240, Lorekeeper's header size.
  const W = 300;
  const H = 60;
  const k = 4;
  const g = new Grid();
  const ink = night ? P.cyanLight : P.navyText;
  const muted = night ? P.mutedNight : P.mutedDay;
  // the mark
  const m = mark(night);
  g.stamp(m, 10, 5);
  // the wordmark
  const wm = wordmark("TIN & THYME");
  g.stamp(wm.g, 66, 6);
  // the crew on a galley counter, beside the wordmark
  const counterY = 26;
  g.rect(214, counterY, 80, 3, P.steelLight);
  g.rect(214, counterY, 80, 1, night ? "#c9d3e0" : "#ffffff");
  g.rect(214, counterY + 3, 80, 1, P.copper);
  g.rect(214, counterY + 4, 80, 1, P.ink);
  const crew: [CharacterId, number][] = [["pepper", 218], ["pinch", 243], ["dash", 270]];
  for (const [id, x] of crew) {
    const r = robot(id);
    const h = Math.max(...[...r.px.keys()].map((kk) => Number(kk.split(",")[1]))) + 1;
    g.stamp(r, x, counterY - h);
  }
  // the line, under both
  const l1 = text("PATHFINDER RUNS THE ROUND;", ink);
  const l2 = text("TIN & THYME LETS YOU WATCH THE KITCHEN.", ink);
  g.stamp(l1.g, 67, 33);
  g.stamp(l2.g, 67, 42);
  // the attribution plate, bottom right
  const plate = text("A WONDER WAGON TOOL · BY LAMADRID LABS", muted);
  g.stamp(plate.g, W - 8 - plate.w, 52);
  // stars only on the night ground, clear of everything drawn
  const bg = new Grid();
  if (night) stars(bg, W, H, "#5a6a96", 90, (x, y) => [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => g.px.has(`${x + dx},${y + dy}`))) || (x >= 62 && y >= 30) || (x >= 62 && x < 212 && y < 27));
  bg.stamp(g, 0, 0);
  const desc =
    "The Tin & Thyme banner: a copper galley porthole with Basil, the Head Chef robot, looking out of it and a thyme sprig along the rim; the pixel wordmark TIN & THYME; the line Pathfinder runs the round; Tin & Thyme lets you watch the kitchen; three robots of the crew on a galley counter; and the plate A Wonder Wagon tool · by Lamadrid Labs.";
  return svgDoc({
    w: W, h: H, scale: k, title: "Tin & Thyme", desc, bg: night ? P.navy : P.paper, body: bg.svg(),
    comment: `README header, ${night ? "night" : "day"}: the mark and wordmark, the line, the crew, and the Wonder Wagon plate.`,
  });
}

function out(rel: string, content: string) {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`wrote ${rel} (${content.length} bytes)`);
}

out("brand/readme/header-night.svg", banner(true));
out("brand/readme/header-day.svg", banner(false));
for (const night of [true, false]) {
  out(
    `brand/logo/mark${night ? "" : "-day"}.svg`,
    svgDoc({
      w: 48, h: 48, scale: 4, title: "Tin & Thyme", bg: null, body: mark(night).svg(),
      desc: "The Tin & Thyme mark: a copper galley porthole with Basil, the Head Chef robot, looking out of it, and a thyme sprig along the rim.",
      comment: `The mark, ${night ? "for dark grounds" : "for light grounds"}: 48 × 48 pixels at 4×.`,
    }),
  );
}
