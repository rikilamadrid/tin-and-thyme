import { useEffect, useState } from "react";
import { HOST_TERMINAL } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { DrawerHeader } from "./Drawer";
import { TerminalView } from "./TerminalView";

const OTHER = "\u0000other";
// The folder the shell is in, kept while HQ is open so reopening the panel shows the same shell.
let lastDir = "";

/**
 * The Terminal panel: your own shell on this machine (not in a sandbox), in your repo, an agent's
 * folder, or any folder you type.
 */
export function TerminalDrawer() {
  const snap = useOffice((s) => s.snap);
  const [dir, setDir] = useState(lastDir);
  const [other, setOther] = useState("");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    officeActions.openHostShell(lastDir);
  }, []);

  const folders = (snap?.config.team ?? []).flatMap((a) => {
    const ws = snap?.agents.find((s) => s.agentId === a.id)?.session.workspace;
    return ws ? [{ path: ws, agent: a, running: snap?.agents.find((s) => s.agentId === a.id)?.session.state === "running" }] : [];
  });
  const inAgent = folders.find((f) => f.path === dir);
  const known = dir === "" || !!inAgent;

  const open = (next: string, fresh = false) => {
    lastDir = next;
    setDir(next);
    setPicking(false);
    officeActions.openHostShell(next, fresh);
  };

  return (
    <>
      <DrawerHeader>
        <div className="min-w-0">
          <b className="text-[18px]">Terminal</b>
          <div className="truncate text-[13px] text-muted">Your own shell on this machine, not in a sandbox.</div>
        </div>
      </DrawerHeader>
      <div className="flex flex-wrap items-center gap-2 border-b-[3px] border-line bg-cream-2 px-3 py-1.5 text-[13px]">
        <label className="text-muted" htmlFor="host-term-dir">
          Folder
        </label>
        <select
          id="host-term-dir"
          className="min-w-0 max-w-full flex-1 border-2 border-line bg-card px-1 py-0.5 text-[13px]"
          value={picking || !known ? OTHER : dir}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setOther(known ? "" : dir);
              setPicking(true);
            } else open(e.target.value);
          }}
        >
          <option value="">This repo (your working copy)</option>
          {folders.map((f) => (
            <option key={f.agent.id} value={f.path}>
              {f.agent.name}'s folder
            </option>
          ))}
          <option value={OTHER}>{!known && !picking ? dir : "Other folder…"}</option>
        </select>
        <button className="btn px-2 text-[12px]" onClick={() => open(dir, true)} title="Close this shell and open a new one in the same folder">
          New shell
        </button>
        {picking && (
          <form
            className="flex w-full items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (other.trim()) open(other.trim());
            }}
          >
            <input
              autoFocus
              className="min-w-0 flex-1 border-2 border-line bg-card px-1.5 py-0.5 font-term text-[16px]"
              placeholder="~/developer/my-app"
              aria-label="Folder path"
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
            <button className="btn px-2 text-[12px]" disabled={!other.trim()}>
              Open
            </button>
            <button type="button" className="btn px-2 text-[12px]" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      {inAgent?.running && (
        <div className="border-b-[3px] border-line bg-notice px-3 py-1.5 text-[13px]">
          {inAgent.agent.name} is working in this folder. Switching branches or committing here can break {inAgent.agent.name}'s work.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <TerminalView agentId={HOST_TERMINAL} />
      </div>
    </>
  );
}
