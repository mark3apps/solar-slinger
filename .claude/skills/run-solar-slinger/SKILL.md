---
name: run-solar-slinger
description: Build and launch Solar Slinger from a clean checkout, and drive it from a script — batch soaks, CI-style checks, or any run that must work with nothing visible. Use when setting up the game on a fresh machine, running the suites unattended, or when the Claude Browser pane is unavailable. For interactive work where the user is watching, prefer the playtest skill.
---

# Run Solar Slinger

> **Use the `playtest` skill instead when the user is watching.** The Claude Browser pane is the
> better tool for anything interactive: `read_page` gives an accessibility tree with element refs,
> plus `find`, network inspection, light/dark `resize_window`, scroll/hover/drag, and — the part that
> matters — the game renders in the user's own app where they can see it. It also needs no setup.
>
> Reach for this driver for the two things the pane genuinely cannot do:
> **(1)** the pane suspends `requestAnimationFrame` when hidden, so nothing advances unless it is
> on screen; this driver runs with nothing visible at all. **(2)** the pane's console has a ~30s eval
> budget, so long soaks must be chunked; this driver ran a full `soak(600)` in one 50s call.
> It also exits with a status code, which is what makes it scriptable and CI-able.
>
> It does **not** solve the perf-measurement variance problem — two in-shoal runs here gave sim
> 2.77 ms and 3.55 ms. Follow `perf-profile`'s interleaved-A/B rule either way.

Vanilla-JS canvas game, no build step. The shipping Electron shell serves the repo over a privileged
`app://` scheme (Chromium refuses ES modules over `file://`). **`driver.mjs` re-registers that same
scheme**, so it launches the game straight off the working tree — no dev server, no port, no window.

Paths below are relative to the repo root. The driver is at
`.claude/skills/run-solar-slinger/driver.mjs`.

## Prerequisites — do this first or nothing works

`npm install` here leaves `node_modules/electron/dist` **missing** (install scripts were skipped), so
`npx electron` fails with no useful message. Download the binary once (~110 MB):

```bash
npm install && node node_modules/electron/install.js
```

Verify:

```bash
ls node_modules/electron/dist/Electron.app > /dev/null && echo "electron ready"
```

Python 3 and Node are the only other requirements. The game itself needs **no** `npm install` — that
is only for the desktop shell and this driver.

## Run (agent path) — the driver

Commands are piped on stdin, one per line, and run in order in a single Electron session (launch is
~1s, so batch them). `#` starts a comment.

```bash
printf 'waitfor window.game 45000
eval ({ bodies: game.bodies.length, seed: game.worldSeed })
eval window.freshRun(0)
eval window.tick(20)
shot .claude/skills/run-solar-slinger/shots/gameplay.png
' | npx electron .claude/skills/run-solar-slinger/driver.mjs
```

Output (this is a real run):

```
waitfor: window.game -> true (48ms)
{"bodies":8388,"seed":3421294885}
shot: /…/shots/gameplay.png (1440x868)
```

`eval` prints one line of JSON, so results pipe into `jq`. Any command failing prints `ERROR [...]`,
stops the run, and exits non-zero.

| Command | Does |
|---|---|
| `waitfor <expr> [ms]` | poll a JS expression until truthy — **always start with `waitfor window.game`** |
| `eval <js>` | evaluate in the page (awaits promises), print JSON — **one line only** |
| `script <path> [json]` | run a whole JS file as an async IIFE, print its return as JSON; `json` lands in `ARGS` |
| `shot <path>` | `capturePage()` → PNG |
| `move <x> <y>` | mouse move — **this aims the ship**, the nose tracks the cursor |
| `click <x> <y>` | real mouse down/up into the canvas |
| `key <code> [down\|up]` | key press, or hold/release (`key w down` … `key w up` to thrust) |
| `type <text>` | type into a focused field |
| `wait <ms>` · `goto <url>` · `reload` · `console` · `clearconsole` | — |

Flags: `--show` (visible window), `--url <url>`, `--size 1440x900`, `--audio` (unmute), `--root <dir>`.

### Screenshots: always `tick` before `shot`

The window is hidden by default, so Chromium throttles `requestAnimationFrame` to nothing. `tick`
advances the fixed-step sim **and renders one frame** regardless, so the capture path is
`eval window.tick(<seconds>)` then `shot`. Never `wait` and hope.

### Pin the world

The seed is **random per run**. Pin it in the URL — this works over `app://` too:

```bash
printf 'waitfor window.game 45000
eval (()=>{const r=window.soak(600,{idle:true});return {seed:game.worldSeed,planets:r.planets,moons:r.moons,nan:r.nanEvents};})()
' | npx electron .claude/skills/run-solar-slinger/driver.mjs --url 'app://game/index.html?seed=20260721'
```

→ `{"seed":20260721,"planets":"21/21","moons":"48/48","nan":0}` in ~50s wall for 600 sim-seconds.

### Multi-seed stability sweep — the fast balance check

`eval` takes the rest of **one line**, so real metric code lives in a file and runs via `script`.
`suites/stability.js` ships next to the driver:

```bash
S=.claude/skills/run-solar-slinger
for s in 20260721 3827467762 111222333 987654321; do
 ( printf "waitfor window.game 45000\nscript $S/suites/stability.js {\"seconds\":600,\"strip\":true}\n" \
   | npx electron $S/driver.mjs --url "app://game/index.html?seed=$s" 2>/dev/null | tail -1 ) &
done; wait
```

**4 seeds × 600 sim-seconds in 18.9s wall** (127× realtime, 450% CPU). Two things make it fast, and
both are measured, not assumed:

- **`strip:true` drops dormant field rock** — 7,600 of 8,404 bodies. Only 138 are awake in an idle
  soak, yet those dormant rocks cost ~78% of the runtime in LOD + rail bookkeeping, and being
  gravity-free in both directions they cannot affect the sky. Proven equivalent on one seed:
  4,516ms stripped vs 23,373ms intact, **every verdict field identical**. Pass `strip:false` when the
  fields themselves are what changed.
- **Parallelism is near-linear** — each Electron process is single-threaded, so N seeds cost about
  what one does.

`suites/stability.js` reports what `window.soak` cannot: `planetsOffRail`, anchor-relative
`worstPlanetDriftPct` (a deorbit shows here long before anything dies), and **cumulative
cause-classified** `nonAsteroidDeaths` instead of a live census that re-accretion makes wobble.
Interpretation rules live in the `balance-test` skill.

### The test suites — and seeing what your change did

`bench.mjs` runs the suites in parallel, saves a baseline, and **diffs against it**. That diff is the
point: you do not read numbers, you read what moved.

```bash
B=.claude/skills/run-solar-slinger/bench.mjs
node $B save                      # before your change — snapshot the baseline
node $B diff                      # after  your change — show what moved
node $B diff combat stability     # just the areas you touched
node $B run worldgen              # print raw JSON, no baseline needed
```

**All 9 suite-runs take ~20s** (5 suites x their seeds, in parallel — each Electron process is
single-threaded, so the set costs about what the slowest one does alone).

| Suite | Covers | Sim? |
|---|---|---|
| `worldgen` | lanes, moon clearance, field pockets, landmarks, population by type | no |
| `progression` | XP curve, ability ladders, kit rules, pick pools, shipStats | no |
| `combat` | damage ladder per target class, per-hit caps | yes |
| `stability` | rails, drift, deaths, integrity over 600 sim-seconds x 4 seeds | yes |
| `perf` | 8 scenarios, sim/draw split with the counts that explain them | yes |

`worldgen` and `progression` need no simulation at all, so they are near-instant — run those after
any `world.js` or `config.js` edit before anything else.

#### Reading a diff

Red = an EXACT field moved (structure, integrity, economy). Yellow = a banded field moved far enough
to clear its tolerance. A real example — `DMG_THRESH` lowered 240 → 150:

```
combat/20260721 (2 changed)
  ladder[moon].moon13000@900        null → 2758
stability/3827467762 (2 changed)
  nonAsteroidDeaths.moon:absorbed      — → 2   NEW
stability/987654321 (4 changed)
  looseCelestials                     0 → 2
  planetsOffRail                      0 → 1
  worstPlanetDriftPct.pct             0 → -6.74
```

That is the documented regression signature for the railed-conjunction guard (which keys off
`DMG_THRESH`) — caught across two seeds without anyone knowing to look for it.

#### Tolerances — why the diff is not all noise

Runtime spawns, spall and AI use `Math.random` on purpose, so live counts genuinely wobble between
identical runs. A first cut compared everything exactly and reported **109 changed fields for a no-op**,
which just teaches you to ignore the tool. Fields are now classed:

- **VOLATILE** (never compared) — particles, aliens, flares, bolts, dropped sim seconds, wall time.
- **Banded** — timings (35% or 0.12ms), live populations (20% or 40), death tallies (±4), staged-impact
  rungs (20% or ±3).
- **EXACT** — everything else. One moon, one NaN, one off-rail planet is the whole point.

**Measured noise floor: 0–2 fields across three consecutive no-op runs.** If you see more than that
with no change, something is genuinely moving.

Three fixes were needed at the source to get there, all worth knowing: `performance.now()` is clamped
to ~0.1 ms in Electron, so a single render timed 0.2 vs 0.3 on identical code (+50%) — `perf.js` now
times a batch of 20 renders per sample; `combat.js` **freezes its target** (derails it, zeroes its
velocity) for the measurement, because a railed moving target gave spreads of 3466 vs 4936 on the same
rung, plus outright misses; and `worldgen.js` **regenerates the world before counting it**, because
the splash backdrop is a live sim and `waitfor window.game` returns after an unbounded slice of it —
its `byType.asteroid` measured 8325 / 8324 / 8323 at 0s / 10s / 25s of boot delay, an EXACT field
going red on unmodified code. The saved `3827467762` baseline had itself been captured 86 asteroids
into that erosion.

#### Adding a suite

Drop `suites/<name>.js` in — it runs as an async IIFE in the page, returns a JSON-able object, and gets
`ARGS` from the JSON passed after the path. Register it in the `SUITES` table in `bench.mjs` with its
seeds. Rules that keep it diffable: **return numbers, not prose**; never return a wall-clock or a
`Math.random`-derived count without adding it to `VOLATILE`; **return `null`, not `0`, when a
measurement did not happen** — a miss and a harmless result must not look alike; and **never assume
the world is untouched at `waitfor window.game`**. The title screen runs the full physics behind it
(`driftSplash`), for a wall-clock-dependent length of time, and `physics.step` culls dead and escaped
bodies out of `game.bodies` — so any count of live bodies silently shrinks with how slow the boot was.
A `sim: false` suite that needs a pristine sky must rebuild it first (`window.freshRun(0, seed)`) and
read it in the same synchronous turn, the way `worldgen.js` does.

### Performance scenario matrix

```bash
S=.claude/skills/run-solar-slinger
printf "waitfor window.game 45000\nscript $S/suites/perf.js\n" \
  | npx electron $S/driver.mjs --url 'app://game/index.html?seed=20260721' 2>/dev/null | tail -1
```

One number for "is it slow" hides *which* subsystem regressed, so `perf.js` parks the ship in eight
places that each isolate one cost driver, and times sim and draw separately in a single session (so
the rows are comparable to each other even though absolute numbers drift between machines).

Sim and draw are split without needing rAF at all — which is what makes it repeatable and works with
the window hidden:

- `window.tick(0)` runs **zero** `update()` iterations and exactly one `render(game)`. That is draw.
- `window.tick(1)` is 60 `update()` calls plus one render. Sim per frame = `(tick(1) - tick(0)) / 60`.
- Medians over repeats, because these timings have fat tails and one GC pause moves a mean.

Measured baseline, seed 20260721 (ms per frame, sim / draw):

| scenario | total | isolates |
|---|---|---|
| debris-heavy | **3.62** (3.32 / 0.30) | crust halo, calving, debris budget pressure |
| solar-storm | 2.96 (2.46 / 0.50) | sheath render + exposure/shelter resolve |
| dense-field | 2.73 (2.33 / 0.40) | field LOD, rockgl, minimap dot bake |
| gas-giant | 2.04 | gas render + enclosed-mass gravity |
| alien-nest | 1.96 | AI state machines, turrets |
| crystal-world | 1.92 | the non-circular collider, sim AND render |
| planet-system | 1.86 | attractors, moons, belt, near-ship crumble |
| open-space | 1.67 | floor cost |

Every row also carries the counts that **explain** its timing — `awake`, `attractors`, `crust`,
`debris`, `particles`, `aliens`, `flares`, `bolts`, `debrisHeadroom`, `substepsLastFrame`, `dtHz`,
`droppedSimSeconds`. A row moving while its counts hold still is a code regression; both moving
together is a content change. Run it before and after and diff the rows.

`{"only":["dense-field"]}` restricts the run; `{"reps":21}` tightens the medians.

**Honest limit:** canvas2d calls are recorded on the main thread and rasterised later, so `drawMs`
measures **draw-call submission**, not GPU raster. It tracks view complexity well (0.1 ms in open
space at 133 awake vs 0.4 ms in a shoal at 841) and is the right signal for "did my change add draw
work" — it is not a frame-budget figure. For that read `game.perf.drawMs` off a **visible** window and
follow `perf-profile`'s variance rules.

### The two suites

```bash
printf 'waitfor window.game 45000
eval (async()=>{const r=await window.mechTest();return {passed:r.passed,failed:r.failed,fails:r.results.filter(x=>!x.pass).map(x=>x.name)};})()
' | npx electron .claude/skills/run-solar-slinger/driver.mjs
```

→ `{"passed":19,"failed":0,"fails":[]}` in 2.5s wall including launch. Interpretation rules live in
the `mechanics-test` and `balance-test` skills — this is just the fastest way to invoke them.

### Driving the UI for real

Verified click-through from cold boot (window is 1440×868 — the 900 includes chrome):

```bash
printf 'waitfor window.game 45000
wait 1200
click 720 396
wait 600
key 1
eval ({ spec: game.prog.spec, choosing: game.choosingUpgrade })
' | npx electron .claude/skills/run-solar-slinger/driver.mjs
```

→ `{"spec":"brawler","choosing":false}` — `click 720 396` is START GAME on the splash, `key 1` picks
the first spec card.

### Getting somewhere interesting

```bash
printf 'waitfor window.game 45000
eval window.freshRun(1)
eval window.goto("The Shoal")
eval window.tick(2)
shot .claude/skills/run-solar-slinger/shots/shoal.png
eval ({ awake: game.bodies._awake.length, bodies: game.bodies.length, sim:+game.perf.simMs.toFixed(2), draw:+game.perf.drawMs.toFixed(2) })
' | npx electron .claude/skills/run-solar-slinger/driver.mjs
```

Two real runs gave `{"awake":1269,…,"sim":2.77,"draw":1.88}` and `{"awake":1342,…,"sim":3.55,"draw":1.76}`
— the spread is the random seed, so **compare only within one pinned seed**. What matters is the shape:
open space sits at `awake: 168`, and the jump past 1,000 is the field LOD engaging. Other hooks:
`window.god(true)`, `window.storm('charge')`, `window.speed(n)` (needs `--show`), `window.locate('gas')`.

## Direct invocation — no app at all

`config.js` and `util.js` are leaves with no DOM dependency, so progression and tuning math can be
called straight from Node. This is the right harness for a PR that only touches those:

```bash
node --input-type=module -e "
import('./src/config.js').then(m => {
  console.log('abilities:', m.ABILITIES.length);
  console.log('brawler kit:', m.SPECS[0].start.join(', '));
});
"
```

→ `abilities: 41` / `brawler kit: kineticSling, reinforcedHull, ramProw, deflector`.

Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning and suggests adding `"type": "module"` to
package.json. **Do not.** `electron/main.js` and `scripts/adhoc-sign-mac.js` are CommonJS and adding it
breaks the desktop build. Ignore the warning; that is why the driver is `.mjs`.

## Run (human path)

```bash
python3 serve.py
```

→ `http://127.0.0.1:8642`, hot reload on save. This is the primary *editing* workflow. Port is taken
if another checkout is serving; a worktree needs `PORT=8743 python3 serve.py`, verified with:

```bash
curl -sSI http://127.0.0.1:8743/src/main.js | grep -i cache-control
```

→ `Cache-Control: no-cache, no-store, must-revalidate`. The driver can attach to it instead of using
`app://` — useful when you want one browser tab and the driver on the same live server:

```bash
printf 'waitfor window.game 45000\neval ({bodies:game.bodies.length, via:location.origin})\n' \
  | npx electron .claude/skills/run-solar-slinger/driver.mjs --url 'http://127.0.0.1:8743/index.html'
```

`npm start` opens the real desktop shell in a window (verified; Ctrl-C or close to quit). It is the
product, not a test surface — it gives you no programmatic handle.

## Gotchas

- **`node_modules/electron/dist` is missing after `npm install`.** The single most likely reason
  nothing runs. See Prerequisites.
- **Run the driver with `npx electron`, never `node`** — it is an Electron *main* process. `node
  driver.mjs` dies on `import { app } from 'electron'`.
- **`soak().deaths` are formatted strings, not objects** — `"moon swallowed by a gas giant @70s
  (m=12245)"`. Filter with `.startsWith(...)`, not `d.type`. The raw `{t,how,type,mass}` objects are on
  `game.deathLog`, which is a different thing. (The `balance-test` skill described the object shape;
  that applied to `deathLog`, not to `soak`'s return.)
- **`TIER 0 · SCOUT` in the HUD is the hull class, not your spec.** `st.shipName` for tier 0 happens to
  be "SCOUT", which collides with the SCOUT specialization. A BRAWLER run correctly shows
  `TIER 0 · SCOUT` up top and `BRAWLER` in the ability panel. Not a bug — don't "fix" it.
- **Audio is muted by default** (`--audio` to unmute). 24 music beds out of an invisible window is a
  bad surprise on a developer's own machine.
- **The Electron CSP security warning in `console` output is dev-mode noise** — it does not appear in
  packaged builds. Pipe through `grep -v 'Security Warning'`.
- **Moon survival is seed-dependent.** Seed `20260721` holds 48/48; seed `3827467762` reproducibly ends
  at 43/48 (45/48 by 300s), losing four moons to `swallowed by a gas giant` before any player input.
  Judge a soak against the same seed you compared before, and see Troubleshooting.
- **Cleaning up: match precisely.** `pkill -f Electron` also matches Claude Desktop, VS Code and Docker
  Desktop helper processes. Use `pkill -f "Solar system.*Electron"` or kill the PID you started.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Error: Electron failed to install correctly` or `npx electron` does nothing | binary not downloaded → `node node_modules/electron/install.js` |
| `waitfor timed out … window.game` | a module failed to load. Add `console` as the next command and read it — usually a bad import path or a missing `.js` extension |
| Screenshot is black or shows only the backdrop | you captured before rendering. Put `eval window.tick(0.1)` immediately before `shot` |
| `{"…":null}` from an `eval` that should return data | the value isn't JSON-serializable (a DOM node, a `Body` with cyclic refs). Project it first: `eval game.bodies.slice(0,3).map(b=>b.name)` |
| Game runs SILENT with no error | Git LFS pointer files instead of music. `git lfs pull` |
| `Address already in use` on serve.py | another checkout is on 8642 → `PORT=8743 python3 serve.py` |
| A parallel sweep hangs (minutes instead of ~20s) | Observed once right after several back-to-back single runs. Check `pgrep -f "Solar system.*Electron"`, kill any strays, and retry — a single seed at 60s is the quick sanity probe (should be ~0.9s wall, ~67x realtime). Cause not pinned down; if it recurs reproducibly, that is worth a look |
| Soak reports fewer moons than expected | check the seed first (`game.worldSeed`), then whether the losses are `swallowed by a gas giant` (a giant eating its own moons — a real content question, not a physics-invariant break) or `absorbed` (the Tantal sibling-slot eccentricity clamp in `world.js spawnMoon`, per `balance-test`) |
