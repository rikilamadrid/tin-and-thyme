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

export const defaultRunner: Runner = (cmd, args, opts = {}) => run(cmd === "node" ? process.execPath : cmd, args, opts);

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
 * Classifies a failed `gh` or `git` call. `gh` exits 4 when authentication is
 * required; a 401, a refused credential prompt, or a 403 is a sign-in problem too.
 */
export function commandFailure(r: RunResult, what: string, tool: "gh" | "git"): DeliveryError {
  const text = r.stderr + "\n" + r.stdout;
  if ((tool === "gh" && r.code === 4) || AUTH_TEXT.test(text)) return new DeliveryError("auth", `${what}: GitHub sign-in is missing or expired`);
  if (FORBIDDEN_TEXT.test(text)) return new DeliveryError("auth", `${what}: GitHub refused this account (403); check that your gh login can write to the repository`);
  if (/rate limit/i.test(text)) return new DeliveryError("blocked", `${what}: GitHub API rate limit reached; try again later`);
  return new DeliveryError("failed", `${what}: ${firstLine(r, `${tool} failed`)}`);
}

export const ghFailure = (r: RunResult, what: string) => commandFailure(r, what, "gh");

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
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failed";
  if (checks.some((c) => c.bucket !== "pass" && c.bucket !== "skipping")) return "pending";
  return "passed";
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

  private async gh(args: string[], what: string, timeoutMs = 30_000): Promise<RunResult> {
    const r = await this.runner("gh", args, { cwd: this.cwd, timeoutMs });
    if (!r.ok) throw ghFailure(r, what);
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

  /** The open PR for the branch if there is one, else a merged one, else null. Closed PRs are ignored. */
  async findPr(branch: string): Promise<PrSummary | null> {
    const r = await this.gh(
      ["pr", "list", "-R", this.repo, "--head", branch, "--base", this.base, "--state", "all", "--limit", "20", "--json", "number,url,title,state,isDraft,headRefName,headRefOid"],
      "listing pull requests",
    );
    const prs = this.json<PrSummary[]>(r, "listing pull requests").filter((p) => p.headRefName === branch);
    return prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED") ?? null;
  }

  /** A normal (not draft) PR from the branch into the base. */
  async createPr(branch: string, title: string, body: string): Promise<void> {
    await this.gh(["pr", "create", "-R", this.repo, "--base", this.base, "--head", branch, "--title", title, "--body", body], "creating the pull request", 60_000);
  }

  async markReady(n: number): Promise<void> {
    await this.gh(["pr", "ready", String(n), "-R", this.repo], "marking the pull request ready");
  }

  async viewPr(n: number): Promise<PrDetail> {
    const r = await this.gh(
      ["pr", "view", String(n), "-R", this.repo, "--json", "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,reviewDecision,mergeCommit"],
      "reading the pull request",
    );
    const raw = this.json<Omit<PrDetail, "mergeCommit"> & { mergeCommit: { oid: string } | null }>(r, "reading the pull request");
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
    await this.gh(["pr", "merge", String(n), "-R", this.repo, "--squash", "--match-head-commit", head, "--subject", subject], "merging the pull request", 60_000);
  }
}
