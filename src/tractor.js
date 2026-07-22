import { GROWTH } from './config.js';
import { CFG } from './config.js';
import { derail } from './entities.js';
import { clamp, angDiff, TAU } from './util.js';
import * as sfx from './sfx.js';

// Where the held object is pulled to: offset from the ship toward the cursor
function holdPoint(game, body) {
  const s = game.ship;
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  const d = s.radius + body.radius + 46;
  return { x: s.x + Math.cos(ang) * d, y: s.y + Math.sin(ang) * d };
}

// Lock-on aim assist: ANY entity (rock, moon, planet, rogue, alien) inside the
// (level-scaled) cone and within throw-line reach pulls the throw onto an
// intercept course. UI-wise this is just the throw line shifting slightly.
export function lockOn(game, baseAng, speed) {
  const s = game.ship;
  const maxD = Math.min(2600, speed * CFG.LOCK_T);
  let best = null, bestD = Infinity;
  const consider = (e) => {
    const d = Math.hypot(e.x - s.x, e.y - s.y);
    if (d > maxD) return;
    const ang = Math.atan2(e.y - s.y, e.x - s.x);
    if (Math.abs(angDiff(baseAng, ang)) > game.st.lockCone) return;
    if (d < bestD) { best = e; bestD = d; }
  };
  for (const al of game.aliens) if (al.alive) consider(al);
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'star' || b === game.held || b.heldBy) continue;
    consider(b);
  }
  if (!best) return { ang: baseAng, target: null };
  // Lead the target: aim where it will be when the rock arrives
  const t = bestD / Math.max(120, speed);
  const px = best.x + (best.vx - s.vx) * t;
  const py = best.y + (best.vy - s.vy) * t;
  return { ang: Math.atan2(py - s.y, px - s.x), target: best };
}

// Locked throws briefly steer toward the target after launch — the aliens
// dodge anything purely ballistic, so this is what makes lock-on real.
// Guidance authority grows with level.
function armHoming(game, b) {
  const s = game.ship;
  const baseAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  const { target } = lockOn(game, baseAng, game.st.fling);
  if (target) {
    b.homing = { target, t: 1.3, acc: 340 + 70 * game.st.totalLevel };
  }
}

// Heavier objects fling slower; ship velocity is inherited.
export function computeFlingVelocity(game, body) {
  const s = game.ship;
  const st = game.st;
  const massFactor = clamp(Math.pow(st.capacity / (body.mass * 4), 0.25), 0.3, 1);
  const speed = st.fling * massFactor;
  const baseAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  const { ang } = lockOn(game, baseAng, speed);
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
    if (dCursor > b.radius + st.grabSlack) continue;
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
  derail(best);
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
    b.vx = v.vx; b.vy = v.vy;
    b.thrownBy = 'player';
    b.thrownTimer = 4;
    armHoming(game, b);
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

// Bigger captured rocks ride farther out; orbit level widens the whole ring.
function orbiterRadius(game, b) {
  return game.ship.radius + 40 + 12 * game.st.orbitLvl + b.radius * 2.6;
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

// LMB with nothing under the cursor: take the orbiter nearest your aim back
// into the beam — held and individually throwable again.
export function retrieveFromOrbit(game) {
  if (!game.orbit.length || !game.ship.alive || game.held) return false;
  const s = game.ship;
  const aimAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  let best = 0, bd = Infinity;
  game.orbit.forEach((b, i) => {
    const d = Math.abs(angDiff(Math.atan2(b.y - s.y, b.x - s.x), aimAng));
    if (d < bd) { bd = d; best = i; }
  });
  const b = game.orbit.splice(best, 1)[0];
  b.heldBy = 'player';
  game.held = b;
  sfx.sfxGrab();
  sfx.setBeam(true);
  return true;
}

// VOLLEY: hold RMB for VOLLEY_TIME, then every rock in your orbit launches at
// the cursor in a tight spread (lock-on adjusts the center line).
export function flingAllFromOrbit(game) {
  if (!game.orbit.length || !game.ship.alive) return 0;
  const s = game.ship;
  const st = game.st;
  const baseAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  const { ang } = lockOn(game, baseAng, st.fling);
  const rocks = game.orbit;
  game.orbit = [];
  const n = rocks.length;
  rocks.forEach((b, i) => {
    b.heldBy = null;
    b.extAx = 0; b.extAy = 0;
    const massFactor = clamp(Math.pow(st.capacity / (b.mass * 4), 0.25), 0.3, 1);
    const speed = st.fling * massFactor;
    const a = ang + (i - (n - 1) / 2) * 0.07;
    b.vx = s.vx + Math.cos(a) * speed;
    b.vy = s.vy + Math.sin(a) * speed;
    b.thrownBy = 'player';
    b.thrownTimer = 4;
    armHoming(game, b);
  });
  sfx.sfxFling();
  sfx.sfxBoom(1.5);
  return n;
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
  const n = game.orbit.length;

  // Active interception: ANY loose rock closing on the ship gets met by the
  // nearest shield rock, which breaks formation and lunges. Alien throws are
  // engaged the moment they're closing; neutral rocks only when they're
  // coming in fast enough to matter (belt drift is harmless).
  let threat = null, bestTti = Infinity;
  for (const b of game.bodies) {
    if (!b.alive || b.heldBy) continue;
    if (b.type === 'star' || b.type === 'planet' || b.type === 'rogue' || b.mass > 9000) continue;
    if (b.thrownBy === 'player' && b.thrownTimer > 0) continue;   // our own shots
    const dx = b.x - s.x, dy = b.y - s.y;
    const d = Math.hypot(dx, dy);
    // Tight defense perimeter — the scan reruns every substep, so a threat
    // drifting back out of this radius releases its interceptor immediately
    if (d > 520) continue;
    const rvx = b.vx - s.vx, rvy = b.vy - s.vy;
    const closing = -(rvx * dx + rvy * dy) / (d || 1);
    const alienShot = b.thrownBy === 'alien' && b.thrownTimer > 0;
    if (closing < (alienShot ? 40 : 140)) continue;
    // Neutral rocks must actually be on a collision course, not just fast —
    // otherwise the shield spends all day chasing belt traffic that would miss
    const miss = Math.abs(dx * rvy - dy * rvx) / (Math.hypot(rvx, rvy) || 1);
    if (!alienShot && miss > 130) continue;
    const tti = d / closing;   // engage whatever hits soonest
    if (tti < bestTti) { threat = b; bestTti = tti; }
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
    const Ri = orbiterRadius(game, b) * (1 + 0.13 * Math.sin(game.time * 0.7 + phase));
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
