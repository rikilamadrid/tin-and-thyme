// Pathfinder's durable gate record, as the kitchen reads it. Read only: nothing here writes to the project.
//
// The engine gives every gate it opens an occurrence (skills/orchestrate/engine/gates.mjs): 12 hex characters
// of randomness, recorded as `- Gate-Id: <occurrence>` in the worker's state file while the gate is open, and
// named in both of its notes in the ticket:
//
//     <!-- pathfinder:orchestrate gate-opened 53.2 3f1c0a9e72b4 9d2e41c07a5b -->
//     <!-- pathfinder:orchestrate gate-resolved 53.2 3f1c0a9e72b4 9d2e41c07a5b -->
//
// The same question opened again is a different occurrence, a retry reuses its occurrence, and an occurrence is
// never used twice. That identity is the only thing the kitchen tells two gates apart by. A gate with no
// occurrence (set by hand in the state file, or written by a kit from before occurrences) has no identity,
// and none is made up for it from its text or from when it was seen.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Whether a value is an occurrence the engine would have written. */
export function isGateOccurrence(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

export interface GateMarker {
  event: "gate-opened" | "gate-resolved";
  key: string;
  /** The digest of the gate's question (the engine's, not recomputed here). */
  digest: string;
  /** Null for a marker written before occurrences existed: no identity. */
  occurrence: string | null;
}

/** One line of a ticket's notes as a gate marker, or null. The same grammar the engine parses. */
export function parseGateMarker(line: string): GateMarker | null {
  const m = /^<!-- pathfinder:orchestrate (gate-opened|gate-resolved) (\S+) ([0-9a-f]{12})(?: ([0-9a-f]{12}))? -->$/.exec(line.trim());
  return m ? { event: m[1] as GateMarker["event"], key: m[2], digest: m[3], occurrence: m[4] ?? null } : null;
}

/** A ticket's gate history, from the notes the engine appended to it. */
export interface GateHistory {
  /**
   * False when the ticket's notes can't be read as a file in its claim's worktree (a GitHub Issues store keeps
   * them as issue comments). Then nothing below is known, and only the state file's `Gate-Id` identifies a gate.
   */
  readable: boolean;
  /** Occurrences with an opened note, in the order written. */
  opened: string[];
  /** Occurrences with a resolved note (answered, or closed by a state change), in the order written. */
  resolved: string[];
  /** Gate notes with no occurrence (an earlier kit's): they identify nothing. */
  unidentified: number;
}

const UNREADABLE: GateHistory = { readable: false, opened: [], resolved: [], unidentified: 0 };

/** The gate history in a ticket file's text, for `key` only. */
export function gateHistory(text: string | null, key: string): GateHistory {
  if (text === null) return UNREADABLE;
  const out: GateHistory = { readable: true, opened: [], resolved: [], unidentified: 0 };
  for (const line of text.split(/\r?\n/)) {
    const m = parseGateMarker(line);
    if (!m || m.key !== key) continue;
    if (!m.occurrence) out.unidentified += 1;
    else {
      const list = m.event === "gate-opened" ? out.opened : out.resolved;
      if (!list.includes(m.occurrence)) list.push(m.occurrence);
    }
  }
  return out;
}

/**
 * The ticket file the engine appends a claim's notes to (a local Markdown store): the one the state file's
 * `Store:` line names, else `context/tickets/<key>-*.md`, both inside the claim's worktree. Null when there
 * is none there.
 */
export function ticketNotesFile(worktree: string, key: string, storeLine: string | null): string | null {
  const ref = storeLine ? /,\s*(\S+)\s*$/.exec(storeLine)?.[1] : null;
  if (ref && !ref.split(/[\\/]/).includes("..")) {
    const named = join(worktree, ...ref.split("/"));
    if (existsSync(named)) return named;
  }
  const dir = join(worktree, "context", "tickets");
  try {
    const file = readdirSync(dir).find((f) => f.startsWith(`${key}-`) && f.endsWith(".md"));
    return file ? join(dir, file) : null;
  } catch {
    return null;
  }
}

/** A claim's gate history, read from its ticket file. Unreadable (never guessed) when the file isn't there. */
export function readGateHistory(worktree: string, key: string, storeLine: string | null): GateHistory {
  const file = ticketNotesFile(worktree, key, storeLine);
  if (!file) return UNREADABLE;
  try {
    return gateHistory(readFileSync(file, "utf8"), key);
  } catch {
    return UNREADABLE;
  }
}

/**
 * A gate request's revision: what an answer must name to be sent.
 *
 * With an occurrence it is that occurrence, so the same question opened again is a different request, and a
 * retried opening is the same one. Without an occurrence there is no identity to use, so it is the ticket and
 * the exact text (a changed text is a new request; a repeated text can't be told apart).
 */
export function gateRevision(key: string, text: string, occurrence: string | null): string {
  if (occurrence) return `${key}#${occurrence}`;
  let h = 2166136261;
  for (const ch of `${key}\n${text}`) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return `${key}:${h.toString(36)}`;
}
