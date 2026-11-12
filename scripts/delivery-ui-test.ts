// In-app delivery in the kitchen (ticket 10.2): the request/reply contract, the
// Origin gate, the gates the drawer and the server share, the snapshot that a
// reconnect restores, and the drawer's rendering, against 10.1's fake runner
// (scripts/delivery-fake.ts). Nothing is pushed, no PR is created or merged on
// GitHub: every network and `gh` call is simulated, and local git is real on
// throwaway repositories.
//
//   pnpm exec tsx scripts/delivery-ui-test.ts           # everything below
//   pnpm exec tsx scripts/delivery-ui-test.ts --vite    # plus the walkthrough through Vite's dev proxy

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WebSocket } from "ws";
import { deliveryStageOf, gateOf, isReadyToDeliver, type DeliveryBoard, type DeliveryClient, type DeliveryReply, type DeliveryView } from "../src/data/delivery";
import type { OfficeEvent } from "../src/data/source";
import { createDeliveryClient } from "../src/data/ws/deliveryClient";
import { DeliveryPanel } from "../src/ui/delivery/DeliveryPanel";
import { diffSummary, diffSummaryArgs, parseNumstat } from "../server/delivery/diffSummary";
import { localEvidence } from "../server/delivery/evidence";
import { defaultRunner, type Runner } from "../server/delivery/forge";
import { pushRejected } from "../server/delivery/ops";
import { attachDelivery, PREVIEW_COMMANDS_NONE, PREVIEW_GIT_ENV } from "../server/delivery/preview";
import { readinessOf } from "../server/delivery/readiness";
import { createDeliveryService, NO_ORIGIN, type DeliveryService } from "../server/delivery/service";
import { parseRequest } from "../server/delivery/wire";
import { ownHandler, startHttp } from "../server/http";
import type { Hub } from "../server/hub";
import type { Inbox } from "../server/inbox";
import type { Planner } from "../server/planner";
import { git, makeScenario, result, type World } from "./delivery-fake";

// ---------------------------------------------------------------- harness

const tmp = mkdtempSync(join(tmpdir(), "tt-delivery-ui-"));
const emptyConfig = join(tmp, "empty.gitconfig");
writeFileSync(emptyConfig, "");
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
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

const ORIGIN = "http://127.0.0.1:5173";
const filler = "A1b2C3d4E5f6G7h8J9k0".repeat(5);
const GH_TOKEN = "gh" + "p_" + filler.slice(0, 36);

/** The fake world plus the engine's `status --json`, built from its claims. */
function engineRunner(world: World): Runner {
  return async (cmd, args, opts) => {
    if (cmd === "node" && args[1] === "status") {
      world.calls.push({ cmd, args: [...args] });
      const rows = [...world.claims.entries()].map(([key, c]) => ({ key, state: c.state, title: c.title, updated: "u1" }));
      return result(JSON.stringify({ ok: true, rows: [...rows, { key: "11.1", state: "working", title: "Other", updated: "u1" }] }));
    }
    return world.runner(cmd, args, opts);
  };
}

interface MiniHub {
  snap: { delivery?: DeliveryBoard };
  emit(e: OfficeEvent): void;
  subscribe(fn: (e: OfficeEvent) => void): () => void;
}
function miniHub(): MiniHub & { events: OfficeEvent[] } {
  const listeners = new Set<(e: OfficeEvent) => void>();
  const events: OfficeEvent[] = [];
  return {
    snap: {},
    events,
    emit(e) {
      events.push(e);
      for (const fn of listeners) fn(e);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

let reqN = 0;
/** A kitchen: a scenario repository, its fake world, one delivery service, and a caller. */
async function kitchen(name: string, opts: { evidence?: boolean } = {}) {
  const s = makeScenario(tmp, name);
  const hub = miniHub();
  const kitchenKey = `kitchen-${name}`;
  const runner = engineRunner(s.world);
  if (opts.evidence !== false) {
    const dir = join(tmp, ".controlroom", kitchenKey, "transfer", "10.1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review-2-pass.md"), `# 10.1 review 2 (fresh tester) of ${s.reviewed}: PASS\n\n- Results: delivery-test 938/938; typecheck 0; build 0.\n- token seen in a log: ${GH_TOKEN}\n`);
    // A later report for another commit is not evidence for this head.
    writeFileSync(join(dir, "review-3-pass.md"), `# 10.1 review 3 of ${s.base}: PASS\n`);
  }
  const make = () => createDeliveryService({ hub, root: s.repo, repo: "owner/project", kitchenKey, runner, home: tmp, core: { confirmDelaysMs: [0] } });
  const service = make();
  await service.refresh();
  const call = async (op: string, params: Record<string, unknown>, origin = ORIGIN, svc: DeliveryService = service): Promise<DeliveryReply> => {
    const got: OfficeEvent[] = [];
    await svc.handle({ rpc: "delivery", id: `r${reqN++}`, op, params }, { origin, reply: (e) => got.push(e) });
    const e = got.find((x) => x.type === "delivery.reply");
    if (!e || e.type !== "delivery.reply") throw new Error(`${op}: no reply`);
    check(`${name} ${op}: exactly one reply`, got.length === 1, got.length);
    return e.reply;
  };
  const triple = (v: { head: string; base: string; tree: string }) => ({ key: "10.1", head: v.head, base: v.base, tree: v.tree });
  return { ...s, hub, kitchenKey, runner, service, make, call, triple, view: () => service.view("10.1") };
}

const count = (w: World, cmd: "git" | "gh" | "node", ...prefix: string[]) => w.calls.filter((c) => c.cmd === cmd && prefix.every((p, i) => c.args[i] === p)).length;

/** Moves origin's main by one unrelated commit. */
function moveMain(k: Awaited<ReturnType<typeof kitchen>>): string {
  const current = k.world.remote.get("refs/heads/main")!;
  k.write("docs/other.md", "unrelated\n");
  git(k.repo, "add", "-A");
  const tree = git(k.repo, "write-tree");
  git(k.repo, "reset", "-q", "--hard");
  const moved = git(k.repo, "commit-tree", tree, "-p", current, "-m", "someone else's change");
  k.world.remote.set("refs/heads/main", moved);
  return moved;
}

const fakeClient: DeliveryClient = { request: async () => ({ ok: false, id: "x", op: null, key: null, kind: "unavailable", message: "test", fix: null, reasons: [], view: null }) };
const render = (view: DeliveryView | undefined, extra: Record<string, unknown> = {}) =>
  renderToString(createElement(DeliveryPanel, { deliveryKey: "10.1", board: { available: true, reason: null, byKey: view ? { "10.1": view } : {} }, view, client: fakeClient, ...extra }));
/** Each `<button …>` opening tag whose attributes include `data-op="<op>"`. */
const buttons = (html: string, op: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(`data-op="${op}"`));
const stepState = (html: string, step: string) => new RegExp(`data-step="${step}" data-state="([^"]*)"`).exec(html)?.[1];

// ---------------------------------------------------------------- pure rules

function pureRules() {
  // The wire: ids, operations (own properties only), exact fields, full ids.
  const H = "a".repeat(40);
  check("wire: inspect ok", parseRequest({ rpc: "delivery", id: "r1", op: "inspect", params: { key: "10.1" } }).ok);
  for (const [label, msg] of [
    ["bad id", { rpc: "delivery", id: "has space", op: "inspect", params: { key: "10.1" } }],
    ["long id", { rpc: "delivery", id: "x".repeat(65), op: "inspect", params: { key: "10.1" } }],
    ["no id", { rpc: "delivery", op: "inspect", params: { key: "10.1" } }],
    ["unknown op", { rpc: "delivery", id: "r", op: "deleteBranch", params: { key: "10.1" } }],
    ["op constructor", { rpc: "delivery", id: "r", op: "constructor", params: { key: "10.1" } }],
    ["op __proto__", { rpc: "delivery", id: "r", op: "__proto__", params: { key: "10.1" } }],
    ["op toString", { rpc: "delivery", id: "r", op: "toString", params: { key: "10.1" } }],
    ["op hasOwnProperty", { rpc: "delivery", id: "r", op: "hasOwnProperty", params: { key: "10.1" } }],
    ["extra top-level field", { rpc: "delivery", id: "r", op: "inspect", params: { key: "10.1" }, cmd: "x" }],
    ["bad key", { rpc: "delivery", id: "r", op: "inspect", params: { key: "../10.1" } }],
    ["unknown param", { rpc: "delivery", id: "r", op: "inspect", params: { key: "10.1", force: true } }],
    ["ensurePr title from the browser", { rpc: "delivery", id: "r", op: "ensurePr", params: { key: "10.1", title: "x" } }],
    ["merge ack flag from the browser", { rpc: "delivery", id: "r", op: "merge", params: { key: "10.1", head: H, base: H, tree: H, acknowledgeNoChecks: true } }],
    ["short sha", { rpc: "delivery", id: "r", op: "push", params: { key: "10.1", head: "abcdef1" } }],
    ["upper-case sha", { rpc: "delivery", id: "r", op: "push", params: { key: "10.1", head: H.toUpperCase() } }],
    ["missing tree", { rpc: "delivery", id: "r", op: "approve", params: { key: "10.1", head: H, base: H } }],
    ["params array", { rpc: "delivery", id: "r", op: "inspect", params: ["10.1"] }],
  ] as const)
    check(`wire refuses: ${label}`, !parseRequest(msg).ok, parseRequest(msg));
  const bad = parseRequest({ rpc: "delivery", id: "keep-me", op: "nope", params: {} });
  check("wire: a refused request keeps its id for the reply", !bad.ok && bad.id === "keep-me");

  // L2: own-property lookup on both maps.
  const fn = () => "ran";
  const map = { inspect: fn } as Record<string, () => string>;
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", 7, null, undefined])
    check(`ownHandler ignores ${String(name)}`, ownHandler(map, name) === undefined);
  check("ownHandler finds an own handler", ownHandler(map, "inspect") === fn);
  check("ownHandler with no map", ownHandler(undefined, "inspect") === undefined);
  check("preview commands: null prototype", Object.getPrototypeOf(PREVIEW_COMMANDS_NONE) === null && Object.keys(PREVIEW_COMMANDS_NONE).length === 0);
  for (const name of ["constructor", "__proto__", "toString"]) check(`preview commands ignore ${name}`, ownHandler(PREVIEW_COMMANDS_NONE, name) === undefined);
  // L3: the preview's identity git calls get no optional locks and no prompt.
  eq("preview git env", PREVIEW_GIT_ENV, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });

  // Readiness.
  const R = "61cd56e8ed4f3890bca9ff72f717d20e66bf5e4d";
  const claim = { branch: "ticket/10.1-demo", worktree: ".pathfinder/worktrees/10.1", orphan: false, state: "done", last: `review PASS on ${R}` };
  const ready = readinessOf("10.1", "done", claim);
  check("ready: done + PASS + ticket branch + live worktree", ready.ready && ready.reviewedHead === R && ready.reason === null, ready);
  check("not ready: engine working", !readinessOf("10.1", "working", claim).ready);
  check("not ready: short sha", !readinessOf("10.1", "done", { ...claim, last: "review PASS on 61cd56e8" }).ready);
  check("not ready: FINDINGS", !readinessOf("10.1", "done", { ...claim, last: `review FINDINGS on ${R}` }).ready);
  check("not ready: other branch", !readinessOf("10.1", "done", { ...claim, branch: "feature/x" }).ready);
  check("not ready: orphan claim", !readinessOf("10.1", "done", { ...claim, orphan: true }).ready);
  check("not ready: no claim", !readinessOf("10.1", "done", null).ready);
  check("not ready says why", /review PASS/.test(readinessOf("10.1", "done", { ...claim, last: "Phase A done" }).reason ?? ""));

  // 10.1 review-5 LOW: push rejection is read from the program's own output only.
  const B = "ticket/10.1-x-non-fast-forward";
  check(
    "push timeout echoing a 'non-fast-forward' slug is not a rejection",
    !pushRejected({ ok: false, code: null, stdout: "", stderr: `Command failed: git push --no-follow-tags --porcelain origin ${H}:refs/heads/${B}`, processStderr: "", killed: true }, H, B),
  );
  check("own stderr naming the slug only is not a rejection", !pushRejected({ ok: false, code: 1, stdout: "", stderr: "", processStderr: `error: failed to push some refs to '${B}'` }, H, B));
  check("porcelain [rejected] status line is a rejection", pushRejected({ ok: false, code: 1, stdout: `To https://github.com/o/p.git\n!\t${H}:refs/heads/${B}\t[rejected] (non-fast-forward)\nDone\n`, stderr: "", processStderr: "error: failed to push some refs" }, H, B));
  check("porcelain line for another ref is not ours", !pushRejected({ ok: false, code: 1, stdout: `!\t${H}:refs/heads/ticket/9.9-a\t[rejected] (fetch first)\n`, stderr: "", processStderr: "" }, H, B));
  check("git's own stderr rejection", pushRejected({ ok: false, code: 1, stdout: "", stderr: "", processStderr: ` ! [rejected]  ${H} -> ${B} (fetch first)` }, H, B));
  check("a fake runner without processStderr still reads plain stderr", pushRejected({ ok: false, code: 1, stdout: "", stderr: " ! [rejected] x -> y (non-fast-forward)" }, H, "ticket/10.1-y"));

  // diffSummary's fixed argument vector and parser.
  eq("diffSummary args", diffSummaryArgs(H, "b".repeat(40)), ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", H, "b".repeat(40)]);
  let threw = false;
  try {
    diffSummaryArgs("HEAD", H);
  } catch {
    threw = true;
  }
  check("diffSummary refuses a ref name", threw);
  eq("numstat parse", parseNumstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0"), [
    { path: "src/a.ts", added: 3, deleted: 1 },
    { path: "img.png", added: null, deleted: null },
  ]);
}

// ---------------------------------------------------------------- the walkthrough (no checks: acknowledgement required)

async function walkthroughNoChecks() {
  const k = await kitchen("nochecks");
  let v = k.view();
  check("ready to deliver listed", k.hub.snap.delivery?.available === true && !!k.hub.snap.delivery.byKey["10.1"]);
  check("ready to deliver", isReadyToDeliver(v) && v.readiness.reviewedHead === k.reviewed, v.readiness);
  check("a working ticket is not listed", !k.hub.snap.delivery?.byKey["11.1"]);
  eq("06.1 input: nothing yet", deliveryStageOf(v), null);

  // Nothing but inspect is possible before an inspection and an approval.
  const pushes = () => count(k.world, "git", "push");
  refusedReply("push before approval", await k.call("push", { key: "10.1", head: k.head }), "refused", /Approve this exact merge first/);
  refusedReply("PR before approval", await k.call("ensurePr", { key: "10.1" }), "refused");
  refusedReply("approve before inspect", await k.call("approve", { key: "10.1", head: k.head, base: k.base, tree: k.head }), "refused", /Inspect first/);
  eq("nothing pushed", pushes(), 0);

  const insp = okReply("inspect", await k.call("inspect", { key: "10.1" }));
  v = k.view();
  const i = v.inspection!;
  check("inspection kept", !!i && i.head === k.head && i.reviewedHead === k.reviewed && i.recordOnly.length === 1);
  eq("inspection files", i.files.map((f) => f.path).sort(), ["context/tickets/10.1-demo.md", "src/feature.ts"]);
  eq("inspection stat", i.stat, { files: 2, added: 3, deleted: 0 });
  check("reply carries the inspection", (insp.data as { head?: string }).head === k.head);
  eq("evidence: the claim's review line", i.evidence.line, `review PASS on ${k.reviewed}`);
  check("evidence: the report for exactly this head", i.evidence.report?.file === "transfer/10.1/review-2-pass.md", i.evidence.report?.file);
  check("evidence: redacted", !!i.evidence.report && !i.evidence.report.text.includes(GH_TOKEN) && i.evidence.report.text.includes("[REDACTED]"));

  refusedReply("approve another tree", await k.call("approve", { key: "10.1", head: i.head, base: i.base, tree: i.mergeBase }), "stale", /not for what was last inspected/);
  check("a refused approval records nothing", !k.view().approval);
  okReply("approve the exact merge", await k.call("approve", k.triple(i)));
  v = k.view();
  check("approval valid", v.approvalState === "valid" && v.approval?.head === i.head && v.approval.acknowledgeNoChecks === false, v.approvalState);

  refusedReply("push another head", await k.call("push", { key: "10.1", head: k.reviewed }), "stale", /only the approved head/);
  eq("still nothing pushed", pushes(), 0);
  const pushed = okReply("push", await k.call("push", { key: "10.1", head: i.head }));
  check("pushed the approved head", k.world.remote.get("refs/heads/ticket/10.1-demo") === i.head && (pushed.data as { already: boolean }).already === false);
  okReply("push again is accepted as already pushed", await k.call("push", { key: "10.1", head: i.head }));
  eq("one push", pushes(), 1);
  const pr = okReply("ensure PR", await k.call("ensurePr", { key: "10.1" }));
  check("PR created", (pr.data as { created: boolean }).created === true && k.world.prs.length === 1);
  okReply("ensure PR again reuses it", await k.call("ensurePr", { key: "10.1" }));
  eq("still one PR", k.world.prs.length, 1);
  eq("06.1 input: PR open", deliveryStageOf(k.view()), "pr-open");

  const merges = () => count(k.world, "gh", "pr", "merge");
  refusedReply("merge before status", await k.call("merge", k.triple(i)), "blocked", /Refresh the PR status/);
  okReply("status", await k.call("status", { key: "10.1" }));
  v = k.view();
  eq("no checks reported", v.status?.checks.summary, "none");
  check("no checks is never passing in the drawer", /No checks reported — this is not a pass/.test(render(v)) && !/All reported checks passed/.test(render(v)));
  refusedReply("merge with no checks and no acknowledgement", await k.call("merge", k.triple(i)), "blocked", /acknowledge/);
  eq("no merge command sent", merges(), 0);
  const html = render(v);
  check("drawer: merge disabled until acknowledged", buttons(html, "merge").length > 0 && buttons(html, "merge").every((b) => b.includes("disabled")));
  check("drawer: acknowledgement control shown with the evidence", /I acknowledge that no checks ran/.test(html) && /review-2-pass\.md/.test(html));

  refusedReply("acknowledge other params", await k.call("acknowledgeNoChecks", { key: "10.1", head: i.head, base: i.base, tree: i.mergeBase }), "stale");
  okReply("acknowledge no checks", await k.call("acknowledgeNoChecks", k.triple(i)));
  v = k.view();
  check("acknowledgement recorded on the approval", v.approval?.acknowledgeNoChecks === true && v.approvalState === "valid");
  check("drawer: merge enabled once acknowledged", buttons(render(v), "merge").every((b) => !b.includes("disabled")));

  refusedReply("merge with params other than the approval", await k.call("merge", { key: "10.1", head: i.head, base: i.base, tree: i.mergeBase }), "stale", /not the head, base and tree on record/);
  eq("still no merge command", merges(), 0);
  const merged = okReply("merge", await k.call("merge", k.triple(i)));
  check("merged once", k.world.merges === 1 && (merged.data as { already: boolean }).already === false);
  v = k.view();
  check("outcome merged and verified", v.outcome === "merged" && v.verified && v.merged?.approval?.acknowledgeNoChecks === true, { outcome: v.outcome, verified: v.verified });
  eq("06.1 input: merged", deliveryStageOf(v), "merged");
  check("drawer: Merged · verified", /Merged · verified/.test(render(v)));
  refusedReply("merge again", await k.call("merge", k.triple(i)), "refused", /already merged/);
  eq("never merged twice", k.world.merges, 1);
  okReply("verify", await k.call("verify", { key: "10.1" }));
  check("ready list drops a merged ticket", !isReadyToDeliver(k.view()));

  // Every broadcast is a delivery.updated for this ticket; the snapshot matches the last one.
  const updates = k.hub.events.filter((e) => e.type === "delivery.updated");
  check("broadcasts after operations", updates.length >= 8, updates.length);
  check("snapshot holds the current view", JSON.stringify(k.hub.snap.delivery?.byKey["10.1"]) === JSON.stringify(k.view()));
  check("no token in any broadcast", !JSON.stringify(k.hub.events).includes(GH_TOKEN));
  eq("pushed refs: only the ticket branch and main", [...k.world.remote.keys()].sort(), ["refs/heads/main", "refs/heads/ticket/10.1-demo"]);
}

// ---------------------------------------------------------------- the Origin gate

async function originGate() {
  const k = await kitchen("origin");
  okReply("inspect (with Origin)", await k.call("inspect", { key: "10.1" }));
  const i = k.view().inspection!;
  // Let the refresh that follows every operation finish first (it reads the engine and git refs), so only these requests are counted.
  await k.service.refresh();
  const before = k.world.calls.length;
  const stateBefore = JSON.stringify(k.view());
  const params: Record<string, Record<string, unknown>> = {
    inspect: { key: "10.1" },
    approve: k.triple(i),
    acknowledgeNoChecks: k.triple(i),
    push: { key: "10.1", head: i.head },
    ensurePr: { key: "10.1" },
    status: { key: "10.1" },
    merge: k.triple(i),
    verify: { key: "10.1" },
  };
  for (const [op, p] of Object.entries(params)) {
    const r = await k.call(op, p, "");
    refusedReply(`no Origin: ${op}`, r, "origin");
    check(`no Origin: ${op} says why`, !r.ok && r.message === NO_ORIGIN);
  }
  // Malformed requests without an Origin are refused as origin too, before anything is parsed.
  refusedReply("no Origin: garbage", await k.call("constructor", {}, ""), "origin");
  eq("no Origin: the runner was never called", k.world.calls.length, before);
  eq("no Origin: the state is unchanged", JSON.stringify(k.view()), stateBefore);
}

// ---------------------------------------------------------------- stale approvals

async function staleApprovals() {
  // 1. The base moves and the status shows it: the stale approval is refused by the gate.
  const k = await kitchen("stale");
  k.world.defaultChecks = [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "https://example.invalid/ci" }];
  okReply("stale: inspect", await k.call("inspect", { key: "10.1" }));
  const i = k.view().inspection!;
  okReply("stale: approve", await k.call("approve", k.triple(i)));
  okReply("stale: push", await k.call("push", { key: "10.1", head: i.head }));
  okReply("stale: PR", await k.call("ensurePr", { key: "10.1" }));
  okReply("stale: status", await k.call("status", { key: "10.1" }));
  check("checks passed", k.view().status?.checks.summary === "passed");
  refusedReply("acknowledgement refused when checks exist", await k.call("acknowledgeNoChecks", k.triple(i)), "refused", /reports checks/);
  check("drawer: passed checks need no acknowledgement", !/I acknowledge that no checks ran/.test(render(k.view())));
  const moved = moveMain(k);
  okReply("stale: status after main moved", await k.call("status", { key: "10.1" }));
  let v = k.view();
  check("approval shown as stale", v.approvalState === "stale" && v.staleReasons.some((r) => r.includes(moved)), v.staleReasons);
  refusedReply("stale approval: merge refused", await k.call("merge", k.triple(i)), "stale", new RegExp(moved));
  refusedReply("stale approval: push refused", await k.call("push", { key: "10.1", head: i.head }), "stale");
  eq("stale approval: no merge command sent", count(k.world, "gh", "pr", "merge"), 0);
  const html = render(v);
  check("drawer: stale block with the reason", /The approval is stale/.test(html) && html.includes(moved) && /Inspect and approve again/.test(html));
  check("drawer: push, PR and merge disabled", ["push", "ensurePr", "merge"].every((op) => buttons(html, op).every((b) => b.includes("disabled"))));

  // 2. Inspecting again invalidates the stored approval itself; it stays unusable.
  okReply("stale: inspect again", await k.call("inspect", { key: "10.1" }));
  v = k.view();
  check("stored approval cleared, reasons kept", v.approval === null && v.approvalState === "stale" && !!v.invalidated && v.staleReasons.some((r) => r.includes(moved)), v.invalidated);
  refusedReply("invalidated approval: merge", await k.call("merge", k.triple(i)), "stale");
  refusedReply("invalidated approval: acknowledge", await k.call("acknowledgeNoChecks", k.triple(i)), "stale");
  okReply("approve again on the new base", await k.call("approve", k.triple(v.inspection!)));
  check("approval valid again", k.view().approvalState === "valid" && k.view().approval?.base === moved);

  // 3. The base moves with no new status: the gate passes, and the core refuses it live.
  const k2 = await kitchen("stale-live");
  k2.world.defaultChecks = [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }];
  okReply("live: inspect", await k2.call("inspect", { key: "10.1" }));
  const i2 = k2.view().inspection!;
  okReply("live: approve", await k2.call("approve", k2.triple(i2)));
  okReply("live: push", await k2.call("push", { key: "10.1", head: i2.head }));
  okReply("live: PR", await k2.call("ensurePr", { key: "10.1" }));
  okReply("live: status", await k2.call("status", { key: "10.1" }));
  const moved2 = moveMain(k2);
  check("live: the kitchen does not know yet", gateOf(k2.view(), "merge") === null);
  refusedReply("live: merge refused as stale by the core", await k2.call("merge", k2.triple(i2)), "stale", new RegExp(moved2));
  eq("live: no merge command sent", count(k2.world, "gh", "pr", "merge"), 0);
  check("live: approval now shown as stale", k2.view().approvalState === "stale");
}

// ---------------------------------------------------------------- partial success, pending, auth, busy

async function partialAndPending() {
  const k = await kitchen("partial");
  k.world.createFail = result("", 1, `pull request create failed: remote said token ${GH_TOKEN} was rejected`);
  okReply("partial: inspect", await k.call("inspect", { key: "10.1" }));
  const i = k.view().inspection!;
  okReply("partial: approve", await k.call("approve", k.triple(i)));
  okReply("partial: push", await k.call("push", { key: "10.1", head: i.head }));
  const failed = await k.call("ensurePr", { key: "10.1" });
  refusedReply("partial: PR fails", failed, "failed");
  check("partial: no token in the reply", !JSON.stringify(failed).includes(GH_TOKEN));
  const v = k.view();
  eq("partial: steps per result", v.steps.map((s) => [s.step, s.ok]), [["inspect", true], ["approve", true], ["push", true], ["ensurePr", false]]);
  const html = render(v, { initialReply: failed });
  eq("drawer: inspect ok", stepState(html, "inspect"), "ok");
  eq("drawer: approve ok", stepState(html, "approve"), "ok");
  eq("drawer: push ok", stepState(html, "push"), "ok");
  eq("drawer: PR failed", stepState(html, "ensurePr"), "failed (failed)");
  eq("drawer: merge not run", stepState(html, "merge"), "not run");
  check("drawer: the failure is shown", /did not complete/.test(html) && !html.includes(GH_TOKEN));

  // Auth: the actionable in-app fix.
  k.world.createFail = null;
  k.world.authFail = true;
  const auth = await k.call("ensurePr", { key: "10.1" });
  refusedReply("auth failure", auth, "auth");
  check("auth failure carries the fix", !auth.ok && auth.fix === "gh auth login --web");
  const authHtml = render(k.view(), { initialReply: auth, onSignIn: () => {} });
  check("drawer: Sign in to GitHub", /Sign in to GitHub/.test(authHtml) && /gh auth login --web/.test(authHtml));
  k.world.authFail = false;

  // Pending: the merge command succeeds but GitHub does not report it merged yet.
  okReply("pending: PR", await k.call("ensurePr", { key: "10.1" }));
  k.world.defaultChecks = "none";
  okReply("pending: status", await k.call("status", { key: "10.1" }));
  okReply("pending: acknowledge", await k.call("acknowledgeNoChecks", k.triple(i)));
  k.world.viewLag = ["open", "open"];
  refusedReply("pending: merge not confirmed", await k.call("merge", k.triple(i)), "blocked", /confirmation pending/);
  let pv = k.view();
  eq("pending outcome", pv.outcome, "pending");
  eq("06.1 input: pending is never merged", deliveryStageOf(pv), "pr-open");
  check("pending: merge gated", gateOf(pv, "merge")?.kind === "blocked" && /do not merge again/.test(gateOf(pv, "merge")!.message));
  const pHtml = render(pv);
  check("drawer: Outcome not confirmed — do not merge again", /Outcome not confirmed — do not merge again/.test(pHtml) && /Check outcome/.test(pHtml));
  check("drawer: merge disabled while pending", buttons(pHtml, "merge").every((b) => b.includes("disabled")));
  eq("drawer: merge step failed (blocked)", stepState(pHtml, "merge"), "failed (blocked)");
  refusedReply("pending: merge refused", await k.call("merge", k.triple(i)), "blocked", /do not merge again/i);
  eq("pending: one merge command only", count(k.world, "gh", "pr", "merge"), 1);
  okReply("pending: check outcome", await k.call("verify", { key: "10.1" }));
  pv = k.view();
  check("pending settled as merged and verified", pv.outcome === "merged" && pv.verified);

  // Busy: one operation per ticket at a time.
  const b = await kitchen("busy");
  const [first, second] = await Promise.all([b.call("inspect", { key: "10.1" }), b.call("status", { key: "10.1" })]);
  check("busy: first runs", first.ok);
  refusedReply("busy: second refused", second, "busy");
  check("busy: cleared afterwards", b.view().running === null);
}

// ---------------------------------------------------------------- reconnect and restart

function wsOpen(url: string, origin?: string): Promise<{ ws: WebSocket; events: OfficeEvent[]; next: (pred: (e: OfficeEvent) => boolean) => Promise<OfficeEvent> }> {
  return new Promise((resolve, reject) => {
    const ws = origin ? new WebSocket(url, { origin }) : new WebSocket(url);
    const events: OfficeEvent[] = [];
    const waiters: { pred: (e: OfficeEvent) => boolean; resolve: (e: OfficeEvent) => void }[] = [];
    ws.on("message", (raw) => {
      const e = JSON.parse(String(raw)) as OfficeEvent;
      events.push(e);
      for (const w of [...waiters])
        if (w.pred(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
    });
    const next = (pred: (e: OfficeEvent) => boolean) =>
      new Promise<OfficeEvent>((res, rej) => {
        const found = events.find(pred);
        if (found) return res(found);
        const t = setTimeout(() => rej(new Error("timed out waiting for an event")), 30_000);
        waiters.push({ pred, resolve: (e) => (clearTimeout(t), res(e)) });
      });
    ws.once("open", () => resolve({ ws, events, next }));
    ws.once("error", reject);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function serve(k: Awaited<ReturnType<typeof kitchen>>, service: DeliveryService, extraOrigins: string[] = []) {
  const port = await freePort();
  const token = "t".repeat(32);
  const commandsRan: string[] = [];
  const commands = { ping: () => void commandsRan.push("ping") } as Record<string, (...a: unknown[]) => unknown>;
  const server = await startHttp({
    hub: k.hub as unknown as Hub,
    inbox: {} as Inbox,
    planner: {} as Planner,
    port,
    browserToken: token,
    agentToken: "a".repeat(32),
    distDir: null,
    allowedOrigins: [ORIGIN, ...extraOrigins],
    commands,
    rpc: { delivery: service.handle },
  });
  return { port, token, server, commandsRan, url: `ws://127.0.0.1:${port}/ws?token=${token}` };
}

async function reconnectAndRestart() {
  const k = await kitchen("reconnect");
  const s = await serve(k, k.service);
  try {
    const c1 = await wsOpen(s.url, ORIGIN);
    const snap1 = (await c1.next((e) => e.type === "snapshot")) as Extract<OfficeEvent, { type: "snapshot" }>;
    check("first snapshot lists the ready ticket", !!snap1.snapshot.delivery?.byKey["10.1"]?.readiness.ready);
    const ask = async (c: Awaited<ReturnType<typeof wsOpen>>, op: string, params: Record<string, unknown>) => {
      const id = `w${reqN++}`;
      c.ws.send(JSON.stringify({ rpc: "delivery", id, op, params }));
      return ((await c.next((e) => e.type === "delivery.reply" && e.id === id)) as Extract<OfficeEvent, { type: "delivery.reply" }>).reply;
    };
    // L2 over the socket: prototype names are no command and no request, and the connection keeps working.
    c1.ws.send(JSON.stringify({ cmd: "constructor" }));
    c1.ws.send(JSON.stringify({ cmd: "__proto__" }));
    c1.ws.send(JSON.stringify({ cmd: "toString", args: [] }));
    c1.ws.send(JSON.stringify({ rpc: "constructor", id: "p1" }));
    c1.ws.send(JSON.stringify({ rpc: "__proto__", id: "p2" }));
    c1.ws.send(JSON.stringify({ cmd: "ping" }));
    okReply("ws: inspect", await ask(c1, "inspect", { key: "10.1" }));
    eq("ws: only the own command ran", s.commandsRan, ["ping"]);
    check("ws: no reply to a prototype-named rpc", !c1.events.some((e) => e.type === "delivery.reply" && (e.id === "p1" || e.id === "p2")));
    const i = k.view().inspection!;
    okReply("ws: approve", await ask(c1, "approve", k.triple(i)));
    okReply("ws: push", await ask(c1, "push", { key: "10.1", head: i.head }));
    k.world.createFail = result("", 1, "pull request create failed: GraphQL: something is wrong");
    refusedReply("ws: PR fails (partial state)", await ask(c1, "ensurePr", { key: "10.1" }), "failed");
    const updated = await c1.next((e) => e.type === "delivery.updated" && e.view.steps.some((x) => x.step === "ensurePr"));
    check("ws: delivery.updated broadcast", updated.type === "delivery.updated");

    // A client without an Origin (an agent's socket) is refused, and runs nothing.
    const callsBefore = k.world.calls.length;
    const agent = await wsOpen(s.url);
    const agentReply = await (async () => {
      agent.ws.send(JSON.stringify({ rpc: "delivery", id: "agent1", op: "push", params: { key: "10.1", head: i.head } }));
      return ((await agent.next((e) => e.type === "delivery.reply" && e.id === "agent1")) as Extract<OfficeEvent, { type: "delivery.reply" }>).reply;
    })();
    refusedReply("ws: client without an Origin refused", agentReply, "origin");
    eq("ws: nothing ran for it", k.world.calls.length, callsBefore);
    check("ws: the reply went to that socket only", !c1.events.some((e) => e.type === "delivery.reply" && e.id === "agent1"));
    agent.ws.close();

    // Reconnect: the new socket's snapshot restores exactly the current delivery state.
    c1.ws.close();
    const c2 = await wsOpen(s.url, ORIGIN);
    const snap2 = (await c2.next((e) => e.type === "snapshot")) as Extract<OfficeEvent, { type: "snapshot" }>;
    const restored = snap2.snapshot.delivery?.byKey["10.1"];
    check("reconnect: snapshot equals the live view", JSON.stringify(restored) === JSON.stringify(k.view()), { restored: restored?.steps, live: k.view().steps });
    eq("reconnect: partial steps restored", restored?.steps.map((x) => [x.step, x.ok]), [["inspect", true], ["approve", true], ["push", true], ["ensurePr", false]]);
    check("reconnect: approval restored", restored?.approvalState === "valid" && restored.approval?.head === i.head);
    eq("reconnect: drawer renders the same steps", stepState(render(restored), "ensurePr"), "failed (failed)");
    c2.ws.close();
  } finally {
    s.server.close();
  }

  // Kitchen restart: a new service on the same deliveries folder restores the stored state.
  k.world.createFail = null;
  const before = k.view();
  const restarted = k.make();
  await restarted.refresh();
  const after = restarted.view("10.1");
  eq("restart: steps restored", after.steps, before.steps);
  eq("restart: approval restored", after.approval, before.approval);
  check("restart: the diff is not kept (inspect again)", after.inspection === null && /Inspect again to see the diff/.test(render(after)));
  // Pending and merged survive a restart too.
  okReply("restart: PR", await k.call("ensurePr", { key: "10.1" }, ORIGIN, restarted));
  okReply("restart: status", await k.call("status", { key: "10.1" }, ORIGIN, restarted));
  okReply("restart: inspect", await k.call("inspect", { key: "10.1" }, ORIGIN, restarted));
  okReply("restart: acknowledge", await k.call("acknowledgeNoChecks", k.triple(restarted.view("10.1").approval!), ORIGIN, restarted));
  k.world.viewLag = ["open", "open"];
  refusedReply("restart: merge pending", await k.call("merge", k.triple(restarted.view("10.1").approval!), ORIGIN, restarted), "blocked");
  const again = k.make();
  await again.refresh();
  eq("restart: pending restored", again.view("10.1").outcome, "pending");
  okReply("restart: check outcome", await k.call("verify", { key: "10.1" }, ORIGIN, again));
  const third = k.make();
  await third.refresh();
  check("restart: merged restored", third.view("10.1").outcome === "merged" && third.view("10.1").verified);
}

// ---------------------------------------------------------------- client, evidence, env, preview seam

async function clientAndSeams() {
  // The browser client: never queued, and a lost connection resolves every request.
  const sent: string[] = [];
  let open = true;
  const c = createDeliveryClient({ send: (f) => (open ? (sent.push(f), true) : false) });
  const p1 = c.request("inspect", { key: "10.1" });
  const frame = JSON.parse(sent[0]) as { rpc: string; id: string; op: string; params: unknown };
  check("client frame", frame.rpc === "delivery" && /^[A-Za-z0-9_-]{1,64}$/.test(frame.id) && frame.op === "inspect", frame);
  c.onReply("other", { ok: false, id: "other", op: null, key: null, kind: "failed", message: "", fix: null, reasons: [], view: null });
  c.connectionLost();
  const r1 = await p1;
  check("client: connection lost resolves as unavailable", !r1.ok && r1.kind === "unavailable" && /Connection lost — see the steps/.test(r1.message));
  open = false;
  const r2 = await c.request("merge", { key: "10.1" });
  check("client: not connected sends nothing", !r2.ok && r2.kind === "unavailable" && sent.length === 1);
  open = true;
  const p3 = c.request("status", { key: "10.1" });
  const id3 = (JSON.parse(sent[1]) as { id: string }).id;
  c.onReply(id3, { ok: true, id: id3, op: "status", key: "10.1", message: "fine", data: null, view: null });
  check("client: reply matched by id", (await p3).ok);

  // Mock source: the drawer says delivery needs the real kitchen.
  check("drawer without a client", /Delivery needs the real kitchen/.test(renderToString(createElement(DeliveryPanel, { deliveryKey: "10.1", board: undefined, view: undefined, client: null }))));

  // Evidence: only a report naming exactly this head.
  const home = join(tmp, "evhome");
  const dir = join(home, ".controlroom", "kit", "transfer", "10.9");
  mkdirSync(dir, { recursive: true });
  const R = "1".repeat(40);
  writeFileSync(join(dir, "review-1-pass.md"), `# review of ${R}: PASS\n`);
  writeFileSync(join(dir, "review-2-pass.md"), `# review of ${R.slice(0, 12)}: PASS\n`);
  writeFileSync(join(dir, "review-3-findings.md"), `# review of ${R}: FINDINGS\n`);
  eq("evidence: exact report", localEvidence({ kitchen: "kit", key: "10.9", reviewedHead: R, line: "l", home }).report?.file, "transfer/10.9/review-1-pass.md");
  eq("evidence: none for another head", localEvidence({ kitchen: "kit", key: "10.9", reviewedHead: "2".repeat(40), line: "l", home }).report, null);
  eq("evidence: bad kitchen name", localEvidence({ kitchen: "../x", key: "10.9", reviewedHead: R, line: null, home }), { line: null, report: null });

  // diffSummary's git calls get GIT_TERMINAL_PROMPT=0 (the delivery runner's environment), checked on the real execFile path.
  const k = makeScenario(tmp, "envcheck");
  const shim = join(tmp, "shim");
  mkdirSync(shim, { recursive: true });
  const logFile = join(tmp, "shim.log");
  writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf 'GIT_TERMINAL_PROMPT=%s args=%s\\n' "$GIT_TERMINAL_PROMPT" "$1" >> "${logFile}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const path = process.env.PATH;
  const prompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.PATH = `${shim}:${path}`;
  delete process.env.GIT_TERMINAL_PROMPT; // the runner itself must set it
  try {
    const d = await diffSummary(defaultRunner, k.repo, k.base, k.head);
    eq("diffSummary on real git", d.stat, { files: 2, added: 3, deleted: 0 });
  } finally {
    process.env.PATH = path;
    process.env.GIT_TERMINAL_PROMPT = prompt;
  }
  const logged = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
  check("diffSummary git calls ran with GIT_TERMINAL_PROMPT=0", logged.length > 0 && logged.every((l) => l.startsWith("GIT_TERMINAL_PROMPT=0 args=diff")), logged);

  // The preview seam without a GitHub origin: unavailable, and it says so.
  const hub = miniHub();
  const att = attachDelivery({ hub, root: tmp, github: null, kitchenKey: "kit" });
  check("seam: unavailable board", hub.snap.delivery?.available === false && att.service === null);
  const replies: OfficeEvent[] = [];
  await att.rpc.delivery({ rpc: "delivery", id: "u1", op: "inspect", params: { key: "10.1" } }, { origin: ORIGIN, reply: (e) => replies.push(e) });
  check("seam: unavailable reply", replies[0]?.type === "delivery.reply" && !replies[0].reply.ok && replies[0].reply.kind === "unavailable");
  check("seam: rpc map has a null prototype", Object.getPrototypeOf(att.rpc) === null);
}

// ---------------------------------------------------------------- headless walkthrough through Vite's dev proxy (--vite)

async function viteWalkthrough() {
  const k = await kitchen("vite");
  const vitePort = await freePort();
  const viteOrigin = `http://localhost:${vitePort}`;
  const s = await serve(k, k.service, [viteOrigin]);
  const vite = spawn(join(process.cwd(), "node_modules", ".bin", "vite"), ["--port", String(vitePort), "--strictPort", "--host", "localhost"], {
    env: { ...process.env, HQ_PORT: String(s.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  vite.stdout.on("data", (d) => (out += String(d)));
  vite.stderr.on("data", (d) => (out += String(d)));
  try {
    const t0 = Date.now();
    while (!/ready in|Local:/.test(out) && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200));
    check("vite started", /ready in|Local:/.test(out), out.slice(-400));
    for (const mod of ["/src/ui/drawers/DeliveryDrawer.tsx", "/src/ui/delivery/DeliveryPanel.tsx", "/src/data/ws/deliveryClient.ts", "/src/data/delivery.ts"]) {
      const res = await fetch(`${viteOrigin}${mod}`);
      check(`vite serves ${mod}`, res.status === 200, res.status);
    }
    const c = await wsOpen(`ws://localhost:${vitePort}/ws?token=${s.token}`, viteOrigin);
    await c.next((e) => e.type === "snapshot");
    const ask = async (op: string, params: Record<string, unknown>) => {
      const id = `v${reqN++}`;
      c.ws.send(JSON.stringify({ rpc: "delivery", id, op, params }));
      return ((await c.next((e) => e.type === "delivery.reply" && e.id === id)) as Extract<OfficeEvent, { type: "delivery.reply" }>).reply;
    };
    okReply("vite: inspect", await ask("inspect", { key: "10.1" }));
    const i = k.view().inspection!;
    okReply("vite: approve", await ask("approve", k.triple(i)));
    okReply("vite: push", await ask("push", { key: "10.1", head: i.head }));
    okReply("vite: PR", await ask("ensurePr", { key: "10.1" }));
    okReply("vite: status", await ask("status", { key: "10.1" }));
    okReply("vite: acknowledge", await ask("acknowledgeNoChecks", k.triple(i)));
    okReply("vite: merge", await ask("merge", k.triple(i)));
    okReply("vite: verify", await ask("verify", { key: "10.1" }));
    check("vite: merged once and verified", k.world.merges === 1 && k.view().verified);
    c.ws.close();
  } finally {
    vite.kill("SIGTERM");
    s.server.close();
  }
}

// ---------------------------------------------------------------- run

async function main() {
  pureRules();
  await walkthroughNoChecks();
  await originGate();
  await staleApprovals();
  await partialAndPending();
  await reconnectAndRestart();
  await clientAndSeams();
  if (process.argv.includes("--vite")) await viteWalkthrough();
}

main()
  .catch((e) => failures.push(`aborted: ${e instanceof Error ? e.stack ?? e.message : String(e)}`))
  .finally(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      console.error(`FAIL ${failures.length} of ${passed + failures.length} checks:`);
      for (const f of failures) console.error("  - " + f);
      process.exit(1);
    }
    console.log(`ok ${passed} checks passed${process.argv.includes("--vite") ? " (including the walkthrough through Vite's dev proxy)" : ""}`);
    process.exit(0);
  });
