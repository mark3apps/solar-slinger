# Solar Slinger

A top-down 2D gravity-sandbox space game. Fly a ship through a single-sun system where every body
moves under N-body gravity, grab things with a tractor beam, and fling them.
**Vanilla JS + HTML5 canvas, ES modules, no build step by default.** A thin desktop
layer (Electron + release CI) rides alongside; everything under `src/` stays packaging-agnostic.
Dependencies are **allowed but not free** — see [Dependencies](#dependencies) for the bar one has to
clear and what must never change.

## Read before you edit

This file is the map. The *why* — every tuned constant, every rule that guards a real past bug —
lives in `docs/`. **Open the matching doc before editing, not after.**

| Editing | Read first |
|---|---|
| `physics.js`, rails, gravity, collisions, `CFG` hazard tuning | [docs/physics-invariants.md](docs/physics-invariants.md) |
| `config.js` progression, `ABILITIES`, `shipStats`, `achievements.js` | [docs/progression.md](docs/progression.md) |
| `render.js`, `hud.js`, `style.css`, `zone.js`, any new sprite or HUD element | [docs/design-laws.md](docs/design-laws.md) |
| `world.js` generation, dense fields, the LOD, planet archetypes, `ai.js`, `glow.js` | [docs/world-content.md](docs/world-content.md) |
| `rockshape.js`, `rockdata.js`, `tools/bake-rocks.mjs`, shaped-rock collision | [docs/rock-fracture.md](docs/rock-fracture.md) |
| `main.js` frame loop, `CFG.DT`, pacing, which clock a system rides | [docs/architecture.md](docs/architecture.md) |
| splash / pause / settings / controls / credits / achievements / system chart | [docs/shell-and-menus.md](docs/shell-and-menus.md) |
| `starmap.js`, the chart's knowledge ladder, journey waypoints | [docs/design-laws.md](docs/design-laws.md) |
| `sfx.js`, `music.js`, adding a sound to an event | [docs/audio.md](docs/audio.md) |
| `electron/`, `package.json` `build:`, release workflow, changelog | [docs/packaging.md](docs/packaging.md) |
| verifying any change | [docs/testing.md](docs/testing.md) |

Anything the user has called a design law is a **regression when violated, even if the code
"works"**. The laws are indexed below; the reasoning is in the docs.

## Baseline before, diff after — do this for every `src/` change

**Snapshot a baseline BEFORE editing, and diff AFTER.** This game has no test runner and its failure
mode is silent: a tuning change three files away quietly deorbits a moon, or turns a whole fragment
system into dead code, and nothing errors. The diff is how that becomes visible.

```bash
B=.claude/skills/run-solar-slinger/bench.mjs
node $B save <suites>      # BEFORE you edit — snapshot
node $B diff <suites>      # AFTER — prints only what moved
```

**Scope it to what you're touching** — that is what keeps it cheap. Pick the suites from the file
you're about to edit:

| Editing | Suites to baseline | Measured cost |
|---|---|---|
| `world.js` generation | `worldgen` | **1s** |
| `config.js` progression / `ABILITIES` / `shipStats` | `progression` | **0.6s** |
| `config.js` damage / hp / durability | `progression combat` | ~4s |
| `physics.js`, rails, gravity, collisions, `CFG` hazards | `stability combat` | ~16s |
| `render.js`, hot loops, the LOD, registries | `perf` | ~11s |
| anything you're unsure about, or a multi-file change | all — `node $B save` with no args | ~20s |

`worldgen` and `progression` need no simulation at all, so there is no excuse to skip them.

Rules that make this worth doing:

- **Baseline FIRST.** A baseline taken after the edit is worthless, and there is no way to recover it
  short of stashing the change.
- **Read the diff, don't skim the exit code.** Red = an EXACT field moved (structure, integrity,
  economy) — one moon, one NaN, one off-rail planet is the entire point. Yellow = a banded field
  cleared its tolerance.
- **Noise floor is 0–2 fields.** More than that with no intended cause means something real moved.
- **Report what moved in your summary**, including the fields you *expected* to move. "6 fields
  changed, 4 were the intended hp bump and its knock-on hits-to-kill" is the useful sentence.
- **Skip it only when nothing under `src/` changed** — docs, skills, and packaging edits don't need it.

Full suite list, tolerance policy and how to add a suite: the **`run-solar-slinger`** skill.

## Tooling

Skills wrap the recurring procedures; subagents audit a diff against the rules it can silently break.

| Skill | For |
|---|---|
| `balance-test` | long-horizon sky stability — `window.soak` against the 17-planet/59-moon baseline |
| `mechanics-test` | fast "did I break the game loop?" — the fixed-seed `window.mechTest` suite |
| `playtest` | **the default way to drive the game** — Browser pane: park the ship, force the event, screenshot it |
| `run-solar-slinger` | clean-machine setup + scripted/unattended runs (Electron driver, nothing visible) |
| `perf-profile` | measure frame/sim/draw cost and A/B it without falling into the hidden-pane trap |
| `add-ability` | the catalog row + `shipStats` channel + runtime hook recipe, and the dead-card check |
| `add-achievement` | the catalog row recipe, and the frame-one freebie sweep every new row needs |
| `release` | drive the `workflow_dispatch` release and verify the auto-update feed |

| Subagent | Audits |
|---|---|
| `physics-reviewer` | physics.js / tractor.js / ai.js / rails / CFG tuning vs the invariants |
| `visual-language-reviewer` | render.js / hud.js / style.css vs the visual grammar + canvas discipline |
| `progression-auditor` | ABILITIES / shipStats / XP curve / achievements vs the economy rules |
| `perf-auditor` | hot paths, the field LOD, the awake list, the registries, budgets and caches |
| `docs-keeper` | whether a change left CLAUDE.md, `docs/`, a skill or an agent stale |

## Run it

```sh
python3 serve.py
```

Serves `http://127.0.0.1:8642` (or `preview_start` with name `solar-slinger` — never Bash for the
server). Edit a `.js`, reload, see it live. **Keep it that way**: the edit-reload loop is the reason
this project is fast to work on, so a dependency that forces a bundle step between editing and seeing
it is a real cost, not a detail (see [Dependencies](#dependencies)).

Two setup traps that cost real time:

- **Clone with [Git LFS](https://git-lfs.com)** (`brew install git-lfs && git lfs install`). The 24
  music beds (~176 MB) are LFS-tracked. Without it you get 130-byte pointer files and the game runs
  **SILENT with no error pointing at the cause**. `git lfs pull` fixes a bad clone.
- **Don't replace `serve.py` with `python3 -m http.server`.** It must stay **no-cache** (browsers
  otherwise cache the ES modules and every edit runs stale) and **`ThreadingHTTPServer`** (single-
  threaded, `minimap-worker.js` holds a keep-alive connection and starves every other request —
  the server stops answering mid-session and the page hangs on an import that never resolves).
  ES modules don't load over `file://`, which is also why the Electron shell serves over `app://`.

## Architecture

Single `game` object (built in [main.js](src/main.js) `:13-52`) is the source of truth, passed by
reference into nearly every function. Fixed-timestep physics inside a variable-timestep
presentation loop.

| Module | Owns |
|---|---|
| [main.js](src/main.js) | Orchestrator + the `game` object + the rAF/`update`/`render` loop. Runs at import time (no `init()` wrapper). |
| [config.js](src/config.js) | All tuning constants (`CFG`, `TIERS`, `PROG`), the `SPECS` + `ABILITIES` catalog, and the pure `newProgress` / `shipStats` / `tierChoices` / `applySpec` / `applyTierUp` / `addXp` / `growAbilities` / `abilityRankCost` derivations. |
| [entities.js](src/entities.js) | The only classes: `Body`, `Ship`, `Alien`. Plus `railBody`/`derail`, `scrapValue`, `makeScrap`. |
| [world.js](src/world.js) | `generateWorld` (seeded), `respawnShip`, `replenishWorld`, `spawnAsteroid`. |
| [physics.js](src/physics.js) | `step` — N-body integration, collisions/damage, rails, the trajectory predictor. **The load-bearing file.** |
| [tractor.js](src/tractor.js) | Grab / hold / fling, the aim lead-marker solver, the orbit shield. |
| [ai.js](src/ai.js) | Alien state machines (grabbers, wreckwrights, golems, shoal lurkers), Bastion forts, nests. |
| [glow.js](src/glow.js) | Glow pockets — the healing mote fields. Rides `dtReal`, never the fixed step. |
| [achievements.js](src/achievements.js) | The run's scoreboard: the ~400-row catalog, the stat ledger, the per-frame predicate sweep. Imports only config — a near-leaf. |
| [rockdata.js](src/rockdata.js) | GENERATED (`tools/bake-rocks.mjs`). The fixed asteroid shape library and its fracture tree — 68 shapes in 5 families, each child CUT from its parent so the pieces tile it exactly. Imports nothing. |
| [rockshape.js](src/rockshape.js) | The narrow phase for shaped rock: convex-hull SAT with a true MTV and real contact manifolds, plus the fracture-tree lookups world.js packs against. Imports only rockdata.js. Drives every `bigShape` pair in physics.js — see [docs/rock-fracture.md](docs/rock-fracture.md). |
| [gravel.js](src/gravel.js) | The SoA store for small, anonymous debris — typed arrays, stable slot handles, contiguous integrate. A grain PROMOTES to a real `Body` the moment the beam reaches it. Imports nothing. |
| [render.js](src/render.js) | All canvas drawing. Owns the 2D context. Delegates bulk rock draws to rockgl.js and the minimap dot bake to minimap-worker.js — both behind fallbacks. |
| [rockgl.js](src/rockgl.js) | Instanced WebGL2 rock layer: a shoal's ~910 blits become one draw call per sheet. Engaged past `GL_ENTER` rocks; falls back to 2D blits on any failure. |
| [minimap-worker.js](src/minimap-worker.js) | The radar's dense-field dot layer, baked off-thread to an ImageBitmap. Its sweep math MIRRORS `drawMinimap`'s — retune both together. |
| [hud.js](src/hud.js) | All DOM/HUD access (cached in `el`). The sim never touches the DOM. |
| [input.js](src/input.js) | Raw keyboard/mouse state + listeners. |
| [sfx.js](src/sfx.js) | Audio engine: the AudioContext + sfx/music buses. Every sound is a real CC0 recording — see [docs/audio.md](docs/audio.md). |
| [music.js](src/music.js) | Adaptive music director: 24 CC-BY tracks in six playlists, exactly one playing at a time — see [docs/audio.md](docs/audio.md). |
| [zone.js](src/zone.js) | Locale director: which of five places the ship is in, and the crossfaded accent colour the cockpit chrome takes there. Same bucket/hysteresis/dwell machine as music.js, but its presence scores are pure geometry over the frame registries. |
| [starmap.js](src/starmap.js) | The SYSTEM CHART's model: the sun-centred projection, the knowledge ladder (charted / seen / unknown / sensor-null) that decides what each contact may say about itself, and the journey route. Draws nothing — `render.drawStarMap` paints it, hud.js carries the DOM chrome, main.js owns the `mapOpen` flag. |
| [util.js](src/util.js) | Pure helpers (`lerp`, `mulberry32`, `rand`, `pick`, `TAU`, `shellModal`, `senseBlind`, `crystalShards`). |
| [devtest.js](src/devtest.js) | The scripted mechanics suite (`window.mechTest`). Lazy-loaded — normal play never imports it. |

**Import rules:** named exports only (no default exports), explicit `.js` extensions on every import
path (native browser ESM requires them), `config`/`util` are leaves. `config.js` must never import
`achievements.js`.

### The loop, in brief

`frame(now)` → `dtReal = min(0.05, delta)` → `update(dtReal)` **only while `game.started && !paused
&& !settingsOpen && !choosingUpgrade`** → always `render` + `updateHud`. Rendering continues while
frozen; the sim freezes. Physics runs on a fixed substep accumulator at `game.simDt` (`CFG.DT`
1/120, or `CFG.DT_COARSE` 1/60 when the machine can't keep up).

- **Gameplay math goes inside the fixed-step loop.** Only cosmetic easing with no quantized target
  (shake decay, zoom ramp) rides `dtReal`. Frame-rate-independent easing: `lerp(a, b, 1 - exp(-k*dt))`.
- **The camera follow is inside the fixed-step loop too**, not on `dtReal` — phase-locking ship and
  camera to one clock is what keeps flight smooth.
- **Every headless path is pinned to `CFG.DT`** so soaks are repeatable per machine.

Full pacing/backlog/`DT_COARSE` rules: [docs/architecture.md](docs/architecture.md).

## Conventions

- **Only `Body`/`Ship`/`Alien` are classes.** Everything else is free functions taking `game` (or an
  array) first and mutating in place. Scrap, rails, flares, bolts, turrets, `fort` are plain objects.
- **Naming:** `SCREAMING_SNAKE_CASE` config constants; `camelCase` everything else; terse locals are
  idiomatic (`b` body, `s` ship, `p` planet, `st` ship-stats, `prog` progression, `vx/vy`, `ax/ay`,
  `w` angular velocity).
- **Comments are load-bearing — they explain *why*, and most guard a real past bug.** Preserve the
  rationale comment when you touch a tuned constant or a physics decision. Never delete a
  "don't regress" comment without understanding the bug it names.
- **Event-flag messaging:** a subsystem signals a one-shot event by setting `game.<x>Warn` /
  `game.<x>Name`; `update()` in main.js drains and clears it and calls `hud.message(text, seconds)`.
  First-time-vs-repeat wording is gated on `game.tut.*` booleans. The audio grammar for an entry's
  optional `snd`: `sfxAlarm` = the ship is in danger NOW, `sfxWarnLow` = hostile contact / bad news,
  `sfxChime` = discovery / opportunity, `sfxLife` = triumph. Keep new events on that grammar.
- **Determinism:** world *generation* uses a seeded `mulberry32`, but the seed is **random per run**
  — pin one with `?seed=` for a repeatable world. The 15-planet/58-moon `layout` table in world.js
  is FIXED, so the seed varies placement, masses and features, never the structural counts: the
  balance baseline holds on any seed. (It censuses as **17 planets / 59 moons** — the layout's 15
  plus the crystal binary's companion and The Wanderer's Star, and the ring shepherd moonlet.) Runtime spawns/spall/AI intentionally use `Math.random`.
  Procedural sprite geometry is seeded off `b.id` and cached.
### Canvas discipline

- Pair every `translate`/`rotate`/`clip` with `save()`/`restore()`.
- Reset `globalCompositeOperation` to `'source-over'` and `globalAlpha` to 1 after additive passes.
- Divide UI/overlay line widths and dash arrays by `game.cam.zoom` so they stay constant on screen.
- One draw function per sprite type; hook new body types into `drawBody`'s type switch.

## The laws, indexed

One line each. **The reasoning — and the bug each one guards — is in the linked doc; read it before
changing anything it touches.**

### Physics invariants — DO NOT REGRESS → [docs/physics-invariants.md](docs/physics-invariants.md)

1. Snapshot every acceleration before integrating anyone (Phase 1 / Phase 2).
2. Hierarchical gravity weight is symmetric per pair; neighbour stars stay damped.
3. Ambient collisions below a closing-speed threshold do no damage; comparable-mass hits are capped.
4. >20× mass ratio → the heavy body is immovable; natural celestial impulse is damped, thrown is not.
5. Ship bounce kick is hard-capped at 200.
6. `WORLD_R` exceeds every system's outermost reach — enforced by construction in `world.moonZone`,
   not by arithmetic redone by hand; star-anchored bodies are exempt from the boundary force.
7. Chunk shedding is gated, or it cascades — and every fragment system answers to one debris budget.
   7b. A split must not chain (no credit propagation, `chainOk`, `CHUNK_INERT`).
8. A planet is its own durability class (flat `PLANET_HP_BASE` + gentle slope, not the mass curve).
9. So is a moon (`MOON_HP_BASE`/`MOON_HP_MUL`).

10. A shoal has FRICTION and SETTLES — field rock is damped toward its pocket's own flow (never
    toward rest) and re-rails once it rides with its neighbours again.
11. Two landmark rocks collide as SHAPES — convex-hull SAT against the baked decomposition
    (`rockshape.rockContacts`), returning a true MTV and real contact manifolds; with friction and
    spin. Two railed rocks of the same pocket normally skip collision — but a railed pair inside
    each other's reach falls through to the full narrow phase and the LIGHTER one is derailed
    (`stuckPair`), because a pocket that re-rails near home can seat a rock on top of a neighbour.
    (History: this was a multi-sample radial probe, `physics.bigPenetration`, until `2f5162c`.)

Also there: **rails** (circular vs elliptical are different objects; never re-rail inside
`game.viewR`), the ship's flow-relative speed ceiling, LONG ARMS, corona/lava heat, gas-giant
interiors, the orbit rubber band, fog of war, and the frame-relative trajectory forecast.

Plus **SURFACE FRICTION** (`CFG.SURF_FRICTION`): contact with a planet or moon drags the ship toward
the velocity of the ground under it (`util.surfaceVel` — the world's motion plus its spin's
tangential speed), so a skid matches the surface in under a second and the ship can be SET DOWN. Its
own three rules: it is planets and moons only (rock contact is tuned against every dense field), it
pays the body no reaction (invariant 4 makes a world immovable against the ship, and a torque on a
world's spin is a secular pump), and there is **nothing to mirror in `predictPaths`** — unlike the
rubber band and the long arms it exists only in contact, and the forecast terminates at contact.

Plus the three scaling rules that make a big debris cascade affordable:

- **The gravity loop reads a cached ATTRACTOR SHORTLIST**, not the whole sky — of 122 attractors only
  ~5 ever clear the influence cull. Exact, not approximate (the pad + the cull both stay).
- **The broad phase is sweep-and-prune and stays that way.** A uniform grid was built, measured
  (3.6x fewer candidate pairs, 0.977x wall clock) and reverted — read the note before re-deriving it.
  The lever for a cascade is FEWER BODIES, not a different search.
- **A world you left keeps its wounds, not its bodies** (`packHalos`): an off-view rubble halo
  collapses to a record on its host and returns piece-for-piece, freeing debris-budget slots.

### Gameplay + visual design laws → [docs/design-laws.md](docs/design-laws.md)

- **Flinging has no recoil**; the tractor tug reaction stays capped.
- **A big rock doesn't handle like a pebble** — beam authority falls with the load's fraction of your
  allowance (`TRACTOR_HEFT`, squared) and *spools up* over `TRACTOR_SPOOL`. The wind-up governs the
  **throw** as well as the hold (`beamGrip` feeds both), or grab-and-instant-fling and re-grab spam
  beat holding. Neither applies to the orbit shield or the brawler's trail rack.
- **A moon or a world must be WINCHED first** — `config.LATCH_BAND` bands it by class and MASS
  (small moons 1.6–2.6s, large 2.6–4.0s, worlds 4.0–5.8s); belt rock still takes hold on the click.
  The winch holds on the button and on range, never on the cursor, and its seconds carry into the
  wind-up — but capped, so **full power always lands after the latch** (`WINDUP_AFTER_LATCH`).
  **Gas giants can never be picked up at all** (`LIFT_NEVER`) — strip one and carry its core.
- **Full throw power is a COLOUR and a POP, never a progress bar** — the beam runs near-white while
  charged, plus a one-shot bloom on the crossing (`render.drawCharge`); only above `CHARGE_SHOW_HEFT`.
- **At full power the tether can't be broken** — it goes taut at `TETHER_MAX_MUL` × the beam ring and
  resolves as a rope (take separating velocity, split by mass). It **rubber-bands** into that limit
  (`TETHER_STRETCH`), and the rope's length is **state** (`b.ropeL`, reeled in at `TETHER_REEL`) —
  engaging at the constant instead snaps a lagging load across the gap in one frame.
  **Ship mass is per-tier** (`SHIP_MASS` 10 → 4,200): that ratio is the whole fight, so it can't
  stay constant.
- **Your own shot is the lowest-precedence grab target**: not a target *at all* for
  `CFG.THROW_LOCKOUT` (2s) after a beam launch, then merely demoted, and a loaded stow ring outranks
  it either way. Ladder: loose rock → orbit ring → your own shot.
- **The beam grips the SIDES of a body, never its middle**, and the winch VFX amps up from near-zero
  into the full hold (`render.gripPoints` / `drawLatch`).
- **Picking up a world unsticks its sky** — grabbing a planet/moon cuts every rail anchored to it;
  its family keeps its own momentum instead of being welded to the beam.
- **Throws never steer** — a rock flies exactly at the cursor *from its own held position*, never
  from the ship. Aim assist is informational only.
- **THE CRUMBLE LAYER DRAWS INSTANCED** — a chunk under 14 drawn units is a sprite from the SHARD
  atlas family, baked NEUTRAL and tinted per instance to its world's material (four atlas rows cover
  every world in the sky). A wounded chunk keeps the vector sprite: the GL layer composites after the
  body loop, so a crack web drawn inline would land underneath it.
- **Dashed lines are reserved for helper/aiming UI.** Real objects use solid strokes; always reset
  `setLineDash([])`.
- **The ship shield is a calm, steady rim glow** — no dashes, no idle motion; motion is for events
  only. **Shield down draws nothing at all.**
- **THE RADAR IS A SCAN; THE CHART IS A CHART.** The dial is ship-centred, forgets what the sweep has
  passed, and shows nothing past its rim. `starmap.js`'s system chart is sun-centred, remembers, and
  is the one instrument allowed to plot a place the scan has never swept — as a GUESS: a soft bloom
  at a deterministic offset (`ghostOff`, hashed off `b.id`, never re-rolled) inside an uncertainty
  ring. **TWO states and a floor**: **charted** (a clean lit disc — named, with its lane and family,
  and no outline) → **unexplored** (the bloom, and **only for worlds and shoals** —
  `starmap.plottable`; a moon never shows around a world you haven't found) → **`b.hidden` shows
  NOTHING, chart included** (the relay stays the only way to learn the Wanderer's Star exists).
  **Moons are icons, never labels**; belt rock is not on the chart at all. `hasFix` is not a third
  state — it only tightens the bloom and keeps the ROUTE honest, since a stop flown to a pure guess
  would never pop.
- **The chart is LIT, not drawn, and it has WEIGHT** — tight additive bloom over a hot core, seeded
  star dust, scanlines, a vignette, and orbit lanes that fade away from the body (one conic gradient,
  feature-checked); pan and zoom ease toward a target (`chartEase` on `dtReal`, zoom in log space,
  momentum taken from the drag's own lag). Close is an X in the corner, the journey rail does not
  exist until a journey does, the legend is swatch-and-word, and the readout carries a **live
  portrait** on the chart's own clock — a charted world turns with its moons, an unexplored one shows
  sensor static.
- **One LOD knob (`zk`, 0 at the fit scale → 1 by zoom 4)** carries everything that would otherwise
  clutter the wide view: moon lanes fade in, small contacts grow, POI labels and uncertainty circles
  wait for a zoom with room for them. Worlds label at every zoom — they are the skeleton.
- **A journey is an ORDERED path pinned to MOVING BODIES.** Everything on that chart orbits, so a
  stop is a body reference, not a coordinate; arrival pops the HEAD ONLY, at world.js's own chart-scan
  zone (so a stop ticks over exactly as the place names itself); a destroyed body leaves a flagged
  "lost contact" at its last position rather than silently vanishing from the list.
- **A WORLD IS SOMEWHERE YOU CAN STOP.** Set the ship down on a planet or moon ROCKETS-DOWN and hold
  still and it BERTHS (`physics.updateDock`): three gates — contact, the nose within `DOCK_ARC` of
  straight up, and surface-relative speed under `DOCK_SPEED` — all true for `DOCK_TIME`. The gates
  are deliberately GENEROUS; the interesting part is what a dock IS, not how tight the approach
  window is. **Attitude and stillness are ENTRY gates; only CONTACT holds a berth**, and the latch
  drains `DOCK_DRAIN`× faster than it fills, which is the whole of the hysteresis. A landing that
  silently declines to latch is this feature's worst failure mode, so the approach SHOWS ITS STATE —
  `render.drawDockGuide` fills an arc on the ship and names the gate that is refusing.
- **A DOCK IS A STRUCTURE, NOT A STATE.** Berth on bare ground and you BUILD one: `DOCK_BUILD` (10s)
  of staying put, during which you get **nothing** — the shield and the repair both gate on
  `physics.dockReady`, so those ten exposed seconds are the price. Once built the station STANDS on
  that world for the rest of the run; fly back and you berth instantly with everything live.
  `game.docks` holds them (bounded by `DOCK_MAX`), and `game.dock`/`game.home` are REFERENCES into
  it, never copies — the build clock ticks on the station.
- **A FINISHED DOCK IS A SAFE HARBOUR**: a shield dome over the berth and total damage immunity (one
  early-out in `damageShip`), plus `DOCK_HEAL` hull/s — the second sanctioned exception to "the hull
  never self-heals". The dome also **REPELS** loose rock and aliens (`updateDomeShield`) — immunity
  alone is half a shield. Its geometry is `config.dockDomeR`, the SAME expression render draws, which
  is why `DOCK_TIERS` lives in config.js: a field whose pushing edge and drawn edge were two
  expressions is the mirror-drift trap. The ship is **held UPRIGHT** while berthed (`DOCK_UPRIGHT`;
  the mouse stops steering, aiming is unaffected) and **pinned EXACTLY** to the pad — friction is an
  exponential approach and cannot hold station on a spinning world, so it left the hull creeping
  across its own dock.
- **LEAVING IS A SEQUENCE** (`CFG.LAUNCH_*`): thrust from a berth doesn't drive the ship, it calls a
  release — clamps swing open, then the engine lights against them, then the pad lets go with
  `LAUNCH_KICK`. Pinned to the pad's velocity throughout, and it commits once started.
- **A DOCK IS WHERE YOU STOP WORKING.** Beam, orbit ring, tether, shotgun and mobility abilities are
  all inert while berthed (`main.dockBlocking` refuses input AND update() skips their substep work —
  a half-live system re-welds a ring the dock just emptied). Anything in hand is dropped AT THE BERTH
  (`tractor.standDown`), gently, earning nothing. `dockBlocking` is NOT `menuBlocking`: H/M/V/P/R
  still work at a dock. And the pad **re-seats its standoff to the ship using it** on every berth —
  the hull grows from radius 4 to ~44 across the tiers, and the clamps pin it to exactly that height.
- **A HOME PORT IS A CHOICE, AND IT IS THE RESPAWN POINT.** Berthing is earned by flying; promoting a
  finished station to home is the H key, because it is the one act that moves where a death puts you
  back. One at a time, and **it dies with its world**. A station is `{ b, ang, rf, t }` — a body, a
  SURFACE-LOCAL bearing, a fraction of its radius (`util.padPos`) and its build seconds — never a
  coordinate: a world orbits AND spins, and a chipped-down world must keep its pad on the surface.
  HOME is the lives ROSE on all three surfaces (pad, dial, chart) because rose already means "a life"
  and one meaning must not wear three hues. **The station's ART tracks the SHIP'S TIER**
  (`config.DOCK_TIERS` via `dockTier`, 6 rows) — a dock is infrastructure you keep improving, so tiering up refits
  every station you own from a landing slab to a working spaceport.
- **Hover hint rings:** green = auto-orbits, cyan = holdable, red = too heavy.
- **The cockpit chrome is LOCALE-reactive; the instruments are not** (hull green / shield blue / lives
  pink stay semantic). `zone.js` picks the accent from WHERE THE SHIP IS — deep space violet, world
  gold, corona ice, shoal orchid, fringe glacial — each chosen to sit OPPOSITE that region's sky.
  Hue is the locale's; the edge wash's INTENSITY is still the music director's mood.
- **No hard edges in-world** — the world boundary and the Oort cloud are stochastic weather, never a
  stroke at an exact radius. In-world transitions are organic, never geometric.
- **A rock is never a perturbed primitive, and never convex** — a base shape plus noise reads as the
  base shape, however hard you rough it. `util.rockOutline` is the ONE generator for gravel and
  landmarks alike: lobes, stretch, 1/f grain, half-plane facets, concave bites and gouges, composed
  as a radial function (so the outline cannot self-intersect and there is no vertex sort to produce a
  sliver). A convexity guard cuts a notch into anything that comes out without one. It can be
  notched, waisted or hollowed — never hooked; an overhang would break the single radial query.
- **THE CRUMBLE:** a world under fire comes apart and the pieces stay; the crater you *see* is the
  crater you can fly into (one profile feeds render, physics and both predict mirrors).
- **AN ERUPTION THROWS BOULDERS, NOT DUST** — a hit gas giant must shoot stuff *out*, but as a few
  big pieces up one throat, never a hundred pebbles across half the sky (`CFG.GAS_EJECTA` /
  `GAS_EJECTA_R`, a tight cone and a speed band that still straddles escape). The **collapse is the
  exception** — killing a giant is allowed the biggest debris event in the game (~55 pieces), under
  a hard per-collapse ceiling (`GAS_STRIP_EJECTA`); what was wrong was the SIZE, not the quantity,
  and `beginGasStrip` must zero `ventT` or the throes run their first half silent. And **gas ejecta
  are terminal** — they puff, they never split, or the pebble cloud comes straight back one shot
  later.
- **World scale:** `PLANET_R_MUL`/`MOON_R_MUL` grow radii only — masses are untouched, and the
  multiplier is a *ceiling* capped by neighbouring lane clearance.
- **System scale:** `CFG.SYS_R_MUL` spreads the sky. **Every sun-anchored radius in world.js goes
  through `SR()`** — lanes, belts, graveyard, Vesper's ellipse, the shoals, the landmark lookups —
  because the *relationships* between those numbers are what the content is built on. It moves
  distance only: sky speed is `sqrt(G*sunMass/r)`, so spreading the sky slows every orbit rather
  than keeping it (the sun's mass is the speed knob, and it is deliberately not recompensated).
- **A PLANET SYSTEM IS RARE, AND IT IS AN EVENT** — fewer worlds, each with a bigger entourage.
  Cuts come off the DUPLICATED archetypes only, never a unique ptype and never a landmark host
  (`PTYPE_COUNT` and "strip every gas giant" both count them). Moon counts and `MOON_ZONE_MUL` move
  TOGETHER, which is what leaves `spawnMoon`'s slot width — every sibling-clearance margin — intact.
- **THE SKY TURNS ONE WAY** — every planet is prograde around the sun (`addPlanet`). A retrograde
  lane meets its neighbours at the SUM of their angular speeds instead of the difference, so
  conjunctions come round far more often and arrive above `DMG_THRESH`, where the railed-conjunction
  pass-through no longer protects the overlapping moon families. The rng draw it replaced is KEPT
  and discarded — never buy a constant with the seeded stream.
- **A SHOAL IS GRADED — YOU COME IN THINKING IT'S FINE AND STUMBLE INTO IT.** The landmark ladder is
  a `[rim, core]` ramp in mass AND drawn size (`FIELD_GIANT_MASS` / `FIELD_GIANT_R_MUL` /
  `FIELD_GIANT_SKEW`), and what enforces it is that **a rock's allowed reach falls as a power of its
  radius** (`FIELD_REACH` + `FIELD_REACH_EXP`) — not a biased sampler (`packBigRock`'s greedy-snug
  scoring saturates the pocket flat and overrides any sampler preference) and not a cumulative-area
  frontier alone (one shared envelope confines the small rock along with the big). The outer third
  holds no large rock at all. The core allowance has a floor set by the HEART's own footprint, and
  the outer third's mean size is floored by the class's small end.
- **MASONRY IS SPACED BY ITS SHAPE, NOT ITS RADIUS** — across the baked library a corner reaches
  1.14–2.45x the nominal radius (mean 1.50), so circle packing births the pocket interlocked.
  (History: 1.14–1.62x under the old per-id generator, whose `util.ROCK_REACH_MAX` 1.62 still caps
  the gravel outlines.) The bound is DIRECTIONAL (`rockshape.reachAt`) and must be taken over the arc
  the other rock subtends, or two big rocks interlock at a corner off the centre line; a conservative
  bound alone strands the biggest rocks in their own clearings, so it is used to ACCEPT and an exact
  SAT test (`world.pairOverlaps`) arbitrates the near misses. **`CFG.FIELD_PACK_GAP`'s overlap sweep
  is OWED A RE-RUN** — its own note says to re-sweep when the shape kinds change, and the whole
  library was replaced.
  Small rock BANKS against big rock (`FIELD_PACK_BANK`) — without it the greedy-snug packer is
  rich-get-richer and never fills the sparse core.
- **A SHOAL HAS SWIMLANES, AND THEY ARE FOUND AMONG THE ROCK, NOT CARVED THROUGH IT** — routes rim to
  rim that SKIRT the core (`world.findLanes`; a lane is ~180 wide and a core rock ~300 across, so a
  core-crossing route can only exist by deleting what it crosses). Only rocks that would leave less
  than `FIELD_LANE_MIN` of passage are dropped; gravel is cleared too, but leaks
  (`FIELD_LANE_LEAK`) so the edge stays ragged.
- **FIELD ROCK REMEMBERS WHERE IT BELONGS** (`world.setFieldHome`) and drifts back to it, so a pocket
  reconstitutes its layout — above all its lanes — instead of merely coming to rest.
- **A planet system is alive while you are in it**; loose debris is on a leash; a world you are not
  at slowly weathers, but never below `PLANET_WEAR_FLOOR`.
- **Rogue planets are gone** (`type: 'rogue'` still supported everywhere — nothing spawns one).
- **Enemy density is deliberately sparse**; nests and shoal-lurker broods are the only alien sources.
- **The shield is an ability, not base, and its shape is spec DNA** (BRAWLER front plate / SCOUT
  full-wrap / HAULER none). Hull does not self-heal — it mends only at a glow pocket, on a DOCK, and
  on the sanctioned hull-gain heal.

### Progression → [docs/progression.md](docs/progression.md)

Specialization-based, no passive leveling. **A rank buys mass inside your class, never the class
above:** the beam tier names a CLASS (`TIERS.labels` — pebbles → belt rock → boulders → small moons
→ large moons → planets, assigned by `config.liftClass`) and that class is a hard gate; catch ranks
only fill `capacity` from `TIERS.caps[tier]` toward `ceil[tier]`. `config.canLift`/`canStow` are the
only grab tests. **Two parallel tracks off one XP stream:** ability ranks
are automatic and never a card; picks only ever offer *new* abilities. Achievements are a third
track that feeds the other two. Field XP is gated twice (per-rock multiplier + per-field budget) and
billiards credit is depth-capped inside a pocket. Add an ability = a catalog row + reading its
channel in `shipStats`. **Every new achievement must be checked against `window.freshRun(i)` +
`window.tick(1)` for all three specs — a predicate true on frame one is the failure mode of the
whole feature.**

### World content → [docs/world-content.md](docs/world-content.md)

The discovery/expedition layer, the solar wave, the four dense fields and their **field LOD** (full
physics is a local privilege — the awake list, the frame registries `game.reg`, the dormant group
advance), shoal lurkers, glow pockets, and the nine planet archetypes with one mechanic each.

- **The sun throws THREE waves, not one thing on a timer** (`CFG.STORM_CLASSES` — squall / surge /
  cme, priced on full-pass exposure at ~9 / ~27 / ~68 hull). **The live wave CARRIES its class**
  (`game.storm` spreads the row), so nothing downstream may read a class-shaped constant off `CFG`.
  The pick is a **flat random third each** — no weights, no forced-first-wave — and `STORM_EVERY` is
  unchanged: the sun fires no more often than it ever did, it just throws something different.
- **A wave's REACH is its geography, and it dissolves rather than stopping** — `reach` caps the
  squall at **½** of `WORLD_R` and the surge at **⅔** (the cme still crosses the whole sky, its taper
  starting outside `WORLD_R` so it behaves exactly as before). `config.stormStrength` gives the live
  0..1 `k` every bite and every alpha is multiplied by; a wave that blinked out at an exact radius
  would be the in-world hard edge the design laws forbid. Only the big two blind alien senses, and
  the shorter reaches cut the sense-blind duty cycle to ~12% from ~25% — check that if aliens feel
  sharp.
- **Every moon shelters** (`STORM_SHADOW_MIN_R` 24, not 60 — that floor silently failed 40 of 59
  moons). `config.shelterR` is the ONE lee definition, sim and render both, and its flat pad is what
  makes a small moon's lee a pocket instead of a razor edge.

## Testing

**The baseline/diff loop above is the primary check** — it covers worldgen, progression, combat,
stability and perf in ~20s and tells you what *changed*. The hooks below are for answering a specific
question the suites don't, or for looking at something by hand.

Verify from `javascript_tool` against the preview (the pane suspends rAF when hidden, so
`tick`/`soak`/`mechTest` are how you advance the sim).

| Hook | Use |
|---|---|
| `window.soak(seconds, {idle})` | The one-call balance soak. Returns `{planets: "17/17", moons: "59/59", deaths, impacts, nanEvents, …}`. |
| `window.mechTest()` | Fixed-seed scripted mechanics suite, ~1.5s, bit-repeatable. |
| `window.tick(seconds)` | Raw headless fast-forward at fixed dt. |
| `window.freshRun(specIdx, seed)` | Repeatable fresh run with the spec auto-picked. |
| `window.speed(n)` | Live fast-forward of the *visible* game (0.25–50). |
| `window.goto('vesper')` / `window.god(true)` / `window.storm('charge', 'cme')` | Teleport / invuln / fire a solar wave now (2nd arg pins the intensity class). |

`window.mechTest()` is NOT in the bench suites — run it directly (2.5s) after any player-facing
mechanic change; 20/20 must pass. Skills wrapping the standard checks: **`balance-test`** (how to
judge a soak), **`mechanics-test`** (did I break the game loop?), **`run-solar-slinger`** (the runner
and driver). Full hook catalog and pass criteria: [docs/testing.md](docs/testing.md).

`game.nanEvents` must be 0. Any tripwire firing is a real upstream bug to root-cause, even though
the tripwire contained it.

## Dependencies

This project shipped with a blanket "no runtime dependencies" rule. That rule is **lifted** — but the
things it was protecting are not, so a dependency has to clear a bar.

**What is still absolute** (these were never about dependencies, they just rode along with the ban):

- **`src/` stays host-agnostic.** Never `require`/`import` Electron or Node APIs from `src/`, never
  assume an origin, absolute path or `file://`. If it wouldn't work over `serve.py`, it's wrong. A
  dependency that only resolves under a bundler's Node-style resolution breaks this.
- **ES modules with explicit `.js` extensions**, named exports only. A CommonJS-only package cannot be
  imported by the browser directly and drags in a build step for everyone.
- **Every capability is fallible.** `rockgl.js` is the pattern: WebGL2 missing, context lost, shader
  failed — latch dead and fall back to the path that always worked. A dependency that has no fallback
  becomes a hard requirement on somebody's machine.
- **Determinism.** World generation is seeded and the soaks must stay bit-repeatable per machine. A
  dependency in the sim path must not introduce its own RNG, its own time source, or platform-varying
  float behaviour.

**The bar.** Before adding one, answer these in the PR/commit message:

1. **Does it beat hand-rolling for THIS workload?** Measure, don't assume. Real example: `bitECS`
   benchmarks 14x over an OOP baseline but ~2x *slower* than a hand-tuned SoA loop — so for one hot
   loop, hand-rolled wins; for SoA across the whole body model, the library wins on plumbing.
2. **Does it survive the edit-reload loop?** Ships ESM, importable straight from `src/` without a
   bundler = free. Needs a build = it must be worth a build step for the whole project.
3. **Does it survive packaging?** It has to work under `app://` in Electron and be a real
   `dependency` (not `devDependency`) if `src/` imports it — see [docs/packaging.md](docs/packaging.md).
4. **What happens when it's absent or broken?** Name the fallback.

**Precedent so far:** `electron-updater` is the shell's one runtime dependency and nothing under
`src/` may import it. Everything else is a devDependency.

**Where dependencies have been considered and rejected**, so the reasoning isn't re-derived: a
general 2D physics engine (Rapier2d, Box2D-wasm) is the wrong shape for this sim — rails, hierarchical
gravity weighting, mass-dominance damage, the crumble and the tractor model don't exist in a
general rigid-body solver, and the nine physics invariants *are* the game. See
[docs/physics-invariants.md](docs/physics-invariants.md).

## Desktop packaging

Electron + a `workflow_dispatch`-only release CI. **The hard rule: `src/` must stay host-agnostic** —
never `require`/`import` Electron or Node APIs from `src/`, never assume an origin, absolute path or
`file://`; if it wouldn't work over `serve.py`, it's wrong. Electron and electron-builder are
devDependencies; `electron-updater` is the shell's one runtime dependency and nothing under `src/`
may import it. The newest `v*` git tag is the version's source of truth, not package.json.
Details — auto-update split by platform, the LFS checkout guard, the artifact-name trap, the
changelog generator: [docs/packaging.md](docs/packaging.md).

```sh
npm run serve      # = python3 serve.py
npm start          # run the Electron shell locally
npm run dist       # build installers into dist/
npm run changelog  # preview pending release notes (needs GH_TOKEN)
```
