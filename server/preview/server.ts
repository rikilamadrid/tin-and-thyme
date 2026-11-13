// Preview mode: serve one reviewed build of Tin & Thyme next to the running kitchen,
// without touching it (docs/delivery-bootstrap.md).
//
//   node <checkout>/dist-server/main.mjs --preview --port 7520 --reviewed <sha> [--repo <path>] [--no-open]
//
// A preview is delivery only. It attaches to no agent session and starts no coordinator:
// no tmux backend, no Pathfinder run, no sandbox or GitHub polling, no hook token. It writes
// nothing to disk: no kitchen record, no lock, nothing in ~/.controlroom or ~/.jsmhq. Its
// browser and hook tokens live in memory only. It serves only on its own port, outside the
// kitchens' range, and only a build whose identity checks out.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import type { OfficeSnapshot, PreviewInfo, SetupState } from "../../src/data/types";
import { startHttp } from "../http";
import { Hub } from "../hub";
import { Inbox } from "../inbox";
import { Planner } from "../planner";
import { canonicalRoot, kitchenKey, kitchensDir } from "../kitchen";
import { run } from "../lib/exec";
import { log } from "../lib/log";
import { detectRepo } from "../repo";
import { loadConfig } from "../store";
import { verifyBuild } from "./identity";

export const PREVIEW_APP = "tin-and-thyme-preview";
/** `tin-and-thyme open` picks kitchen ports from this range (bin/tin-and-thyme.mjs PORTS). */
export const KITCHEN_PORTS = { first: 7420, last: 7499 };

/**
 * The commands a preview accepts from its browser. None yet: the delivery operations
 * (Feature 10) register here as named, typed functions. Anything else is refused.
 */
export const PREVIEW_COMMANDS: Record<string, (...args: unknown[]) => unknown> = {};

export interface PreviewOptions {
  /** The checkout whose dist/ and dist-server/ are served. */
  buildRoot: string;
  /** The file this process is running: it must be that checkout's dist-server/main.mjs. */
  entry: string;
  port: string | undefined;
  repo: string | undefined;
  reviewed: string | undefined;
  open: boolean;
}

/** Ports any kitchen record names (read only). */
function recordedPorts(): Map<number, string> {
  const out = new Map<number, string>();
  try {
    for (const f of readdirSync(kitchensDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(kitchensDir(), f), "utf8"));
        if (typeof r?.port === "number") out.set(r.port, String(r.key ?? f));
      } catch {
        /* not a record */
      }
    }
  } catch {
    /* no kitchens yet */
  }
  return out;
}

/** The preview's own port: given explicitly, outside the kitchens' range, and named by no kitchen record. */
export function checkPreviewPort(raw: string | undefined): number {
  if (!raw) throw new Error(`A preview needs its own port: --port <n>, outside ${KITCHEN_PORTS.first}-${KITCHEN_PORTS.last} (for example 7520).`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`--port must be a whole number from 1024 to 65535, not "${raw}".`);
  if (port >= KITCHEN_PORTS.first && port <= KITCHEN_PORTS.last)
    throw new Error(`Port ${port} is in the kitchens' range (${KITCHEN_PORTS.first}-${KITCHEN_PORTS.last}). A preview stays out of it so it never takes a kitchen's port.`);
  const owner = recordedPorts().get(port);
  if (owner) throw new Error(`Port ${port} belongs to the kitchen ${owner}. A preview never uses a kitchen's port.`);
  return port;
}

function previewSetup(): SetupState {
  return {
    machine: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), persistentAgents: false },
    checks: [],
    sandboxReady: false,
    localReady: false,
    checkedAt: new Date().toISOString(),
  };
}

export async function runPreview(o: PreviewOptions) {
  const entry = join(o.buildRoot, "dist-server", "main.mjs");
  if (resolve(o.entry) !== entry) throw new Error(`A preview runs only from a stamped build (${entry}), not from ${o.entry}.`);
  const port = checkPreviewPort(o.port);
  const build = verifyBuild(o.buildRoot, o.reviewed);
  const distDir = join(o.buildRoot, "dist");
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`No built UI at ${distDir}. Rebuild with \`pnpm build:preview\`.`);

  const repo = await detectRepo(resolve(o.repo ?? process.cwd()));
  // The kitchen key of the repository it serves, for display only: a preview never reads or
  // writes that kitchen's record, lock, state folder, token or tmux sessions.
  const repoKey = kitchenKey(canonicalRoot(repo.root));
  const instance = randomBytes(12).toString("hex");
  const browserToken = randomBytes(24).toString("hex");
  const agentToken = randomBytes(24).toString("hex"); // never written or handed out: no hook can reach a preview

  const config = loadConfig(repo, port).config; // read only; hub.persist = false below
  config.team = [];
  config.project.id = `${repoKey}-preview`;
  config.project.officeName = "Tin & Thyme preview";
  config.project.hqPort = port;
  const hub = new Hub(repo, config.project.id, config, { boards: [], tasks: [] }, previewSetup());
  hub.persist = false;
  hub.snap.welcome = false;
  const preview: PreviewInfo = { sha: build.sha, tree: build.tree, builtAt: build.builtAt, repo: repo.name, repoKey };
  (hub.snap as OfficeSnapshot).preview = preview;
  const inbox = new Inbox(hub, { type: async () => false, enter: async () => false });
  const planner = new Planner(hub, inbox);

  const origin = `http://127.0.0.1:${port}`;
  let server: Awaited<ReturnType<typeof startHttp>>;
  try {
    server = await startHttp({
      hub,
      inbox,
      planner,
      port,
      browserToken,
      agentToken,
      distDir,
      allowedOrigins: [origin, `http://localhost:${port}`],
      commands: PREVIEW_COMMANDS,
      health: { app: PREVIEW_APP, repoKey, instance, sha: build.sha, tree: build.tree, builtAt: build.builtAt },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") throw new Error(`Port ${port} is in use. Pick another free port outside ${KITCHEN_PORTS.first}-${KITCHEN_PORTS.last}.`);
    throw err;
  }

  const url = `${origin}/?token=${browserToken}`;
  log.info(`repo     ${repo.root}`);
  log.info(`build    ${build.sha} (tree ${build.tree}, built ${build.builtAt})`);
  log.info(`mode     preview: delivery only; attaches to no agent session and starts no coordinator`);
  log.info(`\n\n  Tin & Thyme preview is running → ${url}\n`);
  if (o.open) {
    const [opener, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    void run(opener, args);
  }

  const quit = () => {
    log.info("stopping the preview (it held no sessions and wrote no state)");
    inbox.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
