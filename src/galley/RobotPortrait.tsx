import { useEffect, useRef } from "react";
import type { CrewCharacterId } from "../data/crewContract";
import { usePrefs } from "../store/prefs";
import { makeBackend, type ArtStyle } from "./backend";
import { drawRobot, robotSize } from "./robots";

const BOX = 28; // logical units shown

/**
 * Paints one portrait onto `c`, sized for `px` device pixels a side (pixel art rounds down to whole
 * pixels). Shared by the component below and the variant contact sheet (scripts/crew-contact-sheet.mjs).
 */
export function paintPortrait(c: HTMLCanvasElement, style: ArtStyle, character: CrewCharacterId, px: number, dim = false, accent: string | null = null) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const fit = px / BOX;
  const s = style === "pixel" ? Math.max(1, Math.floor(fit)) : fit;
  c.width = Math.round(BOX * s);
  c.height = Math.round(BOX * s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  const B = makeBackend(style, ctx, s);
  B.rect(0, 0, BOX, BOX, "#26314f");
  const { w, h } = robotSize(character);
  // Tall robots (Basil) are framed head-and-shoulders, like the concept roster.
  const y = h > BOX - 2 ? 3 : Math.round((BOX - h) / 2) + 1;
  B.alpha(dim ? 0.5 : 1, () => drawRobot(B, character, Math.round((BOX - w) / 2), y, { shadow: false, accent }));
}

/**
 * One crew robot (a base character or a variant), drawn by the same backend as the room, in the current art style.
 * `accent` is the agent's colour for the design's accent part (CrewMember.color); without it the design is drawn as is.
 */
export function RobotPortrait({ character, size = 48, dim = false, accent = null }: { character: CrewCharacterId; size?: number; dim?: boolean; accent?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const style = usePrefs((s) => s.artStyle);
  useEffect(() => {
    if (ref.current) paintPortrait(ref.current, style, character, size * (window.devicePixelRatio || 1), dim, accent);
  }, [character, size, style, dim, accent]);
  return (
    <canvas
      ref={ref}
      className="shrink-0 rounded-[4px]"
      style={{ width: size, height: size, imageRendering: style === "pixel" ? "pixelated" : "auto" }}
      aria-hidden
    />
  );
}
