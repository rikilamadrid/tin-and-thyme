// Which session is which: worker-to-ticket attribution for the coordinator's subagents.
//
// Every subagent of the coordinator's session tree is identified once, from exact evidence only:
//
//   - the Agent tool's own result (PostToolUse: `tool_use_id`, `tool_response.agentId`, and the prompt);
//   - the subagent's meta.json (`toolUseId`, the launching Agent call) matched to that call's PreToolUse;
//   - the subagent's own transcript, whose first prompt is the brief it was given.
//
// Claude Code's SubagentStart hook carries only `agent_id` and `agent_type` (no prompt, no tool_use_id), so a
// start that arrives before any of that evidence stays unknown until it appears. Nothing is ever matched by
// queue position, name or role: a launch is consumed exactly once, by the one subagent its tool_use_id or
// prompt names, and an attribution that can't be established stays unknown.

/** One Agent tool call seen at PreToolUse, waiting for the subagent it starts. */
export interface Launch {
  toolUseId: string;
  /** HQ id of who launched it: the coordinator, or a worker. */
  parent: string;
  prompt: string;
  label: string;
  type: string;
  at: number;
}

export type Identity =
  | { kind: "worker"; prompt: string; source: Source }
  | { kind: "helper"; parent: string | null; label: string; type: string; source: Source };

export type Source = "tool-result" | "meta" | "transcript";

/** What is known about one subagent from its own files (each field null while it doesn't exist yet). */
export interface Evidence {
  toolUseId: string | null;
  prompt: string | null;
  /** HQ id of the session that launched it, when its meta.json names a known parent subagent. */
  parent: string | null;
  description: string;
  agentType: string;
}

/** Launches older than this with no subagent are dropped (a failed or cancelled Agent call). */
const LAUNCH_TTL_MS = 6 * 60 * 60 * 1000;

export class Attribution {
  private launches = new Map<string, Launch>();
  /** tool_use_ids already bound to a subagent: a launch is consumed exactly once. */
  private consumed = new Map<string, string>();
  private identities = new Map<string, Identity>();

  constructor(private isBrief: (prompt: string) => boolean) {}

  /** PreToolUse(Agent): remember the call by its tool_use_id. Without one there is nothing exact to match. */
  launch(toolUseId: unknown, input: Record<string, unknown>, parent: string, now = Date.now()) {
    if (typeof toolUseId !== "string" || !toolUseId || this.consumed.has(toolUseId)) return;
    for (const [id, l] of this.launches) if (now - l.at > LAUNCH_TTL_MS) this.launches.delete(id);
    const prompt = String(input.prompt ?? "");
    this.launches.set(toolUseId, {
      toolUseId,
      parent,
      prompt,
      label: String(input.description ?? prompt.split("\n")[0]).slice(0, 80) || "Subagent",
      type: String(input.subagent_type ?? "subagent"),
      at: now,
    });
  }

  /** The identity already established for this subagent, if any. */
  known(agentId: string): Identity | null {
    return this.identities.get(agentId) ?? null;
  }

  /**
   * PostToolUse(Agent): the tool's own result names the subagent and its prompt. Exact; consumes the launch.
   * `parent` is who made the call (the hook's own session), used when no PreToolUse was seen.
   */
  bind(toolUseId: unknown, agentId: string, prompt: string, parent: string): Identity {
    const prior = this.identities.get(agentId);
    if (prior) {
      this.consume(toolUseId, agentId);
      return prior;
    }
    const launch = typeof toolUseId === "string" ? this.launches.get(toolUseId) : undefined;
    this.consume(toolUseId, agentId);
    const text = prompt || launch?.prompt || "";
    const identity: Identity = this.isBrief(text)
      ? { kind: "worker", prompt: text, source: "tool-result" }
      : { kind: "helper", parent: launch?.parent ?? parent, label: launch?.label ?? (text.split("\n")[0].slice(0, 80) || "Subagent"), type: launch?.type ?? "subagent", source: "tool-result" };
    this.identities.set(agentId, identity);
    return identity;
  }

  /**
   * Identify a subagent from its own evidence (SubagentStart, any later hook, or the transcript poll).
   * Returns null when nothing exact is known yet: the caller shows it as unknown and asks again later.
   */
  identify(agentId: string, ev: Evidence): Identity | null {
    const prior = this.identities.get(agentId);
    if (prior) return prior;
    let identity: Identity | null = null;
    const launch = ev.toolUseId ? this.launches.get(ev.toolUseId) : undefined;
    const boundElsewhere = ev.toolUseId ? this.consumed.get(ev.toolUseId) : undefined;
    if (boundElsewhere && boundElsewhere !== agentId) return null; // one launch, one subagent: never a second
    if (launch) {
      // Its own prompt wins over the launch's copy (they are the same text when both exist).
      const prompt = ev.prompt ?? launch.prompt;
      identity = this.isBrief(prompt)
        ? { kind: "worker", prompt, source: "meta" }
        : { kind: "helper", parent: launch.parent, label: ev.description || launch.label, type: ev.agentType || launch.type, source: "meta" };
      this.consume(ev.toolUseId, agentId);
    } else if (ev.prompt !== null) {
      identity = this.isBrief(ev.prompt)
        ? { kind: "worker", prompt: ev.prompt, source: "transcript" }
        : { kind: "helper", parent: ev.parent, label: ev.description || ev.prompt.split("\n")[0].slice(0, 80) || "Subagent", type: ev.agentType || "subagent", source: "transcript" };
      if (ev.toolUseId) this.consume(ev.toolUseId, agentId);
    }
    if (identity) this.identities.set(agentId, identity);
    return identity;
  }

  /** Launches still waiting for their subagent (for tests and diagnostics). */
  pending(): Launch[] {
    return [...this.launches.values()];
  }

  private consume(toolUseId: unknown, agentId: string) {
    if (typeof toolUseId !== "string" || !toolUseId) return;
    this.launches.delete(toolUseId);
    if (!this.consumed.has(toolUseId)) this.consumed.set(toolUseId, agentId);
  }
}

// ---------------------------------------------------------------- a session's own report

export type Verdict = "DONE" | "PASS" | "FINDINGS" | "GATE" | "FAILED";

/**
 * The verdict a Pathfinder session reported, and its headline. Null when the report states none.
 *
 * An explicit `VERDICT: …` line wins (a review may quote the developer's `DONE:` or say "GATE: none raised"
 * before it). Otherwise the LAST report line (`DONE: …`, `GATE: …`, `FAILED: …`) is the session's own
 * ending; a `**Result: FINDINGS.**` headline counts only when there is neither.
 */
export function readReport(report: string | null | undefined): { verdict: Verdict; text: string } | null {
  if (!report) return null;
  const strip = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const firstLine = () => report.split("\n").map(strip).find((l) => l && !/^#/.test(l)) ?? "";
  const verdict = /^[\s>#*_-]*VERDICT\s*:\s*\**\s*(DONE|PASS|FINDINGS|GATE|FAILED)\b/im.exec(report);
  if (verdict) return { verdict: verdict[1].toUpperCase() as Verdict, text: firstLine() };
  const lead = [...report.matchAll(/^[\s>*_]*(DONE|PASS|FINDINGS|GATE|FAILED)\s*:\s*(.*)$/gm)].at(-1);
  if (lead) return { verdict: lead[1] as Verdict, text: strip(lead[2]) || strip(lead[0]) };
  const result = /\bResult\s*:\s*\**\s*(DONE|PASS|FINDINGS|GATE|FAILED)\b/.exec(report);
  if (!result) return null;
  return { verdict: result[1].toUpperCase() as Verdict, text: firstLine() };
}
