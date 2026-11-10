import { useEffect, useState } from "react";
import type { AgentConfig, AgentStatus, MachineInfo } from "../../data/types";
import { officeActions } from "../../store/office";
import { SectionTitle } from "../kit";
import { effective, fmtGb, maxMemory, sbxDefault, sizeMismatch, teamBudget } from "../resources";

/** CPU + memory for one agent's sandbox, plus the whole team's budget. */
export function ResourcesSection({ agent, status, team, machine }: { agent: AgentConfig; status: AgentStatus | undefined; team: AgentConfig[]; machine: MachineInfo }) {
  const r = agent.sandbox.resources;
  const custom = r.cpus !== null || r.memoryGb !== null;
  const def = sbxDefault(machine);
  const eff = effective(r, machine);
  const maxMem = maxMemory(machine);
  // Sliders keep a local draft and save on release, so dragging doesn't spam the server.
  const [draft, setDraft] = useState(eff);
  useEffect(() => setDraft(eff), [eff.cpus, eff.memoryGb]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: { cpus: number; memoryGb: number }) => officeActions.updateSandbox(agent.id, { resources: next });

  const budget = teamBudget(team, machine);
  const session = status?.session;
  const mismatch = session ? sizeMismatch(r, session, machine) : false;

  return (
    <section className="border-[3px] border-line bg-card p-3">
      <SectionTitle>Resources</SectionTitle>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Sandbox size">
        <button
          className="btn whitespace-normal px-2.5 py-1.5 text-left"
          role="radio"
          aria-checked={!custom}
          aria-pressed={!custom}
          onClick={() => officeActions.updateSandbox(agent.id, { resources: { cpus: null, memoryGb: null } })}
        >
          <div>sbx default</div>
          <div className="text-[12px] font-normal text-muted">
            All {def.cpus} CPUs · {fmtGb(def.memoryGb)} (half your memory)
          </div>
        </button>
        <button
          className="btn whitespace-normal px-2.5 py-1.5 text-left"
          role="radio"
          aria-checked={custom}
          aria-pressed={custom}
          onClick={() => save({ cpus: Math.min(4, machine.cpus), memoryGb: Math.min(4, maxMem) })}
        >
          <div>Custom</div>
          <div className="text-[12px] font-normal text-muted">Pick CPUs and memory for this agent.</div>
        </button>
      </div>

      {custom && (
        <div className="mt-3 grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-[14px]">
            <span className="flex justify-between font-semibold">
              CPUs <span className="font-term text-[17px]">{draft.cpus} of {machine.cpus}</span>
            </span>
            <input
              type="range" min={1} max={machine.cpus} step={1} value={draft.cpus} className="accent-[#29adff]"
              onChange={(e) => setDraft({ ...draft, cpus: Number(e.target.value) })}
              onPointerUp={() => save(draft)} onKeyUp={() => save(draft)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[14px]">
            <span className="flex justify-between font-semibold">
              Memory <span className="font-term text-[17px]">{fmtGb(draft.memoryGb)} of {fmtGb(maxMem)} max</span>
            </span>
            <input
              type="range" min={0.5} max={maxMem} step={0.5} value={draft.memoryGb} className="accent-[#29adff]"
              onChange={(e) => setDraft({ ...draft, memoryGb: Number(e.target.value) })}
              onPointerUp={() => save(draft)} onKeyUp={() => save(draft)}
            />
          </label>
        </div>
      )}

      <div className={`mt-3 border-2 px-2.5 py-1.5 text-[13px] ${budget.overMemory ? "border-orange bg-warn" : "border-cream-3 bg-cream"}`}>
        <b>Team:</b> {budget.count} sandbox{budget.count === 1 ? "" : "es"} · {budget.cpus} CPUs · {fmtGb(budget.memoryGb)} of your {fmtGb(machine.memoryGb)} memory
        {budget.overMemory && <div className="text-[#ffb35c]">That's more memory than this machine has. Give agents less with Custom, or run fewer at once.</div>}
      </div>

      {agent.mode === "sandbox" && session?.sandbox && (
        <div className={`mt-3 flex items-center gap-2 text-[13px] ${mismatch ? "border-2 border-orange bg-warn px-2.5 py-1.5" : "text-muted"}`}>
          <span className="flex-1">
            The sandbox now has {session.sandbox.cpus} CPUs · {fmtGb(session.sandbox.memoryGb)}.
            {mismatch && " Size is fixed when a sandbox is created, so recreate it to apply the new size."}
          </span>
          {mismatch && (
            <button
              className="btn px-2 text-[12px]"
              onClick={() =>
                window.confirm(
                  `Recreate ${agent.name}'s sandbox with ${eff.cpus} CPUs and ${fmtGb(eff.memoryGb)}?\n\nThe agent's folder and code are kept. Anything installed inside the VM is lost, and the current session restarts.`,
                ) && officeActions.recreateSandbox(agent.id)
              }
            >
              Recreate sandbox
            </button>
          )}
        </div>
      )}
      {agent.mode === "sandbox" && !session?.sandbox && <p className="mt-2 text-[12px] text-muted">Applied when {agent.name}'s sandbox is created on first Start.</p>}
    </section>
  );
}
