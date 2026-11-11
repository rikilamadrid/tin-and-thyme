# Troubleshooting

| You see | What to do |
| --- | --- |
| `has no Pathfinder kit` (exit 2) | Add Pathfinder to that repository yourself, then open it again. |
| `is not inside a Git repository` | Pass a path inside a repository, or `cd` into one. |
| `an older Tin & Thyme is already serving …` (exit 4) | A kitchen for that repository was started by hand, before `tin-and-thyme open`. Keep using it, or stop it yourself and run `open` again. |
| `no kitchen is running for …` (exit 3, from `url`) | Run `tin-and-thyme open <path> --no-browser`. |
| The page is blank or will not connect | Run `tin-and-thyme list`. The next `open` replaces a stale kitchen. Logs: `~/.controlroom/kitchens/<repo>-<hash>.log`. |
| `npm warn install-scripts` during install | Expected with newer npm. The terminal helper is made executable when the server starts. |

Still stuck? The kitchen's own log is `~/.controlroom/kitchens/<repo>-<hash>.log`, and
`tin-and-thyme list` shows which kitchens still answer.
