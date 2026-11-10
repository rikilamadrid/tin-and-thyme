import { create } from "zustand";
import type { ArtStyle } from "../galley/backend";

// Per-browser appearance preferences. Saved locally; nothing goes to the server.

const KEY = "thepass.artStyle";

function saved(): ArtStyle {
  try {
    const v = localStorage.getItem(KEY);
    return v === "cel" ? "cel" : "pixel";
  } catch {
    return "pixel";
  }
}

const SOUND_KEY = "thepass.sound";

/** Sound effects are off unless this browser turned them on. */
function savedSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

interface Prefs {
  artStyle: ArtStyle;
  sound: boolean;
}

export const usePrefs = create<Prefs>(() => ({ artStyle: saved(), sound: savedSound() }));

/** Panels and controls read the art style from <html data-art> (corners and shadows). */
const markArt = (style: ArtStyle) => {
  if (typeof document !== "undefined") document.documentElement.dataset.art = style;
};
markArt(usePrefs.getState().artStyle);
usePrefs.subscribe((s) => markArt(s.artStyle));

export const prefs = {
  setArtStyle(artStyle: ArtStyle) {
    usePrefs.setState({ artStyle });
    try {
      localStorage.setItem(KEY, artStyle);
    } catch {
      /* private window: applies until reload */
    }
  },
  /** Call unlockAudio() in the same user action when turning sound on (the browser requires it). */
  setSound(sound: boolean) {
    usePrefs.setState({ sound });
    try {
      localStorage.setItem(SOUND_KEY, sound ? "on" : "off");
    } catch {
      /* private window: applies until reload */
    }
  },
};

export const ART_STYLES: { id: ArtStyle; label: string; hint: string }[] = [
  { id: "pixel", label: "Detailed pixel art", hint: "Whole-pixel shapes, ink outlines, dithered light" },
  { id: "cel", label: "Cel-shaded", hint: "Inked vector shapes with one flat shadow each" },
];
