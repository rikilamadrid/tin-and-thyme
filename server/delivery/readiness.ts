// "Ready to deliver", read from the orchestrate engine (read-only: `status
// --json`, `board --json` and `owner <key> --json`) and local git refs, so it
// works the same in the kitchen and in a preview that has no Pathfinder run.
//
// A ticket is ready when:
// - the engine row is `done`, its claim's `Last:` line is exactly
//   `review PASS on <full sha>` (ops.ts reviewedHeadOf), and the claim is a live
//   worktree on ticket/<key>-*;
// - every ticket under its `## Blocked by` is Complete in the store, read from
//   the engine's own board (the rule `/ticket load` and the board apply);
// - its branch is not stacked: it carries no commits that are neither on
//   origin/main (by ancestry, or by tree as for a squash merge, the engine's
//   `release` rule) nor the ticket's own. The ticket's own commits are those
//   after its claim ref (`refs/pathfinder/claims/<key>`, the commit the claim
//   started from); a parent is another ticket branch whose own commits (after
//   its claim ref) the branch contains. Delivering a stacked ticket would squash
//   its unmerged parents into main under one PR.
// It fails closed: a board or a git read that fails makes the ticket not ready.
// The kitchen re-reads this, after fetching origin/main, before every delivery
// operation that leads to a write (service.ts), so the server enforces it, not
// only the drawer.

import { statSync } from "node:fs";
import type { RunResult } from "../lib/exec";
import { isAbsolute, join } from "node:path";
import type { DeliveryReadiness } from "../../src/data/delivery";
import { parseCliJson } from "../lib/json";
import type { Runner } from "./forge";
import { isSha, isTicketBranch, reviewedHeadOf } from "./ops";
import { isTicketKey, redact } from "./state";

export interface ReadinessRow {
  key: string;
  title: string | null;
  readiness: DeliveryReadiness;
}

interface StatusRow {
  key?: unknown;
  state?: unknown;
  title?: unknown;
  updated?: unknown;
}

interface OwnerClaim {
  branch?: unknown;
  worktree?: unknown;
  orphan?: unknown;
  state?: unknown;
  last?: unknown;
}

interface BoardTicket {
  key?: unknown;
  status?: unknown;
  blockers?: unknown;
}

/** What stands between a done ticket and delivery besides its claim: unfinished blockers, and stacking. */
export interface DeliveryWait {
  /** `Blocked by` tickets that are not Complete (or a reason the store could not answer). */
  blockers: { key: string; status: string }[] | { error: string };
  /** The branch carries other tickets' unmerged commits (or a reason it could not be told). */
  stack: { parents: string[]; reason: string } | { error: string } | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The unfinished blockers of `key`, as the engine's board reads the store. Pure. */
export function waitingBlockers(tickets: BoardTicket[], key: string): DeliveryWait["blockers"] {
  const byKey = new Map(tickets.filter((t) => isTicketKey(t.key)).map((t) => [t.key as string, t]));
  const me = byKey.get(key);
  if (!me) return { error: `${key} is not in the ticket store` };
  const blockers = Array.isArray(me.blockers) ? me.blockers.filter((b): b is string => typeof b === "string") : [];
  return blockers.flatMap((b) => {
    const t = byKey.get(b);
    const status = t ? (str(t.status) ?? "unrecognised") : "missing from the store";
    return status === "Complete" ? [] : [{ key: b, status }];
  });
}

export function engineOf(root: string): string {
  return join(root, "skills", "orchestrate", "engine", "bin", "orchestrate.mjs");
}

/**
 * The readiness a claim gives a `done` row, with what else it waits on. Pure, for
 * tests. Without `wait`, only the claim is judged (the Readiness class always
 * passes it, failing closed).
 */
export function readinessOf(key: string, engineState: string | null, claim: OwnerClaim | null, wait?: DeliveryWait): DeliveryReadiness {
  const base = { engineState, reviewedHead: null, branch: null, ready: false, waitingOn: [] as string[], stacked: false };
  if (engineState !== "done") return { ...base, reason: engineState ? `the engine reports ${key} as ${engineState}, not done` : `the engine has no row for ${key}` };
  if (!claim) return { ...base, reason: `${key} has no engine claim` };
  const branch = str(claim.branch);
  const reviewedHead = reviewedHeadOf(str(claim.last));
  const out = { ...base, branch, reviewedHead };
  if (!branch || !isTicketBranch(branch, key)) return { ...out, reason: `the claim is on ${branch ?? "no branch"}, not ticket/${key}-<slug>` };
  if (claim.orphan === true || !str(claim.worktree)) return { ...out, reason: "the claim has no live worktree" };
  if (!reviewedHead) return { ...out, reason: `no recorded review PASS: the claim's Last: line is not exactly "review PASS on <full commit id>"` };
  if (wait) {
    if ("error" in wait.blockers) return { ...out, reason: `its blockers cannot be read: ${wait.blockers.error}` };
    const stack = wait.stack;
    if (stack && "error" in stack) return { ...out, reason: `whether its branch is stacked cannot be told: ${stack.error}` };
    const unfinished = wait.blockers;
    if (stack) {
      const keys = [...new Set([...stack.parents, ...unfinished.map((b) => b.key)])];
      return { ...out, waitingOn: keys, stacked: true, reason: `Waiting on ${keys.join(", ") || "unmerged commits"} (stacked): ${stack.reason}` };
    }
    if (unfinished.length)
      return { ...out, waitingOn: unfinished.map((b) => b.key), reason: `Waiting on ${unfinished.map((b) => `${b.key} (${b.status}, not Complete)`).join(", ")}: every ticket it is blocked by must be Complete` };
  }
  return { ...out, ready: true, reason: null };
}

/**
 * The claim's state file as it is on disk now (`<worktree>/context/current-ticket.md`):
 * its `Last:` line can change while the engine row's `Updated` does not.
 */
function stateFileStamp(root: string, claim: OwnerClaim | null): string {
  const worktree = claim ? str(claim.worktree) : null;
  if (!worktree) return "none";
  try {
    const st = statSync(isAbsolute(worktree) ? join(worktree, "context", "current-ticket.md") : join(root, worktree, "context", "current-ticket.md"));
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "none";
  }
}

interface Refs {
  main: string;
  branches: Map<string, { branch: string; head: string }[]>;
  claims: Map<string, string>;
  stamp: string;
}

export class Readiness {
  /**
   * Owner answers by key, reused while the row's state and update time are
   * unchanged and the claim's state file is untouched (a new `Last:` line is
   * read even when `Updated` stays the same).
   */
  private owners = new Map<string, { stamp: string; file: string; claim: OwnerClaim | null }>();
  /** Stacking answers by key, reused while no ticket branch, claim ref or origin/main moved. */
  private stacks = new Map<string, { stamp: string; stack: DeliveryWait["stack"] }>();

  constructor(
    private readonly runner: Runner,
    private readonly root: string,
    private readonly engine = engineOf(root),
    private readonly base = "main",
  ) {}

  /** Every engine row with its readiness; throws when the engine cannot be read. */
  async read(): Promise<ReadinessRow[]> {
    const r = await this.runner("node", [this.engine, "status", "--json"], { cwd: this.root, timeoutMs: 30_000 });
    const out = parseCliJson<{ ok?: boolean; rows?: StatusRow[] }>(r.stdout);
    if (!out || !Array.isArray(out.rows)) throw new Error(`cannot read the engine's status: ${redact((r.stderr || "no output").split("\n")[0])}`);
    const rows: ReadinessRow[] = [];
    let board: BoardTicket[] | { error: string } | null = null;
    let refs: Refs | { error: string } | null = null;
    for (const row of out.rows) {
      const key = str(row.key);
      if (!key || !isTicketKey(key)) continue;
      const state = str(row.state);
      let claim: OwnerClaim | null = null;
      if (state === "done") {
        const stamp = `${state}|${str(row.updated) ?? ""}`;
        const cached = this.owners.get(key);
        if (cached && cached.stamp === stamp && cached.file === stateFileStamp(this.root, cached.claim)) claim = cached.claim;
        else {
          claim = await this.owner(key);
          this.owners.set(key, { stamp, file: stateFileStamp(this.root, claim), claim });
        }
      }
      let wait: DeliveryWait | undefined;
      if (state === "done" && claim) {
        board ??= await this.board();
        refs ??= await this.refs();
        wait = { blockers: "error" in board ? board : waitingBlockers(board, key), stack: await this.stackOf(key, str(claim.branch), refs) };
      }
      rows.push({ key, title: str(row.title), readiness: readinessOf(key, state, claim, wait) });
    }
    return rows;
  }

  /** Forgets cached claims and stacking (after an operation, either may have changed). */
  forget(key?: string): void {
    if (key) {
      this.owners.delete(key);
      this.stacks.delete(key);
    } else {
      this.owners.clear();
      this.stacks.clear();
    }
  }

  /** The store's tickets with their status and blockers, from the engine's board (read-only). */
  private async board(): Promise<BoardTicket[] | { error: string }> {
    const r = await this.runner("node", [this.engine, "board", "--json"], { cwd: this.root, timeoutMs: 30_000 });
    const out = parseCliJson<{ tickets?: BoardTicket[] }>(r.stdout);
    if (!out || !Array.isArray(out.tickets)) return { error: `the engine's board could not be read (${redact((r.stderr || "no output").split("\n")[0])})` };
    return out.tickets;
  }

  private git(args: string[]): Promise<RunResult> {
    return this.runner("git", args, { cwd: this.root, timeoutMs: 20_000 });
  }

  /** Every ticket branch head and claim ref, and origin/main as last fetched (local main if never fetched). */
  private async refs(): Promise<Refs | { error: string }> {
    const list = await this.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/ticket/", "refs/pathfinder/claims/"]);
    if (!list.ok) return { error: "the ticket branches could not be listed" };
    let main = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${this.base}^{commit}`]);
    if (!main.ok || !isSha(main.stdout.trim())) main = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${this.base}^{commit}`]);
    const mainSha = main.stdout.trim();
    if (!main.ok || !isSha(mainSha)) return { error: `${this.base} cannot be resolved` };
    const branches = new Map<string, { branch: string; head: string }[]>();
    const claims = new Map<string, string>();
    for (const line of list.stdout.split("\n")) {
      const [sha, ref] = line.trim().split(" ");
      if (!isSha(sha) || !ref) continue;
      const b = /^refs\/heads\/(ticket\/(\d+\.\d+)-.+)$/.exec(ref);
      if (b) branches.set(b[2], [...(branches.get(b[2]) ?? []), { branch: b[1], head: sha }]);
      const c = /^refs\/pathfinder\/claims\/(\d+\.\d+)$/.exec(ref);
      if (c) claims.set(c[1], sha);
    }
    return { main: mainSha, branches, claims, stamp: `${mainSha}|${list.stdout}` };
  }

  /** Whether `key`'s branch carries other tickets' unmerged commits; null when it does not. */
  private async stackOf(key: string, branch: string | null, refs: Refs | { error: string }): Promise<DeliveryWait["stack"]> {
    if ("error" in refs) return refs;
    const cached = this.stacks.get(key);
    if (cached && cached.stamp === `${branch}|${refs.stamp}`) return cached.stack;
    let stack: DeliveryWait["stack"];
    try {
      stack = await this.computeStack(key, branch, refs);
    } catch (e) {
      stack = { error: redact(e instanceof Error ? e.message : String(e)) };
    }
    this.stacks.set(key, { stamp: `${branch}|${refs.stamp}`, stack });
    return stack;
  }

  private async computeStack(key: string, branch: string | null, refs: Refs): Promise<DeliveryWait["stack"]> {
    const head = (refs.branches.get(key) ?? []).find((b) => b.branch === branch)?.head;
    if (!head) throw new Error(`${branch ?? "the claim's branch"} is not a local branch`);
    const start = refs.claims.get(key);
    if (!start) throw new Error(`${key} has no claim ref (refs/pathfinder/claims/${key}) to tell its own commits from others'`);
    const ancestor = async (a: string, b: string) => {
      const r = await this.git(["merge-base", "--is-ancestor", a, b]);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      throw new Error(`git could not compare ${a} and ${b}`);
    };
    // On origin/main by ancestry, or by tree (a squash merge): the engine's `release` rule.
    const onMain = async (c: string) => {
      if (await ancestor(c, refs.main)) return true;
      const merged = await this.git(["merge-tree", "--write-tree", refs.main, c]);
      const tree = await this.git(["rev-parse", "--verify", `${refs.main}^{tree}`]);
      return merged.ok && tree.ok && merged.stdout.split("\n")[0].trim() === tree.stdout.trim();
    };
    // A branch that no longer contains its claim's start was rewritten; its own commits cannot be told apart.
    if (!(await ancestor(start, head))) throw new Error(`${branch} no longer contains its claim's start ${start.slice(0, 12)}; its own commits cannot be told from others'`);
    const parents: string[] = [];
    for (const [other, list] of refs.branches) {
      if (other === key) continue;
      const otherStart = refs.claims.get(other);
      for (const b of list) {
        const mb = await this.git(["merge-base", head, b.head]);
        const shared = mb.stdout.trim();
        if (!mb.ok || !isSha(shared)) continue;
        // Shared beyond this ticket's start: that branch builds on this one, not the other way round.
        if (!(await ancestor(shared, start))) continue;
        // Shared only up to where that ticket started: a sibling on the same base, not a parent.
        if (otherStart && (await ancestor(shared, otherStart))) continue;
        if (await onMain(shared)) continue;
        if (!parents.includes(other)) parents.push(other);
      }
    }
    const startForeign = !(await onMain(start));
    if (!parents.length && !startForeign) return null;
    return {
      parents: parents.sort(),
      reason: parents.length
        ? `${branch} contains ${parents.join(", ")}'s commits that are not on origin/${this.base}; deliver ${parents.length === 1 ? "it" : "them"} first, then rebase and re-review`
        : `${branch} starts from ${start.slice(0, 12)}, which is not on origin/${this.base}`,
    };
  }

  private async owner(key: string): Promise<OwnerClaim | null> {
    const r = await this.runner("node", [this.engine, "owner", key, "--json"], { cwd: this.root, timeoutMs: 20_000 });
    const out = parseCliJson<{ claim?: OwnerClaim | null }>(r.stdout);
    return out?.claim ?? null;
  }
}
