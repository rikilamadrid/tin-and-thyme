// Gives the packed README image URLs npm can load, and puts the repository's back afterwards.
//
//   node scripts/npm-readme.mjs pin       (prepack)  relative image paths → this version's jsDelivr URLs
//   node scripts/npm-readme.mjs unpin     (postpack) the same URLs → relative paths again
//
// GitHub renders the repository's README with repository-relative paths, so the committed README
// never depends on a CDN or on a version being published. Only the README inside the tarball is
// pinned. Both directions are idempotent, and `unpin` is also the fix if a pack was interrupted
// between the two (or simply `git checkout README.md`).
//
// `pin` refuses an image that does not exist or is not shipped in the package, so a tarball can
// never carry a README pointing at a file the CDN will not have.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cdnPrefix, isRelative, isShipped, mapReadmeImages } from "./readme-images.mjs";

const mode = process.argv[2];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const prefix = cdnPrefix(pkg);
const before = readFileSync("README.md", "utf8");
const problems = [];

let after;
if (mode === "pin") {
  after = mapReadmeImages(before, (src) => {
    if (src.startsWith(prefix)) return src;
    if (!isRelative(src)) {
      problems.push(`${src} is neither repository-relative nor pinned to ${prefix}`);
      return src;
    }
    const file = src.replace(/^\.\//, "");
    if (!existsSync(file)) problems.push(`${file} does not exist`);
    else if (!isShipped(pkg, file)) problems.push(`${file} is not in package.json "files"`);
    return prefix + file;
  });
} else if (mode === "unpin") {
  after = mapReadmeImages(before, (src) => (src.startsWith(prefix) ? src.slice(prefix.length) : src));
} else {
  console.error("usage: node scripts/npm-readme.mjs pin|unpin");
  process.exit(2);
}

if (problems.length) {
  console.error(`npm-readme: README images cannot ship:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
if (after !== before) writeFileSync("README.md", after);
console.log(`npm-readme: README images ${mode === "pin" ? `pinned to ${prefix}` : "repository-relative"}`);
