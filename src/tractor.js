import { clamp } from './util.js';
import * as sfx from './sfx.js';

// Where the held object is pulled to: just off the ship's nose
function holdPoint(game, body) {
  const s = game.ship;
  const d = s.radius + body.radius + 46;
  return { x: s.x + Math.cos(s.angle) * d, y: s.y + Math.sin(s.angle) * d };
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
    if (!b.alive || b.type === 'star') continue;
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
