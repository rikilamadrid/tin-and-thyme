// Ticket 06.1: worker-to-ticket attribution, the coordinator's attention state, review-session outcomes and
// distinct board states. Drives a real PathfinderRun with synthetic hook payloads (shaped as Claude Code sends
// them), fixture transcripts, a fake engine and a temporary HOME. Nothing touches a live kitchen.
// The gate-occurrence sections at the end (review 4) run this repository's own engine instead, on throwaway
// projects with real claims, so the durable gate record is the one Pathfinder really writes.
//
//   npx tsx scripts/coordinator-attention-test.ts

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The real path, spelled as git spells it (macOS /var is /private/var; a Windows short name is expanded).
const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "tt-attention-")));
// Every ~/.controlroom write lands here.
Object.assign(process.env, { HOME: tmp, USERPROFILE: tmp });

const { Attribution, readReport } = await import("../server/attribution");
const { coordinatorAttention, gateOwner, sameQuestion, sessionEnding } = await import("../server/workflowState");
const { COLUMN_LABEL, ticketView, STAGE_LABEL } = await import("../src/data/ticketStage");
// The galley model (the sidebar and the plan wall) lives in the UI bundle; its store reads the page URL.
Object.assign(globalThis, { location: { href: "http://127.0.0.1/" } });
const { buildGalley } = await import("../src/galley/model");
const { needsYou, requestShelf } = await import("../src/data/requests");
const { Hub } = await import("../server/hub");
const { COORDINATOR_ID, PathfinderRun, parseBrief } = await import("../server/pathfinder");
const { gateHistory, gateRevision, isGateOccurrence, parseGateMarker, readGateHistory } = await import("../server/gateRecord");
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

/** `saved`: the action items a restarted kitchen loads from its own disk (action-items.json), when it had saved them. */
function boot(repo: { root: string; coord: string; engine: string; real?: boolean }, slug: string, rows: Record<string, unknown>[] = [], saved?: unknown): World {
  if (!repo.real) writeFileSync(join(repo.root, "rows.json"), JSON.stringify(rows));
  const config = { project: { id: slug, name: slug, path: repo.root }, team: [PathfinderRun.coordinatorConfig(repo.root)], workflow: {} } as never;
  const hub = new Hub({ root: repo.root, name: slug, originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false }, slug, config, { boards: [], tasks: [] }, {} as never);
  hub.persist = false;
  if (saved) hub.snap.actionItems = JSON.parse(JSON.stringify(saved));
  hub.setSession(COORDINATOR_ID, { state: "running" });
  const typed: string[] = [];
  const link = { up: true, delayMs: 0 };
  const inbox = { noteHook() {}, finishTurn() {}, takeForStop: () => null } as never;
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
/** A tool call from a worker session itself: proof it is running at that moment. */
const toolEvent = (w: World, agentId: string, command = "git status") => hook(w, "PostToolUse", { agent_id: agentId, agent_type: "general-purpose", tool_name: "Bash", tool_use_id: `tu_${agentId}_${Math.random().toString(36).slice(2, 8)}`, tool_input: { command }, tool_response: { stdout: "" } });
/** A gate occurrence as the engine writes one (12 hex characters). The tests name them; the engine draws them at random. */
const occ = (n: number) => n.toString(16).padStart(12, "0");

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
  // An explicit VERDICT line wins over a quoted or negated report line; otherwise the last report line does.
  eq("unit: VERDICT wins over a leading GATE line", readReport("GATE: none raised during this review.\n\nAll checks green.\n\nVERDICT: PASS")?.verdict, "PASS");
  eq("unit: VERDICT wins over the developer's quoted DONE line", readReport("DONE: 61cd56e8 was the developer's line.\n\nOne Medium finding.\n\nVERDICT: FINDINGS")?.verdict, "FINDINGS");
  eq("unit: without VERDICT, the last report line is the session's own", readReport("DONE: 61cd56e8 was the previous handoff.\n\nGATE: Which account should the live check use?"), { verdict: "GATE", text: "Which account should the live check use?" });
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
  // Who raised a gate: only a session's own matching GATE report, made in this very gate occurrence. Never the
  // words alone, never timing, never being the one live session.
  const X = "0000000000a1";
  const Y = "0000000000a2";
  const cand = (id: string, o: Partial<Parameters<typeof gateOwner>[2][number]> = {}) => ({ id, name: id, session: "implementation", live: false, end: 2000, report: null, outcome: null, occurrence: null, ...o });
  const gate = (text: string, occurrence: string | null = X) => ({ text, occurrence });
  const asked = (text = "Q", occurrence: string | null = X) => ({ report: { verdict: "GATE", text }, outcome: "gate" as const, occurrence });
  eq("unit: same question ignores case, emphasis and closing punctuation", sameQuestion("**Which account** should we use?", "which account should we use"), true);
  eq("unit: a different question never matches, even as a prefix", sameQuestion("Which account should we use?", "Which account should we use (2)?"), false);
  eq("unit: a session whose own report raised this gate, in this occurrence, owns it", gateOwner("02.1", gate("Q?"), [cand("s1", asked())]).owner?.id, "s1");
  eq("unit: of two sessions that reported the same occurrence, the later one owns it", gateOwner("02.1", gate("Q?"), [cand("s1", { ...asked(), end: 3000 }), cand("s2", { ...asked("q."), end: 2000 })]).owner?.id, "s1");
  const lone = gateOwner("02.1", gate("Q?"), [cand("s1", { live: true, end: null })]);
  eq("unit: the one live session doesn't own a gate it never reported", lone.owner, null);
  check("…the diagnostic says no session reported it and the latest is still running", /reported this gate in its own GATE line.*still running and hasn't reported/.test(lone.diagnostic ?? ""), lone.diagnostic);
  eq("unit: a finished session that reported something else never owns it", gateOwner("02.1", gate("Q?"), [cand("s1", { report: { verdict: "DONE", text: "abc" }, outcome: "handed-off" })]).owner, null);
  eq("unit: an earlier gate session never owns a later gate", gateOwner("02.1", gate("Q2?"), [cand("s1", asked("Q1"))]).owner, null);
  eq("unit: a prefix of the question is not the question", gateOwner("02.1", gate("Q (2)?"), [cand("s1", asked())]).owner, null);
  // Occurrences: the identical question in another occurrence is another gate.
  const earlier = gateOwner("02.1", { text: "Q?", occurrence: Y, resolved: [X] }, [cand("s1", asked("Q", X))]);
  check("unit: a report made in an earlier occurrence never owns the identical question's next occurrence", earlier.owner === null && new RegExp(`earlier occurrence \\(${X}\\), which Pathfinder recorded resolved`).test(earlier.diagnostic ?? ""), earlier);
  const unseen = gateOwner("02.1", gate("Q?", Y), [cand("s1", asked("Q", null))]);
  check("unit: the same words with no occurrence behind them own nothing", unseen.owner === null && /reported the same question, but this kitchen didn't see this occurrence open while that session was running/.test(unseen.diagnostic ?? ""), unseen);
  eq("unit: a later session that reported this occurrence owns it, the earlier occurrence's doesn't", gateOwner("02.1", gate("Q?", Y), [cand("s1", { ...asked("Q", X), end: 9000 }), cand("s2", { ...asked("Q", Y), end: 5000 })]).owner?.id, "s2");
  const noId = gateOwner("02.1", gate("Q?", null), [cand("s1", asked("Q", X)), cand("s2", asked("Q", null))]);
  check("unit: a gate with no occurrence is never owned, whatever was reported", noId.owner === null && /no occurrence ID.*reported the same question, which doesn't show it raised this gate/.test(noId.diagnostic ?? ""), noId);
  check("unit: no session at all: unidentified, and it says so", /No session on 02\.1 was seen/.test(gateOwner("02.1", gate("Q?"), []).diagnostic ?? ""));
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
  // No board heading claims a review is underway for a ticket that is only waiting for one.
  for (const st of ["ready", "blocked", "working", "adversary", "review", "repair", "human-gate", "done", "stale", "failed", "integrated"])
    for (const live of [null, "review"]) {
      const view = tv(st, { liveSession: live });
      check(`unit: a ticket sits under "In review" only while under review (${st}, ${live ?? "no session"})`, COLUMN_LABEL[view.column] !== STAGE_LABEL.inReview || view.stage === "in-review");
    }
  eq("unit: the review column's heading covers waiting and underway", COLUMN_LABEL["in-review"], "Waiting / in review");
  eq("unit: an interrupted claim reads Interrupted", [ticketView({ state: "working", lastEnded: "interrupted" }).stage, ticketView({ state: "stale", recorded: "review", lastEnded: "interrupted" }).label], ["interrupted", "Interrupted"]);
  eq("unit: a live session is never Interrupted", ticketView({ state: "working", liveSession: "resume", lastEnded: "interrupted" }).stage, "in-progress");
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

// The sidebar's waiting, failed, interrupted and stale cards read the same words as the Boards card.
{
  const wl = boot(makeRepo("repo-labels"), "tt-labels");
  setRows(wl, [row("11.1", "review"), row("11.2", "adversary"), row("11.3", "stale", { recordedState: "repair" }), row("11.4", "failed"), row("11.5", "working"), row("11.6", "stale"), row("11.7", "stale", { recordedState: "review" })]);
  // 11.5's developer stopped without a report while its own stage was still recorded: interrupted.
  stateFile(wl, "11.5", { State: "working" });
  preAgent(wl, "tu_115", brief("11.5"), "11.5 developer");
  postAgent(wl, "tu_115", brief("11.5"), "a115");
  subStart(wl, "a115");
  writeSub(wl, "a115", { prompt: brief("11.5"), toolUseId: "tu_115" });
  subStop(wl, "a115");
  await refresh(wl);
  const g = buildGalley(wl.hub.snap);
  const pair = (key: string) => [g.tickets.find((x) => x.key === key)?.label ?? null, wl.hub.snap.tasks.find((x) => x.id === key)?.pf?.view?.label ?? null];
  for (const key of ["11.1", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7"]) {
    const [sidebar, board] = pair(key);
    check(`labels: ${key}'s sidebar card and Boards card say the same (${board})`, sidebar !== null && sidebar === board, { sidebar, board });
  }
  eq("labels: the shared words", ["11.1", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7"].map((k) => pair(k)[1]), ["Waiting for review", "Waiting for adversary review", "Waiting for repair", "Failed", "Interrupted", "Claimed · no live session", "Waiting for review"]);
  eq("labels: the sidebar's phases", ["11.1", "11.4", "11.5", "11.6"].map((k) => g.tickets.find((x) => x.key === k)?.phase), ["waiting", "failed", "interrupted", "stale"]);
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
  eq("restart: an unfinished transcript alone leaves liveness unknown", [workers(w3).get("alive")?.live, workers(w3).get("alive")?.ended], [false, null]);
  toolEvent(w3, "alive");
  await refresh(w3);
  eq("restart: a worker hook establishes live activity", workers(w3).get("alive")?.live, true);
  eq("restart: the transcript poll follows the same rule (waiting on workers)", coordinator(w3).state, "waiting");
}

// Review 5: minimized shapes from a0a704b754b9fea13 (02.1, final tool result) and
// af57c6f1742445342 (01.1, final api-request). Neither had finished metadata or a stop hook.
// No personal transcript contents are retained. These record shapes prove no ending or live process.
{
  const repo = makeRepo("repo-liveness");
  const w = boot(repo, "tt-liveness");
  coordinatorTurn(w, true);
  preAgent(w, "unrelated_pending", brief("09.1", "review", "tester"));
  for (const [id, key, last] of [
    ["a0a704b754b9fea13", "02.1", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "old_call", content: "done" }] } }],
    ["af57c6f1742445342", "01.1", { type: "api-request" }],
  ] as const) {
    writeSub(w, id, { prompt: brief(key), toolUseId: `tu_${id}` });
    appendFileSync(join(subDir(w), `agent-${id}.jsonl`), JSON.stringify(last) + "\n");
  }
  stopTurn(w);
  await refresh(w);
  for (const [id, key] of [["a0a704b754b9fea13", "02.1"], ["af57c6f1742445342", "01.1"]]) {
    const wk = workers(w).get(id)!;
    eq(`R5 ${key}: own identity, no invented live session or outcome`, [crewTicket(w, id), wk.live, wk.ended], [{ ticket: key, session: "implementation" }, false, null]);
    eq(`R5 ${key}: visible liveness is unknown`, w.hub.status(wk.hqId)?.session.state, "unknown");
    check(`R5 ${key}: no false success in galley`, buildGalley(w.hub.snap).crew.find((c) => c.id === wk.hqId)?.status === "session liveness unknown");
  }
  eq("R5: unknown workers never reach status --live", w.run.liveKeys(), []);
  check("R5: coordinator never waits on unobserved workers", coordinator(w).state !== "waiting");
  eq("R5: the unrelated review brief remains pending", pendingLaunches(w), ["unrelated_pending"]);
  await refresh(w);
  eq("R5: repeated reads do not become activity", w.run.liveKeys(), []);
  const touched = join(subDir(w), "agent-a0a704b754b9fea13.jsonl");
  utimesSync(touched, new Date(), new Date(Date.now() + 5000));
  await refresh(w);
  eq("R5: changing a file timestamp is not worker activity", w.run.liveKeys(), []);
  w.hub.setSession(COORDINATOR_ID, { state: "stopped" });
  await refresh(w);
  eq("R5: stopping the coordinator does not invent outcomes for unknown workers", [...workers(w).values()].map((x) => [x.live, x.ended]), [[false, null], [false, null]]);
  w.hub.setSession(COORDINATOR_ID, { state: "running" });
  toolEvent(w, "a0a704b754b9fea13");
  await refresh(w);
  eq("R5: fresh worker hook establishes liveness", w.run.liveKeys(), ["02.1"]);
  // No timeout: a quiet long tool call remains live while its known coordinator process runs.
  (w.run as unknown as { startedAt: number }).startedAt = 0;
  await refresh(w);
  eq("R5: a long tool call remains live without new transcript bytes", workers(w).get("a0a704b754b9fea13")?.live, true);
  appendFileSync(join(subDir(w), "agent-af57c6f1742445342.jsonl"), JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } }) + "\n");
  await refresh(w);
  eq("R5: observed transcript advancement establishes liveness", workers(w).get("af57c6f1742445342")?.live, true);
  appendFileSync(join(subDir(w), "agent-af57c6f1742445342.jsonl"), JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "PASS: verified" }] } }) + "\n");
  await refresh(w);
  eq("R5: terminal transcript ends a worker with no stop hook or finished metadata", [workers(w).get("af57c6f1742445342")?.live, workers(w).get("af57c6f1742445342")?.ended?.verdict], [false, "PASS"]);
  subStart(w, "af57c6f1742445342");
  await refresh(w);
  eq("R5: an old terminal transcript cannot stop a resumed worker", workers(w).get("af57c6f1742445342")?.live, true);
  postAgent(w, "tu_no_file", brief("03.1"), "hook_only");
  stateFile(w, "03.1", { State: "done", Last: "DONE: some later session" });
  // An already observed running coordinator stopping is decisive even inside the attach grace.
  (w.run as unknown as { startedAt: number }).startedAt = Date.now();
  w.hub.setSession(COORDINATOR_ID, { state: "stopped" });
  await refresh(w);
  eq("R5: hook-only worker stops without borrowing a later ticket handoff", [workers(w).get("hook_only")?.live, workers(w).get("hook_only")?.ended?.outcome], [false, "interrupted"]);
  eq("R5: resumed worker cannot hand off from its previous turn's report", workers(w).get("af57c6f1742445342")?.ended?.outcome, "interrupted");
  eq("R5: known workers leave --live when the coordinator process stops", w.run.liveKeys(), []);
  eq("R5: the unfinished worker has no fabricated success", workers(w).get("a0a704b754b9fea13")?.ended?.outcome, "interrupted");
  const restarted = boot(repo, "tt-liveness");
  stopTurn(restarted);
  await refresh(restarted);
  eq("R5: restart does not resurrect the old unfinished worker", workers(restarted).get("a0a704b754b9fea13")?.live, false);
  check("R5: restart never waits on old worker artifacts", coordinator(restarted).state !== "waiting");
}

// Review 6: resumed turns must not reuse a prior PASS, and fresh evidence recovers a missed start.
for (const mode of ["start", "transcript", "hook", "both"] as const) {
  const w = boot(makeRepo(`repo-r6-${mode}`), `tt-r6-${mode}`);
  const id = `r6-${mode}`;
  const file = join(subDir(w), `agent-${id}.jsonl`);
  coordinatorTurn(w, true);
  stopTurn(w);
  writeSub(w, id, { prompt: brief("06.1", "review", "tester"), report: "PASS: old review", toolUseId: "old-launch", finished: true });
  await refresh(w);
  eq(`R6 ${mode}: prior turn keeps its real PASS`, [workers(w).get(id)?.live, workers(w).get(id)?.ended?.result], [false, "old review"]);
  const oldEnd = JSON.stringify(workers(w).get(id)?.ended);
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await refresh(w);
  eq(`R6 ${mode}: timestamp-only change keeps history ended`, [workers(w).get(id)?.live, JSON.stringify(workers(w).get(id)?.ended)], [false, oldEnd]);
  hook(w, "PreToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "toolu_x", tool_input: {} });
  hook(w, "PostToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "toolu_x", tool_response: {} });
  await refresh(w);
  eq(`R6 ${mode}: old tool-hook replay does not revive history`, [workers(w).get(id)?.live, JSON.stringify(workers(w).get(id)?.ended)], [false, oldEnd]);
  eq(`R6 ${mode}: replayed hooks leave the old status idle`, w.hub.status(workers(w).get(id)!.hqId)?.state, "idle");
  if (mode === "start") subStart(w, id);
  if (mode !== "hook") {
    appendFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "Review the new repair" } }) + "\n");
    appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id: "new-tool", input: { command: "pnpm typecheck" } }] } }) + "\n");
  }
  if (mode === "start" || mode === "both" || mode === "hook") {
    hook(w, "PostToolUse", { agent_id: id, tool_name: "Bash", tool_use_id: "new-tool", tool_response: {} });
  }
  await refresh(w);
  eq(`R6 ${mode}: fresh activity recovers only this worker with no prior outcome`, [crewTicket(w, id), workers(w).get(id)?.live, workers(w).get(id)?.ended, w.run.liveKeys(), coordinator(w).state], [{ ticket: "06.1", session: "review" }, true, null, ["06.1"], "waiting"]);
  if (mode === "hook") {
    // The start and the new user prompt were both missed; a new tool call still starts current work.
    appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id: "new-tool", input: {} }] } }) + "\n");
    await refresh(w);
  }
  w.hub.setSession(COORDINATOR_ID, { state: "stopped" });
  await refresh(w);
  eq(`R6 ${mode}: progressed resume interrupted without inheriting PASS`, [workers(w).get(id)?.live, workers(w).get(id)?.ended?.outcome, workers(w).get(id)?.ended?.verdict ?? null, workers(w).get(id)?.ended?.result], [false, "interrupted", null, null]);
  // A current report may reach disk before its own hook. Recovery must not treat it as the old turn.
  w.hub.setSession(COORDINATOR_ID, { state: "running" });
  appendFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "Finish the current review" } }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "SubagentHandback", id: "current-report", input: { message: "PASS: current review verified" } }] } }) + "\n");
  hook(w, "PostToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "current-report", tool_response: {} });
  await refresh(w);
  eq(`R6 ${mode}: a new report already on disk is preserved`, [workers(w).get(id)?.live, workers(w).get(id)?.ended?.verdict, workers(w).get(id)?.ended?.result], [false, "PASS", "current review verified"]);
  const currentEnd = JSON.stringify(workers(w).get(id)?.ended);
  hook(w, "PreToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "current-report", tool_input: {} });
  hook(w, "PostToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "current-report", tool_response: {} });
  await refresh(w);
  eq(`R6 ${mode}: repeating the completed turn's hook preserves its history`, [workers(w).get(id)?.live, JSON.stringify(workers(w).get(id)?.ended)], [false, currentEnd]);
  eq(`R6 ${mode}: a repeated completed hook cannot show working`, w.hub.status(workers(w).get(id)!.hqId)?.state, "idle");
}

// Review 7: a complete resumed turn may be polled before its delayed hook, or receive no hooks.
for (const ending of ["handback", "end-turn"] as const) for (const order of ["poll-first", "hook-first", "no-hooks"] as const) {
  const label = `R7 ${ending}/${order}`;
  const w = boot(makeRepo(`repo-r7-${ending}-${order}`), `tt-r7-${ending}-${order}`);
  (w.run as unknown as { queueRefresh(ms: number): void }).queueRefresh = () => {};
  const id = "resumed-review";
  coordinatorTurn(w, true);
  stopTurn(w);
  writeSub(w, id, { prompt: brief("06.1", "review", "tester"), report: "PASS: previous review", toolUseId: "old-launch", finished: true });
  await refresh(w);
  const file = join(subDir(w), `agent-${id}.jsonl`);
  const oldEnd = JSON.stringify(workers(w).get(id)?.ended);
  // Appended bookkeeping changes bytes, but contains no new turn or terminal evidence.
  appendFileSync(file, JSON.stringify({ type: "progress", data: "bookkeeping" }) + "\n");
  await refresh(w);
  eq(`${label}: bookkeeping preserves old history`, [workers(w).get(id)?.live, JSON.stringify(workers(w).get(id)?.ended)], [false, oldEnd]);
  appendFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "Review the new repair" } }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "assistant", message: ending === "handback"
    ? { content: [{ type: "tool_use", name: "SubagentHandback", id: "new-report", input: { message: "FINDINGS: current regression" } }] }
    : { stop_reason: "end_turn", content: [{ type: "text", text: "FINDINGS: current regression" }] } }) + "\n");
  const reportHook = () => hook(w, "PostToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "new-report", tool_response: {} });
  if (order === "hook-first") reportHook();
  await refresh(w);
  const expected = [false, "FINDINGS", "current regression", "idle", []];
  const snapshot = () => [workers(w).get(id)?.live, workers(w).get(id)?.ended?.verdict, workers(w).get(id)?.ended?.result, w.hub.status(workers(w).get(id)!.hqId)?.state, w.run.liveKeys()];
  eq(`${label}: first poll keeps the current terminal outcome`, snapshot(), expected);
  // end_turn has no report tool hook; a delayed prior tool hook is modelled only for actual tool reports.
  if (order === "poll-first" && ending === "handback") reportHook();
  await refresh(w);
  await refresh(w);
  eq(`${label}: delayed hook and repeated polls cannot revive completion`, snapshot(), expected);
  check(`${label}: coordinator is not waiting for the finished worker`, coordinator(w).state !== "waiting");
  const currentEnd = JSON.stringify(workers(w).get(id)?.ended);
  appendFileSync(file, JSON.stringify({ type: "progress", data: "later bookkeeping" }) + "\n");
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await refresh(w);
  eq(`${label}: unrelated bytes and timestamp preserve current history`, JSON.stringify(workers(w).get(id)?.ended), currentEnd);
  if (ending === "handback") {
    hook(w, "PreToolUse", { agent_id: id, tool_name: "SubagentHandback", tool_use_id: "new-report", tool_input: {} });
    reportHook();
  }
  subStop(w, id, "FINDINGS: current regression");
  await refresh(w);
  eq(`${label}: delayed stop and replay preserve the settled history`, [snapshot(), JSON.stringify(workers(w).get(id)?.ended)], [expected, currentEnd]);
  // Repeated identical text in a genuinely new turn is still new terminal evidence (no unique UUID needed).
  appendFileSync(file, JSON.stringify({ type: "user", message: { content: "Review again" } }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "FINDINGS: current regression" }] } }) + "\n");
  await refresh(w);
  eq(`${label}: another completed turn preserves its own verdict`, snapshot(), expected);
  check(`${label}: repeated report text settles the new turn`, JSON.stringify(workers(w).get(id)?.ended) !== currentEnd);
  w.run.stop();
}

// ================================================================ Action items: truthful, answerable, exactly once

{
  const wa = boot(makeRepo("repo-actions"), "tt-actions");
  const gateItem = (key: string) => (wa.hub.snap.actionItems ?? []).find((i) => i.id === `gate-${key}`)!;
  const at = (ms = 0) => new Date(Date.now() + ms).toISOString();
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
  // 02.1's gate is recorded while ag1 is the one session live on it (no report yet); 03.1's after its only session ended.
  stateFile(wa, "02.1", { State: "human-gate", Gate: "Which account should the live check use?", "Gate-Id": occ(0x21), "Gate stage": "implementation", Updated: at() });
  stateFile(wa, "03.1", { State: "human-gate", Gate: "Approve the copy change?", "Gate-Id": occ(0x31), Updated: at(5_000) });
  setRows(wa, [row("02.1", "human-gate", { gate: "Which account should the live check use?" }), row("03.1", "human-gate", { gate: "Approve the copy change?" })]);
  coordinatorTurn(wa, true);
  stopTurn(wa);
  await refresh(wa);
  const g1 = gateItem("02.1");
  // Being the one live session is not evidence: until a session's own report raises it, the gate is unidentified.
  eq("pending decision: its own ticket and stage; no session credited without its own report", [g1.request?.key, g1.request?.stage, g1.request?.session, g1.request?.owner, g1.fromId], ["02.1", "implementation", null, null, COORDINATOR_ID]);
  check("…unidentified, and it says why", /No session on 02\.1 reported this gate.*still running/.test(g1.request?.diagnostic ?? ""), g1.request?.diagnostic);
  eq("pending decision: the question is Pathfinder's gate, verbatim", g1.details, "Which account should the live check use?");
  eq("pending decision: the request is Pathfinder's gate occurrence", [g1.request?.occurrence, g1.request?.revision], [occ(0x21), `02.1#${occ(0x21)}`]);
  const g3 = gateItem("03.1");
  eq("a historical session never inherits a later gate", [g3.request?.owner, g3.fromId], [null, COORDINATOR_ID]);
  check("…and the request says it can't identify the session, and why", /No session on 03\.1 reported this gate.*ended handed-off/.test(g3.request?.diagnostic ?? ""), g3.request?.diagnostic);
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
  check("the answer to an unidentified gate goes through the coordinator, naming the ticket and no session", wa.typed[0].includes("02.1 gate") && wa.typed[0].includes("raised by an unidentified session") && !wa.typed[0].includes(wa.hub.name(workers(wa).get("ag1")!.hqId)), wa.typed[0]);
  check("the answer names the gate occurrence it is for", wa.typed[0].includes(`gate occurrence ${occ(0x21)}`), wa.typed[0]);
  eq("the answer shows Sending → Delivered", states, ["sending", "delivered"]);
  eq("delivered is not resolved: the gate stays open until Pathfinder records it", gateItem("02.1").status, "open");
  eq("delivered: no longer counted as Needs you", counted().items, []);
  await wa.run.answerGate("gate-02.1", "Use the work account", g1.request!.revision);
  eq("a third send after delivery is refused", wa.typed.length, 1);

  // A reconnect: refreshing (or a browser reconnecting to the same snapshot) changes nothing.
  await refresh(wa);
  await refresh(wa);
  eq("reconnect: the answer and its state are kept, nothing re-sent", [gateItem("02.1").answer?.state, wa.typed.length], ["delivered", 1]);

  // A superseded request: Pathfinder recorded a new gate (a new text is a new occurrence); an answer to the old one is rejected.
  stateFile(wa, "03.1", { State: "human-gate", Gate: "Approve the revised copy change?", "Gate-Id": occ(0x32) });
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

  // A finished worker whose own report raised the gate, in the occurrence it saw open while it ran, still owns it;
  // the coordinator's ended turn with live workers waits.
  stateFile(wa, "02.1", { State: "human-gate", Gate: "Which account should the live check use (2)?", "Gate-Id": occ(0x22), "Gate stage": "implementation", Updated: at() });
  toolEvent(wa, "ag1");
  writeSub(wa, "ag1", { prompt: brief("02.1"), report: "GATE: Which account should the live check use (2)?" });
  subStop(wa, "ag1");
  setRows(wa, [row("02.1", "human-gate", { gate: "Which account should the live check use (2)?" }), row("03.1", "integrated", { lifecycle: "Complete" })]);
  await refresh(wa);
  eq("matching report: a finished worker's own gate keeps its identity", gateItem("02.1").request?.owner, workers(wa).get("ag1")?.hqId);
  // A new gate recorded later, with no new session: never credited to the session that stopped at the old one.
  stateFile(wa, "02.1", { State: "human-gate", Gate: "Which branch should the fix go on?", "Gate-Id": occ(0x23), "Gate stage": "implementation", Updated: at(5_000) });
  setRows(wa, [row("02.1", "human-gate", { gate: "Which branch should the fix go on?" }), row("03.1", "integrated", { lifecycle: "Complete" })]);
  await refresh(wa);
  eq("a later gate with no new session is not credited to the old gate session", [gateItem("02.1").request?.owner, gateItem("02.1").fromId], [null, COORDINATOR_ID]);
  check("…it is unidentified, and the diagnostic names the different gate", /ended gate at a different gate/.test(gateItem("02.1").request?.diagnostic ?? ""), gateItem("02.1").request?.diagnostic);
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

// ================================================================ a resume dispatched while a gate is open

{
  const wr = boot(makeRepo("repo-resume"), "tt-resume");
  const gateItem = (key: string) => (wr.hub.snap.actionItems ?? []).find((i) => i.id === `gate-${key}`)!;
  const q = "Approve the second account for the live check?";
  // The gate was recorded before this kitchen saw any session on the ticket.
  stateFile(wr, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x41), Updated: new Date(Date.now() - 60_000).toISOString() });
  setRows(wr, [row("02.1", "human-gate", { gate: q })]);
  preAgent(wr, "tu_r1", brief("02.1", "resume"), "02.1 resume");
  postAgent(wr, "tu_r1", brief("02.1", "resume"), "ar1");
  subStart(wr, "ar1");
  await refresh(wr);
  eq("resume dispatched while a gate is open: not its owner", [gateItem("02.1").request?.owner, gateItem("02.1").request?.session], [null, null]);
  check("…the diagnostic says no session reported it", /No session on 02\.1 reported this gate.*still running and hasn't reported/.test(gateItem("02.1").request?.diagnostic ?? ""), gateItem("02.1").request?.diagnostic);
  // The resume loads the ticket and rewrites Updated while the same gate stays open: still not its gate.
  stateFile(wr, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x41), Updated: new Date().toISOString() });
  await refresh(wr);
  eq("a rewritten Updated doesn't credit the resume", gateItem("02.1").request?.owner, null);
  // Its own report raises that gate, in the occurrence it saw open while it ran: now it is the owner.
  writeSub(wr, "ar1", { prompt: brief("02.1", "resume"), toolUseId: "tu_r1", report: `GATE: ${q}` });
  subStop(wr, "ar1");
  await refresh(wr);
  eq("…unless its own report raised that gate", [gateItem("02.1").request?.owner, gateItem("02.1").request?.session], [workers(wr).get("ar1")?.hqId, "resume"]);
}

// ================================================================ review 2 M1: no credit from timing or from being the one live worker

{
  // Each reported failure: owner null, an "Unable to identify session" diagnostic, and the ticket, the question and
  // the coordinator-mediated answer path intact.
  const unidentified = (w: World, key: string, q: string, label: string) => {
    const it = (w.hub.snap.actionItems ?? []).find((i) => i.id === `gate-${key}`);
    eq(`${label}: owner is null, from the coordinator`, [it?.request ? it.request.owner : "missing", it?.request ? it.request.session : "missing", it?.fromId], [null, null, COORDINATOR_ID]);
    eq(`${label}: the ticket and the question are kept`, [it?.request?.key, it?.details, it?.status], [key, q, "open"]);
    check(`${label}: the diagnostic says why`, new RegExp(`No session on ${key.replace(".", "\\.")} reported this gate`).test(it?.request?.diagnostic ?? ""), it?.request?.diagnostic);
    return it!;
  };

  // 1. A kitchen restart after a resume (dispatched while the gate was open) rewrote `Updated` via /ticket load.
  {
    const repo = makeRepo("repo-m1-restart");
    const w = boot(repo, "tt-m1-restart");
    const q = "Approve the second account for the live check?";
    stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x51), Updated: new Date(Date.now() - 120_000).toISOString() });
    setRows(w, [row("02.1", "human-gate", { gate: q })]);
    preAgent(w, "tu_r1", brief("02.1", "resume"), "02.1 resume");
    postAgent(w, "tu_r1", brief("02.1", "resume"), "ar1");
    writeSub(w, "ar1", { prompt: brief("02.1", "resume"), toolUseId: "tu_r1" });
    subStart(w, "ar1");
    await refresh(w);
    stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x51), Updated: new Date().toISOString() });
    await refresh(w);
    unidentified(w, "02.1", q, "M1 restart: before the restart, Updated rewritten");
    const w2 = boot(repo, "tt-m1-restart", w.rows);
    await refresh(w2);
    eq("M1 restart: the resume has no observed activity yet", workers(w2).get("ar1")?.live, false);
    unidentified(w2, "02.1", q, "M1 restart: after the restart, the resume isn't credited");
    // The answer path still works for it: typed into the coordinator, naming no session.
    const it = (w2.hub.snap.actionItems ?? []).find((i) => i.id === "gate-02.1")!;
    await w2.run.answerGate("gate-02.1", "Yes, use it", it.request!.revision);
    eq("M1 restart: Send answer reaches the coordinator", [it.answer?.state, w2.typed.length], ["delivered", 1]);
    check("M1 restart: …saying an unidentified session raised it", (w2.typed[0] ?? "").includes("02.1 gate") && (w2.typed[0] ?? "").includes("raised by an unidentified session"), w2.typed[0]);
  }

  // 2. The same question raised again later on the same ticket, after the original session finished.
  {
    const w = boot(makeRepo("repo-m1-repeat"), "tt-m1-repeat");
    const q = "Repair budget exhausted: accept, repair again, or drop?";
    preAgent(w, "tu_1", brief("02.1"), "02.1 dev");
    postAgent(w, "tu_1", brief("02.1"), "a1");
    writeSub(w, "a1", { prompt: brief("02.1"), toolUseId: "tu_1" });
    subStart(w, "a1");
    stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x61), Updated: new Date().toISOString() });
    setRows(w, [row("02.1", "human-gate", { gate: q })]);
    await refresh(w);
    unidentified(w, "02.1", q, "M1 repeat: first raise while a1 is live and hasn't reported");
    writeSub(w, "a1", { prompt: brief("02.1"), toolUseId: "tu_1", report: "DONE: abc", finished: true });
    subStop(w, "a1");
    stateFile(w, "02.1", { State: "working", Updated: new Date().toISOString() });
    setRows(w, [row("02.1", "working")]);
    await refresh(w);
    preAgent(w, "tu_2", brief("02.1", "review", "tester"), "02.1 review");
    postAgent(w, "tu_2", brief("02.1", "review", "tester"), "a2");
    writeSub(w, "a2", { prompt: brief("02.1", "review", "tester"), toolUseId: "tu_2" });
    subStart(w, "a2");
    writeSub(w, "a2", { prompt: brief("02.1", "review", "tester"), toolUseId: "tu_2", report: "VERDICT: FINDINGS", finished: true });
    subStop(w, "a2");
    stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x62), Updated: new Date().toISOString() });
    setRows(w, [row("02.1", "human-gate", { gate: q })]);
    await refresh(w);
    const it = unidentified(w, "02.1", q, "M1 repeat: the same question raised again later");
    check("M1 repeat: the old finished session isn't credited", it.request?.owner !== workers(w).get("a1")?.hqId && /ended handed-off/.test(it.request?.diagnostic ?? ""), it.request);
  }

  // 3. A gate the coordinator records while exactly one worker on that ticket is live.
  {
    const w = boot(makeRepo("repo-m1-coord"), "tt-m1-coord");
    stateFile(w, "02.1", { State: "working", Updated: new Date(Date.now() - 30_000).toISOString() });
    setRows(w, [row("02.1", "working")]);
    preAgent(w, "tu_d", brief("02.1"), "02.1 dev");
    postAgent(w, "tu_d", brief("02.1"), "ad");
    writeSub(w, "ad", { prompt: brief("02.1"), toolUseId: "tu_d" });
    subStart(w, "ad");
    await refresh(w);
    const q = "Coordinator: 02.1 conflicts with 05.1 on server/pathfinder.ts; serialize?";
    stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x71), Updated: new Date().toISOString() });
    setRows(w, [row("02.1", "human-gate", { gate: q })]);
    await refresh(w);
    eq("M1 coordinator gate: the one live worker is still live", workers(w).get("ad")?.live, true);
    unidentified(w, "02.1", q, "M1 coordinator gate: the one live worker isn't credited");
    // The matching-report case is still credited: once the worker, still running while this occurrence is open,
    // raises this question in its own report, it owns it.
    toolEvent(w, "ad");
    writeSub(w, "ad", { prompt: brief("02.1"), toolUseId: "tu_d", report: `GATE: **${q.toLowerCase()}**`, finished: true });
    subStop(w, "ad");
    await refresh(w);
    const it = (w.hub.snap.actionItems ?? []).find((i) => i.id === "gate-02.1")!;
    eq("M1 matching report: the worker whose own GATE line states this question owns it", [it.request?.owner, it.request?.session, it.request?.diagnostic, it.fromId], [workers(w).get("ad")?.hqId, "implementation", null, workers(w).get("ad")?.hqId]);
  }
}

// ================================================================ review 3: a report counts only for the gate occurrence it was made in

{
  // Session A raises Q in its own GATE report, in occurrence X → the human answers and Pathfinder records X resolved
  // → another session runs → the identical Q is raised again, as occurrence Y → restart. A is credited for X only.
  const repo = makeRepo("repo-r3-consumed");
  const w = boot(repo, "tt-r3-consumed");
  const q = "Repair budget exhausted: accept, repair again, or drop?";
  const [X, Y, Z] = [occ(0x81), occ(0x82), occ(0x83)];
  const gateItem = (x: World) => (x.hub.snap.actionItems ?? []).find((i) => i.id === "gate-02.1");
  preAgent(w, "tu_a", brief("02.1"), "02.1 dev");
  postAgent(w, "tu_a", brief("02.1"), "aA");
  writeSub(w, "aA", { prompt: brief("02.1"), toolUseId: "tu_a" });
  subStart(w, "aA");
  stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": X, Updated: new Date().toISOString() });
  setRows(w, [row("02.1", "human-gate", { gate: q })]);
  toolEvent(w, "aA");
  writeSub(w, "aA", { prompt: brief("02.1"), toolUseId: "tu_a", report: `GATE: ${q}`, finished: true });
  subStop(w, "aA");
  await refresh(w);
  const aHq = workers(w).get("aA")?.hqId;
  const first = gateItem(w)!;
  eq("R3: A's own GATE report, made in this occurrence, owns the open gate", [first.request?.owner, first.request?.diagnostic, first.request?.occurrence], [aHq, null, X]);
  await w.run.answerGate("gate-02.1", "repair again", first.request!.revision);
  stateFile(w, "02.1", { State: "working", Updated: new Date().toISOString() });
  setRows(w, [row("02.1", "working")]);
  await refresh(w);
  eq("R3: the answer is Recorded once Pathfinder shows Q resolved", [first.status, first.answer?.state], ["done", "recorded"]);
  const book = () => JSON.parse(readFileSync(join(tmp, ".controlroom", "tt-r3-consumed", "sessions.json"), "utf8")) as Record<string, { occurrence?: string }>;
  eq("R3: A's report is kept with the occurrence it was made in", book().aA?.occurrence, X);
  // Another session runs and finishes; then the coordinator raises the identical question: a new occurrence.
  preAgent(w, "tu_b", brief("02.1"), "02.1 dev 2");
  postAgent(w, "tu_b", brief("02.1"), "aB");
  writeSub(w, "aB", { prompt: brief("02.1"), toolUseId: "tu_b" });
  subStart(w, "aB");
  writeSub(w, "aB", { prompt: brief("02.1"), toolUseId: "tu_b", report: "DONE: def", finished: true });
  subStop(w, "aB");
  stateFile(w, "02.1", { State: "human-gate", Gate: q, "Gate-Id": Y, Updated: new Date().toISOString() });
  setRows(w, [row("02.1", "human-gate", { gate: q })]);
  await refresh(w);
  const again = gateItem(w)!;
  check("R3: a new request opens for the identical question", again !== first && again.status === "open" && again.answer === null && again.request?.occurrence === Y, again);
  eq("R3: before the restart, A isn't credited for the new gate", [again.request?.owner, again.request?.session, again.fromId], [null, null, COORDINATOR_ID]);
  check("R3: …and the diagnostic says its report was for the earlier occurrence", new RegExp(`asked the same question in an earlier occurrence \\(${X}\\)`).test(again.request?.diagnostic ?? ""), again.request?.diagnostic);
  // A is resumed under the same subagent id while Y is open, and stops with its old report still the last one in
  // its transcript: that report stays X's, it is never moved to the occurrence open now.
  subStart(w, "aA");
  toolEvent(w, "aA");
  subStop(w, "aA");
  await refresh(w);
  eq("R3: A resumed and stopped on its old report: the report stays the earlier occurrence's", [book().aA?.occurrence, gateItem(w)?.request?.owner], [X, null]);
  // Restart: the kitchen rebuilds every session from transcripts and sessions.json.
  const w2 = boot(repo, "tt-r3-consumed", w.rows);
  await refresh(w2);
  const after = gateItem(w2)!;
  eq("R3: after the restart, A is rebuilt finished at its gate", [workers(w2).get("aA")?.live, workers(w2).get("aA")?.ended?.outcome], [false, "gate"]);
  eq("R3: after the restart, A still isn't credited for the new gate", [after.request?.owner, after.request?.session, after.fromId], [null, null, COORDINATOR_ID]);
  check("R3: after the restart, the diagnostic still says why", new RegExp(`earlier occurrence \\(${X}\\)`).test(after.request?.diagnostic ?? ""), after.request?.diagnostic);
  eq("R3: the ticket and the question are kept", [after.request?.key, after.details, after.status], ["02.1", q, "open"]);
  await w2.run.answerGate("gate-02.1", "drop it", after.request!.revision);
  eq("R3: Send answer still reaches the coordinator", [after.answer?.state, w2.typed.length], ["delivered", 1]);
  check("R3: …saying an unidentified session raised it", (w2.typed[0] ?? "").includes("raised by an unidentified session"), w2.typed[0]);
  // A new session that raises Q in its own report while this occurrence is open is credited (the positive case holds).
  preAgent(w2, "tu_c", brief("02.1"), "02.1 dev 3");
  postAgent(w2, "tu_c", brief("02.1"), "aC");
  writeSub(w2, "aC", { prompt: brief("02.1"), toolUseId: "tu_c" });
  subStart(w2, "aC");
  writeSub(w2, "aC", { prompt: brief("02.1"), toolUseId: "tu_c", report: `GATE: ${q}`, finished: true });
  subStop(w2, "aC");
  await refresh(w2);
  eq("R3: a later session's own GATE report, made in this occurrence, is credited", [gateItem(w2)?.request?.owner, book().aC?.occurrence], [workers(w2).get("aC")?.hqId, Y]);
  eq("R3: crediting the session doesn't make it a new request or drop the answer", [gateItem(w2) === after, gateItem(w2)?.answer?.state], [true, "delivered"]);
  // Q replaced by a different question: a new occurrence, which the reports of the old one don't own.
  const q2 = "Accept the partial fix?";
  stateFile(w2, "02.1", { State: "human-gate", Gate: q2, "Gate-Id": Z, Updated: new Date().toISOString() });
  setRows(w2, [row("02.1", "human-gate", { gate: q2 })]);
  await refresh(w2);
  eq("R3: a replaced question is a new occurrence, which no earlier report owns", [gateItem(w2)?.request?.occurrence, gateItem(w2)?.request?.owner, book().aC?.occurrence], [Z, null, Y]);
}

// ================================================================ review 4: gate occurrences, from Pathfinder's durable record
//
// Everything below runs this repository's own engine (skills/orchestrate/engine) on throwaway local-Markdown
// projects with real claims. The engine writes the state files and the gate notes; the kitchen only reads them.

const ENGINE_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "orchestrate", "engine", "bin", "orchestrate.mjs");
// Git with no configuration but this: an empty global file (the same on every OS), and a fixed identity.
const EMPTY_GITCONFIG = join(tmp, "empty.gitconfig");
writeFileSync(EMPTY_GITCONFIG, "");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG };
type EngineRepo = { root: string; coord: string; engine: string; real: true };

const engineRun = (repo: EngineRepo, ...args: string[]) => spawnSync(process.execPath, [ENGINE_BIN, ...args, "--root", repo.root], { cwd: repo.root, env: GIT_ENV, encoding: "utf8" });
function engine(repo: EngineRepo, ...args: string[]) {
  const r = engineRun(repo, ...args);
  if (r.status !== 0) throw new Error(`orchestrate ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r;
}

function makeEngineRepo(name: string, keys: string[]): EngineRepo {
  const root = join(tmp, name);
  mkdirSync(join(root, "context", "tickets"), { recursive: true });
  mkdirSync(join(root, "roles"), { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "--quiet", "--initial-branch=main");
  for (const role of ["planner", "orchestrator", "developer", "tester", "integrator"]) writeFileSync(join(root, "roles", `${role}.md`), `---\nname: ${role}\ndescription: ${role}\n---\n`);
  writeFileSync(join(root, ".gitignore"), "/context/current-ticket.md\n/.pathfinder/\n");
  writeFileSync(join(root, "context", "execution-mode.md"), "# Execution Mode\n\n<!-- pathfinder:execution-mode orchestrator -->\n");
  for (const key of keys)
    writeFileSync(join(root, "context", "tickets", `${key}-t.md`), `# Ticket ${key}\n\n## Status\n\nProposed\n\n## Parent Feature\n\n\`${key.split(".")[0]}-x.md\`\n\n## Blocked by\n\nNone\n\n## Goal\n\nSomething.\n\n## Notes / Decisions\n\n- Existing note.\n`);
  git("add", "-A");
  git("commit", "--quiet", "-m", "initial");
  const coord = join(tmp, `${name}-session.jsonl`);
  writeFileSync(coord, "");
  mkdirSync(join(coord.replace(/\.jsonl$/, ""), "subagents"), { recursive: true });
  const repo: EngineRepo = { root, coord, engine: ENGINE_BIN, real: true };
  for (const key of keys) engine(repo, "claim", key);
  return repo;
}

const claimDir = (repo: EngineRepo, key: string) => join(repo.root, ".pathfinder", "worktrees", key);
const statePath = (repo: EngineRepo, key: string) => join(claimDir(repo, key), "context", "current-ticket.md");
const ticketPath = (repo: EngineRepo, key: string) => join(claimDir(repo, key), "context", "tickets", `${key}-t.md`);
/** The open gate's occurrence, as the engine recorded it in the state file. */
const gateId = (repo: EngineRepo, key: string) => /^-\s*Gate-Id:\s*(\S+)\s*$/m.exec(readFileSync(statePath(repo, key), "utf8"))?.[1] ?? null;
const history = (repo: EngineRepo, key: string) => readGateHistory(claimDir(repo, key), key, null);
/** What Pathfinder's record holds for a ticket, byte for byte: the kitchen must never change it. */
const record = (repo: EngineRepo, key: string) => [readFileSync(statePath(repo, key), "utf8"), readFileSync(ticketPath(repo, key), "utf8")];
/** A worker sets its gate by hand, as its brief says: `State: human-gate` and `Gate: <question>`, and no Gate-Id. */
function handGate(repo: EngineRepo, key: string, question: string) {
  const text = readFileSync(statePath(repo, key), "utf8");
  const line = /^- State: working(\r?)$/m.exec(text);
  if (!line) throw new Error(`${key} isn't working: ${text}`);
  writeFileSync(statePath(repo, key), text.replace(line[0], `- State: human-gate${line[1]}\n- Gate: ${question}${line[1]}`));
}
/** A kitchen on an engine project. Only the refreshes a test asks for run, so each step reads the record once, in order. */
function kitchen(repo: EngineRepo, slug: string, saved?: unknown): World {
  const w = boot(repo, slug, [], saved);
  (w.run as unknown as { queueRefresh(ms: number): void }).queueRefresh = () => {};
  return w;
}
const item = (w: World, key: string) => (w.hub.snap.actionItems ?? []).find((i) => i.id === `gate-${key}`);
const gateItems = (w: World, key: string) => (w.hub.snap.actionItems ?? []).filter((i) => i.taskId === key && i.request);
const asked = (w: World, key: string) => w.hub.snap.activity.filter((e) => e.text.startsWith(`${key} needs your decision`)).length;
/** A worker session starts on `key` (its launch, its transcript, its SubagentStart). */
function launch(w: World, agentId: string, key: string, session = "implementation") {
  const p = brief(key, session);
  preAgent(w, `tu_${agentId}`, p, `${key} ${session}`);
  postAgent(w, `tu_${agentId}`, p, agentId);
  writeSub(w, agentId, { prompt: p, toolUseId: `tu_${agentId}` });
  subStart(w, agentId);
}
/** It stops with `report` as its last word (its transcript and its SubagentStop hook both carry it). */
function stopWith(w: World, agentId: string, key: string, report: string, session = "implementation") {
  writeSub(w, agentId, { prompt: brief(key, session), toolUseId: `tu_${agentId}`, report, finished: true });
  subStop(w, agentId, report);
}
/** A worker opens its own gate through the engine while it runs, then reports it and stops. */
function raiseThroughEngine(w: World, repo: EngineRepo, agentId: string, key: string, question: string) {
  engine(repo, "state", key, "--set", "human-gate", "--gate", question);
  toolEvent(w, agentId, `node skills/orchestrate/engine/bin/orchestrate.mjs state ${key} --set human-gate --gate "…"`);
  stopWith(w, agentId, key, `GATE: ${question}`);
  return gateId(repo, key)!;
}

// ---- 0. The durable record tells occurrences apart, and the kitchen reads it as the engine wrote it.
{
  const repo = makeEngineRepo("repo-r4-record", ["80.1", "80.2"]);
  const Q = "Authorize repair?";
  engine(repo, "gate", "80.1", "open", "--question", Q);
  const X = gateId(repo, "80.1");
  check("record: a new opening has an occurrence in the state file", isGateOccurrence(X), X);
  eq("record: the kitchen reads that occurrence from the ticket's notes", history(repo, "80.1"), { readable: true, opened: [X], resolved: [], unidentified: 0 });
  engine(repo, "gate", "80.1", "open", "--question", Q, "--now", "2027-01-01T00:00:00Z");
  eq("record: a retried opening reuses its occurrence and writes no second note", [gateId(repo, "80.1"), history(repo, "80.1").opened], [X, [X]]);
  engine(repo, "gate", "80.1", "resolve", "--answer", "yes");
  eq("record: a resolution names its exact occurrence, and the state file drops it", [gateId(repo, "80.1"), history(repo, "80.1").resolved], [null, [X]]);
  engine(repo, "gate", "80.1", "open", "--question", Q);
  const Y = gateId(repo, "80.1");
  check("record: the identical question opened again is a different occurrence", isGateOccurrence(Y) && Y !== X, [X, Y]);
  eq("record: both openings are in the history, only the first resolved", [history(repo, "80.1").opened, history(repo, "80.1").resolved], [[X, Y], [X]]);
  check("record: the two openings are two requests; a retry is the same one", gateRevision("80.1", Q, X) !== gateRevision("80.1", Q, Y) && gateRevision("80.1", Q, Y) === gateRevision("80.1", `${Q} `, Y));
  engine(repo, "state", "80.1", "--set", "working");
  eq("record: a gate closed by a state change is resolved under its occurrence too", history(repo, "80.1").resolved, [X, Y]);
  engine(repo, "state", "80.1", "--set", "human-gate", "--gate", Q);
  const Z = gateId(repo, "80.1");
  check("record: a gate opened through `state` has an occurrence of its own", isGateOccurrence(Z) && Z !== X && Z !== Y && history(repo, "80.1").opened.join() === [X, Y, Z].join(), [X, Y, Z]);
  // No identity: a gate set by hand, and notes written before occurrences existed. None is made up for them.
  handGate(repo, "80.2", Q);
  const old = ["<!-- pathfinder:orchestrate gate-opened 80.2 c1ce7ac69e62 -->", "<!-- pathfinder:orchestrate gate-resolved 80.2 c1ce7ac69e62 -->"];
  appendFileSync(ticketPath(repo, "80.2"), `\n${old[0]}\n**Human gate opened** on 2026-11-12.\n\n${old[1]}\n**Human gate resolved** on 2026-11-12.\n`);
  eq("record: a hand-set gate and old notes carry no occurrence", [gateId(repo, "80.2"), history(repo, "80.2")], [null, { readable: true, opened: [], resolved: [], unidentified: 2 }]);
  eq("record: an old marker parses with no occurrence, a new one with its own", [parseGateMarker(old[0])?.occurrence, parseGateMarker(`<!-- pathfinder:orchestrate gate-opened 80.1 c1ce7ac69e62 ${X} -->`)?.occurrence], [null, X]);
  eq("record: another ticket's notes are not this ticket's history", gateHistory(readFileSync(ticketPath(repo, "80.1"), "utf8"), "80.2"), { readable: true, opened: [], resolved: [], unidentified: 0 });
  check("record: without an occurrence a request is only its ticket and its text", gateRevision("80.2", Q, null) === gateRevision("80.2", Q, null) && gateRevision("80.2", Q, null) !== gateRevision("80.2", `${Q} (2)`, null) && gateRevision("80.2", Q, null) !== gateRevision("80.1", Q, null));
  eq("record: notes that aren't a file in the claim's worktree are unreadable, never empty", readGateHistory(join(repo.root, "nowhere"), "80.1", null).readable, false);
}

// ---- 1. The kitchen is offline while Q is resolved and the identical Q is raised again; then it restarts.
{
  const repo = makeEngineRepo("repo-r4-offline", ["70.1"]);
  const Q = "Repair budget exhausted: accept, repair again, or drop?";
  const w = kitchen(repo, "tt-r4-offline");
  launch(w, "aA", "70.1");
  const X = raiseThroughEngine(w, repo, "aA", "70.1", Q);
  await refresh(w);
  const aHq = workers(w).get("aA")!.hqId;
  const first = item(w, "70.1")!;
  eq("offline: A raised this occurrence while it ran, so A owns it", [first.request?.owner, first.request?.occurrence, first.request?.revision, first.request?.diagnostic], [aHq, X, `70.1#${X}`, null]);
  await w.run.answerGate("gate-70.1", "one more round", first.request!.revision);
  eq("offline: the answer for X is delivered", [first.answer?.state, w.typed.length], ["delivered", 1]);
  check("offline: …naming A and the occurrence", w.typed[0].includes(`gate occurrence ${X}`) && w.typed[0].includes(`raised by ${w.hub.name(aHq)}'s implementation session`), w.typed[0]);
  // A restart while X is still open: the same request, A still its owner, its answer kept, nothing sent again.
  const wx = kitchen(repo, "tt-r4-offline");
  await refresh(wx);
  eq("restart, same occurrence: the owner and the delivered answer are kept", [item(wx, "70.1")?.request?.owner, item(wx, "70.1")?.request?.occurrence, item(wx, "70.1")?.answer?.state], [workers(wx).get("aA")?.hqId, X, "delivered"]);
  await wx.run.answerGate("gate-70.1", "one more round", `70.1#${X}`);
  eq("restart, same occurrence: nothing is sent twice, and there is one request", [wx.typed.length, gateItems(wx, "70.1").length], [0, 1]);
  // The kitchen is down. Pathfinder records X resolved; the coordinator raises the identical question again.
  const saved = JSON.parse(JSON.stringify(w.hub.snap.actionItems));
  engine(repo, "gate", "70.1", "resolve", "--answer", "one more round");
  engine(repo, "gate", "70.1", "open", "--question", Q);
  const Y = gateId(repo, "70.1")!;
  eq("offline: Pathfinder's record holds X resolved and Y open", [Y !== X, history(repo, "70.1").opened, history(repo, "70.1").resolved], [true, [X, Y], [X]]);
  const before = record(repo, "70.1");
  // Restart, with the old request (X, answered) still on the kitchen's disk.
  const w2 = kitchen(repo, "tt-r4-offline", saved);
  await refresh(w2);
  const second = item(w2, "70.1")!;
  eq("offline: after the restart A is rebuilt finished at its gate", [workers(w2).get("aA")?.live, workers(w2).get("aA")?.ended?.outcome], [false, "gate"]);
  eq("offline: after the restart the old session isn't credited for the new occurrence", [second.request?.owner, second.request?.session, second.fromId, second.request?.occurrence], [null, null, COORDINATOR_ID, Y]);
  check("offline: …and the diagnostic says its report was for the resolved occurrence", new RegExp(`asked the same question in an earlier occurrence \\(${X}\\), which Pathfinder recorded resolved`).test(second.request?.diagnostic ?? ""), second.request?.diagnostic);
  eq("offline: the new request doesn't reuse the old one's answer", [second.answer, requestShelf(second), second.details, gateItems(w2, "70.1").length], [null, "actionable", Q, 1]);
  await w2.run.answerGate("gate-70.1", "one more round", `70.1#${X}`);
  eq("offline: an answer aimed at the superseded occurrence is rejected, nothing sent", [second.answer?.state, w2.typed.length, requestShelf(second)], ["rejected", 0, "actionable"]);
  await w2.run.answerGate("gate-70.1", "stop here");
  eq("offline: an answer that names no request is rejected, nothing sent", [second.answer?.state, w2.typed.length], ["rejected", 0]);
  await w2.run.answerGate("gate-70.1", "stop here", second.request!.revision);
  eq("offline: the new request is answerable", [second.answer?.state, w2.typed.length], ["delivered", 1]);
  check("offline: …naming the new occurrence and no session", w2.typed[0].includes(`gate occurrence ${Y}`) && w2.typed[0].includes("raised by an unidentified session") && !w2.typed[0].includes(X), w2.typed[0]);
  eq("offline: the kitchen changed nothing in Pathfinder's record", record(repo, "70.1"), before);
  // Restart again, with nothing saved but the kitchen's own gate-answers.json: the same result, no second request.
  const w3 = kitchen(repo, "tt-r4-offline");
  await refresh(w3);
  await refresh(w3);
  const third = item(w3, "70.1")!;
  eq("restart: the same occurrence, still unidentified, its delivered answer kept", [third.request?.occurrence, third.request?.owner, third.answer?.state, third.answer?.text, requestShelf(third)], [Y, null, "delivered", "stop here", "awaiting"]);
  await w3.run.answerGate("gate-70.1", "stop here", third.request!.revision);
  eq("restart: nothing is sent again, and there is one request", [w3.typed.length, gateItems(w3, "70.1").length], [0, 1]);
  // Pathfinder records the answer: the request closes as recorded, under the new occurrence only.
  engine(repo, "gate", "70.1", "resolve", "--answer", "stop here");
  await refresh(w3);
  eq("offline: Pathfinder records the new answer", [third.status, third.answer?.state, history(repo, "70.1").resolved], ["done", "recorded", [X, Y]]);
  const notes = readFileSync(ticketPath(repo, "70.1"), "utf8");
  const fromY = notes.slice(notes.indexOf(Y));
  eq("offline: no answer stays saved for an occurrence that is closed", JSON.parse(readFileSync(join(tmp, ".controlroom", "tt-r4-offline", "gate-answers.json"), "utf8")), {});
  check("offline: the old answer is recorded under X only, the new one under Y", notes.slice(0, notes.indexOf(Y)).includes("> one more round") && fromY.includes("> stop here") && !fromY.includes("one more round"), fromY);
}

// ---- 2. X is resolved and the identical Q raised again between two polls (no restart).
{
  const repo = makeEngineRepo("repo-r4-polls", ["70.2", "70.3", "70.8"]);
  const Q = "Repair budget exhausted: accept, repair again, or drop?";
  const w = kitchen(repo, "tt-r4-polls");
  launch(w, "aB", "70.2");
  const X = raiseThroughEngine(w, repo, "aB", "70.2", Q);
  await refresh(w);
  const first = item(w, "70.2")!;
  eq("between polls: B owns the occurrence it raised", [first.request?.owner, first.request?.occurrence], [workers(w).get("aB")?.hqId, X]);
  await w.run.answerGate("gate-70.2", "the old answer", first.request!.revision);
  eq("between polls: the answer for X is delivered", [first.answer?.state, w.typed.length], ["delivered", 1]);
  // Before the next poll: Pathfinder closes X and the coordinator raises the identical question again.
  engine(repo, "state", "70.2", "--set", "working");
  engine(repo, "gate", "70.2", "open", "--question", Q);
  const Y = gateId(repo, "70.2")!;
  eq("between polls: Pathfinder's record holds X resolved and Y open", [Y !== X, history(repo, "70.2").resolved], [true, [X]]);
  // The kitchen still shows X. An answer sent from that card is checked against the record first: nothing is typed.
  await w.run.answerGate("gate-70.2", "the old answer, again", first.request!.revision);
  eq("between polls: an answer from the stale card is refused, nothing sent", [w.typed.length, item(w, "70.2") === first], [1, true]);
  await refresh(w);
  const second = item(w, "70.2")!;
  eq("between polls: the next poll shows a new request for the new occurrence", [second !== first, second.request?.occurrence, second.status, gateItems(w, "70.2").length], [true, Y, "open", 1]);
  eq("between polls: the old session isn't credited for it", [second.request?.owner, second.request?.session, second.fromId], [null, null, COORDINATOR_ID]);
  check("between polls: …and the diagnostic says why", new RegExp(`earlier occurrence \\(${X}\\), which Pathfinder recorded resolved`).test(second.request?.diagnostic ?? ""), second.request?.diagnostic);
  eq("between polls: the old answer state isn't reused", [second.answer, requestShelf(second)], [null, "actionable"]);
  await w.run.answerGate("gate-70.2", "the old answer", `70.2#${X}`);
  eq("between polls: the old answer can't be sent to the new occurrence", [second.answer?.state, second.answer?.revision, w.typed.length, requestShelf(second)], ["rejected", `70.2#${X}`, 1, "actionable"]);
  await w.run.answerGate("gate-70.2", "the new answer", second.request!.revision);
  eq("between polls: the new occurrence is answered", [second.answer?.state, w.typed.length], ["delivered", 2]);
  check("between polls: …under its own occurrence", w.typed[1].includes(`gate occurrence ${Y}`) && w.typed[1].includes("the new answer"), w.typed[1]);
  // A late answer for X arriving after Y was answered doesn't disturb Y's answer.
  await w.run.answerGate("gate-70.2", "the old answer", `70.2#${X}`);
  eq("between polls: a late answer for X leaves Y's delivered answer alone", [second.answer?.state, second.answer?.text, w.typed.length], ["delivered", "the new answer", 2]);
  engine(repo, "gate", "70.2", "resolve", "--answer", "the new answer");
  await refresh(w);
  eq("between polls: Pathfinder records it under Y", [second.status, second.answer?.state, history(repo, "70.2").resolved], ["done", "recorded", [X, Y]]);
  check("between polls: the old answer was never recorded anywhere", !readFileSync(ticketPath(repo, "70.2"), "utf8").includes("the old answer"));

  // The same swap under a request nobody has answered yet: the answer typed into the stale card would otherwise
  // go to the coordinator and be recorded against the new occurrence.
  engine(repo, "gate", "70.8", "open", "--question", Q);
  const X8 = gateId(repo, "70.8")!;
  await refresh(w);
  const stale = item(w, "70.8")!;
  engine(repo, "state", "70.8", "--set", "working");
  engine(repo, "gate", "70.8", "open", "--question", Q);
  const Y8 = gateId(repo, "70.8")!;
  const typedBefore = w.typed.length;
  await w.run.answerGate("gate-70.8", "meant for the first one", stale.request!.revision);
  eq("stale card: the card still shows X, and its answer is rejected against the record, nothing sent", [stale.request?.occurrence, stale.answer?.state, w.typed.length - typedBefore], [X8, "rejected", 0]);
  check("stale card: …saying a new request replaced it", /closed this request and opened a new one on 70\.8/.test(stale.answer?.detail ?? ""), stale.answer?.detail);
  await refresh(w);
  eq("stale card: the next poll shows the new occurrence, unanswered", [item(w, "70.8") !== stale, item(w, "70.8")?.request?.occurrence, item(w, "70.8")?.answer, requestShelf(item(w, "70.8")!)], [true, Y8, null, "actionable"]);
  // The gate is closed in the record (no new one) before the poll: an answer for it is refused too.
  engine(repo, "state", "70.8", "--set", "working");
  await w.run.answerGate("gate-70.8", "too late", item(w, "70.8")!.request!.revision);
  eq("closed between polls: an answer for a gate the record no longer holds is rejected, nothing sent", [item(w, "70.8")?.answer?.state, /no longer open/.test(item(w, "70.8")?.answer?.detail ?? ""), w.typed.length - typedBefore], ["rejected", true, 0]);
  await refresh(w);
  eq("closed between polls: the request closes without a recorded answer", [item(w, "70.8")?.status, item(w, "70.8")?.answer?.state, history(repo, "70.8").resolved], ["done", "rejected", [X8, Y8]]);
  check("closed between polls: nothing typed in the kitchen reached Pathfinder's notes", !/meant for the first one|too late/.test(readFileSync(ticketPath(repo, "70.8"), "utf8")));

  // The session's stop hook is lost, and X is replaced by Y (the identical Q) before the poll that finds it
  // finished: its report can't be shown to be for Y, so it owns nothing.
  launch(w, "aL", "70.3");
  engine(repo, "state", "70.3", "--set", "human-gate", "--gate", Q);
  const X3 = gateId(repo, "70.3")!;
  toolEvent(w, "aL");
  writeSub(w, "aL", { prompt: brief("70.3"), toolUseId: "tu_aL", report: `GATE: ${Q}`, finished: true });
  engine(repo, "state", "70.3", "--set", "working");
  engine(repo, "gate", "70.3", "open", "--question", Q);
  const Y3 = gateId(repo, "70.3")!;
  await refresh(w);
  const lost = item(w, "70.3")!;
  eq("lost stop hook: the session is found finished at its gate", [workers(w).get("aL")?.live, workers(w).get("aL")?.ended?.verdict], [false, "GATE"]);
  eq("lost stop hook: its report isn't credited to the occurrence that replaced the one it saw", [X3 !== Y3, lost.request?.occurrence, lost.request?.owner], [true, Y3, null]);
  check("lost stop hook: …and the diagnostic says the occurrence wasn't seen open while it ran", /reported the same question, but this kitchen didn't see this occurrence open while that session was running/.test(lost.request?.diagnostic ?? ""), lost.request?.diagnostic);
}

// ---- 3. Duplicate retries of one opening; refresh, reconnect and restart keep one request and its result.
{
  const repo = makeEngineRepo("repo-r4-retry", ["70.4"]);
  const Q = "Review found issues after two repair rounds. How should this ticket proceed?";
  const w = kitchen(repo, "tt-r4-retry");
  engine(repo, "gate", "70.4", "open", "--question", Q);
  const X = gateId(repo, "70.4")!;
  await refresh(w);
  const first = item(w, "70.4")!;
  eq("retries: the opening is one request, raised by no session", [first.request?.occurrence, first.request?.owner, gateItems(w, "70.4").length, asked(w, "70.4")], [X, null, 1, 1]);
  await w.run.answerGate("gate-70.4", "one more repair round", first.request!.revision);
  const raisedAt = first.at;
  // The coordinator retries the same opening (a later clock, the label step repeated): the same occurrence.
  engine(repo, "gate", "70.4", "open", "--question", Q, "--now", "2027-01-01T00:00:00Z");
  await refresh(w);
  engine(repo, "gate", "70.4", "open", "--question", Q, "--now", "2027-02-01T00:00:00Z");
  engine(repo, "state", "70.4", "--set", "human-gate", "--gate", Q);
  await refresh(w);
  await refresh(w);
  eq("retries: Pathfinder kept one occurrence and one note", [gateId(repo, "70.4"), history(repo, "70.4").opened], [X, [X]]);
  eq("retries: still the same single request, asked once", [item(w, "70.4") === first, first.request?.revision, first.at === raisedAt, gateItems(w, "70.4").length, asked(w, "70.4")], [true, `70.4#${X}`, true, 1, 1]);
  eq("retries: its delivered answer is kept and wasn't sent again", [first.answer?.state, w.typed.length, requestShelf(first)], ["delivered", 1, "awaiting"]);
  await w.run.answerGate("gate-70.4", "one more repair round", first.request!.revision);
  eq("refresh: a repeated send for the same occurrence is refused", w.typed.length, 1);
  // Restart, once with the kitchen's saved action items and once without: the same request, the same result.
  for (const [label, saved] of [["with its saved items", JSON.parse(JSON.stringify(w.hub.snap.actionItems))], ["with no saved items", undefined]] as const) {
    const w2 = kitchen(repo, "tt-r4-retry", saved);
    await refresh(w2);
    await refresh(w2);
    const it = item(w2, "70.4")!;
    eq(`restart ${label}: one request for the same occurrence, its answer still delivered`, [it.request?.occurrence, it.answer?.state, it.answer?.text, gateItems(w2, "70.4").length, requestShelf(it)], [X, "delivered", "one more repair round", 1, "awaiting"]);
    await w2.run.answerGate("gate-70.4", "one more repair round", it.request!.revision);
    eq(`restart ${label}: nothing is sent again`, w2.typed.length, 0);
  }
}

// ---- 4. Records with no occurrence: owner unknown, the gate open now always answerable.
{
  const repo = makeEngineRepo("repo-r4-legacy", ["70.5"]);
  const Q = "Which account should the live check use?";
  const w = kitchen(repo, "tt-r4-legacy");
  // The ticket's notes hold an earlier gate with the same question, opened and resolved by a kit from before occurrences.
  appendFileSync(ticketPath(repo, "70.5"), `\n<!-- pathfinder:orchestrate gate-opened 70.5 3f1c0a9e72b4 -->\n**Human gate opened** on 2026-11-10.\n\n> ${Q}\n\n<!-- pathfinder:orchestrate gate-resolved 70.5 3f1c0a9e72b4 -->\n**Human gate resolved** on 2026-11-10.\n`);
  launch(w, "aD", "70.5");
  // The worker sets its gate by hand, as its brief says, and reports it: the state file holds no Gate-Id.
  handGate(repo, "70.5", Q);
  toolEvent(w, "aD");
  stopWith(w, "aD", "70.5", `GATE: ${Q}`);
  await refresh(w);
  const first = item(w, "70.5")!;
  eq("no occurrence: the record has none, and the kitchen makes none up", [gateId(repo, "70.5"), first.request?.occurrence, history(repo, "70.5").unidentified], [null, null, 2]);
  eq("no occurrence: the owner is unknown, even though a session reported these words", [first.request?.owner, first.request?.session, first.fromId, first.details, first.status], [null, null, COORDINATOR_ID, Q, "open"]);
  check("no occurrence: …and the diagnostic says why", new RegExp(`no occurrence ID.*${w.hub.name(workers(w).get("aD")!.hqId)} \\(implementation\\) reported the same question, which doesn't show it raised this gate`).test(first.request?.diagnostic ?? ""), first.request?.diagnostic);
  await w.run.answerGate("gate-70.5", "the work account", first.request!.revision);
  eq("no occurrence: the gate is answerable through the coordinator", [first.answer?.state, w.typed.length], ["delivered", 1]);
  check("no occurrence: …naming no session and no occurrence", w.typed[0].includes("70.5 gate") && w.typed[0].includes("raised by an unidentified session") && !w.typed[0].includes("gate occurrence"), w.typed[0]);
  await refresh(w);
  eq("no occurrence: a refresh keeps the one request and its answer", [item(w, "70.5") === first, first.answer?.state, gateItems(w, "70.5").length, asked(w, "70.5")], [true, "delivered", 1, 1]);
  // Nothing shows that the delivered answer was for the gate open now, so the gate can be answered again.
  await w.run.answerGate("gate-70.5", "the work account, please", first.request!.revision);
  eq("no occurrence: the gate open now stays answerable after an earlier answer", [first.answer?.state, first.answer?.text, w.typed.length], ["delivered", "the work account, please", 2]);
  // A restart with that request saved: it can't be shown to be the gate open now, so it is asked afresh.
  const w2 = kitchen(repo, "tt-r4-legacy", JSON.parse(JSON.stringify(w.hub.snap.actionItems)));
  await refresh(w2);
  const again = item(w2, "70.5")!;
  eq("no occurrence, restart: the saved answer isn't taken as this gate's", [again.answer, requestShelf(again), again.request?.owner, gateItems(w2, "70.5").length], [null, "actionable", null, 1]);
  await w2.run.answerGate("gate-70.5", "the work account", again.request!.revision);
  eq("no occurrence, restart: it is answerable", [again.answer?.state, w2.typed.length], ["delivered", 1]);
  // The coordinator now opens the gate through the engine: the record gives it an occurrence, after the session stopped.
  const before = record(repo, "70.5");
  engine(repo, "gate", "70.5", "open", "--question", Q);
  const X = gateId(repo, "70.5")!;
  check("first occurrence: the engine recorded one for the hand-set gate, and rewrote no old note", isGateOccurrence(X) && readFileSync(ticketPath(repo, "70.5"), "utf8").startsWith(before[1].trimEnd()) && history(repo, "70.5").unidentified === 2, X);
  await refresh(w);
  const opened = item(w, "70.5")!;
  eq("first occurrence: it is a new request, and the earlier answer isn't reused", [opened !== first, opened.request?.occurrence, opened.answer, requestShelf(opened), gateItems(w, "70.5").length], [true, X, null, "actionable", 1]);
  eq("first occurrence: a report made before the occurrence existed isn't credited to it", [opened.request?.owner, opened.request?.session], [null, null]);
  check("first occurrence: …and the diagnostic says the occurrence wasn't seen open while the session ran", /reported the same question, but this kitchen didn't see this occurrence open while that session was running/.test(opened.request?.diagnostic ?? ""), opened.request?.diagnostic);
  await w.run.answerGate("gate-70.5", "the work account", opened.request!.revision);
  eq("first occurrence: it is answerable, once", [opened.answer?.state, w.typed.length], ["delivered", 3]);
  await w.run.answerGate("gate-70.5", "the work account", opened.request!.revision);
  eq("first occurrence: …and not twice", w.typed.length, 3);

  // A session outcome saved by an earlier kitchen (no occurrence, the old `consumed` flag or none) credits nothing.
  const repo2 = makeRepo("repo-r4-oldbook");
  const q = "Approve the second account for the live check?";
  for (const id of ["aOld", "aSpent"]) writeSub({ coord: repo2.coord } as World, id, { prompt: brief("02.1"), toolUseId: `tu_${id}`, report: `GATE: ${q}`, finished: true });
  mkdirSync(join(tmp, ".controlroom", "tt-r4-oldbook"), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(tmp, ".controlroom", "tt-r4-oldbook", "coordinator.json"), JSON.stringify({ transcript: repo2.coord, at }));
  writeFileSync(join(tmp, ".controlroom", "tt-r4-oldbook", "sessions.json"), JSON.stringify({ aOld: { outcome: "gate", next: null, result: q, verdict: "GATE", at, key: "02.1", session: "implementation" }, aSpent: { outcome: "gate", next: null, result: q, verdict: "GATE", at, key: "02.1", session: "implementation", consumed: q } }));
  const wo = boot(repo2, "tt-r4-oldbook");
  stateFile(wo, "02.1", { State: "human-gate", Gate: q, "Gate-Id": occ(0x91) });
  setRows(wo, [row("02.1", "human-gate", { gate: q })]);
  await refresh(wo);
  eq("old sessions.json: both sessions are rebuilt at their gate", [workers(wo).get("aOld")?.ended?.verdict, workers(wo).get("aSpent")?.ended?.verdict], ["GATE", "GATE"]);
  eq("old sessions.json: a report saved with no occurrence owns no occurrence", [item(wo, "02.1")?.request?.owner, item(wo, "02.1")?.request?.occurrence], [null, occ(0x91)]);
}

// ---- 5. A state change the engine refuses writes nothing, and the kitchen keeps the same request and its answer.
{
  const repo = makeEngineRepo("repo-r4-invalid", ["70.6", "70.7"]);
  const Q = "Authorize the repair?";
  const w = kitchen(repo, "tt-r4-invalid");
  engine(repo, "gate", "70.6", "open", "--question", Q);
  const X = gateId(repo, "70.6")!;
  await refresh(w);
  const first = item(w, "70.6")!;
  await w.run.answerGate("gate-70.6", "yes, repair it", first.request!.revision);
  eq("invalid change: the answer is delivered for the open occurrence", [first.request?.occurrence, first.answer?.state, w.typed.length], [X, "delivered", 1]);
  const before = record(repo, "70.6");
  eq("invalid change: the engine refuses an unknown state and a blank value", [engineRun(repo, "state", "70.6", "--set", "wroking").status, engineRun(repo, "state", "70.6", "--set", "working", "--last", " ").status], [2, 2]);
  eq("invalid change: Pathfinder's record is byte-identical", record(repo, "70.6"), before);
  await refresh(w);
  await refresh(w);
  eq("invalid change: the kitchen shows the same request, its answer still delivered", [item(w, "70.6") === first, first.request?.revision, first.status, first.answer?.state, gateItems(w, "70.6").length, asked(w, "70.6")], [true, `70.6#${X}`, "open", "delivered", 1, 1]);
  await w.run.answerGate("gate-70.6", "yes, repair it", first.request!.revision);
  eq("invalid change: nothing is sent again, and the kitchen wrote nothing to the record", [w.typed.length, record(repo, "70.6")], [1, before]);
  // The human's answer, recorded afterwards, lands on that same occurrence.
  engine(repo, "gate", "70.6", "resolve", "--answer", "yes, repair it");
  await refresh(w);
  eq("invalid change: the later valid answer is recorded under the same occurrence", [first.status, first.answer?.state, history(repo, "70.6").resolved, gateId(repo, "70.6")], ["done", "recorded", [X], null]);
  check("invalid change: …with the decision in Pathfinder's note", readFileSync(ticketPath(repo, "70.6"), "utf8").includes("> yes, repair it"));

  // Pathfinder's history records an occurrence resolved before the state file drops it (a resolve stopped half
  // way). The history is the truth: the request isn't open, and an answer for it is refused.
  engine(repo, "gate", "70.7", "open", "--question", Q);
  const X7 = gateId(repo, "70.7")!;
  coordinatorTurn(w, true);
  stopTurn(w);
  await refresh(w);
  const open = item(w, "70.7")!;
  eq("half-resolved: the open occurrence needs the human", [open.status, open.request?.occurrence, coordinator(w).state, coordinator(w).relaying], ["open", X7, "needs-input", ["70.7"]]);
  appendFileSync(ticketPath(repo, "70.7"), `\n<!-- pathfinder:orchestrate gate-resolved 70.7 ${"0".repeat(12)} ${X7} -->\n**Human gate resolved** on 2026-11-13. Worker \`70.7\` resumes.\n`);
  eq("half-resolved: the history says resolved while the state file still shows the gate", [history(repo, "70.7").resolved, gateId(repo, "70.7")], [[X7], X7]);
  await w.run.answerGate("gate-70.7", "too late", open.request!.revision);
  eq("half-resolved: an answer for the resolved occurrence is rejected before the next poll, nothing sent", [open.answer?.state, w.typed.length], ["rejected", 1]);
  await refresh(w);
  eq("half-resolved: the request closes on Pathfinder's history", [open.status, /gate history records this request resolved/.test(open.note ?? ""), gateItems(w, "70.7").filter((i) => i.status === "open").length], ["done", true, 0]);
  check("half-resolved: the coordinator no longer needs you for it", coordinator(w).state !== "needs-input" || !(coordinator(w).relaying ?? []).includes("70.7"), coordinator(w));
  await w.run.answerGate("gate-70.7", "too late", open.request!.revision);
  eq("half-resolved: nothing can be sent for it afterwards", w.typed.length, 1);
}

console.log(`\n${passes} passed, ${failures} failed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
