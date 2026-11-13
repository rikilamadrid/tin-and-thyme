import type { AgentConfig, AgentStatus } from "./types";

/** Shared by the drawer and the server; null means a request can be made. */
export function summaryDisabledReason(agent: AgentConfig, status: AgentStatus): string | null {
  if (status.contextRefresh?.state === "running") return "Wait for fresh context to finish.";
  if (status.summary?.state === "requesting") return "Waiting for the agent's summary…";
  if (status.session.state !== "running") return "Start the agent before summarising.";
  if (status.state === "needs-input") return "Answer the agent's question first.";
  if (status.state !== "idle") return "Wait until the agent is idle.";
  if (agent.crew?.session) return "This workflow worker has no interactive prompt.";
  if (!status.session.workspace) return "The agent's folder is unavailable.";
  return null;
}
