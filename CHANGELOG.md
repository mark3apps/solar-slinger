# Changelog

All notable changes to Solar Slinger, newest first. Entries are generated from
the pull requests merged since the previous release — see
[scripts/changelog.mjs](scripts/changelog.mjs) and the
[Build & Release](.github/workflows/release.yml) workflow. Don't hand-edit an
entry expecting it to stick; fix the PR title or description instead.

Releases predating this file are on the
[Releases page](https://github.com/mark3apps/solar-slinger/releases).

## [0.3.0] — 2026-07-31

### Changes

- **Cap shoal XP farming, pay XP for achievements, and make the fields high-risk** ([#40](https://github.com/mark3apps/solar-slinger/pull/40)) — @mark3apps
  The dense asteroid fields were the optimal way to play: park in a shoal, grind gravel, get fully upgraded in about a minute. This closes that, then makes the pockets dangerous…
- **Faster lurker shoves, bigger broods, and organic field outlines** ([#39](https://github.com/mark3apps/solar-slinger/pull/39)) — @mark3apps
  Three asks about the dense asteroid fields: the lurkers threw rocks too slowly, there weren't enough of them in the shoal, and the pocket read as a square.
- **Gate abilities that are inert without a prerequisite** ([#38](https://github.com/mark3apps/solar-slinger/pull/38)) — @mark3apps
  Five abilities in the catalog were dead cards: taking one spent your pick and started its rank bar climbing while nothing whatsoever happened in the world. They're now hidden from…
- **Dense asteroid fields, shoal lurkers, and a 20% larger world** ([#37](https://github.com/mark3apps/solar-slinger/pull/37)) — @mark3apps
  Four vast rock shoals at fixed radii — The Shoal (10,400), The Grindstones (23,000), The Hushfield (33,500), and The Farshoal (44,300, on the new outer band's frost fringe). Each…
- **Five new planet archetypes, each with its own mechanic** ([#36](https://github.com/mark3apps/solar-slinger/pull/36)) — @mark3apps
  The system had four planet types (lava / rocky / gas / ice) and no earth-like world. This adds five solid archetypes — terran, ocean, desert, shroud, crystal — and three gas-giant…
- **Minimap: two-scale dial, ping-only outer band, honest sun** ([#35](https://github.com/mark3apps/solar-slinger/pull/35)) — @mark3apps
  The radar now runs two scales on one radius. The inner half is unchanged — 1:1 with the old dial, out to MINIMAPNEAR (2600u). The outer half is zoomed out 2x, covering 5200u…
- **Expand the soundtrack to 24 tracks: title + menu beds, and move music to Git LFS** ([#34](https://github.com/mark3apps/solar-slinger/pull/34)) — @mark3apps
  The soundtrack goes from ten tracks to 24, the splash and pause menus get music of their own, and the music beds move to Git LFS. Fourteen new Scott Buckley CC-BY tracks…
- **Achievements: 370 run-scoped rows, a score, and a hover-readout log** ([#33](https://github.com/mark3apps/solar-slinger/pull/33)) — @mark3apps
  Adds achievements — a third progression track that costs the other two nothing. 370 rows across ten categories grant points (prog.ach.score), never XP, ranks or picks, so the…
- **Perf pass: 2-4x sim headroom for bigger solar systems** ([#32](https://github.com/mark3apps/solar-slinger/pull/32)) — @mark3apps
  A performance pass on the simulation so the solar system can keep growing. At 120Hz the frame budget is 8.3ms; the old code spent ~7ms at 2x today's body count, dominated by two…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.2.0...v0.3.0

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

