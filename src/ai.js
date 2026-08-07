import { CFG, fieldFrac } from './config.js';
import { Alien, derail } from './entities.js';
import { damageShip, damageBody, addParticles, frameReg } from './physics.js';
import { bump } from './achievements.js';
import * as sfx from './sfx.js';
import { TAU, clamp, senseBlind } from './util.js';

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
  // Registry, not a scan. This walked every body in the world to find the ONE
  // star, once per alien per frame — ~47k iterations a frame with three
  // lurkers hunting at shoal scale, to look at a single body.
  for (const b of frameReg(game).stars) {
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

// Veer around planets and moons instead of ploughing into them (user call,
// 2026-08: grabbers chasing the ship around a nest's own planet kept pancaking
// into its moons). Same additive-thrust idiom as avoidStars, but a WHISKER,
// not a wall: a hard radial push only right at the surface, plus a look-ahead
// along the CLOSING velocity — if the path grazes a world inside the next
// ~1.6s, steer perpendicular around it, weighted by how dead-on and how soon
// the graze is. NOT applied to lurkers: their habitat is field rock (no
// worlds in a pocket) and their containment steering is tuned separately.
function avoidWorlds(game, al) {
  const s = game.ship;
  const nearShip = s.alive && Math.hypot(s.x - al.x, s.y - al.y) < 700;
  // Awake list: aliens hunt inside the wake bubble, and a dormant world's
  // whole pocket is off-view by definition.
  for (const b of (game.bodies._awake || game.bodies)) {
    if (!b.alive || (b.type !== 'planet' && b.type !== 'moon')) continue;
    const dx = b.x - al.x, dy = b.y - al.y;
    const clear = b.radius + al.radius + 90;
    // THE FINAL ATTACK RUN IS EXEMPT: when the SHIP itself is hugging this
    // body (landed, berthing, skimming) and the alien is already in knife
    // range, the surface push would otherwise beat steer()'s clamped thrust
    // and hold every rammer at a polite hover just above the pad — a landed
    // ship could never be reached again. A dive at a grounded player is an
    // attack, not bad pathfinding.
    if (nearShip && Math.hypot(b.x - s.x, b.y - s.y) < clear + s.radius + 120) continue;
    // THE WHISKER IS CAST IN THE WORLD'S OWN FRAME, never the absolute one —
    // the same law as util.surfaceVel's, and for the same reason: WORLDS ORBIT.
    // Moons carry 33-95 u/s and planets 41-130, so over the 1.6s horizon below
    // a world slides 50-200 units out from under a ray aimed at where it is
    // NOW — comparable to `clear` itself for a moon (~230 at the median). Cast
    // absolutely, the whisker therefore called dead-on approaches clean misses
    // and, worse, could veer to the LEADING side, steering the alien into the
    // path of the world it was dodging: exactly the moon-pancaking this
    // function was written to stop. A co-orbiting alien loitering by its own
    // nest world got the mirror bug — near-zero closing speed reads as a
    // full-speed collision course, and it was shoved sideways all day.
    const rvx = al.vx - b.vx, rvy = al.vy - b.vy;
    // Cheap reject: can't touch it this beat and isn't near it now. PER AXIS on
    // the relative speed (|dx| can only close by |rvx| a second), because the
    // old shared `sp * 1.6` bound is not conservative once the ray is relative:
    // a world closing head-on adds its own speed to rsp, up to 1.6 x 130 = 208
    // units of extra reach against the 120 the flat pad allows.
    //
    // THIS BOX IS WIDER THAN THE ONE IT REPLACES, and it has to be — |rvx| runs
    // past |al.vx| by the world's own speed, so strictly more pairs survive the
    // reject and reach the whisker. That is the CORRECT direction (the pairs it
    // now admits are the ones the absolute box was wrongly dropping), and the
    // cost is bounded by the type filter above: only planets and moons ever get
    // this far, ~90 of them in a sky of thousands. Per axis is what keeps the
    // widening honest — it needs no hypot to REJECT; the hypot moved onto the
    // surviving pairs as `rsp` below, beside the `d` they already paid for.
    const rex = Math.abs(rvx) * 1.6 + clear + 120;
    const rey = Math.abs(rvy) * 1.6 + clear + 120;
    if (dx > rex || dx < -rex || dy > rey || dy < -rey) continue;
    const d = Math.hypot(dx, dy) || 1;
    // Hard radial push in the last stretch before the surface. POSITION ONLY,
    // so it is correctly frame-free — a separation and a radial bearing read
    // the same from any frame, and there is no look-ahead in it to be wrong
    // about. It stays on the absolute geometry deliberately.
    if (d < clear + 120) {
      const k = clamp(1 - (d - clear) / 120, 0, 1);
      al.thrustX -= (dx / d) * CFG.ALIEN_ACCEL * 1.4 * k;
      al.thrustY -= (dy / d) * CFG.ALIEN_ACCEL * 1.4 * k;
    }
    const rsp = Math.hypot(rvx, rvy);
    if (rsp < 40) continue;
    // Whisker: closest approach of the velocity ray within the horizon
    const t = clamp((dx * rvx + dy * rvy) / (rsp * rsp), 0, 1.6);
    if (t <= 0) continue;
    const cx = al.x + rvx * t - b.x, cy = al.y + rvy * t - b.y;
    const miss = Math.hypot(cx, cy);
    if (miss > clear) continue;
    // Push out along the closest-approach offset — it already points to the
    // side the path favours. A dead-centre hit degenerates, so fall back to
    // the velocity's own perpendicular.
    let px, py;
    if (miss > 1) { px = cx / miss; py = cy / miss; }
    else { px = -rvy / rsp; py = rvx / rsp; }
    const k = (1 - miss / clear) * (1 - t / 1.6);
    al.thrustX += px * CFG.ALIEN_ACCEL * 1.6 * k;
    al.thrustY += py * CFG.ALIEN_ACCEL * 1.6 * k;
  }
}

function nearestRock(game, al) {
  let best = null, bestD2 = 3200 * 3200;
  // Awake list: the search radius is 3200u and the wake bubble is wider than
  // that around the ship, which is where aliens hunt — a dormant rock could
  // not have won this search anyway.
  for (const b of (game.bodies._awake || game.bodies)) {
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
  // Avoidance only while FLEEING: a wright's whole job is to park ON a debris
  // point, and the husk summon anchors that point at the husk moon itself —
  // the surface push would shove it off its own destination forever and the
  // approach -> build handoff (< 140 of the anchor) could never fire.
  if (al.state === 'flee') avoidWorlds(game, al);
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
  const engaged = s.alive && !senseBlind(game) && fieldFrac(f, s.x, s.y) < 1.15;
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
  // Awake list: a lurker only sets up from inside LURKER_SHOVE_R, which sits
  // well within the wake bubble it and the ship share.
  for (const b of (game.bodies._awake || game.bodies)) {
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
    if (s.alive && !senseBlind(game)) {
      al.lastSeenX = s.x; al.lastSeenY = s.y;
      steer(al, s.x + s.vx * 0.3, s.y + s.vy * 0.3, CFG.ALIEN_SPEED * 0.85);
    } else if (s.alive && al.lastSeenX !== undefined) {
      steer(al, al.lastSeenX, al.lastSeenY, CFG.ALIEN_SPEED * 0.45);
    }
    avoidWorlds(game, al);
    avoidStars(game, al);
    return;
  }

  // TERRITORIAL: an alien belongs to its nest and never abandons that turf.
  // If it has strayed past the territory, or the player has fled the nest's
  // region, it drops everything and returns home to patrol until the player
  // comes back. A DESTROYED nest still anchors its survivors (user call,
  // 2026-08: aliens live only where the nests are) — orphans defend the dead
  // nest's last position instead of hunting freely across the system, so
  // clearing a nest region and flying on actually leaves it behind.
  const home = al.nest || null;
  const homeDist = home ? Math.hypot(home.x - al.x, home.y - al.y) : 0;
  // Grabbers fly at half the sheet speed (CFG.GRABBER_SPEED) — every steer in
  // the grabber mind runs off this, so patrol, chase and hauls all slow
  // together. Lurkers/wrights/golems keep their own tuned speeds.
  const gsp = CFG.ALIEN_SPEED * CFG.GRABBER_SPEED;
  // DUST SHROUD: a cloaked ship reads as "player left the territory" — the
  // return-home branch below is the battle-tested lose-lock path (drops the
  // carried rock, resets state), so disengagement reuses it wholesale.
  const playerHome = home
    ? (s.alive && !senseBlind(game) &&
       Math.hypot(s.x - home.x, s.y - home.y) < CFG.ALIEN_TERRITORY)
    : true;
  if (home && (homeDist > CFG.ALIEN_TERRITORY || !playerHome)) {
    if (al.target && al.target.heldBy === al) {
      al.target.heldBy = null; al.target.extAx = 0; al.target.extAy = 0;
    }
    al.target = null;
    if (homeDist > 700) {
      steer(al, home.x, home.y, gsp);                    // head back to the nest
    } else {                                             // patrol the nest yard
      const around = Math.atan2(al.y - home.y, al.x - home.x) + 0.7;
      steer(al, home.x + Math.cos(around) * 480, home.y + Math.sin(around) * 480,
        gsp * 0.55);
    }
    al.state = 'seek';   // ready to re-engage the instant the player returns
    avoidWorlds(game, al);
    avoidStars(game, al);
    return;
  }

  // NESTLESS grabbers (none spawn today — orphans keep their dead nest as
  // home above) would never take the home branch — route a cloaked player
  // straight to the cooldown strafe, or they'd deadlock chasing a target
  // they can't see. Kept as the safety net for any future nest-free spawn.
  if (senseBlind(game) && al.state !== 'cooldown') {
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
      steer(al, s.x, s.y, gsp * 0.8);
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
      steer(al, r.x + r.vx * 0.4, r.y + r.vy * 0.4, gsp);
      if (Math.hypot(r.x - al.x, r.y - al.y) < al.radius + r.radius + 55) {
        r.heldBy = al;
        derail(r);
        al.fetchT = 0;
        al.carryT = 0;
        al.state = 'carry';
      }
      break;
    }
    case 'carry': {
      const r = al.target;
      if (!r || !r.alive || r.heldBy !== al) { al.target = null; al.state = 'seek'; break; }
      // CARRY HAS A TIMEOUT TOO, mirroring fetch's `fetchT > 7` above (QA
      // #178): a grabber whose speed budget can't close on a moving player —
      // or one it simply can't get sight of past a world — used to haul its
      // rock forever instead of ever re-planning. Drop it clean, same as the
      // death branch below, rather than let a stuck grabber sit on ammo no
      // other alien can use.
      al.carryT = (al.carryT || 0) + dt;
      if (al.carryT > 9) {
        r.heldBy = null; r.extAx = 0; r.extAy = 0;
        al.carryT = 0; al.target = null; al.state = 'seek'; break;
      }
      // Ship died mid-haul: DROP the rock, and zero the carry accel with it.
      // extAx/extAy is not rebuilt from scratch each frame — physics adds it to
      // b.ax every substep until somebody clears it — so a release that let it
      // stand left the rock under a permanent ~800 u/s^2 phantom thrust with no
      // holder and no `thrownBy` leash. It reached belt-shredding speed in
      // seconds, every single time the player died to a loaded grabber. Every
      // other release path (killAlien, the throw, the territory/cloak drops,
      // the tractor) clears it here; this one is the same law.
      if (!s.alive) {
        r.heldBy = null; r.extAx = 0; r.extAy = 0;
        al.target = null; al.state = 'seek'; break;
      }

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
      // The range is CFG.ALIEN_THROW_R — a grabber has to get properly close
      // before it launches, so the wind-up is something you can watch coming.
      steer(al, s.x, s.y, gsp);
      if (distShip < CFG.ALIEN_THROW_R && !senseBlind(game)) {
        // THE LEAD IS SOLVED IN THE THROWER'S OWN FRAME, because the launch
        // below INHERITS the thrower's motion — the same law as the whisker's
        // above and physics.js's lurker body-check. The rock leaves at
        // `al.v + ALIEN_THROW*dir`, so a lead solved against the ship's
        // ABSOLUTE velocity is wrong by `al.v * t`, and a grabber's own speed
        // is no small term: GRABBER_SPEED x ALIEN_SPEED is 215 u/s of ground
        // budget on top of the nest worlds' 59-81 of flow, i.e. up to half of
        // ALIEN_THROW. Cast absolutely, a grabber strafing across a PARKED
        // ship threw every rock up to ~30 deg off the lead it had just solved
        // and could not hit it at all.
        //
        // THE CARRY STAYS. A thrown rock keeping the thrower's motion is the
        // real physics, and it holds the launch speed in the THROWER's frame —
        // which is the invariant T24b asserts — exactly where it was tuned.
        // It does NOT hold the shot's GROUND speed, and never did:
        // |al.v + ALIEN_THROW*dir| depends on `dir`, so moving the aim angle
        // moves the world-frame speed with it (372 u/s under this solve against
        // 481 before it, measured on T24b's own rig). Deleting the carry would
        // be a damage retune wearing an aim fix's clothes — that is why it
        // stays, not because the ground speed is fixed.
        //
        // Two-pass flight time, from the ROCK's own position: the first pass'
        // time is wrong by however far the ship travels during it, so feed it
        // back once. `distShip` is the ALIEN's distance and the rock is held a
        // body-length out in front of it, so it is not the flight to solve.
        // THE ITERATION DOES NOT CLOSE — it converges linearly, shrinking the
        // error by |s.v - al.v| / (projectile speed) per pass, so the leftover
        // miss grows with the target's RELATIVE speed and two passes still
        // leave real gaps at the edges of the envelope: ~50 u for a grabber at
        // d = 450 against |rv| = 250, on a 13.4 u hit radius — and the fort's
        // slower bolt below is worse, ~140 u at d = 1300 against |rv| = 150 on
        // a 10 u hit radius. That is a FAIRNESS property and is left alone: a
        // ship that keeps MOVING still beats the lead, and only a parked or
        // co-orbiting one is reliably hit. A third pass would roughly halve the
        // residual if that ever needs to change.
        const rvx = s.vx - al.vx, rvy = s.vy - al.vy;
        let t = Math.hypot(s.x - r.x, s.y - r.y) / CFG.ALIEN_THROW;
        t = Math.hypot(s.x + rvx * t - r.x, s.y + rvy * t - r.y) / CFG.ALIEN_THROW;
        const ang = Math.atan2(s.y + rvy * t - r.y, s.x + rvx * t - r.x);
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
      steer(al, s.x + s.vx * 0.4, s.y + s.vy * 0.4, gsp * 1.2);
      if (Math.random() < dt * 0.3) al.state = 'seek';
      break;
    }
    case 'cooldown': {
      // Strafe away sideways while the next plan forms
      al.cool -= dt;
      const away = Math.atan2(al.y - s.y, al.x - s.x) + 0.9;
      steer(al, al.x + Math.cos(away) * 400, al.y + Math.sin(away) * 400, gsp * 0.9);
      if (al.cool <= 0) al.state = 'seek';
      break;
    }
  }
  avoidWorlds(game, al);
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
    if (!s.alive || senseBlind(game) || f.wakeT > 0) continue;
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
    // Awake list: the spot has to be 280-1000u from the ship to qualify.
    for (const b of (game.bodies._awake || game.bodies)) {
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
  // Registry: forts are a handful of fortified worlds and this walked every
  // body in the world to find them, every frame.
  for (const b of frameReg(game).forts) {
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
      // THE LEAD IS SOLVED IN THE FORT'S OWN FRAME, for the same reason the
      // grabber's throw is (updateAlien's carry state above): the bolt INHERITS the
      // fort world's velocity, and A FORT ORBITS. Solved absolutely the aim
      // point was off by `b.v * tt` — at the 41-130 u/s a world carries and
      // the ~5s flight `d <= 1300` allows, 200-650 units of systematic lateral
      // lead against a hull whose radius is at most 44. The case that made it
      // absurd is the commonest one: a ship holding station beside the fort is
      // CO-ORBITING, so the true lead is near zero, yet every shell of the
      // barrage was thrown a world's-worth of speed ahead of it.
      // Two passes, from the MUZZLE — `d` is centre-to-ship and overstates the
      // flight by b.radius/260.
      const rvx = s.vx - b.vx, rvy = s.vy - b.vy;
      let tt = Math.hypot(s.x - wx, s.y - wy) / 260;
      tt = Math.hypot(s.x + rvx * tt - wx, s.y + rvy * tt - wy) / 260;
      const ang = Math.atan2(s.y + rvy * tt - wy, s.x + rvx * tt - wx);
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
        // Any rock blocks a bolt — your orbit shield is real cover here.
        // Awake list: a bolt in flight is between a fort and the ship.
        for (const b of (game.bodies._awake || game.bodies)) {
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
  // is invisible to alien senses. Computed ONCE per frame, with a 1.2s release
  // grace so hovering the halo's edge can't strobe the AI between engage and
  // disengage. Forts are exempt on purpose: they're artillery emplacements,
  // not hunters (and no dust moon is ever fortified — world.js keeps them out
  // of the fortify pass).
  //
  // This block OWNS game.dustCloak, and is the only place that writes it. The
  // gates below all ask util.senseBlind instead, because a live SOLAR WAVE
  // hides the ship too (game.stormBlind, main.js) and every gate has to answer
  // to both — see util.js.
  {
    const s = game.ship;
    let inHalo = false, inShroud = false;
    if (s.alive) {
      // Registry: dust moons and shroud worlds share one list, so this no
      // longer walks the world to find the few bodies that can hide you.
      for (const b of frameReg(game).cloakers) {
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

  // HUSK MOONS call their own wright: a hard player smash on the wreck-plating
  // (physics.damageBody sets game.huskWake, cooled per-moon) summons a
  // wreckwright DOWN ON THE MOON — prompt, not on the ambient timer below, but
  // under the ambient descent's exact caps (one wright, golems < 2), so mining
  // a husk can never stack scavengers the timer wouldn't have allowed.
  if (game.huskWake) {
    const hm = game.huskWake;
    game.huskWake = null;
    const busy = game.aliens.some((a) => a.alive && a.kind === 'wright') ||
      game.aliens.reduce((n, a) => n + (a.alive && a.kind === 'golem' ? 1 : 0), 0) >= 2;
    // GAME MODE: the husk summon is the last spawner that isn't a nest or a
    // brood, so it needs the `hostiles` gate by hand — the other two are
    // already empty by construction in a no-enemy world (world.applyModeRules
    // deletes the nests and spends the broods). The flag is still consumed
    // above whatever the mode, or a smash landed in peaceful would sit pending
    // and summon a wright the moment anything else set it.
    if (game.rules.hostiles && hm.alive && game.ship.alive && !busy) {
      const th = Math.random() * TAU;
      const w = new Alien(hm.x + Math.cos(th) * 3400, hm.y + Math.sin(th) * 3400, 'wright');
      w.anchor = { x: hm.x, y: hm.y };
      game.aliens.push(w);
      game.wrightWarn = true;
    }
  }

  // (The AMBIENT wreckwright — the timer that sent one down on any rich debris
  // field near the player — is REMOVED, user call 2026-08: aliens live only
  // where the nests are, and a scavenger materialising in open space was the
  // last free-roaming spawn. The husk-moon summon above is the one wright
  // source left: player-triggered, on a marked moon, under the same caps.)

  // NESTS are the alien homeland: each living nest sustains a local patrol
  // while the player is in its region. No nest nearby = peaceful space, and
  // destroying a nest silences its territory for good.
  if (game.time < CFG.ALIEN_FIRST_WAVE) return;
  game.alienTimer -= dt;
  if (game.alienTimer > 0) return;
  // Idle poll, NOT the regroup clock: open space re-checks every few seconds
  // so flying into a fresh nest's territory still means prompt contact. The
  // slow CFG.ALIEN_REGROUP only arms once a nest is actually in range (below)
  // — it prices the REFILL after you thin a garrison, never the first hello.
  game.alienTimer = 3;

  const s = game.ship;
  if (!s.alive) return;
  if (senseBlind(game)) return;   // a nest can't scramble at a ship it can't see
  // A nest holds a garrison scaling gently with level, and scrambles a whole
  // burst (up to ALIEN_BURST) at once when the player enters its territory.
  const cap = CFG.ALIEN_BURST + Math.min(3, Math.floor(game.st.totalLevel / 5));
  for (const nest of game.bodies) {
    if (!nest.alive || nest.type !== 'nest') continue;
    if (Math.hypot(nest.x - s.x, nest.y - s.y) > 5500) continue;
    // In a nest's region the garrison regroups on the SLOW clock (see the
    // ALIEN_REGROUP config note) — whether or not this cycle spawns anything,
    // so camping the yard can't farm a quick refill.
    game.alienTimer = CFG.ALIEN_REGROUP;
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
