// The local verification evidence shown beside "no checks reported" (Feature 10:
// merging with no checks needs an acknowledgement and shows the local evidence).
//
// Two real sources, read-only:
// - the claim's `Last:` line, `review PASS on <full sha>`, which the orchestrator
//   writes only after an independent tester's PASS;
// - that tester's report, kept in the kitchen's machine-local transfer folder,
//   `~/.controlroom/<kitchen>/transfer/<key>/review-<n>-pass.md`. A report is used
//   only when its first line names exactly the reviewed head (the full id).
// Nothing is inferred: with no matching report, the drawer says so.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeliveryEvidence } from "../../src/data/delivery";
import { isTicketKey, redact } from "./state";

const REPORT = /^review-(\d+)-pass\.md$/;
const SHA = /^[0-9a-f]{40}$/;
export const EVIDENCE_TEXT_LIMIT = 6000;

export function transferDir(kitchen: string, key: string, home = homedir()): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(kitchen) || kitchen.startsWith(".") || !isTicketKey(key)) return null;
  return join(home, ".controlroom", kitchen, "transfer", key);
}

export function localEvidence(o: { kitchen: string; key: string; reviewedHead: string | null; line: string | null; home?: string }): DeliveryEvidence {
  const line = o.line ? redact(o.line) : null;
  const dir = transferDir(o.kitchen, o.key, o.home);
  if (!dir || !o.reviewedHead || !SHA.test(o.reviewedHead) || !existsSync(dir)) return { line, report: null };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => REPORT.test(n));
  } catch {
    return { line, report: null };
  }
  names.sort((a, b) => Number(REPORT.exec(b)![1]) - Number(REPORT.exec(a)![1]));
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile() || statSync(file).size > 1024 * 1024) continue;
      const text = readFileSync(file, "utf8");
      const first = text.split("\n", 1)[0];
      // The exact reviewed head, as a whole word: a prefix or another commit's report is not evidence for it.
      if (!new RegExp(`(^|[^0-9a-f])${o.reviewedHead}([^0-9a-f]|$)`).test(first)) continue;
      const clean = redact(text);
      return { line, report: { file: `transfer/${o.key}/${name}`, text: clean.slice(0, EVIDENCE_TEXT_LIMIT), truncated: clean.length > EVIDENCE_TEXT_LIMIT } };
    } catch {
      continue;
    }
  }
  return { line, report: null };
}
