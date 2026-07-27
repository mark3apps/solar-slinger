import { CFG, PROG, addXp } from './config.js';
import { TAU, rand } from './util.js';
import { sfxCollect } from './sfx.js';

// GLOW POCKETS — sparse clusters of small bioluminescent motes that ride the
// same prograde orbit as the asteroid belt, scattered thin across the whole mid
// system. Motes are SLIGHTLY MAGNETIC: drift near one and it leaps into the ship
// and pops just before the hull touches it, mending a little hull + a little XP.
// Glow pockets are the ONLY place the hull heals mid-life (design law: the hull
// otherwise only resets on respawn).
//
// Pockets never refill in place — you can't camp one. As a pocket is drained it
// vanishes, and the map is topped back up by fading a fresh full pocket in
// ELSEWHERE (never within view of the ship), so the healing supply constantly
// relocates and there's always a next one to fly to.
//
// A pocket is NOT a physics body: it's a cheap point orbiting the sun on a clean
// circular rail (ang += w·dt, w matched to the belt's flow at its radius), with
// motes carried in its CENTER-LOCAL frame (offset lx/ly) so they ride along for
// free. Collection is a plain proximity test like the life pods, so — exactly
// like the cosmetic shoals this file used to hold — it rides dtReal in main.js,
// never the fixed step.

const soft2 = CFG.GRAV_SOFT * CFG.GRAV_SOFT;

// Circular-orbit angular speed at radius r — the exact belt flow (v = sqrt(accel·r),
// w = v/r), so a pocket sweeps the sky alongside the rocks at its radius.
function pocketW(sun, r) {
  const accel = (CFG.G * sun.mass * r) / Math.pow(r * r + soft2, 1.5);
  return Math.sqrt(accel * r) / r;
}

// One mote's center-LOCAL offset + swirl + look. `rnd` is the SEEDED rng at
// world-gen and plain Math.random when a pocket spawns at runtime (runtime
// spawns use Math.random by convention).
export function makeMote(rnd) {
  const or = (0.2 + rnd() * 0.8) * PROG.GLOW_SPREAD;   // distance from center
  const oa = rnd() * TAU;
  return {
    lx: Math.cos(oa) * or, ly: Math.sin(oa) * or,      // offset in the pocket's local frame
    ow: (rnd() - 0.5) * 0.7,                           // slow local swirl (rad/s), until captured
    ph: rnd() * TAU,                                   // pulse phase
    sz: 0.8 + rnd() * 1.1,
    hue: 130 + rnd() * 55,                             // healing green → teal (matches life-pod green)
    captured: false,                                   // once true it commits and vacuums into the ship
    homeV: 0,                                          // current homing speed (ramps up while captured)
  };
}

function buildPocket(sun, r, ang, rnd) {
  const motes = [];
  for (let i = 0; i < PROG.GLOW_MOTES; i++) motes.push(makeMote(rnd));
  return {
    r, ang, w: pocketW(sun, r),
    cx: sun.x + Math.cos(ang) * r,
    cy: sun.y + Math.sin(ang) * r,
    motes,
  };
}

// Seed the starting pockets at world-gen (deterministic off the world rng, so
// they reset WITH the world). The runtime maintainer keeps the count topped up.
export function seedGlowPockets(game, rng) {
  const sun = game.homeStar;
  const pockets = [];
  for (let i = 0; i < PROG.GLOW_POCKETS; i++) {
    pockets.push(buildPocket(sun, rand(rng, PROG.GLOW_RMIN, PROG.GLOW_RMAX), rng() * TAU, rng));
  }
  game.glowPockets = pockets;
}

// A replacement pocket, placed at a fresh random orbit that is NOT within view of
// the ship — so a drained pocket's successor always fades in somewhere new.
function spawnElsewhere(game) {
  const sun = game.homeStar;
  const s = game.ship;
  // Keep the whole FIELD (center + its wide radius) beyond view, so a relocated
  // pocket never materializes on-screen — it always appears somewhere fresh.
  const keep = (game.viewR || 1600) * 1.8 + PROG.GLOW_SPREAD;
  let r, ang, cx, cy, tries = 0;
  do {
    r = PROG.GLOW_RMIN + Math.random() * (PROG.GLOW_RMAX - PROG.GLOW_RMIN);
    ang = Math.random() * TAU;
    cx = sun.x + Math.cos(ang) * r;
    cy = sun.y + Math.sin(ang) * r;
  } while (s && Math.hypot(cx - s.x, cy - s.y) < keep && ++tries < 12);
  game.glowPockets.push(buildPocket(sun, r, ang, Math.random));
}

export function updateGlow(game, dt) {
  const pockets = game.glowPockets;
  if (!pockets || !game.homeStar) return;
  const s = game.ship;
  const sx = game.homeStar.x, sy = game.homeStar.y;
  // Only the pocket the ship is inside needs per-mote work; every other pocket
  // just advances its orbit (O(1)). Same view-local trick the old shoals used.
  const near = (game.viewR || 1600) * 1.6 + PROG.GLOW_SPREAD;
  const near2 = near * near;
  const popR = PROG.GLOW_R + s.radius;   // pop AT the hull (tiny gap), every tier
  const popR2 = popR * popR;
  const magR2 = PROG.GLOW_MAGNET * PROG.GLOW_MAGNET;

  for (let pi = pockets.length - 1; pi >= 0; pi--) {
    const p = pockets[pi];
    p.ang += p.w * dt;
    p.cx = sx + Math.cos(p.ang) * p.r;
    p.cy = sy + Math.sin(p.ang) * p.r;

    const dcx = p.cx - s.x, dcy = p.cy - s.y;
    if (dcx * dcx + dcy * dcy > near2) continue;

    // The ship's position expressed in this pocket's center-local frame, so a
    // mote's (lx,ly) can be compared to it directly.
    const tlx = s.x - p.cx, tly = s.y - p.cy;   // ship in the pocket's local frame
    for (let i = p.motes.length - 1; i >= 0; i--) {
      const m = p.motes[i];
      m.ph += dt * (1.6 + m.sz);
      const dx = tlx - m.lx, dy = tly - m.ly;   // vector from the mote TO the ship
      const d2 = dx * dx + dy * dy;
      if (s.alive && d2 < popR2) {              // reached the hull — pop
        collect(game, p.cx + m.lx, p.cy + m.ly);
        p.motes.splice(i, 1);
        continue;
      }
      // Capture on first touch of the magnet field; once captured a mote is
      // COMMITTED — it vacuums all the way into the hull even if the ship pulls
      // away, so it never stalls halfway. Its speed RAMPS up (MIN→MAX) so it
      // always overtakes the ship and closes the last stretch instead of the old
      // distance-scaled tug that died out near the target.
      if (s.alive && !m.captured && d2 < magR2) { m.captured = true; m.homeV = PROG.GLOW_HOME_MIN; }
      if (m.captured && s.alive) {
        const dist = Math.sqrt(d2) || 1;
        m.homeV = Math.min(PROG.GLOW_HOME_MAX, m.homeV + PROG.GLOW_HOME_ACCEL * dt);
        const step = Math.min(dist, m.homeV * dt);
        m.lx += (dx / dist) * step;
        m.ly += (dy / dist) * step;
      } else {
        // idle swirl about the pocket center until captured (or while ship is dead)
        const c = Math.cos(m.ow * dt), sn = Math.sin(m.ow * dt);
        const nlx = m.lx * c - m.ly * sn, nly = m.lx * sn + m.ly * c;
        m.lx = nlx; m.ly = nly;
      }
    }
    if (p.motes.length === 0) pockets.splice(pi, 1);   // drained → make way for a fresh one
  }

  // Keep the map stocked: drained pockets vanished above; fade fresh ones in
  // ELSEWHERE, never where the ship is standing.
  while (pockets.length < PROG.GLOW_POCKETS) spawnElsewhere(game);
}

function collect(game, mx, my) {
  const s = game.ship;
  s.hull = Math.min(game.st.hullMax, s.hull + PROG.GLOW_HEAL);
  addXp(game, PROG.GLOW_XP);
  if (!game.tut.glow) game.glowMsg = true;   // one-shot first-pocket hint (drained in main.js)
  // Biolum spark pop, drifting with the ship so it reads as "scooped up". Pushed
  // straight onto game.particles (glow.js stays off the physics import to avoid
  // a world↔physics cycle); the shape matches physics.addParticles exactly.
  for (let k = 0; k < 7; k++) {
    const th = Math.random() * TAU, sp = Math.random() * 90;
    game.particles.push({
      x: mx, y: my,
      vx: s.vx * 0.25 + Math.cos(th) * sp, vy: s.vy * 0.25 + Math.sin(th) * sp,
      life: 0.5 * (0.4 + Math.random() * 0.6), maxLife: 0.5,
      size: 2 * (0.5 + Math.random()), color: 'rgba(150, 255, 190, 0.9)',
    });
  }
  sfxCollect();
}
