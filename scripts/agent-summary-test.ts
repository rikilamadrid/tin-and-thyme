// Ticket 03.1: real hooks/inbox/snapshot and Git, with a simulated terminal/agent.
// node --import tsx scripts/agent-summary-test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSummaries } from "../server/agentSummary";
import { excludeSummaryFile, SUMMARY_FILE } from "../server/agentFiles";
import { handleHook } from "../server/hooks";
import { Hub } from "../server/hub";
import { Inbox } from "../server/inbox";
import { loadConfig } from "../server/store";
import { summaryDisabledReason } from "../src/data/agentSummary";
import { mockSetup } from "../src/data/mock/world";
import { AgentSummary } from "../src/ui/drawers/AgentSummary";

const tmp = mkdtempSync(join(process.cwd(), "node_modules/.summary-test-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) { if (test()) return; await wait(10); }
  throw new Error("Timed out waiting for test terminal");
}
let n = 0;
const inboxes: Inbox[] = [];
function fixture(timeout = 500) {
  const dir = join(tmp, `repo-${++n}`);
  mkdirSync(dir);
  git(dir, "init", "-q");
  const repo = { root: dir, name: "test", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false };
  const { config } = loadConfig(repo, 0);
  const hub = new Hub(repo, "summary-test", config, { boards: [], tasks: [] }, mockSetup());
  hub.persist = false;
  const id = config.team[0].id;
  const sent: string[] = [];
  let enters = 0;
  let type: (text: string) => Promise<boolean> = async () => true;
  const inbox = new Inbox(hub, { type: async (_id, text) => { sent.push(text); return type(text); }, enter: async () => { enters++; return true; } });
  inboxes.push(inbox);
  hub.setSession(id, { state: "running", workspace: dir });
  inbox.sessionReattached(id);
  const summaries = new AgentSummaries(hub, inbox, timeout);
  const status = () => hub.status(id)!;
  const hook = (event: string, prompt?: string) => handleHook(hub, inbox, id, event, { prompt });
  const request = () => inbox.requestTurn(id, () => "Write a summary", timeout);
  const marker = () => /^\[(tt-request-[^\]]+)\]/.exec(sent[0])![1];
  const write = (text = "Goal: finish ticket 03.1. Next: independent review.") => writeFileSync(join(dir, SUMMARY_FILE), `<!-- ${marker()} -->\n${text}\n`);
  return { dir, hub, id, inbox, summaries, status, hook, request, sent, marker, write, setType: (f: typeof type) => { type = f; }, enters: () => enters };
}
const tests: [string, () => Promise<void>][] = [
  ["matching submitted turn publishes agent text and timestamp; snapshot reconnect keeps it; file ignored", async () => {
    const f = fixture();
    const snapshots: unknown[] = [];
    f.hub.subscribe((event) => snapshots.push(event));
    const done = f.summaries.start(f.id);
    await until(() => f.sent.length === 1);
    assert.equal(f.status().summary?.state, "requesting");
    f.hook("Stop"); // An unrelated late Stop cannot complete the new request.
    await wait(5);
    assert.equal(f.status().summary?.state, "requesting");
    f.hook("UserPromptSubmit", f.sent[0]);
    f.write();
    f.hook("Stop");
    await done;
    assert.equal(f.status().summary?.state, "ready");
    assert.equal(f.status().summary?.text, "Goal: finish ticket 03.1. Next: independent review.");
    assert.ok(Date.parse(f.status().summary!.at!));
    assert.equal(structuredClone(f.hub.snap).agents[0].summary?.text, f.status().summary?.text);
    assert.ok(snapshots.length >= 4);
    assert.equal(git(f.dir, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(f.sent.length, 1);
    assert.equal(f.enters(), 0);
  }],
  ["working, asking, stopped, and workflow workers are refused without terminal input", async () => {
    for (const state of ["working", "needs-input", "in-review"] as const) {
      const f = fixture(); f.hub.setStatus(f.id, { state });
      await f.summaries.start(f.id);
      assert.equal(f.sent.length, 0); assert.equal(f.status().summary?.state, "error");
    }
    const f = fixture(); f.hub.setSession(f.id, { state: "stopped" });
    await f.summaries.start(f.id); assert.equal(f.sent.length, 0);
    const a = f.hub.cfg(f.id)!;
    f.hub.setSession(f.id, { state: "running" });
    a.crew = { session: "implementation" } as typeof a.crew;
    assert.match(summaryDisabledReason(a, f.status())!, /no interactive prompt/);
  }],
  ["duplicate requests and inbox messages cannot share the reserved prompt", async () => {
    const f = fixture();
    const done = f.summaries.start(f.id);
    await until(() => f.sent.length === 1);
    await f.summaries.start(f.id);
    await assert.rejects(f.request(), /not ready/);
    f.inbox.push(f.id, { fromId: "you", kind: "message", text: "Later instruction" });
    f.hook("UserPromptSubmit", f.sent[0]); f.write();
    assert.equal(f.hook("Stop").response, undefined);
    await done;
    assert.equal(f.sent.length, 1);
    assert.equal(f.inbox.pending(f.id), 1);
    // The queued message remains available to the next ordinary turn.
    assert.match(f.inbox.takeForStop(f.id)!, /Later instruction/);
  }],
  ["missing or stale output fails and preserves the previous displayed summary", async () => {
    for (const stale of [false, true]) {
      const f = fixture();
      f.hub.setStatus(f.id, { summary: { state: "ready", text: "previous", at: "2026-11-11T00:00:00Z" } });
      if (stale) writeFileSync(join(f.dir, SUMMARY_FILE), "<!-- old-request -->\nold\n");
      const done = f.summaries.start(f.id); await until(() => f.sent.length === 1);
      f.hook("UserPromptSubmit", f.sent[0]); f.hook("Stop"); await done;
      assert.equal(f.status().summary?.state, "error");
      assert.equal(f.status().summary?.text, "previous");
      assert.match(f.status().summary!.error!, stale ? /this request/ : /without writing/);
    }
  }],
  ["timeout is visible and never sends a second prompt or Enter", async () => {
    const f = fixture(30);
    await f.summaries.start(f.id);
    assert.equal(f.status().summary?.state, "error");
    assert.match(f.status().summary!.error!, /Timed out/);
    assert.equal(f.sent.length, 1); assert.equal(f.enters(), 0);
  }],
  ["even a hung terminal times out; failed submission rejects without retry", async () => {
    const f = fixture(30); f.setType(() => new Promise(() => {}));
    await assert.rejects(f.request(), /Timed out/); assert.equal(f.sent.length, 1);
    const g = fixture(); g.setType(async () => false);
    await assert.rejects(g.request(), /Could not submit/); assert.equal(g.enters(), 0);
  }],
  ["session exit, restart, and unrelated prompt cancel the marked turn", async () => {
    for (const event of ["SessionEnd", "SessionStart", "UserPromptSubmit", "down"]) {
      const f = fixture(); const pending = assert.rejects(f.request(), /session changed|Another prompt|stopped/);
      await until(() => f.sent.length === 1);
      if (event === "down") f.inbox.sessionDown(f.id); else f.hook(event, "unrelated instruction");
      await pending; assert.equal(f.sent.length, 1);
    }
  }],
  ["permission waits and idle notifications do not finish a request", async () => {
    const f = fixture(40); const pending = assert.rejects(f.request(), /Timed out/);
    await until(() => f.sent.length === 1);
    f.hook("UserPromptSubmit", f.sent[0]); f.hook("PermissionRequest");
    handleHook(f.hub, f.inbox, f.id, "Notification", { notification_type: "idle_prompt" });
    await pending;
  }],
  ["symlink output is refused and never read", async () => {
    const f = fixture(); const done = f.summaries.start(f.id); await until(() => f.sent.length === 1);
    const target = join(f.dir, "private.txt"); writeFileSync(target, `<!-- ${f.marker()} -->\nprivate data`);
    symlinkSync(target, join(f.dir, SUMMARY_FILE));
    f.hook("UserPromptSubmit", f.sent[0]); f.hook("Stop"); await done;
    assert.equal(f.status().summary?.state, "error"); assert.equal(f.status().summary?.text, undefined);
  }],
  ["Git exclusion supports linked worktrees, is idempotent, and refuses tracked summaries", async () => {
    const f = fixture();
    git(f.dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    const wt = join(tmp, "linked"); git(f.dir, "worktree", "add", "-qb", "linked", wt);
    await excludeSummaryFile(wt); await excludeSummaryFile(wt);
    writeFileSync(join(wt, SUMMARY_FILE), "written by agent");
    assert.equal(git(wt, "status", "--porcelain", "--untracked-files=all"), "");
    const excludes = readFileSync(join(f.dir, ".git/info/exclude"), "utf8");
    assert.equal(excludes.split(`/${SUMMARY_FILE}`).length - 1, 1);
    const g = fixture(); writeFileSync(join(g.dir, SUMMARY_FILE), "tracked"); git(g.dir, "add", SUMMARY_FILE);
    await g.summaries.start(g.id); assert.match(g.status().summary!.error!, /tracked/); assert.equal(g.sent.length, 0);
  }],
  ["drawer renders summary as text, timestamp, Copy, and reasons for disabled states", async () => {
    const f = fixture(); const agent = f.hub.cfg(f.id)!;
    f.hub.setStatus(f.id, { summary: { state: "ready", text: "<script>unsafe</script>", at: "2026-11-13T12:00:00Z" } });
    const render = () => renderToStaticMarkup(createElement(AgentSummary, { agent, status: f.status(), connected: true, onRequest() {} }));
    let html = render();
    assert.match(html, /Summarise/); assert.match(html, />Copy<\/button>/); assert.match(html, /dateTime="2026-11-13T12:00:00Z"/);
    assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
    f.hub.setStatus(f.id, { state: "working" }); html = render();
    assert.match(html, /disabled=""/); assert.match(html, /Wait until the agent is idle/);
    f.hub.setStatus(f.id, { state: "needs-input" }); assert.match(render(), /Answer the agent/);
    f.hub.setStatus(f.id, { summary: { state: "error", error: "Timed out" } }); assert.match(render(), /role="alert"/);
  }],
];
let failures = 0;
try {
  for (const [name, test] of tests) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`, error); }
  }
} finally {
  for (const inbox of inboxes) inbox.stop();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${tests.length - failures}/${tests.length} scenarios passed (simulated agent; no live Claude or OS clipboard).`);
process.exitCode = failures ? 1 : 0;
