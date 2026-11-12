// Builds a preview of this checkout and stamps its identity (docs/delivery-bootstrap.md).
//
//   pnpm build:preview
//
// Refuses a dirty checkout, and a checkout any kitchen record names as its repository (that
// checkout's dist/ is what a running kitchen may be serving). Runs the normal `pnpm build`,
// checks the tree did not change, then writes dist-server/preview-identity.json: the commit,
// its tree, the build time and a digest of the built files.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalRoot, kitchensDir } from "../server/kitchen";
import { buildDigest, IDENTITY_FILE, IDENTITY_SCHEMA, requireClean, type BuildIdentity } from "../server/preview/identity";

function fail(message: string): never {
  console.error(`preview-build: ${message}`);
  process.exit(1);
}

/** Repositories that kitchen records name (read only). */
function kitchenRoots(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const f of readdirSync(kitchensDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(kitchensDir(), f), "utf8"));
        if (typeof r?.root === "string") out.set(realpathSync(r.root), String(r.key ?? f));
      } catch {
        /* not a record, or its repo is gone */
      }
    }
  } catch {
    /* no kitchens yet */
  }
  return out;
}

let root: string;
try {
  root = canonicalRoot(process.cwd());
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const kitchen = kitchenRoots().get(root);
if (kitchen) fail(`${root} is the repository of the kitchen ${kitchen}; building here would replace the files it serves. Build the preview in the ticket's worktree or another clone.`);

let before;
try {
  before = requireClean(root);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
console.log(`preview-build: building ${before.head} (tree ${before.tree}) in ${root}`);

const built = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) fail(`pnpm build failed (exit ${built.status ?? built.signal}).`);

let after;
try {
  after = requireClean(root);
} catch (e) {
  fail(`the build changed tracked files: ${e instanceof Error ? e.message : e}`);
}
if (after.head !== before.head || after.tree !== before.tree) fail(`HEAD moved during the build (${before.head} → ${after.head}). Nothing was stamped.`);

const identity: BuildIdentity = { schema: IDENTITY_SCHEMA, sha: after.head, tree: after.tree, builtAt: new Date().toISOString(), digest: buildDigest(root) };
const file = join(root, IDENTITY_FILE);
writeFileSync(`${file}.tmp`, JSON.stringify(identity, null, 2) + "\n");
renameSync(`${file}.tmp`, file);
console.log(`preview-build: stamped ${file}\n  commit ${identity.sha}\n  tree   ${identity.tree}\n  built  ${identity.builtAt}`);
