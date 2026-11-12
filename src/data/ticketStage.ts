// One mapping from a Pathfinder ticket's facts to what every surface shows: the crew sidebar's ticket cards,
// the Boards drawer, the plan wall, the worker drawer's ticket line, and (later) Feature 10's delivery
// controls. Nothing else decides a ticket's label, column, next step or blocker.
//
// Two kinds of fact stay distinct here and are never rewritten to fix a label:
//   - execution state: the engine's row state (working, review, done, integrated, …);
//   - durable lifecycle: the ticket's own `## Status` (Proposed, Ready, In Progress, Complete, …).
// Delivery (a PR open, merged) is an input Feature 10 supplies; nothing here builds it.

import type { DeliveryStage, SessionEnd, TaskStatus } from "./types";

export type TicketStage =
  | "to-do"
  | "blocked"
  | "needs-you"
  | "in-progress"
  | "waiting-review"
  | "in-review"
  | "ready-to-deliver"
  | "awaiting-merge"
  | "completing"
  | "done"
  | "failed"
  | "interrupted"
  | "stale";

export interface TicketStageInput {
  /** The engine's execution state for the ticket. */
  state: string;
  /** The ticket's durable Pathfinder lifecycle (its `## Status`), as the engine reports it. */
  lifecycle?: string | null;
  /** The claim's checkpointed state (a pending stage the engine shows as `stale`). */
  recorded?: string | null;
  /** The open gate's text, verbatim, when the ticket is at a human gate. */
  gate?: string | null;
  /** The session kind of the live worker on this ticket (implementation, review, …), else null. */
  liveSession?: string | null;
  /** Its delivery, from Feature 10's delivery record: a PR is open, or it was merged. */
  delivery?: DeliveryStage | null;
  /** How the ticket's latest finished session ended, when none is live (an interrupted one is shown as such). */
  lastEnded?: SessionEnd["outcome"] | null;
}

export interface TicketView {
  stage: TicketStage;
  /** The one label every surface shows. */
  label: string;
  /** The board column. */
  column: TaskStatus;
  /** The verified next step, from engine and gate data; null when nothing is next. */
  next: string | null;
  /** A real blocker, verbatim where Pathfinder recorded one; null when there is none. */
  blocker: string | null;
}

/** The four delivery-facing labels, as every surface shows them. */
export const STAGE_LABEL = {
  inReview: "In review",
  readyToDeliver: "Ready to deliver",
  awaitingMerge: "Awaiting merge",
  done: "Done / Served",
} as const;

/**
 * Board column headings. The review column holds tickets waiting for a reviewer as well as those under review,
 * so its heading never claims a review is underway; each card's own label says which it is.
 */
export const COLUMN_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  "in-progress": "Doing",
  "in-review": "Waiting / in review",
  reviewed: STAGE_LABEL.readyToDeliver,
  done: STAGE_LABEL.done,
  blocked: "Blocked",
};

const PENDING = new Set(["adversary", "review", "repair"]);
const DOING: Record<string, string> = { implementation: "Developing", resume: "Developing (resume)", repair: "Repairing" };
const complete = (lifecycle: string | null | undefined) => /^complete$/i.test((lifecycle ?? "").trim());
const real = (s: string | null | undefined) => (s && s !== "—" ? s : null);

/** What a ticket shows, everywhere. */
export function ticketView(i: TicketStageInput): TicketView {
  // A pending stage the engine calls stale is that stage, waiting for its session.
  const state = i.state === "stale" && i.recorded && PENDING.has(i.recorded) ? i.recorded : i.state;
  const live = i.liveSession ?? null;
  const gate = real(i.gate);
  const v = (stage: TicketStage, label: string, column: TaskStatus, next: string | null, blocker: string | null = null): TicketView => ({ stage, label, column, next, blocker });

  // Claimed, no live session, and the last one stopped without recording a handoff.
  if (!live && i.lastEnded === "interrupted" && (i.state === "working" || i.state === "stale"))
    return v("interrupted", "Interrupted", i.state === "stale" ? "blocked" : "in-progress", "The coordinator resumes it, or a human decides", "Its last session stopped without recording a handoff");

  switch (state) {
    case "ready":
      return v("to-do", "Ready", "todo", "The coordinator claims it when it's eligible");
    case "blocked":
      return v("blocked", "Blocked", "blocked", null, gate ?? "Waits on its blocking tickets");
    case "human-gate":
      return v("needs-you", "Needs you", "blocked", "Answer the gate in Action items", gate ?? "A human decision is pending");
    case "working":
    case "implementation":
    case "repair":
      return live
        ? v("in-progress", DOING[live] ?? (state === "repair" ? "Repairing" : "Developing"), "in-progress", state === "repair" ? "The developer repairs the review findings" : "The developer implements and reports")
        : v("in-progress", state === "repair" ? "Waiting for repair" : "Waiting for developer", "in-progress", "The coordinator dispatches a developer");
    case "review":
    case "adversary":
      // In review only while a review is actually underway.
      return live
        ? v("in-review", state === "adversary" ? `${STAGE_LABEL.inReview} · adversary` : STAGE_LABEL.inReview, "in-review", "The reviewer reports PASS or FINDINGS")
        : v("waiting-review", state === "adversary" ? "Waiting for adversary review" : "Waiting for review", "in-review", "The coordinator dispatches a reviewer");
    case "done":
      if (i.delivery === "merged") return v("completing", "Merged · integration pending", "reviewed", "Pathfinder records the integration");
      if (i.delivery === "pr-open") return v("awaiting-merge", STAGE_LABEL.awaitingMerge, "reviewed", "A human merges the pull request");
      return v("ready-to-deliver", STAGE_LABEL.readyToDeliver, "reviewed", "A human delivers it (pull request or integration)");
    case "integrated":
      return complete(i.lifecycle)
        ? v("done", STAGE_LABEL.done, "done", null)
        : v("completing", "Integrated · completion pending", "reviewed", "Record the ticket's completion (/ticket complete)");
    case "failed":
      return v("failed", "Failed", "blocked", "A human decides how to continue", "The session reported failure");
    case "stale":
      return v("stale", "Claimed · no live session", "blocked", "The coordinator resumes or releases the claim", "No live session holds the claim");
    default:
      return v("blocked", state, "blocked", null, `Unrecognised Pathfinder state: ${state}`);
  }
}
