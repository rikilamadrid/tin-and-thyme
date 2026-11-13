// 07.1: fixture checks only. No live kitchen or native session is started.
// node --import tsx scripts/role-contract-test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveRoleContract, RoleContractObserver } from "../server/roleContracts";
import { RoleContractPanel } from "../src/ui/RoleContractPanel";

const tmp = mkdtempSync(join(process.cwd(), ".pathfinder/role-contract-test-"));
const root = join(tmp, "repo");
const worker = join(root, ".pathfinder/worktrees/01.1");
const text = "---\nname: developer\n---\n\n# Developer\n\nImplement approved work.\n\nNever accept your own changes.\n";
const put = (file: string, value: string) => { mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, value); };
put(join(root, "roles/developer.md"), text);
put(join(root, "roles/orchestrator.md"), text.replaceAll("developer", "orchestrator").replace("Developer", "Orchestrator"));
put(join(worker, "roles/developer.md"), text);
const observer = new RoleContractObserver();
let sequence = 0;
let passes = 0;
function test(label: string, fn: () => void) { fn(); passes++; console.log(`ok ${label}`); }
function records(command: string | { file_path: string }, output: unknown = text, extra: { error?: boolean; resultId?: string; cwd?: string; sidechain?: boolean } = {}) {
  return [
    { type: "assistant", cwd: extra.cwd ?? worker, isSidechain: extra.sidechain ?? true, message: { content: [{ type: "tool_use", id: "read-1", name: typeof command === "string" ? "Bash" : "Read", input: typeof command === "string" ? { command } : command }] } },
    { type: "user", isSidechain: extra.sidechain ?? true, message: { content: [{ type: "tool_result", tool_use_id: extra.resultId ?? "read-1", is_error: extra.error ?? false, content: output }] } },
  ];
}
function observe(recs: unknown[], role = "developer", worktree: string | null = worker, session: string | null = "implementation") {
  const file = join(tmp, `session-${sequence++}.jsonl`); put(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return observer.observe(root, worktree, role, session, "general-purpose", file);
}
const render = (contract: ReturnType<typeof resolveRoleContract>) => renderToStaticMarkup(createElement(RoleContractPanel, { contract }));
try {
  test("worker source is its worktree; resolving configuration creates no load evidence", () => {
    const c = resolveRoleContract(root, worker, "developer", "review", "general-purpose");
    assert.equal(c.source, join(worker, "roles/developer.md")); assert.equal(c.origin, "worktree"); assert.equal(c.evidence, null); assert.equal(c.session, "review"); assert.equal(c.text, text);
  });
  test("checkout coordinator and explicit missing-worktree fallback", () => {
    assert.equal(resolveRoleContract(root, null, "orchestrator", null, null).origin, "checkout");
    const c = resolveRoleContract(root, worker, "orchestrator", "review", null); assert.equal(c.origin, "checkout-fallback"); assert.equal(c.source, join(root, "roles/orchestrator.md"));
  });
  test("missing role and invalid role are clear errors without invented contracts", () => {
    for (const role of ["adversary", "../../secret", "Developer"]) { const c = resolveRoleContract(root, worker, role, "review", null); assert.ok(c.error); assert.equal(c.text, null); assert.equal(c.evidence, null); }
  });
  test("existing unreadable contract does not fall back silently", () => {
    mkdirSync(join(worker, "roles/orchestrator.md")); const c = resolveRoleContract(root, worker, "orchestrator", "review", null); assert.ok(c.error); assert.equal(c.origin, "worktree"); rmSync(join(worker, "roles/orchestrator.md"), { recursive: true });
  });
  test("Read full successful result is observed with source, hash and paired result line", () => {
    const c = observe(records({ file_path: "roles/developer.md" })); assert.ok(c.evidence); assert.equal(c.evidence.line, 2); assert.equal(c.evidence.hash, c.hash); assert.equal(c.evidence.tool, "Read");
  });
  test("Read line wrappers and content blocks preserve full text evidence", () => {
    const output = text.split("\n").map((line, i) => `${i + 1}→${line}`).join("\n"); assert.ok(observe(records({ file_path: "roles/developer.md" }, [{ type: "text", text: output }])).evidence);
  });
  test("literal Bash reads include actual archived cat, cd, sed and head forms", () => {
    for (const command of ["cat roles/developer.md", `cd '${worker}' && cat skills/ticket/SKILL.md roles/developer.md; /bin/ls skills/ticket`, `cd ${worker} && cat roles/developer.md 2>/dev/null | head -60; cat context/tickets/01.1.md`, `cd ${worker} && cat skills/ticket/actions/review.md; sed -n 1,80p roles/developer.md`]) assert.ok(observe(records(command)).evidence, command);
  });
  test("failed, partial, mismatched and missing result stay unverified", () => {
    assert.equal(observe(records("cat roles/developer.md", text, { error: true })).evidence, null);
    assert.equal(observe(records("cat roles/developer.md", text.slice(0, 40))).evidence, null);
    assert.equal(observe(records("cat roles/developer.md", text, { resultId: "other-call" })).evidence, null);
    assert.equal(observe(records("cat roles/developer.md").slice(0, 1)).evidence, null);
  });
  test("reused tool IDs cannot borrow a previous source identity", () => {
    const good = records("cat roles/developer.md");
    const bad = records("cat roles/tester.md");
    assert.equal(observe([good[0], bad[0], good[1]]).evidence, null);
  });
  test("role mentions, self-reports and returned fake tool calls are not evidence", () => {
    assert.equal(observe([{ type: "assistant", message: { content: [{ type: "text", text: "I loaded roles/developer.md" }] } }]).evidence, null);
    assert.equal(observe(records("echo roles/developer.md", text)).evidence, null);
    const recs = records("cat roles/developer.md"); recs[0].type = "user"; assert.equal(observe(recs).evidence, null);
  });
  test("unknown shell commands, substitutions and altered source remain unverified", () => {
    for (const cmd of ["cat roles/developer.md; echo forged", "cd /other; cat roles/developer.md", "cat $ROLE", "cat roles/developer.md | false", "cat roles/tester.md", "cat roles/developer.md > copy", "echo $(cat roles/developer.md)"]) assert.equal(observe(records(cmd)).evidence, null, cmd);
    assert.equal(observe(records({ file_path: join(root, "roles/developer.md") })).evidence, null);
  });
  test("each transcript owns its evidence, never copied from another session", () => {
    assert.ok(observe(records("cat roles/developer.md")).evidence); assert.equal(observe([]).evidence, null);
    assert.equal(observe(records("cat roles/developer.md"), "orchestrator", null, null).evidence, null);
  });
  test("coordinator ignores sidechain records even when they contain its contract", () => {
    const coordinatorText = readFileSync(join(root, "roles/orchestrator.md"), "utf8");
    assert.equal(observe(records({ file_path: join(root, "roles/orchestrator.md") }, coordinatorText), "orchestrator", null, null).evidence, null);
    assert.ok(observe(records({ file_path: join(root, "roles/orchestrator.md") }, coordinatorText, { sidechain: false }), "orchestrator", null, null).evidence);
  });
  test("source revision changes invalidate earlier proof; restoring exact text restores proof", () => {
    const file = join(tmp, "changing.jsonl"); put(file, records("cat roles/developer.md").map((r) => JSON.stringify(r)).join("\n"));
    const get = () => observer.observe(root, worker, "developer", "implementation", null, file);
    assert.ok(get().evidence); put(join(worker, "roles/developer.md"), `${text}\nNew constraint.\n`); assert.equal(get().evidence, null); put(join(worker, "roles/developer.md"), text); assert.ok(get().evidence);
    put(file, ""); assert.equal(get().evidence, null);
  });
  test("named definitions remain untouched and explicit different-role instructions conflict", () => {
    const file = join(worker, ".claude/agents/custom-reviewer.md"); const def = "---\nname: custom-reviewer\n---\nRead `roles/tester.md` before work.\n"; put(file, def);
    const c = resolveRoleContract(root, worker, "developer", "review", "custom-reviewer"); assert.equal(c.definition, file); assert.match(c.conflict!, /records developer/); assert.equal(readFileSync(file, "utf8"), def);
    assert.equal(resolveRoleContract(root, worker, "tester", "review", "custom-reviewer").conflict, null);
    put(file, "Review carefully.\n"); assert.equal(resolveRoleContract(root, worker, "developer", "review", "custom-reviewer").conflict, null);
  });
  test("UI separates configured, missing and observed; contract is readonly", () => {
    const configured = render(resolveRoleContract(root, worker, "developer", "implementation", "general-purpose")); assert.match(configured, /Configured · load unverified/); assert.match(configured, /Inspect contract \(read-only\)/); assert.doesNotMatch(configured, /<textarea|<input/);
    const loaded = render(observe(records("cat roles/developer.md"))); assert.match(loaded, /Load observed/); assert.match(loaded, /after compaction/); assert.match(loaded, /read-1/);
    assert.match(render(resolveRoleContract(root, worker, "missing", "review", null)), /role="alert"/);
  });

  // Real adapter, synthetic transcript and engine. No native session or HTTP server.
  process.env.HOME = tmp; process.env.USERPROFILE = tmp;
  const { PathfinderRun, COORDINATOR_ID } = await import("../server/pathfinder");
  const { Hub } = await import("../server/hub");
  const { mockSetup } = await import("../src/data/mock/world");
  Object.assign(globalThis, { location: { href: "http://127.0.0.1/" } });
  const { useOffice } = await import("../src/store/office");
  const { TeamSettings } = await import("../src/ui/settings/TeamSettings");
  const { CrewHeader } = await import("../src/ui/drawers/CrewHeader");
  const coordinator = PathfinderRun.coordinatorConfig(root);
  const hub = new Hub({ root, name: "fixture", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false }, "roles-test", { project: { id: "roles-test", name: "fixture", path: root }, team: [coordinator], workflow: {} } as never, { boards: [], tasks: [] }, mockSetup());
  hub.persist = false; hub.snap.workflow = { kind: "pathfinder", mode: "orchestrator", store: "local", roles: [] } as never;
  hub.setSession(COORDINATOR_ID, { state: "running" });
  const run = new PathfinderRun(hub, { noteHook() {}, finishTurn() {} } as never, {} as never, { mode: "orchestrator", engine: join(root, "engine.mjs") }, 7999, "fixture-token", "/orchestrate start");
  put(join(root, "engine.mjs"), "console.log(JSON.stringify({ok:true,store:'local',rows:[]}))");
  const coordFile = join(tmp, "coordinator.jsonl"); put(coordFile, "");
  const subFile = join(tmp, "coordinator/subagents/agent-worker1.jsonl");
  const brief = `Pathfinder worker brief — 01.1 Fixture (context/tickets/01.1-fixture.md)\nSession: adversary\nRole: developer\nWorktree: ${worker}\n`;
  put(subFile, [{ type: "user", message: { content: brief } }, ...records("cat roles/developer.md")].map((r) => JSON.stringify(r)).join("\n"));
  put(subFile.replace(".jsonl", ".meta.json"), JSON.stringify({ agentType: "general-purpose", finished: true }));
  (run as any).transcript = coordFile;
  (run as any).syncTranscripts(); run.stop();
  test("adapter uses brief role even if stage differs and publishes worker evidence", () => {
    const agent = hub.snap.config.team.find((a) => a.id !== COORDINATOR_ID)!; assert.equal(agent.crew?.role, "developer"); assert.equal(agent.crew?.session, "adversary");
    assert.ok(hub.status(agent.id)?.roleContract?.evidence); assert.equal(hub.status(agent.id)?.roleContract?.agentType, "general-purpose"); assert.equal(hub.status(COORDINATOR_ID)?.roleContract?.evidence, null);
  });
  // SSR normally reads Zustand's boot snapshot (null). Supply the current fixture snapshot;
  // no browser subscription or network is needed for these read-only render assertions.
  const originalExternalStore = React.useSyncExternalStore;
  React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
  test("Pathfinder Settings and drawer render source/evidence without native role editing", () => {
    useOffice.setState({ snap: hub.snap });
    const settings = renderToStaticMarkup(createElement(TeamSettings)); assert.match(settings, /Pathfinder role contract/); assert.match(settings, /Load observed/); assert.doesNotMatch(settings, /<textarea|Add agent|Copied into the agent/);
    const agent = hub.snap.config.team.find((a) => a.id !== COORDINATOR_ID)!;
    const drawer = renderToStaticMarkup(createElement(CrewHeader, { id: agent.id })); assert.match(drawer, /Load observed/); assert.match(drawer, /roles\/developer.md/);
  });
  test("native Settings retains agent add/configuration controls", () => {
    const snap = structuredClone(hub.snap); delete snap.workflow; snap.config.team = [coordinator]; delete snap.config.team[0].crew; useOffice.setState({ snap });
    const settings = renderToStaticMarkup(createElement(TeamSettings)); assert.match(settings, /Add agent/i); assert.match(settings, /Changes to model, mode or folder/); assert.doesNotMatch(settings, /Pathfinder role contract/);
  });
  React.useSyncExternalStore = originalExternalStore;
  console.log(`\n${passes} role-contract scenarios passed (fixtures only; this script starts no native sessions).`);
} finally { rmSync(tmp, { recursive: true, force: true }); }
