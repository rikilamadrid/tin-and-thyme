// The Tin & Thyme server: one kitchen for one repository.
//
//   node dist-server/main.mjs [--repo <path>] [--port 7420] [--dev] [--no-open] [--kitchen]
//
// Users start it through `tin-and-thyme open` (bin/tin-and-thyme.mjs), which picks the port, passes
// --kitchen and reuses a running kitchen. --dev: the UI is served by Vite (pnpm dev:hq).

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCommands } from "./commands";
import { startHttp } from "./http";
import { Hub } from "./hub";
import { GitHubSync } from "./githubSync";
import { Inbox } from "./inbox";
import { Planner } from "./planner";
import { ActionItems } from "./actionItems";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { agentToken, browserToken } from "./paths";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan } from "./store";
import { COORDINATOR_ID, detectPathfinder, PathfinderRun } from "./pathfinder";
import { attachDelivery } from "./delivery/preview";
import { unavailableBoard, unavailableRpc } from "./delivery/service";
import { adoptLegacyState, APP, canonicalRoot, claimStateDir, clearRecord, kitchenKey, writeRecord } from "./kitchen";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  ensurePtyHelperExecutable();
  const dev = flag("dev");
  const port = Number(arg("port") ?? process.env.HQ_PORT ?? 7420);
  const repo = await detectRepo(resolve(arg("repo") ?? process.env.HQ_REPO ?? process.cwd()));
  const pf = detectPathfinder(repo.root);
  const loaded = loadConfig(repo, port);
  const config = loaded.config;
  const isNew = pf ? false : loaded.isNew;
  if (pf) {
    // Zero setup: the roster and the board are Pathfinder's. Nothing is read from or written to .jsmhq/.
    config.team = [PathfinderRun.coordinatorConfig(repo.root)];
    config.project.officeName = "Tin & Thyme";
    config.workflow.review = { enabled: false, tool: "human", command: "" };
  }
  config.project.hqPort = port;
  // A Pathfinder kitchen keys its local state (~/.jsmhq, ~/.controlroom, tmux names) by the repo's canonical
  // path, so two repos with the same folder name never share it.
  const canonical = pf ? canonicalRoot(repo.root) : null;
  if (pf && canonical) {
    config.project.id = kitchenKey(canonical);
    const adopted = adoptLegacyState(canonical, config.project.id);
    if (adopted) log.info(`kitchen state: copied this repo's earlier state from ${adopted}`);
    claimStateDir(canonical, config.project.id);
  }
  const slug = config.project.id;
  const instance = process.env.TT_INSTANCE || randomBytes(12).toString("hex");
  const token = agentToken(slug);
  const uiToken = browserToken(slug, dev);

  log.info(`repo   ${repo.root}${repo.github ? `  (github.com/${repo.github})` : ""}`);
  log.info("checking setup…");
  const setup = await runSetupChecks(repo, config.team);
  for (const c of setup.checks) log.info(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

  const hub = new Hub(repo, slug, config, pf ? { boards: [], tasks: [] } : loadPlan(repo.root), setup);
  if (pf) hub.persist = false;
  hub.snap.welcome = isNew;
  const sessions = new Sessions(hub, token);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
  sessions.onSessionDown = (id) => inbox.sessionDown(id);
  sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
  sessions.lastHookAt = (id) => inbox.lastHookAt(id);
  const sbx = new Sbx(hub);
  sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
  const mcp = new SbxMcp(hub, (id, file, args, onExit) => sessions.runTerminal(id, file, args, onExit));
  sessions.onSandboxReady = (id) => {
    void sbx.syncRules(id);
    void mcp.attachAll(id);
    void sbx.refreshPorts(id);
  };
  sessions.onSessionDown = ((down) => (id: string) => {
    down(id);
    void sbx.refreshPorts(id);
  })(sessions.onSessionDown);
  sessions.onSandboxRemoved = (id) => {
    mcp.forget(id);
    void sbx.refreshPorts(id);
  };
  void sbx.refresh();
  void mcp.refresh();
  const planner = new Planner(hub, inbox);
  planner.actions = new ActionItems(hub, planner);

  let pfRun: PathfinderRun | null = null;
  const commands = makeCommands(hub, sessions, planner, inbox, sbx, mcp);
  if (pf) {
    const prompt = arg("pf-prompt") ?? "/orchestrate start";
    pfRun = new PathfinderRun(hub, inbox, sessions, pf, port, token, prompt);
    const r = pfRun;
    sessions.external = (id) => r.isExternal(id);
    sessions.holdsAsking = (id) => r.isAsking(id);
    const native = { ...commands };
    commands.startAgent = (id) => (id === COORDINATOR_ID ? r.startCoordinator() : undefined);
    commands.stopAgent = (id) => (id === COORDINATOR_ID ? native.stopAgent(id) : undefined);
    commands.assignTask = () => hub.activity("config", null, "Pathfinder owns assignment: start the orchestration instead");
    commands.setContextAlert = (pct) => r.setContextAlert(Number(pct));
    commands.ackContextAlert = (id) => typeof id === "string" && r.ackContextAlert(id);
    commands.checkpointFresh = (id) => typeof id === "string" && void r.handoffs.start(id);
    commands.retryHandoff = (key) => typeof key === "string" && void r.handoffs.retry(key);
    commands.resolveActionItem = (id, decision, note) => {
      if (typeof id === "string" && id.startsWith("gate-")) return r.answerGate(id, decision === "done" ? String(note ?? "") : "");
      return native.resolveActionItem(id, decision, note);
    };
    log.info(`Pathfinder project (${pf.mode} mode) — roster and board come from ${pf.engine}`);
    pfRun.start();
  }

  // In-app delivery (Feature 10): Pathfinder projects with a GitHub origin. Its state is kept in
  // ~/.controlroom/<kitchen>/deliveries/, and it runs only on a request from this kitchen's browser page.
  // The handback (ticket 10.3) is typed into the coordinator's session, once per merge.
  const coordinator = pfRun ? { type: (text: string) => sessions.typeInto(COORDINATOR_ID, text) } : null;
  const delivery = pf ? attachDelivery({ hub, root: repo.root, github: repo.github, kitchenKey: slug, coordinator }) : null;
  const noDelivery = "Delivery works in Pathfinder projects only.";
  if (!delivery) hub.snap.delivery = unavailableBoard(noDelivery);

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  const uiOrigin = dev ? `http://localhost:${uiPort}` : `http://127.0.0.1:${port}`;
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");

  await startHttp({
    hub,
    inbox,
    planner,
    port,
    browserToken: uiToken,
    agentToken: token,
    distDir: dev ? null : distDir,
    allowedOrigins: [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
    commands,
    rpc: delivery?.rpc ?? { delivery: unavailableRpc(noDelivery) },
    hookRouter: pfRun ? { agentId: COORDINATOR_ID, handle: (e, b) => pfRun!.onHook(e, b) } : undefined,
    health: pf ? { app: APP, key: slug, instance } : undefined,
  });
  sessions.startPolling();
  sbx.startApprovalPolling();
  delivery?.start();
  const github = new GitHubSync(hub, planner, pf ? null : repo.github);
  if (!pf) github.start();

  const url = `${uiOrigin}/?token=${uiToken}`;
  log.info(`\n\n  Tin & Thyme is running → ${url}\n`);
  // Started by `tin-and-thyme open`: say where this kitchen is, so the command can find and verify it.
  const kitchen = flag("kitchen") && pf && canonical;
  if (kitchen) writeRecord({ app: APP, key: slug, root: canonical, port, pid: process.pid, instance, url, startedAt: new Date().toISOString() });
  if (!flag("no-open")) {
    // Windows: rundll32 hands the URL to the default browser without a shell (the token has no special chars, but `&` would).
    const [opener, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    // Give Vite a moment in dev.
    setTimeout(() => void run(opener, args), dev ? 1500 : 0);
  }

  const quit = () => {
    log.info(sessions.backend.persistent ? "stopping HQ — agent sessions keep running in tmux" : "stopping HQ and its agents — sandboxes and folders are kept");
    sessions.shutdown();
    sbx.stopApprovalPolling();
    delivery?.stop();
    github.stop();
    if (kitchen) clearRecord(slug, instance);
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`Port ${arg("port") ?? 7420} is in use. Start kitchens with \`tin-and-thyme open\`, which picks a free port and reuses a running kitchen.`);
    process.exit(1);
  }
  if ((err as NodeJS.ErrnoException)?.code === "EACCES") {
    const port = arg("port") ?? 7420;
    log.error(
      process.platform === "win32"
        ? `Windows reserved port ${port} (Hyper-V, WSL and Docker reserve port ranges). Pick another with --port.\n  See the reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp`
        : `Not allowed to use port ${port}. Pick another with --port, or start kitchens with \`tin-and-thyme open\`.`,
    );
    process.exit(1);
  }
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
