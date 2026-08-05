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

  **NEITHER applies to the orbit shield or the brawler's trail rack** (`tractor.updateOrbit` owns
  those, with its own caps): those are formations you have already paid for, and re-spooling every
  rock in a seven-slot ring on every capture would make the wall sag exactly when it is being shot
  at. The grip is VISIBLE — `game.heldGrip` feeds `render.drawBeam`, which draws a fresh or heavy
  hold thin, dim and fluttering and settles it as the emitters take hold; at grip 1 it is exactly the
  beam it always was. A mechanic the player cannot see reads as the beam being broken.
- **A MOON OR A WORLD MUST BE WINCHED BEFORE THE BEAM HAS IT AT ALL** (`config.latchTime` /
  `tractor.updateLatch`). **Nothing below the moon rungs winches** — belt rock takes hold on the
  click exactly as it always did, and the whole early game is untouched. Taking a world is an ACT,
  not a click.
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
  - **SHIP MASS IS PER-TIER** (`config.SHIP_MASS`, 10 → 4,200 across the ladder), because a rope
    resolves by mass RATIO and a constant-10 ship meant a Titan wrestled a moon exactly as badly as
    a Scout did. Derived from the drawn footprint — `SHIP_RADIUS` grows ×1.62 a tier and mass rides
    it at the power 2.5 (between area and volume; a ship is hull and framing, not a solid lump).
    Measured load:ship ratios — t0 scout vs a 1,200 rock **120:1**, t2 vs a 5,000 boulder **45:1**,
    t4 vs a 9,000 moon **7:1**, t5 titan vs a 220,000 world **52:1**. Re-derive it if `SHIP_RADIUS`
    ever moves.
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
    winch outright; nothing is banked for the next press.
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
- **THE BEAM GRIPS THE SIDES OF A BODY, NEVER ITS MIDDLE** (`render.gripPoints`). Strands that
  converge on the centre read as passing straight THROUGH the rock, and on a moon or a world — whose
  disc is most of the screen — they bury the whole effect under the sprite where none of it can be
  seen. Every strand lands on the rim, spread either side of the bearing facing the ship, with the
  contact glows and the bright limb arc out there with them; a bigger load is taken in a wider
  embrace. **And the winch AMPS UP**: `drawLatch` scales everything by an eased `amp` from near-zero,
  so the effect builds into the full hold with no visual step at the hand-over. The progress ring is
  the exception — full brightness from the first instant, because it is the one element that has to
  be legible before the effect is.
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
      and the collider's whole narrow phase is a single radial query. `OUTLINE_FLOOR` is how close to
      the middle a surface may come (0.19 of the mean radius).
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
- **Hover hint ring colors:** green = auto-orbits, cyan = holdable, red = too heavy. (`render.js:1055`)
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
  quiet time. Each spec's shield is deliberately different (`shipStats` + `st.shieldArc`):
  - **BRAWLER (War Plating)** — a THIN, FAST-RE-FORMING FRONT PLATE (12%→26% of the pool) covering
    **35% of bearings** (`shieldArc` = 0.35π, ±63° off the nose), with the quickest cycle in the game
    (regen ×1.5, regenDelay ×0.35 — ~1.75s and the nose is covered again). **Its identity is the
    CYCLE, not the capacity.** (History: it was 38%→65% of the pool, which made it simply the best
    shield in the game — converting most of a brawler's health into a regenerating layer meant the
    front-arc drawback never cost anything, because the pool never ran out while you faced the right
    way. And the arc was a clean π/2, i.e. 50%, which covered everything ahead of the beam — "front
    arc only" was barely a drawback in practice. 35% is a genuinely narrow nose plate: you have to
    point at what is hurting you.) A directional hit from behind (`hitAng` in `physics.damageShip`)
    skips the shield entirely — the tail is bare, so facing the threat matters. **Directionless
    damage** (heat, gas crush, Oort grinding — no `hitAng`, nothing to face) can't be dodged by
    aiming, so it is SPLIT by coverage: the shield soaks `arc / π` and the rest goes straight to hull.
    Soaking all of it made the front-arc drawback free in exactly the places it should bite. Full-wrap
    shields are unaffected (share 1). **Anything asserting that share must DERIVE it from
    `st.shieldArc`** (devtest T6 does) — a hardcoded half re-breaks every time the angle is tuned.
    Render clips every shield visual to the covered wedge — the bare tail must READ.
  - **SCOUT (Phase Screen)** — WEAK (16%→26%, max 3 ranks) but full-wrap and snappy: scout-only
    regen ×1.6 and regenDelay ×0.6 come from the spec, not an ability. Both shields are thin now, so
    the CYCLE is what separates them: the brawler's is smaller and returns nearly twice as fast, the
    scout's is a touch slower back but covers every angle.
  - **HAULER has NONE** — by design its protection is the orbit rock wall (Rockwall hardens it,
    Reinforced Hull — id `cargoPlating` — armors the hull); never add a `shield`-channel ability to its pool.
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
floating where the crust used to be. `world.respawnShip` places the ship `DOCK_LIFT` hull-radii ABOVE
the pad (materializing flush with the collider means being shoved off your own dock on frame one) and
riding the surface velocity, so a home world orbiting at 700 u/s doesn't hand the ship back standing
still in front of it.

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

**THE SHIP IS HELD, AND LEAVING IS A SEQUENCE.** A berthed ship stands UPRIGHT (`DOCK_UPRIGHT`) and
is pinned EXACTLY to its pad: the clamps own the attitude and the position, the mouse stops steering,
and W therefore always points straight off the pad. That is what makes a berth read as *held* rather
than as hovering — and aiming is unaffected,
since the beam and every throw go at the cursor and never along the nose. Thrust from a berth does
not drive the ship either; it CALLS A RELEASE (`CFG.LAUNCH_*`): clamps swing open, the engine lights
against them with exhaust washing sideways off the deck (it has nowhere else to go while the ship is
pinned, which is exactly what makes a held burn look held), the shake climbs, and then the pad lets
go. It commits once started — a launch you can abort halfway is a stutter, not a moment.

**HOME IS THE LIVES ROSE, on all three surfaces** — the in-world pad, the radar and the chart
(`render.DOCK_HOME`, matching the life pips' `#ff5c7a`). Not a new marker colour: rose already means
"a life" in this cockpit, and a home port is exactly the place a life hands the ship back. Other
stations are steel — somewhere you can go, not the place you have committed to. The home port also
flies a **lit beacon spire with a pennant**, so the two are told apart by shape and not by hue alone.
(It used to wear a full RING and that was wrong twice over: the ring sat concentric-ish with the
shield dome and the two read as a lens of overlapping circles rather than as a mark on a structure,
and a ring says nothing about what a home port *is*. A spire does — it caps the gantry at the tiers
that have one, and it competes with nothing.)

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

**THE SHIELD DOME IS A REAL FIELD, NOT A DECAL.** It repels loose rock and aliens
(`physics.updateDomeShield`) as well as blocking damage — immunity alone is half a shield, and a hull
sitting inside a heap of debris it happens to be invulnerable to reads as a bug rather than as
protection. That is also why the tier table lives in **config.js**: its drawn edge and its pushing
edge must come from one expression (`dockDomeR`), never two. Where it throws something off, the rim
flares — an EVENT, the one thing this otherwise-calm surface animates for.

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
  the arms ARE the orbit rock rack. It alone keeps the old `Math.max(1.1, 0.07 * u)` outline
  expression, so its shipped art is bit-identical.
- **SCOUT** (`SCOUT_TIERS`) — a winged gun platform that arms itself by swallowing rock: intake
  maw → hopper → wing-root conduits → hardpoints. **FOUR GUNS TOTAL is the ceiling** (two per
  wing, from tier 2 on): everything after that buys GUIDANCE, because its kit is Nav Plotter /
  Lead Computer / Impact Warning / Reflex Jink and a ladder that grew barrels was claiming to be
  a gunship. It grows LONGER, NOT WIDER (length 2.2 → 4.4 against span 1.6 → 2.5), and the wing
  PLANFORM evolves — crank, root extension, rake — so the silhouette changes tier to tier.
  Its gimmick is the GIMBAL: a sensor head that slews to `game.aim` independent of hull heading.
  **From tier 3 the hull SPLITS** — see below.
- **BRAWLER** (`BRAWLER_TIERS`) — a ram, and the ram is the class. `prowW >= 1.20` on every tier,
  so the prow overhangs the hull on BOTH sides; it owns the front ~44% of the length. The stern
  is drawn BARE on every tier because `st.shieldArc < PI` covers the front arc only — the spec's
  weakness is visible from the hull alone.

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

**Outline width** is `outlineW`: `max(1.0 / cam.zoom, 0.085 * u)`. The floor MUST be in screen
pixels. It was 1.1 WORLD units, and since `u` shrinks with the tier that floor won on every small
hull — a tier-0 ship is ~12 world units long, so the outline was most of what you could see of it.

Damage scars are seeded per
(tier, dmg) so they're stable frame to frame — don't swap them to `Math.random`. WHERE they land
is per-spec (`drawShipScars` takes an ellipse): sampled on the hauler's body disc they fall in the
empty air beside a scout's thin fuselage. The shield bubble wraps `shipVisualR(tier, r)` (the drawn
art's reach = `r / SHIP_HIT_FRAC`) PLUS the split stand-off on a split hull — without it the drive
section trails outside its own shield — not the collision radius. The collision radius is a UNIFORM `SHIP_HIT_FRAC` (0.66) of the drawn
footprint on every tier: `shipStats` reads it from `SHIP_RADIUS[tier]` (config.js), derived as
`SHIP_HIT_FRAC × footprint`, where the FOOTPRINT grows by an equal RATIO each tier (perceptual
evenness). render.js normalizes the art to the footprint (`u = r / (SHIP_HIT_FRAC × reach)`),
so tuning the fraction moves only the hitbox, never the drawn size. (History: the hitbox used
to be the body disc alone — 43% coverage at tier 0 vs 57% at tier 5 read as "collisions don't
match the ship".) Keep `SHIP_RADIUS` and `SHIP_ZOOM` in sync with the hull tables' proportions;
the derivation rules live in the config.js comments.

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
