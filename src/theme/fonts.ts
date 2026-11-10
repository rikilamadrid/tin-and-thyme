// UI font styles for panels, drawers, settings and agent terminals. The office
// canvas keeps its pixel font. Saved per browser, not in .jsmhq/config.json,
// because it's a personal choice, not a team setting.

export type FontStyle = "galley" | "pixel" | "clean" | "mono";

export const FONT_STYLES: { id: FontStyle; label: string; hint: string }[] = [
  { id: "galley", label: "Galley", hint: "The roster's system font, easiest to read" },
  { id: "pixel", label: "Pixel", hint: "Pixelify Sans, the old JSM HQ look" },
  { id: "clean", label: "Clean", hint: "Inter, easiest to read" },
  { id: "mono", label: "Mono", hint: "JetBrains Mono, like a terminal" },
];

const KEY = "jsmhq.font";
export const FONT_EVENT = "jsmhq:font";

/** Terminals need a monospace font: Pixel keeps VT323, the others use JetBrains Mono. */
export function terminalFont(font: FontStyle) {
  return font === "pixel"
    ? { family: '"VT323", ui-monospace, Menlo, monospace', size: 19, lineHeight: 1.05, load: '19px "VT323"' }
    : { family: '"JetBrains Mono", ui-monospace, Menlo, monospace', size: 13, lineHeight: 1.2, load: '13px "JetBrains Mono"' };
}

export function savedFont(): FontStyle {
  try {
    const v = localStorage.getItem(KEY);
    return FONT_STYLES.some((f) => f.id === v) ? (v as FontStyle) : "galley";
  } catch {
    return "galley";
  }
}

export function applyFont(font: FontStyle) {
  if (font === "galley") delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = font;
}

export function setFont(font: FontStyle) {
  applyFont(font);
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }));
  try {
    localStorage.setItem(KEY, font);
  } catch {
    /* private window: still applies until reload */
  }
}
