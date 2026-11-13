// Durable gate occurrence identity (ticket 06.3), checked against the real
// Pathfinder engine in skills/orchestrate/engine on a throwaway local-Markdown
// store. Every command runs the real CLI in a fresh process, so every step is
// also a restart.
//
//   node scripts/gate-occurrence-test.mjs
//
// Covers: a new open gets a new occurrence; a retried open or resolve reuses
// it and posts no duplicate; a resolution names its exact occurrence; the same
// question opened, resolved and reopened is a different occurrence; the
// `state --set human-gate` path writes a marker; a fresh process reads the same
// identities; old-format markers parse as "no identity" and are never
// rewritten or given one; read-only commands still work.
//
// Review repair 1 adds: `state --set human-gate` refuses what `gate open`
// refuses; leaving a gate through `state` writes the resolved marker of its
// occurrence; a gate an earlier engine left behind, opened again, gets an
// occurrence; and each path's retry hint names that same path.
//
// Review repair 2 adds: a state change the engine refuses (an unknown state,
// a blank value) writes nothing, so it cannot close a gate it never left, and
// the human's later answer is recorded against that same occurrence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "orchestrate", "engine");
const BIN = join(ENGINE, "bin", "orchestrate.mjs");
const engine = (name) => import(pathToFileURL(join(ENGINE, name)).href);
const { digest, gateOpenedNote, gateResolvedNote, normaliseQuestion } = await engine("comments.mjs");
const { isGateOccurrence, parseGateMarker } = await engine("gates.mjs");
const { postNote } = await engine("tracker.mjs");
const { updateStateFile } = await engine("statefile.mjs");

const NOW = "2026-11-12T10:00:00Z"; // One clock for every step: identity must not come from it.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function orchestrate(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args, "--root", root], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function ok(...args) {
  const result = orchestrate(...args);
  assert.equal(result.status, 0, `orchestrate ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result;
}

const ticketPath = (key) => join(root, ".pathfinder", "worktrees", key, "context", "tickets", `${key}-t.md`);
const statePath = (key) => join(root, ".pathfinder", "worktrees", key, "context", "current-ticket.md");
const gateMarkers = (key) =>
  readFileSync(ticketPath(key), "utf8").split(/\r?\n/).map(parseGateMarker).filter(Boolean);
const gateId = (key) => (/^-\s*Gate-Id:\s*(\S+)\s*$/m.exec(readFileSync(statePath(key), "utf8")) ?? [])[1] ?? null;
const D = (question) => digest(normaliseQuestion(question));
const stateField = (key, name) => (new RegExp(`^-\\s*${name}:\\s*(.*?)\\s*$`, "m").exec(readFileSync(statePath(key), "utf8")) ?? [])[1] ?? null;
const local = (key) => ({
  store: { kind: "local" },
  ticket: { key, ref: `context/tickets/${key}-t.md` },
  worktree: join(root, ".pathfinder", "worktrees", key),
});

// --- the scratch project -----------------------------------------------------

const KEYS = ["99.1", "99.2", "99.3", "99.4", "99.5", "99.6", "99.7", "99.8", "99.9"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-occurrence-")));
try {
  git(["init", "--quiet", "--initial-branch=main"], root);
  mkdirSync(join(root, "context", "tickets"), { recursive: true });
  // The routing policy refuses a selection naming a role with no contract.
  mkdirSync(join(root, "roles"), { recursive: true });
  for (const role of ["planner", "orchestrator", "developer", "tester", "integrator"]) {
    writeFileSync(join(root, "roles", `${role}.md`), `---\nname: ${role}\ndescription: ${role}\n---\n`);
  }
  writeFileSync(join(root, ".gitignore"), "/context/current-ticket.md\n/.pathfinder/\n");
  writeFileSync(join(root, "context", "execution-mode.md"), "# Execution Mode\n\n<!-- pathfinder:execution-mode orchestrator -->\n");
  for (const key of KEYS) {
    writeFileSync(
      join(root, "context", "tickets", `${key}-t.md`),
      `# Ticket ${key}\n\n## Status\n\nProposed\n\n## Parent Feature\n\n\`99-x.md\`\n\n## Blocked by\n\nNone\n\n## Goal\n\nSomething.\n\n## Notes / Decisions\n\n- Existing note.\n`,
    );
  }
  git(["add", "-A"], root);
  git(["commit", "--quiet", "-m", "initial"], root);
  for (const key of KEYS) ok("claim", key, "--now", NOW);

  const Q = "Authorize repair?";

  // --- gate open / resolve ---------------------------------------------------

  let first;
  check("a new open records a new occurrence in the state file and its marker", () => {
    ok("gate", "99.1", "open", "--question", Q, "--now", NOW);
    first = gateId("99.1");
    assert.ok(isGateOccurrence(first), `Gate-Id is an occurrence: ${first}`);
    assert.deepEqual(gateMarkers("99.1"), [{ event: "gate-opened", key: "99.1", digest: D(Q), occurrence: first }]);
  });

  check("a retried open reuses the occurrence and posts no duplicate", () => {
    ok("gate", "99.1", "open", "--question", Q, "--now", NOW);
    ok("gate", "99.1", "open", "--question", Q, "--now", "2027-01-01T00:00:00Z");
    assert.equal(gateId("99.1"), first);
    assert.equal(gateMarkers("99.1").length, 1);
  });

  check("a retried resolve reuses the occurrence and posts no duplicate", () => {
    // A resolve that died after its note and before the state file: the note
    // is in the store, the gate is still open.
    const worktree = join(root, ".pathfinder", "worktrees", "99.1");
    const ticket = { key: "99.1", ref: "context/tickets/99.1-t.md" };
    const partial = postNote({ store: { kind: "local" }, ticket, worktree, note: gateResolvedNote({ key: "99.1", question: Q, answer: "yes", now: NOW, occurrence: first }) });
    assert.deepEqual(partial, { ok: true, posted: true });
    ok("gate", "99.1", "resolve", "--answer", "yes", "--now", NOW);
    const again = orchestrate("gate", "99.1", "resolve", "--answer", "yes", "--now", NOW);
    assert.equal(again.status, 1, "a resolved gate cannot be resolved again");
    assert.equal(gateMarkers("99.1").filter((m) => m.event === "gate-resolved").length, 1);
    assert.equal(gateId("99.1"), null, "resolving clears Gate-Id with Gate");
  });

  check("the resolution references the exact occurrence it closed", () => {
    const [opened, resolved] = gateMarkers("99.1");
    assert.equal(resolved.event, "gate-resolved");
    assert.equal(resolved.occurrence, opened.occurrence);
    assert.equal(resolved.occurrence, first);
  });

  let second;
  check("the same question opened, resolved and reopened is a different occurrence", () => {
    ok("gate", "99.1", "open", "--question", Q, "--now", NOW);
    second = gateId("99.1");
    assert.ok(isGateOccurrence(second));
    assert.notEqual(second, first);
    ok("gate", "99.1", "resolve", "--answer", "no", "--now", NOW);
    const markers = gateMarkers("99.1");
    assert.deepEqual(
      markers.map((m) => [m.event, m.digest, m.occurrence]),
      [
        ["gate-opened", D(Q), first],
        ["gate-resolved", D(Q), first],
        ["gate-opened", D(Q), second],
        ["gate-resolved", D(Q), second],
      ],
    );
    const resolvedMarkers = markers.filter((m) => m.event === "gate-resolved");
    assert.notEqual(resolvedMarkers[0].occurrence, resolvedMarkers[1].occurrence, "both resolutions are distinct");
  });

  let byHand;
  check("a gate a worker opened by editing its state file gets an occurrence when the orchestrator records it", () => {
    updateStateFile(join(root, ".pathfinder", "worktrees", "99.1"), { set: { State: "human-gate", Gate: Q, Updated: NOW } });
    assert.equal(gateId("99.1"), null);
    ok("gate", "99.1", "open", "--question", Q, "--now", NOW);
    byHand = gateId("99.1");
    assert.ok(isGateOccurrence(byHand));
    assert.ok(![first, second].includes(byHand));
    ok("gate", "99.1", "resolve", "--now", NOW);
    assert.equal(gateMarkers("99.1").filter((m) => m.occurrence === byHand).length, 2);
  });

  // --- state --set human-gate -------------------------------------------------

  let viaState;
  check("state --set human-gate --gate opens an occurrence and writes its marker", () => {
    ok("state", "99.2", "--set", "human-gate", "--gate", Q, "--now", NOW);
    viaState = gateId("99.2");
    assert.ok(isGateOccurrence(viaState));
    assert.deepEqual(gateMarkers("99.2"), [{ event: "gate-opened", key: "99.2", digest: D(Q), occurrence: viaState }]);
    ok("state", "99.2", "--set", "human-gate", "--gate", Q, "--now", NOW);
    ok("gate", "99.2", "open", "--question", Q, "--now", NOW);
    assert.equal(gateId("99.2"), viaState, "a retry by either path reuses it");
    assert.equal(gateMarkers("99.2").length, 1);
  });

  check("leaving human-gate through state clears Gate-Id, and the next gate is new", () => {
    ok("state", "99.2", "--set", "working", "--now", NOW);
    assert.equal(gateId("99.2"), null);
    assert.deepEqual(gateMarkers("99.2").at(-1), { event: "gate-resolved", key: "99.2", digest: D(Q), occurrence: viaState }, "its occurrence is closed in the store");
    ok("state", "99.2", "--set", "human-gate", "--gate", Q, "--now", NOW);
    assert.notEqual(gateId("99.2"), viaState);
    assert.equal(gateMarkers("99.2").filter((m) => m.event === "gate-opened").length, 2);
    ok("gate", "99.2", "resolve", "--now", NOW);
  });

  // --- restart ----------------------------------------------------------------

  check("a fresh process reads the same identities from the store and state file", () => {
    const script = `
      const { parseGateMarker } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "gates.mjs")).href)});
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(${JSON.stringify(ticketPath("99.1"))}, "utf8");
      process.stdout.write(JSON.stringify(text.split(/\\r?\\n/).map(parseGateMarker).filter(Boolean)));
    `;
    const fresh = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout), gateMarkers("99.1"));
    ok("gate", "99.1", "open", "--question", "Restart?", "--now", NOW);
    const before = gateId("99.1");
    const status = JSON.parse(ok("status", "--json").stdout);
    assert.equal(status.rows.find((row) => row.key === "99.1").state, "human-gate");
    ok("gate", "99.1", "open", "--question", "Restart?", "--now", NOW);
    assert.equal(gateId("99.1"), before, "a later process reuses the recorded occurrence");
    ok("gate", "99.1", "resolve", "--now", NOW);
  });

  // --- old-format markers -----------------------------------------------------

  check("old-format markers parse as no occurrence identity", () => {
    const legacy = `<!-- pathfinder:orchestrate gate-opened 99.3 ${D(Q)} -->`;
    assert.deepEqual(parseGateMarker(legacy), { event: "gate-opened", key: "99.3", digest: D(Q), occurrence: null });
    assert.equal(parseGateMarker(legacy.replace("gate-opened", "gate-resolved")).occurrence, null);
    assert.equal(gateOpenedNote({ key: "99.3", question: Q, now: NOW }).marker, legacy, "no occurrence, old spelling");
    assert.equal(parseGateMarker("<!-- pathfinder:orchestrate claimed 99.3 ticket/99.3-t -->"), null);
  });

  check("a gate an earlier engine opened is never rewritten or given an occurrence", () => {
    // What the old engine left: its three-fact note, and a state file at the
    // gate with no Gate-Id. Resolving it names no occurrence, because it has
    // none.
    const { worktree, ticket, store } = local("99.3");
    postNote({ store, ticket, worktree, note: gateOpenedNote({ key: "99.3", question: Q, now: NOW }) });
    updateStateFile(worktree, { set: { State: "human-gate", Gate: Q, Updated: NOW } });
    const before = readFileSync(ticketPath("99.3"), "utf8");

    ok("gate", "99.3", "resolve", "--answer", "ok", "--now", NOW);
    assert.equal(gateId("99.3"), null, "no invented occurrence for the legacy gate");
    const after = readFileSync(ticketPath("99.3"), "utf8");
    assert.ok(after.startsWith(before.trimEnd()), "the old record is untouched");
    assert.deepEqual(
      gateMarkers("99.3").map((m) => [m.event, m.occurrence]),
      [["gate-opened", null], ["gate-resolved", null]],
    );

    ok("gate", "99.3", "open", "--question", Q, "--now", NOW);
    const fresh = gateId("99.3");
    assert.ok(isGateOccurrence(fresh), "a genuinely new opening after it gets an occurrence");
    assert.deepEqual(gateMarkers("99.3").at(-1), { event: "gate-opened", key: "99.3", digest: D(Q), occurrence: fresh });
    assert.equal(gateMarkers("99.3").filter((m) => m.occurrence === null).length, 2, "the legacy pair keeps no identity");
  });

  check("a legacy gate opened again gets a new occurrence; the old note is never rewritten", () => {
    // Review scenario E: the old engine opened Q, its `state --set working`
    // closed it with no note, and the worker set human-gate Q again by hand.
    // That record reads exactly like an old gate still open and now retried,
    // so both get a new occurrence: the new opening is never left without
    // identity, and the old three-fact note keeps none.
    const { worktree, ticket, store } = local("99.6");
    postNote({ store, ticket, worktree, note: gateOpenedNote({ key: "99.6", question: Q, now: NOW }) });
    updateStateFile(worktree, { set: { State: "working", Updated: NOW }, unset: ["Gate"] });
    updateStateFile(worktree, { set: { State: "human-gate", Gate: Q, Updated: NOW } });
    const before = readFileSync(ticketPath("99.6"), "utf8");

    ok("gate", "99.6", "open", "--question", Q, "--now", NOW);
    const id = gateId("99.6");
    assert.ok(isGateOccurrence(id), "the opening has an occurrence");
    assert.ok(readFileSync(ticketPath("99.6"), "utf8").startsWith(before.trimEnd()), "the old record is untouched");
    ok("gate", "99.6", "open", "--question", Q, "--now", NOW);
    assert.equal(gateId("99.6"), id, "a retry now reuses it");
    ok("gate", "99.6", "resolve", "--now", NOW);
    assert.deepEqual(
      gateMarkers("99.6").map((m) => [m.event, m.occurrence]),
      [["gate-opened", null], ["gate-opened", id], ["gate-resolved", id]],
    );
  });

  // --- state --set human-gate refuses what gate open refuses --------------------

  check("state --set human-gate refuses a different question while a gate is open", () => {
    ok("gate", "99.4", "open", "--question", "Q1?", "--now", NOW);
    const id = gateId("99.4");
    const markersBefore = gateMarkers("99.4");
    const viaState = orchestrate("state", "99.4", "--set", "human-gate", "--gate", "Q2?", "--now", NOW);
    assert.equal(viaState.status, 1, viaState.stderr);
    assert.match(viaState.stderr, /already at a human gate: Q1\?/);
    const viaGate = orchestrate("gate", "99.4", "open", "--question", "Q2?", "--now", NOW);
    assert.equal(viaGate.status, 1, "gate open refuses it too");
    assert.equal(stateField("99.4", "Gate"), "Q1?");
    assert.equal(gateId("99.4"), id, "the open occurrence is untouched");
    assert.deepEqual(gateMarkers("99.4"), markersBefore, "nothing posted");
  });

  check("state --set human-gate refuses a done or failed claim", () => {
    for (const final of ["done", "failed"]) {
      ok("state", "99.5", "--set", final, "--now", NOW);
      const viaState = orchestrate("state", "99.5", "--set", "human-gate", "--gate", Q, "--now", NOW);
      assert.equal(viaState.status, 1, viaState.stderr);
      assert.match(viaState.stderr, new RegExp(`is ${final}; a gate stops a worker`));
      assert.equal(orchestrate("gate", "99.5", "open", "--question", Q, "--now", NOW).status, 1, "gate open refuses it too");
      assert.equal(stateField("99.5", "State"), final);
      assert.equal(gateId("99.5"), null);
      assert.deepEqual(gateMarkers("99.5"), [], "no opened note on a finished claim");
    }
  });

  // --- leaving a gate through state ---------------------------------------------

  check("leaving a gate through state writes the resolved marker of its occurrence, with no decision", () => {
    const id = gateId("99.4"); // Q1?, opened above
    ok("state", "99.4", "--set", "review", "--now", NOW);
    assert.deepEqual(
      gateMarkers("99.4").map((m) => [m.event, m.digest, m.occurrence]),
      [["gate-opened", D("Q1?"), id], ["gate-resolved", D("Q1?"), id]],
    );
    const text = readFileSync(ticketPath("99.4"), "utf8");
    assert.match(text, /\*\*Human gate closed\*\* on 2026-11-12 by a state change: worker `99\.4` was set to `review`\. No decision was recorded\./);
    assert.ok(!/Decision:/.test(text), "no invented decision");
    assert.equal(gateId("99.4"), null);
    assert.equal(stateField("99.4", "Gate"), null);
    ok("state", "99.4", "--set", "working", "--now", NOW);
    assert.equal(gateMarkers("99.4").length, 2, "no gate open, nothing more to close");

    // A gate with no occurrence (set by hand) has none to close: nothing posted.
    updateStateFile(local("99.4").worktree, { set: { State: "human-gate", Gate: "By hand?", Updated: NOW } });
    ok("state", "99.4", "--set", "working", "--now", NOW);
    assert.equal(gateMarkers("99.4").length, 2);
  });

  // --- retry hints ----------------------------------------------------------------

  check("each path's retry hint names that same path, and the retry reuses the occurrence", () => {
    const file = ticketPath("99.7");
    const hidden = `${file}.away`;
    const failing = (...args) => {
      renameSync(file, hidden); // the store cannot be read: the note fails
      try {
        const result = orchestrate(...args);
        assert.equal(result.status, 1, result.stderr);
        return result.stderr;
      } finally {
        renameSync(hidden, file);
      }
    };

    // state --set human-gate: retry by state, never by gate open (which would
    // also add the label this path leaves alone).
    const viaState = failing("state", "99.7", "--set", "human-gate", "--gate", Q, "--now", NOW);
    assert.match(viaState, /Retry with: orchestrate state 99\.7 --set human-gate --gate "<the same question>"/);
    assert.ok(!/orchestrate gate 99\.7 open/.test(viaState), viaState);
    const id = gateId("99.7");
    assert.ok(isGateOccurrence(id));
    ok("state", "99.7", "--set", "human-gate", "--gate", Q, "--now", NOW);
    assert.equal(gateId("99.7"), id);
    assert.deepEqual(gateMarkers("99.7").map((m) => [m.event, m.occurrence]), [["gate-opened", id]]);

    // Closing through state: the gate stays open and the same command retries.
    const closing = failing("state", "99.7", "--set", "working", "--now", NOW);
    assert.match(closing, /Retry with: orchestrate state 99\.7 --set working/);
    assert.equal(gateId("99.7"), id, "still at its gate");
    ok("state", "99.7", "--set", "working", "--now", NOW);
    assert.deepEqual(gateMarkers("99.7").map((m) => [m.event, m.occurrence]), [["gate-opened", id], ["gate-resolved", id]]);

    // gate open keeps its own hint.
    const viaGate = failing("gate", "99.7", "open", "--question", "Again?", "--now", NOW);
    assert.match(viaGate, /Retry with: orchestrate gate 99\.7 open --question "<the same question>"/);
  });

  // --- a refused state change writes nothing --------------------------------------

  const refusedThenAnswered = (key, refusedArgs) => {
    ok("gate", key, "open", "--question", Q, "--now", NOW);
    const id = gateId(key);
    assert.ok(isGateOccurrence(id));
    const ticketBefore = readFileSync(ticketPath(key), "utf8");
    const stateBefore = readFileSync(statePath(key), "utf8");

    const refused = orchestrate("state", key, ...refusedArgs, "--now", NOW);
    assert.notEqual(refused.status, 0, `state ${refusedArgs.join(" ")} is refused`);
    assert.equal(readFileSync(ticketPath(key), "utf8"), ticketBefore, "the store is byte-identical: no false closing");
    assert.equal(readFileSync(statePath(key), "utf8"), stateBefore, "the state file is byte-identical");

    ok("gate", key, "resolve", "--answer", "Yes, approved", "--now", NOW);
    assert.deepEqual(
      gateMarkers(key).map((m) => [m.event, m.digest, m.occurrence]),
      [["gate-opened", D(Q), id], ["gate-resolved", D(Q), id]],
    );
    const text = readFileSync(ticketPath(key), "utf8");
    assert.match(text, /\*\*Human gate resolved\*\* on 2026-11-12\. Worker `[^`]+` resumes\.\n\nDecision:\n\n> Yes, approved/, "the human's decision is recorded");
    assert.ok(!/Human gate closed/.test(text), "no state-change closing was written");
    assert.equal(gateId(key), null);
    assert.equal(stateField(key, "State"), "working");
  };

  check("a refused unknown state leaves every gate record unchanged, and the later answer is recorded", () => {
    refusedThenAnswered("99.8", ["--set", "wroking"]);
  });

  check("a refused blank --last leaves every gate record unchanged, and the later answer is recorded", () => {
    refusedThenAnswered("99.9", ["--set", "working", "--last", " "]);
  });

  // --- read-only commands -----------------------------------------------------

  check("status, plan, board and check still answer --json on the scratch store", () => {
    const status = JSON.parse(ok("status", "--json").stdout);
    assert.equal(status.rows.find((row) => row.key === "99.3").state, "human-gate");
    JSON.parse(ok("plan", "--json").stdout);
    JSON.parse(ok("board", "--json").stdout);
    ok("state", "99.2", "--set", "done", "--now", NOW);
    const checked = orchestrate("check", "99.2", "--json");
    assert.ok([0, 1].includes(checked.status), checked.stderr);
    if (checked.status === 0) JSON.parse(checked.stdout);
  });

  console.log(`\n${passed} checks passed`);
} finally {
  // Worktrees live inside the scratch root, so one removal takes everything.
  rmSync(root, { recursive: true, force: true });
}
