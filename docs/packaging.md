# Desktop packaging — Electron shell, auto-update, release CI, changelog

> Deep reference. Read before touching `electron/`, `package.json`'s `build:` block,
> `.github/workflows/release.yml` or `scripts/changelog.mjs`. The `release` skill drives an
> actual release; this file is the why behind it.
>
> **The hard rule: `src/` stays host-agnostic.** Never `require`/`import` Electron or Node APIs
> from `src/`, and never assume an origin, absolute path or `file://`.

The game ships as an Electron desktop app for macOS + Windows, but the game code knows nothing
about it — this is a hard rule.

- **`src/` must stay host-agnostic.** The exact same static files run under `serve.py` (browser dev)
  and inside Electron. [electron/main.js](../electron/main.js) serves the repo over a privileged
  `app://` scheme (Chromium won't load ES modules over `file://`, same reason `serve.py` exists) and
  the game code has no idea it's in Electron. Never `require`/`import` Electron or Node APIs from
  `src/`, and never assume an origin, absolute path, or `file://` — if it wouldn't work over
  `serve.py`, it's wrong. Audio assets follow the same rule: always relative paths (`assets/audio/…`);
  the `app://` scheme carries the `stream` privilege so `<audio>` elements can stream the music beds.
- **The build job checks out with `lfs: true`** — the music is LFS-tracked and `actions/checkout`
  does not fetch LFS objects by default, so without it electron-builder packages the pointer files
  and ships a silent game on a green build. A size guard in that job fails the run if any track
  comes through under 1 KB. `prepare`/`publish` deliberately stay pointer-only (they never touch
  the assets, and each extra LFS checkout is billed bandwidth).
- **npm scripts** ([package.json](../package.json)): `npm run serve` (= `python3 serve.py`),
  `npm start` (run the Electron shell locally), `npm run dist` (build installers into `dist/`),
  `npm run changelog` (preview the pending release notes — needs `GH_TOKEN`).
  Electron + electron-builder are **devDependencies** — dev/build only. `electron-updater` is the
  one real `dependency` (it ships inside the packaged app), and it belongs to the SHELL — the
  GAME still has zero runtime dependencies, and nothing under `src/` may ever import it.
- `ELECTRON_START_URL` points the shell at the live dev server (`http://localhost:8642`) instead of
  `app://` for hot-ish iteration.
- **Auto-update** ([electron/updater.js](../electron/updater.js)) — a no-op in dev (`app.isPackaged`
  gate), and split by what unsigned builds can honestly do: **Windows NSIS + Linux AppImage**
  self-update via electron-updater (background download, sha512-verified from `latest*.yml`,
  installs on quit; a dialog offers "Restart now"; AppImage is detected via
  `process.env.APPIMAGE`); **macOS** is check-and-notify ONLY — Squirrel.Mac refuses to swap an
  unsigned/ad-hoc bundle, so until a real Developer ID + notarization (+ a mac `zip` target)
  exists, don't route mac through electron-updater's installer; **Linux deb/rpm** installs are
  root-owned (in-place swap = pkexec prompt mid-game), so they're also check-and-notify — the
  AppImage is the self-updating Linux format. Four load-bearing wires, each of which silently
  reverts the auto platforms to manual updates if removed: the `build.publish` block in
  package.json (makes electron-builder embed `app-update.yml` in the app and emit the
  `dist/latest*.yml` feeds — `latest.yml` win, `latest-linux.yml` + `latest-linux-arm64.yml`
  per-arch), the release workflow uploading `latest*.yml` + `*.blockmap` to the GitHub release
  (the update feed; blockmaps enable differential downloads), the repo staying public (the feeds
  are unauthenticated), and the SPACE-FREE `nsis.artifactName` / `appImage.artifactName` — with
  electron-builder's default "Solar Slinger …" names, latest.yml points at the dash-sanitized
  name while GitHub renames the uploaded asset with DOTS, so the installed app 404s on every
  check (the AppImage name also needs `${arch}` or the x64 and arm64 files collide on the
  release). **Failure law: a failed update check is invisible** — offline/rate-limited must
  never surface a dialog. "Skip this version" persists in `userData/update-prefs.json`
  (notify platforms only).
- **Release CI** ([.github/workflows/release.yml](../.github/workflows/release.yml)) is
  **`workflow_dispatch` only — nothing runs on a push to `main`.** You trigger it and pick a
  `bump` (patch/minor/major); `dry_run: true` builds and generates notes while publishing nothing.
  Three jobs: **prepare** (compute version + notes) → **build** (mac DMG arm64 + x64, Windows NSIS,
  Linux `.deb` + `.rpm` x64 + arm64 each — deb for Debian/Ubuntu/Raspberry Pi OS 64-bit, rpm for
  RHEL/Rocky/Fedora) → **publish**. Every side effect lives in `publish` and is gated on a green
  build, so a broken build can never leave a version commit or a dangling tag on `main`.
- **The newest `v*` git tag is the version's source of truth**, not package.json — the bump is
  applied to the tag, and `publish` then writes it into package.json and commits it. So checkouts
  must use `fetch-depth: 0` + `fetch-tags: true` or every release computes as `0.0.1`. (History:
  the patch digit used to be `github.run_number`, which made minor/major releases impossible and
  left package.json stuck at `0.1.0`.) The release tag is **annotated**, because `git push
  --follow-tags` silently refuses to push a lightweight one.
- **Changelog** ([scripts/changelog.mjs](../scripts/changelog.mjs)): zero-dependency Node, no Actions
  context, so the same command runs on CI and on a laptop. It walks `git log <lastTag>..HEAD
  --first-parent` (PRs land as merge commits here, so first-parent = one entry per PR), recovers each
  PR number from the merge subject — falling back to the associated-PRs API for squashes and direct
  pushes — and renders title + link + author plus a summary line lifted from the PR body (skipping
  the leading `## What changed` heading and the Claude footer). Output goes to BOTH the release body
  and a prepended [CHANGELOG.md](../CHANGELOG.md) section. Commits with no PR behind them get an
  "Other changes" list rather than being dropped. It's `.mjs` on purpose: package.json has no
  `"type": "module"` and must not gain one — `electron/main.js` and `scripts/adhoc-sign-mac.js` are
  CommonJS. The `SECTIONS` label map (enhancement→Features, bug→Fixes…) is a no-op today since no
  PR carries labels; everything falls into **Changes** until they do.
  The install instructions (Gatekeeper / SmartScreen / apt / dnf) live in `INSTALL_NOTES` in that
  script, NOT in the workflow YAML — builds are **unsigned** and every release must carry them.
  The `build:` block in package.json controls what gets packaged and the installer targets. App
  icons live in `build/` (`icon.icns/.ico/.png`, generated from `build/icon-src/`).
- **The version line in CREDITS** comes from a RELATIVE `fetch('package.json')` in main.js — the one
  version source `src/` can read without breaking host-agnosticism (it resolves the same under serve.py
  and over `app://`, which is registered `supportFetchAPI`). `package.json` is listed in the
  electron-builder `files` block so it stays fetchable from the asar. It is **only accurate on a release
  build**: a dev checkout's package.json lags the newest `v*` tag, which is the real source of truth. A
  failed fetch drops the version silently rather than showing a broken line.

