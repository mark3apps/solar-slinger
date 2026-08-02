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
  The growth was taken entirely as an OUTER BAND (~37k–46k, above the last planet at 36800) rather
  than by rescaling the orbit layout — moving every lane would re-tune sky speed, heat margins, and
  the graveyard clearance for nothing. The band holds three planet lanes (38300 / 40800 /
  42600), the dark star's 39500 lane, and The Farshoal dense field on the frost fringe at 44300. Planet lanes stop at 42600, leaving the fringe to the Farshoal.
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
  - **Gravel is drawn SQUATTER than a landmark of the same kind** (`GRAVEL_SQUAT`/`GRAVEL_OFF`), and
    that is a memory bill, not a fudge: the sprite cell must span the ring's longest axis, so the
    atlas pays for the peak-to-mean ratio (`SPRITE_EXT` 1.63 and 6.2 MB of the 8 MB budget at full
    strength, against 1.46 and 5.0 MB squatted) — and a 1.7:1 splinter drawn at 8 px is three pixels
    wide. The extremes cost real memory exactly where they cannot be seen. Rings normalise to a mean
    radius of 1, not a peak, so a body draws the size it collides at whether it came out knobbly or
    smooth.
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
- **The cockpit chrome is mood-reactive, the instruments are not.** `music.js` publishes its live mood
  vector as `game.mood`; `hud.moodChrome` blends it into `--mood` / `--moodI` on `#hud` each frame, and
  the soft edge wash (`#hud::after`, in `--fr`) takes that color — violet when calm, corona amber near
  the sun, ember under threat (danger blends last so it wins a tie). **CHROME ONLY**: hull green, shield
  blue and lives pink stay semantic so the instruments still read at a glance. The `lowhull` / `heat`
  alarm classes override `--fr` outright — an alarm always outranks a mood — and mood is all zeros until
  `game.started`, so the title screen and a calm cruise look exactly as they always did.
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
  the radar and the tab's polygon has to be regenerated** — nothing derives it at runtime.
- **THE XP RAIL IS MOUNTED ON THE PILOT CARD, not floating and not inset in it.** It used to be a wide
  hex pill alone at the top centre of the canopy, disconnected from the ability list it fills toward.
  It now straddles the card's top edge as its own rim-lit slab with a shadow under it — flush-inset
  first, which just read as one more row; the straddle plus the shadow is what makes it read as a part
  bolted on. Its `content-box` + 2px padding is load-bearing: hud.js writes `#xpFill`'s width as a
  percentage, and it has to resolve against the well inside the rim.
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
  the mousedown that starts a tractor grab. **Nothing in the pilot card may ever take the mouse.**
  Both the highlight and the panel are gated on the same flag as the menu button, so neither can sit
  under the pick card or a shell modal.
- **ROGUE PLANETS ARE GONE** (user call: "they're only causing issues"). A wandering 2.5-4.5e5 mass
  under full gravity was a permanent source of sky damage that no player action caused and none could
  prevent: it derailed whatever lane it crossed, ATE moons on the flyby, and — once the outer band
  existed — gravitationally CAPTURED light outer worlds and dragged them into the sun, taking every
  lane it crossed on the way down. Three separate guards were written against that one body type (the
  spawn-ring radius, an entry-speed floor, and the planet fiat re-rail in physics) before deleting it
  turned out to be the honest fix; idle skies went from losing planets to holding 21/21 with zero
  loose worlds. `type: 'rogue'` is still supported everywhere — render, minimap, weighted gravity, the
  re-rail disturber list, `scrapValue`, `noteKill` — so the concept can return if it earns its keep.
  **Nothing spawns one.** Don't "restore" the spawner without solving the capture problem first, and
  note the two rogue achievement rows were retired with it (an unearnable row is worse than a short list).
- **Enemy density is deliberately sparse** ("too many enemies, not enough normal worlds"): most planets are
  free. Nests and the dense fields' **shoal-lurker broods** are the *only* alien sources — there is no
  global wave spawner; a destroyed nest quiets its region forever, and a field's brood is a FINITE
  per-run budget (`FIELD_BROOD`) — kill the last of it and that field is quiet for the run (same rule:
  consequence traces to a player choice). Aliens are territorial (grabbers leashed to `ALIEN_TERRITORY`
  of their nest; lurkers to `FIELD_TERRITORY` of their field anchor — they never leave the shoal).
- **The shield is an ABILITY, not base — and its SHAPE is spec DNA:** you start with NO shield — the
  whole health pool is hull, which does NOT self-heal (it mends ONLY by collecting glow-pocket motes,
  below, and otherwise resets to full on respawn — with ONE sanctioned exception: any pick that
  RAISES hullMax heals the gain +20%, `main.healOnHullGain`, so a hull upgrade never just widens an
  empty bar). A `shield`-channel ability UNLOCKS the regenerating
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


## Ship hull art

The player ship hull is procedural vector art: `drawShipHull(game, tier, dmg, r)` in render.js
draws 6 tier designs x 3 damage states (picked from `game.st.tier` and hull fraction) in the
ship's local frame, nose along +x, per the `SHIP_TIERS` spec table. Ring assemblies rotate in
world space in the orbit shield's spin direction (+angle). Damage scars are seeded per
(tier, dmg) so they're stable frame to frame — don't swap them to `Math.random`. The shield
bubble wraps `shipVisualR(tier, r)` (the drawn art's reach = `r / SHIP_HIT_FRAC`), not the
collision radius. The collision radius is a UNIFORM `SHIP_HIT_FRAC` (0.66) of the drawn
footprint on every tier: `shipStats` reads it from `SHIP_RADIUS[tier]` (config.js), derived as
`SHIP_HIT_FRAC × footprint`, where the FOOTPRINT grows by an equal RATIO each tier (perceptual
evenness). render.js normalizes the art to the footprint (`u = r / (SHIP_HIT_FRAC × reach)`),
so tuning the fraction moves only the hitbox, never the drawn size. (History: the hitbox used
to be the body disc alone — 43% coverage at tier 0 vs 57% at tier 5 read as "collisions don't
match the ship".) Keep `SHIP_RADIUS` and `SHIP_ZOOM` in sync with `SHIP_TIERS` proportions;
the derivation rules live in the config.js comments.
