// The Master Prompter in a Pathfinder kitchen (Feature 04, ticket 04.1).
//
// A Pathfinder kitchen's roster is the crew book (09.3), and nothing about it is kept in .jsmhq/. So the
// prompter reuses that book instead of a config row:
//
//   - added    = the `alien` character has a record that is not retired. Adding creates (or un-retires)
//                it through retireCharacter, the contract's own write path; removing retires it. A retired
//                character's record and history stay, as for every crew member, and an add is refused
//                while the alien is on the floor, so there is at most one prompter;
//   - session  = one Claude Code session the kitchen launches in the project, in tmux, like the
//                coordinator: `kind: "prompter"` in the book, so allocation hands it the alien (the
//                prompter family's only character, reserved for that kind) once per occurrence;
//   - roster   = one team row, PROMPTER_ID, while the alien is added or its session is still live.
//
// The kitchen writes nothing into the project for it: its hooks and role go in ~/.controlroom/<key>/, and its
// role is the coaching contract (src/data/prompter.ts). Pathfinder never dispatches it, so it never takes a ticket.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crewName, FAMILY_COLOR, PROMPTER_CHARACTER, type CrewSession } from "../src/data/crewContract";
import { PROMPTER_DISALLOWED_TOOLS, PROMPTER_ID, PROMPTER_PERMISSION_MODE, PROMPTER_ROLE, PROMPTER_ROLE_MD, PROMPTER_TITLE, prompterCrew } from "../src/data/prompter";
import type { AgentConfig } from "../src/data/types";
import type { CrewRegistry } from "./crew";
import { Hub } from "./hub";
import type { Sessions } from "./sessions";
import { newAgent } from "./store";

/** Hook events the prompter's session reports: a native agent's (agentFiles HOOK_EVENTS), which hooks.ts turns into its state. */
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];

export interface PrompterDeps {
  hub: Hub;
  sessions: Pick<Sessions, "startExternal" | "stop">;
  /** The project root: where the prompter's session runs and reads. */
  root: () => string;
  /** The kitchen state folder, ~/.controlroom/<key>. */
  stateDir: () => string;
  port: number;
  agentToken: string;
  /** The kitchen's crew book; null when it could not be opened. */
  crew: () => CrewRegistry | null;
  crewProblem: () => string | null;
  /** After a change: the roster, the observations, the file and the published snapshot. */
  changed: () => void;
}

/** The `--settings` file for the prompter's session: hook reporting, and Claude Code's editing tools denied. */
export function writePrompterSettings(dir: string, hookUrl: string, agentToken: string): string {
  mkdirSync(dir, { recursive: true });
  const post = (event: string) => ({
    type: "command",
    command: `curl -s -m 3 -X POST -H 'Authorization: Bearer ${agentToken}' -H 'Content-Type: application/json' --data-binary @- ${hookUrl}/${event} 2>/dev/null; exit 0`,
  });
  const hooks: Record<string, unknown[]> = {};
  for (const e of EVENTS) hooks[e] = [{ ...(e.endsWith("ToolUse") ? { matcher: "*" } : {}), hooks: [post(e)] }];
  const file = join(dir, "prompter-settings.json");
  writeFileSync(file, JSON.stringify({ hooks, permissions: { deny: [...PROMPTER_DISALLOWED_TOOLS] } }, null, 2));
  return file;
}

/**
 * The command the prompter's session runs: Claude Code with the coaching role and its editing tools denied.
 * Its permission mode is pinned to `manual`, so a user's global auto or bypass mode never lets it run a
 * command unasked: anything beyond reading (a Bash call included) waits for the human. Bash is not
 * removed, so this is not a read-only filesystem (ticket 04.3).
 */
export function prompterLaunchArgs(settings: string): string[] {
  return ["--settings", settings, "--append-system-prompt", PROMPTER_ROLE_MD, "--disallowedTools", PROMPTER_DISALLOWED_TOOLS.join(","), "--permission-mode", PROMPTER_PERMISSION_MODE];
}

export class PathfinderPrompter {
  /** The Claude conversation of the session this kitchen launched (or found running), for its crew record. */
  private conversation: string | null = null;

  constructor(private d: PrompterDeps) {}

  /** The alien is on the team: it has a record that is not retired. */
  present(crew = this.d.crew()): boolean {
    const rec = crew?.book.characters[PROMPTER_CHARACTER];
    return !!rec && !rec.retired;
  }

  /** The prompter session the book holds live now, if any. */
  private live(crew: CrewRegistry): CrewSession | null {
    return Object.values(crew.book.sessions).find((s) => s.kind === "prompter" && s.phase === "live") ?? null;
  }

  private running(): boolean {
    const st = this.d.hub.status(PROMPTER_ID)?.session.state;
    return st === "running" || st === "starting";
  }

  /** Settings → Team → "Add the Master Prompter". Returns the refusal, or null once it is added. */
  add(): string | null {
    const crew = this.d.crew();
    const hub = this.d.hub;
    const refuse = (why: string) => (hub.activity("config", null, why), why);
    if (!crew) return refuse(`The ${PROMPTER_TITLE} needs the crew book, which can't be opened: ${this.d.crewProblem() ?? "unknown reason"}`);
    if (this.present(crew)) return refuse(`The kitchen already has its ${PROMPTER_TITLE} (${crewName(PROMPTER_CHARACTER, crew.book.characters[PROMPTER_CHARACTER])}). There is at most one.`);
    const problem = crew.retire(PROMPTER_CHARACTER, false);
    if (problem) return refuse(problem);
    this.d.changed();
    hub.activity("config", null, `Added ${crewName(PROMPTER_CHARACTER, crew.book.characters[PROMPTER_CHARACTER])}, the ${PROMPTER_TITLE}. Press Start to launch their session.`);
    return null;
  }

  /** Removes it like any agent: its session stops, the alien is retired (its record and history are kept). */
  async remove(): Promise<void> {
    const crew = this.d.crew();
    if (!crew || !this.present(crew)) return;
    if (this.running()) await this.d.sessions.stop(PROMPTER_ID);
    crew.retire(PROMPTER_CHARACTER, true);
    this.d.changed();
    this.d.hub.activity("config", null, `Removed the ${PROMPTER_TITLE}. Its history is kept in the crew book.`);
  }

  /** Start: one Claude Code session in the project, in tmux, writing nothing into the project. */
  async start(): Promise<void> {
    const hub = this.d.hub;
    if (!this.present() || this.running()) return;
    const settings = writePrompterSettings(this.d.stateDir(), `http://127.0.0.1:${this.d.port}/hook/${PROMPTER_ID}`, this.d.agentToken);
    this.conversation = `${PROMPTER_ROLE}:${new Date().toISOString()}`;
    await this.d.sessions.startExternal(PROMPTER_ID, this.d.root(), { file: "claude", args: prompterLaunchArgs(settings), envFile: null });
    if (hub.status(PROMPTER_ID)?.session.state === "running") hub.setStatus(PROMPTER_ID, { state: "idle", note: "Ready to help write a prompt" });
    this.d.changed();
  }

  /** The team row: the alien under its current name, in the project root. */
  private row(crew: CrewRegistry): AgentConfig {
    const a = newAgent(PROMPTER_ID, crewName(PROMPTER_CHARACTER, crew.book.characters[PROMPTER_CHARACTER]), PROMPTER_TITLE, FAMILY_COLOR.prompter, false);
    a.mode = "local";
    a.workspacePath = this.d.root();
    a.roleMd = PROMPTER_ROLE_MD;
    a.crew = prompterCrew();
    return a;
  }

  /**
   * Keeps the roster row and the crew session in step with what is observed. The row follows the book
   * (also while the startup restore pass is open, so a running session is reattached); the session is
   * recorded only once the pass is closed, so nothing is allocated early.
   */
  sync(crew: CrewRegistry): void {
    const hub = this.d.hub;
    // The session first, so a stopped one has ended before the row is decided.
    const st = hub.status(PROMPTER_ID)?.session.state;
    if (!crew.book.restorePass) {
      const live = this.live(crew);
      if (st === "running" && !live) {
        // Found running after a restart: the same conversation goes on as a linked occurrence; else a new one.
        const last = Object.values(crew.book.sessions).filter((s) => s.kind === "prompter").sort((a, b) => b.seq - a.seq)[0] ?? null;
        const conversation = this.conversation ?? last?.conversation ?? `${PROMPTER_ROLE}:${new Date().toISOString()}`;
        this.conversation = conversation;
        if (crew.latest(conversation)) crew.resume(conversation, { via: "hook", evidence: null });
        else crew.start(conversation, { kind: "prompter", hqId: PROMPTER_ID, role: PROMPTER_ROLE, stage: "prompt", worktree: this.d.root() });
      } else if (live && st !== "running" && st !== "starting") crew.end(live.id, null);
    }
    const want = this.present(crew) || !!this.live(crew) || this.running();
    const team = hub.snap.config.team;
    const had = team.find((a) => a.id === PROMPTER_ID);
    if (want) {
      const next = this.row(crew);
      if (!had || JSON.stringify(had) !== JSON.stringify(next)) {
        // Right after the coordinator, whatever order the rows were in.
        const others = team.filter((a) => a.id !== PROMPTER_ID);
        const lead = others.findIndex((a) => a.isLead);
        hub.snap.config.team = [...others.slice(0, lead + 1), next, ...others.slice(lead + 1)];
        if (!hub.status(PROMPTER_ID)) hub.snap.agents.push(Hub.freshStatus(PROMPTER_ID));
        hub.configChanged();
      }
    } else if (had) {
      hub.snap.config.team = team.filter((a) => a.id !== PROMPTER_ID);
      hub.snap.agents = hub.snap.agents.filter((a) => a.agentId !== PROMPTER_ID);
      hub.emit({ type: "agent.removed", agentId: PROMPTER_ID });
      hub.configChanged();
    }
  }

  /** What the kitchen observes for its live session: its process and the state its hooks reported. */
  observe(crew: CrewRegistry, at: string): void {
    const live = this.live(crew);
    const st = this.d.hub.status(PROMPTER_ID);
    if (!live || !st) return;
    const asking = st.state === "needs-input" ? { kind: "needs-you" as const, reason: st.note ?? "needs you" } : null;
    crew.observe(live.id, { session: st.session.state, agent: st.state, tools: 1, attention: asking, at }, { context: st.context ?? null, model: st.telemetry ?? null, tokens: null, costUsd: null, tools: null, at });
  }

  /** Live prompter sessions confirmed running: the startup restore pass must not end them. */
  runningIds(crew: CrewRegistry): string[] {
    const live = this.live(crew);
    return live && this.d.hub.status(PROMPTER_ID)?.session.state === "running" ? [live.id] : [];
  }
}
