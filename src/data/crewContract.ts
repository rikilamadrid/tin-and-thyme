// The Pass · crew contract (Feature 09, ticket 09.1). The prose version is docs/crew-contract.md.
//
// Four identities, kept apart:
//   role       the Pathfinder role contract (roles/<role>.md): read-only here, owned by Feature 07;
//   character  a persistent visual robot (CrewCharacterId): name and colour customizable, never a role;
//   session    one Pathfinder execution session (CrewSession): always fresh, never resumed;
//   ticket     durable, passes through many sessions.
// A character holds at most one live session. Everything here is pure data and pure functions,
// shared by the server (09.3 registry) and the UI (09.4 settings, 09.5 galley, 09.6 telemetry).

import { CREW_CHARACTERS, type CharacterId } from "./crew";
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
  if (r && ROLE_FAMILY[r]) return ROLE_FAMILY[r];
  if (s && s in STAGE_FAMILY) return STAGE_FAMILY[s as CrewStage];
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
  /** Tool calls observed so far. */
  tools: number;
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
  /** The session kind verbatim (brief `Session:`); unknown kinds are kept as written. */
  stage: CrewStage | (string & {});
  family: RoleFamily;
  ticket: string | null;
  /** The ticket title from the brief header. */
  title: string | null;
  worktree: string | null;
  /** For a helper: the hqId of the session that launched it. */
  parent: string | null;
  /** The character this session wears for its whole life; null = overflow (no free character). */
  characterId: CrewCharacterId | null;
  /** Set only when a migration conflict moved the session off its legacy character. */
  reassignedFrom: CrewCharacterId | null;
  phase: "live" | "ended";
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
  legacy: { name: string; job: string; character: CharacterId } | null;
}

// ---------------------------------------------------------------- Characters (persisted)

export interface CrewCharacterRecord {
  id: CrewCharacterId;
  family: RoleFamily;
  /** Visual customization only. null = the catalogue value. Never implies a role change. */
  name: string | null;
  color: string | null;
  /** The live session this character holds now (invariant: at most one). */
  sessionId: string | null;
  lastSessionId: string | null;
  /** When it last became available (ISO); null while holding a session. */
  availableSince: string | null;
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

export function emptyCrewBook(kitchen: string, now: string): CrewBook {
  return { schema: CREW_BOOK_SCHEMA, version: CREW_BOOK_VERSION, kitchen, updatedAt: now, characters: {}, sessions: {}, migrations: [] };
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

/** How long a finished character keeps its handoff pose before it walks off as available. */
export const FINISHED_LINGER_MS = 6000;
/** An observation older than this is stale, and the state is unknown. */
export const OBSERVATION_STALE_MS = 120_000;

/** What the server observed for a live session (from AgentStatus and Feature 06 attention). */
export interface CrewObservation {
  session: SessionState;
  agent: AgentState;
  /** Tool calls seen; 0 keeps the starting badge. */
  tools: number;
  /** Feature 06's verdict: needs-you only for a real gate, permission or question. */
  attention: { kind: "needs-you" | "waiting"; reason: string } | null;
  at: string;
}

/** A character's state, from observed data only. `session` is the one it holds (or last held). */
export function deriveCrewState(session: CrewSession | null, obs: CrewObservation | null, now: number): CrewState {
  if (!session) return "available";
  if (session.phase === "ended") {
    const ended = session.endedAt ? Date.parse(session.endedAt) : NaN;
    return Number.isFinite(ended) && now - ended < FINISHED_LINGER_MS ? "finished" : "available";
  }
  if (!obs || now - Date.parse(obs.at) > OBSERVATION_STALE_MS) return "unknown";
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
 *  2. Candidates: the family's pool, minus retired characters and any holding a live session.
 *  3. Prefer the candidate whose last session was on the same ticket; else the first in pool order.
 *  4. No candidate -> null: the session is overflow (shown in the compact crew list). Never a
 *     numbered copy, never another family's character, never a cap on real sessions.
 */
export function allocateCharacter(book: Pick<CrewBook, "characters" | "sessions">, family: RoleFamily, ticket: string | null): CrewCharacterId | null {
  if (family === "orchestrator") return COORDINATOR_CHARACTER;
  const free = FAMILY_POOLS[family].filter((id) => {
    const c = book.characters[id];
    if (!c) return true;
    if (c.retired) return false;
    return !c.sessionId || book.sessions[c.sessionId]?.phase !== "live";
  });
  if (ticket) {
    const same = free.find((id) => {
      const last = book.characters[id]?.lastSessionId;
      return !!last && book.sessions[last]?.ticket === ticket;
    });
    if (same) return same;
  }
  return free[0] ?? null;
}

// ---------------------------------------------------------------- Names

export const MAX_CREW_NAME = 24;

/** The name a character shows: its custom name, else the catalogue name. */
export function crewName(id: CrewCharacterId, record?: CrewCharacterRecord | null): string {
  return record?.name ?? CREW_CHARACTERS[id].name;
}

/**
 * Why a custom name is refused, or null when it is fine. Names stay unique (trimmed,
 * case-insensitive) across every catalogue name and every other custom name, and never end in a
 * number ("Dash 2"). Renaming changes nothing but the label.
 */
export function crewNameProblem(id: CrewCharacterId, name: string, characters: CrewBook["characters"]): string | null {
  const n = name.trim();
  if (!n) return "A name can't be empty.";
  if (n.length > MAX_CREW_NAME) return `A name is at most ${MAX_CREW_NAME} characters.`;
  if (/\s\d+$/.test(n)) return "A name can't end in a number.";
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
    if (/\s\d+$/.test(n)) problems.push(`${id} has a numbered name`);
  }
  for (const f of PARALLEL_FAMILIES) if (new Set(FAMILY_POOLS[f]).size < 3) problems.push(`${f} has fewer than 3 characters`);
  if (CHARACTER_FAMILY[COORDINATOR_CHARACTER] !== "orchestrator") problems.push("basil is not the orchestrator");
  return problems;
}
