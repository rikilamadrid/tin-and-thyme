#!/usr/bin/env node
// tin-and-thyme — open a Tin & Thyme kitchen for a Pathfinder repository.
//
//   tin-and-thyme open [path] [--no-browser]   open (or reuse) the kitchen for a repo
//   tin-and-thyme url [path]                   print a running kitchen's URL
//   tin-and-thyme list                         recorded kitchens and whether they answer
//
// One kitchen per repository, keyed by its canonical path. A healthy kitchen that
// proves it serves that exact repo is reused; otherwise one starts on a free
// localhost port. Opening loads the board and observes sessions; it never starts
// an orchestration round, and it never stops another process or writes into the repo.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const HOME = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(HOME, "package.json"), "utf8"));
const SERVER = join(HOME, "dist-server", "main.mjs");
const KITCHEN = join(HOME, "dist-server", "kitchen.mjs");
const PORTS = { first: 7420, last: 7499 };
const START_TIMEOUT_MS = 45_000;
const LOCK_STALE_MS = 90_000;

const out = (s = "") => process.stdout.write(s + "\n");
const fail = (msg, code = 1) => {
  process.stderr.write(`tin-and-thyme: ${msg}\n`);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `Tin & Thyme ${pkg.version}
Pathfinder runs the round; Tin & Thyme lets you watch the kitchen.

Usage:
  tin-and-thyme open [path]   Open the kitchen for a repository (default: the one you are in)
  tin-and-thyme url [path]    Print the URL of the kitchen already running for a repository
  tin-and-thyme list          List known kitchens and whether they still answer
  tin-and-thyme --help        Show this message
  tin-and-thyme --version     Print the version

Flags:
  --no-browser   Start or reuse the kitchen and print its URL instead of opening the browser

Each repository gets one kitchen: a local server on a free port from ${PORTS.first}, bound to
127.0.0.1. Running open again reuses it once it proves it serves that exact repository.
Opening loads the roles, the ticket board and existing claims, and observes sessions already
running. It never starts an orchestration round: that is the Head Chef's card in the kitchen,
and Pathfinder still asks for your approval before it claims anything.

a Wonder Wagon tool`;

const argv = process.argv.slice(2);
if (argv.includes("-v") || argv.includes("--version")) {
  out(pkg.version);
  process.exit(0);
}
const cmd = argv.find((a) => !a.startsWith("-"));
if (!cmd || argv.includes("-h") || argv.includes("--help")) {
  out(HELP);
  process.exit(cmd || argv.length ? 0 : 1);
}
const positional = argv.filter((a) => !a.startsWith("-")).slice(1);
const unknown = argv.filter((a) => a.startsWith("-") && !["--no-browser"].includes(a));
if (unknown.length) fail(`unknown option ${unknown[0]}. Run "tin-and-thyme --help".`);
if (!["open", "url", "list"].includes(cmd)) fail(`unknown command "${cmd}". Run "tin-and-thyme --help".`);
if (Number(process.versions.node.split(".")[0]) < 20) fail(`needs Node.js 20 or newer (you have ${process.versions.node}).`);
if (!existsSync(SERVER) || !existsSync(KITCHEN) || !existsSync(join(HOME, "dist", "index.html"))) {
  fail(`Tin & Thyme isn't built yet. Build it once:\n  cd ${HOME}\n  pnpm install && pnpm build`);
}

const K = await import(KITCHEN);

/** The repository a path belongs to, canonical, or a readable exit. */
function target() {
  const from = resolve(positional[0] ?? ".");
  try {
    return K.canonicalRoot(from);
  } catch (e) {
    fail(`${e.message} Pass a path inside a Pathfinder repository, e.g. tin-and-thyme open ~/Workspace/my-app`);
  }
}

function openBrowser(url) {
  const [opener, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}

/** True when nothing listens on 127.0.0.1:port (what the server binds). */
function portFree(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** One opener per repo at a time: a lock file next to the record (only ever the lock file is removed). */
async function withLock(key, fn) {
  const file = K.lockFile(key);
  const until = Date.now() + START_TIMEOUT_MS + 15_000;
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code === "ENOENT") {
        (await import("node:fs")).mkdirSync(K.kitchensDir(), { recursive: true });
        continue;
      }
      if (e.code !== "EEXIST") throw e;
      // Someone else is opening this kitchen: if they finish, use theirs.
      const rec = K.readRecord(key);
      if (rec && (await K.verify(rec, key, rec.root))) return { reused: rec, waited: true };
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        /* being written */
      }
      const age = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if ((holder && !alive(holder.pid)) || age > LOCK_STALE_MS) rmSync(file, { force: true });
      else if (Date.now() > until) fail(`another "tin-and-thyme open" for this repo hasn't finished (lock ${file}).`);
      else await sleep(250);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/** Starts a kitchen on the first free port (the last one this repo used first), and waits until it proves itself. */
async function start(root, key, preferred) {
  const candidates = [...new Set([preferred, ...Array.from({ length: PORTS.last - PORTS.first + 1 }, (_, i) => PORTS.first + i)].filter(Boolean))];
  const log = K.logFile(key);
  for (const port of candidates) {
    if (!(await portFree(port))) continue; // whatever owns it stays untouched
    const instance = randomBytes(12).toString("hex");
    const fd = openSync(log, "a", 0o600);
    writeSync(fd, `\n--- ${new Date().toISOString()} tin-and-thyme open ${root} (port ${port})\n`);
    const env = { ...process.env, TT_INSTANCE: instance };
    delete env.HQ_REPO;
    delete env.HQ_PORT;
    const child = spawn(process.execPath, [SERVER, "--repo", root, "--port", String(port), "--no-open", "--kitchen"], { cwd: root, env, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    let exited = null;
    child.on("exit", (code) => (exited = code ?? 1));
    child.unref();
    const until = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < until) {
      await sleep(300);
      const rec = K.readRecord(key);
      if (rec?.instance === instance && (await K.verify(rec, key, root))) return rec;
      if (exited !== null) break;
    }
    if (exited === null) fail(`the kitchen on port ${port} didn't answer within ${START_TIMEOUT_MS / 1000}s. Its log: ${log}`);
    const tail = readFileSync(log, "utf8").split("\n").slice(-12).join("\n");
    if (/is in use/.test(tail)) continue; // lost a race for this port: try the next one
    fail(`the kitchen stopped while starting (exit ${exited}). Last lines of ${log}:\n${tail}`);
  }
  fail(`no free port between ${PORTS.first} and ${PORTS.last}.`);
}

if (cmd === "list") {
  const dir = K.kitchensDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  if (!files.length) out("No kitchens recorded yet. Open one with: tin-and-thyme open <path>");
  for (const f of files) {
    const rec = K.readRecord(f.replace(/\.json$/, ""));
    if (!rec) continue;
    const ok = await K.verify(rec, rec.key, rec.root);
    out(`${ok ? "running" : "stale  "}  ${rec.root}  →  ${ok ? rec.url : `(port ${rec.port} no longer answers as this kitchen)`}`);
  }
  process.exit(0);
}

const root = target();
const key = K.kitchenKey(root);

if (cmd === "url") {
  const rec = K.readRecord(key);
  if (!(await K.verify(rec, key, root))) fail(`no kitchen is running for ${root}. Start one with: tin-and-thyme open ${root} --no-browser`, 3);
  out(rec.url);
  process.exit(0);
}

// open
const kit = K.pathfinderKit(root);
if (!kit.ok) {
  fail(
    `${root} has no Pathfinder kit, so there is no board to show.\n` +
      `  Missing: ${kit.missing.join(", ")}\n\n` +
      `Tin & Thyme doesn't write into your repository. To set Pathfinder up there yourself:\n` +
      `  cd ${root}\n  npx create-pathfinder --mode orchestrator\n` +
      `then open it again with: tin-and-thyme open ${root}`,
    2,
  );
}

let rec = K.readRecord(key);
let how = "reused";
if (!(await K.verify(rec, key, root))) {
  // An older Tin & Thyme for this repo, started by hand before kitchens existed: don't start a second one beside it.
  const old = await K.legacyInstancePort(root);
  if (old) {
    fail(
      `an older Tin & Thyme is already serving ${root} on port ${old} (started by hand, before "tin-and-thyme open").
` +
        `Keep using the URL you opened it with. To move this repo to "tin-and-thyme open", stop that instance yourself, then run:
` +
        `  tin-and-thyme open ${root}`,
      4,
    );
  }
}
if (!(await K.verify(rec, key, root))) {
  const r = await withLock(key, async () => {
    // Checked again under the lock: a concurrent open may have just started it.
    const now = K.readRecord(key);
    if (await K.verify(now, key, root)) return { reused: now };
    if (now) out(`The saved kitchen for this repo (port ${now.port}) no longer answers as itself; starting a new one.`);
    return { started: await start(root, key, now?.port) };
  });
  rec = r.reused ?? r.started;
  how = r.started ? "started" : "reused";
}

out(`Tin & Thyme kitchen for ${root}`);
out(`  ${how} · port ${rec.port} · pid ${rec.pid} · Pathfinder ${kit.mode} mode`);
out(`  ${rec.url}`);
if (argv.includes("--no-browser")) process.exit(0);
openBrowser(rec.url);
