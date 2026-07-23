# Solar Slinger

A top-down 2D space game about **gravity**. Fly a ship through a vast single-sun system where every planet, moon, and asteroid moves under real N-body gravitational physics — then grab them with your tractor beam and fling them at things. Beyond the system's edge waits the Oort cloud, which will grind your hull to dust.

![genre](https://img.shields.io/badge/genre-gravity%20sandbox-blueviolet)
![engine](https://img.shields.io/badge/engine-vanilla%20JS%20%2B%20canvas-orange)
![deps](https://img.shields.io/badge/dependencies-none-brightgreen)

## The loop

1. **Fly.** Your ship obeys gravity. The dotted line shows your predicted trajectory through every gravity well — use it to slingshot, orbit, and survive.
2. **Grab & fling.** Hold the tractor beam on an asteroid, aim with the mouse, release to hurl it. The orange dotted line predicts where your throw will curve.
3. **Build your orbit shield.** Small-enough objects can be parked in a defensive orbit around your ship — they block incoming rocks, and you can fling them at things on demand.
4. **Grow — automatically.** There is no shop. *Catching* things strengthens your beam (heavy catches grow it fastest). *Smashing* things speeds up your fling. *Collecting scrap* heals you and toughens your hull. *Burning delta-v* grows your engines. The ship visibly gains armor, pods, coils, and emitters as each system levels.
5. **Survive.** Rogue planets wander through the systems bending orbits, and alien grabbers play your own game against you — they pick up rocks and throw them at you.

## Controls

| Input | Action |
|---|---|
| Mouse | Steer — the ship's nose follows the cursor, and the beam aims there too |
| `W` / `S` | Thrust forward / thrust backward |
| Hold **Left mouse** | Tractor-grab an object near the cursor |
| Release **Left mouse** | **Fling** it toward the cursor |
| **Left mouse** on empty space | Fling a rock **from your orbit** toward the cursor |
| **Right mouse** (while holding) | Add to your orbit shield (or drop if too big) |
| Mouse wheel | Zoom (the camera also pulls back on its own as you level) |
| `T` | Toggle trajectory prediction |
| `P` | Pause |
| `R` | Respawn after death |

All five progression tracks (beam, orbit, fling, hull, engines) live on the HUD with level pips — no menus.

Your orbit holds objects **one size tier below** what your beam can grab — grow the beam from asteroids → moons → minor planets → planets → gas giants and the shield tier follows.

## Run it

No build step, no dependencies — it's plain ES modules. It just needs any static file server (modules don't load over `file://`):

```sh
python3 -m http.server 8642
# then open http://localhost:8642
```

or `npx serve`, or any equivalent. (`serve.py` in this repo is the same thing with caching disabled — preferred for development so edits are never stale.)

## Desktop app

The game also ships as an Electron app for macOS and Windows.

```sh
npm install
npm start          # run the desktop app locally
npm run dist       # build installers into dist/
```

Every push to `main` triggers the **Build & Release** GitHub Actions workflow, which packages a macOS DMG (arm64 + Intel) and a Windows installer and attaches them to a new GitHub release tagged `build-<run number>`. The builds are unsigned: on macOS right-click → Open (or clear the quarantine flag); on Windows click through SmartScreen.

The Electron shell ([electron/main.js](electron/main.js)) serves the exact same static files over an internal `app://` scheme — the game code has no idea it's in Electron, and browser development is unchanged.

## How it works

- `src/physics.js` — N-body gravity (softened, semi-implicit Euler at 120 Hz), impact damage & shattering, scrap pickups, and the trajectory predictor (forward-simulates the whole attractor set plus your ship each frame).
- `src/world.js` — deterministic seeded generation: 3 star systems with planets, moons, rings, asteroid belts, plus free asteroids and rogue planets.
- `src/tractor.js` — the grab/fling weapon and the orbit shield: spring-damper hold with force limits by tier, mass-scaled fling speed, recoil (flinging a planet shoves *you*), and rotating shield slots.
- `src/ai.js` — alien grabber state machine: seek → fetch a rock → carry → lead-the-target throw → strafe away. They avoid stars and you can steal the rock right out of their beam.
- `src/render.js` — canvas renderer: parallax starfield, star glow, day/night planet shading, beams, particles, minimap, screen shake.
- `src/config.js` — every tuning knob and the upgrade tables in one place.

## Debugging

The game exposes hooks in the devtools console:

- `game` — the entire game state, live. Poke at `game.scrap`, `game.bodies`, `game.cam.zoom`…
- `tick(seconds)` — deterministically advance the simulation (used for headless physics testing).
- `game.collisionLog = []` / `game.deathLog = []` — start recording impact and destruction events.

## Ideas / roadmap

- Black holes and binary star systems
- Alien motherships that throw *moons*
- Orbital bombardment missions (park a planet on a target)
- Gamepad support, mobile touch controls
- Persistent high scores

---

Built with [Claude Code](https://claude.com/claude-code).
