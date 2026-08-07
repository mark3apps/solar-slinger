# Design laws (gameplay + visual)

> Deep reference. These are deliberate rules the user has set, not accidents — violating one is a
> regression even if the code "works". The `physics-reviewer` and `visual-language-reviewer`
> subagents audit changes against this file.

These are deliberate rules the user has set, not accidents. Violating them is a regression even if the
code "works."

- **Flinging has no recoil** that pushes the ship back. The tractor tug reaction is capped at 150 so the
  ship stays flyable, but throws must never shove the ship. (`tractor.js:197`)
- **A BIG ROCK DOES NOT HANDLE LIKE A PEBBLE, and the beam takes a grip rather than snapping to one**
  (user design law). `st.force` is a force and `tractor.springHeld` divides it by the load's mass, so
  authority already fell as `1/m` — but force scales with `capacity`, which meant the heaviest thing
  your beam could lift always swung with about the authority the heaviest thing it could lift a tier
  ago did, and a maxed hauler whipped a moon around exactly like a scout whips a pebble. Two
  multipliers on the acceleration cap fix that, both in `springHeld`:
  - **HEFT** (`CFG.TRACTOR_HEFT` 1.6): `1 / (1 + HEFT × heft²)` where `heft` is the load's mass as a
    fraction of your allowance. **Squared on purpose** — anything under half your allowance keeps
    ~90% of its authority, so the ordinary belt-rock loop is untouched and only the top of your class
    fights you (0.385× at a max-weight load).
  - **SPOOL-UP** (`CFG.TRACTOR_SPOOL` 3.2s, `TRACTOR_SPOOL_MIN` 0.4): a squared ramp over a window
    that scales with heft, so a pebble is at full strength in about a second and a moon takes the
    full 3.2s. `b.holdT` is reset at every grab and every retrieve from the ring, so letting go and
    re-grabbing to dodge the ramp costs you the ramp again.
  - **THE WIND-UP APPLIES TO THE THROW, NOT JUST THE HOLD** — `flingSpeedFor` reads the same
    `beamGrip` the hold does, scaled by heft (`speed × (1 - heft × (1 - spool))`). It has to: with
    the ramp on positioning alone, the hardest throw in the game was grab-and-release on the SAME
    FRAME, and letting go and re-grabbing handed you a fresh full-power throw every time — so
    spamming the beam beat holding it, which is the exact inversion of the law. Measured on an
    11,177 moon at 78% of allowance: 262 on an instant throw, 490 after 3s, and 262 again on a
    re-grab. Scaling by heft is what keeps the belt loop untouched (a pebble at ~0.97× on a
    same-frame throw). `b.holdT` is **null** for anything not in the beam — the ring, the rack, a
    rock in flight — and `beamGrip` exempts those, so a volley never winds up.

  **NEITHER applies to the orbit ring or the brawler's trail rack** (`tractor.updateOrbit` owns
  those, with its own caps): those are formations you have already paid for, and re-spooling every
  rock in a fourteen-slot ring on every capture would make the wall sag exactly when it is being shot
  at. The grip is VISIBLE — `game.heldGrip` feeds `render.drawBeam`, which draws a fresh or heavy
  hold thin, dim and fluttering and settles it as the emitters take hold; at grip 1 it is exactly the
  beam it always was. A mechanic the player cannot see reads as the beam being broken.
- **A MOON OR A WORLD MUST BE WINCHED BEFORE THE BEAM HAS IT AT ALL** (`config.latchTime` /
  `tractor.updateLatch`). **Nothing below the moon rungs winches** — belt rock takes hold on the
  click exactly as it always did, and the whole early game is untouched. Taking a world is an ACT,
  not a click.
  - **AND THAT IS A STATEMENT ABOUT THE WORLD, NOT ABOUT WHICH BUTTON WAS PRESSED.** The hauler's
    right-click stow winches too (`tractor.stowFromCursor` returns `'winching'` and hands off to the
    same `updateLatch`, on `game.stowEating` instead of the left button, drawn in the stow's green
    rather than the beam's cyan). It has to: the ring's class ladder is Sling Winch's own and
    deliberately reaches rungs the early beam cannot, so **the winch is the only thing standing
    between a tier-0 hauler and a pocketed moon**. Without it the held-button sweep re-armed every
    0.12s and dragging the cursor across a moon family pocketed five named moons in under a second,
    from a beam that could not lift a boulder. **One `game.latch`, so the two winches are mutually
    exclusive by construction** — a live stow winch makes `tryGrab` report `'winching'` (silently,
    and *not* `null`, which would fall through to the retrieve fallback and pull a rock back out of
    the ring the winch is filling).
  - **The winch is a BAND per class, and MASS positions you inside it** (`config.LATCH_BAND`):
    small moons **1.6–2.6s**, large moons **2.6–4.0s**, worlds **4.0–5.8s**. A flat per-class number
    said a 2,400-mass moon and a 17,000-mass one were the same job. The bands do not overlap, so the
    class ordering still holds absolutely: every small moon is quicker than every large moon, which
    is quicker than every world. Interpolation is **sqrt**, not linear — a world's band spans 33× in
    mass and read linearly every planet under ~150,000 would pin to the floor.
    (History: 1.1 / 1.8 / 2.9 flat → doubled at the top end to 1.6 / 3.6 / 5.8 flat → spread into
    bands over the same 1.6–5.8 envelope.)
  - **AT FULL POWER THE TETHER CANNOT BE BROKEN** (user design law). A hold that has fully closed
    does not let go because you flew away — past `CFG.TETHER_MAX_MUL` (1.3) × the beam ring (the ring
    `drawShipRings` already draws, so the limit is something the player can see) it goes **taut** and
    `tractor.springHeld` resolves it as a rope: take the separating velocity, split by MASS. Only
    death drops it; distance no longer can. The rope only ever REMOVES separating motion, so it
    cannot inject energy or become a slingshot. **This is not the no-recoil law being broken** — that
    law is about the RELEASE (a throw must never shove the ship); being dragged by something you are
    still holding is the opposite, and it is the point.
  - **IT IS A RUBBER BAND, NOT A WALL.** Arresting everything at one exact radius jolted — free one
    substep, stopped the next. The give lives INSIDE the stated ceiling rather than beyond it: the
    band starts biting at `(1 - CFG.TETHER_STRETCH)` × the limit and is fully taut at the limit, so
    "max ~1.3× the ring" stays literally true while a third of the way in is spent easing you to a
    stop. The fraction of separating velocity taken ramps **quadratically** across that stretch, so
    first contact takes almost nothing. A long soft zone costs nothing during ordinary holding: the
    band only ever acts on SEPARATING motion, and a tracked rock never separates.
  - **THE ROPE'S LENGTH IS STATE, NOT A CONSTANT** (`b.ropeL`). Full power routinely arrives with the
    rock ALREADY outside the limit — it lags during the wind-up, and a world's winch runs for seconds
    while you are flying. Sizing the rope at the limit on that first substep snapped the load across
    the whole gap in one frame (measured: a ~2,000-unit yank). The rope is seeded at whatever
    distance it engaged at and hauled in at `CFG.TETHER_REEL`, and the taut/backstop maths run
    against that LIVE length — never against the constant, or it is the instant snap again.
    Measured after the fix: worst single-substep jump **2.5 units**, reeling in at exactly 300 u/s
    from 3,000 down to the 921 limit.
  - **SHIP MASS IS PER-SPEC AS WELL AS PER-TIER** (`config.SPEC_MASS`) — brawler ×1.39, hauler ×1,
    scout ×0.78, flat across the ladder. The tier sets how BIG the hull is; this sets how DENSE it
    is, and the numbers are measured rather than picked: once `SHIP_VIS` matched all three to one
    apparent size, ink as a fraction of bounding box came out **brawler 0.75 / hauler 0.54 / scout
    0.42** — armour slab, framing-and-ring-arms, airframe. Normalized on the hauler those fills *are*
    the multipliers, so a brawler outweighs a scout **1.78:1** at equal size for the visible reason
    that there is far more of it. Flat, not per tier: the measured ratio drifts, but almost entirely
    because the HAULER's own fill climbs (0.44 → 0.63 as its ring arms fill in), so a per-tier table
    would narrow and widen the spread for a reason no player can see.
  - **SHIP MASS IS PER-TIER** (`config.SHIP_MASS`, 10 → 11,200 across the ladder), because a rope
    resolves by mass RATIO and a constant-10 ship meant a Titan wrestled a moon exactly as badly as
    a Scout did. Derived from the drawn footprint — mass rides `SHIP_RADIUS` at the power 2.5
    (between area and volume; a ship is hull and framing, not a solid lump), as the single
    expression `10 × (SHIP_RADIUS[t] / SHIP_RADIUS[0]) ^ 2.5`. Re-derive it if `SHIP_RADIUS`
    ever moves — and note the exponent COMPOUNDS a size change: the 2026-08 +50% top tier
    (below) moved the run-long mass spread from ~420× to ~1,120× and the Titan alone by ×2.66.
  - **FULL POWER MUST ALWAYS LAND AFTER THE LATCH** (`CFG.WINDUP_AFTER_LATCH`, 1.2s). The winch
    seconds carry into `holdT` so the player is not billed twice — but carried in FULL they covered
    the entire wind-up ramp on the heavy rungs, so a moon or a world hit full power at the exact
    instant it latched. That collapses two mechanics into one number and leaves the READY signal
    with nothing to announce. `grabBody` caps the carry at `window - WINDUP_AFTER_LATCH`, so there
    is always wind-up left to run. Measured: full power lands 1.09–1.21s after every latch, across
    the lightest moon (900) to the biggest solid planet (220,000).
  - **Once the beam has picked its target, the cursor is free** (user design rule). The winch holds
    on the button and on beam RANGE, and never re-tests the cursor. Re-testing it was wrong twice
    over: a moon is a moving target on a rail and so is the ship, so holding still lost the winch
    through no decision of the player's — and the cursor is also the AIM, so pinning it to the load
    meant you could not line up the throw you were winching up for. `render.drawLatch` roots its
    emitter on the bearing to the TARGET for the same reason.
  - **The winch seconds carry into the wind-up** (`grabBody(game, b, L.t)`), they are not charged
    twice — from the player's side it was one continuous press, and billing the full `beamGrip` ramp
    on top would put a hard throw on a moon five seconds out from the click. Releasing abandons the
    winch outright; nothing is banked for the next press — but **only the button that OWNS it**. Two
    winches share one `game.latch`, so `main.onFling` (the LEFT button's release) cancels a beam
    winch only (`!game.latch.stow`) and `updateLatch` reads `game.stowEating` for the ring's;
    otherwise a left-click tap threw away a right-button haul, and the freed cursor is precisely what
    made it unrecoverable.
- **A GAS GIANT CANNOT BE PICKED UP AT ALL** (`config.LIFT_NEVER`), at any tier, with any build. It
  is not a heavier rung you buy your way up to — it is off the ladder, the same fact the ship already
  lives with (`CFG.GAS_*`: no surface, the ship flies straight through the cloud tops). It is what
  makes a giant the one world in the sky you have to FIGHT instead of carry. The way through is
  stripping it: `physics.gasStrip` sets `ptype = 'rocky'` on what is left, so the exposed core is an
  ordinary top-rung world you can absolutely take — and the refusal message says so, because "never"
  without a way out reads as a bug.
- **"MY THROW IS AT FULL POWER" IS A COLOUR AND A POP, NOT A PROGRESS BAR** (user design call;
  `render.drawCharge` + `drawBeam`'s colour argument). The beam brightening as it spools says
  *something* is happening; it does not say the one instant that matters when you are lining up a
  shot. But a filling meter is not the answer either — watching a bar creep is not what the player
  wants mid-fight, and a ring around the load is clutter around the exact thing you are aiming at.
  So the readout is exactly two things:
  - **the beam runs HOT** (cyan → near-white `#dcf8ff`) for as long as it is charged — the steady
    state, and with no ring this colour *is* the readout, so it is a real shift and not a tint;
  - **a one-shot bloom on the CROSSING** — a ring thrown outward over a brief flare on the rock, so
    the pop reads as coming FROM the load. The flash is the event; the colour is the state.

  Both gated on `CFG.CHARGE_SHOW_HEFT` (0.25 of your allowance): below it a rock is at full power
  almost at once and the multiplier is within a few percent of 1, so a pop on every belt pebble
  would be noise on the loop the player spends most of the game in.
  (History: this first shipped as an amber filling arc with pips and a halo at completion; the arc
  and the steady ring were cut — "just the color / pop at the end".)
  - **The law is about the AIM POINT, and it has ONE sanctioned meter** (user call, with the SHIP
    SYSTEMS cluster): the cockpit's THROW gauge, bottom-right, reads the live launch speed of the
    held rock — `game.throwSpd`, published by `tractor.updateTractor` off the SAME `flingSpeedFor`
    call the release and the lead markers use, so the gauge, the ✕ and the actual launch can never
    disagree. It lives on the instrument panel, never near the rock you are aiming at, and at full
    power it runs the beam's own charged near-white off the same gate (`game.throwCharged`:
    `CHARGE_SHOW_HEFT` + a closed grip) at the same instant. A meter beside the crosshair is still
    the thing this law forbids.
- **THE BEAM GRIPS THE SIDES OF A BODY, NEVER ITS MIDDLE** (`render.gripPoints`). Strands that
  converge on the centre read as passing straight THROUGH the rock, and on a moon or a world — whose
  disc is most of the screen — they bury the whole effect under the sprite where none of it can be
  seen. Every strand lands on the rim, spread either side of the bearing facing the ship, with the
  contact glows and the bright limb arc out there with them; a bigger load is taken in a wider
  embrace. **And the winch AMPS UP**: `drawLatch` scales everything by an eased `amp` from near-zero,
  so the effect builds into the full hold with no visual step at the hand-over. The progress ring is
  the exception — full brightness from the first instant, because it is the one element that has to
  be legible before the effect is.
- **THE RING RIDES CLOSE — HALF-DISTANCE, EXCEPT MOONS** (user call, 2026-08). `RING_CONDENSE` 0.5
  scales BOTH the standoff pad and the per-rock step in `tractor.orbiterRings`, which takes a full
  14-rock ring from ~297 units of reach to ~151 (measured ratio 0.51). Halving only the steps would
  not have done it: for the innermost rock the PAD is most of the distance, so the first shell would
  have sat exactly where it was and only the outer shells pulled in.
  **A MOON IS EXEMPT and the exemption is geometric, not taste** — a moon is stowable from Sling
  Winch 4 (`liftClass` floors a moon at rung 3 however light it rolled) and its drawn radius is an
  order of magnitude above belt rock, so condensing its standoff puts a body wider than the ship's
  whole pad inside the hull. A moon keeps its own full clearance step; it still ends up nearer the
  ship than before, because everything stacked INSIDE it condensed, and that is correct — pinning it
  to its old absolute radius would leave a dead gap between the rock shells and the moon.
  A hard floor keeps any body's INNER EDGE off the hull, applied to the accumulator rather than the
  stored value so a body pushed out by it also pushes the ones after it.
  **THE CONDENSE SCALES PADDING, NEVER BULK**, and that is what makes the ring safe: `orbiterRings`
  is the ONLY thing keeping two orbiters apart, because `physics.collideBodies` early-outs on an
  orbit/orbit pair and nothing downstream ever shoves them. Two circles at radii r and R from one
  centre are >= |R - r| apart at ANY bearing, so a radial gap wider than the two radii makes overlap
  impossible without any angular slot assignment — which is what lets the bearings stay loose and
  organic. Scaling the WHOLE step by the condense shrank the bulk term too and broke that invariant
  for any radius past ~10; it took a MOON to make it visible, but the ring was interpenetrating for
  real belt rock as well.
- **A SLOT IS A TARGET, NOT A RAIL — SO THE GAP MUST COVER THE HUNT.** Separation margin is
  `0.6x` the pair's radii, never a constant. Every orbiter oscillates about its slot, and a heavy one
  oscillates WIDE: a moon's spring authority floors at 260 u/s^2 while the approach cap let it arrive
  at 380, so it overshot and hunted ~80 units either side — enough to put two moons with correctly
  separated ASSIGNED radii visibly on top of each other. Two fixes together, and both are needed:
  the margin scales with the bodies, and `maxApproach` eases down with radius (`60 / b.radius`,
  floored at 0.4) so mass arrives at a speed it can actually stop at. Belt rock is untouched — at
  radius 60 and under the ease is exactly the old flat 380.
- **RIGHT-CLICK IS THE STOW, AND THE STOW IS A CHOICE** (user call, 2026-08). Pointing at a rock
  and pressing right mouse seats it in the ring directly (`tractor.stowFromCursor`), never passing
  through the beam — the hauler's exact mirror of the brawler's `absorbIntoRam`, one button meaning
  "put that in my rack" for both specs. It replaced an AUTO-STOW on the left-click grab, which made
  one button mean two things depending on the rock's mass (throw this pebble, silently pocket that
  one) and left no way to THROW a stowable rock at all. Holding the button SWEEPS on the same 0.12s
  cadence as the ram, because filling 14 slots with 14 separate clicks turns a doubled ladder into a
  chore. Pointing at empty space leaves the press to the shotgun charge, and the choice is committed
  for the whole press, so a sweep that crosses open space keeps stowing instead of arming a volley
  mid-drag. Both stow paths funnel through one `seatInRing` — a rock seated by the sweep and a rock
  seated from the beam must be the same kind of object, or one quietly misses the spin, the XP or
  the `primed` clear and behaves differently in the ring forever after.
- **AN INTERCEPT IS THE SHIP SLINGING THE ROCK, NOT THE ROCK SWIMMING** (user design rule, 2026-08).
  Every orbiter breaking formation to block carries `b.guardBeam`, and `drawShip` paints a tether
  onto it through the SAME `render.drawBeam` the hold uses — dimmer (grip 0.55) and narrower
  (width ×0.6), bite suppressed, because the rock is being shoved, not gripped for a throw.
  **GOLD, NOT THE HOLD BEAM'S CYAN** (user call, 2026-08): it shipped cyan on the reasoning that
  it is the same tractor doing the same job, but the two fire at the same moment off the same
  emitter at the same width, and two cyan beams read as one confused effect. Hue is the only
  channel left. Cyan is what you are STEERING, gold is what the ship is doing FOR you — the same
  split the hover rings make between the left button's promise and the right's. Drawn BEFORE the held beams so the rock in your hand keeps the
  foreground. Iterated over `game.orbit` rather than off a flag on loose bodies, so a rock that has
  left the ring can never leave a beam painted into empty space; `updateOrbit` clears the flag every
  substep before it re-assigns, so the beam lives exactly as long as the lunge.
- **THE STOW GAUGE IS LIVE OCCUPANCY, AND IT ZIG-ZAGS** (user calls, 2026-08). One SOCKET per slot
  you own (`st.maxOrbiters`, itself derived from `config.ORBIT_SLOTS`), LIT for each slot currently
  holding a rock. It used to draw the whole 14-slot ladder with the slots you had EARNED lit, which
  made "unlit" carry two meanings at once — empty slot, and rank not yet bought — and two states
  cannot say three things; occupancy is the reading you need mid-fight, and the ladder is already on
  the ability bar. The pips are laid out as an alternating **zig-zag**, not a row: at a flat 6px gap
  a full ring measured 178px and pushed the readout past the panel edge, i.e. off screen at exactly
  the ranks that earn it. Offsetting alternate pips vertically lets the pitch drop to 2px without
  the diamonds touching (~126px for 14). The offset is `top`, NOT a transform — `.pp` already spends
  its transform on the 45deg diamond, and a translate stacked there resolves in the rotated frame
  and comes out diagonal. Structure is rebuilt only when capacity moves and the lit class retoggled
  only when the fill moves: this runs every frame, and rewriting innerHTML at 60fps to change a
  class would be the expensive way to do nothing.
- **PICKING UP A WORLD UNSTICKS ITS SKY.** A world's family — moons, ring chunks, probe junk, its
  rubble shell — rides RAILS anchored to it, and the rails pass reads the parent's LIVE position
  every substep. So a grabbed planet used to carry its whole system with it, **welded**: fifty bodies
  teleporting along at whatever speed the beam was swinging the planet, passing through anything in
  the way, and snapping back into perfect formation the instant you let go. A moon family is held by
  gravity, and the moment something ELSE is holding the planet, gravity is no longer what is moving
  it. So the grab cuts every rail anchored to the body (`tractor.unglue`, planet/moon/rogue only).
  Each child keeps the truthful velocity the rails pass last wrote — its real orbital velocity — so
  left alone it simply keeps orbiting, and it re-rails on the ordinary scan once you have dropped the
  world and flown off. Haul the world away and its moons stay where their momentum left them, which
  is the point. The crust halo is the one binding not cut here: `physics.updateCrust` stands its
  assist down while the host is held (it would rail the rubble straight back on — the same glue by
  another route) and the shell resettles after the drop.
- **YOUR OWN SHOT IS THE LOWEST-PRECEDENCE GRAB TARGET IN THE GAME**, in two stages
  (`tractor.pickTarget`; `render`'s hover hint mirrors both):
  - For **`CFG.THROW_LOCKOUT` (2s)** after a beam launch the rock is skipped OUTRIGHT — not a target,
    no hint ring. Demotion alone was not enough, because out in open space your last shot is the only
    thing under the cursor and still won the click.
  - After that it is merely demoted: it wins again once nothing else is in reach, so chasing down
    your own throw stays possible.
  - And a **loaded stow ring outranks it outright** — `tryGrab` reports `null` so `main.onGrab`'s
    retrieve fallback fires, which is the next rock the player was reaching for.

  The precedence ladder is **loose rock → orbit ring → your own shot in flight**. The whole rule
  exists for the rapid-fire loop (retrieve → fling → retrieve): the rock you just let go sits a
  beam-length away, dead centre under the crosshair, and the second click kept catching it instead of
  launching the next one. Only the two BEAM launches stamp the lockout (`releaseHeld` /
  `flingAllFromOrbit`) — NOT billiards credit, where `thrownBy = 'player'` marks a rock your shot
  merely knocked, and locking those out would block grabbing the scatter from your own impact.
- **Throws never steer and the game never bends the release angle** — a rock flies exactly at the cursor,
  *from its own held position* (~70u out), not from the ship. The aim assist is informational only: lead
  markers (✕) show where the cursor must be at release. Solving from the ship offsets the ✕ and every shot
  misses — this was a real bug. (`tractor.js:26`)
- **Dashed lines are reserved for helper/aiming UI** (throw line, beam ring, orbit rings, lead markers,
  prediction paths). Real objects use solid strokes. Always reset `ctx.setLineDash([])` after a dashed draw.
- **The world is 20% larger by AREA than it first shipped** (`WORLD_R` 42000 → 46000 = ×√1.2).
  That growth was taken entirely as an OUTER BAND (above the last planet at an authored 36800) rather
  than by rescaling the orbit layout. The band holds the outer planet lanes (authored 38300 / 40800),
  the dark star's authored 39500 lane, and The Farshoal dense field on the frost fringe at an
  authored 44300.
- **SYSTEM SCALE: the whole sky is then SPREAD by `CFG.SYS_R_MUL`** (1.3 — user call: "make the solar
  system 30% larger"), `WORLD_R` included, so the boundary, the Oort warning band the Farshoal
  deliberately brushes, and every lane keep their relationship. Three rules:
  - **Every sun-anchored radius in world.js goes through `SR()`** — the layout lanes, the three
    belts, the graveyard ring, Vesper's perihelion AND semi-major axis, the ghost, the carved stone,
    the barge lane, the dark star, the four shoals, the ship's own spawn, and the
    `planetAtOrbit(...)` landmark lookups. What is load-bearing is the RELATIONSHIPS between those
    numbers — the shoals ride the gaps between lanes, the graveyard sits below the innermost world
    and inside the flare zone, Vesper's perihelion sits above the graveyard, the dark star threads
    two outer lanes. One radius left unscaled does not throw; it silently moves that piece of content
    into a lane it was designed to avoid. The lookups scale INSIDE `planetAtOrbit` for the same
    reason: a missed multiplier there returns `undefined`, and the world simply ships without its
    landmark, its shepherd or its siege.
  - **It moves DISTANCE, not speed.** Sun-anchored orbital speed is `sqrt(G*sunMass/r)`, so spreading
    the sky 1.3x slows every orbit ~12% and lengthens every period ~48%; the sun's mass is the speed
    knob and is deliberately NOT recompensated (see the sky-speed/camera-zoom pairing in
    physics-invariants.md — that note governs the MASS, not this constant). The slower sky moves
    AWAY from the ambient-damage thresholds rather than toward them, so `DMG_THRESH` was left alone:
    the calmer sky is exactly what the rarer, wider systems wanted.
  - **Bigger lanes hold bigger worlds.** `PLANET_LANE_GAP` clamps each grown disc by what its
    neighbours leave free, so widening the lanes un-clamps the worlds that were losing the most to
    it — the amber giant goes 1148 → 1560 (the full `PLANET_R_MUL`), the violet giant 1058 → 1290.
    That is the second half of "bigger", and it came for free with the spacing.
- **WORLD SCALE: worlds are built BIGGER THAN THEY ARE AUTHORED** — `CFG.PLANET_R_MUL` (3) and
  `CFG.MOON_R_MUL` (2) multiply the radii in world.js's layout table and `spawnMoon`'s own range,
  so planets and moons read as genuinely massive (user call: "we just want these things to be able
  to be massive"). Three rules hold it together:
  - **SIZE ONLY — THE MASSES ARE UNTOUCHED, and that is not an oversight.** Radius is inert to every
    invariant above (rails are circular and mass-driven, gravity is `GM/r²`, hp is `massToHp` and
    `PLANET_HP_*`), while mass is load-bearing for all of them: holding DENSITY at 3x radius needs
    27x mass, which puts the amber giant at 1.75e7 — heavier than the sun (1.42e7). So the worlds got
    big, not heavy, and two consequences are real and intended. Surface gravity falls as `1/mul²`,
    and the LONG ARMS (`SHIP_WELL_START`) are measured in BODY RADII, so a giant's well reaches out
    proportionally rather than absolutely — a gas giant is now something you fly ALONG, not something
    that snatches you. `PLANET_GRAV_SHIP` is the knob if the big worlds should grab as hard as they look.
  - **`PLANET_R_MUL` is a CEILING, not a scale — hence "up to 3x".** Adjacent rails run at different
    angular speeds and therefore ALWAYS reach conjunction, so `generateWorld` caps each grown disc by
    what its NEIGHBOUR LANES leave free (`CFG.PLANET_LANE_GAP`, 400 of clear space between surfaces)
    and splits a contested boundary in PROPORTION to the two desired radii, so the giant stays the
    giant. Worlds land at 2.21x–3x; at a flat 3x the amber giant (520 → 1560) overlapped the shroud
    world inside it by 175 on every pass and the violet giant met the desert world exactly. Widening
    the LANES instead is the expensive fix — lane radii set sky speed, heat margins and the graveyard
    clearance, so moving them re-tunes the game to make one planet bigger. The pass is pure arithmetic
    over the layout, NO rng draw, so the seeded stream and every angle in the sky are untouched.
  - **Every "covers both bodies' radii" clearance rides `MOON_R_MUL`**, or the crossing-orbit bug
    (see `spawnMoon`'s exCap rationale) walks straight back in: the sibling-slot margin, `moonZone`'s
    inner floor, AND the separate copy in `replenishWorld`'s moon re-accretion — two 84-radius moons
    need 168 of separation where the authored constants guarantee 90. Stations and nests orbit at
    `2.6r`/`3.4r`, which grows faster than the moon band's floor, so an **installation-lane sweep** in
    `generateWorld` nudges them outward clear of every sibling moon (they always shared that band; the
    scale-up just ended the luck). The binary pair's separation and the companion's station orbit are
    likewise derived from the radii, floored at their authored values so an unscaled world is
    bit-identical. Adding a new railed satellite means checking it against this set.
- **THE CRUMBLE: a world under fire COMES APART, and the pieces stay** (user design law: *the debris
  should come directly from the planet as it splits*). Four rules, all in `CFG.CRUST_*`:
  - **The crater is cut OUT of the silhouette, never painted on.** `render.worldSil` rebuilds a
    wounded world's outline as a notched polygon and `traceSurface` is the ONE path every fill and
    clip goes through (body fill, surface detail, terminator, eclipse, the crack web), so the
    starfield shows through the wound and everything on the surface simply ends at its edge. The
    old scar drew an opaque space-coloured blob at the rim, fading in — the user's words, *"a bad
    black thing that shows up"*; several overlapping ones merged into one flat void. Crystal worlds
    keep `traceCrystal` (a fractured silhouette already; notches fight it).
  - **THE CRATER YOU SEE IS THE CRATER YOU CAN FLY INTO.** `util.scarSurfaceAt` is the ONE profile,
    read by `render.worldSil` for the picture and by `physics.surfRadius` for the COLLIDER — the
    same law crystal worlds run on, where `util.crystalShards` feeds render and physics alike. Cut
    the silhouette without the collider and rocks stop dead in mid-air across a crater's mouth
    (the user's words: *"things run into the air"*). The narrow phase is radial and gated by
    `shaped()`, mirrored in **both** `predictPaths` hit tests so the forecast can't disagree with
    the sim about where a surface is; `surfReach` (spawn clearance) is unchanged, since craters
    only cut inward. Rocks are excluded in render AND physics — they collide as circles and draw
    as their own jag — so `traceSurface` and `surfRadius` must keep making the same exclusions.
    **The RESOLUTION has to use the narrow phase's `rr` too, never the raw radii.** All three
    contact resolvers recomputed `overlap` as `a.radius + b.radius - d`, which on a shaped surface
    is off by the whole depth of the feature: flying into a crater ejected the ship to the world's
    nominal circle in one step — a teleport to a border that is not where the surface is. (The
    same bug sat in the crystal path from the day shard colliders landed, ejecting the ship to the
    mean disc instead of the facet it touched.) Verified: a ship pushed under a crater floor now
    comes to rest ON that floor, and one parked inside the crater is not ejected at all.
  - **The whole layer is NEAR-SHIP** (`b.nearShip`, set in `updateFieldLOD` against the same wake
    bubble the field LOD uses, measured to the SURFACE so a giant counts as near at its limb). The
    cratered narrow phase, the halo settle (`updateCrust`) and CALVING all skip a world nobody is
    at: it collides as the circle it used to be and spends no debris budget on rubble nobody
    watched break off. The crater itself still lands off-view — a cheap array push, and it is the
    world's record of the wound, so a planet left under bombardment shows the wear on your return.
    Crystal worlds are deliberately NOT gated: their spikes reach outside the radius, so dropping
    to the disc would make the collider smaller than the body. Straight application of the field
    LOD's law — *the chaos you see is always the chaos near you*.
  - **A hit calves REAL PIECES into a halo that persists.** `physics.calveCrust` puts a slab in the
    mouth of the crater it just made — centred one slab-radius off the surface, so it appears to
    lift out of the hole rather than appear beside it — and the crater is SIZED FROM THE SLAB, so
    the notch in the rim always matches the piece floating in it. Both scales shed: a light hit
    flakes a crumb, a hard one takes a slab plus a shower. Fresh pieces fly free for `CRUST_FREE`
    (the tumble), then `physics.updateCrust` eases them onto the host's halo and rails them.
    **That rail snap is allowed ON SCREEN**, unlike the general re-rail scan — that law exists
    because the generic snap discards a flung rock's radial velocity ("it stopped mid-flight"),
    and this one only fires once the assist has already brought the piece within a few percent of
    the state it snaps to. The halo is RIGID (`entities.chunkHaloW`, one rate per world, shared
    with the worldgen belt) — the dense-field pocket law, for the same reason: mixed rates grind,
    and a railed body shoved by contact resolution snaps back next advance and visibly vibrates.
  - **A world's halo holds its BIGGEST pieces, its scar list its WORST wounds.** Both were plain
    caps at first and both filled with whatever landed first, so forty pebble chips crowded out the
    thrown MOON — the moment the feature exists for showed the least. A newcomer that outsizes the
    smallest piece grinds it to dust and takes the slot; a smaller one only gets in if something
    can retire OFF-SCREEN, so a long bombardment keeps turning over with nothing winking out under
    the player's nose. Anything that GRABS a piece unbinds it for good (`tractor.tryGrab`), and the
    assist never touches a body in flight — *throws never steer* outranks it.
  - **SIZE IS DECOUPLED FROM MASS, but MASS THEN FOLLOWS SIZE.** A piece is drawn as a fraction of
    its host (the same law that made worlds 3x their authored radius) because the mass-derived
    radius draws a 3,200-mass chunk at 10 units beside a 705-unit world. But every gate in the game
    — the beam's tier caps above all — is a MASS test, so leaving the two unrelated made a
    130-unit slab of planet weigh a pebble and every gravity tool picked it up like one.
    `config.crustMass` maps drawn radius to mass against the beam class ladder: a crumb is tier-0
    ammo, a mid piece is boulder class, a full-severity slab off a giant is world weight and asks for
    the beam a small world asks for — and the 45,000 ceiling stays under the 5e4 rail-disturber
    threshold. The crumbs and pieces that make up the bulk of any wound stay early-game ammunition,
    which is what the crumble loop runs on. The
    calve deliberately does NOT bill the host for that mass (a four-piece calve mints ~90,000,
    half a mid planet — subtracting it visibly deflated the world); erosion stays on the chip path.
    Crust is never an `attractor`, at any mass — the dense-field rock rule, for both its reasons.
- **A PLANET SYSTEM IS ALIVE WHILE YOU ARE IN IT.** Non-field bodies used to be awake
  unconditionally — fine at ~380 of them, wrong once the debris belts and the crumble layer put
  ~850 in the sky, every one paying the full per-substep bill from the far side of the system. The
  rubble that MAKES a system (its belt, junk probes, ring chunks, trojans) is inert railed scenery,
  so past the wake bubble it group-advances once a FRAME on its rail and sleeps otherwise, exactly
  as a dormant shoal does — ~680 of ~850 asleep in an idle sky. It wakes on the same bubble with a
  seamless hand-off (measured: 1.28 units on the waking frame against 1.27 steady — no pop).
  Three exclusions, each load-bearing: **attractors** (gravity must stay exact — this is why
  planets, moons and the star are never dormant), **elliptical rails** (the group advance is the
  circular path only; a Kepler rail read as a circle is NaN on its first step — see the rails
  section), and **installations**, which station-keep under thrust and must never wander.
- **Loose debris is on a LEASH** (`CFG.DEBRIS_LEASH` / `THROW_LEASH` / `LEASH_PAD`, culled in
  `replenishWorld`). The crumble mints real rubble every time a world is hit, and without a leash
  every lane the player ever fought in stays littered forever, paying the broad phase and holding
  debris budget for rock nobody will look at again. Railed bodies are exempt — they ARE the system
  and cost nothing dormant — as is anything the expedition layer owns (cores, caches, pods, the
  carved stone, the visitor, wrecks, comets) and crust still settling into a halo. Something the
  PLAYER threw carries `b.slung` (stamped at every launch site: both fling paths and the parry
  riposte) and gets a leash roughly twice as long, because `thrownBy` clears a second after launch
  and a rock vanishing out from under a shot in flight would be the cull deciding for the player.
  Both radii sit far outside any view, so nothing can ever be seen to vanish — that is the
  constraint the numbers are chosen against, not a nicety.
- **A world you are not at slowly WEATHERS** (`CFG.PLANET_WEAR_*`, `replenishWorld`), so a lane you
  come back to after a long detour has picked up meteor pitting instead of being pristine exactly
  as you left it. Deliberately NOT routed through `damageBody`: that derails on any chip (a
  weathering planet must never come off its rail), sheds mass, calves crust and can shatter. This
  only costs hp and leaves small craters, and it **stops dead at `PLANET_WEAR_FLOOR`** (50% of
  maxHp) — invariant 8's whole point is that killing a world is a feat the PLAYER performs, so the
  sky must never be able to fall apart on its own. The per-world rate is HASHED OFF THE BODY ID,
  never drawn from the world rng, or it would reshuffle the entire seeded sky. Near-ship worlds and
  fortified ones are skipped, and its craters are small and lose the "keep the worst wounds" tie to
  a real impact crater, so ambient pitting can never erase the crater a thrown moon left.
  **Gas giants are skipped entirely**: gas cannot crater (`damageBody`'s `canWear` — its damage
  reads as weather), so a scar minted here would cut crater bites into the cloud tops in both
  `render.worldSil` and `physics.surfRadius`; and the hp drip alone would cross `drawGasWound`'s
  40%-damage glow gate on the way to the 50% floor — a glowing hole in the cloud deck with nothing
  having hit it.
- **A ROCK IS NEVER A PERTURBED PRIMITIVE** (user design law, arrived at in two rounds: first
  *"triangles, perfect rectangles — that's not at all how that'd look"*, then, after the corners had
  been chamfered and the faces broken, *"they just look like shapes, like a kids block toy"*). The
  second verdict is the important one, because it is a verdict on the METHOD. Both silhouettes were
  a base shape plus noise — gravel was a regular polygon with a wobble, a landmark was a rectangle,
  a triangle or a splinter with roughened edges — and rounding a rectangle's corners leaves a
  rounded rectangle. The primitive reads through whatever you do to it. So there is no primitive.
  - **`util.rockOutline` is the ONE generator**, for the shoal's gravel, the belt's pebbles and the
    landmark monoliths alike (`render.archJag` and `util.rockJagRing` are callers of it, not rivals
    to it). A shoal should be one material; the old split — potatoes down at gravel size, blocks up
    at landmark size — was visible the moment a giant sat among its own rubble.
  - **Five terms, and each does something the others cannot.** LOBES: 2-5 overlapping discs offset
    along a body axis, which is the shape and not decoration — where one lobe's reach overtakes
    another's the profile creases, and that crease is the neck that makes a rock read as something
    broken off something bigger. STRETCH: a 2-lobe elongation, because real rock is rarely equant.
    GRAIN: six harmonics at 1/f amplitude — one octave is a wobble, a SPECTRUM is what reads as
    stone at every distance, because the feature you notice changes with how close you are.
    FACETS: 0-5 half-plane cuts, and a `min` against a line is a genuinely FLAT face with two real
    corners, which noise cannot produce at any amplitude — this is what keeps a slab a slab and
    stops the set drifting into potatoes. BITES: 0-4 concave scallops, craters in the silhouette,
    the deepest concave features a real rock has. (An early version built the shape from half-planes
    and NOTHING else and drew as a machined block, because convex. Flats are a good ingredient and
    a terrible base.)
  - **The kinds are parameter presets now, not five constructions** — and they still mean what the
    pocket is navigated by: a SLAB has long flat faces you route along, a WEDGE tapers to a point, a
    SHARD is a splinter with a narrow waist, a CLEFT's notch is deep enough to fly into, a LUMP is
    the gnarled general case. The mix (`util.rockKind`) is unchanged.
  - **It is a RADIAL FUNCTION about one origin, sampled at even bearings, and two things fall out of
    that.** The outline cannot self-intersect however hard the terms are driven, and there is no
    vertex sort — the previous build sorted by bearing, and a point pushed past its neighbour came
    back as a hairline SLIVER, a radius discontinuity the collider felt as a spike the picture barely
    showed. That failure mode is now unreachable rather than merely bounded: 0 of 3,000 ids carry an
    adjacent-sample jump over 0.20r, against 58 before any of this. And the sampled profile IS the
    table `physics.surfRadius` reads, with no resampling in between, so the drawn edge and the
    collided edge are the same numbers — the CRUMBLE law, reaching rock.
  - **AND IT IS NEVER CONVEX** (user design law: *"I want there to be more extreme concave shapes as
    well in there"*). Two mechanisms, because "some rocks are dramatically hollowed" and "no rock is
    a shape" are different requirements:
    - **The GOUGE** — one dominant concave feature, on `gougeP` of rocks (always, for a CLEFT).
      **Width is the half that matters and the half that is easy to get wrong**: a narrow notch
      removes almost no AREA however deep it goes, so it reads as a crack rather than as a rock with
      a piece missing. It takes the 0.7 power of the raised cosine — flatter floor, steeper walls,
      because the walls are what read as a notch — and never `sqrt`, whose infinite slope at the rim
      puts a vertical wall between two adjacent samples for the collider to catch on. `gougeTwin`
      adds its opposite number, and cutting from both sides is what makes a WAIST rather than a bay:
      a dumbbell held together at the middle, which is a real asteroid (Kleopatra, Itokawa) and, at
      monolith scale, a place to fly through. Measured over 3,000 ids the deepest dent runs p10 0.14
      / p50 0.35 / p90 0.72 of the chord across it — a spread from merely irregular to hollowed, not
      a set that is uniformly chewed.
    - **The CONVEXITY GUARD** — facets are a `min` against a line, so enough of them landing well
      spread out IS a convex polygon: the machined-block failure arriving by the back door, and it
      shipped a clean triangle. So `chordDeficit` measures the deepest dent the outline actually has
      and cuts a modest gouge if there isn't one. Three details are each a bug that was in it:
      it measures at **three window widths** (one window only sees dents its own size, so a chord
      drawn across a narrow window sits inside a wide bay and calls it flat); it runs **after the
      floor**, because a notch that bottoms out ON the floor is shallower than the cut that made it;
      and its depth is a fraction of the **local** surface, since an absolute cut landing on a tall
      lobe barely dents it. With all three, 0% of ids come out under the threshold — against 48%
      measuring near-convex before the guard existed. Its own cut is deliberately MODEST: the drama
      is supposed to come from `gougeP`, or the kinds that come out convex most often (slab, wedge)
      would end up the most chewed.
    - **Gravel's concave features are pulled back** (`GRAVEL_GOUGE_*`) for the same reason it is
      squatted: a gouge is sized against the body, so on an 18-sample ring drawn at 6 px it is most
      of the rock, and the deep ones came out as little hearts and bowties — a silhouette, which is
      the complaint again from the other end. The guard still applies at both scales; it is the
      DRAMA that scales, not the rule.
    - **The honest limit of the representation**: a rock may be notched, waisted, hollowed or cut
      most of the way through, but never HOOKED. An overhang would put two surfaces on one bearing,
      and `rockOutline` is a radial function about one origin by construction. `OUTLINE_FLOOR` is how
      close to the middle a surface may come (0.19 of the mean radius).
      **This is a rule on the GENERATOR, and it is not inherited by the bake** — `tools/bake-rocks.mjs`
      CUTS children out of parents, and a child landing with its own centroid can put a bite between
      that centroid and its far wall. 17 of the 68 baked shapes are not radial functions as a result,
      which is why a landmark's collider is a polygon query and not a bearing one (issue #102 —
      [physics-invariants.md](physics-invariants.md), [rock-fracture.md](rock-fracture.md)).
  - **Gravel is drawn SQUATTER than a landmark of the same kind** (`GRAVEL_SQUAT`/`GRAVEL_OFF`), and
    that is a memory bill, not a fudge: the sprite cell must span the ring's longest axis, so the
    atlas pays for the peak-to-mean ratio in BOTH memory and fill: `SPRITE_EXT` is sized from
    `JAG_PEAK`, so every blit in a shoal rasterises that margin whether the rock fills it or not.
    **This is a measured, accepted cost** — 1.43 against the 1.25 a near-circular ring needed is 31%
    more quad area, and it shows up as roughly +6% on the dense-field frame and +8% on debris-heavy.
    It was not worth buying back: pulling `JAG_PEAK` to 1.30 drops the gravel's mean radius to 0.91
    of the body radius it COLLIDES at, and a rock drawing 9% small is a worse bug than a wider quad.
    Squatting harder does not help either — the peak's tail comes from the grain, not the
    elongation. Rings normalise to a mean radius of 1, not a peak, so a body draws the size it
    collides at whether it came out knobbly or smooth.
- **Damage detail is sized against a FIXED reference radius, not the body** (`DETAIL_R` 260 in
  render's `drawBodyDamage`). Crack widths, crack lengths, the ember fissure glow and a crater's
  fracture rays were all authored as fractions of R when nothing drew bigger than ~250 units; at
  `PLANET_R_MUL` 3 a plain fraction scales the DAMAGE with the world, and a 686-unit planet drew
  12-unit fissures running 450 units across its face — canyons gouged in the surface, not cracking.
  A crack does not get wider or longer because the planet is bigger. Bodies at or under the
  reference are bit-identical; everything above shares one absolute look. Anchoring stays real-R
  (cracks start at the true rim, craters sit on the true limb) — only the detail's scale is clamped.
- **THE PLANET FACE scales the other way: feature COUNT grows with the world, feature SIZE stays a
  fraction of it** (`render.planetDetail` / `drawPlanetDetail`). A continent, a band or a lava plate
  IS a fraction of its world — clamping those to `DETAIL_R` would shrink a giant's weather to a
  postage stamp — but the same four ellipses that dressed a 250-unit disc read as bare at 1500, so
  the mid-frequency layer (eddies, linea, dune trains, craters, gyres) grows in number with the
  built radius (`den`, capped at 5). Three rules hold it together: the face is built ONCE per body
  into `b._pd` as fractions of the radius (seeded off `b.id` — stable, no `Math.random`) and drawn
  against the LIVE radius, so a world chipped smaller wears its face smaller with no pops; the cache
  key is `ptype|gasKind|landmark`, which is what rebuilds the face when a stripped gas giant BECOMES
  its rocky core in place; and the mid-frequency layer sits behind a `fine` gate
  (`R * zoom > 24px`) because at a dozen screen pixels the archetype's big read — bands, caps,
  continents, plates — is the whole story. Organic patches come from `mkBlob`/`blobPath` (two low
  radial harmonics over an ellipse — the rock law's lesson applied to paint: a bare ellipse reads as
  the primitive it is), and every ambient drift still rides multiples of `b.rot`, never wall-clock
  time. **GAS GIANTS RUN THE OPPOSITE WAY ON SIZE TOO** (user call: "because they are so
  incredibly big, the details need to be smaller"): `fs = sqrt(den)` DIVIDES band heights, eddy
  sizes and wave amplitudes as the world grows, so a 2,000-unit giant wears many fine stripes and
  small storm flecks instead of six huge bands — only the landmark Great Eye stays big (it is
  steered by), and the azure giant keeps its few wide bands (calm IS its identity; only its cirrus
  and storm fleck scale down). The archetype signatures are: sheared wavy bands + eddy trains = gas
  (amber busy/warm, azure calm + polar hood + cirrus, violet turbulent + curl hooks), dark crust
  plates over lit magma
  seams + rivers = lava, ragged caps + Europa linea = ice, shelf-sea continents + cloud masses + a
  cyclone = terran, deep basins + currents + gyres + archipelagos + a sunward specular = ocean, ergs
  + dune ripple trains + a canyon = desert, sheared cloud decks + colliding chevrons = shroud, a
  facet lattice keyed to the REAL `b.cjag` silhouette = crystal, maria + rimmed craters + crooked
  ridges = rocky.
- **Every planet wears a belt of its own rubble** (`world.seedDebrisBelts`, appended after
  `seedDenseFields` per the expedition-layer rng rule). Counts scale with the world's radius, the
  material comes from `config.worldDebris` — the same table `calveCrust` reads, so what already
  orbits a world and what breaks off it are visibly one substance — and the ice and lava worlds,
  which shipped with no orbiting rock at all, now carry belts. Three placement rules: the band is
  the WIDEST CLEAR ANNULUS in the shell, not merely everything under the innermost moon (Calyx
  keeps a 59-unit moon 70 units off its cloud tops, which under the simpler rule left the
  most-visited world in the game beltless while the gap just outside that moon was wide open);
  it must clear every lane already railed around that world (moons ride ELLIPSES, so read
  `a * (1 - e)`, not the `rail.r` a circular rail carries — reading `r` NaN'd the band bound, slipped
  past a `<=` guard, and spawned hundreds of bodies at NaN coordinates); and pieces go in evenly
  spaced angular SLOTS, because a uniform scatter at this piece size overlaps at spawn and the
  gentle-contact absorb rule eats half the belt before the world finishes loading.
- **The world edge has no drawn boundary — the Oort cloud is weather, not UI.** No stroke at `WORLD_R`,
  and no shared edge of ANY kind at one exact radius: even a soft constant glow starting at a single
  radius reads as a hard line (the user rejected both). The grind radius is legible from natural cues
  only — aurora-curtain feet weaving through the warning band, dust density smoothstepping up across it,
  early flurries, and the frost vignette + OORT warnings (`render.js drawOort`/`drawOortDust`). More
  generally: in-world transitions are organic/stochastic, never geometric.
- **The ship shield is a calm, steady volumetric rim glow — no dashes, no idle motion.** Motion is reserved
  for *events* (recharge sweep, absorb ripple). **Shield down draws nothing at all** — a naked hull is the
  indicator; the blinking `SHLD` HUD label carries the alarm. (`render.js:609`, `:619`)
- **A ringed giant's band is drawn in TWO PASSES, half behind the world and half in front**
  (`render.js drawRing`, called once from each side of the planet's disc in `drawBody`). One
  full-ellipse pass ahead of the planet put the WHOLE ring behind it — the disc occluded the near arc
  every frame, so the ring read as a decal on the backdrop instead of a body wearing a ring. The split
  is taken in the ellipse's OWN parameter space (`t` in `[0, π]` = the near arc, since the
  pre-rotation offset is `(rx·cos t, ry·sin t)` and canvas y grows toward the viewer), so it follows
  the band's slow tilt for free and the near half rotates WITH the ring rather than snapping sides as
  the tilt sweeps past an axis. The two arcs share their endpoints out past the limb and are stroked
  identically, so they meet seamlessly — and they must never overlap: at `globalAlpha` 0.4 a
  double-stroked span blends to 0.64 and prints a bright pip at each tip. The near half goes over the
  terminator, eclipse and damage (it is in FRONT of the world); only the helper-UI rings outrank it.
- **Hover hint ring colors:** green = right-click STOWS it into the ring, amber = right-click
  CRUSHES it into the ram (brawler's own hue — the green stow promise is never true for a spec with
  no ring), cyan = left-click HOLDS it in the beam, red = too heavy. Green and amber are both the
  RIGHT button and cyan is the LEFT — since the stow moved off the left-click grab (2026-08) the
  hues split cleanly by button, which is what lets the ring be read without a legend. Every hue runs
  the SAME `config.canLift`/`canStow` the click itself runs, so the ring can never promise a grab
  the beam would refuse.
- **The cockpit chrome is LOCALE-reactive, the instruments are not.** `zone.js` — built as the same
  machine as `music.js`, and meant to stay that way: buckets, a presence score each, ENTER/EXIT
  hysteresis, a minimum dwell, a crossfade — decides which of five places the ship is in and publishes
  the crossfaded accent as `game.zone`. `hud.zoneChrome` writes it to `#hud` as three comma triplets
  (`--zone-rgb` / `--zone-soft-rgb` / `--zone-deep-rgb`, a pale→accent→well ramp mixed in JS because
  CSS can't compute a ramp it can also spend at arbitrary alpha), and re-declares `--chrome` /
  `--chrome-soft` off them, so everything already written in terms of those follows for free.
  `render.drawMinimap` reads the same `game.zone` for the dial's grid, scale break, sensor bubble,
  sweep and rim — the top-right is ONE instrument, and a radar still lit violet inside a gold cockpit
  reads as a bug.

  | zone | where | that region's sky | accent |
  |---|---|---|---|
  | `deep` | the fallthrough — open space | blue-black | violet `176,112,255` (the house chrome, unchanged) |
  | `world` | inside a planet/moon/station domain | dark + the planet's own blush | gold `255,201,100` |
  | `corona` | the star filling your sky (`R * 1.4`) | hot amber | ice blue `110,205,255` |
  | `shoal` | inside a dense field's `fieldFrac` footprint | grey/rust rock | orchid `255,106,213` |
  | `fringe` | the Oort approach, last lane to the wall | dim pale blue | glacial `198,226,255` |

  **Every accent is picked AGAINST its region's sky, and that is the whole point** — the mood tint this
  replaced blended TOWARD it and went corona amber over an amber sky, the lowest-contrast thing it
  could have done. Measured against the pilot card's own bed, the switch buys 1.25×–2.4× contrast in
  every zone that changes and leaves deep space exactly as it was.
  The palette is also picked around the INSTRUMENTS, which is what actually decides it: mint green,
  shield cyan, lives rose and alarm ember are spoken for. Acid lime was tried for the shoal first and
  was wrong for exactly that reason — a lime cockpit sits four inches from a green hull bar. The
  fringe is the one deliberately DESATURATED accent; saturation is the second axis, and it is what
  keeps it apart from the corona's ice blue.

  **It is a LOCATION channel, not a threat channel.** Combat is not a place: threat stays with the mood
  vector, which still drives the edge wash's INTENSITY (`--moodI`), and with the alarm classes. The
  `lowhull` / `heat` classes still override `--fr` outright — an alarm always outranks a locale — and
  `game.zone` is undefined until the first frame, with the CSS fallbacks set to the house violet, so
  the title screen is unchanged. **CHROME ONLY**: hull green, shield blue, lives pink, the gold ★ score
  and the per-category achievement accents never take it, or the instruments stop reading at a glance.
  The SHELL MENUS keep the house violet too — they live outside `#hud`, and a pause screen is not a
  place the ship is at.
- **NO FRAME AROUND THE VIEWPORT.** The chrome used to include glowing corner arcs — a masked rounded
  border on `#hud::before`, inset 10px, visible near each corner. It was removed on request: a violet
  outline tracing the whole screen reads as browser chrome laid over the game, not as a machine you fly.
  Don't reintroduce a stroke at the screen edge in any form. The mood channel and both alarms survive
  it intact — the wash carries the mood, and `#fx::after`'s pulsing red/amber vignette carries `lowhull`
  and `heat` (it always outranked the frame anyway). This is the in-world **no hard edges** law applied
  to the HUD's own boundary.
- **The top-right is ONE instrument.** The menu button is an annular-sector tab machined into the
  radar's bezel (`#menuBtn`), not a square parked under the dial — its box is concentric with `#radar`
  and clip-path'd to an arc hugging the rim. The geometry is a hand-computed agreement between two
  files: `render.drawMinimap`'s centre and rim radius, and the polygon in `style.css`. **Move or resize
  the radar and the tab's polygon has to be regenerated** — nothing derives it at runtime. The SYSTEM
  CHART tab (`#mapBtn`) is the same construction one sector further round the same band: menu at
  r 98→122 over 164°–196°, chart over 126°–158°, with a 6° gap between them; the glyph of each rides
  its own sector's midline at r 110 (☰ at 30px/100px in that 240×240 box, ◎ at 53px/168px). Both
  polygons are generated the same way and BOTH have to be regenerated together — the shared
  properties live in a `#menuBtn, #mapBtn` rule so only the clip-paths and glyph offsets can drift.
- **THE RADAR IS A SCAN; THE CHART IS A CHART, and that difference is why both exist.** The dial is
  ship-centred, forgets the moment the sweep passes, and shows nothing past its rim — out in the
  scan band a contact is a ping and an unswept bearing is empty. `starmap.js`'s **system chart** is
  the other instrument: sun-centred, fixed, remembering, and the ONE place allowed to carry an old,
  vague plot. It has four tiers and every draw decision hangs off `contactLevel`:

  | state | test | mark |
  |---|---|---|
  | `charted` | `game.charted[b.chartKey]` | a clean lit disc in its own colour, named, with its orbit lane and its family |
  | `unknown` | not charted | a soft colourless bloom, with an uncertainty ring. No name, class, size or lane — **and only for a WORLD** |
  | `null` | `b.hidden` | **nothing, ever** |

  **TWO STATES AND A FLOOR** (user call). There was a third tier between them — `seen`, "the fog scan
  found it but you never went", drawn as a hollow ring — and it was one distinction too many: the
  player only ever acts on *have I been there or not*, and a chart with three marks to learn is a
  chart you read instead of glance at. **A charted mark carries NO OUTLINE**: it wore a white rim,
  and on a world drawn at any real size that reads as a thick ring bolted round the planet rather
  than as a light. The bloom already separates it from the bed; a stroke on top of a glow is one edge
  too many.

  `starmap.hasFix` (`b.seen || charted`) survives underneath, and is **not** a third state — it never
  changes which mark is drawn, only how tight the bloom is and whether the error circle shows. It
  exists because the ROUTE needs it: a stop pinned to an unexplored world tracks its *plotted*
  position, and that guess can sit up to 3,400 units off the truth — further than the world's own
  arrival radius — so a route flown to a pure guess would land you in empty space with the stop never
  popping and the world never charting. The fog scan reaches 2,600 units, comfortably outside that
  radius, so tying the collapse to `b.seen` means the fix always lands before you arrive.

  **Names are earned.** Reading the nameplate is what charts a body (world.js's chart scan), so a
  world the scan has merely swept is still `UNEXPLORED WORLD`. **`b.hidden` is absolute** — the
  powered relay stays the only way to learn the Wanderer's Star exists, and a chart that leaked it
  would gut the questline exactly as a minimap blip would. **The guess is deterministic**
  (`ghostOff`, mulberry32's mixing step hashed off `b.id`): a plotted position that re-rolled every
  frame would boil, and a boiling mark reads as a rendering bug rather than as uncertainty. Zooming
  in does not sharpen it — the uncertainty ring simply gets wider, which is the honest reason why.

  **The `unknown` state is deliberately NARROW** (`starmap.plottable`, user call): only **worlds** and
  **shoals** are plotted before you have found them. Moons, installations, nests, comets and the
  barge appear the moment the scan picks them up and not a second before — an unknown mark carries no
  information beyond "something is roughly there", and 59 moons' worth of that is not a chart, it is
  fog with dots in it. Worlds and shoals are what you set out toward; the rest is what you find when
  you get there, which is the shape of the discovery layer itself. **A MOON IS ITS HOST'S**: nothing
  hangs off a world you have not found, whatever the fog scan happened to catch on the way past — a
  family of pips orbiting an unexplored bloom would claim you know the system's shape while still
  refusing to name the world at the middle of it, which is the one thing the ladder must never do.
  One predicate serves the draw AND the hit test, so the chart can never show a mark that cannot be
  clicked or answer a click on a mark that was never drawn.

  **Belt rock is not on the chart at all**: it plots PLACES, and a few hundred anonymous asteroid
  marks would bury the ones that mean something. Dense fields ARE on it, as named regions,
  **stippled and never outlined** — the no-hard-edges law read across from the dial's own dot layer,
  since a boundary ring would claim an edge the pocket does not have.

  **MOONS ARE ICONS — they carry no chart label** (user call). Moons have no individual names in this
  game, so a zoomed-in family printed the same `MOON OF OSSIA` four times in a ring around a disc
  already labelled `OSSIA`. Their host names them, and the readout strip names them on demand.
  Labels belong to worlds and landmarks.

  **PLAIN WORDS.** The unexplored tier said `UNCHARTED RETURN` — a "return" is radar jargon for an
  echo, which is precise, wrong for a chart (a chart carries plots, not returns) and meaningless to
  anyone who has not worked a radar. `UNEXPLORED WORLD` / `UNEXPLORED SHOAL`. That is the standard
  for every string on this instrument: it is read by a pilot, not by an operator.
- **THE CHART HAS AN LOD, AND IT IS ONE KNOB** (user call: too busy zoomed out). `zk` — 0 at the fit
  scale, 1 by zoom 4 — carries the marks: **small contacts grow** from 1.3px pips into real marks
  (drawn at a flat 2px with a wide halo, fifty-odd moons and installations made the inner system one
  continuous smear at exactly the zoom whose job is to show the SHAPE of the system, not its
  contents). Three details wait for a zoom
  with room for them, each on its own threshold: an unexplored world's **uncertainty circle** (past
  ~30px, else it is a second ring around every one of them); the **smaller landmarks' labels**
  (`POI_LABEL_ZOOM` 2.5 — at the fit scale a RELAY STATION plate lands straight on top of the world
  it orbits); and **moon lanes**, which have their OWN much later ramp (`MOON_LANE_ZOOM` 4, fading in
  over the next 5 — user call). The moons say "this world has a household", worth knowing from a
  distance; the lanes say "and here is each one's orbit", worth drawing only once they read as
  separate rings rather than a smudge around the disc. Worlds label at every zoom; they are the
  skeleton.
- **THE CHART IS LIT, NOT DRAWN** (user call: "more stylized and glowy"). It is a neon instrument in
  the same kit as the rest of the console, and almost all of that comes from additive passes: a
  seeded star-dust field parallaxed behind the system (seeded ONCE at module load — re-rolled per
  frame it is static hissing, re-rolled per open it quietly says the stars moved), the star's light
  pooling through the inner system, panel-kit scanlines, a vignette, a bloom under every identified
  contact, a glow along the route's legs, and a two-stage corona on the sun. Every `'lighter'` pass
  resets to `'source-over'` — the canvas-discipline law, and on a full-screen instrument a leaked
  composite mode is not subtle. The contact bloom is deliberately **TIGHT** (user call): small
  radius, hot core, fast falloff. A wide soft halo on every mark is a fog bank, not a glow. A charted
  world also gets an additive **hot core over its own colour** — a flat fill of a body's colour is
  the one thing on this chart that reads as paint rather than as something switched on.
- **A LANE IS BRIGHTEST WHERE THE BODY IS** (user call) and fades away around the ring. Drawn flat it
  was a hoop of equal weight everywhere, which says "this whole circle is the subject" — the body is
  the subject and the lane is context that should thin out behind it. One **conic gradient** centred
  on the parent with its start angle pinned to the body's own bearing does it symmetrically for the
  price of a single stroke, instead of forty short ones. `createConicGradient` is feature-checked
  exactly as `drawMinimap` checks it (`src/` may never assume a capability); a flat stroke is the
  honest fallback.
- **FEW RANGE RINGS** (user call): ~2-3 across the view (`niceStep(spanW / 5)`), there to give the
  eye a sense of scale, not to divide the system into bands. At one ring per 10% of the span the
  chart read as a target and the system inside it stopped being the thing you were looking at.
- **THE READOUT STRIP HAS A LIVE PORTRAIT** (user call), and it is the knowledge state on a third
  channel — the one a player reads without learning a key first. A **charted** world turns under its
  own banded weather with a fixed terminator, its ring, and its moons going round; an **unexplored**
  one gets sensor static and the words NO IMAGERY. It runs on `chart.t`, the panel's OWN clock
  (advanced by `chartEase`), because the sim behind a shell modal is frozen and `game.time` cannot
  animate anything here; everything procedural is seeded off `b.id`, so a world's face is ITS face
  every time you point at it rather than a fresh scribble. The strip's text is split three ways —
  name, one sentence of prose, and a gold DATA line (range / orbit / household) — because a sentence
  and a number are read differently, and running them together made the range something you had to
  parse a paragraph to find.
- **The legend is a KEY, not a paragraph** (user call): swatch and word, one short row. The sentence
  that used to ride each line was read once and then sat in front of the chart forever. **RECENTRE is
  an icon sharing a row with the scale bar** — both read the VIEW rather than the system — and it is
  deliberately lighter chrome than the panel kit (a hairline and a glyph), because it is a control
  sitting over the chart rather than a button in a menu. Its position and the canvas-drawn scale
  bar's are a hand-matched pair, like the radar's bezel tabs: move one and move the other.
- **THE JOURNEY RAIL DOES NOT EXIST UNTIL THERE IS A JOURNEY** (user call). An empty panel explaining
  a feature is chrome you read past every time you open the chart; the header's hint line already
  says how to start one. RECENTRE therefore lives in the HEADER, beside the zoom readout it undoes —
  it is a view control and must not disappear with the rail, which only owns CLEAR.
- **THE CHART HAS WEIGHT** (user call). Pan and zoom ease toward a TARGET rather than tracking the
  pointer exactly (`starmap.chartEase`, on `dtReal` — the sim behind a shell modal is frozen, so
  `game.time` is not a clock it could use). Three things follow from that and each is load-bearing:
  the cursor-anchored zoom is computed in **target space** (correcting against a zoom that is itself
  still easing chases its own tail, and the point under the cursor walks away as you spin the wheel);
  zoom eases in **log space** (the eye reads the ratio, so a linear lerp crawls at 40× and snaps at
  1×); and the release momentum is taken from **the drag's own lag** (`chartDragEnd`) rather than a
  measured pointer velocity — the residual already IS how fast you were dragging, so it needs no
  clock, timestamp or velocity history. RECENTRE glides home; OPENING is instant, because easing in
  from wherever the last session was left is a fly-through from a place the player is not looking at.
- **A JOURNEY IS AN ORDERED PATH PINNED TO MOVING BODIES.** Everything on this chart orbits, so a
  waypoint is a body REFERENCE, never a pair of coordinates — a stop stored as a position is stale
  before you have finished plotting the next one. Four rules that each guard a real failure:
  **arrival pops the HEAD ONLY** (dropping every stop you happen to pass is forgiving right up until
  a route doubles back and eats two you still wanted); **the arrival radius IS world.js's chart-scan
  zone**, to the number, so a stop ticks over exactly as the place names itself (sized independently
  first, it popped ~200 units before the nameplate faded up — the confirmation arrived before the
  thing being confirmed); **a destroyed body leaves a flagged LOST CONTACT** at its last known
  position rather than vanishing from the list; and **a drag is not a click** (3px slop), or panning
  across a crowded inner system litters the route with stops nobody asked for. The route's own ink is
  the CHROME family — a plan is a UI construct, not a thing that is out there, and painting one in an
  instrument's colour would make a journey read as a warning.
- **The chart is a SHELL MODAL, and full-bleed.** It freezes the sim like the other four, which is
  what lets it be a chart at all rather than a live display: the positions you click are the
  positions you saw. Because it covers the whole screen it also **hides `#hud` outright** — the other
  shell panels are centred boxes with the cockpit showing around them (right: you are still in the
  cockpit reading a screen), but a radar sitting on top of the chart is two instruments claiming the
  same corner, one showing a slice of the very system the other is showing whole. Its own refusals
  go to the chart's readout strip, never `hud.message`: `#msg` is deliberately hidden under a modal.
  **CLOSE is an X in the top-right corner** (user call), not a BACK button in a tray — every other
  shell panel puts its button at the bottom of the slab, which works because the slab has a bottom;
  a full-bleed overlay has no edge to sit one against, so it takes the convention overlays have.
  In-world, the next stop draws its **arrival ring** whenever that ring could CROSS the view — not
  when its centre is on screen. Those radii are routinely wider than the viewport (a planet's is
  ~1,200 units against a view about 760 across), so culling on the centre meant the ring only ever
  appeared once you were already inside it, i.e. after the stop had popped: the whole thing was dead
  code that nothing errored on.
- **THE XP RAIL IS MOUNTED ON THE PILOT CARD'S FOOT, not floating and not inset in it.** It used to
  be a wide hex pill alone at the top centre of the canopy, disconnected from the ability list it
  fills toward. It now straddles the card's BOTTOM edge as its own rim-lit slab throwing a shadow up
  onto the card — flush-inset first, which just read as one more row; the straddle plus the shadow is
  what makes it read as a part bolted on. Its `content-box` + 2px padding is load-bearing: hud.js
  writes `#xpFill`'s width as a percentage, and it has to resolve against the well inside the rim.
  **The FOOT, not the head** (user call), and the reason is that the card is bottom-anchored and
  grows UPWARD: with the rail on top, every ability learned shoved the run's main gauge another row
  up the canopy, so the instrument you glance at most never sat in the same place twice. Down there
  it is pinned to the screen and the loadout stacks away from it. The card reads bottom-up now —
  rail, the tier it measures, spec + score + lives, then everything that rail has already bought —
  and the spine gradient, the bed's light spill and the rail's drop-shadow all had to invert with it.
- **AN OWED PICK IS OFFERED, NOT FORCED** (user call: don't pause the game for it). The cards land at
  the HEAD of the pilot card, one step above the loadout they are about to join, and simply wait
  there — through firefights, dives, whatever — until the player answers with 1 / 2 or a click. Only
  the run-opening SPEC card still freezes the sim, and it is answered before the world has started
  moving. Three consequences, each deliberate:
  **(1) It is built from the CARD's vocabulary, not the modal's** — sheer beds, square corners, an
  accent spine per row, the same glyph column the loadout uses. An offer row is the loadout row it is
  about to become, one size up and lit, with the catalog line showing and a key cap on the front;
  pick it and it drops into the list directly below as the compact version of the same object.
  Octagon chamfers and opaque slabs stay with the modal kit, where a panel is allowed to be a panel.
  **(2) "Answer me" is carried by LIGHT AND MOTION, never by a heavier surface** — the block breathes,
  the header pip blinks, the milestone wears the kit's gold trim instead of the locale accent, and
  the XP rail that bought the pick pulses at the card's foot until it is taken (on `#xpBar::before`,
  because `.gain` already owns an `animation` on `#xpBar` and retriggers several times a second).
  There is deliberately **no `#msg` line** — user call, "the window popping up is enough": the cards
  are the notification, they stay until answered, and a top-centre line said it twice while occupying
  the slot a real hazard warning needs. The CHIME stays; it is the only channel that reaches a player
  looking somewhere else.
  **(3) The cards are the ONE exception to "nothing in the pilot card may take the mouse"** — see the
  loadout-row law below. They are a control, not a readout, they exist only while a choice is owed,
  and everything around them (header, hint, the block's padding) stays `pointer-events: none` so only
  a card itself can eat a click. A queued second offer is held back 0.8s so it cannot land under a
  cursor that just clicked the first one.
  The card is capped at `calc(100vh - 34px)` and the LOADOUT is the only part allowed to give: on a
  short window a full 19-ability list used to run off the top and take the offer with it, which is
  the one thing on that card asking for something.
- **In-flight HUD surfaces are SHEER and SQUARE-CORNERED** (user call). The pilot card and its hover
  readout are see-through enough to fly over — you should read the sky through the whole card — and
  their corners are hard. Both were rejected in the other direction first: a chamfered corner plus a
  near-opaque bed made a solid object parked on the screen instead of a readout printed on the canopy.
  If text stops reading against a bright limb, fix it with the text's own shadow, never by filling the
  bed back in. The modal panel kit is a different surface and keeps its octagon chamfers.
- **Ability icons are MONOCHROME LINE GLYPHS, never emoji.** `⏩` (U+23E9) carries emoji presentation,
  so the OS painted a filled blue rounded square in a column of hairline symbols. Before adding an
  icon to the `ABILITIES` catalog, check the codepoint isn't `Emoji_Presentation=Yes` — and look at it
  rendered, since a few text-default codepoints still come out colored.
- **Pointing at a loadout row lights it and prints what the ability does** (`hud.abilHover` →
  `.ab2.hover` + `#abilOut`). The list shows rank pips and an XP hairline but never the one thing you
  can't infer — the catalog text. The row's own highlight is two parts, the pairing the menu buttons
  already use: a one-shot sheen that reads as the row lighting up, plus a steady tint that stays while
  the cursor is on it (the sheen alone left no trace of which row the panel belonged to once it had
  passed). The hover state is **hit-tested from a window mousemove against cached row rects**, exactly
  as the achievement toasts are, and there is deliberately no `:hover` in the CSS: the card sits in
  the bottom-left of the play area, so giving its rows real `pointer-events` would let them swallow
  the mousedown that starts a tractor grab. **No READOUT in the pilot card may ever take the mouse.**
  The pick offer's cards are the one exception and they earn it by not being a readout: they are a
  control that exists only while a choice is owed, and 1 / 2 answer them without the cursor ever
  going near that corner. Both the highlight and the panel are gated on the same flag as the menu
  button, so neither can sit under the spec card or a shell modal.
- **ROGUE PLANETS ARE GONE** (user call: "they're only causing issues"). A wandering 2.5-4.5e5 mass
  under full gravity was a permanent source of sky damage that no player action caused and none could
  prevent: it derailed whatever lane it crossed, ATE moons on the flyby, and — once the outer band
  existed — gravitationally CAPTURED light outer worlds and dragged them into the sun, taking every
  lane it crossed on the way down. Three separate guards were written against that one body type (the
  spawn-ring radius, an entry-speed floor, and the planet fiat re-rail in physics) before deleting it
  turned out to be the honest fix; idle skies went from losing planets to holding every world with
  zero loose ones. `type: 'rogue'` is still supported everywhere — render, minimap, weighted gravity,
  the re-rail disturber list, `scrapValue`, `noteKill` — so the concept can return if it earns its
  keep. **Nothing spawns one.** Don't "restore" the spawner without solving the capture problem first,
  and note the two rogue achievement rows were retired with it (an unearnable row is worse than a
  short list). The clearance rule that once sized the outermost planet lane was the rogue SPAWN RING,
  so it stopped binding when they went — which is why the layout's outer lane could later move.
- **A PLANET SYSTEM IS RARE, AND ARRIVING AT ONE IS AN EVENT** (user call: "make a planet system
  rarer, bigger and more of an event"). The layout table holds FEWER worlds and gives each survivor a
  bigger entourage: 19 authored planets → 15 (~80%), moon counts up ~30%, so the sky censuses 17
  planets / 59 moons where it held 21 / 48. Three rules keep that from costing anything:
  - **Cuts come off the DUPLICATES ONLY** — one of the two lava worlds and three of the six ice
    worlds. Never a unique archetype and never a landmark host, because both are load-bearing beyond
    flavour: "destroy one of every archetype" counts `PTYPE_COUNT` distinct ptypes and "strip every
    gas giant" wants three, and the storm/crater/geyser/forge/shepherd hosts and the Bastion siege
    are all found by lane (`planetAtOrbit`). A cut that takes a host doesn't error — the world just
    ships without that content.
  - **Moon COUNT and `MOON_ZONE_MUL` move TOGETHER**, both by the same factor. `spawnMoon` divides
    the zone into one slot per moon, so scaling one without the other silently re-tunes how tightly
    packed a family is — and the slot width IS the sibling-clearance margin the no-crossing rule
    (`exCap`) depends on. Moving both leaves every margin exactly where it was.
  - **Wider families are only safe because the sky turns one way** — see the all-prograde rule below.
- **THE SKY TURNS ONE WAY** (user call: "planets orbit in the same direction… less worry about
  planets and systems ramming into each other"). `addPlanet` fixes every sun-anchored planet
  prograde; one in six used to be drawn retrograde. This is not cosmetic. Moon families deliberately
  overlap radially, and the railed-conjunction pass-through that makes that safe is gated on
  `closing < DMG_THRESH` — a retrograde lane meets each neighbour at the SUM of their angular speeds
  instead of the difference, so its conjunctions come round several times more often AND arrive at
  roughly twice the closing speed, on the wrong side of that gate. Deleting the class of event beat
  guarding it, and it is what paid for the wider families above. Moons keep their ~15% retrograde
  variety — a retrograde MOON stays inside its own slot and meets nothing. **The rng draw the
  constant replaced is kept and discarded**: every angle, mass and feature below it comes out of the
  same seeded stream, so removing a draw would reshuffle the entire sky.
- **Enemy density is deliberately sparse** ("too many enemies, not enough normal worlds"): most planets are
  free. Nests and the dense fields' **shoal-lurker broods** are the *only* alien sources — there is no
  global wave spawner; a destroyed nest quiets its region forever, and a field's brood is a FINITE
  per-run budget (`FIELD_BROOD`) — kill the last of it and that field is quiet for the run (same rule:
  consequence traces to a player choice). Aliens are territorial (grabbers leashed to `ALIEN_TERRITORY`
  of their nest; lurkers to `FIELD_TERRITORY` of their field anchor — they never leave the shoal).
- **The shield is an ABILITY, not base — and its SHAPE is spec DNA:** you start with NO shield — the
  whole health pool is hull, which does NOT self-heal. It otherwise resets to full on respawn, and it
  mends in exactly three sanctioned places, each of which costs something:
  1. **Glow-pocket motes** (below) — you have to fly to the pocket, and pockets never refill in place.
  2. **A DOCK** (`CFG.DOCK_HEAL`, 6 hull/s — see *Docking* below) — you have to land on a world and
     stop, which means being out of the fight while the clamps are on. This is the exception that
     makes putting the ship down a real decision rather than a stunt.
  3. Any pick that RAISES hullMax heals the gain +20% (`main.healOnHullGain`), so a hull upgrade
     never just widens an empty bar.

  A `shield`-channel ability UNLOCKS the regenerating
  shield (rank 0 → `shieldFrac`/`shieldMax` 0, no SHLD bar), which absorbs first and recharges after
  quiet time. **THE SHIELD IS SCOUT-ONLY** (`shipStats`) — exactly one row in the whole catalog feeds
  the `shield` channel, and the other two specs answer an incoming hit with mass instead:
  - **SCOUT (Phase Screen)** — WEAK (16%→26% of the pool) but FULL-WRAP and snappy: scout-only
    regen ×1.6 and regenDelay ×0.6 come from the spec, not an ability. A thin layer that covers every
    angle and comes back fast is the whole of the scout's defence — it is a forgiveness mechanic for
    a ship with no armour, and it is deliberately not enough to stand and trade with.
  - **HAULER — none.** The orbit rock wall is its protection, and since 2026-08 that wall is a
    THREE-row build rather than one: Orbital Sling carries the rock (up to 14 slots), Guard Sling
    makes it break formation to block, Rockwall (5x HP at max) lets it survive the block. Reinforced
    Hull armors what gets through. Splitting carry from screen is the point — a hauler who wants an
    active wall has to spend a pick on one.
  - **BRAWLER — none.** Its protection is hull plus what the fused War Rack prow eats head-on
    (`physics.collideShipBody` → `spendRam`), which is spent by what it absorbs and rebuilt only by
    going and finding more rock. (History: it carried **War Plating**, a thin front-arc plate at
    12%→26% of the pool covering 35% of bearings with the fastest cycle in the game — regen ×1.5,
    regenDelay ×0.35, before that 38%→65% of the pool at a π/2 arc. It is DELETED, ability and
    spec-DNA recharge multipliers together. A regenerating layer is a forgiveness mechanic, and on
    the spec that is already the tank it undid the ram's own bargain: charge in, lose the plate, back
    off for a heartbeat, charge again. The ram only costs something if the damage it eats is damage
    you actually keep.)

  **The ARC mechanism outlives its user.** `st.shieldArc` is the plate's half-angle around the nose:
  a directional hit (`hitAng` in `physics.damageShip`) landing outside it skips the shield entirely,
  and **directionless damage** (heat, gas crush, Oort grinding — no `hitAng`, nothing to face) is
  SPLIT by coverage, the shield soaking `arc / π` and the rest going straight to hull. Render feathers
  every shield visual to the same wedge. No live ability produces a partial arc — Phase Screen is a
  full wrap (share 1) — but the mechanism is kept as the one place a directional shield is expressed,
  and **devtest T6 exercises it against an EXPLICIT wedge written onto `game.st`** so it cannot rot
  unnoticed between users. **Anything asserting the split must DERIVE it from `st.shieldArc`** — a
  hardcoded half re-breaks every time the angle moves.
  - **HAULER has NONE** — by design its protection is the orbit rock wall (Guard Sling makes it
    screen, Rockwall hardens it, Reinforced Hull — id `cargoPlating` — armors the hull); never add a
    `shield`-channel ability to its pool.
  The SHLD HUD bar appears only once a shield is unlocked; below that the HULL bar stands alone.


## Docking, stations and the home port (added 2026-08)

**A world is somewhere you can STOP.** Everything else in this game treats a planet as an obstacle,
a resource or a weapon; this is the one verb that treats it as a place. It rests on
`CFG.SURF_FRICTION` (docs/physics-invariants.md) — without contact friction a world cannot be landed
on at all, only bounced off.

**A DOCK IS A STRUCTURE, NOT A STATE.** That is the load-bearing decision and everything else follows
from it. Three pieces of state, and keeping them separate is the design:

- `game.docks` — every station standing (or half-built) this run, `{ b, ang, rf, t }`. Bounded by
  `CFG.DOCK_MAX`; the oldest NON-HOME station retires when it binds (losing the place you respawn at
  because you built a shed somewhere would be the worst thing that cap could do).
- `game.dock` — the station the ship is BERTHED at right now. A **reference into `game.docks`**,
  never a copy: the build clock ticks on the station, and a copy would bank the seconds somewhere
  that is thrown away on lift-off.
- `game.home` — the RESPAWN POINT. Promoted from the current berth by the **H key**, and never by
  landing alone. Berthing somewhere to patch the hull must not silently move where a death puts you
  back; that is the one thing in a run worth a deliberate keypress. Only a FINISHED station may be
  promoted. One at a time, and **it dies with its world** (`updateDock` clears it with its body, and
  says so — `homeLostName`; losing your home port must never be something the player discovers by
  dying).

**BUILDING IT IS THE COST, AND IT IS PAID EXPOSED.** Berth on bare ground and a station starts going
up: `CFG.DOCK_BUILD` (10s) of staying put, and until it is finished you get *nothing* — the shield
dome, the damage immunity and the repair all gate on `physics.dockReady`, never on merely being
berthed. A station that protected you while it was still going up would make its own cost free. Once
built it **stands there for the rest of the run**: fly away, come back, berth immediately with
everything live from the first moment. Progress banks on the station, so an interrupted build resumes
rather than being discarded, and it only advances while you are berthed — you are the one building it.

**Stations are `{ b, ang, rf, t }` — a body, a SURFACE-LOCAL bearing, a fraction of that body's radius**
(`util.padPos`), never a world coordinate. The same law as a chart waypoint (starmap.js) and then
some, because a world both ORBITS and SPINS: a coordinate pair is stale within a frame, and a bearing
that didn't subtract `b.rot` would leave the pad sliding across the surface as the world turned. The
radius is a FRACTION so a world chipped down under fire keeps its pad on the crust rather than
floating where the crust used to be.

**A HOME RESPAWN ARRIVES BERTHED (2026-08).** A death with a live home port hands the ship back IN
the clamps — `physics.berthAt`, called from main.js's respawn path — docked, shielded, repairing, one
thrust from a launch, rather than hovering over its own pad to re-earn a berth it already owns. It
lives in physics.js because the landing latch is module scratch there: a `game.dock` set without
seeding it is cleared by `updateDock` on the very next substep. `berthAt` re-seats `rf` off
`surfRadius` plus 0.92 of the CURRENT hull radius — a sliver INTO contact, because seated exactly at
the boundary, contact is a floating-point coin flip and the latch drains (the seating lesson
devtest's `setDown` documents). The `DOCK_LIFT` hover placement in `world.respawnShip` remains as the
staging the berth overrides, and the no-home respawn still uses the run's opening orbit. Either way
the ship arrives riding the surface velocity, so a home world orbiting at 700 u/s doesn't hand the
ship back standing still in front of it.

**A DOCK IS WHERE YOU STOP WORKING.** The beam, the orbit ring, the Recovery Tether, the shotgun and
the mobility abilities are all inert while berthed — `main.dockBlocking` refuses their inputs and
update() skips their per-substep work outright. Half-disabling them was the trap: a beam you can
still fire from a pad re-fills a ring the dock just emptied, and a warp tears the hull off a station
it is clamped into without ever running the release. Anything still in hand is let go AT THE BERTH
(`tractor.standDown`, before the station finishes building) — rocks left welded to a parked ship
would orbit a structure they also phase through, with no input able to clear them. It is a DROP, not
a volley: firing your whole shield across the landscape because you touched down would be the landing
doing something violent nobody asked for, and it earns nothing (the `drops` counter belongs to
deliberate gentle put-downs). `dockBlocking` is deliberately separate from `menuBlocking`: H, M, V, P
and R all still work at a dock, because standing at your own home port unable to open the chart
would be absurd.

**THE PAD RE-SEATS TO THE SHIP USING IT.** `rf` is the hull's standoff, measured off whatever ship
built the station — but the ship grows from radius 4 to ~44 across the tiers, and the clamps pin the
hull to exactly that height. Left at its build-time value, returning to an early pad in a bigger ship
parks the hull short of contact or buries it in the crust. Re-measured on every berth, which is also
honest about what a station is: the art already refits to your current tier, and so does the berth.

**THE GROUND HAS TO BE ABLE TO HOLD A DOCK (2026-08).** Two refusals the landing gates issue that no
amount of flying can clear — their guide wording says "go elsewhere", never "fly better":

- **No berth in a wound** (`CFG.DOCK_CRATER_MAX`, gate `'crater'`). A pad is pinned at a fraction of
  the body's NOMINAL radius (`util.padPos` knows nothing about scars), so a station laid down inside
  a crater stood on the phantom surface — floating across the mouth of the hole the player can see.
  Ground cratered deeper than `DOCK_CRATER_MAX` of the radius (read off `util.scarSurfaceAt`, the
  same profile the collider and the silhouette draw from) refuses the berth outright.
- **A station whose footing is blasted away BREAKS** — the same `DOCK_CRATER_MAX` line, swept in
  `updateDock`. Aliens (or you) cratering the crust under a standing station collapse it: debris,
  shake, and a named message (`dockLostName`, or the alarm-grade `homeDockLostName` when it was the
  respawn point — where a death puts you back just changed, and that must never be discovered by
  dying). A structure does not survive its foundations, and the pre-rule behaviour — the pad
  hovering on its build-time standoff over a hole — read as a glitch because it was one.
- **A PORT NEEDS A WORLD THAT CAN CARRY IT** (`config.dockHostOk`, gate `'small'`). The berth is
  sized by the SHIP (the berth floor wins over `dockPadR`'s host cap), so a high-tier port on a small
  moon claimed most of the horizon — a megastructure the moon wore. The line is the berth floor
  against 0.55 of the host radius, deliberately looser than the 0.42 aesthetic cap: the cap is where
  a pad stops looking right, the gate is where it stops being plausible. It reads the same `berthR`
  the pad does, so the gate and the structure can never disagree about how big a berth this ship
  needs — and it therefore varies by SPEC as well as tier, which is correct: a brawler really is a
  wider thing to park. Host radius needed, tiers 0–5: hauler 26/26/44/76/132/230, scout
  26/39/75/116/197/321, brawler 26/37/68/130/231/384. Against the real sky (moons 41–232, planets
  293–1998) every moon hosts tier 0, the median moon carries to ~tier 3, the biggest moon takes a
  tier-4 hull, and a top-tier port is planet infrastructure. The same predicate runs in
  `updateDock`'s refit sweep: the art refits to your CURRENT tier, so a tier-up that outgrows a
  station's world DECOMMISSIONS it — retired quietly with a message (`dockOutgrownName` /
  `homeOutgrownName`), never a bang, because nothing destroyed it; the ship simply grew past what the
  world can hold.

**THE BERTH IS SIZED BY THE HULL AS DRAWN, NOT AS COLLIDED** (`config.berthR`, 2026-08). `st.radius`
is the collision circle and is deliberately one number for every spec — `SHIP_VIS` is what makes all
three ladders read the same SIZE, and its own note spells out the knock-on: everything that wraps the
ART rather than the hitbox multiplies by `vis`. A pad is as art-wrapping as anything gets, and it
never got that multiply, so the deck was sized for a hauler and every scout and brawler overhung it:
a tier-1 brawler's drawn hull reached 16.0 units across a deck whose half-width was 15.2 — **the ship
was wider than its own berth** at tiers 1–4 (scout 1–2, worst 0.88×). Multiplying the ship term by
`vis` makes the pad-to-hull ratio come out exactly the hauler's (1.43 → 1.92 as the tier widens the
deck for what stands on it) at every tier and spec, and leaves the hauler ladder untouched by
construction.

**A STANDING STATION LANDS YOU ITSELF (2026-08).** `physics.updateAutoland`, `CFG.AUTOLAND_*`: come
in close (`AUTOLAND_R`) and slow (`AUTOLAND_VMAX`) with the throttle released and the pad takes the
ship — eases the velocity down an approach vector (floored at `AUTOLAND_TOUCH`, under `DOCK_SPEED`,
so the stillness gate is satisfied at contact by design), stands the nose up, and lets the ordinary
three-gate latch do the rest. Returning to a dock you already built is never a piloting test twice;
the FIRST landing on bare ground is still flown by hand — the approach challenge is part of what a
station costs, and the autoland is part of what it pays back. **Hands-off is the contract, both
ways**: it never engages with the throttle up or against a ship that is plainly leaving, and any
thrust mid-approach hands the helm straight back and stands it down for `AUTOLAND_CD` — the same
cooldown a launch sets, so the pad that just threw you off cannot reel you back in. Dash and warp
count as hands-on too: neither touches the throttle, so without an explicit cancel the autoland
simply eased the dart back out, which is the game fighting the pilot.

**IT ONLY TAKES A SHIP THAT HAS A STRAIGHT LINE IN** (`padPathClear`). The approach is a straight
line — this is a docking aid, not a pathfinder — so engaging it with a world across the path would
drive the ship into that world, the exact thing the pilot is trusting it not to do. A segment-vs-disc
test over the local celestials runs LAST, after the cheap gates have picked a candidate. **The pad's
own host is tested too**, at 0.995 of its radius, and that is the elegant half: the pad sits on that
surface, so the segment only crosses the interior when the ship is over the horizon from it —
"can this berth be seen from here?" falls out of the same arithmetic, with no special case. While it flies,
the guide shows its hand (dashed approach line — helper UI, so dashes are the correct grammar — and
the ring naming who has the helm): a ship steering itself with nothing on screen saying so reads as
a stuck control. Deliberately NOT mirrored in `predictPaths`: unlike the rubber band and the long
arms it only exists hands-off inside one pad's approach cone and terminates at the berth — the
moments it is steering are the moments nobody is aiming a throw off the forecast.

**THE SHIP IS HELD, AND LEAVING IS A SEQUENCE.** A berthed ship stands UPRIGHT (`DOCK_UPRIGHT`) and
is pinned EXACTLY to its pad: the clamps own the attitude and the position, the mouse stops steering,
and W therefore always points straight off the pad. That is what makes a berth read as *held* rather
than as hovering — and aiming is unaffected,
since the beam and every throw go at the cursor and never along the nose. Thrust from a berth does
not drive the ship either; it CALLS A RELEASE (`CFG.LAUNCH_*`): clamps swing open, the engine lights
against them with exhaust washing sideways off the deck (it has nowhere else to go while the ship is
pinned, which is exactly what makes a held burn look held), the shake climbs, and then the pad lets
go. It commits once started — a launch you can abort halfway is a stutter, not a moment.

**A FINISHED BERTH IS A VISTA** (`CFG.DOCK_VISTA` / `DOCK_VISTA_K`, main.js's cinematic zoom). Once
the station is built the camera eases OUT — `DOCK_VISTA`× wider — so a berth becomes a moment to
survey the neighbourhood: the world you built on, its moons, whatever is inbound. It is gated on
`dockReady`, the same gate as the shield and the repair, so the exposed ten-second build stays at
flight zoom — the pull-back is part of the harbour's reward, not of the commitment. The ease rate is
deliberately slower than the tier zoom's (an establishing shot, not a level-up), and the frame the
launch spool starts the target snaps back to flight zoom at the normal rate, so the dive back in
overlaps the clamps releasing instead of following the kick. `viewR` rides the zoom, so sensors and
the wake bubble genuinely widen with the vista — safe, because a berth is the one place nothing can
touch you.

**HOME IS THE LIVES ROSE** (`render.DOCK_HOME`, matching the life pips' `#ff5c7a`). Not a new marker
colour: rose already means "a life" in this cockpit, and a home port is exactly the place a life
hands the ship back.

**But in-world it is A FLAG, NOT A PAINT JOB** (user call, 2026-08: "the only part of it that should
change is a flag shows up and it's a red flag, the colour of the rest of it should not change"). The
STRUCTURE stays steel at every station, home or not — a dock is the same building either way, and
repainting the whole thing said "a different kind of place" when the truth is "the same place, and
it's yours". So the rose lives entirely in the **lit spire and its pennant**, which is also why the
mark has a SHAPE: it reads as home from any distance without the structure ever changing colour. (It
used to wear a full RING and that was wrong twice over: the ring sat concentric-ish with the shield
dome and the two read as a lens of overlapping circles rather than as a mark on a structure, and a
ring says nothing about what a home port *is*.) The two INSTRUMENTS still mark home in rose outright
— that is their own grammar, where a colour is all a two-pixel blip has to work with.

**THE STATION'S ART TRACKS THE SHIP'S TIER** (`config.DOCK_TIERS`, six rows read via `dockTier(st)` off `game.st.tier`,
i.e. your CURRENT tier and not the one it was laid down at). A dock is infrastructure you keep
improving, so tiering up refits every station you own rather than leaving your first pad looking like
a shack forever. The ladder is a SILHOUETTE, not a detail pass — landing slab → gantry mast → second
clamp pair → control block → comms dish → working spaceport — and each row only ever ADDS, so the
thing you learned to recognize at tier 0 is still the thing in the middle at tier 5. The deck's width
tracks *what is standing on it*: a deck sized for the top tier at tier 0 reads as a derelict apron
with a toy in the middle. And `padSize` caps the whole structure against the HOST body with a berth
floor underneath the cap — multiplying the tier curve by the ship's own growth put a tier-5 port at
two thirds of its planet's radius, which read as a megastructure the world was orbiting.

The sprite is a REAL OBJECT (solid strokes, world-space line widths that scale with the camera — a
structure whose girders stay 2 screen-pixels wide as you pull away is a HUD element pretending to be
scenery) and it is CALM: steady lamps, no idle motion. Motion belongs to the build, the launch and
the one-shot bloom, all of which are events. It is composed around one constraint: **the origin is
where the ship parks**, so the parked hull is drawn over that point every frame. The deck sits BELOW
the origin (down into the crust, which is also what "seated" should look like) and the gantry and
blocks stand OUTBOARD in their own zones — the berth frames the ship instead of fighting it. An early
pass put a beacon at the origin and it simply vanished under the hull; another used wide soft blooms
for the deck lamps and they washed out the structure they were meant to be lighting (a runway light
is a POINT). The substructure block under the deck is what carries the visual mass — without it the
station is a line with sticks on it.

**THE STATION IS BUILT FROM MATERIAL, NOT LIGHT (2026-08).** Three near-opaque hull tones
(the module-local `HULL_DK` / `HULL_MD` / `HULL_LT` consts above `drawPad` in render.js) carry the structure's mass — caissons, deck plates, cabins, tanks are
FILLED bodies with seams and thickness — and the ink colour (steel / home rose) is reserved for lit
edges, markings, lamps and glass, which is what keeps a home port readable at a glance without the
whole building being made of glow. The pass this replaced drew everything as translucent ink strokes
and the station read as a hologram parked on the world rather than a thing standing on it.

**THE BUILD IS A WORKSITE, NOT A LOADING SCREEN (2026-08).** The ten seconds of `DOCK_BUILD` are a
staged ASSEMBLY (`render.bstage` windows, in construction order): the caisson and legs rise out of
the crust, the deck is craned in plate by plate (centre-out, each lowered with an ease-out), the
clamp arms unfold from flat on the deck up over the berth — the same joints the launch later swings
open, one mechanism working both directions — the mast telescopes, the cabins lower in, the dish
unfolds, and a commissioning pass paints the touchdown markings on and walks the lamps up one by one.
Every stage MOVES its piece into place: ten seconds of opacity ramps reads as waiting for a bar, ten
seconds of visible work reads as building. A constructor drone and weld glints (both off `game.time`)
mark where the work is right now — sanctioned motion, because the build is an event — and the solid
progress arc stays underneath as the honest clock. All of it is strictly gated on `prog < 1`: the
finished station is static except for its events.

**THE SHIELD DOME IS A REAL FIELD, NOT A DECAL.** It repels loose rock and aliens
(`physics.updateDomeShield`) as well as blocking damage — absorption alone is half a shield, and a
hull sitting inside a heap of debris it happens to be safe from reads as a bug rather than as
protection. That is also why the tier table lives in **config.js**: its drawn edge and its pushing
edge must come from one expression (`dockDomeR`), never two. Where it throws something off, the rim
flares — an EVENT, the one thing this otherwise-calm surface animates for.

**AND THE FIELD IS FINITE** (user call, 2026-08: "the dock shield shouldn't be invulnerable — it
should have a fixed amount but really high, it shouldn't recharge, and when it breaks the dock
breaks"). A berth used to be TOTAL immunity, which made a finished dock the one place in the game
nothing could ever reach you — a safe room rather than a fortification. It is a POOL now
(`CFG.DOCK_SHIELD`, 2400 ≈ 7.5 top-tier hulls or ~35 full CME passes), carried on the station as
`d.hp`, issued once at the build site and **never credited by anything** — not by time, not by
berthing, not by a tier-up. Each station has its own, so a second port is a second pool.

- **Two drains, one debit path** (`physics.spendDome`): damage that would have reached the ship, and
  the cost of throwing something off the rim (`DOCK_REPEL_COST`, priced on the same saturating mass
  knee as collision damage and capped per bite at `DOCK_REPEL_MAX`). Measured: a 4,267-mass rock at
  260 u/s costs 3.8 of 2400; three minutes berthed in ambient traffic costs ~0.2.
- **No free frame** — whatever the pool cannot cover reaches the hull on that same call, exactly the
  rule the ram runs on. Protection is total, then it is over, with no cliff between.
- **When it breaks, the STATION breaks** (`breakDock`) — the dome *is* the harbour's survival, so
  there is no such thing as a standing station with a dead shield, and it goes through the same
  collapse path a blasted-out foundation does.
- **EVERY VELOCITY IN THE REPEL IS MEASURED IN THE DOCK'S OWN FRAME** (`util.surfaceVel`, the same
  expression surface friction and the stillness gate read). The dome rides a world that orbits at up
  to ~700 u/s: read absolutely, a rock merely drifting alongside bills as a 700 u/s impact, and the
  separation floor is satisfied without the rock ever separating from a dome moving just as fast — so
  the same contact re-bills every substep at 120 Hz. Harmless while the field only pushed; the moment
  a repel cost charge it emptied the whole pool in about a second off one drifting rock ("the dock
  shield went almost completely away on one small asteroid hit").
- The dome **shows what it has left** through INTENSITY, never size or motion: the geometry stays
  exactly `dockDomeR` because that is the real collider, and a field drawn smaller than it pushes
  would be the mirror-drift trap in visual form. The cockpit carries the number on the **DOCK bar**
  (top-left, under the ship's own gauges) — in the dome's own pale ice rather than the ship shield's
  blue, because it is the one gauge there that measures something which is not the ship, and on its
  own fixed width rather than the hull/shield points-per-pixel scale, which a pool seven hulls deep
  would flatten.

**IT STANDS ON THE GROUND**, and getting that right is the whole job of drawing it. It
is centred on the SURFACE POINT under the pad — not the pad origin, which sits a hull-radius above
the crust — and CLIPPED against the planet's own disc, so its foot follows the world's curvature
instead of cutting a straight chord across it. A dome sized in pad units alone is fine on a big
planet and wider than the whole body on a moonlet; the clip is what makes one expression correct at
both. It is sized to ENCLOSE the station at whatever tier it is (it tracks the mast height) — a
shield with the gantry poking out of the top is not a shield. Calm and steady like the ship's own
shield rim; its detail is STRUCTURE (ribs, bands, emitter posts), never animation.

On the two instruments the marks obey each one's own grammar: the radar RIM-PINS them past the dial's
reach like the rescue dock and the journey do (the whole value is "which way is it from here", and
home is usually well outside 7,800 units), and the chart carries them under the route, since an
active journey's next stop stays the loudest thing on screen. Home is labelled on both; other
stations are findable, not shouting.


## Ship hull art

**THE HULL IS SPEC DNA (added 2026-08).** There are THREE ladders, not one, and
`drawShipHull` dispatches on `game.prog.spec` via `shipTierTable`. Each says what its spec DOES
before any HUD does, and the three silhouettes are kept deliberately disjoint — reading the spec
at a glance is the whole point of splitting them:

- **HAULER** (`HAULER_TIERS`) — the original ladder, geometry untouched. Ring arms with orb pods:
  the arms ARE the orbit rock rack. Its `Math.max(1.1, 0.07 * u)` outline expression is now the
  stroke weight for ALL THREE specs (see "One stroke weight" below), so its art is bit-identical.
- **SCOUT** (`SCOUT_TIERS`) — a winged SENSOR platform on a needle fuselage, wings **BARE**
  (the gun hardpoints were dropped 2026-08). **The ladder buys GUIDANCE, never armament**, because
  its kit is Nav Plotter / Lead Computer / Impact Warning / Reflex Jink and a ladder that grew
  barrels was claiming to be a gunship. It grows LONGER, NOT WIDER (length 2.2 → 4.4 against span
  1.6 → 2.5), and the wing PLANFORM evolves — crank, root extension, rake — so the silhouette
  changes tier to tier.
  Its gimmick is the GIMBAL: a sensor head that slews to `game.aim` independent of hull heading.
  **From tier 3 the hull SPLITS** — see below.
- **BRAWLER** (`BRAWLER_TIERS`) — a ram, and the ram is the class. `prowW >= 1.20` on every tier,
  so the prow overhangs the hull on BOTH sides; it owns the front ~44% of the length. The stern
  is drawn BARE on every tier because the spec has NO shield at all and its one layer (the ram) is
  welded to the bow — the weakness is visible from the hull alone.

**A TIER MUST CHANGE THE OUTLINE, NOT JUST THE DETAIL** (user design rule). Both new ladders were
first built varying only surface flags over one fixed shape, and six tiers read as ONE ship at six
sizes. Every rung now adds a NAMED system that moves the silhouette — brawler: prow, deflector,
rails, buttresses, sponsons, hammerhead, outriggers, double jaw; scout: guns, crank, arrays, split,
booms, nacelles, winglets, mast, sail.

**THE SPLIT HULL** (scout, tier 3+). The drive section flies loose behind the forward hull on a
gravity coupling. It is a COMPRESSION SPRING, not a linear ease: it only ever PUSHES the drive
against the forward hull, never pulls, so the drive drives. Thrust compresses it toward
`SPLIT_MIN`; release and it springs back out past its rest point and rings. Two hard stops carry
the character — it binds solid at `SPLIT_MIN` (bouncing off the stop) and cannot extend past its
free length, because a compression spring has nothing to pull with. It is sub-stepped at 16ms: a
spring that stiff integrated across a 0.1s frame goes unstable. **The halves must never touch**
or the conceit collapses into a hull with a seam. Turn rate leads the nose (clamped, and the
heading delta MUST be wrapped into -PI..PI or one pass through PI reads as a full-speed spin).
The coupling field follows `drawBeam`'s language — braided strands, additive, solid strokes — and
frays, jitters and arcs harder as `strain` rises. `scoutSplit` caches on `game.time` because
`drawShip`'s flame anchors and `shipVisualR` read the same number in different passes, and two
evaluations of a thrust-dependent value drift apart inside one frame.

**Outline width** is `outlineW(tier, r)`: `max(1.1, 0.07 * u_hauler)` — ONE weight per tier, shared
by all three specs and derived from the HAULER's art unit. It is never derived per spec; see "One
stroke weight, and it is the hauler's" below for why that was the whole bug. The `1.1` is a WORLD-unit
floor and it binds on the first three tiers — a known wart, kept because it is what the hauler has
always drawn.

Damage scars are seeded per
(tier, dmg) so they're stable frame to frame — don't swap them to `Math.random`. WHERE they land
is per-spec (`drawShipScars` takes an ellipse): sampled on the hauler's body disc they fall in the
empty air beside a scout's thin fuselage. The shield bubble wraps `shipVisualR(game, tier, r)` (the
drawn art's reach) PLUS the split stand-off on a split hull — without it the drive
section trails outside its own shield — not the collision radius. The collision radius is a UNIFORM `SHIP_HIT_FRAC` (0.66) of the drawn
footprint on every tier: `shipStats` reads it from `SHIP_RADIUS[tier]` (config.js), derived as
`SHIP_HIT_FRAC × footprint`, where the FOOTPRINT grows by an equal RATIO each tier (perceptual
evenness). render.js normalizes the art to the footprint (`u = r / (SHIP_HIT_FRAC × reach)`),
so tuning the fraction moves only the hitbox, never the drawn size. (History: the hitbox used
to be the body disc alone — 43% coverage at tier 0 vs 57% at tier 5 read as "collisions don't
match the ship".) Keep `SHIP_RADIUS` and `SHIP_ZOOM` in sync with the hull tables' proportions;
the derivation rules live in the config.js comments.

### The top tier is half again as big (2026-08)

`SHIP_RADIUS` is now `[4.0, 7.0, 12.5, 21.8, 38.2, 66.3]` — the old ladder with a multiplier that
ramps **linearly** from ×1.0 at tier 0 to ×1.5 at tier 5, so the Scout is untouched and the Titan is
half again as big. The per-tier growth ratio stays near-uniform (×1.62 → ×1.75), which is the
property that mattered; the ladder is simply steeper end to end.

Two things had to move with it, and both are documented derivations rather than taste:

- **`SHIP_ZOOM` holds APPARENT SIZE FIXED** — `zoom[t] = old_zoom[t] × old_radius[t] / new_radius[t]`,
  giving `[2.46, 1.70, 1.16, 0.82, 0.57, 0.40]`. `footprint × zoom` is unchanged on every tier, so
  the ship looks exactly as it always did in the viewport and the whole +50% is spent where it was
  asked for: **the ship against the worlds**. Known cost — tier 5 sits ~1.5× further back, so
  `game.viewR` goes 1987 → 2754 and the top tier's view covers ~1.9× the area.
- **`CFG.STORM_SHADOW_PAD` 45 → 68** — the pad is measured in ship-widths so the biggest hull fits
  behind the smallest moon, so it moves with the Titan and only with the Titan. Left at 45 the lee
  would have been 48.7 against a 66.3 hull; mechTest T21 asserts exactly this and would have failed.

### Every spec reads the same size as the hauler (2026-08)

The three hull ladders were each normalized to their own **max reach**, which makes the collision
fraction uniform but is NOT the same as looking the same size: a ladder whose reach comes from one
outlier — the scout's needle nose, the brawler's standoff deflector brow — gets its whole body shrunk
to pay for that outlier. Measured, the hauler read up to **1.49× bigger than the brawler** and
**1.33× bigger than the scout**.

`config.SHIP_VIS` is a second factor applied after the reach normalization, per spec and per tier, so
all three match. The hauler is 1 by construction — its shipped art is untouched.

**The metric is the ink's RADIUS OF GYRATION** (RMS distance of drawn material from the hull's own
centroid). Two simpler metrics were measured and rejected against a side-by-side sheet, and both look
right on paper, so the reasons are worth keeping:

| Metric | Why it failed |
|---|---|
| Bounding box (`sqrt(w×h)`) | Made the BRAWLER the biggest ship in the sky — the hauler's box is mostly the air inside its ring arms, the brawler's is solid slab. |
| Ink area (`sqrt(pixels)`) | Made the SCOUT enormous — a needle carries a third of the hauler's pixels, so matching counts stretched it half again the hauler's length at T3. |

Gyration splits them, and the check that it is the right split is that it **agrees with ink area on
the solid brawler** (1.27 vs 1.26 at T5) while still refusing to inflate the thin scout.

MEASURED, NOT FELT: `render.measureShipArt(game)` draws all three ladders off-screen and returns the
numbers; bake `hauler.raw / spec.raw × 1.25`. **Re-bake twice** — outline width is one shared weight
per tier (`max(1.1, 0.07 × u_hauler)`) that does NOT scale with the factor being applied, so a hull
drawn 1.25× bigger doesn't lay down 1.25× the ink; one pass lands within ~1.5–3.6%, a second
converges to **~0.2%**. Re-run it whenever a tier table *or the stroke weight* changes.

The knock-on to know: a spec's drawn reach is now `r / SHIP_HIT_FRAC × vis`, so scout and brawler
extend past their collision circle by that factor. That is the deliberate trade — `SHIP_HIT_FRAC`
stops being a per-spec constant so that apparent size can be one. Everything wrapping the ART rather
than the hitbox multiplies by it (`shipVisualR`'s shield bubble, `ramPlate`'s whole standoff — the
brawler's slab would otherwise end up NARROWER than the hull prow it mounts on, breaking "the ram
overhangs the ship on both sides at every size"). The sim's collision circle does not move.

**The target is `1.25 × hauler`, not `hauler`.** An exact match was the right correction and still
read a touch small on those two in play — a needle and a slab need more room than a compact ring to
carry the same weight on screen. The hauler is now the *smallest* of the three; it remains THE
REFERENCE because one spec has to anchor the measurement, and its art is the one that never moves.

### The ram's slab is floored at rock scale

**…the one thing `SHIP_VIS` could not fix.** It matched the slab against the
*hull*; the remaining problem was the slab against the *world*. Every proportion of the ram is a
fraction of the ship, which is right at the top of the ladder and absurd at the bottom: a tier-0
brawler is 5.4 drawn units, so a full rank-1 ram came out 15 units across carrying stones of radius
~1.2 — while the belt rock it is BUILT FROM runs radius 6–14 (median asteroid ~9). You crushed a
boulder three times longer than your whole ship and the nose gained three specks about one pixel
each at the gameplay zoom; the class's signature mechanic was invisible for the entire early game
(2026-08 user call: *"the brawler's ram rocks shouldn't be scaled down with the ship — at tier 0
they're so tiny it looks ridiculous"*).

So `config.ramPlate` sizes the slab off `hypot(r, CFG.RAM_MIN_R)` — a **soft** floor, deliberately,
for two reasons: it never stops growing with the ship (a hard `max` would draw tiers 0 and 1
identically and then jump), and it evaporates where it isn't wanted — **+391% at tier 0, +262% at
tier 1, +73% at tier 2, +11% at tier 4, +3% at tier 5**, so the top of the ladder is the slab that
was already tuned. **The floor is only the slab, never the mounting**: `back` and `gap` stay on the
true drawn hull, or a floored ram floats a ship-length out in front instead of ploughing on the nose.

**SIZE IT OFF THE STONE, NOT OFF THE SLAB.** What the eye compares is one ram rocklet against one
belt rock, and the rocklet is capped by the slab's DEPTH (`render.ramTierRocks`: `r <= 0.8 ×
depth/2`), so the floor has to clear that whole chain rather than merely look generous. `depth = rs ×
0.655` at a full rank-1 ram, so a stone of radius R needs `rs >= R / 0.262`. Belt rock runs radius
6–14 (median ~9), and **26 lands the tier-0 stones at ~7** — a real rock, mid-class for the rock the
ram is built from. `RAM_MIN_R = 10` was the first attempt and was still wrong: it tripled the slab
and the stones came out ~3, under the smallest gravel in the sky. Check the STONE when retuning this,
never the slab.

The knock-on is deliberate and follows the mirror rule: `ramFace`/`ramArc` read the same plate, so a
low-tier ram's contact edge and protected arc grow with what you can see (tier 0 rank 1: 27° → 31°,
contact edge 15 → 29 units; the top of the ladder goes 36° → 38°). Physics reading an *unfloored*
slab is exactly the drift the rule exists to forbid. Absorption is unaffected either way: it is
priced on ram MASS (`CFG.RAM_ABSORB`), which no part of this touches.

### A ram is smashed together, at the expense of width

**The slab's thickness sizes the STONE, and the WIDTH is whatever that many stones occupy shoulder to
shoulder** (2026-08 user call: *"this is a RAM, they should be smashed next to each other always at
the expense of width"*). `halfW` used to be its own ramp on `t` and `g`, and an independent ramp is
exactly the bug: the width grew while the stone stayed capped by the slab's depth, so the pack got
wider without getting fuller and the stones ended up hanging apart on their beams with daylight
between them — a fence, not a ram.

The chain, all of it in `config.ramPlate` so there is one geometry:

- `stone = depth × RAM_STONE` — one course is one stone thick, which is what makes `depth` the honest
  measure of a ram's substance.
- `halfW = stone × (0.7 + ramPack(t) × (ramPerRow(t) − 1))` — render seats the outermost centre at
  `halfW − 0.7 × stone` and spreads the rest evenly, so this is precisely the width at which the
  centre spacing comes out `2 × stone × pack`.
- `ramPack` is under 1 at every band, so the stones **always** touch — 0.92 at band 1 tightening to a
  0.79 overlap at band 12. That is the loose-rubble-to-fused-wall story now, told by how hard the
  stones are jammed rather than by how far apart they float.

`ramRows`/`ramPerRow`/`ramPack`/`RAM_STONE` are **exported** for exactly this reason: render builds
the layout from them and config solves the width against it, and a pack geometry living in two files
is the mirror-drift trap. The plate publishes `stone` rather than letting render re-derive it, and
render's per-stone jitter is bounded at ±10% and paid for by `ramPack`'s margin so even the two
smallest neighbours still touch. **Nothing in `ramTierRocks` may size a stone from the width again.**

**And the inverse: `halfW` may never be clamped either.** Both clamps have now been tried and both
were reverted (2026-08, QA #201/#202). A `Math.max(halfW, r × 1.05)` floor is daylight *by
construction* — render seats the outermost centre at `halfW − 0.7 × stone` and spreads the rest
evenly, so any width the stone did not pay for goes straight into the gaps: the effective packing
factor ran to **6.8** (tier 5, band 1 — two stones 210 units apart across a 233-unit slab), and it
bound at band 1 on *every* tier, which every ram passes through on its first rock and again as it is
spent. A `Math.min(rs, r × 2.5)` cap on the size basis is the same mistake one step upstream: `rs/r`
is 4.95 at tier 0 and falls monotonically to 1.03 at tier 5, so a cap loose enough to spare the top
of the ladder never binds anywhere, and any cap that binds at all bites hardest at tier 0 — putting
the stones at radius **3.5**, the value `RAM_MIN_R`'s own block rejected. The measured packing factor
is now exactly `ramPack(t)` at every tier × band × fill, 0.920 down to 0.788, with no exceptions.
If the slab genuinely needs to be wider, **raise the stone or the pack and let the width follow.**

The overhang the class's header talks about is the **hull prow's** job, not the rock slab's:
`render.BRAWLER_TIERS`' `prowW` is never below 1.20 hull half-widths, tier 0 included ("a prow flush
with the hull line stops being a ram and becomes a nose"). That is what frees the rock to come out
*narrower* than the hull at the bottom of the density ladder — band 1 is two boulders, and on a Titan
they are meant to read as two boulders.

A useful side effect: with the width now following the pack instead of running ahead of it, the
protected-arc inflation from the rock-scale floor above mostly went away. What remains is that the
arc is **tier-dependent by construction** — `back`/`gap` ride the hull while the slab rides `rs` —
and it spans roughly **4.5° (tier 5, band 1, nearly spent) to 59.5° (tier 0, band 12, full)**. That
is deliberate and is the same mirror rule the section above states: the arc that protects you is the
slab you can see. `src/physics.js`'s "~38° empty, ~48° full" note predates the derived width and no
longer describes the range.

### The ram's density ladder is twelve bands, two per rank

`config.RAM_TIERS` (2026-08 user call: *"instead of 6 visual ram looks, 1 per level, it should be 12,
2 per level, to give it a bit more granularity"*). Rank is still six and still the ceiling; what
doubled is how many builds the pack walks through as it fills. **The even bands reproduce the old
six-band ladder exactly** (2→old 1, 4→old 2, … 12→old 6), so every rank tops out on the build it
always did and the odd bands are pure new ground — the same course, looser packed, on a slightly
smaller slab.

**Band 1 is a PAIR** (2026-08 user call: *"the lowest visual level should be just 2 rocks"*) — the
one count the old ladder never had a rung for, and what makes the bottom read as two boulders
dragged onto the nose rather than a thin course of something. `perRow` is anchored at 2 and 8 over
eleven steps, which is what puts the six even bands on exactly 3/4/5/6/7/8.

`RAM_TIERS` is the one place the length lives, and **three things are keyed off it and must move with
it**: the `t` coefficients in `ramPlate` (halved when this doubled, so the per-rank endpoints hold),
`render.ramTierRocks`' rows/perRow/packK ramp and its beam-rig count (same endpoints, twice the
steps — `perRow` rounds every *other* band on purpose, since a stone count ticking up twelve times
would put 14 across the bow), and `physics.spendRam`'s per-drop spall (halved to 1–2 pebbles: a
downward crossing now happens twice as often, and doubling a brawl's spall against one debris budget
would break invariant 7).

### One stroke weight, and it is the hauler's

**The hull outline is computed once per tier off the HAULER's art unit and handed to whichever hull
is drawing** (`render.outlineW(tier, r)`). Do not derive it per spec.

The trap this closes is subtle and bit twice. Every spec's stroke used to be `k × u`, and `u` is an
*art-space* unit — `r × vis / (SHIP_HIT_FRAC × reach)` — so it means something different on each
ladder: the tier-5 reaches are 1.85 (hauler), 2.75 (scout), 2.56 (brawler), and `SHIP_VIS` scales two
of them up on top of that. **Equal coefficients over unequal units are unequal strokes.** The scout
and brawler ran `0.085` against the hauler's `0.07`, which was survivable while all three normalized
to the same reach and stopped being survivable the moment `SHIP_VIS` scaled them up — at tier 5 they
drew ~27% and ~36% heavier. Dropping them to `0.07` narrowed it and *could not close it*: the brawler
still drew 1.20–1.29× the hauler's line at tiers 3–5.

Since `SHIP_VIS` matches all three to one apparent size, one line weight is the correct line weight
for all of them. The hauler's expression is reproduced exactly, `Math.max(1.1, 0.07 × u_hauler)`,
floor included — that 1.1 is a WORLD-unit floor that binds on the first three tiers, a known wart
kept deliberately because it is what the hauler has always drawn and what the user calls correct.

**Re-bake `SHIP_VIS` after any stroke change** — outline width feeds the ink the size match is
measured from.

### The scout's wings are bare (2026-08)

The pod-and-barrel wing hardpoints are gone, and with them the `hard`, `coils` and `longBarrel`
fields. The class loses nothing structural: it was already documented as escalating **guidance**
rather than armament (its kit is Nav Plotter, Lead Computer, Impact Warning, Reflex Jink, and the gun
count was frozen at four from tier 2 on), so the hardware that actually carries the ladder — gimbal,
dishes, fire-control arrays, sensor booms, the crescent sail — is untouched, as is the evolving wing
planform that carries the silhouette.

One piece of fiction is now dangling and is worth a decision if the class is revisited: the **intake
maw and hopper still feed a weapon system that no longer exists**. The feed conduits were retargeted
to read as structural plumbing, but "it arms itself by swallowing rock" is no longer drawn anywhere.

## The crumble layer draws instanced (added 2026-08)

**A piece of a world is a sprite, not a path** — under WebGL2, for pieces under 14 drawn units.

`drawBody`'s `b.chunk` branch sits ahead of the asteroid one, so chunks never reached `blitRock` and
the whole instanced rock path did not apply to them — which is exactly backwards, because a cascade's
output *is* chunks, in their thousands. Measured with 2,000 chunks on screen,
`rockPathStats().rocksLastFrame` reported **1**. They now go through their own archetype family
(`SHARD_*` in render.js): 2,000 chunks, **2 draw calls, 3.48µs → 0.48µs each, 7.2x**.

Three rules carry it:

- **The bake is NEUTRAL and the colour is a per-instance tint** (`aTint` in rockgl.js, a multiply on
  premultiplied source). Chunk colour is the host world's own face, so ~30 colours are live in a run;
  a row per colour would be 120 atlas rows and straight past `ATLAS_BUDGET`. Baked neutral it is
  **four rows for the entire crumble layer on every world in the sky**. The multiply is exact because
  every layer of the sub-14 shard is a scale of one colour — face is the colour knocked down 34%, the
  crust strip is the colour at full. Verified by rendering the same frame both ways: identical.
- **The bucket cut sits where `drawChunkSprite`'s slab layers switch on** (`R > 14`). Above it a piece
  is big, rare, and something you fly right up to, so it keeps a unique silhouette exactly as big rock
  does — and the pale facet wedge would not survive a multiply anyway.
- **A wounded chunk keeps the vector sprite.** The GL layer composites after the body loop, so a crack
  web drawn in `drawBody` would land *underneath* the sprite it marks. A size gate ("the wound is
  sub-pixel, skip it") was tried and rejected: it makes the crack web pop into existence as you fly
  closer and the piece crosses back to vectors, and a wound on debris is a real signal — it is how you
  read what you have already hit. Fresh crust is unwounded, so the cascade population is covered.

The shard family has its **own sheet geometry and its own tiers** (12 archetypes x 4 rows, up to a
32px bake). The rock family's size cap is a *2D-blit* economic rule — past ~25px a rotated, filtered
`drawImage` costs more raster than a small polygon fill. Instanced GL has no such crossover. Real
crust debris measures a P50 drawn radius of ~19px at the game's own zoom, right past the rock cap, so
capping shards there would have rejected the entire layer this path exists for.

## The sun is a place, not a light source (added 2026-08)

The star is `radius` 4,800 — it fills the screen from a lane out and keeps filling it all the way in.
It used to be a flat cream disc wearing four soft blobs, seven wire-thin prominence arcs and four
brown smudges, and the complaint that started this was exactly right: *"the scale of it is massive but
none of it really reads."* Nothing on the surface had a size of its own, so there was nothing for the
eye to measure 4,800 units against, and the disc read as a sticker at every distance.

Everything below lives in `render.drawStar`.

### Detail at three scales, each fading in at its own zoom

| Layer | World size | Carries |
|---|---|---|
| supergranules | ~1,000-unit cells, live, **both signs** | the surface at any distance where a granule is sub-pixel |
| granulation | baked tiles at three spans — cells ~129 / 43 / 14 units | what resolves as you close in |
| chromosphere | ~50-unit boil cells on the limb | the scale itself — see below |

**The coarse scale is LIVE and the fine scales are TILED, never the other way round.** A tiled texture
1,500 units wide repeats three times across the disc and the eye reads that as wallpaper. Live cells
never repeat and always evolve, which is what that scale needs; a 14-unit cell repeating ninety times
reads as grain, which is what *that* scale needs.

**The supergranules come in both signs.** They were additive-only at first, so the disc could only get
*brighter* in patches — mottling needs the dark half, or the surface reads as a clean sphere with
lamps on it. The dark set is bigger, slower and fainter than the bright set.

**Granulation must BOIL.** Rigidly rotating one tile at `SUN_SPIN` (~1°/s) is a static texture — caught
on sight. There are **three different bakes** and each octave cross-fades between them on its own
clock (`boil`, 17 / 9 / 5s — the smaller the cell, the shorter it lives), each bake at its own bearing,
so cells dissolve where they were and appear where they weren't.

**Each octave fades in slowly with drawn cell size** (full at ~22px, gone under 8px). Granulation that
reaches full strength at a few pixels per cell turns the whole disc into an even speckle — orange peel
— and an even speckle flattens a sphere exactly as hard as no texture at all.

### The limb is the point, and the smear is deliberate

The photosphere is a **filled path**, so however softly it is shaded inside, it *ends*: a solid amber
disc butts against the corona and the step reads as a stroke the whole way round. Nothing painted on
the face can fix that, because the clip is what makes it.

**THE SMEAR** (`sm`, `R*0.88 → R*1.10`, source-over): the disc's own limb colour pushed outward past
where the fill stops, so photosphere colour is on both sides of the boundary and there is nothing to
lock onto. Additive is wrong here — adding light *at* the edge brightens the seam.

**It is wide on purpose, and it is not to be tightened.** A feather that hugged the outline was built
and it dissolves the seam more cheaply, but flying the limb then reads as skimming a big warm object.
This is a STAR: a few hundred units off the surface the whole view should be drowning in its light.
That effect is the feature. *"It should look overwhelming, it's the sun!"*

**The fringe is CELLS, not strands.** Individual spicule jets were drawn here first and every one read
as a HAIR — a stiff, separable, faintly comic fringe that made the star look furry rather than molten.
Soft blobs that each feather to nothing, **straddling** the surface rather than standing on a common
standoff (a shared standoff puts every feather at one height and the fringe grows a second edge of its
own), merge into one ragged hot boundary that churns.

Two related traps already paid for, both in the same family:

- **Prominences are filled tapered RIBBONS, in six faint nested bands.** Walked as N short strokes
  under `'lighter'`, every round cap overlaps its neighbour and blends twice — up close a loop came out
  a visible **chain of discs**. And one wide band at a readable alpha prints its own crisp boundary
  across the screen when you are close enough to fly through the loop; stacking thin bands is how a
  fill gets a soft shoulder. The sheath carries the read, the core is only a hint inside it: a bright
  constant-width wire on a limb this long is an antenna, not plasma.
- **The corona is a union of soft LOBES.** Wedge streamers (a fan filled through a radial gradient)
  read as searchlights, and a single lumpy envelope *path* prints its own outline, because the
  gradient still has alpha wherever the envelope dips inside its own maximum. A lobe that feathers to
  zero on its own can do neither. Their tails need a smooth multi-stop falloff — a gradient running
  linearly to zero has a kink at its outer stop, and where several overlap that kink draws an arc in
  the corona.

### No sunspots

A full anatomy was built and cut: bipolar groups, irregular umbra, filamented penumbra, facular plage,
tuned from near-black up to warm ember. At this size a spot is a **large dark object sitting on a
surface that is otherwise all light and motion**, and it read as damage rather than as weather however
the tones were graded. The star is better as a body that is uniformly, enormously alive. (The
filaments had their own trap on the way: drawn long and sparse they reached past the penumbra fill
meant to contain them and every spot came out a sea urchin.) Don't re-add spots without solving the
"reads as damage" problem first.

### Cost is bounded by the screen, never by the sun

The pattern fills clip to the photosphere and the canvas bounds the raster. The limb passes walk only
the bearing window the camera can see, solved as a **circle-circle intersection** (`limbWindow`) rather
than `drawStormWave`'s `asin(viewR/d)` approximation — the camera can sit *inside* this body, where an
asin window is meaningless. Measured: the `perf` suite reports no change against the pre-change
baseline.
