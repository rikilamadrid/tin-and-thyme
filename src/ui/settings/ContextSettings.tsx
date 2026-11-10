import { useState } from "react";
import { officeActions, useOffice } from "../../store/office";

/** Settings → Context: when a worker's own context use earns a "Context check" (per project, advisory). */
export function ContextSettings() {
  const workflow = useOffice((s) => s.snap?.workflow);
  const live = useOffice((s) => s.live);
  const pct = workflow?.contextAlertPct ?? 35;
  const [draft, setDraft] = useState(String(pct));
  const commit = () => {
    const v = Math.round(Number(draft));
    if (Number.isFinite(v) && v >= 5 && v <= 95 && v !== pct) officeActions.setContextAlert(v);
    else setDraft(String(pct));
  };
  return (
    <div className="flex max-w-[680px] flex-col gap-4">
      <div>
        <h3 className="m-0 text-[18px] font-bold">Context alerts</h3>
        <p className="m-0 mt-1 text-[13px] text-muted">
          A worker whose own observed context use reaches this share of its window gets a small Context check badge on its card. It shows once per crossing and re-arms when the
          worker drops below the threshold or starts a fresh session. It's advice only: nothing restarts unless you press Checkpoint &amp; start fresh in the agent's drawer. Workers
          with no telemetry show — and never alert. Saved for this project in Tin &amp; Thyme's own state (~/.controlroom), not in the repository.
        </p>
      </div>
      {workflow ? (
        <label className="flex items-center gap-3 border-[3px] border-line bg-card px-3 py-2.5">
          <span className="text-[15px] font-semibold">Alert at</span>
          <input
            className="field w-[90px] text-right"
            type="number"
            min={5}
            max={95}
            step={1}
            value={draft}
            disabled={!live}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            aria-label="Context alert threshold, percent"
          />
          <span className="text-[15px] font-semibold">% of the context window used</span>
          <span className="ml-auto text-[12px] text-muted">default 35%</span>
        </label>
      ) : (
        <p className="m-0 text-[13px] text-muted">Context alerts are for workflow projects (Pathfinder), where Tin &amp; Thyme reads each worker's own transcript.</p>
      )}
    </div>
  );
}
