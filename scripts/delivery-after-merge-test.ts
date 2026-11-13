// After a verified merge (ticket 10.3): reconciling the main checkout, the one
// marked handback to the coordinator, the refreshed plan, and the readiness
// cache fix carried from 10.2's review. Against 10.1's fake world
// (scripts/delivery-fake.ts) for everything GitHub, with real local git on
// throwaway repositories and a temporary HOME. Nothing is pushed; the real
// main checkout, the live kitchen and its coordinator are never touched.
//
//   pnpm exec tsx scripts/delivery-after-merge-test.ts

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { gateOf, handbackMarkerOf, type DeliveryBoard, type DeliveryClient, type DeliveryReply, type DeliveryView } from "../src/data/delivery";
import type { OfficeEvent } from "../src/data/source";
import { DeliveryPanel } from "../src/ui/delivery/DeliveryPanel";
import { run } from "../server/lib/exec";
import type { Runner } from "../server/delivery/forge";
import { handbackMarker, handbackText, readPlan, sendHandback } from "../server/delivery/handback";
import { attachDelivery } from "../server/delivery/preview";
import { Readiness, readinessOf, waitingBlockers } from "../server/delivery/readiness";
import { parseNameStatus, parseStatus, Reconciler, safeRelative } from "../server/delivery/reconcile";
import { createDeliveryService, type DeliveryService } from "../server/delivery/service";
import { backupsDir, DeliveryStore } from "../server/delivery/state";
import { parseRequest } from "../server/delivery/wire";
import { addRecordsFixture, git, makeScenario, result, type World } from "./delivery-fake";

// ---------------------------------------------------------------- harness

const tmp = mkdtempSync(join(tmpdir(), "tt-after-merge-"));
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
const ENGINE = resolve(dirname(new URL(import.meta.url).pathname), "..", "skills", "orchestrate", "engine", "bin", "orchestrate.mjs");

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
  check(`${label} (kind ${kind})`, r.kind === kind, { kind: r.kind, message: r.message });
  if (text) check(`${label} (says why)`, text.test(r.message + " " + r.reasons.join(" ")), { message: r.message });
}

const ORIGIN = "http://127.0.0.1:5173";

/** Local git commands the fake world does not answer: reconcile's, run for real on the throwaway repository. */
const LOCAL = new Set(["--no-optional-locks", "ls-tree", "ls-files", "symbolic-ref", "merge", "checkout", "rm", "checkout-index", "hash-object", "mktree", "commit-tree", "update-ref"]);

interface PlanFixture {
  dispatch: { key: string; title: string }[];
  deferred: { key: string; title: string; reason: string }[];
  blocked: { key: string; title: string; reason: string; waiting: string[] }[];
}

function runnerFor(world: World, plan: { current: PlanFixture | null }, owners: { n: number }): Runner {
  return async (cmd, args, opts = {}) => {
    if (cmd === "node" && args[1] === "status") {
      const rows = [...world.claims.entries()].map(([key, c]) => ({ key, state: c.state, title: c.title, updated: "u1" }));
      return result(JSON.stringify({ ok: true, rows }));
    }
    if (cmd === "node" && args[1] === "owner") owners.n++;
    if (cmd === "node" && args[1] === "plan") {
      if (!plan.current) return result("", 1, "refusing to plan: not in orchestrator mode");
      return result(JSON.stringify({ outcome: plan.current.dispatch.length ? "dispatch" : "nothing-eligible", message: "plan", ...plan.current, stale: [] }));
    }
    if (cmd === "git" && LOCAL.has(args[0])) return run("git", args, { cwd: opts.cwd ?? world.repo, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return world.runner(cmd, args, opts);
  };
}

let reqN = 0;
interface Typed {
  texts: string[];
  answer: boolean | "throw";
}

async function kitchen(name: string, opts: { coordinator?: boolean; records?: boolean } = {}) {
  const s = makeScenario(tmp, name);
  if (opts.records) addRecordsFixture(s);
  const snap: { delivery?: DeliveryBoard } = {};
  const events: OfficeEvent[] = [];
  const hub = { snap, emit: (e: OfficeEvent) => void events.push(e) };
  const kitchenKey = `kitchen-${name}`;
  const plan: { current: PlanFixture | null } = {
    current: { dispatch: [], deferred: [], blocked: [{ key: "10.2", title: "Next ticket", reason: "blocked by 10.1", waiting: ["10.1"] }] },
  };
  const owners = { n: 0 };
  const runner = runnerFor(s.world, plan, owners);
  const typed: Typed = { texts: [], answer: true };
  const coordinator =
    opts.coordinator === false
      ? null
      : {
          type: async (text: string) => {
            if (typed.answer === "throw") throw new Error("terminal gone");
            typed.texts.push(text);
            return typed.answer;
          },
        };
  const make = () => createDeliveryService({ hub, root: s.repo, repo: "owner/project", kitchenKey, runner, home: tmp, coordinator, core: { confirmDelaysMs: [0] } });
  const service = make();
  await service.refresh();
  const call = async (op: string, params: Record<string, unknown>, svc: DeliveryService = service): Promise<DeliveryReply> => {
    const got: OfficeEvent[] = [];
    await svc.handle({ rpc: "delivery", id: `a${reqN++}`, op, params }, { origin: ORIGIN, reply: (e) => got.push(e) });
    const e = got.find((x) => x.type === "delivery.reply");
    if (!e || e.type !== "delivery.reply") throw new Error(`${op}: no reply`);
    return e.reply;
  };
  return { ...s, hub, events, kitchenKey, runner, plan, owners, typed, service, make, call, view: () => service.view("10.1"), backups: backupsDir(kitchenKey, tmp) };
}
type Kitchen = Awaited<ReturnType<typeof kitchen>>;

/** Delivers the scenario's ticket through the drawer's operations, up to a verified merge (no checks, acknowledged). */
async function deliver(k: Kitchen) {
  okReply(`${k.kitchenKey} inspect`, await k.call("inspect", { key: "10.1" }));
  const i = k.view().inspection!;
  const t = { key: "10.1", head: i.head, base: i.base, tree: i.tree };
  okReply(`${k.kitchenKey} approve`, await k.call("approve", t));
  okReply(`${k.kitchenKey} push`, await k.call("push", { key: "10.1", head: i.head }));
  okReply(`${k.kitchenKey} PR`, await k.call("ensurePr", { key: "10.1" }));
  okReply(`${k.kitchenKey} status`, await k.call("status", { key: "10.1" }));
  okReply(`${k.kitchenKey} acknowledge`, await k.call("acknowledgeNoChecks", t));
  okReply(`${k.kitchenKey} merge`, await k.call("merge", t));
  const v = k.view();
  if (v.outcome !== "merged" || !v.verified) throw new Error(`${k.kitchenKey}: not merged and verified`);
  return { merge: v.merged!.commit!, approved: i };
}

/** Prepares the completion records and delivers their records PR (ticket 10.3), through local main reconciled. */
async function deliverRecords(k: Kitchen) {
  okReply(`${k.kitchenKey} prepare records`, await k.call("prepareRecords", { key: "10.1" }));
  const R = { key: "10.1", track: "records" };
  okReply(`${k.kitchenKey} records inspect`, await k.call("inspect", R));
  const i = k.view().records!.inspection!;
  const t = { ...R, head: i.head, base: i.base, tree: i.tree };
  okReply(`${k.kitchenKey} records approve`, await k.call("approve", t));
  okReply(`${k.kitchenKey} records push`, await k.call("push", { ...R, head: i.head }));
  okReply(`${k.kitchenKey} records PR`, await k.call("ensurePr", R));
  okReply(`${k.kitchenKey} records status`, await k.call("status", R));
  okReply(`${k.kitchenKey} records acknowledge`, await k.call("acknowledgeNoChecks", t));
  okReply(`${k.kitchenKey} records merge`, await k.call("merge", t));
  okReply(`${k.kitchenKey} records list`, await k.call("reconcilePlan", R));
  okReply(`${k.kitchenKey} records reconcile`, await k.call("reconcile", { ...R, digest: k.view().records!.after.reconcilePlan!.digest }));
  return { head: i.head, merge: k.view().records!.merged!.commit! };
}

const porcelain = (repo: string) => execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], { cwd: repo, encoding: "utf8" });
const bytes = (p: string) => readFileSync(p);
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && a.equals(b);
const listDirs = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

const fakeClient: DeliveryClient = { request: async () => ({ ok: false, id: "x", op: null, key: null, kind: "unavailable", message: "test", fix: null, reasons: [], view: null }) };
const render = (view: DeliveryView) =>
  renderToString(createElement(DeliveryPanel, { deliveryKey: view.key, board: { available: true, reason: null, byKey: { [view.key]: view } }, view, client: fakeClient }));
const buttons = (html: string, op: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(`data-op="${op}"`));

// ---------------------------------------------------------------- pure rules

function pureRules() {
  eq("status parse", parseStatus(" M a.txt\0?? b c\0A  d/e\0"), [
    { status: " M", path: "a.txt" },
    { status: "??", path: "b c" },
    { status: "A ", path: "d/e" },
  ]);
  eq("name-status parse", [...parseNameStatus("M\0a.txt\0A\0d/e\0D\0x\0").entries()], [
    ["a.txt", "M"],
    ["d/e", "A"],
    ["x", "D"],
  ]);
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", "./a", "C:/x", "a\\b", ""]) {
    let threw = false;
    try {
      safeRelative(bad);
    } catch {
      threw = true;
    }
    check(`unsafe path refused: ${JSON.stringify(bad)}`, threw);
  }
  check("plain path accepted", safeRelative("context/tickets/10.1-demo.md") === "context/tickets/10.1-demo.md");

  // The wire: reconcile takes exactly a key and a 64-hex digest; the others a key.
  const D = "a".repeat(64);
  check("wire: reconcile ok", parseRequest({ rpc: "delivery", id: "r", op: "reconcile", params: { key: "10.1", digest: D } }).ok);
  for (const [label, params] of [
    ["no digest", { key: "10.1" }],
    ["short digest", { key: "10.1", digest: "abc" }],
    ["upper-case digest", { key: "10.1", digest: D.toUpperCase() }],
    ["a path from the browser", { key: "10.1", digest: D, path: "/tmp" }],
    ["a force flag", { key: "10.1", digest: D, force: true }],
  ] as const)
    check(`wire refuses reconcile: ${label}`, !parseRequest({ rpc: "delivery", id: "r", op: "reconcile", params }).ok);
  check("wire: handback takes no text", !parseRequest({ rpc: "delivery", id: "r", op: "handback", params: { key: "10.1", text: "rm -rf" } }).ok);
  check("wire: plan takes no flags", !parseRequest({ rpc: "delivery", id: "r", op: "plan", params: { key: "10.1", live: "x" } }).ok);
  check("wire: reconcilePlan ok", parseRequest({ rpc: "delivery", id: "r", op: "reconcilePlan", params: { key: "10.1" } }).ok);

  // The handback text: one line, the marker first, exactly the two commands, no other input.
  const M = "b".repeat(40);
  const text = handbackText("10.1", 7, M);
  check("handback: one line", !/[\r\n]/.test(text));
  check("handback: opens with its marker", text.startsWith(`[tin-and-thyme:handback 10.1 ${M}]`));
  check("handback: asks for /ticket complete then orchestrate release", text.indexOf("/ticket complete 10.1") > 0 && text.indexOf("orchestrate release 10.1") > text.indexOf("/ticket complete 10.1"));
  check("handback: never a dirty main", /never leave completion edits uncommitted on main/.test(text));
  eq("handback marker shared with the drawer", handbackMarker("10.1", M), handbackMarkerOf("10.1", M));
  let threw = false;
  try {
    handbackMarker("10.1", "abc");
  } catch {
    threw = true;
  }
  check("handback marker needs the full merge id", threw);
}

// ---------------------------------------------------------------- reconcile: unrelated changes kept, collisions backed up byte for byte

async function reconcilePreserves() {
  const k = await kitchen("preserve");
  const { merge } = await deliver(k);
  const r = k.repo;
  const w = (p: string, data: string | Buffer) => {
    mkdirSync(dirname(join(r, p)), { recursive: true });
    writeFileSync(join(r, p), data);
  };
  // Unrelated: a tracked modification, an untracked file, an ignored file, a staged unrelated file.
  w("README.md", "hello, local edit\n");
  w("notes/todo.txt", "mine\n");
  writeFileSync(join(r, ".git", "info", "exclude"), "*.local\n");
  w("settings.local", "secret-ish local\n");
  w("docs/staged.md", "staged unrelated\n");
  git(r, "add", "docs/staged.md");
  // Colliding: the merge changes the ticket record (modified here, staged and then edited again),
  // and adds src/feature.ts (an untracked binary draft here, executable).
  w("context/tickets/10.1-demo.md", "staged version\n");
  git(r, "add", "context/tickets/10.1-demo.md");
  w("context/tickets/10.1-demo.md", "working version\n");
  const draft = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0x80, 0x81, 0xc3, 0x28, 42]);
  w("src/feature.ts", draft);
  chmodSync(join(r, "src/feature.ts"), 0o755);
  const before = { readme: bytes(join(r, "README.md")), todo: bytes(join(r, "notes/todo.txt")), local: bytes(join(r, "settings.local")), staged: bytes(join(r, "docs/staged.md")) };
  const head0 = git(r, "rev-parse", "HEAD");

  check("before: local main does not contain the merge", k.view().after.mainHasMerge === false, k.view().after.mainHasMerge);
  refusedReply("reconcile before listing", await k.call("reconcile", { key: "10.1", digest: "c".repeat(64) }), "refused", /List the main checkout first/);

  const listed = okReply("list the main checkout", await k.call("reconcilePlan", { key: "10.1" }));
  const rp = k.view().after.reconcilePlan!;
  check("listing replied", (listed.data as { digest?: string }).digest === rp.digest);
  check("listing: nothing changed by listing", git(r, "rev-parse", "HEAD") === head0 && sameBytes(bytes(join(r, "src/feature.ts")), draft));
  eq(
    "collisions: exactly the ticket record and the added file",
    rp.collisions.map((c) => [c.path, c.kind, c.status]),
    [
      ["context/tickets/10.1-demo.md", "modified", "MM"],
      ["src/feature.ts", "untracked", "??"],
    ],
  );
  check("collision: the record differs from merged and its staged copy is kept", !rp.collisions[0].sameAsMerged && rp.collisions[0].staged);
  check("collision: the draft differs from merged", !rp.collisions[1].sameAsMerged && rp.collisions[1].why.includes("adds"));
  eq("preserved: the unrelated changes", rp.preserved.map((p) => p.path).sort(), ["README.md", "docs/staged.md", "notes/todo.txt"]);
  check("no backup folder before the click", listDirs(k.backups).length === 0);

  // The drawer: listed, the reconcile button is enabled; the handback waits for main.
  let html = render(k.view());
  check("drawer: after-merge section", /After merge/.test(html) && /data-testid="collisions"/.test(html) && /differs from merged/.test(html));
  check("drawer: handback disabled until main contains the merge", buttons(html, "handback").every((b) => b.includes("disabled")));
  check("drawer: reconcile enabled once listed", buttons(html, "reconcile").length > 0 && buttons(html, "reconcile").every((b) => !b.includes("disabled")));

  refusedReply("reconcile with another digest", await k.call("reconcile", { key: "10.1", digest: "d".repeat(64) }), "stale", /not the listing/);
  check("a refused click changed nothing", listDirs(k.backups).length === 0 && git(r, "rev-parse", "HEAD") === head0);

  const done = okReply("reconcile", await k.call("reconcile", { key: "10.1", digest: rp.digest }));
  const res = done.data as { backup: string; manifest: string; moved: number; after: string; before: string };
  const remoteMain = k.world.remote.get("refs/heads/main")!;
  check("main fast-forwarded to origin/main", git(r, "rev-parse", "HEAD") === remoteMain && res.after === remoteMain && res.before === head0);
  check("local main contains the merge", execFileSync("git", ["merge-base", "--is-ancestor", merge, "main"], { cwd: r }).length === 0);
  check("still on main", git(r, "symbolic-ref", "HEAD") === "refs/heads/main");
  eq("moved two", res.moved, 2);

  // The backup: under ~/.controlroom/<kitchen>/backups/<ts>/, byte for byte, with a manifest.
  check("backup folder under the kitchen's backups", res.backup.startsWith(join(tmp, ".controlroom", k.kitchenKey, "backups") + "/") && listDirs(k.backups).length === 1);
  check("backup folder is owner-only", (statSync(res.backup).mode & 0o777) === 0o700);
  check("backup: the binary draft byte for byte", sameBytes(bytes(join(res.backup, "files", "src/feature.ts")), draft));
  check("backup: the draft keeps its mode", (statSync(join(res.backup, "files", "src/feature.ts")).mode & 0o777) === 0o755);
  check("backup: the working record byte for byte", bytes(join(res.backup, "files", "context/tickets/10.1-demo.md")).toString() === "working version\n");
  check("backup: the staged record too", bytes(join(res.backup, "index", "context/tickets/10.1-demo.md")).toString() === "staged version\n");
  const manifest = JSON.parse(readFileSync(res.manifest, "utf8")) as {
    schema: string;
    state: string;
    key: string;
    before: string;
    after: string;
    mergeCommit: string;
    entries: { path: string; sha256: string; backup: string; index: string | null }[];
    preserved: { path: string }[];
  };
  check("manifest: complete", manifest.schema === "tin-and-thyme.reconcile-backup/1" && manifest.state === "done" && manifest.key === "10.1" && manifest.after === remoteMain && manifest.mergeCommit === merge);
  for (const e of manifest.entries) {
    const copy = bytes(join(res.backup, e.backup));
    check(`manifest hash matches the copy: ${e.path}`, (await import("node:crypto")).createHash("sha256").update(copy).digest("hex") === e.sha256);
  }
  eq("manifest lists the kept changes", manifest.preserved.map((p) => p.path).sort(), ["README.md", "docs/staged.md", "notes/todo.txt"]);

  // The checkout: the merged content in place, every unrelated change exactly as it was.
  check("merged file in place", bytes(join(r, "src/feature.ts")).toString() === "export const feature = 1;\n");
  check("merged record in place", bytes(join(r, "context/tickets/10.1-demo.md")).toString().includes("Claimed note."));
  check("kept: tracked edit", sameBytes(bytes(join(r, "README.md")), before.readme));
  check("kept: untracked file", sameBytes(bytes(join(r, "notes/todo.txt")), before.todo));
  check("kept: ignored file", sameBytes(bytes(join(r, "settings.local")), before.local));
  check("kept: staged unrelated file", sameBytes(bytes(join(r, "docs/staged.md")), before.staged) && git(r, "diff", "--cached", "--name-only") === "docs/staged.md");
  const st = parseStatus(execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: r, encoding: "utf8" }));
  eq("status after: only the unrelated changes", st.map((e) => `${e.status} ${e.path}`).sort(), [" M README.md", "?? notes/todo.txt", "A  docs/staged.md"]);

  const v = k.view();
  check("view: reconciled recorded", v.after.reconciled?.moved === 2 && v.after.reconciled.backup === res.backup && v.after.mainHasMerge === true);
  check("view: listing used up", v.after.reconcilePlan === null);
  check("step recorded", v.steps.some((s) => s.step === "reconcile" && s.ok));
  check("plan read after reconcile: waiting on this ticket", v.after.plan?.waitingOn.map((w) => w.key).join() === "10.2" && v.after.plan.newly.length === 0, v.after.plan);

  // Again: nothing to do, and no second backup.
  okReply("list again", await k.call("reconcilePlan", { key: "10.1" }));
  check("up to date now", k.view().after.reconcilePlan?.upToDate === true);
  refusedReply("reconcile when up to date", await k.call("reconcile", { key: "10.1", digest: k.view().after.reconcilePlan!.digest }), "refused", /already contains/);
  check("still one backup", listDirs(k.backups).length === 1);
  return k;
}

// ---------------------------------------------------------------- reconcile: an ignored file the merge adds, and an identical draft

async function reconcileIgnoredAndIdentical() {
  const k = await kitchen("ignored");
  await deliver(k);
  writeFileSync(join(k.repo, ".git", "info", "exclude"), "src/feature.ts\n");
  mkdirSync(join(k.repo, "src"), { recursive: true });
  writeFileSync(join(k.repo, "src/feature.ts"), "ignored local\n");
  okReply("list (ignored)", await k.call("reconcilePlan", { key: "10.1" }));
  const rp = k.view().after.reconcilePlan!;
  eq("ignored file the merge adds is a collision", rp.collisions.map((c) => [c.path, c.kind, c.status]), [["src/feature.ts", "ignored", "!!"]]);
  const res = okReply("reconcile (ignored)", await k.call("reconcile", { key: "10.1", digest: rp.digest })).data as { backup: string };
  check("ignored file backed up, merged content in place", bytes(join(res.backup, "files", "src/feature.ts")).toString() === "ignored local\n" && bytes(join(k.repo, "src/feature.ts")).toString() === "export const feature = 1;\n");

  const k2 = await kitchen("identical");
  await deliver(k2);
  mkdirSync(join(k2.repo, "src"), { recursive: true });
  writeFileSync(join(k2.repo, "src/feature.ts"), "export const feature = 1;\n");
  okReply("list (identical)", await k2.call("reconcilePlan", { key: "10.1" }));
  check("an untracked copy identical to merged says so", k2.view().after.reconcilePlan?.collisions[0]?.sameAsMerged === true);
  okReply("reconcile (identical)", await k2.call("reconcile", { key: "10.1", digest: k2.view().after.reconcilePlan!.digest }));
  check("identical copy still backed up, never deleted", listDirs(k2.backups).length === 1);

  // Nothing colliding: no backup folder at all, and main fast-forwards.
  const k3 = await kitchen("clean");
  await deliver(k3);
  okReply("list (clean)", await k3.call("reconcilePlan", { key: "10.1" }));
  eq("clean: nothing collides", k3.view().after.reconcilePlan?.collisions.length, 0);
  okReply("reconcile (clean)", await k3.call("reconcile", { key: "10.1", digest: k3.view().after.reconcilePlan!.digest }));
  check("clean: fast-forwarded, no backup", git(k3.repo, "rev-parse", "HEAD") === k3.world.remote.get("refs/heads/main") && !existsSync(k3.backups));
}

// ---------------------------------------------------------------- reconcile: refusals change nothing

async function reconcileRefusals() {
  // 1. Local main has a commit origin/main does not: no fast-forward, nothing touched.
  const k = await kitchen("diverged");
  await deliver(k);
  const r = k.repo;
  writeFileSync(join(r, "local.txt"), "a local commit\n");
  git(r, "add", "local.txt");
  git(r, "commit", "-q", "-m", "local only");
  mkdirSync(join(r, "src"), { recursive: true });
  writeFileSync(join(r, "src/feature.ts"), "draft\n");
  writeFileSync(join(r, "README.md"), "edited\n");
  const head = git(r, "rev-parse", "HEAD");
  const status = porcelain(r);
  okReply("list (diverged)", await k.call("reconcilePlan", { key: "10.1" }));
  const rp = k.view().after.reconcilePlan!;
  check("diverged: refusal reported", !!rp.refusal && /cannot be fast-forwarded/.test(rp.refusal), rp.refusal);
  check("drawer: refusal shown", /Cannot reconcile/.test(render(k.view())));
  refusedReply("diverged: reconcile refused", await k.call("reconcile", { key: "10.1", digest: rp.digest }), "refused", /cannot be fast-forwarded/);
  // And the core itself, given the listing's own digest, refuses with nothing changed.
  const rec = new Reconciler({ root: r, repo: "owner/project", base: "main", runner: k.runner });
  let kind = "";
  try {
    await rec.apply("10.1", k.view().merged!.commit!, rp.digest, k.backups);
  } catch (e) {
    kind = (e as { kind?: string }).kind ?? "";
  }
  eq("diverged: the core refuses", kind, "refused");
  check("diverged: HEAD unchanged", git(r, "rev-parse", "HEAD") === head);
  check("diverged: every file exactly as it was", porcelain(r) === status && bytes(join(r, "src/feature.ts")).toString() === "draft\n");
  check("diverged: no backup folder", !existsSync(k.backups));
  check("diverged: refused before running, so no reconcile step", !k.view().steps.some((s) => s.step === "reconcile"));

  // 2. Another branch checked out in the main checkout.
  const k2 = await kitchen("otherbranch");
  await deliver(k2);
  git(k2.repo, "checkout", "-q", "-b", "side");
  okReply("list (other branch)", await k2.call("reconcilePlan", { key: "10.1" }));
  check("other branch: refused", /on side, not main/.test(k2.view().after.reconcilePlan?.refusal ?? ""), k2.view().after.reconcilePlan?.refusal);
  check("other branch: nothing changed", git(k2.repo, "rev-parse", "--abbrev-ref", "HEAD") === "side" && !existsSync(k2.backups));

  // 3. The checkout changed after it was listed: stale, nothing moved.
  const k3 = await kitchen("changed");
  await deliver(k3);
  mkdirSync(join(k3.repo, "src"), { recursive: true });
  writeFileSync(join(k3.repo, "src/feature.ts"), "draft one\n");
  okReply("list (changed)", await k3.call("reconcilePlan", { key: "10.1" }));
  const d3 = k3.view().after.reconcilePlan!.digest;
  writeFileSync(join(k3.repo, "src/feature.ts"), "draft two\n");
  const head3 = git(k3.repo, "rev-parse", "HEAD");
  refusedReply("changed after listing: stale", await k3.call("reconcile", { key: "10.1", digest: d3 }), "stale", /changed since it was listed/);
  check("changed: nothing moved, main not moved", bytes(join(k3.repo, "src/feature.ts")).toString() === "draft two\n" && git(k3.repo, "rev-parse", "HEAD") === head3 && !existsSync(k3.backups));

  // 4. A merge in progress, and a folder where the merge adds a file.
  const k4 = await kitchen("inprogress");
  await deliver(k4);
  writeFileSync(join(k4.repo, ".git", "MERGE_HEAD"), git(k4.repo, "rev-parse", "HEAD") + "\n");
  okReply("list (merge in progress)", await k4.call("reconcilePlan", { key: "10.1" }));
  check("merge in progress: refused", /in progress/.test(k4.view().after.reconcilePlan?.refusal ?? ""));
  rmSync(join(k4.repo, ".git", "MERGE_HEAD"));
  mkdirSync(join(k4.repo, "src", "feature.ts"), { recursive: true });
  writeFileSync(join(k4.repo, "src", "feature.ts", "inner.txt"), "x\n");
  okReply("list (folder in the way)", await k4.call("reconcilePlan", { key: "10.1" }));
  check("folder in the way: refused", /folder/.test(k4.view().after.reconcilePlan?.refusal ?? ""), k4.view().after.reconcilePlan?.refusal);
  check("folder in the way: kept", existsSync(join(k4.repo, "src", "feature.ts", "inner.txt")) && !existsSync(k4.backups));

  // 5. Before a verified merge, none of the after-merge operations run.
  const k5 = await kitchen("notmerged");
  refusedReply("list before merge", await k5.call("reconcilePlan", { key: "10.1" }), "refused", /Nothing is merged yet/);
  refusedReply("handback before merge", await k5.call("handback", { key: "10.1" }), "refused", /Nothing is merged yet/);
  refusedReply("plan before merge", await k5.call("plan", { key: "10.1" }), "refused", /Nothing is merged yet/);
  eq("nothing typed", k5.typed.texts.length, 0);
}

// ---------------------------------------------------------------- the handback: once per marker, only once main has the merge

async function handbackOnce() {
  const k = await kitchen("handback", { records: true });
  const { merge } = await deliver(k);
  // Release is refused until local main contains the merge, so the handback (which asks for it) is too.
  refusedReply("handback before main has the merge (gate)", await k.call("handback", { key: "10.1" }), "refused", /reconcile the main checkout first/);
  const store = new DeliveryStore(join(tmp, ".controlroom", k.kitchenKey, "deliveries"));
  const rec = new Reconciler({ root: k.repo, repo: "owner/project", base: "main", runner: k.runner });
  const deps = {
    read: (key: string) => store.read(key),
    update: (key: string, change: Parameters<DeliveryStore["update"]>[1]) => void store.update(key, change),
    link: { type: async (t: string) => (k.typed.texts.push(t), true) },
    mainContains: (c: string) => rec.mainContains(c),
    records: async () => ({ onMain: true as const }),
    now: () => new Date(),
  };
  let refusal = "";
  try {
    await sendHandback("10.1", deps);
  } catch (e) {
    refusal = (e as Error).message;
  }
  check("handback before main has the merge (core)", /does not contain the merge/.test(refusal), refusal);
  eq("nothing typed before main has the merge", k.typed.texts.length, 0);

  okReply("list", await k.call("reconcilePlan", { key: "10.1" }));
  okReply("reconcile", await k.call("reconcile", { key: "10.1", digest: k.view().after.reconcilePlan!.digest }));
  // The completion records come first: the handback waits until they are on local main (10.3, human decision 2026-11-13).
  refusedReply("handback before the records are on main (gate)", await k.call("handback", { key: "10.1" }), "refused", /completion records first/);
  check("drawer: handback disabled until the records are on main", buttons(render(k.view()), "handback").every((b) => b.includes("disabled")));
  eq("nothing typed before the records are on main", k.typed.texts.length, 0);
  const records = await deliverRecords(k);
  check("drawer: handback enabled once main has the merge and the records", buttons(render(k.view()), "handback").every((b) => !b.includes("disabled")));

  // Two clicks at once: one runs, the other is busy. Exactly one line is typed.
  const [a, b] = await Promise.all([k.call("handback", { key: "10.1" }), k.call("handback", { key: "10.1" })]);
  check("one of two concurrent clicks ran", [a, b].filter((x) => x.ok).length === 1 && [a, b].some((x) => !x.ok && x.kind === "busy"), [a.ok, b.ok]);
  eq("typed once", k.typed.texts.length, 1);
  const marker = handbackMarker("10.1", merge);
  check("typed: the marked request", k.typed.texts[0].startsWith(`[${marker}]`) && /\/ticket complete 10\.1/.test(k.typed.texts[0]) && /orchestrate release 10\.1/.test(k.typed.texts[0]));
  check("typed: the records are on main, not to be edited again", k.typed.texts[0].includes(`records PR #${k.view().records!.merged!.pr}, squash-merged as ${records.merge}`) && /do not edit or commit them again/.test(k.typed.texts[0]));
  let v = k.view();
  check("view: handed back", v.after.handback?.status === "sent" && v.after.handback.marker === marker && v.after.handback.attempts === 1);

  refusedReply("again: refused by the gate", await k.call("handback", { key: "10.1" }), "refused", /never sent twice/);
  const again = await sendHandback("10.1", deps);
  check("again: the core sends nothing", again.data.already === true && again.data.status === "sent");
  eq("still typed once", k.typed.texts.length, 1);

  // A restart (a new service on the same state) and a refresh never send it again.
  const restarted = k.make();
  await restarted.refresh();
  v = restarted.view("10.1");
  check("restart: handback still recorded", v.after.handback?.status === "sent");
  refusedReply("restart: refused", await k.call("handback", { key: "10.1" }, restarted), "refused", /never sent twice/);
  eq("restart: still typed once", k.typed.texts.length, 1);
  check("drawer: handed back, button disabled", /Handed back/.test(render(v)) && buttons(render(v), "handback").every((x) => x.includes("disabled")));

  // The plan: 10.2 was waiting on 10.1; once the completion reaches the store, it is newly eligible.
  k.plan.current = { dispatch: [{ key: "10.2", title: "Next ticket" }], deferred: [{ key: "10.6", title: "Other", reason: "serialize: shares a file" }], blocked: [] };
  const pr = okReply("refresh the plan", await k.call("plan", { key: "10.1" }));
  v = k.view();
  eq("plan: eligible", v.after.plan?.eligible.map((e) => e.key), ["10.2", "10.6"]);
  eq("plan: newly eligible", v.after.plan?.newly, ["10.2"]);
  check("plan: reply says so", /newly: 10\.2/.test(pr.message), pr.message);
  const html = render(v);
  check("drawer: newly eligible shown", /data-key="10.2" data-newly="yes"/.test(html) && /newly eligible/.test(html) && /data-key="10.6" data-newly="no"/.test(html));
  okReply("refresh again", await k.call("plan", { key: "10.1" }));
  eq("plan: still newly eligible on a second refresh", k.view().after.plan?.newly, ["10.2"]);
  k.plan.current = null;
  refusedReply("plan: an engine refusal is reported", await k.call("plan", { key: "10.1" }), "failed", /orchestrator mode/);
  check("plan: the last good plan is kept", k.view().after.plan?.newly.join() === "10.2");
}

async function handbackUnconfirmed() {
  const k = await kitchen("unconfirmed", { records: true });
  await deliver(k);
  okReply("list", await k.call("reconcilePlan", { key: "10.1" }));
  okReply("reconcile", await k.call("reconcile", { key: "10.1", digest: k.view().after.reconcilePlan!.digest }));
  await deliverRecords(k);
  k.typed.answer = false;
  refusedReply("terminal did not confirm", await k.call("handback", { key: "10.1" }), "failed", /did not confirm/);
  check("unconfirmed recorded", k.view().after.handback?.status === "unconfirmed");
  check("drawer: send again offered", /Send the handback again/.test(render(k.view())));
  k.typed.answer = true;
  okReply("explicit retry", await k.call("handback", { key: "10.1" }));
  check("sent on the second attempt", k.view().after.handback?.status === "sent" && k.view().after.handback?.attempts === 2);
  eq("typed twice in all (one unconfirmed, one sent)", k.typed.texts.length, 2);
  refusedReply("then never again", await k.call("handback", { key: "10.1" }), "refused");
  eq("still twice", k.typed.texts.length, 2);

  // Interrupted mid-send (the kitchen stopped): never re-sent without the human looking first.
  const k2 = await kitchen("interrupted");
  const { merge } = await deliver(k2);
  okReply("list", await k2.call("reconcilePlan", { key: "10.1" }));
  okReply("reconcile", await k2.call("reconcile", { key: "10.1", digest: k2.view().after.reconcilePlan!.digest }));
  const store = new DeliveryStore(join(tmp, ".controlroom", k2.kitchenKey, "deliveries"));
  store.update("10.1", (s) => {
    s.handback = { marker: handbackMarker("10.1", merge), at: new Date().toISOString(), status: "sending", note: "x", attempts: 1 };
  });
  const restarted = k2.make();
  await restarted.refresh();
  check("interrupted: the gate says it is being sent", gateOf(restarted.view("10.1"), "handback")?.kind === "busy");
  const rec = new Reconciler({ root: k2.repo, repo: "owner/project", base: "main", runner: k2.runner });
  let kind = "";
  try {
    await sendHandback("10.1", {
      read: (key) => store.read(key),
      update: (key, c) => void store.update(key, c),
      link: { type: async (t) => (k2.typed.texts.push(t), true) },
      mainContains: (c) => rec.mainContains(c),
      records: async () => ({ onMain: true as const }),
      now: () => new Date(),
    });
  } catch (e) {
    kind = (e as { kind?: string }).kind ?? "";
  }
  eq("interrupted: not re-sent", [kind, k2.typed.texts.length], ["blocked", 0]);
  check("interrupted: now unconfirmed, for the human", store.read("10.1").handback?.status === "unconfirmed");

  // A server with no coordinator (the preview): unavailable, nothing typed.
  const k3 = await kitchen("nocoordinator", { coordinator: false });
  await deliver(k3);
  okReply("list", await k3.call("reconcilePlan", { key: "10.1" }));
  okReply("reconcile", await k3.call("reconcile", { key: "10.1", digest: k3.view().after.reconcilePlan!.digest }));
  refusedReply("no coordinator", await k3.call("handback", { key: "10.1" }), "unavailable");
  const attached = attachDelivery({ hub: { snap: {}, emit: () => {} }, root: k3.repo, github: "owner/project", kitchenKey: "preview-k" });
  check("the preview attaches without a coordinator", attached.service?.view("10.1").after.coordinator === false);
}

// ---------------------------------------------------------------- the engine: release refused until local main contains the merge

function engineRelease() {
  const root = join(tmp, "engine-release");
  mkdirSync(join(root, "context"), { recursive: true });
  git(tmp, "init", "-q", "-b", "main", root);
  writeFileSync(join(root, "context", "execution-mode.md"), "# Execution Mode\n\n<!-- pathfinder:execution-mode orchestrator -->\n");
  writeFileSync(join(root, ".gitignore"), "/.pathfinder/\ncontext/current-ticket.md\n");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "branch", "ticket/10.1-demo");
  git(root, "worktree", "add", "-q", join(root, ".pathfinder", "worktrees", "10.1"), "ticket/10.1-demo");
  const wt = join(root, ".pathfinder", "worktrees", "10.1");
  writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "feature");
  const head = git(wt, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/pathfinder/claims/10.1", head);
  writeFileSync(join(wt, "context", "current-ticket.md"), "# Current Ticket\n\n- Worker: 10.1\n- State: done\n");
  // The squash merge on origin/main: the branch's tree on the old base, one parent.
  const squash = git(root, "commit-tree", `${head}^{tree}`, "-p", base, "-m", "Squash 10.1");
  git(root, "update-ref", "refs/remotes/origin/main", squash);
  const release = () => {
    try {
      execFileSync(process.execPath, [ENGINE, "release", "10.1", "--root", root, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, message: "" };
    } catch (e) {
      return { ok: false, message: String((e as { stderr?: string }).stderr ?? e) };
    }
  };
  const refused = release();
  check("engine: release refused while local main lacks the merge", !refused.ok && /not proven merged/.test(refused.message), refused.message);
  check("engine: nothing released", existsSync(wt) && git(root, "rev-parse", "--verify", "refs/heads/ticket/10.1-demo") === head);
  git(root, "merge", "--ff-only", "-q", squash);
  const released = release();
  check("engine: release works once local main contains the merge", released.ok && !existsSync(wt), released.message);
}

// ---------------------------------------------------------------- readiness cache (10.2 review, LOW)

async function readinessCache() {
  const root = join(tmp, "readiness");
  const wt = join(root, ".pathfinder", "worktrees", "10.1", "context");
  mkdirSync(wt, { recursive: true });
  const R = "61cd56e8ed4f3890bca9ff72f717d20e66bf5e4d";
  let last = "Phase A done";
  let owners = 0;
  const runner: Runner = async (cmd, args) => {
    if (cmd === "node" && args[1] === "status") return result(JSON.stringify({ ok: true, rows: [{ key: "10.1", state: "done", title: "Demo", updated: "same" }] }));
    if (cmd === "node" && args[1] === "owner") {
      owners++;
      return result(JSON.stringify({ claim: { branch: "ticket/10.1-demo", worktree: ".pathfinder/worktrees/10.1", orphan: false, state: "done", last } }));
    }
    // An independent ticket: no blockers, started from main.
    if (cmd === "node" && args[1] === "board") return result(JSON.stringify({ tickets: [{ key: "10.1", status: "In Progress", blockers: [] }] }));
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    if (cmd === "git" && args[0] === "for-each-ref") return result(`${A} refs/heads/ticket/10.1-demo\n${B} refs/pathfinder/claims/10.1\n`);
    if (cmd === "git" && args[0] === "rev-parse") return result(`${B}\n`);
    if (cmd === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") return result("");
    return result("", 99, "unexpected");
  };
  const file = join(wt, "current-ticket.md");
  writeFileSync(file, `- State: done\n- Last: ${last}\n`);
  const r = new Readiness(runner, root, "engine.mjs");
  let rows = await r.read();
  check("readiness: not ready without a PASS", rows[0].readiness.ready === false);
  await r.read();
  eq("readiness: cached while nothing changed", owners, 1);
  // The orchestrator records the PASS; Updated stays the same.
  last = `review PASS on ${R}`;
  writeFileSync(file, `- State: done\n- Last: ${last}\n`);
  const future = new Date(Date.now() + 5000);
  (await import("node:fs")).utimesSync(file, future, future);
  rows = await r.read();
  check("readiness: a new Last: line is read though Updated did not change", rows[0].readiness.ready === true && rows[0].readiness.reviewedHead === R, rows[0].readiness);
  eq("readiness: re-read once", owners, 2);

  // A request refused by the gate re-reads readiness too.
  const k = await kitchen("gate-refresh");
  const n0 = k.owners.n;
  refusedReply("a gate-refused request", await k.call("push", { key: "10.1", head: k.head }), "refused");
  await k.service.refresh();
  check("a gate-refused request re-reads the claim", k.owners.n > n0, { before: n0, after: k.owners.n });
  check("listing reads nothing from the browser", lstatSync(k.repo).isDirectory());
}

// ---------------------------------------------------------------- stacked tickets are not ready (10.5 review)

async function stackedNotReady() {
  // Pure: blockers as the engine's board reads them, and fail-closed answers.
  const board = [
    { key: "10.1", status: "In Progress", blockers: [] },
    { key: "10.2", status: "Proposed", blockers: ["10.1"] },
    { key: "10.6", status: "Proposed", blockers: ["10.9"] },
  ];
  eq("blockers: unfinished", waitingBlockers(board, "10.2"), [{ key: "10.1", status: "In Progress" }]);
  eq("blockers: none", waitingBlockers(board, "10.1"), []);
  eq("blockers: missing blocker blocks", waitingBlockers(board, "10.6"), [{ key: "10.9", status: "missing from the store" }]);
  check("blockers: a ticket not in the store", "error" in waitingBlockers(board, "11.1"));
  const R = "61cd56e8ed4f3890bca9ff72f717d20e66bf5e4d";
  const claim = { branch: "ticket/10.2-x", worktree: ".pathfinder/worktrees/10.2", orphan: false, state: "done", last: `review PASS on ${R}` };
  check("pure: board unreadable is not ready", !readinessOf("10.2", "done", claim, { blockers: { error: "no board" }, stack: null }).ready);
  check("pure: stacking unknown is not ready", !readinessOf("10.2", "done", claim, { blockers: [], stack: { error: "no claim ref" } }).ready);
  const st = readinessOf("10.2", "done", claim, { blockers: [{ key: "10.1", status: "In Progress" }], stack: { parents: ["10.1"], reason: "x" } });
  check("pure: stacked says on what", !st.ready && st.stacked && /^Waiting on 10\.1 \(stacked\)/.test(st.reason ?? "") && st.waitingOn.join() === "10.1", st);
  check("pure: independent and unblocked is ready", readinessOf("10.2", "done", claim, { blockers: [], stack: null }).ready);

  // A repository like the real one: independent tickets, a parent, a child stacked on it, and a sibling child.
  const k = await kitchen("stacked");
  const r = k.repo;
  const branchFrom = (key: string, slug: string, from: string) => {
    const branch = `ticket/${key}-${slug}`;
    git(r, "checkout", "-q", "-b", branch, from);
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", `t${key.replace(".", "-")}.ts`), `export const t = "${key}";\n`);
    git(r, "add", "-A");
    git(r, "commit", "-q", "-m", `ticket ${key}`);
    const head = git(r, "rev-parse", "HEAD");
    git(r, "checkout", "-q", "main");
    git(r, "update-ref", `refs/pathfinder/claims/${key}`, from);
    k.world.claims.set(key, { branch, worktree: `.pathfinder/worktrees/${key}`, state: "done", last: `review PASS on ${head}`, ref: `context/tickets/${key}-${slug}.md`, title: slug });
    return head;
  };
  const independent = ["05.1", "05.2", "09.1", "01.1"];
  for (const key of independent) branchFrom(key, "independent", k.base);
  const child = branchFrom("10.2", "child", k.head);
  branchFrom("10.5", "sibling", k.head);
  k.world.tickets.set("10.1", { status: "In Progress", blockers: [] });
  k.world.tickets.set("10.2", { status: "In Progress", blockers: ["10.1"] });
  k.world.tickets.set("10.5", { status: "In Progress", blockers: ["10.1"] });
  await k.service.refresh();
  const v = (key: string) => k.service.view(key);

  for (const key of ["10.1", ...independent]) check(`independent ${key} stays ready`, v(key).readiness.ready, v(key).readiness);
  const c = v("10.2").readiness;
  check("stacked child is not ready", !c.ready && c.stacked && c.waitingOn.join() === "10.1", c);
  check("stacked child says Waiting on 10.1 (stacked)", /^Waiting on 10\.1 \(stacked\)/.test(c.reason ?? "") && /not on origin\/main/.test(c.reason ?? ""), c.reason);
  check("a sibling on the same parent is not a parent", v("10.5").readiness.waitingOn.join() === "10.1", v("10.5").readiness);
  check("drawer shows why", /Waiting on 10\.1 \(stacked\)/.test(render(v("10.2"))));

  // The server enforces it before any write, whatever the client sends.
  const pushes = () => k.world.calls.filter((x) => x.cmd === "git" && x.args[0] === "push").length;
  refusedReply("stacked: inspect refused", await k.call("inspect", { key: "10.2" }), "refused", /stacked/);
  refusedReply("stacked: approve refused", await k.call("approve", { key: "10.2", head: child, base: k.base, tree: child }), "refused", /stacked/);
  refusedReply("stacked: push refused", await k.call("push", { key: "10.2", head: child }), "refused", /stacked/);
  refusedReply("stacked: PR refused", await k.call("ensurePr", { key: "10.2" }), "refused", /stacked/);
  refusedReply("stacked: merge refused", await k.call("merge", { key: "10.2", head: child, base: k.base, tree: child }), "refused", /stacked/);
  eq("stacked: nothing pushed", pushes(), 0);

  // The parent marked Complete in the store but not merged: still stacked.
  k.world.tickets.set("10.1", { status: "Complete", blockers: [] });
  await k.service.refresh();
  check("parent Complete but unmerged: still stacked", !v("10.2").readiness.ready && v("10.2").readiness.stacked, v("10.2").readiness);

  // The parent squash-merged on origin/main, but not yet Complete: waiting on the blocker, no longer stacked.
  k.world.tickets.set("10.1", { status: "In Progress", blockers: [] });
  const squash = git(r, "commit-tree", `${k.head}^{tree}`, "-p", k.base, "-m", "Squash 10.1");
  k.world.remote.set("refs/heads/main", squash);
  refusedReply("merged parent not Complete: refused", await k.call("inspect", { key: "10.2" }), "refused", /10\.1 \(In Progress, not Complete\)/);
  check("merged parent not Complete: not stacked, waiting on the blocker", !v("10.2").readiness.ready && !v("10.2").readiness.stacked && v("10.2").readiness.waitingOn.join() === "10.1", v("10.2").readiness);

  // The parent Complete and merged: the child is ready, and the server lets it through.
  k.world.tickets.set("10.1", { status: "Complete", blockers: [] });
  okReply("parent Complete and merged: inspect runs", await k.call("inspect", { key: "10.2" }));
  check("parent Complete and merged: child ready", v("10.2").readiness.ready && !v("10.2").readiness.stacked, v("10.2").readiness);
  for (const key of independent) check(`independent ${key} still ready`, v(key).readiness.ready, v(key).readiness);

  // Fail closed: a ticket whose claim ref is gone cannot be told apart from its parents.
  git(r, "update-ref", "-d", "refs/pathfinder/claims/05.1");
  await k.service.refresh();
  check("no claim ref: not ready", !v("05.1").readiness.ready && /claim ref/.test(v("05.1").readiness.reason ?? ""), v("05.1").readiness);
}

// ---------------------------------------------------------------- readPlan, alone

async function planAlone() {
  const runner: Runner = async () =>
    result(
      JSON.stringify({
        outcome: "dispatch",
        message: "1 ticket can be claimed now.",
        dispatch: [{ key: "10.2", title: "Next" }, { key: "../x", title: "bad key" }],
        deferred: [],
        blocked: [{ key: "10.7", title: "Still", reason: "blocked by 10.1, 10.6", waiting: ["10.1", "10.6"] }],
      }),
    );
  const p = await readPlan({ runner, root: tmp, engine: "e.mjs", key: "10.1", previous: { at: "x", outcome: "", message: "", eligible: [], waitingOn: [{ key: "10.2", title: "" }], newly: [] }, now: () => new Date(0) });
  eq("readPlan: bad keys dropped", p.eligible.map((e) => e.key), ["10.2"]);
  eq("readPlan: still waiting", p.waitingOn.map((w) => w.key), ["10.7"]);
  eq("readPlan: newly", p.newly, ["10.2"]);
  let threw = false;
  try {
    await readPlan({ runner: async () => result("", 1, "refusing to plan"), root: tmp, engine: "e", key: "10.1", previous: null, now: () => new Date() });
  } catch {
    threw = true;
  }
  check("readPlan: a refusal throws", threw);
}

// ---------------------------------------------------------------- run

async function main() {
  pureRules();
  await reconcilePreserves();
  await reconcileIgnoredAndIdentical();
  await reconcileRefusals();
  await handbackOnce();
  await handbackUnconfirmed();
  engineRelease();
  await readinessCache();
  await stackedNotReady();
  await planAlone();
}

main()
  .catch((e) => failures.push(`aborted: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
  .finally(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      console.error(`FAIL ${failures.length} of ${passed + failures.length} checks:`);
      for (const f of failures) console.error("  - " + f);
      process.exit(1);
    }
    console.log(`ok ${passed} checks passed`);
    process.exit(0);
  });
