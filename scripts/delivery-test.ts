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

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type RunResult } from "../server/lib/exec";
import { defaultRunner, isClearMergeRefusal, MERGE_TIMEOUT_MS, nonInteractiveEnv, summarizeChecks, type Check, type Program, type Runner } from "../server/delivery/forge";
import {
  assertSafePushArgs,
  Delivery,
  isDenylistEntry,
  isTicketBranch,
  isTicketRecord,
  parseGithubRemote,
  pushArgs,
  reviewedHeadOf,
  scanDiff,
  scanMessages,
  type Inspection,
  type Outcome,
} from "../server/delivery/ops";
import { DeliveryError, DeliveryStore, mergeOutcome, redact, type Approval } from "../server/delivery/state";

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
  /** A PR from a fork: true, with the fork owner. */
  isCrossRepository?: boolean;
  headOwner?: string;
}

interface FakeClaim {
  branch: string;
  worktree: string;
  state: string;
  last: string;
  ref: string | null;
  title: string;
  orphan?: boolean;
}

class World {
  originUrl = "https://github.com/owner/project.git";
  /** `git remote get-url --push --all origin`; null means the origin URL. */
  pushUrls: string[] | null = null;
  owner = "owner";
  remote = new Map<string, string>();
  /** Runs before each ls-remote is answered (to move a remote ref at the last moment). */
  beforeLsRemote: ((ref: string) => void) | null = null;
  /** The fake squash merge writes a wrong tree or parent (a merge that cannot be verified). */
  mergeTamper: "tree" | "parent" | null = null;
  claims = new Map<string, FakeClaim>();
  dirty = "";
  prs: FakePr[] = [];
  calls: { cmd: Program; args: string[] }[] = [];
  authFail = false;
  pushFail: RunResult | null = null;
  createFail: RunResult | null = null;
  defaultChecks: Check[] | "none" = "none";
  defaultMergeable: FakePr["mergeable"] = "MERGEABLE";
  /** GitHub lagging behind its own merge: each `pr view` of a merged PR takes the next answer ("open" or "fail"). */
  viewLag: ("open" | "fail")[] = [];
  /** The merge command fails without merging. */
  mergeRefuse: RunResult | null = null;
  /** The merge command merges, then reports this (a merge reported badly). */
  mergeReport: RunResult | null = null;
  /** Runs right after the fake merge lands. */
  afterMerge: (() => void) | null = null;
  /** The next N fetches fail (a transient network failure). */
  fetchFails = 0;
  /** Squash merges actually performed on the simulated GitHub. */
  merges = 0;

  constructor(readonly repo: string) {}

  /** Real local git, for commands that neither touch the network nor move a ref. */
  private static PASS = new Set(["rev-parse", "merge-base", "cat-file", "diff", "merge-tree", "rev-list", "log"]);

  readonly runner: Runner = async (cmd, args, opts = {}) => {
    this.calls.push({ cmd, args: [...args] });
    if (cmd === "node") return this.engine(args);
    if (cmd === "gh") return this.gh(args);
    const [sub] = args;
    if (sub === "push") return this.push(args);
    if (sub === "remote") {
      if (args.join(" ") === "remote get-url origin") return result(this.originUrl + "\n");
      if (args.join(" ") === "remote get-url --push --all origin") return result((this.pushUrls ?? [this.originUrl]).map((u) => u + "\n").join(""));
      return result("", 2, "unexpected remote call");
    }
    if (sub === "status") return result(this.dirty);
    if (sub === "ls-remote") {
      const ref = args[2];
      this.beforeLsRemote?.(ref);
      const sha = this.remote.get(ref);
      return result(sha ? `${sha}\t${ref}\n` : "");
    }
    if (sub === "fetch") {
      if (this.fetchFails > 0) {
        this.fetchFails--;
        return result("", 128, "fatal: unable to access 'https://github.com/owner/project.git/': Could not resolve host: github.com");
      }
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
    const { checks: _checks, mergeCommit, headOwner, isCrossRepository, ...rest } = pr;
    return {
      ...rest,
      headRefOid: head,
      url: `https://github.com/owner/project/pull/${pr.number}`,
      mergeCommit: mergeCommit ? { oid: mergeCommit } : null,
      isCrossRepository: isCrossRepository ?? false,
      headRepositoryOwner: { id: "MDQ6VXNlcjE=", login: headOwner ?? this.owner },
    };
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
    if (sub === "view") {
      const lag = pr.state === "MERGED" ? this.viewLag.shift() : undefined;
      if (lag === "fail") return result("", 1, "HTTP 502: Bad Gateway (https://api.github.com/graphql)");
      if (lag === "open") return result(JSON.stringify({ ...this.view(pr), state: "OPEN", mergeCommit: null }));
      return result(JSON.stringify(this.view(pr)));
    }
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
      if (this.mergeRefuse) return this.mergeRefuse;
      // A real squash: the merge of the branch onto the current remote main, as one commit.
      const main = this.remote.get(`refs/heads/${pr.baseRefName}`)!;
      const merged = git(this.repo, "merge-tree", "--write-tree", main, head).split("\n")[0];
      const tree = this.mergeTamper === "tree" ? git(this.repo, "rev-parse", `${main}^{tree}`) : merged;
      const parent = this.mergeTamper === "parent" ? head : main;
      const commit = git(this.repo, "commit-tree", tree, "-p", parent, "-m", this.flag(args, "--subject") ?? pr.title);
      this.remote.set(`refs/heads/${pr.baseRefName}`, commit);
      Object.assign(pr, { state: "MERGED", headRefOid: head, mergeCommit: commit });
      this.merges++;
      this.afterMerge?.();
      if (this.mergeReport) return this.mergeReport;
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
    last: `review PASS on ${reviewed}`,
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

// The claims' real `Last:` lines (orchestrator decision: exactly `review PASS on <full sha>`).
const RV = "64962bf8d259ebe599bcb656b04464f48c38d962";
eq("reviewed head: the one accepted form", reviewedHeadOf(`review PASS on ${RV}`), RV);
eq("reviewed head: 01.1's real line", reviewedHeadOf("review PASS on 61cd56e8ed4f3890bca9ff72f717d20e66bf5e4d"), "61cd56e8ed4f3890bca9ff72f717d20e66bf5e4d");
for (const last of [
  "review PASS on 61cd56e8",
  "review PASS on 61cd56e8 (round 2); local CI-equivalent green",
  `review pass on ${RV}`,
  `Review PASS on ${RV}`,
  `review PASS ${RV}`,
  `reviewed ${RV}`,
  `review on ${RV}: FINDINGS`,
  `review FINDINGS on ${RV}`,
  `review FAIL on ${RV}`,
  `review PASS on ${RV}: FINDINGS`,
  `review PASS on ${RV} (round 2)`,
  `not review PASS on ${RV}`,
  `review PASS on ${RV} not yet`,
  `ready for review on ${RV}`,
  `awaiting review ${RV}`,
  `not reviewed ${RV} yet`,
  ` review PASS on ${RV}`,
  `review PASS on ${RV}\n`,
  `review PASS on ${RV}0`,
  `review PASS on ${RV.toUpperCase()}`,
  "reconciled 2026-11-12: reviewed 64962bf8 (tree 6b0c6ce) + bookkeeping-only b2b92044",
  "Phase A done: automated checks pass",
  "",
]) eq(`reviewed head refused: ${JSON.stringify(last)}`, reviewedHeadOf(last), null);
eq("reviewed head: none", reviewedHeadOf(null), null);

// The ticket's own record, the only file a post-review commit may touch.
check("record path ok", isTicketRecord("context/tickets/10.1-delivery-core.md", "10.1"));
for (const bad of ["src/feature.ts", "context/tickets/10.2-x.md", "context/tickets/10.11-x.md", "context/tickets/1001-x.md", "context/tickets/10.1-a/b.md", "context/tickets/10.1-x.md.ts", "x/context/tickets/10.1-x.md", "context/features/10.1-x.md"])
  check(`record path refused: ${bad}`, !isTicketRecord(bad, "10.1"));

// Denylist entries: commit ids only.
for (const good of ["2133c3d", "2133c3dd92ea38e7f98023085b20bb45f43f7fa7"]) check(`denylist entry ok: ${good}`, isDenylistEntry(good));
for (const bad of ["-abcdef1", "--output=/tmp/x", "2133c3", "2133C3D", "HEAD", "main", "2133c3d^", "2133c3dd92ea38e7f98023085b20bb45f43f7fa70", "", 7])
  check(`denylist entry malformed: ${JSON.stringify(bad)}`, !isDenylistEntry(bad));

// Delivery's git and gh calls never wait on a prompt.
eq("non-interactive env", nonInteractiveEnv({}), { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
eq("non-interactive env keeps a custom ssh command", nonInteractiveEnv({ GIT_SSH_COMMAND: "ssh -i ~/.ssh/k" }).GIT_SSH_COMMAND, "ssh -i ~/.ssh/k -o BatchMode=yes");
eq("non-interactive env leaves GIT_SSH alone", nonInteractiveEnv({ GIT_SSH: "/usr/local/bin/myssh" }).GIT_SSH_COMMAND, undefined);

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
eq("checks: all skipped is none, not passed", summarizeChecks([{ name: "x", bucket: "skipping", state: "SKIPPED", link: "" }, { name: "y", bucket: "skipping", state: "SKIPPED", link: "" }]), "none");

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
eq("scan finds the token and the literal header", scanned.findings, [
  { file: "src/x.ts", line: 10, kind: "GitHub token" },
  { file: "src/x.ts", line: 12, kind: "Authorization header with a literal credential" },
]);
check("scan never returns the secret", !JSON.stringify(scanned).includes(GH_TOKEN));
// An added line that itself starts with "++ " is content, not a file header.
const plusplus = scanDiff(["diff --git a/notes.txt b/notes.txt", "--- a/notes.txt", "+++ b/notes.txt", "@@ -0,0 +1,2 @@", "+ok", `+++ ${GH_TOKEN}`, `--- removed`].join("\n"));
eq("scan reads an added '++ ' line", plusplus.findings, [{ file: "notes.txt", line: 2, kind: "GitHub token" }]);
// `git log -p` output: each finding names its commit; binary files are listed as unscanned.
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const logScan = scanDiff(
  [
    `commit ${C1}`,
    "",
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1 @@",
    `+const t = "${GH_TOKEN}";`,
    `commit ${C2}`,
    "",
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "Binary files /dev/null and b/img.png differ",
    "diff --git a/a.ts b/a.ts",
    "deleted file mode 100644",
    "--- a/a.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    `-const t = "${GH_TOKEN}";`,
  ].join("\n"),
);
eq("log scan attributes the finding to its commit", logScan.findings, [{ commit: C1, file: "a.ts", line: 1, kind: "GitHub token" }]);
eq("log scan lists binary files as unscanned", logScan.binary, [`${C2.slice(0, 12)} img.png`]);
eq("message scan", scanMessages(`${C1}\x1fFix things\n\nused ${GH_TOKEN} to test\n\x1e\n${C2}\x1fclean\n\x1e`), [{ commit: C1, file: "(commit message)", line: 3, kind: "GitHub token" }]);

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
    check("inspect evidence comes from the claim", i.evidence === `review PASS on ${s.reviewed}`);
    eq("inspect: nothing unscanned", i.unscanned, []);
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

  // ---- repair round 1: the reviewed head is only `review PASS on <full sha>` (H1)
  {
    const s = scenario("h1-forms");
    const c = s.world.claims.get("10.1")!;
    for (const last of [`review PASS on ${s.reviewed.slice(0, 8)}`, `review PASS on ${s.reviewed} (round 2)`, `review FINDINGS on ${s.reviewed}`, `reviewed ${s.reviewed}`, `ready for review on ${s.reviewed}`, `review on ${s.reviewed}: FINDINGS`]) {
      c.last = last;
      refused(`claim Last refused: ${last.replace(s.reviewed, "<sha>")}`, await s.delivery.inspect("10.1"), "refused", /no reviewed head/);
    }
    c.last = `review PASS on ${"0".repeat(40)}`;
    refused("claim names a commit the repository lacks", await s.delivery.inspect("10.1"), "invalid", /reviewed head/);
    c.last = `review PASS on ${s.reviewed}`;
    ok("exact form accepted", await s.delivery.inspect("10.1"));
  }

  // ---- the claim's record path (M1)
  {
    const s = scenario("m1-ref");
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    s.write("src/feature.ts", "export const feature = 'after review';\n");
    s.commit("code after review");
    git(s.repo, "checkout", "-q", "main");
    const c = s.world.claims.get("10.1")!;
    c.ref = "src/feature.ts";
    refused("Store: naming a code file", await s.delivery.inspect("10.1"), "refused", /names src\/feature\.ts as its record/);
    c.ref = "context/tickets/10.2-other.md";
    refused("Store: naming another ticket's record", await s.delivery.inspect("10.1"), "refused", /as its record/);
    c.ref = null;
    refused("no record path", await s.delivery.inspect("10.1"), "refused", /no file as its record/);
    c.ref = "context/tickets/10.1-demo.md";
    refused("the code change is still caught with the right record", await s.delivery.inspect("10.1"), "refused", /more than the ticket record.*src\/feature\.ts/);
  }

  // ---- the push URL (M2)
  {
    const s = scenario("m2-pushurl");
    for (const [label, urls, why] of [
      ["pushurl to another repository", ["https://github.com/someone-else/project.git"], /pushes to https:\/\/github\.com\/someone-else/],
      ["pushInsteadOf to another host", ["https://gitlab.com/owner/project.git"], /pushes to/],
      ["two push URLs", ["https://github.com/owner/project.git", "https://github.com/someone-else/project.git"], /2 push URLs/],
      ["no push URL", [], /0 push URLs/],
    ] as const) {
      s.world.pushUrls = [...urls];
      refused(label, await s.delivery.push("10.1", s.head), "invalid", why);
    }
    eq("no push with a bad push URL", s.world.count("git", "push"), 0);
    s.world.pushUrls = ["git@github.com:owner/project.git"];
    ok("an ssh push URL to the same repository", await s.delivery.push("10.1", s.head));
  }

  // ---- fork / cross-repository PRs (M3)
  {
    const fork = (s: ReturnType<typeof scenario>, extra: Partial<FakePr>): FakePr => ({
      number: 9,
      title: "Totally the ticket",
      state: "OPEN",
      isDraft: false,
      headRefName: "ticket/10.1-demo",
      headRefOid: s.head,
      baseRefName: "main",
      mergeable: "MERGEABLE",
      reviewDecision: "",
      mergeCommit: null,
      checks: [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }],
      ...extra,
    });
    const s = scenario("m3-fork");
    ok("push before a fork PR", await s.delivery.push("10.1", s.head));
    const i = ok("inspect before a fork PR", await s.delivery.inspect("10.1"));
    s.world.prs.push(fork(s, { isCrossRepository: true, headOwner: "mallory" }));
    refused("fork PR is not reused", await s.delivery.ensurePr("10.1"), "refused", /another repository \(mallory\)/);
    eq("no PR created beside a fork PR", s.world.count("gh", "pr", "create"), 0);
    refused("fork PR status", await s.delivery.status("10.1"), "refused", /another repository/);
    refused("fork PR is never merged", await s.delivery.merge("10.1", approvalOf(i)), "refused", /another repository/);
    s.world.prs[0] = fork(s, { isCrossRepository: false, headOwner: "mallory" });
    refused("head owner other than the repository owner", await s.delivery.ensurePr("10.1"), "refused", /another repository \(mallory\)/);
    s.world.prs[0] = fork(s, { state: "MERGED", isCrossRepository: true, headOwner: "mallory", mergeCommit: s.head });
    refused("merged fork PR is not taken as this ticket's merge", await s.delivery.merge("10.1", approvalOf(i)), "refused", /another repository/);
    eq("fork: no merge", s.world.count("gh", "pr", "merge"), 0);
    s.world.prs[0] = fork(s, { state: "CLOSED", isCrossRepository: true, headOwner: "mallory" });
    const created = ok("a closed fork PR is ignored", await s.delivery.ensurePr("10.1"));
    check("own PR created", created.created);
  }

  // ---- denylist entries (M6)
  {
    const s = scenario("m6-denylist");
    for (const bad of ["--output=/tmp/pwned", "-abcdef1", "HEAD", "ABCDEF1234567", "2133c3", `${s.reviewed}^`]) {
      refused(`denylist entry ${bad}`, await s.make({ denylist: [bad] }).inspect("10.1"), "invalid", /not a commit id/);
    }
    check("a malformed entry never reaches git", !s.world.calls.some((c) => c.args.some((a) => a.includes("--output=") || a.includes("-abcdef1") || a.includes("ABCDEF"))));
    refused("abbreviation that resolves to nothing", await s.make({ denylist: ["0000000"] }).inspect("10.1"), "refused", /does not resolve to exactly one commit/);
    // Two commits sharing a 7-digit prefix, found offline and written as real objects.
    const emptyTree = git(s.repo, "hash-object", "-t", "tree", "-w", "--stdin");
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let n = 0; !pair; n++) {
      const body = `tree ${emptyTree}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nn${n}\n`;
      const id = createHash("sha1").update(`commit ${Buffer.byteLength(body)}\0${body}`).digest("hex");
      const prev = seen.get(id.slice(0, 7));
      if (prev !== undefined) pair = [prev, body];
      else seen.set(id.slice(0, 7), body);
    }
    const ids = pair.map((body) => execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: s.repo, input: body, encoding: "utf8" }).trim());
    check("two commits share a 7-digit prefix", ids[0] !== ids[1] && ids[0].slice(0, 7) === ids[1].slice(0, 7), ids);
    refused("ambiguous abbreviation", await s.make({ denylist: [ids[0].slice(0, 7)] }).inspect("10.1"), "refused", /does not resolve to exactly one commit/);
    ok("the full ids are fine (not in the ancestry)", await s.make({ denylist: ids }).inspect("10.1"));
    refused("abbreviation of a commit in the ancestry", await s.make({ denylist: [s.reviewed.slice(0, 10)] }).inspect("10.1"), "refused", new RegExp(`denylisted commit ${s.reviewed}`));
  }

  // ---- per-commit secret scan (M7), commit messages, binary files (L1)
  {
    const s = scenario("m7-history");
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    s.write("src/config.ts", `export const token = "${GH_TOKEN}";\n`);
    const added = s.commit("add config");
    rmSync(join(s.repo, "src/config.ts"));
    const removed = s.commit("remove config");
    git(s.repo, "checkout", "-q", "main");
    s.world.claims.get("10.1")!.last = `review PASS on ${removed}`;
    check("the combined diff no longer has the secret", !git(s.repo, "diff", s.base, removed).includes(GH_TOKEN));
    const o = await s.delivery.inspect("10.1");
    refused("secret added then removed is still refused", o, "refused", new RegExp(`${added.slice(0, 12)} src/config\\.ts:1 \\(GitHub token\\)`));
    check("history secret not in the refusal", !JSON.stringify(o).includes(GH_TOKEN));
  }
  {
    const s = scenario("m7-message");
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    s.write("src/more.ts", "export const more = 1;\n");
    const c = s.commit(`more\n\ndebugged with ${GH_TOKEN}`);
    git(s.repo, "checkout", "-q", "main");
    s.world.claims.get("10.1")!.last = `review PASS on ${c}`;
    const o = await s.delivery.inspect("10.1");
    refused("secret in a commit message", o, "refused", /\(commit message\):3 \(GitHub token\)/);
    check("message secret not in the refusal or state", !JSON.stringify(o).includes(GH_TOKEN) && !readFileSync(join(s.stateDir, "10.1.json"), "utf8").includes(GH_TOKEN));
  }
  {
    const s = scenario("l1-binary");
    git(s.repo, "checkout", "-q", "ticket/10.1-demo");
    writeFileSync(join(s.repo, "src", "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 10]));
    const c = s.commit("binary");
    git(s.repo, "checkout", "-q", "main");
    s.world.claims.get("10.1")!.last = `review PASS on ${c}`;
    const i = ok("binary file is inspected", await s.delivery.inspect("10.1"));
    eq("binary file listed as unscanned", i.unscanned, [`${c.slice(0, 12)} src/blob.bin`]);
    check("the inspect message says so", /1 binary file\(s\) not scanned/.test(s.delivery.read("10.1").steps.inspect?.message ?? ""));
  }

  // ---- concurrency and the cross-instance merge lock (M4, L6)
  /** A second ticket, 10.2, on its own branch from the same base, pushed with an open PR. */
  const second = async (s: Awaited<ReturnType<typeof ready>>) => {
    git(s.repo, "checkout", "-q", "-b", "ticket/10.2-other", s.base);
    s.write("src/other.ts", "export const other = 1;\n");
    s.write("context/tickets/10.2-other.md", "# Other\n");
    const reviewed = s.commit("other");
    git(s.repo, "checkout", "-q", "main");
    s.world.claims.set("10.2", { branch: "ticket/10.2-other", worktree: ".pathfinder/worktrees/10.2", state: "done", last: `review PASS on ${reviewed}`, ref: "context/tickets/10.2-other.md", title: "Other" });
    ok("10.2 push", await s.delivery.push("10.2", reviewed));
    ok("10.2 PR", await s.delivery.ensurePr("10.2"));
    return ok("10.2 inspect", await s.delivery.inspect("10.2"));
  };
  const pass: Check[] = [{ name: "ci", bucket: "pass", state: "SUCCESS", link: "" }];
  {
    // Two simultaneous merges of different tickets, from one Delivery.
    const s = await ready("m4-two-merges", pass);
    const i2 = await second(s);
    const [o1, o2] = await Promise.all([s.delivery.merge("10.1", approvalOf(s.i)), s.delivery.merge("10.2", approvalOf(i2))]);
    check("exactly one of two simultaneous merges runs", [o1, o2].filter((o) => o.ok).length === 1, [o1.ok, o2.ok]);
    refused("the other is blocked by the merge lock", o1.ok ? o2 : o1, "blocked", /merge into main is already running/);
    eq("one merge call", s.world.count("gh", "pr", "merge"), 1);
    const main1 = s.world.remote.get("refs/heads/main")!;
    eq("main moved by exactly one squash on the approved base", git(s.repo, "rev-parse", `${main1}^`), s.base);
    const loser = o1.ok ? "10.2" : "10.1";
    const loserApproval = o1.ok ? approvalOf(i2) : approvalOf(s.i);
    refused("retrying the other after the first landed: its approval is stale", await s.delivery.merge(loser, loserApproval), "stale", /base moved/);
    eq("still one merge call", s.world.count("gh", "pr", "merge"), 1);
    check("no lock left behind", !readdirSync(s.stateDir).some((f) => f.endsWith(".lock")), readdirSync(s.stateDir));
  }
  {
    // Two Delivery instances (as two kitchen processes would be) on the same ticket.
    const s = await ready("m4-two-instances", pass);
    const other = s.make();
    const [o1, o2] = await Promise.all([s.delivery.merge("10.1", approvalOf(s.i)), other.merge("10.1", approvalOf(s.i))]);
    check("exactly one instance merges", [o1, o2].filter((o) => o.ok).length === 1, [o1.ok, o2.ok]);
    refused("the other instance is blocked", o1.ok ? o2 : o1, "blocked", /another delivery step for 10\.1 is already running/);
    eq("two instances: one merge call", s.world.count("gh", "pr", "merge"), 1);
    const again = ok("the other instance retries: already merged, verified", await other.merge("10.1", approvalOf(s.i)));
    check("retry merged nothing", again.already && s.world.count("gh", "pr", "merge") === 1);
  }
  {
    // Another process holds the merge lock; a crashed holder's lock is reclaimed.
    const s = await ready("m4-held-lock", pass);
    const release = new DeliveryStore(s.stateDir).lock("merge", "a merge elsewhere");
    refused("merge waits for another process's merge", await s.delivery.merge("10.1", approvalOf(s.i)), "blocked", /already running/);
    eq("held lock: no merge", s.world.count("gh", "pr", "merge"), 0);
    release();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(s.stateDir, "merge.lock"), JSON.stringify({ pid: dead, token: "crashed", at: new Date(0).toISOString() }));
    writeFileSync(join(s.stateDir, "10.1.lock"), JSON.stringify({ pid: dead, token: "crashed", at: new Date(0).toISOString() }));
    ok("a crashed holder's locks are reclaimed", await s.delivery.merge("10.1", approvalOf(s.i)));
    check("locks released after the merge", !existsSync(join(s.stateDir, "merge.lock")) && !existsSync(join(s.stateDir, "10.1.lock")));
  }
  {
    // origin main moves between the re-check and the merge.
    const s = await ready("m4-ls-remote", pass);
    ok("approve", await s.delivery.approve("10.1", approvalOf(s.i)));
    s.write("docs.md", "raced\n");
    const raced = s.commit("someone merged at the last moment");
    s.world.beforeLsRemote = (ref) => {
      if (ref === "refs/heads/main") s.world.remote.set("refs/heads/main", raced);
    };
    refused("main moved just before the merge", await s.delivery.merge("10.1", approvalOf(s.i)), "stale", /origin main moved from .* to /);
    eq("last-moment move: no merge", s.world.count("gh", "pr", "merge"), 0);
    check("approval invalidated", s.delivery.read("10.1").approval === null && !!s.delivery.read("10.1").invalidated);
    const lsMain = s.world.calls.findIndex((c) => c.args[0] === "ls-remote" && c.args[2] === "refs/heads/main");
    check("ls-remote of main is the last git call before the (refused) merge", lsMain >= 0 && !s.world.calls.slice(lsMain + 1).some((c) => c.cmd === "gh" && c.args[1] === "merge"));
  }

  // ---- merged but unverified (M5)
  for (const tamper of ["tree", "parent"] as const) {
    const s = await ready(`m5-unverified-${tamper}`, pass);
    s.world.mergeTamper = tamper;
    const o = await s.delivery.merge("10.1", approvalOf(s.i));
    refused(`merged, wrong ${tamper}: reported merged but not verified`, o, "failed", /merged as [0-9a-f]{40} but NOT verified/);
    const m = s.world.remote.get("refs/heads/main")!;
    const st = s.delivery.read("10.1");
    check(`merged-unverified recorded (${tamper})`, st.merged?.commit === m && st.mergeCommit === m && st.verified === false && st.merged?.pr === s.world.prs[0].number, st);
    check(`the merge step is a failure (${tamper})`, st.steps.merge?.ok === false);
    refused(`retry does not merge again (${tamper})`, await s.delivery.merge("10.1", approvalOf(s.i)), "failed", /NOT verified/);
    refused(`verify still fails (${tamper})`, await s.delivery.verify("10.1"), "failed", /NOT verified/);
    eq(`one merge call (${tamper})`, s.world.count("gh", "pr", "merge"), 1);
    check(`still merged-unverified (${tamper})`, s.delivery.read("10.1").merged?.commit === m && !s.delivery.read("10.1").verified);
  }

  // ---- N1: a recorded merge keeps the approval it was made under, and its evidence
  const sameApproval = (x: Approval | undefined | null, y: Approval) => !!x && x.key === y.key && x.head === y.head && x.base === y.base && x.tree === y.tree;
  const fast = { confirmDelaysMs: [0, 0] };
  {
    // Repeated checks, before and after the merge; later approvals never change the record or merge again.
    const s = await ready("n1-repeated", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    for (let n = 1; n <= 3; n++) {
      ok(`n1: inspect before the merge (${n})`, await d.inspect("10.1"));
      refused(`n1: verify before the merge refuses (${n})`, await d.verify("10.1"), "refused");
    }
    ok("n1: approve", await d.approve("10.1", original));
    for (let n = 1; n <= 3; n++) refused(`n1: verify of an open PR (${n})`, await d.verify("10.1"), "refused", /OPEN, not merged/);
    check("n1: nothing recorded as merged before the merge", d.read("10.1").merged === null && d.read("10.1").pendingMerge === null);
    ok("n1: merge", await d.merge("10.1", original));
    const m = s.world.remote.get("refs/heads/main")!;
    const rec = d.read("10.1").merged!;
    check("n1: the merge record keeps the approval it was made under", sameApproval(rec.approval, original) && !!rec.approval.at && rec.approval.at === d.read("10.1").approval?.at, rec);
    check("n1: the merge record keeps its evidence", rec.commit === m && rec.pr === s.world.prs[0].number && rec.verification?.parent === s.base && rec.verification?.tree === s.i.tree && d.read("10.1").verified, rec);
    let after: Inspection | null = null;
    for (let n = 1; n <= 3; n++) {
      after = ok(`n1: inspect after the merge (${n})`, await d.inspect("10.1"));
      const st = d.read("10.1");
      check(`n1: inspect cleared only the permission, never the record (${n})`, st.approval === null && sameApproval(st.merged?.approval, original) && st.merged?.approval.at === rec.approval.at && st.merged?.verification !== null && st.verified, st);
      const v = ok(`n1: verify after inspect (${n})`, await d.verify("10.1"));
      eq(`n1: verified against the recorded approval (${n})`, [v.mergeCommit, v.parent, v.tree], [m, s.base, s.i.tree]);
    }
    eq("n1: inspection now sees the squash as the base", after!.base, m);
    ok("n1: a fresh approval after the merge is recorded", await d.approve("10.1", approvalOf(after!)));
    const others: [string, Approval][] = [
      ["the fresh approval", approvalOf(after!)],
      ["the original approval", original],
      ["a different-base approval", { ...original, base: m }],
    ];
    for (const [label, a] of others) {
      const again = ok(`n1: merge with ${label}`, await d.merge("10.1", a));
      check(`n1: ${label}: already merged, nothing merged again`, again.already && again.mergeCommit === m && s.world.count("gh", "pr", "merge") === 1);
      const st = d.read("10.1");
      check(`n1: ${label}: still verified, the record unchanged`, st.verified && sameApproval(st.merged?.approval, original) && st.merged?.approval.at === rec.approval.at && st.merged?.at === rec.at, st.merged);
      ok(`n1: verify after ${label}`, await d.verify("10.1"));
    }
    eq("n1: one merge performed", s.world.merges, 1);
    // Restart: a fresh store and Delivery read the same record back and verify against it.
    const fresh = s.make(fast);
    const back = fresh.read("10.1");
    check("n1 restart: the record and its approval survive", sameApproval(back.merged?.approval, original) && back.merged?.approval.at === rec.approval.at && back.merged?.commit === m && back.verified, back.merged);
    ok("n1 restart: verify", await fresh.verify("10.1"));
    check("n1 restart: merge is already merged", ok("n1 restart: merge", await fresh.merge("10.1", approvalOf(after!))).already);
    eq("n1 restart: still one merge call", s.world.count("gh", "pr", "merge"), 1);
  }
  {
    // A verification that fails is retried, and recovers, without any second merge.
    const s = await ready("n1-recovery", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    s.world.afterMerge = () => {
      s.world.fetchFails = 1;
    };
    refused("n1: merged, verification failed (network)", await d.merge("10.1", original), "failed", /merged as [0-9a-f]{40} but NOT verified/);
    s.world.afterMerge = null;
    const m = s.world.remote.get("refs/heads/main")!;
    const st = d.read("10.1");
    check("n1: merged-unverified, with its approval", st.merged?.commit === m && !st.verified && sameApproval(st.merged?.approval, original) && st.merged?.verification === null && st.pendingMerge === null, st);
    ok("n1: inspect after the merge", await d.inspect("10.1"));
    check("n1: inspect cleared the permission only", d.read("10.1").approval === null && sameApproval(d.read("10.1").merged?.approval, original));
    s.world.fetchFails = 1;
    refused("n1: verify fails again (network)", await d.verify("10.1"), "failed", /NOT verified/);
    refused("n1: merge retry fails the same way, without merging", await (async () => ((s.world.fetchFails = 1), d.merge("10.1", original)))(), "failed", /NOT verified/);
    check("n1: still merged-unverified", !d.read("10.1").verified && d.read("10.1").merged?.commit === m);
    const v = ok("n1: verify recovers against the recorded approval", await d.verify("10.1"));
    eq("n1: recovered verification", [v.mergeCommit, v.parent, v.tree], [m, s.base, s.i.tree]);
    check("n1: now verified", d.read("10.1").verified && d.read("10.1").merged?.verification?.parent === s.base);
    // A later re-check that fails never flips a verified merge back.
    s.world.fetchFails = 1;
    refused("n1: a failing re-check is reported", await d.verify("10.1"), "failed", /stays verified; this re-check failed/);
    check("n1: still verified after a failing re-check", d.read("10.1").verified && d.read("10.1").merged?.verification !== null);
    const other = { ...original, base: m, tree: git(s.repo, "rev-parse", `${m}^{tree}`) };
    ok("n1: merge with a different approval: already merged", await d.merge("10.1", other));
    check("n1: still verified, record unchanged, after a different approval", d.read("10.1").verified && sameApproval(d.read("10.1").merged?.approval, original));
    eq("n1 recovery: one merge call", s.world.count("gh", "pr", "merge"), 1);
    eq("n1 recovery: one merge performed", s.world.merges, 1);
  }

  // ---- N2: a merge GitHub has not confirmed is pending or unknown, never "not merged"
  {
    // The command succeeds; GitHub reports OPEN, then cannot be read, then MERGED.
    const s = await ready("n2-open-lag", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    s.world.viewLag = ["open", "open", "open"];
    const o = await d.merge("10.1", original);
    refused("n2: an unconfirmed merge is confirmation pending", o, "blocked", /succeeded, but GitHub does not report it merged yet: confirmation pending/);
    check("n2: never reported as not merged", !o.ok && !/not merged/i.test(o.message), o);
    const st = d.read("10.1");
    check("n2: pending recorded with its approval", st.merged === null && st.pendingMerge?.status === "confirmation-pending" && sameApproval(st.pendingMerge.approval, original) && st.pendingMerge.pr === s.world.prs[0].number, st.pendingMerge);
    check("n2: the merge step is not recorded as not merged", !/not merged/i.test(st.steps.merge?.message ?? "x not merged"));
    s.world.viewLag = ["open"];
    const before = s.world.calls.length;
    refused("n2: a retry while GitHub still lags stays pending", await d.merge("10.1", original), "blocked", /still unknown: .*already has [0-9a-f]{40} with the approved head or tree/);
    check("n2: the retry read origin main to reconcile", s.world.calls.slice(before).some((c) => c.args[0] === "ls-remote" && c.args[2] === "refs/heads/main"));
    eq("n2: the retry merged nothing", s.world.count("gh", "pr", "merge"), 1);
    s.world.viewLag = ["fail"];
    refused("n2: verify while GitHub cannot be read stays unknown", await d.verify("10.1"), "blocked", /still unknown: GitHub could not be read/);
    check("n2: still pending", d.read("10.1").pendingMerge !== null && d.read("10.1").merged === null);
    // Restart, then GitHub catches up.
    const fresh = s.make(fast);
    check("n2 restart: the pending record survives", fresh.read("10.1").pendingMerge?.status === "confirmation-pending");
    const v = ok("n2: verify once GitHub reports MERGED", await fresh.verify("10.1"));
    const done = fresh.read("10.1");
    check("n2: settled as merged and verified, under the original approval", done.pendingMerge === null && done.verified && sameApproval(done.merged?.approval, original) && done.merged?.commit === v.mergeCommit, done);
    check("n2: merge after settling is already merged", ok("n2: merge after settling", await fresh.merge("10.1", original)).already);
    eq("n2: one merge call in all", s.world.count("gh", "pr", "merge"), 1);
  }
  {
    // The command succeeds; every re-read fails. A later retry with another approval settles it first.
    const s = await ready("n2-read-fails", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    s.world.viewLag = ["fail", "fail", "fail"];
    refused("n2: re-reads fail after a successful merge: confirmation pending", await d.merge("10.1", original), "blocked", /confirmation pending/);
    check("n2: pending, not 'not merged'", d.read("10.1").pendingMerge?.status === "confirmation-pending" && d.read("10.1").merged === null);
    const m = s.world.remote.get("refs/heads/main")!;
    const again = ok("n2: a retry with another approval settles as merged", await d.merge("10.1", { ...original, base: m }));
    check("n2: the settled retry merged nothing", again.already && again.mergeCommit === m && s.world.count("gh", "pr", "merge") === 1);
    check("n2: recorded and verified under the original approval", sameApproval(d.read("10.1").merged?.approval, original) && d.read("10.1").verified);
  }
  {
    // The command fails after GitHub merged (reported badly).
    const s = await ready("n2-reported-badly", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    s.world.mergeReport = result("", 1, "HTTP 504: Gateway Timeout");
    ok("n2: a badly reported merge GitHub confirms is verified", await d.merge("10.1", original));
    check("n2: and recorded", sameApproval(d.read("10.1").merged?.approval, original) && d.read("10.1").verified && d.read("10.1").pendingMerge === null);
    const t = await ready("n2-reported-badly-lag", pass);
    const e = t.make(fast);
    t.world.mergeReport = result("", 1, "HTTP 504: Gateway Timeout");
    t.world.viewLag = ["open", "open"];
    const o = await e.merge("10.1", approvalOf(t.i));
    refused("n2: failed command, GitHub lagging: outcome unknown", o, "failed", /Gateway Timeout; whether PR #\d+ merged is unknown/);
    check("n2: recorded as pending, never not merged", e.read("10.1").pendingMerge !== null && e.read("10.1").merged === null && !o.ok && !/not merged/i.test(o.message), e.read("10.1").pendingMerge);
    t.world.mergeReport = null;
    const again = ok("n2: the retry settles as merged once GitHub reports it", await e.merge("10.1", approvalOf(t.i)));
    check("n2: no second merge after a badly reported one", again.already && t.world.count("gh", "pr", "merge") === 1 && t.world.merges === 1);
  }
  {
    // The command is refused and origin main has not moved: settled as not merged, and the retry merges once.
    const s = await ready("n2-refused", pass);
    const d = s.make(fast);
    s.world.mergeRefuse = result("", 1, "GraphQL: Pull request is not mergeable (mergePullRequest)");
    const o = await d.merge("10.1", approvalOf(s.i));
    check("n2: a refused merge with main unmoved is settled as not merged", !o.ok && /not mergeable/.test(o.message) && !/unknown/.test(o.message) && d.read("10.1").pendingMerge === null && d.read("10.1").merged === null, o);
    s.world.mergeRefuse = null;
    ok("n2: the retry merges", await d.merge("10.1", approvalOf(s.i)));
    eq("n2: exactly one merge performed", s.world.merges, 1);
  }
  for (const merged of [true, false]) {
    // The kitchen stopped right after sending the command: only the write-ahead record exists.
    const s = await ready(`n2-interrupted-${merged ? "merged" : "not-merged"}`, pass);
    const original = approvalOf(s.i);
    const n = s.world.prs[0].number;
    const at = new Date().toISOString();
    new DeliveryStore(s.stateDir).update("10.1", (st) => {
      st.approval = { ...original, at };
      st.pendingMerge = { at, pr: n, approval: { ...original, at }, status: "sent", note: "the merge command was sent" };
    });
    if (merged) await s.world.runner("gh", ["pr", "merge", String(n), "-R", "owner/project", "--squash", "--match-head-commit", s.head, "--subject", "interrupted"]);
    const calls = s.world.count("gh", "pr", "merge");
    const fresh = s.make(fast);
    if (merged) {
      s.world.viewLag = ["open"];
      refused("n2 restart: an interrupted merge is settled before anything else", await fresh.merge("10.1", original), "blocked", /still unknown/);
      ok("n2 restart: verify settles it as merged", await fresh.verify("10.1"));
      check("n2 restart: recorded under the pending approval", sameApproval(fresh.read("10.1").merged?.approval, original) && fresh.read("10.1").merged?.approval.at === at && fresh.read("10.1").verified);
      eq("n2 restart: no merge call after the interrupted one", s.world.count("gh", "pr", "merge"), calls);
    } else {
      // F1: an interrupted command is unknown; it is settled as not merged only after the settle delay.
      refused("n2 restart: an interrupted merge that did not land stays unknown within the settle delay", await fresh.merge("10.1", original), "blocked", /still unknown: .*settled only once 300 s, longer than the merge timeout, have passed/);
      check("n2 restart: still unknown, approval kept", mergeOutcome(fresh.read("10.1")) === "unknown" && sameApproval(fresh.read("10.1").pendingMerge?.approval, original) && s.world.merges === 0);
      const later = s.make({ ...fast, now: () => new Date(Date.now() + 10 * 60_000) });
      ok("n2 restart: an interrupted merge that did not land is settled, then merged once", await later.merge("10.1", original));
      eq("n2 restart: one merge performed", s.world.merges, 1);
    }
  }

  // ---- F1–F3 (review 3): pending, unknown, confirmed merged and confirmed not merged are kept apart
  /** Lands the PR's squash on the simulated GitHub as if done outside the app (or by GitHub, late); not counted as an app call. */
  const landOutside = async (s: Awaited<ReturnType<typeof ready>>) => {
    await s.world.runner("gh", ["pr", "merge", String(s.world.prs[0].number), "-R", "owner/project", "--squash", "--match-head-commit", s.head, "--subject", "landed outside the app"]);
    s.world.calls.pop();
  };
  const appMerges = (s: Awaited<ReturnType<typeof ready>>) => s.world.count("gh", "pr", "merge");
  const SETTLE = 5 * MERGE_TIMEOUT_MS;
  {
    // The classifier: only GitHub's explicit refusal (or a refused sign-in) is a clear refusal.
    const clear = [
      "merging the pull request: GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)",
      "merging the pull request: X Pull request #7 is not mergeable: the merge commit cannot be cleanly created.",
      'merging the pull request: GraphQL: Required status check "ci" is expected. (mergePullRequest)',
      "merging the pull request: GraphQL: Repository rule violations found",
    ];
    for (const m of clear) check(`f1: clear refusal: ${m.slice(26, 70)}`, isClearMergeRefusal(new DeliveryError("failed", m)));
    check("f1: a refused sign-in is a clear refusal", isClearMergeRefusal(new DeliveryError("auth", "merging the pull request: GitHub sign-in is missing or expired")));
    const unclear = [
      "merging the pull request: HTTP 502: Bad Gateway (https://api.github.com/graphql)",
      "merging the pull request: Command failed: gh (killed: SIGTERM)",
      "merging the pull request: error connecting to api.github.com",
      "merging the pull request: gh failed",
      "merging the pull request: HTTP 503: is not mergeable",
      "merging the pull request: GitHub API rate limit reached; try again later",
      "merging the pull request: something unrecognized",
    ];
    for (const m of unclear) check(`f1: unclear, never a refusal: ${m.slice(26, 70)}`, !isClearMergeRefusal(new DeliveryError(/rate limit/.test(m) ? "blocked" : "failed", m)));
    let threw = false;
    try {
      new Delivery({ root: "/x", repo: "owner/project", store: new DeliveryStore(join(tmp, "f1-cfg")), settleAfterMs: MERGE_TIMEOUT_MS });
    } catch {
      threw = true;
    }
    check("f1: a settle delay not longer than the merge timeout is refused", threw);
  }
  const unclearFailures: [string, RunResult][] = [
    ["timeout", result("", 1, "Command failed: gh pr merge 100 -R owner/project --squash (timed out after 60000 ms)")],
    ["kill", result("", 137, "")],
    ["5xx", result("", 1, "HTTP 502: Bad Gateway (https://api.github.com/graphql)")],
    ["network", result("", 1, 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host')],
  ];
  for (const [name, failure] of unclearFailures) {
    // An unclear failure stays unknown, with its approval, and GitHub completes the merge later.
    const s = await ready(`f1-late-${name}`, pass);
    let t = Date.now();
    const d = s.make({ ...fast, now: () => new Date(t) });
    const original = approvalOf(s.i);
    const approved = ok(`f1 ${name}: approve`, await d.approve("10.1", original));
    s.world.mergeRefuse = failure;
    const o = await d.merge("10.1", original);
    refused(`f1 ${name}: an unclear failure is unknown`, o, "failed", /whether PR #\d+ merged is unknown/);
    check(`f1 ${name}: never reported as not merged`, !o.ok && !/not merged/i.test(o.message), o);
    let st = d.read("10.1");
    check(
      `f1 ${name}: outcome unknown, pending approval and its time kept`,
      mergeOutcome(st) === "unknown" && st.pendingMerge?.status === "unknown" && sameApproval(st.pendingMerge.approval, original) && st.pendingMerge.approval.at === approved.at && sameApproval(st.approval, original),
      st,
    );
    s.world.mergeRefuse = null;
    refused(`f1 ${name}: a retry within the settle delay is held`, await d.merge("10.1", original), "blocked", /still unknown: .*failure was unclear/);
    eq(`f1 ${name}: the retry sent no merge`, appMerges(s), 1);
    t += 2 * 60_000;
    await landOutside(s); // GitHub completes the timed-out request late
    // Restart: a fresh Delivery and store.
    const fresh = s.make({ ...fast, now: () => new Date(t) });
    check(`f1 ${name}: restart keeps the unknown outcome`, mergeOutcome(fresh.read("10.1")) === "unknown");
    const v = ok(`f1 ${name}: verify after the late landing`, await fresh.verify("10.1"));
    st = fresh.read("10.1");
    check(
      `f1 ${name}: confirmed merged, verified, under the original approval`,
      mergeOutcome(st) === "merged" && st.verified && st.pendingMerge === null && sameApproval(st.merged?.approval, original) && st.merged?.approval?.at === approved.at && st.merged?.commit === v.mergeCommit,
      st,
    );
    check(`f1 ${name}: merge again is already merged`, ok(`f1 ${name}: merge again`, await fresh.merge("10.1", original)).already);
    const i2 = ok(`f1 ${name}: inspect after the merge`, await fresh.inspect("10.1"));
    ok(`f1 ${name}: approve the post-merge base`, await fresh.approve("10.1", approvalOf(i2)));
    check(`f1 ${name}: the post-merge approval merges nothing`, ok(`f1 ${name}: merge post-merge`, await fresh.merge("10.1", approvalOf(i2))).already);
    check(`f1 ${name}: the record keeps the original approval`, sameApproval(fresh.read("10.1").merged?.approval, original) && fresh.read("10.1").merged?.approval?.at === approved.at && fresh.read("10.1").verified);
    eq(`f1 ${name}: exactly one merge`, [s.world.merges, appMerges(s)], [1, 1]);
  }
  {
    // An unclear failure that never lands: settled as not merged only after the settle delay; the retry merges once.
    const s = await ready("f1-settle", pass);
    let t = Date.now();
    const d = s.make({ ...fast, now: () => new Date(t) });
    const original = approvalOf(s.i);
    const approved = ok("f1 settle: approve", await d.approve("10.1", original));
    s.world.mergeRefuse = unclearFailures[0][1];
    refused("f1 settle: unclear failure", await d.merge("10.1", original), "failed", /unknown/);
    s.world.mergeRefuse = null;
    t += MERGE_TIMEOUT_MS + 1000;
    refused("f1 settle: still unknown after only the merge timeout", await d.verify("10.1"), "blocked", /still unknown/);
    check("f1 settle: still unknown", mergeOutcome(d.read("10.1")) === "unknown");
    t += SETTLE;
    refused("f1 settle: after the settle delay, verify confirms not merged", await d.verify("10.1"), "refused", /confirmed not merged: .*longer than the merge timeout/);
    let st = d.read("10.1");
    check(
      "f1 settle: confirmed not merged, the attempt and its approval kept",
      mergeOutcome(st) === "not-merged" && st.pendingMerge === null && sameApproval(st.lastAttempt?.approval, original) && st.lastAttempt?.approval.at === approved.at && sameApproval(st.approval, original),
      st,
    );
    ok("f1 settle: the retry merges", await d.merge("10.1", original));
    st = d.read("10.1");
    check("f1 settle: merged under the original approval", sameApproval(st.merged?.approval, original) && st.merged?.approval?.at === approved.at && st.verified);
    eq("f1 settle: exactly one merge, two commands", [s.world.merges, appMerges(s)], [1, 2]);
  }
  {
    // Settled as not merged, then the merge lands even later: the original approval still verifies it.
    const s = await ready("f1-later-still", pass);
    let t = Date.now();
    const d = s.make({ ...fast, now: () => new Date(t) });
    const original = approvalOf(s.i);
    const approved = ok("f1 later: approve", await d.approve("10.1", original));
    s.world.mergeRefuse = unclearFailures[2][1];
    refused("f1 later: unclear failure", await d.merge("10.1", original), "failed", /unknown/);
    s.world.mergeRefuse = null;
    t += SETTLE + 1000;
    refused("f1 later: settled not merged", await d.verify("10.1"), "refused", /not merged/);
    await landOutside(s);
    const i2 = ok("f1 later: re-inspect", await d.inspect("10.1"));
    ok("f1 later: re-approve the post-merge base", await d.approve("10.1", approvalOf(i2)));
    const fresh = s.make({ ...fast, now: () => new Date(t) });
    ok("f1 later: verify after a restart", await fresh.verify("10.1"));
    const st = fresh.read("10.1");
    check("f1 later: bound to the original approval, never the post-merge one", mergeOutcome(st) === "merged" && st.verified && sameApproval(st.merged?.approval, original) && st.merged?.approval?.at === approved.at, st.merged);
    check("f1 later: merge with the post-merge approval is already merged", ok("f1 later: merge", await fresh.merge("10.1", approvalOf(i2))).already);
    eq("f1 later: exactly one merge", [s.world.merges, appMerges(s)], [1, 1]);
  }
  {
    // A clear refusal is confirmed not merged at once, with positive evidence.
    const s = await ready("f1-refusal", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    s.world.mergeRefuse = result("", 1, "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)");
    const o = await d.merge("10.1", original);
    check("f1 refusal: reported as GitHub's refusal, not unknown", !o.ok && /Base branch was modified/.test(o.message) && !/unknown/.test(o.message), o);
    const st = d.read("10.1");
    check("f1 refusal: confirmed not merged, with the refusal as evidence", mergeOutcome(st) === "not-merged" && /GitHub refused the merge command/.test(st.lastAttempt?.reason ?? "") && sameApproval(st.lastAttempt?.approval, original), st);
    s.world.mergeRefuse = null;
    ok("f1 refusal: the retry merges", await d.merge("10.1", original));
    eq("f1 refusal: exactly one merge", s.world.merges, 1);
  }
  {
    // Delayed GitHub responses: every gh call is slow and the PR reads lag behind the merge.
    const s = await ready("f1-delayed", pass);
    let t = Date.now();
    const slow: Runner = async (cmd, args, opts) => {
      if (cmd === "gh") await new Promise((r) => setTimeout(r, 15));
      return s.world.runner(cmd, args, opts);
    };
    const d = s.make({ ...fast, runner: slow, now: () => new Date(t) });
    const original = approvalOf(s.i);
    const approved = ok("f1 delayed: approve", await d.approve("10.1", original));
    s.world.viewLag = ["open", "fail", "open", "fail"];
    refused("f1 delayed: confirmation pending", await d.merge("10.1", original), "blocked", /confirmation pending/);
    check("f1 delayed: outcome pending", mergeOutcome(d.read("10.1")) === "pending");
    t += 24 * 3600_000;
    const fresh = s.make({ ...fast, runner: slow, now: () => new Date(t) });
    refused("f1 delayed: still lagging a day later, after a restart: held", await fresh.merge("10.1", { ...original, base: s.world.remote.get("refs/heads/main")! }), "blocked", /pending .*still unknown/);
    check("f1 delayed: still pending, never not merged", mergeOutcome(fresh.read("10.1")) === "pending" && sameApproval(fresh.read("10.1").pendingMerge?.approval, original));
    ok("f1 delayed: verify once GitHub answers", await fresh.verify("10.1"));
    const st = fresh.read("10.1");
    check("f1 delayed: merged under the original approval", sameApproval(st.merged?.approval, original) && st.merged?.approval?.at === approved.at && st.verified);
    eq("f1 delayed: exactly one merge", [s.world.merges, appMerges(s)], [1, 1]);
  }
  for (const end of ["lands", "closed"] as const) {
    // F3: the command exits 0 but merges nothing yet (queued or async). Pending is never settled by time.
    const s = await ready(`f3-queued-${end}`, pass);
    let t = Date.now();
    let queued = false;
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "merge" && !queued) {
        queued = true;
        s.world.calls.push({ cmd, args: [...args] });
        return result("queued\n");
      }
      return s.world.runner(cmd, args, opts);
    };
    const d = s.make({ ...fast, runner, now: () => new Date(t) });
    const original = approvalOf(s.i);
    const approved = ok(`f3 ${end}: approve`, await d.approve("10.1", original));
    refused(`f3 ${end}: exit 0 without a merge is pending`, await d.merge("10.1", original), "blocked", /confirmation pending/);
    t += 7 * 24 * 3600_000;
    refused(`f3 ${end}: verify a week later stays pending`, await d.verify("10.1"), "blocked", /pending .*can still land/);
    refused(`f3 ${end}: a retry stays pending`, await d.merge("10.1", original), "blocked", /pending/);
    const fresh = s.make({ ...fast, runner, now: () => new Date(t) });
    let st = fresh.read("10.1");
    check(
      `f3 ${end}: pending survives a restart with its approval, never settled as not merged`,
      mergeOutcome(st) === "pending" && st.lastAttempt === null && sameApproval(st.pendingMerge?.approval, original) && st.pendingMerge?.approval.at === approved.at,
      st,
    );
    if (end === "lands") {
      await landOutside(s);
      ok(`f3 ${end}: verify once it lands`, await fresh.verify("10.1"));
      st = fresh.read("10.1");
      check(`f3 ${end}: merged under the original approval`, mergeOutcome(st) === "merged" && sameApproval(st.merged?.approval, original) && st.merged?.approval?.at === approved.at && st.verified);
      eq(`f3 ${end}: exactly one merge`, [s.world.merges, appMerges(s)], [1, 1]);
    } else {
      s.world.prs[0].state = "CLOSED";
      refused(`f3 ${end}: a closed PR confirms not merged`, await fresh.verify("10.1"), "refused", /closed without merging/);
      check(`f3 ${end}: confirmed not merged, attempt kept`, mergeOutcome(fresh.read("10.1")) === "not-merged" && sameApproval(fresh.read("10.1").lastAttempt?.approval, original));
      eq(`f3 ${end}: nothing merged`, [s.world.merges, appMerges(s)], [0, 1]);
    }
  }
  {
    // F2: merged outside the app. Wrong and post-merge approvals first, then the correct one.
    const s = await ready("f2-outside", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    await landOutside(s);
    const wrong = { ...original, tree: "0".repeat(40) };
    refused("f2: merge with a wrong approval: merged, NOT verified", await d.merge("10.1", wrong), "failed", /NOT verified/);
    let st = d.read("10.1");
    check("f2: recorded merged-unverified with no bound approval", mergeOutcome(st) === "merged" && st.merged?.approval === null && !st.verified && st.merged?.commit === s.world.remote.get("refs/heads/main"), st.merged);
    const i2 = ok("f2: inspect after the outside merge", await d.inspect("10.1"));
    const post = approvalOf(i2);
    ok("f2: approve the post-merge base", await d.approve("10.1", post));
    refused("f2: verify with the post-merge approval: NOT verified", await d.verify("10.1"), "failed", /NOT verified/);
    refused("f2: merge with the post-merge approval: NOT verified", await d.merge("10.1", post), "failed", /NOT verified/);
    check("f2: still no bound approval", d.read("10.1").merged?.approval === null && !d.read("10.1").verified);
    const fresh = s.make(fast);
    check("f2 restart: still merged-unverified, unbound", fresh.read("10.1").merged?.approval === null);
    check("f2: the correct approval verifies it", ok("f2: merge with the correct approval", await fresh.merge("10.1", original)).already);
    st = fresh.read("10.1");
    check("f2: bound to the correct approval and verified", sameApproval(st.merged?.approval, original) && st.verified && st.merged?.verification?.parent === s.base);
    ok("f2: verify keeps it", await fresh.verify("10.1"));
    ok("f2: a wrong approval later changes nothing", await fresh.merge("10.1", wrong));
    check("f2: binding unchanged", sameApproval(fresh.read("10.1").merged?.approval, original) && fresh.read("10.1").verified);
    eq("f2: exactly one merge, none by the app", [s.world.merges, appMerges(s)], [1, 0]);
  }
  {
    // F2: the human approved, then it merged outside the app; re-inspection invalidates the approval, which still verifies it.
    const s = await ready("f2-approved", pass);
    const d = s.make(fast);
    const original = approvalOf(s.i);
    const approved = ok("f2 approved: approve", await d.approve("10.1", original));
    await landOutside(s);
    ok("f2 approved: inspect", await d.inspect("10.1"));
    check("f2 approved: the approval is invalidated", d.read("10.1").approval === null && sameApproval(d.read("10.1").invalidated?.approval, original));
    ok("f2 approved: verify binds the human's original approval", await d.verify("10.1"));
    check("f2 approved: bound with its time", sameApproval(d.read("10.1").merged?.approval, original) && d.read("10.1").merged?.approval?.at === approved.at && d.read("10.1").verified);
    eq("f2 approved: exactly one merge", [s.world.merges, appMerges(s)], [1, 0]);
  }

  // ---- state file: permissions, unique temp files, corrupt state (L5)
  {
    const s = scenario("l5-perms");
    mkdirSync(s.stateDir, { recursive: true, mode: 0o755 });
    chmodSync(s.stateDir, 0o755);
    ok("inspect with a wide existing folder", await s.delivery.inspect("10.1"));
    eq("deliveries folder tightened to 0700", statSync(s.stateDir).mode & 0o777, 0o700);
    eq("state file is 0600", statSync(join(s.stateDir, "10.1.json")).mode & 0o777, 0o600);
    eq("no temp or lock files left", readdirSync(s.stateDir), ["10.1.json"]);
    const release = new DeliveryStore(s.stateDir).lock("10.1", "probe");
    eq("lock file is 0600", statSync(join(s.stateDir, "10.1.lock")).mode & 0o777, 0o600);
    release();

    writeFileSync(join(s.stateDir, "10.1.json"), "{ not json");
    const before = s.world.calls.length;
    const o = await s.delivery.push("10.1", s.head);
    refused("corrupt state returns an Outcome", o, "failed", /unreadable/);
    check("corrupt state: nothing ran", s.world.calls.length === before && s.world.count("git", "push") === 0);
    eq("corrupt state left as it was", readFileSync(join(s.stateDir, "10.1.json"), "utf8"), "{ not json");
    check("corrupt state: no lock left", !existsSync(join(s.stateDir, "10.1.lock")));
  }

  // ---- the real runner never prompts (L2)
  {
    const saved = { cmd: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH, prompt: process.env.GIT_TERMINAL_PROMPT };
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    delete process.env.GIT_TERMINAL_PROMPT;
    const r = await defaultRunner("git", ["-c", 'alias.envprobe=!printf "%s|%s|%s|%s" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" "$GIT_SSH_COMMAND" "$GH_PROMPT_DISABLED"', "envprobe"], { cwd: tmp });
    eq("git runs without prompts", r.stdout, "0|never|ssh -o BatchMode=yes|1");
    Object.assign(process.env, { GIT_TERMINAL_PROMPT: saved.prompt ?? "0" });
    if (saved.cmd !== undefined) process.env.GIT_SSH_COMMAND = saved.cmd;
    if (saved.ssh !== undefined) process.env.GIT_SSH = saved.ssh;
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
  // The real (abbreviated) denylist, as configured: each must resolve to exactly one commit here.
  const denylist = R.denylist.filter((c) => {
    try {
      git(repo, "rev-parse", "--verify", `${c}^{commit}`);
      return true;
    } catch {
      return false;
    }
  });
  eq("replay denylist resolves in this clone", denylist, R.denylist);

  const world = new World(repo);
  world.originUrl = "https://github.com/rikilamadrid/tin-and-thyme.git";
  world.owner = "rikilamadrid";
  world.remote.set("refs/heads/main", R.base);
  // The claims' real Last lines.
  world.claims.set("05.1", {
    branch: R.b51,
    worktree: ".pathfinder/worktrees/05.1",
    state: "done",
    last: `review PASS on ${R.r51}`,
    ref: "context/tickets/05.1-adopt-and-repair-run-policy.md",
    title: "Adopt and repair the run policy draft",
  });
  world.claims.set("05.2", {
    branch: R.b52,
    worktree: ".pathfinder/worktrees/05.2",
    state: "done",
    last: `review PASS on ${R.r52}`,
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
