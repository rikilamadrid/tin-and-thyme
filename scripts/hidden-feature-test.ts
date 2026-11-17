// Ticket 06.2: hiding Feature 02 from the kitchen's work surfaces. Drives a real PathfinderRun with synthetic hook
// payloads (shaped as Claude Code sends them), fixture transcripts, a fake engine and a temporary HOME, then reads
// what a browser is sent: the visible snapshot and the event feed. Nothing touches a live kitchen.
//
//   npx tsx scripts/hidden-feature-test.ts

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "tt-hidden-")));
// Every ~/.controlroom write lands here.
Object.assign(process.env, { HOME: tmp, USERPROFILE: tmp });
// The UI stores read localStorage and the page URL when they load.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear() },
});
Object.assign(globalThis, { location: { href: "http://127.0.0.1/" } });

const { Hub } = await import("../server/hub");
const { COORDINATOR_ID, PathfinderRun } = await import("../server/pathfinder");
const { featureOf, hiddenFeaturesFor, hiddenIn, visibleEvent, visibleFeed, visibleSnapshot } = await import("../server/hiddenFeatures");
const { buildGalley } = await import("../src/galley/model");
const { selectAttention } = await import("../src/store/office");
const { cueState } = await import("../src/audio/cues");
import type { OfficeEvent } from "../src/data/source";
import type { OfficeSnapshot } from "../src/data/types";
type Run = InstanceType<typeof PathfinderRun>;
type HubT = InstanceType<typeof Hub>;

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

// ---------------------------------------------------------------- fixtures (the coordinator-attention-test shapes)

const brief = (key: string, session = "implementation", role = "developer") =>
  `Pathfinder worker brief — ${key} Ticket ${key} (context/tickets/${key}-x.md)\n\nSession:   ${session}\nRole:      ${role}\nModel:     inherited\nEffort:    inherited\nWorktree:  /work/.pathfinder/worktrees/${key}\n`;

interface World {
  root: string;
  coord: string;
  hub: HubT;
  run: Run;
}

function makeRepo(name: string, specs: string[]) {
  const root = join(tmp, name);
  const engineDir = join(root, "skills", "orchestrate", "engine", "bin");
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(join(root, "context", "features"), { recursive: true });
  for (const spec of specs) writeFileSync(join(root, "context", "features", spec), `# ${spec}\n`);
  writeFileSync(join(root, "context", "execution-mode.md"), "<!-- pathfinder:execution-mode orchestrator -->\n");
  writeFileSync(
    join(engineDir, "orchestrate.mjs"),
    `import { readFileSync } from "node:fs";\nconst rows = JSON.parse(readFileSync(${JSON.stringify(join(root, "rows.json"))}, "utf8"));\nprocess.stdout.write(JSON.stringify({ ok: true, store: "local", rows }));\n`,
  );
  const coord = join(tmp, `${name}-session.jsonl`);
  writeFileSync(coord, "");
  mkdirSync(join(coord.replace(/\.jsonl$/, ""), "subagents"), { recursive: true });
  return { root, coord, engine: join(engineDir, "orchestrate.mjs") };
}

function boot(repo: { root: string; coord: string; engine: string }, slug: string, rows?: Record<string, unknown>[]): World {
  if (rows) writeFileSync(join(repo.root, "rows.json"), JSON.stringify(rows));
  const config = { project: { id: slug, name: slug, path: repo.root }, team: [PathfinderRun.coordinatorConfig(repo.root)], workflow: {} } as never;
  const hub = new Hub({ root: repo.root, name: slug, originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false }, slug, config, { boards: [], tasks: [] }, {} as never);
  hub.persist = false;
  hub.setSession(COORDINATOR_ID, { state: "running" });
  const inbox = { noteHook() {}, finishTurn() {}, takeForStop: () => null } as never;
  const sessions = { typeInto: async () => true } as never;
  const run = new PathfinderRun(hub, inbox, sessions, { mode: "orchestrator", engine: repo.engine }, 7999, "token", "/orchestrate start");
  run.start();
  run.stop();
  return { root: repo.root, coord: repo.coord, hub, run };
}

const row = (key: string, state: string, extra: Record<string, unknown> = {}) => ({ worker: key, key, lifecycle: "In Progress", state, where: "—", gate: "—", last: "—", title: `Ticket ${key}`, ...extra });
const stateFile = (w: World, key: string, lines: Record<string, string>) => {
  const dir = join(w.root, ".pathfinder", "worktrees", key, "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current-ticket.md"), `# Current Ticket\n\n${Object.entries(lines).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`);
};
const subDir = (w: World) => join(w.coord.replace(/\.jsonl$/, ""), "subagents");
function writeSub(w: World, agentId: string, opts: { prompt: string; toolUseId: string; finished?: boolean; report?: string }) {
  const recs: unknown[] = [{ parentUuid: null, isSidechain: true, agentId, type: "user", message: { role: "user", content: opts.prompt }, timestamp: new Date().toISOString() }];
  if (opts.report)
    recs.push({ isSidechain: true, agentId, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "SubagentHandback", input: { message: opts.report } }] }, timestamp: new Date().toISOString() });
  writeFileSync(join(subDir(w), `agent-${agentId}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(subDir(w), `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "", toolUseId: opts.toolUseId, ...(opts.finished ? { finished: true } : {}) }));
}
const hook = (w: World, event: string, body: Record<string, unknown>) => w.run.onHook(event, { session_id: "s", transcript_path: w.coord, cwd: w.root, hook_event_name: event, ...body });
function launch(w: World, agentId: string, key: string, session = "implementation", role = "developer") {
  const p = brief(key, session, role);
  hook(w, "PreToolUse", { tool_name: "Agent", tool_use_id: `tu_${agentId}`, tool_input: { prompt: p, description: `${key} ${session}`, subagent_type: "general-purpose", run_in_background: true } });
  hook(w, "PostToolUse", { tool_name: "Agent", tool_use_id: `tu_${agentId}`, tool_input: { prompt: p }, tool_response: { isAsync: true, status: "async_launched", agentId, prompt: p } });
  writeSub(w, agentId, { prompt: p, toolUseId: `tu_${agentId}` });
  hook(w, "SubagentStart", { agent_id: agentId, agent_type: "general-purpose" });
  hook(w, "PostToolUse", { agent_id: agentId, agent_type: "general-purpose", tool_name: "Bash", tool_use_id: `tu_${agentId}_git`, tool_input: { command: "git status" }, tool_response: { stdout: "" } });
}
function stopWith(w: World, agentId: string, key: string, report: string, session = "implementation", role = "developer") {
  writeSub(w, agentId, { prompt: brief(key, session, role), toolUseId: `tu_${agentId}`, report, finished: true });
  hook(w, "SubagentStop", { agent_id: agentId, agent_type: "general-purpose", agent_transcript_path: join(subDir(w), `agent-${agentId}.jsonl`), last_assistant_message: report, stop_hook_active: false });
}
function coordinatorTurnEnded(w: World) {
  writeFileSync(w.coord, JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Dispatched. Waiting." }] } }) + "\n");
  hook(w, "Stop", { stop_hook_active: false, last_assistant_message: "Waiting." });
}
const refresh = (w: World) => (w.run as unknown as { refresh(): Promise<void> }).refresh();
type WorkerView = { key: string; hqId: string; live: boolean; occurrence: string };
const workers = (w: World) => (w.run as unknown as { workers: Map<string, WorkerView> }).workers;
const hqOf = (w: World, agentId: string) => workers(w).get(agentId)!.hqId;
type BookSession = { id: string; ticket: string | null; phase: string; characterId: string | null };
const crewBook = (w: World) => (w.run as unknown as { crew: { book: { sessions: Record<string, BookSession> } } }).crew.book;
const characterOf = (w: World, agentId: string) => crewBook(w).sessions[workers(w).get(agentId)!.occurrence]?.characterId ?? null;
/** What a browser is sent right now. */
const view = (w: World): OfficeSnapshot => visibleSnapshot(w.hub.snap, hiddenIn(w.hub.snap, w.hub.hiddenFeatures));
const mentions02 = (s: OfficeSnapshot) => JSON.stringify({ boards: s.boards, tasks: s.tasks, items: s.actionItems, delivery: s.delivery?.byKey, plan: s.workflow?.plan, handoffs: s.workflow?.handoffs });

// ================================================================ pure units

eq("unit: Feature of 02.1, 2.1 and 10.1", [featureOf("02.1"), featureOf("2.1"), featureOf("10.1")], ["02", "02", "10"]);
{
  const none = makeRepo("repo-other", ["02-other-feature.md", "10-x.md"]);
  eq("unit: another project's Feature 02 is never hidden (only the harness-accounts spec is suppressed)", [...hiddenFeaturesFor(none.root)], []);
  eq("unit: a project with no features folder hides nothing", [...hiddenFeaturesFor(join(tmp, "nowhere"))], []);
}

// ================================================================ a kitchen with Feature 02 hidden

const QUESTION = "Which account should the live check use?";
const repo = makeRepo("repo-hidden", ["02-harness-accounts.md", "10-x.md"]);
const rows = [row("02.1", "human-gate", { gate: QUESTION }), row("02.2", "ready"), row("10.1", "working")];
const w = boot(repo, "tt-hidden", rows);
stateFile(w, "02.1", { State: "human-gate", Gate: QUESTION, Next: "await the human" });
const recordBefore = [readFileSync(join(repo.root, "rows.json"), "utf8"), readFileSync(join(repo.root, ".pathfinder", "worktrees", "02.1", "context", "current-ticket.md"), "utf8")];

eq("setup: this project's Feature 02 is the suppressed one", [...w.hub.hiddenFeatures], ["02"]);

// Past the crew book's reattach window, so each session wears a robot as soon as it starts.
(w.run as unknown as { startedAt: number }).startedAt = 0;
await refresh(w);
// 02.1's developer raised its gate and stopped; then the same character's next session picks up 10.1 and runs.
launch(w, "a021", "02.1");
stopWith(w, "a021", "02.1", `GATE: ${QUESTION}`);
launch(w, "a101", "10.1");
w.hub.snap.workflow!.plan = { at: new Date().toISOString(), outcome: "planned", dispatch: ["02.2", "10.1"], deferred: [{ key: "02.1", reason: "gate open" }] };
await refresh(w);
coordinatorTurnEnded(w);
await refresh(w);

const h021 = hqOf(w, "a021");
const h101 = hqOf(w, "a101");
const raw = w.hub.snap;
const seen = view(w);

// -- Pathfinder's record and the kitchen's own state stay exactly as they are.
check("engine state: rows and 02.1's state file are byte-for-byte unchanged", JSON.stringify([readFileSync(join(repo.root, "rows.json"), "utf8"), readFileSync(join(repo.root, ".pathfinder", "worktrees", "02.1", "context", "current-ticket.md"), "utf8")]) === JSON.stringify(recordBefore));
const gateRaw = (raw.actionItems ?? []).find((i) => i.id === "gate-02.1");
eq("gate: Feature 02's gate stays open and unresolved in the kitchen's own state", [gateRaw?.status, gateRaw?.closedAt, gateRaw?.answer ?? null], ["open", null, null]);
eq("kitchen state: 02.x tasks and board are still held (only the browser's view changes)", [raw.tasks.map((t) => t.id).sort(), raw.boards.map((b) => b.id).sort()], [["02.1", "02.2", "10.1"], ["F02", "F10"]]);
check("history kept: the crew book still records the finished 02.1 session", Object.values(crewBook(w).sessions).some((s) => s.ticket === "02.1" && s.phase === "ended"));

// -- The surfaces a browser is sent.
eq("tabs/boards/wall board: Feature 02's board is absent", seen.boards.map((b) => b.id), ["F10"]);
eq("ticket cards: 02.x tasks are absent", seen.tasks.map((t) => t.id), ["10.1"]);
eq("action items: the 02.1 gate is absent", (seen.actionItems ?? []).map((i) => i.id), []);
eq("attention counts: nothing counts for Feature 02 (top bar and galley)", [selectAttention(seen).total, buildGalley(seen).needsCount], [0, 0]);
check("attention counts: the raw state would have counted it (the test sees the gate)", selectAttention(raw).total > 0, selectAttention(raw));
eq("galley: no 02.x ticket card, gate or next-round queue entry", [buildGalley(seen).tickets.map((t) => t.key), buildGalley(seen).gates, buildGalley(seen).nextRound], [["10.1"], [], []]);
eq("transporter/pending work: the plan keeps only 10.1", [seen.workflow?.plan?.dispatch, seen.workflow?.plan?.deferred], [["10.1"], []]);
eq("sounds: no open decision a cue could sound for", [...cueState(seen).decisions], []);
check("notifications: no activity line names 02.1 or 02.2", !seen.activity.some((e) => /\b02\.[12]\b/.test(e.text)), seen.activity.map((e) => e.text));
check("notifications: the raw activity did name 02.1 (the gate notice)", raw.activity.some((e) => e.text.startsWith("02.1 needs your decision")));
eq("hidden is its own state: shown as Hidden, never Cancelled or Complete", seen.workflow?.hidden, [{ feature: "02", state: "hidden", tickets: 2 }]);
check("hidden is not a lifecycle: no visible task's lifecycle says Cancelled or Complete because of it", seen.tasks.every((t) => t.pf?.lifecycle === "In Progress"));
check("snapshot surfaces: nothing of Feature 02 remains in boards, tasks, items, delivery, plan or handoffs", !/"0?2\.\d|"F02"/.test(mentions02(seen)), mentions02(seen));

// -- Sessions: finished hidden ones leave the crew and activity; live ones never do.
eq("crew: the finished 02.1 session's row and status are absent", [seen.config.team.some((a) => a.id === h021), seen.agents.some((a) => a.agentId === h021)], [false, false]);
eq("crew: the live 10.1 session is shown", [seen.config.team.some((a) => a.id === h101), seen.agents.find((a) => a.agentId === h101)?.session.state], [true, "running"]);
check("floor labels: the galley crew has the 10.1 session and no 02.1 one", buildGalley(seen).crew.some((c) => c.id === h101 && c.ticket === "10.1") && !buildGalley(seen).crew.some((c) => c.ticket === "02.1"), buildGalley(seen).crew.map((c) => [c.id, c.ticket]));
check("activity: nothing from the finished 02.1 session", !seen.activity.some((e) => e.agentId === h021));
const crewSeen = seen.workflow?.crew;
check("workflow.crew: the 02.1 session left the history projection", !!crewSeen && !crewSeen.history.some((s) => s.ticket === "02.1"), crewSeen?.history.map((s) => s.ticket));
check("workflow.crew: the live 10.1 session is current", !!crewSeen?.current.some((s) => s.ticket === "10.1"), crewSeen?.current.map((s) => s.ticket));
check("workflow.crew: no character shows a 02.x ticket", !!crewSeen && !crewSeen.characters.some((c) => c.ticket?.startsWith("02.") || c.badge?.ticket?.startsWith("02.")), crewSeen?.characters.map((c) => [c.id, c.ticket]));
eq("same character: the 02.1 and 10.1 sessions wore the same robot", characterOf(w, "a021") !== null && characterOf(w, "a021") === characterOf(w, "a101"), true);
check("same character: its unrelated current session stays visible", !!crewSeen?.characters.some((c) => c.id === characterOf(w, "a101") && c.ticket === "10.1"), crewSeen?.characters.map((c) => [c.id, c.ticket, c.state]));

// -- The coordinator: the hidden gate doesn't make it ask; a live worker means it waits.
eq("coordinator: not \"Needs you\" for a hidden gate while a worker runs", [raw.agents.find((a) => a.agentId === COORDINATOR_ID)?.state, raw.agents.find((a) => a.agentId === COORDINATOR_ID)?.relaying ?? null], ["waiting", null]);

// ================================================================ the event feed: refreshes and reconnects agree

{
  const sent: OfficeEvent[] = [];
  const stop = visibleFeed(w.hub, (e) => sent.push(e));
  const first = sent[0];
  check("feed: the first message is the visible snapshot", first?.type === "snapshot" && JSON.stringify(first.snapshot) === JSON.stringify(view(w)));
  const again: OfficeEvent[] = [];
  const stop2 = visibleFeed(w.hub, (e) => again.push(e));
  check("reconnect: a second connection gets the same snapshot", JSON.stringify(again[0]) === JSON.stringify(first));
  stop2();
  sent.length = 0;
  // Hidden things the kitchen keeps emitting are not sent.
  w.hub.activity("agent.needs-input", COORDINATOR_ID, `02.1 needs your decision: ${QUESTION}`);
  w.hub.emit({ type: "action.updated", item: gateRaw! });
  w.hub.emit({ type: "task.updated", task: raw.tasks.find((t) => t.id === "02.2")! });
  w.hub.emit({ type: "board.updated", board: raw.boards.find((b) => b.id === "F02")! });
  w.hub.terminal(h021, "old output");
  eq("feed: hidden activity, gate, task, board and terminal events are not sent", sent, []);
  w.hub.activity("task.assigned", h101, "10.1 moved todo → in-progress");
  eq("feed: unrelated events still are", sent.map((e) => e.type), ["activity"]);
  sent.length = 0;

  // A live session on a hidden ticket is never hidden: it, its ticket, its gate and its board come back.
  launch(w, "a021r", "02.1", "repair");
  await refresh(w);
  const h021r = hqOf(w, "a021r");
  const back = sent.filter((e) => e.type === "snapshot").at(-1);
  check("live: a new 02.1 session sends a fresh snapshot", !!back);
  const live = view(w);
  check("live: the live 02.1 session is shown", live.agents.some((a) => a.agentId === h021r && a.session.state === "running") && live.config.team.some((a) => a.id === h021r));
  eq("live: its ticket, gate and board are shown again (02.2 stays hidden)", [live.tasks.map((t) => t.id).sort(), (live.actionItems ?? []).map((i) => i.id), live.boards.map((b) => b.id)], [["02.1", "10.1"], ["gate-02.1"], ["F02", "F10"]]);
  check("live: the event feed's snapshot is the visible one", back?.type === "snapshot" && JSON.stringify(back.snapshot.tasks.map((t) => t.id).sort()) === JSON.stringify(["02.1", "10.1"]));
  check("live: the earlier finished 02.1 session is still not shown as current crew", !live.config.team.some((a) => a.id === h021) || live.agents.find((a) => a.agentId === h021)?.session.state !== "running");
  sent.length = 0;

  // It finishes: Feature 02 leaves the surfaces again, and the browser is told with a full snapshot.
  stopWith(w, "a021r", "02.1", `GATE: ${QUESTION}`, "repair");
  await refresh(w);
  const gone = sent.filter((e) => e.type === "snapshot").at(-1);
  check("finished: the browser gets a snapshot without Feature 02", gone?.type === "snapshot" && gone.snapshot.tasks.every((t) => featureOf(t.id) !== "02") && !gone.snapshot.agents.some((a) => a.agentId === h021r), gone?.type === "snapshot" ? gone.snapshot.tasks.map((t) => t.id) : sent.map((e) => e.type));
  check("finished: no event after it names a hidden ticket or session", sent.slice(sent.indexOf(gone!) + 1).every((e) => !JSON.stringify(e).includes(h021r) && !/"02\.\d"/.test(JSON.stringify(e))), sent.slice(sent.indexOf(gone!) + 1).map((e) => e.type));
  const repairChar = characterOf(w, "a021r");
  const chars = view(w).workflow?.crew?.characters ?? [];
  check("finished: the robot that wore the 02.1 repair keeps its place but shows no 02.x session", !!repairChar && chars.some((c) => c.id === repairChar && c.sessionId === null && c.ticket === null) && !chars.some((c) => c.ticket?.startsWith("02.")), chars.map((c) => [c.id, c.state, c.ticket]));
  check("finished: the crew book still holds both 02.1 sessions", Object.values(crewBook(w).sessions).filter((s) => s.ticket === "02.1" && s.phase === "ended").length === 2);
  stop();
}
{
  // visibleEvent unit: a workflow update is filtered the same way the snapshot is.
  const h = hiddenIn(w.hub.snap, w.hub.hiddenFeatures);
  const wf = visibleEvent({ type: "workflow.updated", workflow: w.hub.snap.workflow! }, h, w.hub.snap);
  check("feed: a workflow update carries the hidden list and no 02.x plan entry", wf?.type === "workflow.updated" && wf.workflow.hidden?.[0]?.feature === "02" && !(wf.workflow.plan?.dispatch ?? []).some((k) => k.startsWith("02.")));
}

// ================================================================ a server restart

{
  const before = view(w);
  const w2 = boot(repo, "tt-hidden");
  await refresh(w2);
  const after = view(w2);
  eq("restart: Feature 02 is still hidden from boards, tasks and action items", [after.boards.map((b) => b.id), after.tasks.map((t) => t.id), (after.actionItems ?? []).map((i) => i.id)], [before.boards.map((b) => b.id), before.tasks.map((t) => t.id), (before.actionItems ?? []).map((i) => i.id)]);
  eq("restart: the gate is still open in the kitchen's own state", (w2.hub.snap.actionItems ?? []).find((i) => i.id === "gate-02.1")?.status, "open");
  check("restart: no finished 02.1 session in the crew it shows", !after.config.team.some((a) => a.crew?.ticket === "02.1") && !(after.workflow?.crew?.history ?? []).some((s) => s.ticket === "02.1"));
  eq("restart: hidden is still shown as Hidden", after.workflow?.hidden?.map((x) => [x.feature, x.state]), [["02", "hidden"]]);
  eq("restart: attention counts stay clear of Feature 02", selectAttention(after).items.length, 0);
}

// ================================================================ a project whose Feature 02 isn't suppressed

{
  const other = makeRepo("repo-plain", ["02-other-feature.md"]);
  const wo = boot(other, "tt-plain", [row("02.1", "human-gate", { gate: QUESTION })]);
  stateFile(wo, "02.1", { State: "human-gate", Gate: QUESTION });
  await refresh(wo);
  const seenOther = view(wo);
  eq("other project: its Feature 02 board, ticket and gate are all shown", [seenOther.boards.map((b) => b.id), seenOther.tasks.map((t) => t.id), (seenOther.actionItems ?? []).map((i) => i.id)], [["F02"], ["02.1"], ["gate-02.1"]]);
  eq("other project: no hidden list", seenOther.workflow?.hidden ?? [], []);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
