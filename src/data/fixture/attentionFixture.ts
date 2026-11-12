// Tin & Thyme · the truthful attention fixture (`?fixture=attention`, `?fixture=attention&phase=waiting`).
//
// A fixed Pathfinder run for checking ticket 06.1's states in a browser, every label from the shared
// ticket-stage mapping (src/data/ticketStage.ts):
//
//   - Action items: two open gates, one whose raising session is identified (its own GATE report) and one
//     that is not ("Unable to identify session", with the server's diagnostic);
//   - Boards and the sidebar: In review (a live tester), Waiting for review (no reviewer yet), Ready to
//     deliver, Interrupted, Needs you, Developing;
//   - worker drawers: background sessions show a read-only "Activity" tab.
//
// `phase=waiting` is the same run after both gates were answered and Pathfinder recorded them: the
// coordinator's turn ended while its workers run, so it shows "Waiting on workers", not "Needs you".
// It is labelled as a fixture, never connects to a server, and every action is a no-op.

import { CHARACTERS, type CharacterId } from "../crew";
import { presets } from "../mock/presets";
import { World } from "../mock/world";
import { ticketView } from "../ticketStage";
import type { ActionItem, ActivityEvent, AgentConfig, AgentStatus, OfficeSnapshot, SessionEnd, Task } from "../types";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const WT = (ticket: string | null) => (ticket ? `/fixture/.pathfinder/worktrees/${ticket}` : "/fixture");

interface Seat {
  id: string;
  character: CharacterId;
  role: string;
  session: string | null;
  ticket: string | null;
  running: boolean;
  note: string;
  ended?: Omit<SessionEnd, "at">;
}

const GATE_OWNED = "Which account should the live check use?";
const GATE_UNOWNED = "Approve the copy change for the empty state?";

const SEATS: Seat[] = [
  { id: "coordinator", character: "basil", role: "orchestrator", session: null, ticket: null, running: true, note: "" },
  { id: "w-31-2-implementation-a1", character: "pepper", role: "developer", session: "implementation", ticket: "31.2", running: true, note: "Edit: src/sync/retry.ts" },
  { id: "w-31-4-review-b2", character: "dash", role: "tester", session: "review", ticket: "31.4", running: true, note: "Browser checks: keyboard trap" },
  // Finished sessions: history on their tickets.
  { id: "w-31-1-implementation-c3", character: "sprig", role: "developer", session: "implementation", ticket: "31.1", running: false, note: "Stopped at a human gate", ended: { outcome: "gate", next: null, result: GATE_OWNED, verdict: "GATE" } },
  { id: "w-31-5-review-d4", character: "mochi", role: "tester", session: "review", ticket: "31.5", running: false, note: "Reported PASS", ended: { outcome: "handed-off", next: "done", result: "PASS at 51aa0d3: all checks verified", verdict: "PASS" } },
  { id: "w-31-3-review-e5", character: "roux", role: "tester", session: "review", ticket: "31.3", running: false, note: "Reported PASS", ended: { outcome: "handed-off", next: "done", result: "PASS at 9c1e2f0", verdict: "PASS" } },
  { id: "w-31-7-implementation-f6", character: "crumb", role: "developer", session: "implementation", ticket: "31.7", running: false, note: "Interrupted — stopped without recording a handoff", ended: { outcome: "interrupted", next: null, result: "Last: editing src/binder/sort.ts" } },
];

/** [key, title, engine state (gates open), engine state (after the gates were answered), lifecycle, recorded]. */
const TICKETS: [string, string, string, string, string, string | null][] = [
  ["31.1", "Live account check", "human-gate", "working", "In Progress", "human-gate"],
  ["31.2", "Retry failed card sync", "working", "working", "In Progress", "working"],
  ["31.3", "Scan sheet keyboard trap", "done", "done", "In Progress", "done"],
  ["31.4", "Toast focus ring", "review", "review", "In Progress", "review"],
  ["31.5", "Deck list empty state", "human-gate", "done", "In Progress", "human-gate"],
  ["31.6", "Offline banner copy", "review", "review", "In Progress", "review"],
  ["31.7", "Binder sort menu", "stale", "stale", "In Progress", "working"],
];

function config(seat: Seat, sandbox: AgentConfig["sandbox"]): AgentConfig {
  const c = CHARACTERS[seat.character];
  return {
    id: seat.id, name: c.name, role: seat.role, isLead: seat.role === "orchestrator", cli: "claude", model: "", mode: "local", color: "#29adff", skills: [],
    roleMd: `Fixture ${seat.session ?? "coordinator"} session (${seat.role}).`, sandbox: structuredClone(sandbox), workspacePath: WT(seat.ticket), mcp: [],
    crew: { character: c.id, job: c.job, role: seat.role, session: seat.session, ticket: seat.ticket, worktree: seat.ticket ? WT(seat.ticket) : null },
  };
}

export function attentionSnapshot(waiting: boolean): OfficeSnapshot {
  const base = World.initialSnapshot(presets[0]);
  const sandbox = base.config.team[0].sandbox;
  const team = SEATS.map((s) => config(s, sandbox));
  const name = (id: string) => CHARACTERS[SEATS.find((s) => s.id === id)!.character].name;
  const agents: AgentStatus[] = SEATS.map((s) => ({
    agentId: s.id,
    state: s.id === "coordinator" ? (waiting ? "waiting" : "needs-input") : s.running ? "working" : "idle",
    currentTaskId: s.ticket,
    stateSince: ago(4),
    note: s.id === "coordinator" ? (waiting ? "Waiting on 2 workers" : "Asking: 31.1, 31.5 need your decision") : s.note,
    relaying: s.id === "coordinator" && !waiting ? ["31.1", "31.5"] : null,
    session: { state: s.running ? "running" : "stopped", detail: s.running ? null : "Session finished", workspace: WT(s.ticket), sandbox: null },
    context: null,
    telemetry: null,
    ended: s.ended ? { ...s.ended, at: ago(10) } : null,
  }));
  const tasks: Task[] = TICKETS.map(([id, title, open, answered, lifecycle, recorded]) => {
    const state = waiting ? answered : open;
    const gate = state === "human-gate" ? (id === "31.1" ? GATE_OWNED : GATE_UNOWNED) : null;
    const live = SEATS.find((s) => s.running && s.ticket === id)?.session ?? null;
    const last = SEATS.find((s) => !s.running && s.ticket === id)?.ended?.outcome ?? null;
    const view = ticketView({ state, lifecycle, recorded, gate, liveSession: live, lastEnded: last });
    return {
      id, boardId: "fixture", title, ownerId: SEATS.find((s) => s.ticket === id)?.id ?? null, status: view.column, needs: [], prNumber: null,
      pf: { state, lifecycle, role: null, gate, recorded, view },
    };
  });
  const gateItem = (key: string, details: string, owner: string | null, session: string | null, diagnostic: string | null): ActionItem => ({
    id: `gate-${key}`, fromId: owner ?? "coordinator", taskId: key, title: `${key} needs your decision`, details,
    waiting: true, status: waiting ? "done" : "open", note: waiting ? `Pathfinder: ${key} is now ${key === "31.1" ? "working" : "done"}` : null,
    at: ago(9), closedAt: waiting ? ago(1) : null,
    request: { kind: "gate", key, stage: session ?? "review", owner, session, diagnostic, revision: `fixture-${key}` },
    answer: waiting ? { state: "recorded", text: "Use the work account (fixture)", revision: `fixture-${key}`, at: ago(1), detail: `Pathfinder recorded it: ${key} is now working` } : null,
    snoozedUntil: null,
  });
  const actionItems: ActionItem[] = [
    gateItem("31.1", `${GATE_OWNED} (fixture — nothing is sent)`, "w-31-1-implementation-c3", "implementation", null),
    gateItem(
      "31.5", `${GATE_UNOWNED} (fixture — nothing is sent)`, null, null,
      `No session on 31.5 reported this gate in its own GATE line, so Tin & Thyme can't tell who raised it (the coordinator may have recorded it). The latest, ${name("w-31-5-review-d4")} (review), ended handed-off.`,
    ),
  ];
  const lines: [ActivityEvent["type"], string | null, string, number][] = [
    ["session", null, `Fixture · truthful attention${waiting ? " (gates answered: waiting on workers)" : " (two open gates)"}`, 0],
    ["agent.needs-input", "w-31-1-implementation-c3", `${name("w-31-1-implementation-c3")} stopped 31.1 at a human gate`, 9],
    ["session", "w-31-7-implementation-f6", `${name("w-31-7-implementation-f6")}'s implementation session on 31.7 was interrupted (no handoff recorded)`, 11],
    ["review.started", "w-31-3-review-e5", `${name("w-31-3-review-e5")} reported PASS on 31.3 (review)`, 12],
  ];
  const activity: ActivityEvent[] = lines.map(([type, agentId, text, min], i) => ({ id: `fx-a-${i}`, at: ago(min), type, agentId, text }));
  return {
    ...base,
    config: { ...base.config, project: { ...base.config.project, name: "attention (fixture)" }, team },
    agents,
    boards: [{ id: "fixture", title: "Tin & Thyme fixture · truthful attention", status: "active", order: 0 }],
    tasks,
    pullRequests: [],
    actionItems,
    activity,
    messages: [],
    workflow: {
      kind: "pathfinder", mode: "orchestrator", store: "fixture", contextAlertPct: 90, handoffs: {}, helpers: [],
      roles: ["adversary", "developer", "integrator", "orchestrator", "planner", "tester"].map((r) => ({ name: r, description: `${r} (fixture)` })),
    },
  };
}
