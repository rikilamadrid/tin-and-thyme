import type { DeliveryBoard } from "./delivery";
import type { CharacterId } from "./crew";
import type { StackConfig } from "./stack";
// Domain types shared by the data source, the store, the office and the HUD.

// ---------------------------------------------------------------- Config

/** sbx's machine-wide base network policy (`sbx policy init`). */
export type BasePolicy = "allow-all" | "balanced" | "deny-all" | "unknown";

/** Services sbx can inject keys for through its host proxy (the value never enters the VM). */
export const SERVICE_KEYS = ["anthropic", "openai", "github", "google", "groq", "mistral", "openrouter", "xai", "nebius", "copilot", "cursor", "devin", "droid"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** VM size. null = let sbx decide (all host CPUs; 50% of RAM, 0.5–32 GB). Set at creation only. */
export interface SandboxResources {
  cpus: number | null;
  memoryGb: number | null;
}

/** Per-agent sandbox settings HQ applies through sbx. Machine-wide ones live in SbxState. */
export interface SandboxSettings {
  resources: SandboxResources;
  allow: string[]; // extra allowed domains for this sandbox, e.g. "registry.npmjs.org"
  deny: string[]; // blocked domains for this sandbox (deny wins over allow)
}

export type AgentMode = "sandbox" | "local";

/** Which coding agent CLI runs in the sandbox. */
export type AgentCli = "claude" | "codex";

export const CLI_LABEL: Record<AgentCli, string> = { claude: "Claude Code", codex: "Codex" };

export interface AgentConfig {
  id: string; // "john"
  name: string; // "John"
  role: string; // "Lead" | "Developer" | "QA" | anything
  isLead: boolean;
  cli: AgentCli;
  model: string; // optional start model ("" = the CLI's default; users can switch with /model)
  mode: AgentMode;
  color: string; // hex, used for the robot, owner dots and chips
  skills: string[];
  roleMd: string; // contents of ROLE.md
  sandbox: SandboxSettings;
  workspacePath: string | null; // an existing folder to use; null = HQ-managed clone
  /** MCP servers (names in sbx's registry) this agent's sandbox gets. */
  mcp?: string[];
  /** The Pass: this session's robot character (assigned once, never changes) and its real workflow facts. */
  crew?: CrewInfo;
}

/** A visual alias (character, kitchen job) next to the real workflow role, session and ticket. */
export interface CrewInfo {
  character: CharacterId;
  /** Kitchen job shown under the name, e.g. "Saucier". */
  job: string;
  /** The real workflow role, e.g. "developer" (Pathfinder roles/<role>.md). */
  role: string;
  /** Pathfinder session kind: implementation | resume | repair | adversary | review; null for the coordinator. */
  session: string | null;
  ticket: string | null;
  worktree: string | null;
}

/** An MCP server registered with Docker Sandboxes (`sbx mcp ls`). */
export interface McpServer {
  name: string;
  transport: string; // "remote http" | "local stdio" | …
  status: string; // "ready" | "needs-auth" | …
  nextStep: string | null; // e.g. "sbx mcp auth arcjet"
}

export interface McpState {
  servers: McpServer[];
  /** Per agent: servers attached to its sandbox right now (sbx can't detach one; recreating the sandbox does). */
  attached: Record<string, string[]>;
  error: string | null;
  checkedAt: string;
}

export interface NewMcpServer {
  name: string;
  url?: string;
  /** Local stdio server: a program on this Mac. */
  command?: string;
  args?: string[];
  /** Optional API key: sent as "Authorization: Bearer <key>", stored by sbx (never by HQ). */
  apiKey?: string;
}

export type ReviewTool = "coderabbit" | "greptile" | "copilot" | "human" | "custom";
export type DeployTool = "instacloud" | "vercel" | "custom";

export interface WorkflowConfig {
  review: { enabled: boolean; tool: ReviewTool; command: string };
  merge: { by: "human" | "lead" };
  deploy: { enabled: boolean; tool: DeployTool; command: string; perAgentEnvironments: boolean };
}

export interface ProjectConfig {
  /** Fixed once created: names sandboxes, tmux sessions and ~/.jsmhq/<id>. Renaming the project never changes it. */
  id: string; // "askwell"
  name: string; // "Askwell"
  repo: string; // "jsmastery-pro/askwell"
  path: string; // "~/developer/askwell"
  hqPort: number; // port sandboxes use to reach HQ via host.docker.internal
  exportPlan?: boolean; // also write the plan to docs/plan.md
  officeName?: string; // the sign on the office wall; empty = "JSM HQ"
}

export interface HqConfig {
  project: ProjectConfig;
  team: AgentConfig[];
  workflow: WorkflowConfig;
  /** Optional: what the project is built with (plan 009). */
  stack?: StackConfig;
}

/** An agent asked to reach a domain its sandbox blocks (Team MCP `request_access`). */
export interface AccessRequest {
  id: string;
  agentId: string;
  domain: string;
  reason: string;
  at: string;
  status: "pending" | "allowed" | "denied";
}

export type AccessDecision = "agent" | "everyone" | "deny";

import type { TicketView } from "./ticketStage";

// ---------------------------------------------------------------- Live state

/** `waiting`: a workflow coordinator whose turn ended while workers it dispatched are still running (not asking you). */
export type AgentState = "idle" | "working" | "needs-input" | "waiting" | "in-review" | "review-passed";

/** The agent's process: its tmux session running `sbx run` (Sandbox) or `claude` (Local). */
export type SessionState = "stopped" | "starting" | "running" | "failed";

export interface SessionInfo {
  state: SessionState;
  detail: string | null; // why it failed, or what it is doing
  workspace: string | null; // absolute folder path on the host
  sandbox: { cpus: number; memoryGb: number } | null; // what the existing sandbox actually has
}

export interface AgentStatus {
  agentId: string;
  state: AgentState;
  currentTaskId: string | null;
  stateSince: string; // ISO time
  note: string | null; // e.g. "Asking: max PDF size 10 MB or 20 MB?"
  session: SessionInfo;
  /** Context window use read from the session's own transcript; absent/null when unavailable. */
  context?: { used: number; limit: number } | null;
  /**
   * Model and reasoning effort for this agent's own session. "observed" = read from its latest model
   * call in its transcript; "configured" = only what was requested for it (no call seen yet). Never another agent's values.
   */
  telemetry?: SessionTelemetry | null;
  /** Ticket keys of open gates this "needs input" is relaying (each is its own action item, so it isn't counted twice). */
  relaying?: string[] | null;
  /** A worker's own context crossed the project's alert threshold (advisory; once per crossing). */
  contextAlert?: { pct: number; threshold: number } | null;
  /** Whether Tin & Thyme can checkpoint this worker and start it fresh through Pathfinder, and why not. */
  fresh?: FreshReadiness | null;
  /**
   * How a workflow session ended, read from Pathfinder's own checkpoint when it stopped (absent while it runs).
   * handed-off = it recorded the next stage (or done); gate = it stopped for a human; failed = it reported failure;
   * interrupted = it stopped without recording any of those.
   */
  ended?: SessionEnd | null;
}

export interface SessionEnd {
  outcome: "handed-off" | "gate" | "failed" | "interrupted";
  /** The stage Pathfinder recorded next (adversary, review, repair, done, integrated), when handed off. */
  next: string | null;
  /** The session's last recorded result (Pathfinder `Last`), verbatim; or its own report's headline. */
  result: string | null;
  /** The verdict the session itself reported (DONE, PASS, FINDINGS, GATE, FAILED), when it reported one. */
  verdict?: "DONE" | "PASS" | "FINDINGS" | "GATE" | "FAILED" | null;
  at: string;
}

export interface FreshReadiness {
  can: boolean;
  reason: string;
  /** When Pathfinder itself lacks the control Tin & Thyme would need: the smallest change to it. */
  pathfinderChange?: string;
}

export type HandoffStepStatus = "pending" | "running" | "ok" | "failed";

/** One "Checkpoint & start fresh" for a ticket: three steps, each with what happened. */
export interface Handoff {
  key: string;
  /** The session it replaces (HQ agent id). */
  from: string;
  phase: "running" | "dispatched" | "started" | "failed" | "refused";
  steps: { pause: { status: HandoffStepStatus; detail: string }; save: { status: HandoffStepStatus; detail: string }; dispatch: { status: HandoffStepStatus; detail: string } };
  /** The local checkpoint (outside the project), once written. */
  checkpoint: string | null;
  /** Marks the one request typed to the coordinator, so a retry never sends a second. */
  dispatchId: string | null;
  retryable: boolean;
  at: string;
}

export interface SessionTelemetry {
  model: string | null;
  effort: string | null;
  source: "observed" | "configured";
}

export type BoardStatus = "active" | "planned" | "done";

export interface Board {
  id: string; // "P3"
  title: string; // "Phase 3 — Knowledge + chat"
  status: BoardStatus;
  order: number;
}

/** `reviewed`: review passed, ready to deliver (a workflow ticket waiting for its PR or merge). */
export type TaskStatus = "todo" | "in-progress" | "in-review" | "reviewed" | "done" | "blocked";

/** A reviewed ticket's delivery, from its delivery record (Feature 10): a PR is open, or it was merged. */
export type DeliveryStage = "pr-open" | "merged";

export interface Task {
  id: string; // "P3-T02"
  boardId: string;
  title: string;
  ownerId: string | null;
  status: TaskStatus;
  needs: string[]; // task IDs
  prNumber: number | null;
  description?: string; // what to build
  files?: string[]; // the only files this task may edit
  doneWhen?: string; // acceptance criteria
  note?: string | null; // e.g. why it's blocked
  /** The workflow's own words for this ticket (Pathfinder engine row), shown as is. */
  pf?: {
    state: string;
    lifecycle: string;
    role: string | null;
    gate: string | null;
    /** The state the claim's checkpoint records (e.g. "adversary" while the engine shows a pending stage as stale). */
    recorded?: string | null;
    /** Delivery input for a reviewed ticket (PR open, merged); null until a delivery record says so (Feature 10). */
    delivery?: DeliveryStage | null;
    /** What every surface shows for this ticket: label, column, next step, blocker (src/data/ticketStage.ts). */
    view?: TicketView;
  };
}

export type ReviewState = "pending" | "reviewing" | "changes-requested" | "passed";

export interface PullRequest {
  number: number;
  title: string; // "[P3-T02] Chat route"
  taskId: string;
  authorId: string;
  review: ReviewState;
  openComments: number;
  mergeable: boolean;
  merged: boolean;
  openedAt: string;
  url?: string; // link to GitHub
  branch?: string;
  closed?: boolean; // closed without merging — hidden from the board
  conflict?: boolean; // has merge conflicts with the base branch
  reviewNote?: string | null; // e.g. "CodeRabbit: review rate limited"
}

export type EnvironmentStatus = "live" | "deploying" | "sleeping";

export interface Environment {
  name: string; // "main" | agent id
  agentId: string | null;
  url: string;
  status: EnvironmentStatus;
  lastDeployAt: string;
}

/** The human at the keyboard, as a message sender. */
export const HUMAN_ID = "you";

/** One message carried by the Team MCP between two agents (or from you). */
export interface AgentMessage {
  id: string;
  at: string;
  fromId: string; // agent id, or HUMAN_ID
  toId: string;
  text: string;
  delivered?: "typed" | "on-stop" | "queued"; // how HQ handed it over
}

export type ActivityType =
  | "task.assigned"
  | "task.started"
  | "task.created"
  | "agent.needs-input"
  | "agent.answered"
  | "message"
  | "pr.opened"
  | "review.started"
  | "review.passed"
  | "review.changes"
  | "pr.merged"
  | "deploy"
  | "session"
  | "config";

export interface ActivityEvent {
  id: string;
  at: string;
  type: ActivityType;
  agentId: string | null;
  text: string;
}

/** What removing an agent would delete. Answer to `inspectWorkspace`. */
export interface WorkspaceInfo {
  agentId: string;
  path: string;
  managed: boolean; // HQ made this folder (only these can be deleted from HQ)
  exists: boolean;
  changedFiles: number; // uncommitted changes
  unpushedCommits: number; // commits on local branches that aren't on any remote
  sandboxName: string | null;
  sandboxExists: boolean;
}

export interface RemoveAgentOptions {
  deleteSandbox: boolean;
  deleteFolder: boolean;
}

// ---------------------------------------------------------------- Setup

export type SetupCheckId = "os" | "sbx" | "sbx-login" | "sbx-policy" | "tmux" | "gh" | "gh-remote" | "github-secret" | "claude" | "codex" | "openai-secret";
export type SetupStatus = "ok" | "missing" | "unsupported" | "warning";

export interface SetupFix {
  command: string; // shown with a Copy button
  runnable: boolean; // HQ may run it in a visible terminal ("Run in terminal")
  docs: string | null;
}

export interface SetupCheck {
  id: SetupCheckId;
  label: string;
  status: SetupStatus;
  detail: string; // version found, or what is wrong
  neededFor: "sandbox" | "local" | "all" | "github";
  fix: SetupFix | null;
}

/** A network rule in effect for a sandbox, as sbx reports it. */
export interface SbxRule {
  id: string;
  decision: "allow" | "deny";
  resources: string[];
  source: "hq" | "kit" | "org" | "cli"; // cli = added with the sbx CLI, outside HQ
}

export interface SbxAgentState {
  rules: SbxRule[]; // empty until the sandbox exists
  keys: string[]; // service keys scoped to this sandbox
  envFile: { path: string; exists: boolean };
  syncError: string | null;
  /** Requests the sandbox blocked, waiting in sbx's approval queue (`sbx policy approval ls`). */
  approvals: SbxApproval[];
  /** Sandbox ports reachable from this machine (`sbx ports`), e.g. for a CLI's sign-in callback. */
  ports?: SbxPort[];
}

/** Terminal id of the Terminal panel: your own shell on this machine, not in a sandbox. */
export const HOST_TERMINAL = "shell:@host";

export interface SbxPort {
  sandbox: number;
  host: number;
}

export interface SbxApproval {
  id: string; // sbx's approval id
  host: string; // "mcp.notion.com:443"
  /** sbx's title as is, e.g. "GET api.example.com:443/v1/data" (shown, so different requests can be told apart). */
  title?: string;
  detail: string;
  /** False when sbx's entry is narrower than host:port (e.g. one HTTP method and path). */
  hostWide?: boolean;
  /** "TCP" or "UDP" from sbx's detail. HQ's allow rules are TCP, so others are answered through sbx. */
  protocol?: string;
}

/** What sbx actually has on this machine (read back, not saved settings). */
export interface SbxState {
  basePolicy: BasePolicy;
  proxy: string | null;
  globalKeys: string[]; // service keys available to every sandbox
  agents: Record<string, SbxAgentState>;
  checkedAt: string;
}

export interface MachineInfo {
  cpus: number;
  memoryGb: number;
  /** False on Windows: agents run inside HQ and stop when it stops (no tmux). */
  persistentAgents?: boolean;
}

export interface SetupState {
  machine: MachineInfo;
  checks: SetupCheck[];
  sandboxReady: boolean; // every sandbox check passes
  localReady: boolean; // Local mode can run
  checkedAt: string;
}

export interface OfficeSnapshot {
  /** True until the first-run welcome is finished for this repo (real HQ only). */
  welcome?: boolean;
  setup: SetupState;
  sbx: SbxState;
  config: HqConfig;
  agents: AgentStatus[];
  boards: Board[];
  tasks: Task[];
  pullRequests: PullRequest[];
  environments: Environment[];
  messages: AgentMessage[]; // newest first, last 100
  activity: ActivityEvent[]; // newest first, last 50
  accessRequests?: AccessRequest[];
  mcp?: McpState;
  actionItems?: ActionItem[];
  /** Set when a workflow adapter owns the roster and the board. */
  workflow?: WorkflowInfo;
  /** In-app delivery (Feature 10): restored from here on every (re)connect. */
  delivery?: DeliveryBoard;
  /** Set only by a preview server (docs/delivery-bootstrap.md): the reviewed build it serves. */
  preview?: PreviewInfo;
}

/** A preview's build identity: delivery only, no agent sessions. */
export interface PreviewInfo {
  /** The commit the build was made from (40 hex). */
  sha: string;
  /** That commit's tree (40 hex). */
  tree: string;
  /** ISO time the build finished. */
  builtAt: string;
  /** The repository it serves: its folder name and kitchen key. */
  repo: string;
  repoKey: string;
}

export interface WorkflowInfo {
  kind: "pathfinder";
  mode: string;
  store: string;
  /** Configured roles (roles/*.md frontmatter). */
  roles: { name: string; description: string }[];
  /** Context alert threshold for this project, in percent of the window (advisory). */
  contextAlertPct?: number;
  /** Checkpoint & start fresh, by ticket. */
  handoffs?: Record<string, Handoff>;
  /**
   * Delegated helpers (subagents that aren't Pathfinder workers), grouped by the session that launched them.
   * Running ones work at the subagent stations; finished ones are that session's history.
   */
  helpers?: WorkflowHelper[];
  /** The coordinator's latest dispatch plan, as observed when it ran `orchestrate plan` (never computed here). */
  plan?: PlanSeen | null;
}

export interface WorkflowHelper {
  id: string;
  label: string;
  type: string;
  /** HQ id of the session that launched it (the coordinator unless a worker did). */
  parent?: string;
  finished?: boolean;
  /** Seen through its hooks, but which session it is can't be established yet: shown as unknown, never guessed. */
  unknown?: boolean;
}

export interface PlanSeen {
  at: string;
  outcome: string;
  /** Eligible tickets the plan would claim now, or defers to a later round. */
  dispatch: string[];
  deferred: { key: string; reason: string }[];
}

/** Something an agent needs the user to do outside its sandbox (Team MCP `ask_user`). */
export interface ActionItem {
  id: string;
  fromId: string; // agent id
  taskId: string | null;
  title: string;
  details: string; // steps; never secret values
  waiting: boolean; // the agent can't continue without it
  status: "open" | "done" | "dismissed";
  note: string | null; // the user's note when closing it
  at: string;
  closedAt: string | null;
  /** A workflow request (a Pathfinder human gate): whose it is, exactly, or why that can't be said. */
  request?: ActionRequest | null;
  /** The human's answer to `request`, and how far it got. */
  answer?: ActionAnswer | null;
  /** Snoozed until then: hidden from "Needs you", nothing sent, nothing resolved. */
  snoozedUntil?: string | null;
}

export interface ActionRequest {
  kind: "gate";
  /** The ticket the gate is on (from the engine and the ticket's state file). */
  key: string;
  /** The stage it was raised in (Pathfinder's `Gate stage`, else the raising session's). */
  stage: string | null;
  /** HQ id of the session that raised it; null when that can't be established. */
  owner: string | null;
  /** That session's kind (implementation, review, …). */
  session: string | null;
  /** Why the session can't be identified (shown as "Unable to identify session"); null when it can. */
  diagnostic: string | null;
  /**
   * The gate occurrence this request is, from Pathfinder's own record (the state file's `Gate-Id`). The same
   * question opened again is a different occurrence, so a different request. Null when the record gives the
   * gate no occurrence: then it has no identity, and its session is never identified.
   */
  occurrence: string | null;
  /** Names this request: the occurrence when there is one, else the ticket and the exact text. An answer to any other revision is rejected. */
  revision: string;
}

export interface ActionAnswer {
  /**
   * sending → delivered (typed into the coordinator's session) → recorded (Pathfinder shows the gate resolved);
   * failed: it never reached the coordinator; rejected: not sent (an empty or superseded answer).
   */
  state: "sending" | "delivered" | "recorded" | "failed" | "rejected";
  text: string;
  /** The request revision it answers (so, for a gate with an occurrence, that occurrence). */
  revision: string;
  at: string;
  detail: string | null;
}

// ---------------------------------------------------------------- Inputs

export interface NewAgentInput {
  name: string;
  role: string;
  cli?: AgentCli;
  model?: string;
  mode: AgentMode;
}

/** First-run choices from the welcome screen. */
export interface WelcomeInput {
  projectName: string;
  lead: { name: string; cli: AgentCli };
  workers: { name: string; role: string; cli: AgentCli }[];
  reviewTool: ReviewTool;
  reviewEnabled: boolean;
  /** Optional: what the project is built with. */
  stack?: StackConfig;
}

export type AgentPatch = Partial<
  Pick<AgentConfig, "name" | "role" | "cli" | "model" | "mode" | "color" | "skills" | "roleMd" | "workspacePath">
>;

export interface WorkflowPatch {
  review?: Partial<WorkflowConfig["review"]>;
  merge?: Partial<WorkflowConfig["merge"]>;
  deploy?: Partial<WorkflowConfig["deploy"]>;
}
