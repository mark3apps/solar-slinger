// All gameplay tuning lives here.
export const CFG = {
  G: 8,                    // gravitational constant (gameplay-tuned)
  DT: 1 / 120,             // physics substep
  // Soft boundary radius. MUST exceed the outermost orbit reach (orbit +
  // moons), or the boundary force quietly deorbits the outer planets.
  // Beyond it lies the Oort cloud, which grinds the ship down.
  WORLD_R: 32000,
  OORT_WARN: 1400,         // warning distance before the cloud edge
  OORT_DPS: 6,             // hull damage/s at the edge, scaling with depth
  ATTRACT_MIN: 2000,       // bodies at/above this mass exert gravity
  GRAV_SOFT: 40,           // softening length to avoid singularities
  // The ship feels amplified gravity from everything — big suns and planets
  // should really pull on YOU (thrown objects and NPCs use normal G).
  SHIP_GRAV: 1.45,
  // ...and the SUN doubly so: stars pull on the ship this much harder still
  // (total star pull on the ship = SHIP_GRAV * STAR_GRAV_SHIP)
  STAR_GRAV_SHIP: 1.6,

  // Solar flares: the sun periodically erupts plasma at nearby ships
  FLARE_RANGE: 10000,      // only fires while the ship is this close to the sun
  FLARE_SPEED: 750,
  FLARE_DMG: 26,

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
  DMG_THRESH: 240,         // closing speed below which impacts just bounce
  DMG_THRESH_THROWN: 140,  // threshold when either body was recently thrown
  DMG_THROWN_MULT: 2,
  DMG_SHIP: 4.4e-4,        // impact damage to ship: relSpeed * mass * K
  RESTITUTION: 0.35,

  SHIP_TURN: 9,            // rad/s — the nose tracks the mouse
  SHIP_REGEN: 2.5,         // hull/s after quiet period
  SHIP_REGEN_DELAY: 8,

  PICKUP_MAGNET: 620,      // scrap starts homing inside this range
  DEBRIS_LIFE: 150,

  ORBIT_OMEGA: 1.5,        // rad/s — how fast the shield orbit spins
  VOLLEY_TIME: 3,          // hold RMB this long to fling the whole orbit

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
    // Generous size rule: anything up to ~45% of beam capacity fits the orbit,
    // so a chunky asteroid your beam handles easily is never "too big".
    // The orbit works from the very start (small rocks only at tier 0).
    orbitCap: Math.max(tier >= 1 ? TIERS.caps[tier - 1] : 0, prog.capacity * 0.45),
    orbitLabel: tier >= 1 ? TIERS.labels[tier - 1] : 'Small rocks',
    // 1 slot out of the gate; every orbit level adds 3 more
    maxOrbiters: 1 + 3 * orbitLvl,
    orbitLvl,
    levels: { beam: tier, orbit: orbitLvl, fling: flingLvl, hull: hullLvl, thrust: thrustLvl },
    fracs,
    // The ship GROWS with you — paired with the deep auto zoom-out below,
    // leveling reads as you outgrowing the universe
    radius: Math.min(64, 9 + totalLevel * 2.0),
    // Camera pulls way back as you grow (animated in main.js, no manual
    // zoom) — the system visibly shrinks around your ever-bigger ship
    zoomOut: Math.min(3.4, 1 + totalLevel * 0.11),
    totalLevel,
  };
}
