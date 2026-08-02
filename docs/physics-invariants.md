# Physics invariants, rails, and the environmental hazard envelopes

> **DO NOT REGRESS.** Each numbered invariant below was a real bug that shredded the star systems
> within minutes. The rationale also lives in comments in [physics.js](../src/physics.js) and
> [config.js](../src/config.js) — read those before editing. The `physics-reviewer` subagent audits
> changes against this file; the `balance-test` skill proves the sky survives.

## Motion rules that pair with the invariants

- **The ship speed ceiling is RELATIVE to the local orbital flow** (`physics.orbitalFlow`): the ship's
  velocity is capped to within `maxSpeed` of the surrounding space's prograde circular velocity vector,
  not capped in absolute magnitude. The current carries the ship and the engine buys `maxSpeed` of
  deviation in any direction — with the spin you reach flow+maxSpeed, against it flow−maxSpeed (so out
  in the belt, where maxSpeed exceeds the flow, you can fly retrograde; near the sun the flow outruns
  maxSpeed and sweeps you prograde). Mirrored in predictPaths — keep in sync.
- **Sun-anchored orbits are slightly non-uniform:** `railBody` nudges each star-anchored body's angular
  speed by a deterministic ±~4% (hashed off `b.id`), so the sky isn't one rigid disc. Kept SUBTLE — a
  bigger spread lets same-radius rocks catch up and grind each other. Moons/installations stay exact.

## Physics invariants — DO NOT REGRESS

Each of these was a real bug that shredded the star systems within minutes. The rationale lives in
comments in [physics.js](../src/physics.js) / [config.js](../src/config.js) — read them before editing.

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
   stations/nests/gas giants) don't fail all-or-nothing — see **THE CRUMBLE** in the design laws for
   what a WORLD does with a hit; this invariant is the gating. Wear needs an IMPACT POINT (`hx/hy`):
   every impact path passes one, and the two continuous environmental sources (corona heat,
   atmosphere burn) pass none — at ~21 damage a substep against `CHUNK_DMG_MIN` 4 a world melting in
   the corona would otherwise shed its whole crust in a second. At HALF the
   `CHUNK_DMG_MIN`/`CHUNK_DMG_FRAC` gates a hit carves a crater; at the full gates it calves a slab
   and a shower of crumbs. A dying world (planet/moon/rogue, non-gas) comes apart into
   `CRUST_DEATH` (44–92) slow pieces that jostle apart, and any piece over `CHUNK_SPLIT_R` breaks
   again when IT dies — two or three levels, terminating. Pieces of worlds carry `b.chunk` (the
   crust-shard sprite, `render.drawChunkSprite`) and are built through `entities.makeChunk`.
   The gates are load-bearing: the damage floor keeps corona-heat drip from ever shedding,
   `config.crustMass` caps a piece at 45,000 — far under the 5e4 rail-disturber threshold — so
   nothing here can wake rail lanes, pieces spawn TOUCHING but never inside the parent's surface (a
   chunk born overlapping its parent takes collision damage and sheds again — feedback loop), and
   only a direct `'player-throw'` hit propagates player credit onto chunks (shard/Demolition chains
   stay bounded). **Every fragment system answers to ONE budget** — `physics.debrisRoom` /
   `CFG.DEBRIS_BUDGET`, counted over `reg.nonField`. They all used to compare `game.bodies.length`
   against ~450, written when a world held ~380 bodies; the dense fields put ~7,900 rocks in that
   array, so from the day the shoals landed chunk spray, spall, the death cloud and the BRAWLER's
   Cluster Rounds were ALL dead code and a damaged planet only ever grew decals. Shoal rock must
   never be able to starve the rest of the sim of fragments.
   (`physics.js damageBody`/`shatter`, `config.js CHUNK_*`/`CRUST_*`/`DEBRIS_BUDGET`)
7b. **A SPLIT MUST NOT CHAIN.** A world's rubble halo is as densely packed as a shoal, and every
   piece over `CHUNK_SPLIT_R` shatters into more pieces — so a chain through it both pays throw-kill
   XP per link AND manufactures more rock to chain into. One slab thrown through a halo ran that
   loop to the debris budget: hundreds of large bodies colliding, the frame rate gone, and a fresh
   run at tier 5 in seconds. THREE independent brakes, all load-bearing: a split propagates NO
   player credit to its children (the rule shard/Demolition damage already follows);
   `chainOk` treats `b.chunk` as dense rock, so `FIELD_CHAIN_MAX` caps the billiards mark exactly as
   it does inside a pocket; and fresh fragments carry `b.inertT` (`CFG.CHUNK_INERT`, 4s) during
   which they pass through OTHER DEBRIS — never through the ship, the aliens, or celestials, since
   those are what a player is aiming at and a slab ghosting through a planet reads as broken. The
   inert window also stops a death cloud, which is born inside the volume the world occupied, from
   resolving its own overlap by eating itself on frame one.
   **GAS EJECTA ARE EXEMPT FROM SPLITTING ENTIRELY** (`!body.gasEjecta` on the `CHUNK_SPLIT_R`
   branch). A gas giant's column is deliberately FEW AND BIG (`CFG.GAS_EJECTA`, see the eruption
   rules in [world-content.md](world-content.md)), which puts essentially every piece over the split
   threshold — measured 20 of 24 — so without the exemption a collapse's ~55 surviving pieces could
   be worked into thousands of bodies, reinstating the pebble cloud that sizing rule exists to
   delete. This matters MORE now that a collapse is deliberately allowed a big yield
   (~55 pieces, see world-content.md): the exemption is what makes that yield safe to grant. The
   collapse also carries its own hard ceiling on top of the shared budget (`GAS_STRIP_EJECTA`, the
   `b.stripEj` ledger), because its cadence tightens as the world fails and nothing else bounded the
   total; the ceiling is set above the tuned yield so it stays a backstop, not the mechanism.
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
9. **SO IS A MOON** — the rung between belt rock and a planet (`CFG.MOON_HP_BASE`/`MOON_HP_MUL`,
   same flat-base-plus-slope shape as the planet class, for the same mass-dominance reason). Moons
   shipped on the plain `massToHp` curve every pebble uses, which put an 8,000-mass moon at 96 hp —
   less than one solid throw, so a named, charted, permanent piece of the sky died to about the same
   effort as a boulder, and invariant 8's "rock chips a planet, MOON wounds it" had no rung of its
   own. Measured ladder on a 13k-mass moon: a 600-mass rock takes ~43 hits, a 2,500 boulder 3, a
   6,000 boulder one. It does NOT stop the ambient `absorbed` losses in a long soak — that rule is a
   mass ratio and never reads hp, so those are a rail/derail question, not a toughness one.

## Railed conjunctions pass through (added 2026-08)

**Two RAILED natural celestials touching below `DMG_THRESH` do not collide at all** — no derail, no
separation, no impulse (`physics.collideBodies`, guarded right after `closing` is computed).

Moon families deliberately reach past Hill stability (`world.moonZone`, `maxR = hill * 1.5`) so
systems stay wide, which means **neighbouring planets' families overlap radially** — 16 of 20
adjacent pairs on seed 3827467762, several by more than 8,000 units. Adjacent lanes run at different
angular speeds and therefore always reach conjunction, so those touches are a normal recurring event.
They were silently lethal: at closing 25–240 an impact does no damage and logs nothing, but the
`closing > 25` derail still fired, and a moon knocked out of its exact orbit falls into whatever it is
near — around a gas giant it was swallowed within seconds. Measured cost before the fix: 4 swallowed
+ 7 absorbed moons per 600s idle soak, one planet left off-rail at −7.1% drift, **with no player
anywhere**. After: all `moon:absorbed` gone, 48/48 moons on every seed, zero off-rail planets.

**Letting the families overlap is the user's design call** — moons stay far out, and a conjunction
must not unmake a charted world. The guard is deliberately narrow: both bodies railed, both natural
(`thrownTimer <= 0`), both planet/moon type, and below `DMG_THRESH`. Player and alien throws keep
every bit of their impulse, damage and derail, and a genuine celestial crunch above the threshold
resolves normally. **Returning before the separation/impulse is the point** — a railed body shoved by
contact resolution snaps back on its next rail advance and visibly vibrates, so a half-fix that only
skipped the derail would trade a dead moon for a juddering one.

Stations are deliberately NOT in the guard (they station-keep under thrust and must never wander); a
moon-vs-station brush can still derail, measured at about one event per 700s.

## Rails (the biggest architectural fact)

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

**A circular rail and an elliptical rail are DIFFERENT OBJECTS, and `rail.e > 0` is what tells them
apart.** A circular rail carries `r`/`w`/`ang` (plus physics's incremental rotor cache); an ellipse
carries `a`/`e`/`n`/`M`/`smin`. The physics rail advance and both `predictPaths` mirrors branch on
`rail.e > 0`, so a **degenerate `e === 0` ellipse is advanced as a circle**, reads the `r`/`w`/`ang`
it doesn't have, and is NaN on its very first substep — after which the tripwire culls it and a moon
has quietly vanished seconds into the run. `spawnMoon` legitimately clamps `e` to 0 whenever a
sibling slot is too tight to allow any radial excursion, so **`railEllipse` itself builds an honest
CIRCULAR rail when `e` isn't positive** (entities.js) rather than every consumer having to know. Keep
the guard at that one choke point; don't relax the branch tests to `!== undefined` instead — an
ellipse of zero eccentricity is a circle, and the sim should only ever hold one representation of it.


## Environmental envelopes and ship-only gravity rules

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

