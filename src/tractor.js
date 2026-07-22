import { GROWTH } from './config.js';
import { CFG } from './config.js';
import { clamp, angDiff, TAU } from './util.js';
import * as sfx from './sfx.js';

// Where the held object is pulled to: offset from the ship toward the cursor
function holdPoint(game, body) {
  const s = game.ship;
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  const d = s.radius + body.radius + 46;
  return { x: s.x + Math.cos(ang) * d, y: s.y + Math.sin(ang) * d };
}

// Heavier objects fling slower; ship velocity is inherited.
export function computeFlingVelocity(game, body) {
  const s = game.ship;
  const st = game.st;
  const massFactor = clamp(Math.pow(st.capacity / (body.mass * 4), 0.25), 0.3, 1);
  const speed = st.fling * massFactor;
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  return { vx: s.vx + Math.cos(ang) * speed, vy: s.vy + Math.sin(ang) * speed };
}

export function tryGrab(game) {
  if (!game.ship.alive || game.held) return false;
  const s = game.ship;
  const st = game.st;
  let best = null, bestD = Infinity;
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'star' || b.heldBy === 'orbit') continue;
    const dCursor = Math.hypot(b.x - game.aim.x, b.y - game.aim.y);
    const dShip = Math.hypot(b.x - s.x, b.y - s.y);
    if (dCursor > b.radius + 70) continue;
    if (dShip > st.range + b.radius) continue;
    if (dCursor < bestD) { best = b; bestD = dCursor; }
  }
  if (!best) return false;
  if (best.mass > st.capacity) {
    game.tooHeavy = best;          // HUD shows "too heavy" feedback
    game.tooHeavyT = 1.2;
    sfx.sfxDenied();
    return false;
  }
  if (best.heldBy && best.heldBy !== 'player') {
    // Steal it from an alien
    const al = best.heldBy;
    if (al.target === best) { al.target = null; al.state = 'cooldown'; al.cool = 2; }
  }
  best.heldBy = 'player';
  game.held = best;

  // AUTO-UPGRADE: every catch strengthens the beam. Heavy catches (relative to
  // current capacity) grow it fastest; re-catching the same rock pays less
  // each time so you can't farm one pebble forever.
  const w = clamp(best.mass / game.prog.capacity, 0.1, 1) / (1 + 0.6 * best.catchCount);
  game.prog.capacity = Math.min(GROWTH.CAPACITY_MAX, game.prog.capacity * (1 + GROWTH.CATCH_RATE * w));
  game.prog.catches++;
  best.catchCount++;

  sfx.sfxGrab();
  sfx.setBeam(true);
  return true;
}

export function releaseHeld(game, fling) {
  const b = game.held;
  if (!b) return;
  game.held = null;
  b.heldBy = null;
  b.extAx = 0; b.extAy = 0;
  sfx.setBeam(false);
  if (!b.alive) return;
  if (fling) {
    const v = computeFlingVelocity(game, b);
    const dvx = v.vx - b.vx, dvy = v.vy - b.vy;
    b.vx = v.vx; b.vy = v.vy;
    b.thrownBy = 'player';
    b.thrownTimer = 4;
    // Recoil: flinging a planet shoves you backwards
    const s = game.ship;
    const k = (b.mass / (b.mass + 4000)) * 0.8;
    let rx = -dvx * k, ry = -dvy * k;
    const rm = Math.hypot(rx, ry);
    if (rm > 300) { rx *= 300 / rm; ry *= 300 / rm; }
    s.vx += rx; s.vy += ry;
    sfx.sfxFling();
  } else {
    sfx.sfxDrop();
  }
}

// Spring-damper pull toward the hold point; runs every physics substep.
export function updateTractor(game, dt) {
  const b = game.held;
  if (!b) return;
  const s = game.ship;
  const st = game.st;

  if (!b.alive || !s.alive) { releaseHeld(game, false); return; }

  const d = Math.hypot(b.x - s.x, b.y - s.y);
  if (d > st.range * 1.6 + b.radius) { releaseHeld(game, false); return; }

  const hp = holdPoint(game, b);
  const relX = hp.x - b.x, relY = hp.y - b.y;
  const desVx = relX * 7 + s.vx, desVy = relY * 7 + s.vy;
  let ax = (desVx - b.vx) * 5, ay = (desVy - b.vy) * 5;
  const cap = st.force / b.mass;
  const am = Math.hypot(ax, ay);
  if (am > cap) { ax *= cap / am; ay *= cap / am; }
  b.extAx = ax; b.extAy = ay;

  // Equal-and-opposite tug on the ship (capped so it stays flyable)
  const fx = ax * b.mass, fy = ay * b.mass;
  let sax = -fx / 2500, say = -fy / 2500;
  const sm = Math.hypot(sax, say);
  if (sm > 150) { sax *= 150 / sm; say *= 150 / sm; }
  s.vx += sax * dt; s.vy += say * dt;
}

// ---------- orbit shield ----------

export function orbitRadius(game) {
  let maxR = 10;
  for (const b of game.orbit) maxR = Math.max(maxR, b.radius);
  return game.ship.radius + 55 + maxR + 12 * game.st.orbitLvl;
}

// Move the held object into your defensive orbit (if it's small enough).
export function addToOrbit(game) {
  const b = game.held;
  const st = game.st;
  if (!b || !b.alive) return false;
  if (st.orbitCap <= 0 || b.mass > st.orbitCap || game.orbit.length >= st.maxOrbiters) return false;
  game.held = null;
  b.heldBy = 'orbit';
  b.thrownBy = null; b.thrownTimer = 0;
  game.orbit.push(b);
  game.prog.orbitXp += 1;   // AUTO-UPGRADE: using the orbit grows the orbit
  sfx.setBeam(false);
  sfx.sfxCollect();
  return true;
}

// Fling the orbiter closest to the aim direction at the cursor.
export function flingFromOrbit(game) {
  if (!game.orbit.length || !game.ship.alive) return false;
  const s = game.ship;
  const aimAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  const n = game.orbit.length;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const b = game.orbit[i];
    const ang = Math.atan2(b.y - s.y, b.x - s.x);
    const d = Math.abs(angDiff(ang, aimAng));
    if (d < bestD) { bestD = d; best = i; }
  }
  const b = game.orbit.splice(best, 1)[0];
  b.heldBy = null;
  b.extAx = 0; b.extAy = 0;
  const v = computeFlingVelocity(game, b);
  b.vx = v.vx; b.vy = v.vy;
  b.thrownBy = 'player';
  b.thrownTimer = 4;
  sfx.sfxFling();
  return true;
}

// Spring each orbiter to its rotating slot; runs every physics substep.
export function updateOrbit(game, dt) {
  const s = game.ship;
  // Drop dead/stolen orbiters; release everything if the ship dies
  if (game.orbit.length) {
    game.orbit = game.orbit.filter((b) => {
      if (b.alive && b.heldBy === 'orbit' && s.alive) return true;
      if (b.heldBy === 'orbit') { b.heldBy = null; b.extAx = 0; b.extAy = 0; }
      return false;
    });
  }
  if (!game.orbit.length) return;

  game.orbitAngle += CFG.ORBIT_OMEGA * dt;
  const R = orbitRadius(game);
  const n = game.orbit.length;

  // Active interception: hostile thrown rocks closing on the ship get met by
  // the nearest shield rock, which breaks formation and lunges. The block
  // usually costs the orbiter — ammo doubling as armor.
  let threat = null, threatD = Infinity;
  for (const b of game.bodies) {
    if (b.thrownBy !== 'alien' || b.thrownTimer <= 0 || !b.alive) continue;
    const dx = b.x - s.x, dy = b.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d > 900) continue;   // spot threats basically at launch
    if ((b.vx - s.vx) * dx + (b.vy - s.vy) * dy >= 0) continue;   // not closing
    if (d < threatD) { threat = b; threatD = d; }
  }
  let interceptorIdx = -1;
  if (threat) {
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(game.orbit[i].x - threat.x, game.orbit[i].y - threat.y);
      if (d < bd) { bd = d; interceptorIdx = i; }
    }
  }

  for (let i = 0; i < n; i++) {
    const b = game.orbit[i];
    // Loose, organic slots: each rock breathes in and out and drifts around
    // its nominal position instead of sitting pinned on a rail.
    const phase = b.id * 1.73;
    const Ri = R * (1 + 0.13 * Math.sin(game.time * 0.7 + phase));
    const ang = game.orbitAngle + (i / n) * TAU + 0.25 * Math.sin(game.time * 0.5 + phase * 2.1);
    let tx = s.x + Math.cos(ang) * Ri;
    let ty = s.y + Math.sin(ang) * Ri;
    if (i === interceptorIdx) {   // lunge at the incoming rock (slight lead)
      tx = threat.x + threat.vx * 0.12;
      ty = threat.y + threat.vy * 0.12;
    }
    // Cap the approach speed — an uncapped spring slings new orbiters through
    // the belt at 1000+ u/s and they shatter on bystanders before settling.
    // Interceptors are allowed to move much faster.
    const intercepting = i === interceptorIdx;
    const maxApproach = intercepting ? 950 : 380;
    let dvx = (tx - b.x) * 4.5, dvy = (ty - b.y) * 4.5;
    const dm = Math.hypot(dvx, dvy);
    if (dm > maxApproach) { dvx *= maxApproach / dm; dvy *= maxApproach / dm; }
    const desVx = dvx + s.vx, desVy = dvy + s.vy;
    let ax = (desVx - b.vx) * (intercepting ? 10 : 3.5), ay = (desVy - b.vy) * (intercepting ? 10 : 3.5);
    const cap = intercepting ? 2400
      : Math.min(900, Math.max(120, (game.st.force * 1.5) / b.mass));
    const am = Math.hypot(ax, ay);
    if (am > cap) { ax *= cap / am; ay *= cap / am; }
    b.extAx = ax; b.extAy = ay;
  }
}
