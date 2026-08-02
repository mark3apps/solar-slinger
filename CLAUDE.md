# Solar Slinger

A top-down 2D gravity-sandbox space game. Fly a ship through a single-sun system where every body
moves under N-body gravity, grab things with a tractor beam, and fling them.
**Vanilla JS + HTML5 canvas, ES modules, no build step, no runtime dependencies.** A thin desktop
layer (Electron + release CI) rides alongside; everything under `src/` stays packaging-agnostic.

## Read before you edit

This file is the map. The *why* — every tuned constant, every rule that guards a real past bug —
lives in `docs/`. **Open the matching doc before editing, not after.**

| Editing | Read first |
|---|---|
| `physics.js`, rails, gravity, collisions, `CFG` hazard tuning | [docs/physics-invariants.md](docs/physics-invariants.md) |
| `config.js` progression, `ABILITIES`, `shipStats`, `achievements.js` | [docs/progression.md](docs/progression.md) |
| `render.js`, `hud.js`, `style.css`, any new sprite or HUD element | [docs/design-laws.md](docs/design-laws.md) |
| `world.js` generation, dense fields, the LOD, planet archetypes, `ai.js`, `glow.js` | [docs/world-content.md](docs/world-content.md) |
| `main.js` frame loop, `CFG.DT`, pacing, which clock a system rides | [docs/architecture.md](docs/architecture.md) |
| splash / pause / settings / controls / credits / achievements panel | [docs/shell-and-menus.md](docs/shell-and-menus.md) |
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
| `config.js` damage / hp / durability | `progression combat` | ~2s |
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
| `balance-test` | long-horizon sky stability — `window.soak` against the 21-planet/48-moon baseline |
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
server). Edit a `.js`, reload, see it live: no build, no bundler, no `npm install` needed for the
game itself.

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
| [render.js](src/render.js) | All canvas drawing. Owns the 2D context. Delegates bulk rock draws to rockgl.js and the minimap dot bake to minimap-worker.js — both behind fallbacks. |
| [rockgl.js](src/rockgl.js) | Instanced WebGL2 rock layer: a shoal's ~1900 blits become one draw call per sheet. Engaged past `GL_ENTER` rocks; falls back to 2D blits on any failure. |
| [minimap-worker.js](src/minimap-worker.js) | The radar's dense-field dot layer, baked off-thread to an ImageBitmap. Its sweep math MIRRORS `drawMinimap`'s — retune both together. |
| [hud.js](src/hud.js) | All DOM/HUD access (cached in `el`). The sim never touches the DOM. |
| [input.js](src/input.js) | Raw keyboard/mouse state + listeners. |
| [sfx.js](src/sfx.js) | Audio engine: the AudioContext + sfx/music buses. Every sound is a real CC0 recording — see [docs/audio.md](docs/audio.md). |
| [music.js](src/music.js) | Adaptive music director: 24 CC-BY tracks in six playlists, exactly one playing at a time — see [docs/audio.md](docs/audio.md). |
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
  — pin one with `?seed=` for a repeatable world. The 20-planet/48-moon `layout` table in world.js
  is FIXED, so the seed varies placement, masses and features, never the structural counts: the
  balance baseline holds on any seed. Runtime spawns/spall/AI intentionally use `Math.random`.
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
6. `WORLD_R` exceeds every system's outermost reach; star-anchored bodies are exempt from the boundary force.
7. Chunk shedding is gated, or it cascades — and every fragment system answers to one debris budget.
   7b. A split must not chain (no credit propagation, `chainOk`, `CHUNK_INERT`).
8. A planet is its own durability class (flat `PLANET_HP_BASE` + gentle slope, not the mass curve).
9. So is a moon (`MOON_HP_BASE`/`MOON_HP_MUL`).

Also there: **rails** (circular vs elliptical are different objects; never re-rail inside
`game.viewR`), the ship's flow-relative speed ceiling, LONG ARMS, corona/lava heat, gas-giant
interiors, the orbit rubber band, fog of war, and the frame-relative trajectory forecast.

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
- **Dashed lines are reserved for helper/aiming UI.** Real objects use solid strokes; always reset
  `setLineDash([])`.
- **The ship shield is a calm, steady rim glow** — no dashes, no idle motion; motion is for events
  only. **Shield down draws nothing at all.**
- **Hover hint rings:** green = auto-orbits, cyan = holdable, red = too heavy.
- **The cockpit chrome is mood-reactive; the instruments are not** (hull green / shield blue / lives
  pink stay semantic).
- **No hard edges in-world** — the world boundary and the Oort cloud are stochastic weather, never a
  stroke at an exact radius. In-world transitions are organic, never geometric.
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
- **A planet system is alive while you are in it**; loose debris is on a leash; a world you are not
  at slowly weathers, but never below `PLANET_WEAR_FLOOR`.
- **Rogue planets are gone** (`type: 'rogue'` still supported everywhere — nothing spawns one).
- **Enemy density is deliberately sparse**; nests and shoal-lurker broods are the only alien sources.
- **The shield is an ability, not base, and its shape is spec DNA** (BRAWLER front plate / SCOUT
  full-wrap / HAULER none). Hull does not self-heal.

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

## Testing

**The baseline/diff loop above is the primary check** — it covers worldgen, progression, combat,
stability and perf in ~20s and tells you what *changed*. The hooks below are for answering a specific
question the suites don't, or for looking at something by hand.

Verify from `javascript_tool` against the preview (the pane suspends rAF when hidden, so
`tick`/`soak`/`mechTest` are how you advance the sim).

| Hook | Use |
|---|---|
| `window.soak(seconds, {idle})` | The one-call balance soak. Returns `{planets: "21/21", moons: "48/48", deaths, impacts, nanEvents, …}`. |
| `window.mechTest()` | Fixed-seed scripted mechanics suite, ~1.5s, bit-repeatable. |
| `window.tick(seconds)` | Raw headless fast-forward at fixed dt. |
| `window.freshRun(specIdx, seed)` | Repeatable fresh run with the spec auto-picked. |
| `window.speed(n)` | Live fast-forward of the *visible* game (0.25–50). |
| `window.goto('vesper')` / `window.god(true)` / `window.storm('charge')` | Teleport / invuln / fire a solar wave now. |

`window.mechTest()` is NOT in the bench suites — run it directly (2.5s) after any player-facing
mechanic change; 19/19 must pass. Skills wrapping the standard checks: **`balance-test`** (how to
judge a soak), **`mechanics-test`** (did I break the game loop?), **`run-solar-slinger`** (the runner
and driver). Full hook catalog and pass criteria: [docs/testing.md](docs/testing.md).

`game.nanEvents` must be 0. Any tripwire firing is a real upstream bug to root-cause, even though
the tripwire contained it.

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
