// The GitHub side of delivery: the `gh` calls for PRs, checks and merge, through
// an injectable runner (execFile with fixed argument vectors, never a shell).
//
// Read-only PR polling stays in server/github.ts; this reuses its PR field types.
// Every call names the repository with `-R owner/name`, so the human's current
// directory never decides which repository is written to.

import type { GhPr } from "../github";
import { run, type RunResult } from "../lib/exec";
import { parseCliJson } from "../lib/json";
import { DeliveryError, redact } from "./state";

// ---------------------------------------------------------------- runner

export type Program = "git" | "gh" | "node";

/** Runs one program with a fixed argument vector. Tests inject a fake. */
export type Runner = (cmd: Program, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

/**
 * What delivery's `git` and `gh` calls add to the server's environment, so a
 * missing or expired credential fails at once instead of waiting on a prompt
 * nobody can answer (the kitchen server may still own the terminal it started
 * from): no git credential prompt, no Git Credential Manager dialog, no ssh
 * passphrase or host-key question, no gh prompt. A GIT_SSH_COMMAND the human
 * already set keeps its options and gains BatchMode; a GIT_SSH program is left
 * alone. (A `core.sshCommand` setting is overridden by GIT_SSH_COMMAND; it is
 * kept only when the human also exports GIT_SSH_COMMAND.)
 */
export function nonInteractiveEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };
  if (env.GIT_SSH_COMMAND) out.GIT_SSH_COMMAND = `${env.GIT_SSH_COMMAND} -o BatchMode=yes`;
  else if (!env.GIT_SSH) out.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return out;
}

export const defaultRunner: Runner = (cmd, args, opts = {}) =>
  cmd === "node" ? run(process.execPath, args, opts) : run(cmd, args, { ...opts, env: nonInteractiveEnv() });

/** The first meaningful line of a failed command's output, redacted. */
export function firstLine(r: RunResult, fallback: string): string {
  const line = (r.stderr || r.stdout)
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return redact(line || fallback);
}

const AUTH_TEXT = /gh auth login|not logged in|authentication (?:required|failed)|bad credentials|HTTP 401|requires authentication|invalid username or password|could not read Username/i;
const FORBIDDEN_TEXT = /HTTP 403|returned error: 403|permission to \S+ denied|resource not accessible/i;

/**
 * What the program itself wrote to stderr, with the command's own content
 * arguments (PR title, body, merge subject) removed. Node's "Command failed:
 * <argv>" text, which `run` puts in `stderr` when the program wrote none, is
 * never the program's output: it is dropped (a fake runner without
 * `processStderr` is read the same way).
 */
function ownStderr(r: RunResult, echoed: readonly string[]): string {
  let text = r.processStderr ?? (/^Command failed: /.test(r.stderr) ? "" : r.stderr);
  const parts = echoed.flatMap((v) => [v, ...v.split("\n").map((l) => l.trim())]).filter((v) => v.length >= 3);
  for (const v of [...new Set(parts)].sort((a, b) => b.length - a.length)) text = text.split(v).join(" ");
  return text;
}

/** How a failed call bears on a merge: a clear refusal (never completes later) or unclear (it may have taken effect). */
type Verdict = "refusal" | "unclear";
const verdicts = new WeakMap<DeliveryError, Verdict>();
const classified = (e: DeliveryError, v: Verdict): DeliveryError => (verdicts.set(e, v), e);

/**
 * Classifies a failed `gh` or `git` call from the process result itself: its
 * exit code, the signal or timeout that stopped it, and its own stderr. Never
 * from the command's arguments: Node's error text echoes the full argv, and
 * `echoed` (titles, bodies, subjects) is removed from stderr before matching.
 * - Stopped by a timeout or a signal: its own failure, unclear, never sign-in.
 * - `gh` exit 4 (authentication required), or a 401, refused credential
 *   prompt, or 403 in the program's own stderr: a sign-in problem.
 * - Anything else is reported with the program's own first line.
 */
export function commandFailure(r: RunResult, what: string, tool: "gh" | "git", echoed: readonly string[] = []): DeliveryError {
  if (r.killed || r.signal) {
    const how = r.killed ? `timed out and was stopped${r.signal ? ` (${r.signal})` : ""}` : `was terminated by signal ${r.signal}`;
    return classified(new DeliveryError("failed", `${what}: ${tool} ${how} before it finished; whether it took effect is unknown`), "unclear");
  }
  const text = ownStderr(r, echoed);
  if ((tool === "gh" && r.code === 4) || AUTH_TEXT.test(text)) return classified(new DeliveryError("auth", `${what}: GitHub sign-in is missing or expired`), "refusal");
  if (FORBIDDEN_TEXT.test(text)) return classified(new DeliveryError("auth", `${what}: GitHub refused this account (403); check that your gh login can write to the repository`), "refusal");
  if (/rate limit/i.test(text)) return classified(new DeliveryError("blocked", `${what}: GitHub API rate limit reached; try again later`), "unclear");
  const fallback = r.errno ? `${tool} could not run (${r.errno})` : `${tool} failed`;
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  const verdict: Verdict = line && !UNCLEAR_TEXT.test(text) && REFUSAL_TEXT.test(text) ? "refusal" : "unclear";
  // Shown only, never classified: stdout when the program wrote nothing to stderr.
  const shown = line || r.stdout.split("\n").map((l) => l.trim()).find(Boolean) || fallback;
  return classified(new DeliveryError("failed", `${what}: ${redact(shown)}`), verdict);
}

export const ghFailure = (r: RunResult, what: string, echoed: readonly string[] = []) => commandFailure(r, what, "gh", echoed);

/** How long the merge command may run before it is killed. */
export const MERGE_TIMEOUT_MS = 60_000;

/** Text of an unclear failure: the request may or may not have reached GitHub and completed. */
const UNCLEAR_TEXT = /\b5\d\d\b|timed? ?out|timeout|killed|SIGTERM|SIGKILL|signal|ECONN|ETIMEDOUT|EPIPE|EOF|connection|connect|network|resolve host|TLS|socket|something went wrong|try again later|rate limit|command failed|gh failed/i;

/**
 * GitHub's explicit refusal of a merge request: the mutation was rejected, so
 * this request can never merge the PR later. Only this text, or a sign-in
 * failure (the request was never authorized), counts; a timeout, kill, 5xx,
 * network error or anything unrecognized is unclear and never settles a merge
 * as not merged on its own.
 */
const REFUSAL_TEXT =
  /head branch was modified|base branch was modified|is not mergeable|not mergeable|merge commit cannot be cleanly created|required status checks?|status check .* is expected|approving reviews? (?:is|are) required|review is required|changes requested|repository rule violations|base branch policy prohibits|merging is blocked|merge method .* not allowed|is in (?:clean|dirty|blocked|unstable|behind|draft) status|pull request is (?:still )?a draft|protected branch/i;

export function isClearMergeRefusal(err: DeliveryError): boolean {
  // A failure classified from its process result is judged by that verdict alone, never by its text.
  const verdict = verdicts.get(err);
  if (verdict) return verdict === "refusal";
  if (UNCLEAR_TEXT.test(err.message)) return false;
  if (err.kind === "auth") return true;
  return REFUSAL_TEXT.test(err.message);
}

// ---------------------------------------------------------------- shapes

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface PrSummary {
  number: number;
  url: string;
  title: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  /** True when the PR's head lives in another repository (a fork). */
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
}

export interface PrDetail extends PrSummary {
  baseRefName: string;
  mergeable: GhPr["mergeable"];
  reviewDecision: GhPr["reviewDecision"] | "";
  mergeCommit: string | null;
}

/** What GitHub reports. `none` means no checks were reported, which is never "passing". */
export type ChecksSummary = "none" | "passed" | "pending" | "failed";

export interface Check {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" | string;
  state: string;
  link: string;
}

export function summarizeChecks(checks: Check[]): ChecksSummary {
  // Checks that were all skipped verified nothing: that is "none", never "passed".
  if (checks.every((c) => c.bucket === "skipping")) return "none";
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failed";
  if (checks.some((c) => c.bucket !== "pass" && c.bucket !== "skipping")) return "pending";
  return "passed";
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_FIELDS = "number,url,title,state,isDraft,headRefName,headRefOid,isCrossRepository,headRepositoryOwner";

// ---------------------------------------------------------------- forge

export class Forge {
  constructor(
    private readonly runner: Runner,
    readonly repo: string,
    readonly base: string,
    private readonly cwd: string,
  ) {
    if (!REPO.test(repo)) throw new DeliveryError("invalid", `not an owner/name repository: ${repo}`);
  }

  /** `echoed`: the call's content arguments (title, body, subject), never matched when classifying a failure. */
  private async gh(args: string[], what: string, timeoutMs = 30_000, echoed: string[] = []): Promise<RunResult> {
    const r = await this.runner("gh", args, { cwd: this.cwd, timeoutMs });
    if (!r.ok) throw ghFailure(r, what, echoed);
    return r;
  }

  private json<T>(r: RunResult, what: string): T {
    const data = parseCliJson<T>(r.stdout);
    if (data === null) throw new DeliveryError("failed", `${what}: gh returned no JSON`);
    return data;
  }

  /** The human's existing `gh` login. Never reads or returns the token. */
  async authStatus(): Promise<void> {
    await this.gh(["auth", "status", "--hostname", "github.com"], "gh sign-in check", 15_000);
  }

  /**
   * Refuses a PR whose head is not a branch of this repository itself: a fork
   * (or any cross-repository PR) can carry the same branch name, and its title
   * and commits are not the ticket's. Fails closed when GitHub omits the fields.
   */
  assertSameRepository(pr: Pick<PrSummary, "number" | "isCrossRepository" | "headRepositoryOwner">): void {
    const owner = this.repo.split("/")[0].toLowerCase();
    const headOwner = pr.headRepositoryOwner?.login;
    if (pr.isCrossRepository !== false || typeof headOwner !== "string" || headOwner.toLowerCase() !== owner)
      throw new DeliveryError("refused", `PR #${pr.number} comes from another repository (${headOwner ?? "unknown owner"}), not ${this.repo}; delivery never reuses or merges it`);
  }

  /**
   * The open PR for the branch if there is one, else a merged one, else null.
   * Closed PRs are ignored; an open or merged PR from another repository with
   * the same branch name is refused, never reused.
   */
  async findPr(branch: string): Promise<PrSummary | null> {
    const r = await this.gh(["pr", "list", "-R", this.repo, "--head", branch, "--base", this.base, "--state", "all", "--limit", "20", "--json", PR_FIELDS], "listing pull requests");
    const prs = this.json<PrSummary[]>(r, "listing pull requests").filter((p) => p.headRefName === branch && (p.state === "OPEN" || p.state === "MERGED"));
    for (const p of prs) this.assertSameRepository(p);
    return prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED") ?? null;
  }

  /** A normal (not draft) PR from the branch into the base. */
  async createPr(branch: string, title: string, body: string): Promise<void> {
    await this.gh(["pr", "create", "-R", this.repo, "--base", this.base, "--head", branch, "--title", title, "--body", body], "creating the pull request", 60_000, [title, body]);
  }

  async markReady(n: number): Promise<void> {
    await this.gh(["pr", "ready", String(n), "-R", this.repo], "marking the pull request ready");
  }

  async viewPr(n: number): Promise<PrDetail> {
    const r = await this.gh(
      ["pr", "view", String(n), "-R", this.repo, "--json", `${PR_FIELDS},baseRefName,mergeable,reviewDecision,mergeCommit`],
      "reading the pull request",
    );
    const raw = this.json<Omit<PrDetail, "mergeCommit"> & { mergeCommit: { oid: string } | null }>(r, "reading the pull request");
    this.assertSameRepository(raw);
    return { ...raw, mergeCommit: raw.mergeCommit?.oid ?? null };
  }

  /**
   * The checks GitHub reports, as they are. `gh pr checks` exits 8 while checks
   * are pending and 1 when one failed, still printing the JSON; with no checks
   * at all it prints "no checks reported" and exits 1.
   */
  async checks(n: number): Promise<Check[]> {
    const r = await this.runner("gh", ["pr", "checks", String(n), "-R", this.repo, "--json", "name,bucket,state,link"], { cwd: this.cwd, timeoutMs: 30_000 });
    if (r.code === 4) throw ghFailure(r, "reading checks");
    const data = parseCliJson<Check[]>(r.stdout);
    if (Array.isArray(data)) return data;
    if (/no checks reported/i.test(r.stderr + r.stdout)) return [];
    throw ghFailure(r.ok ? { ...r, ok: false } : r, "reading checks");
  }

  /** Squash merge pinned to the approved head. Never `--auto`, never `--delete-branch`. */
  async squashMerge(n: number, head: string, subject: string): Promise<void> {
    if (!SHA.test(head)) throw new DeliveryError("invalid", `not a full commit id: ${head}`);
    await this.gh(["pr", "merge", String(n), "-R", this.repo, "--squash", "--match-head-commit", head, "--subject", subject], "merging the pull request", MERGE_TIMEOUT_MS, [subject, subject.replace(/ \(#\d+\)$/, "")]);
  }
}
