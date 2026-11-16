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
  assert.deepEqual(chain(w, "conv").map((s) => [s.id, s.phase]), [["conv", "ended"], ["conv#2", "live"]]);
  const second = book(w).sessions["conv#2"];
  assert.deepEqual([second.conversation, second.continuation, second.characterId, second.hqId, occurrenceLabel(second)], ["conv", { of: "conv", via: "hook", evidence: null }, "pepper", hqId, "same conversation"]);
  assert.deepEqual(book(w).sessions.conv, first, "the ended occurrence and its outcome are untouched");
  assert.deepEqual([workers(w).get("conv")!.hqId, workers(w).get("conv")!.live, workers(w).get("conv")!.occurrence], [hqId, true, "conv#2"]);
  assert.match(w.hub.status(hqId)!.note ?? "", /Resumed implementation session \(same conversation\)/);
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
  assert.deepEqual(chain(w, "conv").map((s) => [s.id, s.phase, s.continuation?.via ?? null, s.continuation?.evidence ?? null]), [["conv", "ended", null, null], ["conv#2", "ended", "hook", null], ["conv#3", "live", "tool", "toolu_third"]]);
  assert.equal(book(w).sessions["conv#3"].characterId, "pepper"); assert.equal(team(w).length, rows);
  assert.deepEqual(crewHistoryProblems({ ...book(w), sessions: settled } as Book, book(w)), []);
  await refresh(w);
  sound(w);
});

await test("restart recovery: the chain, the robots and the outcomes are read back; nothing is duplicated or relaunched", async () => {
  const repo = makeRepo("repo-restart");
  const w = boot(repo, "tt-restart");
  setRows(w, [row("04.1", "working"), row("04.2", "review")]);
  launch(w, "conv", "04.1"); launch(w, "rev", "04.2", "review", "tester");
  await refresh(w);
  finish(w, "conv", "04.1", "DONE: first");
  subStart(w, "conv"); // resumed: conv#2 is live when the kitchen stops
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

console.log(`${passed} crew runtime scenarios passed (synthetic hooks and transcripts, temporary HOME; no native session). Artifacts: ${tmp}`);
