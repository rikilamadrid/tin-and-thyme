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

export const DELIVERY_OPS = ["inspect", "approve", "acknowledgeNoChecks", "push", "ensurePr", "status", "merge", "verify", "reconcilePlan", "reconcile", "prepareRecords", "handback", "plan"] as const;
export type DeliveryOp = (typeof DELIVERY_OPS)[number];

/**
 * The recorded steps (state.ts STEPS). Acknowledging "no checks" is recorded as
 * an approval; listing the main checkout (reconcilePlan) is read-only and records
 * nothing; preparing the completion records is the `records` step.
 */
export const DELIVERY_STEPS = ["inspect", "approve", "push", "ensurePr", "status", "merge", "verify", "reconcile", "records", "handback", "plan"] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

/**
 * Which delivery a request or view is for: the ticket's implementation, or its
 * completion records on `ticket/<key>-records` (server/delivery/records.ts), which
 * has its own state, approval and steps. Only these ops exist on the records
 * track; it has no records, handback or plan of its own.
 */
export type DeliveryTrack = "ticket" | "records";
export const RECORDS_TRACK_OPS: readonly DeliveryOp[] = ["inspect", "approve", "acknowledgeNoChecks", "push", "ensurePr", "status", "merge", "verify", "reconcilePlan", "reconcile"];

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
  /**
   * Ready to deliver: engine state `done`, a recorded review PASS, a live claim on
   * ticket/<key>-*, every `Blocked by` ticket Complete, and a branch that is not
   * stacked on another ticket's unmerged commits.
   */
  ready: boolean;
  /** The tickets it waits on: unfinished blockers, or parents it is stacked on. */
  waitingOn: string[];
  /** Its branch carries another ticket's unmerged commits ("Waiting on <key> (stacked)"). */
  stacked: boolean;
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

/** One file a fast-forward of main would overwrite or remove (server/delivery/reconcile.ts). */
export interface ReconcileCollisionView {
  path: string;
  kind: "modified" | "untracked" | "ignored";
  status: string;
  why: string;
  type: "file" | "symlink" | "missing";
  size: number | null;
  /** The main checkout's copy equals what the merged origin/main has there. */
  sameAsMerged: boolean;
  /** Staged content that differs from the working file is backed up too. */
  staged: boolean;
}

/** The last listing of the main checkout, kept in memory: the click must match its digest. */
export interface ReconcilePlanView {
  at: string;
  branch: string;
  head: string;
  target: string;
  mergeCommit: string;
  upToDate: boolean;
  collisions: ReconcileCollisionView[];
  preserved: { path: string; status: string }[];
  preservedTotal: number;
  refusal: string | null;
  digest: string;
}

export interface ReconciledView {
  at: string;
  before: string;
  after: string;
  target: string;
  mergeCommit: string;
  backup: string | null;
  moved: number;
  preserved: number;
}

export interface HandbackView {
  marker: string;
  at: string;
  status: "sending" | "sent" | "unconfirmed";
  note: string;
  attempts: number;
}

export interface PlanView {
  at: string;
  outcome: string;
  message: string;
  eligible: { key: string; title: string; deferred: string | null }[];
  waitingOn: { key: string; title: string }[];
  newly: string[];
}

/** After a verified merge: the main checkout, the handback to the coordinator, and the refreshed plan. */
export interface AfterMergeView {
  /** Local main contains the merge commit (null: not known yet). */
  mainHasMerge: boolean | null;
  reconcilePlan: ReconcilePlanView | null;
  reconciled: ReconciledView | null;
  handback: HandbackView | null;
  /** A coordinator session exists to hand back to (not in a preview). */
  coordinator: boolean;
  plan: PlanView | null;
}

/** The completion records prepared after the verified merge (state.ts RecordsPrepRecord). */
export interface RecordsPrepView {
  at: string;
  branch: string;
  /** The records commit; null when local main already records the ticket Complete. */
  head: string | null;
  parent: string;
  mergeCommit: string;
  changes: string[];
  onMain: boolean;
}

export interface DeliveryView {
  key: string;
  /** "records": the view of the ticket's completion-records delivery (nested in the ticket's view as `records`). */
  track: DeliveryTrack;
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
  /** After a verified merge (empty before). */
  after: AfterMergeView;
  /** The ticket track only: the prepared completion records, and their own delivery (null before the merge is verified). */
  recordsPrep: RecordsPrepView | null;
  records: DeliveryView | null;
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

  const afterMerge = (): Gate | null => {
    if (outcome !== "merged" || !view.merged?.commit) return { kind: "refused", message: "Nothing is merged yet: this comes after a verified merge" };
    if (!view.verified) return { kind: "refused", message: "Verify the merge first" };
    return null;
  };
  // A records delivery never produces records, a handback or a plan of its own.
  if (view.track === "records" && !RECORDS_TRACK_OPS.includes(op))
    return { kind: "refused", message: "A completion-records delivery has no records, handback or plan of its own; those belong to the ticket" };

  switch (op) {
    case "status":
      return null;
    case "reconcilePlan":
    case "plan":
      return afterMerge();
    case "prepareRecords": {
      const g = afterMerge();
      if (g) return g;
      if (view.after.mainHasMerge !== true) return { kind: "refused", message: "Local main does not contain the merge yet: reconcile the main checkout first (the records are cut from the updated main)" };
      const p = view.recordsPrep;
      if (p && p.mergeCommit === view.merged!.commit) {
        if (p.onMain) return { kind: "refused", message: "Local main already records this ticket Complete: there are no records to deliver" };
        if (view.records?.outcome === "merged") return { kind: "refused", message: "The completion records are already merged" };
        if (p.head && view.records?.readiness.reviewedHead === p.head) return { kind: "refused", message: `The completion records are prepared on ${p.branch} at ${short(p.head)}: deliver them below` };
      }
      return null;
    }
    case "reconcile": {
      const g = afterMerge();
      if (g) return g;
      const p = view.after.reconcilePlan;
      if (!p) return { kind: "refused", message: "List the main checkout first: the backup is for exactly what you were shown" };
      if (p.mergeCommit !== view.merged!.commit) return { kind: "stale", message: "The listing is for another merge; list the main checkout again" };
      if (p.refusal) return { kind: "refused", message: p.refusal };
      if (p.upToDate) return { kind: "refused", message: "Local main already contains the merge: nothing to reconcile" };
      return null;
    }
    case "handback": {
      const g = afterMerge();
      if (g) return g;
      const h = view.after.handback;
      if (h && h.marker === handbackMarkerOf(view.key, view.merged!.commit!)) {
        if (h.status === "sent") return { kind: "refused", message: `Handed back to the coordinator at ${h.at}; it is never sent twice` };
        if (h.status === "sending") return { kind: "busy", message: "The handback is being sent" };
      }
      if (!view.after.coordinator) return { kind: "unavailable", message: "This server has no coordinator session to hand back to" };
      if (view.after.mainHasMerge !== true) return { kind: "refused", message: "Local main does not contain the merge yet: reconcile the main checkout first (orchestrate release refuses until it does)" };
      const rs = recordsSettled(view);
      if (rs) return { kind: "refused", message: rs };
      return null;
    }
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

/**
 * Null when the ticket's completion records are on local main: delivered through
 * their records PR (merged, verified, and local main contains it), or local main
 * already recorded the ticket Complete. Otherwise why the handback waits.
 */
export function recordsSettled(view: DeliveryView): string | null {
  const p = view.recordsPrep;
  if (p?.onMain && p.mergeCommit === view.merged?.commit) return null;
  const r = view.records;
  if (!r || r.outcome !== "merged" || !r.merged?.commit) return "Deliver the completion records first: prepare them, then merge their records PR (completion edits are never left uncommitted on main)";
  if (!r.verified) return "Verify the completion records' merge first";
  if (r.after.mainHasMerge !== true) return "Local main does not contain the completion records yet: reconcile the main checkout for them first";
  return null;
}

/** The handback's marker (server/delivery/handback.ts handbackMarker). */
export const handbackMarkerOf = (key: string, mergeCommit: string) => `tin-and-thyme:handback ${key} ${mergeCommit}`;

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
