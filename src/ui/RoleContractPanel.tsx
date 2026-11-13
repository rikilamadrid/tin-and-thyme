import type { RoleContract } from "../data/roleContract";

/** Shared by Pathfinder Settings and the crew drawer. Configuration never implies loading. */
export function RoleContractPanel({ contract }: { contract: RoleContract | undefined }) {
  if (!contract) return <p className="text-[13px]">Role source and session evidence are not available yet.</p>;
  const label = contract.error ? "Contract unavailable" : contract.conflict ? "Role conflict" : contract.evidence ? "Load observed" : "Configured · load unverified";
  return (
    <section aria-label="Pathfinder role contract" className="min-w-0 space-y-2 rounded border border-current/20 p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2"><b>Pathfinder role: {contract.role}</b><span>{label}</span></div>
      {contract.session && <div>Stage: {contract.session}</div>}
      <div>Agent type: {contract.agentType ?? "Unverified"}</div>
      <div className="break-all">Source: {contract.source ?? "Unresolved"}</div>
      {contract.origin === "checkout-fallback" && <p>The worktree has no copy; this is the checkout contract.</p>}
      {contract.error && <p role="alert">{contract.error}</p>}
      {contract.definition && <p className="break-all">Named agent definition: {contract.definition}. Definition compatibility requires review; its name alone does not prove role compatibility.</p>}
      {contract.conflict && <p role="alert">{contract.conflict} Resolve the configuration before starting a replacement session.</p>}
      {contract.evidence ? (
        <div>
          <p>The full current contract appeared in a successful {contract.evidence.tool} result earlier in this session. This does not prove it remains in context after compaction or that every rule was followed.</p>
          <details><summary className="cursor-pointer font-bold">Load evidence</summary><div className="break-all">{contract.evidence.transcript}:{contract.evidence.line}<br />Tool: {contract.evidence.toolId}</div></details>
        </div>
      ) : !contract.error && <p>No matching successful full-contract read was observed in the inspected session data. Skills may have loaded it another way; configuration alone does not prove loading.</p>}
      {contract.text !== null && <details><summary className="cursor-pointer font-bold">Inspect contract (read-only)</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]">{contract.text}</pre></details>}
      <p>Pathfinder skills load role contracts on demand. Tin &amp; Thyme observes the source and available evidence.</p>
    </section>
  );
}
