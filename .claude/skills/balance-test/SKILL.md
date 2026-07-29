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
of pane visibility, subdividing internally to the fixed `CFG.DT = 1/120` physics substep — and
`window.soak(seconds, opts)`, which wraps tick with the log-arming and census bookkeeping below. World
generation is seeded, so the starting layout is identical every run.

## Workflow

1. **Start the preview** (do not use Bash for the server):
   `preview_start` with `{ name: "solar-slinger" }`. It serves on `http://127.0.0.1:8642` via the no-cache
   `serve.py`. If it's already running, reload so the latest modules load.

2. **Run the soak.** One `javascript_tool` call:

   ```js
   window.soak(600, { idle: true });   // 10 idle sim-minutes — the cleanest stability signal
   ```

   It returns `{ simSeconds, wallMs, planets: "17/17", moons: "45/45", ship, lives, tier,
   deaths: [...], impacts, nanEvents }`. `idle: true` removes the ship first (no life is spent);
   omit it to soak with the ship alive and interacting. For a longer soak, call `soak` twice
   (`2 × 300s`) rather than one huge call, and combine the results yourself — each call re-arms
   the logs, so tallies are per-call.

   For **before/after comparisons**, reload between runs (generation is seeded, so both runs start
   from the identical world) and diff the two summaries — planet/moon fractions, death list shape,
   impact count.

   If you need custom instrumentation between chunks (or `soak` isn't loaded because you're on an old
   build), fall back to the raw primitive: arm `game.collisionLog = [] / game.deathLog = []`, census
   `game.bodies` by type, `window.tick(600)`, re-census.

3. **Read the result and judge against the pass criteria below.**

4. **Watching a failure live (optional).** When a soak flags something and you (or the user) want to *see*
   it happen: `window.speed(10)` runs the visible game at 10× real time (0.25–50; a per-frame wall-clock
   budget guards the frame — the amber `SIM ×n` HUD badge shows the achieved rate if the machine can't
   keep up). Combine
   with `window.goto('<body name>')` to park the ship at the trouble spot, `window.god(true)` to survive
   the trip, and `window.speed(0.25)` for slow-mo once the event is imminent. `window.speed(1)` restores
   normal play. Opening the page with `?dev=1` adds hotkeys: `-` halve, `=` double, `0` reset. Note picks
   still freeze the sim at speed — `game.autoUpgrade = true` if that stalls a long watch.

## Pass criteria (baseline re-measured 2026-07 on the one-sun world: 17 planets, 45 moons)

- **Idle-sky stability (the cleanest signal):** `soak(600, {idle: true})` — **17/17 planets and 45/45
  moons must survive 10 idle sim-minutes.** The idle sky is nearly deterministic: a few seeded moon
  absorptions around t≈210-275 and two seeded rogues meeting the sun around t≈578 are the known-good
  fingerprint. Any planet loss in an IDLE soak is a regression.
- **With the ship alive:** expect the same, *plus* occasional losses of the 1-2 innermost worlds to
  ship-interaction drama (magma/Emberkin artillery near a live ship can chip the firing world off its
  rail into the corona). 15/17+ is normal; losses of OUTER planets, or several at once, are regressions.
- **Moon survival:** moons should essentially all survive; they're railed and orbits are exact by
  construction. A moon `shattered` against its own planet points at invariant #1 or #2 (energy pumping
  in tight pairs).
- **No runaway death cascade:** deaths should be a handful of discrete events, not a steadily climbing
  count. A rising death rate over time = the systems are sandblasting themselves (invariant #3).
- **`nanEvents` must be 0.** A nonzero count (or `Solar Slinger: culled non-finite body` / `reset
  non-finite ship` in the console) means something upstream produced a NaN — the tripwire in physics.js
  contained it, but the source is a real bug. Treat any tripwire firing as a failure to root-cause.
- **Combat (with enemies engaged):** the orbit shield should intercept most thrown-rock volleys
  (~5/6). Enemy density is deliberately sparse — most planets stay free.

## Interpreting deaths

`deaths` entries render from `deathLog` `{t, how, type, mass}` where
`how ∈ {shattered, "vaporized by star", absorbed}`. Map failures back to invariants in
[CLAUDE.md](../../../CLAUDE.md) and the comments in [physics.js](../../../src/physics.js):

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
- `window.speed` affects only the live rAF loop — it never touches `tick`/`soak` results, and
  `game.timeScale` back at 1 restores completely normal play (the scaled path steps `update()` in
  1x-sized chunks, so physics semantics are identical at any speed).
