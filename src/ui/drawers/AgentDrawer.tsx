import { useEffect, useState, type ReactNode } from "react";
import { CLI_LABEL, HUMAN_ID, type AccessRequest, type AgentConfig, type AgentStatus, type OfficeSnapshot } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui, type AgentTab } from "../../store/ui";
import { ago, Dot, ReviewChip, SectionTitle, StateChip, Tabs, useNow } from "../kit";
import { CrewHeader } from "./CrewHeader";
import { DrawerHeader } from "./Drawer";
import { PortBanner, PortsRow } from "./Ports";
import { TerminalView } from "./TerminalView";
import { AgentSummary } from "./AgentSummary";
import { AgentFreshContext } from "./AgentFreshContext";


export function AgentDrawer({ id, initialTab }: { id: string; initialTab?: AgentTab }) {
  const snap = useOffice((s) => s.snap);
  const connected = useOffice((s) => s.live && s.connection === "open");
  const [tab, setTab] = useState<AgentTab>(initialTab ?? "terminal");
  const agent = snap?.config.team.find((a) => a.id === id);
  const status = snap?.agents.find((a) => a.agentId === id);
  // Opening the drawer is seeing the context alert: it clears until the next crossing.
  const alerting = !!status?.contextAlert;
  useEffect(() => {
    if (alerting) officeActions.ackContextAlert(id);
  }, [alerting, id]);
  if (!snap || !agent || !status) {
    return (
      <>
        <DrawerHeader>
          <b>Agent removed</b>
        </DrawerHeader>
      </>
    );
  }
  const unread = snap.messages.filter((m) => m.toId === id).length;
  // A workflow worker is a background subagent of the coordinator: its view is an activity transcript, and
  // Claude Code offers no way to type into it. Only the coordinator's (and native agents') terminals are live.
  const transcriptOnly = !!agent.crew?.session && !agent.isLead;
  const access = snap.accessRequests?.find((r) => r.agentId === id && r.status === "pending");

  return (
    <>
      <DrawerHeader>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <b className="text-[18px]">{agent.name}</b>
            <StateChip state={status.state} />
          </div>
          <div className="truncate font-term text-[17px] text-muted">
            {agent.role} · {CLI_LABEL[agent.cli]}{agent.model ? ` ${agent.model}` : ""} · {agent.mode === "sandbox" ? "Docker Sandbox" : "Local mode"}
          </div>
        </div>
      </DrawerHeader>
      <CrewHeader id={id} />
      <SessionBar agent={agent} status={status} />
      <AgentSummary agent={agent} status={status} connected={connected} onRequest={() => officeActions.summariseAgent(id)} />
      <AgentFreshContext agent={agent} status={status} connected={connected} onRequest={() => officeActions.freshContext(id)} />
      {access ? (
        <AccessCard request={access} agent={agent} />
      ) : (
        status.note && (
          // One line, always: a note that wraps or unwraps would change the terminal's height under you.
          <div className={`truncate border-b-[3px] border-line px-3 py-1.5 text-[14px] ${status.state === "needs-input" ? "bg-danger text-[#ff7a9c]" : "bg-cream-2"}`} title={status.note}>
            {status.note}
            {status.state === "needs-input" &&
              (transcriptOnly ? (
                <button className="ml-2 underline" onClick={() => ui.openActions()}>
                  — answer in Action items (sent through the coordinator)
                </button>
              ) : (
                <span className="ml-2 text-muted">— answer in the terminal and press Enter</span>
              ))}
          </div>
        )
      )}
      <BlockedRequests agent={agent} />
      <PortBanner agent={agent} status={status} />
      <div className="border-b-[3px] border-line px-3 py-2">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "terminal", label: transcriptOnly ? "Activity" : "Terminal" },
            { id: "shell", label: "Shell" },
            { id: "task", label: "Task" },
            { id: "sandbox", label: "Sandbox" },
            { id: "messages", label: `Messages${unread ? ` · ${unread}` : ""}` },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "terminal" &&
          (status.session.state === "running" ? (
            transcriptOnly ? (
              <div className="flex h-full flex-col">
                <div className="border-b-[3px] border-line bg-cream-2 px-3 py-1 text-[12px] text-muted">
                  Activity transcript of a background session (read-only). It can't be typed to; answer its requests in Action items, through the coordinator.
                </div>
                <div className="min-h-0 flex-1">
                  <TerminalView agentId={id} readOnly />
                </div>
              </div>
            ) : (
              <TerminalView agentId={id} />
            )
          ) : (
            <NotRunning agent={agent} status={status} />
          ))}
        {tab === "shell" && <ShellTab agent={agent} status={status} />}
        {tab === "task" && <TaskTab snap={snap} agent={agent} taskId={status.currentTaskId} />}
        {tab === "sandbox" && <SandboxTab snap={snap} agent={agent} />}
        {tab === "messages" && <MessagesTab snap={snap} agent={agent} />}
      </div>
    </>
  );
}

/** A plain shell inside the agent's sandbox (Local mode: in its folder), beside the agent's own session. */
function ShellTab({ agent, status }: { agent: AgentConfig; status: AgentStatus }) {
  const running = status.session.state === "running";
  const [n, setN] = useState(0); // bumps to open a fresh shell
  useEffect(() => {
    if (running) officeActions.openShell(agent.id);
  }, [agent.id, running, n]);
  if (!running)
    return <div className="p-4 text-[14px] text-muted">Start {agent.name} first. The shell opens inside {agent.mode === "sandbox" ? "their sandbox" : "their folder"}.</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b-[3px] border-line bg-cream-2 px-3 py-1 text-[12px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {agent.mode === "sandbox" ? `A shell in ${agent.name}'s sandbox, beside the agent` : `Your shell in ${agent.name}'s folder`}
        </span>
        <button
          className="btn px-2 text-[12px] text-ink"
          onClick={() => {
            officeActions.closeShell(agent.id);
            setN((x) => x + 1);
          }}
        >
          New shell
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView agentId={`shell:${agent.id}`} />
      </div>
    </div>
  );
}

/** Requests this agent's sandbox blocked (sbx's approval queue), even ones the agent never asked about. */
function BlockedRequests({ agent }: { agent: AgentConfig }) {
  const approvals = useOffice((s) => s.snap?.sbx.agents[agent.id]?.approvals) ?? [];
  const [open, setOpen] = useState(false);
  // Buttons stay disabled from a click until HQ sends the updated list.
  const [busy, setBusy] = useState(false);
  const listKey = approvals.map((a) => a.id).join(",");
  useEffect(() => setBusy(false), [listKey]);
  if (!approvals.length) return null;
  const act = (id: string, decision: "allow" | "dismiss") => {
    setBusy(true);
    officeActions.answerApproval(agent.id, id, decision);
    window.setTimeout(() => setBusy(false), 15_000); // in case nothing changes (e.g. sbx refused)
  };
  const shown = open ? approvals : approvals.slice(0, 3);
  return (
    <div className="border-b-[3px] border-line bg-warn px-3 py-1.5 text-[13px]">
      <div className="flex items-center gap-2">
        <b className="flex-1">
          Blocked by the sandbox · {approvals.length}
        </b>
        <button
          className="text-[12px] underline disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            const hosts = [...new Set(approvals.map((a) => a.title ?? a.host))];
            const list = hosts.slice(0, 15).join("\n") + (hosts.length > 15 ? `\n…and ${hosts.length - 15} more` : "");
            if (window.confirm(`Allow all ${hosts.length} for ${agent.name}'s sandbox?\n\n${list}\n\nOnly allow sites you trust. You can remove them later in Settings → Sandbox.`)) act("all", "allow");
          }}
        >
          Allow all
        </button>
        <button className="text-[12px] underline disabled:opacity-50" disabled={busy} onClick={() => act("all", "dismiss")}>
          Dismiss all
        </button>
      </div>
      <ul className="mt-1">
        {shown.map((a) => (
          <li key={a.id} className="flex items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate font-term text-[16px]" title={`${a.title ?? a.host} — ${a.detail}`}>
              {a.title ?? a.host}
            </span>
            <button className="btn px-1.5 text-[11px]" disabled={busy} onClick={() => act(a.id, "allow")}>
              Allow
            </button>
            <button className="btn px-1.5 text-[11px]" disabled={busy} onClick={() => act(a.id, "dismiss")}>
              Dismiss
            </button>
          </li>
        ))}
      </ul>
      {approvals.length > 3 && (
        <button className="text-[12px] underline" onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show all ${approvals.length}`}
        </button>
      )}
    </div>
  );
}

/** The agent asked (request_access) to reach a domain its sandbox blocks. */
function AccessCard({ request, agent }: { request: AccessRequest; agent: AgentConfig }) {
  return (
    <div className="border-b-[3px] border-line bg-danger px-3 py-2">
      <div className="text-[14px] text-[#ff7a9c]">
        <b>{agent.name}</b> wants to reach <b className="font-term text-[17px]">{request.domain}</b>
      </div>
      <div className="mb-2 text-[13px] text-muted">“{request.reason}”</div>
      <div className="flex flex-wrap gap-2">
        <button className="btn px-2 text-[13px]" onClick={() => officeActions.resolveAccess(request.id, "agent")}>
          Allow for {agent.name}
        </button>
        <button className="btn px-2 text-[13px]" onClick={() => officeActions.resolveAccess(request.id, "everyone")}>
          Allow for everyone
        </button>
        <button className="btn px-2 text-[13px]" onClick={() => officeActions.resolveAccess(request.id, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

const SESSION_COLOR = { running: "#00e436", starting: "#29adff", stopped: "#83769c", failed: "#ff004d", unknown: "#83769c" } as const;

/** Session state + Start/Stop + the agent's folder. */
function SessionBar({ agent, status }: { agent: AgentConfig; status: AgentStatus }) {
  const s = status.session;
  const live = useOffice((st) => st.live);
  return (
    <div className="flex items-center gap-2 border-b-[3px] border-line bg-cream px-3 py-1.5 text-[13px]">
      <span className={`chip chip-dot ${s.state === "starting" ? "blink" : ""}`} style={{ ["--c" as string]: SESSION_COLOR[s.state] }}>
        {s.state === "running" ? "Session running" : s.state === "starting" ? "Starting" : s.state === "failed" ? "Failed" : "Stopped"}
      </span>
      <span className="min-w-0 flex-1 truncate font-term text-[15px] text-muted" title={s.workspace ?? undefined}>
        {s.state === "starting" ? s.detail : (s.workspace ?? "")}
      </span>
      {s.workspace && live && (
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.openWorkspace(agent.id)} title="Open the agent's folder">
          Open folder
        </button>
      )}
      {s.state === "running" || s.state === "starting" ? (
        <button className="btn px-2 text-[12px]" disabled={s.state === "starting"} onClick={() => officeActions.stopAgent(agent.id)}>
          Stop
        </button>
      ) : agent.crew?.session ? null : (
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.startAgent(agent.id)}>
          Start
        </button>
      )}
    </div>
  );
}

function NotRunning({ agent, status }: { agent: AgentConfig; status: AgentStatus }) {
  const s = status.session;
  const setup = useOffice((st) => st.snap?.setup);
  const blocked = agent.mode === "sandbox" ? !setup?.sandboxReady : !setup?.localReady;
  return (
    <div className="grid h-full place-items-center bg-navy-2 p-6 text-center text-[#dfe6ff]">
      <div className="max-w-[380px]">
        {agent.crew?.session ? (
          <>
            <p className="mb-2 font-term text-[22px]">{s.state === "unknown" ? `This ${agent.crew.session} session's liveness is unknown` : `This ${agent.crew.session} session has finished`}</p>
            {s.detail && <p className="mb-3 font-term text-[16px] text-[#9aa6d1]">{s.detail}</p>}
            <p className="text-[13px] text-[#9aa6d1]">
              {s.state === "unknown" ? "Its transcript identifies the worker, but no new activity or completion has been observed. It is not counted as a running worker." : `Pathfinder decides the next session for ${agent.crew.ticket ?? "this ticket"}; Tin & Thyme does not restart workers.`}
            </p>
          </>
        ) : s.state === "starting" ? (
          <p className="blink font-term text-[22px]">{s.detail ?? "Starting…"}</p>
        ) : (
          <>
            <p className="mb-2 font-term text-[22px]">{s.state === "failed" ? `${agent.name} could not start` : `${agent.name} isn't running`}</p>
            {s.detail && <pre className="mb-3 whitespace-pre-wrap border-2 border-red px-2 py-1 text-left font-term text-[16px] text-[#ffd0dc]">{s.detail}</pre>}
            <p className="mb-4 text-[13px] text-[#9aa6d1]">
              {agent.mode === "sandbox"
                ? `Start runs ${CLI_LABEL[agent.cli]} in a Docker Sandbox on this agent's own copy of the repo.`
                : `Start runs ${CLI_LABEL[agent.cli]} locally in this agent's own copy of the repo, with permission prompts on.`}
            </p>
            {agent.cli === "codex" && (
              <p className="mb-4 text-[12px] text-[#ffc14d]">
                First start only: Codex asks you to trust this folder and HQ's hooks. Choose <b>Yes</b>, then <b>Trust all and continue</b>, in the terminal.
              </p>
            )}
            <p className="hidden">
            </p>
            <div className="flex justify-center gap-2">
              <button className="btn text-ink" onClick={() => officeActions.startAgent(agent.id)}>
                Start {agent.name}
              </button>
              {blocked && (
                <button className="btn text-ink" onClick={() => ui.openSetup()}>
                  Setup checklist
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TaskTab({ snap, agent, taskId }: { snap: OfficeSnapshot; agent: AgentConfig; taskId: string | null }) {
  const task = taskId ? snap.tasks.find((t) => t.id === taskId) : null;
  const pr = task?.prNumber ? snap.pullRequests.find((p) => p.number === task.prNumber) : null;
  const active = snap.boards.filter((b) => b.status === "active");
  const free = snap.tasks.filter((t) => t.status === "todo" && active.some((b) => b.id === t.boardId));
  const [pick, setPick] = useState("");

  if (agent.isLead) {
    return (
      <div className="scroll-thin h-full overflow-y-auto p-4">
        <SectionTitle>Planning</SectionTitle>
        <p className="mb-3 text-[15px]">The lead plans and assigns work through the HQ Team MCP. It writes no app code.</p>
        {active.map((b) => {
          const tasks = snap.tasks.filter((t) => t.boardId === b.id);
          const count = (s: string) => tasks.filter((t) => t.status === s).length;
          return (
            <button key={b.id} className="panel mb-2 block w-full px-3 py-2 text-left" onClick={() => ui.openBoards(b.id)}>
              <b>{b.title}</b>
              <div className="font-term text-[17px] text-muted">
                {count("todo")} to do · {count("in-progress")} in progress · {count("in-review")} in review · {count("reviewed")} reviewed · {count("done")} done
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <SectionTitle>Current task</SectionTitle>
      {task ? (
        <div className="panel mb-4 px-3 py-2">
          <div className="font-term text-[18px] text-muted">{task.id} · {snap.boards.find((b) => b.id === task.boardId)?.title}</div>
          <b className="text-[17px]">{task.title}</b>
          <div className="mt-1 text-[14px]">Status: {task.status}{task.note ? ` — ${task.note}` : ""}</div>
          {task.description && <p className="mt-1 whitespace-pre-wrap text-[14px]">{task.description}</p>}
          {!!task.files?.length && (
            <div className="mt-1 text-[13px]">
              Files: {task.files.map((f) => <code key={f} className="mr-1 bg-cream-2 px-1 font-term text-[15px]">{f}</code>)}
            </div>
          )}
          {task.doneWhen && <div className="mt-1 text-[13px]"><b>Done when:</b> {task.doneWhen}</div>}
          {task.needs.length > 0 && (
            <div className="text-[14px]">
              Needs: {task.needs.map((n) => `${n} (${snap.tasks.find((t) => t.id === n)?.status ?? "?"})`).join(", ")}
            </div>
          )}
          {pr && (
            <div className="mt-2 flex items-center gap-2 text-[14px]">
              <button className="font-semibold underline" onClick={() => ui.openPrs()}>
                PR #{pr.number}
              </button>
              <ReviewChip review={pr.review} merged={pr.merged} />
              {pr.openComments > 0 && <span>{pr.openComments} comments</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 text-[15px] text-muted">No task right now.</p>
      )}
      <SectionTitle>Assign a task</SectionTitle>
      <div className="flex gap-2">
        <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Task to assign">
          <option value="">Pick a to-do task…</option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} {t.title}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!pick} onClick={() => (officeActions.assignTask(pick, agent.id), setPick(""))}>
          Assign
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">If {agent.name} is free, the lead tells them to start right away.</p>
    </div>
  );
}

function SandboxTab({ snap, agent }: { snap: OfficeSnapshot; agent: AgentConfig }) {
  const env = snap.environments.find((e) => e.agentId === agent.id);
  const now = useNow(5000);
  const sb = agent.sandbox;
  const actual = snap.agents.find((a) => a.agentId === agent.id)?.session.sandbox;
  const row = (k: string, v: ReactNode) => (
    <div className="grid grid-cols-[140px_1fr] gap-2 border-t border-dashed border-cream-3 py-1.5 text-[14px] first:border-t-0">
      <span className="text-muted">{k}</span>
      <span className="min-w-0 break-words">{v}</span>
    </div>
  );
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <SectionTitle>Sandbox</SectionTitle>
      <div className="panel mb-4 px-3 py-1">
        {row("Mode", agent.mode === "sandbox" ? "Docker Sandbox (microVM), full access inside the VM" : "Local worktree, permission prompts on")}
        {row(
          "Resources",
          <>
            {sb.resources.cpus || sb.resources.memoryGb ? `${sb.resources.cpus ?? "all"} CPUs · ${sb.resources.memoryGb ?? "default"} GB` : "sbx default"}
            {actual && <span className="text-muted"> (now {actual.cpus} CPUs · {actual.memoryGb} GB)</span>}
          </>,
        )}
        {row("Network", `base: ${snap.sbx.basePolicy}`)}
        {row("Allowed", sb.allow.length ? sb.allow.join(", ") : "—")}
        {row("Blocked", sb.deny.length ? sb.deny.join(", ") : "—")}
        {row(
          "MCP servers",
          agent.mode !== "sandbox" ? (
            <span className="text-muted">Sandbox mode only</span>
          ) : (agent.mcp ?? []).length ? (
            (agent.mcp ?? []).map((n) => (
              <span key={n} className="chip mb-1 mr-1 font-term text-[14px]" title={(snap.mcp?.attached[agent.id] ?? []).includes(n) ? "Attached" : "Attaches on next start"}>
                {n}
                {(snap.mcp?.attached[agent.id] ?? []).includes(n) ? "" : " · next start"}
              </span>
            ))
          ) : (
            <button className="text-[13px] underline" onClick={() => ui.openSettings("mcp")}>
              None — add in Settings → MCP
            </button>
          ),
        )}
        {row("Ports", <PortsRow agent={agent} running={snap.agents.find((a) => a.agentId === agent.id)?.session.state === "running"} />)}
        {row("HQ access", <span className="font-term text-[17px]">localhost / host.docker.internal :{snap.config.project.hqPort} (added by HQ)</span>)}
        {row(
          "Service keys",
          [...snap.sbx.globalKeys.map((k) => `${k} (all)`), ...(snap.sbx.agents[agent.id]?.keys ?? [])].map((k) => (
            <span key={k} className="chip mb-1 mr-1 font-term text-[14px]">
              {k}
            </span>
          )),
        )}
        {row("App variables", snap.sbx.agents[agent.id]?.envFile.exists ? "env file set" : "—")}
        {row("Skills", agent.skills.join(", ") || "—")}
      </div>
      {env && (
        <>
          <SectionTitle>Environment</SectionTitle>
          <button className="panel mb-4 block w-full px-3 py-2 text-left" onClick={() => ui.openEnv(env.name)}>
            <div className="font-term text-[17px]">{env.url}</div>
            <div className="text-[14px] text-muted">
              {env.status} · deployed {ago(env.lastDeployAt, now)} ago
            </div>
          </button>
        </>
      )}
      <button className="btn" onClick={() => ui.openSettings("sandbox", agent.id)}>
        Edit sandbox settings
      </button>
    </div>
  );
}

function MessagesTab({ snap, agent }: { snap: OfficeSnapshot; agent: AgentConfig }) {
  const now = useNow(1000);
  const [draft, setDraft] = useState("");
  const list = snap.messages.filter((m) => m.fromId === agent.id || m.toId === agent.id);
  const who = (id: string) =>
    id === HUMAN_ID ? { name: "You", color: "#ffec27" } : id === "hq" ? { name: "HQ", color: "#3ee0d0" } : snap.config.team.find((a) => a.id === id);
  const running = snap.agents.find((a) => a.agentId === agent.id)?.session.state === "running";
  const send = () => {
    if (!draft.trim()) return;
    officeActions.sendMessage(agent.id, draft.trim());
    setDraft("");
  };
  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>Team MCP messages</SectionTitle>
        <p className="mb-3 text-[13px] text-muted">Agents can't reach each other's sandboxes. Every message goes through HQ.</p>
        {list.length === 0 && <p className="text-[15px] text-muted">No messages yet.</p>}
        <ul className="flex flex-col gap-2">
          {list.map((m) => {
            const out = m.fromId === agent.id;
            const other = who(out ? m.toId : m.fromId);
            return (
              <li key={m.id} className={`border-2 border-line px-2.5 py-1.5 ${out ? "ml-8 bg-card" : "mr-8 bg-cream-2"}`}>
                <div className="flex items-center gap-1.5 text-[13px] text-muted">
                  {other && <Dot color={other.color} size={8} />}
                  {out ? `To ${other?.name ?? "?"}` : `From ${other?.name ?? "?"}`}
                  <span className="ml-auto font-term text-[15px]">{ago(m.at, now)}</span>
                </div>
                <div className="text-[15px]">{m.text}</div>
              </li>
            );
          })}
        </ul>
      </div>
      <form
        className="flex gap-2 border-t-[3px] border-line bg-cream p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input className="field" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${agent.name}…`} aria-label={`Message ${agent.name}`} />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
      <p className="bg-cream px-2 pb-1.5 text-[11px] text-muted">
        {running ? "Delivered now if idle, otherwise when the current turn ends." : `${agent.name} isn't running; it's delivered after Start.`}
      </p>
    </div>
  );
}
