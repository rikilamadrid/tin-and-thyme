import type { AgentConfig, AgentStatus } from "./types";

export function freshContextDisabledReason(agent: AgentConfig, status: AgentStatus): string | null {
  if (agent.crew?.session) return "Use Checkpoint & start fresh for this workflow worker.";
  if (status.contextRefresh?.state === "running") return "Fresh context is in progress…";
  if (status.summary?.state === "requesting") return "Wait for the agent's summary to finish.";
  if (status.session.state !== "running") return "Start the agent before refreshing context.";
  if (status.state === "needs-input") return "Answer the agent's question first.";
  if (status.state !== "idle") return "Wait until the agent is idle.";
  if (!status.session.workspace) return "The agent's folder is unavailable.";
  return null;
}
