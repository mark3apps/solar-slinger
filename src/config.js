// All gameplay tuning lives here.
export const CFG = {
  G: 8,                    // gravitational constant (gameplay-tuned)
  DT: 1 / 120,             // physics substep
  // Soft boundary radius. MUST exceed the outermost orbit reach (orbit +
  // moons), or the boundary force quietly deorbits the outer planets.
  // Beyond it lies the Oort cloud, which grinds the ship down.
  WORLD_R: 18500,
  OORT_WARN: 1400,         // warning distance before the cloud edge
  OORT_DPS: 6,             // hull damage/s at the edge, scaling with depth
  ATTRACT_MIN: 2000,       // bodies at/above this mass exert gravity
  GRAV_SOFT: 40,           // softening length to avoid singularities
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

  PREDICT_STEPS: 200,      // trajectory forecast resolution
  PREDICT_DT: 1 / 30,
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
  CATCH_RATE: 0.22,        // capacity *= 1 + rate * (mass/capacity, repeat-discounted)
  CAPACITY_MAX: 1500000,
  SMASH_RATE: 0.05,        // fling *= 1 + rate per player-credited kill
  FLING_BASE: 430,
  FLING_MAX: 2200,
  TOUGH_RATE: 0.35,        // maxHull += scrapValue * rate
  HULL_BASE: 100,
  HULL_MAX: 800,
  THRUST_BASE: 130,        // slow start — leveling up opens the system to you
  THRUST_MAX: 850,
  THRUST_SCALE: 62,        // thrust = base + scale * sqrt(deltaV / 1000)
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
  const thrustLvl = Math.min(5, Math.floor((prog.thrust - GROWTH.THRUST_BASE) / 130));
  const orbitLvl = Math.min(5, Math.floor(Math.sqrt(prog.orbitXp / 4)));
  const totalLevel = tier + flingLvl + hullLvl + thrustLvl + orbitLvl;
  return {
    capacity: prog.capacity,
    tier,
    label: TIERS.labels[tier],
    range: 280 + 70 * tier,
    force: prog.capacity * 55 * (0.6 + 0.12 * tier),
    fling: prog.fling,
    thrust: prog.thrust,
    maxHull: Math.round(prog.maxHull),
    orbitCap: tier >= 1 ? TIERS.caps[tier - 1] : 0,
    orbitLabel: tier >= 1 ? TIERS.labels[tier - 1] : 'locked',
    maxOrbiters: Math.min(9, 2 + tier + Math.floor(orbitLvl / 2)),
    orbitLvl,
    levels: { beam: tier, orbit: orbitLvl, fling: flingLvl, hull: hullLvl, thrust: thrustLvl },
    radius: Math.min(32, 14 + totalLevel * 0.75),
    // Camera pulls back as you grow — the system shrinks around you
    zoomOut: 1 + totalLevel * 0.045,
    totalLevel,
  };
}
