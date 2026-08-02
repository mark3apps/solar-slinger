# The loop, the fixed step, and dt discipline

> Deep reference. [CLAUDE.md](../CLAUDE.md) carries the summary; read this file before touching
> `main.js`'s frame loop, `CFG.DT`/`SUBSTEP_MAX`/pacing, or anything that decides *which clock* a
> system rides. See also [world-content.md](world-content.md) for the field LOD, the awake list and
> the frame registries — the other half of what makes ~8,000 bodies affordable.

## The loop (main.js)

- `frame(now)` → `dtReal = min(0.05, delta)` (clamps tab-switch stalls) → `update(dtReal)` **only while
  `game.started && !paused && !settingsOpen && !choosingUpgrade`** → always `render(game)` +
  `hud.updateHud(game)`. Rendering continues while frozen; the sim freezes. The frozen world is the
  living backdrop behind every menu overlay.
- Physics runs on a **fixed substep** via an accumulator: `while (acc >= dt && simSteps < CFG.SUBSTEP_MAX) { updateTractor; updateOrbit; step(game, dt); cam follow; acc -= dt }`, where `dt` is the live step `simDt` — `CFG.DT` (1/120) normally, `CFG.DT_COARSE` (1/60) on a machine that can't keep up.
- **FRAME PACING breaks the fixed-timestep death spiral** (main.js `updatePacing`, thresholds in config.js).
  The accumulator's substeps-per-frame count RISES as fps falls (60 fps = 2, 15 fps = 6), so a late frame
  is handed 3x the sim work for being late — measured in a shoal, sim 2.5ms at 1 substep vs 7.1ms at 6
  against a 1.7ms draw. Two guards: `CFG.SUBSTEP_MAX` (3) caps substeps per frame and **DROPS** the
  leftover backlog (`acc %= dt`) — carrying it is what compounds; and `simDt` drops to `CFG.DT_COARSE`
  after `PACE_DWELL` of persistently slow frames, halving the cost instead of dilating time. The two are
  sized against each other: 3 x 1/60 = 50ms = exactly the `dtReal` clamp, so **nothing is ever dropped on
  the coarse step**. Enter is on frame time (vsync can only make it look faster); exit is on projected
  WORK (`2 x simMs + drawMs`) plus a frame-time clause — a 60 Hz display floors `frameMs` at 16.7ms, so a
  frame-time-only exit stranded it on the coarse step forever. Nothing changes on a machine that keeps up.
- **`CFG.DT` is the REFERENCE step, and every headless path is PINNED to it** (`pinFineStep` in
  `window.tick` and mechTest's `stepSim`; `window.speed` too, so fast-forward semantics stay 1x). Only
  `frame()` may repace — if measured frame time leaked into a harness, `soak`/`mechTest` would integrate
  differently per machine and neither would be repeatable. `game.perf.dtHz` reports the live step and
  `game.perf.dropped` totals the sim seconds lost to the cap (console-readable, not on the HUD overlay).
  A coarser step is a relief valve, not a free win: it doubles how far a body moves between collision
  tests, and `damageBody`'s per-CALL wear gates (invariant 7) see 2x the damage per call from the
  continuous dps sources (corona heat, atmosphere burn).
- **A variable step means `updateFieldLOD` must advance by `simSteps * dt`, never `simSteps * CFG.DT`** —
  on the coarse step those differ by 2x, and ~7000 dormant field rocks would silently drift off the sim clock.
- **Gameplay math goes inside the `CFG.DT` loop.** Cosmetic easing with no quantized target
  (shake decay, the zoom ramp) rides `dtReal`. Frame-rate-independent easing idiom: `lerp(a, b, 1 - Math.exp(-k*dt))`.
- **The two DIRECTORS run every frame, frozen or not**, after the sim block and before `render`:
  `music.updateMusic(game, dtReal)` then `zone.updateZone(game, dtReal)`. Both smooth on the wall clock
  (a menu still has to duck the music, and both crossfades are cosmetic easing with no quantized
  target), and both are also driven from `window.tick` — the pane suspends rAF when hidden, so a
  headless soak is the only clock they'd otherwise have.
- **The camera follow is the exception: it lives INSIDE the `CFG.DT` loop**, not on `dtReal`. Its target
  (the ship) advances in quantized DT chunks; a `dtReal`-chased camera beats against that quantization as
  the substeps-per-frame count wobbles, and the ship visibly jerks back and forth around screen centre
  (worse the higher the zoom). Phase-locking ship and camera to one clock is what keeps flight smooth.

