// SYSTEM SCALE — how far apart the sky is spread. Every sun-anchored radius
// world.js authors (the layout lanes, the belts, the graveyard, Vesper's
// ellipse, the dense fields, the landmark lookups, the ship's own spawn) is a
// SHAPE that gets multiplied by this, and CFG.WORLD_R rides it too so the
// boundary and the Oort cloud stay in the same relation to the outermost lane.
// It lives OUTSIDE the CFG literal only because WORLD_R has to be computed
// from it and an object literal cannot read its own siblings — treat it as a
// member of the WORLD SCALE family documented at PLANET_R_MUL below.
//
// It is a DISTANCE knob, not a speed one: sun-anchored orbital speed is
// sqrt(G*sunMass/r), so spreading the sky 1.3x without touching the sun's mass
// slows every orbit by 1/sqrt(1.3) (~12%) and lengthens every period by
// 1.3^1.5 (~48%). That is the intent — a planet system you have to travel to
// is more of an event — and it moves the sky AWAY from the ambient-damage
// thresholds (invariant 3) rather than toward them, so the calmer sky is free.
// If flight ever needs its old cruise back, raise the sun's mass by the same
// factor (world.js) — sky speed and this constant are the pair, and the
// camera-zoom note in docs/physics-invariants.md applies to that knob alone.
// 1.69 = the original 1.3 grown a further 30% (2026-08 user call: "the solar
// system should get up to 30% larger") — the second growth pass rides the
// first, so every note written against 1.3 still describes the SHAPE, just
// spread wider again.
const SYS = 1.69;

// All gameplay tuning lives here.
export const CFG = {
  SYS_R_MUL: SYS,
  G: 8,                    // gravitational constant (gameplay-tuned)
  // FIXED PHYSICS SUBSTEP — the FINE step, and the reference every invariant in
  // CLAUDE.md was tuned at. Everything headless (window.tick / soak / mechTest)
  // is PINNED here so the harnesses stay bit-repeatable; see FRAME PACING in
  // main.js for the live-frame rule that can drop the loop to DT_COARSE.
  DT: 1 / 120,             // physics substep
  // RELIEF STEP. The accumulator's substeps-per-frame count RISES as the frame
  // rate falls (60 fps = 2, 15 fps = 6), so a machine that is already late pays
  // 3x the sim cost for being late — slow frame ⇒ more substeps ⇒ slower frame,
  // a genuine positive feedback loop (measured in a dense shoal: sim 2.5ms at
  // 1 substep, 7.1ms at 6, against a 1.7ms draw — the sim overtook the draw 4x
  // over). Halving the substep rate halves that cost directly. Verified against
  // the 20-sim-minute idle soak (seed 20260721): every planet and moon of the
  // then-current sky (21/21 and 48/48; it is 17/59 since the rarer/wider
  // planet-system pass, and the finding is about the STEP, not the counts),
  // zero loose planets, zero NaN — the same fingerprint as 1/120, because the
  // celestials ride precomputed rails and never integrate at all. It is NOT the
  // default anyway: a coarser step doubles how far a fast body moves between
  // collision tests, so it is the deal you strike only when the alternative is
  // a 15 fps death spiral.
  DT_COARSE: 1 / 60,
  // ...and it was DISARMED until the collision narrow phase could survive it.
  // IT IS NOW RE-ARMED — physics.sweptContact is the pre-test this asked for.
  // MEASURED, 220 randomized trials per cell (impact parameter AND sample phase
  // both randomized — a fixed start distance measures one lucky alignment, not
  // the expected rate), fraction of impacts that register against the ship:
  //
  //   closing            400    800   1300   1800   2500
  //   1/120 overlap      99%    97%    92%    86%    77%
  //   1/60  overlap      79%    90%    70%    52%    38%
  //   1/120 SWEPT       100%   100%   100%   100%   100%
  //   1/60  SWEPT       100%   100%   100%   100%   100%
  //
  // The swept step is now strictly better than the old FINE step was: 1/60 with
  // the pre-test detects everything 1/120 without it was missing. That is what
  // lifted the disarm — see THE SWEPT PRE-TEST in physics.js.
  //
  // RE-MEASURING IT: count DETECTIONS (physics.shipContacts), never deflection.
  // Invariant 4 makes a 400-mass rock immovable against a 10-mass ship, so a
  // landed hit barely moves the projectile and a deflection-based harness reads
  // ~0% everywhere. Park the test ship well INSIDE WORLD_R too: outside it the
  // boundary force is ~37,750 u/s² and shoves the ship hard enough that any
  // ship-velocity signal reads 100% on every trial.
  //
  // The history below is why it was disarmed in the first place; keep it.
  //
  // At ALIEN_THROW (430) that is 97% -> 77%: about one alien throw in five
  // passes straight THROUGH the ship. collideShipBody is a pure overlap test
  // (`if (d2 > rr*rr) return`) with no swept component, so doubling the step
  // doubles how far a projectile jumps between the only samples that can ever
  // detect it. That is a rule change a player feels mid-fight, not a rounding
  // error — and the baseline row shows 1/120 is already leaving fast grazes on
  // the table, so this compounds an existing weakness rather than finding a new
  // one.
  //
  // THE POINT: disarming costs NO frame rate. SUBSTEP_MAX is what halves the
  // sim cost (3 substeps instead of 6) and it changes no physics at all, since
  // every substep is still 1/120. The coarse step never bought frames — it
  // bought back the wall-clock SPEED the cap gives up (3 x 1/60 = 50ms of sim
  // per frame vs 3 x 1/120 = 25ms), i.e. it exists to stop the game running in
  // slow motion below 40 fps. So the trade is slow-motion vs. missed hits, and
  // missed hits lose.
  //
  // DONE: the swept segment-vs-disc pre-test landed in collideShipBody and
  // collideAlienBody (ship + aliens only — a handful of entities, NOT the
  // ~8000-body sweep, where tunnelling is off-view and cosmetic), the table was
  // re-run, and it did lift the 1/120 row as predicted. Hence true.
  PACE_COARSE_ENABLED: true,
  // HARD CAP on substeps per frame — the guard that actually breaks the spiral,
  // independent of which step is live. Past the cap the backlog is DROPPED
  // (honest time dilation) instead of compounding into the next frame. 3 is
  // exactly the fine step's budget at 40 fps (3 x 1/120 = 25ms) and the coarse
  // step's at 20 fps (3 x 1/60 = 50ms) — and 50ms is precisely where frame()
  // clamps dtReal, so on the coarse step nothing is ever dropped at all.
  SUBSTEP_MAX: 3,
  // FRAME PACING thresholds (main.js updatePacing), in milliseconds.
  // ENTER the coarse step on smoothed FRAME TIME: past 25ms (40 fps) a frame
  // owes more than the fine step's own cap can cover, so it is already being
  // time-dilated and the coarse step is strictly better. Frame time is the
  // right signal here because vsync idling can only make it look FASTER, never
  // slower — nothing but real slowness pushes it past 25ms.
  PACE_COARSE_MS: 25,
  // LEAVE it on projected WORK — sim + draw, never frame time. A 60 Hz display
  // floors frameMs at 16.7ms however fast the machine is, so a frame-time exit
  // test would strand every 60 Hz machine on the coarse step forever after one
  // slow patch. Work is refresh-independent. The projection doubles simMs
  // because halving the step doubles the substeps (conservative: the AI/LOD/
  // glow part of simMs doesn't double, so it errs toward staying coarse), and
  // 8ms of projected work leaves the fine step comfortably inside a 60 Hz
  // frame. Projecting rather than measuring is what stops the switch
  // oscillating — a machine that looks fast BECAUSE it is on the coarse step
  // would otherwise flip back, get slow, and flip again forever.
  PACE_FINE_WORK_MS: 8,
  // ...and only if the frame is not slow for reasons that have nothing to do
  // with us. Work alone said "the fine step fits" on a 28ms frame whose cost
  // was some OTHER process — true, but beside the point: at 28ms the fine cap
  // is already dilating time, so the coarse step is still the better state.
  // Measured before this clause existed: 4 flips in 11 seconds at a 28ms
  // frame, the switch hunting on a 3s period. 20ms leaves 5ms of hysteresis
  // under PACE_COARSE_MS, and still clears a 60 Hz vsync frame (16.7ms).
  // A 30 Hz display (33ms) never clears it and stays coarse forever — that is
  // CORRECT, not the 60 Hz bug repeating one octave down: at 33ms the fine
  // step owes 4 substeps against a cap of 3, so it would be dilating time even
  // on a machine with headroom to spare. Don't "fix" it by raising this past
  // PACE_COARSE_MS; the two numbers describe the same 25ms cap budget from
  // either side, and crossing them makes the switch hunt.
  PACE_FINE_MS: 20,
  PACE_DWELL: 1.5,         // seconds the disagreement must hold before switching
  // Soft boundary radius. MUST exceed the outermost orbit reach (orbit +
  // moons), or the boundary force quietly deorbits the outer planets.
  // Beyond it lies the Oort cloud, which grinds the ship down.
  // 46000 = the old 42000 grown 20% by AREA (42000 x sqrt(1.2)) — the extra
  // room is the OUTER BAND: the outer planet lanes (world.js layout, stopping
  // at an authored 40800), the dark star's authored 39500 lane, and the
  // Farshoal dense field riding the frost fringe at an authored 44300.
  // x SYS multiplies with the lanes so all four of those relationships — and
  // the Oort warning band the Farshoal deliberately brushes — survive a
  // change to the system scale. The outermost MOON reach is no longer left to
  // arithmetic done by hand here: world.moonZone clamps a family by what this
  // radius actually leaves, which is what makes invariant 6 structural.
  WORLD_R: 46000 * SYS,
  // WORLD SCALE — planets and moons are built at these multiples of the radii
  // authored in world.js (the layout table, and spawnMoon's own 18-34 range).
  // SIZE ONLY: THE MASSES ARE UNTOUCHED, deliberately. Radius is inert to every
  // physics invariant — rails are circular and mass-driven, gravity is GM/r²,
  // hp is massToHp — while mass is load-bearing for all of them, so scaling it
  // to match is not a tuning question but a demolition: holding density at 3x
  // radius needs 27x mass, which puts the amber giant at 1.75e7, HEAVIER THAN
  // THE SUN (1.42e7). The worlds therefore get big, not heavy, and two things
  // follow that you can feel. Surface gravity falls as 1/mul², and the LONG
  // ARMS (SHIP_WELL_START, below) are measured in body radii so a giant's well
  // reaches out proportionally rather than absolutely: a gas giant is now
  // something you fly ALONG, not something that snatches you. Raise
  // PLANET_GRAV_SHIP if the big worlds should grab as hard as they look.
  // 5.25 = the previous 3 grown 1.75x (2026-08 user call: "planets should be
  // 1.5x to 2x bigger"). The 1.5-2x SPREAD comes from world.js's per-planet
  // seeded size jitter (x0.86-1.14 on the authored radius), so each world
  // lands somewhere in 4.5-6x authored — 1.5-2x the sky this note was written
  // against — and no two seeds grow the same world the same amount.
  PLANET_R_MUL: 5.25,
  // 5 = the previous 2 grown 2.5x (same pass: "moons should be 2x to 3x
  // bigger"); spawnMoon's own seeded x0.8-1.2 jitter spans the 2-3x range.
  // EVERY clearance margin sized to cover moon radii rides this constant
  // (moonZone's floor, spawnMoon's sibling margin, replenishWorld's refill
  // clearance) — that is what lets it move without re-deriving them.
  MOON_R_MUL: 5,
  // How far out a planet holds moons, as a multiple of its HILL radius
  // (world.moonZone). Rails hold a moon on its orbit regardless of the sun's
  // tide, so the zone deliberately reaches past raw Hill stability — this is
  // the "wide, majestic moon systems" knob, and 2.9 is the previous 1.95 taken
  // ~1.5x wider (2026-08 user call: "the moon orbiting radius should be able
  // to be about 1.5x larger"). It pairs with the moon COUNTS in the layout:
  // counts grew up to 1.5x in the same pass (a seeded x1-1.5 per planet), so
  // spawnMoon's per-moon slot width — and with it every sibling-clearance
  // margin the no-crossing rule depends on — holds on average, and addPlanet
  // now CLAMPS a family's count to what its zone can actually slot (the
  // 180*MOON_R_MUL floor) so an unlucky draw degrades to fewer moons, never
  // to a crossing pair. Move one of these without the other and you are
  // re-tuning how tightly packed a family is, not how wide it is.
  // Hill goes with orbitR x cbrt(mass), so this widens the BIGGEST worlds most
  // in absolute terms, which is the point: a gas giant's family should read as
  // a system you fly through, not a bracelet.
  MOON_ZONE_MUL: 2.9,
  // Eccentricity ceiling for an elliptical moon rail (spawnMoon's eCap). Read
  // by moonZone as well, to turn a zone into the apoapsis it can actually
  // reach — the two MUST agree or the boundary clamp under-counts the reach it
  // is there to bound.
  MOON_E_MAX: 0.34,
  // ...but a lane only holds so much world, which is why the multiplier above
  // is a CEILING ("up to 3x") rather than a flat scale. Two planets on
  // adjacent rails run at different angular speeds and so ALWAYS reach
  // conjunction eventually: at a flat 3x the amber giant (520 -> 1560) and the
  // shroud world inside it (205 -> 615) overlapped by 175 units on every pass,
  // and the violet giant met the desert world exactly. generateWorld shrinks
  // any pair that would not leave this much clear space between their
  // surfaces, splitting the shortfall in PROPORTION to the two desired radii
  // so the giant is still the giant. Widening the LANES instead was the other
  // way out and it is the expensive one — lane radii set sky speed, corona
  // heat margins and the graveyard clearance (see world.js), so moving them
  // re-tunes the whole game to make one planet bigger.
  PLANET_LANE_GAP: 400,
  OORT_WARN: 1400,         // warning distance before the cloud edge
  OORT_DPS: 6,             // hull damage/s at the edge, scaling with depth
  ATTRACT_MIN: 2000,       // bodies at/above this mass exert gravity
  GRAV_SOFT: 40,           // softening length to avoid singularities
  // The ship feels amplified gravity from everything — big suns and planets
  // should really pull on YOU (thrown objects and NPCs use normal G).
  SHIP_GRAV: 1.45,
  // How hard the sun grabs the SHIP (multiplies SHIP_GRAV for stars only).
  // Tunes as a pair with the sun's mass (world.js, 1.42e7): the ship-felt sun
  // pull and its cruise speed both scale with mass x this amp. It was
  // deliberately NOT raised when the sun mass was lowered to calm the sky —
  // slower cruise SHOULD come with a gentler pull (see the sky-speed notes in
  // world.js and on SHIP_ZOOM). Never touch one without considering the other.
  STAR_GRAV_SHIP: 0.8,
  // Planets, moons, and rogues also grab the ship extra hard — flying near
  // a world should FEEL like entering its well (total = SHIP_GRAV * this).
  // 6.0 = the old 3.0 x 2 (2026-08 user call, first "about 1.4x as strong",
  // then raised to "2x instead"), cashing in the invitation the WORLD SCALE
  // note above makes: the growth pass left masses alone, so surface pull fell
  // as 1/mul² while the worlds grew — this claws the felt grab back toward
  // how big they now look. Ship-only, like everything in this family: rails,
  // moon orbits, thrown rocks and damage never read it.
  PLANET_GRAV_SHIP: 6.0,
  // LONG ARMS (ship only): beyond SHIP_WELL_START planet radii, the
  // ship-felt pull of a world falls off as 1/r instead of 1/r² until the
  // boost caps at SHIP_WELL_MAX — wells reach farther WITHOUT deepening
  // close-range gravity. Applies only on the ship's gravity path (and its
  // mirror in predictPaths — keep them in sync); thrown rocks, aliens,
  // debris, and celestials are untouched.
  SHIP_WELL_START: 2.5,
  SHIP_WELL_MAX: 6,
  // ORBIT RUBBER BAND (ship only): inside SHIP_BAND_RANGE body radii (+300)
  // of a world, the INWARD radial component of the ship's velocity relative
  // to that world is damped by up to SHIP_BAND_DAMP/s (accel capped at
  // SHIP_BAND_MAX). Tangential motion is untouched — plunges soften into
  // captures and orbits circularize on their own. Outward radial velocity
  // is exempt ON PURPOSE: an assist must never become an escape jail.
  // Mirrored in predictPaths like the long arms.
  //
  // MOSTLY REMOVED (2026-08, user call: "it kinda breaks things"). DAMP was
  // 1.2, and the damage was structural rather than a matter of degree: the
  // brake ramps with `t`, which is 0 at the band's edge and 1 AT THE SURFACE —
  // so the assist was strongest at exactly the place the player is trying to
  // arrive. Terminal descent speed is g_surface / DAMP, which at 1.2 is about
  // 5 u/s: a descent from 120 units up took nearly half a minute of the ship
  // apparently refusing to fall, and it read as gravity being broken rather
  // than as an assist. The wider cost was the same everywhere — the band
  // quietly cancelled the inward half of every approach, so a world's well
  // never really felt like one however hard PLANET_GRAV_SHIP pulled.
  //
  // At 0.3 the same descent is ~20 u/s and takes a few seconds, while a
  // genuine PLUNGE (200+ u/s inbound) still gets a meaningful 60 u/s² of
  // softening on the way in, which is the case the band was written for.
  // Kept rather than deleted: killing it outright makes every near-miss a
  // hyperbolic slingshot and there is no capture arc left at all.
  SHIP_BAND_RANGE: 4,
  SHIP_BAND_DAMP: 0.3,
  SHIP_BAND_MAX: 130,
  // SURFACE SKIMMING: grinding tangentially along a body while in contact
  // chews the hull (collideShipBody) — a gentle landing is free below
  // SKIM_SPEED, then dps = (tangential speed - SKIM_SPEED) * SKIM_DPS_K.
  // (A sub-orbital slide grinds continuously; a super-orbital graze lifts
  // off in a few substeps and only takes a scratch — both are intended.)
  SKIM_SPEED: 100,
  SKIM_DPS_K: 0.09,

  // ---- PLANET SPIN (entities.Body) ----------------------------------------
  // A WORLD'S DAY IS LONGER THE BIGGER IT IS (user call: "planets, especially
  // large ones, rotate slower"). Planets used to draw one flat rate regardless
  // of size, so a 1,290-unit gas giant swept its cloud bands past at the same
  // angular rate as a 180-unit rock — and angular rate is not what the eye
  // reads. It reads the SURFACE going by, which is `spin x radius`, so the flat
  // rate made every big world look like it was visibly spinning rather than
  // turning. It also gave the biggest worlds the fastest ground to land on,
  // which is the wrong way round for the thing you most want to set down on.
  //
  // Two knobs, deliberately separate. PLANET_SPIN_SLOW is the flat "everything
  // is calmer now" factor; PLANET_SPIN_REF/POW is the SIZE falloff on top of
  // it, and only bites above the reference radius (`max(REF, radius)`), so the
  // small worlds take the flat slowdown alone and are not sped up by the curve.
  //
  // Measured across the sky at these values: a 180-unit world goes from a
  // ~78-210s day to ~157-419s, and the 1,290-unit giant from the same ~78-210s
  // to ~9-25 MINUTES. MOONS ARE DELIBERATELY UNTOUCHED — the request named
  // planets, moons are all well under the reference radius anyway, and their
  // quicker turn is what makes a moon read as a small body next to a world.
  PLANET_SPIN_SLOW: 0.5,
  PLANET_SPIN_REF: 300,
  PLANET_SPIN_POW: 0.85,

  // ---- LANDING: SURFACE FRICTION (physics.collideShipBody) ----------------
  // A world is a TURNING body, and until this existed the hull touching one was
  // a purely elastic event: nothing in contact took energy out tangentially, so
  // a graze skated across a planet at the speed it arrived with until the grind
  // killed the ship. Contact now drags the ship toward the velocity of THE
  // PATCH OF GROUND UNDER IT — the world's own motion plus the tangential speed
  // of its spin at that radius — as an exponential rate, so a skid matches the
  // surface it is skidding on in well under a second.
  //
  // Applied to the WHOLE relative velocity, not just the tangential half, and
  // that is what makes a landing possible at all: the radial part cancels the
  // gravity the ship keeps falling in with, so it settles against the
  // resolver's push-out instead of chattering on it. Residual drift is
  // g_surface / SURF_FRICTION — under 1 u/s on a mid world, ~4 u/s under the
  // deepest LONG ARMS amplification, i.e. far inside DOCK_SPEED either way.
  //
  // It never touches the BOUNCE: the kick below is an impulse applied in the
  // same substep, and at 1/120s this rate removes 3.7% of a velocity. A hard
  // arrival still bounces exactly as invariants 3-5 tune it; only a ship that
  // STAYS down is slowed. Thrust wins easily (180 u/s² against 4.5/s is a
  // 40 u/s terminal, and clearing the hull ends contact anyway), so the pad
  // never becomes flypaper.
  //
  // PLANETS AND MOONS ONLY. A rock is not a place you land on, and rock contact
  // is long-tuned against every dense field in the game.
  SURF_FRICTION: 4.5,      // 1/s — 95% of the difference gone in 0.67s

  // ---- DOCKING (physics.updateDock) ---------------------------------------
  // Set the ship down on a world ROCKETS-DOWN and hold still and it BERTHS.
  // Three gates, all true together for DOCK_TIME, and then one of two things
  // happens: you berth at a station that is already standing there, or you
  // start BUILDING one.
  //
  // THE GATES ARE DELIBERATELY GENEROUS (widened 2026-08 — the first pass was
  // too fiddly to land with). A landing is meant to be a thing you decide to
  // do, not a trick you execute; the interesting part of this feature is what
  // a dock IS, not how tight the approach window is.
  DOCK_ARC: 1.0,           // rad of slop on "rockets down" — the nose has to sit
                           //   within ~57° of straight up off the surface. Still
                           //   a real requirement (a belly flop or a nose-in
                           //   crash is not a docking) but forgiving of drift.
  DOCK_SPEED: 60,          // u/s of SURFACE-RELATIVE speed that still reads as
                           //   stopped. Under SKIM_SPEED (100) on purpose:
                           //   anything still GRINDING is not parked.
  DOCK_TIME: 0.5,          // s all three gates must hold before the clamps bite
  // The latch timer DRAINS this many times faster than it fills once the hull
  // leaves the surface, which is the whole of the berth's hysteresis: a berthed
  // ship gets DOCK_TIME / DOCK_DRAIN (~0.17s) of grace so a bump across a
  // crater lip cannot flicker the clamps, and a deliberate lift-off still
  // reads as leaving almost at once.
  //
  // ATTITUDE AND STILLNESS ARE ENTRY GATES, NOT HOLDING ONES — only CONTACT
  // holds a berth. (The ship is held UPRIGHT while berthed anyway, so the
  // attitude gate could not fail; the rule still matters for the moment
  // between the clamps letting go and the helm coming back.)
  DOCK_DRAIN: 3,
  // ---- Building a station -------------------------------------------------
  // A DOCK IS A STRUCTURE, NOT A STATE. Berthing at a bare patch of ground
  // starts a build that takes DOCK_BUILD seconds of staying put — and none of
  // what a dock gives you (the shield, the repair) arrives until it is
  // finished, so those ten seconds are a real exposed commitment rather than a
  // loading bar. Once built the station STAYS on that world for the rest of the
  // run: fly away, come back, and you berth at it immediately with everything
  // live from the first moment.
  //
  // Progress is kept if you leave mid-build (`d.t` lives on the station, not on
  // the berth), so an interrupted build resumes rather than being thrown away.
  // It only advances while you are actually berthed — you are the one building it.
  DOCK_BUILD: 10,
  DOCK_BERTH_R: 90,        // world units: land this close to a standing station
                           //   and you berth at IT instead of starting a second
                           //   one beside it. Comfortably wider than the pad
                           //   sprite at every tier.
  // Cap on standing stations per run. Not a balance number — a bound, so the
  // list, the two instruments and the draw can never grow without limit. Well
  // above any plausible play pattern; the oldest NON-HOME station retires when
  // it binds, and the home port is never retired.
  DOCK_MAX: 8,
  DOCK_HEAL: 6,            // hull/s while berthed at a FINISHED station (see the
                           //   design law note in docs/design-laws.md — this is
                           //   the second sanctioned exception to "the hull
                           //   never heals")
  DOCK_UPRIGHT: 6,         // 1/s the helm eases the nose to the surface normal
                           //   while berthed — the ship stands up and stays up
  DOCK_LIFT: 1.6,          // hull radii a respawn is placed above the pad, so
                           //   the ship never materializes inside the crust
  // ---- LAUNCH (physics.updateLaunch) --------------------------------------
  // LEAVING A DOCK IS A SEQUENCE, NOT A KEYPRESS. Thrust from a berth and the
  // station runs a release: the clamps swing back, the engine spools against
  // them, and only then does it let go. The ship is PINNED to the pad's own
  // velocity for the whole of it (so the sequence cannot be steered or shoved
  // out of), and it commits once started — a launch you can abort halfway is a
  // stutter, not a moment.
  //
  // The point is the WEIGHT. A dock you can leave instantly is a parking space;
  // one that takes a second to release makes berthing feel like a real
  // commitment, which is what earns the protection it gives.
  LAUNCH_HOLD: 0.5,        // s of CLAMPS RELEASING — arms swing out, glow builds
  LAUNCH_TIME: 1.25,       // s total; HOLD..TIME is the IGNITION hold (plume,
                           //   rising shake) before the pad lets go
  LAUNCH_KICK: 300,        // u/s straight up as the clamps release — the shove
                           //   off the pad, so a launch clears the structure
                           //   without needing the player to fight gravity
  // The dome does not just absorb, it PUSHES: anything crossing it is thrown
  // back out at no less than this, so a berth can never be crowded or shoved.
  DOCK_REPEL_MIN: 210,

  // Solar flares: the sun RARELY erupts plasma at ships that fly close.
  // A direct hit is a real event now: EMP kills the engines for
  // FLARE_ENGINE_OUT seconds and blows half the orbit shield loose.
  // The flare family is keyed to the SUN'S RADIUS in spirit (fire while close,
  // fizzle past the graveyard) — both moved when the sun doubled to 4800:
  // range 5500→11000 keeps "close" the same ~2.3 sun radii it always was, and
  // life 6→8 keeps the fizzle reach (surface + speed*life ≈ 10,800) covering
  // the ring the range invites you to fight over.
  FLARE_RANGE: 11000,      // only fires while the ship is this close to the sun
  FLARE_SPEED: 750,
  FLARE_LIFE: 8,           // seconds of flight — flares fizzle ~6000 out
  FLARE_DMG: 26,
  FLARE_ENGINE_OUT: 3,     // seconds of dead engines after a direct hit

  // CORONA HEAT on BODIES/ALIENS: everything melts inside HEAT_ZONE x the
  // sun's radius (dps ramps depth²). Lava-born things are immune.
  // HEAT_ZONE must keep this zone's outer edge INSIDE the graveyard ring:
  // the ring is derived from the sun's radius in world.js (sunR x 1.36, so
  // ~6530 against 1.30 x 4800 = 6240, wrecks scattered ±90 stay ~200 clear) —
  // raise it and the wrecks start cooking (any damage at all derails them;
  // there is no "subtle" for railed bodies).
  HEAT_ZONE: 1.30,
  HEAT_DPS_BODY: 0.12,     // fraction of a body's maxHp per second at surface
  // CORONA HEAT on the SHIP: a wide envelope with an EXPONENTIAL ramp —
  // dps = HEAT_SHIP_DPS * e^(-(d - sunR) / HEAT_SHIP_FALLOFF). At the zone
  // edge it's a whisper (~0.01), at the graveyard ring ~2.4/s, at the
  // photosphere the full 42/s. Warmth warns long before it kills; the kill
  // only happens if you keep going.
  // The falloff DOUBLED with the sun (300 → 600, 2026-08): the ramp is
  // measured from the surface, so a 2x sun with the old e-folding read only
  // ~0.13/s at its graveyard ring — the guarded salvage lost its guard.
  HEAT_SHIP_ZONE: 2.1,     // visual + damage envelope, x sun radius
  HEAT_SHIP_DPS: 42,       // dps at the photosphere
  HEAT_SHIP_FALLOFF: 600,  // e-folding distance of the ramp
  // Lava worlds radiate the same aura, weaker and SHIP-only (their own
  // moons must never cook on their rails)
  LAVA_HEAT_ZONE: 1.7,     // reach, x planet radius
  LAVA_HEAT_DPS: 12,
  // GAS DIVE: gas giants have no surface for the SHIP — it flies in.
  // Interior gravity uses enclosed mass (x d³/R³ of the point value, in
  // gravityAt + predictPaths) so climbing out stays possible while the
  // pressure crushes: dps = depth² x GAS_CRUSH_DPS; instant death inside
  // GAS_CORE x radius. Rocks and aliens still bounce off the cloud tops.
  GAS_CRUSH_DPS: 110,
  GAS_CORE: 0.30,
  // A GAS GIANT IS NOT MADE OF ROCK, and until now it took damage as though it
  // were: a thrown rock BOUNCED off the cloud tops, the hit drew the crack web
  // every solid world uses (fissures across a ball of hydrogen), and killing
  // one sprayed stone fragments and left a hole in the sky. All three are the
  // same mistake — treating an atmosphere as a crust.
  //   IT SWALLOWS.  Loose rock that reaches the cloud tops sinks and is gone,
  //     with a plume where it went in. No bounce, because there is nothing to
  //     bounce off; no threshold, because "punching through" a gas giant just
  //     means sinking deeper. The giant still takes the impact — scaled by what
  //     hit it, so pebbles are weather and a thrown moon is a wound.
  //   IT STORMS.  Damage shows as cyclones churning up out of the bands
  //     (render.drawGasWound), not as cracks. The atmosphere is the wound.
  //   IT IS STRIPPED, NOT SHATTERED.  At zero hp the envelope blows off as an
  //     expanding cloud and leaves the CORE behind — a real dense world on the
  //     giant's own rail, which its moons are handed to so a system survives
  //     losing its primary. Killing a gas giant transforms it rather than
  //     deleting it, which is also why the planet count holds.
  // REPRICED WITH THE PLANET HP PASS (0.5 -> 2.0). Gas hp rides PLANET_HP_BASE,
  // so when planets were re-priced it fell 25,200 -> 14,200 (x0.56) — but the
  // moon-mass impactor was tempered x0.25 in the same pass, and the gas class
  // was carried along rather than re-derived. Net: the ladder went 16 -> 35
  // moon slams, 3.5-5x off the stated target below, and GAS_HIT_CAP stopped
  // binding at any reachable fling speed (0.079 of maxHp, needing ~2,500+
  // closing against a 1,005 ceiling) — a documented bound that never fired.
  // Measured back into band via `bench run combat`: 9 moon slams, 39 boulders,
  // and gasSingleHitFraction back to the full 0.18, i.e. the cap engages again
  // at the top of the fling range, which is the whole point of it.
  GAS_IMPACT_MUL: 2.0,     // an impact spent sinking into atmosphere, not cratering
  // NO SINGLE IMPACT STRIPS A GIANT. Collision damage is QUADRATIC in closing
  // speed, and a late-game fling throws a moon three times faster than a mid
  // one — measured, a heavy moon at full tier-5 sling computed 2.7x the giant's
  // ENTIRE hp in one hit, so two moons ended the biggest thing in the sky. Same
  // idiom as invariant 3's comparable-mass cap and LURKER_HIT_CAP: bound what
  // one blow can take, and the number of blows stops depending on how hard the
  // player happens to be able to throw. Six to ten moons, either way.
  GAS_HIT_CAP: 0.18,       // most of maxHp one impact may take
  GAS_DOM_EXP: 0.65,       // mass-dominance softening — a gas giant is not rigid
  GAS_CORE_MASS: 0.28,     // the core's share of the giant's mass — cores are dense
  GAS_STORMS: 6,           // cyclones on a fully-wounded giant
  // THE IMPACT HAS TO BE AN EVENT YOU CAN SEE. A rock blinking out of existence
  // against a wall of cloud is the least interesting thing that could happen,
  // and it left the player no way to tell a giant was being hurt at all. So a
  // swallowed rock takes GAS_SINK seconds to go under — it keeps ploughing in,
  // fading and slowing as the clouds close over it — and the entry itself
  // leaves a mark on the world: a hot flash, a plume, a shock ring running out
  // through the bands, and a dark punch-hole that swirls shut over
  // GAS_HIT_FADE. Sustained damage then reads as storms whose eyes GLOW hotter
  // the deeper the wound goes, and past GAS_VENT the limb starts streaming
  // atmosphere away — the visual promise of the strip-to-core death.
  GAS_SINK: 0.55,          // seconds a swallowed rock spends going under
  GAS_HIT_FADE: 3.2,       // seconds an entry wound takes to swirl closed
  GAS_VENT: 0.62,          // damage fraction past which the atmosphere visibly bleeds off
  GAS_VENT_EVERY: 5.5,     // base seconds between instability geysers (faster as it fails)
  // AN ERUPTION THROWS BOULDERS, NOT DUST (user design law: *it should shoot
  // stuff out — not a hundred pebbles across half the sky*). The column shipped
  // as 3-15 pieces per eruption sized 1.2-4.2% of the giant's radius, which
  // MEASURED as: one solid impact = 15 pieces at a median 17.6 units against a
  // 1,148-unit world, the geyser drip = 87 pieces per 30s, and a full collapse =
  // 96 pieces peaking at 102 live and flung out to 5.3x the giant's radius. A
  // 17-unit crumb beside a world that size is sub-visible — it is under
  // CRUST_R_MIN, the crumb floor of the crumble system that mints every other
  // piece of a broken world — so the loudest thing in the game read as a puff of
  // grit, and one dying giant spent ~100 of the 1,500 DEBRIS_BUDGET slots (of
  // which ordinary play already holds ~950) on rocks nobody could see.
  // So: roughly a THIRD the pieces at roughly DOUBLE the radius, which lands
  // about the same total ejected MASS in objects that read as pieces of a world
  // and are worth flying over to grab. Count and size both ride `scale` (the
  // impactor, or how far gone the giant is), so a pebble still puffs and a moon
  // still fountains — the ladder is intact, it just starts from a real rock.
  GAS_EJECTA: [1, 4],      // pieces per eruption: base + this x scale
  GAS_EJECTA_R: [0.019, 0.020],  // piece radius, x the giant's radius: floor + this x scale
  // ...and the COLLAPSE answers to a hard total, not just a per-eruption count.
  // The throes fire on a tightening timer, so the piece count was an emergent
  // product of two tunings and nothing bounded it; this is the ceiling that
  // makes the whole system safe to build on (same idiom as CRUST_PER_HOST and
  // CRUST_DEATH — bound it by construction, not by hoping the cadence holds).
  // KILLING A GIANT IS THE EXCEPTION, and gets to be the biggest debris event in
  // the game: measured, the throes mint 47 pieces and leave ~55 gas ejecta in the
  // scene (user call — 26 was too austere for the death of the biggest thing in
  // the sky). What was wrong with the old 96 was the SIZE of the pieces, not the
  // quantity. The yield needs no multiplier of its own: it falls out of the
  // ordinary eruption count run across the FULL five seconds, which is only true
  // because beginGasStrip zeroes `ventT` — see the note there, and do not tune
  // this number without reading it, because a stalled first half is exactly the
  // kind of bug that gets "fixed" by inflating a count instead.
  // Minted and surviving differ by ~15%: ejecta launch from the CURRENT surface,
  // the throes collapse that surface inward the whole time, and escape velocity
  // climbs as the radius falls (v_esc = sqrt(2GM/r)), so the late column
  // increasingly falls short of escape and rains back in to be quietly eaten.
  // The ceiling sits deliberately above both so it stays a backstop rather than
  // the mechanism — a cap that binds every time would truncate the tail, and the
  // tail is the most violent part of the collapse, so the last and loudest vents
  // would be the ones minting no rock.
  GAS_STRIP_EJECTA: 70,    // most pieces ONE death-throe collapse may ever throw
  // THE STRIP IS A SCENE, NOT A SWAP. At zero hp the giant does not pop into
  // a core: it enters death throes for GAS_STRIP_TIME seconds — venting from
  // everywhere at once, its envelope visibly collapsing inward, the hot core
  // burning brighter through the thinning cloud — and only then blows the
  // atmosphere off in one shell. Killing the biggest thing in the sky should
  // take longer to watch than killing a rock.
  GAS_STRIP_TIME: 5,
  // A CORE COMES OUT MOLTEN. It has just had a planet's worth of atmosphere
  // ripped off it and spent the whole life of the system under that pressure —
  // so it is exposed red-hot and boiling, and it takes GAS_CORE_COOL to settle
  // into the ordinary rocky world it will be from then on. Purely a look:
  // `b.molten` drives a colour lerp and a render overlay, and deliberately does
  // NOT make it ptype 'lava', which would hand a freshly killed giant the lava
  // archetype's heat aura and magma artillery as a parting gift.
  GAS_CORE_COOL: 75,

  // Celestial bodies feel full gravity from stars and their parent planet, but
  // only this fraction from other planets/moons/rogues. The ship, aliens,
  // debris, and anything you throw always feel FULL gravity from everything.
  // Without this, planet masses big enough to matter to the ship make the
  // systems gravitationally shred themselves within minutes.
  CROSS_GRAV: 0.15,
  // Non-anchor STARS are damped even harder for celestials: at 0.15 the
  // neighbor-star tide on outer planets is still ~8% of their own star's pull
  // (16x Jupiter-scale) and pumps them into their sun within ~8 minutes.
  CROSS_STAR: 0.05,

  // Body-vs-body impacts only deal damage above a closing-speed threshold —
  // ambient orbital traffic (asteroids drifting across planet orbits at
  // 100-300) must bounce harmlessly or the systems sandblast themselves to
  // death in minutes. Deliberately THROWN objects get a lower threshold and a
  // damage multiplier, so the tractor fling (and alien throws) stay lethal.
  DMG_BODY: 1.2e-6,        // dmg = K * (closing - threshold)^2 * dmgMass(otherMass)
  // 240 is tuned to the sky speed (sun mass 1.42e7, world.js): ambient
  // crossing traffic closes at ~100-300, and this lets it bounce harmlessly
  // while real slams still bite. It was briefly raised to 340 when the sun
  // was 3.2e7 (1.4x faster sky); with the sky slowed back down it returns to
  // 240. Keep them in ratio if the sun mass changes again. THROWN keeps its
  // own low threshold — fling/alien-throw speeds are ship-derived, not orbital.
  DMG_THRESH: 240,         // closing speed below which impacts just bounce
  DMG_THRESH_THROWN: 140,  // threshold when either body was recently thrown
  DMG_THROWN_MULT: 2,
  // DEALT damage is tempered (user calls, 2026-08: damage "shouldn't increase
  // exponentially as things get bigger", then "it shouldn't just affect the
  // top end, it should affect the whole thing"). The mass term in every
  // dealt-damage formula goes through config.dmgMass:
  //   LOW_MUL * m                        at or below DMG_MASS_KNEE
  //   LOW_MUL * KNEE * (m/KNEE)^EXP      above it
  // The knee sits at the BOTTOM of the throwable range — the smallest
  // combat-ladder rung — so the ENTIRE ladder from ordinary rock to gas giant
  // rides the sublinear curve. Net factors vs raw mass: x1.3 at and below the
  // 600 rung, a 2500 rock ~x0.60, a 6000 boulder ~x0.38, a 13k moon ~x0.25, a
  // mid planet ~x0.074, a gas giant ~x0.03. Sub-knee dust rides the flat
  // LOW_MUL rather than the power curve — normalizing a sublinear curve
  // anywhere above the floor makes everything under the pivot hit HARDER
  // still (an uncompensated 600 pivot was a 2.4x pebble buff; the deliberate
  // lift is 1.3x). First shipped as knee 6000 / EXP 0.6 ("top end only"),
  // rejected twice; the whole-range clamp is deliberate, and it re-prices the
  // celestial kill ladders wholesale — the measured post-temper rungs live in
  // the combat bench baseline, not in invariant 8's old hit-counts. Ship
  // TAKEN damage already saturates via massSat and is not run through this.
  // LOW_MUL is a bottom-end lift (user call, 2026-08: "the little guys should
  // do more" — the gap from boulders up to planets read too wide). It scales
  // the WHOLE curve, and the exponent drop 0.5 -> 0.46 is what pays for it:
  // the two cancel at gas-giant mass, so the lift tapers — +30% at and below
  // the knee, ~+19% on a boulder, ~+15% on a moon, ~+6% on a mid planet, ~0
  // at the top. Change either constant without re-deriving the other and the
  // top end silently moves too.
  DMG_MASS_KNEE: 600,
  DMG_MASS_EXP: 0.46,
  DMG_MASS_LOW_MUL: 1.3,
  // Ship impact damage: closing * DMG_SHIP * massSat, where massSat is the
  // impactor's mass saturating at 1 — the saturation knee SCALES WITH BEAM
  // TIER (1500 * (1 + tier * 1.2) in collideShipBody), so pebbles that
  // stung a scout barely tickle a dreadnought while planet slams always
  // hurt. Capped at 45% of max hull per hit.
  DMG_SHIP: 0.18,
  RESTITUTION: 0.35,

  // ---- THE BRAWLER'S RAM (War Rack) -------------------------------------
  // A rock absorbed into the ram STOPS BEING A ROCK. It is destroyed and its
  // mass is added to one scalar, `ship.ram` — there is no pack of bodies flying
  // in formation ahead of the hull. That was the first build of this and it was
  // wrong in a way worth recording: seven real bodies parked on the bow
  // collided with the target on their own, died individually before the hull
  // ever arrived, and left the "ram" as a cloud of debris rather than a thing
  // attached to the ship. A ram is ONE object, it is welded on, and it grows.
  //
  // Capacity: what the ram can hold, per War Rack rank and tier. The per-rock
  // gate is still config.canStow (a class rung plus a mass allowance), so the
  // ram is boulder-capped the way the rack was — you build a ram out of rock
  // you could have thrown, not out of moons.
  RAM_CAP_PER_RANK: 4200,   // x rank x (0.6 + 0.14 * tier): ~2.5k at rank 1 -> ~33k maxed
  // SIZE, and it is deliberately FRONT-LOADED. The growth curve is
  // pow(fill, 0.4), not sqrt: the first few rocks have to visibly transform the
  // slab or the build phase gives no feedback for its first ten seconds, and a
  // ram that creeps up in imperceptible increments is one the player never
  // learns to read. Two rocks into a rank-6 ram is already a third of its full
  // size; the last rocks thicken a thing that is plainly there. The slab's
  // actual dimensions live in config.ramPlate — the ONE geometry render draws
  // and physics measures, per the CFG.dockDomeR mirror-drift rule.
  RAM_R_POW: 0.4,           // front-loaded growth (see above)
  // ABSORPTION. Front-arc damage is taken by the ram INSTEAD of the hull —
  // fully, not as a percentage — and spends this much ram mass per hull point
  // it eats. The hull takes nothing at all until the ram is gone, which is the
  // whole promise of the thing; what it costs is that the ram is then gone.
  // 120 sets the exchange: a rank-1 ram (~2.5k) is worth ~21 hull — one solid
  // hit — and a maxed one (~33k) is worth ~270, a whole brawl.
  RAM_ABSORB: 120,
  // INERTIA. A big ram carries you THROUGH what you hit instead of bouncing:
  // the contact kick is scaled by (1 - RAM_KEEP_MAX * ram/(ram + RAM_KEEP_KNEE)).
  // Saturating on ABSOLUTE mass, not on fill, because "bigger" has to mean
  // bigger — a full rank-1 ram is still a small ram and should still bounce.
  RAM_KEEP_KNEE: 6000,
  RAM_KEEP_MAX: 0.85,

  // PLANET DURABILITY (user design law: "killing a planet should feel like a
  // feat"). Planet hp is a BIG FLAT BASE plus a gentle mass slope, NOT the
  // mass-scaled curve every other body uses — because mass-scaled hp gets the
  // sizing exactly backwards once mass dominance is in play. Dominance already
  // throttles what a small impactor does to a heavy body (damage roughly
  // 1/targetMass), so a mass-proportional hp curve punished big worlds twice
  // and left SMALL planets — barely heavier than a big moon, so dominance
  // barely protects them — as paper: at the old `massToHp x 0.4`, ONE thrown
  // moon (4.7k-12k damage) vaporized a 96-hp world outright. The flat base is
  // what makes a planet survive a moon; the slope keeps a giant meaningfully
  // tougher without running away.
  // The intended ladder, and the reason the numbers are where they are:
  //   thrown ROCK   -> chips and scars it. Hundreds of hits. Planets are not
  //                    rock-killable, on purpose.
  //   thrown MOON   -> a real wound, several to many hits. It SURVIVES one.
  //   thrown PLANET -> the killing blow. That's the feat.
  // Damage still lands in full — scars, craters, chunk spray and mass loss are
  // all gated on ABSOLUTE damage as well as hp fraction (CHUNK_DMG_MIN, see
  // below), which is exactly why raising hp doesn't quietly stop a planet from
  // visibly coming apart. Corona heat is a fraction of maxHp per second, so a
  // planet still melts in the sun at the same rate as before.
  // 18000 -> 7000 (2026-08): re-priced for the dmgMass temper, on the user's
  // call — the old base was sized against LINEAR mass damage, and under the
  // tempered curve it made worlds feel unkillable (a moon slam took 23 hits;
  // the planet-fling one-shot was gone). At 7000 the original ladder reads
  // again: ~11 moon slams wound a mid world down, a hard (~900) fling of a
  // comparable planet is the killing blow, rock still chips in the dozens.
  // The flat-base-not-mass-curve SHAPE is unchanged — that part is invariant 8.
  PLANET_HP_BASE: 7000,
  PLANET_HP_MUL: 1.2,

  // MOONS ARE THEIR OWN DURABILITY CLASS TOO — the rung between belt rock and a
  // planet. They shipped on the plain `massToHp` curve every pebble uses, which
  // put a 8,000-mass moon at 96 hp: less than a single solid throw, so a MOON —
  // a named, charted, permanent piece of the sky — died to about the same
  // effort as a boulder. That is the wrong end of the ladder in invariant 8,
  // which reads "rock chips a PLANET, moon wounds it": for that to mean
  // anything a moon has to be a thing you work at, not a thing you clip.
  // Same shape as the planet class and for the same reason (mass dominance
  // already throttles what a small impactor does to a heavy body, so a
  // mass-proportional curve punishes big moons twice): a flat base, well under
  // PLANET_HP_BASE so the ladder still reads, plus a gentle slope.
  //   thrown ROCK -> chips it, tens of hits
  //   thrown BOULDER / another MOON -> a real wound, a handful of hits
  // Raising this does NOT quiet the crumble: craters, calving and mass loss all
  // gate on ABSOLUTE damage as well as hp fraction (invariant 7's dual gate).
  // It does NOT stop the ambient "absorbed" losses either — that rule is a mass
  // ratio and never reads hp — those are a rail/derail question, not toughness.
  MOON_HP_BASE: 2600,
  MOON_HP_MUL: 1.0,

  // CHUNK SHEDDING: big bodies don't fail all-or-nothing — a single hit that
  // bites hard enough (≥ CHUNK_DMG_MIN absolute damage, or ≥ CHUNK_DMG_FRAC of
  // maxHp for smaller "big" bodies like moons) knocks real chunk asteroids off
  // at the impact point and carves a persistent surface scar (physics.damageBody
  // → render's crack/scar pass). The absolute floor matters for planets: mass
  // dominance throttles their per-hit damage to a few points, so a frac-only
  // gate would mean planets never visibly shed. Corona heat can never shed —
  // its per-call drip is ~0.1% of maxHp (HEAT_DPS_BODY / 120), far under both
  // gates. CHUNK_MAX_MASS stays FAR below the 5e4 rail-disturber threshold
  // (physics rail scan) so flying chunks can never wake whole rail lanes.
  CHUNK_MIN_MASS: 3500,    // bodies at/above this mass shed chunks (moons and up)
  CHUNK_DMG_MIN: 4,        // absolute damage floor — lets ordinary throws crater planets
  CHUNK_DMG_FRAC: 0.045,   // or: single hit bites this fraction of maxHp
  CHUNK_MAX_MASS: 3200,    // per-chunk mass cap (grabbable boulder, never a disturber)

  // THE DEBRIS BUDGET — the one ceiling every fragment system answers to.
  // EVERY one of them used to gate on `game.bodies.length < 450`, written when
  // the world held ~380 bodies. The dense fields put ~7,900 rocks in that same
  // array, so from the day the shoals landed the comparison was false on frame
  // one and chunk spray, spall, a dying world's debris cloud and the BRAWLER's
  // Cluster Rounds ALL silently stopped happening — a planet took damage and
  // only ever grew decals. Shoal rock must not be able to starve the rest of
  // the sim of fragments, so the budget counts NON-FIELD bodies only (the
  // reg.nonField registry, ~380 in a fresh world) and the fields keep their own
  // separate ceilings (FIELD_ROCKS, the 10600/11200 caps in world/physics).
  // Read through physics.debrisRoom, which is one frame stale for bodies born
  // this frame — the per-event caps below are what actually bound a single
  // burst, the budget bounds the accumulation.
  // 1900 = the old 1500 moved with the 2026-08 growth pass: the moon chunk
  // shells (and the larger moon census they ride) raised the PERMANENT
  // non-field population from ~800 to ~1100+ (bench stability, four seeds),
  // and a ceiling that stood still would have quietly halved the room every
  // cascade, spall and Cluster Round has to mint into (measured:
  // minDebrisHeadroom 680 → 260 before this moved). +400 restores the
  // accumulation room the old margin gave; the per-event caps are untouched.
  DEBRIS_BUDGET: 1900,

  // THE GRAVEL MULTIPLIER — what the debris budget stopped having to bound.
  //
  // A hit's wreckage yield was written against DEBRIS_BUDGET, because every
  // piece was a full Body and a Body is expensive. Measured, 6,000 pieces in one
  // place: 13.12ms of sim as Bodies against 1.96ms as gravel, and 3.55ms of draw
  // against 0.15ms — 11.9x on sim, 16.8x on the frame, 2.03us a piece down to
  // 0.17us. At that price the yield no longer has to answer to the budget at
  // all; only the part of it that stays REAL does.
  //
  // So an impact now sprays this multiple of what it used to. The first
  // debrisRoom pieces are minted as Bodies exactly as before — grabbable,
  // damaging, carrying gravity-billiards credit, indistinguishable from today —
  // and the rest are gravel, which promotes to a Body the moment the beam
  // reaches for one (physics.promoteGravel). The budget goes back to bounding
  // what the SIM carries; it no longer bounds what the player is allowed to see.
  //
  // Deliberately a MULTIPLIER on the existing yield rather than a new absolute:
  // the shape of a spray (how it scales with severity, where the first pieces
  // come out of the crater) is tuned, and this must not reshape it — only make
  // more of it.
  GRAVEL_SPRAY_MUL: 10,
  // ...but 1 (i.e. none of the extra) inside a dense field. See physics.js: a
  // pocket is already made of rock, and spraying 10x grit per hit across ~800
  // plain asteroids is what buried a tier-5 throw in thousands of grains.
  GRAVEL_SPRAY_FIELD: 1,

  // ---- CRUST DEBRIS: the crumble layer -----------------------------------
  // A world under fire CALVES. Every wounding hit knocks real pieces of the
  // planet loose at the impact point, and — unlike the old chunk spray, which
  // fired them off at 80-450 u/s to become ordinary belt gravel a screen away
  // — they STAY: a rubble halo hanging over the wound that the player can fly
  // through, grab, and throw back. Two rules make that work:
  //   SIZE IS DECOUPLED FROM MASS, exactly like the WORLD SCALE law that made
  //     planets 3x their authored radius at unchanged mass. A 3200-mass chunk
  //     draws at radius 10 — a speck beside a 705-radius world, which is why
  //     the old spray read as dust even when it fired. A crust slab's radius
  //     is a FRACTION OF ITS HOST instead, so a piece of a planet looks like a
  //     piece of that planet. Mass stays under CHUNK_MAX_MASS, so nothing here
  //     can wake a rail lane (the 5e4 disturber threshold) or change what a
  //     chunk does to anything it hits.
  //   THE HALO IS RIGID — one shared angular speed per host, the same law the
  //     dense-field pockets run on (see FIELD_* / the shared rail.w). Mixed
  //     angular speeds around one world means neighbouring slabs catch up and
  //     grind, and railed bodies shoved apart by contact resolution snap back
  //     on the next rail advance — a visible vibration. Rigid means the rubble
  //     keeps the shape the impacts gave it, which IS the design ask: the
  //     debris stays localised to where the damage happened.
  // Fresh pieces fly FREE for a beat (they tumble, bump, and spread — the
  // crumble), settle under a band assist, then rail onto the halo for good.
  CRUST_BAND_LO: 1.05,     // halo inner edge (x the host's surface reach)
  CRUST_BAND_HI: 1.5,      // halo outer edge — a hugging halo, not a ring system
  CRUST_SETTLE: 1.9,       // 1/s — how hard the band eases a loose piece onto the halo
  CRUST_FREE: 1.1,         // seconds a fresh piece tumbles before the band takes it
  CRUST_R_MIN: 0.02,       // crumb radius, as a fraction of the host's radius
  CRUST_R_MAX: 0.15,       // slab radius at a full-severity wound
  CRUST_HP_MUL: 3,         // a slab is a real target — hp follows the DRAWN size
  // A BIG PIECE OF A WORLD BREAKS LIKE THE WORLD DID. Crust slabs are drawn as
  // a fraction of their parent planet, so the biggest run 100+ units across —
  // and a rock that size popping into a puff of dust reads wrong beside a
  // planet that comes apart into sixty pieces. Above CHUNK_SPLIT_R a chunk
  // shatters into smaller chunks of its own material instead. Each child is
  // roughly a third to a half its parent, so the cascade runs two or three
  // levels and then stops on its own — bounded by construction, the same shape
  // as the dense fields' giant-shard rule.
  CHUNK_SPLIT_R: 15,       // drawn radius above which a chunk shatters instead of puffing
  CHUNK_SPLIT: [3, 7],     // pieces one splitting chunk yields
  // FRESH FRAGMENTS ARE INERT TO OTHER DEBRIS for this long. Without it,
  // throwing one big slab into a world's halo detonated the entire system: the
  // slab split, its pieces smashed the 26 halo slabs and 24 belt pieces packed
  // around them, each of those split, and the wave ran until it hit the debris
  // budget — hundreds of large bodies colliding at once, the frame rate gone,
  // and (because the billiards credit stamp rode along) every one of those
  // deaths paying throw-kill XP, which took a fresh run to tier 5 in a couple
  // of seconds. Two independent fixes: a split no longer propagates player
  // credit at all (shatter, the same rule shard/Demolition damage follows), and
  // fresh pieces pass through OTHER DEBRIS while this window runs. The ship and
  // the aliens still collide with them throughout — they are the things a
  // player is aiming at, and a slab that ghosted through an enemy would be a
  // worse bug than the one this fixes. Celestials still collide too: passing
  // through a planet for four seconds and popping out the far side reads as
  // broken, and rock-on-rock is where the cascade actually lived.
  CHUNK_INERT: 4,

  // ---- THE LEASH: loose debris is scenery, and scenery has a range ---------
  // A PLANET SYSTEM IS ALIVE WHILE YOU ARE IN IT. Everything the crumble mints
  // is rubble around a world, and once you have flown to the next lane it is
  // rubble nobody will ever look at again — but it still pairs in the collision
  // broad phase, still holds a slot in the debris budget, and still keeps its
  // pocket of the sky busy forever. So loose debris that drifts clear of the
  // player is retired. Railed bodies are exempt (a world's belt, its junk
  // probes, the ring chunks, the trojans — those ARE the system, and they cost
  // nothing once dormant), and so is everything the expedition layer cares
  // about: cores, caches, mayday pods, the carved stone, the visitor, wrecks,
  // comets.
  // Both leashes sit far outside any view (the screen edge is at 1.0x viewR),
  // so nothing can ever be seen to vanish — that is the whole constraint.
  DEBRIS_LEASH: 3.2,       // x viewR, plus the pad below: ordinary loose rubble
  THROW_LEASH: 7,          // x viewR: something the PLAYER threw gets a long run
  LEASH_PAD: 2200,         // absolute floor added to both, so a tight zoom still reaches far

  // ---- AMBIENT WORLD WEAR --------------------------------------------------
  // A world you are not at still lives in a shooting gallery. Left alone it
  // slowly picks up meteor damage, so a lane you come back to after twenty
  // minutes has visibly weathered rather than being pristine exactly as you
  // left it. Deliberately SLOW and hard-FLOORED: this must never be a way for
  // the sky to fall apart on its own — invariant 8's whole point is that
  // killing a world is a feat the PLAYER performs — so it can only ever take a
  // planet down to PLANET_WEAR_FLOOR of its maxHp and then stops dead. It also
  // never derails, never sheds mass and never calves (see world.wearWorlds):
  // this is weathering, not impacts.
  // The per-world rate is hashed off the body id, NOT drawn from the world rng
  // — a draw there would reshuffle the entire seeded sky (see the
  // expedition-layer rule in world.js).
  PLANET_WEAR_FLOOR: 0.5,      // hp floor as a fraction of maxHp — a hard stop
  PLANET_WEAR_DPS: [1.1, 4.2], // per-world rate band, hp/sec (≈40-160 min to the floor)
  PLANET_WEAR_SCAR: 0.055,     // one small crater per this fraction of maxHp worn away
  CRUST_PER_HOST: 26,      // rubble pieces one world carries (past this it recycles off-view)
  CRUST_DEATH: [44, 92],   // pieces a dying world comes apart into

  // Speed governor: each engine level raises the ceiling; excess speed
  // (slingshots, knockbacks) bleeds off at SPEED_BLEED x the overage per
  // second, and NOTHING sustains beyond SPEED_HARD x the ceiling. The old
  // gentle bleed (0.8, no hard cap) predates the long-arm gravity boost —
  // 6x far-field assists let low-level ships coast at absurd speeds.
  // The ceiling is measured RELATIVE to the local orbital flow
  // (physics.orbitalFlow): the ship's velocity is capped to within maxSpeed of
  // the surrounding space's prograde circular velocity. The current carries the
  // ship and the engine buys maxSpeed of deviation in any direction — with the
  // spin you reach flow+maxSpeed, against it flow-maxSpeed. predictPaths mirrors
  // the bleed, the hard cap, AND the flow-relative reference; keep all in sync.
  SPEED_BLEED: 1.6,
  SPEED_HARD: 1.9,

  // Fair-view normalization: cam.zoom is scaled by the canvas diagonal so
  // EVERY window sees the same world extent — a small screen renders the
  // world smaller instead of cropping it, and a huge monitor grants no wider
  // view. At this reference diagonal (1920x1080) zoom equals the tuned
  // values exactly. Screen-space UI (DOM HUD, minimap, the /zoom stroke
  // idiom) is unaffected and never scales.
  VIEW_REF_DIAG: Math.hypot(1920, 1080),

  SHIP_TURN: 9,            // rad/s — the nose tracks the mouse
  // Engine SPOOL: thrust BUILDS over a long ramp rather than stepping to
  // full — THRUST_SPOOL_T seconds from a standing start to 100%, on a
  // normalized exponential approach that lands EXACTLY at full power at T,
  // tuned to pass ~75% at 2s (user call). Release is a fast exponential
  // FALLOFF — quick at first, gentle at the tail, spent in about a second —
  // and re-pressing mid-decay RESUMES the ramp from wherever the falloff
  // left the engine (physics inverts the curve, so there is no jump either
  // way); a direction flip still restarts from zero. physics.step owns the
  // state (s.spool); the plume art and the HUD thrust ring read it.
  THRUST_SPOOL_T: 6,       // seconds, standing start -> full thrust
  THRUST_SPOOL_K: 0.7,     // 1/s — curve steepness (~75% of full by 2s)
  THRUST_DECAY: 4,         // 1/s — release falloff (~13% left by 0.5s, spent ~1s)
  // The afterburner's own spool: the boost multiplier fades IN over half a
  // second of the tank opening (user call: "kick on fully within 0.5s") —
  // never a step on the frame Shift lands. Releasing is DELIBERATELY SLOWER
  // (user call: "should take 3 seconds to come down after it stops") — the
  // burn is spending a scarce tank, so the extra shove it bought should
  // linger a beat past letting go rather than cutting the instant the key is
  // up. Same exponential-approach math as THRUST_SPOOL/_DECAY, just applied
  // to the boost fraction (s.burnK) instead of the throttle itself.
  BURN_KICK: 9,            // 1/s — ~99% of the boost within 0.5s
  BURN_DECAY: 1.8,         // 1/s — release falloff, spent in ~3s
  // The SHIELD recharges after a quiet spell; the HULL never self-heals — it
  // mends only by collecting glow-pocket motes (glow.js)
  SHIP_REGEN: 9,           // shield/s once recharging
  SHIP_REGEN_DELAY: 5,     // seconds without damage before recharge starts

  PICKUP_MAGNET: 620,      // scrap starts homing inside this range
  DEBRIS_LIFE: 150,

  // HEFT AND SPOOL-UP — why a big rock does not handle like a pebble.
  //
  // `st.force` is a force and springHeld divides it by the load's mass, so the
  // beam's authority already falls as 1/m. That is not the same thing as a big
  // rock being HARD TO PUSH: force scales with `capacity`, so the heaviest
  // thing your beam can lift always swung with about the same authority as the
  // heaviest thing it could lift a tier ago, and a maxed hauler whipped a moon
  // around exactly like a scout whips a pebble.
  //
  // TRACTOR_HEFT re-couples the two: authority is scaled by 1/(1 + HEFT*heft²)
  // where heft is the load's mass as a fraction of your allowance. It is
  // SQUARED so the drag stays off the light end — anything under half your
  // allowance keeps ~90% of its authority and the ordinary belt-rock loop is
  // untouched — and bites hard only at the top of your class (0.385x at a
  // max-weight load).
  //
  // TRACTOR_SPOOL is the other half: the beam does not lock in instantly, it
  // takes a grip. Authority opens from TRACTOR_SPOOL_MIN on a squared ramp, so
  // it is weak for the first moment and only gets really strong after you have
  // held the thing a while — the ramp is scaled by heft, so a pebble is at full
  // strength in about a second and a max-weight load takes the full time. NOT
  // applied to the orbit shield or the brawler's trail rack (tractor.updateOrbit
  // owns those, with its own caps): those are formations you have already paid
  // for, and re-spooling every rock in a seven-slot ring on every capture would
  // make the wall sag exactly when it is being shot at.
  TRACTOR_HEFT: 1.6,       // authority falloff strength vs load fraction (squared)
  TRACTOR_SPOOL: 3.2,      // seconds to a full grip on a max-weight load
  TRACTOR_SPOOL_MIN: 0.4,  // authority the instant the beam takes hold
  // A ROCK YOU JUST THREW IS NOT A TARGET AT ALL FOR THIS LONG (user design
  // rule). tractor.pickTarget already ranks your own shots last, but demotion
  // only helps when something ELSE is under the cursor — out in open space your
  // last shot is alone out there and still won the click. A hard window is what
  // makes rapid fire feel right: throw, throw, throw, and the beam never once
  // reaches back for the rock already doing its job. After it expires the rock
  // is grabbable again, still at the bottom of the precedence ladder.
  // Stamped by the two BEAM launches only (releaseHeld / flingAllFromOrbit) —
  // NOT by billiards credit, where `thrownBy = 'player'` marks a rock your shot
  // merely knocked, and locking those out would block grabbing the scatter from
  // your own impact.
  THROW_LOCKOUT: 2,        // seconds
  // ONCE THE BEAM IS AT FULL POWER THE TETHER CANNOT BE BROKEN, and instead of
  // snapping at the old leash it goes TAUT at this multiple of the beam ring
  // (`st.range` — the ring drawn around the ship, so the limit is something the
  // player can already see). tractor.springHeld resolves it as a rope: cancel
  // the separating velocity, split the overshoot by mass. Against a moon the
  // ship is the one that moves.
  TETHER_MAX_MUL: 1.3,
  // …and it RUBBER BANDS into that limit rather than hitting it as a wall. The
  // give is a fraction of the max taken from INSIDE it: the band starts biting
  // at (1 - this) x max and is fully taut at max, so the stated ceiling stays
  // literally true and a third of the way in is spent easing you to a stop.
  // The band only ever acts on SEPARATING motion, so a long soft zone costs
  // nothing during ordinary holding — the rock tracks the ship and never
  // separates. It is only felt when you actively pull against it, which is the
  // only moment it should be felt at all. (Was 0.16, which still read as a
  // wall arriving early rather than as rubber.)
  TETHER_STRETCH: 0.35,
  // How fast the rope hauls in slack, once it has taken hold somewhere past the
  // limit (see springHeld: the rope's length is state, not a constant). Slow
  // enough to read as being reeled in, fast enough that a world does not stay
  // out at arm's length for long.
  TETHER_REEL: 300,        // world units per second

  // THE WINCH CREDITS THE WIND-UP BUT MUST NEVER FINISH IT (user design rule:
  // full power always takes longer than the winch). The winch seconds carry
  // into `holdT` so the player is not billed twice — but carried in FULL they
  // covered the whole ramp on the heavy rungs, so a moon or a world hit full
  // power at the exact instant it latched. That collapses two mechanics into
  // one number and leaves the READY signal with nothing to announce. grabBody
  // caps the carry so at least this long is always left to run after the beam
  // takes hold, whatever the class.
  WINDUP_AFTER_LATCH: 1.2, // seconds of wind-up guaranteed after every latch
  // THE CHARGE READOUT (render.drawCharge). Only shown for loads at or above
  // this fraction of your allowance: below it the wind-up multiplier is within
  // a few percent of 1 and the ring would be noise on every belt pebble.
  CHARGE_SHOW_HEFT: 0.25,
  CHARGE_FLASH: 0.5,       // seconds the "full power" bloom lasts
  // THE LAUNCH. A throw is the loudest thing the player does and it used to
  // happen in total silence visually — the rock simply changed velocity. This
  // is the muzzle flash: one record per launch (tractor pushes, render.js
  // draws, main.js decays), scaled by how big the load was and whether it went
  // out at full power, so a charged moon leaves a crater of light and a pebble
  // a blip. A LIST, not a single timer like game.jinkT: rapid fire overlaps,
  // and a shotgun volley launches a whole ring at once.
  LAUNCH_FX: 0.42,         // seconds a launch flash lives
  LAUNCH_FX_MAX: 12,       // most flashes alive at once (a full volley + change)

  ORBIT_OMEGA: 1.5,        // rad/s — how fast the shield orbit spins
  // SHOTGUN volley: holding RMB arms orbiters progressively over this many
  // seconds (1 at a tap -> all at full charge); release fires what's armed,
  // and hitting full charge fires automatically
  VOLLEY_TIME: 2,

  // Rails: celestial bodies ride precomputed orbits until something disturbs
  // them (impulse, grab, or a heavy wanderer inside this range).
  RAIL_DISTURB: 1400,
  RAIL_RETRY: 2,           // seconds between re-rail scans
  RAIL_TOL: 0.16,          // max fractional deviation from circular to re-rail

  ALIEN_HP: 45,
  ALIEN_RADIUS: 13,
  ALIEN_ACCEL: 250,
  ALIEN_SPEED: 330,
  ALIEN_CAPACITY: 2600,    // heaviest rock an alien can grab
  ALIEN_THROW: 430,
  ALIEN_CONTACT_DMG: 24,
  ALIEN_FIRST_WAVE: 55,    // seconds of peace at the start
  // (No ALIEN_WAVE_EVERY. Timed waves are gone — nests and shoal-lurker broods
  // are the only alien sources now, per the sparse-enemy design law, so only
  // the opening grace period above survives from the old spawner.)
  ALIEN_SCRAP: 28,
  ALIEN_TERRITORY: 6000,   // aliens defend their nest's turf, never roam past this
  ALIEN_BURST: 4,          // a nest can scramble up to this many at once

  // DENSE ASTEROID FIELDS (world.js seedDenseFields): packed rock shoals
  // riding the sun's rails at fixed radii, each home to a finite brood of
  // SHOAL LURKERS (ai.js) — camouflaged ambushers that never leave the field.
  // SIZE AND COUNT ARE SEPARATE KNOBS. The pocket is deliberately VAST — a
  // field you cross in two seconds is a clump, not a region — so the extents
  // grew far faster than the rock count: the shoal should read as somewhere
  // you fly INTO and are surrounded by, with real open lanes inside it rather
  // than wall-to-wall gravel. Rock SIZE carries the density impression
  // instead (world.fieldMass skews big, few pebbles).
  // TOTAL bodies per pocket — the huge packed rocks plus the rubble that banks
  // against them (world.seedDenseFields fills the remainder with rubble, so the
  // small-rock count is this minus however many big rocks landed, 89-97).
  // Measured across the four pockets, seeds 20260721 and 3827467762: a pocket
  // censuses 904-915 of a ceiling of 920 (the packer gives up on the last few
  // slots), split 89-97 masonry + 808-825 rubble; the world carries 371-377
  // shaped landmarks in total. The packer places all of those but the HEART,
  // which seedDenseFields pins at the field centre before packing starts.
  // Re-measure this split whenever FIELD_ROCKS or FIELD_GIANTS moves —
  // `node .claude/skills/run-solar-slinger/bench.mjs save worldgen` reports the
  // per-pocket `rocks` straight out of the suite.
  //
  // Cut to a THIRD of the old small-rock count (1856 -> ~620) at the same time
  // as the pocket grew 30% in each axis. Both moves thin the gravel on purpose:
  // the maze is carried by rock you can see and route around, and a dense haze
  // of pebbles between the giants only obscured it. Density is a fifth of what
  // it was, and the pocket reads as more open BECAUSE the structure in it is
  // more legible, not less full.
  // NB: this is the pocket's TOTAL body count, masonry included — the rubble
  // loop runs `for (i = bigs.length; i < FIELD_ROCKS; i++)`, so raising the
  // landmark count without raising this pays for the landmarks by deleting
  // gravel.
  // Back at its long-standing value after a detour to 660. Cutting THIS is not
  // how the pocket's density came down — the density the player feels is the
  // MASONRY, and that came down by capping where big rock may go
  // (FIELD_REACH) and spacing it by its true extent (FIELD_PACK_GAP). Cutting
  // gravel instead just thinned the haze the small rock provides, which is what
  // makes the outer approach read as a rock field at all.
  // Held at 800 while the fracture library lands. It was briefly at 1250, raised
  // chasing road visibility — a +54% swing in TOTAL world bodies that was never
  // measured for frame cost. The collider rewrite has to be A/B'd against a
  // stationary target, and the roads don't read for a reason raw count doesn't
  // fix (they measure genuinely clear: 0.013 cover inside vs 0.200 outside, 15x,
  // but occupy only 9.3% of the pocket, so there is nothing dense enough beside
  // them to read as a wall). Density contrast is the lever, not population.
  // Held at 800 while the fracture library lands (it was briefly 1250, an
  // unmeasured +54% on total world bodies). With FIELD_GIANTS down to 300 this
  // is now MOSTLY ordinary asteroid rather than landmark, which is the requested
  // mix: fewer mid and small shaped rocks, more plain rock between them.
  // 800 -> 920, +15% plain asteroid. This is the pocket's TOTAL body count with
  // the masonry counted inside it, and the rubble loop runs
  // `for (i = bigs.length; i < FIELD_ROCKS; i++)` — so with FIELD_GIANTS cut to
  // 100 at the same time, nearly the whole rise plus the freed landmark budget
  // lands as plain rock, which is what was asked for from both directions at
  // once.
  FIELD_ROCKS: 920,
  // Pocket size is PHYSICAL, not angular — an angular width scales with the
  // orbit radius and turned the outer field into an 11,000u dilute arc.
  // The pocket is deliberately close to ROUND rather than a long lane-shaped
  // smear: the design goal is that flying in you get LOST in it, and a wide
  // arc you cross in one straight line never does that no matter how long it
  // is. At 7700 x 5700 against a ~450u view radius, the far side is nearly
  // twenty screens away in every direction. These are the EXTENTS of the
  // outline, not a rectangle: the actual boundary is the lobed blob in
  // fieldLobe() below, sampled by world.fieldPoint — a rectangular scatter at
  // these numbers read as an obvious square of rocks.
  //
  // THE POCKET AND EVERYTHING IN IT SCALE TOGETHER. These extents were cut 15%
  // on each axis, and FIELD_GIANT_R_MUL / FIELD_MONOLITH_R_MUL / FIELD_PACK_GAP
  // / FIELD_RUBBLE_BAND were all cut by the same 0.85 with them. That is not
  // tidiness, it is the only way to shrink a pocket without losing rocks: a
  // 15%-per-axis cut is 28% less AREA, and these pockets already run ~71% rock
  // coverage, so holding the rocks at their old size would have needed ~99%
  // coverage — above the theoretical limit for packing circles at all. The
  // packer would simply have failed the last ~25 draws per pocket and quietly
  // thinned the maze. Scaled together, the count, the density, the passage
  // widths and the traversability are all preserved exactly; the whole shoal is
  // just 15% smaller.
  // (Earlier this went the other way — grown 30% on each axis.) NOTE WHAT THE
  // EXTENTS TOUCH: a pocket
  // reaches FIELD_SPREAD x FIELD_LOBE_MAX either side of its lane, which is
  // ~4,060 units now, and the fields sit only ~800-1,000 units clear of the
  // neighbouring PLANET lanes (the Shoal at 10,400 spans two of them). That
  // overlap already existed and is fine — field rock is gravity-free so it
  // cannot perturb a lane, and a planet simply ploughs through — but it is why
  // the stability suite across all four seeds is the check that matters when
  // these numbers move, not worldgen.
  // FIELD_GIANTS / FIELD_MONOLITHS were scaled with the AREA at the same time.
  // Growing the pocket without growing the masonry spreads the huge rocks
  // apart, the packing gaps stop being gaps, and the maze quietly dissolves
  // into a scatter — the size and the structure are one knob in two halves.
  FIELD_LEN: 3260,         // tangential half-length of the pocket (world units)
  FIELD_SPREAD: 2431,      // radial half-thickness (world units)
  // A few GIANTS per pocket: landmark rocks big enough to navigate by and to
  // shatter into a cascade of smaller field rock (physics.shatter), which is
  // the chaos engine of the whole shoal. Gravity-free like everything else in
  // here — see the FIELD ROCK note below.
  // Raised 9 -> 200, and each one is scaled up by FIELD_GIANT_R_MUL: the giants
  // are the MAZE ITSELF now, not decoration in it. They are packed across the
  // pocket (world.packBigRock) and the passages are what they leave between
  // them, so this count IS the maze's density — scaled with FIELD_LEN /
  // FIELD_SPREAD, because spreading the same rocks over a bigger pocket turns
  // the gaps into open space and there is nothing left to navigate.
  // It is ALSO the budget for the shaped narrow phase: every one carries a real
  // polygon collider (rockshape.js via world.shapeBig), of which only the awake
  // ones are ever swept.
  // A REQUEST, NOT A GUARANTEE — world.packBigRock is best-effort and reports
  // what it actually placed. What bounds the real number is the packing rule
  // (FIELD_PACK_GAP, measured between REACH circles): the count should be
  // limited by whether the rock physically fits, not by a number picked to
  // approximate whether it fits.
  //
  // 100, down a long way. The class was crowding the core with exactly the wrong
  // thing: the bottom of a shoal's size ladder should be PLAIN asteroids — a
  // circle collider and an atlas sprite — not small landmarks paying for a
  // polygon narrow phase nobody can see at that size. The ramp is rank-based and
  // skewed small, so trimming the count takes the bottom rungs first and leaves
  // the handful of genuinely large rocks intact.
  // (main took this to 200 with a flat FIELD_GIANT_R_MUL of 10.2; that predates
  // the graded ladder below and would undo it — see FIELD_GIANT_SKEW.)
  FIELD_GIANTS: 100,
  // The mass ladder the class is drawn from — low end to high end. Walked by
  // rank through FIELD_GIANT_SKEW below, so this is a CONTINUUM of sizes rather
  // than a band.
  FIELD_GIANT_MASS: [8000, 130000],
  // Drawn size only — the same radius-not-mass rule as FIELD_MONOLITH_R_MUL, and
  // for the same reasons (grab class, damage ladder and payout all key off mass,
  // and none of them is what "bigger" is asking for).
  //
  // A [rim, core] RAMP, not a scalar, and world.js destructures it as one. The
  // multiplier rides the same `t` as the mass, so density falls with size — that
  // is what gives the class a populated mid-size rung instead of jumping from
  // gravel to monolith. The core end came down 30% (7.9 -> 5.53) because the
  // biggest rocks were too big on screen; the rim end is untouched, since moving
  // both would flatten the ladder that makes a shoal read as graded at all.
  FIELD_GIANT_R_MUL: [2.3, 5.53],
  // HOW THE COUNT IS SPREAD ALONG THAT LADDER — the exponent on rank position.
  //
  // THIS IS THE GRADIENT, and it is the single most misread knob in the file.
  // `t = pow(u, SKEW)` and mass runs from the HIGH end at t=0 to the LOW end at
  // t=1, so a skew far below 1 drives t toward 1 for nearly every rank and piles
  // the whole class into its smallest bucket. At 0.14 that measured, across four
  // pockets: 843 rocks between 24 and 48 units, 53 between 64 and 96, ONE
  // between 96 and 128, and NOTHING between 128 and 160 — then the monoliths
  // appearing from nowhere at 160+. That is not a gentle ramp with a heavy small
  // end, it is two populations with a hole between them, which is why flying in
  // never felt graded.
  //
  // 0.42 is where the two requirements meet, and they pull opposite ways: the
  // ramp has to reach high enough to leave no gap, while the large end stays
  // THIN. The share of the class above any rung is T^(1/skew), so this moves the
  // tail hard — 0.72 closed the hole but doubled rock over 160 units, and 0.42
  // keeps the ladder continuous while cutting that tail to about a third.
  FIELD_GIANT_SKEW: 0.42,
  FIELD_GIANT_SHARDS: [5, 9],   // pieces a giant breaks into (big shards re-flag as giants — one more cascade level)
  // Both lurker ranges are sized OFF the pocket, not absolutely: the wake
  // must reach past the far end (FIELD_LEN) or you could sit deep inside the
  // rocks without ever springing the ambush, and the territory has to contain
  // the whole pocket plus chase room or a lurker breaks off mid-slash.
  // (No circular wake/territory radii any more — lurker containment is the
  // POCKET FOOTPRINT itself, via fieldFrac() below: a circle wide enough to
  // cover the long axis overshot the short axis by 2x, and the baddies
  // visibly hunted open space outside their own rocks.)
  // MONOLITHS: a couple of rocks per pocket (plus the named heart), the
  // landmarks you steer by from across the shoal. Still field rock — no
  // gravity, and breakable only by a truly heavy blow (see FIELD_HP_CAP).
  // 5 -> 3, the requested 60% of the large end. Cut HERE rather than by capping
  // the giant ramp, because the ramp is what bridges up to this class: thinning
  // its top would re-open the gap that FIELD_GIANT_SKEW was just raised to
  // close. Fewer of the very large, with a full ladder leading up to each.
  FIELD_MONOLITHS: 3,
  // Raised with the giants (same "much more mass" call), and bounded by the one
  // number that matters here: TIERS.ceil[5] is 1,200,000, and a monolith above
  // it is permanently ungrabbable at every tier. The heart takes MASS[1], so
  // the ceiling of this band IS the heaviest thing in a pocket — 1.05e6 keeps a
  // fully-ranked top-tier beam able to take one, which is the payoff the whole
  // landmark is built around. Do not raise it past ~1.1e6.
  FIELD_MONOLITH_MASS: [3e5, 4.6e5],
  // ...and then DOUBLED AGAIN in drawn size. This is the world-scale law
  // (PLANET_R_MUL / MOON_R_MUL) applied to the shoal: it grows the RADIUS
  // only, and the mass is untouched. Going the other way — 8x the mass, since
  // radius goes with cbrt — would have moved everything that keys off mass:
  // it lifts a monolith past TIERS.ceil[5] (1.2e6), i.e. permanently
  // ungrabbable even at the top tier, and it re-prices the impact damage a
  // thrown one deals. Size is the thing being asked for here, so size is the
  // only thing that moves. Consequences that are deliberate: the collision
  // cross-section grows with the square (a bigger thing to thread past — that
  // IS the landmark), and the density is nominally lower, which nothing in the
  // sim reads. Applied in world.seedDenseFields to radius AND baseRadius, or
  // the first chip would snap it back to its mass-derived size (physics
  // eases radiusT off baseRadius * cbrt(mass / baseMass)).
  // (The mass raise above is the deliberate exception to that, argued at
  // FIELD_GIANT_MASS — it is scoped to the shoal's landmark classes and to a
  // user design call, and the ceiling it has to respect is spelled out there.)
  // Cut from 6.8 with that raise, on the same cbrt arithmetic the giants use, so
  // a monolith lands at ~228-413 units — unchanged in the only terms that read
  // on screen, and still clearly the biggest thing in the pocket now that
  // FIELD_GIANT_R_MUL has taken the giants to 36-325. A monolith is most of a
  // screen of solid rock: the thing you round and find the way blocked by.
  // 6.6 -> 4.62, the same 30% cut as FIELD_GIANT_R_MUL's core end, so the
  // monoliths stay the top of one continuous ladder instead of stepping out
  // above a class that just shrank underneath them.
  FIELD_MONOLITH_R_MUL: 4.62,

  // ------------------------------------------------------------------ MAZE --
  // THE MAZE IS THE ROCKS. Not a corridor network carved out of the pocket and
  // then filled around — that was the first attempt and it was wrong twice
  // over: the lanes read as randomly generated cleared paths (because that is
  // what they were), and the thing actually blocking you was gravel rather
  // than anything you could see coming.
  //
  // Instead the huge rocks are PACKED across the pocket at roughly half its
  // area, and the maze is the GAPS BETWEEN THEM. Everything follows from the
  // packing gap:
  //   - a passage is wherever two neighbours failed to touch
  //   - a dead end is wherever three of them did
  //   - passages open and close along their length because the gap is drawn
  //     per pair, so a route widens, pinches, and sometimes stops
  // Nothing is authored. The layout is a consequence of rock the player can
  // see and fly around, which is the whole point.
  //
  // The gap band, in world units, drawn per neighbour pair. The low end is
  // under a ship-length: those pairs read as touching and wall a route off.
  // Tightened with the giant count: the packer saturates long before it runs
  // out of rocks to place, so "more big rocks" is really "less room between
  // them" — raising FIELD_GIANTS alone just raises the number it gives up on.
  // This is the FLOOR on spacing, not a target — the greedy search in
  // world.packBigRock is what actually aims at it. The two have to move
  // together: with rejection sampling a tight floor did nothing (rocks still
  // landed wherever they first fit), and with a greedy search a loose floor
  // holds every rock at arm's length however hard it tries to snug up.
  // THE GAP IS NOW MEASURED BETWEEN REACH CIRCLES, SO IT MAY GO NEGATIVE — and
  // that is what keeps the walls solid. world.packBigRock spaces landmarks by
  // `radius * shape.reach` (the guarantee that no orientation can defeat), and
  // a reach circle is much bigger than the silhouette inside it in most
  // directions — mean reach is 1.49x, so a strictly non-negative gap would hold
  // every pair a third of a rock apart and the maze would dissolve into a
  // polka-dot scatter with no walls and no dead ends.
  // A negative gap lets the bounding circles interpenetrate, so silhouettes come
  // right up against each other, while the LOW END is a hard bound on how far a
  // pair can clip. Read it as "how much of the slack between circle and rock the
  // packer is allowed to spend": at -40 two neighbours nestle or rest on one
  // another; at +40 there is a passage.
  // SWEPT AGAINST ACTUAL SURFACE OVERLAP in a seeded pocket (mean over 4):
  //   gap[0]     0 -> 0 overlapping pairs, 216 landmarks placed
  //            -40 -> 5 pairs, worst 17u  (7% of one rock — not visible)
  //            -80 -> 31 pairs, worst 55u
  //           -150 -> 103 pairs, worst 118u  (the reported clipping)
  // Anything at or above 0 is a proof, not a tuning; below it this is a budget
  // for how much clipping is acceptable. RE-SWEEP if FIELD_SIZE_VARY, the
  // R_MULs or the shape kinds change — all three move `reach`.
  // *** THIS SWEEP IS OWED A RE-RUN. *** It was measured against the old per-id
  // generator, whose reach ran 1.14-1.62x radius. The whole shape library was
  // replaced by the bake (rockdata.js) and the tail now runs to 2.446 (68
  // shapes, mean 1.500), so the numbers above under-report the overlap a given
  // gap buys. The band was NOT retuned with the library — treat the table as
  // history until it is re-swept.
  // THE LOW END MAY NOT BE ZERO. At 0 the packer is allowed to set two rocks
  // down exactly touching, and a pocket seeded with touching mid-size rock is
  // trading contacts from the first substep — which is the clipping and the
  // breaking, not a collider fault: they were born in contact. Measured at 0:
  // 63 overlapping pairs at seed, 15 of them mid-against-mid.
  // 20 is under the drawn size of even the smallest landmark, so the masonry
  // still reads as interlocked rather than as spaced-out furniture; it just
  // cannot start the run already pressed together.
  FIELD_PACK_GAP: [20, 70],
  // ...AND A SIZE-PROPORTIONAL SHARE ON TOP, because the band above is absolute
  // and the slack it is spending is NOT.
  //
  // This is why "the really large ones seem to be all alone". The gap is applied
  // to REACH circles, and a reach circle exceeds its rock by (reach - 1) * r —
  // ~196 units of invisible margin on a 400-unit landmark against ~15 on a
  // 30-unit one. An absolute -40 claws back the same 40 for both, so the small
  // rock nestles and the big rock is left holding a margin nothing can close.
  // Measured, mean surface-to-surface gap to the nearest neighbour by size:
  //   r 0-50 -> 27,  50-90 -> 32,  90-150 -> 35,  150-250 -> 27,  250+ -> 85.
  // Every class sat at ~30 except the biggest, which sat at nearly three times
  // that — visibly stranded in its own clearing.
  // FIXED BY A TIGHTER BOUND, NOT BY A CONCESSION — this knob is kept at 0 and
  // documented because the obvious fix is wrong. Spending a fraction of each
  // radius does close the big rocks up, but it spends the very margin that
  // guarantees no overlap, and at 0.10 it put real clipping back: minimum
  // surface gaps went from -27/-20/-14/2/-12 across the size bands to
  // -49/-48/-44/-31/-49, i.e. the reported bug, reintroduced.
  // The margin was never the problem — using a GLOBAL max as a directional
  // bound was. world.packBigRock now bounds per direction (rockshape.reachAt), so
  // the spacing is honest at every size and the guarantee survives intact.
  FIELD_PACK_NESTLE: 0,
  // ---- SWIMLANES (user design law): routes THROUGH the rock, so that following
  // the path gives you a better shot of getting out. world.seedLanes draws them;
  // read the note there for why this reverses the earlier "no carved corridors"
  // decision and how it avoids the two ways that attempt failed.
  //
  // Three per pocket, rim to rim through an off-centre waypoint. Few on purpose:
  // enough that you find one, not so many that the rock between them stops being
  // the obstacle. More lanes is not more navigable — past a handful they start
  // intersecting and the pocket turns back into open space with debris in it.
  // RIM MOUTHS — where the network opens onto the approach. The road count is
  // much larger than this: the mouths feed a graph of interior junctions
  // (FIELD_LANE_NODES) and the edges between them, so a pocket carries roughly
  // mouths + nodes + chords roads in total.
  // 5 -> 8. The roads measured genuinely clear (0.013 cover inside against 0.200
  // outside, a 15x contrast) and still could not be SEEN, because five of them
  // across a pocket this wide is 9.3% of its area — you have to already be in
  // one to notice it. More of them, narrower, is the legibility lever: what
  // reads as a road is the WALL beside it, so the network has to be dense enough
  // that you are never far from an edge.
  FIELD_LANES: 8,
  // Interior junctions, spread from q 0.14 out to 0.76 so the network REACHES
  // THE MIDDLE. Roads that only ring the core leave it open and undifferentiated
  // — following one inward just stopped meaning anything.
  FIELD_LANE_NODES: 5,
  // Half-width band, world units, BEFORE the per-lane breathing (which runs it
  // from 0.45x to ~1.7x of the drawn value). At 190 a lane runs from a ~85-unit
  // squeeze — tight enough that a big load has to be threaded — out to a ~320
  // unit bay. Against a ~450 unit view radius, you can see a lane's walls on
  // both sides at its narrowest, which is what makes it read as a route rather
  // than as absence of rock.
  // Half-width band, world units, BEFORE the per-road breathing (0.45x-1.7x).
  // CUT HARD from [150, 230]. Narrow is what lets the network exist at all: a
  // 70-unit channel THREADS between 300-unit rocks, where a 190-unit one had to
  // delete them — which is why the wide version had to be routed around the core
  // and left the middle open. Narrow roads are also the ask ("smaller and more
  // intricate"): at this width a road is a squeeze you fly, with its walls
  // visible either side for most of its length.
  FIELD_LANE_W: [55, 105],
  // Share of gravel that ignores the lanes entirely. THE EDGE, not a rounding
  // error: with none of it the channels have a crisp kerb and read as authored,
  // which is precisely the failure that got corridors cut the first time. Small
  // rock in a lane is also a fair obstacle — you can see it and shoot it.
  FIELD_LANE_LEAK: 0.22,
  // Candidate routes drawn per lane before the quietest is kept. The lanes are
  // FOUND among the placed rock, not carved through it (world.findLanes), and
  // this is the search budget for that. 40 is enough to find a genuinely quiet
  // line through a pocket; it is pure arithmetic over ~300 slots, so it costs
  // far less than one extra packing pass.
  // Passable width a lane must retain, world units. A landmark is removed from a
  // route only if it would leave less than this — a rock at the lane's edge is
  // the WALL, not an obstruction, and treating contact as blockage clears a
  // swathe either side of every route (measured: it cost two thirds of the
  // pocket's largest rocks). At 150 a lane always admits the ship with room to
  // correct, while still narrowing to something you have to fly rather than
  // drift through.
  // Passable width a road must retain. Scaled down with FIELD_LANE_W — a
  // network of 70-unit channels cannot demand 150 units of clear passage, it
  // would delete its own walls.
  FIELD_LANE_MIN: 85,
  FIELD_LANE_TRIES: 40,
  // (There is deliberately no lane-separation constant. There WAS —
  // FIELD_LANE_APART, from when a pocket held three independent rim-to-rim
  // curves and two of them stacking wasted the pocket. `findLanes` never read
  // it, and the network form made it the wrong idea rather than an unfinished
  // one: see the note on the edge loop in world.js.)
  // PER-ROCK SIZE VARIATION on top of the class multiplier — every big rock
  // draws its own factor in this band. Without it the giants all came out
  // within a whisker of the same size (their masses span 14k-60k, but radius
  // goes with cbrt, so that whole range is only a 1.6x spread) and a pocket of
  // near-identical boulders reads as tiled rather than tumbled. The packer
  // resolves each rock's final radius BEFORE placing it, so the small ones
  // genuinely slot into gaps the big ones cannot.
  FIELD_SIZE_VARY: [0.8, 1.3],
  // Packing attempts per huge rock. A pocket this full rejects a lot of draws,
  // and giving up early leaves a thin field rather than a maze — but the
  // budget has to be bounded, because freshRun/mechTest regenerate the world
  // constantly. world.seedDenseFields reports what it actually placed.
  // Good enough to stop searching: a candidate sitting within this of its
  // nearest neighbour is snug, so the packer takes it rather than spending the
  // rest of its try budget looking for better. Without an early-out the greedy
  // search costs every try on every rock, and worldgen runs constantly
  // (freshRun / mechTest).
  // Share of packing tries drawn on a ring just off an already-placed BIGGER
  // rock, instead of from the pocket sampler. The landmark equivalent of
  // FIELD_RUBBLE_LOOSE's inverse — see the note in world.packBigRock for why the
  // radial biases alone could never fix "the really large ones are all alone":
  // the bias chooses where candidates fall, the greedy-snug score chooses which
  // one wins, and the score always prefers wherever rock already is.
  // Kept well under 1: at 1.0 every rock rings another one and the pocket reads
  // as clusters of satellites rather than as terrain.
  FIELD_PACK_BANK: 0.45,
  // How far into the (size-ordered) slot list a bank draw may pick. This is what
  // aims the bank at the rocks that actually need company: the pocket has only a
  // handful of rocks over 250 units, so a uniform pick effectively never lands
  // on one. Kept a good deal larger than the count of truly huge rocks so the
  // mid ladder gets banked against too and the result is graded rather than a
  // ring of satellites around six monoliths.
  FIELD_PACK_BANK_TOP: 40,
  FIELD_PACK_SNUG: 12,
  FIELD_PACK_TRIES: 170,
  // RUBBLE. The small rock is not scattered across the pocket any more — it is
  // drawn as a SKIRT around the huge rocks, so gravel banks up against the
  // masonry and the passages stay flyable. A uniform scatter silts every gap
  // up and the maze stops existing at exactly the scale the ship cares about.
  // Fraction of small rock that is loose scatter instead of skirt: enough to
  // keep the pocket from reading as rings around boulders, few enough that a
  // passage stays a passage.
  // RAISED 0.22 -> 0.65 when the masonry was pulled into the core (FIELD_REACH).
  // Skirt gravel banks against big rocks, so it inherits wherever they are — and
  // once they stopped reaching the rim, so did the gravel, and the pocket ENDED
  // ON AN EDGE. That is the no-hard-edges law, and it is also the approach the
  // player is supposed to be lulled by: the thin outer haze is what makes a
  // shoal something you drift into before you notice it.
  FIELD_RUBBLE_LOOSE: 0.65,
  FIELD_RUBBLE_BAND: [7, 179],   // how far off a host's surface its skirt sits
  // ---- WHERE THE MASS SITS IN A POCKET (user design call: the really large
  // clumped-together rocks belong near the HEART, and it should thin out and
  // shrink toward the edge). Before this, every knob here was flat: the scatter
  // was area-uniform, the landmark packer drew from the same flat sampler, and
  // the gravel ladder did not know where it was. A pocket therefore had the
  // same rock everywhere, and its middle was no more of a place than its rim.
  //
  // These are EXPONENTS on the pocket sampler's normalised radius, `q = u^p`.
  // p = 0.5 is exactly area-uniform (the old behaviour); larger p pulls inward,
  // with density going as q^(1/p - 2). Counts do NOT change (FIELD_ROCKS,
  // FIELD_GIANTS and FIELD_MONOLITHS are what they were): this is a
  // redistribution of the same rock, which is the only way to restate the shape
  // of a pocket without also re-tuning how much is in it. Measured on The
  // Grindstones, seed 20260721: rocks per unit area 2.58 / 1.47 / 1.09 / 0.75 /
  // 0.81 across the five bands from heart to rim, against 0.77 / 1.10 / 0.97 /
  // 0.88 / 1.10 before — flat, and if anything edge-heavy.
  // Both ends were pushed out when the landmark ladder became a graded
  // continuum (FIELD_GIANT_MASS). They had been doing almost nothing: the range
  // was narrow AND the rank that indexed it put every giant at one end of it, so
  // 200 rocks all drew at ~0.55-0.63 and the "gradient" was a rounding error.
  // With the rank fixed, the range has to be wide enough to be worth indexing —
  // mean normalised radius runs 0.29 at the core end against 0.77 at the rim,
  // i.e. the biggest rock genuinely sits in the middle third and the smallest
  // genuinely prefers the outside. The rim end carries most of the weight, and
  // that is the point: FIELD_REACH already stops big rock reaching the rim by
  // fiat, so what is left for these exponents to arrange is where the MANY small
  // landmarks go. Left near uniform they fill the core's gaps and dilute the
  // very contrast the grading exists for. FIELD_PACK_BIAS_FRAC is the safety valve
  // that keeps a strong core bias from silently dropping rocks into a full core.
  FIELD_CORE_POW: 2.4,      // the biggest landmark: hard into the heart
  // Back toward uniform from 0.30. Pushing the small landmarks hard at the rim
  // starved the CORE of anything to pack around the giants: the masonry goes
  // down first and the greedy-snug rule then crowds each later rock against
  // whatever is nearest, so rim-drawn candidates crowd against EACH OTHER out
  // there and the biggest rocks are left sitting in their own clearings.
  // Measured: mean gap from a 250+ rock to its nearest landmark ran ~3x that of
  // every other size class, which is "the really large ones are all alone".
  // FIELD_REACH already bars big rock from the rim, so this exponent no longer
  // has to do that job and can go back to filling the pocket evenly.
  // THE SMALLEST ROCK AIMS INWARD, and 0.55 was wrong for a reason the comment
  // it replaces had backwards. 0.55 is very nearly area-uniform (q = u^0.5 is
  // exactly uniform per unit area), which SOUNDS like "free to fill the core" —
  // but the packer runs HEAVIEST FIRST, so by the time small rock is drawn the
  // core is already saturated and every core candidate is rejected. An
  // area-uniform sampler aimed into a full core does not spread the small rock
  // out; it leaves it wherever there is still room, which is the rim. Reported,
  // correctly and more than once, as the small rocks only being on the outside.
  // 0.85 — mildly inward of area-uniform, and the pair with FIELD_PACK_FRONT is
  // the point. Unsaturating the core is what makes room; this only has to cover
  // the bias the placement ORDER still leaves behind. 1.25 was tried and empties
  // the rim outright (outer-third coverage fell to 0.007, i.e. nothing to fly in
  // through), which trades the reported bug for its mirror image — the approach
  // has to read as a rock field or there is nothing to stumble out of.
  // Back to 0.55 — area-uniform. 0.85 was set to drag small landmarks inward
  // when the core was starved of small rock, but PLAIN asteroids are the right
  // answer to that (FIELD_RUBBLE_POW now aims them at the middle), and leaving
  // this above area-uniform just re-crowds the core with the exact class asked
  // to shrink there.
  FIELD_EDGE_POW: 0.55,
  // Loose gravel (skirt gravel follows its host instead). Pulled OUT from 0.85
  // to past area-uniform with FIELD_RUBBLE_LOOSE above and for the same reason:
  // this is now the only draw that puts anything past the masonry's edge.
  // 0.28 -> 1.5, and the old value did the OPPOSITE of what its comment claimed.
  // fieldPoint takes q = pow(rng(), POW) * lobe, so a POW BELOW 1 clusters q
  // high — i.e. pushes rock OUT to the rim. At 0.28 the loose rubble draw was
  // shoving plain asteroids to the edge as hard as it could while the note above
  // it said the knob "pulls inward". Measured: 457 plain asteroids in the outer
  // third against 21 in the inner. Above 1 it genuinely aims at the middle,
  // which is where plain rock has to be — the size range WIDENS toward the core
  // (docs/rock-fracture.md), so the core needs the bottom of the ladder in it,
  // not just the top.
  FIELD_RUBBLE_POW: 1.5,
  // Share of the packer's try budget that keeps the centre bias. The rest go
  // back to a uniform draw so a rock that cannot fit in a full core is placed
  // further out instead of being silently dropped — and what gets dropped in a
  // pocket packed from the middle is precisely the biggest rocks.
  FIELD_PACK_BIAS_FRAC: 0.45,
  // THE AREA RELIEF VALVE under FIELD_REACH below — no longer the primary limit.
  // It is the packing fraction the masonry is assumed to reach behind its own
  // growing edge, which is what turns "the area of everything bigger than me"
  // into "how far out I may go" (world.seedDenseFields takes whichever of the
  // two allowances is more generous).
  // Its job now is narrow and worth keeping: if the big rocks genuinely do not
  // fit inside their size allowance, this grows and lets them spill outward
  // rather than being silently dropped — and what gets dropped in a pocket
  // packed from the middle is precisely the biggest rocks. Set it too LOW and
  // the valve opens early and defeats FIELD_REACH; too HIGH and it never
  // relieves and the biggest rocks go missing instead.
  // 0.72 -> 0.60. The area valve is what decides how full the core is allowed to
  // get, and a saturated core is both halves of the current complaint: there is
  // no room left for small rock to sit among the big ones, and what does get in
  // is packed tight enough to seed contacts that overlap and judder. Leaving a
  // fifth more of the core unclaimed is what makes FIELD_EDGE_POW's inward aim
  // able to land anywhere.
  FIELD_PACK_FRONT: 0.60,
  // HOW FAR OUT A LANDMARK MAY SIT, BY ITS OWN SIZE — [smallest, biggest], in
  // fieldFrac units. THE knob for "the giant ones should only be near the
  // middle" (user design law), and the primary limit; FIELD_PACK_FRONT above is
  // only the relief valve under it (world.seedDenseFields takes whichever is
  // more generous).
  //
  // A shoal is meant to be a place you come into thinking everything is fine and
  // then STUMBLE INTO. That shape is: an outer approach carrying nothing but
  // gravel and small rock, and a core you meet all at once. The smallest
  // landmark may therefore go anywhere at all (past the outline, into the ragged
  // fringe), and the biggest is held inside the inner 0.45 — a fifth of the
  // AREA, so the wall is genuinely sudden.
  //
  // THE CORE END HAS A FLOOR IT MUST NOT GO UNDER, and it is set by the HEART,
  // not by taste. The heart's own reach disc plus FIELD_HEART_CLEAR already
  // covers out to q ~0.29, so an allowance below that leaves the big rocks
  // literally nowhere to stand: the area valve opens and dumps them into the
  // middle third instead. Measured at 0.28 — 6.8 rocks over 150 units in the
  // middle third against 1.3 in the core, i.e. the opposite of the intent.
  // If FIELD_MONOLITH_R_MUL or FIELD_HEART_CLEAR move, this floor moves.
  // Do not read the two ends as a gentle ramp between them: the class is skewed
  // hard toward its small end (FIELD_GIANT_SKEW), so most rocks sit near the
  // rim value and the tight end governs only the few that are actually huge.
  FIELD_REACH: [1.15, 0.45],
  // ...and HOW FAST the allowance falls with radius. See world.seedDenseFields:
  // allowance = REACH[0] * (smallestLandmark / r) ^ this, floored at REACH[1].
  // A linear ramp between the two ends was tried first and is far too generous
  // through the middle of the ladder — a 332-unit rock, 80% of the biggest thing
  // in the pocket, came out allowed to q 0.63, which put genuinely huge rock in
  // the outer third and left it reading as "big asteroids the whole way".
  // At 0.72 the curve is: ~30 units reaches 0.96, ~40 reaches 0.78, ~60 reaches
  // 0.58, and anything from ~90 up is on the REACH[1] floor. So the exact size
  // ordering only matters across the small end — above ~90 units every rock is
  // simply "core", which is the design in one sentence.
  // Decay rate of the exponential in world.setQMax: allowance goes
  //   REACH[1] + (REACH[0] - REACH[1]) * exp(-EXP * (r/rMin - 1))
  // so a rock at the smallest landmark size keeps the whole pocket and the
  // allowance falls away as it grows. At 0.55 a rock twice the minimum still
  // reaches ~0.85 of the pocket and one six times it is inside ~0.5 — the small
  // and mid end keep the run of the place, and only the genuinely large get
  // squeezed toward the middle.
  FIELD_REACH_EXP: 0.55,
  // Superseded by FIELD_REACH_EXP — the old power-law exponent. Kept only
  // because the measurements quoted in the FIELD_REACH note above were taken
  // against it; nothing reads it now.
  FIELD_REACH_FALL: 0.72,
  // How far past its own allowance a rock may spill once its biased tries are
  // spent, as a FRACTION of that allowance (see packBigRock — additive slack
  // conceded far more to a rock capped at 0.30 than to one allowed 1.15, i.e.
  // it leaked hardest exactly where the cap matters most). The last-resort valve, under FIELD_PACK_FRONT —
  // it replaces the old "open the whole pocket on the last tries", which
  // relieved the same pressure by putting the BIGGEST rocks anywhere at all,
  // undoing the grading precisely where it was tightest.
  // Cut 0.22 -> 0.10 because at 0.22 it WAS the leak: a 384-unit rock allowed
  // only to q 0.47 was landing at q 0.65 on slack alone.
  FIELD_FRONT_SLACK: 0.10,
  // Clearance the HEART holds against the masonry, on top of both radii. The
  // ordinary per-pair gap bottoms out at 4 units, which once the big rocks are
  // drawn inward welds a ring of monoliths onto the one rock the field is named
  // for — and it is the chart entry, the AI anchor and the thing you fly in to
  // reach. Measured before this: a staged shot at a heart lost ~60% of its
  // damage to whatever was parked in front of it.
  //
  // THE PRESSURE ON THIS RING TRACKS THE POCKET'S DENSITY, so re-sweep it
  // whenever that moves. History worth keeping, because it went both ways: at
  // ~0.7 core coverage the old failure came straight back (a staged shot at the
  // heart lost 64% of its damage to rock parked in front of it, 294 -> 105) and
  // it took 560 here to clear it. Once the density came down and the masonry was
  // spaced by its true reach, the ring stopped mattering at all — swept at
  // 170 / 260 / 340 the combat rung did not move by a single point. It now sits
  // BELOW its old value on purpose: it is subtracted from the room the giants
  // have to ring the heart with (see FIELD_REACH's floor), so every unit here is
  // taken straight out of the core the design wants packed.
  // If a future change re-densifies the core, expect this to start binding again
  // and sweep it rather than assuming it.
  FIELD_HEART_CLEAR: 180,
  // ...and the SIZE gradient. A rock's mass ladder is drawn against how far out
  // it lands: the chunky tier's share falls from core to rim, and the whole
  // ladder is scaled on top of that. The endpoints are chosen so the pocket's
  // MEAN gravel mass lands within a couple of percent of what it was — a size
  // gradient that also changes how much is IN a shoal is two changes wearing
  // one coat, and the second one is a balance change nobody asked for.
  //
  // THE ENDPOINTS ARE SOLVED, NOT PICKED. A taper whose two ends look balanced
  // is not mass-neutral, because the rock is not spread evenly across it:
  // gravel sits at a mean normalised distance of 0.74 and 37% of it is at or
  // past the rim, so a first cut at [1.24, 0.60] quietly took 30% of the
  // pocket's gravel mass out (mean 2538 -> 1772) and surfaced as a third of the
  // `giants` census, which counts field rock over 3000 mass. Solved against the
  // measured distribution instead, these land the mean at ~2512 against 2538.
  // Re-solve them if FIELD_RUBBLE_POW, FIELD_EDGE_KEEP or the pocket's extents
  // move — all three change where the rock sits, and therefore what the taper
  // averages to.
  //
  // How much of the heart's density survives at the outline. Applied as a
  // rejection on where a rock LANDED, which is the only place that catches
  // skirt gravel (four rocks in five bank against a host and inherit its
  // position, so biasing the samplers alone leaves the density flat). The count
  // is unchanged — a rejected draw is retried, so the same rocks end up further
  // in rather than fewer of them.
  // Raised 0.30 -> 0.80 with FIELD_RUBBLE_LOOSE / FIELD_RUBBLE_POW: the rim
  // thinning was tuned when the masonry reached the outline and the gravel had
  // its density from banking against it. With the big rock pulled inward, the
  // old value thinned an outer region that had nothing else left in it.
  FIELD_EDGE_KEEP: 0.80,
  FIELD_CHUNK_CORE: 0.62, FIELD_CHUNK_EDGE: 0.24,
  FIELD_GRAVEL_TAPER: [1.80, 0.87],   // mass scale at the heart / at the rim
  // Field-rock hp ceiling. Without it FIELD_HP_MUL made a monolith ~34,000 hp
  // — unbreakable, which contradicts the design ("bigger rocks break into
  // smaller pieces and keep the chaos going"). At 5200 a thrown moon-class
  // mass (4.7-12k damage) can crack even a monolith; pebbles still bounce off.
  FIELD_HP_CAP: 5200,
  // FIELD ROCK is its own material, not belt rock: no gravity AT ALL — it
  // neither feels it nor exerts it, GIANTS INCLUDED (a shoal is about
  // knocking things into each other, and a heavy attractor parked in the
  // middle of that would quietly turn the pocket into its own solar system)
  // — plus a much livelier bounce and a thick hide against its own kind.
  // That combination is what makes a shoal a PINBALL TABLE you can knock
  // around all day instead of a cloud that grinds itself to dust the first
  // time something big ploughs through. Gravity-free is also the only reason
  // 2000+ of them are affordable.
  // FLAT restitution for field-rock pairs, just under perfectly elastic
  // (>= 1 ADDS energy per hit and the pocket boils itself apart). This is a
  // fixed value, not a multiplier on RESTITUTION: the whole point of the
  // material is that hits SEND ROCKS FLYING, and inheriting the world's
  // deliberately deadened bounce defeated it.
  FIELD_BOUNCE: 0.92,
  // ---- THE POCKET SETTLES (user design call: "even though we're in space, the
  // rocks should have friction on them so they eventually slow back down and we
  // don't end up with everything just breaking").
  //
  // Field rock feels no gravity, so before this NOTHING removed energy from a
  // knocked rock except FIELD_BOUNCE, and 0.92 restitution across a pocket of
  // 800 touching rocks decays about as fast as it spreads. A cascade therefore
  // had no end state: rock stirred up in minute one was still crossing the
  // pocket at damage speed in minute ten, so the shoal ground itself down
  // instead of returning to being a place.
  //
  // The damping is toward THE POCKET'S OWN FLOW, never toward zero. A shoal
  // orbits — a rock damped toward rest in the sun frame would fall out of the
  // pocket and the whole field would smear along its lane within minutes. Flow
  // velocity is the rigid pocket's rail velocity at the rock's position (one
  // shared f.w — see world.seedDenseFields), so "stopped" means "riding with
  // its neighbours again", which is the state it was seeded in.
  // Applied as exp(-k*dt) on the RELATIVE velocity, so it is frame-rate
  // independent and never overshoots into a reversal.
  // GENTLE. This governs how long a knocked rock keeps moving, and at 0.34 it
  // stopped almost immediately — combined with the home spring the pocket read
  // as glued rather than as heavy. The ask is that a rock moves somewhat and
  // then works its way back VERY SLOWLY, which is a long, weak return, not a
  // fast one.
  FIELD_DRAG: 0.12,
  // ...but a LIVE PLAYER THROW barely feels it. A throw that visibly bled speed
  // on its way to the target would make the aim marker lie (tractor.js solves
  // the lead against a straight line) and quietly nerf every heavy throw. Scoped
  // to thrownTimer, so it covers exactly the window the throw is credited for.
  FIELD_DRAG_THROWN: 0.04,
  // Once a rock is this slow relative to the flow it REJOINS THE RAIL. Drag
  // alone leaves an asymptotic tail of thousands of nearly-stopped free bodies —
  // all awake, all integrating, none of them doing anything — and the rigid
  // pocket is defined by every rock sharing one exact angular rate, which an
  // asymptote never quite reaches. Re-railing is the actual end state, and it
  // is the same idiom the installations use when they fly home.
  // Gated on still being in or near its own pocket (FIELD_SETTLE_FRAC, in
  // fieldFrac units): a rock knocked clear across the system keeps drifting,
  // because re-railing that one would snap it onto a circular orbit at whatever
  // radius it happened to reach and call it shoal.
  // A settling rock must be CONTACT-FREE for this long before it may go back on
  // rails. Railing while still touching something freezes the overlap — the
  // railed-pair pass-through in physics.collide treats two railed rocks of one
  // pocket as a rigid body, so neither can ever separate again, and the rock's
  // only escape is to be derailed, drift home and rail into the same occupied
  // spot once more. That churn is what made a pocket accumulate overlap for as
  // long as you played in it (seeded at 3 overlapping pairs; 139 after 120s,
  // every one of them both-railed).
  //
  // 0.3s, not a frame or two: the point is that the neighbour has had time to be
  // pushed clear and STAY clear, not merely that this instant happens to be
  // quiet. Cheap either way — a rock that fails the test simply stays dynamic,
  // which is the state it was already in.
  // HOW HARD THE SHIP CAN SHOVE A LANDMARK. The generic ship-vs-body kick uses
  // shipM / (shipM + mass), which against a 8,000-460,000 mass landmark is ~0.004
  // — the rock did not move, derail or spin at any speed. This scales the mass
  // in that knee instead of bypassing it, so the response still grades with what
  // you hit: a rim rock is properly shoved, a core monolith gives a couple of
  // units and stays. Lower = the shoal shrugs the ship off harder.
  FIELD_SHIP_MASS_K: 0.02,
  // ABSOLUTE ceiling on what one ram can impart to a landmark, at any tier.
  // Without it the softened knee above inverts late-game (shipM reaches ~1030
  // against an effective rock mass of 600) and a single ram launches a monolith
  // hard enough to break its neighbours, which break theirs — one hit takes the
  // whole pocket. 55 is comfortably a shove you can see and comfortably under
  // the speed at which field rock damages field rock, so the shoal answers the
  // ship without ever being weaponised by it.
  FIELD_SHIP_KICK_MAX: 55,
  // How fast a fracture piece leaves its parent's centre. Low on purpose: the
  // pieces were CUT from that outline and the break reads best when they open
  // along the seams and drift, so you can still see the rock they came out of.
  // Fast ejecta reads as a firework and throws away the one thing the baked
  // fracture tree buys — that the pieces match.
  // Camera-shake ceiling. physics.addShake approaches this asymptotically rather
  // than clamping to it — see the note there.
  SHAKE_MAX: 26,
  // Floor: an event smaller than this earns no camera shake at all. Ambient
  // chipping calls addShake continuously with tiny amounts, which summed to a
  // permanent tremble — most visible at high tier, where the wider view turns
  // the same world-space wobble into more screen movement.
  SHAKE_MIN: 1.6,
  // Distance at which a positioned shake event contributes nothing. Events that
  // pass no position (hull hits, your own ram) are unaffected and always land at
  // full strength — this only stops the far side of a pocket from shaking you.
  SHAKE_RANGE: 2600,
  // Minimum gap between two POSITIONED shake events. Without it a long cascade
  // tops the camera up faster than the exp(-7t) decay can drop it and the shake
  // runs for the whole event. Ship-local hits ignore this.
  SHAKE_CD: 0.9,
  // Odds a hard hit on a shaped landmark still sheds a crust slab. 0.05 — the
  // fracture tree is how a landmark expresses damage now, and the old per-hit
  // spray was burying a pocket in gravel on top of it. See physics.js.
  FIELD_CALVE_CHANCE: 0.05,
  FIELD_BREAK_SPREAD: 26,
  // Fraction of the parent's velocity a fracture piece inherits at LOW parent
  // speed, and (FIELD_BREAK_SOFT) the speed above which that fraction starts
  // falling further still. A rock nudged apart keeps most of its drift — it
  // should stay with the pocket it belongs to; a rock hit hard enough to
  // shatter has SPENT that energy on shattering, so its pieces come out far
  // slower than the thing that broke. Without this one tier-5 throw cascaded
  // through a whole pocket: a 458,000-mass monolith flung at throw speed became
  // four pieces each still doing throw speed.
  FIELD_BREAK_KEEP: 0.55,
  FIELD_BREAK_SOFT: 220,
  // Ceiling on the spin a single impact can impart. Landmarks are seeded slow on
  // purpose (a 300-unit slab whipping round reads as debris, not as terrain), so
  // a hit must be able to set one turning without letting a fast graze put it
  // into a spin the drag then takes a minute to bleed off.
  FIELD_SPIN_MAX: 0.30,
  FIELD_RAIL_CLEAR: 0.3,
  FIELD_SETTLE_V: 3,
  FIELD_SETTLE_FRAC: 1.35,
  // ...AND IT GOES BACK WHERE IT BELONGS, not merely still (user design law:
  // "the rocks should slowly revert back to their rail after getting moved
  // around — we want to keep the swimlanes mostly intact"). Each rock carries
  // the pocket-frame position it was seeded at (world.setFieldHome) and is
  // pulled toward it; against FIELD_DRAG that is a damped spring in the pocket's
  // rotating frame, so it converges instead of ringing.
  // THE POINT IS THE LANES. Settling wherever a rock happened to stop silts a
  // route up over a run, and the routes are the one part of the layout that has
  // to survive being fought in — they are also the first thing a cascade fills.
  // A (accel cap) is what keeps this from reading as the rock being dragged
  // home: at 9 u/s^2 a rock 600 units out takes the better part of half a minute
  // to work its way back, which is "slowly". K is the spring rate that governs
  // the last stretch, so a rock a few units off does not creep for ever.
  // Never applied to a live player throw — it would curve the shot.
  FIELD_HOME_A: 2.2,
  FIELD_HOME_K: 0.012,
  // How close to home counts as home for the re-rail. This is a TOLERANCE, not a
  // target: the rock re-rails where it is, it is not teleported onto its home
  // (that dropped rocks on top of whatever had drifted into the spot, and two
  // railed rocks of one pocket never separate). Tightened from 130 with the
  // teleport removed, so the spring does the work and the layout that comes back
  // is closer to the one that was seeded — the lanes above all.
  // TIGHT, and that is a correctness matter rather than a tidiness one: a rock
  // re-rails where it stands, so a loose tolerance re-rails it into whatever has
  // drifted into the spot, and a railed pair can never separate. Home itself is
  // a position the packer proved clear; the closer this is to zero, the closer
  // re-railing is to landing somewhere known good.
  FIELD_HOME_SNAP: 20,
  // ---- BIG-ROCK CONTACT. Tangential friction at the contact, and the spin it
  // implies — scoped to bigShape pairs (Coulomb friction on every pebble in the
  // sky is a different, much larger change, and the complaint was about the
  // landmarks). Without these a landmark collision has NO tangential term at
  // all: two angular slabs meeting corner-to-face exchanged a pure normal
  // impulse and slid across each other without either one turning, which is the
  // single most visible way "the big rocks don't collide correctly".
  // Friction is a fraction of the normal impulse, Coulomb-clamped to the
  // tangential velocity so it can never reverse the slide.
  FIELD_BIG_FRICTION: 0.35,
  // How much of the implied angular impulse actually lands. A rubble pile is not
  // a rigid body and these rocks have no real inertia tensor — the moment of
  // inertia used is the uniform disc's (0.5*m*r^2). Damped so a graze adds a
  // believable tumble instead of setting a 300-unit monolith spinning like a
  // top; the cap in physics.applyBigSpin is the hard backstop.
  FIELD_BIG_SPIN: 0.45,
  FIELD_TOUGH: 0.08,       // x damage on field-vs-field impacts (unless a player throw is involved)
  // FIELD_SHIP_DMG — REMOVED ENTIRELY (user call, 2026-08: "remove this
  // multiplier altogether"). It multiplied ship-taken damage from field rock
  // (shipped 1.0, raised to 2.5 for high-risk/high-reward — measured over 20s:
  // parked 4%->7% hull, flythrough 6%->11%, farming 3%->10% — then 1.3, then
  // gone): under the tempered damage curve it was the last flat amplifier in
  // the sky, and a stirred pocket fed rock after rock into the 45% per-hit
  // cap. Shoal rock now prices like any rock of its mass and speed. The
  // field's remaining teeth are DELIBERATE and live elsewhere: the un-tiered
  // massSat knee in collideShipBody (a big ship never becomes immune to a
  // shoal) and sheer rock count. Do not reintroduce a flat field multiplier
  // to make shoals scary; tune the knee or the lurkers instead.
  // FRIENDLY FIRE on the brawler blast (physics.brawlerThrowKill): the share of
  // its body damage the SHIP takes for standing inside the DAMAGE radius, with
  // the same linear falloff. At Demolition 3 / tier 3 that is ~63 at point
  // blank — a fifth of the hull, and hull does not self-heal — so detonating on
  // top of yourself is a real mistake rather than a free screen-clear. Keyed to
  // the damage radius only: the long push may still shove rock past you
  // harmlessly, because the lesson is "not that close", not "never use it".
  BLAST_SELF_DMG: 0.6,
  // BILLIARDS CHAIN DEPTH, field rock only. THE fix for the shoal exploit: the
  // gravity-billiards rule stamps thrownBy='player' onto any rock your throw
  // knocks hard, so the NEXT rock it smashes still counts as yours. In the belt
  // that's a trick shot. In a pocket of 1900 TOUCHING rocks it was a chain
  // reaction that never died — every fresh contact refreshed the 1.4s timer, so
  // the mark spread outward forever, and because the FIELD_TOUGH damp exempts
  // "a player throw", the ENTIRE shoal took full lethal damage and paid full
  // credit. Measured: one fling = 245 XP in 30s and still climbing (80% of a
  // whole tier), most of it chip-scrap from thousands of laundered impacts.
  // Capped, the trick shot survives and the cascade doesn't: link 1 is the rock
  // you hit, link 2 is the rock it knocks, and there is no link 3 — deeper
  // rocks carom at FIELD_TOUGH and pay nothing, exactly as the material intends.
  // Belt rock is UNCAPPED (it's sparse; it cannot cascade), so planet billiards
  // stay glorious.
  FIELD_CHAIN_MAX: 2,
  FIELD_HP_MUL: 6,         // field rock is MUCH tougher stuff than belt rock
  // ...but NOT the landmarks. FIELD_HP_MUL is tuned for the gravel — "tough
  // against its own kind", so a pocket doesn't grind itself to dust — and
  // stacking it on a giant made one that shrugged off everything: measured, a
  // 600-mass rock thrown at 700 took 15 hp off a 2,582-hp giant, i.e. 172 solid
  // hits to break the thing the player is meant to be breaking. The gravel keeps
  // its 6x; the masonry is meant to come apart.
  FIELD_BIG_HP_MUL: 2.2,
  // MASS DOMINANCE SOFTENING for a landmark rock, exactly the gas-giant idiom
  // (GAS_DOM_EXP) and for the same reason. Damage carries `b.mass * domA` where
  // domA = b.mass/(a.mass+b.mass), which is effectively QUADRATIC in the light
  // body's mass — a rock a fiftieth of a giant's mass lands a fiftieth of the
  // damage at a fiftieth of the weight. Dominance models a compact rigid body
  // shrugging off a pebble; a 400-unit shoal giant is a rubble pile, and it is
  // drawn huge precisely BECAUSE its mass was left alone (the radius-not-mass
  // rule), so the player's expectation is set by a size the formula never sees.
  // Raising the factor to a power < 1 pulls it back toward parity: at 0.45 a
  // 600-mass rock does ~9.5x what it did, and a giant is ~9 hits rather than 172.
  // AMBIENT contact is untouched — FIELD_TOUGH (0.08) still damps every
  // field-vs-field impact that isn't a player throw, so a pocket does not start
  // dismantling its own landmarks.
  FIELD_BIG_DOM_EXP: 0.45,
  // ...and a CEILING on what one impact may take, as a fraction of maxHp — the
  // same idiom as LURKER_HIT_CAP and GAS_HIT_CAP, reached for the same reason.
  // Impact damage is quadratic in closing speed and linear in mass across three
  // orders of magnitude, so no hp value is tunable across the whole throw
  // ladder: softening dominance enough that a 600-mass rock chips a giant in 7
  // hits also let a thrown MOON one-shot the shoal's named heart (measured, 6
  // hits -> 1). Bounding one blow decouples the two — the number of hits stops
  // depending on how hard the player happens to be able to throw, so a pebble
  // still chips and a moon still hits like a moon without ending a landmark in
  // one blow. 0.34 => at least three solid hits, whatever you throw.
  FIELD_BIG_HIT_CAP: 0.34,
  FIELD_BROOD: 7,          // lurkers per field per run — finite; a cleared field is QUIET
  FIELD_HUNTERS: 3,        // how many of that brood may hunt at once (ai.updateFields)
  // NOT frail any more. At 34 hp a lurker was a jump-scare that died to the
  // first thing you threw, so an ambush resolved before it could develop and
  // the shoals' one predator never actually threatened anyone. At 90 it eats
  // several solid hits and you have to keep flying while you deal with it —
  // which is the whole point, because the danger is the ROCKS it is aiming at
  // you, and that only lands if it lives long enough to line one up.
  LURKER_HP: 90,
  // Ceiling on what ONE rock hit can take off a lurker, as a fraction of its
  // max hp — so it always costs at least ceil(1 / this) solid hits. This, not
  // LURKER_HP, is what actually makes it hard to kill: see the note at the cap
  // in physics.collideAlienBody for why hp alone cannot work here.
  LURKER_HIT_CAP: 0.34,    // => 3 hits minimum
  // 10 -> 13, WITH render.js scaling its draw by LURKER_DRAW to hold the on-screen
  // size exactly where it was. The sprite is a splinter spanning r*1.7 at the
  // nose to -r*1.3 at the tail — a mean extent about 1.26x the radius — while it
  // collided as a plain circle of r, so the nose spike and the tail sat visibly
  // OUTSIDE the hitbox and shots through them missed. The collider now matches
  // the silhouette instead of the silhouette overhanging the collider.
  LURKER_RADIUS: 13,
  // Draw scale that keeps the visual size unchanged across that radius bump
  // (10/13). Render multiplies the sprite by this; nothing else reads it.
  LURKER_DRAW: 0.77,
  LURKER_DMG: 16,          // contact damage per slash pass (grabbers hit for 24)
  // x ALIEN_SPEED. Still the quickest thing in the sky up close, but no longer
  // by so much that it is simply everywhere at once: at 1.35 (446, charging at
  // 624) a lurker crossed the gap between two rocks faster than the player
  // could read which rock it was setting up, so the `line` swing-around — the
  // whole tell the attack is built on — went by too fast to be a window. At
  // 1.1 (363, charging at 508) it still outruns an early hull (maxSpeed 280)
  // and the tell has time to land, while a late-game ship can genuinely
  // outpace one, which is what the tier ladder is for.
  // This is an ABSOLUTE speed budget, not a flow-relative one (ai.steer sets a
  // desired world velocity), so it has to clear the pocket's orbital flow or a
  // lurker could never catch its own rocks. Measured, that floor is low — 103
  // at The Shoal down to 52 at The Farshoal — so there is plenty of room here;
  // it is only worth remembering before anyone cuts this much further.
  // Cutting the cap 18% moved the MEAN speed only 200 -> 180: a lurker spends
  // most of its time manoeuvring under ai.steer's arrive damping rather than
  // flat out. The 18% lands in full on the charge, which is the part you feel.
  // 1.1 -> 0.55, halved. The notes above are kept because their MEASUREMENTS are
  // still the reference points, but their conclusion no longer holds: at 1.1 a
  // lurker outran an early hull badly enough that the tell had no time to read
  // as a tell. The floor those notes name is the thing to watch — the pocket's
  // own orbital flow runs 103 at The Shoal down to 52 at The Farshoal, and this
  // is an ABSOLUTE budget rather than a flow-relative one, so halving again from
  // here would put a lurker below the rock it is supposed to be chasing.
  LURKER_SPEED: 0.55,
  // The lurker fights like a BRAWLER, not a grabber: it has no beam, it
  // BODY-CHECKS field rocks at you. Ambient rock contact can't hurt it (it
  // lives in the rocks — see the shove branch in physics.collideAlienBody);
  // a PLAYER-thrown rock still guts it, which is the counterplay.
  // Shove speed is a REAL THREAT SPEED, not a nudge: at 420 the rock crawled
  // across the pocket and you simply flew around it, and the guidance window
  // (below) was doing all the work of making the shot connect. It sits above
  // ALIEN_THROW (430) on purpose — a body-check is the lurker's whole attack,
  // where a grabber's throw is one of several.
  // 700 -> 1000: a shoal under attack is a place with rock genuinely flying AT
  // you rather than a place where rock exists. The SPEED of the shot is what
  // makes it a threat and it is unchanged — what came down is how OFTEN one
  // arrives (LURKER_SHOVE_CD, below).
  LURKER_SHOVE: 1000,      // speed imparted to a rock it charges through
  // Seconds before it can body-check again — the cadence knob, and the reason
  // it is this and not the states: `stalk` refuses to pick a new rock while
  // this is running, so it governs the whole loop no matter which branch the
  // lurker took to get back there.
  // 0.5 -> 2.2. At 0.5 the cooldown expired inside the `slip` that follows a
  // charge, so it was never the limiter at all — the brood re-armed the instant
  // it finished breaking off, and each shove is a 1000-speed threat the player
  // is supposed to answer individually rather than sit inside a stream of. The
  // gap now outlasts the slip, so a lurker visibly circles before it lines up
  // again.
  // MEASURING THIS NEEDS CARE, and the trap cost real time: only 2-4 lurkers
  // hunt at once and their AI rides Math.random, so a 60s probe sees
  // single-digit events and is pure Poisson noise — the same build measured 13
  // shoves, then 0, then 4, then 8. Fatten the brood for the event rate and
  // ALTERNATE the two configs inside one session. Done that way, over 14
  // lurker-minutes: 3.89 -> 2.42 shoves per lurker-minute (x0.62), the speed
  // cut above contributing as much as the cooldown by stretching the `line`
  // swing-around that precedes every shot.
  LURKER_SHOVE_CD: 2.2,
  // It only sets up a body-check when it is genuinely CLOSE — a rock punted
  // from across the pocket is a random event the player never reads as aimed,
  // and it wastes the charge. Inside this range the shot is a real threat.
  LURKER_SHOVE_R: 950,     // ship must be within this before it lines a rock up
  // Heaviest rock a body-check can actually LAUNCH — shared by the AI's pick
  // and the physics gate so they can't disagree. A charge that clips a giant
  // (or a monolith) on the way in now just separates instead of "throwing" it
  // at 40u/s and burning the cooldown on a shot that visibly did nothing.
  // Raised with the shove speed: ship damage scales with the ROCK'S MASS, so
  // letting a body-check pick up something heavier is most of what "throws
  // harder" means in the damage formula — not just a faster pebble.
  LURKER_SHOVE_MASS: 3400,
  // The shove is HELPED: the rock keeps steering toward its lead solution for
  // a moment after the hit, so a body-check reads as a deliberate aimed shot
  // instead of a hopeful nudge that the pocket's own drift walks off target.
  // Tuned against a stationary target: at 400/0.9s the shots grazed (median
  // closest approach ~25u — about a ship-width wide), because a pocket this
  // busy deflects a rock off its neighbours mid-flight. This converges those
  // grazes into hits while staying a short, bounded correction rather than a
  // homing missile.
  LURKER_GUIDE_T: 1.3,     // seconds of guidance after the body-check
  LURKER_GUIDE_A: 700,     // steering accel during that window

  // THE SOLAR WAVE — the sun's coronal weather, and the one event the whole
  // system feels at once. The sun CHARGES visibly (a telegraph you can act on),
  // then fires a shock front that sweeps outward trailing a deep SHEATH of
  // charged plasma.
  //
  // THE SHEATH IS THE WHOLE MECHANIC. The front alone is a 2 x band ring, which
  // crosses any given radius in ~1.5s — far too brief to be anything but
  // scenery, which is exactly what the storm used to be. The sheath trailing
  // behind it takes seconds to pass, so being caught out in one is a situation
  // you have to answer rather than a flicker you never noticed.
  //
  // IT STILL NEVER TOUCHES BODIES, CELESTIALS OR RAILS (the storm-shove law —
  // a force on any of those is an invariant-3 regression waiting to happen).
  // Everything it does lands on the SHIP, on loose SCRAP, and on SENSORS:
  //   - caught exposed: hull dps, engines derated, sensors scrambled
  //   - SHELTER is the counterplay — a world's lee blocks it (STORM_SHADOW_*)
  //   - the big ones blind ALIEN senses system-wide for the passage (the window)
  //   - it ionizes the scrap it sweeps (PROG.ION_SCRAP_MUL — the payday)
  //
  // THE SUN THROWS THREE DIFFERENT THINGS, not one thing on a timer. Every
  // number a wave runs on is a property of the WAVE, carried on game.storm, so
  // there is exactly one place a class is described and nothing downstream can
  // read a global that no longer matches the plasma actually on screen. See
  // STORM_CLASSES below; the per-wave constants that used to live here are
  // rows in that table now.
  // UNCHANGED BY THE INTENSITY LADDER, deliberately: adding classes must not
  // make the sky stormier. The sun fires no more often than it ever did — what
  // changed is WHAT it throws, not how often it throws.
  STORM_EVERY: 300,        // average seconds between waves — weather, not a metronome
  // THE INTENSITY LADDER, weakest first. Each row is a complete wave: its
  // telegraph, its geometry, its bite, its payday and its palette. The top row
  // (cme) holds the numbers the wave shipped with and is still the reference
  // every other row is priced against — the two below it are NOT a CME with the
  // damage turned down, they are shorter, faster, cooler events that cost a
  // fraction as much and give a fraction as much back.
  //
  // FULL-PASS EXPOSURE is the figure that matters, not dps: standing still, a
  // sheath washes over you for tail/speed seconds, so the real price of being
  // caught is dps x that. The ladder is deliberately ~3x per step —
  //   squall 3.5s x 2.5 =   ~9 hull   (a scratch; the class that TEACHES the
  //                                    mechanic at a price nobody fears)
  //   surge  6.1s x 4.5 =  ~27 hull   (a real bite — 13% of a tier-0 hull)
  //   cme    9.7s x 7   =  ~68 hull   (measured: BRAWLER 27%, HAULER/SCOUT 53%
  //                                    of their thinner hulls — the one that
  //                                    can end a run, kept exactly as it was)
  // — so the classes are told apart by CONSEQUENCE, not by reading a label.
  // Damage is directionless (no hitAng) like heat and gas crush at every class,
  // so a partial shield soaks only its coverage share; and because it is
  // continuous the regen delay never elapses mid-wave. All three stay FLAT
  // rather than hull-scaled, like every other environmental hazard here.
  //
  // HOW FAR IT CLIMBS is the second axis, and the one that gives the system a
  // GEOGRAPHY. A wave is not just weaker, it is more local: `reach` is the
  // fraction of CFG.WORLD_R its shock can climb to before it has spent itself,
  // and past `fade` (a fraction of that reach) it DISSOLVES rather than
  // travelling at full strength and then blinking out — `config.stormStrength`
  // returns the live 0..1 the wave carries as `k`, and every bite and every
  // alpha is multiplied by it. A wave that vanished at an exact radius would be
  // the geometric in-world edge the house style forbids; each class instead
  // spends its last ~10 seconds visibly shredding.
  //   squall  reach 0.5   — the inner system only. Full strength to ~18,500,
  //                         gone by ~29,900: it never touches the amber giant.
  //   surge   reach 0.667 — out through the mid system, gone by ~39,900.
  //   cme     reach 1.17  — the whole sky. Its `fade` puts the taper's start at
  //                         exactly WORLD_R, i.e. entirely OUTSIDE the world, so
  //                         the top class behaves precisely as it always did:
  //                         full strength everywhere anything lives, and the old
  //                         expiry (front out past WORLD_R + band + tail) falls
  //                         out of the same arithmetic.
  //
  // BLINDING IS THE CLASS DIVIDE, and it is why a big wave is worth WANTING. A
  // live wave floods the band and nothing alien can pick the ship out of it —
  // but a squall is a ripple, not a flood (`blind: false`), so the only class
  // that costs nothing is also the only one that hands you nothing.
  // THIS IS THE KNOB THAT MOVES THE STEALTH LAYER. A shorter-reaching wave is a
  // shorter-LIVED wave, so the ladder cuts the system's sense-blind duty cycle
  // to ~12% from the ~25% it ran at when every wave was a CME and every wave
  // crossed the whole sky. Handing `blind` to the squall would only take it to
  // ~15%. If the aliens start feeling too sharp, this is the first place to
  // look — every nest and lurker answers to it.
  //
  // `pay` is the payday in one knob: it scales BOTH the per-second ride XP
  // (PROG.XP_STORM_RIDE) and how far the scrap it sweeps is charged toward
  // PROG.ION_SCRAP_MUL. Risk and reward move together or the ladder is a lie.
  //
  // WHICH CLASS FIRES IS A FLAT RANDOM PICK — one of the three, equal odds, no
  // weights and no special cases (`config.stormClass`). Weighting them is the
  // obvious next idea and it was deliberately NOT taken: a third each is what
  // makes the telegraph worth reading every single time, because there is never
  // a class you can assume it probably is.
  //
  // COLOUR IS THE OTHER TELL, and it rides the game's EXISTING heat grammar
  // rather than inventing a second one: hot reads amber-to-white, cool reads
  // violet-to-blue, exactly as it does on a wounded giant's storm eyes and in
  // the corona. So intensity climbs that ramp — a squall is a pale cyan ripple
  // over a blue-violet haze, a surge burns rose, and only a CME earns the
  // white-hot core. The cme row's colours are the ones the wave shipped with,
  // unchanged, so the top of the ladder still looks like itself.
  //
  // `dens` is the OTHER half of looking weaker, and it matters more than the
  // palette: it thins the filaments, the motes and the sun's prominences, so a
  // squall is a SPARSER wave rather than a dimmed CME. Fading a full-density
  // wave just desaturates it, and a low-alpha additive over black is grey —
  // which is the exact failure the filament comment in render.js warns about.
  //
  // Six colours per class, each named for its job in drawStormWave:
  //   core   incandescent leading edge, and the brightest thing in the wave
  //   shock  the broad glow riding on that edge
  //   warm   the telegraph/instrument tone (screen pulse, radar, chart)
  //   sheath the body of the plasma behind the shock
  //   haze   the deep tail, where it dissolves into nothing
  //   filLo/filHi  the two ends of the streaming filaments' heat ramp
  // Plain [r,g,b] triples: they interpolate (render's mixc), and they still
  // stringify straight into an `rgba(${c}, a)` template.
  STORM_CLASSES: [
    { key: 'squall', name: 'SOLAR SQUALL', tag: 'SQUALL',
      charge: 3.5, speed: 1200, band: 380, tail: 4200, reach: 0.5, fade: 0.62,
      dps: 2.5, thrust: 0.85, ion: 2.0, shove: 60, blind: false, pay: 0.45,
      blurb: 'a thin front, and it will not reach the outer system.',
      dens: 0.45, core: [215, 245, 255], shock: [120, 195, 255], warm: [150, 205, 255],
      sheath: [95, 120, 235], haze: [70, 90, 210], filLo: [70, 130, 235], filHi: [170, 225, 255] },
    { key: 'surge', name: 'SOLAR SURGE', tag: 'SURGE',
      charge: 5, speed: 1050, band: 520, tail: 6400, reach: 0.667, fade: 0.68,
      dps: 4.5, thrust: 0.72, ion: 3.4, shove: 100, blind: true, pay: 0.72,
      blurb: 'deep enough to hurt — and nothing alien can see you while it passes.',
      dens: 0.72, core: [255, 228, 246], shock: [255, 140, 200], warm: [255, 150, 190],
      sheath: [225, 80, 190], haze: [135, 55, 215], filLo: [235, 70, 140], filHi: [255, 180, 215] },
    { key: 'cme', name: 'CORONAL MASS EJECTION', tag: 'CME',
      charge: 7, speed: 950, band: 700, tail: 9200, reach: 1.166, fade: 0.858,
      dps: 7, thrust: 0.6, ion: 5, shove: 150, blind: true, pay: 1,
      blurb: 'a deep sheath, it crosses the whole sky, and it bites — but nothing alien can see you while it passes.',
      dens: 1, core: [255, 250, 240], shock: [255, 185, 105], warm: [255, 170, 90],
      sheath: [215, 70, 160], haze: [120, 55, 210], filLo: [255, 105, 55], filHi: [255, 200, 125] },
  ],
  // SHELTER: the sun sits at the origin, so a world's shadow is just the
  // cylinder running anti-sunward from it. Forgiving on purpose — the lee has
  // to be somewhere a pilot can fly to under pressure, not a razor edge (and a
  // hard geometric boundary is against the house style anyway; render feathers
  // the wedge). Shelter geometry is a property of the BODY, not of the wave:
  // every class breaks around the same lee, so what a pilot learns once holds.
  //
  // MOONS SHELTER. They always could in principle — the type test has read
  // planet/moon/rogue from the start — but MIN_R at 60 quietly failed 40 of the
  // sky's 59 moons (median radius 52.5), so "duck behind that moon" was a move
  // that worked two times in three and there was no way to tell which. 24 clears
  // every real moon (the smallest a seed can roll is ~25.5) and still refuses
  // the ring shepherd at 18: a moonlet the size of the ship shelters nobody, and
  // that is the pebble line the floor exists to draw.
  STORM_SHADOW: 1.15,      // shadow cylinder radius, x the sheltering body's radius
  // …plus a FLAT pad, because forgiveness has to be measured in ship-widths and
  // a pure multiple is not: 1.15x a 26-radius moon is a 30-unit half-width — a
  // slot a TITAN (SHIP_RADIUS 44.2) does not fit through, let alone thread under
  // fire with the sensors out. The pad is sized off the largest hull in the game
  // for exactly that reason: at 45 the smallest moon in the sky shelters even
  // the biggest ship, while a 500-radius planet barely notices the +8%.
  STORM_SHADOW_PAD: 45,
  STORM_SHADOW_LEN: 30,    // how far that lee reaches behind it, x radius
  STORM_SHADOW_MIN_R: 24,  // smallest body that casts one — see MOONS SHELTER above

  PREDICT_STEPS: 200,      // trajectory forecast resolution (ship path)
  PREDICT_DT: 1 / 30,
  HELD_STEPS: 60,          // the throw line is short (~2s of flight)...
  LOCK_T: 1.8,             // ...and lock-on only works within throw-line reach

  // DELIVERY: flinging/towing a matching object into a target's catch radius
  // hands it over (world.updateDeliveries — the relay, the Herald, the Tinker
  // Barge, and mayday-pod docks all share this one verb).
  DELIVER_R: 280,
  // The barge only asks for things it can see from its own deck: wants are
  // picked from a census of matching bodies within this radius of the barge
  // (user design rule — a want you must haul from across the system reads as
  // a chore, not a trade; the graveyard-wreck want effectively retires unless
  // the player has stockpiled wrecks nearby). 6000 comfortably covers the
  // neighboring junk-satellite worlds, ring ice sweeping past, and the
  // view-local rock field of a player hanging around to trade.
  TINKER_WANT_R: 6000,
  // IRON MOONS are magnetic: loose scrap DEBRIS inside this range drifts into
  // a pooling halo just off the surface. Debris ONLY — the storm-shove law:
  // a force that touched bodies, celestials, or rails is an invariant
  // regression waiting to happen (see CFG.STORM_* above).
  IRON_MAGNET_R: 900,
  IRON_MAGNET_A: 60,       // capped accel — gentler than the storm shove (STORM_SHOVE)
  // DUST MOONS trail a concealing halo: inside DUST_HALO x radius the ship is
  // invisible to alien senses (ai.js gates on game.dustCloak). The render
  // gradient reaches wider than the mechanic so the boundary never reads as a
  // hard edge (in-world transitions are organic, never geometric).
  DUST_HALO: 2.4,
  // SHROUD PLANETS conceal the same way (ai.js feeds the same game.dustCloak
  // flag, so every AI gate works unchanged) — a smaller multiple because the
  // world is planet-sized. Fortified shrouds don't cloak (a permanently
  // cloaked siege would be a free win). Render haze reaches 2.1x — wider than
  // the mechanic, same no-hard-edge law as the dust moons.
  SHROUD_HALO: 1.7,
  // TERRAN ATMOSPHERE (physics.step): loose free-flying rocks entering the
  // shell burn — depth² x maxHp-fraction dps, the corona-heat shape, so small
  // rocks flash to nothing while a heavyweight (> ATMO_MAX_MASS) punches
  // through to the surface: bombarding a terran world takes a real rock.
  // Railed bodies are exempt (the world's own junk satellites live inside the
  // shell, and damaging a railed body derails it — a cascade), as are held
  // rocks and premium/quest objects. The SHIP is untouched: breathable sky.
  ATMO_ZONE: 1.5,
  ATMO_MAX_MASS: 1400,
  ATMO_DPS_FRAC: 0.9,
};

// THE POCKET OUTLINE. A pocket sampled straight from the FIELD_LEN x
// FIELD_SPREAD extents reads as a SQUARE of rocks — the eye finds the four
// corners immediately and the shoal stops being a place and becomes a box.
// The outline is therefore a lobed blob: a few low harmonics (deterministic
// per field, seeded in world.seedDenseFields) bulge and pinch the boundary,
// so every approach shows a different silhouette and the edge never runs
// straight. Amplitudes are capped well under 1 so the radius stays positive
// and the pocket stays roughly as big as its extents claim (~0.67x-1.33x).
// The tempered mass every DEALT-damage formula uses in place of raw impactor
// mass (see CFG.DMG_MASS_KNEE). One function, sim-wide, so body-vs-body, the
// gas-giant entry, the ram and the alien-hit paths cannot drift apart —
// LINEAR below the knee (x DMG_MASS_LOW_MUL, the deliberate bottom-end lift),
// continuous at it, sublinear and monotone above it — the LOW_MUL scales the
// WHOLE curve, sub-knee included. Mass DOMINANCE stays on raw mass:
// dominance decides who hurts whom (a direction), this decides how hard the
// blow can possibly land (a magnitude), and running dominance through the
// temper would let a tempered giant start TAKING real damage from pebbles.
export function dmgMass(m) {
  return CFG.DMG_MASS_LOW_MUL * (m <= CFG.DMG_MASS_KNEE
    ? m : CFG.DMG_MASS_KNEE * Math.pow(m / CFG.DMG_MASS_KNEE, CFG.DMG_MASS_EXP));
}

// Returns the outline radius in NORMALIZED pocket units (1 = the plain
// ellipse). A field with no lobe table (an older save, a test stub) falls
// back to the ellipse.
export function fieldLobe(f, th) {
  const L = f && f.lobe;
  if (!L) return 1;
  return 1 + L[0] * Math.cos(2 * th + L[1])
           + L[2] * Math.cos(3 * th + L[3])
           + L[4] * Math.cos(5 * th + L[5]);
}
export const FIELD_LOBE_MAX = 1.42;   // ceiling on fieldLobe — see seedDenseFields' amplitudes

// Normalized position of (x, y) in a dense field's POCKET frame: <= 1 means
// inside the lobed footprint (FIELD_LEN along the lane, FIELD_SPREAD across
// it, modulated by fieldLobe), values above 1 scale with how far outside.
// This is THE containment test for everything field-scoped — the lurker leash
// and wake (ai.js), the hunting-eye mirror (render.js), and the entry
// announce (world.js) all share it so they can never disagree about where a
// field ends; the rock SCATTER is sampled from the same outline (world.js
// fieldPoint) so what the containment test calls "inside" is exactly where
// the rocks are. Lives in config because config is a leaf every consumer
// already imports, and it needs CFG.
export function fieldFrac(f, x, y) {
  const dx = x - f.x, dy = y - f.y;
  const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
  const rad = dx * ca + dy * sa;        // radial offset (across the lane)
  const tan = -dx * sa + dy * ca;       // tangential offset (along the lane)
  const nx = tan / CFG.FIELD_LEN, ny = rad / CFG.FIELD_SPREAD;
  const q = Math.hypot(nx, ny);
  if (q < 1e-6) return 0;
  return q / fieldLobe(f, Math.atan2(ny, nx));
}

// WHAT A PIECE OF A WORLD WEIGHS, from how big it is drawn.
//
// Crust is sized off its parent world, not off its mass (CFG.CRUST_*) — that is
// what makes a slab look like a slab. But MASS is what the game gates on: the
// tractor's tier caps (TIERS.caps), the orbit stow, the fling solver and the
// hover hint ring are all mass tests. Leave the two unrelated and a 130-unit
// slab of planet weighs the same as a pebble, so every gravity tool picks it up
// like one — which is exactly what it looked like, and wrong.
//
// So drawn radius maps to mass through one curve, tuned against the TIER CAPS
// rather than against rock density (belt rock's own radius curve would put a
// 130-unit body at 9 million, heavier than the sun — the same reason worlds are
// big-not-heavy under the WORLD SCALE law). The ladder it produces, read
// against the beam class ladder (TIERS):
//   ~12u crumb  ->    ~300  grabbable from tier 0 — this is the ammunition
//   ~40u piece  ->   ~3,900 boulder class, needs tier 2
//   ~90u slab   ->  ~21,000 large-moon weight, needs tier 4
//  ~130u slab   ->  ~45,000 world weight, needs tier 5, and that is the ceiling
// A full-severity slab off a gas giant IS a small world, and it asks for the
// beam a small world asks for; the crumbs and pieces that make up the bulk of
// any wound stay early-game ammunition, which is what the crumble loop runs on.
// The ceiling is the point: it stays under the 5e4 rail-disturber threshold, so
// even a thrown slab of planet can never wake whole rail lanes.
export function crustMass(R) {
  return Math.max(90, Math.min(45000, 1.8 * Math.pow(R, 2.1)));
}

// ---------------------------------------------------------------------------
// WORLD DEBRIS MATERIAL — what a piece of a given world is made of. The ONE
// table behind both halves of the crumble layer: the rubble belts worldgen
// hangs on every planet (world.seedDebrisBelts) and the crust a wounded world
// calves under fire (physics.calveCrust). They must agree, or a planet's own
// broken-off slabs would read as a different substance from the rubble already
// orbiting it.
// The base tone is the HOST'S OWN COLOUR on purpose — render's chunk sprite
// paints fracture faces by knocking that colour down and keeps one bright edge
// run as surviving crust, so a piece drawn in its parent's colour reads as
// split rock FROM that parent rather than as a rock painted to match. Only the
// archetypes with a genuinely different substance override it.
// `mix` is a 0..1 roll from the caller's rng — seeded at worldgen, Math.random
// for runtime calving, same as every other spawn in the game.
export function worldDebris(ptype, hostColor, mix = 0.5) {
  switch (ptype) {
    // Ring and shell ice: the existing gas-giant ring material, extended to the
    // ice worlds — which shipped with NO orbiting rock at all.
    case 'gas':  return { color: mix < 0.72 ? '#cfe6f2' : '#a9c6d8', ice: true };
    case 'ice':  return { color: mix < 0.6 ? '#bfe3f2' : '#8fb6cc', ice: true };
    // Chilled ejecta over a lava world — basalt, with the hottest fraction
    // still glowing. Colour only: a real `magma` timer would enrol every piece
    // in the decay registry and cool them all to one brown within seconds.
    case 'lava': return { color: mix < 0.3 ? '#8a4a30' : mix < 0.7 ? '#5c453e' : '#42352f' };
    // Facet shards. A slice of them hide a mineral core, so a crystal world's
    // halo prospects like the cored belt rock does — the same battle-tested
    // loop, not a new economy.
    case 'crystal': return { color: mix < 0.5 ? '#9d86c9' : '#7a6ba3', cored: mix < 0.22 };
    // Everything solid keeps its parent's face.
    default: return { color: hostColor };
  }
}

// ---------------------------------------------------------------------------
// ---- THE SOLAR WAVE: the two derivations every consumer has to share -------

// Pick a wave class off CFG.STORM_CLASSES — a FLAT random pick, equal odds, no
// weights and no special cases. That evenness is the point: weight the table (or
// force the first wave of a run to the gentle row, which is the other tempting
// special case) and the telegraph stops being worth reading, because there is a
// class you can assume it probably is.
//
// `roll` is the caller's rng — always Math.random in practice, because a wave is
// RUNTIME weather and must never buy a draw off the seeded world stream (the
// same rule the retrograde-lane note in world.js states).
export function stormClass(roll) {
  const cs = CFG.STORM_CLASSES;
  return cs[Math.min(cs.length - 1, (roll() * cs.length) | 0)];
}

// HOW FAR OUT THE WAVE HAS LEFT TO GIVE, 0..1, from the shock's current radius.
// Full strength until `fade` of the way to `reach`, then dissolving to nothing
// at the limit — physics scales its bite by this and render scales every alpha,
// so a spent wave SHREDS instead of blinking out at an exact radius (which is
// the geometric in-world edge the house style will not have). A class's whole
// geography lives in these two numbers; see the STORM_CLASSES notes.
// A CLASS'S `fade` MUST BE < 1 — it is a fraction of `reach`, so at 1 the taper
// has zero width and above 1 it has negative width. The three shipped classes
// are 0.62 / 0.68 / 0.858; the `Math.max(1, …)` floor is what keeps a fourth
// row that breaks the rule legible rather than catastrophic, and the two ways
// to break it fail differently:
//   `fade: 1` (a plausible way to say "no taper at all") — without the floor
//   the divide is by 0, giving Infinity and therefore k = 0 for any r > `fadeR`.
//   Not NaN: a wave that BLINKS OUT at an exact radius, which is the
//   geometric in-world edge the house style will not have.
//   `fade > 1` — without the floor the denominator goes NEGATIVE and k comes
//   back ABOVE 1 (measured 1.139 at r = 44056 for `fade: 1.2`), i.e. a wave
//   stronger than full strength, amplifying every bite and every alpha.
// The floor degrades both to a one-unit taper. It is not a substitute for the
// invariant; it is what stops a bad row from silently rewriting the sun.
export function stormStrength(wave) {
  const reachR = CFG.WORLD_R * wave.reach;
  const fadeR = reachR * wave.fade;
  if (wave.r <= fadeR) return 1;
  return Math.max(0, 1 - (wave.r - fadeR) / Math.max(1, reachR - fadeR));
}

// …and when there is nothing left of it. The front, not the tail: the sheath
// trails BEHIND the shock, so a front stopped at the limit is a wave entirely
// inside it — which is what "a squall never reaches the outer system" has to
// mean. By here stormStrength is already 0, so nothing visible is being cut.
export function stormSpent(wave) { return wave.r > CFG.WORLD_R * wave.reach; }

// Half-width of the lee a body casts. THE ONE definition: main.shelterBody
// decides shelter with it and render.drawStormWave punches the plasma out with
// it (shrunk, the safe direction — see there). The two drifting apart is a pilot
// sitting in visible shadow taking damage, or worse, the reverse.
export function shelterR(b) { return b.radius * CFG.STORM_SHADOW + CFG.STORM_SHADOW_PAD; }

// ---------------------------------------------------------------------------
// DOCK STATIONS: the tier ladder, and the two radii both readers need.
//
// THE ART TABLE LIVES HERE, not in render.js, for one reason: the shield dome
// is a REAL COLLIDER (physics.updateDomeShield throws rock and aliens off it)
// as well as a drawn arc, and a field whose pushing edge and drawn edge came
// from two different expressions is the exact mirror-drift trap this codebase
// keeps warning about. One source, both readers — render.drawPad for the
// structure, physics for the push.
//
// One row per beam tier (0-5), read from the ship's CURRENT tier and not the
// one a station was laid down at: a dock is infrastructure you keep improving,
// so tiering up refits every station you own. The progression is a SILHOUETTE,
// not a detail pass — landing slab, gantry, second clamp pair, control block,
// dish, working spaceport — and each row only ever ADDS, so the thing you
// learned to recognize at tier 0 is still the thing in the middle at tier 5.
//
// `w` tracks WHAT IS STANDING ON THE DECK rather than growing for its own sake:
// a tier-0 pad is a narrow slab because a slab is all it is. A deck sized for
// the top tier at tier 0 reads as a derelict apron with a toy in the middle.
export const DOCK_TIERS = [
  { w: 0.86, pairs: 1, mast: 0,    tower: 0, dish: 0, lights: 2 },   // 0 — a landing slab and two clamps
  { w: 0.95, pairs: 1, mast: 0.8,  tower: 0, dish: 0, lights: 2 },   // 1 — a gantry mast goes up
  { w: 1.04, pairs: 2, mast: 0.95, tower: 0, dish: 0, lights: 3 },   // 2 — a second pair of clamps
  { w: 1.13, pairs: 2, mast: 1.1,  tower: 1, dish: 0, lights: 3 },   // 3 — a control block
  { w: 1.22, pairs: 2, mast: 1.25, tower: 1, dish: 1, lights: 4 },   // 4 — a comms dish
  { w: 1.32, pairs: 2, mast: 1.4,  tower: 2, dish: 1, lights: 4 },   // 5 — a working spaceport
];

// How big a station is. THE BERTH SETS THE SCALE — a dock is sized by the thing
// that parks in it, so this tracks the hull, not the world. The tier table then
// widens it only modestly, because the SHIP is already growing underneath
// (radius 4 at tier 0, ~44 at tier 5): multiplying the two growth curves
// together put a tier-5 port at two thirds of its planet's radius, which read
// as a megastructure the world was orbiting rather than a building on it.
//
// The host cap keeps a port from swallowing a small moon, and the berth floor
// WINS over it — a pad the ship does not fit on is not a pad, and on a moonlet
// a titan-class hull genuinely is most of the horizon.
export function dockTier(st) {
  return DOCK_TIERS[Math.min(DOCK_TIERS.length - 1, st.tier || 0)];
}
export function dockPadR(st, hostR) {
  const want = Math.max(16, st.radius * 2.2) * dockTier(st).w;
  return Math.max(Math.max(14, st.radius * 1.9), Math.min(want, hostR * 0.42));
}
// The dome, measured FROM THE SURFACE POINT under the pad (not the pad origin,
// which sits a hull-radius above the crust — `groundY` is that lift). Sized to
// ENCLOSE the station at whatever tier it is, so it tracks the mast height: a
// shield with the gantry poking out of the top is not a shield, and a flat
// multiple would leave tier 0 (no mast at all) under a dome three times taller
// than the thing it covers.
export function dockDomeR(st, hostR, groundY) {
  return dockPadR(st, hostR) * (1.15 + dockTier(st).mast * 0.24) + groundY;
}

// THE RAM'S GEOMETRY: A SLAB OF FUSED ROCK RIDING JUST AHEAD OF THE BOW. It is
// not welded on — it is HELD, floating a short gap off the nose in the same
// braided energy field that couples the scout's split drive section, and it
// visibly compresses into that field when it takes a hit or eats a rock. A flat
// working face across the front, rocky everywhere else, and WIDER THAN THE
// SHIP at every size — the overhang is the silhouette; a slab narrower than the
// hull would just read as a bigger nose.
//
//   back   where the field's hull emitters end and the coupling gap begins —
//          measured off the DRAWN nose (radius / SHIP_HIT_FRAC), not the
//          collision circle, or the slab overlaps the art it must stand clear of
//   gap    the energy gap the beams span (the spring's free length)
//   depth  the slab's thickness along the nose axis
//   halfW  half its width across the bow — always past the hull radius
//
// One definition, shared: render draws this exact slab and hangs the beams in
// this exact gap, physics takes the front CONTACT EDGE from ramFace and the
// covered arc from ramArc — so the edge you can see is the edge that hits and
// the edge that protects, per the CFG.dockDomeR mirror-drift rule.
export function ramPlate(st, ram) {
  if (!(ram > 0) || !(st.ramCap > 0)) return null;
  const fill = Math.min(1, ram / st.ramCap);
  const g = Math.pow(fill, CFG.RAM_R_POW);
  const r = st.radius;
  // DENSITY IS THE TIER, RANK IS THE CEILING (user design rule). The barrier's
  // visible tier tracks what is IN it right now — how dense the current ram
  // is — walking loose rubble up to a fused wall as you feed it, and back DOWN
  // as hits spend it. War Rack's rank only sets how high that ladder is
  // allowed to climb: each rank unlocks the next tier, it does not wear it.
  // ramTier below is the one place that mapping lives; the plate carries the
  // result so render's build and physics' tier-drop detection read one number.
  const t = ramTierOf(fill, st.orbitLvl || 1);
  return {
    back: (r / SHIP_HIT_FRAC) * 1.04,
    // The field gap is the compression spring's FREE LENGTH, and it is
    // deliberately generous: the slab rides well clear of the nose at rest so
    // that compression has somewhere visible to go — under thrust it squeezes
    // to ~2/3 of this, and an impact slams it nearly to the hull (render's
    // spring). A tight resting gap made all three states read the same.
    gap: r * 0.55,
    depth: r * (0.26 + 0.055 * t + 0.34 * g),
    halfW: r * (0.72 + 0.16 * t + 0.52 * g),
    fill,
    tier: t,
  };
}
// fill -> tier, capped by rank. Six even density bands: a rank-6 ram walks all
// six as it fills; a rank-2 ram tops out at tier 2 however much it holds
// (which can't be much — the cap is rank-scaled too, so the bands and the
// capacity climb together).
function ramTierOf(fill, rank) {
  return Math.max(1, Math.min(rank, Math.ceil(fill * 6)));
}
// The shared read: what tier is this ram AT? Physics compares it across a
// spend to catch a downward crossing (debris comes loose); render keys the
// rocklet build off it. 0 for no ram.
export function ramTier(st, ram) {
  if (!(ram > 0) || !(st.ramCap > 0)) return 0;
  return ramTierOf(Math.min(1, ram / st.ramCap), st.orbitLvl || 1);
}
// The leading face's distance from the ship's centre — the front contact edge.
// physics.collideShipBody swaps this in for the hull radius inside the covered
// arc, which is what makes a rock strike the slab you can SEE instead of
// passing through it to touch the hull buried behind.
// Measured at the FULL gap, deliberately ignoring the render spring: the
// compression (thrust / impacts) is cosmetic, and reading it here would make
// the contact edge ring with the visual. Conservative by construction — the
// sprung slab only ever sits AT or BEHIND this edge, so contact registers at
// the field's outer extent and never late; the few units of daylight during a
// compressed charge read as the field meeting the rock first.
export function ramFace(st, ram) {
  const p = ramPlate(st, ram);
  return p ? p.back + p.gap + p.depth : st.radius;
}
// The half-angle the slab actually covers, taken from its own corners. It
// widens as the slab widens, which is why "the bigger it is the more it shrugs
// off" needs no second constant to be true.
export function ramArc(st, ram) {
  const p = ramPlate(st, ram);
  if (!p) return 0;
  return Math.atan2(p.halfW, p.back + p.gap + p.depth);
}
// How much of the contact kick the ram lets you keep. Saturating on absolute
// mass — see CFG.RAM_KEEP_KNEE.
export function ramKeep(ram) {
  if (!(ram > 0)) return 0;
  return CFG.RAM_KEEP_MAX * (ram / (ram + CFG.RAM_KEEP_KNEE));
}

// ---------------------------------------------------------------------------
// THE BEAM CLASS LADDER (user design law: *a rank buys mass inside your class,
// never the class above*).
//
// Your beam TIER names a CLASS OF THING — pebbles, belt rock, boulders, small
// moons, large moons, worlds — and that class is a HARD GATE: a planet is
// unliftable below the top tier however many catch ranks you own, and a moon is
// unliftable below the moon rungs however light that particular moon happens to
// be. Inside your class, `capacity` is the mass allowance, and catch ranks raise
// it from `caps[tier]` toward `ceil[tier]` (shipStats) — which is exactly and
// only what a rank buys.
//
// This used to be ONE mass number with an unbounded multiplier on it
// (`caps[tier] * (1 + 0.22 * catchC)`), and the multiplier ran to 3.64x on a
// stacked catch channel (Heavy Winch 6 + Bulk Freighter 6). A tier-2 beam with
// that build carried 127,000 — most of the solid planets in the sky — and a
// tier-3 one carried a gas giant. Ranks were silently buying TIERS, so hauling
// a world stopped being the top of the ladder and became something you fell
// into a third of the way up it. The ceiling is what stops that: the class gate
// makes the promise, and the capped fill keeps ranks honest inside it.
//
// The rungs are fitted to the sky's actual mass census (seed 20260721):
//   ice shards 64-446, probe junk 70-384, crust crumbs 90-2,837, belt rock
//   40-2,600 (pebble floor doubled 2026-08), comets 2,400, caches 2,800,
//   derelict stations 1,500-1,900,
//   boulders 2,702-5,756, cored rock 677-4,416, shoal rock 120-4,999,
//   moons 900 + 2,400-17,050, shoal monoliths 19,523-480,000,
//   planets 20,000-650,000.
export const TIERS = {
  // The MASS CEILING of each class — and the class boundary itself (liftClass
  // walks this ladder). Catch ranks asymptote toward your own tier's entry and
  // can never cross it.
  ceil:   [1600, 3200, 6200, 8200, 18000, 1200000],
  // The allowance with NO catch ranks: where each tier starts. ceil[0] is set
  // so that an unranked tier-0 beam grabs what an unranked tier-0 beam always
  // grabbed (1,200) — the opening is unchanged; only the top of the ladder is.
  caps:   [1100, 2100, 4300, 6200, 11500,  360000],
  labels: ['Pebbles & ice', 'Belt rock', 'Boulders & cores', 'Small moons', 'Large moons', 'Planets'],
};

// WHAT CLASS OF THING THIS IS TO THE BEAM — the rung your tier must reach
// before the beam will take hold at all, independent of your mass allowance.
//
// Everything rides the one mass ladder above, with two type rules on top:
//   - A WORLD IS ALWAYS THE TOP RUNG. A planet is a planet whether it is the
//     20,000-mass lava pebble at the inner lane or the 650,000 amber giant;
//     "planets only at the top tier" is the whole point and a mass test would
//     hand the small ones over three tiers early.
//   - A MOON IS NEVER BELT ROCK, however light. Moon mass (900, then
//     2,400-17,050) overlaps boulders and shoal rock across two whole rungs, so
//     a pure mass test would sell a named, charted moon at the boulder tier.
//     The moon rungs are its own, split small/large at ceil[3].
// Anything else — belt rock, crust slabs, shoal monoliths, derelicts — is
// classed purely by weight, so a full-severity slab off a gas giant asks for
// the same beam a moon of the same mass does.
// Off the ladder entirely — no beam tier ever reaches these.
export const LIFT_NEVER = 99;

export function liftClass(b) {
  // A GAS GIANT HAS NOTHING TO GRIP (user design law). It is not a heavier rung
  // you buy your way up to; it is not on the ladder. This is the same fact the
  // ship already lives with — `CFG.GAS_*`, "gas giants have no surface for the
  // SHIP", it flies straight through the cloud tops — applied to the beam, and
  // it is why a giant is the one world in the sky you have to fight instead of
  // carry. STRIPPING one is the answer: physics.gasStrip sets `ptype = 'rocky'`
  // on what is left, so the exposed CORE is an ordinary top-rung world you can
  // absolutely pick up. That is the reward for the fight.
  if (b.type === 'star') return LIFT_NEVER;
  if (b.ptype === 'gas' && (b.type === 'planet' || b.type === 'rogue')) return LIFT_NEVER;
  if (b.type === 'planet' || b.type === 'rogue') return 5;
  let k = b.type === 'moon' ? 3 : 0;   // the moon floor
  while (k < 5 && b.mass > TIERS.ceil[k]) k++;
  return k;
}

// HOW LONG THE BEAM MUST WINCH BEFORE IT TAKES HOLD AT ALL, by lift class
// (user design law). Belt rock snaps into the beam the way it always has — 0
// here, and the whole early game is untouched. A MOON OR A WORLD has to be
// worked at: hold the button on it and the emitters bite in over seconds.
// Letting go or leaving beam RANGE drops it; the cursor is free to wander once
// the target is picked (tractor.updateLatch). It is what makes taking one an
// ACT rather than a click, and it is the front half of the same idea as the
// throw wind-up (tractor.beamGrip) — which is why the winch seconds carry over
// into `holdT` rather than being charged twice.
// THE WINCH IS A BAND PER CLASS, AND MASS POSITIONS YOU INSIDE IT (user design
// rule: "semi based on their mass as well, but shouldn't be outside of the
// numbers you have here"). A flat per-class number said a 2,400-mass moon and a
// 17,000-mass moon were the same job, which they visibly are not.
//
// The bands stay inside the 1.6 – 5.8 envelope the flat ladder set, and they do
// not overlap, so the CLASS ordering still holds absolutely: every small moon
// winches quicker than every large moon, which winches quicker than every
// world. Nothing below the moon rungs winches at all.
// (History: 1.1 / 1.8 / 2.9 flat, then doubled at the top end to 1.6 / 3.6 /
// 5.8 flat, now spread into bands over the same envelope.)
export const LATCH_BAND = { 3: [1.6, 2.6], 4: [2.6, 4.0], 5: [4.0, 5.8] };
// The mass span each band interpolates across. Moons read their own class
// bounds; WORLDS use a fixed reference span rather than the live planet range,
// because planet masses are seed-shaped and the feel of winching a world must
// not change from seed to seed.
const LATCH_SPAN = { 3: [900, 8200], 4: [8200, 18000], 5: [2e4, 7e5] };
export function latchTime(b) {
  const k = liftClass(b);
  const band = LATCH_BAND[k];
  if (!band) return 0;                       // belt rock takes hold on the click
  const [m0, m1] = LATCH_SPAN[k];
  const x = (b.mass - m0) / (m1 - m0);
  // SQRT, not linear: a world's band spans 33x in mass, and read linearly every
  // planet under ~150,000 would pin to the floor and the mass sensitivity would
  // only exist for the two giants nobody can lift anyway.
  const t = Math.sqrt(x < 0 ? 0 : x > 1 ? 1 : x);
  return Math.round((band[0] + (band[1] - band[0]) * t) * 100) / 100;
}

// THE ONE GRAB TEST — class gate first, then the mass allowance inside it.
// tractor.tryGrab, the hover hint ring (render) and the stow tests all route
// through here so the ring can never promise a grab the beam refuses.
export function canLift(st, b) {
  return liftClass(b) <= st.tier && b.mass <= st.capacity;
}

// The same pair for the STOW (orbit shield / brawler rack), which rides one
// class below the beam — see shipStats for how orbitTier/orbitCap are derived.
export function canStow(st, b) {
  return st.orbitCap > 0 && liftClass(b) <= st.orbitTier && b.mass <= st.orbitCap;
}

// Per-tier collision radius. DERIVED, not hand-picked: the ship's full drawn
// FOOTPRINT (nose tip / outer ring — shipVisualR) grows by the SAME RATIO
// each tier (x1.62, from 6.0 to 67 world units — equal RATIOS, not equal
// increments: the eye judges size change multiplicatively), and the collision
// circle is a UNIFORM fraction of that footprint on every tier:
//   SHIP_RADIUS[t] = SHIP_HIT_FRAC × footprint[t]
// History: the collision circle used to be the drawn body DISC only, which
// covered 43% of the visual reach at tier 0 but ~57% at tier 5 — rocks
// visibly sailed through the scout's nose, and the hitbox feel changed tier
// to tier ("collision size doesn't match the ship"). 0.66 covers the solid
// hull mass everywhere while leaving nose tips and thin ring arcs forgiving.
// render.js normalizes the art to the footprint (r / SHIP_HIT_FRAC), so
// changing the fraction moves ONLY the hitbox, never the drawn size.
export const SHIP_HIT_FRAC = 0.66;
export const SHIP_RADIUS = [4.0, 6.4, 10.4, 16.8, 27.3, 44.2];

// PER-TIER SHIP MASS. It was a flat 10 forever — which was harmless while
// nothing read it, and stopped being harmless the moment the tether went taut
// (CFG.TETHER_MAX_MUL): a rope resolves by MASS RATIO, so a constant-10 ship
// meant a Titan wrestled a moon exactly as badly as a Scout did, and every
// load in the game won every fight outright.
//
// DERIVED from the drawn footprint, not hand-felt: SHIP_RADIUS grows by a
// uniform x1.62 per tier, and mass rides that at the power 2.5 (1.62^2.5 =
// x3.34 a tier) — between area and volume, because a ship is hull and framing
// rather than a solid lump. Over the run that is ~420x, so what you can wrestle
// changes completely from end to end: a Scout is a gnat on anything it can
// lift, a Titan can genuinely muscle the smaller worlds and still gets swung
// around by a gas giant's core.
// If SHIP_RADIUS is ever re-derived, re-derive this with it.
export const SHIP_MASS = [10, 34, 112, 375, 1250, 4200];

// Per-tier camera zoom TARGET (the value cam zoom eases toward): a
// geometric ramp from 2.46 to 0.6 — each step recedes by the same ~25%
// RATIO. The start value is DERIVED, not aesthetic: it makes the ship's
// APPARENT on-screen size arc identical to the approved one (~15px-eq
// scout -> ~40px-eq titan) while the ship's WORLD size shrank — small
// ships look the same in the viewport but tiny next to planets. The pairing
// anchor is the drawn FOOTPRINT ladder (SHIP_RADIUS ÷ SHIP_HIT_FRAC): change
// THAT and you must re-derive this — retuning SHIP_HIT_FRAC alone moves only
// the hitbox and needs no zoom change. Zoom is driven by beam tier
// alone — other progression tracks don't pull the camera back.
// NOTE: this tight tier-0 zoom is why the SKY SPEED is tuned low (the sun's
// mass, world.js) — the world scrolls past ~2x faster per zoom unit, so a
// fast sky at this zoom reads as flying wildly fast. Flight feel = sky speed
// x zoom; they tune together. Raise this zoom and the sun mass must drop.
export const SHIP_ZOOM = [2.46, 1.86, 1.40, 1.06, 0.80, 0.60];

// Per-tier ship CLASS name (matches the hull designs drawn in render.js
// SHIP_TIERS). Distinct from st.label, which names what your BEAM can grab.
export const SHIP_NAMES = ['Scout', 'Fighter', 'Corvette', 'Cruiser', 'Dreadnought', 'Titan'];

// What each planet ARCHETYPE (b.ptype — one mechanic each, see world.js) calls
// itself to the player. A catalog, so it lives here in the leaf rather than in
// whichever file happened to print it first: the in-world approach plate
// (render.drawApproach) and the system chart's readout (starmap.contactClass)
// both name the same world, and two copies of this table would drift.
export const PTYPE_LABELS = {
  lava: 'LAVA WORLD', rocky: 'ROCKY WORLD', gas: 'GAS GIANT', ice: 'ICE WORLD',
  terran: 'TERRAN WORLD', ocean: 'OCEAN WORLD', desert: 'DESERT WORLD',
  shroud: 'SHROUDED WORLD', crystal: 'CRYSTAL WORLD',
};

// ROGUELITE PROGRESSION (spec-based). The RUN OPENS on a SPECIALIZATION choice
// (SPECS — main.startGame -> the 'spec' modal); it sets your starting kit and gates
// which named ABILITIES you can be offered. The core grab/throw/fly loop is base
// (shipStats), so every spec is playable at once. Doing good things (grab, smash,
// skim, kill, collect, survey, slingshot, shield-block) grants XP.
//
// TWO PROGRESSION TRACKS, ONE XP STREAM (user design rule). Every XP award feeds
// BOTH at once — they are parallel accumulators, not a shared purse:
//   1. RANKS ARE AUTOMATIC. Each ability you own carries its OWN xp pool
//      (prog.abilXp[id]) and its own per-rank threshold (abilityRankCost —
//      specific to that ability, and RISING with every rank taken). Cross the
//      threshold and the rank lands by itself, mid-flight, no modal. The HUD
//      draws a fill bar under every learned ability so you can watch each one
//      climb. Nothing is ever spent to rank up — growAbilities only accrues.
//   2. NEW ABILITIES ARE CHOSEN. Crossing xpForPick PAUSES the game (the
//      frame() gate) for a card, and a card ONLY ever offers abilities you do
//      NOT own yet (tierChoices, soft-floored by minTier). There is exactly ONE
//      such pick between tier-ups (PICKS_PER_TIER), then the next one is the
//      TIER-UP milestone: same new-ability choice, plus the tier bump and +1
//      life. So a tier hands you two new abilities and ranks up everything you
//      already fly, continuously.
// Death spends a life (build kept); 0 lives = game over and a fresh spec choice.
export const PROG = {
  START_LIVES: 3,
  MAX_LIVES: 5,
  PICKS_PER_TIER: 1,       // new-ability picks between tier-up milestones
  // XP-to-next-pick: BASE + STEP*level + CURVE*level² (level = picks taken).
  // FRONT-LOADED PACING (user design rule, tightened three times now). The
  // original linear curve (145 + 58*level) priced every tier in the same band,
  // so the opening crawled exactly like the midgame; the quadratic redistributes
  // the climb onto the later tiers, and successive speed passes have scaled the
  // whole thing down while pushing the weighting further forward. Per-tier
  // totals (2 picks each, T_t = 2B + S(4t+1) + C(8t²+4t+1)):
  //     183 / 595 / 1247 / 2139 / 3271   — total climb 7435
  // The pass before this ran 308 / 852 / 1652 / 2708 / 4020 (9540): the current
  // numbers are ~22% faster overall and DELIBERATELY not uniformly so — tier 0
  // is 41% quicker, tier 1 30%, tier 2 25%, tier 3 21%, tier 4 19%. The opening
  // is where speed is felt, so that is where the cuts went.
  // AUTO-RANK RESHAPE: a tier used to cost FOUR picks (3 rank-ups + the
  // milestone). Ranks are automatic now, so a tier is TWO picks — both of them
  // whole NEW abilities. The first lands at 72 XP: two surveys, or a handful of
  // smashes. And the ability bars start filling from XP #1, so the opening
  // minute answers back continuously between the cards.
  // ACHIEVEMENT PASS: achievements pay XP now (XP_PER_ACH_POINT below), and
  // that stream is STEEPLY FRONT-LOADED — most rows a given player earns land
  // in the opening minutes (FIRST STEPS plus every "do X once" row), while the
  // deep thresholds and the insane feats mostly never land at all. Measured on
  // a DRIFTING ship that never played: score 25 -> 160 -> 260 -> 325 -> 380 at
  // t = 50/100/150/300/450s, and flat after — 96 XP inside the first 100
  // seconds, over half the old tier-0 cost, with the last 150s paying nothing.
  // So the curve is raised WHERE THE INCOME LANDS, not uniformly (the first
  // pass scaled everything by 1.31 and was wrong in both directions: it
  // under-corrected tier 0 and taxed tier 4, which gets almost none of it):
  //     183 ->  303  (x1.66)   guaranteed income — every player earns these
  //     595 ->  763  (x1.28)
  //    1247 -> 1399  (x1.12)
  //    2139 -> 2211  (x1.03)
  //    3271 -> 3199  (x0.98)   optional income — DON'T price it in
  //   total climb 7875 (was 7435)
  // The split is the principle: early achievement XP is a FLOOR (nobody misses
  // "catch a rock"), so absorbing it into the price is fair to everyone; late
  // achievement XP varies wildly between players, so assuming it would punish
  // anyone who doesn't chase it. The absorption is deliberately partial early
  // (~65%) — earning XP by play is genuinely hardest at tier 0 with the weakest
  // ship, and that is exactly where a boost is worth having.
  // This flattens the curve somewhat (tier 0 is 9.5% of tier 4, was 5.6%),
  // which is the point: TOTAL income is now flatter than it was, since
  // achievement XP falls off as play XP climbs.
  XP_BASE: 105,
  XP_STEP: 82,
  XP_CURVE: 11,
  // ---- automatic ability ranks (growAbilities / abilityRankCost) ----
  // ABIL_XP_TOTAL is the budget for the LONGEST track (6 ranks) at weight 1.0
  // to climb from rank 1 to max — sized just under the 7875 full climb, so a
  // kit ability owned from frame one tops out around tier 4-5. KEEP IT IN RATIO
  // with the pick curve above: shorten the climb without shortening this and
  // every ability ends the run mid-ladder.
  // GROWTH splits that budget across the (max - 1) rank-ups with linearly
  // rising weights (1, 1+G, 1+2G, …) — every rank costs more than the last.
  // SHORT is how much of the budget a track keeps when it has FEWER ranks. At
  // 1.0 (a flat budget per ability) a 3-rank track's first rank cost ~2200 XP,
  // five times a long track's, and short abilities sat visibly inert for two
  // tiers. At 0 (budget straight-line with length) they'd max in the opening
  // minutes and their bar would be decoration for the rest of the run. 0.45
  // sits between those: short tracks rank noticeably sooner AND still finish
  // late-ish. Per-row `xpMul` then scales an individual ability (late-tier rows
  // discount it — they're learned with far less run left to earn in).
  // (Scaled 6500 -> 6900 with the pick curve's total in the achievement pass —
  // the RATIO to the climb is what matters, and the stagger below is
  // proportional, so the kit-gap and rising-threshold laws scale with it
  // untouched. Note the ability pools receive the achievement XP too, so this
  // tracks the total climb, not the pick curve's shape.)
  ABIL_XP_TOTAL: 6900,
  ABIL_XP_GROWTH: 0.9,
  ABIL_XP_SHORT: 0.45,
  // STAGGER (user design rule: abilities must never rank up in lockstep). Every
  // owned ability's pool receives the SAME award, so two tracks with the same
  // `max` and `xpMul` — three of the four BRAWLER kit abilities, say — hold
  // identical pools forever and would cross identical thresholds on the same
  // frame. That fired as one useless "3 ABILITY RANKS GAINED" instead of three
  // separate moments. Two deterministic offsets (hashed off the ability id, so
  // the bars stay rock-steady frame to frame and runs stay repeatable) pull
  // them apart:
  //   SPREAD — a per-ABILITY scale on its whole ladder. This is what actually
  //     separates two same-shaped tracks, and the gap widens with every rank
  //     since it's proportional.
  //   WOBBLE — a per-RANK nudge on top, so an ability's own steps aren't a
  //     clean multiple of each other either. It is deliberately SMALLER than
  //     SPREAD and BOUNDED: the tightest consecutive-rank ratio in the ladder
  //     is 1.243 (ranks 4->5 of a 6-rank track), so a wobble beyond ~0.108
  //     could make a later rank cost LESS than an earlier one and break the
  //     "thresholds always rise" rule. Keep it under 0.10.
  // The KIT rows don't take SPREAD from the hash — see the kit-spacing note on
  // abilityRankCost. A hash is luck, and once every ability became six ranks a
  // kit fired 15-20 rank-ups in one run instead of 9-13: searching this pair
  // could no longer separate them (the best tightest-gap anywhere on the whole
  // (spread, wobble) grid was 18 XP, against 52 in the old mixed-length
  // catalog). Kit ladders are spaced evenly across the SPREAD band by kit
  // position instead, which separates them by construction; SPREAD is still
  // what sets the WIDTH of that band, and the hash still applies to every
  // ability learned from a card.
  // WOBBLE was halved (0.08 -> 0.04) as part of that: the kit spacing hands
  // rank 1 a 75 XP separation at this spread, and a +-8% per-rank nudge on a
  // ~490 XP first threshold is +-39 XP, i.e. enough to eat most of it. At 0.04
  // the tightest kit gap is 47 XP; the ladder still isn't a clean multiple of
  // itself, which is all the nudge was ever for. devtest T5c asserts both laws
  // against the real catalog, so an ability that collides fails the suite.
  ABIL_XP_SPREAD: 0.23,
  ABIL_XP_WOBBLE: 0.04,
  // XP awards per action (tuned in the balance-test soak — see CLAUDE.md)
  XP_CATCH: 6,             // + up to 20 scaled by mass vs capacity
  XP_SMASH: 10,            // + 12 for a big kill
  XP_SCRAP: 0.5,           // per unit of debris-chunk value collected
  XP_ORBIT: 8,             // stow a rock into the orbit shield
  XP_BLOCK: 14,            // a shield rock intercepts an alien throw
  XP_PARRY: 14,            // a Deflector parry launches its rock (paid at the launch, not the catch)
  XP_RAM: 7,               // a ram KILL (shatter credit 'ram') — kills only, chip damage pays nothing
  XP_SURVEY: 40,           // chart a world
  XP_SKIM: 0.7,            // per hull-point ground off while skimming a surface
  XP_SLING: 0.6,           // per unit of speed gained in a clean slingshot
  // ---- expedition layer: charting, deliveries, rescues ----
  XP_SURVEY_MOON: 15,      // charting a moon — worth less than a world
  XP_SURVEY_POI: 25,       // charting a station or named landmark
  XP_SURVEY_STAR: 160,     // charting the hidden dark star (the relay questline payoff)
  XP_MASTER_CHART: 250,    // logging EVERY chartable body in the system
  XP_HERALD: 200,          // waking the Herald (deliver it a graveyard wreck)
  XP_TRADE: 150,           // the Tinker Barge's XP payment option
  XP_RESCUE: 180,          // docking a mayday pod at a station before its air runs out
  XP_SKIM_BANDED: 3,       // banded-moon skim XP multiplier (the skate park)
  XP_SKIM_DUNE: 2,         // desert-world dune skim multiplier (a planet is an easier skate than a moon — pays less)
  // ---- the solar wave (CFG.STORM_*): riding one out in the open ----
  // Staying exposed in the sheath costs hull the whole time it passes, so it
  // is a real wager and it pays like one. CAPPED PER WAVE (STORM_RIDE_MAX):
  // the front outruns any ship, but you can still ride it outward and stretch
  // your time in it, and an uncapped per-second payout would reward exactly
  // that — the same rate-independence argument as the dense fields' xpLeft.
  // ~10s of sheath at 5/s is ~50 XP a wave against a 303-XP tier 0: worth
  // taking the hits for, nowhere near worth farming.
  //
  // THIS IS THE CME RATE, and every class scales it by its own `pay` (0.45 /
  // 0.72 / 1). A squall costs a tenth as much hull as a CME, so paying it the
  // same per second would make the cheap wave the efficient farm and quietly
  // invert the whole ladder. The cap is left FLAT at 14s: the weak classes have
  // shallow sheaths and never come near it anyway, so scaling it would only
  // punish a pilot for chasing a squall outward — the one skilled thing you can
  // do with one.
  XP_STORM_RIDE: 5,
  STORM_RIDE_MAX: 14,      // seconds of exposure paid per wave
  // Scrap the wave sweeps comes out IONIZED and pays more. Never field-sourced
  // scrap: that chunk's XP was already charged against the pocket's budget at
  // drop time (fieldXp), and re-inflating it at pickup would launder the field
  // farm straight back through the weather.
  //
  // THIS IS THE CEILING, reached only by a CME at full strength. `d.ion` stores
  // how far toward it the chunk was charged — the sweeping wave's `pay` times
  // its remaining `k` — rather than a bare flag, so the pickup multiplier lerps
  // 1 -> ION_SCRAP_MUL and a squall's salvage is worth visibly less than a CME's.
  //
  // 0 MEANS UNCHARGED, and that is a state the scalar really can reach now that
  // a spending wave scales `pay` by `k`. Everything downstream still tests
  // `if (d.ion)` — the charged-blue draw, the ionScrap stat — so the value has
  // to be either a MEANINGFUL charge or none at all: see STORM_ION_FLOOR, which
  // is what keeps those truthiness tests honest rather than merely defined.
  ION_SCRAP_MUL: 1.7,
  // The least a wave may charge a chunk and still mark it. Below this it stamps
  // NOTHING, because render's rule is that the colour IS the price tag and has
  // to be unmistakable at a glance — and a chunk burning full charged-blue for a
  // 1.03x payout is that tag lying. The floor sits well under the weakest real
  // charge (a squall at full strength is `pay` 0.45), so it only ever catches a
  // front already shredding at the end of its reach: squall stops charging below
  // k~0.44, surge below k~0.28, CME below k 0.2. A wave too spent to bite is too
  // spent to ionize.
  STORM_ION_FLOOR: 0.2,
  // FIELD ROCK PAYS A FRACTION (fieldXp below). A dense field is ~1900 rocks
  // in one pocket and there are four of them: at full rates parking inside one
  // and grinding the nearest gravel out-earned every aimed, risky thing in the
  // game by an order of magnitude — it was the optimal play, which is exactly
  // what a sandbox reward curve must not have. The rocks are SCENERY and
  // ammunition, not an income stream; the field's real payouts are its
  // ACHIEVEMENTS (calving a monolith, surviving a lurker ambush), which now pay
  // XP of their own, so the feats still pay while the grind doesn't.
  XP_FIELD_MUL: 0.3,
  // ...AND each pocket carries a FINITE XP BUDGET for the whole run (fieldXp
  // below). The multiplier alone could never hold: it prices ONE rock, and the
  // problem is that a shoal holds 1900 of them, so any trick that raises the
  // rock-per-minute rate (the billiards chain, a Demolition blast, whatever is
  // found next) simply outruns it. A budget is rate-independent — it caps the
  // whole pocket no matter how fast you empty it. Deliberately the same shape
  // as FIELD_BROOD, the lurker budget: finite per run, no refill, so working a
  // shoal dry is a CHOICE with a consequence that traces back to the player.
  // ~30 rocks' worth each, ~600 XP across all four fields = under 8% of the
  // climb: fields contribute, but can never be the plan.
  FIELD_XP_BUDGET: 150,
  // ACHIEVEMENTS PAY XP: an earned row grants pts x this (main.drainAchievements).
  // Deliberately derived from the point band, so the reward tracks how hard the
  // row was: a 200-pt insane feat pays 120 XP (three world surveys), a 5-pt
  // trivial one pays 3. Sized so a strong achievement-chasing run banks roughly
  // a quarter of the climb this way and the pick curve above absorbs it.
  XP_PER_ACH_POINT: 0.6,
  // Life pods: sparse world collectibles that refill the buffer
  LIFE_R: 62,              // collect radius
  LIFE_MAX_ACTIVE: 1,      // at most this many adrift at once
  LIFE_RESPAWN: 150,       // avg seconds between respawns (only while under MAX_LIVES)
  // Glow pockets (glow.js): sparse clusters of small bioluminescent motes that
  // ride the belt's prograde orbit, scattered thin across the whole mid system.
  // Motes are SLIGHTLY MAGNETIC — drift near one and it leaps into the ship,
  // popping just BEFORE the hull touches it, for a little hull + XP. Glow pockets
  // are the ONLY place the hull heals mid-life (design law; it otherwise only
  // resets on respawn). Pockets never refill where you stand: as one is drained
  // it vanishes and a fresh pocket fades in ELSEWHERE, so the healing supply
  // constantly relocates and you're always flying on to the next one.
  GLOW_POCKETS: 48,        // active pockets kept scattered across the system
  // Orbital band the pockets scatter through — just above the graveyard ring,
  // out to the far ice belt. Both are sun-anchored radii, so both ride SYSTEM
  // SCALE with the lanes they are described against: without it, spreading the
  // sky leaves the healing supply bunched in the inner third of it.
  GLOW_RMIN: 4200 * SYS,
  GLOW_RMAX: 31000 * SYS,
  GLOW_SPREAD: 480,        // field radius — WIDE, so you sweep the ship through it (and it's easy to spot)
  GLOW_MOTES: 9,           // motes in a fresh pocket (more, to keep the wide field dense enough to scoop)
  GLOW_R: 6,               // pop gap beyond the hull — the mote flies ALL the way in and pops AT the ship
  GLOW_MAGNET: 170,        // capture range — once the ship is this close a mote commits and vacuums in
  GLOW_HOME_MIN: 240,      // homing speed the instant a mote is captured...
  GLOW_HOME_MAX: 900,      // ...ramping up to this — faster than the ship, so it always reaches the hull
  GLOW_HOME_ACCEL: 1600,   // homing acceleration (u/s²): the vacuum ramp from MIN to MAX
  GLOW_HEAL: 4,            // hull points mended per mote (small — there are many)
  GLOW_XP: 3,              // XP per mote
};

// SPECIALIZATIONS. You pick ONE at the start of a run (main.startGame -> the 'spec'
// modal). It sets your starting kit and gates which named ABILITIES you can be
// offered at tier-ups. The core grab + throw + fly loop is UNIVERSAL (shipStats
// bases), so every spec is playable from the first frame; the kit + tree layer on.
// KIT RULE (design law): every kit must contain at least THREE abilities with
// max > 1. A max-1 unlock arrives already maxed and can never rank, so a kit
// short on rankable tracks opens the run with almost no automatic progress to
// watch — the ability bars ARE the minute-one feedback, and the first card is a
// couple of minutes out. (The rule predates automatic ranks: it used to be that
// between-tier picks could only deepen owned abilities, so a thin kit made the
// first picks a non-choice. Same rule, same fix, different failure mode —
// SCOUT once shipped with a lone rankable track behind Retro Jets.)
export const SPECS = [
  // Kit carries the COMPLETE RAM LOOP, not stat sliders: War Rack IS the loop
  // — built by eating rocks, spent by what it absorbs and rams (there is no
  // release ability; Scattergun was deleted with the old trailing rack) — so
  // the brawler's frame-one identity is a mechanic you build and ride behind.
  // Heavy Winch stays a strong early pool card. (The old kit rule — at least
  // three rankable rows — is satisfied by construction now that every ability
  // is six ranks; a kit is three climbing bars from frame one.)
  // NO INNATE ABILITIES: a spec is its kit and its pool, nothing else. The
  // brawler used to bonk harder than everyone at rank 0 through a spec-DNA
  // floor in shipStats, which meant its signature move was partly invisible —
  // not on any card, not on any bar. The ram is now entirely War Rack's, so
  // every point of it is a rank you can see climbing.
  // KIT ORDER IS RANK CADENCE, NOT A LIST (see ladderScale): kit rows are spaced
  // evenly across the XP spread band by their POSITION, so first-listed ranks
  // soonest and last-listed slowest, and reordering a kit re-times the whole
  // run. Each kit therefore leads with the ability that spec is ABOUT — War
  // Rack builds the prow the brawler fights with, Orbital Sling is the hauler's
  // ring, the Deflector is the scout's signature move — so the identity track
  // is the one whose bar moves fastest.
  // The orders are also SEARCHED, not just authored: the tightest gap between
  // any two kit rank-ups is 100 / 102 / 76 XP here against devtest's floor of
  // 40 (two ranks landing closer than that read as one event and the stagger
  // has failed). The obvious authored orders were much worse — the hauler's
  // longArmTractor-first reading scored 39 and tripped the suite outright.
  { id: 'brawler', name: 'BRAWLER', icon: '※',
    desc: 'Smash, ram, and shatter. Throws hard, flies tanky.',
    start: ['bulwarkRing', 'reinforcedHull', 'kineticSling'] },
  { id: 'hauler', name: 'HAULER', icon: '◎',
    desc: 'Master of the beam — long reach, big hauls, orbit shields.',
    start: ['orbitalSling', 'salvageMagnet', 'longArmTractor'] },
  { id: 'scout', name: 'SCOUT', icon: '◇',
    desc: 'Eyes and speed — sensors, precision, and mobility.',
    start: ['deflector', 'phaseScreen', 'tunedThrusters', 'navPlotter'] },
];

// The named-ability catalog. Each ability has an OWNER spec, `max` ranks (which
// it climbs AUTOMATICALLY off its own XP pool — see abilityRankCost), and a
// `minTier` soft-floor (it can't be OFFERED until you've reached that tier).
// EVERY ABILITY IS SIX RANKS (user design rule). The catalog used to run 1/3/4/6
// and that was three different kinds of card wearing one name: a max-1 row
// arrived already maxed (its bar was decoration and the pick was a switch, not
// a track), and a 3-rank row finished half a run before a 6-rank one. One
// length means one promise — every card you take is a track that climbs all
// run, and the HUD bar under it always means the same thing. The rule has a
// price, and it is paid in shipStats: a row that used to reach its ceiling in
// 3 ranks now takes 6, so its PER-RANK step was halved (4-rank rows x2/3) and
// the ceilings are unchanged. Ranks got finer, not stronger — the one thing
// this must never be is a stealth power pass. The five former unlocks (Retro
// Jets, Gravity Compass, Impact Warning, Twin Grip, Slipstream) were the real
// work: rank 1 does exactly what the unlock always did, and ranks 2-6 deepen
// it, because a rank that changes nothing is the failure mode this whole
// system is built to avoid (see the Nav Plotter note — a flat has-plotter
// boost made its own ranks 2-3 dead).
// An optional `xpMul` scales that ability's whole rank ladder: rows floored at
// a late tier discount it (0.5 at minTier 3, 0.7 at 2) because they're learned
// with only a fraction of the run's XP left to earn — at 1.0 a capstone would
// dead-end one rank short of its max no matter how well you played. Omit it
// (default 1) for anything offered from tier 0. An optional `also: { specId: minTier }` map shares the
// ability with OTHER specs at (usually higher) tier floors — the Scout sensor/
// QoL chain (Retro Jets, Gravity Compass, Nav Plotter, Lead Computer, Impact
// Warning) reaches every spec this way: Scout gets them at tier 0, everyone
// else buys in later. `channel` is the stat bucket it feeds — shipStats sums
// each owned ability's rank into its channel and derives everything from those
// totals, so several abilities can stack the same channel.
// An optional `needs: '<channel>'` is a HARD PREREQUISITE, not a soft floor: the
// ability is not OFFERED at all until you own something feeding that channel
// (prereqMet). It exists for rows that are literally inert on their own —
// Rockwall/Aegis/Recovery Tether all act on ORBIT rocks, and with no
// orbit ability shipStats hands you orbitCap 0 / maxOrbiters 0, so there is
// never a rock for them to act on; Impact Warning marks a spot on the FORECAST
// PATH, and shipStats gates it behind the plotter outright (`hasCrashWarn =
// collisionC > 0 && hasPredict`). Offering one of those was a dead card: it
// spent the pick, its bar started climbing, and nothing whatsoever happened in
// the world. It names a CHANNEL, not an id, so it resolves across specs without
// a per-spec table (the orbit channel is BRAWLER's War Rack and HAULER's
// Orbital Sling alike) — the same reason shipStats reads channels.
// ONE TRACK PER CHANNEL PER SPEC (user design rule). There used to be five
// "second track" rows — Grapple Extenders, Expanded Bay, Overtuned Drive, Bulk
// Freighter, Juggernaut — each a second ability stacking a channel its spec
// already had a row for. They are DELETED, and nothing may replace them: a card
// whose whole promise is "the number you are already raising, again" spends a
// pick without adding a verb, and it made two of the three tier-3 capstone
// slots a stat top-up. Every remaining row owns its channel outright, so the
// pool is shorter and every card in it does something the others don't.
// NAMING LAW (user design rule): two abilities that DO the same thing carry the
// SAME name/icon/desc even across specs — Heavy Winch is the catch starter in
// both BRAWLER and HAULER, Reinforced Hull is the hull track in both (ids stay
// distinct, they're separate catalog rows). With the second tracks gone this is
// now the ONLY reason two rows ever share a name.
// BRAWLER's runtime abilities (War Rack's ram, Cluster Rounds, Shockwave,
// Wall Splat, Berserker, Demolition) are live — their hooks live in physics.js
// (collideShipBody's ram + absorption, brawlerThrowKill) and tractor.js
// (absorbIntoRam, Berserker fling). NOTHING is innate: the brawler's
// ram used to have a spec-DNA floor in shipStats that made it hit harder at
// rank 0 than any other spec, and that is gone — every spec now starts at the
// universal base and differs only by what its kit and pool contain.
// HAULER's: Recovery Tether + Twin Grip + Dead Stop (tractor.js), Aegis
// Reflector (physics collideBodies), Rockwall (physics damageBody hardening +
// tractor orbit spin). SCOUT's: Deflector (the parry state machine in
// physics.js), Afterburner (fuel tank in main.js, thrust + governor in
// physics), Dash Jets (A/D — main.onDash), Reflex Jink (the auto-dodge scan in
// physics.step), Slipstream (main.onWarp), Recon Drone (world.js survey). All
// three specs' runtime abilities are live.
export const ABILITIES = [
  // 🥊 BRAWLER
  { id: 'kineticSling',   spec: 'brawler', name: 'Kinetic Sling',  icon: '➹', channel: 'fling',  max: 6, minTier: 0, weight: 1.0, desc: 'Hurl held rocks harder.' },
  { id: 'reinforcedHull', spec: 'brawler', name: 'Reinforced Hull', icon: '▤', channel: 'hull',  max: 6, minTier: 0, weight: 1.0, desc: 'Raise maximum hull.' },
  // THE RACK IS A RAM, AND IT IS ONE OBJECT. War Rack does not trail ammo and
  // does not fly a formation: RIGHT-CLICK a rock and it is dragged in and
  // CRUSHED, destroyed outright, its mass welded into a single structure on the
  // bow that GROWS with everything you feed it. That structure is the brawler's
  // whole ram — it multiplies what a charge deals, it carries the ship's
  // momentum through a hit instead of bouncing, and it takes head-on damage
  // INSTEAD OF THE HULL until it is used up. Ranks buy how much it can hold.
  // This replaced Ram Prow, deleted along with the innate spec-DNA ram: two
  // abilities and a hidden floor all pushing one pair of numbers meant the
  // brawler's signature was spread across three places, one of them invisible.
  // It is one ability now, and it is a thing you can watch getting bigger.
  // THE RAM CANNOT BE THROWN, FIRED OR DROPPED (user design rule). It is not
  // ammunition and not a held rock — it is a structure you ride behind, spent
  // only by what it absorbs for you. Scattergun, which used to fire the old
  // trailing rack, is DELETED with the rack: a ringless spec has nothing for a
  // volley to launch, and giving the ram a release move would just be the
  // throw wearing a different name.
  { id: 'bulwarkRing',    spec: 'brawler', name: 'War Rack',       icon: '◒', channel: 'orbit',  max: 6, minTier: 0, weight: 1.1, desc: 'RIGHT-CLICK rock to crush it into the ram riding ahead of your bow. It grows as it feeds — hits harder, shrugs off knockback, and eats head-on damage until it is spent.' },
  { id: 'heavyRounds',    spec: 'brawler', name: 'Heavy Winch',    icon: '✦', channel: 'catch',  max: 6, minTier: 0, weight: 1.0, desc: 'Grab and hurl much heavier rocks.' },
  { id: 'warPlating',     spec: 'brawler', name: 'War Plating',    icon: '⛨', channel: 'shield', max: 6, minTier: 0, weight: 0.9, desc: 'A thin front plate that re-forms fast — FRONT ARC ONLY. Your tail stays bare.' },
  { id: 'clusterRounds',  spec: 'brawler', name: 'Cluster Rounds', icon: '❋', channel: 'cluster',    max: 6, minTier: 0, weight: 1.0, desc: 'Your throw-kills burst into grabbable shrapnel.' },
  { id: 'shockwave',      spec: 'brawler', name: 'Shockwave',      icon: '◎', channel: 'shockwave',  max: 6, minTier: 0, weight: 1.0, desc: 'Throw-kills knock nearby bodies back.' },
  { id: 'wallSplat',      spec: 'brawler', name: 'Wall Splat',     icon: '▦', channel: 'wallsplat',  max: 6, minTier: 0, weight: 1.0, desc: 'Smash thrown rocks INTO worlds — splat kills pay bonus XP and shove nearby rocks, primed as yours.' },
  { id: 'berserker',      spec: 'brawler', name: 'Berserker',      icon: '✷', channel: 'berserk',    max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'The lower your hull, the harder you throw and ram.' },
  { id: 'demolition',     spec: 'brawler', name: 'Demolition',     icon: '✸', channel: 'demolition', max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Throw-kills detonate, damaging everything nearby.' },

  // 📡 HAULER
  { id: 'longArmTractor', spec: 'hauler', name: 'Long-Arm Tractor', icon: '⤢', channel: 'reach',  max: 6, minTier: 0, weight: 1.0, desc: 'Extend tractor range and grab forgiveness.' },
  { id: 'salvageMagnet',  spec: 'hauler', name: 'Salvage Magnet',   icon: '⦿', channel: 'magnet', max: 6, minTier: 0, weight: 1.0, desc: 'Vacuum scrap and motes from farther away.' },
  { id: 'orbitalSling',   spec: 'hauler', name: 'Orbital Sling',    icon: '◍', channel: 'orbit',  max: 6, minTier: 0, weight: 1.1, desc: 'Stow rocks into a defensive orbit ring.' },
  { id: 'heavyWinch',     spec: 'hauler', name: 'Heavy Winch',      icon: '✦', channel: 'catch',  max: 6, minTier: 0, weight: 1.0, desc: 'Grab and hurl much heavier rocks.' },
  // HAULER has NO energy shield ON PURPOSE (design law): the orbit rock wall IS
  // its protection — Rockwall/Reinforced Hull harden that identity instead.
  // chMul 2/3: the HAULER's hull track was deliberately SHORTER than the
  // brawler's (max 4 vs 6) — the brawler is the tank, and length was the lever
  // that said so. Six ranks everywhere took that lever away, so the row keeps
  // its ceiling by contributing 2/3 of a rank to the shared `hull` channel
  // instead: 6 x 2/3 = the 4 it always summed to. Scaling the channel's
  // coefficient in shipStats would have nerfed the brawler's own track, which
  // never changed length.
  { id: 'cargoPlating',   spec: 'hauler', name: 'Reinforced Hull',  icon: '▤', channel: 'hull',   max: 6, chMul: 2 / 3, minTier: 0, weight: 0.9, desc: 'Raise maximum hull.' },
  { id: 'rockwall',       spec: 'hauler', name: 'Rockwall',         icon: '⛉', channel: 'rockwall', max: 6, minTier: 0, needs: 'orbit', weight: 1.0, desc: 'Orbit rocks are far tougher and spin faster to block.' },
  { id: 'recoveryTether', spec: 'hauler', name: 'Recovery Tether',  icon: '↩', channel: 'tether', max: 6, minTier: 0, needs: 'orbit', weight: 1.0, desc: 'Your thrown rocks curve back into your orbit.' },
  { id: 'deadStop',       spec: 'hauler', name: 'Dead Stop',        icon: '⊘', channel: 'deadstop', max: 6, minTier: 0, weight: 1.0, desc: 'Catch a rock an alien threw at you to prime it — its next fling flies far harder.' },
  { id: 'aegisReflector', spec: 'hauler', name: 'Aegis Reflector',  icon: '❂', channel: 'aegis',  max: 6, minTier: 3, xpMul: 0.5, needs: 'orbit', weight: 0.9, desc: 'Orbit rocks hurl intercepted enemy fire back.' },
  { id: 'twinGrip',       spec: 'hauler', name: 'Twin Grip',        icon: '⇄', channel: 'twin',   max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Hold and throw two rocks at once. Ranks steady the rig — the second rock rides tighter and drags you around less.' },

  // 🔭 SCOUT
  // ICONS ARE MONOCHROME LINE GLYPHS, never emoji. ⏩ (U+23E9) has emoji
  // PRESENTATION by default, so the OS painted a filled blue rounded square in
  // a list of hairline symbols — it read as a foreign object. The two engine
  // rows escalate on purpose: two arrows tuned, three overtuned.
  { id: 'tunedThrusters', spec: 'scout', name: 'Tuned Thrusters', icon: '⇉', channel: 'engine',    max: 6, minTier: 0, weight: 1.0, desc: 'Faster thrust and a higher speed ceiling.' },
  // The sensor/QoL chain is SHARED (`also`): Scout-native at tier 0, offered to
  // the other specs later — the two flight-feel rows at tier 1, the sensor
  // tracks at tier 2 (below the tier-3 capstone band so they don't crowd it).
  { id: 'retroJets',      spec: 'scout', name: 'Retro Jets',      icon: '◂', channel: 'reverse',   max: 6, minTier: 0, also: { brawler: 1, hauler: 1 }, weight: 1.0, desc: 'Unlock reverse thrust (S). Ranks add braking authority.' },
  { id: 'gravityCompass', spec: 'scout', name: 'Gravity Compass', icon: '✧', channel: 'compass',   max: 6, minTier: 0, also: { brawler: 1, hauler: 1 }, weight: 1.0, desc: 'World-pull chevrons at your ship. Ranks pick up fainter pulls.' },
  { id: 'navPlotter',     spec: 'scout', name: 'Nav Plotter',     icon: '⋯', channel: 'plotter',   max: 6, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.1, desc: 'Your flight-path forecast.' },
  { id: 'impactWarning',  spec: 'scout', name: 'Impact Warning',  icon: '⚠', channel: 'collision', max: 6, minTier: 0, also: { brawler: 2, hauler: 2 }, needs: 'plotter', weight: 1.0, desc: 'Mark where your path will hit (needs the plotter). Ranks forecast farther ahead.' },
  { id: 'leadComputer',   spec: 'scout', name: 'Lead Computer',   icon: '⊕', channel: 'targeting', max: 6, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.0, desc: 'Aim lead-markers for your throws.' },
  // THE PARRY IS THE SCOUT'S, not the brawler's. It was always a precision
  // move — read the incoming rock, take it on the nose, aim the return — which
  // is the scout's whole register, and it sat oddly on a spec whose answer to
  // an incoming rock is now to eat it and wear it. Kit ability, so it ranks
  // from frame one alongside Phase Screen: the scout's defence is timing and a
  // thin wrap, never mass.
  { id: 'deflector',      spec: 'scout', name: 'Deflector',       icon: '⤺', channel: 'deflect',   max: 6, minTier: 0, weight: 1.0, desc: 'A rock striking your NOSE freezes against the hull, then hurls itself wherever your mouse points when the freeze ends. Every rank: +1 rock held, wider catch bubble, longer freeze, harder hurl.' },
  { id: 'deepArray',      spec: 'scout', name: 'Deep Array',      icon: '◈', channel: 'deep',      max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Long-range map and forecast.' },
  { id: 'phaseScreen',    spec: 'scout', name: 'Phase Screen',   icon: '⛨', channel: 'shield',      max: 6, minTier: 0, weight: 0.9, desc: 'A thin full-wrap shield that recharges fast.' },
  // Afterburner is shared to BRAWLER only, and LATE (tier 4 — above even the
  // capstone band): a burning brawler is an endgame reward, and HAULER never
  // gets it (the freighter fantasy is mass, not speed).
  { id: 'afterburner',    spec: 'scout', name: 'Afterburner',    icon: '»', channel: 'afterburner', max: 6, minTier: 0, also: { brawler: 4 }, weight: 1.0, desc: 'Hold SHIFT for a long, hard burn. The tank refills slowly.' },
  { id: 'evasionRoll',    spec: 'scout', name: 'Dash Jets',      icon: '↯', channel: 'evasion',     max: 6, minTier: 0, weight: 1.0, desc: 'Tap A / D to dart sideways (brief i-frames).' },
  { id: 'autoEvade',      spec: 'scout', name: 'Reflex Jink',    icon: '↺', channel: 'autoevade',   max: 6, minTier: 2, xpMul: 0.7, weight: 0.9, desc: 'Auto-dodges an incoming rock at the last instant. Recharges.' },
  { id: 'reconDrone',     spec: 'scout', name: 'Recon Drone',    icon: '✜', channel: 'recon',       max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Auto-charts worlds from much farther out.' },
  { id: 'slipstream',     spec: 'scout', name: 'Slipstream',     icon: '➸', channel: 'slipstream',  max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Tap F to warp forward toward the cursor. Ranks warp farther and recharge sooner.' },
];

export function abilityById(id) { return ABILITIES.find((a) => a.id === id); }
export function specById(id) { return SPECS.find((s) => s.id === id); }

export function newProgress() {
  return {
    xp: 0,
    level: 0,              // total pick-events taken
    tier: 0,               // 0..5 — driven by milestones, NOT capacity
    picksThisTier: 0,      // toward the next tier-up milestone
    spec: null,            // chosen at run start (applySpec seeds the starting kit)
    upgrades: {},          // { abilityId: rank } — empty until a spec is chosen
    abilXp: {},            // { abilityId: xp banked toward its NEXT rank } — growAbilities
    lives: PROG.START_LIVES,
    masterChart: false,    // 100% chart completion (shipStats grants the sensor/forecast bonus)
    maxLivesBonus: 0,      // permanent cap raises (charting the dark star) — read via maxLives()
    // flavor counters (stats only, not read by shipStats)
    catches: 0,
    smashes: 0,
    surveyed: 0,
  };
}

// The lives cap: base PROG cap plus permanent bonuses earned in-run. Every cap
// read goes through here so a bonus can never be forgotten by one call site.
export function maxLives(prog) { return PROG.MAX_LIVES + (prog.maxLivesBonus || 0); }

// ---- XP + pick bookkeeping (pure helpers over game.prog) --------------------

export function xpForPick(prog) {
  return PROG.XP_BASE + PROG.XP_STEP * prog.level + PROG.XP_CURVE * prog.level * prog.level;
}
export function owesPick(prog) { return prog.xp >= xpForPick(prog); }
// THE dense-field XP resolver — every award sourced from a shoal rock goes
// through here, and nothing else may pay one. Two gates, and both are needed:
//   1. XP_FIELD_MUL, a flat damp on what one rock is worth. Uniform across the
//      pocket ON PURPOSE — a monolith is worth breaking for the spectacle and
//      the achievement, not the XP, and exempting the big ones would just move
//      the farm onto them.
//   2. The pocket's own FINITE BUDGET. The multiplier prices a rock; the budget
//      prices the SHOAL, which is the only thing that holds when someone finds
//      a way to destroy a thousand of them at once.
// Returns what may actually be paid (0 once a pocket is worked out) and charges
// the budget for it. Non-field bodies pass through untouched, so a call site can
// wrap every award unconditionally.
export function fieldXp(game, b, xp) {
  if (!b || !b.fieldRock || xp <= 0) return xp;
  const pay = xp * PROG.XP_FIELD_MUL;
  const f = game.fields && b.field != null ? game.fields[b.field] : null;
  if (!f) return pay;                                   // stray shard, no pocket to charge
  if (f.xpLeft == null) f.xpLeft = PROG.FIELD_XP_BUDGET;
  if (f.xpLeft <= 0) return 0;
  const got = Math.min(pay, f.xpLeft);
  f.xpLeft -= got;
  // Announce it ONCE, through the event-flag shape — a payout that silently
  // stops reads as a bug. The rocks keep shattering; only the salvage is gone.
  if (f.xpLeft <= 0 && !f.picked) { f.picked = true; game.fieldDryName = f.name; }
  return got;
}
// EVERY XP award feeds BOTH tracks: the pick purse (prog.xp, spent on the next
// new-ability card) and, in parallel, every owned ability's own rank pool. They
// are separate accumulators — ranking up costs the pick purse nothing, and
// consumePickCost never touches an ability pool.
export function addXp(game, amount) {
  if (amount <= 0 || !game.ship || !game.ship.alive) return;
  game.prog.xp += amount;
  growAbilities(game.prog, amount, game.rankUps);
}

// ---- automatic ability ranks ----------------------------------------------
// The XP an ability needs to climb from `rank` to `rank+1` — its OWN threshold,
// rising with every rank it has already taken. The ability's whole ladder (rank
// 1 -> max) gets a budget of ABIL_XP_TOTAL x its xpMul x a track-length factor
// (see ABIL_XP_SHORT — a 3-rank track must not be priced like a 6-rank one),
// split across its (max - 1) steps by the ABIL_XP_GROWTH weights. Memoized:
// this runs per owned ability on every single XP award, over pure catalog data.
// FNV-1a over a key, mapped to 0..1. Deliberately NOT util.seedFrom: config is
// the root leaf and imports nothing, and this must stay that way. Used only for
// the ability-cost stagger — a HASH, not an RNG, because the HUD reads these
// costs every frame to draw the bars and Math.random would make them shiver.
function hash01(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1e6) / 1e6;
}
const signed = (key) => hash01(key) * 2 - 1;   // -1..1

// KIT SPACING — the ladder scale for one ability, in 1 +- ABIL_XP_SPREAD.
// A hash is luck, and luck stopped being good enough when every ability became
// six ranks: a starting kit now fires 15-20 rank-ups in a run instead of 9-13,
// and the three or four bars that start TOGETHER crowd hardest at rank 1, where
// every 6-rank track costs about the same. No (spread, wobble) pair could open
// that up — searched over the whole grid, the best tightest kit gap was 18 XP
// against the old catalog's 52. So kit rows are SPACED EVENLY across the spread
// band by their position in the kit: separation by construction rather than by
// luck, and proportional, so it holds at every rank rather than just the first.
// A kit's authored ORDER is therefore its rank cadence — first listed ranks
// soonest, last listed slowest — and reordering a kit re-times it.
// Everything learned from a CARD keeps the hash: those pools are never equal in
// the first place, since no two cards are taken at the same instant.
let kitSpread = null;
function ladderScale(a) {
  if (!kitSpread) {
    kitSpread = new Map();
    for (const s of SPECS) {
      const n = s.start.length;
      s.start.forEach((id, i) => kitSpread.set(id, n > 1 ? (2 * i) / (n - 1) - 1 : 0));
    }
  }
  const slot = kitSpread.get(a.id);
  return 1 + PROG.ABIL_XP_SPREAD * (slot !== undefined ? slot : signed(a.id));
}

const rankCostCache = new Map();
let longestTrack = 0;
export function abilityRankCost(a, rank) {
  if (!a || !(a.max > 1) || !(rank >= 1) || rank >= a.max) return Infinity;
  const key = `${a.id}:${rank}`;
  let cost = rankCostCache.get(key);
  if (cost === undefined) {
    if (!longestTrack) for (const x of ABILITIES) longestTrack = Math.max(longestTrack, x.max);
    const steps = a.max - 1;
    let sum = 0;
    for (let i = 0; i < steps; i++) sum += 1 + PROG.ABIL_XP_GROWTH * i;
    const lenF = PROG.ABIL_XP_SHORT
      + (1 - PROG.ABIL_XP_SHORT) * (steps / Math.max(1, longestTrack - 1));
    const w = 1 + PROG.ABIL_XP_GROWTH * (rank - 1);
    // Stagger (ABIL_XP_SPREAD / _WOBBLE): a per-ability ladder scale (spaced by
    // kit position for a starting kit, hashed for everything else — see
    // ladderScale) plus a per-rank nudge, so no two tracks cross a threshold
    // together.
    const spread = ladderScale(a);
    const wobble = 1 + PROG.ABIL_XP_WOBBLE * signed(key);
    cost = Math.round(PROG.ABIL_XP_TOTAL * (a.xpMul || 1) * lenF * w / sum * spread * wobble);
    rankCostCache.set(key, cost);
  }
  return cost;
}
// Pour `amount` XP into every owned ability's pool and cash in any thresholds
// crossed. Pushes { id, name, rank } onto `out` (game.rankUps) for each rank
// landed — main.js drains that into the message/sfx/hull-heal pass, the same
// event-flag shape the rest of the sim uses. The while loop handles a single
// fat award crossing two thresholds at once; the queue is capped so an undrained
// list (splash frames) can't grow without bound.
export function growAbilities(prog, amount, out) {
  if (!(amount > 0) || !prog || !prog.upgrades) return;
  const bank = prog.abilXp || (prog.abilXp = {});
  for (const id of Object.keys(prog.upgrades)) {
    const a = abilityById(id);
    let rank = prog.upgrades[id];
    if (!a || !(a.max > 1) || !(rank > 0) || rank >= a.max) continue;
    let pool = (bank[id] || 0) + amount;
    let cost = abilityRankCost(a, rank);
    while (rank < a.max && pool >= cost) {
      pool -= cost;
      rank++;
      if (out && out.length < 16) out.push({ id, name: a.name, rank });
      cost = abilityRankCost(a, rank);
    }
    prog.upgrades[id] = rank;
    // A maxed track banks nothing — its bar reads FULL, not a stalled fraction.
    bank[id] = rank >= a.max ? 0 : pool;
  }
}
// The next owed pick is a tier-up milestone once enough picks are banked in
// this tier (until the top tier, after which it's plain picks forever).
export function pickIsMilestone(prog) {
  return prog.tier < TIERS.caps.length - 1 && prog.picksThisTier >= PROG.PICKS_PER_TIER;
}
export function consumePickCost(prog) {
  prog.xp = Math.max(0, prog.xp - xpForPick(prog));
  prog.level++;
}
// Learn an ability (or add a rank to one, capped at its max). New abilities come
// in at rank 1 with an EMPTY xp pool — its bar starts at zero and fills from the
// next award, so a late pick is visibly a fresh track, not a half-earned one.
export function applyAbility(prog, id) {
  const a = abilityById(id);
  if (!a) return;
  const cur = prog.upgrades[id] || 0;
  if (cur < a.max) prog.upgrades[id] = cur + 1;
  if (!cur) (prog.abilXp || (prog.abilXp = {}))[id] = 0;
}
// Run start: lock in the spec and grant its starting kit at rank 1.
export function applySpec(prog, id) {
  const s = specById(id);
  if (!s) return;
  prog.spec = id;
  const bank = prog.abilXp || (prog.abilXp = {});
  for (const aid of s.start) {
    prog.upgrades[aid] = Math.max(1, prog.upgrades[aid] || 0);
    if (bank[aid] == null) bank[aid] = 0;
  }
}
// TIER-UP: the tier bump, and the pick counter resets for the new tier. It does
// NOT rank your build up any more — that used to be the tier "dividend", and it
// double-counts now that ranks come from XP continuously (a kit ability would
// hit its max on tier-ups alone, making its own xp bar decorative). The tier's
// power spike is the NEW ability main.js grants right after this, plus the life.
export function applyTierUp(prog) {
  prog.tier = Math.min(TIERS.caps.length - 1, prog.tier + 1);
  prog.picksThisTier = 0;
}

// One weighted, no-replacement draw from a bag of { u, w }: roulette-wheel on
// total weight, splice the winner out, return its upgrade. Runtime randomness
// (Math.random) is intentional per the determinism rules.
function drawWeighted(bag) {
  let total = 0; for (const e of bag) total += e.w;
  let r = Math.random() * total, idx = 0;
  for (; idx < bag.length - 1; idx++) { r -= bag[idx].w; if (r <= 0) break; }
  return bag.splice(idx, 1)[0].u;
}

// The tier floor for an ability under a given spec: the OWNER spec uses
// `minTier`; a spec listed in `also` uses its own (usually higher) floor;
// any other spec can never be offered it.
export function tierFloorFor(a, spec) {
  if (a.spec === spec) return a.minTier || 0;
  if (a.also && a.also[spec] != null) return a.also[spec];
  return Infinity;
}
// PREREQUISITES: a row carrying `needs` is only offerable once you OWN an
// ability feeding that channel (see the `needs` note on the catalog) — the
// rows that do nothing at all on their own. It's a plain scan of the owned
// upgrades rather than a shipStats call: this runs inside the card draw, and
// shipStats derives the whole stat block. Rank 0 doesn't count as owned
// anywhere else, so it doesn't here either.
export function prereqMet(a, prog) {
  if (!a.needs) return true;
  const u = prog.upgrades || {};
  for (const x of ABILITIES) if (x.channel === a.needs && u[x.id] > 0) return true;
  return false;
}
// UPGRADE CARDS: `n` random NEW abilities from your offer pool (your spec's own
// rows + shared `also` rows) that you don't own yet, whose tier floor has been
// reached, and whose prerequisite channel (if any) you already own. Weighted,
// no-replacement. This is the ONLY card draw — a pick
// is always "learn something new" now, at the milestone and between them alike;
// deepening what you own is the automatic track (growAbilities), never a card.
// (There used to be a second draw, rankChoices, for the between-tier picks.)
export function tierChoices(prog, n = 2) {
  const bag = ABILITIES
    .filter((a) => !(prog.upgrades[a.id] > 0) && prog.tier >= tierFloorFor(a, prog.spec)
      && prereqMet(a, prog))
    .map((a) => ({ u: a, w: a.weight || 1 }));
  const chosen = [];
  while (chosen.length < n && bag.length) chosen.push(drawWeighted(bag));
  return chosen;
}

// Derived ship stats. The UNIVERSAL BASE (tier-scaled) is the old tier-0..5
// baseline — the core grab/throw/fly loop that EVERY spec has from frame one.
// Owned ABILITIES then add on top: each ability's rank is summed into its
// `channel`, and the stats below read those channel totals. The st field names
// are unchanged, so every consumer (render/physics/tractor/hud) is untouched.
export function shipStats(prog) {
  const tier = prog.tier;
  const u = prog.upgrades || {};
  // Sum owned ability ranks into their channels. An optional `chMul` lets one
  // ROW count for less than a whole rank — how a track holds its old ceiling
  // when its LENGTH is fixed at six but its channel is shared with a longer
  // track in another spec (cargoPlating; see its catalog note). Channel totals
  // are therefore not necessarily integers — anything downstream that needs a
  // count of things (maxOrbiters) rounds for itself.
  const ch = {};
  for (const a of ABILITIES) {
    const rk = u[a.id] || 0;
    if (rk > 0) ch[a.channel] = (ch[a.channel] || 0) + rk * (a.chMul || 1);
  }
  const c = (k) => ch[k] || 0;

  const catchC = c('catch'), reachC = c('reach'), engineC = c('engine'), flingC = c('fling'),
    hullC = c('hull'), shieldC = c('shield'), magnetC = c('magnet'),
    orbitLvl = c('orbit'), volC = c('volley');
  // BRAWLER runtime channels (all 1:1). There is no `ram` channel any more —
  // the ram is the FUSED PROW, so it rides the `orbit` channel (War Rack) and
  // is derived from what you have actually crushed onto the nose at runtime.
  const berserkC = c('berserk'), clusterC = c('cluster'),
    shockC = c('shockwave'), demoC = c('demolition'), wallsplatC = c('wallsplat');
  // SCOUT: the parry (Deflector moved here from BRAWLER).
  const deflectC = c('deflect');
  // HAULER runtime channels.
  const tetherC = c('tether'), aegisC = c('aegis'), twinC = c('twin'),
    rockwallC = c('rockwall'), deadstopC = c('deadstop');
  // SCOUT runtime channels.
  const afterburnerC = c('afterburner'), evasionC = c('evasion'), reconC = c('recon'),
    slipC = c('slipstream'), autoevadeC = c('autoevade');
  // Sensor chain — each is its own ability/channel (Scout-owned, shared to the
  // other specs via `also`); reads spec-agnostically, so whoever owns it gets it.
  const compassC = c('compass'), plotterC = c('plotter'), collisionC = c('collision'),
    targetingC = c('targeting'), deepC = c('deep');
  const hasCompass = compassC > 0, hasPredict = plotterC > 0, hasTargeting = targetingC > 0,
    hasDeepSensors = deepC > 0, hasCrashWarn = collisionC > 0 && hasPredict;

  // SIX-RANK RESCALE (read this before tuning any coefficient below). Every
  // ability is six ranks now; the tracks that used to be 3 or 4 kept their old
  // CEILING and had their per-rank step divided by the same factor their length
  // was multiplied by (3 -> 6 halves the step, 4 -> 6 takes two thirds). So a
  // maxed build is exactly as strong as it was and the ladder to it is just
  // finer. Channels stacked by two abilities (ram = Ram Prow + Juggernaut,
  // orbit = Sling + Bay) are scaled against the SUMMED old ceiling, not one
  // row's. Anything that reads a channel and was already six ranks (catch,
  // reach, engine, fling, magnet, hull, deflect, brawler shield) is untouched.
  // CATCH RANKS BUY MASS INSIDE YOUR CLASS, NEVER THE CLASS ABOVE (see the
  // TIERS block for the ladder and for the 3.64x rank multiplier this replaced).
  // The fill is asymptotic on purpose: it approaches the tier's own ceiling
  // without ever touching it, so no amount of stacking can round its way into
  // the rung above, and the last ranks still buy something rather than dead-
  // ending against a hard clamp. Heavy Winch's 6 ranks are now the DEEPEST
  // catch channel in the game (Bulk Freighter, the second track that used to
  // stack to 12, is deleted) and reach ~70% of the gap.
  const catchFill = 1 - Math.pow(0.82, catchC);
  const capacity = TIERS.caps[tier] + (TIERS.ceil[tier] - TIERS.caps[tier]) * catchFill;
  // Hull is the HULL channel alone. Ram Prow / Juggernaut used to add 17.5 a
  // rank on top (+210 at the top of a 12-rank ram channel), which is gone with
  // them: the brawler's toughness is Reinforced Hull plus what the fused prow
  // soaks for it, and neither is a hidden term in a number the HUD prints.
  const maxHull = 120 + 40 * tier + 55 * hullC;
  // The regenerating shield is an UPGRADE, and its SHAPE is spec DNA (design
  // law): no shield ability -> shieldFrac 0 -> shieldMax 0 -> no shield, no SHLD
  // bar. It trades max hull for a recharging layer; only the shield regens.
  // BRAWLER (War Plating) is a SMALL, FAST-RE-FORMING FRONT PLATE — shieldArc is
  // the half-angle around the nose, and hits from behind skip it entirely
  // (physics.damageShip). It used to carve a BIG slice of the pool (38% -> 65%),
  // which made it simply the best shield in the game: converting most of a
  // brawler's health into a regenerating layer meant the front-arc drawback
  // never cost anything, because the pool was deep enough to never run out
  // while you were facing the right way. Its identity is the CYCLE, not the
  // capacity: a thin plate that soaks one hit and is back almost immediately
  // (regenDelay below), which rewards a ship built to keep its nose on the
  // threat. SCOUT (Phase Screen) is a thin FULL WRAP that also recharges fast —
  // forgiving of any angle, which is what a scout needs. HAULER has no shield
  // ability at all; the orbit rock wall is its protection.
  let shieldFrac = 0, shieldArc = Math.PI;
  if (shieldC > 0) {
    if (prog.spec === 'brawler') {
      shieldFrac = Math.min(0.26, 0.12 + 0.028 * (shieldC - 1));
      // Coverage is `shieldArc / PI` — the fraction of all bearings the plate
      // covers, and the exact share it soaks from DIRECTIONLESS damage (heat,
      // gas crush, Oort grind) in physics.damageShip. Deliberately well UNDER
      // half: at a clean 50% the plate covered everything ahead of the beam, so
      // "front arc only" was barely a drawback in practice — anything you were
      // flying toward was covered. 35% is a genuinely NARROW nose plate (±63°):
      // you have to point at the thing that is hurting you, glancing threats
      // get through, and an all-over effect is soaked by only about a third.
      // Render clips the shield visual to this same wedge.
      shieldArc = Math.PI * 0.35;
    } else {
      // Phase Screen went 3 -> 6 ranks, so its step halved: still 0.16 at rank
      // 1 and 0.26 at the top, reached over five smaller steps.
      shieldFrac = Math.min(0.28, 0.16 + 0.02 * (shieldC - 1));
    }
  }
  const hullMax = Math.round(maxHull * (1 - shieldFrac));

  // Stow: ONE CLASS BELOW THE BEAM, unlocked by an orbit ability. It is the
  // same two-part gate the beam runs (config.canStow) — a class rung plus a
  // mass allowance inside it — so a rock you can hold is not automatically a
  // rock you can stow. The FORMATION is spec DNA like the shield: HAULER's stow
  // orbits and protects; BRAWLER's is CRUSHED INTO THE RAM (frontRam).
  // THE RAM'S ROCK CLASS CLIMBS WITH WAR RACK'S OWN RANK (user design rule:
  // "the tiers allow the max amount of debris to go up, plus larger rocks") —
  // ranks 1-2 eat belt rock, 3+ boulders — AND IT HARD-STOPS AT BOULDER CLASS
  // (user design rule: "never moons or any large objects in the ram"). No
  // rank and no beam tier ever opens a moon rung here: the ram is debris
  // crushed into a wall, and a moon on the nose would be a different (and
  // sillier) machine. The ladder still sits inside the beam's own
  // one-class-below gate, so early tiers can promise nothing the beam
  // hasn't earned.
  const frontRam = prog.spec === 'brawler';
  // Floored at 0, not at tier-1: a tier-0 beam still has a class to stow FROM,
  // and an orbit ability that granted nothing until the first tier-up would be
  // a dead card in two of the three starting kits.
  let orbitTier = orbitLvl > 0 ? Math.max(0, tier - 1) : -1;
  if (frontRam && orbitTier >= 0) {
    orbitTier = Math.min(orbitTier, orbitLvl <= 2 ? 1 : 2);
  }
  const orbitCap = orbitTier >= 0 ? Math.min(capacity * 0.55, TIERS.ceil[orbitTier]) : 0;
  const orbitLabel = orbitTier >= 0 ? TIERS.labels[orbitTier] : 'Nothing yet';
  // THE RAM'S TOTAL. Absorbed rock is DESTROYED and banked here as one number
  // (tractor.absorbIntoRam -> ship.ram), so a brawler never puts anything into
  // game.orbit at all — maxOrbiters is hard 0 for this spec below, which is what
  // stops the ring code and the ram code both thinking they own the stow.
  const ramCap = frontRam && orbitLvl > 0
    ? CFG.RAM_CAP_PER_RANK * orbitLvl * (0.6 + 0.14 * tier) : 0;

  // totalLevel feeds ENEMY scaling (ai.js) and SHIP MASS (physics.js). Keep it in
  // the old ~0..25 band so combat/physics balance is preserved: it's just the sum
  // of every owned ability rank (each channel total), weighted.
  // THE WEIGHT MOVED WITH THE SIX-RANK PASS (0.6 -> 0.48), and it had to. This
  // is a POWER PROXY, and the pass deliberately left power alone — it cut every
  // shortened track's per-rank step in half — while the rank COUNT it reads
  // inflated by ~1.4x (a 3-rank track that used to sit maxed and idle now keeps
  // climbing). At the old weight the proxy read a ship that hadn't got stronger
  // as several levels stronger, and pointed tougher enemies and a heavier hull
  // at it: measured mid-run, a tier-2 scout went from level 16 to 23. 0.48 is
  // fitted against the OLD trajectory at matched XP across all three specs
  // (within a level at every tier boundary). Re-fit it if track lengths move again.
  const rankSum = Object.values(ch).reduce((s, v) => s + v, 0);
  const totalLevel = Math.min(25, tier * 2 + Math.round(rankSum * 0.48));

  return {
    capacity,
    tier,
    label: TIERS.labels[tier],
    shipName: SHIP_NAMES[tier],
    // Beam-reach base is sized against SHIP_ZOOM so the ring stays on-screen at
    // every tier; reach abilities + the orbit ring extend it.
    range: [160, 223, 308, 451, 538, 630][tier] + 40 * reachC + 20 * orbitLvl,
    grabSlack: 70 + 22 * reachC,
    // Beam FORCE (newtons, not acceleration): tractor.springHeld divides by the
    // load's mass, so this scaling with `capacity` is what keeps a max-weight
    // load feeling roughly the same at every tier. What makes a heavy load feel
    // heavy is layered on top of it per-body — CFG.TRACTOR_HEFT and the
    // spool-up, both in springHeld.
    force: capacity * 55 * (0.6 + 0.12 * tier),
    maxSpeed: 280 + 40 * tier + 80 * engineC,
    thrust: 180 + 30 * tier + 95 * engineC,
    // 150 -> 50 per Kinetic Sling rank (user call, 2026-08: "Kinetic Sling gets
    // too high, it should max out at around 1,000"): the old slope put a T5
    // Sling-6 launch at ~1,605 before the tether/Berserker multipliers even
    // stacked, and on the quadratic damage law that one channel dwarfed every
    // other lever. Ceiling is now T5+6 ranks = 1,005. Rank value drops with it
    // (+50 speed each) — that is the point, not a dead-card bug; on v^2 each
    // rank is still ~+15% damage at the ceiling.
    fling: 430 + 55 * tier + 50 * flingC,
    maxHull: Math.round(maxHull),
    // Pool splits hull (mends only at glow pockets) / shield (recharges)
    hullMax,
    shieldMax: Math.round(maxHull) - hullMax,
    // Stow is LOCKED until an orbit ability (rank 0 -> no slots); see the
    // frontRam/boulder-cap derivation above for the brawler differences.
    // orbitTier is the CLASS rung (-1 = locked), orbitCap the mass allowance
    // inside it — config.canStow is the pair, and every stow test uses it.
    orbitCap,
    orbitTier,
    orbitLabel,
    // BRAWLER: the stow is CRUSHED INTO A RAM instead of orbiting. Absorbed rock
    // is destroyed on contact with the beam and banked as `ship.ram` mass
    // (tractor.absorbIntoRam); physics.collideShipBody swings it, spends it on
    // damage, and reads its size back through config.ramRadius.
    frontRam,
    ramCap,
    // Damage DEALT, at a full ram. SUPER-LINEAR in rank on purpose (user design
    // rule: "especially at rank 6 the ram needs to be way stronger") — the old
    // linear ladder was fitted to the deleted Ram Prow + Juggernaut ceiling
    // (2.62x at 6), which priced rank 6 as a stat bump when it is actually the
    // capstone of the spec's whole identity. The square term keeps ranks 1-2
    // near the old curve (0.86x / 1.28x bonus at full) and runs away at the
    // top: rank 6 is 1 + 1.5 + 2.16 = 4.66x bonus, ~5.7x total dealt — and the
    // ram's mass ALSO rides the ship's effective mass now (main.js /
    // collideShipBody), so a loaded rank-6 charge hits harder still.
    // Physics still scales all of it by how full the ram actually is: an
    // empty-nosed brawler deals exactly what any other spec does.
    ramBiteMax: 0.30 + 0.25 * orbitLvl + 0.06 * orbitLvl * orbitLvl,
    // 1/2/3/5/6/7 ring slots, capped at 7 — and HARD 0 for the brawler, which
    // has no ring at all any more: its stow is the ram, and a spec that could
    // fill both would be carrying two stows off one ability.
    maxOrbiters: frontRam ? 0
      : orbitLvl > 0 ? Math.min(7, 1 + Math.round((orbitLvl - 1) * 1.2)) : 0,
    orbitLvl,
    // Kept for render (engine-flare size, chart-length) — indexed like the old levels
    levels: { beam: tier, orbit: orbitLvl, fling: flingC, hull: hullC, thrust: engineC, chart: deepC },
    // ---- ability gates (Scout sensor chain + shared unlocks) ----
    // RETRO JETS was a max-1 unlock; at six ranks rank 1 is still exactly the
    // old unlock (full reverse) and the ranks buy braking AUTHORITY on top —
    // growing the ability can only ever help, so nobody's flight feel is worse
    // than it was for having the same ability.
    hasReverse: c('reverse') > 0,
    reversePower: c('reverse') > 0 ? 1 + 0.1 * (c('reverse') - 1) : 0,   // x reverse thrust
    hasTargeting,
    targetLvl: targetingC,
    targetReach: 0.6 + 0.125 * targetingC,  // x LOCK_T, when targeting is on
    targetMarkers: 2 + targetingC,          // how many ✕ markers show (2 -> 8)
    hasPredict,
    predictLvl: plotterC,
    hasCrashWarn,
    hasCompass,
    compassLvl: compassC,
    // GRAVITY COMPASS was a max-1 unlock too. Rank 1 keeps the old 1.2 floor
    // (below it the pull is too faint to point at anything useful); ranks lower
    // it toward 0.6, so a ranked compass keeps reading out in the quiet places
    // between lanes where an unranked one just goes blank.
    compassFloor: compassC > 0 ? 1.2 / (1 + 0.2 * (compassC - 1)) : Infinity,
    // NOTE: nothing feeds the volley channel any more — Scattergun was deleted
    // with the brawler's trailing rack (the ram cannot be fired). The stats and
    // main.js's fireVolley path are kept wired because they are the ring's
    // launch machinery and the mechanics suite exercises them directly, but in
    // play hasVolley is false for every reachable build.
    hasVolley: volC > 0,
    volleyLvl: volC,
    // Shield RANK, not just the pool. achievements.js needs it: Phase Screen is
    // in SCOUT's starting kit, so "you have a shield" is frame-one true for a
    // whole spec and can only be asked about as a rank (see unlockDeflect).
    shieldLvl: shieldC,
    // SCATTERGUN's ranks used to be dead weight — hasVolley was the only thing
    // anything read, so rank 2 and 3 bought nothing at all. Six ranks made that
    // untenable: the pellets now leave harder and in a tighter cone.
    volleySpeed: volC > 0 ? 1 + 0.05 * (volC - 1) : 1,
    volleySpread: 0.07 * (volC > 0 ? 1 - 0.06 * (volC - 1) : 1),
    // ---- BRAWLER runtime abilities (read by physics/tractor) ----
    // NO INNATE RAM. These are the UNIVERSAL BASE, identical for every spec: a
    // bare-nosed brawler rams exactly as hard as a scout does. The whole ram
    // comes from the STRUCTURE it has built on its bow, which physics applies on
    // top of these via ramBiteMax and ship.ram (see collideShipBody). It used to
    // be a spec-DNA floor of 1.35 / 0.85 that no card, bar or readout ever
    // showed — power the player owned and could not see.
    ramMul: 1,      // ram damage DEALT to bodies (base; the ram multiplies it)
    ramArmor: 1,    // impact damage TAKEN (base; the ram absorbs ahead of it)
    berserk: berserkC,                            // fling/ram scale up as hull drops (runtime hull read)
    cluster: clusterC,                            // shrapnel shards spawned on a throw-kill
    shockwave: shockC,                            // knockback impulse on a throw-kill
    demolition: demoC,                            // AoE damage on a throw-kill
    wallSplat: wallsplatC,                        // Wall Splat: kills AGAINST a world blast nearby rocks
    // DEFLECTOR (the parry, brawler kit): rocks closing on the NOSE freeze on
    // contact for the window, then launch along ship→cursor when it runs out
    // (physics.updateParry owns the whole flow: scan, pin, aim, launch).
    // Rank 1 catches at the HULL — the rock must actually hit you
    // (user design rule: no catching out in space) — and each of the SIX
    // ranks widens the catch bubble, adds a slot (cap = rank, so a maxed
    // deflector freezes a six-rock volley), lengthens the freeze, and hardens
    // the hurl; the cooldown is fixed. Per-rank growth is sized for the long
    // track — rank 6 tops out near the old 3-rank ceiling. The base window is
    // long on purpose: it is the aiming time, so it can't be short.
    deflect: deflectC,
    deflectWindow: deflectC > 0 ? 0.5 + 0.09 * (deflectC - 1) : 0,
    deflectPower: deflectC > 0 ? 520 + 80 * (deflectC - 1) : 0,
    deflectReach: deflectC > 0 ? 6 + 11 * (deflectC - 1) : 0,   // catch margin beyond the hull (world units)
    // Shield coverage half-angle around the nose (PI = full wrap). Brawler's
    // front-arc plating sets PI/2; physics.damageShip + render both read it.
    shieldArc,
    // ---- HAULER runtime abilities ----
    tether: tetherC,                              // Recovery Tether: thrown rocks home back to orbit
    aegis: aegisC,                                // Aegis Reflector: orbit rocks reflect intercepted fire
    twinGrip: twinC > 0,                          // Twin Grip: hold two rocks
    maxHeld: twinC > 0 ? 2 : 1,
    twinLvl: twinC,
    // TWIN GRIP was a max-1 unlock; its ranks steady the RIG rather than adding
    // a third hand (held/held2 is the whole plumbing, and a third rock would be
    // a mechanic, not a rank). The flanking rock is sprung with more force, and
    // the per-rock tug on the ship falls. Note the tug only ever goes DOWN: the
    // no-recoil design law caps the COMBINED tug at 150, which is why the twin
    // hold halves it to 75 in the first place — ranks may not claw that back.
    twinHold: twinC > 0 ? 1 + 0.14 * (twinC - 1) : 1,   // x hold force on the second rock
    twinTug: twinC > 0 ? 1 - 0.06 * (twinC - 1) : 1,    // x the halved per-rock tug cap
    rockwall: rockwallC,                          // Rockwall: hardened, faster-spinning orbit rocks
    deadStop: deadstopC,                          // Dead Stop: caught alien throws prime for a harder fling
    // ---- SCOUT runtime abilities ----
    afterburner: afterburnerC,                    // hold Shift: fuel-tank overdrive (main.js drains, physics burns)
    burnTime: 3.5 + 0.75 * afterburnerC,          // seconds a FULL tank burns for (4.25 -> 8)
    burnRefill: 1 / (55 - 5 * afterburnerC),      // tank/s while idle — a slow 50s -> 25s refill
    evasion: evasionC,                            // tap A/D: sideways dash burst + i-frames (main.onDash)
    autoEvade: autoevadeC,                        // Reflex Jink: auto-dodge scan (physics.step)
    recon: reconC,                                // Recon Drone: auto-survey reach (world.js)
    // SLIPSTREAM was a max-1 unlock. Rank 1 is the old warp exactly (950u, 3.5s
    // cooldown, 0.5s of invulnerability at the exit); ranks push it out to
    // 1300u on a 2.5s cycle. main.onWarp reads these instead of literals.
    slipstream: slipC > 0,                        // tap F: short warp (main.onWarp)
    slipLvl: slipC,
    warpDist: slipC > 0 ? 950 + 70 * (slipC - 1) : 0,
    warpCool: slipC > 0 ? 3.5 - 0.2 * (slipC - 1) : 0,
    warpInvuln: slipC > 0 ? 0.5 + 0.05 * (slipC - 1) : 0,
    // ---- scaled passives ----
    magnet: CFG.PICKUP_MAGNET * (1 + 0.4 * magnetC),
    // Deep Array widens the map reveal; MASTER CHART (knowing the whole sky)
    // sharpens it further — the completionist reward reads through the same
    // stat every consumer already uses.
    sensorMul: (1 + 0.15 * deepC) * (prog.masterChart ? 1.25 : 1),
    // RECHARGE IS SPEC DNA, like the shield's shape above. Both shields are thin
    // now, so the CYCLE is what separates them: BRAWLER's plate is the quickest
    // to re-form of anything in the game (a ~1.75s lull and the nose is covered
    // again) because that is the whole point of a small front plate on a ship
    // built to keep charging; SCOUT's wrap is a touch slower to return but
    // covers every angle. HAULER keeps the base rate — it has no shield anyway.
    regen: CFG.SHIP_REGEN * (prog.spec === 'scout' ? 1.6 : prog.spec === 'brawler' ? 1.5 : 1),
    regenDelay: CFG.SHIP_REGEN_DELAY
      * (prog.spec === 'scout' ? 0.6 : prog.spec === 'brawler' ? 0.35 : 1),
    // Forecast horizon: Nav Plotter ranks widen it, Deep Array widens it further.
    // (Ranks must feed a real effect — a flat has-plotter boost made rank 2-3 dead.)
    // MASTER CHART adds a flat +0.2: a fully-logged sky forecasts farther.
    // IMPACT WARNING joins them here, and this is what its own ranks buy: it was
    // a max-1 unlock whose only job was drawing the ✕ where the path already
    // ended, so at six ranks it had nothing to deepen. Now each rank pushes the
    // forecast a little farther out, which is the same thing as seeing the
    // crash sooner — the warning IS the horizon. Small (0.05/rank vs the
    // plotter's 0.09) because the plotter is the ability that owns the path.
    predictBoost: 1 + 0.09 * plotterC + 0.075 * deepC + 0.05 * collisionC
      + (prog.masterChart ? 0.2 : 0),
    // Size/zoom are tier-driven ONLY (see the SHIP_RADIUS/SHIP_ZOOM comments)
    radius: SHIP_RADIUS[tier],
    // What the ship WEIGHS, for anything that resolves by mass ratio — today
    // the taut tether (tractor.springHeld). main.js copies it onto game.ship
    // beside the radius, so `s.mass` stays the single authoritative read.
    shipMass: SHIP_MASS[tier],
    zoomOut: 1.15 / SHIP_ZOOM[tier],
    totalLevel,
  };
}

// The ADVERTISED span of each headline stat, for the HUD's SHIP SYSTEMS
// gauges: [tier-0 base, all-in ceiling]. The ceiling is tier 5 plus a maxed
// six-rank channel (reach also counts the stacked 12-rank orbit channel's
// +20/rank). These are shipStats' own formulas evaluated at their two ends and
// nothing else — KEEP THEM IN STEP with the expressions above, or a gauge's
// pin sits past its rail: the mirror-drift trap (dockDomeR's law), applied to
// a readout. They live HERE, beside the formulas, for exactly that reason.
// The afterburner's two envelope multipliers, at a given afterburner channel
// rank. ONE source on purpose: physics.step applies them while burning, and
// the HUD's dial and thrust ring SCALE themselves by them (each gauge tops
// out at what THIS ship can actually do under full burn) — two copies of
// these expressions is the mirror-drift trap.
// burnCap's RANK-1 value is untouched (1.475 — a hard, near-50% burn from
// the moment you own it), but the per-rank step above that was too steep: a
// maxed (rank 6) tank more than DOUBLED sustained speed (×2.1), which read
// as too high (user call). The ceiling is pulled back to ×1.8 — still a
// real, ship-defining burn, not a mild nudge — by shrinking only the growth
// PAST rank 1 (0.125/rank -> 0.065/rank); the early game is unchanged.
// (History: flat 1.35 + 0.125·ab, rank1 1.475 -> rank6 2.1.)
export const burnCap = (ab) => 1.475 + 0.065 * (ab - 1);   // × maxSpeed while burning
export const burnThrust = (ab) => 1.75 + 0.175 * ab;        // × thrust while burning
