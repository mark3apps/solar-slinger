import { CFG } from './config.js';
import { Body } from './entities.js';
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

  for (let i = 0; i < (opts.moons || 0); i++) {
    const mr = radius + 65 + i * 55 + rand(rng, 0, 25);
    const mth = rng() * TAU;
    const mx = x + Math.cos(mth) * mr;
    const my = y + Math.sin(mth) * mr;
    const mv = orbitVel(p, mx, my, 1);
    bodies.push(new Body({
      type: 'moon', x: mx, y: my, vx: mv.vx, vy: mv.vy,
      mass: rand(rng, 2200, 5200), radius: rand(rng, 10, 14),
      color: '#a8a8b8', parent: p,
    }));
  }
  return p;
}

function asteroidRadius(mass) { return 4 + Math.cbrt(mass) / 2; }

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
    spawnAsteroid(
      bodies, x, y,
      v.vx + rand(rng, -8, 8), v.vy + rand(rng, -8, 8),
      rand(rng, 180, 850),
    );
  }
}

function addSystem(bodies, rng, cx, cy, starMass, starRadius, starColor, layout) {
  const star = new Body({
    type: 'star', x: cx, y: cy, mass: starMass, radius: starRadius, color: starColor,
  });
  bodies.push(star);
  for (const item of layout) {
    if (item.belt) addBelt(bodies, rng, star, item.r, item.spread, item.count);
    else addPlanet(bodies, rng, star, item.r, item.mass, item.radius, item);
  }
  return star;
}

export function generateWorld(game, seed = 20260721) {
  const rng = mulberry32(seed);
  const bodies = game.bodies;

  // Home system — center of the map
  const home = addSystem(bodies, rng, 0, 0, 5e6, 170, '#ffd98a', [
    { r: 900,  mass: 2.5e4, radius: 26 },
    { r: 1500, mass: 5e4,   radius: 34, moons: 1 },
    { r: 2100, belt: true, spread: 170, count: 30 },
    { r: 2900, mass: 8e4,   radius: 44, moons: 1 },
    { r: 4300, mass: 2e5,   radius: 72, ring: true, moons: 2 },
    { r: 5600, mass: 6e4,   radius: 38 },
  ]);

  // Binary neighbor — smaller, denser
  addSystem(bodies, rng, 9500, -6500, 3.5e6, 145, '#8ab8ff', [
    { r: 800,  mass: 3e4,   radius: 30 },
    { r: 1500, belt: true, spread: 140, count: 20 },
    { r: 2400, mass: 1.6e5, radius: 62, moons: 2, ring: true },
    { r: 3400, mass: 4e4,   radius: 32 },
  ]);

  // Red giant system — big and dangerous
  addSystem(bodies, rng, -9000, 7000, 6e6, 210, '#ff9a6a', [
    { r: 1100, mass: 3e4,   radius: 28 },
    { r: 1900, mass: 1e5,   radius: 52, moons: 1 },
    { r: 2700, belt: true, spread: 200, count: 26 },
    { r: 4000, mass: 2.2e5, radius: 78, ring: true, moons: 1 },
  ]);

  // Free-floating asteroids between systems
  for (let i = 0; i < 36; i++) {
    const th = rng() * TAU;
    const r = rand(rng, 4000, CFG.WORLD_R * 0.9);
    spawnAsteroid(
      bodies,
      Math.cos(th) * r, Math.sin(th) * r,
      rand(rng, -22, 22), rand(rng, -22, 22),
      rand(rng, 180, 900),
    );
  }

  // Rogue planets — wanderers that stir up (but can't shred) the systems
  const rogues = [
    { mass: 2.5e5, radius: 62 },
    { mass: 3.5e5, radius: 74 },
    { mass: 4.5e5, radius: 86 },
  ];
  for (const rg of rogues) {
    const th = rng() * TAU;
    const d = CFG.WORLD_R * 0.95;
    const aimTh = th + Math.PI + rand(rng, -0.5, 0.5);
    const sp = rand(rng, 18, 34);
    bodies.push(new Body({
      type: 'rogue',
      x: Math.cos(th) * d, y: Math.sin(th) * d,
      vx: Math.cos(aimTh) * sp, vy: Math.sin(aimTh) * sp,
      mass: rg.mass, radius: rg.radius,
      color: '#7a4ad9',
      name: 'Rogue',
    }));
  }

  // Player starts in a stable orbit inside the home asteroid belt
  const sr = 2100;
  const sv = Math.sqrt((CFG.G * home.mass) / sr);
  game.spawn = { x: home.x, y: home.y - sr, vx: sv, vy: 0 };
  game.homeStar = home;
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

// Keep loose asteroids topped up so the player always has ammo nearby.
export function replenishAsteroids(game, dt) {
  game.asteroidTimer -= dt;
  if (game.asteroidTimer > 0) return;
  game.asteroidTimer = 6;
  const count = game.bodies.reduce((n, b) => n + (b.alive && b.type === 'asteroid' ? 1 : 0), 0);
  if (count >= 55) return;
  const th = Math.random() * TAU;
  const d = 2400 + Math.random() * 1200;
  const x = game.ship.x + Math.cos(th) * d;
  const y = game.ship.y + Math.sin(th) * d;
  if (Math.hypot(x, y) > CFG.WORLD_R) return;
  spawnAsteroid(
    game.bodies, x, y,
    (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40,
    180 + Math.random() * 700,
  );
}
