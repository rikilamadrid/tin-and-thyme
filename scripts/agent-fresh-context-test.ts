// Ticket 03.2: real Git, hooks, Inbox and snapshot; simulated agent/terminal.
// node --import tsx scripts/agent-fresh-context-test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFreshContext } from "../server/agentFreshContext";
import { HANDOFF_FILE, excludeContextFile } from "../server/agentFiles";
import { AgentSummaries } from "../server/agentSummary";
import { handleHook } from "../server/hooks";
import { Hub } from "../server/hub";
import { Inbox } from "../server/inbox";
import { loadConfig } from "../server/store";
import { summaryDisabledReason } from "../src/data/agentSummary";
import { mockSetup } from "../src/data/mock/world";
import { AgentFreshContext as Panel } from "../src/ui/drawers/AgentFreshContext";

mkdirSync(".pathfinder", { recursive: true });
const tmp = mkdtempSync(join(process.cwd(), ".pathfinder/fresh-test-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let n = 0; n < 500; n++) { if (test()) return; await wait(10); }
  throw new Error("Timed out waiting for simulated terminal");
}
let n = 0;
const inboxes: Inbox[] = [];
function fixture(timeout = 3000) {
  const dir = join(tmp, `repo-${++n}`); mkdirSync(dir); git(dir, "init", "-q");
  const repo = { root: dir, name: "fresh-test", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false };
  const { config } = loadConfig(repo, 0);
  const hub = new Hub(repo, "fresh-test", config, { boards: [], tasks: [] }, mockSetup()); hub.persist = false;
  const id = config.team[0].id;
  const sent: string[] = [];
  let enters = 0;
  let type: (text: string) => Promise<boolean> = async () => true;
  const inbox = new Inbox(hub, { type: async (_id, text) => { sent.push(text); return type(text); }, enter: async () => { enters++; return true; } });
  inboxes.push(inbox);
  hub.setSession(id, { state: "running", workspace: dir }); inbox.sessionReattached(id);
  const fresh = new AgentFreshContext(hub, inbox, timeout);
  const status = () => hub.status(id)!;
  const hook = (event: string, prompt?: string, session_id = "old", source?: string, last_assistant_message?: string) => handleHook(hub, inbox, id, event, { prompt, session_id, source, last_assistant_message });
  const write = (prompt: string, content = "Feature: 03\nDone: summary\nVerified: tests\nOpen: none\nNext: review\nRead next: ticket03.2") => {
    const marker = /^\[(tt-request-[^\]]+)\]/.exec(prompt)![1];
    writeFileSync(join(dir, HANDOFF_FILE), `<!-- ${marker} -->\n${content}\n`);
  };
  const ready = (prompt: string, session = "new", reply?: string) => {
    const marker = /^\[(tt-request-[^\]]+)\]/.exec(prompt)![1];
    hook("Stop", undefined, session, undefined, reply ?? `READY [${marker}]\nDone: summary\nOpen: none\nNext: review`);
  };
  const automate = (options: { handoff?: (prompt: string) => void; clear?: (command: string) => void; orient?: (prompt: string) => void; } = {}) => {
    type = async (text) => {
      await wait(10);
      if (text.startsWith("/")) {
        if (options.clear) options.clear(text);
        else { hook("SessionEnd", undefined, "old"); hook("SessionStart", undefined, "new", "clear"); }
      } else if (sent.length === 1) {
        hook("UserPromptSubmit", text);
        if (options.handoff) options.handoff(text); else write(text);
        hook("Stop");
      } else {
        hook("UserPromptSubmit", text, "new");
        if (options.orient) options.orient(text); else ready(text);
      }
      return true;
    };
  };
  return { dir, hub, id, inbox, fresh, status, hook, sent, write, ready, automate, setType: (f: typeof type) => { type = f; }, enters: () => enters };
}
const tests: [string, () => Promise<void>][] = [
  ["Claude and Codex run handoff → exact clear command → marked orientation; progress survives snapshot copy", async () => {
    for (const cli of ["claude", "codex"] as const) {
      const f = fixture(); f.hub.cfg(f.id)!.cli = cli;
      const observed: string[] = [];
      f.hub.subscribe(() => observed.push(JSON.stringify(f.status().contextRefresh)));
      f.automate({ clear() { f.hook("SessionEnd"); f.hook("SessionStart", undefined, "new", cli === "claude" ? "clear" : "startup"); } });
      await f.fresh.start(f.id);
      assert.equal(f.status().contextRefresh?.state, "ready");
      assert.equal(f.status().contextRefresh?.steps.orient.detail, "READY\nDone: summary\nOpen: none\nNext: review");
      assert.equal(f.sent.length, 3); assert.equal(f.sent[1], cli === "claude" ? "/clear" : "/new");
      assert.match(f.sent[2], /Read .jsmhq-handoff.md.*reply READY.*3-line status/);
      assert.ok(observed.some((s) => s.includes('"clear":{"state":"running"}')));
      assert.ok(observed.some((s) => s.includes('"orient":{"state":"running"}')));
      assert.equal(structuredClone(f.hub.snap).agents[0].contextRefresh?.state, "ready");
      assert.equal(git(f.dir, "status", "--porcelain", "--untracked-files=all"), ""); assert.equal(f.enters(), 0);
    }
  }],
  ["handoff timeout preserves context and sends no clear, orientation, or Enter", async () => {
    const f = fixture(40); await f.fresh.start(f.id);
    assert.equal(f.sent.length, 1); assert.equal(f.enters(), 0);
    assert.match(f.status().contextRefresh!.error!, /Timed out/);
    assert.equal(f.status().contextRefresh?.steps.clear.state, "pending");
  }],
  ["missing, stale timestamp, wrong marker, empty, large, and symlink handoffs never clear", async () => {
    for (const mode of ["missing", "stale", "marker", "empty", "large", "symlink"]) {
      const f = fixture();
      f.automate({ handoff(prompt) {
        const file = join(f.dir, HANDOFF_FILE);
        if (mode === "missing") return;
        f.write(prompt, mode === "empty" ? "" : mode === "large" ? "x".repeat(33_000) : "current handoff");
        if (mode === "stale") utimesSync(file, new Date(0), new Date(0));
        if (mode === "marker") writeFileSync(file, "<!-- old-marker -->\nold");
        if (mode === "symlink") { rmSync(file); const target = join(f.dir, "outside.txt"); writeFileSync(target, "private"); symlinkSync(target, file); }
      } });
      await f.fresh.start(f.id);
      assert.equal(f.status().contextRefresh?.state, "error", mode); assert.equal(f.sent.length, 1, mode);
      assert.equal(f.status().contextRefresh?.steps.clear.state, "pending", mode);
    }
  }],
  ["tracked handoff is refused before asking the agent; linked worktrees are excluded idempotently", async () => {
    const f = fixture(); writeFileSync(join(f.dir, HANDOFF_FILE), "tracked"); git(f.dir, "add", HANDOFF_FILE);
    await f.fresh.start(f.id); assert.equal(f.sent.length, 0); assert.match(f.status().contextRefresh!.error!, /tracked/);
    const g = fixture(); git(g.dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    const linked = join(tmp, "linked"); git(g.dir, "worktree", "add", "-qb", "linked", linked);
    await excludeContextFile(linked, HANDOFF_FILE); await excludeContextFile(linked, HANDOFF_FILE);
    writeFileSync(join(linked, HANDOFF_FILE), "handoff"); assert.equal(git(linked, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(readFileSync(join(g.dir, ".git/info/exclude"), "utf8").split(`/${HANDOFF_FILE}`).length - 1, 1);
  }],
  ["working, asking, stopped, missing folder, summary-in-progress and workflow sessions are refused", async () => {
    for (const mode of ["working", "needs-input", "stopped", "folder", "summary", "workflow"] as const) {
      const f = fixture();
      if (mode === "working" || mode === "needs-input") f.hub.setStatus(f.id, { state: mode });
      if (mode === "stopped") f.hub.setSession(f.id, { state: "stopped" });
      if (mode === "folder") f.hub.setSession(f.id, { workspace: null });
      if (mode === "summary") f.hub.setStatus(f.id, { summary: { state: "requesting" } });
      if (mode === "workflow") f.hub.cfg(f.id)!.crew = { session: "review" } as never;
      await f.fresh.start(f.id); assert.equal(f.sent.length, 0, mode); assert.equal(f.status().contextRefresh?.state, "error");
    }
  }],
  ["duplicate clicks, summaries, and queued messages cannot interleave with the sequence", async () => {
    const f = fixture(); f.automate(); const done = f.fresh.start(f.id);
    await until(() => f.sent.length === 1);
    await f.fresh.start(f.id);
    assert.match(summaryDisabledReason(f.hub.cfg(f.id)!, f.status())!, /fresh context/);
    await new AgentSummaries(f.hub, f.inbox).start(f.id);
    f.inbox.push(f.id, { fromId: "you", kind: "message", text: "AFTER orientation" });
    await done;
    assert.equal(f.status().contextRefresh?.state, "ready"); assert.equal(f.sent.length, 3);
    assert.equal(f.inbox.pending(f.id), 1); assert.match(f.inbox.takeForStop(f.id)!, /AFTER orientation/);
  }],
  ["unmarked prompt between handoff and clear cancels the sequence", async () => {
    const f = fixture(); f.automate(); const done = f.fresh.start(f.id);
    await until(() => f.status().contextRefresh?.steps.clear.state === "running");
    f.hook("UserPromptSubmit", "human interruption"); f.hook("Stop"); await done;
    assert.equal(f.sent.length, 1); assert.match(f.status().contextRefresh!.error!, /interrupted/);
  }],
  ["session exit and folder change between steps never send clear", async () => {
    for (const mode of ["exit", "folder"]) {
      const f = fixture(); f.automate(); const done = f.fresh.start(f.id);
      await until(() => f.status().contextRefresh?.steps.clear.state === "running");
      if (mode === "exit") f.inbox.sessionDown(f.id); else f.hub.setSession(f.id, { workspace: "/other" });
      await done; assert.equal(f.sent.length, 1); assert.equal(f.status().contextRefresh?.state, "error");
    }
  }],
  ["unconfirmed clear fails visibly and never orients; saved handoff remains", async () => {
    const f = fixture(1200); f.automate({ clear() {} }); await f.fresh.start(f.id);
    assert.equal(f.sent.length, 2); assert.match(f.status().contextRefresh!.error!, /confirming the context clear/);
    assert.equal(f.status().contextRefresh?.steps.orient.state, "pending"); assert.match(readFileSync(join(f.dir, HANDOFF_FILE), "utf8"), /Next: review/);
  }],
  ["same-session startup is not evidence of clear", async () => {
    const f = fixture(); f.automate({ clear() { f.hook("SessionStart", undefined, "old", "startup"); } });
    await f.fresh.start(f.id); assert.equal(f.sent.length, 2); assert.match(f.status().contextRefresh!.error!, /without evidence/);
  }],
  ["failed or hung clear submission stops, even if a reset hook arrives", async () => {
    for (const hung of [false, true]) {
      const f = fixture(1200);
      f.setType(async (text) => {
        await wait(5);
        if (text.startsWith("/")) { f.hook("SessionStart", undefined, "new", "clear"); return hung ? new Promise(() => {}) : false; }
        f.hook("UserPromptSubmit", text); f.write(text); f.hook("Stop"); return true;
      });
      await f.fresh.start(f.id); assert.equal(f.sent.length, 2); assert.equal(f.status().contextRefresh?.state, "error");
    }
  }],
  ["orientation timeout keeps successful handoff and clear, without replaying either", async () => {
    const f = fixture(1200); f.automate({ orient() {} }); await f.fresh.start(f.id);
    assert.equal(f.sent.length, 3); assert.equal(f.status().contextRefresh?.steps.handoff.state, "ok");
    assert.equal(f.status().contextRefresh?.steps.clear.state, "ok"); assert.equal(f.status().contextRefresh?.steps.orient.state, "failed");
    assert.equal(f.enters(), 0);
  }],
  ["orientation Stop without a request-specific READY status fails visibly", async () => {
    for (const mode of ["absent", "refusal", "stale", "incomplete", "session"]) {
      const f = fixture();
      f.automate({ orient(prompt) {
        if (mode === "absent") f.hook("Stop", undefined, "new");
        if (mode === "refusal") f.ready(prompt, "new", "I could not read the handoff.");
        if (mode === "stale") f.ready(prompt, "new", "READY [tt-request-old]\nDone: previous\nOpen: none\nNext: previous");
        if (mode === "incomplete") f.ready(prompt, "new", `READY [${/^\[(tt-request-[^\]]+)\]/.exec(prompt)![1]}]`);
        if (mode === "session") f.ready(prompt, "old");
      } });
      await f.fresh.start(f.id);
      assert.equal(f.status().contextRefresh?.state, "error", mode);
      assert.equal(f.status().contextRefresh?.steps.orient.state, "failed", mode);
      assert.equal(f.sent.length, 3, mode);
    }
  }],
  ["Claude resume with different session ID cannot confirm clear; Codex resume cannot confirm new", async () => {
    for (const cli of ["claude", "codex"] as const) {
      const f = fixture(); f.hub.cfg(f.id)!.cli = cli;
      f.automate({ clear() { f.hook("SessionStart", undefined, "resumed-other-context", "resume"); } });
      await f.fresh.start(f.id);
      assert.equal(f.status().contextRefresh?.state, "error"); assert.equal(f.sent.length, 2);
      assert.equal(f.status().contextRefresh?.steps.orient.state, "pending");
    }
  }],
  ["Claude startup with a different ID is refused, and Codex deferred startup times out without orientation", async () => {
    const claude = fixture(); claude.hub.cfg(claude.id)!.cli = "claude";
    claude.automate({ clear() { claude.hook("SessionStart", undefined, "unrelated-new-session", "startup"); } });
    await claude.fresh.start(claude.id);
    assert.equal(claude.sent.length, 2); assert.equal(claude.status().contextRefresh?.steps.clear.state, "failed");
    const codex = fixture(1200); codex.hub.cfg(codex.id)!.cli = "codex";
    codex.automate({ clear() {} }); await codex.fresh.start(codex.id);
    assert.equal(codex.sent[1], "/new"); assert.equal(codex.sent.length, 2);
    assert.equal(codex.status().contextRefresh?.steps.orient.state, "pending");
    assert.match(codex.status().contextRefresh!.error!, /Timed out confirming/);
  }],
  ["drawer shows running steps, errors, disabled reasons, and hides fresh context for workflow workers", async () => {
    const f = fixture(40); const agent = f.hub.cfg(f.id)!;
    const render = () => renderToStaticMarkup(createElement(Panel, { agent, status: f.status(), connected: true, onRequest() {} }));
    assert.match(render(), /Fresh context/);
    f.hub.setStatus(f.id, { state: "needs-input" }); assert.match(render(), /disabled=""/); assert.match(render(), /Answer the agent/);
    f.hub.setStatus(f.id, { state: "idle" }); const done = f.fresh.start(f.id);
    assert.match(render(), /Refreshing context/); assert.match(render(), /Save and verify handoff/);
    await done; assert.match(render(), /role="alert"/); assert.match(render(), /Timed out/);
    agent.crew = { session: "implementation" } as never; assert.equal(render(), "");
  }],
];
let failed = 0;
try {
  for (const [name, test] of tests) {
    try { await test(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); }
  }
} finally { for (const inbox of inboxes) inbox.stop(); rmSync(tmp, { recursive: true, force: true }); }
console.log(`${tests.length - failed}/${tests.length} fresh-context scenarios passed (simulated terminal/agent).`);
process.exitCode = failed ? 1 : 0;
