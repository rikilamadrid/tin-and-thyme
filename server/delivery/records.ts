// Completion records as their own small PR (Feature 10, Notes; human decision 2026-11-13).
//
// After a ticket's implementation merge is verified, local main contains it and
// the engine's claim is released, the kitchen commits the completion records,
// cut from that updated main, and delivers them as branch `ticket/<key>-records`
// through the same steps as any ticket (inspect, the human's exact approval,
// push, PR, checks, merge, verify, reconcile). The records commit contains
// exactly what `/ticket complete` writes (skills/ticket/actions/complete.md
// steps 3-5), and nothing else:
//
//   - the ticket's `## Status` line set to `Complete`;
//   - the parent Feature's `## Status` line set to `Complete`, only when every
//     other ticket of that Feature is Complete, Cancelled or Superseded, both in
//     the commit and in the ticket store as the engine's board reads it (the
//     store can hold tickets main does not track yet);
//   - one entry appended to `context/history.md`, only when the Feature
//     completed (the durable history is per Feature: complete.md step 5).
//
// The check is mechanical and exact: the intended change is computed from the
// commit's own parent, and the commit must change exactly those files to exactly
// those bytes (same modes). An extra line, an extra file, another status or an
// edit anywhere else in those files is refused: that diff needs normal review (a
// tester PASS), like any ticket. The same check is applied to what would land on
// origin's main (the expected merge tree against the current base), so a records
// diff verified against an older main is never merged onto a main where it would
// mean something else.
//
// Only this verified, records-only diff may be accepted by the human's exact
// in-app approval in place of a tester PASS. A records delivery never produces a
// records delivery of its own.
//
// Two rules come from the orchestrate engine, which this module never changes:
//
//   - `ticket/<key>-records` is the branch on origin (the PR's head). Locally the
//     commit is kept under `refs/tin-and-thyme/records/<key>`, never as a local
//     branch: the engine reads every local `ticket/<key>-*` branch as a claim on
//     that ticket (claims.mjs), so a local records branch would show a delivered
//     ticket as a stale, orphaned claim in every status and plan.
//   - The records are prepared only after the claim is released. `orchestrate
//     release` proves a squash merge from local main (merging the ticket branch
//     into it must change nothing); once the records commit, which rewrites the
//     ticket's Status line, is on local main, that proof fails for any branch that
//     touched the same line, and release would need `--force`.
//
// Git is read through the injectable runner (execFile, fixed argument vectors).
// Writing the commit adds objects and sets that one ref; it never touches a
// working tree, the index, a branch or another ref. The ref is the kitchen's
// own: it is created once, and moved only to replace a commit that is no longer
// exactly the records (main or the store changed since) while nothing of the
// records delivery is merged or pending. It is never pushed: delivery pushes
// only `<sha>:refs/heads/ticket/<key>-records`.

import type { Runner } from "./forge";
import { commandFailure } from "./forge";
import { isSha } from "./ops";
import { DeliveryError, isTicketKey } from "./state";

// ---------------------------------------------------------------- names

/** The branch on origin the completion records are delivered from (the records PR's head). */
export function recordsBranch(key: string): string {
  if (!isTicketKey(key)) throw new DeliveryError("invalid", `not a ticket key: ${String(key)}`);
  return `ticket/${key}-records`;
}

/**
 * Where the kitchen keeps the records commit locally. Not under `refs/heads`
 * (the engine would read a local `ticket/<key>-*` branch as a claim), and never
 * pushed (ops.ts pushes only `<sha>:refs/heads/ticket/…`).
 */
export function recordsRef(key: string): string {
  if (!isTicketKey(key)) throw new DeliveryError("invalid", `not a ticket key: ${String(key)}`);
  return `refs/tin-and-thyme/records/${key}`;
}

/** True for `ticket/<key>-records`: a records branch never gets records of its own. */
export const isRecordsBranch = (branch: string | null | undefined, key: string): boolean => !!branch && isTicketKey(key) && branch === `ticket/${key}-records`;

export const HISTORY_PATH = "context/history.md";
export const HISTORY_TEMPLATE = "templates/history.template.md";
const TICKETS = "context/tickets";
const FEATURES = "context/features";

// ---------------------------------------------------------------- pure Markdown rules

/** The six statuses the orchestrate engine accepts (skills/orchestrate/engine/store.mjs). */
export const STATUSES = ["Proposed", "Ready", "In Progress", "Complete", "Cancelled", "Superseded"] as const;
const DONE = new Set(["Complete", "Cancelled", "Superseded"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a `## Heading` section's body starts and ends (up to the next `## `), as the engine reads it. */
function sectionRange(text: string, heading: string): { start: number; end: number } | null {
  const m = new RegExp(`^## ${esc(heading)}[ \\t]*\\r?\\n`, "mi").exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^## /m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

/** The `## Status` value: its first non-blank line, trimmed, or null when there is no section. */
export function statusLine(text: string): string | null {
  const r = sectionRange(text, "Status");
  if (!r) return null;
  return (
    text
      .slice(r.start, r.end)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

/** The status as the engine recognises it (exact word, ignoring case), or null. */
export function statusOf(text: string): string | null {
  const line = statusLine(text);
  if (line === null) return null;
  return STATUSES.find((s) => s.toLowerCase() === line.toLowerCase()) ?? null;
}

/** The text with only the `## Status` value line replaced by `value`; null when there is no value line. */
export function withStatus(text: string, value: string): string | null {
  const r = sectionRange(text, "Status");
  if (!r) return null;
  const body = text.slice(r.start, r.end);
  const m = /^([ \t]*)(\S[^\r\n]*?)([ \t]*)(?=\r?$)/m.exec(body);
  if (!m) return null;
  const at = r.start + m.index;
  return text.slice(0, at) + m[1] + value + m[3] + text.slice(at + m[0].length);
}

/** The Feature file the ticket's `## Parent Feature` names (first backticked `NN-slug.md`). */
export function parentFeatureOf(text: string): string | null {
  const r = sectionRange(text, "Parent Feature");
  if (!r) return null;
  const m = /`([0-9]+-[A-Za-z0-9][A-Za-z0-9._-]*\.md)`/.exec(text.slice(r.start, r.end));
  return m ? m[1] : null;
}

/** The first `# ` heading. */
export function titleOf(text: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(text);
  return m ? m[1] : null;
}

export interface HistoryFacts {
  date: string;
  featureNumber: string;
  featureTitle: string;
  key: string;
  pr: number;
  mergeCommit: string;
}

const clean = (s: string) => s.replace(/`/g, "").replace(/\s+/g, " ").trim();

/** One compact history entry, in templates/history.template.md's shape. */
export function historyEntry(f: HistoryFacts): string {
  return [
    `### ${f.date} — Feature ${f.featureNumber}: ${clean(f.featureTitle)}`,
    "",
    `- Outcome: \`Feature ${f.featureNumber} is complete; its last open ticket, ${f.key}, was delivered.\``,
    `- Verification: \`ticket ${f.key}: PR #${f.pr} squash-merged as ${f.mergeCommit} and verified on main in Tin & Thyme\``,
    `- Commit/PR: \`${f.mergeCommit}, PR #${f.pr}\``,
    "- Follow-up: `none`",
    "",
  ].join("\n");
}

/**
 * The history file with the entry appended. A missing file is created from the
 * template, its placeholder entry replaced by this one (complete.md step 5).
 * Null when neither the file nor the template exists.
 */
export function withHistoryEntry(existing: string | null, template: string | null, entry: string): string | null {
  if (existing !== null) return `${existing.replace(/\n*$/, "")}\n\n${entry}`;
  if (template === null) return null;
  const placeholder = /^### \[YYYY-MM-DD\][^\n]*\n(?:\n|- [^\n]*\n)*/m;
  if (!placeholder.test(template)) return null;
  return template.replace(placeholder, `${entry}\n`);
}

// ---------------------------------------------------------------- the intended change

export interface Implementation {
  pr: number;
  mergeCommit: string;
}

/** A ticket as the store holds it now (the engine's `board --json`: key and status). */
export interface StoreTicket {
  key: string;
  status: string;
}

const featureNumber = (s: string) => s.replace(/^0+(?=\d)/, "");

export interface RecordsChange {
  path: string;
  /** The content before (null: the file is created). */
  before: string | null;
  after: string;
  /** The file mode the result must have. */
  mode: string;
  why: string;
}

export interface IntendedRecords {
  /** The commit the change is computed from. */
  from: string;
  key: string;
  ticketPath: string;
  title: string | null;
  featurePath: string;
  /** Ticket status before; the Feature's before and after (equal when unchanged). */
  ticketStatus: string;
  featureBefore: string | null;
  featureAfter: string | null;
  /** In path order. Empty when the commit already records the ticket Complete. */
  changes: RecordsChange[];
  /** Already recorded on this commit: nothing to change. */
  already: boolean;
}

/** Read-only git against the repository, for one commit's files. */
export class RecordsGit {
  constructor(
    private readonly runner: Runner,
    private readonly root: string,
  ) {}

  async ok(args: string[], what: string, input?: string): Promise<string> {
    const r = await this.runner("git", args, { cwd: this.root, timeoutMs: 60_000, ...(input !== undefined ? { input } : {}) });
    if (!r.ok) throw commandFailure(r, what, "git");
    return r.stdout;
  }

  async commit(ref: string, what: string): Promise<string | null> {
    const r = await this.runner("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: this.root });
    const sha = r.stdout.trim();
    if (r.ok && isSha(sha)) return sha;
    if (r.code === 1) return null;
    throw commandFailure(r, `resolving ${what}`, "git");
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.runner("git", ["merge-base", "--is-ancestor", a, b], { cwd: this.root });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw commandFailure(r, `checking whether ${a} is an ancestor of ${b}`, "git");
  }

  async parents(commit: string): Promise<string[]> {
    return (await this.ok(["rev-list", "--parents", "-n", "1", commit], `reading ${commit}`)).trim().split(/\s+/).slice(1);
  }

  /** `<mode> <type> <sha>` per path under a tree-ish, with -z. */
  async entries(treeish: string, paths: string[] = []): Promise<Map<string, { mode: string; type: string; sha: string }>> {
    const out = await this.ok(["ls-tree", "-z", "--full-tree", treeish, ...(paths.length ? ["--", ...paths] : [])], `listing ${treeish}`);
    const map = new Map<string, { mode: string; type: string; sha: string }>();
    for (const rec of out.split("\0")) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, sha] = rec.slice(0, tab).split(" ");
      map.set(rec.slice(tab + 1), { mode, type, sha });
    }
    return map;
  }

  /** The names directly under a directory of a commit (files only). */
  async files(commit: string, dir: string): Promise<string[]> {
    const out = await this.ok(["ls-tree", "-z", "--full-tree", `${commit}:${dir}`], `listing ${dir} at ${commit}`).catch(() => "");
    return out
      .split("\0")
      .map((rec) => {
        const tab = rec.indexOf("\t");
        return tab >= 0 && rec.slice(0, tab).split(" ")[1] === "blob" ? rec.slice(tab + 1) : null;
      })
      .filter((n): n is string => !!n);
  }

  /**
   * A file's content at a commit, or null when it does not exist there. With
   * `exact`, the text must hash back to the same blob: a file that is not valid
   * UTF-8 (or that this reader would not write back byte for byte) is refused
   * rather than rewritten with other bytes changed.
   */
  async read(commit: string, path: string, exact = false): Promise<string | null> {
    const e = (await this.entries(commit, [path])).get(path);
    if (!e || e.type !== "blob") return null;
    const text = await this.ok(["cat-file", "blob", e.sha], `reading ${path} at ${commit}`);
    if (exact && (await this.hash(text)) !== e.sha)
      throw new DeliveryError("refused", `${path} at ${commit.slice(0, 12)} cannot be rewritten byte for byte (it is not plain UTF-8 text); its completion record needs the human (normal review), not a records-only PR`);
    return text;
  }

  /** The blob id the content would have (nothing written unless `write`). */
  async hash(content: string, write = false): Promise<string> {
    const sha = (await this.ok(["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin"], "hashing records content", content)).trim();
    if (!isSha(sha)) throw new DeliveryError("failed", "git hash-object returned no id");
    return sha;
  }
}

/**
 * What `/ticket complete <key>` records, computed from one commit's files: the
 * ticket's Status, the derived Feature Status, and the history entry when the
 * Feature completes. `store` is every ticket the store holds now: the Feature
 * completes only when its other tickets are done both in the commit and there.
 * Refuses (instead of guessing) when anything it reads is missing or
 * unrecognised.
 */
export async function intendedRecords(g: RecordsGit, from: string, key: string, impl: Implementation, store: readonly StoreTicket[]): Promise<IntendedRecords> {
  const refuse = (why: string): never => {
    throw new DeliveryError("refused", `cannot derive ${key}'s completion records at ${from.slice(0, 12)}: ${why}; this needs the human (normal review), not a records-only PR`);
  };
  const feature = key.split(".")[0];
  const ticketNames = await g.files(from, TICKETS);
  const own = ticketNames.filter((n) => n.startsWith(`${key}-`) && n.endsWith(".md"));
  if (own.length !== 1) refuse(own.length ? `${own.length} ticket files are named ${key}-*.md` : `there is no ${TICKETS}/${key}-*.md`);
  const ticketPath = `${TICKETS}/${own[0]}`;
  const ticketMode = (await g.entries(from, [ticketPath])).get(ticketPath)!.mode;
  const ticket = (await g.read(from, ticketPath, true))!;
  const status = statusOf(ticket);
  if (!status) refuse(`${ticketPath} has ${statusLine(ticket) === null ? "no ## Status section" : `an unrecognised status \`${statusLine(ticket)}\``}`);
  const featureFile = parentFeatureOf(ticket);
  if (!featureFile) refuse(`${ticketPath} names no parent Feature file under ## Parent Feature`);
  if (featureNumber(featureFile!.split("-")[0]) !== featureNumber(feature)) refuse(`${ticketPath}'s parent Feature ${featureFile} is not Feature ${feature}`);
  const featurePath = `${FEATURES}/${featureFile}`;
  const featureText = await g.read(from, featurePath, true);
  if (featureText === null) refuse(`${featurePath} does not exist`);
  const featureMode = (await g.entries(from, [featurePath])).get(featurePath)!.mode;
  const featureBefore = statusLine(featureText!);
  if (featureBefore === null) refuse(`${featurePath} has no ## Status section`);

  const base = { from, key, ticketPath, title: titleOf(ticket), featurePath, ticketStatus: status!, featureBefore, featureAfter: featureBefore };
  if (status === "Complete") return { ...base, changes: [], already: true };
  if (DONE.has(status!)) refuse(`${ticketPath} is ${status}, not open`);

  const changes: RecordsChange[] = [];
  const newTicket = withStatus(ticket, "Complete");
  if (newTicket === null) refuse(`${ticketPath}'s ## Status has no value line to change`);
  changes.push({ path: ticketPath, before: ticket, after: newTicket!, mode: ticketMode, why: `${ticketPath}: ## Status ${status} → Complete` });

  // Every ticket of this Feature (key NN.*), with this one now Complete.
  const siblings = ticketNames.filter((n) => new RegExp(`^${esc(feature)}\\.\\d+-.+\\.md$`).test(n));
  let allDone = true;
  for (const n of siblings) {
    if (n === own[0]) continue;
    const text = (await g.read(from, `${TICKETS}/${n}`)) ?? "";
    const s = statusOf(text);
    if (!s) refuse(`${TICKETS}/${n} has no recognisable status, so the Feature's status cannot be derived`);
    if (!DONE.has(s!)) allDone = false;
  }
  // The store can hold tickets of this Feature that this commit does not (not tracked yet), or hold them in another state.
  for (const t of store) {
    if (t.key === key || !isTicketKey(t.key) || featureNumber(t.key.split(".")[0]) !== featureNumber(feature)) continue;
    if (!DONE.has(STATUSES.find((s) => s.toLowerCase() === String(t.status).toLowerCase()) ?? "")) allDone = false;
  }
  let featureAfter = featureBefore;
  if (allDone && featureBefore!.toLowerCase() !== "complete") {
    const next = withStatus(featureText!, "Complete");
    if (next === null) refuse(`${featurePath}'s ## Status has no value line to change`);
    featureAfter = "Complete";
    changes.push({ path: featurePath, before: featureText!, after: next!, mode: featureMode, why: `${featurePath}: ## Status ${featureBefore} → Complete (every ticket of Feature ${feature} is done)` });

    const date = (await g.ok(["log", "-1", "--format=%cs", impl.mergeCommit], "reading the merge date")).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse(`the merge commit ${impl.mergeCommit} has no readable date`);
    const entry = historyEntry({ date, featureNumber: feature, featureTitle: titleOf(featureText!) ?? featureFile!, key, pr: impl.pr, mergeCommit: impl.mergeCommit });
    const existing = await g.read(from, HISTORY_PATH, true);
    const template = existing === null ? await g.read(from, HISTORY_TEMPLATE, true) : null;
    const history = withHistoryEntry(existing, template, entry);
    if (history === null) refuse(`${HISTORY_PATH} does not exist and ${HISTORY_TEMPLATE} has no placeholder entry to create it from`);
    const historyMode = existing === null ? "100644" : (await g.entries(from, [HISTORY_PATH])).get(HISTORY_PATH)!.mode;
    changes.push({ path: HISTORY_PATH, before: existing, after: history!, mode: historyMode, why: `${HISTORY_PATH}: one entry appended (Feature ${feature} completed)` });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...base, featureAfter, changes, already: false };
}

// ---------------------------------------------------------------- the mechanical check

/**
 * Refuses unless `to` (a commit or a tree) differs from `from` in exactly the
 * intended files, each with exactly the intended bytes and mode. Every reason
 * names the path, so the human sees what makes it need normal review.
 */
export async function checkExactly(g: RecordsGit, from: string, to: string, intended: IntendedRecords, what: string): Promise<void> {
  const changed = (await g.ok(["diff", "--name-only", "--no-renames", "-z", from, to], `listing what ${what} changes`)).split("\0").filter(Boolean);
  const want = new Set(intended.changes.map((c) => c.path));
  const reasons: string[] = [];
  for (const p of changed) if (!want.has(p)) reasons.push(`${p}: not a completion record`);
  const got = await g.entries(to, [...want]);
  for (const c of intended.changes) {
    const e = got.get(c.path);
    if (!e || !changed.includes(c.path)) {
      reasons.push(`${c.path}: missing (expected ${c.why})`);
      continue;
    }
    if (e.type !== "blob" || e.sha !== (await g.hash(c.after))) reasons.push(`${c.path}: differs from the intended change (${c.why}); nothing else in it may change`);
    else if (e.mode !== c.mode) reasons.push(`${c.path}: mode ${e.mode}, expected ${c.mode}`);
  }
  if (reasons.length)
    throw new DeliveryError("refused", `${what} is not exactly ${intended.key}'s completion records, so it is not a records-only diff: it needs normal review (a tester PASS), like any ticket`, { reasons: reasons.slice(0, 20) });
}

export interface RecordsCheck {
  intended: IntendedRecords;
  parent: string;
  /** One line for the drawer's evidence and the no-checks acknowledgement. */
  evidence: string;
}

/**
 * The records head is one commit whose parent contains the implementation merge
 * and is on origin's main, and whose change from that parent is exactly the
 * intended records; and what would land on `base` (the expected merge `tree`) is
 * exactly the records intended against `base`.
 */
export async function checkRecordsHead(g: RecordsGit, o: { key: string; head: string; base: string; tree: string; impl: Implementation; store: readonly StoreTicket[] }): Promise<RecordsCheck> {
  const parents = await g.parents(o.head);
  if (parents.length !== 1) throw new DeliveryError("refused", `${recordsBranch(o.key)} at ${o.head} is not one commit on main (${parents.length} parents)`);
  const [parent] = parents;
  if (!(await g.isAncestor(o.impl.mergeCommit, parent)))
    throw new DeliveryError("refused", `${recordsBranch(o.key)} is not cut from a main that contains the implementation merge ${o.impl.mergeCommit}; completion is never recorded before the implementation landed`);
  if (!(await g.isAncestor(parent, o.base))) throw new DeliveryError("refused", `${recordsBranch(o.key)}'s parent ${parent} is not on origin's main ${o.base}; prepare the records again from the updated main`);
  const intended = await intendedRecords(g, parent, o.key, o.impl, o.store);
  if (intended.already) throw new DeliveryError("refused", `main at ${parent.slice(0, 12)} already records ${o.key} Complete; ${recordsBranch(o.key)} has nothing to deliver`);
  await checkExactly(g, parent, o.head, intended, `${recordsBranch(o.key)} at ${o.head.slice(0, 12)}`);
  if (parent !== o.base) {
    const onBase = await intendedRecords(g, o.base, o.key, o.impl, o.store);
    if (onBase.already) throw new DeliveryError("refused", `origin's main ${o.base.slice(0, 12)} already records ${o.key} Complete; nothing to deliver`);
    await checkExactly(g, o.base, o.tree, onBase, `the merge of ${recordsBranch(o.key)} onto ${o.base.slice(0, 12)}`);
  }
  return {
    intended,
    parent,
    evidence: `records-only diff verified mechanically on ${o.head}: ${intended.changes.map((c) => c.why).join("; ")}`,
  };
}

// ---------------------------------------------------------------- writing the commit

/** A tree with the given files replaced or added (blobs already written). Never touches an index or a working tree. */
async function rewriteTree(g: RecordsGit, tree: string | null, edits: Map<string, { mode: string; sha: string }>): Promise<string> {
  const current = tree ? await g.entries(tree) : new Map<string, { mode: string; type: string; sha: string }>();
  const sub = new Map<string, Map<string, { mode: string; sha: string }>>();
  const out = new Map(current);
  for (const [path, e] of edits) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      out.set(path, { mode: e.mode, type: "blob", sha: e.sha });
      continue;
    }
    const dir = path.slice(0, slash);
    if (!sub.has(dir)) sub.set(dir, new Map());
    sub.get(dir)!.set(path.slice(slash + 1), e);
  }
  for (const [dir, inner] of sub) {
    const existing = current.get(dir);
    if (existing && existing.type !== "tree") throw new DeliveryError("refused", `${dir} is not a folder`);
    out.set(dir, { mode: "040000", type: "tree", sha: await rewriteTree(g, existing?.sha ?? null, inner) });
  }
  const input = [...out].map(([name, e]) => `${e.mode} ${e.type} ${e.sha}\t${name}\0`).join("");
  const sha = (await g.ok(["mktree", "-z"], "writing the records tree", input)).trim();
  if (!isSha(sha)) throw new DeliveryError("failed", "git mktree returned no tree");
  return sha;
}

/**
 * Commits the intended records on top of `parent` and points the kitchen's
 * records ref at it. No branch is created. The ref is created only when it does
 * not exist; with `replace` (the commit it holds now, which the caller found is
 * no longer exactly the records) it is moved from exactly that commit, and from
 * nothing else.
 */
export async function writeRecordsCommit(g: RecordsGit, o: { key: string; parent: string; intended: IntendedRecords; impl: Implementation; replace?: string }): Promise<string> {
  if (o.replace !== undefined && !isSha(o.replace)) throw new DeliveryError("invalid", "the records commit to replace must be a full commit id");
  if (o.intended.from !== o.parent || o.intended.already || !o.intended.changes.length) throw new DeliveryError("invalid", "nothing to commit for these records");
  const edits = new Map<string, { mode: string; sha: string }>();
  for (const c of o.intended.changes) edits.set(c.path, { mode: c.mode, sha: await g.hash(c.after, true) });
  const rootTree = (await g.ok(["rev-parse", "--verify", `${o.parent}^{tree}`], "reading main's tree")).trim();
  const tree = await rewriteTree(g, rootTree, edits);
  const message = [
    `Complete ticket ${o.key}: completion records`,
    "",
    ...o.intended.changes.map((c) => `- ${c.why}`),
    "",
    `Implementation: PR #${o.impl.pr}, squash-merged as ${o.impl.mergeCommit} and verified.`,
    "Records-only: delivered through Tin & Thyme's records PR on the human's exact approval.",
  ].join("\n");
  const commit = (await g.ok(["commit-tree", tree, "-p", o.parent, "-m", message], "committing the records")).trim();
  if (!isSha(commit)) throw new DeliveryError("failed", "git commit-tree returned no commit");
  await g.ok(["update-ref", "-m", `tin-and-thyme: completion records for ${o.key}`, recordsRef(o.key), commit, o.replace ?? ""], `${o.replace ? "moving" : "creating"} ${recordsRef(o.key)}`);
  return commit;
}
