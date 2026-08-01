// All gameplay tuning lives here.
export const CFG = {
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
  // the 20-sim-minute idle soak (seed 20260721): 21/21 planets, 48/48 moons,
  // zero loose planets, zero NaN — the same fingerprint as 1/120, because the
  // celestials ride precomputed rails and never integrate at all. It is NOT the
  // default anyway: a coarser step doubles how far a fast body moves between
  // collision tests, so it is the deal you strike only when the alternative is
  // a 15 fps death spiral.
  DT_COARSE: 1 / 60,
  // ...and it is DISARMED until the collision narrow phase can survive it.
  // MEASURED, 220 randomized trials per cell (impact parameter AND sample phase
  // both randomized — a fixed start distance measures one lucky alignment, not
  // the expected rate), fraction of impacts that register against the ship:
  //
  //   closing   400    800   1300   1800   2500
  //   1/120     99%    97%    92%    86%    77%
  //   1/60      79%    90%    70%    52%    38%
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
  // TO RE-ARM: add a swept segment-vs-disc pre-test to collideShipBody and
  // collideAlienBody (ship + aliens only — a handful of entities, NOT the
  // ~8000-body sweep, where tunnelling is off-view and cosmetic), re-run the
  // table above, then flip this to true. It should also lift the 1/120 row.
  PACE_COARSE_ENABLED: false,
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
  // room is the OUTER BAND (~37k-46k): three new planet lanes (world.js
  // layout, stopping at 42600 — the rogue spawn ring needs clearance above
  // the outermost lane), the dark star's 39500 lane, and the Farshoal dense
  // field riding the frost fringe at 44300.
  WORLD_R: 46000,
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
  PLANET_R_MUL: 3,
  MOON_R_MUL: 2,
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
  // a world should FEEL like entering its well (total = SHIP_GRAV * this)
  PLANET_GRAV_SHIP: 3.0,
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
  SHIP_BAND_RANGE: 4,
  SHIP_BAND_DAMP: 1.2,
  SHIP_BAND_MAX: 130,
  // SURFACE SKIMMING: grinding tangentially along a body while in contact
  // chews the hull (collideShipBody) — a gentle landing is free below
  // SKIM_SPEED, then dps = (tangential speed - SKIM_SPEED) * SKIM_DPS_K.
  // (A sub-orbital slide grinds continuously; a super-orbital graze lifts
  // off in a few substeps and only takes a scratch — both are intended.)
  SKIM_SPEED: 100,
  SKIM_DPS_K: 0.09,

  // Solar flares: the sun RARELY erupts plasma at ships that fly close.
  // A direct hit is a real event now: EMP kills the engines for
  // FLARE_ENGINE_OUT seconds and blows half the orbit shield loose.
  FLARE_RANGE: 5500,       // only fires while the ship is this close to the sun
  FLARE_SPEED: 750,
  FLARE_LIFE: 6,           // seconds of flight — flares fizzle ~4500 out
  FLARE_DMG: 26,
  FLARE_ENGINE_OUT: 3,     // seconds of dead engines after a direct hit

  // CORONA HEAT on BODIES/ALIENS: everything melts inside HEAT_ZONE x the
  // sun's radius (dps ramps depth²). Lava-born things are immune.
  // HEAT_ZONE must keep this zone's outer edge INSIDE the graveyard ring
  // (~3160): 1.30 x 2400 = 3120 — raise it and the wrecks start cooking
  // (any damage at all derails them; there is no "subtle" for railed bodies).
  HEAT_ZONE: 1.30,
  HEAT_DPS_BODY: 0.12,     // fraction of a body's maxHp per second at surface
  // CORONA HEAT on the SHIP: a wide envelope with an EXPONENTIAL ramp —
  // dps = HEAT_SHIP_DPS * e^(-(d - sunR) / HEAT_SHIP_FALLOFF). At the zone
  // edge it's a whisper (~0.01), at the graveyard ring ~2.5/s, at the
  // photosphere the full 42/s. Warmth warns long before it kills; the kill
  // only happens if you keep going.
  HEAT_SHIP_ZONE: 2.1,     // visual + damage envelope, x sun radius
  HEAT_SHIP_DPS: 42,       // dps at the photosphere
  HEAT_SHIP_FALLOFF: 300,  // e-folding distance of the ramp
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
  DMG_BODY: 1.2e-6,        // dmg = K * (closing - threshold)^2 * otherMass
  // 240 is tuned to the sky speed (sun mass 1.42e7, world.js): ambient
  // crossing traffic closes at ~100-300, and this lets it bounce harmlessly
  // while real slams still bite. It was briefly raised to 340 when the sun
  // was 3.2e7 (1.4x faster sky); with the sky slowed back down it returns to
  // 240. Keep them in ratio if the sun mass changes again. THROWN keeps its
  // own low threshold — fling/alien-throw speeds are ship-derived, not orbital.
  DMG_THRESH: 240,         // closing speed below which impacts just bounce
  DMG_THRESH_THROWN: 140,  // threshold when either body was recently thrown
  DMG_THROWN_MULT: 2,
  // Ship impact damage: closing * DMG_SHIP * massSat, where massSat is the
  // impactor's mass saturating at 1 — the saturation knee SCALES WITH BEAM
  // TIER (1500 * (1 + tier * 1.2) in collideShipBody), so pebbles that
  // stung a scout barely tickle a dreadnought while planet slams always
  // hurt. Capped at 45% of max hull per hit.
  DMG_SHIP: 0.18,
  RESTITUTION: 0.35,

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
  PLANET_HP_BASE: 18000,
  PLANET_HP_MUL: 1.2,

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
  // The SHIELD recharges after a quiet spell; the HULL never self-heals — it
  // mends only by collecting glow-pocket motes (glow.js)
  SHIP_REGEN: 9,           // shield/s once recharging
  SHIP_REGEN_DELAY: 5,     // seconds without damage before recharge starts

  PICKUP_MAGNET: 620,      // scrap starts homing inside this range
  DEBRIS_LIFE: 150,

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
  ALIEN_WAVE_EVERY: 42,
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
  FIELD_ROCKS: 1900,       // rocks per field (~58u mean spacing — thick, trimmed from 2200)
  // Pocket size is PHYSICAL, not angular — an angular width scales with the
  // orbit radius and turned the outer field into an 11,000u dilute arc.
  // The pocket is deliberately close to ROUND rather than a long lane-shaped
  // smear: the design goal is that flying in you get LOST in it, and a wide
  // arc you cross in one straight line never does that no matter how long it
  // is. At 6200 x 4600 against a ~450u view radius, the far side is a dozen
  // screens away in every direction. These are the EXTENTS of the outline,
  // not a rectangle: the actual boundary is the lobed blob in fieldLobe()
  // below, sampled by world.fieldPoint — a rectangular scatter at these
  // numbers read as an obvious square of rocks.
  FIELD_LEN: 2950,         // tangential half-length of the pocket (world units)
  FIELD_SPREAD: 2200,      // radial half-thickness (world units)
  // A few GIANTS per pocket: landmark rocks big enough to navigate by and to
  // shatter into a cascade of smaller field rock (physics.shatter), which is
  // the chaos engine of the whole shoal. Gravity-free like everything else in
  // here — see the FIELD ROCK note below.
  FIELD_GIANTS: 9,
  FIELD_GIANT_MASS: [14000, 60000],   // the biggest are moon-scale monoliths
  FIELD_GIANT_SHARDS: [5, 9],   // pieces a giant breaks into (big shards re-flag as giants — one more cascade level)
  // Both lurker ranges are sized OFF the pocket, not absolutely: the wake
  // must reach past the far end (FIELD_LEN) or you could sit deep inside the
  // rocks without ever springing the ambush, and the territory has to contain
  // the whole pocket plus chase room or a lurker breaks off mid-slash.
  // (No circular wake/territory radii any more — lurker containment is the
  // POCKET FOOTPRINT itself, via fieldFrac() below: a circle wide enough to
  // cover the long axis overshot the short axis by 2x, and the baddies
  // visibly hunted open space outside their own rocks.)
  // MONOLITHS: a couple of rocks per pocket (plus the named heart) at twice
  // the drawn radius of the biggest regular giant (radius goes with cbrt of
  // mass, so 2x the size = 8x the mass). Landmarks you steer by from across
  // the shoal; still field rock — no gravity, and breakable only by a truly
  // heavy blow (see FIELD_HP_CAP).
  FIELD_MONOLITHS: 2,
  FIELD_MONOLITH_MASS: [3e5, 4.8e5],
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
  FIELD_TOUGH: 0.08,       // x damage on field-vs-field impacts (unless a player throw is involved)
  // ...and the MIRROR of it: shoal rock is tough against its own kind and
  // DANGEROUS TO YOU. The pockets are meant to be high risk / high reward and
  // were reading as pure reward. The reason is that the pocket is RIGID (one
  // shared rail w, zero relative drift): match its orbit and every rock is
  // nearly stationary relative to you, so the `closing > 25` gate meant a
  // farmer sitting in the middle of 1900 rocks was barely scratched.
  // It weights toward SELF-INFLICTED danger without being free otherwise,
  // because the damage rides `closing`: the faster the rock, the more it takes,
  // so it is loose stirred-up rock that bites and ambient jostling stays minor.
  // Measured over 20s at 1.0 vs 2.5 — parked 4% -> 7% hull, flying through
  // 6% -> 11%, and FARMING (10 detonating throws) 3% -> 10%, which is the
  // behaviour meant to cost the most. It also puts a real price on the brawler
  // blasts, which used to be free area denial in here.
  FIELD_SHIP_DMG: 2.5,
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
  LURKER_RADIUS: 10,
  LURKER_DMG: 16,          // contact damage per slash pass (grabbers hit for 24)
  LURKER_SPEED: 1.35,      // x ALIEN_SPEED — the fastest thing in the sky up close
  // The lurker fights like a BRAWLER, not a grabber: it has no beam, it
  // BODY-CHECKS field rocks at you. Ambient rock contact can't hurt it (it
  // lives in the rocks — see the shove branch in physics.collideAlienBody);
  // a PLAYER-thrown rock still guts it, which is the counterplay.
  // Shove speed is a REAL THREAT SPEED, not a nudge: at 420 the rock crawled
  // across the pocket and you simply flew around it, and the guidance window
  // (below) was doing all the work of making the shot connect. It sits above
  // ALIEN_THROW (430) on purpose — a body-check is the lurker's whole attack,
  // where a grabber's throw is one of several.
  // 700 -> 1000 and the cadence tightened: a body-check now arrives faster than
  // you can comfortably reposition, and a shoal under attack is a place with
  // rock genuinely flying AT you rather than a place where rock exists.
  LURKER_SHOVE: 1000,      // speed imparted to a rock it charges through
  LURKER_SHOVE_CD: 0.5,    // seconds before it can body-check again
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

  // THE SOLAR WAVE — the sun's coronal mass ejections, and the one piece of
  // weather the whole system feels at once. The sun CHARGES visibly for
  // STORM_CHARGE seconds (a telegraph you can act on), then fires a shock
  // front that sweeps outward at STORM_SPEED trailing a STORM_TAIL-deep
  // SHEATH of charged plasma.
  //
  // THE SHEATH IS THE WHOLE MECHANIC. The front alone is a 2 x STORM_BAND
  // ring, which crosses any given radius in ~1.5s — far too brief to be
  // anything but scenery, which is exactly what the storm used to be. The
  // sheath trailing behind it takes ~10s to pass, so being caught out in one
  // is a situation you have to answer rather than a flicker you never noticed.
  //
  // IT STILL NEVER TOUCHES BODIES, CELESTIALS OR RAILS (the storm-shove law —
  // a force on any of those is an invariant-3 regression waiting to happen).
  // Everything it does lands on the SHIP, on loose SCRAP, and on SENSORS:
  //   - caught exposed: hull dps, engines derated, sensors scrambled
  //   - SHELTER is the counterplay — a world's lee blocks it (STORM_SHADOW_*)
  //   - it blinds ALIEN senses system-wide for the whole passage (the window)
  //   - it ionizes the scrap it sweeps (PROG.ION_SCRAP_MUL — the payday)
  STORM_EVERY: 300,        // average seconds between waves — weather, not a metronome
  STORM_CHARGE: 7,         // seconds the sun visibly loads before the front fires
  STORM_SPEED: 950,        // shock-front expansion speed (u/s)
  STORM_BAND: 700,         // half-thickness of the bright leading shock
  STORM_TAIL: 9200,        // depth of the plasma sheath trailing the shock (~10s to pass)
  // Hull damage/sec while caught EXPOSED in the sheath. Directionless (no
  // hitAng) like heat and gas crush, so a partial shield soaks only its
  // coverage share — see damageShip. And because the damage is CONTINUOUS the
  // regen delay never elapses mid-wave: whatever shield you had is spent, and
  // it does not come back until the wave is off you.
  // MEASURED against the thing that matters — a full pass is TAIL/SPEED ≈ 9.7s
  // of exposure, so this number times ten is the real cost. At 16 that was 160
  // against a tier-0 hull of 205: 78% of a fresh ship, for weather that fires
  // every ~5 minutes and that a player far from any world cannot dodge. Hull
  // does not self-heal, so that is very close to run-ending on a first
  // encounter. 7 costs ~55-64 (measured, tier 0: BRAWLER 27% of its hull,
  // HAULER/SCOUT 53% of their thinner ones) — a price you feel and weigh,
  // which is what makes sheltering a decision rather than a formality. Kept
  // FLAT rather than scaled to hull, like every other environmental hazard
  // here (Oort grind, corona heat, gas crush at 9), and deliberately under the
  // gas cloud tops: a wave is 10 seconds you were handed, not a dive you chose.
  STORM_DPS: 7,
  STORM_THRUST: 0.6,       // engine derate while exposed: you are flying into the wind.
                           // Keyed to EXPOSURE, not the ion afterglow — ducking behind a
                           // world gives the engines back at once, which is the lesson.
  STORM_ION: 5,            // seconds of sensor scramble after the last exposed moment
  STORM_SHOVE: 150,        // radiation pressure on loose SCRAP DEBRIS. Debris only. Always.
  // SHELTER: the sun sits at the origin, so a world's shadow is just the
  // cylinder running anti-sunward from it. Forgiving on purpose — the lee has
  // to be somewhere a pilot can fly to under pressure, not a razor edge (and a
  // hard geometric boundary is against the house style anyway; render feathers
  // the wedge). Moons and up only: a pebble shelters nobody.
  STORM_SHADOW: 1.15,      // shadow cylinder radius, x the sheltering body's radius
  STORM_SHADOW_LEN: 30,    // how far that lee reaches behind it, x radius
  STORM_SHADOW_MIN_R: 60,  // smallest body that casts one

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

// Tractor size tiers. Your ORBIT can hold objects one tier below what your
// BEAM can grab.
export const TIERS = {
  caps: [1200, 6000, 35000, 120000, 400000, 1200000],
  labels: ['Asteroids', 'Moons', 'Minor planets', 'Planets', 'Gas giants', 'Anything but stars'],
};

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
  XP_PARRY: 14,            // a Deflector parry launches its rock (paid at the flick, not the catch)
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
  XP_STORM_RIDE: 5,
  STORM_RIDE_MAX: 14,      // seconds of exposure paid per wave
  // Scrap the wave sweeps comes out IONIZED and pays more. Never field-sourced
  // scrap: that chunk's XP was already charged against the pocket's budget at
  // drop time (fieldXp), and re-inflating it at pickup would launder the field
  // farm straight back through the weather.
  ION_SCRAP_MUL: 1.7,
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
  GLOW_RMIN: 4200,         // orbital band they scatter through — just above the graveyard ring
  GLOW_RMAX: 31000,        // ...out to the far ice belt
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
  // Kit carries Ram Prow + Deflector, not Heavy Winch: the brawler's frame-one
  // identity is MECHANICS (the innate prow and the parry, each deepened by its
  // track) — a kit of three stat sliders played like the base ship with bigger
  // numbers. Heavy Winch stays a strong early pool card. (The old kit rule —
  // at least three rankable rows — is satisfied by construction now that every
  // ability is six ranks; a kit is four climbing bars from frame one.)
  { id: 'brawler', name: 'BRAWLER', icon: '※',
    desc: 'Smash, ram, and shatter. Throws hard, flies tanky.',
    start: ['kineticSling', 'reinforcedHull', 'ramProw', 'deflector'] },
  { id: 'hauler', name: 'HAULER', icon: '◎',
    desc: 'Master of the beam — long reach, big hauls, orbit shields.',
    start: ['longArmTractor', 'salvageMagnet', 'heavyWinch'] },
  { id: 'scout', name: 'SCOUT', icon: '◇',
    desc: 'Eyes and speed — sensors, precision, and mobility.',
    start: ['tunedThrusters', 'retroJets', 'navPlotter', 'leadComputer'] },
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
// Scattergun/Rockwall/Aegis/Recovery Tether all act on ORBIT rocks, and with no
// orbit ability shipStats hands you orbitCap 0 / maxOrbiters 0, so there is
// never a rock for them to act on; Impact Warning marks a spot on the FORECAST
// PATH, and shipStats gates it behind the plotter outright (`hasCrashWarn =
// collisionC > 0 && hasPredict`). Offering one of those was a dead card: it
// spent the pick, its bar started climbing, and nothing whatsoever happened in
// the world. It names a CHANNEL, not an id, so it resolves across specs without
// a per-spec table (the orbit channel is BRAWLER's War Rack and HAULER's
// Orbital Sling / Expanded Bay alike) — the same reason shipStats reads
// channels. Keep it for genuinely-inert rows ONLY: the second-track duplicates
// (Grapple Extenders, Expanded Bay, Overtuned Drive, Bulk Freighter,
// Juggernaut) READ like extensions but are fully functional standing alone, and
// gating them would just thin the early pool for flavour.
// NAMING LAW (user design rule): two abilities that DO the same thing carry the
// SAME name/icon/desc even across specs (Heavy Winch is the catch starter in
// both BRAWLER and HAULER; Reinforced Hull is the hull track in both — ids stay
// distinct, they're separate catalog rows). Same-spec second tracks (Grapple
// Extenders, Expanded Bay, Overtuned Drive, Bulk Freighter, Juggernaut) are the
// deliberate exception: they must stay separately named to coexist as distinct
// cards, so their descs read as "more of the same" instead. BRAWLER's runtime abilities
// (Ram Prow, Deflector, Cluster Rounds, Shockwave, Wall Splat, Berserker,
// Demolition, Juggernaut — plus the INNATE ram, spec DNA) are live — their
// hooks live in physics.js (collideShipBody + brawlerThrowKill + the parry
// state machine) and tractor.js (Berserker fling). HAULER's: Recovery Tether +
// Twin Grip + Dead Stop (tractor.js), Aegis Reflector (physics collideBodies),
// Rockwall (physics damageBody hardening + tractor orbit spin). SCOUT's:
// Afterburner (fuel tank in main.js, thrust + governor in physics), Dash Jets
// (A/D — main.onDash), Reflex Jink (the auto-dodge scan in physics.step),
// Slipstream (main.onWarp), Recon Drone (world.js survey). All three specs'
// runtime abilities are live.
export const ABILITIES = [
  // 🥊 BRAWLER
  { id: 'kineticSling',   spec: 'brawler', name: 'Kinetic Sling',  icon: '➹', channel: 'fling',  max: 6, minTier: 0, weight: 1.0, desc: 'Hurl held rocks harder.' },
  { id: 'reinforcedHull', spec: 'brawler', name: 'Reinforced Hull', icon: '▤', channel: 'hull',  max: 6, minTier: 0, weight: 1.0, desc: 'Raise maximum hull.' },
  { id: 'scattergun',     spec: 'brawler', name: 'Scattergun',     icon: '☄', channel: 'volley', max: 6, minTier: 0, needs: 'orbit', weight: 1.1, desc: 'Right-click to blast your orbit rocks outward. Ranks fire harder and tighter.' },
  { id: 'heavyRounds',    spec: 'brawler', name: 'Heavy Winch',    icon: '✦', channel: 'catch',  max: 6, minTier: 0, weight: 1.0, desc: 'Grab and hurl much heavier rocks.' },
  { id: 'bulwarkRing',    spec: 'brawler', name: 'War Rack',       icon: '◒', channel: 'orbit',  max: 6, minTier: 0, weight: 1.1, desc: 'Drag captured rocks behind you as shotgun ammo (moon-size max).' },
  { id: 'warPlating',     spec: 'brawler', name: 'War Plating',    icon: '⛨', channel: 'shield', max: 6, minTier: 0, weight: 0.9, desc: 'A thin front plate that re-forms fast — FRONT ARC ONLY. Your tail stays bare.' },
  { id: 'deflector',      spec: 'brawler', name: 'Deflector',      icon: '⤺', channel: 'deflect', max: 6, minTier: 0, weight: 1.0, desc: 'A rock striking your NOSE freezes against the hull — flick the mouse to hurl it that way. Every rank: +1 rock held, wider catch bubble, longer freeze, harder hurl.' },
  { id: 'ramProw',        spec: 'brawler', name: 'Ram Prow',       icon: '△', channel: 'ram',        max: 6, minTier: 0, weight: 1.0, desc: 'Harden your innate ram — hit harder, shrug off more.' },
  { id: 'clusterRounds',  spec: 'brawler', name: 'Cluster Rounds', icon: '❋', channel: 'cluster',    max: 6, minTier: 0, weight: 1.0, desc: 'Your throw-kills burst into grabbable shrapnel.' },
  { id: 'shockwave',      spec: 'brawler', name: 'Shockwave',      icon: '◎', channel: 'shockwave',  max: 6, minTier: 0, weight: 1.0, desc: 'Throw-kills knock nearby bodies back.' },
  { id: 'wallSplat',      spec: 'brawler', name: 'Wall Splat',     icon: '▦', channel: 'wallsplat',  max: 6, minTier: 0, weight: 1.0, desc: 'Smash thrown rocks INTO worlds — splat kills pay bonus XP and shove nearby rocks, primed as yours.' },
  { id: 'berserker',      spec: 'brawler', name: 'Berserker',      icon: '✷', channel: 'berserk',    max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'The lower your hull, the harder you throw and ram.' },
  { id: 'demolition',     spec: 'brawler', name: 'Demolition',     icon: '✸', channel: 'demolition', max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Throw-kills detonate, damaging everything nearby.' },
  { id: 'juggernaut',     spec: 'brawler', name: 'Juggernaut',     icon: '⬢', channel: 'ram',        max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'A devastating ram and a much tougher hull.' },

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
  { id: 'grappleExtenders', spec: 'hauler', name: 'Grapple Extenders', icon: '⤢', channel: 'reach', max: 6, minTier: 0, weight: 1.0, desc: 'More reach and grab forgiveness.' },
  { id: 'expandedBay',    spec: 'hauler', name: 'Expanded Bay',     icon: '◍', channel: 'orbit',  max: 6, minTier: 0, weight: 1.0, desc: 'More orbit slots.' },
  { id: 'rockwall',       spec: 'hauler', name: 'Rockwall',         icon: '⛉', channel: 'rockwall', max: 6, minTier: 0, needs: 'orbit', weight: 1.0, desc: 'Orbit rocks are far tougher and spin faster to block.' },
  { id: 'bulkFreighter',  spec: 'hauler', name: 'Bulk Freighter',   icon: '❖', channel: 'catch',  max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Haul planet-scale masses.' },
  { id: 'recoveryTether', spec: 'hauler', name: 'Recovery Tether',  icon: '↩', channel: 'tether', max: 6, minTier: 0, needs: 'orbit', weight: 1.0, desc: 'Your thrown rocks curve back into your orbit.' },
  { id: 'deadStop',       spec: 'hauler', name: 'Dead Stop',        icon: '⊘', channel: 'deadstop', max: 6, minTier: 0, weight: 1.0, desc: 'Catch a rock an alien threw at you to prime it — its next fling flies far harder.' },
  { id: 'aegisReflector', spec: 'hauler', name: 'Aegis Reflector',  icon: '❂', channel: 'aegis',  max: 6, minTier: 3, xpMul: 0.5, needs: 'orbit', weight: 0.9, desc: 'Orbit rocks hurl intercepted enemy fire back.' },
  { id: 'twinGrip',       spec: 'hauler', name: 'Twin Grip',        icon: '⇄', channel: 'twin',   max: 6, minTier: 3, xpMul: 0.5, weight: 0.9, desc: 'Hold and throw two rocks at once. Ranks steady the rig — the second rock rides tighter and drags you around less.' },

  // 🔭 SCOUT
  { id: 'tunedThrusters', spec: 'scout', name: 'Tuned Thrusters', icon: '⏩', channel: 'engine',    max: 6, minTier: 0, weight: 1.0, desc: 'Faster thrust and a higher speed ceiling.' },
  // The sensor/QoL chain is SHARED (`also`): Scout-native at tier 0, offered to
  // the other specs later — the two flight-feel rows at tier 1, the sensor
  // tracks at tier 2 (below the tier-3 capstone band so they don't crowd it).
  { id: 'retroJets',      spec: 'scout', name: 'Retro Jets',      icon: '◂', channel: 'reverse',   max: 6, minTier: 0, also: { brawler: 1, hauler: 1 }, weight: 1.0, desc: 'Unlock reverse thrust (S). Ranks add braking authority.' },
  { id: 'gravityCompass', spec: 'scout', name: 'Gravity Compass', icon: '✧', channel: 'compass',   max: 6, minTier: 0, also: { brawler: 1, hauler: 1 }, weight: 1.0, desc: 'World-pull chevrons at your ship. Ranks pick up fainter pulls.' },
  { id: 'navPlotter',     spec: 'scout', name: 'Nav Plotter',     icon: '⋯', channel: 'plotter',   max: 6, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.1, desc: 'Your flight-path forecast.' },
  { id: 'impactWarning',  spec: 'scout', name: 'Impact Warning',  icon: '⚠', channel: 'collision', max: 6, minTier: 0, also: { brawler: 2, hauler: 2 }, needs: 'plotter', weight: 1.0, desc: 'Mark where your path will hit (needs the plotter). Ranks forecast farther ahead.' },
  { id: 'leadComputer',   spec: 'scout', name: 'Lead Computer',   icon: '⊕', channel: 'targeting', max: 6, minTier: 0, also: { brawler: 2, hauler: 2 }, weight: 1.0, desc: 'Aim lead-markers for your throws.' },
  { id: 'overtunedDrive', spec: 'scout', name: 'Overtuned Drive', icon: '⏩', channel: 'engine',    max: 6, minTier: 0, weight: 1.0, desc: 'Push the speed ceiling higher.' },
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
  // BRAWLER runtime channels (ram = Ram Prow + Juggernaut; the rest are 1:1).
  const ramC = c('ram'), berserkC = c('berserk'), clusterC = c('cluster'),
    shockC = c('shockwave'), demoC = c('demolition'), wallsplatC = c('wallsplat'),
    deflectC = c('deflect');
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
  const capacity = TIERS.caps[tier] * (1 + 0.22 * catchC);
  // ram armor beefs the hull too — 30/rank over the old 4+3 ceiling, so 17.5
  // over the new 6+6 (same +210 at the top).
  const maxHull = 120 + 40 * tier + 55 * hullC + 17.5 * ramC;
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

  // Stow cap: one tier below the beam (or 45% of capacity), unlocked by an
  // orbit ability. The FORMATION is spec DNA like the shield: HAULER's stow
  // orbits and protects; BRAWLER's trails BEHIND the ship (trailStow — an
  // ammo train, not a shield) and is CAPPED AT MOON CLASS forever, however
  // high the beam tier climbs — the rack is shotgun ammo, not a planet garage.
  const trailStow = prog.spec === 'brawler';
  let orbitCap = orbitLvl > 0 ? Math.max(tier >= 1 ? TIERS.caps[tier - 1] : 0, capacity * 0.45) : 0;
  let orbitLabel = tier >= 1 ? TIERS.labels[tier - 1] : 'Small rocks';
  if (trailStow && orbitCap > TIERS.caps[1]) {
    orbitCap = TIERS.caps[1];
    orbitLabel = TIERS.labels[1];
  }

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
    force: capacity * 55 * (0.6 + 0.12 * tier),
    maxSpeed: 280 + 40 * tier + 80 * engineC,
    thrust: 180 + 30 * tier + 95 * engineC,
    fling: 430 + 55 * tier + 150 * flingC,
    maxHull: Math.round(maxHull),
    // Pool splits hull (mends only at glow pockets) / shield (recharges)
    hullMax,
    shieldMax: Math.round(maxHull) - hullMax,
    // Stow is LOCKED until an orbit ability (rank 0 -> no slots); see the
    // trailStow/moon-cap derivation above for the brawler differences.
    orbitCap,
    orbitLabel,
    trailStow,
    // 1/2/3/5/6/7 slots, CAPPED at 7 — orbit is a stacking channel (Orbital
    // Sling + Expanded Bay), so uncapped it could hit 23; higher ranks still
    // grow orbitCap/range. The old ladder was 2*lvl-1 over a 4-rank track
    // (1/3/5/7); stretched across six ranks it climbs at 1.2 slots per rank so
    // a single maxed orbit ability still lands exactly on the 7-slot cap.
    maxOrbiters: orbitLvl > 0 ? Math.min(7, 1 + Math.round((orbitLvl - 1) * 1.2)) : 0,
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
    hasVolley: volC > 0,
    volleyLvl: volC,
    // SCATTERGUN's ranks used to be dead weight — hasVolley was the only thing
    // anything read, so rank 2 and 3 bought nothing at all. Six ranks made that
    // untenable: the pellets now leave harder and in a tighter cone.
    volleySpeed: volC > 0 ? 1 + 0.05 * (volC - 1) : 1,
    volleySpread: 0.07 * (volC > 0 ? 1 - 0.06 * (volC - 1) : 1),
    // ---- BRAWLER runtime abilities (read by physics/tractor) ----
    // INNATE RAM (spec DNA, like the shield shape): a brawler bonks from frame
    // one — ram deals more and impacts hurt less at rank ZERO, so minute-one
    // play already inverts (other specs dodge rocks; the brawler plays
    // chicken). Ram Prow / Juggernaut then deepen the same numbers.
    // (Ram Prow 4 + Juggernaut 3 = a 7-rank channel before; 6 + 6 = 12 now, so
    // both coefficients are scaled by 7/12 and the ceiling is where it was.)
    ramMul: (prog.spec === 'brawler' ? 1.35 : 1) + 0.26 * ramC,   // ram damage DEALT to bodies
    ramArmor: Math.max(0.45, (prog.spec === 'brawler' ? 0.85 : 1) - 0.064 * ramC), // impact damage TAKEN (lower = tougher)
    berserk: berserkC,                            // fling/ram scale up as hull drops (runtime hull read)
    cluster: clusterC,                            // shrapnel shards spawned on a throw-kill
    shockwave: shockC,                            // knockback impulse on a throw-kill
    demolition: demoC,                            // AoE damage on a throw-kill
    wallSplat: wallsplatC,                        // Wall Splat: kills AGAINST a world blast nearby rocks
    // DEFLECTOR (the parry, brawler kit): rocks closing on the NOSE freeze on
    // contact for the window; the player's mouse FLICK picks the hurl
    // direction (physics.updateParry owns the whole flow: scan, pin, flick,
    // launch). Rank 1 catches at the HULL — the rock must actually hit you
    // (user design rule: no catching out in space) — and each of the SIX
    // ranks widens the catch bubble, adds a slot (cap = rank, so a maxed
    // deflector freezes a six-rock volley), lengthens the freeze, and hardens
    // the hurl; the cooldown is fixed. Per-rank growth is sized for the long
    // track — rank 6 tops out near the old 3-rank ceiling. The base window is
    // long on purpose: enough time to read the freeze and aim the flick.
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
    zoomOut: 1.15 / SHIP_ZOOM[tier],
    totalLevel,
  };
}
