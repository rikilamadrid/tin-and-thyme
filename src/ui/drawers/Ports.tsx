import { useEffect, useState } from "react";
import type { AgentConfig, AgentStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { dismissPort, usePorts } from "../../store/ports";

const NO_PORTS: number[] = [];

function useForwarded(agentId: string) {
  return useOffice((s) => s.snap?.sbx.agents[agentId]?.ports) ?? [];
}

/** Disabled from a click until HQ's port list changes (or a timeout, if sbx failed). */
function useBusy(key: string) {
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => setBusy(null), [key]);
  useEffect(() => {
    if (busy === null) return;
    const t = window.setTimeout(() => setBusy(null), 15_000);
    return () => window.clearTimeout(t);
  }, [busy]);
  return [busy, setBusy] as const;
}

/**
 * A program in the agent's Shell tab printed a localhost URL (a CLI sign-in, a dev server). The
 * browser on this machine can't reach a port inside the sandbox until it's forwarded.
 */
export function PortBanner({ agent, status }: { agent: AgentConfig; status: AgentStatus }) {
  const seen = usePorts((s) => s.seen[`shell:${agent.id}`]) ?? NO_PORTS;
  const dismissed = usePorts((s) => s.dismissed[agent.id]) ?? NO_PORTS;
  const forwarded = useForwarded(agent.id);
  const [busy, setBusy] = useBusy(forwarded.map((p) => p.sandbox).join());
  if (agent.mode !== "sandbox" || status.session.state !== "running") return null;
  const port = [...seen].reverse().find((p) => !dismissed.includes(p));
  if (!port) return null;
  const done = forwarded.some((p) => p.sandbox === port);
  return (
    <div className={`flex items-center gap-2 border-b-[3px] border-line px-3 py-1.5 text-[13px] ${done ? "bg-okay" : "bg-notice"}`}>
      <span className="min-w-0 flex-1">
        {done ? (
          <>
            <b>localhost:{port}</b> now reaches the sandbox. If a page already opened and failed, reload it.
          </>
        ) : (
          <>
            Something in the sandbox uses <b>localhost:{port}</b>. Your browser can't reach it until you forward the port.
          </>
        )}
      </span>
      {done ? (
        <button className="btn px-2 text-[12px]" onClick={() => dismissPort(agent.id, port)}>
          OK
        </button>
      ) : (
        <>
          <button
            className="btn px-2 text-[12px]"
            disabled={busy === port}
            onClick={() => {
              setBusy(port);
              officeActions.forwardPort(agent.id, port);
            }}
          >
            {busy === port ? "Forwarding…" : `Forward port ${port}`}
          </button>
          <button className="btn px-2 text-[12px]" onClick={() => dismissPort(agent.id, port)}>
            Not now
          </button>
        </>
      )}
    </div>
  );
}

/** Sandbox tab: forwarded ports, ports seen in the agent's output, and forwarding any port by hand. */
export function PortsRow({ agent, running }: { agent: AgentConfig; running: boolean }) {
  const forwarded = useForwarded(agent.id);
  const seenAgent = usePorts((s) => s.seen[agent.id]) ?? NO_PORTS;
  const seenShell = usePorts((s) => s.seen[`shell:${agent.id}`]) ?? NO_PORTS;
  const [busy, setBusy] = useBusy(forwarded.map((p) => p.sandbox).join());
  const [text, setText] = useState("");
  if (agent.mode !== "sandbox") return <span className="text-muted">Sandbox mode only</span>;
  if (!running) return <span className="text-muted">Start {agent.name} to forward ports</span>;
  const suggested = [...new Set([...seenShell, ...seenAgent])].filter((p) => !forwarded.some((f) => f.sandbox === p)).slice(-4);
  const value = Number(text);
  const valid = Number.isInteger(value) && value >= 1 && value <= 65535;
  const forward = (port: number) => {
    setBusy(port);
    officeActions.forwardPort(agent.id, port);
  };
  return (
    <div className="flex flex-col gap-1.5">
      {forwarded.map((p) => (
        <div key={p.sandbox} className="flex items-center gap-2">
          <a className="font-term text-[17px] underline" href={`http://localhost:${p.host}`} target="_blank" rel="noopener noreferrer">
            localhost:{p.host}
          </a>
          {p.host !== p.sandbox && <span className="text-muted">→ sandbox :{p.sandbox}</span>}
          <button
            className="btn ml-auto px-2 text-[12px]"
            disabled={busy === p.sandbox}
            onClick={() => {
              setBusy(p.sandbox);
              officeActions.unforwardPort(agent.id, p.sandbox);
            }}
          >
            Stop
          </button>
        </div>
      ))}
      {suggested.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">Seen in output:</span>
          {suggested.map((p) => (
            <button key={p} className="btn px-2 text-[12px]" disabled={busy === p} onClick={() => forward(p)} title={`Forward port ${p} to localhost:${p} on this machine`}>
              Forward {p}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          forward(value);
          setText("");
        }}
      >
        <input
          className="w-[90px] border-2 border-line bg-card px-1.5 py-0.5 font-term text-[16px]"
          inputMode="numeric"
          placeholder="3000"
          aria-label="Port to forward"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 5))}
        />
        <button className="btn px-2 text-[12px]" disabled={!valid}>
          Forward port
        </button>
      </form>
      <span className="text-[12px] text-muted">Opens a port in the sandbox at the same port on this machine (localhost only).</span>
    </div>
  );
}
