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

**Clone with [Git LFS](https://git-lfs.com) installed** (`brew install git-lfs && git lfs install`).
The 24 music beds (~176 MB) are LFS-tracked — see `.gitattributes`. Without LFS you get 130-byte
pointer files, the `<audio>` elements fail to decode, and the game runs SILENT with no error that
points at the cause. `git lfs pull` fixes an already-bad clone. Everything else in the repo is
plain text; only `assets/audio/music/*.m4a` is tracked (the SFX pack is small enough to stay inline).

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
| [config.js](src/config.js) | All tuning constants (`CFG`, `TIERS`, `PROG`), the `SPECS` + `ABILITIES` catalog, and the pure `newProgress()` / `shipStats(prog)` / `tierChoices` / `applySpec` / `applyTierUp` / `addXp` / `growAbilities` / `abilityRankCost` derivations. |
| [entities.js](src/entities.js) | The only classes: `Body`, `Ship`, `Alien`. Plus `railBody`/`derail`, `scrapValue`, `makeScrap`. |
| [world.js](src/world.js) | `generateWorld` (seeded), `respawnShip`, `replenishWorld`, `spawnAsteroid`. |
| [physics.js](src/physics.js) | `step` — N-body integration, collisions/damage, rails, the trajectory predictor. **The load-bearing file.** |
| [tractor.js](src/tractor.js) | Grab / hold / fling, the aim lead-marker solver, the orbit shield. |
| [ai.js](src/ai.js) | Alien state machines (grabbers, wreckwrights, golems), Bastion forts, nests. |
| [glow.js](src/glow.js) | Glow pockets — the healing mote fields (seed / update / collect). Rides dtReal, never the fixed step. |
| [achievements.js](src/achievements.js) | The run's scoreboard: the ~370-row catalog, the stat ledger, and the per-frame predicate sweep. Imports only config — a near-leaf. |
| [render.js](src/render.js) | All canvas drawing. Owns the 2D context. |
| [hud.js](src/hud.js) | All DOM/HUD access (cached in `el`). The sim never touches the DOM. |
| [input.js](src/input.js) | Raw keyboard/mouse state + listeners. |
| [sfx.js](src/sfx.js) | Audio engine: owns the AudioContext + the sfx/music buses. EVERY sound is a real CC0 recording (`assets/audio/sfx/` — Kenney + OpenGameArt, lazily decoded): one-shots via the `BANK` variant table, continuous state (thrust/beam/heat/scrape/charge) via the `LOOPS` table — loop-authored samples with game-driven gain/pitch. The synth blips at the bottom are decode-window fallbacks ONLY — the user explicitly rejected synth as the primary voice; never promote them back. |
| [music.js](src/music.js) | Adaptive music director: 24 Scott Buckley CC-BY tracks (`assets/audio/music/`, one composer so every mood shares one voice) in six PLAYLISTS — four picked by the mood vector (calm / world / sun / danger) and two by GAME STATE, which outranks mood: **title** (splash) and **menu** (paused / shell modal mid-run). **Exactly one track plays at a time** (they're full mixes, not stems — layering them sounded like songs on top of each other): the mood vector picks a playlist with enter/exit hysteresis + dwell, switches crossfade, and a track ending naturally rotates within its playlist. Every playlist needs ≥2 tracks — a one-track list rotates to itself at its natural end and `switchTo` early-outs on that, so the fallback is a manual replay. Streams via `<audio>` elements (never `decodeAudioData` — a 7-min track decodes to ~150 MB of PCM). Runs every frame, sim frozen or not. |
| [util.js](src/util.js) | Pure helpers (`lerp`, `mulberry32`, `rand`, `pick`, `TAU`). |
| [devtest.js](src/devtest.js) | The scripted mechanics test suite (`window.mechTest`). Lazy-loaded only when invoked — normal play never imports it. |

The player ship hull is procedural vector art: `drawShipHull(game, tier, dmg, r)` in render.js
draws 6 tier designs x 3 damage states (picked from `game.st.tier` and hull fraction) in the
ship's local frame, nose along +x, per the `SHIP_TIERS` spec table. Ring assemblies rotate in
world space in the orbit shield's spin direction (+angle). Damage scars are seeded per
(tier, dmg) so they're stable frame to frame — don't swap them to `Math.random`. The shield
bubble wraps `shipVisualR(tier, r)` (the drawn art's reach = `r / SHIP_HIT_FRAC`), not the
collision radius. The collision radius is a UNIFORM `SHIP_HIT_FRAC` (0.66) of the drawn
footprint on every tier: `shipStats` reads it from `SHIP_RADIUS[tier]` (config.js), derived as
`SHIP_HIT_FRAC × footprint`, where the FOOTPRINT grows by an equal RATIO each tier (perceptual
evenness). render.js normalizes the art to the footprint (`u = r / (SHIP_HIT_FRAC × reach)`),
so tuning the fraction moves only the hitbox, never the drawn size. (History: the hitbox used
to be the body disc alone — 43% coverage at tier 0 vs 57% at tier 5 read as "collisions don't
match the ship".) Keep `SHIP_RADIUS` and `SHIP_ZOOM` in sync with `SHIP_TIERS` proportions;
the derivation rules live in the config.js comments.

**Import rules:** named exports only (no default exports), explicit `.js` extensions on every
import path (native browser ESM requires them), `config`/`util` are leaves.

### The loop (main.js)

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
- **The camera follow is the exception: it lives INSIDE the `CFG.DT` loop**, not on `dtReal`. Its target
  (the ship) advances in quantized DT chunks; a `dtReal`-chased camera beats against that quantization as
  the substeps-per-frame count wobbles, and the ship visibly jerks back and forth around screen centre
  (worse the higher the zoom). Phase-locking ship and camera to one clock is what keeps flight smooth.

### The front-end shell (splash / pause / settings / controls / credits / achievements)

The game boots to a **splash screen**, not straight into play — flags on `game` gate it, and the
sim runs only when all are clear (the `frame()` gate above): `started` (false → splash; START sets it),
`paused` (pause menu), and the four **shell modals** `settingsOpen` / `controlsOpen` / `creditsOpen` /
`achievementsOpen`.
Those four are separate flags (each is its own panel) but every gate treats them alike, so they're asked
about through one leaf helper — **`util.shellModal(game)`** — which main, hud, music and render all use.
They're mutually exclusive: each fully REPLACES the panel it opened over, so `openX` clears the others
rather than stacking (a panel peeking out around another's edges looks broken). That replacement rule
covers the **death / game-over panels and the `#msg` slot too** — `syncMenus` hides all three while a
modal is up and restores them from the live flags on close. It became load-bearing when ACHIEVEMENTS
turned out to be reachable *from* the game-over screen: they're centered `.panel`s as well, and `#msg`
sits at 17% from the top, exactly where a panel's header is. `choosingUpgrade` still
freezes independently — and START goes straight into it: `startGame` calls `openSpec`, so the first thing
after the splash is the **specialization choice**, held over the frozen just-started world. `resetRun`
re-arms it for a fresh run.
- **Transitions live in main.js** (it owns the state); **hud.js only routes the clicks** and derives which
  overlay is visible from those flags every frame in `syncMenus` (guarded, so the DOM is touched only when
  a flag flips) — same owner-split as the upgrade modal. `hud.initMenus(handlers)` wires the buttons once.
- **ESC / P** are one context-sensitive handler (`toggleMenu`): resume↔pause in-game, back out of whichever
  shell modal is up, never dismiss an upgrade card, no-op on the splash or over the death/game-over panels.
  The on-screen **☰ button** (top-right, below the minimap) just calls `pauseGame`. Player input
  (grab/fling/RMB) is gated behind `menuBlocking()` so nothing reaches the sim through a menu.
- **The splash backdrop is a LIVE sim, not a still.** `driftSplash` (main.js) flies a slow wide
  establishing shot — the camera orbits the sun at `SPLASH_ZOOM` — while running the fixed-step
  **physics only**: `step(game, CFG.DT)` on its own accumulator, never `update()`. update() is the
  player's loop, and a title screen must not spend a life, bank XP, or queue a message. Two guards keep
  it consequence-free: the ship is pinned invulnerable (a belt hit can't kill it and charge `prog.lives`
  for a run that hasn't started), and every `EVENT_MSGS` flag `step` raises is CLEARED each frame instead
  of drained (else they'd all fire as messages the instant START ran). `replenishWorld` and `updateAliens`
  stay out on purpose — the survey scan pays `XP_SURVEY` and sets `b.seen`, so idling on the menu would
  bank progress and burn off the minimap fog before the run began.
  Two things must ride the physics clock or the backdrop misbehaves, and both were real bugs the moment
  it went live: **`game.shake` is zeroed every splash frame** — `step` pumps it on any heavy ambient
  collision system-wide (`physics.addShake`, capped at 30) but its DECAY lives in `update()`, so it
  saturated and render's ±15px random jitter shook the whole sky forever; and **the camera advances
  INSIDE the substep loop**, not on `dtReal` — same phase-locking law as the in-game follow cam, because
  a live backdrop moving in quantized `CFG.DT` chunks is something a `dtReal` camera beats against.
- **The title console boots, it doesn't just appear.** `.boot` on the splash (added by `hud.playBoot`)
  runs a ~1.2s power-on: scan sweep → wordmark resolving out of a glyph scramble (`scrambleTitle`, a
  same-length substitution so the centered title never reflows) → subtitle tracking closing → buttons
  staggering in. Every entry animation needs `backwards` fill or the stagger does nothing. It replays on
  every fresh showing of the splash but NOT when a shell modal closes back onto it — the console is
  already booted, and re-running it there reads as a glitch (`prevSplash` / `prevModal` in `syncMenus`).
- **CONTROLS is a schematic, not a table** — real key caps in their true WASD geometry plus a drawn mouse,
  with a readout strip that answers "what does this do?" when you point at one. Each cap carries its own
  `data-fn` / `data-note` and `hud.initControlMap` delegates hover/focus to mirror them into the readout,
  so **adding a control is an HTML edit** — nothing in JS needs to know it exists. The caps are `<button>`s
  so a keyboard walks the same schematic via focus. A gold pip marks ability-gated controls. The readout is
  sized for its LONGEST note, not the current one, or the centered panel bounces as the cursor crosses it.
- **Settings** (Music/SFX volume sliders, Trajectory prediction, Render scale, Auto quality,
  FPS counter, Performance metrics, World seed) persist to
  `localStorage['ss_settings']` — host-agnostic, so it works identically under serve.py and Electron.
  `loadSettings()` runs BEFORE the boot `regenWorld()` on purpose: a pinned seed has to reach the very
  first world, and loading after it would make every boot world random regardless of the setting.
  There are NO audio toggles — a slider at zero IS the mute (music at zero pauses its streams
  entirely, not just silences them). The Web Audio context must still first be created *inside* a
  user gesture (a context built at page load starts suspended and never resumes): `sfx.initAudio`
  runs only from clicks/keys, and the settings loader only STORES the persisted volumes. main.js
  also arms it from a **one-shot window `pointerdown`/`keydown`** — every other call site is a shell
  button, so on a cold load the TITLE bed could only start if you clicked SETTINGS/CONTROLS/CREDITS;
  a click on START armed audio and immediately left the splash, and the title theme never played.
  pointerdown fires before the button's click handler, so the bed is already rising as the panel opens.
- **The splash and the pause menu have their own music beds** (`title` / `menu` in music.js), chosen
  by game state ahead of the mood vector. Because those beds ARE the content there, they play at full
  level — the old menu duck now only covers the ~2s before the crossfade lands. `choosingUpgrade` is
  deliberately NOT a menu: pick cards land mid-flight every couple of minutes and swapping the score
  under each one would shred the soundtrack, so it keeps ducking the gameplay track instead. A shell
  modal opened FROM the splash stays on the title bed — no run has started, so there is nothing to pause.
  The volume DEFAULTS are deliberately lopsided (music 0.85, SFX 0.5): the ambient tracks are mastered
  quiet while the CC0 sample packs run hot — at equal gains the SFX buried the soundtrack.
  The settings panel's credit line ("Music: Scott Buckley … Kenney.nl") is REQUIRED by the CC-BY music
  licenses — see `assets/audio/CREDITS.md`; don't remove it while those tracks ship. The **CREDITS**
  panel carries the full attribution (every track title, both licenses); the settings line stays put
  regardless, because `CREDITS.md` names it specifically.
- **The world seed is RANDOM per run.** `main.pickSeed` resolves it in one order — `?seed=` on the URL
  (wins outright, so a repro link works even for a player who has pinned one), then the Settings field,
  then `Math.random`. `main.regenWorld(seed)` is the single builder: boot, `resetRun`, and a seed
  committed on the splash all go through it, and it records the live seed as `game.worldSeed`.
  `generateWorld`'s own `20260721` default stays put — `devtest.js` leans on it for its fixed baseline.
  `util.seedFrom` maps typed text to the uint32 mulberry32 wants: plain digits stay themselves (so the
  number shown in the settings note regenerates exactly that world), anything else is FNV-1a hashed, so
  worlds can be named. Committing a seed (blur/Enter) re-rolls **only from the title screen**, where the
  splash backdrop is a live sim and the new world can be seen before START; mid-run it waits for the
  next run and the note line says so. Typing never re-rolls — that would rebuild the system per keystroke.
- **A focused text field owns the keyboard** (`input.js`). Every gameplay hotkey is a bare letter, so the
  keydown listener bails out on `INPUT`/`TEXTAREA`/contenteditable targets — without it, typing a seed
  fires `R` (respawn, and on game over a full restart), `T`, `P`, the digit picks, and the `w`/`s`
  `preventDefault` swallows those letters before the field ever sees them. ESC is deliberately let
  through first, so it still backs out of a panel from inside the field.
- **The perf overlay** (`#perfBadge`) has two independent Settings toggles: FPS counter (top line) and
  Performance metrics (frame/sim/draw ms, substeps, and the live array counts). `main.frame` owns the
  sampling into `game.perf`; hud.js only formats it. Frame time is the RAW rAF delta, never `dtReal` —
  `dtReal` is clamped to a 20 fps floor and would flatline at 50ms exactly when the overlay matters.
  Timings are EMA-smoothed and the text refreshes at ~5 Hz (per-frame digits strobe too fast to read);
  both toggles off costs one `classList` check. Amber, like `#speedBadge` — this HUD's helper/debug
  colour, kept clear of the semantic hull-green / shield-blue / lives-pink instruments. The metrics
  block also reports the EFFECTIVE **render scale** + backing-store size — auto quality (below) is
  deliberately silent in play, so this line is the only place a drop below the chosen ceiling shows.
- **RENDER SCALE is the one quality knob** (`game.renderScale`, Settings: 50/75/100% of native dpr).
  `render.js`'s `resize()` sizes the world canvas at `native dpr x scale`; `#game` is CSS-stretched to
  the window, so a lower scale only SOFTENS the picture — `vw`/`vh` stay CSS pixels, so `cam.zoom`,
  `viewR`, `mouseWorld` and every `/zoom` UI stroke are untouched and the scale can never reach the
  sim. **The RADAR deliberately stays at native dpr** (its own `rdpr`): 200x200 CSS px is under 2% of
  the world canvas's pixels, and its 1px dots would be the first thing to turn to mush — downscale the
  picture, not the instruments (the minimap dot cache sizes off `rdpr` for the same reason, so a scale
  change can't leave it baked at a resolution its transform no longer matches). The setting is a
  **CEILING**: `main.updateAutoScale` may step BELOW it (never above) when `perf.frameMs` blows the
  budget, one notch at a time on a 5s dwell — a resolution change is SEEN, and a scale that hunts is
  worse than one that is simply too low. The climb can't read `frameMs` alone (rAF is vsync-capped, so
  it never drops under ~16.7ms however much headroom exists), so it PROJECTS the next notch's cost
  from `drawMs`, treating all of it as fill: an overestimate, which is the safe direction. Skipped
  while `timeScale !== 1` (fast-forward burns a sim budget, not a pixel one) and for the first
  seconds after boot. Defeatable via **Auto quality**, because a 100% setting silently running at 50%
  reads as a broken setting rather than as a ceiling.
- **EXIT** calls `window.close()` — quits the Electron window; a harmless no-op in a plain browser tab.
- `window.tick` sets `started = true` so headless soaks bypass the splash.

## Conventions

- **Only `Body`/`Ship`/`Alien` are classes.** Everything else is free functions that take `game`
  (or an array) first and mutate in place. Scrap, rails, flares, bolts, turrets, `fort` are plain objects.
- **Naming:** `SCREAMING_SNAKE_CASE` config constants; `camelCase` everything else; terse locals are
  idiomatic (`b` body, `s` ship, `p` planet, `st` ship-stats, `prog` progression, `vx/vy`, `ax/ay`, `w` angular velocity).
- **Comments are load-bearing — they explain *why*, and most guard a real past bug.** Preserve the
  rationale comment when you touch a tuned constant or a physics decision. Do not delete a "don't regress"
  comment without understanding the bug it names.
- **Roguelite progression is SPECIALIZATION-based.** There is NO passive leveling. The run OPENS on a
  choice of one of three **specs** (`SPECS` in config.js — BRAWLER / HAULER / SCOUT; `main.openSpec`
  from `startGame`). `applySpec` locks `prog.spec` and grants that spec's **starting-kit**
  abilities at rank 1. **Kit rule:** every kit carries at least THREE abilities with `max > 1` —
  a max-1 unlock arrives already maxed and never ranks, so a thin kit opens the run with almost
  nothing climbing (the ability bars are the minute-one feedback; the first card is minutes out).
  The spec choice is FREE — it spends no XP, no level, and no tier slot, so the
  XP bar starts empty (a paid opener read as "it skipped my first upgrade").
- **Named abilities, spec-scoped, one currency.** `ABILITIES` (config.js) is the whole catalog: each
  entry has an OWNER `spec`, `max` ranks, a `weight`, and a **`minTier` soft floor** (it can't be
  OFFERED until you reach that tier — capstones sit at 3). An optional **`also: { specId: minTier }`**
  map shares an ability with other specs at their own (usually higher) floors — the Scout sensor/QoL
  chain (Retro Jets, Gravity Compass at tier 1; Nav Plotter, Lead Computer, Impact Warning at tier 2)
  reaches BRAWLER/HAULER this way, and Afterburner reaches BRAWLER only at tier 4 (`tierFloorFor` is
  the one resolver). An optional **`xpMul`** scales that ability's whole automatic rank ladder —
  late-floored rows discount it (0.5 at `minTier` 3, 0.7 at 2) because they're learned with only a
  fraction of the run's XP left to earn. An optional **`needs: '<channel>'` is a HARD PREREQUISITE**
  (`config.prereqMet`, filtered in `tierChoices`): the row isn't OFFERED until you own an ability
  feeding that channel. It exists only for rows that are literally INERT alone — Scattergun /
  Rockwall / Aegis Reflector / Recovery Tether all act on ORBIT rocks, and with no orbit ability
  `shipStats` gives `orbitCap` 0 / `maxOrbiters` 0 so there is never a rock to act on; Impact
  Warning is gated behind the plotter inside `shipStats` itself (`hasCrashWarn = collisionC > 0 &&
  hasPredict`). Each was a dead card: it spent the pick, its bar climbed, nothing happened. It names
  a CHANNEL, not an id, so it resolves across specs with no per-spec table (orbit = BRAWLER's War
  Rack and HAULER's Orbital Sling / Expanded Bay alike). Every channel a `needs` points at has at
  least one un-gated tier-0 provider in that spec's pool, so a gate can never deadlock. Do NOT add
  it to the second-track duplicates (Grapple Extenders, Expanded Bay, Overtuned Drive, Bulk
  Freighter, Juggernaut) — they READ like extensions but work fine standing alone.
  `channel` is the stat bucket it feeds;
  `shipStats` SUMS every owned ability's rank into its channel, so several abilities can stack one
  channel (e.g. HAULER's Orbital Sling + Expanded Bay both feed `orbit`). Add an ability by adding a
  catalog row + reading its channel in `shipStats` — nothing else needs to know it exists.
  **Naming law:** two abilities that DO the same thing share one name/icon/desc even across specs
  (Heavy Winch = the catch starter in BRAWLER and HAULER; Reinforced Hull = both hull tracks; ids stay
  distinct). Same-spec second tracks (Grapple Extenders, Expanded Bay, Overtuned Drive, Bulk
  Freighter, Juggernaut) are the exception — they must stay separately named to coexist as cards, and
  their descs read as "more of the same".
- **TWO PROGRESSION TRACKS, ONE XP STREAM.** Good play (catch, smash, ram-kill, parry, skim/skate,
  kill, collect scrap, survey, slingshot, shield-block) grants XP via `addXp(game, amount)`
  (`PROG.XP_*`). Ram kills pay `XP_RAM` in `shatter`'s `'ram'` branch (kills only — chip damage,
  scrap, and combos stay off, so bulldozing never outearns aimed throws); a completed Deflector
  parry pays `XP_PARRY` at the LAUNCH, not the catch. Every award then feeds BOTH tracks at once —
  they are **parallel accumulators, not a shared purse**, so ranking up costs the pick purse nothing:
  - **RANKS ARE AUTOMATIC — deepening is never a card.** Each owned ability holds its own pool
    (`prog.abilXp[id]`) and its own rising per-rank threshold (`abilityRankCost`); `growAbilities`
    (called from `addXp`) pours every award into every owned ability and cashes in what crosses.
    Ranks land mid-flight with no modal. A landed rank is queued on `game.rankUps`, which
    `main.update` drains into one message + `sfxUpgrade` + the hull-gain heal (the event-flag shape).
    `abilityRankCost` budgets an ability's whole ladder as `ABIL_XP_TOTAL × xpMul × a track-length
    factor` and splits it across its `max - 1` steps with rising weights — keep `ABIL_XP_TOTAL` in
    ratio with the pick curve or abilities end the run mid-ladder.
    **Two laws hold over that ladder, and devtest T5c asserts both:** thresholds always RISE, and no
    two abilities in a spec's STARTING KIT rank up together. Kit abilities are the only ones learned
    at the same instant, so their pools stay equal forever and only the cost stagger separates them —
    `ABIL_XP_SPREAD` (a per-ability ladder scale) + `ABIL_XP_WOBBLE` (a per-rank nudge), both hashed
    off the ability id so the HUD bars stay steady and runs stay repeatable. The pair is SEARCHED
    against the real catalog to maximize the tightest kit gap (49 XP at 0.23/0.08); a per-ability
    scale alone cannot do it, because ladders of different LENGTH cross however they are scaled.
    `ABIL_XP_WOBBLE` must stay under ~0.108 or a later rank can cost less than an earlier one.
  - **PICKS ONLY EVER OFFER NEW ABILITIES.** Crossing `xpForPick(prog)` sets `game.choosingUpgrade`
    and PAUSES the sim (`frame()` gate) for a card; both kinds draw from `tierChoices(prog, 2)` —
    2 random abilities you do NOT own that clear their `minTier`. There is exactly ONE such pick
    between milestones (`PROG.PICKS_PER_TIER` = 1); the next one is the **TIER-UP milestone**, which
    also runs `applyTierUp` (tier bump — it grants NO ranks; a "dividend" would double-count against
    the automatic track and make a kit ability's own bar decorative) and pays +1 life. A tier is
    therefore two new abilities.
  Both empty-pool branches must keep progression moving: with nothing left to offer, a plain pick
  still advances `picksThisTier` (else a spec whose pool is exhausted can never reach its tier-up)
  and a milestone tiers up anyway.
  The XP curve is **front-loaded on purpose** (`XP_BASE`/`XP_STEP`/`XP_CURVE`): per-tier totals run
  303 / 763 / 1399 / 2211 / 3199 (total climb 7875), so tier 0 is still a fraction of tier 4. Speed
  passes shorten the whole climb by cutting the EARLY tiers hardest — that is where pace is felt.
  **The achievement pass raised it WHERE THE NEW INCOME LANDS, not uniformly** (from
  183/595/1247/2139/3271, total 7435 → ×1.66 / 1.28 / 1.12 / 1.03 / 0.98): achievement XP is steeply
  front-loaded — measured on a ship that never played, 96 XP arrived in the first 100 seconds and the
  next 150 paid nothing. **The split is the principle: early achievement XP is a FLOOR** every player
  collects, so pricing it in is fair to everyone; **late achievement XP is optional** and wildly
  player-dependent, so assuming it would punish anyone who doesn't chase it. A first pass that scaled
  the whole curve by 1.31 was wrong in both directions — it under-corrected tier 0 and taxed a tier 4
  that gets almost none of the stream. Absorption is deliberately PARTIAL early (~65%): play XP is
  hardest to earn at tier 0 with the weakest ship, which is exactly where the boost earns its keep.
  **`ABIL_XP_TOTAL` moves with the climb TOTAL** (6500 → 6900), not with the curve's shape — every
  ability pool receives the achievement XP too. See the ratio rule above.
- **XP INCOME IN THE DENSE FIELDS IS GATED TWICE, and both gates are load-bearing.** Four pockets of
  ~1900 rocks each meant parking in a shoal out-earned every aimed, risky thing in the game — the
  optimal play was the least interesting one. **`config.fieldXp(game, b, xp)` is the ONE resolver**;
  every award sourced from a shoal rock goes through it and nothing else may pay one. Call sites:
  catch and orbit-stow (tractor.js), smash / ram / parry and BOTH scrap drops incl. the combo bonus
  (physics.js — debris chunks are pure XP, so undamped salvage just relocates the farm). Non-field
  bodies pass through untouched, so a site can wrap unconditionally.
  1. **`PROG.XP_FIELD_MUL` (0.3)** — what ONE rock is worth. Uniform across the pocket on purpose:
     exempting giants and monoliths would move the farm onto them, and the reward for calving one is
     its ACHIEVEMENT, which pays XP of its own.
  2. **`PROG.FIELD_XP_BUDGET` (150/field, `f.xpLeft`)** — what the SHOAL is worth, for the whole run.
     **This is the gate that actually holds.** A multiplier prices a rock, and the problem is that a
     pocket holds 1900 of them, so any trick that raises the rocks-per-minute rate simply outruns it;
     a budget is rate-independent. Deliberately the same shape as `FIELD_BROOD`: finite per run, no
     refill, so working a shoal dry is a CHOICE whose consequence traces to the player. All four
     fields together cap at ~600 XP, under 8% of the climb. A dried pocket announces itself once
     (`game.fieldDryName` → the `EVENT_MSGS` drain) — the rocks still shatter and are still ammunition,
     and a payout that silently stopped would read as a bug.
  Untouched: `XP_BLOCK` and alien kills (the lurker brood is itself a finite budget) and everything
  outside a field.
- **BILLIARDS CREDIT IS DEPTH-CAPPED INSIDE A POCKET** (`CFG.FIELD_CHAIN_MAX` 2, `physics.chainOk`,
  `b.chainN`). This was the actual exploit, and it was a physics bug wearing an economy costume: the
  gravity-billiards rule stamps `thrownBy = 'player'` onto any rock your throw knocks hard, and among
  1900 TOUCHING rocks that mark spread outward forever (every fresh contact refreshed the 1.4s timer).
  Because the `FIELD_TOUGH` damp exempts "a player throw", **the entire shoal took full lethal damage
  and paid full credit off one fling** — measured at 245 XP in 30s and still climbing, most of it
  chip-scrap from thousands of laundered impacts. Capped, the trick shot survives and the cascade
  doesn't (one throw: 66 XP / 19 kills → 13 XP / 5 kills). `chainN` is the link number and **must be
  reset to 0 at every REAL launch** — `tractor.releaseHeld`, `flingAllFromOrbit`, the parry riposte —
  or a rock that once ended a chain can never start one. Belt rock is deliberately UNCAPPED: it is
  sparse and cannot cascade, so planet billiards stay glorious.
- **The pick modal is deferred, never lost.** It won't open while a rock is in the beam
  (`game.held`) nor for ~2s after any fling (`game.flingDelayT`, set in `releaseHeld` /
  `flingAllFromOrbit`) — freezing the sim mid-aim feels awful. `owesPick` stays true until consumed,
  so the pick just waits.
- **`shipStats(prog)` = universal base + channels.** The base is tier-scaled and equals the old
  tier-0..5 baseline, so **the core grab / throw / fly loop works for every spec from frame one**;
  owned abilities add on top. All `st.*` field names are unchanged, so render/physics/tractor/hud
  consumers never needed touching. `totalLevel` = `min(25, tier*2 + round(rankSum*0.6))` — keep it in
  the 0–25 band, it still feeds enemy scaling (ai.js) and ship mass (physics.js).
- **Runtime abilities live outside config.** Most abilities are pure `shipStats` numbers, but each spec
  has real mechanics wired into the sim — keep the hook and the catalog row in sync:
  - BRAWLER — the ram is INNATE spec DNA: `st.ramMul`/`st.ramArmor` have a brawler-only base floor
    (config.shipStats) so it bonks from frame one, and Ram Prow (in the STARTING KIT, not Heavy
    Winch) / Juggernaut / Berserker deepen it in `physics.collideShipBody` (Berserker also scales
    `tractor.flingSpeedFor`); Cluster Rounds / Shockwave / Demolition in `physics.brawlerThrowKill`,
    called ONLY from `shatter`'s `'player-throw'` branch. **The blast has TWO RADII and they are not
    interchangeable:** `pushR` (`170 + 60 × shockwave`, 350 at max) keeps a long reach because the
    shove is the spectacle and costs the world nothing, while `dmgR` (`90 + 38 × demolition`, 204 at
    max) is deliberately tight because *erasing* a body has to be earned. A rock caught between the
    two is thrown, not deleted — the more interesting outcome, since it becomes your next projectile.
    (History: one shared reach of `240 + 90/rank` = 510 at max, off EVERY throw-kill — a circle about
    as wide as the screen. It only looked generous in the sparse belt; in a dense field it deleted a
    pocket faster than the eye could follow.) **FRIENDLY FIRE** (`CFG.BLAST_SELF_DMG` 0.6) is keyed to
    `dmgR` alone: standing inside it costs the same damage with the same falloff (~63 at point blank,
    a fifth of a tier-3 hull, and hull does not self-heal), so the blast is no longer the one brawler
    tool with no downside. `hitAng` points from ship to blast, so a BRAWLER's front-arc shield really
    does cover a detonation it is facing. The body-count caps (20 swept, **10 damaged**) are what
    actually bind inside a shoal — a pocket puts ~100 rocks inside any of these radii versus a handful
    of belt rock — so treat them as the field limiter, not just a perf guard; Wall Splat (`st.wallSplat`,
    `physics.wallSplat`) rides its OWN flag instead — `collideBodies` sets `body.splatWall` around
    the one damage call where YOUR live throw dies against a celestial (its shatter credit is only
    `'player'`, so the credit alone can't distinguish a splat), and the burst is push-only,
    asteroids-only, with hard shoves carrying billiards credit; **Deflector** (`st.deflect`, also in
    the starting kit) is the PARRY: `physics.updateParry` scans each substep for rocks closing
    (>60) on the nose within `PARRY_ARC` (~60° half-angle) and hull + `st.deflectReach`, and
    FREEZES them where caught. At rank 1 the reach is a hair past the hull — the rock must
    actually HIT the ship (user design rule: no catching out in space); ranks widen the bubble.
    Capacity is the RANK (SIX ranks — a maxed deflector freezes a six-rock volley) and late
    arrivals JOIN the running window. While a session is live the nose is LOCKED (the steering block checks
    `game.parry`) and the mouse is a FLICK read from RAW SCREEN deltas (`game.mouseSX/SY`, stashed
    in main.js — world-aim deltas are camera-contaminated); a decisive flick or window end hurls
    EVERY held rock player-thrown at `st.deflectPower` (flick = volley one way; no flick = each
    back along its capture bearing), paying `XP_PARRY` per rock. Fixed 2.5s cooldown; ranks buy
    field width + slots + window + power. Eligibility (`parryEligible`): loose asteroids only,
    beam-scale mass cap, `!majorComet`, never held/own-throws — `render.drawDeflectable` MIRRORS it
    for the incoming-rock indicator (pulsing cyan circlet on catchable rocks), keep them in sync;
    `parryFrozen` is skipped by `collideBodies`/`collideShipBody`/`tryGrab`; `resetRun` clears
    `game.parry`. Render: `drawParry` — dashed charge ring + per-rock flick arrow (helper UI),
    additive glow (event motion). The War Rack stow (`st.trailStow`) is a TRAILING ammo pack, not a
    protective ring: `tractor.updateOrbit` branches to aft slots that drag behind the nose, with
    NO interceptor (protection is the front-arc plating; the pack only incidentally blocks shots
    through the wake), and its `orbitCap` is clamped to MOON CLASS (`TIERS.caps[1]`) at every
    tier (config.shipStats) — shotgun ammo, never a planet garage.
  - HAULER — Recovery Tether (`tractor.updateTethers`, in the `CFG.DT` substep loop), Aegis Reflector
    (the orbit-intercept block in `physics.collideBodies`), Twin Grip (`game.held2` threaded through
    `tryGrab`/`springHeld`/`releaseHeld`/`addToOrbit` + a second beam in render), Rockwall (orbit-held
    rocks take reduced damage in `physics.damageBody` + the wall spins faster in `tractor.updateOrbit`),
    Dead Stop (`st.deadStop`: catching an alien-thrown rock in `tryGrab` sets `b.primed` — a
    multiplier in `flingSpeedFor`, consumed in `releaseHeld`; `flingSpeedFor` takes the BODY as well
    as the mass precisely so the aim solver's ✕ markers price the prime in — an ember halo in
    render marks a primed rock).
  - SCOUT — Afterburner is a FUEL TANK, not a free hold: main.js owns `game.burnerFuel`/`game.burnerOn`
    (engage needs >0.25 tank, hysteresis; drains over `st.burnTime`, refills at `st.burnRefill` — the
    HUD BURN bar), and physics reads **`game.burnerOn`, never raw Shift**, for both the thrust boost
    AND the governor ceiling — reading Shift directly desyncs thrust from the tank. Dash Jets
    (`main.onDash`, cooldown `game.evadeT`) darts perpendicular to the NOSE (`angle ± π/2`). Reflex
    Jink is the auto-dodge closest-approach scan in `physics.step` (recharge `game.autoEvadeT`,
    ticked in main.js); Slipstream (`main.onWarp`, `game.warpT`); Recon Drone (survey radius, world.js).
- **Controls the abilities add:** hold **Shift** = Afterburner (spends the BURN tank), tap **A / D** =
  Dash Jets (dart left/right), tap **F** = Slipstream. All no-op unless the ability is owned and off
  cooldown (Afterburner: unless the tank can light), and are gated behind `menuBlocking()` like every
  other player input.
- **ACHIEVEMENTS are a THIRD track, and they FEED the other two.** ~385 rows in
  [achievements.js](src/achievements.js) grant **points** (`prog.ach.score`), and those points also
  **pay XP** — `pts × PROG.XP_PER_ACH_POINT` (0.6), banked in `main.drainAchievements`, never in
  achievements.js `award` (the sweep stays a pure read; the drain is where the game reacts). So a
  landed row feeds the pick purse and every ability pool like any other good play: a 200-pt insane
  feat pays 120 XP, a 5-pt trivial one 3. The XP curve above was re-shaped (not just scaled) to
  absorb the stream — **the two numbers move together**, and dropping the rate without dropping the
  curve leaves the opening far slower than it was.
  (History: achievements were points-ONLY at first, deliberately costing the other
  tracks nothing; they now pay, because the score alone didn't reward a player for chasing them.)
  **The XP is deliberately NEVER SHOWN** (user call) — not on the toast, not in the panel. Raw XP is
  an abstracted number the player reads nowhere else in the game; progress surfaces as the bars, the
  rank-up line and the pick card, and printing a figure beside every toast would be noise, not
  feedback. The toast and the panel show POINTS, exactly as before.
  **Run-scoped on purpose:** the
  score answers "how was THIS run", so the ledger lives on `prog` and dies with it; nothing is
  persisted to localStorage (a lifetime tally makes an achievement a thing you grind once and never
  see again). `main.freshProgress()` bolts `newAchState()` onto `newProgress()` — **config.js must
  never import achievements.js**, since achievements imports config and config is a leaf.
  - **Two halves, deliberately apart.** (1) A **stat ledger** (`prog.ach.stats`): gameplay code bumps
    plain counters through `bump` / `best` / `least` / `mark` — null-safe, so they're callable from
    splash frames and headless soaks where no ledger exists — plus `noteCatch` / `noteKill` /
    `noteDeath`, which classify the three richest events in one call each rather than a dozen bumps
    at the call site. Call sites never know what an achievement is. (2) **Predicates**: every row's
    `test(game, s, c)` is a PURE READ, evaluated each frame for every row not yet earned; earned rows
    splice out, so the sweep shrinks as the run goes. **No loops, no allocation inside a predicate** —
    anything that needs scanning is computed once into the shared context `c` (the ONE loop the
    sweep allows itself is the orbit-mass sum, and only because `st.maxOrbiters` caps it at seven).
    Measured at 0.02 ms per sweep across all 380 rows — 0.1% of a 60 fps frame.
  - **Adding one is a catalog row.** Only reach for a new `bump` if nothing already records the event.
    Several discovery rows ride the existing `EVENT_MSGS` one-shot flags through `ACH_EVENT_STATS`
    (main's drain feeds them) rather than instrumenting world.js a second time; the heat/oort/gas/skim/
    coast/spin/no-damage streaks are integrated inside the sweep off flags that already exist, so the
    hot path never grew a line for them.
  - **Watch for freebies — this is the failure mode of the whole feature.** A predicate true on frame
    one is a bug, and five have been caught so far: counting max-1 unlocks as "maxed" handed SCOUT
    *Maxed Out* immediately (Retro Jets is in its kit); `game.lastDamage` starting at `-99` handed
    every run 99 free seconds of "untouched"; an "own four abilities" row landed instantly because
    the BRAWLER and SCOUT kits ARE four (count rows must sit above the biggest kit — 5+); an
    "unlock the Deflector" row was free for BRAWLER, which starts with it (kit abilities need a RANK
    threshold, not an unlock one); and a "tier 2 with no picks taken" row was unreachable, since a
    tier-up spends a pick and increments `prog.level`. **Check every new row against
    `window.freshRun(i)` + `window.tick(1)` for all three specs** — anything other than *Specialist*
    landing on frame one is a freebie.
  - **`noteDeath` ends every streak the sweep is timing.** Without it "ten minutes untouched" would
    survive being blown up, and a dive that ended at a gas giant's core would score as one you climbed
    out of.
  - **Presentation:** landed rows queue on `game.achQueue` (the same event-flag shape as `rankUps`) and
    `main.drainAchievements` turns them into **toasts on their own rail** — never `hud.message`, whose
    single slot belongs to the sim warning you about the world; a score notification must not be able
    to overwrite a hazard warning or be overwritten by one. The sound follows the existing grammar
    (triumph): `sfxTierUp` for a 60+ row, `sfxUpgrade` otherwise. The cockpit gets a gold `★` score
    chip (hidden until the first point — its appearance IS the first achievement), the GAME OVER panel
    leads with the final score, and **V** opens the log. The panel is rebuilt on open, never per frame.
  - **Toast lifetime is driven in JS, not by a CSS animation delay, because HOVERING PAUSES IT.**
    A notification you have to read in four seconds is one you miss, so pointing at a toast holds it
    open and expands its full description; the clock restarts (shorter) once the pointer leaves, and
    a toast caught mid-exit is brought back rather than fading out from under the cursor. **The
    toasts stay `pointer-events: none` and hover is HIT-TESTED against their rects from a
    window-level mousemove** — the rail sits in the middle of the play area, and a toast with real
    pointer-events would swallow the mousedown that starts a tractor grab (the canvas listener would
    simply never fire, and a rock you reached for would be missed because a notification happened to
    be in the way). The listener is bound with the first toast and unbound with the last. The
    description reveal animates `grid-template-rows: 0fr -> 1fr`, so it expands to the text's OWN
    height with no magic max-height to keep in sync with the copy. Enter overshoots in from the
    right with a one-shot light sweep (the panels' energy-line idiom); leave fades and drifts out,
    THEN collapses its own height and eats the rail's 8px gap with a negative margin, so the toasts
    below slide up instead of snapping. Both drop to a plain fade under `prefers-reduced-motion`.
  - **The panel is a SCHEMATIC, not a table** — the same shape as CONTROLS, and for the same reason.
    At this catalog size a two-line row per entry is a wall of prose you have to READ to scan, so rows
    are COMPACT (marker · name · points) in a two-column grid, and each carries its description in
    `data-note`; `initAchPanel` delegates hover/focus to mirror it into the readout strip underneath.
    Adding an achievement therefore needs nothing in hud.js. The rows are `<button>`s so a keyboard
    walks the list exactly as a mouse does, and the readout is sized for its LONGEST description, not
    the current one, or the centre-transformed panel bounces as the cursor crosses it. Filters run
    ALL / EARNED / one per category. `secret`-category rows are REDACTED until earned — name and
    description both, though the POINTS still show, so a classified row is visibly worth chasing;
    every other locked row reads in full, because a readable locked achievement is a to-do list.
- **Test hooks:** `game.autoUpgrade = true` auto-resolves each card (picks index 0) so a `window.tick`
  soak never stalls; `window.tick` also auto-seeds `SPECS[0]` when no spec is chosen (set
  `game.prog.spec` + rebuild `game.st` first to soak a different spec).
- **Lives, not a death penalty.** `prog.lives` starts at `PROG.START_LIVES` (3). A death spends one
  life and respawns with ALL upgrades kept; 0 lives → `game.gameOver` + the GAME OVER panel, and R
  calls `resetRun()` (fresh `newProgress()`, world regenerated). Extra lives come from sparse **life
  pods** (`game.pickups`, seeded in `generateWorld` + trickled by
  `main.updateLifePods`/`world.spawnLifePod`, capped at `PROG.MAX_LIVES`) and +1 per tier-up
  milestone. Life pods are real objects → SOLID stroke (render `drawPickups`).
- **No scrap currency — debris chunks are XP pickups.** There is NO scrap counter, and debris chunks
  don't heal: collecting a debris chunk pays `d.value * PROG.XP_SCRAP` and nothing else (the hull mends
  only at glow pockets — below; shield recharges). Which kills DROP chunks is still gated — only a player throw or a
  shield-rock hit (`physics.collisionCredit` → `earnsScrap`) mints them; belt traffic, a rogue
  clipping a moon, a ram, an absorption, or star heat shatter with NO drop. A direct throw-kill
  (`'player-throw'`) additionally pays combat XP. Don't reintroduce unconditional `dropScrap` on death.
- **The ship speed ceiling is RELATIVE to the local orbital flow** (`physics.orbitalFlow`): the ship's
  velocity is capped to within `maxSpeed` of the surrounding space's prograde circular velocity vector,
  not capped in absolute magnitude. The current carries the ship and the engine buys `maxSpeed` of
  deviation in any direction — with the spin you reach flow+maxSpeed, against it flow−maxSpeed (so out
  in the belt, where maxSpeed exceeds the flow, you can fly retrograde; near the sun the flow outruns
  maxSpeed and sweeps you prograde). Mirrored in predictPaths — keep in sync.
- **Sun-anchored orbits are slightly non-uniform:** `railBody` nudges each star-anchored body's angular
  speed by a deterministic ±~4% (hashed off `b.id`), so the sky isn't one rigid disc. Kept SUBTLE — a
  bigger spread lets same-radius rocks catch up and grind each other. Moons/installations stay exact.
- **Event-flag messaging:** a subsystem signals a one-shot event by setting `game.<x>Warn` / `game.<x>Name`;
  `update()` in main.js drains and clears it and calls `hud.message(text, seconds)`. First-time-vs-repeat
  wording is gated on `game.tut.*` booleans. An entry's optional `snd` plays with the message — the audio
  grammar: `sfxAlarm` = the ship is in danger NOW, `sfxWarnLow` = hostile contact / bad news, `sfxChime` =
  discovery / opportunity, `sfxLife` = triumph. Keep new events on that grammar.
- **Audio conventions:** world-positioned one-shots (booms, turret fire) pass `sfx.distVol(game, x, y)` so
  far-side belt crunches stay a murmur — never add an unscaled boom for an off-screen event. The music mood
  (`world`/`sun`/`danger`) is computed even with no AudioContext, so headless soaks can assert on it via
  `window.musicState()`; `window.tick` advances it with the sim. The sun channel has a DEADZONE on its outer
  third (spawn sits ~3.3 sun-radii out and the dread bed must not brood over a fresh run — tune in
  `music.computeMood`).
- **Determinism:** world *generation* uses a seeded `mulberry32` RNG, but the seed is **random per run**
  (see the world-seed bullet in the shell section) — pin one with `?seed=` for a repeatable world.
  The 20-planet/48-moon `layout` table in world.js is FIXED, so the seed varies placement, masses and
  features, never the structural counts: the balance baseline holds on any seed. Runtime
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
3. **Ambient collisions below a closing-speed threshold do no damage** (`DMG_THRESH 240` natural —
   tuned to the sky speed (sun mass 1.42e7); keep them in ratio if orbital speeds change again;
   `DMG_THRESH_THROWN 140` — thrown speeds are ship-derived, not orbital); damage is mass-dominance
   weighted; natural celestial hits are damped and
   capped at 70% of remaining hp when masses are within 8× (comparable rocks crunch + spall, they don't
   one-shot). (`physics.js:377`, `config.js:40`)
4. **>20× mass ratio → the heavy body is immovable**; natural celestial-vs-celestial impulse is damped
   (×0.25). Thrown bodies keep full impulse (planet billiards stay glorious). (`physics.js:330`, `:347`)
5. **Ship bounce kick is hard-capped at 200** — an uncapped kick let alien-thrown rocks fling the ship
   at 900+. (`physics.js:452`)
6. **`WORLD_R` must exceed every system's outermost reach** (orbit + moons), and star-anchored
   planets/moons are exempt from the boundary force — it silently deorbits them otherwise. (`config.js:5`, `physics.js:613`)
7. **Chunk shedding is gated, or it cascades.** Big bodies (`CHUNK_MIN_MASS`+, moons and up; never
   stations/nests/gas giants) don't fail all-or-nothing. At HALF the `CHUNK_DMG_MIN`/`CHUNK_DMG_FRAC`
   gates a hit carves a persistent scar (`b.scars` — render punches a visible bite out of the
   silhouette); at the full gates it also SPRAYS real chunk asteroids (a couple from the crater, the
   rest in random directions; giants vent extra) and sheds the mass. A dying world (planet/moon/rogue,
   non-gas) shatters into a dense cloud of up to 30 slow chunks that jostle apart. Pieces of worlds
   carry `b.chunk` — the PLANET CHUNK crust-shard sprite (render `drawChunkSprite`), distinct from
   belt rock. The gates are load-bearing: the damage floor keeps corona-heat drip (~0.1% of maxHp per
   call) from ever shedding, `CHUNK_MAX_MASS` (3200) stays far under the 5e4 rail-disturber threshold
   so chunks can't wake rail lanes, hit-spray chunks spawn OUTSIDE the parent's surface with outward
   velocity (a chunk born overlapping its parent takes collision damage and sheds again — feedback
   loop), body counts are capped, and only a direct `'player-throw'` hit propagates player credit onto
   chunks (shard/Demolition chains stay bounded). (`physics.js damageBody`/`shatter`, `config.js CHUNK_*`)
8. **A PLANET IS ITS OWN DURABILITY CLASS** (user design law: *killing a planet should feel like a
   feat*). Planet hp is a big flat `CFG.PLANET_HP_BASE` plus a gentle `PLANET_HP_MUL × massToHp`
   slope — deliberately NOT the mass-scaled curve every other body uses. Mass dominance already
   throttles what a small impactor does to a heavy body (damage ≈ 1/targetMass), so mass-proportional
   hp punished big worlds twice while leaving SMALL planets — barely heavier than a big moon, so
   dominance barely shields them — as paper: one thrown moon (4.7k–12k damage) vaporized a 96-hp
   world outright. The intended ladder is **rock chips it → moon wounds it (it SURVIVES one; ~7 slams
   kill a mid planet) → a thrown PLANET is the killing blow.** Raising hp does NOT quiet the damage:
   scars, crater bites, chunk spray and mass loss are gated on ABSOLUTE damage as well as hp fraction
   (invariant 7's dual gate exists for exactly this reason), and corona heat is a fraction of maxHp
   per second, so a planet still melts in the sun at the same rate. (`entities.js Body`, `config.js
   PLANET_HP_*`)

### Rails (the biggest architectural fact)

Celestial bodies ride **precomputed circular rails** (`railBody`/`derail`) and skip gravity entirely.
They derail on grab/damage/throw/hard-bounce or when a heavy thrown giant comes within
`RAIL_DISTURB` — **except PLANETS, which never derail from mere proximity** (a proximity-derailed
world beside a much heavier rogue gets gravitationally BOUND and dragged sunward — the outer-band
capture cascade; only a real impact knocks a planet off its rail; and a loose planet with a rogue
still adjacent re-rails BY FIAT off-view within ±15% of its lane, no circularity wait — the snap is
what breaks the gravitational bond) — and re-rail once near-circular
again — **but never within the player's view**
(the `game.viewR` guard, `physics.js:534`): an on-screen re-rail snap reads as "the rock I flung just
stopped mid-flight." Installations (stations, nests, forts) instead use active station-keeping — they
thrust back to `homeR` and re-rail even on-screen, because they must never wander.

### The discovery layer

Combat-free exploration content, deliberately sparse and all seeded to fixed spots (landmarks you can
give directions by). Rules that keep it from breaking the invariants above:

- **Comet Vesper** free-flies an eccentric orbit (peri ~3900 — deliberately above the graveyard ring,
  which otherwise collision-random-walks it into the sun — apo ~20100) and must NEVER be railed —
  rails are circular-only. It is an **honorary celestial**: weighted gravity (`majorComet` in the
  Phase-1 `weighted` check + predictPaths mirrors) and ×0.25 natural impulses, because full planet
  gravity/impulses killed it every ~15 min in soaks. If chaos still claims it, `replenishWorld`
  respawns it in ~4 min. `cometT = Infinity` deliberately survives the ambient-comet expiry
  (`Infinity - dt` stays `Infinity`). Its anti-sunward tail is render-only.
- The **shepherd** station-keeps (it's in the physics `install` set) and respawns ~5 min after an
  AMBIENT death only — a player kill scatters the ring permanently. Both are deliberate: ring decay
  must always trace back to a player choice.
- **The interstellar visitor** carries `noBoundary` — the one flag exempting a non-star-anchored body
  from the world-edge force (`physics.js`), because that force would capture its hyperbolic pass. It's
  cleared the moment the player catches it. Don't put `noBoundary` on anything else without a reason
  this strong.
- **THE SOLAR WAVE** (`CFG.STORM_*`) — system-wide weather with a telegraph, a bite, a counterplay
  and a payday. The sun CHARGES visibly for `STORM_CHARGE` seconds, then fires a shock front sweeping
  out at `STORM_SPEED` trailing a `STORM_TAIL`-deep **plasma sheath**. **The sheath is the whole
  mechanic**: the front alone is a 1400u ring that crosses any radius in ~1.5s — too brief to notice,
  which is exactly what the storm used to be (decorative). The sheath takes ~10s to pass, so being
  caught out in one is a situation you answer. Force-wise NOTHING CHANGED: it still pushes SCRAP
  DEBRIS ONLY, never bodies, celestials, or rails — a wave touching those is an invariant-3-style
  regression. What it does instead lands on the ship, on scrap, and on sensors:
  - **Caught EXPOSED** (in the sheath, no world between you and the sun): `STORM_DPS` directionless
    hull damage (no `hitAng` — no facing dodges a wave, so a partial shield soaks only its coverage
    share, and the continuous damage means the regen delay never elapses mid-wave), engines derated
    to `STORM_THRUST`, and **sensors scrambled** for `STORM_ION` seconds past the last exposure —
    the trajectory forecast and lead markers go dark and the radar drops/smears its returns.
    Measured at tier 0: ~55 hull on a BRAWLER (27%), ~63 on HAULER/SCOUT (53%). Kept FLAT, not
    hull-scaled, like every other environmental hazard, and under the gas cloud tops (9 dps).
  - **SHELTER is the counterplay** (`main.shelterBody`, `STORM_SHADOW_*`): the sun is pinned at the
    origin, so a world's lee is just the cylinder running anti-sunward from it. Render CUTS that lee
    out of the plasma with an even-odd clip — the shadow isn't painted on, the plasma simply isn't
    there — and the drawn lee is deliberately NARROWER/SHORTER than the mechanical one, so anywhere
    that LOOKS sheltered is sheltered (the dust-halo safe-direction rule). Its outline is re-stroked
    soft afterwards: a clip cuts with a knife, and a hard in-world edge is against the house style.
  - **The payoff**: a live wave BLINDS ALIEN SENSES system-wide for its whole ~56s passage (the
    window to move), it IONIZES the scrap it sweeps (`PROG.ION_SCRAP_MUL`, drawn charged blue), and
    riding it out exposed pays `PROG.XP_STORM_RIDE`/sec, **capped per wave** at `STORM_RIDE_MAX` —
    the front outruns any ship but you can still ride it outward, and an uncapped per-second payout
    would reward exactly that (the same rate-independence argument as the fields' `xpLeft`).
  - **Ionization must never touch FIELD scrap.** A shoal chunk's XP was already priced against the
    pocket budget by `fieldXp` at DROP time, so `dropScrap` stamps `d.field` and the pickup multiplier
    skips it — otherwise the field farm launders itself back through the weather.
  - **main.js owns `stormExposed`/`stormBlind`/`stormIonT`/`stormShelter`**, resolved once per frame
    in `updateStorm` before both consumers (`updateAliens` and the substeps); physics/render/ai only
    READ them — the same owner-split as the afterburner tank and `game.burnerOn`. `driftSplash` clears
    them (a wave left standing when you back out to the menu would cook the parked ship forever), and
    `resetRun` clears the geometry with them.
  - **Render sizes STRUCTURE in wave units and TEXTURE off `view.r`.** A gameplay view is ~900u wide
    against a 9200u sheath, so anything sized in wave units is bigger than the screen and collapses to
    a flat wash — the first cut's 220u filaments drew as screen-filling columns. Streaks/motes scale
    with the view, fade at BOTH tips (a hard leading tip reads as architecture, not plasma), and
    stay saturated (low-alpha additive near-white over black is just grey). ~0.4ms while it crosses
    the view, nothing at all otherwise.
  - `window.storm('charge'|'here'|'off')` fires one on demand instead of waiting out `STORM_EVERY`.
- **Survey/CHART**: flying into a world's nameplate zone charts it (`replenishWorld` scan) and pays
  `PROG.XP_SURVEY`. That zone is widened by the SCOUT **Recon Drone** ability (`st.recon`), which charts
  worlds from far outside it. Forecast horizon (`st.predictBoost`) and sensor/minimap reach
  (`st.sensorMul`) come from the SCOUT **Nav Plotter** and **Deep Array** abilities, not from a passive
  survey track.
- **Echo logs** are strings on bodies (`b.echo`), announced once on first grab via `game.echoMsg`.
- **The expedition layer** (all seeded content appends AFTER `seedGlowPockets` in `generateWorld` —
  any rng draw earlier reshuffles the whole sky and breaks mechTest T1; the guard comment in world.js
  marks the spot):
  - **Deliveries** (`world.updateDeliveries`, per-frame): the shared "fling/tow an object into a
    target's catch radius" verb (`CFG.DELIVER_R`). Consumption is a HANDOVER (`alive = false`, no
    shatter/scrap); **railed bodies are never cargo** (legit deliveries are always loose — without
    that gate a planet's railed junk satellites self-deliver to the barge at lane conjunction), and
    every handler carries a **re-entry guard** (the loop visits bodies pushed mid-sweep, and the
    barge's ice payment spawns inside its own catch radius — unguarded, an ice-for-ice trade is a
    runaway).
  - **CHART EVERYTHING**: every world/moon/station/named landmark carries a `b.chartKey`;
    `game.charted` records KEYS (respawned landmarks stay charted — spawn fns set their own keys).
    The total is recomputed live each scan (a destroyed uncharted body drops out — no 100% softlock).
    100% fires **MASTER CHART** (`prog.masterChart` → sensorMul ×1.25 + predictBoost in shipStats).
    Moons/POIs pay less than worlds and halve the Recon Drone reach.
  - **The Herald resolves**: deliver any graveyard wreck (`b.wreck`) → `gh.awake` — XP, a life pod,
    the ping turns friendly, and the fog scan sees ×1.5 farther within 6000u (MIRRORED in the
    minimap sensor bubble — keep in sync).
  - **The Tinker Barge** (`spawnTinker`): the system's ONE friendly NPC — a railed, station-keeping
    trader at r≈12000 with a rotating want (crystal/ice/wreck/junk — junk EXCLUDES the carved
    stone/visitor/wrecks or it eats landmarks). **Wants come from a LOCAL census** (user design
    rule — the barge only asks for things close by; a cross-system haul is a chore, not a trade):
    `pickTinkerWant` counts supply within `CFG.TINKER_WANT_R` (cored rocks count toward crystal),
    offers only plentiful wants (fallback: whatever there's most of), and a want whose local supply
    dries up re-rolls on a ~8s census — but NEVER while the player is holding a match (no re-rolling
    out from under a delivery in progress). The wreck want thus only appears if wrecks were hauled
    near the lane. Not grabbable (`b.tinker` in tryGrab); mass 1900 DELIBERATELY under `ATTRACT_MIN`
    (installations are never attractors); player kill permanent, ambient death respawns (~300s) —
    the shepherd's rule.
  - **The Uncharted Star**: `b.hidden` = sensor-null (fog + chart scans both skip it) — only feeding
    the Relay Station (the `ei === 0` echo station; its log IS the breadcrumb) a core crystal reveals
    the dark dwarf on the outermost rail (r≈39500). Type `'planet'` ON PURPOSE (star bypasses minimap
    fog; a custom type wouldn't re-rail after a rogue disturbance); NO `noBoundary`. Charting it:
    `XP_SURVEY_STAR` + permanent `prog.maxLivesBonus` +1 — **all lives-cap reads go through
    `config.maxLives(prog)`**, never raw `PROG.MAX_LIVES`.
  - **Mayday pods**: rare ambient rescues (t>180s, one at a time) — a real loose body (hp override 60)
    drifting sunward or nest-ward with an air timer; dock it at ANY station. The pod SPRITE is a
    real spacecraft (capsule + charred shield + orange rescue paint + beacon mast strobing faster
    as air runs out) — never a flat UI token. While the rescue is live the minimap runs a full
    mission display: blinking POD-tagged cross (hidden while the pod rides the player's beam), a
    guide line from ship to the nearest station, and a pulsing DOCK-tagged ring (prefer a SEEN
    dock; an unseen fallback is a bearing only — the station blip itself stays fogged, never a map
    reveal). Loss = a silent somber message, no penalty. Aliens grabbing the pod is intended drama
    (the helper refuses alien-held deliveries).
  - **Moons with jobs**: **iron** = debris-only magnet pooling scrap at a surface halo (the
    storm-shove law — never bodies/rails; ship magnet always wins); **sulfur** = player-credited
    smash (`earnsScrap`, >8 dmg, not the killing blow, 30s cd ticked in the always-running pre-pass)
    fountains capped loose rock; **dust** = `game.dustCloak` stealth (computed once per frame in
    `updateAliens` with 1.2s release hysteresis; nest-bound aliens disengage through the
    battle-tested return-home path, ORPHANS need the explicit cooldown fallback or they deadlock;
    never fortified); **banded** = skim XP ×`XP_SKIM_BANDED`, hull cost unchanged.
    **`updateAliens` OWNS `game.dustCloak` and is the only writer; every GATE asks
    `util.senseBlind(game)` instead**, because a live solar wave hides the ship too
    (`game.stormBlind`). render.js's hunting-eye mirror uses the same leaf helper — the two must
    never disagree about whether the ship is visible, and render must not import ai.
- The **ring shepherd**, **Forge Moon**, **graveyard wrecks**, **ghost ship** (station-type, `parent:
  null` so it gets no station-keeping), and **carved stone** are ordinary railed bodies — the fortify
  pass must keep skipping volcanic/shepherd moons.
- **Sky speed pairs with camera zoom:** the sun's mass (`1.42e7`, world.js) is the sole knob for how
  fast every sun-anchored orbit sweeps — orbital cruise is `sqrt(G*sunMass/r)`, so planets, belts,
  trojans, graveyard, Vesper, rails, and the ship's own cruise all scale with it together. It is tuned
  LOW on purpose: the tier-0 camera is zoomed in tight (`SHIP_ZOOM` 2.46, config.js) and the world
  scrolls past ~2x faster per zoom unit, so a fast sky at that zoom reads as "flying wildly fast."
  Flight feel = sky speed × zoom — **raise the zoom and this mass must drop, and vice-versa.**
  `STAR_GRAV_SHIP` (0.8) is NOT a compensator: it sets how hard the sun grabs the ship, and it rides
  down with the sky on purpose (slower cruise ⇒ gentler pull). (History: mass was once 3.2e7 to speed
  the sky up 1.4x; it was lowered to 1.42e7 — ~1.5x slower than that — to calm flight at the 2.46 zoom.)
- **LONG ARMS** (`SHIP_WELL_START`/`SHIP_WELL_MAX`): the SHIP feels planet/moon/rogue gravity fall off
  as 1/r (capped at 3.5x) beyond 4 body radii — longer reach, identical close-range gravity. It lives
  in `gravityAt` behind `heavyMul !== 1` (ship-only) and is MIRRORED in `predictPaths.accelAt`; the two
  must stay in sync or the forecast lies. Thrown rocks, aliens, debris, celestials never feel it.
- **Fog of war:** the minimap only draws bodies with `b.seen` (set by the `replenishWorld` scan once
  within sensor range; the sun is always visible). DENSE FIELDS are the one exception to the
  asteroids-stay-off-the-dial rule: every field rock in radar range draws as a dim tan 1px return
  (giants bigger — they're the landmarks you navigate a shoal by), each pinging on its own bearing as
  the sweep crosses it; their fog is FIELD-level (`f.seen`, set when the anchor enters sensor range),
  and an unexplored field returns one anonymous gray dot in the scan band like any other
  unidentified contact. The **gravity compass** (chevrons at the ship) shows
  the pull of WORLDS ONLY — `game.shipGx/Gy` is stashed from the non-star portion of the ship's gravity
  in `step`, then vector-smoothed into `game.compassX/Y` in main.js so the arrow can't whip.
- **Orbit rubber band** (`SHIP_BAND_*`): ship-only, inward-radial-only damping near worlds (mirrored in
  predictPaths). Outbound is exempt by design — the assist must never become an escape jail. **Surface
  skimming** (`SKIM_*`): tangential contact grinding damages the hull with sparks + a contact glow; the
  normal bounce path still only bites above closing-speed thresholds.
- **Corona heat** (`HEAT_*`): bodies/aliens melt inside `HEAT_ZONE x radius` (depth², lava-born matter
  immune: `ptype 'lava'`, `magma > 0`, `ember > 0.01`) — that zone's outer edge MUST stay inside the
  graveyard ring (~3160): ANY body damage derails railed wrecks, there is no "subtle" for them. The
  SHIP uses a separate wide envelope (`HEAT_SHIP_*`) with an EXPONENTIAL ramp — warmth/glow warn far
  out, lethal dps only arrives near the photosphere. Lava worlds radiate a weaker SHIP-ONLY aura
  (`LAVA_*`) — their own railed moons must never take heat.
- **Gas giants have no surface for the SHIP** (`GAS_*`): it flies in, crushed by depth², dead at the
  core. Interior ship gravity is enclosed-mass (`x d³/R³`, in `gravityAt` AND `predictPaths.accelAt` —
  keep in sync, else dives predict as inescapable). The prediction hit marker for a gas giant is its
  CORE, not its cloud tops. Rocks and aliens still bounce off the cloud tops — only the ship dives.
- **The drawn ship trajectory is frame-relative:** predictPaths simulates in inertial space (physics
  truth) but re-expresses the DISPLAYED ship path in the dominant attractor's frame, anchored at its
  current position (`game.predictRef`, 1.35x hysteresis) — near a world you see your real orbit shape
  around it; sun-dominant is exactly the inertial path (the sun is pinned). The compass chevron phase
  ACCUMULATES in main.js (`game.compassPhase`) — never derive animation phase as `time * speed`, a
  changing speed teleports the phase.

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
- **The world is 20% larger by AREA than it first shipped** (`WORLD_R` 42000 → 46000 = ×√1.2).
  The growth was taken entirely as an OUTER BAND (~37k–46k, above the last planet at 36800) rather
  than by rescaling the orbit layout — moving every lane would re-tune sky speed, heat margins, and
  the graveyard clearance for nothing. The band holds three planet lanes (38300 / 40800 /
  42600), the dark star's 39500 lane, and The Farshoal dense field on the frost fringe at 44300. Planet lanes stop at 42600, leaving the fringe to the Farshoal.
- **The world edge has no drawn boundary — the Oort cloud is weather, not UI.** No stroke at `WORLD_R`,
  and no shared edge of ANY kind at one exact radius: even a soft constant glow starting at a single
  radius reads as a hard line (the user rejected both). The grind radius is legible from natural cues
  only — aurora-curtain feet weaving through the warning band, dust density smoothstepping up across it,
  early flurries, and the frost vignette + OORT warnings (`render.js drawOort`/`drawOortDust`). More
  generally: in-world transitions are organic/stochastic, never geometric.
- **The ship shield is a calm, steady volumetric rim glow — no dashes, no idle motion.** Motion is reserved
  for *events* (recharge sweep, absorb ripple). **Shield down draws nothing at all** — a naked hull is the
  indicator; the blinking `SHLD` HUD label carries the alarm. (`render.js:609`, `:619`)
- **Hover hint ring colors:** green = auto-orbits, cyan = holdable, red = too heavy. (`render.js:1055`)
- **The cockpit chrome is mood-reactive, the instruments are not.** `music.js` publishes its live mood
  vector as `game.mood`; `hud.moodChrome` blends it into `--mood` / `--moodI` on `#hud` each frame, and
  the cockpit frame (`--fr`) plus a soft edge wash take that color — violet when calm, corona amber near
  the sun, ember under threat (danger blends last so it wins a tie). **CHROME ONLY**: hull green, shield
  blue and lives pink stay semantic so the instruments still read at a glance. The `lowhull` / `heat`
  alarm classes override `--fr` outright — an alarm always outranks a mood — and mood is all zeros until
  `game.started`, so the title screen and a calm cruise look exactly as they always did.
- **ROGUE PLANETS ARE GONE** (user call: "they're only causing issues"). A wandering 2.5-4.5e5 mass
  under full gravity was a permanent source of sky damage that no player action caused and none could
  prevent: it derailed whatever lane it crossed, ATE moons on the flyby, and — once the outer band
  existed — gravitationally CAPTURED light outer worlds and dragged them into the sun, taking every
  lane it crossed on the way down. Three separate guards were written against that one body type (the
  spawn-ring radius, an entry-speed floor, and the planet fiat re-rail in physics) before deleting it
  turned out to be the honest fix; idle skies went from losing planets to holding 21/21 with zero
  loose worlds. `type: 'rogue'` is still supported everywhere — render, minimap, weighted gravity, the
  re-rail disturber list, `scrapValue`, `noteKill` — so the concept can return if it earns its keep.
  **Nothing spawns one.** Don't "restore" the spawner without solving the capture problem first, and
  note the two rogue achievement rows were retired with it (an unearnable row is worse than a short list).
- **Enemy density is deliberately sparse** ("too many enemies, not enough normal worlds"): most planets are
  free. Nests and the dense fields' **shoal-lurker broods** are the *only* alien sources — there is no
  global wave spawner; a destroyed nest quiets its region forever, and a field's brood is a FINITE
  per-run budget (`FIELD_BROOD`) — kill the last of it and that field is quiet for the run (same rule:
  consequence traces to a player choice). Aliens are territorial (grabbers leashed to `ALIEN_TERRITORY`
  of their nest; lurkers to `FIELD_TERRITORY` of their field anchor — they never leave the shoal).
- **The shield is an ABILITY, not base — and its SHAPE is spec DNA:** you start with NO shield — the
  whole health pool is hull, which does NOT self-heal (it mends ONLY by collecting glow-pocket motes,
  below, and otherwise resets to full on respawn — with ONE sanctioned exception: any pick that
  RAISES hullMax heals the gain +20%, `main.healOnHullGain`, so a hull upgrade never just widens an
  empty bar). A `shield`-channel ability UNLOCKS the regenerating
  shield (rank 0 → `shieldFrac`/`shieldMax` 0, no SHLD bar), which absorbs first and recharges after
  quiet time. Each spec's shield is deliberately different (`shipStats` + `st.shieldArc`):
  - **BRAWLER (War Plating)** — a THIN, FAST-RE-FORMING FRONT PLATE (12%→26% of the pool) covering
    **35% of bearings** (`shieldArc` = 0.35π, ±63° off the nose), with the quickest cycle in the game
    (regen ×1.5, regenDelay ×0.35 — ~1.75s and the nose is covered again). **Its identity is the
    CYCLE, not the capacity.** (History: it was 38%→65% of the pool, which made it simply the best
    shield in the game — converting most of a brawler's health into a regenerating layer meant the
    front-arc drawback never cost anything, because the pool never ran out while you faced the right
    way. And the arc was a clean π/2, i.e. 50%, which covered everything ahead of the beam — "front
    arc only" was barely a drawback in practice. 35% is a genuinely narrow nose plate: you have to
    point at what is hurting you.) A directional hit from behind (`hitAng` in `physics.damageShip`)
    skips the shield entirely — the tail is bare, so facing the threat matters. **Directionless
    damage** (heat, gas crush, Oort grinding — no `hitAng`, nothing to face) can't be dodged by
    aiming, so it is SPLIT by coverage: the shield soaks `arc / π` and the rest goes straight to hull.
    Soaking all of it made the front-arc drawback free in exactly the places it should bite. Full-wrap
    shields are unaffected (share 1). **Anything asserting that share must DERIVE it from
    `st.shieldArc`** (devtest T6 does) — a hardcoded half re-breaks every time the angle is tuned.
    Render clips every shield visual to the covered wedge — the bare tail must READ.
  - **SCOUT (Phase Screen)** — WEAK (16%→26%, max 3 ranks) but full-wrap and snappy: scout-only
    regen ×1.6 and regenDelay ×0.6 come from the spec, not an ability. Both shields are thin now, so
    the CYCLE is what separates them: the brawler's is smaller and returns nearly twice as fast, the
    scout's is a touch slower back but covers every angle.
  - **HAULER has NONE** — by design its protection is the orbit rock wall (Rockwall hardens it,
    Reinforced Hull — id `cargoPlating` — armors the hull); never add a `shield`-channel ability to its pool.
  The SHLD HUD bar appears only once a shield is unlocked; below that the HULL bar stands alone.
- **Early-game interactables** (give the belt more to do than smash-the-same-rock; all lean on the
  existing throw/grab/collision loop, no new subsystems):
  - **Cored rocks** (`b.cored`, ~13% of belt/field rocks over 250 mass, world.js `maybeCore`): cracking
    the shell with a PLAYER smash frees a dense `b.core` crystal — heavy salvage (3.5x scrap, fat beam
    catch). Ambient shatters don't reveal it (earnsScrap gate). A purple glint marks cored rocks.
  - **Salvage caches** (`b.cache`, world.js `spawnCache`, ~5% of local-field spawns): light grabbable
    canisters that BURST into scrap + ice ammo when the player cracks them (physics.shatter).
  - **Gravity billiards** (physics.js): throw-kills chained within `game.comboT` (2.6s) rack up
    `game.combo`; a heavy rock plowing through light ones, or a knocked rock (credit propagated — ASTEROIDS
    ONLY, never moons/planets) killing the next, keeps it going. 2+ shouts a multiplier + bonus scrap.
  - **Ice-moon geysers** (world.js): ice-type moons vent catchable ammo like the far ice planets, but
    close-in and faster — an early harvesting loop.
  - **Dense asteroid fields** (`world.seedDenseFields`, `CFG.FIELD_*`): four VAST rock shoals at
    fixed radii — three in the planet-lane gaps (10400 / 23000 / 33500 — The Shoal, The Grindstones,
    The Hushfield) and one on the outer band's frost fringe (44300, The Farshoal). Each is ~1900 rocks
    across a roughly 5900 x 4400 pocket (mean nearest-neighbour spacing ~58u — the density the
    user signed off on; SIZE and COUNT are separate knobs and must move together, or you are
    re-tuning the feel rather than the size). **The pocket is close to ROUND on purpose** (`FIELD_LEN` /
    `FIELD_SPREAD`, physical units converted to an angle per radius — an angular width turned the
    outer field into a dilute 11,000u arc): the design goal is that you fly in and GET LOST, and a
    long lane-shaped smear never does that no matter how big it is — against a ~450u view radius the
    far side is a dozen screens away in every direction.
    **But round is not RECTANGULAR** — `FIELD_LEN`/`FIELD_SPREAD` are the EXTENTS of an organic
    outline, not a box to scatter inside. A uniform draw across those extents read as an obvious
    SQUARE of rocks (the eye finds the four corners instantly and the shoal stops being a place).
    The boundary is a lobed blob: three low harmonics per field (`f.lobe`, seeded at worldgen,
    evaluated by `config.fieldLobe`, ceiling `FIELD_LOBE_MAX`) bulge and pinch it ~0.6-1.4x, so no
    two shoals share a silhouette. `world.fieldPoint` is the ONE sampler — seed pass and reknit both
    — and it draws directions AGAINST the lobe radius (bulges stay as dense as pinches), places
    ~7% of rocks past the outline as a ragged fringe (a shoal that stops dead at its boundary is
    the hard in-world edge the design law forbids), and converts the flat pocket frame back to
    sun-polar with the chord-bow correction (`tan²/2r`) so the rocks sit where `fieldFrac` says
    they do. **The HEART is placed at the pocket CENTRE, never a scatter draw** — its rail angle IS
    `f.ang`, so an off-centre heart drags the whole containment frame with it (measured before the
    fix: 40% of a shoal's own rocks fell outside `fieldFrac <= 1`, i.e. outside its own leash, wake
    and entry announce).
    **The whole shoal shares ONE `rail.w`** (the id-hashed ±4% jitter is overridden per rock, at seed,
    at reknit, AND in the physics re-rail scan): a pocket with mixed angular speeds shears apart and
    same-radius rocks grind each other, so a rigid pocket is what keeps a field a field. Each field's
    HEART is a named, chartable giant; the AI anchor (`game.fields`, ai.js `updateFields`) reads the
    heart's rail angle directly (splash frames advance rails but not the AI, so deriving from the rail
    keeps the anchor glued to the rocks), falling back to its own clock at the shared `w` if the heart
    is stolen or killed. Pockets slowly REKNIT toward seeded density off-view (`replenishWorld`;
    the census counts the POCKET, not strays).
  - **FIELD ROCK is its own material** — never treat it as belt rock (`world.markFieldRock` stamps
    every one, including shards minted by `physics.shatter`, or the pocket launders itself back into
    gravel):
    - **No gravity in either direction.** It doesn't FEEL gravity (skipped in physics Phase 1, so a
      knocked rock drifts and caroms in a straight line instead of falling into an orbit) and it never
      EXERTS any — `attractor` is forced false at any mass, GIANTS INCLUDED. A heavy attractor parked
      in a pocket built for knocking rocks together would quietly turn the shoal into its own solar
      system. It is also the only reason 2000+ of them are affordable: the hot loop is
      O(bodies x attractors), and field rock adds to neither side of it.
    - **Near-elastic bounce**: field-vs-field uses the FLAT `FIELD_BOUNCE` (0.92), not a multiplier
      on the world's deadened `RESTITUTION` (scaling it still thudded). Kept under 1 — at e >= 1
      every hit ADDS energy and the pocket boils itself apart. Field rocks are also EXEMPT from the
      gentle-contact absorb rule against each other: a pocket that ate every soft touch with a 15x
      mass ratio digested itself around its own giants.
    - **Tough against its own kind, DANGEROUS TO YOU** (`FIELD_SHIP_DMG` 2.5, the mirror of
      `FIELD_TOUGH` below, applied in `collideShipBody`). The pockets are meant to be **high risk /
      high reward** and were reading as pure reward, because a rigid pocket is SAFE: match its orbit
      and every rock is nearly stationary relative to you, so the `closing > 25` gate left a farmer
      sitting inside 1900 rocks barely scratched. The multiplier rides `closing`, so it weights the
      danger toward LOOSE, stirred-up rock — the mess you made — while ambient jostling stays minor.
      Hull does not self-heal, so that attrition is the real price of working a shoal.
      **Field rock also keeps the BASE mass-saturation knee at every tier**, which mattered far more
      than the multiplier: the knee normally grows with tier (`1500 × (1 + tier×1.2)`) so a
      dreadnought shrugs off pebbles, and that made the shoals get SAFER the stronger you got — a
      median field rock at 300 closing went 31% of hull at tier 0, 7% at tier 3, **4% at tier 5**,
      i.e. harmless at exactly the tier you farm them. Flat knee ⇒ the same absolute bite at every
      tier, so a bigger hull endures more of a shoal without ever becoming immune to one. A big ship
      in a dense field is a big target.
      **`FIELD_SHIP_DMG` is deliberately NOT applied to alien-thrown rock** — a lurker shove already
      carries its own `thrown` multiplier and its own speed/mass tuning, and the two stacked put a
      single body-check on the 45%-per-hit cap at every tier (a two-shot kill from an ambush, with
      three hunting). Keeping them separate is also what lets the shoal and its predator be tuned
      independently instead of through each other.
    - **Tough against its own kind** (`FIELD_TOUGH` 0.08 damage scale, `FIELD_HP_MUL` 6 hp): hits
      send rocks flying, they don't erase them. The damp covers EVERY field-vs-field impact —
      including lurker body-checks and chain caroms, which are 'thrown' and at full damage vaporized
      their targets instead of billiarding them. Only a player's own live throw punches at full
      strength — smashing field rock deliberately still works and still pays. In a 30s soak melee,
      40 kicked rocks cascaded into ~1160 loose rocks caroming with only 5 deaths out of 2200.
      **"A player's own live throw" means YOUR throw and at most `FIELD_CHAIN_MAX` links past it** —
      see the billiards depth cap in the design laws. Unbounded, the propagated `thrownBy = 'player'`
      mark defeated this damp across the whole pocket, which is also why the shoal did NOT survive
      being knocked around "indefinitely" as this rule intends.
    - **GIANTS** (`FIELD_GIANTS` per pocket) shatter into a spray of smaller field rock, and shards
      over 3000 mass are giants themselves — a bounded cascade, not an unbounded chain. This is the
      shoal's chaos engine. The shard budget must stay ABOVE the world's steady-state body count or
      the cascade silently never fires. Above them sit **MONOLITHS** (`FIELD_MONOLITHS` + the named
      heart, `FIELD_MONOLITH_MASS` 3e5-4.8e5): twice the drawn RADIUS of the biggest giant (8x the
      mass — radius goes with cbrt), the rocks you steer by from across the pocket. Field-rock hp is
      capped at `FIELD_HP_CAP` (5200) precisely so a monolith stays breakable by a thrown moon-class
      mass — FIELD_HP_MUL alone made one ~34k hp, i.e. unbreakable, contradicting the calving design.
      A thrown monolith IS a rail disturber (mass > 5e4) — that's existing thrown-giant drama.
    - Field rock is why the view-local spawner's global asteroid cap is 9800 (was 380) and the world
      runs ~8000 bodies. Headless `tick` calls at this scale can exceed a 30s console eval budget:
      run soaks in chunks.
  - **THE FIELD LOD** (`physics.updateFieldLOD`, called once per FRAME from main.update AND
    driftSplash — never per substep) is what makes those bodies affordable: **full physics is a
    LOCAL privilege.** Every field rock is classified AWAKE (its field is the one the ship is at,
    and it sits inside a wake bubble of ~2.2x viewR around the ship) or DORMANT (the far side of
    your own field, and every field you are not in). Dormant rocks are skipped by the collision
    sweep, both gravity phases, the per-substep rails pass, the ship/alien collision loops and the
    NaN tripwire; railed dormants are group-advanced once per frame with exact trig — the pocket is
    RIGID (shared `w`), so the whole shoal travels as one and the minimap stays truthful — while
    LOOSE dormants freeze mid-drift (off-view by definition; they resume on wake). Held/thrown/
    parry-frozen rocks are ALWAYS awake (a throw must never freeze mid-flight), and dormant
    advancement drives the same `rail.ang` the substep path reads with `rl.rdt = 0` invalidating
    the incremental rotor, so waking is seamless (measured: no displacement pops crossing the wake
    seam at speed). The LOD is advanced by `simSteps * CFG.DT` — the exact sim time the substep
    loop consumed — so dormant pockets never drift off the sim clock. **The chaos you see is always
    the chaos near you — that's the design, not a shortcut** (a thrown rock CAN pass through a
    dormant zone uncollided; it's off-view and the trade is deliberate).
    Three follow-on optimizations ride the same classification:
    - **THE AWAKE LIST** (`game.bodies._awake`, built in the same LOD pass): every per-substep loop
      in `step()` iterates it instead of the full array — walking ~8000 bodies 10-15x per frame just
      to skip dormants measured ~1.4ms (~40% of sim). It holds REFERENCES (compaction-proof), lives
      ON the bodies array so `generateWorld`'s clear invalidates it (`bodies._awake = null`; step()
      falls back to the full array while null), and `spawnAsteroid` registers spawns eagerly; any
      creation site that bypasses it self-heals at the next frame's rebuild (one frame of stasis).
      The dead/escaped cull is the one remaining full-array pass, throttled to every 4th substep.
    - **The renderer skips dormant bodies outright**: dormancy requires >2.2x viewR + 600 from the
      camera and the screen edge is at 1.0x viewR, so a dormant rock CANNOT be on screen. Teleports
      (Slipstream warp, dev goto) reclassify the LOD immediately (`updateFieldLOD(game, 0)`) or the
      arrival would render empty for one frame.
    - **The minimap dot layer is cached**: ~1900 in-range rocks x (hypot+atan2+fillRect) per frame
      bakes into an offscreen canvas at ~15Hz (rebaked on origin jumps, fog flips, or the sim clock
      rewinding = resetRun) and composites as one drawImage; the sweep line stays live.
    Measured at ~8000 bodies, in-field: sim 3.6 -> 2.3ms, draw 2.2 -> 1.6ms, locked 120 fps.
  - **SHOAL LURKERS** (`Alien` kind `'lurker'`) are the fields' ambush predators, and they fight like
    BRAWLERS, not grabbers: no beam — they BODY-CHECK field rocks at you. Entering `FIELD_WAKE` springs
    one from a nearby rock (`FIELD_BROOD` per field per run, `FIELD_HUNTERS` of them hunting at
    once); it picks a rock roughly between itself and the ship,
    swings around to the far side (`line` — the visible tell), and CHARGES through it (`charge`), which
    launches the rock on a two-pass lead solve, marked alien-thrown so it plugs into every existing
    counter (orbit shield blocks it for XP, Deflector parries it, Dead Stop primes on the catch). Three
    rules are load-bearing and each fixed a real failure:
    - **Ambient rock contact does it NO harm.** A predator that died to its own habitat suicided on the
      nearest rock within seconds of spawning. A PLAYER-thrown rock still hurts it — that's the counterplay.
    - **It takes a MINIMUM number of hits, and hp is not what does that** (`LURKER_HIT_CAP` 0.34 of
      `LURKER_HP`, capped in `collideAlienBody`). Rock damage is QUADRATIC in closing speed and linear
      in mass, spanning three orders of magnitude (a 200-mass lob at 400 closing does 139; a 1400-mass
      rock at 1000 does 7422), so NO hp value is tunable across that range — every one is either
      one-shot by a real throw or immortal to a weak one. Raising `LURKER_HP` 34 → 90 alone changed
      literally nothing: both were one-shot by all nine sample throws. The per-hit cap (same idiom as
      invariant 3's comparable-rock cap) makes it cost ≥3 solid hits, which is what lets the predator
      live long enough to line up the rocks that are the actual threat. Lurkers only — grabbers and
      golems keep their existing feel.
    - **Only a committed `charge` shoves.** At shoal density a lurker brushes rocks constantly just
      manoeuvring; letting brushes shove burnt every cooldown on a random rock flung a random way
      (measured: 1 shove/min, none landing within 1300u).
    - **`collideAlienBody`'s "never collide with your own ammo" early-out must skip lurkers** — for a
      lurker the target IS the rock it means to hit, and that one line silently cancelled the whole mechanic.
    - **Only rocks under `LURKER_SHOVE_MASS` are shovable, in the AI pick AND the physics gate.**
      Without the physics half, a charge that clipped a giant on the way in "threw" it at ~40u/s and
      burnt the cooldown on a shot that visibly did nothing.
    The shot is *helped*: it only sets up from close in (`LURKER_SHOVE_R`) and the launched rock keeps
    steering toward the lead point briefly (`LURKER_GUIDE_*`) so a busy pocket deflecting it off a
    neighbour doesn't turn every shot into a graze. `LURKER_SHOVE` sits ABOVE `ALIEN_THROW` on
    purpose — the body-check is the lurker's whole attack, and at the old 420 the rock crawled over
    and the guidance window was doing all the work. Lurkers respect the dust shroud, and their
    containment is the POCKET FOOTPRINT itself via **`config.fieldFrac`** — the ONE shared
    lobed-outline test (ai.js leash + wake, render.js hunting-eye mirror, world.js entry announce all
    use it, so they can never disagree about where a field ends). A circular territory wide enough
    to cover the lane's long axis overshot the short axis 2x and lurkers visibly hunted empty space;
    now they engage while the ship is inside ~1.15 of the footprint, turn back at 1.3, and ambushes
    only spring with the ship actually IN the rocks (frac < ~1).
  - **Glow pockets** (`game.glowPockets`, glow.js): sparse WIDE FIELDS of small bioluminescent motes that
    ride the belt's prograde orbit (a circular rail, `w` matched to the flow at their radius), scattered
    thin across the mid system — a field (`GLOW_SPREAD`) is wide enough that you SWEEP the ship through it,
    scooping several in a pass, and its green region-halo makes it easy to spot. Motes are SLIGHTLY
    MAGNETIC — near the ship (`GLOW_MAGNET`) they home in and POP a hair before the hull touches
    (`GLOW_*` tuning in config.js) for a little hull + XP. **The only roaming mid-life
    hull heal** (see the split-health law above — hull-raising picks also heal their gain). No in-place refill — a drained pocket vanishes and a
    fresh full one fades in ELSEWHERE (never within view), so `game.glowPockets` holds a steady
    `PROG.GLOW_POCKETS` and the healing supply constantly relocates. Seeded deterministically off the
    world rng in `world.seedGlowPockets`; collected on dtReal in `glow.updateGlow` (a proximity test like
    the life pods, NOT the fixed step); drawn additively in `drawGlow` (a green region-halo + motes,
    healing-green palette). Never touches bodies/rails/velocities — purely additive to the sim.
- **Planet archetypes each carry ONE mechanic, every one built on an existing battle-tested shape**
  (nine ptypes: lava/rocky/gas/ice + terran/ocean/desert/shroud/crystal; the world.js PTYPE comment
  is the source of truth; gas giants also carry a render-only `gasKind` — amber/azure/violet looks,
  physics keys on ptype `'gas'` alone):
  - **TERRAN — atmosphere burn-up** (`CFG.ATMO_*`, physics.step, the corona-heat shape): loose
    free-flying asteroids under `ATMO_MAX_MASS` burn inside 1.5x radius — railed bodies (the world's
    own junk satellites live in the shell; damage would derail them), held rocks, and
    premium/quest objects (core/cache/pod/carved/visitor/wreck) are exempt, the SHIP never burns,
    and heavyweights punch through BY DESIGN: bombarding a terran world takes a real rock.
    Render streak rides `b.reentryT/reentryAng` (stamped in physics, decays in the integrate loop).
  - **OCEAN — waterspouts** (world.js hazard loop): the cryo-geyser branch with a sea-green cast —
    railed `iceOf` pellets, same caps, so it can never flood the belt.
  - **DESERT — dune skimming** pays `PROG.XP_SKIM_DUNE` (2x); hull cost UNCHANGED — the banded-moon
    law (bonus XP never discounts the grind).
  - **SHROUD — cloud cloak**: feeds the SAME `game.dustCloak` flag as dust moons (ai.js), halo
    `CFG.SHROUD_HALO` (1.7x; render haze drawn wider at 2.1x — no hard mechanic edge). Fortified
    shrouds don't cloak (a permanently cloaked siege is a free win).
  - **CRYSTAL — the one NON-CIRCULAR collider in the sim.** `util.crystalShards(id)` is the single
    source of the jagged shard polygon for BOTH render (traceCrystal) and physics — keep them on one
    table or the drawn surface and the felt surface diverge. Physics: `surfRadius` radial narrow
    phase in collideBodies/collideShipBody/collideAlienBody, `b._bp` broad-phase reach (the sweep
    must see the tallest spike, 1.32r max = `util.CRYSTAL_REACH`), predictPaths mirrors both hit
    tests, and ALL surface spawn offsets (chunk spray, shards) go through `surfReach` so nothing is
    born inside a spike (invariant 7's feedback loop). A hard player smash also rings loose a `core`
    shard (`damageBody`, floor dmg > 3 — planet mass dominance keeps throws under the moon-tuned 8).
    Render: lit sunward limb + per-shard sheens keyed to sun alignment; the hitbox IS the drawn shape.
  - **Each archetype carries achievements too** (11 rows + a secret): the discovery rows ride the
    existing one-shot `tut` flags (`atmo` / `dune` / `shroudCloak`) or a counter fed from
    `ACH_EVENT_STATS` (`spoutWarn`→`spouts`, `shardWarn`→`shards`) rather than instrumenting the sim
    twice; only the terran burn needed a real `bump` (`atmoBurns`), because its warn flag is
    tut-gated to one message and cannot count. `noteKill` classifies terran/crystal deaths
    (`kTerran` / `kCrystal`) alongside the existing ice/lava/gas buckets.

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
  `serve.py`, it's wrong. Audio assets follow the same rule: always relative paths (`assets/audio/…`);
  the `app://` scheme carries the `stream` privilege so `<audio>` elements can stream the music beds.
- **The build job checks out with `lfs: true`** — the music is LFS-tracked and `actions/checkout`
  does not fetch LFS objects by default, so without it electron-builder packages the pointer files
  and ships a silent game on a green build. A size guard in that job fails the run if any track
  comes through under 1 KB. `prepare`/`publish` deliberately stay pointer-only (they never touch
  the assets, and each extra LFS checkout is billed bandwidth).
- **npm scripts** ([package.json](package.json)): `npm run serve` (= `python3 serve.py`),
  `npm start` (run the Electron shell locally), `npm run dist` (build installers into `dist/`),
  `npm run changelog` (preview the pending release notes — needs `GH_TOKEN`).
  Electron + electron-builder are **devDependencies** — dev/build only. `electron-updater` is the
  one real `dependency` (it ships inside the packaged app), and it belongs to the SHELL — the
  GAME still has zero runtime dependencies, and nothing under `src/` may ever import it.
- `ELECTRON_START_URL` points the shell at the live dev server (`http://localhost:8642`) instead of
  `app://` for hot-ish iteration.
- **Auto-update** ([electron/updater.js](electron/updater.js)) — a no-op in dev (`app.isPackaged`
  gate), and split by what unsigned builds can honestly do: **Windows NSIS + Linux AppImage**
  self-update via electron-updater (background download, sha512-verified from `latest*.yml`,
  installs on quit; a dialog offers "Restart now"; AppImage is detected via
  `process.env.APPIMAGE`); **macOS** is check-and-notify ONLY — Squirrel.Mac refuses to swap an
  unsigned/ad-hoc bundle, so until a real Developer ID + notarization (+ a mac `zip` target)
  exists, don't route mac through electron-updater's installer; **Linux deb/rpm** installs are
  root-owned (in-place swap = pkexec prompt mid-game), so they're also check-and-notify — the
  AppImage is the self-updating Linux format. Four load-bearing wires, each of which silently
  reverts the auto platforms to manual updates if removed: the `build.publish` block in
  package.json (makes electron-builder embed `app-update.yml` in the app and emit the
  `dist/latest*.yml` feeds — `latest.yml` win, `latest-linux.yml` + `latest-linux-arm64.yml`
  per-arch), the release workflow uploading `latest*.yml` + `*.blockmap` to the GitHub release
  (the update feed; blockmaps enable differential downloads), the repo staying public (the feeds
  are unauthenticated), and the SPACE-FREE `nsis.artifactName` / `appImage.artifactName` — with
  electron-builder's default "Solar Slinger …" names, latest.yml points at the dash-sanitized
  name while GitHub renames the uploaded asset with DOTS, so the installed app 404s on every
  check (the AppImage name also needs `${arch}` or the x64 and arm64 files collide on the
  release). **Failure law: a failed update check is invisible** — offline/rate-limited must
  never surface a dialog. "Skip this version" persists in `userData/update-prefs.json`
  (notify platforms only).
- **Release CI** ([.github/workflows/release.yml](.github/workflows/release.yml)) is
  **`workflow_dispatch` only — nothing runs on a push to `main`.** You trigger it and pick a
  `bump` (patch/minor/major); `dry_run: true` builds and generates notes while publishing nothing.
  Three jobs: **prepare** (compute version + notes) → **build** (mac DMG arm64 + x64, Windows NSIS,
  Linux `.deb` + `.rpm` x64 + arm64 each — deb for Debian/Ubuntu/Raspberry Pi OS 64-bit, rpm for
  RHEL/Rocky/Fedora) → **publish**. Every side effect lives in `publish` and is gated on a green
  build, so a broken build can never leave a version commit or a dangling tag on `main`.
- **The newest `v*` git tag is the version's source of truth**, not package.json — the bump is
  applied to the tag, and `publish` then writes it into package.json and commits it. So checkouts
  must use `fetch-depth: 0` + `fetch-tags: true` or every release computes as `0.0.1`. (History:
  the patch digit used to be `github.run_number`, which made minor/major releases impossible and
  left package.json stuck at `0.1.0`.) The release tag is **annotated**, because `git push
  --follow-tags` silently refuses to push a lightweight one.
- **Changelog** ([scripts/changelog.mjs](scripts/changelog.mjs)): zero-dependency Node, no Actions
  context, so the same command runs on CI and on a laptop. It walks `git log <lastTag>..HEAD
  --first-parent` (PRs land as merge commits here, so first-parent = one entry per PR), recovers each
  PR number from the merge subject — falling back to the associated-PRs API for squashes and direct
  pushes — and renders title + link + author plus a summary line lifted from the PR body (skipping
  the leading `## What changed` heading and the Claude footer). Output goes to BOTH the release body
  and a prepended [CHANGELOG.md](CHANGELOG.md) section. Commits with no PR behind them get an
  "Other changes" list rather than being dropped. It's `.mjs` on purpose: package.json has no
  `"type": "module"` and must not gain one — `electron/main.js` and `scripts/adhoc-sign-mac.js` are
  CommonJS. The `SECTIONS` label map (enhancement→Features, bug→Fixes…) is a no-op today since no
  PR carries labels; everything falls into **Changes** until they do.
  The install instructions (Gatekeeper / SmartScreen / apt / dnf) live in `INSTALL_NOTES` in that
  script, NOT in the workflow YAML — builds are **unsigned** and every release must carry them.
  The `build:` block in package.json controls what gets packaged and the installer targets. App
  icons live in `build/` (`icon.icns/.ico/.png`, generated from `build/icon-src/`).
- **The version line in CREDITS** comes from a RELATIVE `fetch('package.json')` in main.js — the one
  version source `src/` can read without breaking host-agnosticism (it resolves the same under serve.py
  and over `app://`, which is registered `supportFetchAPI`). `package.json` is listed in the
  electron-builder `files` block so it stays fetchable from the asar. It is **only accurate on a release
  build**: a dev checkout's package.json lags the newest `v*` tag, which is the real source of truth. A
  failed fetch drops the version silently rather than showing a broken line.

## Testing (headless + live fast-forward, no framework)

There is no test runner. Verify balance and physics with the console hooks (all defined at the bottom
of main.js; ship-damage god mode and the NaN tally hook into physics.js):

- `window.soak(seconds, {idle})` — **the one-call balance soak**: arms `collisionLog`/`deathLog`/
  `game.nanEvents`, forces `autoUpgrade` on for the duration, `window.tick`s, and returns a summary —
  `{ planets: "21/21", moons: "48/48", ship, lives, tier, deaths[], impacts, nanEvents, wallMs }`.
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
  gating, NaN containment…). **Bit-repeatable** — the world seed is fixed and `Math.random` is swapped
  for a seeded RNG for the duration — so same code ⇒ identical report. Returns
  `{ passed, failed, results, logs }` (also `window.lastMechReport`; `{download: true}` saves the
  JSON). ~1.5s wall. See the `mechanics-test` skill for the check list and judging rules.
- `window.freshRun(specIdx, seed)` — repeatable fresh run: full reset onto the given world seed with
  the spec auto-picked and the sim armed. The world layout is bit-identical per seed.
- `window.speed(n)` — **live fast-forward**: runs the *visible* game at n× real time (0.25–50).
  `updateScaled` steps `update()` in 1x-sized chunks (the tick idiom) so AI/timers/easing see normal
  per-step dt, with a ~24ms wall-clock budget per frame — an unreachable target degrades gracefully and
  the amber HUD badge shows target + achieved rate (`game.speedActual`). 0.25 is slow-mo for watching a
  collision frame-by-frame-ish. `?dev=1` on the URL adds hotkeys: `-` halve, `=` double, `0` reset.
  Picks still open (and freeze) normally at speed — set `game.autoUpgrade = true` to blast through them.
  For truly unbounded fast-forward use `tick`/`soak` (headless, no render — ~35x+ on a laptop).
- `window.goto('vesper')` / `window.goto(x, y)` — teleport the ship beside a named body (velocity
  matched, parked outside its radius, brief invuln, camera snapped) or to coordinates.
  `window.locate('name'|'type')` returns the body itself.
- `window.god(on)` — ship ignores all damage (`damageShip` early-out) for poking at the corona,
  forts, or gas cores without respawn loops.
- `window.storm('charge' | 'here' | 'off')` — fire a SOLAR WAVE now instead of waiting out
  `CFG.STORM_EVERY`. `'charge'` starts at the telegraph so you see the whole event; `'here'` parks a
  front just inside the ship so the sheath is about to arrive (checking exposure/shelter without a
  40-second wait); `'off'` clears it.
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
- `game.collisionLog = []` — opt-in; records `{t,a,b,closing,dmgToA,dmgToB}` for impacts >2 dmg.
- `game.deathLog = []` — opt-in; records `{t,how,type,mass}` on every body death.
- `game.nanEvents` — count of NaN-tripwire firings (body culls / ship resets). Any nonzero value is
  a real upstream bug to root-cause, even though the tripwire contained it.

Run these from `javascript_tool` against the preview (the pane suspends rAF when hidden, so `window.tick`
/`window.soak`/`window.mechTest` are the way to advance the sim; `window.speed` needs the pane visible to
actually render). Two skills wrap all this: **`mechanics-test`** (fast "did I break the game loop?" —
runs `mechTest` and judges it) and **`balance-test`** (long-horizon stability — runs `soak` against the
21-planet/48-moon baseline — the 21 includes The Wanderer's Star, the expedition layer's
hidden dark dwarf).
