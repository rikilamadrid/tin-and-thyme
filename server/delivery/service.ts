// The kitchen side of in-app delivery: one Delivery (ops.ts) and one DeliveryStore
// per process, the readiness read from the engine, and the request/reply handler
// the WebSocket calls for `{ rpc: "delivery", … }`.
//
// - Every request needs the Origin the socket sent at upgrade; a client without
//   one (not a browser page) is refused and nothing runs. This is hardening, not
//   a security boundary (Feature 10, Notes).
// - Parameters are validated (wire.ts), then the request must pass the same gate
//   the drawer shows (src/data/delivery.ts gateOf) and match exactly what the
//   human was shown: approve takes the last inspected {head, base, tree}; push,
//   acknowledge and merge take the stored approval, and merge's "no checks"
//   acknowledgement comes from the stored approval, never from the client.
// - Then the delivery core runs it, re-validating everything live and recording
//   each step. One operation per ticket at a time here (`busy`), and across
//   processes by the core's lock files.
// - After every operation the ticket's DeliveryView is broadcast
//   (`delivery.updated`) and kept in the snapshot, so a reconnect restores it.
//   The reply goes to the requesting socket only.
// - After a verified merge (ticket 10.3): list the main checkout, reconcile it on
//   the human's click for exactly that listing (reconcile.ts), hand the ticket
//   back to the coordinator once (handback.ts), and refresh the plan.

import { readdirSync } from "node:fs";
import {
  type AfterMergeView,
  approvalReasons,
  DELIVERY_STEPS,
  gateOf,
  type DeliveryApprovalView,
  type DeliveryBoard,
  type DeliveryFailure,
  type DeliveryOp,
  type DeliveryReadiness,
  type DeliveryReply,
  type DeliveryStatusView,
  type DeliveryView,
  type InspectionView,
  type ReconcilePlanView,
  type StepView,
} from "../../src/data/delivery";
import type { OfficeEvent } from "../../src/data/source";
import type { RpcContext } from "../http";
import { log } from "../lib/log";
import { diffSummary } from "./diffSummary";
import { localEvidence } from "./evidence";
import { defaultRunner, type Runner } from "./forge";
import { readPlan, sendHandback, type CoordinatorLink } from "./handback";
import { Delivery, type DeliveryConfig, type DeliveryStatus, type Outcome } from "./ops";
import { engineOf, Readiness, type ReadinessRow } from "./readiness";
import { Reconciler, type ReconcilePlan } from "./reconcile";
import { backupsDir, deliveriesDir, DeliveryError, DeliveryStore, emptyState, isTicketKey, mergeOutcome, redact, redactDeep, type Approval, type DeliveryState } from "./state";
import { parseRequest, requestIdOf, type DeliveryParams } from "./wire";

/** What the service needs from the Hub: the snapshot it keeps current, and the broadcast. */
export interface DeliveryHub {
  snap: { delivery?: DeliveryBoard };
  emit(e: OfficeEvent): void;
}

export interface DeliveryServiceOptions {
  hub: DeliveryHub;
  /** The project's main checkout. */
  root: string;
  /** The configured GitHub repository, `owner/name`. */
  repo: string;
  /** The kitchen folder under ~/.controlroom (its deliveries/ and transfer/ live there). */
  kitchenKey: string;
  runner?: Runner;
  home?: string;
  engine?: string;
  /** How often readiness is re-read from the engine (default 15 s). */
  refreshMs?: number;
  /** The coordinator's session, for the handback; none in a preview. */
  coordinator?: CoordinatorLink | null;
  /** Passed to the delivery core (tests: clock and confirmation delays). */
  core?: Pick<DeliveryConfig, "base" | "denylist" | "now" | "confirmDelaysMs" | "settleAfterMs">;
}

export interface DeliveryService {
  /** The WebSocket rpc handler for `delivery`. */
  handle: (msg: Record<string, unknown>, ctx: RpcContext) => Promise<void>;
  view(key: string): DeliveryView;
  board(): DeliveryBoard;
  /** Re-reads readiness from the engine and publishes what changed. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

/** The snapshot field when delivery is not available in this kitchen. */
export function unavailableBoard(reason: string): DeliveryBoard {
  return { available: false, reason, byKey: {} };
}

/** An rpc handler that answers every delivery request with `unavailable`. */
export function unavailableRpc(reason: string) {
  return (msg: Record<string, unknown>, ctx: RpcContext) =>
    ctx.reply({ type: "delivery.reply", id: requestIdOf(msg), reply: { ok: false, id: requestIdOf(msg), op: null, key: null, kind: "unavailable", message: reason, fix: null, reasons: [], view: null } });
}

export const NO_ORIGIN =
  "Delivery operations run only from the kitchen's own browser page: this connection sent no browser Origin, so nothing was run.";

/** Operations that write, or that lead to one (an inspection is what an approval binds to). */
const LEADS_TO_WRITE = new Set<DeliveryOp>(["inspect", "approve", "acknowledgeNoChecks", "push", "ensurePr", "merge"]);

const approvalView = (a: Approval): DeliveryApprovalView => ({ key: a.key, head: a.head, base: a.base, tree: a.tree, at: a.at ?? null, acknowledgeNoChecks: a.acknowledgeNoChecks === true });
const planView = (p: ReconcilePlan): ReconcilePlanView => ({
  at: p.at,
  branch: p.branch,
  head: p.head,
  target: p.target,
  mergeCommit: p.mergeCommit,
  upToDate: p.upToDate,
  collisions: p.collisions.map((c) => ({ path: c.path, kind: c.kind, status: c.status, why: c.why, type: c.type, size: c.size, sameAsMerged: c.sameAsMerged, staged: c.stagedBlob !== null })),
  preserved: p.preserved.map(({ path, status }) => ({ path, status })),
  preservedTotal: p.preservedTotal,
  refusal: p.refusal,
  digest: p.digest,
});
const sameTriple = (a: { head?: string | null; base?: string | null; tree?: string | null }, b: { head?: string | null; base?: string | null; tree?: string | null }) =>
  a.head === b.head && a.base === b.base && a.tree === b.tree;

export function createDeliveryService(o: DeliveryServiceOptions): DeliveryService {
  const runner = o.runner ?? defaultRunner;
  const engine = o.engine ?? engineOf(o.root);
  const store = new DeliveryStore(deliveriesDir(o.kitchenKey, o.home));
  const delivery = new Delivery({ root: o.root, repo: o.repo, store, runner, engine, ...o.core });
  const base = o.core?.base ?? "main";
  const readiness = new Readiness(runner, o.root, engine, base);
  const clock = () => (o.core?.now ? o.core.now() : new Date());
  const reconciler = new Reconciler({ root: o.root, repo: o.repo, base, runner, now: clock });
  const board: DeliveryBoard = { available: true, reason: null, byKey: {} };
  o.hub.snap.delivery = board;

  let rows = new Map<string, ReadinessRow>();
  let engineError: string | null = null;
  const inspections = new Map<string, InspectionView>();
  const statuses = new Map<string, DeliveryStatusView>();
  const running = new Map<string, DeliveryOp>();
  /** A request past the busy check, still being validated (not shown as running). */
  const checking = new Map<string, DeliveryOp>();
  const published = new Map<string, string>();
  /** The last listing of the main checkout per ticket: the reconcile click must match it. */
  const reconcilePlans = new Map<string, ReconcilePlan>();
  /** Whether local main contains each verified merge (refreshed with readiness). */
  const mainHas = new Map<string, boolean | null>();

  const read = (key: string): DeliveryState => {
    try {
      return store.read(key);
    } catch {
      return emptyState(key);
    }
  };

  function view(key: string): DeliveryView {
    const s = read(key);
    const row = rows.get(key);
    const ready: DeliveryReadiness = row?.readiness ?? {
      engineState: null,
      reviewedHead: null,
      branch: null,
      ready: false,
      waitingOn: [],
      stacked: false,
      reason: engineError ? `the engine could not be read (${engineError})` : `the engine has no row for ${key}`,
    };
    // Only an inspection of exactly the stored head, base and tree is shown (another process may have inspected since).
    const cached = inspections.get(key) ?? null;
    const inspection = cached && sameTriple(cached, s) ? cached : null;
    const status = statuses.get(key) ?? null;
    const approval = s.approval ? approvalView(s.approval) : null;
    let staleReasons: string[] = [];
    let approvalState: DeliveryView["approvalState"] = "none";
    if (approval) {
      staleReasons = approvalReasons(approval, { head: s.head, base: s.base, tree: s.tree }, status);
      approvalState = staleReasons.length ? "stale" : "valid";
    } else if (s.invalidated) {
      approvalState = "stale";
      staleReasons = s.invalidated.reasons;
    }
    const steps = DELIVERY_STEPS.flatMap((n) => (s.steps[n] ? [s.steps[n] as StepView] : []));
    const listing = reconcilePlans.get(key);
    const after: AfterMergeView = {
      mainHasMerge: s.merged?.commit ? (mainHas.get(key) ?? null) : null,
      reconcilePlan: listing && listing.mergeCommit === s.merged?.commit ? planView(listing) : null,
      reconciled: s.reconciled,
      handback: s.handback,
      coordinator: !!o.coordinator,
      plan: s.plan,
    };
    return redactDeep({
      key,
      title: row?.title ?? inspection?.title ?? null,
      readiness: ready,
      repo: s.repo,
      branch: s.branch,
      head: s.head,
      base: s.base,
      tree: s.tree,
      inspection,
      approval,
      approvalState,
      staleReasons,
      invalidated: s.invalidated ? { at: s.invalidated.at, reasons: s.invalidated.reasons, approval: approvalView(s.invalidated.approval) } : null,
      pr: s.pr,
      status,
      outcome: mergeOutcome(s),
      pendingNote: s.pendingMerge?.note ?? null,
      merged: s.merged
        ? { pr: s.merged.pr, commit: s.merged.commit, at: s.merged.at, approval: s.merged.approval ? approvalView(s.merged.approval) : null, verification: s.merged.verification }
        : null,
      verified: s.verified,
      lastAttempt: s.lastAttempt ? { at: s.lastAttempt.at, pr: s.lastAttempt.pr, settledAt: s.lastAttempt.settledAt, reason: s.lastAttempt.reason } : null,
      steps,
      running: running.get(key) ?? null,
      after,
      updated: s.updated,
    });
  }

  function publish(key: string) {
    const v = view(key);
    const json = JSON.stringify(v);
    if (published.get(key) === json) return;
    published.set(key, json);
    board.byKey[key] = v;
    o.hub.emit({ type: "delivery.updated", view: v });
  }

  /** Tickets the board lists: engine rows that are done, and every ticket with delivery state. */
  function keys(): Set<string> {
    const out = new Set<string>();
    for (const r of rows.values()) if (r.readiness.engineState === "done") out.add(r.key);
    try {
      for (const f of readdirSync(store.dir)) {
        const k = f.endsWith(".json") ? f.slice(0, -5) : "";
        if (isTicketKey(k)) out.add(k);
      }
    } catch {
      // no deliveries yet
    }
    for (const k of [...inspections.keys(), ...running.keys()]) out.add(k);
    return out;
  }

  /** Reads whether local main contains the ticket's verified merge (read-only git). */
  async function checkMain(key: string): Promise<void> {
    const s = read(key);
    const commit = s.merged?.commit;
    if (!commit || !s.verified) {
      mainHas.delete(key);
      return;
    }
    try {
      mainHas.set(key, await reconciler.mainContains(commit));
    } catch {
      mainHas.set(key, null);
    }
  }

  /** Fetches origin/main (as the core does) and re-reads readiness with nothing cached for this ticket. */
  async function freshReadiness(key: string): Promise<void> {
    const r = await runner("git", ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: o.root, timeoutMs: 120_000 });
    if (!r.ok) log.warn(`delivery: fetching origin/${base} before ${key}'s operation failed; readiness uses the last fetched origin/${base}`);
    readiness.forget(key);
    if (refreshing) await refreshing.catch(() => {});
    await refresh();
  }

  let refreshing: Promise<void> | null = null;
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const list = await readiness.read();
        rows = new Map(list.map((r) => [r.key, r]));
        engineError = null;
      } catch (e) {
        engineError = redact(e instanceof Error ? e.message : String(e));
      }
      const want = keys();
      for (const k of want) await checkMain(k);
      for (const k of Object.keys(board.byKey)) if (!want.has(k)) {
        delete board.byKey[k];
        published.delete(k);
      }
      for (const k of want) publish(k);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const statusView = (d: DeliveryStatus, at: string): DeliveryStatusView => ({
    at,
    pr: d.pr ? { number: d.pr.number, url: d.pr.url, state: d.pr.state, title: d.pr.title, isDraft: d.pr.isDraft } : null,
    head: d.head,
    base: d.base,
    checks: { summary: d.checks.summary, items: d.checks.items.map((c) => ({ name: c.name, bucket: c.bucket, state: c.state, link: c.link })) },
    mergeable: d.mergeable,
    reviewDecision: d.reviewDecision || null,
  });

  type Result = { ok: true; message: string; data: unknown } | { ok: false; kind: DeliveryFailure; message: string; fix: string | null; reasons: string[] };
  const fromOutcome = <T>(out: Outcome<T>, step: keyof DeliveryState["steps"], data?: (d: T) => unknown): Result =>
    out.ok ? { ok: true, message: out.state.steps[step]?.message ?? "", data: data ? data(out.data) : out.data } : { ok: false, kind: out.kind, message: out.message, fix: out.fix, reasons: out.reasons };
  const now = () => clock().toISOString();
  const errorResult = (e: unknown): Result => {
    const err = e instanceof DeliveryError ? e : new DeliveryError("failed", e instanceof Error ? e.message : String(e));
    return { ok: false, kind: err.kind, message: err.message, fix: err.fix, reasons: err.reasons };
  };

  /** Reads the plan (read-only) and records it; the previous one says which tickets were waiting on this one. */
  const planStep = (key: string) =>
    delivery.runStep(key, "plan", async () => {
      const rec = await readPlan({ runner, root: o.root, engine, key, previous: read(key).plan, now: clock });
      const n = rec.eligible.length;
      return {
        data: rec,
        message: `${n} ticket${n === 1 ? "" : "s"} eligible now${rec.newly.length ? `, newly: ${rec.newly.join(", ")}` : ""}${rec.waitingOn.length ? `; still waiting on ${key}: ${rec.waitingOn.map((w) => w.key).join(", ")}` : ""}`,
        change: (st: DeliveryState) => {
          st.plan = rec;
        },
      };
    });

  async function runOp(op: DeliveryOp, p: DeliveryParams, v: DeliveryView): Promise<Result> {
    const key = p.key;
    const triple = { key, head: p.head!, base: p.base!, tree: p.tree! };
    switch (op) {
      case "inspect": {
        const out = await delivery.inspect(key);
        if (!out.ok) {
          inspections.delete(key);
          return fromOutcome(out, "inspect");
        }
        const i = out.data;
        let diff;
        try {
          diff = await diffSummary(runner, o.root, i.mergeBase, i.head);
        } catch (e) {
          inspections.delete(key);
          const err = e instanceof DeliveryError ? e : new DeliveryError("failed", e instanceof Error ? e.message : String(e));
          return { ok: false, kind: err.kind, message: `inspected, but the changed files could not be listed: ${err.message}`, fix: err.fix, reasons: err.reasons };
        }
        const iv: InspectionView = {
          at: now(),
          key,
          repo: i.repo,
          branch: i.branch,
          title: i.title,
          head: i.head,
          reviewedHead: i.reviewedHead,
          recordOnly: i.recordOnly,
          recordPath: i.recordPath,
          base: i.base,
          mergeBase: i.mergeBase,
          behind: i.behind,
          tree: i.tree,
          unscanned: i.unscanned,
          evidence: localEvidence({ kitchen: o.kitchenKey, key, reviewedHead: i.reviewedHead, line: i.evidence, home: o.home }),
          files: diff.files,
          filesTruncated: diff.truncated,
          stat: diff.stat,
        };
        inspections.set(key, redactDeep(iv));
        return fromOutcome(out, "inspect", () => inspections.get(key));
      }
      case "approve":
        return fromOutcome(await delivery.approve(key, triple), "approve", approvalView);
      case "acknowledgeNoChecks":
        return fromOutcome(await delivery.approve(key, { ...triple, acknowledgeNoChecks: true }), "approve", approvalView);
      case "push":
        return fromOutcome(await delivery.push(key, p.head!), "push");
      case "ensurePr":
        // The PR's title and body are the core's own; the browser sends neither.
        return fromOutcome(await delivery.ensurePr(key), "ensurePr", (d) => ({ pr: { number: d.pr.number, url: d.pr.url, state: d.pr.state }, created: d.created, merged: d.merged }));
      case "status": {
        const out = await delivery.status(key);
        if (out.ok) statuses.set(key, redactDeep(statusView(out.data, now())));
        return fromOutcome(out, "status", () => statuses.get(key));
      }
      case "merge": {
        // Exactly the stored approval, acknowledgement included; the client's parameters only had to equal it.
        const a = v.approval!;
        return fromOutcome(await delivery.merge(key, { key, head: a.head, base: a.base, tree: a.tree, ...(a.acknowledgeNoChecks ? { acknowledgeNoChecks: true } : {}) }), "merge");
      }
      case "verify":
        return fromOutcome(await delivery.verify(key), "verify");
      case "reconcilePlan": {
        // Read-only: fetch origin/main and list the main checkout. Recorded in memory only.
        reconcilePlans.delete(key);
        try {
          const plan = await reconciler.plan(key, read(key).merged!.commit!);
          reconcilePlans.set(key, plan);
          await checkMain(key);
          const message = plan.refusal
            ? `cannot reconcile: ${plan.refusal}`
            : plan.upToDate
              ? "local main already contains the merge"
              : `${plan.collisions.length} colliding file${plan.collisions.length === 1 ? "" : "s"} to back up; ${plan.preservedTotal} unrelated change${plan.preservedTotal === 1 ? "" : "s"} kept`;
          return { ok: true, message, data: planView(plan) };
        } catch (e) {
          return errorResult(e);
        }
      }
      case "reconcile": {
        const commit = read(key).merged!.commit!;
        const out = await delivery.runStep(key, "reconcile", async () => {
          const release = store.lock("main", "reconciling the main checkout");
          let applied;
          try {
            applied = await reconciler.apply(key, commit, p.digest!, backupsDir(o.kitchenKey, o.home));
          } finally {
            release();
          }
          const r = applied.result;
          return {
            data: r,
            message: r.upToDate
              ? "local main already contains the merge; nothing was moved"
              : `${r.moved ? `moved ${r.moved} colliding file${r.moved === 1 ? "" : "s"} to ${r.backup} (manifest.json lists them); ` : "nothing collided; "}${base} fast-forwarded ${r.before.slice(0, 12)} → ${r.after.slice(0, 12)}; ${r.preserved} unrelated change${r.preserved === 1 ? "" : "s"} kept`,
            change: (st: DeliveryState) => {
              st.reconciled = { at: now(), before: r.before, after: r.after, target: r.target, mergeCommit: r.mergeCommit, backup: r.backup, moved: r.moved, preserved: r.preserved };
            },
          };
        });
        // A listing is used once: after a reconcile (or a refused one) the checkout is listed again.
        reconcilePlans.delete(key);
        await checkMain(key);
        // The plan before completion: which tickets wait on this one.
        if (out.ok) await planStep(key);
        return fromOutcome(out, "reconcile");
      }
      case "handback": {
        const out = await delivery.runStep(key, "handback", () =>
          sendHandback(key, {
            read: (k) => store.read(k),
            update: (k, change) => void store.update(k, change, clock()),
            link: o.coordinator ?? null,
            mainContains: (c) => reconciler.mainContains(c),
            now: clock,
          }),
        );
        await checkMain(key);
        return fromOutcome(out, "handback");
      }
      case "plan":
        return fromOutcome(await planStep(key), "plan");
    }
  }

  /** The request must carry exactly what the human was shown or approved. */
  function paramsMismatch(op: DeliveryOp, p: DeliveryParams, v: DeliveryView): string | null {
    if (op === "approve") {
      const i = v.inspection;
      if (!i) return "inspect first: an approval is for exactly what you were shown";
      if (!sameTriple(p, i)) return `this approval is not for what was last inspected (head ${i.head}, base ${i.base}, tree ${i.tree}); inspect again`;
    }
    if (op === "acknowledgeNoChecks" || op === "merge") {
      if (!v.approval || !sameTriple(p, v.approval)) return "these are not the head, base and tree on record as approved; nothing was run";
    }
    if (op === "push" && (!v.approval || p.head !== v.approval.head)) return `only the approved head ${v.approval?.head ?? "(none)"} can be pushed`;
    if (op === "reconcile" && p.digest !== v.after.reconcilePlan?.digest) return "this is not the listing of the main checkout you were shown; list it again";
    return null;
  }

  async function handle(msg: Record<string, unknown>, ctx: RpcContext): Promise<void> {
    const send = (r: DeliveryReply) => ctx.reply({ type: "delivery.reply", id: r.id, reply: redactDeep(r) });
    // Hardening: only a browser page (which always sends an Origin, checked at upgrade) may drive delivery.
    if (!ctx.origin) return send({ ok: false, id: requestIdOf(msg), op: null, key: null, kind: "origin", message: NO_ORIGIN, fix: null, reasons: [], view: null });
    const parsed = parseRequest(msg);
    if (!parsed.ok)
      return send({ ok: false, id: parsed.id, op: parsed.op, key: parsed.key, kind: "invalid", message: parsed.message, fix: null, reasons: [], view: parsed.key ? view(parsed.key) : null });
    const { id, op, params } = parsed.req;
    const key = params.key;
    const fail = (kind: DeliveryFailure, message: string, reasons: string[] = []) =>
      send({ ok: false, id, op, key, kind, message, fix: null, reasons, view: view(key) });

    if (running.has(key) || checking.has(key)) return fail("busy", `${running.get(key) ?? checking.get(key)} is running for ${key}; wait for it to finish`);
    // The ticket is taken now, before any await, so a second request is busy rather than run after this one.
    checking.set(key, op);
    // A refused request re-reads readiness too, so the next attempt never runs on a stale claim (10.2 review, LOW).
    const reread = () => {
      readiness.forget(key);
      void refresh().catch((e) => log.warn("delivery refresh:", e instanceof Error ? e.message : e));
    };
    let before: DeliveryView;
    try {
      // Before anything that leads to a write, readiness (claim, blockers, stacking) is read afresh against a
      // freshly fetched origin/main, so the server enforces it, not only the drawer (10.5 review).
      if (LEADS_TO_WRITE.has(op)) await freshReadiness(key);
      before = view(key);
      const gate = gateOf(before, op);
      if (gate) {
        reread();
        return fail(gate.kind, gate.message, op === "merge" || op === "push" || op === "ensurePr" || op === "acknowledgeNoChecks" ? before.staleReasons : []);
      }
      const mismatch = paramsMismatch(op, params, before);
      if (mismatch) {
        reread();
        return fail("stale", mismatch);
      }
      running.set(key, op);
    } finally {
      checking.delete(key);
    }

    publish(key);
    let result: Result;
    try {
      result = await runOp(op, params, before);
    } catch (e) {
      result = { ok: false, kind: "failed", message: redact(e instanceof Error ? e.message : String(e)), fix: null, reasons: [] };
    } finally {
      running.delete(key);
    }
    await checkMain(key);
    readiness.forget(key);
    publish(key);
    void refresh().catch((e) => log.warn("delivery refresh:", e instanceof Error ? e.message : e));
    const v = view(key);
    send(result.ok ? { ok: true, id, op, key, message: result.message, data: result.data, view: v } : { ok: false, id, op, key, kind: result.kind, message: result.message, fix: result.fix, reasons: result.reasons, view: v });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    handle,
    view,
    board: () => board,
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), o.refreshMs ?? 15_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
