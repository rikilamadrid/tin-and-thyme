// Pure decisions about what the kitchen shows for a Pathfinder run: the coordinator's attention state,
// how a finished session ended, and which board column a ticket belongs in. No I/O here.

import type { AgentState, SessionEnd } from "../src/data/types";
import { readReport } from "./attribution";

// ---------------------------------------------------------------- the coordinator's attention

export interface AttentionInput {
  /** The coordinator's turn ended (Stop hook, or its transcript's last word after a restart). */
  turnEnded: boolean;
  /** Dispatched workers whose sessions are live right now. */
  liveWorkers: number;
  /** Tickets with an open human gate (a `human-gate` row or an open `gate-*` action item). */
  openGates: string[];
  /** A permission prompt or question the coordinator raised and nobody has answered yet (its note), else null. */
  asking: string | null;
}

/**
 * What the coordinator is waiting on. A real ask (an open gate, a permission prompt, or a question with no
 * live workers) needs the human; a turn that ended while dispatched workers run is waiting on them.
 * Null: its turn is open, and what it shows is the hooks' (working, or a permission prompt they reported).
 */
export function coordinatorAttention(i: AttentionInput): { state: AgentState; note: string } | null {
  // A turn in progress is the hooks' to show (working, or a permission prompt they reported).
  if (!i.turnEnded) return null;
  if (i.asking) return { state: "needs-input", note: i.asking };
  if (i.openGates.length) {
    const keys = [...new Set(i.openGates)].sort();
    return { state: "needs-input", note: `Asking: ${keys.join(", ")} ${keys.length === 1 ? "needs" : "need"} your decision` };
  }
  if (i.liveWorkers > 0) return { state: "waiting", note: `Waiting on ${i.liveWorkers} worker${i.liveWorkers === 1 ? "" : "s"}` };
  return { state: "needs-input", note: "Asking: answer the coordinator in its terminal" };
}

// ---------------------------------------------------------------- how a session ended

/** The checkpoint state a session of this kind works in; recording anything else is its handoff. */
const OWN_STATE: Record<string, string> = { adversary: "adversary", review: "review", repair: "repair" };

/**
 * How a stopped session ended, from the state Pathfinder recorded for its ticket when it stopped. Only a
 * recorded next stage (or done / integrated) is a handoff; a session that stopped leaving its own stage
 * in place was interrupted.
 */
export function sessionOutcome(session: string, recorded: string | null): SessionEnd["outcome"] {
  if (recorded === "human-gate") return "gate";
  if (recorded === "failed") return "failed";
  if (!recorded || recorded === (OWN_STATE[session] ?? "working")) return "interrupted";
  return "handed-off";
}

/**
 * How a stopped session ended. Its own report decides first: a session that reported DONE, PASS or FINDINGS
 * handed off, GATE stopped at a human gate, FAILED failed. Without a report, the ticket's recorded state
 * decides (sessionOutcome). `next` is a recorded later stage only, never the session's own.
 */
export function sessionEnding(
  session: string,
  report: string | null,
  rec: { state: string | null; last: string | null; gate: string | null },
  at = new Date().toISOString(),
): SessionEnd {
  const r = readReport(report);
  const own = OWN_STATE[session] ?? "working";
  const later = rec.state && rec.state !== own && !["human-gate", "failed"].includes(rec.state) ? rec.state : null;
  if (r) {
    const outcome: SessionEnd["outcome"] = r.verdict === "GATE" ? "gate" : r.verdict === "FAILED" ? "failed" : "handed-off";
    return { outcome, next: outcome === "handed-off" ? later : null, result: r.text || rec.last, verdict: r.verdict, at };
  }
  const outcome = sessionOutcome(session, rec.state);
  return { outcome, next: outcome === "handed-off" ? rec.state : null, result: outcome === "gate" ? rec.gate ?? rec.last : rec.last, at };
}

// ---------------------------------------------------------------- the board

/** A ticket's board view: the one shared mapping every surface uses (src/data/ticketStage.ts). */
export { ticketView } from "../src/data/ticketStage";
