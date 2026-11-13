// Persistent crew storage. This module never launches or resumes a conversation.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CREW_BOOK_FILE, CREW_BOOK_SCHEMA, CREW_BOOK_VERSION, ROLE_FAMILIES, isCrewCharacterId,
  migrateLegacy, reconcileAfterRestore, restoreSession, startSession, endSession,
  customizeCharacter, retireCharacter,
  type CrewBook, type CrewCharacterId, type CrewObservation, type CrewSessionFacts,
  type CrewState, type CrewTelemetry, type LegacyCrewJson, type LegacySessionsJson,
} from "../src/data/crewContract";
import { crewSnapshot } from "../src/data/crewSnapshot";
import type { SessionEnd } from "../src/data/types";

export type EndingEvidence = SessionEnd & { key?: string; session?: string; occurrence?: string; consumed?: string };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === "string";

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
      (s.end !== null && (!record(s.end) || typeof s.end.at !== "string" || !["handed-off", "interrupted", "failed", "gate"].includes(s.end.outcome))) ||
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
    if (existsSync(file)) {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { /* quarantine below */ }
      if (record(raw) && typeof raw.version === "number" && raw.version > CREW_BOOK_VERSION)
        throw new Error(`Crew book version ${raw.version} is newer than supported ${CREW_BOOK_VERSION}; left read-only: ${file}`);
      if (record(raw) && typeof raw.kitchen === "string" && raw.kitchen !== kitchen)
        throw new Error(`Crew book belongs to ${raw.kitchen}, not ${kitchen}; left read-only: ${file}`);
      if (validBook(raw, kitchen)) existing = raw;
      else {
        mkdirSync(join(directory, "backups"), { recursive: true });
        renameSync(file, join(directory, "backups", `crew-book.corrupt-${now.replace(/[:.]/g, "-")}-${randomUUID()}.json`));
      }
    }
    const readLegacy = <T>(name: string): T => {
      const path = join(directory, name);
      if (!existsSync(path)) return {} as T;
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!record(raw)) throw new Error(`Invalid legacy crew input; left unchanged: ${path}`);
      return raw as T;
    };
    const crew = readLegacy<LegacyCrewJson>("crew.json");
    const endings = readLegacy<Record<string, EndingEvidence>>("sessions.json");
    const backup = join(directory, "backups", `crew-${now.replace(/[:.]/g, "-")}-${randomUUID()}`);
    this.book = migrateLegacy(crew, endings as LegacySessionsJson, existing, { kitchen, now, backup });
    // Older contract data kept only the basic outcome. Preserve all legacy outcome facts and links,
    // including review verdict and the gate occurrence used by Feature 06, before the first write.
    for (const [id, ending] of Object.entries(endings)) {
      const session = this.book.sessions[id];
      if (!session || !record(ending)) continue;
      if (!existing?.sessions[id] && session.end) session.end = { ...ending };
      restoreSession(this.book, id, { phase: session.phase, ticket: typeof ending.key === "string" ? ending.key : null, stage: typeof ending.session === "string" ? ending.session : null }, now);
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

  restore(id: string, facts: CrewSessionFacts & { phase: "live" | "ended"; end?: SessionEnd | null; endedAt?: string | null }, now = new Date().toISOString()) {
    return restoreSession(this.book, id, facts, now);
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
    if (telemetry) s.telemetry = structuredClone(telemetry);
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
    const text = JSON.stringify(this.book, null, 2) + "\n";
    if (text === this.saved) return;
    const file = join(this.directory, CREW_BOOK_FILE);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    this.saved = text;
  }
}
