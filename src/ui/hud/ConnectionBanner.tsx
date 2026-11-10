import { useOffice } from "../../store/office";

/** Shown when the real HQ server is unreachable. */
export function ConnectionBanner() {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const ready = useOffice((s) => s.snap !== null);
  const persistent = useOffice((s) => s.snap?.setup.machine.persistentAgents ?? true);
  if (!live || connection === "open" || (connection === "connecting" && !ready)) return null;
  const text =
    connection === "unauthorized"
      ? "HQ restarted with a new link. Open the URL printed in your terminal."
      : `Lost connection to HQ. Reconnecting…${persistent ? " Agents keep running in tmux." : ""}`;
  return (
    <div role="status" className="fixed left-1/2 top-[68px] z-50 -translate-x-1/2 border-[3px] border-line bg-red px-3 py-1 text-[14px] font-semibold text-white shadow-[0_3px_0_rgba(36,26,46,0.45)]">
      {text}
    </div>
  );
}
