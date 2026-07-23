---
name: balance-test
description: Run a headless balance/physics-stability simulation of Solar Slinger and interpret the results. Use after changing physics.js, config.js tuning, world.js generation, ai.js enemy behavior, or tractor.js — or whenever the user asks whether a change "breaks the star systems", deorbits planets, or unbalances combat.
---

# Balance test

Solar Slinger has no test framework. You verify physics stability and combat balance by fast-forwarding
the live game headlessly and reading the death/collision logs. The historically dangerous failure mode is
**star systems shredding themselves within minutes** (planets deorbiting into the sun, tight pairs pumping
energy) — this harness catches exactly that.

## Why it works this way

The browser preview suspends `requestAnimationFrame` when its pane is hidden, so a normal wall-clock wait
advances nothing. The game exposes `window.tick(seconds)` which steps the sim deterministically regardless
of pane visibility, subdividing internally to the fixed `CFG.DT = 1/120` physics substep. World generation
is seeded, so the starting layout is identical every run.

## Workflow

1. **Start the preview** (do not use Bash for the server):
   `preview_start` with `{ name: "solar-slinger" }`. It serves on `http://127.0.0.1:8642` via the no-cache
   `serve.py`. If it's already running, reload so the latest modules load.

2. **Arm the logs and fast-forward.** Run this in one `javascript_tool` call:

   ```js
   game.collisionLog = [];
   game.deathLog = [];
   const before = game.bodies.filter(b => b.alive).map(b => ({id:b.id, type:b.type, name:b.name}));
   const planets0 = before.filter(b => b.type === 'planet').length;
   const moons0   = before.filter(b => b.type === 'moon').length;
   window.tick(600);   // 10 sim-minutes
   const alive = game.bodies.filter(b => b.alive);
   const planets1 = alive.filter(b => b.type === 'planet').length;
   const moons1   = alive.filter(b => b.type === 'moon').length;
   const deaths = (game.deathLog || []).map(d => `${d.type} ${d.how} @${d.t|0}s (m=${d.mass|0})`);
   ({ planets: `${planets1}/${planets0}`, moons: `${moons1}/${moons0}`,
      shipHull: game.ship.hull|0, shipAlive: game.ship.alive,
      deaths, impacts: (game.collisionLog||[]).length });
   ```

   For a longer soak, tick in chunks (`window.tick(300)` twice) rather than one huge call.

3. **Read the result and judge against the pass criteria below.**

## Pass criteria (baseline from a known-good build)

- **Planet survival:** ~12/13+ planets survive 10 idle sim-minutes. Losing **one** planet to a rogue
  drive-by is *intended drama*. Losing several — or any loss labeled `vaporized by star` for a
  star-anchored planet/moon — is a regression (a broken gravity/rails/boundary invariant).
- **Moon survival:** moons should essentially all survive; they're railed and orbits are exact by
  construction. A moon `shattered` against its own planet points at invariant #1 or #2 (energy pumping
  in tight pairs).
- **No runaway death cascade:** deaths should be a handful of discrete events, not a steadily climbing
  count. A rising death rate over time = the systems are sandblasting themselves (invariant #3).
- **Combat (with enemies engaged):** the orbit shield should intercept most thrown-rock volleys
  (~5/6). Enemy density is deliberately sparse — most planets stay free.

## Interpreting deaths

`deathLog` entries are `{t, how, type, mass}` where `how ∈ {shattered, "vaporized by star", absorbed}`.
Map failures back to invariants in [CLAUDE.md](../../../CLAUDE.md) and the comments in
[physics.js](../../../src/physics.js):

| Symptom | Likely broken invariant |
|---|---|
| Star-anchored planet `vaporized by star` | #2 (neighbor-star damping) or #6 (`WORLD_R`/boundary exemption) |
| Moon `shattered` against its planet | #1 (snapshot before integrate) or #2 (symmetric pair weight) |
| Death count climbs steadily over time | #3 (ambient damage threshold) |
| A rogue launches a planet out of orbit | #4 (damped natural impulse / immovable heavy) |
| Ship dies instantly to one thrown rock | #5 (ship bounce/impact cap) |

## Caveats

- Runtime spall/spawn/AI use `Math.random`, so exact deaths vary run-to-run. Judge *aggregate* balance
  (counts, trends), not bit-exact replay. Run 2–3 times if a result is borderline.
- This is a stability/balance check, not a visual check. For visual-language regressions (shield, dashes,
  hint colors) verify in the browser and consult the `visual-language-reviewer` subagent.
