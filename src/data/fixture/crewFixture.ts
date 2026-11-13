// Tin & Thyme · the crew lifecycle fixture (Feature 09, ticket 09.7).
//
// FIXTURE DATA ONLY. Nothing here reads a server, a transcript or ~/.controlroom, and nothing
// here is evidence about a live kitchen. Every book it builds is keyed CREW_FIXTURE_KITCHEN, and
// every session id carries an "fx" marker, so fixture data can't be mistaken for live data:
// worker and helper ids start with "fx" ("fx0001", "fxl0p"), and coordinator ids are
// "coordinator:fx-<name>", because the contract keys a coordinator `coordinator:<transcript name>`.
//
// It holds three things, all built on the 09.1 contract (src/data/crewContract.ts,
// docs/crew-contract.md) and changing none of it:
//   1. FixtureKitchen: a scripted kitchen on a fixed clock that changes its crew book only
//      through the contract's own functions;
//   2. invariant checks (crewBookProblems, crewHistoryProblems, crewSnapshotProblems) that work on
//      any book or snapshot, so 09.8 can run them against live data too;
//   3. CREW_SCENARIOS: one scenario per Feature 09 acceptance item, each returning its checks,
//      its final book and its snapshot. `crewBusyFixture()` is the busy scene for the UI tickets.
//
// Run them with `pnpm exec tsx scripts/crew-scenarios.ts`.

import type { ArtStyle } from "../../galley/backend";
import { CREW_CHARACTERS } from "../crew";
import {
  beginRestore, CHARACTER_FAMILY, compareSessionAge, COORDINATOR_CHARACTER, CREW_STATE_BADGE, CREW_STATES, crewColor, crewFloorChanges, crewName, crewOnFloor,
  crewTransitionKind, customizeCharacter, deriveCrewState, emptyCrewBook, endSession, FAMILY_POOLS, FAMILY_PRESENCE, familyFor, migrateLegacy, reconcileAfterRestore, restoreSession,
  retireCharacter, startSession,
  type CrewBook, type CrewCharacterId, type CrewCharacterRecord, type CrewCharacterView, type CrewObservation, type CrewOutcome, type CrewSession, type CrewSessionFacts,
  type CrewSessionView, type CrewSnapshot, type CrewState, type CrewTelemetry, type LegacyCrewJson, type LegacySessionsJson, type RoleFamily,
} from "../crewContract";
import type { SessionEnd } from "../types";

/** How any UI that shows this data must name it. */
export const CREW_FIXTURE_LABEL = "crew lifecycle fixture";
/** The kitchen key of every fixture book. No real kitchen key contains a colon. */
export const CREW_FIXTURE_KITCHEN = "fixture:crew-lifecycle";

/** Where a result came from. Feature 09 wants the three reported separately. */
export type CrewEvidence = "fixture" | "live" | "mock";

/** The fixture clock starts here and only moves when a scenario says so. */
export const CREW_FIXTURE_T0 = Date.parse("2026-11-13T09:00:00.000Z");
const at = (sec: number) => new Date(CREW_FIXTURE_T0 + sec * 1000).toISOString();
const ending = (outcome: CrewOutcome, sec: number, next: string | null = null): SessionEnd => ({ outcome, next, result: `fixture: ${outcome}`, at: at(sec) });

// ---------------------------------------------------------------- Snapshot projection

/**
 * A CrewSnapshot from a book and the observations of its live sessions, read off
 * docs/crew-contract.md ("Snapshot the UI reads"). 09.3 owns the real projection; this one exists so
 * the fixture can hand the UI tickets a snapshot and so the scenarios can check what a client
 * would see. Two readings of the doc are the fixture's own:
 *   - `stateSince` uses the after-restart rule, because a fixture keeps no poll history;
 *   - `lastOutcome` is the outcome of the character's latest ENDED session.
 */
export function crewFixtureSnapshot(book: CrewBook, observations: Record<string, CrewObservation>, now: number): CrewSnapshot {
  const sessions = Object.values(book.sessions);
  const view = (s: CrewSession): CrewSessionView => ({
    ...s,
    characterName: s.characterId ? crewName(s.characterId, book.characters[s.characterId]) : null,
    state: deriveCrewState(s, observations[s.id] ?? null, now),
  });
  const characters = Object.values(FAMILY_POOLS).flat().flatMap((id): CrewCharacterView[] => {
    const rec = book.characters[id];
    if (!rec) return [];
    const session = (rec.sessionId ? book.sessions[rec.sessionId] : null) ?? (rec.lastSessionId ? book.sessions[rec.lastSessionId] : null) ?? null;
    const obs = session ? observations[session.id] ?? null : null;
    const state = deriveCrewState(session, obs, now, id);
    const shown = state === "available" ? null : session;
    const badge = CREW_STATE_BADGE[state];
    const lastEnded = sessions.filter((s) => s.characterId === id && s.phase === "ended").sort((a, b) => b.seq - a.seq)[0] ?? null;
    return [{
      id,
      family: rec.family,
      name: crewName(id, rec),
      job: CREW_CHARACTERS[id].job,
      look: CREW_CHARACTERS[id].look,
      accent: crewColor(id, rec),
      customized: rec.name !== null || rec.color !== null,
      retired: rec.retired,
      state,
      stateSince: state === "available" ? rec.availableSince ?? rec.firstSeen : state === "finished" && session?.endedAt ? session.endedAt : new Date(now).toISOString(),
      badge: badge ? { kind: badge, reason: obs?.attention?.reason ?? null, ticket: shown?.ticket ?? null } : null,
      sessionId: shown?.id ?? null,
      ticket: shown?.ticket ?? null,
      stage: shown?.stage ?? null,
      role: shown?.role ?? null,
      telemetry: shown?.telemetry ?? null,
      lastOutcome: lastEnded?.end?.outcome ?? null,
    }];
  });
  const current = sessions.filter((s) => s.phase === "live").sort(compareSessionAge).map(view);
  const history = sessions
    .filter((s) => s.phase === "ended")
    .sort((a, b) => (Date.parse(b.endedAt ?? "") || 0) - (Date.parse(a.endedAt ?? "") || 0) || b.seq - a.seq)
    .map(view);
  return { version: book.version, characters, current, history, overflow: current.filter((s) => s.characterId === null).map((s) => s.id) };
}

// ---------------------------------------------------------------- Invariants (any book, fixture or live)

/**
 * What is wrong with a crew book, or [] when the contract's invariants hold: no character worn by
 * two live sessions, Basil worn only by the coordinator, families never borrowing, the record
 * caches agreeing with the sessions, and phases consistent with their endings.
 * `settled` (the default) also requires the restore pass to be closed, as it always is on disk.
 */
export function crewBookProblems(book: CrewBook, settled = true): string[] {
  const problems: string[] = [];
  const sessions = Object.values(book.sessions);
  const wearers = new Map<CrewCharacterId, CrewSession[]>();
  for (const s of sessions) if (s.phase === "live" && s.characterId) wearers.set(s.characterId, [...(wearers.get(s.characterId) ?? []), s]);
  for (const [id, live] of wearers) {
    if (live.length > 1) problems.push(`${id} is worn by ${live.length} live sessions (${live.map((s) => s.id).join(", ")})`);
    if (id === COORDINATOR_CHARACTER) for (const s of live) if (s.kind !== "coordinator") problems.push(`${s.kind} session ${s.id} wears basil`);
  }
  if (sessions.filter((s) => s.phase === "live" && s.kind === "coordinator").length > 1) problems.push("more than one live coordinator session");
  const seqs = new Set<number>();
  for (const [key, s] of Object.entries(book.sessions)) {
    if (key !== s.id) problems.push(`session ${s.id} is filed under ${key}`);
    if (seqs.has(s.seq)) problems.push(`seq ${s.seq} is used twice (${s.id})`);
    seqs.add(s.seq);
    if (s.phase === "live" && (s.endedAt !== null || s.end !== null)) problems.push(`live session ${s.id} has an ending`);
    if (s.phase === "ended" && s.endedAt === null && !s.legacy && s.end !== null) problems.push(`ended session ${s.id} has an outcome but no endedAt`);
    if (s.kind === "coordinator" && s.characterId !== COORDINATOR_CHARACTER) problems.push(`coordinator session ${s.id} does not wear basil`);
    if (!s.characterId) continue;
    if (!book.characters[s.characterId]) problems.push(`${s.characterId} has no record but session ${s.id} wears it`);
    if (!s.legacy && CHARACTER_FAMILY[s.characterId] !== s.family) problems.push(`${s.family} session ${s.id} wears ${s.characterId}, a ${CHARACTER_FAMILY[s.characterId]} character`);
  }
  if (!book.characters.basil) problems.push("basil has no record");
  for (const rec of Object.values(book.characters) as CrewCharacterRecord[]) {
    const live = wearers.get(rec.id) ?? [];
    if (rec.family !== CHARACTER_FAMILY[rec.id]) problems.push(`${rec.id} is recorded in family ${rec.family}`);
    if (rec.sessionId !== null && !live.some((s) => s.id === rec.sessionId)) problems.push(`${rec.id} caches session ${rec.sessionId}, which does not wear it live`);
    if (rec.sessionId === null && live.length) problems.push(`${rec.id} caches no session but ${live[0].id} wears it live`);
    if ((rec.availableSince === null) !== (live.length > 0)) problems.push(`${rec.id} availableSince disagrees with its live session`);
  }
  if (settled && book.restorePass !== null) problems.push("the restore pass is still open");
  return problems;
}

/**
 * What a later book lost or rewrote compared with an earlier one, or []. Session records are never
 * deleted or re-keyed; an ending, an outcome, a ticket link, a transcript path and frozen readings
 * are never changed; an ended session never goes live again; an unknown value (null) may be filled
 * later but a known one never changes. A character changes only with `reassignedFrom` set.
 */
export function crewHistoryProblems(before: CrewBook, after: CrewBook): string[] {
  const problems: string[] = [];
  const json = (v: unknown) => JSON.stringify(v);
  for (const was of Object.values(before.sessions)) {
    const is = after.sessions[was.id];
    if (!is) {
      problems.push(`session ${was.id} is gone`);
      continue;
    }
    if (is.kind !== was.kind) problems.push(`session ${was.id} changed kind`);
    if (was.phase === "ended" && is.phase !== "ended") problems.push(`ended session ${was.id} is live again`);
    if (is.characterId !== was.characterId && is.reassignedFrom !== was.characterId) problems.push(`session ${was.id} changed character ${was.characterId} -> ${is.characterId}`);
    for (const f of ["hqId", "role", "stage", "ticket", "title", "worktree", "parent", "transcript", "startedAt", "endedAt", "end", "report", "legacy"] as const) {
      if (was[f] !== null && json(is[f]) !== json(was[f])) problems.push(`session ${was.id} changed ${f}: ${json(was[f])} -> ${json(is[f])}`);
    }
    if (was.phase === "ended" && json(is.telemetry) !== json(was.telemetry)) problems.push(`ended session ${was.id} changed its frozen readings`);
  }
  for (const was of Object.values(before.characters) as CrewCharacterRecord[]) {
    const is = after.characters[was.id];
    if (!is) problems.push(`character ${was.id} is gone`);
    else if (is.name !== was.name || is.color !== was.color || is.firstSeen !== was.firstSeen) problems.push(`character ${was.id} changed name, colour or firstSeen`);
  }
  if (after.migrations.length < before.migrations.length) problems.push("a migration entry is gone");
  return problems;
}

/**
 * What is wrong with a snapshot of `book`, or []. It works on any projection, the fixture's or the
 * real one (09.3), so a ticket that changes how a snapshot is built can run it unchanged:
 *   - a character listed twice or with no record, a repeated or numbered name, a name, colour,
 *     family, customized or retired flag that disagrees with the character's record;
 *   - a badge that disagrees with the state;
 *   - a character that shows a session which is not in the book or does not wear it;
 *   - a character whose ticket, stage, role, readings or badge ticket are not exactly those of the
 *     session it shows (all null when it shows none). This is the reuse defect: a character on a
 *     fresh session still showing the last session's ticket or readings;
 *   - a session listed with any field that differs from the book's record, or under a character
 *     name that is not its own character's (null for overflow);
 *   - a session missing from current + history, listed twice or in the wrong list, a live session
 *     not shown on its own character, an overflow list that disagrees.
 * `book` is the book the snapshot was built from: every comparison is against its records.
 * It needs no observations, so it can't check `state` beyond the badge, or `stateSince`.
 */
export function crewSnapshotProblems(snap: CrewSnapshot, book: CrewBook): string[] {
  const problems: string[] = [];
  const json = (v: unknown) => JSON.stringify(v ?? null);
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const c of snap.characters) {
    if (ids.has(c.id)) problems.push(`${c.id} is listed twice`);
    ids.add(c.id);
    const n = c.name.trim().toLowerCase();
    if (names.has(n)) problems.push(`${c.id} and ${names.get(n)} share the name ${c.name}`);
    names.set(n, c.id);
    if (/\d$/.test(n)) problems.push(`${c.id} has the numbered name ${c.name}`);
    if (!/^#[0-9a-f]{6}$/.test(c.accent)) problems.push(`${c.id} has no colour`);
    const rec = book.characters[c.id];
    if (!rec) problems.push(`${c.id} is listed but has no record`);
    else {
      if (c.name !== crewName(c.id, rec)) problems.push(`${c.id} is named ${c.name}, but its record says ${crewName(c.id, rec)}`);
      if (c.accent !== crewColor(c.id, rec)) problems.push(`${c.id} is drawn in ${c.accent}, but its record says ${crewColor(c.id, rec)}`);
      if (c.family !== rec.family) problems.push(`${c.id} is listed in family ${c.family}, but its record says ${rec.family}`);
      if (c.customized !== (rec.name !== null || rec.color !== null)) problems.push(`${c.id} customized flag disagrees with its record`);
      if (c.retired !== rec.retired) problems.push(`${c.id} retired flag disagrees with its record`);
    }
    if ((c.badge?.kind ?? null) !== CREW_STATE_BADGE[c.state]) problems.push(`${c.id} is ${c.state} but its badge is ${c.badge?.kind ?? "none"}`);
    if (c.state === "available" && c.sessionId) problems.push(`${c.id} is available but still shows session ${c.sessionId}`);
    const shown = c.sessionId ? book.sessions[c.sessionId] ?? null : null;
    if (c.sessionId && !shown) problems.push(`${c.id} shows session ${c.sessionId}, which is not in the book`);
    if (shown && shown.characterId !== c.id) problems.push(`${c.id} shows session ${c.sessionId}, which does not wear it`);
    const of = shown ? `session ${shown.id}` : "no session";
    for (const f of ["ticket", "stage", "role", "telemetry"] as const) {
      if (json(c[f]) !== json(shown?.[f])) problems.push(`${c.id} shows ${of} but its ${f} is ${json(c[f])}, not ${json(shown?.[f])}`);
    }
    if (c.badge && json(c.badge.ticket) !== json(shown?.ticket)) problems.push(`${c.id} shows ${of} but its badge names ticket ${json(c.badge.ticket)}, not ${json(shown?.ticket)}`);
  }
  const listed = new Set<string>();
  for (const s of snap.current) {
    if (s.phase !== "live") problems.push(`current lists ended session ${s.id}`);
    if (s.characterId && snap.characters.find((c) => c.id === s.characterId)?.sessionId !== s.id) problems.push(`live session ${s.id} is not shown on ${s.characterId}`);
    if ((s.characterId === null) !== snap.overflow.includes(s.id)) problems.push(`overflow list disagrees for session ${s.id}`);
  }
  for (const s of snap.history) if (s.phase !== "ended") problems.push(`history lists live session ${s.id}`);
  for (const s of [...snap.current, ...snap.history]) {
    if (listed.has(s.id)) problems.push(`session ${s.id} is listed twice`);
    listed.add(s.id);
    const rec = book.sessions[s.id];
    if (!rec) {
      problems.push(`session ${s.id} is listed but is not in the book`);
      continue;
    }
    for (const f of Object.keys(rec) as (keyof CrewSession)[]) {
      if (json(s[f]) !== json(rec[f])) problems.push(`session ${s.id} is listed with ${f} ${json(s[f])}, but the book says ${json(rec[f])}`);
    }
    const name = rec.characterId ? crewName(rec.characterId, book.characters[rec.characterId]) : null;
    if (s.characterName !== name) problems.push(`session ${s.id} is listed under the character name ${json(s.characterName)}, but ${rec.characterId ?? "overflow"} is ${json(name)}`);
  }
  for (const id of Object.keys(book.sessions)) if (!listed.has(id)) problems.push(`session ${id} is in neither current nor history`);
  for (const id of snap.overflow) if (!snap.current.some((s) => s.id === id)) problems.push(`overflow names ${id}, which is not a current session`);
  return problems;
}

/** A book as text that ignores key order and `updatedAt`, for "the same book whatever the order". */
export function canonicalCrewBook(book: CrewBook): string {
  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ ...book, updatedAt: "", characters: sorted(book.characters as Record<string, CrewCharacterRecord>), sessions: sorted(book.sessions) });
}

// ---------------------------------------------------------------- The scripted kitchen

/** What the fixture says the server observed for a session on the current poll. */
export type FixtureSight = "starting" | "no-tools" | "working" | "idle" | "needs-input" | "stopped" | "failed";

const SIGHT: Record<FixtureSight, Pick<CrewObservation, "session" | "agent" | "tools">> = {
  starting: { session: "starting", agent: "idle", tools: 0 },
  // The process is running and the agent is busy, but it has made no tool call yet.
  "no-tools": { session: "running", agent: "working", tools: 0 },
  working: { session: "running", agent: "working", tools: 4 },
  idle: { session: "running", agent: "idle", tools: 4 },
  "needs-input": { session: "running", agent: "needs-input", tools: 4 },
  stopped: { session: "stopped", agent: "idle", tools: 4 },
  failed: { session: "failed", agent: "idle", tools: 4 },
};

/**
 * A scripted kitchen on the fixture clock. It changes its book only through the contract
 * (startSession, endSession, retireCharacter), checks the book's invariants after every change and
 * keeps what it finds in `violations`. The one field it writes by hand is `CrewSession.telemetry`:
 * the contract has no function for readings (09.6 owns that write path).
 */
export class FixtureKitchen {
  readonly book: CrewBook = emptyCrewBook(CREW_FIXTURE_KITCHEN, at(0));
  readonly observations: Record<string, CrewObservation> = {};
  /** Problems crewBookProblems found after any step, with the step that caused them. */
  readonly violations: string[] = [];
  /** How many book changes were checked. */
  steps = 0;
  /** Problems crewSnapshotProblems found in any snapshot this kitchen took, with its number and time. */
  readonly snapshotViolations: string[] = [];
  /** How many snapshots were taken and checked. */
  snapshots = 0;
  /** Seconds since CREW_FIXTURE_T0. */
  clock = 0;
  private count = 0;
  /** Sessions the server has lost sight of: their observation is no longer re-read on a poll. */
  private readonly lost = new Set<string>();

  get now(): number {
    return CREW_FIXTURE_T0 + this.clock * 1000;
  }
  get iso(): string {
    return at(this.clock);
  }
  tick(sec: number): this {
    this.clock += sec;
    return this;
  }

  private audit(step: string): void {
    this.steps += 1;
    for (const p of crewBookProblems(this.book)) this.violations.push(`after ${step}: ${p}`);
  }

  /** The coordinator's session, keyed as the contract says: `coordinator:<transcript name>`. */
  coordinator(name = "fx-main"): CrewSession {
    const s = startSession(this.book, `coordinator:${name}`, { kind: "coordinator", hqId: "coordinator", role: "orchestrator", stage: "coordinate", transcript: `/fixture/${name}.jsonl` }, this.iso);
    this.see(s.id, "working");
    this.audit(`coordinator ${name}`);
    return s;
  }

  /** A brief worker for one stage of one ticket. The role defaults to the stage's family. */
  worker(stage: string, ticket: string, role?: string): CrewSession {
    const id = `fx${String(++this.count).padStart(4, "0")}`;
    const family = familyFor(null, stage);
    const s = startSession(this.book, id, this.facts(id, stage, ticket, role ?? (family === "unknown" ? null : family)), this.iso);
    this.see(id, "working");
    this.audit(`start ${stage} ${ticket}`);
    return s;
  }

  /** A non-brief subagent of `parent`. */
  helper(parent: CrewSession): CrewSession {
    const id = `fx${String(++this.count).padStart(4, "0")}`;
    const s = startSession(this.book, id, { kind: "helper", hqId: id, stage: "helper", parent: parent.hqId, transcript: `/fixture/${id}.jsonl` }, this.iso);
    this.see(id, "working");
    this.audit("start helper");
    return s;
  }

  /** The facts a brief gives for a worker session, shaped like the live ones. */
  facts(id: string, stage: string, ticket: string, role: string | null): CrewSessionFacts {
    return { kind: "worker", hqId: `w-${ticket}-${stage}-${id}`, role, stage, ticket, title: `Fixture ticket ${ticket}`, worktree: `.pathfinder/worktrees/${ticket}`, transcript: `/fixture/${id}.jsonl` };
  }

  /** What the server observes for a session from now on. `attention` is Feature 06's verdict. */
  see(id: string, sight: FixtureSight, attention: CrewObservation["attention"] = null): void {
    this.lost.delete(id);
    this.observations[id] = { ...SIGHT[sight], attention, at: this.iso };
  }

  /** The server loses sight of a session: its last reading stays, and ages. */
  lose(id: string): void {
    this.lost.add(id);
  }

  /** Readings for a session. Written by hand: see the class comment. */
  readings(id: string, t: Omit<CrewTelemetry, "at">): void {
    this.book.sessions[id].telemetry = { ...t, at: this.iso };
  }

  /** Ends a session with Pathfinder's recorded outcome, or null for "outcome unknown". */
  end(id: string, outcome: CrewOutcome | null, next: string | null = null): void {
    endSession(this.book, id, outcome ? ending(outcome, this.clock, next) : null, this.iso);
    delete this.observations[id];
    this.audit(`end ${id}`);
  }

  retire(id: CrewCharacterId, retired: boolean): void {
    retireCharacter(this.book, id, retired, this.iso);
    this.audit(`${retired ? "retire" : "un-retire"} ${id}`);
  }

  /** Renames or recolours a character through the contract's one write path. Returns its refusal, or null. */
  customize(id: CrewCharacterId, change: { name?: string | null; color?: string | null }): string | null {
    const refused = customizeCharacter(this.book, id, change, this.iso);
    this.audit(`customize ${id}`);
    return refused;
  }

  /**
   * One poll: every session still in sight is read again (its `at` is now), then the snapshot is
   * built and checked with crewSnapshotProblems, so a stale ticket or reading on a reused character
   * is caught on the poll that shows it, not only in a scenario's last snapshot.
   */
  snapshot(): CrewSnapshot {
    for (const [id, o] of Object.entries(this.observations)) if (!this.lost.has(id)) o.at = this.iso;
    const snap = crewFixtureSnapshot(this.book, this.observations, this.now);
    this.snapshots += 1;
    for (const p of crewSnapshotProblems(snap, this.book)) this.snapshotViolations.push(`snapshot ${this.snapshots} at +${this.clock}s: ${p}`);
    return snap;
  }
}

// ---------------------------------------------------------------- Scenarios

export interface CrewCheck {
  label: string;
  ok: boolean;
  /** What was seen instead, when the check failed. */
  detail: string | null;
}

export interface CrewScenarioOutcome {
  checks: CrewCheck[];
  /** Parts of the acceptance item this fixture can't decide, and who can. Reported, never passed. */
  notCovered: string[];
  /** The final book and snapshot, for a UI ticket that wants to draw the scenario. */
  book: CrewBook;
  snapshot: CrewSnapshot;
}

/**
 * The fixture items of Feature 09's acceptance, in its words, plus the fixture rehearsals of its
 * live and Settings items. A bracket says how much of the item a fixture can decide; the rest is
 * listed by each scenario as not covered, with its owner.
 */
export const CREW_FIXTURE_ACCEPTANCE = {
  concurrent: "2 developers + 2 testers + 2 adversaries together",
  reuse: "finish → relax → a fresh session on the same character, with no stale ticket or readings",
  gate: "a human gate while others run",
  "coordinator-waiting": "a coordinator waiting with no false badge",
  endings: "interrupted and failed sessions",
  "rapid-handoffs": "rapid handoffs and overlapping arrivals",
  overflow: "more sessions than stations or seats (data only: more sessions than characters; the station and seat layout is 09.5)",
  presentation: "both art styles, reduced motion, and sound on and off (data only)",
  restart: "a restart or reconnect with no duplicate crew, replayed arrivals, lost history or session launch (fixture rehearsal of the live item)",
  team: "Settings → Team shows roles, crew, current sessions and history, with no repeated editable rows (crew data only: roles are Feature 07, the Settings page is 09.4)",
} as const;
export type CrewAcceptanceId = keyof typeof CREW_FIXTURE_ACCEPTANCE;

/** Feature 09's live acceptance. Listed by the runner, never run here: 09.8 owns the live run. */
export const CREW_LIVE_ACCEPTANCE: readonly { id: string; text: string; owner: string }[] = [
  { id: "live-concurrent", text: "two concurrent developers and two concurrent testers, in an isolated Pathfinder repo", owner: "09.8" },
  { id: "live-reuse", text: "a character reused for a fresh session", owner: "09.8" },
  { id: "live-restart", text: "a restart or reconnect with no duplicate crew, replayed arrivals, lost history or session launch", owner: "09.8" },
];

export interface CrewScenario {
  id: string;
  title: string;
  /** Always "fixture": nothing in this file is live or mock evidence. */
  evidence: Extract<CrewEvidence, "fixture">;
  covers: CrewAcceptanceId[];
  /** Families this scenario shows that the installed kit can't run live (FAMILY_PRESENCE). */
  fixtureOnlyFamilies: RoleFamily[];
  run(): CrewScenarioOutcome;
}

class Checks {
  readonly list: CrewCheck[] = [];
  same(label: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    this.list.push({ label, ok: a === e, detail: a === e ? null : `got ${a}, expected ${e}` });
  }
  none(label: string, problems: string[]): void {
    this.list.push({ label, ok: problems.length === 0, detail: problems.length ? problems.join("; ") : null });
  }
}

/** Closes a scenario with the checks every one of them owes: invariants at every step, a sound final book and snapshot. */
function close(k: FixtureKitchen, c: Checks, notCovered: string[] = []): CrewScenarioOutcome {
  const snapshot = k.snapshot();
  c.none(`no character shared by two live sessions, at any of ${k.steps} steps`, k.violations);
  c.none(`every snapshot taken (${k.snapshots}) shows each character with its own session's ticket, stage, role and readings`, k.snapshotViolations);
  c.none("final book holds the contract invariants", crewBookProblems(k.book));
  c.none("final snapshot: no repeated or numbered name, every session in current or history", crewSnapshotProblems(snapshot, k.book));
  return { checks: c.list, notCovered, book: k.book, snapshot };
}

/** What the two scenarios that cover the Settings → Team item leave open. */
const TEAM_NOT_COVERED = [
  "Settings → Team: the role contracts it shows (roles are read from roles/<role>.md: Feature 07)",
  "Settings → Team: the page itself, that crew, current sessions and history are drawn with no repeated editable rows (visual, 09.4); only the crew data behind it is checked here",
];

const who = (snap: CrewSnapshot, id: CrewCharacterId) => snap.characters.find((c) => c.id === id) ?? null;
const states = (snap: CrewSnapshot) => Object.fromEntries(snap.characters.map((c) => [c.id, c.state]));
const needsYou = (snap: CrewSnapshot) => snap.characters.filter((c) => c.badge?.kind === "needs-you").map((c) => c.id);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The busy scene: the coordinator waiting on workers, 2 developers, 2 testers and 2 adversaries
 * live together, a helper, one overflow session, one cook just finished and one relaxing. Every
 * lifecycle state appears once or more, so a UI ticket can draw all seven from one snapshot.
 * Adversaries are fixture-only: this kit has no adversary role or stage.
 */
export function crewBusyFixture(): { kitchen: FixtureKitchen; sessions: Record<string, CrewSession>; snapshot: CrewSnapshot } {
  const k = new FixtureKitchen();
  const coordinator = k.coordinator();
  k.tick(5);
  const dev1 = k.worker("implementation", "07.2");
  const dev2 = k.worker("implementation", "08.1");
  const dev3 = k.worker("implementation", "06.3");
  const dev4 = k.worker("repair", "05.2");
  k.tick(5);
  const test1 = k.worker("review", "07.1");
  const test2 = k.worker("review", "08.2");
  const adv1 = k.worker("adversary", "07.3");
  const adv2 = k.worker("adversary", "08.3");
  const helper = k.helper(coordinator);
  const lead = k.worker("implementation", "09.9", "lead"); // orchestrator family, and Basil is reserved: overflow
  k.readings(dev1.id, { context: { used: 124_000, limit: 200_000 }, model: { model: "claude-sonnet-5-5", effort: "medium", source: "observed" }, tokens: { input: 88_000, output: 9_400 }, costUsd: null, tools: 11 });
  k.readings(test1.id, { context: null, model: { model: "claude-haiku-5-5", effort: null, source: "configured" }, tokens: null, costUsd: null, tools: null });
  k.tick(10);
  k.end(dev4.id, "handed-off", "review");
  k.tick(38);
  k.end(dev3.id, "handed-off", "review");
  k.tick(2);
  k.see(coordinator.id, "idle", { kind: "waiting", reason: "waiting on workers" });
  k.see(dev2.id, "needs-input", { kind: "needs-you", reason: "08.1 gate" });
  k.see(test2.id, "starting");
  k.see(adv2.id, "failed");
  return { kitchen: k, sessions: { coordinator, dev1, dev2, dev3, dev4, test1, test2, adv1, adv2, helper, lead }, snapshot: k.snapshot() };
}

function concurrent(): CrewScenarioOutcome {
  const c = new Checks();
  const { kitchen: k, sessions: s, snapshot } = crewBusyFixture();
  const live = snapshot.current;
  const liveIn = (f: RoleFamily) => live.filter((x) => x.family === f).map((x) => x.characterId);
  c.same("2 developers live together, on distinct characters", liveIn("developer"), ["pepper", "roux"]);
  c.same("2 testers live together, on distinct characters", liveIn("tester"), ["dash", "dot"]);
  c.same("2 adversaries live together, on distinct characters", liveIn("adversary"), ["pinch", "tang"]);
  c.same("adversaries are stated fixture-only by the contract", FAMILY_PRESENCE.adversary, "fixture-only");
  c.same("the coordinator wears basil and the helper a helper character", [s.coordinator.characterId, s.helper.characterId], ["basil", "whisk"]);
  c.same("each character shows its own state", states(snapshot), {
    pepper: "working", roux: "needs-you", ember: "finished", sprig: "available", dash: "working", dot: "assigned", pinch: "working", tang: "unknown", basil: "waiting", whisk: "working",
  });
  c.same("every lifecycle state appears in the busy scene", CREW_STATES.filter((st) => !snapshot.characters.some((ch) => ch.state === st)), []);
  c.same("the one session with no free character is overflow, with no robot", [snapshot.overflow, s.lead.characterId], [[s.lead.id], null]);
  c.same("an unread value stays null, never 0", k.book.sessions[s.test1.id].telemetry, { context: null, model: { model: "claude-haiku-5-5", effort: null, source: "configured" }, tokens: null, costUsd: null, tools: null, at: at(10) });
  c.same("a session with no readings shows none", who(snapshot, "tang")?.telemetry ?? null, null);
  return close(k, c);
}

function reuse(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  k.coordinator();
  k.tick(5);
  const a = k.worker("implementation", "07.2");
  const x = k.worker("implementation", "08.1");
  const readings = { context: { used: 151_000, limit: 200_000 }, model: { model: "claude-sonnet-5-5", effort: "medium", source: "observed" as const }, tokens: { input: 90_000, output: 12_000 }, costUsd: null, tools: 14 };
  k.readings(a.id, readings);
  k.tick(55);
  k.end(a.id, "handed-off", "review");
  k.tick(1);
  const finished = who(k.snapshot(), "pepper");
  c.same("finish: pepper holds the handoff pose on the session it just ended", [finished?.state, finished?.sessionId, finished?.ticket], ["finished", a.id, "07.2"]);
  k.tick(9);
  const relaxed = who(k.snapshot(), "pepper");
  c.same("relax: pepper is available with no ticket, session, readings or badge", [relaxed?.state, relaxed?.sessionId, relaxed?.ticket, relaxed?.stage, relaxed?.telemetry, relaxed?.badge], ["available", null, null, null, null, null]);
  c.same("relax: the real outcome is remembered", relaxed?.lastOutcome, "handed-off");
  k.tick(50);
  const b = k.worker("implementation", "09.4");
  k.see(b.id, "starting");
  const freshSnap = k.snapshot();
  const fresh = who(freshSnap, "pepper");
  c.same("fresh session: a new session id on the same character", [b.characterId, b.id !== a.id, b.transcript !== a.transcript, b.startedAt], ["pepper", true, true, at(120)]);
  c.same("fresh session: the new ticket and no stale readings", [fresh?.state, fresh?.sessionId, fresh?.ticket, fresh?.telemetry, fresh?.badge], ["assigned", b.id, "09.4", null, { kind: "starting", reason: null, ticket: "09.4" }]);
  c.none("fresh session: the shared snapshot check finds nothing of the finished session on pepper", crewSnapshotProblems(freshSnap, k.book));
  k.see(b.id, "no-tools");
  const noTools = who(k.snapshot(), "pepper");
  k.see(b.id, "working");
  c.same("a running session with no tool call yet is still assigned, and working after its first", [noTools?.state, noTools?.badge?.kind, who(k.snapshot(), "pepper")?.state], ["assigned", "starting", "working"]);
  c.same("history keeps the finished session, its ticket and its frozen readings", [k.book.sessions[a.id].phase, k.book.sessions[a.id].ticket, k.book.sessions[a.id].telemetry], ["ended", "07.2", { ...readings, at: at(5) }]);
  k.tick(80);
  k.end(b.id, "handed-off", "review");
  k.tick(1);
  const d = k.worker("implementation", "06.3");
  k.see(d.id, "starting");
  const taken = who(k.snapshot(), "pepper");
  c.same("a fresh session takes a just-finished character at once; the linger is animation only", [d.characterId, taken?.state, taken?.sessionId, crewTransitionKind("finished", "assigned")], ["pepper", "assigned", d.id, "animate"]);
  k.tick(9);
  k.end(x.id, "handed-off", "review");
  k.tick(90);
  k.end(d.id, "handed-off", "review");
  const repair = k.worker("repair", "08.1");
  c.same("a repair goes back to the cook who built the ticket, though pepper is first in the pool", repair.characterId, "roux");
  const snap = k.snapshot();
  c.same("Team data: one pepper row, three pepper sessions in history", [snap.characters.filter((ch) => ch.id === "pepper").length, snap.history.filter((h) => h.characterId === "pepper").map((h) => h.ticket)], [1, ["06.3", "09.4", "07.2"]]);
  c.same("one live session per character", snap.current.map((s) => s.characterId), ["basil", "roux"]);
  return close(k, c, TEAM_NOT_COVERED);
}

function gate(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  k.coordinator();
  k.tick(5);
  const dev1 = k.worker("implementation", "07.2");
  const dev2 = k.worker("implementation", "08.1");
  const test = k.worker("review", "07.1");
  k.tick(25);
  k.see(dev2.id, "needs-input", { kind: "needs-you", reason: "08.1 gate" });
  let snap = k.snapshot();
  c.same("the gated worker shows needs-you, naming the reason and the ticket", [who(snap, "roux")?.state, who(snap, "roux")?.badge], ["needs-you", { kind: "needs-you", reason: "08.1 gate", ticket: "08.1" }]);
  c.same("the others keep running, with no badge", [who(snap, "pepper")?.state, who(snap, "pepper")?.badge, who(snap, "dash")?.state, who(snap, "dash")?.badge], ["working", null, "working", null]);
  c.same("exactly one needs-you badge in the kitchen", needsYou(snap), ["roux"]);
  k.tick(10);
  k.see(dev1.id, "needs-input");
  snap = k.snapshot();
  c.same("needs-input that Feature 06 has not confirmed is waiting, never pink", [who(snap, "pepper")?.state, who(snap, "pepper")?.badge?.kind, needsYou(snap)], ["waiting", "waiting", ["roux"]]);
  k.see(dev1.id, "working");
  k.see(dev2.id, "stopped", { kind: "needs-you", reason: "08.1 gate" });
  c.same("a worker whose process stopped at a real gate is still a gate", who(k.snapshot(), "roux")?.state, "needs-you");
  k.tick(10);
  k.end(dev2.id, "gate");
  k.tick(1);
  snap = k.snapshot();
  c.same("the session ends with the gate outcome, kept distinct from the others", [who(snap, "roux")?.state, snap.history[0]?.id, snap.history[0]?.end?.outcome], ["finished", dev2.id, "gate"]);
  c.same("the other sessions are still live", snap.current.map((s) => s.id), [k.book.sessions["coordinator:fx-main"].id, dev1.id, test.id]);
  k.tick(9);
  snap = k.snapshot();
  c.same("after the handoff pose the character is available and remembers the gate", [who(snap, "roux")?.state, who(snap, "roux")?.lastOutcome, who(snap, "roux")?.badge], ["available", "gate", null]);
  return close(k, c);
}

function coordinatorWaiting(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  let snap = k.snapshot();
  c.same("before a coordinator session is recorded, basil is unknown, never available", [who(snap, "basil")?.state, who(snap, "basil")?.badge?.kind, snap.current.length], ["unknown", "unknown", 0]);
  const first = k.coordinator();
  k.see(first.id, "starting");
  c.same("a starting coordinator keeps the starting badge", [who(k.snapshot(), "basil")?.state, who(k.snapshot(), "basil")?.badge?.kind], ["assigned", "starting"]);
  k.tick(5);
  const dev = k.worker("implementation", "07.2");
  const test = k.worker("review", "07.1");
  k.tick(20);
  k.see(first.id, "idle", { kind: "waiting", reason: "waiting on workers" });
  snap = k.snapshot();
  c.same("waiting on workers shows the waiting badge with its reason", [who(snap, "basil")?.state, who(snap, "basil")?.badge], ["waiting", { kind: "waiting", reason: "waiting on workers", ticket: null }]);
  c.same("no needs-you badge anywhere while the coordinator only waits", needsYou(snap), []);
  c.same("the workers it waits on are shown working", [who(snap, "pepper")?.state, who(snap, "dash")?.state], ["working", "working"]);
  k.see(first.id, "needs-input");
  snap = k.snapshot();
  c.same("an unconfirmed needs-input coordinator is waiting, not needs-you", [who(snap, "basil")?.state, who(snap, "basil")?.badge, needsYou(snap)], ["waiting", { kind: "waiting", reason: null, ticket: null }, []]);
  k.see(first.id, "idle", { kind: "waiting", reason: "waiting on workers" });
  k.tick(3600);
  c.same("a wait re-read on every poll stays waiting after an hour", who(k.snapshot(), "basil")?.state, "waiting");
  k.lose(first.id);
  k.tick(121);
  snap = k.snapshot();
  c.same("a coordinator the server lost sight of is unknown, never idle or working", [who(snap, "basil")?.state, who(snap, "basil")?.badge?.kind, who(snap, "pepper")?.state], ["unknown", "unknown", "working"]);
  const second = k.coordinator("fx-second");
  snap = k.snapshot();
  c.same("a new coordinator session takes basil and the old one ends with its outcome unknown", [second.characterId, k.book.sessions[first.id].phase, k.book.sessions[first.id].end, snap.characters.filter((ch) => ch.id === "basil").length], ["basil", "ended", null, 1]);
  c.same("the workers are untouched by the coordinator change", [k.book.sessions[dev.id].characterId, k.book.sessions[test.id].characterId, k.book.sessions[dev.id].phase], ["pepper", "dash", "live"]);
  return close(k, c);
}

function endings(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  k.coordinator();
  k.tick(5);
  const handed = k.worker("implementation", "07.2");
  const gated = k.worker("implementation", "08.1");
  const failed = k.worker("implementation", "06.3");
  const interrupted = k.worker("resume", "05.2");
  const silent = k.worker("review", "07.1");
  const broken = k.worker("implementation", "09.9");
  const blank = { context: null, model: null, tokens: null, costUsd: null, tools: null };
  k.readings(failed.id, blank);
  k.tick(55);
  k.end(handed.id, "handed-off", "review");
  k.end(gated.id, "gate");
  k.end(failed.id, "failed");
  k.end(interrupted.id, "interrupted");
  k.end(silent.id, null);
  k.see(broken.id, "failed");
  k.tick(2);
  let snap = k.snapshot();
  const outcome = (id: string) => k.book.sessions[id].end?.outcome ?? null;
  c.same("the four outcomes stay distinct in history", [handed, gated, failed, interrupted].map((s) => outcome(s.id)), ["handed-off", "gate", "failed", "interrupted"]);
  c.same("a session that ended with no recorded outcome stays unknown, not interrupted", [k.book.sessions[silent.id].phase, k.book.sessions[silent.id].end, who(snap, "dash")?.lastOutcome], ["ended", null, null]);
  c.same("each character remembers its own last outcome", (["pepper", "roux", "ember", "sprig"] as const).map((id) => who(snap, id)?.lastOutcome), ["handed-off", "gate", "failed", "interrupted"]);
  c.same("a live session whose process failed is unknown, never available or working", [who(snap, "crumb")?.state, who(snap, "crumb")?.badge?.kind, k.book.sessions[broken.id].phase], ["unknown", "unknown", "live"]);
  c.same("readings that were never available are frozen as null, never 0", k.book.sessions[failed.id].telemetry, { ...blank, at: at(5) });
  c.same("all five finished sessions are in history", snap.history.map((h) => h.id).sort(), [handed, gated, failed, interrupted, silent].map((s) => s.id).sort());
  const before = clone(k.book);
  k.tick(10);
  endSession(k.book, failed.id, ending("handed-off", k.clock), k.iso);
  startSession(k.book, failed.id, k.facts(failed.id, "implementation", "06.3", "developer"), k.iso);
  c.same("an ended session is never revived and its outcome never rewritten", [k.book.sessions[failed.id].phase, outcome(failed.id), k.book.sessions[failed.id].endedAt], ["ended", "failed", at(60)]);
  const retry = k.worker("repair", "06.3");
  snap = k.snapshot();
  c.same("a fresh repair session reuses the cook that failed, as a new session", [retry.characterId, retry.id !== failed.id, who(snap, "ember")?.sessionId, who(snap, "ember")?.lastOutcome], ["ember", true, retry.id, "failed"]);
  c.none("nothing in history was lost or rewritten by the later sessions", crewHistoryProblems(before, k.book));
  return close(k, c);
}

function rapidHandoffs(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  k.coordinator();
  const tickets = ["07.2", "08.1", "09.4"];
  const stages = ["implementation", "review", "repair", "review"];
  const worn: Record<string, (CrewCharacterId | null)[]> = Object.fromEntries(tickets.map((t) => [t, []]));
  const liveOn: Record<string, CrewSession | null> = Object.fromEntries(tickets.map((t) => [t, null]));
  const arrivals: CrewCharacterId[][] = [];
  const departures: CrewCharacterId[][] = [];
  const replays: number[] = [];
  let prev = k.snapshot();
  for (const stage of stages) {
    k.tick(1);
    // Every ticket hands off in the same second: the old session ends and the next starts at one instant.
    for (const t of tickets) {
      const old = liveOn[t];
      if (old) k.end(old.id, "handed-off", stage);
      liveOn[t] = k.worker(stage, t);
      worn[t].push(liveOn[t]!.characterId);
    }
    const next = k.snapshot();
    // The floor change of THIS handoff: the snapshot before it against the snapshot after it.
    const change = crewFloorChanges(prev, next);
    arrivals.push(change.arrivals);
    departures.push(change.departures);
    replays.push(crewFloorChanges(next, k.snapshot()).arrivals.length);
    prev = next;
  }
  c.same("three sessions arriving in one instant get three distinct cooks, then three distinct testers", arrivals.slice(0, 2), [["pepper", "roux", "ember"], ["dash", "dot", "blip"]]);
  c.same("each arrival is announced once, and later handoffs to characters on the floor announce none", [arrivals.slice(2), replays], [[[], []], [0, 0, 0, 0]]);
  c.same("each repair returns to the cook that built the ticket, each re-review to its tester", worn, {
    "07.2": ["pepper", "dash", "pepper", "dash"], "08.1": ["roux", "dot", "roux", "dot"], "09.4": ["ember", "blip", "ember", "blip"],
  });
  const snap = k.snapshot();
  c.same("twelve worker sessions in four seconds: three live beside the coordinator, nine in history, all handed off", [snap.current.length, snap.history.length, snap.history.every((h) => h.end?.outcome === "handed-off")], [4, 9, true]);
  const live = liveOn["07.2"]!;
  const count = Object.keys(k.book.sessions).length;
  const again = startSession(k.book, live.id, k.facts(live.id, "review", "07.2", "tester"), k.iso);
  c.same("a session reported twice is one session: no second allocation, no new record", [again === k.book.sessions[live.id], again.characterId, Object.keys(k.book.sessions).length], [true, "dash", count]);
  c.same("a handoff never beams a robot out: no departure at any of the four handoffs, though every character changes session", departures, [[], [], [], []]);
  return close(k, c);
}

function overflow(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  k.coordinator();
  k.tick(5);
  const devs = Array.from({ length: 8 }, (_, i) => k.worker("implementation", `10.${i + 1}`));
  const testers = Array.from({ length: 5 }, (_, i) => k.worker("review", `11.${i + 1}`));
  const lead = k.worker("implementation", "12.1", "lead");
  let snap = k.snapshot();
  c.same("8 developers: the pool of six is worn, two are overflow", devs.map((s) => s.characterId), ["pepper", "roux", "ember", "sprig", "crumb", "mochi", null, null]);
  c.same("5 testers: the pool of four is worn, one is overflow", testers.map((s) => s.characterId), ["dash", "dot", "blip", "zest", null]);
  c.same("an orchestrator-family worker is overflow: basil is reserved for the coordinator", lead.characterId, null);
  c.same("the overflow list names exactly the sessions with no robot", snap.overflow, [devs[6].id, devs[7].id, testers[4].id, lead.id]);
  c.same("no cap on real sessions: all fifteen are current", snap.current.length, 15);
  c.same("no numbered copy and no borrowed character: eleven robots, each once", snap.characters.map((ch) => ch.id), ["pepper", "roux", "ember", "sprig", "crumb", "mochi", "dash", "dot", "blip", "zest", "basil"]);
  k.tick(55);
  k.end(devs[0].id, "handed-off", "review");
  const late = k.worker("implementation", "10.9");
  c.same("a character that frees up goes to the next new session, not to a waiting overflow session", [late.characterId, k.book.sessions[devs[6].id].characterId, k.book.sessions[devs[7].id].characterId], ["pepper", null, null]);
  const prev = k.snapshot();
  const extra = k.worker("implementation", "10.10");
  snap = k.snapshot();
  c.same("an overflow session never arrives through the transporter", [extra.characterId, crewFloorChanges(prev, snap)], [null, { arrivals: [], departures: [] }]);
  k.tick(30);
  k.end(devs[6].id, "failed");
  snap = k.snapshot();
  const ended = snap.history.find((h) => h.id === devs[6].id);
  c.same("an overflow session keeps its history: ticket, outcome, and no character", [ended?.ticket, ended?.end?.outcome, ended?.characterId, ended?.characterName], ["10.7", "failed", null, null]);
  c.same("seventeen sessions started, none lost", [snap.current.length + snap.history.length, Object.keys(k.book.sessions).length], [17, 17]);
  return close(k, c, [
    "more sessions than STATIONS OR SEATS: where robots stand and sit, and that robots, ticket badges and nameplates don't overlap (visual, 09.5). This scenario shows more sessions than characters, as data",
    "the compact crew list that shows overflow sessions, and an off-floor overflow leaving through the transporter (visual, 09.5)",
  ]);
}

/** What the transcript restore reports for one session after a restart. `hook` = it arrived through startSession instead. */
interface Sighting {
  id: string;
  facts: CrewSessionFacts & { phase: "live" | "ended"; end?: SessionEnd | null; endedAt?: string | null };
  hook?: boolean;
}

/**
 * Startup after a restart, the way docs/crew-contract.md orders it: open the restore pass
 * (migrateLegacy, or beginRestore when the caller skips the migration), report every sighting,
 * then reconcile once. Never restoreSession without an open pass: it would allocate on the spot
 * and let restore order decide who gets a character.
 */
function restart(persisted: CrewBook, opener: "migrateLegacy" | "beginRestore", sightings: Sighting[], running: string[], sec: number, legacy?: { crew: LegacyCrewJson; sessions: LegacySessionsJson }) {
  const now = at(sec);
  let book = clone(persisted);
  if (opener === "migrateLegacy") book = migrateLegacy(legacy?.crew ?? {}, legacy?.sessions ?? {}, book, { kitchen: CREW_FIXTURE_KITCHEN, now, backup: "/fixture/backups/crew-fx" });
  else beginRestore(book);
  const opened = book.restorePass !== null;
  for (const s of sightings) {
    if (s.hook) startSession(book, s.id, s.facts, now);
    else restoreSession(book, s.id, s.facts, now);
  }
  const midPass = clone(book);
  const conflicts = reconcileAfterRestore(book, running, now);
  return { book, opened, midPass, conflicts };
}

function restartFromBook(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  const coordinator = k.coordinator();
  k.tick(5);
  const old1 = k.worker("implementation", "06.3");
  const old2 = k.worker("implementation", "05.2");
  k.tick(20);
  k.end(old1.id, "handed-off", "review");
  k.end(old2.id, "failed");
  k.tick(5);
  const dev1 = k.worker("implementation", "07.2");
  const dev2 = k.worker("implementation", "08.1");
  // Five testers for a pool of four: the fifth is overflow before the restart.
  const test1 = k.worker("review", "07.1");
  const test2 = k.worker("review", "08.2");
  const test3 = k.worker("review", "06.3");
  const test4 = k.worker("review", "05.2");
  const test5 = k.worker("review", "09.4");
  const lead = k.worker("implementation", "09.9", "lead");
  k.readings(dev1.id, { context: { used: 61_000, limit: 200_000 }, model: null, tokens: null, costUsd: null, tools: null });
  c.same("a custom name and colour are accepted; a numbered name and the needs-you pink are refused", [k.customize("pepper", { name: "Paprika", color: "#3366CC" }), k.customize("roux", { name: "Dash 2" }) !== null, k.customize("roux", { color: "#ff77a8" }) !== null], [null, true, true]);
  c.same("before the restart: who wears what; the fifth tester and the lead are overflow", [dev1, dev2, test1, test2, test3, test4, test5, lead].map((s) => s.characterId), ["pepper", "roux", "dash", "dot", "blip", "zest", null, null]);
  const before = k.snapshot();
  // The kitchen stops at +30 s and is back at +600 s. The book goes to disk and back as JSON.
  const persisted = clone(k.book);
  const live = (s: CrewSession): Sighting => ({ id: s.id, facts: { ...k.facts(s.id, String(s.stage), String(s.ticket), s.role), kind: s.kind, phase: "live" } });
  const newDev = "fx9001";
  const newTester = "fx9002";
  const newEnded = "fx9003";
  const sightings: Sighting[] = [
    { id: coordinator.id, facts: { kind: "coordinator", hqId: "coordinator", phase: "live" } },
    // dev1 kept running, but the restore reads it differently from the book on every link it
    // carries: another id, role, stage, ticket, title, worktree, transcript path and start time.
    { id: dev1.id, facts: { kind: "worker", hqId: `w-99.9-review-${dev1.id}`, role: "tester", stage: "review", ticket: "99.9", title: "A brief header read wrongly", worktree: ".pathfinder/worktrees/99.9", transcript: `/fixture/moved/${dev1.id}.jsonl`, startedAt: at(590), phase: "live" } },
    live(test1),
    live(test3),
    live(test4),
    live(test5),
    live(lead),
    // dev2 handed off while the kitchen was down. test2's transcript is gone: nothing reports it, so dot comes free.
    { id: dev2.id, facts: { ...k.facts(dev2.id, "implementation", "08.1", "developer"), phase: "ended", end: ending("handed-off", 300, "review") } },
    // old1 handed off at +25 s. The restore reports another ending and another time for it.
    { id: old1.id, facts: { ...k.facts(old1.id, "implementation", "06.3", "developer"), phase: "ended", end: ending("interrupted", 500), endedAt: at(500) } },
    // old2 failed at +25 s. Its transcript still looks live, and the restore even counts it as running: a stale sighting.
    { id: old2.id, facts: { ...k.facts(old2.id, "implementation", "05.2", "developer"), phase: "live" } },
    // Three sessions the book has never seen: one a hook reports, one the restore finds live, one that came and went.
    { id: newDev, hook: true, facts: { ...k.facts(newDev, "implementation", "09.4", "developer"), startedAt: at(400), phase: "live" } },
    { id: newTester, facts: { ...k.facts(newTester, "review", "08.1", "tester"), startedAt: at(350), phase: "live" } },
    { id: newEnded, facts: { ...k.facts(newEnded, "implementation", "10.1", "developer"), startedAt: at(420), phase: "ended", end: ending("failed", 500) } },
  ];
  const running = [coordinator.id, dev1.id, test1.id, test3.id, test4.id, test5.id, lead.id, old2.id, newDev, newTester];
  const forward = restart(persisted, "migrateLegacy", sightings, running, 600);
  const reverse = restart(persisted, "migrateLegacy", [...sightings].reverse(), running, 600);
  const begun = restart(persisted, "beginRestore", sightings, running, 600);
  const begunReverse = restart(persisted, "beginRestore", [...sightings].reverse(), running, 600);
  const book = forward.book;
  const s = book.sessions;
  const links = (x: CrewSession) => [x.hqId, x.role, x.stage, x.family, x.ticket, x.title, x.worktree, x.transcript, x.startedAt];

  c.same("the restore pass was open for every sighting and is closed after reconcile", [forward.opened, reverse.opened, begun.opened, begunReverse.opened, book.restorePass], [true, true, true, true, null]);
  c.same("reverse restore order gives the same book", canonicalCrewBook(reverse.book) === canonicalCrewBook(book), true);
  c.same("beginRestore gives the same book as migrateLegacy, in either order", [canonicalCrewBook(begun.book) === canonicalCrewBook(book), canonicalCrewBook(begunReverse.book) === canonicalCrewBook(book)], [true, true]);
  c.same("nothing is allocated while the pass is open, and an unseen session keeps its character", [forward.midPass.sessions[newDev].characterId, forward.midPass.sessions[newTester].characterId, forward.midPass.sessions[test2.id].phase, forward.midPass.sessions[test2.id].characterId], [null, null, "live", "dot"]);
  c.none("no duplicate crew: the restarted book holds the invariants", crewBookProblems(book));
  c.same("sessions that kept running keep their characters", [s[dev1.id].characterId, s[test1.id].characterId, s[test3.id].characterId, s[test4.id].characterId, s[coordinator.id].characterId, s[coordinator.id].phase], ["pepper", "dash", "blip", "zest", "basil", "live"]);
  c.same("a tester that was overflow before the restart stays overflow, though dot came free during it and went to a new session", [s[test5.id].characterId, s[test5.id].reassignedFrom, s[test5.id].phase, book.characters.dot?.sessionId], [null, null, "live", newTester]);
  c.same("an orchestrator-family worker has no character before or after: basil is reserved for the coordinator", [s[lead.id].characterId, s[lead.id].phase], [null, "live"]);
  c.same("a session that ended while the kitchen was down keeps its real outcome and time", [s[dev2.id].phase, s[dev2.id].end?.outcome, s[dev2.id].endedAt], ["ended", "handed-off", at(300)]);
  c.same("a session nobody saw again ends with its outcome unknown, not interrupted", [s[test2.id].phase, s[test2.id].end, s[test2.id].endedAt], ["ended", null, at(600)]);
  c.same("new sessions get a free character of their own family at reconcile", [s[newDev].characterId, s[newTester].characterId], ["roux", "dot"]);
  c.same("a session that came and went while the kitchen was down is history with no robot", [s[newEnded].phase, s[newEnded].characterId, s[newEnded].end?.outcome], ["ended", null, "failed"]);
  c.same("no session launch: the book gained only the three sessions the restore observed", Object.keys(s).filter((id) => !persisted.sessions[id]).sort(), [newDev, newTester, newEnded]);
  c.same("a sighting that disagrees with the book on every link changes none: the stored id, role, stage, ticket, title, worktree, transcript and start time win", [links(s[dev1.id]), s[dev1.id].ticket, s[dev1.id].transcript], [links(persisted.sessions[dev1.id]), "07.2", `/fixture/${dev1.id}.jsonl`]);
  c.same("a sighting with another ending for a session whose outcome is recorded changes neither the outcome nor its time", [s[old1.id].end?.outcome, s[old1.id].endedAt], ["handed-off", at(25)]);
  c.same("a stale live sighting of an ended session revives nothing: it stays ended with its outcome and time, and its old character is free for a new session", [s[old2.id].phase, s[old2.id].end?.outcome, s[old2.id].endedAt, s[old2.id].characterId, book.characters.roux?.sessionId], ["ended", "failed", at(25), "roux", newDev]);
  c.none("no lost history: every earlier session, outcome, ticket link and transcript path is kept, against sightings that disagree", crewHistoryProblems(persisted, book));
  c.same("readings that were never read stay null across the restart", s[dev1.id].telemetry, { context: { used: 61_000, limit: 200_000 }, model: null, tokens: null, costUsd: null, tools: null, at: at(30) });
  c.same("a start that imports nothing appends no migration entry, so no backup is owed", book.migrations.length, 0);
  const observations = Object.fromEntries(running.map((id) => [id, { ...SIGHT.working, attention: null, at: at(600) }]));
  const snapshot = crewFixtureSnapshot(book, observations, CREW_FIXTURE_T0 + 600_000);
  c.same("no replayed arrivals: the first snapshot after a restart announces nothing", crewFloorChanges(null, snapshot), { arrivals: [], departures: [] });
  c.same("no duplicate crew: the same robots as before the restart, each once", [snapshot.characters.map((ch) => ch.id), before.characters.map((ch) => ch.id)], [["pepper", "roux", "dash", "dot", "blip", "zest", "basil"], ["pepper", "roux", "dash", "dot", "blip", "zest", "basil"]]);
  c.same("the overflow list names the same two sessions before and after the restart", [before.overflow, snapshot.overflow], [[test5.id, lead.id], [test5.id, lead.id]]);
  c.same("a custom name and colour cross the restart, in the book, on the character and on its session", [book.characters.pepper?.name, book.characters.pepper?.color, who(snapshot, "pepper")?.name, who(snapshot, "pepper")?.accent, who(snapshot, "pepper")?.customized, snapshot.current.find((x) => x.id === dev1.id)?.characterName], ["Paprika", "#3366cc", "Paprika", "#3366cc", true, "Paprika"]);
  c.none("the restarted snapshot is sound", crewSnapshotProblems(snapshot, book));
  const settled = canonicalCrewBook(book);
  c.same("a second reconcile finds nothing to do", [reconcileAfterRestore(book, running, at(600)), canonicalCrewBook(book) === settled], [[], true]);
  const seenAgain = sightings.map((x) => ({ ...x, hook: false }));
  const twice = restart(book, "migrateLegacy", seenAgain, running, 600);
  c.same("a second restart with the same sightings changes nothing", canonicalCrewBook(twice.book) === settled, true);

  // An upgrade pass: a legacy crew.json found next to the book holds one running worker the old
  // code put on Basil. The coordinator is already in the book, so no coordinator START moves the
  // worker off: reconcile has to. Legacy files carry no start time, so by the age order the worker
  // is the OLDER of the two on Basil: only the "Basil is the coordinator's" rule can move it.
  const onBasil = "fxl7b";
  const legacy = { crew: { [onBasil]: { id: "basil", name: "Basil 2", job: "Head Chef" } } as LegacyCrewJson, sessions: {} };
  const upgrade = [...seenAgain, { id: onBasil, facts: { ...k.facts(onBasil, "implementation", "09.9", "lead"), phase: "live" as const } }];
  const late = restart(book, "migrateLegacy", upgrade, [...running, onBasil], 660, legacy);
  const lateReverse = restart(book, "migrateLegacy", [...upgrade].reverse(), [...running, onBasil], 660, legacy);
  const moved = late.book.sessions[onBasil];
  c.same("upgrade: a legacy worker on basil shares him with the coordinator only until reconcile", [late.midPass.sessions[onBasil].characterId, late.midPass.sessions[onBasil].phase, late.midPass.sessions[coordinator.id].characterId], ["basil", "live", "basil"]);
  c.same("upgrade: reconcile moves it to overflow, records the conflict and keeps its legacy row; the coordinator keeps basil", [moved.characterId, moved.reassignedFrom, moved.phase, moved.startedAt, moved.legacy?.name, late.conflicts.map((x) => [x.sessionId, x.characterId]), late.book.migrations.at(-1)?.conflicts.length, late.book.sessions[coordinator.id].characterId, late.book.characters.basil?.sessionId], [null, "basil", "live", null, "Basil 2", [[onBasil, "basil"]], 1, "basil", coordinator.id]);
  c.same("upgrade: reverse restore order gives the same book", canonicalCrewBook(lateReverse.book) === canonicalCrewBook(late.book), true);
  c.none("upgrade: the invariants hold and no history is lost", [...crewBookProblems(late.book), ...crewHistoryProblems(book, late.book)]);
  c.none("no character shared by two live sessions before the restart either", k.violations);
  c.none(`every snapshot taken before the restart (${k.snapshots}) shows each character with its own session's ticket, stage, role and readings`, k.snapshotViolations);
  return {
    checks: c.list,
    notCovered: [
      "a real server restart with real transcripts and a real ~/.controlroom book (live, 09.8)",
      "a legacy worker on basil moved off by a NEW coordinator session's start (the startSession path; scripts/crew-contract-test.ts of 09.1 checks it). Here the coordinator is already in the book, so the reconcile path is the one checked",
    ],
    book,
    snapshot,
  };
}

function restartFromLegacy(): CrewScenarioOutcome {
  const c = new Checks();
  // Shaped like the live files that produced 4 "Pepper" rows and 4 "Dash" rows in Settings → Team.
  const crew: LegacyCrewJson = {};
  const sessions: LegacySessionsJson = {};
  for (let i = 0; i < 4; i++) {
    crew[`fxl${i}p`] = { id: "pepper", name: "Pepper", job: "Sous Chef" };
    sessions[`fxl${i}p`] = ending("handed-off", -3600 + i * 600, "review");
    crew[`fxl${i}d`] = { id: "dash", name: "Dash", job: "Expediter" };
    sessions[`fxl${i}d`] = ending("interrupted", -3300 + i * 600);
  }
  crew.fxl8d = { id: "dash", name: "Dash", job: "Expediter" }; // crew-only: running
  crew.fxl9d = { id: "dash", name: "Dash 2", job: "Expediter" }; // crew-only: running, a numbered copy
  crew.fxl9p = { id: "pepper", name: "Pepper", job: "Sous Chef" }; // crew-only: died while nothing watched
  sessions.fxl0x = ending("gate", -4000); // sessions-only
  const k = new FixtureKitchen(); // only for its facts(); its book is not used
  const worker = (id: string, stage: string, ticket: string, role: string, phase: "live" | "ended", startedAt: string | null): Sighting => ({ id, facts: { ...k.facts(id, stage, ticket, role), startedAt, phase } });
  const sightings: Sighting[] = [
    // Two coordinator transcripts, both reported live and running: the newer one keeps Basil.
    { id: "coordinator:fx-main", facts: { kind: "coordinator", hqId: "coordinator", stage: "coordinate", transcript: "/fixture/fx-main.jsonl", startedAt: at(-600), phase: "live" } },
    { id: "coordinator:fx-old", facts: { kind: "coordinator", hqId: "coordinator", stage: "coordinate", transcript: "/fixture/fx-old.jsonl", startedAt: at(-7200), phase: "live" } },
    ...[0, 1].flatMap((i) => [worker(`fxl${i}p`, "implementation", "05.1", "developer", "ended", null), worker(`fxl${i}d`, "review", "05.1", "tester", "ended", null)]),
    // fxl2p and fxl2d: their transcripts are gone, so nothing reports them.
    // fxl3p handed off long ago (sessions.json says so), but its transcript still looks live and the
    // restore even counts it as running: a stale sighting.
    worker("fxl3p", "implementation", "05.1", "developer", "live", null),
    worker("fxl3d", "review", "05.1", "tester", "ended", null),
    worker("fxl8d", "review", "07.1", "tester", "live", at(-300)),
    worker("fxl9d", "review", "08.2", "tester", "live", at(-200)),
  ];
  const running = ["coordinator:fx-main", "coordinator:fx-old", "fxl3p", "fxl8d", "fxl9d"];
  const first = migrateLegacy(crew, sessions, null, { kitchen: CREW_FIXTURE_KITCHEN, now: at(0), backup: "/fixture/backups/crew-fx" });
  c.same("the legacy import opens the restore pass and records one migration with its backup path", [first.restorePass !== null, first.migrations.length, first.migrations[0]?.backup, first.migrations[0]?.imported.length], [true, 1, "/fixture/backups/crew-fx", 12]);
  c.same("two live legacy sessions share dash until every observation is in", Object.values(first.sessions).filter((s) => s.phase === "live" && s.characterId === "dash").map((s) => s.id), ["fxl8d", "fxl9d"]);
  const run = (order: Sighting[]) => {
    const book = clone(first);
    for (const s of order) restoreSession(book, s.id, s.facts, at(0));
    const conflicts = reconcileAfterRestore(book, running, at(0));
    return { book, conflicts };
  };
  const { book, conflicts } = run(sightings);
  const reverse = run([...sightings].reverse());
  const s = book.sessions;
  c.same("reverse restore order gives the same book", canonicalCrewBook(reverse.book) === canonicalCrewBook(book), true);
  c.none("no duplicate crew after reconcile", crewBookProblems(book));
  c.same("dash stays with the older live session; the numbered copy becomes dot", [s.fxl8d.characterId, s.fxl9d.characterId, s.fxl9d.reassignedFrom, conflicts.map((x) => [x.sessionId, x.characterId])], ["dash", "dot", "dash", [["fxl9d", "dash"]]]);
  c.same("the conflict is recorded in the migration entry", book.migrations[0]?.conflicts.length, 1);
  c.same("the legacy row is kept verbatim, and never keyed by its name", [s.fxl9d.legacy, Object.keys(s).length], [{ name: "Dash 2", job: "Expediter", character: "dash" }, 14]);
  c.same("of two coordinator transcripts the newer keeps basil and the older ends with its outcome unknown, whichever was restored first", [s["coordinator:fx-main"].phase, s["coordinator:fx-main"].characterId, s["coordinator:fx-old"].phase, s["coordinator:fx-old"].end, book.characters.basil?.sessionId, canonicalCrewBook(reverse.book) === canonicalCrewBook(book)], ["live", "basil", "ended", null, "coordinator:fx-main", true]);
  c.same("a stale live sighting of a session sessions.json ended revives nothing: outcome and time stay, and pepper stays free", [s.fxl3p.phase, s.fxl3p.end?.outcome, s.fxl3p.endedAt, book.characters.pepper?.sessionId], ["ended", "handed-off", at(-1800), null]);
  c.same("a crew-only session that died unobserved ends with its outcome unknown and frees pepper", [s.fxl9p.phase, s.fxl9p.end, book.characters.pepper?.sessionId], ["ended", null, null]);
  c.same("a sessions-only entry is history with no robot, outcome kept", [s.fxl0x.phase, s.fxl0x.characterId, s.fxl0x.end?.outcome], ["ended", null, "gate"]);
  c.same("every recorded outcome is kept: 4 handed-off, 4 interrupted", [0, 1, 2, 3].flatMap((i) => [s[`fxl${i}p`].end?.outcome, s[`fxl${i}d`].end?.outcome]), Array.from({ length: 4 }, () => ["handed-off", "interrupted"]).flat());
  c.same("ticket links and transcript paths are filled from the restore", [s.fxl0p.ticket, s.fxl0p.transcript, s.fxl0p.role], ["05.1", "/fixture/fxl0p.jsonl", "developer"]);
  c.same("a session whose transcript is gone keeps its record with unknown links", [s.fxl2p.phase, s.fxl2p.ticket, s.fxl2p.transcript, s.fxl2p.characterId], ["ended", null, null, "pepper"]);
  const observations = Object.fromEntries(running.map((id) => [id, { ...SIGHT.working, attention: null, at: at(1) }]));
  const snapshot = crewFixtureSnapshot(book, observations, CREW_FIXTURE_T0 + 1000);
  c.same("Team data: four robots, not twelve rows; the past sessions are history", [snapshot.characters.map((ch) => ch.name), snapshot.current.length, snapshot.history.length], [["Pepper", "Dash", "Dot", "Basil"], 3, 11]);
  c.none("no repeated or numbered name reaches the snapshot", crewSnapshotProblems(snapshot, book));
  c.same("no replayed arrivals: migrated robots appear in place", crewFloorChanges(null, snapshot), { arrivals: [], departures: [] });
  const again = migrateLegacy(crew, sessions, book, { kitchen: CREW_FIXTURE_KITCHEN, now: at(60), backup: "/fixture/backups/crew-fx-2" });
  for (const x of sightings) restoreSession(again, x.id, x.facts, at(60));
  reconcileAfterRestore(again, running, at(60));
  c.same("idempotent: a second start from the same files imports nothing and changes nothing", [again.migrations.length, Object.keys(again.sessions).length, canonicalCrewBook(again) === canonicalCrewBook(book)], [1, 14, true]);
  c.none("the second start lost no history", crewHistoryProblems(book, again));
  // A third start whose restore disagrees with the book: every worker is reported live and running,
  // under another id, role, stage, ticket, title, worktree and transcript path.
  const third = migrateLegacy(crew, sessions, book, { kitchen: CREW_FIXTURE_KITCHEN, now: at(120), backup: "/fixture/backups/crew-fx-3" });
  for (const x of sightings) {
    const facts = x.facts.kind === "coordinator" ? x.facts : { ...x.facts, hqId: `w-99.9-plan-${x.id}`, role: "lead", stage: "plan", ticket: "99.9", title: "A brief header read wrongly", worktree: ".pathfinder/worktrees/99.9", transcript: `/fixture/moved/${x.id}.jsonl`, phase: "live" as const };
    restoreSession(third, x.id, facts, at(120));
  }
  reconcileAfterRestore(third, sightings.map((x) => x.id), at(120));
  c.same("a later start whose sightings disagree on every known link and report every session live changes nothing: stored values win, nothing is revived", [third.migrations.length, s.fxl0p.ticket, third.sessions.fxl0p.ticket, third.sessions.fxl0p.phase, canonicalCrewBook(third) === canonicalCrewBook(book)], [1, "05.1", "05.1", "ended", true]);
  c.none("the disagreeing start lost no history", crewHistoryProblems(book, third));
  return {
    checks: c.list,
    notCovered: ["the backup copy and the atomic write of crew-book.json (09.3 owns the disk)", "the real ~/.controlroom files of a live kitchen (09.8)", ...TEAM_NOT_COVERED],
    book,
    snapshot,
  };
}

function reconnect(): CrewScenarioOutcome {
  const c = new Checks();
  const k = new FixtureKitchen();
  k.coordinator();
  k.tick(5);
  const dev1 = k.worker("implementation", "07.2");
  k.worker("review", "07.1");
  const s1 = k.snapshot();
  k.tick(10);
  const dev2 = k.worker("implementation", "08.1");
  const s2 = k.snapshot();
  c.same("on one connection, a new character arrives once", [crewFloorChanges(s1, s2), crewFloorChanges(s2, k.snapshot())], [{ arrivals: ["roux"], departures: [] }, { arrivals: [], departures: [] }]);
  // The client reconnects. The server never stopped, and the poll reports every session again.
  const before = canonicalCrewBook(k.book);
  for (const s of Object.values(k.book.sessions)) startSession(k.book, s.id, { kind: s.kind, role: s.role, stage: s.stage, ticket: s.ticket }, k.iso);
  const s3 = k.snapshot();
  c.same("re-reporting every session after a reconnect allocates nothing and changes nothing", canonicalCrewBook(k.book) === before, true);
  c.same("the first snapshot after a reconnect replays no arrival and no departure", crewFloorChanges(null, s3), { arrivals: [], departures: [] });
  c.same("identities are stable across the reconnect", s3.characters.map((ch) => [ch.id, ch.sessionId]), s2.characters.map((ch) => [ch.id, ch.sessionId]));
  k.tick(10);
  k.retire("roux", true);
  const s4 = k.snapshot();
  c.same("a retired character keeps its session and stays on the floor until it ends", [who(s4, "roux")?.retired, who(s4, "roux")?.sessionId, crewOnFloor(who(s4, "roux")!), crewFloorChanges(s3, s4)], [true, dev2.id, true, { arrivals: [], departures: [] }]);
  k.tick(10);
  k.end(dev2.id, "handed-off", "review");
  k.tick(1);
  const s5 = k.snapshot();
  k.tick(9);
  const s6 = k.snapshot();
  c.same("it departs once, after its handoff pose, and not again", [crewFloorChanges(s4, s5), crewFloorChanges(s5, s6), crewFloorChanges(s6, k.snapshot())], [{ arrivals: [], departures: [] }, { arrivals: [], departures: ["roux"] }, { arrivals: [], departures: [] }]);
  c.same("a reconnect after the departure replays nothing", crewFloorChanges(null, k.snapshot()), { arrivals: [], departures: [] });
  const dev3 = k.worker("implementation", "09.4");
  c.same("a retired character is never allocated: the next cook is ember", [dev1.characterId, dev3.characterId], ["pepper", "ember"]);
  c.same("the retired character's session is still in history", [k.book.sessions[dev2.id].phase, k.book.sessions[dev2.id].characterId, k.book.sessions[dev2.id].end?.outcome], ["ended", "roux", "handed-off"]);
  const s7 = k.snapshot();
  k.retire("roux", false);
  c.same("un-retiring brings it back as one arrival", crewFloorChanges(s7, k.snapshot()), { arrivals: ["roux"], departures: [] });
  return close(k, c, ["a real browser reconnect to a running server, and that no audio cue replays (live, 09.8; audio 09.6)"]);
}

/** The presentation settings Feature 09 wants every lifecycle state shown under. The crew data is the same in all eight. */
export const CREW_PRESENTATIONS: readonly { art: ArtStyle; motion: "full" | "reduced"; sound: "on" | "off" }[] = (["pixel", "cel"] as const).flatMap((art) =>
  (["full", "reduced"] as const).flatMap((motion) => (["on", "off"] as const).map((sound) => ({ art, motion, sound }))),
);

function presentation(): CrewScenarioOutcome {
  const c = new Checks();
  const { kitchen: k, snapshot } = crewBusyFixture();
  c.same("the matrix is both art styles × full and reduced motion × sound on and off", CREW_PRESENTATIONS.length, 8);
  c.same("the busy scene gives each of the eight a character in every lifecycle state", CREW_STATES.map((st) => snapshot.characters.some((ch) => ch.state === st)), CREW_STATES.map(() => true));
  const badged = (["assigned", "waiting", "needs-you", "unknown"] as CrewState[]).map((st) => snapshot.characters.find((ch) => ch.state === st)?.badge?.kind ?? null);
  c.same("reduced motion: starting, waiting, needs-you and unknown each carry a static badge", badged, ["starting", "waiting", "needs-you", "unknown"]);
  const kinds = CREW_STATES.flatMap((from) => CREW_STATES.map((to) => crewTransitionKind(from, to)));
  c.same("every change of state is stay, animate or snap, so a static pose always exists", [kinds.length, kinds.every((x) => x === "stay" || x === "animate" || x === "snap")], [49, true]);
  const idle = snapshot.characters.filter((ch) => ch.state === "available");
  c.same("sound: an available character has no session, badge or readings to cue from", idle.map((ch) => [ch.id, ch.sessionId, ch.badge, ch.telemetry]), [["sprig", null, null, null]]);
  c.same("sound: the first snapshot of a connection cues no arrival, whatever the toggle", crewFloorChanges(null, snapshot), { arrivals: [], departures: [] });
  return close(k, c, [
    "how each state is drawn in the pixel and cel styles (visual, 09.2 and 09.5)",
    "the static poses, icons and badges under reduced motion (visual, 09.5 and 09.6)",
    "that sound follows the audio toggle and idle characters stay silent (audible, 09.6)",
    "the combined pass over all eight settings (09.8)",
  ]);
}

/** Every fixture scenario, in the order of Feature 09's acceptance list. */
export const CREW_SCENARIOS: readonly CrewScenario[] = [
  { id: "concurrent", title: "2 developers, 2 testers and 2 adversaries at once (the busy scene)", evidence: "fixture", covers: ["concurrent"], fixtureOnlyFamilies: ["adversary"], run: concurrent },
  { id: "reuse", title: "Finish, relax, then a fresh session on the same character", evidence: "fixture", covers: ["reuse", "team"], fixtureOnlyFamilies: [], run: reuse },
  { id: "gate", title: "A human gate while others run", evidence: "fixture", covers: ["gate"], fixtureOnlyFamilies: [], run: gate },
  { id: "coordinator-waiting", title: "A coordinator waiting, with no false badge", evidence: "fixture", covers: ["coordinator-waiting"], fixtureOnlyFamilies: [], run: coordinatorWaiting },
  { id: "endings", title: "Interrupted, failed, gated and unrecorded endings", evidence: "fixture", covers: ["endings"], fixtureOnlyFamilies: [], run: endings },
  { id: "rapid-handoffs", title: "Rapid handoffs and overlapping arrivals", evidence: "fixture", covers: ["rapid-handoffs"], fixtureOnlyFamilies: [], run: rapidHandoffs },
  { id: "overflow", title: "More sessions than characters (data only; stations and seats are 09.5)", evidence: "fixture", covers: ["overflow"], fixtureOnlyFamilies: [], run: overflow },
  { id: "presentation", title: "Both art styles, reduced motion, sound on and off (data only)", evidence: "fixture", covers: ["presentation"], fixtureOnlyFamilies: ["adversary"], run: presentation },
  { id: "restart", title: "Restart from the crew book, forward and reverse restore order, with sightings that disagree", evidence: "fixture", covers: ["restart"], fixtureOnlyFamilies: [], run: restartFromBook },
  { id: "restart-legacy", title: "First start from legacy crew.json and sessions.json, forward and reverse, with two coordinator transcripts", evidence: "fixture", covers: ["restart", "team"], fixtureOnlyFamilies: [], run: restartFromLegacy },
  { id: "reconnect", title: "Client reconnect, retire and un-retire: nothing replayed", evidence: "fixture", covers: ["restart"], fixtureOnlyFamilies: [], run: reconnect },
];

/**
 * Proof that the invariant checks can fail: each case breaks a copy of the busy scene on purpose
 * and passes only when the matching check reports it. A harness whose checks can't fail proves
 * nothing, so the runner runs this before it trusts the scenarios.
 */
export function crewHarnessSelfCheck(): CrewCheck[] {
  const { kitchen, sessions, snapshot } = crewBusyFixture();
  // `naming`: the words the report must contain, so a case can't pass on some other complaint.
  const caught = (label: string, problems: string[], naming?: string): CrewCheck => {
    const ok = naming === undefined ? problems.length > 0 : problems.some((p) => p.includes(naming));
    return { label, ok, detail: ok ? null : problems.length ? `reported, but not as "${naming}": ${problems.join("; ")}` : "the broken data was reported as sound" };
  };
  const shared = clone(kitchen.book);
  shared.sessions[sessions.dev2.id].characterId = "pepper";
  const borrowed = clone(kitchen.book);
  borrowed.sessions[sessions.test1.id].characterId = "mochi";
  const dropped = clone(kitchen.book);
  delete dropped.sessions[sessions.dev4.id];
  const rewritten = clone(kitchen.book);
  rewritten.sessions[sessions.dev4.id].end!.outcome = "failed";
  const zeroed = clone(kitchen.book);
  zeroed.sessions[sessions.dev4.id].telemetry = { context: null, model: null, tokens: null, costUsd: 0, tools: 0, at: at(0) };
  const revived = clone(kitchen.book);
  revived.sessions[sessions.dev4.id].phase = "live";
  const numbered = clone(snapshot);
  numbered.characters.find((ch) => ch.id === "dot")!.name = "Dash 2";
  const stale = clone(snapshot);
  stale.characters.find((ch) => ch.id === "sprig")!.ticket = "05.2";
  // The reuse defect: pepper holds dev1 (07.2, with readings) and roux is at the 08.1 gate.
  const dev1 = sessions.dev1.id;
  const otherTicket = clone(snapshot);
  otherTicket.characters.find((ch) => ch.id === "pepper")!.ticket = sessions.dev3.ticket;
  const otherReadings = clone(snapshot);
  otherReadings.characters.find((ch) => ch.id === "pepper")!.telemetry = clone(kitchen.book.sessions[sessions.test1.id].telemetry);
  const noReadings = clone(snapshot);
  noReadings.characters.find((ch) => ch.id === "pepper")!.telemetry = null;
  const otherRole = clone(snapshot);
  Object.assign(otherRole.characters.find((ch) => ch.id === "pepper")!, { stage: "review", role: "tester" });
  const otherBadge = clone(snapshot);
  otherBadge.characters.find((ch) => ch.id === "roux")!.badge!.ticket = "07.2";
  const misnamed = clone(snapshot);
  misnamed.current.find((x) => x.id === dev1)!.characterName = "Roux";
  const misworn = clone(snapshot);
  misworn.current.find((x) => x.id === dev1)!.characterId = "ember";
  const relinked = clone(snapshot);
  relinked.history.find((x) => x.id === sessions.dev4.id)!.ticket = "07.2";
  return [
    caught("catches one character worn by two live sessions", crewBookProblems(shared)),
    caught("catches a character borrowed from another family", crewBookProblems(borrowed)),
    caught("catches a session dropped from history", crewHistoryProblems(kitchen.book, dropped)),
    caught("catches a rewritten outcome", crewHistoryProblems(kitchen.book, rewritten)),
    caught("catches unknown readings turned into 0", crewHistoryProblems(kitchen.book, zeroed)),
    caught("catches an ended session brought back to live", crewHistoryProblems(kitchen.book, revived)),
    caught("catches a numbered name in a snapshot", crewSnapshotProblems(numbered, kitchen.book)),
    caught("catches a stale ticket on an available character", crewSnapshotProblems(stale, kitchen.book), "sprig shows no session but its ticket is"),
    caught("catches a busy character showing another session's ticket", crewSnapshotProblems(otherTicket, kitchen.book), `pepper shows session ${dev1} but its ticket is`),
    caught("catches a busy character showing another session's readings", crewSnapshotProblems(otherReadings, kitchen.book), `pepper shows session ${dev1} but its telemetry is`),
    caught("catches a busy character showing no readings when its session has some", crewSnapshotProblems(noReadings, kitchen.book), `pepper shows session ${dev1} but its telemetry is`),
    caught("catches a busy character showing another session's stage and role", crewSnapshotProblems(otherRole, kitchen.book), `pepper shows session ${dev1} but its role is`),
    caught("catches a badge naming another session's ticket", crewSnapshotProblems(otherBadge, kitchen.book), "its badge names ticket"),
    caught("catches a session listed under another character's name", crewSnapshotProblems(misnamed, kitchen.book), `session ${dev1} is listed under the character name "Roux"`),
    caught("catches a session listed on a character it does not wear", crewSnapshotProblems(misworn, kitchen.book), `session ${dev1} is listed with characterId "ember"`),
    caught("catches a history row with another ticket than the book's", crewSnapshotProblems(relinked, kitchen.book), "is listed with ticket"),
  ];
}
