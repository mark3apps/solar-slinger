# The front-end shell — splash, pause, settings, controls, credits, achievements, the chart

> Deep reference. Read before editing the menu state machine in `main.js`, the DOM routing in
> `hud.js`, the boot animation, the world-seed flow, the perf overlay or the render-scale ladder.


The game boots to a **splash screen**, not straight into play — flags on `game` gate it, and the
sim runs only when all are clear (the `frame()` gate above): `started` (false → splash; START sets it),
`paused` (pause menu), and the six **shell modals** `settingsOpen` / `controlsOpen` / `creditsOpen` /
`achievementsOpen` / `systemsOpen` / `mapOpen`.
Those six are separate flags (each is its own panel) but every gate treats them alike, so they're asked
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
**`choosingUpgrade` MEANS THE SPEC CARD AND NOTHING ELSE.** It used to cover ability picks too, and those
now happen in flight: `openUpgrade` fills `upgradeChoices` / `upgradeKind` and `hud.syncOffer` seats the
cards at the head of the pilot card, where they wait without pausing anything (design-laws: *an owed pick
is offered, not forced*). Every consumer that reads the flag therefore now asks about the spec card
alone — `menuBlocking`, the music duck, the trajectory predictor, the V / M hotkeys, `toggleMenu`,
`syncMenus`'s `hudLive` — and that is the correct reading in each: a run must not be pausable-by-proxy
through a card it is allowed to ignore.
- **Transitions live in main.js** (it owns the state); **hud.js only routes the clicks** and derives which
  overlay is visible from those flags every frame in `syncMenus` (guarded, so the DOM is touched only when
  a flag flips) — same owner-split as the spec modal, and `syncOffer` is the same pattern again (signature-
  guarded, since it is `innerHTML` and rebuilding it per frame would throw away the card under the cursor
  between the mousedown and the click trying to pick it). `hud.initMenus(handlers)` wires the buttons once,
  the offer's delegated click included.
- **ESC / P** are one context-sensitive handler (`toggleMenu`): resume↔pause in-game, back out of whichever
  shell modal is up, never dismiss the spec card, no-op on the splash or over the death/game-over panels.
  The on-screen **☰ button** (a tab docked on the minimap's left rim — see design-laws) just calls
  `pauseGame`. Player input
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
  deliberately NOT a menu: swapping the score under a pick card would shred the soundtrack, so it
  ducks the gameplay track instead. Since the flag narrowed to the SPEC card that duck now happens
  once per run, under the title bed — an ability pick is offered in flight and never touches the
  music at all, which is exactly what the rule was protecting in the first place. A shell
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
- **MAIN MENU ENDS THE RUN — the seed is rolled on the way TO the title, never on the way out of it**
  (`main.toMainMenu`). Backing out used to only flip `started`, so the splash sat over a paused,
  half-played world and START silently RESUMED it: the title screen has no notion of "continue", so
  that read as the menu having done nothing. It now runs the full `resetRun` — which is what makes the
  backdrop honest, and is the whole reason the reset lives here rather than in `startGame`: the sky
  drifting behind the menu IS the brand-new system START drops you into, exactly as on a cold boot.
  Two things ride along: the spec card is deliberately NOT opened (`resetRun(seed, openCard=false)` —
  `startGame` opens it on the way in; a pick card floating over the splash is an upgrade modal with no
  run behind it, and every other `resetRun` caller, `window.freshRun` included, relies on the reset
  ENDING on that card), and the dead run's last words go with it (`hud.clearMessage` + the pending
  grab-tip `setTimeout` — the `#msg` lifetime is wall-clock, so a warning raised in a run's final
  second would otherwise hang over the title panel's header).
- **The system keys are ESC / T / V / M / H / R**, and the CONTROLS schematic (`index.html`
  `.syskeys`) is the list players read — a hotkey added to `input.js` without a key cap there is a
  control that only exists for whoever wrote it. **H** promotes the current dock to the run's home
  port; like every other hotkey it is gated on `menuBlocking()`, so it does nothing behind a pause,
  a shell modal or the open spec card. **1 / 2 / 3** answer whatever pick is on offer and carry the
  same gate for the inline one — the spec card is itself the blocker and answers from anywhere, but a
  digit pressed behind a pause screen must not reach into the run and spend a pick. They are
  deliberately NOT on the CONTROLS schematic: they exist only while cards are up, and the cards print
  their own key caps.
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
- **SAVED SOLAR SYSTEMS** (`systemsOpen`, the sixth shell modal) is the library of named worlds the
  player chose to keep — `game.systems`, an array of `{ name, seed }` rows persisted to
  `localStorage['ss_systems']` (its own key, so a settings wipe and the library can't take each
  other out; capped at 50, oldest saves fall off). **The seed IS the system**: `generateWorld` is
  seeded, so a row rebuilds its layout bit-identically — nothing else needs storing. Three ways in,
  one panel: the splash's **SAVED SYSTEMS** button (START is labelled **NEW SYSTEM** to make the
  pair read as a choice), the pause menu's **SAVE SYSTEM**, and an inline name-and-save form on the
  game-over panel. Which half of the panel is live is DERIVED from `game.started`
  (`hud.refreshSystems`), never from which button opened it: over a run the save form shows and the
  rows are a library to read; on the title screen the form is gone and **clicking a row FLIES that
  system** (`main.playSystem` — `regenWorld(seed)` + `startGame()`, so it opens on the spec card
  exactly like a cold boot). **Launching is title-screen only** — from the pause menu a row click is
  refused (belt and braces: the buttons are `disabled` AND the handler checks `game.started`),
  because one click ending the run in progress would be the costliest misclick in the game.
  Details that guard real traps:
  - **Every save form arrives PREFILLED with the seed's preset name** — `util.defaultSystemName`,
    one word off each of two lists (24×24), picked off a private mulberry32 XOR-offset from the
    world seed, so the same world proposes the same name on every surface. The placeholder and the
    blank-field fallback are that same name, so an empty field saves exactly what it shows.
  - **Re-saving a seed already in the library renames it and moves it to the top** — never a
    duplicate row; the seed is the identity, the name is a label.
  - **The game-over form is one-shot** (the button disarms to "SYSTEM SAVED ✓") and
    `hud.armGameOverSave` re-arms it on the next game over — it is called from the death branch in
    `update()`, so an idle soak (which sets no `deathCause`) never touches it.
  - The rows are rebuilt on the open transition and by main's save/delete handlers, **never per
    frame** (innerHTML — same law as the journey rail), and the ✕ is a **separate button beside
    the row, never nested inside it**: a delete must not also be a click on the thing it deletes.
  - `game.systems` is deliberately **NOT run state** — `resetRun` leaves it alone; only the
    explicit delete (or the 50-row cap) removes an entry.
- **THE SYSTEM CHART** (`mapOpen`, **M** or the ◎ tab on the radar bezel) is a shell modal and
  the only one that is **full-bleed** rather than a centred `.panel`: it IS the screen while it is up,
  because the sky it draws needs every pixel (a 440px octagon would make picking one moon out of a
  family impossible). Three consequences follow from being full-bleed, and each was a real fix:
  it **hides `#hud` outright** while it is open (the other panels leave the cockpit showing around
  them, which is right — but a radar on top of the chart is two instruments claiming one corner);
  its **close control is an X in the top-right corner**, not a BACK button in a tray, because there
  is no panel edge to sit one against; and its refusals go to **its own readout strip**, never
  `hud.message`, since `#msg` is deliberately hidden under a modal.
  Its canvas `#starmap` stays at **native dpr** for the same reason the radar does — downscale the
  picture, not the instruments — and is sized lazily inside `render.drawStarMap`, so nothing is
  allocated until the panel is first opened. It **always opens sun-centred at the fit scale**
  (`chartReset(true)`); the journey it plots is run state on `game.route` and outlives the panel,
  while the VIEW lives on `starmap.chart` and does not (it means nothing to a soak, and a death
  should not move it). Model, paint and chrome are split the same way every other panel is:
  `starmap.js` owns the projection, the knowledge ladder and the route; `render.drawStarMap` paints;
  `hud.refreshChart` mirrors state into the DOM (header stats and readout every frame, the journey
  rail only on a change signature — it is `innerHTML`, and rebuilding it per frame would also blow
  away the row under the cursor). The laws it obeys are in design-laws.md.
- **EXIT** calls `window.close()` — quits the Electron window; a harmless no-op in a plain browser tab.
- `window.tick` sets `started = true` so headless soaks bypass the splash.

