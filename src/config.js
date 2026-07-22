// All gameplay tuning lives here.
export const CFG = {
  G: 8,                    // gravitational constant (gameplay-tuned)
  DT: 1 / 120,             // physics substep
  WORLD_R: 15000,          // soft boundary radius around origin
  ATTRACT_MIN: 2000,       // bodies at/above this mass exert gravity
  GRAV_SOFT: 40,           // softening length to avoid singularities
  // Celestial bodies feel full gravity from stars and their parent planet, but
  // only this fraction from other planets/moons/rogues. The ship, aliens,
  // debris, and anything you throw always feel FULL gravity from everything.
  // Without this, planet masses big enough to matter to the ship make the
  // systems gravitationally shred themselves within minutes.
  CROSS_GRAV: 0.15,

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

  SHIP_RADIUS: 14,
  SHIP_TURN: 9,            // rad/s toward mouse
  SHIP_REGEN: 2.5,         // hull/s after quiet period
  SHIP_REGEN_DELAY: 8,

  PICKUP_MAGNET: 230,      // scrap starts homing inside this range
  DEBRIS_LIFE: 70,

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

// Upgrade tracks. levels[i] is the stat value at level i; costs[i] is the price to REACH level i.
export const UPGRADES = {
  capacity: {
    name: 'Tractor Capacity',
    desc: 'Grab and fling heavier objects',
    levels: [1200, 6000, 35000, 120000, 400000, 1000000],
    labels: ['Asteroids', 'Moons', 'Minor planets', 'Planets', 'Gas giants', 'Anything but stars'],
    costs: [0, 60, 180, 500, 1200, 3000],
  },
  power: {
    name: 'Beam Power',
    desc: 'Stronger pull, longer range, harder flings',
    levels: [1, 1.35, 1.8, 2.4, 3.2],
    costs: [0, 50, 140, 380, 900],
  },
  engine: {
    name: 'Engines',
    desc: 'More thrust to fight gravity wells',
    levels: [190, 255, 340, 450, 590],
    costs: [0, 45, 130, 340, 820],
  },
  hull: {
    name: 'Hull Plating',
    desc: 'Take bigger hits (buying repairs you)',
    levels: [100, 150, 220, 320, 460],
    costs: [0, 45, 130, 340, 820],
  },
};

// Derived ship stats from upgrade levels
export function shipStats(up) {
  const capacity = UPGRADES.capacity.levels[up.capacity];
  const pw = UPGRADES.power.levels[up.power];
  return {
    capacity,
    capacityLabel: UPGRADES.capacity.labels[up.capacity],
    power: pw,
    range: 260 * (0.85 + 0.35 * pw),
    force: capacity * 55 * (0.6 + 0.4 * pw),   // max tractor force (accel*mass)
    fling: 430 * (0.8 + 0.45 * pw),            // base fling speed
    thrust: UPGRADES.engine.levels[up.engine],
    maxHull: UPGRADES.hull.levels[up.hull],
  };
}
