// Checks the Feature 09 crew contract (src/data/crewContract.ts, docs/crew-contract.md).
//
//   npx tsx scripts/crew-contract-test.ts

import { CHARACTERS, CREW_CHARACTERS, CREW_VARIANTS, type CharacterId } from "../src/data/crew";
import { agentPalette } from "../src/theme/tokens";
import {
  allocateCharacter, beginRestore, canTransition, crewColor, crewColorProblem, crewFloorChanges, customizeCharacter, FAMILY_COLOR, retireCharacter, compareSessionAge, CREW_STATE_BADGE, CHARACTER_FAMILY, CREW_STATES, CREW_TRANSITIONS, crewContractProblems, crewNameProblem, crewTransitionKind, deriveCrewState,
  emptyCrewBook, endSession, FAMILY_POOLS, familyFor, FINISHED_LINGER_MS, MAX_CREW_NAME, migrateLegacy, PARALLEL_FAMILIES, reconcileAfterRestore,
  RESERVED_ACCENTS, restoreSession, ROLE_FAMILIES, spriteBase, startSession,
  type CrewBook, type CrewCharacterId, type CrewCharacterView, type CrewState, type CrewSession, type LegacyCrewJson, type LegacySessionsJson, type RoleFamily,
} from "../src/data/crewContract";

function same(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const NOW = Date.parse("2026-11-12T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function session(id: string, family: RoleFamily, ticket: string | null, characterId: CrewCharacterId | null, phase: "live" | "ended"): CrewSession {
  return {
    id, kind: "worker", hqId: `w-${id}`, role: family, stage: family === "tester" ? "review" : "implementation", family, ticket, title: null, worktree: null, parent: null,
    characterId, reassignedFrom: null, phase, seq: 0, startedAt: iso(NOW - 60_000), endedAt: phase === "ended" ? iso(NOW - 30_000) : null, end: null, report: null,
    transcript: null, telemetry: null, legacy: null,
  };
}

const STAGE: Record<RoleFamily, string> = { developer: "implementation", tester: "review", adversary: "adversary", orchestrator: "coordinate", helper: "helper", planner: "plan", integrator: "integrate", unknown: "bake" };
/** Adds a session to the book the way the registry does: through startSession. */
function start(book: CrewBook, id: string, family: RoleFamily, ticket: string | null, now = NOW) {
  return startSession(book, id, { role: family === "unknown" ? "chef" : family, stage: STAGE[family], ticket }, iso(now)).characterId;
}
function finish(book: CrewBook, id: string, now = NOW) {
  endSession(book, id, { outcome: "handed-off", next: "review", result: "done", at: iso(now) }, iso(now));
}

/** Synthetic data shaped like the live ~/.controlroom files: crew.json {id, job, name}; sessions.json {at, next, outcome, result}. */
const end = (at: number, outcome: "handed-off" | "gate" | "failed" | "interrupted" = "handed-off") => ({ at: iso(at), next: outcome === "handed-off" ? "review" : null, outcome, result: `Last at ${at}` });
const LIVE_CREW: LegacyCrewJson = {
  a1f0c2: { id: "pepper", job: "Sous Chef", name: "Pepper" },
  b2e1d3: { id: "dash", job: "Expediter", name: "Dash" },
  c3d2e4: { id: "pepper", job: "Sous Chef", name: "Pepper" },
  d4c3f5: { id: "roux", job: "Saucier", name: "Roux" },
  e5b4a6: { id: "pepper", job: "Sous Chef", name: "Pepper 2" },
  f6a5b7: { id: "unit", job: "Integrator", name: "Integrator bot" },
  a7f6c8: { id: "dash", job: "Expediter", name: "Dash" }, // crew-only: live at migration time
};
const LIVE_SESSIONS: LegacySessionsJson = {
  a1f0c2: end(NOW - 9e6),
  b2e1d3: end(NOW - 8e6, "gate"),
  c3d2e4: end(NOW - 7e6),
  d4c3f5: end(NOW - 6e6, "failed"),
  e5b4a6: end(NOW - 5e6, "interrupted"),
  f6a5b7: end(NOW - 4e6),
  z9y8x7: end(NOW - 3e6), // sessions-only
};
const OPTS = { kitchen: "k", now: iso(NOW), backup: "/x/backups/crew-1" };
const strip = (b: CrewBook) => ({ ...b, updatedAt: "" });

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
    same("coordinator", allocateCharacter(book, "orchestrator", null, "coordinator"), "basil");
    same("orchestrator-family worker", allocateCharacter(book, "orchestrator", null), null);
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
    for (const n of ["Dash2", "Dash-2", "R2D2", "Dash 2"]) same(n, crewNameProblem("pepper", n, chars) !== null, true);
    same("empty", crewNameProblem("pepper", "   ", chars) !== null, true);
    same("max ok", crewNameProblem("pepper", "x".repeat(MAX_CREW_NAME), chars), null);
    same("too long", crewNameProblem("pepper", "x".repeat(MAX_CREW_NAME + 1), chars) !== null, true);
  }],
  ["familyFor: aliases, role over stage, prototype keys (L1)", () => {
    for (const [r, f] of [["dev", "developer"], ["engineer", "developer"], ["qa", "tester"], ["reviewer", "tester"], ["lead", "orchestrator"], ["coordinator", "orchestrator"], [" Developer ", "developer"]]) same(r, familyFor(r, null), f);
    same("role over stage", familyFor("developer", "review"), "developer");
    same("role over stage 2", familyFor("tester", "implementation"), "tester");
    same("helper stage over role", familyFor("developer", "helper"), "helper");
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      same(`role ${k}`, familyFor(k, null), "unknown");
      same(`stage ${k}`, familyFor(null, k), "unknown");
    }
  }],
  ["accents: distinct per base, never needs-you pink or unknown grey (L3)", () => {
    for (const base of ["dash", "pinch", "unit"] as const) {
      const a = Object.values(CREW_VARIANTS).filter((v) => v.base === base).map((v) => v.accent);
      same(`${base} accents unique`, new Set(a).size, a.length);
    }
    same("no pink", Object.values(CREW_VARIANTS).filter((v) => RESERVED_ACCENTS.includes(v.accent)).map((v) => v.id), []);
    same("bolt != cog", CREW_VARIANTS.bolt.accent !== CREW_VARIANTS.cog.accent, true);
    same("sprite base", [spriteBase("dot"), spriteBase("whisk"), spriteBase("pepper")], ["dash", "unit", "pepper"]);
  }],
  ["allocation: a single-character family overflows the second session (planner)", () => {
    const book = emptyCrewBook("test", iso(NOW));
    same("planners", [start(book, "p1", "planner", null), start(book, "p2", "planner", null)], ["sage", null]);
    finish(book, "p1");
    same("overflow keeps no robot", book.sessions.p2.characterId, null);
    same("next planner gets sage", start(book, "p3", "planner", null), "sage");
  }],
  ["allocation: a just-finished character goes to a new session inside the linger window", () => {
    const book = emptyCrewBook("test", iso(NOW));
    start(book, "s1", "tester", "05.1");
    finish(book, "s1", NOW);
    same("dash again at +1s", start(book, "s2", "tester", "05.2", NOW + 1000), "dash");
    same("state", deriveCrewState(book.sessions.s2, null, NOW + 1000), "unknown");
    same("assigned once observed", deriveCrewState(book.sessions.s2, { session: "starting", agent: "working", tools: 0, attention: null, at: iso(NOW + 1000) }, NOW + 1000), "assigned");
    same("finished -> assigned animates", crewTransitionKind("finished", "assigned"), "animate");
    same("startSession never re-allocates", startSession(book, "s2", { role: "tester", stage: "review" }, iso(NOW)).characterId, "dash");
  }],
  ["deriveCrewState: reading time, malformed time, Basil (M1, M3)", () => {
    const live = session("x", "developer", "01.1", "pepper", "live");
    const gate = { session: "running" as const, agent: "needs-input" as const, tools: 4, attention: { kind: "needs-you" as const, reason: "01.1 gate" }, at: iso(NOW - 5000) };
    same("old gate, fresh reading", deriveCrewState(live, gate, NOW), "needs-you");
    same("stale reading + needs-you", deriveCrewState(live, { ...gate, at: iso(NOW - 180_000) }, NOW), "unknown");
    same("garbage at", deriveCrewState(live, { ...gate, attention: null, agent: "working", at: "garbage" }, NOW), "unknown");
    same("coordinator waiting", deriveCrewState(live, { ...gate, attention: { kind: "waiting", reason: "waiting on workers" } }, NOW), "waiting");
    same("basil, no session", deriveCrewState(null, null, NOW, "basil"), "unknown");
    same("pepper, no session", deriveCrewState(null, null, NOW, "pepper"), "available");
    same("empty book has basil", Object.keys(emptyCrewBook("k", iso(NOW)).characters), ["basil"]);
  }],
  ["transitions: illegal jumps snap (L6)", () => {
    same("available -> working", crewTransitionKind("available", "working"), "snap");
    same("working -> waiting", crewTransitionKind("working", "waiting"), "animate");
    same("same", crewTransitionKind("unknown", "unknown"), "stay");
  }],
  ["migration: live-shaped files, crew-only entry stays live and holds its character (H1, M2)", () => {
    const b = migrateLegacy(LIVE_CREW, LIVE_SESSIONS, null, OPTS);
    same("ids", Object.keys(b.sessions), [...Object.keys(LIVE_CREW), "z9y8x7"]);
    same("seq = crew.json order", Object.values(b.sessions).map((s) => s.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
    same("three Pepper sessions on pepper", Object.values(b.sessions).filter((s) => s.characterId === "pepper").length, 3);
    same("numbered legacy kept verbatim", b.sessions.e5b4a6.legacy, { name: "Pepper 2", job: "Sous Chef", character: "pepper" });
    same("crew-only is live", [b.sessions.a7f6c8.phase, b.sessions.a7f6c8.end, b.sessions.a7f6c8.endedAt], ["live", null, null]);
    same("ended keeps outcome", [b.sessions.d4c3f5.phase, b.sessions.d4c3f5.end?.outcome, b.sessions.d4c3f5.endedAt], ["ended", "failed", iso(NOW - 6e6)]);
    same("sessions-only", [b.sessions.z9y8x7.characterId, b.sessions.z9y8x7.phase, b.sessions.z9y8x7.end?.outcome], [null, "ended", "handed-off"]);
    same("unit family from legacy job", b.sessions.f6a5b7.family, "integrator");
    same("tester family", b.sessions.a7f6c8.family, "tester");
    same("dash held", [b.characters.dash?.sessionId, b.characters.dash?.lastSessionId, b.characters.dash?.availableSince], ["a7f6c8", "a7f6c8", null]);
    same("pepper derived", [b.characters.pepper?.sessionId, b.characters.pepper?.lastSessionId, b.characters.pepper?.availableSince, b.characters.pepper?.firstSeen], [null, "e5b4a6", iso(NOW - 5e6), iso(NOW)]);
    same("roux derived", [b.characters.roux?.lastSessionId, b.characters.roux?.availableSince], ["d4c3f5", iso(NOW - 6e6)]);
    same("basil present", b.characters.basil?.id, "basil");
    same("dash not given to a new tester", allocateCharacter(b, "tester", null), "dot");
    same("migration record", [b.migrations.length, b.migrations[0].from, b.migrations[0].fromVersion, b.migrations[0].imported.length, b.migrations[0].backup], [1, "crew.json", 0, 8, OPTS.backup]);
  }],
  ["migration: idempotent, never mutates its input, keeps customizations", () => {
    const b1 = migrateLegacy(LIVE_CREW, LIVE_SESSIONS, null, OPTS);
    b1.characters.pepper!.name = "Chili";
    const before = JSON.stringify(b1);
    const b2 = migrateLegacy(LIVE_CREW, LIVE_SESSIONS, b1, { ...OPTS, now: iso(NOW + 60_000) });
    same("input untouched", JSON.stringify(b1), before);
    same("re-run changes only updatedAt", strip(b2), strip(b1));
    same("updatedAt moved", b2.updatedAt, iso(NOW + 60_000));
  }],
  ["migration: later run ends a live session, imports new ids, never revives", () => {
    const b1 = migrateLegacy(LIVE_CREW, LIVE_SESSIONS, null, OPTS);
    const crew2 = { ...LIVE_CREW, b8e7d9: { id: "roux", job: "Saucier", name: "Roux" } } as LegacyCrewJson;
    const b2 = migrateLegacy(crew2, { ...LIVE_SESSIONS, a7f6c8: end(NOW - 1000, "gate") }, b1, { ...OPTS, now: iso(NOW + 1) });
    same("live -> ended", [b2.sessions.a7f6c8.phase, b2.sessions.a7f6c8.end?.outcome, b2.sessions.a7f6c8.endedAt], ["ended", "gate", iso(NOW - 1000)]);
    same("new id, next seq", [b2.sessions.b8e7d9.phase, b2.sessions.b8e7d9.seq], ["live", 8]);
    same("record", [b2.migrations[1].from, b2.migrations[1].fromVersion, b2.migrations[1].imported, b2.migrations[1].filled], ["crew-book.json", 1, ["b8e7d9"], ["a7f6c8"]]);
    const shrunk = { ...LIVE_SESSIONS } as LegacySessionsJson;
    delete shrunk.d4c3f5;
    const b3 = migrateLegacy(LIVE_CREW, shrunk, b2, { ...OPTS, now: iso(NOW + 2) });
    same("ended stays ended", [b3.sessions.d4c3f5.phase, b3.sessions.d4c3f5.end?.outcome], ["ended", "failed"]);
    same("restore cannot revive", restoreSession(b3, "d4c3f5", { phase: "live" }, iso(NOW + 3)).phase, "ended");
  }],
  ["restore: fills nulls only, recomputes family, may end a live session (rule 5, L2)", () => {
    const b = migrateLegacy(LIVE_CREW, LIVE_SESSIONS, null, OPTS);
    const s = restoreSession(b, "f6a5b7", { phase: "ended", hqId: "w-04-1-helper-f6a5b7", role: null, stage: "helper", ticket: "04.1", startedAt: iso(NOW - 4.5e6) }, iso(NOW));
    same("filled", [s.hqId, s.stage, s.ticket, s.startedAt, s.characterId], ["w-04-1-helper-f6a5b7", "helper", "04.1", iso(NOW - 4.5e6), "unit"]);
    same("family follows stage", s.family, "helper");
    restoreSession(b, "f6a5b7", { phase: "ended", ticket: "99.9" }, iso(NOW));
    same("non-null kept", b.sessions.f6a5b7.ticket, "04.1");
    const live = restoreSession(b, "a7f6c8", { phase: "ended", role: "tester", stage: "review" }, iso(NOW + 5));
    same("live -> ended, outcome unknown", [live.phase, live.end, live.endedAt], ["ended", null, iso(NOW + 5)]);
    same("dash freed", b.characters.dash?.sessionId, null);
  }],
  ["reconcile: unobserved crew-only sessions end; shared character tiebreak: no startedAt first, then startedAt, then seq (rule 7)", () => {
    const crew = { ...LIVE_CREW, b1x: { id: "pepper", job: "Sous Chef", name: "Pepper" }, b2x: { id: "pepper", job: "Sous Chef", name: "Pepper 2" } } as LegacyCrewJson;
    const b = migrateLegacy(crew, LIVE_SESSIONS, null, OPTS);
    same("both live, oldest holds", [b.sessions.b1x.phase, b.sessions.b2x.phase, b.characters.pepper?.sessionId], ["live", "live", "b1x"]);
    same("pepper is taken before reconcile", allocateCharacter(b, "developer", null), "roux");
    const c = reconcileAfterRestore(b, ["b1x", "b2x"], iso(NOW + 10));
    same("dead crew-only ended", [b.sessions.a7f6c8.phase, b.sessions.a7f6c8.end], ["ended", null]);
    same("earlier seq keeps pepper", [b.sessions.b1x.characterId, b.sessions.b2x.characterId, b.sessions.b2x.reassignedFrom], ["pepper", "roux", "pepper"]);
    same("conflict recorded", [c.length, c[0].sessionId, b.migrations[0].conflicts.length], [1, "b2x", 1]);
    same("holders", [b.characters.pepper?.sessionId, b.characters.roux?.sessionId, b.characters.dash?.sessionId], ["b1x", "b2x", null]);

    const b4 = migrateLegacy(crew, LIVE_SESSIONS, null, OPTS);
    restoreSession(b4, "b1x", { phase: "live", startedAt: iso(NOW - 1000) }, iso(NOW));
    restoreSession(b4, "b2x", { phase: "live", startedAt: iso(NOW - 2000) }, iso(NOW));
    reconcileAfterRestore(b4, ["b1x", "b2x"], iso(NOW + 10));
    same("earlier startedAt keeps pepper", [b4.sessions.b2x.characterId, b4.sessions.b1x.characterId, b4.sessions.b1x.reassignedFrom], ["pepper", "roux", "pepper"]);
    same("second reconcile is a no-op", reconcileAfterRestore(b4, ["b1x", "b2x"], iso(NOW + 20)), []);
  }],
  ["coordinator: Basil always, one live coordinator session", () => {
    const b = emptyCrewBook("k", iso(NOW));
    same("c1", startSession(b, "coordinator:t1", { kind: "coordinator", stage: "coordinate" }, iso(NOW)).characterId, "basil");
    same("c2", startSession(b, "coordinator:t2", { kind: "coordinator", stage: "coordinate" }, iso(NOW + 1)).characterId, "basil");
    same("c1 ended", [b.sessions["coordinator:t1"].phase, b.characters.basil?.sessionId], ["ended", "coordinator:t2"]);
  }],
  ["basil: only the coordinator wears him (N1)", () => {
    const liveOnBasil = (b: CrewBook) => Object.values(b.sessions).filter((s) => s.phase === "live" && s.characterId === "basil").map((s) => s.id);
    // A coordinator, then a worker whose brief says Role: lead.
    const b1 = emptyCrewBook("k", iso(NOW));
    startSession(b1, "coordinator:t1", { kind: "coordinator" }, iso(NOW));
    const lead = startSession(b1, "wk1", { kind: "worker", role: "lead", stage: "implementation", ticket: "x" }, iso(NOW + 1));
    same("Role lead worker is overflow", [lead.family, lead.characterId], ["orchestrator", null]);
    same("basil held once", liveOnBasil(b1), ["coordinator:t1"]);
    const integ = startSession(b1, "wk2", { kind: "worker", stage: "integrate", ticket: "x" }, iso(NOW + 2));
    same("Session integrate, no Role, is overflow", integ.characterId, null);
    // The same worker first, with no coordinator yet: still never basil.
    const b2 = emptyCrewBook("k", iso(NOW));
    same("lead worker alone", startSession(b2, "wk1", { role: "lead" }, iso(NOW)).characterId, null);
    // A legacy live basil worker, the restore records the coordinator, then reconcile.
    const OPT = { kitchen: "k", now: iso(NOW), backup: "/b" };
    const legacy: LegacyCrewJson = { z1: { id: "basil", name: "Basil", job: "Head Chef" } };
    const b3 = migrateLegacy(legacy, {}, null, OPT);
    restoreSession(b3, "coordinator:t", { kind: "coordinator", phase: "live", startedAt: iso(NOW - 3_600_000) }, iso(NOW + 1));
    same("coordinator start moves the legacy worker off", [b3.sessions.z1.characterId, b3.sessions.z1.reassignedFrom], [null, "basil"]);
    same("conflict recorded", b3.migrations.at(-1)?.conflicts.map((c) => [c.sessionId, c.characterId]), [["z1", "basil"]]);
    same("reconcile finds nothing more", reconcileAfterRestore(b3, ["z1", "coordinator:t"], iso(NOW + 2)), []);
    same("basil held by the coordinator only", liveOnBasil(b3), ["coordinator:t"]);
    // Legacy live basil worker kept running through reconcile, then a coordinator starts.
    const b4 = migrateLegacy(legacy, {}, null, OPT);
    const c4 = reconcileAfterRestore(b4, ["z1"], iso(NOW + 1));
    same("reconcile moves a non-coordinator off basil", [c4.map((c) => c.sessionId), b4.sessions.z1.characterId], [["z1"], null]);
    startSession(b4, "coordinator:t2", { kind: "coordinator" }, iso(NOW + 2));
    same("coordinator gets basil alone", liveOnBasil(b4), ["coordinator:t2"]);
    same("basil record holder", b4.characters.basil?.sessionId, "coordinator:t2");
  }],
  ["compareSessionAge is a total order (N3)", () => {
    const mk = (id: string, seq: number, t: number | null) => ({ ...session(id, "developer", null, "pepper", "live"), seq, startedAt: t === null ? null : iso(t) });
    const A = mk("A", 0, NOW + 10), B = mk("B", 1, null), C = mk("C", 2, NOW + 5);
    const lt = (x: CrewSession, y: CrewSession) => compareSessionAge(x, y) < 0;
    same("no cycle", [lt(A, B), lt(B, C), lt(C, A)].filter(Boolean).length < 3 && [lt(B, A), lt(C, B), lt(A, C)].filter(Boolean).length < 3, true);
    same("order", [B, C, A].map((s) => s.id), [A, B, C].sort(compareSessionAge).map((s) => s.id));
    same("same order from any input", [C, A, B].sort(compareSessionAge).map((s) => s.id), ["B", "C", "A"]);
    for (const x of [A, B, C]) for (const y of [A, B, C]) if (x !== y && Math.sign(compareSessionAge(x, y)) !== -Math.sign(compareSessionAge(y, x))) throw new Error(`antisymmetry ${x.id} ${y.id}`);
    same("equal startedAt falls back to seq", compareSessionAge(mk("D", 3, NOW), mk("E", 4, NOW)) < 0, true);
  }],
  ["state order, badges, endedAt (N2, N4)", () => {
    const live = session("s", "developer", "09.1", "pepper", "live");
    const obs = { session: "stopped", agent: "needs-input", tools: 3, attention: { kind: "needs-you", reason: "09.1 gate" }, at: iso(NOW) } as const;
    same("stopped at a real gate is needs-you", deriveCrewState(live, obs, NOW), "needs-you");
    same("stopped and waiting is waiting", deriveCrewState(live, { ...obs, attention: { kind: "waiting", reason: "workers" } }, NOW), "waiting");
    same("stopped, no attention, is unknown", deriveCrewState(live, { ...obs, attention: null }, NOW), "unknown");
    same("badges", CREW_STATES.map((s) => CREW_STATE_BADGE[s]), [null, "starting", null, "waiting", "needs-you", "unknown", null]);
    // Reconcile ends a crew-only session; a later sessions.json ending fills end but keeps endedAt.
    const OPT = { kitchen: "k", now: iso(NOW), backup: "/b" };
    const crew: LegacyCrewJson = { q1: { id: "pepper", name: "Pepper", job: "Sous Chef" } };
    const b = migrateLegacy(crew, {}, null, OPT);
    reconcileAfterRestore(b, [], iso(NOW + 1000));
    const b2 = migrateLegacy(crew, { q1: end(NOW - 5000, "gate") }, b, { ...OPT, now: iso(NOW + 2000) });
    same("ending filled, endedAt kept", [b2.sessions.q1.end?.outcome, b2.sessions.q1.end?.at, b2.sessions.q1.endedAt], ["gate", iso(NOW - 5000), iso(NOW + 1000)]);
  }],
  ["restart order: every permutation of ended/live/new restore order gives the same allocation (M1)", () => {
    for (const [key, perms] of [["8 observations", permutations(RESTART_OBS.length)]] as const) {
      let first: string | null = null;
      for (const order of perms) {
        const b = restart(order.map((i) => RESTART_OBS[i]));
        const got = JSON.stringify(allocationOf(b));
        if (first === null) first = got;
        else if (got !== first) throw new Error(`${key}: order ${order.join(",")} gave ${got}, first gave ${first}`);
        same("uniqueness", liveSharing(b), []);
        same("no fresh session detached while its family has a free character", detachedFresh(b, ["n1", "n2", "n3", "t3"]), []);
      }
      same(`${key}: expected allocation`, JSON.parse(first!), RESTART_EXPECTED);
    }
  }],
  ["restart order: the reviewer's case, new testers restored before the ended ones (M1)", () => {
    const b = migrateLegacy({}, {}, prevRun(), RESTART_OPTS);
    const n1 = restoreSession(b, "n1", { phase: "live", role: "tester", stage: "review", ticket: "x", startedAt: iso(NOW + 100) }, iso(NOW + 200));
    const n2 = restoreSession(b, "n2", { phase: "live", role: "tester", stage: "review", ticket: "y", startedAt: iso(NOW + 101) }, iso(NOW + 200));
    same("pending: no character yet, none taken", [n1.characterId, n2.characterId], [null, null]);
    for (const id of ["t1", "t2", "t3", "t4"]) restoreSession(b, id, { phase: "ended" }, iso(NOW + 200));
    reconcileAfterRestore(b, ["n1", "n2", "o1", "p1", "coordinator:c1"], iso(NOW + 300));
    same("both get a robot", [b.sessions.n1.characterId, b.sessions.n2.characterId], ["dash", "dot"]);
    same("pass closed", b.restorePass, null);
  }],
  ["incomplete observation: an unseen or unconfirmed session keeps its character (M1)", () => {
    const b = migrateLegacy({}, {}, prevRun(), RESTART_OPTS);
    const holders = () => ["t1", "t2", "t3", "t4"].map((id) => [b.sessions[id].phase, b.sessions[id].characterId]);
    const before = holders();
    restoreSession(b, "n1", { phase: "live", role: "tester", stage: "review", ticket: "B", startedAt: iso(NOW + 100) }, iso(NOW + 200));
    same("a new session started by a hook mid-pass waits too", startSession(b, "h1", { role: "tester", stage: "review", ticket: "Q" }, iso(NOW + 201)).characterId, null);
    restoreSession(b, "t3", { phase: "live" }, iso(NOW + 202));
    same("unseen and seen-live sessions keep their characters mid-pass", holders(), before);
    same("no live session shares a character mid-pass", liveSharing(b), []);
    same("all four testers still held, so nothing is free", allocateCharacter(b, "tester", null), null);
    restoreSession(b, "t1", { phase: "ended" }, iso(NOW + 203));
    same("a confirmed ending frees dash, but nothing is allocated yet", [b.sessions.t1.phase, b.characters.dash?.sessionId, b.sessions.n1.characterId], ["ended", null, null]);
    reconcileAfterRestore(b, ["t2", "t3", "t4", "o1", "p1", "n1", "h1", "coordinator:c1"], iso(NOW + 300));
    same("t2, t3, t4 confirmed running keep theirs", ["t2", "t3", "t4"].map((id) => b.sessions[id].characterId), ["dot", "blip", "zest"]);
    same("n1 takes the one freed character, h1 is genuine overflow", [b.sessions.n1.characterId, b.sessions.h1.characterId], ["dash", null]);
    same("h1 kept its observed start", b.sessions.h1.startedAt, iso(NOW + 201));
    same("after the pass startSession allocates at once", startSession(b, "h2", { role: "developer", stage: "implementation" }, iso(NOW + 400)).characterId, "roux");
  }],
  ["restart: newest coordinator wins whatever the restore order; overflow from the last run stays overflow", () => {
    for (const order of [[0, 1], [1, 0]]) {
      const b = migrateLegacy({}, {}, prevRun(), RESTART_OPTS);
      const cs = [["coordinator:old", NOW - 50_000], ["coordinator:new", NOW + 50]] as const;
      for (const i of order) restoreSession(b, cs[i][0], { kind: "coordinator", phase: "live", startedAt: iso(cs[i][1]) }, iso(NOW + 200));
      same(`live on basil, order ${order}`, liveSharing(b), []);
      reconcileAfterRestore(b, ["coordinator:old", "coordinator:new", "o1"], iso(NOW + 300));
      same(`newest holds basil, order ${order}`, [b.characters.basil?.sessionId, b.sessions["coordinator:old"].phase], ["coordinator:new", "ended"]);
      same("o1 was overflow before the restart and stays so (rule 6)", [b.sessions.o1.phase, b.sessions.o1.characterId], ["live", null]);
    }
  }],
  ["character uniqueness and stable identity: fuzz with restarts in random order (M1)", () => {
    let rnd = 20261112;
    const r = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const fams = ["developer", "tester", "adversary", "helper", "planner", "integrator", "chef", "lead"];
    for (let run = 0; run < 400; run++) {
      let b = emptyCrewBook("k", iso(NOW));
      let t = 1;
      let n = 0;
      const settled = new Map<string, CrewCharacterId | null>();
      const settle = () => { for (const s of Object.values(b.sessions)) if (!settled.has(s.id) && (!b.restorePass || s.seq < b.restorePass.firstSeq)) settled.set(s.id, s.characterId); };
      const check = (where: string) => {
        same(`${where}: uniqueness`, liveSharing(b), []);
        for (const [id, rec] of Object.entries(b.characters)) {
          const live = Object.values(b.sessions).filter((s) => s.phase === "live" && s.characterId === id).sort(compareSessionAge);
          same(`${where}: ${id} cache`, rec!.sessionId ?? null, live[0]?.id ?? null);
        }
        for (const [id, c] of settled) same(`${where}: ${id} keeps its character`, b.sessions[id].characterId, c);
      };
      for (let k = 0; k < 30; k++) {
        const op = r();
        const live = Object.values(b.sessions).filter((s) => s.phase === "live").map((s) => s.id);
        if (op < 0.5) startSession(b, `s${n++}`, { role: pick(fams), stage: r() < 0.5 ? "review" : "implementation", ticket: `T${Math.floor(r() * 4)}`, kind: r() < 0.15 ? "helper" : "worker" }, iso(NOW + t++ * 1000));
        else if (op < 0.85 && live.length) endSession(b, pick(live), null, iso(NOW + t++ * 1000));
        else {
          // A restart: some live sessions ended while down, some still run, some are new; restored in two random orders.
          const obs: Obs[] = live.map((id) => ({ id, phase: r() < 0.5 ? "ended" : "live" }) as Obs).filter(() => r() < 0.8);
          for (let j = 0; j < 1 + Math.floor(r() * 4); j++) obs.push({ id: `s${n++}`, phase: r() < 0.8 ? "live" : "ended", role: pick(fams), stage: "implementation", ticket: `T${Math.floor(r() * 4)}`, startedAt: iso(NOW + t * 1000 - Math.floor(r() * 3) * 1000) });
          const running = obs.filter((o) => o.phase === "live").map((o) => o.id);
          const at = NOW + t++ * 1000;
          const runOnce = (order: Obs[]) => {
            const x = migrateLegacy({}, {}, b, { ...RESTART_OPTS, now: iso(at) });
            for (const o of order) {
              const { id, ...facts } = o;
              restoreSession(x, id, facts, iso(at));
              same("mid-pass uniqueness", liveSharing(x), []);
            }
            reconcileAfterRestore(x, running, iso(at + 500));
            return x;
          };
          const a = runOnce(shuffle(obs, r));
          const c = runOnce(shuffle(obs, r));
          same(`run ${run}: restore order changes nothing`, [allocationOf(a), seqOf(a)], [allocationOf(c), seqOf(c)]);
          b = a;
          same(`run ${run}: no fresh session detached`, detachedFresh(b, obs.filter((o) => o.role).map((o) => o.id)), []);
        }
        settle();
        check(`run ${run} step ${k}`);
      }
    }
  }],
  ["colours: role colour source, custom colour rules, write path (L1)", () => {
    same("role colours match the server's for the roles it knows", [FAMILY_COLOR.developer, FAMILY_COLOR.tester, FAMILY_COLOR.adversary, FAMILY_COLOR.orchestrator, FAMILY_COLOR.integrator, FAMILY_COLOR.planner], ["#29adff", "#00e436", "#ffa300", "#ff77a8", "#ffec27", "#83769c"]);
    same("resolved colours", [crewColor("pepper"), crewColor("dot"), crewColor("unit"), crewColor("basil")], ["#29adff", "#29adff", "#c2c3c7", "#ff77a8"]);
    same("agentPalette pink refused", crewColorProblem("pepper", agentPalette[0]) !== null, true);
    same("alert pink refused, any case", crewColorProblem("dash", "#FF4F7B") !== null, true);
    same("unknown grey refused except for unit", [crewColorProblem("dot", "#c2c3c7") !== null, crewColorProblem("unit", "#c2c3c7")], [true, null]);
    same("malformed refused", ["red", "#fff", "#12345g"].map((c) => crewColorProblem("dot", c) !== null), [true, true, true]);
    same("other palette entries fine", agentPalette.slice(1).filter((c) => c !== "#c2c3c7").map((c) => crewColorProblem("pepper", c)).filter(Boolean), []);
    const b = emptyCrewBook("k", iso(NOW));
    same("refused change writes nothing", [customizeCharacter(b, "roux", { name: "Chili", color: "#ff77a8" }, iso(NOW)) !== null, b.characters.roux], [true, undefined]);
    same("accepted", customizeCharacter(b, "roux", { name: " Chili ", color: "#00E436" }, iso(NOW)), null);
    same("stored", [b.characters.roux?.name, b.characters.roux?.color, b.characters.roux?.family, crewColor("roux", b.characters.roux)], ["Chili", "#00e436", "developer", "#00e436"]);
    same("reset", [customizeCharacter(b, "roux", { color: null }, iso(NOW)), b.characters.roux?.color, b.characters.roux?.name], [null, null, "Chili"]);
    same("basil can't be retired", retireCharacter(b, "basil", true, iso(NOW)) !== null, true);
    start(b, "s1", "tester", null);
    same("retire a held character", retireCharacter(b, "dash", true, iso(NOW)), null);
    same("its session keeps it", [b.sessions.s1.characterId, allocateCharacter(b, "tester", null)], ["dash", "dot"]);
  }],
  ["transporter: arrivals and departures are deltas within one connection, never replayed (L4)", () => {
    const v = (id: CrewCharacterId, state: CrewState, retired = false) => ({ id, state, retired }) as CrewCharacterView;
    const s1 = { characters: [v("basil", "working"), v("pepper", "available")] };
    const s2 = { characters: [v("basil", "working"), v("pepper", "working"), v("roux", "assigned")] };
    same("first snapshot after (re)connect or restart: nothing", crewFloorChanges(null, s2), { arrivals: [], departures: [] });
    same("first session of roux arrives", crewFloorChanges(s1, s2), { arrivals: ["roux"], departures: [] });
    same("same snapshot again: nothing", crewFloorChanges(s2, s2), { arrivals: [], departures: [] });
    const s3 = { characters: [v("basil", "working"), v("pepper", "finished", true), v("roux", "available")] };
    same("retired with a finishing session stays", crewFloorChanges(s2, s3), { arrivals: [], departures: [] });
    const s4 = { characters: [v("basil", "working"), v("pepper", "available", true), v("roux", "available")] };
    same("then departs; a session ending alone never does", crewFloorChanges(s3, s4), { arrivals: [], departures: ["pepper"] });
    same("un-retire arrives", crewFloorChanges(s4, { characters: [v("basil", "working"), v("pepper", "available"), v("roux", "available")] }), { arrivals: ["pepper"], departures: [] });
  }],
  ["restore never changes kind; migrated sessions are workers (L3)", () => {
    const b = migrateLegacy({ h: { id: "unit", name: "Helper bot", job: "Helper" } }, {}, null, OPTS);
    restoreSession(b, "h", { phase: "live", kind: "helper", stage: "helper" }, iso(NOW));
    same("kind kept, family from the restore", [b.sessions.h.kind, b.sessions.h.family], ["worker", "helper"]);
  }],
];

type Obs = { id: string; phase: "live" | "ended"; role?: string; stage?: string; ticket?: string; startedAt?: string; kind?: "worker" | "helper" | "coordinator" };
const RESTART_OPTS = { kitchen: "k", now: iso(NOW + 100), backup: "/x/backups/crew-2" };

/** The last run: four testers hold every tester character, a fifth is overflow, a developer on pepper, the coordinator. */
function prevRun(): CrewBook {
  const b = migrateLegacy({}, {}, null, OPTS);
  reconcileAfterRestore(b, [], iso(NOW));
  ["A", "B", "C", "D"].forEach((tk, i) => startSession(b, `t${i + 1}`, { role: "tester", stage: "review", ticket: tk }, iso(NOW - 100_000 + i * 1000)));
  startSession(b, "o1", { role: "tester", stage: "review", ticket: "E" }, iso(NOW - 95_000));
  startSession(b, "p1", { role: "developer", stage: "implementation", ticket: "A" }, iso(NOW - 94_000));
  startSession(b, "coordinator:c1", { kind: "coordinator", stage: "coordinate" }, iso(NOW - 200_000));
  return b;
}
/** What the restart observes. t4 is not seen at all (transcript gone). */
const RESTART_OBS: Obs[] = [
  { id: "t1", phase: "ended" },
  { id: "t2", phase: "ended" },
  { id: "t3", phase: "live" },
  { id: "o1", phase: "live" },
  { id: "p1", phase: "ended" },
  { id: "n1", phase: "live", role: "tester", stage: "review", ticket: "B", startedAt: iso(NOW + 50) },
  { id: "n2", phase: "live", role: "tester", stage: "review", ticket: "X" }, // no start time: takes the reconcile time
  { id: "n3", phase: "live", role: "developer", stage: "resume", ticket: "A", startedAt: iso(NOW + 45) },
];
const RESTART_EXPECTED = { "coordinator:c1": "basil", n1: "dot", n2: "dash", n3: "pepper", o1: null, t3: "blip" };
function restart(obs: Obs[]): CrewBook {
  const b = migrateLegacy({}, {}, prevRun(), RESTART_OPTS);
  for (const { id, ...facts } of obs) restoreSession(b, id, facts, iso(NOW + 200));
  reconcileAfterRestore(b, ["t3", "o1", "n1", "n2", "n3", "coordinator:c1"], iso(NOW + 300));
  return b;
}
const allocationOf = (b: CrewBook) => Object.fromEntries(Object.values(b.sessions).filter((s) => s.phase === "live").map((s) => [s.id, s.characterId] as const).sort(([a], [c]) => (a < c ? -1 : 1)));
const seqOf = (b: CrewBook) => Object.fromEntries(Object.values(b.sessions).map((s) => [s.id, s.seq] as const).sort(([a], [c]) => (a < c ? -1 : 1)));
/** Characters worn by more than one live session. */
function liveSharing(b: CrewBook): string[] {
  const by = new Map<string, string[]>();
  for (const s of Object.values(b.sessions)) if (s.phase === "live" && s.characterId) by.set(s.characterId, [...(by.get(s.characterId) ?? []), s.id]);
  return [...by].filter(([, ids]) => ids.length > 1).map(([c, ids]) => `${c}: ${ids.join(",")}`);
}
/** Of `ids` (the sessions a restore pass recorded), the live ones with no character while their family has a free one. */
function detachedFresh(b: CrewBook, ids: string[]): string[] {
  if (b.restorePass) throw new Error("pass still open");
  return ids
    .map((id) => b.sessions[id])
    .filter((s) => s.phase === "live" && s.characterId === null)
    .filter((s) => s.family !== "orchestrator" && allocateCharacter(b, s.family, null) !== null)
    .map((s) => `${s.id} (${s.family})`);
}
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const go = (rest: number[], acc: number[]) => (rest.length ? rest.forEach((x, i) => go([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x])) : out.push(acc));
  go([...Array(n).keys()], []);
  return out;
}
function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
