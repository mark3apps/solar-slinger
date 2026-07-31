import { CFG, PROG, addXp } from './config.js';
import { makeScrap, scrapValue, railBody, derail, keplerStep } from './entities.js';
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

// The local orbital "flow" — the prograde circular velocity VECTOR of the space
// around (x,y), i.e. "the rotation of the universe" at that point. The governor
// caps the ship's velocity RELATIVE to this flow at maxSpeed, so the current
// carries the ship along and the engine only buys maxSpeed of deviation in any
// direction: with the flow you reach flow+maxSpeed, against it flow-maxSpeed,
// sideways/radial ±maxSpeed. Near the sun the flow outruns maxSpeed and sweeps
// you prograde; out in the belt maxSpeed exceeds it so you can even fly
// retrograde. Speed magnitude alone is the WRONG cap (it let you sit still in a
// fast current, or fly full-tilt against the spin). Mirrored in predictPaths.
function orbitalFlow(game, x, y) {
  const sun = game.homeStar;
  const rx = x - sun.x, ry = y - sun.y;
  const sr = Math.max(sun.radius, Math.hypot(rx, ry));
  const v = Math.sqrt(CFG.G * CFG.SHIP_GRAV * CFG.STAR_GRAV_SHIP * sun.mass / sr);
  return { vx: (-ry / sr) * v, vy: (rx / sr) * v };   // CCW/prograde unit tangent x speed
}

// Collision credit taxonomy (drives scrap + fling growth):
//   'player-throw' — this body was smashed BY a player-thrown rock: scrap + fling
//   'player'       — player-involved but not a direct throw-kill (your own
//                    projectile shattering, or a shield-rock brush): scrap only
//   'alien'/'ram'/null — no player payout
// earnsScrap gates every scrap drop; only 'player-throw' grows the fling.
function earnsScrap(credit) { return credit === 'player' || credit === 'player-throw'; }
function collisionCredit(target, other) {
  if (other.thrownBy === 'player' && other.thrownTimer > 0) return 'player-throw';
  // Cluster-Rounds shrapnel scores a player kill (scrap) but NOT 'player-throw',
  // so a shard-kill can't re-trigger Cluster Rounds — no exponential shard chain.
  if (other.thrownBy === 'shard' && other.thrownTimer > 0) return 'player';
  if ((target.thrownBy === 'player' && target.thrownTimer > 0)
      || target.heldBy === 'orbit' || other.heldBy === 'orbit') return 'player';
  if ((other.thrownBy === 'alien' && other.thrownTimer > 0)
      || (target.thrownBy === 'alien' && target.thrownTimer > 0)) return 'alien';
  return null;
}

// BRAWLER throw-kill effects (Cluster Rounds / Shockwave / Demolition). Called
// from shatter ONLY on a 'player-throw' kill. Iterates a SNAPSHOT of the body
// list so the shrapnel it spawns — and any Demolition chain-kills — don't feed
// back into this same blast. Demolition damages with credit 'player' (drops
// scrap but does NOT re-enter here), so the chain is bounded, never infinite.
function brawlerThrowKill(game, body) {
  const st = game.st;
  if (st.cluster > 0 && game.bodies.length < 460) {   // body-count cap like the spall path
    const n = st.cluster + 1;
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + Math.random() * 0.7;
      const sp = 260 + Math.random() * 200;
      const shard = spawnAsteroid(game.bodies,
        body.x + Math.cos(th) * (body.radius + 4), body.y + Math.sin(th) * (body.radius + 4),
        body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp, 140 + Math.random() * 220);
      // 'shard' (NOT 'player') so a shard-kill can't re-cluster (see collisionCredit)
      shard.thrownBy = 'shard'; shard.thrownTimer = 1.2; shard.color = '#ffb98a';
    }
  }
  if (st.shockwave > 0 || st.demolition > 0) {
    const R = 240 + 90 * Math.max(st.shockwave, st.demolition);
    const push = 130 * st.shockwave;
    const dmg = 16 * st.demolition * (1 + st.tier * 0.4);
    let hits = 0;
    for (const nb of game.bodies.slice()) {   // snapshot — shards/chain-kills don't recurse
      // ONLY loose asteroids (belt rocks + fragments). Never moons/planets/
      // installations/wrecks/comets — the blast must not derail a railed
      // celestial or damage one past its invariant-3 protections; and skip our
      // own shrapnel so a blast can't blow up the shards it just spawned.
      // Vesper is type 'asteroid' but an HONORARY CELESTIAL (majorComet) —
      // every loose-rock filter must exclude it explicitly or the blast puts
      // undamped impulse on the one body those rules exist to protect.
      if (nb === body || !nb.alive || nb.type !== 'asteroid' || nb.majorComet ||
          nb.thrownBy === 'shard' || nb.heldBy) continue;
      const ddx = nb.x - body.x, ddy = nb.y - body.y;
      const dd = Math.hypot(ddx, ddy);
      if (dd > R || dd < 1) continue;
      const falloff = 1 - dd / R;
      if (push > 0) {
        const imp = push * falloff * Math.min(1, 3000 / nb.mass);
        nb.vx += (ddx / dd) * imp; nb.vy += (ddy / dd) * imp;
        if (imp > 70) derail(nb);              // only a real shove derails — limits belt sandblasting
      }
      if (dmg > 0) damageBody(game, nb, dmg * falloff, 'player', body.x, body.y);
      if (++hits >= 24) break;                 // cap the blast's reach
    }
    addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 22, '#ffcaa0', 230, 1.1, 4);
    addShake(game, 5 + 3 * Math.max(st.shockwave, st.demolition));
  }
}

// WALL SPLAT (brawler): your throw died against a world's face
// (collideBodies sets body.splatWall around that one damage call). The
// environment becomes part of the arsenal: bonus XP, and nearby LOOSE rocks
// are shoved off the impact — hard shoves carry your billiards credit (same
// closing>60 propagation idea as collideBodies), so a splat near a cluster
// can open a combo. Push-only, asteroids only: like Shockwave, the blast
// must never derail a railed celestial or touch an installation.
function wallSplat(game, body) {
  const st = game.st;
  addXp(game, 8 + 7 * st.wallSplat);
  const R = 170 + 55 * st.wallSplat;
  let hits = 0;
  for (const nb of game.bodies.slice()) {
    // Same loose-rock filter as the Shockwave blast above — including the
    // explicit majorComet exclusion (Vesper is type 'asteroid' by mechanics
    // but an honorary celestial by law; see that comment).
    if (nb === body || !nb.alive || nb.type !== 'asteroid' || nb.majorComet ||
        nb.thrownBy === 'shard' || nb.heldBy) continue;
    const ddx = nb.x - body.x, ddy = nb.y - body.y;
    const dd = Math.hypot(ddx, ddy);
    if (dd > R || dd < 1) continue;
    const imp = (110 + 45 * st.wallSplat) * (1 - dd / R) * Math.min(1, 2500 / nb.mass);
    nb.vx += (ddx / dd) * imp; nb.vy += (ddy / dd) * imp;
    if (imp > 70) {
      derail(nb);
      // A real shove is a chain-link: the rock it smashes next is still yours
      if (nb.thrownBy !== 'player') { nb.thrownBy = 'player'; nb.thrownTimer = Math.max(nb.thrownTimer, 1.4); }
    }
    if (++hits >= 12) break;
  }
  addParticles(game, body.x, body.y, body.vx * 0.2, body.vy * 0.2,
    18, '#ffcaa0', 200, 0.9, 4);
  addShake(game, 4 + 2 * st.wallSplat);
  if (!game.tut.wallsplat) game.wallSplatWarn = true;   // main.js announces (first time)
}

export function shatter(game, body, credit = null) {
  if (!body.alive) return;
  body.alive = false;
  // The ring shepherd only respawns after AMBIENT deaths — a deliberate
  // player kill earns its permanently scattered ring (world.js respawn).
  // Same rule for the Tinker Barge: shoot the trader and no trader returns.
  if (body.shepherd && earnsScrap(credit)) game.shepherdPlayerKilled = true;
  if (body.tinker && earnsScrap(credit)) game.tinkerPlayerKilled = true;
  if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'shattered', type: body.type, mass: Math.round(body.mass) });
  if (body.heldBy === 'player' && game.held === body) game.held = null;

  const isBig = body.mass > 5e4;
  // A dying WORLD comes apart into a TON of planet chunks — a dense, jostling
  // debris cloud filling the volume the world occupied, not a neat ring.
  // Speeds are deliberately mixed (slow core pieces, fast ejecta) so the cloud
  // lingers and the chunks bump and grind each other on the way out; being
  // ordinary bodies they collide, spall, and chain like anything else. Chunk
  // masses stay under CHUNK_MAX_MASS (never rail disturbers) and the count is
  // capped by mass and by the global body budget.
  const isWorld = body.type === 'planet' || body.type === 'moon' || body.type === 'rogue';
  if (isWorld && body.ptype !== 'gas') {
    // Ejection speeds are LOW on purpose: the cloud should hang together and
    // visibly jostle — chunks grinding past each other — before gravity and
    // the orbital flow shear it into a debris stream. Fast ejecta reads as a
    // firework that empties the screen in a second.
    const n = Math.min(Math.min(30, 10 + Math.floor(body.mass / 8000)),
      Math.max(0, 460 - game.bodies.length));
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + (Math.random() - 0.5) * 0.6;
      const rr = body.radius * (0.2 + Math.random() * 0.85);
      const s = 25 + Math.random() * 130;
      const m = clamp(body.mass * (0.01 + Math.random() * 0.022), 120, CFG.CHUNK_MAX_MASS);
      const f = spawnAsteroid(
        game.bodies,
        body.x + Math.cos(th) * rr,
        body.y + Math.sin(th) * rr,
        body.vx + Math.cos(th) * s + (Math.random() - 0.5) * 70,
        body.vy + Math.sin(th) * s + (Math.random() - 0.5) * 70,
        m,
      );
      f.color = body.color;
      f.chunk = true;         // crust-shard sprite — visibly a piece of THIS world
    }
  } else if (isBig) {
    // Big non-world bodies (giant loose asteroids) break into plain fragments
    const n = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + Math.random() * 0.6;
      const s = 40 + Math.random() * 110;
      const m = clamp(body.mass * (0.02 + Math.random() * 0.03), 200, 4000);
      const f = spawnAsteroid(
        game.bodies,
        body.x + Math.cos(th) * body.radius * 0.6,
        body.y + Math.sin(th) * body.radius * 0.6,
        body.vx + Math.cos(th) * s, body.vy + Math.sin(th) * s,
        m,
      );
      f.color = body.color;   // wreckage reads as pieces of the world it was
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

  // CORED ROCK: cracking the shell (only a player smash frees it) exposes a
  // dense mineral core — heavy salvage that survives the break, grab or smash.
  if (body.cored && earnsScrap(credit)) {
    const cm = clamp(body.mass * 0.8, 500, 4000);
    const core = spawnAsteroid(game.bodies, body.x, body.y, body.vx * 0.5, body.vy * 0.5, cm);
    core.core = true; core.color = '#b98cff';
    addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 20, '#d8b8ff', 190, 1.3, 4);
    game.coreFound = true;
  }
  // SALVAGE CACHE: bursts into scrap + ice ammo pellets when you crack it
  if (body.cache && earnsScrap(credit)) {
    dropScrap(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 120);
    for (let i = 0; i < 3; i++) {
      const th = (i / 3) * TAU + Math.random() * 0.8;
      const sp = 45 + Math.random() * 70;
      const pel = spawnAsteroid(game.bodies, body.x + Math.cos(th) * 10, body.y + Math.sin(th) * 10,
        body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp, 150 + Math.random() * 150);
      pel.ice = true; pel.color = '#bfe3f2';
    }
    addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 26, '#bfe3f2', 210, 1.4, 4);
    game.cacheCracked = true;
  }

  // Scrap is EARNED, not ambient: only a player throw or a shield-rock hit
  // (credit === 'player') pays out. A rock the player never touched — belt
  // traffic sandblasting itself, a rogue clipping a moon, a ram, star heat —
  // shatters with no salvage. Keeps the sky from minting free scrap.
  if (earnsScrap(credit)) dropScrap(game, body.x, body.y, body.vx * 0.4, body.vy * 0.4, scrapValue(body));
  // Wall Splat rides its own flag, not the credit: the dying body here is the
  // player's OWN projectile (credit 'player'), which never reaches the
  // 'player-throw' branch below.
  if (body.splatWall && game.st.wallSplat > 0) wallSplat(game, body);
  const big = isBig || isWorld;   // even a small moon dies like a world
  addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3,
    big ? 50 : 16, body.color, big ? 260 : 140, big ? 1.6 : 0.9, big ? 5 : 3);
  addShake(game, big ? 14 : 4);
  // Distance-scaled: far belt traffic crunching itself stays a murmur
  sfx.sfxBoom(big ? 3 : 1, sfx.distVol(game, body.x, body.y));

  // XP: only a direct throw-kill pays combat XP (not your own projectile
  // shattering or a shield brush — those still pay scrap, above).
  // A RAM KILL pays a smaller cut: ramming is a real brawler verb (the innate
  // prow), so splattering a rock on your hull is good play — but it stays
  // scrap-less (earnsScrap) and combo-less, so bulldozing the belt never
  // outearns aimed throws.
  if (credit === 'ram') addXp(game, PROG.XP_RAM + (isBig ? 8 : 0));
  if (credit === 'player-throw') {
    brawlerThrowKill(game, body);   // Cluster Rounds / Shockwave / Demolition (no-op unless owned)
    addXp(game, PROG.XP_SMASH + (isBig ? 12 : 0));
    game.prog.smashes++;
    // GRAVITY BILLIARDS: throw-kills chained within the window rack up a
    // combo (the chain is carried by propagated credit in collideBodies).
    // 2+ pays a bonus and flags main.js to shout the multiplier.
    game.combo = (game.combo || 0) + 1;
    game.comboT = 2.6;
    game.comboBest = Math.max(game.comboBest || 0, game.combo);
    if (game.combo >= 2) {
      game.comboShow = game.combo;
      dropScrap(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 8 * game.combo);
    }
  }
}

// Chip damage: lose hp, shed some mass as scrap, shrink. hx/hy is the impact
// position when the caller knows it (fort turret targeting reads it).
export function damageBody(game, body, dmg, credit = null, hx, hy) {
  if (body.type === 'star' || !body.alive) return;
  // BASTION fortifications break down progressively, not all-or-nothing:
  // a hit landing ON a turret chews through THAT turret (the emitters poke
  // through their own bubble — 60% leaks in while shielded), anywhere else
  // drains the shield. With the shield down every hit finds a turret. The
  // last turret's death liberates the world; the body beneath is untouched.
  if (body.fort) {
    const f = body.fort;
    f.quiet = 0;
    f.hitT = 0.35;
    let tur = null;
    if (hx !== undefined && f.turrets.length) {
      const ia = Math.atan2(hy - body.y, hx - body.x);
      let bd = Infinity;
      for (const t of f.turrets) {
        const da = Math.abs(angDiff(ia, body.rot + t.ang));
        if (da < bd) { bd = da; tur = t; }
      }
      if (f.shield > 0 && bd > 0.55) tur = null;   // shielded + wide miss = shield's problem
    }
    if (!tur && f.shield <= 0 && f.turrets.length) tur = f.turrets[0];
    if (tur) {
      const through = f.shield > 0 ? 0.6 : 1;
      tur.hp -= dmg * through;
      if (f.shield > 0) f.shield = Math.max(0, f.shield - dmg * 0.4);
      if (tur.hp <= 0) {
        f.turrets.splice(f.turrets.indexOf(tur), 1);
        addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 16, '#ffb35c', 200, 1);
        sfx.sfxBoom(1, sfx.distVol(game, body.x, body.y));
        if (!f.turrets.length) {
          body.fort = null;
          dropScrap(game, body.x + body.radius * 0.8, body.y, body.vx * 0.5, body.vy * 0.5, 200);
          game.fortLiberatedName = body.name || `the ${body.type}`;
          return;
        }
      }
    } else if (f.shield > 0) {
      f.shield = Math.max(0, f.shield - dmg);
    }
    if (f.shield <= 0 && !f.shieldDownSaid) {
      f.shieldDownSaid = true;
      game.fortShieldDownName = body.name || body.type;
    }
    return;
  }
  // ROCKWALL (hauler): rocks serving in the orbit shield are hardened — the
  // wall survives the intercepts it exists to make. Loose rocks are untouched.
  if (body.heldBy === 'orbit' && game.st.rockwall > 0) dmg *= 1 - 0.2 * game.st.rockwall;
  // SULFUR MOONS: a hard PLAYER smash (earnsScrap credit — ambient traffic
  // can't trigger it) vents the crust: a queued chain of surface pops that
  // fountain loose sling rock (the world.js hazard loop pops them). Not on
  // the killing blow — the moon's death is its own event, not a send-off.
  if (body.type === 'moon' && body.moonType === 'sulfur' && earnsScrap(credit) &&
      dmg > 8 && !(body.sulfurCd > 0) && body.hp - dmg > 0) {
    body.sulfurCd = 30;
    body.sulfurPops = 3 + Math.floor(Math.random() * 3);
    body.sulfurPopT = 0.2;
    game.sulfurWarn = true;
  }
  derail(body);
  body.hp -= dmg;
  if (body.hp <= 0) { shatter(game, body, credit); return; }
  const frac = clamp(dmg / body.maxHp, 0, 0.5);

  // CHUNKS + SCARS: a hard single hit on a big body isn't just an hp tick.
  // Wear shows EARLY — at half the spray gates the hit already carves a
  // persistent crater (b.scars; render punches a visible bite out of the
  // silhouette). At the full gates the impact also SPRAYS real chunk
  // asteroids: a couple burst from the crater, the rest shoot out in random
  // directions all around the body (giants vent extra), and they fly,
  // collide, and chain like any other rock. The dual gate (absolute damage
  // OR hp fraction) exists because mass dominance throttles planet hits to a
  // few points — see the CHUNK_* rationale in config.js. Corona heat's
  // per-call drip (~0.1% of maxHp) can never clear even the half gates.
  const canWear = body.type !== 'station' && body.type !== 'nest' && body.ptype !== 'gas';
  const bigEnough = body.mass >= CFG.CHUNK_MIN_MASS;
  // Small rocks scar too — wear is universal, only the SPRAY needs the mass
  // gate. Their maxHp is tiny so the gate is fractional (a real bite of the
  // rock, not a graze), with a radius floor below which a scar can't read.
  const scarHit = bigEnough
    ? (dmg >= CFG.CHUNK_DMG_MIN * 0.5 || frac >= CFG.CHUNK_DMG_FRAC * 0.5)
    : (frac >= 0.15 && body.radius >= 5);
  if (canWear && scarHit) {
    // severity 0..1 blends both gates: frac carries moons, raw damage carries
    // planets (whose maxHp dwarfs any single hit)
    const sev = clamp(frac * 8 + dmg / 60, 0.15, 1);
    const ia = (hx !== undefined) ? Math.atan2(hy - body.y, hx - body.x) : Math.random() * TAU;
    // scar angle is stored SURFACE-LOCAL (minus rot) so the bite rides the spin
    body.scars.push({ a: ia - body.rot, s: 0.6 + sev * 1.6, t: game.time });
    if (body.scars.length > 7) body.scars.shift();
    if (bigEnough && (dmg >= CFG.CHUNK_DMG_MIN || frac >= CFG.CHUNK_DMG_FRAC) &&
        game.bodies.length < 450) {   // body-count cap like the spall path
      const n = 2 + Math.round(sev * 4) + (body.mass >= 2e4 ? 2 : 0);
      let shed = 0;
      for (let k = 0; k < n; k++) {
        // first chunks burst from the crater; the rest spray ANYWHERE — a big
        // impact rings the whole body, not just the wound
        const th = k < 2 ? ia + (Math.random() - 0.5) * 1.6 : Math.random() * TAU;
        const m = clamp(body.mass * (0.004 + Math.random() * 0.012) * sev, 90, CFG.CHUNK_MAX_MASS);
        const sp = 80 + Math.random() * 150 + 220 * sev;
        // spawn OUTSIDE the surface with outward velocity — a chunk born
        // overlapping its parent would take collision damage and shed again
        const f = spawnAsteroid(game.bodies,
          body.x + Math.cos(th) * (body.radius * 1.03 + 14),
          body.y + Math.sin(th) * (body.radius * 1.03 + 14),
          body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp, m);
        f.color = body.color;   // chunks read as pieces of the world they left
        // shed pieces of worlds are PLANET CHUNKS (crust-shard sprite); big
        // loose asteroids just calve ordinary rock
        if (body.type === 'planet' || body.type === 'moon' || body.type === 'rogue') f.chunk = true;
        // GRAVITY BILLIARDS: chunks your throw knocked loose carry your credit
        // for a beat — same rule as the knocked-rock propagation in
        // collideBodies. ONLY on a direct 'player-throw' hit: shard/Demolition
        // damage stays credit-neutral so those chains remain bounded.
        if (credit === 'player-throw') { f.thrownBy = 'player'; f.thrownTimer = 1.4; }
        shed += m;
      }
      // The shed mass really leaves the body (floor at 25% of base, like chip)
      body.mass = Math.max(body.baseMass * 0.25, body.mass - shed);
      addParticles(game,
        body.x + Math.cos(ia) * body.radius, body.y + Math.sin(ia) * body.radius,
        body.vx * 0.5, body.vy * 0.5, 8 + Math.round(sev * 16), body.color, 170, 1, 4);
      addShake(game, Math.min(10, 2 + sev * 9));
      sfx.sfxBoom(1 + sev * 1.5, sfx.distVol(game, body.x, body.y));
    }
  }

  if (frac > 0.01) {
    // Chip scrap only from player-caused hits (throw / shield) — see shatter
    if (earnsScrap(credit)) dropScrap(game, body.x, body.y, body.vx * 0.5, body.vy * 0.5, scrapValue(body) * frac * 0.5);
    body.mass = Math.max(body.baseMass * 0.25, body.mass - body.baseMass * frac * 0.35);
    addParticles(game, body.x, body.y, body.vx * 0.5, body.vy * 0.5, 8, body.color, 100, 0.7);
  }
  // One radius/attractor rebuild covers both the chip and chunk mass losses
  body.radius = body.baseRadius * Math.cbrt(body.mass / body.baseMass);
  if (body.mass < CFG.ATTRACT_MIN && body.type !== 'star') body.attractor = false;
}

function vaporize(game, body) {
  if (!body.alive) return;
  body.alive = false;
  if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'vaporized by star', type: body.type, mass: Math.round(body.mass) });
  if (body.heldBy === 'player' && game.held === body) game.held = null;
  addParticles(game, body.x, body.y, 0, 0, 24, '#ffd98a', 220, 1.1, 4);
  sfx.sfxBoom(1.5, sfx.distVol(game, body.x, body.y));
}

export function killAlien(game, alien) {
  if (!alien.alive) return;
  alien.alive = false;
  if (alien.target && alien.target.heldBy === alien) {
    alien.target.heldBy = null;
    alien.target.extAx = 0; alien.target.extAy = 0;
  }
  // Wrights refund everything they've eaten; golems are MADE of scrap
  dropScrap(game, alien.x, alien.y, alien.vx * 0.3, alien.vy * 0.3,
    CFG.ALIEN_SCRAP + (alien.hoard || 0));
  addParticles(game, alien.x, alien.y, alien.vx * 0.3, alien.vy * 0.3, 30, '#8aff6a', 200, 1.2, 4);
  addShake(game, 6);
  sfx.sfxBoom(2, sfx.distVol(game, alien.x, alien.y));
  game.alienKills++;
}

export function damageShip(game, dmg, cause, hitAng) {
  const s = game.ship;
  // godMode is the window.god() dev/test hook — every ship-damage path funnels
  // through here, so this one early-out is the whole feature
  if (!s.alive || s.invuln > 0 || game.godMode) return;
  game.lastDamage = game.time;
  // The shield eats damage first; only the overflow bites the hull. Coverage
  // is spec DNA (st.shieldArc, config.shipStats): BRAWLER's War Plating wraps
  // only the FRONT arc, so a directional hit (hitAng = world angle from ship
  // to impact) landing outside it skips the shield entirely — the tail is
  // bare.
  // DIRECTIONLESS damage (heat, gas crush, Oort grinding — no hitAng) has no
  // angle to test, so it can't be shrugged off by facing the right way. It
  // bathes the WHOLE hull, and a partial shield only covers part of that hull:
  // it soaks its COVERAGE SHARE (arc / PI — half, for the brawler's PI/2
  // plating) and the rest goes straight through. Half a shield stops half of
  // an all-over effect; it used to soak all of it, which quietly made the
  // front-arc drawback free in exactly the places it should hurt most. A
  // full-wrap shield (SCOUT's Phase Screen) is unaffected — its share is 1.
  const arc = game.st.shieldArc ?? Math.PI;
  const fullWrap = arc > Math.PI - 0.01;
  const covered = hitAng === undefined || fullWrap ||
    Math.abs(angDiff(hitAng, s.angle)) <= arc;
  let rem = dmg;
  if (s.shield > 0 && rem > 0 && covered) {
    const soakable = (hitAng === undefined && !fullWrap) ? dmg * (arc / Math.PI) : rem;
    const absorbed = Math.min(s.shield, rem, soakable);
    s.shield -= absorbed;
    rem -= absorbed;
    s.shieldHitT = 0.35;
  }
  s.hull -= rem;
  if (dmg >= 1) {   // continuous grinding (Oort cloud) shouldn't spam fx
    addShake(game, Math.min(18, dmg * 0.5));
    // Shield ate the whole hit → energy zap; anything reached the hull → metal
    if (rem <= 0) sfx.sfxShieldHit(); else sfx.sfxHit();
  }
  if (s.hull <= 0) {
    s.alive = false;
    game.held = null;
    game.held2 = null;   // Twin Grip: drop the second rock too
    game.deathCause = cause;
    addParticles(game, s.x, s.y, s.vx * 0.3, s.vy * 0.3, 60, '#9fd6ff', 280, 1.6, 4);
    sfx.sfxShipDeath();
    addShake(game, 22);
  }
}

// ---------- gravity ----------

// Perf: these run every substep for every live entity, so they avoid
// allocating — both return a shared scratch object whose values must be
// consumed before the next gravity call.
const SOFT2 = CFG.GRAV_SOFT * CFG.GRAV_SOFT;
const _g = { ax: 0, ay: 0 };
const _gp = { ax: 0, ay: 0 };   // non-star portion of the last gravityAt call (gravity compass)

// Full acceleration from all attractors at point (x,y) — used for the ship,
// aliens, and debris, which always feel everything.
function gravityAt(attractors, x, y, starMul = 1, heavyMul = 1) {
  let ax = 0, ay = 0, pax = 0, pay = 0;
  for (const b of attractors) {
    const star = b.type === 'star';
    const heavy = b.type === 'planet' || b.type === 'moon' || b.type === 'rogue';
    let w = star ? starMul : heavy ? heavyMul : 1;
    const dx = b.x - x, dy = b.y - y;
    const d2 = dx * dx + dy * dy + SOFT2;
    const d = Math.sqrt(d2);
    // LONG ARMS (see CFG.SHIP_WELL_*): only the SHIP passes heavyMul != 1,
    // so this far-field boost never touches aliens, debris, or thrown rocks.
    // Inside SHIP_WELL_START radii f <= 1 and nothing changes — same
    // close-range gravity, longer reach. predictPaths mirrors this exactly.
    if (heavy && heavyMul !== 1) {
      const f = d / (b.radius * CFG.SHIP_WELL_START);
      if (f > 1) w *= Math.min(CFG.SHIP_WELL_MAX, f);
      // GAS DIVE: inside a gas giant the ship feels enclosed-mass gravity
      // (uniform-density: x d³/R³ of the point value) — without this, the
      // point-mass interior pull (~380 at half depth) makes every dive
      // terminal; with it, escape is hard but genuinely possible.
      if (b.ptype === 'gas' && d < b.radius) {
        const q = d / b.radius;
        w *= q * q * q;
      }
    }
    const inv = (w * CFG.G * b.mass) / (d2 * d);
    ax += dx * inv; ay += dy * inv;
    // Non-star portion, stashed for the gravity compass: the sun's ambient
    // pull is everywhere and obvious — worlds are what's worth pointing at
    if (!star) { pax += dx * inv; pay += dy * inv; }
  }
  _g.ax = ax; _g.ay = ay;
  _gp.ax = pax; _gp.ay = pay;
  return _g;
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
    const d2 = dx * dx + dy * dy + SOFT2;
    const inv = (w * CFG.G * b.mass) / (d2 * Math.sqrt(d2));
    ax += dx * inv; ay += dy * inv;
  }
  _g.ax = ax; _g.ay = ay;
  return _g;
}

// Soft boundary: everything beyond WORLD_R gets nudged back toward the center
// (squared-distance early-out first — nearly everything is inside the world)
const WORLD_R2 = CFG.WORLD_R * CFG.WORLD_R;
const _bnd = { ax: 0, ay: 0 };
function boundaryAccel(x, y) {
  if (x * x + y * y < WORLD_R2) return null;
  const d = Math.sqrt(x * x + y * y);
  const over = (d - CFG.WORLD_R) / 1000;
  const k = 25 * (1 + over * over);
  _bnd.ax = (-x / d) * k; _bnd.ay = (-y / d) * k;
  return _bnd;
}

// ---------- collisions ----------

function collideBodies(game, a, b) {
  // A parry-frozen rock is pinned at the ship's hull — nothing grinds it
  // (or gets ground by it) until the flick launches it back into play.
  if (a.parryFrozen || b.parryFrozen) return;
  // Orbiting shield rocks don't grind against each other
  if (a.heldBy === 'orbit' && b.heldBy === 'orbit') return;
  // ...and your own throws (or the rock in your beam) pass through your
  // shield instead of smashing it on the way out. Alien throws still connect.
  const aOwn = (a.thrownBy === 'player' && a.thrownTimer > 0) || a.heldBy === 'player';
  const bOwn = (b.thrownBy === 'player' && b.thrownTimer > 0) || b.heldBy === 'player';
  if ((a.heldBy === 'orbit' && bOwn) || (b.heldBy === 'orbit' && aOwn)) return;
  // Twin Grip: your two beam-held rocks don't grind against each other
  if (a.heldBy === 'player' && b.heldBy === 'player') return;
  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return;
  const d = Math.sqrt(d2) || 0.001;
  const overlap = rr - d;

  // Stars vaporize anything they touch
  if (a.type === 'star' || b.type === 'star') {
    const victim = a.type === 'star' ? b : a;
    if (victim.type !== 'star') vaporize(game, victim);
    return;
  }

  const nx = dx / d, ny = dy / d;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const closing = -(rvx * nx + rvy * ny);

  // ICE QUENCHES EMBER: any icy rock (ring chunk, geyser pop, comet) landing
  // on an infested planet smothers its reefs — thrown ice hits harder.
  for (const [pl, rk] of [[a, b], [b, a]]) {
    if (pl.type === 'planet' && pl.ember > 0 && (rk.ice || rk.comet)) {
      const potency = (rk.mass / 6000) * (rk.thrownTimer > 0 ? 1.6 : 1);
      pl.ember = Math.max(0, pl.ember - potency);
      addParticles(game, rk.x, rk.y, pl.vx * 0.5, pl.vy * 0.5, 16, '#bfeffc', 170, 0.9);
      if (pl.ember <= 0.01) {
        pl.ember = 0;
        pl.emberSeeded = false;
        // Cleanse bounty only if YOU lobbed the ice — ambient ice still
        // smothers the reef, it just earns no salvage (scrap is player-earned).
        if (rk.thrownBy === 'player' && rk.thrownTimer > 0) {
          dropScrap(game, rk.x, rk.y, pl.vx * 0.6, pl.vy * 0.6, 150);
        }
        game.emberCleansedName = pl.name;
      }
    }
  }

  // Shield rocks earn XP by intercepting incoming alien throws
  if (closing > 50 &&
      ((a.heldBy === 'orbit' && b.thrownBy === 'alien' && b.thrownTimer > 0) ||
       (b.heldBy === 'orbit' && a.thrownBy === 'alien' && a.thrownTimer > 0))) {
    addXp(game, PROG.XP_BLOCK);
    // AEGIS REFLECTOR (hauler): don't just block — hurl the enemy rock straight
    // back out as YOUR shot (marked player-thrown, so it can smash the alien).
    // Once reflected it's no longer 'alien', so this can't re-fire on it.
    if (game.st.aegis > 0) {
      const rock = a.thrownBy === 'alien' ? a : b;
      const sh = game.ship;
      const rdx = rock.x - sh.x, rdy = rock.y - sh.y, rd = Math.hypot(rdx, rdy) || 1;
      const spd = 320 + 130 * game.st.aegis;
      rock.vx = sh.vx + (rdx / rd) * spd; rock.vy = sh.vy + (rdy / rd) * spd;
      rock.thrownBy = 'player'; rock.thrownTimer = 3;
      derail(rock);
    }
  }

  // No surface-hugging: a small body drifting gently onto a much bigger one
  // is absorbed (either you're in orbit, or you're part of the planet now).
  if (closing >= 0 && closing < 70) {
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    if (big.mass >= small.mass * 15 && !small.heldBy && small.type !== 'rogue' &&
        small.type !== 'station' && small.type !== 'nest' &&   // artificial structures don't melt into planets
        !small.majorComet) {   // ...and the landmark comet bounces off worlds instead of melting into them
      small.alive = false;
      if (small === game.held) game.held = null;
      if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'absorbed', type: small.type, mass: Math.round(small.mass) });
      // No scrap: a rock gently melting into a planet is ambient, not a smash
      addParticles(game, small.x, small.y, big.vx * 0.5, big.vy * 0.5, 10, small.color, 90, 0.7);
      return;
    }
  }

  // In very lopsided collisions the heavy body is immovable — otherwise the
  // constant rain of ambient asteroid bumps random-walks planet orbits. The
  // 20x rule alone stopped covering that once boulder-class rocks (2600-6000)
  // and magma bombs (700-1900) joined the belt: vs the small inner worlds
  // (2e4/4e4) they sit INSIDE 20x, and one fast hit — or a SILENT
  // sub-DMG_THRESH bump (closing 25-240: no damage, no log, full impulse) —
  // kicks ~30-70 u/s off a ~150 u/s orbit. Artillery fallback shells and
  // bomb-caromed boulders sun-dived the r=3600/5000 lava worlds in ship-alive
  // soaks ("vaporized by star" ~3 min in). So: NO un-thrown asteroid ever
  // moves a celestial, at any mass ratio. Thrown rocks keep full impulse
  // (planet billiards stay glorious), and rogue drive-bys / celestial-vs-
  // celestial crunches keep their damped shoves — those are intended drama.
  const celestial = (x) => x.type === 'planet' || x.type === 'moon' || x.type === 'rogue' || x.majorComet;
  const natRock = (x) => x.type === 'asteroid' && x.thrownTimer <= 0;
  const aMoves = a.mass < b.mass * 20 && !(celestial(a) && natRock(b));
  const bMoves = b.mass < a.mass * 20 && !(celestial(b) && natRock(a));

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
    // Lopsided impacts bounce HARDER: the more dominant the heavy body, the
    // livelier the light one is flung away (e: 0.35 equal -> ~0.75 extreme).
    const dom = Math.max(a.mass, b.mass) / (a.mass + b.mass);
    const e = CFG.RESTITUTION * (1 + (dom - 0.5) * 2.3);
    const invA = aMoves ? 1 / a.mass : 0;
    const invB = bMoves ? 1 / b.mass : 0;
    let j = ((1 + e) * closing) / (invA + invB || 1);
    // majorComet (Vesper) counts as a celestial here: its eccentric orbit
    // crosses the inner planets every pass, and at mass 2400 vs the 2e4 lava
    // world (8x — both movable) an undamped natural bounce shoves the planet
    // hard enough to walk its perihelion into the sun over repeated hits.
    // It ALSO damps natural hits on Vesper from plain rocks: an undamped
    // belt-asteroid strike moved Vesper ~100 u/s per hit, and crossing two
    // belts twice per orbit random-walked its perihelion into the sun.
    // (Both plain-rock cases are now fully shadowed by the stronger natRock
    // immovability above — un-thrown asteroids can't move any celestial,
    // Vesper included. This damp still matters for celestial-vs-celestial.)
    // Player throws (thrownTimer) keep full impulse in every case.
    if (a.thrownTimer <= 0 && b.thrownTimer <= 0 &&
        ((celestial(a) && celestial(b)) || a.majorComet || b.majorComet)) {
      j *= 0.25;
    }
    a.vx -= j * invA * nx; a.vy -= j * invA * ny;
    b.vx += j * invB * nx; b.vy += j * invB * ny;

    // Impact damage — each takes damage scaled by the other's mass, but only
    // above the closing-speed threshold (thrown objects hit harder & easier).
    // Credit is per-body (see collisionCredit): the rock your throw smashes
    // earns scrap + fling; your own projectile shattering earns scrap only;
    // ambient belt traffic earns nothing.
    const creditA = collisionCredit(a, b);
    const creditB = collisionCredit(b, a);
    // GRAVITY BILLIARDS: a rock knocked hard by your throw (or a chain-link)
    // inherits your credit for a beat, so the NEXT rock it smashes still counts
    // as yours — trick shots chain. Only ASTEROIDS carry it (never moons/
    // planets, which would then take undamped impulses and wander).
    if (closing > 60) {
      const aPlayer = (a.thrownBy === 'player' && a.thrownTimer > 0) || a.heldBy === 'orbit';
      const bPlayer = (b.thrownBy === 'player' && b.thrownTimer > 0) || b.heldBy === 'orbit';
      if (aPlayer && bMoves && b.type === 'asteroid' && b.thrownBy !== 'player') {
        b.thrownBy = 'player'; b.thrownTimer = Math.max(b.thrownTimer, 1.4);
      }
      if (bPlayer && aMoves && a.type === 'asteroid' && a.thrownBy !== 'player') {
        a.thrownBy = 'player'; a.thrownTimer = Math.max(a.thrownTimer, 1.4);
      }
    }
    const thrown = a.thrownTimer > 0 || b.thrownTimer > 0;
    const eff = Math.max(0, closing - (thrown ? CFG.DMG_THRESH_THROWN : CFG.DMG_THRESH));
    const mult = thrown ? CFG.DMG_THROWN_MULT : 1;
    // Mass dominance decides who hurts whom: the heavier side deals up to
    // ~2x its base damage while taking almost none from the lighter side.
    // Equal masses keep the old numbers (both factors are 1 at 50/50).
    // Natural (un-thrown) impacts are damped so hard ambient hits usually
    // CRUNCH (survive + spall fragments) rather than kill — deliberate
    // throws keep full lethality on top of their own threshold/multiplier.
    const domA = b.mass / (a.mass + b.mass);   // how dominant the OTHER body is
    const natural = thrown ? 1 : 0.55;
    let dmgToA = CFG.DMG_BODY * eff * eff * b.mass * mult * natural * 2 * domA;
    let dmgToB = CFG.DMG_BODY * eff * eff * a.mass * mult * natural * 2 * (1 - domA);
    // Comparable-mass natural hits never one-shot: cap at 70% of remaining
    // hp so they crunch (and spall, below) instead of vanishing. Truly
    // lopsided impacts (8x+) keep their insta-crush — big IS stronger.
    const ratio = Math.max(a.mass, b.mass) / Math.min(a.mass, b.mass);
    if (!thrown && ratio < 8) {
      dmgToA = Math.min(dmgToA, a.hp * 0.7);
      dmgToB = Math.min(dmgToB, b.hp * 0.7);
    }
    // Magma-born ordnance (planet artillery, forge plumes — world.js
    // magmaBorn) doesn't wound celestials on its own either: damageBody
    // derails on ANY chip, and a lava world slowly shelling itself apart (or
    // ambient bombs chewing a Bastion fort) is the same regression in slow
    // motion. Thrown bombs are ordinary rocks — the dense-sling-rock loot
    // loop keeps full effect. The bomb itself still takes full damage.
    if (celestial(a) && b.magmaBorn && b.thrownTimer <= 0) dmgToA = 0;
    if (celestial(b) && a.magmaBorn && a.thrownTimer <= 0) dmgToB = 0;
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
    // WALL SPLAT context: flag YOUR live throw dying AGAINST a world (its own
    // shatter credit is only 'player' — own-projectile — so shatter can't tell
    // a splat from open-space fragmentation without this). Set/cleared around
    // the synchronous damage call — never persists.
    const splats = (x, other) => x.thrownBy === 'player' && x.thrownTimer > 0 && celestial(other);
    if (dmgToA > 0.5) {
      a.splatWall = splats(a, b);
      damageBody(game, a, dmgToA, creditA, b.x, b.y);
      a.splatWall = false;
    }
    if (dmgToB > 0.5) {
      b.splatWall = splats(b, a);
      damageBody(game, b, dmgToB, creditB, a.x, a.y);
      b.splatWall = false;
    }
    if (closing > 60 && (a.mass > 1e4 || b.mass > 1e4)) addShake(game, 3);

    // SPALL: a violent hit that BOTH bodies survive still crunches — small
    // rocks spray sideways out of the impact, chipped off the lighter body.
    if (eff > 40 && a.alive && b.alive && game.bodies.length < 450) {
      const small = a.mass <= b.mass ? a : b;
      if (small.mass > 120 && small.type !== 'station' && small.type !== 'nest' &&
          Math.random() < 0.75) {
        const cx = a.x + nx * a.radius, cy = a.y + ny * a.radius;   // contact point
        const cvx = (a.vx + b.vx) / 2, cvy = (a.vy + b.vy) / 2;
        const nFrag = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < nFrag; k++) {
          const m = Math.min(400, Math.max(15, small.mass * (0.015 + Math.random() * 0.03)));
          // spray perpendicular to the impact normal, either side
          const th = Math.atan2(ny, nx) + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2)
            + (Math.random() - 0.5) * 1.2;
          const sp = 80 + Math.random() * 160 + eff * 0.4;
          const f = spawnAsteroid(game.bodies,
            cx + Math.cos(th) * (small.radius * 0.8 + 6),
            cy + Math.sin(th) * (small.radius * 0.8 + 6),
            cvx + Math.cos(th) * sp, cvy + Math.sin(th) * sp, m);
          f.color = small.color;
        }
        small.mass = Math.max(small.baseMass * 0.25, small.mass * 0.96);
        small.radius = small.baseRadius * Math.cbrt(small.mass / small.baseMass);
        addParticles(game, cx, cy, cvx, cvy, 6, small.color, 120, 0.6);
      }
    }
  }
}

function collideShipBody(game, s, b, dt) {
  const dx = b.x - s.x, dy = b.y - s.y;
  const rr = s.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 > rr * rr) return;
  const d = Math.sqrt(d2) || 0.001;

  // Stars have no wall for the SHIP: no bounce, no instant kill — you fly
  // straight INTO the photosphere, and the corona heat (whose exponential
  // ramp keeps climbing past the surface) melts you down mid-plunge. Bodies
  // and aliens still vaporize on contact; only the ship gets the long dive.
  if (b.type === 'star') return;

  // GAS DIVE: gas giants have no surface for the SHIP — it flies straight
  // in. Pressure crushes with depth² and dense atmosphere drags the ship
  // toward the planet's frame; the core is instant death, everything above
  // it is a fight you can still win. (Rocks/aliens keep the solid bounce.)
  if (b.ptype === 'gas') {
    if (d < b.radius * CFG.GAS_CORE) {
      damageShip(game, 99999, `Crushed at the core of ${b.name || 'a gas giant'}.`);
      return;
    }
    const depth = Math.min(1, 1 - (d - b.radius * CFG.GAS_CORE) / (b.radius * (1 - CFG.GAS_CORE)));
    if (s.invuln <= 0) {
      damageShip(game, depth * depth * CFG.GAS_CRUSH_DPS * dt,
        `Crushed in the depths of ${b.name || 'a gas giant'}.`);
    }
    // Dense air drags HARD from the first deck down — the giant grabs you
    // and pulls you into its frame; thrust is how you argue with it
    const drag = Math.min(0.95, 0.35 + depth * 1.1) * dt;
    s.vx += (b.vx - s.vx) * drag; s.vy += (b.vy - s.vy) * drag;
    // ENTRY: punching through the cloud tops is a full-screen moment —
    // flash + shock rings (render reads gasEnterT) + a hull-rattling jolt
    if (!(game.gasDiveT > 0)) {
      game.gasEnterT = 0.8;
      addShake(game, 14);
      sfx.sfxBoom(1.3);
    }
    game.gasDiveT = 0.2;
    game.gasDiveDepth = depth;
    game.gasDiveBody = b;
    if (!game.tut.gasdive) game.gasDiveWarn = true;
    // Turbulence: the deep decks batter the hull and cloud-stuff streams
    // past — throttled particle cadence, not per-substep
    addShake(game, depth * 0.6);
    game.gasFxT = (game.gasFxT ?? 0) - dt;
    if (game.gasFxT <= 0) {
      game.gasFxT = 0.05;
      const rvx2 = b.vx - s.vx, rvy2 = b.vy - s.vy;
      addParticles(game,
        s.x + (Math.random() - 0.5) * 130, s.y + (Math.random() - 0.5) * 130,
        s.vx + rvx2 * 0.5 + (Math.random() - 0.5) * 90,
        s.vy + rvy2 * 0.5 + (Math.random() - 0.5) * 90,
        2, b.color, 60, 0.6, 3);
    }
    return;
  }
  // Direction of this contact (ship -> body), for the front-arc shield check
  const hitAng = Math.atan2(dy, dx);
  // Touching a live Bastion shield zaps you on top of the normal bounce
  if (b.fort && b.fort.shield > 0) damageShip(game, 10, 'Zapped by a Bastion fortress shield.', hitAng);
  if (b === game.held) return;      // held object can't crush you
  if (b.heldBy === 'orbit') return; // your own shield can't crush you either
  if (b.thrownBy === 'player' && b.thrownTimer > 0) return; // your own throws pass through you
  if (b.parryFrozen) return;        // the parried rock is pinned at the hull — no re-collide

  const nx = dx / d, ny = dy / d;
  const rvx = b.vx - s.vx, rvy = b.vy - s.vy;
  const closing = -(rvx * nx + rvy * ny);

  // (The Deflector parry catches BEFORE contact — updateParry's front-arc
  // field scan — so a rock reaching this code either isn't deflectable or
  // slipped in during the cooldown, and the impact resolves normally.)

  // Push the ship out (bodies barely notice the ship)
  const overlap = s.radius + b.radius - d;
  s.x -= nx * overlap; s.y -= ny * overlap;

  // SURFACE SKIMMING: sliding along a surface in contact grinds the hull.
  // The normal bounce only bites above a CLOSING speed, so a fast tangential
  // graze was completely free — now it sparks and ticks damage (per-substep,
  // so damageShip's dmg>=1 gate keeps the hit sfx/shake from 120Hz spam).
  {
    const tvx = rvx + closing * nx, tvy = rvy + closing * ny;   // tangential slide
    const vT = Math.hypot(tvx, tvy);
    if (vT > CFG.SKIM_SPEED && s.invuln <= 0) {
      const grind = (vT - CFG.SKIM_SPEED) * CFG.SKIM_DPS_K * dt;
      damageShip(game, grind, `Ground apart skimming ${b.name || 'a ' + b.type}.`, hitAng);
      // Skating a surface is risky XP — and BANDED MOONS are the skate park:
      // same grind, same hull cost, triple the payout.
      const banded = b.type === 'moon' && b.moonType === 'banded';
      addXp(game, grind * PROG.XP_SKIM * (banded ? PROG.XP_SKIM_BANDED : 1));
      if (banded && !game.tut.banded) game.bandedWarn = true;

      game.scrapeT = 0.18;                                       // render: contact glow
      game.scrapeX = s.x + nx * s.radius; game.scrapeY = s.y + ny * s.radius;
      if (!game.tut.scrape) game.scrapeWarn = true;
      game.scrapeFxT = (game.scrapeFxT ?? 0) - dt;
      if (game.scrapeFxT <= 0) {
        game.scrapeFxT = 0.06;                                   // spark cadence, not per-substep
        addParticles(game, game.scrapeX, game.scrapeY,
          -tvx * 0.35 + b.vx, -tvy * 0.35 + b.vy, 2, '#ffcf7a', 90, 0.35, 2);
      }
    }
  }

  if (closing > 0) {
    // Ship bounces away, scaled by the impactor's mass and hard-capped — a
    // flat closing*1.3 kick let alien-thrown rocks launch the ship at 900+.
    const mEff = Math.min(b.mass, 4e5);
    const kick = Math.min(200, closing * 1.35 * (mEff / (mEff + 900)));
    s.vx -= nx * kick; s.vy -= ny * kick;

    // Audible contact even when the bounce does no damage — gentle hits are
    // damage-free by design (invariant 3), but the clank must still say
    // "you touched it". sfxBump self-throttles against substep repeats.
    sfx.sfxBump((closing / 300) * (0.35 + 0.65 * (b.mass / (b.mass + 2000))));


    // NEWTON'S OTHER HALF: the impact moves and damages the BODY too. The
    // ship's effective ram mass grows with level — a scout nudges pebbles,
    // a titan bulldozes boulders. Planets barely notice (mass ratio kills
    // the kick before it can derail anything heavy), so orbits stay safe.
    const shipM = 30 + game.st.totalLevel * 25;
    const bKick = Math.min(260, closing * 1.1 * (shipM / (shipM + b.mass)));
    if (bKick > 6) {
      if (closing > 25) derail(b);
      b.vx += nx * bKick; b.vy += ny * bKick;
    }
    const effB = Math.max(0, closing - 100);
    // RAM PROW / JUGGERNAUT boost the ram (st.ramMul); BERSERKER adds more as the
    // ship's hull drops. Brawler-only — and the brawler's ramMul/ramArmor have an
    // INNATE spec-DNA floor (config.shipStats), so it bonks from frame one even
    // before Ram Prow ranks (other specs stay at exactly 1 / 1).
    const ramHullFrac = clamp(s.hull / Math.max(1, game.st.maxHull), 0, 1);
    const aggro = game.st.ramMul * (game.st.berserk > 0 ? 1 + game.st.berserk * 0.3 * (1 - ramHullFrac) : 1);
    const ramDmg = CFG.DMG_BODY * effB * effB * shipM * 2 * aggro;
    // Ramming is "running into things", not a throw — it damages the body but
    // pays out NO scrap and no fling growth (credit 'ram', not 'player').
    if (ramDmg > 0.5) damageBody(game, b, ramDmg, 'ram', s.x, s.y);

    const thrown = b.thrownTimer > 0 && b.thrownBy === 'alien' ? 1.25 : 1;
    // Graded, not binary: damage scales with closing speed and a SATURATING
    // mass factor, so a planet bump stings (~25) and a planet slam hurts
    // (~70) without instantly gutting the hull. Capped at 45% per hit.
    // The saturation knee grows with beam tier: a dreadnought shrugs off
    // the pebbles that used to sting the scout — big slams always hurt.
    const massSat = b.mass / (b.mass + 1500 * (1 + game.st.tier * 1.2));
    // RAM PROW / JUGGERNAUT: a reinforced prow takes less from impacts (ramArmor
    // <= 1; exactly 1 for non-ram builds, so nothing else changes).
    const dmg = Math.min(CFG.DMG_SHIP * closing * massSat * thrown * game.st.ramArmor,
      game.st.maxHull * 0.45);
    if (dmg > 1.5 && closing > 25) {
      damageShip(game, dmg, b.type === 'rogue' ? 'Flattened by a rogue planet.' :
        thrown > 1 ? 'Hit by an alien-thrown rock.' :
        `Collided with ${b.type === 'asteroid' ? 'an' : 'a'} ${b.type}.`, hitAng);
    }
  }
}

// DEFLECTOR PARRY — a FRONT-ARC field, not a contact reaction: each substep
// the field scans for rocks closing on the nose (within PARRY_ARC of the
// heading, inside hull + st.deflectReach) and freezes them where they are.
// Capacity is the rank (rank 2 can hold two rocks mid-freeze, rank 3 three)
// and late arrivals JOIN the running window rather than restarting it, so a
// volley of alien throws freezes as a volley. While a session is live: every
// rock is pinned at its capture bearing/distance riding with the ship (no
// teleport to the hull — it freezes where the field caught it), the nose is
// locked (the steering block checks game.parry), and the mouse is repurposed
// as a FLICK — direction read from RAW SCREEN deltas (game.mouseSX/SY,
// stashed by main.js), never from game.aim: the camera chases the ship, so
// world-space aim deltas are contaminated by camera motion and a stationary
// mouse would read as a flick. Launch fires on a decisive flick (snappy for
// skilled hands) or at window's end: a flick hurls EVERY held rock that way
// (the riposte volley); no flick sends each back out along its own capture
// bearing. Screen axes map to world axes (translate+scale only), so the
// screen direction IS the world direction. Deflectable = the same loose-rock
// filter as everywhere (asteroid, never Vesper, not held/own-throw) plus the
// beam-scale mass cap — render.drawDeflectable mirrors this exactly for the
// incoming-rock indicator; keep them in sync or the hint lies.
const PARRY_ARC = 1.05;   // half-angle around the nose (~60°) — "in front of the ship"
// Screen-pixels of mouse travel that count as a deliberate FLICK (launches
// early). Tuned UP twice — 46 fired on an ordinary aiming twitch, and even
// 120 still felt hair-triggered (user: "even further before triggering").
// Below it, motion only AIMS; the launch then waits for the window.
// render.drawParry imports this so the arrow fills toward the real threshold.
export const PARRY_FLICK = 210;
function parryEligible(game, b) {
  const s = game.ship;
  return b.alive && b.type === 'asteroid' && !b.majorComet && !b.heldBy &&
    !b.parryFrozen && !(b.thrownBy === 'player' && b.thrownTimer > 0) &&
    b.mass <= game.st.capacity * 1.5 &&
    Math.abs(angDiff(Math.atan2(b.y - s.y, b.x - s.x), s.angle)) <= PARRY_ARC;
}
function updateParry(game, dt) {
  if (game.parryCd > 0) game.parryCd -= dt;
  const s = game.ship, st = game.st;

  // Field scan: start a session, or grow a live one up to capacity
  if (st.deflect > 0 && s.alive && s.invuln <= 0 && !(game.parryCd > 0) &&
      (!game.parry || game.parry.rocks.length < st.deflect)) {
    const reach = st.deflectReach;
    for (const b of game.bodies) {
      if (game.parry && game.parry.rocks.length >= st.deflect) break;
      // Cheap squared-distance cull FIRST — this scan runs per substep over
      // every body, and parryEligible costs an atan2.
      const dx = b.x - s.x, dy = b.y - s.y;
      const rr = s.radius + b.radius + reach;
      if (dx * dx + dy * dy > rr * rr) continue;
      if (!parryEligible(game, b)) continue;
      const d = Math.hypot(dx, dy) || 0.001;
      const nx = dx / d, ny = dy / d;
      const closing = -((b.vx - s.vx) * nx + (b.vy - s.vy) * ny);
      if (closing <= 60) continue;               // drifting past, not incoming
      if (!game.parry) {
        game.parry = { t: 0, window: st.deflectWindow, rocks: [],
          mx0: game.mouseSX ?? 0, my0: game.mouseSY ?? 0 };
      }
      game.parry.rocks.push({ b, nx, ny, hold: Math.max(d, s.radius + b.radius + 4) });
      b.parryFrozen = true;
      derail(b);
      b.vx = s.vx; b.vy = s.vy;                  // caught: it rides with the ship
      b.thrownBy = null; b.thrownTimer = 0;      // an alien throw is CAUGHT, not still hostile
      s.shieldHitT = 0.35;                       // absorb-ripple grammar — event motion only
      addShake(game, 5);
      sfx.sfxShieldHit();
      addParticles(game, b.x, b.y, s.vx * 0.5, s.vy * 0.5, 10, '#9fd6ff', 120, 0.5, 3);
      if (!game.tut.parry) game.parryWarn = true;   // main.js announces (first time)
    }
  }

  const p = game.parry;
  if (!p) return;
  // Drop rocks that died mid-freeze (heat, a chain-kill); ship death ends it
  p.rocks = p.rocks.filter((r) => (r.b.alive ? true : (r.b.parryFrozen = false, false)));
  if (!p.rocks.length || !s.alive) {
    for (const r of p.rocks) r.b.parryFrozen = false;
    game.parry = null;
    return;
  }
  for (const r of p.rocks) {   // pin each at its capture bearing, riding along
    r.b.x = s.x + r.nx * r.hold; r.b.y = s.y + r.ny * r.hold;
    r.b.vx = s.vx; r.b.vy = s.vy;
  }
  p.t += dt;
  const fx = (game.mouseSX ?? 0) - p.mx0, fy = (game.mouseSY ?? 0) - p.my0;
  const mag = Math.hypot(fx, fy);
  if (p.t >= p.window || mag > PARRY_FLICK) {
    const flicked = mag > 12;
    const fdx = flicked ? fx / mag : 0, fdy = flicked ? fy / mag : 0;
    for (const r of p.rocks) {
      const b = r.b;
      const dx = flicked ? fdx : r.nx, dy = flicked ? fdy : r.ny;
      b.parryFrozen = false;
      b.vx = s.vx + dx * st.deflectPower;
      b.vy = s.vy + dy * st.deflectPower;
      b.thrownBy = 'player'; b.thrownTimer = 2.5;  // the riposte is YOUR shot — full billiards credit
      addXp(game, PROG.XP_PARRY);                  // good play pays — per rock, at the launch
      addParticles(game, b.x, b.y, b.vx * 0.3, b.vy * 0.3, 12, '#9fd6ff', 200, 0.7, 3);
    }
    game.parry = null;
    game.parryCd = 2.5;                          // fixed — ranks buy field/slots/window/power, not uptime
    addShake(game, 4 + 2 * p.rocks.length);
    sfx.sfxFling();
  }
}

function collideAlienBody(game, al, b) {
  if (b === al.target) return;   // never collide with its own ammo (incl. during fetch approach)
  const dx = b.x - al.x, dy = b.y - al.y;
  const rr = al.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 > rr * rr) return;
  const d = Math.sqrt(d2) || 0.001;

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
          addXp(game, PROG.XP_SMASH);
          game.prog.smashes++;
        }
      }
    }
  }
}

// ---------- main step ----------

const _sweep = [];       // collision broad-phase scratch (reused every substep)
const _attractors = [];  // attractor list scratch (reused every substep)
// Hoisted sort comparator — the sweep sorts every substep; an inline arrow
// would allocate a fresh closure 120 times a second for nothing.
const _byLeftEdge = (a, b) => (a.x - a.radius) - (b.x - b.radius);
let nanWarned = false;   // the NaN tripwire below warns once per session

export function step(game, dt) {
  const bodies = game.bodies;
  const attractors = _attractors;
  attractors.length = 0;
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
      } else if (!b.heldBy && b.thrownTimer <= 0 && b.liveT > 6 && !b.majorComet && !b.shepherd &&
                 (b.type === 'asteroid' || b.type === 'moon' || b.type === 'planet' ||
                  b.type === 'station' || b.type === 'nest')) {
        // (majorComet — Vesper — is excluded: a hard knock can leave its
        // orbit momentarily near-circular, and railing it would freeze the
        // long-period comet onto a circle forever. It free-flies for life.
        // The shepherd is excluded too: this scan's railBody would silently
        // rebase homeR to wherever it happens to be — its install-path snap
        // is the only one allowed to re-rail it, back in its true lane.)
        // Never re-rail on-screen: a flung rock snapping onto a circular
        // orbit in front of the player reads as "it just stopped mid-flight"
        if (Math.hypot(b.x - game.ship.x, b.y - game.ship.y) <
            (game.viewR || 1200) * 1.15 + 300) continue;
        // Try to re-rail around the natural parent
        // Re-rail around the natural parent: moons/stations/nests around
        // their planet, a binary companion around its primary, everything
        // else (and orphans) around the sun
        const parent = (b.parent && b.parent.alive) ? b.parent : game.homeStar;
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
    // majorComet (Vesper) rides the weighted path as an honorary celestial:
    // under full planet gravity, gravitational focusing funneled it into a
    // planet impact or a sun plunge every ~15 minutes. CROSS_GRAV keeps its
    // long ellipse stable the same way it keeps every other orbit stable.
    const weighted = b.type === 'planet' || b.type === 'moon' || b.type === 'rogue' || b.majorComet;
    const g = weighted ? gravityOnBody(attractors, b) : gravityAt(attractors, b.x, b.y);
    b.ax = g.ax + b.extAx; b.ay = g.ay + b.extAy;

    // INSTALLATIONS (stations, nests, fortified moons) don't wander when
    // knocked loose — station-keeping thrusters drive them straight back
    // toward their home orbit, and they re-rail as soon as they're close.
    // The ring SHEPHERD keeps station too: it must hold its lane, or ambient
    // knocks (not the player) would scatter the ring it exists to shepherd.
    const install = b.type === 'station' || b.type === 'nest' || b.fort || b.shepherd;
    if (install && !b.heldBy && b.thrownTimer <= 0 && b.parent && b.parent.alive) {
      const p = b.parent;
      const dx = b.x - p.x, dy = b.y - p.y;
      const r = Math.hypot(dx, dy) || 1;
      const homeR = b.homeR || r;
      const ux = dx / r, uy = dy / r;
      const rvx = b.vx - p.vx, rvy = b.vy - p.vy;
      const side = Math.sign(ux * rvy - uy * rvx) || 1;
      const vC = Math.sqrt((CFG.G * p.mass * homeR * homeR) /
        Math.pow(homeR * homeR + CFG.GRAV_SOFT ** 2, 1.5));
      const desVx = p.vx + (-uy * side) * vC + ux * (homeR - r) * 1.2;
      const desVy = p.vy + (ux * side) * vC + uy * (homeR - r) * 1.2;
      let cx = (desVx - b.vx) * 2.5, cy = (desVy - b.vy) * 2.5;
      const cm = Math.hypot(cx, cy);
      if (cm > 300) { cx *= 300 / cm; cy *= 300 / cm; }
      b.ax += cx; b.ay += cy;
      // Snap back onto the rail once the orbit is close enough
      const vT = ux * rvy - uy * rvx, vR = ux * rvx + uy * rvy;
      if (b.liveT > 1.5 && Math.abs(r - homeR) < homeR * 0.08 &&
          Math.abs(Math.abs(vT) - vC) < vC * 0.3 && Math.abs(vR) < vC * 0.3) {
        b.vx = p.vx - uy * side * vC;
        b.vy = p.vy + ux * side * vC;
        railBody(b, p);
        b.homeR = homeR;
      }
    }

    // (No mid-flight guidance and no angle adjustment: thrown rocks fly
    // straight at the cursor. The assist is the ✕ lead markers the UI
    // draws from tractor.aimSolutions — the player releases on the ✕.)
    // Star-anchored bodies are held by their sun, never the map edge — the
    // boundary force would deorbit outer planets of off-center systems.
    // noBoundary marks the interstellar visitor: the edge force would bend
    // its hyperbolic pass into a captured orbit and it could never leave.
    if (!(b.parent && (b.type === 'planet' || b.type === 'moon')) && !b.noBoundary) {
      const bnd = boundaryAccel(b.x, b.y);
      if (bnd) { b.ax += bnd.ax; b.ay += bnd.ay; }
    }
  }

  const s = game.ship;
  let shipAx = 0, shipAy = 0;
  if (s.alive) {
    // The nose tracks the mouse; W thrusts forward, S thrusts backward.
    // NOSE LOCK during a Deflector parry: the mouse is being read as the
    // flick (updateParry), so the ship must NOT also turn with it — steering
    // and flicking off one input at once feels like the ship fighting you.
    if (!game.parry) {
      const aimAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
      s.angle += clamp(angDiff(s.angle, aimAng), -CFG.SHIP_TURN * dt, CFG.SHIP_TURN * dt);
    }

    let th = game.st.thrust;
    const c = game.controls;
    // Flare EMP: fried engines answer to nobody for a few seconds
    if (s.engineOutT > 0) s.engineOutT -= dt;
    // AFTERBURNER (scout): a FUEL-TANK burn, not a free hold — main.js drains
    // game.burnerFuel and sets game.burnerOn (never read raw Shift here, or
    // thrust and the BURN bar disagree). The burn is much harder than the old
    // hold-Shift overdrive because the tank makes it scarce.
    const boosting = game.burnerOn && s.engineOutT <= 0;
    if (boosting) th *= 1.75 + 0.35 * game.st.afterburner;
    // Reverse thrust is an UPGRADE (Retro Thrusters) — until unlocked, S does
    // nothing and only forward thrust drives the ship.
    const back = game.st.hasReverse ? c.b : 0;
    let throttle = s.engineOutT > 0 ? 0 : c.f - back;
    if (boosting) throttle = Math.max(throttle, 1);   // Shift alone dashes forward
    s.thrusting = throttle > 0;
    s.braking = throttle < 0;
    const tx = Math.cos(s.angle) * th * throttle;
    const ty = Math.sin(s.angle) * th * throttle;

    // Afterburner exhaust wash: hot particles streaming off the stern.
    // Throttled cadence — this runs at 120Hz (render adds the plume art).
    if (boosting && s.thrusting) {
      game.burnFxT = (game.burnFxT ?? 0) - dt;
      if (game.burnFxT <= 0) {
        game.burnFxT = 0.035;
        addParticles(game,
          s.x - Math.cos(s.angle) * s.radius * 1.7,
          s.y - Math.sin(s.angle) * s.radius * 1.7,
          s.vx * 0.35 - Math.cos(s.angle) * 340,
          s.vy * 0.35 - Math.sin(s.angle) * 340,
          2, Math.random() < 0.55 ? '#9fd6ff' : '#ffd27a', 130, 0.5, 2.5);
      }
    }

    // REFLEX JINK (scout): when the charge is ready and a rock is about to
    // hit, the ship sidesteps ON ITS OWN — brief i-frames, slow recharge
    // (game.autoEvadeT, ticked down in main.js). Closest-approach test, not
    // just proximity: only things genuinely on a collision course trigger it,
    // and only fast ones — slow drift bounces harmlessly anyway (DMG thresh).
    if (game.st.autoEvade > 0 && game.autoEvadeT <= 0 && s.invuln <= 0) {
      for (const b of bodies) {
        if (!b.alive || b.heldBy || b.type === 'star') continue;
        if (b.thrownBy === 'player' && b.thrownTimer > 0) continue;  // passes through us anyway
        if (b.mass < 200) continue;                                  // too light to matter
        const dx = b.x - s.x, dy = b.y - s.y;
        if (dx > 1100 || dx < -1100 || dy > 1100 || dy < -1100) continue;
        const rvx = b.vx - s.vx, rvy = b.vy - s.vy;
        const v2 = rvx * rvx + rvy * rvy;
        if (v2 < 210 * 210) continue;
        const tc = -(dx * rvx + dy * rvy) / v2;      // time of closest approach
        if (tc <= 0 || tc > 0.45) continue;          // not inbound / not imminent
        const mx = dx + rvx * tc, my = dy + rvy * tc;
        const rr = b.radius + s.radius + 8;
        if (mx * mx + my * my > rr * rr) continue;   // clean miss — let it pass
        // Sidestep AWAY from the pass line; a dead-center shot picks a side.
        const mm = Math.hypot(mx, my);
        const vm = Math.sqrt(v2);
        const ux = mm > 4 ? -mx / mm : -rvy / vm;
        const uy = mm > 4 ? -my / mm : rvx / vm;
        const burst = 430 + 70 * game.st.autoEvade;
        s.vx += ux * burst; s.vy += uy * burst;
        s.invuln = Math.max(s.invuln, 0.3);
        game.autoEvadeT = 15 - 3.5 * game.st.autoEvade;   // 11.5 / 8 / 4.5s recharge
        game.jinkT = 0.3;                                 // render: flash ring
        game.jinkWarn = true;                             // main.js: first-time message
        addParticles(game, s.x, s.y, s.vx * 0.4, s.vy * 0.4, 14, '#9fffe8', 180, 0.6, 3);
        sfx.sfxCollect();
        break;
      }
    }

    // The ship feels amplified gravity — big bodies really grab at you,
    // worlds doubly so and the sun hardest of all
    const g = gravityAt(attractors, s.x, s.y, CFG.STAR_GRAV_SHIP, CFG.PLANET_GRAV_SHIP);
    // Gravity compass source (render.js): WORLDS ONLY — the sun's ambient
    // pull would drown the planet signal everywhere, and the sun is never
    // hard to find. main.js smooths this before display.
    game.shipGx = _gp.ax * CFG.SHIP_GRAV; game.shipGy = _gp.ay * CFG.SHIP_GRAV;
    shipAx = g.ax * CFG.SHIP_GRAV + tx; shipAy = g.ay * CFG.SHIP_GRAV + ty;

    // ORBIT RUBBER BAND (CFG.SHIP_BAND_*): near a world, bleed off the
    // ship's INWARD radial velocity relative to it — plunges soften into
    // captures and near-orbits circularize. Tangential motion and outbound
    // climbs are untouched.
    for (const b of attractors) {
      if (b.type !== 'planet' && b.type !== 'moon' && b.type !== 'rogue') continue;
      const band = b.radius * CFG.SHIP_BAND_RANGE + 300;
      const dx = b.x - s.x, dy = b.y - s.y;
      if (dx > band || dx < -band || dy > band || dy < -band) continue;
      const d = Math.hypot(dx, dy);
      if (d > band || d < b.radius + s.radius) continue;
      const ux = dx / d, uy = dy / d;                              // ship -> world
      const vR = (s.vx - b.vx) * ux + (s.vy - b.vy) * uy;          // >0 = falling in
      if (vR <= 0) continue;
      const t = 1 - (d - b.radius) / (band - b.radius);
      const brake = Math.min(CFG.SHIP_BAND_MAX, vR * CFG.SHIP_BAND_DAMP * t);
      shipAx -= ux * brake; shipAy -= uy * brake;
    }
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

    // Emberkin burning halos: colonized worlds scorch anything flying close
    for (const b of attractors) {
      if (!b.ember || b.ember <= 0.1) continue;
      const d = Math.hypot(s.x - b.x, s.y - b.y);
      if (d < b.radius * 2.2) {
        damageShip(game, 9 * b.ember * dt, 'Burned away by an Emberkin halo.');
      }
    }

    // The Oort cloud grinds ships apart
    const rc = Math.hypot(s.x, s.y);
    if (rc > CFG.WORLD_R && s.invuln <= 0) {
      const dps = CFG.OORT_DPS * (1 + (rc - CFG.WORLD_R) / 900);
      damageShip(game, dps * dt, 'Shredded by the Oort cloud.');
    }

    // CORONA HEAT + lava auras: a sunward approach MELTS the ship well
    // before contact — by the surface there's nothing left to crash. The
    // ship's ramp is EXPONENTIAL (CFG.HEAT_SHIP_*): the envelope is wide
    // and warns early with warmth and glow, but real damage only arrives
    // really close. game.heatT feeds the render glow/vignette.
    game.heatT = 0;
    {
      const sun2 = game.homeStar;
      if (sun2) {
        const hz = sun2.radius * CFG.HEAT_SHIP_ZONE;
        const dSun = Math.hypot(s.x - sun2.x, s.y - sun2.y);
        if (dSun < hz) {
          const dps = CFG.HEAT_SHIP_DPS * Math.exp(-(dSun - sun2.radius) / CFG.HEAT_SHIP_FALLOFF);
          if (s.invuln <= 0 && dps > 0.05) damageShip(game, dps * dt, "Melted in the sun's corona.");
          game.heatT = Math.pow(Math.min(1, dps / CFG.HEAT_SHIP_DPS), 0.55);
          if (!game.tut.heat && dps > 2) game.heatWarn = true;
          // FEAR: deep heat shakes the hull hard, and sparks tear off the
          // hull itself — tight around the ship, fast, and MULTIPLYING as
          // the heat climbs (rate and speed both scale with heatT)
          if (game.heatT > 0.35) addShake(game, game.heatT * 0.5);
          const sparkRate = 30 * game.heatT + 40 * game.heatT * game.heatT;
          if (Math.random() < dt * sparkRate) {
            const ux2 = (s.x - sun2.x) / (dSun || 1), uy2 = (s.y - sun2.y) / (dSun || 1);
            const sp2 = (260 + Math.random() * 440) * (0.5 + game.heatT);
            addParticles(game,
              s.x + (Math.random() - 0.5) * s.radius * 2.4,
              s.y + (Math.random() - 0.5) * s.radius * 2.4,
              s.vx + ux2 * sp2 + (Math.random() - 0.5) * 120,
              s.vy + uy2 * sp2 + (Math.random() - 0.5) * 120,
              2, Math.random() < 0.4 ? '#fff3d0' : '#ffcf8a', 90, 0.35, 2);
          }
        }
      }
      for (const b of attractors) {
        if (b.ptype !== 'lava') continue;
        const lz = b.radius * CFG.LAVA_HEAT_ZONE;
        const dl = Math.hypot(s.x - b.x, s.y - b.y);
        if (dl < lz) {
          const t = Math.min(1, (lz - dl) / (lz - b.radius));
          if (t * 0.6 > game.heatT) game.heatT = t * 0.6;   // less prominent glow
          if (s.invuln <= 0) damageShip(game, t * t * CFG.LAVA_HEAT_DPS * dt, `Melted over ${b.name || 'a lava world'}.`);
          if (!game.tut.heat) game.heatWarn = true;
        }
      }
    }
  }

  for (const al of game.aliens) {
    if (!al.alive) continue;
    const g = gravityAt(attractors, al.x, al.y);
    al.ax = g.ax + al.thrustX; al.ay = g.ay + al.thrustY;
  }

  const storm = game.storm;   // solar storm front nudges loose scrap outward
  // IRON MOONS are magnetic — natural salvage depots. Shortlist them once per
  // substep; the debris loop springs loose chunks toward a pooling halo just
  // off the surface. DEBRIS ONLY, exactly the storm-shove law: a force that
  // touched bodies, celestials, or rails is an invariant regression.
  let ironMoons = null;
  for (const b of bodies) {
    if (b.alive && b.type === 'moon' && b.moonType === 'iron') (ironMoons ??= []).push(b);
  }
  for (const d of game.debris) {
    const dx = s.x - d.x, dy = s.y - d.y;
    const dd = Math.sqrt(dx * dx + dy * dy) || 0.001;   // guard: ship exactly on the chunk → NaN poison
    const magnet = game.st.magnet || CFG.PICKUP_MAGNET;   // Scrap Magnet upgrade widens it
    if (s.alive && dd < magnet) {
      // Spring-steer toward the ship (matching its velocity) rather than pure
      // acceleration — otherwise chunks whip into little orbits around you.
      // (The ship magnet always outranks an iron moon's pull.)
      const t = 1 - dd / magnet;
      const spd = 260 + 700 * t;
      const desVx = (dx / dd) * spd + s.vx, desVy = (dy / dd) * spd + s.vy;
      d.ax = (desVx - d.vx) * 4; d.ay = (desVy - d.vy) * 4;
    } else {
      const g = gravityAt(attractors, d.x, d.y);
      d.ax = g.ax * 0.4; d.ay = g.ay * 0.4;
      if (ironMoons) {
        // Spring toward the nearest iron moon's pooling ring (radius + 50) so
        // chunks visibly POOL off the surface instead of burying in the disc.
        // Same desired-velocity idiom as the ship magnet, much gentler cap.
        let im = null, imd = CFG.IRON_MAGNET_R;
        for (const m of ironMoons) {
          const md = Math.hypot(m.x - d.x, m.y - d.y);
          if (md < imd) { imd = md; im = m; }
        }
        if (im) {
          const ux = (im.x - d.x) / (imd || 1), uy = (im.y - d.y) / (imd || 1);
          const toRing = imd - (im.radius + 50);
          const spd2 = Math.max(-60, Math.min(60, toRing * 0.6));
          const desVx2 = im.vx + ux * spd2, desVy2 = im.vy + uy * spd2;
          let iax = (desVx2 - d.vx) * 2, iay = (desVy2 - d.vy) * 2;
          const iam = Math.hypot(iax, iay);
          if (iam > CFG.IRON_MAGNET_A) { iax *= CFG.IRON_MAGNET_A / iam; iay *= CFG.IRON_MAGNET_A / iam; }
          d.ax += iax; d.ay += iay;
        }
      }
      if (storm) {
        // Gentle radiation-pressure shove while the front passes. Scrap
        // ONLY — pushing bodies or celestials is how invariants die.
        const hx = d.x - game.homeStar.x, hy = d.y - game.homeStar.y;
        const hr = Math.hypot(hx, hy) || 1;
        if (Math.abs(hr - storm.r) < CFG.STORM_BAND) {
          d.ax += (hx / hr) * 130; d.ay += (hy / hr) * 130;
        }
      }
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
    if (rl.e > 0) {
      // Elliptical rail: analytic Kepler advance (see entities.keplerStep)
      keplerStep(rl, dt);
      b.x = p.x + rl.px; b.y = p.y + rl.py;
      b.vx = p.vx + rl.vpx; b.vy = p.vy + rl.vpy;
    } else {
      rl.ang += rl.w * dt;
      const c = Math.cos(rl.ang), sn = Math.sin(rl.ang);
      b.x = p.x + c * rl.r;
      b.y = p.y + sn * rl.r;
      // Keep velocity truthful so collisions and grabs behave normally
      b.vx = p.vx - sn * rl.w * rl.r;
      b.vy = p.vy + c * rl.w * rl.r;
    }
  }

  // NaN containment tripwire: a non-finite body is always an upstream bug,
  // but left alive ONE of them annihilates the whole system within a few
  // substeps — NaN comparisons defeat every broad-phase reject, so it "hits"
  // everything, and if it's an attractor it NaN-poisons every live body's
  // gravity. Contain the blast radius to the buggy body: cull it, warn once.
  for (const b of bodies) {
    if (b.alive && !isFinite(b.x + b.y + b.vx + b.vy)) {
      b.alive = false;
      // Counter for headless soaks (window.soak) — the console warn fires once
      // per session, but a soak needs the tally to flag the regression
      game.nanEvents = (game.nanEvents || 0) + 1;
      if (!nanWarned) {
        nanWarned = true;
        console.warn('Solar Slinger: culled non-finite body (upstream bug)', b.type, b.id);
      }
    }
  }

  if (s.alive) {
    s.vx += shipAx * dt; s.vy += shipAy * dt;
    // Speed governor (CFG.SPEED_*): the ceiling is maxSpeed measured RELATIVE
    // to the local orbital flow (orbitalFlow) — the current carries the ship
    // and the engine buys maxSpeed of deviation in any direction. Excess bleeds
    // off; the hard cap stops any assist chain from outrunning the bleed.
    let cap = game.st.maxSpeed;
    // AFTERBURNER raises the ceiling too, so the burn actually reaches speed
    // (gated on the fuel tank via game.burnerOn, same as the thrust boost).
    if (game.burnerOn && s.engineOutT <= 0) cap *= 1.35 + 0.25 * game.st.afterburner;
    const flow = orbitalFlow(game, s.x, s.y);
    const rvx = s.vx - flow.vx, rvy = s.vy - flow.vy;   // velocity relative to the flow
    const rsp = Math.hypot(rvx, rvy);
    if (rsp > cap) {
      const brake = (rsp - cap) * CFG.SPEED_BLEED * dt;
      let f = Math.max(0, (rsp - brake) / rsp);
      const hard = cap * CFG.SPEED_HARD;
      if (rsp * f > hard) f = hard / rsp;
      s.vx = flow.vx + rvx * f; s.vy = flow.vy + rvy * f;
    }
    // Stashed for the audio layer (sfx speed voice + engine cruise/settle):
    // how close the ship is to its flow-RELATIVE ceiling ALONG THE NOSE — the
    // forward component of the deviation, over the same cap the governor
    // brakes on. Direction matters: drifting sideways or backwards at speed
    // must not read as "hitting max" (a bounce or fling recoil isn't cruise).
    // Post-bleed, so a clean burn can kiss >1 briefly; floored at 0 when the
    // deviation points behind the nose.
    game.speedFrac = Math.min(1.2, Math.max(0,
      ((s.vx - flow.vx) * Math.cos(s.angle) + (s.vy - flow.vy) * Math.sin(s.angle)) / cap));
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.invuln > 0) s.invuln -= dt;

    // Ship half of the NaN tripwire (post-integration, pre-collision): a NaN
    // ship never dies "honestly" — NaN comparisons skip all damage — but the
    // `|| 0.001` distance fallback in the gas-dive check reads NaN as zero
    // distance and insta-crushes it at the first gas giant tested. Snap the
    // kinematics back to the spawn point instead (recoverable, no free heal)
    // and patch NaN pools so the HUD and regen math stay sane.
    if (!isFinite(s.x + s.y + s.vx + s.vy)) {
      s.x = game.spawn.x; s.y = game.spawn.y;
      s.vx = game.spawn.vx; s.vy = game.spawn.vy;
      s.invuln = Math.max(s.invuln, 2);
      game.nanEvents = (game.nanEvents || 0) + 1;   // soak-visible tally (window.soak)
      if (!nanWarned) {
        nanWarned = true;
        console.warn('Solar Slinger: reset non-finite ship (upstream bug)');
      }
    }
    if (!isFinite(s.angle)) s.angle = 0;
    if (!isFinite(s.hull)) s.hull = Math.max(1, game.st.hullMax * 0.5);
    if (!isFinite(s.shield)) s.shield = 0;
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

  // Deflector parry: pin/flick/launch — before collisions so the frozen rock
  // sits at its pinned spot for this substep's pair tests (which skip it).
  updateParry(game, dt);

  // Collisions: body-body via sweep-and-prune on x. Sorting ~400 bodies by
  // left edge is cheap; the inner loop then stops at the first body whose
  // x-extent can't overlap, so the old O(n^2) pair scan (~80k tests per
  // substep) collapses to the handful of genuinely near pairs. The x-extent
  // overlap test is exactly the old |a.x-b.x| <= a.r+b.r cheap bound.
  const sweep = _sweep;
  sweep.length = 0;
  for (const b of bodies) if (b.alive) sweep.push(b);
  sweep.sort(_byLeftEdge);
  for (let i = 0; i < sweep.length; i++) {
    const a = sweep[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < sweep.length; j++) {
      const b = sweep[j];
      if (b.x - b.radius > a.x + a.radius) break;
      if (!b.alive) continue;
      if (Math.abs(a.y - b.y) > a.radius + b.radius) continue;
      collideBodies(game, a, b);
    }
  }

  // Ship & alien collisions with bodies (aliens are usually absent — skip
  // spinning up an iterator per body for an empty list at 120Hz)
  const aliens = game.aliens;
  for (const b of bodies) {
    if (!b.alive) continue;
    if (s.alive) collideShipBody(game, s, b, dt);
    if (aliens.length) for (const al of aliens) if (al.alive) collideAlienBody(game, al, b);
  }

  // Alien-ship ramming
  for (const al of game.aliens) {
    if (!al.alive || !s.alive) continue;
    const rr = al.radius + s.radius;
    const dd2 = (al.x - s.x) ** 2 + (al.y - s.y) ** 2;
    if (dd2 < rr * rr) {
      const d = Math.sqrt(dd2);
      const nx = (s.x - al.x) / (d || 1), ny = (s.y - al.y) / (d || 1);
      s.vx += nx * 180; s.vy += ny * 180;
      al.vx -= nx * 180; al.vy -= ny * 180;
      damageShip(game, al.contactDmg || CFG.ALIEN_CONTACT_DMG,
        al.kind === 'golem' ? 'Crushed by a scrap-golem.' : 'Rammed by an alien grabber.',
        Math.atan2(al.y - s.y, al.x - s.x));
      al.hp -= 12;
      if (al.hp <= 0) killAlien(game, al);
    }
  }

  // Scrap pickup + expiry (compacted in place — this runs at 120Hz)
  if (game.debris.length) {
    const debris = game.debris;
    const escapeR2 = (CFG.WORLD_R * 1.3) ** 2;
    let w = 0;
    for (const d of debris) {
      const pr = s.radius + d.radius + 8;
      if (s.alive && (d.x - s.x) ** 2 + (d.y - s.y) ** 2 < pr * pr) {
        // Debris chunks are pure XP pickups now — no scrap currency, and they
        // do NOT heal the hull (hull only resets on respawn; shield recharges).
        addXp(game, d.value * PROG.XP_SCRAP);
        sfx.sfxCollect();
        continue;
      }
      if (d.life > 0 && d.x * d.x + d.y * d.y < escapeR2) debris[w++] = d;
    }
    debris.length = w;
  }

  // Solar flares: plasma blobs racing out from the sun. They scorch the
  // ship, vaporize small rocks in their path, and shove bigger ones.
  if (game.flares && game.flares.length) {
    const keep = [];
    for (const f of game.flares) {
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.life -= dt;
      const fr = f.radius + s.radius;
      if (s.alive && (f.x - s.x) ** 2 + (f.y - s.y) ** 2 < fr * fr) {
        damageShip(game, CFG.FLARE_DMG, 'Scorched by a solar flare.',
          Math.atan2(f.y - s.y, f.x - s.x));
        s.vx += f.vx * 0.18; s.vy += f.vy * 0.18;
        addParticles(game, s.x, s.y, f.vx * 0.3, f.vy * 0.3, 18, '#ffb35c', 220, 1, 4);
        // EMP SURGE: a direct hit is an EVENT — engines dead for a beat,
        // and the charged front blows HALF the orbit shield out of formation
        s.engineOutT = CFG.FLARE_ENGINE_OUT;
        if (game.orbit.length) {
          const kick = Math.ceil(game.orbit.length / 2);
          for (let k = 0; k < kick; k++) {
            const ob = game.orbit.pop();
            ob.heldBy = null; ob.orbitAng = undefined;
            ob.extAx = 0; ob.extAy = 0;
            ob.vx += f.vx * 0.4 + (Math.random() - 0.5) * 140;
            ob.vy += f.vy * 0.4 + (Math.random() - 0.5) * 140;
          }
        }
        game.flareHitWarn = true;
        f.life = 0;
      }
      if (f.life > 0) {
        for (const b of bodies) {
          if (!b.alive || b.type === 'star') continue;
          const br = f.radius + b.radius;
          if (Math.abs(b.x - f.x) > br) continue;
          if ((b.x - f.x) ** 2 + (b.y - f.y) ** 2 > br * br) continue;
          if (b.mass < 500 && !b.heldBy) {
            shatter(game, b);
            f.life = 0;
          } else {
            derail(b);
            b.vx += f.vx * 0.06 * dt * 60; b.vy += f.vy * 0.06 * dt * 60;
          }
          break;
        }
      }
      // In-flight sputter: the plasma sheds glowing embers as it flies
      if (f.life > 0 && Math.random() < dt * 7) {
        addParticles(game, f.x, f.y, f.vx * 0.15, f.vy * 0.15, 1, '#ffcf8a', 70, 0.6, 3);
      }
      if (f.life > 0 && Math.hypot(f.x, f.y) < CFG.WORLD_R * 1.2) keep.push(f);
    }
    game.flares = keep;
  }

  // CORONA HEAT on bodies and aliens: everything but lava-born matter
  // (molten magma, lava/ember worlds) melts near the sun — rocks shed
  // embers and shatter before they can reach the surface. Two-compare
  // bounding reject first; the zone is tiny compared to the map, so this
  // is nearly free for the whole population.
  {
    const sun2 = game.homeStar;
    if (sun2) {
      const hz = sun2.radius * CFG.HEAT_ZONE;
      for (const b of bodies) {
        if (!b.alive || b.type === 'star') continue;
        const hx = b.x - sun2.x, hy = b.y - sun2.y;
        if (hx > hz || hx < -hz || hy > hz || hy < -hz) continue;
        if (b.ptype === 'lava' || b.magma > 0 || b.ember > 0.01) continue;
        const d = Math.hypot(hx, hy);
        if (d >= hz) continue;
        const t = Math.min(1, (hz - d) / (hz - sun2.radius));
        damageBody(game, b, t * t * CFG.HEAT_DPS_BODY * b.maxHp * dt);
        if (b.alive && Math.random() < dt * 5) {
          addParticles(game, b.x, b.y, b.vx * 0.3, b.vy * 0.3, 1, '#ffb35c', 80, 0.7, 3);
        }
      }
      for (const al of game.aliens) {
        if (!al.alive) continue;
        const hx = al.x - sun2.x, hy = al.y - sun2.y;
        if (hx > hz || hx < -hz || hy > hz || hy < -hz) continue;
        const d = Math.hypot(hx, hy);
        if (d >= hz) continue;
        const t = Math.min(1, (hz - d) / (hz - sun2.radius));
        al.hp -= t * t * 25 * dt;
        if (al.hp <= 0) killAlien(game, al);
      }
    }
  }

  // Particles (updated + compacted in place — filter() would allocate at 120Hz)
  {
    const parts = game.particles;
    let w = 0;
    for (const p of parts) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.985; p.vy *= 0.985;
      p.life -= dt;
      if (p.life > 0) parts[w++] = p;
    }
    parts.length = w;
  }

  // Cull dead / escaped bodies (in place, squared distance)
  {
    const cullR2 = (CFG.WORLD_R * 1.35) ** 2;
    let w = 0;
    for (const b of bodies) {
      if (b.alive && (b.type !== 'asteroid' || b.x * b.x + b.y * b.y < cullR2)) bodies[w++] = b;
    }
    bodies.length = w;
    const aliens = game.aliens;
    w = 0;
    for (const a of aliens) if (a.alive) aliens[w++] = a;
    aliens.length = w;
  }
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
        weighted: b.type === 'planet' || b.type === 'moon' || b.type === 'rogue' || b.majorComet,
        // rubber-band eligible: real worlds only (majorComet is weighted for
        // gravity but the capture assist doesn't apply near a comet)
        rb: b.type === 'planet' || b.type === 'moon' || b.type === 'rogue',
        gas: b.ptype === 'gas',   // ship path enters these; hit = the core
        parentIdx: -1, anchorIdx: -1,
        // Railed attractors predict EXACTLY — advance the rail analytically.
        // Elliptical rails carry a COPY of their Kepler elements so advancing
        // the forecast's mean anomaly never mutates the live rail.
        railR: b.onRails ? b.rail.r : 0,
        railW: b.onRails ? b.rail.w : 0,
        railAng: b.onRails ? b.rail.ang : 0,
        railParent: b.onRails ? b.rail.parent : null,
        railEl: (b.onRails && b.rail.e > 0)
          ? { e: b.rail.e, a: b.rail.a, smin: b.rail.smin, n: b.rail.n, M: b.rail.M, dir: b.rail.dir, ca: b.rail.ca, sa: b.rail.sa }
          : null,
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
      weighted: h.type === 'planet' || h.type === 'moon' || h.type === 'rogue' || h.majorComet,
      parentGhost: h.parent ? atr[src.indexOf(h.parent)] || null : null,
      anchorGhost: anchor ? atr[src.indexOf(anchor)] || null : null,
    };
  }

  const shipPts = [], heldPts = [];
  let shipHit = null, heldHit = null;
  const dt = CFG.PREDICT_DT;
  const soft2 = SOFT2;

  // DISPLAY FRAME for the ship path: the whole universe orbits, so an
  // inertial-space line near a moving world is technically true but
  // unreadable — it curves toward where the world WILL be, through where
  // it ISN'T. Physics still predicts in inertial space; only the DRAWN
  // points are re-expressed relative to the dominant attractor's frame,
  // anchored at that body's CURRENT position — so near a world you see
  // your actual approach/orbit shape around it. The sun is pinned at the
  // origin, so with the sun dominant this is exactly the inertial path.
  // 1.35x hysteresis keeps the frame from flickering at dominance borders.
  let refIdx = -1, refX0 = 0, refY0 = 0;
  if (ship) {
    let bestIdx = -1, bestA = 0, prevIdx = -1, prevA = 0;
    for (let i = 0; i < atr.length; i++) {
      const b = atr[i];
      const dx = b.x - ship.x, dy = b.y - ship.y;
      const d2 = dx * dx + dy * dy + soft2;
      const d = Math.sqrt(d2);
      let w = b.star ? CFG.STAR_GRAV_SHIP : b.weighted ? CFG.PLANET_GRAV_SHIP : 1;
      if (b.weighted) {
        const f = d / (b.radius * CFG.SHIP_WELL_START);
        if (f > 1) w *= Math.min(CFG.SHIP_WELL_MAX, f);
      }
      const a = (w * CFG.G * b.mass) / d2;
      if (a > bestA) { bestA = a; bestIdx = i; }
      if (src[i] === game.predictRef) { prevIdx = i; prevA = a; }
    }
    refIdx = (prevIdx >= 0 && prevA * 1.35 >= bestA) ? prevIdx : bestIdx;
    if (refIdx >= 0) {
      game.predictRef = src[refIdx];
      refX0 = atr[refIdx].x; refY0 = atr[refIdx].y;
    }
  }

  const _acc = [0, 0];   // reused — 200 steps/frame would otherwise churn arrays
  const accelAt = (x, y, starMul = 1, heavyMul = 1) => {
    let ax = 0, ay = 0;
    for (const b of atr) {
      let w = b.star ? starMul : b.weighted ? heavyMul : 1;
      const dx = b.x - x, dy = b.y - y;
      const d2 = dx * dx + dy * dy + soft2;
      const d = Math.sqrt(d2);
      // Mirror of gravityAt's LONG ARMS far-field boost — the ship path is
      // the only caller passing heavyMul != 1, and the predicted trajectory
      // must bend exactly like the real one or the forecast lies.
      if (b.weighted && heavyMul !== 1) {
        const f = d / (b.radius * CFG.SHIP_WELL_START);
        if (f > 1) w *= Math.min(CFG.SHIP_WELL_MAX, f);
        if (b.gas && d < b.radius) {   // enclosed-mass interior, like gravityAt
          const q = d / b.radius;
          w *= q * q * q;
        }
      }
      const inv = (w * CFG.G * b.mass) / (d2 * d);
      ax += dx * inv; ay += dy * inv;
    }
    _acc[0] = ax; _acc[1] = ay;
    return _acc;
  };

  // CHART progression: surveyed worlds extend the ship forecast (up to ~2x,
  // hard-capped so the per-frame predictor can't grow unbounded)
  const steps = Math.min(420, Math.round(CFG.PREDICT_STEPS * (game.st.predictBoost || 1)));
  // The DRAWN ship path never leaves the screen: cap its displayed length
  // at a fraction of the view radius — which reaches to the screen CORNER,
  // so even 0.85 stays on-screen and the render fades the tail out before
  // the edge. Kept generous (0.85 base) because the tier-0 camera is zoomed
  // in tight (SHIP_ZOOM 2.46): at a smaller fraction the forecast collapsed
  // to a ~1s stub that read as broken. Chart levels widen it further.
  const maxPathLen = (game.viewR || 1200) *
    Math.min(0.95, 0.85 + 0.03 * ((game.st.levels && game.st.levels.chart) || 0));
  let pathLen = 0, lastPx = null, lastPy = null, shipEnd = false;
  for (let i = 0; i < steps; i++) {
    // Advance attractors (stars pinned) with the same hierarchical weighting
    // the real sim uses, so predicted planet positions match reality.
    for (let bi = 0; bi < atr.length; bi++) {
      const b = atr[bi];
      if (b.star) continue;
      if (b.railParent) {
        if (b.railEl) {
          keplerStep(b.railEl, dt);
          b.x = b.railParent.x + b.railEl.px;
          b.y = b.railParent.y + b.railEl.py;
        } else {
          b.railAng += b.railW * dt;
          b.x = b.railParent.x + Math.cos(b.railAng) * b.railR;
          b.y = b.railParent.y + Math.sin(b.railAng) * b.railR;
        }
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

    if (ship && !shipHit && !shipEnd) {
      let [ax, ay] = accelAt(ship.x, ship.y, CFG.STAR_GRAV_SHIP, CFG.PLANET_GRAV_SHIP);
      ax *= CFG.SHIP_GRAV; ay *= CFG.SHIP_GRAV;
      // Mirror of the orbit rubber band (step) — same inward-only radial
      // damping, so the forecast bends into captures exactly like the ship
      for (const b of atr) {
        if (!b.rb) continue;
        const band = b.radius * CFG.SHIP_BAND_RANGE + 300;
        const bdx = b.x - ship.x, bdy = b.y - ship.y;
        if (bdx > band || bdx < -band || bdy > band || bdy < -band) continue;
        const d = Math.hypot(bdx, bdy);
        if (d > band || d < b.radius + ship.r) continue;
        const ux = bdx / d, uy = bdy / d;
        const vR = (ship.vx - b.vx) * ux + (ship.vy - b.vy) * uy;
        if (vR <= 0) continue;
        const t = 1 - (d - b.radius) / (band - b.radius);
        const brake = Math.min(CFG.SHIP_BAND_MAX, vR * CFG.SHIP_BAND_DAMP * t);
        ax -= ux * brake; ay -= uy * brake;
      }
      ship.vx += ax * dt; ship.vy += ay * dt;
      // Mirror the speed governor (relative to the orbital flow) so the path
      // stays honest — same flow-relative clamp the real ship gets
      const pcap = game.st.maxSpeed;
      const pflow = orbitalFlow(game, ship.x, ship.y);
      const prvx = ship.vx - pflow.vx, prvy = ship.vy - pflow.vy;
      const prsp = Math.hypot(prvx, prvy);
      if (prsp > pcap) {
        let f = Math.max(0, (prsp - (prsp - pcap) * CFG.SPEED_BLEED * dt) / prsp);
        const hard = pcap * CFG.SPEED_HARD;
        if (prsp * f > hard) f = hard / prsp;
        ship.vx = pflow.vx + prvx * f; ship.vy = pflow.vy + prvy * f;
      }
      ship.x += ship.vx * dt; ship.y += ship.vy * dt;
      // Re-express in the reference body's frame (see DISPLAY FRAME above)
      const fx = refIdx >= 0 ? refX0 - atr[refIdx].x : 0;
      const fy = refIdx >= 0 ? refY0 - atr[refIdx].y : 0;
      const px = ship.x + fx, py = ship.y + fy;
      if (lastPx !== null) {
        pathLen += Math.hypot(px - lastPx, py - lastPy);
        if (pathLen > maxPathLen) shipEnd = true;   // path cap: stays on screen
      }
      lastPx = px; lastPy = py;
      if (!shipEnd && i % 2 === 0) shipPts.push({ x: px, y: py });
      if (!shipEnd) for (const b of atr) {
        // Gas giants have no ship surface — the meaningful "hit" is the core
        const hr = (b.gas ? b.radius * CFG.GAS_CORE : b.radius) + ship.r;
        if ((b.x - ship.x) ** 2 + (b.y - ship.y) ** 2 < hr * hr) { shipHit = { x: px, y: py }; break; }
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
        const hr = b.radius + held.r;
        if ((b.x - held.x) ** 2 + (b.y - held.y) ** 2 < hr * hr) { heldHit = { x: held.x, y: held.y }; break; }
      }
    }
  }
  return { shipPts, heldPts, shipHit, heldHit };
}
