# The `tin-and-thyme` command

The npm package and the executable are both `tin-and-thyme`. Open a kitchen for any
Pathfinder repository with one command:

```bash
tin-and-thyme open .
```

The kitchen opens in your browser with the repository's roles, its ticket board
(from the repo's own Pathfinder engine and ticket store) and any existing claims.
No `HQ_REPO`, no ports to manage.

## Install

```bash
npm install -g tin-and-thyme       # or, without installing: npx tin-and-thyme@latest open .
tin-and-thyme --version
```

Update with `npm install -g tin-and-thyme@latest`; uninstall with
`npm uninstall -g tin-and-thyme`. Kitchens you started keep running until you stop
them (`kill <pid>`).

### From source

```bash
git clone https://github.com/rikilamadrid/tin-and-thyme && cd tin-and-thyme
pnpm install && pnpm build
ln -s "$PWD/bin/tin-and-thyme.mjs" ~/.local/bin/tin-and-thyme   # any folder on your PATH
```

The link points at the checkout, so after pulling changes, run `pnpm build` again.
Remove it with `rm ~/.local/bin/tin-and-thyme`.

## Use

```bash
cd ~/Workspace/personal/some-pathfinder-repo
tin-and-thyme open .                    # open (or reuse) this repo's kitchen in the browser
tin-and-thyme open ~/Workspace/other    # any path inside another repo
tin-and-thyme open . --no-browser       # start or reuse it, and print the URL instead
tin-and-thyme url .                     # print the URL of the kitchen already running (exit 3 if none)
tin-and-thyme list                      # every recorded kitchen, and whether it still answers
tin-and-thyme --help                    # usage; exits 0
tin-and-thyme --version                 # the version alone; exits 0
```

| Exit | Meaning |
| --- | --- |
| 0 | Done (the URL was printed or opened) |
| 1 | Not a Git repository, a bad option, or the kitchen could not start (the log path is printed) |
| 2 | The repository has no Pathfinder kit; nothing was written |
| 3 | `url`: no kitchen is running for that repository |
| 4 | An older, hand-started Tin & Thyme already serves that repository |

## How it decides

- **One kitchen per repository.** The target is resolved to its canonical root
  (Git top level, symlinks resolved). Its kitchen key is `<folder>-<8 hex>`,
  where the hex is the start of the SHA-256 of that root. So two repos that share
  a folder name never share local state (`~/.controlroom/<key>`,
  `~/.jsmhq/<key>`) or tmux session names.
- **Reuse only what proves itself.** A running kitchen is reused only if its
  `/api/health` reports this app, this repository's key and the exact instance id
  in its record (`~/.controlroom/kitchens/<key>.json`, mode 0600).
- **Otherwise start one** on the first free localhost port from 7420, preferring
  the port this repository used last. A busy port is skipped, never taken over.
- **Stale records** (the recorded port is gone, or now belongs to something else)
  are replaced. Whatever owns that port keeps running.
- **Concurrent opens converge.** A per-repo lock
  (`~/.controlroom/kitchens/<key>.lock`) lets one command start the kitchen while
  the others wait and reuse it.
- **Older hand-started instances.** If a Tin & Thyme for the same repository was
  started by hand (with `HQ_REPO`) before this command existed, `open` says so and
  exits instead of starting a second one beside it.
- A kitchen runs in the background. Its log is
  `~/.controlroom/kitchens/<key>.log`. Stop it by its pid (shown by `open`): the
  record is removed when it stops cleanly.

## Opening is not starting work

Opening loads the board and observes any session data already there. It never
starts an orchestration round. Starting one is the Head Chef's card in the
kitchen, which runs Pathfinder's `/orchestrate start`; that still asks for
Pathfinder's normal approval before it claims anything.

## A repository without the Pathfinder kit

`open` needs `context/execution-mode.md` (with its `pathfinder:execution-mode`
marker) and `skills/orchestrate/engine/bin/orchestrate.mjs`. When they are
missing it says which, and how to add Pathfinder yourself
(`npx create-pathfinder --mode orchestrator` inside that repo). Tin & Thyme
never writes into the repository.

## Earlier local state

Before kitchens were keyed by path, a repo's state lived under its folder name
(`~/.controlroom/<folder>`). The first kitchen for that repository copies it
(never moves it), and only when the saved coordinator transcript proves it
belongs to that repository.
