// Claude Code session transcripts, read only.
//
// The coordinator's transcript and its subagents' transcripts are the durable
// record of a run: each worker's brief (first prompt), whether it finished
// (meta.json), and the token usage of its latest model call (context in use).
// Tin & Thyme reads them so a restart rebuilds the same roster, and so the
// roster can show real context usage. Nothing here writes.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** ~/.claude/projects/<cwd with every non-alphanumeric character as "-"> */
export function transcriptDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function head(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, any>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, any> => x !== null);

export interface ContextUse {
  used: number;
  limit: number;
}

/** What one session's own transcript says about its latest model call. */
export interface SessionUse {
  context: ContextUse | null;
  /** Model id the latest call ran on (message.model). */
  model: string | null;
  /** Reasoning effort of the latest call (perTurnEffort, else effort). */
  effort: string | null;
}

/**
 * Reads the latest assistant record of this session (the main thread, or a subagent with
 * `sidechain`). Context in use = the input side of that call (fresh + cache read + cache write);
 * the window is 200k tokens unless the model id says 1M or usage already exceeds 200k.
 */
export function sessionUse(file: string, sidechain?: boolean): SessionUse {
  const none = { context: null, model: null, effort: null };
  if (!existsSync(file)) return none;
  const recs = lines(tail(file, 512 * 1024));
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.type !== "assistant" || !r.message) continue;
    if (sidechain !== undefined && !!r.isSidechain !== sidechain) continue;
    const model = typeof r.message.model === "string" && r.message.model !== "<synthetic>" ? r.message.model : null;
    const effort = typeof r.perTurnEffort === "string" ? r.perTurnEffort : typeof r.effort === "string" ? r.effort : null;
    const u = r.message.usage;
    const used = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0;
    if (!used && !model) continue;
    const limit = /\[1m\]|-1m\b/i.test(model ?? "") || used > 200_000 ? 1_000_000 : 200_000;
    return { context: used ? { used, limit } : null, model, effort };
  }
  return none;
}

export function contextUse(file: string, sidechain?: boolean): ContextUse | null {
  return sessionUse(file, sidechain).context;
}

/** The model Claude Code picked when it launched a subagent (its meta.json), before any call ran. */
export function subagentPickedModel(transcript: string): string | null {
  try {
    const m = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8")).pickedEffortModel;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}

/** True when the main thread's last word was the model ending its turn: it waits for the human. */
export function awaitingHuman(file: string): boolean {
  if (!existsSync(file)) return false;
  const recs = lines(tail(file, 256 * 1024)).filter((r) => (r.type === "assistant" || r.type === "user") && !r.isSidechain);
  const last = recs.at(-1);
  if (!last || last.type !== "assistant") return false;
  return last.message?.stop_reason === "end_turn";
}

/** Text of the first user message (a slash command's args are inside it). */
export function firstPrompt(file: string): string {
  try {
    for (const r of lines(head(file, 256 * 1024))) {
      if (r.type !== "user") continue;
      const c = r.message?.content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? "").join("\n") : "";
    }
  } catch {
    /* unreadable */
  }
  return "";
}

export function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function transcriptRevision(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${createHash("sha256").update(tail(file, 16 * 1024)).digest("hex")}`;
  } catch { return ""; }
}

function firstTimestamp(file: string): string {
  try {
    for (const r of lines(head(file, 64 * 1024))) if (r.timestamp) return String(r.timestamp);
  } catch {
    /* unreadable */
  }
  return "";
}

export interface SubagentRecord {
  agentId: string;
  file: string;
  prompt: string;
  finished: boolean;
  startedAt: string;
  /** From the subagent's meta.json: what it was launched to do, and its agent type. */
  description: string;
  agentType: string;
  /** From meta.json: the Agent tool call that launched it (the same `tool_use_id` its launcher's hooks carry). */
  toolUseId: string | null;
  /** From meta.json: the subagent that launched it, when a subagent did (absent for the coordinator's own). */
  parentAgentId: string | null;
  /** When meta.json last changed (ms), 0 without one: a resumed session's earlier `finished` predates its resume. */
  metaUpdatedAt: number;
  /** A changed file is evidence of activity only after this kitchen has observed an earlier version. */
  revision: string;
  transcriptEnded: boolean;
}

/** Explicit completion in the latest turn, even when no Stop hook or finished metadata was written. */
export function subagentEnded(file: string): boolean {
  try {
    for (const r of lines(tail(file, 512 * 1024)).reverse()) {
      if (r.type === "api-request") return false;
      if (r.type === "user") {
        const c = r.message?.content;
        if (typeof c === "string" || (Array.isArray(c) && c.some((p: any) => p.type !== "tool_result"))) return false;
      }
      if (r.type !== "assistant") continue;
      return r.message?.stop_reason === "end_turn" || r.isApiErrorMessage === true ||
        (Array.isArray(r.message?.content) && r.message.content.some((p: any) => p.type === "tool_use" && p.name === "SubagentHandback"));
    }
  } catch { /* unreadable evidence cannot establish an ending */ }
  return false;
}

/** What Claude Code records next to a subagent's transcript (`agent-<id>.meta.json`); null until it exists. */
export interface SubagentMeta {
  finished: boolean;
  description: string;
  agentType: string;
  toolUseId: string | null;
  parentAgentId: string | null;
}

export function subagentMeta(transcript: string): SubagentMeta | null {
  try {
    const meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      finished: meta.finished === true,
      description: str(meta.description),
      agentType: str(meta.agentType),
      toolUseId: str(meta.toolUseId) || null,
      parentAgentId: str(meta.parentAgentId) || null,
    };
  } catch {
    return null;
  }
}

/** The first prompt of a subagent's own transcript, or null while the file doesn't exist yet. */
export function subagentPrompt(transcript: string): string | null {
  if (!existsSync(transcript)) return null;
  const p = firstPrompt(transcript);
  return p || null;
}

/**
 * The report a subagent finished with, from its own transcript: its last SubagentHandback message, else the
 * text of its last assistant message. Null when there is none (or the transcript can't be read).
 */
export function subagentReport(transcript: string): string | null {
  if (!existsSync(transcript)) return null;
  let recs: Record<string, any>[];
  try {
    recs = lines(tail(transcript, 512 * 1024));
  } catch {
    return null;
  }
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
    for (const p of r.message.content) {
      if (p?.type === "tool_use" && p.name === "SubagentHandback" && typeof p.input?.message === "string") return p.input.message;
    }
    const text = r.message.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n").trim();
    if (text) return text;
  }
  return null;
}

/** Background subagents of one session, oldest first. */
export function subagents(sessionFile: string): SubagentRecord[] {
  const dir = join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out: SubagentRecord[] = [];
  for (const f of names) {
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const file = join(dir, f);
    // No meta yet: still starting.
    const meta = subagentMeta(file);
    out.push({
      agentId, file, prompt: firstPrompt(file), finished: meta?.finished ?? false, startedAt: firstTimestamp(file),
      description: meta?.description ?? "", agentType: meta?.agentType ?? "", toolUseId: meta?.toolUseId ?? null, parentAgentId: meta?.parentAgentId ?? null,
      metaUpdatedAt: meta ? mtime(join(dir, `agent-${agentId}.meta.json`)) : 0,
      revision: transcriptRevision(file), transcriptEnded: subagentEnded(file),
    });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The newest main-session transcript in `cwd` whose first prompt passes `match`. */
export function findSession(cwd: string, match: (firstPrompt: string) => boolean): string | null {
  const dir = transcriptDir(cwd);
  let files: { f: string; m: number }[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {
    return null;
  }
  for (const { f } of files.slice(0, 40)) if (match(firstPrompt(f).replace(/\s+/g, " "))) return f;
  return null;
}
