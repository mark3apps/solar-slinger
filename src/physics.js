import { CFG } from './config.js';
import { makeScrap, scrapValue, massToHp } from './entities.js';
import { spawnAsteroid } from './world.js';
import { computeFlingVelocity } from './tractor.js';
import { TAU, clamp, angDiff } from './util.js';
import * as sfx from './sfx.js';

// ---------- particles / effects ----------

export function addParticles(game, x, y, vx, vy, n, color, speed = 120, life = 0.8, size = 3) {
  for (let i = 0; i < n; i++) {
    const th = Math.random() * TAU;
    const s = Math.random() * speed;
    game.particles.push({
      x, y,
      vx: vx + Math.cos(th) * s, vy: vy + Math.sin(th) * s,
      life: life * (0.4 + Math.random() * 0.6), maxLife: life,
      size: size * (0.5 + Math.random()), color,
    });
  }
  if (game.particles.length > 900) game.particles.splice(0, game.particles.length - 900);
}

export function addShake(game, amt) {
  game.shake = Math.min(30, game.shake + amt);
}

// ---------- destruction ----------

function dropScrap(game, x, y, vx, vy, totalValue) {
  let remaining = Math.round(totalValue);
  const chunk = Math.max(3, Math.round(totalValue / 10));
  let guard = 40;
  while (remaining > 0 && guard-- > 0) {
    const v = Math.min(chunk, remaining);
    remaining -= v;
    const th = Math.random() * TAU;
    const s = 30 + Math.random() * 90;
    game.debris.push(makeScrap(x, y, vx + Math.cos(th) * s, vy + Math.sin(th) * s, v));
  }
}

export function shatter(game, body, credit = null) {
  if (!body.alive) return;
  body.alive = false;
  if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'shattered', type: body.type, mass: Math.round(body.mass) });
  if (body.heldBy === 'player' && game.held === body) game.held = null;

  const isBig = body.mass > 5e4;
  // Big bodies break into grabbable fragments, not just dust
  if (isBig) {
    const n = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + Math.random() * 0.6;
      const s = 40 + Math.random() * 110;
      const m = clamp(body.mass * (0.02 + Math.random() * 0.03), 200, 4000);
      spawnAsteroid(
        game.bodies,
        body.x + Math.cos(th) * body.radius * 0.6,
        body.y + Math.sin(th) * body.radius * 0.6,
        body.vx + Math.cos(th) * s, body.vy + Math.sin(th) * s,
        m,
      );
    }
  }

  dropScrap(game, body.x, body.y, body.vx * 0.4, body.vy * 0.4, scrapValue(body));
  addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3,
    isBig ? 50 : 16, body.color, isBig ? 260 : 140, isBig ? 1.6 : 0.9, isBig ? 5 : 3);
  addShake(game, isBig ? 14 : 4);
  sfx.sfxBoom(isBig ? 3 : 1);

  if (credit === 'player' && body.type !== 'asteroid') {
    game.kills = (game.kills || 0) + 1;
  }
}

// Chip damage: lose hp, shed some mass as scrap, shrink
export function damageBody(game, body, dmg, credit = null) {
  if (body.type === 'star' || !body.alive) return;
  body.hp -= dmg;
  if (body.hp <= 0) { shatter(game, body, credit); return; }
  const frac = clamp(dmg / body.maxHp, 0, 0.5);
  if (frac > 0.01) {
    dropScrap(game, body.x, body.y, body.vx * 0.5, body.vy * 0.5, scrapValue(body) * frac * 0.5);
    body.mass = Math.max(body.baseMass * 0.25, body.mass - body.baseMass * frac * 0.35);
    body.radius = body.baseRadius * Math.cbrt(body.mass / body.baseMass);
    if (body.mass < CFG.ATTRACT_MIN && body.type !== 'star') body.attractor = false;
    addParticles(game, body.x, body.y, body.vx * 0.5, body.vy * 0.5, 8, body.color, 100, 0.7);
  }
}

function vaporize(game, body) {
  if (!body.alive) return;
  body.alive = false;
  if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'vaporized by star', type: body.type, mass: Math.round(body.mass) });
  if (body.heldBy === 'player' && game.held === body) game.held = null;
  addParticles(game, body.x, body.y, 0, 0, 24, '#ffd98a', 220, 1.1, 4);
  sfx.sfxBoom(1.5);
}

export function killAlien(game, alien) {
  if (!alien.alive) return;
  alien.alive = false;
  if (alien.target && alien.target.heldBy === alien) {
    alien.target.heldBy = null;
    alien.target.extAx = 0; alien.target.extAy = 0;
  }
  dropScrap(game, alien.x, alien.y, alien.vx * 0.3, alien.vy * 0.3, CFG.ALIEN_SCRAP);
  addParticles(game, alien.x, alien.y, alien.vx * 0.3, alien.vy * 0.3, 30, '#8aff6a', 200, 1.2, 4);
  addShake(game, 6);
  sfx.sfxBoom(2);
  game.alienKills++;
}

export function damageShip(game, dmg, cause) {
  const s = game.ship;
  if (!s.alive || s.invuln > 0) return;
  s.hull -= dmg;
  game.lastDamage = game.time;
  addShake(game, Math.min(18, dmg * 0.5));
  sfx.sfxHit();
  if (s.hull <= 0) {
    s.alive = false;
    game.held = null;
    game.deathCause = cause;
    addParticles(game, s.x, s.y, s.vx * 0.3, s.vy * 0.3, 60, '#9fd6ff', 280, 1.6, 4);
    sfx.sfxBoom(3);
    addShake(game, 22);
  }
}

// ---------- gravity ----------

// Full acceleration from all attractors at point (x,y) — used for the ship,
// aliens, and debris, which always feel everything.
function gravityAt(attractors, x, y) {
  let ax = 0, ay = 0;
  for (const b of attractors) {
    const dx = b.x - x, dy = b.y - y;
    const d2 = dx * dx + dy * dy + CFG.GRAV_SOFT * CFG.GRAV_SOFT;
    const inv = (CFG.G * b.mass) / (d2 * Math.sqrt(d2));
    ax += dx * inv; ay += dy * inv;
  }
  return { ax, ay };
}

// The star a body is gravitationally anchored to (its own system's sun).
// Planets: parent IS the star. Moons: parent is a planet, grandparent the star.
// Rogues and loose heavies have no parent — they answer to every star fully.
function starAnchor(body) {
  if (!body.parent) return null;
  return body.parent.type === 'star' ? body.parent : body.parent.parent || null;
}

// Hierarchically-weighted acceleration ON a celestial body: full pull from its
// own star and within its parent-child (planet-moon) pair; CROSS_GRAV fraction
// from everything else — INCLUDING other stars. Two hard-won rules live here:
// 1) The weight must be symmetric per pair, or Newton's third law breaks and
//    secularly pumps tight pairs (moons batter their planets to death).
// 2) Neighbor stars must be damped too: at full strength their tides put outer
//    planets beyond the Hill stability limit and they dive into their sun.
function gravityOnBody(attractors, body) {
  const anchor = starAnchor(body);
  let ax = 0, ay = 0;
  for (const b of attractors) {
    if (b === body) continue;
    let w;
    if (b === body.parent || b.parent === body) w = 1;
    else if (b.type === 'star') w = (!anchor || b === anchor) ? 1 : CFG.CROSS_GRAV;
    else w = CFG.CROSS_GRAV;
    const dx = b.x - body.x, dy = b.y - body.y;
    const d2 = dx * dx + dy * dy + CFG.GRAV_SOFT * CFG.GRAV_SOFT;
    const inv = (w * CFG.G * b.mass) / (d2 * Math.sqrt(d2));
    ax += dx * inv; ay += dy * inv;
  }
  return { ax, ay };
}

// Soft boundary: everything beyond WORLD_R gets nudged back toward the center
function boundaryAccel(x, y) {
  const d = Math.hypot(x, y);
  if (d < CFG.WORLD_R) return null;
  const over = (d - CFG.WORLD_R) / 1000;
  const k = 25 * (1 + over * over);
  return { ax: (-x / d) * k, ay: (-y / d) * k };
}

// ---------- collisions ----------

function collideBodies(game, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 0.001;
  const overlap = a.radius + b.radius - d;
  if (overlap <= 0) return;

  // Stars vaporize anything they touch
  if (a.type === 'star' || b.type === 'star') {
    const victim = a.type === 'star' ? b : a;
    if (victim.type !== 'star') vaporize(game, victim);
    return;
  }

  const nx = dx / d, ny = dy / d;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const closing = -(rvx * nx + rvy * ny);

  // In very lopsided collisions the heavy body is immovable — otherwise the
  // constant rain of ambient asteroid bumps random-walks planet orbits.
  const aMoves = a.mass < b.mass * 20;
  const bMoves = b.mass < a.mass * 20;

  // Positional separation (mass-weighted among movers)
  const total = (aMoves ? a.mass : 0) + (bMoves ? b.mass : 0) || 1;
  if (aMoves) { const p = overlap * (bMoves ? b.mass / total : 1); a.x -= nx * p; a.y -= ny * p; }
  if (bMoves) { const p = overlap * (aMoves ? a.mass / total : 1); b.x += nx * p; b.y += ny * p; }

  if (closing > 0) {
    // Impulse with restitution (immovable side treated as infinite mass)
    const e = CFG.RESTITUTION;
    const invA = aMoves ? 1 / a.mass : 0;
    const invB = bMoves ? 1 / b.mass : 0;
    const j = ((1 + e) * closing) / (invA + invB || 1);
    a.vx -= j * invA * nx; a.vy -= j * invA * ny;
    b.vx += j * invB * nx; b.vy += j * invB * ny;

    // Impact damage — each takes damage scaled by the other's mass, but only
    // above the closing-speed threshold (thrown objects hit harder & easier)
    const creditA = b.thrownTimer > 0 ? b.thrownBy : null;
    const creditB = a.thrownTimer > 0 ? a.thrownBy : null;
    const thrown = a.thrownTimer > 0 || b.thrownTimer > 0;
    const eff = Math.max(0, closing - (thrown ? CFG.DMG_THRESH_THROWN : CFG.DMG_THRESH));
    const mult = thrown ? CFG.DMG_THROWN_MULT : 1;
    const dmgToA = CFG.DMG_BODY * eff * eff * b.mass * mult;
    const dmgToB = CFG.DMG_BODY * eff * eff * a.mass * mult;
    // Debug tap: set game.collisionLog = [] from devtools to record impacts
    if (game.collisionLog && (dmgToA > 2 || dmgToB > 2)) {
      game.collisionLog.push({
        t: Math.round(game.time * 10) / 10,
        a: `${a.type}(m${Math.round(a.mass)},hp${Math.round(a.hp)})`,
        b: `${b.type}(m${Math.round(b.mass)},hp${Math.round(b.hp)})`,
        closing: Math.round(closing),
        dmgToA: Math.round(dmgToA * 10) / 10, dmgToB: Math.round(dmgToB * 10) / 10,
      });
    }
    if (dmgToA > 0.5) damageBody(game, a, dmgToA, creditA);
    if (dmgToB > 0.5) damageBody(game, b, dmgToB, creditB);
    if (closing > 60 && (a.mass > 1e4 || b.mass > 1e4)) addShake(game, 3);
  }
}

function collideShipBody(game, s, b) {
  const dx = b.x - s.x, dy = b.y - s.y;
  const d = Math.hypot(dx, dy) || 0.001;
  if (d > s.radius + b.radius) return;

  if (b.type === 'star') { damageShip(game, 99999, 'You flew into a star.'); return; }
  if (b === game.held) return;   // held object can't crush you

  const nx = dx / d, ny = dy / d;
  const rvx = b.vx - s.vx, rvy = b.vy - s.vy;
  const closing = -(rvx * nx + rvy * ny);

  // Push the ship out (bodies barely notice the ship)
  const overlap = s.radius + b.radius - d;
  s.x -= nx * overlap; s.y -= ny * overlap;

  if (closing > 0) {
    // Ship bounces away from the body
    s.vx -= nx * closing * 1.3; s.vy -= ny * closing * 1.3;
    const thrown = b.thrownTimer > 0 && b.thrownBy === 'alien' ? 1.25 : 1;
    const dmg = CFG.DMG_SHIP * closing * Math.min(b.mass, 4e5) * thrown;
    if (dmg > 1.5 && closing > 25) {
      damageShip(game, dmg, b.type === 'rogue' ? 'Flattened by a rogue planet.' :
        thrown > 1 ? 'Hit by an alien-thrown rock.' :
        `Collided with ${b.type === 'asteroid' ? 'an' : 'a'} ${b.type}.`);
    }
  }
}

function collideAlienBody(game, al, b) {
  if (b === al.target) return;   // never collide with its own ammo (incl. during fetch approach)
  const dx = b.x - al.x, dy = b.y - al.y;
  const d = Math.hypot(dx, dy) || 0.001;
  if (d > al.radius + b.radius) return;

  if (b.type === 'star') { killAlien(game, al); return; }

  const nx = dx / d, ny = dy / d;
  const closing = -((b.vx - al.vx) * nx + (b.vy - al.vy) * ny);
  const overlap = al.radius + b.radius - d;
  al.x -= nx * overlap; al.y -= ny * overlap;
  if (closing > 0) {
    al.vx -= nx * closing * 1.2; al.vy -= ny * closing * 1.2;
    const bonus = b.thrownTimer > 0 && b.thrownBy === 'player' ? 2.5 : 1;
    const effA = Math.max(0, closing - 60);   // aliens are squishier than planets
    const dmg = CFG.DMG_BODY * effA * effA * b.mass * bonus * 2;
    if (dmg > 1) {
      al.hp -= dmg;
      addParticles(game, al.x, al.y, 0, 0, 6, '#8aff6a', 100, 0.5);
      if (al.hp <= 0) killAlien(game, al);
    }
  }
}

// ---------- main step ----------

export function step(game, dt) {
  const bodies = game.bodies;
  const attractors = [];
  for (const b of bodies) if (b.alive && b.attractor) attractors.push(b);

  // Phase 1: compute ALL accelerations from a consistent position snapshot.
  // (Integrating each body inside the same loop makes forces asymmetric —
  // later bodies see earlier bodies' updated positions — which violates
  // Newton's third law and pumps energy into tight planet-moon pairs.)
  for (const b of bodies) {
    if (!b.alive || b.type === 'star') continue;
    const weighted = b.type === 'planet' || b.type === 'moon' || b.type === 'rogue';
    const g = weighted ? gravityOnBody(attractors, b) : gravityAt(attractors, b.x, b.y);
    b.ax = g.ax + b.extAx; b.ay = g.ay + b.extAy;
    const bnd = boundaryAccel(b.x, b.y);
    if (bnd) { b.ax += bnd.ax; b.ay += bnd.ay; }
  }

  const s = game.ship;
  let shipAx = 0, shipAy = 0;
  if (s.alive) {
    // Face the mouse
    const aimAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    s.angle += clamp(angDiff(s.angle, aimAng), -CFG.SHIP_TURN * dt, CFG.SHIP_TURN * dt);

    const th = game.st.thrust;
    const c = game.controls;
    let tx = (c.f - c.b) * Math.cos(s.angle) + (c.r - c.l) * -Math.sin(s.angle);
    let ty = (c.f - c.b) * Math.sin(s.angle) + (c.r - c.l) * Math.cos(s.angle);
    const tm = Math.hypot(tx, ty);
    s.thrusting = tm > 0.01;
    if (tm > 1) { tx /= tm; ty /= tm; }

    const g = gravityAt(attractors, s.x, s.y);
    shipAx = g.ax + tx * th; shipAy = g.ay + ty * th;
    const bnd = boundaryAccel(s.x, s.y);
    if (bnd) { shipAx += bnd.ax; shipAy += bnd.ay; }
  }

  for (const al of game.aliens) {
    if (!al.alive) continue;
    const g = gravityAt(attractors, al.x, al.y);
    al.ax = g.ax + al.thrustX; al.ay = g.ay + al.thrustY;
  }

  for (const d of game.debris) {
    const g = gravityAt(attractors, d.x, d.y);
    d.ax = g.ax * 0.4; d.ay = g.ay * 0.4;
    if (s.alive) {
      const dx = s.x - d.x, dy = s.y - d.y;
      const dd = Math.hypot(dx, dy) || 0.001;   // guard: ship exactly on the chunk → NaN poison
      if (dd < CFG.PICKUP_MAGNET) {
        const pull = 900 * (1 - dd / CFG.PICKUP_MAGNET) + 150;
        d.ax += (dx / dd) * pull; d.ay += (dy / dd) * pull;
      }
    }
  }

  // Phase 2: integrate everything (semi-implicit Euler)
  for (const b of bodies) {
    if (!b.alive || b.type === 'star') continue;
    b.vx += b.ax * dt; b.vy += b.ay * dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.rot += b.spin * dt;
    if (b.thrownTimer > 0) b.thrownTimer -= dt; else b.thrownBy = null;
  }

  if (s.alive) {
    s.vx += shipAx * dt; s.vy += shipAy * dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.invuln > 0) s.invuln -= dt;
  }

  for (const al of game.aliens) {
    if (!al.alive) continue;
    al.vx += al.ax * dt; al.vy += al.ay * dt;
    const sp = Math.hypot(al.vx, al.vy);
    if (sp > CFG.ALIEN_SPEED * 1.6) { al.vx *= 0.995; al.vy *= 0.995; }
    al.x += al.vx * dt; al.y += al.vy * dt;
  }

  for (const d of game.debris) {
    d.vx += d.ax * dt; d.vy += d.ay * dt;
    d.x += d.vx * dt; d.y += d.vy * dt;
    d.life -= dt;
  }

  // Collisions: body-body (skip pairs of tiny far-apart rocks via cheap bound)
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b.alive) continue;
      const rr = a.radius + b.radius;
      if (Math.abs(a.x - b.x) > rr || Math.abs(a.y - b.y) > rr) continue;
      collideBodies(game, a, b);
    }
  }

  // Ship & alien collisions with bodies
  for (const b of bodies) {
    if (!b.alive) continue;
    if (s.alive) collideShipBody(game, s, b);
    for (const al of game.aliens) if (al.alive) collideAlienBody(game, al, b);
  }

  // Alien-ship ramming
  for (const al of game.aliens) {
    if (!al.alive || !s.alive) continue;
    const d = Math.hypot(al.x - s.x, al.y - s.y);
    if (d < al.radius + s.radius) {
      const nx = (s.x - al.x) / (d || 1), ny = (s.y - al.y) / (d || 1);
      s.vx += nx * 180; s.vy += ny * 180;
      al.vx -= nx * 180; al.vy -= ny * 180;
      damageShip(game, CFG.ALIEN_CONTACT_DMG, 'Rammed by an alien grabber.');
      al.hp -= 12;
      if (al.hp <= 0) killAlien(game, al);
    }
  }

  // Scrap pickup + expiry
  if (game.debris.length) {
    const keep = [];
    for (const d of game.debris) {
      if (s.alive && Math.hypot(d.x - s.x, d.y - s.y) < s.radius + d.radius + 6) {
        game.scrap += d.value;
        game.collected = (game.collected || 0) + d.value;
        sfx.sfxCollect();
        continue;
      }
      if (d.life > 0 && Math.hypot(d.x, d.y) < CFG.WORLD_R * 1.3) keep.push(d);
    }
    game.debris = keep;
  }

  // Particles
  for (const p of game.particles) {
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.985; p.vy *= 0.985;
    p.life -= dt;
  }
  game.particles = game.particles.filter((p) => p.life > 0);

  // Cull dead / escaped bodies
  game.bodies = bodies.filter((b) =>
    b.alive && (b.type !== 'asteroid' || Math.hypot(b.x, b.y) < CFG.WORLD_R * 1.35));
  game.aliens = game.aliens.filter((a) => a.alive);
}

// ---------- trajectory prediction ----------

// Forward-simulate the attractors plus ghost points for the ship and (if holding)
// the held object as it would fly if flung right now. Returns polyline points.
export function predictPaths(game) {
  const atr = [];
  const src = [];
  for (const b of game.bodies) {
    if (b.alive && b.attractor) {
      src.push(b);
      atr.push({
        x: b.x, y: b.y, vx: b.vx, vy: b.vy, mass: b.mass, radius: b.radius,
        star: b.type === 'star',
        weighted: b.type === 'planet' || b.type === 'moon' || b.type === 'rogue',
        parentIdx: -1, anchorIdx: -1,
      });
    }
  }
  for (let i = 0; i < src.length; i++) {
    if (src[i].parent) atr[i].parentIdx = src.indexOf(src[i].parent);
    const anchor = starAnchor(src[i]);
    if (anchor) atr[i].anchorIdx = src.indexOf(anchor);
  }
  const s = game.ship;
  const ship = s.alive ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, r: s.radius } : null;
  let held = null;
  if (game.held && game.held.alive) {
    const fv = computeFlingVelocity(game, game.held);
    const h = game.held;
    const anchor = starAnchor(h);
    held = {
      x: h.x, y: h.y, vx: fv.vx, vy: fv.vy, r: h.radius,
      weighted: h.type === 'planet' || h.type === 'moon' || h.type === 'rogue',
      parentGhost: h.parent ? atr[src.indexOf(h.parent)] || null : null,
      anchorGhost: anchor ? atr[src.indexOf(anchor)] || null : null,
    };
  }

  const shipPts = [], heldPts = [];
  let shipHit = null, heldHit = null;
  const dt = CFG.PREDICT_DT;
  const soft2 = CFG.GRAV_SOFT * CFG.GRAV_SOFT;

  const accelAt = (x, y) => {
    let ax = 0, ay = 0;
    for (const b of atr) {
      const dx = b.x - x, dy = b.y - y;
      const d2 = dx * dx + dy * dy + soft2;
      const inv = (CFG.G * b.mass) / (d2 * Math.sqrt(d2));
      ax += dx * inv; ay += dy * inv;
    }
    return [ax, ay];
  };

  for (let i = 0; i < CFG.PREDICT_STEPS; i++) {
    // Advance attractors (stars pinned) with the same hierarchical weighting
    // the real sim uses, so predicted planet positions match reality.
    for (let bi = 0; bi < atr.length; bi++) {
      const b = atr[bi];
      if (b.star) continue;
      let ax = 0, ay = 0;
      for (let k = 0; k < atr.length; k++) {
        const o = atr[k];
        if (o === b) continue;
        let w = 1;
        if (b.weighted && b.parentIdx !== k && o.parentIdx !== bi) {
          if (o.star) w = (b.anchorIdx === -1 || b.anchorIdx === k) ? 1 : CFG.CROSS_GRAV;
          else w = CFG.CROSS_GRAV;
        }
        const dx = o.x - b.x, dy = o.y - b.y;
        const d2 = dx * dx + dy * dy + soft2;
        const inv = (w * CFG.G * o.mass) / (d2 * Math.sqrt(d2));
        ax += dx * inv; ay += dy * inv;
      }
      b.vx += ax * dt; b.vy += ay * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
    }

    if (ship && !shipHit) {
      const [ax, ay] = accelAt(ship.x, ship.y);
      ship.vx += ax * dt; ship.vy += ay * dt;
      ship.x += ship.vx * dt; ship.y += ship.vy * dt;
      if (i % 2 === 0) shipPts.push({ x: ship.x, y: ship.y });
      for (const b of atr) {
        if (Math.hypot(b.x - ship.x, b.y - ship.y) < b.radius + ship.r) { shipHit = { x: ship.x, y: ship.y }; break; }
      }
    }
    if (held && !heldHit) {
      let ax, ay;
      if (held.weighted) {
        ax = 0; ay = 0;
        for (const o of atr) {
          let w;
          if (o === held.parentGhost) w = 1;
          else if (o.star) w = (!held.anchorGhost || o === held.anchorGhost) ? 1 : CFG.CROSS_GRAV;
          else w = CFG.CROSS_GRAV;
          const dx = o.x - held.x, dy = o.y - held.y;
          const d2 = dx * dx + dy * dy + soft2;
          const inv = (w * CFG.G * o.mass) / (d2 * Math.sqrt(d2));
          ax += dx * inv; ay += dy * inv;
        }
      } else {
        [ax, ay] = accelAt(held.x, held.y);
      }
      held.vx += ax * dt; held.vy += ay * dt;
      held.x += held.vx * dt; held.y += held.vy * dt;
      if (i % 2 === 0) heldPts.push({ x: held.x, y: held.y });
      for (const b of atr) {
        if (Math.hypot(b.x - held.x, b.y - held.y) < b.radius + held.r) { heldHit = { x: held.x, y: held.y }; break; }
      }
    }
  }
  return { shipPts, heldPts, shipHit, heldHit };
}
