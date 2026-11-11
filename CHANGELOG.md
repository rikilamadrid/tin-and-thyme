# Changelog

All notable changes to Tin & Thyme are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - not yet published

The first release candidate. It is not published: `package.json` keeps
`"private": true` until the deliberate first-publication step in RELEASING.md, which
also replaces "not yet published" above with the publication date.

### Added

- `tin-and-thyme`, the command: `open [path]` opens or reuses one kitchen per repository
  (keyed by its canonical path), `--no-browser` prints the URL instead, `url [path]` and
  `list` find running kitchens. Concurrent opens converge on one instance; busy ports and
  stale records are skipped without stopping anything; a repository without the Pathfinder
  kit gets an actionable message and is never written to.
- The Pathfinder adapter: roles, the ticket board and existing claims from the
  repository's own engine; the coordinator in tmux under a local-only run policy; worker
  sessions observed through Claude Code hooks; human gates as Action items.
- The kitchen, in Detailed pixel art and Cel-shaded: the Head Chef's office, prep pods,
  the review scanner, subagent stations, the belt and the MAIN hatch.
- The Crew Transporter: workers beam in on an observed session start and out when they
  stop; ticket cards keep each session's outcome (handed off, human gate, failed,
  interrupted) and last readings; "Waiting for …" and "Ready for next round" from what
  Pathfinder recorded.
- Per-session context, model and effort telemetry; advisory context alerts; optional
  sound cues that never replay on refresh or reconnect.
- Labelled sample scenes: `?fixture=busy`, `?fixture=sounds`, `?fixture=handoff`.

### Changed

- Forked from JSM HQ 0.7.5 and renamed, as JSM HQ's trademark notice asks of a fork:
  the package is `tin-and-thyme`, with its own name and no JSM logo.

### Removed

- The inherited `jsm-hq` executable and the upstream install instructions. This is a
  product decision, not a trademark requirement: Tin & Thyme ships one command,
  `tin-and-thyme`.
