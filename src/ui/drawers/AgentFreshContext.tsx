import { freshContextDisabledReason } from "../../data/agentFreshContext";
import type { AgentConfig, AgentStatus } from "../../data/types";

const LABELS = { handoff: "Save and verify handoff", clear: "Clear context", orient: "Orient from handoff" } as const;
const MARKS = { pending: "○", running: "◌", ok: "✓", failed: "✗" } as const;

export function AgentFreshContext({ agent, status, connected, onRequest }: {
  agent: AgentConfig; status: AgentStatus; connected: boolean; onRequest(): void;
}) {
  if (agent.crew?.session) return null;
  const refresh = status.contextRefresh;
  const reason = connected ? freshContextDisabledReason(agent, status) : "Connect to the kitchen to refresh context.";
  return (
    <section className="border-b-[3px] border-line bg-cream px-3 py-2 text-[13px]" aria-label="Fresh context">
      <div className="flex items-center gap-2">
        <button className="btn px-2 text-[12px]" disabled={!!reason} title={reason ?? "Save a handoff, clear context, then orient from the handoff"} onClick={onRequest}>
          {refresh?.state === "running" ? "Refreshing context…" : "Fresh context"}
        </button>
        {reason && <span className="text-muted">{reason}</span>}
      </div>
      {refresh && <ol className="mt-2 list-none space-y-1 p-0" aria-live="polite">
        {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((key) => {
          const step = refresh.steps[key];
          return <li key={key} className="flex gap-2">
            <span aria-label={step.state}>{MARKS[step.state]}</span>
            <span><b>{LABELS[key]}</b>{step.detail && <span className="block text-muted">{step.detail}</span>}</span>
          </li>;
        })}
      </ol>}
      {refresh?.state === "error" && <p className="mt-1 text-red" role="alert">Fresh context stopped. Later steps did not run.</p>}
    </section>
  );
}
