// Checks ticket 01.2: an agent's colour (Settings → Team) recolours exactly one accent part of its
// robot, and nothing else in any approved design moves.
//
//   npx tsx scripts/agent-colour-test.ts
//
// Robots are drawn into a recording backend, so a "drawing" here is the list of calls drawRobot
// makes (kind, geometry, colour, options), in both art styles. DESIGN_DRAWS holds a hash of each
// character's drawing as it was on main before this ticket (fd05b69): the designs did not move
// while every hash still matches.

import { createHash } from "node:crypto";
import { CHARACTERS, CREW_CHARACTERS, CREW_VARIANTS, type CharacterId } from "../src/data/crew";
import { RESERVED_ACCENTS, type CrewCharacterId } from "../src/data/crewContract";
import { busySnapshot } from "../src/data/fixture/busyFixture";
import { presets } from "../src/data/mock/presets";
import { World } from "../src/data/mock/world";
import type { ArtStyle, Backend } from "../src/galley/backend";
import { ACCENT_PARTS, drawRobot, ROBOTS, usableAccent } from "../src/galley/robots";
import { agentPalette } from "../src/theme/tokens";

// The galley model reads the store, which looks at the page address when it loads.
(globalThis as { location?: unknown }).location ??= { href: "http://localhost/?fixture=busy" };
const { agentColor, buildGalley } = await import("../src/galley/model");

const STYLES: ArtStyle[] = ["pixel", "cel"];

/** sha256 (first 16 hex) of each character's drawing on main at fd05b69: [pixel, cel]. */
const DESIGN_DRAWS: Record<CrewCharacterId, [string, string]> = {
  basil: ["0d3d69ce605bdec0", "0189ca20cc6d604e"],
  pepper: ["ff5edd5b2ae0e5c6", "6ceda289e8ae541f"],
  roux: ["9966e85eb8c7d08e", "3b5a6dbe741a21c7"],
  ember: ["7bafb6fbccd4fa29", "d82e57a736986db1"],
  sprig: ["26e3b90aab194536", "f81d1b3d23e12281"],
  crumb: ["103bf61bcf2c066a", "56faaa3dacb65461"],
  mochi: ["83322703fbe6d1a7", "cbb3abe780cdf896"],
  dash: ["39dae5d04775b119", "54c8b450feced61a"],
  pinch: ["e74b07c2e5f0b4fe", "a616fec041b9b76a"],
  unit: ["4a8509453cbe1463", "edeb54f33b339a83"],
  dot: ["9fdebe856aadfdfa", "0126f56055566690"],
  blip: ["b93a45e721a15fb7", "3dc8108389e4aef7"],
  zest: ["ffa706cade21c641", "655fe92c9846bd92"],
  tang: ["70277f1e3caafd6c", "9f1b46bdc4277922"],
  nib: ["c8ec583c27baf7eb", "95acdc423207e24c"],
  brine: ["bad3c8392aadfcc9", "c829afe55f601d4a"],
  whisk: ["cc6646cbba0537ea", "da3d3bdb8d91b4bb"],
  ladle: ["95add5726c061672", "b931abbc261e598f"],
  scoop: ["afcd881159c077a6", "60cb9042ccd1ff6d"],
  tongs: ["a984e059e4070b6b", "b42a90db079e5b3e"],
  sage: ["5c9e94b1777887e2", "180adc6fdea18468"],
  clove: ["f72587dc355b3b65", "ccb30e847bfe157b"],
  bolt: ["c6dc6afa647b3112", "c3eb14607a3e4747"],
  cog: ["b6365482391e0a81", "2212d8c77f56a385"],
};

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
      : v;

/** Every call drawRobot makes for one character, one per line. `accent` undefined = the option left out. */
function drawing(kind: ArtStyle, id: CrewCharacterId, accent?: string | null): string[] {
  const log: string[] = [];
  const rec = (name: string) => (...a: unknown[]) => void log.push(`${name} ${JSON.stringify(canon(a))}`);
  const B = {
    kind, rect: rec("rect"), box: rec("box"), ell: rec("ell"), line: rec("line"), glow: rec("glow"), path: rec("path"), text: rec("text"), tw: () => 0,
    clip: (_x: number, _y: number, _w: number, _h: number, fn: () => void) => fn(), alpha: (_a: number, fn: () => void) => fn(),
    spriteK: (k: number) => k, sprite: (_x: number, _y: number, _k: number, fn: (Z: Backend) => void) => fn(B),
  } as unknown as Backend;
  drawRobot(B, id, 3, 5, accent === undefined ? {} : { accent });
  return log;
}
const hash = (log: string[]) => createHash("sha256").update(log.join("\n")).digest("hex").slice(0, 16);

function same(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const ALL = Object.keys(CREW_CHARACTERS) as CrewCharacterId[];
const BASES = Object.keys(CHARACTERS) as CharacterId[];
const VARIANTS = Object.keys(CREW_VARIANTS) as CrewCharacterId[];
/** Every palette colour an agent may be shown in. */
const PICKS = agentPalette.filter((c) => !RESERVED_ACCENTS.includes(c));

const tests: [string, () => void][] = [
  ["designs: all 24 characters draw as on main, in both styles, with no colour", () => {
    same("characters", ALL.length, 24);
    for (const id of ALL) same(id, STYLES.map((k) => hash(drawing(k, id))), DESIGN_DRAWS[id]);
  }],
  ["designs: a null colour and the design's own accent colour draw the design", () => {
    for (const id of BASES) for (const k of STYLES) {
      same(`${id}/${k} null`, drawing(k, id, null), drawing(k, id));
      same(`${id}/${k} own colour`, drawing(k, id, ACCENT_PARTS[id].colour), drawing(k, id));
      same(`${id}/${k} own colour, upper case`, drawing(k, id, ACCENT_PARTS[id].colour.toUpperCase()), drawing(k, id));
    }
  }],
  ["accent parts: each base design names one part, and every piece of it is the listed colour", () => {
    same("one entry per base design", Object.keys(ACCENT_PARTS).sort(), [...BASES].sort());
    for (const id of BASES) {
      const slot = ACCENT_PARTS[id];
      const pieces = [...(slot.parts ?? []).map((i) => ROBOTS[id].parts[i]?.[5]), ...(slot.details ?? []).map((i) => ROBOTS[id].details[i]?.[4])];
      if (!pieces.length) throw new Error(`${id} has no accent piece`);
      same(`${id} ${slot.name}`, pieces, pieces.map(() => slot.colour));
    }
  }],
  ["accent parts: a picked colour changes those calls only, and only their colour", () => {
    for (const id of BASES) for (const k of STYLES) for (const pick of PICKS) {
      const slot = ACCENT_PARTS[id];
      const before = drawing(k, id);
      const after = drawing(k, id, pick);
      same(`${id}/${k} ${pick} call count`, after.length, before.length);
      const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i]));
      // Pixel art draws each part twice (ink pass, then fill); a detail is one call.
      const want = (slot.parts?.length ?? 0) * (k === "pixel" ? 2 : 1) + (slot.details?.length ?? 0);
      same(`${id}/${k} ${pick} changed calls`, changed.length, pick === slot.colour ? 0 : want);
      for (const i of changed) same(`${id}/${k} ${pick} call ${i}`, after[i], before[i].replace(JSON.stringify(slot.colour), JSON.stringify(pick)));
    }
  }],
  ["reserved pinks and malformed colours are never drawn: the design's own accent shows", () => {
    same("reserved", RESERVED_ACCENTS.map((c) => usableAccent(c)), RESERVED_ACCENTS.map(() => null));
    const refused = [...RESERVED_ACCENTS, ...RESERVED_ACCENTS.map((c) => c.toUpperCase()), " #FF77A8 ", "", "red", "#fff", "#12345g", "#29adff80", "url(#x)", "rgb(41,173,255)"];
    same("refused", refused.map((c) => usableAccent(c)), refused.map(() => null));
    same("null and undefined", [usableAccent(null), usableAccent(undefined)], [null, null]);
    same("trimmed and lower-cased", usableAccent(" #29ADFF "), "#29adff");
    same("palette: only the pink is refused", agentPalette.filter((c) => !usableAccent(c)), ["#ff77a8"]);
    for (const id of ALL) for (const k of STYLES) for (const c of refused) same(`${id}/${k} ${JSON.stringify(c)}`, hash(drawing(k, id, c)), DESIGN_DRAWS[id][STYLES.indexOf(k)]);
  }],
  ["variants keep their designed accent whatever colour is passed", () => {
    same("variants", VARIANTS.length, 14);
    for (const id of VARIANTS) for (const k of STYLES) for (const pick of PICKS) same(`${id}/${k} ${pick}`, hash(drawing(k, id, pick)), DESIGN_DRAWS[id][STYLES.indexOf(k)]);
  }],
  ["native team: each member carries its agent's colour; the lead's default pink is dropped", () => {
    const snap = World.initialSnapshot(presets[0]);
    const colours = Object.fromEntries(snap.config.team.map((a) => [a.id, a.color]));
    same("preset colours", colours, { michael: "#ff77a8", dwight: "#29adff", jim: "#ffd23a" });
    same("crew colours", Object.fromEntries(buildGalley(snap).crew.map((c) => [c.id, c.color])), { michael: null, dwight: "#29adff", jim: "#ffd23a" });
    snap.config.team[1].color = "#FF4F7B";
    snap.config.team[2].color = "not a colour";
    same("reserved and malformed", buildGalley(snap).crew.map((c) => c.color), [null, null, null]);
  }],
  ["Pathfinder sessions are not wired: no crew member takes a colour", () => {
    const snap = busySnapshot();
    const team = snap.config.team;
    if (!team.length || team.some((a) => !a.crew)) throw new Error("the busy fixture should be all Pathfinder sessions");
    same("the fixture's stored colours are usable", team.map((a) => usableAccent(a.color) !== null), team.map(() => true));
    same("agentColor", team.map((a) => agentColor(a)), team.map(() => null));
    same("crew colours", buildGalley(snap).crew.map((c) => c.color), team.map(() => null));
    // The same agents without their session facts are a native team, and do take the colour.
    same("without crew", team.map((a) => agentColor({ ...a, crew: undefined })), team.map((a) => a.color));
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed · ${ALL.length} characters × ${STYLES.length} styles · ${PICKS.length} pickable colours`);
if (failed) process.exit(1);
