import type { AgentState, ReviewState } from "../data/types";

// PICO-8-flavoured "cozy management game" palette. Shared by the office and the HUD.
export const colors = {
  ink: "#241a2e",
  cream: "#fff6e9",
  cream2: "#f0dfc2",
  cream3: "#e2cba6",
  muted: "#7d6b73",
  navy: "#1d2b53",
  navy2: "#16213f",
  blue: "#29adff",
  red: "#ff004d",
  orange: "#ffa300",
  green: "#00e436",
  lav: "#83769c",
  yellow: "#ffec27",
  pink: "#ff77a8",
  grass: "#4a8f3d",
  white: "#fff1e8",
} as const;

export interface StateStyle {
  label: string;
  color: string;
  dim: string;
}

export const stateStyle: Record<AgentState, StateStyle> = {
  working: { label: "Working", color: colors.blue, dim: "#1d6fb8" },
  "needs-input": { label: "Needs input", color: colors.red, dim: "#7e0f33" },
  waiting: { label: "Waiting on workers", color: colors.lav, dim: "#5a5170" },
  "in-review": { label: "In review", color: colors.orange, dim: "#a86a00" },
  "review-passed": { label: "Review passed", color: colors.green, dim: "#00873a" },
  idle: { label: "Idle", color: colors.lav, dim: "#5a5170" },
};

export const reviewStyle: Record<ReviewState, StateStyle> = {
  pending: { label: "Queued", color: colors.lav, dim: "#5a5170" },
  reviewing: { label: "Reviewing", color: colors.orange, dim: "#a86a00" },
  "changes-requested": { label: "Changes", color: colors.red, dim: "#7e0f33" },
  passed: { label: "Passed", color: colors.green, dim: "#00873a" },
};

/** Robot body colours offered for new agents, in order. */
export const agentPalette = [
  "#ff77a8", // pink
  "#29adff", // blue
  "#ffd23a", // yellow
  "#00e436", // green
  "#ff8a3d", // orange
  "#a98bff", // violet
  "#3ee0d0", // teal
  "#ff5c5c", // coral
  "#c2c3c7", // silver
  "#b0e04a", // lime
  "#f0a6ff", // lilac
  "#6fa8ff", // periwinkle
] as const;

export const font = {
  ui: '"Pixelify Sans", "Trebuchet MS", system-ui, sans-serif',
  term: '"VT323", ui-monospace, Menlo, Consolas, monospace',
};

/** Lighter / darker variants of an agent colour for sprite shading. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
