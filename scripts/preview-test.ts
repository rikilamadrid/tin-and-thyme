// A preview serves only a stamped, clean, reviewed build, on its own port. This checks the
// refusals against a throwaway repository and a fake home: no real kitchen is read or touched.
//
//   npx tsx scripts/preview-test.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDigest, IDENTITY_FILE, IDENTITY_SCHEMA, verifyBuild, type BuildIdentity } from "../server/preview/identity";
import { checkPreviewPort } from "../server/preview/server";

const tmp = mkdtempSync(join(tmpdir(), "tt-preview-"));
const home = join(tmp, "home");
mkdirSync(join(home, ".controlroom", "kitchens"), { recursive: true });
Object.assign(process.env, { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(tmp, "none.gitconfig") });
writeFileSync(join(tmp, "none.gitconfig"), "");

const repo = join(tmp, "build");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "preview@test.invalid");
git("config", "user.name", "Preview Test");
writeFileSync(join(repo, ".gitignore"), "dist\ndist-server\n");
writeFileSync(join(repo, "app.txt"), "one\n");
git("add", ".");
git("commit", "-q", "-m", "one");
mkdirSync(join(repo, "dist"));
mkdirSync(join(repo, "dist-server"));
writeFileSync(join(repo, "dist", "index.html"), "<html>one</html>");
writeFileSync(join(repo, "dist-server", "main.mjs"), "// one");

let failures = 0;
function refuses(label: string, fn: () => unknown, pattern: RegExp) {
  try {
    fn();
    console.log(`✗ ${label}: was accepted`);
    failures++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (pattern.test(msg)) console.log(`✓ ${label}: ${msg}`);
    else {
      console.log(`✗ ${label}: refused for the wrong reason: ${msg}`);
      failures++;
    }
  }
}
function accepts(label: string, fn: () => unknown) {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (e) {
    console.log(`✗ ${label}: ${e instanceof Error ? e.message : e}`);
    failures++;
  }
}

const head = git("rev-parse", "HEAD");
const stamp = (over: Partial<BuildIdentity> = {}) =>
  writeFileSync(
    join(repo, IDENTITY_FILE),
    JSON.stringify({ schema: IDENTITY_SCHEMA, sha: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), builtAt: new Date().toISOString(), digest: buildDigest(repo), ...over }),
  );

// Identity
refuses("no identity", () => verifyBuild(repo, head), /No build identity/);
stamp();
accepts("stamped, clean, reviewed head", () => verifyBuild(repo, head));
refuses("reviewed head not named", () => verifyBuild(repo, undefined), /Name the reviewed commit/);
refuses("short reviewed sha", () => verifyBuild(repo, head.slice(0, 12)), /full 40-hex/);
refuses("another reviewed sha", () => verifyBuild(repo, "0".repeat(40)), /not the reviewed commit/);

writeFileSync(join(repo, "app.txt"), "changed\n");
refuses("tracked change", () => verifyBuild(repo, head), /uncommitted changes/);
git("checkout", "--", "app.txt");
writeFileSync(join(repo, "stray.txt"), "x");
refuses("untracked file", () => verifyBuild(repo, head), /uncommitted changes/);
rmSync(join(repo, "stray.txt"));

writeFileSync(join(repo, "dist", "index.html"), "<html>tampered</html>");
refuses("built files changed after stamping", () => verifyBuild(repo, head), /built files changed/);
writeFileSync(join(repo, "dist", "index.html"), "<html>one</html>");
accepts("restored build verifies again", () => verifyBuild(repo, head));

writeFileSync(join(repo, "app.txt"), "two\n");
git("commit", "-q", "-am", "two");
refuses("HEAD moved after the build", () => verifyBuild(repo, head), /checkout moved/);
stamp({ tree: "f".repeat(40) });
refuses("tree mismatch", () => verifyBuild(repo, git("rev-parse", "HEAD")), /tree is/);

// Port
writeFileSync(join(home, ".controlroom", "kitchens", "other-12345678.json"), JSON.stringify({ app: "tin-and-thyme", key: "other-12345678", port: 7600, instance: "x" }));
refuses("no port", () => checkPreviewPort(undefined), /needs its own port/);
refuses("kitchen range", () => checkPreviewPort("7420"), /kitchens' range/);
refuses("kitchen range end", () => checkPreviewPort("7499"), /kitchens' range/);
refuses("a recorded kitchen's port", () => checkPreviewPort("7600"), /belongs to the kitchen other-12345678/);
refuses("not a port", () => checkPreviewPort("80"), /1024 to 65535/);
accepts("own port outside the range", () => checkPreviewPort("7520"));

rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall preview checks passed");
