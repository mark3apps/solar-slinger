import { CFG, PROG, addXp } from './config.js';
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
};

// Planet archetypes — each type has its own palette and its own look in the
// renderer (lava glow, rocky continents, gas bands, ice caps) so the kinds
// read at a glance.
const PTYPE_COLORS = {
  lava:  ['#e0603a', '#d4502c', '#e8784a'],
  rocky: ['#c98a5a', '#b0895f', '#8fae62', '#c9b45a'],
  gas:   ['#d9a95c', '#5a9dc9', '#b05ac9', '#7bd9c9'],
  ice:   ['#a8cbe8', '#8fd9d0', '#9a9ad9'],
};
const PLANET_NAMES = ['Khepri', 'Vantor', 'Ossia', 'Brune', 'Calyx', 'Nerev', 'Tantal', 'Ymir', 'Quorra', 'Pell', 'Sable', 'Ison', 'Halcyon', 'Drex'];

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

function spawnMoon(bodies, rng, planet, mr) {
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
  // semi-major axis; e is capped so periapsis always clears the planet, and
  // kept moderate so neighbouring moon orbits rarely cross (a crossing that
  // actually collides just derails + re-rails, but we keep it rare). Tight
  // inner slots fall back to circular. arg + phase are randomised so orbits
  // don't share an apsidal line.
  const eCap = Math.min(0.34, 1 - (planet.radius + radius + 60) / mr);
  if (eCap > 0.08 && rng() < 0.55) {
    railEllipse(m, planet, mr, rand(rng, 0.1, eCap), rng() * TAU, rng() * TAU, dir);
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
    color: pick(rng, PTYPE_COLORS[ptype]),
    name: opts.name || pick(rng, PLANET_NAMES),
    ring: opts.ring || false,
    ptype,
    parent: star,
  });
  bodies.push(p);
  railBody(p, star);

  // Moons spread across the whole stable zone — big outer planets get wide,
  // varied moon families instead of a tight string of pearls.
  const count = opts.moons || 0;
  if (count > 0) {
    const { minR, maxR } = moonZone(star, p, orbitR);
    if (maxR > minR + 50) {
      for (let i = 0; i < count; i++) {
        const t = (i + rand(rng, 0.1, 0.85)) / count;
        spawnMoon(bodies, rng, p, minR + (maxR - minR) * t);
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
  game.bodies.push(sh);
  railBody(sh, host);
  game.shepherd = sh;
  return sh;
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

  // Inner system is scorched lava worlds, the middle is rocky with huge
  // ringed gas giants, and the far reaches are ice. Top-end planet radius 520.
  // Each planet is an ECOSYSTEM: stations, nests, trojans, ring fields, junk
  // satellites, and type hazards all hang off these anchor worlds.
  // Spread wide: plenty of open flying and unoccupied worlds between the
  // occupied ones (2 nests, 1 fortified planet + 1 fortified moon, 1 ember
  // bloom — everything else is free space and salvage).
  const layout = [
    { r: 3600,  mass: 2e4,   radius: 60,  ptype: 'lava' },
    { r: 5000,  mass: 4e4,   radius: 85,  ptype: 'lava', moons: 1 },
    { r: 6600,  mass: 6e4,   radius: 105, ptype: 'rocky', moons: 1 },
    { r: 8000,  belt: true, spread: 450, count: 60 },
    { r: 9500,  mass: 1.2e5, radius: 165, ptype: 'rocky', moons: 3, nest: true },
    { r: 11200, mass: 2e5,   radius: 235, ptype: 'rocky', moons: 4, station: true },
    { r: 13000, mass: 1.3e5, radius: 170, ptype: 'rocky', moons: 2 },
    { r: 14800, mass: 5e5,   radius: 430, ptype: 'gas', ring: true, moons: 7 },
    { r: 16800, mass: 2.2e5, radius: 220, ptype: 'rocky', binary: true },
    { r: 18400, belt: true, spread: 500, count: 50 },
    { r: 20200, mass: 3.5e5, radius: 340, ptype: 'gas', ring: true, moons: 6, station: true },
    { r: 22000, mass: 1.8e5, radius: 205, ptype: 'rocky', ring: true, moons: 3 },
    { r: 24000, mass: 6.5e5, radius: 520, ptype: 'gas', ring: true, moons: 8 },
    { r: 26500, mass: 1.6e5, radius: 195, ptype: 'ice', moons: 3, nest: true },
    { r: 28500, belt: true, spread: 600, count: 45 },
    { r: 30200, mass: 9e4,   radius: 140, ptype: 'ice', moons: 2, station: true },
    { r: 32500, mass: 4e4,   radius: 95,  ptype: 'ice', moons: 1 },
    { r: 34500, mass: 1.1e5, radius: 150, ptype: 'rocky', moons: 2 },
    { r: 36800, mass: 5e4,   radius: 120, ptype: 'ice', moons: 1 },
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
    if (m) { m.volcanic = true; m.color = '#c98a6a'; m.name = 'Forge Moon'; }
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

  // SATELLITE JUNK: rocky worlds are littered with dead probes — triple scrap
  for (const p of planets) {
    if (p.ptype !== 'rocky') continue;
    const n = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const jr = p.radius + rand(rng, 80, 300);
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
    railBody(cs, sun);
  }

  // Hand each derelict station its echo log, in generation order
  {
    let ei = 0;
    for (const b of bodies) {
      if (b.type === 'station' && !b.ghost && ei < ECHOES.stations.length) b.echo = ECHOES.stations[ei++];
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
  // (volcanic/shepherd moons are discovery content — never fortified)
  const bigMoons = bodies.filter((b) => b.type === 'moon' && b.radius >= 28 && !b.volcanic && !b.shepherd).slice(0, 1);
  for (const m of bigMoons) fortify(m, 150, 2);

  // THE EMBERKIN: living plasma already blooming on the innermost lava world.
  // It deepens over time and, at full bloom, seeds the next planet outward.
  planets[0].ember = 0.55;

  // Rogue planets — wanderers that stir up (but can't shred) the system
  const rogues = [
    { mass: 2.5e5, radius: 95 },
    { mass: 3e5, radius: 105 },
    { mass: 3.5e5, radius: 112 },
    { mass: 4.5e5, radius: 125 },
  ];
  for (const rg of rogues) {
    const th = rng() * TAU;
    const d = CFG.WORLD_R * 0.92;
    // Oblique entry: sweep through the map rather than beelining into the sun
    const aimTh = th + Math.PI + (rng() < 0.5 ? -1 : 1) * rand(rng, 0.85, 1.25);
    const sp = rand(rng, 24, 44);
    bodies.push(new Body({
      type: 'rogue',
      x: Math.cos(th) * d, y: Math.sin(th) * d,
      vx: Math.cos(aimTh) * sp, vy: Math.sin(aimTh) * sp,
      mass: rg.mass, radius: rg.radius,
      color: '#7a4ad9',
      name: 'Rogue',
    }));
  }

  // Player starts in a stable orbit inside the inner asteroid belt.
  // The ship feels SHIP_GRAV-amplified gravity, so its circular speed differs
  // from the rocks around it.
  const sr = 8000;
  const sv = Math.sqrt((CFG.G * CFG.SHIP_GRAV * CFG.STAR_GRAV_SHIP * sun.mass) / sr);
  game.spawn = { x: sun.x, y: sun.y - sr, vx: sv, vy: 0 };
  game.homeStar = sun;
  game.moonBaseline = bodies.filter((b) => b.type === 'moon').length;
  game.surveyTotal = planets.length;   // worlds the CHART track can log
  // Roguelite life pods: one seeded near the starting belt so the +1-life
  // mechanic is discoverable; replenishWorld/main.js trickle in more.
  game.pickups = [];
  game.lifeTimer = PROG.LIFE_RESPAWN;
  spawnLifePod(game, sun.x + 2400, sun.y - sr - 1100);
  // Glow pockets: the sparse, sun-orbiting healing springs (deterministic, so
  // they reset with the world). Seeded off the same world rng — see glow.js.
  seedGlowPockets(game, rng);
  respawnShip(game);
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

// The world refills itself: asteroids near the player, fresh rogues at the
// rim, and new moons captured by lonely planets.
export function replenishWorld(game, dt) {
  const rng = Math.random;

  // Rogues — slower trickle, same cap of 3
  game.rogueTimer = (game.rogueTimer ?? 240) - dt;
  if (game.rogueTimer <= 0) {
    game.rogueTimer = 200 + rng() * 200;
    const rogues = game.bodies.reduce((n, b) => n + (b.alive && b.type === 'rogue' ? 1 : 0), 0);
    if (rogues < 3) {
      const th = rng() * TAU;
      const aimTh = th + Math.PI + (rng() < 0.5 ? -1 : 1) * (0.85 + rng() * 0.4);
      const sp = 24 + rng() * 20;
      game.bodies.push(new Body({
        type: 'rogue',
        x: Math.cos(th) * CFG.WORLD_R * 0.92, y: Math.sin(th) * CFG.WORLD_R * 0.92,
        vx: Math.cos(aimTh) * sp, vy: Math.sin(aimTh) * sp,
        mass: 2.5e5 + rng() * 2e5, radius: 95 + rng() * 30,
        color: '#7a4ad9', name: 'Rogue',
      }));
      game.rogueIncoming = 3;
    }
  }

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
          spawnMoon(game.bodies, rng, p, minR + (maxR - minR) * rng());
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
    // Aurora / eclipse timers fade even while the player is far away or dead
    if (p.auroraT > 0) p.auroraT -= dt;
    if (p.eclipseT > 0) p.eclipseT -= dt;
    const iceMoon = p.type === 'moon' && p.moonType === 'ice';
    if (!s.alive || (p.type !== 'planet' && !p.volcanic && !iceMoon)) continue;
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
        m.magma = 8; m.color = '#ff8040';
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
        m.magma = 7; m.color = '#ff8040';
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
      const seeR = Math.max(2600, (game.viewR || 1200) * 1.25) * (game.st.sensorMul || 1);
      const seeR2 = seeR * seeR;
      for (const b of game.bodies) {
        if (b.seen || !b.alive) continue;
        const bt = b.type;
        if (bt !== 'planet' && bt !== 'moon' && bt !== 'rogue' && bt !== 'station' &&
            bt !== 'nest' && !b.comet && !b.visitor) continue;
        const ddx = b.x - s.x, ddy = b.y - s.y;
        if (ddx * ddx + ddy * ddy < seeR2) b.seen = true;
      }
    }
    if (s.alive) for (const p of game.bodies) {
      if (!p.alive || p.type !== 'planet') continue;
      if (p.eclipseCd > 0) p.eclipseCd -= 0.5;
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      // SURVEY: reading a world's nameplate (the approach zone) charts it —
      // exploring IS the mechanic, no extra button.
      // RECON DRONE (scout) auto-charts worlds from much farther than the nameplate zone.
      if (!p.surveyed && d < p.radius * 5 + 600 + (game.st.recon || 0) * 2600) {
        p.surveyed = true;
        game.prog.surveyed++;
        addXp(game, PROG.XP_SURVEY);   // charting a world pays XP
        game.surveyMsg = `WORLD CHARTED: ${(p.name || 'planet').toUpperCase()} — ${game.prog.surveyed}/${game.surveyTotal} surveyed. +XP.`;
      }
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

  // Ghost ship ping — found by ear: a sonar blip (louder as you close in)
  // plus a visible ring rippling out of the wreck
  if (game.ghost && game.ghost.alive && s.alive) {
    const gh = game.ghost;
    const gd = Math.hypot(gh.x - s.x, gh.y - s.y);
    game.ghostPingT = (game.ghostPingT ?? 1) - dt;
    if (gd < 3000 && game.ghostPingT <= 0) {
      game.ghostPingT = 3.5;
      game.ghostPing = { x: gh.x, y: gh.y, t: 1.6 };
      sfxPing(1 - gd / 3200);
      if (!game.tut.ghost) game.ghostWarn = true;
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
  // Global cap leaves room for the permanent trojan/ring/junk populations
  if (locals >= target || total >= 380) return;
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
