# Project Overview

Durable, project-wide context.

Keep this concise. Feature scope, active work, history, and temporary
planning belong elsewhere.

Two words keep an unmade decision visible:

- `TBD` — a human decision is still required
- `None` — considered and intentionally excluded

Leave nothing blank. A blank field is indistinguishable from an abandoned one.

> Created 2026-11-12 to record the human's integration workflow choice. Every other field is `TBD`
> until the human decides it. Existing guidance stays authoritative where referenced (`README.md`,
> `CONTRIBUTING.md`, `RELEASING.md`, `context/coding-standards.md`, `context/ai-interaction.md`).

## Project

- Name: `Tin & Thyme`
- Stage: `TBD`
- Repo type: `TBD`
- Primary goal: `TBD`

## Product

- Problem: `TBD`
- Primary user: `TBD`
- First useful outcome: `TBD`
- Distinctive quality: `TBD`
- Avoid becoming: `TBD`

## Scope

### In

- `TBD`

### Out

- `TBD`

## Requirements and Open Decisions

Record only what constrains the work. An open decision stays `TBD` until a
human resolves it.

| Type | Item | Notes |
| --- | --- | --- |
| Open decision | `TBD` | |

## System

Record only important project-wide architecture and constraints.

- Architecture: `TBD`
- Main components: `TBD`
- Constraints: `TBD`

## Technology

The stack an agent must follow rather than choose. Keep the rows this project
actually has.

| Layer | Choice | Reason |
| --- | --- | --- |
| Platform/runtime | `TBD` | |
| Language(s) | `TBD` | |
| UI/presentation | `TBD` | |
| Backend/application | `TBD` | |
| Data storage and access | `TBD` | |
| Auth | `TBD` | |
| Testing | `TBD` | |
| Build and package tooling | `TBD` | |

## Commands

The commands an agent runs to verify its own work.

```text
install: TBD
run/dev: TBD
test: TBD
lint/static analysis: TBD
build/package: TBD
```

## Delivery Workflow

| Area | Choice |
| --- | --- |
| Git workflow | Ticket branch → normal (non-draft) pull request against `rikilamadrid/tin-and-thyme` `main` → checks and review → the human's merge approval. Human decision, 2026-11-12. |
| Default branch | `main` |
| Branch naming | `ticket/<key>-<slug>`, the branch Pathfinder's orchestration claim creates |
| Commit convention | `TBD` |
| Review policy | Every PR passes its checks and a review before merge. The human approves every merge; agents never merge. |
| Merge strategy | The human merges; the method is `TBD`. |
| CI/CD | `TBD` |
| Versioning and changelog | `TBD`; see `RELEASING.md` and `CHANGELOG.md` for current practice |
| Release process | `TBD`; see `RELEASING.md` for current practice |

## Environments and Integrations

| Area | Choice | Notes |
| --- | --- | --- |
| Local development | `TBD` | |
| Preview/staging | `TBD` | |
| Production | `TBD` | |
| Configuration and secrets | `TBD` | |
| External services/APIs | `TBD` | `gh` defaults to the upstream fork parent; always pass `-R rikilamadrid/tin-and-thyme`. |

## Quality Priorities

Rank only what matters for this project, highest first.

1. `TBD`

| Concern | Target or decision |
| --- | --- |
| Correctness/reliability | `TBD` |
| Security/privacy | `TBD` |
| Accessibility | `TBD` |
| Performance | `TBD` |
| Supported platforms | `TBD` |

## Durable Decisions

Decisions that outlive a Feature, including approved prototype direction and
anything a prototype proved must not reach production.

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-12 | Integration is ticket branch → non-draft PR to `main` → checks and review → human merge approval. | Human's choice; merges stay with the human. |

## Learning

- What the human wants to understand: `TBD`
- Preferred lesson format: `TBD`
