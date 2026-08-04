# Testing — headless soaks, the mechanics suite, and live fast-forward

> Deep reference for every console hook. There is no test runner. The `balance-test` and
> `mechanics-test` skills wrap the two standard checks; this file is the full hook catalog.

There is no test runner. Verify balance and physics with the console hooks (all defined at the bottom
of main.js; ship-damage god mode and the NaN tally hook into physics.js):

- `window.soak(seconds, {idle})` — **the one-call balance soak**: arms `collisionLog`/`deathLog`/
  `game.nanEvents`, forces `autoUpgrade` on for the duration, `window.tick`s, and returns a summary —
  `{ planets: "17/17", moons: "59/59", ship, lives, tier, deaths[], impacts, nanEvents, wallMs }`.
  `{idle: true}` kills the ship first (no life spent — deathCause stays empty) for the cleanest
  sky-stability signal. Judge the result against the `balance-test` skill's pass criteria.
  **Soaks now run on a RANDOM world** unless you pin one — load `?seed=20260721` for a run that is
  bit-comparable with an earlier soak. The 17/45 criteria hold on any seed (the layout table is fixed);
  `game.worldSeed` records which world a given result came from, so quote it when reporting.
- `window.tick(seconds)` — steps the whole game headlessly at fixed dt (physics still subdivides to
  `CFG.DT`), then renders once. `window.tick(300)` fast-forwards 5 minutes. The raw primitive under
  `soak` — use it directly when you need custom instrumentation between chunks.
- `window.mechTest({seed, reset, download})` — **the scripted mechanics suite** (devtest.js,
  lazy-loaded): a fixed set of player actions against a fixed-seed fresh run, asserting each core
  mechanic and several design laws (fling-at-cursor/no-recoil, deferred picks, split-health, orbit
  gating, NaN containment, the three docking gates and what a berth makes inert, the solar-wave
  classes, the aimed riposte, the pilot card's keydown/click/paused-guard answer paths, and that a
  landmark's collider agrees with the polygon render draws it as).
  **Bit-repeatable** — the world seed is fixed and `Math.random` is swapped
  for a seeded RNG for the duration — so same code ⇒ identical report. Two things had to be true for
  that to actually hold, and neither was until issue #96: nothing outside the sim may draw from the
  swapped stream (sfx/music/hud now own private ones), and nothing seeded off a body id may outlive
  its world (`generateWorld` resets the id counter). Every result carries a **`draws`** field — the
  RNG draw count at that test's boundary — which is the tripwire for a recurrence: a drifting column
  localises the culprit to one test in a single diff. Returns
  `{ passed, failed, results, logs }` (also `window.lastMechReport`; `{download: true}` saves the
  JSON). ~4s wall. See the `mechanics-test` skill for the check list and judging rules.
- `window.freshRun(specIdx, seed)` — repeatable fresh run: full reset onto the given world seed with
  the spec auto-picked and the sim armed. The world layout is bit-identical per seed.
- `window.speed(n)` — **live fast-forward**: runs the *visible* game at n× real time (0.25–50).
  `updateScaled` steps `update()` in 1x-sized chunks (the tick idiom) so AI/timers/easing see normal
  per-step dt, with a ~24ms wall-clock budget per frame — an unreachable target degrades gracefully and
  the amber HUD badge shows target + achieved rate (`game.speedActual`). 0.25 is slow-mo for watching a
  collision frame-by-frame-ish. `?dev=1` on the URL adds hotkeys: `-` halve, `=` double, `0` reset.
  Picks still open (and freeze) normally at speed — set `game.autoUpgrade = true` to blast through them.
  For truly unbounded fast-forward use `tick`/`soak` (headless, no render). **`speed()` is the SLOW
  path for covering sim time** — it renders every frame and holds a ~24ms per-frame wall budget, so
  it is for *watching* a failure, never for reaching one.
  **Throughput, measured 2026-08 on an M-series laptop at 8,437 bodies: `tick(300)` idle = 28.4s
  wall, i.e. ~10x realtime** (window visibility made no difference — 9.4x shown, 10.6x hidden).
  (History: this line claimed ~35x+, which dates from a ~380-body world; the four dense fields put
  ~7,900 more bodies in the array and the rate fell with it.) The lever for a long campaign is
  PARALLELISM, not a multiplier: three `run-solar-slinger` driver processes soaking different seeds
  at once finished 900 sim-seconds in 30.7s wall (~29x aggregate, 353% CPU) — near-linear, because
  each process is single-threaded and the cores are otherwise idle.
- `window.goto('vesper')` / `window.goto(x, y)` — teleport the ship beside a named body (velocity
  matched, parked outside its radius, brief invuln, camera snapped) or to coordinates.
  `window.locate('name'|'type')` returns the body itself.
- `window.god(on)` — ship ignores all damage (`damageShip` early-out) for poking at the corona,
  forts, or gas cores without respawn loops.
- `window.storm('charge' | 'here' | 'off', cls)` — fire a SOLAR WAVE now instead of waiting out
  `CFG.STORM_EVERY`. `'charge'` starts at the telegraph so you see the whole event; `'here'` parks a
  front just inside the ship so the sheath is about to arrive (checking exposure/shelter without a
  40-second wait); `'off'` clears it. **`cls` pins the intensity** — a `CFG.STORM_CLASSES` key
  (`'squall'` / `'surge'` / `'cme'`, weakest first) or an index; omit it for the same flat random
  third-each pick the sky makes. Pin it whenever you are checking one class's numbers or palette, and
  remember the live wave carries its own stats (`game.storm.dps`, `.tail`, `.blind`, `.k`…) — reading
  `CFG` for those will mislead you. **The return value reports `k` and `reachR`**, because a class
  summoned OUTSIDE its reach is already spent and expires on the next frame — correct (a squall
  cannot exist past half the system) and invisible unless you read it.
- `window.game` — the live state handle. `game.prog.ach` is the achievement ledger: `.score`,
  `.order` (ids, in the order earned), `.got` (id → seconds), `.stats` (every raw counter). Reading
  `.stats` after a soak is the fastest way to check a new achievement's predicate is fed by anything.
- `game.autoUpgrade = true` — auto-resolves each pick (picks card 0) so soaks never stall. Drive a
  climb by pumping `game.prog.xp`.
- **Specs headlessly:** `window.tick` bypasses the spec modal by seeding `SPECS[0]` when
  `game.prog.spec` is null. To soak a different spec (or a specific build), assign `game.prog`
  wholesale — `{ xp, level, tier, picksThisTier, spec, upgrades: { abilityId: rank }, lives, … }` —
  then `window.tick(1/60)` once to rebuild `game.st` before measuring.
- `window.musicState()` — the music director's live mood vector (`world`/`sun`/`danger`), duck level,
  and per-bed gains/stream state. Mood advances under `window.tick` even with no AudioContext.
- `window.zoneState()` — the locale director (`zone.js`): the zone owning the cockpit accent, seconds
  in it, what it `want`s next, the crossfaded `rgb`, and every `pres`ence score — i.e. the whole
  switch decision in one object. Park the ship and `window.tick(9)` (past `DWELL_OUT` + the fade) to
  read a settled zone; presence is pure geometry, so it is the same on every seed.
- `game.collisionLog = []` — opt-in; records `{t,a,b,closing,dmgToA,dmgToB}` for impacts >2 dmg.
- `game.deathLog = []` — opt-in; records `{t,how,type,mass}` on every body death.
- `game.nanEvents` — count of NaN-tripwire firings (body culls / ship resets). Any nonzero value is
  a real upstream bug to root-cause, even though the tripwire contained it.

Run these from `javascript_tool` against the preview (the pane suspends rAF when hidden, so `window.tick`
/`window.soak`/`window.mechTest` are the way to advance the sim; `window.speed` needs the pane visible to
actually render). Two skills wrap all this: **`mechanics-test`** (fast "did I break the game loop?" —
runs `mechTest` and judges it) and **`balance-test`** (long-horizon stability — runs `soak` against the
17-planet/59-moon baseline — the 17 is the layout's 15 worlds plus the crystal binary's
companion and The Wanderer's Star, the expedition layer's hidden dark dwarf).
