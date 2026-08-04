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
   **It is now BOUNDED BY CONSTRUCTION, in `world.moonZone`.** The zone a planet holds moons in is a
   multiple of its HILL radius and Hill grows with `orbitR`, so the widest families in the sky are the
   outer band's — exactly where there is least room left before the edge. Checking that by hand every
   time the layout moved had quietly stopped working: measured on the pre-2026-08 sky, the outermost
   world's single moon reached ~48,500 against a `WORLD_R` of 46,000, and widening the zone would have
   taken that past 6,000 over. The clamp is `(WORLD_R - orbitR) / (1 + MOON_E_MAX)` — the ellipse
   reaches `a*(1+e)`, so it is the APOAPSIS the boundary has to leave room for, not the semi-major
   axis, and `MOON_E_MAX` is shared with `spawnMoon`'s `eCap` precisely so the two cannot drift apart.
   Same idiom as `CRUST_PER_HOST` and `GAS_STRIP_EJECTA`: bound it by construction, not by hoping.
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

## Landmark rock collides as a shape, not as a bearing (added 2026-08)

**Two `bigShape` rocks get CONVEX-HULL SAT** (`rockshape.rockContacts`, against the baked
decomposition in `rockdata.js`), not the single-bearing surface test every other shaped pair uses.

> Superseded 2026-08: this invariant originally described a multi-sample radial probe
> (`physics.bigPenetration`, now deleted). The measurements below were taken against that probe and
> are kept because they are what motivated the whole narrow phase — but the mechanism is now SAT.
> A radial probe can find a deep contact; what it cannot do is produce a true minimum-translation
> vector, because its depth comes from the deepest sample while its direction comes from a separately
> looked-up face normal, and the two disagree by however far along a face the contact landed. Resting
> pairs therefore never resolved and pockets accumulated interpenetration for as long as they were
> played in. SAT returns depth and axis as one measurement, which is the entire argument for it.
> See [rock-fracture.md](rock-fracture.md).

The ordinary shaped narrow phase measures each surface along the line joining the two centres. That
is exact for a circle and close enough for a pebble against a slab — the pebble's whole silhouette
sits within a degree or two of that line. For two 200–400 unit ANGULAR rocks it is simply the wrong
test: a corner can be buried deep in a neighbour's flank while the centre line passes through a notch
in one and a waist in the other, and the pair reports no contact at all. **Measured on seed 20260721,
a freshly generated pocket at rest: of 801 candidate pairs the centre-line test found 90 contacts and
the probe found 144 — 54 real overlaps, 37% of the total, were invisible to the collider, the worst
buried 87 units deep.**

**What ships is convex-hull SAT**, not that radial probe. Every baked shape carries a convex
decomposition (`rockdata.js`); `rockshape.rockContacts` transforms both bodies' hulls to world space,
rejects most of the hull pairs on a bounding circle, and runs SAT on what survives — so the depth and
the axis come out of ONE measurement, which is the entire argument for it. Face clipping turns each
surviving pair into a real contact manifold of up to two points, because a single point lets a
resting slab satisfy the constraint and still rock about it forever.

(History: this was `physics.bigPenetration`, a multi-sample radial probe over each rock's own surface
through the arc facing the other — no vertex lists, no winding. It was deleted in `2f5162c`. Its
weakness is the paragraph above: a probe can find a deep contact but cannot produce a true MTV.)

Three things follow, and each one is load-bearing:

- **The SAT overlap is a DEPTH, not a radial sum**, so it takes no centre-line cosine projection.
  Discounting it as well would under-separate exactly the off-axis contacts SAT exists to resolve,
  and two landmarks would settle interpenetrated and jitter there.
- **`rockContacts` must RETURN every overlapping hull pair's manifold — and `collideBodies` resolves
  only the deepest one per substep.** Those are two different rules and both are load-bearing. A
  decomposed body has no single separating vector (two gnarled rocks can catch on a corner AND rest
  on a face at once), so collapsing the list *inside* `rockContacts` throws away the information —
  resolving only the deepest of a collapsed set left 46% of overlapping pairs still overlapping, and
  `tools/test-rockshape.mjs` iterates the whole list to prove convergence. But applying all four
  impulses to one pair in one substep is how a contact turns into a launch, so the resolver takes
  `cs[0]` and relies on 120 Hz iteration instead: measured, 98% of realistic overlaps clear in one
  push and the rest in two.
- **The contact normal is NOT re-derived from the centre line.** SAT already orients it from a toward
  b, and a corner catch legitimately points back across that line. Re-deriving it is what made
  contacts read as skating sideways down a slab.
- **Landmark contacts carry tangential friction and the spin it implies**
  (`physics.applyBigFriction`, `CFG.FIELD_BIG_FRICTION` / `FIELD_BIG_SPIN`). Nothing else in the file
  has a tangential term — without one, two slabs meeting corner-to-face exchange no sideways force
  and neither one turns, so they slide across each other and part still tumbling at exactly the rate
  they were seeded with. Coulomb-clamped to the slip so friction can never reverse the slide; the
  moment of inertia is the uniform disc's, because these are explicitly rubble piles and anything
  tighter would be false precision. **Scoped to `bigShape` pairs** — Coulomb friction on every pebble
  in the sky is a much larger change to a long-tuned resolver.
- **Two railed rocks of the same pocket skip the whole thing** (see below). They must, or the probe
  finding 144 resting overlaps would turn into 144 pointless resolutions per substep.

### ...and a ROUND party gets the exact circle query, not a bearing (added 2026-08, issue #102)

**The ship, an alien and a pebble collide with a landmark through `rockshape.rockCircleQuery`** — the
signed distance from their centre to the DRAWN outline, its outward normal and the closest point, all
out of one closest-point walk. Same argument as SAT, applied to the other half of the collision
matrix: depth, direction and contact location are the same measurement.

**A single radius per bearing is NOT a surface here, and treating it as one was a real bug.**
`rockshape.rockSurfAt` marches the outline and takes the OUTERMOST crossing, which is the surface only
while the outline is a radial function r(θ). `util.rockOutline` is one by construction — the design
law is explicit that an overhang would break the single radial query — but the bake does not stop at
`rockOutline`: a child is CUT from its parent and lands with its own centroid, and a cut can put a
concave bite between that centroid and the far wall. Measured at 1440 bearings over the baked library:
**17 of the 68 shapes have multi-crossing bearings**, worst radial gap **1.40 body radii** (`s2_34`);
`m2_31` is multi-crossing over **6.7%** of its circumference. **None of the 5 roots is affected** —
every offender is a cut child. While `physics.surfRadius` fed that far-wall radius to ship-, alien-
and pebble-vs-landmark contact, the ship stopped and bounced *in open space* at a visible notch: one
landmark had two disagreeing narrow phases, because landmark-vs-landmark went through `rockContacts`
and respected the notch while nothing else did. It contradicted the crumble law directly.

Three rules follow:

- **The query runs on `v`, the drawn outline — not `hulls`.** With a circle on one side there is no
  decomposition to need, and agreeing with the picture is the entire point (measured agreement ~1e-12
  body radii, against `render.js`'s own 0.8%-of-radius wobble budget).
- **Its depth takes no centre-line projection**, for exactly the reason the SAT depth doesn't.
- **`surfRadius`'s `bigShape` branch is a fallback now, not the collider.** What still reaches it is
  the case with no circle on either side — a landmark against a crystal world's shard polygon or a
  cratered limb — where both profiles are radial by construction anyway. Don't hand it a new collider.

`window.mechTest`'s *shaped rock: collider agrees with the drawn outline* is the guard: every baked
shape, both placements, boundary flip plus a probe inside every concavity.

## Railed conjunctions pass through (added 2026-08)

**Two RAILED natural celestials touching below `DMG_THRESH` do not collide at all** — no derail, no
separation, no impulse (`physics.collideBodies`, guarded right after `closing` is computed).

**The same rule covers a shoal's own masonry, and it sits ABOVE the narrow phase rather than below
it.** A pocket shares one angular rate (`world.seedDenseFields`'s `w`, re-applied by the reknit and
by the settle re-rail), so two rocks both still on that rail have exactly zero relative motion —
there is no collision to resolve, now or ever. And they genuinely do interlock: the packer spaces
landmarks by their circle radii while a shaped rock's corners reach past that
(`rockshape.shapeReach`), so a freshly generated pocket has its masonry keyed together at the corners
on purpose.
Without the guard the resolver would push all 144 resting overlaps apart every substep and the rail
advance would snap them back on the next — the judder described below, on a hundred rocks at once,
plus the shaped narrow phase paid on every one of them for nothing. A knock derails, and a derailed
rock collides normally again.

Moon families deliberately reach past Hill stability (`world.moonZone`, `maxR = hill *
CFG.MOON_ZONE_MUL`) so systems stay wide, which means **neighbouring planets' families overlap
radially** — 14 of 16 adjacent pairs, the worst by more than 20,000 units. Adjacent lanes run at
different angular speeds and therefore always reach conjunction, so those touches are a normal
recurring event. They were silently lethal: at closing 25–240 an impact does no damage and logs
nothing, but the `closing > 25` derail still fired, and a moon knocked out of its exact orbit falls
into whatever it is near — around a gas giant it was swallowed within seconds. Measured cost before
the fix: 4 swallowed + 7 absorbed moons per 600s idle soak, one planet left off-rail at −7.1% drift,
**with no player anywhere**. After: all `moon:absorbed` gone, every moon alive on every seed, zero
off-rail planets.

**Letting the families overlap is the user's design call** — moons stay far out, and a conjunction
must not unmake a charted world. The guard is deliberately narrow: both bodies railed, both natural
(`thrownTimer <= 0`), both planet/moon type, and below `DMG_THRESH`. Player and alien throws keep
every bit of their impulse, damage and derail, and a genuine celestial crunch above the threshold
resolves normally.

**THE ALL-PROGRADE SKY IS WHAT KEEPS THAT AFFORDABLE.** The guard is gated on `closing <
DMG_THRESH`, so how much overlap it can absorb depends entirely on how fast a conjunction closes.
One planet in six used to be drawn retrograde, and a retrograde lane meets each neighbour at the SUM
of their angular speeds rather than the difference — several times as many conjunctions, each at
roughly twice the closing speed, i.e. on the wrong side of the threshold this whole guard lives
below. `addPlanet` now fixes every sun-anchored planet prograde, which is what let the families be
widened (`MOON_ZONE_MUL` 1.5 → 1.95 on top of a 1.3x system scale, worst overlap 13,222 → 20,771)
with **no** moon or planet losses across 600s on all four bench seeds. **Returning before the separation/impulse is the point** — a railed body shoved by
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
  **MOSTLY REMOVED, 2026-08** (user call: "it kinda breaks things") — `DAMP` 1.2 → **0.3**. The damage
  was structural, not a matter of degree: the brake ramps with `t`, which is 0 at the band's edge and
  **1 at the surface**, so the assist was strongest exactly where the player is trying to arrive.
  Terminal descent is `g_surface / DAMP`; measured A/B in one session, an unpowered 400-unit fall at
  1.2 **never completed inside 60s** and at 0.3 lands in ~21s. The wider cost was the same everywhere:
  the band quietly cancelled the inward half of every approach, so a world's well never really felt
  like one however hard `PLANET_GRAV_SHIP` pulled. Kept rather than deleted — at zero, every near-miss
  is a hyperbolic slingshot and there is no capture arc left at all. **Note this constant is
  SHIP-ONLY, so the stability/combat suites are blind to it**: all four seeds diff clean across the
  change, and the evidence that it did anything is the descent A/B above, not the bench.
- **Surface friction** (`SURF_FRICTION`, added 2026-08): ship-only, CONTACT-only. Touching a planet or
  a moon drags the ship toward the velocity of the ground under it — `util.surfaceVel`, the body's own
  motion plus `spin x r` tangentially — at an exponential rate, so a skid matches the surface in
  ~0.7s and the ship can be landed at all. Before it, hull-vs-world contact was purely elastic and a
  graze skated across a planet at its arrival speed until the grind killed the ship.
  Four rules hold it in place, and each one guards something:
  - **Planets and moons only.** A rock is not a place you land on, and rock contact is long-tuned
    against every dense field in the game (invariants 3–5).
  - **It drags the WHOLE relative velocity, not just the tangential half.** The radial part cancels
    the gravity the ship keeps falling in with, so it settles against the resolver's push-out rather
    than chattering on it — that half is what makes a landing possible instead of a bounce. Residual
    drift is `g_surface / SURF_FRICTION`: under 1 u/s on a mid world, ~4 u/s at the deepest LONG ARMS
    amplification, i.e. far inside `DOCK_SPEED` either way.
  - **It never fights the bounce.** The kick is an impulse in the same substep and at 1/120s this
    rate removes 3.7% of a velocity, so a hard arrival still bounces exactly as invariants 3–5 tune
    it. Only a ship that STAYS down is slowed, and thrust wins easily (180 u/s² against 4.5/s is a
    40 u/s terminal), so a pad can never become flypaper.
  - **No reaction on the body, and NOTHING TO MIRROR in predictPaths.** Every body it can touch is
    >20x the ship's mass — invariant 4's immovable regime — and a torque on a world's spin from a
    ship scraping it is precisely the secular pump the rails exist to prevent. And unlike the rubber
    band and the long arms, which act at RANGE and so must be mirrored, this term exists only in
    contact and the forecast TERMINATES at contact (`shipHit`).
- **Docking** (`DOCK_*`, `physics.updateDock`): the landing this makes possible. Three gates —
  contact, nose within `DOCK_ARC` of straight up off the surface, surface-relative speed under
  `DOCK_SPEED` — held together for `DOCK_TIME`. The gates are read inside `collideShipBody` (the one
  place that knows the hull is touching something) into a module-level `landing` scratch, and
  RESOLVED once per substep in `updateDock` right after the ship/alien contact pass — because "the
  hull touched nothing" is a fact no per-body collider can observe. **Attitude and stillness are
  ENTRY gates; only contact holds a berth.** The latch timer drains `DOCK_DRAIN`x faster than it
  fills, which is the whole hysteresis (~0.17s of grace over a crater lip). The gates were WIDENED in
  2026-08 (arc 0.72 → 1.0 rad, speed 30 → 60, time 0.8 → 0.5s): the first pass was too fiddly to land
  with, and the interesting part of the feature is what a dock IS, not the approach window.
  `game.dockT` / `dockCand` / `dockGate` are published per substep for the approach guidance —
  a landing that silently declines to latch is the worst failure mode this has.
- **The berthed ship is HELD** (`DOCK_UPRIGHT`): the helm gives the nose to the surface normal and the
  mouse stops steering, so W always points straight off the pad and the launch needs no separate
  notion of "up". Aiming is untouched — the beam and every throw still go at the cursor.
- **THE CLAMPS ARE AN EXACT PIN, NOT A SPRING.** While berthed, `updateDock` sets the hull's position
  to `padPos` and its velocity to `surfaceVel` every substep, after the whole contact pass — so it
  wins over both the resolver's push-out and the friction. Surface friction alone CANNOT hold a berth:
  it is an exponential approach, and co-rotating with a spinning world needs a continuous centripetal
  term a velocity damper only ever supplies as a lag. The residual was a steady ~0.06 u/s creep of the
  hull across its own pad (reported as "the ship moves slightly faster than the base does") — visible
  as a berth sliding off its dock after a minute. Pinning is also what a clamp physically IS, so this
  is the honest model rather than a patch, and it costs nothing: the pad is by construction exactly
  where the hull was when the clamps bit. Measured 0.0000 drift over 30s across 2.3 rad of rotation.
- **The dome REPELS** (`updateDomeShield`, `CFG.DOCK_REPEL_MIN`): damage immunity alone is half a
  shield — without the push, rock and aliens still pile into the berth, and a hull sitting inside a
  heap of debris it happens to be invulnerable to reads as a bug rather than as protection. Reflects
  the inward component and then floors the outward one, so a slow drifter cannot sit on the boundary
  being re-solved every substep. **Geometry comes from `config.dockDomeR` — the same expression
  render draws**, which is why the tier table lives in config.js and not in render.js. **Scoped to
  loose asteroids and aliens**: never celestials (invariant 4 makes the heavy body immovable against
  something this small anyway, and a field nudging railed worlds would be a secular pump on the sky),
  never the host body, and never your own held or thrown rock — the beam outranks the dome.
- **Launch** (`LAUNCH_*`, `physics.updateLaunch`): thrust from a berth is zeroed and CALLS A RELEASE
  instead — clamps back over `LAUNCH_HOLD`, engine lighting against them to `LAUNCH_TIME`, then
  `LAUNCH_KICK` straight up. The ship is pinned to the pad's `surfaceVel` throughout (the sequence
  cannot be steered or shoved out of) and it commits once started. On release the latch timer is
  zeroed by hand, or the drain's grace window would hand the berth straight back while the hull is
  still inside the pad's contact.
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


## The gravity loop: the attractor shortlist (added 2026-08)

**Every loose body caches the attractors it is inside cull range of** (`physics.attShortlist`), and
re-derives that list every `ATT_STALE` seconds, staggered off `b.id`. Celestials are untouched — they
keep the full weighted walk, because invariant 2's symmetric pairs are defined over every attractor.

The influence cutoff (`GRAV_CULL_A`) already skipped negligible attractors, but `gravityAt` still
*visited* all ~130 to decide. Measured standing in a planet system: of 122 attractors, **4.8** clear
the cull at halo range and 1.9 out in the open lanes. A top-6 truncation is bit-exact, because fewer
than six ever qualify. Clean interleaved A/B at 3,000 loose chunks: **9.39ms → 6.17ms of sim per
frame, 1.52x**, and `perf[debris-heavy]` sim −37%.

**It is exact, not an approximation**, and two rules keep it that way. The **pad**: the build inflates
each cull radius by how far the pair could close before the next rebuild (the body's own speed plus
`ATT_CLOSE_V`), so nothing can enter range unseen. The **cull stays**: `gravityAt` still applies
`cullR2` to every member, so a padded-in attractor contributes nothing until it genuinely qualifies.
A shortlist can therefore only differ from the full walk by an attractor under `GRAV_CULL_A`, which
the cutoff already calls unobservable — so `predictPaths` needs no mirror. Four stability seeds over
600 sim-seconds: bit-identical.

Invalidation is a generation counter bumped whenever the attractor **count** moves, plus an explicit
bump in `generateWorld` — a regen usually rebuilds the *same* number of attractors (the layout table
is fixed), so the count check alone cannot see it.

## The broad phase: why it is still sweep-and-prune

**A uniform spatial grid was built here, measured, and reverted.** Do not re-derive the experiment.

The premise is real: on a clumped cascade — 2,000 chunks inside 150 units — sweep-and-prune visits
**233,328 candidate pairs a substep**, of which 26,838 pass the y-test and 21,287 actually touch. An
11x waste ratio. A uniform grid with the cell auto-sized to the population cut that to **51,981
pairs, 3.6x fewer**.

It still measured **0.977x on wall clock.** The sweep walks a contiguous, x-sorted, temporally
coherent array at roughly 2ns a visit; a grid pointer-chases through cell lists into a mostly-empty
table. The algorithmic win is cancelled exactly by locality. (The sort is NOT the cost — on the
persistent near-sorted list it measures 0.0ms even with thousands awake.)

Three pathologies were found and fixed on the way, and they are the reason this is written down:
sizing the grid to the bodies' bounding box let one flung rock collapse the whole blob into a single
clamped edge cell (**378ms a frame**, a 35x regression); walking each big body's footprint in
debris-sized cells is quadratic in `bigRadius / cell` (a 700-unit planet spans 6,084 cells); and a
body migrating between grid and sweep must be evicted explicitly, or the membership counts disagree
every substep and force a full random-order re-sort. Even with all three fixed, the answer was a
wash. **The lever for a big cascade is fewer bodies, not a different search.**

## Halo packing: a world you left keeps its wounds, not its bodies

`physics.packHalos`, run once a frame at the top of `updateFieldLOD` (before the registries clear —
it reads `reg.crust`). A settled rubble halo whose host is beyond `HALO_PACK_R x wakeR` collapses
into a plain record on the host and re-expands inside `HALO_UNPACK_R` (different radii, or a world on
the boundary would thrash). Every piece returns with its own **id** — so the sprite archetype, seeded
off `b.id`, is the same stone — plus radius, mass, hp, material, scars and rail phase. Measured
round-trip: 29 packed, 29 restored, every field identical.

**Why it matters:** the LOD already stopped *simulating* off-view rubble, but the pieces still held
slots in `reg.nonField`, which IS `CFG.DEBRIS_BUDGET`. Work over a few worlds and the budget that is
supposed to bound the chaos *around you* instead bounds how much damage you have *ever done*.
Measured: 62–65 budget slots returned per abandoned halo.

Two scoping rules: **held or thrown disqualifies the whole host's halo** (never collapse what the
player is acting on), and **field rock is never packed** — a shoal giant calves crust that keeps its
`b.field`, and that rock answers to the pocket's ceilings, not the debris budget. A piece that
re-railed around the **star** rather than its host is packed as loose (position and velocity
round-trip exactly) — restoring a 3,474-unit star rail against a 258-unit crust band would teleport
it across the system.

## The sweep side-table: the fix was layout, not algorithm (added 2026-08)

The scan reads four fields per candidate — `x`, `y`, `_bp`, `alive`. Those four now live in parallel
`Float64Array`/`Uint8Array` side-tables filled once per substep in sweep order, and the scan touches
nothing else (`THE SWEEP SIDE-TABLE` in physics.js).

**Why, in one number: a candidate visit cost 44.8ns.** Five property loads and three compares —
work that should cost 2-3ns. That ~15-20x gap is cache misses: a `Body` carries ~50 fields, and two
bodies adjacent in the x-sorted sweep are nowhere near each other in the heap, so every visit drags a
cache line to read three floats off a cold object. For scale, the same profile put an actual
**collision** at 261ns — a visit that does almost nothing was costing a sixth of real contact
resolution.

Measured, same shoal cascade, spans aligned:

| | before | after |
|---|---|---|
| collision block | 0.858 ms/frame | **0.500** (−42%) |
| scan only | 0.703 | **0.329** (−53%) |
| ns per candidate visit | 44.8 | **20.9** (2.1x) |
| visits / collide pairs per frame | 15,699 / 594 | 15,785 / 598 (unchanged) |

Identical visit and pair counts: this changed how the data is *reached*, not what is searched. It is
also the retrospective explanation for why the uniform grid failed — the grid cut visits 3.6x but
every grid visit chases the same cold pointers, so it hit the identical 45ns wall.

**THE WRITE-BACK IS LOAD-BEARING.** `collideBodies` separates bodies and can kill them, and the
original loop re-read `a.x`, `b.x`, `b.y` and `b.alive` FRESH every iteration — so a body shoved by an
earlier contact was seen at its new position by later tests in the same scan. The table is therefore
written back after every collision that lands, **including the left edge**, or the break test runs on
stale extents. This is deliberately not "cleaned up" into a snapshot: the sim is tuned against the
live-read behaviour, and all four stability seeds detect the difference. With the write-back, 600
sim-seconds x 4 seeds are bit-identical.

`_bp` is stamped once per substep at the top of `step()`, so `swR` alone never needs writing back.
Float64 rather than Float32 on purpose — world coordinates reach ~1e5, and the scan's compares must
agree with the f64 arithmetic `collideBodies` does, or a pair could be pruned here and overlapping
there.

**What this leaves.** The per-frame LOD classification walk is now the largest single phase
(~0.38 ms/frame over ~3,800 bodies). Ablation could not isolate a dominant sub-cost inside it —
rail advance ~10%, `regPush` ~2%, the rest diffuse — because it is the same problem: ~3,800 cold
object reads. Staggering the classification would skip only a minority of that; the registries are
consumed the same frame and dormant rail advance is those bodies' only motion, so neither can be
staggered. **The LOD walk wants the body model in typed arrays, not a cheaper schedule.**

## The swept pre-test: a fast rock no longer passes through you (added 2026-08)

`collideShipBody` and `collideAlienBody` were pure OVERLAP tests at one instant, so a projectile that
crossed the hull between two samples was never seen. `physics.sweptContact` adds a segment-vs-disc
test on the RELATIVE displacement over the substep, and places the body where it actually touched so
the normal, the overlap and the impulse all read a genuine contact.

Measured, 220 randomized trials per cell (impact parameter and sample phase both randomized),
fraction of impacts that register against the ship:

|  | 400 | 800 | 1300 | 1800 | 2500 |
|---|---|---|---|---|---|
| 1/120 overlap only | 100% | 100% | 100% | 94% | **76%** |
| 1/60 overlap only | 100% | 97% | 71% | 57% | **48%** |
| **1/120 swept** | 100% | 100% | 100% | 100% | **100%** |
| **1/60 swept** | 100% | 100% | 100% | 100% | **100%** |

This was a live bug at the DEFAULT step, not only a coarse-step one — a quarter of the fastest
impacts were being missed at 1/120. It also **re-armed `CFG.PACE_COARSE_ENABLED`**, which had been
disarmed precisely because 1/60 could not survive the overlap-only narrow phase; 1/60 with the
pre-test now detects everything 1/120 without it was missing.

**Scoped deliberately.** Ship and aliens only — tunnelling between two rocks is off-view and
cosmetic, and a swept test per candidate pair in the ~3,700-body sweep would cost far more than the
misses are worth. The `seg2 > rr*rr` gate confines it to pairs that moved further than their contact
radius in one substep, so celestials (rr ~700 would need 84,000 u/s) never enter it and their
gas-dive / star-plunge / crater branches are untouched. `shaped` bodies are excluded: their contact
radius is bearing-dependent, so one segment-vs-disc test does not describe them.

### Two traps when re-measuring this table

Both cost real time; the harness is only meaningful if it can reproduce the old numbers on demand
(`physics.forceSweptOff(true)` does that).

1. **Count DETECTIONS (`physics.shipContacts`), never deflection.** Invariant 4 makes a 400-mass rock
   immovable against a 10-mass ship, so a landed hit barely moves the projectile — a deflection-based
   harness reads near-0% everywhere and looks like total failure.
2. **Park the test ship well inside `WORLD_R` (46,000).** Outside it the boundary force runs to
   ~37,750 u/s²; any ship-velocity signal then reads 100% on every trial, swept test or not.

## GRAVEL: small debris lives in typed arrays (added 2026-08)

[gravel.js](../src/gravel.js) is a structure-of-arrays store for rock that is numerous and
individually anonymous. Not a new kind of rock — **the same rock in a cheaper representation**, which
is what makes the design law survivable.

**Why, in one number.** A collision-scan candidate visit cost 44.8ns against an arithmetic cost of
2-3ns; the gap is cache misses on ~50-field `Body` objects scattered through the heap. Moving four
fields into typed arrays halved it (THE SWEEP SIDE-TABLE). The same shape measured **4.2x on the
integration loop** and 15x on a pure kernel. A side-table only pays where a body is read many times
a frame; integration touches each once, so the data has to LIVE in the arrays — hence a store.

**PROMOTION IS THE CONTRACT.** `physics.promoteGravel`, called from `tractor.pickTarget` and nowhere
else — the one point where the beam has committed to a target. Position, velocity, spin, mass, hp,
material and the remaining inert window all transfer. Promoting in the hover-ring pass instead would
mint a `Body` for every grain the cursor sweeps past. Verified end to end: a grain under the cursor
promotes and ends up `heldBy === 'player'` with mass, radius and position intact; a grain out of
range is untouched.

**What gravel deliberately does NOT do**, each an accepted cost rather than an omission:

- **Grains do not damage each other.** They carom (see "Grain-on-grain contact" below) but a grain-on-
  grain hit produces no damage, no scars, no credit and no splitting — everything that makes a
  collision an EVENT belongs to `Body`. That is what keeps the O(n²) tail off the cascade while still
  letting a pocket behave like one.
- **Grains do not damage celestials.** A grain carries ~90-200 mass against a planet's 1e5+; mass
  dominance already throttled that to nothing, and thousands of `damageBody` calls would reinstate
  the cascade the debris budget exists to bound.
- **Ship contact damage is capped hard (12).** A cascade can put hundreds of grains through the hull
  in a second, and an uncapped per-grain bite makes standing in your own debris cloud lethal in a way
  no single visible event explains.

**Where grains come from today: the OVERFLOW.** The chunk spray in `damageBody` clamped its yield to
`debrisRoom`, so a hard hit late in a cascade silently produced less wreckage than the same hit at
the start. That difference is now minted as gravel. The change is purely additive — no existing
`Body` spawn was converted — so XP, credit and achievement semantics are untouched, and
`CFG.DEBRIS_BUDGET` goes back to bounding what the SIM carries rather than what the player is
allowed to see.

**Five things now die with a world regen** (`world.generateWorld`): the awake list, the frame
registries, the attractor shortlists, the packed halos, and the gravel store. Every one of them
holds state that outlives its world otherwise; this is the recurring bug in that neighbourhood.

`GRAVEL_R_MAX` (14) is pinned to the shard atlas's own bucket ceiling — a grain past it has no baked
sprite and could not draw. Keep the two numbers together.

## The gravel sim runs on another core (added 2026-08)

[gravel-worker.js](../src/gravel-worker.js) advances every grain — gravity, the world edge, the inert
timer, the integrate — on a worker thread, over the same `SharedArrayBuffer` the store lives in.
`physics.gravelDispatch` posts the work at the TOP of the substep and `gravelJoin` collects it at the
bottom, so it overlaps the rails scan, both gravity phases, the Body integrate and the collision
sweep rather than adding to them.

**Why gravel and nothing else.** It is the only part of the sim that satisfies both conditions: its
state is in typed arrays rather than an object graph, and its update is a pure function of
(grain state, attractor snapshot, dt) touching no `game` object, no DOM and no canvas. Contact is
NOT off-thread — gravel-vs-ship/alien/celestial reads live game state and can damage the ship, so
`collideGravel` stays on the main thread.

**COOP/COEP is the precondition** and all three hosts must send it: `serve.py`, the Electron shell's
`app://` handler, and the `run-solar-slinger` driver. Miss one and `SharedArrayBuffer` is undefined
there and only there — every headless measurement would silently time the main-thread fallback while
the real game ran the worker. Verified: cross-origin isolation on, and the music beds still load
(8MB fetch, 405s track) — everything this page loads is same-origin, so `require-corp` costs nothing.

**THE MAIN THREAD MUST NOT `Atomics.wait`.** It throws there by design — blocking the UI thread is
what it exists to prevent. So the worker blocks (parked in `wait`, costing nothing) and the join
SPINS. That is only affordable because of the asymmetry it is built on: ~2ms of gravel dispatched
into a substep that then spends ~25ms on Body physics, so the spin is normally zero iterations. It is
bounded anyway, and falling past the bound latches `workerDead` and reverts to the inline pass —
a capability that can hang is not a capability.

**The worker mirrors `physics.stepGravel` exactly**, and must keep doing so: the fallback path runs
the main-thread version, and the game may not behave differently depending on which one ran. Same
mirror rule `predictPaths` lives under.

**Fixed capacity, not growth.** `MAX_SLOTS` is allocated once (~3.9MB) because reallocating would
leave the worker holding views onto a dead buffer. `spawn` returns -1 when full rather than growing.

### Grain-on-grain contact — and why a grid works here when it failed for bodies

Grains now carom off each other, resolved on the worker by a uniform hash grid. **This is not a
reversal of "the broad phase is still sweep-and-prune"** — read that note's reasoning, not its
headline. The grid failed for bodies because every visit chased a pointer into a ~50-field object
scattered through the heap; the algorithmic win was cancelled by locality. None of that is true here:
grains live in contiguous typed arrays, they are all small, and their sizes sit within one bucket of
each other — the exact population a uniform grid is built for. It also runs off the frame budget.

**The cell never clamps.** Sizing to a bounding box and clamping outliers into edge cells was the 35x
regression documented above. The cell OPENS UP instead — a bigger cell costs candidate efficiency and
nothing else, so the grid always covers the full span and no clamping happens at all.

Resolution is deliberately plain: equal-and-opposite impulse plus mass-split positional separation,
`e = 0.45`. No damage, no scars, no credit, no splitting — everything that makes a collision an EVENT
belongs to `Body`. This only has to make a pocket carom.

**Why it had to exist before field rock can ever be gravel.** "FIELD ROCK caroms. Its whole point is
that a shoal plays like a pinball table" (physics.js). Gravel without self-collision would have
deleted that outright, so grain contact is the GATE on the field-rock migration, not an optimisation
alongside it.

**IT LIVES IN A SHARED MODULE, and that is not a tidiness choice.** `gravel-contact.js` is called by
BOTH the worker and `physics.stepGravel`. It was originally implemented only inside the worker, which
meant a host without `SharedArrayBuffer` — no cross-origin isolation, a worker that failed to start —
played a game where debris did not carom. **A capability may change how fast something runs; it may
never change what the simulation does.** If you add a rule to grain contact, it lands in both paths
automatically; if you ever split them again, you have reintroduced that bug.
