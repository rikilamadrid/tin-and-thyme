# Project History

Compact record of completed work.

## Completed

### 2026-11-13 — Feature 10: In-App Ticket Delivery

- Outcome: Exact-head delivery approval, merge verification, labelled preview, safe local-main reconciliation, idempotent coordinator handback, constrained completion-records PRs and refreshed board/dispatch state. All five Feature 10 tickets are Complete.
- Verification: Final independent PASS on `f7656bf`; repaired production wiring reproduced eight failures before the fix and passed 32 checks afterward. Developer combined checks passed after-merge 508, attention 432, UI 311, summary 11, fresh-context 16, typecheck/build. Final implementation merge tree equals the reviewed tree. GitHub CI did not run.
- Commit/PR: PR #21 (`c674c1e`), following the earlier delivery/preview increments; [final review](reviews/10.3-review-f7656bf.md). The old `9281359` approval was superseded by explicit approval of repaired head `f7656bf`.
- Follow-up: Live delivery activation, real GitHub-to-coordinator handback and native sessions/harnesses were not tested. Claude handoff → clear → READY remains blocked by account limits; Codex `/new`, native hook timing and clipboard paste remain unverified. Saved handoffs and visible refusal on unconfirmed resets remain required; no automatic continuation or rollback is claimed. Preserve the unadopted 10.5 timeout/cache/polling draft (only its stale-readiness refusal was adopted) and assign the preview banner overlap noted in 10.3. Live kitchen activation and credential changes remain prohibited.

### 2026-11-13 — Feature 03: Agent Context Tools

- Outcome: Agent-written summaries with Copy and a guarded handoff → clear → orientation flow for idle interactive agents; Pathfinder workflow workers keep their existing checkpoint flow. Human accepted delivery with the native-verification limitations below.
- Verification: Independent reviews and automated checks passed for 03.1 (`cc0f577`) and 03.2 (`a6ce346`); 03.2 passed 16 fresh-context scenarios, 11 summary regressions, five independent probes, typecheck and developer build. Merged-tree equality verified. GitHub CI did not run.
- Commit/PR: PR #23 (`91a4686`) and PR #25 (`ad29f29`).
- Follow-up: Native Claude handoff → clear → READY was blocked by account limits and remains unverified. Codex /new compatibility, native hook/Stop timing, agent-authored status accuracy, and actual summary clipboard paste remain unverified. Automated guards require a fresh saved handoff before reset and stop visibly on unconfirmed clearing; they do not establish native compatibility or rollback a reset already performed. Live kitchen activation remains separate.

### 2026-11-13 — Feature 01: Kitchen Polish

- Outcome: Taller kitchen with more station spacing; saved native-agent colours update robot accents, tags, roster chips and portraits together.
- Verification: Independent PASS for 01.1 (`61cd56e`) and 01.2 (`458ea27`); local typecheck/build and relevant checks passed on integration candidates, with merged-tree equality verified. GitHub reported no CI checks. 01.2 persistence was exercised in a fresh process; no complete live server restart was tested.
- Commit/PR: PR #8 (`7e5a02f`) and PR #20 (`a393e23`).
- Follow-up: Pathfinder character colour overrides still require the existing product decision. Activation of the merged build is separate; :7420 was not restarted.

### 2026-11-13 — Feature 05: Run Policy Repair

- Outcome: `A configurable run policy (command guardrails, not a security boundary) for orchestration sessions, set with "tin-and-thyme policy"; local-only stays the default and github-dev is not activated. The project overview and the Feature 08 credential-separation record are in the repository.`
- Verification: `Independent tester PASS on 64962bf (05.1) and df080b1 (05.2); typecheck, build and scripts/run-policy-test.ts (177 blocked / 32 known bypass / 56 allowed) passed locally on the PR head. GitHub Actions is disabled, so no CI ran.`
- Commit/PR: `PR #4 (53807ae), PR #5 (7e945fc)`
- Follow-up: `github-dev must not be relied on before credential separation (Feature 08, Proposed). ci.yml does not run scripts/run-policy-test.ts. Feature 08's pointer to the 05.1 branch is stale now that 05.1 has merged.`
