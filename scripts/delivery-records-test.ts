// Completion records as their own records PR (ticket 10.3; human decision
// 2026-11-13). Against 10.1's fake world (scripts/delivery-fake.ts) for
// everything GitHub, with real local git on throwaway repositories and a
// temporary HOME. Nothing is pushed; the real main checkout, the live kitchen
// and its coordinator are never touched.
//
//   pnpm exec tsx scripts/delivery-records-test.ts
//
// Covers: refusal before the implementation merge is verified, before local
// main contains it, and before the engine's claim is released; the exact-lines
// check (the intended records accepted; an extra line, an extra file, a wrong
// status, edits elsewhere in those files, a mode change, a second commit refused
// as needing normal review); no recursion; the approval bound to the exact
// records head; the same push, PR, merge and verification as a ticket; the
// records delivery's own state; the commit kept under the kitchen's ref, never a
// local branch; the Feature left alone while siblings are open, in the commit or
// only in the store; a file that is not plain text; and "already Complete on
// main".

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { gateOf, isReadyToDeliver, recordsSettled, type DeliveryBoard, type DeliveryClient, type DeliveryReply, type DeliveryView } from "../src/data/delivery";
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
  recordsRef,
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
const LOCAL = new Set(["--no-optional-locks", "--literal-pathspecs", "ls-tree", "ls-files", "symbolic-ref", "merge", "checkout", "rm", "checkout-index", "update-index", "hash-object", "mktree", "commit-tree", "update-ref"]);

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

/** What `orchestrate release` leaves: no claim for the ticket (the fake engine then answers `owner` with none). */
function release(k: Kitchen) {
  k.world.claims.delete("10.1");
}

/** The kitchen's records ref, or "" when there is none; and that no local records branch exists. */
const REF = recordsRef("10.1");
const refHead = (repo: string) => git(repo, "for-each-ref", "--format=%(objectname)", REF);
const noBranch = (repo: string) => git(repo, "branch", "--list", recordsBranch("10.1")) === "";
const buttons = (html: string, op: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(`data-op="${op}"`));

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
  eq("records ref: the kitchen's own, not a branch", recordsRef("10.3"), "refs/tin-and-thyme/records/10.3");
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

  // The handback says who writes the records, and when.
  const text = handbackText("10.1", 7, "b".repeat(40));
  check("handback: the records are the kitchen's records PR, after the release", /records PR from ticket\/10\.1-records once this claim is released/.test(text) && /do not edit, commit or push them yourself/.test(text) && /never leave completion edits uncommitted on main/.test(text));
}

// ---------------------------------------------------------------- refused before the implementation merge is verified and in local main

async function beforeVerified() {
  const k = await kitchen("before");
  refusedReply("prepare before any merge", await k.call("prepareRecords", { key: "10.1" }), "refused", /Nothing is merged yet/);
  refusedReply("records inspect before any merge", await k.call("inspect", R), "refused", /no completion-records delivery yet/);
  check("no records view before the merge", k.view().records === null);
  check("no records commit", refHead(k.repo) === "" && noBranch(k.repo));
  const { merge } = await deliver(k);

  // Merged and verified, but local main does not contain it yet.
  check("records view after the verified merge", !!k.rview() && k.rview()!.track === "records");
  refusedReply("prepare before local main has the merge", await k.call("prepareRecords", { key: "10.1" }), "refused", /reconcile the main checkout first/);
  check("records not ready before reconcile", k.rview()!.readiness.ready === false && /reconcile the main checkout first/.test(k.rview()!.readiness.reason ?? ""));
  refusedReply("records inspect before local main has the merge", await k.call("inspect", R), "refused", /reconcile the main checkout first/);
  check("still no records commit", refHead(k.repo) === "" && noBranch(k.repo));

  // In local main, but the claim is still held: the release comes first (orchestrate release proves the merge from local main).
  await reconcile(k);
  check("view: the claim is still held", k.view().after.claimReleased === false);
  refusedReply("prepare before the claim is released", await k.call("prepareRecords", { key: "10.1" }), "refused", /Hand the ticket back first.*released 10\.1's claim/);
  check("drawer: prepare disabled, and says why", buttons(render(k.view()), "prepareRecords").length === 1 && buttons(render(k.view()), "prepareRecords").every((b) => b.includes("disabled") && b.includes("Hand the ticket back first")));
  check("still no records commit while the claim is held", refHead(k.repo) === "" && noBranch(k.repo));
  release(k);
  await k.service.refresh();
  check("view: the claim is released", k.view().after.claimReleased === true);
  // The server asks the engine itself before writing: a claim that is held again is refused whatever the view says.
  k.world.claims.set("10.1", { branch: "ticket/10.1-demo", worktree: ".pathfinder/worktrees/10.1", state: "done", last: "x", ref: "context/tickets/10.1-demo.md", title: "Demo feature" });
  refusedReply("prepare with the claim held again (the server asks the engine)", await k.call("prepareRecords", { key: "10.1" }), "refused", /claim is still held \(ticket\/10\.1-demo in \.pathfinder\/worktrees\/10\.1\).*nothing was prepared/);
  check("nothing written", refHead(k.repo) === "");
  release(k);

  // Merged but NOT verified (e.g. its verification failed): refused even when local main has it.
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
  const early = await intendedRecords(g, oldMain, "10.1", impl, []).catch((e: Error) => e);
  // (the old main's ticket record has no parent Feature: nothing can be derived there at all)
  check("old main: records cannot be derived", early instanceof Error && /names no parent Feature/.test(early.message), String(early));
  await refuses("core: a records commit whose parent lacks the merge", checkRecordsHead(g, { key: "10.1", head: oldMain, base: merge, tree: git(k.repo, "rev-parse", `${merge}^{tree}`), impl, store: [] }), /never recorded before the implementation landed/);
  okReply("prepare once verified, in local main and released", await k.call("prepareRecords", { key: "10.1" }));
  check("the records commit is under the kitchen's ref, not a branch", refHead(k.repo) === k.view().recordsPrep!.head && noBranch(k.repo) && k.view().recordsPrep!.ref === REF);
}

// ---------------------------------------------------------------- the exact-lines check

const T0 = "context/tickets/10.1-demo.md";
const ALL = ["context/features/10-demo.md", "context/history.md", "context/tickets/10.1-demo.md"];

async function exactLines() {
  const k = await kitchen("exact");
  const { merge, pr } = await deliver(k);
  await reconcile(k);
  release(k);
  const g = k.rgit;
  const impl = { pr, mergeCommit: merge };
  const main = git(k.repo, "rev-parse", "refs/heads/main");
  const intended = await intendedRecords(g, main, "10.1", impl, []);
  eq(
    "intended: the ticket Status, the derived Feature Status and one history entry",
    intended.changes.map((c) => c.path),
    ["context/features/10-demo.md", "context/history.md", "context/tickets/10.1-demo.md"],
  );
  check("intended: Feature completes (10.1 is its only ticket)", intended.featureBefore === "In Progress" && intended.featureAfter === "Complete");
  const date = git(k.repo, "log", "-1", "--format=%cs", merge);
  const hist = intended.changes.find((c) => c.path === "context/history.md")!;
  check("intended: the history entry is appended, nothing else", hist.after.startsWith(hist.before!.replace(/\n*$/, "")) && hist.after.includes(`### ${date} — Feature 10: Demo Feature`) && hist.after.includes(`${merge}, PR #${pr}`));

  const branch = REF;
  const tree = (c: string) => git(k.repo, "rev-parse", `${c}^{tree}`);

  // The Feature completes only when its other tickets are done in the store too (the store can hold tickets main does not track).
  const derive = async (store: { key: string; status: string }[]) => (await intendedRecords(g, main, "10.1", impl, store)).changes.map((c) => c.path);
  eq("store: an open sibling only the store knows keeps the Feature open", await derive([{ key: "10.2", status: "Proposed" }]), [T0]);
  eq("store: an unrecognised sibling status keeps the Feature open", await derive([{ key: "10.2", status: "unrecognised" }]), [T0]);
  eq("store: done siblings let the Feature complete", await derive([{ key: "10.2", status: "Complete" }, { key: "10.4", status: "cancelled" }, { key: "10.5", status: "Superseded" }]), ALL);
  eq("store: the ticket's own row and other Features' tickets do not count", await derive([{ key: "10.1", status: "In Progress" }, { key: "11.1", status: "Proposed" }, { key: "1.1", status: "Ready" }]), ALL);

  /** Writes a records commit with the given changes (tampered or not), checks it, and removes the branch. */
  async function attempt(label: string, changes: IntendedRecords["changes"], expect: RegExp | null, parent = main) {
    const head = await writeRecordsCommit(g, { key: "10.1", parent, intended: { ...intended, from: parent, changes }, impl });
    try {
      const p = checkRecordsHead(g, { key: "10.1", head, base: main, tree: tree(head), impl, store: [] });
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
  await attempt("refuses a Feature status left as it was", edit(F, (s) => s.replace("## Status\n\nComplete", "## Status\n\nIn Progress")), /10-demo\.md: missing/);
  await attempt("refuses a wrong Feature status", edit(F, (s) => s.replace("## Status\n\nComplete", "## Status\n\nCancelled")), /10-demo\.md: differs/);
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
    const second = await writeRecordsCommit(g, { key: "10.1", parent: first, intended: { ...(await intendedRecords(g, main, "10.1", impl, [])), from: first }, impl });
    git(k.repo, "update-ref", "-d", branch);
    return checkRecordsHead(g, { key: "10.1", head: second, base: main, tree: tree(second), impl, store: [] });
  })(), /not on origin's main/);

  // A commit with an extra file is refused by the service too, as needing normal review, and cannot be approved.
  const bad = await writeRecordsCommit(g, { key: "10.1", parent: main, intended: { ...intended, changes: [...intended.changes, { path: "notes.md", before: null, after: "n\n", mode: "100644", why: "x" }] }, impl });
  await k.service.refresh();
  refusedReply("service inspect: needs normal review", await k.call("inspect", R), "refused", /needs normal review.*notes\.md: not a completion record/);
  eq("the ref is not moved by a refused inspection", git(k.repo, "rev-parse", branch), bad);
  refusedReply("no approval without an inspection", await k.call("approve", { ...R, head: bad, base: main, tree: tree(bad) }), "refused", /Inspect first/);
  check("drawer: approve not offered", buttons(render(k.view()), "approve").length > 0 && buttons(render(k.view()), "approve").every((b) => b.includes("disabled")));
  check("nothing of it reached origin", !k.world.remote.has("refs/heads/ticket/10.1-records") && k.world.prs.every((x) => x.headRefName !== "ticket/10.1-records"));
  // Preparing again commits the exact records in its place (the kitchen's own ref, nothing merged or pending), and says so.
  const redone = okReply("prepare replaces a commit that is not exactly the records", await k.call("prepareRecords", { key: "10.1" }));
  check("says what it replaced, and why", redone.message.includes(`replaces the earlier commit ${bad}`) && /notes\.md: not a completion record/.test(redone.message), redone.message);
  check("the ref now holds exactly the records", refHead(k.repo) !== bad && git(k.repo, "diff", "--name-only", `${refHead(k.repo)}^`, refHead(k.repo)).split("\n").sort().join() === ALL.join());
  okReply("and it inspects", await k.call("inspect", R));
  git(k.repo, "update-ref", "-d", branch);

  // On a main that moved on (another ticket merged): what lands is checked against that main too.
  const p = await intendedRecords(g, main, "10.1", impl, []);
  const good = await writeRecordsCommit(g, { key: "10.1", parent: main, intended: p, impl });
  git(k.repo, "checkout", "-q", "main");
  writeFileSync(join(k.repo, "other.txt"), "other ticket\n");
  git(k.repo, "add", "other.txt");
  git(k.repo, "commit", "-q", "-m", "another ticket");
  const moved = git(k.repo, "rev-parse", "HEAD");
  const mtree = git(k.repo, "merge-tree", "--write-tree", moved, good).split("\n")[0];
  const ok = await checkRecordsHead(g, { key: "10.1", head: good, base: moved, tree: mtree, impl, store: [] }).then(
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
  await refuses("refused when the base now derives other records", checkRecordsHead(g, { key: "10.1", head: good, base: moved2, tree: mtree2, impl, store: [] }), /merge of ticket\/10\.1-records onto .* is not exactly/);
  // ... and likewise when only the store learns of an open sibling after the records were prepared.
  await refuses("refused when the store now derives other records", checkRecordsHead(g, { key: "10.1", head: good, base: moved, tree: mtree, impl, store: [{ key: "10.3", status: "Ready" }] }), /10-demo\.md: not a completion record/);
}

// ---------------------------------------------------------------- the records PR, end to end; approval bound to the exact head; no recursion

async function recordsPr() {
  const k = await kitchen("pr");
  const impl = await deliver(k);
  await reconcile(k);
  const ticketApproval = k.view().merged!.approval!;

  // The handback comes first, with no records yet; the coordinator then releases the claim.
  check("handback allowed before the records", gateOf(k.view(), "handback") === null && /hand the ticket back/.test(recordsSettled(k.view()) ?? ""));
  okReply("handback", await k.call("handback", { key: "10.1" }));
  check("handback typed once, naming the records PR to come", k.typed.length === 1 && /records PR from ticket\/10\.1-records once this claim is released/.test(k.typed[0]), k.typed);
  release(k);
  await k.service.refresh();
  check("drawer: prepare offered once the claim is released", buttons(render(k.view()), "prepareRecords").length === 1 && buttons(render(k.view()), "prepareRecords").every((b) => !b.includes("disabled")));
  const prep = okReply("prepare", await k.call("prepareRecords", { key: "10.1" }));
  const rp = k.view().recordsPrep!;
  const head = rp.head!;
  check("prepared for ticket/10.1-records, cut from the updated main", rp.branch === "ticket/10.1-records" && rp.ref === REF && rp.parent === git(k.repo, "rev-parse", "refs/heads/main") && refHead(k.repo) === head, rp);
  check("no local branch was created (the engine would read it as a claim)", noBranch(k.repo) && git(k.repo, "for-each-ref", "refs/heads/ticket/") .split("\n").every((l) => !l.includes("records")));
  eq("the records commit: one commit on local main", git(k.repo, "rev-parse", `${head}^`), rp.parent);
  check("prepare reply lists the changes", /10\.1-demo\.md: ## Status In Progress → Complete/.test(prep.message), prep.message);
  check("the main checkout is untouched by preparing", execFileSync("git", ["status", "--porcelain"], { cwd: k.repo, encoding: "utf8" }) === "");
  // Preparing again keeps the existing commit, because it is still exactly the records (also with the prepared record lost).
  check("prepare again: kept", /already prepared at/.test(okReply("prepare again", await k.call("prepareRecords", { key: "10.1" })).message));
  new DeliveryStore(k.dir).update("10.1", (s) => void (s.recordsPrep = null));
  const again = okReply("prepare again, the record lost: the existing commit is kept", await k.call("prepareRecords", { key: "10.1" }));
  check("says it was already prepared", /already prepared at/.test(again.message) && k.view().recordsPrep?.head === head, again.message);
  eq("still the same records head", refHead(k.repo), head);

  // The records delivery has its own state: a separate file, its own approval.
  okReply("records inspect", await k.call("inspect", R));
  const ri = k.rview()!.inspection!;
  check("records inspection: the exact records head", ri.head === head && ri.branch === "ticket/10.1-records" && /records-only diff verified mechanically/.test(ri.evidence.line ?? ""));
  check("records view: ready to deliver, for the records branch", isReadyToDeliver(k.rview()!) && k.rview()!.branch === "ticket/10.1-records" && k.rview()!.readiness.reviewedHead === head);
  eq("records inspection: exactly the three files", ri.files.map((f) => f.path).sort(), ["context/features/10-demo.md", "context/history.md", "context/tickets/10.1-demo.md"]);
  const t = { ...R, head: ri.head, base: ri.base, tree: ri.tree };
  refusedReply("the ticket's approval is not the records' approval", await k.call("merge", { ...R, head: ticketApproval.head, base: ticketApproval.base, tree: ticketApproval.tree }), "refused", /Approve this exact merge first/);
  refusedReply("approve another head", await k.call("approve", { ...t, head: "f".repeat(40) }), "stale", /not for what was last inspected/);
  okReply("approve the exact records head", await k.call("approve", t));
  check("records state is its own file", existsSync(join(k.dir, "10.1.records.json")) && JSON.parse(readFileSync(join(k.dir, "10.1.records.json"), "utf8")).approval.head === head);
  check("the ticket's own state keeps its merge approval", new DeliveryStore(k.dir).read("10.1").merged!.approval!.head === ticketApproval.head && new DeliveryStore(k.dir).read("10.1").approval?.head !== head);

  // The approval binds to the exact head: the branch moving (a different commit, same records) invalidates it.
  const other = git(k.repo, "commit-tree", git(k.repo, "rev-parse", `${head}^{tree}`), "-p", rp.parent, "-m", "same records, another commit");
  git(k.repo, "update-ref", REF, other, head);
  refusedReply("push after the records head moved", await k.call("push", { ...R, head }), "stale", /now at/);
  check("approval invalidated, with why", k.rview()!.approvalState === "stale" && k.rview()!.staleReasons.some((r) => r.includes(`head moved from ${head}`)), k.rview()!.staleReasons);
  check("nothing pushed", !k.world.remote.has("refs/heads/ticket/10.1-records"));
  git(k.repo, "update-ref", REF, head, other);
  okReply("inspect again", await k.call("inspect", R));
  okReply("approve again", await k.call("approve", t));

  const pushesBefore = k.world.calls.filter((c) => c.cmd === "git" && c.args[0] === "push").length;
  okReply("records push", await k.call("push", { ...R, head }));
  const pushes = k.world.calls.filter((c) => c.cmd === "git" && c.args[0] === "push").slice(pushesBefore);
  eq("the one push: exactly <records head>:refs/heads/ticket/10.1-records, no force, no tags", pushes.map((c) => c.args), [["push", "--no-follow-tags", "--porcelain", "origin", `${head}:refs/heads/ticket/10.1-records`]]);
  check("origin has the records branch at that head, and nothing of the kitchen's own refs", k.world.remote.get("refs/heads/ticket/10.1-records") === head && [...k.world.remote.keys()].every((r) => !/tin-and-thyme|refs\/backup|refs\/pathfinder/.test(r)), [...k.world.remote.keys()]);
  const prR = okReply("records PR", await k.call("ensurePr", R));
  const prNum = (prR.data as { pr: { number: number } }).pr.number;
  const fpr = k.world.prs.find((p) => p.number === prNum)!;
  check("records PR: its own title and branch", fpr.title === "Completion records for ticket 10.1" && fpr.headRefName === "ticket/10.1-records" && fpr.number !== impl.pr, fpr);
  okReply("records status", await k.call("status", R));
  // No checks reported: the same explicit acknowledgement as any delivery, on the records check as its evidence.
  refusedReply("records merge without the acknowledgement", await k.call("merge", t), "blocked", /No checks reported/);
  okReply("records acknowledge", await k.call("acknowledgeNoChecks", t));
  const mergesBefore = k.world.calls.filter((c) => c.cmd === "gh" && c.args[1] === "merge").length;
  okReply("records merge", await k.call("merge", t));
  const merges = k.world.calls.filter((c) => c.cmd === "gh" && c.args[1] === "merge").slice(mergesBefore);
  check("the one merge: squash, pinned to the approved records head", merges.length === 1 && merges[0].args.includes("--squash") && merges[0].args[merges[0].args.indexOf("--match-head-commit") + 1] === head && !merges[0].args.includes("--delete-branch") && !merges[0].args.includes("--auto"), merges.map((c) => c.args));
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

  // Local main gets the records through the same reconcile; nothing more is typed to the coordinator.
  check("the records are not on local main yet", /reconcile the main checkout for them/.test(recordsSettled(k.view()) ?? ""));
  await reconcile(k, "records");
  check("records reconciled into local main", k.rview()!.after.mainHasMerge === true && recordsSettled(k.view()) === null && git(k.repo, "rev-parse", "refs/heads/main") === rm);
  check("the main checkout now records the ticket Complete", /## Status\n\nComplete\n/.test(readFileSync(join(k.repo, "context/tickets/10.1-demo.md"), "utf8")));
  check("no records-of-records state", !existsSync(join(k.dir, "10.1.records.records.json")));
  refusedReply("the handback is never sent twice", await k.call("handback", { key: "10.1" }), "refused", /never sent twice/);
  eq("typed once in all", k.typed.length, 1);
  check("still no local records branch", noBranch(k.repo));

  // A ticket whose delivered branch is itself a records branch never gets records.
  const k2 = await kitchen("recursion");
  await deliver(k2);
  await reconcile(k2);
  release(k2);
  new DeliveryStore(k2.dir).update("10.1", (s) => void (s.branch = "ticket/10.1-records"));
  refusedReply("records for a records branch", await k2.call("prepareRecords", { key: "10.1" }), "refused", /never produces another records PR/);
  check("no records commit created for it", refHead(k2.repo) === "" && noBranch(k2.repo));
}

// ---------------------------------------------------------------- the Feature left alone while siblings are open; already Complete on main

async function featureAndOnMain() {
  const k = await kitchen("siblings", { siblings: { "10.2-next.md": "# Next\n\n## Status\n\nReady\n\n## Parent Feature\n\n`10-demo.md`\n", "11.1-other.md": "# Other\n\n## Status\n\nIn Progress\n" } });
  await deliver(k);
  await reconcile(k);
  release(k);
  okReply("prepare", await k.call("prepareRecords", { key: "10.1" }));
  eq("only the ticket's Status (Feature still open, no history entry)", k.view().recordsPrep!.changes, ["context/tickets/10.1-demo.md: ## Status In Progress → Complete"]);
  const head = k.view().recordsPrep!.head!;
  eq("the records commit changes one file", git(k.repo, "diff", "--name-only", `${head}^`, head), "context/tickets/10.1-demo.md");
  okReply("inspect", await k.call("inspect", R));

  // A sibling with an unrecognised status: the Feature cannot be derived, so nothing is guessed.
  const k2 = await kitchen("unrecognised", { siblings: { "10.2-next.md": "# Next\n\n## Status\n\nDone-ish\n" } });
  await deliver(k2);
  await reconcile(k2);
  release(k2);
  refusedReply("an unrecognised sibling status", await k2.call("prepareRecords", { key: "10.1" }), "refused", /10\.2-next\.md has no recognisable status/);

  // A sibling only the ticket store knows (its file is not tracked on main yet), still open: the Feature stays as it is.
  const k5 = await kitchen("store-sibling");
  await deliver(k5);
  await reconcile(k5);
  release(k5);
  k5.world.tickets.set("10.2", { status: "Proposed", blockers: ["10.1"] });
  okReply("prepare with an open sibling only in the store", await k5.call("prepareRecords", { key: "10.1" }));
  eq("store sibling open: only the ticket's Status", k5.view().recordsPrep!.changes, ["context/tickets/10.1-demo.md: ## Status In Progress → Complete"]);
  okReply("store sibling open: the records inspect", await k5.call("inspect", R));
  // The sibling finishes after the records were prepared: they are no longer exactly the records, and are refused.
  k5.world.tickets.set("10.2", { status: "Complete", blockers: [] });
  refusedReply("the store changed after preparing: not exactly the records any more", await k5.call("inspect", R), "refused", /needs normal review.*10-demo\.md: missing/);
  const stale5 = refHead(k5.repo);
  const redo5 = okReply("prepare again: the records as they are now", await k5.call("prepareRecords", { key: "10.1" }));
  check("the stale commit was replaced, with the Feature and its history entry", redo5.message.includes(`replaces the earlier commit ${stale5}`) && k5.view().recordsPrep!.changes.length === 3 && refHead(k5.repo) === k5.view().recordsPrep!.head, redo5.message);
  okReply("the new records inspect", await k5.call("inspect", R));

  // The ticket store cannot be read: nothing is derived or written.
  const k6 = await kitchen("no-store");
  await deliver(k6);
  await reconcile(k6);
  release(k6);
  const board = k6.world.runner;
  (k6.world as { runner: Runner }).runner = async (cmd, args, opts) => (cmd === "node" && args[1] === "board" ? result("", 1, "orchestrate: cannot read the ticket store") : board(cmd, args, opts));
  refusedReply("the store cannot be read", await k6.call("prepareRecords", { key: "10.1" }), "refused", /ticket store could not be read.*nothing was prepared/);
  check("nothing written without the store", refHead(k6.repo) === "");

  // A ticket file that is not plain UTF-8 text cannot be rewritten byte for byte: refused, not rewritten.
  const k7 = await kitchen("binary");
  await deliver(k7);
  await reconcile(k7);
  release(k7);
  git(k7.repo, "checkout", "-q", "main");
  writeFileSync(join(k7.repo, "context/tickets/10.1-demo.md"), Buffer.concat([readFileSync(join(k7.repo, "context/tickets/10.1-demo.md")), Buffer.from([0x4e, 0xff, 0xfe, 0x0a])]));
  git(k7.repo, "commit", "-q", "-am", "a note in another encoding");
  k7.world.remote.set("refs/heads/main", git(k7.repo, "rev-parse", "HEAD"));
  refusedReply("a ticket file that is not plain UTF-8", await k7.call("prepareRecords", { key: "10.1" }), "refused", /cannot be rewritten byte for byte/);
  check("nothing written for it", refHead(k7.repo) === "");

  // No history file and no template: refused, not invented.
  const k3 = await kitchen("nohistory", { history: null });
  await deliver(k3);
  await reconcile(k3);
  release(k3);
  refusedReply("no history file or template", await k3.call("prepareRecords", { key: "10.1" }), "refused", /history\.template\.md has no placeholder/);

  // Local main already records the ticket Complete: nothing to deliver, the handback is allowed.
  const k4 = await kitchen("onmain");
  await deliver(k4);
  await reconcile(k4);
  release(k4);
  git(k4.repo, "checkout", "-q", "main");
  writeFileSync(join(k4.repo, "context/tickets/10.1-demo.md"), show(k4.repo, "HEAD", "context/tickets/10.1-demo.md").replace("## Status\n\nIn Progress", "## Status\n\nComplete"));
  git(k4.repo, "commit", "-q", "-am", "completed by hand");
  k4.world.remote.set("refs/heads/main", git(k4.repo, "rev-parse", "HEAD"));
  const r = okReply("prepare: already on main", await k4.call("prepareRecords", { key: "10.1" }));
  check("says there is nothing to deliver", /already records 10\.1 Complete/.test(r.message) && k4.view().recordsPrep!.onMain && k4.view().recordsPrep!.head === null);
  check("no records commit", refHead(k4.repo) === "" && noBranch(k4.repo));
  check("the records count as settled", recordsSettled(k4.view()) === null);
  refusedReply("nothing more to prepare", await k4.call("prepareRecords", { key: "10.1" }), "refused", /already records this ticket Complete/);
}

// ---------------------------------------------------------------- forge failures on the records track are classified as on any delivery

async function recordsForgeFailure() {
  const k = await kitchen("forge");
  await deliver(k);
  await reconcile(k);
  release(k);
  okReply("prepare", await k.call("prepareRecords", { key: "10.1" }));
  okReply("records inspect", await k.call("inspect", R));
  const ri = k.rview()!.inspection!;
  const t = { ...R, head: ri.head, base: ri.base, tree: ri.tree };
  okReply("records approve", await k.call("approve", t));

  // Sign-in missing: an auth failure with the in-app fix, and nothing pushed.
  k.world.authFail = true;
  okReply("records push (git, not gh)", await k.call("push", { ...R, head: ri.head }));
  const noAuth = await k.call("ensurePr", R);
  check("records PR without sign-in: auth, with the fix", !noAuth.ok && noAuth.kind === "auth" && noAuth.fix === "gh auth login --web", noAuth);
  k.world.authFail = false;
  okReply("records PR", await k.call("ensurePr", R));
  okReply("records status", await k.call("status", R));
  okReply("records acknowledge", await k.call("acknowledgeNoChecks", t));

  // The merge command is stopped by its timeout: unclear, never sign-in, and never sent again blindly.
  const mergesBefore = k.world.merges;
  let sent = 0;
  k.world.ghVia.merge = async (args) => {
    sent++;
    return { ok: false, code: null, stdout: "", stderr: `Command failed: gh ${args.join(" ")}`, processStderr: "", killed: true, signal: "SIGTERM", errno: null };
  };
  const timedOut = await k.call("merge", t);
  check("records merge timeout: failed, not auth", !timedOut.ok && timedOut.kind === "failed" && /timed out|unknown/.test(timedOut.message), timedOut);
  check("records merge timeout: outcome unknown, approval kept", k.rview()!.outcome === "unknown" && k.rview()!.approval?.head === ri.head, k.rview()!.outcome);
  refusedReply("records merge again: not retried blindly", await k.call("merge", t), "blocked", /do not merge again/i);
  eq("the merge command was sent once, and nothing merged", [sent, k.world.merges - mergesBefore], [1, 0]);
  check("the ticket's own merge is untouched by the records' unknown outcome", k.view().outcome === "merged" && k.view().verified);
  // While that merge is unsettled, the prepared commit is never replaced, even if it is no longer exactly the records.
  k.world.tickets.set("10.2", { status: "Proposed", blockers: [] });
  refusedReply("prepare again under an unsettled merge", await k.call("prepareRecords", { key: "10.1" }), "blocked", /outcome is not confirmed.*left as it is/);
  eq("the prepared commit is still the one that was sent", refHead(k.repo), ri.head);
  refusedReply("no handback or plan on the records track, whatever its outcome", await k.call("handback", R), "invalid");
}

async function main() {
  pureRules();
  await beforeVerified();
  await exactLines();
  await recordsPr();
  await featureAndOnMain();
  await recordsForgeFailure();
}

main()
  .catch((e) => failures.push(`aborted: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
  .finally(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      console.error(`FAIL ${failures.length} of ${passed + failures.length} checks:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`ok ${passed} checks passed`);
    process.exit(0);
  });
