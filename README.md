# Solar Slinger

A top-down 2D space game about **gravity**. Fly a ship through hand-built solar systems where every planet, moon, and asteroid moves under real N-body gravitational physics — then grab them with your tractor beam and fling them at things.

![genre](https://img.shields.io/badge/genre-gravity%20sandbox-blueviolet)
![engine](https://img.shields.io/badge/engine-vanilla%20JS%20%2B%20canvas-orange)
![deps](https://img.shields.io/badge/dependencies-none-brightgreen)

## The loop

1. **Fly.** Your ship obeys gravity. The dotted line shows your predicted trajectory through every gravity well — use it to slingshot, orbit, and survive.
2. **Grab & fling.** Hold the tractor beam on an asteroid, aim, release to hurl it. The orange dotted line predicts where your throw will curve.
3. **Destroy & collect.** Hard impacts chip and shatter bodies into golden scrap. Fly close to vacuum it up.
4. **Upgrade.** Spend scrap on tractor capacity (asteroids → moons → planets → gas giants), beam power, engines, and hull.
5. **Survive.** Rogue planets wander through the systems bending every orbit, and alien grabbers show up to play your own game against you — they pick up rocks and throw them at you.

## Controls

| Input | Action |
|---|---|
| `W A S D` | Thrust (forward / left / back / right) |
| Mouse | Aim — the ship turns to face your cursor |
| Hold **Left mouse** | Tractor-grab an object near the cursor |
| Release **Left mouse** | **Fling** it toward the cursor |
| **Right mouse** | Drop gently (keep it in orbit!) |
| Mouse wheel | Zoom |
| `E` | Ship upgrades |
| `T` | Toggle trajectory prediction |
| `P` | Pause |
| `R` | Respawn after death |

## Run it

No build step, no dependencies — it's plain ES modules. It just needs any static file server (modules don't load over `file://`):

```sh
python3 -m http.server 8642
# then open http://localhost:8642
```

or `npx serve`, or any equivalent.

## How it works

- `src/physics.js` — N-body gravity (softened, semi-implicit Euler at 120 Hz), impact damage & shattering, scrap pickups, and the trajectory predictor (forward-simulates the whole attractor set plus your ship each frame).
- `src/world.js` — deterministic seeded generation: 3 star systems with planets, moons, rings, asteroid belts, plus free asteroids and rogue planets.
- `src/tractor.js` — the grab/fling weapon: spring-damper hold with force limits by upgrade tier, mass-scaled fling speed, and recoil (flinging a planet shoves *you*).
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
