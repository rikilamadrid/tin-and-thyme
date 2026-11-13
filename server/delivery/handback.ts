// After the merge is verified and local main contains it: hand the ticket back
// to the Pathfinder coordinator, once, and refresh the dispatch plan.
//
// - The handback is one line typed into the coordinator's session, opening with
//   a marker, `[tin-and-thyme:handback <key> <merge commit>]`, asking it to run
//   `/ticket complete <key>` and then `orchestrate release <key>`. The kitchen
//   never completes or releases anything itself: those stay Pathfinder's.
// - It is recorded before it is typed and is never typed twice for the same
//   marker: not on a retry click, a reconnect, a restart, or anything else (see
//   Feature 06's notes: a dismissal re-sent the same message three times). Only
//   a send the coordinator's terminal did not confirm can be sent again, and
//   only on the human's explicit click.
// - It is refused until local main contains the merge, because `orchestrate
//   release` proves the merge from local main and refuses otherwise.
// - It is refused until the completion records are on local main too: delivered
//   through their own records PR (records.ts), or already recorded there. The
//   coordinator is told they are, so `/ticket complete` never edits main.
// - The plan is read with `orchestrate plan --json` (read-only); tickets that
//   were waiting on this one and are eligible now are reported as newly eligible.

import { handbackMarkerOf } from "../../src/data/delivery";
import { parseCliJson } from "../lib/json";
import type { Runner } from "./forge";
import { isSha } from "./ops";
import { DeliveryError, isTicketKey, redact, type DeliveryState, type HandbackRecord, type PlanRecord } from "./state";

/** The coordinator's session, as the kitchen reaches it (`sessions.typeInto`). */
export interface CoordinatorLink {
  /** Types one line and submits it; false when the terminal did not take it. */
  type(text: string): Promise<boolean>;
}

export const HANDBACK_PREFIX = "tin-and-thyme:handback"; // handbackMarkerOf in src/data/delivery.ts

export function handbackMarker(key: string, mergeCommit: string): string {
  if (!isTicketKey(key) || !isSha(mergeCommit)) throw new DeliveryError("invalid", "a handback needs a ticket key and the full merge commit id");
  return handbackMarkerOf(key, mergeCommit);
}

/**
 * Where the completion records are (Feature 10, Notes; human decision
 * 2026-11-13): a records PR on `ticket/<key>-records`, delivered through this same
 * flow, or already on main. Without that fact (never sent by the kitchen) the
 * coordinator is told not to edit main.
 */
export const RECORDS_CLAUSE =
  "Completion records follow Feature 10's Notes (a records PR through the in-app delivery flow): never leave completion edits uncommitted on main; if where to commit them is not settled for you, open a human gate instead of editing main.";

/** Where the ticket's completion records are: delivered by their records PR, or already on main. */
export type RecordsDone = { pr: number; commit: string } | { onMain: true };

export function recordsClause(records: RecordsDone): string {
  const where =
    "onMain" in records
      ? "Local main already records it Complete"
      : (() => {
          if (!Number.isInteger(records.pr) || records.pr <= 0 || !isSha(records.commit)) throw new DeliveryError("invalid", "the records PR number and full merge commit id are required");
          return `Its completion records (ticket Status, derived Feature Status, history entry) are on main through records PR #${records.pr}, squash-merged as ${records.commit}`;
        })();
  return `${where}: do not edit or commit them again, and never leave completion edits uncommitted on main.`;
}

/** The one line the coordinator receives. Only validated ids and numbers go into it. */
export function handbackText(key: string, pr: number, mergeCommit: string, records?: RecordsDone): string {
  const marker = handbackMarker(key, mergeCommit);
  if (!Number.isInteger(pr) || pr <= 0) throw new DeliveryError("invalid", "a handback needs the merged PR number");
  return (
    `[${marker}] The human delivered ticket ${key} in Tin & Thyme: PR #${pr} is squash-merged as ${mergeCommit}, verified, and the local main checkout contains it. ` +
    `Run /ticket complete ${key}, then orchestrate release ${key}. ${records ? recordsClause(records) : RECORDS_CLAUSE} ` +
    `This request is sent once; if you have already handled this marker, do nothing.`
  ).replace(/\s+/g, " ");
}

export interface HandbackDeps {
  read(key: string): DeliveryState;
  update(key: string, change: (s: DeliveryState) => void): void;
  link: CoordinatorLink | null;
  /** True when local main contains this commit (read-only). */
  mainContains(commit: string): Promise<boolean>;
  /** Where the completion records are, or why they are not on local main yet. */
  records(key: string): Promise<RecordsDone | string>;
  now(): Date;
}

export interface HandbackResult {
  marker: string;
  status: HandbackRecord["status"];
  /** It had been sent already: nothing was typed now. */
  already: boolean;
}

/** Runs inside the ticket's step lock (Delivery.runStep), so two clicks never both type. */
export async function sendHandback(key: string, d: HandbackDeps): Promise<{ data: HandbackResult; message: string }> {
  const s = d.read(key);
  if (!s.merged?.commit || !s.verified) throw new DeliveryError("refused", `${key}'s merge is not verified yet; verify it first`);
  const commit = s.merged.commit;
  const marker = handbackMarker(key, commit);
  const prev = s.handback?.marker === marker ? s.handback : null;
  if (prev?.status === "sent") return { data: { marker, status: "sent", already: true }, message: `already handed back at ${prev.at}; it is never sent twice` };
  if (!d.link) throw new DeliveryError("refused", "this server has no coordinator session to hand back to; nothing was sent");
  if (!(await d.mainContains(commit)))
    throw new DeliveryError("refused", `local main does not contain the merge ${commit} yet: reconcile the main checkout first. orchestrate release refuses until it does, so nothing was sent`);
  const records = await d.records(key);
  if (typeof records === "string") throw new DeliveryError("refused", `${records}; nothing was sent`);
  if (prev?.status === "sending") {
    // The kitchen stopped while typing it: it may have arrived. Never re-sent without the human looking first.
    d.update(key, (st) => {
      st.handback = { ...prev, status: "unconfirmed", note: "the kitchen stopped while it was being typed; check the coordinator's terminal before sending it again" };
    });
    throw new DeliveryError("blocked", "the last handback was interrupted while being typed and may have arrived: check the coordinator's terminal, then send again only if it is not there");
  }
  const at = d.now().toISOString();
  const attempts = (prev?.attempts ?? 0) + 1;
  d.update(key, (st) => {
    st.handback = { marker, at, status: "sending", note: "being typed into the coordinator's session", attempts };
  });
  let ok = false;
  try {
    ok = await d.link.type(handbackText(key, s.merged.pr, commit, records));
  } catch {
    ok = false;
  }
  if (!ok) {
    d.update(key, (st) => {
      st.handback = { marker, at, status: "unconfirmed", note: "the coordinator's terminal did not confirm it; check it before sending again", attempts };
    });
    throw new DeliveryError("failed", "the coordinator's terminal did not confirm the handback; check it before sending again");
  }
  d.update(key, (st) => {
    st.handback = { marker, at, status: "sent", note: `asked the coordinator to run /ticket complete ${key}, then orchestrate release ${key}`, attempts };
  });
  return { data: { marker, status: "sent", already: false }, message: `asked the coordinator once (${marker}) to run /ticket complete ${key}, then orchestrate release ${key}` };
}

interface PlanEntry {
  key?: unknown;
  title?: unknown;
  reason?: unknown;
  waiting?: unknown;
}

const text = (v: unknown, max = 200) => (typeof v === "string" ? redact(v).slice(0, max) : "");

/** `orchestrate plan --json`, read-only, as the drawer shows it. */
export async function readPlan(o: { runner: Runner; root: string; engine: string; key: string; previous: PlanRecord | null; now: () => Date }): Promise<PlanRecord> {
  const r = await o.runner("node", [o.engine, "plan", "--json"], { cwd: o.root, timeoutMs: 60_000 });
  const out = parseCliJson<{ outcome?: unknown; message?: unknown; dispatch?: PlanEntry[]; deferred?: PlanEntry[]; blocked?: PlanEntry[] }>(r.stdout);
  if (!out || !Array.isArray(out.dispatch)) throw new DeliveryError("failed", `cannot read the engine's plan: ${redact((r.stderr || "no output").split("\n")[0])}`);
  const keyed = (list: PlanEntry[] | undefined) => (Array.isArray(list) ? list.filter((e) => isTicketKey(e.key)) : []) as (PlanEntry & { key: string })[];
  const eligible = [
    ...keyed(out.dispatch).map((e) => ({ key: e.key, title: text(e.title), deferred: null })),
    ...keyed(out.deferred).map((e) => ({ key: e.key, title: text(e.title), deferred: text(e.reason) || "deferred" })),
  ];
  const waitingOn = keyed(out.blocked)
    .filter((e) => Array.isArray(e.waiting) && e.waiting.includes(o.key))
    .map((e) => ({ key: e.key, title: text(e.title) }));
  // Waiting on this ticket in the previous plan, or already reported as newly eligible there.
  const before = new Set([...(o.previous?.waitingOn ?? []).map((w) => w.key), ...(o.previous?.newly ?? [])]);
  return {
    at: o.now().toISOString(),
    outcome: text(out.outcome, 40),
    message: text(out.message, 400),
    eligible,
    waitingOn,
    newly: eligible.filter((e) => before.has(e.key)).map((e) => e.key),
  };
}
