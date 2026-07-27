# Solar Slinger

A top-down 2D gravity-sandbox space game. Fly a ship through a single-sun system where
every body moves under N-body gravity, grab things with a tractor beam, and fling them.
**The game is vanilla JS + HTML5 canvas, ES modules, no build step, no runtime dependencies.**
The repo also ships a thin desktop-packaging layer (Electron + a release CI) — see
[Desktop packaging](#desktop-packaging). Everything under `src/` stays packaging-agnostic.

## Run it

```sh
python3 serve.py          # http://127.0.0.1:8642  (or preview_start name "solar-slinger")
```

This is the primary dev workflow: edit a `.js`, reload, see it live — no build, no bundler.
`serve.py` is a **no-cache** wrapper around `http.server` on port 8642. Do **not** replace it
with plain `python3 -m http.server`: plain http.server sends no cache header, browsers cache
the ES modules, and every edit runs stale until a hard refresh (this bit us repeatedly).
ES modules do not load over `file://` — you need a server (which is also why the Electron shell
serves over `app://`, below). The `npm` scripts are only for the desktop build; the game itself
needs no `npm install` to develop in the browser.

## Architecture

Single `game` object (built in [main.js](src/main.js) `:13-52`) is the source of truth,
passed by reference into nearly every function. Fixed-timestep physics inside a
variable-timestep presentation loop.

| Module | Owns |
|---|---|
| [main.js](src/main.js) | Orchestrator + the `game` object + the rAF/`update`/`render` loop. Runs at import time (no `init()` wrapper). |
| [config.js](src/config.js) | All tuning constants (`CFG`, `TIERS`, `PROG`), the roguelite `UPGRADES`/`PATHS` catalog, and the pure `newProgress()` / `shipStats(prog)` / `pickChoices` / `addXp` derivations. |
| [entities.js](src/entities.js) | The only classes: `Body`, `Ship`, `Alien`. Plus `railBody`/`derail`, `scrapValue`, `makeScrap`. |
| [world.js](src/world.js) | `generateWorld` (seeded), `respawnShip`, `replenishWorld`, `spawnAsteroid`. |
| [physics.js](src/physics.js) | `step` — N-body integration, collisions/damage, rails, the trajectory predictor. **The load-bearing file.** |
| [tractor.js](src/tractor.js) | Grab / hold / fling, the aim lead-marker solver, the orbit shield. |
| [ai.js](src/ai.js) | Alien state machines (grabbers, wreckwrights, golems), Bastion forts, nests. |
| [render.js](src/render.js) | All canvas drawing. Owns the 2D context. |
| [hud.js](src/hud.js) | All DOM/HUD access (cached in `el`). The sim never touches the DOM. |
| [input.js](src/input.js) | Raw keyboard/mouse state + listeners. |
| [sfx.js](src/sfx.js) | Web Audio synthesis. |
| [util.js](src/util.js) | Pure helpers (`lerp`, `mulberry32`, `rand`, `pick`, `TAU`). |

The player ship hull is procedural vector art: `drawShipHull(game, tier, dmg, r)` in render.js
draws 6 tier designs x 3 damage states (picked from `game.st.tier` and hull fraction) in the
ship's local frame, nose along +x, per the `SHIP_TIERS` spec table. Ring assemblies rotate in
world space in the orbit shield's spin direction (+angle). Damage scars are seeded per
(tier, dmg) so they're stable frame to frame — don't swap them to `Math.random`. The shield
bubble wraps `shipVisualR(tier, r)` (the drawn art's reach), not the collision radius. The
collision radius itself IS the drawn body disc: `shipStats` reads it straight from
`SHIP_RADIUS[tier]` (config.js), whose values are derived so the drawn FOOTPRINT grows by an
equal RATIO each tier (perceptual evenness) — keep that array and `SHIP_ZOOM` in sync with
`SHIP_TIERS` proportions; the derivation rules live in the config.js comments.

**Import rules:** named exports only (no default exports), explicit `.js` extensions on every
import path (native browser ESM requires them), `config`/`util` are leaves.

### The loop (main.js)

- `frame(now)` → `dtReal = min(0.05, delta)` (clamps tab-switch stalls) → `update(dtReal)` **only while
  `game.started && !paused && !settingsOpen && !choosingUpgrade`** → always `render(game)` +
  `hud.updateHud(game)`. Rendering continues while frozen; the sim freezes. The frozen world is the
  living backdrop behind every menu overlay.
- Physics runs on a **fixed substep** via an accumulator: `while (acc >= CFG.DT) { updateTractor; updateOrbit; step(game, CFG.DT); cam follow; acc -= CFG.DT }` with `CFG.DT = 1/120`.
- **Gameplay math goes inside the `CFG.DT` loop.** Cosmetic easing with no quantized target
  (shake decay, the zoom ramp) rides `dtReal`. Frame-rate-independent easing idiom: `lerp(a, b, 1 - Math.exp(-k*dt))`.
- **The camera follow is the exception: it lives INSIDE the `CFG.DT` loop**, not on `dtReal`. Its target
  (the ship) advances in quantized DT chunks; a `dtReal`-chased camera beats against that quantization as
  the substeps-per-frame count wobbles, and the ship visibly jerks back and forth around screen centre
  (worse the higher the zoom). Phase-locking ship and camera to one clock is what keeps flight smooth.

### The front-end shell (splash / pause / settings)

The game boots to a **splash screen**, not straight into play — three flags on `game` gate it, and the
sim runs only when all are clear (the `frame()` gate above): `started` (false → splash; START sets it),
`paused` (pause menu), `settingsOpen` (settings modal). `choosingUpgrade` still freezes independently.
- **Transitions live in main.js** (it owns the state); **hud.js only routes the clicks** and derives which
  overlay is visible from those flags every frame in `syncMenus` (guarded, so the DOM is touched only when
  a flag flips) — same owner-split as the upgrade modal. `hud.initMenus(handlers)` wires the buttons once.
- **ESC / P** are one context-sensitive handler (`toggleMenu`): resume↔pause in-game, back out of settings,
  never dismiss an upgrade card, no-op on the splash or over the death/game-over panels. The on-screen **☰
  button** (top-right, below the minimap) just calls `pauseGame`. Player input (grab/fling/RMB) is gated
  behind `menuBlocking()` so nothing reaches the sim through a menu.
- **Settings** (Sound, Trajectory prediction) persist to `localStorage['ss_settings']` — host-agnostic, so
  it works identically under serve.py and Electron. **Sound**: the Web Audio context must first be created
  *inside* a user gesture (a context built at page load starts suspended and never resumes), so `sfx.setSoundEnabled`
  is only ever called with `on` from a click, and the loader touches audio only to honor a persisted MUTE.
- **EXIT** calls `window.close()` — quits the Electron window; a harmless no-op in a plain browser tab.
- `window.tick` sets `started = true` so headless soaks bypass the splash.

## Conventions

- **Only `Body`/`Ship`/`Alien` are classes.** Everything else is free functions that take `game`
  (or an array) first and mutate in place. Scrap, rails, flares, bolts, turrets, `fort` are plain objects.
- **Naming:** `SCREAMING_SNAKE_CASE` config constants; `camelCase` everything else; terse locals are
  idiomatic (`b` body, `s` ship, `p` planet, `st` ship-stats, `prog` progression, `vx/vy`, `ax/ay`, `w` angular velocity).
- **Comments are load-bearing — they explain *why*, and most guard a real past bug.** Preserve the
  rationale comment when you touch a tuned constant or a physics decision. Do not delete a "don't regress"
  comment without understanding the bug it names.
- **Roguelite progression (XP + pick-one-of-two).** There is NO passive leveling. Good play
  (catch, smash, skim/skate, kill, collect scrap, survey, slingshot, shield-block) grants XP via
  `addXp(game, amount)` — the per-action awards live in `PROG.XP_*` (config.js). Crossing
  `xpForPick(prog)` sets `game.choosingUpgrade` and PAUSES the sim (`frame()` gate) while a modal
  offers a CHOICE of 2 upgrades (`pickChoices`, drawn from the tier-gated `UPGRADES` pool — narrow
  early, widening by tier). Every `PROG.PICKS_PER_TIER` small picks the next choice is a **tier-up
  milestone**: a 3-way specialization-path card (`PATHS`) that bumps `prog.tier`, grants a signature
  upgrade, biases the pool, and +1 life. `shipStats(prog)` derives `game.st` from `prog.tier` +
  earned upgrade RANKS (not accumulators) — the `st.*` field names are unchanged, plus new ability
  gates (`hasReverse/hasTargeting/hasPredict/hasCrashWarn/hasCompass/hasVolley`, `maxOrbiters`
  starts 0). **You start with ONLY the tractor beam + one held rock**; reverse thrust, targeting
  markers, the trajectory plotter, collision alerts, the gravity compass, the orbit shield, and the
  RMB shotgun are all upgrades gated on those `st` flags (checked in physics/render/main/tractor).
  `totalLevel` = `min(25, tier*2 + round(rankSum*0.6))` — kept in the old 0–25 band because it still
  feeds enemy scaling (ai.js) and ship mass (physics.js). Tune XP rates / pool / ranks in config.js;
  the auto-resolve test hook is `game.autoUpgrade = true` (picks card 0 headlessly).
- **Lives, not a death penalty.** `prog.lives` starts at `PROG.START_LIVES` (3). A death spends one
  life and respawns with ALL upgrades kept; 0 lives → `game.gameOver` + the GAME OVER panel, and R
  calls `resetRun()` (fresh `newProgress()`, world regenerated). Extra lives come from sparse **life
  pods** (`game.pickups`, seeded in `generateWorld` + trickled by
  `main.updateLifePods`/`world.spawnLifePod`, capped at `PROG.MAX_LIVES`) and +1 per tier-up
  milestone. Life pods are real objects → SOLID stroke (render `drawPickups`).
- **No scrap currency — debris chunks are XP pickups.** There is NO scrap counter, and debris chunks
  don't heal: collecting a debris chunk pays `d.value * PROG.XP_SCRAP` and nothing else (the hull mends
  only at glow pockets — below; shield recharges). Which kills DROP chunks is still gated — only a player throw or a
  shield-rock hit (`physics.collisionCredit` → `earnsScrap`) mints them; belt traffic, a rogue
  clipping a moon, a ram, an absorption, or star heat shatter with NO drop. A direct throw-kill
  (`'player-throw'`) additionally pays combat XP. Don't reintroduce unconditional `dropScrap` on death.
- **The ship speed ceiling is RELATIVE to the local orbital flow** (`physics.orbitalFlow`): the ship's
  velocity is capped to within `maxSpeed` of the surrounding space's prograde circular velocity vector,
  not capped in absolute magnitude. The current carries the ship and the engine buys `maxSpeed` of
  deviation in any direction — with the spin you reach flow+maxSpeed, against it flow−maxSpeed (so out
  in the belt, where maxSpeed exceeds the flow, you can fly retrograde; near the sun the flow outruns
  maxSpeed and sweeps you prograde). Mirrored in predictPaths — keep in sync.
- **Sun-anchored orbits are slightly non-uniform:** `railBody` nudges each star-anchored body's angular
  speed by a deterministic ±~4% (hashed off `b.id`), so the sky isn't one rigid disc. Kept SUBTLE — a
  bigger spread lets same-radius rocks catch up and grind each other. Moons/installations stay exact.
- **Event-flag messaging:** a subsystem signals a one-shot event by setting `game.<x>Warn` / `game.<x>Name`;
  `update()` in main.js drains and clears it and calls `hud.message(text, seconds)`. First-time-vs-repeat
  wording is gated on `game.tut.*` booleans.
- **Determinism:** world *generation* uses a seeded `mulberry32` RNG (default seed `20260721`). Runtime
  spawns/spall/AI intentionally use `Math.random`. Procedural sprite geometry is seeded off `b.id` and cached.

## Physics invariants — DO NOT REGRESS

Each of these was a real bug that shredded the star systems within minutes. The rationale lives in
comments in [physics.js](src/physics.js) / [config.js](src/config.js) — read them before editing.

1. **Snapshot all accelerations before integrating anyone.** Phase 1 writes every body's `ax/ay` from
   one position snapshot; Phase 2 integrates. Integrating inside the accumulation loop makes forces
   asymmetric (later bodies see earlier bodies' new positions), breaks Newton's third law, and pumps
   energy into tight planet-moon pairs. (`physics.js:567`)
2. **Hierarchical gravity weight must be symmetric per pair**, and neighbor stars must be damped
   (`CROSS_GRAV 0.15`, `CROSS_STAR 0.05`) — at full strength their tides deorbit outer planets into their
   sun in ~8 min. Ship/aliens/debris always feel full gravity (`gravityAt`); only celestials use the
   weighted `gravityOnBody`. (`physics.js:232`, `config.js:29`)
3. **Ambient collisions below a closing-speed threshold do no damage** (`DMG_THRESH 240` natural —
   tuned to the sky speed (sun mass 1.42e7); keep them in ratio if orbital speeds change again;
   `DMG_THRESH_THROWN 140` — thrown speeds are ship-derived, not orbital); damage is mass-dominance
   weighted; natural celestial hits are damped and
   capped at 70% of remaining hp when masses are within 8× (comparable rocks crunch + spall, they don't
   one-shot). (`physics.js:377`, `config.js:40`)
4. **>20× mass ratio → the heavy body is immovable**; natural celestial-vs-celestial impulse is damped
   (×0.25). Thrown bodies keep full impulse (planet billiards stay glorious). (`physics.js:330`, `:347`)
5. **Ship bounce kick is hard-capped at 200** — an uncapped kick let alien-thrown rocks fling the ship
   at 900+. (`physics.js:452`)
6. **`WORLD_R` must exceed every system's outermost reach** (orbit + moons), and star-anchored
   planets/moons are exempt from the boundary force — it silently deorbits them otherwise. (`config.js:5`, `physics.js:613`)

### Rails (the biggest architectural fact)

Celestial bodies ride **precomputed circular rails** (`railBody`/`derail`) and skip gravity entirely.
They derail on grab/damage/throw/hard-bounce or when a heavy rogue/thrown giant comes within
`RAIL_DISTURB`, and re-rail once near-circular again — **but never within the player's view**
(the `game.viewR` guard, `physics.js:534`): an on-screen re-rail snap reads as "the rock I flung just
stopped mid-flight." Installations (stations, nests, forts) instead use active station-keeping — they
thrust back to `homeR` and re-rail even on-screen, because they must never wander.

### The discovery layer

Combat-free exploration content, deliberately sparse and all seeded to fixed spots (landmarks you can
give directions by). Rules that keep it from breaking the invariants above:

- **Comet Vesper** free-flies an eccentric orbit (peri ~3900 — deliberately above the graveyard ring,
  which otherwise collision-random-walks it into the sun — apo ~20100) and must NEVER be railed —
  rails are circular-only. It is an **honorary celestial**: weighted gravity (`majorComet` in the
  Phase-1 `weighted` check + predictPaths mirrors) and ×0.25 natural impulses, because full planet
  gravity/impulses killed it every ~15 min in soaks. If chaos still claims it, `replenishWorld`
  respawns it in ~4 min. `cometT = Infinity` deliberately survives the ambient-comet expiry
  (`Infinity - dt` stays `Infinity`). Its anti-sunward tail is render-only.
- The **shepherd** station-keeps (it's in the physics `install` set) and respawns ~5 min after an
  AMBIENT death only — a player kill scatters the ring permanently. Both are deliberate: ring decay
  must always trace back to a player choice.
- **The interstellar visitor** carries `noBoundary` — the one flag exempting a non-star-anchored body
  from the world-edge force (`physics.js`), because that force would capture its hyperbolic pass. It's
  cleared the moment the player catches it. Don't put `noBoundary` on anything else without a reason
  this strong.
- **Solar storms** (`CFG.STORM_*`) push SCRAP DEBRIS ONLY — never bodies, celestials, or the ship.
  Auroras, tail-brightening, and the front visual are render-side. A storm touching rails or celestial
  velocities is an invariant-3-style regression waiting to happen.
- **Survey/CHART**: flying into a world's nameplate zone charts it (`replenishWorld` scan) and pays
  `PROG.XP_SURVEY`. Forecast horizon (`st.predictBoost`) and sensor/minimap reach (`st.sensorMul`) now
  come from the **Deep Sensors** and **Trajectory Plotter** upgrades, not from a passive survey track.
- **Echo logs** are strings on bodies (`b.echo`), announced once on first grab via `game.echoMsg`.
- The **ring shepherd**, **Forge Moon**, **graveyard wrecks**, **ghost ship** (station-type, `parent:
  null` so it gets no station-keeping), and **carved stone** are ordinary railed bodies — the fortify
  pass must keep skipping volcanic/shepherd moons.
- **Sky speed pairs with camera zoom:** the sun's mass (`1.42e7`, world.js) is the sole knob for how
  fast every sun-anchored orbit sweeps — orbital cruise is `sqrt(G*sunMass/r)`, so planets, belts,
  trojans, graveyard, Vesper, rails, and the ship's own cruise all scale with it together. It is tuned
  LOW on purpose: the tier-0 camera is zoomed in tight (`SHIP_ZOOM` 2.46, config.js) and the world
  scrolls past ~2x faster per zoom unit, so a fast sky at that zoom reads as "flying wildly fast."
  Flight feel = sky speed × zoom — **raise the zoom and this mass must drop, and vice-versa.**
  `STAR_GRAV_SHIP` (0.8) is NOT a compensator: it sets how hard the sun grabs the ship, and it rides
  down with the sky on purpose (slower cruise ⇒ gentler pull). (History: mass was once 3.2e7 to speed
  the sky up 1.4x; it was lowered to 1.42e7 — ~1.5x slower than that — to calm flight at the 2.46 zoom.)
- **LONG ARMS** (`SHIP_WELL_START`/`SHIP_WELL_MAX`): the SHIP feels planet/moon/rogue gravity fall off
  as 1/r (capped at 3.5x) beyond 4 body radii — longer reach, identical close-range gravity. It lives
  in `gravityAt` behind `heavyMul !== 1` (ship-only) and is MIRRORED in `predictPaths.accelAt`; the two
  must stay in sync or the forecast lies. Thrown rocks, aliens, debris, celestials never feel it.
- **Fog of war:** the minimap only draws bodies with `b.seen` (set by the `replenishWorld` scan once
  within sensor range; the sun is always visible). The **gravity compass** (chevrons at the ship) shows
  the pull of WORLDS ONLY — `game.shipGx/Gy` is stashed from the non-star portion of the ship's gravity
  in `step`, then vector-smoothed into `game.compassX/Y` in main.js so the arrow can't whip.
- **Orbit rubber band** (`SHIP_BAND_*`): ship-only, inward-radial-only damping near worlds (mirrored in
  predictPaths). Outbound is exempt by design — the assist must never become an escape jail. **Surface
  skimming** (`SKIM_*`): tangential contact grinding damages the hull with sparks + a contact glow; the
  normal bounce path still only bites above closing-speed thresholds.
- **Corona heat** (`HEAT_*`): bodies/aliens melt inside `HEAT_ZONE x radius` (depth², lava-born matter
  immune: `ptype 'lava'`, `magma > 0`, `ember > 0.01`) — that zone's outer edge MUST stay inside the
  graveyard ring (~3160): ANY body damage derails railed wrecks, there is no "subtle" for them. The
  SHIP uses a separate wide envelope (`HEAT_SHIP_*`) with an EXPONENTIAL ramp — warmth/glow warn far
  out, lethal dps only arrives near the photosphere. Lava worlds radiate a weaker SHIP-ONLY aura
  (`LAVA_*`) — their own railed moons must never take heat.
- **Gas giants have no surface for the SHIP** (`GAS_*`): it flies in, crushed by depth², dead at the
  core. Interior ship gravity is enclosed-mass (`x d³/R³`, in `gravityAt` AND `predictPaths.accelAt` —
  keep in sync, else dives predict as inescapable). The prediction hit marker for a gas giant is its
  CORE, not its cloud tops. Rocks and aliens still bounce off the cloud tops — only the ship dives.
- **The drawn ship trajectory is frame-relative:** predictPaths simulates in inertial space (physics
  truth) but re-expresses the DISPLAYED ship path in the dominant attractor's frame, anchored at its
  current position (`game.predictRef`, 1.35x hysteresis) — near a world you see your real orbit shape
  around it; sun-dominant is exactly the inertial path (the sun is pinned). The compass chevron phase
  ACCUMULATES in main.js (`game.compassPhase`) — never derive animation phase as `time * speed`, a
  changing speed teleports the phase.

## Design laws (gameplay + visual)

These are deliberate rules the user has set, not accidents. Violating them is a regression even if the
code "works."

- **Flinging has no recoil** that pushes the ship back. The tractor tug reaction is capped at 150 so the
  ship stays flyable, but throws must never shove the ship. (`tractor.js:197`)
- **Throws never steer and the game never bends the release angle** — a rock flies exactly at the cursor,
  *from its own held position* (~70u out), not from the ship. The aim assist is informational only: lead
  markers (✕) show where the cursor must be at release. Solving from the ship offsets the ✕ and every shot
  misses — this was a real bug. (`tractor.js:26`)
- **Dashed lines are reserved for helper/aiming UI** (throw line, beam ring, orbit rings, lead markers,
  prediction paths). Real objects use solid strokes. Always reset `ctx.setLineDash([])` after a dashed draw.
- **The ship shield is a calm, steady volumetric rim glow — no dashes, no idle motion.** Motion is reserved
  for *events* (recharge sweep, absorb ripple). **Shield down draws nothing at all** — a naked hull is the
  indicator; the blinking `SHLD` HUD label carries the alarm. (`render.js:609`, `:619`)
- **Hover hint ring colors:** green = auto-orbits, cyan = holdable, red = too heavy. (`render.js:1055`)
- **Enemy density is deliberately sparse** ("too many enemies, not enough normal worlds"): most planets are
  free. Nests are the *only* alien source — there is no global wave spawner; a destroyed nest quiets its
  region forever. Aliens are territorial (leashed to `ALIEN_TERRITORY` of their nest).
- **Ship health is split:** hull ≈ 2/3 of the pool, does NOT self-heal — it mends ONLY by collecting
  glow-pocket motes (below), and otherwise resets to full only on respawn; shield ≈ 1/3, absorbs first,
  recharges after quiet time. The **Shield Cells** upgrade shifts the split toward shield; **Shield
  Regen** speeds the recharge (`st.regen`/`st.regenDelay`). Separate HULL/SHLD HUD bars.
- **Early-game interactables** (give the belt more to do than smash-the-same-rock; all lean on the
  existing throw/grab/collision loop, no new subsystems):
  - **Cored rocks** (`b.cored`, ~13% of belt/field rocks over 250 mass, world.js `maybeCore`): cracking
    the shell with a PLAYER smash frees a dense `b.core` crystal — heavy salvage (3.5x scrap, fat beam
    catch). Ambient shatters don't reveal it (earnsScrap gate). A purple glint marks cored rocks.
  - **Salvage caches** (`b.cache`, world.js `spawnCache`, ~5% of local-field spawns): light grabbable
    canisters that BURST into scrap + ice ammo when the player cracks them (physics.shatter).
  - **Gravity billiards** (physics.js): throw-kills chained within `game.comboT` (2.6s) rack up
    `game.combo`; a heavy rock plowing through light ones, or a knocked rock (credit propagated — ASTEROIDS
    ONLY, never moons/planets) killing the next, keeps it going. 2+ shouts a multiplier + bonus scrap.
  - **Ice-moon geysers** (world.js): ice-type moons vent catchable ammo like the far ice planets, but
    close-in and faster — an early harvesting loop.
  - **Glow pockets** (`game.glowPockets`, glow.js): sparse WIDE FIELDS of small bioluminescent motes that
    ride the belt's prograde orbit (a circular rail, `w` matched to the flow at their radius), scattered
    thin across the mid system — a field (`GLOW_SPREAD`) is wide enough that you SWEEP the ship through it,
    scooping several in a pass, and its green region-halo makes it easy to spot. Motes are SLIGHTLY
    MAGNETIC — near the ship (`GLOW_MAGNET`) they home in and POP a hair before the hull touches
    (`GLOW_*` tuning in config.js) for a little hull + XP. **The ONLY mid-life
    hull heal** (see the split-health law above). No in-place refill — a drained pocket vanishes and a
    fresh full one fades in ELSEWHERE (never within view), so `game.glowPockets` holds a steady
    `PROG.GLOW_POCKETS` and the healing supply constantly relocates. Seeded deterministically off the
    world rng in `world.seedGlowPockets`; collected on dtReal in `glow.updateGlow` (a proximity test like
    the life pods, NOT the fixed step); drawn additively in `drawGlow` (a green region-halo + motes,
    healing-green palette). Never touches bodies/rails/velocities — purely additive to the sim.

### Canvas discipline

- Pair every `translate`/`rotate`/`clip` with `save()`/`restore()`.
- Reset `globalCompositeOperation` to `'source-over'` and `globalAlpha` to 1 after additive/alpha passes.
- Divide UI/overlay line widths and dash arrays by `game.cam.zoom` so they stay constant on screen.
- One draw function per sprite type; hook new body types into `drawBody`'s type switch.

## Desktop packaging

The game ships as an Electron desktop app for macOS + Windows, but the game code knows nothing
about it — this is a hard rule.

- **`src/` must stay host-agnostic.** The exact same static files run under `serve.py` (browser dev)
  and inside Electron. [electron/main.js](electron/main.js) serves the repo over a privileged
  `app://` scheme (Chromium won't load ES modules over `file://`, same reason `serve.py` exists) and
  the game code has no idea it's in Electron. Never `require`/`import` Electron or Node APIs from
  `src/`, and never assume an origin, absolute path, or `file://` — if it wouldn't work over
  `serve.py`, it's wrong.
- **npm scripts** ([package.json](package.json)): `npm run serve` (= `python3 serve.py`),
  `npm start` (run the Electron shell locally), `npm run dist` (build installers into `dist/`).
  Electron + electron-builder are **devDependencies** — dev/build only, not shipped game deps, so
  the "no runtime dependencies" claim still holds.
- `ELECTRON_START_URL` points the shell at the live dev server (`http://localhost:8642`) instead of
  `app://` for hot-ish iteration.
- **Release CI** ([.github/workflows/release.yml](.github/workflows/release.yml)): every push to
  `main` builds a mac DMG (arm64 + x64), a Windows NSIS installer, and Linux `.deb` + `.rpm`
  packages (x64 + arm64 each; deb for Debian/Ubuntu/Raspberry Pi OS 64-bit, rpm for
  RHEL/Rocky/Fedora) and attaches them to a GitHub
  release tagged `v<major>.<minor>.<run number>` — the patch digit is stamped from the CI run
  number, so package.json's patch is ignored on CI; bump major/minor there when it matters. Builds are **unsigned** (mac: right-click → Open / clear
  quarantine; Windows: click through SmartScreen). The `build:` block in package.json controls what
  gets packaged and the installer targets. App icons live in `build/` (`icon.icns/.ico/.png`,
  generated from `build/icon-src/`).

## Testing (headless, no framework)

There is no test runner. Verify balance and physics with the console hooks:

- `window.tick(seconds)` — steps the whole game headlessly at fixed dt (physics still subdivides to
  `CFG.DT`), then renders once. `window.tick(300)` fast-forwards 5 minutes.
- `window.game` — the live state handle.
- `game.autoUpgrade = true` — headless helper: auto-resolves each upgrade pick (picks card 0) so a
  `window.tick` soak doesn't stall on the choice modal. Drive a climb by pumping `game.prog.xp`.
- `game.collisionLog = []` — opt-in; records `{t,a,b,closing,dmgToA,dmgToB}` for impacts >2 dmg.
- `game.deathLog = []` — opt-in; records `{t,how,type,mass}` on every body death.

Run these from `javascript_tool` against the preview (the pane suspends rAF when hidden, so `window.tick`
is the way to advance the sim). See the `balance-test` skill for the full workflow and pass criteria.
