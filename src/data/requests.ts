// Which human requests are visible and actionable, and which count toward "Needs you". The one place that
// decides it: the Action items drawer, the attention badges and anything that later filters requests (e.g.
// a feature that suppresses some kinds) go through here.

import type { ActionItem, AgentStatus, OfficeSnapshot } from "./types";

export type RequestShelf = "actionable" | "awaiting" | "snoozed" | "closed";

/**
 * Where one action item belongs right now:
 * - actionable: open and waiting on the human (counts toward "Needs you");
 * - awaiting: answered, on its way or waiting for Pathfinder to record it (not asking the human again);
 * - snoozed: the human put it aside; nothing was sent and nothing resolved;
 * - closed: done or dismissed.
 */
export function requestShelf(item: ActionItem, now = Date.now()): RequestShelf {
  if (item.status !== "open") return "closed";
  if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) return "snoozed";
  const a = item.answer;
  if (item.request && a && a.revision === item.request.revision && (a.state === "sending" || a.state === "delivered")) return "awaiting";
  return "actionable";
}

export function requestsByShelf(items: ActionItem[] | undefined, now = Date.now()): Record<RequestShelf, ActionItem[]> {
  const out: Record<RequestShelf, ActionItem[]> = { actionable: [], awaiting: [], snoozed: [], closed: [] };
  for (const i of items ?? []) out[requestShelf(i, now)].push(i);
  return out;
}

/**
 * An agent "needs input" that is only relaying open gates is not a separate ask: each gate is its own
 * request (answered, awaiting or snoozed), so it isn't counted twice.
 */
export function askingCounts(agent: AgentStatus, items: ActionItem[] | undefined): boolean {
  if (agent.state !== "needs-input") return false;
  const relaying = agent.relaying ?? [];
  if (!relaying.length) return true;
  const gates = new Set((items ?? []).filter((i) => i.status === "open" && i.request?.kind === "gate").map((i) => i.request!.key));
  return !relaying.every((k) => gates.has(k));
}

/** The requests that count toward "Needs you" right now. */
export function needsYou(snap: OfficeSnapshot, now = Date.now()) {
  const shelves = requestsByShelf(snap.actionItems, now);
  return { items: shelves.actionable, asking: snap.agents.filter((a) => askingCounts(a, snap.actionItems)) };
}
