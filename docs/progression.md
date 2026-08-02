# Progression — specs, abilities, XP, achievements, lives

> Deep reference. Read before editing `config.js` (`SPECS`/`ABILITIES`/`PROG`/`shipStats`),
> `achievements.js`, or any XP award site. The `add-ability` and `add-achievement` skills wrap the
> two most common tasks here.

- **Roguelite progression is SPECIALIZATION-based.** There is NO passive leveling. The run OPENS on a
  choice of one of three **specs** (`SPECS` in config.js — BRAWLER / HAULER / SCOUT; `main.openSpec`
  from `startGame`). `applySpec` locks `prog.spec` and grants that spec's **starting-kit**
  abilities at rank 1. The old **kit rule** (at least three rankable rows, so the ability bars —
  the minute-one feedback — actually climb while the first card is still minutes out) is satisfied
  by construction now that EVERY ability is six ranks: a kit is three or four climbing bars.
  The spec choice is FREE — it spends no XP, no level, and no tier slot, so the
  XP bar starts empty (a paid opener read as "it skipped my first upgrade").
- **Named abilities, spec-scoped, one currency.** `ABILITIES` (config.js) is the whole catalog: each
  entry has an OWNER `spec`, `max` ranks, a `weight`, and a **`minTier` soft floor** (it can't be
  OFFERED until you reach that tier — capstones sit at 3).
  **EVERY ABILITY IS SIX RANKS** (user design rule). The catalog used to run 1/3/4/6, which was three
  different kinds of card wearing one name: a max-1 row arrived already maxed (its bar was decoration),
  and a 3-rank row finished half a run before a 6-rank one. One length means one promise. The price is
  paid in `shipStats`, and paying it is mandatory: a row that reached its ceiling in 3 ranks now takes
  6, so its **per-rank step was HALVED** (4-rank rows ×2/3) and every ceiling is unchanged — ranks got
  finer, not stronger. Where a channel is shared by tracks that were different lengths, the fix is the
  row's optional **`chMul`** (a rank counts as less than 1 toward its channel) rather than the channel
  coefficient, which would nerf the other spec: HAULER's Reinforced Hull carries `chMul: 2/3` so its
  deliberately-shorter hull track still sums to the 4 it always did against BRAWLER's 6. The five
  former unlocks (Retro Jets, Gravity Compass, Impact Warning, Twin Grip, Slipstream) were the real
  work — rank 1 does exactly what the unlock did, and ranks 2-6 deepen it (braking authority, a lower
  compass sensing floor, forecast horizon, a steadier twin rig, warp distance/cooldown) — because a
  rank that changes nothing is the failure mode this whole system exists to avoid. An optional **`also: { specId: minTier }`**
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
    at the same instant, so their pools stay equal forever and only the cost ladder separates them.
    **Kit rows do NOT take their ladder scale from the id hash** (`config.ladderScale`): they are
    SPACED EVENLY across the `ABIL_XP_SPREAD` band by their position in the kit, so a kit's authored
    ORDER is its rank cadence (first listed ranks soonest) and reordering one re-times it. The hash
    still scales every ability learned from a CARD — those pools are never equal anyway. Spacing
    replaced searching when all six ranks landed: a kit now fires 15-20 rank-ups a run instead of
    9-13, and searching the constants could not separate them (best tightest-gap anywhere on the
    grid: 18 XP, against 52 before). `ABIL_XP_WOBBLE` (the per-rank nudge) was halved to 0.04 to stop
    eating the spacing, and must stay under ~0.108 regardless or a later rank can cost less than an
    earlier one. Tightest kit gap now 47 XP.
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
  consumers never needed touching. `totalLevel` = `min(25, tier*2 + round(rankSum*0.48))` — keep it in
  the 0–25 band, it still feeds enemy scaling (ai.js) and ship mass (physics.js). The weight moved with
  the six-rank pass (0.6 → 0.48) and had to: it is a POWER PROXY, power was deliberately held flat, but
  the rank COUNT it reads inflated ~1.4× — at 0.6 a mid-run tier-2 scout read as level 23 instead of 16
  and got tougher enemies and a heavier hull for a ship that had not changed. Re-fit it against the old
  trajectory at matched XP if track lengths ever move again.
- **Runtime abilities live outside config.** Most abilities are pure `shipStats` numbers, but each spec
  has real mechanics wired into the sim — keep the hook and the catalog row in sync:
  - BRAWLER — the ram is INNATE spec DNA: `st.ramMul`/`st.ramArmor` have a brawler-only base floor
    (config.shipStats) so it bonks from frame one, and Ram Prow (in the STARTING KIT, not Heavy
    Winch) / Juggernaut / Berserker deepen it in `physics.collideShipBody` (Berserker also scales
    `tractor.flingSpeedFor`); Cluster Rounds / Shockwave / Demolition in `physics.brawlerThrowKill`,
    called ONLY from `shatter`'s `'player-throw'` branch. **The blast has TWO RADII and they are not
    interchangeable:** `pushR` (`170 + 30 × shockwave`, 350 at max) keeps a long reach because the
    shove is the spectacle and costs the world nothing, while `dmgR` (`90 + 19 × demolition`, 204 at
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
    `tryGrab`/`springHeld`/`releaseHeld`/`addToOrbit` + a second beam in render; its RANKS steady the
    rig rather than adding a third hand — `st.twinHold` springs the flanking rock harder and
    `st.twinTug` shrinks the per-rock tug, which may only ever go DOWN, since the halved 75 exists to
    keep the COMBINED tug under the 150 the no-recoil law allows), Rockwall (orbit-held
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
    ticked in main.js); Slipstream (`main.onWarp`, `game.warpT`; distance/cooldown/i-frames come from
    `st.warpDist`/`warpCool`/`warpInvuln`, never literals, so its ranks mean something); Recon Drone
    (survey radius, world.js).
- **Controls the abilities add:** hold **Shift** = Afterburner (spends the BURN tank), tap **A / D** =
  Dash Jets (dart left/right), tap **F** = Slipstream. All no-op unless the ability is owned and off
  cooldown (Afterburner: unless the tank can light), and are gated behind `menuBlocking()` like every
  other player input.
- **ACHIEVEMENTS are a THIRD track, and they FEED the other two.** ~400 rows in
  [achievements.js](../src/achievements.js) grant **points** (`prog.ach.score`), and those points also
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
    Measured at 0.02 ms per sweep across the whole catalog — 0.1% of a 60 fps frame.
  - **Adding one is a catalog row.** Only reach for a new `bump` if nothing already records the event.
    Several discovery rows ride the existing `EVENT_MSGS` one-shot flags through `ACH_EVENT_STATS`
    (main's drain feeds them) rather than instrumenting world.js a second time; the heat/oort/gas/skim/
    coast/spin/no-damage streaks are integrated inside the sweep off flags that already exist, so the
    hot path never grew a line for them.
  - **Watch for freebies — this is the failure mode of the whole feature.** A predicate true on frame
    one is a bug, and five have been caught so far (the first is history now that no ability is
    max-1, but `achievements.js` keeps the guard that shut it): counting max-1 unlocks as "maxed" handed SCOUT
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
