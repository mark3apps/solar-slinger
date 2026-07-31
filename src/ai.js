import { CFG, fieldFrac } from './config.js';
import { Alien, derail } from './entities.js';
import { damageShip, damageBody, addParticles } from './physics.js';
import { bump } from './achievements.js';
import * as sfx from './sfx.js';
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
  let best = null, bestD2 = 3200 * 3200;
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'star') continue;
    if (b.type === 'nest' || b.type === 'station') continue;   // never throw home
    if (b.mass > CFG.ALIEN_CAPACITY) continue;
    if (b.heldBy) continue;
    const d2 = (b.x - al.x) ** 2 + (b.y - al.y) ** 2;
    if (d2 < bestD2) { best = b; bestD2 = d2; }
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

// SHOAL LURKER: the dense fields' ambush predator (spawned by updateFields).
// Hit-and-run in three beats — STALK weaves toward you through the rocks,
// POUNCE is a full-speed slash pass at your lead point, SLIP curls away into
// the field before it comes around again. The physics ram loop does the
// actual damage (al.contactDmg) and costs the lurker hp per pass, so a
// lurker naturally dies after ~3 slashes even if you never swing back.
function updateLurker(game, al, dt) {
  const s = game.ship;
  const f = game.fields && game.fields[al.field];
  if (!f) { al.alive = false; return; }
  // Containment is the POCKET FOOTPRINT (config.fieldFrac), not a circle: a
  // circle wide enough to cover the lane's long axis overshot its short axis
  // by 2x, and lurkers visibly hunted open space outside their own rocks.
  // The engage bound (1.15) sits above the chase bound (1.3 on the LURKER)
  // deliberately UNDER-hysteresized the other way round: the ship slipping
  // just past the edge doesn't instantly break the hunt, but a lurker can
  // never be dragged more than a fringe past its own rocks before it turns.
  const engaged = s.alive && !game.dustCloak && fieldFrac(f, s.x, s.y) < 1.15;
  // Lose the ship (it left the shoal, died, or slipped into a dust shroud) or
  // stray past the fringe yourself, and slink home to prowl the rocks until
  // the player comes back in.
  if (!engaged || fieldFrac(f, al.x, al.y) > 1.3) {
    const homeDist = Math.hypot(f.x - al.x, f.y - al.y);
    if (homeDist > 500) {
      steer(al, f.x, f.y, CFG.ALIEN_SPEED);
    } else {   // prowl the shoal — a slow circuit among the rocks
      const around = Math.atan2(al.y - f.y, al.x - f.x) + 0.8;
      steer(al, f.x + Math.cos(around) * 380, f.y + Math.sin(around) * 380,
        CFG.ALIEN_SPEED * 0.45);
    }
    al.state = 'stalk';   // re-engage the instant the player returns
    avoidStars(game, al);
    return;
  }
  const sp = CFG.ALIEN_SPEED * CFG.LURKER_SPEED;
  const dist = Math.hypot(s.x - al.x, s.y - al.y);
  if (al.shovedT > 0) al.shovedT -= dt;
  switch (al.state) {
    case 'stalk': {
      // Line up a rock to body-check at the player. Failing that (nothing
      // catchable nearby), close the distance with a sideways sine weave —
      // it reads skittery, slipping between the rocks, not a grabber's
      // beeline — and fall back to a direct slash pass.
      // It only sets up a body-check from CLOSE IN (CFG.LURKER_SHOVE_R): a
      // rock punted from across the pocket never reads as aimed and wastes
      // the charge. Further out it closes the distance first.
      const rock = (al.shovedT > 0 || dist > CFG.LURKER_SHOVE_R)
        ? null : pickShoveRock(game, al, s);
      if (rock) { al.target = rock; al.state = 'line'; al.fetchT = 0; break; }
      const wob = Math.sin(game.time * 5 + al.wobble);
      steer(al, s.x - Math.sin(al.angle) * wob * 220,
        s.y + Math.cos(al.angle) * wob * 220, sp * 0.85);
      if (dist < 400) { al.state = 'pounce'; al.cool = 1.1; }
      break;
    }
    case 'line': {
      // Swing around to the far side of the rock — the staging point on the
      // line from the player THROUGH the rock — so the charge that follows
      // sends it at the ship. This arc behind the rock is the tell that
      // reads as "it's setting something up", and the window to move.
      const r = al.target;
      if (!r || !r.alive || r.heldBy) { al.target = null; al.state = 'stalk'; break; }
      al.fetchT = (al.fetchT || 0) + dt;
      // Give up on a rock that isn't coming together and re-pick: chasing one
      // bad angle for long is what made the body-check feel rare.
      if (al.fetchT > 3.5) { al.target = null; al.state = 'stalk'; break; }
      const rdx = r.x - s.x, rdy = r.y - s.y;
      const rd = Math.hypot(rdx, rdy) || 1;
      const stage = r.radius + al.radius + 70;
      const sx = r.x + (rdx / rd) * stage, sy = r.y + (rdy / rd) * stage;
      steer(al, sx, sy, sp);
      if (Math.hypot(sx - al.x, sy - al.y) < 95) { al.state = 'charge'; al.cool = 1.6; }
      break;
    }
    case 'charge': {
      // Straight through the rock at the ship. The shove itself happens in
      // physics.collideAlienBody (which sets shovedT); this just drives.
      const r = al.target;
      al.cool -= dt;
      if (!r || !r.alive || r.heldBy || al.shovedT > 0 || al.cool <= 0) {
        al.target = null;
        al.state = 'slip'; al.cool = 0.9;
        al.slipDir = Math.random() < 0.5 ? -1 : 1;
        break;
      }
      // Aim PAST the rock along the rock->ship line, so it drives through
      // the contact instead of parking on the surface
      const adx = s.x - r.x, ady = s.y - r.y;
      const ad = Math.hypot(adx, ady) || 1;
      steer(al, r.x + (adx / ad) * 90, r.y + (ady / ad) * 90, sp * 1.4);
      break;
    }
    case 'pounce': {   // no rock to hand: the old slash pass, straight at you
      al.cool -= dt;
      const t = dist / (sp * 1.4);
      steer(al, s.x + s.vx * t, s.y + s.vy * t, sp * 1.4);
      if (al.cool <= 0) {
        al.state = 'slip'; al.cool = 1.3;
        al.slipDir = Math.random() < 0.5 ? -1 : 1;
      }
      break;
    }
    case 'slip': {     // break off through the rocks before coming around
      al.cool -= dt;
      const away = Math.atan2(al.y - s.y, al.x - s.x) + al.slipDir * 0.7;
      steer(al, al.x + Math.cos(away) * 500, al.y + Math.sin(away) * 500, sp);
      if (al.cool <= 0) al.state = 'stalk';
      break;
    }
    default: al.state = 'stalk';
  }
  avoidStars(game, al);
}

// A rock the lurker can actually body-check AT the player: loose, light
// enough to move, close to hand, and already roughly between it and the ship
// (score favours a small swing-around, so it commits to shots that look
// aimed rather than dragging one across the whole pocket). Deliberately NOT
// the grabber's nearestRock — that one ignores geometry because a beam can
// carry ammo anywhere; a shove only works along the line it charges.
function pickShoveRock(game, al, s) {
  const sdx = s.x - al.x, sdy = s.y - al.y;
  const sd = Math.hypot(sdx, sdy) || 1;
  const ux = sdx / sd, uy = sdy / sd;
  let best = null, bestScore = 0;
  for (const b of game.bodies) {
    if (!b.alive || b.type !== 'asteroid' || b.heldBy) continue;
    if (b.mass > CFG.LURKER_SHOVE_MASS || b.majorComet || b.pod) continue;   // muscle, not a beam
    const dx = b.x - al.x, dy = b.y - al.y;
    const d = Math.hypot(dx, dy);
    if (d < 60 || d > 700) continue;
    // How well the rock sits on the line toward the ship (1 = dead ahead)
    const align = (dx * ux + dy * uy) / (d || 1);
    if (align < 0.3) continue;
    const score = align * (1 - d / 700);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

function updateAlien(game, al, dt) {
  const s = game.ship;
  al.wobble += dt * 3;
  al.thrustX = 0; al.thrustY = 0;
  const distShip = s.alive ? Math.hypot(s.x - al.x, s.y - al.y) : Infinity;
  al.angle = s.alive ? Math.atan2(s.y - al.y, s.x - al.x) : al.angle;

  // Non-grabber kinds have their own simple minds
  if (al.kind === 'lurker') { updateLurker(game, al, dt); return; }
  if (al.kind === 'wright') { updateWright(game, al, dt); return; }
  if (al.kind === 'golem') {
    // Relentless: your leftovers hunt you until one of you is gone. DUST
    // SHROUD: a cloaked ship breaks the track — it prowls the last place it
    // saw you, slower, instead of tracking through the dust.
    if (s.alive && !game.dustCloak) {
      al.lastSeenX = s.x; al.lastSeenY = s.y;
      steer(al, s.x + s.vx * 0.3, s.y + s.vy * 0.3, CFG.ALIEN_SPEED * 0.85);
    } else if (s.alive && al.lastSeenX !== undefined) {
      steer(al, al.lastSeenX, al.lastSeenY, CFG.ALIEN_SPEED * 0.45);
    }
    avoidStars(game, al);
    return;
  }

  // TERRITORIAL: an alien belongs to its nest and never abandons that turf.
  // If it has strayed past the territory, or the player has fled the nest's
  // region, it drops everything and returns home to patrol until the player
  // comes back. (A destroyed nest leaves orphans that hunt freely 'til dead.)
  const home = (al.nest && al.nest.alive) ? al.nest : null;
  const homeDist = home ? Math.hypot(home.x - al.x, home.y - al.y) : 0;
  // DUST SHROUD: a cloaked ship reads as "player left the territory" — the
  // return-home branch below is the battle-tested lose-lock path (drops the
  // carried rock, resets state), so disengagement reuses it wholesale.
  const playerHome = home
    ? (s.alive && !game.dustCloak &&
       Math.hypot(s.x - home.x, s.y - home.y) < CFG.ALIEN_TERRITORY)
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

  // ORPHAN grabbers (nest destroyed) never take the home branch above — route
  // a cloaked player straight to the cooldown strafe, or they'd deadlock
  // chasing a target they can't see.
  if (game.dustCloak && al.state !== 'cooldown') {
    if (al.target && al.target.heldBy === al) {
      al.target.heldBy = null; al.target.extAx = 0; al.target.extAy = 0;
    }
    al.target = null;
    al.state = 'cooldown';
    al.cool = 1.5;
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

      // Close to throwing range, lead the target, and throw. (No throw while
      // the player is dust-cloaked — you can't lead a target you can't see.)
      steer(al, s.x, s.y, CFG.ALIEN_SPEED);
      if (distShip < 950 && !game.dustCloak) {
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

// DENSE-FIELD anchors + SHOAL LURKER broods. The anchor tracks the field's
// heart rock EXACTLY while it rides its rail (splash frames advance rails but
// not this function, so deriving from the rail is what keeps the anchor glued
// to the visible rocks across the title screen); a stolen or destroyed heart
// hands off to the anchor's own clock at the same shared w. Each field holds
// a FINITE brood (CFG.FIELD_BROOD): entering the shoal springs ambushes —
// a lurker "detaches" from a nearby field rock — until the budget is spent,
// and once the last of the brood dies the field is quiet for the rest of the
// run (the nest rule: consequence traces to a player choice; no respawner).
function updateFields(game, dt) {
  if (!game.fields) return;
  const s = game.ship;
  for (let fi = 0; fi < game.fields.length; fi++) {
    const f = game.fields[fi];
    const h = f.heart;
    if (h && h.alive && h.onRails) f.ang = h.rail.ang;
    else f.ang += f.w * dt;
    const hs = game.homeStar;
    f.x = hs.x + Math.cos(f.ang) * f.r;
    f.y = hs.y + Math.sin(f.ang) * f.r;
    if (f.wakeT > 0) f.wakeT -= dt;
    if (f.brood <= 0) {
      // Brood spent: the field goes QUIET the moment the last lurker dies
      if (!f.cleared &&
          !game.aliens.some((a) => a.alive && a.kind === 'lurker' && a.field === fi)) {
        f.cleared = true;
        bump(game, 'fieldClear');
        game.fieldClearWarn = f.name;
      }
      continue;
    }
    if (!s.alive || game.dustCloak || f.wakeT > 0) continue;
    // Ambushes spring only when the ship is actually IN the rocks — the
    // pocket footprint, not a circle around the anchor (config.fieldFrac).
    if (fieldFrac(f, s.x, s.y) > 1.02) continue;
    let awake = 0;
    for (const a of game.aliens) if (a.alive && a.kind === 'lurker' && a.field === fi) awake++;
    if (awake >= CFG.FIELD_HUNTERS) continue;   // only so many hunting at once
    // Gap between ambushes. It has to stay well under the time it takes a
    // lurker to die, or a bigger brood never actually fields its hunter cap —
    // the shoal just trickles one at a time however many are left.
    f.wakeT = 4 + Math.random() * 3;
    f.brood--;
    // The ambush: it was one of the rocks — spawn at a field rock near the
    // player (close enough to menace, far enough to see coming).
    let spot = null, bd = Infinity;
    for (const b of game.bodies) {
      if (!b.alive || b.field !== fi || b.heldBy) continue;
      const d = Math.hypot(b.x - s.x, b.y - s.y);
      if (d > 280 && d < 1000 && d < bd) { bd = d; spot = b; }
    }
    const th = Math.random() * TAU;
    const x = spot ? spot.x + Math.cos(th) * (spot.radius + 8) : s.x + Math.cos(th) * 600;
    const y = spot ? spot.y + Math.sin(th) * (spot.radius + 8) : s.y + Math.sin(th) * 600;
    const al = new Alien(x, y, 'lurker');
    al.field = fi;
    if (spot) { al.vx = spot.vx; al.vy = spot.vy; }
    game.aliens.push(al);
    addParticles(game, x, y, 0, 0, 10, '#8d8577', 90, 0.6);
    game.lurkerWarn = true;
  }
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
      f.shield = Math.min(f.maxShield, f.shield + 5 * dt);
      if (f.shield > 0) f.shieldDownSaid = false;
    }
    if (!s.alive) continue;
    const d = Math.hypot(s.x - b.x, s.y - b.y);
    if (d > 1300) continue;
    for (const t of f.turrets) {
      t.cool -= dt;
      if (t.fireT > 0) t.fireT -= dt;
      if (t.cool > 0) continue;
      // BARRAGE RHYTHM: a short angry burst at true gatling rate, then a
      // long pause to cycle — slow shells make the stream a wall you weave
      // through, and the breaks are your window to strike.
      if ((t.burst ?? 0) <= 0) {
        t.burst = 4 + Math.floor(Math.random() * 3);
        t.cool = 3.5 + Math.random() * 1.5;
        continue;
      }
      t.burst--;
      t.cool = 0.13;
      t.fireT = 0.1;
      const wx = b.x + Math.cos(b.rot + t.ang) * b.radius;
      const wy = b.y + Math.sin(b.rot + t.ang) * b.radius;
      const tt = d / 260;
      const ang = Math.atan2(s.y + s.vy * tt - wy, s.x + s.vx * tt - wx);
      game.bolts.push({
        x: wx, y: wy,
        vx: Math.cos(ang) * 260 + b.vx, vy: Math.sin(ang) * 260 + b.vy,
        life: 5.5,
      });
      sfx.sfxBolt(sfx.distVol(game, wx, wy));
    }
  }
  if (game.bolts.length) {
    const keep = [];
    for (const bo of game.bolts) {
      bo.x += bo.vx * dt; bo.y += bo.vy * dt;
      bo.life -= dt;
      let dead = bo.life <= 0;
      const sr = s.radius + 6;
      if (!dead && s.alive && (bo.x - s.x) ** 2 + (bo.y - s.y) ** 2 < sr * sr) {
        damageShip(game, 10, 'Shot down by a Bastion gatling battery.',
          Math.atan2(bo.y - s.y, bo.x - s.x));
        dead = true;
      }
      if (!dead) {
        // Any rock blocks a bolt — your orbit shield is real cover here
        for (const b of game.bodies) {
          if (!b.alive || b.fort) continue;
          const br = b.radius + 6;
          if (Math.abs(b.x - bo.x) > br) continue;
          if ((b.x - bo.x) ** 2 + (b.y - bo.y) ** 2 < br * br) {
            damageBody(game, b, 5, null, bo.x, bo.y);
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
  // DUST SHROUD: inside a dust moon's halo (CFG.DUST_HALO x radius) the ship
  // is invisible to alien senses. Computed ONCE per frame — every gate below
  // reads game.dustCloak — with a 1.2s release grace so hovering the halo's
  // edge can't strobe the AI between engage and disengage. Forts are exempt
  // on purpose: they're artillery emplacements, not hunters (and no dust moon
  // is ever fortified — world.js keeps them out of the fortify pass).
  {
    const s = game.ship;
    let inHalo = false, inShroud = false;
    if (s.alive) {
      for (const b of game.bodies) {
        if (!b.alive) continue;
        const dust = b.type === 'moon' && b.moonType === 'dust';
        // SHROUD PLANETS conceal the same way — same game.dustCloak flag, so
        // every AI gate below works unchanged. Fortified shrouds don't cloak:
        // a fort is an artillery emplacement, and a permanently cloaked siege
        // would be a free win.
        const shroud = b.type === 'planet' && b.ptype === 'shroud' && !b.fort;
        if (!dust && !shroud) continue;
        const halo = b.radius * (dust ? CFG.DUST_HALO : CFG.SHROUD_HALO);
        if (Math.hypot(b.x - s.x, b.y - s.y) < halo) { inHalo = true; inShroud = shroud; break; }
      }
    }
    if (inHalo) {
      game.dustCloak = true;
      game.dustCloakT = 1.2;
      if (inShroud) { if (!game.tut.shroudCloak) game.shroudWarn = true; }
      else if (!game.tut.dust) game.dustWarn = true;
    } else if (game.dustCloakT > 0) {
      game.dustCloakT -= dt;
      if (game.dustCloakT <= 0) game.dustCloak = false;
    } else {
      game.dustCloak = false;
    }
  }

  // Field anchors advance BEFORE the alien loop so lurkers steer at this
  // frame's anchor, not last frame's.
  updateFields(game, dt);

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
  if (game.dustCloak) return;   // a nest can't scramble at a ship it can't see
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
