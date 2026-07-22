import { CFG, GROWTH } from './config.js';
import { makeScrap, scrapValue, massToHp, railBody, derail } from './entities.js';
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

  // Derelict stations break into salvage modules — metallic, triple-scrap
  if (body.type === 'station') {
    for (let i = 0; i < 4; i++) {
      const th = (i / 4) * TAU + Math.random();
      const sp = 60 + Math.random() * 90;
      const frag = spawnAsteroid(game.bodies,
        body.x + Math.cos(th) * body.radius, body.y + Math.sin(th) * body.radius,
        body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp,
        300 + Math.random() * 400);
      frag.color = '#9fb0c2'; frag.junk = true;
    }
  }
  if (body.type === 'nest') game.nestKilled = true;   // main.js announces it

  dropScrap(game, body.x, body.y, body.vx * 0.4, body.vy * 0.4, scrapValue(body));
  addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3,
    isBig ? 50 : 16, body.color, isBig ? 260 : 140, isBig ? 1.6 : 0.9, isBig ? 5 : 3);
  addShake(game, isBig ? 14 : 4);
  sfx.sfxBoom(isBig ? 3 : 1);

  // AUTO-UPGRADE: smashing things (with your own throws) speeds up the fling
  if (credit === 'player') {
    game.prog.fling = Math.min(GROWTH.FLING_MAX, game.prog.fling * (1 + GROWTH.SMASH_RATE * (isBig ? 2 : 1)));
    game.prog.smashes++;
  }
}

// Chip damage: lose hp, shed some mass as scrap, shrink
export function damageBody(game, body, dmg, credit = null) {
  if (body.type === 'star' || !body.alive) return;
  derail(body);
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
  if (dmg >= 1) {   // continuous grinding (Oort cloud) shouldn't spam fx
    addShake(game, Math.min(18, dmg * 0.5));
    sfx.sfxHit();
  }
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
    else if (b.type === 'star') w = (!anchor || b === anchor) ? 1 : CFG.CROSS_STAR;
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
  // Orbiting shield rocks don't grind against each other
  if (a.heldBy === 'orbit' && b.heldBy === 'orbit') return;
  // ...and your own throws (or the rock in your beam) pass through your
  // shield instead of smashing it on the way out. Alien throws still connect.
  const aOwn = (a.thrownBy === 'player' && a.thrownTimer > 0) || a.heldBy === 'player';
  const bOwn = (b.thrownBy === 'player' && b.thrownTimer > 0) || b.heldBy === 'player';
  if ((a.heldBy === 'orbit' && bOwn) || (b.heldBy === 'orbit' && aOwn)) return;
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

  // Shield rocks earn orbit XP by making contact with incoming alien throws
  if (closing > 50 &&
      ((a.heldBy === 'orbit' && b.thrownBy === 'alien' && b.thrownTimer > 0) ||
       (b.heldBy === 'orbit' && a.thrownBy === 'alien' && a.thrownTimer > 0))) {
    game.prog.orbitXp += 3;
  }

  // No surface-hugging: a small body drifting gently onto a much bigger one
  // is absorbed (either you're in orbit, or you're part of the planet now).
  if (closing >= 0 && closing < 70) {
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    if (big.mass >= small.mass * 15 && !small.heldBy && small.type !== 'rogue' &&
        small.type !== 'station' && small.type !== 'nest') {   // artificial structures don't melt into planets
      small.alive = false;
      if (small === game.held) game.held = null;
      if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'absorbed', type: small.type, mass: Math.round(small.mass) });
      dropScrap(game, small.x, small.y, big.vx * 0.6, big.vy * 0.6, scrapValue(small) * 0.3);
      addParticles(game, small.x, small.y, big.vx * 0.5, big.vy * 0.5, 10, small.color, 90, 0.7);
      return;
    }
  }

  // In very lopsided collisions the heavy body is immovable — otherwise the
  // constant rain of ambient asteroid bumps random-walks planet orbits.
  const aMoves = a.mass < b.mass * 20;
  const bMoves = b.mass < a.mass * 20;

  // Positional separation (mass-weighted among movers)
  const total = (aMoves ? a.mass : 0) + (bMoves ? b.mass : 0) || 1;
  if (aMoves) { const p = overlap * (bMoves ? b.mass / total : 1); a.x -= nx * p; a.y -= ny * p; }
  if (bMoves) { const p = overlap * (aMoves ? a.mass / total : 1); b.x += nx * p; b.y += ny * p; }

  if (closing > 0) {
    // A real bounce knocks a body off its rails into live physics
    if (closing > 25) {
      if (aMoves) derail(a);
      if (bMoves) derail(b);
    }
    // Impulse with restitution (immovable side treated as infinite mass).
    // Natural celestial-vs-celestial bounces are damped — a rogue drive-by
    // must shove a planet, not launch it out of orbit into its star. Thrown
    // bodies keep full impulse so planet billiards stay glorious.
    const e = CFG.RESTITUTION;
    const invA = aMoves ? 1 / a.mass : 0;
    const invB = bMoves ? 1 / b.mass : 0;
    let j = ((1 + e) * closing) / (invA + invB || 1);
    const celestial = (t) => t === 'planet' || t === 'moon' || t === 'rogue';
    if (a.thrownTimer <= 0 && b.thrownTimer <= 0 && celestial(a.type) && celestial(b.type)) {
      j *= 0.25;
    }
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
  if (b === game.held) return;      // held object can't crush you
  if (b.heldBy === 'orbit') return; // your own shield can't crush you either
  if (b.thrownBy === 'player' && b.thrownTimer > 0) return; // your own throws pass through you

  const nx = dx / d, ny = dy / d;
  const rvx = b.vx - s.vx, rvy = b.vy - s.vy;
  const closing = -(rvx * nx + rvy * ny);

  // Push the ship out (bodies barely notice the ship)
  const overlap = s.radius + b.radius - d;
  s.x -= nx * overlap; s.y -= ny * overlap;

  if (closing > 0) {
    // Ship bounces away, scaled by the impactor's mass and hard-capped — a
    // flat closing*1.3 kick let alien-thrown rocks launch the ship at 900+.
    const mEff = Math.min(b.mass, 4e5);
    const kick = Math.min(200, closing * 1.35 * (mEff / (mEff + 900)));
    s.vx -= nx * kick; s.vy -= ny * kick;
    const thrown = b.thrownTimer > 0 && b.thrownBy === 'alien' ? 1.25 : 1;
    // A single impact never quite one-shots you from full health
    const dmg = Math.min(CFG.DMG_SHIP * closing * Math.min(b.mass, 4e5) * thrown,
      game.st.maxHull * 0.65);
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
    const mEffA = Math.min(b.mass, 4e5);
    const kickA = Math.min(380, closing * 1.2 * (mEffA / (mEffA + 500)));
    al.vx -= nx * kickA; al.vy -= ny * kickA;
    const playerRock = b.thrownTimer > 0 && b.thrownBy === 'player';
    const bonus = playerRock ? 2.5 : 1;
    const effA = Math.max(0, closing - 60);   // aliens are squishier than planets
    const dmg = CFG.DMG_BODY * effA * effA * b.mass * bonus * 2;
    if (dmg > 1) {
      al.hp -= dmg;
      addParticles(game, al.x, al.y, 0, 0, 6, '#8aff6a', 100, 0.5);
      if (al.hp <= 0) {
        killAlien(game, al);
        if (playerRock) {   // alien kills count as smashes too
          game.prog.fling = Math.min(GROWTH.FLING_MAX, game.prog.fling * (1 + GROWTH.SMASH_RATE));
          game.prog.smashes++;
        }
      }
    }
  }
}

// ---------- main step ----------

export function step(game, dt) {
  const bodies = game.bodies;
  const attractors = [];
  for (const b of bodies) if (b.alive && b.attractor) attractors.push(b);

  // Rails maintenance: heavy wanderers (rogues, thrown giants) wake nearby
  // railed bodies into live physics; long-quiet live bodies snap back onto
  // rails when their orbit is near-circular again.
  game.railScanT = (game.railScanT ?? 0) - dt;
  if (game.railScanT <= 0) {
    game.railScanT = CFG.RAIL_RETRY;
    const disturbers = [];
    for (const b of bodies) {
      if (!b.alive) continue;
      if (b.type === 'rogue' || (b.thrownTimer > 0 && b.mass > 5e4)) disturbers.push(b);
    }
    for (const b of bodies) {
      if (!b.alive) continue;
      if (b.onRails) {
        for (const d of disturbers) {
          if (Math.hypot(d.x - b.x, d.y - b.y) < CFG.RAIL_DISTURB + d.radius) { derail(b); break; }
        }
      } else if (!b.heldBy && b.thrownTimer <= 0 && b.liveT > 6 &&
                 (b.type === 'asteroid' || b.type === 'moon' || b.type === 'planet' ||
                  b.type === 'station' || b.type === 'nest')) {
        // Never re-rail on-screen: a flung rock snapping onto a circular
        // orbit in front of the player reads as "it just stopped mid-flight"
        if (Math.hypot(b.x - game.ship.x, b.y - game.ship.y) <
            (game.viewR || 1200) * 1.15 + 300) continue;
        // Try to re-rail around the natural parent
        const parent = (b.type !== 'asteroid' && b.type !== 'planet' && b.parent && b.parent.alive)
          ? b.parent : game.homeStar;   // moons/stations/nests re-rail around their planet
        let clear = true;
        for (const d of disturbers) {
          if (Math.hypot(d.x - b.x, d.y - b.y) < CFG.RAIL_DISTURB + d.radius) { clear = false; break; }
        }
        if (clear) {
          const dx = b.x - parent.x, dy = b.y - parent.y;
          const r = Math.hypot(dx, dy);
          if (r > parent.radius + b.radius + 60) {
            const vC = Math.sqrt((CFG.G * parent.mass * r * r) / Math.pow(r * r + CFG.GRAV_SOFT ** 2, 1.5));
            // tangential/radial decomposition of current relative velocity
            const rvx = b.vx - parent.vx, rvy = b.vy - parent.vy;
            const vT = (dx * rvy - dy * rvx) / r;
            const vR = (dx * rvx + dy * rvy) / r;
            if (Math.abs(Math.abs(vT) - vC) < vC * CFG.RAIL_TOL && Math.abs(vR) < vC * CFG.RAIL_TOL) {
              b.vx = parent.vx - (dy / r) * Math.sign(vT) * vC;
              b.vy = parent.vy + (dx / r) * Math.sign(vT) * vC;
              railBody(b, parent);
            }
          }
        }
      }
    }
  }

  // Phase 1: compute ALL accelerations from a consistent position snapshot.
  // (Integrating each body inside the same loop makes forces asymmetric —
  // later bodies see earlier bodies' updated positions — which violates
  // Newton's third law and pumps energy into tight planet-moon pairs.)
  // Railed bodies skip gravity entirely — that's the point of rails.
  for (const b of bodies) {
    if (!b.alive || b.type === 'star' || b.onRails) continue;
    const weighted = b.type === 'planet' || b.type === 'moon' || b.type === 'rogue';
    const g = weighted ? gravityOnBody(attractors, b) : gravityAt(attractors, b.x, b.y);
    b.ax = g.ax + b.extAx; b.ay = g.ay + b.extAy;

    // Lock-on guidance: locked player throws briefly steer to intercept
    if (b.homing) {
      const h = b.homing;
      h.t -= dt;
      const tg = h.target;
      if (h.t <= 0 || !tg.alive || b.thrownTimer <= 0) {
        b.homing = null;
      } else {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const d = Math.hypot(tg.x - b.x, tg.y - b.y);
        const tt = d / sp;
        const px = tg.x + tg.vx * tt, py = tg.y + tg.vy * tt;
        const dd = Math.hypot(px - b.x, py - b.y) || 1;
        let hx = ((px - b.x) / dd * sp - b.vx) * 4;
        let hy = ((py - b.y) / dd * sp - b.vy) * 4;
        const hm = Math.hypot(hx, hy);
        if (hm > h.acc) { hx *= h.acc / hm; hy *= h.acc / hm; }
        b.ax += hx; b.ay += hy;
      }
    }
    // Star-anchored bodies are held by their sun, never the map edge — the
    // boundary force would deorbit outer planets of off-center systems.
    if (!(b.parent && (b.type === 'planet' || b.type === 'moon'))) {
      const bnd = boundaryAccel(b.x, b.y);
      if (bnd) { b.ax += bnd.ax; b.ay += bnd.ay; }
    }
  }

  const s = game.ship;
  let shipAx = 0, shipAy = 0;
  if (s.alive) {
    // The nose tracks the mouse; W thrusts forward, S thrusts backward.
    const aimAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    s.angle += clamp(angDiff(s.angle, aimAng), -CFG.SHIP_TURN * dt, CFG.SHIP_TURN * dt);

    const th = game.st.thrust;
    const c = game.controls;
    const throttle = c.f - c.b;
    s.thrusting = throttle > 0;
    s.braking = throttle < 0;
    const tx = Math.cos(s.angle) * th * throttle;
    const ty = Math.sin(s.angle) * th * throttle;

    // AUTO-UPGRADE: spent delta-v grows the engines
    if (throttle !== 0) {
      game.prog.dv += th * dt;
      game.prog.thrust = Math.min(GROWTH.THRUST_MAX,
        GROWTH.THRUST_BASE + GROWTH.THRUST_SCALE * Math.sqrt(game.prog.dv / GROWTH.THRUST_DIV));
    }

    // The ship feels amplified gravity — big bodies really grab at you
    const g = gravityAt(attractors, s.x, s.y);
    shipAx = g.ax * CFG.SHIP_GRAV + tx; shipAy = g.ay * CFG.SHIP_GRAV + ty;
    const bnd = boundaryAccel(s.x, s.y);
    if (bnd) { shipAx += bnd.ax; shipAy += bnd.ay; }

    // CLOUD SKIMMING: a low pass over a gas giant's cloud tops slings you
    // forward — free delta-v if you're brave. Dip too deep and the heat bites.
    game.skimT = Math.max(0, (game.skimT || 0) - dt);
    for (const b of attractors) {
      if (b.ptype !== 'gas' || !b.alive) continue;
      const d = Math.hypot(s.x - b.x, s.y - b.y);
      if (d > b.radius * 1.05 && d < b.radius * 1.5) {
        const depth = 1 - (d - b.radius * 1.05) / (b.radius * 0.45);
        const sp = Math.hypot(s.vx, s.vy) || 1;
        const boost = 260 * depth;
        shipAx += (s.vx / sp) * boost; shipAy += (s.vy / sp) * boost;
        game.skimT = 0.25;
        addParticles(game, s.x - s.vx * 0.04, s.y - s.vy * 0.04, s.vx * 0.5, s.vy * 0.5,
          1, '#ffc276', 60, 0.5, 2.5);
        if (d < b.radius * 1.16) damageShip(game, 9 * dt, 'Burned up in the cloud tops of a gas giant.');
      }
    }

    // The Oort cloud grinds ships apart
    const rc = Math.hypot(s.x, s.y);
    if (rc > CFG.WORLD_R && s.invuln <= 0) {
      const dps = CFG.OORT_DPS * (1 + (rc - CFG.WORLD_R) / 900);
      damageShip(game, dps * dt, 'Shredded by the Oort cloud.');
    }
  }

  for (const al of game.aliens) {
    if (!al.alive) continue;
    const g = gravityAt(attractors, al.x, al.y);
    al.ax = g.ax + al.thrustX; al.ay = g.ay + al.thrustY;
  }

  for (const d of game.debris) {
    const dx = s.x - d.x, dy = s.y - d.y;
    const dd = Math.hypot(dx, dy) || 0.001;   // guard: ship exactly on the chunk → NaN poison
    if (s.alive && dd < CFG.PICKUP_MAGNET) {
      // Spring-steer toward the ship (matching its velocity) rather than pure
      // acceleration — otherwise chunks whip into little orbits around you.
      const t = 1 - dd / CFG.PICKUP_MAGNET;
      const spd = 260 + 700 * t;
      const desVx = (dx / dd) * spd + s.vx, desVy = (dy / dd) * spd + s.vy;
      d.ax = (desVx - d.vx) * 4; d.ay = (desVy - d.vy) * 4;
    } else {
      const g = gravityAt(attractors, d.x, d.y);
      d.ax = g.ax * 0.4; d.ay = g.ay * 0.4;
    }
  }

  // Phase 2: integrate live bodies (semi-implicit Euler)
  for (const b of bodies) {
    if (!b.alive || b.type === 'star') continue;
    b.rot += b.spin * dt;
    if (b.thrownTimer > 0) b.thrownTimer -= dt; else b.thrownBy = null;
    if (b.onRails) continue;
    b.liveT += dt;
    b.vx += b.ax * dt; b.vy += b.ay * dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
  }

  // Rails pass: advance precomputed orbits analytically. Array order puts
  // planets before their moons, so a moon's (possibly live) parent has its
  // final position before the moon reads it.
  for (const b of bodies) {
    if (!b.alive || !b.onRails) continue;
    const rl = b.rail;
    const p = rl.parent;
    if (!p.alive) { derail(b); continue; }
    rl.ang += rl.w * dt;
    const c = Math.cos(rl.ang), sn = Math.sin(rl.ang);
    b.x = p.x + c * rl.r;
    b.y = p.y + sn * rl.r;
    // Keep velocity truthful so collisions and grabs behave normally
    b.vx = p.vx - sn * rl.w * rl.r;
    b.vy = p.vy + c * rl.w * rl.r;
  }

  if (s.alive) {
    s.vx += shipAx * dt; s.vy += shipAy * dt;
    // Speed governor: above this level's ceiling, velocity bleeds back down
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > game.st.maxSpeed) {
      const brake = (sp - game.st.maxSpeed) * 0.8 * dt;
      const f = Math.max(0, (sp - brake) / sp);
      s.vx *= f; s.vy *= f;
    }
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
      if (s.alive && Math.hypot(d.x - s.x, d.y - s.y) < s.radius + d.radius + 8) {
        // AUTO-UPGRADE: scrap heals you and toughens the hull
        game.scrap += d.value;
        game.prog.scrapCollected += d.value;
        game.prog.maxHull = Math.min(GROWTH.HULL_MAX, game.prog.maxHull + d.value * GROWTH.TOUGH_RATE);
        s.hull = Math.min(game.prog.maxHull, s.hull + d.value);
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
        // Railed attractors predict EXACTLY — advance the rail analytically
        railR: b.onRails ? b.rail.r : 0,
        railW: b.onRails ? b.rail.w : 0,
        railAng: b.onRails ? b.rail.ang : 0,
        railParent: b.onRails ? b.rail.parent : null,
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
      if (b.railParent) {
        b.railAng += b.railW * dt;
        b.x = b.railParent.x + Math.cos(b.railAng) * b.railR;
        b.y = b.railParent.y + Math.sin(b.railAng) * b.railR;
        continue;
      }
      let ax = 0, ay = 0;
      for (let k = 0; k < atr.length; k++) {
        const o = atr[k];
        if (o === b) continue;
        let w = 1;
        if (b.weighted && b.parentIdx !== k && o.parentIdx !== bi) {
          if (o.star) w = (b.anchorIdx === -1 || b.anchorIdx === k) ? 1 : CFG.CROSS_STAR;
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
      let [ax, ay] = accelAt(ship.x, ship.y);
      ax *= CFG.SHIP_GRAV; ay *= CFG.SHIP_GRAV;
      ship.vx += ax * dt; ship.vy += ay * dt;
      // Mirror the speed governor so the predicted path stays honest
      const psp = Math.hypot(ship.vx, ship.vy);
      if (psp > game.st.maxSpeed) {
        const f = Math.max(0, (psp - (psp - game.st.maxSpeed) * 0.8 * dt) / psp);
        ship.vx *= f; ship.vy *= f;
      }
      ship.x += ship.vx * dt; ship.y += ship.vy * dt;
      if (i % 2 === 0) shipPts.push({ x: ship.x, y: ship.y });
      for (const b of atr) {
        if (Math.hypot(b.x - ship.x, b.y - ship.y) < b.radius + ship.r) { shipHit = { x: ship.x, y: ship.y }; break; }
      }
    }
    if (held && !heldHit && i < CFG.HELD_STEPS) {
      let ax, ay;
      if (held.weighted) {
        ax = 0; ay = 0;
        for (const o of atr) {
          let w;
          if (o === held.parentGhost) w = 1;
          else if (o.star) w = (!held.anchorGhost || o === held.anchorGhost) ? 1 : CFG.CROSS_STAR;
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
