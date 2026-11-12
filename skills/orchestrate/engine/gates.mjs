/**
 * Gate occurrences: which opening of a human gate a note belongs to.
 *
 * A gate's markers name its ticket and a digest of its question. That is not
 * enough to tell occurrences apart: the same question can be opened, resolved,
 * and opened again, and both openings would carry one marker. So every gate the
 * engine opens gets an occurrence, recorded in the worker's state file as
 * `- Gate-Id: <occurrence>` before anything is written to the store, and named
 * as a fourth fact in both of its markers:
 *
 *     <!-- pathfinder:orchestrate gate-opened 53.2 3f1c0a9e72b4 9d2e41c07a5b -->
 *     <!-- pathfinder:orchestrate gate-resolved 53.2 3f1c0a9e72b4 9d2e41c07a5b -->
 *
 * The occurrence is a random nonce, not a clock reading and not a count of the
 * notes already in the store. A count is only as good as the history it
 * counts, and that history has gaps: a note whose write failed, a gate a worker
 * opened by editing its state file, and every re-opening an earlier engine
 * skipped. A nonce is unique without trusting that history. A retry reads the
 * occurrence back from the state file, so retrying an open or a resolve
 * re-writes the same marker, which the store already holds; a new opening
 * draws a new nonce, so its notes never merge with an earlier one's.
 *
 * Every way an occurrence ends writes its resolved marker: `gate resolve`, with
 * the human's decision, or `state --set` to any other state, with a note that
 * a state change closed it and no decision.
 *
 * Markers written before occurrences existed have three facts. They parse with
 * `occurrence: null` — no identity — and nothing here rewrites them or gives
 * them one.
 */

import { randomBytes } from "node:crypto";

import { normaliseQuestion } from "./comments.mjs";

/** The state-file field holding the open gate's occurrence. */
export const GATE_ID_FIELD = "Gate-Id";

/** A new, never-before-used occurrence: 12 hex characters of randomness. */
export function newGateOccurrence() {
  return randomBytes(6).toString("hex");
}

/** Whether a value is an occurrence this module would have written. */
export function isGateOccurrence(value) {
  return /^[0-9a-f]{12}$/.test(String(value ?? ""));
}

/**
 * A gate marker line, parsed.
 *
 * @returns {{event: "gate-opened"|"gate-resolved", key: string, digest: string,
 *            occurrence: string|null} | null}
 *          null for any line that is not a gate marker. `occurrence` is null
 *          for a marker written before occurrences existed.
 */
export function parseGateMarker(line) {
  const match = /^<!-- pathfinder:orchestrate (gate-opened|gate-resolved) (\S+) ([0-9a-f]{12})(?: ([0-9a-f]{12}))? -->$/.exec(
    String(line ?? "").trim(),
  );
  if (!match) return null;
  return { event: match[1], key: match[2], digest: match[3], occurrence: match[4] ?? null };
}

/**
 * The occurrence an opening of `question` on `claim` writes under.
 *
 * - The claim's own recorded `Gate-Id`, when it is already at a gate with this
 *   question: a retry, which reuses it.
 * - Otherwise a new occurrence.
 *
 * A claim at this gate with no `Gate-Id` — one a worker set by hand, or one an
 * earlier engine opened — gets a new occurrence too. The durable record cannot
 * tell an earlier engine's still-open gate from one that engine closed without
 * a note (its `state --set` wrote none) and a worker then reopened by hand: the
 * state file and the three-fact marker read the same either way. Treating both
 * as new is the safe error. At worst one physical gate carries two openings,
 * the earlier engine's note without identity and this one with it, and nothing
 * is lost; the opposite error would leave a genuinely new opening with no
 * identity at all. The earlier note is never rewritten or given an occurrence.
 *
 * @returns {{occurrence: string, reused: boolean}}
 */
export function occurrenceForOpen({ claim, question }) {
  const atThisGate = claim.state === "human-gate" && claim.gate === normaliseQuestion(question);
  if (atThisGate && isGateOccurrence(claim.gateId)) return { occurrence: claim.gateId, reused: true };
  return { occurrence: newGateOccurrence(), reused: false };
}
