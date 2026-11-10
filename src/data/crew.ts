// The Pass · crew catalog: the robot characters and how a workflow role maps to one.
//
// A character is a visual alias only. The name and the kitchen job dress the
// session up; the drawer and the roster always show the real workflow role and
// the real ticket ID next to it. Shared by the server (which assigns a
// character once per session, so it never changes) and the UI (which draws it).

export type CharacterId = "basil" | "pepper" | "roux" | "ember" | "sprig" | "crumb" | "mochi" | "dash" | "pinch" | "unit";

export interface Character {
  id: CharacterId;
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
