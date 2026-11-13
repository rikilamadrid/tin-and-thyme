// Pathfinder workflow adapter (Tin & Thyme).
//
// When HQ opens a repository that carries Pathfinder's execution-mode marker,
// the roster and the board come from Pathfinder, never from .jsmhq/:
//
//   - the board is the project's OWN engine: `orchestrate.mjs status --json`
//     (run from the project, so its kit version decides the vocabulary);
//   - the coordinator is one Claude Code session Tin & Thyme launches in tmux,
//     running Pathfinder's `/orchestrate start`;
//   - worker sessions are that coordinator's background subagents. They are
//     seen through Claude Code hook events on the coordinator's session tree:
//     PreToolUse(Agent) carries the Pathfinder brief (ticket, session, role,
//     worktree), SubagentStart/SubagentStop carry agent_id, and every worker
//     tool call carries its agent_id. A claim or worktree alone is never
//     treated as a running agent: liveness needs its own hook or observed
//     transcript activity, and ends at a stop, explicit transcript ending or
//     coordinator process exit. Unfinished files alone leave liveness unknown.
//     Only observed live keys are passed to `status --live`.
//
// Pathfinder owns every state change. This module reads the engine and the
// worker state files and writes nothing into the project.

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ACTIVE_POLICY_FILE, BLOCKED_COMMANDS, describePolicy, LOCAL_ONLY, originRepo, POLICY_LIMITS, policyArgs, PROTECTED_FILES, readPolicy, writePolicy } from "./runPolicy";
import type { ActionItem, AgentConfig, AgentStatus, Board, PlanSeen, SessionEnd, Task, TaskStatus, WorkflowHelper } from "../src/data/types";
import { assignCharacter, type CharacterId } from "../src/data/crew";
import { awaitingHuman, findSession, sessionUse, subagentPickedModel, subagents } from "./transcripts";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import { Handoffs, type HandoffWorker } from "./handoff";
import { handleHook } from "./hooks";
import type { Sessions } from "./sessions";
import { newAgent } from "./store";
import { log } from "./lib/log";
import { Attribution, readReport, type Evidence, type Identity } from "./attribution";
import { coordinatorAttention, gateOwner, sameQuestion, sessionEnding, ticketView, type GateCandidate } from "./workflowState";
import { gateRevision, isGateOccurrence, readGateHistory, type GateHistory } from "./gateRecord";
import { subagentMeta, subagentPrompt, subagentReport, transcriptRevision } from "./transcripts";
import type { ActionAnswer, ActionRequest, DeliveryStage } from "../src/data/types";
import { requestShelf } from "../src/data/requests";

export const COORDINATOR_ID = "coordinator";
const ENGINE = join("skills", "orchestrate", "engine", "bin", "orchestrate.mjs");

export interface PathfinderInfo {
  mode: string;
  engine: string;
}

export function detectPathfinder(root: string): PathfinderInfo | null {
  const modeFile = join(root, "context", "execution-mode.md");
  const engine = join(root, ENGINE);
  if (!existsSync(modeFile) || !existsSync(engine)) return null;
  const m = /<!--\s*pathfinder:execution-mode\s+([a-z-]+)\s*-->/.exec(readFileSync(modeFile, "utf8"));
  return m ? { mode: m[1], engine } : null;
}

interface StatusRow {
  worker: string;
  key: string;
  lifecycle: string;
  state: string;
  where: string;
  gate: string;
  last: string;
  title: string;
  /** The claim's checkpointed state (newer kits; a pending stage shows as `stale` in `state`). */
  recordedState?: string | null;
}

interface Worker {
  agentId: string; // Claude Code subagent id
  hqId: string; // id in HQ's team
  key: string;
  session: string; // implementation | adversary | review | repair | …
  role: string;
  worktree: string | null;
  live: boolean;
  /** Identity is known, but neither activity nor an ending has been observed in this kitchen. */
  livenessUnknown?: boolean;
  transcriptRevision?: string;
  resumeRevision?: string;
  tools: number;
  character: CharacterId;
  transcript: string | null;
  /** How the session ended (its own report, else Pathfinder's checkpoint at that moment); null while live. */
  ended: SessionEnd | null;
  /** When a finished session was resumed under the same subagent id (its earlier `finished` predates this). */
  resumedAt?: number;
  /**
   * The gate occurrence open on its ticket at its latest hook event (so while it was running); null when there was
   * none, or the gate had no occurrence. In memory only: a restart forgets it, and then nothing is credited.
   */
  gateSeen: string | null;
}

/**
 * A saved session outcome, with the ticket and stage it belongs to (absent in files from before they were kept).
 * `occurrence`: the gate occurrence its GATE report was made in (see `reportedIn`). The report credits that
 * occurrence only, across restarts; an entry without one (any saved before occurrences) credits no gate.
 * `consumed` is what earlier versions kept instead; it is read past and never written.
 */
type BookEntry = SessionEnd & { key?: string; session?: string; occurrence?: string; consumed?: string };
const stripBook = ({ key: _key, session: _session, occurrence: _occurrence, consumed: _consumed, ...ended }: BookEntry): SessionEnd => ended;

/** The gate open on a ticket right now, as Pathfinder's durable record states it. */
interface GateNow {
  text: string;
  stage: string | null;
  /** The open gate's occurrence, from the state file's `Gate-Id`; null when it has none. */
  occurrence: string | null;
  /** The ticket's gate history (resolved occurrences), from the notes the engine wrote. */
  history: GateHistory;
  /** That history records this very occurrence resolved (a resolve that hasn't reached the state file yet). */
  resolved: boolean;
}

/** How a stopped session ended from its ticket's recorded state alone (see workflowState.ts). */
export { sessionOutcome } from "./workflowState";

/** The ticket keys a `plan` run lists as eligible, from its --json output or its printed text. */
export function parsePlanOutput(out: string): Omit<PlanSeen, "at"> | null {
  try {
    const j = JSON.parse(out);
    const plan = j.plan ?? j;
    if (plan && typeof plan.outcome === "string" && Array.isArray(plan.dispatch)) {
      return {
        outcome: plan.outcome,
        dispatch: plan.dispatch.map((e: { key: string }) => e.key).filter(Boolean),
        deferred: (plan.deferred ?? []).map((e: { key: string; reason?: string }) => ({ key: e.key, reason: e.reason ?? "" })).filter((e: { key: string }) => e.key),
      };
    }
  } catch {
    /* text form */
  }
  if (!/^Dispatch plan/m.test(out)) return null;
  const section = (title: string) => {
    const m = new RegExp(`^${title}\\n((?:  .*\\n?)*)`, "m").exec(out);
    return m ? [...m[1].matchAll(/^ {2}(\d+\.\d+)\s+(.*)$/gm)].map((x) => ({ key: x[1], reason: x[2].trim() })) : [];
  };
  const dispatch = section("Claim now:").map((e) => e.key);
  return { outcome: dispatch.length ? "dispatch" : "nothing-eligible", dispatch, deferred: section("Eligible, but waits this round:") };
}

/** The brief header the engine writes (skills/orchestrate/engine/brief.mjs formatBrief). */
export function parseBrief(prompt: string): { key: string; title: string; session: string; role: string; worktree: string | null } | null {
  const head = /Pathfinder worker brief\s+—\s+(\d+\.\d+)\s+(.*?)\s+\(([^)]*)\)\s*$/m.exec(prompt);
  if (!head) return null;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(prompt)?.[1].trim() ?? null;
  return { key: head[1], title: head[2], session: field("Session") ?? "implementation", role: field("Role") ?? "developer", worktree: field("Worktree") };
}

const ROLE_COLOR: Record<string, string> = { developer: "#29adff", tester: "#00e436", adversary: "#ffa300", orchestrator: "#ff77a8", integrator: "#ffec27", planner: "#83769c" };
const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Bash commands a local-only run refuses for the coordinator and every worker (see runPolicy.ts). */
export { BLOCKED_COMMANDS };

// ---------------------------------------------------------------- the coordinator's hooks and run-policy guard

/** The policy guard this server ships, next to this module in dist-server/ (absent on a tsx `--dev` server). */
const BUNDLED_GUARD = join(dirname(fileURLToPath(import.meta.url)), "run-policy-guard.mjs");
const GATE = "Treat this step as a human decision: record it as a human gate (State: human-gate, Gate: <what you need>) and stop.";
/**
 * The non-Bash tools whose writes the guard checks (they must not change the policy or guard files).
 * Whether Claude Code anchors this matcher is not verified here. Either reading is safe: unanchored,
 * it only sends more tools to the guard, which blocks any tool it doesn't know.
 */
export const FILE_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

/**
 * The hook command. It reads the guard file once, checks its SHA-256 against `sha256` (fixed at
 * coordinator start), and runs exactly those bytes from memory, so a kitchen copy that Bash rewrote,
 * emptied or swapped mid-run blocks instead of deciding. The hash only pins what was there at start:
 * installRunPolicyGuard trusts whatever dist-server holds when the coordinator starts. It fails closed: Claude Code blocks a tool call only
 * on exit 2 and treats any other failure as a non-blocking error, so anything but exit 0 becomes exit 2.
 */
export function guardHookCommand(guard: string, sha256: string, args: string[]): string {
  const say = (what: string) => `process.stderr.write("Tin & Thyme run policy: " + ${what} + " ${GATE}"); process.exit(2)`;
  // Shell single quotes around JS: the loader has no single quotes, and GATE none either.
  const loader = [
    `const fs = require("fs"), crypto = require("crypto"), [f, h, ...a] = process.argv.slice(1); let b;`,
    `try { b = fs.readFileSync(f) } catch (e) { ${say(`"the guard " + f + " can not be read, so this is blocked."`)} }`,
    `if (crypto.createHash("sha256").update(b).digest("hex") !== h) { ${say(`"the guard " + f + " changed after the coordinator started, so every guarded tool call is blocked until you restart the coordinator."`)} }`,
    `process.argv = [process.argv[0], f, ...a];`,
    `import("data:text/javascript;base64," + b.toString("base64")).catch((e) => { ${say(`"the guard could not run (" + e.message + "), so this is blocked."`)} });`,
  ].join(" ");
  if (loader.includes("'")) throw new Error("the guard loader may not contain a single quote");
  const run = ["node", "-e", `'${loader}'`, ...[guard, sha256, ...args].map((a) => JSON.stringify(a))].join(" ");
  return `${run}; s=$?; [ "$s" -eq 0 ] && exit 0; [ "$s" -eq 2 ] || echo "Tin & Thyme run policy: the guard did not run (exit $s), so this is blocked. ${GATE}" >&2; exit 2`;
}

/**
 * The legacy local-only guard, for a server with no bundled guard. Its Bash rule is 7b3eda3's, byte
 * for byte; it also refuses Write/Edit of the policy and guard files in its own folder.
 */
function legacyGuardScript(): string {
  return `#!/usr/bin/env node
// Tin & Thyme run policy for this orchestration: commit locally only.
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
const FILE_TOOLS = ${JSON.stringify(FILE_TOOL_MATCHER.split("|"))};
const PROTECTED = ${JSON.stringify(PROTECTED_FILES.map((f) => f.toLowerCase()))};
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j = {}; try { j = JSON.parse(s); } catch {}
  if (FILE_TOOLS.includes(j.tool_name)) {
    const p = real(resolve(j.cwd || process.cwd(), String(j.tool_input?.file_path ?? j.tool_input?.notebook_path ?? "")));
    if (real(dirname(p)).toLowerCase() === real(dirname(resolve(process.argv[1]))).toLowerCase() && PROTECTED.includes(basename(p).toLowerCase())) {
      process.stderr.write("Tin & Thyme run policy: " + basename(p) + " defines this run's guard; only you can change it. ${GATE}");
      process.exit(2);
    }
    process.exit(0);
  }
  let cmd = ""; try { cmd = JSON.parse(s).tool_input?.command ?? ""; } catch {}
  if (new RegExp(${JSON.stringify(BLOCKED_COMMANDS)}).test(cmd)) {
    process.stderr.write("Tin & Thyme run policy: this run is local only. Do not push, open or edit pull requests or GitHub issues, call the GitHub API, or deploy. ${GATE}");
    process.exit(2);
  }
  process.exit(0);
});
`;
}

/**
 * Writes the guard for this run into `dir` (the kitchen state folder) and returns the hook command
 * that runs it. The policy comes from `dir`/run-policy.json (`tin-and-thyme policy`) and is fixed
 * into the command, so a change applies only when the coordinator next starts; active-policy.json
 * records it. run-policy.json is an ordinary file Bash can rewrite, so github-dev is honoured only
 * when its repo is the project's origin. Without the bundled guard only local-only can be enforced.
 * The bundled guard is trusted as found: a dist-server guard that Bash rewrote is hashed and used
 * from this start on. The Tin & Thyme install is a trusted component, not something this checks.
 */
export function installRunPolicyGuard(dir: string, bundledGuard: string, log: (text: string) => void, root: string): string {
  const { policy: wanted, problem } = readPolicy(dir);
  if (problem) log(`Run policy: ${problem}`);
  const bundled = existsSync(bundledGuard);
  let policy = wanted;
  if (wanted.mode === "github-dev") {
    const origin = originRepo(root);
    if (!bundled) {
      policy = LOCAL_ONLY;
      log("Run policy: this server has no bundled policy guard (dev build), so the run stays local only. Build with `pnpm build`.");
    } else if (!origin || origin.toLowerCase() !== wanted.repo.toLowerCase()) {
      policy = LOCAL_ONLY;
      log(`Run policy: run-policy.json names ${wanted.repo}, but this project's origin is ${origin ?? "not a GitHub repository"}, so the run stays local only. Set it again with tin-and-thyme policy --set=github-dev.`);
    }
  }
  writePolicy(dir, policy, ACTIVE_POLICY_FILE);
  log(`Run policy: ${describePolicy(policy)}. Limits: ${POLICY_LIMITS.join(" ")}`);
  const guard = join(dir, bundled ? "run-policy-guard.mjs" : "no-push-guard.mjs");
  const bytes = bundled ? readFileSync(bundledGuard) : Buffer.from(legacyGuardScript());
  writeFileSync(guard, bytes);
  chmodSync(guard, 0o755);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return guardHookCommand(guard, sha256, bundled ? policyArgs(policy) : []);
}

export interface CoordinatorSettingsOptions {
  /** The kitchen state folder, ~/.controlroom/<key>. */
  dir: string;
  /** The kitchen's hook endpoint for the coordinator, without the event. */
  hookUrl: string;
  agentToken: string;
  bundledGuard: string;
  /** The project root: github-dev must name its origin. */
  root: string;
  log(text: string): void;
}

/** The coordinator's `--settings` file: the run-policy guard first on Bash and the file tools, then the kitchen's observers. */
export function writeCoordinatorSettings(o: CoordinatorSettingsOptions): string {
  mkdirSync(o.dir, { recursive: true });
  const guard = installRunPolicyGuard(o.dir, o.bundledGuard, o.log, o.root);
  const post = (event: string) => ({
    type: "command",
    command: `curl -s -m 3 -X POST -H 'Authorization: Bearer ${o.agentToken}' -H 'Content-Type: application/json' --data-binary @- ${o.hookUrl}/${event} 2>/dev/null; exit 0`,
  });
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Notification", "Stop", "SessionEnd"];
  const hooks: Record<string, unknown[]> = {};
  for (const e of events) hooks[e] = [{ ...(e.endsWith("ToolUse") ? { matcher: "*" } : {}), hooks: [post(e)] }];
  hooks.PreToolUse.unshift(
    { matcher: "Bash", hooks: [{ type: "command", command: guard, timeout: 60 }] },
    { matcher: FILE_TOOL_MATCHER, hooks: [{ type: "command", command: guard, timeout: 60 }] },
  );
  const file = join(o.dir, "coordinator-settings.json");
  writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return file;
}

export class PathfinderRun {
  private workers = new Map<string, Worker>();
  /** Helper subagent id → who launched it (seen through hooks). */
  private helperInfo = new Map<string, { parent: string; label: string; type: string; finished: boolean }>();
  private rows: StatusRow[] = [];
  private polling: NodeJS.Timeout | null = null;
  private refreshQueued = false;
  private engineError: string | null = null;
  private seq = 0;
  /** The coordinator's Claude Code transcript (from its hooks, or found once at start-up). */
  private transcript: string | null = null;
  /** The coordinator's turn ended (its Stop hook, or its transcript's last word); a new prompt reopens it. */
  private turnEnded = false;
  /** The note of the attention state this run last set on the coordinator (so a real ask set elsewhere is kept). */
  private attentionNote: string | null = null;
  /** Ticket keys already integrated when this run was first read: only later ones are deliveries. */
  private integratedAtStart: Set<string> | null = null;
  private startedAt = Date.now();
  private coordinatorObservedRunning = false;

  constructor(
    private hub: Hub,
    private inbox: Inbox,
    private sessions: Sessions,
    private info: PathfinderInfo,
    private port: number,
    private agentToken: string,
    private prompt: string,
  ) {
    this.handoffs = new Handoffs({
      root: this.hub.repo.root,
      engine: this.info.engine,
      stateDir: this.stateDir,
      workers: () => [...this.workers.values()].map((w) => this.handoffWorker(w)),
      row: (key) => this.rows.find((r) => r.key === key),
      coordinator: () => {
        const st = this.hub.status(COORDINATOR_ID);
        return { running: st?.session.state === "running", state: st?.state ?? "idle", transcript: this.transcript };
      },
      typeToCoordinator: (text) => this.sessions.typeInto(COORDINATOR_ID, text),
      openDecisions: (key) => (this.hub.snap.actionItems ?? []).filter((i) => i.status === "open" && i.taskId === key && !i.id.startsWith("gate-")).map((i) => i.title),
      publish: (handoffs) => {
        if (!this.hub.snap.workflow) return;
        this.hub.snap.workflow = { ...this.hub.snap.workflow, handoffs };
        this.emitWorkflow();
        this.queueRefresh(300);
      },
      activity: (text, agentId) => this.hub.activity("session", agentId, text),
    });
  }

  readonly handoffs: Handoffs;
  /** Context alerts: per worker, whether a crossing may alert (armed), and whether one is showing. */
  private ctxAlert = new Map<string, { armed: boolean; showing: boolean; pct: number }>();

  private handoffWorker(w: Worker): HandoffWorker {
    return { hqId: w.hqId, name: this.hub.name(w.hqId), key: w.key, role: w.role, session: w.session, worktree: w.worktree, live: w.live, transcript: w.transcript, agentId: w.agentId };
  }

  private emitWorkflow() {
    if (this.hub.snap.workflow) this.hub.emit({ type: "workflow.updated", workflow: structuredClone(this.hub.snap.workflow) });
  }

  // ---------------------------------------------------------------- context alerts

  /** The project's context alert threshold (percent), kept in ~/.controlroom/<slug>/settings.json. */
  private loadSettings(): { contextAlertPct: number } {
    try {
      const v = JSON.parse(readFileSync(join(this.stateDir, "settings.json"), "utf8")).contextAlertPct;
      if (typeof v === "number" && v >= 5 && v <= 95) return { contextAlertPct: v };
    } catch {
      /* default */
    }
    return { contextAlertPct: 35 };
  }

  setContextAlert(pct: number) {
    const v = Math.round(Math.min(95, Math.max(5, Number(pct) || 35)));
    writeFileSync(join(this.stateDir, "settings.json"), JSON.stringify({ ...this.loadSettings(), contextAlertPct: v }, null, 2));
    if (this.hub.snap.workflow) this.hub.snap.workflow = { ...this.hub.snap.workflow, contextAlertPct: v };
    this.emitWorkflow();
    this.hub.activity("config", null, `Context alert threshold set to ${v}% (advisory)`);
    this.queueRefresh(100);
  }

  ackContextAlert(hqId: string) {
    const a = this.ctxAlert.get(hqId);
    if (!a?.showing) return;
    a.showing = false;
    this.hub.setStatus(hqId, { contextAlert: null });
  }

  /** One worker's own observed context against the threshold: alert once per crossing; re-arm below it. */
  private checkContext(hqId: string, ctx: { used: number; limit: number } | null, live = true) {
    const thr = this.hub.snap.workflow?.contextAlertPct ?? 35;
    const a = this.ctxAlert.get(hqId) ?? { armed: true, showing: false, pct: 0 };
    this.ctxAlert.set(hqId, a);
    if (!live && a.showing) {
      a.showing = false;
      this.hub.setStatus(hqId, { contextAlert: null });
    }
    if (!ctx) return; // missing telemetry (or a stopped session): no alert, the meter shows —
    const pct = Math.round((ctx.used / ctx.limit) * 100);
    a.pct = pct;
    if (pct < thr) {
      a.armed = true;
      if (a.showing) {
        a.showing = false;
        this.hub.setStatus(hqId, { contextAlert: null });
      }
      return;
    }
    if (a.armed) {
      a.armed = false;
      a.showing = true;
      this.hub.setStatus(hqId, { contextAlert: { pct, threshold: thr } });
      this.hub.activity("agent.needs-input", hqId, `Context check: ${this.hub.name(hqId)} is at ${pct}% of its context (alert at ${thr}%). Advisory; nothing restarts on its own.`);
    } else if (a.showing) this.hub.setStatus(hqId, { contextAlert: { pct, threshold: thr } });
  }

  get root() {
    return this.hub.repo.root;
  }

  /** The configured roster: the coordinator. Workers join as their sessions start. */
  static coordinatorConfig(root: string): AgentConfig {
    const c = assignCharacter("orchestrator", []);
    const a = newAgent(COORDINATOR_ID, c.name, "orchestrator", ROLE_COLOR.orchestrator, true);
    a.mode = "local";
    a.workspacePath = root;
    a.roleMd = "Pathfinder orchestrator (roles/orchestrator.md in the project).";
    a.crew = { character: c.id, job: c.job, role: "orchestrator", session: null, ticket: null, worktree: null };
    return a;
  }

  /** Configured roles from roles/*.md frontmatter (name, description). */
  static readRoles(root: string): { name: string; description: string }[] {
    const dir = join(root, "roles");
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => {
          const text = readFileSync(join(dir, f), "utf8");
          const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
          const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1].trim() ?? "";
          return { name: field("name") || f.replace(/\.md$/, ""), description: field("description") };
        });
    } catch {
      return [];
    }
  }

  roles(): string[] {
    return PathfinderRun.readRoles(this.root).map((r) => r.name);
  }

  private get stateDir() {
    const dir = join(homedir(), ".controlroom", this.hub.slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Tin & Thyme's own note of which transcript is the coordinator's (in ~/.controlroom, never the project). */
  private rememberTranscript(file: string) {
    if (this.transcript === file) return;
    this.transcript = file;
    writeFileSync(join(this.stateDir, "coordinator.json"), JSON.stringify({ transcript: file, at: new Date().toISOString() }, null, 2));
  }

  private crewBook(next?: Record<string, { id: CharacterId; name: string; job: string }>) {
    const file = join(this.stateDir, "crew.json");
    if (next) {
      writeFileSync(file, JSON.stringify(next, null, 2));
      return next;
    }
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, { id: CharacterId; name: string; job: string }>;
    } catch {
      return {};
    }
  }

  private recallTranscript() {
    try {
      const f = JSON.parse(readFileSync(join(this.stateDir, "coordinator.json"), "utf8")).transcript;
      if (typeof f === "string" && existsSync(f)) return (this.transcript = f);
    } catch {
      /* first run */
    }
    // An orchestration started before Tin & Thyme kept this note: match its first prompt.
    const cmd = /^\/(\S+)\s*(.*)$/.exec(this.prompt.trim());
    if (!cmd) return null;
    const [, name, args] = cmd;
    const f = findSession(this.root, (p) => p.includes(`<command-name>/${name}</command-name>`) && p.includes(args.replace(/\s+/g, " ").slice(0, 80)));
    if (f) this.rememberTranscript(f);
    return f;
  }

  /** The coordinator ended its turn and nobody has answered yet: its ready prompt is not "idle". */
  isAsking(hqId: string) {
    return hqId === COORDINATOR_ID && this.turnEnded;
  }

  isExternal(hqId: string) {
    return hqId.startsWith("w-");
  }

  // ---------------------------------------------------------------- launch

  private hookSettingsFile(): string {
    return writeCoordinatorSettings({
      dir: join(homedir(), ".controlroom", this.hub.slug),
      hookUrl: `http://127.0.0.1:${this.port}/hook/${COORDINATOR_ID}`,
      agentToken: this.agentToken,
      bundledGuard: BUNDLED_GUARD,
      root: this.root,
      log: (text) => this.hub.activity("config", COORDINATOR_ID, text),
    });
  }

  async startCoordinator() {
    const settings = this.hookSettingsFile();
    this.hub.activity("session", COORDINATOR_ID, `Starting Pathfinder orchestration in ${this.root} (roles: ${this.roles().join(", ") || "none found"})`);
    await this.sessions.startExternal(COORDINATOR_ID, this.root, { file: "claude", args: ["--settings", settings, this.prompt], envFile: null });
  }

  // ---------------------------------------------------------------- hooks

  /** Every hook from the coordinator's session tree. */
  onHook(event: string, body: Record<string, unknown>) {
    const agentId = typeof body.agent_id === "string" ? body.agent_id : null;
    if (agentId) return this.workerHook(agentId, event, body);
    if (typeof body.transcript_path === "string" && body.transcript_path) this.rememberTranscript(body.transcript_path);
    if (event === "UserPromptSubmit") this.turnEnded = false;

    // The coordinator itself. An Agent call is remembered by its tool_use_id, never queued by position.
    if (event === "PreToolUse" && (body.tool_name === "Agent" || body.tool_name === "Task")) {
      this.attribution.launch(body.tool_use_id, (body.tool_input ?? {}) as Record<string, unknown>, COORDINATOR_ID);
    }
    if (event === "PostToolUse" && body.tool_name === "Bash") {
      const cmd = String((body.tool_input as Record<string, unknown>)?.command ?? "");
      if (/orchestrate\.mjs\s+plan\b/.test(cmd)) {
        const r = (body.tool_response ?? {}) as Record<string, unknown>;
        const seen = parsePlanOutput(String(r.stdout ?? r.output ?? ""));
        if (seen) this.notePlan({ ...seen, at: new Date().toISOString() });
      }
    }
    if (event === "PostToolUse" && (body.tool_name === "Agent" || body.tool_name === "Task")) this.agentLaunched(COORDINATOR_ID, body);
    if (event === "PreToolUse" && body.tool_name === "Bash") {
      const cmd = String((body.tool_input as Record<string, unknown>)?.command ?? "");
      if (/orchestrate\.mjs/.test(cmd)) {
        const m = /orchestrate\.mjs\s+(\S+)(?:\s+(\d+\.\d+))?/.exec(cmd);
        if (m) this.hub.activity("task.assigned", COORDINATOR_ID, `Coordinator ran engine \`${m[1]}${m[2] ? " " + m[2] : ""}\``);
        this.queueRefresh(1500);
      }
    }
    const r = handleHook(this.hub, this.inbox, COORDINATOR_ID, event, body as never);
    if (event === "Stop" && r.ok && !r.response) {
      // Its turn ended: asking the human (a gate, the approval, a question), or waiting on workers it dispatched.
      this.turnEnded = true;
      this.attentionNote = null;
      this.applyAttention();
    } else if (this.turnEnded && event === "Notification") {
      // Claude Code's idle reminder ("waiting for your input") would read as idle: the same rule decides.
      this.applyAttention();
    }
    this.queueRefresh(800);
    return r;
  }

  private subagentTranscript(agentId: string): string | null {
    return this.transcript ? join(this.transcript.replace(/\.jsonl$/, ""), "subagents", `agent-${agentId}.jsonl`) : null;
  }

  // ---------------------------------------------------------------- attribution

  /** Which subagent is which, from exact evidence only (attribution.ts). */
  private attribution = new Attribution((prompt) => parseBrief(prompt) !== null);
  /** Subagents seen through hooks whose identity can't be established yet: shown as unknown, never guessed. */
  private unknownAgents = new Map<string, { type: string; finished: boolean }>();

  /** What a subagent's own files say about it (null fields while they don't exist yet). */
  private evidence(agentId: string, file = this.subagentTranscript(agentId)): Evidence {
    const meta = file ? subagentMeta(file) : null;
    // Launched by a subagent: its parent is that worker when known; never assumed to be the coordinator.
    const parent = !meta ? null : meta.parentAgentId ? (this.workers.get(meta.parentAgentId)?.hqId ?? null) : COORDINATOR_ID;
    return { toolUseId: meta?.toolUseId ?? null, prompt: file ? subagentPrompt(file) : null, parent, description: meta?.description ?? "", agentType: meta?.agentType ?? "" };
  }

  /** An identified subagent joins: a worker gets its own ticket and stage, a helper only its launcher. */
  private adopt(agentId: string, identity: Identity | null, finished = false, unknown = false): Worker | null {
    if (!identity) return null;
    const pending = this.unknownAgents.get(agentId);
    this.unknownAgents.delete(agentId);
    if (identity.kind === "worker") return this.workers.get(agentId) ?? this.addWorker(agentId, identity.prompt, finished || !!pending?.finished, unknown && !pending);
    if (!this.helperInfo.has(agentId)) this.helperInfo.set(agentId, { parent: identity.parent ?? "unknown", label: identity.label, type: identity.type, finished: finished || !!pending?.finished });
    return null;
  }

  /** PostToolUse(Agent) from `parent`: the tool's result names the subagent it started, exactly. */
  private agentLaunched(parent: string, body: Record<string, unknown>) {
    const r = (body.tool_response ?? {}) as Record<string, unknown>;
    const id = typeof r.agentId === "string" ? r.agentId : null;
    if (!id) return;
    const prompt = String((body.tool_input as Record<string, unknown>)?.prompt ?? r.prompt ?? "");
    this.adopt(id, this.attribution.bind(body.tool_use_id, id, prompt, parent));
  }

  /** A worker session joins the room. `finished` restores one that already ended (from its transcript). */
  private addWorker(agentId: string, prompt: string, finished = false, unknown = false): Worker | null {
    const b = parseBrief(prompt);
    if (!b) return null;
    const role = b.session === "adversary" ? "adversary" : b.role;
    // One id per session, from its own subagent id: the same session keeps it across restarts and reconnects.
    const hqId = `w-${b.key.replace(".", "-")}-${b.session}-${agentId.replace(/[^a-z0-9]/gi, "").slice(0, 10) || ++this.seq}`;
    // The character is chosen once per session and kept in ~/.controlroom, so restarts give the same one.
    // Finished sessions have left the floor, so only live crew hold a character.
    const saved = this.crewBook()[agentId];
    const c = saved ?? assignCharacter(role, [...this.workers.values()].filter((x) => x.live).map((x) => x.character));
    if (!saved) this.crewBook({ ...this.crewBook(), [agentId]: c });
    const transcript = this.subagentTranscript(agentId);
    const ended = finished ? this.restoredEnding(agentId, b.key, b.session, transcript) : null;
    const w: Worker = { agentId, hqId, key: b.key, session: b.session, role, worktree: b.worktree, live: !finished && !unknown, livenessUnknown: unknown && !finished, tools: 0, character: c.id, transcript, ended, gateSeen: null };
    this.workers.set(agentId, w);
    const cfg = newAgent(hqId, c.name, role, ROLE_COLOR[role] ?? "#c2c3c7", false);
    cfg.mode = "local";
    cfg.workspacePath = b.worktree;
    cfg.roleMd = `Pathfinder ${b.session} session, role ${b.role}, for ${b.key} ${b.title}`;
    cfg.crew = { character: c.id, job: c.job, role, session: b.session, ticket: b.key, worktree: b.worktree };
    const hub = this.hub;
    hub.snap.config.team.push(cfg);
    const st: AgentStatus = {
      agentId: hqId, state: w.live ? "working" : "idle", currentTaskId: b.key, stateSince: new Date().toISOString(),
      note: w.livenessUnknown ? "Session liveness unknown — awaiting new activity or completion evidence" : finished ? "Session ended — restoring its outcome" : `Started ${b.session} session`,
      session: { state: w.livenessUnknown ? "unknown" : finished ? "stopped" : "running", detail: `Background subagent ${agentId} of the coordinator`, workspace: b.worktree, sandbox: null },
      ...this.usage(w.transcript, undefined, this.configuredFor(w)),
      ended,
    };
    hub.snap.agents.push(st);
    hub.configChanged();
    hub.emit({ type: "agent.updated", agent: structuredClone(st) });
    if (w.live) hub.activity("task.started", hqId, `${cfg.name} (${role}, ${b.session} ${b.key}) started in ${b.worktree ?? "its worktree"}`);
    if (w.live) this.handoffs.onWorkerStarted(b.key, hqId);
    hub.terminal(hqId, `\x1b[1mPathfinder ${b.session} session for ${b.key}\x1b[0m — ${b.title}\r\nsubagent ${agentId}\r\nworktree ${b.worktree}\r\n${finished ? "\r\n\x1b[1m■ session finished\x1b[0m (restored from its transcript)\r\n" : ""}\r\n`);
    this.applyAttention();
    this.queueRefresh(500);
    return w;
  }

  /**
   * A finished session restored after a restart: the outcome saved for this session and ticket, else its own
   * report. A saved outcome from before tickets were recorded with it is used only when there is no report.
   */
  private restoredEnding(agentId: string, key: string, session: string, transcript: string | null): SessionEnd | null {
    const saved = this.endBook()[agentId];
    if (saved?.key === key) return stripBook(saved);
    const report = transcript ? subagentReport(transcript) : null;
    if (readReport(report)) return this.settleAs(agentId, key, sessionEnding(session, report, this.recorded(key)));
    return saved && !saved.key ? stripBook(saved) : null;
  }

  /** A finished session is running again (resumed with the same subagent id): it keeps only its own identity. */
  private resumeWorker(w: Worker) {
    w.live = true;
    w.livenessUnknown = false;
    w.ended = null;
    w.gateSeen = null;
    w.resumedAt = Date.now();
    w.resumeRevision = w.transcript ? transcriptRevision(w.transcript) : "";
    this.hub.setSession(w.hqId, { state: "running", detail: `Background subagent ${w.agentId} of the coordinator (resumed)` });
    this.hub.setStatus(w.hqId, { state: "working", note: `Resumed ${w.session} session`, ended: null, currentTaskId: w.key });
    this.hub.activity("task.started", w.hqId, `${this.hub.name(w.hqId)} (${w.role}, ${w.session} ${w.key}) resumed`);
    this.applyAttention();
  }

  /** What was requested for this worker itself: the model Claude Code picked at launch. Effort isn't recorded until a call runs. */
  private configuredFor(w: Worker): { model: string | null; effort: string | null } {
    return { model: w.transcript ? subagentPickedModel(w.transcript) : null, effort: null };
  }

  /** Context and telemetry from one session's transcript; falls back to its own configured values. */
  private usage(file: string | null, sidechain: boolean | undefined, configured: { model: string | null; effort: string | null }) {
    const u = file ? sessionUse(file, sidechain) : { context: null, model: null, effort: null };
    const telemetry: AgentStatus["telemetry"] =
      u.model || u.effort
        ? { model: u.model, effort: u.effort, source: "observed" }
        : configured.model || configured.effort
          ? { model: configured.model, effort: configured.effort, source: "configured" }
          : null;
    return { context: u.context, telemetry };
  }

  /** Session outcomes, kept in ~/.controlroom by subagent id (with its ticket) so a restart reads the same history. */
  private endBook(next?: Record<string, BookEntry>) {
    const file = join(this.stateDir, "sessions.json");
    if (next) {
      writeFileSync(file, JSON.stringify(next, null, 2));
      return next;
    }
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, BookEntry>;
    } catch {
      return {};
    }
  }

  /** What Pathfinder recorded for this ticket right now: its checkpoint, else the engine's row. */
  private recorded(key: string): { state: string | null; last: string | null; gate: string | null } {
    const row = this.rows.find((r) => r.key === key);
    if (row?.state === "integrated") return { state: "integrated", last: row.last !== "—" ? row.last : null, gate: null };
    const sf = this.stateFile(key);
    return {
      state: sf.State?.split(/\s/)[0] ?? row?.recordedState ?? null,
      last: sf.Last ?? (row && row.last !== "—" ? row.last : null),
      gate: sf.Gate ?? (row && row.gate !== "—" ? row.gate : null),
    };
  }

  /**
   * Keep one session's outcome under its own subagent id, with its own ticket and stage. `occurrence` is the gate
   * occurrence its GATE report was made in, when the kitchen saw that (`reportedIn`). A report that states the same
   * GATE question as the entry already saved for this session is not taken as a new report: it may be the old one
   * read again (a repeated stop, or a resumed session whose transcript still ends with it), so it keeps what the
   * saved entry had, an occurrence or none, and is never moved to a later occurrence.
   */
  private settleAs(agentId: string, key: string, ended: SessionEnd, session?: string, occurrence: string | null = null): SessionEnd {
    const w = this.workers.get(agentId);
    if (w) w.ended = ended;
    const book = this.endBook();
    const was = book[agentId]?.key === key ? book[agentId] : undefined;
    const same = ended.verdict === "GATE" && was?.verdict === "GATE" && sameQuestion(ended.result ?? "", was.result ?? "");
    const made = same ? (isGateOccurrence(was?.occurrence) ? was.occurrence : null) : occurrence;
    this.endBook({ ...book, [agentId]: { ...ended, key, session: session ?? w?.session, ...(made ? { occurrence: made } : {}) } });
    return ended;
  }

  /**
   * The gate occurrence a stopping session's GATE report was made in, or null when that can't be shown. It can
   * when all of this holds: the kitchen saw the occurrence open on the ticket at a hook event from the session
   * itself (so while it ran), the same occurrence is still the open one now that it stopped, Pathfinder's history
   * doesn't record it resolved, and the report states its question. An occurrence is never reopened, so it was
   * open the whole time between, which includes the moment the session reported. No clock is read, and no gate
   * without an occurrence is ever used.
   */
  private reportedIn(w: Worker, ended: SessionEnd): string | null {
    if (ended.verdict !== "GATE" || !w.gateSeen) return null;
    const now = this.gateNow(w.key);
    return now && now.occurrence === w.gateSeen && !now.resolved && sameQuestion(ended.result ?? "", now.text) ? now.occurrence : null;
  }

  /** A session stopped: its own report decides how it ended, else its ticket's recorded state. */
  private endWorker(w: Worker, why: string, report: string | null = null, lostCoordinator = false) {
    const hub = this.hub;
    w.live = false;
    w.livenessUnknown = false;
    const oldTurn = lostCoordinator && w.resumeRevision !== undefined && w.transcript && transcriptRevision(w.transcript) === w.resumeRevision;
    const own = oldTurn ? null : readReport(report) ? report : w.transcript ? subagentReport(w.transcript) : null;
    // Losing the parent proves interruption, not completion of whatever later stage the ticket now records.
    const rec = lostCoordinator ? { state: null, last: null, gate: null } : this.recorded(w.key);
    const ending = sessionEnding(w.session, own ?? report, rec);
    const ended = this.settleAs(w.agentId, w.key, ending, w.session, this.reportedIn(w, ending));
    w.gateSeen = null;
    const note =
      ended.outcome === "handed-off"
        ? ended.verdict && ended.verdict !== "DONE" ? `Reported ${ended.verdict}${ended.next ? ` — Pathfinder recorded ${ended.next}` : ""}` : `Handed off — ${ended.next ? `Pathfinder recorded ${ended.next}` : "reported done"}`
        : ended.outcome === "gate" ? "Stopped at a human gate" : ended.outcome === "failed" ? "Reported failure — a human decides" : "Interrupted — stopped without recording a handoff";
    hub.setSession(w.hqId, { state: "stopped", detail: why });
    hub.setStatus(w.hqId, { state: "idle", note, ended });
    hub.terminal(w.hqId, `\r\n\x1b[1m■ session ended\x1b[0m (${w.tools} tool calls) — ${note}\r\n`);
    const name = hub.name(w.hqId);
    const text =
      ended.outcome === "handed-off"
        ? ended.verdict && ended.verdict !== "DONE" ? `${name} reported ${ended.verdict} on ${w.key} (${w.session})` : `${name} handed off ${w.key} (${w.session})${ended.next ? `; Pathfinder recorded ${ended.next}` : ""}`
        : ended.outcome === "gate"
          ? `${name} stopped ${w.key} at a human gate`
          : ended.outcome === "failed"
            ? `${name} reported ${w.key} failed; a human decides`
            : `${name}'s ${w.session} session on ${w.key} was interrupted (no handoff recorded)`;
    hub.activity(ended.outcome === "handed-off" ? "review.started" : ended.outcome === "interrupted" ? "session" : "agent.needs-input", w.hqId, text);
    this.applyAttention();
  }

  /** Finished sessions restored from transcripts with no saved outcome: infer it once, then keep it. */
  private settleRestored() {
    const all = [...this.workers.values()];
    for (const w of all) {
      if (w.live || w.ended || w.livenessUnknown) continue;
      const later = all.some((x) => x !== w && x.key === w.key && x.transcript && w.transcript && this.startOf(x) > this.startOf(w));
      const rec = this.recorded(w.key);
      const report = w.transcript ? subagentReport(w.transcript) : null;
      // Its own report first; else a later session on the same ticket means it handed off; else the recorded state.
      const ended = readReport(report)
        ? sessionEnding(w.session, report, rec)
        : later
          ? { outcome: "handed-off" as const, next: rec.state ?? "next stage", result: rec.last, at: new Date().toISOString() }
          : sessionEnding(w.session, null, rec);
      this.settleAs(w.agentId, w.key, ended, w.session);
      this.hub.setStatus(w.hqId, { ended });
    }
  }

  private startOf(w: Worker): string {
    return this.subagentStarts.get(w.agentId) ?? "";
  }
  private subagentStarts = new Map<string, string>();

  /** Rebuilds and reconciles the worker roster from the transcripts, then reads context use. */
  private syncTranscripts() {
    if (!this.transcript) this.recallTranscript();
    const hub = this.hub;
    const coordAlive = hub.status(COORDINATOR_ID)?.session.state === "running";
    if (coordAlive) this.coordinatorObservedRunning = true;
    if (this.transcript) {
      // Delegated helpers: the coordinator's running subagents that aren't Pathfinder workers.
      // Running ones work at the subagent stations; finished ones (the latest few) are their launcher's history.
      const recs = subagents(this.transcript);
      for (const r of recs) this.subagentStarts.set(r.agentId, r.startedAt);
      // Every subagent is identified from its own transcript and meta.json (workers get their own brief).
      // Parents first, so a helper a worker launched finds that worker.
      for (const rec of [...recs].sort((a, b) => Number(!!a.parentAgentId) - Number(!!b.parentAgentId))) {
        const known = this.workers.get(rec.agentId);
        if (!known) {
          // An unfinished file proves identity, not liveness. The coordinator may be a different process after
          // a restart. Wait for this worker's own hook or observed transcript advancement before counting it.
          const finished = rec.finished || rec.transcriptEnded;
          const restored = this.adopt(rec.agentId, this.attribution.identify(rec.agentId, this.evidence(rec.agentId, rec.file)), finished, !finished);
          if (restored) restored.transcriptRevision = rec.revision;
          continue;
        }
        // A resumed session's earlier `finished` predates its resume: only a clearly newer one ends it (its
        // SubagentStop hook ends it in any case).
        const finishedNow = (rec.finished && !(known.resumedAt && rec.metaUpdatedAt < known.resumedAt + 1000)) ||
          (rec.transcriptEnded && rec.revision !== known.resumeRevision);
        const advanced = !!known.transcriptRevision && rec.revision !== known.transcriptRevision;
        if ((known.live || known.livenessUnknown) && finishedNow) this.endWorker(known, `Session ended after ${known.tools} tool calls (transcript)`);
        else if (known.livenessUnknown && advanced && coordAlive) this.resumeWorker(known);
        known.transcriptRevision = rec.revision;
      }
      const all: WorkflowHelper[] = recs
        .filter((r) => !this.workers.has(r.agentId))
        .map((r) => {
          const seen = this.helperInfo.get(r.agentId);
          const finished = r.finished || !coordAlive || !!seen?.finished;
          if (!seen) return { id: r.agentId, label: "Unidentified subagent", type: r.agentType || "subagent", finished, unknown: true };
          return { id: r.agentId, label: r.description || seen.label, type: r.agentType || seen.type, parent: seen.parent, finished };
        });
      // Seen through hooks only, with no transcript yet: unknown until its own evidence appears.
      for (const [id, u] of this.unknownAgents) {
        if (!recs.some((r) => r.agentId === id)) all.push({ id, label: "Unidentified subagent", type: u.type || "subagent", finished: u.finished || !coordAlive, unknown: true });
      }
      const helpers = [...all.filter((h) => !h.finished), ...all.filter((h) => h.finished).slice(-8)];
      if (hub.snap.workflow && JSON.stringify(helpers) !== JSON.stringify(hub.snap.workflow.helpers ?? [])) {
        hub.snap.workflow = { ...hub.snap.workflow, helpers };
        this.emitWorkflow();
      }
      this.settleRestored();
    }
    // Reconcile workers already seen through hooks too, including those with no transcript. A stopped parent
    // process cannot keep its background workers alive. Allow the initial session reattachment to finish.
    if (!coordAlive && (this.coordinatorObservedRunning || Date.now() - this.startedAt >= 15_000)) {
      for (const w of this.workers.values()) if (w.live) this.endWorker(w, "Coordinator process stopped; no worker stop hook was received", null, true);
    }
    // Context in use, from each session's own transcript.
    // Context, model and effort, each from that session's own transcript (never another agent's).
    const setUse = (id: string, file: string | null, sidechain: boolean | undefined, configured: { model: string | null; effort: string | null }) => {
      const st = hub.status(id);
      if (!st) return;
      const next = this.usage(file, sidechain, configured);
      if (JSON.stringify(next.context) !== JSON.stringify(st.context ?? null) || JSON.stringify(next.telemetry) !== JSON.stringify(st.telemetry ?? null)) hub.setStatus(id, next);
    };
    const lead = hub.cfg(COORDINATOR_ID);
    setUse(COORDINATOR_ID, this.transcript, false, { model: lead?.model || null, effort: null });
    for (const w of this.workers.values()) {
      setUse(w.hqId, w.transcript, undefined, this.configuredFor(w));
      // Only a running worker can use a fresh context: a finished session never alerts.
      this.checkContext(w.hqId, w.live ? (hub.status(w.hqId)?.context ?? null) : null, w.live);
      const fresh = this.handoffs.readiness(this.handoffWorker(w));
      if (JSON.stringify(fresh) !== JSON.stringify(hub.status(w.hqId)?.fresh ?? null)) hub.setStatus(w.hqId, { fresh });
    }
    // After a restart no Stop hook arrives: the transcript says whether the coordinator's last turn ended.
    // The same rule as the Stop hook decides what that means (asking, or waiting on its workers).
    if (coordAlive && this.transcript && existsSync(this.transcript)) {
      const ended = awaitingHuman(this.transcript);
      if (ended !== this.turnEnded) {
        this.turnEnded = ended;
        if (!ended) this.reopenTurn();
      }
      this.applyAttention();
    }
  }

  /** The coordinator's turn reopened without a prompt hook (seen in its transcript): drop an attention state this run set. */
  private reopenTurn() {
    const st = this.hub.status(COORDINATOR_ID);
    if (st && (st.state === "waiting" || (st.state === "needs-input" && st.note === this.attentionNote))) this.hub.setStatus(COORDINATOR_ID, { state: "working", note: "Working", relaying: null });
    this.attentionNote = null;
  }

  /**
   * Open human gates still waiting on the human: `human-gate` rows and open `gate-*` action items, less those
   * the human already answered (on their way to the coordinator, or waiting for Pathfinder to record them).
   */
  private openGates(): string[] {
    const items = (this.hub.snap.actionItems ?? []).filter((i) => i.status === "open" && i.id.startsWith("gate-"));
    const answered = new Set(items.filter((i) => requestShelf(i) === "awaiting").map((i) => i.request?.key ?? i.taskId));
    const rows = this.rows.filter((r) => r.state === "human-gate" && !this.settledGates.has(r.key)).map((r) => r.key);
    return [...new Set([...rows, ...items.map((i) => i.taskId ?? i.id.replace(/^gate-/, ""))])].filter((k) => !answered.has(k));
  }

  /** The coordinator's attention once its turn ended: needs you for a real ask, else waiting on live workers. */
  private applyAttention() {
    const st = this.hub.status(COORDINATOR_ID);
    if (!st || !this.turnEnded || st.session.state !== "running") return;
    // A question or permission prompt raised elsewhere (a hook, the screen) is a real ask: keep it.
    const asking = st.state === "needs-input" && st.note !== this.attentionNote ? st.note : null;
    const gates = this.openGates();
    const next = coordinatorAttention({ turnEnded: true, liveWorkers: [...this.workers.values()].filter((w) => w.live).length, openGates: gates, asking });
    if (!next) return;
    // Only open gates: each is its own action item, so the coordinator relaying them isn't a second ask.
    const relaying = !asking && next.state === "needs-input" && gates.length ? gates.sort() : null;
    if (next.state === st.state && next.note === st.note && JSON.stringify(relaying) === JSON.stringify(st.relaying ?? null)) return;
    this.attentionNote = next.note;
    this.hub.setStatus(COORDINATOR_ID, { ...next, relaying });
  }

  private workerHook(agentId: string, event: string, body: Record<string, unknown>) {
    let w = this.workers.get(agentId) ?? null;
    if (!w && !this.helperInfo.has(agentId)) {
      // Not identified yet: only its own evidence (meta.json's tool_use_id, its own first prompt) can say who it
      // is. SubagentStart carries neither, so until they exist it stays unknown; the Agent call's result or the
      // transcript poll identifies it later. Never the oldest pending brief.
      const file = typeof body.agent_transcript_path === "string" && body.agent_transcript_path ? body.agent_transcript_path : this.subagentTranscript(agentId);
      const finished = event === "SubagentStop";
      w = this.adopt(agentId, this.attribution.identify(agentId, this.evidence(agentId, file)), finished);
      if (!w && !this.helperInfo.has(agentId)) {
        const u = this.unknownAgents.get(agentId) ?? { type: typeof body.agent_type === "string" ? body.agent_type : "", finished: false };
        u.finished ||= finished;
        this.unknownAgents.set(agentId, u);
        if (event === "SubagentStart") log.info(`subagent ${agentId} started; its session can't be identified yet`);
      }
      if (w && finished) {
        // It finished before it could be identified: added as finished, with its own report.
        this.queueRefresh(500);
        return { ok: true };
      }
    }
    if (!w) {
      // A delegated helper (e.g. a search), or a subagent not identified yet: it shows at the subagent stations.
      const h = this.helperInfo.get(agentId);
      if (h && event === "SubagentStop") h.finished = true;
      // A helper's own Agent calls: their subagents are its helpers.
      if (h && event === "PreToolUse" && (body.tool_name === "Agent" || body.tool_name === "Task")) this.attribution.launch(body.tool_use_id, (body.tool_input ?? {}) as Record<string, unknown>, h.parent);
      if (h && event === "PostToolUse" && (body.tool_name === "Agent" || body.tool_name === "Task")) this.agentLaunched(h.parent, body);
      if (event === "SubagentStart" || event === "SubagentStop") this.queueRefresh(500);
      return { ok: true };
    }
    const hub = this.hub;
    if (!w.live && (event === "SubagentStart" || (w.livenessUnknown && event !== "SubagentStop"))) this.resumeWorker(w);
    // A hook event from the session itself shows it is running now: note which gate occurrence is open on its ticket.
    if (event !== "SubagentStop") w.gateSeen = this.openOccurrence(w.key);
    switch (event) {
      case "PreToolUse": {
        w.tools += 1;
        const input = (body.tool_input ?? {}) as Record<string, unknown>;
        if (body.tool_name === "Agent" || body.tool_name === "Task") this.attribution.launch(body.tool_use_id, input, w.hqId);
        const detail = String(input.command ?? input.file_path ?? input.pattern ?? input.skill ?? "");
        const note = `${body.tool_name}${detail ? ": " + clip(detail.replace(/\s+/g, " "), 70) : ""}`;
        hub.setStatus(w.hqId, { state: "working", note, relaying: null });
        hub.terminal(w.hqId, `\x1b[36m▸ ${body.tool_name}\x1b[0m ${clip(detail.replace(/\s+/g, " "), 160)}\r\n`);
        if (/orchestrate\.mjs|current-ticket\.md|git commit/.test(detail)) this.queueRefresh(1500);
        break;
      }
      case "PostToolUse": {
        if (body.tool_name === "Agent" || body.tool_name === "Task") this.agentLaunched(w.hqId, body);
        const res = body.tool_response as Record<string, unknown> | undefined;
        const failed = res && (res.interrupted || (typeof res.stderr === "string" && /(Tin & Thyme|Tin & Thyme) run policy/.test(res.stderr)));
        if (failed) hub.terminal(w.hqId, `\x1b[33m  blocked by run policy\x1b[0m\r\n`);
        break;
      }
      case "SubagentStop": {
        const last = typeof body.last_assistant_message === "string" ? body.last_assistant_message : null;
        if (w.live || w.livenessUnknown) this.endWorker(w, `Session ended after ${w.tools} tool calls`, last);
        break;
      }
    }
    this.queueRefresh(800);
    return { ok: true };
  }

  // ---------------------------------------------------------------- engine → board

  /**
   * A ticket's delivery stage (PR open, merged), from its delivery record. Feature 10 sets this; until then no
   * ticket has one, and the board shows reviewed tickets as ready to deliver.
   */
  deliveryOf: (key: string) => DeliveryStage | null = () => null;

  liveKeys(): string[] {
    return [...new Set([...this.workers.values()].filter((w) => w.live).map((w) => w.key))];
  }

  /** The coordinator ran `orchestrate plan`: keep what it said (in ~/.controlroom) until the next plan. */
  private notePlan(plan: PlanSeen) {
    writeFileSync(join(this.stateDir, "plan.json"), JSON.stringify(plan, null, 2));
    if (!this.hub.snap.workflow) return;
    this.hub.snap.workflow = { ...this.hub.snap.workflow, plan };
    this.emitWorkflow();
    this.hub.activity("task.assigned", COORDINATOR_ID, `Dispatch plan: ${plan.dispatch.length ? `${plan.dispatch.join(", ")} eligible to claim` : "nothing to claim now"}${plan.deferred.length ? `; ${plan.deferred.map((d) => d.key).join(", ")} wait for a later round` : ""}`);
  }

  private savedPlan(): PlanSeen | null {
    try {
      const p = JSON.parse(readFileSync(join(this.stateDir, "plan.json"), "utf8"));
      return p && Array.isArray(p.dispatch) ? (p as PlanSeen) : null;
    } catch {
      return null;
    }
  }

  start() {
    this.hub.snap.workflow = { kind: "pathfinder", mode: this.info.mode, store: "", roles: PathfinderRun.readRoles(this.root), contextAlertPct: this.loadSettings().contextAlertPct, handoffs: {}, plan: this.savedPlan() };
    void this.refresh();
    this.polling = setInterval(() => void this.refresh(), 5000);
  }

  stop() {
    if (this.polling) clearInterval(this.polling);
  }

  private queueRefresh(ms: number) {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    setTimeout(() => {
      this.refreshQueued = false;
      void this.refresh();
    }, ms);
  }

  private status(): Promise<{ ok: boolean; rows?: StatusRow[]; message?: string }> {
    const live = this.liveKeys();
    const args = [this.info.engine, "status", "--json", ...(live.length ? ["--live", live.join(",")] : [])];
    return new Promise((resolve) => {
      execFile("node", args, { cwd: this.root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ ok: false, message: err ? err.message : "engine returned no JSON" });
        }
      });
    });
  }

  private stateFile(key: string): Record<string, string> {
    const file = join(this.root, ".pathfinder", "worktrees", key, "context", "current-ticket.md");
    const out: Record<string, string> = {};
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^-\s*([A-Za-z -]+):\s*(.+)$/.exec(line);
      if (m && ["State", "Gate", "Gate-Id", "Store", "Last", "Next", "Updated", "Adversary", "Review", "Repair", "Resolved findings", "Gate stage", "Failed stage", "Worker"].includes(m[1])) out[m[1]] = m[2].trim();
    }
    return out;
  }

  /**
   * The gate open on `key` right now, from Pathfinder's durable record: its worker's state file (`State`, `Gate`,
   * `Gate-Id`) and the gate notes the engine wrote in its ticket. Null when the state file isn't at a gate. Read
   * from disk every time, so a start-up, a refresh and an answer all see the record as it is at that moment.
   */
  private gateNow(key: string, sf = this.stateFile(key)): GateNow | null {
    if (sf.State?.split(/\s/)[0] !== "human-gate") return null;
    const occurrence = isGateOccurrence(sf["Gate-Id"]) ? sf["Gate-Id"] : null;
    const history = readGateHistory(join(this.root, ".pathfinder", "worktrees", key), key, sf.Store ?? null);
    return { text: sf.Gate ?? "", stage: sf["Gate stage"] ?? null, occurrence, history, resolved: !!occurrence && history.resolved.includes(occurrence) };
  }

  /** The occurrence of the gate open on `key` right now, from its state file alone; null when there is no gate, or it has none. */
  private openOccurrence(key: string): string | null {
    const sf = this.stateFile(key);
    return sf.State?.split(/\s/)[0] === "human-gate" && isGateOccurrence(sf["Gate-Id"]) ? sf["Gate-Id"] : null;
  }

  /** Gate requests this run has itself seen open (by revision). One without an occurrence is the same request only while watched. */
  private watched = new Set<string>();
  /** Tickets whose state file still shows a gate occurrence that Pathfinder's history records resolved (ticket → occurrence). */
  private settledGates = new Map<string, string>();

  /**
   * Answers delivered for gate occurrences, kept in ~/.controlroom by request revision, so a restart shows the same
   * result for the same occurrence and sends nothing twice. Only a request with an occurrence is kept: without
   * one, nothing shows that a saved answer was for the gate open now.
   */
  private answerBook(next?: Record<string, ActionAnswer>) {
    const file = join(this.stateDir, "gate-answers.json");
    if (next) {
      writeFileSync(file, JSON.stringify(next, null, 2));
      return next;
    }
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, ActionAnswer>;
    } catch {
      return {};
    }
  }

  private async refresh() {
    const r = await this.status();
    if (!r.ok || !r.rows) {
      if (r.message !== this.engineError) {
        this.engineError = r.message ?? "engine failed";
        this.hub.activity("config", null, `Pathfinder engine: ${this.engineError}`);
      }
      return;
    }
    this.engineError = null;
    this.rows = r.rows;
    const store = (r as { store?: string }).store;
    if (store && this.hub.snap.workflow) this.hub.snap.workflow.store = store;
    try {
      this.syncTranscripts();
    } catch (e) {
      log.warn("transcripts:", e);
    }
    this.applyBoard();
  }

  private ownerFor(key: string): string | null {
    const ws = [...this.workers.values()].filter((w) => w.key === key);
    const live = ws.filter((w) => w.live);
    return (live.at(-1) ?? ws.at(-1))?.hqId ?? null;
  }

  private applyBoard() {
    const hub = this.hub;
    const features = new Map<string, StatusRow[]>();
    for (const row of this.rows) {
      const f = row.key.split(".")[0];
      features.set(f, [...(features.get(f) ?? []), row]);
    }
    const featureTitle = (nn: string) => {
      try {
        const file = readdirSync(join(this.root, "context", "features")).find((f) => f.startsWith(`${nn}-`) || f.startsWith(`${nn.padStart(2, "0")}-`));
        return file ? file.replace(/^\d+-/, "").replace(/\.md$/, "").replace(/-/g, " ") : "";
      } catch {
        return "";
      }
    };
    const inScope = new Set(this.rows.filter((r) => r.state !== "integrated").map((r) => r.key.split(".")[0]));
    const boards: Board[] = [...features.keys()]
      .sort((a, b) => Number(a) - Number(b))
      .map((f, i) => {
        const rows = features.get(f) ?? [];
        const active = rows.some((r) => !["integrated", "ready", "blocked"].includes(r.state));
        return { id: `F${f}`, title: `Feature ${f}${featureTitle(f) ? " — " + featureTitle(f) : ""}`, status: active ? "active" : inScope.has(f) ? "planned" : "done", order: i };
      });
    const tasks: Task[] = this.rows.map((row) => {
      const sf = this.stateFile(row.key);
      const evidence = [
        `Pathfinder state: ${row.state} · lifecycle: ${row.lifecycle}${row.worker && row.worker !== "—" ? ` · worker: ${row.worker}` : ""}`,
        row.where && row.where !== "—" ? `Where: ${row.where}` : "",
        sf.Review ? `Review: ${sf.Review}` : "",
        sf.Adversary ? `Adversary: ${sf.Adversary}` : "",
        sf["Resolved findings"] ? `Resolved findings: ${sf["Resolved findings"]}` : "",
        sf.Last || (row.last && row.last !== "—") ? `Last: ${sf.Last ?? row.last}` : "",
        sf.Next ? `Next: ${sf.Next}` : "",
        sf.Updated ? `Updated: ${sf.Updated}` : "",
      ].filter(Boolean);
      const gate = row.state === "human-gate" ? sf.Gate ?? row.gate : null;
      // One shared mapping decides label, column, next step and blocker: `done` is never "in review".
      const recordedState = row.recordedState ?? (sf.State ? sf.State.split(/\s/)[0] : null);
      const liveSession = [...this.workers.values()].filter((w) => w.live && w.key === row.key).at(-1)?.session ?? null;
      const lastEnded = [...this.workers.values()].filter((w) => !w.live && w.key === row.key && w.ended).sort((x, y) => Date.parse(x.ended!.at) - Date.parse(y.ended!.at)).at(-1)?.ended?.outcome ?? null;
      const view = ticketView({ state: row.state, lifecycle: row.lifecycle, recorded: recordedState, gate: gate ?? row.gate, liveSession, lastEnded, delivery: this.deliveryOf(row.key) });
      const status: TaskStatus = view.column;
      return {
        id: row.key,
        boardId: `F${row.key.split(".")[0]}`,
        title: row.title,
        ownerId: this.ownerFor(row.key),
        status,
        needs: [],
        prNumber: null,
        description: evidence.join("\n"),
        pf: {
          state: row.state, lifecycle: row.lifecycle, role: (row as { role?: string | null }).role ?? null, gate: gate ?? (row.gate && row.gate !== "—" ? row.gate : null),
          recorded: recordedState,
          delivery: this.deliveryOf(row.key),
          view,
        },
        note: gate ? `◆ Needs you: ${gate}` : row.gate && row.gate !== "—" ? row.gate : row.state === "stale" ? "stale: claim with no live session" : null,
      };
    });

    // Delivery into MAIN is only what the engine reports as integrated, and only news since this run was first read.
    if (!this.integratedAtStart) this.integratedAtStart = new Set(this.rows.filter((r) => r.state === "integrated").map((r) => r.key));
    for (const row of this.rows) {
      if (row.state !== "integrated" || this.integratedAtStart.has(row.key)) continue;
      this.integratedAtStart.add(row.key);
      hub.activity("pr.merged", this.ownerFor(row.key), `${row.key} delivered to MAIN (Pathfinder: integrated)`);
    }

    // Boards and tasks: emit only what changed.
    const prevBoards = new Map(hub.snap.boards.map((b) => [b.id, JSON.stringify(b)]));
    const prevTasks = new Map(hub.snap.tasks.map((t) => [t.id, JSON.stringify(t)]));
    hub.snap.boards = boards;
    hub.snap.tasks = tasks;
    for (const b of boards) if (prevBoards.get(b.id) !== JSON.stringify(b)) hub.emit({ type: "board.updated", board: b });
    for (const t of tasks) {
      const before = prevTasks.get(t.id);
      if (before === JSON.stringify(t)) continue;
      hub.emit({ type: "task.updated", task: t });
      if (before) {
        const old = JSON.parse(before) as Task;
        if (old.status !== t.status) hub.activity("task.assigned", t.ownerId, `${t.id} moved ${old.status} → ${t.status}`);
      }
    }

    // Workers follow their ticket's engine state while they are live.
    for (const w of this.workers.values()) {
      const row = this.rows.find((r) => r.key === w.key);
      if (!row) continue;
      const st = hub.status(w.hqId);
      if (st && st.currentTaskId !== w.key) hub.setStatus(w.hqId, { currentTaskId: w.key });
      // Only a live session can be asking; a finished one's gate is the coordinator's to relay (and an action item).
      if (w.live && row.state === "human-gate" && st && st.state !== "needs-input") {
        // Its gate is an action item, answered through the coordinator: not a second ask, and not in its terminal.
        hub.setStatus(w.hqId, { state: "needs-input", note: `Asking: ${clip(this.stateFile(w.key).Gate ?? row.gate)}`, relaying: [w.key] });
      } else if (row.state !== "human-gate" && st?.state === "needs-input" && st.relaying?.length) {
        // Its gate is no longer open in Pathfinder: it isn't asking any more.
        hub.setStatus(w.hqId, w.live ? { state: "working", note: "Continuing after the gate", relaying: null } : { state: "idle", relaying: null });
      }
    }

    // Human gates → action items (Pathfinder's own gate text, verbatim), one request per gate occurrence.
    const open = new Set<string>();
    const requests = new Set<string>();
    const settled = new Map<string, string>();
    for (const row of this.rows.filter((r) => r.state === "human-gate")) {
      // Read the list fresh each time: an earlier gate in this loop may have just been added.
      const items = hub.snap.actionItems ?? [];
      const id = `gate-${row.key}`;
      const sf = this.stateFile(row.key);
      if (sf.State && sf.State.split(/\s/)[0] !== "human-gate") {
        // The state file moved on after the engine read it. A mixed reading opens and closes nothing: read again.
        open.add(id);
        this.queueRefresh(400);
        continue;
      }
      const now = this.gateNow(row.key, sf);
      if (now?.resolved) {
        // Pathfinder's gate history records this occurrence resolved; only the state file hasn't caught up. It isn't
        // waiting on the human, so it is not an open request (it closes below).
        settled.set(row.key, now.occurrence!);
        continue;
      }
      open.add(id);
      const text = sf.Gate ?? row.gate;
      const request = this.gateRequest(row.key, { text, occurrence: now?.occurrence ?? null, resolved: now?.history.resolved ?? [] }, sf["Gate stage"] ?? null);
      const existing = items.find((i) => i.id === id);
      // The same request is the same occurrence, whatever its text. A gate with no occurrence has only its text, and
      // that is the same request only while this run has watched it: one carried over a restart can't be shown to be
      // the gate open now, so it starts again as a new request.
      const same = existing?.status === "open" && existing.request?.revision === request.revision && (request.occurrence !== null || this.watched.has(request.revision));
      this.watched.add(request.revision);
      requests.add(request.revision);
      if (existing && same) {
        // Keep its answer and snooze, and keep whose it is current.
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
          existing.request = request;
          existing.fromId = request.owner ?? COORDINATOR_ID;
          hub.emit({ type: "action.updated", item: existing });
        }
        continue;
      }
      // A new request (a new occurrence, or a changed gate): never another session's, never an earlier request's
      // answer or snooze. An answer this kitchen delivered for this very occurrence before a restart is its own.
      const item: ActionItem = {
        id, fromId: request.owner ?? COORDINATOR_ID, taskId: row.key, title: `${row.key} needs your decision`,
        details: text,
        waiting: true, status: "open", note: null, at: new Date().toISOString(), closedAt: null,
        request, answer: (request.occurrence && this.answerBook()[request.revision]) || null, snoozedUntil: null,
      };
      hub.snap.actionItems = [item, ...items.filter((i) => i.id !== id)];
      hub.emit({ type: "action.updated", item });
      hub.activity("agent.needs-input", item.fromId, `${row.key} needs your decision: ${clip(text, 60)}`);
    }
    this.settledGates = settled;
    this.pruneAnswers(requests);
    for (const item of hub.snap.actionItems ?? []) {
      if (item.id.startsWith("gate-") && item.status === "open" && !open.has(item.id)) {
        // Resolved only when Pathfinder shows it: the engine no longer reports the gate, or its history records
        // this occurrence resolved.
        const key = item.taskId ?? item.id.replace(/^gate-/, "");
        const now = this.rows.find((r) => r.key === key)?.state ?? "no longer listed";
        const occurrence = settled.get(key);
        const recorded = occurrence && item.request?.occurrence === occurrence ? `Pathfinder's gate history records this request resolved (occurrence ${occurrence})` : `Pathfinder: ${key} is now ${now}`;
        item.status = "done";
        item.closedAt = new Date().toISOString();
        item.note = recorded;
        if (item.answer && item.request && item.answer.revision === item.request.revision && item.answer.state === "delivered") {
          item.answer = { ...item.answer, state: "recorded", at: item.closedAt, detail: occurrence ? recorded : `Pathfinder recorded it: ${key} is now ${now}` };
        }
        hub.emit({ type: "action.updated", item });
      }
    }
    this.applyAttention();
  }

  /** An occurrence that isn't open now never opens again, so its saved answer has nothing left to restore. */
  private pruneAnswers(open: Set<string>) {
    const book = this.answerBook();
    const kept = Object.fromEntries(Object.entries(book).filter(([revision]) => open.has(revision)));
    if (Object.keys(kept).length !== Object.keys(book).length) this.answerBook(kept);
  }

  /**
   * Who raised a ticket's gate: only a session whose own report raised this question in this very occurrence
   * (gateOwner). Anything else, including a gate the coordinator recorded and any gate with no occurrence, is
   * unidentified and says why (never a guess from timing or from the question's words).
   */
  private gateRequest(key: string, gate: { text: string; occurrence: string | null; resolved: string[] }, gateStage: string | null): ActionRequest {
    const base = { kind: "gate" as const, key, revision: gateRevision(key, gate.text, gate.occurrence), occurrence: gate.occurrence };
    const ws = [...this.workers.values()].filter((w) => w.key === key);
    const book = this.endBook();
    const candidates = ws.map((w): GateCandidate & { w: Worker } => ({ w, ...this.gateCandidate(w, book[w.agentId]) }));
    const { owner, diagnostic } = gateOwner(key, gate, candidates);
    if (!owner) return { ...base, stage: gateStage, owner: null, session: null, diagnostic };
    const w = (owner as GateCandidate & { w: Worker }).w;
    return { ...base, stage: gateStage ?? w.session, owner: w.hqId, session: w.session, diagnostic: null };
  }

  /** A session as the gate-owner decision sees it: its own report, the occurrence that report was made in, and when it ended (to order reporters only). */
  private gateCandidate(w: Worker, saved: BookEntry | undefined): GateCandidate {
    const at = w.ended ? Date.parse(w.ended.at) : NaN;
    const end = !w.live && Number.isFinite(at) ? at : null;
    const report = w.ended?.verdict ? { verdict: w.ended.verdict, text: w.ended.result ?? "" } : null;
    const occurrence = saved?.key === w.key && isGateOccurrence(saved.occurrence) ? saved.occurrence : null;
    return { id: w.hqId, name: this.hub.name(w.hqId), session: w.session, live: w.live, end, report, outcome: w.ended?.outcome ?? null, occurrence };
  }

  /**
   * The human answered a gate in the UI: hand the text to the coordinator, verbatim, exactly once per gate
   * occurrence. The answer must name the request it is for, and that request must be the gate open in Pathfinder's
   * record at this moment: an answer to a resolved or replaced occurrence is refused and nothing is typed, so it
   * can never be recorded against a later one.
   */
  async answerGate(itemId: string, note: string, revision?: string) {
    const item = this.hub.snap.actionItems?.find((i) => i.id === itemId);
    if (!item || item.status !== "open") {
      this.hub.activity("agent.answered", COORDINATOR_ID, `That request is already resolved; nothing was sent`);
      return;
    }
    const key = item.taskId ?? itemId.replace(/^gate-/, "");
    const occurrence = item.request?.occurrence ?? null;
    const shown = item.request?.revision ?? gateRevision(key, item.details, null);
    const text = note.trim();
    const answer = (state: ActionAnswer["state"], detail: string | null, rev = shown): ActionAnswer => ({ state, text, revision: rev, at: new Date().toISOString(), detail });
    const publish = (a: ActionAnswer) => {
      item.answer = a;
      if (occurrence && a.revision === shown && a.state === "delivered") this.answerBook({ ...this.answerBook(), [shown]: a });
      // The request may have been replaced while the answer was on its way: then there is nothing of it left to show.
      if (this.hub.snap.actionItems?.includes(item)) this.hub.emit({ type: "action.updated", item: { ...item } });
    };
    const sent = item.answer && item.answer.revision === shown ? item.answer.state : null;
    // A refusal never replaces an answer already sent for the request that is open now.
    const refuse = (detail: string, rev = shown) => {
      if (sent === "sending" || sent === "delivered") this.hub.activity("agent.answered", COORDINATOR_ID, `An answer for ${key} wasn't sent. ${detail.replace(/^Not sent: /, "")}`);
      else publish(answer("rejected", detail, rev));
    };
    // Pathfinder's record, read now (not as of the last refresh): only the gate occurrence open at this moment is answered.
    const sf = this.stateFile(key);
    const now = this.gateNow(key, sf);
    if (sf.State && (!now || now.resolved)) {
      refuse(`Not sent: Pathfinder's record shows this gate on ${key} is no longer open (it was resolved, or closed by a state change), so there is nothing to answer.`);
      this.queueRefresh(0);
      return;
    }
    if (now && gateRevision(key, sf.Gate ?? item.details, now.occurrence) !== shown) {
      refuse(`Not sent: Pathfinder closed this request and opened a new one on ${key} since it was shown. Read the current request and answer that.`);
      this.queueRefresh(0);
      return;
    }
    if (revision ? revision !== shown : occurrence !== null) {
      refuse(revision ? "Not sent: this request changed since you read it. Read the current request and answer that." : "Not sent: the answer didn't say which request it is for.", revision ?? shown);
      return;
    }
    if (!text) {
      refuse("Not sent: write an answer first. Snooze puts a request aside without sending anything.");
      return;
    }
    // Sent once per occurrence. A gate with no occurrence can't show that an answer delivered earlier was for the gate
    // open now, so only an answer still on its way holds another one back.
    if (sent === "sending" || (occurrence && (sent === "delivered" || sent === "recorded"))) {
      this.hub.activity("agent.answered", COORDINATOR_ID, `Your answer for ${key} was already sent; it wasn't sent again`);
      return;
    }
    if (this.hub.status(COORDINATOR_ID)?.session.state !== "running") {
      publish(answer("failed", "The coordinator isn't running, so nothing was sent. Start the orchestration, then send it again."));
      return;
    }
    publish(answer("sending", null));
    const who = item.request?.owner ? `${this.hub.name(item.request.owner)}'s ${item.request.session ?? ""} session`.replace(/\s+session$/, " session") : "an unidentified session";
    const message = `Human answer for the ${key} gate (from Tin & Thyme${occurrence ? `, gate occurrence ${occurrence}` : ""}, raised by ${who}): ${text}`;
    const ok = await this.sessions.typeInto(COORDINATOR_ID, message.replace(/\s+/g, " "));
    publish(ok ? answer("delivered", "Typed into the coordinator's session. Resolved once Pathfinder records it.") : answer("failed", "Couldn't reach the coordinator's terminal; nothing was delivered. Send it again."));
    this.hub.activity("agent.answered", COORDINATOR_ID, ok ? `Your answer for ${key} went to the coordinator` : `Couldn't reach the coordinator's terminal for ${key}`);
    if (!ok) log.warn(`answerGate: coordinator terminal unavailable`);
  }

  /** Snooze a gate: it leaves "Needs you" for a while. Nothing is sent to any agent and nothing is resolved. */
  snoozeGate(itemId: string, minutes = 60) {
    const item = this.hub.snap.actionItems?.find((i) => i.id === itemId);
    if (!item || item.status !== "open") return;
    item.snoozedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
    this.hub.emit({ type: "action.updated", item: { ...item } });
  }
}
