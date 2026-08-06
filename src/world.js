import {
  CFG, PROG, addXp, maxLives, fieldFrac, fieldLobe, worldDebris, crustMass,
  FIELD_LOBE_MAX, stormClass, stormStrength, stormSpent,
} from './config.js';
import { Body, railBody, railEllipse, makeChunk, chunkHaloW, resetBodyIds } from './entities.js';
import { seedGlowPockets, seedMoonGlow } from './glow.js';
import { TAU, mulberry32, rand, pick, CRYSTAL_REACH, padPos, surfaceVel, placeName } from './util.js';
import { pickShapeId, reachAt, shapeReach, rockOverlap, rockReach } from './rockshape.js';
import * as gravel from './gravel.js';
import { sfxPing } from './sfx.js';

// Recovered echo logs — one-line lore fragments carried by derelicts and
// oddities, shown once on the first grab (tractor.js sets game.echoMsg).
// Cheapest possible worldbuilding: strings on bodies.
const ECHOES = {
  stations: [
    'RECOVERED LOG — "…day 900. The relay still points at a star none of our charts contain."',
    'RECOVERED LOG — "…evacuation complete. If you find this: the forge moon was already burning when we arrived."',
    'RECOVERED LOG — "…they were never invaders. The nests grew from the cargo we abandoned."',
  ],
  hulk: 'RECOVERED LOG — "…too close to the sun, I know. The graveyard keeps what the light takes."',
  herald: 'RECOVERED LOG — "…final entry: we followed the ping past the ice line. It was already old when this sun was young."',
  carved: 'ANALYSIS — these facets are machined, not tumbled. Whoever cut this stone counted in sixes.',
  visitor: 'ANALYSIS — the lattice is annealed by aeons of starlight. This object is older than the sun.',
  // Expedition layer — payoff lines for the delivery quests + rescues.
  heraldWake: 'SIGNAL — "…wreck received. Our crew is home. The Herald resumes its watch — this reach of sky is yours to read."',
  wanderer: 'ANALYSIS — a cold dwarf, older than every chart. The relay was right: the sky was never finished being counted.',
  rescue: [
    'RESCUED PILOT — "Three days in that can. I had started naming the asteroids. Thank you."',
    'RESCUED PILOT — "I watched your beam light up through the pod glass. Prettiest thing I ever saw."',
    'RESCUED PILOT — "The nests took my ship past the ice line. Do not fly where I flew."',
  ],
};

// Planet archetypes — each type has its own palette and its own look in the
// renderer (lava glow, rocky continents, gas bands, ice caps, terran seas,
// dune fields, cloud shrouds, crystal facets) so the kinds read at a glance.
// Beyond gas/lava's core physics (dive/no-surface, heat immunity + magma
// lobs), each new archetype carries ONE mechanic, every one built on an
// existing battle-tested shape: terran = atmosphere burn-up (physics.step,
// the corona-heat shape), ocean = waterspout ammo (the cryo-geyser branch
// below), desert = dune-skim XP (the banded-moon rule, collideShipBody),
// shroud = cloud cloak (the dust-moon flag, ai.js), crystal = shard-polygon
// COLLIDER (util.crystalShards, shared with render) + facet-shard salvage
// (physics.damageBody).

// SYSTEM SCALE. Every sun-anchored AUTHORED distance in this file is spread
// through this one helper — buildLayout's gap ladder, the Farshoal's fringe
// berth, Vesper's semi-major axis, the fallback initialisers below. The
// authored numbers stay the readable SHAPE of the sky (and stay comparable
// with the notes written about them); CFG.SYS_R_MUL is the only thing that
// says how far apart it all sits. Radii that are DERIVED per seed (the lanes
// themselves, the field midpoints, the barge lane, the ghost, the dark star,
// the ship's spawn) inherit the scale through the gaps they were derived
// from, so the rule is unchanged in spirit: nothing sun-anchored is placed by
// an unscaled literal.
//
// PUT EVERY SUN-ANCHORED RADIUS THROUGH IT. The relationships between these
// numbers are load-bearing — the fields ride the gaps BETWEEN lanes, the
// graveyard sits below the innermost world and inside the flare zone, Vesper's
// perihelion sits ABOVE the graveyard, the carved stone rides the middle belt,
// the dark star threads two outer lanes — and one radius left unscaled quietly
// moves that piece of content into a lane it was designed to avoid.
// PLANET/MOON radii are a DIFFERENT knob (CFG.PLANET_R_MUL / MOON_R_MUL, the
// WORLD SCALE family): this spreads the sky out, those grow the worlds in it.
const SR = (r) => r * CFG.SYS_R_MUL;

// ...and A LANE THAT IS NAMED TWICE GETS A CONSTANT, not a second SR() call.
// The respawnable landmarks are each described in two places — the spawn
// function that places the body, and replenishWorld's off-view check that
// picks an arrival angle by testing where the body WOULD land. Those two must
// agree exactly, and when they were both bare literals the first scaling pass
// updated the spawn and missed the check: the test then measured a point
// thousands of units off the real orbit, so "never pop into existence in view"
// silently stopped being true. One binding read by both sites is what makes
// that unrepresentable, which a second SR() at the call site would not.
//
// SINCE THE SEEDED-LAYOUT PASS these are `let`s, RE-DERIVED once per
// generateWorld from the sky that run actually built (the graveyard from the
// sun's radius, the barge lane from the generated planet lanes) — but they
// stay the ONE binding both the spawn functions and the replenish checks
// read, which is the whole of the rule above. The initialisers only cover the
// window before the first generateWorld call ever runs.
let GRAVEYARD_R = SR(3250);           // the wreck ring, just above the corona
let VESPER_PERI = SR(3900);           // ...and Vesper's perihelion, deliberately above it
let VESPER_SEMI = SR(12000);
let TINKER_R = SR(12000);             // the barge's trade lane

const PTYPE_COLORS = {
  lava:    ['#e0603a', '#d4502c', '#e8784a'],
  rocky:   ['#c98a5a', '#b0895f', '#8fae62', '#c9b45a'],
  gas:     ['#d9a95c', '#5a9dc9', '#b05ac9', '#7bd9c9'],
  ice:     ['#a8cbe8', '#8fd9d0', '#9a9ad9'],
  terran:  ['#4f86c9', '#4a80bd', '#5a8fd0'],
  ocean:   ['#3a6fc4', '#3568b8', '#4278cf'],
  desert:  ['#d4a55a', '#c9974e', '#ddb26a'],
  shroud:  ['#c9bd7a', '#bfae66', '#d2c489'],
  crystal: ['#a98fd9', '#9a7fd4', '#b89fe4'],
};
// Gas giants additionally vary by gasKind (render-only — physics keys on
// ptype 'gas' alone, so a kind can never fork the sim): amber = classic
// banded giant, azure = smooth ice giant, violet = exotic swirl. The color
// pick still burns exactly ONE rng draw, keeping the seeded stream identical.
const GAS_KIND_COLORS = {
  amber:  ['#d9a95c', '#d4a24e', '#e0b26a'],
  azure:  ['#5a9dc9', '#4f93c4', '#7bd9c9'],
  violet: ['#b05ac9', '#a04fc0', '#c06ad4'],
};
// THE NAME POOLS — one per archetype (user call, 2026-08), so a name carries
// its world's flavour and different seeds wear genuinely different names
// instead of one 19-name deck re-dealt. Rules that keep this safe:
//  - Pools are DISJOINT and each is 10 deep against a worst per-type count of
//    ~4 (exactly three gas giants is structural; the duplicated archetypes cap
//    around there), so no run can wrap a pool — a wrap is two worlds with one
//    name, which makes chart messages and window.goto ambiguous (the old
//    14-name list actually shipped that bug).
//  - Names come off a PRIVATE stream forked from the run seed (nameRng in
//    generateWorld), NEVER the world rng — and the old shared-pool shuffle is
//    still burned and discarded there, so every existing seed's layout is
//    bit-identical and only the nameplates changed ("kept and discarded",
//    the retrograde-lane rule).
//  - The legacy 19 names live on, each filed under the archetype it read
//    best on, so long-running players still meet familiar worlds.
const PLANET_NAME_POOLS = {
  lava:    ['Vantor', 'Cindral', 'Pyrris', 'Scoria', 'Brasque', 'Ashvel', 'Kilnor', 'Fervel', 'Charwyn', 'Emberis'],
  rocky:   ['Sable', 'Wold', 'Tantal', 'Drex', 'Cairnos', 'Gravon', 'Torvel', 'Rhud', 'Manthe', 'Ferrow'],
  gas:     ['Ymir', 'Ferren', 'Naiad', 'Boreth', 'Vashtar', 'Ondrel', 'Maelgor', 'Threx', 'Ullur', 'Grandis'],
  ice:     ['Brune', 'Pell', 'Ison', 'Rimhel', 'Frael', 'Vintra', 'Skade', 'Halvor', 'Nivelle', 'Tundrel'],
  terran:  ['Corve', 'Calyx', 'Quorra', 'Verdane', 'Sylva', 'Loamis', 'Talem', 'Rilla', 'Everin', 'Arbore'],
  ocean:   ['Halcyon', 'Maris', 'Thalos', 'Brinn', 'Undine', 'Delmar', 'Sirene', 'Fathom', 'Swale', 'Lagune'],
  desert:  ['Khepri', 'Dunreth', 'Sirocco', 'Ochra', 'Zephris', 'Barchan', 'Mesarra', 'Harmat', 'Aridas', 'Sabkha'],
  shroud:  ['Nerev', 'Velmar', 'Pallis', 'Obscura', 'Mistrel', 'Duskren', 'Gauzel', 'Murken', 'Shrivane', 'Cirralis'],
  crystal: ['Ossia', 'Aster', 'Prisme', 'Lucent', 'Beryl', 'Quarzen', 'Selen', 'Kyrast', 'Virell', 'Faceze'],
};
// The legacy shared pool. STILL LOAD-BEARING twice over: generateWorld burns
// its shuffle on the world rng (removing those draws would re-jitter every
// seeded sky), and addPlanet's no-name fallback still picks from it.
const PLANET_NAMES = ['Khepri', 'Vantor', 'Ossia', 'Brune', 'Calyx', 'Nerev', 'Tantal', 'Ymir', 'Quorra', 'Pell', 'Sable', 'Ison', 'Halcyon', 'Drex', 'Ferren', 'Wold', 'Corve', 'Naiad', 'Aster'];

// Moon archetypes — like planets, each kind has its own palette and a distinct
// renderer look (render.js drawMoonDetail), plus a mass/size skew, so a
// planet's moon family reads as a set of little worlds instead of pale clones.
// w = spawn weight; the render.js switch keys off `type`.
const MOON_TYPES = [
  { type: 'rock',   w: 3, colors: ['#9a8f7f', '#8c8072', '#a89a86'], mMul: 1.0,  rMul: 1.0 },
  { type: 'ice',    w: 3, colors: ['#cfe4f5', '#d3d9ec', '#bfe0ea'], mMul: 0.8,  rMul: 1.18 },
  { type: 'iron',   w: 2, colors: ['#8a8d96', '#7c7f88', '#9aa0ab'], mMul: 1.55, rMul: 0.82 },
  { type: 'dust',   w: 2, colors: ['#6a655f', '#5f5a55', '#746d65'], mMul: 0.9,  rMul: 1.02 },
  { type: 'sulfur', w: 1, colors: ['#c9a24b', '#b5763a', '#d4b45a'], mMul: 1.0,  rMul: 0.94 },
  { type: 'banded', w: 1, colors: ['#a99a86', '#93a0b2', '#b0a58f'], mMul: 1.1,  rMul: 1.06 },
  // The 2026-08 variety pass — six more jobs, one mechanic each (see the
  // "moons with jobs" ledger in docs/world-content.md):
  //   lodestar — impossibly dense micro-moon: gravity as terrain, the longest
  //     winch in the sky. The "every moon shelters" law (STORM_SHADOW_MIN_R
  //     24) is guaranteed by spawnMoon's 26-unit radius clamp — lodestar's
  //     low tail is the only roll that ever touches it.
  //   geode  — a player kill frees a dense mineral core (physics.shatter).
  //   verdant— hosts a slowly-regrowing glow pocket in low orbit (glow.js).
  //   comet  — rides the most eccentric ellipse its slot allows and vents its
  //     geysers only near periapsis (the hazard loop below).
  //   husk   — wreck-plated; a hard player smash calls a wreckwright down on it
  //     (physics.damageBody -> ai.js), and the moon itself is richer salvage.
  //   pumice — featherweight for its size: impacts bury instead of bouncing and
  //     the crust crumbles at double rate (physics.js, both).
  // mMul 4.5 tops the roll out at 49,500 — DELIBERATELY 1% under the 5e4
  // rail-disturber threshold (see crustMass's ceiling note). Bumping it past
  // 4.54 silently makes every big lodestar a planet-class disturber.
  { type: 'lodestar', w: 1, colors: ['#5a5661', '#4e4a57', '#66626f'], mMul: 4.5,  rMul: 0.5 },
  { type: 'geode',    w: 1, colors: ['#8d8494', '#978c9c', '#7f7787'], mMul: 1.15, rMul: 0.98 },
  { type: 'verdant',  w: 1, colors: ['#7fae8d', '#6da184', '#8fbf9a'], mMul: 0.95, rMul: 1.08 },
  { type: 'comet',    w: 1, colors: ['#cde8ea', '#bfdfe6', '#d8ecf2'], mMul: 0.7,  rMul: 0.9 },
  { type: 'husk',     w: 1, colors: ['#8f7f72', '#7d7a80', '#997f66'], mMul: 1.2,  rMul: 0.96 },
  // Chalk-pale on purpose — a 2026-08 user call ("Shale and Curd look too
  // similar") split pumice off the rock moon: colder, brighter ground, and
  // the renderer draws vesicle stipple ONLY, never the shared crater set.
  { type: 'pumice',   w: 2, colors: ['#d8d3c6', '#cfc9ba', '#e0dbd0'], mMul: 0.45, rMul: 1.28 },
  //   molten — a cooled black crust over live magma (2026-08 user call):
  //     mostly dark, ember cracks throughout (render), and SEARING to skid
  //     on (physics.js skim venom, alongside sulfur's poison).
  { type: 'molten',   w: 1, colors: ['#2e2428', '#282025', '#362a2b'], mMul: 1.1,  rMul: 0.92 },
];
const MOON_TYPE_TOTAL = MOON_TYPES.reduce((s, m) => s + m.w, 0);
function pickMoonType(rng) {
  let r = rng() * MOON_TYPE_TOTAL;
  for (const mt of MOON_TYPES) { if ((r -= mt.w) < 0) return mt; }
  return MOON_TYPES[0];
}

// EVERY MOON CARRIES A NAME now, drawn from its type's own pool — the pools are
// the vocabulary, the seed decides who wears what (same contract as
// PLANET_NAMES). The chart still draws moons as icons, never labels
// (render.labelsItself keys off type): a name is READOUT knowledge, earned by
// charting, and it feeds the storm-lee message and the journey rail.
const MOON_NAMES = {
  rock:     ['Cairn', 'Tor', 'Scarp', 'Fell', 'Crag', 'Shale', 'Combe', 'Karst', 'Gault', 'Whin', 'Dolm', 'Stane'],
  ice:      ['Rime', 'Firn', 'Floe', 'Serac', 'Hoar', 'Nilas', 'Verglas', 'Brume', 'Frazil', 'Graupel', 'Sleet', 'Thaw'],
  iron:     ['Anvil', 'Ingot', 'Rivet', 'Girder', 'Pyrite', 'Taconite', 'Ferrule', 'Hematite', 'Lode', 'Smelt', 'Wootz'],
  dust:     ['Pall', 'Murk', 'Hush', 'Soot', 'Gloam', 'Dun', 'Ash', 'Smirch', 'Haze', 'Sift', 'Silt'],
  sulfur:   ['Brimstone', 'Fume', 'Reek', 'Ochre', 'Saffron', 'Vitriol', 'Tarnish', 'Mordant', 'Gall', 'Sallow'],
  banded:   ['Strata', 'Vein', 'Warp', 'Weft', 'Loom', 'Twill', 'Chine', 'Lamina', 'Plait', 'Marl'],
  lodestar: ['Plumb', 'Ballast', 'Fathom', 'Keel', 'Sinker', 'Gnomon', 'Heft', 'Burden', 'Fulcrum', 'Dram'],
  geode:    ['Druse', 'Vug', 'Agate', 'Seam', 'Kernel', 'Pith', 'Locket', 'Casket', 'Cameo', 'Bezel'],
  verdant:  ['Moss', 'Sward', 'Lichen', 'Fern', 'Verdure', 'Sylva', 'Bower', 'Bracken', 'Clover', 'Loam'],
  comet:    ['Wisp', 'Veil', 'Skein', 'Plume', 'Banner', 'Pennant', 'Streamer', 'Tress', 'Gossamer', 'Sillage'],
  husk:     ['Hulk', 'Wrack', 'Gantry', 'Spar', 'Bulwark', 'Derrick', 'Keelson', 'Scuttle', 'Jetsam', 'Flotsam'],
  pumice:   ['Tuff', 'Scoria', 'Froth', 'Spume', 'Barm', 'Lather', 'Crumb', 'Chalk', 'Curd', 'Wafer'],
  molten:   ['Cinder', 'Ember', 'Char', 'Scald', 'Basalt', 'Gutter', 'Smolder', 'Furnace', 'Kindle', 'Brazier'],
};
// Per-run naming state. Reset by generateWorld off a FORKED stream, never the
// main world rng: names are assigned mid-spawn (spawnMoon), and drawing the
// main rng there would violate the append-only rule on the seeded stream (see
// the EXPEDITION LAYER note in generateWorld) and reshuffle the whole sky.
let moonNamePools = null;
function resetMoonNames(seed) {
  const nrng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  moonNamePools = {};
  for (const k in MOON_NAMES) {
    const pool = MOON_NAMES[k].slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(nrng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    moonNamePools[k] = { pool, next: 0 };
  }
}
// Pools wrap with a numeral rather than duplicating: two moons with one name
// is the exact ambiguity the 19-name planet pool exists to prevent.
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function moonName(type) {
  const st = moonNamePools && moonNamePools[type];
  if (!st) return null;
  const n = st.next++;
  const base = st.pool[n % st.pool.length];
  const round = Math.floor(n / st.pool.length);
  return round ? `${base} ${ROMAN[round - 1] || round + 1}` : base;
}

// Circular-orbit velocity around a parent at distance r, plus the parent's own
// velocity. Uses the SOFTENED gravity the sim actually applies, so initial
// orbits are truly circular even close-in (matters for moons).
function orbitVel(parent, x, y, dir = 1) {
  const dx = x - parent.x, dy = y - parent.y;
  const r = Math.hypot(dx, dy);
  const soft2 = CFG.GRAV_SOFT * CFG.GRAV_SOFT;
  const accel = (CFG.G * parent.mass * r) / Math.pow(r * r + soft2, 1.5);
  const s = Math.sqrt(accel * r) * dir;
  const th = Math.atan2(dy, dx);
  return { vx: parent.vx - Math.sin(th) * s, vy: parent.vy + Math.cos(th) * s };
}

function spawnMoon(bodies, rng, planet, mr, exCap = Infinity) {
  // Archetype sets the palette + look and skews mass/size, so a moon family
  // spans ice, rock, iron, dust, sulfur, banded instead of pale clones.
  const mt = pickMoonType(rng);
  const t = rng();
  // x CFG.MOON_R_MUL, applied to the finished expression so the ±2 jitter
  // scales with the moon instead of shrinking into an invisible wobble on a
  // body several times the size. The trailing x0.8-1.2 is the SEEDED size
  // spread of the 2026-08 growth pass: under MOON_R_MUL 5 it spans 4-6x the
  // authored range — "2x to 3x bigger" than the MOON_R_MUL 2 sky the margins
  // below were first sized against. Every clearance that has to cover a moon
  // radius (moonZone's floor, the sibling margin in addPlanet, replenish's
  // refill clearance) is sized for the TOP of this spread, jitter included.
  // Mass is untouched; see the WORLD SCALE note on CFG.MOON_R_MUL for why
  // size and mass part ways.
  // 2026-08 "more size variety" pass: BOTH spread terms widened x1.3 around
  // their unchanged means (base 26±10.4, was ±8; seeded jitter ±26%, was
  // ±20%) — the sky's min-to-max moon range grows ~30%. The top of the
  // spread grew ~253 -> ~306 (pumice rMul 1.28, jitter included), and every
  // clearance solved against the old top moved with it: addPlanet's 180 slot
  // floor -> 220, its 80x shared-edge margin -> 100, replenishWorld's 110x
  // refill clearance -> 130. The FLOOR is clamped at 26 world units: under
  // STORM_SHADOW_MIN_R (24) a moon casts no lee and "every moon shelters" is
  // a law — only a lodestar's (rMul 0.5) low tail ever touches the clamp.
  const radius = Math.max(26,
    ((15.6 + t * 20.8) * mt.rMul + rand(rng, -2, 2)) * CFG.MOON_R_MUL
    * rand(rng, 0.74, 1.26));
  // Moons run the gamut now — some are proper little worlds, and at these
  // masses they're real attractors. (The old sub-ATTRACT_MIN test-particle
  // rule predates rails: it only ever mattered for LIVE moons, and rails
  // hold their orbits exact regardless.) A MOON IS ITS OWN BEAM CLASS
  // (config.liftClass) whatever it weighs — tier 3 for the small ones, tier 4
  // past TIERS.ceil[3] — so mooncatching is earned no matter how light the
  // roll came out, and a light moon is never sold at the boulder tier.
  const mass = (3000 + t * 8000) * mt.mMul;
  const dir = rng() < 0.85 ? 1 : -1;
  const m = new Body({
    type: 'moon', x: planet.x + mr, y: planet.y, vx: 0, vy: 0,
    mass, radius, color: pick(rng, mt.colors), parent: planet,
  });
  m.moonType = mt.type;
  // Off the forked naming stream (see resetMoonNames) — zero main-rng draws.
  m.name = moonName(mt.type);
  bodies.push(m);
  // ~55% of moons ride an ELLIPSE (railEllipse), the rest circular. mr is the
  // semi-major axis; e is capped so periapsis always clears the planet. Tight
  // inner slots fall back to circular. arg + phase are randomised so orbits
  // don't share an apsidal line.
  //
  // NEIGHBOUR CLEARANCE (exCap): callers pass the max radial excursion (e*mr,
  // world units) this orbit may take without reaching a sibling's orbit. Two
  // confocal orbits whose radial ranges overlap ALWAYS intersect in space, so
  // an "overlapping" ellipse is a guaranteed crossing — and a crossing pair
  // eventually collides. This was a real bug: the default seed spawned two
  // crossing pairs in the inner gas giant's family; both pairs collided at
  // t≈151s/176s, all four moons derailed, lost energy to the damped inelastic
  // bounces, and sank into the planet ("absorbed" at t≈202-267s) — 4 of 45
  // moons deterministically dead in the first 4.5 minutes of every run.
  // e is DRAWN first and clamped after, so the seeded rng stream (and thus
  // the rest of the generated world) is untouched by the clamp.
  // MOON_E_MAX, not a literal: moonZone reads the same ceiling to work out the
  // apoapsis a family can reach, and the boundary clamp there is only correct
  // while the two agree.
  const eCap = Math.min(CFG.MOON_E_MAX, 1 - (planet.radius + radius + 60) / mr);
  // A COMET MOON takes the ellipse branch whenever its slot allows one at all,
  // and rides the WIDEST swing the slot permits — periapsis is where it vents,
  // so the orbit IS the mechanic. The rng() branch draw stays first in the ||
  // so it is drawn (and discarded) for a comet too — the retrograde-lane idiom:
  // never buy a constant with the seeded stream — and `e` is still drawn
  // before the override, so the ellipse branch's draw count is unchanged.
  if (eCap > 0.08 && (rng() < 0.55 || mt.type === 'comet')) {
    let e = Math.max(0, Math.min(rand(rng, 0.1, eCap), exCap / mr));
    if (mt.type === 'comet') e = Math.max(0, Math.min(eCap, exCap / mr));
    railEllipse(m, planet, mr, e, rng() * TAU, rng() * TAU, dir);
  } else {
    const mth = rng() * TAU;
    m.x = planet.x + Math.cos(mth) * mr;
    m.y = planet.y + Math.sin(mth) * mr;
    const mv = orbitVel(planet, m.x, m.y, dir);
    m.vx = mv.vx; m.vy = mv.vy;
    railBody(m, planet);
  }
  return m;
}

// How far out this planet can hold a moon. Rails hold moons on their orbits
// regardless of the sun's tide, so the zone extends far beyond raw Hill
// stability — wide, majestic moon systems. (A derailed outer moon may drift
// off and re-rail around the sun; that's fine and rare.)
function moonZone(star, planet, orbitR) {
  const hill = orbitR * Math.cbrt(planet.mass / (3 * star.mass));
  // ...AND THE BOUNDARY IS WHAT ACTUALLY ENDS IT (invariant 6: WORLD_R must
  // exceed every system's outermost reach). The zone is a multiple of the Hill
  // radius and Hill grows with orbitR, so the widest families in the sky are
  // the outer band's — exactly where there is least room left before the edge.
  // That used to be checked by arithmetic done by hand whenever the layout
  // moved, and it had quietly stopped holding: at the authored 1.5x the
  // outermost world's single moon already reached ~2,500 past WORLD_R, and
  // widening the zone to MOON_ZONE_MUL would have taken that past 6,000. It is
  // benign only for as long as the moon stays railed (star-anchored bodies are
  // exempt from the boundary force); one derail and the edge is pushing on a
  // charted moon. Bound it by construction instead — the same idiom as
  // CRUST_PER_HOST and GAS_STRIP_EJECTA. An ellipse reaches a*(1+e) and
  // spawnMoon's eCap tops out at MOON_E_MAX, so THAT is the multiple of maxR
  // the boundary has to leave room for, not maxR itself.
  const room = Math.max(0, CFG.WORLD_R - orbitR) / (1 + CFG.MOON_E_MAX);
  // The inner clearance rides MOON_R_MUL because that is what it is FOR: 90
  // comfortably cleared a 42-radius moon, and a doubled moon parked on the old
  // floor would hang 84 units into a planet that also grew underneath it.
  // ...AND THE FLOOR IS PROPORTIONAL NOW TOO (user call, 2026-08: moons —
  // "especially" the gas giants' — orbited visibly inside their own world's
  // drawn kit). The absolute term covers small worlds; the proportional term
  // covers what each archetype DRAWS around itself: a ring's outer band
  // reaches ~2.2r (render.drawRing at 2.14r + half its stroke), the terran
  // burn deck 1.58r, a crystal's spikes 1.32r — so a ringed world's family
  // starts clear of its rings and a terran's clear of its sky. The ring-gap
  // SHEPHERD is spawned pinned to its lane by its own path (spawnShepherd)
  // and never consults this zone; a tighter zone degrades to FEWER moons via
  // spawnMoon's count clamp, never to a crossing pair.
  const propFloor = planet.ring ? 2.5
    : planet.ptype === 'terran' ? 1.75
    : planet.ptype === 'crystal' ? 1.6 : 1.45;
  return {
    minR: Math.max(planet.radius + 90 * CFG.MOON_R_MUL, planet.radius * propFloor),
    maxR: Math.min(hill * CFG.MOON_ZONE_MUL, room),
  };
}

function addPlanet(bodies, rng, star, orbitR, mass, radius, opts = {}) {
  // opts.ang pins the orbital angle — co-orbital companions must sit at a
  // FIXED offset from their lane host, not at a fresh draw (a random angle
  // could land the pair in the same area of the sky, the one thing a shared
  // lane must never do).
  const th = opts.ang !== undefined ? opts.ang : rng() * TAU;
  const x = star.x + Math.cos(th) * orbitR;
  const y = star.y + Math.sin(th) * orbitR;
  // EVERY PLANET ORBITS THE SUN THE SAME WAY (user design law). One in six
  // worlds used to be drawn retrograde, and a retrograde lane meets each of
  // its neighbours at the SUM of their angular speeds instead of the
  // difference — conjunctions with the lanes on either side of it come round
  // several times more often, and each one closes at roughly twice the speed.
  // Moon families deliberately overlap radially (see the railed-conjunction
  // pass-through in physics.collideBodies), and that pass-through is gated on
  // closing < DMG_THRESH: a prograde conjunction drifts through under the gate,
  // a retrograde one arrives above it, which is a real impact, a derail, and a
  // moon that falls into whatever it is near. Making the sky turn one way
  // deletes that whole class of event instead of guarding it.
  // The draw is KEPT and discarded: every angle, mass and feature in the sky
  // below this point comes out of the same seeded stream, so buying a constant
  // by removing a draw would reshuffle the entire world (see the WORLD SCALE
  // note in spawnMoon — never pay for a value with the rng stream).
  rng();
  const dir = 1;
  const v = orbitVel(star, x, y, dir);
  const ptype = opts.ptype || 'rocky';
  const p = new Body({
    type: 'planet', x, y, vx: v.vx, vy: v.vy, mass, radius,
    color: pick(rng, opts.gasKind ? GAS_KIND_COLORS[opts.gasKind] : PTYPE_COLORS[ptype]),
    name: opts.name || pick(rng, PLANET_NAMES),
    ring: opts.ring || false,
    ptype,
    parent: star,
  });
  if (opts.gasKind) p.gasKind = opts.gasKind;
  bodies.push(p);
  railBody(p, star);

  // Moons spread across the whole stable zone — big outer planets get wide,
  // varied moon families instead of a tight string of pearls. Each moon's
  // radial excursion is confined to its own spawn slot (minus a 45u margin
  // per side — covers both bodies' radii), so sibling orbits can never
  // overlap radially, which is exactly the no-crossing condition (see the
  // exCap rationale in spawnMoon). That margin rides MOON_R_MUL: it is sized
  // to cover BOTH moons' radii, and at 2x two 84-radius siblings need 168 of
  // separation where the authored 45-per-side only guarantees 90 — which is
  // the crossing-orbits bug again, arriving through the back door.
  // Only edges SHARED with a sibling are
  // capped: the innermost moon's sunward reach is already guarded by the
  // planet-clearance term in spawnMoon, and the outermost may spill past
  // maxR like it always did (rails don't care). Keeping non-shared edges
  // uncapped matters: it leaves every NON-crossing orbit bit-identical to
  // the pre-fix worldgen — moons are attractors, so needlessly moving them
  // perturbs every free-flyer's path and re-rolls the whole sky's fate.
  // THE COUNT IS CLAMPED TO WHAT THE ZONE CAN SLOT. Moon counts are a seeded
  // draw now (up to 1.5x the authored base) and moon radii span up to ~306
  // units at the top of spawnMoon's widened jitter, so a small world's zone
  // can be asked for more family than it can hold apart. A slot floor of
  // 220*MOON_R_MUL (1100 at 5) is sized so the tightened placement draw below
  // keeps even two top-of-jitter siblings clear: min adjacent separation is
  // 0.6 slotW (the 0.3-0.7 draw), i.e. >=660, against ~612 for two max moons.
  // Chunk-shell clearance on top of that is seedDebrisBelts' own job — it
  // measures real slack per moon and shrinks or skips the shell.
  // An over-draw therefore degrades to FEWER moons, never to a crossing pair.
  const { minR, maxR } = moonZone(star, p, orbitR);
  const count = Math.min(opts.moons || 0,
    Math.floor((maxR - minR) / (220 * CFG.MOON_R_MUL)));
  if (count > 0) {
    if (maxR > minR + 50) {
      const slotW = (maxR - minR) / count;
      for (let i = 0; i < count; i++) {
        // 0.3-0.7 of the slot (was 0.1-0.85): the wider draw let adjacent
        // moons land 0.25 slotW apart, which two grown-and-jittered moons no
        // longer fit inside. 0.6 slotW of guaranteed separation is what the
        // count clamp above is solved against.
        const t = (i + rand(rng, 0.3, 0.7)) / count;
        const mr = minR + (maxR - minR) * t;
        const lo = minR + slotW * i;
        const dLo = i > 0 ? mr - lo : Infinity;
        const dHi = i < count - 1 ? lo + slotW - mr : Infinity;
        // 100*MOON_R_MUL of shared-edge margin (was 45, then 80): sized to
        // cover two top-of-jitter moon radii (~612 since the widened spread)
        // PLUS both their chunk shells (seedDebrisBelts hangs rubble out to
        // 1.5x a moon's radius), so an elliptical excursion can never reach a
        // sibling's shell.
        spawnMoon(bodies, rng, p, mr, Math.min(dLo, dHi) - 100 * CFG.MOON_R_MUL);
      }
    }
  }
  return p;
}

// A derelict station in orbit: light enough to steal, tough enough that the
// jackpot takes a real hit. Shattering one drops salvage modules (physics.js).
// maxR caps the orbit where the host has a close NEIGHBOUR rather than open
// space around it — the binary companion is the only such host, and at 3x
// radii its 2.6r station orbit reached back inside the primary.
function addStation(bodies, rng, planet, maxR = Infinity) {
  const r = Math.min(planet.radius * 2.6 + 60, maxR);
  const th = rng() * TAU;
  const x = planet.x + Math.cos(th) * r, y = planet.y + Math.sin(th) * r;
  const v = orbitVel(planet, x, y, 1);
  const st = new Body({
    type: 'station', x, y, vx: v.vx, vy: v.vy,
    mass: 1900, radius: 26, hp: 130,
    color: '#8fa3b8', name: 'Derelict Station', parent: planet,
  });
  bodies.push(st);
  railBody(st, planet);
  return st;
}

// An alien nest: the grabber waves come FROM these. Destroy it and its
// region goes quiet. High hp — cracking one is a siege, not a drive-by.
function addNest(bodies, rng, planet) {
  const r = planet.radius * 3.4 + 120;
  const th = rng() * TAU;
  const x = planet.x + Math.cos(th) * r, y = planet.y + Math.sin(th) * r;
  const v = orbitVel(planet, x, y, 1);
  const n = new Body({
    type: 'nest', x, y, vx: v.vx, vy: v.vy,
    mass: 1800, radius: 30, hp: 520,
    color: '#69a24e', name: 'Alien Nest', parent: planet,
  });
  bodies.push(n);
  railBody(n, planet);
  return n;
}

// The ring-gap shepherd moonlet, in its lane. Shared by generateWorld and
// the replenish respawn (ambient deaths only — player kills are permanent).
function spawnShepherd(game, host, th) {
  const r = host.radius * 1.9;
  const x = host.x + Math.cos(th) * r, y = host.y + Math.sin(th) * r;
  const v = orbitVel(host, x, y, 1);
  const sh = new Body({
    type: 'moon', x, y, vx: v.vx, vy: v.vy,
    // Scaled like any other moon (WORLD SCALE) — it is a moonlet, and next to
    // a giant that grew 2.6x it would otherwise be a mote holding open a gap
    // you can no longer see it in.
    mass: 900, radius: 9 * CFG.MOON_R_MUL, color: '#e8ddc0', name: 'Shepherd', parent: host,
    // Override hp (default massToHp(900) ≈ 11): ambient ring-chunk bumps
    // killed it within ~20 idle minutes in soak testing. The ring-scatter
    // consequence should follow a PLAYER choice, not background noise —
    // a deliberate fling still one-shots it easily. It also station-keeps
    // (physics.js `install`) so knocks can't drag it out of its lane.
    hp: 120,
  });
  sh.shepherd = true;
  sh.chartKey = 'shepherd';   // set HERE so a respawned shepherd stays chartable
  game.bodies.push(sh);
  railBody(sh, host);
  game.shepherd = sh;
  return sh;
}

// THE TINKER BARGE's rotating shopping list. Matching is by the same flags
// the rest of the sim already uses; the junk want EXCLUDES wrecks, the carved
// stone, and the interstellar visitor — they're junk-flagged for scrap value,
// and the barge must never eat a landmark.
const TINKER_WANTS = [
  { id: 'crystal', label: 'a mineral core crystal', match: (b) => !!b.core },
  { id: 'ice',     label: 'an ice chunk',           match: (b) => !!b.ice },
  { id: 'wreck',   label: 'graveyard wreck salvage', match: (b) => !!b.wreck },
  { id: 'junk',    label: 'a dead satellite',       match: (b) => !!b.junk && !b.wreck && !b.carved && !b.visitor },
];

// Does this body satisfy (or crackably precede) a want? Cored rocks count
// toward crystal — the shell just needs one smash, so a cored rock in the
// neighborhood makes the crystal want fair to ask.
function wantSupply(w, b) {
  if (w.id === 'crystal') return !!(b.core || b.cored);
  return !!w.match(b);
}

// Census of what's actually obtainable near the barge right now.
function tinkerWantCounts(game) {
  const counts = { crystal: 0, ice: 0, wreck: 0, junk: 0 };
  const tk = game.tinker;
  if (!tk || !tk.alive) return counts;
  for (const b of game.bodies) {
    if (!b.alive || b === tk) continue;
    if (Math.hypot(b.x - tk.x, b.y - tk.y) > CFG.TINKER_WANT_R) continue;
    for (const w of TINKER_WANTS) if (wantSupply(w, b)) counts[w.id]++;
  }
  return counts;
}

// The barge only asks for things CLOSE BY (user design rule): offer only
// wants with a couple of matches in the neighborhood census; if nothing is
// plentiful, ask for whatever there's most of. The graveyard-wreck want thus
// only ever comes up when wrecks have actually been hauled into the region.
function pickTinkerWant(game, not) {
  const counts = tinkerWantCounts(game);
  const bag = TINKER_WANTS.filter((w) => w !== not && counts[w.id] >= 2);
  if (bag.length) return bag[Math.floor(Math.random() * bag.length)];
  // Nothing plentiful: ask for whatever there's most of — but only a want
  // with NONZERO supply (bc starts at 0), never a bare impossible ask.
  let best = null, bc = 0;
  for (const w of TINKER_WANTS) {
    if (w === not) continue;
    if (counts[w.id] > bc) { bc = counts[w.id]; best = w; }
  }
  return best || TINKER_WANTS[1];   // truly nothing around: ice — the barge's own payments reseed it
}

// The Tinker Barge, working its trade lane at r≈12000 — the system's ONE
// friendly vessel. Shared by generateWorld (seeded angle) and the replenish
// respawn (ambient deaths only — a player kill is permanent, exactly the
// shepherd's rule: consequence must trace to a player choice, and a trader
// you can lose forever gives its hp meaning). type 'station' + a live parent
// puts it in the physics `install` set for free, so it station-keeps and can
// never wander off its lane.
function spawnTinker(game, sun, th) {
  const r = TINKER_R;
  const x = sun.x + Math.cos(th) * r, y = sun.y + Math.sin(th) * r;
  const v = orbitVel(sun, x, y, 1);
  const tk = new Body({
    type: 'station', x, y, vx: v.vx, vy: v.vy,
    // Mass 1900 like the derelicts, and DELIBERATELY under ATTRACT_MIN
    // (2000): installations are never attractors — a knocked-loose attractor
    // feels celestials at full gravity while they feel it at CROSS_GRAV, the
    // asymmetry the weighted-gravity invariant exists to avoid.
    mass: 1900, radius: 24,
    color: '#c9a86a', name: 'Tinker Barge', parent: sun,
    // Override hp (derelicts run 130): the barge must shrug off belt noise —
    // losing the one trader to ambient traffic is not a story. A deliberate
    // player assault still kills it, permanently.
    hp: 400,
  });
  tk.tinker = true;
  tk.chartKey = 'tinker';   // set HERE so a respawned barge stays chartable
  game.bodies.push(tk);
  railBody(tk, sun);
  game.tinker = tk;   // assigned BEFORE the want pick — the census reads tk's position
  game.tinkerWant = pickTinkerWant(game, game.tinkerWant || null);
  return tk;
}

// Comet Vesper at perihelion, falling into a fresh pass. Shared by
// generateWorld (seeded angle) and the replenish respawn (random angle).
function spawnVesper(game, sun, th) {
  // SYSTEM SCALE: BOTH ends of the ellipse, or the shape of the orbit changes
  // rather than its size — and the perihelion has to keep clearing the
  // graveyard ring, which moved with it. vp is computed from the sun's mass
  // below, so the speeds follow the geometry on their own.
  const peri = VESPER_PERI, semi = VESPER_SEMI;
  const vp = Math.sqrt(CFG.G * sun.mass * (2 / peri - 1 / semi));
  const c = spawnAsteroid(game.bodies,
    sun.x + Math.cos(th) * peri, sun.y + Math.sin(th) * peri,
    -Math.sin(th) * vp, Math.cos(th) * vp, 2400);
  c.comet = true; c.cometT = Infinity; c.majorComet = true;
  c.name = 'Comet Vesper'; c.color = '#d8f4ff';
  c.chartKey = 'vesper';   // set HERE so a respawned Vesper stays chartable (keys, not bodies)
  // A landmark must outlive ambient traffic: its orbit crosses every belt
  // and planet lane between 3900 and 20100, and at default massToHp (~29)
  // a single hard crunch shattered it within ~10 minutes in soak testing.
  // Override hp like stations do — the natural-hit cap (70% of remaining
  // hp) then means only deliberate player throws can actually finish it.
  c.hp = c.maxHp = 500;
  game.vesper = c;
  return c;
}

// Radius from mass. Shrunk to match the small starting hull (the drawn scout
// body disc, ~2.6 world units — NOT SHIP_RADIUS[0], which is now the larger
// hitbox): the old 1.6 + cbrt*0.78 bottomed out at ~3.5, so even a "pebble"
// out-sized the scout. This drops the floor and slope so common rocks land
// ~1.7-3.3 (peer to / smaller than the ship) while boulders stay clearly
// chunky (~9-12). Mass is untouched, so gravity, grab tiers, hp and scrap
// are all unchanged — only the drawn/collision disc shrinks.
export function asteroidRadius(mass) { return 0.5 + Math.cbrt(mass) * 0.62; }

// Skewed small (down to pebbles), occasionally chunky — and ~12% are
// BOULDERS, a class between common rocks and moons that keeps the size
// ladder readable. The small tail sits HIGHER than it used to (user call,
// 2026-08: pebbles up to ~twice their old mass): floor 15 -> 40 and skew
// 2.2 -> 1.8 double the ~30-300 pebble band while the 1,000+ rock and the
// branch ceiling (2,600, where boulders take over) stay where they were —
// every draw still lands in the same beam classes, so TIERS is untouched.
// KNOW WHAT RETUNING THIS COSTS: the draw COUNT is unchanged (two per rock,
// so the append-only rng contract below holds), but mass feeds radius feeds
// placement/packing retries, so ANY change to these numbers deals the same
// seed a different sky downstream — every fixed-seed expectation that leans
// on world layout re-rolls. Measured 2026-08: this exact retune left the
// first moon bit-identical yet broke mechTest's dock staging (4 of 31) purely
// through downstream reshuffle. Re-run the full mechTest after touching this,
// and expect worldgen bench churn that is knock-on, not regression.
function asteroidMass(rng) {
  if (rng() < 0.12) return 2600 + rng() * 3400;   // boulder: 2600-6000
  return 40 + Math.pow(rng(), 1.8) * 2560;
}

export function spawnAsteroid(bodies, x, y, vx, vy, mass) {
  const a = new Body({
    type: 'asteroid', x, y, vx, vy, mass,
    radius: asteroidRadius(mass),
    color: mass >= 2600 ? '#a3765c' : '#8d8577',   // boulders read rusty
  });
  bodies.push(a);
  // Register with the awake list so mid-frame spawns (spall, shards, geyser
  // pellets) simulate THIS frame instead of waiting for the next LOD rebuild.
  // Creation sites that bypass this helper self-heal anyway — one frame of
  // stasis, then the rebuild picks them up.
  if (bodies._awake) bodies._awake.push(a);
  return a;
}

// ~13% of belt/field rocks over pebble size hide a dense mineral CORE. Cracking
// the shell (a player smash) frees the core as heavy, high-value salvage — a
// reason to prospect the belt instead of grinding every rock the same.
function maybeCore(a, rng) {
  if (a.mass > 250 && rng() < 0.13) { a.cored = true; a.color = '#7d7566'; }
  return a;
}

// Derelict cargo cache: a light canister adrift in the lanes. Grabbable from
// the very start; smashing it (yours, or a rock you throw at it) bursts it into
// scrap + ice ammo — early loot that isn't "smash the same rock again".
export function spawnCache(bodies, x, y, vx, vy) {
  const c = new Body({ type: 'asteroid', x, y, vx, vy, mass: 460, radius: 8, color: '#93a6bc' });
  c.cache = true;
  bodies.push(c);
  return c;
}

function addBelt(bodies, rng, star, beltR, spread, count) {
  for (let i = 0; i < count; i++) {
    const r = beltR + rand(rng, -spread, spread);
    const th = rng() * TAU;
    const x = star.x + Math.cos(th) * r;
    const y = star.y + Math.sin(th) * r;
    const v = orbitVel(star, x, y, 1);
    const a = maybeCore(spawnAsteroid(bodies, x, y, v.vx, v.vy, asteroidMass(rng)), rng);
    railBody(a, star);
  }
}

// Seeded Fisher-Yates. Layout shuffles must ride the WORLD rng, never
// Math.random — two runs of one seed have to build the same sky, or ?seed=
// stops meaning anything and mechTest T1's regeneration checksum fails.
function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- THE SEEDED LAYOUT (2026-08 user call: "every seeded solar system ends
// up different" — names, types, counts, spacing — instead of one fixed table
// wearing a different coat of angles). The old 15-row table survives here as
// the TEMPLATE: a ladder of SLOTS carrying the gap sequence and everything
// anchored to a lane REGION (the dense-field gap midpoints, the barge lane,
// the ghost's drift, the dark star's thread), and a set of CONTENTS that
// shuffle within loose bands and jitter in size/mass/moon count. The planet
// COUNT is deliberately fixed at the template's 15 (user call: "we didn't
// need to add more planets") — variety comes from arrangement, never from
// population. The GUARDRAILS are structural, not checked-by-hand:
//   - All nine ptypes always ship, and exactly THREE gas giants (one per
//     gasKind) — "destroy every archetype" and "strip every gas giant"
//     (achievements) count 9 and 3.
//   - Role tags (ember/fort/forge/shepherd/storm/crater/geysers/binary) ride
//     the CONTENT, so every landmark, the siege and the quest chain exist on
//     every seed; the fort always rides the desert world (waterspouts are
//     gated on !fort, so a fortified ocean world would ship with its one
//     mechanic suppressed — the reason the old table pinned ocean at 6600).
//   - The lava world stays innermost (the ember bloom + corona theming), the
//     terran station stays the FIRST station generated (the relay is "first
//     station in body order"), gas giants and the crystal binary stay in the
//     mid system, ice accumulates outward.
//   - Slot-anchored content derives from the lanes the seed actually built,
//     so a field can never land ON a lane and the barge can never share one.
//   - The gap ladder starts at the graveyard ring (itself derived from the
//     sun's radius) and the outermost lane is capped, so the inner edge
//     clears the corona and the outer edge leaves the Farshoal its berth on
//     any draw.
function buildLayout(rng, graveyardR) {
  const W = (mass, radius, ptype, moons, x = {}) =>
    ({ mass, radius, ptype, moons: moons || 0, ...x });
  // The slot ladder. `gap` is the authored spacing to the previous slot
  // (world.js's usual authored units — SR spreads them), taken from the old
  // fixed table so every relationship written about that sky still holds on
  // average. Slot markers (fieldMid/tinkerMid/ghostMid/darkMid) stay with the
  // SLOT when group contents shuffle: they describe a place in the gap
  // ladder, not a planet.
  const slots = [
    { gap: 350,  c: W(2e4, 60, 'lava', 0) },
    { gap: 3000, c: W(6e4, 105, 'ocean', 1) },
    { gap: 1400, belt: { spread: 450, count: 60 }, spawnBelt: true },
    { gap: 1500, grp: 'warm' },
    { gap: 1700, grp: 'warm', fieldMid: 'The Shoal' },
    { gap: 1800, grp: 'warm', tinkerMid: true },
    { gap: 1800, c: W(5e5, 430, 'gas', 9, { gasKind: 'violet', ring: true, forge: true }) },
    { gap: 2000, c: W(2.2e5, 220, 'crystal', 0, { binary: true }) },
    { gap: 1600, belt: { spread: 500, count: 50 }, carvedBelt: true },
    { gap: 1800, grp: 'mid' },
    { gap: 1800, grp: 'mid' },
    { gap: 2000, c: W(6.5e5, 520, 'gas', 10, { gasKind: 'amber', ring: true, storm: true }),
      fieldMid: 'The Grindstones' },
    { gap: 2500, c: W(1.6e5, 195, 'ice', 4, { nest: true }) },
    { gap: 2000, belt: { spread: 600, count: 45 } },
    { gap: 1700, grp: 'outer' },
    { gap: 4300, grp: 'outer', fieldMid: 'The Hushfield', ghostMid: true },
    { gap: 3800, grp: 'band' },
    { gap: 2500, grp: 'band', darkMid: true },
  ];
  // Shuffle groups: contents trade SLOTS within their band, so which world
  // sits at which lane varies per seed while the band structure (and every
  // slot-anchored derivation) stays put. The warm group holds the only
  // station among its three, so the relay's "first station" rule survives any
  // order it lands in.
  const groups = {
    warm: shuffle(rng, [
      W(1.2e5, 165, 'rocky', 4, { nest: true }),
      W(2e5, 235, 'terran', 5, { station: true }),
      W(1.3e5, 170, 'desert', 3, { fort: true }),
    ]),
    mid: shuffle(rng, [
      W(3.5e5, 340, 'gas', 8, { gasKind: 'azure', ring: true, station: true, shepherd: true }),
      W(1.8e5, 205, 'shroud', 4, { ring: true }),
    ]),
    outer: shuffle(rng, [
      W(9e4, 140, 'ice', 3, { station: true, geysers: true }),
      W(1.1e5, 150, 'rocky', 3, { crater: true }),
    ]),
    band: shuffle(rng, [
      W(6e4, 115, 'ice', 3),
      W(5.5e4, 105, 'rocky', 1, { station: true }),
    ]),
  };
  for (const s of slots) if (s.grp) s.c = groups[s.grp].shift();
  // CO-ORBITAL OUTER BAND (2026-08 user call: the outskirts can share a lane
  // "just not in the same area of the sky"). On ~60% of seeds the two
  // EXISTING band worlds pair up on the inner band lane at a fixed angular
  // offset — no world is added (user call: "we didn't need to add more
  // planets"), the band's population just arranges differently. Same radius
  // means the same rail |w|, and the sky turns one way — so the separation
  // drawn here HOLDS FOREVER: a shared lane is SAFER than two neighbouring
  // ones (neighbours always reach conjunction; co-orbitals never do), which
  // is the guardrail that makes this free. The vacated outer slot stays in
  // the ladder as an EMPTY lane so the dark star's mid-gap derivation (and
  // the ladder's total reach) are the same either way.
  if (rng() < 0.6) {
    const bandSlots = slots.filter((s) => s.grp === 'band');
    const [inner, outer] = bandSlots;
    inner.c.partner = outer.c;
    inner.c.partner.dth = rand(rng, 0.35, 0.65) * TAU;
    outer.c = null;
    outer.vacant = true;
  }
  // Per-world jitter. Radius x0.86-1.14 under PLANET_R_MUL 5.25 spans 4.5-6x
  // authored — the "1.5x to 2x bigger" band against the previous 3x sky (see
  // the constant's note). Gas masses jitter tighter so the azure giant stays
  // above the 3e5 trojan floor. Moon counts grow UP TO 1.5x, never shrink —
  // addPlanet clamps a family to what its zone can slot, so an over-draw
  // degrades to fewer moons, never to a crossing pair.
  const jit = (c) => {
    c.radius *= rand(rng, 0.86, 1.14);
    c.mass *= c.ptype === 'gas' ? rand(rng, 0.9, 1.1) : rand(rng, 0.85, 1.15);
    if (c.moons) c.moons = Math.round(c.moons * rand(rng, 1, 1.5));
  };
  // Walk the ladder into WORLD-unit lane radii, starting from the graveyard
  // ring the sun's own size dictated. Belt counts jitter too.
  let r = graveyardR;
  const rows = [];
  for (const s of slots) {
    r += SR(s.gap * rand(rng, 0.9, 1.15));
    if (s.belt) {
      rows.push({ r, belt: true, spread: s.belt.spread,
        count: Math.round(s.belt.count * rand(rng, 0.85, 1.2)),
        spawnBelt: s.spawnBelt, carvedBelt: s.carvedBelt });
      continue;
    }
    if (s.vacant) {
      // The co-orbital pairing's vacated lane: no world, but the radius stays
      // real — the dark star threads the mid-point of the gap it leaves.
      rows.push({ r, vacant: true, darkMid: s.darkMid });
      continue;
    }
    jit(s.c);
    if (s.c.partner) jit(s.c.partner);
    rows.push({ r, ...s.c, fieldMid: s.fieldMid, tinkerMid: s.tinkerMid,
      ghostMid: s.ghostMid, darkMid: s.darkMid });
  }
  // OUTERMOST-LANE GUARD: gap jitter can push the last lane far
  // enough out to crowd the Farshoal's frost-fringe berth (authored 44300).
  // Squeeze the whole ladder proportionally back under SR(41500) — invariant
  // 6 stays structural either way (moonZone clamps every family by the room
  // WORLD_R actually leaves), this guard is about keeping the outer band's
  // CONTENT relationships intact on a hot draw.
  const first = rows[0].r, last = rows[rows.length - 1].r;
  const cap = SR(41500);
  if (last > cap) {
    const k = (cap - first) / (last - first);
    for (const row of rows) row.r = first + (row.r - first) * k;
  }
  return rows;
}

export function generateWorld(game, seed = 20260721) {
  const rng = mulberry32(seed);
  const bodies = game.bodies;
  // Fresh world = fresh array contents. resetRun regenerates into the SAME
  // array (everything holds game.bodies by reference) — without this clear, a
  // second sun + full system stacked onto the old one on every game over.
  bodies.length = 0;
  // ...and the awake list dies with the old world: it holds REFERENCES, and a
  // stale list would keep simulating the dead sky's bodies. step() falls back
  // to the full array until updateFieldLOD rebuilds it (first frame).
  bodies._awake = null;
  // ...and so do the frame registries, for exactly the same reason: they hold
  // REFERENCES too, and a stale one would have render drawing the dead sky's
  // planets and physics answering to a sun that no longer exists.
  // physics.frameReg rebuilds on demand (see the note above updateFieldLOD).
  game.reg = null;
  // ...and every cached ATTRACTOR SHORTLIST is retired, for the third time for
  // the same reason (physics.attShortlist). step() bumps the generation
  // whenever the attractor COUNT moves, which cannot see a regen that happens
  // to rebuild the same number of attractors — and the fixed layout table
  // means it almost always does. Anything that outlives a regen holding a
  // shortlist (aliens, loose scrap) would keep feeling the dead sun's pull.
  game._attGen = (game._attGen ?? 0) + 1;
  game._attN = -1;
  // ...and the packed-halo host list, fourth of the same family: it holds
  // REFERENCES to the dead sky's worlds, and physics.packHalos would re-mint a
  // dead planet's rubble into the new world the moment the ship flew near where
  // that planet used to be.
  if (game._packedHosts) game._packedHosts.length = 0;
  // ...and the gravel store, fifth of the same family. It holds the dead sky's
  // debris in typed arrays that nothing else clears, so without this a regen
  // leaves every grain of the previous run drifting through the new one.
  gravel.reset();
  // ...and the body-id counter, sixth of the same family — and the only one
  // whose leak is INVISIBLE, because the ids stay perfectly valid. It seeds
  // every rock's baked shape (rockshape.rockShapeOf) and its sprite detail, so
  // without this the same seed builds the same layout wearing different rock:
  // identical worldgen checksum, different collisions half a second later. The
  // reset goes BEFORE generateWorld's bodies are minted, and nothing OUTSIDE
  // generateWorld mints an id-bearing object: only Body and Alien draw
  // NEXT_ID++, `Ship` carries no id at all (generateWorld does not build one —
  // respawnShip just repositions main.js's single import-time Ship), and
  // regenWorld clears game.aliens before this runs. That is why the ids minted by
  // generateWorld are a pure function of the seed — check this ordering again if Ship ever gains
  // an id. See the note on NEXT_ID in entities.js.
  resetBodyIds();
  // ...and the moon-name pools, seventh of the family — seeded off a FORK of
  // the world seed so spawnMoon can assign names without drawing the main rng.
  resetMoonNames(seed);

  // ONE sun, vast and dangerous, with the whole map as its system.
  // SKY SPEED (orbital cruise): every sun-anchored orbit's speed is
  // sqrt(G * sunMass / r), so this mass single-handedly sets how fast the
  // whole sky — planets, belts, trojans, graveyard, Vesper, the ship's own
  // cruise, rails included — sweeps past. It's tuned LOW to suit the tight
  // tier-0 camera zoom (SHIP_ZOOM, config.js): the world scrolls past ~2x
  // faster per zoom unit, so at 2.46 a fast sky reads as "flying wildly
  // fast." At 1.42e7 every orbit sweeps ~1.5x slower than the old 3.2e7,
  // which calms flight at the zoom. STAR_GRAV_SHIP is deliberately NOT
  // recompensated here — we WANT the ship's cruise (and the pull it feels)
  // to come down with the sky, not stay pinned. Raising zoom or this mass
  // without the other shifts flight feel; they tune together.
  // RADIUS 4800 = the old 2400 doubled (2026-08 user call: "the sun should be
  // 2x bigger"). SIZE ONLY — the mass is the sky-speed knob above and is
  // deliberately untouched, the same radius/mass split as WORLD SCALE. The
  // corona consequences moved with it where they were absolute: the graveyard
  // ring derives from this radius now (below), and config's FLARE_RANGE /
  // FLARE_LIFE / HEAT_SHIP_FALLOFF doubled so "close to the sun" keeps
  // meaning the same thing in sun radii.
  const sun = new Body({
    type: 'star', x: 0, y: 0, mass: 1.42e7, radius: 4800, color: '#ffd98a',
  });
  bodies.push(sun);

  // The inner anchors derive from the SUN'S OWN SIZE, so doubling it can
  // never swallow them: the wreck ring rides at 1.36 sun radii (the same
  // proportion the authored 3250 held over the old 2400 sun), which keeps it
  // just above the HEAT_ZONE edge (1.30r — see the constant's note), and
  // Vesper's perihelion keeps its deliberate margin above the ring. These are
  // module `let`s: the replenish respawn checks read the same bindings.
  GRAVEYARD_R = sun.radius * 1.36;
  VESPER_PERI = GRAVEYARD_R * 1.2;
  VESPER_SEMI = Math.max(SR(12000), VESPER_PERI * 2.6);

  // Inner system is a scorched lava world, then warm worlds, huge ringed gas
  // giants of three kinds, a crystal binary and a cloud-shrouded ringed world
  // in the middle, and ice in the far reaches — but WHICH world sits at WHICH
  // lane, how big it grew, how many moons it holds and what it is named are
  // all the seed's to decide now: see buildLayout and its guardrail notes.
  // Each planet is an ECOSYSTEM: stations, nests, trojans, ring fields, junk
  // satellites, and type hazards all hang off these anchor worlds.
  // A PLANET SYSTEM IS RARE, AND IT IS AN EVENT still holds: the template is
  // the same 15 anchor slots the rarer/wider pass authored, and the 0-2
  // per-seed extras come off the duplicated archetypes only.
  const layout = buildLayout(rng, GRAVEYARD_R);

  // Slot-anchored derivations — the barge lane, the three inner dense-field
  // radii, the ghost's drift and the dark star's thread all ride the lanes
  // THIS seed generated (a fixed radius would land on a lane two seeds out of
  // three). Belts hand the ship's spawn lane and the carved stone's home to
  // the discovery layer the same way. Walked BEFORE the size-clamp pass so
  // the mid-points read clean lane radii.
  const fieldRs = [];
  let ghostR = SR(31400), darkR = SR(39500), spawnBeltR = SR(8000), carvedR = SR(18400);
  {
    let prevP = null;
    for (const row of layout) {
      if (row.belt) {
        if (row.spawnBelt) spawnBeltR = row.r;
        if (row.carvedBelt) carvedR = row.r;
        continue;
      }
      if (prevP) {
        if (row.fieldMid) fieldRs.push({ name: row.fieldMid, r: (prevP.r + row.r) / 2 });
        if (row.tinkerMid) TINKER_R = (prevP.r + row.r) / 2;
        // 0.28 of the way across its gap — the proportion the authored 31400
        // held between the 30200 and 34500 lanes.
        if (row.ghostMid) ghostR = prevP.r * 0.72 + row.r * 0.28;
        if (row.darkMid) darkR = (prevP.r + row.r) / 2;
      }
      // A vacant lane (the co-orbital pairing's freed outer slot) anchors its
      // markers like any lane, but it holds no world to measure the NEXT gap
      // from — the last real planet stays the reference.
      if (!row.vacant) prevP = row;
    }
  }

  // ---- WORLD SCALE. The radii authored above are the SHAPE of the sky; the
  // worlds are built up to CFG.PLANET_R_MUL times that size (see the note on
  // the constant for why the MASSES stay put). "Up to", because a lane only
  // holds so much world: adjacent rails run at different angular speeds and
  // therefore always reach conjunction, so each grown disc is capped by what
  // its NEIGHBOUR LANES leave free. A contested boundary is split in
  // PROPORTION to the two desired radii — the giant keeps being the giant, and
  // both sides give up the same fraction rather than one of them absorbing the
  // whole shortfall. Belt lanes are skipped: they're rock, they overlap the
  // outer moon families already, and nothing here is fighting them for room.
  //
  // This is pure arithmetic over the layout — NO rng draw — so the seeded
  // stream, and with it every angle and position in the sky, is untouched.
  {
    const lanes = layout.filter((it) => !it.belt && !it.vacant);
    const want = lanes.map((it) => it.radius * CFG.PLANET_R_MUL);
    const got = want.slice();
    for (let i = 0; i < lanes.length - 1; i++) {
      const free = (lanes[i + 1].r - lanes[i].r) - CFG.PLANET_LANE_GAP;
      const sum = want[i] + want[i + 1];
      if (sum <= free) continue;
      got[i] = Math.min(got[i], free * (want[i] / sum));
      got[i + 1] = Math.min(got[i + 1], free * (want[i + 1] / sum));
    }
    lanes.forEach((it, i) => {
      // A co-orbital partner shares its host's lane, so it yields to the
      // neighbour clamp by the same fraction the host did — and it converts
      // to FINAL units here, exactly where the host does.
      if (it.partner) it.partner.radius *= CFG.PLANET_R_MUL * (got[i] / want[i]);
      it.radius = got[i];
    });
  }
  // Names come off the PER-ARCHETYPE pools now (PLANET_NAME_POOLS), drawn
  // from a PRIVATE stream forked off the run seed — never the world rng. The
  // legacy shuffle below is KEPT AND DISCARDED: it burns the exact world-rng
  // draws it always did, so every existing seed's layout, jitter and moon
  // census are bit-identical; only the nameplates changed. (The binary
  // companion takes "<name> B" and the Wanderer's Star names itself.)
  shuffle(rng, PLANET_NAMES.slice());
  // The seed is MIXED (an avalanche step, the ghostOff idiom), and each pool
  // shuffles off its OWN stream — a plain `seed ^ K` fed one sequential
  // stream, and its early draws were biased enough that three unrelated seeds
  // all dealt the lava pool the same first name (measured: 'Cindral' on
  // 20260721, 555000111 AND 42).
  const nameSeed = (Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B) ^ (seed >>> 13)) >>> 0;
  const namePools = {}, nameIdxByType = {};
  let nameTi = 0;
  for (const k in PLANET_NAME_POOLS) {
    const tSeed = (nameSeed + Math.imul(++nameTi, 0x9E3779B9)) >>> 0;
    namePools[k] = shuffle(mulberry32(tSeed), PLANET_NAME_POOLS[k].slice());
  }
  const nextName = (pt) => {
    const pool = namePools[pt] || namePools.rocky;
    const i = nameIdxByType[pt] = (nameIdxByType[pt] || 0) + 1;
    return pool[(i - 1) % pool.length];   // % is belt-and-braces; 10 deep never wraps
  };
  const planets = [];
  for (const item of layout) {
    if (item.belt) { addBelt(bodies, rng, sun, item.r, item.spread, item.count); continue; }
    if (item.vacant) continue;   // the co-orbital pairing's freed lane — no world here
    item.name = nextName(item.ptype);
    const p = addPlanet(bodies, rng, sun, item.r, item.mass, item.radius, item);
    item.p = p;
    planets.push(p);
    if (item.station) addStation(bodies, rng, p);
    if (item.nest) addNest(bodies, rng, p);
    // BINARY PAIR: a near-equal companion circling the primary — the chaotic
    // double-well between them is a playground, and it guards good salvage.
    if (item.binary) {
      // The pair's separation has to grow with the pair, or WORLD SCALE closes
      // the gap the "playground" is made of: at 3x the two discs plus the
      // companion's own junk ring and station all wanted the 1500 the authored
      // sky had room for. Derived from the radii and floored at the authored
      // value, so an unscaled world (mul 1) is bit-identical.
      const compR = item.radius * 0.85;
      const sep = Math.max(1500, (item.radius + compR) * 1.9);
      const th2 = rng() * TAU;
      const cx = p.x + Math.cos(th2) * sep, cy = p.y + Math.sin(th2) * sep;
      const cv = orbitVel(p, cx, cy, 1);
      const comp = new Body({
        type: 'planet', x: cx, y: cy, vx: cv.vx, vy: cv.vy,
        mass: item.mass * 0.75, radius: compR,
        color: pick(rng, PTYPE_COLORS[item.ptype]),
        name: p.name + ' B', ptype: item.ptype, parent: p,
      });
      bodies.push(comp);
      railBody(comp, p);
      planets.push(comp);
      // Keep the companion's station between the two worlds, not through the
      // primary: a 2.6r orbit off a scaled companion swings back inside it.
      addStation(bodies, rng, comp, sep - p.radius - 200);
    }
    // CO-ORBITAL COMPANION: the OTHER outer-band world, riding this same lane
    // at a fixed angular offset (buildLayout draws 0.35-0.65 of a turn) —
    // pairing rearranges the band's existing population, it never adds a
    // world. Same lane radius = same rail |w| and the sky turns one way, so
    // the separation drawn at seed time holds for the whole run — the pair
    // can never reach conjunction, which is what makes a shared lane safe
    // where a merely nearby one would not be. Still a full planet: named,
    // charted, junk-belted, moon-holding, and it keeps the station it would
    // have carried on its own lane.
    if (item.partner) {
      const pt = item.partner;
      pt.name = nextName(pt.ptype);
      pt.ang = Math.atan2(p.y - sun.y, p.x - sun.x) + pt.dth;
      const q = addPlanet(bodies, rng, sun, item.r, pt.mass, pt.radius, pt);
      pt.p = q;
      planets.push(q);
      if (pt.station) addStation(bodies, rng, q);
      if (pt.nest) addNest(bodies, rng, q);
    }
  }

  // TROJAN CLUSTERS: heavyweight planets carry dense rock pockets 60° ahead
  // and behind on their own orbit (L4/L5) — natural ammo depots that travel
  // with the planet (same rail radius = same angular speed; the small radial
  // jitter makes the cluster shear apart slowly, which keeps it organic).
  for (const p of planets) {
    if (p.mass < 3e5) continue;
    const dir = Math.sign(p.rail.w) || 1;
    const pr = Math.hypot(p.x - sun.x, p.y - sun.y);
    const pAng = Math.atan2(p.y - sun.y, p.x - sun.x);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 10; i++) {
        const a = pAng + side * (Math.PI / 3) + rand(rng, -0.05, 0.05);
        const tr = pr + rand(rng, -380, 380);
        const x = sun.x + Math.cos(a) * tr, y = sun.y + Math.sin(a) * tr;
        const v = orbitVel(sun, x, y, dir);
        const t = spawnAsteroid(bodies, x, y, v.vx, v.vy, asteroidMass(rng));
        railBody(t, sun);
      }
    }
  }

  // ---- DISCOVERY LAYER: landmarks and one-off finds. Everything here is
  // seeded, so each is in the same place every run — you can give directions
  // by them. (Set BEFORE the ring fields so ringGap shapes chunk placement.)
  // Hosts are found by the ROLE TAG buildLayout stamped on their layout row,
  // never by looking a lane radius back up: the lanes are seeded per run now,
  // so a radius lookup would return undefined on every seed but the authored
  // one and the world would silently ship without its landmark, its shepherd
  // or its siege — the failure the old planetAtOrbit comment warned about,
  // promoted to a certainty. The role rides the CONTENT through the group
  // shuffle, so the landmark exists on every seed wherever its world landed.
  const roleHost = (k) => { const it = layout.find((x) => x[k] && x.p); return it ? it.p : null; };

  // LANDMARKS: render-only flags giving select worlds a unique face — the
  // Great Eye on the big gas giant, a rayed impact basin, live cryo-geysers.
  const stormHost = roleHost('storm'); if (stormHost) stormHost.landmark = 'storm';
  const craterHost = roleHost('crater'); if (craterHost) craterHost.landmark = 'crater';
  const geyserHost = roleHost('geysers'); if (geyserHost) geyserHost.landmark = 'geysers';

  // FORGE MOON: the inner gas giant keeps one volcanically live moon. When
  // you're close it lobs loose magma bombs that cool into dense sling rock
  // (replenishWorld hazard loop) — an Io, not a gun battery.
  const forgeHost = roleHost('forge');
  if (forgeHost) {
    const m = bodies.find((b) => b.type === 'moon' && b.parent === forgeHost);
    if (m) { m.volcanic = true; m.color = '#c98a6a'; m.name = 'Forge Moon'; m.chartKey = 'forge'; }
  }

  // RING SHEPHERD: one ringed giant has a visible ring gap held open by a
  // tiny named moonlet riding in it. Steal (or smash) the shepherd and the
  // ring slowly scatters — a consequence you can watch happen over minutes
  // (decay logic in replenishWorld, visuals in render.js).
  const shepHost = roleHost('shepherd');
  if (shepHost) {
    shepHost.ringGap = true;
    spawnShepherd(game, shepHost, rng() * TAU);
    game.shepherdPlanet = shepHost;
  }

  // RING FIELDS: gas-giant rings are made of actual grabbable ice chunks.
  // A ringGap planet keeps its chunks OUT of the shepherd's lane.
  for (const p of planets) {
    if (p.ptype !== 'gas') continue;
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      const cr = p.radius * (p.ringGap
        ? (rng() < 0.5 ? rand(rng, 1.55, 1.78) : rand(rng, 2.02, 2.15))
        : rand(rng, 1.55, 2.15));
      const x = p.x + Math.cos(a) * cr, y = p.y + Math.sin(a) * cr;
      const v = orbitVel(p, x, y, 1);
      const c = spawnAsteroid(bodies, x, y, v.vx, v.vy, rand(rng, 60, 480));
      c.color = '#cfe6f2'; c.ice = true;
      railBody(c, p);
    }
  }

  // SATELLITE JUNK: settled solid worlds are littered with dead probes —
  // triple scrap. Every solid archetype but the hostile extremes (lava/ice)
  // qualifies; this set covers exactly the planets that were ROCKY before the
  // archetype split, so the junk economy (and the rng draw order) is unchanged.
  const JUNK_WORLDS = new Set(['rocky', 'terran', 'desert', 'ocean', 'shroud', 'crystal']);
  for (const p of planets) {
    if (!JUNK_WORLDS.has(p.ptype)) continue;
    const n = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      // Crystal worlds: the junk ring floats above the SPIKE reach (1.32r,
      // util.CRYSTAL_REACH), not the mean disc — at radius + 80 the old floor
      // left ~5u between a railed probe and the tallest turning spike, one
      // tuning nudge away from a perpetual grind-derail churn.
      const jr = p.radius * (p.ptype === 'crystal' ? 1.45 : 1) + rand(rng, 80, 300);
      const x = p.x + Math.cos(a) * jr, y = p.y + Math.sin(a) * jr;
      const v = orbitVel(p, x, y, 1);
      const j = spawnAsteroid(bodies, x, y, v.vx, v.vy, rand(rng, 60, 350));
      j.color = '#9fb0c2'; j.junk = true;
      railBody(j, p);
    }
  }

  // GRAVEYARD ORBIT: pre-collapse wreckage rings the sun just above its
  // corona (GRAVEYARD_R = 1.36 sun radii, below the innermost planet lane and
  // well inside the flare zone) — the richest salvage in the system, guarded
  // by heat, not guns. One hulk carries a recovered log.
  {
    const g0 = rng() * TAU;
    for (let i = 0; i < 9; i++) {
      const a = g0 + (i / 9) * TAU + rand(rng, -0.15, 0.15);
      const gr = GRAVEYARD_R + rand(rng, -90, 90);
      const wx = Math.cos(a) * gr, wy = Math.sin(a) * gr;
      const wv = orbitVel(sun, wx, wy, 1);
      const w = spawnAsteroid(bodies, wx, wy, wv.vx, wv.vy, i === 0 ? 2800 : rand(rng, 200, 700));
      w.color = '#9fb0c2'; w.junk = true;
      w.wreck = true;   // graveyard salvage: the Herald's price, the barge's want
      if (i === 0) w.echo = ECHOES.hulk;
      railBody(w, sun);
    }
  }

  // COMET VESPER: ONE real long-period comet on a genuinely eccentric orbit
  // (perihelion ~3900, aphelion ~20100, period ~8.6 min under the heavy
  // sun). It free-flies under full gravity — rails are circular-only and
  // the re-rail scan can never capture it (an ellipse never sits within
  // RAIL_TOL of circular). The comet flag reuses the ambient-comet tail +
  // 4x scrap; cometT = Infinity keeps the ambient expiry (Infinity - dt
  // stays Infinity) from culling it. Perihelion sits ABOVE the graveyard
  // ring (3250±90) on purpose: when it dipped through the wrecks, repeated
  // collisions random-walked its perihelion into the sun within ~8 minutes.
  spawnVesper(game, sun, rng() * TAU);

  // GHOST SHIP: a pre-collapse hull drifting in the outer dark between the
  // ice worlds, found by EAR before eye — it pings when you fly near
  // (replenishWorld). Station-type so shattering it breaks into salvage
  // modules; parent stays null so it gets none of the installation
  // station-keeping (it's a wreck, not infrastructure).
  {
    const th = rng() * TAU;
    const gr = ghostR;   // 0.28 across the outer gap — see the slot-anchored derivations
    const gx = Math.cos(th) * gr, gy = Math.sin(th) * gr;
    const gv = orbitVel(sun, gx, gy, 1);
    const gh = new Body({
      type: 'station', x: gx, y: gy, vx: gv.vx, vy: gv.vy,
      mass: 1500, radius: 22, hp: 200,
      color: '#5a6472', name: 'The Herald',
    });
    gh.ghost = true; gh.spin = 0.18; gh.echo = ECHOES.herald;
    gh.chartKey = 'herald';
    bodies.push(gh);
    railBody(gh, sun);
    game.ghost = gh;
  }

  // THE CARVED STONE: one rock in the middle belt is... not a rock.
  // Perfectly faceted, clearly worked. No mechanic — just something to find
  // and screenshot. (render.js gives carved rocks a machined silhouette.)
  {
    const th = rng() * TAU;
    const cr2 = carvedR + rand(rng, -300, 300);   // the middle belt's own generated lane
    const cx2 = Math.cos(th) * cr2, cy2 = Math.sin(th) * cr2;
    const cv2 = orbitVel(sun, cx2, cy2, 1);
    const cs = spawnAsteroid(bodies, cx2, cy2, cv2.vx, cv2.vy, 777);
    cs.carved = true; cs.junk = true; cs.color = '#95a3b5';
    cs.echo = ECHOES.carved;
    cs.chartKey = 'carved'; cs.name = 'Carved Stone';
    railBody(cs, sun);
  }

  // Hand each derelict station its echo log, in generation order
  {
    let ei = 0;
    for (const b of bodies) {
      if (b.type === 'station' && !b.ghost && ei < ECHOES.stations.length) {
        b.echo = ECHOES.stations[ei++];
        // THE RELAY: the first station's log IS the breadcrumb ("…the relay
        // still points at a star none of our charts contain") — so that
        // station is the relay itself. Feed its dish a core crystal
        // (updateDeliveries.powerRelay) and it reveals the dark star.
        if (ei === 1) { b.relay = true; b.name = 'Relay Station'; game.relay = b; }
      }
    }
  }

  // (No map-wide free asteroid field — the view-local spawner in
  // replenishWorld keeps rocks available wherever the player actually is.)

  // THE BASTION: a mech race has fortified select worlds — energy shields
  // plus surface turret batteries. The world itself becomes a weapon until
  // you drain the shield and smash every turret (liberation pays 200 scrap).
  const fortify = (body, shield, nTurrets) => {
    if (!body) return;
    body.fort = {
      shield, maxShield: shield, hitT: 0, quiet: 9,
      turrets: Array.from({ length: nTurrets }, (_, i) => ({
        ang: (i / nTurrets) * TAU, cool: 1 + i * 0.7, hp: 35, maxHp: 35,
      })),
    };
  };
  fortify(roleHost('fort'), 260, 3);
  // (volcanic/shepherd moons are discovery content — never fortified — and a
  // fort on a DUST moon would contradict its stealth-haven job; same rule for
  // a VERDANT moon — a Bastion camped on the healing spring blocks its job —
  // and a HUSK moon, which is the wrights' turf, not the Bastions')
  // (the size floor rides MOON_R_MUL — unscaled it would pass EVERY moon and
  // the "big moon" fort would land on whichever one happens to be first)
  const bigMoons = bodies.filter((b) => b.type === 'moon' && b.radius >= 28 * CFG.MOON_R_MUL &&
    !b.volcanic && !b.shepherd && b.moonType !== 'dust' &&
    b.moonType !== 'verdant' && b.moonType !== 'husk').slice(0, 1);
  for (const m of bigMoons) fortify(m, 150, 2);

  // THE EMBERKIN: living plasma already blooming on the innermost lava world.
  // It deepens over time and, at full bloom, seeds the next planet outward.
  planets[0].ember = 0.55;

  // ROGUE PLANETS WERE REMOVED (2026-07, user call: "they're only causing
  // issues"). A wandering 2.5-4.5e5 mass under full gravity was a permanent
  // source of sky damage that no player action caused and none could prevent:
  // it derailed whatever lane it crossed, ATE moons on the flyby, and — once
  // the outer band existed — gravitationally captured light outer worlds and
  // dragged them into the sun, taking every lane it crossed on the way down.
  // Three separate guards were written against that one body type (the
  // spawn-ring radius, the entry-speed floor, and the planet fiat re-rail in
  // physics) before deleting it turned out to be the honest fix. The sky's
  // drama now comes from things the player is part of. `type: 'rogue'` stays
  // supported everywhere (render, minimap, weighted gravity, the re-rail
  // disturber list) so the concept can return if it ever earns its keep —
  // nothing spawns one.

  // Player starts in a stable orbit inside the inner asteroid belt.
  // The ship feels SHIP_GRAV-amplified gravity, so its circular speed differs
  // from the rocks around it.
  const sr = spawnBeltR;   // the inner belt's generated lane, wherever this seed put it
  const sv = Math.sqrt((CFG.G * CFG.SHIP_GRAV * CFG.STAR_GRAV_SHIP * sun.mass) / sr);
  game.spawn = { x: sun.x, y: sun.y - sr, vx: sv, vy: 0 };
  game.homeStar = sun;
  game.moonBaseline = bodies.filter((b) => b.type === 'moon').length;
  // CHART EVERYTHING: every world, moon, and station is chartable (b.chartKey;
  // named landmarks set their own keys at their spawn sites so respawns keep
  // them). game.charted records KEYS, not bodies. Worldgen bodies only —
  // replenish-spawned moons get no key, so the chart total never inflates
  // mid-run. Pure flagging, no rng draws: the seeded stream and the mechTest
  // world checksum are untouched.
  {
    let pi = 0, mi = 0, si = 0;
    for (const b of bodies) {
      if (b.chartKey) continue;
      if (b.type === 'planet') b.chartKey = 'p' + pi++;
      else if (b.type === 'moon') b.chartKey = 'm' + mi++;
      else if (b.type === 'station') b.chartKey = 'st' + si++;
    }
  }
  game.charted = {};
  game.surveyTotal = 0;   // recomputed live by the chart scan (replenishWorld)
  // Roguelite life pods: one seeded near the starting belt so the +1-life
  // mechanic is discoverable; replenishWorld/main.js trickle in more.
  game.pickups = [];
  game.lifeTimer = PROG.LIFE_RESPAWN;
  spawnLifePod(game, sun.x + 2400, sun.y - sr - 1100);
  // Glow pockets: the sparse, sun-orbiting healing springs (deterministic, so
  // they reset with the world). Seeded off the same world rng — see glow.js.
  seedGlowPockets(game, rng);
  // VERDANT MOONS each host one anchored pocket in low orbit. Off the forked
  // naming stream, NOT the main rng — a cosmetic mote layout must not shift
  // the seeded sky (the append-only rule below), and moon count varies per
  // seed so the draw count here varies too.
  seedMoonGlow(game, mulberry32((seed ^ 0x51f15e) >>> 0));
  // A stale husk-wake reference must not survive into a fresh sky (the
  // tinkerWant precedent): physics sets it, ai.js consumes it.
  game.huskWake = null;
  // ---- EXPEDITION LAYER (seeded). Everything below draws rng AFTER
  // seedGlowPockets ON PURPOSE: the whole sky above stays bit-identical to
  // the pre-expedition worldgen (and the mechTest T1 checksum with it). Any
  // new seeded content must keep appending here, never draw rng earlier. ----
  // The Tinker Barge — the system's one friendly vessel (see spawnTinker).
  // Clear the want FIRST: game state survives resetRun until reassigned, and
  // a fresh run must not exclude the previous run's want from the pick.
  game.tinkerWant = null;
  spawnTinker(game, sun, rng() * TAU);
  game.tinkerCd = 0;
  game.tinkerSaid = null;
  game.tinkerPlayerKilled = false;
  // THE WANDERER'S STAR — a cold dark dwarf deep in the outer band, the payoff
  // of the relay questline. hidden = sensor-null: the fog scan and the chart
  // scan both skip it, so no amount of flying reveals it — only the powered
  // relay does. Type 'planet' ON PURPOSE: 'star' would bypass minimap fog
  // (render draws stars from anywhere) and vaporize the ship on contact, and
  // a custom type would fall through the physics re-rail scan — rogues DO
  // wander out here (they spawn at WORLD_R-600 = 45.4k) and can still knock
  // it loose by IMPACT (planets no longer proximity-derail), so it must be
  // re-railable — as a planet it also gets the fiat rescue that breaks a
  // rogue capture, which suits a questline body that must never be lost.
  // Mass 4.5e4 stays under the replenish
  // moon-host filter (5e4: no moons accrete around it), and its sun
  // anchorage exempts it from the boundary force the ordinary way — NO
  // noBoundary; that flag is the interstellar visitor's alone.
  {
    const th = rng() * TAU;
    const dr2 = darkR;   // its lane threads the outer band, mid-gap between the two outermost worlds
    const dx = Math.cos(th) * dr2, dy = Math.sin(th) * dr2;
    const dv = orbitVel(sun, dx, dy, 1);
    const dk = new Body({
      type: 'planet', x: dx, y: dy, vx: dv.vx, vy: dv.vy,
      // Scaled like a layout world (WORLD SCALE), but it is spawned outside
      // the layout so it takes the multiplier raw rather than the neighbour
      // clamp. It can afford to, and by a wider margin than it used to: an
      // authored 1200/1300 to the 38300 and 40800 worlds became ~1560/1690
      // once SYSTEM SCALE spread those lanes, against three grown discs that
      // did not change size.
      mass: 4.5e4, radius: 70 * CFG.PLANET_R_MUL, color: '#241f2e',
      name: "The Wanderer's Star", parent: sun,
    });
    dk.dark = true; dk.hidden = true; dk.chartKey = 'wanderer';
    bodies.push(dk);
    railBody(dk, sun);
    game.darkStar = dk;
  }
  // ---- INSTALLATION LANES. Stations and nests ride circular orbits scaled off
  // their host's surface (2.6r / 3.4r), which has always put them INSIDE the
  // moon band — the two allocators simply never talked to each other, and on
  // the authored sky they happened never to collide. WORLD SCALE ended that
  // luck: a station orbit grows with PLANET_R_MUL while the moon band's floor
  // only grows by the planet radius plus a fixed clearance, so the station
  // slides deeper into the family (two hosts shipped a station sharing a
  // radius with a moon on the very first seed). Two railed bodies whose radial
  // RANGES overlap always meet — the same no-crossing condition spawnMoon's
  // exCap enforces between siblings — and an installation knocked off its rail
  // is precisely what station-keeping exists to prevent.
  //
  // So each installation is nudged OUTWARD to the first radius clear of every
  // sibling moon. Outward only: inward is the surface, and the band above is
  // open (rails don't care how far out they sit). Runs after the whole
  // discovery layer so the shepherd and the Forge Moon are already placed, and
  // it draws NO rng — the orbital angle each body already has is kept.
  for (const b of bodies) {
    if (b.type !== 'station' && b.type !== 'nest') continue;
    const p = b.parent;
    if (!p || p.type !== 'planet' || !b.rail) continue;
    const pad = b.radius + 60;
    const bands = bodies
      .filter((m) => m.type === 'moon' && m.parent === p && m.rail)
      .map((m) => {
        const a = m.rail.a !== undefined ? m.rail.a : m.rail.r, e = m.rail.e || 0;
        // 1.55x the moon's radius, not 1x: seedDebrisBelts hangs a chunk
        // shell out to that reach later in generateWorld, and a station
        // nudged merely clear of the DISC would sit in the shell it is about
        // to grow. The pass runs before the shells exist, so it reserves the
        // room they will deterministically take.
        return { lo: a * (1 - e) - m.radius * 1.55 - pad, hi: a * (1 + e) + m.radius * 1.55 + pad };
      })
      .sort((u, v) => u.lo - v.lo);
    let r = b.rail.r;
    for (const bd of bands) if (r > bd.lo && r < bd.hi) r = bd.hi;
    if (r === b.rail.r) continue;
    const th = b.rail.ang;
    b.x = p.x + Math.cos(th) * r; b.y = p.y + Math.sin(th) * r;
    const v = orbitVel(p, b.x, b.y, 1);
    b.vx = v.vx; b.vy = v.vy;
    railBody(b, p);   // resets homeR too — station-keeping flies back to the NEW lane
  }

  game.relayPowered = false;
  game.relayBeamT = 0;
  game.wandererEchoT = 0;
  // DENSE ASTEROID FIELDS (appended here, after every earlier rng draw, per
  // the expedition-layer rule above). The three inner pockets ride the
  // GENERATED lane-gap midpoints collected above — the gaps are the point,
  // not the numbers — and the Farshoal keeps its authored frost-fringe berth,
  // which is pinned to WORLD_R by construction (44300 of the 46000 the
  // boundary is authored at, both spread by the same SYS).
  fieldRs.push({ name: 'The Farshoal', r: SR(44300) });
  seedDenseFields(game, sun, rng, fieldRs);
  seedDebrisBelts(bodies, planets, rng);
  respawnShip(game);
}

// PLANETARY DEBRIS BELTS — every world wears a shell of its own rubble.
//
// What shipped before was three or four dead probes (SATELLITE JUNK, above) on
// the solid worlds and fourteen ice chunks on the gas giants, sized when the
// worlds themselves were a third of their current radius. Against a 705-unit
// planet four specks is nothing, and the lava and ice worlds carried NOTHING
// AT ALL. This pass hangs a real belt on every planet: the count scales with
// the world's own size, and the material comes from config.worldDebris — the
// same table physics.calveCrust reads when a wounded world calves, so what
// already orbits a planet and what breaks off it are visibly the same stuff.
//
// Appended AFTER seedDenseFields, per the expedition-layer rule: it draws rng,
// and drawing any earlier would reshuffle every angle in the sky above it.
// The belts are railed like the junk and ring chunks they join, so they cost
// the gravity loop nothing; sizes stay under ATTRACT_MIN for the same reason.
function seedDebrisBelts(bodies, planets, rng) {
  for (const p of planets) {
    if (p.dark) continue;   // the hidden dwarf is meant to be a bare silhouette
    // Crystal worlds measure from the SPIKE reach (util.CRYSTAL_REACH), never
    // the mean disc: at the disc a railed rock and the tallest turning spike
    // grind each other into a perpetual derail churn. Read from the shared
    // constant, not copied — CLAUDE.md's guard on CRYSTAL_REACH requires this
    // clearance to move WITH it, and a hard-coded 1.32 breaks that silently the
    // first time the spikes are retuned.
    const reach = p.ptype === 'crystal' ? p.radius * CRYSTAL_REACH : p.radius;
    // Belt pieces are drawn at a fraction of the HOST, like every other piece
    // of a world (CFG.CRUST_*) — the mass-derived radius drew a 900-mass rock
    // at 6.5 units, invisible beside a 1148-unit gas giant. Held well under
    // moon scale on purpose: this is rubble you fly through, not a second moon
    // system, and mass follows the radius (config.crustMass) so the beam's tier
    // caps gate a piece by the size the player can actually see.
    // Cap 68 = the old 34 doubled (2026-08 user call: chunks keep their
    // bottom end but run "up to 2x bigger" — the rand(0.3, 1) draw below is
    // what keeps the small end small, the cap is what lets a grown giant's
    // shell carry real boulders instead of the same 34-unit specks).
    let crMax = Math.min(p.radius * 0.035, 68);
    // THE BAND MUST CLEAR EVERY LANE ALREADY IN USE. Moons, stations, nests,
    // the gas rings and the junk probes are all railed around this world at
    // their own Keplerian rates, and the crossing-orbit rule (see spawnMoon's
    // exCap rationale) is that any "covers both bodies' radii" clearance has to
    // ride the SCALED radii. A first cut ignored it and put 45-55 unit rubble
    // straight through the inner moon lanes: half the belt was absorbed on
    // frame one and the survivors ground moons out of the sky inside four
    // idle minutes.
    // Collect the lanes already spoken for, as forbidden intervals.
    // GATHER THIS WORLD'S SATELLITES IN THE SAME PASS. The per-slot overlap
    // test below needs the full list (down to the 5-unit ring pellets) while
    // the lane search only wants the ones big enough to hold a lane — but both
    // used to walk the whole `bodies` array, the slot test once per slot. This
    // pass runs AFTER seedDenseFields, so the array already holds ~3,643 shoal
    // rocks and every one of them is railed: the parent compare alone ran into
    // millions of iterations per generateWorld. One walk, two lists. Same
    // membership, so placement is unchanged. (generateWorld now also runs on a
    // main-menu backout, which puts this cost behind a player-visible click.)
    const blocked = [], sats = [];
    for (const b of bodies) {
      if (!b.rail || b.rail.parent !== p) continue;
      sats.push(b);
      if (b.radius < 8) continue;   // specks can't hold a lane
      // A CIRCULAR RAIL AND AN ELLIPTICAL RAIL ARE DIFFERENT OBJECTS, and
      // moons ride ellipses: rail.r simply does not exist on one, so reading it
      // here yielded undefined, NaN'd the band, slipped through a `<=` guard
      // (every NaN comparison is false) and spawned a few hundred bodies at NaN
      // coordinates for the tripwire to cull. Take the PERIAPSIS — the closest
      // the moon ever comes — so the clearance holds all the way round.
      const lane = b.rail.e > 0 ? b.rail.a * (1 - b.rail.e) : b.rail.r;
      if (!Number.isFinite(lane)) continue;
      blocked.push([lane - b.radius - 40, lane + b.radius + 40]);
    }
    blocked.sort((u, v) => u[0] - v[0]);
    // Take the WIDEST CLEAR ANNULUS in the shell, not merely everything under
    // the innermost moon. Calyx keeps a 59-unit moon 70 units off its cloud
    // tops, which under the simpler rule left the most-visited world in the
    // game with no belt at all — while the gap just OUTSIDE that moon was
    // comfortably wide. Worlds wear their rubble wherever there is room for it.
    // A GAS GIANT'S RUBBLE GOES IN ITS RING, not down on the cloud tops. It has
    // no surface: anything that touches the tops is SWALLOWED (CFG.GAS_*), so a
    // band starting at 1.06 radii put two dozen pieces one nudge away from
    // being eaten — and the giant duly ate its own belt, ~100 pieces in the
    // first few seconds. Its rubble joins the ice ring instead, which thickens
    // the feature it already has rather than inventing a second one underneath.
    const gas = p.ptype === 'gas';
    // The inner clearance is proportional PLUS an absolute pad: 6% of a
    // 180-unit inner world is 11 units, less than the width of a belt piece,
    // so a small world's rubble sat one nudge from grinding on its own surface.
    let lo = gas ? reach * 1.5 : reach * 1.06 + 26;
    let best = null;
    const hiCap = reach * (gas ? 2.2 : CFG.CRUST_BAND_HI);
    for (const [s, e] of blocked) {
      const hi = Math.min(s, hiCap);
      if (hi - lo > (best ? best[1] - best[0] : 0)) best = [lo, hi];
      lo = Math.max(lo, e);
      if (lo >= hiCap) break;
    }
    if (hiCap - lo > (best ? best[1] - best[0] : 0)) best = [lo, hiCap];
    if (!best) continue;
    // Shrink the pieces to fit a tight gap rather than abandoning it; below a
    // few units they stop reading as rubble at all, so give up there.
    crMax = Math.min(crMax, (best[1] - best[0]) * 0.5 - 6);
    if (!(crMax > 5)) continue;   // written so a NaN falls through to `continue`
    const inner = best[0] + crMax, outer = best[1] - crMax;
    if (!(outer > inner)) continue;
    // A gas giant already carries its ring chunks out past this band; the solid
    // worlds get the full count. Scaled off radius, so a giant wears a real
    // shell and a small inner world a thin one rather than the same four specks.
    // The divisor rides PLANET_R_MUL (normalised to the 3x sky it was tuned
    // on): the count should follow a world's size CLASS, not the global
    // growth knob — otherwise every scale pass multiplies the whole sky's
    // body count as a side effect of making the worlds bigger.
    const n = Math.round((p.ptype === 'gas' ? 12 : 18)
      * (0.5 + p.radius / (620 * (CFG.PLANET_R_MUL / 3))));
    // EVENLY SPACED SLOTS, jittered — not a free scatter. At this piece size a
    // uniform random draw puts several pairs on top of each other at spawn, and
    // overlapping bodies are eaten by the gentle-contact absorb rule before the
    // world has finished loading.
    for (let i = 0; i < n; i++) {
      const a = ((i + rand(rng, 0.12, 0.88)) / n) * TAU;
      // Weighted inward: a shell is densest near the surface it came off.
      const br = inner + (outer - inner) * Math.pow(rng(), 1.6);
      const x = p.x + Math.cos(a) * br, y = p.y + Math.sin(a) * br;
      const cr = crMax * rand(rng, 0.3, 1);
      // Don't spawn ON something already railed here. The lane search above
      // only avoids satellites big enough to hold a lane (radius >= 8); the
      // gas rings are 5-unit ice pellets scattered right through the band this
      // rubble joins, and a piece born overlapping one is eaten by the
      // gentle-contact absorb rule before the world has finished loading.
      let clear = true;
      for (const q of sats) {
        if (Math.hypot(q.x - x, q.y - y) < q.radius + cr + 14) { clear = false; break; }
      }
      if (!clear) continue;
      const v = orbitVel(p, x, y, 1);
      const c = spawnAsteroid(bodies, x, y, v.vx, v.vy, crustMass(cr));
      makeChunk(c, cr, worldDebris(p.ptype, p.color, rng()));
      railBody(c, p);
      // RIGID SHELL: one angular rate for the whole thing, shared with the
      // crust a wounded world calves into the same band (entities.chunkHaloW).
      // Mixed rates inside one shell means neighbours catch up and grind.
      c.rail.w = chunkHaloW(p);
      // The piece just placed has to be visible to the remaining slots — the
      // old test read `bodies`, which was growing under it as the belt filled.
      sats.push(c);
    }
  }

  // ---- MOON SHELLS (2026-08 user call: "moons should have more chunks
  // orbiting them"). The bigger moons wear a few pieces of their own rubble —
  // the same idiom as the planet belts above: railed, rigid shell rate
  // (chunkHaloW), pieces sized off the host, material from worldDebris so a
  // moon's shell and what breaks off it are visibly the same stuff.
  // CLEARANCE IS MEASURED, NOT ASSUMED. A shell reaches past the moon's own
  // disc, and sibling orbits are only guaranteed apart by spawnMoon's margin
  // — so each moon's real radial slack to its nearest railed neighbour
  // (sibling moons, stations, nests) is computed here, and the shell takes at
  // most 45% of it (both sides of a shared gap together stay under 100%).
  // A tight family shrinks its shells; a crowded one skips them. The shepherd
  // is a moonlet holding open a ring gap — rubble is the opposite of its job.
  for (const m of bodies) {
    if (m.type !== 'moon' || m.shepherd || !m.rail || m.radius < 100) continue;
    const host = m.rail.parent;
    const myA = m.rail.e !== undefined ? m.rail.a : m.rail.r;
    const myEx = m.rail.e !== undefined ? m.rail.e * myA : 0;
    if (!Number.isFinite(myA)) continue;
    let slack = Infinity;
    for (const q of bodies) {
      if (q === m || !q.rail || q.rail.parent !== host) continue;
      if (q.type !== 'moon' && q.type !== 'station' && q.type !== 'nest') continue;
      const qa = q.rail.e !== undefined ? q.rail.a : q.rail.r;
      const qex = q.rail.e !== undefined ? q.rail.e * qa : 0;
      if (!Number.isFinite(qa)) continue;
      slack = Math.min(slack, Math.abs(myA - qa) - myEx - qex - m.radius - q.radius);
    }
    const lo = m.radius * 1.12 + 16;
    const hi = Math.min(m.radius * 1.55,
      m.radius + (slack === Infinity ? m.radius * 0.55 : Math.max(0, slack * 0.45)));
    const cMax = Math.min(m.radius * 0.07, 26);
    if (cMax < 4 || hi - lo < cMax * 2 + 8) continue;
    const n = Math.round(3 + m.radius / 55);
    for (let i = 0; i < n; i++) {
      // Evenly spaced slots, jittered — the planet belts' anti-overlap rule.
      const a = ((i + rand(rng, 0.15, 0.85)) / n) * TAU;
      const br = rand(rng, lo + cMax, hi - cMax);
      const x = m.x + Math.cos(a) * br, y = m.y + Math.sin(a) * br;
      const cr = cMax * rand(rng, 0.35, 1);
      const v = orbitVel(m, x, y, 1);
      const c = spawnAsteroid(bodies, x, y, v.vx, v.vy, crustMass(cr));
      makeChunk(c, cr, worldDebris(m.moonType === 'ice' ? 'ice' : 'rock', m.color, rng()));
      railBody(c, m);
      c.rail.w = chunkHaloW(m);
    }
  }
}

// DENSE FIELDS — rock shoals packed tight enough that flying one is weaving,
// not cruising. Radii sit in the gaps between planet LANES and clear of the
// existing belts. Each field is home to a finite SHOAL LURKER brood
// (CFG.FIELD_BROOD, ai.js) — the second and only other alien source besides
// nests; a brood destroyed quiets its field for the run.
// SINCE THE SEEDED-LAYOUT PASS the radii arrive as an argument: generateWorld
// hands in the lane-gap MIDPOINTS of the sky this seed actually built (the
// slots carrying fieldMid markers in buildLayout), so a pocket keeps riding
// its lane gap however the lanes were drawn — a fixed radius would land ON a
// lane two seeds out of three. The names travel with the markers: The Shoal
// in the warm gap, The Grindstones against the amber giant, The Hushfield in
// the wide outer gap, and The Farshoal on the frost fringe beyond every lane,
// brushing the Oort warning band — evocative and harmless: Oort grinding
// bites the SHIP only, rocks and lurkers are immune.

// Field rock mass — the full ladder without belt rock's heavy pebble skew: a
// shoal made of specks reads as space debris, not as terrain you thread. The
// exponent is near-linear (1.05 vs the belt's 2.2) so every size is well
// represented, and nearly HALF the pocket is deliberately chunky. Masses above
// CFG.ATTRACT_MIN are fine HERE and nowhere else: markFieldRock forces
// `attractor = false` at any mass, so field rock never joins the
// O(bodies x attractors) gravity loop no matter how big it rolls. (History:
// before that rule, ordinary asteroidMass here minted ~107 permanent
// attractors and nearly doubled the hot loop.)
//
// The ladder was shifted UP as a whole (chunky share 0.35 -> 0.46, and the
// small tier's floor 120 -> 220): the shoal reads as terrain made of rock you
// thread between, and the smallest grade was carrying too much of the count
// for how little it contributes to that. Trading specks for chunk keeps the
// pocket's nearest-neighbour spacing where it was (~148u centre-to-centre, ~26u
// surface-to-surface, measured on seed 20260721 at FIELD_ROCKS 740)
// while the visible material in it goes up — LESS gravel, MORE rock, which is
// a different thing from "denser".
//
// AND IT KNOWS WHERE IT IS. `frac` is the rock's normalised distance from the
// heart (config.fieldFrac, 0 at the centre and 1 at the outline), and both the
// chunky tier's share and the ladder's overall scale fall across it. A pocket
// whose gravel is the same size everywhere reads as one texture stretched over
// a big area; graded, the middle is where the material is and the rim is where
// it runs out. The endpoints (CFG.FIELD_CHUNK_* / FIELD_GRAVEL_TAPER) are set
// so the MEAN gravel mass barely moves — the gradient is the change, not the
// tonnage.
function fieldMass(rng, frac = 0.5) {
  const t = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const chunky = CFG.FIELD_CHUNK_CORE + (CFG.FIELD_CHUNK_EDGE - CFG.FIELD_CHUNK_CORE) * t;
  const scale = CFG.FIELD_GRAVEL_TAPER[0]
    + (CFG.FIELD_GRAVEL_TAPER[1] - CFG.FIELD_GRAVEL_TAPER[0]) * t;
  if (rng() < chunky) return (2200 + rng() * 4200) * scale;   // chunky tier
  return (220 + Math.pow(rng(), 1.05) * 1780) * scale;
}

// Stamp a body as FIELD ROCK — the shoal's own material. Exported because
// physics.shatter mints new field rock when a giant breaks apart, and every
// property here has to travel with the shards or the pocket slowly turns back
// into ordinary belt gravel.
//   - fieldRock: no gravity FELT (physics Phase 1), livelier bounce, tough
//     against its own kind
//   - attractor false: no gravity EXERTED, at any mass. Giants are heavy
//     enough to qualify by the ordinary ATTRACT_MIN rule, and a heavy
//     attractor sitting in a pocket built for knocking rocks together would
//     quietly turn the shoal into its own little solar system — and put
//     dozens of extra bodies into the O(bodies x attractors) gravity loop.
//   - hp x FIELD_HP_MUL: it survives the chaos it exists to create.
// A rock's HOME, in the pocket's own rotating frame (tangential/radial offsets
// in world units — config.fieldFrac's projection, so home and containment can
// never disagree about the frame). Because the pocket is rigid, this is constant
// for the run: the pocket turns, the offsets do not.
//
// It exists so a stirred-up shoal comes BACK, and specifically so the SWIMLANES
// do (user design law: "the rocks should slowly revert back to their rail after
// getting moved around — we want to keep the swimlanes mostly intact"). Settling
// a rock wherever it happened to stop is what silts a route up over a run; the
// pocket has to reconstitute the layout it was seeded with, not merely stop
// moving. physics.js does the drifting.
export function setFieldHome(b, f) {
  const dx = b.x - f.x, dy = b.y - f.y;
  const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
  b.homeTan = -dx * sa + dy * ca;
  b.homeRad = dx * ca + dy * sa;
  return b;
}

export function markFieldRock(b, fi) {
  b.field = fi;
  b.fieldRock = true;
  b.attractor = false;
  // Capped: FIELD_HP_MUL alone made a monolith ~34k hp — unbreakable, which
  // contradicts "bigger rocks break into pieces and keep the chaos going".
  // At the cap, a thrown moon-class mass still cracks anything in the shoal.
  // The gravel is tough (FIELD_HP_MUL); the LANDMARKS are meant to come apart.
  // Stacking the gravel's 6x on a giant is what made one take 172 solid hits.
  // ORDER MATTERS: `b.bigShape` must already be set when this runs. Every caller
  // shapes first and marks second — physics.js's fracture path marked first once
  // and silently armoured every piece at the gravel class.
  const mul = b.bigShape ? CFG.FIELD_BIG_HP_MUL : CFG.FIELD_HP_MUL;
  b.hp = b.maxHp = Math.min(b.maxHp * mul, CFG.FIELD_HP_CAP);
  return b;
}

// A scatter point inside a field's LOBED outline, returned in the pocket
// frame (tangential along the lane, radial across it). sqrt(u) keeps the
// scatter area-uniform inside the outline instead of piling up at the middle,
// and the direction is drawn against the lobe radius (rejection, bounded) so
// the bulges are as densely packed as the pinches — sampling directions flat
// would leave every bulge visibly thinner than the waist.
// The last few percent land OUTSIDE the outline as stragglers: a shoal that
// stops dead at its boundary has a drawn edge, which is exactly the hard
// in-world line the design law forbids. The ragged fringe is what makes the
// pocket end the way weather does.
// Returns WORLD coords, because the flat pocket frame config.fieldFrac
// measures in is not the sun-polar frame the rails want: the arc term has to
// use the LOCAL radius, and the tan²/2r term undoes the chord bow. Without
// that correction a 3900u-long pocket at the inner lane sags ~730u sunward at
// its ends — a third of its own half-thickness — and the containment test
// stops agreeing with where the rocks visibly are.
// `pow` is the exponent on the normalised radius (see CFG.FIELD_*_POW): 0.5 is
// area-uniform, larger pulls the draw toward the HEART. It is a parameter and
// not a constant because the same sampler places a monolith, a giant and loose
// gravel, and those want different gradients — the biggest rock hard into the
// middle, the gravel gently, the fringe stragglers not at all.
function fieldPoint(f, sun, rng, pow = 0.5) {
  let th = rng() * TAU, lb = fieldLobe(f, th);
  for (let k = 0; k < 3; k++) {
    if (rng() < (lb * lb) / (FIELD_LOBE_MAX * FIELD_LOBE_MAX)) break;
    th = rng() * TAU; lb = fieldLobe(f, th);
  }
  let q = Math.pow(rng(), pow) * lb;
  // The fringe straggler is drawn AFTER the taper and pushes outward regardless
  // of it: the ragged edge is the no-hard-edges law, and a pocket that tapers
  // its way to nothing at the rim would still end on a visible boundary — it
  // would just end on a fainter one.
  if (rng() < 0.07) q *= 1 + rng() * 0.35;
  const tan = Math.cos(th) * q * CFG.FIELD_LEN;
  const rad = Math.sin(th) * q * CFG.FIELD_SPREAD;
  const w = pocketToWorld(f, sun, tan, rad);
  const rr = w.rr, a = w.a;
  // `qn` is this draw's position in config.fieldFrac units — 0 at the heart, 1
  // at the outline. Handed back rather than re-derived, because the packer's
  // radial frontier (packBigRock) tests every candidate against it and
  // fieldFrac would redo the whole projection to recover a number that was in
  // hand here. It is exactly `q / lb`: fieldFrac divides the same q by the same
  // lobe radius at the same bearing.
  // `tan`/`rad` ride along for the lane test — they are the pocket-frame
  // coordinates this point was built FROM, so handing them back costs nothing
  // and avoids projecting the world position straight back again.
  return { x: sun.x + Math.cos(a) * rr, y: sun.y + Math.sin(a) * rr,
    qn: q / lb, tan, rad };
}

// The pocket frame -> world. Pulled out of fieldPoint because the packer's bank
// draw (see packBigRock) builds points in the pocket frame directly rather than
// from a bearing and a radius, and both have to land in the same place.
// The arc term uses the LOCAL radius and the tan^2/2r term undoes the chord bow
// — without that a 3900u-long pocket at the inner lane sags ~730u sunward at its
// ends and the containment test stops agreeing with where the rocks are.
function pocketToWorld(f, sun, tan, rad) {
  const rr = f.r + rad + (tan * tan) / (2 * f.r);
  const a = f.ang + tan / rr;
  return { rr, a, x: sun.x + Math.cos(a) * rr, y: sun.y + Math.sin(a) * rr };
}

// RUBBLE: a point on a skirt just off one of the pocket's huge rocks. Small
// rock banks up against the masonry instead of being scattered evenly, which
// is what keeps the gaps between the big rocks flyable — a uniform scatter
// silts every passage up and the maze stops existing at the only scale the
// ship cares about. A minority (CFG.FIELD_RUBBLE_LOOSE) still spawns loose, or
// the pocket reads as a set of rings drawn around boulders.
// How likely a rock is to be KEPT where it landed: 1 at the heart, falling to
// CFG.FIELD_EDGE_KEEP at the outline and holding there. It holds rather than
// continuing to fall because the fringe past the outline is the ragged edge the
// no-hard-edges law asks for, and thinning it toward nothing would put the
// visible boundary back — just a softer one, in a different place.
function fieldKeep(f, x, y) {
  const t = Math.min(1, fieldFrac(f, x, y));
  return 1 + (CFG.FIELD_EDGE_KEEP - 1) * t;
}

// The skirt draw needs no taper of its own: it banks against the huge rocks,
// and those are now packed from the heart outward, so the gravel inherits the
// gradient from its hosts. Only the LOOSE minority is drawn against the pocket
// directly, and that is the draw CFG.FIELD_RUBBLE_POW pulls inward.
function rubblePoint(f, sun, rng, bigs) {
  if (!bigs.length || rng() < CFG.FIELD_RUBBLE_LOOSE) {
    return fieldPoint(f, sun, rng, CFG.FIELD_RUBBLE_POW);
  }
  const h = bigs[Math.floor(rng() * bigs.length)];
  const a = rng() * TAU;
  const d = h.radius * 1.02
    + rand(rng, CFG.FIELD_RUBBLE_BAND[0], CFG.FIELD_RUBBLE_BAND[1]);
  return { x: h.x + Math.cos(a) * d, y: h.y + Math.sin(a) * d };
}

// ---- SWIMLANES: routes THROUGH the rock (user design law) -------------------
//
// "Tight swimlanes throughout these, so if you follow the path you have a better
// shot of getting out." A pocket that is uniformly impassable is not a maze, it
// is a wall; the lanes are what make working your way in and back out a skill
// rather than a grind.
//
// THIS REVERSES AN EARLIER DECISION AND HAS TO ANSWER WHY IT FAILED BEFORE.
// Corridors were tried once and rejected on two counts (see the MAZE note in
// config.js): they "read as randomly generated cleared paths", and "the thing
// actually blocking you was gravel rather than anything you could see coming".
// Both are addressed here, and neither is optional:
//   - THE WIDTH BREATHES. A constant-width channel is the thing that reads as
//     drawn. Each lane's half-width runs through a couple of slow sine terms, so
//     it pinches to a squeeze and opens into a bay along its length, and no two
//     stretches of the same lane look alike.
//   - GRAVEL IS CLEARED TOO, not just the masonry. A lane the landmarks respect
//     and the pebbles silt up is exactly the old failure. That is what
//     CFG.FIELD_LANE_LEAK moderates: a small share of gravel ignores the lane
//     entirely, so the EDGE is ragged and a route is a place rock thins out
//     rather than a channel with a kerb.
//
// Lanes are stored in the POCKET FRAME (tangential/radial offsets in world
// units, the same frame config.fieldFrac projects into) so they rotate with the
// pocket for free and cost nothing to maintain — and so the reknit and the
// rocks' own drift home can both read them and keep the routes open over a run.
// One curved road between two pocket-frame points. A quadratic Bezier with the
// control point pushed off the chord, so an edge bows rather than running
// straight — a network of straight segments reads as a diagram.
function buildEdge(rng, a, b, bow) {
  const mx = (a.tan + b.tan) / 2, my = (a.rad + b.rad) / 2;
  const ex = b.tan - a.tan, ey = b.rad - a.rad;
  const el = Math.hypot(ex, ey) || 1;
  const cx = mx - (ey / el) * bow, cy = my + (ex / el) * bow;
  const pts = [];
  const N = 18;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1), u = 1 - t;
    pts.push({
      tan: u * u * a.tan + 2 * u * t * cx + t * t * b.tan,
      rad: u * u * a.rad + 2 * u * t * cy + t * t * b.rad,
    });
  }
  return {
    pts,
    w0: rand(rng, CFG.FIELD_LANE_W[0], CFG.FIELD_LANE_W[1]),
    k1: rand(rng, 1.7, 3.1), p1: rng() * TAU,
    k2: rand(rng, 4.3, 6.9), p2: rng() * TAU,
  };
}

// THE ROADS ARE A NETWORK, NOT A HANDFUL OF CROSSINGS (user design law: "smaller
// and more intricate and connecting").
//
// Three independent rim-to-rim curves gave three ways through and no way to
// change your mind — and because each was wide enough to need its own clearing,
// they had to be routed around the core, so following one inward just opened out
// into undifferentiated space. Narrow roads fix both halves at once: a 70-unit
// channel can THREAD between 300-unit rocks instead of deleting them, so the
// network can reach the middle, and it can afford far more edges.
//
// Built as a graph over shared nodes, so the roads genuinely meet rather than
// crossing coincidentally: junctions are a property of the structure. Node sites
// are chosen by looking for the quietest spot at a target radius — the routes
// still FOLLOW the gaps the masonry left (see the note above findLanes' old
// form), they are simply joined up now.
function findLanes(f, rng, slots) {
  const L = CFG.FIELD_LEN, S = CFG.FIELD_SPREAD;
  // How hemmed-in a pocket-frame point is: nearby rock, weighted by proximity.
  const crowd = (tan, rad) => {
    let c = 0;
    for (const sl of slots) {
      const d = Math.hypot((sl.tan || 0) - tan, (sl.rad || 0) - rad) - sl.r;
      if (d < 520) c += 520 - Math.max(0, d);
    }
    return c;
  };
  // INTERIOR JUNCTIONS, spread across the radius so the network reaches the
  // middle instead of ringing it. Each is the quietest of several draws at its
  // target radius — a junction in a wall would force every road through it to
  // delete rock.
  const nodes = [];
  const NN = CFG.FIELD_LANE_NODES;
  for (let i = 0; i < NN; i++) {
    const tq = 0.14 + (0.62 * i) / Math.max(1, NN - 1);
    let best = null, bestC = Infinity;
    for (let t = 0; t < 16; t++) {
      const a = rng() * TAU, q = tq * rand(rng, 0.8, 1.2);
      const n = { tan: Math.cos(a) * q * L, rad: Math.sin(a) * q * S };
      const c = crowd(n.tan, n.rad);
      if (c < bestC) { bestC = c; best = n; }
    }
    nodes.push(best);
  }
  // RIM MOUTHS — where the network opens onto the approach.
  const rim = [];
  for (let i = 0; i < CFG.FIELD_LANES; i++) {
    const a = (i / CFG.FIELD_LANES) * TAU + rand(rng, -0.35, 0.35);
    rim.push({ tan: Math.cos(a) * 1.12 * L, rad: Math.sin(a) * 1.12 * S });
  }
  // EDGES: every mouth reaches its nearest junction, the junctions are chained
  // so the interior is connected end to end, and a few chords close loops — a
  // tree would mean exactly one route between any two points, which is a maze
  // solution, not a road network.
  const pairs = [];
  for (const r of rim) {
    let n = nodes[0], nd = Infinity;
    for (const c of nodes) {
      const d = Math.hypot(c.tan - r.tan, c.rad - r.rad);
      if (d < nd) { nd = d; n = c; }
    }
    pairs.push([r, n]);
  }
  for (let i = 0; i < nodes.length; i++) pairs.push([nodes[i], nodes[(i + 1) % nodes.length]]);
  for (let i = 0; i + 2 < nodes.length; i += 2) pairs.push([nodes[i], nodes[i + 2]]);
  // Each edge takes the quietest of a few bows, so an individual road still
  // picks its way through what is actually there.
  //
  // NO SEPARATION TERM, ON PURPOSE. Cost is rock displacement alone: nothing
  // here pushes two roads apart. There used to be a documented/tuned constant
  // for this (config's FIELD_LANE_APART, now deleted), but `findLanes` never
  // actually read it. The network form makes it the wrong idea rather than an
  // unfinished one. Measured over 3 seeds x 4 pockets, of the pairs
  // running closest together essentially all are indices >= 8 — the junction
  // CHAIN and the CHORDS — while the 8 rim edges stay well clear of each
  // other. That is the topology, not a defect: a chord from node i to i+2
  // exists to shortcut the chain through i+1, so it is DEFINED as running
  // alongside it. A separation cost would push chords off the chains they are
  // built to close, and buy nothing on the rim edges, which never needed it.
  const lanes = [];
  for (const [a, b] of pairs) {
    const span = Math.hypot(b.tan - a.tan, b.rad - a.rad);
    let best = null, bestC = Infinity;
    for (let t = 0; t < CFG.FIELD_LANE_TRIES; t++) {
      const ln = buildEdge(rng, a, b, rand(rng, -0.42, 0.42) * span);
      let cost = 0;
      for (const sl of slots) {
        const d = laneDepthOne(ln, sl.tan || 0, sl.rad || 0) + sl.r;
        if (d > 0) cost += d * d;
      }
      if (cost < bestC) { bestC = cost; best = ln; }
    }
    if (best) lanes.push(best);
  }
  return lanes;
}

// Half-width of `ln` at normalised position `t` along it. Breathing, never
// constant — see seedLanes. Floored so a pinch is a squeeze, not a blockage.
function laneWidth(ln, t, q) {
  const m = 1 + 0.42 * Math.sin(ln.k1 * t * TAU + ln.p1)
    + 0.24 * Math.sin(ln.k2 * t * TAU + ln.p2);
  // NARROWER TOWARD THE MIDDLE. Two reasons, and they agree: a wide channel
  // through the core displaces the rock the core exists to hold, and squeezing
  // through the dense part is what a route should FEEL like — it opens out as
  // you near the rim, which is also the direction it is getting you.
  const taper = q === undefined ? 1 : 0.55 + 0.45 * Math.min(1, q / 0.6);
  return ln.w0 * Math.max(0.45, m) * taper;
}

// How far INSIDE a lane the pocket-frame point (tan, rad) sits, in world units:
// > 0 means it is in the clear channel by that much, <= 0 means it is not in a
// lane at all. Walks every lane's segments — 3 lanes x 25 segments is nothing
// against the packer's own budget, and it is exact rather than a grid lookup
// that would quantise the very edge the leak is there to keep ragged.
function laneDepth(f, tan, rad) {
  let best = -Infinity;
  if (!f.lanes) return best;
  let bw = 0, bx = 0, by = 0;
  for (const ln of f.lanes) {
    const d = laneDepthOne(ln, tan, rad);
    if (d > best) { best = d; bw = _laneW; bx = _laneCx; by = _laneCy; }
  }
  _laneW = bw; _laneCx = bx; _laneCy = by;
  return best;
}

// Depth inside ONE lane. Split out so a candidate route can be scored against
// the rock already on the ground before it is adopted (see findLanes).
let _laneW = 0;   // half-width of the channel at the closest point of the last query
let _laneCx = 0, _laneCy = 0;   // ...and that closest point, in the pocket frame
function laneDepthOne(ln, tan, rad) {
  let best = -Infinity;
  {
    const p = ln.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i].tan, ay = p[i].rad;
      const ex = p[i + 1].tan - ax, ey = p[i + 1].rad - ay;
      const len2 = ex * ex + ey * ey || 1;
      let s = ((tan - ax) * ex + (rad - ay) * ey) / len2;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const dx = tan - (ax + ex * s), dy = rad - (ay + ey * s);
      const d = Math.hypot(dx, dy);
      const t = (i + s) / (p.length - 1);
      // Normalised radius of the CLOSEST POINT on the lane, which is what the
      // taper is about — not of the query point, or a rock just outside a core
      // stretch would be tested against the rim's generous width.
      const cx = (ax + ex * s) / CFG.FIELD_LEN, cy = (ay + ey * s) / CFG.FIELD_SPREAD;
      const hw = laneWidth(ln, t, Math.hypot(cx, cy));
      const w = hw - d;
      if (w > best) { best = w; _laneW = hw; _laneCx = ax + ex * s; _laneCy = ay + ey * s; }
    }
  }
  return best;
}

// The same test from WORLD coordinates. The projection is fieldFrac's, so
// "inside a lane" and "inside the pocket" can never disagree about the frame.
function laneDepthAt(f, x, y) {
  const dx = x - f.x, dy = y - f.y;
  const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
  return laneDepth(f, -dx * sa + dy * ca, dx * ca + dy * sa);
}

// EXACT surface clearance between two placed/candidate rocks, in world units.
// Negative means they interpenetrate.
//
// Only ever called when the cheap conservative bound has already REJECTED a
// candidate — that structure is what makes an exact test affordable here. The
// bound has to cover the whole arc over which two rocks could touch, so for two
// large rocks it approaches their global reach and holds them much further apart
// than they need to be: measured, mean surface gap to the nearest landmark ran
// ~30 units for every size class but 250+, which sat at 89. Using the bound to
// ACCEPT (where it is free and always right) and this to arbitrate the near
// misses (where the bound is merely pessimistic) gets both — the guarantee and
// the tightness.
// (History: this mirrored physics.bigPenetration, the radial probe that walked
// one surface through the arc facing the other. Both went with the collider
// rewrite; this is convex-hull SAT via rockshape.rockOverlap now.)
// EXACT, and now genuinely exact rather than exact-to-seven-probes. The old
// version walked each radial outline through the arc the other subtended and
// took the worst surface-to-surface distance — correct only because both shapes
// were radial functions, and only as good as the probe count. The baked shapes
// are convex-decomposed, so overlap is a boolean SAT query against a handful of
// hulls: cheaper than seven probes and right at every bearing rather than seven
// of them.
//
// It answers a BOOLEAN, and the caller still bounds with reachAt first. That
// split is the point: the bound is free and always right, so it ACCEPTS; this
// arbitrates the near misses the bound is merely pessimistic about. Using the
// bound as the decision strands the biggest rocks in their own clearings
// (measured: mean surface gap ~30 units for every size class but 250+, which
// sat at 89), and using this for everything spends exact work ranking candidates
// that were going to be rejected anyway.
// TWO PERSISTENT PROXIES, MUTATED IN PLACE — not a micro-optimisation, the
// difference between a 1s worldgen and a 3.7s one. rockshape caches each body's
// world-space hulls keyed on (shape, radius, rotation) and applies TRANSLATION
// at read time, so moving a proxy costs nothing while a fresh object per call
// re-rotates and re-allocates every hull. The packer runs hundreds of rocks x
// 170 tries x every slot placed so far, per pocket, on every worldgen — and
// worldgen runs constantly (freshRun / mechTest), so this path is hot in a way
// its call site does not look.
const _pgA = { id: 0, shapeId: null, x: 0, y: 0, rot: 0, radius: 1 };
const _pgB = { id: 0, shapeId: null, x: 0, y: 0, rot: 0, radius: 1 };
function put(p, x, y, r, shapeId, rot) {
  // Only the cache-invalidating fields are compared; x/y are free to change.
  if (p.shapeId !== shapeId || p.radius !== r || p.rot !== rot) {
    p.shapeId = shapeId; p.radius = r; p.rot = rot;
    p._hw = null; p._rs = null;
  }
  p.x = x; p.y = y;
  return p;
}
function pairOverlaps(gx, gy, gr, gShape, gRot, px, py, pr, pShape, pRot) {
  return rockOverlap(put(_pgA, gx, gy, gr, gShape, gRot),
                     put(_pgB, px, py, pr, pShape, pRot));
}

// PACK THE HUGE ROCKS. This is the maze generator — there is no other one.
//
// Draw a position from the pocket sampler and keep it only if the rock clears
// every huge rock already placed by a gap drawn from CFG.FIELD_PACK_GAP. The
// gap is drawn PER PAIR, so the spacing is different everywhere: at the low end
// two neighbours read as touching and wall a route off, at the high end they
// leave a passage the ship can turn around in. That per-pair draw is the whole
// mechanism — passages open and close because the rock is spaced unevenly, not
// because anything decided where a corridor should go.
//
// A HUGE ROCK MUST NEVER BE BORN ON A CELESTIAL. `keepOut` is the pocket's
// local shortlist of worlds, moons and stations, and it is not optional: a
// pocket reaches FIELD_SPREAD x FIELD_LOBE_MAX either side of its lane, which
// overlaps the neighbouring PLANET lanes, and a landmark rock is 200-390 units
// across. Without this the packer put rocks straight on top of moons —
// measured on seed 111222333, three moons started inside a giant (overlaps of
// 39, 39 and 149 units) and ONE OF THEM WAS DEAD INSIDE A SECOND. That is the
// silent-deorbit failure the balance baseline exists to catch, and it only
// appeared when the rocks got big enough to reach.
// The shortlist is built once per pocket rather than scanned per try: the
// packer runs ~205 rocks (CFG.FIELD_GIANTS 200 + FIELD_MONOLITHS 5) x
// CFG.FIELD_PACK_TRIES 170 x 4 fields per worldgen, and freshRun / mechTest
// regenerate the world constantly.
function pocketKeepOut(game, f) {
  const reach = CFG.FIELD_LEN * FIELD_LOBE_MAX + 1200;
  const out = [];
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'asteroid') continue;
    if (Math.hypot(b.x - f.x, b.y - f.y) > reach + b.radius) continue;
    out.push(b);
  }
  return out;
}

// Returns how many were placed. Placement is best-effort within a bounded try
// budget: a pocket this full rejects most draws, and seedDenseFields reports
// what actually landed rather than looping until it fits.
// `spec` entries are {mass, r, pow, qMax} — `r` is the rock's FINAL radius,
// size draw and class multiplier already folded in by the caller. It is resolved
// up front rather than derived here because the packer has to know the true
// radius before it looks for room: placing on a class radius and varying
// afterwards is the same bug the celestial keep-out fixes, a rock that grew
// after placement overlapping whatever it was measured to clear. (It is also
// why the caller passes a radius rather than a mass->radius function now — the
// giant multiplier is graded per rock, so there is no such function.)
// THE BIGGEST GO IN FIRST AND THEY GO IN THE MIDDLE. `spec` is placed in the
// order given (seedDenseFields sorts it heaviest-first) and each entry carries
// its own `pow`, interpolated from CFG.FIELD_CORE_POW down to FIELD_EDGE_POW
// across the size range — so a monolith is drawn hard toward the heart and the
// smallest giant is drawn almost anywhere. Combined with heaviest-first, the
// core fills with the big masonry and everything after it packs around and
// outward from that, which is the clumping the pocket is supposed to have.
//
// THE BIAS IS DROPPED ON THE LAST TRIES, and that is not a detail. The packer
// is best-effort within a try budget, and a centre-biased draw into a centre
// that is already full rejects every candidate — so the rock would be silently
// LOST rather than placed further out, and the count that vanishes is exactly
// the biggest rocks. Past FIELD_PACK_BIAS_TRIES the draw goes back to uniform
// and the rock takes what room is left.
//
// ...BUT `sp.qMax` SURVIVES THAT DROP, and it is what actually grades a pocket.
// Biasing the SAMPLER alone does not, and the measured reason is this function's
// own greedy-snug rule: scoring candidates by distance-to-nearest-neighbour
// makes the masonry fill outward from whatever is already placed, so the pocket
// saturates to one flat coverage everywhere the packer can reach and the
// sampler's preference is overridden by the score. Measured with the size ramp
// and a 2.4 core exponent already in but no cap: mean landmark radius across
// five equal-AREA bands ran 165 / 153 / 157 / 153 / 121 and coverage ran
// 0.61 / 0.68 / 0.66 / 0.59 / 0.24 — flat until the very rim, which is exactly
// the "the whole thing is filled with them" this exists to fix.
// `qMax` is set in seedDenseFields from the rock's OWN SIZE (CFG.FIELD_REACH),
// with a cumulative-area valve underneath it — see the note there for why the
// area solve cannot carry this alone.
// The slack is the last-resort valve: rather than opening the whole pocket to a
// rock that cannot fit — which puts the BIGGEST rocks on the rim, the exact
// failure being fixed — a late try lets it spill just past its own band, and
// only that far.
function packBigRock(f, sun, rng, spec, slots, keepOut) {
  let placed = 0;
  for (const sp of spec) {
    const mass = sp.mass, r = sp.r;
    let spot = null, spotNear = Infinity;
    const biasTries = CFG.FIELD_PACK_TRIES * CFG.FIELD_PACK_BIAS_FRAC;
    for (let t = 0; t < CFG.FIELD_PACK_TRIES; t++) {
      // BANK AGAINST THE MASONRY (CFG.FIELD_PACK_BANK) — the same idea
      // rubblePoint uses for gravel, applied to the landmarks themselves.
      //
      // Without it the greedy-snug rule is rich-get-richer: it scores candidates
      // by distance to the nearest neighbour, so a rock drawn anywhere in the
      // pocket snugs into whatever region ALREADY has the most rock in it. The
      // biggest rocks go down first, alone, in a core the later draws then never
      // choose — and they stay alone. Measured, mean gap from a 250+ rock to its
      // nearest landmark ran ~3x every other size class however the radial
      // biases were tuned, because the bias picks WHERE candidates fall and the
      // snug score picks which one wins.
      // Drawing a share of tries on a ring just off a bigger placed rock puts
      // the choice where the problem is: small rock banks against big rock, and
      // a landmark ends up with company at its own scale.
      let p = null;
      if (slots.length > 1 && rng() < CFG.FIELD_PACK_BANK) {
        // PICKED FROM THE BIGGEST, not uniformly. `slots` is filled in
        // descending size order (heart, monoliths, then giants heaviest-first),
        // so the head of the array IS the big rock. A uniform pick over ~300
        // slots chose any given monolith 0.3% of the time, so the bank draw
        // fired constantly and almost never actually banked against the rocks
        // that needed company — 250+ mean gap sat at 91-99 through three
        // successive attempts to fix it from the radial biases.
        const top = Math.min(slots.length, CFG.FIELD_PACK_BANK_TOP);
        const g = slots[Math.floor(rng() * top)];
        // NEVER BANK AGAINST THE HEART. It is slots[0], so an unguarded pick
        // lands on it more than any other rock, and the whole point of
        // FIELD_HEART_CLEAR is that this one rock keeps a clearing — it is the
        // field's name, its chart entry, the AI's anchor and the thing you fly
        // in to reach and then have to fight. Measured with it in the pool: the
        // combat ladder's shot at the heart lost 58% of its damage to what had
        // banked in front of it.
        if (g && g.heart) { /* fall through to the ordinary draw */ } else
        if (g.r > r * 1.2) {
          const a = rng() * TAU;
          // The ring has to sit at the REAL clearance for this bearing, not at
          // the sum of nominal radii: the acceptance test below bounds both
          // rocks by their directional reach, so a ring drawn on nominal radii
          // lands inside the big rock's own corner envelope and is rejected
          // almost every time — the bank draw fires and then quietly does
          // nothing, which is exactly what it looked like (250+ mean gap 96 ->
          // 79, when it should have collapsed to the gap band).
          const dd = g.r * reachAt(g.shapeId, a - g.rot)
            + r * reachAt(sp.shapeId, a + Math.PI - sp.rot)
            + rand(rng, 2, 55);
          const tan = (g.tan || 0) + Math.cos(a) * dd;
          const rad = (g.rad || 0) + Math.sin(a) * dd;
          const w = pocketToWorld(f, sun, tan, rad);
          const nx = tan / CFG.FIELD_LEN, ny = rad / CFG.FIELD_SPREAD;
          const qq = Math.hypot(nx, ny);
          p = { x: w.x, y: w.y, tan, rad, banked: true,
            qn: qq < 1e-6 ? 0 : qq / fieldLobe(f, Math.atan2(ny, nx)) };
        }
      }
      if (!p) p = fieldPoint(f, sun, rng, t < biasTries ? sp.pow : 0.5);
      // Frontier test. Slack ramps in only after the biased tries are spent.
      if (sp.qMax !== undefined) {
        // PROPORTIONAL, not additive. A flat slack is a much bigger concession
        // to a rock held at 0.30 than to one allowed 1.15 — it moved the former
        // a third of the way out again while barely touching the latter, i.e. it
        // leaked hardest exactly where the cap matters most.
        const slack = t < biasTries ? 0
          : CFG.FIELD_FRONT_SLACK * ((t - biasTries) / (CFG.FIELD_PACK_TRIES - biasTries));
        if (p.qn > sp.qMax * (1 + slack)) continue;
      }
      // A BANKED DRAW IS ALLOWED TO TOUCH. The general band is a floor on
      // spacing for everything on the try, so a rock aimed at resting against a
      // monolith was still held the band's mean (~35 units) off it — and off
      // every other rock too. That is the difference between a landmark with
      // rock piled against it and a landmark with a moat, which is what "all
      // alone" looks like from the cockpit.
      const gap = p.banked ? rand(rng, 6, CFG.FIELD_PACK_SNUG * 2)
        : rand(rng, CFG.FIELD_PACK_GAP[0], CFG.FIELD_PACK_GAP[1]);
      let clash = false, near = Infinity;
      for (const g of slots) {
        // SPACED BY THE SHAPE'S REACH, NOT BY ITS CIRCLE. A landmark's corners
        // reach 1.14-2.45x its nominal radius across the baked library, mean 1.50
        // (rockshape.shapeReach; 1.14-1.62 was the old per-id generator, whose
        // util.ROCK_REACH_MAX 1.62 still caps the gravel outlines), so
        // packing on `r` reserved a footprint about half the size of the rock
        // that went into it, and the masonry was born INTERLOCKED — visibly
        // overlapping and clipping on every seed, before anything moved.
        //
        // REACH, not the extent along this pair's bearing. The bearing version
        // was tried and is wrong for the same reason the old collider was wrong:
        // two star polygons can clear along the line joining their centres and
        // still interlock at a corner off it. Measured with the bearing test,
        // the seeded pocket still had 60-75 overlapping pairs and the worst was
        // buried 237 units. Probing enough bearings to catch that (the collider
        // uses 14) is not affordable HERE — the packer runs hundreds of rocks x
        // 170 tries x every slot placed so far, per pocket, on every worldgen,
        // and worldgen runs constantly (freshRun / mechTest).
        // Reach is the cheap guarantee: one number per rock, and no orientation
        // can defeat it.
        // Bounded PER DIRECTION (rockshape.reachAt), not by the shape's global
        // reach. Still a strict upper bound — nothing can overlap — but an
        // honest one: a slab's longest corner points one way, and reserving for
        // it in every direction is what left the biggest rocks stranded in their
        // own clearings (see CFG.FIELD_PACK_NESTLE for the measurement).
        const ang = Math.atan2(p.y - g.y, p.x - g.x);
        const dc = Math.hypot(g.x - p.x, g.y - p.y) || 1;
        // Each rock's bound is taken over the arc the OTHER one subtends — see
        // rockshape.reachAt's `half` argument. Without the window this is a
        // centre-line bound and two large rocks interlock at a corner off it,
        // which is the clipping the reach bound exists to prevent.
        const hg = Math.min(1.2, Math.asin(Math.min(1, r * shapeReach(sp.shapeId) / dc)));
        const hp = Math.min(1.2, Math.asin(Math.min(1, g.r * shapeReach(g.shapeId) / dc)));
        const d = dc
          - g.r * reachAt(g.shapeId, ang - g.rot, hg)
          - r * reachAt(sp.shapeId, ang + Math.PI - sp.rot, hp);
        // THE HEART KEEPS ITS OWN CLEARANCE. Everything else is spaced by the
        // per-pair FIELD_PACK_GAP (4-58 units — at the low end, two neighbours
        // read as touching), and once the biggest rocks are drawn toward the
        // middle that gap welds a ring of monoliths onto the heart. Measured:
        // a staged shot at the heart lost 60% of its damage to whatever was
        // parked in front of it, and FIELD_HP_CAP exists precisely so a
        // monolith stays breakable. The heart is also the field's NAME, its
        // chart entry and the AI's anchor — it is the thing you fly in to
        // reach, so it is the one rock that is allowed some room around it.
        const want = g.heart ? CFG.FIELD_HEART_CLEAR : gap;
        let dd2 = d;
        if (d < want) {
          // The conservative bound says no. It is pessimistic by construction,
          // so ask the exact question before giving up on this spot.
          // Grow the neighbour by the gap and ask whether they touch. That
          // turns "are they at least `want` apart" into the exact boolean SAT
          // can answer, instead of a distance query the hulls cannot give
          // cheaply. Conservative at the corners, which is precisely where the
          // masonry used to be born interlocked.
          if (pairOverlaps(g.x, g.y, g.r + want, g.shapeId, g.rot,
                           p.x, p.y, r, sp.shapeId, sp.rot)) { clash = true; break; }
          // Legal but tight. Report it as exactly the gap it was required to
          // clear rather than 0 — the greedy scorer below ranks on this, and
          // handing it a 0 would make every bound-rejected-but-legal spot look
          // like the snuggest one in the pocket.
          dd2 = want;
        }
        if (dd2 < near) near = dd2;
      }
      // Celestials get a fat margin on top of both radii. Touching is not good
      // enough — a moon is MOVING, and one born a few units clear still grinds
      // itself against the rock on the first substep.
      if (!clash) for (const b of keepOut) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < b.radius + r + 260) { clash = true; break; }
      }
      if (clash) continue;
      // GREEDY: take the SNUGGEST candidate, not the first legal one.
      //
      // This is what "the rocks are too loose apart from each other" actually
      // was. Rejection sampling only avoids overlap — it does not pack. A rock
      // lands wherever it first happens to fit, which at random is usually out
      // in open space, so the pocket fills with rocks holding each other at
      // arm's length and voids scattered everywhere between them. Shrinking the
      // pocket or the gap band cannot fix that: the gap is a FLOOR on spacing,
      // never a target, and the sampler was never aiming at it.
      // Scoring on distance-to-nearest-neighbour makes each rock crowd up
      // against the mass already there, so the rock consolidates into walls and
      // the leftover space consolidates into corridors — which is the maze.
      if (near < spotNear) { spotNear = near; spot = p; }
      if (near <= CFG.FIELD_PACK_SNUG) break;   // snug enough; stop paying for tries
    }
    if (!spot) continue;                   // no room left — a full pocket, not a bug
    // The silhouette travels WITH the slot: it is what the next rock measures
    // its clearance against, and what the body is stamped with when it spawns.
    spot.r = r; spot.mass = mass; spot.shapeId = sp.shapeId; spot.rot = sp.rot;
    slots.push(spot);
    placed++;
  }
  return placed;
}

// `bigShape` is THE flag for "this rock is a shaped landmark". Both the drawn
// outline (render.traceAsteroid) and the collider (physics.surfRadius) key off
// it and nothing else — not a radius threshold on each side, which is how the
// picture and the hitbox drift apart the moment one of them is retuned or a
// rock chips its way across the line. rockshape.rockShapeOf turns it into an
// actual slab / wedge / lump off the body id.
function shapeBig(b) {
  b.bigShape = true;
  return b;
}

function seedDenseFields(game, sun, rng, fieldRs) {
  game.fields = [];
  for (let fi = 0; fi < fieldRs.length; fi++) {
    const fd = fieldRs[fi];
    const fdR = fd.r;   // WORLD units already — generated lane-gap midpoints (+ the Farshoal's SR'd berth)
    const ang0 = rng() * TAU;
    // ONE shared angular speed for the whole shoal: railBody's per-body ±4%
    // w jitter would shear a pocket this tight into a long dilute arc within
    // minutes (and same-radius rocks that catch up GRIND — the exact failure
    // the jitter comment warns about). A rigid pocket has ZERO relative
    // drift, which is what keeps "super dense" true for the whole run. The
    // FIELD's w is nudged once per field instead (deterministic off fi), so
    // the three shoals never sit in lockstep with the belts around them.
    const w = Math.sqrt(CFG.G * sun.mass / (fdR * fdR * fdR)) * (1 + (fi - 1) * 0.015);
    const f = {
      r: fdR, ang: ang0, w, name: fd.name, heart: null,
      x: sun.x + Math.cos(ang0) * fdR, y: sun.y + Math.sin(ang0) * fdR,
      brood: CFG.FIELD_BROOD, wakeT: 0, cleared: false, near: false, seen: false,
      // The pocket's own SILHOUETTE (config.fieldLobe): three harmonics drawn
      // once here, so a field's shape is part of the world seed and every
      // consumer of fieldFrac sees the same blob. Amplitudes sum to at most
      // 0.41 — under CFG's FIELD_LOBE_MAX ceiling (so the rejection sampler
      // and the LOD reach stay honest), and enough that no two of the four
      // shoals look alike from the same bearing.
      lobe: [
        rand(rng, 0.12, 0.20), rng() * TAU,
        rand(rng, 0.08, 0.13), rng() * TAU,
        rand(rng, 0.05, 0.08), rng() * TAU,
      ],
    };
    game.fields.push(f);

    // ---- 1. THE MASONRY. The huge rocks are placed FIRST and the maze is
    // whatever they leave between them (config.FIELD_PACK_GAP). Slots are
    // computed before any body exists because packing needs each rock's final
    // RADIUS, and that is mass -> asteroidRadius -> the size multiplier.
    const slots = [];
    // The HEART sits at the pocket's CENTRE, not at a packed draw. Its rail
    // angle IS the field's anchor (f.ang, read back every frame in
    // ai.updateFields), so a heart placed off-centre silently drags the whole
    // containment frame with it — measured before this rule: 40% of a shoal's
    // own rocks fell OUTSIDE fieldFrac <= 1, i.e. outside its own leash, wake
    // and entry announce.
    // THE SILHOUETTE IS DRAWN BEFORE PLACEMENT, not at first use. Packing has to
    // know the rock's true outline and which way it is turned to space it
    // correctly (see packBigRock). Drawn from the seeded stream so a pocket's
    // masonry stays a property of the world seed, then stamped on the body as
    // `shapeId` / `rot`.
    //
    // TIER IS CHOSEN FROM THE SIZE CLASS, and that is what makes a fracture
    // read: a monolith wears a tier-0 silhouette and breaks into the tier-1
    // pieces cut from it, which are the same shapes the mid-size rocks lying
    // around it are already wearing. The pieces look like they belong to the
    // pocket because they are drawn from the same shelf of the same library.
    // See docs/rock-fracture.md.
    const drawShape = (tier) => pickShapeId(rng(), tier);
    const heartMass = CFG.FIELD_MONOLITH_MASS[1];
    slots.push({ x: f.x, y: f.y, mass: heartMass, heart: true, tan: 0, rad: 0,
      r: asteroidRadius(heartMass) * CFG.FIELD_MONOLITH_R_MUL,
      shapeId: drawShape(0), rot: rng() * TAU });
    // Mass AND the per-rock size draw together — see CFG.FIELD_SIZE_VARY, and
    // packBigRock's note on why the radius has to be settled before placement.
    const vary = () => rand(rng, CFG.FIELD_SIZE_VARY[0], CFG.FIELD_SIZE_VARY[1]);
    const monoSpec = [], giantSpec = [];
    for (let i = 0; i < CFG.FIELD_MONOLITHS; i++) {
      const mass = rand(rng, CFG.FIELD_MONOLITH_MASS[0], CFG.FIELD_MONOLITH_MASS[1]);
      monoSpec.push({ mass, r: asteroidRadius(mass) * CFG.FIELD_MONOLITH_R_MUL * vary(),
        shapeId: drawShape(0), rot: rng() * TAU });
    }
    // THE LANDMARK LADDER IS A RAMP, NOT A BAND (user design law: little and
    // mid-size rock at the rim, the large ones packed in toward the centre).
    // Rank i walks CFG.FIELD_GIANT_MASS from its core end down to its rim end,
    // so the class is a continuum of sizes rather than 240 draws from one band —
    // and since the pull toward the heart below is set from each rock's own
    // place on that ramp, size and position are the SAME gradient rather than
    // two that happen to correlate.
    //
    // In LOG space, because radius goes with cbrt(mass): a linear ramp across
    // 4,200-360,000 spends over half its length above 180,000, where every rock
    // is within 15% of the same drawn size, and the visible half of the ladder
    // gets squeezed into the last few ranks.
    //
    // The jitter is what keeps it a distribution instead of a staircase.
    // Slightly wider than one rung (1.6 / N), so adjacent ranks overlap and the
    // ordering is a tendency rather than a sort — without it a pocket grades in
    // visibly concentric size bands, which reads as authored.
    const gLo = Math.log(CFG.FIELD_GIANT_MASS[0]), gHi = Math.log(CFG.FIELD_GIANT_MASS[1]);
    const [mulLo, mulHi] = CFG.FIELD_GIANT_R_MUL;
    const gN = CFG.FIELD_GIANTS;
    for (let i = 0; i < gN; i++) {
      const u = gN > 1 ? i / (gN - 1) : 0;   // 0 = core end of the ladder, 1 = rim
      // SKEWED toward the small end (CFG.FIELD_GIANT_SKEW) — see the note there
      // for why an even spread is not the neutral choice it looks like.
      const t = Math.min(1, Math.max(0,
        Math.pow(u, CFG.FIELD_GIANT_SKEW) + (rng() - 0.5) * (1.6 / gN)));
      const mass = Math.exp(gHi + (gLo - gHi) * t);
      // The size multiplier rides the SAME t as the mass — see the note on
      // CFG.FIELD_GIANT_R_MUL: density falls with size, which is what gives the
      // class a mid-size rung without dropping its small end below the gravel.
      const mul = mulHi + (mulLo - mulHi) * t;
      // TIER OFF THE SAME `t` as the mass and the size multiplier. The three
      // ride one gradient, so the pieces a rock breaks into are drawn from the
      // shelf its own neighbours came from — which is what stops a fracture
      // reading as debris from somewhere else.
      giantSpec.push({ mass, r: asteroidRadius(mass) * mul * vary(),
        shapeId: drawShape(t < 0.34 ? 0 : t < 0.7 ? 1 : 2), rot: rng() * TAU });
    }
    // HEAVIEST FIRST, and each rock's own pull toward the heart set from where
    // it sits in the size range. Sorting is what makes the bias mean anything:
    // draw order IS packing order, so whatever goes first takes the middle.
    // The two classes are ranked TOGETHER — monoliths are 2-250x a giant's mass,
    // so ranking within each class separately would have the smallest monolith
    // and the biggest giant asking for the same spot with the same claim.
    //
    // Ranked on DRAWN RADIUS, not on mass — and the two are no longer the same
    // ordering now that the giant multiplier is graded (a rim giant is denser
    // than a core one, so mass order and size order genuinely differ across the
    // class boundary). Packing order is about who needs the room, and the room a
    // rock needs is its radius.
    //
    // The normalisation is LOG for the reason the mass ramp is: on a linear
    // scale the class spans 36-325 units against a 413-unit ceiling, so most of
    // it scores near one end and draws nearly the same centre bias. That was the
    // old bug in its purest form — the gradient existed, indexed by a number
    // that barely moved.
    const spanLo = Math.log(asteroidRadius(CFG.FIELD_GIANT_MASS[0]) * mulLo);
    const spanHi = Math.log(asteroidRadius(CFG.FIELD_MONOLITH_MASS[1])
      * CFG.FIELD_MONOLITH_R_MUL * CFG.FIELD_SIZE_VARY[1]);
    const setPow = (sp) => {
      const s = Math.min(1, Math.max(0, (Math.log(sp.r) - spanLo) / (spanHi - spanLo)));
      sp.pow = CFG.FIELD_EDGE_POW + (CFG.FIELD_CORE_POW - CFG.FIELD_EDGE_POW) * s;
      return sp;
    };
    monoSpec.forEach(setPow); giantSpec.forEach(setPow);
    monoSpec.sort((a, b) => b.r - a.r);
    giantSpec.sort((a, b) => b.r - a.r);

    // THE RADIAL FRONTIER — how far out each rock is allowed to go, in
    // config.fieldFrac units. This is the knob that actually makes a pocket
    // grade (see the note on packBigRock for the measurement that says so).
    //
    // SOLVED FROM AREA, NOT PICKED. Walking the size order and accumulating
    // rock area, a rock's frontier is the radius at which everything bigger
    // than it would fill the pocket to FIELD_PACK_FRONT coverage:
    //     cumArea = front * pocketArea * qMax^2   =>   qMax = sqrt(...)
    // so the masonry grows outward from the heart as a saturated disc and each
    // rock may reach exactly as far as the rock ahead of it did. A hand-picked
    // ladder cannot survive a change to the counts, the mass band or the
    // multipliers — this one re-solves itself, which matters because all three
    // of those move together whenever the pocket is retuned.
    // The heart's own footprint plus its clearance ring seeds the accumulator:
    // that area is genuinely spoken for, and starting from zero would hand the
    // first few monoliths a frontier inside a disc they cannot occupy.
    // A ROCK'S OWN SIZE IS THE PRIMARY LIMIT; the area frontier is the RELIEF
    // VALVE under it (`qMax` = whichever is more generous).
    //
    // The area solve alone cannot express what a shoal is supposed to be, and
    // the reason is worth keeping: it derives reach from CUMULATIVE area, so
    // every rock's frontier is one shared envelope. Tighten it enough to keep
    // giants in the middle and it confines the SMALL rock to the middle too —
    // the last rock placed always sits at the envelope's edge, wherever that is.
    // With the pocket's landmarks at ~66% coverage that envelope lands at
    // q ~0.96, i.e. everywhere, which is "the whole thing is filled with them".
    //
    // So the allowance is read off the rock's own size (CFG.FIELD_REACH,
    // [rim, core], log-interpolated across the class span): the smallest
    // landmarks may go anywhere, the biggest are held inside the core. That is a
    // direct statement of the design law and it does not care how much rock
    // there is in total.
    // The area frontier still runs underneath as `max(...)`: if the big rocks
    // genuinely do not fit inside their allowance, it grows and they spill
    // outward rather than being silently dropped — which is what it was always
    // for, and what a hard size band on its own would lose.
    const pocketA = Math.PI * CFG.FIELD_LEN * CFG.FIELD_SPREAD;
    let cumA = Math.PI * Math.pow(slots[0].r + CFG.FIELD_HEART_CLEAR, 2);
    const reachLo = Math.log(asteroidRadius(CFG.FIELD_GIANT_MASS[0]) * mulLo
      * CFG.FIELD_SIZE_VARY[0]);
    const reachHi = Math.log(asteroidRadius(CFG.FIELD_MONOLITH_MASS[1])
      * CFG.FIELD_MONOLITH_R_MUL * CFG.FIELD_SIZE_VARY[1]);
    // ALLOWED REACH FALLS AS A POWER OF THE ROCK'S RADIUS, and the shape of that
    // curve is the whole design. A LINEAR ramp between the two ends was tried
    // and is far too generous in the middle of the ladder: interpolated across
    // the class, a 332-unit rock — 80% of the biggest thing in the pocket — came
    // out allowed to q 0.63, so genuinely huge rock reached the outer third and
    // the pocket still read as "big asteroids the whole way".
    // As a power law the allowance collapses where it needs to: at FALL 0.6 the
    // smallest landmark goes anywhere, ~50 units reaches 0.85, ~80 reaches 0.64,
    // ~150 reaches 0.45 and anything 250+ is inside 0.33. Read it as an AREA
    // budget per size class — allowance^2 falls as r^-1.2, so a rock twice as
    // wide gets well under half the pocket to live in.
    const rMin = Math.exp(reachLo);
    const setQMax = (sp) => {
      cumA += Math.PI * sp.r * sp.r;
      // EXPONENTIAL DECAY, NOT A POWER LAW. A power of the size ratio spends most
      // of its travel in the middle of the size range, so the allowance came down
      // steadily across every class and the pocket read as a size that slides
      // inward — mid rock pushed out of the core along with the small rock. An
      // exponential holds the allowance near its ceiling across the small and
      // mid end and then falls away hard, which is the shape the design actually
      // wants: most of the pocket admits ANY rock, and only the genuinely large
      // are squeezed toward the middle. Read with the size law in
      // docs/rock-fracture.md — the range WIDENS toward the core, it does not
      // slide, so the bottom of it has to keep the run of the whole pocket.
      const allow = CFG.FIELD_REACH[1] + (CFG.FIELD_REACH[0] - CFG.FIELD_REACH[1])
        * Math.exp(-CFG.FIELD_REACH_EXP * (sp.r / rMin - 1));
      sp.qMax = Math.min(FIELD_LOBE_MAX, Math.max(allow,
        Math.sqrt(cumA / (CFG.FIELD_PACK_FRONT * pocketA))));
    };
    // Accumulated across BOTH calls in placement order — monoliths are every
    // one of them bigger than every giant, so mono-then-giant is one descending
    // size order and the frontier only ever grows.
    for (const sp of monoSpec) setQMax(sp);
    for (const sp of giantSpec) setQMax(sp);

    const keepOut = pocketKeepOut(game, f);
    packBigRock(f, sun, rng, monoSpec, slots, keepOut);
    packBigRock(f, sun, rng, giantSpec, slots, keepOut);

    // ---- 1b. THE LANES, found among the rock that is now on the ground (see
    // findLanes for why this order and not the other one). Only then are the few
    // rocks still standing in a chosen route dropped — a handful, against the
    // half of the pocket's largest rocks that carving-first cost.
    // The HEART is never dropped: it is the field's name, its chart entry and
    // the AI's anchor, and findLanes' cost function already weights it heavily
    // enough that a route rarely wants its ground.
    f.lanes = findLanes(f, rng, slots);
    const clear = [];
    for (const sl of slots) {
      // DROP ONLY WHAT BLOCKS, and measure blocking by the PASSAGE LEFT rather
      // than by contact. Anything else is a swathe: excluding every landmark
      // that so much as touches a route clears ~450 units either side of it for
      // a 300-unit rock, and three routes then take most of the pocket's biggest
      // rocks with them — measured, 27 landmarks over 250 units down to 8, and
      // the survivors left further from their neighbours than before the lanes
      // existed at all. A slab at a lane's edge is not a problem, it is the
      // WALL; a slab plugging the middle is.
      const dep = laneDepth(f, sl.tan || 0, sl.rad || 0);
      const left = 2 * _laneW - (dep + sl.r);   // passable width this rock leaves
      if (!sl.heart && dep > -sl.r && left < CFG.FIELD_LANE_MIN) continue;
      clear.push(sl);
    }
    slots.length = 0;
    for (const sl of clear) slots.push(sl);

    const bigs = [];
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const v = orbitVel(sun, sl.x, sl.y, 1);
      const rock = spawnAsteroid(game.bodies, sl.x, sl.y, v.vx, v.vy, sl.mass);
      rock.giant = true;
      if (sl.heart) {
        // The field HEART: the shoal's named monolith, its AI anchor, and its
        // chart entry.
        rock.name = fd.name; rock.chartKey = 'field' + fi;
        f.heart = rock;
      }
      rock.radius = rock.baseRadius = sl.r;
      // The silhouette the packer measured, not a fresh one off the body id —
      // a rock that changed shape after placement overlaps whatever it was
      // spaced against, which is the bug this whole pre-resolve exists to fix.
      rock.shapeId = sl.shapeId; rock.rot = sl.rot;
      // A BIG ROCK TUMBLES SLOWLY. The Body constructor gives every asteroid the
      // same +/-0.3 rad/s tumble, which is right for a pebble and absurd on a
      // 400-unit slab — at that size the rim is moving faster than the ship and
      // the whole pocket reads as a blender. Scaled off radius so the drawn
      // SURFACE speed stays in a believable band across a ladder that spans more
      // than a decade of size.
      rock.spin *= Math.max(0.12, Math.min(1, 55 / sl.r));
      shapeBig(rock);
      railBody(rock, sun);
      rock.rail.w = w;   // the rigid-pocket rule — see the note on `w` above
      markFieldRock(rock, fi);
      setFieldHome(rock, f);
      bigs.push(rock);
    }

    // ---- 2. THE RUBBLE. Small rock banks against the masonry (rubblePoint)
    // rather than scattering evenly, so the gaps between the huge rocks stay
    // flyable. Anything that lands inside a big rock is redrawn: a body born
    // under a surface is quietly ABSORBED on the first substep, which at this
    // rock size would be a steady, invisible leak out of the pocket.
    // Placed gravel, bucketed, so each new pebble can clear the ones already
    // down. Without this the rubble pass only ever checked the MASONRY and
    // gravel silently piled into itself — measured on a seeded world, 21 of 27
    // overlapping pairs in the whole sky were gravel on gravel. They then sit
    // interpenetrated for the run, because two railed rocks of one pocket skip
    // collision by design (they are rigidly co-moving), so nothing separates
    // them until the player disturbs one and it derails — which is exactly
    // "many rocks initially overlap until I touch them and then they snap
    // apart".
    const GCELL = 120;
    const gcells = new Map();
    const gkey = (x, y) => Math.floor(x / GCELL) + ',' + Math.floor(y / GCELL);
    const gravelClear = (x, y, r) => {
      const cx = Math.floor(x / GCELL), cy = Math.floor(y / GCELL);
      for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const cell = gcells.get(ix + ',' + iy);
        if (!cell) continue;
        for (const o of cell) {
          if (Math.hypot(o.x - x, o.y - y) < o.r + r + 3) return false;
        }
      }
      return true;
    };
    for (let i = bigs.length; i < CFG.FIELD_ROCKS; i++) {
      let x = f.x, y = f.y, sited = false;
      for (let tries = 0; tries < 8; tries++) {
        const p = rubblePoint(f, sun, rng, bigs);
        x = p.x; y = p.y;
        // GRAVEL IS CLEARED FROM THE LANES TOO — the old corridor attempt
        // failed partly because it was not, and "the thing actually blocking
        // you was gravel". A share leaks through (CFG.FIELD_LANE_LEAK) so a
        // route reads as rock thinning out rather than a channel with a kerb.
        // THE LEAK LIVES AT THE EDGE, NOT IN THE MIDDLE. A uniform leak puts as
        // much rock down the centre of a route as along its walls, which is what
        // makes a lane read as "slightly thinner" rather than as a lane. Scaling
        // it by how deep into the channel the rock landed keeps the CENTRE open
        // and leaves the ragged fringe exactly where it does its job — on the
        // boundary, where a crisp kerb would read as authored.
        // BANKED ONTO THE SHOULDER, not merely rejected. A road is only visible
        // if the rock either side of it is denser than the ambient scatter —
        // measured, the channels were genuinely clear (cover 0.013 inside
        // against 0.200 outside) and still invisible, because at 9% of the
        // pocket's area a thin clear line reads exactly like the gaps that are
        // everywhere anyway. Pushing a rejected pebble OUT to the shoulder
        // instead of redrawing it elsewhere builds a berm along every road: same
        // rock count, same overall density, but the road now has walls.
        // The leak still applies, and still only at the EDGE (a crisp kerb reads
        // as authored), so the berm is ragged rather than a wall of masonry.
        const ld = laneDepthAt(f, x, y);
        if (ld > 0) {
          const core = Math.min(1, ld / (_laneW * 0.6));
          if (rng() > CFG.FIELD_LANE_LEAK * (1 - core)) {
            const dx = x - f.x, dy = y - f.y;
            const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
            const tn = -dx * sa + dy * ca, rd = dx * ca + dy * sa;
            let ox = tn - _laneCx, oy = rd - _laneCy;
            const om = Math.hypot(ox, oy);
            // Dead on the centreline there is no outward direction to take, so
            // pick one; anywhere else, push along the way it already leans.
            if (om < 1e-3) { const a2 = rng() * TAU; ox = Math.cos(a2); oy = Math.sin(a2); }
            else { ox /= om; oy /= om; }
            const push = _laneW + rand(rng, 4, 90);
            const ntan = _laneCx + ox * push, nrad = _laneCy + oy * push;
            const w2 = pocketToWorld(f, sun, ntan, nrad);
            x = w2.x; y = w2.y;
          }
        }
        let clash = false;
        // Cheap radius guess for the clearance test — the true one needs the
        // mass draw below, and the ladder's spread is narrow enough at this
        // scale that a mid estimate keeps pebbles apart without wasting draws.
        // NO LAST-TRY ESCAPE HERE, unlike the density taper below. The taper is
        // a preference — accepting a rim draw on the final try only costs a
        // slightly flatter gradient. This is the clearance test, and swallowing
        // it seeds a pebble INSIDE another pebble: both are railed field rock,
        // so collideBodies' railed-pair pass-through freezes them exactly where
        // worldgen put them, and stuckPair can only fire once they are inside
        // each other's surfReach. Measured before this: 1-5 interpenetrating
        // gravel pairs per world, worst 21.9 units of overlap on ~13-unit rocks
        // — fully buried, and visible from the first frame. `gcells` was added
        // for precisely this (21 of 27 overlapping pairs in the whole sky were
        // gravel on gravel); the escape hatch was undoing it on one try in
        // eight. Falling out to `if (!sited) continue;` drops the pebble, which
        // is what the landmark `clash` path already does.
        if (!gravelClear(x, y, 13)) continue;
        for (const g of bigs) {
          // Against the SHAPE, for the same reason the masonry is packed against
          // it: a landmark's corners reach past its nominal radius, so a circle
          // test here drops gravel inside those corners, where it is absorbed on
          // the first substep — a steady, invisible leak out of the pocket.
          // Bounded, not sampled: rockSurfAt on the centre line alone misses a
          // corner that reaches past it, and a pebble dropped inside one is
          // absorbed on the first substep — a steady, invisible leak. The window
          // is the arc this pebble subtends, which at gravel size is small, so
          // the bound stays tight rather than pushing a halo off every landmark.
          const dg = Math.hypot(g.x - x, g.y - y) || 1;
          const hw = Math.min(1.0, Math.asin(Math.min(1, 16 / dg)));
          const ext = g.radius * reachAt(g.shapeId, Math.atan2(y - g.y, x - g.x) - g.rot, hw);
          if (dg < ext + 26) { clash = true; break; }
        }
        // THE DENSITY TAPER, applied where the rock actually LANDED. Biasing
        // the samplers is not enough on its own: four rocks in five are skirt
        // gravel banked against a host, so they inherit the masonry's spread
        // and no amount of pull on the loose draw moves them. A rejection on
        // the final position is the one place that catches every path into the
        // pocket. Count is unchanged — a rejected draw is retried, so the same
        // FIELD_ROCKS end up further in rather than fewer.
        if (!clash && rng() > fieldKeep(f, x, y) && tries < 7) continue;
        if (!clash) { sited = true; break; }
      }
      // NEVER PLACE A PEBBLE THAT NEVER FOUND ROOM. The loop used to fall out of
      // its try budget and spawn at whatever the LAST candidate was, clash and
      // all — which is a body born inside a landmark. It is absorbed on the first
      // substep if it is deep, and sits visibly interpenetrated if it is not,
      // and being railed field rock nothing ever separates it. Dropping the rock
      // costs one pebble out of hundreds; keeping it costs a bug.
      //
      // THIS MOVED THE SEEDED STREAM, DELIBERATELY, AND THE SHIFT IS DECLARED
      // HERE (issue #149). Until the gravel-clearance escape hatch was closed,
      // a pebble that failed `gravelClear` on the LAST of 8 tries fell through
      // and SPAWNED, drawing the 2% cache test plus fieldMass's two draws and
      // maybeCore's mass-gated one. Dropping it instead draws none of those, so
      // every draw after this point in seedDenseFields — and seedDebrisBelts,
      // which runs after it — lands differently: measured on seed 20260721 the
      // Farshoal's heart moves from (-26202,-51284) to (52454,23774), a whole
      // shoal on a different bearing.
      //
      // NOT re-aligned by drawing-and-discarding here, though that is the
      // project's usual rule. This `!sited` exit is reached by TWO paths — the
      // landmark `clash` path, which already dropped silently and drew nothing
      // before the change, and the gravel-clearance path, which is the only one
      // that used to spawn. Draining draws on both would invent a THIRD stream
      // that matches neither, and draining only the second means reconstructing
      // the old bug's exact conditions (run the `bigs` clash loop after a
      // clearance failure purely to decide how many draws to throw away) —
      // encoding a deleted bug's draw pattern into the code forever. The layout
      // for a given seed is therefore different from before this fix, on
      // purpose. `?seed=` is still reproducible; it just reproduces a new sky.
      if (!sited) continue;
      const v = orbitVel(sun, x, y, 1);
      // The mass ladder is drawn against where the rock LANDED, not where it
      // was aimed — the skirt draw offsets it off a host by up to a couple of
      // hundred units, and a rock banked on the outside of an outer giant is at
      // the rim whatever its host's own frac says.
      const rock = rng() < 0.02
        ? spawnCache(game.bodies, x, y, v.vx, v.vy)   // shoals hide salvage
        : maybeCore(spawnAsteroid(game.bodies, x, y, v.vx, v.vy,
          fieldMass(rng, fieldFrac(f, x, y))), rng);
      const gk = gkey(x, y);
      if (!gcells.has(gk)) gcells.set(gk, []);
      gcells.get(gk).push({ x, y, r: rock.radius });
      railBody(rock, sun);
      rock.rail.w = w;
      markFieldRock(rock, fi);
      setFieldHome(rock, f);
    }
  }
}

// A drifting extra-life collectible. Without explicit coords it appears on a
// ring just beyond the current view (main.js trickles these in over time).
export function spawnLifePod(game, x, y) {
  if (x === undefined) {
    const s = game.ship;
    const ang = Math.random() * TAU;
    const d = (game.viewR || 1600) * 1.05;
    x = s.x + Math.cos(ang) * d;
    y = s.y + Math.sin(ang) * d;
  }
  game.pickups.push({
    x, y,
    vx: (Math.random() - 0.5) * 18, vy: (Math.random() - 0.5) * 18,
    phase: Math.random() * TAU,
  });
}

export function respawnShip(game) {
  const s = game.ship;
  // A RESPAWN CLEARS THE BERTH, and this is load-bearing rather than tidiness.
  // The clamps are an exact pin (physics.updateDock): while game.dock is set,
  // every substep snaps the hull to THAT station's pad. Death and respawn both
  // happen between substeps, so updateDock never sees the dead ship and the
  // berth survives — and a pilot who dies berthed at one station with the home
  // port at another gets placed correctly here and then dragged back to the
  // station they died at on the very next step (measured 537 units off). The
  // berth is re-earned in about half a second from the pad you land on, which
  // at home is immediate.
  game.dock = null;
  game.launch = null;   // …and a release sequence never survives its ship
  // A HOME PORT IS THE RESPAWN POINT. Falls back to the run's opening orbit
  // whenever there isn't one — never docked, never chose one, or the world it
  // was on came apart (physics.updateDock clears game.home with its body, so a
  // dead reference can't reach here).
  const h = game.home && game.home.b.alive ? game.home : null;
  if (h) {
    // Placed a hull's height ABOVE the pad rather than on it: materializing
    // flush with the crust puts the ship inside the collider on frame one,
    // which the resolver answers with a shove — a respawn that starts by
    // launching you off your own dock. It comes in RIDING THE SURFACE (the
    // same surfaceVel the friction and the stillness gate use), so a home world
    // that is orbiting at 700 u/s doesn't hand the ship back standing still in
    // front of it.
    const p = padPos(h, undefined, s.radius * CFG.DOCK_LIFT);
    const v = surfaceVel(h.b, p.x, p.y);
    s.x = p.x; s.y = p.y;
    s.vx = v.vx; s.vy = v.vy;
    s.angle = h.ang + h.b.rot;   // rockets down, exactly as it was parked
  } else {
    s.x = game.spawn.x; s.y = game.spawn.y;
    s.vx = game.spawn.vx; s.vy = game.spawn.vy;
  }
  s.hull = game.st.hullMax;
  s.shield = game.st.shieldMax;
  // THE RAM DOES NOT SURVIVE A DEATH. It is not a stat, it is cargo you crushed
  // onto the hull — the wreck took it with it, and a respawned brawler goes and
  // builds a new one. (The shield above refills because it is an ABILITY; the
  // ram is the rock you were carrying.)
  s.ram = 0;
  s.ramHitT = 0;
  s.alive = true;
  s.invuln = 4;
  game.deathCause = '';
}

// A little handover sparkle. world.js can't import physics.addParticles (that
// would close an import cycle with physics's spawnAsteroid import), so the few
// particles are pushed directly in the same shape physics uses.
function puff(game, x, y, color, n = 14) {
  for (let i = 0; i < n; i++) {
    const th = Math.random() * TAU, sp = Math.random() * 140;
    game.particles.push({
      x, y, vx: Math.cos(th) * sp, vy: Math.sin(th) * sp,
      life: 0.7 * (0.4 + Math.random() * 0.6), maxLife: 0.7,
      size: 2.5 * (0.5 + Math.random()), color,
    });
  }
  if (game.particles.length > 900) game.particles.splice(0, game.particles.length - 900);
}

// ---- DELIVERIES: the shared "fling or tow an object into a target's catch
// radius" verb. One helper serves every consumer — a graveyard wreck wakes
// the Herald; (more targets join it: the relay, the Tinker Barge, mayday-pod
// docks). Runs per-frame (not the throttled scan: a flung rock at 800 u/s
// crosses a catch radius in well under half a second). Consumption is a
// HANDOVER, not a kill: alive = false with no shatter, so no debris, no
// scrap, no death-log drama; a beam-held delivery auto-drops from the beam
// (tractor.springHeld drops dead bodies from either Twin Grip slot). The
// target's own rail and velocity are never touched.
function updateDeliveries(game) {
  const targets = [];
  const gh = game.ghost;
  if (gh && gh.alive && !gh.awake) {
    targets.push({ b: gh, r: CFG.DELIVER_R + 40, match: (x) => x.wreck, on: wakeHerald });
  }
  const tk = game.tinker;
  if (tk && tk.alive && game.tinkerWant && !(game.tinkerCd > 0)) {
    targets.push({ b: tk, r: CFG.DELIVER_R, match: game.tinkerWant.match, on: payBarge });
  }
  const rl = game.relay;
  if (rl && rl.alive && !game.relayPowered) {
    targets.push({ b: rl, r: CFG.DELIVER_R, match: (x) => !!x.core, on: powerRelay });
  }
  if (game.mayday && game.mayday.alive) {
    const pod = game.mayday;
    for (const st of game.bodies) {
      if (!st.alive || st.type !== 'station') continue;
      targets.push({ b: st, r: CFG.DELIVER_R + 60, match: (x) => x === pod, on: rescuePod });
    }
  }
  if (!targets.length) return;
  for (const b of game.bodies) {
    if (!b.alive) continue;
    // Never consume the orbit wall (a flyby would auto-deliver the shield) or
    // an alien's carried rock — only free-flying, thrown, or player-held cargo.
    if (b.heldBy && b.heldBy !== 'player') continue;
    // RAILED bodies are scenery, not cargo: legit deliveries are always loose
    // (a grab derails, and thrown rocks can't re-rail in view). Without this,
    // a planet's railed junk satellites silently self-deliver to the barge
    // whenever their lanes conjoin — a reward leak with no player act behind it.
    if (b.onRails) continue;
    for (const t of targets) {
      if (b === t.b || !t.match(b)) continue;
      if (Math.hypot(b.x - t.b.x, b.y - t.b.y) < t.r + b.radius) { t.on(game, b, t.b); break; }
    }
  }
}

// FEATURE: THE HERALD, RESOLVED. Its log mourns a crew the graveyard kept —
// tow any graveyard wreck the 28,000u from the sun's corona to the outer dark
// (the longest quest in the game, on purpose) and the ghost ship wakes: XP,
// the crew's last life pod offered in thanks, and its mournful ping becomes a
// friendly beacon (the fog scan sees farther near it; render lights the hull).
function wakeHerald(game, b, gh) {
  if (gh.awake) return;   // re-entry guard: two matches in one frame pay once
  b.alive = false;
  gh.awake = true;
  gh.wakeEchoT = 7;   // the echo payoff follows the wake announcement, not over it
  puff(game, gh.x, gh.y, '#b8ffd9', 24);
  addXp(game, PROG.XP_HERALD);
  game.heraldWakeWarn = true;
  spawnLifePod(game, gh.x + 120, gh.y);
}

// FEATURE: THE TINKER BARGE trade. Consume the matching want, fling back a
// rotating payment, then rest (tinkerCd) before broadcasting a new want.
// Payments are loose light objects — never railed, never boundary-flagged.
function payBarge(game, b, tk) {
  // RE-ENTRY GUARD, load-bearing: the delivery loop iterates game.bodies by
  // index, so bodies pushed DURING the sweep are visited too — and the ice
  // payment spawns inside the catch radius. Without this check an ice-for-ice
  // trade consumes its own payment (each pellet 1/3 likely to spawn 4 more:
  // branching mean > 1, i.e. a runaway) the same frame the cd was armed.
  if (game.tinkerCd > 0) return;
  b.alive = false;
  puff(game, tk.x, tk.y, '#ffd98a', 18);
  const roll = Math.floor(Math.random() * 3);
  let paid;
  if (roll === 0) {
    // premium ice ammo, lobbed gently out of the catch ring
    for (let i = 0; i < 4; i++) {
      const th = Math.random() * TAU, sp = 60 + Math.random() * 80;
      const pel = spawnAsteroid(game.bodies,
        tk.x + Math.cos(th) * (tk.radius + 14), tk.y + Math.sin(th) * (tk.radius + 14),
        tk.vx + Math.cos(th) * sp, tk.vy + Math.sin(th) * sp, 150 + Math.random() * 150);
      pel.ice = true; pel.color = '#bfe3f2';
    }
    paid = 'premium ice ammo';
  } else if (roll === 1) {
    spawnLifePod(game, tk.x + 90, tk.y - 60);   // full lives convert to XP on collect
    paid = 'a life pod';
  } else {
    addXp(game, PROG.XP_TRADE);
    paid = `+${PROG.XP_TRADE} XP`;
  }
  game.tinkerPaidWarn = paid;
  game.tinkerCd = 30;
  game.tinkerWant = pickTinkerWant(game, game.tinkerWant);
}

// FEATURE: MAYDAY PODS. Any station is a rescue dock — the derelicts, the
// relay, the barge, even the Herald. Dock the pod in time for XP, sometimes a
// life, and the pilot's one-liner (delayed past the announcement). Too late,
// and it just goes quiet — the loss IS the penalty; nothing else is docked.
function rescuePod(game, b, st) {
  if (game.mayday !== b) return;   // re-entry guard, same rule as the others
  b.alive = false;
  game.mayday = null;
  puff(game, st.x, st.y, '#b8ffd9', 18);
  addXp(game, PROG.XP_RESCUE);
  if (Math.random() < 0.25 && game.prog.lives < maxLives(game.prog)) game.prog.lives++;
  game.maydaySavedWarn = true;
  game.rescueEchoT = 5;
}

// FEATURE: THE UNCHARTED STAR. Feed the relay's dish a dense core crystal
// (cracked from a cored belt rock) and it powers up, locks a bearing, and the
// sensor-null dark dwarf becomes real: seen (a violet rim pin on the minimap
// until charted) and finally chartable. Charting it pays XP_SURVEY_STAR,
// fires the payoff echo, and permanently raises the lives cap (+1 — "the
// star keeps you"; see the chart scan + config.maxLives).
function powerRelay(game, b, rl) {
  if (game.relayPowered) return;   // re-entry guard: one crystal is enough
  b.alive = false;
  puff(game, rl.x, rl.y, '#b89aff', 22);
  game.relayPowered = true;
  game.relayBeamT = 12;   // render: the dish's bearing beam, fading out
  game.relayWarn = true;
  const dk = game.darkStar;
  if (dk && dk.alive) { dk.hidden = false; dk.seen = true; }
}

// The world refills itself: asteroids near the player, fresh rogues at the
// rim, and new moons captured by lonely planets.
export function replenishWorld(game, dt) {
  const rng = Math.random;

  // (No rogue trickle — rogue planets were removed entirely; see the note in
  // generateWorld where the seeded ones used to be.)

  // Moons — destroyed ones are eventually replaced around big planets.
  // 60s cadence (was 90): the sun's tide claims derailed moons steadily, and
  // replenishment must keep the sky full.
  game.moonTimer = (game.moonTimer ?? 60) - dt;
  if (game.moonTimer <= 0) {
    game.moonTimer = 60;
    const moons = game.bodies.filter((b) => b.alive && b.type === 'moon').length;
    if (moons < game.moonBaseline) {
      const hosts = game.bodies.filter((b) => b.alive && b.type === 'planet' && b.mass >= 5e4);
      if (hosts.length) {
        const p = hosts[Math.floor(rng() * hosts.length)];
        const orbitR = Math.hypot(p.x - game.homeStar.x, p.y - game.homeStar.y);
        const { minR, maxR } = moonZone(game.homeStar, p, orbitR);
        if (maxR > minR + 50) {
          // Don't drop the newcomer onto (or across) a surviving sibling's
          // orbit — overlapping confocal orbits always cross and a crossing
          // pair eventually collides (see spawnMoon's exCap rationale). Gap
          // is measured to each railed sibling's radial range, and the
          // clearance rides MOON_R_MUL because it is sized to cover BOTH
          // bodies' radii — at 130x it covers two top-of-jitter moons (~612
          // since the widened spread) plus their chunk shells (1.5x radius
          // each), the same arithmetic as spawnMoon's 100x shared-edge margin
          // with the refill's own radius still unrolled. A blocked draw just
          // retries; a fully missed cycle only delays the refill by 60s.
          const clear = 130 * CFG.MOON_R_MUL;
          for (let tries = 0; tries < 4; tries++) {
            const mr = minR + (maxR - minR) * rng();
            let gap = Infinity;
            for (const m of game.bodies) {
              if (!m.alive || m.type !== 'moon' || m.parent !== p || !m.onRails) continue;
              const ell = m.rail.e !== undefined;
              const a = ell ? m.rail.a : m.rail.r;
              const ex = ell ? m.rail.e * a : 0;
              gap = Math.min(gap, Math.abs(mr - a) - ex);
            }
            if (gap > clear) { spawnMoon(game.bodies, rng, p, mr, gap - clear); break; }
          }
        }
      }
    }
  }

  // ---- AMBIENT EVENT PACING: sparse and genuinely random. Wide windows
  // (min + a span several times the min) keep events from ever feeling like
  // a metronome — quiet stretches are the point; an event should interrupt
  // calm, not compete with the last one. ----

  // ---- solar flares: the sun RARELY erupts plasma at ships that fly close ----
  const s = game.ship;
  game.flareTimer = (game.flareTimer ?? 60) - dt;
  if (game.flareTimer <= 0 && s.alive) {
    game.flareTimer = 75 + rng() * 90;
    const sun = game.homeStar;
    const d = Math.hypot(s.x - sun.x, s.y - sun.y);
    if (d < CFG.FLARE_RANGE) {
      // Lead the ship a little, then loose a tight fan of plasma
      const t = d / CFG.FLARE_SPEED;
      const ang = Math.atan2(s.y + s.vy * t - sun.y, s.x + s.vx * t - sun.x);
      for (let i = 0; i < 5; i++) {
        const a = ang + (i - 2) * 0.055 + (rng() - 0.5) * 0.03;
        const sp = CFG.FLARE_SPEED * (0.9 + rng() * 0.25);
        game.flares.push({
          x: sun.x + Math.cos(a) * (sun.radius + 80),
          y: sun.y + Math.sin(a) * (sun.radius + 80),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: CFG.FLARE_LIFE, radius: 26 + rng() * 18,
        });
      }
      game.flareWarn = true;
    }
  }

  // ---- comet showers: streams of fast ice sweeping past the player ----
  game.cometTimer = (game.cometTimer ?? 180) - dt;
  if (game.cometTimer <= 0 && s.alive) {
    game.cometTimer = 240 + rng() * 300;
    const th = rng() * TAU;
    const ex = Math.cos(th) * CFG.WORLD_R * 0.95, ey = Math.sin(th) * CFG.WORLD_R * 0.95;
    const aimAng = Math.atan2(s.y - ey, s.x - ex) + (rng() - 0.5) * 0.12;
    const n = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const lag = i * (420 + rng() * 240);
      const perp = (rng() - 0.5) * 1000;
      const px = ex - Math.cos(aimAng) * lag - Math.sin(aimAng) * perp;
      const py = ey - Math.sin(aimAng) * lag + Math.cos(aimAng) * perp;
      const sp = 520 + rng() * 180;
      const c = spawnAsteroid(game.bodies, px, py,
        Math.cos(aimAng) * sp, Math.sin(aimAng) * sp, 350 + rng() * 400);
      c.comet = true; c.cometT = 90; c.color = '#bfeffc';
    }
    game.cometWarn = true;
  }

  // ---- interstellar visitor: a hyperbolic one-shot. It enters once per
  // run, crosses the system in ~3 minutes, and leaves FOREVER unless caught.
  // noBoundary exempts it from the world-edge force (physics.js) — that
  // force would bend the hyperbola into a captured orbit and break the
  // whole "it will not return" promise.
  if (!game.visitorDone && game.time > 240) {
    game.visitorDone = true;
    const th = rng() * TAU;
    const R0 = CFG.WORLD_R * 1.22;
    const ex = Math.cos(th) * R0, ey = Math.sin(th) * R0;
    // Aim past the sun with a ~3-5k impact parameter: it sweeps the
    // mid-system instead of either beelining into the star or skirting the rim
    const off = (rng() < 0.5 ? -1 : 1) * (3200 + rng() * 1800);
    const px = -Math.sin(th) * off, py = Math.cos(th) * off;
    const ang = Math.atan2(py - ey, px - ex);
    const sp = 540 + rng() * 80;   // far above escape speed everywhere
    const v = spawnAsteroid(game.bodies, ex, ey, Math.cos(ang) * sp, Math.sin(ang) * sp, 1800);
    v.visitor = true; v.noBoundary = true; v.junk = true;
    v.color = '#c08a5f'; v.name = 'Interstellar Object';
    v.echo = ECHOES.visitor;
    game.visitor = v;
    game.visitorWarn = true;
  }
  if (game.visitor) {
    const v = game.visitor;
    if (!v.alive) {
      game.visitor = null;                 // somebody smashed it — no farewell
    } else if (v.catchCount > 0 || v.heldBy) {
      v.noBoundary = false;                // caught! it lives here now
      game.visitor = null;
    } else if ((v.x * v.vx + v.y * v.vy) > 0 &&
               v.x * v.x + v.y * v.y > (CFG.WORLD_R * 1.26) ** 2) {
      v.alive = false;                     // receding past the rim: gone for good
      game.visitor = null;
      game.visitorGone = true;
    }
  }

  // ---- MAYDAY PODS: an escape pod adrift on a bad trajectory — falling
  // sunward, or drifting straight into nest territory — with a failing air
  // supply. Tow it to ANY station in time. Sparse and genuinely random like
  // every ambient event; never before 3 minutes in; one at a time. A loss
  // costs nothing but the silence.
  game.maydayTimer = (game.maydayTimer ?? 260) - dt;
  if (game.maydayTimer <= 0) {
    game.maydayTimer = 320 + rng() * 300;
    if (game.time > 180 && !game.mayday && s.alive) {
      const th = rng() * TAU;
      const d0 = (game.viewR || 1200) * 1.2 + 400;   // arrive just off-view
      const px = s.x + Math.cos(th) * d0, py = s.y + Math.sin(th) * d0;
      // The bad trajectory: 50/50 sunward drift, or toward the nearest nest
      // (the drama it fell out of). Aliens CAN grab it — that's the story.
      let ang = Math.atan2(game.homeStar.y - py, game.homeStar.x - px);
      if (rng() < 0.5) {
        let nest = null, nd = Infinity;
        for (const b of game.bodies) {
          if (!b.alive || b.type !== 'nest') continue;
          const dd = Math.hypot(b.x - px, b.y - py);
          if (dd < nd) { nd = dd; nest = b; }
        }
        if (nest) ang = Math.atan2(nest.y - py, nest.x - px);
      }
      const sp = 140 + rng() * 60;
      const pod = spawnAsteroid(game.bodies, px, py, Math.cos(ang) * sp, Math.sin(ang) * sp, 140);
      pod.pod = true; pod.color = '#9fd8b0'; pod.name = 'Escape Pod';
      pod.radius = pod.baseRadius = 9;
      // Override hp (massToHp(140) ≈ 4): a stray pebble must not end the
      // rescue before it starts; a real hit still can.
      pod.hp = pod.maxHp = 60;
      pod.podT = 90 + rng() * 30;   // the air supply, in seconds
      game.mayday = pod;
      // Bearing shout, computed at spawn (y-down screen space: +y = south)
      const oct = ['east', 'south-east', 'south', 'south-west',
        'west', 'north-west', 'north', 'north-east'][Math.round((((th % TAU) + TAU) % TAU) / (TAU / 8)) % 8];
      game.maydayWarn = oct;
    }
  }
  // Pod life cycle: air ticks down, an urgent fast ping, loss handling.
  // (Rescue is a delivery — rescuePod nulls game.mayday before this runs.)
  if (game.mayday) {
    const pod = game.mayday;
    if (!pod.alive) {
      game.maydayLostWarn = true;   // smashed by the drama it drifted through
      game.mayday = null;
    } else {
      pod.podT -= dt;
      if (pod.podT <= 0) {
        pod.alive = false;   // gone quiet — a dim fade, no wreck drama
        puff(game, pod.x, pod.y, '#5a7a68', 8);
        game.maydayLostWarn = true;
        game.mayday = null;
      } else if (s.alive) {
        const pd = Math.hypot(pod.x - s.x, pod.y - s.y);
        game.maydayPingT = (game.maydayPingT ?? 0.5) - dt;
        if (pd < 4000 && game.maydayPingT <= 0) {
          game.maydayPingT = 2.5;   // urgent — faster than the Herald or barge
          game.maydayPing = { x: pod.x, y: pod.y, t: 1.2, t0: 1.2, friendly: true };
          sfxPing(0.8 * (1 - pd / 4200));
        }
      }
    }
  }
  if (game.maydayPing) {
    game.maydayPing.t -= dt;
    if (game.maydayPing.t <= 0) game.maydayPing = null;
  }

  // Comet Vesper is a permanent landmark: comets keep coming. If cosmic
  // chaos (or the player) ever claims it, a fresh incarnation falls sunward
  // from a new angle a few minutes later — THE comet is always out there.
  if (game.vesper && !game.vesper.alive) {
    game.vesperRespawnT = (game.vesperRespawnT ?? 240) - dt;
    if (game.vesperRespawnT <= 0) {
      game.vesperRespawnT = null;
      // Never pop into existence in view — flip to the far side if needed.
      // Test the point spawnVesper will ACTUALLY use (VESPER_PERI), not the
      // authored radius: a check aimed at a different orbit is no check.
      let th = rng() * TAU;
      const px = Math.cos(th) * VESPER_PERI, py = Math.sin(th) * VESPER_PERI;
      if (Math.hypot(px - s.x, py - s.y) < (game.viewR || 1200) * 1.5) th += Math.PI;
      spawnVesper(game, game.homeStar, th);
    }
  }

  // The Tinker Barge, like the shepherd below, is only replaced after an
  // AMBIENT death (a new trader eventually works the lane, arriving off-view).
  // A player kill is permanent — the system remembers who shot the trader.
  if (game.tinker && !game.tinker.alive && !game.tinkerPlayerKilled) {
    game.tinkerRespawnT = (game.tinkerRespawnT ?? 300) - dt;
    if (game.tinkerRespawnT <= 0) {
      game.tinkerRespawnT = null;
      let th = Math.random() * TAU;
      // Same rule as Vesper above: the off-view test has to be taken on the
      // lane spawnTinker actually uses.
      const px = Math.cos(th) * TINKER_R, py = Math.sin(th) * TINKER_R;
      if (Math.hypot(px - s.x, py - s.y) < (game.viewR || 1200) * 1.5) th += Math.PI;
      spawnTinker(game, game.homeStar, th);
    }
  }

  // A shepherd lost to AMBIENT chaos is eventually replaced (a stray
  // moonlet migrates into the lane and the ring reknits). A deliberate
  // player kill is permanent — that scattered ring is the player's mark.
  if (game.shepherdPlanet && game.shepherdPlanet.alive &&
      game.shepherd && !game.shepherd.alive && !game.shepherdPlayerKilled) {
    game.shepherdRespawnT = (game.shepherdRespawnT ?? 300) - dt;
    if (game.shepherdRespawnT <= 0) {
      game.shepherdRespawnT = null;
      // Arrive on the far side of the planet from the player, never in view
      const p2 = game.shepherdPlanet;
      let th = Math.atan2(p2.y - s.y, p2.x - s.x) + rand(Math.random, -0.9, 0.9);
      spawnShepherd(game, p2, th);
    }
  }

  // Dense fields slowly REKNIT: ambient traffic (rogue drive-bys derail
  // everything in RAIL_DISTURB; moon conjunctions plow the inner shoal) frays
  // a pocket over minutes, and player smashing thins it for good otherwise.
  // Top back up toward the seeded density — off-view only, and counted
  // against the POCKET (not strays flung across the system that still carry
  // b.field), so a scattered shoal genuinely regrows instead of reading full.
  // A rogue plow can scatter dozens at once (the outer shoals sit inside the
  // spawn ring's disturb annulus) and a slow trickle leaves a pocket visibly
  // thin for minutes, so the batch is generous — but it is DERIVED from
  // FIELD_ROCKS rather than a constant. It used to be a hardcoded 55 under a
  // comment claiming it scaled; at today's FIELD_ROCKS 740 that same 55 would
  // refill a pocket several times faster than intended.
  game.fieldTimer = (game.fieldTimer ?? 30) - dt;
  if (game.fieldTimer <= 0 && game.fields) {
    game.fieldTimer = 30;
    for (let fi = 0; fi < game.fields.length; fi++) {
      const f = game.fields[fi];
      let n = 0;
      for (const b of game.bodies) {
        if (b.alive && b.field === fi &&
            Math.hypot(b.x - f.x, b.y - f.y) < CFG.FIELD_LEN * 2.5) n++;
      }
      if (n >= CFG.FIELD_ROCKS * 0.8 || game.bodies.length > 10600) continue;
      // Reknit banks the new rock against the pocket's own masonry, exactly as
      // the seed pass does. Refilling from a flat scatter would slowly silt the
      // passages up — over a long run the maze quietly becomes the uniform
      // cloud it replaced, and nothing reports it because the census only ever
      // counted rocks.
      const bigs = [];
      for (const b of game.bodies) if (b.alive && b.field === fi && b.bigShape) bigs.push(b);
      const batch = Math.max(5, Math.round(CFG.FIELD_ROCKS * 0.029));   // ~3% a tick
      // THE REKNIT MUST CLEAR ITS GROUND, exactly as the seed pass does.
      //
      // It used to spawn wherever rubblePoint pointed, with no check of any kind
      // — not against the masonry, not against other gravel, not against the
      // roads. Every 30 seconds it dropped rock straight into whatever was
      // standing there, and because two railed rocks of one pocket skip
      // collision by design, the pair then sat interpenetrated until the player
      // disturbed one and it derailed and snapped clear. Seeding could be made
      // perfect and a session would still fill up with overlaps at ~3% of the
      // pocket per tick, which is exactly what it looked like.
      // The neighbour scan is over this field's own rocks only and the batch is
      // ~23, so it is a few thousand distance tests per 30 seconds.
      const mine = [];
      for (const b of game.bodies) if (b.alive && b.field === fi) mine.push(b);
      const roomAt = (x, y, r) => {
        for (const o of mine) {
          const dx = o.x - x, dy = o.y - y;
          if (Math.abs(dx) > 420 || Math.abs(dy) > 420) continue;
          const ext = o.bigShape
            ? rockReach(o)
            : o.radius;
          if (Math.hypot(dx, dy) < ext + r + 8) return false;
        }
        return true;
      };
      for (let i = 0; i < batch; i++) {
        let x = 0, y = 0, sited = false;
        for (let t = 0; t < 6 && !sited; t++) {
          const p = rubblePoint(f, game.homeStar, rng, bigs);
          x = p.x; y = p.y;
          // ...and it does not silt up the roads either, or a session slowly
          // erases the one part of the layout that has to survive being fought
          // in (the same argument as the rocks' drift home).
          if (laneDepthAt(f, x, y) > 0 && rng() > CFG.FIELD_LANE_LEAK) continue;
          if (roomAt(x, y, 14)) sited = true;
        }
        if (!sited) continue;
        // Never in view — a rock fading into existence mid-screen reads wrong
        if (Math.hypot(x - s.x, y - s.y) < (game.viewR || 1200) * 1.3) continue;
        const v = orbitVel(game.homeStar, x, y, 1);
        // Same taper the seed pass uses. Reknitting from a flat ladder would
        // slowly erase the size gradient over a long run — the same failure the
        // skirt draw above exists to prevent, one knob along.
        const rock = maybeCore(spawnAsteroid(game.bodies, x, y, v.vx, v.vy,
          fieldMass(rng, fieldFrac(f, x, y))), rng);
        railBody(rock, game.homeStar);
        rock.rail.w = f.w;   // join the rigid pocket, not the jittered flow
        markFieldRock(rock, fi);
        setFieldHome(rock, f);
        mine.push(rock);   // later rocks in this batch must clear it too
      }
    }
  }

  // ---- THE SOLAR WAVE: system-wide weather with teeth (CFG.STORM_*). Only
  // the wave's own geometry lives here — the sun's CHARGE, then a shock front
  // trailing a plasma sheath. render.js draws it, physics.js burns the ship
  // and shoves scrap, and main.js owns exposure/shelter and the payout.
  //
  // The CHARGE is the telegraph, and it is the reason the wave is fair: the
  // sun visibly loads for the class's own `charge` seconds before anything is
  // in flight, which is the window to put a world between you and it.
  //
  // THE CLASS IS ROLLED AT CHARGE TIME, not at launch: the telegraph has to
  // announce WHICH of the three is coming (a squall and a CME are worth very
  // different decisions), and the sun's swell, its colour and the screen pulse
  // all key off it while it loads. So the resolved row is parked on
  // game.stormCls the moment the charge starts, the wave inherits it, and
  // NOTHING downstream reads a class-shaped constant off CFG — everything a
  // live wave does comes off the wave. `Math.random`, never the seeded stream:
  // weather is runtime, and buying a constant with a seeded draw would move
  // every spawn after it (see the retrograde-lane note in addPlanet).
  //
  // THE CADENCE IS UNTOUCHED BY THE LADDER. This timer and CFG.STORM_EVERY are
  // exactly what they were when every wave was a CME — three classes means the
  // sun throws something DIFFERENT each time, never something more often.
  game.stormTimer = (game.stormTimer ?? 240) - dt;
  if (game.stormTimer <= 0 && !game.storm && !(game.stormChargeT > 0)) {
    game.stormTimer = CFG.STORM_EVERY * (0.6 + rng() * 1.0);
    const cls = stormClass(rng);   // flat pick of the three — see config
    game.stormCls = cls;
    game.stormChargeT = cls.charge;
    game.stormChargeMax = cls.charge;   // the telegraph ramps 0->1 against this
    game.stormChargeWarn = cls;   // the ROW itself — see EVENT_MSGS in main.js
  }
  if (game.stormChargeT > 0) {
    game.stormChargeT -= dt;
    if (game.stormChargeT <= 0) {
      game.stormChargeT = 0;
      // The wave carries its whole class: `seed` varies the front's lobing and
      // filaments so no two look alike (render-only — the mechanic is a clean
      // radius either way), and the spread row is what physics/render/main read.
      const cls = game.stormCls || CFG.STORM_CLASSES[CFG.STORM_CLASSES.length - 1];
      game.storm = {
        r: game.homeStar.radius, prevR: game.homeStar.radius, seed: rng() * 1000, k: 1, ...cls,
      };
      game.stormWarn = cls;
    }
  }
  if (game.storm) {
    const wave = game.storm;
    wave.prevR = wave.r;
    wave.r += wave.speed * dt;
    // HOW MUCH OF ITSELF IT HAS LEFT (config.stormStrength): 1 while it is still
    // climbing, tapering to 0 as it spends itself at its class's reach. Resolved
    // ONCE here, on the wave, and only READ by physics and render — the same
    // owner-split as game.stormExposed. It is a property of the WAVE, not of
    // where the ship is: the whole sheath weakens together as the front tires.
    wave.k = stormStrength(wave);
    for (const p of game.bodies) {
      if (!p.alive || p.type !== 'planet') continue;
      const pr = Math.hypot(p.x, p.y);
      if (pr > wave.prevR - wave.band && pr < wave.r + wave.band) {
        // Only announce an aurora the player can actually see light up — and
        // only while the wave still has the punch to light one. Past the taper
        // the front is shredding, and an aurora over a world a dying squall
        // merely drifted across is a promise the sky does not keep.
        if (wave.k > 0.35 && !(p.auroraT > 0)
            && Math.hypot(p.x - s.x, p.y - s.y) < 5200) game.auroraName = placeName(p);
        if (wave.k > 0.35) p.auroraT = 7;
      }
    }
    // Gone when the SHOCK has spent itself (config.stormSpent) — the front, not
    // the tail, because the sheath trails behind it and a front stopped at the
    // limit is a wave wholly inside it. stormStrength is already 0 by then, so
    // nothing visible is cut; for a CME the class's reach puts that point out
    // past WORLD_R + band + tail, exactly where the wave always expired.
    if (stormSpent(wave)) { game.storm = null; game.stormCls = null; }
  }

  // Emberkin creep: infestations deepen over time, and at full bloom seed
  // the next planet outward — untreated, they take the whole system
  for (const p of game.bodies) {
    if (!p.alive || p.type !== 'planet' || !p.ember) continue;
    p.ember = Math.min(1, p.ember + 0.0011 * dt);
    if (p.ember >= 1 && !p.emberSeeded) {
      p.emberSeeded = true;
      let next = null, bd = Infinity;
      const pr = Math.hypot(p.x, p.y);
      for (const q of game.bodies) {
        if (!q.alive || q.type !== 'planet' || q.ember) continue;
        const qr = Math.hypot(q.x, q.y);
        if (qr > pr && qr - pr < bd) { bd = qr - pr; next = q; }
      }
      if (next) { next.ember = 0.08; game.emberSeededName = placeName(next); }
    }
  }

  // ---- planet-type hazards & gifts (only fire while the player is close) ----
  for (const p of game.bodies) {
    if (!p.alive) continue;
    // Aurora / eclipse / sulfur timers fade even while the player is far away
    // or dead (the d>4200 skip below would stall a distant cooldown forever)
    if (p.auroraT > 0) p.auroraT -= dt;
    if (p.eclipseT > 0) p.eclipseT -= dt;
    if (p.sulfurCd > 0) p.sulfurCd -= dt;
    if (p.shardCd > 0) p.shardCd -= dt;   // crystal-world facet chip (physics.damageBody)
    if (p.huskCd > 0) p.huskCd -= dt;     // husk-moon wright call (physics.damageBody)
    const iceMoon = p.type === 'moon' && p.moonType === 'ice';
    const cometMoon = p.type === 'moon' && p.moonType === 'comet';
    const sulfurVenting = p.type === 'moon' && p.moonType === 'sulfur' && p.sulfurPops > 0;
    if (!s.alive || (p.type !== 'planet' && !p.volcanic && !iceMoon && !cometMoon && !sulfurVenting)) continue;
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d > 4200) { continue; }
    if (p.volcanic) {
      // FORGE MOON: undirected eruptions, not artillery — a plume of magma
      // pops out at a random angle and cools into dense sling rock
      if (p.heldBy) continue;
      p.hazT = (p.hazT ?? 9) - dt;
      if (p.hazT <= 0) {
        p.hazT = 20 + rng() * 18;
        const ang = rng() * TAU;
        const sp = 180 + rng() * 120;
        const m = spawnAsteroid(game.bodies,
          p.x + Math.cos(ang) * (p.radius + 14), p.y + Math.sin(ang) * (p.radius + 14),
          p.vx + Math.cos(ang) * sp, p.vy + Math.sin(ang) * sp,
          350 + rng() * 550);
        m.magma = 8; m.magmaBorn = true; m.color = '#ff8040';
        game.volcWarn = true;
      }
    } else if (p.ptype === 'lava' || p.ember > 0.01) {
      // Magma bombardment. Wild lava worlds lob loosely; EMBERKIN-colonized
      // worlds fire AIMED artillery, faster the deeper the infestation.
      const infested = p.ember > 0.01;
      p.hazT = (p.hazT ?? 4) - dt;
      if (p.hazT <= 0) {
        // Wild lava worlds erupt sparsely; Emberkin artillery keeps its
        // combat cadence (it's a threat you clear, not ambient weather)
        p.hazT = infested ? 8.5 - 5 * p.ember + rng() * 3 : 14 + rng() * 14;
        const sp = infested ? 400 + rng() * 90 : 300 + rng() * 150;
        const lead = infested ? d / sp : 0;
        const tx = s.x + s.vx * lead, ty = s.y + s.vy * lead;
        const ang = Math.atan2(ty - p.y, tx - p.x) + (rng() - 0.5) * (infested ? 0.12 : 0.6);
        const m = spawnAsteroid(game.bodies,
          p.x + Math.cos(ang) * (p.radius + 30), p.y + Math.sin(ang) * (p.radius + 30),
          p.vx + Math.cos(ang) * sp, p.vy + Math.sin(ang) * sp,
          700 + rng() * 1200);
        m.magma = 7; m.magmaBorn = true; m.color = '#ff8040';
        if (infested) game.emberWarn = true; else game.magmaWarn = true;
      }
    } else if (p.ptype === 'ice') {
      // Cryo-geysers pop free ice chunks into low orbit — shield restock
      p.hazT = (p.hazT ?? 7) - dt;
      if (p.hazT <= 0) {
        p.hazT = 16 + rng() * 12;
        let n = 0;
        for (const b of game.bodies) {
          if (b.alive && b.iceOf === p && !b.heldBy &&
              Math.hypot(b.x - p.x, b.y - p.y) < p.radius + 700) n++;
        }
        if (n < 6) {
          const a = rng() * TAU;
          const cr = p.radius + 140 + rng() * 280;
          const x = p.x + Math.cos(a) * cr, y = p.y + Math.sin(a) * cr;
          const v = orbitVel(p, x, y, 1);
          const c = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, 120 + rng() * 330);
          c.color = '#bfe3f2'; c.ice = true; c.iceOf = p;
          railBody(c, p);
          game.geyserWarn = true;
        }
      }
    } else if (p.ptype === 'ocean' && !p.fort) {
      // WATERSPOUTS: the world-sea flings condensed brine ice into low orbit —
      // the cryo-geyser loop with a sea-green cast. Same caps (iceOf), same
      // rails, so the pellet economy can never flood the belt. NOT while
      // fortified (the shroud-cloak rule): the spouts only fire with the
      // player inside 4200 — i.e. exactly during a siege — and a Bastion
      // handing its attacker free railed shield ammo undercuts the siege.
      p.hazT = (p.hazT ?? 6) - dt;
      if (p.hazT <= 0) {
        p.hazT = 13 + rng() * 10;
        let n = 0;
        for (const b of game.bodies) {
          if (b.alive && b.iceOf === p && !b.heldBy &&
              Math.hypot(b.x - p.x, b.y - p.y) < p.radius + 600) n++;
        }
        if (n < 5) {
          const a = rng() * TAU;
          const cr = p.radius + 110 + rng() * 220;
          const x = p.x + Math.cos(a) * cr, y = p.y + Math.sin(a) * cr;
          const v = orbitVel(p, x, y, 1);
          const c = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, 110 + rng() * 280);
          c.color = '#b9e9d9'; c.ice = true; c.iceOf = p;
          railBody(c, p);
          game.spoutWarn = true;
        }
      }
    } else if (iceMoon) {
      // Ice MOONS vent cryo-geysers too — an early, close-in harvesting loop:
      // hover the field and scoop the pellets it pops into low orbit. Faster
      // cadence than the far ice planets, sized to the smaller moon.
      if (p.heldBy) continue;
      p.hazT = (p.hazT ?? 5) - dt;
      if (p.hazT <= 0) {
        p.hazT = 9 + rng() * 8;
        let n = 0;
        for (const b of game.bodies) {
          if (b.alive && b.iceOf === p && !b.heldBy &&
              Math.hypot(b.x - p.x, b.y - p.y) < p.radius + 260) n++;
        }
        if (n < 4) {
          const a = rng() * TAU;
          const cr = p.radius + 40 + rng() * 90;
          const x = p.x + Math.cos(a) * cr, y = p.y + Math.sin(a) * cr;
          const v = orbitVel(p, x, y, 1);
          const c = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, 110 + rng() * 220);
          c.color = '#bfe3f2'; c.ice = true; c.iceOf = p;
          railBody(c, p);
          game.geyserWarn = true;
        }
      }
    } else if (cometMoon) {
      // COMET MOONS vent on a TIMETABLE: same pellet economy as the ice
      // geysers (iceOf caps, rails, catchable ammo), but only near PERIAPSIS —
      // spawnMoon put it on the widest ellipse its slot allows, and the chart's
      // orbit lanes are how you read when the next close pass comes. A comet
      // moon that lost its rail (grabbed, knocked loose) vents on the plain ice
      // cadence instead: derailed there IS no periapsis, and a moon that never
      // vents again after one grab would quietly delete its own mechanic.
      if (p.heldBy) continue;
      const rail = p.rail;
      // THE FAST CADENCE IS PAID FOR BY THE WINDOW, so it only exists where a
      // window does. `near` is d < peri * 1.35, which is ALWAYS true below
      // e ≈ 0.149 ((1+e) < (1-e)·1.35) — and the off-view re-rail scan puts a
      // disturbed moon back on a CIRCULAR rail (no e at all). So a low-e roll
      // or one grab-and-release would turn "burst at periapsis" into the
      // fastest permanent geyser in the sky (~1.5x the ice moon it is modeled
      // on, uncapped by fieldXp — measured, progression audit 2026-08). Only a
      // rail with a real timetable (e ≥ 0.15) earns the burst; everything else
      // vents on the plain ice-moon cadence.
      const timetabled = !!(rail && rail.parent && rail.e >= 0.15);
      const near = !timetabled ||
        Math.hypot(p.x - rail.parent.x, p.y - rail.parent.y) < rail.a * (1 - rail.e) * 1.35;
      p.hazT = (p.hazT ?? 4) - dt;
      if (p.hazT <= 0 && near) {
        // Faster than the ice-moon cadence while a real window is open — the
        // close pass is short, and the burst is the event.
        p.hazT = timetabled ? 6 + rng() * 5 : 9 + rng() * 8;
        let n = 0;
        for (const b of game.bodies) {
          if (b.alive && b.iceOf === p && !b.heldBy &&
              Math.hypot(b.x - p.x, b.y - p.y) < p.radius + 260) n++;
        }
        if (n < 4) {
          const a = rng() * TAU;
          const cr = p.radius + 40 + rng() * 90;
          const x = p.x + Math.cos(a) * cr, y = p.y + Math.sin(a) * cr;
          const v = orbitVel(p, x, y, 1);
          const c = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, 110 + rng() * 220);
          c.color = '#d8ecf2'; c.ice = true; c.iceOf = p;
          railBody(c, p);
          game.cometVentWarn = true;
        }
      }
    } else if (sulfurVenting) {
      // SULFUR MOONS: the pop chain a player smash queued (physics.damageBody
      // sets sulfurPops). Each pop fountains one loose ballistic rock — the
      // forge-magma precedent: NEVER railed — capped like the geysers so a
      // pop party can't flood the belt.
      if (p.heldBy) continue;
      p.sulfurPopT = (p.sulfurPopT ?? 0.2) - dt;
      if (p.sulfurPopT <= 0) {
        p.sulfurPopT = 0.3 + rng() * 0.2;
        let n = 0;
        for (const b of game.bodies) {
          if (b.alive && b.sulfurOf === p && !b.heldBy &&
              Math.hypot(b.x - p.x, b.y - p.y) < p.radius + 400) n++;
        }
        // The shared debris budget (CFG.DEBRIS_BUDGET / physics.debrisRoom),
        // inlined rather than imported — physics imports world, and this is one
        // registry read. The old `bodies.length < 400` counted shoal rock and
        // so was false from frame one: sulfur vents have never fired in a world
        // with dense fields in it.
        const room = CFG.DEBRIS_BUDGET - (game.reg ? game.reg.nonField.length : game.bodies.length);
        if (n < 6 && room > 0) {
          const a = rng() * TAU;
          const sp = 160 + rng() * 100;
          const c = spawnAsteroid(game.bodies,
            p.x + Math.cos(a) * (p.radius + 10), p.y + Math.sin(a) * (p.radius + 10),
            p.vx + Math.cos(a) * sp, p.vy + Math.sin(a) * sp, 60 + rng() * 140);
          c.color = '#d4b45a'; c.sulfurOf = p;
        }
        p.sulfurPops--;
      }
    }
  }
  // ---- discovery scans (throttled — none of this needs frame precision) ----
  game.scanT = (game.scanT ?? 0.5) - dt;
  if (game.scanT <= 0) {
    game.scanT = 0.5;
    const hs = game.homeStar;
    // FOG OF WAR: anything that has come within sensor range is charted on
    // the minimap forever (render.js skips bodies without b.seen). Only the
    // types the minimap actually draws are worth flagging.
    if (s.alive) {
      // Deep Sensors upgrade widens the reveal radius (st.sensorMul)
      let seeR = Math.max(2600, (game.viewR || 1200) * 1.25) * (game.st.sensorMul || 1);
      // The awakened Herald is a live beacon: near it the scan sees half again
      // as far. render.js mirrors this in the minimap sensor bubble — keep the
      // two in sync or the bubble lies about the reveal.
      const gh0 = game.ghost;
      if (gh0 && gh0.alive && gh0.awake &&
          Math.hypot(gh0.x - s.x, gh0.y - s.y) < 6000) seeR *= 1.5;
      const seeR2 = seeR * seeR;
      for (const b of game.bodies) {
        // b.hidden = sensor-null (the dark star): NEVER revealed by the scan,
        // only by the powered relay (updateDeliveries sets seen directly).
        if (b.seen || !b.alive || b.hidden) continue;
        const bt = b.type;
        if (bt !== 'planet' && bt !== 'moon' && bt !== 'rogue' && bt !== 'station' &&
            bt !== 'nest' && !b.comet && !b.visitor) continue;
        const ddx = b.x - s.x, ddy = b.y - s.y;
        if (ddx * ddx + ddy * ddy < seeR2) b.seen = true;
      }
      // Dense fields are charted as REGIONS, not as their individual rocks
      // (render's minimap stipple reads f.seen): the anchor coming inside
      // sensor range identifies the whole shoal, same rule as a body.
      if (game.fields) {
        for (const f of game.fields) {
          if (f.seen) continue;
          const ddx = f.x - s.x, ddy = f.y - s.y;
          if (ddx * ddx + ddy * ddy < seeR2) f.seen = true;
        }
      }
    }
    // CHART: reading a nameplate (the approach zone) charts the body — the old
    // planets-only survey, generalized to every chartKey carrier: moons,
    // stations, and named landmarks. Exploring IS the mechanic, no extra
    // button. The TOTAL is recomputed live each tick so a chartable destroyed
    // while uncharted drops out of the denominator instead of softlocking the
    // 100% MASTER CHART (and hidden bodies stay out until revealed).
    if (s.alive) {
      // RECON DRONE (scout) auto-charts from far beyond the nameplate zone;
      // its reach is HALVED for small bodies so a ranked drone doesn't chart
      // a whole moon family from across the well.
      const recon = game.st.recon || 0;
      let uncharted = 0, justCharted = null;
      for (const b of game.bodies) {
        if (!b.alive || !b.chartKey || b.hidden || game.charted[b.chartKey]) continue;
        const d = Math.hypot(b.x - s.x, b.y - s.y);
        // Chart zone = the nameplate zone (drawApproach): planets keep their
        // wide ring, named POIs their 900/1400 POI zones, plain moons a
        // tighter ring of their own — reading the nameplate IS the chart.
        const zone = (b.type === 'planet' ? b.radius * 5 + 600
          : b.shepherd || b.volcanic || b.carved ? 900
            : b.type === 'station' || b.majorComet ? 1400
              : b.type === 'moon' ? b.radius * 5 + 300 : 900)
          + recon * (b.type === 'planet' ? 1300 : 650);
        if (d < zone) { game.charted[b.chartKey] = true; game.prog.surveyed++; justCharted = b; }
        else uncharted++;
      }
      game.surveyTotal = game.prog.surveyed + uncharted;
      if (justCharted) {
        const b = justCharted;
        addXp(game, b.dark ? PROG.XP_SURVEY_STAR
          : b.type === 'planet' ? PROG.XP_SURVEY
            : b.type === 'moon' ? PROG.XP_SURVEY_MOON : PROG.XP_SURVEY_POI);
        const nm = b.name || (b.type === 'moon' && b.parent && b.parent.name
          ? `moon of ${b.parent.name}` : b.type);
        game.surveyMsg = `CHARTED: ${nm.toUpperCase()} — ${game.prog.surveyed}/${game.surveyTotal} logged. +XP.`;
        if (b.dark) {
          // The questline payoff: a permanent +1 lives cap (config.maxLives
          // reads the bonus), an immediate life, and the final echo — which
          // FOLLOWS the chart message (wandererEchoT) instead of overwriting
          // it in the same frame's single HUD slot.
          game.prog.maxLivesBonus = (game.prog.maxLivesBonus || 0) + 1;
          game.prog.lives = Math.min(maxLives(game.prog), game.prog.lives + 1);
          game.surveyMsg = `THE WANDERER'S STAR — charted at last. Lives cap raised. +XP.`;
          game.wandererEchoT = 6;
        }
        // MASTER CHART: every chartable body logged. One-shot; the permanent
        // sensor/forecast bonus reads prog.masterChart in shipStats.
        if (uncharted === 0 && !game.prog.masterChart) {
          game.prog.masterChart = true;
          addXp(game, PROG.XP_MASTER_CHART);
          game.masterChartWarn = true;
        }
      }
    }
    // IRON MOON tut: fires the first time you SEE the pooling happen —
    // several chunks gathered in a magnet halo with the ship close enough
    // to watch (the pull itself lives in physics's debris loop).
    if (s.alive && !game.tut.iron) {
      for (const b of game.bodies) {
        if (!b.alive || b.type !== 'moon' || b.moonType !== 'iron') continue;
        if (Math.hypot(b.x - s.x, b.y - s.y) > 1500) continue;
        let n = 0;
        for (const d2 of game.debris) {
          if (Math.hypot(d2.x - b.x, d2.y - b.y) < CFG.IRON_MAGNET_R) n++;
        }
        if (n >= 3) { game.ironWarn = true; break; }
      }
    }
    if (s.alive) for (const p of game.bodies) {
      if (!p.alive || p.type !== 'planet') continue;
      if (p.eclipseCd > 0) p.eclipseCd -= 0.5;
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d > 6500) continue;
      // MOONSHADOW: a moon sitting on the sun-planet line casts its shadow
      // on the world. Pure geometry, only checked for planets near the player.
      const rpx = p.x - hs.x, rpy = p.y - hs.y;
      const pr = Math.hypot(rpx, rpy) || 1;
      const ux = rpx / pr, uy = rpy / pr;
      for (const m of game.bodies) {
        if (!m.alive || m.type !== 'moon' || m.parent !== p) continue;
        const mx = m.x - hs.x, my = m.y - hs.y;
        const proj = mx * ux + my * uy;
        if (proj <= 0 || proj >= pr) continue;          // must sit between sun and planet
        if (Math.abs(mx * uy - my * ux) < m.radius * 1.7) {
          p.eclipseT = 1.2;                             // refreshed while aligned
          if (!(p.eclipseCd > 0)) { p.eclipseCd = 90; game.eclipseName = p.name; }
          break;
        }
      }
    }
    // Graveyard orbit: announce the wreck ring on first close pass. The band
    // is a SUN-DISTANCE window straddling GRAVEYARD_R, so it rides SYSTEM
    // SCALE with the ring it is announcing — left unscaled it would sit in
    // empty space inside the innermost lane and the ring would never announce
    // at all. Reaching up to VESPER_PERI is deliberate: the comet's perihelion
    // is the top of the same neighbourhood.
    if (s.alive && !game.tut.graveyard) {
      const rc = Math.hypot(s.x - hs.x, s.y - hs.y);
      if (rc > GRAVEYARD_R * 0.85 && rc < VESPER_PERI) game.graveyardWarn = true;
    }
    // Comet Vesper: announce the first time it crosses the player's view
    if (s.alive && game.vesper && game.vesper.alive && !game.tut.vesper &&
        Math.hypot(game.vesper.x - s.x, game.vesper.y - s.y) < (game.viewR || 1200) * 1.35) {
      game.vesperWarn = true;
    }
    // Dense fields announce on approach — a rising-edge latch per field (the
    // scan re-fires every 0.5s, so a bare flag would spam), re-armed with
    // hysteresis once the player is well clear so a return visit re-hails.
    if (s.alive && game.fields) {
      for (const f of game.fields) {
        const frac = fieldFrac(f, s.x, s.y);   // the shared pocket-footprint test
        if (frac < 1.1) {
          if (!f.near) { f.near = true; game.fieldWarn = true; }
        } else if (frac > 1.6) f.near = false;
      }
    }
    // Ring shepherd: an unshepherded ring scatters, and slowly reknits if
    // the moonlet ever settles back into its lane. Runs even while the ship
    // is dead — the consequence keeps unfolding without an audience. "Gone"
    // means dead, stolen, or out of the lane; a mere derail (rogue drive-by)
    // while it still orbits in place must NOT scatter the ring.
    const shp = game.shepherdPlanet;
    if (shp && shp.alive) {
      const sh = game.shepherd;
      const gone = !sh || !sh.alive || !!sh.heldBy ||
        Math.hypot(sh.x - shp.x, sh.y - shp.y) > shp.radius * 2.6;
      shp.ringDecay = Math.max(0, Math.min(1, (shp.ringDecay || 0) + (gone ? 0.004 : -0.002)));
      if (gone && !shp.ringWarned && shp.ringDecay > 0.05) {
        shp.ringWarned = true;
        game.ringDecayName = shp.name;
      }
      if (!gone && shp.ringDecay === 0) shp.ringWarned = false;
    }
  }

  // Deliveries — the shared handover verb (per-frame; see updateDeliveries)
  updateDeliveries(game);

  // The Wanderer's Star payoff echo, delayed so it lands after the chart
  // message instead of fighting it for the single HUD slot.
  if (game.wandererEchoT > 0) {
    game.wandererEchoT -= dt;
    if (game.wandererEchoT <= 0) game.echoMsg = ECHOES.wanderer;
  }
  // The rescued pilot's line, same delayed-beat idiom.
  if (game.rescueEchoT > 0) {
    game.rescueEchoT -= dt;
    if (game.rescueEchoT <= 0) game.echoMsg = pick(Math.random, ECHOES.rescue);
  }

  // Tinker Barge: a chime ping (a slower, friendlier cousin of the Herald's
  // sonar — 4.5s vs 3.5s so the two are tellable apart by ear) plus the want
  // hail once you're in trading range.
  if (game.tinker && game.tinker.alive && s.alive) {
    const tk = game.tinker;
    if (game.tinkerCd > 0) game.tinkerCd -= dt;
    const td = Math.hypot(tk.x - s.x, tk.y - s.y);
    game.tinkerPingT = (game.tinkerPingT ?? 1) - dt;
    if (td < 3200 && game.tinkerPingT <= 0) {
      game.tinkerPingT = 4.5;
      game.tinkerPing = { x: tk.x, y: tk.y, t: 1.6, friendly: true };
      sfxPing(0.7 * (1 - td / 3400));
    }
    // A want the neighborhood can no longer supply is quietly re-rolled — the
    // barge only ever asks for things that are actually close by, not just
    // things that WERE when the want was picked (rails sweep supply in and
    // out of the lane). Never while the player is HOLDING a match: re-rolling
    // out from under a delivery in progress would be the worst kind of rude.
    game.tinkerCensusT = (game.tinkerCensusT ?? 8) - dt;
    if (game.tinkerCensusT <= 0) {
      game.tinkerCensusT = 8;
      const w = game.tinkerWant;
      const holdingMatch = w && ((game.held && wantSupply(w, game.held)) ||
        (game.held2 && wantSupply(w, game.held2)));
      if (w && !holdingMatch && tinkerWantCounts(game)[w.id] === 0) {
        game.tinkerWant = pickTinkerWant(game, w);
        game.tinkerSaid = null;   // re-hail the new want on approach
      }
    }
    // Hail once per want per approach (leaving resets it, so a return visit
    // re-hails; a rotated want re-hails immediately).
    if (td > 2600) game.tinkerSaid = null;
    if (td < 1800 && game.tinkerWant && !(game.tinkerCd > 0) &&
        game.tinkerSaid !== game.tinkerWant.id) {
      game.tinkerSaid = game.tinkerWant.id;
      game.tinkerWantWarn = game.tinkerWant.label;
    }
  }
  if (game.tinkerPing) {
    game.tinkerPing.t -= dt;
    if (game.tinkerPing.t <= 0) game.tinkerPing = null;
  }

  // Ghost ship ping — found by ear: a sonar blip (louder as you close in)
  // plus a visible ring rippling out of the wreck. Once AWAKE (a wreck
  // delivered — wakeHerald) the same cadence turns friendly: no more UNKNOWN
  // CONTACT warnings, and the ring renders warm instead of mournful.
  if (game.ghost && game.ghost.alive && s.alive) {
    const gh = game.ghost;
    if (gh.awake && gh.wakeEchoT > 0) {
      gh.wakeEchoT -= dt;   // the two-beat resolution: announcement, then the echo
      if (gh.wakeEchoT <= 0) game.echoMsg = ECHOES.heraldWake;
    }
    const gd = Math.hypot(gh.x - s.x, gh.y - s.y);
    game.ghostPingT = (game.ghostPingT ?? 1) - dt;
    if (gd < 3000 && game.ghostPingT <= 0) {
      game.ghostPingT = 3.5;
      game.ghostPing = { x: gh.x, y: gh.y, t: 1.6, friendly: !!gh.awake };
      sfxPing(1 - gd / 3200);
      if (!game.tut.ghost && !gh.awake) game.ghostWarn = true;
    }
  }
  if (game.ghostPing) {
    game.ghostPing.t -= dt;
    if (game.ghostPing.t <= 0) game.ghostPing = null;
  }

  // Magma cools into dense dark rock; spent comets fade away off-screen
  // (captured ones are keepers)
  // Registry, not a walk (physics.updateFieldLOD collects it in the one
  // full-array pass the frame already pays for): this ticked two fields over
  // EVERY body in the world every frame — ~15k iterations at shoal scale —
  // for the handful that ever carry magma or a comet timer. No LOD trade
  // here: the registry holds dormant members too, so decay keeps running for
  // rocks the player has flown away from. Falling back to the full array
  // covers the first frame of a fresh world, before the LOD has run.
  for (const b of (game.reg ? game.reg.decay : game.bodies)) {
    if (b.magma > 0) { b.magma -= dt; if (b.magma <= 0) b.color = '#6e5a50'; }
    if (b.comet && b.alive) {
      b.cometT -= dt;
      if (b.cometT <= 0 && !b.heldBy &&
          Math.hypot(b.x - s.x, b.y - s.y) > (game.viewR || 1000) * 2) b.alive = false;
    }
  }

  // View-local asteroid field: rocks only need to exist a threshold outside
  // the current view. Keep a slowly-drifting target count in a ring just
  // beyond the camera edge, and cull local rocks left far behind.
  const viewR = game.viewR || 900;

  game.localCullT = (game.localCullT ?? 2.5) - dt;
  if (game.localCullT <= 0) {
    game.localCullT = 2.5;
    const cullR = viewR * 1.8 + 2600;
    // Registry (the `!b.local` reject below still stands, so the full-array
    // fallback behaves identically on a world's first frame).
    for (const b of (game.reg ? game.reg.locals : game.bodies)) {
      if (!b.local || !b.alive || b.heldBy || b.thrownTimer > 0) continue;
      if (Math.hypot(b.x - game.ship.x, b.y - game.ship.y) > cullR) b.alive = false;
    }
    // THE LEASH (CFG.DEBRIS_LEASH / THROW_LEASH). Loose rubble that has drifted
    // clear of the player is retired. The crumble layer mints real debris every
    // time a world is hit, and without this every lane the player ever fought
    // in stays permanently littered — paying the broad phase and holding debris
    // budget for rock nobody will look at again. RAILED bodies are exempt:
    // a world's belt, its junk probes, its ring chunks and the trojans ARE the
    // system, and they cost nothing once dormant. So is anything the expedition
    // layer cares about, and so is crust still settling into a halo.
    // Both radii sit far outside any view, so nothing can be seen to vanish —
    // that is the constraint the numbers are chosen against.
    const loose = viewR * CFG.DEBRIS_LEASH + CFG.LEASH_PAD;
    const slung = viewR * CFG.THROW_LEASH + CFG.LEASH_PAD;
    for (const b of (game.reg ? game.reg.nonField : game.bodies)) {
      if (!b.alive || b.onRails || b.heldBy || b.type !== 'asteroid' || b.local) continue;
      if (b.crust || b.core || b.cache || b.pod || b.carved || b.visitor ||
          b.wreck || b.junk || b.comet || b.tinker || b.ghost) continue;
      // Something the PLAYER threw gets a long run before it goes — a throw is
      // a deliberate act, and a rock vanishing out from under a shot in flight
      // (or one you are chasing) would be the leash making a decision for them.
      const r = b.slung ? slung : loose;
      if (Math.hypot(b.x - game.ship.x, b.y - game.ship.y) > r) b.alive = false;
    }
  }

  // AMBIENT WORLD WEAR — see CFG.PLANET_WEAR_*. A world nobody is at slowly
  // picks up meteor damage, so a lane you return to after a long detour has
  // visibly weathered instead of being pristine exactly as you left it.
  // Deliberately NOT routed through physics.damageBody: that derails on any
  // chip (a weathering planet must never come off its rail), sheds mass, calves
  // crust and can shatter. This only ever costs hp and leaves small craters,
  // and it STOPS DEAD at the floor — the sky must never fall apart on its own.
  game.wearT = (game.wearT ?? 2) - dt;
  if (game.wearT <= 0) {
    const step = 2;
    game.wearT = step;
    for (const p of (game.reg ? game.reg.planets : [])) {
      if (!p.alive || p.nearShip || p.fort) continue;   // present player, or a shielded siege
      // A gas giant doesn't pit — damageBody's canWear already excludes gas
      // (its damage reads as WEATHER, never craters), and a scar minted here
      // would notch the cloud tops in BOTH render.worldSil and physics.surfRadius.
      // The hp drip is skipped too: the wear floor (0.5) sits past drawGasWound's
      // 0.4 glow gate, so ambient wear alone would eventually open a glowing
      // hole in every giant's cloud deck with nothing having hit it.
      if (p.ptype === 'gas') continue;
      // ...and neither does an OCEAN world: the sea closes over every wound —
      // no pitting, no scars (hits read as waves; see the OCEAN_* notes).
      if (p.ptype === 'ocean') continue;
      const floor = p.maxHp * CFG.PLANET_WEAR_FLOOR;
      if (p.hp <= floor) continue;
      // Rate hashed off the id, never drawn from the world rng — a draw here
      // would reshuffle the whole seeded sky (the expedition-layer rule above).
      const [lo, hi] = CFG.PLANET_WEAR_DPS;
      const k = (Math.sin(p.id * 78.233) * 0.5 + 0.5);
      p.hp = Math.max(floor, p.hp - (lo + (hi - lo) * k) * step);
      // A crater every so often, so the wear READS and not just the hp bar.
      // Small: this is pitting, not a moon strike (physics sizes a real impact
      // crater from the slab it calved, which ambient wear never does).
      p.wearScar = (p.wearScar ?? 0) + (lo + (hi - lo) * k) * step;
      if (p.wearScar > p.maxHp * CFG.PLANET_WEAR_SCAR) {
        p.wearScar = 0;
        p.scars.push({ a: (p.id * 2.399 + p.scars.length * 1.7) % TAU,
          s: 0.4 + (Math.sin(p.id * 12.9898 + p.scars.length) * 0.5 + 0.5) * 0.45,
          t: game.time });
        // Keep the WORST wounds, exactly as physics.damageBody does — ambient
        // pitting must never erase the crater a thrown moon left.
        if (p.scars.length > 10) {
          let wi = 0;
          for (let i = 1; i < p.scars.length; i++) if (p.scars[i].s < p.scars[wi].s) wi = i;
          p.scars.splice(wi, 1);
        }
      }
    }
  }

  game.asteroidTimer -= dt;
  if (game.asteroidTimer > 0) return;
  game.asteroidTimer = 0.4;
  // The available amount breathes over time so the field never feels static
  const target = Math.round(30 + 22 * (0.5 + 0.5 * Math.sin(game.time * 0.02)));
  // Both counts come off the registry — they were two more full-array reduces,
  // 2.5x a second over every body in the world. A body that died since the
  // last LOD pass is still counted here for one frame; the only consequence is
  // one spawn cycle budgeting slightly low, and it self-corrects immediately.
  const reg = game.reg;
  const locals = reg ? reg.locals.length
    : game.bodies.reduce((n, b) => n + (b.alive && b.local ? 1 : 0), 0);
  const total = reg ? reg.asteroids
    : game.bodies.reduce((n, b) => n + (b.alive && b.type === 'asteroid' ? 1 : 0), 0);
  // Global cap leaves room for the permanent trojan/ring/junk populations.
  // Raised 380 -> 9800 across the dense-field work: the four pockets are
  // ~8800 PERMANENT asteroids on their own, and the cap counts every asteroid
  // in the world — at the old ceilings the fields alone starved this
  // view-local spawner and the player flew through empty space everywhere
  // except the shoals. Field rock is gravity-free and non-attracting
  // (CFG.FIELD_*), so the count costs the O(bodies x attractors) gravity loop
  // nothing; the budget that actually binds is the collision broad-phase.
  if (locals >= target || total >= 9800) return;
  for (let i = 0; i < Math.min(3, target - locals); i++) {
    const th = rng() * TAU;
    const d = viewR + 250 + rng() * 1100;
    const x = game.ship.x + Math.cos(th) * d;
    const y = game.ship.y + Math.sin(th) * d;
    const fromSun = Math.hypot(x - game.homeStar.x, y - game.homeStar.y);
    if (Math.hypot(x, y) > CFG.WORLD_R || fromSun < game.homeStar.radius + 900) continue;
    const v = orbitVel(game.homeStar, x, y, 1);
    const a = rng() < 0.05
      ? spawnCache(game.bodies, x, y, v.vx, v.vy)          // occasional salvage cache
      : maybeCore(spawnAsteroid(game.bodies, x, y, v.vx, v.vy, asteroidMass(rng)), rng);
    a.local = true;
    railBody(a, game.homeStar);
  }
}
