// The simulated world for the delivery tests (scripts/delivery-test.ts and
// scripts/delivery-ui-test.ts), moved here unchanged from delivery-test.ts so both
// use the same fake runner.
//
// Local git is real: each scenario builds a throwaway repository and the fake
// runner passes read-only/local git commands through to it. Everything that would
// touch the network or GitHub (fetch, ls-remote, push, every `gh` call) and the
// orchestrate engine's claim are simulated in memory. Nothing is ever pushed.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run, type RunResult } from "../server/lib/exec";
import type { Check, Program, Runner } from "../server/delivery/forge";
import { assertSafePushArgs, Delivery } from "../server/delivery/ops";
import { DeliveryStore } from "../server/delivery/state";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const result = (stdout: string, code = 0, stderr = ""): RunResult => ({ ok: code === 0, code, stdout, stderr });

// ---------------------------------------------------------------- the simulated world

export interface FakePr {
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

export interface FakeClaim {
  branch: string;
  worktree: string;
  state: string;
  last: string;
  ref: string | null;
  title: string;
  orphan?: boolean;
}

export class World {
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
  /** A `gh` PR subcommand answered by a real process instead (a fake CLI run through `run`, e.g. one killed by its timeout). */
  ghVia: Partial<Record<string, (args: string[]) => Promise<RunResult>>> = {};

  constructor(readonly repo: string) {}

  /** Real local git, for commands that neither touch the network nor move a ref. */
  private static PASS = new Set(["rev-parse", "merge-base", "cat-file", "diff", "merge-tree", "rev-list", "log", "for-each-ref"]);

  readonly runner: Runner = async (cmd, args, opts = {}) => {
    this.calls.push({ cmd, args: [...args] });
    if (cmd === "node") return this.engine(args);
    const via = cmd === "gh" && args[0] === "pr" ? this.ghVia[args[1]] : undefined;
    if (via) return via(args);
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

  /** The store as the engine's `board --json` reads it; a claimed ticket not listed here is In Progress with no blockers. */
  tickets = new Map<string, { status: string; blockers: string[]; title?: string }>();

  private engine(args: string[]): RunResult {
    if (args[1] === "board") {
      const keys = new Set([...this.tickets.keys(), ...this.claims.keys()]);
      const tickets = [...keys].map((key) => {
        const t = this.tickets.get(key) ?? { status: "In Progress", blockers: [] };
        return { key, title: t.title ?? this.claims.get(key)?.title ?? key, status: t.status, blockers: t.blockers };
      });
      return result(JSON.stringify({ store: "fake", tickets }));
    }
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
export function makeScenario(tmp: string, name: string) {
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
  // The claim ref records the commit the claim started from, as the engine's claim does.
  git(repo, "update-ref", "refs/pathfinder/claims/10.1", base);

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
