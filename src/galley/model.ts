// The Pass · what the galley shows, derived from the snapshot alone.
//
// One source of truth: both art styles, the room, the roster and the drawer all
// read this model, so a style switch only changes how it is painted.
//
//   configured role  → listed in the roster; not in the room
//   running session  → beamed in through the transporter: at a prep pod, the pass, or the island
//   finished session → beamed out: off the floor and the roster, kept in its ticket's history
//   ticket card      → one per ticket in flight; it outlives each session and says what it waits for
//
// A worktree or claim alone never puts a robot to work: only an observed session start does.
// Empty stations stay empty: a ticket is only "ready for next round" when the coordinator's plan says so.

import { assignCharacter, CHARACTERS, characterForRole, type CharacterId } from "../data/crew";
import type { AgentConfig, AgentStatus, OfficeSnapshot, SessionEnd, SessionTelemetry, Task, TaskStatus, WorkflowHelper } from "../data/types";
import type { IconKind } from "./robots";
import { selectAttention } from "../store/office";
import { ticketView } from "../data/ticketStage";

/** `wait`: the coordinator's turn ended while workers it dispatched run (not asking you). */
export type CrewState = "needs" | "work" | "review" | "wait" | "idle" | "off";
/** "gone" = a finished workflow session: it has beamed out and lives only in its ticket's history. */
export type Place = "island" | "pod" | "pass" | "lounge" | "gone";

export interface CrewMember {
  id: string;
  character: CharacterId;
  name: string;
  job: string;
  /** The real workflow role. */
  role: string;
  session: string | null;
  ticket: string | null;
  worktree: string | null;
  state: CrewState;
  status: string;
  running: boolean;
  finished: boolean;
  context: { used: number; limit: number } | null;
  /** This session's own model and effort (observed or configured); null when unknown. */
  telemetry: SessionTelemetry | null;
  /** How a finished workflow session ended (null while running or when unknown). */
  ended: SessionEnd | null;
  place: Place;
  isLead: boolean;
  config: AgentConfig;
  agent: AgentStatus;
}

export interface Slip {
  id: string;
  boardId: string;
  title: string;
  mark: IconKind | null;
  /** True for tickets that sit in a column without a live session behind them. */
  dim: boolean;
}

export type Pod = { kind: "cook"; member: CrewMember } | { kind: "open" };

export type TicketPhase = "needs" | "live" | "waiting" | "interrupted" | "failed" | "done" | "next-round" | "stale";

/** One ticket in flight: who is on it now, what it waits for, and every session it has had. */
export interface TicketCard {
  key: string;
  title: string;
  phase: TicketPhase;
  /** What the card says, in plain words ("Waiting for adversary", "Needs you", …). */
  label: string;
  /** The stage being worked or waited for (Pathfinder's word: implementation, adversary, review, repair). */
  stage: string | null;
  /** The live session on it, if any. */
  current: CrewMember | null;
  /** Finished sessions on this ticket, oldest first. */
  history: CrewMember[];
  /** Pathfinder's gate text while the ticket waits on a human. */
  gate: string | null;
  /** True whenever a human gate is open on the ticket (it stays after the worker leaves). */
  needsYou: boolean;
  /** The verified next step and any real blocker (src/data/ticketStage.ts), when the workflow reports them. */
  next: string | null;
  blocker: string | null;
}

export interface RoleInfo {
  name: string;
  description: string;
  character: CharacterId | "cook";
  running: number;
  finished: number;
}

export interface GalleyModel {
  crew: CrewMember[];
  roles: RoleInfo[];
  columns: Slip[][];
  pods: Pod[];
  podOverflow: number;
  coordinator: CrewMember | null;
  reviewers: CrewMember[];
  lounge: CrewMember[];
  /** Tickets waiting on a human decision (workflow gates). */
  gates: string[];
  /** Tickets at the pass (review states). */
  atPass: string[];
  needsCount: number;
  queued: string[];
  served: number;
  /** Delegated helper subagents running now (from the workflow; empty when none). */
  helpers: WorkflowHelper[];
  /** Every helper this run (running and finished), grouped later by the session that launched it. */
  allHelpers: WorkflowHelper[];
  /** Tickets in flight, most urgent first. */
  tickets: TicketCard[];
  /** Tickets whose next stage is recorded and waiting for its session to start (shown at the transporter). */
  waiting: TicketCard[];
  /** Eligible tickets the coordinator's latest plan holds for another approved dispatch. */
  nextRound: string[];
  /** Finished sessions this run (all off the floor). */
  departed: number;
}

export const POD_COUNT = 5;

/** What a live session is doing, by Pathfinder session kind. */
const DOING: Record<string, string> = { implementation: "Developing", resume: "Developing (resume)", adversary: "Adversary", review: "Testing", repair: "Repairing" };
export const stageWords = (session: string | null) => (session ? DOING[session] ?? session[0].toUpperCase() + session.slice(1) : "Working");
const PENDING = new Set(["adversary", "review", "repair"]);

/** The ticket's state for the board: a pending stage the engine calls stale reads as that stage. */
function effState(t: Task): string | undefined {
  const s = t.pf?.state;
  if (s === "stale" && t.pf?.recorded && PENDING.has(t.pf.recorded)) return t.pf.recorded;
  return s;
}
const COLS = ["New", "Cooking", "At the pass", "Served"] as const;
const COLUMN_OF: Record<TaskStatus, number> = { todo: 0, blocked: 0, "in-progress": 1, "in-review": 2, reviewed: 2, done: 3 };
export const COLUMN_NAMES = COLS;

const keyNum = (k: string) => k.split(/[.-]/).map((n) => Number(n.replace(/\D/g, "")) || 0);
const byKey = (a: string, b: string) => {
  const x = keyNum(a);
  const y = keyNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The character, name and job for an agent (from the server; a stable fallback for native HQ teams). */
export function crewIdentity(snap: OfficeSnapshot, config: AgentConfig): { character: CharacterId; name: string; job: string; role: string } {
  if (config.crew) return { character: config.crew.character, name: config.name, job: config.crew.job, role: config.crew.role };
  const team = snap.config.team;
  const taken: CharacterId[] = [];
  for (const a of team) {
    const c = assignCharacter(a.isLead ? "orchestrator" : a.role, taken);
    taken.push(c.id);
    if (a.id === config.id) return { character: c.id, name: config.name, job: c.job, role: config.role };
  }
  return { character: "unit", name: config.name, job: "Crew", role: config.role };
}

function column(t: Task): number {
  // The shared mapping decides the column (reviewed tickets wait at the pass, never as "in review").
  if (t.pf?.view) return COLUMN_OF[t.pf.view.column];
  const s = effState(t);
  if (s) {
    if (s === "ready" || s === "blocked") return 0;
    if (s === "adversary" || s === "review" || s === "done") return 2;
    if (s === "integrated") return 3;
    return 1; // working, repair, stale, failed, human-gate, unknown words
  }
  return COLUMN_OF[t.status];
}

export function buildGalley(snap: OfficeSnapshot, podOf?: Map<string, number>): GalleyModel {
  const statusOf = new Map(snap.agents.map((a) => [a.agentId, a]));
  const crew: CrewMember[] = [];
  for (const config of snap.config.team) {
    const agent = statusOf.get(config.id);
    if (!agent) continue;
    const id = crewIdentity(snap, config);
    const running = agent.session.state === "running" || agent.session.state === "starting";
    const workflowSession = !!config.crew?.session;
    const isLead = config.isLead || id.character === "basil";
    const reviewRole = ["tester", "adversary", "reviewer", "qa"].includes(id.role.toLowerCase()) || config.crew?.session === "adversary" || config.crew?.session === "review";
    const ticket = config.crew?.ticket ?? agent.currentTaskId ?? null;
    let state: CrewState;
    let status: string;
    let place: Place;
    if (isLead) {
      place = "island";
      state = !running ? "off" : agent.state === "needs-input" ? "needs" : agent.state === "working" ? "work" : agent.state === "waiting" ? "wait" : "idle";
      status = !running ? "not running" : state === "needs" ? "Needs you" : state === "work" ? "running the pass" : state === "wait" ? "waiting on workers" : "on watch";
    } else if (running) {
      place = reviewRole ? "pass" : "pod";
      state = agent.state === "needs-input" ? "needs" : reviewRole ? "review" : "work";
      status = state === "needs" ? "Needs you" : reviewRole ? "at the pass" : "cooking";
    } else if (workflowSession) {
      // A finished session has beamed out: it leaves the floor and the roster and stays in its ticket's history.
      place = "gone";
      state = "off";
      const o = agent.ended?.outcome;
      status = agent.session.state === "unknown" ? "session liveness unknown" : o === "handed-off" ? "handed off" : o === "gate" ? "stopped at a human gate" : o === "failed" ? "failed" : o === "interrupted" ? "interrupted" : "finished";
    } else {
      place = "lounge";
      state = "off";
      status = "not running";
    }
    crew.push({
      id: config.id, character: id.character, name: id.name, job: id.job, role: id.role, session: config.crew?.session ?? null, ticket,
      worktree: config.crew?.worktree ?? agent.session.workspace, state, status, running, finished: !running && workflowSession && agent.session.state !== "unknown",
      context: agent.context ?? null, telemetry: agent.telemetry ?? null, ended: agent.ended ?? null, place, isLead, config, agent,
    });
  }

  // Board columns.
  const runningIds = new Set(crew.filter((c) => c.running).map((c) => c.id));
  const liveTicket = new Set(crew.filter((c) => c.running && c.ticket && !c.isLead).map((c) => c.ticket as string));
  const columns: Slip[][] = [[], [], [], []];
  const queued: string[] = [];
  const gates: string[] = [];
  const atPass: string[] = [];
  for (const t of snap.tasks) {
    const s = effState(t);
    const live = liveTicket.has(t.id) || (!!t.ownerId && runningIds.has(t.ownerId));
    let mark: IconKind | null = null;
    let dim = false;
    if (s) {
      if (s === "ready") {
        if (t.pf?.lifecycle === "Ready") {
          mark = "wait";
          queued.push(t.id);
        }
      } else if (s === "stale" && !t.pf?.recorded) {
        mark = "wait"; // claimed, waiting for its first session
      } else if (s === "blocked") mark = "lock";
      else if (s === "human-gate") {
        mark = "needs";
        gates.push(t.id);
      } else if (s === "working" || s === "repair") {
        mark = live ? "work" : "idle";
        dim = !live;
      } else if (s === "stale" || s === "failed") {
        mark = "idle";
        dim = true;
      } else if (s === "adversary" || s === "review") {
        mark = live ? "review" : "wait";
        atPass.push(t.id);
      } else if (s === "done") {
        mark = "done";
        atPass.push(t.id);
      }
    } else {
      mark = t.status === "in-progress" ? (live ? "work" : "idle") : t.status === "in-review" ? "review" : t.status === "reviewed" ? "done" : t.status === "blocked" ? "lock" : null;
      if (t.status === "in-review") atPass.push(t.id);
    }
    columns[column(t)].push({ id: t.id, boardId: t.boardId, title: t.title, mark, dim });
  }
  const rank: Record<string, number> = { needs: 0, work: 1, review: 1, wait: 2, done: 2, idle: 3, lock: 5 };
  columns.forEach((col, i) =>
    col.sort((a, b) => (i === 3 ? byKey(b.id, a.id) : (rank[a.mark ?? ""] ?? 4) - (rank[b.mark ?? ""] ?? 4) || byKey(a.id, b.id))),
  );

  // Prep pods: running cooks keep their pod (oldest session first); the rest stay open. Nothing is docked at
  // an empty pod: Pathfinder decides each round, so an open station promises nothing.
  // `podOf` keeps each cook at the pod it already has, so a departure never shuffles the others.
  const cooks = crew.filter((c) => c.place === "pod");
  const pods: Pod[] = Array.from({ length: POD_COUNT }, () => ({ kind: "open" }) as Pod);
  const placed = new Set<string>();
  for (const member of cooks) {
    const i = podOf?.get(member.id);
    if (i !== undefined && i < POD_COUNT && pods[i].kind === "open") {
      pods[i] = { kind: "cook", member };
      placed.add(member.id);
    }
  }
  for (const member of cooks) {
    if (placed.has(member.id)) continue;
    const i = pods.findIndex((p) => p.kind === "open");
    if (i < 0) break;
    pods[i] = { kind: "cook", member };
    placed.add(member.id);
  }

  // Ticket cards.
  const plan = snap.workflow?.plan ?? null;
  const planned = new Set([...(plan?.dispatch ?? []), ...(plan?.deferred ?? []).map((d) => d.key)]);
  const nextRound: string[] = [];
  const tickets: TicketCard[] = [];
  const started = (c: CrewMember) => Date.parse(c.agent.stateSince);
  for (const t of snap.tasks) {
    const sessions = crew.filter((c) => !c.isLead && c.config.crew?.session && c.ticket === t.id);
    const current = sessions.filter((c) => c.running).at(-1) ?? null;
    const history = sessions.filter((c) => !c.running).sort((a, b) => Date.parse(a.ended?.at ?? a.agent.stateSince) - Date.parse(b.ended?.at ?? b.agent.stateSince) || started(a) - started(b));
    const s = t.pf?.state ?? null;
    const rec = t.pf?.recorded ?? null;
    const gate = s === "human-gate" ? t.pf?.gate ?? null : null;
    const last = history.at(-1) ?? null;
    let phase: TicketPhase | null = null;
    let label = "";
    let stage: string | null = null;
    const view = t.pf?.view ?? null;
    if (current) {
      stage = current.session;
      phase = current.state === "needs" || s === "human-gate" ? "needs" : "live";
      const doing = view && view.stage !== "needs-you" ? view.label : stageWords(stage);
      label = phase === "needs" ? `Needs you · ${doing}` : doing;
    } else if (s === "human-gate") {
      phase = "needs";
      label = "Needs you";
    } else if (s === "failed" || s === "stale" || PENDING.has(s ?? "") || (s === "working" && last?.ended?.outcome === "interrupted")) {
      // No live session: the shared mapping's words, the same as the Boards card and the worker drawer.
      const shared = ticketView({ state: s ?? "", recorded: rec, liveSession: null, lastEnded: last?.ended?.outcome ?? null });
      label = shared.label;
      if (shared.stage === "failed") phase = "failed";
      else if (shared.stage === "interrupted") {
        phase = "interrupted";
        stage = last?.session ?? null;
      } else if (shared.stage === "stale") phase = "stale";
      else {
        // Waiting for the session its pending stage needs (review, adversary, repair).
        phase = "waiting";
        stage = s === "stale" ? rec : s;
      }
    } else if (s === "done" || view?.stage === "completing") {
      // Ready to deliver, awaiting merge, or integrated with completion pending: the shared mapping's words.
      phase = "done";
      label = view?.label ?? "Ready to deliver";
    } else if (s === "ready" && planned.has(t.id)) {
      phase = "next-round";
      label = "Ready for next round";
      nextRound.push(t.id);
    } else if (!t.pf && (t.status === "in-progress" || t.status === "in-review") && sessions.length) {
      phase = "stale";
      label = "No live session";
    }
    if (!phase) continue;
    tickets.push({ key: t.id, title: t.title, phase, label, stage, current, history, gate, needsYou: s === "human-gate" || current?.state === "needs", next: view?.next ?? null, blocker: view && view.blocker !== gate ? view.blocker : null });
  }
  const order: Record<TicketPhase, number> = { needs: 0, failed: 1, interrupted: 2, live: 3, waiting: 4, done: 5, stale: 6, "next-round": 7 };
  tickets.sort((a, b) => order[a.phase] - order[b.phase] || byKey(a.key, b.key));

  // Configured roles from the workflow (Pathfinder roles/*.md), with how many sessions each has this run.
  const roleNames = snap.workflow?.roles ?? [];
  const roles: RoleInfo[] = roleNames.map((r) => ({
    name: r.name,
    description: r.description,
    character: characterForRole(r.name),
    running: crew.filter((c) => c.role === r.name && c.running).length,
    finished: crew.filter((c) => c.role === r.name && c.finished).length,
  }));

  // Same count as the top bar's Action items: open items plus anyone asking.
  const needsCount = selectAttention(snap).total;

  return {
    crew,
    roles,
    columns,
    pods,
    podOverflow: Math.max(0, cooks.length - placed.size),
    coordinator: crew.find((c) => c.place === "island") ?? null,
    reviewers: crew.filter((c) => c.place === "pass"),
    // Oldest break first: the couch seats the most recent finishers (the last two).
    lounge: crew.filter((c) => c.place === "lounge").sort((a, b) => Date.parse(a.agent.stateSince) - Date.parse(b.agent.stateSince)),
    gates: gates.sort(byKey),
    atPass: atPass.sort(byKey),
    needsCount,
    queued,
    served: columns[3].length,
    helpers: (snap.workflow?.helpers ?? []).filter((h) => !h.finished),
    allHelpers: snap.workflow?.helpers ?? [],
    tickets,
    waiting: tickets.filter((t) => t.phase === "waiting"),
    nextRound: nextRound.sort(byKey),
    departed: crew.filter((c) => c.place === "gone").length,
  };
}

export const characterName = (id: CharacterId) => CHARACTERS[id].name;
