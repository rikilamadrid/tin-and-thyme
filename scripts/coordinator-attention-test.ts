// Ticket 06.1: worker-to-ticket attribution, the coordinator's attention state, review-session outcomes and
// distinct board states. Drives a real PathfinderRun with synthetic hook payloads (shaped as Claude Code sends
// them), fixture transcripts, a fake engine and a temporary HOME. Nothing touches a live kitchen.
//
//   npx tsx scripts/coordinator-attention-test.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "tt-attention-"));
// Every ~/.controlroom write lands here.
Object.assign(process.env, { HOME: tmp, USERPROFILE: tmp });

const { Attribution, readReport } = await import("../server/attribution");
const { coordinatorAttention, sessionEnding } = await import("../server/workflowState");
const { ticketView, STAGE_LABEL } = await import("../src/data/ticketStage");
// The galley model (the sidebar and the plan wall) lives in the UI bundle; its store reads the page URL.
Object.assign(globalThis, { location: { href: "http://127.0.0.1/" } });
const { buildGalley } = await import("../src/galley/model");
const { needsYou, requestShelf } = await import("../src/data/requests");
const { Hub } = await import("../server/hub");
const { COORDINATOR_ID, PathfinderRun, parseBrief } = await import("../server/pathfinder");
type Run = InstanceType<typeof PathfinderRun>;

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes += 1;
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// ---------------------------------------------------------------- fixtures

const brief = (key: string, session = "implementation", role = "developer") =>
  `Pathfinder worker brief — ${key} Ticket ${key} (context/tickets/${key}-x.md)\n\nSession:   ${session}\nRole:      ${role}\nModel:     inherited\nEffort:    inherited\nWorktree:  /work/.pathfinder/worktrees/${key}\n`;

interface World {
  root: string;
  coord: string;
  rows: Record<string, unknown>[];
  hub: InstanceType<typeof Hub>;
  run: Run;
  typed: string[];
  /** Set to make typing into the coordinator fail (its terminal unreachable). */
  link: { up: boolean; delayMs: number };
}

function makeRepo(name: string) {
  const root = join(tmp, name);
  const engineDir = join(root, "skills", "orchestrate", "engine", "bin");
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(join(root, "context"), { recursive: true });
  writeFileSync(join(root, "context", "execution-mode.md"), "<!-- pathfinder:execution-mode orchestrator -->\n");
  // A fake engine: `status --json` prints the rows the test wrote.
  writeFileSync(
    join(engineDir, "orchestrate.mjs"),
    `import { readFileSync } from "node:fs";\nconst rows = JSON.parse(readFileSync(${JSON.stringify(join(root, "rows.json"))}, "utf8"));\nprocess.stdout.write(JSON.stringify({ ok: true, store: "local", rows }));\n`,
  );
  const coord = join(tmp, `${name}-session.jsonl`);
  writeFileSync(coord, "");
  mkdirSync(join(coord.replace(/\.jsonl$/, ""), "subagents"), { recursive: true });
  return { root, coord, engine: join(engineDir, "orchestrate.mjs") };
}

function boot(repo: { root: string; coord: string; engine: string }, slug: string, rows: Record<string, unknown>[] = []): World {
  writeFileSync(join(repo.root, "rows.json"), JSON.stringify(rows));
  const config = { project: { id: slug, name: slug, path: repo.root }, team: [PathfinderRun.coordinatorConfig(repo.root)], workflow: {} } as never;
  const hub = new Hub({ root: repo.root, name: slug, originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false }, slug, config, { boards: [], tasks: [] }, {} as never);
  hub.persist = false;
  hub.setSession(COORDINATOR_ID, { state: "running" });
  const typed: string[] = [];
  const link = { up: true, delayMs: 0 };
  const inbox = { noteHook() {}, takeForStop: () => null } as never;
  const sessions = {
    typeInto: async (_id: string, text: string) => {
      if (link.delayMs) await new Promise((r) => setTimeout(r, link.delayMs));
      if (!link.up) return false;
      typed.push(text);
      return true;
    },
  } as never;
  const run = new PathfinderRun(hub, inbox, sessions, { mode: "orchestrator", engine: repo.engine }, 7999, "token", "/orchestrate start");
  run.start();
  run.stop();
  return { root: repo.root, coord: repo.coord, rows, hub, run, typed, link };
}

const setRows = (w: World, rows: Record<string, unknown>[]) => {
  w.rows = rows;
  writeFileSync(join(w.root, "rows.json"), JSON.stringify(rows));
};
const row = (key: string, state: string, extra: Record<string, unknown> = {}) => ({ worker: key, key, lifecycle: "In Progress", state, where: "—", gate: "—", last: "—", title: `Ticket ${key}`, ...extra });
const stateFile = (w: World, key: string, lines: Record<string, string>) => {
  const dir = join(w.root, ".pathfinder", "worktrees", key, "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current-ticket.md"), `# Current Ticket\n\n${Object.entries(lines).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`);
};

const subDir = (w: World) => join(w.coord.replace(/\.jsonl$/, ""), "subagents");
/** A subagent's own transcript (first prompt, optional report) and meta.json, as Claude Code writes them. */
function writeSub(w: World, agentId: string, opts: { prompt?: string; toolUseId?: string; finished?: boolean; parentAgentId?: string; report?: string; description?: string; agentType?: string }) {
  const dir = subDir(w);
  if (opts.prompt !== undefined) {
    const recs: unknown[] = [{ parentUuid: null, isSidechain: true, agentId, type: "user", message: { role: "user", content: opts.prompt }, timestamp: new Date().toISOString() }];
    if (opts.report)
      recs.push({ isSidechain: true, agentId, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "SubagentHandback", input: { message: opts.report } }] }, timestamp: new Date().toISOString() });
    writeFileSync(join(dir, `agent-${agentId}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  if (opts.toolUseId !== undefined || opts.finished !== undefined) {
    writeFileSync(
      join(dir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: opts.agentType ?? "general-purpose", description: opts.description ?? "", toolUseId: opts.toolUseId, ...(opts.parentAgentId ? { parentAgentId: opts.parentAgentId } : {}), ...(opts.finished ? { finished: true } : {}) }),
    );
  }
}
/** The coordinator's own transcript: its last record says whether its turn ended. */
function coordinatorTurn(w: World, ended: boolean) {
  const rec = ended
    ? { type: "assistant", isSidechain: false, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Dispatched. Waiting." }] } }
    : { type: "user", isSidechain: false, message: { role: "user", content: "go on" } };
  writeFileSync(w.coord, JSON.stringify(rec) + "\n");
}

// Hook payloads, as Claude Code sends them (PreToolUse/PostToolUse carry tool_use_id; SubagentStart only agent_id and agent_type).
const hook = (w: World, event: string, body: Record<string, unknown>) => w.run.onHook(event, { session_id: "s", transcript_path: w.coord, cwd: w.root, hook_event_name: event, ...body });
const preAgent = (w: World, toolUseId: string, prompt: string, description = "") => hook(w, "PreToolUse", { tool_name: "Agent", tool_use_id: toolUseId, tool_input: { prompt, description, subagent_type: "general-purpose", run_in_background: true } });
const postAgent = (w: World, toolUseId: string, prompt: string, agentId: string, by?: string) =>
  hook(w, "PostToolUse", { ...(by ? { agent_id: by, agent_type: "general-purpose" } : {}), tool_name: "Agent", tool_use_id: toolUseId, tool_input: { prompt }, tool_response: { isAsync: true, status: "async_launched", agentId, prompt } });
const subStart = (w: World, agentId: string) => hook(w, "SubagentStart", { agent_id: agentId, agent_type: "general-purpose" });
const subStop = (w: World, agentId: string, last = "") => hook(w, "SubagentStop", { agent_id: agentId, agent_type: "general-purpose", agent_transcript_path: join(subDir(w), `agent-${agentId}.jsonl`), last_assistant_message: last, stop_hook_active: false });
const stopTurn = (w: World) => hook(w, "Stop", { stop_hook_active: false, last_assistant_message: "Waiting." });

type WorkerView = { key: string; session: string; live: boolean; hqId: string; ended: { outcome: string; verdict?: string | null; result: string | null } | null };
const workers = (w: World) => (w.run as unknown as { workers: Map<string, WorkerView> }).workers;
const helperInfo = (w: World) => (w.run as unknown as { helperInfo: Map<string, { parent: string; label: string }> }).helperInfo;
const pendingLaunches = (w: World) => (w.run as unknown as { attribution: InstanceType<typeof Attribution> }).attribution.pending().map((l) => l.toolUseId);
const refresh = (w: World) => (w.run as unknown as { refresh(): Promise<void> }).refresh();
const coordinator = (w: World) => w.hub.status(COORDINATOR_ID)!;
const crewTicket = (w: World, agentId: string) => {
  const wk = workers(w).get(agentId);
  const cfg = wk && w.hub.cfg(wk.hqId);
  return cfg?.crew ? { ticket: cfg.crew.ticket, session: cfg.crew.session } : null;
};
const helpers = (w: World) => w.hub.snap.workflow?.helpers ?? [];

// ================================================================ pure units

{
  const a = new Attribution((p) => parseBrief(p) !== null);
  a.launch("tu_1", { prompt: brief("02.1") }, COORDINATOR_ID);
  a.launch("tu_2", { prompt: "Find where X is", description: "Search X" }, COORDINATOR_ID);
  // A start with no evidence is unknown, whatever is pending.
  eq("unit: a start with no evidence stays unknown (no queue position)", a.identify("ag_h", { toolUseId: null, prompt: null, parent: null, description: "", agentType: "" }), null);
  // meta.json's toolUseId names the exact launch.
  const h = a.identify("ag_h", { toolUseId: "tu_2", prompt: null, parent: null, description: "", agentType: "Explore" });
  eq("unit: meta toolUseId binds the helper to its own launch", h && h.kind, "helper");
  eq("unit: the brief's launch is still pending", a.pending().map((l) => l.toolUseId), ["tu_1"]);
  const wk = a.bind("tu_1", "ag_w", brief("02.1"), COORDINATOR_ID);
  eq("unit: the tool result binds the worker", wk.kind === "worker" && parseBrief(wk.prompt)?.key, "02.1");
  eq("unit: a launch is consumed exactly once", a.pending(), []);
  eq("unit: a second subagent claiming a consumed launch stays unknown", a.identify("ag_other", { toolUseId: "tu_1", prompt: null, parent: null, description: "", agentType: "" }), null);
  eq("unit: an identity is never re-decided", a.identify("ag_w", { toolUseId: null, prompt: "something else", parent: null, description: "", agentType: "" })?.kind, "worker");
}
{
  eq("unit: report DONE", readReport("DONE: 61cd56e8\n\nBoth findings fixed.")?.verdict, "DONE");
  eq("unit: report GATE text", readReport("GATE: needs a second account.\nmore")?.text, "needs a second account.");
  eq("unit: report VERDICT: PASS", readReport("## 01.1 review, round 2: PASS, with no findings\n\nbody\n\nVERDICT: PASS")?.verdict, "PASS");
  eq("unit: report **Result: FINDINGS.**", readReport("# 09.1 review\n\n**Result: FINDINGS.** I found one Medium gap.")?.verdict, "FINDINGS");
  eq("unit: no verdict, no report", readReport("I looked around and changed nothing."), null);
}
{
  const ended = sessionEnding("review", "**Result: PASS.** One Low finding deferred.\n\nVERDICT: PASS", { state: "review", last: "previous developer's DONE line", gate: null });
  eq("unit: a review that reported PASS is handed off, not interrupted", [ended.outcome, ended.verdict], ["handed-off", "PASS"]);
  check("unit: its result is its own report, never the ticket's earlier Last", ended.result?.startsWith("Result: PASS") === true, ended.result);
  const f = sessionEnding("review", "VERDICT: FINDINGS", { state: "review", last: null, gate: null });
  eq("unit: a review that reported FINDINGS is handed off", [f.outcome, f.verdict, f.next], ["handed-off", "FINDINGS", null]);
  eq("unit: no report and its own stage still recorded is interrupted", sessionEnding("review", null, { state: "review", last: null, gate: null }).outcome, "interrupted");
  eq("unit: GATE report", sessionEnding("implementation", "GATE: sign in", { state: "working", last: null, gate: null }).outcome, "gate");
}
{
  const base = { turnEnded: true, liveWorkers: 0, openGates: [] as string[], asking: null };
  eq("unit: turn ended with live workers → waiting", coordinatorAttention({ ...base, liveWorkers: 2 })?.state, "waiting");
  eq("unit: open gate → needs you even while workers run", coordinatorAttention({ ...base, liveWorkers: 2, openGates: ["02.1"] })?.state, "needs-input");
  eq("unit: no workers and a question → needs you", coordinatorAttention(base)?.state, "needs-input");
  eq("unit: a permission prompt → needs you", coordinatorAttention({ ...base, liveWorkers: 1, asking: "Asking: Approve Bash?" }), { state: "needs-input", note: "Asking: Approve Bash?" });
  eq("unit: a turn in progress is the hooks' to show", coordinatorAttention({ ...base, turnEnded: false, liveWorkers: 1 }), null);
}
{
  const tv = (state: string, extra: Record<string, unknown> = {}) => ticketView({ state, lifecycle: "In Progress", ...extra });
  eq("unit: active review with a live tester → In review", [tv("review", { liveSession: "review" }).label, tv("review", { liveSession: "review" }).column], ["In review", "in-review"]);
  eq("unit: review with no live reviewer is not In review", [tv("review").stage, tv("review").label], ["waiting-review", "Waiting for review"]);
  eq("unit: done → Ready to deliver, never Review", [tv("done").label, tv("done").column], ["Ready to deliver", "reviewed"]);
  eq("unit: done + PR open → Awaiting merge", [tv("done", { delivery: "pr-open" }).label, tv("done", { delivery: "pr-open" }).next], ["Awaiting merge", "A human merges the pull request"]);
  eq("unit: integrated + Complete → Done / Served", [ticketView({ state: "integrated", lifecycle: "Complete" }).label, ticketView({ state: "integrated", lifecycle: "Complete" }).column], ["Done / Served", "done"]);
  eq("unit: integrated without Complete is not Done", [tv("integrated").label, tv("integrated").column], ["Integrated · completion pending", "reviewed"]);
  eq("unit: a gate's blocker is Pathfinder's own text", tv("human-gate", { gate: "Sign in" }).blocker, "Sign in");
  eq("unit: stale with a pending review reads as waiting for review", ticketView({ state: "stale", recorded: "review" }).label, "Waiting for review");
  for (const st of ["ready", "blocked", "working", "adversary", "review", "repair", "human-gate", "done", "stale", "failed", "integrated"])
    for (const live of [null, "review"])
      check(`unit: only an underway review is In review (${st}, ${live ?? "no session"})`, (tv(st, { liveSession: live }).stage === "in-review") === ((st === "review" || st === "adversary") && !!live));
}

// ================================================================ the run: attribution through hooks

const repo = makeRepo("repo-a");
const w = boot(repo, "tt-a");

// 1. PostToolUse before SubagentStart (the original defect), then a helper starts.
preAgent(w, "tu_101", brief("10.1"), "10.1 delivery core developer");
postAgent(w, "tu_101", brief("10.1"), "a101");
subStart(w, "a101");
eq("PostToolUse before SubagentStart: the worker has its own ticket", crewTicket(w, "a101"), { ticket: "10.1", session: "implementation" });
eq("PostToolUse before SubagentStart: its brief is not left pending", pendingLaunches(w), []);
preAgent(w, "tu_plan", "Investigate the in-app delivery flow and plan it.", "Investigate in-app delivery flow plan");
subStart(w, "aplan"); // SubagentStart carries no prompt and no tool_use_id
check("a helper never inherits a ticket (no worker for it)", !workers(w).has("aplan"));
postAgent(w, "tu_plan", "Investigate the in-app delivery flow and plan it.", "aplan");
check("the helper is identified by its own launch", helperInfo(w).get("aplan")?.label === "Investigate in-app delivery flow plan", helperInfo(w).get("aplan"));
eq("only one worker exists", [...workers(w).keys()], ["a101"]);

// 2. Two concurrent dispatches answered in reverse order.
preAgent(w, "tu_021", brief("02.1"), "02.1 developer");
preAgent(w, "tu_091", brief("09.1", "review", "tester"), "09.1 review");
writeSub(w, "a091", { prompt: brief("09.1", "review", "tester"), toolUseId: "tu_091" });
subStart(w, "a091"); // identified at start from its meta.json toolUseId and its own prompt
subStart(w, "a021"); // no files yet: unknown, and must not take the other pending brief
eq("reverse order: the second launch is identified from its own meta.json", crewTicket(w, "a091"), { ticket: "09.1", session: "review" });
check("reverse order: an unidentified start takes no brief", !workers(w).has("a021"));
postAgent(w, "tu_091", brief("09.1", "review", "tester"), "a091");
postAgent(w, "tu_021", brief("02.1"), "a021");
eq("reverse order: the first launch keeps its own ticket", crewTicket(w, "a021"), { ticket: "02.1", session: "implementation" });
eq("reverse order: no launch left pending", pendingLaunches(w), []);
check("reverse order: both live", workers(w).get("a021")?.live === true && workers(w).get("a091")?.live === true);

// 3. A helper started while a brief is pending.
preAgent(w, "tu_052", brief("05.2"), "05.2 developer");
preAgent(w, "tu_srch", "Search the repo for hook payload docs", "Search hooks");
writeSub(w, "asrch", { prompt: "Search the repo for hook payload docs", toolUseId: "tu_srch", description: "Search hooks", agentType: "Explore" });
subStart(w, "asrch");
check("helper while a brief is pending: the helper is not a worker", !workers(w).has("asrch") && helperInfo(w).has("asrch"));
eq("helper while a brief is pending: the brief stays pending for its own subagent", pendingLaunches(w), ["tu_052"]);
subStart(w, "anoev"); // a second helper with no evidence at all
check("a start with no evidence never takes the pending brief", !workers(w).has("anoev"));
postAgent(w, "tu_052", brief("05.2"), "a052");
subStart(w, "a052");
eq("the pending brief went to its own subagent", crewTicket(w, "a052"), { ticket: "05.2", session: "implementation" });
// A worker's own helper: its parent is that worker, from the worker's own hooks.
hook(w, "PreToolUse", { agent_id: "a052", agent_type: "general-purpose", tool_name: "Agent", tool_use_id: "tu_w_help", tool_input: { prompt: "Read the docs", description: "Docs lookup", subagent_type: "Explore" } });
writeSub(w, "awhelp", { prompt: "Read the docs", toolUseId: "tu_w_help", parentAgentId: "a052", description: "Docs lookup", agentType: "Explore" });
subStart(w, "awhelp");
eq("a worker's helper belongs to that worker", helperInfo(w).get("awhelp")?.parent, workers(w).get("a052")?.hqId);

// 7. Ambiguous: a start nothing can identify stays unknown and is shown as unknown.
await refresh(w);
const unknown = helpers(w).find((h) => h.id === "anoev");
eq("unknown attribution is shown as unknown", unknown && { unknown: unknown.unknown, label: unknown.label }, { unknown: true, label: "Unidentified subagent" });
check("unknown attribution is not a worker", !workers(w).has("anoev"));

// Attention: the coordinator's turn ends while workers run.
setRows(w, [row("10.1", "working"), row("02.1", "working"), row("09.1", "review"), row("05.2", "working")]);
coordinatorTurn(w, true);
stopTurn(w);
eq("turn ended with live workers → waiting on workers", [coordinator(w).state, coordinator(w).note], ["waiting", "Waiting on 4 workers"]);
// Claude Code's idle reminder doesn't turn it into "idle".
hook(w, "Notification", { message: "Claude is waiting for your input", notification_type: "idle_prompt" });
eq("the idle reminder keeps waiting on workers", coordinator(w).state, "waiting");
// An open gate needs the human even while workers run.
stateFile(w, "02.1", { State: "human-gate", Gate: "Sign in to the second account" });
setRows(w, [row("10.1", "working"), row("02.1", "human-gate", { gate: "Sign in to the second account" }), row("09.1", "review"), row("05.2", "working")]);
await refresh(w);
eq("an open gate → needs you even while workers run", [coordinator(w).state, coordinator(w).note], ["needs-input", "Asking: 02.1 needs your decision"]);

// 5. A finished session followed by a new one on the same ticket.
writeSub(w, "a021", { prompt: brief("02.1"), toolUseId: "tu_021", report: "GATE: Sign in to the second account" });
subStop(w, "a021", "");
eq("a gated session ends at its own gate", [workers(w).get("a021")?.ended?.outcome, workers(w).get("a021")?.ended?.result], ["gate", "Sign in to the second account"]);
stateFile(w, "02.1", { State: "review" });
setRows(w, [row("10.1", "working"), row("02.1", "review"), row("09.1", "review"), row("05.2", "working")]);
preAgent(w, "tu_021r", brief("02.1", "review", "tester"), "02.1 review");
postAgent(w, "tu_021r", brief("02.1", "review", "tester"), "a021r");
subStart(w, "a021r");
writeSub(w, "a021r", { prompt: brief("02.1", "review", "tester"), toolUseId: "tu_021r", report: "## 02.1 review\n\n**Result: PASS.** No findings.\n\nVERDICT: PASS" });
subStop(w, "a021r", "");
const rev = workers(w).get("a021r")?.ended;
eq("a review that reported PASS is not Interrupted", [rev?.outcome, rev?.verdict], ["handed-off", "PASS"]);
check("the review's result is its own, not the earlier gate", rev?.result?.startsWith("Result: PASS") === true, rev?.result);
eq("the earlier session keeps its own outcome", workers(w).get("a021")?.ended?.outcome, "gate");
eq("the earlier session keeps its own ticket", crewTicket(w, "a021"), { ticket: "02.1", session: "implementation" });

// 4. A resumed session on the same ticket.
writeSub(w, "a101", { prompt: brief("10.1"), toolUseId: "tu_101", report: "DONE: 0123456789abcdef", finished: true });
subStop(w, "a101", "DONE: 0123456789abcdef");
eq("a session that reported DONE handed off", workers(w).get("a101")?.ended?.outcome, "handed-off");
subStart(w, "a101"); // resumed under the same subagent id
eq("a resumed session keeps its own identity", [crewTicket(w, "a101"), workers(w).get("a101")?.live, workers(w).get("a101")?.ended], [{ ticket: "10.1", session: "implementation" }, true, null]);
await refresh(w); // its meta.json still says finished from before the resume
check("a resumed session isn't ended by its earlier finished flag", workers(w).get("a101")?.live === true);
preAgent(w, "tu_101b", brief("10.1", "resume"), "Resume 10.1");
postAgent(w, "tu_101b", brief("10.1", "resume"), "a101b");
eq("a new resume session on the same ticket is its own session", crewTicket(w, "a101b"), { ticket: "10.1", session: "resume" });
eq("…and the earlier session is still its own", crewTicket(w, "a101"), { ticket: "10.1", session: "implementation" });

// No workers and a question → needs you (the run-approval case).
for (const id of ["a101", "a101b", "a091", "a052"]) {
  writeSub(w, id, { prompt: id === "a091" ? brief("09.1", "review", "tester") : id === "a101b" ? brief("10.1", "resume") : id === "a052" ? brief("05.2") : brief("10.1"), report: "DONE: abc", finished: true });
  subStop(w, id, "DONE: abc");
}
stateFile(w, "02.1", { State: "done" });
setRows(w, [row("10.1", "done"), row("02.1", "done"), row("09.1", "done"), row("05.2", "done")]);
await refresh(w);
eq("no live workers and its turn ended → needs you", [coordinator(w).state, coordinator(w).note], ["needs-input", "Asking: answer the coordinator in its terminal"]);
// A new prompt reopens the turn.
hook(w, "UserPromptSubmit", { prompt: "carry on" });
coordinatorTurn(w, false);
await refresh(w);
eq("a new prompt clears the attention state", coordinator(w).state, "working");

// Board: `done` never renders as in-review; PR open comes from the delivery hook point.
eq("board: every done ticket is Ready to deliver, none in review", w.hub.snap.tasks.map((t) => [t.status, t.pf?.view?.label]), Array(4).fill(["reviewed", "Ready to deliver"]));
w.run.deliveryOf = (key) => (key === "02.1" ? "pr-open" : null);
await refresh(w);
eq("board: Awaiting merge comes from the delivery input", w.hub.snap.tasks.map((t) => [t.id, t.status, t.pf?.view?.label]), [["10.1", "reviewed", "Ready to deliver"], ["02.1", "reviewed", "Awaiting merge"], ["09.1", "reviewed", "Ready to deliver"], ["05.2", "reviewed", "Ready to deliver"]]);
w.run.deliveryOf = () => null;

// Every surface shows the same thing: the server's board (Boards drawer column + card label, worker drawer
// ticket line), the sidebar's ticket card and the plan wall, all from the one mapping.
{
  const wb = boot(makeRepo("repo-surfaces"), "tt-surfaces");
  setRows(wb, [row("05.1", "done"), row("05.2", "done"), row("10.4", "review"), row("01.1", "integrated", { lifecycle: "Complete" }), row("06.9", "done")]);
  preAgent(wb, "tu_104", brief("10.4", "review", "tester"), "10.4 review");
  postAgent(wb, "tu_104", brief("10.4", "review", "tester"), "a104");
  subStart(wb, "a104");
  wb.run.deliveryOf = (key) => (key === "06.9" ? "pr-open" : null);
  await refresh(wb);
  const g = buildGalley(wb.hub.snap);
  const wall = (key: string) => g.columns.findIndex((col) => col.some((s) => s.id === key));
  const surfaces = (key: string) => {
    const t = wb.hub.snap.tasks.find((x) => x.id === key)!;
    const card = g.tickets.find((x) => x.key === key);
    return { boardColumn: t.status, boardLabel: t.pf?.view?.label, drawerLabel: t.pf?.view?.label, sidebar: card?.label ?? null, wall: ["New", "Cooking", "At the pass", "Served"][wall(key)] };
  };
  const ready = { boardColumn: "reviewed", boardLabel: STAGE_LABEL.readyToDeliver, drawerLabel: STAGE_LABEL.readyToDeliver, sidebar: STAGE_LABEL.readyToDeliver, wall: "At the pass" };
  eq("surfaces: 05.1 (done) → Ready to deliver everywhere", surfaces("05.1"), ready);
  eq("surfaces: 05.2 (done) → Ready to deliver everywhere", surfaces("05.2"), ready);
  eq("surfaces: 10.4 in active review → In review", surfaces("10.4"), { boardColumn: "in-review", boardLabel: "In review", drawerLabel: "In review", sidebar: "In review", wall: "At the pass" });
  eq("surfaces: an integrated, Complete ticket → Done / Served", surfaces("01.1"), { boardColumn: "done", boardLabel: "Done / Served", drawerLabel: "Done / Served", sidebar: null, wall: "Served" });
  eq("surfaces: a PR-open input → Awaiting merge", surfaces("06.9"), { boardColumn: "reviewed", boardLabel: "Awaiting merge", drawerLabel: "Awaiting merge", sidebar: "Awaiting merge", wall: "At the pass" });
  check("surfaces: no done ticket is ever labelled Review", !wb.hub.snap.tasks.some((t) => t.pf?.state === "done" && (t.status === "in-review" || /review/i.test(t.pf?.view?.label ?? ""))));
  eq("surfaces: the ready ticket's card names its next step", g.tickets.find((x) => x.key === "05.1")?.next, "A human delivers it (pull request or integration)");
}

// 6. Restart and reconnect: a new run rebuilds every identity from the transcripts alone.
{
  // A saved outcome from before tickets were kept with it, wrong for this session: its own report wins.
  const book = join(tmp, ".controlroom", "tt-a", "sessions.json");
  const saved = JSON.parse(readFileSync(book, "utf8"));
  delete saved.a091;
  saved.a091 = { outcome: "gate", next: null, result: "02.1's gate text", at: new Date().toISOString() };
  writeFileSync(book, JSON.stringify(saved));
  for (const [id, prompt] of [["a021", brief("02.1")], ["a021r", brief("02.1", "review", "tester")]] as const) writeSub(w, id, { prompt, finished: true, toolUseId: `tu_${id}` });
  writeSub(w, "aplan", { prompt: "Investigate the in-app delivery flow and plan it.", toolUseId: "tu_plan", finished: true, description: "Investigate in-app delivery flow plan", agentType: "Plan" });
  writeSub(w, "asrch", { prompt: "Search the repo for hook payload docs", toolUseId: "tu_srch", finished: true, description: "Search hooks", agentType: "Explore" });

  const w2 = boot(repo, "tt-a", w.rows);
  await refresh(w2);
  const keys = (x: World) => Object.fromEntries([...workers(x).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, wk]) => [id, `${wk.key}/${wk.session}`]));
  eq("restart: every worker is rebuilt from its own brief", keys(w2), { a021: "02.1/implementation", a021r: "02.1/review", a052: "05.2/implementation", a091: "09.1/review", a101: "10.1/implementation", a101b: "10.1/resume" });
  check("restart: helpers are never workers", !workers(w2).has("aplan") && !workers(w2).has("asrch") && !workers(w2).has("awhelp"));
  eq("restart: a session's saved outcome stays its own", workers(w2).get("a021")?.ended?.outcome, "gate");
  eq("restart: an unverifiable saved outcome loses to the session's own report", [workers(w2).get("a091")?.ended?.outcome, workers(w2).get("a091")?.ended?.result], ["handed-off", "abc"]);
  eq("restart: the worker's helper is still that worker's", helpers(w2).find((h) => h.id === "awhelp")?.parent, workers(w2).get("a052")?.hqId);
  const team = w2.hub.snap.config.team.length;
  await refresh(w2);
  await refresh(w2);
  eq("reconnect: refreshing again adds nobody", w2.hub.snap.config.team.length, team);
  // Restart while the coordinator's turn had ended and a worker is still live → waiting, from the transcript.
  writeSub(w, "alive", { prompt: brief("07.1"), toolUseId: "tu_alive" });
  coordinatorTurn(w, true);
  const w3 = boot(repo, "tt-a", [...w.rows, row("07.1", "working")]);
  (w3.run as unknown as { startedAt: number }).startedAt = 0; // past the reattach grace
  await refresh(w3);
  eq("restart: a live worker is rebuilt live", workers(w3).get("alive")?.live, true);
  eq("restart: the transcript poll follows the same rule (waiting on workers)", coordinator(w3).state, "waiting");
}

// ================================================================ Action items: truthful, answerable, exactly once

{
  const wa = boot(makeRepo("repo-actions"), "tt-actions");
  const gateItem = (key: string) => (wa.hub.snap.actionItems ?? []).find((i) => i.id === `gate-${key}`)!;
  const counted = () => {
    const n = needsYou(wa.hub.snap);
    return { items: n.items.map((i) => i.id).sort(), asking: n.asking.map((a) => a.agentId) };
  };

  // A real pending decision, raised by a live worker: its own ticket, stage, session and owner.
  preAgent(wa, "tu_g1", brief("02.1"), "02.1 developer");
  postAgent(wa, "tu_g1", brief("02.1"), "ag1");
  subStart(wa, "ag1");
  // A finished session on another ticket that ended handed off: history, never an owner of a later gate.
  preAgent(wa, "tu_h1", brief("03.1", "review", "tester"), "03.1 review");
  postAgent(wa, "tu_h1", brief("03.1", "review", "tester"), "ah1");
  subStart(wa, "ah1");
  writeSub(wa, "ah1", { prompt: brief("03.1", "review", "tester"), report: "VERDICT: PASS" });
  subStop(wa, "ah1");
  stateFile(wa, "02.1", { State: "human-gate", Gate: "Which account should the live check use?", "Gate stage": "implementation" });
  stateFile(wa, "03.1", { State: "human-gate", Gate: "Approve the copy change?" });
  setRows(wa, [row("02.1", "human-gate", { gate: "Which account should the live check use?" }), row("03.1", "human-gate", { gate: "Approve the copy change?" })]);
  coordinatorTurn(wa, true);
  stopTurn(wa);
  await refresh(wa);
  const g1 = gateItem("02.1");
  eq("pending decision: ticket, stage, session and owner are its own", [g1.request?.key, g1.request?.stage, g1.request?.session, g1.request?.owner, g1.fromId], ["02.1", "implementation", "implementation", workers(wa).get("ag1")?.hqId, workers(wa).get("ag1")?.hqId]);
  eq("pending decision: the question is Pathfinder's gate, verbatim", g1.details, "Which account should the live check use?");
  const g3 = gateItem("03.1");
  eq("a historical session never inherits a later gate", [g3.request?.owner, g3.fromId], [null, COORDINATOR_ID]);
  check("…and the request says it can't identify the session, and why", /ended handed-off, not at this gate/.test(g3.request?.diagnostic ?? ""), g3.request?.diagnostic);
  eq("both identifiable requests count toward Needs you, nothing else does", counted(), { items: ["gate-02.1", "gate-03.1"], asking: [] });
  eq("the coordinator relays the open gates (it needs you)", [coordinator(wa).state, coordinator(wa).relaying], ["needs-input", ["02.1", "03.1"]]);

  // Dismiss/snooze sends nothing and resolves nothing.
  wa.run.snoozeGate("gate-03.1");
  eq("snooze: nothing is sent to any agent", wa.typed, []);
  eq("snooze: the gate stays open", [gateItem("03.1").status, requestShelf(gateItem("03.1"))], ["open", "snoozed"]);
  eq("snooze: it leaves Needs you", counted().items, ["gate-02.1"]);
  await refresh(wa);
  eq("snooze: a refresh doesn't bring it back or send anything", [requestShelf(gateItem("03.1")), wa.typed.length], ["snoozed", 0]);

  // An empty answer is never sent (the old "Done" with no note became a dismissal message).
  await wa.run.answerGate("gate-02.1", "   ", g1.request!.revision);
  eq("an empty answer is rejected and nothing is sent", [gateItem("02.1").answer?.state, wa.typed.length], ["rejected", 0]);

  // A delivery failure: the coordinator's terminal can't be reached.
  wa.link.up = false;
  await wa.run.answerGate("gate-02.1", "Use the work account", g1.request!.revision);
  eq("delivery failure: a specific failure, nothing delivered", [gateItem("02.1").answer?.state, wa.typed.length], ["failed", 0]);
  check("delivery failure: it says why", /Couldn't reach the coordinator's terminal/.test(gateItem("02.1").answer?.detail ?? ""));
  eq("delivery failure: the request still needs you", counted().items, ["gate-02.1"]);

  // A double-clicked submission: sent exactly once.
  wa.link.up = true;
  wa.link.delayMs = 30;
  const states: string[] = [];
  const unsub = wa.hub.subscribe((e) => e.type === "action.updated" && e.item.id === "gate-02.1" && e.item.answer && states.push(e.item.answer.state));
  await Promise.all([wa.run.answerGate("gate-02.1", "Use the work account", g1.request!.revision), wa.run.answerGate("gate-02.1", "Use the work account", g1.request!.revision)]);
  unsub();
  wa.link.delayMs = 0;
  eq("double click: typed into the coordinator exactly once", wa.typed.length, 1);
  check("the answer names the ticket and the session that asked", wa.typed[0].includes("02.1 gate") && wa.typed[0].includes(wa.hub.name(workers(wa).get("ag1")!.hqId)), wa.typed[0]);
  eq("the answer shows Sending → Delivered", states, ["sending", "delivered"]);
  eq("delivered is not resolved: the gate stays open until Pathfinder records it", gateItem("02.1").status, "open");
  eq("delivered: no longer counted as Needs you", counted().items, []);
  await wa.run.answerGate("gate-02.1", "Use the work account", g1.request!.revision);
  eq("a third send after delivery is refused", wa.typed.length, 1);

  // A reconnect: refreshing (or a browser reconnecting to the same snapshot) changes nothing.
  await refresh(wa);
  await refresh(wa);
  eq("reconnect: the answer and its state are kept, nothing re-sent", [gateItem("02.1").answer?.state, wa.typed.length], ["delivered", 1]);

  // A superseded request: Pathfinder recorded a new gate text; an answer to the old one is rejected.
  stateFile(wa, "03.1", { State: "human-gate", Gate: "Approve the revised copy change?" });
  setRows(wa, [row("02.1", "human-gate", { gate: "Which account should the live check use?" }), row("03.1", "human-gate", { gate: "Approve the revised copy change?" })]);
  const oldRevision = g3.request!.revision;
  await refresh(wa);
  check("superseded: the changed gate is a new request", gateItem("03.1").request?.revision !== oldRevision);
  eq("superseded: a new request isn't snoozed by the old one", requestShelf(gateItem("03.1")), "actionable");
  await wa.run.answerGate("gate-03.1", "Yes", oldRevision);
  eq("superseded: an answer to the old request is rejected, nothing sent", [gateItem("03.1").answer?.state, wa.typed.length], ["rejected", 1]);

  // An answered gate: resolved only when Pathfinder shows it resolved.
  stateFile(wa, "02.1", { State: "working" });
  setRows(wa, [row("02.1", "working"), row("03.1", "human-gate", { gate: "Approve the revised copy change?" })]);
  await refresh(wa);
  eq("answered gate: Pathfinder recorded it, so it's resolved", [gateItem("02.1").status, gateItem("02.1").answer?.state], ["done", "recorded"]);
  check("answered gate: it says what Pathfinder recorded", /02\.1 is now working/.test(gateItem("02.1").answer?.detail ?? ""), gateItem("02.1").answer);

  // A finished worker that stopped at its gate still owns it; the coordinator's ended turn with live workers waits.
  writeSub(wa, "ag1", { prompt: brief("02.1"), report: "GATE: Which account should the live check use?" });
  stateFile(wa, "02.1", { State: "human-gate", Gate: "Which account should the live check use (2)?", "Gate stage": "implementation" });
  subStop(wa, "ag1");
  setRows(wa, [row("02.1", "human-gate", { gate: "Which account should the live check use (2)?" }), row("03.1", "integrated", { lifecycle: "Complete" })]);
  await refresh(wa);
  eq("a finished worker's own gate keeps its identity", gateItem("02.1").request?.owner, workers(wa).get("ag1")?.hqId);
  // Answer it in the terminal instead: the gate closes; nothing remains in Needs you.
  stateFile(wa, "02.1", { State: "working" });
  setRows(wa, [row("02.1", "working"), row("03.1", "integrated", { lifecycle: "Complete" })]);
  preAgent(wa, "tu_g2", brief("02.1", "resume"), "02.1 resume");
  postAgent(wa, "tu_g2", brief("02.1", "resume"), "ag2");
  subStart(wa, "ag2");
  await refresh(wa);
  eq("ended coordinator turn with a live worker: waiting, not Needs you", [coordinator(wa).state, coordinator(wa).relaying ?? null], ["waiting", null]);
  eq("no false Needs you remains", counted(), { items: [], asking: [] });
  eq("closed gates read as resolved in Pathfinder", (wa.hub.snap.actionItems ?? []).filter((i) => i.status !== "open").map((i) => i.note), ["Pathfinder: 02.1 is now working", "Pathfinder: 03.1 is now integrated"]);
}

console.log(`\n${passes} passed, ${failures} failed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
