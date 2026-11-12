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
//     treated as a running agent: liveness is "SubagentStart seen, no
//     SubagentStop yet", and only those keys are passed to `status --live`.
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
  tools: number;
  character: CharacterId;
  transcript: string | null;
  /** How the session ended (from Pathfinder's checkpoint at that moment); null while live. */
  ended: SessionEnd | null;
}

/** The checkpoint state a session of this kind works in; recording anything else is its handoff. */
const OWN_STATE: Record<string, string> = { adversary: "adversary", review: "review", repair: "repair" };

/**
 * How a stopped session ended, from the state Pathfinder recorded for its ticket when it stopped. Only a
 * recorded next stage (or done / integrated) is a handoff; a session that stopped leaving its own stage
 * in place was interrupted.
 */
export function sessionOutcome(session: string, recorded: string | null): SessionEnd["outcome"] {
  if (recorded === "human-gate") return "gate";
  if (recorded === "failed") return "failed";
  if (!recorded || recorded === (OWN_STATE[session] ?? "working")) return "interrupted";
  return "handed-off";
}

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
  private pendingBriefs: string[] = [];
  /** Delegated helpers launched but not yet started: who launched them, and what for. */
  private pendingHelpers: { parent: string; label: string; type: string }[] = [];
  /** Helper subagent id → who launched it (seen through hooks). */
  private helperInfo = new Map<string, { parent: string; label: string; type: string; finished: boolean }>();
  private rows: StatusRow[] = [];
  private polling: NodeJS.Timeout | null = null;
  private refreshQueued = false;
  private engineError: string | null = null;
  private seq = 0;
  /** The coordinator's Claude Code transcript (from its hooks, or found once at start-up). */
  private transcript: string | null = null;
  /** True while the "waiting for you" state came from the transcript, not a hook. */
  private awaitingFromTranscript = false;
  /** Ticket keys already integrated when this run was first read: only later ones are deliveries. */
  private integratedAtStart: Set<string> | null = null;
  private startedAt = Date.now();

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

  /** The coordinator ended its turn on a question (read from its transcript) and nobody has answered yet. */
  isAsking(hqId: string) {
    return hqId === COORDINATOR_ID && this.awaitingFromTranscript;
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
    if (event === "UserPromptSubmit") this.awaitingFromTranscript = false;

    // The coordinator itself.
    if (event === "PreToolUse" && (body.tool_name === "Agent" || body.tool_name === "Task")) {
      const input = (body.tool_input ?? {}) as Record<string, unknown>;
      const prompt = String(input.prompt ?? "");
      if (parseBrief(prompt)) this.pendingBriefs.push(prompt);
      else this.pendingHelpers.push({ parent: COORDINATOR_ID, label: String(input.description ?? prompt.split("\n")[0]).slice(0, 80) || "Subagent", type: String(input.subagent_type ?? "subagent") });
    }
    if (event === "PostToolUse" && body.tool_name === "Bash") {
      const cmd = String((body.tool_input as Record<string, unknown>)?.command ?? "");
      if (/orchestrate\.mjs\s+plan\b/.test(cmd)) {
        const r = (body.tool_response ?? {}) as Record<string, unknown>;
        const seen = parsePlanOutput(String(r.stdout ?? r.output ?? ""));
        if (seen) this.notePlan({ ...seen, at: new Date().toISOString() });
      }
    }
    if (event === "PostToolUse" && (body.tool_name === "Agent" || body.tool_name === "Task")) {
      const r = (body.tool_response ?? {}) as Record<string, unknown>;
      const id = typeof r.agentId === "string" ? r.agentId : null;
      const prompt = String((body.tool_input as Record<string, unknown>)?.prompt ?? r.prompt ?? "");
      if (id && !this.workers.has(id) && parseBrief(prompt)) this.addWorker(id, prompt);
    }
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
      // A coordinator that ends its turn mid-run is asking the human (the approval gate or a question).
      this.hub.setStatus(COORDINATOR_ID, { state: "needs-input", note: "Asking: answer the coordinator in its terminal" });
    }
    this.queueRefresh(800);
    return r;
  }

  private subagentTranscript(agentId: string): string | null {
    return this.transcript ? join(this.transcript.replace(/\.jsonl$/, ""), "subagents", `agent-${agentId}.jsonl`) : null;
  }

  /** A worker session joins the room. `finished` restores one that already ended (from its transcript). */
  private addWorker(agentId: string, prompt: string, finished = false): Worker | null {
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
    const ended = finished ? (this.endBook()[agentId] ?? null) : null;
    const w: Worker = { agentId, hqId, key: b.key, session: b.session, role, worktree: b.worktree, live: !finished, tools: 0, character: c.id, transcript: this.subagentTranscript(agentId), ended };
    this.workers.set(agentId, w);
    const cfg = newAgent(hqId, c.name, role, ROLE_COLOR[role] ?? "#c2c3c7", false);
    cfg.mode = "local";
    cfg.workspacePath = b.worktree;
    cfg.roleMd = `Pathfinder ${b.session} session, role ${b.role}, for ${b.key} ${b.title}`;
    cfg.crew = { character: c.id, job: c.job, role, session: b.session, ticket: b.key, worktree: b.worktree };
    const hub = this.hub;
    hub.snap.config.team.push(cfg);
    const st: AgentStatus = {
      agentId: hqId, state: finished ? "idle" : "working", currentTaskId: b.key, stateSince: new Date().toISOString(),
      note: finished ? "Session finished — report handed to the coordinator" : `Started ${b.session} session`,
      session: { state: finished ? "stopped" : "running", detail: `Background subagent ${agentId} of the coordinator`, workspace: b.worktree, sandbox: null },
      ...this.usage(w.transcript, undefined, this.configuredFor(w)),
      ended,
    };
    hub.snap.agents.push(st);
    hub.configChanged();
    hub.emit({ type: "agent.updated", agent: structuredClone(st) });
    if (!finished) hub.activity("task.started", hqId, `${cfg.name} (${role}, ${b.session} ${b.key}) started in ${b.worktree ?? "its worktree"}`);
    if (!finished) this.handoffs.onWorkerStarted(b.key, hqId);
    hub.terminal(hqId, `\x1b[1mPathfinder ${b.session} session for ${b.key}\x1b[0m — ${b.title}\r\nsubagent ${agentId}\r\nworktree ${b.worktree}\r\n${finished ? "\r\n\x1b[1m■ session finished\x1b[0m (restored from its transcript)\r\n" : ""}\r\n`);
    this.queueRefresh(500);
    return w;
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

  /** Session outcomes, kept in ~/.controlroom by subagent id so a restart reads the same history. */
  private endBook(next?: Record<string, SessionEnd>) {
    const file = join(this.stateDir, "sessions.json");
    if (next) {
      writeFileSync(file, JSON.stringify(next, null, 2));
      return next;
    }
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, SessionEnd>;
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

  private settle(w: Worker, outcome: SessionEnd["outcome"], rec: { state: string | null; last: string | null; gate: string | null }) {
    const ended: SessionEnd = { outcome, next: outcome === "handed-off" ? rec.state : null, result: outcome === "gate" ? rec.gate ?? rec.last : rec.last, at: new Date().toISOString() };
    w.ended = ended;
    this.endBook({ ...this.endBook(), [w.agentId]: ended });
    return ended;
  }

  private endWorker(w: Worker, why: string) {
    const hub = this.hub;
    w.live = false;
    const rec = this.recorded(w.key);
    const ended = this.settle(w, sessionOutcome(w.session, rec.state), rec);
    const note =
      ended.outcome === "handed-off" ? `Handed off — Pathfinder recorded ${ended.next}` : ended.outcome === "gate" ? "Stopped at a human gate" : ended.outcome === "failed" ? "Reported failure — a human decides" : "Interrupted — stopped without recording a handoff";
    hub.setSession(w.hqId, { state: "stopped", detail: why });
    hub.setStatus(w.hqId, { state: "idle", note, ended });
    hub.terminal(w.hqId, `\r\n\x1b[1m■ session ended\x1b[0m (${w.tools} tool calls) — ${note}\r\n`);
    const name = hub.name(w.hqId);
    const text =
      ended.outcome === "handed-off"
        ? `${name} handed off ${w.key} (${w.session}); Pathfinder recorded ${ended.next}`
        : ended.outcome === "gate"
          ? `${name} stopped ${w.key} at a human gate`
          : ended.outcome === "failed"
            ? `${name} reported ${w.key} failed; a human decides`
            : `${name}'s ${w.session} session on ${w.key} was interrupted (no handoff recorded)`;
    hub.activity(ended.outcome === "handed-off" ? "review.started" : ended.outcome === "interrupted" ? "session" : "agent.needs-input", w.hqId, text);
  }

  /** Finished sessions restored from transcripts with no saved outcome: infer it once, then keep it. */
  private settleRestored() {
    const all = [...this.workers.values()];
    for (const w of all) {
      if (w.live || w.ended) continue;
      const later = all.some((x) => x !== w && x.key === w.key && x.transcript && w.transcript && this.startOf(x) > this.startOf(w));
      const rec = this.recorded(w.key);
      const outcome = later ? "handed-off" : sessionOutcome(w.session, rec.state);
      const ended = this.settle(w, outcome, later ? { ...rec, state: rec.state ?? "next stage" } : rec);
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
    if (this.transcript) {
      // Delegated helpers: the coordinator's running subagents that aren't Pathfinder workers.
      // Running ones work at the subagent stations; finished ones (the latest few) are their launcher's history.
      const recs = subagents(this.transcript);
      for (const r of recs) this.subagentStarts.set(r.agentId, r.startedAt);
      const all: WorkflowHelper[] = recs
        .filter((r) => !parseBrief(r.prompt))
        .map((r) => {
          const seen = this.helperInfo.get(r.agentId);
          return {
            id: r.agentId,
            label: r.description || seen?.label || r.prompt.split("\n")[0].slice(0, 80) || "Subagent",
            type: r.agentType || seen?.type || "subagent",
            parent: seen?.parent ?? COORDINATOR_ID,
            finished: r.finished || !coordAlive || !!seen?.finished,
          };
        });
      const helpers = [...all.filter((h) => !h.finished), ...all.filter((h) => h.finished).slice(-8)];
      if (hub.snap.workflow && JSON.stringify(helpers) !== JSON.stringify(hub.snap.workflow.helpers ?? [])) {
        hub.snap.workflow = { ...hub.snap.workflow, helpers };
        this.emitWorkflow();
      }
      for (const rec of subagents(this.transcript)) {
        const known = this.workers.get(rec.agentId);
        if (!known) {
          // An unfinished subagent is live only while its coordinator runs; give the reattach a few seconds first.
          if (!rec.finished && !coordAlive && Date.now() - this.startedAt < 15_000) continue;
          if (parseBrief(rec.prompt)) this.addWorker(rec.agentId, rec.prompt, rec.finished || !coordAlive);
          continue;
        }
        if (known.live && rec.finished) this.endWorker(known, `Session ended after ${known.tools} tool calls (transcript)`);
      }
      this.settleRestored();
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
    // After a restart no Stop hook arrives: a coordinator whose last turn ended is waiting on the human.
    const st = hub.status(COORDINATOR_ID);
    if (st && coordAlive && this.transcript) {
      const waiting = awaitingHuman(this.transcript);
      if (waiting && !this.awaitingFromTranscript) {
        this.awaitingFromTranscript = true;
        hub.setStatus(COORDINATOR_ID, { state: "needs-input", note: "Asking: its turn ended — answer the coordinator in its terminal" });
      } else if (waiting && st.state !== "needs-input") {
        hub.setStatus(COORDINATOR_ID, { state: "needs-input", note: "Asking: its turn ended — answer the coordinator in its terminal" });
      } else if (!waiting && this.awaitingFromTranscript) {
        this.awaitingFromTranscript = false;
        if (st.state === "needs-input") hub.setStatus(COORDINATOR_ID, { state: "working", note: "Working" });
      }
    }
  }

  private workerHook(agentId: string, event: string, body: Record<string, unknown>) {
    let w = this.workers.get(agentId) ?? null;
    if (!w && event === "SubagentStart" && !this.helperInfo.has(agentId)) {
      const prompt = this.pendingBriefs.shift();
      if (prompt) w = this.addWorker(agentId, prompt);
      else {
        const h = this.pendingHelpers.shift();
        if (h) this.helperInfo.set(agentId, { ...h, finished: false });
      }
    }
    if (!w) {
      // A delegated helper (e.g. a search): it shows at the subagent stations while it runs.
      const h = this.helperInfo.get(agentId);
      if (h && event === "SubagentStop") h.finished = true;
      if (event === "SubagentStart" || event === "SubagentStop") this.queueRefresh(500);
      return { ok: true };
    }
    const hub = this.hub;
    switch (event) {
      case "SubagentStart":
        w.live = true;
        break;
      case "PreToolUse": {
        w.tools += 1;
        const input = (body.tool_input ?? {}) as Record<string, unknown>;
        if (body.tool_name === "Agent" || body.tool_name === "Task") {
          this.pendingHelpers.push({ parent: w.hqId, label: String(input.description ?? "").slice(0, 80) || "Subagent", type: String(input.subagent_type ?? "subagent") });
        }
        const detail = String(input.command ?? input.file_path ?? input.pattern ?? input.skill ?? "");
        const note = `${body.tool_name}${detail ? ": " + clip(detail.replace(/\s+/g, " "), 70) : ""}`;
        hub.setStatus(w.hqId, { state: "working", note });
        hub.terminal(w.hqId, `\x1b[36m▸ ${body.tool_name}\x1b[0m ${clip(detail.replace(/\s+/g, " "), 160)}\r\n`);
        if (/orchestrate\.mjs|current-ticket\.md|git commit/.test(detail)) this.queueRefresh(1500);
        break;
      }
      case "PostToolUse": {
        const res = body.tool_response as Record<string, unknown> | undefined;
        const failed = res && (res.interrupted || (typeof res.stderr === "string" && /(Tin & Thyme|Tin & Thyme) run policy/.test(res.stderr)));
        if (failed) hub.terminal(w.hqId, `\x1b[33m  blocked by run policy\x1b[0m\r\n`);
        break;
      }
      case "SubagentStop": {
        if (w.live) this.endWorker(w, `Session ended after ${w.tools} tool calls`);
        break;
      }
    }
    this.queueRefresh(800);
    return { ok: true };
  }

  // ---------------------------------------------------------------- engine → board

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
      const m = /^-\s*([A-Za-z ]+):\s*(.+)$/.exec(line);
      if (m && ["State", "Gate", "Last", "Next", "Updated", "Adversary", "Review", "Repair", "Resolved findings", "Gate stage", "Failed stage", "Worker"].includes(m[1])) out[m[1]] = m[2].trim();
    }
    return out;
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
    const map: Record<string, TaskStatus> = {
      ready: "todo", blocked: "blocked", working: "in-progress", adversary: "in-review", review: "in-review", repair: "in-progress",
      "human-gate": "blocked", done: "in-review", stale: "blocked", failed: "blocked", integrated: "done",
    };
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
      return {
        id: row.key,
        boardId: `F${row.key.split(".")[0]}`,
        title: row.title,
        ownerId: this.ownerFor(row.key),
        status: map[row.state] ?? "blocked",
        needs: [],
        prNumber: null,
        description: evidence.join("\n"),
        pf: {
          state: row.state, lifecycle: row.lifecycle, role: (row as { role?: string | null }).role ?? null, gate: gate ?? (row.gate && row.gate !== "—" ? row.gate : null),
          recorded: row.recordedState ?? (sf.State ? sf.State.split(/\s/)[0] : null),
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
        hub.setStatus(w.hqId, { state: "needs-input", note: `Asking: ${clip(this.stateFile(w.key).Gate ?? row.gate)}` });
      }
    }

    // Human gates → action items (Pathfinder's own gate text, verbatim).
    const open = new Set<string>();
    for (const row of this.rows.filter((r) => r.state === "human-gate")) {
      // Read the list fresh each time: an earlier gate in this loop may have just been added.
      const items = hub.snap.actionItems ?? [];
      const id = `gate-${row.key}`;
      open.add(id);
      const text = this.stateFile(row.key).Gate ?? row.gate;
      const existing = items.find((i) => i.id === id);
      if (existing && existing.status === "open" && existing.details.startsWith(text)) continue;
      const item: ActionItem = {
        id, fromId: this.ownerFor(row.key) ?? COORDINATOR_ID, taskId: row.key, title: `${row.key} needs your decision`,
        details: `${text}\n\nPathfinder human gate. "Done" with a note types your answer into the coordinator's session; Pathfinder records and resumes it.`,
        waiting: true, status: "open", note: null, at: new Date().toISOString(), closedAt: null,
      };
      hub.snap.actionItems = [item, ...items.filter((i) => i.id !== id)];
      hub.emit({ type: "action.updated", item });
      hub.activity("agent.needs-input", item.fromId, `${row.key} needs your decision: ${clip(text, 60)}`);
    }
    for (const item of hub.snap.actionItems ?? []) {
      if (item.id.startsWith("gate-") && item.status === "open" && !open.has(item.id)) {
        item.status = "done";
        item.closedAt = new Date().toISOString();
        hub.emit({ type: "action.updated", item });
      }
    }
  }

  /** The human answered a gate in the UI: hand the text to the coordinator, verbatim. */
  async answerGate(itemId: string, note: string) {
    const item = this.hub.snap.actionItems?.find((i) => i.id === itemId);
    if (!item) return;
    const key = item.taskId ?? itemId.replace(/^gate-/, "");
    const text = note.trim() ? `Human answer for the ${key} gate (from Tin & Thyme): ${note.trim()}` : `Human dismissed the ${key} gate in Tin & Thyme without an answer; leave it open.`;
    const ok = await this.sessions.typeInto(COORDINATOR_ID, text.replace(/\s+/g, " "));
    this.hub.activity("agent.answered", COORDINATOR_ID, ok ? `Your answer for ${key} went to the coordinator` : `Couldn't reach the coordinator's terminal for ${key}`);
    if (!ok) log.warn(`answerGate: coordinator terminal unavailable`);
  }
}
