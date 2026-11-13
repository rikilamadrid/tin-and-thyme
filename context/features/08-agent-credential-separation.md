# Agent Credential Separation

## Status

Proposed

## Goal

Agent sessions can reach only an agent-scoped GitHub credential. The human's GitHub logins, SSH keys,
package-registry and deploy credentials are out of their reach, so that GitHub-side rules
(rulesets, required reviews, protected environments) constrain what agents can actually do.

## Context

- Read: Feature 05's enforcement doc, `docs/run-policy-enforcement.md` on branch
  `ticket/05.1-adopt-and-repair-the-run-policy-draft` (stop-condition section), and ticket 05.1's
  Notes / Decisions.
- Finding (ticket 05.1, independently reviewed): agent sessions run as the human's OS user, which holds
  the human's credentials. A restricted agent token does not help while those are reachable, and
  overriding HOME alone does not separate the keychain or the ssh-agent.
- Relevant area: `TBD`, decided by the approach.

## Requirements

- `TBD`. A human decision is required first: a separate OS user, a container, a credential broker, or
  explicitly accepting the gap.
- No credential values are recorded in tracked files.

## Out of Scope

- Changing GitHub settings or credentials, or activating the github-dev policy, without the human.

## Acceptance Criteria

- `TBD`, after the approach is chosen.

## Notes / Decisions

- Recorded 2026-11-12 as a separate Proposed feature at the human's direction. Not part of 05.1, and
  not to be implemented until the human approves an approach.
