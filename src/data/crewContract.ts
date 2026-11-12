// The Pass · crew contract (Feature 09, ticket 09.1). The prose version is docs/crew-contract.md.
//
// Four identities, kept apart:
//   role       the Pathfinder role contract (roles/<role>.md): read-only here, owned by Feature 07;
//   character  a persistent visual robot (CrewCharacterId): name and colour customizable, never a role;
//   session    one Pathfinder execution session (CrewSession): always fresh, never resumed;
//   ticket     durable, passes through many sessions.
// A character holds at most one live session. Everything here is pure data and pure functions,
// shared by the server (09.3 registry) and the UI (09.4 settings, 09.5 galley, 09.6 telemetry).

import { CREW_CHARACTERS, CREW_VARIANTS, type CharacterId } from "./crew";
import type { AgentState, SessionEnd, SessionState, SessionTelemetry } from "./types";

// ---------------------------------------------------------------- Characters

/** Variant characters added by Feature 09 (names and jobs in crew.ts CREW_VARIANTS). */
export type VariantCharacterId =
  | "dot" | "blip" | "zest" // tester
  | "tang" | "nib" | "brine" // adversary
  | "whisk" | "ladle" | "scoop" | "tongs" // helper
  | "sage" // planner
  | "clove" // integrator
  | "bolt" | "cog"; // unknown

/** Every crew character id. The base ids (basil … unit) stay valid, so old crew.json maps cleanly. */
export type CrewCharacterId = CharacterId | VariantCharacterId;

export function isCrewCharacterId(id: unknown): id is CrewCharacterId {
  return typeof id === "string" && Object.hasOwn(CREW_CHARACTERS, id);
}

/**
 * The base sprite a character is drawn with today. Widening decision (M4): 09.3 widens
 * `CrewInfo.character` and `AgentConfig.crew.character` to CrewCharacterId; every galley path
 * typed CharacterId (robots.ts, scene.ts, RobotPortrait, model.ts) calls this until 09.2 adds the
 * variant sprites and widens `ROBOTS` itself. Base ids map to themselves.
 */
export function spriteBase(id: CrewCharacterId): CharacterId {
  return Object.hasOwn(CREW_VARIANTS, id) ? CREW_VARIANTS[id as VariantCharacterId].base : (id as CharacterId);
}

/** Accents no variant may use: the needs-you pinks (tokens pink and CrewPanel's needs-you outline). */
export const RESERVED_ACCENTS: readonly string[] = ["#ff77a8", "#ff4f7b"];
/** The plain colour the base Crew bot (unit) is drawn in for an unknown role. */
export const UNKNOWN_GREY = "#c2c3c7";

// ---------------------------------------------------------------- Role families

export const ROLE_FAMILIES = ["developer", "tester", "adversary", "orchestrator", "helper", "planner", "integrator", "unknown"] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

/**
 * Each family's characters, in allocation order. The pool size is also the family's floor bound:
 * a session that finds no free character in its own pool is overflow (see allocateCharacter).
 * A character belongs to exactly one family; families never borrow from each other.
 */
export const FAMILY_POOLS: Record<RoleFamily, readonly CrewCharacterId[]> = {
  developer: ["pepper", "roux", "ember", "sprig", "crumb", "mochi"],
  tester: ["dash", "dot", "blip", "zest"],
  adversary: ["pinch", "tang", "nib", "brine"],
  orchestrator: ["basil"],
  helper: ["whisk", "ladle", "scoop", "tongs"],
  planner: ["sage"],
  integrator: ["clove"],
  unknown: ["unit", "bolt", "cog"],
};

/** Families that can run several sessions at once (live or in fixtures): each needs >= 3 characters. */
export const PARALLEL_FAMILIES: readonly RoleFamily[] = ["developer", "tester", "adversary", "helper", "unknown"];

/**
 * Where each family appears with the Pathfinder kit installed here (static routing policy).
 * `live` = dispatched as its own session; `in-coordinator` = runs inside the coordinator session;
 * `human-led` = runs outside the kitchen; `fixture-only` = no stage in this kit (other versions, fixtures).
 */
export const FAMILY_PRESENCE: Record<RoleFamily, "live" | "in-coordinator" | "human-led" | "fixture-only"> = {
  developer: "live",
  tester: "live",
  orchestrator: "live",
  helper: "live",
  integrator: "in-coordinator",
  planner: "human-led",
  adversary: "fixture-only",
  unknown: "live",
};

/** The family each character belongs to (derived from FAMILY_POOLS). */
export const CHARACTER_FAMILY = Object.fromEntries(
  (Object.entries(FAMILY_POOLS) as [RoleFamily, readonly CrewCharacterId[]][]).flatMap(([f, ids]) => ids.map((id) => [id, f])),
) as Record<CrewCharacterId, RoleFamily>;

/** The coordinator's character. Reserved: never allocated to any other session. */
export const COORDINATOR_CHARACTER: CrewCharacterId = "basil";

// ---------------------------------------------------------------- Stages

/**
 * The session kinds a brief's `Session:` header (or the coordinator) can name. Developer stages
 * are the static policy's non-review sessions; `repair` and `adversary` come from other Pathfinder
 * versions; `coordinate` and `integrate` are the coordinator's own work; `helper` is a non-brief
 * subagent the coordinator or a worker starts.
 */
export const CREW_STAGES = ["implementation", "resume", "rebase-and-reverify", "resolve-conflict", "repair", "review", "adversary", "coordinate", "integrate", "plan", "helper"] as const;
export type CrewStage = (typeof CREW_STAGES)[number];

export const STAGE_FAMILY: Record<CrewStage, RoleFamily> = {
  implementation: "developer",
  resume: "developer",
  "rebase-and-reverify": "developer",
  "resolve-conflict": "developer",
  repair: "developer",
  review: "tester",
  adversary: "adversary",
  coordinate: "orchestrator",
  integrate: "orchestrator", // `/orchestrate integrate` runs inside the coordinator session here
  plan: "planner",
  helper: "helper",
};

/** Pathfinder role names (and the aliases the kitchen already accepts) to a family. */
const ROLE_FAMILY: Record<string, RoleFamily> = {
  developer: "developer", dev: "developer", engineer: "developer",
  tester: "tester", qa: "tester", reviewer: "tester",
  adversary: "adversary",
  orchestrator: "orchestrator", lead: "orchestrator", coordinator: "orchestrator",
  planner: "planner",
  integrator: "integrator",
  helper: "helper",
};

/**
 * A session's family. Order: an `adversary` or `helper` stage wins (as addWorker does today), then
 * the brief's `Role:`, then the stage, else `unknown`. A dispatched worker whose Role is
 * `integrator` is the integrator family; the coordinator integrating stays orchestrator.
 */
export function familyFor(role: string | null | undefined, stage: string | null | undefined): RoleFamily {
  const s = (stage ?? "").trim().toLowerCase();
  if (s === "adversary" || s === "helper") return s;
  const r = (role ?? "").trim().toLowerCase();
  if (r && Object.hasOwn(ROLE_FAMILY, r)) return ROLE_FAMILY[r];
  if (s && Object.hasOwn(STAGE_FAMILY, s)) return STAGE_FAMILY[s as CrewStage];
  return "unknown";
}

// ---------------------------------------------------------------- Sessions

export type CrewSessionKind = "coordinator" | "worker" | "helper";

/** How a session ended. Alias of SessionEnd's outcome so Feature 06 changes flow through. */
export type CrewOutcome = SessionEnd["outcome"];

/** Telemetry belongs to the session, never the character. Unavailable values are null, never 0. */
export interface CrewTelemetry {
  context: { used: number; limit: number } | null;
  /** Model and effort, observed or configured (SessionTelemetry). */
  model: SessionTelemetry | null;
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
  /** Tool calls observed so far; null when never read (e.g. a restored session). */
  tools: number | null;
  /** When these readings were taken (ISO). */
  at: string;
}

/**
 * One execution session. Id rules:
 * - worker / helper: the Claude Code subagent id (crew.json's and sessions.json's key today);
 * - coordinator: `coordinator:<transcript file name without .jsonl>`.
 * A session record is never deleted and never re-keyed.
 */
export interface CrewSession {
  id: string;
  kind: CrewSessionKind;
  /** The id the rest of the snapshot uses: `w-<key>-<session>-<id10>` for workers, COORDINATOR_ID, or the helper id. */
  hqId: string | null;
  /** The Pathfinder role verbatim (brief `Role:`), e.g. "developer". */
  role: string | null;
  /** The session kind verbatim (brief `Session:`); unknown kinds are kept as written. null until known (migrated sessions). */
  stage: CrewStage | (string & {}) | null;
  /**
   * familyFor(role, stage) once either is known. A migrated session with neither takes its legacy
   * character's family (for `unit`, familyFor(legacy job)). It may differ from the character's own
   * family only for a legacy session: the character is never changed to match.
   */
  family: RoleFamily;
  ticket: string | null;
  /** The ticket title from the brief header. */
  title: string | null;
  worktree: string | null;
  /** For a helper: the hqId of the session that launched it. */
  parent: string | null;
  /**
   * The character this session wears for its whole life; null = overflow (no free character when it
   * started). An overflow session stays without a robot until it ends, even after one frees up.
   */
  characterId: CrewCharacterId | null;
  /** Set only when a migration conflict moved the session off its legacy character. */
  reassignedFrom: CrewCharacterId | null;
  /** live -> ended only. Nothing ever moves a session from ended back to live. */
  phase: "live" | "ended";
  /** Book-wide creation order (0, 1, 2 …). For migrated sessions, crew.json key order. The age tiebreak. */
  seq: number;
  startedAt: string | null;
  endedAt: string | null;
  /** Pathfinder's recorded ending; null while live, or when an ended session's outcome was never recorded. */
  end: SessionEnd | null;
  /** A review/adversary report verdict when one was read (Feature 06 classifies it). */
  report: "pass" | "findings" | "gate" | null;
  /** The session's own subagent transcript. */
  transcript: string | null;
  /** Latest readings while live; frozen at the last reading when it ends. */
  telemetry: CrewTelemetry | null;
  /** What crew.json said about this session before Feature 09, verbatim (e.g. "Pepper 2"). */
  legacy: { name: string; job: string; character: string } | null;
}

// ---------------------------------------------------------------- Characters (persisted)

export interface CrewCharacterRecord {
  id: CrewCharacterId;
  family: RoleFamily;
  /** Visual customization only. null = the catalogue value. Never implies a role change. */
  name: string | null;
  color: string | null;
  /**
   * The live session this character holds now (invariant: at most one). A cache kept by
   * refreshCharacters; allocation reads the sessions themselves, so a stale cache can't free it.
   */
  sessionId: string | null;
  /** Its session with the highest seq, live or ended; drives the same-ticket preference. */
  lastSessionId: string | null;
  /** When it last became available (ISO): its latest session end; null while holding a session. */
  availableSince: string | null;
  /** When the book first recorded it. Migrated characters: the migration time (legacy files carry none). */
  firstSeen: string;
  /** Removed from the floor by the human; never allocated while retired. History is kept. */
  retired: boolean;
}

// ---------------------------------------------------------------- Crew book (persisted file)

export const CREW_BOOK_SCHEMA = "tin-and-thyme.crew-book";
export const CREW_BOOK_VERSION = 1;
/** In ~/.controlroom/<key>/. Legacy crew.json and sessions.json stay next to it, untouched. */
export const CREW_BOOK_FILE = "crew-book.json";
/** Backups go to ~/.controlroom/<key>/backups/crew-<stamp>/ before any migration write. */
export const CREW_BACKUP_DIR = "backups";

export interface CrewMigration {
  from: "crew.json" | "sessions.json" | "crew-book.json";
  fromVersion: number; // 0 = pre-Feature-09 files
  at: string;
  /** Absolute path of the backup directory written before this migration. */
  backup: string;
  imported: string[]; // session ids created
  filled: string[]; // existing session ids whose null fields were filled
  conflicts: { sessionId: string; characterId: CrewCharacterId; reason: string }[];
}

export interface CrewBook {
  schema: typeof CREW_BOOK_SCHEMA;
  version: typeof CREW_BOOK_VERSION;
  /** The kitchen key (~/.controlroom/<key>). */
  kitchen: string;
  updatedAt: string;
  characters: Partial<Record<CrewCharacterId, CrewCharacterRecord>>;
  sessions: Record<string, CrewSession>;
  migrations: CrewMigration[];
}

/** crew.json today (server/pathfinder.ts crewBook): subagent id -> the character assignCharacter gave it. */
export type LegacyCrewJson = Record<string, { id: CharacterId; name: string; job: string }>;
/** sessions.json today (server/pathfinder.ts endBook): subagent id -> how it ended. */
export type LegacySessionsJson = Record<string, SessionEnd>;

function newRecord(id: CrewCharacterId, now: string): CrewCharacterRecord {
  return { id, family: CHARACTER_FAMILY[id], name: null, color: null, sessionId: null, lastSessionId: null, availableSince: now, firstSeen: now, retired: false };
}

/** A book with nothing but Basil, who is always present. */
export function emptyCrewBook(kitchen: string, now: string): CrewBook {
  return { schema: CREW_BOOK_SCHEMA, version: CREW_BOOK_VERSION, kitchen, updatedAt: now, characters: { basil: newRecord("basil", now) }, sessions: {}, migrations: [] };
}

// ---------------------------------------------------------------- Lifecycle states

export const CREW_STATES = ["available", "assigned", "working", "waiting", "needs-you", "unknown", "finished"] as const;
export type CrewState = (typeof CREW_STATES)[number];

/** Allowed character state transitions. `available` is the only state without a session. */
export const CREW_TRANSITIONS: Record<CrewState, readonly CrewState[]> = {
  available: ["assigned"],
  assigned: ["working", "waiting", "needs-you", "unknown", "finished"],
  working: ["waiting", "needs-you", "unknown", "finished"],
  waiting: ["working", "needs-you", "unknown", "finished"],
  "needs-you": ["working", "waiting", "unknown", "finished"],
  unknown: ["working", "waiting", "needs-you", "finished"],
  // A fresh session may take a finished character at once: animation never delays assignment.
  finished: ["available", "assigned"],
};

export function canTransition(from: CrewState, to: CrewState): boolean {
  return from === to || CREW_TRANSITIONS[from].includes(to);
}

/**
 * How 09.5 draws a change of state. deriveCrewState is the truth; CREW_TRANSITIONS only says
 * which changes get an animation. Any other jump (available -> working after a restart, say) snaps
 * straight to the new state's pose with no animation and is never rejected or delayed.
 */
export function crewTransitionKind(from: CrewState, to: CrewState): "stay" | "animate" | "snap" {
  if (from === to) return "stay";
  return CREW_TRANSITIONS[from].includes(to) ? "animate" : "snap";
}

/** How long a finished character keeps its handoff pose before it walks off as available. */
export const FINISHED_LINGER_MS = 6000;
/** A reading the server took longer ago than this is stale, and the state is unknown. */
export const OBSERVATION_STALE_MS = 120_000;

/** What the server observed for a live session (from AgentStatus and Feature 06 attention). */
export interface CrewObservation {
  session: SessionState;
  agent: AgentState;
  /** Tool calls seen; 0 keeps the starting badge. */
  tools: number;
  /** Feature 06's verdict: needs-you only for a real gate, permission or question. */
  attention: { kind: "needs-you" | "waiting"; reason: string } | null;
  /**
   * When the server took this reading (ISO), stamped on every poll, not when the agent last acted.
   * A gate the human leaves for an hour stays fresh because each poll re-reads it; staleness means
   * the server lost sight of the session. Unparseable counts as stale.
   */
  at: string;
}

/**
 * A character's state, from observed data only. `session` is the one it holds (or last held).
 * `character` matters only without a session: Basil is never `available`, he shows `unknown`
 * until the coordinator's session is recorded.
 */
export function deriveCrewState(session: CrewSession | null, obs: CrewObservation | null, now: number, character?: CrewCharacterId): CrewState {
  if (!session) return character === COORDINATOR_CHARACTER ? "unknown" : "available";
  if (session.phase === "ended") {
    const ended = session.endedAt ? Date.parse(session.endedAt) : NaN;
    return Number.isFinite(ended) && now - ended < FINISHED_LINGER_MS ? "finished" : "available";
  }
  const at = obs ? Date.parse(obs.at) : NaN;
  if (!obs || !Number.isFinite(at) || now - at > OBSERVATION_STALE_MS) return "unknown";
  if (obs.attention?.kind === "needs-you") return "needs-you";
  if (obs.attention?.kind === "waiting") return "waiting";
  if (obs.session === "starting" || (obs.session === "running" && obs.tools === 0)) return "assigned";
  if (obs.session !== "running") return "unknown"; // a live session whose process stopped or failed: never idle
  if (obs.agent === "working") return "working";
  // needs-input without Feature 06 confirming it, idle between tools, in review: waiting, never pink.
  return "waiting";
}

// ---------------------------------------------------------------- Allocation

/**
 * Picks the character for a NEW session. Call it once per session id and store the result in
 * CrewSession.characterId; later polls, reconnects and restarts read that, never re-allocate.
 *  1. orchestrator -> basil, always.
 *  2. Candidates: the family's pool, minus retired characters and any worn by a live session
 *     (read from the sessions, not the record cache). A just-finished character is a candidate at
 *     once: the linger window is animation only.
 *  3. Prefer the candidate whose last session was on the same ticket; else the first in pool order.
 *  4. No candidate -> null: the session is overflow (shown in the compact crew list). Never a
 *     numbered copy, never another family's character, never a cap on real sessions. The session
 *     stays overflow for its whole life, even when a character frees up later.
 */
export function allocateCharacter(book: Pick<CrewBook, "characters" | "sessions">, family: RoleFamily, ticket: string | null): CrewCharacterId | null {
  if (family === "orchestrator") return COORDINATOR_CHARACTER;
  const worn = new Set(Object.values(book.sessions).flatMap((s) => (s.phase === "live" && s.characterId ? [s.characterId] : [])));
  const free = FAMILY_POOLS[family].filter((id) => !book.characters[id]?.retired && !worn.has(id));
  if (ticket) {
    const same = free.find((id) => {
      const last = book.characters[id]?.lastSessionId;
      return !!last && book.sessions[last]?.ticket === ticket;
    });
    if (same) return same;
  }
  return free[0] ?? null;
}

// ---------------------------------------------------------------- Session lifecycle (executable rules)
//
// The registry (09.3) changes the book only through these. They mutate the book they are given
// (migrateLegacy alone returns a new one) and never touch the disk: backup, atomic write and the
// corrupt-file rule stay with the caller (docs/crew-contract.md, Crew book).

/** Older first: both startedAt known -> earlier start; otherwise (legacy entries have none) lower seq. */
export function compareSessionAge(a: CrewSession, b: CrewSession): number {
  const x = a.startedAt ? Date.parse(a.startedAt) : NaN;
  const y = b.startedAt ? Date.parse(b.startedAt) : NaN;
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a.seq - b.seq;
}

const nextSeq = (book: CrewBook) => Object.values(book.sessions).reduce((m, s) => Math.max(m, s.seq + 1), 0);
const latest = (xs: (string | null)[]) => xs.filter((x): x is string => !!x && Number.isFinite(Date.parse(x))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;

/**
 * Recomputes every character record's cached fields from the sessions: sessionId (the oldest live
 * session wearing it, by compareSessionAge), lastSessionId (highest seq), availableSince (null while
 * held, else its latest session end, else the value it had). Creates missing records (firstSeen =
 * now) and keeps Basil present. Names, colours, retired and firstSeen are never changed here.
 */
export function refreshCharacters(book: CrewBook, now: string): void {
  if (!book.characters.basil) book.characters.basil = newRecord("basil", now);
  const by = new Map<CrewCharacterId, CrewSession[]>();
  for (const s of Object.values(book.sessions)) if (s.characterId) by.set(s.characterId, [...(by.get(s.characterId) ?? []), s]);
  for (const id of new Set([...(Object.keys(book.characters) as CrewCharacterId[]), ...by.keys()])) {
    const rec = (book.characters[id] ??= newRecord(id, now));
    const mine = by.get(id) ?? [];
    const holder = mine.filter((s) => s.phase === "live").sort(compareSessionAge)[0] ?? null;
    rec.sessionId = holder?.id ?? null;
    rec.lastSessionId = mine.length ? mine.reduce((a, b) => (b.seq > a.seq ? b : a)).id : rec.lastSessionId;
    rec.availableSince = holder ? null : latest(mine.map((s) => s.endedAt)) ?? rec.availableSince ?? now;
  }
}

/** What a brief, the coordinator or a helper hook says about a session. */
export interface CrewSessionFacts {
  kind?: CrewSessionKind;
  hqId?: string | null;
  role?: string | null;
  stage?: string | null;
  ticket?: string | null;
  title?: string | null;
  worktree?: string | null;
  parent?: string | null;
  transcript?: string | null;
  startedAt?: string | null;
}

function blankSession(id: string, seq: number): CrewSession {
  return {
    id, kind: "worker", hqId: null, role: null, stage: null, family: "unknown", ticket: null, title: null, worktree: null, parent: null,
    characterId: null, reassignedFrom: null, phase: "live", seq, startedAt: null, endedAt: null, end: null, report: null, transcript: null, telemetry: null, legacy: null,
  };
}

const FACT_FIELDS = ["kind", "hqId", "role", "stage", "ticket", "title", "worktree", "parent", "transcript", "startedAt"] as const;

/**
 * A NEW live session: allocates its character once and records it. An id already in the book is
 * returned as it is (never re-allocated, never revived). A new coordinator session ends any other
 * live coordinator session (one coordinator per kitchen), so Basil is never shared.
 */
export function startSession(book: CrewBook, id: string, facts: CrewSessionFacts, now: string): CrewSession {
  const had = book.sessions[id];
  if (had) return had;
  const s = blankSession(id, nextSeq(book));
  for (const f of FACT_FIELDS) if (facts[f] !== undefined) (s as unknown as Record<string, unknown>)[f] = facts[f];
  s.startedAt ??= now;
  s.family = s.kind === "coordinator" ? "orchestrator" : familyFor(s.role, s.stage ?? (s.kind === "helper" ? "helper" : null));
  if (s.kind === "coordinator") for (const o of Object.values(book.sessions)) if (o.kind === "coordinator" && o.phase === "live") endSession(book, o.id, null, now);
  s.characterId = allocateCharacter(book, s.family, s.ticket);
  book.sessions[id] = s;
  book.updatedAt = now;
  refreshCharacters(book, now);
  return s;
}

/** live -> ended, with Pathfinder's recorded ending (null = outcome unknown). An ended session is left alone. */
export function endSession(book: CrewBook, id: string, end: SessionEnd | null, now: string): CrewSession | null {
  const s = book.sessions[id];
  if (!s) return null;
  if (s.phase === "live") {
    s.phase = "ended";
    s.end = end ?? s.end;
    s.endedAt = s.end?.at ?? now;
    book.updatedAt = now;
    refreshCharacters(book, now);
  }
  return s;
}

/**
 * Migration rule 5, executable. The transcript restore re-observing a session it found: fills only
 * null fields, recomputes `family` from role and stage when it filled either, may end a live
 * session (live -> ended) but never revives an ended one, and never changes the character. An id
 * not in the book is recorded: live ones go through startSession; ended ones get no character
 * (a session that already ended never takes one).
 */
export function restoreSession(book: CrewBook, id: string, facts: CrewSessionFacts & { phase: "live" | "ended"; end?: SessionEnd | null; endedAt?: string | null }, now: string): CrewSession {
  let s = book.sessions[id];
  if (!s) {
    if (facts.phase === "live") return startSession(book, id, facts, now);
    s = blankSession(id, nextSeq(book));
    if (facts.kind) s.kind = facts.kind;
    book.sessions[id] = s;
  }
  let changed = false;
  let refamily = false;
  for (const f of FACT_FIELDS) {
    const v = facts[f];
    const rec = s as unknown as Record<string, unknown>;
    if (v === undefined || v === null || rec[f] !== null) continue;
    rec[f] = v;
    changed = true;
    if (f === "role" || f === "stage") refamily = true;
  }
  if (refamily || (!s.legacy && s.family === "unknown" && (s.role || s.stage))) s.family = s.kind === "coordinator" ? "orchestrator" : familyFor(s.role, s.stage);
  if (s.end === null && facts.end) (s.end = facts.end), (changed = true);
  if (facts.phase === "ended" && s.phase === "live") {
    s.phase = "ended";
    s.endedAt = facts.endedAt ?? s.end?.at ?? now;
    changed = true;
  } else if (s.phase === "ended" && s.endedAt === null && (facts.endedAt || s.end?.at)) {
    s.endedAt = facts.endedAt ?? s.end!.at;
    changed = true;
  }
  if (changed) book.updatedAt = now;
  refreshCharacters(book, now);
  return s;
}

/**
 * Rule 7, run once after the first full restore pass (and never before it):
 *  1. every live session the restore did not see running is ended with `end: null` (outcome
 *     unknown), endedAt = now: a crew-only legacy entry whose session died while the server was down;
 *  2. a character still worn by two or more live sessions stays with the oldest (compareSessionAge:
 *     startedAt, else seq, i.e. crew.json order, which is start order). Each later one is allocated
 *     again in its own family, gets `reassignedFrom`, and is listed in the latest migration's
 *     `conflicts` (or overflow, characterId null, when its pool is full).
 * Returns the conflicts it recorded.
 */
export function reconcileAfterRestore(book: CrewBook, runningIds: Iterable<string>, now: string): CrewMigration["conflicts"] {
  const running = new Set(runningIds);
  for (const s of Object.values(book.sessions)) if (s.phase === "live" && !running.has(s.id)) endSession(book, s.id, null, now);
  const conflicts: CrewMigration["conflicts"] = [];
  const live = Object.values(book.sessions).filter((s) => s.phase === "live" && s.characterId).sort(compareSessionAge);
  const keeper = new Map<CrewCharacterId, string>();
  for (const s of live) {
    const c = s.characterId!;
    if (!keeper.has(c)) {
      keeper.set(c, s.id);
      continue;
    }
    s.characterId = null;
    s.reassignedFrom = c;
    s.characterId = allocateCharacter(book, s.family, s.ticket);
    if (s.characterId) keeper.set(s.characterId, s.id);
    conflicts.push({ sessionId: s.id, characterId: c, reason: `${c} stays with older live session ${keeper.get(c)}; moved to ${s.characterId ?? "overflow"}` });
  }
  if (conflicts.length) {
    book.migrations.at(-1)?.conflicts.push(...conflicts);
    book.updatedAt = now;
  }
  refreshCharacters(book, now);
  return conflicts;
}

// ---------------------------------------------------------------- Migration (executable rules)

export interface MigrateOptions {
  kitchen: string;
  now: string;
  /** The backup directory the caller wrote before calling (rule 1); recorded in the migration. */
  backup: string;
}

function legacyEnd(v: unknown): SessionEnd | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Partial<SessionEnd>;
  if (typeof e.at !== "string" || typeof e.outcome !== "string") return null;
  return { outcome: e.outcome, next: e.next ?? null, result: e.result ?? null, at: e.at };
}

/**
 * Rules 3, 4 and 6, executable. Imports crew.json and sessions.json into a crew book; returns a new
 * book and never mutates `existing`.
 *  - Key by subagent id only, never by name. crew.json keeps its key order, which is start order
 *    (addWorker appends at session start), and that order becomes `seq`.
 *  - crew.json + sessions.json -> ended with that ending. crew.json only -> LIVE (end null): the
 *    session was running, or died unobserved; reconcileAfterRestore decides which.
 *    sessions.json only -> ended, characterId null.
 *  - The character is the legacy id unchanged ("Pepper 2" -> pepper; an unrecognized id -> null);
 *    the family is that character's, and for `unit` familyFor(legacy job), the role assignCharacter
 *    wrote there.
 *  - An id already in the book is never imported again. Its null fields may be filled (ending,
 *    endedAt, legacy), and a sessions.json ending may move it live -> ended, never back. Those ids
 *    are listed in `filled`.
 *  - No conflict is resolved here: two crew-only entries may wear one character until the restore
 *    has run (allocation already treats that character as taken).
 *  - A run that imports and fills nothing returns the book unchanged apart from updatedAt, with no
 *    new migration entry.
 */
export function migrateLegacy(crew: LegacyCrewJson, sessions: LegacySessionsJson, existing: CrewBook | null, opts: MigrateOptions): CrewBook {
  const { now } = opts;
  const book = existing ? structuredClone(existing) : emptyCrewBook(opts.kitchen, now);
  const imported: string[] = [];
  const filled: string[] = [];
  let seq = nextSeq(book);
  for (const [id, raw] of Object.entries(crew ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const end = legacyEnd(sessions?.[id]);
    const ended = Object.hasOwn(sessions ?? {}, id);
    const legacy = { name: String(raw.name ?? ""), job: String(raw.job ?? ""), character: String(raw.id ?? "") };
    const had = book.sessions[id];
    if (had) {
      let changed = false;
      if (had.legacy === null) (had.legacy = legacy), (changed = true);
      if (had.end === null && end) (had.end = end), (changed = true);
      if (ended && had.phase === "live") (had.phase = "ended"), (changed = true);
      if (had.phase === "ended" && had.endedAt === null && had.end) (had.endedAt = had.end.at), (changed = true);
      if (changed) filled.push(id);
      continue;
    }
    const s = blankSession(id, seq++);
    s.characterId = isCrewCharacterId(raw.id) ? raw.id : null;
    s.family = raw.id === "unit" ? familyFor(legacy.job, null) : s.characterId ? CHARACTER_FAMILY[s.characterId] : "unknown";
    s.legacy = legacy;
    s.end = end;
    s.phase = ended ? "ended" : "live";
    s.endedAt = end?.at ?? null;
    book.sessions[id] = s;
    imported.push(id);
  }
  for (const [id, raw] of Object.entries(sessions ?? {})) {
    if (Object.hasOwn(crew ?? {}, id)) continue;
    const end = legacyEnd(raw);
    const had = book.sessions[id];
    if (had) {
      let changed = false;
      if (had.end === null && end) (had.end = end), (changed = true);
      if (had.phase === "live") (had.phase = "ended"), (changed = true);
      if (had.endedAt === null && had.end) (had.endedAt = had.end.at), (changed = true);
      if (changed) filled.push(id);
      continue;
    }
    const s = blankSession(id, seq++);
    s.phase = "ended";
    s.end = end;
    s.endedAt = end?.at ?? null;
    book.sessions[id] = s;
    imported.push(id);
  }
  book.updatedAt = now;
  if (imported.length || filled.length) {
    book.migrations.push({ from: existing ? "crew-book.json" : "crew.json", fromVersion: existing ? book.version : 0, at: now, backup: opts.backup, imported, filled, conflicts: [] });
  }
  refreshCharacters(book, now);
  return book;
}

// ---------------------------------------------------------------- Names

export const MAX_CREW_NAME = 24;

/** The name a character shows: its custom name, else the catalogue name. */
export function crewName(id: CrewCharacterId, record?: CrewCharacterRecord | null): string {
  return record?.name ?? CREW_CHARACTERS[id].name;
}

/**
 * Why a custom name is refused, or null when it is fine. A name is 1–MAX_CREW_NAME characters
 * after trimming, unique (case-insensitive) across every catalogue name and every other custom
 * name, and never ends in a digit ("Dash 2", "Dash2", "Dash-2", "R2D2"). Renaming changes nothing
 * but the label.
 */
export function crewNameProblem(id: CrewCharacterId, name: string, characters: CrewBook["characters"]): string | null {
  const n = name.trim();
  if (!n) return "A name can't be empty.";
  if (n.length > MAX_CREW_NAME) return `A name is at most ${MAX_CREW_NAME} characters.`;
  if (/\d$/.test(n)) return "A name can't end in a number.";
  const key = n.toLowerCase();
  for (const other of Object.keys(CREW_CHARACTERS) as CrewCharacterId[]) {
    if (other === id) continue;
    if (crewName(other, characters[other]).toLowerCase() === key || CREW_CHARACTERS[other].name.toLowerCase() === key) return `${n} is already a crew name.`;
  }
  return null;
}

// ---------------------------------------------------------------- Snapshot (what the UI reads)

export interface CrewBadge {
  kind: "starting" | "waiting" | "needs-you" | "unknown";
  /** Short reason, e.g. "08.1 gate", "waiting on workers"; null when none is known. */
  reason: string | null;
  ticket: string | null;
}

export interface CrewCharacterView {
  id: CrewCharacterId;
  family: RoleFamily;
  name: string;
  job: string;
  look: string;
  /** Custom colour, else the variant accent, else null (the role colour). */
  accent: string | null;
  customized: boolean;
  retired: boolean;
  state: CrewState;
  stateSince: string;
  badge: CrewBadge | null;
  /** The session it holds (or, while finished, the one it just ended). */
  sessionId: string | null;
  ticket: string | null;
  stage: string | null;
  role: string | null;
  /** That session's readings; null when available. */
  telemetry: CrewTelemetry | null;
  lastOutcome: CrewOutcome | null;
}

export interface CrewSessionView extends CrewSession {
  /** The character's display name now; null for overflow. */
  characterName: string | null;
  state: CrewState;
}

/**
 * Published by 09.3 as `OfficeSnapshot.workflow.crew`. Characters listed: basil plus every
 * character with a record (ever held a session or was customized), in FAMILY_POOLS order.
 */
export interface CrewSnapshot {
  version: typeof CREW_BOOK_VERSION;
  characters: CrewCharacterView[];
  /** Live sessions, overflow included, oldest first. */
  current: CrewSessionView[];
  /** Ended sessions, newest first. */
  history: CrewSessionView[];
  /** Ids of live sessions without a character. */
  overflow: string[];
}

// ---------------------------------------------------------------- Self-check

/** Problems with the catalogue itself (empty when the contract holds). Run by scripts/crew-contract-test.ts. */
export function crewContractProblems(): string[] {
  const problems: string[] = [];
  const all = Object.keys(CREW_CHARACTERS) as CrewCharacterId[];
  const pooled = Object.values(FAMILY_POOLS).flat();
  const seen = new Set<string>();
  for (const id of pooled) {
    if (seen.has(id)) problems.push(`${id} is in more than one pool`);
    seen.add(id);
  }
  for (const id of all) if (!seen.has(id)) problems.push(`${id} is in no family pool`);
  for (const id of pooled) if (!(id in CREW_CHARACTERS)) problems.push(`${id} has no name or job`);
  for (const id of all) if (CREW_CHARACTERS[id].id !== id) problems.push(`${id} is catalogued as ${CREW_CHARACTERS[id].id}`);
  const names = new Map<string, string>();
  for (const id of all) {
    const n = CREW_CHARACTERS[id].name.trim().toLowerCase();
    if (names.has(n)) problems.push(`${id} and ${names.get(n)} share the name ${CREW_CHARACTERS[id].name}`);
    names.set(n, id);
    if (/\d$/.test(n)) problems.push(`${id} has a numbered name`);
  }
  const accents = new Map<string, string>();
  for (const v of Object.values(CREW_VARIANTS)) {
    const a = v.accent.toLowerCase();
    const k = `${v.base}:${a}`;
    if (accents.has(k)) problems.push(`${v.id} and ${accents.get(k)} share the accent ${a} on ${v.base}`);
    accents.set(k, v.id);
    if (RESERVED_ACCENTS.includes(a)) problems.push(`${v.id} uses the needs-you pink ${a}`);
    if (v.base === "unit" && a === UNKNOWN_GREY) problems.push(`${v.id} uses the plain unknown grey`);
    if (CHARACTER_FAMILY[v.id] !== CHARACTER_FAMILY[v.base] && v.base !== "unit") problems.push(`${v.id} is drawn from another family's base ${v.base}`);
  }
  for (const f of PARALLEL_FAMILIES) if (new Set(FAMILY_POOLS[f]).size < 3) problems.push(`${f} has fewer than 3 characters`);
  if (CHARACTER_FAMILY[COORDINATOR_CHARACTER] !== "orchestrator") problems.push("basil is not the orchestrator");
  return problems;
}
