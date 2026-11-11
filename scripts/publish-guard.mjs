// prepublishOnly: refuses an `npm publish` from this tree unless every statement of the
// release agrees. Modelled on Lorekeeper's publish guard.
//
//   - intent is explicit: TIN_AND_THYME_PUBLISH=yes (the release workflow sets it);
//   - package.json is no longer "private" (that removal is the deliberate first-publication step);
//   - its version is the newest `## [X.Y.Z]` in CHANGELOG.md;
//   - every README image is pinned to that version's files in the package, and each one ships;
//   - the tree is clean, and HEAD is contained in origin/main.
//
// npm runs no lifecycle scripts when publishing a tarball, so the one-time bootstrap publish
// (RELEASING.md) is checked by hand instead.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const fail = (msg) => {
  console.error(`publish-guard: ${msg}`);
  process.exit(1);
};
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (process.env.TIN_AND_THYME_PUBLISH !== "yes") fail("publishing needs explicit intent: TIN_AND_THYME_PUBLISH=yes (see RELEASING.md)");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.private) fail('package.json still says "private": true. Removing it is the deliberate first-publication step (RELEASING.md).');

const changelog = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync("CHANGELOG.md", "utf8"))?.[1];
if (changelog !== pkg.version) fail(`version disagreement: package.json ${pkg.version}, newest CHANGELOG.md section ${changelog ?? "none"}`);

const readme = readFileSync("README.md", "utf8");
const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
const prefix = `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/`;
for (const src of images) {
  if (!src.startsWith(prefix)) fail(`README image ${src} is not pinned to ${prefix} (npm cannot show it otherwise)`);
  const file = src.slice(prefix.length);
  if (!existsSync(file) || !pkg.files.some((f) => file === f || file.startsWith(f.replace(/\/?$/, "/")))) fail(`README image ${file} is not shipped in the package`);
}

if (git("status", "--porcelain")) fail("the working tree is not clean");
try {
  git("fetch", "--quiet", "origin", "main");
  execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
} catch {
  fail("HEAD is not contained in origin/main");
}
console.log(`publish-guard: ${pkg.name}@${pkg.version} may be published`);
