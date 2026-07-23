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
| [config.js](src/config.js) | All tuning constants (`CFG`, `TIERS`, `GROWTH`) and the pure `newProgress()` / `shipStats(prog)` derivations. |
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

**Import rules:** named exports only (no default exports), explicit `.js` extensions on every
import path (native browser ESM requires them), `config`/`util` are leaves.

### The loop (main.js)

- `frame(now)` → `dtReal = min(0.05, delta)` (clamps tab-switch stalls) → `update(dtReal)` when not
  paused → always `render(game)` + `hud.updateHud(game)`. Rendering continues while paused; the sim freezes.
- Physics runs on a **fixed substep** via an accumulator: `while (acc >= CFG.DT) { updateTractor; updateOrbit; step(game, CFG.DT); acc -= CFG.DT }` with `CFG.DT = 1/120`.
- **Gameplay math goes inside the `CFG.DT` loop.** Only cosmetic/camera/easing work uses `dtReal`.
  Frame-rate-independent easing idiom: `lerp(a, b, 1 - Math.exp(-k*dt))`.

## Conventions

- **Only `Body`/`Ship`/`Alien` are classes.** Everything else is free functions that take `game`
  (or an array) first and mutate in place. Scrap, rails, flares, bolts, turrets, `fort` are plain objects.
- **Naming:** `SCREAMING_SNAKE_CASE` config constants; `camelCase` everything else; terse locals are
  idiomatic (`b` body, `s` ship, `p` planet, `st` ship-stats, `prog` progression, `vx/vy`, `ax/ay`, `w` angular velocity).
- **Comments are load-bearing — they explain *why*, and most guard a real past bug.** Preserve the
  rationale comment when you touch a tuned constant or a physics decision. Do not delete a "don't regress"
  comment without understanding the bug it names.
- **No shop, no menus.** All progression is *derived* from `game.prog` by `shipStats()` every frame.
  Leveling comes from play: catches grow the beam, smashes grow fling, scrap heals + toughens hull,
  spent delta-v grows thrust, orbit use grows the shield. Tune via `GROWTH` in config.js.
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
3. **Ambient collisions below a closing-speed threshold do no damage** (`DMG_THRESH 240` natural,
   `DMG_THRESH_THROWN 140`); damage is mass-dominance weighted; natural celestial hits are damped and
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
- **Ship health is split:** hull = 2/3 of the pool, heals *only* from scrap; shield = 1/3, absorbs first,
  recharges after quiet time. Separate HULL/SHLD HUD bars.

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
  `main` builds a mac DMG (arm64 + x64), a Windows NSIS installer, and a Linux arm64 `.deb`
  (Raspberry Pi 3+ on 64-bit Raspberry Pi OS) and attaches them to a GitHub
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
- `game.collisionLog = []` — opt-in; records `{t,a,b,closing,dmgToA,dmgToB}` for impacts >2 dmg.
- `game.deathLog = []` — opt-in; records `{t,how,type,mass}` on every body death.

Run these from `javascript_tool` against the preview (the pane suspends rAF when hidden, so `window.tick`
is the way to advance the sim). See the `balance-test` skill for the full workflow and pass criteria.
