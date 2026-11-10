// The Pass · which real events get a sound.
//
// Each store change is compared with the state before it. Only a change that
// happens while connected counts: the first snapshot, a reconnect (a new full
// snapshot, plus a few settling seconds) and a poll that changes nothing all set
// a new baseline silently.
// Changes that arrive together (one server event often updates a task, an agent
// and an action item within milliseconds) are gathered for a moment and only
// the most specific cue plays, so sounds never stack.

import type { OfficeSnapshot } from "../data/types";
import { buildGalley } from "../galley/model";
import { useOffice } from "../store/office";
import { SETTLE_MS } from "./settle";
import { playCue, type Cue } from "./sfx";

interface CueState {
  /** Open human decisions: action items and agents asking. */
  decisions: Set<string>;
  running: Set<string>;
  /** Workflow sessions running now (each one beamed in once). */
  arrived: Set<string>;
  /** Workflow sessions that ended with a recorded handoff (never an interrupted or failed stop). */
  handedOff: Set<string>;
  /** Ticket → board column. */
  column: Map<string, number>;
  /** Confirmed milestones (a review passing). */
  milestones: Set<string>;
  /** Confirmed merges into main. */
  merged: Set<string>;
}

/** Most specific first: a merge also moves its ticket; a review pass may also open a gate. */
const RANK: Record<Cue, number> = { merged: 6, needs: 5, milestone: 4, handoff: 3, arrive: 2, moved: 1 };
const GATHER_MS = 350;
/** The same event key (a gate that flaps open/closed/open) only sounds once in this window. */
const REPEAT_MS = 60_000;

export function cueState(snap: OfficeSnapshot): CueState {
  const m = buildGalley(snap);
  const decisions = new Set<string>();
  for (const i of snap.actionItems ?? []) if (i.status === "open") decisions.add(`item:${i.id}`);
  for (const a of snap.agents) if (a.state === "needs-input") decisions.add(`ask:${a.agentId}`);
  const column = new Map<string, number>();
  m.columns.forEach((col, i) => col.forEach((s) => column.set(s.id, i)));
  const milestones = new Set<string>();
  const merged = new Set<string>();
  for (const t of snap.tasks) {
    if (t.pf?.state === "done") milestones.add(`task:${t.id}`);
    if (t.pf?.state === "integrated") merged.add(`task:${t.id}`);
  }
  for (const p of snap.pullRequests) {
    if (p.review === "passed") milestones.add(`pr:${p.number}`);
    // Only GitHub's confirmed merge counts; an opened or closed PR never does.
    if (p.merged) merged.add(`pr:${p.number}`);
  }
  return {
    decisions,
    running: new Set(m.crew.filter((c) => c.running).map((c) => c.id)),
    arrived: new Set(m.crew.filter((c) => c.running && !c.isLead && c.config.crew?.session).map((c) => c.id)),
    handedOff: new Set(m.crew.filter((c) => !c.running && c.ended?.outcome === "handed-off").map((c) => c.id)),
    column,
    milestones,
    merged,
  };
}

/** Everything that newly happened between two states, as [cue, event key]. */
export function diffCues(prev: CueState, next: CueState): [Cue, string][] {
  const out: [Cue, string][] = [];
  const added = (a: Set<string>, b: Set<string>) => [...b].filter((x) => !a.has(x));
  for (const k of added(prev.merged, next.merged)) out.push(["merged", `merged:${k}`]);
  for (const k of added(prev.decisions, next.decisions)) out.push(["needs", `needs:${k}`]);
  for (const k of added(prev.milestones, next.milestones)) out.push(["milestone", `milestone:${k}`]);
  // Keyed by session: a session arrives once and hands off once, whatever refreshes or polls follow.
  for (const id of added(prev.handedOff, next.handedOff)) out.push(["handoff", `handoff:${id}`]);
  for (const id of added(prev.arrived, next.arrived)) out.push(["arrive", `arrive:${id}`]);
  for (const [t, col] of next.column) {
    const was = prev.column.get(t);
    if (was !== undefined && was !== col) out.push(["moved", `moved:${t}:${was}->${col}`]);
  }
  return out;
}

export interface CueRecord {
  at: number;
  cue: Cue;
  keys: string[];
  played: boolean;
}

/** The last cues chosen (whether or not sound was on), newest last. Read by the fixture checks. */
export const cueLog: CueRecord[] = [];

let started = false;

export function startCues() {
  if (started) return;
  started = true;
  let prev: CueState | null = null;
  let epoch = -1;
  let pending: [Cue, string][] = [];
  let timer = 0;
  const lastKey = new Map<string, number>();
  let quietUntil = 0;

  const flush = () => {
    timer = 0;
    const now = Date.now();
    const fresh = pending.filter(([, k]) => now - (lastKey.get(k) ?? -Infinity) > REPEAT_MS);
    pending = [];
    if (!fresh.length) return;
    for (const [, k] of fresh) lastKey.set(k, now);
    const top = fresh.reduce((a, b) => (RANK[b[0]] > RANK[a[0]] ? b : a))[0];
    const played = playCue(top);
    cueLog.push({ at: now, cue: top, keys: fresh.map(([, k]) => k), played });
    if (cueLog.length > 50) cueLog.shift();
  };

  let lastSnap: OfficeSnapshot | null = null;
  useOffice.subscribe((s) => {
    // Terminal output and other UI-only changes keep the same snapshot: nothing to compare.
    if (!s.snap || (s.snap === lastSnap && s.epoch === epoch)) return;
    lastSnap = s.snap;
    // A full snapshot (first load, reconnect, preset reload) is a new baseline, never an event.
    if (s.epoch !== epoch || !prev) {
      epoch = s.epoch;
      prev = cueState(s.snap);
      pending = [];
      lastKey.clear(); // a new world: what it already shows is history, and later events are new
      quietUntil = Date.now() + SETTLE_MS;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      return;
    }
    const next = cueState(s.snap);
    if (s.connection !== "open" || Date.now() < quietUntil) {
      prev = next;
      return;
    }
    const found = diffCues(prev!, next);
    prev = next;
    if (!found.length) return;
    pending.push(...found);
    if (!timer) timer = window.setTimeout(flush, GATHER_MS);
  });
}
