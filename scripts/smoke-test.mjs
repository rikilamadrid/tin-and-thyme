// Installs a packed tin-and-thyme tarball into an empty folder like a new user would,
// then drives the installed `tin-and-thyme` executable against a throwaway Pathfinder-shaped
// repository:
//
//   - --version and --help answer with the product's identity;
//   - the terminal library loads its prebuilt binary and can spawn (it differs by OS);
//   - `open --no-browser` starts a kitchen, the built UI is served, the board loads, and no
//     orchestration starts;
//   - opening again (from the repository, without a path) reuses the same kitchen, and `url`
//     prints the same URL;
//   - a repository without the Pathfinder kit gets the missing-kit message;
//   - every image the packed README references is inside the package (pinned to this version's
//     jsDelivr URL by prepack, or still repository-relative when packed with --ignore-scripts).
//
// Kitchen state goes to a temporary HOME, never the real one. The repository's engine is a
// stub that answers `status --json` with two tickets: this test checks Tin & Thyme, not Pathfinder.
//
//   node scripts/smoke-test.mjs <path/to/tin-and-thyme-x.y.z.tgz>

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cdnPrefix, isRelative, readmeImages } from "./readme-images.mjs";

const tarball = resolve(process.argv[2] ?? "");
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "tin-and-thyme-smoke-"));
const app = join(work, "app");
const home = join(work, "home"); // the kitchens' state lives here for this test
const repo = join(work, "smoke-kitchen");
const bare = join(work, "no-kit");
const kitchenPids = new Set();

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "pipe", shell: win, encoding: "utf8" });
const step = (msg) => console.log(`• ${msg}`);
function fail(msg) {
  console.error(`✗ ${msg}`);
  cleanup();
  process.exit(1);
}
function cleanup() {
  // Stop only the kitchens this test started (their pids are in the test HOME's records).
  try {
    for (const f of readdirSync(join(home, ".controlroom", "kitchens")).filter((x) => x.endsWith(".json"))) {
      kitchenPids.add(JSON.parse(readFileSync(join(home, ".controlroom", "kitchens", f), "utf8")).pid);
    }
  } catch {
    /* none started */
  }
  for (const pid of kitchenPids) {
    try {
      if (win) execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a file; the runner is thrown away anyway */
  }
}

// 1. Install the tarball into an empty folder.
step(`installing ${tarball}`);
mkdirSync(app);
writeFileSync(join(app, "package.json"), '{ "name": "smoke", "private": true }\n');
try {
  sh("npm", ["install", "--no-audit", "--no-fund", tarball], app);
} catch (e) {
  fail(`npm install failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
}
const pkgRoot = join(app, "node_modules", "tin-and-thyme");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
// The executable npm linked from "bin" (a .cmd shim on Windows, so run the entry with node there).
const exe = win ? [process.execPath, join(pkgRoot, "bin", "tin-and-thyme.mjs")] : [join(app, "node_modules", ".bin", "tin-and-thyme")];
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.HQ_REPO;
delete env.HQ_PORT;
const tt = (args, cwd = work) => {
  const r = spawnSync(exe[0], [...exe.slice(1), ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
mkdirSync(home);

// 2. Identity.
const version = tt(["--version"]);
if (version.code !== 0 || version.out.trim() !== pkg.version) fail(`--version printed ${JSON.stringify(version.out)} (exit ${version.code}), expected ${pkg.version}`);
const help = tt(["--help"]);
if (help.code !== 0 || !help.out.startsWith(`Tin & Thyme ${pkg.version}`) || !help.out.includes("tin-and-thyme open [path]") || !help.out.trim().endsWith("a Wonder Wagon tool")) fail(`--help:\n${help.out}`);
step(`tin-and-thyme ${pkg.version}: --version and --help`);

// 2b. The packed README's images all ship in the package.
{
  const prefix = cdnPrefix(pkg);
  const images = readmeImages(readFileSync(join(pkgRoot, "README.md"), "utf8"));
  if (!images.length) fail("the packed README references no images");
  const pinned = images.filter((src) => src.startsWith(prefix)).length;
  for (const src of images) {
    if (!src.startsWith(prefix) && !isRelative(src)) fail(`packed README image ${src} is neither pinned to ${prefix} nor relative`);
    const file = src.startsWith(prefix) ? src.slice(prefix.length) : src.replace(/^\.\//, "");
    if (!existsSync(join(pkgRoot, file))) fail(`packed README image ${file} is not in the package`);
  }
  if (pinned && pinned !== images.length) fail(`packed README pins ${pinned} of ${images.length} images`);
  step(`README: ${images.length} images in the package, ${pinned ? `pinned to ${prefix}` : "repository-relative (packed without prepack)"}`);
}

// 3. The terminal library loads its prebuilt binary and can spawn a process.
const req = createRequire(join(pkgRoot, "package.json"));
const pty = req("@lydell/node-pty");
await new Promise((done) => {
  const p = pty.spawn(process.execPath, ["-e", "console.log('pty-ok')"], { cols: 80, rows: 10 });
  let out = "";
  p.onData((d) => (out += d));
  p.onExit(() => (out.includes("pty-ok") ? done() : fail(`pty spawn printed: ${JSON.stringify(out)}`)));
  setTimeout(() => fail("pty spawn timed out"), 15_000);
});
step("terminal library spawns processes");

// 4. A throwaway Pathfinder-shaped repository (stub engine) and one without the kit.
const commit = (dir) => {
  sh("git", ["init", "-q", "-b", "main"], dir);
  sh("git", ["add", "."], dir);
  sh("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "commit", "-qm", "init"], dir);
};
mkdirSync(join(repo, "context"), { recursive: true });
mkdirSync(join(repo, "roles"));
mkdirSync(join(repo, "skills", "orchestrate", "engine", "bin"), { recursive: true });
writeFileSync(join(repo, "context", "execution-mode.md"), "# Execution Mode\n\n<!-- pathfinder:execution-mode orchestrator -->\n");
writeFileSync(join(repo, "roles", "developer.md"), "---\nname: developer\ndescription: Implements one ticket (smoke test)\n---\n");
const rows = [
  { worker: "—", key: "1.1", lifecycle: "Ready", state: "ready", where: "—", gate: "—", last: "—", title: "Smoke ticket one" },
  { worker: "—", key: "1.2", lifecycle: "Complete", state: "integrated", where: "—", gate: "—", last: "—", title: "Smoke ticket two" },
];
writeFileSync(
  join(repo, "skills", "orchestrate", "engine", "bin", "orchestrate.mjs"),
  `// Smoke-test stub, not Pathfinder: answers \`status --json\` only.\nconsole.log(JSON.stringify({ ok: true, mode: "orchestrator", store: "smoke stub", rows: ${JSON.stringify(rows)} }));\n`,
);
commit(repo);
mkdirSync(bare);
writeFileSync(join(bare, "README.md"), "# no kit\n");
commit(bare);

// 5. Open with an explicit path, without a browser.
const first = tt(["open", repo, "--no-browser"]);
const url = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/.exec(first.out)?.[1];
if (first.code !== 0 || !url || !/started/.test(first.out)) fail(`open:\n${first.out}`);
const pid = Number(/pid (\d+)/.exec(first.out)?.[1]);
if (pid) kitchenPids.add(pid);
const port = Number(new URL(url).port);
step(`open started a kitchen on port ${port}`);

const page = await fetch(url);
const html = await page.text();
if (!page.ok || !html.includes('<div id="root">')) fail(`page: HTTP ${page.status}`);
const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
if (!asset || !(await fetch(`http://127.0.0.1:${port}${asset}`)).ok) fail("the built UI's script isn't served");
const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
if (health.app !== "tin-and-thyme" || !health.key?.startsWith("smoke-kitchen-") || !health.instance) fail(`health: ${JSON.stringify(health)}`);
step("built UI served; health reports this kitchen");

const WebSocket = req("ws");
const token = new URL(url).searchParams.get("token");
const snap = await new Promise((done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  let latest = null;
  ws.on("message", (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === "snapshot") latest = e.snapshot;
    else if (latest && e.type === "task.updated") latest.tasks = [...latest.tasks.filter((t) => t.id !== e.task.id), e.task];
    else if (latest && e.type === "workflow.updated") latest.workflow = e.workflow;
    if (latest?.tasks.length === rows.length) {
      ws.close();
      done(latest);
    }
  });
  ws.on("error", (err) => fail(`websocket: ${err.message}`));
  setTimeout(() => fail(`board didn't load in 30s (tasks: ${latest?.tasks.length ?? "no snapshot"})`), 30_000);
});
if (snap.workflow?.kind !== "pathfinder" || snap.workflow.roles?.[0]?.name !== "developer") fail(`workflow: ${JSON.stringify(snap.workflow)}`);
const ids = snap.tasks.map((t) => t.id).sort().join(",");
if (ids !== "1.1,1.2") fail(`board: ${ids}`);
const running = snap.agents.filter((a) => a.session.state === "running" || a.session.state === "starting");
if (running.length) fail(`opening started sessions: ${running.map((a) => a.agentId).join(", ")}`);
step(`board loaded (${ids}), roles loaded, no session started`);

// 6. Opening again from inside the repository reuses it; url prints the same URL.
const again = tt(["open", "--no-browser"], repo);
if (again.code !== 0 || !again.out.includes(url) || !/reused/.test(again.out)) fail(`second open:\n${again.out}`);
const printed = tt(["url", repo]);
if (printed.code !== 0 || printed.out.trim() !== url) fail(`url:\n${printed.out}`);
step("open from the repository reused the kitchen; url printed the same URL");

// 7. The missing-kit message.
const none = tt(["open", bare, "--no-browser"]);
if (none.code !== 2 || !none.out.includes("has no Pathfinder kit") || !none.out.includes("npx create-pathfinder")) fail(`missing kit:\n${none.out}`);
step("a repository without the kit gets the setup message (exit 2)");

cleanup();
console.log("✓ smoke test passed");
process.exit(0);
