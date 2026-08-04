---
name: perf-profile
description: Measure Solar Slinger's frame/sim/draw cost correctly and A/B a performance change. Use when the user reports frame drops or stutter, asks "is this faster?", or before/after any edit to the physics step, the field LOD, the registries, or a render pass. Encodes the hidden-pane measurement trap that makes naive timings meaningless.
---

# Performance profiling

The world holds **~4,415 bodies** (3,643 field rock + 772 non-field) and locks 120 fps only because
of the field LOD, the awake list and
the frame registries. This skill is how you measure whether a change actually helped.

Architecture rules being defended: [docs/world-content.md](../../../docs/world-content.md) (the field
LOD section) and [docs/architecture.md](../../../docs/architecture.md).

## The measurement trap — read this before quoting any number

**A hidden Browser pane runs on efficiency cores; timings swing 3–6× against a visible one.** An
absolute millisecond figure from one session is worthless on its own, and comparing a number you took
today against one from an earlier session is worse than not measuring — it will confidently tell you
the wrong direction.

**Only trust an interleaved old-vs-new A/B taken in a single session**, on the same pane visibility,
at the same location, with the same body count. Report the **ratio**, not the milliseconds.

## Where the numbers live

`game.perf`, sampled by `main.frame`:

| Field | Meaning |
|---|---|
| `frameMs` | RAW rAF delta — never `dtReal` (which is clamped to a 20 fps floor and flatlines at 50 ms exactly when it matters) |
| `simMs` / `drawMs` | the two halves of the frame |
| `fps`, `steps` | achieved rate, substeps this frame |
| `dtHz` | the LIVE step — 120 normally, 60 once pacing drops to `CFG.DT_COARSE` |
| `dropped` | total sim seconds lost to the `SUBSTEP_MAX` backlog drop |

All EMA-smoothed. Settings → **Performance metrics** shows them live (plus the effective render scale
and backing-store size — auto quality is silent in play, so that line is the only place a drop below
the chosen ceiling shows). **FPS counter** is a separate toggle.

`game.reg` counts tell you what the frame is actually paying for: `nonField` (the renderer's set,
~380 of ~7,900), `asteroids`, `planets`, `moons`, plus `game.bodies.length` and
`game.bodies._awake.length`.

## Start here: the scenario matrix

Before hand-rolling a measurement, run the harness — it isolates each cost driver instead of giving
you one blended number:

```bash
S=.claude/skills/run-solar-slinger
printf "waitfor window.game 45000\nscript $S/suites/perf.js\n" \
  | npx electron $S/driver.mjs --url 'app://game/index.html?seed=20260721' 2>/dev/null | tail -1
```

Eight scenarios — open-space, dense-field, planet-system, gas-giant, crystal-world, solar-storm,
alien-nest, debris-heavy — each timed for sim and draw separately, with the counts that explain the
timing (`awake`, `attractors`, `crust`, `debris`, `aliens`, `debrisHeadroom`, `dtHz`,
`droppedSimSeconds`). Baseline and full details in the `run-solar-slinger` skill.

It sidesteps the rAF problem entirely: `window.tick(0)` runs zero `update()` calls and exactly one
`render(game)`, so draw is measurable with the window hidden and without a vsync-capped frame loop.
Caveat: that measures draw-call **submission**, not GPU raster.

Reach for the manual procedure below when you need a frame-budget number (`game.perf.*` off a visible
window) or you are profiling something the matrix does not park you next to.

## Procedure

1. **Start the preview**: `preview_start` with `{ name: "solar-slinger" }`. Never Bash for the server.

2. **Pick a repeatable load and say which one you used.** The two that matter are different problems:

   ```js
   window.freshRun(0);                 // fixed seed, spec auto-picked
   window.goto('The Shoal');           // in-field: ~910 nearby rocks, the LOD's worst case
   // or leave the ship in open space for the "cost of bodies you already ruled out" case
   window.tick(5);                     // settle
   ```

   Use `window.locate('<name>')` if you're unsure a landmark exists on this seed.

3. **Let the EMA settle, then sample.** The metrics are smoothed, so read after a second or two of
   real frames — and the pane must be **visible** for rAF to run at all:

   ```js
   ({ frame: game.perf.frameMs.toFixed(2), sim: game.perf.simMs.toFixed(2),
      draw: game.perf.drawMs.toFixed(2), fps: Math.round(game.perf.fps),
      dtHz: game.perf.dtHz, steps: game.perf.steps,
      bodies: game.bodies.length, awake: game.bodies._awake?.length,
      nonField: game.reg?.nonField.length })
   ```

4. **Interleave.** Baseline → change → baseline again. If the two baselines disagree by more than a
   few percent, the machine is noisy and the run is void — repeat rather than reporting it.

5. **Report the ratio**, with the body count, the parking spot, and pane visibility stated.

## Reference costs (for orientation only, not as targets)

Measured at ~8,000 bodies (the 1,900-rock pocket era — an upper bound on today's ~4,415), in-field,
after the LOD landed: **sim 3.6 → 2.3 ms, draw 2.2 → 1.6 ms**,
locked 120 fps. The awake list alone was worth ~1.4 ms (~40% of sim). The registries were worth 1.7×
the frame at doubled body count with an identical 381 awake bodies. The achievement sweep is 0.02 ms
across all ~385 rows. The solar wave costs ~0.4 ms while it crosses the view, nothing otherwise.

## Headless timing

`window.tick` bypasses rAF and is pinned to `CFG.DT`, so it measures **sim only**, repeatably, with no
pane-visibility dependence — good for isolating a physics change from a render one. `window.soak`
returns `wallMs`. Headless calls at this body count can exceed a 30 s console eval budget: **run in
chunks** (`2 × 300 s`, not one `600 s` call).

`window.speed(n)` is for *watching*, not measuring — it needs the pane visible and burns a wall-clock
budget per frame.

## The usual culprits

Before profiling further, grep the diff for these — they account for nearly every regression here:

- A `filter`/`find`/`reduce`/`for` over `game.bodies` looking for a kind of body → use `game.reg`.
- A per-substep loop iterating `game.bodies` instead of `game.bodies._awake`.
- A budget or cap tested against `game.bodies.length` → must count `reg.nonField`. This one silently
  turned chunk spray, spall, the death cloud and Cluster Rounds into dead code once the shoals landed.
- `updateFieldLOD` called per substep instead of once per frame, or advanced by `simSteps * CFG.DT`
  instead of `simSteps * dt`.
- A render pass rejecting shoal rock one at a time to reach the ~380 landmarks.
- A cache keyed off the wrong dpr after a render-scale change.

Then hand the diff to the **`perf-auditor`** subagent for the full rule sweep.
