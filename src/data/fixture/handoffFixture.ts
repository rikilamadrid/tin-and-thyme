// Tin & Thyme · the crew transporter handoff fixture (`?fixture=handoff`).
//
// A scripted Pathfinder run, shaped like the real server's events, for watching
// sessions beam in and out while tickets keep their cards:
//
//   1  a delegated helper of the coordinator finishes (it moves to Basil's history)
//   2  Pepper finishes developing 29.12: Pathfinder records "adversary" and he beams out
//   3  Sprig stops 21.3 at a human gate: the card keeps a pink Needs you after he leaves
//   4  Pinch's adversary session starts on 29.12: he beams in and heads to the scanner
//   5  together: Crumb's 28.8 session stops without a handoff (Interrupted, no success
//      cue) while Dash hands 29.10 off as done
//   6  a reconnect: a full snapshot, nothing replays
//   7  Pinch's own context and model readings update
//
// Ember (18.10) and Roux (20.3) keep developing throughout. 19.7 and 20.2 are
// "ready for next round" because the coordinator's last plan listed them.
//
// The script is keyed to a start time kept in the URL (`t0`), so a refresh
// rebuilds exactly the current state and shows the crew where it is, without
// replaying any arrival. Opening the URL without `t0` starts it again. It is
// labelled as a fixture, never connects to a server, and every action is a no-op.

import { SETTLE_MS } from "../../audio/settle";
import { CHARACTERS, type CharacterId } from "../crew";
import { presets } from "../mock/presets";
import { World } from "../mock/world";
import type { OfficeDataSource } from "../source";
import type { ActionItem, ActivityEvent, AgentConfig, AgentStatus, OfficeSnapshot, SessionEnd, Task, WorkflowHelper } from "../types";

type Emit = Parameters<OfficeDataSource["connect"]>[0];
type Status = NonNullable<Parameters<OfficeDataSource["connect"]>[1]>;

/** Before step 1 (past the cue settle window), and between steps. `&step=<ms>` shortens it for checks. */
const LEAD_MS = SETTLE_MS + 2500;
const stepMs = () => Math.max(1500, Number(new URL(location.href).searchParams.get("step")) || 7000);

interface Seat {
  id: string;
  character: CharacterId;
  role: string;
  session: string | null;
  ticket: string | null;
  running: boolean;
  note: string;
  ctx: number | null;
  tel: [string | null, string | null, "observed" | "configured"] | null;
  ended?: Omit<SessionEnd, "at">;
  /** Minutes before t0 the session ended (history only). */
  endedAgo?: number;
}

const TICKETS: [id: string, title: string, state: string, lifecycle: string, recorded: string | null][] = [
  ["18.10", "Retry failed card sync", "working", "In Progress", "working"],
  ["19.7", "Offline banner copy", "ready", "Ready", null],
  ["20.2", "Deck import progress", "ready", "Ready", null],
  ["20.3", "Deck list empty state", "working", "In Progress", "working"],
  ["21.3", "Trade history filters", "working", "In Progress", "working"],
  ["28.8", "Binder sort menu", "working", "In Progress", "working"],
  ["29.8", "Card detail skeleton", "integrated", "Complete", null],
  ["29.9", "Collection search debounce", "integrated", "Complete", null],
  ["29.10", "Scan sheet keyboard trap", "review", "In Progress", "review"],
  ["29.12", "Toast focus ring follow-up", "working", "In Progress", "working"],
];

const handed = (next: string, result: string): Omit<SessionEnd, "at"> => ({ outcome: "handed-off", next, result });

/** Everyone at t0: the coordinator, six live sessions, and the run's finished sessions (history only). */
const SEATS: Seat[] = [
  { id: "coordinator", character: "basil", role: "orchestrator", session: null, ticket: null, running: true, note: "Running the pass", ctx: 0.41, tel: ["claude-opus-5-5", "high", "observed"] },
  { id: "w-29-12-implementation-a1", character: "pepper", role: "developer", session: "implementation", ticket: "29.12", running: true, note: "Bash: pnpm test src/ui/Toast", ctx: 0.62, tel: ["claude-sonnet-5-5", "medium", "observed"] },
  { id: "w-18-10-implementation-b2", character: "ember", role: "developer", session: "implementation", ticket: "18.10", running: true, note: "Edit: src/sync/retry.ts", ctx: 0.44, tel: ["claude-sonnet-5-5", "high", "observed"] },
  { id: "w-20-3-implementation-c3", character: "roux", role: "developer", session: "implementation", ticket: "20.3", running: true, note: "Read: src/decks/DeckList.tsx", ctx: 0.31, tel: ["claude-opus-5-5", "high", "observed"] },
  { id: "w-21-3-implementation-d4", character: "sprig", role: "developer", session: "implementation", ticket: "21.3", running: true, note: "Bash: git commit -m '21.3 filters'", ctx: 0.52, tel: ["claude-sonnet-5-5", "medium", "observed"] },
  { id: "w-28-8-implementation-e5", character: "crumb", role: "developer", session: "implementation", ticket: "28.8", running: true, note: "Edit: src/binder/sort.ts", ctx: null, tel: ["claude-haiku-5-5", null, "configured"] },
  { id: "w-29-10-review-f6", character: "dash", role: "tester", session: "review", ticket: "29.10", running: true, note: "Browser checks: keyboard trap", ctx: 0.35, tel: ["claude-haiku-5-5", "low", "observed"] },
  // History: finished before t0. They are off the floor and the roster; their tickets keep them.
  { id: "w-29-10-implementation-0a", character: "mochi", role: "developer", session: "implementation", ticket: "29.10", running: false, note: "", ctx: 0.58, tel: ["claude-sonnet-5-5", "medium", "observed"], ended: handed("adversary", "DONE: draft PR #411 at 9c1e2f0 — Adversary pending"), endedAgo: 22 },
  { id: "w-29-10-adversary-0b", character: "pinch", role: "adversary", session: "adversary", ticket: "29.10", running: false, note: "", ctx: 0.21, tel: ["claude-opus-5-5", "max", "observed"], ended: handed("review", "Experiments recorded for 9c1e2f0: 3 probes, 0 regressions — Tester pending"), endedAgo: 12 },
  { id: "w-29-9-implementation-0c", character: "roux", role: "developer", session: "implementation", ticket: "29.9", running: false, note: "", ctx: 0.47, tel: ["claude-opus-5-5", "high", "observed"], ended: handed("adversary", "DONE: draft PR #405 at 51aa0d3"), endedAgo: 48 },
  { id: "w-29-9-adversary-0d", character: "pinch", role: "adversary", session: "adversary", ticket: "29.9", running: false, note: "", ctx: 0.18, tel: ["claude-opus-5-5", "max", "observed"], ended: handed("review", "Experiments recorded for 51aa0d3"), endedAgo: 40 },
  { id: "w-29-9-review-0e", character: "dash", role: "tester", session: "review", ticket: "29.9", running: false, note: "", ctx: 0.29, tel: ["claude-haiku-5-5", "low", "observed"], ended: handed("done", "PASS at 51aa0d3: all checks verified"), endedAgo: 33 },
];

/** The adversary session that starts in step 4. */
const PINCH: Seat = { id: "w-29-12-adversary-g7", character: "pinch", role: "adversary", session: "adversary", ticket: "29.12", running: true, note: "Started adversary session", ctx: 0.08, tel: ["claude-opus-5-5", "max", "configured"] };

const WT = (ticket: string | null) => (ticket ? `/fixture/.pathfinder/worktrees/${ticket}` : "/fixture");

function config(seat: Seat, sandbox: AgentConfig["sandbox"]): AgentConfig {
  const c = CHARACTERS[seat.character];
  return {
    id: seat.id, name: c.name, role: seat.role, isLead: seat.role === "orchestrator", cli: "claude", model: "", mode: "local", color: "#29adff", skills: [],
    roleMd: `Fixture ${seat.session ?? "coordinator"} session (${seat.role}).`, sandbox: structuredClone(sandbox), workspacePath: WT(seat.ticket), mcp: [],
    crew: { character: c.id, job: c.job, role: seat.role, session: seat.session, ticket: seat.ticket, worktree: seat.ticket ? WT(seat.ticket) : null },
  };
}

function status(seat: Seat, at: string): AgentStatus {
  return {
    agentId: seat.id, state: seat.running ? "working" : "idle", currentTaskId: seat.ticket, stateSince: at, note: seat.running ? seat.note : "Session finished",
    session: { state: seat.running ? "running" : "stopped", detail: seat.running ? null : "Session finished", workspace: WT(seat.ticket), sandbox: null },
    context: seat.ctx === null ? null : { used: Math.round(seat.ctx * 200_000), limit: 200_000 },
    telemetry: seat.tel ? { model: seat.tel[0], effort: seat.tel[1], source: seat.tel[2] } : null,
    ended: seat.ended ? { ...seat.ended, at } : null,
  };
}

/** The whole run after `n` steps, for a script started at `t0` (epoch ms). Pure: the same inputs give the same snapshot. */
export function handoffSnapshot(t0: number, n: number): OfficeSnapshot {
  const STEP = stepMs();
  const iso = (ms: number) => new Date(ms).toISOString();
  const stepAt = (i: number) => iso(t0 + LEAD_MS + (i - 1) * STEP);
  const base = World.initialSnapshot(presets[0]);
  const sandbox = base.config.team[0].sandbox;
  const seats = [...SEATS];
  const team = seats.map((s) => config(s, sandbox));
  let agents = seats.map((s) => status(s, s.endedAgo ? iso(t0 - s.endedAgo * 60_000) : iso(t0 - 4 * 60_000)));
  let tasks: Task[] = TICKETS.map(([id, title, state, lifecycle, recorded]) => ({
    id, boardId: "fixture", title, ownerId: null, status: state === "integrated" ? "done" : state === "ready" ? "todo" : state === "review" ? "in-review" : "in-progress",
    needs: [], prNumber: null, pf: { state, lifecycle, role: null, gate: null, recorded },
  }));
  let actionItems: ActionItem[] = [];
  let helpers: WorkflowHelper[] = [
    { id: "h0", label: "Read the dispatch plan for Feature 29", type: "Explore", parent: "coordinator", finished: true },
    { id: "h4", label: "Search toast focus-ring styles", type: "Explore", parent: "w-29-12-implementation-a1", finished: true },
    { id: "h1", label: "Find every card-sync call site", type: "Explore", parent: "coordinator" },
    { id: "h2", label: "Plan the 18.10 retry policy", type: "Plan", parent: "coordinator" },
    { id: "h3", label: "Check card-sync tests for flakes", type: "general-purpose", parent: "w-18-10-implementation-b2" },
  ];
  const activity: ActivityEvent[] = [
    { id: "fx-h-a", at: iso(t0 - 5 * 60_000), type: "task.assigned", agentId: "coordinator", text: "Dispatch plan: 19.7 eligible to claim; 20.2 waits for a later round (fixture)" },
    { id: "fx-h-b", at: iso(t0 - 60_000), type: "session", agentId: null, text: "Fixture · crew transporter handoff. Steps start in a few seconds." },
  ];
  const say = (i: number, type: ActivityEvent["type"], agentId: string | null, text: string) => activity.unshift({ id: `fx-h-${i}`, at: stepAt(i), type, agentId, text: `Fixture ${i}/7 · ${text}` });
  const agent = (id: string, patch: Partial<AgentStatus>) => (agents = agents.map((a) => (a.agentId === id ? { ...a, ...patch } : a)));
  const task = (id: string, pf: Partial<NonNullable<Task["pf"]>>, statusOf?: Task["status"]) =>
    (tasks = tasks.map((t) => (t.id === id ? { ...t, status: statusOf ?? t.status, pf: { ...t.pf!, ...pf } } : t)));
  const end = (i: number, id: string, e: Omit<SessionEnd, "at">, note: string) =>
    agent(id, { state: "idle", stateSince: stepAt(i), note, session: { state: "stopped", detail: "Session ended", workspace: agents.find((a) => a.agentId === id)!.session.workspace, sandbox: null }, ended: { ...e, at: stepAt(i) } });

  const steps: ((i: number) => void)[] = [
    (i) => {
      helpers = helpers.map((h) => (h.id === "h1" ? { ...h, finished: true } : h));
      say(i, "session", "coordinator", "Basil's helper finished “Find every card-sync call site” (now in his history)");
    },
    (i) => {
      end(i, "w-29-12-implementation-a1", handed("adversary", "DONE: draft PR #418 at 4f2c9e1 — Adversary pending"), "Handed off — Pathfinder recorded adversary");
      task("29.12", { state: "stale", recorded: "adversary" });
      say(i, "review.started", "w-29-12-implementation-a1", "Pepper handed off 29.12 (implementation); Pathfinder recorded adversary");
    },
    (i) => {
      end(i, "w-21-3-implementation-d4", { outcome: "gate", next: null, result: "Push and open the draft PR for 21.3? (run policy: local only)" }, "Stopped at a human gate");
      task("21.3", { state: "human-gate", recorded: "human-gate", gate: "Push and open the draft PR for 21.3? (run policy: local only)" });
      actionItems = [{ id: "gate-21.3", fromId: "w-21-3-implementation-d4", taskId: "21.3", title: "21.3 needs your decision", details: "Push and open the draft PR for 21.3? (fixture — nothing is sent)", waiting: true, status: "open", note: null, at: stepAt(i), closedAt: null }];
      say(i, "agent.needs-input", "w-21-3-implementation-d4", "Sprig stopped 21.3 at a human gate");
    },
    (i) => {
      team.push(config(PINCH, sandbox));
      agents = [...agents, status(PINCH, stepAt(i))];
      task("29.12", { state: "adversary", recorded: "adversary" }, "in-review");
      say(i, "task.started", PINCH.id, "Pinch (adversary) started on 29.12 — beams in and heads to the scanner");
    },
    (i) => {
      end(i, "w-28-8-implementation-e5", { outcome: "interrupted", next: null, result: "Last: editing src/binder/sort.ts (no handoff recorded)" }, "Interrupted — stopped without recording a handoff");
      task("28.8", { state: "stale", recorded: "working" });
      end(i, "w-29-10-review-f6", handed("done", "PASS at 9c1e2f0: keyboard trap fixed, focus order verified"), "Handed off — Pathfinder recorded done");
      task("29.10", { state: "done", recorded: "done" });
      say(i, "session", "w-28-8-implementation-e5", "Together: Crumb's 28.8 session was interrupted, and Dash handed 29.10 off as done");
    },
    (i) => say(i, "session", null, "Reconnect: a full snapshot arrives; nothing replays"),
    (i) => {
      agent(PINCH.id, { context: { used: 38_000, limit: 200_000 }, telemetry: { model: "claude-opus-5-5", effort: "max", source: "observed" }, note: "Probing focus-ring edge cases" });
      agent("w-18-10-implementation-b2", { context: { used: 104_000, limit: 200_000 }, note: "Bash: pnpm test src/sync" });
      agent("w-20-3-implementation-c3", { context: { used: 76_000, limit: 200_000 }, note: "Edit: src/decks/DeckList.tsx" });
      say(i, "session", PINCH.id, "Pinch's own context and model readings update. Script complete — open the URL without t0 to run it again");
    },
  ];
  for (let i = 1; i <= Math.min(n, steps.length); i++) steps[i - 1](i);

  return {
    ...base,
    config: { ...base.config, project: { ...base.config.project, name: "transporter (fixture)" }, team },
    agents,
    boards: [{ id: "fixture", title: "Tin & Thyme fixture · crew transporter handoff", status: "active", order: 0 }],
    tasks,
    pullRequests: [],
    actionItems,
    activity,
    messages: [],
    workflow: {
      kind: "pathfinder", mode: "orchestrator", store: "fixture", contextAlertPct: 90, handoffs: {}, helpers,
      plan: { at: iso(t0 - 5 * 60_000), outcome: "dispatch", dispatch: ["19.7"], deferred: [{ key: "20.2", reason: "worker limit 3 reached" }] },
      roles: ["adversary", "developer", "integrator", "orchestrator", "planner", "tester"].map((name) => ({ name, description: `${name} (fixture)` })),
    },
  };
}

export const HANDOFF_STEPS = 7;
const RECONNECT_STEP = 6;

/** Real-shaped store events for everything that changed between two snapshots. */
function emitDiff(prev: OfficeSnapshot, next: OfficeSnapshot, emit: Emit) {
  const j = (x: unknown) => JSON.stringify(x);
  if (j(prev.config) !== j(next.config)) emit({ type: "config.updated", config: structuredClone(next.config) });
  const pa = new Map(prev.agents.map((a) => [a.agentId, j(a)]));
  for (const a of next.agents) if (pa.get(a.agentId) !== j(a)) emit({ type: "agent.updated", agent: structuredClone(a) });
  const pt = new Map(prev.tasks.map((t) => [t.id, j(t)]));
  for (const t of next.tasks) if (pt.get(t.id) !== j(t)) emit({ type: "task.updated", task: structuredClone(t) });
  const pi = new Map((prev.actionItems ?? []).map((i) => [i.id, j(i)]));
  for (const i of next.actionItems ?? []) if (pi.get(i.id) !== j(i)) emit({ type: "action.updated", item: structuredClone(i) });
  if (j(prev.workflow) !== j(next.workflow) && next.workflow) emit({ type: "workflow.updated", workflow: structuredClone(next.workflow) });
  const seen = new Set(prev.activity.map((e) => e.id));
  for (const e of [...next.activity].reverse()) if (!seen.has(e.id)) emit({ type: "activity", event: e });
}

/** The script's start time, kept in the URL so a refresh resumes the same run. */
function startTime(): number {
  const url = new URL(location.href);
  const t = Number(url.searchParams.get("t0"));
  if (Number.isFinite(t) && t > 0 && t <= Date.now()) return t;
  const now = Date.now();
  url.searchParams.set("t0", String(now));
  history.replaceState(null, "", url);
  return now;
}

export function handoffScript(emit: Emit, setStatus: Status): () => void {
  const t0 = startTime();
  const STEP = stepMs();
  const due = (i: number) => t0 + LEAD_MS + (i - 1) * STEP;
  const stepsDone = () => {
    let n = 0;
    while (n < HANDOFF_STEPS && Date.now() >= due(n + 1)) n++;
    return n;
  };
  let n = stepsDone();
  let snap = handoffSnapshot(t0, n);
  emit({ type: "snapshot", snapshot: structuredClone(snap) });
  setStatus("open");
  const timers: number[] = [];
  for (let i = n + 1; i <= HANDOFF_STEPS; i++) {
    timers.push(
      window.setTimeout(() => {
        const next = handoffSnapshot(t0, i);
        n = i;
        if (i === RECONNECT_STEP) {
          setStatus("reconnecting");
          timers.push(
            window.setTimeout(() => {
              snap = next;
              emit({ type: "snapshot", snapshot: structuredClone(next) });
              setStatus("open");
            }, 700),
          );
          return;
        }
        emitDiff(snap, next, emit);
        snap = next;
      }, Math.max(0, due(i) - Date.now())),
    );
  }
  return () => timers.forEach((t) => window.clearTimeout(t));
}
