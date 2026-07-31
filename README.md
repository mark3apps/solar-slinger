# Solar Slinger

A top-down 2D space game about **gravity**. Fly a ship through a vast single-sun system where every planet, moon, and asteroid moves under N-body physics — then grab them with your tractor beam and fling them at things. Beyond the system's edge waits the Oort cloud, which will grind your hull to dust.

![genre](https://img.shields.io/badge/genre-gravity%20sandbox-blueviolet)
![engine](https://img.shields.io/badge/engine-vanilla%20JS%20%2B%20canvas-orange)
![deps](https://img.shields.io/badge/runtime%20dependencies-none-brightgreen)

## The loop

1. **Pick a specialization.** Every run opens on a free choice of BRAWLER (smash and ram), HAULER (long beams, big hauls, orbit shields), or SCOUT (sensors, precision, mobility). The spec sets your starting kit and gates which named abilities the run can offer you.
2. **Fly.** Your ship obeys gravity — planets really grab at you, and the local orbital current carries you with the sky. Slingshot cleanly through a well without touching the throttle and the game pays you XP for it.
3. **Grab & fling.** Hold the tractor beam on a rock, aim with the mouse, release to hurl it. Throws fly exactly at the cursor — the lead-marker ✕s (an ability) show where to release to hit a moving target.
4. **Earn picks.** Good play — catching, smashing, surveying worlds, skimming surfaces, shield-blocks, billiard combos — grants XP. Each threshold pauses the game for a choice: small picks deepen abilities you own; every fourth pick is a **tier-up** that offers a new ability, auto-ranks your whole build once, grows the ship a hull class, and adds a life.
5. **Survive on lives.** Death spends a life and respawns you with your build intact; at zero lives the run ends and a fresh spec choice begins. Extra lives drift through space as pods. The hull only mends at green **glow pockets** — the healing supply constantly relocates, so you fly to it.
6. **Explore.** Nests, Bastion fortresses, derelict stations, a ring shepherd, a graveyard orbit, a ghost ship, Comet Vesper, solar storms, and a one-time interstellar visitor are all seeded landmarks — combat is deliberately sparse, and a destroyed nest quiets its region forever.

## Controls

| Input | Action |
|---|---|
| Mouse | Steer — the ship's nose follows the cursor, and the beam aims there too |
| `W` | Thrust forward |
| `S` | Reverse thrust *(Retro Jets ability)* |
| Hold **Left mouse** | Tractor-grab an object near the cursor |
| Release **Left mouse** | **Fling** it toward the cursor |
| **Left mouse** on empty space | Pull a rock back out of your orbit shield |
| **Right mouse** (while holding) | Stow the rock in your orbit shield |
| Hold **Right mouse** | Charge the shotgun — release to fire armed orbiters *(ability)* |
| `Shift` | Afterburner *(ability)* |
| `Space` | Evasion roll *(ability)* |
| `F` | Slipstream warp *(ability)* |
| `T` | Toggle trajectory prediction |
| `Esc` / `P` | Pause menu |
| `R` | Respawn after death / start a new run after game over |

There is no manual zoom — the camera pulls back on its own as your ship tiers up from Scout to Titan.

## Run it

No build step, no bundler, no runtime dependencies — plain ES modules. Modules don't load over `file://`, so use the bundled dev server:

```sh
python3 serve.py
# then open http://127.0.0.1:8642
```

`serve.py` disables HTTP caching on purpose: plain `python3 -m http.server` lets browsers cache the ES modules, and every edit runs stale until a hard refresh. Edit a `.js`, reload, see it live.

## Desktop app

The game also ships as an Electron app for macOS, Windows, and Linux. Electron is a dev dependency only — the game itself stays dependency-free.

```sh
npm install
npm start          # run the desktop app locally
npm run dist       # build installers into dist/
```

Releases are **manual**. Nothing runs on a push to `main`; when the tree is in a good place, run the **Build & Release** workflow from the Actions tab (or `gh workflow run release.yml -f bump=minor`) and choose a `patch` / `minor` / `major` bump. It builds a macOS DMG (arm64 + Intel), a Windows NSIS installer, and Linux `.deb` + `.rpm` packages (x64 + arm64), then tags `v<version>`, commits the version bump and a new [CHANGELOG.md](CHANGELOG.md) section, and publishes a release. `dry_run: true` does the whole build and prints the notes without publishing anything.

Release notes are generated from the pull requests merged since the previous tag — one bullet per PR with a summary line lifted from its description. Preview them at any time without releasing:

```sh
GH_TOKEN=$(gh auth token) npm run changelog
```

Builds are unsigned — every release carries the macOS Gatekeeper / Windows SmartScreen steps in its notes.

The Electron shell ([electron/main.js](electron/main.js)) serves the exact same static files over an internal `app://` scheme — the game code has no idea it's in Electron, and browser development is unchanged.

## How it works

- `src/main.js` — the orchestrator: the single `game` state object, the fixed-substep loop, the front-end shell (splash / pause / settings), and the roguelite pick flow.
- `src/config.js` — every tuning knob, the spec + ability catalog, and the pure progression math (`shipStats`, pick/tier logic).
- `src/physics.js` — N-body gravity (softened, semi-implicit Euler at 120 Hz), rails, collisions and damage, and the trajectory predictor.
- `src/world.js` — deterministic seeded generation of the one-sun system: planets, moon families, belts, trojans, the discovery layer — plus the world's self-replenishment.
- `src/tractor.js` — grab / hold / fling, the aim lead-marker solver, and the orbit shield.
- `src/ai.js` — alien grabbers, wreckwrights, scrap-golems, nests, and Bastion fortresses.
- `src/glow.js` — the glow-pocket healing fields.
- `src/render.js` — all canvas drawing: procedural ship hulls, planets, effects, minimap.
- `src/hud.js` — all DOM access; the sim never touches the DOM.

Celestial bodies ride precomputed **rails** (circular or Kepler ellipses) until something disturbs them, then re-rail once their orbit settles — that's what keeps a fully dynamic sky stable for hours.

## Debugging

The game exposes hooks in the devtools console:

- `game` — the entire game state, live. Poke at `game.prog`, `game.bodies`, `game.st`…
- `speed(n)` — run the live game at n× real time (0.25–50): fast-forward long stretches, or slow-mo a
  collision. An amber `SIM ×n` badge shows while it's active; `speed(1)` (or the `0` key with `?dev=1`
  on the URL) returns to normal. `?dev=1` also enables `-` / `=` to halve / double the speed.
- `mechTest()` — the scripted mechanics suite: a fixed-seed, fully repeatable run through grab, fling,
  orbit, picks, shield, death/respawn, and more; returns a pass/fail report with all the logs
  (`mechTest({download: true})` saves it as JSON).
- `freshRun(specIdx, seed)` — restart into a repeatable fresh run (same seed = same world).
- `tick(seconds)` — advance the simulation headlessly (used for balance soaks).
- `soak(seconds, {idle: true})` — one-call balance soak: records deaths/impacts and returns a summary
  (`{idle: true}` removes the ship first for a pure sky-stability run).
- `goto('vesper')` / `locate('vesper')` — teleport the ship beside a named body / grab the body itself.
- `god(true)` — the ship ignores all damage while you investigate somewhere lethal.
- `game.autoUpgrade = true` — auto-resolve upgrade picks so a long `tick()` never stalls on a choice.
- `game.collisionLog = []` / `game.deathLog = []` — start recording impact and destruction events.

## Ideas / roadmap

- Alien motherships that throw *moons*
- Orbital bombardment missions (park a planet on a target)
- Gamepad support, mobile touch controls
- Persistent high scores / run history

---

Built with [Claude Code](https://claude.com/claude-code).
