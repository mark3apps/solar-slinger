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

// AIM ASSIST, inverted: the rock ALWAYS flies exactly at the cursor — the
// game never adjusts your angle. Instead it solves, for every entity in
// throw reach, WHERE you'd have to release for the straight-line paths to
// collide (|R + Vt| = speed*t, ship-relative), and hands those lead points
// to the UI as ✕ markers. The player's job is to let go on the ✕, not on
// the target. A solution whose angle the cursor currently satisfies (within
// the real angular width of the target) is "hot" — that release will hit.
export function aimSolutions(game) {
  const s = game.ship;
  const st = game.st;
  const held = game.held;
  const speed = held
    ? st.fling * clamp(Math.pow(st.capacity / (held.mass * 4), 0.25), 0.3, 1)
    : st.fling;
  const heldR = held ? held.radius : 6;
  // CRITICAL FRAME CHOICE: the rock launches from ITS OWN position (the hold
  // point, ~70 out from the ship, plus any spring lag) — not from the ship.
  // Solving from the ship puts the ✕ on a parallel-offset line and the shot
  // misses by the full offset. Origin = the actual launch point.
  const o = held || s;
  const cursorAng = Math.atan2(game.aim.y - o.y, game.aim.x - o.x);
  const reach = Math.min(2600, speed * CFG.LOCK_T);
  const sols = [];
  let hot = null;
  const consider = (e) => {
    const rx = e.x - o.x, ry = e.y - o.y;
    if (Math.hypot(rx, ry) > reach + 400) return;
    const vx = e.vx - s.vx, vy = e.vy - s.vy;
    const a = vx * vx + vy * vy - speed * speed;
    const bq = 2 * (rx * vx + ry * vy);
    const c = rx * rx + ry * ry;
    let t = 0;
    if (Math.abs(a) > 1e-6) {
      const disc = bq * bq - 4 * a * c;
      if (disc < 0) return;                       // target outruns the throw
      const sq = Math.sqrt(disc);
      const ts = [(-bq - sq) / (2 * a), (-bq + sq) / (2 * a)].filter((x) => x > 0.02);
      if (!ts.length) return;
      t = Math.min(...ts);
    } else if (bq < -1e-6) {
      t = -c / bq;
    } else return;
    if (t > CFG.LOCK_T * 1.4) return;             // meets beyond the throw line
    // Lead point: where the cursor must sit for this angle (launch frame,
    // so it stays correct even while the ship itself is moving)
    const mx = o.x + rx + vx * t, my = o.y + ry + vy * t;
    const ang = Math.atan2(ry + vy * t, rx + vx * t);
    const tol = Math.max(0.004, (e.radius + heldR * 0.8) / (speed * t));
    const sol = {
      target: e, t, mx, my,
      onLine: Math.abs(angDiff(cursorAng, ang)) <= tol,
      cursorD: Math.hypot(mx - game.aim.x, my - game.aim.y),
    };
    sols.push(sol);
    if (sol.onLine && (!hot || t < hot.t)) hot = sol;
  };
  for (const al of game.aliens) if (al.alive) consider(al);
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'star' || b === held || b.heldBy) continue;
    consider(b);
  }
  sols.sort((x, y) => x.cursorD - y.cursorD);
  return { sols: sols.slice(0, 6), hot };
}

// Heavier objects fling slower; ship velocity is inherited. The rock flies
// from ITS OWN position straight through the cursor point — matching the
// frame aimSolutions solves in, so releasing on a ✕ really connects. (If
// the cursor sits basically on the rock, fall back to the ship-nose angle.)
export function computeFlingVelocity(game, body) {
  const s = game.ship;
  const st = game.st;
  const massFactor = clamp(Math.pow(st.capacity / (body.mass * 4), 0.25), 0.3, 1);
  const speed = st.fling * massFactor;
  const dx = game.aim.x - body.x, dy = game.aim.y - body.y;
  const ang = Math.hypot(dx, dy) > 25
    ? Math.atan2(dy, dx)
    : Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
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

// Ring assignment for the whole formation: orbiters are sorted by size and
// packed outward — smallest hugging the ship, largest patrolling the far
// edge. Each ring clears the previous rock's bulk, so a full orbit of mixed
// sizes stacks out to roughly 3x the old single-ring distance.
function orbiterRings(game) {
  const rings = new Map();
  const base = game.ship.radius + 40 + 12 * game.st.orbitLvl;
  let R = base;
  const sorted = [...game.orbit].sort((a, b) => a.radius - b.radius);
  for (const b of sorted) {
    R += b.radius * 1.6 + 14;
    rings.set(b, Math.min(R, base + 400));   // soft cap keeps the far edge sane
    R += b.radius;
  }
  return rings;
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
  // The tractor capture spins the rock up — captured bodies visibly whirl
  // (ambient spin is a sleepy ±0.3 rad/s)
  b.spin = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.4);
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
  b.orbitAng = undefined;
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
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);   // straight at the cursor
  const rocks = game.orbit;
  game.orbit = [];
  const n = rocks.length;
  rocks.forEach((b, i) => {
    b.heldBy = null;
    b.orbitAng = undefined;
    b.extAx = 0; b.extAy = 0;
    const massFactor = clamp(Math.pow(st.capacity / (b.mass * 4), 0.25), 0.3, 1);
    const speed = st.fling * massFactor;
    const a = ang + (i - (n - 1) / 2) * 0.07;
    b.vx = s.vx + Math.cos(a) * speed;
    b.vy = s.vy + Math.sin(a) * speed;
    b.thrownBy = 'player';
    b.thrownTimer = 4;
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
      b.orbitAng = undefined;
      return false;
    });
  }
  if (!game.orbit.length) return;

  const n = game.orbit.length;
  const rings = orbiterRings(game);

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
    // Best blocker = the orbiter already nearest the threat's incoming LINE
    // (not nearest the rock itself) — with only a small allowed shift, a
    // defender on the wrong side of the formation can never reach the path.
    let bd = Infinity;
    const tvm = Math.hypot(threat.vx - s.vx, threat.vy - s.vy) || 1;
    const ux = (threat.vx - s.vx) / tvm, uy = (threat.vy - s.vy) / tvm;
    for (let i = 0; i < n; i++) {
      const px = game.orbit[i].x - threat.x, py = game.orbit[i].y - threat.y;
      const ahead = px * ux + py * uy > 0;
      const d = ahead ? Math.abs(px * uy - py * ux) : Math.hypot(px, py);
      if (d < bd) { bd = d; interceptorIdx = i; }
    }
  }

  for (let i = 0; i < n; i++) {
    const b = game.orbit[i];
    // Loose, organic slots: each rock breathes in and out and drifts around
    // its nominal position instead of sitting pinned on a rail.
    const phase = b.id * 1.73;
    const Ri = rings.get(b) * (1 + 0.13 * Math.sin(game.time * 0.7 + phase));
    // Each ring spins at its own rate so the SLOT's linear speed stays
    // constant — a shared angular speed makes outer slots move faster than
    // the approach cap and big rocks can never catch them.
    const w = CFG.ORBIT_OMEGA * Math.min(1, 80 / Ri);
    b.orbitAng = (b.orbitAng ?? Math.atan2(b.y - s.y, b.x - s.x)) + w * dt;
    const ang = b.orbitAng + 0.25 * Math.sin(game.time * 0.5 + phase * 2.1);
    let tx = s.x + Math.cos(ang) * Ri;
    let ty = s.y + Math.sin(ang) * Ri;
    if (i === interceptorIdx) {
      // BLOCK, don't chase: the defender only shifts a bounded distance
      // from its own slot toward the threat's incoming line — a shield
      // wall bracing, not a hunter leaving formation.
      const lx = threat.x + threat.vx * 0.12 - tx;
      const ly = threat.y + threat.vy * 0.12 - ty;
      const lm = Math.hypot(lx, ly) || 1;
      const lim = Math.min(lm, 80 + 25 * game.st.orbitLvl);
      tx += (lx / lm) * lim;
      ty += (ly / lm) * lim;
    }
    // Cap the approach speed — an uncapped spring slings new orbiters through
    // the belt at 1000+ u/s and they shatter on bystanders before settling.
    // Interceptors are allowed to move much faster.
    const intercepting = i === interceptorIdx;
    const maxApproach = intercepting ? 600 : 380;
    let dvx = (tx - b.x) * 4.5, dvy = (ty - b.y) * 4.5;
    const dm = Math.hypot(dvx, dvy);
    if (dm > maxApproach) { dvx *= maxApproach / dm; dvy *= maxApproach / dm; }
    const desVx = dvx + s.vx, desVy = dvy + s.vy;
    let ax = (desVx - b.vx) * (intercepting ? 10 : 3.5), ay = (desVy - b.vy) * (intercepting ? 10 : 3.5);
    // Holding a circle takes real centripetal authority (v²/R) on top of
    // formation-keeping — the floor must cover it or heavy rocks lag into
    // a trailing pursuit circle far inside their assigned ring.
    const cap = intercepting ? 1600
      : Math.min(900, Math.max(260, (game.st.force * 1.5) / b.mass));
    const am = Math.hypot(ax, ay);
    if (am > cap) { ax *= cap / am; ay *= cap / am; }
    b.extAx = ax; b.extAy = ay;
  }
}
