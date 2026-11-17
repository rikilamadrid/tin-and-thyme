// Persistent crew storage. This module never launches or resumes a conversation.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CREW_BOOK_FILE, CREW_BOOK_SCHEMA, CREW_BOOK_VERSION, ROLE_FAMILIES, isCrewCharacterId,
  migrateLegacy, reconcileAfterRestore, restoreSession, startSession, endSession, continueSession, latestOccurrence, conversationOccurrences,
  customizeCharacter, retireCharacter,
  type CrewBook, type CrewCharacterId, type CrewContinuation, type CrewObservation, type CrewSession, type CrewSessionFacts,
  type CrewState, type CrewTelemetry, type LegacyCrewJson, type LegacySessionsJson,
} from "../src/data/crewContract";
import { crewSnapshot } from "../src/data/crewSnapshot";
import type { SessionEnd } from "../src/data/types";

export type EndingEvidence = SessionEnd & { key?: string; session?: string; occurrence?: string; consumed?: string; terminalBoundary?: TerminalBoundary };
/**
 * Where a worker's ended turn stood in its transcript when the ending was recorded. Written once with the
 * ending, never rewritten. `turns`, `starts` and `tools` are absent in books written before they were kept.
 */
export interface TerminalBoundary {
  /** The terminal record visible in the transcript at that moment (an earlier turn's while `pending`). */
  revision: string | null;
  /** This turn's own terminal record was not on disk yet. */
  pending: boolean;
  /** Turn starts the transcript holds once this turn's own bytes are all on disk: a later one is a later turn. */
  turns?: number;
  /**
   * Written by `6552316` only, never now: every prompt-shaped record then on disk or owed, mid-turn ones included.
   * It is not a turn count. Read only for what the ended turn still owed (docs/crew-contract.md).
   */
  starts?: number;
  /** Tool calls of this turn seen through hooks whose records were not on disk yet: a replay of one is not a resume. */
  tools?: string[];
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === "string";

/** A missing file is an empty input. Unreadable storage is never evidence of corrupt data. */
function readOptional(file: string): string | null {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`Cannot read crew storage (${code ?? "I/O error"}): ${file}; existing files left unchanged`, { cause: error });
  }
}

function endingProblem(value: unknown, legacy = false): string | null {
  if (!record(value)) return "ending must be an object";
  if (!["handed-off", "interrupted", "failed", "gate"].includes(value.outcome)) return "outcome must be handed-off, interrupted, failed or gate";
  if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return "at must be a valid timestamp";
  for (const field of ["next", "result"])
    if (!nullableString(value[field]) && !(legacy && value[field] === undefined)) return `${field} must be a string or null`;
  if (value.verdict !== undefined && value.verdict !== null && !["DONE", "PASS", "FINDINGS", "GATE", "FAILED"].includes(value.verdict)) return "verdict is invalid";
  for (const field of ["key", "session", "occurrence", "consumed"])
    if (value[field] !== undefined && typeof value[field] !== "string") return `${field} must be a string when present`;
  const b = value.terminalBoundary;
  if (b !== undefined && (!record(b) || !nullableString(b.revision) || typeof b.pending !== "boolean" ||
    (b.turns !== undefined && !(Number.isInteger(b.turns) && b.turns >= 0)) ||
    (b.starts !== undefined && !(Number.isInteger(b.starts) && b.starts >= 0)) ||
    (b.tools !== undefined && !(Array.isArray(b.tools) && b.tools.every((id: unknown) => typeof id === "string"))))) return "terminalBoundary is invalid";
  return null;
}

function readLegacy(directory: string, name: "crew.json" | "sessions.json"): Record<string, any> {
  const file = join(directory, name);
  const text = readOptional(file);
  if (text === null) return {};
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid legacy JSON: ${file}; original bytes and crew book left unchanged`, { cause: error }); }
  if (!record(value)) throw new Error(`Invalid legacy input: ${file}; expected an object; original bytes and crew book left unchanged`);
  for (const [id, entry] of Object.entries(value)) {
    const problem = !id ? "session id is empty" : name === "sessions.json" ? endingProblem(entry, true)
      : !record(entry) || ["id", "name", "job"].some((field) => typeof entry[field] !== "string")
        ? "crew entry requires string id, name and job" : null;
    if (problem) throw new Error(`Invalid legacy entry ${JSON.stringify(id)} in ${file}: ${problem}; original bytes and crew book left unchanged`);
    // Older outcomes omitted these optional details. Keep all other fields verbatim.
    if (name === "sessions.json") value[id] = { ...entry, next: entry.next ?? null, result: entry.result ?? null };
  }
  return value;
}


/** A first occurrence has no link; a continuation names an earlier occurrence of its own conversation and how the resume was seen. */
function validContinuation(sessions: Record<string, any>, s: Record<string, any>): boolean {
  const c = s.continuation;
  if (c === null) return true;
  const of = record(c) && typeof c.of === "string" ? sessions[c.of] : null;
  return record(c) && record(of) && of.id !== s.id && (of.conversation ?? of.id) === s.conversation &&
    ["tool", "transcript", "hook"].includes(c.via) && nullableString(c.evidence);
}

/** Refuse an invalid book before mutation. Unknown future versions are handled separately, read-only. */
function validBook(v: unknown, kitchen: string): v is CrewBook {
  if (!record(v) || v.schema !== CREW_BOOK_SCHEMA || v.version !== CREW_BOOK_VERSION || v.kitchen !== kitchen ||
    typeof v.updatedAt !== "string" || !record(v.characters) || !record(v.sessions) || !Array.isArray(v.migrations) || !v.characters.basil) return false;
  if (v.restorePass != null && (!record(v.restorePass) || !Number.isInteger(v.restorePass.firstSeq))) return false;
  for (const [id, c] of Object.entries(v.characters)) {
    if (!isCrewCharacterId(id) || !record(c) || c.id !== id || !ROLE_FAMILIES.includes(c.family) || typeof c.firstSeen !== "string" || typeof c.retired !== "boolean" ||
      ![c.name, c.color, c.sessionId, c.lastSessionId, c.availableSince].every(nullableString)) return false;
  }
  const seqs = new Set<number>();
  for (const [id, s] of Object.entries(v.sessions)) {
    if (!record(s) || s.id !== id || !["worker", "helper", "coordinator"].includes(s.kind) || !ROLE_FAMILIES.includes(s.family) ||
      !["live", "ended"].includes(s.phase) || !Number.isInteger(s.seq) || s.seq < 0 || seqs.has(s.seq) ||
      ![s.hqId, s.role, s.stage, s.ticket, s.title, s.worktree, s.parent, s.startedAt, s.endedAt, s.transcript].every(nullableString) ||
      (s.characterId !== null && !isCrewCharacterId(s.characterId)) || (s.reassignedFrom !== null && !isCrewCharacterId(s.reassignedFrom)) ||
      (s.end !== null && endingProblem(s.end) !== null) || typeof s.conversation !== "string" || !s.conversation || !validContinuation(v.sessions, s) ||
      (s.telemetry !== null && !record(s.telemetry)) || (s.legacy !== null && !record(s.legacy))) return false;
    seqs.add(s.seq);
  }
  return v.migrations.every((m: unknown) => record(m) && typeof m.backup === "string" && Array.isArray(m.imported) && Array.isArray(m.filled) && Array.isArray(m.conflicts));
}

export class CrewRegistry {
  readonly book: CrewBook;
  readonly observations: Record<string, CrewObservation> = {};
  private states = new Map<CrewCharacterId, { state: CrewState; since: string }>();
  private saved = "";

  constructor(readonly directory: string, readonly kitchen: string, now = new Date().toISOString()) {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, CREW_BOOK_FILE);
    let existing: CrewBook | null = null;
    const text = readOptional(file);
    let corrupt = false;
    if (text !== null) {
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { /* actual JSON corruption, quarantine after validating inputs */ }
      if (record(raw) && typeof raw.version === "number" && raw.version > CREW_BOOK_VERSION)
        throw new Error(`Crew book version ${raw.version} is newer than supported ${CREW_BOOK_VERSION}; left read-only: ${file}`);
      if (record(raw) && typeof raw.kitchen === "string" && raw.kitchen !== kitchen)
        throw new Error(`Crew book belongs to ${raw.kitchen}, not ${kitchen}; left read-only: ${file}`);
      // Books written before conversations and occurrences were kept apart: every session was its
      // conversation's only occurrence. Read as such; nothing is written until a later save.
      if (record(raw) && record(raw.sessions)) for (const session of Object.values(raw.sessions)) if (record(session)) {
        if (session.conversation === undefined) session.conversation = session.id;
        if (session.continuation === undefined) session.continuation = null;
      }
      if (validBook(raw, kitchen)) existing = raw;
      else corrupt = true;
    }
    // Validate every source before quarantine, backup or adoption. A malformed legacy record
    // cannot poison the replacement book or cause an existing book to be moved out of the way.
    const crew = readLegacy(directory, "crew.json") as LegacyCrewJson;
    const endings = readLegacy(directory, "sessions.json") as Record<string, EndingEvidence>;
    const backup = join(directory, "backups", `crew-${now.replace(/[:.]/g, "-")}-${randomUUID()}`);
    this.book = migrateLegacy(crew, endings as LegacySessionsJson, existing, { kitchen, now, backup });
    // Older contract data kept only the basic outcome. Preserve all legacy outcome facts and links,
    // including review verdict and the gate occurrence used by Feature 06, before the first write.
    for (const [id, ending] of Object.entries(endings)) {
      const session = this.book.sessions[id];
      if (!session || !record(ending)) continue;
      if (existing?.sessions[id]?.end == null && session.end) session.end = { ...ending };
      restoreSession(this.book, id, { phase: session.phase, ticket: typeof ending.key === "string" ? ending.key : null, stage: typeof ending.session === "string" ? ending.session : null }, now);
    }
    if (!validBook(this.book, kitchen)) throw new Error(`Crew migration produced an invalid book; existing files left unchanged: ${file}`);
    if (corrupt) {
      mkdirSync(join(directory, "backups"), { recursive: true });
      renameSync(file, join(directory, "backups", `crew-book.corrupt-${now.replace(/[:.]/g, "-")}-${randomUUID()}.json`));
    }
    if (this.book.migrations.length > (existing?.migrations.length ?? 0)) {
      mkdirSync(backup, { recursive: true });
      for (const name of ["crew.json", "sessions.json", "coordinator.json", CREW_BOOK_FILE]) {
        if (existsSync(join(directory, name))) copyFileSync(join(directory, name), join(backup, name));
      }
    }
    // migrateLegacy opens restore on EVERY start. Nothing is published or written until reconcile.
  }

  start(id: string, facts: CrewSessionFacts, now = new Date().toISOString()) {
    return startSession(this.book, id, facts, now);
  }

  /** The occurrence a conversation is in now (or was last in). */
  latest(conversation: string): CrewSession | null {
    return latestOccurrence(this.book, conversation);
  }

  /**
   * Re-observes a conversation: `id` is the Claude conversation id, and the facts go to its latest
   * occurrence. An ended occurrence is never revived by this; a resume needs `resume()`.
   */
  restore(id: string, facts: CrewSessionFacts & { phase: "live" | "ended"; end?: SessionEnd | null; endedAt?: string | null }, now = new Date().toISOString()) {
    return restoreSession(this.book, this.latest(id)?.id ?? id, facts, now);
  }

  /**
   * The same conversation was seen running again after its last occurrence ended: a new linked
   * occurrence, once. Returns the occurrence this resume belongs to: an ended one means this very
   * resume was already recorded and is over (a duplicate event). null for an unknown conversation.
   */
  resume(conversation: string, resume: Pick<CrewContinuation, "via" | "evidence">, now = new Date().toISOString()) {
    return continueSession(this.book, conversation, resume, now);
  }

  /** The newest recorded ending of a conversation, whichever occurrence it belongs to. */
  lastEnding(conversation: string): EndingEvidence | null {
    return conversationOccurrences(this.book, conversation).reverse().find((s) => s.end)?.end ?? null;
  }

  /** Every recorded ending of a conversation, oldest first. */
  endings(conversation: string): EndingEvidence[] {
    return conversationOccurrences(this.book, conversation).flatMap((s) => (s.end ? [s.end as EndingEvidence] : []));
  }

  end(id: string, ending: EndingEvidence | null, now = new Date().toISOString()) {
    endSession(this.book, id, ending, now);
    // An unknown ending can be filled later without changing the time the session ended.
    return restoreSession(this.book, id, { phase: "ended", end: ending }, now);
  }

  observe(id: string, observation: CrewObservation, telemetry?: CrewTelemetry) {
    const s = this.book.sessions[id];
    if (!s || s.phase !== "live") return;
    this.observations[id] = observation;
    if (!telemetry) return;
    // The reading's time moves only when a reading does, so an unchanged poll rewrites nothing.
    const same = s.telemetry && JSON.stringify({ ...s.telemetry, at: "" }) === JSON.stringify({ ...telemetry, at: "" });
    if (!same) s.telemetry = structuredClone(telemetry);
  }

  reconcile(runningIds: Iterable<string>, now = new Date().toISOString()) {
    if (!this.book.restorePass) return;
    reconcileAfterRestore(this.book, runningIds, now);
    this.save();
  }

  snapshot(now = Date.now()) {
    if (this.book.restorePass) return undefined;
    return crewSnapshot(this.book, this.observations, now, this.states);
  }

  customize(id: CrewCharacterId, change: { name?: string | null; color?: string | null }, now = new Date().toISOString()) {
    const error = customizeCharacter(this.book, id, change, now);
    if (!error) this.save();
    return error;
  }

  retire(id: CrewCharacterId, retired: boolean, now = new Date().toISOString()) {
    const error = retireCharacter(this.book, id, retired, now);
    if (!error) this.save();
    return error;
  }

  save() {
    if (this.book.restorePass) return;
    if (!validBook(this.book, this.kitchen)) throw new Error(`Refusing to persist an invalid crew book; existing file left unchanged: ${join(this.directory, CREW_BOOK_FILE)}`);
    const text = JSON.stringify(this.book, null, 2) + "\n";
    if (text === this.saved) return;
    const file = join(this.directory, CREW_BOOK_FILE);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    this.saved = text;
  }
}
