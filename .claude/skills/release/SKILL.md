---
name: release
description: Cut a Solar Slinger desktop release through the workflow_dispatch CI — preview the changelog, pick the semver bump, dry-run, then publish and verify the auto-update feed. Use when the user asks to ship a release, cut a version, publish a build, or check what's pending since the last tag.
---

# Cutting a release

Releases are **a deliberate act, not a side effect of merging** — nothing runs on a push to `main`.
The workflow is `workflow_dispatch` only.

Full rationale for every wire below: [docs/packaging.md](../../../docs/packaging.md).

## Publishing is outward-facing — confirm before you trigger it

A real run tags `main`, commits a version bump, and publishes a public GitHub release. **Never trigger
a non-dry-run without the user explicitly asking for that release, with that bump.** If they asked
vaguely ("ship it"), show them the pending changelog and the computed version first and get a yes.

A dry run is safe and reversible: it builds and generates notes while publishing nothing.

## 1. See what's pending

```bash
npm run changelog
```

Needs `GH_TOKEN`. Zero-dependency Node, no Actions context, so the same command runs on CI and on a
laptop. It walks `git log <lastTag>..HEAD --first-parent` — PRs land as merge commits here, so
first-parent gives one entry per PR — recovers each PR number, and lifts a summary line from the PR
body. Commits with no PR behind them land under "Other changes" rather than being dropped.

Also confirm what version the bump will produce:

```bash
git fetch --tags && git tag -l 'v*' --sort=-v:refname | head -3
```

**The newest `v*` tag is the source of truth, not package.json** — package.json in a dev checkout
lags, and `publish` is what writes the number into it.

## 2. Choose the bump

`patch` / `minor` / `major`, applied to the newest tag. Ask the user unless they said which.

## 3. Dry run first

```bash
gh workflow run release.yml -f bump=patch -f dry_run=true
```

Then watch it:

```bash
gh run watch $(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')
```

Three jobs: **prepare** (compute version + notes once, so all runners agree) → **build** (mac DMG
arm64 + x64, Windows NSIS, Linux AppImage/deb/rpm × x64 + arm64) → **publish** (skipped on a dry run).
**Every side effect lives in `publish` and is gated on a green build**, so a broken build can never
leave a version commit or a dangling tag on `main`.

Check in the dry-run output:

- **The LFS guard passed.** The build job checks out with `lfs: true` because `actions/checkout` does
  not fetch LFS objects by default — without it electron-builder packages the 130-byte pointer files
  and ships a **silent game on a green build**. A size guard fails the run if any track comes through
  under 1 KB. If that step failed, fix it before anything else.
- **The generated notes read correctly**, including the `INSTALL_NOTES` block (Gatekeeper / SmartScreen
  / apt / dnf). Builds are **unsigned** and every release must carry those instructions; they live in
  `scripts/changelog.mjs`, not in the workflow YAML.
- **All build matrix legs are green**, not just the host platform's.

## 4. Publish

```bash
gh workflow run release.yml -f bump=patch -f dry_run=false
```

## 5. Verify the auto-update feed

This is the part that fails silently. Four wires each revert the auto-updating platforms to manual
updates if broken:

1. The `build.publish` block in package.json (makes electron-builder embed `app-update.yml` and emit
   the `dist/latest*.yml` feeds).
2. The release workflow uploading **`latest*.yml` + `*.blockmap`** to the GitHub release.
3. The repo staying **public** — the feeds are unauthenticated.
4. **Space-free `nsis.artifactName` / `appImage.artifactName`.** With electron-builder's default
   "Solar Slinger …" names, `latest.yml` points at the dash-sanitized name while GitHub renames the
   uploaded asset with DOTS, and the installed app **404s on every update check**. The AppImage name
   also needs `${arch}` or x64 and arm64 collide on the release.

Confirm the assets landed:

```bash
gh release view v<version> --json assets -q '.assets[].name'
```

Expect `latest.yml` (Windows), `latest-mac.yml` (mac check-and-notify), `latest-linux.yml`,
`latest-linux-arm64.yml`, the `.blockmap` files,
and the installers themselves. Then spot-check that a name inside `latest.yml` matches an asset name
exactly.

## What updates how (don't "fix" this by routing everything through electron-updater)

| Platform | Behaviour |
|---|---|
| Windows NSIS, Linux AppImage | **Self-update** via electron-updater — background download, sha512-verified, installs on quit, dialog offers "Restart now" |
| macOS | **Check-and-notify only.** Squirrel.Mac refuses to swap an unsigned/ad-hoc bundle. Needs a real Developer ID + notarization (+ a mac `zip` target) before it can change |
| Linux deb/rpm | **Check-and-notify only** — root-owned installs mean an in-place swap is a pkexec prompt mid-game. The AppImage is the self-updating Linux format |

**Failure law: a failed update check is invisible.** Offline or rate-limited must never surface a
dialog. "Skip this version" persists in `userData/update-prefs.json` (notify platforms only).

## Local build (no release)

```bash
npm run dist
```

Builds installers into `dist/` with `--publish never`.

## After the release

Have the **`docs-keeper`** subagent check whether the release changed anything the docs assert — and
remember the CREDITS version line comes from a relative `fetch('package.json')`, so it is **only
accurate on a release build**.
