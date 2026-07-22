import { CFG } from './config.js';
import { Body, railBody } from './entities.js';
import { TAU, mulberry32, rand, pick } from './util.js';

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
  const mth = rng() * TAU;
  const mx = planet.x + Math.cos(mth) * mr;
  const my = planet.y + Math.sin(mth) * mr;
  const mv = orbitVel(planet, mx, my, rng() < 0.85 ? 1 : -1);
  // Moons stay below ATTRACT_MIN on purpose: as test particles they exert no
  // force, so packed multi-moon systems can't pump each other (or their
  // planet) into chaos — these mass ratios physically can't support
  // mutually-gravitating moons at game scale. Bonus: aliens can throw them.
  const m = new Body({
    type: 'moon', x: mx, y: my, vx: mv.vx, vy: mv.vy,
    mass: rand(rng, 1400, 1900), radius: rand(rng, 16, 22),
    color: '#d3d9ec', parent: planet,   // pale ice — clearly not an asteroid
  });
  bodies.push(m);
  railBody(m, planet);
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

function asteroidRadius(mass) { return 1.6 + Math.cbrt(mass) * 0.78; }

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

function addBelt(bodies, rng, star, beltR, spread, count) {
  for (let i = 0; i < count; i++) {
    const r = beltR + rand(rng, -spread, spread);
    const th = rng() * TAU;
    const x = star.x + Math.cos(th) * r;
    const y = star.y + Math.sin(th) * r;
    const v = orbitVel(star, x, y, 1);
    const a = spawnAsteroid(bodies, x, y, v.vx, v.vy, asteroidMass(rng));
    railBody(a, star);
  }
}

export function generateWorld(game, seed = 20260721) {
  const rng = mulberry32(seed);
  const bodies = game.bodies;

  // ONE sun, vast and dangerous, with the whole map as its system.
  const sun = new Body({
    type: 'star', x: 0, y: 0, mass: 1.6e7, radius: 2400, color: '#ffd98a',
  });
  bodies.push(sun);

  // Inner system is scorched lava worlds, the middle is rocky with huge
  // ringed gas giants, and the far reaches are ice. Top-end planet radius 520.
  // Each planet is an ECOSYSTEM: stations, nests, trojans, ring fields, junk
  // satellites, and type hazards all hang off these anchor worlds.
  const layout = [
    { r: 3600,  mass: 2e4,   radius: 60,  ptype: 'lava' },
    { r: 4700,  mass: 4e4,   radius: 85,  ptype: 'lava', moons: 1 },
    { r: 5900,  mass: 6e4,   radius: 105, ptype: 'rocky', moons: 1 },
    { r: 7000,  belt: true, spread: 450, count: 60 },
    { r: 8200,  mass: 1.2e5, radius: 165, ptype: 'rocky', moons: 3, nest: true },
    { r: 9800,  mass: 2e5,   radius: 235, ptype: 'rocky', moons: 4, station: true },
    { r: 10800, mass: 1.3e5, radius: 170, ptype: 'rocky', moons: 2 },
    { r: 11800, mass: 5e5,   radius: 430, ptype: 'gas', ring: true, moons: 7, nest: true },
    { r: 14000, mass: 2.2e5, radius: 220, ptype: 'rocky', binary: true },
    { r: 15400, belt: true, spread: 500, count: 50 },
    { r: 17200, mass: 3.5e5, radius: 340, ptype: 'gas', ring: true, moons: 6, station: true },
    { r: 18600, mass: 1.8e5, radius: 205, ptype: 'rocky', ring: true, moons: 3 },
    { r: 20000, mass: 6.5e5, radius: 520, ptype: 'gas', ring: true, moons: 8 },
    { r: 22800, mass: 1.6e5, radius: 195, ptype: 'ice', moons: 3, nest: true },
    { r: 24800, belt: true, spread: 600, count: 45 },
    { r: 26200, mass: 9e4,   radius: 140, ptype: 'ice', moons: 2, station: true },
    { r: 28400, mass: 4e4,   radius: 95,  ptype: 'ice', moons: 1 },
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

  // RING FIELDS: gas-giant rings are made of actual grabbable ice chunks
  for (const p of planets) {
    if (p.ptype !== 'gas') continue;
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      const cr = p.radius * rand(rng, 1.55, 2.15);
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

  // (No map-wide free asteroid field — the view-local spawner in
  // replenishWorld keeps rocks available wherever the player actually is.)

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
  const sr = 7000;
  const sv = Math.sqrt((CFG.G * CFG.SHIP_GRAV * CFG.STAR_GRAV_SHIP * sun.mass) / sr);
  game.spawn = { x: sun.x, y: sun.y - sr, vx: sv, vy: 0 };
  game.homeStar = sun;
  game.moonBaseline = bodies.filter((b) => b.type === 'moon').length;
  respawnShip(game);
}

export function respawnShip(game) {
  const s = game.ship;
  s.x = game.spawn.x; s.y = game.spawn.y;
  s.vx = game.spawn.vx; s.vy = game.spawn.vy;
  s.hull = game.st.maxHull;
  s.alive = true;
  s.invuln = 4;
  game.deathCause = '';
}

// The world refills itself: asteroids near the player, fresh rogues at the
// rim, and new moons captured by lonely planets.
export function replenishWorld(game, dt) {
  const rng = Math.random;

  // Rogues
  game.rogueTimer = (game.rogueTimer ?? 150) - dt;
  if (game.rogueTimer <= 0) {
    game.rogueTimer = 150;
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

  // Moons — destroyed ones are eventually replaced around big planets
  game.moonTimer = (game.moonTimer ?? 90) - dt;
  if (game.moonTimer <= 0) {
    game.moonTimer = 90;
    const moons = game.bodies.filter((b) => b.alive && b.type === 'moon').length;
    if (moons < game.moonBaseline) {
      const hosts = game.bodies.filter((b) => b.alive && b.type === 'planet' && b.mass >= 5e4);
      if (hosts.length) {
        const p = hosts[Math.floor(rng() * hosts.length)];
        const orbitR = Math.hypot(p.x - game.homeStar.x, p.y - game.homeStar.y);
        const { minR, maxR } = moonZone(game.homeStar, p, orbitR);
        if (maxR > minR + 50) {
          const fakeRng = () => rng();
          spawnMoon(game.bodies, fakeRng, p, minR + (maxR - minR) * rng());
        }
      }
    }
  }

  // ---- solar flares: the sun erupts plasma at ships that fly too close ----
  const s = game.ship;
  game.flareTimer = (game.flareTimer ?? 20) - dt;
  if (game.flareTimer <= 0 && s.alive) {
    game.flareTimer = 30 + rng() * 25;
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
  game.cometTimer = (game.cometTimer ?? 75) - dt;
  if (game.cometTimer <= 0 && s.alive) {
    game.cometTimer = 90 + rng() * 60;
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

  // ---- planet-type hazards & gifts (only fire while the player is close) ----
  for (const p of game.bodies) {
    if (!p.alive || p.type !== 'planet' || !s.alive) continue;
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d > 4200) { continue; }
    if (p.ptype === 'lava') {
      // Magma bombardment: molten rock lobbed loosely your way. Dangerous
      // while glowing; cools into a dense dark rock — great fling ammo.
      p.hazT = (p.hazT ?? 4) - dt;
      if (p.hazT <= 0) {
        p.hazT = 7 + rng() * 6;
        const ang = Math.atan2(s.y - p.y, s.x - p.x) + (rng() - 0.5) * 0.6;
        const sp = 300 + rng() * 150;
        const m = spawnAsteroid(game.bodies,
          p.x + Math.cos(ang) * (p.radius + 30), p.y + Math.sin(ang) * (p.radius + 30),
          p.vx + Math.cos(ang) * sp, p.vy + Math.sin(ang) * sp,
          700 + rng() * 1200);
        m.magma = 7; m.color = '#ff8040';
        game.magmaWarn = true;
      }
    } else if (p.ptype === 'ice') {
      // Cryo-geysers pop free ice chunks into low orbit — shield restock
      p.hazT = (p.hazT ?? 5) - dt;
      if (p.hazT <= 0) {
        p.hazT = 9 + rng() * 6;
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
    }
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
    const a = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, asteroidMass(rng));
    a.local = true;
    railBody(a, game.homeStar);
  }
}
