// "Ready to deliver", read from the orchestrate engine only (read-only:
// `status --json` and `owner <key> --json`), so it works the same in the kitchen
// and in a preview that has no Pathfinder run.
//
// A ticket is ready when the engine row is `done`, its claim's `Last:` line is
// exactly `review PASS on <full sha>` (ops.ts reviewedHeadOf), and the claim is a
// live worktree on ticket/<key>-*. The delivery operations re-check all of this
// themselves before any write; this only decides what the kitchen offers.

import { join } from "node:path";
import type { DeliveryReadiness } from "../../src/data/delivery";
import { parseCliJson } from "../lib/json";
import type { Runner } from "./forge";
import { isTicketBranch, reviewedHeadOf } from "./ops";
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

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function engineOf(root: string): string {
  return join(root, "skills", "orchestrate", "engine", "bin", "orchestrate.mjs");
}

/** The readiness a claim gives a `done` row. Pure, for tests. */
export function readinessOf(key: string, engineState: string | null, claim: OwnerClaim | null): DeliveryReadiness {
  const base = { engineState, reviewedHead: null, branch: null, ready: false };
  if (engineState !== "done") return { ...base, reason: engineState ? `the engine reports ${key} as ${engineState}, not done` : `the engine has no row for ${key}` };
  if (!claim) return { ...base, reason: `${key} has no engine claim` };
  const branch = str(claim.branch);
  const reviewedHead = reviewedHeadOf(str(claim.last));
  const out = { ...base, branch, reviewedHead };
  if (!branch || !isTicketBranch(branch, key)) return { ...out, reason: `the claim is on ${branch ?? "no branch"}, not ticket/${key}-<slug>` };
  if (claim.orphan === true || !str(claim.worktree)) return { ...out, reason: "the claim has no live worktree" };
  if (!reviewedHead) return { ...out, reason: `no recorded review PASS: the claim's Last: line is not exactly "review PASS on <full commit id>"` };
  return { ...out, ready: true, reason: null };
}

export class Readiness {
  /** Owner answers by key, reused while the row's state and update time are unchanged. */
  private owners = new Map<string, { stamp: string; claim: OwnerClaim | null }>();

  constructor(
    private readonly runner: Runner,
    private readonly root: string,
    private readonly engine = engineOf(root),
  ) {}

  /** Every engine row with its readiness; throws when the engine cannot be read. */
  async read(): Promise<ReadinessRow[]> {
    const r = await this.runner("node", [this.engine, "status", "--json"], { cwd: this.root, timeoutMs: 30_000 });
    const out = parseCliJson<{ ok?: boolean; rows?: StatusRow[] }>(r.stdout);
    if (!out || !Array.isArray(out.rows)) throw new Error(`cannot read the engine's status: ${redact((r.stderr || "no output").split("\n")[0])}`);
    const rows: ReadinessRow[] = [];
    for (const row of out.rows) {
      const key = str(row.key);
      if (!key || !isTicketKey(key)) continue;
      const state = str(row.state);
      let claim: OwnerClaim | null = null;
      if (state === "done") {
        const stamp = `${state}|${str(row.updated) ?? ""}`;
        const cached = this.owners.get(key);
        if (cached && cached.stamp === stamp) claim = cached.claim;
        else {
          claim = await this.owner(key);
          this.owners.set(key, { stamp, claim });
        }
      }
      rows.push({ key, title: str(row.title), readiness: readinessOf(key, state, claim) });
    }
    return rows;
  }

  /** Forgets cached claims (after an operation, the claim may have changed). */
  forget(key?: string): void {
    if (key) this.owners.delete(key);
    else this.owners.clear();
  }

  private async owner(key: string): Promise<OwnerClaim | null> {
    const r = await this.runner("node", [this.engine, "owner", key, "--json"], { cwd: this.root, timeoutMs: 20_000 });
    const out = parseCliJson<{ claim?: OwnerClaim | null }>(r.stdout);
    return out?.claim ?? null;
  }
}
