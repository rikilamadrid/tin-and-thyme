// In-app delivery (Feature 10): the browser-safe contract between the kitchen
// server and the delivery drawer, and the one set of rules both apply.
//
// The server (server/delivery/service.ts) builds a DeliveryView per ticket from
// the stored delivery state (server/delivery/state.ts), the engine's readiness
// and its in-memory inspection and status. The drawer renders it, and
// `gateOf` says which operation is allowed now and why not. The server checks
// the same gate before it runs anything, so a button the drawer disables is
// also refused when another client sends it.
//
// Nothing here talks to git, GitHub or the DOM.

export const DELIVERY_OPS = ["inspect", "approve", "acknowledgeNoChecks", "push", "ensurePr", "status", "merge", "verify"] as const;
export type DeliveryOp = (typeof DELIVERY_OPS)[number];

/** The recorded steps (state.ts STEPS). Acknowledging "no checks" is recorded as an approval. */
export const DELIVERY_STEPS = ["inspect", "approve", "push", "ensurePr", "status", "merge", "verify"] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

/**
 * Why an operation did not run. The first six come from the delivery core
 * (state.ts FailureKind); the rest from the kitchen:
 * - `origin`: the WebSocket client sent no browser Origin;
 * - `busy`: another operation for this ticket is running;
 * - `unavailable`: delivery is not available here, or the connection was lost.
 */
export type DeliveryFailure = "auth" | "invalid" | "refused" | "stale" | "blocked" | "failed" | "origin" | "busy" | "unavailable";

/** state.ts `mergeOutcome`: `none` (nothing sent), `pending`, `unknown`, `merged`, `not-merged`. */
export type MergeOutcome = "none" | "pending" | "unknown" | "merged" | "not-merged";

/** What GitHub reports. `none` means no checks were reported, which is never "passing". */
export type ChecksSummary = "none" | "passed" | "pending" | "failed";

export interface DeliveryReadiness {
  /** The engine's state for the ticket (`done`, `integrated`, …), or null when the engine has no row. */
  engineState: string | null;
  /** The reviewed head the claim records (`Last: review PASS on <full sha>`), or null. */
  reviewedHead: string | null;
  branch: string | null;
  /** Ready to deliver: engine state `done`, a recorded review PASS, and a live claim on ticket/<key>-*. */
  ready: boolean;
  /** Why it is not ready, when it is not. */
  reason: string | null;
}

export interface DeliveryApprovalView {
  key: string;
  head: string;
  base: string;
  tree: string;
  at: string | null;
  /** The human acknowledged that GitHub reports no checks, and merges on the local evidence. */
  acknowledgeNoChecks: boolean;
}

export interface DiffFile {
  path: string;
  /** Lines added and deleted; null for a binary file. */
  added: number | null;
  deleted: number | null;
}

/** The local verification evidence recorded for the reviewed head. */
export interface DeliveryEvidence {
  /** The claim's `Last:` line (`review PASS on <sha>`). */
  line: string | null;
  /** The independent review report for exactly this head, from the kitchen's machine-local transfer folder. */
  report: { file: string; text: string; truncated: boolean } | null;
}

/** One inspection, kept in the kitchen's memory only: a restart forgets it ("inspect again"). */
export interface InspectionView {
  at: string;
  key: string;
  repo: string;
  branch: string;
  title: string | null;
  head: string;
  reviewedHead: string;
  /** Commits after the reviewed head that change only the ticket record. */
  recordOnly: string[];
  recordPath: string | null;
  base: string;
  mergeBase: string;
  behind: boolean;
  tree: string;
  /** Binary files the secret scan could not read. */
  unscanned: string[];
  evidence: DeliveryEvidence;
  files: DiffFile[];
  filesTruncated: boolean;
  stat: { files: number; added: number; deleted: number };
}

export interface DeliveryCheck {
  name: string;
  bucket: string;
  state: string;
  link: string;
}

/** The last `status` result, kept in memory. */
export interface DeliveryStatusView {
  at: string;
  pr: { number: number; url: string; state: string; title: string; isDraft: boolean } | null;
  /** The PR's head, as GitHub reports it. */
  head: string | null;
  /** origin's base branch, freshly fetched. */
  base: string;
  checks: { summary: ChecksSummary; items: DeliveryCheck[] };
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  reviewDecision: string | null;
}

export interface StepView {
  step: DeliveryStep;
  ok: boolean;
  at: string;
  message: string;
  kind?: DeliveryFailure;
  fix?: string | null;
  reasons?: string[];
}

export interface MergedView {
  pr: number;
  commit: string | null;
  at: string;
  /** The approval the merge is bound to; null for a merge made outside the app until one verifies. */
  approval: DeliveryApprovalView | null;
  verification: { at: string; parent: string; tree: string; main: string } | null;
}

export interface DeliveryView {
  key: string;
  title: string | null;
  readiness: DeliveryReadiness;
  repo: string | null;
  branch: string | null;
  /** The last inspected head, base and expected merge tree (stored). */
  head: string | null;
  base: string | null;
  tree: string | null;
  inspection: InspectionView | null;
  approval: DeliveryApprovalView | null;
  approvalState: "none" | "valid" | "stale";
  /** Why the approval is stale: from the stored invalidation, the inspection, or the last status. */
  staleReasons: string[];
  invalidated: { at: string; reasons: string[]; approval: DeliveryApprovalView } | null;
  pr: { number: number; url: string } | null;
  status: DeliveryStatusView | null;
  outcome: MergeOutcome;
  /** The pending or unknown merge's note. */
  pendingNote: string | null;
  merged: MergedView | null;
  verified: boolean;
  lastAttempt: { at: string; pr: number; settledAt: string; reason: string } | null;
  /** The latest result of each step, in step order. */
  steps: StepView[];
  running: DeliveryOp | null;
  updated: string;
}

/** The snapshot's delivery field: every ticket the kitchen can deliver or has delivery state for. */
export interface DeliveryBoard {
  available: boolean;
  /** Why delivery is unavailable here. */
  reason: string | null;
  byKey: Record<string, DeliveryView>;
}

export type DeliveryReply =
  | { ok: true; id: string; op: DeliveryOp; key: string; message: string; data: unknown; view: DeliveryView | null }
  | { ok: false; id: string | null; op: DeliveryOp | null; key: string | null; kind: DeliveryFailure; message: string; fix: string | null; reasons: string[]; view: DeliveryView | null };

/** Request/reply over the kitchen's WebSocket. Never queued while disconnected. */
export interface DeliveryClient {
  request(op: DeliveryOp, params: Record<string, string>): Promise<DeliveryReply>;
}

// ---------------------------------------------------------------- rules

export interface Gate {
  kind: DeliveryFailure;
  message: string;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "—");

/**
 * Why an approval no longer holds, from what the kitchen knows without new
 * network calls: the last inspection and the last status. Empty when it holds.
 */
export function approvalReasons(
  approval: Pick<DeliveryApprovalView, "head" | "base" | "tree"> & { at?: string | null },
  current: { head: string | null; base: string | null; tree: string | null },
  status: DeliveryStatusView | null,
): string[] {
  // A status read before the approval says nothing about it (the human approved what they saw later).
  if (status && approval.at && status.at < approval.at) status = null;
  const reasons: string[] = [];
  if (current.head && current.head !== approval.head) reasons.push(`head moved from ${approval.head} to ${current.head}`);
  if (current.base && current.base !== approval.base) reasons.push(`base moved from ${approval.base} to ${current.base}`);
  if (current.tree && current.tree !== approval.tree) reasons.push(`expected merge tree changed from ${approval.tree} to ${current.tree}`);
  if (status) {
    if (status.base !== approval.base && !reasons.some((r) => r.startsWith("base moved"))) reasons.push(`origin's base moved from ${approval.base} to ${status.base}`);
    if (status.pr?.state === "OPEN" && status.head && status.head !== approval.head) reasons.push(`PR #${status.pr.number} head is ${status.head}, not the approved ${approval.head}`);
  }
  return reasons;
}

/**
 * Whether `op` may run now, and why not. One rule set: the drawer disables
 * buttons with it and the server refuses with it before calling the delivery
 * core (which re-validates everything live anyway). Null means allowed.
 */
export function gateOf(view: DeliveryView, op: DeliveryOp): Gate | null {
  if (view.running) return { kind: "busy", message: `${view.running} is running for ${view.key}; wait for it to finish` };
  const outcome = view.outcome;
  const notReady = view.readiness.ready ? null : ({ kind: "refused", message: `Not deliverable: ${view.readiness.reason ?? "not ready"}` } as Gate);
  const settled = (): Gate | null => {
    if (outcome === "merged") return { kind: "refused", message: `PR #${view.merged?.pr ?? view.pr?.number ?? "?"} is already merged; verify it instead` };
    if (outcome === "pending" || outcome === "unknown") return { kind: "blocked", message: "Outcome not confirmed — do not merge again. Check the outcome first." };
    return null;
  };
  const approved = (): Gate | null => {
    if (view.approvalState === "stale") return { kind: "stale", message: `The approval is stale (${view.staleReasons.join("; ") || "the head or base moved"}); inspect and approve again` };
    if (!view.approval || view.approvalState !== "valid") return { kind: "refused", message: "Approve this exact merge first" };
    return null;
  };
  const statusFor = (head: string): Gate | null => {
    if (!view.status) return { kind: "blocked", message: "Refresh the PR status first" };
    if (!view.status.pr) return { kind: "blocked", message: "GitHub reports no PR for this branch yet" };
    if (view.status.head !== head) return { kind: "blocked", message: `The last status is for ${short(view.status.head)}, not the approved ${short(head)}; refresh the status` };
    return null;
  };

  switch (op) {
    case "status":
      return null;
    case "verify":
      return outcome !== "none" || view.pr || view.status?.pr ? null : { kind: "refused", message: "Nothing to verify yet: no PR or merge is recorded" };
    case "inspect":
      if (outcome === "merged") return settled();
      return notReady;
    case "approve":
      return settled() ?? notReady ?? (view.inspection ? null : { kind: "refused", message: "Inspect first: an approval is for exactly what you were shown" });
    case "acknowledgeNoChecks": {
      const g = settled() ?? notReady ?? approved();
      if (g) return g;
      const s = statusFor(view.approval!.head);
      if (s) return s;
      if (view.status!.checks.summary !== "none") return { kind: "refused", message: "GitHub reports checks for this PR: there is nothing to acknowledge" };
      if (!view.inspection) return { kind: "refused", message: "Inspect again to see the local verification evidence before acknowledging" };
      if (!view.inspection.evidence.line && !view.inspection.evidence.report) return { kind: "blocked", message: "No local verification evidence is recorded for this ticket" };
      return null;
    }
    case "push":
    case "ensurePr":
      return settled() ?? notReady ?? approved();
    case "merge": {
      const g = settled() ?? notReady ?? approved();
      if (g) return g;
      const a = view.approval!;
      if (!view.pr) return { kind: "refused", message: "Create or reuse the PR first" };
      const s = statusFor(a.head);
      if (s) return s;
      const st = view.status!;
      if (st.checks.summary === "failed") return { kind: "blocked", message: "A check failed: merging is blocked" };
      if (st.checks.summary === "pending") return { kind: "blocked", message: "Checks are still running: merging is blocked" };
      if (st.checks.summary === "none" && !a.acknowledgeNoChecks) return { kind: "blocked", message: "No checks reported: acknowledge the local evidence before merging" };
      if (st.mergeable === "CONFLICTING") return { kind: "blocked", message: "The PR conflicts with the base" };
      if (st.mergeable !== "MERGEABLE") return { kind: "blocked", message: "GitHub has not computed mergeability yet; refresh the status" };
      if (st.reviewDecision === "CHANGES_REQUESTED") return { kind: "blocked", message: "The PR has changes requested" };
      return null;
    }
  }
}

/** A ticket shown as "Ready to deliver": deliverable now and nothing sent yet (or a settled not-merged). */
export function isReadyToDeliver(view: DeliveryView): boolean {
  return view.readiness.ready && (view.outcome === "none" || view.outcome === "not-merged");
}

/**
 * The input to 06.1's shared ticket-state mapping (`deliveryOf(key)`), which
 * owns the labels. Never a second mapping: only these two facts.
 * - merged: GitHub reports the PR merged (verified or not);
 * - pr-open: a PR exists and the merge is not confirmed (covers pending, unknown and not-merged).
 * Pending or unknown is never reported as merged.
 */
export type DeliveryStageInput = "pr-open" | "merged";

export function deliveryStageOf(view: DeliveryView | null | undefined): DeliveryStageInput | null {
  if (!view) return null;
  if (view.outcome === "merged") return "merged";
  if (view.pr) return "pr-open";
  return null;
}
