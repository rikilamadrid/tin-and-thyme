import { useMemo } from "react";
import { buildGalley } from "../../galley/model";
import { RobotPortrait } from "../../galley/RobotPortrait";
import { officeActions, useOffice } from "../../store/office";
import { ContextGauge, StatusBadge, TicketBadge } from "../hud/CrewPanel";
import { effortLabel, modelLabel } from "../hud/telemetry";

/** The Pass: who this session is in the galley, next to the real workflow facts. */
export function CrewHeader({ id }: { id: string }) {
  const snap = useOffice((s) => s.snap);
  const c = useMemo(() => (snap ? buildGalley(snap).crew.find((x) => x.id === id) : null), [snap, id]);
  if (!c) return null;
  const task = c.ticket ? snap?.tasks.find((t) => t.id === c.ticket) : null;
  const rows: [string, React.ReactNode][] = [
    [
      "Ticket",
      c.ticket ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <TicketBadge id={c.ticket} />
          <span className="truncate">{task?.title ?? ""}</span>
          {task?.pf && <span className="text-[#a8b8d8]">· {task.pf.view?.label ?? `Pathfinder: ${task.pf.state}`}</span>}
          {task?.pf?.view?.next && <span className="w-full text-[12px] text-[#a8b8d8]">Next: {task.pf.view.next}</span>}
        </span>
      ) : (
        <span className="text-[#a8b8d8]">—</span>
      ),
    ],
    ["Session", <span>{c.session ? `${c.session} · ${c.running ? "live" : "finished"}` : c.isLead ? `coordinator · ${c.running ? "live" : "not running"}` : c.running ? "live" : "not running"}</span>],
    ["Worktree", <span className="block truncate font-mono text-[12px]" title={c.worktree ?? ""}>{c.worktree ? c.worktree.replace(/^.*?\/(\.pathfinder\/)/, "$1") : "—"}</span>],
    [
      "Context",
      <span className="flex flex-wrap items-center gap-2">
        <ContextGauge ctx={c.context} />
        {c.context && (
          <span className="text-[12px] text-[#a8b8d8]">
            {Math.round(c.context.used / 1000)}k of {Math.round(c.context.limit / 1000)}k tokens
          </span>
        )}
      </span>,
    ],
    ["Model", <Telemetry value={modelLabel(c.telemetry?.model)} raw={c.telemetry?.model ?? null} source={c.telemetry?.model ? c.telemetry.source : null} />],
    ["Effort", <Telemetry value={effortLabel(c.telemetry?.effort)} raw={null} source={c.telemetry?.effort ? c.telemetry.source : null} />],
  ];
  return (
    <div className="border-b-[3px] border-line bg-[#0c1226] px-3 py-2.5 font-[system-ui] text-[#eef6ff]">
      <div className="flex items-center gap-3">
        <RobotPortrait character={c.character} size={64} dim={!c.running} accent={c.color} />
        <div className="min-w-0 flex-1">
          <div className="text-[24px] font-black leading-[26px]">{c.name}</div>
          <div className="text-[15px] font-extrabold text-[#ffc93a]">
            {c.job} · {c.role[0]?.toUpperCase() + c.role.slice(1)}
          </div>
          <div className="text-[11px] font-semibold text-[#a8b8d8]">kitchen job · {snap?.workflow ? "Pathfinder role" : "role"}</div>
        </div>
        <StatusBadge c={c} />
      </div>
      {!c.running && (c.context || c.telemetry) && (
        <p className="m-0 mt-2 text-[12px] text-[#a8b8d8]">
          <span className="mr-1 rounded-[2px] bg-[#26314f] px-1 text-[10px] font-extrabold uppercase tracking-[0.06em]">last</span>
          Historical: the last values from this {c.session ? "finished session" : "session"}'s transcript.
        </p>
      )}
      <dl className="m-0 mt-2 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[#a8b8d8]">{k}</dt>
            <dd className="m-0 min-w-0">{v}</dd>
          </div>
        ))}
      </dl>
      {c.session && <FreshPanel id={id} ticket={c.ticket} />}
    </div>
  );
}

/** One telemetry value with where it came from: Observed (its own model calls) or Configured (requested only). */
function Telemetry({ value, raw, source }: { value: string; raw: string | null; source: "observed" | "configured" | null }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <b className="font-extrabold">{value}</b>
      {raw && raw !== value && <span className="font-mono text-[11px] text-[#7f8bb5]">{raw}</span>}
      {source && (
        <span
          className={`rounded-[3px] px-1.5 text-[10px] font-extrabold uppercase leading-[16px] tracking-[0.05em] ${source === "observed" ? "bg-[#123325] text-[#7fe0a8]" : "bg-[#2f2a14] text-[#ffd66b]"}`}
          title={source === "observed" ? "Read from this agent's own model calls" : "Only what was requested for this agent; no model call seen yet"}
        >
          {source === "observed" ? "Observed" : "Configured"}
        </span>
      )}
    </span>
  );
}

const STEP_LABEL = { pause: "Reach a safe pause", save: "Save and verify the checkpoint", dispatch: "Dispatch a fresh session through Pathfinder" } as const;
const STEP_MARK = { pending: "○", running: "◌", ok: "✓", failed: "✗" } as const;

/** Checkpoint & start fresh: readiness, the three steps as they run, and a retry that can't duplicate a worker. */
function FreshPanel({ id, ticket }: { id: string; ticket: string | null }) {
  const status = useOffice((s) => s.snap?.agents.find((a) => a.agentId === id));
  const handoff = useOffice((s) => (ticket ? s.snap?.workflow?.handoffs?.[ticket] : undefined));
  const threshold = useOffice((s) => s.snap?.workflow?.contextAlertPct ?? 35);
  const fresh = status?.fresh;
  const ctx = status?.context;
  const pct = ctx ? Math.round((ctx.used / ctx.limit) * 100) : null;
  const mine = handoff && handoff.from === id;
  return (
    <section aria-label="Fresh context" className="mt-2 rounded-[6px] bg-[#141d3a] px-2.5 py-2 ring-1 ring-[#26335c]">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[12px] font-extrabold uppercase tracking-[0.06em] text-[#a8b8d8]">Fresh context</b>
        <span className="text-[12px] text-[#a8b8d8]">
          {pct === null ? "Context —" : `Context ${pct}%`} · alert at {threshold}% (advisory)
        </span>
        <div className="flex-1" />
        {mine && handoff.phase === "failed" && handoff.retryable ? (
          <button className="btn px-2 text-[12px]" onClick={() => officeActions.retryHandoff(handoff.key)}>
            Retry
          </button>
        ) : (
          <button className="btn px-2 text-[12px]" disabled={!fresh?.can} title={fresh?.reason} onClick={() => officeActions.checkpointFresh(id)}>
            Checkpoint &amp; start fresh
          </button>
        )}
      </div>
      {!mine && fresh && <p className="m-0 mt-1.5 text-[12px] leading-[17px] text-[#c9d3e0]">{fresh.reason}</p>}
      {!fresh && <p className="m-0 mt-1.5 text-[12px] text-[#a8b8d8]">Not a Pathfinder worker session: nothing to hand off.</p>}
      {fresh?.pathfinderChange && (
        <details className="mt-1.5 text-[12px] leading-[17px] text-[#c9d3e0]">
          <summary className="cursor-pointer font-bold text-[#ffc93a]">What Pathfinder would need</summary>
          <p className="m-0 mt-1">{fresh.pathfinderChange}</p>
        </details>
      )}
      {mine && (
        <ol className="m-0 mt-1.5 list-none space-y-1 p-0 text-[12px] leading-[17px]">
          {(Object.keys(STEP_LABEL) as (keyof typeof STEP_LABEL)[]).map((k) => {
            const st = handoff.steps[k];
            return (
              <li key={k} className="flex gap-2">
                <span className={`w-3 shrink-0 font-black ${st.status === "ok" ? "text-[#7fe0a8]" : st.status === "failed" ? "text-[#ff7a9c]" : "text-[#a8b8d8]"}`} aria-label={st.status}>
                  {STEP_MARK[st.status]}
                </span>
                <span className="min-w-0">
                  <b className="font-bold">{STEP_LABEL[k]}</b>
                  {st.detail && <span className="block text-[#c9d3e0]">{st.detail}</span>}
                </span>
              </li>
            );
          })}
          {handoff.checkpoint && (
            <li className="truncate font-mono text-[11px] text-[#7f8bb5]" title={handoff.checkpoint}>
              checkpoint: {handoff.checkpoint}
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
