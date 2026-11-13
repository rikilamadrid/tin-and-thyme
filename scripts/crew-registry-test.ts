// 09.3: production disk registry and snapshot, isolated copies only. No process or native harness is launched.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewRegistry } from "../server/crew";
import { FAMILY_POOLS, type CrewSessionFacts } from "../src/data/crewContract";
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
