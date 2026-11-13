import { useMemo } from "react";
import { CHARACTERS } from "../../data/crew";
import { buildGalley, stageWords, type CrewMember, type RoleInfo, type TicketCard } from "../../galley/model";
import type { WorkflowHelper } from "../../data/types";
import { RobotPortrait } from "../../galley/RobotPortrait";
import { useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { ACTIVITY_H } from "./ActivityFeed";
import { effortLabel, modelLabel } from "./telemetry";

/** The roster column at the left, outside the room (as in the original JSM HQ). */
export const CREW_W = 280;

type Mark = "needs" | "work" | "review" | "off" | "wait" | "idle";

/** The scene's state marks as inline SVG: shape carries the meaning, not colour. */
export function MarkIcon({ k, size = 11, color = "currentColor" }: { k: Mark; size?: number; color?: string }) {
  const p: Record<Mark, JSX.Element> = {
    work: <rect x="1" y="1" width="3" height="3" fill={color} />,
    idle: <rect x="1.3" y="1.3" width="2.4" height="2.4" fill="none" stroke={color} strokeWidth="0.8" />,
    review: (
      <>
        <circle cx="2" cy="2" r="1.4" fill="none" stroke={color} strokeWidth="0.9" />
        <path d="M3 3 L4.6 4.6" stroke={color} strokeWidth="1.1" strokeLinecap="round" />
      </>
    ),
    needs: (
      <>
        <path d="M2.5 0 L5 2.5 L2.5 5 L0 2.5Z" fill={color} />
        <rect x="2.1" y="1" width=".8" height="2" fill="#141a2e" />
        <rect x="2.1" y="3.4" width=".8" height=".8" fill="#141a2e" />
      </>
    ),
    wait: <path d="M0 0 H5 L3 2.5 L5 5 H0 L2 2.5Z" fill={color} />,
    off: <path d="M3.5 .2 A2.4 2.4 0 1 0 3.5 4.8 A1.8 1.8 0 1 1 3.5 .2Z" fill={color} />,
  };
  return (
    <svg width={size} height={size} viewBox="-0.3 -0.3 5.6 5.6" aria-hidden className="shrink-0">
      {p[k]}
    </svg>
  );
}

function markFor(c: CrewMember): Mark {
  if (c.state === "needs") return "needs";
  if (c.state === "review") return "review";
  if (c.state === "work") return "work";
  if (c.state === "idle") return "idle";
  return "off";
}

export function TicketBadge({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center rounded-[3px] bg-[#f4f8ff] px-1.5 font-[system-ui] text-[12px] font-black leading-[18px] text-[#141a2e]" title={`Ticket ${id}`}>
      {id}
    </span>
  );
}

export function StatusBadge({ c }: { c: CrewMember }) {
  const alert = c.state === "needs";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[3px] px-1.5 text-[11px] font-extrabold leading-[18px] ${alert ? "bg-[#ff4f7b] text-[#141a2e]" : c.running ? "bg-[#f4f8ff] text-[#4b6182]" : "bg-[#26314f] text-[#a8b8d8]"}`}
    >
      <MarkIcon k={markFor(c)} color={alert || c.running ? "#141a2e" : "#a8b8d8"} />
      {c.status}
    </span>
  );
}

export function ContextGauge({ ctx }: { ctx: { used: number; limit: number } | null }) {
  if (!ctx) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] font-extrabold text-[#a8b8d8]" title="Context use isn't available for this session">
        CTX <span className="text-[#eef6ff]">—</span>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((ctx.used / ctx.limit) * 100));
  const on = Math.round(pct / 10);
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-extrabold text-[#a8b8d8]" title={`${Math.round(ctx.used / 1000)}k of ${Math.round(ctx.limit / 1000)}k tokens in context (from the session transcript)`}>
      CTX
      <span className="flex gap-[2px]">
        {Array.from({ length: 10 }, (_, k) => (
          <i key={k} className="block h-[8px] w-[4px]" style={{ background: k < on ? (pct >= 85 ? "#ff8a3a" : "#ffc93a") : "#26335c" }} />
        ))}
      </span>
      <span className="text-[#eef6ff]">{pct}%</span>
    </div>
  );
}

/**
 * Context · model · effort for this agent's own session, in one compact row that wraps on narrow cards.
 * A finished session keeps its last observed values, marked "last". Missing values show "—".
 */
export function UsageRow({ c }: { c: CrewMember }) {
  const t = c.telemetry;
  const from = t ? (t.source === "observed" ? "observed in this session" : "configured for this session (no model call seen yet)") : "not available";
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] font-extrabold leading-[14px] text-[#a8b8d8]" title={`Model and effort: ${from}${c.running ? "" : " · last values from the finished session"}`}>
      {!c.running && (
        <span className="rounded-[2px] bg-[#26314f] px-1 text-[9px] uppercase tracking-[0.06em] text-[#a8b8d8]" aria-label="Historical: last readings from the finished session">
          last
        </span>
      )}
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <ContextGauge ctx={c.context} />
        {c.agent.contextAlert && (
          <span
            className="rounded-[3px] bg-[#ffc93a] px-1 text-[9px] font-black uppercase leading-[14px] tracking-[0.04em] text-[#141a2e]"
            title={`Context at ${c.agent.contextAlert.pct}% (alert at ${c.agent.contextAlert.threshold}%). Advisory: open the drawer to checkpoint and start fresh.`}
          >
            ◔ Context check
          </span>
        )}
        <span aria-hidden>·</span>
      </span>
      {/* Separators trail each item, so a wrapped line never starts with one. */}
      <span className="whitespace-nowrap text-[#eef6ff]" aria-label={`Model ${modelLabel(t?.model)}`}>
        {modelLabel(t?.model)}
        <span className="ml-1.5 text-[#a8b8d8]" aria-hidden>
          ·
        </span>
      </span>
      <span className="whitespace-nowrap text-[#eef6ff]" aria-label={`Effort ${effortLabel(t?.effort)}`}>
        {effortLabel(t?.effort)}
      </span>
    </div>
  );
}

function CrewCard({ c, selected }: { c: CrewMember; selected: boolean }) {
  const alert = c.state === "needs";
  return (
    <button
      className={`relative grid w-full cursor-pointer grid-cols-[48px_1fr] gap-x-2 rounded-[6px] bg-[#141d3a] p-2 text-left font-[system-ui] text-[#eef6ff] outline-offset-[-2px] hover:bg-[#1a2448] ${selected ? "outline outline-2 outline-[#ffc93a]" : alert ? "outline outline-2 outline-[#ff4f7b]" : ""}`}
      onClick={() => ui.openAgent(c.id)}
      aria-label={`${c.name}, ${c.job}. Pathfinder role ${c.role}.${c.ticket ? ` Ticket ${c.ticket}.` : ""} ${c.status}.`}
    >
      {alert && <i className="absolute bottom-0 left-0 top-0 w-[4px] rounded-l-[6px] bg-[#ff4f7b]" />}
      <RobotPortrait character={c.character} size={48} dim={!c.running} accent={c.color} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[15px] font-extrabold leading-[18px]">
          {/* The agent's colour (Settings → Team): the same one as its robot's accent and its kitchen name tag. */}
          {c.color && <i className="block h-[10px] w-[10px] shrink-0 rounded-[2px]" style={{ background: c.color }} aria-hidden />}
          <span className="truncate">{c.name}</span>
        </div>
        <div className="truncate text-[11px] font-bold leading-[14px] text-[#a8b8d8]">{c.job}</div>
        <div className="truncate text-[11px] font-extrabold leading-[14px] text-[#ffc93a]" title="Pathfinder role">
          {c.role}
          {c.session && c.session !== "implementation" && c.session !== c.role ? ` · ${c.session}` : ""}
        </div>
      </div>
      <div className="col-span-2 mt-1.5 flex flex-wrap items-center gap-1">
        {c.ticket && <TicketBadge id={c.ticket} />}
        <StatusBadge c={c} />
      </div>
      <div className="col-span-2 mt-1.5">
        <UsageRow c={c} />
      </div>
    </button>
  );
}

function RoleRow({ r }: { r: RoleInfo }) {
  const ch = r.character === "cook" ? null : CHARACTERS[r.character];
  const look = ch ? `${ch.name} · ${ch.job}` : "cook bots (Pepper, Roux, Ember, …)";
  const state = r.running ? `${r.running} running` : r.finished ? `${r.finished} finished` : "no session";
  return (
    <li className="flex items-center gap-2 py-[3px]" title={r.description}>
      <RobotPortrait character={r.character === "cook" ? "pepper" : r.character} size={24} dim={!r.running} />
      <b className="w-[86px] shrink-0 truncate text-[12px] text-[#eef6ff]">{r.name}</b>
      <span className="min-w-0 flex-1 truncate text-[11px] text-[#a8b8d8]">{look}</span>
      <span className={`shrink-0 text-[11px] font-bold ${r.running ? "text-[#ffc93a]" : "text-[#7f8bb5]"}`}>{state}</span>
    </li>
  );
}

/** Delegated helpers of one session: running ones first, finished ones folded into its history. */
function HelperList({ helpers }: { helpers: WorkflowHelper[] }) {
  if (!helpers.length) return null;
  const live = helpers.filter((h) => !h.finished);
  const done = helpers.filter((h) => h.finished);
  const row = (h: WorkflowHelper) => (
    <li key={h.id} className="flex min-w-0 gap-1.5 text-[11px] leading-[15px]" title={h.label}>
      <b className={`shrink-0 ${h.finished ? "text-[#7f8bb5]" : "text-[#9fe7ff]"}`}>{h.type}</b>
      <span className={`truncate ${h.finished ? "text-[#7f8bb5]" : "text-[#cfd8ec]"}`}>{h.label}</span>
    </li>
  );
  return (
    <div className="mt-1.5 rounded-[4px] bg-[#0f1630] px-2 py-1">
      {live.length > 0 && (
        <>
          <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#a8b8d8]">Helpers · {live.length} running</div>
          <ul className="m-0 list-none p-0">{live.map(row)}</ul>
        </>
      )}
      {done.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#7f8bb5]">{done.length} finished helper{done.length === 1 ? "" : "s"}</summary>
          <ul className="m-0 list-none p-0">{done.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

const OUTCOME: Record<string, string> = { "handed-off": "Handed off", gate: "Stopped at a human gate", failed: "Reported failure", interrupted: "Interrupted" };

/** One finished session in a ticket's history: who, which stage, how it ended, its result and last readings. */
function HistoryRow({ c, helpers }: { c: CrewMember; helpers: WorkflowHelper[] }) {
  const e = c.ended;
  const how = e ? `${OUTCOME[e.outcome]}${e.outcome === "handed-off" && e.next ? ` → ${e.next}` : ""}` : "Finished";
  return (
    <li className="border-t border-[#26335c] pt-1.5 first:border-t-0 first:pt-0">
      <button type="button" className="flex w-full cursor-pointer items-center gap-1.5 bg-transparent p-0 text-left text-[#eef6ff] hover:underline" onClick={() => ui.openAgent(c.id)} aria-label={`${c.name}, ${c.role}, ${c.session ?? ""} session: ${how}`}>
        <RobotPortrait character={c.character} size={20} dim accent={c.color} />
        <b className="text-[12px]">{c.name}</b>
        <span className="truncate text-[11px] text-[#a8b8d8]">
          {c.role} · {stageWords(c.session)}
        </span>
      </button>
      <div className={`mt-0.5 text-[11px] font-bold ${e?.outcome === "interrupted" ? "text-[#ffb35c]" : e?.outcome === "gate" || e?.outcome === "failed" ? "text-[#ff8fab]" : "text-[#7fe0a8]"}`}>{how}</div>
      {e?.result && (
        <div className="line-clamp-2 text-[11px] leading-[14px] text-[#cfd8ec]" title={e.result}>
          {e.result}
        </div>
      )}
      <div className="mt-0.5">
        <UsageRow c={c} />
      </div>
      <HelperList helpers={helpers} />
    </li>
  );
}

const PHASE_STYLE: Record<TicketCard["phase"], { chip: string; mark: Mark; color: string }> = {
  needs: { chip: "bg-[#ff4f7b] text-[#141a2e]", mark: "needs", color: "#141a2e" },
  failed: { chip: "bg-[#ff4f7b] text-[#141a2e]", mark: "needs", color: "#141a2e" },
  live: { chip: "bg-[#f4f8ff] text-[#4b6182]", mark: "work", color: "#141a2e" },
  waiting: { chip: "bg-[#26314f] text-[#cfe3ff]", mark: "wait", color: "#cfe3ff" },
  interrupted: { chip: "bg-[#3a2a1a] text-[#ffb35c]", mark: "idle", color: "#ffb35c" },
  done: { chip: "bg-[#d9f2e3] text-[#14402a]", mark: "review", color: "#14402a" },
  "next-round": { chip: "bg-[#26314f] text-[#a8b8d8]", mark: "wait", color: "#a8b8d8" },
  stale: { chip: "bg-[#26314f] text-[#a8b8d8]", mark: "idle", color: "#a8b8d8" },
};

/** A ticket in flight. It stays put while sessions come and go, and keeps each one's result in its history. */
function TicketCardView({ t, helpers, selected }: { t: TicketCard; helpers: WorkflowHelper[]; selected: string | null }) {
  const st = PHASE_STYLE[t.phase];
  const c = t.current;
  const helpersOf = (id: string) => helpers.filter((h) => h.parent === id);
  return (
    <article
      aria-label={`Ticket ${t.key}, ${t.title}: ${t.label}${t.needsYou && t.phase !== "needs" ? ". Needs you." : ""}`}
      className={`relative rounded-[6px] bg-[#141d3a] p-2 font-[system-ui] text-[#eef6ff] ${t.needsYou ? "outline outline-2 outline-offset-[-2px] outline-[#ff4f7b]" : c && selected === c.id ? "outline outline-2 outline-offset-[-2px] outline-[#ffc93a]" : ""}`}
    >
      {t.needsYou && <i className="absolute bottom-0 left-0 top-0 w-[4px] rounded-l-[6px] bg-[#ff4f7b]" />}
      <div className="flex items-center gap-1.5">
        <TicketBadge id={t.key} />
        <span className="min-w-0 truncate text-[12px] font-bold text-[#cfd8ec]" title={t.title}>
          {t.title}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className={`inline-flex items-center gap-1 rounded-[3px] px-1.5 text-[11px] font-extrabold leading-[18px] ${st.chip}`}>
          <MarkIcon k={st.mark} color={st.color} />
          {t.label}
        </span>
        {t.needsYou && t.phase !== "needs" && (
          <span className="inline-flex items-center gap-1 rounded-[3px] bg-[#ff4f7b] px-1.5 text-[11px] font-extrabold leading-[18px] text-[#141a2e]">
            <MarkIcon k="needs" color="#141a2e" /> Needs you
          </span>
        )}
      </div>
      {t.gate && (
        <button type="button" className="mt-1 block w-full cursor-pointer bg-transparent p-0 text-left text-[11px] leading-[14px] text-[#ff8fab] hover:underline" onClick={() => ui.openActions()} title="Open Action items">
          {t.gate}
        </button>
      )}
      {c && (
        <button
          type="button"
          className="mt-1.5 grid w-full cursor-pointer grid-cols-[36px_1fr] gap-x-2 rounded-[4px] bg-[#0f1630] p-1.5 text-left text-[#eef6ff] hover:bg-[#18224a]"
          onClick={() => ui.openAgent(c.id)}
          aria-label={`${c.name}, ${c.job}. Pathfinder role ${c.role}, ${stageWords(c.session)}. ${c.status}.`}
        >
          <RobotPortrait character={c.character} size={36} accent={c.color} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-extrabold leading-[16px]">
              {c.name} <span className="text-[11px] font-bold text-[#a8b8d8]">· {c.job}</span>
            </div>
            <div className="truncate text-[11px] font-extrabold leading-[14px] text-[#ffc93a]" title="Pathfinder role and stage">
              {c.role} · {stageWords(c.session)}
            </div>
          </div>
          <div className="col-span-2 mt-1">
            <UsageRow c={c} />
          </div>
          {c.agent.note && <div className="col-span-2 mt-0.5 truncate text-[11px] text-[#a8b8d8]">{c.agent.note}</div>}
        </button>
      )}
      {c && <HelperList helpers={helpersOf(c.id)} />}
      {t.history.length > 0 && (
        <details className="mt-1.5" open={!c && t.phase !== "next-round"}>
          <summary className="cursor-pointer text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#a8b8d8]">
            History · {t.history.length} session{t.history.length === 1 ? "" : "s"}
          </summary>
          <ol className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0">
            {[...t.history].reverse().map((h) => (
              <HistoryRow key={h.id} c={h} helpers={helpersOf(h.id)} />
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

export function CrewPanel() {
  const snap = useOffice((s) => s.snap);
  const drawer = useUi((s) => s.drawer);
  const model = useMemo(() => (snap ? buildGalley(snap) : null), [snap]);
  if (!model) return null;
  const selected = drawer?.kind === "agent" ? drawer.id : null;
  const onShift = model.crew.filter((c) => c.running);
  // Workflow sessions appear in their ticket's card; the roster lists the rest (the coordinator, native crews).
  const carded = new Set(model.tickets.flatMap((t) => (t.current ? [t.current.id] : [])));
  const rosterOnly = onShift.filter((c) => !carded.has(c.id));
  const offShift = model.crew.filter((c) => !c.running && c.place !== "gone");
  const needs = onShift.filter((c) => c.state === "needs").length;
  const gated = model.tickets.filter((t) => t.needsYou).length;
  const helpers = model.allHelpers;
  const coordinatorHelpers = helpers.filter((h) => (h.parent ?? "coordinator") === (model.coordinator?.id ?? "coordinator"));

  return (
    <section aria-label="Crew" className="fixed left-4 top-[74px] z-10 flex flex-col gap-2 font-[system-ui]" style={{ width: CREW_W, bottom: 16 + ACTIVITY_H + 10 }}>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
        <h2 className="m-0 flex items-baseline gap-2 text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#a8b8d8]">
          Crew · {onShift.length} on shift
          {needs > 0 && (
            <span className="inline-flex items-center gap-1 text-[#ff4f7b]">
              <MarkIcon k="needs" color="#ff4f7b" />
              {needs} need you
            </span>
          )}
        </h2>
        {rosterOnly.length ? (
          <div className="flex flex-col gap-2">
            {rosterOnly.map((c) => (
              <div key={c.id}>
                <CrewCard c={c} selected={selected === c.id} />
                {c.isLead && <HelperList helpers={coordinatorHelpers} />}
              </div>
            ))}
          </div>
        ) : (
          !onShift.length && <p className="m-0 rounded-[6px] bg-[#141d3a] p-2 text-[12px] text-[#a8b8d8]">No session is running. Start the orchestration from the Head Chef's card.</p>
        )}
        {model.tickets.length > 0 && (
          <>
            <h2 className="m-0 mt-1 flex items-baseline gap-2 text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#a8b8d8]">
              Tickets · {model.tickets.length} in flight
              {gated > 0 && (
                <span className="inline-flex items-center gap-1 text-[#ff4f7b]">
                  <MarkIcon k="needs" color="#ff4f7b" />
                  {gated} need you
                </span>
              )}
            </h2>
            <div className="flex flex-col gap-2">
              {model.tickets.map((t) => (
                <TicketCardView key={t.key} t={t} helpers={helpers} selected={selected} />
              ))}
            </div>
            {model.departed > 0 && <p className="m-0 text-[11px] text-[#7f8bb5]">{model.departed} finished session{model.departed === 1 ? "" : "s"} this run · each is in its ticket's history</p>}
          </>
        )}
        {offShift.length > 0 && (
          <>
            <h2 className="m-0 mt-1 text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#a8b8d8]">Off shift · {offShift.length}</h2>
            <div className="flex flex-col gap-2">
              {offShift.map((c) => (
                <CrewCard key={c.id} c={c} selected={selected === c.id} />
              ))}
            </div>
          </>
        )}
        {model.roles.length > 0 && (
          <>
            <h2 className="m-0 mt-1 text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#a8b8d8]">Configured roles · {model.roles.length}</h2>
            <ul className="m-0 list-none rounded-[6px] bg-[#141d3a] px-2 py-1">
              {model.roles.map((r) => (
                <RoleRow key={r.name} r={r} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
