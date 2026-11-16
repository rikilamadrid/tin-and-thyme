// 09.3: production disk registry and snapshot, isolated copies only. No process or native harness is launched.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewRegistry } from "../server/crew";
import { FAMILY_POOLS, occurrenceLabel, type CrewSessionFacts } from "../src/data/crewContract";
import { crewBookProblems, crewHistoryProblems, crewSnapshotProblems } from "../src/data/fixture/crewFixture";

const root = mkdtempSync(join(tmpdir(), "tt-crew-registry-"));
const t = (n = 0) => new Date(Date.parse("2026-11-13T09:00:00.000Z") + n * 1000).toISOString();
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }
const dir = (name: string) => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const facts = (ticket: string, role = "developer", second = 0): CrewSessionFacts => ({ role, stage: role === "tester" ? "review" : "implementation", ticket, hqId: `hq-${ticket}`, transcript: `/isolated/${ticket}.jsonl`, startedAt: t(second) });
const ending = (n = 2) => ({ outcome: "handed-off" as const, at: t(n), next: "review", result: "DONE", verdict: "DONE" as const });
const fresh = (name: string) => { const r = new CrewRegistry(dir(name), name, t()); r.reconcile([], t()); return r; };

test("restore stays unpublished and unwritten until caller's completed reattach pass", () => {
  const r = new CrewRegistry(dir("startup"), "startup", t());
  r.restore("later", { ...facts("09.2", "developer", 2), phase: "live" }, t(3));
  r.start("early", facts("09.1", "developer", 1), t(3));
  assert.equal(r.snapshot(), undefined); r.save(); assert.equal(existsSync(join(r.directory, "crew-book.json")), false);
  r.reconcile(["later", "early"], t(4));
  assert.equal(r.book.sessions.early.characterId, "pepper"); assert.equal(r.book.sessions.later.characterId, "roux");
  assert.equal(r.book.restorePass, null); assert.deepEqual(crewBookProblems(r.book), []);
});

test("concurrent role variants, fresh reuse, truthful role/telemetry projection", () => {
  const r = fresh("reuse"); r.start("one", facts("01.1"), t()); r.start("two", facts("02.1"), t());
  assert.notEqual(r.book.sessions.one.characterId, r.book.sessions.two.characterId);
  r.observe("one", { session: "running", agent: "working", tools: 3, attention: null, at: t(1) }, { context: { used: 10, limit: 100 }, model: null, tokens: null, costUsd: null, tools: 3, at: t(1) });
  r.end("one", ending(), t(2)); const prior = structuredClone(r.book);
  r.start("new-conversation", facts("01.1", "engineer", 3), t(3));
  assert.equal(r.book.sessions["new-conversation"].characterId, "pepper");
  const snapshot = r.snapshot(Date.parse(t(3)))!; const pepper = snapshot.characters.find((c) => c.id === "pepper")!;
  assert.equal(pepper.sessionId, "new-conversation"); assert.equal(pepper.role, "engineer"); assert.equal(pepper.telemetry, null); assert.equal(pepper.lastOutcome, "handed-off");
  assert.deepEqual(crewHistoryProblems(prior, r.book), []); assert.deepEqual(crewSnapshotProblems(snapshot, r.book), []);
});

test("persistent ids survive reverse-order restart and overflow never acquires a freed robot", () => {
  const r = fresh("reverse");
  for (let n = 0; n <= FAMILY_POOLS.developer.length; n++) r.start(`dev-${n}`, facts(`01.${n}`, "developer", n), t(n));
  r.end("dev-0", ending(8), t(8)); r.save();
  const before = structuredClone(r.book); const next = new CrewRegistry(r.directory, "reverse", t(9));
  assert.ok(next.book.restorePass);
  for (const s of Object.values(before.sessions).reverse()) next.restore(s.id, { ...s, phase: s.phase }, t(9));
  next.reconcile(Object.values(before.sessions).filter((s) => s.phase === "live").map((s) => s.id), t(10));
  assert.equal(next.book.sessions["dev-6"].characterId, null);
  assert.deepEqual(crewHistoryProblems(before, next.book), []); assert.deepEqual(crewBookProblems(next.book), []);
});

test("restore never borrows an available character from another role family", () => {
  const r = new CrewRegistry(dir("families"), "families", t());
  for (let n = 4; n >= 0; n--) r.restore(`tester-${n}`, { ...facts(`02.${n}`, "tester", n), phase: "live" }, t(5));
  r.restore("dev", { ...facts("03.1"), phase: "live" }, t(5));
  r.reconcile(Object.keys(r.book.sessions), t(6));
  assert.equal(r.book.sessions["tester-4"].characterId, null); assert.equal(r.book.sessions.dev.characterId, "pepper");
});

test("missing transcript/parent ends retained session with unknown outcome", () => {
  const r = fresh("lost"); r.start("lost", facts("04.1"), t()); r.save();
  const next = new CrewRegistry(r.directory, "lost", t(5)); next.reconcile([], t(20));
  assert.equal(next.book.sessions.lost.phase, "ended"); assert.equal(next.book.sessions.lost.end, null);
  assert.equal(next.book.sessions.lost.transcript, "/isolated/04.1.jsonl");
  assert.equal(next.snapshot(Date.parse(t(30)))!.characters.find((c) => c.id === "pepper")!.telemetry, null);
});

test("migration backs up exact inputs, preserves verdict/occurrence/links and retries once", () => {
  const path = dir("migration");
  const legacy = { a: { id: "pepper", name: "Pepper", job: "Saucier" }, b: { id: "pepper", name: "Pepper 2", job: "Saucier" } };
  const ends = { a: { ...ending(), verdict: "PASS", key: "01.1", session: "review", occurrence: "gate-evidence" } };
  writeFileSync(join(path, "crew.json"), JSON.stringify(legacy)); writeFileSync(join(path, "sessions.json"), JSON.stringify(ends));
  writeFileSync(join(path, "coordinator.json"), '{"transcript":"/preserved/coordinator.jsonl"}');
  const r = new CrewRegistry(path, "migration", t(4));
  const backup = r.book.migrations[0].backup;
  for (const name of ["crew.json", "sessions.json", "coordinator.json"]) assert.equal(readFileSync(join(backup, name), "utf8"), readFileSync(join(path, name), "utf8"));
  assert.deepEqual(r.book.sessions.a.end, ends.a); assert.equal(r.book.sessions.a.ticket, "01.1"); assert.equal(r.book.sessions.a.stage, "review");
  r.restore("b", { ...facts("02.1"), phase: "live" }, t(4)); r.reconcile(["b"], t(5));
  const original = structuredClone(r.book); const next = new CrewRegistry(path, "migration", t(6));
  next.restore("b", { ...facts("02.1"), phase: "live" }, t(6)); next.reconcile(["b"], t(7));
  assert.equal(next.book.migrations.length, 1); assert.equal(readdirSync(join(path, "backups")).length, 1);
  assert.deepEqual(crewHistoryProblems(original, next.book), []);
  assert.equal(readFileSync(join(path, "crew.json"), "utf8"), JSON.stringify(legacy)); assert.equal(readFileSync(join(path, "sessions.json"), "utf8"), JSON.stringify(ends));
});

test("unknown versions and wrong kitchen remain read-only; corrupt file is recoverable", () => {
  const r = fresh("safety"); const file = join(r.directory, "crew-book.json");
  const newer = JSON.stringify({ ...r.book, version: 999 }); writeFileSync(file, newer);
  assert.throws(() => new CrewRegistry(r.directory, "safety", t(1)), /newer/); assert.equal(readFileSync(file, "utf8"), newer);
  const wrong = JSON.stringify({ ...r.book, kitchen: "other" }); writeFileSync(file, wrong);
  assert.throws(() => new CrewRegistry(r.directory, "safety", t(1)), /belongs/); assert.equal(readFileSync(file, "utf8"), wrong);
  writeFileSync(file, "{broken"); const repaired = new CrewRegistry(r.directory, "safety", t(2)); repaired.reconcile([], t(3));
  const backups = readdirSync(join(r.directory, "backups")); assert.equal(backups.length, 1); assert.equal(readFileSync(join(r.directory, "backups", backups[0]), "utf8"), "{broken");
});

test("projection keeps every character in catalogue order; available readings clear and stateSince stays stable", () => {
  const r = fresh("projection"); r.start("one", facts("01.1"), t()); r.end("one", ending(2), t(2));
  assert.equal(r.customize("dot", { name: "Dottie" }, t(3)), null);
  const a = r.snapshot(Date.parse(t(10)))!; const b = r.snapshot(Date.parse(t(11)))!;
  assert.deepEqual(a.characters.map((c) => c.id), ["pepper", "dot", "basil"]);
  assert.equal(a.characters[0].state, "available"); assert.equal(a.characters[0].stateSince, b.characters[0].stateSince);
  assert.equal(a.characters[0].sessionId, null); assert.equal(a.characters[0].role, null); assert.equal(a.characters[0].telemetry, null);
  assert.deepEqual(crewSnapshotProblems(a, r.book), []);
});

test("unreadable valid book fails closed without quarantine or replacement (M1)", () => {
  const r = fresh("unreadable"); r.start("retained", facts("09.3"), t()); r.save();
  const file = join(r.directory, "crew-book.json"); const original = readFileSync(file, "utf8");
  chmodSync(file, 0);
  try {
    // Exercise real filesystem denial; a privileged test runner must not silently claim this case passed.
    assert.throws(() => readFileSync(file, "utf8"), { code: "EACCES" }, "Run this permissions regression as an unprivileged user");
    assert.throws(() => new CrewRegistry(r.directory, "unreadable", t(1)), /Cannot read crew storage \(EACCES\).*crew-book\.json.*unchanged/);
    assert.equal(existsSync(file), true); assert.equal(existsSync(join(r.directory, "backups")), false);
  } finally { chmodSync(file, 0o600); }
  assert.equal(readFileSync(file, "utf8"), original);
  const recovered = new CrewRegistry(r.directory, "unreadable", t(2)); recovered.reconcile(["retained"], t(3));
  assert.equal(recovered.book.sessions.retained.ticket, "09.3"); assert.equal(recovered.book.sessions.retained.phase, "live");
});

test("malformed legacy entries fail before touching existing history or source bytes (M2)", () => {
  const cases: { file: "crew.json" | "sessions.json"; value: unknown; reason: RegExp }[] = [
    { file: "sessions.json", value: { ...ending(), outcome: "bogus" }, reason: /outcome/ },
    { file: "sessions.json", value: { ...ending(), at: "not-a-time" }, reason: /at must/ },
    { file: "sessions.json", value: { ...ending(), at: null }, reason: /at must/ },
    { file: "sessions.json", value: { ...ending(), next: [] }, reason: /next must/ },
    { file: "sessions.json", value: { ...ending(), result: {} }, reason: /result must/ },
    { file: "sessions.json", value: { ...ending(), verdict: "MAYBE" }, reason: /verdict/ },
    { file: "sessions.json", value: { ...ending(), occurrence: false }, reason: /occurrence must/ },
    { file: "sessions.json", value: null, reason: /object/ },
    { file: "crew.json", value: { id: "pepper", name: "Pepper" }, reason: /id, name and job/ },
    { file: "crew.json", value: { id: 2, name: "Pepper", job: "Saucier" }, reason: /id, name and job/ },
  ];
  for (const [index, bad] of cases.entries()) {
    const r = fresh(`invalid-${index}`); r.start("retained", facts("09.3"), t()); r.save();
    const file = join(r.directory, "crew-book.json"); const before = readFileSync(file, "utf8");
    const legacy = join(r.directory, bad.file); const bytes = JSON.stringify({ old: bad.value }); writeFileSync(legacy, bytes);
    assert.throws(() => new CrewRegistry(r.directory, r.kitchen, t(2)), (error: unknown) => error instanceof Error && error.message.includes(legacy) && error.message.includes('"old"') && bad.reason.test(error.message));
    assert.equal(readFileSync(file, "utf8"), before); assert.equal(readFileSync(legacy, "utf8"), bytes);
    assert.equal(existsSync(join(r.directory, "backups")), false);
    // Even a corrupt active file is not moved before all legacy inputs have validated.
    writeFileSync(file, "{corrupt"); assert.throws(() => new CrewRegistry(r.directory, r.kitchen, t(3)), bad.reason);
    assert.equal(readFileSync(file, "utf8"), "{corrupt"); assert.equal(existsSync(join(r.directory, "backups")), false);
  }
  const path = dir("invalid-first-start"); const legacy = join(path, "sessions.json");
  writeFileSync(legacy, JSON.stringify({ old: { outcome: "bogus", at: t() } }));
  assert.throws(() => new CrewRegistry(path, "invalid-first-start", t()), /outcome/);
  assert.equal(existsSync(join(path, "crew-book.json")), false); assert.equal(existsSync(join(path, "backups")), false);
});

test("validated migration reloads and retains post-migration sessions; save refuses invalid endings (M2)", () => {
  const path = dir("valid-reload");
  // Older versions omitted next/result; they become null while all other metadata survives.
  writeFileSync(join(path, "sessions.json"), JSON.stringify({ old: { outcome: "handed-off", at: t(), verdict: "PASS", extraEvidence: { source: "legacy" } } }));
  const r = new CrewRegistry(path, "valid-reload", t(1)); r.reconcile([], t(2));
  assert.equal(r.book.sessions.old.end?.next, null); assert.equal(r.book.sessions.old.end?.result, null);
  r.start("post-migration", facts("09.3"), t(3)); r.save(); const before = structuredClone(r.book);
  const next = new CrewRegistry(path, "valid-reload", t(4)); next.reconcile(["post-migration"], t(5));
  assert.deepEqual(crewHistoryProblems(before, next.book), []); assert.deepEqual(Object.keys(next.book.sessions).sort(), ["old", "post-migration"]);
  assert.equal(readdirSync(join(path, "backups")).length, 1);
  const file = join(path, "crew-book.json"); const bytes = readFileSync(file, "utf8");
  next.book.sessions.old.end = { ...ending(), outcome: "bogus" } as never;
  assert.throws(() => next.save(), /Refusing to persist an invalid crew book/); assert.equal(readFileSync(file, "utf8"), bytes);
});

test("filling unknown ending keeps all verdict/gate metadata and never overwrites a known outcome (M3)", () => {
  const r = fresh("fill-ending"); r.start("unknown", facts("09.3", "tester"), t()); r.end("unknown", null, t(1));
  r.start("known", facts("09.4"), t()); r.end("known", ending(1), t(1)); r.save();
  const known = structuredClone(r.book.sessions.known.end);
  const full = { ...ending(2), verdict: "PASS", key: "09.3", session: "review", occurrence: "recorded-gate", consumed: "yes", extraEvidence: { terminal: "record-id" } };
  writeFileSync(join(r.directory, "sessions.json"), JSON.stringify({ unknown: full, known: { ...full, verdict: "FAILED" } }));
  const next = new CrewRegistry(r.directory, r.kitchen, t(3)); next.reconcile([], t(4));
  assert.deepEqual(next.book.sessions.unknown.end, full); assert.equal(next.book.sessions.unknown.endedAt, t(1));
  assert.deepEqual(next.book.sessions.known.end, known);
  const again = new CrewRegistry(r.directory, r.kitchen, t(5)); again.reconcile([], t(6));
  assert.deepEqual(again.book.sessions.unknown.end, full); assert.deepEqual(again.book.sessions.known.end, known);
  assert.equal(again.book.migrations.length, next.book.migrations.length);
  assert.deepEqual(crewHistoryProblems(next.book, again.book), []);
});

// ---- Linked continuations (human decision 2026-11-16): the Claude conversation id and the occurrence id are kept apart.
const convo = (r: CrewRegistry, id: string) => Object.values(r.book.sessions).filter((s) => s.conversation === id).sort((a, b) => a.seq - b.seq);

test("resume: a new linked occurrence, same conversation and robot; the ended one keeps its outcome", () => {
  const r = fresh("resume"); r.start("conv", facts("05.1"), t()); const robot = r.book.sessions.conv.characterId;
  r.observe("conv", { session: "running", agent: "working", tools: 2, attention: null, at: t(1) }, { context: { used: 5, limit: 100 }, model: null, tokens: null, costUsd: null, tools: 2, at: t(1) });
  r.end("conv", { ...ending(2), key: "05.1", session: "implementation" }, t(2)); r.save();
  const ended = structuredClone(r.book.sessions.conv); const before = structuredClone(r.book);
  const next = r.resume("conv", { via: "tool", evidence: "toolu_resume_1" }, t(5))!;
  assert.equal(next.id, "conv#2"); assert.equal(next.conversation, "conv"); assert.deepEqual(next.continuation, { of: "conv", via: "tool", evidence: "toolu_resume_1" });
  assert.equal(occurrenceLabel(next), "same conversation"); assert.equal(occurrenceLabel(r.book.sessions.conv), "new conversation");
  assert.equal(next.phase, "live"); assert.equal(next.characterId, robot); assert.equal(next.end, null); assert.equal(next.telemetry, null); assert.equal(next.startedAt, t(5));
  for (const f of ["hqId", "role", "stage", "ticket", "transcript", "kind", "family"] as const) assert.equal(next[f], ended[f]);
  assert.deepEqual(r.book.sessions.conv, ended, "the ended occurrence is untouched");
  assert.deepEqual(crewHistoryProblems(before, r.book), []); assert.deepEqual(crewBookProblems(r.book), []);
  const snap = r.snapshot(Date.parse(t(5)))!;
  assert.deepEqual(snap.current.map((s) => s.id), ["conv#2"]); assert.deepEqual(snap.history.map((s) => [s.id, s.end?.outcome]), [["conv", "handed-off"]]);
  assert.equal(snap.characters.find((c) => c.id === robot)!.sessionId, "conv#2"); assert.deepEqual(crewSnapshotProblems(snap, r.book), []);
  assert.equal(r.resume("never-seen", { via: "hook", evidence: null }, t(5)), null, "an unknown conversation is not a continuation");
});

test("repeated resume and duplicate events add no record; a later genuine resume adds exactly one", () => {
  const r = fresh("repeat"); r.start("conv", facts("05.1"), t()); r.end("conv", ending(2), t(2));
  r.resume("conv", { via: "tool", evidence: "toolu_a" }, t(3));
  // The same resume again, by the same evidence, by other evidence and by a bare hook, while it runs: all the live occurrence.
  for (const again of [{ via: "tool", evidence: "toolu_a" }, { via: "transcript", evidence: "rev-9" }, { via: "hook", evidence: null }] as const)
    assert.equal(r.resume("conv", again, t(4))!.id, "conv#2");
  assert.equal(r.restore("conv", { ...facts("05.1"), phase: "live" }, t(4)).id, "conv#2"); assert.equal(r.start("conv", facts("05.1"), t(4)).id, "conv");
  assert.deepEqual(convo(r, "conv").map((s) => s.id), ["conv", "conv#2"]);
  r.end("conv#2", { ...ending(6), verdict: "PASS" }, t(6)); const settled = structuredClone(r.book);
  // A late duplicate of the event that opened #2 arrives after #2 ended: that occurrence, unchanged, never a #3 and never live.
  const late = r.resume("conv", { via: "tool", evidence: "toolu_a" }, t(7))!;
  assert.equal(late.id, "conv#2"); assert.equal(late.phase, "ended"); assert.deepEqual(r.book.sessions, settled.sessions);
  // Ending again, or with another outcome, never rewrites a recorded outcome.
  r.end("conv#2", { ...ending(8), outcome: "failed", verdict: "FAILED" }, t(8)); r.end("conv", null, t(8));
  assert.deepEqual(r.book.sessions, settled.sessions);
  const third = r.resume("conv", { via: "transcript", evidence: "terminal:123:abc" }, t(9))!;
  assert.equal(third.id, "conv#3"); assert.equal(third.continuation!.of, "conv#2");
  assert.equal(r.resume("conv", { via: "transcript", evidence: "terminal:123:abc" }, t(10))!.id, "conv#3");
  assert.deepEqual(convo(r, "conv").map((s) => [s.id, s.phase, s.end?.verdict ?? null]), [["conv", "ended", "DONE"], ["conv#2", "ended", "PASS"], ["conv#3", "live", null]]);
  assert.deepEqual(crewHistoryProblems(settled, r.book), []); assert.deepEqual(crewBookProblems(r.book), []);
});

test("a resume never holds two robots, and takes another only when its own is worn", () => {
  const r = fresh("robots"); r.start("a", facts("05.1"), t()); r.end("a", ending(1), t(1));
  r.start("b", facts("05.1", "developer", 2), t(2)); // a fresh session on the same ticket takes the free robot first
  assert.equal(r.book.sessions.b.characterId, "pepper");
  const again = r.resume("a", { via: "hook", evidence: null }, t(3))!;
  assert.equal(again.characterId, "roux", "its robot is worn by b, so the ordinary rules pick the next free one");
  const worn = Object.values(r.book.sessions).filter((s) => s.phase === "live").map((s) => s.characterId);
  assert.deepEqual(worn.sort(), ["pepper", "roux"]); assert.equal(new Set(worn).size, worn.length);
  assert.equal(convo(r, "a").filter((s) => s.phase === "live").length, 1); assert.deepEqual(crewBookProblems(r.book), []);
  // An overflow conversation that resumes still gets at most one robot, and only a free one of its own family.
  const o = fresh("robots-overflow");
  for (let n = 0; n <= FAMILY_POOLS.developer.length; n++) o.start(`dev-${n}`, facts(`01.${n}`, "developer", n), t(n));
  assert.equal(o.book.sessions["dev-6"].characterId, null);
  o.end("dev-6", ending(8), t(8)); assert.equal(o.resume("dev-6", { via: "hook", evidence: null }, t(9))!.characterId, null);
  assert.deepEqual(o.snapshot(Date.parse(t(9)))!.overflow, ["dev-6#2"]); assert.deepEqual(crewBookProblems(o.book), []);
});

test("restart recovery: the chain survives, restore revives nothing and reprocessing after restart adds nothing", () => {
  const r = fresh("restart-chain"); r.start("conv", facts("05.1"), t()); r.end("conv", { ...ending(2), key: "05.1" }, t(2));
  r.resume("conv", { via: "tool", evidence: "toolu_a" }, t(3)); r.start("other", facts("06.1", "tester"), t(3)); r.save();
  const before = structuredClone(r.book);
  const next = new CrewRegistry(r.directory, r.kitchen, t(10));
  // The transcript restore names the conversation, in reverse order; hooks from before the restart are delivered again.
  next.restore("other", { ...facts("06.1", "tester"), phase: "live" }, t(10)); next.restore("conv", { ...facts("05.1"), phase: "live" }, t(10));
  assert.equal(next.resume("conv", { via: "tool", evidence: "toolu_a" }, t(10))!.id, "conv#2"); assert.equal(next.resume("conv", { via: "hook", evidence: null }, t(10))!.id, "conv#2");
  next.reconcile(["conv#2", "other"], t(11));
  assert.deepEqual(Object.keys(next.book.sessions).sort(), ["conv", "conv#2", "other"]); assert.equal(next.book.sessions["conv#2"].characterId, before.sessions["conv#2"].characterId);
  assert.deepEqual(next.lastEnding("conv"), { ...ending(2), key: "05.1" });
  assert.deepEqual(crewHistoryProblems(before, next.book), []); assert.deepEqual(crewBookProblems(next.book), []);
  // The next start finds the conversation's transcript finished: its live occurrence ends; the first one is not touched.
  const later = new CrewRegistry(r.directory, r.kitchen, t(20)); later.restore("conv", { ...facts("05.1"), phase: "ended" }, t(20)); later.reconcile(["other"], t(21));
  assert.deepEqual(convo(later, "conv").map((s) => [s.id, s.phase, s.end?.outcome ?? null]), [["conv", "ended", "handed-off"], ["conv#2", "ended", null]]);
  // A restart that only finds the transcript unfinished is no evidence of a resume: nothing is revived or added.
  const idle = new CrewRegistry(r.directory, r.kitchen, t(30)); idle.restore("conv", { ...facts("05.1"), phase: "live" }, t(30)); idle.reconcile(["other"], t(31));
  assert.deepEqual(convo(idle, "conv").map((s) => [s.id, s.phase]), [["conv", "ended"], ["conv#2", "ended"]]); assert.deepEqual(crewHistoryProblems(later.book, idle.book), []);
});

test("a resume seen during the restore pass waits for reconcile and gets its own robot back", () => {
  const r = fresh("pass-resume"); r.start("busy", facts("05.2"), t()); r.start("conv", facts("05.1", "developer", 1), t(1)); r.end("conv", ending(2), t(2)); r.save();
  assert.equal(r.book.sessions.conv.characterId, "roux");
  const next = new CrewRegistry(r.directory, r.kitchen, t(10));
  const s = next.resume("conv", { via: "tool", evidence: "toolu_b" }, t(10))!;
  assert.equal(s.characterId, null, "nothing is allocated while the pass is open"); assert.equal(next.resume("conv", { via: "tool", evidence: "toolu_b" }, t(10))!.id, s.id);
  next.restore("fresh", { ...facts("05.9", "developer", 9), phase: "live" }, t(10));
  next.reconcile([s.id, "busy", "fresh"], t(11));
  // `fresh` is older and would be handed roux first in pool order; the continuation still gets its own robot back.
  assert.equal(next.book.sessions.busy.characterId, "pepper"); assert.equal(next.book.sessions["conv#2"].characterId, "roux"); assert.equal(next.book.sessions.fresh.characterId, "ember");
  assert.deepEqual(crewBookProblems(next.book), []);
});

test("a book written before occurrences reads unchanged; a broken link is refused, not repaired", () => {
  const r = fresh("old-book"); r.start("conv", facts("05.1"), t()); r.end("conv", ending(2), t(2)); r.save();
  const file = join(r.directory, "crew-book.json"); const book = JSON.parse(readFileSync(file, "utf8"));
  for (const s of Object.values(book.sessions) as Record<string, unknown>[]) { delete s.conversation; delete s.continuation; }
  writeFileSync(file, JSON.stringify(book));
  const next = new CrewRegistry(r.directory, r.kitchen, t(5)); next.reconcile([], t(6));
  assert.equal(next.book.sessions.conv.conversation, "conv"); assert.equal(next.book.sessions.conv.continuation, null); assert.equal(existsSync(join(r.directory, "backups")), false);
  assert.equal(next.resume("conv", { via: "hook", evidence: null }, t(7))!.id, "conv#2"); next.save();
  const linked = JSON.parse(readFileSync(file, "utf8")); linked.sessions["conv#2"].continuation.of = "missing"; writeFileSync(file, JSON.stringify(linked));
  const repaired = new CrewRegistry(r.directory, r.kitchen, t(8)); repaired.reconcile([], t(9));
  assert.equal(readdirSync(join(r.directory, "backups")).filter((f) => f.startsWith("crew-book.corrupt-")).length, 1, "an invalid book is quarantined, never overwritten");
});

// Optional evidence from a real kitchen's frozen legacy inputs. Read-only source; all mutation is in temp.
const source = process.env.CREW_LEGACY_COPY_SOURCE;
if (source) test("read-only copy of real legacy files is lossless and idempotent", () => {
  const path = dir("real-copy"); const bytes: Record<string, string> = {};
  for (const name of ["crew.json", "sessions.json", "coordinator.json"]) if (existsSync(join(source, name))) {
    bytes[name] = readFileSync(join(source, name), "utf8"); copyFileSync(join(source, name), join(path, name));
  }
  const r = new CrewRegistry(path, "real-copy", t()); r.reconcile([], t(20));
  const crew = JSON.parse(bytes["crew.json"] ?? "{}"); const ends = JSON.parse(bytes["sessions.json"] ?? "{}");
  assert.deepEqual(Object.keys(r.book.sessions).sort(), [...new Set([...Object.keys(crew), ...Object.keys(ends)])].sort());
  for (const [id, end] of Object.entries(ends)) assert.deepEqual(r.book.sessions[id].end, end);
  const before = structuredClone(r.book); const next = new CrewRegistry(path, "real-copy", t(30)); next.reconcile([], t(31));
  assert.deepEqual(crewHistoryProblems(before, next.book), []); assert.equal(next.book.migrations.length, before.migrations.length);
  for (const [name, text] of Object.entries(bytes)) assert.equal(readFileSync(join(source, name), "utf8"), text);
});
console.log(`${passed} registry scenarios passed; artifacts: ${root}`);
