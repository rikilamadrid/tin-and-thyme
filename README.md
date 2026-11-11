<div align="center">

# Tin & Thyme

**Watch a Pathfinder orchestration run as a robot kitchen, and step in only when it needs you.**

Pathfinder runs the round; Tin & Thyme lets you watch the kitchen.

<sub>a <a href="https://github.com/rikilamadrid/wonder-wagon-ui">Wonder Wagon</a> tool · shelved beside <a href="https://github.com/rikilamadrid/pathfinder">Pathfinder</a>, <a href="https://github.com/rikilamadrid/lorekeeper">Lorekeeper</a> and <a href="https://github.com/rikilamadrid/forge">Forge</a></sub>

[Quick start](#quick-start) ·
[Tour](#a-tour-of-the-kitchen) ·
[What runs where](#what-runs-on-your-machine) ·
[Troubleshooting](#troubleshooting) ·
[Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md)

</div>

![Tin & Thyme in detailed pixel art: the Head Chef's office, two developers cooking, an adversary at the review scanner, the Crew Transporter with tickets waiting for the next round, and ticket cards with a human gate and an interrupted session.](https://cdn.jsdelivr.net/npm/tin-and-thyme@0.1.0/docs/images/tin-and-thyme-pixel.png)

<sub>The labelled sample scene (`?fixture=handoff`), not a live run: the toolbar says <b>Fixture · crew transporter handoff</b>, and every ticket, name and reading is sample data.</sub>

Tin & Thyme is a local web app for one job: seeing what a
[Pathfinder](https://github.com/rikilamadrid/pathfinder) orchestration is doing,
right now, in the repository you are in. One command opens a kitchen for that
repository, with its roles, its ticket board and any existing claims already
loaded:

```sh
tin-and-thyme open .
```

Pathfinder decides what runs, records every stage, and keeps approval, acceptance,
merge and release with you. Tin & Thyme reads what Pathfinder records and what
Claude Code reports, and draws it: the orchestrator in its office, short-lived
worker sessions beaming in to cook a ticket and beaming out when they hand it on,
human gates in pink, and finished work riding the belt into **MAIN**. Opening a
kitchen never approves, claims or dispatches anything, and Tin & Thyme writes
nothing into your repository.

## Quick start

Tin & Thyme is not on npm yet. Install it once from this repository:

```sh
git clone https://github.com/rikilamadrid/tin-and-thyme ~/Workspace/personal/tin-and-thyme
cd ~/Workspace/personal/tin-and-thyme
pnpm install && pnpm build
ln -s "$PWD/bin/tin-and-thyme.mjs" ~/.local/bin/tin-and-thyme   # any folder on your PATH
tin-and-thyme --version
```

Then, from any repository that has the Pathfinder kit:

```sh
cd ~/Workspace/my-app
tin-and-thyme open .                    # open (or reuse) this repository's kitchen in your browser
tin-and-thyme open ~/Workspace/other    # or name any repository
tin-and-thyme open . --no-browser       # start or reuse it, and print the URL instead
tin-and-thyme url .                     # the URL of the kitchen already running
tin-and-thyme list                      # every kitchen, and whether it still answers
```

No Pathfinder kit yet? `open` says what is missing and how to add it yourself
(`npx create-pathfinder --mode orchestrator` in that repository). Tin & Thyme
does not set anything up for you.

When you want work to run, start the Head Chef: **Start team** in the top bar,
or **Start Basil** in its drawer. That launches Pathfinder's coordinator in
Claude Code (`/orchestrate start`), and Pathfinder asks for your approval before
it claims a single ticket.

## A tour of the kitchen

### Two ways to draw it

The same kitchen in **Detailed pixel art** (whole pixels, ink outlines, dithered
light) or **Cel-shaded** (inked vector shapes with one flat shadow each). Switch
in **Settings → Appearance**; nothing else changes.

![The same sample scene, cel-shaded.](https://cdn.jsdelivr.net/npm/tin-and-thyme@0.1.0/docs/images/tin-and-thyme-cel.png)

### The crew

- **The Head Chef** is Pathfinder's orchestrator: one Claude Code session that
  Tin & Thyme starts in tmux, running `/orchestrate start`. It works in the glass
  office. When it ends its turn on a question, it shows **Needs you**.
- **Workers are disposable.** Each Pathfinder stage (implementation, adversary,
  review, repair) runs as its own background session of the coordinator, seen
  through Claude Code hooks. A robot is on the floor only while its session runs.
  Developers cook at the prep pods; testers and adversaries work at the review
  scanner over the belt.
- **Helpers** the coordinator delegates (searches, plans) work at the subagent
  stations, under the name of the session that launched them.

### The Crew Transporter

![The Crew Transporter mid-beam: a session dissolving in the teal column inside the glass tube, with tickets above it held for the next round. From the labelled sample scene.](https://cdn.jsdelivr.net/npm/tin-and-thyme@0.1.0/docs/images/crew-transporter.png)

Sessions arrive and leave through a glass tube beside the prep line, with a quick
teal beam:

- a worker **beams in** only when its session is observed to start, then walks to
  its station;
- when it stops, it walks back and **beams out**, and its station is free again;
- several at once take turns, and each beam runs shorter;
- with reduced motion there is no beam at all: robots simply appear and leave.

Work itself never uses the tube. Tickets travel by the belt, the scanner and the
**MAIN** hatch.

### Ticket cards and stage handoffs

Every ticket in flight has one card in the left column, and it outlives the
sessions that work on it. When a developer finishes and Pathfinder records the
next stage, the card reads **Waiting for adversary** until that session actually
starts; then it shows the new worker, its stage, and that session's own context,
model and effort. Each finished session stays in the card's **History**, with
how it ended and its last readings. Finished sessions leave the floor and the
roster instead of piling up in the lounge.

A card also tells you when something needs a person:

- **Needs you**, in pink, for a human gate. Pathfinder's own question stays on the
  card and in **Action items** after the worker has left. Answering there types
  your reply into the coordinator's session, and Pathfinder records it.
- **Interrupted** when a session stopped without recording a handoff. No success
  sound plays.
- **Ready for next round** when the coordinator's latest plan lists the ticket as
  eligible and waiting for another approved dispatch. An empty station may stay
  empty.

### Board, terminals and Activity

- **Boards** shows every ticket Pathfinder's engine reports, by Feature.
- Each crew member's drawer has a **terminal**: the Head Chef's is its live
  Claude Code session; a worker's shows the tools it runs, as it runs them.
- **Activity** lists what happened, newest first: starts, handoffs, gates, plans
  and deliveries.

### Telemetry, context and sound

- **Context, model and effort** are read from each session's own transcript. A
  value that is not reported shows **—**, never a guess.
- **Context alerts** (Settings → Context, 35% by default) flag a live worker
  whose context crosses the threshold. They are advisory: nothing restarts on its
  own.
- **Sound** (Settings → Audio) is off by default. When on, short cues mark a new
  human decision, a beam-in, a handoff, a ticket moving, a passing review and a
  confirmed merge. Refreshes and reconnects never replay them.

## What runs on your machine

| When | What happens |
| --- | --- |
| `tin-and-thyme open` | Resolves the repository to its canonical path. If a kitchen answers on its recorded port **and** proves it is that exact instance for that exact repository, it is reused. Otherwise one starts: a background Node server on the first free port from 7420, bound to `127.0.0.1`. |
| Two `open`s at once | One starts the kitchen; the other waits on a per-repository lock and reuses it. |
| A busy port or a stale record | The port is skipped. Tin & Thyme never stops a process it did not start. |
| The kitchen opens | It reads Pathfinder's engine (`orchestrate.mjs status`) and the session data already on disk. No session starts. |
| **Start team** | Launches the coordinator in tmux under a local-only run policy: pushes, pull requests, issues, GitHub API calls, deploys and `npm publish` are refused and become a human gate. |
| You close the browser | Nothing else happens. The kitchen keeps running; `tin-and-thyme open` or `tin-and-thyme url` brings you back. |
| You stop a kitchen | `kill <pid>` (`open` prints it). Coordinator and worker sessions keep running in tmux. |

What Tin & Thyme keeps lives in your home folder, keyed by the repository's
canonical path, so two repositories with the same folder name never share it:
`~/.controlroom/<repo>-<hash>/` (run state), `~/.controlroom/kitchens/` (instance
records and logs) and `~/.jsmhq/<repo>-<hash>/` (the hook token). Those folder
names predate the project's current name; they are kept so existing kitchens keep
their state.

## Requirements

- macOS (verified). Linux should work but has not been verified yet.
- Node.js 20 or newer, and Git.
- A repository with the Pathfinder kit: `context/execution-mode.md` and
  `skills/orchestrate/engine/`. Human-in-the-loop and orchestrator modes both show
  their board.
- To run an orchestration from the kitchen: Claude Code and tmux.
- For a GitHub Issues ticket store: the GitHub CLI (`gh`), which Pathfinder's
  engine uses to read it.

## Supported integrations

| | |
| --- | --- |
| **Pathfinder** | The repository's own kit and engine, at the version it carries. Ticket stores: local Markdown and GitHub Issues. |
| **Claude Code** | The coordinator and its worker sessions: hooks for live events, transcripts for context, model and effort. |
| **Wonder Wagon** | The family's naming and CLI conventions. Tin & Thyme has no Wonder Wagon theme or serial yet; its kitchen palette is its own. |

The server still carries features of the project it was forked from (Docker
Sandboxes, a native multi-agent team, GitHub review loops). `tin-and-thyme open`
does not use them, and this README does not describe them.

## Troubleshooting

| You see | What to do |
| --- | --- |
| `has no Pathfinder kit` (exit 2) | Add Pathfinder to that repository yourself, then open it again. |
| `is not inside a Git repository` | Pass a path inside a repository, or `cd` into one. |
| `an older Tin & Thyme is already serving …` (exit 4) | A kitchen for that repository was started by hand, before `tin-and-thyme open`. Keep using it, or stop it yourself and run `open` again. |
| `no kitchen is running for …` (exit 3, from `url`) | Run `tin-and-thyme open <path> --no-browser`. |
| The page is blank or will not connect | Run `tin-and-thyme list`. The next `open` replaces a stale kitchen. Logs: `~/.controlroom/kitchens/<repo>-<hash>.log`. |
| `npm warn install-scripts` during install | Expected with newer npm. The terminal helper is made executable when the server starts. |

## What has been verified, and how

- **The labelled sample scene.** The transporter, ticket handoffs, the human gate,
  the interrupted session, both art styles, reduced motion and refresh without
  replay are checked in `?fixture=handoff` in headless Chrome. The screenshots in
  this README come from it.
- **Live kitchens.** `tin-and-thyme open` has loaded real Pathfinder repositories
  (local Markdown and GitHub Issues stores, including an existing claim), reused
  them on a second open, kept two same-named repositories apart and recovered from
  a stale record. A live coordinator view reconnected after a server restart
  without replaying anything.
- **Not yet observed live:** a real worker session beaming in and out, end to end.
  That event handling is checked against real-shaped hook events, not a recorded
  run.
- **The package.** `scripts/smoke-test.mjs` installs the packed tarball, runs the
  installed `tin-and-thyme`, opens a kitchen, loads its board, reuses it and checks
  the missing-kit message.

## Further reading

| Document | What it covers |
| --- | --- |
| [`docs/getting-started.md`](docs/getting-started.md) | From install to watching your first round |
| [`docs/how-it-works.md`](docs/how-it-works.md) | The server, the Pathfinder adapter, hooks, and what is kept where |
| [`docs/tin-and-thyme-cli.md`](docs/tin-and-thyme-cli.md) | Every command and exit code, and how a kitchen is chosen |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, release by release |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Running from source, tests, packaging and releasing |
| [`RELEASING.md`](RELEASING.md) | How a version reaches npm, and what is still to set up |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability |

## Credits and license

Tin & Thyme began as a fork of [JSM HQ](https://github.com/jsmastery-pro/jsm-hq)
by JavaScript Mastery. Its local server, session handling, terminals and the
first pixel office come from that project, under the MIT license. Tin & Thyme is
an independent project, not made, endorsed or supported by JavaScript Mastery.
"JSM HQ" and "JavaScript Mastery" are their trademarks; see
[`TRADEMARKS.md`](TRADEMARKS.md).

MIT. See [`LICENSE`](LICENSE): © 2026 JavaScript Mastery, and © 2026 Ricardo
Lamadrid for Tin & Thyme.
