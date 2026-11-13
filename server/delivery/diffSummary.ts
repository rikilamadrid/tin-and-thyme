// The diff the human inspects before approving: every file the delivered head
// changes since its merge base with the integration branch, with line counts.
// Read-only local git (`git diff --numstat`), through the delivery runner, so the
// call gets the same non-interactive environment as every other delivery call
// (GIT_TERMINAL_PROMPT=0, forge.ts nonInteractiveEnv).

import type { DiffFile } from "../../src/data/delivery";
import { commandFailure, type Runner } from "./forge";
import { redact } from "./state";

const SHA = /^[0-9a-f]{40}$/;
/** More than this many files are summarized, not listed. */
export const DIFF_FILE_LIMIT = 500;

export interface DiffSummary {
  files: DiffFile[];
  truncated: boolean;
  stat: { files: number; added: number; deleted: number };
}

/** The argument vector, fixed: two full commit ids, no renames, no external diff or textconv drivers. */
export function diffSummaryArgs(from: string, to: string): string[] {
  if (!SHA.test(from) || !SHA.test(to)) throw new Error("diffSummary needs two full commit ids");
  return ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", from, to];
}

/** Parses `git diff --numstat -z`: `added\tdeleted\tpath\0`, with `-\t-` for a binary file. */
export function parseNumstat(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ""));
    if (!m) continue;
    files.push({ path: redact(m[3]), added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) });
  }
  return files;
}

export async function diffSummary(runner: Runner, root: string, from: string, to: string): Promise<DiffSummary> {
  const r = await runner("git", diffSummaryArgs(from, to), { cwd: root, timeoutMs: 60_000 });
  if (!r.ok) throw commandFailure(r, "listing the changed files", "git");
  const all = parseNumstat(r.stdout);
  const stat = { files: all.length, added: 0, deleted: 0 };
  for (const f of all) {
    stat.added += f.added ?? 0;
    stat.deleted += f.deleted ?? 0;
  }
  return { files: all.slice(0, DIFF_FILE_LIMIT), truncated: all.length > DIFF_FILE_LIMIT, stat };
}
