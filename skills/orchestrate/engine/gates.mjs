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
 * Markers written before occurrences existed have three facts. They parse with
 * `occurrence: null` — no identity — and nothing here rewrites them or gives
 * them one.
 */

import { randomBytes } from "node:crypto";

import { digest, normaliseQuestion } from "./comments.mjs";

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
 * - `null` when it is already at this gate, has no `Gate-Id`, and the store's
 *   latest gate marker for the key is an opening of this question without an
 *   occurrence: a gate an earlier engine opened. It stays without identity
 *   rather than being given an invented one.
 * - Otherwise a new occurrence.
 *
 * `markers` is every marker line in the ticket's store, in the order written;
 * it is consulted only for the second case.
 *
 * @returns {{occurrence: string|null, reused: boolean, legacy: boolean}}
 */
export function occurrenceForOpen({ claim, key, question, markers = () => [] }) {
  const atThisGate = claim.state === "human-gate" && claim.gate === normaliseQuestion(question);
  if (atThisGate && isGateOccurrence(claim.gateId)) return { occurrence: claim.gateId, reused: true, legacy: false };
  if (atThisGate && !claim.gateId) {
    const latest = (typeof markers === "function" ? markers() : markers)
      .map(parseGateMarker)
      .filter((parsed) => parsed && parsed.key === key)
      .at(-1);
    if (latest && latest.event === "gate-opened" && latest.occurrence === null && latest.digest === digest(normaliseQuestion(question))) {
      return { occurrence: null, reused: true, legacy: true };
    }
  }
  return { occurrence: newGateOccurrence(), reused: false, legacy: false };
}
