import { CFG } from './config.js';
import { Body, railBody } from './entities.js';
import { TAU, mulberry32, rand, pick } from './util.js';

const PLANET_COLORS = ['#c98a5a', '#5a9dc9', '#b05ac9', '#6ac95a', '#c9b45a', '#d97b6c', '#7bd9c9', '#9a8ad9'];
const PLANET_NAMES = ['Khepri', 'Vantor', 'Ossia', 'Brune', 'Calyx', 'Nerev', 'Tantal', 'Ymir', 'Quorra', 'Pell', 'Sable', 'Ison'];

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

// How far out this planet can hold a moon against the sun's tide. Rails make
// even the outer edge safe, so the zone is wider than raw Hill stability.
function moonZone(star, planet, orbitR) {
  const hill = orbitR * Math.cbrt(planet.mass / (3 * star.mass));
  return { minR: planet.radius + 90, maxR: hill * 0.5 };
}

function addPlanet(bodies, rng, star, orbitR, mass, radius, opts = {}) {
  const th = rng() * TAU;
  const x = star.x + Math.cos(th) * orbitR;
  const y = star.y + Math.sin(th) * orbitR;
  const dir = rng() < 0.85 ? 1 : -1;
  const v = orbitVel(star, x, y, dir);
  const p = new Body({
    type: 'planet', x, y, vx: v.vx, vy: v.vy, mass, radius,
    color: pick(rng, PLANET_COLORS),
    name: pick(rng, PLANET_NAMES),
    ring: opts.ring || false,
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

function asteroidRadius(mass) { return 3 + Math.cbrt(mass) * 0.9; }

// Skewed small, occasionally chunky
function asteroidMass(rng) { return 60 + Math.pow(rng(), 2.2) * 2540; }

export function spawnAsteroid(bodies, x, y, vx, vy, mass) {
  const a = new Body({
    type: 'asteroid', x, y, vx, vy, mass,
    radius: asteroidRadius(mass),
    color: '#8d8577',
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
    type: 'star', x: 0, y: 0, mass: 8e6, radius: 1500, color: '#ffd98a',
  });
  bodies.push(sun);

  const layout = [
    { r: 2400,  mass: 2e4,   radius: 55 },
    { r: 3300,  mass: 3e4,   radius: 70 },
    { r: 4200,  mass: 5e4,   radius: 95,  moons: 1 },
    { r: 5200,  belt: true, spread: 400, count: 60 },
    { r: 6600,  mass: 1e5,   radius: 150, moons: 3 },
    { r: 8800,  mass: 3e5,   radius: 300, ring: true, moons: 6 },
    { r: 10800, mass: 1.2e5, radius: 160, moons: 2 },
    { r: 11900, belt: true, spread: 450, count: 50 },
    { r: 13600, mass: 2.5e5, radius: 260, ring: true, moons: 5 },
    { r: 16800, mass: 6e4,   radius: 110, moons: 3 },
  ];
  for (const item of layout) {
    if (item.belt) addBelt(bodies, rng, sun, item.r, item.spread, item.count);
    else addPlanet(bodies, rng, sun, item.r, item.mass, item.radius, item);
  }

  // Free-floating asteroids — the space between orbits shouldn't feel empty
  for (let i = 0; i < 120; i++) {
    const th = rng() * TAU;
    const r = rand(rng, 3600, CFG.WORLD_R * 0.94);
    const v = orbitVel(sun, Math.cos(th) * r, Math.sin(th) * r, rng() < 0.9 ? 1 : -1);
    const a = spawnAsteroid(bodies, Math.cos(th) * r, Math.sin(th) * r, v.vx, v.vy, asteroidMass(rng));
    railBody(a, sun);
  }

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
  const sr = 5200;
  const sv = Math.sqrt((CFG.G * CFG.SHIP_GRAV * sun.mass) / sr);
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

  // Asteroids near the player — faster refill when the field is depleted
  game.asteroidTimer -= dt;
  if (game.asteroidTimer > 0) return;
  game.asteroidTimer = 3;
  const count = game.bodies.reduce((n, b) => n + (b.alive && b.type === 'asteroid' ? 1 : 0), 0);
  if (count >= 170) return;
  const spawnN = count < 110 ? 3 : 1;
  for (let i = 0; i < spawnN; i++) {
    const th = rng() * TAU;
    const d = 2400 + rng() * 1400;
    const x = game.ship.x + Math.cos(th) * d;
    const y = game.ship.y + Math.sin(th) * d;
    const fromSun = Math.hypot(x - game.homeStar.x, y - game.homeStar.y);
    if (Math.hypot(x, y) > CFG.WORLD_R || fromSun < game.homeStar.radius + 900) continue;
    const v = orbitVel(game.homeStar, x, y, 1);
    const a = spawnAsteroid(game.bodies, x, y, v.vx, v.vy, asteroidMass(rng));
    railBody(a, game.homeStar);
  }
}
