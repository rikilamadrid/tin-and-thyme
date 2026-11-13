// After a verified merge: bring the project's main checkout up to the merged
// origin/main without losing anything (Feature 10, "After a verified merge").
//
//   plan(key)          read-only: fetch origin/main, and list what a fast-forward
//                      would collide with: tracked modifications to paths the
//                      merge changes, and untracked or ignored files at paths it
//                      adds. Everything else is an unrelated change, preserved.
//   apply(key, digest) on the human's click, for exactly the listed plan: copy each
//                      colliding file to ~/.controlroom/<kitchen>/backups/<ts>/
//                      with a manifest, verify every copy byte for byte, and only
//                      then move it out of the way; then fast-forward main only.
//
// Nothing is deleted: a colliding file is removed from the checkout only after
// its backup verified, and a tracked one is put back to the commit main is on
// (its change lives in the backup). Every refusal (main diverged, another branch
// checked out, a merge in progress, a folder in the way, unmerged entries) is
// found before anything is copied, so a refusal leaves the checkout exactly as
// it was. If git still refuses the fast-forward after the files were moved (a
// lock, a file that appeared meanwhile), every moved file is put back from its
// verified copy and the index entries are restored, and the listing is taken
// again to confirm the checkout is as it was; the copies stay in the backup
// either way. Every git call is a fixed argument vector through the injected
// runner, and paths are passed as literal pathspecs (`app/[id]/page.tsx` names
// one file, never a pattern).

import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { RunResult } from "../lib/exec";
import { commandFailure, type Runner } from "./forge";
import { isSha, parseGithubRemote } from "./ops";
import { DeliveryError, redact } from "./state";

export const MANIFEST_SCHEMA = "tin-and-thyme.reconcile-backup/1";
const DIGEST = /^[0-9a-f]{64}$/;
export const isPlanDigest = (v: unknown): v is string => typeof v === "string" && DIGEST.test(v);

/** One file a fast-forward would overwrite or remove. */
export interface Collision {
  /** Relative to the repository root. */
  path: string;
  /** How the main checkout holds it. */
  kind: "modified" | "untracked" | "ignored";
  /** `git status` XY for a tracked change, `??` untracked, `!!` ignored. */
  status: string;
  /** What the merged origin/main does at this path. */
  why: string;
  /** What is on disk now: a file, a symbolic link, or nothing (a deletion). */
  type: "file" | "symlink" | "missing";
  size: number | null;
  mode: number | null;
  /** Of the file's bytes, or of a link's target text. */
  sha256: string | null;
  /** The bytes equal what origin/main has at this path (nothing of it would be lost). */
  sameAsMerged: boolean;
  /** Tracked in the commit main is on (restored from it once backed up). */
  inHead: boolean;
  /** The staged content differs from the working file; it is saved too. */
  stagedBlob: string | null;
}

export interface Preserved {
  path: string;
  status: string;
}

export interface ReconcilePlan {
  key: string;
  at: string;
  branch: string;
  /** Local main now. */
  head: string;
  /** origin/main, freshly fetched. */
  target: string;
  mergeCommit: string;
  /** Local main already contains the merge: nothing to do. */
  upToDate: boolean;
  collisions: Collision[];
  /** Unrelated changes, left exactly where they are. */
  preserved: Preserved[];
  preservedTotal: number;
  /** Why it cannot be done; nothing is changed when this is set. */
  refusal: string | null;
  /** Of head, target, merge and every collision: what the human's click must match. */
  digest: string;
}

export interface ReconcileResult {
  before: string;
  after: string;
  target: string;
  mergeCommit: string;
  backup: string | null;
  manifest: string | null;
  moved: number;
  preserved: number;
  upToDate: boolean;
}

export interface ReconcilerConfig {
  root: string;
  /** owner/name: origin must resolve to it. */
  repo: string;
  base: string;
  runner: Runner;
  now?: () => Date;
}

const PRESERVED_LIST_LIMIT = 200;
/** Paths are names, never patterns: without this, `docs/[ab].md` would also match `docs/a.md`. */
const LITERAL = "--literal-pathspecs";

/** One path's index entry (stage 0) before reconcile touched it. */
interface IndexEntry {
  mode: string;
  blob: string;
}
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"];

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Git's (SHA-1) blob id for these bytes, with no filters: what `git hash-object --no-filters` gives. */
const blobId = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

/** A path git reported, refused unless it is a plain relative path inside the repository. */
export function safeRelative(p: string): string {
  if (!p || p.includes("\0") || p.includes("�") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "." || s === ""))
    throw new DeliveryError("refused", `git reported a path reconcile will not handle: ${JSON.stringify(p).slice(0, 120)}`);
  return p;
}

/** `root/p`, only when it stays inside root. */
function inside(root: string, p: string): string {
  const full = join(root, safeRelative(p));
  if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) throw new DeliveryError("refused", `${p} is outside ${root}`);
  return full;
}

const ancestors = (p: string) => {
  const parts = p.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** NUL-separated `git status --porcelain=v1 -z --no-renames`: XY and path. */
export function parseStatus(out: string): { status: string; path: string }[] {
  return out
    .split("\0")
    .filter(Boolean)
    .map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }));
}

/** NUL-separated `git diff --name-status -z --no-renames`: status letter and path. */
export function parseNameStatus(out: string): Map<string, string> {
  const parts = out.split("\0");
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) map.set(parts[i + 1], parts[i][0]);
  return map;
}

function hashOnDisk(full: string): { type: Collision["type"]; size: number | null; mode: number | null; sha256: string | null; blob: string | null } {
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return { type: "missing", size: null, mode: null, sha256: null, blob: null };
  }
  if (st.isSymbolicLink()) {
    const target = readlinkSync(full);
    return { type: "symlink", size: Buffer.byteLength(target), mode: null, sha256: sha256(target), blob: blobId(Buffer.from(target)) };
  }
  if (st.isFile()) {
    const bytes = readFileSync(full);
    return { type: "file", size: bytes.length, mode: st.mode & 0o777, sha256: sha256(bytes), blob: blobId(bytes) };
  }
  throw new DeliveryError("refused", `${full} is a folder or special file; reconcile moves files only, so leave it to the human`);
}

export class Reconciler {
  private readonly now: () => Date;
  constructor(private readonly cfg: ReconcilerConfig) {
    this.now = cfg.now ?? (() => new Date());
  }

  private git(args: string[], timeoutMs?: number): Promise<RunResult> {
    return this.cfg.runner("git", args, { cwd: this.cfg.root, timeoutMs });
  }

  private async gitOk(args: string[], what: string, timeoutMs?: number): Promise<string> {
    const r = await this.git(args, timeoutMs);
    if (!r.ok) throw commandFailure(r, what, "git");
    return r.stdout;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.git(["merge-base", "--is-ancestor", a, b]);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw commandFailure(r, `checking whether ${a} is in ${b}`, "git");
  }

  private async resolve(ref: string, what: string): Promise<string> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = r.stdout.trim();
    if (!r.ok || !isSha(sha)) throw new DeliveryError("invalid", `cannot resolve ${what} (${ref})`);
    return sha;
  }

  /** True when local main (the branch, wherever it is checked out) contains `commit`. Read-only. */
  async mainContains(commit: string): Promise<boolean> {
    if (!isSha(commit)) return false;
    const main = await this.resolve(`refs/heads/${this.cfg.base}`, `local ${this.cfg.base}`);
    return main === commit || (await this.isAncestor(commit, main));
  }

  /** origin is the configured repository; then origin/main is fetched. */
  private async fetchTarget(): Promise<string> {
    const url = (await this.gitOk(["remote", "get-url", "origin"], "reading origin")).trim();
    const origin = parseGithubRemote(url);
    if (!origin || origin.toLowerCase() !== this.cfg.repo.toLowerCase()) throw new DeliveryError("invalid", `origin is ${url}, not github.com/${this.cfg.repo}`);
    const b = this.cfg.base;
    await this.gitOk(["fetch", "--no-tags", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], `fetching origin/${b}`, 120_000);
    return this.resolve(`refs/remotes/origin/${b}`, `origin/${b}`);
  }

  /** What a fast-forward to the merged origin/main would collide with. Changes nothing in the checkout. */
  async plan(key: string, mergeCommit: string): Promise<ReconcilePlan> {
    if (!isSha(mergeCommit)) throw new DeliveryError("invalid", `not a merge commit id: ${mergeCommit}`);
    return this.listing(key, mergeCommit, await this.fetchTarget());
  }

  /** The listing against an already fetched origin/main (`target`): local reads only. */
  private async listing(key: string, mergeCommit: string, target: string): Promise<ReconcilePlan> {
    const root = this.cfg.root;
    const base = this.cfg.base;
    const at = this.now().toISOString();
    const out = (p: Partial<ReconcilePlan> & { head: string; refusal: string | null }): ReconcilePlan => {
      const plan: ReconcilePlan = { key, at, branch: base, target, mergeCommit, upToDate: false, collisions: [], preserved: [], preservedTotal: 0, digest: "", ...p };
      plan.digest = planDigest(plan);
      return plan;
    };

    const symbolic = await this.git(["symbolic-ref", "--quiet", "HEAD"]);
    const head = await this.resolve("HEAD", "the main checkout's HEAD");
    if (!symbolic.ok || symbolic.stdout.trim() !== `refs/heads/${base}`)
      return out({ head, refusal: `the main checkout is on ${symbolic.ok ? symbolic.stdout.trim().replace(/^refs\/heads\//, "") : "a detached HEAD"}, not ${base}; only ${base} is fast-forwarded` });
    if (!(await this.isAncestor(mergeCommit, target))) return out({ head, refusal: `origin/${base} (${target}) does not contain the merge ${mergeCommit}; verify the merge again` });
    if (await this.isAncestor(mergeCommit, head)) return out({ head, upToDate: true, refusal: null });
    if (!(await this.isAncestor(head, target)))
      return out({ head, refusal: `local ${base} (${head}) has commits that origin/${base} (${target}) does not: it cannot be fast-forwarded, and nothing was changed` });
    for (const name of IN_PROGRESS) {
      const p = (await this.gitOk(["rev-parse", "--git-path", name], "reading the git folder")).trim();
      if (existsSync(isAbsolute(p) ? p : join(root, p))) return out({ head, refusal: `a git operation is in progress in the main checkout (${name}); finish or abort it first` });
    }

    const changed = parseNameStatus(await this.gitOk(["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", head, target], "listing what the merge changes"));
    const status = parseStatus(await this.gitOk(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], "reading the main checkout"));
    const inHead = new Set((await this.gitOk(["ls-tree", "-r", "-z", "--name-only", head], "listing the main checkout's commit")).split("\0").filter(Boolean));
    const listed = new Map(status.map((e) => [e.path, e.status]));

    const unmerged = status.filter((e) => /U/.test(e.status) || e.status === "AA" || e.status === "DD");
    if (unmerged.length) return out({ head, refusal: `the main checkout has unmerged files (${unmerged.map((e) => e.path).slice(0, 5).join(", ")}); resolve them first` });

    const why = (p: string): string | null => {
      const c = changed.get(p);
      if (c === "A") return `origin/${base} adds this file`;
      if (c === "D") return `origin/${base} deletes this file`;
      if (c) return `origin/${base} changes this file`;
      return null;
    };
    const found = new Map<string, { kind: Collision["kind"]; status: string; why: string }>();
    for (const e of status) {
      if (e.path.endsWith("/")) {
        // An untracked folder git would not list file by file (a nested repository): refused if anything lands inside it.
        const dir = e.path;
        const hit = [...changed.keys()].find((p) => p.startsWith(dir) || dir === `${p}/`);
        if (hit) return out({ head, refusal: `${dir} is a nested repository or folder git cannot list, and origin/${base} writes ${hit} there; leave it to the human` });
        continue;
      }
      safeRelative(e.path);
      const under = e.status === "??" && [...changed.keys()].some((p) => p.startsWith(`${e.path}/`));
      const reason = why(e.path) ?? (under ? `origin/${base} adds files under this path` : null);
      if (reason) found.set(e.path, { kind: e.status === "??" ? "untracked" : "modified", status: e.status, why: reason });
    }
    // Ignored files git would overwrite without asking, and files standing where the merge needs a folder.
    for (const [p, c] of changed) {
      safeRelative(p);
      if (c !== "A") continue;
      for (const a of ancestors(p)) {
        if (found.has(a) || inHead.has(a)) continue;
        let st;
        try {
          st = lstatSync(inside(root, a));
        } catch {
          break; // nothing there, so nothing below it either
        }
        if (st.isDirectory()) continue;
        found.set(a, { kind: listed.get(a) === "??" ? "untracked" : "ignored", status: listed.get(a) ?? "!!", why: `origin/${base} adds files under this path` });
        break;
      }
      if (found.has(p)) continue;
      let st;
      try {
        st = lstatSync(inside(root, p));
      } catch {
        continue;
      }
      if (st.isDirectory()) return out({ head, refusal: `origin/${base} adds the file ${p}, but the main checkout has a folder there; leave it to the human` });
      found.set(p, { kind: listed.has(p) ? (listed.get(p) === "??" ? "untracked" : "modified") : "ignored", status: listed.get(p) ?? "!!", why: why(p)! });
    }

    const collisions: Collision[] = [];
    for (const [p, f] of [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const disk = hashOnDisk(inside(root, p));
      const mergedBlob = blobOf((await this.gitOk([LITERAL, "ls-tree", "-z", target, "--", p], `reading ${p} in origin/${base}`)).split("\0")[0]);
      let stagedBlob: string | null = null;
      if (f.kind === "modified" && /[MAT]/.test(f.status[0]) && f.status[1] !== " ") {
        const idx = (await this.gitOk([LITERAL, "ls-files", "-s", "-z", "--", p], `reading the staged ${p}`)).split("\0")[0];
        stagedBlob = /^\d+ ([0-9a-f]{40}) 0\t/.exec(idx)?.[1] ?? null;
        if (stagedBlob === disk.blob) stagedBlob = null;
      }
      collisions.push({
        path: p,
        kind: f.kind,
        status: f.status,
        why: f.why,
        type: disk.type,
        size: disk.size,
        mode: disk.mode,
        sha256: disk.sha256,
        sameAsMerged: disk.blob !== null ? disk.blob === mergedBlob : mergedBlob === null,
        inHead: inHead.has(p),
        stagedBlob,
      });
    }

    const unrelated = status.filter((e) => !found.has(e.path));
    const preserved: Preserved[] = unrelated.slice(0, PRESERVED_LIST_LIMIT).map((e) => ({ path: e.path, status: e.status }));
    return out({ head, collisions, preserved, preservedTotal: unrelated.length, refusal: null });
  }

  /**
   * On the human's click, for exactly the plan they saw (`digest`): back up and
   * move every colliding file, then fast-forward main. Throws a DeliveryError,
   * with nothing changed, for a refusal or a plan that no longer matches.
   */
  async apply(key: string, mergeCommit: string, digest: string, backups: string): Promise<{ result: ReconcileResult; plan: ReconcilePlan }> {
    const plan = await this.plan(key, mergeCommit);
    if (plan.refusal) throw new DeliveryError("refused", plan.refusal);
    if (plan.digest !== digest) throw new DeliveryError("stale", "the main checkout or origin/main changed since it was listed; nothing was changed. List it again and check the new list");
    const root = this.cfg.root;
    const base = this.cfg.base;
    if (plan.upToDate) return { plan, result: { before: plan.head, after: plan.head, target: plan.target, mergeCommit, backup: null, manifest: null, moved: 0, preserved: plan.preservedTotal, upToDate: true } };

    let backup: string | null = null;
    let manifestPath: string | null = null;
    let index = new Map<string, IndexEntry>();
    const manifest = {
      schema: MANIFEST_SCHEMA,
      key,
      root,
      createdAt: this.now().toISOString(),
      branch: base,
      before: plan.head,
      target: plan.target,
      mergeCommit,
      digest: plan.digest,
      state: "copying" as "copying" | "copied" | "moved" | "put-back" | "fast-forward-failed" | "done",
      note: "Each file under files/ is the main checkout's copy at that path, byte for byte; index/ holds staged content that differed. Nothing was deleted.",
      after: null as string | null,
      entries: plan.collisions.map((c) => ({ ...c, backup: c.type === "missing" ? null : `files/${c.path}`, index: c.stagedBlob ? `index/${c.path}` : null })),
      preserved: plan.preserved.map(({ path, status }) => ({ path, status })),
      preservedTotal: plan.preservedTotal,
    };
    const save = () => {
      if (!manifestPath) return;
      const tmp = `${manifestPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, manifestPath);
    };

    if (plan.collisions.length) {
      backup = newBackupDir(backups, this.now());
      manifestPath = join(backup, "manifest.json");
      save();
      // 1. Copy every file and verify each copy against the plan's hash and against the file itself.
      for (const c of plan.collisions) {
        const src = inside(root, c.path);
        if (c.type !== "missing") {
          const dst = inside(join(backup, "files"), c.path);
          mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
          if (c.type === "symlink") symlinkSync(readlinkSync(src), dst);
          else {
            copyFileSync(src, dst, constants.COPYFILE_EXCL);
            if (c.mode !== null) chmodSync(dst, c.mode);
          }
          const copy = hashOnDisk(dst);
          const now = hashOnDisk(src);
          if (copy.sha256 !== c.sha256 || now.sha256 !== c.sha256 || now.type !== c.type)
            throw new DeliveryError("stale", `${c.path} changed while it was being backed up; nothing was moved, and the copies so far are in ${backup}`);
        } else if (existsSync(src)) throw new DeliveryError("stale", `${c.path} appeared while it was being backed up; nothing was moved`);
        if (c.stagedBlob) {
          const idx = join(backup, "index") + sep;
          mkdirSync(idx, { recursive: true, mode: 0o700 });
          await this.gitOk(["checkout-index", `--prefix=${idx}`, "--", c.path], `saving the staged ${c.path}`);
          const saved = inside(join(backup, "index"), c.path);
          if (!existsSync(saved) || blobId(readFileSync(saved)) !== c.stagedBlob) throw new DeliveryError("failed", `the staged ${c.path} could not be saved; nothing was moved, and the copies so far are in ${backup}`);
        }
      }
      // The index as it is for these paths, so a refused fast-forward can be undone exactly.
      index = await this.indexEntries(plan.collisions.map((c) => c.path));
      manifest.state = "copied";
      save();
    }

    // 2. Only now move them out of the way: tracked ones back to main's commit, the rest out of the checkout.
    // 3. Fast-forward only, to exactly the fetched origin/main.
    // From the first move on, a failure puts every moved file back.
    let moving = false;
    try {
      if (backup) {
        moving = true;
        const restore = plan.collisions.filter((c) => c.kind === "modified" && c.inHead).map((c) => c.path);
        const added = plan.collisions.filter((c) => c.kind === "modified" && !c.inHead).map((c) => c.path);
        if (restore.length) await this.gitOk([LITERAL, "checkout", "-q", plan.head, "--", ...restore], "putting the backed-up tracked files back to main's commit");
        // Index only (`--cached`): the working file is moved below. `-f` because a staged file edited again (AM) is refused otherwise; both versions are in the backup.
        if (added.length) await this.gitOk([LITERAL, "rm", "--cached", "-f", "-q", "--", ...added], "unstaging the backed-up new files");
        for (const c of plan.collisions) {
          if (c.kind === "modified" && c.inHead) continue;
          const full = inside(root, c.path);
          try {
            unlinkSync(full);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new DeliveryError("failed", `${c.path} could not be moved: ${(e as Error).message}`);
          }
          removeEmptyParents(root, c.path);
        }
        manifest.state = "moved";
        save();
      }
      const ff = await this.git(["merge", "--ff-only", "--no-edit", plan.target], 120_000);
      if (!ff.ok) throw commandFailure(ff, `fast-forwarding ${base}`, "git");
    } catch (e) {
      const err = e instanceof DeliveryError ? e : new DeliveryError("failed", e instanceof Error ? e.message : String(e));
      if (!moving || !backup) throw new DeliveryError("failed", `${err.message}; nothing was moved, and the main checkout is as it was`);
      // Git refused after files were moved: put every one back, and confirm the checkout lists exactly as before.
      let why: string | null = null;
      try {
        await this.putBack(plan, backup, index);
        const again = await this.listing(key, mergeCommit, plan.target);
        if (again.digest !== plan.digest) why = "the main checkout does not list as it did before";
      } catch (e2) {
        why = redact(e2 instanceof Error ? e2.message : String(e2));
      }
      manifest.state = why ? "fast-forward-failed" : "put-back";
      manifest.note += why
        ? ` It failed: ${redact(err.message)}. The moved files could not all be put back (${why}); they are kept here.`
        : ` It failed: ${redact(err.message)}. Every moved file was put back where it was; these copies were kept.`;
      save();
      throw new DeliveryError(
        "failed",
        why
          ? `${err.message}; the moved files could not all be put back (${why}): they are kept, byte for byte, in ${backup}`
          : `${err.message}; ${base} was not moved, every file that had been moved was put back, and the main checkout is as it was (the copies were kept in ${backup})`,
      );
    }
    const after = await this.resolve("HEAD", "the main checkout's HEAD");
    if (after !== plan.target || !(await this.isAncestor(mergeCommit, after))) throw new DeliveryError("failed", `${base} is at ${after} after the fast-forward, not ${plan.target}`);
    manifest.state = "done";
    manifest.after = after;
    save();
    return { plan, result: { before: plan.head, after, target: plan.target, mergeCommit, backup, manifest: manifestPath, moved: plan.collisions.length, preserved: plan.preservedTotal, upToDate: false } };
  }

  /** The index entries (stage 0) of these paths, as they are now. */
  private async indexEntries(paths: string[]): Promise<Map<string, IndexEntry>> {
    const out = new Map<string, IndexEntry>();
    for (let i = 0; i < paths.length; i += 100) {
      const listed = await this.gitOk([LITERAL, "ls-files", "-s", "-z", "--", ...paths.slice(i, i + 100)], "reading the index");
      for (const rec of listed.split("\0")) {
        const m = /^(\d+) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(rec);
        if (m && paths.includes(m[3])) out.set(m[3], { mode: m[1], blob: m[2] });
      }
    }
    return out;
  }

  /**
   * Undoes the move after a refused fast-forward: every file goes back where it
   * was, from its verified copy, and the index entries of those paths are set
   * back. It replaces only what the move itself left there (main's committed copy
   * of a tracked file, or nothing); anything else is left alone and reported.
   */
  private async putBack(plan: ReconcilePlan, backup: string, index: Map<string, IndexEntry>): Promise<void> {
    const root = this.cfg.root;
    for (const c of plan.collisions) {
      const full = inside(root, c.path);
      const tracked = c.kind === "modified" && c.inHead;
      const now = hashOnDisk(full);
      // Not moved yet (the move stopped before it): already as it was.
      if (now.type === c.type && now.sha256 === c.sha256) continue;
      if (tracked) {
        const committed = blobOf((await this.gitOk([LITERAL, "ls-tree", "-z", plan.head, "--", c.path], `reading ${c.path} in main's commit`)).split("\0")[0]);
        if (now.blob !== committed) throw new DeliveryError("failed", `${c.path} changed after it was moved`);
        if (now.type !== "missing") unlinkSync(full);
      } else if (now.type !== "missing") throw new DeliveryError("failed", `${c.path} appeared after it was moved`);
      if (c.type === "missing") continue;
      const copy = inside(join(backup, "files"), c.path);
      mkdirSync(dirname(full), { recursive: true });
      if (c.type === "symlink") symlinkSync(readlinkSync(copy), full);
      else {
        copyFileSync(copy, full, constants.COPYFILE_EXCL);
        if (c.mode !== null) chmodSync(full, c.mode);
      }
      if (hashOnDisk(full).sha256 !== c.sha256) throw new DeliveryError("failed", `${c.path} could not be put back byte for byte`);
    }
    for (const c of plan.collisions) {
      const e = index.get(c.path);
      if (e) await this.gitOk(["update-index", "--add", "--cacheinfo", `${e.mode},${e.blob},${c.path}`], `restoring the staged ${c.path}`);
      else if (c.kind === "modified" && c.inHead) await this.gitOk(["update-index", "--force-remove", "--", c.path], `restoring the staged deletion of ${c.path}`);
    }
  }
}

/** `<mode> blob <sha>\t<path>` → the blob id; null for anything else. */
const blobOf = (lsTreeRecord: string) => /^\d+ blob ([0-9a-f]{40})\t/.exec(lsTreeRecord)?.[1] ?? null;

/** Head, target, merge and every collision as seen: the click applies exactly this. */
export function planDigest(p: Pick<ReconcilePlan, "key" | "head" | "target" | "mergeCommit" | "upToDate" | "refusal" | "collisions">): string {
  return sha256(
    JSON.stringify({
      key: p.key,
      head: p.head,
      target: p.target,
      merge: p.mergeCommit,
      upToDate: p.upToDate,
      refusal: p.refusal,
      collisions: p.collisions.map((c) => [c.path, c.kind, c.status, c.type, c.sha256, c.mode, c.stagedBlob]),
    }),
  );
}

/** ~/.controlroom/<kitchen>/backups/<ts>, new and owner-only; never an existing folder. */
function newBackupDir(backups: string, now: Date): string {
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  chmodSync(backups, 0o700);
  const ts = now.toISOString().replace(/:/g, "-");
  for (let n = 1; n < 100; n++) {
    const dir = join(backups, n === 1 ? ts : `${ts}-${n}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new DeliveryError("failed", `cannot create the backup folder: ${(e as Error).message}`);
    }
  }
  throw new DeliveryError("failed", `cannot create a new backup folder in ${backups}`);
}

/** Removes the folders a moved file leaves empty, up to (never including) the root. */
function removeEmptyParents(root: string, p: string) {
  for (const a of ancestors(p).reverse()) {
    const dir = inside(root, a);
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}
