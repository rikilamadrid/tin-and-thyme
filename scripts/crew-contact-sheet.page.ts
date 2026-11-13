// The drawing half of scripts/crew-contact-sheet.mjs: runs in a headless browser, paints every
// crew character with the app's own backends, sprites and portrait painter, and leaves the PNG
// as a data URL on <body data-png>. Nothing is redrawn here.

import { CREW_CHARACTERS, CREW_VARIANTS } from "../src/data/crew";
import { FAMILY_POOLS, ROLE_FAMILIES, type CrewCharacterId } from "../src/data/crewContract";
import { makeBackend, UIF, type ArtStyle } from "../src/galley/backend";
import { paintPortrait } from "../src/galley/RobotPortrait";
import { drawRobot, robotSize } from "../src/galley/robots";

const STYLES: [ArtStyle, string][] = [["pixel", "Detailed pixel art"], ["cel", "Cel-shaded"]];
/** The room's robot scale (BOT_K in src/galley/scene.ts). */
const BOT_K = 1.2;
/** Device pixels per logical unit the kitchen gets in a small and a large window. */
const ROOM_SCALES = [2, 3];
const FLOOR = "#2b3554";
const BG = "#10162a";
const FG = "#e8eef6";
const SUB = "#a8b8d8";

const ids = ROLE_FAMILIES.flatMap((f) => FAMILY_POOLS[f]);
const isVariant = (id: CrewCharacterId) => Object.hasOwn(CREW_VARIANTS, id);

const LABEL_W = 96;
const SLOT = 40; // logical units per robot in a line-up
const LINE_H = 47; // logical units per line-up row
const maxPool = Math.max(...ROLE_FAMILIES.map((f) => FAMILY_POOLS[f].length));
const lineupW = (s: number) => maxPool * SLOT * s + 16;
const bandH = (s: number) => 22 + ROLE_FAMILIES.length * LINE_H * s + 12;
const CARD_W = 236;
const CARD_H = 262;
const COLS = 6;

const W = Math.max(LABEL_W + STYLES.length * lineupW(Math.max(...ROOM_SCALES)) + 16, COLS * CARD_W + 24);
const H = 88 + ROOM_SCALES.reduce((a, s) => a + bandH(s), 0) + 30 + Math.ceil(ids.length / COLS) * CARD_H + 16;

const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d")!;

function text(t: string, x: number, y: number, size: number, colour = FG, weight = 600, align: CanvasTextAlign = "left") {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.font = `${weight} ${size}px ${UIF}`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillText(t, x, y);
}

/** A robot with its feet centred on device (fx, fy), exactly as scene.ts `bot` draws it at room scale `s`. */
function roomBot(style: ArtStyle, s: number, id: CrewCharacterId, fx: number, fy: number, k = BOT_K) {
  const B = makeBackend(style, ctx, s, -fx / s, -fy / s);
  const kk = B.spriteK(k);
  const { w, h } = robotSize(id);
  if (style === "pixel") B.ell(0, 0, w * kk * 0.42, 1.6, "#0b1022");
  B.sprite(-(w * kk) / 2, -h * kk, kk, (Z) => drawRobot(Z, id, 0, 0));
}

ctx.fillStyle = BG;
ctx.fillRect(0, 0, W, H);
text("Tin & Thyme · crew contact sheet (ticket 09.2)", 16, 14, 20, FG, 800);
text(`${ids.length} characters: 10 base designs and ${Object.keys(CREW_VARIANTS).length} variants (marked ◆), from FAMILY_POOLS in src/data/crewContract.ts`, 16, 38, 12, SUB, 500);

// ---------------------------------------------------------------- 1 · line-ups at kitchen scale
let top = 64;
text("Kitchen scale · each role family side by side (the room's robot scale, in a small and a large window)", 16, top, 13, FG, 700);
top += 24;
for (const s of ROOM_SCALES) {
  const rowH = LINE_H * s;
  STYLES.forEach(([style, label], n) => {
    const x = LABEL_W + n * lineupW(s);
    text(`${label} · ${s}× window (${style === "pixel" ? Math.round(s * BOT_K) : (s * BOT_K).toFixed(1)} px per sprite pixel)`, x + 8, top, 11, SUB, 600);
    ROLE_FAMILIES.forEach((f, r) => {
      const y0 = top + 18 + r * rowH;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = FLOOR;
      ctx.fillRect(x, y0, lineupW(s) - 8, rowH - 4);
      FAMILY_POOLS[f].forEach((id, i) => roomBot(style, s, id, x + 8 + (i + 0.5) * SLOT * s, y0 + rowH - 4 * s));
    });
  });
  ROLE_FAMILIES.forEach((f, r) => text(f, 16, top + 18 + r * rowH + rowH / 2 - 8, 12, FG, 700));
  top += bandH(s);
}

// ---------------------------------------------------------------- 2 · every character, both styles, with portraits
text("Every character · sprite at 4× and the roster portrait (RobotPortrait), in both styles", 16, top, 13, FG, 700);
top += 26;
const family = (id: CrewCharacterId) => ROLE_FAMILIES.find((f) => FAMILY_POOLS[f].includes(id))!;
ids.forEach((id, n) => {
  const cx = 16 + (n % COLS) * CARD_W;
  const cy = top + Math.floor(n / COLS) * CARD_H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(cx, cy, CARD_W - 8, CARD_H - 8);
  const c = CREW_CHARACTERS[id];
  text(`${isVariant(id) ? "◆ " : ""}${c.name}`, cx + 8, cy + 6, 13, FG, 800);
  text(`${id} · ${family(id)}`, cx + CARD_W - 16, cy + 8, 10, SUB, 600, "right");
  text(isVariant(id) ? CREW_VARIANTS[id as keyof typeof CREW_VARIANTS].accessory : c.look, cx + 8, cy + 24, 10, SUB, 500);
  STYLES.forEach(([style], i) => {
    const x = cx + 8 + i * 112;
    roomBot(style, 4, id, x + 54, cy + 190, 1);
    const p = document.createElement("canvas");
    paintPortrait(p, style, id, 48);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = style !== "pixel";
    ctx.drawImage(p, x + 6, cy + 200, 48, 48);
    text(style, x + 60, cy + 236, 9, SUB, 600);
  });
  if (isVariant(id)) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CREW_VARIANTS[id as keyof typeof CREW_VARIANTS].accent;
    ctx.fillRect(cx, cy, 3, CARD_H - 8);
  }
});

document.body.dataset.png = canvas.toDataURL("image/png");
