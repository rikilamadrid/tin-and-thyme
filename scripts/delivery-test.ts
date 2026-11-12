// Delivery core (server/delivery) against an injectable fake runner.
//
// Local git is real: each scenario builds a throwaway repository in a temp folder
// and the fake runner passes read-only/local git commands (rev-parse, merge-base,
// diff, merge-tree, rev-list, cat-file) through to it. Everything that would
// touch the network or GitHub — fetch, ls-remote, push, every `gh` call — and the
// orchestrate engine's claim are simulated in memory. Nothing is ever pushed,
// and no PR is ever created or merged on GitHub.
//
// The 05.1 → 05.2 replay runs on a --shared clone of this repository's own
// objects when they are present (the real reviewed heads, base and expected
// trees from the delivery specification); otherwise it is reported as skipped.
//
//   pnpm exec tsx scripts/delivery-test.ts

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type RunResult } from "../server/lib/exec";
import { summarizeChecks, type Check, type Program, type Runner } from "../server/delivery/forge";
import { assertSafePushArgs, Delivery, isTicketBranch, parseGithubRemote, pushArgs, reviewedHeadOf, scanDiff, type Inspection, type Outcome } from "../server/delivery/ops";
import { DeliveryStore, redact, type Approval } from "../server/delivery/state";

// ---------------------------------------------------------------- harness

const tmp = mkdtempSync(join(tmpdir(), "tt-delivery-"));
const emptyConfig = join(tmp, "empty.gitconfig");
writeFileSync(emptyConfig, "");
const projectGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
Object.assign(process.env, {
  HOME: tmp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
});

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, detail?: unknown) {
  if (cond) passed++;
  else failures.push(`${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function ok<T>(label: string, o: Outcome<T>): T {
  if (!o.ok) {
    failures.push(`${label}: expected ok, got ${o.kind}: ${o.message} ${JSON.stringify(o.reasons)}`);
    throw new Error(`${label} failed; cannot continue this scenario`);
  }
  passed++;
  return o.data;
}
function refused<T>(label: string, o: Outcome<T>, kind: string, text?: RegExp) {
  if (o.ok) return check(label, false, "expected a refusal, got ok");
  check(`${label} (kind ${kind})`, o.kind === kind, { kind: o.kind, message: o.message, reasons: o.reasons });
  if (text) check(`${label} (says why)`, text.test(o.message + " " + o.reasons.join(" ")), { message: o.message, reasons: o.reasons });
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const result = (stdout: string, code = 0, stderr = ""): RunResult => ({ ok: code === 0, code, stdout, stderr });

// Token-shaped fixtures are built at run time, so this file never contains one.
const filler = "A1b2C3d4E5f6G7h8J9k0".repeat(5);
const GH_TOKEN = "gh" + "p_" + filler.slice(0, 36);
const PAT = "github" + "_pat_" + filler.slice(0, 60);

// ---------------------------------------------------------------- the simulated world

interface FakePr {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  mergeCommit: string | null;
  checks: Check[] | "none";
}

interface FakeClaim {
  branch: string;
  worktree: string;
  state: string;
  last: string;
  ref: string;
  title: string;
  orphan?: boolean;
}

class World {
  originUrl = "https://github.com/owner/project.git";
  remote = new Map<string, string>();
  claims = new Map<string, FakeClaim>();
  dirty = "";
  prs: FakePr[] = [];
  calls: { cmd: Program; args: string[] }[] = [];
  authFail = false;
  pushFail: RunResult | null = null;
  createFail: RunResult | null = null;
  defaultChecks: Check[] | "none" = "none";
  defaultMergeable: FakePr["mergeable"] = "MERGEABLE";

  constructor(readonly repo: string) {}

  /** Real local git, for commands that neither touch the network nor move a ref. */
  private static PASS = new Set(["rev-parse", "merge-base", "cat-file", "diff", "merge-tree", "rev-list"]);

  readonly runner: Runner = async (cmd, args, opts = {}) => {
    this.calls.push({ cmd, args: [...args] });
    if (cmd === "node") return this.engine(args);
    if (cmd === "gh") return this.gh(args);
    const [sub] = args;
    if (sub === "push") return this.push(args);
    if (sub === "remote") return args[1] === "get-url" && args[2] === "origin" ? result(this.originUrl + "\n") : result("", 2, "unexpected remote call");
    if (sub === "status") return result(this.dirty);
    if (sub === "ls-remote") {
      const ref = args[2];
      const sha = this.remote.get(ref);
      return result(sha ? `${sha}\t${ref}\n` : "");
    }
    if (sub === "fetch") {
      const m = /^\+refs\/heads\/(.+):(refs\/remotes\/origin\/.+)$/.exec(args[3] ?? "");
      const sha = m && this.remote.get(`refs/heads/${m[1]}`);
      if (!m || !sha) return result("", 128, "fatal: couldn't find remote ref");
      git(this.repo, "update-ref", m[2], sha);
      return result("");
    }
    if (World.PASS.has(sub)) return run("git", args, { cwd: opts.cwd ?? this.repo });
    return result("", 99, `fake runner: unexpected git ${args.join(" ")}`);
  };

  private engine(args: string[]): RunResult {
    const key = args[2];
    const c = this.claims.get(key);
    const claim = c ? { key, orphan: false, ...c } : null;
    return result(JSON.stringify({ key, claim, here: false, root: this.repo }));
  }

  private push(args: string[]): RunResult {
    assertSafePushArgs(args); // the module must never build anything else
    if (this.pushFail) return this.pushFail;
    const [sha, dest] = args[args.length - 1].split(":");
    const current = this.remote.get(dest);
    if (current && current !== sha) return result("", 1, ` ! [rejected] ${sha} -> ${dest} (non-fast-forward)`);
    this.remote.set(dest, sha);
    return result(`To ${this.originUrl}\n*\t${sha}:${dest}\t[new branch]\nDone\n`);
  }

  private flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  }

  private view(pr: FakePr) {
    const head = pr.state === "OPEN" ? (this.remote.get(`refs/heads/${pr.headRefName}`) ?? pr.headRefOid) : pr.headRefOid;
    const { checks: _checks, mergeCommit, ...rest } = pr;
    return { ...rest, headRefOid: head, url: `https://github.com/owner/project/pull/${pr.number}`, mergeCommit: mergeCommit ? { oid: mergeCommit } : null };
  }

  private gh(args: string[]): RunResult {
    if (this.authFail) return result("", 4, "You are not logged into any GitHub hosts. To log in, run: gh auth login");
    if (args[0] === "auth") return result("", 0, "github.com\n  ✓ Logged in to github.com account someone (keyring)\n");
    if (args[0] !== "pr") return result("", 99, `fake gh: unexpected ${args.join(" ")}`);
    const sub = args[1];
    const byNumber = () => this.prs.find((p) => p.number === Number(args[2]));
    if (sub === "list") {
      const head = this.flag(args, "--head");
      return result(JSON.stringify(this.prs.filter((p) => p.headRefName === head).map((p) => this.view(p))));
    }
    if (sub === "create") {
      if (args.includes("--draft")) return result("", 99, "a draft PR was requested");
      if (this.createFail) return this.createFail;
      const head = this.flag(args, "--head")!;
      const sha = this.remote.get(`refs/heads/${head}`);
      if (!sha) return result("", 1, "pull request create failed: head branch not found");
      const pr: FakePr = {
        number: 100 + this.prs.length,
        title: this.flag(args, "--title")!,
        state: "OPEN",
        isDraft: false,
        headRefName: head,
        headRefOid: sha,
        baseRefName: this.flag(args, "--base")!,
        mergeable: this.defaultMergeable,
        reviewDecision: "",
        mergeCommit: null,
        checks: this.defaultChecks,
      };
      this.prs.push(pr);
      return result(`https://github.com/owner/project/pull/${pr.number}\n`);
    }
    const pr = byNumber();
    if (!pr) return result("", 1, "no pull requests found");
    if (sub === "ready") {
      pr.isDraft = false;
      return result("");
    }
    if (sub === "view") return result(JSON.stringify(this.view(pr)));
    if (sub === "checks") {
      if (pr.checks === "none") return result("", 1, `no checks reported on the '${pr.headRefName}' branch`);
      const code = pr.checks.some((c) => c.bucket === "fail") ? 1 : pr.checks.some((c) => c.bucket === "pending") ? 8 : 0;
      return result(JSON.stringify(pr.checks), code);
    }
    if (sub === "merge") {
      if (args.includes("--delete-branch") || args.includes("--auto") || !args.includes("--squash")) return result("", 99, "unsafe merge flags");
      const pinned = this.flag(args, "--match-head-commit");
      const head = this.view(pr).headRefOid;
      if (pinned !== head) return result("", 1, "Head branch was modified. Review and try the merge again.");
      // A real squash: the merge of the branch onto the current remote main, as one commit.
      const main = this.remote.get(`refs/heads/${pr.baseRefName}`)!;
      const tree = git(this.repo, "merge-tree", "--write-tree", main, head).split("\n")[0];
      const commit = git(this.repo, "commit-tree", tree, "-p", main, "-m", this.flag(args, "--subject") ?? pr.title);
      this.remote.set(`refs/heads/${pr.baseRefName}`, commit);
      Object.assign(pr, { state: "MERGED", headRefOid: head, mergeCommit: commit });
      return result("");
    }
    return result("", 99, `fake gh: unexpected pr ${sub}`);
  }

  count(cmd: Program, ...prefix: string[]) {
    return this.calls.filter((c) => c.cmd === cmd && prefix.every((p, i) => c.args[i] === p)).length;
  }
}

/** A fresh repository: main at `base`, ticket/10.1-demo with a reviewed commit and a record-only commit. */
function scenario(name: string) {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  const commit = (msg: string) => {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", msg);
    return git(repo, "rev-parse", "HEAD");
  };
  write("README.md", "hello\n");
  write("context/tickets/10.1-demo.md", "# Demo\n\n## Status\n\nIn Progress\n");
  const base = commit("base");
  git(repo, "checkout", "-q", "-b", "ticket/10.1-demo");
  write("src/feature.ts", "export const feature = 1;\n");
  const reviewed = commit("feature");
  write("context/tickets/10.1-demo.md", "# Demo\n\n## Status\n\nIn Progress\n\nClaimed note.\n");
  const head = commit("record only");
  git(repo, "checkout", "-q", "main");
  // Local-only refs that must never reach the remote.
  git(repo, "update-ref", "refs/backup/10.1-pre-squash", reviewed);
  git(repo, "update-ref", "refs/pathfinder/claims/10.1", head);

  const world = new World(repo);
  world.remote.set("refs/heads/main", base);
  world.claims.set("10.1", {
    branch: "ticket/10.1-demo",
    worktree: ".pathfinder/worktrees/10.1",
    state: "done",
    last: `review PASS on ${reviewed.slice(0, 8)} (round 1); local typecheck, tests and build green`,
    ref: "context/tickets/10.1-demo.md",
    title: "Demo feature",
  });
  const stateDir = join(tmp, `${name}-deliveries`);
  const make = (extra: Partial<ConstructorParameters<typeof Delivery>[0]> = {}) =>
    new Delivery({ root: repo, repo: "owner/project", store: new DeliveryStore(stateDir), runner: world.runner, ...extra });
  return { repo, world, base, reviewed, head, write, commit, stateDir, delivery: make(), make };
}

const approvalOf = (i: Inspection, extra: Partial<Approval> = {}): Approval => ({ key: i.key, head: i.head, base: i.base, tree: i.tree, ...extra });

// ---------------------------------------------------------------- pure rules

eq("origin https", parseGithubRemote("https://github.com/owner/project.git"), "owner/project");
eq("origin ssh scp", parseGithubRemote("git@github.com:owner/project.git"), "owner/project");
eq("origin ssh url", parseGithubRemote("ssh://git@github.com/owner/project"), "owner/project");
eq("origin elsewhere", parseGithubRemote("https://gitlab.com/owner/project.git"), null);
eq("origin lookalike host", parseGithubRemote("https://github.com.evil.example/owner/project.git"), null);
check("ticket branch ok", isTicketBranch("ticket/10.1-delivery-core", "10.1"));
check("ticket branch for another key", !isTicketBranch("ticket/10.2-delivery-core", "10.1"));
check("not a ticket branch", !isTicketBranch("feature/10.1-x", "10.1"));
check("ticket branch with ..", !isTicketBranch("ticket/10.1-a..b", "10.1"));

// The claims' real `Last:` lines.
eq("reviewed head: review PASS on", reviewedHeadOf("review PASS on 61cd56e8 (round 2); local CI-equivalent green"), "61cd56e8");
eq("reviewed head: reviewed", reviewedHeadOf("reconciled 2026-11-12: reviewed 64962bf8 (tree 6b0c6ce) + bookkeeping-only b2b92044"), "64962bf8");
eq("reviewed head: review PASS", reviewedHeadOf("reconciled 2026-11-12: review PASS df080b1d + bookkeeping-only ff00d6ec; docs-only"), "df080b1d");
eq("reviewed head: none", reviewedHeadOf("Phase A done: automated checks pass"), null);

const H = "b2b92044de5096248277b8ef9b97e18f0aab30c7";
eq("push args", pushArgs("05.1", H, "ticket/05.1-adopt"), ["push", "--no-follow-tags", "--porcelain", "origin", `${H}:refs/heads/ticket/05.1-adopt`]);
for (const bad of [
  ["push", "--force", "origin", `${H}:refs/heads/ticket/05.1-a`],
  ["push", "-f", "origin", `${H}:refs/heads/ticket/05.1-a`],
  ["push", "--force-with-lease", "origin", `${H}:refs/heads/ticket/05.1-a`],
  ["push", "--all", "origin"],
  ["push", "--mirror", "origin"],
  ["push", "--tags", "origin", `${H}:refs/heads/ticket/05.1-a`],
  ["push", "origin", `+${H}:refs/heads/ticket/05.1-a`],
  ["push", "origin", `${H}:refs/backup/05.1-pre-squash`],
  ["push", "origin", "refs/backup/05.1-pre-squash:refs/backup/05.1-pre-squash"],
  ["push", "origin", `${H}:refs/pathfinder/claims/05.1`],
  ["push", "origin", "refs/pathfinder/claims/05.1"],
  ["push", "origin", `${H}:refs/heads/main`],
  ["push", "origin", `:refs/heads/ticket/05.1-a`],
  ["push", "origin", "ticket/05.1-a"],
  ["push", "upstream", `${H}:refs/heads/ticket/05.1-a`],
  ["push", "origin", `${H}:refs/heads/ticket/05.1-a`, `${H}:refs/heads/ticket/05.2-b`],
]) {
  let threw = false;
  try {
    assertSafePushArgs(bad);
  } catch {
    threw = true;
  }
  check(`unsafe push refused: ${bad.slice(1).join(" ")}`, threw);
}

eq("checks: none is not passing", summarizeChecks([]), "none");
eq("checks: failed", summarizeChecks([{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }, { name: "lint", bucket: "fail", state: "FAILURE", link: "" }]), "failed");
eq("checks: pending", summarizeChecks([{ name: "ci", bucket: "pending", state: "IN_PROGRESS", link: "" }]), "pending");
eq("checks: passed", summarizeChecks([{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }, { name: "x", bucket: "skipping", state: "SKIPPED", link: "" }]), "passed");

// Redaction.
for (const [label, text] of [
  ["classic token", `token is ${GH_TOKEN} ok`],
  ["fine-grained token", `token is ${PAT} ok`],
  ["authorization header", `Authorization: Bearer abc.${filler}`],
  ["url credentials", `fatal: unable to access 'https://x-access-token:${GH_TOKEN}@github.com/owner/project.git/'`],
] as const) {
  const out = redact(text);
  check(`redacts ${label}`, !out.includes(GH_TOKEN) && !out.includes(PAT) && !out.includes(filler.slice(0, 20)) && out.includes("[REDACTED]"), out);
}
eq("redaction leaves ordinary text", redact("pushed abc123 to ticket/10.1-demo"), "pushed abc123 to ticket/10.1-demo");

// Diff secret scan: finds token shapes, never returns them, and ignores code that merely mentions a header.
const scanned = scanDiff(
  [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,0 +10,3 @@",
    `+const t = "${GH_TOKEN}";`,
    "+const h = `Authorization: Bearer ${token}`;",
    `+fetch(url, { headers: { Authorization: "token ${filler.slice(0, 40)}" } });`,
  ].join("\n"),
);
eq("scan finds the token and the literal header", scanned, [
  { file: "src/x.ts", line: 10, kind: "GitHub token" },
  { file: "src/x.ts", line: 12, kind: "Authorization header with a literal credential" },
]);
check("scan never returns the secret", !JSON.stringify(scanned).includes(GH_TOKEN));

// ---------------------------------------------------------------- scenarios

async function main() {
  // ---- inspect: the happy path
  {
    const s = scenario("inspect");
    const i = ok("inspect", await s.delivery.inspect("10.1"));
    eq("inspect head", i.head, s.head);
    eq("inspect reviewed head (resolved from the claim's abbreviation)", i.reviewedHead, s.reviewed);
    eq("inspect record-only commits", i.recordOnly, [s.head]);
    eq("inspect base is fetched origin/main", i.base, s.base);
    eq("inspect expected tree is the real merge tree", i.tree, git(s.repo, "merge-tree", "--write-tree", s.base, s.head));
    check("inspect evidence comes from the claim", i.evidence?.includes("local typecheck"));
    const stored = JSON.parse(readFileSync(join(s.stateDir, "10.1.json"), "utf8"));
    eq("state records the inspected head/base/tree", [stored.head, stored.base, stored.tree], [i.head, i.base, i.tree]);
    check("state records the inspect step", stored.steps.inspect?.ok === true);
    eq("inspect never pushes", s.world.count("git", "push"), 0);
  }

  // ---- inspect: every validation refuses
  {
    const s = scenario("wrong-repo");
    s.world.originUrl = "https://github.com/someone-else/project.git";
    refused("wrong repository", await s.delivery.inspect("10.1"), "invalid", /not github.com\/owner\/project/);
    s.world.originUrl = "https://gitlab.com/owner/project.git";
    refused("non-GitHub origin", await s.delivery.inspect("10.1"), "invalid");
  }
  {
    const s = scenario("wrong-branch");
    s.world.claims.get("10.1")!.branch = "ticket/10.2-demo";
    refused("branch of another ticket", await s.delivery.inspect("10.1"), "invalid", /not ticket\/10\.1-<slug>/);
    s.world.claims.get("10.1")!.branch = "main";
    refused("main is not a ticket branch", await s.delivery.inspect("10.1"), "invalid");
    s.world.claims.delete("10.1");
    refused("no claim", await s.delivery.inspect("10.1"), "invalid", /no engine claim/);
  }
  {
    const s = scenario("not-done");
    s.world.claims.get("10.1")!.state = "working";
    refused("claim not done", await s.delivery.inspect("10.1"), "refused", /working, not done/);
    s.world.claims.get("10.1")!.state = "done";
    s.world.claims.get("10.1")!.orphan = true;
    refused("orphan claim", await s.delivery.inspect("10.1"), "refused");
  }
  {
    const s = scenario("dirty");
    s.world.dirty = " M src/feature.ts\n?? notes.txt\n";
    refused("dirty worktree", await s.delivery.inspect("10.1"), "refused", /uncommitted/);
  }
  {
    const s = scenario("no-review");
    s.world.claims.get("10.1")!.last = "tests pass";
    refused("no recorded reviewed head", await s.delivery.inspect("10.1"), "refused", /no reviewed head/);
  }
  {
    const s = scenario("post-review-code");
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    s.write("src/feature.ts", "export const feature = 2;\n");
    s.commit("unreviewed change");
    git(s.repo, "checkout", "-q", "main");
    refused("unreviewed code after the reviewed head", await s.delivery.inspect("10.1"), "refused", /more than the ticket record.*src\/feature\.ts/);
  }
  {
    const s = scenario("denylist");
    refused("denylisted commit in the ancestry", await s.make({ denylist: [s.reviewed] }).inspect("10.1"), "refused", /denylisted/);
    ok("denylist entry this repository lacks", await s.make({ denylist: ["2133c3dd92ea38e7f98023085b20bb45f43f7fa7"] }).inspect("10.1"));
    const stray = git(s.repo, "commit-tree", git(s.repo, "rev-parse", "main^{tree}"), "-m", "stray");
    ok("denylisted commit not in the ancestry", await s.make({ denylist: [stray] }).inspect("10.1"));
  }
  {
    const s = scenario("secret");
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    s.write("src/config.ts", `export const token = "${GH_TOKEN}";\n`);
    const leaked = s.commit("leak");
    git(s.repo, "checkout", "-q", "main");
    s.world.claims.get("10.1")!.last = `review PASS on ${leaked}`;
    const o = await s.delivery.inspect("10.1");
    refused("secret in the diff", o, "refused", /src\/config\.ts:1 \(GitHub token\)/);
    check("secret not in the refusal", !JSON.stringify(o).includes(GH_TOKEN));
    check("secret not in the stored state", !readFileSync(join(s.stateDir, "10.1.json"), "utf8").includes(GH_TOKEN));
  }
  {
    const s = scenario("conflict");
    s.write("src/feature.ts", "export const feature = 'main';\n");
    const moved = s.commit("main changes the same file");
    s.world.remote.set("refs/heads/main", moved);
    refused("conflict with the current base", await s.delivery.inspect("10.1"), "refused", /conflicts with main/);
  }

  // ---- push: first push, retries, refusals, auth
  {
    const s = scenario("push");
    refused("push of a head nobody inspected", await s.delivery.push("10.1", s.reviewed), "stale", /not the .* you saw/);
    refused("push of a non-sha", await s.delivery.push("10.1", "HEAD"), "invalid");
    const first = ok("push", await s.delivery.push("10.1", s.head));
    eq("push result", first, { branch: "ticket/10.1-demo", head: s.head, already: false });
    eq("remote branch at the head", s.world.remote.get("refs/heads/ticket/10.1-demo"), s.head);
    const again = ok("push retry, same head", await s.delivery.push("10.1", s.head));
    check("same head is accepted without pushing again", again.already && s.world.count("git", "push") === 1);

    const other = scenario("push-other");
    other.world.remote.set("refs/heads/ticket/10.1-demo", other.reviewed);
    refused("remote branch with a different head", await other.delivery.push("10.1", other.head), "refused", /not overwriting/);
    eq("different remote head untouched", other.world.remote.get("refs/heads/ticket/10.1-demo"), other.reviewed);
    eq("no push attempted over a different head", other.world.count("git", "push"), 0);

    const denied = scenario("push-403");
    denied.world.pushFail = result(
      "",
      128,
      `remote: Permission to owner/project.git denied to someone.\nfatal: unable to access 'https://x-access-token:${GH_TOKEN}@github.com/owner/project.git/': The requested URL returned error: 403`,
    );
    const o = await denied.delivery.push("10.1", denied.head);
    refused("push refused with 403", o, "auth", /403/);
    check("403 offers the sign-in fix", !o.ok && o.fix === "gh auth login --web");
    check("403 token never surfaces", !JSON.stringify(o).includes(GH_TOKEN) && !readFileSync(join(denied.stateDir, "10.1.json"), "utf8").includes(GH_TOKEN));

    // Every push this run made: one refspec, the ticket branch, nothing local-only.
    const pushes = [s, other, denied].flatMap((x) => x.world.calls.filter((c) => c.cmd === "git" && c.args[0] === "push"));
    check("pushes were made", pushes.length === 2, pushes.length);
    for (const p of pushes) {
      const spec = p.args[p.args.length - 1];
      check(`pushed refspec ${spec} is <sha>:refs/heads/ticket/…`, /^[0-9a-f]{40}:refs\/heads\/ticket\/10\.1-demo$/.test(spec));
      check("no force/all/mirror/tags", !p.args.some((a) => /^(-f|--force.*|--all|--mirror|--tags)$/.test(a)));
      check("no local-only refs pushed", !p.args.some((a) => /refs\/(backup|pathfinder)\//.test(a)));
    }
    check("remote has no local-only refs", [...s.world.remote.keys()].every((r) => r.startsWith("refs/heads/")) && ![...s.world.remote.keys()].some((r) => /backup|pathfinder/.test(r)));
  }

  // ---- ensure-PR: before push, create, reuse, draft, merged, auth (gh exit 4)
  {
    const s = scenario("pr");
    refused("PR before push", await s.delivery.ensurePr("10.1"), "refused", /push it first/);
    ok("push for PR", await s.delivery.push("10.1", s.head));
    const created = ok("ensure PR creates", await s.delivery.ensurePr("10.1"));
    check("created a normal PR", created.created && !created.pr.isDraft && created.pr.state === "OPEN");
    const createCall = s.world.calls.find((c) => c.cmd === "gh" && c.args[1] === "create")!;
    check("create names the repo, base and head", createCall.args.join(" ").includes("-R owner/project --base main --head ticket/10.1-demo"));
    check("create is not a draft", !createCall.args.includes("--draft"));
    check("default title from the claim", created.pr.title === "Demo feature (ticket 10.1)", created.pr.title);
    const reused = ok("ensure PR reuses", await s.delivery.ensurePr("10.1"));
    check("existing PR reused, not created again", !reused.created && reused.pr.number === created.pr.number && s.world.count("gh", "pr", "create") === 1);
    eq("state records the PR", s.delivery.read("10.1").pr, { number: created.pr.number, url: created.pr.url });

    const d = scenario("pr-draft");
    ok("push for draft", await d.delivery.push("10.1", d.head));
    d.world.prs.push({ number: 7, title: "Draft", state: "OPEN", isDraft: true, headRefName: "ticket/10.1-demo", headRefOid: d.head, baseRefName: "main", mergeable: "MERGEABLE", reviewDecision: "", mergeCommit: null, checks: "none" });
    const fromDraft = ok("ensure PR on a draft", await d.delivery.ensurePr("10.1"));
    check("draft marked ready and reused", fromDraft.pr.number === 7 && !fromDraft.created && d.world.count("gh", "pr", "ready") === 1 && d.world.prs[0].isDraft === false);

    const a = scenario("pr-auth");
    ok("push for auth", await a.delivery.push("10.1", a.head));
    a.world.authFail = true;
    const o = await a.delivery.ensurePr("10.1");
    refused("gh exit 4", o, "auth", /sign-in/);
    check("gh exit 4 offers the sign-in fix", !o.ok && o.fix === "gh auth login --web");
    a.world.authFail = false;
    a.world.createFail = result("", 1, `HTTP 422: Validation Failed\nAuthorization: token ${GH_TOKEN}\nhttps://user:${GH_TOKEN}@github.com`);
    const leaky = await a.delivery.ensurePr("10.1");
    check("a failing create is reported", !leaky.ok && leaky.kind === "failed");
    check("token never in a returned message", !JSON.stringify(leaky).includes(GH_TOKEN));
    const file = readFileSync(join(a.stateDir, "10.1.json"), "utf8");
    check("token never in the stored state", !file.includes(GH_TOKEN) && !file.includes(filler.slice(0, 20)));
  }

  // ---- status, merge, verify: checks as reported, stale approvals, idempotent retries
  const ready = async (name: string, checks: FakePr["checks"] = "none") => {
    const s = scenario(name);
    s.world.defaultChecks = checks;
    ok(`${name}: push`, await s.delivery.push("10.1", s.head));
    ok(`${name}: PR`, await s.delivery.ensurePr("10.1"));
    const i = ok(`${name}: inspect`, await s.delivery.inspect("10.1"));
    return { ...s, i };
  };
  {
    const s = await ready("checks-none");
    const st = ok("status, no checks", await s.delivery.status("10.1"));
    eq("no checks reported is 'none', not passing", st.checks.summary, "none");
    eq("status head", st.head, s.head);
    eq("status mergeable", st.mergeable, "MERGEABLE");
    refused("no checks without acknowledgement", await s.delivery.merge("10.1", approvalOf(s.i)), "blocked", /acknowledgement/);
    s.world.claims.get("10.1")!.last = `review PASS on ${s.reviewed.slice(0, 8)}`;
    ok("approval recorded", await s.delivery.approve("10.1", approvalOf(s.i, { acknowledgeNoChecks: true })));
    eq("approval stored as {key, head, base, tree}", (({ key, head, base, tree }) => ({ key, head, base, tree }))(s.delivery.read("10.1").approval!), { key: "10.1", head: s.head, base: s.base, tree: s.i.tree });
    eq("no merge attempted while blocked", s.world.count("gh", "pr", "merge"), 0);

    const merged = ok("merge with acknowledgement and evidence", await s.delivery.merge("10.1", approvalOf(s.i, { acknowledgeNoChecks: true })));
    check("merge result", !merged.already && merged.checks === "none" && merged.evidence?.includes("review PASS"), merged);
    const mergeCall = s.world.calls.find((c) => c.cmd === "gh" && c.args[1] === "merge")!;
    check("merge is a squash pinned to the approved head", mergeCall.args.includes("--squash") && mergeCall.args[mergeCall.args.indexOf("--match-head-commit") + 1] === s.head);
    check("merge keeps the remote branch", !mergeCall.args.includes("--delete-branch") && s.world.remote.has("refs/heads/ticket/10.1-demo"));
    const m = s.world.remote.get("refs/heads/main")!;
    eq("merge commit recorded", merged.mergeCommit, m);
    eq("squash parent is the approved base", git(s.repo, "rev-parse", `${m}^`), s.base);
    eq("squash tree is the expected tree", git(s.repo, "rev-parse", `${m}^{tree}`), s.i.tree);

    const again = ok("merge retry when already merged", await s.delivery.merge("10.1", approvalOf(s.i, { acknowledgeNoChecks: true })));
    check("already merged is verified, not merged again", again.already && s.world.count("gh", "pr", "merge") === 1);
    const v = ok("verify", await s.delivery.verify("10.1"));
    eq("verify", [v.mergeCommit, v.parent, v.tree], [m, s.base, s.i.tree]);
    check("state says verified", s.delivery.read("10.1").verified && s.delivery.read("10.1").mergeCommit === m);

    // Reconnect / restart: a new store and Delivery on the same folder see the same state.
    const reopened = s.make().read("10.1");
    check("state survives a restart", reopened.verified && reopened.steps.push?.ok && reopened.steps.ensurePr?.ok && reopened.steps.merge?.ok && reopened.steps.verify?.ok, reopened.steps);
  }
  {
    const s = await ready("checks-failed", [
      { name: "ci", bucket: "pass", state: "SUCCESS", link: "" },
      { name: "lint", bucket: "fail", state: "FAILURE", link: "" },
    ]);
    eq("status, failed check", ok("status, failed check", await s.delivery.status("10.1")).checks.summary, "failed");
    refused("failed check blocks the merge", await s.delivery.merge("10.1", approvalOf(s.i, { acknowledgeNoChecks: true })), "blocked", /failing check.*lint/);
    eq("failed check: no merge", s.world.count("gh", "pr", "merge"), 0);
  }
  {
    const s = await ready("checks-pending", [{ name: "ci", bucket: "pending", state: "IN_PROGRESS", link: "" }]);
    const st = ok("status, pending check", await s.delivery.status("10.1"));
    eq("pending summary", st.checks.summary, "pending");
    refused("pending check blocks the merge", await s.delivery.merge("10.1", approvalOf(s.i)), "blocked", /still running/);
  }
  {
    const s = await ready("checks-passed", [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }]);
    s.world.prs[0].mergeable = "UNKNOWN";
    refused("mergeability not computed yet", await s.delivery.merge("10.1", approvalOf(s.i)), "blocked", /not computed/);
    s.world.prs[0].mergeable = "MERGEABLE";
    const merged = ok("merge with passing checks (no acknowledgement needed)", await s.delivery.merge("10.1", approvalOf(s.i)));
    eq("passing checks merge", merged.checks, "passed");
  }
  {
    // Stale: the base moved.
    const s = await ready("stale-base", [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }]);
    ok("approve", await s.delivery.approve("10.1", approvalOf(s.i)));
    s.write("docs.md", "unrelated\n");
    const moved = s.commit("someone else merged");
    s.world.remote.set("refs/heads/main", moved);
    const o = await s.delivery.merge("10.1", approvalOf(s.i));
    refused("stale approval: base moved", o, "stale", /base moved from .* to /);
    const st = s.delivery.read("10.1");
    check("stale approval cleared, with the reason kept for the UI", st.approval === null && st.invalidated?.reasons.some((r) => r.startsWith("base moved")), st.invalidated);
    eq("stale: no merge", s.world.count("gh", "pr", "merge"), 0);
  }
  {
    // Stale: the head moved (a later record-only commit, pushed to the PR).
    const s = await ready("stale-head", [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }]);
    ok("approve", await s.delivery.approve("10.1", approvalOf(s.i)));
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    s.write("context/tickets/10.1-demo.md", "# Demo\n\nanother note\n");
    const newer = s.commit("another record note");
    git(s.repo, "checkout", "-q", "main");
    s.world.remote.set("refs/heads/ticket/10.1-demo", newer);
    refused("stale approval: head moved", await s.delivery.merge("10.1", approvalOf(s.i)), "stale", /head moved from .* to /);
    // Inspecting also invalidates a stored approval, so the UI shows why before any click.
    const t = await ready("stale-on-inspect", [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }]);
    ok("approve", await t.delivery.approve("10.1", approvalOf(t.i)));
    t.write("docs.md", "unrelated\n");
    t.world.remote.set("refs/heads/main", t.commit("main moved"));
    ok("re-inspect", await t.delivery.inspect("10.1"));
    check("inspect invalidated the approval", t.delivery.read("10.1").approval === null && !!t.delivery.read("10.1").invalidated?.reasons.length);
    refused("approve against a stale view", await t.delivery.approve("10.1", approvalOf(t.i)), "stale", /base moved/);
  }

  // ---- the 05.1 → 05.2 replay
  await replay();
}

// ---------------------------------------------------------------- 05.1 → 05.2 replay

const R = {
  base: "7b3eda3e73ee398acf63a677e9bf03d870aaf55c",
  b51: "ticket/05.1-adopt-and-repair-the-run-policy-draft",
  h51: "b2b92044de5096248277b8ef9b97e18f0aab30c7",
  r51: "64962bf8d259ebe599bcb656b04464f48c38d962",
  b52: "ticket/05.2-land-the-project-overview-and-the-creden",
  h52: "ff00d6ec5c229b6887c79af7f2fd492a70127da8",
  r52: "df080b1d496fbab2687dce67e0a03644aeba6bac",
  t1: "4ef46c870ce3dee487e915f19712cd3f2300d139",
  t2: "1811484d067e504728da2541887f8839819ba065",
  denylist: ["2133c3d", "befeaa9", "0a2ae82", "46c672f"],
};

let replayed = false;
async function replay() {
  const have = [R.base, R.h51, R.h52, R.r51, R.r52].every((sha) => {
    try {
      execFileSync("git", ["--git-dir", projectGitDir, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!have) {
    console.log("SKIPPED 05.1 → 05.2 replay: this clone does not have the 05.1/05.2 commits");
    return;
  }
  // A --shared clone reads this repository's objects and writes only its own.
  const repo = join(tmp, "replay");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", projectGitDir, repo], { stdio: "ignore" });
  git(repo, "update-ref", `refs/heads/${R.b51}`, R.h51);
  git(repo, "update-ref", `refs/heads/${R.b52}`, R.h52);
  git(repo, "update-ref", "refs/backup/05.1-bookkeeping-v1", R.r51);
  git(repo, "update-ref", "refs/pathfinder/claims/05.1", R.h51);
  const denylist = R.denylist.map((c) => {
    try {
      return git(repo, "rev-parse", "--verify", `${c}^{commit}`);
    } catch {
      return c;
    }
  });

  const world = new World(repo);
  world.originUrl = "https://github.com/rikilamadrid/tin-and-thyme.git";
  world.remote.set("refs/heads/main", R.base);
  // The claims' real Last lines.
  world.claims.set("05.1", {
    branch: R.b51,
    worktree: ".pathfinder/worktrees/05.1",
    state: "done",
    last: "reconciled 2026-11-12: reviewed 64962bf8 (tree 6b0c6ce) + bookkeeping-only b2b92044; local CI-equivalent green on PR head and on expected post-merge tree 4ef46c87",
    ref: "context/tickets/05.1-adopt-and-repair-run-policy.md",
    title: "Adopt and repair the run policy draft",
  });
  world.claims.set("05.2", {
    branch: R.b52,
    worktree: ".pathfinder/worktrees/05.2",
    state: "done",
    last: "reconciled 2026-11-12: review PASS df080b1d + bookkeeping-only ff00d6ec; docs-only; check candidate; merges after 05.1",
    ref: "context/tickets/05.2-land-project-overview-and-feature-08.md",
    title: "Land the project overview and the credential-separation feature record",
  });
  const d = new Delivery({ root: repo, repo: "rikilamadrid/tin-and-thyme", store: new DeliveryStore(join(tmp, "replay-deliveries")), runner: world.runner, denylist });

  // 05.1 against its real base.
  const i51 = ok("replay 05.1 inspect", await d.inspect("05.1"));
  eq("05.1 head", i51.head, R.h51);
  eq("05.1 reviewed head", i51.reviewedHead, R.r51);
  eq("05.1 record-only commit", i51.recordOnly, [R.h51]);
  eq("05.1 base", i51.base, R.base);
  eq("05.1 expected tree is T1", i51.tree, R.t1);
  // 05.2 approved early, against the old base: it must go stale once 05.1 lands.
  const early52 = ok("replay 05.2 early inspect", await d.inspect("05.2"));
  eq("05.2 reviewed head", early52.reviewedHead, R.r52);

  ok("replay 05.1 push", await d.push("05.1", R.h51));
  ok("replay 05.2 push", await d.push("05.2", R.h52));
  const p51 = ok("replay 05.1 PR", await d.ensurePr("05.1"));
  const p52 = ok("replay 05.2 PR", await d.ensurePr("05.2"));
  check("replay PRs are normal PRs", p51.created && p52.created && !p51.pr.isDraft && !p52.pr.isDraft);
  eq("replay 05.1 checks: none reported (CI unavailable)", ok("replay 05.1 status", await d.status("05.1")).checks.summary, "none");

  const m51 = ok("replay 05.1 merge", await d.merge("05.1", approvalOf(i51, { acknowledgeNoChecks: true })));
  const M51 = world.remote.get("refs/heads/main")!;
  eq("05.1 squash parent is BASE", git(repo, "rev-parse", `${M51}^`), R.base);
  eq("05.1 main tree is T1", git(repo, "rev-parse", `${M51}^{tree}`), R.t1);
  eq("05.1 merge commit", m51.mergeCommit, M51);

  refused("replay 05.2 early approval is stale after 05.1", await d.merge("05.2", approvalOf(early52, { acknowledgeNoChecks: true })), "stale", /base moved from 7b3eda3e/);
  const i52 = ok("replay 05.2 re-inspect against the new main", await d.inspect("05.2"));
  eq("05.2 base is the 05.1 squash", i52.base, M51);
  eq("05.2 expected tree is T2", i52.tree, R.t2);
  ok("replay 05.2 approve", await d.approve("05.2", approvalOf(i52, { acknowledgeNoChecks: true })));
  ok("replay 05.2 merge", await d.merge("05.2", approvalOf(i52, { acknowledgeNoChecks: true })));
  const M52 = world.remote.get("refs/heads/main")!;
  eq("05.2 squash parent is M51", git(repo, "rev-parse", `${M52}^`), M51);
  eq("05.2 main tree is T2", git(repo, "rev-parse", `${M52}^{tree}`), R.t2);
  ok("replay 05.1 verify after 05.2", await d.verify("05.1"));
  ok("replay 05.2 verify", await d.verify("05.2"));

  eq(
    "replay remote refs: main and the two ticket branches only",
    [...world.remote.keys()].sort(),
    ["refs/heads/main", `refs/heads/${R.b51}`, `refs/heads/${R.b52}`].sort(),
  );
  eq("replay remote ticket heads", [world.remote.get(`refs/heads/${R.b51}`), world.remote.get(`refs/heads/${R.b52}`)], [R.h51, R.h52]);
  const pushes = world.calls.filter((c) => c.cmd === "git" && c.args[0] === "push").map((c) => c.args[c.args.length - 1]);
  eq("replay pushed exactly the two pinned refspecs", pushes, [`${R.h51}:refs/heads/${R.b51}`, `${R.h52}:refs/heads/${R.b52}`]);
  replayed = true;
}

main()
  .catch((e) => failures.push(`aborted: ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      console.error(`FAIL ${failures.length} of ${passed + failures.length} checks:`);
      for (const f of failures) console.error("  - " + f);
      process.exit(1);
    }
    console.log(`ok ${passed} checks passed${replayed ? " (including the 05.1 → 05.2 replay on the real objects)" : ""}`);
  });
