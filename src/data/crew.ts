// The Pass · crew catalog: the robot characters and how a workflow role maps to one.
//
// A character is a visual alias only. The name and the kitchen job dress the
// session up; the drawer and the roster always show the real workflow role and
// the real ticket ID next to it. Shared by the server (which assigns a
// character once per session, so it never changes) and the UI (which draws it).
//
// Feature 09 adds variant characters (CREW_VARIANTS below) so parallel sessions of one role
// family never share a name. Their ids, families and the allocation rules live in
// ./crewContract.ts (docs/crew-contract.md); this file holds only their names and jobs.

import type { VariantCharacterId } from "./crewContract";

/** The base characters, each with its own sprite in src/galley/robots.ts. */
export type CharacterId = "basil" | "pepper" | "roux" | "ember" | "sprig" | "crumb" | "mochi" | "dash" | "pinch" | "unit";

export interface Character<I extends string = CharacterId> {
  id: I;
  name: string;
  job: string;
  /** One-line silhouette description, for tooltips and the settings preview. */
  look: string;
}

export const CHARACTERS: Record<CharacterId, Character> = {
  basil: { id: "basil", name: "Basil", job: "Head Chef", look: "tall command bot · flip-up visor · order tablet" },
  pepper: { id: "pepper", name: "Pepper", job: "Sous Chef", look: "tread bot · cleaver arm" },
  roux: { id: "roux", name: "Roux", job: "Saucier", look: "squat pot-bot · whisk arm" },
  ember: { id: "ember", name: "Ember", job: "Grill Cook", look: "unicycle bot · heat-shield face" },
  sprig: { id: "sprig", name: "Sprig", job: "Garde Manger", look: "four-leg walker · terrarium dome" },
  crumb: { id: "crumb", name: "Crumb", job: "Pastry Chef", look: "mixer-head bot · rolling-pin arm" },
  mochi: { id: "mochi", name: "Mochi", job: "Line Cook", look: "caster-ball bot · backwards cap" },
  dash: { id: "dash", name: "Dash", job: "Expediter", look: "hover drone · one scanner eye" },
  pinch: { id: "pinch", name: "Pinch", job: "Taster", look: "low crab bot · two pincers · tasting spoon" },
  unit: { id: "unit", name: "Crew bot", job: "Crew", look: "neutral box bot" },
};

/**
 * Variant characters (Feature 09). Data only: 09.2 draws each from its `base` sprite with the
 * named accessory and palette accent, so a variant reads as the same kind of bot, never a copy.
 * Names are unique across CHARACTERS and CREW_VARIANTS (checked by scripts/crew-contract-test.ts).
 */
export interface VariantCharacter extends Character<VariantCharacterId> {
  /** The base character whose silhouette the variant shares. */
  base: CharacterId;
  /** The distinguishing accessory, for the art and the settings preview. */
  accessory: string;
  /** Palette accent (PICO-8 colours, like the role colours). */
  accent: string;
}

export const CREW_VARIANTS: Record<VariantCharacterId, VariantCharacter> = {
  // tester family (base Dash)
  dot: { id: "dot", name: "Dot", job: "Checker", look: "hover drone · twin scanner eyes · antenna", base: "dash", accessory: "twin scanner eyes + antenna", accent: "#ff77a8" },
  blip: { id: "blip", name: "Blip", job: "Plate Inspector", look: "hover drone · magnifier lens · clipboard", base: "dash", accessory: "magnifier lens + clipboard", accent: "#ffec27" },
  zest: { id: "zest", name: "Zest", job: "Expo Runner", look: "hover drone · visor band · order spike", base: "dash", accessory: "visor band + order spike", accent: "#ffa300" },
  // adversary family (base Pinch)
  tang: { id: "tang", name: "Tang", job: "Food Critic", look: "low crab bot · monocle · notepad claw", base: "pinch", accessory: "monocle + notepad claw", accent: "#29adff" },
  nib: { id: "nib", name: "Nib", job: "Spice Taster", look: "low crab bot · pepper-mill claw · tall eyestalks", base: "pinch", accessory: "pepper-mill claw + tall eyestalks", accent: "#00e436" },
  brine: { id: "brine", name: "Brine", job: "Pickler", look: "low crab bot · jar shell · dropper", base: "pinch", accessory: "jar shell + dropper", accent: "#83769c" },
  // helper family (base Crew bot)
  whisk: { id: "whisk", name: "Whisk", job: "Runner", look: "neutral box bot · whisk antenna · wheels", base: "unit", accessory: "whisk antenna + wheels", accent: "#29adff" },
  ladle: { id: "ladle", name: "Ladle", job: "Prep Hand", look: "neutral box bot · ladle arm · apron", base: "unit", accessory: "ladle arm + apron", accent: "#00e436" },
  scoop: { id: "scoop", name: "Scoop", job: "Kitchen Porter", look: "neutral box bot · scoop hands · crate", base: "unit", accessory: "scoop hands + crate", accent: "#ffec27" },
  tongs: { id: "tongs", name: "Tongs", job: "Fetcher", look: "neutral box bot · tong arms · satchel", base: "unit", accessory: "tong arms + satchel", accent: "#ff77a8" },
  // planner and integrator (one each: neither runs in parallel)
  sage: { id: "sage", name: "Sage", job: "Menu Planner", look: "neutral box bot · menu board · pencil", base: "unit", accessory: "menu board + pencil", accent: "#83769c" },
  clove: { id: "clove", name: "Clove", job: "Plating Lead", look: "neutral box bot · cloche · tweezers", base: "unit", accessory: "cloche + tweezers", accent: "#ffec27" },
  // unknown roles
  bolt: { id: "bolt", name: "Bolt", job: "Crew", look: "neutral box bot · question-mark panel", base: "unit", accessory: "question-mark panel", accent: "#c2c3c7" },
  cog: { id: "cog", name: "Cog", job: "Crew", look: "neutral box bot · gear badge", base: "unit", accessory: "gear badge", accent: "#c2c3c7" },
};

/** Every crew character: the base ones and their variants. */
export const CREW_CHARACTERS: Record<CharacterId | VariantCharacterId, Character<CharacterId | VariantCharacterId>> = { ...CHARACTERS, ...CREW_VARIANTS };

/** Developer sessions take a cook in this order, so concurrent developers never share one. */
export const COOKS: CharacterId[] = ["pepper", "roux", "ember", "sprig", "crumb", "mochi"];

/** The kitchen-side reading of a Pathfinder role (one character, or the cook pool). */
export function characterForRole(role: string): CharacterId | "cook" {
  const r = role.trim().toLowerCase();
  if (r === "orchestrator" || r === "lead" || r === "coordinator") return "basil";
  if (r === "developer" || r === "dev" || r === "engineer") return "cook";
  if (r === "tester" || r === "qa" || r === "reviewer") return "dash";
  if (r === "adversary") return "pinch";
  return "unit";
}

/**
 * Picks a character for a new session. `taken` holds the characters already in
 * the room this run; a cook is never reused while another is free, and a second
 * copy of a single-character role gets a number ("Dash 2").
 *
 * @deprecated Feature 09 replaces this with `allocateCharacter` in ./crewContract.ts (no numbered
 * names, family pools, persistent crew). Kept until 09.3 moves the server and the galley over.
 */
export function assignCharacter(role: string, taken: CharacterId[]): { id: CharacterId; name: string; job: string } {
  const want = characterForRole(role);
  if (want === "cook") {
    const free = COOKS.find((c) => !taken.includes(c));
    if (free) return { id: free, name: CHARACTERS[free].name, job: CHARACTERS[free].job };
    const least = [...COOKS].sort((a, b) => taken.filter((t) => t === a).length - taken.filter((t) => t === b).length)[0];
    const n = taken.filter((t) => t === least).length + 1;
    return { id: least, name: `${CHARACTERS[least].name} ${n}`, job: CHARACTERS[least].job };
  }
  const c = CHARACTERS[want];
  const n = taken.filter((t) => t === want).length;
  if (want === "unit") {
    const label = role ? role[0].toUpperCase() + role.slice(1) : "Crew";
    return { id: "unit", name: n ? `${label} bot ${n + 1}` : `${label} bot`, job: label };
  }
  return { id: want, name: n ? `${c.name} ${n + 1}` : c.name, job: c.job };
}
