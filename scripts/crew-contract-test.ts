// Checks the Feature 09 crew contract (src/data/crewContract.ts, docs/crew-contract.md).
//
//   npx tsx scripts/crew-contract-test.ts

import { CHARACTERS, CREW_CHARACTERS, type CharacterId } from "../src/data/crew";
import {
  allocateCharacter, canTransition, CHARACTER_FAMILY, CREW_STATES, CREW_TRANSITIONS, crewContractProblems, crewNameProblem, deriveCrewState,
  emptyCrewBook, FAMILY_POOLS, familyFor, FINISHED_LINGER_MS, PARALLEL_FAMILIES, ROLE_FAMILIES,
  type CrewBook, type CrewCharacterId, type CrewSession, type RoleFamily,
} from "../src/data/crewContract";

function same(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const NOW = Date.parse("2026-11-12T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function session(id: string, family: RoleFamily, ticket: string | null, characterId: CrewCharacterId | null, phase: "live" | "ended"): CrewSession {
  return {
    id, kind: "worker", hqId: `w-${id}`, role: family, stage: family === "tester" ? "review" : "implementation", family, ticket, title: null, worktree: null, parent: null,
    characterId, reassignedFrom: null, phase, startedAt: iso(NOW - 60_000), endedAt: phase === "ended" ? iso(NOW - 30_000) : null, end: null, report: null,
    transcript: null, telemetry: null, legacy: null,
  };
}

/** Adds a session to the book the way the registry would: allocate, then hold. */
function start(book: CrewBook, id: string, family: RoleFamily, ticket: string | null) {
  const c = allocateCharacter(book, family, ticket);
  book.sessions[id] = session(id, family, ticket, c, "live");
  if (c) book.characters[c] = { id: c, family: CHARACTER_FAMILY[c], name: null, color: null, sessionId: id, lastSessionId: id, availableSince: null, firstSeen: iso(NOW), retired: false };
  return c;
}
function finish(book: CrewBook, id: string) {
  const s = book.sessions[id];
  s.phase = "ended";
  s.endedAt = iso(NOW);
  const c = s.characterId && book.characters[s.characterId];
  if (c) Object.assign(c, { sessionId: null, availableSince: iso(NOW) });
}

const tests: [string, () => void][] = [
  ["catalogue: no contract problems", () => same("problems", crewContractProblems(), [])],
  ["ids are unique and cover every pool", () => {
    const pooled = Object.values(FAMILY_POOLS).flat();
    same("unique pooled ids", new Set(pooled).size, pooled.length);
    same("pooled = catalogue", [...pooled].sort(), Object.keys(CREW_CHARACTERS).sort());
  }],
  ["existing character ids stay valid in their old families", () => {
    const legacy: CharacterId[] = ["basil", "pepper", "roux", "ember", "sprig", "crumb", "mochi", "dash", "pinch", "unit"];
    same("legacy ids", Object.keys(CHARACTERS).sort(), [...legacy].sort());
    same("families", legacy.map((id) => CHARACTER_FAMILY[id]), ["orchestrator", "developer", "developer", "developer", "developer", "developer", "developer", "tester", "adversary", "unknown"]);
  }],
  ["every parallel family has >= 3 distinct characters", () => {
    for (const f of PARALLEL_FAMILIES) if (FAMILY_POOLS[f].length < 3) throw new Error(`${f}: ${FAMILY_POOLS[f].length}`);
  }],
  ["no duplicate or numbered display names", () => {
    const names = Object.values(CREW_CHARACTERS).map((c) => c.name.toLowerCase());
    same("unique names", new Set(names).size, names.length);
    same("numbered", names.filter((n) => /\s\d+$/.test(n)), []);
  }],
  ["familyFor: static-policy stages, adversary, helper, integrator, unknown", () => {
    same("impl", familyFor("developer", "implementation"), "developer");
    for (const s of ["resume", "rebase-and-reverify", "resolve-conflict", "repair"]) same(s, familyFor(null, s), "developer");
    same("review", familyFor("tester", "review"), "tester");
    same("adversary stage wins", familyFor("tester", "adversary"), "adversary");
    same("coordinator integrating", familyFor("orchestrator", "integrate"), "orchestrator");
    same("dispatched integrator", familyFor("integrator", "integrate"), "integrator");
    same("helper", familyFor(null, "helper"), "helper");
    same("unknown", familyFor("chef", "bake"), "unknown");
    for (const f of ROLE_FAMILIES) if (!FAMILY_POOLS[f].length) throw new Error(`${f} has no pool`);
  }],
  ["allocation: concurrent same-family sessions get distinct characters, then overflow", () => {
    const book = emptyCrewBook("test", iso(NOW));
    same("testers", ["a", "b", "c", "d", "e"].map((id, i) => start(book, id, "tester", `0${i}.1`)), ["dash", "dot", "blip", "zest", null]);
    same("adversaries", ["p", "q"].map((id) => start(book, id, "adversary", null)), ["pinch", "tang"]);
    same("coordinator", allocateCharacter(book, "orchestrator", null), "basil");
  }],
  ["allocation: reuse a finished character; prefer the same ticket", () => {
    const book = emptyCrewBook("test", iso(NOW));
    start(book, "s1", "developer", "07.2"); // pepper
    start(book, "s2", "developer", "08.1"); // roux
    finish(book, "s1");
    finish(book, "s2");
    same("same ticket -> roux", start(book, "s3", "developer", "08.1"), "roux");
    same("other ticket -> pepper", start(book, "s4", "developer", "09.9"), "pepper");
    same("fresh session, old one kept", [book.sessions.s1.phase, book.sessions.s4.phase], ["ended", "live"]);
  }],
  ["allocation: retired characters are skipped", () => {
    const book = emptyCrewBook("test", iso(NOW));
    start(book, "s1", "tester", null);
    finish(book, "s1");
    book.characters.dash!.retired = true;
    same("next", start(book, "s2", "tester", null), "dot");
  }],
  ["transitions: available only to assigned; finished back to available or assigned", () => {
    same("available", CREW_TRANSITIONS.available, ["assigned"]);
    same("finished->assigned", canTransition("finished", "assigned"), true);
    same("available->working", canTransition("available", "working"), false);
    for (const s of CREW_STATES) if (s !== "available" && !canTransition(s, "finished") && s !== "finished") throw new Error(`${s} cannot finish`);
  }],
  ["deriveCrewState: observed data only", () => {
    const live = session("x", "developer", "01.1", "pepper", "live");
    const obs = { session: "running" as const, agent: "working" as const, tools: 3, attention: null, at: iso(NOW) };
    same("none", deriveCrewState(null, null, NOW), "available");
    same("no observation", deriveCrewState(live, null, NOW), "unknown");
    same("stale", deriveCrewState(live, { ...obs, at: iso(NOW - 10 * 60_000) }, NOW), "unknown");
    same("starting", deriveCrewState(live, { ...obs, tools: 0 }, NOW), "assigned");
    same("working", deriveCrewState(live, obs, NOW), "working");
    same("needs-input unconfirmed", deriveCrewState(live, { ...obs, agent: "needs-input" }, NOW), "waiting");
    same("gate", deriveCrewState(live, { ...obs, attention: { kind: "needs-you", reason: "01.1 gate" } }, NOW), "needs-you");
    same("stopped while live", deriveCrewState(live, { ...obs, session: "stopped" }, NOW), "unknown");
    const ended = { ...live, phase: "ended" as const, endedAt: iso(NOW - 1000) };
    same("just finished", deriveCrewState(ended, null, NOW), "finished");
    same("relaxing", deriveCrewState(ended, null, NOW + FINISHED_LINGER_MS), "available");
  }],
  ["names: unique, not numbered, rename is label only", () => {
    const chars: CrewBook["characters"] = { roux: { id: "roux", family: "developer", name: "Saucy", color: null, sessionId: null, lastSessionId: null, availableSince: null, firstSeen: iso(NOW), retired: false } };
    same("catalogue clash", crewNameProblem("pepper", "dash", chars) !== null, true);
    same("custom clash", crewNameProblem("pepper", " saucy ", chars) !== null, true);
    same("numbered", crewNameProblem("dot", "Dash 2", chars) !== null, true);
    same("own name", crewNameProblem("pepper", "Pepper", chars), null);
    same("fine", crewNameProblem("pepper", "Chili", chars), null);
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
const pools = Object.entries(FAMILY_POOLS).map(([f, ids]) => `${f}=${ids.length}`).join(" ");
console.log(`\n${tests.length - failed}/${tests.length} passed · ${Object.keys(CREW_CHARACTERS).length} characters · ${pools}`);
if (failed) process.exit(1);
