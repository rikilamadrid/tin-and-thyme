import { useEffect, useState } from "react";
import { summaryDisabledReason } from "../../data/agentSummary";
import type { AgentConfig, AgentStatus } from "../../data/types";

export function AgentSummary({ agent, status, connected, onRequest }: {
  agent: AgentConfig;
  status: AgentStatus;
  connected: boolean;
  onRequest(): void;
}) {
  const summary = status.summary;
  const [copy, setCopy] = useState("");
  useEffect(() => setCopy(""), [agent.id, summary?.text]);
  const reason = connected ? summaryDisabledReason(agent, status) : "Connect to the kitchen to request a summary.";
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summary?.text ?? "");
      setCopy("Copied");
    } catch {
      setCopy("Copy failed. Select the summary text and copy it manually.");
    }
  };
  return (
    <section className="border-b-[3px] border-line bg-cream px-3 py-2 text-[13px]" aria-label="Agent summary">
      <div className="flex items-center gap-2">
        <button className="btn px-2 text-[12px]" disabled={!!reason} title={reason ?? "Ask the agent for a short summary of its work"} onClick={onRequest}>
          {summary?.state === "requesting" ? "Summarising…" : "Summarise"}
        </button>
        {reason && <span className="text-muted">{reason}</span>}
      </div>
      {summary?.state === "error" && <p className="mt-1 text-red" role="alert">{summary.error}</p>}
      {summary?.text && (
        <details className="mt-2" open>
          <summary className="cursor-pointer font-semibold">Work summary</summary>
          <div className="mt-1 flex items-center gap-2">
            {summary.at && <time className="text-muted" dateTime={summary.at}>{new Date(summary.at).toLocaleString()}</time>}
            <button className="btn px-2 text-[12px]" onClick={copySummary}>Copy</button>
            <span role="status">{copy}</span>
          </div>
          <p className="scroll-thin mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words select-text">{summary.text}</p>
        </details>
      )}
    </section>
  );
}
