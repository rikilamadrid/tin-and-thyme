// Tin & Thyme · "Checkpoint & start fresh" for a Pathfinder worker.
//
// Gives a worker's ticket a fresh context window without losing its place, using only
// controls Pathfinder supports today:
//
//   1. Safe pause   — the old session must already have stopped. Pathfinder has no way to ask
//                     a *running* worker to stop at a checkpoint, so a live worker is left alone
//                     and the drawer names the smallest Pathfinder change that would allow it.
//   2. Save+verify  — a local checkpoint (outside the project) with the ticket, role, branch,
//                     worktree, uncommitted changes, evidence, open decisions and the exact next
//                     step, checked against `orchestrate owner` and git. Nothing in the worktree
//                     is touched; the old transcript stays where it is.
//   3. Dispatch     — `/orchestrate resume <key>` typed to the coordinator, which runs Pathfinder's
//                     own resume (status --live, stage --advance, brief --session resume). Resume
//                     refuses gated claims and live work, so stage, approvals and gates are kept and
//                     only one worker can write to the worktree. One marked request per handoff:
//                     a retry checks the coordinator's transcript first and never sends a second.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { FreshReadiness, Handoff } from "../src/data/types";

export interface HandoffWorker {
  hqId: string;
  name: string;
  key: string;
  role: string;
  session: string;
  worktree: string | null;
  live: boolean;
  transcript: string | null;
  agentId: string;
}

export interface HandoffRow {
  key: string;
  state: string;
  title: string;
  gate: string;
}

/** What the handoff needs from the Pathfinder adapter. */
export interface HandoffHost {
  root: string;
  engine: string;
  stateDir: string;
  workers(): HandoffWorker[];
  row(key: string): HandoffRow | undefined;
  coordinator(): { running: boolean; state: string; transcript: string | null };
  typeToCoordinator(text: string): Promise<boolean>;
  openDecisions(key: string): string[];
  publish(handoffs: Record<string, Handoff>): void;
  activity(text: string, agentId: string | null): void;
}

/** The smallest Pathfinder change that would let Tin & Thyme pause a running worker safely. */
export const PAUSE_CHANGE =
  "Add `orchestrate pause <key> --request | --status` (records `Pause: requested` / `Pause: acknowledged` in the claim's current-ticket.md through the existing checkpoint writer), " +
  "and one step to worker-brief.md and resume-brief.md: after each tool call, if a pause is requested, record Last and Next with `orchestrate state`, mark the pause acknowledged, report `PAUSED: <key>` and end the session. " +
  "start.md then treats PAUSED like any stopped session, so `/orchestrate resume <key>` can start the fresh one.";

interface Owner {
  worktree: string;
  branch: string;
  state: string;
  gate: string | null;
  next: string | null;
}

const run = (cmd: string, args: string[], cwd: string) =>
  new Promise<{ ok: boolean; out: string; err: string }>((done) =>
    execFile(cmd, args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => done({ ok: !e, out: String(out ?? ""), err: String(err ?? (e ? e.message : "")) })),
  );

const now = () => new Date().toISOString();

export class Handoffs {
  private state = new Map<string, Handoff>();
  private busy = new Set<string>();

  constructor(private host: HandoffHost) {}

  all(): Record<string, Handoff> {
    return Object.fromEntries(this.state);
  }

  /** Whether this session can be checkpointed and restarted through Pathfinder, and why not. */
  readiness(w: HandoffWorker): FreshReadiness {
    const row = this.host.row(w.key);
    if (!row) return { can: false, reason: `Pathfinder shows no claim for ${w.key}, so there is nothing to resume.` };
    const newer = this.host.workers().filter((x) => x.key === w.key);
    if (newer.at(-1)?.hqId !== w.hqId) return { can: false, reason: `A newer session owns ${w.key}. Use that session's drawer.` };
    const h = this.state.get(w.key);
    if (h && (h.phase === "running" || h.phase === "dispatched")) return { can: false, reason: "A handoff for this ticket is already in progress." };
    if (row.state === "human-gate")
      return { can: false, reason: `${w.key} is waiting at a human gate: “${row.gate || "decision pending"}”. Pathfinder will not resume a gated claim, so answer it in Action items first. The gate is left as it is.` };
    if (row.state === "done" || row.state === "integrated") return { can: false, reason: `${w.key} is ${row.state}: there is no open work for a fresh session to continue.` };
    if (row.state === "failed") return { can: false, reason: `${w.key} failed. Pathfinder resumes a failed claim only with your guidance in the coordinator (\`/orchestrate resume ${w.key}\`).` };
    if (w.live)
      return {
        can: false,
        reason:
          "This session is still running. Pathfinder has no supported way to ask a running worker to finish its tool call and stop at a checkpoint, so Tin & Thyme won't interrupt it. It stays as it is; when it stops, this button becomes available.",
        pathfinderChange: PAUSE_CHANGE,
      };
    return { can: true, reason: `The session has stopped. Tin & Thyme saves a checkpoint, verifies it, then asks Pathfinder to resume ${w.key} in a fresh session.` };
  }

  private set(key: string, h: Handoff) {
    this.state.set(key, h);
    this.host.publish(this.all());
  }

  private step(key: string, name: keyof Handoff["steps"], status: Handoff["steps"]["pause"]["status"], detail: string, patch: Partial<Handoff> = {}) {
    const h = this.state.get(key);
    if (!h) return;
    this.set(key, { ...h, ...patch, steps: { ...h.steps, [name]: { status, detail } } });
  }

  /** Called when a worker session for this ticket starts: a dispatched handoff has landed. */
  onWorkerStarted(key: string, hqId: string) {
    const h = this.state.get(key);
    if (h?.phase !== "dispatched") return;
    this.step(key, "dispatch", "ok", `Pathfinder started the fresh session (${hqId}). It verifies the claim and worktree and reports before editing.`, { phase: "started" });
    this.host.activity(`${key}: fresh session started from the checkpoint`, hqId);
  }

  async start(hqId: string) {
    const w = this.host.workers().find((x) => x.hqId === hqId);
    if (!w || this.busy.has(w.key)) return;
    const ready = this.readiness(w);
    const base: Handoff = {
      key: w.key,
      from: hqId,
      phase: "running",
      steps: { pause: { status: "running", detail: "Checking the session has stopped…" }, save: { status: "pending", detail: "" }, dispatch: { status: "pending", detail: "" } },
      checkpoint: null,
      dispatchId: null,
      retryable: false,
      at: now(),
    };
    if (!ready.can) {
      this.set(w.key, { ...base, phase: "refused", steps: { ...base.steps, pause: { status: "failed", detail: ready.reason } } });
      return;
    }
    this.busy.add(w.key);
    this.set(w.key, base);
    try {
      // 1. Safe pause: the old session has stopped (no live session, and its transcript says finished).
      const finished = this.finished(w);
      if (w.live || finished === false) {
        this.step(w.key, "pause", "failed", "The session still looks active, so it was left untouched. Nothing was saved or dispatched.", { phase: "refused" });
        return;
      }
      this.step(w.key, "pause", "ok", `Session ${w.agentId} has stopped: no tool call is in flight. Its transcript stays for reference${w.transcript ? ` (${w.transcript})` : ""}.`);
      // 2. Save and verify the checkpoint.
      if (!(await this.save(w))) return;
      // 3. Dispatch through Pathfinder.
      await this.dispatch(w.key);
    } finally {
      this.busy.delete(w.key);
    }
  }

  /** Retry a failed handoff from the step that failed. Never sends a second dispatch for the same request. */
  async retry(key: string) {
    const h = this.state.get(key);
    if (!h || h.phase !== "failed" || !h.retryable || this.busy.has(key)) return;
    const w = this.host.workers().find((x) => x.hqId === h.from);
    this.busy.add(key);
    try {
      if (h.steps.save.status !== "ok") {
        if (!w) return;
        this.set(key, { ...h, phase: "running" });
        if (!(await this.save(w))) return;
      }
      await this.dispatch(key);
    } finally {
      this.busy.delete(key);
    }
  }

  private finished(w: HandoffWorker): boolean | null {
    if (!w.transcript) return null;
    try {
      return JSON.parse(readFileSync(w.transcript.replace(/\.jsonl$/, ".meta.json"), "utf8")).finished === true;
    } catch {
      return null;
    }
  }

  private async owner(key: string): Promise<Owner | null> {
    const r = await run("node", [this.host.engine, "owner", key, "--json"], this.host.root);
    try {
      const c = JSON.parse(r.out).claim;
      return c ? { worktree: c.worktree, branch: c.branch, state: c.state, gate: c.gate ?? null, next: c.next ?? null } : null;
    } catch {
      return null;
    }
  }

  private async git(wt: string) {
    const g = (...a: string[]) => run("git", ["-C", wt, ...a], wt);
    const [branch, head, porcelain, stat, diff, log] = await Promise.all([
      g("rev-parse", "--abbrev-ref", "HEAD"),
      g("rev-parse", "HEAD"),
      g("status", "--porcelain=v1", "--untracked-files=all"),
      g("diff", "--stat", "HEAD"),
      g("diff", "HEAD"),
      g("log", "--oneline", "-8"),
    ]);
    if (!branch.ok || !head.ok) return null;
    const fingerprint = createHash("sha256").update(porcelain.out).update("\0").update(diff.out).digest("hex").slice(0, 16);
    return { branch: branch.out.trim(), head: head.out.trim(), porcelain: porcelain.out.trimEnd(), stat: stat.out.trimEnd(), log: log.out.trimEnd(), fingerprint };
  }

  private fingerprints = new Map<string, { file: string; fingerprint: string; branch: string; worktree: string }>();

  private async save(w: HandoffWorker): Promise<boolean> {
    const key = w.key;
    const fail = (detail: string, retryable = true) => {
      this.step(key, "save", "failed", `${detail} Nothing was dispatched; the session and worktree are unchanged.`, { phase: "failed", retryable });
      return false;
    };
    this.step(key, "save", "running", "Reading the claim, worktree and git state…");
    const owner = await this.owner(key);
    if (!owner) return fail(`\`orchestrate owner ${key}\` returned no claim.`);
    if (owner.state === "human-gate") return fail(`${key} reached a human gate meanwhile; Pathfinder won't resume it until the gate is answered.`, false);
    const wt = isAbsolute(owner.worktree) ? owner.worktree : join(this.host.root, owner.worktree);
    if (!existsSync(wt)) return fail(`The claimed worktree ${owner.worktree} doesn't exist.`);
    if (w.worktree && resolve(this.host.root, w.worktree) !== resolve(wt)) return fail(`The session worked in ${w.worktree}, but the claim names ${owner.worktree}.`, false);
    const git = await this.git(wt);
    if (!git) return fail(`git can't read ${owner.worktree}.`);
    if (git.branch !== owner.branch) return fail(`The worktree is on ${git.branch}, but the claim's branch is ${owner.branch}.`, false);
    const ticketFile = join(wt, "context", "current-ticket.md");
    const ticket = existsSync(ticketFile) ? readFileSync(ticketFile, "utf8") : "";
    if (!new RegExp(`^- Ticket: ${key.replace(".", "\\.")}\\b`, "m").test(ticket)) return fail(`The worktree's context/current-ticket.md is not ${key}'s.`, false);
    const line = (name: string) => new RegExp(`^- ${name}:\\s*(.+)$`, "m").exec(ticket)?.[1].trim() ?? null;
    const evidence = sections(ticket, /verification|evidence|tests?|dispatches|findings/i);
    const decisions = [owner.gate ? `Human gate: ${owner.gate}` : null, ...this.host.openDecisions(key)].filter(Boolean) as string[];
    const row = this.host.row(key);
    const changes = git.porcelain ? git.porcelain.split("\n").length : 0;
    const text = [
      `# Tin & Thyme checkpoint · ${key}`,
      "",
      `- Ticket: ${key} — ${row?.title ?? ""}`,
      `- Role: ${w.role} (${w.session} session, replacing ${w.name} / ${w.agentId})`,
      `- Pathfinder state: ${owner.state}`,
      `- Branch: ${owner.branch}`,
      `- Worktree: ${owner.worktree}`,
      `- Head: ${git.head}`,
      `- Uncommitted changes: ${changes ? `${changes} path(s), kept as they are in the worktree` : "none"} (fingerprint ${git.fingerprint})`,
      `- Old transcript (kept for reference): ${w.transcript ?? "not found"}`,
      `- Saved: ${now()}`,
      "",
      "## Exact next step",
      "",
      owner.next ?? line("Next") ?? "Not recorded in the claim: read context/current-ticket.md and the branch's commits.",
      "",
      "## Last recorded",
      "",
      line("Last") ?? "Not recorded.",
      "",
      "## Current changes",
      "",
      "```",
      git.porcelain || "(clean)",
      git.stat ? `\n${git.stat}` : "",
      "```",
      "",
      "## Recent commits",
      "",
      "```",
      git.log,
      "```",
      "",
      "## Tests and evidence (from context/current-ticket.md)",
      "",
      evidence || "None recorded in the claim yet.",
      "",
      "## Outstanding decisions",
      "",
      decisions.length ? decisions.map((d) => `- ${d}`).join("\n") : "None.",
      "",
      "## Before editing, the fresh session must",
      "",
      `1. Run \`orchestrate owner ${key}\` and confirm the claim, worktree and branch match the lines above.`,
      "2. Check `git status` in the worktree matches “Current changes” (uncommitted edits are expected and must be kept).",
      "3. Report what is done, what remains unverified, and what it will do next, before any edit.",
      "",
    ].join("\n");
    const dir = join(this.host.stateDir, "handoffs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}-${now().replace(/[:.]/g, "-")}.md`);
    writeFileSync(file, text);
    chmodSync(file, 0o600);
    // Verify what was written, and that the worktree didn't move while writing.
    const back = readFileSync(file, "utf8");
    const again = await this.git(wt);
    if (!back.includes(`- Branch: ${owner.branch}`) || !back.includes(`- Worktree: ${owner.worktree}`)) return fail("The checkpoint didn't read back as written.");
    if (!again || again.fingerprint !== git.fingerprint || again.head !== git.head) return fail("The worktree changed while the checkpoint was written; run it again when nothing is editing it.");
    this.fingerprints.set(key, { file, fingerprint: git.fingerprint, branch: owner.branch, worktree: wt });
    this.step(key, "save", "ok", `Checkpoint saved and verified against the claim and worktree (${changes ? `${changes} uncommitted path(s) preserved` : "clean worktree"}, head ${git.head.slice(0, 7)}).`, { checkpoint: file });
    return true;
  }

  private async dispatch(key: string) {
    const h = this.state.get(key);
    const saved = this.fingerprints.get(key);
    if (!h || !saved) return;
    const fail = (detail: string, retryable = true) => this.step(key, "dispatch", "failed", `${detail} The checkpoint is kept${retryable ? "; Retry sends it once the problem is fixed" : ""}.`, { phase: "failed", retryable });
    this.step(key, "dispatch", "running", "Re-checking the worktree and asking Pathfinder to resume the ticket…", { phase: "running" });
    // Exactly one worker may write to the worktree: never while a session for this ticket is live.
    if (this.host.workers().some((x) => x.key === key && x.live)) return fail(`A session for ${key} is running again, so no second one is started.`, false);
    const owner = await this.owner(key);
    if (!owner || owner.branch !== saved.branch) return fail("The claim changed since the checkpoint was saved.", false);
    if (owner.state === "human-gate") return fail(`${key} is now at a human gate; answer it first.`, false);
    const git = await this.git(saved.worktree);
    if (!git || git.fingerprint !== saved.fingerprint) return fail("The worktree changed since the checkpoint was saved; save a new checkpoint.", false);
    const coord = this.host.coordinator();
    // A previous attempt may have reached the coordinator even though it reported a failure.
    if (h.dispatchId && coord.transcript && transcriptHas(coord.transcript, h.dispatchId)) {
      this.step(key, "dispatch", "ok", `The coordinator already received request ${h.dispatchId}; not sending it again. Waiting for the fresh session…`, { phase: "dispatched" });
      return;
    }
    if (!coord.running) return fail("The coordinator isn't running, so nothing was sent.");
    if (coord.state === "working") return fail("The coordinator is busy with a turn; nothing was sent.");
    const id = h.dispatchId ?? `tt-${randomBytes(3).toString("hex")}`;
    this.set(key, { ...this.state.get(key)!, dispatchId: id });
    const text =
      `/orchestrate resume ${key} — Tin & Thyme fresh-context handoff ${id}. Read the checkpoint ${saved.file} before building the brief and pass it to the fresh session. ` +
      `The fresh session must first verify the claim (orchestrate owner ${key}) and the worktree, then report what is done, what remains unverified and what it will do next, before any edit. ` +
      `Keep the ticket's stage, approvals and gates exactly as recorded.`;
    const ok = await this.host.typeToCoordinator(text);
    if (!ok) return fail("Typing into the coordinator's terminal failed.");
    this.step(key, "dispatch", "ok", `Sent \`/orchestrate resume ${key}\` (request ${id}) to the coordinator. Pathfinder now stages the resume and starts the fresh session; it asks you in the coordinator if the run needs approval.`, {
      phase: "dispatched",
    });
    this.host.activity(`${key}: checkpoint saved; asked Pathfinder for a fresh session (${id})`, null);
  }
}

function transcriptHas(file: string, needle: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}

/** Markdown sections whose heading matches, verbatim (bounded). */
function sections(md: string, heading: RegExp): string {
  const out: string[] = [];
  const parts = md.split(/^(?=#{2,3} )/m);
  for (const p of parts) {
    const h = /^#{2,3} (.+)$/m.exec(p)?.[1];
    if (h && heading.test(h)) out.push(p.trim());
  }
  const text = out.join("\n\n");
  return text.length > 6000 ? text.slice(0, 6000) + "\n… (truncated; the full file is context/current-ticket.md)" : text;
}
