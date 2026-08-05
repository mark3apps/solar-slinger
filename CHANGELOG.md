# Changelog

All notable changes to Solar Slinger, newest first. Entries are generated from
the pull requests merged since the previous release — see
[scripts/changelog.mjs](scripts/changelog.mjs) and the
[Build & Release](.github/workflows/release.yml) workflow. Don't hand-edit an
entry expecting it to stick; fix the PR title or description instead.

Releases predating this file are on the
[Releases page](https://github.com/mark3apps/solar-slinger/releases).

## [0.6.0] — 2026-08-05

### Changes

- **QA: fix the 9 high and 6 medium findings from the post-merge review** ([#155](https://github.com/mark3apps/solar-slinger/pull/155)) — @mark3apps
  Closes #137, #138, #139, #140, #141, #142, #143, #144, #145, #146, #147, #148, #149, #150, #151.
- **The shield is SCOUT-ONLY — delete the brawler's War Plating** ([#154](https://github.com/mark3apps/solar-slinger/pull/154)) — @mark3apps
  The BRAWLER shouldn't have a shield ability at all, so warPlating (War Plating) is deleted.
- **Bigger sky: 2x sun, grown worlds, seeded per-run layouts** ([#136](https://github.com/mark3apps/solar-slinger/pull/136)) — @mark3apps
  A full growth-and-variety pass on world generation, all user-directed:
- **Add SHIP SYSTEMS instrument cluster to the cockpit HUD** ([#135](https://github.com/mark3apps/solar-slinger/pull/135)) — @mark3apps
  Adds a bottom-right instrument cluster to the flight HUD showing the ship's live build and flight state, styled as an aircraft instrument panel rather than a plain stat table.
- **Rework ship loadouts and rebuild the brawler around a density-tiered ram** ([#134](https://github.com/mark3apps/solar-slinger/pull/134)) — @mark3apps
  No innate abilities. The brawler's hidden spec-DNA ram floor (ramMul 1.35 / ramArmor 0.85 in shipStats) is gone — every spec starts at the universal base and differs only by kit…
- **fix(devtest): stage dock tests against live state, not worldgen's** ([#133](https://github.com/mark3apps/solar-slinger/pull/133)) — @mark3apps
  window.mechTest was failing 4/31 on main since #132 — T15 "dock: three gates latch a berth" plus the three dependent dock tests.
- **Balance: temper damage scaling sky-wide, re-price hp and throw speeds** ([#132](https://github.com/mark3apps/solar-slinger/pull/132)) — @mark3apps
  Damage in Solar Slinger scaled linearly with impactor mass (dmg = K·(closing−thresh)²·mass·dom), and mass spans 10 → 650,000 — so damage output ran away as things got bigger and…
- **QA fix: never name a hidden world in a dock message** ([#122](https://github.com/mark3apps/solar-slinger/pull/122)) — @mark3apps
  Closes #106.
- **QA fix: restore game.paused after mechTest, and make T23 clean up in a finally** ([#126](https://github.com/mark3apps/solar-slinger/pull/126)) — @mark3apps
  Closes #110.
- **QA fix: put the `draws` tripwire in mechTest's console table** ([#121](https://github.com/mark3apps/solar-slinger/pull/121)) — @mark3apps
  Closes #105.
- **QA fix: drop gravel that never found room, instead of burying it** ([#123](https://github.com/mark3apps/solar-slinger/pull/123)) — @mark3apps
  Closes #107.
- **QA fix: name the failure the stormStrength floor actually guards** ([#125](https://github.com/mark3apps/solar-slinger/pull/125)) — @mark3apps
  Closes #109.
- **QA fix: correct the hullsWorld cache comment's claim about railed rock** ([#124](https://github.com/mark3apps/solar-slinger/pull/124)) — @mark3apps
  Closes #108.
- **QA fix: correct the resetBodyIds rationale — the ship carries no id** ([#127](https://github.com/mark3apps/solar-slinger/pull/127)) — @mark3apps
  Closes #111.
- **QA fix: an automatic hull rank must not disarm "Limped In"** ([#128](https://github.com/mark3apps/solar-slinger/pull/128)) — @mark3apps
  Closes #112.
- **QA fix: delete FIELD_LANE_APART, a lane rule the network form retired** ([#129](https://github.com/mark3apps/solar-slinger/pull/129)) — @mark3apps
  Closes #114.
- **QA fix: remove the manifold's dead, always-zero per-point depth** ([#130](https://github.com/mark3apps/solar-slinger/pull/130)) — @mark3apps
  Closes #115.
- **QA fix: re-derive three stale ~7,600 field-rock citations in src/** ([#120](https://github.com/mark3apps/solar-slinger/pull/120)) — @mark3apps
  Closes #113.
- **QA fix: collide shaped rock against the outline it is drawn as (finding #102 on PR #83)** ([#119](https://github.com/mark3apps/solar-slinger/pull/119)) — @mark3apps
  Automated fix for the day's one HIGH-severity QA finding. Draft on purpose — a human still needs to approve. This is the largest of today's three and it touches physics.js, so the…
- **QA fix: gate the deflector's tells on one predicate (finding #103 on PR #99)** ([#118](https://github.com/mark3apps/solar-slinger/pull/118)) — @mark3apps
  Automated fix for a QA finding. Draft on purpose — a human still needs to approve.
- **QA fix: pin the mechTest harness view (finding #104 on PR #100)** ([#117](https://github.com/mark3apps/solar-slinger/pull/117)) — @mark3apps
  Automated fix for a QA finding. Draft on purpose — needs a human decision, and this one is not a routine "bug fixed" PR. See the honesty note below.
- **Give SCOUT and BRAWLER their own hull ladders** ([#101](https://github.com/mark3apps/solar-slinger/pull/101)) — @mark3apps
  The player hull was one spec-agnostic table (SHIPTIERS), so all three specialisations flew the same ship. It's now three ladders dispatched on game.prog.spec via shipTierTable.
- **Make mechTest genuinely bit-repeatable, cover the pilot card, and answer #85's measurement** ([#100](https://github.com/mark3apps/solar-slinger/pull/100)) — @mark3apps
  Closes #96. Closes #85. (#91 was already fixed on main by d989c81; verified and closed separately.)
- **QA sweep: 11 issues — dock gating, fracture hp, chart leak, duplicate achievement id, stale docs, and docking/storm/parry coverage** ([#99](https://github.com/mark3apps/solar-slinger/pull/99)) — @mark3apps
  Closes #77, #84, #86, #87, #88, #89, #90, #92, #93, #94, #95, #97.
- **Delete the util-side half of the old shaped-rock collider** ([#98](https://github.com/mark3apps/solar-slinger/pull/98)) — @mark3apps
  2f5162c replaced the sampled radial collider with rockshape.js's SAT narrow phase, but the util.js half of it survived as runtime-dead code. Six exports were imported by nothing…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.5.0...v0.6.0

## [0.5.0] — 2026-08-03

### Changes

- **Baked rock shape + fracture library, replacing the shoal's sampled collider** ([#83](https://github.com/mark3apps/solar-slinger/pull/83)) — @mark3apps
  The shoal's collider is replaced with a baked shape library that is also a fracture tree, plus a pass of playtest fixes on top of it.
- **Pilot card reads bottom-up, and an owed pick is offered rather than forced** ([#82](https://github.com/mark3apps/solar-slinger/pull/82)) — @mark3apps
  Two user calls on the abilities window in the bottom-left.
- **Land on worlds: surface friction, dock stations and home ports** ([#80](https://github.com/mark3apps/solar-slinger/pull/80)) — @mark3apps
  Makes a world somewhere you can stop. Everything else in this game treats a planet as an obstacle, a resource or a weapon; this adds the one verb that treats it as a place.
- **Deflector: aim the riposte with the cursor, not a flick** ([#81](https://github.com/mark3apps/solar-slinger/pull/81)) — @mark3apps
  The Deflector parry no longer fires on a mouse flick. The window is the timer and the cursor is the aim: when the freeze window runs out, every held rock launches along…
- **Three solar wave intensities, and every moon shelters from them** ([#79](https://github.com/mark3apps/solar-slinger/pull/79)) — @mark3apps
  The sun threw exactly one thing, and moons only pretended to block it. This
- **Fix the five open QA findings, and re-derive the body counts they exposed** ([#78](https://github.com/mark3apps/solar-slinger/pull/78)) — @mark3apps
  Clears the open qa-bot issues: four real bugs (#73, #74, #75, #76) and the doc-drift sweep (#77). #72 needs no change — see below.
- **Make a debris cascade cheap enough to be 10x bigger** ([#70](https://github.com/mark3apps/solar-slinger/pull/70)) — @mark3apps
  A cascade produced ~1,500 pieces, hard-capped by DEBRISBUDGET because every piece was a full Body. It now produces 12,000+, and a piece costs 29× less (4.9µs → 0.17µs of sim).
- **Add the system chart, and a journey to plot on it** ([#71](https://github.com/mark3apps/solar-slinger/pull/71)) — @mark3apps
  A sun-centred system chart over the whole screen, and a multi-stop journey you can plot on it and then fly.
- **Rock silhouettes, and grade the shoals from the heart outward** ([#67](https://github.com/mark3apps/solar-slinger/pull/67)) — @mark3apps
  Two related pieces of shoal work: what a rock looks like, and where the rock is.
- **Give the cockpit an accent that follows where the ship is** ([#69](https://github.com/mark3apps/solar-slinger/pull/69)) — @mark3apps
  The cockpit chrome was one violet everywhere. It now takes an accent from where the ship is, switched by a new locale director in src/zone.js — built deliberately as the same…
- **Make a planet system rare, big, and an event** ([#68](https://github.com/mark3apps/solar-slinger/pull/68)) — @mark3apps
  The sky is spread 30% wider, holds ~80% as many worlds, gives every surviving one a ~30% bigger moon family reaching ~30% further out, and turns one way.
- **Make the combat damage ladder bit-exact** ([#66](https://github.com/mark3apps/solar-slinger/pull/66)) — @mark3apps
  ladder[fieldRock]. swung 170x on unchanged code. Ten bench.mjs diff combat runs against an identical working tree gave rock2500@700 = 2, 99, 104, 146, 185, 265, 310, 315, 339, 345.
- **Rebuild the dense fields as a maze made of huge, breakable rock** ([#65](https://github.com/mark3apps/solar-slinger/pull/65)) — @mark3apps
  The shoals were a uniform cloud of gravel — dense in every direction, so there was no route through one, only more of the same. They are now packed with 124–131 landmark rocks…
- **Make the combat ladder's heaviest rung deterministic** ([#63](https://github.com/mark3apps/solar-slinger/pull/63)) — @mark3apps
  node .claude/skills/run-solar-slinger/bench.mjs diff combat gave four different answers across four runs on completely unmodified code. CLAUDE.md gates every src/ change on that…
- **Make a gas giant erupt boulders instead of dust** ([#64](https://github.com/mark3apps/solar-slinger/pull/64)) — @mark3apps
  A hit gas giant threw 3–15 pieces sized 1.2–4.2% of its radius. Measured on Sable (radius 1,148):
- **Rebuild the pilot card around a mounted XP rail** ([#62](https://github.com/mark3apps/solar-slinger/pull/62)) — @mark3apps
  The XP bar used to float alone at the top centre of the canopy, with no relationship to the ability list it fills toward. This moves it onto the pilot card and reworks the card…
- **Rework the beam: class ladder, winch, wind-up, and what a throw looks like** ([#61](https://github.com/mark3apps/solar-slinger/pull/61)) — @mark3apps
  Reworks how the tractor beam decides what it can lift, how hard it can push it, and what any of that looks like. Driven end-to-end by playtest feedback, so it's a series of…
- **Route the eclipse through traceSurface, and glint cored chunks** ([#60](https://github.com/mark3apps/solar-slinger/pull/60)) — @mark3apps
  Two render.js fixes. Fixes #52 and #53.
- **Gas giant: subject the swallow to the conjunction guard, and stop double-draining the vent timer** ([#59](https://github.com/mark3apps/solar-slinger/pull/59)) — @mark3apps
  Two independent gas-giant defects in physics.js. Fixes #50 and #51.
- **Measure the generated sky in worldgen, not the surviving one** ([#58](https://github.com/mark3apps/solar-slinger/pull/58)) — @mark3apps
  worldgen.js declares every metric it returns time-invariant, and bench.mjs diffs all of them EXACT. Two fields broke that contract and went red on unmodified code in run after run.
- **Select field membership structurally in the worldgen suite** ([#57](https://github.com/mark3apps/solar-slinger/pull/57)) — @mark3apps
  Fixes #55.
- **Gather a world's satellites once instead of per belt slot** ([#56](https://github.com/mark3apps/solar-slinger/pull/56)) — @mark3apps
  Fixes #54.
- **Stop dropped rocks keeping the force that was holding them** ([#49](https://github.com/mark3apps/solar-slinger/pull/49)) — @mark3apps
  A bug-fix sweep. The load-bearing find is one state-cleanup miss with two sites, both on the ship-death path.
- **Slim CLAUDE.md into docs/, add a diffable test harness, and fix moons dying at conjunction** ([#48](https://github.com/mark3apps/solar-slinger/pull/48)) — @mark3apps
  CLAUDE.md drops from 143 KB to 19 KB, the repo gains a five-suite test harness that shows you what a change moved, and one 29-line physics fix stops moons being destroyed by an…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.4.0...v0.5.0

## [0.4.0] — 2026-08-01

### Changes

- **Give every ability six ranks, and hold the ceilings while doing it** ([#47](https://github.com/mark3apps/solar-slinger/pull/47)) — @mark3apps
  Every ability is six ranks. The catalog ran 1/3/4/6, which was three different kinds of card wearing one name: a max: 1 row arrived already maxed — its bar was decoration and the…
- **Make worlds come apart: crust debris, cratered colliders, gas-giant strips** ([#46](https://github.com/mark3apps/solar-slinger/pull/46)) — @mark3apps
  The root cause first: every fragment system in the game was dead code. Chunk spray, spall, a dying world's debris cloud and the BRAWLER's Cluster Rounds all gated on…
- **Reset the run and roll a new world when backing out to the main menu** ([#45](https://github.com/mark3apps/solar-slinger/pull/45)) — @mark3apps
  MAIN MENU now ends the run. It used to only flip game.started to false, so the splash sat over a paused, half-played world and START silently resumed it. The title screen has no…
- **Build planets up to 3x and moons 2x their authored size** ([#44](https://github.com/mark3apps/solar-slinger/pull/44)) — @mark3apps
  Planets and moons are now built much bigger than the layout table authors them, so the sky reads as genuinely massive. Two constants in config.js drive it — PLANETRMUL (3) and…
- **Make the solar wave a real event: plasma sheath, world shelter, sensor blackout** ([#43](https://github.com/mark3apps/solar-slinger/pull/43)) — @mark3apps
  The solar storm did nothing, and the reason turned out to be geometric rather than a matter of tuning. The front was 2 × STORMBAND = 1400u thick travelling at 950 u/s, so it…
- **Scale the frame to a doubled world: registries, instanced rocks, worker minimap** ([#42](https://github.com/mark3apps/solar-slinger/pull/42)) — @mark3apps
  Three cuts at the same problem, plus a dev-server fix found on the way.
- **Cut frame cost: render scale, substep cap, rock sprite atlas** ([#41](https://github.com/mark3apps/solar-slinger/pull/41)) — @mark3apps
  Three independent optimizations against a report of ~15fps on an older Mac. Profiling the running game found the frame split across three separate bottlenecks, so this attacks all…

**Full changelog:** https://github.com/mark3apps/solar-slinger/compare/v0.3.0...v0.4.0

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

