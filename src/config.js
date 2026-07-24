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

// Per-tier collision radius (= the drawn hull's body disc; render.js
// normalizes the art to it). These are DERIVED, not hand-picked: the ship's
// full drawn FOOTPRINT (nose tip / outer ring — shipVisualR) grows by the
// SAME RATIO each tier (x1.62, from 6.0 to 67 world units), and each entry
// divides that footprint by its tier design's art-reach ratio
// (footprint/bodyR from render.js SHIP_TIERS: 2.33, 1.94, 1.82, 1.76, 1.71,
// 1.76). Equal RATIOS, not equal increments: the eye judges size change
// multiplicatively, so an increment ladder made the early tiers feel huge
// and (paired with the zoom's growing ratio steps) tier 6 feel like an
// explosion. Recompute if SHIP_TIERS proportions change.
export const SHIP_RADIUS = [2.6, 5.0, 8.6, 14.5, 24.1, 38.0];

// Per-tier camera zoom TARGET (the value cam zoom eases toward): a
// geometric ramp from 2.46 to 0.6 — each step recedes by the same ~25%
// RATIO. The start value is DERIVED, not aesthetic: it makes the ship's
// APPARENT on-screen size arc identical to the approved one (~15px-eq
// scout -> ~40px-eq titan) while the ship's WORLD size shrank — small
// ships look the same in the viewport but tiny next to planets. Change
// SHIP_RADIUS and you must re-derive this. Zoom is driven by beam tier
// alone — other progression tracks don't pull the camera back.
// NOTE: this tight tier-0 zoom is why the SKY SPEED is tuned low (the sun's
// mass, world.js) — the world scrolls past ~2x faster per zoom unit, so a
// fast sky at this zoom reads as flying wildly fast. Flight feel = sky speed
// x zoom; they tune together. Raise this zoom and the sun mass must drop.
export const SHIP_ZOOM = [2.46, 1.86, 1.40, 1.06, 0.80, 0.60];

// Per-tier ship CLASS name (matches the hull designs drawn in render.js
// SHIP_TIERS). Distinct from st.label, which names what your BEAM can grab.
export const SHIP_NAMES = ['Scout', 'Fighter', 'Corvette', 'Cruiser', 'Dreadnought', 'Titan'];

// ROGUELITE PROGRESSION. Nothing grows passively any more: doing good things
// (grab, smash, skim, kill, collect, survey, slingshot, shield-block) grants
// XP; crossing a threshold PAUSES the game and offers a CHOICE of 2 upgrades.
// Every PICKS_PER_TIER small picks the next choice is a TIER-UP milestone —
// a 3-way specialization-path card plus a full-ship boost. You start with only
// the tractor beam and a single held rock; every other ability is an upgrade.
// Death spends a life (upgrades kept); 0 lives = game over and a fresh run.
export const PROG = {
  START_LIVES: 3,
  MAX_LIVES: 5,
  PICKS_PER_TIER: 5,       // small picks before a tier-up milestone
  // XP-to-next-pick rises with level: BASE + STEP * level
  XP_BASE: 90,
  XP_STEP: 26,
  // XP awards per action (tuned in the balance-test soak — see CLAUDE.md)
  XP_CATCH: 6,             // + up to 20 scaled by mass vs capacity
  XP_SMASH: 10,            // + 12 for a big kill
  XP_SCRAP: 0.5,           // per unit of debris-chunk value collected
  XP_ORBIT: 8,             // stow a rock into the orbit shield
  XP_BLOCK: 14,            // a shield rock intercepts an alien throw
  XP_SURVEY: 40,           // chart a world
  XP_SKIM: 0.7,            // per hull-point ground off while skimming a surface
  XP_SLING: 0.6,           // per unit of speed gained in a clean slingshot
  // Life pods: sparse world collectibles that refill the buffer
  LIFE_R: 62,              // collect radius
  LIFE_MAX_ACTIVE: 1,      // at most this many adrift at once
  LIFE_RESPAWN: 150,       // avg seconds between respawns (only while under MAX_LIVES)
};

// The upgrade catalog. Each entry: id, display, icon, max rank, the tier
// RANGE it can appear in (guides the pool — narrow early, widening later),
// and a base draw weight. shipStats() reads the earned ranks to derive stats;
// several upgrades are ABILITY UNLOCKS (rank 1 turns the ability on).
export const UPGRADES = [
  // core stat upgrades (broad availability)
  { id: 'beamReach', name: 'Beam Reach', icon: '⤢', max: 3, tiers: [0, 5], weight: 1.0,
    desc: 'Extend tractor range and grab forgiveness.' },
  { id: 'catchStrength', name: 'Beam Power', icon: '✦', max: 3, tiers: [0, 5], weight: 1.0,
    desc: 'Grab heavier rocks within your tier.' },
  { id: 'hullPlate', name: 'Hull Plating', icon: '▤', max: 5, tiers: [0, 5], weight: 1.1,
    desc: 'Raise maximum hull.' },
  { id: 'engine', name: 'Engine Tuning', icon: '⏩', max: 4, tiers: [0, 5], weight: 1.0,
    desc: 'Faster thrust and a higher speed ceiling.' },
  { id: 'flingPower', name: 'Fling Power', icon: '➹', max: 4, tiers: [1, 5], weight: 1.0,
    desc: 'Throw and shotgun rocks harder.' },
  { id: 'shieldCap', name: 'Shield Cells', icon: '⛨', max: 3, tiers: [1, 5], weight: 0.9,
    desc: 'Shift more of your health pool into regenerating shield.' },
  { id: 'scrapMagnet', name: 'Scrap Magnet', icon: '⦿', max: 3, tiers: [2, 5], weight: 0.8,
    desc: 'Pull in scrap from farther away.' },
  { id: 'regen', name: 'Shield Regen', icon: '♻', max: 3, tiers: [3, 5], weight: 0.8,
    desc: 'Shield recharges sooner and faster.' },
  // ability unlocks (rank 1 unlocks; higher ranks improve)
  { id: 'reverse', name: 'Retro Thrusters', icon: '◂', max: 1, tiers: [0, 5], weight: 1.3,
    desc: 'Unlock reverse thrust (S).' },
  { id: 'targeting', name: 'Targeting Computer', icon: '⊕', max: 3, tiers: [0, 5], weight: 1.2,
    desc: 'Unlock aim lead-markers; ranks add reach and markers.' },
  { id: 'predict', name: 'Trajectory Plotter', icon: '⋯', max: 3, tiers: [1, 5], weight: 1.1,
    desc: 'Unlock your flight-path forecast; ranks see farther.' },
  { id: 'orbitShield', name: 'Orbit Shield', icon: '◍', max: 4, tiers: [1, 5], weight: 1.2,
    desc: 'Stow rocks into a defensive orbit; ranks add slots.' },
  { id: 'compass', name: 'Gravity Compass', icon: '✧', max: 2, tiers: [2, 5], weight: 1.0,
    desc: 'Unlock the world-gravity chevrons at your ship.' },
  { id: 'crashWarn', name: 'Collision Alert', icon: '⚠', max: 1, tiers: [2, 5], weight: 1.0,
    desc: 'Mark where your path will hit (needs the plotter).' },
  { id: 'volley', name: 'Shotgun Array', icon: '☄', max: 3, tiers: [3, 5], weight: 1.1,
    desc: 'Unlock the right-click orbit shotgun; ranks charge faster.' },
  { id: 'sensor', name: 'Deep Sensors', icon: '◈', max: 3, tiers: [3, 5], weight: 0.9,
    desc: 'See farther on the map and extend the forecast.' },
];

// Tier-up specialization paths. Choosing one grants a free rank of its
// signature upgrade and biases the small-pick pool for the coming tier.
export const PATHS = [
  { id: 'brawler', name: 'BRAWLER', icon: '※',
    desc: 'Built for the smash. Fling, hull, and shotgun favored.',
    grant: 'flingPower', bias: { flingPower: 2.2, hullPlate: 1.8, volley: 1.9, catchStrength: 1.4 } },
  { id: 'hauler', name: 'HAULER', icon: '◎',
    desc: 'Master of the beam. Capacity, reach, and the orbit shield favored.',
    grant: 'orbitShield', bias: { orbitShield: 2.2, catchStrength: 2.0, beamReach: 1.7, scrapMagnet: 1.6 } },
  { id: 'scout', name: 'SCOUT', icon: '◇',
    desc: 'Eyes everywhere. Engines, targeting, plotter, and sensors favored.',
    grant: 'engine', bias: { engine: 2.0, targeting: 2.0, predict: 1.8, sensor: 1.8, compass: 1.6 } },
];

export function upgradeById(id) { return UPGRADES.find((u) => u.id === id); }

export function newProgress() {
  return {
    xp: 0,
    level: 0,              // total pick-events taken
    tier: 0,               // 0..5 — driven by milestones, NOT capacity
    picksThisTier: 0,      // toward the next tier-up milestone
    upgrades: {},          // { id: rank } — the whole build
    path: null,            // last chosen specialization (biases the pool)
    lives: PROG.START_LIVES,
    // flavor counters (stats only, not read by shipStats)
    catches: 0,
    smashes: 0,
    surveyed: 0,
  };
}

// ---- XP + pick bookkeeping (pure helpers over game.prog) --------------------

export function xpForPick(prog) { return PROG.XP_BASE + PROG.XP_STEP * prog.level; }
export function owesPick(prog) { return prog.xp >= xpForPick(prog); }
export function addXp(game, amount) {
  if (amount <= 0 || !game.ship || !game.ship.alive) return;
  game.prog.xp += amount;
}
// The next owed pick is a tier-up milestone once enough small picks are banked
// (until the top tier, after which it's small picks forever).
export function pickIsMilestone(prog) {
  return prog.tier < TIERS.caps.length - 1 && prog.picksThisTier >= PROG.PICKS_PER_TIER;
}
export function consumePickCost(prog) {
  prog.xp = Math.max(0, prog.xp - xpForPick(prog));
  prog.level++;
}
export function applyUpgrade(prog, id) {
  prog.upgrades[id] = (prog.upgrades[id] || 0) + 1;
}
export function applyPath(prog, id) {
  prog.path = id;
  const p = PATHS.find((x) => x.id === id);
  if (p && p.grant) {
    const u = upgradeById(p.grant);
    if (u && (prog.upgrades[p.grant] || 0) < u.max) applyUpgrade(prog, p.grant);
  }
  prog.tier = Math.min(TIERS.caps.length - 1, prog.tier + 1);
  prog.picksThisTier = 0;
}

// Weighted, no-replacement draw of `n` eligible upgrades for the choice cards.
// Eligibility = within the current tier's pool and not yet maxed; path bias
// nudges the odds toward the chosen specialization. Runtime randomness
// (Math.random) is intentional per the determinism rules.
export function pickChoices(prog, n = 2) {
  const path = PATHS.find((p) => p.id === prog.path);
  const bag = UPGRADES
    .filter((u) => prog.tier >= u.tiers[0] && prog.tier <= u.tiers[1] &&
      (prog.upgrades[u.id] || 0) < u.max)
    .map((u) => ({ u, w: u.weight * ((path && path.bias[u.id]) || 1) }));
  const chosen = [];
  while (chosen.length < n && bag.length) {
    let total = 0; for (const e of bag) total += e.w;
    let r = Math.random() * total, idx = 0;
    for (; idx < bag.length - 1; idx++) { r -= bag[idx].w; if (r <= 0) break; }
    chosen.push(bag[idx].u);
    bag.splice(idx, 1);
  }
  return chosen;
}

// Derived ship stats. Everything is a function of tier + earned upgrade ranks
// (no accumulators). The st field names match the old ones so every consumer
// is untouched; the new gate fields (has*/…Lvl) turn abilities on/scale them.
export function shipStats(prog) {
  const tier = prog.tier;
  const u = prog.upgrades || {};
  const r = (id) => u[id] || 0;
  const catchR = r('catchStrength'), beamR = r('beamReach'), hullR = r('hullPlate'),
    engineR = r('engine'), flingR = r('flingPower'), shieldR = r('shieldCap'),
    orbitR = r('orbitShield'), targR = r('targeting'), predR = r('predict'),
    compR = r('compass'), volR = r('volley'), magR = r('scrapMagnet'),
    senR = r('sensor'), regR = r('regen'), crashR = r('crashWarn'), revR = r('reverse');

  const capacity = TIERS.caps[tier] * (1 + 0.22 * catchR);
  const orbitLvl = orbitR;   // drives ring layout / interceptor reach in tractor.js
  const maxHull = 120 + 40 * tier + 60 * hullR;
  const shieldFrac = Math.min(0.55, (1 / 3) + 0.06 * shieldR);
  const hullMax = Math.round(maxHull * (1 - shieldFrac));

  // totalLevel feeds ENEMY scaling (ai.js) and SHIP MASS (physics.js). Keep it
  // in the old ~0..25 band so combat/physics balance is preserved.
  const rankSum = catchR + beamR + hullR + engineR + flingR + shieldR + orbitR +
    targR + predR + compR + volR + magR + senR + regR + crashR + revR;
  const totalLevel = Math.min(25, tier * 2 + Math.round(rankSum * 0.6));

  return {
    capacity,
    tier,
    label: TIERS.labels[tier],
    shipName: SHIP_NAMES[tier],
    // Beam reach base is sized against SHIP_ZOOM so the ring stays on-screen at
    // every tier; beamReach/orbit ranks extend it. The base is the old
    // [200,265,350,490,560,630] ladder tapered by a shrink that runs from -20%
    // at tier 0 to 0% at tier 5 (0.80 + 0.04*tier) — a tighter starting beam
    // that grows back to the same top-tier reach.
    range: [160, 223, 308, 451, 538, 630][tier] + 40 * beamR + 30 * orbitLvl,
    grabSlack: 70 + 22 * beamR,
    force: capacity * 55 * (0.6 + 0.12 * tier),
    maxSpeed: 280 + 40 * tier + 85 * engineR,
    thrust: 180 + 30 * tier + 105 * engineR,
    fling: 430 + 55 * tier + 190 * flingR,
    maxHull: Math.round(maxHull),
    // Pool splits hull (scrap-heal only) / shield (recharges); shieldCap shifts it
    hullMax,
    shieldMax: Math.round(maxHull) - hullMax,
    // Orbit shield is LOCKED until the orbitShield upgrade (rank 0 -> no slots)
    orbitCap: orbitR > 0 ? Math.max(tier >= 1 ? TIERS.caps[tier - 1] : 0, capacity * 0.45) : 0,
    orbitLabel: tier >= 1 ? TIERS.labels[tier - 1] : 'Small rocks',
    maxOrbiters: orbitR > 0 ? 2 * orbitR - 1 : 0,   // 1, 3, 5, 7 slots
    orbitLvl,
    // Kept for render (engine-flare size, chart-length) — indexed like the old levels
    levels: { beam: tier, orbit: orbitLvl, fling: flingR, hull: hullR, thrust: engineR, chart: senR },
    // ---- ability gates (new) ----
    hasReverse: revR > 0,
    hasTargeting: targR > 0,
    targetLvl: targR,
    targetReach: 0.6 + 0.25 * targR,     // x LOCK_T, when targeting is on
    targetMarkers: 2 + 2 * targR,        // how many ✕ markers show
    hasPredict: predR > 0,
    predictLvl: predR,
    hasCrashWarn: crashR > 0,
    hasCompass: compR > 0,
    compassLvl: compR,
    hasVolley: volR > 0,
    volleyLvl: volR,
    // ---- scaled passives (new) ----
    magnet: CFG.PICKUP_MAGNET * (1 + 0.4 * magR),
    sensorMul: 1 + 0.3 * senR,
    regen: CFG.SHIP_REGEN * (1 + 0.35 * regR),
    regenDelay: CFG.SHIP_REGEN_DELAY * (1 - 0.1 * regR),
    // Forecast horizon: only meaningful once the plotter is unlocked
    predictBoost: 1 + Math.min(1.1, 0.3 * Math.max(0, predR - 1) + 0.12 * senR),
    // Size/zoom are tier-driven ONLY (see the SHIP_RADIUS/SHIP_ZOOM comments)
    radius: SHIP_RADIUS[tier],
    zoomOut: 1.15 / SHIP_ZOOM[tier],
    totalLevel,
  };
}
