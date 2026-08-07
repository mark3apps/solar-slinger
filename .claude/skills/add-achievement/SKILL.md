---
name: add-achievement
description: Add an achievement row to Solar Slinger's catalog and prove it isn't a frame-one freebie. Use when asked to add achievements, a new category of feats, or to fix an achievement that unlocks immediately or never unlocks.
---

# Adding an achievement

An achievement is **one catalog row** in [src/achievements.js](../../../src/achievements.js). The panel
is a schematic driven by `data-note`, so adding a row needs **nothing in hud.js**.

Full rationale: [docs/progression.md](../../../docs/progression.md).

## 1. Write the row

```js
A('firstSmash', 'combat', PTS.easy, 'Demolition Debut',
  'Destroy something with a thrown rock.',
  (g) => g.prog.smashes >= 1),
```

`A(id, cat, pts, name, desc, test)`.

- **`cat`** — `first` / `haul` / `combat` / `flight` / `peril` / `explore` / `build` / `silly` /
  `insane` / `secret`. Category order is panel order.
- **`pts`** — from `PTS`: `trivial` 5, `easy` 10, `normal` 20, `tricky` 35, `hard` 60, `brutal` 100,
  `insane` 200. Points also pay XP at `PROG.XP_PER_ACH_POINT` (0.6), banked in `main.drainAchievements`.
- **`secret`** rows are REDACTED until earned — name and description both, though the points still show,
  so a classified row is visibly worth chasing. Every other locked row reads in full: a readable locked
  achievement is a to-do list, which is the point.

## 2. The predicate contract

`test(game, s, c)` is a **PURE READ**, evaluated every frame for every row not yet earned.

- **No loops. No allocation. No mutation.** Anything needing a scan is computed once into the shared
  context `c` by the sweep. The one sanctioned loop is the orbit-mass sum, and only because
  `st.maxOrbiters` caps it — at **14** since the Orbital Sling ladder doubled; read the length from
`config.ORBIT_SLOTS`, never a literal.
- `s` is the ledger — every counter reads as undefined-or-number, so bare `>=` is safe without guards.
- The measured budget is **0.02 ms per sweep across all ~385 rows** (0.1% of a 60 fps frame). Keep it.

## 3. Feed it from something that already exists

**Only add a new instrument if nothing already records the event.** Check, in order:

1. An existing counter in `s` (`window.game.prog.ach.stats` after a soak lists them all).
2. `noteCatch` / `noteKill` / `noteDeath` — they classify the three richest events in one call each.
   Adding a bucket there is usually better than a `bump` at the call site.
3. `ACH_EVENT_STATS` — several discovery rows ride the existing `EVENT_MSGS` one-shot flags through
   main's drain rather than instrumenting `world.js` a second time.
4. The integrated streaks inside the sweep itself (heat / oort / gas / skim / coast / spin / no-damage)
   ride flags that already exist, so the hot path never grew a line for them.

Only then reach for `bump` / `best` / `least` / `mark`. They are null-safe, so they're callable from
splash frames and headless soaks where no ledger exists.

**If your row times a streak, `noteDeath` must end it.** Without that, "ten minutes untouched" survives
being blown up, and a dive that ended at a gas giant's core scores as one you climbed out of.

## 4. Prove it isn't a freebie — this is the failure mode of the whole feature

A predicate true on frame one is a bug. **Five have shipped and been caught:**

| Freebie | Cause |
|---|---|
| SCOUT *Maxed Out* instantly | counted max-1 unlocks as "maxed" (Retro Jets is in its kit). History now that every ability is six ranks — but `achievements.js` keeps the guard |
| every run got 99 free seconds "untouched" | `game.lastDamage` starts at `-99` |
| "own four abilities" landed instantly | the BRAWLER and SCOUT kits ARE four — **count rows must sit at 5+** |
| "unlock the Deflector" free for BRAWLER | it starts with it — **kit abilities need a RANK threshold, not an unlock one** |
| "tier 2 with no picks taken" unreachable | a tier-up spends a pick and increments `prog.level` |

**Run this for all three specs. Anything other than *Specialist* landing on frame one is a freebie:**

```js
for (const i of [0, 1, 2]) {
  window.freshRun(i);
  window.tick(1);
  console.log(i, game.prog.ach.order);   // expect ['firstSpec'] only
}
```

Then prove it's *reachable*: soak and confirm the counter your predicate reads actually moves.

```js
window.freshRun(0);
window.soak(300);
game.prog.ach.stats;                     // is your counter climbing?
game.prog.ach.order;                     // did the row land?
```

An unearnable row is worse than a short list — two rogue-planet rows were retired for exactly that
reason when rogues were removed.

## 5. Rules the row must not break

- **Run-scoped, never persisted.** The ledger lives on `prog` and dies with it; nothing goes to
  localStorage. A lifetime tally makes an achievement a thing you grind once and never see again.
- **`config.js` must never import `achievements.js`** — achievements imports config, and config is a leaf.
- **Points are shown; XP is NEVER shown** — not on the toast, not in the panel. That is a user call:
  raw XP is an abstracted number the player reads nowhere else in the game.
- **Toasts have their own rail, never `hud.message`** — the single `#msg` slot belongs to the sim
  warning you about the world, and a score notification must not overwrite a hazard warning.
- Sound follows the existing grammar: `sfxTierUp` for a 60+ row, `sfxUpgrade` otherwise.
- `award` in achievements.js stays a **pure read** — the game reacts in `main.drainAchievements`.

## 6. Close out

Run the **`mechanics-test`** skill (the catalog is on the hot path, so a broken predicate can throw
inside the sweep), and have the **`progression-auditor`** subagent review the diff.
