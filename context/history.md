# Project History

Compact record of completed work.

## Completed

### 2026-11-13 — Feature 05: Run Policy Repair

- Outcome: `A configurable run policy (command guardrails, not a security boundary) for orchestration sessions, set with "tin-and-thyme policy"; local-only stays the default and github-dev is not activated. The project overview and the Feature 08 credential-separation record are in the repository.`
- Verification: `Independent tester PASS on 64962bf (05.1) and df080b1 (05.2); typecheck, build and scripts/run-policy-test.ts (177 blocked / 32 known bypass / 56 allowed) passed locally on the PR head. GitHub Actions is disabled, so no CI ran.`
- Commit/PR: `PR #4 (53807ae), PR #5 (7e945fc)`
- Follow-up: `github-dev must not be relied on before credential separation (Feature 08, Proposed). ci.yml does not run scripts/run-policy-test.ts. Feature 08's pointer to the 05.1 branch is stale now that 05.1 has merged.`
