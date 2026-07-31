# Changelog

All notable changes to Solar Slinger, newest first. Entries are generated from
the pull requests merged since the previous release — see
[scripts/changelog.mjs](scripts/changelog.mjs) and the
[Build & Release](.github/workflows/release.yml) workflow. Don't hand-edit an
entry expecting it to stick; fix the PR title or description instead.

Releases predating this file are on the
[Releases page](https://github.com/mark3apps/solar-slinger/releases).

## [0.2.0] — 2026-07-31

### Changes

- **Automatic ability ranks, faster front-loaded climb, tougher planets, half-shield soak** ([#31](https://github.com/mark3apps/solar-slinger/pull/31)) — @mark3apps
  Rebuilds progression around two parallel tracks fed by one XP stream: abilities deepen automatically as you earn XP, and cards are now only ever used to learn something new.
- **Ship specializations: brawler innate ram + Deflector parry, Wall Splat, Hauler Dead Stop** ([#30](https://github.com/mark3apps/solar-slinger/pull/30)) — @mark3apps
  Makes the specializations feel mechanically distinct at early levels instead of playing like the base ship with bigger numbers — the brawler especially.
- **Speed up the whole tier climb by a third** ([#29](https://github.com/mark3apps/solar-slinger/pull/29)) — @mark3apps
  Every tier upgrade now arrives about a third sooner. The XP-to-next-pick curve is scaled by 2/3 — XPBASE 60→40, XPSTEP 30→20, XPCURVE 3→2.
- **Expedition update: six exploration features (chart everything, friendly NPCs, quests, moon jobs)** ([#28](https://github.com/mark3apps/solar-slinger/pull/28)) — @mark3apps
  A content update from a pitch session on adventure/exploration mechanics — six features, all built on existing systems (rails, echo logs, EVENTMSGS, pickups, the hazard loop) with…
- **Random world seeds, a perf overlay, and the build version** ([#26](https://github.com/mark3apps/solar-slinger/pull/26)) — @mark3apps
  Three gaps in the front-end shell. Nothing in physics.js, world.js, render.js, tractor.js, ai.js or config.js is touched — no physics invariant is in scope.
- **Progressive damage: cracks, scars, chunk sprays, and planet-chunk debris** ([#27](https://github.com/mark3apps/solar-slinger/pull/27)) — @mark3apps
  Big entities no longer fail all-or-nothing — they crack, scar, and shed real debris as they take damage, and a dying world comes apart into a cloud of planet chunks.
- **Auto-update: Windows + Linux AppImage self-update, check-and-notify on macOS and deb/rpm** ([#25](https://github.com/mark3apps/solar-slinger/pull/25)) — @mark3apps
  The desktop app now keeps itself up to date: Windows and the new Linux AppImage download releases in the background and install on quit, while macOS and deb/rpm builds check for…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.1.24...v0.2.0

## [0.1.24] — 2026-07-31

### Changes

- **Oort cloud redesign: a living glacial wall instead of a dotted ring** ([#24](https://github.com/mark3apps/solar-slinger/pull/24)) — @mark3apps
  The world edge was a faint fog stroke, one dull red ring, and 420 static dots — effectively invisible at gameplay zoom. This rebuilds the Oort cloud as a living glacial wall…
- **Manual releases with generated changelogs** ([#23](https://github.com/mark3apps/solar-slinger/pull/23)) — @mark3apps
  Releases stop being a side effect of merging. The workflow is now manually triggered, takes a patch/minor/major bump, and builds its release notes from the pull requests merged…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.1.23...v0.1.24

