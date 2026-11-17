// Ticket 04.1: the alien Master Prompter joins the kitchen.
//
//   npx tsx scripts/prompter-test.ts
//
// Runs with a temporary HOME and temporary repositories. It starts no native session, no kitchen and no
// browser: the server's own command table (Settings → Team's `addPrompter`) and the Pathfinder kitchen's
// prompter runtime are driven directly, with the terminal backend stubbed.
//
//   1. contract   the alien is in the crew catalog, reserved for the prompter's own session (never a ticket's)
//   2. role       the coaching contract, the native ROLE.md, the read-only launch and the settings file
//   3. native     add from the server command path: the alien at its spot, a second add refused, no tasks
//   4. pathfinder the same through the crew book: persistent, one at most, arrivals and departures, restart

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = mkdtempSync(join(tmpdir(), "tt-prompter-"));
process.env.HOME = HOME;
// The galley model imports the store, which reads the page address when it loads.
(globalThis as { location?: unknown }).location ??= { href: "http://localhost/" };

const contract = await import("../src/data/crewContract");
const { CHARACTERS } = await import("../src/data/crew");
const P = await import("../src/data/prompter");
const { roleMd } = await import("../server/agentFiles");
const { adapters } = await import("../server/adapters");
const { Hub } = await import("../server/hub");
const { Inbox } = await import("../server/inbox");
const { Planner } = await import("../server/planner");
const { makeCommands } = await import("../server/commands");
const { loadConfig } = await import("../server/store");
const { CrewRegistry } = await import("../server/crew");
const { PathfinderPrompter, prompterLaunchArgs, writePrompterSettings } = await import("../server/prompter");
const { PathfinderRun } = await import("../server/pathfinder");
const { mockSetup } = await import("../src/data/mock/world");
const { buildGalley } = await import("../src/galley/model");
const { SPOTS, targetFor } = await import("../src/galley/scene");
type HubT = InstanceType<typeof Hub>;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const section = (t: string) => console.log(`\n${t}`);
const NOW = "2026-11-17T12:00:00.000Z";

// ---------------------------------------------------------------- 1. contract

section("Contract: the alien is catalogued and reserved for the prompter's own session");
{
  const { allocateCharacter, CHARACTER_FAMILY, crewContractProblems, emptyCrewBook, endSession, FAMILY_POOLS, familyFor, isCrewCharacterId, PROMPTER_CHARACTER, retireCharacter, startSession, continueSession, beginRestore, reconcileAfterRestore } = contract;
  check("alien is a crew character id in the catalog (name, job, look)", isCrewCharacterId("alien") && CHARACTERS.alien.job === "Master Prompter" && !!CHARACTERS.alien.look);
  check("its family is prompter, whose pool is the alien alone", CHARACTER_FAMILY.alien === "prompter" && FAMILY_POOLS.prompter.join() === "alien" && PROMPTER_CHARACTER === "alien");
  check("the catalogue still holds (crewContractProblems is empty)", crewContractProblems().length === 0, crewContractProblems());
  check("a brief with Role: prompter, or Session: prompt, is the prompter family", familyFor("prompter", "implementation") === "prompter" && familyFor(null, "prompt") === "prompter");

  const book = emptyCrewBook("k", NOW);
  const w1 = startSession(book, "w1", { kind: "worker", role: "prompter", stage: "implementation", ticket: "18.10" }, NOW);
  const w2 = startSession(book, "w2", { kind: "worker", role: null, stage: "prompt", ticket: "18.11" }, NOW);
  const h1 = startSession(book, "h1", { kind: "helper", role: "prompter", stage: "helper" }, NOW);
  check("excluded from ticket work: a dispatched worker in the prompter family never wears the alien (overflow)", w1.family === "prompter" && w1.characterId === null && w2.characterId === null, [w1.characterId, w2.characterId]);
  check("…nor does a helper, whatever its role (it is a helper)", h1.family === "helper" && h1.characterId !== "alien", h1.characterId);
  check("…and allocateCharacter refuses it for every kind but prompter", ["worker", "helper", "coordinator"].every((k) => allocateCharacter(book, "prompter", null, k as never) !== "alien"));
  const p1 = startSession(book, "prompter:a", { kind: "prompter", hqId: P.PROMPTER_ID, role: "prompter", stage: "prompt" }, NOW);
  check("the prompter's own session (kind prompter) wears the alien", p1.family === "prompter" && p1.characterId === "alien");
  const p2 = startSession(book, "prompter:b", { kind: "prompter", hqId: P.PROMPTER_ID, role: "prompter", stage: "prompt" }, NOW);
  check("at most one: a second live prompter session is overflow", p2.characterId === null);
  endSession(book, p1.id, null, NOW);
  const resumed = continueSession(book, "prompter:a", { via: "hook", evidence: null }, NOW);
  check("a resumed prompter conversation keeps the alien (a linked occurrence)", !!resumed && resumed.id === "prompter:a#2" && resumed.characterId === "alien" && resumed.continuation?.of === "prompter:a");
  endSession(book, resumed!.id, null, NOW);
  retireCharacter(book, "alien", true, NOW);
  check("a retired alien is never allocated, even to a prompter session", startSession(book, "prompter:c", { kind: "prompter", role: "prompter", stage: "prompt" }, NOW).characterId === null);

  // Restore: a running prompter keeps the alien through the startup pass; one not running ends.
  const b2 = emptyCrewBook("k", NOW);
  const live = startSession(b2, "prompter:x", { kind: "prompter", role: "prompter", stage: "prompt" }, NOW);
  beginRestore(b2);
  reconcileAfterRestore(b2, [live.id], NOW);
  check("reconcile keeps a running prompter session on the alien", b2.sessions[live.id].phase === "live" && b2.sessions[live.id].characterId === "alien");
  beginRestore(b2);
  reconcileAfterRestore(b2, [], NOW);
  check("reconcile ends a prompter session that is not running (outcome unknown)", b2.sessions[live.id].phase === "ended" && b2.sessions[live.id].end === null);
}

// ---------------------------------------------------------------- 2. role

section("Role: Feature 04's coaching contract, read-only");
{
  const md = P.PROMPTER_ROLE_MD;
  check("it reads only what is needed, and names that context", /Read only the project context that request needs/.test(md) && ["CLAUDE.md", "AGENTS.md", "context/project-overview.md", "context/current-ticket.md", "context/features/", "context/tickets/", "context/handoff.md"].every((f) => md.includes(f)) && /Never load the whole repository/.test(md));
  check("it returns a ready-to-paste prompt plus a short why, citing the ticket and its files", /ready-to-paste prompt/.test(md) && /\*\*Why\*\*/.test(md) && /names the ticket key, the files/.test(md) && /citing the files you read/.test(md));
  check("it never edits files and never takes a ticket", /Never edit, create, move or delete a file/.test(md) && /Never take a ticket, claim work or start an agent/.test(md));

  const repo = { root: join(HOME, "role-repo"), name: "role", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false };
  mkdirSync(repo.root, { recursive: true });
  const { config } = loadConfig(repo, 7999);
  const agent = { ...config.team[1], id: "prompter", name: "Zorbo", role: "Master Prompter", roleMd: md, crew: P.prompterCrew() };
  config.team.push(agent);
  const own = roleMd(agent, config);
  check("native ROLE.md: the coaching role, the prompter's rules, no ticket tools", own.includes(md.trim().split("\n")[0]) && own.includes("You never take, claim or work on a task") && !own.includes("get_my_task") && !own.includes("gh pr create") && own.includes("Your tools: list_workers, get_status, list_tasks, ask_user"));
  const lead = roleMd(config.team[0], config);
  check("the lead's ROLE.md says never to assign it a task, and marks it in the team list", lead.includes("Never assign a task to the Master Prompter") && lead.includes("Zorbo — Master Prompter (Master Prompter: coaches the user's prompts, never takes tasks)"));
  check("a teammate's ROLE.md is unchanged by it (still its worker rules)", roleMd(config.team[1], config).includes("call get_my_task first"));
  const args = adapters.claude.launch(agent).args;
  check("native launch: Claude Code gets every editing tool disallowed", args.join(" ").includes("--disallowedTools Edit,Write,NotebookEdit"), args);
  check("…and a teammate's launch is unchanged", !adapters.claude.launch(config.team[1]).args.includes("--disallowedTools"));

  const settings = writePrompterSettings(join(HOME, "state"), "http://127.0.0.1:7999/hook/prompter", "tok");
  const json = JSON.parse(readFileSync(settings, "utf8"));
  check("Pathfinder launch: settings deny every editing tool and report hooks to /hook/prompter", JSON.stringify(json.permissions.deny) === JSON.stringify([...P.PROMPTER_DISALLOWED_TOOLS]) && JSON.stringify(json.hooks.Stop).includes("/hook/prompter/Stop") && settings.startsWith(HOME));
  const la = prompterLaunchArgs(settings);
  check("Pathfinder launch: the role goes in as an appended system prompt, nothing is written into the project", la[0] === "--settings" && la.includes("--append-system-prompt") && la[la.indexOf("--append-system-prompt") + 1] === md && la[la.indexOf("--disallowedTools") + 1] === "Edit,Write,NotebookEdit");
  check("Pathfinder launch: permission mode pinned to default (a global auto mode never lets it act unasked)", la.join(" ").endsWith("--permission-mode default"));
}

// ---------------------------------------------------------------- 3. native (server command path)

section("Native team: Settings → Team → Add the Master Prompter (server command table)");
{
  const root = join(HOME, "native-repo");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const repo = { root, name: "native", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false };
  const { config } = loadConfig(repo, 7999);
  const hub = new Hub(repo, "prompter-test", config, { boards: [{ id: "b1", title: "Board", status: "active" }], tasks: [{ id: "T-1", boardId: "b1", title: "A task", description: "", files: [], doneWhen: "", needs: [], status: "todo", ownerId: null, note: null, prNumber: null }] } as never, mockSetup());
  const inbox = new Inbox(hub, { type: async () => true, enter: async () => true });
  const planner = new Planner(hub, inbox);
  const removed: string[] = [];
  const sessions = { removeResources: async (id: string) => (removed.push(id), []), recheckSetup: async () => {} };
  const stub = { forget: () => {}, refresh: async () => {} };
  const commands = makeCommands(hub, sessions as never, planner, inbox, stub as never, stub as never);
  const before = hub.snap.config.team.length;
  const first = commands.addPrompter();
  const p = P.findPrompter(hub.snap.config.team);
  check("the first add is accepted and adds one row, flagged crew.role = prompter, wearing the alien", first === null && hub.snap.config.team.length === before + 1 && !!p && p.id === "prompter" && p.crew?.role === "prompter" && p.crew.character === "alien" && p.crew.ticket === null);
  check("it has a status entry and the coaching role", !!hub.status("prompter") && p!.roleMd === P.PROMPTER_ROLE_MD);
  const saved = JSON.parse(readFileSync(join(root, ".jsmhq", "config.json"), "utf8"));
  check("it is saved with the team (.jsmhq/config.json keeps its crew flag)", saved.team.some((a: { id: string; crew?: { role: string } }) => a.id === "prompter" && a.crew?.role === "prompter"));
  const second = commands.addPrompter();
  check("a second add is refused, says why, and changes nothing", typeof second === "string" && /already has its Master Prompter/.test(second as string) && P.findPrompter(hub.snap.config.team) === p && hub.snap.config.team.filter(P.isPrompter).length === 1 && hub.snap.activity.some((e) => /already has its Master Prompter/.test(e.text)), second);

  const m = buildGalley(hub.snap);
  const alien = m.prompter;
  check("the galley shows the alien at its own spot (not a pod, the pass or the lounge)", !!alien && alien.character === "alien" && alien.place === "prompter" && targetFor(m, alien, new Map()).x === SPOTS.prompter.x && targetFor(m, alien, new Map()).y === SPOTS.prompter.y);
  check("…in the same art as every robot: its portrait is the alien (crewIdentity)", alien!.character === "alien" && m.lounge.every((c) => c.id !== "prompter") && m.pods.every((x) => x.kind !== "cook" || x.member.id !== "prompter"));

  let threw = "";
  try {
    planner.assign("T-1", "prompter", "lead");
  } catch (e) {
    threw = (e as Error).message;
  }
  check("excluded from assignment: the lead's assign_task path (Planner.assign) refuses it", threw === P.PROMPTER_NO_TASKS && hub.snap.tasks[0].ownerId === null, threw);
  commands.assignTask("T-1", "prompter");
  check("…and so does the browser's Assign (said in the activity feed, task untouched)", hub.snap.tasks[0].ownerId === null && hub.snap.activity.some((e) => e.text === P.PROMPTER_NO_TASKS));
  planner.assign("T-1", hub.snap.config.team[1].id, "lead");
  check("…while a teammate still takes it", hub.snap.tasks[0].ownerId === hub.snap.config.team[1].id);

  await commands.removeAgent("prompter", { deleteSandbox: false, deleteFolder: false });
  check("removed like any agent", !P.findPrompter(hub.snap.config.team) && removed.includes("prompter") && !hub.status("prompter"));
  check("once removed it can be added again", commands.addPrompter() === null && hub.snap.config.team.filter(P.isPrompter).length === 1);
}

// ---------------------------------------------------------------- 4. Pathfinder (crew book)

section("Pathfinder kitchen: the prompter in the crew book (09.3's persistent crew and sessions)");
{
  const root = join(HOME, "pf-repo");
  const state = join(HOME, ".controlroom", "pf-kitchen");
  mkdirSync(root, { recursive: true });
  const { crewFloorChanges, FINISHED_LINGER_MS } = contract;
  const repo = { root, name: "pf", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false };
  const makeHub = () => {
    const { config } = loadConfig(repo, 7999);
    config.team = [PathfinderRun.coordinatorConfig(root)];
    const hub = new Hub(repo, "pf-kitchen", config, { boards: [], tasks: [] }, mockSetup());
    hub.persist = false;
    return hub;
  };
  const launched: { id: string; dir: string; args: string[] }[] = [];
  const sessionsFor = (hub: HubT) => ({
    async startExternal(id: string, dir: string, spec: { args: string[] }) {
      launched.push({ id, dir, args: spec.args });
      hub.setSession(id, { state: "running", detail: null, workspace: dir });
    },
    async stop(id: string) {
      hub.setSession(id, { state: "stopped", detail: null });
    },
  });
  const boot = (hub: HubT, reconcile: (crew: InstanceType<typeof CrewRegistry>) => string[] = () => []) => {
    const crew = new CrewRegistry(state, "pf-kitchen", NOW);
    let snaps: ReturnType<typeof crew.snapshot>[] = [];
    const prompter: InstanceType<typeof PathfinderPrompter> = new PathfinderPrompter({
      hub, sessions: sessionsFor(hub) as never, root: () => root, stateDir: () => state, port: 7999, agentToken: "tok",
      crew: () => crew, crewProblem: () => null,
      changed: () => {
        prompter.sync(crew);
        prompter.observe(crew, new Date().toISOString());
        crew.save();
        snaps.push(crew.snapshot());
      },
    });
    // The kitchen's first poll: the row follows the book even while the restore pass is open, then it closes.
    prompter.sync(crew);
    crew.reconcile([...reconcile(crew), ...prompter.runningIds(crew)]);
    prompter.sync(crew);
    snaps = [crew.snapshot()];
    return { crew, prompter, snaps: () => snaps };
  };

  const hub = makeHub();
  const k = boot(hub);
  check("before any add: no prompter row, no alien record", !P.findPrompter(hub.snap.config.team) && !k.crew.book.characters.alien);
  const first = k.prompter.add();
  const row = P.findPrompter(hub.snap.config.team);
  check("add: accepted; the alien's record is created (not retired) and its row joins right after the coordinator", first === null && k.crew.book.characters.alien?.retired === false && hub.snap.config.team[1]?.id === "prompter" && row?.crew?.character === "alien" && row.mode === "local" && row.workspacePath === root);
  const [s0, s1] = [k.snaps()[0], k.snaps().at(-1)!];
  check("the published crew lists the alien (family prompter, available) and the transporter announces one arrival", s1!.characters.some((c) => c.id === "alien" && c.family === "prompter" && c.state === "available") && JSON.stringify(crewFloorChanges(s0!, s1!)) === JSON.stringify({ arrivals: ["alien"], departures: [] }));
  const m = buildGalley(hub.snap);
  check("the galley shows the alien at its spot (off until started)", m.prompter?.place === "prompter" && m.prompter.state === "off" && targetFor(m, m.prompter, new Map()).y === SPOTS.prompter.y);
  const second = k.prompter.add();
  check("a second add is refused, says why, and changes nothing", typeof second === "string" && /already has its Master Prompter/.test(second!) && hub.snap.config.team.filter(P.isPrompter).length === 1 && hub.snap.activity.some((e) => /already has its Master Prompter/.test(e.text)), second);

  await k.prompter.start();
  const live = Object.values(k.crew.book.sessions).find((s) => s.kind === "prompter" && s.phase === "live");
  check("Start: one Claude Code session in the project root, with the coaching role and no editing tools", launched.length === 1 && launched[0].id === "prompter" && launched[0].dir === root && launched[0].args.includes("--append-system-prompt") && launched[0].args.includes("--disallowedTools"));
  check("its session is recorded once (kind prompter, stage prompt) and wears the alien", !!live && live.characterId === "alien" && live.stage === "prompt" && live.ticket === null && live.hqId === "prompter");
  hub.setStatus("prompter", { state: "working", note: "Using Read" });
  k.prompter.observe(k.crew, new Date().toISOString());
  const view = k.crew.snapshot()!.characters.find((c) => c.id === "alien")!;
  check("observed state flows into the crew (working, no ticket)", view.state === "working" && view.ticket === null && view.role === "prompter");
  await k.prompter.start();
  check("a second Start while it runs launches nothing", launched.length === 1);

  // Restart while its tmux session is still alive: the row is back during restore, the session keeps the alien.
  const hub2 = makeHub();
  hub2.snap.agents.push(Hub.freshStatus("prompter"));
  hub2.setSession("prompter", { state: "running", detail: null, workspace: root });
  const k2 = boot(hub2);
  const after = Object.values(k2.crew.book.sessions).filter((s) => s.kind === "prompter");
  check("restart with the session alive: the row is restored from the book, and the same conversation keeps the alien", hub2.snap.config.team[1]?.id === "prompter" && after.filter((s) => s.phase === "live").length === 1 && after.find((s) => s.phase === "live")!.characterId === "alien" && after.every((s) => s.conversation === live!.conversation));
  check("…and a restart replays no arrival", JSON.stringify(crewFloorChanges(null, k2.snaps()[0]!)) === JSON.stringify({ arrivals: [], departures: [] }));
  // Its session ends: the alien stays (a session ending never beams it out).
  hub2.setSession("prompter", { state: "stopped", detail: null });
  k2.prompter.sync(k2.crew);
  const ended = k2.crew.snapshot()!;
  check("its session ending keeps the alien on the floor and its row in the team", !!P.findPrompter(hub2.snap.config.team) && Object.values(k2.crew.book.sessions).every((s) => s.kind !== "prompter" || s.phase === "ended") && JSON.stringify(crewFloorChanges(k2.snaps()[0]!, ended).departures) === "[]");

  // Remove: stop, retire; the row leaves; it departs once its handoff pose is over.
  await k2.prompter.start();
  await k2.prompter.remove();
  const gone = k2.crew.book.characters.alien!;
  const pSessions = Object.values(k2.crew.book.sessions).filter((s) => s.kind === "prompter");
  check("remove: its session stops and the alien is retired (record and history kept); the row leaves", gone.retired && !P.findPrompter(hub2.snap.config.team) && !hub2.status("prompter") && pSessions.length >= 2 && pSessions.every((s) => s.phase === "ended"), { retired: gone.retired, row: !!P.findPrompter(hub2.snap.config.team), status: hub2.status("prompter")?.session.state, sessions: pSessions.map((s) => [s.id, s.phase]) });
  const later = k2.crew.snapshot(Date.now() + FINISHED_LINGER_MS + 1000)!;
  check("…and the transporter announces one departure, once", JSON.stringify(crewFloorChanges(k2.snaps()[0]!, later)) === JSON.stringify({ arrivals: [], departures: ["alien"] }) && JSON.stringify(crewFloorChanges(later, k2.crew.snapshot(Date.now() + FINISHED_LINGER_MS + 2000)!)) === JSON.stringify({ arrivals: [], departures: [] }));
  check("added again: un-retired, one arrival", k2.prompter.add() === null && !k2.crew.book.characters.alien!.retired && JSON.stringify(crewFloorChanges(later, k2.crew.snapshot(Date.now() + FINISHED_LINGER_MS + 3000)!).arrivals) === JSON.stringify(["alien"]));
  // A brief can never put ticket work on it.
  const brief = k2.crew.start("w-subagent", { kind: "worker", role: "prompter", stage: "implementation", ticket: "18.10" });
  check("excluded from assignment: a dispatched Role: prompter worker is overflow, never the alien", brief.characterId === null && brief.family === "prompter");
  // The book written to disk holds the new kind and family and reads back.
  const reread = new CrewRegistry(state, "pf-kitchen");
  check("the crew book on disk validates with a prompter session (reloads without quarantine)", Object.values(reread.book.sessions).some((s) => s.kind === "prompter") && reread.book.characters.alien?.family === "prompter");
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed (temporary HOME; no native session, kitchen or browser)`);
process.exit(failed ? 1 : 0);
