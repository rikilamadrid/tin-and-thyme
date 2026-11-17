// Ticket 09.3: the Pathfinder runtime recording sessions in the crew book. Drives a real PathfinderRun with
// synthetic hook payloads, fixture transcripts, a fake engine and a temporary HOME, like
// coordinator-attention-test.ts. Nothing touches a live kitchen, and no native session is started.
//
//   node --import tsx scripts/crew-runtime-test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "tt-crew-runtime-")));
// Every ~/.controlroom write lands here.
Object.assign(process.env, { HOME: tmp, USERPROFILE: tmp });
Object.assign(globalThis, { location: { href: "http://127.0.0.1/" } });

const { Hub } = await import("../server/hub");
const { COORDINATOR_ID, PathfinderRun } = await import("../server/pathfinder");
const { crewBookProblems, crewHistoryProblems, crewSnapshotProblems } = await import("../src/data/fixture/crewFixture");
const { FAMILY_POOLS, occurrenceLabel } = await import("../src/data/crewContract");
const { subagentTurns } = await import("../server/transcripts");
type Run = InstanceType<typeof PathfinderRun>;
type Book = import("../src/data/crewContract").CrewBook;

interface World { root: string; coord: string; slug: string; hub: InstanceType<typeof Hub>; run: Run }

const brief = (key: string, session = "implementation", role = "developer") =>
  `Pathfinder worker brief — ${key} Ticket ${key} (context/tickets/${key}-x.md)\n\nSession:   ${session}\nRole:      ${role}\nModel:     inherited\nEffort:    inherited\nWorktree:  /work/.pathfinder/worktrees/${key}\n`;

function makeRepo(name: string) {
  const root = join(tmp, name);
  const engineDir = join(root, "skills", "orchestrate", "engine", "bin");
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(join(root, "context"), { recursive: true });
  writeFileSync(join(root, "context", "execution-mode.md"), "<!-- pathfinder:execution-mode orchestrator -->\n");
  writeFileSync(join(engineDir, "orchestrate.mjs"), `import { readFileSync } from "node:fs";\nconst rows = JSON.parse(readFileSync(${JSON.stringify(join(root, "rows.json"))}, "utf8"));\nprocess.stdout.write(JSON.stringify({ ok: true, store: "local", rows }));\n`);
  writeFileSync(join(root, "rows.json"), "[]");
  const coord = join(tmp, `${name}-session.jsonl`);
  writeFileSync(coord, "");
  mkdirSync(join(coord.replace(/\.jsonl$/, ""), "subagents"), { recursive: true });
  return { root, coord, engine: join(engineDir, "orchestrate.mjs") };
}
type Repo = ReturnType<typeof makeRepo>;

function boot(repo: Repo, slug: string, coordinator: "running" | "stopped" = "running"): World {
  const config = { project: { id: slug, name: slug, path: repo.root }, team: [PathfinderRun.coordinatorConfig(repo.root)], workflow: {} } as never;
  const hub = new Hub({ root: repo.root, name: slug, originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false }, slug, config, { boards: [], tasks: [] }, {} as never);
  hub.persist = false;
  if (coordinator === "running") hub.setSession(COORDINATOR_ID, { state: "running" });
  const inbox = { noteHook() {}, finishTurn() {}, takeForStop: () => null } as never;
  const run = new PathfinderRun(hub, inbox, { typeInto: async () => true } as never, { mode: "orchestrator", engine: repo.engine }, 7999, "token", "/orchestrate start");
  run.start();
  run.stop();
  (run as unknown as { queueRefresh(ms: number): void }).queueRefresh = () => {};
  return { root: repo.root, coord: repo.coord, slug, hub, run };
}

const row = (key: string, state: string, extra: Record<string, unknown> = {}) => ({ worker: key, key, lifecycle: "In Progress", state, where: "—", gate: "—", last: "—", title: `Ticket ${key}`, ...extra });
const setRows = (w: World, rows: Record<string, unknown>[]) => writeFileSync(join(w.root, "rows.json"), JSON.stringify(rows));
const stateFile = (w: World, key: string, lines: Record<string, string>) => {
  const dir = join(w.root, ".pathfinder", "worktrees", key, "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current-ticket.md"), `# Current Ticket\n\n${Object.entries(lines).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`);
};
const subDir = (w: { coord: string }) => join(w.coord.replace(/\.jsonl$/, ""), "subagents");
function writeSub(w: { coord: string }, agentId: string, opts: { prompt: string; toolUseId?: string; finished?: boolean; report?: string; at?: string }) {
  const at = opts.at ?? new Date().toISOString();
  const recs: unknown[] = [{ parentUuid: null, isSidechain: true, agentId, type: "user", message: { role: "user", content: opts.prompt }, timestamp: at }];
  if (opts.report) recs.push({ isSidechain: true, agentId, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "SubagentHandback", input: { message: opts.report } }] }, timestamp: at });
  writeFileSync(join(subDir(w), `agent-${agentId}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(subDir(w), `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "", toolUseId: opts.toolUseId ?? `tu_${agentId}`, ...(opts.finished ? { finished: true } : {}) }));
}
const hook = (w: World, event: string, body: Record<string, unknown>) => w.run.onHook(event, { session_id: "s", transcript_path: w.coord, cwd: w.root, hook_event_name: event, ...body });
const subStart = (w: World, agentId: string) => hook(w, "SubagentStart", { agent_id: agentId, agent_type: "general-purpose" });
const subStop = (w: World, agentId: string, last = "") => hook(w, "SubagentStop", { agent_id: agentId, agent_type: "general-purpose", agent_transcript_path: join(subDir(w), `agent-${agentId}.jsonl`), last_assistant_message: last, stop_hook_active: false });
const tool = (w: World, agentId: string, toolUseId: string, event = "PreToolUse") => hook(w, event, { agent_id: agentId, agent_type: "general-purpose", tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command: "git status" }, tool_response: { stdout: "" } });
/** The coordinator launches a worker: Agent call, its result, the subagent's own files, its start hook. */
function launch(w: World, agentId: string, key: string, session = "implementation", role = "developer") {
  const prompt = brief(key, session, role);
  hook(w, "PreToolUse", { tool_name: "Agent", tool_use_id: `tu_${agentId}`, tool_input: { prompt, description: "", subagent_type: "general-purpose", run_in_background: true } });
  hook(w, "PostToolUse", { tool_name: "Agent", tool_use_id: `tu_${agentId}`, tool_input: { prompt }, tool_response: { isAsync: true, status: "async_launched", agentId, prompt } });
  writeSub(w, agentId, { prompt });
  subStart(w, agentId);
}
/** The worker reports and stops. */
function finish(w: World, agentId: string, key: string, report = "DONE: abc", session = "implementation", role = "developer") {
  writeSub(w, agentId, { prompt: brief(key, session, role), report, finished: true });
  subStop(w, agentId, report);
}

type WorkerView = { hqId: string; live: boolean; livenessUnknown?: boolean; occurrence: string; ended: { outcome: string; verdict?: string | null } | null };
const workers = (w: World) => (w.run as unknown as { workers: Map<string, WorkerView> }).workers;
const refresh = (w: World) => (w.run as unknown as { refresh(): Promise<void> }).refresh();
const book = (w: World) => (w.run as unknown as { crew: { book: Book } }).crew.book;
const chain = (w: World, id: string) => Object.values(book(w).sessions).filter((s) => s.conversation === id).sort((a, b) => a.seq - b.seq);
const disk = (slug: string) => JSON.parse(readFileSync(join(tmp, ".controlroom", slug, "crew-book.json"), "utf8")) as Book;
const team = (w: World) => w.hub.snap.config.team;
const workerRows = (w: World) => team(w).filter((a) => a.id !== COORDINATOR_ID);
const snapshot = (w: World) => w.hub.snap.workflow!.crew!;
/** Every published snapshot must agree with the book it was projected from. */
const sound = (w: World) => { assert.deepEqual(crewBookProblems(book(w)), []); assert.deepEqual(crewSnapshotProblems(snapshot(w), book(w)), []); };

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log(`PASS ${name}`); }

await test("sessions are recorded in the crew book by their own identity; the team has no row per session", async () => {
  const w = boot(makeRepo("repo-roster"), "tt-roster");
  setRows(w, [1, 2, 3, 4, 5].map((n) => row(`01.${n}`, "working")));
  await refresh(w);
  assert.equal(w.hub.snap.workflow?.crew, undefined, "no snapshot before the restore pass has closed");
  // Launched out of order, and one after another on the same character.
  for (const n of [3, 1, 5, 2, 4]) {
    launch(w, `dev${n}`, `01.${n}`);
    await refresh(w);
    finish(w, `dev${n}`, `01.${n}`);
  }
  await refresh(w);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => [book(w).sessions[`dev${n}`].ticket, book(w).sessions[`dev${n}`].stage, book(w).sessions[`dev${n}`].end?.outcome]), [1, 2, 3, 4, 5].map((n) => [`01.${n}`, "implementation", "handed-off"]));
  assert.deepEqual(new Set(Object.values(book(w).sessions).filter((s) => s.kind === "worker").map((s) => s.characterId)), new Set(["pepper"]));
  assert.equal(workerRows(w).length, 1, "five finished sessions on one robot are one row, not five");
  assert.deepEqual([workerRows(w)[0].id, workerRows(w)[0].name, workerRows(w)[0].crew?.ticket], [workers(w).get("dev4")!.hqId, "Pepper", "01.4"]);
  assert.equal(snapshot(w).history.filter((s) => s.kind === "worker").length, 5);
  // An earlier session keeps its name and its status although its row has gone to a later session.
  assert.equal(w.hub.name(workers(w).get("dev3")!.hqId), "Pepper"); assert.equal(w.hub.status(workers(w).get("dev3")!.hqId)?.ended?.outcome, "handed-off");
  assert.equal(existsSync(join(tmp, ".controlroom", "tt-roster", "crew.json")), false); assert.equal(existsSync(join(tmp, ".controlroom", "tt-roster", "sessions.json")), false);
  assert.deepEqual(disk("tt-roster").sessions, JSON.parse(JSON.stringify(book(w).sessions)), "the book on disk is the book in memory");
  sound(w);
});

await test("concurrent same-role sessions wear distinct robots; a reused robot shows the new session's own role", async () => {
  const w = boot(makeRepo("repo-roles"), "tt-roles");
  setRows(w, [row("02.1", "working"), row("02.2", "working"), row("02.3", "review"), row("02.4", "review")]);
  launch(w, "d1", "02.1"); launch(w, "d2", "02.2"); launch(w, "t1", "02.3", "review", "tester"); launch(w, "t2", "02.4", "review", "tester");
  await refresh(w);
  assert.deepEqual(["d1", "d2", "t1", "t2"].map((id) => book(w).sessions[id].characterId), ["pepper", "roux", "dash", "dot"]);
  assert.deepEqual(workerRows(w).map((a) => [a.name, a.crew?.character, a.crew?.role, a.crew?.ticket]), [["Pepper", "pepper", "developer", "02.1"], ["Roux", "roux", "developer", "02.2"], ["Dash", "dash", "tester", "02.3"], ["Dot", "dot", "tester", "02.4"]]);
  finish(w, "d1", "02.1");
  // A fresh session with another role name of the same family takes the freed robot: nothing of d1 carries over.
  launch(w, "d3", "02.1", "repair", "engineer");
  await refresh(w);
  assert.equal(book(w).sessions.d3.characterId, "pepper"); assert.equal(book(w).sessions.d3.continuation, null); assert.equal(occurrenceLabel(book(w).sessions.d3), "new conversation");
  const pepper = snapshot(w).characters.find((c) => c.id === "pepper")!;
  assert.deepEqual([pepper.sessionId, pepper.role, pepper.stage, pepper.ticket, pepper.lastOutcome], ["d3", "engineer", "repair", "02.1", "handed-off"]);
  const rowNow = workerRows(w).find((a) => a.crew?.character === "pepper")!;
  assert.deepEqual([rowNow.id, rowNow.role, rowNow.crew?.role, rowNow.crew?.session], [workers(w).get("d3")!.hqId, "engineer", "engineer", "repair"]);
  assert.equal(workerRows(w).length, 4);
  sound(w);
});

await test("resume: the same conversation gets one linked occurrence; repeated and duplicate events add none", async () => {
  const w = boot(makeRepo("repo-resume"), "tt-resume");
  setRows(w, [row("03.1", "working")]);
  launch(w, "conv", "03.1");
  await refresh(w);
  tool(w, "conv", "toolu_first");
  finish(w, "conv", "03.1", "DONE: first turn");
  await refresh(w);
  const hqId = workers(w).get("conv")!.hqId; const first = structuredClone(book(w).sessions.conv); const rows = team(w).length;
  assert.deepEqual([first.phase, first.end?.outcome, first.characterId], ["ended", "handed-off", "pepper"]);

  // Pathfinder resumes it under the same subagent id.
  subStart(w, "conv");
  assert.equal(chain(w, "conv").length, 1, "a bare start can be a duplicate; wait for evidence");
  tool(w, "conv", "toolu_second");
  assert.deepEqual(chain(w, "conv").map((s) => [s.id, s.phase]), [["conv", "ended"], ["conv#2", "live"]]);
  const second = book(w).sessions["conv#2"];
  assert.deepEqual([second.conversation, second.continuation, second.characterId, second.hqId, occurrenceLabel(second)], ["conv", { of: "conv", via: "tool", evidence: "toolu_second" }, "pepper", hqId, "same conversation"]);
  assert.deepEqual(book(w).sessions.conv, first, "the ended occurrence and its outcome are untouched");
  assert.deepEqual([workers(w).get("conv")!.hqId, workers(w).get("conv")!.live, workers(w).get("conv")!.occurrence], [hqId, true, "conv#2"]);
  assert.equal(w.hub.status(hqId)!.session.state, "running");
  assert.equal(w.hub.snap.activity.some((a) => /resumed the same conversation/.test(a.text)), true);
  assert.equal(team(w).length, rows, "no second robot and no second row because a worker resumed");

  // Repeated resume signals while it runs: the start hook again, its tool calls (new and replayed), polls.
  subStart(w, "conv"); subStart(w, "conv"); tool(w, "conv", "toolu_second"); tool(w, "conv", "toolu_second", "PostToolUse"); tool(w, "conv", "toolu_first");
  await refresh(w); await refresh(w);
  assert.deepEqual(chain(w, "conv").map((s) => s.id), ["conv", "conv#2"]); assert.equal(team(w).length, rows);
  assert.deepEqual(snapshot(w).current.filter((s) => s.kind === "worker").map((s) => [s.id, s.continuation?.of]), [["conv#2", "conv"]]);
  assert.deepEqual(snapshot(w).characters.filter((c) => c.sessionId?.startsWith("conv")).map((c) => [c.id, c.sessionId]), [["pepper", "conv#2"]]);
  sound(w);

  // It stops with a new report: the continuation has its own outcome; the first keeps its own.
  writeFileSync(join(subDir(w), "agent-conv.jsonl"), readFileSync(join(subDir(w), "agent-conv.jsonl"), "utf8") + JSON.stringify({ type: "user", message: { role: "user", content: "Go on" } }) + "\n" +
    JSON.stringify({ isSidechain: true, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_y", name: "SubagentHandback", input: { message: "FAILED: second turn broke" } }] } }) + "\n");
  subStop(w, "conv", "FAILED: second turn broke");
  await refresh(w);
  assert.deepEqual(chain(w, "conv").map((s) => [s.id, s.phase, s.end?.outcome]), [["conv", "ended", "handed-off"], ["conv#2", "ended", "failed"]]);
  const settled = structuredClone(book(w).sessions);

  // Duplicate events after it ended: a repeated stop, replayed tool hooks, more polls. Nothing is revived or added.
  subStop(w, "conv", "FAILED: second turn broke"); tool(w, "conv", "toolu_second"); tool(w, "conv", "toolu_first", "PostToolUse"); tool(w, "conv", "toolu_y", "PostToolUse");
  await refresh(w); await refresh(w);
  assert.deepEqual(book(w).sessions, settled); assert.equal(workers(w).get("conv")!.live, false); assert.equal(team(w).length, rows);

  // A later genuine resume, seen by a tool call the kitchen had never seen: exactly one more, keyed by that evidence.
  tool(w, "conv", "toolu_third");
  assert.deepEqual(chain(w, "conv").map((s) => [s.id, s.phase, s.continuation?.via ?? null, s.continuation?.evidence ?? null]), [["conv", "ended", null, null], ["conv#2", "ended", "tool", "toolu_second"], ["conv#3", "live", "tool", "toolu_third"]]);
  assert.equal(book(w).sessions["conv#3"].characterId, "pepper"); assert.equal(team(w).length, rows);
  assert.deepEqual(crewHistoryProblems({ ...book(w), sessions: settled } as Book, book(w)), []);
  await refresh(w);
  sound(w);
});

// Append real turn boundaries rather than replacing earlier turns, so delayed bytes and replay are distinct.
const appendRecord = (w: World, id: string, record: unknown) => {
  const file = join(subDir(w), `agent-${id}.jsonl`);
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify(record) + "\n");
};
const userTurn = (w: World, id: string) => appendRecord(w, id, { type: "user", message: { role: "user", content: "Continue" } });
const terminal = (w: World, id: string, report: string, toolId: string) => appendRecord(w, id, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "SubagentHandback", input: { message: report } }] } });

await test("delayed bare starts cannot reserve a robot or duplicate a completed resumed turn", async () => {
  const w = boot(makeRepo("repo-start-replay"), "tt-start-replay");
  setRows(w, [row("03.2", "working")]); launch(w, "conv", "03.2"); await refresh(w);
  finish(w, "conv", "03.2", "DONE: first"); await refresh(w);
  const before = structuredClone(book(w).sessions.conv);
  subStart(w, "conv"); subStop(w, "conv", "DONE: second");
  userTurn(w, "conv"); terminal(w, "conv", "DONE: second", "second-handback");
  await refresh(w); await refresh(w);
  assert.equal(chain(w, "conv").length, 2);
  const settled = structuredClone(book(w).sessions);
  subStart(w, "conv"); subStart(w, "conv"); await refresh(w); subStop(w, "conv", "DONE: second");
  assert.deepEqual(book(w).sessions, settled);
  assert.deepEqual(book(w).sessions.conv, before);
  assert.equal(workers(w).get("conv")!.live, false);
  launch(w, "next", "03.2"); await refresh(w);
  assert.equal(book(w).sessions.next.characterId, "pepper", "duplicate starts do not reserve Pepper"); sound(w);
});

await test("a hook-ended continuation consumes its late terminal once, including a restart before the flush", async () => {
  for (const restart of [false, true]) {
    const repo = makeRepo(`repo-late-${restart}`);
    let w = boot(repo, `tt-late-${restart}`);
    setRows(w, [row("03.3", "working")]); launch(w, "conv", "03.3"); await refresh(w);
    finish(w, "conv", "03.3", "DONE: first"); await refresh(w);
    tool(w, "conv", "resume-tool");
    subStop(w, "conv", "DONE: second");
    assert.equal(chain(w, "conv").length, 2);
    const ended = structuredClone(book(w).sessions["conv#2"]);
    if (restart) { w = boot(repo, `tt-late-${restart}`); await refresh(w); }
    userTurn(w, "conv"); await refresh(w); // partial late flush must not look like another resume
    terminal(w, "conv", "DONE: second", "second-handback"); await refresh(w); await refresh(w);
    assert.equal(chain(w, "conv").length, 2);
    assert.deepEqual(book(w).sessions["conv#2"], ended, "late bytes do not rewrite the recorded ending");
    const again = boot(repo, `tt-late-${restart}`); await refresh(again);
    assert.equal(chain(again, "conv").length, 2);
    userTurn(again, "conv"); terminal(again, "conv", "DONE: third", "third-handback"); await refresh(again);
    assert.equal(chain(again, "conv").length, 3, "a subsequent whole turn still gets its own record"); sound(again);
  }
});

await test("coordinator replacement neither resumes the old conversation nor revives its dead helpers", async () => {
  const w = boot(makeRepo("repo-coordinator-restart"), "tt-coordinator-restart");
  const prompt = "Search the repository";
  hook(w, "PreToolUse", { tool_name: "Agent", tool_use_id: "helper-launch", tool_input: { prompt, description: "Search", subagent_type: "Explore" } });
  hook(w, "PostToolUse", { tool_name: "Agent", tool_use_id: "helper-launch", tool_input: { prompt }, tool_response: { agentId: "helper", prompt } });
  writeSub(w, "helper", { prompt, toolUseId: "helper-launch" }); await refresh(w);
  assert.equal(chain(w, "helper").length, 1);
  const original = `coordinator:repo-coordinator-restart-session`;
  for (let i = 0; i < 2; i++) {
    w.hub.setSession(COORDINATOR_ID, { state: "stopped" }); await refresh(w);
    w.hub.setSession(COORDINATOR_ID, { state: "running" }); await refresh(w);
    assert.equal(chain(w, original).length, 1);
    assert.equal(chain(w, "helper").length, 1);
    assert.equal(chain(w, "helper")[0].phase, "ended");
  }
  // Genuine helper advancement under the same observed parent can still resume it once. A later turn starts after
  // a terminal record: the dead turn's late terminal record, then the next turn's prompt.
  hook(w, "UserPromptSubmit", {});
  terminal(w, "helper", "found it", "helper-report"); userTurn(w, "helper"); await refresh(w);
  assert.equal(chain(w, "helper").length, 2);
  assert.equal(chain(w, "helper")[1].phase, "live");
  await refresh(w); assert.equal(chain(w, "helper").length, 2);
  const replacement = join(tmp, "replacement-session.jsonl"); writeFileSync(replacement, "");
  hook(w, "SessionStart", { transcript_path: replacement }); await refresh(w);
  assert.equal(chain(w, original).length, 2, "only the explicitly identified same-conversation resume is recorded");
  assert.equal(chain(w, "coordinator:replacement-session").length, 1);
  assert.equal(snapshot(w).current.some((s) => s.kind === "helper"), false); sound(w);
});

// Repair round 2 (N1–N5). Each record is appended as Claude Code writes it: a prompt opens a turn, a terminal record closes it.
const prompt = (w: World, id: string, text = "Continue") => appendRecord(w, id, { isSidechain: true, agentId: id, type: "user", message: { role: "user", content: text } });
const toolCall = (w: World, id: string, toolId: string) => appendRecord(w, id, { isSidechain: true, agentId: id, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Bash", input: {} }] } });
const toolResult = (w: World, id: string, toolId: string) => appendRecord(w, id, { isSidechain: true, agentId: id, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] } });
const say = (w: World, id: string, text: string) => appendRecord(w, id, { isSidechain: true, agentId: id, type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
const outcomes = (w: World, id: string) => chain(w, id).map((s) => [s.id, s.phase, s.end?.verdict ?? s.end?.outcome ?? null]);
const boundaryOf = (w: World, id: string) => (book(w).sessions[id].end as { terminalBoundary?: { revision: string | null; pending: boolean; turns?: number; starts?: number; tools?: string[] } } | null)?.terminalBoundary;
const setMeta = (w: World, id: string, meta: Record<string, unknown>) => writeFileSync(join(subDir(w), `agent-${id}.meta.json`), JSON.stringify({ toolUseId: `tu_${id}`, description: "", agentType: "general-purpose", ...meta }));
function launchHelper(w: World, id: string) {
  const text = `Search the repository for ${id}`;
  hook(w, "PreToolUse", { tool_name: "Agent", tool_use_id: `tu_${id}`, tool_input: { prompt: text, description: "Search", subagent_type: "Explore" } });
  writeFileSync(join(subDir(w), `agent-${id}.jsonl`), JSON.stringify({ parentUuid: null, isSidechain: true, agentId: id, type: "user", message: { role: "user", content: text }, timestamp: new Date().toISOString() }) + "\n");
  setMeta(w, id, { agentType: "Explore", description: "Search" });
  hook(w, "SubagentStart", { agent_id: id, agent_type: "Explore" });
}
const helperTool = (w: World, id: string, toolId: string, event = "PreToolUse") => hook(w, event, { agent_id: id, agent_type: "Explore", tool_name: "Grep", tool_use_id: toolId, tool_input: { pattern: "x" } });
const helperStop = (w: World, id: string) => hook(w, "SubagentStop", { agent_id: id, agent_type: "Explore" });
const liveOn = (w: World, character: string) => Object.values(book(w).sessions).filter((s) => s.phase === "live" && s.characterId === character).map((s) => s.id);

await test("N1: an ending with no terminal record hides no later turn, however it ended and across a restart", async () => {
  for (const how of ["stop hook, no terminal record", "coordinator lost", "meta.json finished"] as const) for (const restart of [false, true]) {
    const repo = makeRepo(`repo-n1-${how.length}-${restart}`); const slug = `tt-n1-${how.length}-${restart}`;
    let w = boot(repo, slug);
    setRows(w, [row("11.1", "working")]); await refresh(w); launch(w, "conv", "11.1"); await refresh(w);
    if (how === "stop hook, no terminal record") subStop(w, "conv", "");
    if (how === "coordinator lost") { w.hub.setSession(COORDINATOR_ID, { state: "stopped" }); await refresh(w); w.hub.setSession(COORDINATOR_ID, { state: "running" }); hook(w, "SessionStart", {}); }
    if (how === "meta.json finished") setMeta(w, "conv", { finished: true });
    await refresh(w);
    assert.deepEqual(outcomes(w, "conv"), [["conv", "ended", "interrupted"]], how);
    assert.deepEqual(boundaryOf(w, "conv"), { revision: null, pending: true, turns: 1 });
    const first = structuredClone(book(w).sessions.conv);
    // No late flush ever comes. Polls, bookkeeping bytes and a bare start are not a resume.
    await refresh(w); await refresh(w);
    if (restart) { w = boot(repo, slug); hook(w, "Notification", {}); await refresh(w); await refresh(w); }
    appendRecord(w, "conv", { type: "progress", note: "bookkeeping" }); subStart(w, "conv"); await refresh(w);
    assert.equal(chain(w, "conv").length, 1, `${how}: nothing but a later prompt is a later turn`);
    // No terminal record: a prompt-shaped record after the turn's last one is inside that turn by the turn-start rule
    // (a task notification nobody answers has this shape). It opens nothing and holds no robot.
    prompt(w, "conv", "Please continue and report"); await refresh(w); await refresh(w);
    assert.deepEqual([outcomes(w, "conv"), workers(w).get("conv")!.live, liveOn(w, "pepper")], [[["conv", "ended", "interrupted"]], false, []], `${how}, restart ${restart}: inside the ended turn`);
    // A genuine resume after such an ending is recorded by its first fresh tool call.
    tool(w, "conv", "n1-resume"); await refresh(w);
    assert.deepEqual([outcomes(w, "conv"), workers(w).get("conv")!.live, liveOn(w, "pepper")], [[["conv", "ended", "interrupted"], ["conv#2", "live", null]], true, ["conv#2"]], `${how}, restart ${restart}`);
    assert.equal(w.hub.status(workers(w).get("conv")!.hqId)?.session.state, "running");
    toolCall(w, "conv", "n1-resume"); toolResult(w, "conv", "n1-resume"); await refresh(w);
    say(w, "conv", "DONE: resumed work"); subStop(w, "conv", "DONE: resumed work"); await refresh(w); await refresh(w);
    assert.deepEqual(outcomes(w, "conv"), [["conv", "ended", "interrupted"], ["conv#2", "ended", "DONE"]]);
    assert.equal(book(w).sessions["conv#2"].end?.result, "resumed work"); assert.equal(w.hub.status(workers(w).get("conv")!.hqId)?.ended?.verdict, "DONE");
    assert.deepEqual(book(w).sessions.conv, first, "the ended occurrence is never rewritten");
    // A whole further text-only turn between two polls, with its stop hook: its prompt follows a terminal record, so it
    // is its own record, once.
    subStart(w, "conv"); prompt(w, "conv", "Again"); say(w, "conv", "FAILED: third"); subStop(w, "conv", "FAILED: third"); await refresh(w); await refresh(w);
    assert.deepEqual(outcomes(w, "conv"), [["conv", "ended", "interrupted"], ["conv#2", "ended", "DONE"], ["conv#3", "ended", "FAILED"]]);
    const settled = structuredClone(book(w).sessions);
    const again = boot(repo, slug); hook(again, "Notification", {}); await refresh(again); await refresh(again); subStart(again, "conv"); subStop(again, "conv", "FAILED: third"); await refresh(again);
    assert.deepEqual(book(again).sessions, settled, "a restart and replays add and change nothing"); sound(again);
  }
});

await test("N1/M2: a pending turn's late bytes are still its own; the turn after them is a later turn", async () => {
  for (const restart of [false, true]) for (const late of ["terminal record arrives", "terminal record never arrives"] as const) {
    const repo = makeRepo(`repo-n1-late-${restart}-${late.length}`); const slug = `tt-n1-late-${restart}-${late.length}`;
    let w = boot(repo, slug);
    setRows(w, [row("11.2", "working")]); await refresh(w); launch(w, "conv", "11.2"); await refresh(w);
    terminal(w, "conv", "DONE: first", "t1"); subStop(w, "conv", "DONE: first"); await refresh(w);
    tool(w, "conv", "t2"); subStop(w, "conv", "DONE: second"); // resumed by a tool call, stopped before any byte of the turn is on disk
    assert.equal(boundaryOf(w, "conv#2")?.pending, true); assert.equal(boundaryOf(w, "conv#2")?.turns, 2);
    const ended = structuredClone(book(w).sessions["conv#2"]);
    if (restart) { w = boot(repo, slug); hook(w, "Notification", {}); await refresh(w); }
    prompt(w, "conv"); await refresh(w); toolCall(w, "conv", "t2"); toolResult(w, "conv", "t2"); await refresh(w);
    assert.deepEqual([chain(w, "conv").length, workers(w).get("conv")!.live], [2, false], "its own prompt and tool records are not a resume");
    if (late === "terminal record arrives") {
      // The pending turn's own terminal record is consumed; the prompt after it opens the genuine next turn.
      terminal(w, "conv", "DONE: second", "t3"); await refresh(w);
      assert.deepEqual([chain(w, "conv").length, workers(w).get("conv")!.live], [2, false], "its own terminal record is not a resume");
      prompt(w, "conv", "One more thing"); await refresh(w);
    } else {
      // No terminal record: a prompt-shaped record is inside the pending turn by the turn-start rule (a mid-turn
      // coordinator message has this shape), so the genuine next turn is recorded by its first fresh tool call.
      prompt(w, "conv", "One more thing"); await refresh(w);
      assert.deepEqual([chain(w, "conv").length, workers(w).get("conv")!.live], [2, false], "a prompt-shaped record inside the pending turn is not a resume");
      tool(w, "conv", "t5"); await refresh(w); toolCall(w, "conv", "t5"); toolResult(w, "conv", "t5"); await refresh(w);
    }
    assert.deepEqual(outcomes(w, "conv"), [["conv", "ended", "DONE"], ["conv#2", "ended", "DONE"], ["conv#3", "live", null]], `${late}, restart ${restart}`);
    assert.deepEqual(book(w).sessions["conv#2"], ended, "late bytes rewrite nothing");
    say(w, "conv", "DONE: third"); subStop(w, "conv", "DONE: third"); await refresh(w); await refresh(w);
    assert.deepEqual(chain(w, "conv").map((s) => s.end?.result), ["first", "second", "third"]); sound(w);
  }
});

await test("a book written before boundaries kept `turns` and `tools`, or before they existed, still consumes its pending turn's late flush", async () => {
  for (const [owed, shape] of [["whole turn", "b085f0a"], ["terminal only", "b085f0a"], ["whole turn", "87f8e46"]] as const) {
    const repo = makeRepo(`repo-old-boundary-${owed.length}-${shape}`); const slug = `tt-old-boundary-${owed.length}-${shape}`;
    const w = boot(repo, slug);
    setRows(w, [row("11.4", "working")]); await refresh(w); launch(w, "conv", "11.4"); await refresh(w);
    if (owed === "whole turn") { terminal(w, "conv", "DONE: first", "t1"); subStop(w, "conv", "DONE: first"); await refresh(w); tool(w, "conv", "t2"); }
    subStop(w, "conv", "DONE: latest"); await refresh(w);
    // As b085f0a wrote it: { revision, pending } only. As 87f8e46 wrote it: no boundary at all.
    const file = join(tmp, ".controlroom", slug, "crew-book.json"); const old = JSON.parse(readFileSync(file, "utf8"));
    for (const s of Object.values(old.sessions) as { end: { terminalBoundary?: Record<string, unknown> } | null }[]) if (s.end?.terminalBoundary) {
      if (shape === "87f8e46") delete s.end.terminalBoundary; else { delete s.end.terminalBoundary.turns; delete s.end.terminalBoundary.tools; }
    }
    writeFileSync(file, JSON.stringify(old, null, 2) + "\n");
    const w2 = boot(repo, slug); hook(w2, "Notification", {}); await refresh(w2);
    const settled = structuredClone(book(w2).sessions);
    const keys = shape === "87f8e46" ? [] : ["revision", "pending"];
    assert.deepEqual(Object.values(settled).filter((s) => s.conversation === "conv").map((s) => Object.keys((s.end as { terminalBoundary?: object }).terminalBoundary ?? {})), owed === "whole turn" ? [keys, keys] : [keys], "loaded as written");
    if (owed === "whole turn") { prompt(w2, "conv"); await refresh(w2); toolCall(w2, "conv", "t2"); toolResult(w2, "conv", "t2"); await refresh(w2); }
    terminal(w2, "conv", "DONE: latest", "t9"); await refresh(w2); await refresh(w2);
    assert.deepEqual(book(w2).sessions, settled, `${owed}: the late flush adds and rewrites nothing`);
    prompt(w2, "conv", "And again"); await refresh(w2);
    assert.equal(chain(w2, "conv").at(-1)!.phase, "live"); assert.equal(chain(w2, "conv").length, Object.values(settled).filter((s) => s.conversation === "conv").length + 1); sound(w2);
  }
});

await test("N2: a helper's own late bytes and a stale finished flag are not resumes", async () => {
  const w = boot(makeRepo("repo-n2"), "tt-n2");
  hook(w, "Notification", {}); await refresh(w);
  // Late flush: its stop hook first, then its bytes in two parts with a poll between.
  launchHelper(w, "late"); await refresh(w);
  helperTool(w, "late", "g1"); helperTool(w, "late", "g1", "PostToolUse"); await refresh(w);
  helperStop(w, "late"); await refresh(w);
  assert.deepEqual(chain(w, "late").map((s) => s.phase), ["ended"]);
  toolCall(w, "late", "g1"); await refresh(w);
  assert.deepEqual([chain(w, "late").length, liveOn(w, "whisk")], [1, []], "part of its own turn is not a resume, and Whisk is not reserved");
  toolResult(w, "late", "g1"); say(w, "late", "found"); await refresh(w); await refresh(w);
  assert.equal(chain(w, "late").length, 1);
  // Stale flag: meta.json keeps `finished: true` across a genuine resume.
  launchHelper(w, "stale"); await refresh(w);
  say(w, "stale", "found it"); setMeta(w, "stale", { agentType: "Explore", finished: true }); helperStop(w, "stale"); await refresh(w); await refresh(w);
  assert.deepEqual(chain(w, "stale").map((s) => s.phase), ["ended"]);
  hook(w, "SubagentStart", { agent_id: "stale", agent_type: "Explore" }); prompt(w, "stale", "Look again"); await refresh(w);
  for (const step of [() => {}, () => toolCall(w, "stale", "h1"), () => toolResult(w, "stale", "h1"), () => toolCall(w, "stale", "h2")]) { step(); await refresh(w); await refresh(w); }
  assert.deepEqual(chain(w, "stale").map((s) => [s.id, s.phase, s.continuation?.via ?? null]), [["stale", "ended", null], ["stale#2", "live", "transcript"]], "one genuine resume is one continuation, still running");
  assert.deepEqual(liveOn(w, book(w).sessions["stale#2"].characterId!), ["stale#2"]);
  // A flag written after the resume, or its own terminal record, ends it once.
  toolResult(w, "stale", "h2"); say(w, "stale", "found again"); await refresh(w); await refresh(w);
  assert.deepEqual(chain(w, "stale").map((s) => s.phase), ["ended", "ended"]); sound(w);
});

await test("N2 across a restart: a resumed helper keeps its occurrence; its late bytes and a stale finished flag add none", async () => {
  const helperChain = (w: World) => chain(w, "h").map((s) => [s.id, s.phase, s.continuation?.via ?? null]);
  // Resumed by a tool call before any byte, meta.json still says finished, the kitchen restarts mid-turn.
  {
    const repo = makeRepo("repo-n2-restart-live"); let w = boot(repo, "tt-n2-restart-live");
    hook(w, "Notification", {}); await refresh(w);
    launchHelper(w, "h"); await refresh(w);
    say(w, "h", "found"); setMeta(w, "h", { agentType: "Explore", finished: true }); helperStop(w, "h"); await refresh(w); await refresh(w);
    helperTool(w, "h", "g2"); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null], ["h#2", "live", "tool"]]);
    w = boot(repo, "tt-n2-restart-live"); hook(w, "Notification", {}); await refresh(w); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null], ["h#2", "live", "tool"]], "the stale flag and the earlier turn's terminal record end nothing");
    assert.deepEqual(liveOn(w, book(w).sessions["h#2"].characterId!), ["h#2"]);
    prompt(w, "h", "Look again"); toolCall(w, "h", "g2"); await refresh(w); helperTool(w, "h", "g3"); toolResult(w, "h", "g2"); await refresh(w); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null], ["h#2", "live", "tool"]], "its own bytes and its next tool call are the same occurrence");
    say(w, "h", "found again"); helperStop(w, "h"); await refresh(w); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null], ["h#2", "ended", "tool"]]); sound(w);
  }
  // Resumed by a tool call and stopped before any byte; the kitchen restarts; then the late flush, then a real turn.
  {
    const repo = makeRepo("repo-n2-restart-late"); let w = boot(repo, "tt-n2-restart-late");
    hook(w, "Notification", {}); await refresh(w);
    launchHelper(w, "h"); await refresh(w);
    say(w, "h", "found"); helperStop(w, "h"); await refresh(w); await refresh(w);
    helperTool(w, "h", "g2"); await refresh(w); helperStop(w, "h"); await refresh(w);
    const settled = structuredClone(book(w).sessions);
    w = boot(repo, "tt-n2-restart-late"); hook(w, "Notification", {}); await refresh(w); await refresh(w);
    prompt(w, "h", "Look again"); toolCall(w, "h", "g2"); await refresh(w); toolResult(w, "h", "g2"); say(w, "h", "found again"); await refresh(w); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null], ["h#2", "ended", "tool"]], "the late prompt it still owed is not a later turn");
    assert.deepEqual(Object.fromEntries(Object.entries(book(w).sessions).filter(([, s]) => s.kind === "helper")), Object.fromEntries(Object.entries(settled).filter(([, s]) => s.kind === "helper")));
    prompt(w, "h", "A third question"); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null], ["h#2", "ended", "tool"], ["h#3", "live", "transcript"]], "a genuine later turn still is one"); sound(w);
  }
  // Stopped before its own bytes, the kitchen restarts, then those bytes arrive.
  {
    const repo = makeRepo("repo-n2-restart-first"); let w = boot(repo, "tt-n2-restart-first");
    hook(w, "Notification", {}); await refresh(w);
    launchHelper(w, "h"); await refresh(w); helperTool(w, "h", "g1"); helperStop(w, "h"); await refresh(w);
    w = boot(repo, "tt-n2-restart-first"); hook(w, "Notification", {}); await refresh(w);
    toolCall(w, "h", "g1"); await refresh(w); toolResult(w, "h", "g1"); say(w, "h", "found"); await refresh(w); await refresh(w);
    assert.deepEqual(helperChain(w), [["h", "ended", null]]); assert.deepEqual(liveOn(w, "whisk"), []); sound(w);
  }
});

await test("a worker continuation live at a restart keeps its occurrence; a stale flag or the earlier terminal record ends nothing", async () => {
  for (const stopFirst of [true, false]) {
    const repo = makeRepo(`repo-live-restart-${stopFirst}`); const slug = `tt-live-restart-${stopFirst}`;
    let w = boot(repo, slug);
    setRows(w, [row("11.5", "working")]); await refresh(w); launch(w, "conv", "11.5"); await refresh(w);
    finish(w, "conv", "11.5", "DONE: first"); await refresh(w); // meta.json now says finished
    tool(w, "conv", "t2"); await refresh(w); // resumed by a tool call; none of its bytes on disk
    const first = structuredClone(book(w).sessions.conv);
    w = boot(repo, slug); hook(w, "Notification", {}); await refresh(w); await refresh(w);
    assert.deepEqual([outcomes(w, "conv"), liveOn(w, "pepper")], [[["conv", "ended", "DONE"], ["conv#2", "live", null]], ["conv#2"]], `stop first ${stopFirst}: still the same live occurrence`);
    if (stopFirst) { subStop(w, "conv", "DONE: second"); await refresh(w); assert.deepEqual(boundaryOf(w, "conv#2"), { revision: boundaryOf(w, "conv")!.revision, pending: true, turns: 2 }); }
    prompt(w, "conv"); toolCall(w, "conv", "t2"); toolResult(w, "conv", "t2"); await refresh(w);
    if (!stopFirst) { tool(w, "conv", "t3"); await refresh(w); } // after its stop a fresh tool call would be a later turn
    terminal(w, "conv", "DONE: second", "t4"); if (!stopFirst) subStop(w, "conv", "DONE: second"); await refresh(w); await refresh(w);
    assert.deepEqual(outcomes(w, "conv"), [["conv", "ended", "DONE"], ["conv#2", "ended", "DONE"]], "its own bytes, a later tool call and its stop are that one occurrence");
    assert.deepEqual(chain(w, "conv").map((s) => s.end?.result), ["first", "second"]); assert.deepEqual(book(w).sessions.conv, first);
    const w2 = boot(repo, slug); hook(w2, "Notification", {}); await refresh(w2); prompt(w2, "conv", "Once more"); await refresh(w2);
    assert.deepEqual(outcomes(w2, "conv").map((o) => o[1]), ["ended", "ended", "live"], "a genuine later turn after another restart is one more"); sound(w2);
  }
});

await test("N3: after a restart, a replayed hook for any tool of a pending turn is still a replay", async () => {
  const repo = makeRepo("repo-n3");
  const w = boot(repo, "tt-n3");
  setRows(w, [row("11.3", "working")]); await refresh(w); launch(w, "conv", "11.3"); await refresh(w);
  terminal(w, "conv", "DONE: first", "t1"); subStop(w, "conv", "DONE: first"); await refresh(w);
  tool(w, "conv", "t2"); tool(w, "conv", "t2", "PostToolUse"); tool(w, "conv", "t3"); tool(w, "conv", "t3", "PostToolUse");
  subStop(w, "conv", "DONE: second");
  assert.deepEqual(boundaryOf(w, "conv#2")?.tools, ["t2", "t3"], "the tool calls no byte was written for are kept with the ending");
  const settled = structuredClone(book(w).sessions);
  const w2 = boot(repo, "tt-n3"); hook(w2, "Notification", {}); await refresh(w2);
  tool(w2, "conv", "t2", "PostToolUse"); tool(w2, "conv", "t3", "PostToolUse"); tool(w2, "conv", "t3"); await refresh(w2);
  assert.deepEqual(book(w2).sessions, settled); assert.deepEqual([workers(w2).get("conv")!.live, liveOn(w2, "pepper")], [false, []]);
  prompt(w2, "conv"); toolCall(w2, "conv", "t2"); toolResult(w2, "conv", "t2"); toolCall(w2, "conv", "t3"); toolResult(w2, "conv", "t3"); terminal(w2, "conv", "DONE: second", "t4");
  await refresh(w2); tool(w2, "conv", "t4", "PostToolUse"); await refresh(w2);
  assert.deepEqual(book(w2).sessions, settled, "the late flush and its own replays add and change nothing");
  // A second restart with the bytes on disk, then a tool call nobody has seen: exactly one more.
  const w3 = boot(repo, "tt-n3"); hook(w3, "Notification", {}); await refresh(w3); tool(w3, "conv", "t3", "PostToolUse");
  assert.deepEqual(book(w3).sessions, settled);
  tool(w3, "conv", "t5");
  assert.deepEqual(chain(w3, "conv").map((s) => [s.id, s.phase, s.continuation?.evidence ?? null]), [["conv", "ended", null], ["conv#2", "ended", "t2"], ["conv#3", "live", "t5"]]); await refresh(w3); sound(w3);
});

await test("N4: a hook handled while no coordinator runs ties no later process to the old conversation", async () => {
  const lead = (w: World) => Object.values(book(w).sessions).filter((s) => s.kind === "coordinator").sort((a, b) => a.seq - b.seq).map((s) => [s.phase, s.continuation?.via ?? null]);
  for (const pollBetween of [false, true]) {
    const w = boot(makeRepo(`repo-n4-${pollBetween}`), `tt-n4-${pollBetween}`);
    hook(w, "Notification", {}); await refresh(w);
    assert.deepEqual(lead(w), [["live", null]]);
    w.hub.setSession(COORDINATOR_ID, { state: "stopped" }); await refresh(w);
    hook(w, "SessionEnd", {}); // the old process's last hook, handled after it was seen stopped
    if (pollBetween) await refresh(w);
    w.hub.setSession(COORDINATOR_ID, { state: "running" }); await refresh(w); await refresh(w);
    assert.deepEqual(lead(w), [["ended", null]], "a new process with no hook of its own resumes nothing");
    // Its own hook, handled while it runs, records the resume once; replays add nothing.
    hook(w, "SessionStart", {}); await refresh(w); hook(w, "SessionStart", {}); hook(w, "UserPromptSubmit", {}); await refresh(w);
    assert.deepEqual(lead(w), [["ended", null], ["live", "hook"]]); sound(w);
  }
});

await test("N5: a helper resume is recorded when it is seen: by its tool call before any byte, or as a whole turn between polls", async () => {
  const repo = makeRepo("repo-n5");
  const w = boot(repo, "tt-n5");
  hook(w, "Notification", {}); await refresh(w);
  launchHelper(w, "h"); await refresh(w);
  helperTool(w, "h", "g1"); toolCall(w, "h", "g1"); helperTool(w, "h", "g1", "PostToolUse"); toolResult(w, "h", "g1"); await refresh(w);
  say(w, "h", "found"); helperStop(w, "h"); await refresh(w); await refresh(w);
  const first = structuredClone(book(w).sessions.h);
  // Replays of the ended turn: nothing, in this run and after a restart.
  hook(w, "SubagentStart", { agent_id: "h", agent_type: "Explore" }); helperTool(w, "h", "g1"); helperTool(w, "h", "g1", "PostToolUse"); helperStop(w, "h"); await refresh(w); await refresh(w);
  assert.equal(chain(w, "h").length, 1);
  const w2 = boot(repo, "tt-n5"); hook(w2, "Notification", {}); await refresh(w2); await refresh(w2);
  helperTool(w2, "h", "g1"); helperTool(w2, "h", "g1", "PostToolUse"); await refresh(w2);
  assert.equal(chain(w2, "h").length, 1);
  // A fresh tool call while the transcript still ends at the old terminal record: recorded now, by that call.
  helperTool(w2, "h", "g2"); await refresh(w2);
  assert.deepEqual(chain(w2, "h").map((s) => [s.id, s.phase, s.continuation?.via ?? null, s.continuation?.evidence ?? null]), [["h", "ended", null, null], ["h#2", "live", "tool", "g2"]]);
  helperTool(w2, "h", "g2"); helperTool(w2, "h", "g2", "PostToolUse"); await refresh(w2); await refresh(w2);
  assert.equal(chain(w2, "h").length, 2, "its replay and quiet polls add nothing, and it stays live while its bytes are late");
  assert.equal(chain(w2, "h")[1].phase, "live");
  prompt(w2, "h", "again"); toolCall(w2, "h", "g2"); await refresh(w2);
  assert.deepEqual(chain(w2, "h").map((s) => s.phase), ["ended", "live"], "its own bytes arriving are the same occurrence");
  toolResult(w2, "h", "g2"); say(w2, "h", "found again"); helperStop(w2, "h"); await refresh(w2); await refresh(w2);
  assert.deepEqual(chain(w2, "h").map((s) => s.phase), ["ended", "ended"]);
  // A whole resumed turn between two polls: one ended occurrence, keyed by its terminal record.
  hook(w2, "SubagentStart", { agent_id: "h", agent_type: "Explore" }); prompt(w2, "h", "third"); say(w2, "h", "third answer"); helperStop(w2, "h"); await refresh(w2); await refresh(w2);
  assert.deepEqual(chain(w2, "h").map((s) => [s.id, s.phase, s.continuation?.via ?? null, String(s.continuation?.evidence ?? "").startsWith("terminal:")]), [["h", "ended", null, false], ["h#2", "ended", "tool", false], ["h#3", "ended", "transcript", true]]);
  assert.deepEqual(book(w2).sessions.h, first); assert.deepEqual(liveOn(w2, "whisk"), []);
  const settled = structuredClone(book(w2).sessions);
  const w3 = boot(repo, "tt-n5"); hook(w3, "Notification", {}); await refresh(w3); helperStop(w3, "h"); await refresh(w3);
  assert.deepEqual(Object.fromEntries(Object.entries(book(w3).sessions).filter(([, s]) => s.kind === "helper")), Object.fromEntries(Object.entries(settled).filter(([, s]) => s.kind === "helper")), "a restart reads the same helper chain back"); sound(w3);
  // A helper resume still needs a running coordinator that identified itself (M4).
  w3.hub.setSession(COORDINATOR_ID, { state: "stopped" }); await refresh(w3); w3.hub.setSession(COORDINATOR_ID, { state: "running" });
  helperTool(w3, "h", "g9"); prompt(w3, "h", "fourth"); await refresh(w3); await refresh(w3);
  assert.equal(chain(w3, "h").length, 3, "an unidentified coordinator revives no helper");
});

await test("restart recovery: the chain, the robots and the outcomes are read back; nothing is duplicated or relaunched", async () => {
  const repo = makeRepo("repo-restart");
  const w = boot(repo, "tt-restart");
  setRows(w, [row("04.1", "working"), row("04.2", "review")]);
  launch(w, "conv", "04.1"); launch(w, "rev", "04.2", "review", "tester");
  await refresh(w);
  finish(w, "conv", "04.1", "DONE: first");
  subStart(w, "conv"); tool(w, "conv", "toolu_resume"); // positive evidence: conv#2 is live when the kitchen stops
  writeSub(w, "conv", { prompt: brief("04.1") }); // its transcript is unfinished again
  await refresh(w);
  const before = structuredClone(book(w)); const rowsBefore = workerRows(w).map((a) => [a.id, a.crew?.character]);
  assert.deepEqual(chain(w, "conv").map((s) => [s.id, s.phase]), [["conv", "ended"], ["conv#2", "live"]]);

  const w2 = boot(repo, "tt-restart");
  await refresh(w2); await refresh(w2);
  assert.deepEqual(Object.keys(book(w2).sessions).sort(), Object.keys(before.sessions).sort(), "a restart adds no session record");
  assert.deepEqual(crewHistoryProblems(before, book(w2)), []);
  assert.deepEqual(chain(w2, "conv").map((s) => [s.id, s.phase, s.characterId]), [["conv", "ended", "pepper"], ["conv#2", "live", "pepper"]]);
  // An unfinished transcript proves identity, not liveness: shown unknown, still on its own robot, never idle or working.
  assert.deepEqual([workers(w2).get("conv")!.live, workers(w2).get("conv")!.livenessUnknown, workers(w2).get("conv")!.occurrence], [false, true, "conv#2"]);
  assert.equal(snapshot(w2).characters.find((c) => c.id === "pepper")!.state, "unknown");
  assert.deepEqual(workerRows(w2).map((a) => [a.id, a.crew?.character]), rowsBefore);
  sound(w2);
  // Its own next tool call shows it running: the same occurrence, no new record.
  tool(w2, "conv", "toolu_after_restart");
  await refresh(w2);
  assert.deepEqual(chain(w2, "conv").map((s) => [s.id, s.phase]), [["conv", "ended"], ["conv#2", "live"]]); assert.equal(workers(w2).get("conv")!.live, true);
  finish(w2, "conv", "04.1", "DONE: second");
  await refresh(w2);
  const settled = structuredClone(book(w2));

  // Restart again with everything finished, restored in whatever order the directory gives.
  const w3 = boot(repo, "tt-restart");
  await refresh(w3);
  assert.deepEqual(book(w3).sessions, settled.sessions, "a restart on a settled book changes no session");
  assert.deepEqual([workers(w3).get("conv")!.live, workers(w3).get("conv")!.ended?.outcome, workers(w3).get("conv")!.occurrence], [false, "handed-off", "conv#2"]);
  assert.equal(book(w3).migrations.length, 0); assert.equal(existsSync(join(tmp, ".controlroom", "tt-restart", "backups")), false);
  sound(w3);
});

await test("a session with no stop event ends with an honest unknown outcome once its parent is gone", async () => {
  const repo = makeRepo("repo-lost");
  const w = boot(repo, "tt-lost");
  setRows(w, [row("05.1", "working")]);
  launch(w, "gone", "05.1");
  await refresh(w);
  assert.equal(book(w).sessions.gone.phase, "live");
  // The kitchen restarts and the coordinator is not running: nothing can still be running under it.
  const w2 = boot(repo, "tt-lost", "stopped");
  await refresh(w2);
  assert.equal(book(w2).restorePass !== null, true, "inside the reattach window nothing is decided");
  assert.equal(book(w2).sessions.gone.phase, "live"); assert.equal(w2.hub.snap.workflow?.crew, undefined);
  (w2.run as unknown as { startedAt: number }).startedAt = 0; // past the reattach window
  await refresh(w2);
  const s = book(w2).sessions.gone;
  assert.deepEqual([s.phase, s.end, s.ticket, s.characterId], ["ended", null, "05.1", "pepper"]);
  assert.equal(snapshot(w2).history.find((x) => x.id === "gone")!.end, null); assert.equal(snapshot(w2).characters.find((c) => c.id === "pepper")!.lastOutcome, null);
  assert.equal(w2.hub.status(workers(w2).get("gone")!.hqId)?.session.state, "unknown", "the status still says its liveness was never observed");
  sound(w2);
});

await test("migration through the runtime's own startup: legacy files are imported once, backed up, and left byte-identical", async () => {
  const repo = makeRepo("repo-legacy");
  const dir = join(tmp, ".controlroom", "tt-legacy");
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 3600_000).toISOString();
  // Two sessions the old kitchen both called Pepper, a tester, and an entry whose transcript is gone.
  const crew = { old1: { id: "pepper", name: "Pepper", job: "Saucier" }, old2: { id: "pepper", name: "Pepper 2", job: "Saucier" }, rev1: { id: "dash", name: "Dash", job: "Expediter" }, lost: { id: "roux", name: "Roux", job: "Rôtisseur" } };
  const ends = { old1: { outcome: "handed-off", next: "review", result: "abc", at, verdict: "DONE", key: "06.1", session: "implementation" }, rev1: { outcome: "gate", next: null, result: "Ship it?", at, verdict: "GATE", key: "06.1", session: "review", occurrence: "0000000000a1" } };
  const bytes = { "crew.json": JSON.stringify(crew, null, 2), "sessions.json": JSON.stringify(ends, null, 2), "coordinator.json": JSON.stringify({ transcript: repo.coord, at }, null, 2) };
  for (const [name, text] of Object.entries(bytes)) writeFileSync(join(dir, name), text);
  // Transcripts are written newest first, so the restore reads them in the reverse of start order.
  writeSub(repo, "old2", { prompt: brief("06.2"), at: new Date(Date.now() - 1000_000).toISOString() });
  writeSub(repo, "rev1", { prompt: brief("06.1", "review", "tester"), report: "GATE: Ship it?", finished: true, at: new Date(Date.now() - 2000_000).toISOString() });
  writeSub(repo, "old1", { prompt: brief("06.1"), report: "DONE: abc", finished: true, at: new Date(Date.now() - 3000_000).toISOString() });

  const w = boot(repo, "tt-legacy");
  setRows(w, [row("06.1", "review"), row("06.2", "working")]);
  await refresh(w);
  const b = book(w);
  assert.deepEqual(Object.keys(b.sessions).filter((id) => !id.startsWith("coordinator:")).sort(), ["lost", "old1", "old2", "rev1"]);
  assert.deepEqual(["old1", "old2", "rev1", "lost"].map((id) => [b.sessions[id].characterId, b.sessions[id].phase, b.sessions[id].legacy?.name]), [["pepper", "ended", "Pepper"], ["pepper", "live", "Pepper 2"], ["dash", "ended", "Dash"], ["roux", "ended", "Roux"]]);
  assert.deepEqual(b.sessions.old1.end, ends.old1); assert.deepEqual(b.sessions.rev1.end, ends.rev1);
  assert.deepEqual([b.sessions.old2.ticket, b.sessions.old2.stage, b.sessions.old2.hqId, b.sessions.old2.transcript], ["06.2", "implementation", workers(w).get("old2")!.hqId, join(subDir(repo), "agent-old2.jsonl")]);
  assert.deepEqual([b.sessions.lost.end, b.sessions.lost.ticket], [null, null], "a session whose transcript is gone ends with an unknown outcome and no invented link");
  assert.deepEqual(workers(w).get("rev1")!.ended, { outcome: "gate", next: null, result: "Ship it?", at, verdict: "GATE" });
  // One Pepper robot and no numbered copy: the row is its latest session.
  assert.deepEqual(workerRows(w).map((a) => [a.name, a.crew?.character, a.crew?.ticket]).sort(), [["Dash", "dash", "06.1"], ["Pepper", "pepper", "06.2"]]);
  assert.equal(b.migrations.length, 1);
  for (const [name, text] of Object.entries(bytes)) { assert.equal(readFileSync(join(dir, name), "utf8"), text); assert.equal(readFileSync(join(b.migrations[0].backup, name), "utf8"), text); }
  sound(w);
  const before = structuredClone(b);
  const w2 = boot(repo, "tt-legacy");
  await refresh(w2); await refresh(w2);
  assert.deepEqual(crewHistoryProblems(before, book(w2)), []); assert.deepEqual(Object.keys(book(w2).sessions).sort(), Object.keys(before.sessions).sort());
  assert.equal(book(w2).migrations.length, 1); assert.equal(readdirSync(join(dir, "backups")).length, 1);
  for (const [name, text] of Object.entries(bytes)) assert.equal(readFileSync(join(dir, name), "utf8"), text);
  assert.equal(existsSync(join(dir, "crew-book.json")), true);
});

await test("overflow before a restart stays overflow after it; freed robots go to nobody who was running", async () => {
  const repo = makeRepo("repo-overflow");
  const w = boot(repo, "tt-overflow");
  const n = FAMILY_POOLS.developer.length;
  setRows(w, Array.from({ length: n + 1 }, (_, i) => row(`07.${i}`, "working")));
  for (let i = 0; i <= n; i++) launch(w, `dev${i}`, `07.${i}`);
  await refresh(w);
  assert.equal(book(w).sessions[`dev${n}`].characterId, null); assert.deepEqual(snapshot(w).overflow, [`dev${n}`]);
  // The overflow session is listed, as the plain crew bot under its role, never as a robot it does not wear.
  const extra = workerRows(w).find((a) => a.id === workers(w).get(`dev${n}`)!.hqId)!;
  assert.deepEqual([extra.name, extra.crew?.character, extra.crew?.ticket], ["Developer session", "unit", `07.${n}`]);
  finish(w, "dev0", "07.0");
  await refresh(w);
  const before = structuredClone(book(w));
  const w2 = boot(repo, "tt-overflow");
  await refresh(w2);
  assert.equal(book(w2).sessions[`dev${n}`].characterId, null, "pepper is free, but a session that was overflow keeps no robot");
  assert.deepEqual(Object.values(book(w2).sessions).filter((s) => s.kind === "worker").map((s) => [s.id, s.characterId]), Object.values(before.sessions).filter((s) => s.kind === "worker").map((s) => [s.id, s.characterId]));
  assert.deepEqual(crewHistoryProblems(before, book(w2)), []);
  sound(w2);
});

await test("the published crew carries Feature 06's attention unchanged: a real gate is needs-you, waiting on workers is not", async () => {
  const w = boot(makeRepo("repo-attention"), "tt-attention");
  setRows(w, [row("08.1", "working"), row("08.2", "working")]);
  launch(w, "g1", "08.1"); launch(w, "g2", "08.2");
  tool(w, "g1", "toolu_g1"); tool(w, "g2", "toolu_g2");
  await refresh(w);
  assert.deepEqual(snapshot(w).characters.filter((c) => c.family === "developer").map((c) => [c.id, c.state, c.badge]), [["pepper", "working", null], ["roux", "working", null]]);
  // The coordinator ends its turn while both run: waiting, never pink.
  writeFileSync(w.coord, JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Dispatched. Waiting." }] } }) + "\n");
  hook(w, "Stop", { stop_hook_active: false, last_assistant_message: "Waiting." });
  await refresh(w);
  assert.equal(w.hub.status(COORDINATOR_ID)?.state, "waiting");
  const basil = snapshot(w).characters.find((c) => c.id === "basil")!;
  assert.deepEqual([basil.state, basil.badge?.kind, basil.sessionId?.startsWith("coordinator:")], ["waiting", "waiting", true]);
  // 08.1's own worker is at an open gate while 08.2 keeps cooking.
  stateFile(w, "08.1", { State: "human-gate", Gate: "Ship it?", "Gate-Id": "0000000000b1", Updated: new Date().toISOString() });
  setRows(w, [row("08.1", "human-gate", { gate: "Ship it?" }), row("08.2", "working")]);
  await refresh(w);
  const at = (id: string) => snapshot(w).characters.find((c) => c.id === id)!;
  assert.deepEqual([at("pepper").state, at("pepper").badge], ["needs-you", { kind: "needs-you", reason: "08.1 gate", ticket: "08.1" }]);
  assert.deepEqual([at("roux").state, at("roux").badge], ["working", null]);
  assert.equal(w.hub.status(workers(w).get("g1")!.hqId)?.state, "needs-input");
  // The coordinator relays the open gate: Feature 06 decided needs-input, and Basil shows exactly that.
  assert.deepEqual([w.hub.status(COORDINATOR_ID)?.state, at("basil").state, at("basil").badge?.reason], ["needs-input", "needs-you", w.hub.status(COORDINATOR_ID)?.note]);
  sound(w);
});

await test("the crew write command changes only the look, validates through the contract and survives a restart", async () => {
  const repo = makeRepo("repo-custom");
  const w = boot(repo, "tt-custom");
  setRows(w, [row("09.1", "working")]);
  launch(w, "c1", "09.1");
  await refresh(w);
  const session = structuredClone(book(w).sessions.c1);
  assert.equal(w.run.customizeCrew("pepper", { name: "Paprika", color: "#00E436" }), null);
  assert.deepEqual([workerRows(w)[0].name, workerRows(w)[0].role, workerRows(w)[0].crew?.role], ["Paprika", "developer", "developer"]);
  const pepper = () => snapshot(w).characters.find((c) => c.id === "pepper")!;
  assert.deepEqual([pepper().name, pepper().accent, pepper().customized, pepper().role, pepper().family], ["Paprika", "#00e436", true, "developer", "developer"]);
  assert.deepEqual(book(w).sessions.c1, session, "a rename touches no session");
  for (const [id, change, reason] of [["roux", { name: "Paprika" }, /already a crew name/], ["roux", { name: "Roux 2" }, /end in a number/], ["roux", { color: "#ff77a8" }, /needs-you/], ["nobody", { name: "X" }, /Unknown character/]] as const) {
    const saved = readFileSync(join(tmp, ".controlroom", "tt-custom", "crew-book.json"), "utf8");
    assert.match(w.run.customizeCrew(id, change) ?? "", reason); assert.equal(readFileSync(join(tmp, ".controlroom", "tt-custom", "crew-book.json"), "utf8"), saved);
  }
  assert.match(w.run.retireCrew("basil", true) ?? "", /can't be retired/); assert.equal(w.run.retireCrew("roux", true), null);
  launch(w, "c2", "09.1", "resume");
  assert.equal(book(w).sessions.c2.characterId, "ember", "a retired robot is never allocated");
  const w2 = boot(repo, "tt-custom");
  await refresh(w2);
  assert.deepEqual([book(w2).characters.pepper?.name, book(w2).characters.pepper?.color, book(w2).characters.roux?.retired], ["Paprika", "#00e436", true]);
  assert.equal(w2.run.customizeCrew("pepper", { name: null, color: null }), null); assert.equal(snapshot(w2).characters.find((c) => c.id === "pepper")!.name, "Pepper");
  sound(w2);
});

await test("a crew book this kitchen can't open is left byte-identical, and the run still observes its sessions", async () => {
  const repo = makeRepo("repo-newer");
  const dir = join(tmp, ".controlroom", "tt-newer");
  mkdirSync(dir, { recursive: true });
  const newer = JSON.stringify({ schema: "tin-and-thyme.crew-book", version: 999, kitchen: "tt-newer", sessions: {} });
  writeFileSync(join(dir, "crew-book.json"), newer);
  const w = boot(repo, "tt-newer");
  setRows(w, [row("10.1", "working")]);
  launch(w, "n1", "10.1");
  await refresh(w);
  finish(w, "n1", "10.1");
  await refresh(w);
  assert.equal(readFileSync(join(dir, "crew-book.json"), "utf8"), newer); assert.deepEqual(readdirSync(dir).filter((f) => f === "backups" || f === "crew.json" || f === "sessions.json"), []);
  assert.deepEqual([workers(w).get("n1")!.live, workers(w).get("n1")!.ended?.outcome], [false, "handed-off"]);
  assert.equal(w.hub.snap.workflow?.crew, undefined); assert.equal(workerRows(w).length, 0);
  assert.equal(w.hub.snap.activity.some((a) => /Crew book not opened.*newer than supported/.test(a.text)), true);
  assert.match(w.run.customizeCrew("pepper", { name: "X" }) ?? "", /can't be opened/);
});

// Repair round 3 (R3-1 to R3-3). Real Claude Code subagent transcripts hold prompt-shaped `user` records inside a turn.
// These are synthetic records of the same shapes (no real content): a system reminder (isMeta, string) right after the
// first prompt, a skill body (isMeta, text part) after a Skill tool result, an image note, a coordinator message and a
// task notification delivered mid-turn, and an interrupt marker. A genuine resume prompt is often isMeta too.
type Shape = "reminder" | "skill" | "image" | "coordinator" | "notification" | "interrupt";
const SHAPES: Shape[] = ["reminder", "skill", "image", "coordinator", "notification", "interrupt"];
const shaped = (w: World, id: string, kind: Shape) => {
  const text = { reminder: "<system-reminder>\nSynthetic context.\n</system-reminder>", skill: "Base directory for this skill: /synthetic/skills/x\n\n# X", image: "[Image: synthetic 10x10]",
    coordinator: "Message from the coordinator: synthetic", notification: "<task-notification>synthetic</task-notification>", interrupt: "[Request interrupted by user]" }[kind];
  appendRecord(w, id, { isSidechain: true, agentId: id, type: "user", ...(kind === "interrupt" ? {} : { isMeta: true }),
    message: { role: "user", content: kind === "reminder" || kind === "coordinator" ? text : [{ type: "text", text }] } });
};
/** A genuine resume prompt as Claude Code writes one for a message sent to a finished subagent: isMeta, after a terminal record. */
const metaPrompt = (w: World, id: string) => appendRecord(w, id, { isSidechain: true, agentId: id, type: "user", isMeta: true, message: { role: "user", content: "Message from the coordinator: continue" } });
/** One turn's bytes after its prompt, with the mid-turn record where real transcripts carry it. */
const turnBody = (w: World, id: string, kind: Shape, toolId: string) => {
  if (kind === "reminder") shaped(w, id, kind);
  toolCall(w, id, toolId); toolResult(w, id, toolId);
  if (kind !== "reminder") shaped(w, id, kind);
};

await test("R3: turn starts are a file's first prompt and a prompt directly after a terminal record, never a record inside a turn", async () => {
  const w = boot(makeRepo("repo-r3-count"), "tt-r3-count");
  launchHelper(w, "c");
  const file = join(subDir(w), "agent-c.jsonl");
  const count = () => subagentTurns(file);
  for (const kind of SHAPES) turnBody(w, "c", kind, `c-${kind}`);
  assert.deepEqual(count(), { turns: 1, legacy: 1 + SHAPES.length }, "every mid-turn shape is inside the first turn");
  say(w, "c", "done"); metaPrompt(w, "c");
  assert.equal(count().turns, 2, "an isMeta prompt directly after a terminal record starts a turn");
  shaped(w, "c", "reminder"); shaped(w, "c", "coordinator");
  assert.equal(count().turns, 2, "records right after that prompt are inside its turn");
  terminal(w, "c", "DONE: x", "c-h"); toolResult(w, "c", "c-h"); appendRecord(w, "c", { type: "progress" }); shaped(w, "c", "interrupt");
  assert.equal(count().turns, 2, "an interrupt marker after a terminal record is not a turn start");
  prompt(w, "c", "next"); assert.equal(count().turns, 3, "tool results, bookkeeping and an interrupt marker between a terminal record and a prompt change nothing");
  toolCall(w, "c", "c-t"); shaped(w, "c", "interrupt"); prompt(w, "c", "after an interrupt");
  assert.equal(count().turns, 3, "a prompt after a turn cut short with no terminal record is inside that turn (rule)");
  // A forked subagent's file opens with its inherited context, an assistant record among it, before its first prompt.
  const fork = join(subDir(w), "agent-fork.jsonl");
  writeFileSync(fork, [{ type: "fork-context-ref" }, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "k0", name: "Agent", input: {} }] } },
    { type: "user", message: { role: "user", content: "fork brief" } }, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "k1", name: "Bash", input: {} }] } }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(subagentTurns(fork).turns, 1, "a fork's first prompt starts its first turn");
  appendRecord(w, "fork", { type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>x</system-reminder>" } }); say(w, "fork", "done"); metaPrompt(w, "fork");
  assert.equal(subagentTurns(fork).turns, 2);
  // An incremental read agrees with a fresh read of the whole file.
  const whole = readFileSync(file, "utf8"); writeFileSync(file, ""); count(); writeFileSync(file, whole);
  assert.deepEqual(count(), { turns: 3, legacy: 1 + SHAPES.length + 1 + 2 + 1 + 1 + 1 + 1 });
});

await test("R3-1: a late flush holding mid-turn records adds no occurrence and holds no robot; a genuine later turn still does", async () => {
  for (const kind of SHAPES) for (const restart of [false, true]) {
    const repo = makeRepo(`repo-r3-1-${kind}-${restart}`); const slug = `tt-r3-1-${kind}-${restart}`;
    let w = boot(repo, slug);
    setRows(w, [row("12.1", "working"), row("12.2", "working")]); await refresh(w); launch(w, "conv", "12.1"); await refresh(w);
    turnBody(w, "conv", kind, "s1"); terminal(w, "conv", "DONE: first", "t1"); subStop(w, "conv", "DONE: first"); await refresh(w);
    tool(w, "conv", "t2"); tool(w, "conv", "t2", "PostToolUse"); await refresh(w); subStop(w, "conv", "DONE: second"); // before any byte of the turn
    const before = structuredClone(book(w).sessions);
    if (restart) { w = boot(repo, slug); hook(w, "Notification", {}); await refresh(w); await refresh(w); }
    // The late flush stops before its terminal record (R3-1 T2), then the terminal record arrives (T1).
    prompt(w, "conv"); turnBody(w, "conv", kind, "t2"); await refresh(w); await refresh(w);
    assert.deepEqual([outcomes(w, "conv"), workers(w).get("conv")!.live, liveOn(w, "pepper")], [[["conv", "ended", "DONE"], ["conv#2", "ended", "DONE"]], false, []], `${kind}, restart ${restart}: before the terminal record`);
    terminal(w, "conv", "DONE: second", "t3"); await refresh(w); await refresh(w);
    assert.deepEqual(book(w).sessions, before, `${kind}, restart ${restart}: the late flush adds and rewrites nothing`);
    launch(w, "other", "12.2"); await refresh(w);
    assert.equal(book(w).sessions.other.characterId, book(w).sessions.conv.characterId, "no robot is held by a fabricated turn");
    // A genuine later turn, its prompt isMeta, recorded at that prompt; its mid-turn records add nothing.
    metaPrompt(w, "conv"); await refresh(w); turnBody(w, "conv", kind, "t4"); await refresh(w);
    assert.deepEqual(outcomes(w, "conv").map((o) => o.slice(0, 2)), [["conv", "ended"], ["conv#2", "ended"], ["conv#3", "live"]], `${kind}: a genuine resume`);
    say(w, "conv", "DONE: third"); subStop(w, "conv", "DONE: third"); await refresh(w); await refresh(w);
    // A whole unseen turn between two polls, mid-turn records included: exactly one more occurrence.
    metaPrompt(w, "conv"); turnBody(w, "conv", kind, "t5"); say(w, "conv", "DONE: fourth"); await refresh(w); await refresh(w); await refresh(w);
    assert.deepEqual(outcomes(w, "conv"), [["conv", "ended", "DONE"], ["conv#2", "ended", "DONE"], ["conv#3", "ended", "DONE"], ["conv#4", "ended", "DONE"]], `${kind}, restart ${restart}`);
    sound(w);
  }
});

await test("R3-1: a first turn's late flush that starts with a reminder or carries a mid-turn record adds no occurrence", async () => {
  for (const kind of SHAPES) {
    const w = boot(makeRepo(`repo-r3-1-first-${kind}`), `tt-r3-1-first-${kind}`);
    setRows(w, [row("12.3", "working")]); await refresh(w); launch(w, "conv", "12.3"); await refresh(w);
    tool(w, "conv", "f1"); tool(w, "conv", "f1", "PostToolUse"); subStop(w, "conv", "DONE: first"); await refresh(w);
    const before = structuredClone(book(w).sessions);
    turnBody(w, "conv", kind, "f1"); await refresh(w);
    terminal(w, "conv", "DONE: first", "f2"); await refresh(w); await refresh(w);
    assert.deepEqual([book(w).sessions, workers(w).get("conv")!.live], [before, false], kind); sound(w);
  }
});

await test("R3-2: a helper's own mid-turn records are not a later turn, with or without its stop hook; a genuine one is", async () => {
  for (const kind of SHAPES) for (const stop of [true, false]) {
    const w = boot(makeRepo(`repo-r3-2-${kind}-${stop}`), `tt-r3-2-${kind}-${stop}`);
    hook(w, "Notification", {}); await refresh(w);
    launchHelper(w, "h"); await refresh(w); await refresh(w);
    turnBody(w, "h", kind, "g1"); say(w, "h", "found it"); if (stop) helperStop(w, "h");
    await refresh(w); await refresh(w); await refresh(w);
    assert.deepEqual(chain(w, "h").map((s) => [s.id, s.phase]), [["h", "ended"]], `${kind}, stop hook ${stop}`);
    metaPrompt(w, "h"); turnBody(w, "h", kind, "g2"); say(w, "h", "found more"); await refresh(w); await refresh(w);
    assert.deepEqual(chain(w, "h").map((s) => [s.id, s.phase]), [["h", "ended"], ["h#2", "ended"]], `${kind}: a whole genuine later turn is one more`);
    assert.deepEqual(liveOn(w, "whisk"), []); sound(w);
  }
  // First sight saw only the brief; the reminder and the whole rest of the turn land before the next poll (T6).
  const w = boot(makeRepo("repo-r3-2-first-sight"), "tt-r3-2-first-sight");
  hook(w, "Notification", {}); await refresh(w);
  launchHelper(w, "h"); await refresh(w);
  turnBody(w, "h", "reminder", "g1"); say(w, "h", "found it"); await refresh(w); await refresh(w); await refresh(w);
  assert.deepEqual(chain(w, "h").map((s) => [s.id, s.phase]), [["h", "ended"]]); sound(w);
});

await test("R3-3: an interrupt marker after an ending is never a resume; a task notification is one only directly after a terminal record", async () => {
  for (const kind of ["interrupt", "notification"] as const) for (const ended of ["stop hook, no terminal record", "terminal record"] as const) {
    const w = boot(makeRepo(`repo-r3-3-${kind}-${ended.length}`), `tt-r3-3-${kind}-${ended.length}`);
    setRows(w, [row("12.4", "working")]); await refresh(w); launch(w, "conv", "12.4"); await refresh(w);
    tool(w, "conv", "i1"); toolCall(w, "conv", "i1"); toolResult(w, "conv", "i1");
    if (ended === "terminal record") terminal(w, "conv", "DONE: first", "i2");
    subStop(w, "conv", ended === "terminal record" ? "DONE: first" : ""); await refresh(w);
    shaped(w, "conv", kind); await refresh(w); await refresh(w);
    if (kind === "notification" && ended === "terminal record") {
      // Decided by the turn-start rule: it may be a genuine resume (real ones are answered), so it is recorded, and the
      // answer's terminal record ends it.
      assert.deepEqual([outcomes(w, "conv"), liveOn(w, "pepper")], [[["conv", "ended", "DONE"], ["conv#2", "live", null]], ["conv#2"]]);
      say(w, "conv", "DONE: answered"); await refresh(w); await refresh(w);
      assert.deepEqual([outcomes(w, "conv"), liveOn(w, "pepper")], [[["conv", "ended", "DONE"], ["conv#2", "ended", "DONE"]], []]);
    } else assert.deepEqual([chain(w, "conv").length, workers(w).get("conv")!.live, liveOn(w, "pepper")], [1, false, []], `${kind} after ${ended}`);
    sound(w);
  }
});

await test("R3: a 6552316 book's `starts` counted mid-turn records; after the upgrade it neither fabricates nor swallows a turn", async () => {
  for (const flush of ["after the restart", "before the restart"] as const) {
    const repo = makeRepo(`repo-r3-upgrade-${flush.length}`); const slug = `tt-r3-upgrade-${flush.length}`;
    const w = boot(repo, slug);
    setRows(w, [row("12.5", "working")]); await refresh(w); launch(w, "conv", "12.5"); await refresh(w);
    turnBody(w, "conv", "reminder", "u1"); shaped(w, "conv", "skill"); terminal(w, "conv", "DONE: first", "u2"); subStop(w, "conv", "DONE: first"); await refresh(w);
    tool(w, "conv", "u3"); subStop(w, "conv", "DONE: second"); await refresh(w); // before any byte of the turn
    assert.deepEqual([boundaryOf(w, "conv")?.turns, boundaryOf(w, "conv#2")?.turns], [1, 2]);
    // As 6552316 wrote it: every prompt-shaped record on disk (brief, reminder, skill body = 3), plus the one owed.
    const file = join(tmp, ".controlroom", slug, "crew-book.json"); const old = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, starts] of [["conv", 3], ["conv#2", 4]] as const) { const b = old.sessions[id].end.terminalBoundary; delete b.turns; b.starts = starts; }
    writeFileSync(file, JSON.stringify(old, null, 2) + "\n");
    const flushTurn = (x: World) => { prompt(x, "conv"); turnBody(x, "conv", "reminder", "u3"); shaped(x, "conv", "skill"); terminal(x, "conv", "DONE: second", "u4"); };
    if (flush === "before the restart") flushTurn(w);
    const w2 = boot(repo, slug); hook(w2, "Notification", {}); await refresh(w2); await refresh(w2);
    const loaded = structuredClone(book(w2).sessions);
    assert.deepEqual(Object.values(loaded).filter((s) => s.phase === "ended").map((s) => JSON.stringify(s)), Object.values(old.sessions as Record<string, object>).filter((s) => (s as { phase: string }).phase === "ended").map((s) => JSON.stringify(s)), "loaded as written");
    if (flush === "after the restart") { flushTurn(w2); await refresh(w2); await refresh(w2); }
    assert.deepEqual(book(w2).sessions, loaded, `${flush}: the late flush adds and rewrites nothing`);
    metaPrompt(w2, "conv"); await refresh(w2);
    assert.deepEqual(outcomes(w2, "conv"), [["conv", "ended", "DONE"], ["conv#2", "ended", "DONE"], ["conv#3", "live", null]], `${flush}: the genuine next turn is not swallowed`);
    sound(w2);
  }
});

console.log(`${passed} crew runtime scenarios passed (synthetic hooks and transcripts, temporary HOME; no native session). Artifacts: ${tmp}`);
