// Per-ticket delivery state, kept in ~/.controlroom/<kitchen>/deliveries/<key>.json,
// and the redaction every stored or returned message goes through.
//
// The state survives reconnects and kitchen restarts: each operation records its
// step result here, so the UI can show exactly which steps succeeded. Nothing in
// this file talks to git or GitHub.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export const STEPS = ["inspect", "approve", "push", "ensurePr", "status", "merge", "verify"] as const;
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
  mergeCommit: string | null;
  verified: boolean;
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
    mergeCommit: null,
    verified: false,
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

export class DeliveryStore {
  constructor(readonly dir: string) {}

  private file(key: string): string {
    if (!isTicketKey(key)) throw new DeliveryError("invalid", `not a ticket key: ${String(key)}`);
    return join(this.dir, `${key}.json`);
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

  /** Writes atomically (temp file + rename), owner-only, with every string redacted. */
  write(state: DeliveryState): DeliveryState {
    const file = this.file(state.key);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const clean = redactDeep(state);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
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
