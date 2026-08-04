---
name: mechanics-test
description: Run Solar Slinger's scripted, fixed-seed mechanics suite (window.mechTest) and interpret the report. Use after changing tractor.js, main.js game flow, config.js progression/abilities, or any player-facing mechanic — or whenever the user asks "did I break grabbing / flinging / picks / the shield?". For long-horizon orbital stability use balance-test instead.
---

# Mechanics test

`window.mechTest()` scripts a fixed set of player actions against a **fixed-seed** fresh run and asserts
each core mechanic — and several design laws — still behaves. It is **bit-repeatable**: the world seed is
fixed and `Math.random` is swapped for a seeded RNG for the duration, so two runs on the same code return
identical reports. A run takes ~4s wall (the docking cases fly real approaches).

This is the fast "did I break the game loop?" check. It complements, not replaces, the `balance-test`
skill: mechanics-test proves the verbs work; balance-test proves the sky survives an hour.

## Workflow

1. **Start the preview** (never Bash): `preview_start` with `{ name: "solar-slinger" }`; reload if it was
   already running so the latest modules load.

2. **Run it** from `javascript_tool`:

   ```js
   await window.mechTest();
   ```

   Options: `{ seed: 12345 }` for a different world; `{ reset: false }` to leave the post-suite world in
   place for inspection (default regenerates a clean run); `{ download: true }` to save the report JSON
   to a file for the user.

3. **Read the report**: `{ seed, wallMs, passed, failed, results, logs }`.
   - `results[]` — `{ name, pass, detail }` per check; `detail` carries the measured numbers, so a
     failure is usually diagnosable without re-running.
   - `logs.deaths` / `logs.collisions` — everything the death/collision recorders caught during the
     scripted actions (normally empty or near-empty).
   - `logs.nanEvents` — must be 0. The suite's own deliberate NaN injection is scrubbed from the tally;
     anything left is a real upstream bug.
   - The last report is also on `window.lastMechReport`.

## What the suite covers (and which laws each check guards)

| Check | Guards |
|---|---|
| world-gen deterministic | seeded generation contract |
| grab + derail + catch XP | tractor grab, derail-on-grab trigger, XP economy |
| fling at cursor, no recoil | **"throws never steer"** + **"flinging has no recoil"** design laws |
| orbit gate, capture + shotgun | orbit ring is ability-gated; capture/launch bookkeeping |
| pick deferred by fling, then consumed | **"the pick offer is deferred, never lost"** (and that an ability pick never sets `choosingUpgrade` — it is offered on the pilot card, not forced) |
| shield unlocks and absorbs first | shield-is-an-ability law; absorb-before-hull ordering |
| god mode blocks damage | the `window.god` dev hook |
| hull does not self-heal | **split-health law** (hull mends only at glow pockets) |
| shield recharges after quiet time | regen delay/rate plumbing |
| speed governor bleeds overspeed | the relative-to-flow speed ceiling |
| glow mote heals hull | the one legitimate mid-life heal |
| death spends life, respawn keeps build | lives system, build persistence |
| NaN tripwire contains poison | invariant containment + `nanEvents` counting |
| delivery: wreck wakes the Herald | the shared delivery verb (updateDeliveries) — handover, not kill; pays XP |
| chart pays once; master chart at 100% | chart-everything: once-per-key payout, hidden-star exclusion, MASTER CHART reward |
| achievement ids are unique | the track is id-keyed end to end — a duplicate id silently forfeits a row's points and XP while the panel shows both as earned |
| dock: three gates latch a berth | contact / nose-within-`DOCK_ARC` / speed-under-`DOCK_SPEED`, all true for `DOCK_TIME`; and that `game.dockGate` names the one refusing |
| dock: build window is unprotected, finished berth heals | **"a dock is a structure, not a state"** — the `DOCK_BUILD` seconds give nothing, the finished station gives immunity + `DOCK_HEAL` |
| dock: jink and parry are inert while berthed | **"a dock is where you stop working"** for the two abilities `main.dockBlocking` structurally cannot reach (neither is input-driven), and that a parried rock is released rather than welded to the hull |
| dock: launch releases, and the station persists | **"leaving is a sequence"**; a finished station STANDS on its world after the ship goes |
| dock: a save needs the repair to happen AT the dock | "Limped In" means what it says — healing to full anywhere else cancels the arm |
| storm: three classes, graded reach and a real taper | **"a wave's reach is its geography, and it dissolves rather than stopping"** — per-class reach ordering, full strength inside `fade`, zero at the limit, and `fade < 1` (the `stormStrength` divisor invariant) |
| storm: every moon casts a lee | **"every moon shelters"** — counts real moons against `STORM_SHADOW_MIN_R` (the floor was 60 and quietly failed 40 of 59); the ring shepherd moonlet is the one documented exception |
| parry: the riposte flies at the cursor | the aimed-deflection direction — ship→cursor, not back along the capture bearing |
| pilot card: keydown, click, and the paused-run guard | the inline offer's three real answer paths — the `Digit1` keydown, the `#offerBox` click delegate (and the `data-i` wiring it reads), and the guard that refuses a digit into a paused run; plus the `flingDelayT` deferral an answered inline offer arms |
| sky intact after suite | the suite's own actions must not shred planets/moons |

**The pilot card's answer paths ARE covered now** (issue #96), and the story is worth knowing before
you touch this suite. That case was written once, passed, and was reverted, because answering a pick
made consecutive runs diverge. Two independent defects, both since fixed at the source:

- **Audio was drawing from the gameplay stream.** `input.js` calls `initAudio()` on ANY keydown, and
  `sfx.play()` plus its synth fallback take a wildly different number of `Math.random` draws
  depending on whether a context exists and whether samples have decoded — no context = 0 draws,
  context but undecoded = the fallback runs and `noiseSweep` alone burns ~29,000, decoded = one.
  One real keydown therefore moved a later pick onto a different ability. `sfx.js`, `music.js` and
  `hud.js` now own private streams.
- **Body ids outlived their world.** `NEXT_ID` was session-monotonic while `rockshape.rockShapeOf`
  keys the baked silhouette off `b.id`, so a re-run of the same seed built the same layout wearing
  DIFFERENT rock — identical worldgen checksum in, 4,409 / 4,410 / 4,411 live bodies out half a
  second later. `world.generateWorld` resets it now.

**Every result carries a `draws` field** — the RNG draw count at that test's boundary. It is the
tripwire: two runs of the same seed must produce the same sequence of them, and a drifting column
localises a recurrence to a single test in one diff. That is how both defects above were found.
**If a new case ever makes the suite drift, do not delete the case** — read the `draws` column, and
check whether something has started drawing gameplay randoms off an initialise-once capability.

## Judging results

- **All checks must pass.** Any failure is a regression in that mechanic (or, occasionally, a deliberate
  redesign — in which case update the failing check in [src/devtest.js](../../../src/devtest.js) in the
  same change, and say so).
- `identical` across two consecutive runs should hold. If two same-code runs differ, something
  non-deterministic leaked into the suite path (a `Date.now()`/unseeded-random dependency) — worth
  root-causing before trusting any other result.
- After a **mechanics redesign** (e.g. a new ability gate), the right fix is usually to *extend* the
  suite: add an assertion for the new gate rather than deleting the old check.

## Adding a check

Checks live in [src/devtest.js](../../../src/devtest.js) — one `t('name', () => { ... })` block each,
using `expect(cond, msg)` and returning a short detail string. Keep new checks deterministic (no wall
clock, no unseeded randomness), park the ship with `parkShip` first, and leave the world census intact
or the final "sky intact" check will flag you. devtest.js is lazy-loaded (only `window.mechTest` imports
it), so it costs normal play nothing — keep it that way.
