import { CFG, PROG, addXp, maxLives, fieldFrac } from './config.js';
import { Body, railBody, railEllipse } from './entities.js';
import { seedGlowPockets } from './glow.js';
import { TAU, mulberry32, rand, pick } from './util.js';
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
// One name per layout planet — the list must be at least as long as the
// layout's named-planet count (19) or nameIdx wraps and the sky gets two
// worlds with one name (the old 14-name list shipped duplicate Khepri/Vantor,
// which made chart messages and window.goto ambiguous).
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
];
const MOON_TYPE_TOTAL = MOON_TYPES.reduce((s, m) => s + m.w, 0);
function pickMoonType(rng) {
  let r = rng() * MOON_TYPE_TOTAL;
  for (const mt of MOON_TYPES) { if ((r -= mt.w) < 0) return mt; }
  return MOON_TYPES[0];
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
  const radius = (18 + t * 16) * mt.rMul + rand(rng, -2, 2);
  // Moons run the gamut now — some are proper little worlds, and at these
  // masses they're real attractors. (The old sub-ATTRACT_MIN test-particle
  // rule predates rails: it only ever mattered for LIVE moons, and rails
  // hold their orbits exact regardless.) Heavier moons also gate the beam:
  // most need tier 2+ capacity to grab, so mooncatching is earned.
  const mass = (3000 + t * 8000) * mt.mMul;
  const dir = rng() < 0.85 ? 1 : -1;
  const m = new Body({
    type: 'moon', x: planet.x + mr, y: planet.y, vx: 0, vy: 0,
    mass, radius, color: pick(rng, mt.colors), parent: planet,
  });
  m.moonType = mt.type;
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
  const eCap = Math.min(0.34, 1 - (planet.radius + radius + 60) / mr);
  if (eCap > 0.08 && rng() < 0.55) {
    const e = Math.max(0, Math.min(rand(rng, 0.1, eCap), exCap / mr));
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
  return { minR: planet.radius + 90, maxR: hill * 1.5 };
}

function addPlanet(bodies, rng, star, orbitR, mass, radius, opts = {}) {
  const th = rng() * TAU;
  const x = star.x + Math.cos(th) * orbitR;
  const y = star.y + Math.sin(th) * orbitR;
  const dir = rng() < 0.85 ? 1 : -1;
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
  // exCap rationale in spawnMoon). Only edges SHARED with a sibling are
  // capped: the innermost moon's sunward reach is already guarded by the
  // planet-clearance term in spawnMoon, and the outermost may spill past
  // maxR like it always did (rails don't care). Keeping non-shared edges
  // uncapped matters: it leaves every NON-crossing orbit bit-identical to
  // the pre-fix worldgen — moons are attractors, so needlessly moving them
  // perturbs every free-flyer's path and re-rolls the whole sky's fate.
  const count = opts.moons || 0;
  if (count > 0) {
    const { minR, maxR } = moonZone(star, p, orbitR);
    if (maxR > minR + 50) {
      const slotW = (maxR - minR) / count;
      for (let i = 0; i < count; i++) {
        const t = (i + rand(rng, 0.1, 0.85)) / count;
        const mr = minR + (maxR - minR) * t;
        const lo = minR + slotW * i;
        const dLo = i > 0 ? mr - lo : Infinity;
        const dHi = i < count - 1 ? lo + slotW - mr : Infinity;
        spawnMoon(bodies, rng, p, mr, Math.min(dLo, dHi) - 45);
      }
    }
  }
  return p;
}

// A derelict station in orbit: light enough to steal, tough enough that the
// jackpot takes a real hit. Shattering one drops salvage modules (physics.js).
function addStation(bodies, rng, planet) {
  const r = planet.radius * 2.6 + 60;
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
    mass: 900, radius: 9, color: '#e8ddc0', name: 'Shepherd', parent: host,
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
  const r = 12000;
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
  const peri = 3900, semi = 12000;
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
function asteroidRadius(mass) { return 0.5 + Math.cbrt(mass) * 0.62; }

// Skewed small (down to pebbles), occasionally chunky — and ~12% are
// BOULDERS, a class between common rocks and moons that keeps the size
// ladder readable.
function asteroidMass(rng) {
  if (rng() < 0.12) return 2600 + rng() * 3400;   // boulder: 2600-6000
  return 15 + Math.pow(rng(), 2.2) * 2585;
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
  const sun = new Body({
    type: 'star', x: 0, y: 0, mass: 1.42e7, radius: 2400, color: '#ffd98a',
  });
  bodies.push(sun);

  // Inner system is scorched lava worlds, then a warm world-sea, the terran
  // world, a fortified desert, huge ringed gas giants of three kinds, a
  // crystal binary and a cloud-shrouded ringed world in the middle, and ice
  // in the far reaches. Top-end planet radius 520.
  // NOTE: the new archetypes live on what were ROCKY slots, with r/mass/
  // radius/moons untouched — only the type/palette changed, so the seeded
  // rng stream, positions, and the 17/45 balance baseline are all identical
  // to the four-type sky.
  // Each planet is an ECOSYSTEM: stations, nests, trojans, ring fields, junk
  // satellites, and type hazards all hang off these anchor worlds.
  // Spread wide: plenty of open flying and unoccupied worlds between the
  // occupied ones (2 nests, 1 fortified planet + 1 fortified moon, 1 ember
  // bloom — everything else is free space and salvage).
  const layout = [
    { r: 3600,  mass: 2e4,   radius: 60,  ptype: 'lava' },
    { r: 5000,  mass: 4e4,   radius: 85,  ptype: 'lava', moons: 1 },
    // Ocean at 6600, desert at 13000 — NOT the other way round: the Bastion
    // fortify pass always takes the 13000 slot, waterspouts are gated on
    // !fort (below), and an ocean world there would ship with its one
    // mechanic suppressed on every seed. Dune skimming is not fort-gated,
    // so the desert world under siege keeps its mechanic.
    { r: 6600,  mass: 6e4,   radius: 105, ptype: 'ocean', moons: 1 },
    { r: 8000,  belt: true, spread: 450, count: 60 },
    { r: 9500,  mass: 1.2e5, radius: 165, ptype: 'rocky', moons: 3, nest: true },
    { r: 11200, mass: 2e5,   radius: 235, ptype: 'terran', moons: 4, station: true },
    { r: 13000, mass: 1.3e5, radius: 170, ptype: 'desert', moons: 2 },
    { r: 14800, mass: 5e5,   radius: 430, ptype: 'gas', gasKind: 'violet', ring: true, moons: 7 },
    { r: 16800, mass: 2.2e5, radius: 220, ptype: 'crystal', binary: true },
    { r: 18400, belt: true, spread: 500, count: 50 },
    { r: 20200, mass: 3.5e5, radius: 340, ptype: 'gas', gasKind: 'azure', ring: true, moons: 6, station: true },
    { r: 22000, mass: 1.8e5, radius: 205, ptype: 'shroud', ring: true, moons: 3 },
    { r: 24000, mass: 6.5e5, radius: 520, ptype: 'gas', gasKind: 'amber', ring: true, moons: 8 },
    { r: 26500, mass: 1.6e5, radius: 195, ptype: 'ice', moons: 3, nest: true },
    { r: 28500, belt: true, spread: 600, count: 45 },
    { r: 30200, mass: 9e4,   radius: 140, ptype: 'ice', moons: 2, station: true },
    { r: 32500, mass: 4e4,   radius: 95,  ptype: 'ice', moons: 1 },
    { r: 34500, mass: 1.1e5, radius: 150, ptype: 'rocky', moons: 2 },
    { r: 36800, mass: 5e4,   radius: 120, ptype: 'ice', moons: 1 },
    // ---- THE OUTER BAND (37k-46k): the room opened by the WORLD_R area
    // growth. Entries are APPENDED so every earlier world's seeded placement
    // is untouched (draws happen in layout order); only post-layout content
    // re-rolls its angles. The dark star keeps its 39500 lane between the
    // first two, and The Farshoal (dense field) rides at 42400.
    // Lanes stop at 42600: the rogue spawn ring (WORLD_R - 600 = 45400) must
    // clear the outermost planet by ~2x RAIL_DISTURB. At 43900 the sentinel
    // sat 1500 from the ring — inside effective disturb reach (1400 + rogue
    // radius) — so a just-spawned rogue derailed it, co-traveled, and
    // gravitationally dragged it sunward (outer lanes orbit at only ~50 u/s).
    { r: 38300, mass: 6e4,   radius: 115, ptype: 'ice', moons: 2 },
    { r: 40800, mass: 5.5e4, radius: 105, ptype: 'rocky', moons: 1, station: true },
    { r: 42600, mass: 3.5e4, radius: 85,  ptype: 'ice' },   // a lone frozen sentinel — no moons, under the moon-accretion mass floor
  ];
  const planets = [];
  let nameIdx = 0;
  for (const item of layout) {
    if (item.belt) { addBelt(bodies, rng, sun, item.r, item.spread, item.count); continue; }
    item.name = PLANET_NAMES[nameIdx++ % PLANET_NAMES.length];
    const p = addPlanet(bodies, rng, sun, item.r, item.mass, item.radius, item);
    planets.push(p);
    if (item.station) addStation(bodies, rng, p);
    if (item.nest) addNest(bodies, rng, p);
    // BINARY PAIR: a near-equal companion circling the primary — the chaotic
    // double-well between them is a playground, and it guards good salvage.
    if (item.binary) {
      const th2 = rng() * TAU;
      const cx = p.x + Math.cos(th2) * 1500, cy = p.y + Math.sin(th2) * 1500;
      const cv = orbitVel(p, cx, cy, 1);
      const comp = new Body({
        type: 'planet', x: cx, y: cy, vx: cv.vx, vy: cv.vy,
        mass: item.mass * 0.75, radius: item.radius * 0.85,
        color: pick(rng, PTYPE_COLORS[item.ptype]),
        name: p.name + ' B', ptype: item.ptype, parent: p,
      });
      bodies.push(comp);
      railBody(comp, p);
      planets.push(comp);
      addStation(bodies, rng, comp);
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
  const planetAtOrbit = (r) => planets.find((p) => p.parent === sun && Math.abs(Math.hypot(p.x, p.y) - r) < 60);

  // LANDMARKS: render-only flags giving select worlds a unique face — the
  // Great Eye on the big gas giant, a rayed impact basin, live cryo-geysers.
  const stormHost = planetAtOrbit(24000); if (stormHost) stormHost.landmark = 'storm';
  const craterHost = planetAtOrbit(34500); if (craterHost) craterHost.landmark = 'crater';
  const geyserHost = planetAtOrbit(30200); if (geyserHost) geyserHost.landmark = 'geysers';

  // FORGE MOON: the inner gas giant keeps one volcanically live moon. When
  // you're close it lobs loose magma bombs that cool into dense sling rock
  // (replenishWorld hazard loop) — an Io, not a gun battery.
  const forgeHost = planetAtOrbit(14800);
  if (forgeHost) {
    const m = bodies.find((b) => b.type === 'moon' && b.parent === forgeHost);
    if (m) { m.volcanic = true; m.color = '#c98a6a'; m.name = 'Forge Moon'; m.chartKey = 'forge'; }
  }

  // RING SHEPHERD: one ringed giant has a visible ring gap held open by a
  // tiny named moonlet riding in it. Steal (or smash) the shepherd and the
  // ring slowly scatters — a consequence you can watch happen over minutes
  // (decay logic in replenishWorld, visuals in render.js).
  const shepHost = planetAtOrbit(20200);
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
  // corona (r~3250, below the innermost planet at 3600 and well inside the
  // flare zone) — the richest salvage in the system, guarded by heat, not
  // guns. One hulk carries a recovered log.
  {
    const g0 = rng() * TAU;
    for (let i = 0; i < 9; i++) {
      const a = g0 + (i / 9) * TAU + rand(rng, -0.15, 0.15);
      const gr = 3250 + rand(rng, -90, 90);
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
    const gr = 31400;
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
    const cr2 = 18400 + rand(rng, -300, 300);
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
  const planetAtR = (r) => planets.find((p) => p.parent === sun && Math.abs(Math.hypot(p.x, p.y) - r) < 60);
  fortify(planetAtR(13000), 260, 3);
  // (volcanic/shepherd moons are discovery content — never fortified — and a
  // fort on a DUST moon would contradict its stealth-haven job)
  const bigMoons = bodies.filter((b) => b.type === 'moon' && b.radius >= 28 &&
    !b.volcanic && !b.shepherd && b.moonType !== 'dust').slice(0, 1);
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
  const sr = 8000;
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
    const dr2 = 39500;   // its lane threads the outer band, between the 38300 and 40800 worlds
    const dx = Math.cos(th) * dr2, dy = Math.sin(th) * dr2;
    const dv = orbitVel(sun, dx, dy, 1);
    const dk = new Body({
      type: 'planet', x: dx, y: dy, vx: dv.vx, vy: dv.vy,
      mass: 4.5e4, radius: 70, color: '#241f2e',
      name: "The Wanderer's Star", parent: sun,
    });
    dk.dark = true; dk.hidden = true; dk.chartKey = 'wanderer';
    bodies.push(dk);
    railBody(dk, sun);
    game.darkStar = dk;
  }
  game.relayPowered = false;
  game.relayBeamT = 0;
  game.wandererEchoT = 0;
  // DENSE ASTEROID FIELDS: three packed rock shoals at fixed radii (appended
  // here, after every earlier rng draw, per the expedition-layer rule above).
  seedDenseFields(game, sun, rng);
  respawnShip(game);
}

// DENSE FIELDS — rock shoals packed tight enough that flying one is weaving,
// not cruising. Radii sit in the gaps between planet LANES (10400 between the
// 9500/11200 worlds, 23000 between 22000/24000, 33500 between 32500/34500) and
// clear of the existing belts. Each field is home to a finite SHOAL LURKER
// brood (CFG.FIELD_BROOD, ai.js) — the second and only other alien source
// besides nests; a brood destroyed quiets its field for the run.
const FIELD_DEFS = [
  { r: 10400, name: 'The Shoal' },
  { r: 23000, name: 'The Grindstones' },
  { r: 33500, name: 'The Hushfield' },
  // The frost fringe of the outer band opened by the WORLD_R 42000→46000
  // area growth. Beyond every planet lane (42600), brushing the Oort warning
  // band — evocative and harmless: Oort grinding bites the SHIP only, rocks
  // and lurkers are immune, and the reknit absorbs spawn-ring rogue plows.
  { r: 44300, name: 'The Farshoal' },
];

// Field rock mass — the full ladder without belt rock's heavy pebble skew: a
// shoal made of specks reads as space debris, not as terrain you thread. The
// exponent is near-linear (1.15 vs the belt's 2.2) so every size is well
// represented, and a third of the pocket is deliberately chunky. Masses above
// CFG.ATTRACT_MIN are fine HERE and nowhere else: markFieldRock forces
// `attractor = false` at any mass, so field rock never joins the
// O(bodies x attractors) gravity loop no matter how big it rolls. (History:
// before that rule, ordinary asteroidMass here minted ~107 permanent
// attractors and nearly doubled the hot loop.)
function fieldMass(rng) {
  if (rng() < 0.35) return 1800 + rng() * 3200;     // chunky tier: 1800-5000
  return 120 + Math.pow(rng(), 1.15) * 1700;
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
export function markFieldRock(b, fi) {
  b.field = fi;
  b.fieldRock = true;
  b.attractor = false;
  // Capped: FIELD_HP_MUL alone made a monolith ~34k hp — unbreakable, which
  // contradicts "bigger rocks break into pieces and keep the chaos going".
  // At the cap, a thrown moon-class mass still cracks anything in the shoal.
  b.hp = b.maxHp = Math.min(b.maxHp * CFG.FIELD_HP_MUL, CFG.FIELD_HP_CAP);
  return b;
}

function seedDenseFields(game, sun, rng) {
  game.fields = [];
  for (let fi = 0; fi < FIELD_DEFS.length; fi++) {
    const fd = FIELD_DEFS[fi];
    const ang0 = rng() * TAU;
    // ONE shared angular speed for the whole shoal: railBody's per-body ±4%
    // w jitter would shear a pocket this tight into a long dilute arc within
    // minutes (and same-radius rocks that catch up GRIND — the exact failure
    // the jitter comment warns about). A rigid pocket has ZERO relative
    // drift, which is what keeps "super dense" true for the whole run. The
    // FIELD's w is nudged once per field instead (deterministic off fi), so
    // the three shoals never sit in lockstep with the belts around them.
    const w = Math.sqrt(CFG.G * sun.mass / (fd.r * fd.r * fd.r)) * (1 + (fi - 1) * 0.015);
    const f = {
      r: fd.r, ang: ang0, w, name: fd.name, heart: null,
      x: sun.x + Math.cos(ang0) * fd.r, y: sun.y + Math.sin(ang0) * fd.r,
      brood: CFG.FIELD_BROOD, wakeT: 0, cleared: false, near: false, seen: false,
    };
    game.fields.push(f);
    const arc = CFG.FIELD_LEN / fd.r;   // physical pocket size at every radius
    const placed = [];
    for (let i = 0; i < CFG.FIELD_ROCKS; i++) {
      // Reject positions that land on top of something already placed: a rock
      // born touching the 5200-mass heart is quietly ABSORBED by the
      // surface-hugging rule on the first substep. Retries just consume more
      // of the seeded stream — deterministic, and nothing draws after fields.
      // The scan is bounded to the heart plus the last 40 placements: a full
      // O(n^2) sweep at this rock count is millions of checks per worldgen,
      // and freshRun/mechTest regenerate the world constantly.
      let x = 0, y = 0;
      for (let tries = 0; tries < 6; tries++) {
        const a = ang0 + rand(rng, -arc, arc);
        const rr = fd.r + rand(rng, -CFG.FIELD_SPREAD, CFG.FIELD_SPREAD);
        x = sun.x + Math.cos(a) * rr; y = sun.y + Math.sin(a) * rr;
        if (f.heart && Math.hypot(f.heart.x - x, f.heart.y - y) < 120) continue;
        let clash = false;
        for (let k = Math.max(0, placed.length - 40); k < placed.length; k++) {
          if (Math.hypot(placed[k].x - x, placed[k].y - y) < 40) { clash = true; break; }
        }
        if (!clash) break;
      }
      placed.push({ x, y });
      const v = orbitVel(sun, x, y, 1);
      let rock;
      if (i === 0) {
        // The field HEART: the shoal's named MONOLITH and its anchor. Its
        // rail angle IS the field anchor (ai.js updateFields reads it), and
        // its chartKey makes the field a chartable landmark.
        rock = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, CFG.FIELD_MONOLITH_MASS[1]);
        rock.name = fd.name; rock.chartKey = 'field' + fi;
        rock.giant = true;
        f.heart = rock;
      } else if (i <= CFG.FIELD_MONOLITHS) {
        // MONOLITHS: twice the drawn radius of the biggest regular giant
        // (8x the mass — radius goes with cbrt). Steer-by landmarks.
        rock = spawnAsteroid(game.bodies, x, y, v.vx, v.vy,
          rand(rng, CFG.FIELD_MONOLITH_MASS[0], CFG.FIELD_MONOLITH_MASS[1]));
        rock.giant = true;
      } else if (i <= CFG.FIELD_MONOLITHS + CFG.FIELD_GIANTS) {
        // GIANTS: the pocket's mid-tier landmarks and its chaos engine —
        // crack one and it sprays a cascade of smaller field rock
        // (physics.shatter).
        rock = spawnAsteroid(game.bodies, x, y, v.vx, v.vy,
          rand(rng, CFG.FIELD_GIANT_MASS[0], CFG.FIELD_GIANT_MASS[1]));
        rock.giant = true;
      } else if (rng() < 0.02) {
        rock = spawnCache(game.bodies, x, y, v.vx, v.vy);   // shoals hide salvage (rate halved when the rock count doubled — same absolute loot)
      } else {
        rock = maybeCore(spawnAsteroid(game.bodies, x, y, v.vx, v.vy, fieldMass(rng)), rng);
      }
      railBody(rock, sun);
      rock.rail.w = w;   // override the id-hashed jitter — the rigid-pocket rule above
      markFieldRock(rock, fi);
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
  s.x = game.spawn.x; s.y = game.spawn.y;
  s.vx = game.spawn.vx; s.vy = game.spawn.vy;
  s.hull = game.st.hullMax;
  s.shield = game.st.shieldMax;
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
          // is measured to each railed sibling's radial range; 90u covers
          // both bodies' radii. A blocked draw just retries; a fully missed
          // cycle only delays the refill by 60s.
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
            if (gap > 90) { spawnMoon(game.bodies, rng, p, mr, gap - 90); break; }
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
      // Never pop into existence in view — flip to the far side if needed
      let th = rng() * TAU;
      const px = Math.cos(th) * 3900, py = Math.sin(th) * 3900;
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
      const px = Math.cos(th) * 12000, py = Math.sin(th) * 12000;
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
  // 30s x 8 rocks ≈ 16/min: a rogue plow can scatter dozens at once (the
  // outer shoals sit inside the spawn ring's disturb annulus), and a slow
  // trickle leaves a pocket visibly thin for minutes — unacceptable for
  // content whose whole identity is density. Rate scales with FIELD_ROCKS.
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
      for (let i = 0; i < 55; i++) {   // scales with FIELD_ROCKS (see the cadence note above)
        const a = f.ang + rand(rng, -CFG.FIELD_LEN, CFG.FIELD_LEN) / f.r;
        const rr = f.r + rand(rng, -CFG.FIELD_SPREAD, CFG.FIELD_SPREAD);
        const x = game.homeStar.x + Math.cos(a) * rr;
        const y = game.homeStar.y + Math.sin(a) * rr;
        // Never in view — a rock fading into existence mid-screen reads wrong
        if (Math.hypot(x - s.x, y - s.y) < (game.viewR || 1200) * 1.3) continue;
        const v = orbitVel(game.homeStar, x, y, 1);
        const rock = maybeCore(spawnAsteroid(game.bodies, x, y, v.vx, v.vy, fieldMass(rng)), rng);
        railBody(rock, game.homeStar);
        rock.rail.w = f.w;   // join the rigid pocket, not the jittered flow
        markFieldRock(rock, fi);
      }
    }
  }

  // ---- solar storms: system-wide discovery weather (CFG.STORM_*). The
  // expanding front is tracked here; render draws it, physics gives loose
  // scrap a nudge, and every world the front washes over gets an aurora.
  game.stormTimer = (game.stormTimer ?? 300) - dt;
  if (game.stormTimer <= 0 && !game.storm) {
    game.stormTimer = CFG.STORM_EVERY * (0.6 + rng() * 1.0);
    game.storm = { r: game.homeStar.radius, prevR: game.homeStar.radius };
    game.stormWarn = true;
  }
  if (game.storm) {
    const wave = game.storm;
    wave.prevR = wave.r;
    wave.r += CFG.STORM_SPEED * dt;
    for (const p of game.bodies) {
      if (!p.alive || p.type !== 'planet') continue;
      const pr = Math.hypot(p.x, p.y);
      if (pr > wave.prevR - CFG.STORM_BAND && pr < wave.r + CFG.STORM_BAND) {
        // Only announce an aurora the player can actually see light up
        if (!(p.auroraT > 0) && Math.hypot(p.x - s.x, p.y - s.y) < 5200) game.auroraName = p.name;
        p.auroraT = 7;
      }
    }
    if (wave.r > CFG.WORLD_R + CFG.STORM_BAND) game.storm = null;
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
      if (next) { next.ember = 0.08; game.emberSeededName = next.name; }
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
    const iceMoon = p.type === 'moon' && p.moonType === 'ice';
    const sulfurVenting = p.type === 'moon' && p.moonType === 'sulfur' && p.sulfurPops > 0;
    if (!s.alive || (p.type !== 'planet' && !p.volcanic && !iceMoon && !sulfurVenting)) continue;
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
        if (n < 6 && game.bodies.length < 400) {
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
          + recon * (b.type === 'planet' ? 2600 : 1300);
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
    // Graveyard orbit: announce the wreck ring on first close pass
    if (s.alive && !game.tut.graveyard) {
      const rc = Math.hypot(s.x - hs.x, s.y - hs.y);
      if (rc > 2750 && rc < 3900) game.graveyardWarn = true;
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
  for (const b of game.bodies) {
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
    for (const b of game.bodies) {
      if (!b.local || !b.alive || b.heldBy || b.thrownTimer > 0) continue;
      if (Math.hypot(b.x - game.ship.x, b.y - game.ship.y) > cullR) b.alive = false;
    }
  }

  game.asteroidTimer -= dt;
  if (game.asteroidTimer > 0) return;
  game.asteroidTimer = 0.4;
  // The available amount breathes over time so the field never feels static
  const target = Math.round(30 + 22 * (0.5 + 0.5 * Math.sin(game.time * 0.02)));
  const locals = game.bodies.reduce((n, b) => n + (b.alive && b.local ? 1 : 0), 0);
  const total = game.bodies.reduce((n, b) => n + (b.alive && b.type === 'asteroid' ? 1 : 0), 0);
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
