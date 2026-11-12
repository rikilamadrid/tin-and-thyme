// Where delivery shows up outside its drawer: a "Ready to deliver" entry on the
// ticket's board card, and a list in the action items. Labels for "Awaiting
// merge" and "Merged" belong to 06.1's shared ticket-state mapping; these only
// open the drawer.

import { isReadyToDeliver } from "../../data/delivery";
import { useOffice } from "../../store/office";
import { ui } from "../../store/ui";

/** On a board card: "Ready to deliver" and a Deliver… button, or Deliver… alone once delivery has started. */
export function DeliverButton({ taskId }: { taskId: string }) {
  const view = useOffice((s) => s.snap?.delivery?.byKey[taskId]);
  if (!view) return null;
  const ready = isReadyToDeliver(view);
  // Reviewed but waiting on another ticket (an unfinished blocker, or stacked on unmerged commits): say on what.
  if (!ready && !view.pr && view.outcome === "none") {
    if (view.readiness.engineState !== "done" || !view.readiness.waitingOn.length) return null;
    return (
      <div className="mt-1 text-[12px] text-muted" title={view.readiness.reason ?? undefined}>
        Waiting on {view.readiness.waitingOn.join(", ")}
        {view.readiness.stacked ? " (stacked)" : ""}
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[12px]">
      {ready && (
        <span className="chip text-[11px]" style={{ background: "#00e436" }}>
          Ready to deliver
        </span>
      )}
      <button className="btn px-1.5 text-[11px]" onClick={() => ui.openDelivery(taskId)}>
        Deliver…
      </button>
    </div>
  );
}

/** In the action items: every ticket that is ready to deliver. */
export function ReadyToDeliverList() {
  const board = useOffice((s) => s.snap?.delivery);
  const ready = Object.values(board?.byKey ?? {})
    .filter(isReadyToDeliver)
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  if (!ready.length) return null;
  return (
    <>
      <h4 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-muted">Ready to deliver</h4>
      <ul className="mb-4 flex flex-col gap-1.5 text-[14px]">
        {ready.map((v) => (
          <li key={v.key} className="flex items-center gap-2 border-[3px] border-line bg-card px-2.5 py-1.5">
            <span className="flex-1">
              <b>{v.key}</b> {v.title ?? ""} passed review and is ready to deliver
            </span>
            <button className="btn px-2 text-[12px]" onClick={() => ui.openDelivery(v.key)}>
              Deliver…
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
