---
name: add-ability
description: Add or rebalance a named ability in Solar Slinger's ABILITIES catalog — the catalog row, the shipStats channel, any runtime hook, and the verification that it isn't a dead card. Use when asked to add a new ability/upgrade/perk, retune an existing one's ranks or tier floor, or change a spec's starting kit.
---

# Adding an ability

The whole point of the design is that **adding an ability is a catalog row plus reading its channel in
`shipStats`** — nothing else should need to know it exists. If you find yourself editing a third place
just to make it appear, stop and say so; that's a smell, not a step.

Full rationale: [docs/progression.md](../../../docs/progression.md). This skill is the procedure.

## 1. Write the catalog row

`ABILITIES` in [src/config.js](../../../src/config.js). The shape:

```js
{ id: 'kineticSling', spec: 'brawler', name: 'Kinetic Sling', icon: '➹', channel: 'fling',
  max: 6, minTier: 0, weight: 1.0, desc: 'Hurl held rocks harder.' },
```

| Field | Rules |
|---|---|
| `id` | unique; stays distinct even when two specs share a `name` |
| `spec` | the OWNER spec — `brawler` / `hauler` / `scout` |
| `channel` | the stat bucket. `shipStats` SUMS every owned ability's rank into its channel, so several abilities can stack one channel |
| `max` | rank count. **Prefer `max > 1`** — a max-1 unlock arrives already maxed and its bar never climbs |
| `minTier` | soft floor: can't be OFFERED until this tier. Capstones sit at 3 |
| `weight` | offer weight in `tierChoices` |
| `also` | optional `{ specId: minTier }` — shares the row with other specs at their own, usually higher, floor. `tierFloorFor` is the one resolver |
| `xpMul` | optional ladder scale. Late-floored rows discount: **0.5 at `minTier` 3, 0.7 at 2** — they're learned with only a fraction of the run's XP left |
| `needs` | optional HARD prerequisite naming a **channel**, not an id |

**`needs` is only for rows that are literally INERT alone.** Scattergun / Rockwall / Aegis Reflector /
Recovery Tether all act on ORBIT rocks, and with no orbit ability `shipStats` gives `orbitCap` 0, so
there is never a rock to act on. Each was a dead card: it spent the pick, its bar climbed, nothing
happened. Two constraints: every channel a `needs` points at must have an **un-gated tier-0 provider
in that spec's pool** (or the gate deadlocks), and **do not add it to the second-track duplicates**
(Grapple Extenders, Expanded Bay, Overtuned Drive, Bulk Freighter, Juggernaut) — they read like
extensions but work fine standing alone.

**Naming law:** two abilities that DO the same thing share one name/icon/desc even across specs
(Heavy Winch is the catch starter in BRAWLER and HAULER; Reinforced Hull is both hull tracks). Same-spec
second tracks are the exception — they must stay separately named to coexist as cards, and their descs
read as "more of the same".

## 2. Read the channel in `shipStats`

Still in config.js. Sum the rank into the stat it feeds. All existing `st.*` field names must stay
unchanged — render/physics/tractor/hud consume them by name.

`totalLevel` = `min(25, tier*2 + round(rankSum*0.6))`; keep it in the 0–25 band, it feeds enemy scaling
(ai.js) and ship mass (physics.js).

**HAULER never gets a `shield`-channel ability.** Its protection is the orbit rock wall, by design.

## 3. Only if the ability is mechanical: wire the runtime hook

Most abilities are pure `shipStats` numbers. The ones with real sim behaviour live outside config, and
the hook and the catalog row must stay in sync:

| Spec | Hook sites |
|---|---|
| BRAWLER | `physics.collideShipBody` (ram), `physics.brawlerThrowKill` (cluster/shockwave/demolition), `physics.wallSplat`, `physics.updateParry` (Deflector), `tractor.updateOrbit` (War Rack aft slots), `tractor.flingSpeedFor` (Berserker) |
| HAULER | `tractor.updateTethers`, the orbit-intercept block in `physics.collideBodies` (Aegis), `game.held2` through `tryGrab`/`springHeld`/`releaseHeld`/`addToOrbit` (Twin Grip), `physics.damageBody` + `tractor.updateOrbit` (Rockwall), `tryGrab`/`flingSpeedFor`/`releaseHeld` (Dead Stop) |
| SCOUT | `main.js` owns `game.burnerFuel`/`game.burnerOn` (Afterburner — physics reads **`game.burnerOn`, never raw Shift**), `main.onDash`, the closest-approach scan in `physics.step` (Reflex Jink), `main.onWarp` (Slipstream), `world.js` survey radius (Recon Drone) |

If the ability adds a **control**, it goes in `input.js` gated behind `menuBlocking()` like every other
player input, and gets a `data-fn`/`data-note` key cap in the CONTROLS schematic in `index.html` —
**that is an HTML edit; nothing in JS needs to know it exists.** Mark ability-gated caps with the gold pip.

## 4. If you touched a starting kit

**Kit rule: every kit carries at least THREE abilities with `max > 1`.** The ability bars are the
minute-one feedback and the first card is minutes out, so a thin kit opens the run with almost nothing
climbing. Current kits are 4 / 3 / 4 abilities.

**Kit abilities are the only ones learned at the same instant**, so their pools stay equal forever and
only the cost stagger separates them. If you change a kit, re-verify devtest T5c: thresholds always
RISE, and **no two kit abilities rank up together**. The separating constants (`ABIL_XP_SPREAD` 0.23,
`ABIL_XP_WOBBLE` 0.08) were SEARCHED against the real catalog to maximize the tightest kit gap (49 XP)
— a per-ability scale alone cannot do it, because ladders of different LENGTH cross however they are
scaled. **`ABIL_XP_WOBBLE` must stay under ~0.108** or a later rank can cost less than an earlier one.

## 5. Verify

1. **`mechanics-test` skill** — `await window.mechTest()`. All checks must pass; it asserts the orbit
   gate, pick deferral, split health and the shield-is-an-ability law.
2. **The card actually appears.** With the owning spec, confirm `tierChoices(prog, 2)` can offer it at
   the intended tier:

   ```js
   window.freshRun(0);           // 0 brawler, 1 hauler, 2 scout
   window.tick(1);
   game.prog.tier = 2;           // or whatever floor you're testing
   config.tierChoices(game.prog, 8).map(a => a.id);
   ```

3. **It isn't a dead card.** Own it at rank 1 and confirm something measurably changes — a `st.*`
   value, or the mechanic firing. If nothing does without a second ability, it needs `needs`.
4. **The ladder finishes.** Set `game.autoUpgrade = true`, pump `game.prog.xp`, and confirm the ability
   reaches `max` by tier 5 rather than ending mid-climb. If the catalog grew a lot, `ABIL_XP_TOTAL`
   moves with the climb TOTAL (currently 6900 against a 7875 climb).
5. **`balance-test` skill** if the ability touches damage, mass, throw speed or enemy interaction.

Then have the **`progression-auditor`** subagent review the diff.
