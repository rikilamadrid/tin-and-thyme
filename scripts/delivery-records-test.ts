// Completion records as their own records PR (ticket 10.3; human decision
// 2026-11-13). Against 10.1's fake world (scripts/delivery-fake.ts) for
// everything GitHub, with real local git on throwaway repositories and a
// temporary HOME. Nothing is pushed; the real main checkout, the live kitchen
// and its coordinator are never touched.
//
//   pnpm exec tsx scripts/delivery-records-test.ts
//
// Covers: refusal before the implementation merge is verified (and in local
// main); the exact-lines check (the intended records accepted; an extra line, an
// extra file, a wrong status, edits elsewhere in those files, a mode change, a
// second commit refused as needing normal review); no recursion; the approval
// bound to the exact records head; the records delivery's own state; the Feature
// left alone while siblings are open; and "already Complete on main".

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { gateOf, recordsSettled, type DeliveryBoard, type DeliveryClient, type DeliveryReply, type DeliveryView } from "../src/data/delivery";
import type { OfficeEvent } from "../src/data/source";
import { DeliveryPanel } from "../src/ui/delivery/DeliveryPanel";
import { run } from "../server/lib/exec";
import type { Runner } from "../server/delivery/forge";
import { handbackText } from "../server/delivery/handback";
import {
  checkRecordsHead,
  historyEntry,
  intendedRecords,
  isRecordsBranch,
  parentFeatureOf,
  RecordsGit,
  recordsBranch,
  statusOf,
  withHistoryEntry,
  withStatus,
  writeRecordsCommit,
  type IntendedRecords,
} from "../server/delivery/records";
import { createDeliveryService, type DeliveryService } from "../server/delivery/service";
import { DeliveryStore } from "../server/delivery/state";
import { parseRequest } from "../server/delivery/wire";
import { addRecordsFixture, git, makeScenario, result, type World } from "./delivery-fake";

// ---------------------------------------------------------------- harness

const tmp = mkdtempSync(join(tmpdir(), "tt-records-"));
const emptyConfig = join(tmp, "empty.gitconfig");
writeFileSync(emptyConfig, "");
Object.assign(process.env, {
  HOME: tmp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
});

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, detail?: unknown) {
  if (cond) passed++;
  else failures.push(`${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function okReply(label: string, r: DeliveryReply): Extract<DeliveryReply, { ok: true }> {
  if (!r.ok) {
    failures.push(`${label}: expected ok, got ${r.kind}: ${r.message} ${JSON.stringify(r.reasons)}`);
    throw new Error(`${label} failed; cannot continue this scenario`);
  }
  passed++;
  return r;
}
function refusedReply(label: string, r: DeliveryReply, kind: string, text?: RegExp) {
  if (r.ok) return check(label, false, "expected a refusal, got ok");
  check(`${label} (kind ${kind})`, r.kind === kind, { kind: r.kind, message: r.message, reasons: r.reasons });
  if (text) check(`${label} (says why)`, text.test(r.message + " " + r.reasons.join(" ")), { message: r.message, reasons: r.reasons });
}
async function refuses(label: string, p: Promise<unknown>, text: RegExp) {
  try {
    await p;
    check(label, false, "expected a refusal, got ok");
  } catch (e) {
    const err = e as { message?: string; reasons?: string[]; kind?: string };
    const all = `${err.message ?? ""} ${(err.reasons ?? []).join(" ")}`;
    check(label, err.kind === "refused" && text.test(all), { kind: err.kind, message: err.message, reasons: err.reasons });
  }
}

const ORIGIN = "http://127.0.0.1:5173";
const LOCAL = new Set(["--no-optional-locks", "ls-tree", "ls-files", "symbolic-ref", "merge", "checkout", "rm", "checkout-index", "hash-object", "mktree", "commit-tree", "update-ref"]);

function runnerFor(world: World): Runner {
  return async (cmd, args, opts = {}) => {
    if (cmd === "node" && args[1] === "status") {
      const rows = [...world.claims.entries()].map(([key, c]) => ({ key, state: c.state, title: c.title, updated: "u1" }));
      return result(JSON.stringify({ ok: true, rows }));
    }
    if (cmd === "node" && args[1] === "plan") return result(JSON.stringify({ outcome: "nothing-eligible", message: "plan", dispatch: [], deferred: [], blocked: [], stale: [] }));
    if (cmd === "git" && LOCAL.has(args[0])) return run("git", args, { cwd: opts.cwd ?? world.repo, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return world.runner(cmd, args, opts);
  };
}

let reqN = 0;
async function kitchen(name: string, fixture: Parameters<typeof addRecordsFixture>[1] = {}) {
  const s = makeScenario(tmp, name);
  addRecordsFixture(s, fixture);
  const snap: { delivery?: DeliveryBoard } = {};
  const hub = { snap, emit: (_e: OfficeEvent) => {} };
  const kitchenKey = `kitchen-${name}`;
  const runner = runnerFor(s.world);
  const typed: string[] = [];
  const make = () =>
    createDeliveryService({ hub, root: s.repo, repo: "owner/project", kitchenKey, runner, home: tmp, coordinator: { type: async (t: string) => (typed.push(t), true) }, core: { confirmDelaysMs: [0] } });
  const service = make();
  await service.refresh();
  const call = async (op: string, params: Record<string, unknown>, svc: DeliveryService = service): Promise<DeliveryReply> => {
    const got: OfficeEvent[] = [];
    await svc.handle({ rpc: "delivery", id: `r${reqN++}`, op, params }, { origin: ORIGIN, reply: (e) => got.push(e) });
    const e = got.find((x) => x.type === "delivery.reply");
    if (!e || e.type !== "delivery.reply") throw new Error(`${op}: no reply`);
    return e.reply;
  };
  const dir = join(tmp, ".controlroom", kitchenKey, "deliveries");
  return { ...s, kitchenKey, runner, typed, service, make, call, dir, rgit: new RecordsGit(runner, s.repo), view: () => service.view("10.1"), rview: () => service.view("10.1").records };
}
type Kitchen = Awaited<ReturnType<typeof kitchen>>;

/** The ticket through a verified merge (no checks, acknowledged). */
async function deliver(k: Kitchen) {
  okReply("inspect", await k.call("inspect", { key: "10.1" }));
  const i = k.view().inspection!;
  const t = { key: "10.1", head: i.head, base: i.base, tree: i.tree };
  okReply("approve", await k.call("approve", t));
  okReply("push", await k.call("push", { key: "10.1", head: i.head }));
  okReply("PR", await k.call("ensurePr", { key: "10.1" }));
  okReply("status", await k.call("status", { key: "10.1" }));
  okReply("acknowledge", await k.call("acknowledgeNoChecks", t));
  okReply("merge", await k.call("merge", t));
  const v = k.view();
  if (v.outcome !== "merged" || !v.verified) throw new Error("not merged and verified");
  return { merge: v.merged!.commit!, pr: v.merged!.pr };
}

async function reconcile(k: Kitchen, track?: "records") {
  const R = track ? { key: "10.1", track } : { key: "10.1" };
  okReply(`list${track ? " (records)" : ""}`, await k.call("reconcilePlan", R));
  const plan = track ? k.rview()!.after.reconcilePlan! : k.view().after.reconcilePlan!;
  okReply(`reconcile${track ? " (records)" : ""}`, await k.call("reconcile", { ...R, digest: plan.digest }));
}

const R = { key: "10.1", track: "records" } as const;
const fakeClient: DeliveryClient = { request: async () => ({ ok: false, id: "x", op: null, key: null, kind: "unavailable", message: "test", fix: null, reasons: [], view: null }) };
const render = (view: DeliveryView) =>
  renderToString(createElement(DeliveryPanel, { deliveryKey: view.key, board: { available: true, reason: null, byKey: { [view.key]: view } }, view, client: fakeClient }));
const show = (repo: string, rev: string, path: string) => execFileSync("git", ["show", `${rev}:${path}`], { cwd: repo, encoding: "utf8" });

// ---------------------------------------------------------------- pure rules

function pureRules() {
  const t = "# T\n\n## Status\n\nIn Progress\n\n## Parent Feature\n\n`10-demo.md` (see Notes)\n\n## Notes\n\nStatus: In Progress here is prose.\n";
  eq("status read", statusOf(t), "In Progress");
  eq("status: only the value line changes", withStatus(t, "Complete"), t.replace("## Status\n\nIn Progress\n", "## Status\n\nComplete\n"));
  eq("status: CRLF kept", withStatus("## Status\r\n\r\nReady\r\n", "Complete"), "## Status\r\n\r\nComplete\r\n");
  eq("status: unrecognised", statusOf("## Status\n\nDone-ish\n"), null);
  eq("status: missing section", withStatus("# x\n", "Complete"), null);
  eq("parent feature", parentFeatureOf(t), "10-demo.md");
  eq("no parent feature", parentFeatureOf("## Status\n\nReady\n"), null);
  const entry = historyEntry({ date: "2026-11-13", featureNumber: "10", featureTitle: "In-App `Delivery`", key: "10.3", pr: 7, mergeCommit: "c".repeat(40) });
  check("history entry: template shape", /^### 2026-11-13 — Feature 10: In-App Delivery\n\n- Outcome: `.+`\n- Verification: `.+`\n- Commit\/PR: `c{40}, PR #7`\n- Follow-up: `none`\n$/.test(entry), entry);
  eq("history: appended after a blank line", withHistoryEntry("# H\n\n## Completed\n\n", null, entry), `# H\n\n## Completed\n\n${entry}`);
  const template = "# Project History\n\n## Completed\n\n### [YYYY-MM-DD] — [Feature or milestone]\n\n- Outcome: `x`\n- Follow-up: `y`\n\nFollow-up is about the work.\n";
  eq("history: created from the template, its placeholder replaced", withHistoryEntry(null, template, entry), `# Project History\n\n## Completed\n\n${entry}\nFollow-up is about the work.\n`);
  eq("history: neither file nor template", withHistoryEntry(null, null, entry), null);
  eq("records branch", recordsBranch("10.3"), "ticket/10.3-records");
  check("is a records branch", isRecordsBranch("ticket/10.3-records", "10.3") && !isRecordsBranch("ticket/10.3-records", "10.4") && !isRecordsBranch("ticket/10.3-post-merge", "10.3"));

  // The wire: `track` is "records" or absent, only on the records delivery's ops.
  const H = "a".repeat(40);
  check("wire: records inspect", parseRequest({ rpc: "delivery", id: "w", op: "inspect", params: { key: "10.1", track: "records" } }).ok);
  check("wire: records merge", parseRequest({ rpc: "delivery", id: "w", op: "merge", params: { key: "10.1", head: H, base: H, tree: H, track: "records" } }).ok);
  check("wire: prepareRecords", parseRequest({ rpc: "delivery", id: "w", op: "prepareRecords", params: { key: "10.1" } }).ok);
  for (const [label, op, params] of [
    ["another track value", "inspect", { key: "10.1", track: "ticket" }],
    ["a track object", "inspect", { key: "10.1", track: { x: 1 } }],
    ["records of records (prepareRecords takes no track)", "prepareRecords", { key: "10.1", track: "records" }],
    ["a records handback", "handback", { key: "10.1", track: "records" }],
    ["a records plan", "plan", { key: "10.1", track: "records" }],
    ["a branch from the browser", "prepareRecords", { key: "10.1", branch: "ticket/10.1-records" }],
  ] as const)
    check(`wire refuses ${label}`, !parseRequest({ rpc: "delivery", id: "w", op, params }).ok);

  // The handback names where the records are.
  const M = "b".repeat(40);
  const text = handbackText("10.1", 7, M, { pr: 9, commit: "d".repeat(40) });
  check("handback: records PR named", text.includes(`records PR #9, squash-merged as ${"d".repeat(40)}`) && /do not edit or commit them again/.test(text) && /never leave completion edits uncommitted on main/.test(text));
  check("handback: already on main", /Local main already records it Complete/.test(handbackText("10.1", 7, M, { onMain: true })));
}

// ---------------------------------------------------------------- refused before the implementation merge is verified and in local main

async function beforeVerified() {
  const k = await kitchen("before");
  refusedReply("prepare before any merge", await k.call("prepareRecords", { key: "10.1" }), "refused", /Nothing is merged yet/);
  refusedReply("records inspect before any merge", await k.call("inspect", R), "refused", /no completion-records delivery yet/);
  check("no records view before the merge", k.view().records === null);
  check("no records branch", git(k.repo, "branch", "--list", recordsBranch("10.1")) === "");
  const { merge } = await deliver(k);

  // Merged and verified, but local main does not contain it yet.
  check("records view after the verified merge", !!k.rview() && k.rview()!.track === "records");
  refusedReply("prepare before local main has the merge", await k.call("prepareRecords", { key: "10.1" }), "refused", /reconcile the main checkout first/);
  check("records not ready before reconcile", k.rview()!.readiness.ready === false && /reconcile the main checkout first/.test(k.rview()!.readiness.reason ?? ""));
  refusedReply("records inspect before local main has the merge", await k.call("inspect", R), "refused", /reconcile the main checkout first/);
  check("still no records branch", git(k.repo, "branch", "--list", recordsBranch("10.1")) === "");

  // Merged but NOT verified (e.g. its verification failed): refused even when local main has it.
  await reconcile(k);
  const store = new DeliveryStore(k.dir);
  store.update("10.1", (s) => void (s.verified = false));
  await k.service.refresh();
  refusedReply("prepare with the merge unverified", await k.call("prepareRecords", { key: "10.1" }), "refused", /Verify the merge first/);
  store.update("10.1", (s) => void (s.verified = true));
  await k.service.refresh();

  // A records commit cut from a main without the merge is refused by the core check itself.
  const g = k.rgit;
  const impl = { pr: 100, mergeCommit: merge };
  const oldMain = git(k.repo, "rev-parse", `${merge}^`);
  const early = await intendedRecords(g, oldMain, "10.1", impl).catch((e: Error) => e);
  // (the old main's ticket record has no parent Feature: nothing can be derived there at all)
  check("old main: records cannot be derived", early instanceof Error && /names no parent Feature/.test(early.message), String(early));
  await refuses("core: a records commit whose parent lacks the merge", checkRecordsHead(g, { key: "10.1", head: oldMain, base: merge, tree: git(k.repo, "rev-parse", `${merge}^{tree}`), impl }), /never recorded before the implementation landed/);
  okReply("prepare once verified and in local main", await k.call("prepareRecords", { key: "10.1" }));
}

// ---------------------------------------------------------------- the exact-lines check

async function exactLines() {
  const k = await kitchen("exact");
  const { merge, pr } = await deliver(k);
  await reconcile(k);
  const g = k.rgit;
  const impl = { pr, mergeCommit: merge };
  const main = git(k.repo, "rev-parse", "refs/heads/main");
  const intended = await intendedRecords(g, main, "10.1", impl);
  eq(
    "intended: the ticket Status, the derived Feature Status and one history entry",
    intended.changes.map((c) => c.path),
    ["context/features/10-demo.md", "context/history.md", "context/tickets/10.1-demo.md"],
  );
  check("intended: Feature completes (10.1 is its only ticket)", intended.featureBefore === "In Progress" && intended.featureAfter === "Complete");
  const date = git(k.repo, "log", "-1", "--format=%cs", merge);
  const hist = intended.changes.find((c) => c.path === "context/history.md")!;
  check("intended: the history entry is appended, nothing else", hist.after.startsWith(hist.before!.replace(/\n*$/, "")) && hist.after.includes(`### ${date} — Feature 10: Demo Feature`) && hist.after.includes(`${merge}, PR #${pr}`));

  const branch = `refs/heads/${recordsBranch("10.1")}`;
  const tree = (c: string) => git(k.repo, "rev-parse", `${c}^{tree}`);
  /** Writes a records commit with the given changes (tampered or not), checks it, and removes the branch. */
  async function attempt(label: string, changes: IntendedRecords["changes"], expect: RegExp | null, parent = main) {
    const head = await writeRecordsCommit(g, { key: "10.1", parent, intended: { ...intended, from: parent, changes }, impl });
    try {
      const p = checkRecordsHead(g, { key: "10.1", head, base: main, tree: tree(head), impl });
      if (expect) await refuses(label, p, expect);
      else {
        const rc = await p;
        check(label, /records-only diff verified mechanically/.test(rc.evidence) && rc.parent === main, rc.evidence);
      }
    } finally {
      git(k.repo, "update-ref", "-d", branch);
    }
    return head;
  }
  const edit = (path: string, f: (s: string) => string) => intended.changes.map((c) => (c.path === path ? { ...c, after: f(c.after) } : c));
  const T = "context/tickets/10.1-demo.md";
  const F = "context/features/10-demo.md";
  const Hp = "context/history.md";

  await attempt("accepts exactly the intended records", intended.changes, null);
  await attempt("refuses an extra line in the ticket (needs normal review)", edit(T, (s) => s + "One more line.\n"), /needs normal review.*10\.1-demo\.md: differs from the intended change/);
  await attempt("refuses an extra file", [...intended.changes, { path: "src/extra.ts", before: null, after: "x\n", mode: "100644", why: "extra" }], /src\/extra\.ts: not a completion record/);
  await attempt("refuses a wrong ticket status", edit(T, (s) => s.replace("## Status\n\nComplete", "## Status\n\nCancelled")), /10\.1-demo\.md: differs from the intended change/);
  await attempt("refuses a wrong Feature status", edit(F, (s) => s.replace("## Status\n\nComplete", "## Status\n\nIn Progress")), /10-demo\.md: differs/);
  await attempt("refuses an edit elsewhere in the Feature file", edit(F, (s) => s.replace("Demo.", "Demo, rewritten.")), /10-demo\.md: differs/);
  await attempt("refuses an edit elsewhere in the ticket file", edit(T, (s) => s.replace("Claimed note.", "Claimed note, edited.")), /10\.1-demo\.md: differs/);
  await attempt("refuses an edit to the history header", edit(Hp, (s) => s.replace("Compact record", "A record")), /history\.md: differs/);
  await attempt("refuses a second history entry", edit(Hp, (s) => s + "\n" + s.slice(s.indexOf("### "))), /history\.md: differs/);
  await attempt("refuses a missing record", intended.changes.filter((c) => c.path !== Hp), /history\.md: missing/);
  await attempt("refuses a mode change", intended.changes.map((c) => (c.path === T ? { ...c, mode: "100755" } : c)), /mode 100755/);

  // Two commits on top of main: the parent is not on origin's main.
  const first = await writeRecordsCommit(g, { key: "10.1", parent: main, intended, impl });
  git(k.repo, "update-ref", "-d", branch);
  await refuses("refuses records stacked on another unmerged commit", (async () => {
    const second = await writeRecordsCommit(g, { key: "10.1", parent: first, intended: { ...(await intendedRecords(g, main, "10.1", impl)), from: first }, impl });
    git(k.repo, "update-ref", "-d", branch);
    return checkRecordsHead(g, { key: "10.1", head: second, base: main, tree: tree(second), impl });
  })(), /not on origin's main/);

  // A commit with an extra file is refused by the service too, as needing normal review, and cannot be approved.
  const bad = await writeRecordsCommit(g, { key: "10.1", parent: main, intended: { ...intended, changes: [...intended.changes, { path: "notes.md", before: null, after: "n\n", mode: "100644", why: "x" }] }, impl });
  await k.service.refresh();
  refusedReply("prepare keeps a records branch that is not exactly the records", await k.call("prepareRecords", { key: "10.1" }), "refused", /notes\.md: not a completion record/);
  eq("the branch is not moved", git(k.repo, "rev-parse", branch), bad);
  refusedReply("service inspect: needs normal review", await k.call("inspect", R), "refused", /needs normal review/);
  refusedReply("no approval without an inspection", await k.call("approve", { ...R, head: bad, base: main, tree: tree(bad) }), "refused", /Inspect first/);
  check("drawer: approve not offered", !/data-op="approve"/.test(render(k.view())) || /data-op="approve"[^>]*disabled/.test(render(k.view())));
  git(k.repo, "update-ref", "-d", branch);

  // On a main that moved on (another ticket merged): what lands is checked against that main too.
  const p = await intendedRecords(g, main, "10.1", impl);
  const good = await writeRecordsCommit(g, { key: "10.1", parent: main, intended: p, impl });
  git(k.repo, "checkout", "-q", "main");
  writeFileSync(join(k.repo, "other.txt"), "other ticket\n");
  git(k.repo, "add", "other.txt");
  git(k.repo, "commit", "-q", "-m", "another ticket");
  const moved = git(k.repo, "rev-parse", "HEAD");
  const mtree = git(k.repo, "merge-tree", "--write-tree", moved, good).split("\n")[0];
  const ok = await checkRecordsHead(g, { key: "10.1", head: good, base: moved, tree: mtree, impl }).then(
    () => true,
    (e: Error) => e.message,
  );
  check("records verified onto a main that moved on", ok === true, ok);
  // ... and refused when, on that main, the merge would land something else (a sibling ticket added there makes the Feature not complete).
  git(k.repo, "update-ref", "-d", branch);
  writeFileSync(join(k.repo, "context/tickets/10.2-next.md"), "# Next\n\n## Status\n\nReady\n\n## Parent Feature\n\n`10-demo.md`\n");
  git(k.repo, "add", "-A");
  git(k.repo, "commit", "-q", "-m", "sibling ticket");
  const moved2 = git(k.repo, "rev-parse", "HEAD");
  const mtree2 = git(k.repo, "merge-tree", "--write-tree", moved2, good).split("\n")[0];
  await refuses("refused when the base now derives other records", checkRecordsHead(g, { key: "10.1", head: good, base: moved2, tree: mtree2, impl }), /merge of ticket\/10\.1-records onto .* is not exactly/);
}

// ---------------------------------------------------------------- the records PR, end to end; approval bound to the exact head; no recursion

async function recordsPr() {
  const k = await kitchen("pr");
  const impl = await deliver(k);
  await reconcile(k);
  const ticketApproval = k.view().merged!.approval!;

  check("drawer: prepare offered once local main has the merge", /data-op="prepareRecords"(?![^>]*disabled)/.test(render(k.view())));
  check("handback waits for the records", /completion records first/.test(gateOf(k.view(), "handback")?.message ?? "") && recordsSettled(k.view()) !== null);
  const prep = okReply("prepare", await k.call("prepareRecords", { key: "10.1" }));
  const rp = k.view().recordsPrep!;
  const head = rp.head!;
  check("prepared on ticket/10.1-records, cut from the updated main", rp.branch === "ticket/10.1-records" && rp.parent === git(k.repo, "rev-parse", "refs/heads/main") && git(k.repo, "rev-parse", "refs/heads/ticket/10.1-records") === head, rp);
  check("prepare reply lists the changes", /10\.1-demo\.md: ## Status In Progress → Complete/.test(prep.message), prep.message);
  check("the main checkout is untouched by preparing", execFileSync("git", ["status", "--porcelain"], { cwd: k.repo, encoding: "utf8" }) === "");
  refusedReply("the gate says it is prepared", await k.call("prepareRecords", { key: "10.1" }), "refused", /prepared on ticket\/10\.1-records/);
  // With the prepared record lost, preparing again accepts the existing branch only because it is exactly the records.
  new DeliveryStore(k.dir).update("10.1", (s) => void (s.recordsPrep = null));
  const again = okReply("prepare again: the existing branch is kept", await k.call("prepareRecords", { key: "10.1" }));
  check("says it was already prepared", /already prepared at/.test(again.message), again.message);
  eq("still the same records head", git(k.repo, "rev-parse", "refs/heads/ticket/10.1-records"), head);

  // The records delivery has its own state: a separate file, its own approval.
  okReply("records inspect", await k.call("inspect", R));
  const ri = k.rview()!.inspection!;
  check("records inspection: the exact records head", ri.head === head && ri.branch === "ticket/10.1-records" && /records-only diff verified mechanically/.test(ri.evidence.line ?? ""));
  eq("records inspection: exactly the three files", ri.files.map((f) => f.path).sort(), ["context/features/10-demo.md", "context/history.md", "context/tickets/10.1-demo.md"]);
  const t = { ...R, head: ri.head, base: ri.base, tree: ri.tree };
  refusedReply("the ticket's approval is not the records' approval", await k.call("merge", { ...R, head: ticketApproval.head, base: ticketApproval.base, tree: ticketApproval.tree }), "refused", /Approve this exact merge first/);
  refusedReply("approve another head", await k.call("approve", { ...t, head: "f".repeat(40) }), "stale", /not for what was last inspected/);
  okReply("approve the exact records head", await k.call("approve", t));
  check("records state is its own file", existsSync(join(k.dir, "10.1.records.json")) && JSON.parse(readFileSync(join(k.dir, "10.1.records.json"), "utf8")).approval.head === head);
  check("the ticket's own state keeps its merge approval", new DeliveryStore(k.dir).read("10.1").merged!.approval!.head === ticketApproval.head && new DeliveryStore(k.dir).read("10.1").approval?.head !== head);

  // The approval binds to the exact head: the branch moving (a different commit, same records) invalidates it.
  const other = git(k.repo, "commit-tree", git(k.repo, "rev-parse", `${head}^{tree}`), "-p", rp.parent, "-m", "same records, another commit");
  git(k.repo, "update-ref", "refs/heads/ticket/10.1-records", other, head);
  refusedReply("push after the records head moved", await k.call("push", { ...R, head }), "stale", /now at/);
  check("approval invalidated, with why", k.rview()!.approvalState === "stale" && k.rview()!.staleReasons.some((r) => r.includes(`head moved from ${head}`)), k.rview()!.staleReasons);
  check("nothing pushed", !k.world.remote.has("refs/heads/ticket/10.1-records"));
  git(k.repo, "update-ref", "refs/heads/ticket/10.1-records", head, other);
  okReply("inspect again", await k.call("inspect", R));
  okReply("approve again", await k.call("approve", t));

  okReply("records push", await k.call("push", { ...R, head }));
  const prR = okReply("records PR", await k.call("ensurePr", R));
  const prNum = (prR.data as { pr: { number: number } }).pr.number;
  const fpr = k.world.prs.find((p) => p.number === prNum)!;
  check("records PR: its own title and branch", fpr.title === "Completion records for ticket 10.1" && fpr.headRefName === "ticket/10.1-records" && fpr.number !== impl.pr, fpr);
  okReply("records status", await k.call("status", R));
  // The remote records branch moved after approval: merge refused (pinned to the approved head).
  okReply("records acknowledge", await k.call("acknowledgeNoChecks", t));
  okReply("records merge", await k.call("merge", t));
  const rv = k.rview()!;
  check("records merged and verified", rv.outcome === "merged" && rv.verified && rv.merged!.approval!.head === head);
  const rm = rv.merged!.commit!;
  eq("records merge changes exactly the records", git(k.repo, "diff", "--name-only", `${rm}^`, rm).split("\n").sort(), ["context/features/10-demo.md", "context/history.md", "context/tickets/10.1-demo.md"]);
  check("on origin's main: ticket Complete, Feature Complete, one entry", /## Status\n\nComplete\n/.test(show(k.repo, rm, "context/tickets/10.1-demo.md")) && /## Status\n\nComplete\n/.test(show(k.repo, rm, "context/features/10-demo.md")) && show(k.repo, rm, "context/history.md").split("### ").length === 2);
  check("the ticket's implementation merge is untouched", k.view().merged!.commit === impl.merge && k.view().verified);

  // No recursion: the records delivery offers no records, handback or plan; preparing again is refused.
  for (const op of ["prepareRecords", "handback", "plan"] as const) check(`records track: no ${op}`, /no records, handback or plan of its own/.test(gateOf(rv, op)?.message ?? ""));
  check("records view has no records of its own", rv.records === null && rv.recordsPrep === null && rv.after.handback === null && rv.after.coordinator === false);
  refusedReply("prepare after the records merged", await k.call("prepareRecords", { key: "10.1" }), "refused", /already merged/);
  check("drawer: the ticket's panel nests the records panel", render(k.view()).includes('data-track="records"'));
  check("drawer: the records panel has no records, handback or plan buttons", (() => {
    const html = render(rv);
    return html.includes('data-track="records"') && !/data-op="handback"/.test(html) && !/data-op="plan"/.test(html) && !/data-op="prepareRecords"/.test(html);
  })());

  // The handback waits until local main has the records too, then names them.
  refusedReply("handback before local main has the records", await k.call("handback", { key: "10.1" }), "refused", /reconcile the main checkout for them first/);
  await reconcile(k, "records");
  check("records reconciled into local main", k.rview()!.after.mainHasMerge === true && recordsSettled(k.view()) === null);
  check("no records-of-records state", !existsSync(join(k.dir, "10.1.records.records.json")));
  okReply("handback", await k.call("handback", { key: "10.1" }));
  check("handback names the records PR", k.typed.length === 1 && k.typed[0].includes(`records PR #${prNum}, squash-merged as ${rm}`), k.typed);

  // A ticket whose delivered branch is itself a records branch never gets records.
  const k2 = await kitchen("recursion");
  await deliver(k2);
  await reconcile(k2);
  new DeliveryStore(k2.dir).update("10.1", (s) => void (s.branch = "ticket/10.1-records"));
  refusedReply("records for a records branch", await k2.call("prepareRecords", { key: "10.1" }), "refused", /never produces another records PR/);
  check("no records branch created for it", git(k2.repo, "branch", "--list", recordsBranch("10.1")) === "");
}

// ---------------------------------------------------------------- the Feature left alone while siblings are open; already Complete on main

async function featureAndOnMain() {
  const k = await kitchen("siblings", { siblings: { "10.2-next.md": "# Next\n\n## Status\n\nReady\n\n## Parent Feature\n\n`10-demo.md`\n", "11.1-other.md": "# Other\n\n## Status\n\nIn Progress\n" } });
  await deliver(k);
  await reconcile(k);
  okReply("prepare", await k.call("prepareRecords", { key: "10.1" }));
  eq("only the ticket's Status (Feature still open, no history entry)", k.view().recordsPrep!.changes, ["context/tickets/10.1-demo.md: ## Status In Progress → Complete"]);
  const head = k.view().recordsPrep!.head!;
  eq("the records commit changes one file", git(k.repo, "diff", "--name-only", `${head}^`, head), "context/tickets/10.1-demo.md");
  okReply("inspect", await k.call("inspect", R));

  // A sibling with an unrecognised status: the Feature cannot be derived, so nothing is guessed.
  const k2 = await kitchen("unrecognised", { siblings: { "10.2-next.md": "# Next\n\n## Status\n\nDone-ish\n" } });
  await deliver(k2);
  await reconcile(k2);
  refusedReply("an unrecognised sibling status", await k2.call("prepareRecords", { key: "10.1" }), "refused", /10\.2-next\.md has no recognisable status/);

  // No history file and no template: refused, not invented.
  const k3 = await kitchen("nohistory", { history: null });
  await deliver(k3);
  await reconcile(k3);
  refusedReply("no history file or template", await k3.call("prepareRecords", { key: "10.1" }), "refused", /history\.template\.md has no placeholder/);

  // Local main already records the ticket Complete: nothing to deliver, the handback is allowed.
  const k4 = await kitchen("onmain");
  await deliver(k4);
  await reconcile(k4);
  git(k4.repo, "checkout", "-q", "main");
  writeFileSync(join(k4.repo, "context/tickets/10.1-demo.md"), show(k4.repo, "HEAD", "context/tickets/10.1-demo.md").replace("## Status\n\nIn Progress", "## Status\n\nComplete"));
  git(k4.repo, "commit", "-q", "-am", "completed by hand");
  k4.world.remote.set("refs/heads/main", git(k4.repo, "rev-parse", "HEAD"));
  const r = okReply("prepare: already on main", await k4.call("prepareRecords", { key: "10.1" }));
  check("says there is nothing to deliver", /already records 10\.1 Complete/.test(r.message) && k4.view().recordsPrep!.onMain && k4.view().recordsPrep!.head === null);
  check("no records branch", git(k4.repo, "branch", "--list", recordsBranch("10.1")) === "");
  check("handback allowed", gateOf(k4.view(), "handback") === null);
  okReply("handback", await k4.call("handback", { key: "10.1" }));
  check("handback says main already records it", /Local main already records it Complete/.test(k4.typed[0] ?? ""));
}

async function main() {
  pureRules();
  await beforeVerified();
  await exactLines();
  await recordsPr();
  await featureAndOnMain();
}

main()
  .catch((e) => failures.push(`aborted: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
  .finally(() => {
    if (failures.length) {
      console.error(`FAIL ${failures.length} of ${passed + failures.length} checks:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`ok ${passed} checks passed`);
  });
