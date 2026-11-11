// The Pass · a fixed "busy run" scene for checking the galley layout (`?fixture=busy`).
//
// A sample Pathfinder orchestration with every place in the room in use: the
// head chef working, three cooks at prep pods (one asking), a ticket waiting for
// a cook, a tester and an adversary at the pass, and two finished cooks in the
// lounge (one at a handoff gate). It is labelled as a fixture in the toolbar,
// never connects to a server, and every action is a no-op.

import { SETTLE_MS } from "../../audio/settle";
import { assignCharacter, type CharacterId } from "../crew";
import { presets } from "../mock/presets";
import { World } from "../mock/world";
import type { OfficeDataSource } from "../source";
import { handoffScript } from "./handoffFixture";
import type { ActionItem, ActivityEvent, AgentConfig, AgentStatus, OfficeSnapshot, Task } from "../types";

export const FIXTURES = ["busy", "sounds", "handoff"] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** How the toolbar names each fixture. */
export const FIXTURE_LABEL: Record<FixtureName, string> = { busy: "busy layout", sounds: "sound audition", handoff: "crew transporter handoff" };

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

interface Seat {
  id: string;
  role: string;
  session: string | null;
  ticket: string | null;
  state: AgentStatus["state"];
  running: boolean;
  note: string | null;
  ctx: number | null;
  /** [model, effort, source]; null = no telemetry at all. */
  tel: [string | null, string | null, "observed" | "configured"] | null;
}

const FIN = "Session finished — report handed to the coordinator";
const PAUSE_CHANGE_FIXTURE =
  "Add `orchestrate pause <key> --request | --status` and one step in worker-brief.md: after each tool call, if a pause is requested, record Last and Next, report PAUSED and end the session.";
const ROSTER: Seat[] = [
  { id: "coordinator", role: "orchestrator", session: null, ticket: null, state: "working", running: true, note: "Running the pass", ctx: 0.41, tel: ["claude-opus-5-5", "high", "observed"] },
  { id: "w-29-12", role: "developer", session: "implementation", ticket: "29.12", state: "working", running: true, note: "Edit: src/ui/Toast.tsx", ctx: 0.62, tel: ["claude-sonnet-5-5", "medium", "observed"] },
  { id: "w-18-5", role: "developer", session: "repair", ticket: "18.5", state: "needs-input", running: true, note: "Asking: page size 50 or 100?", ctx: 0.88, tel: ["claude-opus-5-5", "xhigh", "observed"] },
  { id: "w-18-10", role: "developer", session: "implementation", ticket: "18.10", state: "working", running: true, note: "Bash: npm test", ctx: null, tel: null },
  { id: "w-29-10", role: "tester", session: "review", ticket: "29.10", state: "working", running: true, note: "Browser checks", ctx: 0.35, tel: ["claude-haiku-5-5", "low", "observed"] },
  { id: "w-29-11", role: "adversary", session: "adversary", ticket: "29.11", state: "working", running: true, note: "Probing edge cases", ctx: 0.27, tel: ["claude-opus-5-5", "max", "observed"] },
  { id: "w-21-3", role: "developer", session: "implementation", ticket: "21.3", state: "idle", running: false, note: FIN, ctx: 0.97, tel: ["claude-sonnet-5-5", "medium", "observed"] },
  { id: "w-28-8", role: "developer", session: "implementation", ticket: "28.8", state: "idle", running: false, note: FIN, ctx: null, tel: ["claude-sonnet-5-5", null, "configured"] },
  { id: "w-20-3", role: "developer", session: "repair", ticket: "20.3", state: "idle", running: false, note: FIN, ctx: 0.54, tel: ["claude-opus-5-5", "high", "observed"] },
  { id: "w-29-9", role: "integrator", session: "integration", ticket: "29.9", state: "idle", running: false, note: FIN, ctx: null, tel: null },
];

const TICKETS: [id: string, title: string, state: string, lifecycle: string][] = [
  ["19.7", "Offline banner copy", "ready", "Ready"],
  ["20.2", "Deck import progress", "ready", "Proposed"],
  ["18.10", "Retry failed card sync", "working", "In Progress"],
  ["18.5", "Paginate legacy cards sync", "repair", "In Progress"],
  ["29.12", "Toast focus ring follow-up", "working", "In Progress"],
  ["21.3", "Trade history filters", "human-gate", "In Progress"],
  ["20.3", "Deck list empty state", "working", "In Progress"],
  ["28.8", "Binder sort menu", "working", "In Progress"],
  ["29.10", "Scan sheet keyboard trap", "review", "In Review"],
  ["29.11", "Price chart empty state", "adversary", "In Review"],
  ["29.9", "Collection search debounce", "integrated", "Done"],
  ["29.8", "Card detail skeleton", "integrated", "Done"],
];

function agent(seat: Seat, taken: CharacterId[], sandbox: AgentConfig["sandbox"]): AgentConfig {
  const c = assignCharacter(seat.role, taken);
  taken.push(c.id);
  return {
    id: seat.id,
    name: c.name,
    role: seat.role,
    isLead: seat.role === "orchestrator",
    cli: "claude",
    model: "",
    mode: "local",
    color: "#29adff",
    skills: [],
    roleMd: `Fixture ${seat.session ?? "coordinator"} session (${seat.role}).`,
    sandbox: structuredClone(sandbox),
    workspacePath: seat.ticket ? `/fixture/.pathfinder/worktrees/${seat.ticket}` : "/fixture",
    mcp: [],
    crew: { character: c.id, job: c.job, role: seat.role, session: seat.session, ticket: seat.ticket, worktree: seat.ticket ? `/fixture/.pathfinder/worktrees/${seat.ticket}` : null },
  };
}

export function busySnapshot(): OfficeSnapshot {
  const base = World.initialSnapshot(presets[0]);
  const taken: CharacterId[] = [];
  const team = ROSTER.map((s) => agent(s, taken, base.config.team[0].sandbox));
  const agents: AgentStatus[] = ROSTER.map((s) => ({
    agentId: s.id,
    state: s.state,
    currentTaskId: s.ticket,
    stateSince: ago(4),
    note: s.note,
    session: { state: s.running ? "running" : "stopped", detail: s.running ? null : "Session finished", workspace: s.ticket ? `/fixture/.pathfinder/worktrees/${s.ticket}` : "/fixture", sandbox: null },
    context: s.ctx === null ? null : { used: Math.round(s.ctx * 200_000), limit: 200_000 },
    telemetry: s.tel ? { model: s.tel[0], effort: s.tel[1], source: s.tel[2] } : null,
    ended: s.running || !s.session ? null : s.ticket === "21.3" ? { outcome: "gate", next: null, result: "push/draft-PR handoff after the Developer phase", at: ago(6) } : { outcome: "handed-off", next: "adversary", result: "DONE (fixture)", at: ago(8) },
    // Fixture: context alerts at the default 35% for running workers, and each kind of Fresh context answer.
    contextAlert: s.running && s.session && s.ctx !== null && s.ctx * 100 >= 35 ? { pct: Math.round(s.ctx * 100), threshold: 35 } : null,
    fresh: !s.session
      ? null
      : s.running
        ? { can: false, reason: "Fixture: this session is still running, so it isn't interrupted (Pathfinder has no safe pause for a running worker).", pathfinderChange: PAUSE_CHANGE_FIXTURE }
        : s.ticket === "21.3"
          ? { can: false, reason: "Fixture: 21.3 is waiting at a human gate; Pathfinder won't resume a gated claim." }
          : { can: true, reason: "Fixture: the session has stopped. In a live run this saves a checkpoint and asks Pathfinder to resume the ticket; here nothing is sent." },
  }));
  const tasks: Task[] = TICKETS.map(([id, title, state, lifecycle]) => ({
    id, boardId: "fixture", title, ownerId: ROSTER.find((s) => s.ticket === id)?.id ?? null,
    status: state === "integrated" ? "done" : state === "ready" ? "todo" : state === "review" || state === "adversary" ? "in-review" : "in-progress",
    needs: [], prNumber: null,
    pf: { state, lifecycle, role: null, gate: state === "human-gate" ? "push/draft-PR handoff after the Developer phase" : null },
  }));
  const actionItems: ActionItem[] = [
    { id: "gate-21.3", fromId: "w-21-3", taskId: "21.3", title: "21.3 needs your decision", details: "push/draft-PR handoff after the Developer phase (fixture)", waiting: true, status: "open", note: null, at: ago(6), closedAt: null },
  ];
  const lines: [ActivityEvent["type"], string | null, string, number][] = [
    ["agent.needs-input", "w-18-5", "Roux asks: page size 50 or 100? (fixture)", 1],
    ["task.started", "w-29-11", "Pinch (adversary) started on 29.11", 2],
    ["task.started", "w-29-10", "Dash (tester) started review of 29.10", 3],
    ["task.started", "w-18-10", "Ember (developer) started 18.10", 5],
    ["agent.needs-input", "w-21-3", "21.3 needs your decision: push/draft-PR handoff", 6],
    ["review.started", "w-28-8", "Crumb finished 28.8; the coordinator takes the handoff", 8],
    ["task.started", "w-29-12", "Pepper (developer) started 29.12", 9],
    ["task.assigned", "coordinator", "Coordinator ran engine `next`", 10],
    ["pr.merged", null, "29.9 integrated into main", 14],
    ["pr.merged", null, "29.8 integrated into main", 21],
    ["session", "coordinator", "Basil started (Claude Code, Local mode)", 25],
  ];
  const activity: ActivityEvent[] = lines.map(([type, agentId, text, min], i) => ({ id: `fx-${i}`, at: ago(min), type, agentId, text }));
  return {
    ...base,
    config: { ...base.config, project: { ...base.config.project, name: "sample-app (fixture)" }, team },
    agents,
    boards: [{ id: "fixture", title: "Tin & Thyme fixture · busy run", status: "active", order: 0 }],
    tasks,
    pullRequests: [],
    actionItems,
    activity,
    messages: [],
    workflow: {
      kind: "pathfinder", mode: "orchestrator", store: "fixture", contextAlertPct: 35, handoffs: {},
      // Fixture: three delegated helpers occupying the subagent stations.
      helpers: [
        { id: "h1", label: "Find every card-sync call site", type: "Explore" },
        { id: "h2", label: "Check 29.10 screenshots against the spec", type: "general-purpose" },
        { id: "h3", label: "Plan the 18.10 retry policy", type: "Plan" },
      ],
      roles: ["adversary", "developer", "integrator", "orchestrator", "planner", "tester"].map((name) => ({ name, description: `${name} (fixture)` })),
    },
  };
}

type Emit = Parameters<OfficeDataSource["connect"]>[0];
type Status = NonNullable<Parameters<OfficeDataSource["connect"]>[1]>;

/**
 * The sound audition script: real-shaped store events, one cue per step, then
 * three steps that must stay silent (a reconnect, a poll with no change, a local
 * commit and an opened PR). It loops; each loop starts from a fresh snapshot (silent).
 */
function soundScript(emit: Emit, status: Status): () => void {
  let snap = busySnapshot();
  const timers: number[] = [];
  let n = 0;
  const say = (text: string) => {
    const event: ActivityEvent = { id: `fx-s-${++n}`, at: new Date().toISOString(), type: "session", agentId: null, text: `Fixture · ${text}` };
    snap = { ...snap, activity: [event, ...snap.activity].slice(0, 50) };
    emit({ type: "activity", event });
  };
  const task = (id: string, state: string, lifecycle: string, status: Task["status"]) => {
    const t = snap.tasks.find((x) => x.id === id)!;
    const next: Task = { ...t, status, pf: { ...t.pf!, state, lifecycle } };
    snap = { ...snap, tasks: snap.tasks.map((x) => (x.id === id ? next : x)) };
    emit({ type: "task.updated", task: next });
  };
  const steps: [label: string, run: () => void][] = [
    ["1/8 Ticket moved: 19.7 goes New → Cooking", () => task("19.7", "working", "In Progress", "in-progress")],
    [
      "2/8 Handed off: Ember records 18.10's next stage and beams out",
      () => {
        const a = snap.agents.find((x) => x.agentId === "w-18-10")!;
        const at = new Date().toISOString();
        const next: AgentStatus = { ...a, state: "idle", stateSince: at, note: "Handed off — Pathfinder recorded adversary", session: { ...a.session, state: "stopped", detail: "Session finished" }, ended: { outcome: "handed-off", next: "adversary", result: "DONE (fixture)", at } };
        snap = { ...snap, agents: snap.agents.map((x) => (x.agentId === a.agentId ? next : x)) };
        emit({ type: "agent.updated", agent: next });
      },
    ],
    [
      "3/8 Needs you: a handoff gate opens on 18.10",
      () => {
        const item: ActionItem = { id: "gate-18.10", fromId: "w-18-10", taskId: "18.10", title: "18.10 needs your decision", details: "push/draft-PR handoff (fixture)", waiting: true, status: "open", note: null, at: new Date().toISOString(), closedAt: null };
        snap = { ...snap, actionItems: [...(snap.actionItems ?? []), item] };
        emit({ type: "action.updated", item });
      },
    ],
    ["4/8 Milestone reached: 29.10 passes review", () => task("29.10", "done", "In Review", "in-review")],
    ["5/8 Merged into MAIN: 29.11 integration confirmed", () => task("29.11", "integrated", "Done", "done")],
    [
      "6/8 Reconnect (should be silent)",
      () => {
        status("reconnecting");
        window.setTimeout(() => {
          emit({ type: "snapshot", snapshot: structuredClone(snap) });
          status("open");
        }, 600);
      },
    ],
    [
      "7/8 Poll with no change (should be silent)",
      () => {
        for (const t of snap.tasks) emit({ type: "task.updated", task: structuredClone(t) });
        for (const a of snap.agents) emit({ type: "agent.updated", agent: structuredClone(a) });
      },
    ],
    [
      "8/8 Local commit and an opened PR (should be silent: no merge is confirmed)",
      () => {
        const pr = { number: 412, title: "[29.12] Toast focus ring follow-up", taskId: "29.12", authorId: "w-29-12", review: "pending" as const, openComments: 0, mergeable: true, merged: false, openedAt: new Date().toISOString() };
        snap = { ...snap, pullRequests: [...snap.pullRequests, pr] };
        emit({ type: "pr.updated", pr });
      },
    ],
  ];
  // `&step=<ms>` shortens the script for automated checks.
  const STEP_MS = Math.max(800, Number(new URL(location.href).searchParams.get("step")) || 4500);
  const loop = () => {
    snap = busySnapshot();
    emit({ type: "snapshot", snapshot: structuredClone(snap) });
    say("sound audition starts. Turn on Settings → Audio → Sound effects to hear it.");
    steps.forEach(([label, run], i) => {
      timers.push(
        window.setTimeout(() => {
          say(label);
          run();
        }, SETTLE_MS + 500 + i * STEP_MS),
      );
    });
    timers.push(window.setTimeout(loop, SETTLE_MS + 500 + steps.length * STEP_MS + 1500));
  };
  status("open");
  loop();
  return () => timers.forEach((t) => window.clearTimeout(t));
}

/** A data source that shows one fixed scene (or plays the sound script). It talks to nothing; every command is ignored. */
export function createFixtureSource(name: FixtureName): OfficeDataSource {
  const target = {
    dev: undefined,
    connect(onEvent: Emit, onStatus?: Status) {
      if (name === "sounds") return soundScript(onEvent, onStatus ?? (() => {}));
      if (name === "handoff") return handoffScript(onEvent, onStatus ?? (() => {}));
      onEvent({ type: "snapshot", snapshot: busySnapshot() });
      onStatus?.("open");
      return () => {};
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop as keyof typeof t] : () => {}),
  }) as unknown as OfficeDataSource;
}
