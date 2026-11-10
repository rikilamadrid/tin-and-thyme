import { useEffect, useState } from "react";
import type { AgentConfig } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";

/** Confirms removing an agent and lets you choose what to delete with it. */
export function RemoveAgentDialog({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const info = useOffice((s) => s.workspaceInfo[agent.id]);
  const [asked, setAsked] = useState(false);
  const [deleteSandbox, setDeleteSandbox] = useState(true);
  const [deleteFolder, setDeleteFolder] = useState(false);

  useEffect(() => {
    // Drop any stale answer, then ask the server for the folder's current state.
    useOffice.setState((s) => {
      const next = { ...s.workspaceInfo };
      delete next[agent.id];
      return { workspaceInfo: next };
    });
    officeActions.inspectWorkspace(agent.id);
    setAsked(true);
  }, [agent.id]);

  const loading = asked && !info;
  const atRisk = info ? info.changedFiles + info.unpushedCommits > 0 : false;
  const remove = () => {
    officeActions.removeAgent(agent.id, { deleteSandbox, deleteFolder: deleteFolder && !!info?.managed });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label={`Remove ${agent.name}`}>
      <div className="panel w-[min(560px,100%)] p-4">
        <h3 className="mb-1 text-[20px] font-bold">Remove {agent.name} from the team?</h3>
        <p className="mb-3 text-[13px] text-muted">Their session stops, and their unfinished tasks go back to the board.</p>

        {loading && <p className="blink mb-3 font-term text-[18px]">Checking {agent.name}'s folder…</p>}

        {info && (
          <div className="mb-3 flex flex-col gap-2.5">
            <label className={`flex items-start gap-2 border-2 border-line bg-card p-2 ${info.sandboxExists ? "" : "opacity-60"}`}>
              <input type="checkbox" className="mt-1" checked={deleteSandbox && info.sandboxExists} disabled={!info.sandboxExists} onChange={(e) => setDeleteSandbox(e.target.checked)} />
              <span className="min-w-0">
                <b className="text-[15px]">Delete {agent.name}'s sandbox (the VM)</b>
                <span className="block font-term text-[16px] text-muted">{info.sandboxExists ? `sbx rm ${info.sandboxName}` : "No sandbox exists"}</span>
                <span className="block text-[12px] text-muted">Safe: the code lives in the folder, not the VM. Anything installed inside the VM is lost.</span>
              </span>
            </label>

            <label className={`flex items-start gap-2 border-2 p-2 ${atRisk && deleteFolder ? "border-red bg-danger" : "border-line bg-card"} ${info.managed && info.exists ? "" : "opacity-60"}`}>
              <input type="checkbox" className="mt-1" checked={deleteFolder} disabled={!info.managed || !info.exists} onChange={(e) => setDeleteFolder(e.target.checked)} />
              <span className="min-w-0">
                <b className="text-[15px]">Delete {agent.name}'s folder</b>
                <span className="block truncate font-term text-[16px] text-muted" title={info.path}>{info.path}</span>
                {!info.managed && <span className="block text-[12px] text-muted">This is your own folder, so HQ never deletes it.</span>}
                {info.managed && !info.exists && <span className="block text-[12px] text-muted">The folder doesn't exist.</span>}
                {info.managed && info.exists && (
                  <span className={`block text-[12px] ${atRisk ? "font-semibold text-[#ff7a9c]" : "text-muted"}`}>
                    {atRisk
                      ? `⚠ ${[info.unpushedCommits ? `${info.unpushedCommits} commit${info.unpushedCommits > 1 ? "s" : ""} not pushed` : "", info.changedFiles ? `${info.changedFiles} file${info.changedFiles > 1 ? "s" : ""} changed` : ""].filter(Boolean).join(" · ")} — deleting loses them.`
                      : "Everything here is committed and pushed."}
                  </span>
                )}
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn text-[#ff7a9c]" disabled={loading} onClick={remove}>
            Remove {agent.name}
          </button>
        </div>
      </div>
    </div>
  );
}
