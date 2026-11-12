// Ticket delivery as explicit, validated, idempotent operations:
//
//   inspect(key)            validate everything; compute the head, base and expected merge tree
//   approve(key, approval)  record the human's exact approval {head, base, tree}
//   push(key, head)         <sha>:refs/heads/<ticket branch>, never forced
//   ensurePr(key)           reuse an open PR or create a normal one
//   status(key)             head, checks (as reported), mergeable, review decision
//   merge(key, approval)    squash, pinned with --match-head-commit; idempotent when merged
//   verify(key)             the new main has the expected parent and tree
//
// Every process call goes through an injectable runner (execFile, fixed argument
// vectors, no shell). It is reached only through service.ts, on a request from
// the kitchen's browser page (the delivery drawer). Every write is
// preceded by a fresh validation, and every result is recorded per ticket in
// the delivery state, redacted.

import { join } from "node:path";
import type { RunResult } from "../lib/exec";
import { parseCliJson } from "../lib/json";
import { commandFailure, defaultRunner, Forge, isClearMergeRefusal, MERGE_TIMEOUT_MS, summarizeChecks, type Check, type ChecksSummary, type PrDetail, type PrSummary, type Runner } from "./forge";
import { DeliveryError, DeliveryStore, emptyState, isTicketKey, redact, redactDeep, type Approval, type DeliveryState, type FailureKind, type PendingMerge, type SettledAttempt, type StepName } from "./state";

// ---------------------------------------------------------------- pure rules

const SHA = /^[0-9a-f]{40}$/;
export const isSha = (v: unknown): v is string => typeof v === "string" && SHA.test(v);

/** `https://github.com/o/n(.git)`, `git@github.com:o/n(.git)`, `ssh://git@github.com/o/n(.git)` → `o/n`. */
export function parseGithubRemote(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `ticket/<key>-<slug>`, for exactly this key. */
export function isTicketBranch(branch: string, key: string): boolean {
  const m = /^ticket\/(\d+\.\d+)-[A-Za-z0-9][A-Za-z0-9._-]*$/.exec(branch);
  return !!m && m[1] === key && !branch.includes("..") && !branch.endsWith(".lock") && !branch.endsWith(".");
}

/**
 * The reviewed head the engine's claim records. The orchestrator writes the
 * claim's `Last:` line as exactly `review PASS on <full 40-hex sha>` after an
 * independent tester's PASS (Feature 10, Notes). Anything else — a short id,
 * lower-case "pass", extra wording (FINDINGS, FAIL, "not", a round number) —
 * is not a recorded reviewed head.
 */
export function reviewedHeadOf(last: string | null): string | null {
  if (typeof last !== "string") return null;
  const m = /^review PASS on ([0-9a-f]{40})$/.exec(last);
  return m ? m[1] : null;
}

/** `context/tickets/<key>-<slug>.md`: the only file a post-review commit may change. */
export function isTicketRecord(path: string, key: string): boolean {
  return new RegExp(`^context/tickets/${key.replace(/\./g, "\\.")}-[^/]+\\.md$`).test(path);
}

/**
 * A denylist entry is a lowercase commit id: the full 40 hex digits, or an
 * abbreviation of at least 7 that must resolve to exactly one commit. Anything
 * else (an option-looking `-…`, a ref name, upper case) is refused before it
 * reaches git.
 */
export const isDenylistEntry = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,40}$/.test(v);

const FORBIDDEN_PUSH_FLAGS = /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes|--all|--mirror|--tags|--follow-tags|--delete|-d|--prune|--set-upstream|-u)$/;

/**
 * Refuses any push that is not exactly one `<sha>:refs/heads/ticket/…` refspec
 * to origin, without force, --all, --mirror or --tags. `refs/backup/*` and
 * `refs/pathfinder/*` can never be pushed.
 */
export function assertSafePushArgs(args: string[]): void {
  const bad = (why: string) => {
    throw new DeliveryError("refused", `unsafe push refused: ${why}`);
  };
  if (args[0] !== "push") bad("not a push");
  const flags = args.slice(1).filter((a) => a.startsWith("-"));
  const positional = args.slice(1).filter((a) => !a.startsWith("-"));
  for (const f of flags) if (FORBIDDEN_PUSH_FLAGS.test(f)) bad(`flag ${f}`);
  for (const f of flags) if (f !== "--no-follow-tags" && f !== "--porcelain") bad(`unexpected flag ${f}`);
  if (positional.length !== 2 || positional[0] !== "origin") bad("expected exactly `origin <sha>:refs/heads/<ticket branch>`");
  const spec = positional[1];
  if (/refs\/(?:backup|pathfinder)\//.test(spec)) bad(`refspec ${spec} names a local-only ref`);
  const m = /^([0-9a-f]{40}):refs\/heads\/(ticket\/\d+\.\d+-[A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(spec);
  if (!m) bad(`refspec ${spec} is not <sha>:refs/heads/ticket/<key>-<slug>`);
}

/** The one push this module ever runs. */
export function pushArgs(key: string, head: string, branch: string): string[] {
  if (!isSha(head)) throw new DeliveryError("invalid", `not a full commit id: ${head}`);
  if (!isTicketBranch(branch, key)) throw new DeliveryError("invalid", `${branch} is not ticket/${key}-<slug>`);
  const args = ["push", "--no-follow-tags", "--porcelain", "origin", `${head}:refs/heads/${branch}`];
  assertSafePushArgs(args);
  return args;
}

/**
 * Whether git itself reported the push rejected because the remote branch moved
 * (non-fast-forward, fetch first, stale info). Judged only from the program's own
 * output, never from Node's error text, which echoes the argv and so the branch
 * name (a slug containing "non-fast-forward" must not read as a rejection):
 * - the `--porcelain` status line on stdout, by its fields: flag `!`, exactly our
 *   `<sha>:refs/heads/<branch>`, summary `[rejected]`;
 * - or the program's own stderr (`processStderr`), with the branch name removed.
 */
export function pushRejected(r: RunResult, head: string, branch: string): boolean {
  const spec = `${head}:refs/heads/${branch}`;
  for (const line of r.stdout.split("\n")) {
    const [flag, ref, summary] = line.split("\t");
    if (flag === "!" && ref === spec && /^\[rejected\]/.test(summary ?? "")) return true;
  }
  const own = (r.processStderr ?? (/^Command failed: /.test(r.stderr) ? "" : r.stderr)).split(branch).join(" ");
  return /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(own);
}

/** Strict token shapes for the diff scan; ordinary code that mentions a header is not a finding. */
const SECRET_SCAN: [string, RegExp][] = [
  ["GitHub token", /\bgh[oprsu]_[A-Za-z0-9]{36}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["Authorization header with a literal credential", /authorization["']?\s*[:=]\s*["']?(?:bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ["credentials in a URL", /:\/\/[^\s/:@]+:[^\s/@$]{16,}@/],
];

export interface SecretFinding {
  /** The commit that adds it, when scanning `git log -p` output. */
  commit?: string;
  file: string;
  line: number;
  kind: string;
}

export interface ScanResult {
  findings: SecretFinding[];
  /** Binary files the scan could not read (`commit file` or `file`). */
  binary: string[];
}

/** `"b/x"` / `b/x` / `/dev/null` → the path without its a/ or b/ prefix. */
function diffPath(raw: string): string {
  const p = raw.trim().replace(/^"(.*)"$/, "$1");
  return p === "/dev/null" ? p : p.replace(/^[ab]\//, "");
}

/**
 * Added lines of unified diffs (`-U0` or more) that look like secrets; never
 * returns the text. Accepts one diff or `git log -p --format='commit %H'`
 * output, attributing each finding to its commit. `---`/`+++` are file headers
 * only between `diff --git` and the first hunk, so an added line that itself
 * starts with `++ ` is still scanned. Binary files are listed as unscanned.
 */
export function scanDiff(diff: string): ScanResult {
  const findings: SecretFinding[] = [];
  const binary: string[] = [];
  let commit: string | undefined;
  let file = "";
  let line = 0;
  let header = false;
  const at = (f: string) => (commit ? `${commit.slice(0, 12)} ${f}` : f);
  for (const text of diff.split("\n")) {
    const c = /^commit ([0-9a-f]{40})$/.exec(text);
    if (c) {
      commit = c[1];
      file = "";
      header = false;
      continue;
    }
    if (text.startsWith("diff --git ")) {
      header = true;
      const b = text.lastIndexOf(" b/");
      const q = text.lastIndexOf(' "b/');
      file = q >= 0 ? diffPath(text.slice(q + 1)) : b >= 0 ? diffPath(text.slice(b + 1)) : "";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      header = false;
      line = Number(hunk[1]);
      continue;
    }
    if (header) {
      if (text.startsWith("+++ ")) {
        const p = diffPath(text.slice(4));
        if (p !== "/dev/null") file = p;
      } else if (/^Binary files .* differ$/.test(text) || text === "GIT binary patch") binary.push(at(file));
      continue;
    }
    if (text.startsWith("+")) {
      for (const [kind, pattern] of SECRET_SCAN) if (pattern.test(text)) findings.push({ ...(commit ? { commit } : {}), file, line, kind });
      line++;
    } else if (text.startsWith(" ")) line++;
  }
  return { findings, binary: [...new Set(binary)] };
}

/** Commit messages (`git log --format=%H%x1f%B%x1e`) that look like they hold a secret. */
export function scanMessages(log: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const record of log.split("\x1e")) {
    const sep = record.indexOf("\x1f");
    if (sep < 0) continue;
    const commit = record.slice(0, sep).trim();
    if (!isSha(commit)) continue;
    record
      .slice(sep + 1)
      .split("\n")
      .forEach((text, i) => {
        for (const [kind, pattern] of SECRET_SCAN) if (pattern.test(text)) findings.push({ commit, file: "(commit message)", line: i + 1, kind });
      });
  }
  return findings;
}

export interface Inspection {
  key: string;
  repo: string;
  branch: string;
  worktree: string;
  title: string | null;
  /** The commit to deliver: the local ticket branch head. */
  head: string;
  /** The reviewed head the claim records (full id). */
  reviewedHead: string;
  /** Commits after the reviewed head change only this record (empty when head == reviewed). */
  recordOnly: string[];
  recordPath: string | null;
  /** Freshly fetched origin/<base>. */
  base: string;
  mergeBase: string;
  behind: boolean;
  /** The tree main will have after the squash merge. */
  tree: string;
  /** Binary files the secret scan could not read, shown to the human (`<commit> <path>`). */
  unscanned: string[];
  /** The local verification evidence the claim records, shown when GitHub reports no checks. */
  evidence: string | null;
}

/** Why an approval no longer matches the current inspection; empty when it still holds. */
export function approvalStaleness(approval: Approval, current: Pick<Inspection, "key" | "head" | "base" | "tree">): string[] {
  const reasons: string[] = [];
  if (approval.key !== current.key) reasons.push(`approval is for ${approval.key}, not ${current.key}`);
  if (approval.head !== current.head) reasons.push(`head moved from ${approval.head} to ${current.head}`);
  if (approval.base !== current.base) reasons.push(`base moved from ${approval.base} to ${current.base}`);
  if (approval.tree !== current.tree) reasons.push(`expected merge tree changed from ${approval.tree} to ${current.tree}`);
  return reasons;
}

function validApproval(key: string, a: unknown): Approval {
  const x = a as Partial<Approval> | null;
  if (!x || typeof x !== "object") throw new DeliveryError("invalid", "approval is missing");
  if (x.key !== key) throw new DeliveryError("invalid", `approval is for ${String(x.key)}, not ${key}`);
  for (const f of ["head", "base", "tree"] as const) if (!isSha(x[f])) throw new DeliveryError("invalid", `approval ${f} is not a full commit/tree id`);
  if (x.acknowledgeNoChecks !== undefined && typeof x.acknowledgeNoChecks !== "boolean") throw new DeliveryError("invalid", "acknowledgeNoChecks must be true or false");
  return { key, head: x.head!, base: x.base!, tree: x.tree!, ...(x.acknowledgeNoChecks ? { acknowledgeNoChecks: true } : {}) };
}

// ---------------------------------------------------------------- operations

export interface DeliveryConfig {
  /** The project's main checkout. */
  root: string;
  /** The configured GitHub repository, `owner/name`. */
  repo: string;
  store: DeliveryStore;
  /** The integration branch. */
  base?: string;
  /** Commits that must never be reachable from a delivered head (e.g. credential-bearing history). */
  denylist?: string[];
  runner?: Runner;
  /** The project's orchestrate engine; defaults to `<root>/skills/orchestrate/engine/bin/orchestrate.mjs`. */
  engine?: string;
  now?: () => Date;
  /**
   * Waits before re-reading the PR after a merge command that succeeded, while
   * GitHub does not report it merged yet (default 500 ms, then 1500 ms). After
   * the last, the merge is recorded as confirmation pending, never as not merged.
   */
  confirmDelaysMs?: number[];
  /**
   * An unclear merge failure (timeout, kill, 5xx, network, interrupted) is
   * settled as not merged only when, this long after the command was sent,
   * GitHub still does not report the PR merged and origin has neither the
   * approved head nor tree. Must be longer than the merge timeout
   * (default 5 minutes; the merge command is killed after 60 s).
   */
  settleAfterMs?: number;
}

export type Outcome<T> =
  | { ok: true; data: T; state: DeliveryState }
  | { ok: false; kind: FailureKind; message: string; fix: string | null; reasons: string[]; state: DeliveryState };

export interface Claim {
  key: string;
  branch: string | null;
  worktree: string | null;
  orphan: boolean;
  state: string | null;
  last: string | null;
  ref: string | null;
  title: string | null;
}

export interface DeliveryStatus {
  pr: PrDetail | null;
  head: string | null;
  base: string;
  checks: { summary: ChecksSummary; items: Check[] };
  mergeable: PrDetail["mergeable"] | null;
  reviewDecision: PrDetail["reviewDecision"] | null;
}

export interface MergeResult {
  pr: { number: number; url: string };
  mergeCommit: string;
  already: boolean;
  /** What GitHub reported when this merge ran; null when it was already merged. */
  checks: ChecksSummary | null;
  /** Shown when the merge relied on the human's acknowledgement of "no checks reported". */
  evidence: string | null;
}

export interface VerifyResult {
  mergeCommit: string;
  parent: string;
  tree: string;
  main: string;
}

export class Delivery {
  private readonly runner: Runner;
  private readonly base: string;
  private readonly engine: string;
  private readonly forge: Forge;
  private readonly now: () => Date;
  private readonly confirmDelaysMs: number[];
  private readonly settleAfterMs: number;

  constructor(private readonly cfg: DeliveryConfig) {
    this.runner = cfg.runner ?? defaultRunner;
    this.base = cfg.base ?? "main";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(this.base) || this.base.includes("..")) throw new DeliveryError("invalid", `not a branch name: ${this.base}`);
    this.engine = cfg.engine ?? join(cfg.root, "skills", "orchestrate", "engine", "bin", "orchestrate.mjs");
    this.forge = new Forge(this.runner, cfg.repo, this.base, cfg.root);
    this.now = cfg.now ?? (() => new Date());
    this.confirmDelaysMs = cfg.confirmDelaysMs ?? [500, 1500];
    this.settleAfterMs = cfg.settleAfterMs ?? 5 * MERGE_TIMEOUT_MS;
    if (!Number.isFinite(this.settleAfterMs) || this.settleAfterMs <= MERGE_TIMEOUT_MS)
      throw new DeliveryError("invalid", `settleAfterMs must be longer than the merge timeout (${MERGE_TIMEOUT_MS} ms)`);
  }

  /** The stored delivery state (what a reconnecting UI restores). */
  read(key: string): DeliveryState {
    return this.cfg.store.read(key);
  }

  // ------------------------------------------------------------ public operations

  inspect(key: string): Promise<Outcome<Inspection>> {
    return this.step(key, "inspect", async () => {
      const insp = await this.inspectNow(key);
      const unscanned = insp.unscanned.length ? `; ${insp.unscanned.length} binary file(s) not scanned for secrets` : "";
      return { data: insp, message: `${insp.branch} at ${insp.head} onto ${this.base} ${insp.base}: tree ${insp.tree}${unscanned}` };
    });
  }

  /** Records the human's approval of the exact head, base and tree they were shown. */
  approve(key: string, approval: Approval): Promise<Outcome<Approval>> {
    return this.step(key, "approve", async () => {
      const a = validApproval(key, approval);
      const insp = await this.inspectNow(key);
      const reasons = approvalStaleness(a, insp);
      if (reasons.length) throw new DeliveryError("stale", "the approval no longer matches the branch or base; inspect again", { reasons });
      const recorded = { ...a, at: this.now().toISOString() };
      this.cfg.store.update(key, (s) => {
        s.approval = recorded;
        s.invalidated = null;
      });
      return { data: recorded, message: `approved ${a.head} onto ${a.base} (tree ${a.tree})` };
    });
  }

  push(key: string, head: string): Promise<Outcome<{ branch: string; head: string; already: boolean }>> {
    return this.step<{ branch: string; head: string; already: boolean }>(key, "push", async () => {
      if (!isSha(head)) throw new DeliveryError("invalid", `not a full commit id: ${String(head)}`);
      const insp = await this.inspectNow(key);
      if (insp.head !== head) throw new DeliveryError("stale", `${insp.branch} is now at ${insp.head}, not the ${head} you saw; inspect again`);
      const remote = await this.remoteHead(insp.branch);
      if (remote === head) return { data: { branch: insp.branch, head, already: true }, message: `${insp.branch} already on origin at ${head}` };
      if (remote) throw new DeliveryError("refused", `origin ${insp.branch} is ${remote}, expected ${head}; not overwriting it`);
      const r = await this.git(pushArgs(key, head, insp.branch), { timeoutMs: 120_000 });
      if (!r.ok) {
        if (pushRejected(r, head, insp.branch)) throw new DeliveryError("refused", `origin refused ${insp.branch}: it changed on the remote; not overwriting it`);
        throw commandFailure(r, `pushing ${insp.branch}`, "git");
      }
      const after = await this.remoteHead(insp.branch);
      if (after !== head) throw new DeliveryError("failed", `after the push, origin ${insp.branch} is ${after ?? "missing"}, not ${head}`);
      return { data: { branch: insp.branch, head, already: false }, message: `pushed ${head} to ${insp.branch}` };
    });
  }

  ensurePr(key: string, opts: { title?: string; body?: string } = {}): Promise<Outcome<{ pr: PrSummary; created: boolean; merged: boolean }>> {
    return this.step<{ pr: PrSummary; created: boolean; merged: boolean }>(key, "ensurePr", async () => {
      const insp = await this.inspectNow(key);
      await this.forge.authStatus();
      const remote = await this.remoteHead(insp.branch);
      if (!remote) throw new DeliveryError("refused", `${insp.branch} is not on origin yet; push it first`);
      if (remote !== insp.head) throw new DeliveryError("refused", `origin ${insp.branch} is ${remote}, not the inspected ${insp.head}`);

      const record = (pr: PrSummary) => (s: DeliveryState) => {
        s.pr = { number: pr.number, url: pr.url };
      };
      const existing = await this.forge.findPr(insp.branch);
      if (existing?.state === "MERGED")
        return { data: { pr: existing, created: false, merged: true }, message: `PR #${existing.number} is already merged; verify it`, change: record(existing) };
      if (existing) {
        if (existing.headRefOid !== insp.head) throw new DeliveryError("refused", `PR #${existing.number} is at ${existing.headRefOid}, not ${insp.head}`);
        if (existing.isDraft) await this.forge.markReady(existing.number);
        const pr = { ...existing, isDraft: false };
        return { data: { pr, created: false, merged: false }, message: `reusing PR #${pr.number}`, change: record(pr) };
      }

      const title = text(opts.title, 256) ?? `${insp.title ?? `Ticket ${key}`} (ticket ${key})`;
      const body =
        text(opts.body, 20_000) ??
        [`Delivers ticket \`${insp.recordPath ?? `context/tickets/${key}`}\`.`, "", `- Head: \`${insp.head}\``, `- Reviewed: \`${insp.reviewedHead}\``, `- Base: \`${insp.base}\``, `- Expected tree after merge: \`${insp.tree}\``].join("\n");
      await this.forge.createPr(insp.branch, title, body);
      const pr = await this.forge.findPr(insp.branch);
      if (!pr || pr.state !== "OPEN") throw new DeliveryError("failed", `created a PR for ${insp.branch} but cannot find it open`);
      return { data: { pr, created: true, merged: false }, message: `created PR #${pr.number}`, change: record(pr) };
    });
  }

  status(key: string): Promise<Outcome<DeliveryStatus>> {
    return this.step<DeliveryStatus>(key, "status", async () => {
      const claim = await this.validClaim(key, { allowAnyState: true });
      const branch = claim.branch!;
      const base = await this.fetchBase();
      const found = await this.forge.findPr(branch);
      if (!found) {
        return {
          data: { pr: null, head: null, base, checks: { summary: "none" as const, items: [] }, mergeable: null, reviewDecision: null },
          message: `no PR for ${branch}`,
        };
      }
      const pr = await this.forge.viewPr(found.number);
      const items = await this.forge.checks(pr.number);
      const summary = summarizeChecks(items);
      return {
        data: { pr, head: pr.headRefOid, base, checks: { summary, items }, mergeable: pr.mergeable, reviewDecision: pr.reviewDecision || null },
        message: `PR #${pr.number} ${pr.state}, ${pr.mergeable}, checks: ${summary === "none" ? "no checks reported" : summary}`,
        change: (s: DeliveryState) => {
          s.pr = { number: pr.number, url: pr.url };
        },
      };
    });
  }

  merge(key: string, approval: Approval): Promise<Outcome<MergeResult>> {
    return this.step<MergeResult>(key, "merge", async () => {
      const a = validApproval(key, approval);
      // One merge into the base at a time, across every Delivery and kitchen process using this
      // deliveries folder: held from the pre-merge re-check through the merge and its verification.
      const release = this.cfg.store.lock("merge", `a merge into ${this.base}`);
      try {
        return await this.mergeLocked(key, a);
      } finally {
        release();
      }
    });
  }

  private async mergeLocked(key: string, a: Approval): Promise<{ data: MergeResult; message: string }> {
    const recorded = this.cfg.store.read(key);
    // A recorded merge is never merged again, whatever approval this call carries:
    // it is verified against the approval it is bound to. An unbound (outside) merge
    // is offered this call's approval, which is bound only if it verifies.
    if (recorded.merged) {
      await this.validRepo();
      return this.alreadyMerged(key, [a]);
    }
    // A merge whose outcome GitHub has not confirmed is settled first, from GitHub
    // and origin, before any new attempt: merged (and verified), or not merged.
    if (recorded.pendingMerge) {
      await this.validRepo();
      const r = await this.reconcile(key, recorded.pendingMerge);
      if (r.merged) return this.alreadyMerged(key, [a]);
      // Confirmed not merged, on positive evidence: a new attempt may follow, fully re-checked.
    }

    const claim = await this.validClaim(key);
    const found = await this.forge.findPr(claim.branch!);
    if (!found) throw new DeliveryError("refused", `no PR for ${claim.branch}; ensure the PR first`);
    const pr = await this.forge.viewPr(found.number);

    if (pr.state === "MERGED") {
      // Merged outside this app (no merge or pending merge recorded): recorded with no approval.
      // This call's approval is bound only if it verifies; a wrong one is never kept.
      this.recordMerged(key, pr, null);
      return this.alreadyMerged(key, [a]);
    }
    if (pr.state !== "OPEN") throw new DeliveryError("refused", `PR #${pr.number} is ${pr.state}`);

    const insp = await this.inspectNow(key);
    const reasons = approvalStaleness(a, insp);
    if (pr.headRefOid !== a.head) reasons.push(`PR #${pr.number} head is ${pr.headRefOid}, not the approved ${a.head}`);
    if (reasons.length) this.stale(key, a, reasons);
    if (pr.baseRefName !== this.base) throw new DeliveryError("invalid", `PR #${pr.number} targets ${pr.baseRefName}, not ${this.base}`);
    if (pr.headRefName !== claim.branch) throw new DeliveryError("invalid", `PR #${pr.number} is from ${pr.headRefName}, not ${claim.branch}`);
    if (pr.isDraft) throw new DeliveryError("blocked", `PR #${pr.number} is a draft`);

    const items = await this.forge.checks(pr.number);
    const checks = summarizeChecks(items);
    if (checks === "failed") throw new DeliveryError("blocked", `PR #${pr.number} has a failing check`, { reasons: items.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => c.name) });
    if (checks === "pending") throw new DeliveryError("blocked", `PR #${pr.number} has checks still running`, { reasons: items.filter((c) => c.bucket === "pending").map((c) => c.name) });
    if (checks === "none") {
      if (!insp.evidence) throw new DeliveryError("blocked", "no checks reported and no local verification evidence recorded for the ticket");
      if (!a.acknowledgeNoChecks) throw new DeliveryError("blocked", "no checks reported: merging needs your explicit acknowledgement of the local evidence", { reasons: [insp.evidence] });
    }
    if (pr.mergeable === "CONFLICTING") throw new DeliveryError("blocked", `PR #${pr.number} conflicts with ${this.base}`);
    if (pr.mergeable !== "MERGEABLE") throw new DeliveryError("blocked", `GitHub has not computed whether PR #${pr.number} is mergeable yet; try again in a moment`);
    if (pr.reviewDecision === "CHANGES_REQUESTED") throw new DeliveryError("blocked", `PR #${pr.number} has changes requested`);

    // Immediately before merging: origin's base is still exactly the approved base.
    const remoteBase = await this.remoteHead(this.base);
    if (remoteBase !== a.base) this.stale(key, a, [`origin ${this.base} moved from ${a.base} to ${remoteBase ?? "nothing"}`]);

    // Written before the command is sent: an interrupted merge is "outcome unknown", never "not merged".
    const approvedAt = this.cfg.store.read(key).approval?.at ?? this.now().toISOString();
    const sent: PendingMerge = {
      at: this.now().toISOString(),
      pr: pr.number,
      approval: { ...a, at: approvedAt },
      status: "sent",
      note: `the merge command for PR #${pr.number} was sent; its outcome is not recorded yet`,
    };
    this.cfg.store.update(key, (s) => {
      s.approval = { ...a, at: approvedAt };
      s.invalidated = null;
      s.pendingMerge = sent;
    });

    let failure: DeliveryError | null = null;
    try {
      await this.forge.squashMerge(pr.number, a.head, `${pr.title} (#${pr.number})`);
    } catch (err) {
      failure = err instanceof DeliveryError ? err : new DeliveryError("failed", err instanceof Error ? err.message : String(err));
    }
    // GitHub may lag behind its own merge command: a successful command is re-read a few times.
    const confirmed = await this.confirmMerged(pr.number, failure ? [] : this.confirmDelaysMs);
    if (confirmed) {
      this.recordMerged(key, confirmed, sent.approval);
      const v = await this.verifyRecorded(key);
      return {
        data: { pr: { number: pr.number, url: pr.url }, mergeCommit: v.mergeCommit, already: false, checks, evidence: checks === "none" ? insp.evidence : null },
        message: `merged PR #${pr.number} as ${v.mergeCommit}`,
      };
    }

    if (!failure) {
      const note = `the merge command for PR #${pr.number} succeeded, but GitHub does not report it merged yet: confirmation pending`;
      this.setPending(key, "confirmation-pending", note);
      throw new DeliveryError("blocked", `${note}. Do not merge again: verify it in a moment; it is settled from GitHub and origin before any new merge attempt`);
    }

    // The command failed and GitHub does not report a merge. A clear refusal from GitHub is
    // settled as not merged once GitHub and origin confirm nothing landed; an unclear failure
    // (timeout, kill, 5xx, network) stays unknown, with its approval, until reads settle it.
    const refusal = isClearMergeRefusal(failure) ? failure.message : null;
    if (refusal) this.setPending(key, "refused", `GitHub refused the merge command for PR #${pr.number} (${refusal})`, refusal);
    else this.setPending(key, "unknown", `the merge command for PR #${pr.number} failed unclearly (${failure.message}) and GitHub does not report it merged; outcome unknown`);
    let settled: { merged: true } | { merged: false; reason: string };
    try {
      settled = await this.reconcile(key, { ...sent, status: refusal ? "refused" : "unknown", ...(refusal ? { refusal } : {}) });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new DeliveryError(failure.kind, `${failure.message}; whether PR #${pr.number} merged is unknown (${why}). It is settled from GitHub and origin before any new merge attempt`, {
        fix: failure.fix ?? undefined,
        reasons: failure.reasons,
      });
    }
    if (settled.merged) {
      const v = await this.verifyRecorded(key);
      return {
        data: { pr: { number: pr.number, url: pr.url }, mergeCommit: v.mergeCommit, already: false, checks, evidence: checks === "none" ? insp.evidence : null },
        message: `merged PR #${pr.number} as ${v.mergeCommit}`,
      };
    }
    throw failure;
  }

  /** Clears an approval that no longer holds, keeping why for the UI, and stops. */
  private stale(key: string, a: Approval, reasons: string[]): never {
    this.cfg.store.update(key, (s) => {
      s.approval = null;
      s.invalidated = { at: this.now().toISOString(), reasons, approval: a };
    });
    throw new DeliveryError("stale", "the approval is stale; inspect and approve again", { reasons });
  }

  verify(key: string): Promise<Outcome<VerifyResult>> {
    return this.step(key, "verify", async () => {
      // The claim may already be released after a merge, so this reads the PR the state recorded.
      await this.validRepo();
      const s = this.cfg.store.read(key);
      if (!s.merged && s.pendingMerge) {
        const r = await this.reconcile(key, s.pendingMerge);
        if (!r.merged) throw new DeliveryError("refused", `PR #${s.pendingMerge.pr} is confirmed not merged: ${r.reason}`);
      } else if (!s.merged) {
        const number = s.pr?.number ?? (s.branch && isTicketBranch(s.branch, key) ? (await this.forge.findPr(s.branch))?.number : undefined);
        if (!number) throw new DeliveryError("refused", `no PR is recorded for ${key}`);
        const pr = await this.forge.viewPr(number);
        if (pr.state !== "MERGED") throw new DeliveryError("refused", `PR #${pr.number} is ${pr.state}, not merged`);
        // Merged outside this app: recorded with no approval; one is bound only once it verifies.
        this.recordMerged(key, pr, null);
      }
      // Against the approval the merge is bound to; an unbound (outside) merge binds the first recorded approval that verifies.
      const v = await this.verifyRecorded(key);
      return { data: v, message: `${this.base} has ${v.mergeCommit}: parent ${v.parent}, tree ${v.tree}` };
    });
  }

  // ------------------------------------------------------------ internals

  /** Runs one operation for a key, one at a time, recording its result. */
  private async step<T>(key: string, name: StepName, fn: () => Promise<{ data: T; message: string; change?: (s: DeliveryState) => void }>): Promise<Outcome<T>> {
    if (!isTicketKey(key)) {
      const err = new DeliveryError("invalid", `not a ticket key: ${String(key)}`);
      return { ok: false, kind: err.kind, message: err.message, fix: null, reasons: [], state: emptyState(String(key)) };
    }
    const failure = (e: unknown, state: DeliveryState): Outcome<T> => {
      const err = e instanceof DeliveryError ? e : new DeliveryError("failed", e instanceof Error ? e.message : String(e));
      return { ok: false, kind: err.kind, message: err.message, fix: err.fix, reasons: err.reasons, state };
    };
    // Nothing runs unless the step's result can be recorded: an unreadable state file stops here, untouched.
    try {
      this.cfg.store.read(key);
    } catch (e) {
      return failure(e, emptyState(key));
    }
    // One step per ticket at a time, across every Delivery and kitchen process using this folder.
    let release: () => void;
    try {
      release = this.cfg.store.lock(key, `another delivery step for ${key}`);
    } catch (e) {
      return failure(e, this.safeRead(key));
    }
    const at = () => this.now().toISOString();
    try {
      let result: { data: T; message: string; change?: (s: DeliveryState) => void };
      try {
        result = await fn();
      } catch (e) {
        const err = e instanceof DeliveryError ? e : new DeliveryError("failed", e instanceof Error ? e.message : String(e));
        try {
          const state = this.cfg.store.record(key, { step: name, ok: false, at: at(), message: err.message, kind: err.kind, fix: err.fix, reasons: err.reasons });
          return failure(err, state);
        } catch (recordErr) {
          return failure(new DeliveryError(err.kind, `${err.message} (and the result could not be recorded: ${(recordErr as Error).message})`, { fix: err.fix ?? undefined, reasons: err.reasons }), this.safeRead(key));
        }
      }
      try {
        const state = this.cfg.store.record(key, { step: name, ok: true, at: at(), message: redact(result.message) }, result.change);
        return { ok: true, data: redactDeep(result.data), state };
      } catch (recordErr) {
        return failure(new DeliveryError("failed", `${redact(result.message)}, but the result could not be recorded: ${(recordErr as Error).message}`), this.safeRead(key));
      }
    } finally {
      release();
    }
  }

  private safeRead(key: string): DeliveryState {
    try {
      return this.cfg.store.read(key);
    } catch {
      return emptyState(key);
    }
  }

  private git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    if (args[0] === "push") assertSafePushArgs(args);
    return this.runner("git", args, { cwd: opts.cwd ?? this.cfg.root, timeoutMs: opts.timeoutMs });
  }

  private async gitOk(args: string[], what: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.git(args, opts);
    if (!r.ok) throw commandFailure(r, what, "git");
    return r.stdout.trim();
  }

  private async commit(ref: string, what: string): Promise<string> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = r.stdout.trim();
    if (!r.ok || !isSha(sha)) throw new DeliveryError("invalid", `cannot resolve ${what} (${ref})`);
    return sha;
  }

  /** 0 → true, 1 → false, anything else is an error. */
  private async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.git(["merge-base", "--is-ancestor", a, b]);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw commandFailure(r, `checking whether ${a} is an ancestor of ${b}`, "git");
  }

  private async claim(key: string): Promise<Claim | null> {
    const r = await this.runner("node", [this.engine, "owner", key, "--json"], { cwd: this.cfg.root, timeoutMs: 20_000 });
    const out = parseCliJson<{ claim?: Partial<Claim> | null }>(r.stdout);
    if (!out) throw new DeliveryError("failed", `cannot read the engine's claim for ${key}: ${redact((r.stderr || "no output").split("\n")[0])}`);
    const c = out.claim;
    if (!c) return null;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { key, branch: str(c.branch), worktree: str(c.worktree), orphan: c.orphan === true, state: str(c.state), last: str(c.last), ref: str(c.ref), title: str(c.title) };
  }

  /** The repository, and a live claim on its own ticket branch. */
  private async validRepo(): Promise<void> {
    const url = await this.gitOk(["remote", "get-url", "origin"], "reading origin");
    const origin = parseGithubRemote(url);
    if (!origin || origin.toLowerCase() !== this.cfg.repo.toLowerCase()) throw new DeliveryError("invalid", `origin is ${url}, not github.com/${this.cfg.repo}`);
    // Where a push really goes: `pushurl` and `pushInsteadOf` are applied here, and there must be exactly one.
    const pushUrls = (await this.gitOk(["remote", "get-url", "--push", "--all", "origin"], "reading origin's push URL"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (pushUrls.length !== 1) throw new DeliveryError("invalid", `origin has ${pushUrls.length} push URLs; delivery needs exactly one, github.com/${this.cfg.repo}`, { reasons: pushUrls });
    const pushTo = parseGithubRemote(pushUrls[0]);
    if (!pushTo || pushTo.toLowerCase() !== this.cfg.repo.toLowerCase()) throw new DeliveryError("invalid", `origin pushes to ${pushUrls[0]}, not github.com/${this.cfg.repo}`);
  }

  private async validClaim(key: string, opts: { allowAnyState?: boolean } = {}): Promise<Claim> {
    await this.validRepo();
    const claim = await this.claim(key);
    if (!claim) throw new DeliveryError("invalid", `${key} has no engine claim`);
    if (!claim.branch || !isTicketBranch(claim.branch, key)) throw new DeliveryError("invalid", `${key}'s claim is on ${claim.branch ?? "no branch"}, not ticket/${key}-<slug>`);
    if (claim.orphan || !claim.worktree) throw new DeliveryError("refused", `${key}'s claim has no live worktree; leave it to the human`);
    if (!opts.allowAnyState && claim.state !== "done") throw new DeliveryError("refused", `${key}'s claim is ${claim.state ?? "unknown"}, not done`);
    return claim;
  }

  private async fetchBase(): Promise<string> {
    await this.gitOk(["fetch", "--no-tags", "origin", `+refs/heads/${this.base}:refs/remotes/origin/${this.base}`], `fetching origin/${this.base}`, { timeoutMs: 120_000 });
    return this.commit(`refs/remotes/origin/${this.base}`, `origin/${this.base}`);
  }

  private async remoteHead(branch: string): Promise<string | null> {
    const ref = `refs/heads/${branch}`;
    const out = await this.gitOk(["ls-remote", "origin", ref], `reading origin ${branch}`, { timeoutMs: 60_000 });
    for (const line of out.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && isSha(sha)) return sha;
    }
    return null;
  }

  /** Every validation the Feature requires before a write. Throws a DeliveryError. */
  private async inspectNow(key: string): Promise<Inspection> {
    const claim = await this.validClaim(key);
    const branch = claim.branch!;
    const worktree = join(this.cfg.root, claim.worktree!);
    const head = await this.commit(`refs/heads/${branch}`, `the ${branch} head`);

    const dirty = await this.git(["status", "--porcelain", "--untracked-files=all"], { cwd: worktree });
    if (!dirty.ok) throw commandFailure(dirty, `reading ${claim.worktree}`, "git");
    const changed = dirty.stdout.split("\n").filter((l) => l.trim());
    if (changed.length) throw new DeliveryError("refused", `${claim.worktree} has uncommitted changes`, { reasons: changed.slice(0, 10).map((l) => l.trim()) });

    const recorded = reviewedHeadOf(claim.last);
    if (!recorded) throw new DeliveryError("refused", `${key}'s claim records no reviewed head (its Last: line is not exactly "review PASS on <full commit id>")`);
    const reviewedHead = await this.commit(recorded, "the reviewed head");
    if (!claim.ref || !isTicketRecord(claim.ref, key)) throw new DeliveryError("refused", `${key}'s claim names ${claim.ref ?? "no file"} as its record, not context/tickets/${key}-<slug>.md`);
    let recordOnly: string[] = [];
    if (reviewedHead !== head) {
      if (!(await this.isAncestor(reviewedHead, head))) throw new DeliveryError("refused", `${head} does not build on the reviewed head ${reviewedHead}`);
      const files = (await this.gitOk(["diff", "--name-only", "--no-renames", reviewedHead, head], "listing post-review changes")).split("\n").filter(Boolean);
      const other = files.filter((f) => f !== claim.ref);
      if (other.length) throw new DeliveryError("refused", `commits after the reviewed head change more than the ticket record`, { reasons: other.slice(0, 10) });
      recordOnly = (await this.gitOk(["rev-list", `${reviewedHead}..${head}`], "listing post-review commits")).split("\n").filter(Boolean);
    }

    await this.checkDenylist(head);

    const base = await this.fetchBase();
    const mergeBase = await this.gitOk(["merge-base", base, head], "finding the merge base");
    if (!isSha(mergeBase)) throw new DeliveryError("refused", `${branch} shares no history with ${this.base}`);

    // Every commit that will be pushed, not only the combined diff: a secret added and later removed
    // is still in the pushed history. A merge commit is read against its first parent.
    const range = `${mergeBase}..${head}`;
    const patches = await this.gitOk(
      ["log", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "--diff-merges=first-parent", "--format=commit %H", range],
      "reading the commits to deliver",
      { timeoutMs: 60_000 },
    );
    const scan = scanDiff(patches);
    const messages = scanMessages(await this.gitOk(["log", "--format=%H%x1f%B%x1e", range], "reading the commit messages"));
    const findings = [...scan.findings, ...messages];
    if (findings.length)
      throw new DeliveryError("refused", `the commits to deliver contain what looks like a secret`, {
        reasons: findings.slice(0, 10).map((f) => `${f.commit ? `${f.commit.slice(0, 12)} ` : ""}${f.file}:${f.line} (${f.kind})`),
      });

    const merge = await this.git(["merge-tree", "--write-tree", base, head]);
    if (merge.code === 1) throw new DeliveryError("refused", `${branch} conflicts with ${this.base} ${base}`, { reasons: merge.stdout.split("\n").slice(1).filter(Boolean).slice(0, 10) });
    if (!merge.ok) throw commandFailure(merge, "computing the merge tree", "git");
    const tree = merge.stdout.split("\n")[0].trim();
    if (!isSha(tree)) throw new DeliveryError("failed", "merge-tree returned no tree");

    const insp: Inspection = {
      key,
      repo: this.cfg.repo,
      branch,
      worktree: claim.worktree!,
      title: claim.title,
      head,
      reviewedHead,
      recordOnly,
      recordPath: claim.ref,
      base,
      mergeBase,
      behind: mergeBase !== base,
      tree,
      unscanned: scan.binary,
      evidence: claim.last,
    };
    this.cfg.store.update(key, (s) => {
      s.repo = insp.repo;
      s.branch = branch;
      s.head = head;
      s.base = base;
      s.tree = tree;
      // An approval for another head, base or tree no longer holds; keep why, for the UI. This is
      // the permission for a new operation only: a recorded merge keeps its own approval in
      // `merged`, which no recheck touches.
      if (s.approval) {
        const reasons = approvalStaleness(s.approval, insp);
        if (reasons.length) {
          s.invalidated = { at: this.now().toISOString(), reasons, approval: s.approval };
          s.approval = null;
        }
      }
    });
    return insp;
  }

  /**
   * Denylisted commits must not be in the head's ancestry. A full id this
   * repository lacks cannot be; an abbreviation must resolve to exactly one
   * commit; anything else is refused, and never passed to git.
   */
  private async checkDenylist(head: string): Promise<void> {
    for (const entry of this.cfg.denylist ?? []) {
      if (!isDenylistEntry(entry)) throw new DeliveryError("invalid", `denylist entry ${JSON.stringify(String(entry)).slice(0, 80)} is not a commit id (7 to 40 lowercase hex digits)`);
      let sha = entry;
      if (isSha(entry)) {
        if (!(await this.git(["cat-file", "-e", `${entry}^{commit}`])).ok) continue;
      } else {
        const r = await this.git(["rev-parse", "--verify", "--quiet", `${entry}^{commit}`]);
        sha = r.stdout.trim();
        if (!r.ok || !isSha(sha)) throw new DeliveryError("refused", `denylist entry ${entry} does not resolve to exactly one commit (missing or ambiguous); list its full id`);
      }
      if (await this.isAncestor(sha, head)) throw new DeliveryError("refused", `denylisted commit ${sha} is reachable from ${head}`);
    }
  }

  /**
   * Records GitHub's report of the merge with the approval it was made under.
   * The first record is kept: a later report only fills in a merge commit GitHub
   * did not report at first, and a recorded approval is never replaced. `approval`
   * is the one this app's own merge command was sent under, or null for a merge
   * made outside the app (bound later, only by verification).
   */
  private recordMerged(key: string, pr: PrDetail, approval: Approval | null): void {
    if (pr.state !== "MERGED") throw new DeliveryError("refused", `PR #${pr.number} is ${pr.state}, not merged`);
    const commit = isSha(pr.mergeCommit) ? pr.mergeCommit : null;
    this.cfg.store.update(key, (s) => {
      if (!s.merged) {
        s.merged = { at: this.now().toISOString(), pr: pr.number, commit, approval: approval ? { ...approval, at: approval.at ?? this.now().toISOString() } : null, verification: null };
        s.verified = false;
      } else if (!s.merged.commit && commit && s.merged.pr === pr.number) {
        s.merged.commit = commit;
      }
      s.pendingMerge = null;
      s.mergeCommit = s.merged.commit;
      if (s.merged.pr === pr.number) s.pr = { number: pr.number, url: pr.url };
    });
  }

  private setPending(key: string, status: PendingMerge["status"], note: string, refusal?: string): void {
    this.cfg.store.update(key, (s) => {
      if (s.pendingMerge) s.pendingMerge = { ...s.pendingMerge, status, note, ...(refusal ? { refusal } : {}) };
    });
  }

  /** Re-reads the PR (after each delay) until GitHub reports it merged; null when it never does. */
  private async confirmMerged(n: number, delays: number[]): Promise<PrDetail | null> {
    for (const delay of [0, ...delays]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const pr = await this.forge.viewPr(n);
        if (pr.state === "MERGED") return pr;
      } catch {
        // not readable yet: read again, or settle it later
      }
    }
    return null;
  }

  /**
   * Settles a merge whose outcome was not confirmed, with reads only: GitHub's
   * PR state, then origin's base (`ls-remote`), then whether the approved head
   * or tree is now on it.
   * - Confirmed merged: GitHub reports the PR merged; recorded under the pending approval.
   * - Confirmed not merged: GitHub does not report it merged, origin has neither
   *   the approved head nor tree, and there is positive evidence it cannot merge
   *   later from this command: GitHub clearly refused it, the PR is closed, or (for
   *   an unclear failure only) more than `settleAfterMs`, longer than the merge
   *   timeout, has passed since it was sent. The pending record is then cleared
   *   and kept as `lastAttempt`, approval included.
   * - Anything else stays pending (the command exited 0: never settled by time)
   *   or unknown, keeps its approval, and throws, so no new merge is attempted.
   */
  private async reconcile(key: string, p: PendingMerge): Promise<{ merged: true } | { merged: false; reason: string }> {
    const pending = p.status === "confirmation-pending";
    const hold = (why: string): never => {
      if (pending)
        throw new DeliveryError(
          "blocked",
          `the merge of PR #${p.pr} is pending (its command succeeded; GitHub has not confirmed it), so whether it merged is still unknown: ${why}. Nothing is merged again until GitHub confirms it or the PR is closed; check again later, or leave it to the human`,
        );
      throw new DeliveryError("blocked", `whether PR #${p.pr} merged is still unknown: ${why}. Nothing is merged again until it is settled; check again in a moment, or leave it to the human`);
    };
    let pr: PrDetail;
    try {
      pr = await this.forge.viewPr(p.pr);
    } catch (e) {
      return hold(`GitHub could not be read (${e instanceof Error ? e.message : String(e)})`);
    }
    if (pr.state === "MERGED") {
      this.recordMerged(key, pr, p.approval);
      return { merged: true };
    }
    let main: string | null;
    try {
      main = await this.remoteHead(this.base);
    } catch (e) {
      return hold(`origin ${this.base} could not be read (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!main) return hold(`origin has no ${this.base}`);
    let where: string;
    if (main === p.approval.base) {
      where = `origin ${this.base} is still at the approved base ${p.approval.base}`;
    } else {
      let landed: string | null;
      try {
        landed = await this.landedOnBase(p.approval);
      } catch (e) {
        return hold(`origin ${this.base} could not be compared with the approval (${e instanceof Error ? e.message : String(e)})`);
      }
      if (landed) {
        const note = `GitHub reports PR #${p.pr} ${pr.state}, but origin ${this.base} already has ${landed} with the approved head or tree: confirmation pending`;
        this.setPending(key, "confirmation-pending", note);
        return hold(note);
      }
      where = `origin ${this.base} (${main}) has neither the approved head nor the approved tree`;
    }
    // Nothing has landed yet. Only positive evidence settles it as not merged.
    const elapsed = this.now().getTime() - Date.parse(p.at);
    const evidence =
      pr.state === "CLOSED"
        ? `PR #${p.pr} is closed without merging`
        : p.status === "refused"
          ? `GitHub refused the merge command (${p.refusal ?? p.note})`
          : !pending && elapsed > this.settleAfterMs
            ? `no merge ${Math.round(elapsed / 1000)} s after the command was sent, longer than the merge timeout`
            : null;
    if (!evidence) {
      if (pending) return hold(`GitHub reports PR #${p.pr} ${pr.state} and ${where} yet; a merge whose command succeeded (e.g. queued) can still land`);
      const left = Number.isFinite(elapsed) ? `; it is settled only once ${Math.round(this.settleAfterMs / 1000)} s, longer than the merge timeout, have passed since the command with nothing landed (${Math.max(0, Math.round(elapsed / 1000))} s so far)` : "";
      return hold(`GitHub reports PR #${p.pr} ${pr.state} and ${where}, but the command's failure was unclear and GitHub may still complete it${left}`);
    }
    const reason = `GitHub reports PR #${p.pr} ${pr.state}, ${where}, and ${evidence}`;
    const settled: SettledAttempt = { at: p.at, pr: p.pr, approval: p.approval, outcome: "not-merged", settledAt: this.now().toISOString(), reason };
    this.cfg.store.update(key, (s) => {
      if (s.pendingMerge && s.pendingMerge.pr === p.pr && s.pendingMerge.at === p.at) {
        s.pendingMerge = null;
        s.lastAttempt = settled;
      }
    });
    return { merged: false, reason };
  }

  /** A commit on the fetched base that is the approved head, or has the approved tree after the approved base; null when there is none. */
  private async landedOnBase(a: Approval): Promise<string | null> {
    const main = await this.fetchBase();
    if (main === a.head || (await this.isAncestor(a.head, main))) return a.head;
    const log = await this.gitOk(["log", "--first-parent", "--format=%H %T", "--max-count=1000", `${a.base}..${main}`], `reading origin/${this.base} since the approved base`);
    for (const line of log.split("\n")) {
      const [commit, tree] = line.trim().split(" ");
      if (isSha(commit) && tree === a.tree) return commit;
    }
    return null;
  }

  /** The recorded merge, verified (again) against the approval it is bound to. Never merges. */
  private async alreadyMerged(key: string, offered: Approval[] = []): Promise<{ data: MergeResult; message: string }> {
    const v = await this.verifyRecorded(key, offered);
    const s = this.cfg.store.read(key);
    const n = s.merged!.pr;
    const url = s.pr?.number === n ? s.pr.url : `https://github.com/${this.cfg.repo}/pull/${n}`;
    return { data: { pr: { number: n, url }, mergeCommit: v.mergeCommit, already: true, checks: null, evidence: null }, message: `PR #${n} was already merged; verified ${v.mergeCommit}` };
  }

  /**
   * Verifies the recorded merge against the approval it is bound to. A merge
   * with no bound approval (made outside the app) is checked against the
   * approvals on record (the last settled attempt, the invalidated and current
   * approvals) and any `offered` by the caller, and the first that verifies is
   * bound for good; one that does not verify is never kept. A merge that was
   * never verified stays merged-but-unverified when this fails (it is never
   * merged again); a merge that was verified stays verified, and the failed
   * re-check is reported.
   */
  private async verifyRecorded(key: string, offered: Approval[] = []): Promise<VerifyResult> {
    const before = this.cfg.store.read(key);
    let rec = before.merged;
    if (!rec) throw new DeliveryError("refused", `no merge is recorded for ${key}`);
    try {
      if (!rec.commit) {
        this.recordMerged(key, await this.forge.viewPr(rec.pr), null);
        rec = this.cfg.store.read(key).merged!;
        if (!rec.commit) throw new DeliveryError("failed", `GitHub reports no merge commit for PR #${rec.pr}`);
      }
      const candidates = rec.approval ? [rec.approval] : approvalCandidates(key, [before.lastAttempt?.approval, before.invalidated?.approval, before.approval, ...offered]);
      if (!candidates.length) throw new DeliveryError("refused", "no approval is recorded to verify it against; approve the head, base and tree it was merged from, then verify");
      const main = await this.fetchBase();
      const errors: string[] = [];
      for (const a of candidates) {
        let v: VerifyResult;
        try {
          v = await this.checkMergeCommit(rec.commit, a, main);
        } catch (e) {
          if (!(e instanceof DeliveryError) || e.kind !== "failed" || candidates.length === 1) throw e;
          errors.push(e.message);
          continue;
        }
        const bound: Approval = { ...a, at: a.at ?? this.now().toISOString() };
        this.cfg.store.update(key, (s) => {
          s.mergeCommit = v.mergeCommit;
          s.verified = true;
          if (s.merged) {
            if (!s.merged.approval) s.merged.approval = bound;
            s.merged.verification = { at: this.now().toISOString(), parent: v.parent, tree: v.tree, main: v.main };
          }
        });
        return v;
      }
      throw new DeliveryError("failed", `no recorded or offered approval matches it (${errors.join("; ")})`);
    } catch (e) {
      const err = e instanceof DeliveryError ? e : new DeliveryError("failed", e instanceof Error ? e.message : String(e));
      if (before.verified && rec.verification)
        throw new DeliveryError("failed", `PR #${rec.pr} was verified as ${rec.commit} at ${rec.verification.at} and stays verified; this re-check failed: ${err.message}`, { reasons: err.reasons });
      throw new DeliveryError("failed", `PR #${rec.pr} is merged${rec.commit ? ` as ${rec.commit}` : ""} but NOT verified: ${err.message}. Do not merge again; verify it, or leave it to the human`, { reasons: err.reasons });
    }
  }

  /** The merge commit is one squash commit on the approved base, with the approved tree, and it is on the base branch (`main`, freshly fetched). */
  private async checkMergeCommit(m: string, a: Approval, main: string): Promise<VerifyResult> {
    const parents = (await this.gitOk(["rev-list", "--parents", "-n", "1", m], `reading ${m}`)).split(/\s+/).filter(Boolean).slice(1);
    if (parents.length !== 1) throw new DeliveryError("failed", `${m} is not a squash commit (${parents.length} parents)`);
    const [parent] = parents;
    if (parent !== a.base) throw new DeliveryError("failed", `${m}'s parent is ${parent}, not the approved base ${a.base}`);
    const tree = await this.gitOk(["rev-parse", "--verify", `${m}^{tree}`], `reading ${m}'s tree`);
    if (tree !== a.tree) throw new DeliveryError("failed", `${m}'s tree is ${tree}, not the expected ${a.tree}`);
    if (m !== main && !(await this.isAncestor(m, main))) throw new DeliveryError("failed", `${m} is not on ${this.base} (${main})`);
    return { mergeCommit: m, parent, tree, main };
  }
}

/** Distinct, well-formed approvals for this key, in order (the same head, base and tree once). */
function approvalCandidates(key: string, list: (Approval | null | undefined)[]): Approval[] {
  const out: Approval[] = [];
  for (const a of list) {
    if (!a || a.key !== key || !isSha(a.head) || !isSha(a.base) || !isSha(a.tree)) continue;
    if (!out.some((b) => b.head === a.head && b.base === a.base && b.tree === a.tree)) out.push(a);
  }
  return out;
}

function text(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !v.trim()) throw new DeliveryError("invalid", "title and body must be non-empty text");
  if (v.length > max) throw new DeliveryError("invalid", `text longer than ${max} characters`);
  return redact(v);
}

