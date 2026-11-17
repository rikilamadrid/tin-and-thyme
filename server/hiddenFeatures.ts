// Ticket 06.2: hide a Feature from the kitchen's work surfaces. A view decision only.
//
// The kitchen's own state (hub.snap), Pathfinder's record, the crew book and every gate are untouched: this
// module only decides what a browser is sent, the full snapshot and each event alike, so a refresh, a
// reconnect and a server restart all show the same thing. Matching is by ticket and session identity
// (06.1's attribution: a session's own ticket), never by a name or a character. A live session is never
// hidden, and neither is the ticket it works on.
//
// There is no general hidden-features system (human, 2026-11-12): one suppression, this project's Feature 02.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { OfficeEvent } from "../src/data/source";
import type { ActionItem, ActivityEvent, AgentStatus, HiddenFeature, OfficeSnapshot, WorkflowInfo } from "../src/data/types";
import type { CrewSessionView, CrewSnapshot } from "../src/data/crewContract";

/**
 * The one suppression (human, 2026-11-12): Feature 02, harness accounts. It applies only in a project whose
 * Feature 02 is that spec, so another repository's Feature 02 is never hidden by this kitchen.
 */
export const SUPPRESSED: readonly { feature: string; spec: string }[] = [{ feature: "02", spec: "02-harness-accounts.md" }];

/** The suppressed features this project has (its `context/features/` holds the named spec). */
export function hiddenFeaturesFor(root: string): Set<string> {
  try {
    const specs = new Set(readdirSync(join(root, "context", "features")));
    return new Set(SUPPRESSED.filter((s) => specs.has(s.spec)).map((s) => s.feature));
  } catch {
    return new Set();
  }
}

/** A ticket key's Feature, as the suppression names it ("2.1" and "02.1" are both Feature 02). */
export function featureOf(key: string): string {
  const f = key.split(".")[0];
  return /^\d+$/.test(f) ? f.padStart(2, "0") : f;
}

/** Only a stopped or failed session is finished. Running, starting and unknown liveness are never hidden. */
const FINISHED = new Set<AgentStatus["session"]["state"]>(["stopped", "failed"]);

export interface Hidden {
  /** The suppressed features (empty: nothing is filtered). */
  features: Set<string>;
  /** Tickets of a suppressed feature with no live session. */
  tickets: Set<string>;
  /** Tickets with a live (not finished) session: never hidden. */
  live: Set<string>;
  /** Finished sessions (hq ids) whose own ticket is hidden. */
  sessions: Set<string>;
  /** Ended crew-book sessions (occurrence ids) whose own ticket is hidden. */
  crewSessions: Set<string>;
  /** Boards (`F<nn>`) of a suppressed feature with no live ticket. */
  boards: Set<string>;
  /** Changes whenever what is hidden changes: a browser then gets a fresh full snapshot. */
  signature: string;
}

const NONE: Hidden = { features: new Set(), tickets: new Set(), live: new Set(), sessions: new Set(), crewSessions: new Set(), boards: new Set(), signature: "" };

/** A gate or request's own ticket: its request, its task, else the `gate-<key>` id. */
const itemKey = (i: ActionItem) => i.request?.key ?? i.taskId ?? (i.id.startsWith("gate-") ? i.id.slice(5) : null);

/** What is hidden in this snapshot, read from the sessions' own identities. */
export function hiddenIn(snap: OfficeSnapshot, features: ReadonlySet<string>): Hidden {
  if (!features.size || snap.workflow?.kind !== "pathfinder") return NONE;
  const inFeature = (key: string | null | undefined): key is string => !!key && features.has(featureOf(key));
  // A session's own ticket: its crew row's (the brief it was started with), else the one a worker's status follows.
  const crewTicket = new Map(snap.config.team.flatMap((a) => (a.crew?.session ? [[a.id, a.crew.ticket] as const] : [])));
  const status = new Map(snap.agents.map((a) => [a.agentId, a]));
  const ticketOf = (id: string) => (crewTicket.has(id) ? crewTicket.get(id) ?? null : id.startsWith("w-") ? status.get(id)?.currentTaskId ?? null : null);

  const live = new Set<string>();
  const finished: [string, string][] = [];
  for (const id of new Set([...crewTicket.keys(), ...status.keys()])) {
    const ticket = ticketOf(id);
    if (!ticket) continue;
    const st = status.get(id);
    if (st && !FINISHED.has(st.session.state)) live.add(ticket);
    else finished.push([id, ticket]);
  }
  const crew = snap.workflow.crew;
  for (const s of crew?.current ?? []) if (s.ticket) live.add(s.ticket);

  const hidden = (key: string | null | undefined): key is string => inFeature(key) && !live.has(key);
  const keys = [
    ...snap.tasks.map((t) => t.id),
    ...(snap.actionItems ?? []).map(itemKey),
    ...finished.map(([, t]) => t),
    ...(crew?.history ?? []).map((s) => s.ticket),
    ...Object.keys(snap.workflow.handoffs ?? {}),
    ...(snap.workflow.plan?.dispatch ?? []),
    ...(snap.workflow.plan?.deferred ?? []).map((d) => d.key),
    ...Object.keys(snap.delivery?.byKey ?? {}),
  ];
  const tickets = new Set(keys.filter(hidden));
  const sessions = new Set(finished.filter(([, t]) => hidden(t)).map(([id]) => id));
  const crewSessions = new Set((crew?.history ?? []).filter((s) => hidden(s.ticket)).map((s) => s.id));
  const liveFeatures = new Set([...live].map(featureOf));
  const boards = new Set(snap.boards.filter((b) => /^F/.test(b.id) && features.has(featureOf(b.id.slice(1))) && !liveFeatures.has(featureOf(b.id.slice(1)))).map((b) => b.id));
  const sorted = (s: Set<string>) => [...s].sort();
  const signature = JSON.stringify([sorted(tickets), sorted(sessions), sorted(crewSessions), sorted(boards)]);
  return { features: new Set(features), tickets, live, sessions, crewSessions, boards, signature };
}

/** Ticket keys an activity line names (`02.1`), read as written. */
const KEY_IN_TEXT = /(?<![\w.])(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g;

function visibleActivity(e: ActivityEvent, h: Hidden): boolean {
  if (e.agentId && h.sessions.has(e.agentId)) return false;
  for (const m of e.text.matchAll(KEY_IN_TEXT)) {
    const key = `${m[1]}.${m[2]}`;
    if (h.features.has(m[1]) && !h.live.has(key)) return false;
  }
  return true;
}

function visibleItem(i: ActionItem, h: Hidden): boolean {
  const key = itemKey(i);
  return !(key && h.tickets.has(key)) && !h.sessions.has(i.fromId);
}

function visibleCrew(crew: CrewSnapshot, h: Hidden): CrewSnapshot {
  const shown = (s: CrewSessionView) => !h.crewSessions.has(s.id);
  return {
    ...crew,
    // Live sessions are never hidden; ended ones of a hidden ticket leave the projection (the crew book keeps them).
    history: crew.history.filter(shown),
    // A character keeps its place; only a finished hidden session it last wore is no longer shown on it.
    characters: crew.characters.map((c) =>
      c.sessionId && h.crewSessions.has(c.sessionId) ? { ...c, sessionId: null, ticket: null, stage: null, role: null, telemetry: null, badge: c.badge ? { ...c.badge, ticket: null } : null } : c,
    ),
  };
}

function visibleWorkflow(wf: WorkflowInfo, h: Hidden): WorkflowInfo {
  const plan = wf.plan ? { ...wf.plan, dispatch: wf.plan.dispatch.filter((k) => !h.tickets.has(k)), deferred: wf.plan.deferred.filter((d) => !h.tickets.has(d.key)) } : wf.plan;
  const counts = new Map<string, number>();
  for (const k of h.tickets) counts.set(featureOf(k), (counts.get(featureOf(k)) ?? 0) + 1);
  const hidden: HiddenFeature[] = [...h.features].sort().filter((f) => counts.has(f) || h.boards.has(`F${f}`)).map((feature) => ({ feature, state: "hidden", tickets: counts.get(feature) ?? 0 }));
  return {
    ...wf,
    ...(wf.handoffs ? { handoffs: Object.fromEntries(Object.entries(wf.handoffs).filter(([k]) => !h.tickets.has(k))) } : {}),
    ...(wf.helpers ? { helpers: wf.helpers.filter((x) => !(x.finished && x.parent && h.sessions.has(x.parent))) } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(wf.crew ? { crew: visibleCrew(wf.crew, h) } : {}),
    hidden,
  };
}

/** The snapshot a browser is sent. The kitchen's own snapshot is never changed. */
export function visibleSnapshot(snap: OfficeSnapshot, h: Hidden): OfficeSnapshot {
  if (!h.features.size || !snap.workflow) return snap;
  return {
    ...snap,
    config: { ...snap.config, team: snap.config.team.filter((a) => !h.sessions.has(a.id)) },
    agents: snap.agents.filter((a) => !h.sessions.has(a.agentId)),
    boards: snap.boards.filter((b) => !h.boards.has(b.id)),
    tasks: snap.tasks.filter((t) => !h.tickets.has(t.id)),
    pullRequests: snap.pullRequests.filter((p) => !h.tickets.has(p.taskId)),
    environments: snap.environments.filter((e) => !(e.agentId && h.sessions.has(e.agentId))),
    messages: snap.messages.filter((m) => !h.sessions.has(m.fromId) && !h.sessions.has(m.toId)),
    activity: snap.activity.filter((e) => visibleActivity(e, h)),
    ...(snap.actionItems ? { actionItems: snap.actionItems.filter((i) => visibleItem(i, h)) } : {}),
    workflow: visibleWorkflow(snap.workflow, h),
    ...(snap.delivery ? { delivery: { ...snap.delivery, byKey: Object.fromEntries(Object.entries(snap.delivery.byKey).filter(([k]) => !h.tickets.has(k))) } } : {}),
  };
}

/** One event as a browser is sent it, or null when it is about something hidden. */
export function visibleEvent(e: OfficeEvent, h: Hidden, snap: OfficeSnapshot): OfficeEvent | null {
  if (!h.features.size) return e;
  switch (e.type) {
    case "snapshot":
      return { type: "snapshot", snapshot: visibleSnapshot(e.snapshot, h) };
    case "config.updated":
      return { ...e, config: { ...e.config, team: e.config.team.filter((a) => !h.sessions.has(a.id)) } };
    case "agent.updated":
      return h.sessions.has(e.agent.agentId) ? null : e;
    case "terminal.output":
      return h.sessions.has(e.agentId) ? null : e;
    case "board.updated":
      return h.boards.has(e.board.id) ? null : e;
    case "task.updated":
      return h.tickets.has(e.task.id) ? null : e;
    case "pr.updated":
      return h.tickets.has(e.pr.taskId) ? null : e;
    case "env.updated":
      return e.env.agentId && h.sessions.has(e.env.agentId) ? null : e;
    case "message":
      return h.sessions.has(e.message.fromId) || h.sessions.has(e.message.toId) ? null : e;
    case "activity":
      return visibleActivity(e.event, h) ? e : null;
    case "action.updated":
      return visibleItem(e.item, h) ? e : null;
    case "workflow.updated":
      return snap.workflow?.kind === "pathfinder" ? { ...e, workflow: visibleWorkflow(e.workflow, h) } : e;
    case "delivery.updated":
      return h.tickets.has(e.view.key) ? null : e;
    default:
      return e;
  }
}

/**
 * What one browser connection is sent: the visible snapshot, then each visible event. When what is hidden
 * changes (a session on a hidden ticket finished, or one started), the browser gets a fresh full snapshot
 * instead, exactly as a reconnect would, so nothing it was shown before lingers and nothing is missed.
 */
export function visibleFeed(hub: { snap: OfficeSnapshot; hiddenFeatures: ReadonlySet<string>; subscribe(fn: (e: OfficeEvent) => void): () => void }, send: (e: OfficeEvent) => void): () => void {
  let last = hiddenIn(hub.snap, hub.hiddenFeatures);
  send({ type: "snapshot", snapshot: visibleSnapshot(hub.snap, last) });
  return hub.subscribe((e) => {
    const now = hiddenIn(hub.snap, hub.hiddenFeatures);
    const changed = now.signature !== last.signature;
    last = now;
    if (changed) {
      send({ type: "snapshot", snapshot: visibleSnapshot(hub.snap, now) });
      // Terminal bytes are not part of a snapshot: still deliver them.
      if (e.type !== "terminal.output") return;
    }
    const v = visibleEvent(e, now, hub.snap);
    if (v) send(v);
  });
}
