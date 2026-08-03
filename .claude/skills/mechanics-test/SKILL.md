---
name: mechanics-test
description: Run Solar Slinger's scripted, fixed-seed mechanics suite (window.mechTest) and interpret the report. Use after changing tractor.js, main.js game flow, config.js progression/abilities, or any player-facing mechanic — or whenever the user asks "did I break grabbing / flinging / picks / the shield?". For long-horizon orbital stability use balance-test instead.
---

# Mechanics test

`window.mechTest()` scripts a fixed set of player actions against a **fixed-seed** fresh run and asserts
each core mechanic — and several design laws — still behaves. It is **bit-repeatable**: the world seed is
fixed and `Math.random` is swapped for a seeded RNG for the duration, so two runs on the same code return
identical reports. A run takes ~1.5s wall.

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
| sky intact after suite | the suite's own actions must not shred planets/moons |

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
