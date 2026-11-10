// The server's single source of truth. Every mutation emits the matching
// OfficeEvent to all connected browsers, and config/plan changes are saved.

import type { OfficeEvent } from "../src/data/source";
import type { ActivityType, AgentConfig, AgentStatus, HqConfig, OfficeSnapshot, SessionInfo, SetupState } from "../src/data/types";
import { writePlanExport } from "./planExport";
import { saveConfig, savePlan, type PlanFile } from "./store";
import type { RepoInfo } from "./repo";

type Listener = (e: OfficeEvent) => void;

const now = () => new Date().toISOString();

export class Hub {
  snap: OfficeSnapshot;
  private listeners = new Set<Listener>();
  private seq = 0;
  /** False for a workflow adapter (Pathfinder): the project's files are its own; HQ writes nothing there. */
  persist = true;

  constructor(readonly repo: RepoInfo, readonly slug: string, config: HqConfig, plan: PlanFile, setup: SetupState) {
    this.snap = {
      setup,
      sbx: { basePolicy: "unknown", proxy: null, globalKeys: [], agents: {}, checkedAt: now() },
      config,
      agents: config.team.map((a) => Hub.freshStatus(a.id)),
      boards: plan.boards,
      tasks: plan.tasks,
      pullRequests: [],
      environments: [],
      messages: [],
      activity: [],
    };
  }

  static freshStatus(agentId: string): AgentStatus {
    return {
      agentId, state: "idle", currentTaskId: null, stateSince: now(), note: "Not started",
      session: { state: "stopped", detail: null, workspace: null, sandbox: null },
    };
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: OfficeEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // ------------------------------------------------------------ lookups

  cfg(id: string): AgentConfig | undefined {
    return this.snap.config.team.find((a) => a.id === id);
  }

  status(id: string): AgentStatus | undefined {
    return this.snap.agents.find((a) => a.agentId === id);
  }

  name(id: string | null) {
    if (id === "you") return "You";
    if (id === "hq") return "HQ";
    return (id && this.cfg(id)?.name) || "Someone";
  }

  // ------------------------------------------------------------ mutations

  /** While an access request is open, the agent stays "needs you"; what hooks report meanwhile is kept for after. */
  private held = new Map<string, { state: AgentStatus["state"]; note: string | null }>();

  /** Remember what the agent was doing before it asked, to return to it after the answer. */
  holdForAccess(agentId: string) {
    const s = this.status(agentId);
    if (s && !this.held.has(agentId) && s.state !== "needs-input") this.held.set(agentId, { state: s.state, note: s.note });
  }

  pendingAccess(agentId: string) {
    return this.snap.accessRequests?.find((r) => r.agentId === agentId && r.status === "pending");
  }

  /** An access request was answered: drop back to what the agent is really doing (unless another is open). */
  accessAnswered(agentId: string) {
    // Another request from this agent is still open: keep waiting (and keep what it was doing).
    if (this.pendingAccess(agentId)) return;
    const held = this.held.get(agentId);
    this.held.delete(agentId);
    const s = this.status(agentId);
    if (s?.state === "needs-input" && s.note?.startsWith("Asking: access to"))
      this.setStatus(agentId, held ?? { state: "working", note: "Access answered" });
  }

  setStatus(id: string, patch: Partial<Omit<AgentStatus, "agentId" | "session">>) {
    const s = this.status(id);
    if (!s) return;
    const open = this.pendingAccess(id);
    if (open && patch.state !== undefined && patch.state !== "needs-input") {
      // A patch without a note keeps the note from before the request, not the "Asking" one.
      this.held.set(id, { state: patch.state, note: patch.note !== undefined ? patch.note : (this.held.get(id)?.note ?? null) });
      patch = { ...patch, state: "needs-input", note: `Asking: access to ${open.domain}` };
    }
    if (patch.state !== undefined && patch.state !== s.state) s.stateSince = now();
    Object.assign(s, patch);
    this.emit({ type: "agent.updated", agent: structuredClone(s) });
  }

  setSession(id: string, patch: Partial<SessionInfo>) {
    const s = this.status(id);
    if (!s) return;
    s.session = { ...s.session, ...patch };
    this.emit({ type: "agent.updated", agent: structuredClone(s) });
  }

  setSetup(setup: SetupState) {
    this.snap.setup = setup;
    this.emit({ type: "setup.updated", setup });
  }

  activity(type: ActivityType, agentId: string | null, text: string) {
    this.seq += 1;
    const event = { id: `a${this.seq}`, at: now(), type, agentId, text };
    this.snap.activity = [event, ...this.snap.activity].slice(0, 50);
    this.emit({ type: "activity", event });
  }

  configChanged() {
    if (this.persist) saveConfig(this.repo.root, this.snap.config);
    this.emit({ type: "config.updated", config: structuredClone(this.snap.config) });
  }

  planChanged() {
    if (!this.persist) return;
    const plan = { boards: this.snap.boards, tasks: this.snap.tasks };
    savePlan(this.repo.root, plan);
    if (this.snap.config.project.exportPlan) writePlanExport(this.repo.root, this.snap.config, plan);
  }

  terminal(agentId: string, data: string) {
    this.emit({ type: "terminal.output", agentId, data });
  }
}
