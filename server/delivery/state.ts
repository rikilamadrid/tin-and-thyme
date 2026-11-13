// Per-ticket delivery state, kept in ~/.controlroom/<kitchen>/deliveries/<key>.json,
// and the redaction every stored or returned message goes through.
//
// The state survives reconnects and kitchen restarts: each operation records its
// step result here, so the UI can show exactly which steps succeeded. Nothing in
// this file talks to git or GitHub.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- redaction

/**
 * Token-shaped text. Redaction is deliberately broad: anything that looks like a
 * credential in a message is replaced, even at the cost of hiding something
 * harmless. (The diff secret scan in ops.ts is stricter, so ordinary code that
 * merely mentions an Authorization header is not refused.)
 */
const REDACTIONS: [RegExp, string][] = [
  // `Authorization: Bearer …`, `authorization=…`: keep the header name, drop the rest of the line.
  [/(authorization\s*[:=]\s*)[^\r\n]*/gi, "$1[REDACTED]"],
  // GitHub tokens: ghp_, gho_, ghs_, ghu_, ghr_, and fine-grained github_pat_.
  [/\bgh[oprsu]_[A-Za-z0-9]{8,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "[REDACTED]"],
  // Credentials embedded in a URL: https://user:secret@host → https://[REDACTED]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@"],
  // Other common provider tokens.
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[REDACTED]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
];

/** Replaces token-shaped text. Safe to call on any string, any number of times. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** Redacts every string inside a JSON-shaped value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------- errors

/**
 * Why an operation stopped:
 * - `auth`: the human's `gh` / git sign-in is missing or refused (has an actionable fix);
 * - `invalid`: a parameter or the repository/branch/claim failed validation;
 * - `refused`: a safety rule refused the write (different remote head, dirty worktree, secret found…);
 * - `stale`: the approval no longer matches the head or base;
 * - `blocked`: GitHub state blocks it for now (failed or pending checks, not mergeable);
 * - `failed`: a command failed for another reason.
 */
export type FailureKind = "auth" | "invalid" | "refused" | "stale" | "blocked" | "failed";

/** The sign-in fix shown in the app (run through the existing setup fix). */
export const AUTH_FIX = "gh auth login --web";

export class DeliveryError extends Error {
  readonly kind: FailureKind;
  readonly fix: string | null;
  readonly reasons: string[];
  constructor(kind: FailureKind, message: string, opts: { fix?: string; reasons?: string[] } = {}) {
    super(redact(message));
    this.kind = kind;
    this.fix = opts.fix ?? (kind === "auth" ? AUTH_FIX : null);
    this.reasons = (opts.reasons ?? []).map(redact);
  }
}

// ---------------------------------------------------------------- shapes

export const STEPS = ["inspect", "approve", "push", "ensurePr", "status", "merge", "verify", "reconcile", "records", "handback", "plan"] as const;
export type StepName = (typeof STEPS)[number];

export interface StepResult {
  step: StepName;
  ok: boolean;
  at: string;
  message: string;
  kind?: FailureKind;
  fix?: string | null;
  reasons?: string[];
}

/** The exact thing the human approved: this head, onto this base, giving this tree. */
export interface Approval {
  key: string;
  head: string;
  base: string;
  tree: string;
  /** Required when GitHub reports no checks: the human merges on the local evidence. */
  acknowledgeNoChecks?: boolean;
  at?: string;
}

/**
 * A merge as GitHub reported it. Once recorded it is never erased. It is
 * evidence of what was merged, never permission for a new push or merge (that
 * is `DeliveryState.approval`, and a recorded merge is never merged again
 * whatever approval a later call carries).
 *
 * `approval` is the approval the merge is bound to, and once set it is never
 * replaced: every later check verifies against it.
 * - A merge this app sent (a `pendingMerge` existed) is bound at once to the
 *   approval the command was sent under.
 * - A merge made outside the app is recorded with no approval
 *   (merged-unverified). An approval is bound to it only once it verifies
 *   (the merge commit's parent is its base and its tree is its tree), so a
 *   wrong or post-merge approval never becomes permanent and a correct one can
 *   still verify it later.
 */
export interface MergeRecord {
  at: string;
  pr: number;
  commit: string | null;
  /** The exact approval (head, base, tree, at) the merge is bound to; null until one verifies (outside merges). */
  approval: Approval | null;
  /** The last successful verification of the merge commit against that approval. */
  verification: { at: string; parent: string; tree: string; main: string } | null;
}

/**
 * A merge command whose outcome GitHub has not confirmed. Written immediately
 * before the command is sent, so an interrupted merge is never mistaken for
 * "not merged". Its approval is kept until the outcome is confirmed, and no new
 * merge is attempted until it is settled, with reads only.
 * - `sent`: the command was sent and no outcome was recorded (e.g. interrupted): unknown;
 * - `confirmation-pending`: the command exited 0, or origin already has the
 *   approved head or tree, but GitHub does not report the PR merged yet:
 *   pending. It is never settled as not merged by time (a queued or async merge
 *   can land much later); only GitHub reporting it merged, or the PR closed, settles it;
 * - `unknown`: the command failed unclearly (timeout, kill, 5xx, network): unknown;
 * - `refused`: GitHub clearly refused the command (`refusal`): settled as not
 *   merged once GitHub and origin confirm nothing landed.
 */
export interface PendingMerge {
  at: string;
  pr: number;
  approval: Approval;
  status: "sent" | "confirmation-pending" | "unknown" | "refused";
  note: string;
  /** GitHub's clear refusal, when `status` is `refused`. */
  refusal?: string;
}

/**
 * The last merge attempt that was settled as confirmed not merged, with the
 * approval it was sent under and the positive evidence. Kept so that a merge
 * landing even later can still be verified against that original approval.
 */
export interface SettledAttempt {
  at: string;
  pr: number;
  approval: Approval;
  outcome: "not-merged";
  settledAt: string;
  reason: string;
}

/**
 * The four merge outcomes, kept apart (plus `none`, nothing sent):
 * - `pending`: the command exited 0 but GitHub has not confirmed the merge;
 * - `unknown`: the command failed unclearly, was interrupted, or is not settled yet;
 * - `merged`: GitHub reports the PR merged (verified or not: see `verified`);
 * - `not-merged`: confirmed not merged on positive evidence (a clear refusal,
 *   the PR closed, or no merge long after the merge timeout).
 */
export type MergeOutcome = "none" | "pending" | "unknown" | "merged" | "not-merged";

export function mergeOutcome(s: Pick<DeliveryState, "merged" | "pendingMerge" | "lastAttempt">): MergeOutcome {
  if (s.merged) return "merged";
  if (s.pendingMerge) return s.pendingMerge.status === "confirmation-pending" ? "pending" : "unknown";
  if (s.lastAttempt?.outcome === "not-merged") return "not-merged";
  return "none";
}

/** After a verified merge: the main checkout was reconciled (reconcile.ts). */
export interface ReconcileRecord {
  at: string;
  /** Local main before and after; equal when it already contained the merge. */
  before: string;
  after: string;
  /** origin/main as fetched, which contains the merge. */
  target: string;
  mergeCommit: string;
  /** ~/.controlroom/<kitchen>/backups/<ts>, when anything was moved. */
  backup: string | null;
  moved: number;
  preserved: number;
}

/**
 * The one marked request to the coordinator (handback.ts). Recorded before it
 * is typed, so it is never typed twice for the same marker:
 * - `sending`: recorded, being typed (left behind only when the kitchen stopped mid-send);
 * - `sent`: the coordinator's terminal took it;
 * - `unconfirmed`: the terminal did not confirm it; only the human's explicit retry types it again.
 */
export interface HandbackRecord {
  marker: string;
  at: string;
  status: "sending" | "sent" | "unconfirmed";
  note: string;
  attempts: number;
}

/** The last read-only `orchestrate plan --json`, for the tickets this completion made eligible. */
export interface PlanRecord {
  at: string;
  outcome: string;
  message: string;
  /** Eligible now: the plan's dispatch and deferred entries. */
  eligible: { key: string; title: string; deferred: string | null }[];
  /** Still blocked by this ticket. */
  waitingOn: { key: string; title: string }[];
  /** Eligible now and waiting on this ticket in the previous plan. */
  newly: string[];
}

/**
 * The completion records prepared after a verified merge (records.ts), on the
 * ticket's own state. Either a records commit for `ticket/<key>-records`, cut
 * from local main once it contains the implementation merge and the claim is
 * released, or `onMain`: local main already records the ticket Complete, so
 * there is nothing to deliver.
 */
export interface RecordsPrepRecord {
  at: string;
  /** The branch on origin the records are delivered from. */
  branch: string;
  /** The local ref that holds the commit (`refs/tin-and-thyme/records/<key>`). */
  ref: string;
  /** The records commit; null when `onMain`. */
  head: string | null;
  /** The main commit it was cut from (or read, when `onMain`). */
  parent: string;
  /** The implementation merge it follows. */
  mergeCommit: string;
  /** What it changes, one line per file. */
  changes: string[];
  onMain: boolean;
}

/** Which delivery a state file belongs to: the ticket's implementation, or its completion records (`<key>.records.json`). */
export type DeliveryTrack = "ticket" | "records";

export interface DeliveryState {
  schema: "tin-and-thyme.delivery/1";
  key: string;
  repo: string | null;
  branch: string | null;
  /** The last inspected head, base, and expected merge tree. */
  head: string | null;
  base: string | null;
  tree: string | null;
  pr: { number: number; url: string } | null;
  approval: Approval | null;
  /** Why the last approval stopped being valid, for the UI. */
  invalidated: { at: string; reasons: string[]; approval: Approval } | null;
  /**
   * Set as soon as GitHub reports the PR merged, before verification runs, so a
   * merge whose verification fails or is interrupted is recorded as
   * merged-but-unverified (`merged` set, `verified` false), never as "not merged".
   */
  merged: MergeRecord | null;
  /** A merge command sent whose outcome is not confirmed yet; see PendingMerge. */
  pendingMerge: PendingMerge | null;
  /** The last attempt settled as confirmed not merged; see SettledAttempt. */
  lastAttempt: SettledAttempt | null;
  mergeCommit: string | null;
  verified: boolean;
  /** After the merge: the main checkout reconciled, the handback, the refreshed plan. */
  reconciled: ReconcileRecord | null;
  handback: HandbackRecord | null;
  plan: PlanRecord | null;
  /** The completion records prepared for this ticket (the ticket's own state only). */
  recordsPrep: RecordsPrepRecord | null;
  steps: Partial<Record<StepName, StepResult>>;
  /** Every step result, newest last, capped. */
  history: StepResult[];
  updated: string;
}

const HISTORY_LIMIT = 100;

export function emptyState(key: string): DeliveryState {
  return {
    schema: "tin-and-thyme.delivery/1",
    key,
    repo: null,
    branch: null,
    head: null,
    base: null,
    tree: null,
    pr: null,
    approval: null,
    invalidated: null,
    merged: null,
    pendingMerge: null,
    lastAttempt: null,
    mergeCommit: null,
    verified: false,
    reconciled: null,
    handback: null,
    plan: null,
    recordsPrep: null,
    steps: {},
    history: [],
    updated: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------- store

const KEY = /^\d+\.\d+$/;

/** True for a ticket key (`10.1`); keys name files, so nothing else is accepted. */
export const isTicketKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key);

/** ~/.controlroom/<kitchen>/deliveries */
export function deliveriesDir(kitchen: string, home = homedir()): string {
  if (!/^[A-Za-z0-9._-]+$/.test(kitchen) || kitchen.startsWith(".")) throw new DeliveryError("invalid", `not a kitchen folder name: ${kitchen}`);
  return join(home, ".controlroom", kitchen, "deliveries");
}

/** ~/.controlroom/<kitchen>/backups: where reconciling the main checkout moves colliding files. */
export function backupsDir(kitchen: string, home = homedir()): string {
  return join(deliveriesDir(kitchen, home), "..", "backups");
}

/** A lock file's holder is gone when its process no longer exists. */
function holderAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_SETTLE_MS = 60_000;

/**
 * One delivery identity's state files. The ticket track keeps `<key>.json` and
 * `<key>.lock`; the records track keeps `<key>.records.json` and
 * `<key>.records.lock` in the same folder, so it has its own state and step lock
 * while `merge.lock` and `main.lock` stay shared by every delivery.
 */
export class DeliveryStore {
  constructor(
    readonly dir: string,
    readonly track: DeliveryTrack = "ticket",
  ) {}

  private get suffix(): string {
    return this.track === "records" ? ".records" : "";
  }

  private file(key: string): string {
    if (!isTicketKey(key)) throw new DeliveryError("invalid", `not a ticket key: ${String(key)}`);
    return join(this.dir, `${key}${this.suffix}.json`);
  }

  /** The folder, owner-only, even when it already existed with a wider mode. */
  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  /**
   * Takes a lock file in the deliveries folder, shared by every Delivery and
   * every kitchen process using this folder: `<key>.lock` for one ticket's
   * steps, `merge.lock` for any merge into the integration branch, `main.lock`
   * for reconciling the main checkout. Returns the
   * release function, or throws a `blocked` DeliveryError while another live
   * holder has it. A lock whose holder process is gone (a crash) is reclaimed.
   */
  lock(name: string, what: string): () => void {
    if (!isTicketKey(name) && name !== "merge" && name !== "main") throw new DeliveryError("invalid", `not a lock name: ${String(name)}`);
    this.ensureDir();
    const path = join(this.dir, `${name}${isTicketKey(name) ? this.suffix : ""}.lock`);
    const token = randomBytes(12).toString("hex");
    const body = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }) + "\n";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeSync(fd, body);
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            if ((JSON.parse(readFileSync(path, "utf8")) as { token?: unknown }).token === token) unlinkSync(path);
          } catch {
            // already gone, or not ours: leave it
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new DeliveryError("failed", `cannot take the ${what} lock: ${(e as Error).message}`);
      }
      let raw = "";
      let holder: { pid?: unknown } | null = null;
      try {
        raw = readFileSync(path, "utf8");
        holder = JSON.parse(raw) as { pid?: unknown };
      } catch {
        holder = null;
      }
      let settled = false;
      try {
        settled = Date.now() - statSync(path).mtimeMs > LOCK_SETTLE_MS;
      } catch {
        continue; // released meanwhile: try again
      }
      // A holder that is alive, or a lock still being written, is respected.
      const stale = holder ? !holderAlive(holder.pid) : settled;
      if (!stale) throw new DeliveryError("blocked", `${what} is already running${holder && typeof holder.pid === "number" ? ` (process ${holder.pid})` : ""}; wait for it to finish`, { reasons: [path] });
      try {
        if (readFileSync(path, "utf8") === raw) unlinkSync(path);
      } catch {
        // someone else reclaimed it first
      }
    }
    throw new DeliveryError("blocked", `${what} is already running; wait for it to finish`, { reasons: [path] });
  }

  /** True when this identity has a state file for the key. */
  exists(key: string): boolean {
    return existsSync(this.file(key));
  }

  /** The stored state, or a fresh empty one. An unreadable file is not silently replaced. */
  read(key: string): DeliveryState {
    const file = this.file(key);
    if (!existsSync(file)) return emptyState(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new DeliveryError("failed", `delivery state for ${key} is unreadable; it was left as it is`);
    }
    const s = parsed as Partial<DeliveryState>;
    if (!s || s.schema !== "tin-and-thyme.delivery/1" || s.key !== key) throw new DeliveryError("failed", `delivery state for ${key} has an unknown shape; it was left as it is`);
    return { ...emptyState(key), ...s, steps: s.steps ?? {}, history: s.history ?? [] };
  }

  /** Writes atomically (a uniquely named temp file + rename), owner-only, with every string redacted. */
  write(state: DeliveryState): DeliveryState {
    const file = this.file(state.key);
    this.ensureDir();
    const clean = redactDeep(state);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      throw new DeliveryError("failed", `cannot write the delivery state for ${state.key}: ${(e as Error).message}`);
    }
    return clean;
  }

  update(key: string, change: (s: DeliveryState) => void, now = new Date()): DeliveryState {
    const s = this.read(key);
    change(s);
    s.updated = now.toISOString();
    return this.write(s);
  }

  /** Records one step's result, as the latest for that step and in the history. */
  record(key: string, result: StepResult, change?: (s: DeliveryState) => void): DeliveryState {
    const clean = redactDeep(result);
    return this.update(
      key,
      (s) => {
        change?.(s);
        s.steps[clean.step] = clean;
        s.history = [...s.history, clean].slice(-HISTORY_LIMIT);
      },
      new Date(clean.at),
    );
  }
}
