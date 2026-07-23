// All gameplay tuning lives here.
export const CFG = {
  G: 8,                    // gravitational constant (gameplay-tuned)
  DT: 1 / 120,             // physics substep
  // Soft boundary radius. MUST exceed the outermost orbit reach (orbit +
  // moons), or the boundary force quietly deorbits the outer planets.
  // Beyond it lies the Oort cloud, which grinds the ship down.
  WORLD_R: 42000,
  OORT_WARN: 1400,         // warning distance before the cloud edge
  OORT_DPS: 6,             // hull damage/s at the edge, scaling with depth
  ATTRACT_MIN: 2000,       // bodies at/above this mass exert gravity
  GRAV_SOFT: 40,           // softening length to avoid singularities
  // The ship feels amplified gravity from everything — big suns and planets
  // should really pull on YOU (thrown objects and NPCs use normal G).
  SHIP_GRAV: 1.45,
  // SKY-SPEED COMPENSATION: the sun's mass was doubled (world.js) so every
  // sun-anchored orbit sweeps ~1.4x faster — a livelier sky. This amp was
  // HALVED at the same time so the ship-felt sun pull (mass x amp) and the
  // spawn-orbit speed are numerically unchanged. These two tune together:
  // never touch one without the other or the ship's flight feel shifts.
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
  // 340 = the original 240 scaled by the ~1.41x sky speed-up (doubled sun
  // mass): ambient crossing traffic now closes at ~140-420, and the old
  // threshold let routine crossings sandblast moons/comets. THROWN keeps its
  // old threshold — fling/alien-throw speeds are ship-derived, not orbital.
  DMG_THRESH: 340,         // closing speed below which impacts just bounce
  DMG_THRESH_THROWN: 140,  // threshold when either body was recently thrown
  DMG_THROWN_MULT: 2,
  // Ship impact damage: closing * DMG_SHIP * massSat, where massSat is the
  // impactor's mass saturating at 1 — the saturation knee SCALES WITH BEAM
  // TIER (1500 * (1 + tier * 1.2) in collideShipBody), so pebbles that
  // stung a scout barely tickle a dreadnought while planet slams always
  // hurt. Capped at 45% of max hull per hit.
  DMG_SHIP: 0.18,
  RESTITUTION: 0.35,

  // Speed governor: each engine level raises the ceiling; excess speed
  // (slingshots, knockbacks) bleeds off at SPEED_BLEED x the overage per
  // second, and NOTHING sustains beyond SPEED_HARD x the ceiling. The old
  // gentle bleed (0.8, no hard cap) predates the long-arm gravity boost —
  // 6x far-field assists let low-level ships coast at absurd speeds.
  // predictPaths mirrors both numbers; keep them in sync.
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
  // The SHIELD recharges after a quiet spell; the hull only heals from scrap
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

  // Solar storms: periodic charged waves sweeping the WHOLE system —
  // discovery weather, not a weapon. The front lights auroras on the worlds
  // it washes over, brightens comet tails, and gives loose scrap a gentle
  // outward push. It deals no damage and never touches celestials or rails.
  STORM_EVERY: 420,        // average seconds between storms — rare weather, not a metronome
  STORM_SPEED: 950,        // wave-front expansion speed (u/s)
  STORM_BAND: 700,         // half-thickness of the active front

  PREDICT_STEPS: 200,      // trajectory forecast resolution (ship path)
  PREDICT_DT: 1 / 30,
  HELD_STEPS: 60,          // the throw line is short (~2s of flight)...
  LOCK_T: 1.8,             // ...and lock-on only works within throw-line reach
};

// Tractor size tiers. Your ORBIT can hold objects one tier below what your
// BEAM can grab.
export const TIERS = {
  caps: [1200, 6000, 35000, 120000, 400000, 1200000],
  labels: ['Asteroids', 'Moons', 'Minor planets', 'Planets', 'Gas giants', 'Anything but stars'],
};

// Upgrades are AUTOMATIC — playing the game grows the ship:
//   catch things in the beam  -> beam capacity grows (heavier catches = faster)
//   smash things              -> fling speed grows
//   collect scrap             -> heals you AND raises max hull
//   spend delta-v flying      -> engines grow
export const GROWTH = {
  CATCH_RATE: 0.35,        // capacity *= 1 + rate * (mass/capacity, repeat-discounted)
  CAPACITY_MAX: 1500000,
  SMASH_RATE: 0.05,        // fling *= 1 + rate per player-credited kill
  FLING_BASE: 430,
  FLING_MAX: 2200,
  TOUGH_RATE: 0.35,        // maxHull += scrapValue * rate
  HULL_BASE: 100,
  HULL_MAX: 800,
  THRUST_BASE: 100,        // slow start — leveling up opens the system to you
  THRUST_MAX: 1100,
  THRUST_SCALE: 80,        // thrust = base + scale * sqrt(deltaV / THRUST_DIV)
  THRUST_DIV: 2500,        // bigger = slower engine leveling
};

export function newProgress() {
  return {
    capacity: TIERS.caps[0],
    fling: GROWTH.FLING_BASE,
    maxHull: GROWTH.HULL_BASE,
    thrust: GROWTH.THRUST_BASE,
    dv: 0,                 // lifetime delta-v spent
    catches: 0,
    smashes: 0,
    scrapCollected: 0,
    orbitXp: 0,            // +1 per orbit add, +3 per shield block
    surveyed: 0,           // worlds charted by flying close (world.js scan)
  };
}

// Derived ship stats + per-track levels (levels drive visuals & alien scaling)
export function shipStats(prog) {
  let tier = 0;
  while (tier < TIERS.caps.length - 1 && prog.capacity >= TIERS.caps[tier + 1]) tier++;
  const flingLvl = Math.min(5, Math.floor((prog.fling - GROWTH.FLING_BASE) / 300));
  const hullLvl = Math.min(5, Math.floor((prog.maxHull - GROWTH.HULL_BASE) / 120));
  const thrustLvl = Math.min(5, Math.floor((prog.thrust - GROWTH.THRUST_BASE) / 180));
  const orbitLvl = Math.min(5, Math.floor(Math.sqrt(prog.orbitXp / 4)));
  // Charting worlds levels a SENSOR track — deliberately excluded from
  // totalLevel so exploration never inflates the zoom/ship-size pacing.
  const chartLvl = Math.min(5, Math.floor(prog.surveyed / 4));
  const totalLevel = tier + flingLvl + hullLvl + thrustLvl + orbitLvl;

  // Fraction of the way to each track's next level (1 when maxed) — shown on
  // the HUD so you always know how close the next level is.
  const frac01 = (v) => Math.max(0, Math.min(1, v));
  const fracs = {
    beam: tier >= TIERS.caps.length - 1 ? 1
      : frac01((prog.capacity - TIERS.caps[tier]) / (TIERS.caps[tier + 1] - TIERS.caps[tier])),
    fling: flingLvl >= 5 ? 1 : frac01(((prog.fling - GROWTH.FLING_BASE) - flingLvl * 300) / 300),
    hull: hullLvl >= 5 ? 1 : frac01(((prog.maxHull - GROWTH.HULL_BASE) - hullLvl * 120) / 120),
    thrust: thrustLvl >= 5 ? 1 : frac01(((prog.thrust - GROWTH.THRUST_BASE) - thrustLvl * 180) / 180),
    orbit: orbitLvl >= 5 ? 1
      : frac01((prog.orbitXp - 4 * orbitLvl * orbitLvl) / (4 * (orbitLvl + 1) ** 2 - 4 * orbitLvl * orbitLvl)),
    chart: chartLvl >= 5 ? 1 : frac01((prog.surveyed - chartLvl * 4) / 4),
  };

  return {
    capacity: prog.capacity,
    tier,
    label: TIERS.labels[tier],
    // Orbit level extends how far the beam reaches and how forgiving the
    // cursor is about being near a target
    range: 280 + 70 * tier + 45 * orbitLvl,
    grabSlack: 70 + 28 * orbitLvl,
    force: prog.capacity * 55 * (0.6 + 0.12 * tier),
    // Speed governor: each engine level raises the ceiling; exceeding it
    // (slingshots, knockbacks) bleeds off gradually
    maxSpeed: 280 + 135 * thrustLvl,
    fling: prog.fling,
    thrust: prog.thrust,
    maxHull: Math.round(prog.maxHull),
    // The pool splits ~2/3 hull (scrap-heal only) / 1/3 shield (recharges)
    hullMax: Math.round(prog.maxHull * (2 / 3)),
    shieldMax: Math.round(prog.maxHull) - Math.round(prog.maxHull * (2 / 3)),
    // Generous size rule: anything up to ~45% of beam capacity fits the orbit,
    // so a chunky asteroid your beam handles easily is never "too big".
    // The orbit works from the very start (small rocks only at tier 0).
    orbitCap: Math.max(tier >= 1 ? TIERS.caps[tier - 1] : 0, prog.capacity * 0.45),
    orbitLabel: tier >= 1 ? TIERS.labels[tier - 1] : 'Small rocks',
    // 1 slot out of the gate; every orbit level adds 3 more
    maxOrbiters: 1 + 3 * orbitLvl,
    orbitLvl,
    levels: { beam: tier, orbit: orbitLvl, fling: flingLvl, hull: hullLvl, thrust: thrustLvl, chart: chartLvl },
    fracs,
    // Every charted world sharpens the sensors: predictPaths multiplies its
    // forecast step count by this, so exploring literally extends how far
    // ahead you can see. Capped ~2x so the per-frame predictor stays cheap.
    predictBoost: 1 + Math.min(1.1, prog.surveyed * 0.06),
    // The ship GROWS with you — paired with the deep auto zoom-out below,
    // leveling reads as you outgrowing the universe
    radius: Math.min(64, 9 + totalLevel * 2.0),
    // Camera pulls way back as you grow (animated in main.js, no manual
    // zoom) — the system visibly shrinks around your ever-bigger ship
    zoomOut: Math.min(3.4, 1 + totalLevel * 0.11),
    totalLevel,
  };
}
