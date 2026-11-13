// Build identity for a Tin & Thyme preview (docs/delivery-bootstrap.md).
//
// A preview serves one reviewed build of Tin & Thyme next to the running kitchen. Its
// identity is the commit it was built from (SHA and tree), when it was built, and a digest
// of the built files. `scripts/preview-build.ts` writes it after building a clean
// checkout; the preview server checks it again before it serves anything, and refuses
// a dirty checkout, a moved HEAD, rebuilt files or an unreviewed commit.
//
// The stamp detects drift (a build that is not the reviewed one: other files, another commit,
// a dirty tree), not tampering: a process running as the same user can rewrite the build and
// its identity file together.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PREVIEW_GIT_ENV } from "../delivery/preview";

export const IDENTITY_SCHEMA = "tin-and-thyme.preview-build/1";
export const IDENTITY_FILE = join("dist-server", "preview-identity.json");

export interface BuildIdentity {
  schema: typeof IDENTITY_SCHEMA;
  /** The commit the build was made from (40 hex). */
  sha: string;
  /** That commit's tree (40 hex). */
  tree: string;
  /** ISO time the build finished. */
  builtAt: string;
  /** sha256 over every built file (dist/ and dist-server/, this file excluded). */
  digest: string;
}

export interface GitFacts {
  head: string;
  tree: string;
  /** `git status --porcelain` lines: tracked changes and untracked files (ignored files excluded). */
  dirty: string[];
}

const SHA = /^[0-9a-f]{40}$/;

/** Read-only git: PREVIEW_GIT_ENV, so `git status` never refreshes the index and nothing prompts. */
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...PREVIEW_GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** HEAD, its tree and the working tree's changes. Throws a readable error outside a Git checkout. */
export function gitFacts(root: string): GitFacts {
  try {
    const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const tree = git(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return { head, tree, dirty: status ? status.split("\n") : [] };
  } catch {
    throw new Error(`${root} is not a Git checkout with a commit; a preview is built only from a known commit.`);
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/** sha256 over the sorted relative paths and contents of dist/ and dist-server/ (the identity file excluded). */
export function buildDigest(root: string): string {
  const files = [...filesUnder(join(root, "dist")), ...filesUnder(join(root, "dist-server"))]
    .map((f) => relative(root, f).split(sep).join("/"))
    .filter((f) => f !== IDENTITY_FILE.split(sep).join("/"))
    .sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f + "\0");
    h.update(createHash("sha256").update(readFileSync(join(root, f))).digest("hex") + "\n");
  }
  return h.digest("hex");
}

export function readIdentity(root: string): BuildIdentity | null {
  try {
    const j = JSON.parse(readFileSync(join(root, IDENTITY_FILE), "utf8"));
    if (j?.schema !== IDENTITY_SCHEMA || !SHA.test(j.sha) || !SHA.test(j.tree) || typeof j.builtAt !== "string" || !/^[0-9a-f]{64}$/.test(j.digest)) return null;
    return j as BuildIdentity;
  } catch {
    return null;
  }
}

const dirtyList = (lines: string[]) => lines.slice(0, 8).join("; ") + (lines.length > 8 ? `; and ${lines.length - 8} more` : "");

/** Refuses a dirty checkout: what `preview-build` checks before and after building. */
export function requireClean(root: string): GitFacts {
  const facts = gitFacts(root);
  if (facts.dirty.length) throw new Error(`${root} has uncommitted changes (${dirtyList(facts.dirty)}). A preview is built only from a clean, committed tree.`);
  return facts;
}

/**
 * The checks a preview passes before it serves: the build carries an identity, the checkout is
 * clean and still at that commit and tree, the built files are the ones that were stamped, and
 * the human named that exact commit as the reviewed head.
 */
export function verifyBuild(root: string, reviewed: string | undefined): BuildIdentity {
  const id = readIdentity(root);
  if (!id) throw new Error(`No build identity at ${join(root, IDENTITY_FILE)}. Build the preview with \`pnpm build:preview\` in a clean checkout first.`);
  const facts = requireClean(root);
  if (facts.head !== id.sha) throw new Error(`The checkout moved: HEAD is ${facts.head}, the build is ${id.sha}. Rebuild with \`pnpm build:preview\`.`);
  if (facts.tree !== id.tree) throw new Error(`The checkout's tree is ${facts.tree}, the build's is ${id.tree}. Rebuild with \`pnpm build:preview\`.`);
  const digest = buildDigest(root);
  if (digest !== id.digest) throw new Error(`The built files changed after the preview build was stamped (digest ${digest.slice(0, 12)}, stamped ${id.digest.slice(0, 12)}). Rebuild with \`pnpm build:preview\`.`);
  if (!reviewed) throw new Error(`Name the reviewed commit: --reviewed <40-hex sha>. This build is ${id.sha}.`);
  if (!SHA.test(reviewed)) throw new Error(`--reviewed must be a full 40-hex commit SHA, not "${reviewed}".`);
  if (reviewed !== id.sha) throw new Error(`This build is ${id.sha}, not the reviewed commit ${reviewed}. A preview serves only the reviewed head.`);
  return id;
}
