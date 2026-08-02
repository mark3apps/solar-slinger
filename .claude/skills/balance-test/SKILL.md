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

**Default to the fast path.** A one-seed `window.soak(600)` in the Browser pane costs ~50s wall and
answers about one world. The driver sweep below costs ~19s and answers about four — see
"Why the fast path" for the measurements and the equivalence proof.

### Fastest path — the bench runner with a baseline diff

If you want to know **what your change did** rather than what the numbers are, use the runner: it
snapshots a baseline, re-runs, and prints only what moved (noise floor 0–2 fields).

```bash
B=.claude/skills/run-solar-slinger/bench.mjs
node $B save            # before the change
node $B diff stability  # after — prints only what moved
```

Full suite list, tolerances and how to read a diff: the `run-solar-slinger` skill.

### Fast path — multi-seed sweep (raw numbers)

```bash
S=.claude/skills/run-solar-slinger
for s in 20260721 3827467762 111222333 987654321; do
 ( printf "waitfor window.game 45000\nscript $S/suites/stability.js {\"seconds\":600,\"strip\":true}\n" \
   | npx electron $S/driver.mjs --url "app://game/index.html?seed=$s" 2>/dev/null | tail -1 ) &
done; wait
```

Measured 2026-08: **4 seeds x 600 sim-seconds in 18.9s wall (127x realtime, 450% CPU).** Each line is
one seed's verdict:

```json
{"seed":20260721,"wallMs":10303,"xRealtime":58.2,"planetsAlive":21,"planetsOffRail":0,
 "worstPlanetDriftPct":{"name":"Aster","pct":0},"moonsAlive":48,"moonsAtStart":48,
 "nonAsteroidDeaths":{"moon:absorbed":1,"moon:swallowed by a gas giant":1},"firstWorldLossAt":128}
```

Read them in this order — most load-bearing first:

| Field | Judge |
|---|---|
| `nanEvents` | **must be 0 on every seed.** Any firing is a real upstream bug, even though the tripwire contained it |
| `planetsOffRail` | **must be 0.** A planet alive but off-rail is a deorbit in progress the alive-count cannot see |
| `worstPlanetDriftPct` | healthy seeds read 0 to -0.03%. Anything past ~1% wants explaining |
| `planetsAlive` | 21 on every seed, hard |
| `nonAsteroidDeaths` | **cumulative and cause-classified** — compare the SHAPE across seeds, not one number |
| `firstWorldLossAt` | dropping sharply vs a baseline sweep = something got more fragile |
| `moonsAlive` vs `moonsAtStart` | a trend, NOT a pass/fail — see the moon caveat in the criteria below |

**Judge across seeds, not within one.** A single seed cannot separate a regression from a fragile
layout; that is the whole reason the sweep is cheap now. One outlier seed = investigate that seed.
All four moving together = a real regression.

`strip:true` removes dormant FIELD ROCK before running (~7,600 of ~8,400 bodies). Use `strip:false`
when the dense fields themselves are what you changed.

### Why the fast path (measured, not assumed)

- **Only 138 of 8,404 bodies are awake in an idle soak, yet the 7,600 dormant field rocks cost ~78%
  of the runtime** in pure LOD classification + dormant rail advance. They are gravity-free in both
  directions and can never touch a planet, so they cannot affect the sky verdict.
- **Equivalence proved, same seed, 300 sim-seconds:** stripped 4,516ms vs intact 23,373ms (5.2x), and
  every verdict field identical — planets 21/0 off-rail, moons 48/48, `{moon:absorbed:1}`,
  `firstWorldLossAt` 128. Re-run that A/B if you ever doubt the strip.
- **Parallelism is near-linear** (each process is single-threaded): 4 concurrent seeds cost 18.9s
  versus ~11s for one alone.
- **Never use `window.speed(20)` to hurry a soak.** That is the live rAF path — it renders every frame
  under a per-frame wall budget and is strictly SLOWER than `tick`. It is for *watching* a failure,
  never for reaching one.

### Slow path — single seed in the Browser pane

Still correct, and the right choice when you want to *watch* what a soak found. `preview_start` with
`{ name: "solar-slinger" }`, then one `javascript_tool` call:

```js
window.soak(600, { idle: true });   // 10 idle sim-minutes
```

Returns `{ simSeconds, wallMs, planets: "17/17", moons: "59/59", ship, lives, tier, deaths: [...],
impacts, nanEvents }`. `idle: true` removes the ship first (no life spent). Note its `moons` figure is
a live census, and its `deaths` are formatted strings — see the caveats below. Chunk long runs
(`2 x 300s`) to stay inside the pane's ~30s console eval budget.

3. **Read the result and judge against the pass criteria below.**

4. **Watching a failure live (optional).** When a soak flags something and you (or the user) want to *see*
   it happen: `window.speed(10)` runs the visible game at 10× real time (0.25–50; a per-frame wall-clock
   budget guards the frame — the amber `SIM ×n` HUD badge shows the achieved rate if the machine can't
   keep up). Combine
   with `window.goto('<body name>')` to park the ship at the trouble spot, `window.god(true)` to survive
   the trip, and `window.speed(0.25)` for slow-mo once the event is imminent. `window.speed(1)` restores
   normal play. Opening the page with `?dev=1` adds hotkeys: `-` halve, `=` double, `0` reset. Note picks
   still freeze the sim at speed — `game.autoUpgrade = true` if that stalls a long watch.

## Pass criteria (baseline re-measured 2026-08 after the rarer/wider planet-system
## pass, on the one-sun world: 17 planets, 59 moons — the 17 is the layout's 15
## worlds plus the crystal binary's companion and The Wanderer's Star (the
## expedition layer's dark dwarf, which counts as a planet in the census and must
## survive like one); the 59 is the layout's 58 plus the ring shepherd moonlet)

**Measured baseline — 4 seeds x `suites/stability.js {seconds:600, strip:true}`, idle, all four identical
except where noted.** Every field below held on 20260721 / 3827467762 / 111222333 / 987654321:

| Field | Pass | Why it is the bar |
|---|---|---|
| `nanEvents` | **0** | any firing is a real upstream bug; the tripwire only contained it |
| `planetsAlive` | **17/17** | planets are permanent — losing one is never variance |
| `planetsOffRail` | **0** | alive-but-off-rail is a deorbit in progress the census cannot see |
| `worstPlanetDriftPct` | **< 1%** | measured 0 / 0 / 0 / 0 across the four seeds |
| `moonsAlive` | **59/59**, and equal to `moonsAtStart` | genuinely holds now — see the history note below |
| `nonAsteroidDeaths` | **`{}`** — empty on all four seeds | any entry at all is the signal; the per-cause bars below are what a REGRESSION would look like |
| `moon:absorbed` | **0** | was 1/5/7/7 before the conjunction fix; a return means that guard regressed |
| `moon:swallowed by a gas giant` | **0**, and never more than ~4 per 600s | a jump means a new loose-moon source |

**Judge across seeds, not within one.** One outlier seed = investigate that seed. All four moving
together = a real regression. Run the sweep before AND after a change; the numbers above are the
"after" of a known-good branch, not a universal constant.

### History — why `moonsAlive` was NOT trustworthy before 2026-08

`moonsAlive` is a **live census with re-accretion** (`replenishWorld` rebuilds moons), so it was a
wobbling snapshot rather than a loss count and could read a perfect 48/48 while nine moons had died.
Pre-fix measurements, same four seeds, no `src/` change: 48/48 with `absorbed 1, swallowed 1`;
48/48 with **`absorbed 5, swallowed 4`**; 43/48; 43/48. The census could pass a broken sky and fail a
healthy one, which is why `nonAsteroidDeaths` (cumulative, cause-classified) is now the primary
signal and the count is only corroboration.

The cause was found and fixed: neighbouring planets' moon families overlap radially by design
(`moonZone` reached to `hill * 1.5` then, `hill * CFG.MOON_ZONE_MUL` now, so systems stay wide — 16 of
20 adjacent pairs overlapped on seed 3827467762, several by >8000u; the rarer/wider pass since took
that to 14 of 16 and a worst overlap of 20,771, which the all-prograde sky is what pays for),
adjacent lanes always reach conjunction, and a sub-`DMG_THRESH` brush
at closing 70-185 did no damage and logged nothing yet still tripped the `closing > 25` derail in
`collideBodies` — knocking a moon out of its exact orbit and, near a gas giant, into the cloud tops.
Two railed natural celestials now pass through each other below `DMG_THRESH`. **If `moon:absorbed`
ever returns, that guard is the first place to look.**

### Known remaining edge

A moon brushing a **station** can still derail (measured: one event in 700s on seed 987654321, closing
138). Stations were deliberately left out of the conjunction guard — they station-keep under thrust
and carry their own "must never wander" rules, so lumping them in is a separate decision.

  - The Tantal sibling-slot eccentricity clamp in world.js `spawnMoon`/`addPlanet` is still
    load-bearing: **repeatable same-time same-mass moon absorptions in the first ~5 minutes mean that
    clamp has regressed.**
  - **Dense-field asserts the planet/moon census cannot see** (worth adding to any field-related
    soak): per pocket, rocks within ~6000u of `game.fields[i]` should stay near `CFG.FIELD_ROCKS`
    (the reknit refills off-view); every field rock must satisfy `b.fieldRock && !b.attractor`
    (gravity-free in both directions); and railed field rock must carry `b.rail.w === fields[i].w`
    (the rigid-pocket rule — a mismatch shears the pocket apart).
- **With the ship alive:** expect the same, *plus* occasional losses of the 1-2 innermost worlds to
  ship-interaction drama (magma/Emberkin artillery near a live ship can chip the firing world off its
  rail into the corona). 20/21+ is normal now that nothing wanders the sky unprompted; losses of
  OUTER planets, or several at once, are regressions.
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

`soak().deaths` is an array of **pre-formatted strings** — `"moon swallowed by a gas giant @70s
(m=12245)"` — rendered from the raw `game.deathLog` records `{t, how, type, mass}`. Filter them with
`.startsWith('moon')` / `!d.startsWith('asteroid')`; `d.type` is undefined on the formatted strings
and a `d.type !== 'asteroid'` filter silently matches everything. Read `game.deathLog` directly when
you need the fields. Observed `how` values: `shattered`, `absorbed`, `vaporized by star`,
`swallowed by a gas giant`. Map failures back to invariants in
[docs/physics-invariants.md](../../../docs/physics-invariants.md) and the comments in
[physics.js](../../../src/physics.js):

| Symptom | Likely broken invariant |
|---|---|
| Star-anchored planet `vaporized by star` | #2 (neighbor-star damping) or #6 (`WORLD_R`/boundary exemption) |
| Moon `shattered` against its planet | #1 (snapshot before integrate) or #2 (symmetric pair weight) |
| Death count climbs steadily over time | #3 (ambient damage threshold) |
| Anything launches a planet out of orbit | #4 (damped natural impulse / immovable heavy) |
| Ship dies instantly to one thrown rock | #5 (ship bounce/impact cap) |

## Caveats

- Runtime spall/spawn/AI use `Math.random`, so exact deaths vary run-to-run. Judge *aggregate* balance
  (counts, trends), not bit-exact replay. Run 2–3 times if a result is borderline.
- This is a stability/balance check, not a visual check. For visual-language regressions (shield, dashes,
  hint colors) verify in the browser and consult the `visual-language-reviewer` subagent.
- `window.speed` affects only the live rAF loop — it never touches `tick`/`soak` results, and
  `game.timeScale` back at 1 restores completely normal play (the scaled path steps `update()` in
  1x-sized chunks, so physics semantics are identical at any speed).
