# Releasing `tin-and-thyme`

Tin & Thyme publishes one npm package, `tin-and-thyme`, which installs the
`tin-and-thyme` command. The process follows Lorekeeper's `RELEASING.md` and
Pathfinder's CONTRIBUTING § Releasing.

**The version comes from one place.** The newest `## [X.Y.Z]` heading in
`CHANGELOG.md` is the source of truth. `package.json`, the Git tag and the GitHub
Release must agree with it. The release workflow and the publish guard
(`scripts/publish-guard.mjs`, run as `prepublishOnly`) both refuse otherwise.

**Nothing public exists until npm has the package.** A published version, a pushed tag
and a Release are permanent. A mistake is corrected by superseding it, never by
removing it.

## Where things stand

| Gate | State today | Opened by |
| --- | --- | --- |
| GitHub Actions | **Disabled** for `rikilamadrid/tin-and-thyme` | Step A below |
| `"private": true` in `package.json` | **Present**, so `npm publish` is refused | Step B1, deliberately |
| The package on npm | **Not published** (`tin-and-thyme` and `tinandthyme` both answered 404 on 2026-11-11) | Step B, by a human |
| The trusted publisher on npmjs.com | **Not configured** (it cannot exist before the package does) | Step C |

`.github/workflows/release.yml` refuses to run while any of the last three hold, and
cannot run at all while Actions is disabled.

## A. Enable GitHub Actions (when you choose to)

```sh
gh api -X PUT repos/rikilamadrid/tin-and-thyme/actions/permissions -F enabled=true -f allowed_actions=all
gh api repos/rikilamadrid/tin-and-thyme/actions/permissions     # expect "enabled": true
```

Enabling Actions also starts `ci.yml` on every push to `main` and every pull request:
a build and the tarball smoke test on Ubuntu, macOS and Windows, then a bare-Linux
install. In a private repository these use the account's Actions minutes, and macOS and
Windows runners count at a multiple of Linux minutes. Windows has never been run, so
expect that leg to need attention.

Under **Settings → Actions → General → Workflow permissions**, the default read-only
token is fine: `release.yml` asks for exactly `contents: write` and `id-token: write`.

## B. First publication (one time, by a human)

npm attaches a trusted publisher from the package's own settings page, so `0.1.0` is
published by hand once. Lorekeeper did exactly this for `create-lorekeeper`.

1. **Cross the first-publication boundary.** On a branch, remove `"private": true` from
   `package.json`, and change `## [0.1.0] - not yet published` in `CHANGELOG.md` to
   `## [0.1.0] - YYYY-MM-DD`. Open a pull request and merge it. This commit is the
   deliberate decision to publish under the name `tin-and-thyme`.
2. **Build and verify the exact bytes you will publish**, on an up-to-date `main` with a
   clean tree:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   npx tsx scripts/session-backend-test.ts && npx tsx scripts/workspace-test.ts
   mkdir -p /tmp/tt-release && npm pack --pack-destination /tmp/tt-release
   node scripts/smoke-test.mjs /tmp/tt-release/tin-and-thyme-0.1.0.tgz
   shasum -a 256 /tmp/tt-release/tin-and-thyme-0.1.0.tgz
   ```

3. **Log in as the package owner:** `npm login` (account `riki.lamadrid`, the account
   that publishes Pathfinder, Lorekeeper and Forge). `npm whoami` proves identity, not
   publish entitlement; do not treat it as a preflight.
4. **Re-check that the name is still free.** Both must return `404`, because npm refuses
   a new name that matches an existing one once `-`, `.` and `_` are removed:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/tin-and-thyme
   curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/tinandthyme
   ```

5. **Publish the verified tarball, exactly those bytes:**

   ```sh
   npm publish /tmp/tt-release/tin-and-thyme-0.1.0.tgz
   ```

   npm runs no lifecycle scripts for a tarball, so the publish guard does not run here;
   steps 1 to 4 are its human equivalent. npm asks for your 2FA code. This publish
   carries no provenance: provenance needs a supported CI identity *and* a public
   repository.
6. **Check it from outside:**

   ```sh
   npm view tin-and-thyme version                                   # 0.1.0
   curl -s -o /dev/null -w '%{http_code}\n' https://cdn.jsdelivr.net/npm/tin-and-thyme@0.1.0/docs/images/tin-and-thyme-pixel.png   # 200
   ```

   Then install it into a scratch folder and `tin-and-thyme open` a scratch Pathfinder
   repository.
7. **Tag and release `v0.1.0`.** With Actions enabled (A), dispatch the workflow. It sees
   `0.1.0` already on the registry, skips the publish, and pushes the tag and creates the
   Release:

   ```sh
   gh workflow run release.yml --ref main -f version=0.1.0
   ```

   Without Actions, tag by hand instead:
   `git tag -a v0.1.0 -m "v0.1.0" <release commit> && git push origin v0.1.0`, then
   `gh release create v0.1.0 --verify-tag --title "Tin & Thyme v0.1.0" --notes-file <the 0.1.0 changelog section>`.

## C. Configure the trusted publisher, just before the first workflow publish

npm's documentation (docs.npmjs.com/trusted-publishers, read 2026-11-11) adds three
rules that decide *when* to do this:

- **A new trusted publisher must complete a successful publish within 2 days, or it
  expires.** Step B7 does not publish, so configure the publisher only when the next
  version (for example `0.1.1`) is merged and ready to dispatch, or recreate it then.
- **Configurations created after 2026-09-03 allow only `npm stage publish` by default.**
  This workflow runs `npm publish`, so it must be allowed explicitly.
- **`repository.url` in `package.json` must match the GitHub repository exactly.** It is
  `git+https://github.com/rikilamadrid/tin-and-thyme.git`.

On <https://www.npmjs.com/package/tin-and-thyme/access>, under **Trusted Publisher**,
choose **GitHub Actions** and enter:

| Field | Value |
| --- | --- |
| Organization or user | `rikilamadrid` |
| Repository | `tin-and-thyme` |
| Workflow filename | `release.yml` (the filename only) |
| Environment | leave empty |
| Allowed actions | allow **`npm publish`** |

Then, within 2 days, dispatch the release (below). After it succeeds, set
**Require two-factor authentication and disallow tokens** under Publishing access.

The trusted publisher needs a GitHub-hosted runner (the workflow uses
`ubuntu-latest`), Node.js 22.14 or newer and npm 11.5.1 or newer (the workflow installs
the latest npm and checks).

**Provenance:** none while the repository is private. npm attaches provenance only when
a public package is published from a public repository. Making the repository public is
a separate decision; nothing in this process requires it.

## Every later release

1. Move the `[Unreleased]` entries into `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md` and
   keep an empty `[Unreleased]` above it. The GitHub Release notes are this section,
   verbatim.
2. Set the same version in `package.json`, and update the version in the README image
   URLs (`https://cdn.jsdelivr.net/npm/tin-and-thyme@X.Y.Z/…`). The publish guard
   refuses if they disagree.
3. Open the release pull request. CI builds, packs and smoke-tests the tarball. Merge it.
4. `gh workflow run release.yml --ref main -f version=X.Y.Z`. It refuses unless the
   input, the changelog and the manifest agree, `"private"` is gone, the package exists
   on npm, and `main`'s tip is the commit being released. In order, it tests, verifies
   the tarball, publishes through trusted publishing, reads the version back from the
   registry, pushes the annotated tag and creates the Release.
5. If it fails, **re-dispatch it.** Every step skips an effect that already exists.
   Never invent a new version to get past a failed run.

## README images on npm

npm renders the README from the published package and cannot load images from a
private repository. The README therefore points its images at the published package
itself, through jsDelivr's npm mirror:
`https://cdn.jsdelivr.net/npm/tin-and-thyme@<version>/docs/images/<file>.png`. The images
ship in the tarball (`docs/images` is in `files`). Nothing is uploaded anywhere: jsDelivr
serves the files npm already has. Until a version is published, those images show their
alt text, on GitHub as well.

The trusted publisher is bound to the workflow's filename. Renaming `release.yml`
silently breaks every future publish.
