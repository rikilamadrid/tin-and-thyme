import { FIXTURE_LABEL } from "../../data/fixture/busyFixture";
import type { SimSpeed } from "../../data/source";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { usePrefs } from "../../store/prefs";
import { ui, useUi } from "../../store/ui";
import { MarkIcon } from "./CrewPanel";

const SPEEDS: SimSpeed[] = [1, 2, 4];

export function Logo() {
  return (
    <svg className="h-[30px] w-[30px] shrink-0" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden>
      <rect x="1" y="1" width="8" height="8" fill="#241a2e" />
      <rect x="2" y="2" width="6" height="6" fill="#29adff" />
      <rect x="3" y="3" width="1" height="2" fill="#fff6e9" />
      <rect x="6" y="3" width="1" height="2" fill="#fff6e9" />
      <rect x="3" y="6" width="4" height="1" fill="#1d2b53" />
      <rect x="4" y="0" width="2" height="1" fill="#ffec27" />
    </svg>
  );
}

type Look = "pixel" | "cel";

/** A toolbar button in the galley's style: roster typography, an optional count, a visible keyboard focus ring. */
function TbButton({
  look,
  label,
  count,
  onClick,
  title,
  pressed,
  alert = false,
}: {
  look: Look;
  label: string;
  count?: number | string;
  onClick: () => void;
  title?: string;
  pressed?: boolean;
  alert?: boolean;
}) {
  const shape = look === "pixel" ? "rounded-[3px] shadow-[0_2px_0_#05070f]" : "rounded-[8px] shadow-[0_1px_6px_rgba(0,0,0,0.35)]";
  const tone = alert
    ? "bg-[#ff4f7b] text-[#141a2e] ring-[#ff8fab] hover:bg-[#ff6b90]"
    : pressed
      ? "bg-[#26335c] text-[#eef6ff] ring-[#ffc93a]"
      : "bg-[#141d3a] text-[#eef6ff] ring-[#26335c] hover:bg-[#1a2448]";
  return (
    <button
      type="button"
      className={`inline-flex h-[32px] cursor-pointer items-center gap-1.5 whitespace-nowrap px-2.5 font-[system-ui] text-[13px] font-extrabold ring-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffc93a] ${shape} ${tone}`}
      onClick={onClick}
      title={title}
      aria-pressed={pressed}
    >
      {alert && <MarkIcon k="needs" size={12} color="#141a2e" />}
      {label}
      {count !== undefined && count !== 0 && count !== "" && (
        <span className={`rounded-[3px] px-1.5 text-[12px] font-black leading-[18px] tabular-nums ${alert ? "bg-[#141a2e] text-[#ff8fab]" : "bg-[#26314f] text-[#eef6ff]"}`}>{count}</span>
      )}
    </button>
  );
}

const Divider = () => <span className="h-[24px] w-px shrink-0 bg-[#26335c]" aria-hidden />;

export function TopBar() {
  const snap = useOffice((s) => s.snap);
  const speed = useOffice((s) => s.speed);
  const hasDev = useOffice((s) => s.presets !== null);
  const planBoardId = useUi((s) => s.planBoardId);
  const attention = selectAttention(snap).total;
  const debugOpen = useUi((s) => s.debugOpen);
  const live = useOffice((s) => s.live);
  const fixture = useOffice((s) => s.fixture);
  const look = usePrefs((s) => s.artStyle);
  if (!snap) return null;
  const setupIssues = snap.setup.checks.filter((c) => c.status !== "ok").length;
  // A finished workflow session is history, not something to restart.
  const finishedWorker = new Set(snap.config.team.filter((a) => a.crew?.session).map((a) => a.id));
  const stopped = snap.agents.filter((a) => (a.session.state === "stopped" || a.session.state === "failed") && !finishedWorker.has(a.agentId));

  // Live: count real running sessions. Mock: every agent counts as running.
  const runningIds = new Set(snap.agents.filter((a) => a.session.state === "running").map((a) => a.agentId));
  const sandboxes = snap.config.team.filter((a) => a.mode === "sandbox" && runningIds.has(a.id)).length;
  const local = snap.config.team.filter((a) => a.mode === "local" && runningIds.has(a.id)).length;
  const openPrs = snap.pullRequests.filter((p) => !p.merged && !p.closed).length;
  const barShape = look === "pixel" ? "rounded-[4px] shadow-[0_3px_0_#05070f]" : "rounded-[10px] shadow-[0_2px_12px_rgba(0,0,0,0.45)]";

  return (
    <header
      className={`fixed left-4 right-4 top-[10px] z-10 flex h-[54px] items-center gap-3 bg-[#0c1226] px-3 font-[system-ui] text-[#eef6ff] ring-1 ring-[#26335c] ${barShape}`}
    >
      <div className="flex min-w-0 shrink items-center gap-3">
        <b className="whitespace-nowrap text-[24px] font-black leading-none tracking-[0.01em] text-[#ffc93a]">TIN &amp; THYME</b>
        <Divider />
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-2 whitespace-nowrap text-[14px] font-extrabold">
            {snap.config.project.name}
            {fixture ? (
              <span className="rounded-[3px] bg-[#ff8a3a] px-1.5 text-[11px] font-black uppercase leading-[16px] tracking-[0.06em] text-[#141a2e]" title="A fixed sample scene for checking the layout. Nothing here is live, and no action reaches a server.">
                Fixture · {FIXTURE_LABEL[fixture]}
              </span>
            ) : (
              !live && (
                <span className="rounded-[3px] bg-[#ffc93a] px-1.5 text-[11px] font-black uppercase leading-[16px] tracking-[0.06em] text-[#141a2e]" title="Running on mock data. Start the real HQ with `pnpm dev:hq`.">
                  Demo data
                </span>
              )
            )}
          </div>
          <div className="truncate text-[12px] font-semibold text-[#a8b8d8]" title={snap.config.project.repo}>
            {snap.workflow ? `Pathfinder ${snap.workflow.mode}${snap.workflow.store ? ` · ${snap.workflow.store}` : ""}` : snap.config.project.repo}
          </div>
        </div>
      </div>
      <div className="min-w-6 flex-1" />

      {hasDev && (
        <div className="flex items-center gap-1.5" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <TbButton key={s} look={look} label={`${s}x`} pressed={speed === s} onClick={() => officeActions.setSpeed(s)} />
          ))}
        </div>
      )}

      <div
        className={`flex h-[32px] shrink-0 items-center gap-2 whitespace-nowrap bg-[#141d3a] px-2.5 text-[13px] font-semibold text-[#a8b8d8] ring-1 ring-[#26335c] ${look === "pixel" ? "rounded-[3px]" : "rounded-[8px]"}`}
        title="Running sessions: Local mode runs on this machine; Sandbox mode runs each agent in its own Docker Sandbox (microVM)"
        role="status"
        aria-label={`Running sessions: ${local} local, ${sandboxes} sandbox`}
      >
        <i className="led" style={runningIds.size ? undefined : { background: "#83769c", animation: "none" }} />
        <span className="text-[11px] font-extrabold uppercase tracking-[0.08em]">Running</span>
        <span>
          <b className="font-black tabular-nums text-[#eef6ff]">{local}</b> local
        </span>
        <span className="text-[#56628a]">·</span>
        <span>
          <b className="font-black tabular-nums text-[#eef6ff]">{sandboxes}</b> sandbox
        </span>
      </div>

      <Divider />
      {live && stopped.length > 0 && (
        <TbButton look={look} label={`Start ${stopped.length === snap.agents.length ? "team" : `${stopped.length} stopped`}`} onClick={() => stopped.forEach((a) => officeActions.startAgent(a.agentId))} />
      )}
      {live && <TbButton look={look} label={setupIssues ? "Setup" : "Setup ✓"} count={setupIssues} title="Setup checklist" onClick={() => ui.openSetup()} />}
      <TbButton
        look={look}
        label="Action items"
        count={attention}
        alert={attention > 0}
        title={attention ? `${attention} waiting on you` : "Everything waiting on you"}
        onClick={() => ui.openActions()}
      />
      <TbButton look={look} label="Boards" onClick={() => ui.openBoards(planBoardId ?? undefined)} />
      <TbButton look={look} label="PRs" count={openPrs} onClick={() => ui.openPrs()} />
      <TbButton look={look} label="Terminal" title="Your own shell on this machine: the repo, an agent's folder or any folder" onClick={() => ui.openTerminal()} />
      <Divider />
      <TbButton look={look} label="Settings" onClick={() => ui.openSettings("team")} />
      <TbButton look={look} label="Debug" pressed={debugOpen} title="Debug panel (D)" onClick={() => ui.toggleDebug()} />
    </header>
  );
}
