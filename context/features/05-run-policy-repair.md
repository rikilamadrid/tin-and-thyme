# Run Policy Repair

## Status

Complete

## Goal

Tin & Thyme's configurable coordinator run policy (`local-only` default, `github-dev` for one
repository) becomes a reviewable local commit. What it enforces is tested, and what it does not
enforce is stated plainly.

## Context

- Read: `context/handoff.md` (sections "Changed files", "Verification", "Known policy gaps").
- Draft to adopt: an uncommitted change written by the coordinator session (which should not have
  implemented it), transferred as a bundle at
  `~/.controlroom/tin-and-thyme-c6df7995/transfer/05.1/` (files + `manifest.sha256` + `diff.patch`).
- Relevant area: `server/runPolicy.ts`, `server/runPolicyGuard.ts`, `server/pathfinder.ts`
  (`runPolicyGuard`, `hookSettingsFile`), `server/kitchen.ts`, `bin/tin-and-thyme.mjs`,
  `scripts/build-server.mjs`, `scripts/run-policy-test.ts`.
- Avoid: `context/features/01..04`, the ticket migration under `~/.controlroom/…/migrate/`, GitHub.

## Requirements

- The draft is adopted without loss: the worktree's version of each transferred file matches the
  bundle's checksums before any change.
- `local-only` stays the default and behaves exactly as today's guard.
- Each known gap is either closed with a real control or named as a limit in the code, the CLI
  help, and `describePolicy`. At minimum:
  - commands run through scripts or subprocesses, including the orchestration engine's own `gh` calls;
  - the hook failing open when the guard file is missing;
  - push redirection through `git -c` or repo config, and the guard checking a different `cwd`;
  - Write/Edit (non-Bash) tools changing the policy file;
  - a GitHub write scope broader than ticket work.
- Tests show the allowed and the refused operations through the real guard entry point, and that
  the generated coordinator settings wire that guard.

## Out of Scope

- Activating the policy, migrating tickets, pushing, opening PRs, merging, publishing.
- Features 01–04.

## Acceptance Criteria

- One local commit on the ticket branch containing only the in-scope files.
- `pnpm typecheck`, `pnpm build` and the policy tests pass, and their output is reported.
- A written list of the limits that remain.

## Notes / Decisions

- Human direction (2026-11-11): the developer owns this repair and an independent reviewer assesses
  it before any activation. This run is local only: no push or PR.
