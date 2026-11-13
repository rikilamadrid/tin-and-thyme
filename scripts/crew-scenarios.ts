// Runs the Feature 09 crew lifecycle scenarios (src/data/fixture/crewFixture.ts) against the crew
// contract (src/data/crewContract.ts, docs/crew-contract.md).
//
//   pnpm exec tsx scripts/crew-scenarios.ts          run every scenario
//   pnpm exec tsx scripts/crew-scenarios.ts --list   list them without running
//
// Results are reported in three separate sections, as Feature 09 asks: FIXTURE, LIVE and MOCK.
// This runner produces fixture results only. The live section lists what 09.8 still has to run and
// never counts a fixture result as live. Exit code 1 when a check fails, when the self-check can't
// make the invariant checks fail, or when a fixture acceptance item has no scenario.

import {
  CREW_FIXTURE_ACCEPTANCE, CREW_FIXTURE_LABEL, CREW_LIVE_ACCEPTANCE, CREW_SCENARIOS, crewHarnessSelfCheck,
  type CrewAcceptanceId, type CrewCheck, type CrewEvidence,
} from "../src/data/fixture/crewFixture";

interface Result {
  id: string;
  title: string;
  evidence: CrewEvidence;
  checks: CrewCheck[];
  notCovered: string[];
}

const listOnly = process.argv.includes("--list");
const tag = (e: CrewEvidence) => `[${e}]`;
const failedIn = (checks: CrewCheck[]) => checks.filter((c) => !c.ok).length;

function printChecks(checks: CrewCheck[]) {
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.label}${c.ok || !c.detail ? "" : `\n       ${c.detail}`}`);
}

console.log(`Crew lifecycle scenarios · Feature 09 · ${CREW_FIXTURE_LABEL}`);
console.log("Fixture data only: no server, transcript or ~/.controlroom file is read.\n");

if (listOnly) {
  for (const s of CREW_SCENARIOS) console.log(`${tag(s.evidence)} ${s.id} — ${s.title}`);
  for (const l of CREW_LIVE_ACCEPTANCE) console.log(`[live] ${l.id} — ${l.text} (not run here: ${l.owner})`);
  process.exit(0);
}

console.log("Self-check: each invariant check must fail on data broken on purpose");
let selfCheck: CrewCheck[];
try {
  selfCheck = crewHarnessSelfCheck();
} catch (e) {
  selfCheck = [{ label: "self-check ran", ok: false, detail: `threw: ${(e as Error).message}` }];
}
printChecks(selfCheck);

const results: Result[] = [];
for (const s of CREW_SCENARIOS) {
  let checks: CrewCheck[];
  let notCovered: string[] = [];
  try {
    ({ checks, notCovered } = s.run());
  } catch (e) {
    checks = [{ label: "scenario ran to the end", ok: false, detail: `threw: ${(e as Error).stack ?? (e as Error).message}` }];
  }
  if (!checks.length) checks = [{ label: "scenario asserts something", ok: false, detail: "no checks" }];
  results.push({ id: s.id, title: s.title, evidence: s.evidence, checks, notCovered });
}

const fixture = results.filter((r) => r.evidence === "fixture");
const live = results.filter((r) => r.evidence === "live");
const mock = results.filter((r) => r.evidence === "mock");

console.log("\n================ FIXTURE results ================");
for (const r of fixture) {
  const s = CREW_SCENARIOS.find((x) => x.id === r.id)!;
  const bad = failedIn(r.checks);
  console.log(`\n${tag(r.evidence)} ${r.id} — ${r.title} · ${bad ? `FAILED ${bad} of ${r.checks.length}` : `${r.checks.length} checks passed`}`);
  for (const a of s.covers) console.log(`  acceptance: ${CREW_FIXTURE_ACCEPTANCE[a]}`);
  if (s.fixtureOnlyFamilies.length) console.log(`  fixture-only here: ${s.fixtureOnlyFamilies.join(", ")} (this kit has no such role or stage, so no live run can show it)`);
  printChecks(r.checks);
  for (const n of r.notCovered) console.log(`  not covered: ${n}`);
}

console.log("\n================ LIVE results ================");
if (live.length) for (const r of live) console.log(`${tag(r.evidence)} ${r.id} — ${r.title}`);
else console.log("None. This runner makes no live run.");
for (const l of CREW_LIVE_ACCEPTANCE) console.log(`  not run: ${l.id} — ${l.text} (${l.owner})`);

console.log("\n================ MOCK results ================");
console.log(mock.length ? mock.map((r) => `${tag(r.evidence)} ${r.id} — ${r.title}`).join("\n") : "None. This runner uses no mock data source.");

const uncovered = (Object.keys(CREW_FIXTURE_ACCEPTANCE) as CrewAcceptanceId[]).filter((a) => !CREW_SCENARIOS.some((s) => s.covers.includes(a)));
const failedScenarios = fixture.filter((r) => failedIn(r.checks));
const checks = fixture.reduce((n, r) => n + r.checks.length, 0);
const failedChecks = fixture.reduce((n, r) => n + failedIn(r.checks), 0);
const selfFailed = failedIn(selfCheck);
const openItems = fixture.reduce((n, r) => n + r.notCovered.length, 0);

console.log("\n================ Summary ================");
console.log(`fixture: ${fixture.length - failedScenarios.length}/${fixture.length} scenarios passed · ${checks - failedChecks}/${checks} checks`);
console.log(`live:    0 run · ${CREW_LIVE_ACCEPTANCE.length} not run`);
console.log(`mock:    ${mock.length} run`);
console.log(`self-check: ${selfCheck.length - selfFailed}/${selfCheck.length} broken cases caught`);
console.log(`not covered by any fixture check: ${openItems} items, listed above under their scenarios`);
for (const a of uncovered) console.log(`NO SCENARIO for acceptance item: ${CREW_FIXTURE_ACCEPTANCE[a]}`);
for (const r of failedScenarios) console.log(`FAILED ${tag(r.evidence)} ${r.id}`);
if (failedScenarios.length || selfFailed || uncovered.length) process.exit(1);
