import { CFG } from './config.js';
import { Alien, derail } from './entities.js';
import { damageShip, damageBody, addParticles } from './physics.js';
import { TAU, clamp } from './util.js';

// Steering: accelerate toward a desired velocity (auto-fights gravity)
function steer(al, tx, ty, speed) {
  const dx = tx - al.x, dy = ty - al.y;
  const d = Math.hypot(dx, dy) || 1;
  const arrive = clamp(d / 300, 0.2, 1);
  const desVx = (dx / d) * speed * arrive;
  const desVy = (dy / d) * speed * arrive;
  al.thrustX = clamp((desVx - al.vx) * 2.2, -CFG.ALIEN_ACCEL, CFG.ALIEN_ACCEL);
  al.thrustY = clamp((desVy - al.vy) * 2.2, -CFG.ALIEN_ACCEL, CFG.ALIEN_ACCEL);
}

// Stay clear of the sun — survival overrides everything. (Tight margin: with
// a giant sun, radius*3 would lock aliens out of the whole inner system.)
function avoidStars(game, al) {
  for (const b of game.bodies) {
    if (b.type !== 'star') continue;
    const dx = al.x - b.x, dy = al.y - b.y;
    const d = Math.hypot(dx, dy);
    if (d < b.radius * 1.6 + 400) {
      al.thrustX += (dx / d) * CFG.ALIEN_ACCEL * 1.6;
      al.thrustY += (dy / d) * CFG.ALIEN_ACCEL * 1.6;
      return true;
    }
  }
  return false;
}

function nearestRock(game, al) {
  let best = null, bestD = Infinity;
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'star') continue;
    if (b.type === 'nest' || b.type === 'station') continue;   // never throw home
    if (b.mass > CFG.ALIEN_CAPACITY) continue;
    if (b.heldBy) continue;
    const d = Math.hypot(b.x - al.x, b.y - al.y);
    if (d < bestD && d < 3200) { best = b; bestD = d; }
  }
  return best;
}

// Wreckwright: descends on a debris field, eats the scrap, and welds a golem
// from it. Defenseless the whole time — killing it refunds its hoard.
function updateWright(game, al, dt) {
  const s = game.ship;
  if (al.state === 'approach') {
    if (!al.anchor) { al.alive = false; return; }
    steer(al, al.anchor.x, al.anchor.y, CFG.ALIEN_SPEED * 0.7);
    if (Math.hypot(al.anchor.x - al.x, al.anchor.y - al.y) < 140) al.state = 'build';
  } else if (al.state === 'build') {
    steer(al, al.x, al.y, 0);           // hold position and work
    al.buildT += dt;
    al.eatT = (al.eatT ?? 0) - dt;
    if (al.eatT <= 0) {
      al.eatT = 0.35;
      let best = null, bd = 1100;       // slurp the nearest chunk in reach
      for (const d of game.debris) {
        const dd = Math.hypot(d.x - al.x, d.y - al.y);
        if (dd < bd) { bd = dd; best = d; }
      }
      if (best) {
        al.hoard += best.value;
        best.life = 0;
        addParticles(game, best.x, best.y, (al.x - best.x) * 2, (al.y - best.y) * 2, 3, '#ffd25a', 60, 0.4);
      }
    }
    if (al.buildT > 8) {
      const gol = new Alien(al.x, al.y, 'golem');
      gol.hoard = Math.round(al.hoard * 0.8);   // the golem IS the scrap
      game.aliens.push(gol);
      game.golemWarn = true;
      al.hoard = 0;
      al.state = 'flee';
    }
  } else {   // flee: job done, leave the sector
    const away = s.alive ? Math.atan2(al.y - s.y, al.x - s.x) : 0;
    steer(al, al.x + Math.cos(away) * 600, al.y + Math.sin(away) * 600, CFG.ALIEN_SPEED);
    if (!s.alive || Math.hypot(al.x - s.x, al.y - s.y) > 6000) al.alive = false;
  }
  avoidStars(game, al);
}

function updateAlien(game, al, dt) {
  const s = game.ship;
  al.wobble += dt * 3;
  al.thrustX = 0; al.thrustY = 0;
  const distShip = s.alive ? Math.hypot(s.x - al.x, s.y - al.y) : Infinity;
  al.angle = s.alive ? Math.atan2(s.y - al.y, s.x - al.x) : al.angle;

  // Non-grabber kinds have their own simple minds
  if (al.kind === 'wright') { updateWright(game, al, dt); return; }
  if (al.kind === 'golem') {
    // Relentless: your leftovers hunt you until one of you is gone
    if (s.alive) steer(al, s.x + s.vx * 0.3, s.y + s.vy * 0.3, CFG.ALIEN_SPEED * 0.85);
    avoidStars(game, al);
    return;
  }

  // TERRITORIAL: an alien belongs to its nest and never abandons that turf.
  // If it has strayed past the territory, or the player has fled the nest's
  // region, it drops everything and returns home to patrol until the player
  // comes back. (A destroyed nest leaves orphans that hunt freely 'til dead.)
  const home = (al.nest && al.nest.alive) ? al.nest : null;
  const homeDist = home ? Math.hypot(home.x - al.x, home.y - al.y) : 0;
  const playerHome = home
    ? (s.alive && Math.hypot(s.x - home.x, s.y - home.y) < CFG.ALIEN_TERRITORY)
    : true;
  if (home && (homeDist > CFG.ALIEN_TERRITORY || !playerHome)) {
    if (al.target && al.target.heldBy === al) {
      al.target.heldBy = null; al.target.extAx = 0; al.target.extAy = 0;
    }
    al.target = null;
    if (homeDist > 700) {
      steer(al, home.x, home.y, CFG.ALIEN_SPEED);        // race back to the nest
    } else {                                             // patrol the nest yard
      const around = Math.atan2(al.y - home.y, al.x - home.x) + 0.7;
      steer(al, home.x + Math.cos(around) * 480, home.y + Math.sin(around) * 480,
        CFG.ALIEN_SPEED * 0.55);
    }
    al.state = 'seek';   // ready to re-engage the instant the player returns
    avoidStars(game, al);
    return;
  }

  switch (al.state) {
    case 'seek': {
      // Drift toward the player, then look for ammo
      steer(al, s.x, s.y, CFG.ALIEN_SPEED * 0.8);
      if (distShip < 2600) {
        const rock = nearestRock(game, al);
        if (rock) { al.target = rock; al.state = 'fetch'; }
        else if (distShip < 500) al.state = 'harass';
      }
      break;
    }
    case 'fetch': {
      const r = al.target;
      if (!r || !r.alive || r.heldBy) { al.target = null; al.state = 'seek'; break; }
      al.fetchT = (al.fetchT || 0) + dt;
      if (al.fetchT > 7) {   // uncatchable (deep in a well etc.) — pick another rock
        al.fetchT = 0; al.target = null; al.state = 'seek'; break;
      }
      // Intercept lead: aim ahead of the moving rock
      steer(al, r.x + r.vx * 0.4, r.y + r.vy * 0.4, CFG.ALIEN_SPEED);
      if (Math.hypot(r.x - al.x, r.y - al.y) < al.radius + r.radius + 55) {
        r.heldBy = al;
        derail(r);
        al.fetchT = 0;
        al.state = 'carry';
      }
      break;
    }
    case 'carry': {
      const r = al.target;
      if (!r || !r.alive || r.heldBy !== al) { al.target = null; al.state = 'seek'; break; }
      if (!s.alive) { r.heldBy = null; al.target = null; al.state = 'seek'; break; }

      // Haul the rock along at a fixed offset (simplified alien tractor)
      const hx = al.x + Math.cos(al.angle) * (al.radius + r.radius + 26);
      const hy = al.y + Math.sin(al.angle) * (al.radius + r.radius + 26);
      const desVx = (hx - r.x) * 8 + al.vx, desVy = (hy - r.y) * 8 + al.vy;
      const cap = 60000 / r.mass + 40;
      let ax = (desVx - r.vx) * 5, ay = (desVy - r.vy) * 5;
      const am = Math.hypot(ax, ay);
      if (am > cap) { ax *= cap / am; ay *= cap / am; }
      r.extAx = ax; r.extAy = ay;

      // Close to throwing range, lead the target, and throw
      steer(al, s.x, s.y, CFG.ALIEN_SPEED);
      if (distShip < 950) {
        const t = distShip / CFG.ALIEN_THROW;
        const px = s.x + s.vx * t, py = s.y + s.vy * t;
        const ang = Math.atan2(py - r.y, px - r.x);
        r.heldBy = null; r.extAx = 0; r.extAy = 0;
        r.vx = al.vx + Math.cos(ang) * CFG.ALIEN_THROW;
        r.vy = al.vy + Math.sin(ang) * CFG.ALIEN_THROW;
        r.thrownBy = 'alien';
        r.thrownTimer = 5;
        al.target = null;
        al.state = 'cooldown';
        al.cool = 2.5 + Math.random() * 2;
      }
      break;
    }
    case 'harass': {
      // No ammo around: dive at the player
      steer(al, s.x + s.vx * 0.4, s.y + s.vy * 0.4, CFG.ALIEN_SPEED * 1.2);
      if (Math.random() < dt * 0.3) al.state = 'seek';
      break;
    }
    case 'cooldown': {
      // Strafe away sideways while the next plan forms
      al.cool -= dt;
      const away = Math.atan2(al.y - s.y, al.x - s.x) + 0.9;
      steer(al, al.x + Math.cos(away) * 400, al.y + Math.sin(away) * 400, CFG.ALIEN_SPEED * 0.9);
      if (al.cool <= 0) al.state = 'seek';
      break;
    }
  }
  avoidStars(game, al);
}

// BASTION fortresses: shield upkeep, turret fire, and bolt flight/impacts
function updateForts(game, dt) {
  const s = game.ship;
  for (const b of game.bodies) {
    if (!b.alive || !b.fort) continue;
    const f = b.fort;
    if (f.hitT > 0) f.hitT -= dt;
    f.quiet = (f.quiet ?? 0) + dt;
    // The shield only regenerates while turrets survive to project it
    if (f.quiet > 8 && f.shield < f.maxShield && f.turrets.length) {
      f.shield = Math.min(f.maxShield, f.shield + 6 * dt);
    }
    if (!s.alive) continue;
    const d = Math.hypot(s.x - b.x, s.y - b.y);
    if (d > 1900) continue;
    for (const t of f.turrets) {
      t.cool -= dt;
      if (t.cool > 0) continue;
      t.cool = 2 + Math.random() * 0.9;
      const wx = b.x + Math.cos(b.rot + t.ang) * b.radius;
      const wy = b.y + Math.sin(b.rot + t.ang) * b.radius;
      const tt = d / 620;
      const ang = Math.atan2(s.y + s.vy * tt - wy, s.x + s.vx * tt - wx);
      game.bolts.push({
        x: wx, y: wy,
        vx: Math.cos(ang) * 620 + b.vx, vy: Math.sin(ang) * 620 + b.vy,
        life: 3.2,
      });
    }
  }
  if (game.bolts.length) {
    const keep = [];
    for (const bo of game.bolts) {
      bo.x += bo.vx * dt; bo.y += bo.vy * dt;
      bo.life -= dt;
      let dead = bo.life <= 0;
      if (!dead && s.alive && Math.hypot(bo.x - s.x, bo.y - s.y) < s.radius + 6) {
        damageShip(game, 9, 'Shot down by a Bastion turret.');
        dead = true;
      }
      if (!dead) {
        // Any rock blocks a bolt — your orbit shield is real cover here
        for (const b of game.bodies) {
          if (!b.alive || b.fort) continue;
          if (Math.abs(b.x - bo.x) > b.radius + 6) continue;
          if (Math.hypot(b.x - bo.x, b.y - bo.y) < b.radius + 6) {
            damageBody(game, b, 5);
            dead = true;
            break;
          }
        }
      }
      if (!dead) keep.push(bo);
    }
    game.bolts = keep;
  }
}

export function updateAliens(game, dt) {
  for (const al of game.aliens) if (al.alive) updateAlien(game, al, dt);
  updateForts(game, dt);

  // WRECKWRIGHTS lurk beyond your battles and descend on rich debris fields.
  // Collect your scrap or lose it to a golem.
  game.wrightTimer = (game.wrightTimer ?? 40) - dt;
  if (game.wrightTimer <= 0) {
    game.wrightTimer = 25;
    const s2 = game.ship;
    const wrightAlive = game.aliens.some((a) => a.alive && a.kind === 'wright');
    const golems = game.aliens.reduce((n, a) => n + (a.alive && a.kind === 'golem' ? 1 : 0), 0);
    if (game.time > 90 && s2.alive && !wrightAlive && golems < 2) {
      let best = null;
      for (const d of game.debris) {
        if (Math.hypot(d.x - s2.x, d.y - s2.y) > 7000) continue;
        if (!best || d.value > best.value) best = d;
      }
      if (best) {
        let field = 0;
        for (const d of game.debris) {
          if (Math.hypot(d.x - best.x, d.y - best.y) < 1200) field += d.value;
        }
        if (field >= 60) {
          const th = Math.random() * TAU;
          const w = new Alien(s2.x + Math.cos(th) * 3800, s2.y + Math.sin(th) * 3800, 'wright');
          w.anchor = { x: best.x, y: best.y };
          game.aliens.push(w);
          game.wrightWarn = true;
        }
      }
    }
  }

  // NESTS are the alien homeland: each living nest sustains a local patrol
  // while the player is in its region. No nest nearby = peaceful space, and
  // destroying a nest silences its territory for good.
  if (game.time < CFG.ALIEN_FIRST_WAVE) return;
  game.alienTimer -= dt;
  if (game.alienTimer > 0) return;
  game.alienTimer = 12;   // seconds between eruptions

  const s = game.ship;
  if (!s.alive) return;
  // A nest holds a garrison scaling gently with level, and scrambles a whole
  // burst (up to ALIEN_BURST) at once when the player enters its territory.
  const cap = CFG.ALIEN_BURST + Math.min(3, Math.floor(game.st.totalLevel / 5));
  for (const nest of game.bodies) {
    if (!nest.alive || nest.type !== 'nest') continue;
    if (Math.hypot(nest.x - s.x, nest.y - s.y) > 5500) continue;
    const local = game.aliens.reduce((n, a) => n + (a.alive && a.nest === nest ? 1 : 0), 0);
    const burst = Math.min(CFG.ALIEN_BURST, cap - local);
    if (burst <= 0) continue;
    for (let i = 0; i < burst; i++) {
      const th = Math.random() * TAU;
      const r = 200 + Math.random() * 140;
      const al = new Alien(nest.x + Math.cos(th) * r, nest.y + Math.sin(th) * r);
      al.nest = nest;
      game.aliens.push(al);
    }
    game.alienWarn = 3;
    break;   // one nest erupts per cycle
  }
}
