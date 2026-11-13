# Getting started with Tin & Thyme

From nothing to watching a Pathfinder round in your own kitchen. About ten minutes.

## 1. What you need

- macOS (verified; Linux should work but has not been verified), Node.js 20+, Git.
- A repository with the Pathfinder kit. Don't have one? In that repository, run
  `npx create-pathfinder --mode orchestrator` and follow Pathfinder's own onboarding.
- To run an orchestration from the kitchen: Claude Code and tmux. To only watch an
  existing board, neither is needed.

## 2. Install the command

```sh
npm install -g tin-and-thyme
tin-and-thyme --version
```

Or run it without installing: `npx tin-and-thyme@latest open .`. To update later,
run `npm install -g tin-and-thyme@latest` again. To run it from source instead, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## 3. Open a kitchen

```sh
cd ~/Workspace/my-app
tin-and-thyme open .
```

Your browser opens on the kitchen for `my-app`: its configured roles, its ticket board
and any claims that already exist. Nothing has started. Run the same command again, from
the repository or with its path from anywhere, and you get the same kitchen back.

Rather copy the URL yourself? `tin-and-thyme open . --no-browser` prints it, and
`tin-and-thyme url .` prints the URL of a kitchen that is already running.

## 4. Start a round

Press **Start team** in the top bar (or **Start Basil** in the Head Chef's drawer). Tin &
Thyme launches Pathfinder's coordinator in Claude Code, in tmux, with `/orchestrate start`.
Pathfinder plans the round and asks you to approve it, in the Head Chef's terminal,
before it claims anything.

From then on:

- each worker session **beams in** through the Crew Transporter when it starts and
  **beams out** when it stops;
- every ticket keeps one card on the left; between stages it says what it is waiting for;
- a **Needs you** badge means Pathfinder is waiting on a human gate. Open **Action
  items**, read Pathfinder's question and who asked it, and **Send answer**: your
  reply is typed into the coordinator's session once, and the request shows
  **Recorded** when Pathfinder records it;
- **Waiting on workers** on the Head Chef means its turn ended while workers it
  dispatched are still running: nothing is asked of you.

The coordinator runs under a local-only policy: pushes, pull requests, issues, GitHub API
calls, deploys and `npm publish` are refused and become a human gate.

## 5. Leave, come back, stop

- Closing the browser changes nothing. `tin-and-thyme open` brings you back.
- `tin-and-thyme list` shows every kitchen and whether it still answers.
- To stop a kitchen, `kill` the pid that `open` printed. The coordinator and its workers
  keep running in tmux; opening the kitchen again picks them up.

## Something not working?

See [Troubleshooting](troubleshooting.md), and the kitchen's log
at `~/.controlroom/kitchens/<repo>-<hash>.log`.
