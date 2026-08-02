import { CFG, PROG, addXp, fieldXp, worldDebris, crustMass, FIELD_LOBE_MAX } from './config.js';
import {
  makeScrap, scrapValue, massToHp, railBody, derail, keplerStep, makeChunk, chunkHaloW,
} from './entities.js';
import { spawnAsteroid, markFieldRock } from './world.js';
import { computeFlingVelocity } from './tractor.js';
import {
  TAU, clamp, angDiff, crystalShards, crystalRadiusAt, scarSurfaceAt, CRYSTAL_REACH,
} from './util.js';
import { bump, best, noteKill } from './achievements.js';
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

// `fromField` marks a chunk as shoal salvage. Its XP was already priced
// against the pocket's budget by fieldXp at THIS moment (the callers below),
// so nothing downstream may scale it again — the solar wave's ionization
// bonus checks this flag and skips field scrap for exactly that reason.
function dropScrap(game, x, y, vx, vy, totalValue, fromField) {
  let remaining = Math.round(totalValue);
  const chunk = Math.max(3, Math.round(totalValue / 10));
  let guard = 40;
  while (remaining > 0 && guard-- > 0) {
    const v = Math.min(chunk, remaining);
    remaining -= v;
    const th = Math.random() * TAU;
    const s = 30 + Math.random() * 90;
    const d = makeScrap(x, y, vx + Math.cos(th) * s, vy + Math.sin(th) * s, v);
    if (fromField) d.field = true;
    game.debris.push(d);
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
// May `src` pass its billiards credit on to `dst`? DENSE ROCK is capped; belt
// rock is sparse and self-limiting, so trick shots out in the open are
// unchanged. See CFG.FIELD_CHAIN_MAX for the exploit this closes.
//
// A WORLD'S RUBBLE HALO COUNTS AS DENSE ROCK. The cap was written for the
// shoals, where touching rocks let one throw launder itself into the whole
// pocket at full lethality and full payout; a planet ringed by two dozen crust
// slabs and its debris belt is exactly as packed, and it was left uncapped
// because it did not exist yet. Throwing one slab back through a halo chained
// the mark from piece to piece, and since every piece over CHUNK_SPLIT_R
// SHATTERS INTO MORE PIECES, each link both paid throw-kill XP and manufactured
// more rock to chain into — a fresh run reached tier 5 in seconds and the frame
// rate went with it. Same depth limit, same reason.
function chainOk(src, dst) {
  return !(dst.fieldRock || dst.chunk) || (src.chainN || 0) + 1 <= CFG.FIELD_CHAIN_MAX;
}
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
  if (st.cluster > 0 && debrisRoom(game) > 0) {   // the shared debris budget
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
    // BLAST REACH. Was 240 + 90/rank — a maxed blast cleared a 510 radius, a
    // circle about as wide as the screen, off EVERY throw-kill. Out in the belt
    // that only looked generous; inside a shoal it erased a pocket faster than
    // the eye could follow and made the fields a no-risk harvest. Trimmed to
    // roughly HALF the area at every rank (rank 3: 510 -> 350) — still the
    // loudest thing a brawler does, no longer a screen-wide delete key.
    // TWO RADII, and the split is the whole point:
    //   PUSH keeps its long reach — the shove is the spectacle, it costs the
    //     world nothing, and a wide wave of rock scattering off the impact is
    //     what the ability is FOR.
    //   DAMAGE is tight. Erasing a body is the part that has to be earned, so
    //     it now needs the target genuinely close to the detonation (rank 3:
    //     204 vs the original 510 — 16% of the area).
    // A rock between the two radii gets thrown, not deleted, which is the more
    // interesting outcome anyway: it becomes YOUR next projectile.
    const pushR = 170 + 60 * st.shockwave;
    const dmgR = 90 + 38 * st.demolition;
    const R = Math.max(pushR, dmgR);          // one sweep, widest of the two
    const push = 130 * st.shockwave;
    const dmg = 16 * st.demolition * (1 + st.tier * 0.4);
    // FRIENDLY FIRE: detonating on top of yourself hurts. Without it the blast
    // was the one brawler tool with no downside — pure area denial — and in a
    // dense field, where the next rock is always within arm's reach, that is
    // exactly what made a shoal safe to harvest. Keyed to the DAMAGE radius, so
    // the long shove still never hurts you: the danger is specifically about
    // detonating TOO CLOSE.
    const s = game.ship;
    if (dmg > 0 && s.alive) {
      const sdx = s.x - body.x, sdy = s.y - body.y;
      const sd = Math.hypot(sdx, sdy);
      if (sd < dmgR) {
        // hitAng points FROM the ship TOWARD the blast — the same convention
        // collideShipBody uses, so a BRAWLER's front-arc shield really does
        // cover a detonation it happens to be facing.
        damageShip(game, dmg * (1 - sd / dmgR) * CFG.BLAST_SELF_DMG,
          'Caught in your own detonation.', Math.atan2(-sdy, -sdx));
        if (!s.alive) bump(game, 'ownGoal');   // your own ordnance still counts
      }
    }
    let hits = 0, damaged = 0;
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
      if (push > 0 && dd < pushR) {
        const imp = push * (1 - dd / pushR) * Math.min(1, 3000 / nb.mass);
        nb.vx += (ddx / dd) * imp; nb.vy += (ddy / dd) * imp;
        if (imp > 70) derail(nb);              // only a real shove derails — limits belt sandblasting
      }
      if (dmg > 0 && dd < dmgR && damaged < 10) {
        damageBody(game, nb, dmg * (1 - dd / dmgR), 'player', body.x, body.y);
        damaged++;
      }
      // Body-count caps. These are what actually BIND inside a dense field (a
      // pocket puts ~100 rocks inside any of these radii, vs a handful in the
      // belt), so treat them as the field limiter, not just a perf guard. The
      // damage cap is the tighter of the two on purpose — the shove is cheap
      // spectacle, the deletions are not.
      if (++hits >= 20) break;
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
  bump(game, 'kSplat');
  if (!game.tut.wallsplat) game.wallSplatWarn = true;   // main.js announces (first time)
}

// ---------------------------------------------------------------------------
// THE DEBRIS BUDGET. Every fragment system in the game asks this before it
// spawns anything: chunk spray, spall, a dying world's cloud, Cluster Rounds.
// They all used to compare `game.bodies.length` against ~450, a ceiling
// written when a whole world held ~380 bodies. The dense fields put ~7,900
// rocks into that same array, so the comparison has been false on frame one
// ever since the shoals landed and NONE of those systems have fired in a real
// game — a planet took damage and grew decals, nothing more. Counting
// NON-FIELD bodies (the reg.nonField registry) is what keeps shoal rock from
// starving the rest of the sim; the pockets keep their own separate ceilings.
// One frame stale for bodies born this frame, like every registry read — the
// per-event caps at each call site are what bound a single burst.
export function debrisRoom(game) {
  const reg = game.reg;
  return Math.max(0, CFG.DEBRIS_BUDGET - (reg ? reg.nonField.length : game.bodies.length));
}

// Knock one real piece off a world at bearing `ang`. `sev` (0..1) is how hard
// the hit bit — it drives the piece's SIZE, and the caller sizes the crater it
// leaves from the radius this returns, so the bite in the rim always matches
// the slab now floating beside it.
//
// SIZE IS DECOUPLED FROM MASS here, exactly like the WORLD SCALE law that made
// planets 3x their authored radius at unchanged mass (see CFG.CRUST_*). Mass
// stays under CHUNK_MAX_MASS so a slab still can't wake a rail lane, but the
// drawn radius is a fraction of the HOST's — a piece of a planet has to look
// like a piece of that planet, and the mass-derived radius drew a 3200-mass
// chunk at 10 units beside a 705-unit world.
function calveCrust(game, host, ang, sev, credit) {
  const roll = 0.45 + Math.random() * 0.55;
  const R = host.radius * (CFG.CRUST_R_MIN + (CFG.CRUST_R_MAX - CFG.CRUST_R_MIN) * sev * roll);
  // Sized FIRST, because whether the halo has room for it depends on how big
  // it is: a slab always displaces a crumb (see crustRoom).
  if (!crustRoom(game, host, R)) return null;
  // Mass follows the DRAWN size through the one curve (config.crustMass), so
  // every mass gate in the game — the beam's tier cap above all — agrees with
  // what the player is looking at. A slab needs a real ship to lift.
  const m = crustMass(R);
  // Born IN THE MOUTH OF THE CRATER IT LEFT — centred exactly one slab-radius
  // off the nominal surface, so its inner face sits on the rim while the notch
  // render just cut is a bowl of the same width behind it. The piece therefore
  // appears to lift straight out of the hole it made, which is the whole read:
  // the debris comes off the planet, it does not appear beside it.
  // Touching, never overlapping — a piece born inside its parent takes
  // collision damage and sheds again (invariant 7's feedback loop).
  const d = surfReach(host) + R;
  const x = host.x + Math.cos(ang) * d, y = host.y + Math.sin(ang) * d;
  // A pop, not a launch: the old spray fired chunks off at 80-450 and they
  // were a screen away before you could look at them. This barely clears the
  // crater, so the piece hangs where it broke off.
  const pop = 18 + Math.random() * 34 + 44 * sev;
  const w = chunkHaloW(host);
  const f = spawnAsteroid(game.bodies, x, y,
    host.vx + Math.cos(ang) * pop - Math.sin(ang) * w * d,
    host.vy + Math.sin(ang) * pop + Math.cos(ang) * w * d, m);
  makeChunk(f, R, worldDebris(host.ptype, host.color, Math.random()));
  f.crust = host;            // bound to its world (updateCrust)
  f.crustFree = CFG.CRUST_FREE;
  f.crustT = game.time;      // age, for the halo's off-view turnover (crustRoom)
  // GRAVITY BILLIARDS: pieces your throw knocked loose carry your credit for a
  // beat — same rule as the knocked-rock propagation in collideBodies, and for
  // the same reason it is limited to a DIRECT throw (shard/Demolition damage
  // stays credit-neutral so those chains stay bounded).
  if (credit === 'player-throw') { f.thrownBy = 'player'; f.thrownTimer = 1.4; }
  return f;
}

// A FULL halo must not stop the crumble. A planet takes thousands of rock hits
// to kill, so a hard count cap means the pieces stop coming after the first
// couple of dozen and every hit after that is a decal again — the exact
// complaint this whole layer exists to answer. Worse, a plain cap fills with
// whatever landed FIRST: forty rock chips fill it with crumbs, and then the
// thrown MOON — the moment the whole feature exists for — has nowhere to put
// the slab it tore off, so the biggest hit in the game shows the least.
//
// So: A WORLD'S HALO HOLDS THE BIGGEST PIECES IT HAS SHED. A newcomer that
// outsizes the smallest piece up there grinds it to dust and takes its slot,
// which is what a rubble ring does to itself anyway. A newcomer smaller than
// everything already there only gets in if something can be retired OFF-SCREEN,
// so a long bombardment keeps turning the halo over without anything visibly
// winking out under the player's nose.
// Reads the frame registry, so a piece calved this frame is not counted until
// the next one — the cap is a look, not an invariant.
function crustRoom(game, host, newR) {
  const list = game.reg && game.reg.crust;
  if (!list) return true;
  let n = 0, small = null, oldFar = null;
  const s = game.ship;
  const far = (game.viewR || 1200) * 1.2;
  for (const b of list) {
    if (b.crust !== host || !b.alive) continue;
    n++;
    if (!small || b.radius < small.radius) small = b;
    if (!s.alive || Math.hypot(b.x - s.x, b.y - s.y) > far) {
      if (!oldFar || b.crustT < oldFar.crustT) oldFar = b;
    }
  }
  if (n < CFG.CRUST_PER_HOST) return true;
  const gone = (small && newR > small.radius) ? small : oldFar;
  if (!gone) return false;
  gone.alive = false;
  gone.crust = null;
  // Ground to dust, not deleted — a piece that simply blinked out would read as
  // a bug even in the frame something bigger erupts to replace it.
  addParticles(game, gone.x, gone.y, gone.vx, gone.vy, 7, gone.color, 60, 0.7, 3);
  return true;
}

// THE CRUMBLE, per substep. A freshly calved piece is FREE for CRUST_FREE
// seconds: it tumbles out of the crater under real gravity and bumps its
// neighbours, which is the part the player actually watches. Then a band
// assist eases it onto its host's rigid halo — radial velocity damped out,
// tangential speed eased toward the halo rate, radius eased into the band —
// and once it is riding that halo to within a hair, it RAILS and is permanent.
//
// The general rail scan may never re-rail inside the player's view ("the rock
// I flung just stopped mid-flight"); this one may, and the difference is real.
// That law exists because the generic snap DISCARDS whatever radial velocity a
// flung rock still carries. This snap only fires once the assist has already
// brought the piece to within a few percent of the state it is snapping to, so
// there is nothing left to discard — and a halo the player is standing in is
// exactly where the snap would be seen.
function updateCrust(game, dt) {
  const list = game.reg && game.reg.crust;
  if (!list || !list.length) return;
  const k = 1 - Math.exp(-CFG.CRUST_SETTLE * dt);
  for (const b of list) {
    const h = b.crust;
    if (!b.alive || !h) continue;
    // Same near-ship gate as the cratered collider: the settle is a thing you
    // WATCH, and a halo forms seconds after a hit the player was present for,
    // so by the time they leave its pieces are already railed and cost nothing.
    // A piece still loose around a world nobody is at simply waits.
    if (!h.nearShip) continue;
    // The world it came off is gone: its rubble is ordinary debris now, free
    // to fly (the rails pass has already derailed it off the dead parent).
    if (!h.alive) { b.crust = null; continue; }
    // Anything holding a piece takes it out of the halo for good — it is
    // somebody's ammunition now, and a slab that crept back toward its planet
    // after being let go would be the assist making decisions for the player.
    // (tractor.tryGrab clears the binding at the grab itself; this covers the
    // alien carriers, which have no equivalent choke point.) The test is the
    // GRAB and never the throw: a fresh calve carries `thrownBy = 'player'`
    // for a beat as gravity-billiards credit without the player ever having
    // touched it, and unbinding on that emptied the halo as it formed.
    if (b.heldBy) { b.crust = null; continue; }
    // NEVER touch a piece in flight — "throws never steer" is a design law,
    // and an assist that curved a thrown slab back toward its planet would
    // break it outright. It re-settles from scratch once it lands.
    if (b.thrownTimer > 0) { b.crustFree = CFG.CRUST_FREE; continue; }
    if (b.crustFree > 0) { b.crustFree -= dt; continue; }
    const dx = b.x - h.x, dy = b.y - h.y;
    const r = Math.hypot(dx, dy) || 1;
    const lo = surfReach(h) * CFG.CRUST_BAND_LO + b.radius;
    const hi = surfReach(h) * CFG.CRUST_BAND_HI;
    // Knocked clean off the world: it escaped, and it stays escaped.
    if (r > hi * 1.8) { b.crust = null; continue; }
    if (b.onRails) continue;          // already riding the halo
    const nx = dx / r, ny = dy / r;
    const w = chunkHaloW(h);
    const tr = clamp(r, lo, hi);
    const want = w * tr;
    // Ease onto the halo's own velocity at the nearest band radius...
    b.vx += (h.vx - ny * want - b.vx) * k;
    b.vy += (h.vy + nx * want - b.vy) * k;
    // ...and ease the radius itself in, or a piece that came out of the crater
    // sinking or climbing settles into a circle in the wrong place.
    if (r < lo || r > hi) { const pull = (tr - r) * k; b.x += nx * pull; b.y += ny * pull; }
    const rvx = b.vx - h.vx, rvy = b.vy - h.vy;
    const vT = (dx * rvy - dy * rvx) / r;
    const vR = (dx * rvx + dy * rvy) / r;
    const tol = Math.abs(w * r) * 0.05 + 0.5;
    if (r >= lo && r <= hi && Math.abs(vR) < tol && Math.abs(vT - w * r) < tol) {
      b.vx = h.vx - ny * w * r; b.vy = h.vy + nx * w * r;
      railBody(b, h);
      b.rail.w = w;   // RIGID: one rate for the whole shell, never a per-radius one
    }
  }
}

// THE ERUPTION. What goes into a gas giant comes back out. A body that finishes
// its sink has reached depth, and the giant answers with a column blasted back
// up the throat it made — atmosphere, condensate, and pieces of whatever went
// in. Being swallowed silently was the right physics and the wrong game: the
// hit is the loudest thing the player can do to one of these, and it deserves
// to be SEEN coming back out.
//
// Scaled by the impactor, so a pebble puffs and a moon fountains. The ejecta
// come out at a spread of speeds on purpose — surface escape velocity here is
// only ~80, so the slow half arcs up and rains back in (and is quietly eaten,
// no second eruption) while the fast half clears the world entirely and becomes
// ammunition. `gasEjecta` is what stops the fountain feeding itself forever.
function gasErupt(game, giant, ang, scale) {
  if (!giant || !giant.alive) return;
  const R = giant.radius;
  const n = Math.min(Math.round(3 + scale * 12), debrisRoom(game));
  // How much of this column the halo can actually keep. A failing giant vents
  // every few seconds forever, and binding every piece would let ONE dying
  // world fill the entire debris budget with its own ejecta and starve every
  // other system of fragments. Past the cap the column still flies — the
  // spectacle is the point — but the surplus stays ordinary loose debris and
  // goes home on the leash instead of joining the ring.
  const list = game.reg && game.reg.crust;
  let keep = CFG.CRUST_PER_HOST;
  if (list) for (const q of list) if (q.crust === giant && q.alive) keep--;
  for (let i = 0; i < n; i++) {
    const th = ang + (Math.random() - 0.5) * 1.15;
    // LAUNCHED TO ORBIT, NOT AWAY. Surface escape velocity here is only ~80, so
    // the first cut's 90-700 threw everything clear of the world in a second —
    // a firework, and the ejecta were gone before you could reach them. This
    // band straddles escape: most of it arcs up and is captured, a little of it
    // gets out. What is captured then SETTLES INTO THE GIANT'S HALO through the
    // ordinary crust assist, so a gas giant you keep hitting slowly wears a ring
    // built out of what you fed it and what it threw back.
    const sp = 52 + Math.random() * 78 + 34 * scale;
    const cr = R * (0.012 + 0.03 * Math.random() * scale);
    const f = spawnAsteroid(game.bodies,
      giant.x + Math.cos(th) * (R + cr + 10), giant.y + Math.sin(th) * (R + cr + 10),
      giant.vx + Math.cos(th) * sp, giant.vy + Math.sin(th) * sp, crustMass(cr));
    makeChunk(f, cr, worldDebris('gas', giant.color, Math.random()));
    f.gasEjecta = true;              // rains back in quietly — never erupts again
    f.inertT = CFG.CHUNK_INERT;      // clears the column without shattering its siblings
    if (keep > 0) {                  // ...and what the halo can hold settles into it
      keep--;
      f.crust = giant;
      f.crustFree = CFG.CRUST_FREE;
      f.crustT = game.time;
    }
  }
  // The column itself: cloud thrown straight back up the entry bearing.
  addParticles(game, giant.x + Math.cos(ang) * R, giant.y + Math.sin(ang) * R,
    giant.vx + Math.cos(ang) * 160, giant.vy + Math.sin(ang) * 160,
    24 + Math.round(scale * 40), giant.color, 260, 1.9, 6);
  addParticles(game, giant.x + Math.cos(ang) * R, giant.y + Math.sin(ang) * R,
    giant.vx + Math.cos(ang) * 110, giant.vy + Math.sin(ang) * 110,
    10 + Math.round(scale * 18), '#ffe6bd', 200, 1.3, 4);
  // ...and the throat blows open again as it vents (render.drawGasWound).
  const hits = (giant.gasHits ||= []);
  hits.push({ a: ang - giant.rot, t: game.time, s: scale });
  if (hits.length > 7) hits.shift();
  addShake(game, Math.min(9, 2 + scale * 8));
  sfx.sfxBoom(1 + scale * 1.8, sfx.distVol(game, giant.x, giant.y));
}

// INSTABILITY GEYSERS. A gas giant that has been hurt badly enough stops
// needing the player's help: past CFG.GAS_VENT it starts throwing material out
// on its own, harder and more often the closer it is to being stripped. It is
// the same eruption the impacts make, fired on a timer at a random bearing —
// the world visibly coming apart, and the payoff the venting streamers promise.
// Near-ship only, like every other world-detail system: an unwatched giant
// spending debris budget on geysers nobody sees is pure waste.
function updateGasVents(game, dt) {
  const reg = game.reg;
  if (!reg) return;
  for (const p of reg.planets) {
    if (!p.alive || p.ptype !== 'gas' || !p.nearShip) continue;
    const dmg01 = 1 - p.hp / p.maxHp;
    if (dmg01 <= CFG.GAS_VENT) { p.ventT = 0; continue; }
    const v = (dmg01 - CFG.GAS_VENT) / (1 - CFG.GAS_VENT);
    p.ventT = (p.ventT ?? 0) - dt;
    if (p.ventT > 0) continue;
    if (!p.ventedOnce) { p.ventedOnce = true; bump(game, 'gasVented'); }
    p.ventT = CFG.GAS_VENT_EVERY * (1.25 - v * 0.7) * (0.6 + Math.random() * 0.8);
    gasErupt(game, p, Math.random() * TAU, 0.15 + v * 0.35);
  }
}

// ---------------------------------------------------------------------------
// DEATH THROES OF A GAS GIANT (CFG.GAS_STRIP_TIME). Killing the biggest thing
// in the sky used to be the most abrupt death in the game: hp hit zero and the
// world was instantly replaced by a core a third its size. Now it comes apart
// over five seconds you can watch and fly through — venting from everywhere at
// once, the envelope visibly collapsing inward (the eased radius does the
// work), the hot core burning brighter through the thinning cloud — and only
// at the end does the atmosphere blow off in one shell.
//
// The body is NEVER killed and replaced: it BECOMES the core in place. That is
// what keeps its rail, its lane, its chart entry and its whole family of moons
// attached without a hand-over pass — a satellite never learns its primary
// changed. Kill credit is banked here, at the moment the player earned it.
function beginGasStrip(game, body, credit) {
  if (body.stripT > 0) return;
  body.stripT = CFG.GAS_STRIP_TIME;
  body.stripFor = CFG.GAS_STRIP_TIME;
  body.hp = 1;                       // stays alive through the throes
  body.radiusT = undefined;          // the throes drive the radius, not the chip easing
  if (game.deathLog) {
    game.deathLog.push({ t: Math.round(game.time), how: 'stripped to its core',
      type: body.type, mass: Math.round(body.mass) });
  }
  noteKill(game, body, credit, body.hitBy);
  if (credit === 'player-throw') {
    addXp(game, PROG.XP_SMASH + 12);
    game.prog.smashes++;
  }
  game.gasCollapseName = body.name || 'a gas giant';   // main.js announces it
  addShake(game, 12);
  sfx.sfxBoom(3, sfx.distVol(game, body.x, body.y));
}

// Run the throes: violent venting all over the world, rising shake, then the
// envelope goes and what is left is a rocky core on the giant's own orbit.
// A freshly exposed core, cooling: molten orange-red settling to rock grey.
// One lerp, evaluated only while a core is still hot (at most a handful ever).
function coolColor(m) {
  const r = Math.round(107 + (214 - 107) * m);
  const g = Math.round(98 + (74 - 98) * m);
  const b = Math.round(88 + (44 - 88) * m);
  return `rgb(${r},${g},${b})`;
}

function updateGasStrip(game, dt) {
  const reg = game.reg;
  if (!reg) return;
  for (const p of reg.planets) {
    // COOLING: the core walks from molten to rock over GAS_CORE_COOL. Runs
    // wherever the player is — a world that only cooled while watched would be
    // glowing exactly as you left it an hour later.
    if (p.molten > 0) {
      p.molten = Math.max(0, p.molten - dt / CFG.GAS_CORE_COOL);
      p.color = coolColor(p.molten);
    }
    if (!p.alive || !(p.stripT > 0)) continue;
    const was = p.stripT;
    p.stripT -= dt;
    const k = 1 - p.stripT / p.stripFor;           // 0 -> 1 through the collapse
    // THE ENVELOPE FALLS IN ACROSS THE WHOLE SCENE. Handing the radius to the
    // ordinary chip easing collapsed it inside the first second and a half and
    // then left the world sitting at core size for the rest of the throes — the
    // collapse has to BE the five seconds, not precede them. Accelerating, so it
    // sags and then gives way.
    p.radius = p.baseRadius * (1 - Math.pow(k, 1.6) * (1 - CFG.GAS_CORE));
    p._sil = null;
    // Vents accelerate as it fails — the world tearing itself open.
    p.ventT = (p.ventT ?? 0) - dt;
    if (p.ventT <= 0) {
      p.ventT = 0.55 - 0.3 * k;
      gasErupt(game, p, Math.random() * TAU, 0.3 + k * 0.5);
    }
    // A rumble that builds rather than one bang at the end.
    if (Math.floor(was * 4) !== Math.floor(p.stripT * 4)) addShake(game, 3 + k * 7);
    if (p.stripT > 0) continue;
    completeGasStrip(game, p);
  }
}

// The envelope goes. Everything after this is a rocky world.
function completeGasStrip(game, p) {
  p.stripT = 0;
  const R = p.baseRadius * CFG.GAS_CORE;
  p.mass = p.baseMass = p.baseMass * CFG.GAS_CORE_MASS;
  p.radius = p.baseRadius = p.radiusT = R;
  p.ptype = 'rocky';
  p.gasKind = null;
  p.ring = false;
  p.wasGiantCore = true;           // ACHIEVEMENTS: killing this again is its own feat
  p.molten = 1;                    // exposed red-hot; cools over CFG.GAS_CORE_COOL
  p.color = coolColor(1);
  p.gasHits = null;
  p.scars = [];
  p.maxHp = CFG.PLANET_HP_BASE + massToHp(p.mass) * CFG.PLANET_HP_MUL;
  p.hp = p.maxHp;
  p.name = `${(p.name || 'the giant').replace(/ Core$/, '')} Core`;
  p.attractor = true;
  p._sil = null;   // the silhouette cache is keyed on the old radius
  // THE HALO SURVIVES AS A SECOND, WIDER RING. Everything the giant threw up
  // and caught is orbiting at ~1.2 of its OLD radius — four times the core it
  // just became — so it stays exactly where it is and is railed there for good.
  // Without this the crust assist read the band off the core's radius instead,
  // decided every piece was far outside it, unbound the lot, and the leash
  // swept away the ring the player spent the whole fight building. Their rails
  // keep the halo's shared rate, so it still turns as one piece.
  if (game.reg) {
    for (const c of game.reg.crust) {
      if (!c.alive || c.crust !== p) continue;
      c.crust = null;                       // the halo band went with the atmosphere
      if (c.onRails) continue;              // already riding it
      const dx = c.x - p.x, dy = c.y - p.y;
      const r = Math.hypot(dx, dy) || 1;
      const w = chunkHaloW(p);
      c.vx = p.vx - (dy / r) * w * r;
      c.vy = p.vy + (dx / r) * w * r;
      railBody(c, p);
      c.rail.w = w;
    }
  }
  // Future crust calved off the CORE sizes its halo from the core, not the
  // giant that used to be here.
  p.haloW = undefined;
  // RAIL IT, BY FIAT. damageBody derails on every chip, so a giant arrives at
  // its own death already free-flying on whatever ellipse the impacts left it,
  // and the generic re-rail scan will not take a path that far from circular —
  // measured, a stripped core wandered from its 20,200 lane out past 35,000 and
  // kept going. The core is permanent sky anchor content and must never wander:
  // same class of law as the planet-rescue snap in the rail scan, and it also
  // keeps the moons that are still railed to it over their own lanes.
  const anchor = (p.rail && p.rail.parent) || p.parent;
  if (anchor && anchor.alive) {
    const dx = p.x - anchor.x, dy = p.y - anchor.y;
    const r = Math.hypot(dx, dy) || 1;
    const vC = Math.sqrt((CFG.G * anchor.mass * r * r) / Math.pow(r * r + CFG.GRAV_SOFT ** 2, 1.5));
    const rvx = p.vx - anchor.vx, rvy = p.vy - anchor.vy;
    const dir = Math.sign((dx * rvy - dy * rvx) / r) || 1;
    p.vx = anchor.vx - (dy / r) * dir * vC;
    p.vy = anchor.vy + (dx / r) * dir * vC;
    railBody(p, anchor);
  }
  // The envelope, going out: wide, slow, and in the giant's own colour.
  addParticles(game, p.x, p.y, p.vx, p.vy, 110, '#cfe6f2', 340, 3.0, 8);
  addParticles(game, p.x, p.y, p.vx, p.vy, 50, '#ffffff', 220, 2.0, 5);
  addShake(game, 16);
  sfx.sfxBoom(3, sfx.distVol(game, p.x, p.y));
  game.gasStrippedName = p.name;   // main.js announces it
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
  // ACHIEVEMENTS: one call classifies the corpse. body.hitBy is whatever landed
  // the killing blow (stamped in collideBodies) — the moon-shot and sniper rows
  // are the only reason it exists.
  noteKill(game, body, credit, body.hitBy);
  if (body.heldBy === 'player' && game.held === body) game.held = null;

  // FIELD GIANT: cracking one sprays a cascade of smaller FIELD rock — the
  // chaos engine of a shoal. The shards inherit the whole material through
  // world.markFieldRock (gravity-free, tough, livelier bounce) and the
  // parent's pocket index, or the pocket would slowly launder itself into
  // ordinary belt gravel every time something big broke. Mass is conserved
  // (roughly) rather than invented, and the spray is capped by the global
  // body budget like every other shed.
  if (body.fieldRock && body.giant) {
    const lo = CFG.FIELD_GIANT_SHARDS[0], hi = CFG.FIELD_GIANT_SHARDS[1];
    // Budget headroom must sit ABOVE the world's steady-state body count
    // (~9700 with four pockets) or the cascade silently never fires — keep it
    // in step with the caps in world.replenishWorld.
    const n = Math.min(lo + Math.floor(Math.random() * (hi - lo + 1)),
      Math.max(0, 11200 - game.bodies.length));
    const share = (body.mass * 0.72) / Math.max(1, n);
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + Math.random() * 0.6;
      const sp = 40 + Math.random() * 110;
      const shard = spawnAsteroid(game.bodies,
        body.x + Math.cos(th) * (body.radius * 0.7),
        body.y + Math.sin(th) * (body.radius * 0.7),
        body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp,
        share * (0.6 + Math.random() * 0.8));
      markFieldRock(shard, body.field);
      // A shard big enough to be worth breaking again keeps the cascade
      // going — one more level, not an unbounded chain (the threshold sits
      // above what a second-generation shard can inherit, so it terminates).
      if (shard.mass > 3000) shard.giant = true;
    }
    addParticles(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 34, body.color, 210, 1.3, 4);
    addShake(game, 9);
  }

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
    // A DYING WORLD COMES APART — the whole thing, not a token spray. Ejection
    // speeds are LOW on purpose: the cloud should hang together and visibly
    // jostle — pieces grinding past each other — before gravity and the
    // orbital flow shear it into a debris stream. Fast ejecta reads as a
    // firework that empties the screen in a second.
    // Sizes run a real SPECTRUM, and they are sized off the world's RADIUS,
    // not its mass, for the reason in CFG.CRUST_*: a mass-derived radius draws
    // a dead 705-unit planet as a puff of ~10-unit specks. The exponent skews
    // small, so the cloud is mostly rubble with a few genuine slabs of crust
    // tumbling through it.
    const [lo, hi] = CFG.CRUST_DEATH;
    const n = Math.min(lo + Math.floor(Math.random() * (hi - lo + 1)), debrisRoom(game));
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + (Math.random() - 0.5) * 0.9;
      const rr = body.radius * (0.15 + Math.random() * 0.9);
      const s = 20 + Math.random() * 120;
      const pr = body.radius * (0.045 + 0.2 * Math.pow(Math.random(), 2.4));
      const f = spawnAsteroid(
        game.bodies,
        body.x + Math.cos(th) * rr,
        body.y + Math.sin(th) * rr,
        body.vx + Math.cos(th) * s + (Math.random() - 0.5) * 60,
        body.vy + Math.sin(th) * s + (Math.random() - 0.5) * 60,
        crustMass(pr),
      );
      makeChunk(f, pr, worldDebris(body.ptype, body.color, Math.random()));
      // The cloud is born INSIDE the volume the world occupied, so every piece
      // starts overlapping several others. Inert, they drift apart and settle;
      // solid, they resolved that overlap by eating each other on frame one.
      f.inertT = CFG.CHUNK_INERT;
    }
    // The halo it was already wearing joins its own funeral: the rails pass
    // derails these off the dead parent, updateCrust unbinds them, and this
    // kick throws them outward with the rest instead of leaving a tidy ring
    // hanging in the hole where the world used to be.
    if (game.reg) {
      for (const c of game.reg.crust) {
        if (!c.alive || c.crust !== body) continue;
        derail(c); c.crust = null;
        const ca = Math.atan2(c.y - body.y, c.x - body.x);
        const cs = 40 + Math.random() * 90;
        c.vx += Math.cos(ca) * cs; c.vy += Math.sin(ca) * cs;
      }
    }
  } else if (isWorld && body.ptype === 'gas') {
    // Unreachable in normal play: damageBody diverts a gas giant at zero hp
    // into beginGasStrip (the death THROES) instead of here. This stays as the
    // honest fallback for anything that calls shatter on one directly — a
    // dev hook, a future instakill — and just completes the strip at once.
    completeGasStrip(game, body);
    return;
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
  } else if (body.chunk && body.radius >= CFG.CHUNK_SPLIT_R) {
    // A BIG PIECE OF A WORLD BREAKS LIKE THE WORLD DID (CFG.CHUNK_SPLIT_*).
    // Crust is drawn as a fraction of its parent planet, so the biggest slabs
    // run 100+ units across, and one of those bursting into a puff of dust
    // reads wrong beside a planet that comes apart into sixty pieces. Each
    // child is a third to a half its parent, so a 130-unit slab goes 130 ->
    // ~50 -> ~20 -> under the threshold: the cascade is two or three levels
    // deep and terminates on its own, the same shape as the field-giant shard
    // rule above.
    const [lo, hi] = CFG.CHUNK_SPLIT;
    const n = Math.min(lo + Math.floor(Math.random() * (hi - lo + 1)), debrisRoom(game));
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + (Math.random() - 0.5) * 0.7;
      const sp = 30 + Math.random() * 90;
      const cr = body.radius * (0.3 + Math.random() * 0.22);
      const f = spawnAsteroid(game.bodies,
        body.x + Math.cos(th) * body.radius * 0.5, body.y + Math.sin(th) * body.radius * 0.5,
        body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp, crustMass(cr));
      makeChunk(f, cr, { color: body.color, ice: body.ice, cored: false });
      f.inertT = CFG.CHUNK_INERT;   // passes through other debris while it flies clear
      // Rubble from a slab that was riding a world's halo rejoins that halo —
      // smash a slab in orbit and its pieces settle back around the planet
      // instead of scattering into the lane (updateCrust; the free window lets
      // them tumble apart first).
      if (body.crust && body.crust.alive) { f.crust = body.crust; f.crustFree = CFG.CRUST_FREE; f.crustT = game.time; }
      // NO CREDIT PROPAGATION. A split is the one place the gravity-billiards
      // stamp must not travel: every child is itself splittable, so a marked
      // child that kills another chunk pays throw-kill XP AND passes the mark
      // on again. One thrown slab into a packed halo ran that loop until it hit
      // the debris budget and took a fresh run to tier 5 in seconds. Same rule
      // shard and Demolition damage already follow — the chain stays bounded.
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
    dropScrap(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, 120, body.fieldRock);
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

  // SHOAL SALVAGE goes through the field gates too (fieldXp): debris chunks are
  // pure XP now, so the scrap IS an XP stream and has to be capped with the
  // rest, or the farm just moves to the pickups. Chunks are priced in `value`
  // and pay `value * XP_SCRAP` when collected, so the budget is charged in XP
  // and the allowance converted back — which leaves non-field drops bit-exact.
  // (Charged at DROP time, not pickup: the chunk has no memory of its parent,
  // and uncollected debris expiring is the player's loss either way.)
  const fieldVal = (v) => v <= 0 ? v : fieldXp(game, body, v * PROG.XP_SCRAP) / PROG.XP_SCRAP;
  // Scrap is EARNED, not ambient: only a player throw or a shield-rock hit
  // (credit === 'player') pays out. A rock the player never touched — belt
  // traffic sandblasting itself, a rogue clipping a moon, a ram, star heat —
  // shatters with no salvage. Keeps the sky from minting free scrap.
  if (earnsScrap(credit)) dropScrap(game, body.x, body.y, body.vx * 0.4, body.vy * 0.4, fieldVal(scrapValue(body)), body.fieldRock);
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
  if (credit === 'ram') addXp(game, fieldXp(game, body, PROG.XP_RAM + (isBig ? 8 : 0)));
  if (credit === 'player-throw') {
    brawlerThrowKill(game, body);   // Cluster Rounds / Shockwave / Demolition (no-op unless owned)
    addXp(game, fieldXp(game, body, PROG.XP_SMASH + (isBig ? 12 : 0)));
    game.prog.smashes++;
    // GRAVITY BILLIARDS: throw-kills chained within the window rack up a
    // combo (the chain is carried by propagated credit in collideBodies).
    // 2+ pays a bonus and flags main.js to shout the multiplier.
    game.combo = (game.combo || 0) + 1;
    game.comboT = 2.6;
    game.comboBest = Math.max(game.comboBest || 0, game.combo);
    if (game.combo >= 2) {
      game.comboShow = game.combo;
      // Gated in a shoal too: a chain through touching rocks is the easiest
      // combo in the game, and the bonus must not out-pay a real one.
      dropScrap(game, body.x, body.y, body.vx * 0.3, body.vy * 0.3, fieldVal(8 * game.combo), body.fieldRock);
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
          dropScrap(game, body.x + body.radius * 0.8, body.y, body.vx * 0.5, body.vy * 0.5, 200, body.fieldRock);
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
  // CRYSTAL WORLDS: a hard PLAYER smash rings a facet loose — one dense core
  // shard (the cored-rock salvage economy: fat beam catch, 3.5x scrap) pops
  // off the impact point. The sulfur-vent gates, except the damage floor is 3,
  // not 8: mass dominance throttles what a thrown rock does to a PLANET (a
  // solid 1000-mass throw lands ~6), so the moon-tuned floor was unreachable.
  // earnsScrap credit only, a long cooldown (decayed in world.js's
  // always-running pre-pass), never on the killing blow.
  if (body.type === 'planet' && body.ptype === 'crystal' && earnsScrap(credit) &&
      dmg > 3 && !(body.shardCd > 0) && body.hp - dmg > 0) {
    body.shardCd = 45;
    const sa = (hx !== undefined) ? Math.atan2(hy - body.y, hx - body.x) : Math.random() * TAU;
    const sp = 150 + Math.random() * 90;
    const shard = spawnAsteroid(game.bodies,
      body.x + Math.cos(sa) * (surfReach(body) + 18), body.y + Math.sin(sa) * (surfReach(body) + 18),
      body.vx + Math.cos(sa) * sp, body.vy + Math.sin(sa) * sp, 600 + Math.random() * 800);
    shard.core = true; shard.color = '#b98cff';
    addParticles(game, shard.x, shard.y, body.vx * 0.3, body.vy * 0.3, 16, '#d8b8ff', 170, 1.1, 3);
    game.shardWarn = true;
  }
  // A gas giant already coming apart takes no more damage — the throes own it.
  if (body.stripT > 0) return;
  derail(body);
  body.hp -= dmg;
  if (body.hp <= 0) {
    // A GAS GIANT DOES NOT SHATTER — it goes into death throes and ends up as a
    // core (beginGasStrip). Everything else dies here as it always did.
    if (body.ptype === 'gas' && (body.type === 'planet' || body.type === 'rogue')) {
      beginGasStrip(game, body, credit);
      return;
    }
    shatter(game, body, credit); return;
  }
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
  const isWorldBody = body.type === 'planet' || body.type === 'moon' || body.type === 'rogue';
  // Small rocks scar too — wear is universal, only the SPRAY needs the mass
  // gate. Their maxHp is tiny so the gate is fractional (a real bite of the
  // rock, not a graze), with a radius floor below which a scar can't read.
  // A WORLD CRUMBLES WHERE IT WAS STRUCK, so wear needs an impact point.
  // Every impact path passes one (collisions, the ram, a Demolition blast, a
  // fort turret); the two CONTINUOUS environmental sources — corona heat and
  // atmosphere burn-up — pass none, and must not crater or calve: they are a
  // fraction of maxHp per call, which since planets went to the flat
  // PLANET_HP_BASE (18,000+) is ~21 damage a substep, clearing the absolute
  // CHUNK_DMG_MIN gate 120 times a second. A world melting in the corona would
  // have shed its entire crust in about a second. Melting shows as the crack
  // web (drawBodyDamage reads hp directly); craters are for things that hit it.
  const scarHit = hx !== undefined && (bigEnough
    ? (dmg >= CFG.CHUNK_DMG_MIN * 0.5 || frac >= CFG.CHUNK_DMG_FRAC * 0.5)
    : (frac >= 0.15 && body.radius >= 5));
  if (canWear && scarHit) {
    // severity 0..1 blends both gates: frac carries moons, raw damage carries
    // planets (whose maxHp dwarfs any single hit)
    const sev = clamp(frac * 8 + dmg / 60, 0.15, 1);
    const ia = (hx !== undefined) ? Math.atan2(hy - body.y, hx - body.x) : Math.random() * TAU;
    const hard = bigEnough && (dmg >= CFG.CHUNK_DMG_MIN || frac >= CFG.CHUNK_DMG_FRAC);
    // THE CRUMBLE. A WORLD calves real pieces of itself that STAY — they pop
    // out of the crater, tumble, and settle into a rubble halo hanging over
    // the wound (calveCrust / updateCrust). Every wounding hit sheds at both
    // scales: a light one flakes a crumb, a hard one takes a slab off and
    // showers crumbs with it. Big LOOSE bodies (a giant asteroid) keep the old
    // outward spray below — they have no surface to hang a halo on.
    let bite = 0;   // radius of the biggest piece that left, so the crater matches it
    // CALVING IS NEAR-SHIP TOO. A world takes ambient hits all run long; off-view
    // those would spend halo slots and debris budget on rubble nobody watched
    // break off. The CRATER still lands either way — that is a cheap array push
    // and it is the world's record of the wound, so a planet you left under
    // bombardment still shows the wear when you come back.
    if (isWorldBody && bigEnough && body.nearShip) {
      const n = Math.min(hard ? 1 + Math.round(sev * 3) : 1, debrisRoom(game));
      for (let k = 0; k < n; k++) {
        // The first piece is the SLAB the hit took off, and it comes out of
        // the crater. The rest are crumbs knocked loose around it.
        const kSev = k === 0 ? sev : sev * (0.18 + Math.random() * 0.3);
        const th = ia + (Math.random() - 0.5) * (k === 0 ? 0.5 : 2.2);
        const f = calveCrust(game, body, th, kSev, credit);
        if (!f) continue;   // halo full of bigger pieces — this hit only scars
        bite = Math.max(bite, f.radius);
      }
      // The calve deliberately does NOT bill the host for the mass it made.
      // Crust mass is derived from DRAWN size against the tractor's tier caps
      // (config.crustMass), not from a share of the parent, so a four-piece
      // calve mints up to ~90,000 — nearly half a mid planet. Subtracting that
      // shrank the world visibly with every moon strike (radius tracks
      // cbrt(mass/baseMass)) and would have hollowed it out long before its hp
      // ran out. Erosion still happens, through the chip path below, which is
      // where it was always metered.
    } else if (hard && !isWorldBody && debrisRoom(game) > 0) {
      const n = Math.min(2 + Math.round(sev * 4), debrisRoom(game));
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
          body.x + Math.cos(th) * (surfReach(body) * 1.03 + 14),
          body.y + Math.sin(th) * (surfReach(body) * 1.03 + 14),
          body.vx + Math.cos(th) * sp, body.vy + Math.sin(th) * sp, m);
        f.color = body.color;   // wreckage reads as pieces of the body it was
        // GRAVITY BILLIARDS: chunks your throw knocked loose carry your credit
        // for a beat — same rule as the knocked-rock propagation in
        // collideBodies. ONLY on a direct 'player-throw' hit: shard/Demolition
        // damage stays credit-neutral so those chains remain bounded.
        if (credit === 'player-throw') { f.thrownBy = 'player'; f.thrownTimer = 1.4; }
        shed += m;
      }
      body.mass = Math.max(body.baseMass * 0.25, body.mass - shed);
    }
    // The crater is sized to the piece that came out of it — render draws the
    // bite at R x 0.06 x s, so a slab of radius `bite` leaves a hole exactly
    // that wide. THIS is the read the whole feature turns on: a notch missing
    // from the rim with the matching slab floating in it. Hits that shed
    // nothing (a full halo, an exhausted budget) fall back to the old
    // severity-sized mark, so wear still shows.
    // The upper clamp is what keeps a wound reading as CRATERS. Render draws a
    // bite at R x 0.06 x s of pure space colour, so s = 2 is already 12% of the
    // world punched out per hit; letting it track the biggest slabs (s ~ 3.4)
    // meant a dozen hits along one arc merged into a single flat black gouge
    // with no internal edges — which reads as a hole in the renderer, not as a
    // battered planet.
    const s = bite > 0 ? clamp(bite / (body.radius * 0.06), 0.5, 2) : 0.6 + sev * 1.6;
    // scar angle is stored SURFACE-LOCAL (minus rot) so the bite rides the spin
    body.scars.push({ a: ia - body.rot, s, t: game.time });
    // A WORLD KEEPS ITS WORST WOUNDS, not its most recent ones. Dropping the
    // oldest meant a handful of pebble chips after a moon strike quietly
    // erased the crater the moon left — the limb went back to smooth while the
    // slabs it knocked off were still hanging over it.
    if (body.scars.length > 10) {
      let wi = 0;
      for (let i = 1; i < body.scars.length; i++) if (body.scars[i].s < body.scars[wi].s) wi = i;
      body.scars.splice(wi, 1);
    }
    if (bite > 0 || hard) {
      addParticles(game,
        body.x + Math.cos(ia) * body.radius, body.y + Math.sin(ia) * body.radius,
        body.vx * 0.5, body.vy * 0.5, 8 + Math.round(sev * 16), body.color, 170, 1, 4);
    }
    // Only a HARD bite is an event. A crumb flaking off gets its dust and
    // nothing else — the chip already carries the collision's own sound, and
    // a boom per crumb turns a sustained bombardment into a drum roll.
    if (hard) {
      addShake(game, Math.min(10, 2 + sev * 9));
      sfx.sfxBoom(1 + sev * 1.5, sfx.distVol(game, body.x, body.y));
    }
  }

  if (frac > 0.01) {
    // Chip scrap only from player-caused hits (throw / shield) — see shatter
    // CHIP scrap — the firehose in the shoal exploit: every chained impact that
    // merely dents a rock dropped salvage, and there were thousands per second.
    // Same gates as the kill drop above (fieldXp charges the pocket's budget).
    if (earnsScrap(credit)) {
      const v = scrapValue(body) * frac * 0.5;
      dropScrap(game, body.x, body.y, body.vx * 0.5, body.vy * 0.5,
        fieldXp(game, body, v * PROG.XP_SCRAP) / PROG.XP_SCRAP, body.fieldRock);
    }
    body.mass = Math.max(body.baseMass * 0.25, body.mass - body.baseMass * frac * 0.35);
    addParticles(game, body.x, body.y, body.vx * 0.5, body.vy * 0.5, 8, body.color, 100, 0.7);
  }
  // One radius/attractor rebuild covers both the chip and chunk mass losses.
  // The radius is a TARGET, not an assignment: mass loss used to resize the body
  // on the frame of the hit, so a world visibly popped a size smaller every time
  // something big landed. The integrate loop eases the live radius toward this,
  // and since collisions read the live radius the felt size follows the drawn
  // one all the way down.
  body.radiusT = body.baseRadius * Math.cbrt(body.mass / body.baseMass);
  if (body.mass < CFG.ATTRACT_MIN && body.type !== 'star') body.attractor = false;
}

function vaporize(game, body) {
  if (!body.alive) return;
  body.alive = false;
  if (game.deathLog) game.deathLog.push({ t: Math.round(game.time), how: 'vaporized by star', type: body.type, mass: Math.round(body.mass) });
  // ACHIEVEMENTS: only a body YOU put on that trajectory counts as an offering
  // — the belt drops things into the sun on its own all day.
  if (body.thrownBy === 'player') {
    bump(game, 'sunFed');
    if (body.mass >= 3500) bump(game, 'sunFedBig');
  }
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
  if (alien.kind === 'wright') bump(game, 'kWright');
  else if (alien.kind === 'golem') bump(game, 'kGolem');
  else if (alien.kind === 'lurker') bump(game, 'kLurker');
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
  const hadShield = s.shield > 0 || game.st.shieldMax > 0;
  s.hull -= rem;
  if (dmg >= 1) {   // continuous grinding (Oort cloud) shouldn't spam fx
    // ACHIEVEMENTS: count real BLOWS, not grinding ticks — the same >= 1 gate
    // the fx use, so "50 hits" means fifty things actually hit you.
    bump(game, 'hits');
    if (hadShield && s.shield <= 0 && rem > 0) bump(game, 'shieldBreaks');
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

// INFLUENCE CUTOFF (perf): an attractor whose pull at this range is below
// GRAV_CULL_A (u/s²) contributes nothing a player could ever observe — over a
// full minute of flight the integrated error is ~1 u/s against orbital speeds
// of hundreds. Skipping it turns the per-substep gravity sum for every loose
// rock / alien / debris chunk from O(all attractors) into "the sun plus the
// few neighbors that actually matter", which is what lets the system scale.
// cullR2 = G·m / EPS is the squared range where the pull decays to EPS;
// step() stamps it on each attractor once per substep (mass changes on
// damage, so it can't be precomputed at spawn). The SHIP (starMul/heavyMul
// ≠ 1) uses the much wider cullShip2 below, sized so nothing it could feel
// above EPS — LONG ARMS boost included — is ever dropped; the compass and
// the predictPaths mirror share exactly that rule. Celestials use
// gravityOnBody (below), which keeps invariant 2's symmetric pairs and is
// untouched by this.
const GRAV_CULL_A = 0.02;
export const GRAV_CULL_K = CFG.G / GRAV_CULL_A;   // predictPaths mirrors the same constant
// The SHIP's cutoff must be far more conservative: its felt pull is scaled by
// SHIP_GRAV × PLANET_GRAV_SHIP and LONG ARMS can boost a far world's tug by
// up to SHIP_WELL_MAX — so its cull range is widened by exactly that worst
// case, keeping every attractor the ship could feel above GRAV_CULL_A. The
// same constant is used by gravityAt (the real ship) AND predictPaths'
// accelAt (the forecast), so the mirror law holds: the drawn path and the
// flown path cull identically.
export const SHIP_CULL_K = GRAV_CULL_K * CFG.SHIP_GRAV * CFG.PLANET_GRAV_SHIP * CFG.SHIP_WELL_MAX;

// Full acceleration from all attractors at point (x,y) — used for the ship,
// aliens, and debris. The ship always feels everything; aliens/debris/loose
// rocks skip negligible far-field attractors (see the cutoff note above).
function gravityAt(attractors, x, y, starMul = 1, heavyMul = 1) {
  let ax = 0, ay = 0, pax = 0, pay = 0;
  const loose = starMul === 1 && heavyMul === 1;   // ship passes ≠1 → the wide ship cutoff
  for (const b of attractors) {
    const dx = b.x - x, dy = b.y - y;
    const d2 = dx * dx + dy * dy + SOFT2;
    if (d2 > (loose ? b.cullR2 : b.cullShip2)) continue;   // negligible tug — skip the sqrt+div
    const star = b.type === 'star';
    const heavy = b.type === 'planet' || b.type === 'moon' || b.type === 'rogue';
    let w = star ? starMul : heavy ? heavyMul : 1;
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

// Effective surface radius of `body` toward the world bearing `ang` (radians,
// from the body's center). CRYSTAL planets collide as their drawn shard
// polygon (util.crystalShards — the SAME table render draws, so the felt
// surface is the seen surface, spikes included, and it turns with b.rot);
// everything else is the circle it always was. Radial narrow phase: the
// collision normal stays radial, which is what the resolver assumes anyway.
function surfRadius(body, ang) {
  if (body.ptype === 'crystal') {
    const sh = (body.cjag ||= crystalShards(body.id));
    return body.radius * crystalRadiusAt(sh, ang - body.rot);
  }
  // CRATERED WORLDS collide as the shape they are DRAWN as, for exactly the
  // reason crystal worlds do. Once impacts started cutting real notches out of
  // a world's outline, the collider was still the full circle behind them, so
  // a rock crossing the mouth of a crater stopped dead in open space — the
  // wound was a hole in the picture only. util.scarSurfaceAt is the shared
  // profile (render.worldSil draws from the same call), and scars are stored
  // surface-local, so the bearing loses b.rot exactly as the crystal path does.
  // Rocks are excluded — they collide as circles and draw as their own jag,
  // and render.traceSurface makes the same exclusion.
  if (body.type !== 'asteroid' && body.scars.length) {
    return body.radius * scarSurfaceAt(body.scars, body.radius, ang - body.rot);
  }
  return body.radius;
}
// Does this body's surface depart from a circle at all? The narrow phase pays
// for a bearing solve only when one of the pair answers yes.
//
// CRATERS ARE GATED ON `nearShip` (set in updateFieldLOD): the notched collider
// exists so the wound you can see is the wound you can fly into, and off-view
// there is nothing to see — the world collides as the circle it always was, at
// no cost. Crystal worlds are NOT gated: their spikes reach OUTSIDE the radius,
// so dropping to the disc would make the collider smaller than the body, and
// the railed junk ring floating just past those spikes is tuned against them.
function shaped(body) {
  return body.ptype === 'crystal'
    || (body.nearShip && body.type !== 'asteroid' && body.scars.length > 0);
}
// Spawn-clearance reach: anything born off a body's surface (chunks, shards)
// must clear the TALLEST feature, not the mean disc — a chunk born inside a
// crystal spike takes collision damage and sheds again (the exact feedback
// loop invariant 7 warns about).
function surfReach(body) {
  return body.ptype === 'crystal' ? body.radius * CRYSTAL_REACH : body.radius;
}

function collideBodies(game, a, b) {
  // A parry-frozen rock is pinned at the ship's hull — nothing grinds it
  // (or gets ground by it) until the flick launches it back into play.
  if (a.parryFrozen || b.parryFrozen) return;
  // FRESH FRAGMENTS PASS THROUGH OTHER DEBRIS (CFG.CHUNK_INERT). Rock-on-rock
  // is where the split cascade lived: pieces of a shattered slab landing in a
  // world's packed halo shattered THOSE, and the wave ran to the debris budget.
  // Scoped to loose rock on purpose — the ship and the aliens have their own
  // collision paths and are untouched, and celestials still connect, because a
  // slab ghosting through a planet and out the far side reads as broken.
  if ((a.inertT > 0 || b.inertT > 0) && a.type === 'asteroid' && b.type === 'asteroid') return;
  // A rock going under a gas giant's cloud tops is already gone — it just has
  // not finished the fall yet (CFG.GAS_SINK). Nothing touches it on the way in.
  if (a.sinkT > 0 || b.sinkT > 0) return;
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
  let rr = a.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  // NON-CIRCULAR SURFACES (a crystal world's shard polygon, a cratered world's
  // notched limb) get a radial narrow phase: bound cheaply first, then refine
  // rr along the actual bearing. Spikes reach OUTSIDE the radius, so crystal
  // has to bound on surfReach; craters only cut inward, so the plain sum is
  // already a valid outer bound and the early-out below does the rejecting.
  if (shaped(a) || shaped(b)) {
    const bound = surfReach(a) + surfReach(b);
    if (d2 >= bound * bound) return;
    const ang = Math.atan2(dy, dx);
    rr = surfRadius(a, ang) + surfRadius(b, ang + Math.PI);
  }
  if (d2 >= rr * rr) return;
  const d = Math.sqrt(d2) || 0.001;
  const overlap = rr - d;

  // Stars vaporize anything they touch
  if (a.type === 'star' || b.type === 'star') {
    const victim = a.type === 'star' ? b : a;
    if (victim.type !== 'star') vaporize(game, victim);
    return;
  }

  // A GAS GIANT SWALLOWS (CFG.GAS_* — "it swallows"). There is no surface to
  // bounce off, so loose rock reaching the cloud tops sinks and is gone. This
  // replaces the old behaviour, where a thrown rock rebounded off a ball of
  // hydrogen and, if you kept at it, blew the whole world into stone fragments.
  // The giant still takes the impact, scaled by the impactor and damped by
  // GAS_IMPACT_MUL — a pebble is weather, a thrown moon is a real wound — so a
  // gas giant remains something you CAN fight, just not with gravel.
  // Anything HELD is exempt — beam cargo and the orbit wall alike (`heldBy`
  // covers both). The ship dives these on purpose (GAS_CRUSH_DPS), and having
  // the atmosphere strip your shield rock by rock on the way in would be a
  // second, unannounced penalty on a mechanic that already charges you hull.
  {
    const giant = a.ptype === 'gas' ? a : b.ptype === 'gas' ? b : null;
    const rock = giant === a ? b : a;
    // EVERYTHING sinks, not just loose rock. Scoping this to `type ===
    // 'asteroid'` left a thrown MOON falling through to the ordinary contact
    // path, where the giant's mass dominance shattered it against the cloud
    // tops — the single most dramatic thing you can throw at a gas giant
    // exploded on it instead of going in. A PLANET is the exception: two worlds
    // meeting is the top of invariant 8's ladder and belongs on the ordinary
    // path, where the giant takes a real wound and neither body silently
    // disappears. Stars were handled above.
    if (giant && rock.type !== 'planet' && !rock.heldBy && !rock.parryFrozen && rock.alive) {
      const rel = Math.hypot(rock.vx - giant.vx, rock.vy - giant.vy);
      const wasThrown = rock.thrownTimer > 0;
      // The ordinary damage terms, so a gas impact stays in ratio with every
      // other impact in the game...
      const eff = Math.max(0, rel - (wasThrown ? CFG.DMG_THRESH_THROWN : CFG.DMG_THRESH));
      const mult = wasThrown ? CFG.DMG_THROWN_MULT : 1;
      // ...except mass dominance is SOFTENED (CFG.GAS_DOM_EXP). Dominance models
      // a heavy body shrugging off a light one because it is RIGID, and a gas
      // giant is not: a moon plunging in deposits its energy deep rather than
      // chipping a surface. At full dominance a thrown moon did 1.7% of a
      // giant's hp — sixty moons to strip one.
      const dom = Math.pow(rock.mass / (rock.mass + giant.mass), CFG.GAS_DOM_EXP);
      // ...and the whole thing is CAPPED per impact (CFG.GAS_HIT_CAP), because
      // the speed term is quadratic and a late-game sling would otherwise end a
      // gas giant in two throws.
      const dmg = Math.min(giant.maxHp * CFG.GAS_HIT_CAP,
        CFG.DMG_BODY * eff * eff * rock.mass * mult * CFG.GAS_IMPACT_MUL * 2 * dom);
      // ENTRY PLUME: the cloud tops boil where it went in, in the giant's own
      // colour, thrown back OUT along the entry bearing (this runs before the
      // shared normal is computed, so it takes its own).
      const ex = (rock.x - giant.x) / d, ey = (rock.y - giant.y) / d;
      addParticles(game, rock.x, rock.y, giant.vx + ex * 40, giant.vy + ey * 40,
        Math.min(26, 6 + Math.round(rock.mass / 260)), giant.color,
        150, 1.2, Math.min(6, 2 + rock.radius * 0.08));
      if (rock.mass > 900) {
        addShake(game, Math.min(7, rock.mass / 2600));
        sfx.sfxBoom(1, sfx.distVol(game, rock.x, rock.y));
      }
      if (game.deathLog) {
        game.deathLog.push({ t: Math.round(game.time), how: 'swallowed by a gas giant',
          type: rock.type, mass: Math.round(rock.mass) });
      }
      // THE ENTRY WOUND — surface-local, so it rides the giant's rotation like
      // every other feature. render.drawGasWound turns these into the flash,
      // the shock ring and the punch-hole that swirls shut. Sized off the
      // impactor, so a pebble dimples the cloud tops and a moon tears them open.
      const hits = (giant.gasHits ||= []);
      hits.push({ a: Math.atan2(rock.y - giant.y, rock.x - giant.x) - giant.rot,
        t: game.time, s: Math.min(1, 0.18 + rock.mass / 9000) });
      if (hits.length > 7) hits.shift();
      // It SINKS rather than vanishing: it keeps ploughing in for GAS_SINK
      // seconds, slowing and fading as the clouds close over it (the integrate
      // loop runs the timer, render fades it, collisions ignore it meanwhile).
      // ACHIEVEMENTS: only a body the PLAYER put on that trajectory counts as
      // feeding — the belt drops rocks into these all day on its own.
      if (rock.slung || rock.thrownBy === 'player') {
        bump(game, 'gasFed');
        if (rock.type === 'moon') bump(game, 'gasFedMoon');
      }
      // CREDIT IS READ BEFORE THE THROWN STATE IS CLEARED. collisionCredit keys
      // off `thrownBy`/`thrownTimer`, so clearing them first made every kill a
      // gas giant ever took read as ambient — no kill credit, no XP, and the
      // Giant Slayer row could never land however many moons you fed it.
      const cred = collisionCredit(giant, rock);
      giant.hitBy = rock;           // ACHIEVEMENTS: what landed the blow
      rock.sinkT = CFG.GAS_SINK;
      rock.sinkIn = giant;          // who eats it, and who erupts when it lands
      rock.thrownBy = null; rock.thrownTimer = 0;
      if (dmg > 0.5) damageBody(game, giant, dmg, cred, rock.x, rock.y);
      return;
    }
  }

  const nx = dx / d, ny = dy / d;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const closing = -(rvx * nx + rvy * ny);

  // TWO RAILED CELESTIALS BRUSHING AT CONJUNCTION PASS THROUGH EACH OTHER.
  // Moon families deliberately reach past Hill stability (world.js moonZone,
  // maxR = hill * 1.5) so systems stay wide, which means NEIGHBOURING planets'
  // families overlap radially — measured on seed 3827467762, 16 of 20 adjacent
  // pairs do, several by >8000u. Adjacent lanes run at different angular speeds
  // and therefore ALWAYS reach conjunction, so these touches are a normal,
  // recurring event and not drama. They were silently lethal: at closing
  // 25-240 an impact does NO damage and logs NOTHING (see the sub-DMG_THRESH
  // note below), but the `closing > 25` derail below still fired, and a moon
  // knocked out of its exact orbit falls into whatever it is near — around a
  // gas giant it was SWALLOWED within seconds. Every loss traced this way was a
  // brush at closing 70-185: 4 swallowed + 7 absorbed moons per 600s idle soak,
  // with no player anywhere. Letting them overlap is the user's design call —
  // moons stay far out, and a conjunction must not unmake a charted world.
  //
  // Deliberately narrow. It needs BOTH bodies railed (a rail is an exact,
  // deterministic orbit — nothing here is reacting to it) and BOTH natural
  // (`thrownTimer <= 0`), so player and alien throws keep every bit of their
  // impulse, damage and derail. Above DMG_THRESH the collision is real again
  // and resolves normally, so a genuine celestial crunch still happens.
  // Returning BEFORE the separation/impulse below is the point: a railed body
  // shoved by contact resolution snaps back on its next rail advance and
  // visibly vibrates, so a half-fix that only skipped the derail would trade a
  // dead moon for a juddering one.
  if (a.onRails && b.onRails && closing < CFG.DMG_THRESH &&
      a.thrownTimer <= 0 && b.thrownTimer <= 0 &&
      (a.type === 'planet' || a.type === 'moon') &&
      (b.type === 'planet' || b.type === 'moon')) return;

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
    bump(game, 'blocks');
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
      rock.throwX = rock.x; rock.throwY = rock.y;
      derail(rock);
      bump(game, 'aegisBack');
    }
  }

  // No surface-hugging: a small body drifting gently onto a much bigger one
  // is absorbed (either you're in orbit, or you're part of the planet now).
  if (closing >= 0 && closing < 70) {
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    if (big.mass >= small.mass * 15 && !small.heldBy && small.type !== 'rogue' &&
        small.type !== 'station' && small.type !== 'nest' &&   // artificial structures don't melt into planets
        !(small.fieldRock && big.fieldRock) &&   // shoal rocks BOUNCE off their giants — a pocket that
                                                 // quietly ate every gentle contact with a 15x mass
                                                 // ratio digested itself around its own giants
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
    let e = CFG.RESTITUTION * (1 + (dom - 0.5) * 2.3);
    // FIELD ROCK caroms. Its whole point is that a shoal plays like a pinball
    // table, so field-vs-field contact uses a FLAT near-elastic restitution
    // instead of scaling the world's deliberately deadened one (that scaling
    // still left equal-mass hits at ~0.74 — thuds, not caroms). Kept under 1:
    // e >= 1 ADDS energy on every hit and a pocket this size boils itself apart.
    if (a.fieldRock && b.fieldRock) e = CFG.FIELD_BOUNCE;
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
    // In a DENSE FIELD that chain is bounded (CFG.FIELD_CHAIN_MAX): the rocks
    // touch, so an unbounded mark spread through the whole pocket and laundered
    // it into one endless player throw — full lethality (the FIELD_TOUGH damp
    // exempts player throws) and full payout. `chainN` is the link number, set
    // to 0 at every REAL launch (tractor.releaseHeld / flingAllFromOrbit /
    // the parry riposte) so a rock you re-throw always starts a fresh chain.
    if (closing > 60) {
      const aPlayer = (a.thrownBy === 'player' && a.thrownTimer > 0) || a.heldBy === 'orbit';
      const bPlayer = (b.thrownBy === 'player' && b.thrownTimer > 0) || b.heldBy === 'orbit';
      if (aPlayer && bMoves && b.type === 'asteroid' && b.thrownBy !== 'player' &&
          chainOk(a, b)) {
        b.thrownBy = 'player'; b.thrownTimer = Math.max(b.thrownTimer, 1.4);
        b.chainN = (a.chainN || 0) + 1;
      }
      if (bPlayer && aMoves && a.type === 'asteroid' && a.thrownBy !== 'player' &&
          chainOk(b, a)) {
        a.thrownBy = 'player'; a.thrownTimer = Math.max(a.thrownTimer, 1.4);
        a.chainN = (b.chainN || 0) + 1;
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
    // FIELD ROCK has a thick hide against ITS OWN KIND: the pocket is meant
    // to be knocked around INDEFINITELY — hits send rocks flying, they don't
    // erase them. The damp covers every field-vs-field impact, including
    // lurker body-checks and chain caroms (those are 'thrown', and at full
    // damage every shove vaporized its target instead of billiarding it);
    // ONLY a player's own throw punches at full strength, because smashing
    // field rock deliberately still works and still pays.
    if (a.fieldRock && b.fieldRock &&
        !((a.thrownBy === 'player' && a.thrownTimer > 0) ||
          (b.thrownBy === 'player' && b.thrownTimer > 0))) {
      dmgToA *= CFG.FIELD_TOUGH; dmgToB *= CFG.FIELD_TOUGH;
    }
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
      a.hitBy = b;   // ACHIEVEMENTS: who landed this blow (shatter reads it back)
      damageBody(game, a, dmgToA, creditA, b.x, b.y);
      a.splatWall = false;
    }
    if (dmgToB > 0.5) {
      b.splatWall = splats(b, a);
      b.hitBy = a;
      damageBody(game, b, dmgToB, creditB, a.x, a.y);
      b.splatWall = false;
    }
    if (closing > 60 && (a.mass > 1e4 || b.mass > 1e4)) addShake(game, 3);

    // SPALL: a violent hit that BOTH bodies survive still crunches — small
    // rocks spray sideways out of the impact, chipped off the lighter body.
    if (eff > 40 && a.alive && b.alive && debrisRoom(game) > 0) {
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
  if (b.sinkT > 0) return;   // already under the cloud tops
  const dx = b.x - s.x, dy = b.y - s.y;
  let rr = s.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  // The ship lands on (and skims along) the real surface — a crystal world's
  // shard polygon, a cratered world's notched limb — not the mean disc. Same
  // radial narrow phase as collideBodies; you can fly down into a crater you
  // punched, which is the whole point of cutting it out of the silhouette.
  if (shaped(b)) {
    const bound = s.radius + surfReach(b);
    if (d2 > bound * bound) return;
    rr = s.radius + surfRadius(b, Math.atan2(dy, dx) + Math.PI);
  }
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

  // Push the ship out (bodies barely notice the ship). Uses the narrow phase's
  // `rr`, NOT the raw radii: on a shaped surface those differ by the whole
  // depth of the feature, and recomputing from b.radius here meant flying into
  // a crater snapped you back out to the world's nominal circle in one step —
  // a teleport to a border that is not where the surface is. (The same bug sat
  // in the crystal path from the day shard colliders landed: the ship was
  // ejected to the mean disc rather than to the facet it actually touched.)
  const overlap = rr - d;
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
      // same grind, same hull cost, triple the payout. DESERT WORLDS' dune
      // seas pay double, same law (bonus XP, hull cost never discounted).
      const banded = b.type === 'moon' && b.moonType === 'banded';
      const dune = b.type === 'planet' && b.ptype === 'desert';
      addXp(game, grind * PROG.XP_SKIM * (banded ? PROG.XP_SKIM_BANDED : dune ? PROG.XP_SKIM_DUNE : 1));
      if (banded && !game.tut.banded) game.bandedWarn = true;
      if (dune && !game.tut.dune) game.duneWarn = true;

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
    // The saturation KNEE normally grows with tier, so a dreadnought shrugs off
    // the pebbles that used to sting a scout. That rule is right for stray belt
    // gravel and WRONG for a rock storm: it made the shoals get SAFER the
    // stronger you got (a median field rock at 300 closing: 31% of hull at tier
    // 0, 7% at tier 3, 4% at tier 5 — the tier you actually farm them at, which
    // is why they read as harmless no matter how high FIELD_SHIP_DMG went).
    // Field rock therefore keeps the BASE knee at every tier: the same absolute
    // bite from tier 0 to 5, so a bigger hull endures more of a shoal without
    // ever becoming immune to one. A big ship in a dense field is a big target.
    const knee = 1500 * (b.fieldRock ? 1 : 1 + game.st.tier * 1.2);
    const massSat = b.mass / (b.mass + knee);
    // SHOAL ROCK BITES (CFG.FIELD_SHIP_DMG) — the exact mirror of FIELD_TOUGH:
    // field rock is tough against ITS OWN KIND and dangerous to YOU. This is
    // what makes a dense field high-risk/high-reward instead of just high-
    // reward. It costs nothing to fly through one: the pocket is RIGID (one
    // shared rail w, zero relative drift), so ambient closing speeds are ~0 and
    // the `closing > 25` gate below means gentle contact still cannot hurt. The
    // danger is entirely SELF-INFLICTED — once you start smashing, the space
    // around you fills with fast loose rock, and a Shockwave detonation is now
    // a genuine double-edged sword rather than free area denial.
    // NOT applied to an alien-thrown rock, which already carries its own
    // `thrown` multiplier and its own tuning (LURKER_SHOVE speed + mass). The
    // two stacked put a single lurker body-check on the 45% per-hit cap at
    // EVERY tier — a two-shot kill from an ambush you may not have seen, with
    // three of them hunting. Keeping them separate is also what lets the shoal
    // and its predator be tuned independently instead of through each other.
    const field = b.fieldRock && !(b.thrownBy === 'alien' && b.thrownTimer > 0)
      ? CFG.FIELD_SHIP_DMG : 1;
    // RAM PROW / JUGGERNAUT: a reinforced prow takes less from impacts (ramArmor
    // <= 1; exactly 1 for non-ram builds, so nothing else changes).
    const dmg = Math.min(CFG.DMG_SHIP * closing * massSat * thrown * field * game.st.ramArmor,
      game.st.maxHull * 0.45);
    if (dmg > 1.5 && closing > 25) {
      // ACHIEVEMENTS: was this YOUR shot coming back to meet you? Read before
      // the damage lands, checked after, because that's the only moment both
      // facts are true at once.
      const own = b.thrownBy === 'player' && b.thrownTimer > 0;
      damageShip(game, dmg, b.type === 'rogue' ? 'Flattened by a rogue planet.' :
        thrown > 1 ? 'Hit by an alien-thrown rock.' :
        `Collided with ${b.type === 'asteroid' ? 'an' : 'a'} ${b.type}.`, hitAng);
      if (own && !s.alive) bump(game, 'ownGoal');
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
      bump(game, 'parries');
      best(game, 'parryBest', game.parry.rocks.length);
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
      b.slung = true;                              // ...so it gets the long debris leash too
      b.chainN = 0;                                // ...and link 0 of a fresh chain (chainOk)
      b.throwX = b.x; b.throwY = b.y;              // achievements: launch point (see tractor.releaseHeld)
      b.killedByParry = true;                      // ...and the verb that set the kill up
      // Good play pays — per rock, at the launch. Damped in a shoal
      // (fieldXp): the parry catches any loose rock closing on the nose, and
      // inside a pocket you can fly into a full window's worth on purpose.
      addXp(game, fieldXp(game, b, PROG.XP_PARRY));
      addParticles(game, b.x, b.y, b.vx * 0.3, b.vy * 0.3, 12, '#9fd6ff', 200, 0.7, 3);
    }
    game.parry = null;
    game.parryCd = 2.5;                          // fixed — ranks buy field/slots/window/power, not uptime
    addShake(game, 4 + 2 * p.rocks.length);
    sfx.sfxFling();
  }
}

function collideAlienBody(game, al, b) {
  // Grabbers never collide with the rock they're fetching. A LURKER is the
  // opposite case: its target is the rock it intends to BODY-CHECK, so this
  // early-out silently cancelled the entire mechanic (measured: 1 shove a
  // minute, all of them incidental hits on other rocks).
  if (b === al.target && al.kind !== 'lurker') return;
  if (b.sinkT > 0) return;   // already under the cloud tops
  const dx = b.x - al.x, dy = b.y - al.y;
  let rr = al.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (shaped(b)) {   // aliens bounce off the real surface too, craters included
    const bound = al.radius + surfReach(b);
    if (d2 > bound * bound) return;
    rr = al.radius + surfRadius(b, Math.atan2(dy, dx) + Math.PI);
  }
  if (d2 > rr * rr) return;
  const d = Math.sqrt(d2) || 0.001;

  if (b.type === 'star') { killAlien(game, al); return; }

  // SHOAL LURKER BODY-CHECK. The lurker is the dense field's native predator
  // and fights like a brawler ramming: ambient rock contact does it NO harm
  // (a creature that died to its own habitat could never survive to reach
  // you — before this it suicided on the nearest rock within seconds of
  // spawning), and instead of bouncing it SHOVES the rock along its charge
  // heading, turning the field's own ammo into a projectile. The rock is
  // marked alien-thrown, so it plugs straight into every existing counter:
  // the orbit shield blocks it for XP, the Deflector can parry it, Dead Stop
  // primes on catching it. A PLAYER-thrown rock is excluded here and falls
  // through to the damage path below — throwing rocks back is how you kill it.
  if (al.kind === 'lurker' && b.type === 'asteroid' && !b.heldBy &&
      !(b.thrownTimer > 0 && b.thrownBy === 'player')) {
    const nx0 = dx / d, ny0 = dy / d;
    const overlap0 = rr - d;   // the narrow phase's reach, never the raw radii
    al.x -= nx0 * overlap0; al.y -= ny0 * overlap0;
    const sh = game.ship;
    // ONLY a committed charge throws. At shoal density (~88u between rocks)
    // a lurker brushes rocks constantly just manoeuvring, and letting those
    // brushes shove meant every cooldown was burnt on a random rock flung a
    // random way — the aimed shot never got to happen (measured: 3 shoves a
    // minute, none landing within 1300u of the ship). Incidental contact now
    // just separates, free of charge.
    if (al.state === 'charge' && !(al.shovedT > 0) && sh.alive &&
        b.mass <= CFG.LURKER_SHOVE_MASS && Math.hypot(al.vx, al.vy) > 60) {
      // Heavier rock, lazier shove — this is muscle, not a tractor beam. The
      // knee sits at pickShoveRock's own 2000-mass ceiling so the heaviest
      // rock it will even consider still leaves at a threatening clip (at a
      // 1400 knee the top of that range crawled out at 0.7x and read as a
      // shove that had failed).
      // The knee tracks LURKER_SHOVE_MASS (the ceiling pickShoveRock will even
      // consider) so the HEAVIEST rock it can pick still leaves at ~0.9x — the
      // reason main tuned it to 1800 against a 2000 ceiling. With the ceiling
      // raised to 3400 a fixed 1800 would have sent the top of the range out at
      // 0.53x, i.e. exactly the "shove that visibly failed" that knee exists to
      // prevent — so it is DERIVED now and can't drift out of sync again.
      const push = CFG.LURKER_SHOVE
        * Math.min(1, (CFG.LURKER_SHOVE_MASS * 0.9) / Math.max(300, b.mass));
      // AIMED, with the grabber's lead solve. The velocity is set outright
      // rather than added to the lurker's: the whole pocket is carried by
      // orbital motion, and inheriting that carry threw every shot wide of
      // the lead it just solved for.
      const speed = push + Math.hypot(al.vx, al.vy) * 0.25;
      // Two-pass lead solve: the first pass' flight time is wrong by however
      // far the ship travels during it, so feed it back once. Cheap, and the
      // difference is the whole shot at these speeds.
      let t = Math.hypot(sh.x - b.x, sh.y - b.y) / speed;
      t = Math.hypot(sh.x + sh.vx * t - b.x, sh.y + sh.vy * t - b.y) / speed;
      const ang = Math.atan2(sh.y + sh.vy * t - b.y, sh.x + sh.vx * t - b.x);
      derail(b);
      b.vx = Math.cos(ang) * speed;
      b.vy = Math.sin(ang) * speed;
      b.thrownBy = 'alien'; b.thrownTimer = 5;
      b.guideT = CFG.LURKER_GUIDE_T;   // helped along — see the guidance pass in step()
      al.vx *= 0.5; al.vy *= 0.5;          // the body-check costs it its charge
      al.shovedT = CFG.LURKER_SHOVE_CD;
      addParticles(game, b.x, b.y, 0, 0, 8, '#c9b9a2', 120, 0.5);
      sfx.sfxBump(0.55 * sfx.distVol(game, b.x, b.y));
    }
    return;
  }

  const nx = dx / d, ny = dy / d;
  const closing = -((b.vx - al.vx) * nx + (b.vy - al.vy) * ny);
  const overlap = rr - d;   // shaped surfaces: eject to the surface, not the disc
  al.x -= nx * overlap; al.y -= ny * overlap;
  if (closing > 0) {
    const mEffA = Math.min(b.mass, 4e5);
    const kickA = Math.min(380, closing * 1.2 * (mEffA / (mEffA + 500)));
    al.vx -= nx * kickA; al.vy -= ny * kickA;
    const playerRock = b.thrownTimer > 0 && b.thrownBy === 'player';
    const bonus = playerRock ? 2.5 : 1;
    const effA = Math.max(0, closing - 60);   // aliens are squishier than planets
    let dmg = CFG.DMG_BODY * effA * effA * b.mass * bonus * 2;
    // LURKERS TAKE A MINIMUM NUMBER OF HITS. Rock damage is QUADRATIC in
    // closing speed and linear in mass, so it spans three orders of magnitude
    // (a 200-mass lob at 400 does 139; a 1400-mass rock at 1000 does 7422) and
    // NO hp value is tunable across that range — every one is either one-shot
    // by a real throw or immortal to a weak one. Raising LURKER_HP 34 -> 90
    // alone changed literally nothing: both were one-shot by all nine sample
    // throws. So the per-hit damage is capped at a fraction of max hp, the same
    // idiom invariant 3 uses to stop comparable rocks one-shotting each other.
    // The predator now has to be FOUGHT rather than deleted in passing, which
    // is what lets it live long enough to line up the rocks that are the actual
    // threat. Lurkers only — grabbers and golems keep their existing feel.
    if (al.kind === 'lurker') dmg = Math.min(dmg, CFG.LURKER_HIT_CAP * CFG.LURKER_HP);
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
const _byLeftEdge = (a, b) => (a.x - a._bp) - (b.x - b._bp);   // _bp = broad-phase radius (set each substep)
let nanWarned = false;   // the NaN tripwire below warns once per session

// ---------- dense-field LOD ----------
// THE FIELD LOD is what makes ~8000 field rocks affordable: full physics is a
// LOCAL privilege. Once per FRAME (main.update and driftSplash call this —
// never per substep) every field rock is classified:
//   AWAKE — its field is the one the ship is actually at (f.active) AND the
//     rock is inside the wake bubble around the view. Full physics.
//   DORMANT — everything else: the far side of your own field, and the
//     fields you are not in. Dormant rocks are skipped by the collision
//     sweep, both gravity phases, the per-substep rails pass, the ship/alien
//     collision loops and the NaN tripwire. Railed dormants are advanced
//     HERE, once per frame with exact trig — the pocket is RIGID (shared w),
//     so the group travels as one and the minimap stays truthful; LOOSE
//     dormants freeze mid-drift where they are (they are off-view by
//     definition — nobody sees the pause, and they resume on wake).
// Held, thrown, and parry-frozen rocks are ALWAYS awake: a player throw must
// not freeze mid-flight because it crossed the bubble. Waking is seamless:
// dormant advancement drives the SAME rail state the substep path reads, and
// rl.rdt = 0 invalidates the incremental rotor so the first awake substep
// resyncs from rail.ang instead of a stale cached heading.
// It ALSO builds THE AWAKE LIST (game.bodies._awake): every alive, awake
// body, gathered in this same single pass. step()'s hot loops iterate that
// list instead of the full array — before it existed they walked all ~8000
// bodies 10-15 times per frame just to `continue` past dormants (measured:
// ~1.4ms/frame, ~40% of sim time, spent skipping bodies we had already
// decided not to simulate). The list lives ON the bodies array so
// world.generateWorld's `bodies.length = 0` can invalidate it in the same
// breath (`bodies._awake = null`) — a stale list holding the DEAD world's
// bodies would be catastrophic. Failure mode is deliberately soft: a body
// created after the list was built (spall, shards, pellets) is simply not
// simulated until the next frame's rebuild — one frame of stasis for a
// fresh fragment, invisible; spawnAsteroid registers its spawns eagerly
// anyway, covering nearly every runtime creation site.
// ---------------------------------------------------------------------------
// THE FRAME REGISTRIES (game.reg)
//
// The awake list fixed the per-SUBSTEP loops, but a second family of scans
// survived it: "find the bodies of kind X", asked over and over against the
// full array. Each was written when the world held a few hundred bodies and
// each is now a walk of ~8000 (physics' iron-moon and terran shortlists run
// PER SUBSTEP; ai's avoidStars walked every body to find the one star, once
// per alien per frame; world's local/asteroid census ran two full reduces;
// render asked half a dozen more). Measured: with the ship parked in open
// space — an identical 381 awake bodies either way — doubling the world's
// total body count still cost 1.7x the frame. That gap was this: work
// proportional to bodies we had already decided not to simulate.
//
// So the ONE full-array walk the frame already pays for (the LOD pass below)
// now also classifies as it goes, and every scan reads the answer instead.
//
// THREE RULES, and each is load-bearing:
//   1. A registry is a per-frame SNAPSHOT, so every consumer must still check
//      b.alive — entries can die mid-frame (a shatter, a cull) and the list
//      will not know until the next rebuild.
//   2. It holds REFERENCES, so world.generateWorld must drop it in the same
//      breath as the awake list (`game.reg = null`) — a stale registry holding
//      the DEAD world's planets would have render drawing ghost worlds and
//      gravity answering to suns that no longer exist.
//   3. It may be one frame STALE for newcomers. A body spawned after the walk
//      is simply not in it until the next rebuild — the same soft failure the
//      awake list already has, and for the same reason: one frame of a fresh
//      fragment being uncounted is invisible, while a hard guarantee would
//      mean touching every creation site in the codebase.
// frameReg() covers the cold start (first frame after a regen, before the LOD
// has run) with a one-off walk, so no consumer needs its own fallback path.
// ---------------------------------------------------------------------------
function newReg() {
  return {
    stars: [], planets: [], terrans: [], ironMoons: [], stations: [], locals: [],
    forts: [],
    // EVERY body that is not shoal rock (~380 of ~15,600 at doubled scale).
    // The renderer's landmark passes — approach plates, the planet colour
    // wash, the minimap blip layer — all want exactly this set: field rock is
    // terrain, drawn by the cached dot layer, and every one of those passes
    // was rejecting all ~15,000 rocks one at a time to reach the 380 it
    // wanted. Not the same thing as the awake list, which is bounded by the
    // wake bubble: radar reach is far wider than that, and a landmark must
    // blip whether or not it is near enough to simulate.
    nonField: [],
    // Bodies that hide the ship from alien senses: dust moons and shroud
    // worlds both feed the one game.dustCloak flag (ai.js), so they share one
    // list — the gate does not care which kind concealed you.
    cloakers: [],
    // Bodies with something DECAYING on them (cooling magma, an expiring
    // ambient comet) — world.replenishWorld ticked those two fields over
    // every body in the world, every frame, for the handful that ever carry
    // them. A registry keeps that exact behaviour (no LOD trade: dormant
    // members are still ticked) at the cost of the walk we already do.
    decay: [],
    // The rubble a wounded world has calved (physics.calveCrust). Handful of
    // bodies in a quiet run, a few hundred in a long bombardment — a registry
    // keeps updateCrust's per-substep pass off the full array either way.
    crust: [],
    asteroids: 0, moons: 0,
  };
}

// Classify one live body into the registries. Kept as a plain switch on type
// so the LOD's hot walk pays one jump per body, not a chain of predicates.
function regPush(reg, b) {
  switch (b.type) {
    case 'star': reg.stars.push(b); break;
    case 'planet':
      reg.planets.push(b);
      if (b.ptype === 'terran') reg.terrans.push(b);
      else if (b.ptype === 'shroud') reg.cloakers.push(b);
      break;
    case 'moon':
      reg.moons++;
      if (b.moonType === 'iron') reg.ironMoons.push(b);
      else if (b.moonType === 'dust') reg.cloakers.push(b);
      break;
    case 'station': reg.stations.push(b); break;
    case 'asteroid': reg.asteroids++; break;
  }
  if (b.field == null) reg.nonField.push(b);
  if (b.fort) reg.forts.push(b);
  if (b.local) reg.locals.push(b);
  if (b.magma > 0 || b.comet) reg.decay.push(b);
  if (b.crust) reg.crust.push(b);
}

// The registries, built on demand if the LOD has not run yet this world (the
// first frame after generateWorld, where render and replenishWorld can both
// reach the game before the substep loop has). Costs one walk, once.
export function frameReg(game) {
  let reg = game.reg;
  if (!reg) {
    reg = game.reg = newReg();
    for (const b of game.bodies) if (b.alive) regPush(reg, b);
  }
  return reg;
}

export function updateFieldLOD(game, dt) {
  const bodies = game.bodies;
  const awake = bodies._awake || (bodies._awake = []);
  awake.length = 0;
  const reg = game.reg || (game.reg = newReg());
  reg.stars.length = 0; reg.planets.length = 0; reg.terrans.length = 0;
  reg.ironMoons.length = 0; reg.stations.length = 0; reg.locals.length = 0;
  reg.decay.length = 0; reg.forts.length = 0; reg.cloakers.length = 0;
  reg.nonField.length = 0; reg.crust.length = 0;
  reg.asteroids = 0; reg.moons = 0;
  const flds = game.fields;
  const s = game.ship;
  const cx = s.alive ? s.x : game.cam.x;
  const cy = s.alive ? s.y : game.cam.y;
  const wakeR = (game.viewR || 1200) * 2.2 + 600;
  const wakeR2 = wakeR * wakeR;
  if (flds) {
    for (const f of flds) {
      // Reach must cover the pocket's LONGEST lobe (config.FIELD_LOBE_MAX)
      // plus the fringe stragglers, or the far bulge of a field you are
      // standing in stays dormant while it is inside the wake bubble.
      f.active = Math.hypot(f.x - cx, f.y - cy) < CFG.FIELD_LEN * (FIELD_LOBE_MAX * 1.35) + wakeR;
    }
  }
  for (const b of bodies) {
    if (!b.alive) continue;
    regPush(reg, b);   // the frame registries ride this same walk (see above)
    // NEAR-SHIP flag for the WORLD-DETAIL work — the cratered-surface narrow
    // phase and the crust halo assist. Both are per-contact/per-substep costs
    // that exist purely so the player can see and feel a wound, and a world
    // three lanes away has no audience: the same "the chaos you see is always
    // the chaos near you" trade the field LOD is built on. Measured to the
    // SURFACE, not the centre, so a 1,148-unit giant counts as near when you
    // are near its limb rather than only near its core. Off-view a cratered
    // world simply collides as the circle it used to be — nothing can observe
    // the difference, and it costs a bearing solve per contact to maintain.
    if (b.type === 'planet' || b.type === 'moon' || b.type === 'rogue') {
      b.nearShip = Math.hypot(b.x - cx, b.y - cy) - b.radius < wakeR;
    }
    let dormant;
    if (b.heldBy || b.thrownTimer > 0 || b.parryFrozen) {
      dormant = false;
    } else if (b.field == null || !flds) {
      // A PLANET SYSTEM FREEZES WHEN THE PLAYER LEAVES IT. Non-field bodies
      // used to be awake unconditionally, which was fine when there were ~380
      // of them; the debris belts and the crumble layer put ~800 in the sky,
      // and every one was paying the full per-substep bill — the collision
      // sweep, both gravity phases, the rails pass — from the far side of the
      // system. The rubble that MAKES a planet system (its belt, its junk
      // probes, its ring chunks, the trojans) is inert railed scenery, so out
      // past the wake bubble it group-advances once a FRAME on its rail and
      // sleeps otherwise, exactly as a dormant shoal does. It wakes as you
      // approach, on the same bubble, with the same seamless hand-off.
      // Excluded, and each for a reason: ATTRACTORS (gravity has to stay exact
      // — this is why planets, moons and the star are never dormant),
      // ELLIPTICAL rails (the group advance below is the circular path only —
      // a Kepler rail read as a circle is NaN on its first step), and
      // INSTALLATIONS, which station-keep under thrust and must never wander.
      dormant = b.onRails && !b.attractor && !(b.rail.e > 0)
        && b.type !== 'station' && b.type !== 'nest' && !b.fort && !b.tinker && !b.shepherd
        && (b.x - cx) ** 2 + (b.y - cy) ** 2 > wakeR2;
    } else {
      const f = flds[b.field];
      if (f && !f.active) dormant = true;
      else {
        const dx = b.x - cx, dy = b.y - cy;
        dormant = dx * dx + dy * dy > wakeR2;
      }
    }
    b.dormant = dormant;
    if (!dormant) { awake.push(b); continue; }
    if (b.onRails) {
      const rl = b.rail;
      const p = rl.parent;
      if (!p.alive) { derail(b); b.dormant = false; awake.push(b); continue; }
      rl.ang += rl.w * dt;
      const c = Math.cos(rl.ang), sn = Math.sin(rl.ang);
      b.x = p.x + c * rl.r;
      b.y = p.y + sn * rl.r;
      b.vx = p.vx - sn * rl.w * rl.r;   // truthful velocity: grabs/minimap/wake read it
      b.vy = p.vy + c * rl.w * rl.r;
      rl.rdt = 0;   // invalidate the substep rotor — wake resyncs from rail.ang
    }
  }
}

export function step(game, dt) {
  const bodies = game.bodies;
  // THE AWAKE LIST (built once per frame by updateFieldLOD): every per-substep
  // loop below iterates `live`, not the full array — at ~8000 bodies with
  // ~6900 dormant, walking the array 10-15 times per frame just to skip them
  // measured ~1.4ms (~40% of sim). Null until the first LOD build after a
  // world regen, so the fallback is the plain array — correctness never
  // depends on the list existing, only speed does. Loops keep their alive/
  // dormant guards: entries can die mid-frame, and the fallback path needs them.
  const live = bodies._awake || bodies;
  // Frame registries (see updateFieldLOD): the "find every body of kind X"
  // shortlists this function used to rebuild from scratch on every substep.
  const reg = frameReg(game);
  const attractors = _attractors;
  attractors.length = 0;
  let aliveCount = 0;   // AWAKE count — the sweep-list staleness check below compares
                        // against sweep membership, and dormant bodies are not members
  for (const b of live) {
    if (!b.alive || b.dormant) continue;
    aliveCount++;
    // Broad-phase radius: crystal planets' spikes reach past the disc, and
    // the sweep must see the TALLEST feature or spike hits get pruned before
    // the narrow phase ever runs. Everything else: _bp IS the radius.
    b._bp = b.ptype === 'crystal' ? b.radius * CRYSTAL_REACH : b.radius;
    if (!b.attractor) continue;
    // Influence-cutoff ranges for this substep (see GRAV_CULL_A above). Stars
    // are never culled — the sun is the structural anchor of every orbit.
    if (b.type === 'star') { b.cullR2 = Infinity; b.cullShip2 = Infinity; }
    else { b.cullR2 = b.mass * GRAV_CULL_K; b.cullShip2 = b.mass * SHIP_CULL_K; }
    attractors.push(b);
  }

  // Rails maintenance: heavy wanderers (rogues, thrown giants) wake nearby
  // railed bodies into live physics; long-quiet live bodies snap back onto
  // rails when their orbit is near-circular again.
  game.railScanT = (game.railScanT ?? 0) - dt;
  if (game.railScanT <= 0) {
    game.railScanT = CFG.RAIL_RETRY;
    const disturbers = [];
    for (const b of live) {   // thrown giants are always awake (LOD exemption)
      if (!b.alive) continue;
      if (b.type === 'rogue' || (b.thrownTimer > 0 && b.mass > 5e4)) disturbers.push(b);
    }
    // live list: dormant railed rocks can't be disturbed (their disturbers
    // would be awake near the ship anyway) and frozen dormant strays simply
    // wait for wake before they can re-rail — both are the LOD's documented
    // "the chaos near you" trade.
    for (const b of live) {
      if (!b.alive) continue;
      if (b.onRails) {
        // PLANETS never derail from mere proximity — only a real impact can
        // knock a world off its rail. The proximity derail is what opened
        // the rogue-capture window: a railed planet ignores gravity, but
        // once knocked live beside a rogue 7-13x its mass it gets BOUND as
        // the rogue's satellite and dragged wherever the rogue falls — in
        // soaks the outer-band worlds (~50 u/s lanes, right where rogues
        // apogee at their slowest) were captured and carried into the sun
        // within minutes, and each one derailed every lane it crossed on
        // the way down (a three-planet cascade). Moons/asteroids/stations
        // keep the full disturb drama: they're replenished; planets are
        // permanent, and "rogues stir up but can't shred" is the design law.
        if (b.type !== 'planet') {
          for (const d of disturbers) {
            if (Math.hypot(d.x - b.x, d.y - b.y) < CFG.RAIL_DISTURB + d.radius) { derail(b); break; }
          }
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
        // PLANET RESCUE: a knocked-loose world re-rails by FIAT — off-view,
        // still near its home lane (±15%), but with NO circularity test and
        // NO disturber-clear wait. A live planet parked beside a heavier
        // rogue gets gravitationally BOUND (the pair orbits at ~200u and the
        // rogue drags the world wherever it falls — in soaks, into the sun,
        // derailing every lane crossed on the way). The bound orbit is never
        // near-circular and the rogue never clears, so the ordinary path
        // below can NEVER rescue it; the fiat snap is what breaks the bond.
        // Radial velocity is discarded (the rail is circular) — invisible
        // off-view, and worth the tiny energy fudge to keep the sky whole.
        // Same class of law as installation station-keeping: worlds are the
        // sky's anchor content, and they must never wander (far).
        if (b.type === 'planet') {
          // The fiat fires ONLY with a rogue adjacent — that is the capture
          // case it exists for. Gating on the captor also keeps it from
          // quietly ending a legitimate off-view player planet-throw (a
          // thrown world starts inside its own ±15% band), and lets a
          // rogue-free loose planet fall through to the ordinary
          // near-circular path below instead of being stranded railless
          // forever when it drifts out of the band.
          let captor = false;
          for (const d of disturbers) {
            if (d.type === 'rogue' &&
                Math.hypot(d.x - b.x, d.y - b.y) < CFG.RAIL_DISTURB * 1.5 + d.radius) { captor = true; break; }
          }
          if (captor) {
            const dx = b.x - parent.x, dy = b.y - parent.y;
            const r = Math.hypot(dx, dy);
            const home = b.homeR || r;
            if (r > parent.radius + b.radius + 60 && Math.abs(r - home) < home * 0.15) {
              const vC = Math.sqrt((CFG.G * parent.mass * r * r) / Math.pow(r * r + CFG.GRAV_SOFT ** 2, 1.5));
              const rvx = b.vx - parent.vx, rvy = b.vy - parent.vy;
              const dir = Math.sign((dx * rvy - dy * rvx) / r) || 1;
              b.vx = parent.vx - (dy / r) * dir * vC;
              b.vy = parent.vy + (dx / r) * dir * vC;
              railBody(b, parent);
              b.homeR = home;   // rescue cycles must not random-walk the lane
            }
            // Rogue adjacent either way: the ordinary path below could never
            // fire (its disturber-clear check fails), so stop here.
            continue;
          }
        }
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
              // DENSE-FIELD rocks rejoin the RIGID pocket, not the jittered
              // flow: railBody just re-applied the id-hashed ±4% w, and a
              // mis-w rock inside an ~85u-spacing pocket shears and grinds
              // (the exact failure the shared field w exists to prevent).
              // Also covers the field HEART, whose rail.ang is the AI anchor.
              const ff = b.field != null && game.fields && game.fields[b.field];
              if (ff && parent === game.homeStar) b.rail.w = ff.w;
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
  for (const b of live) {
    if (!b.alive || b.type === 'star' || b.onRails || b.dormant) continue;
    // majorComet (Vesper) rides the weighted path as an honorary celestial:
    // under full planet gravity, gravitational focusing funneled it into a
    // planet impact or a sun plunge every ~15 minutes. CROSS_GRAV keeps its
    // long ellipse stable the same way it keeps every other orbit stable.
    // FIELD ROCK feels NO gravity at all (CFG.FIELD_* — its own material).
    // Knocked out of the shoal it drifts and caroms in a straight line
    // instead of falling into an orbit, which is what makes a pocket play
    // like a pinball table; it also keeps a thousand-rock sky free in the
    // hottest loop in the game. The heart is a normal body and is excluded.
    // A body-checked rock is HELPED for a moment (CFG.LURKER_GUIDE_*): it
    // keeps steering toward the ship's lead point just after the hit, so a
    // lurker's shot reads as aimed instead of being walked off target by the
    // pocket's own drift. Strictly time-boxed and gentle — it corrects a
    // near-miss into a threat, it does not chase you down.
    if (b.guideT > 0) {
      b.guideT -= dt;
      // NB: game.ship, not the `s` binding — that const is declared further
      // down in step() and is in its temporal dead zone up here.
      const sg = game.ship;
      if (sg.alive && b.thrownBy === 'alien') {
        const sp2 = Math.hypot(b.vx, b.vy) || 1;
        let t2 = Math.hypot(sg.x - b.x, sg.y - b.y) / sp2;
        t2 = Math.hypot(sg.x + sg.vx * t2 - b.x, sg.y + sg.vy * t2 - b.y) / sp2;
        const ax2 = sg.x + sg.vx * t2 - b.x, ay2 = sg.y + sg.vy * t2 - b.y;
        const ad2 = Math.hypot(ax2, ay2) || 1;
        // steer the VELOCITY toward the lead bearing, never add speed
        const dvx = (ax2 / ad2) * sp2 - b.vx, dvy = (ay2 / ad2) * sp2 - b.vy;
        const dm = Math.hypot(dvx, dvy) || 1;
        const k = Math.min(1, CFG.LURKER_GUIDE_A * dt / dm);
        b.vx += dvx * k; b.vy += dvy * k;
      }
    }
    if (b.fieldRock) {
      b.ax = b.extAx; b.ay = b.extAy;
      // Gravity-free, but NOT exempt from the world edge: without gravity a
      // knocked rock leaves in a straight line forever, and the map edge is
      // the one thing that still has to turn it back (noBoundary remains the
      // interstellar visitor's alone).
      const bnd0 = boundaryAccel(b.x, b.y);
      if (bnd0) { b.ax += bnd0.ax; b.ay += bnd0.ay; }
      continue;
    }
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
    // SOLAR WAVE: the engines choke on the plasma while you are caught out in
    // the sheath. main.js owns the exposure test (game.stormExposed) exactly
    // the way it owns the afterburner tank via game.burnerOn — physics never
    // re-derives either, or the flag and what it drives quietly disagree.
    // Keyed to EXPOSURE, not the ion afterglow: reaching a world's lee gives
    // the engines straight back, which is how the counterplay teaches itself.
    if (game.stormExposed) th *= CFG.STORM_THRUST;
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
      // Awake list: anything close enough and fast enough to be worth dodging
      // is inside the wake bubble by construction, so the dormants this used
      // to walk could never have passed the 1100u box test anyway.
      for (const b of live) {
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

    // THE SOLAR WAVE cooks whatever it catches in the open (CFG.STORM_*).
    // Exposure is main.js's call — it is inside the sheath AND has no world
    // between it and the sun. DIRECTIONLESS damage (no hitAng), like the heat
    // and the crush below: there is no facing that dodges a wave, so a partial
    // shield soaks only its coverage share (see damageShip). Sheltering behind
    // a world stops it dead — that is the entire counterplay.
    if (game.stormExposed && s.invuln <= 0) {
      damageShip(game, CFG.STORM_DPS * dt, 'Cooked by a solar wave.');
      // Hull sparks off the sunward side, like the corona's — the plasma is
      // stripping the plating and you can see which way it is coming from.
      if (Math.random() < dt * 26) {
        const rr = Math.hypot(s.x, s.y) || 1;
        addParticles(game,
          s.x + (Math.random() - 0.5) * s.radius * 2.2,
          s.y + (Math.random() - 0.5) * s.radius * 2.2,
          (s.x / rr) * 320, (s.y / rr) * 320,
          1, Math.random() < 0.5 ? '#bfe0ff' : '#ffd9a0', 120, 0.4, 2.2);
      }
      // A low rumble, not a jolt: this is a per-SUBSTEP add against update()'s
      // exp(-7) decay, so it settles around ~1px — the wave buffets, the
      // impacts are what slam.
      addShake(game, 0.06);
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
  // Registry, not a scan: this shortlist used to walk every body in the world
  // once per SUBSTEP (2-3x a frame) to find a handful of moons that change
  // only when one dies. See the frame-registry note above updateFieldLOD.
  const ironMoons = reg.ironMoons.length ? reg.ironMoons : null;
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
        // Radiation-pressure shove through the whole plasma SHEATH, hardest
        // at the shock and fading back through the tail. Scrap ONLY —
        // pushing bodies or celestials is how invariants die.
        const hx = d.x - game.homeStar.x, hy = d.y - game.homeStar.y;
        const hr = Math.hypot(hx, hy) || 1;
        const lead = storm.r - hr;   // >0 once the shock has swept past this chunk
        if (lead > -CFG.STORM_BAND && lead < CFG.STORM_TAIL) {
          const k = lead < 0 ? 1 : 1 - lead / CFG.STORM_TAIL;
          d.ax += (hx / hr) * CFG.STORM_SHOVE * k;
          d.ay += (hy / hr) * CFG.STORM_SHOVE * k;
          // …and the wave leaves it IONIZED: it glows, and it pays
          // ION_SCRAP_MUL more when collected. Never field-sourced scrap —
          // that chunk's XP was already charged against the pocket's budget
          // at drop time and must not be re-inflated here (see config).
          if (!d.field) d.ion = 1;
        }
      }
    }
  }

  // THE CRUMBLE: ease freshly calved crust onto its world's halo. Between the
  // two phases on purpose — it reads the accelerations Phase 1 just wrote as
  // already applied to nothing, and adjusts VELOCITY, so Phase 2 integrates
  // the settled value in the same substep.
  updateCrust(game, dt);
  updateGasVents(game, dt);
  updateGasStrip(game, dt);

  // Phase 2: integrate live bodies (semi-implicit Euler)
  for (const b of live) {
    if (!b.alive || b.type === 'star' || b.dormant) continue;
    b.rot += b.spin * dt;
    if (b.thrownTimer > 0) b.thrownTimer -= dt; else b.thrownBy = null;
    if (b.inertT > 0) b.inertT -= dt;       // fresh fragment, flying clear of its siblings
    // SHRINK, EASED. damageBody sets a radius TARGET; the body walks to it over
    // about a second and a half instead of snapping. Everything downstream reads
    // b.radius, so the collider, the silhouette and the crater profile all
    // shrink together and never disagree mid-animation.
    if (b.radiusT !== undefined && b.radius !== b.radiusT) {
      b.radius += (b.radiusT - b.radius) * (1 - Math.exp(-2.2 * dt));
      if (Math.abs(b.radiusT - b.radius) < 0.05) b.radius = b.radiusT;
    }
    // GOING UNDER: a swallowed rock keeps ploughing into the clouds, dragging
    // to a halt as they close over it, then is gone. Render fades it out across
    // the same window, so it sinks rather than blinking out of existence.
    if (b.sinkT > 0) {
      b.sinkT -= dt;
      const drag = Math.exp(-3.4 * dt);
      b.vx *= drag; b.vy *= drag;
      if (b.sinkT <= 0) {
        b.alive = false;
        const gi = b.sinkIn;
        // Ejecta that rained back in do NOT erupt again — that is what keeps
        // the fountain from feeding itself forever.
        if (gi && !b.gasEjecta) {
          gasErupt(game, gi, Math.atan2(b.y - gi.y, b.x - gi.x),
            Math.min(1, 0.15 + b.mass / 11000));
        }
        continue;
      }
    }
    if (b.reentryT > 0) b.reentryT -= dt;   // atmosphere fire streak fades once clear
    if (b.onRails) continue;
    b.liveT += dt;
    b.vx += b.ax * dt; b.vy += b.ay * dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
  }

  // Rails pass: advance precomputed orbits analytically. Array order puts
  // planets before their moons, so a moon's (possibly live) parent has its
  // final position before the moon reads it.
  for (const b of live) {
    if (!b.alive || !b.onRails || b.dormant) continue;   // dormant rails advance in updateFieldLOD
    const rl = b.rail;
    const p = rl.parent;
    if (!p.alive) { derail(b); continue; }
    if (rl.e > 0) {
      // Elliptical rail: analytic Kepler advance (see entities.keplerStep)
      keplerStep(rl, dt);
      b.x = p.x + rl.px; b.y = p.y + rl.py;
      b.vx = p.vx + rl.vpx; b.vy = p.vy + rl.vpy;
    } else {
      // rl.ang stays the source of truth (predictPaths copies it; the orbit
      // guide arc draws from it) but position uses an INCREMENTAL ROTATION:
      // one rotor multiply per substep instead of cos+sin — with most of a
      // big world railed, this pass was a top trig bill. Float drift of the
      // unit vector is ~1e-14/step; the periodic resync from rl.ang makes it
      // unobservable on any timescale.
      rl.ang += rl.w * dt;
      if (rl.rdt !== dt) {   // first pass / dt change: build rotor + sync exact
        rl.rdt = dt;
        rl.dc = Math.cos(rl.w * dt); rl.ds = Math.sin(rl.w * dt);
        rl.c = Math.cos(rl.ang); rl.s = Math.sin(rl.ang);
        rl.sync = 600;
      } else {
        const c = rl.c * rl.dc - rl.s * rl.ds;
        rl.s = rl.s * rl.dc + rl.c * rl.ds;
        rl.c = c;
        if (--rl.sync <= 0) { rl.sync = 600; rl.c = Math.cos(rl.ang); rl.s = Math.sin(rl.ang); }
      }
      b.x = p.x + rl.c * rl.r;
      b.y = p.y + rl.s * rl.r;
      // Keep velocity truthful so collisions and grabs behave normally
      b.vx = p.vx - rl.s * rl.w * rl.r;
      b.vy = p.vy + rl.c * rl.w * rl.r;
    }
  }

  // NaN containment tripwire: a non-finite body is always an upstream bug,
  // but left alive ONE of them annihilates the whole system within a few
  // substeps — NaN comparisons defeat every broad-phase reject, so it "hits"
  // everything, and if it's an attractor it NaN-poisons every live body's
  // gravity. Contain the blast radius to the buggy body: cull it, warn once.
  for (const b of live) {
    if (b.dormant) continue;   // frozen or group-railed — it cannot go non-finite
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

  // Collisions: body-body via sweep-and-prune on x. The sweep list is
  // PERSISTENT across substeps: bodies barely move in 1/120s, so feeding
  // Timsort last substep's order makes the sort near-linear — rebuilding
  // from the master array every substep (grouped by creation, effectively
  // random in x) made the sort the single most expensive line in step() at
  // high body counts. Membership is tracked with b._sw: the compact pass
  // drops dead bodies, the append pass admits newcomers (spawns/spall), and
  // the cull pass at the bottom of step() clears _sw on anything it removes
  // from the world. A world REGEN reuses the same bodies array
  // (world.generateWorld does bodies.length = 0), which this can't see —
  // the aliveCount cross-check catches it exactly: stale entries make the
  // sweep strictly longer than the live population, forcing a hard rebuild.
  const sweep = _sweep;
  {
    let w = 0;
    for (const b of sweep) { if (b.alive && !b.dormant && b._sw) sweep[w++] = b; else b._sw = false; }
    sweep.length = w;
    for (const b of live) if (b.alive && !b.dormant && !b._sw) { b._sw = true; sweep.push(b); }
    if (sweep.length !== aliveCount) {   // stale ghosts (world regen) — hard reset
      for (const b of sweep) b._sw = false;
      sweep.length = 0;
      for (const b of live) if (b.alive && !b.dormant) { b._sw = true; sweep.push(b); }
    }
  }
  sweep.sort(_byLeftEdge);
  for (let i = 0; i < sweep.length; i++) {
    const a = sweep[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < sweep.length; j++) {
      const b = sweep[j];
      if (b.x - b._bp > a.x + a._bp) break;
      if (!b.alive) continue;
      if (Math.abs(a.y - b.y) > a._bp + b._bp) continue;
      collideBodies(game, a, b);
    }
  }

  // Ship & alien collisions with bodies (aliens are usually absent — skip
  // spinning up an iterator per body for an empty list at 120Hz)
  const aliens = game.aliens;
  for (const b of live) {
    if (!b.alive || b.dormant) continue;   // ship and hunters are inside the wake bubble by definition
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
        al.kind === 'golem' ? 'Crushed by a scrap-golem.'
          : al.kind === 'lurker' ? 'Shredded by a shoal lurker.'
            : 'Rammed by an alien grabber.',
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
        // A chunk the solar wave swept comes out IONIZED and pays more (never
        // field scrap — dropScrap's fromField flag keeps the pocket budget
        // honest, see config.ION_SCRAP_MUL).
        addXp(game, d.value * PROG.XP_SCRAP * (d.ion ? PROG.ION_SCRAP_MUL : 1));
        if (d.ion) bump(game, 'ionScrap');
        bump(game, 'scrap');
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
      for (const b of live) {   // dormant field rock is nowhere near the corona
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

  // TERRAN ATMOSPHERE: loose rocks entering a living world's air burn up —
  // the corona-heat shape (depth² x maxHp fraction), scoped to the shell
  // (CFG.ATMO_ZONE x radius). Only free-flying asteroids burn: railed bodies
  // are exempt (the world's own junk satellites live INSIDE the shell, and
  // damaging a railed body derails it — a cascade), and so are held rocks,
  // parry-frozen rocks, and premium/quest objects (core, cache, pod, carved,
  // visitor, wreck). Heavyweights (> ATMO_MAX_MASS) punch through: attacking
  // a terran world is a feat that takes a real rock. The ship never burns.
  // CRUST is exempt for the same reason railed junk is — it lives inside the
  // shell by construction. A world's own halo sits at 1.05-1.5 radii and the
  // atmosphere reaches 1.5, so without this a terran world burned away every
  // piece it calved within about a second of calving it, and the crumble
  // simply did not exist on the archetype most worth bombarding.
  {
    // Both halves were full-array walks per SUBSTEP, and the inner one is the
    // heavier by far: field rock is type 'asteroid', so every rock in every
    // shoal was tested for atmospheric entry 2-3 times a frame. The terran
    // list comes from the registry; the candidates come from the awake list,
    // which is the LOD's documented trade — a dormant rock is off-view by
    // construction, and burn-up is a thing you watch happen.
    const terrans = reg.terrans.length ? reg.terrans : null;
    if (terrans) {
      for (const b of live) {
        if (!b.alive || b.type !== 'asteroid' || b.onRails || b.heldBy || b.crust ||
            b.mass > CFG.ATMO_MAX_MASS || b.core || b.cache || b.pod ||
            b.carved || b.visitor || b.wreck || b.junk || b.parryFrozen) continue;
        for (const p of terrans) {
          const az = p.radius * CFG.ATMO_ZONE;
          const dx = b.x - p.x, dy = b.y - p.y;
          if (dx > az || dx < -az || dy > az || dy < -az) continue;
          const d = Math.hypot(dx, dy);
          if (d >= az) continue;
          const t = Math.min(1, (az - d) / (az - p.radius));
          // The fire trails opposite the motion THROUGH the air (planet-
          // relative) — render draws the streak while reentryT holds, scaled
          // by DEPTH (reentryK) so the burn fades in across the shell instead
          // of switching on at the exact 1.5r boundary (no hard edges in-world).
          b.reentryT = 0.22;
          b.reentryK = t;
          b.reentryAng = Math.atan2(b.vy - p.vy, b.vx - p.vx);
          damageBody(game, b, t * t * CFG.ATMO_DPS_FRAC * b.maxHp * dt);
          if (b.alive && Math.random() < dt * 8) {
            addParticles(game, b.x, b.y, b.vx * 0.25, b.vy * 0.25, 1, '#ffb35c', 70, 0.6, 2.5);
          }
          if (!b.alive) {
            // The burn-up itself is the counter (the atmoWarn flag is
            // tut-gated to one message, so it can't feed a "twenty of them" row)
            bump(game, 'atmoBurns');
            if (!game.tut.atmo && s.alive &&
                Math.hypot(b.x - s.x, b.y - s.y) < 3200) game.atmoWarn = true;
          }
          break;
        }
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

  // Cull dead / escaped bodies (in place, squared distance). THROTTLED to
  // every 4th substep: this is the one remaining full-array pass in step(),
  // and a dead body lingering in the array a few substeps is harmless —
  // every consumer checks b.alive, the sweep compacts its own list, and the
  // awake list holds references (never indices), so compaction can't
  // invalidate it.
  game._cullTick = (game._cullTick || 0) + 1;
  if ((game._cullTick & 3) === 0) {
    const cullR2 = (CFG.WORLD_R * 1.35) ** 2;
    let w = 0;
    for (const b of bodies) {
      if (b.alive && (b.type !== 'asteroid' || b.x * b.x + b.y * b.y < cullR2)) bodies[w++] = b;
      else b._sw = false;   // leaving the world (dead or escaped) → leave the sweep list too
    }
    bodies.length = w;
  }
  {
    const aliens = game.aliens;
    let w = 0;
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
  const dtP = CFG.PREDICT_DT;
  for (const b of (game.bodies._awake || game.bodies)) {   // attractors are never dormant
    if (b.alive && b.attractor) {
      const railed = b.onRails;
      const circ = railed && !(b.rail.e > 0);
      src.push(b);
      atr.push({
        x: b.x, y: b.y, vx: b.vx, vy: b.vy, mass: b.mass, radius: b.radius,
        star: b.type === 'star',
        weighted: b.type === 'planet' || b.type === 'moon' || b.type === 'rogue' || b.majorComet,
        // rubber-band eligible: real worlds only (majorComet is weighted for
        // gravity but the capture assist doesn't apply near a comet)
        rb: b.type === 'planet' || b.type === 'moon' || b.type === 'rogue',
        gas: b.ptype === 'gas',   // ship path enters these; hit = the core
        // crystal ghosts hit-test against the shard polygon at the CURRENT
        // rot (spin drift over the horizon is smaller than the marker dot)
        crystal: b.ptype === 'crystal', rot: b.rot,
        cjag: b.ptype === 'crystal' ? (b.cjag ||= crystalShards(b.id)) : null,
        // CRATERS: the forecast has to agree with the collider about where a
        // world's surface IS, or the ✕ lands on the rim of a crater the rock
        // will actually fly into. Carried by reference — scars are read-only
        // here, and the ghost keeps the same rot the crystal path does (spin
        // drift over the horizon is smaller than the marker dot).
        scars: (b.ptype !== 'crystal' && b.type !== 'asteroid' && b.scars.length) ? b.scars : null,
        // Influence cutoffs for the GHOST sums (same constants as gravityAt —
        // the forecast must not disagree with the sim about what matters):
        // cull2 for loose-body sums, cull2Ship (the wide one) for the ship path.
        cull2: b.type === 'star' ? Infinity : b.mass * GRAV_CULL_K,
        cull2Ship: b.type === 'star' ? Infinity : b.mass * SHIP_CULL_K,
        parentIdx: -1, anchorIdx: -1,
        // Railed attractors predict EXACTLY — advance the rail analytically.
        // Circular rails advance by INCREMENTAL ROTATION: one cos/sin pair
        // here at build, then a 4-mult complex rotate per step — the old
        // per-step cos/sin for every railed ghost was the single biggest
        // trig bill in the game (~25k calls per forecast). 200 steps of
        // drift is ~1e-13 rad — invisible on a dashed helper line.
        // Elliptical rails carry a COPY of their Kepler elements so advancing
        // the forecast's mean anomaly never mutates the live rail.
        railR: railed ? b.rail.r : 0,
        railParent: railed ? b.rail.parent : null,
        railC: circ ? Math.cos(b.rail.ang) : 0,
        railS: circ ? Math.sin(b.rail.ang) : 0,
        railDc: circ ? Math.cos(b.rail.w * dtP) : 0,
        railDs: circ ? Math.sin(b.rail.w * dtP) : 0,
        railEl: (railed && b.rail.e > 0)
          ? { e: b.rail.e, a: b.rail.a, smin: b.rail.smin, n: b.rail.n, M: b.rail.M, dir: b.rail.dir, ca: b.rail.ca, sa: b.rail.sa }
          : null,
      });
    }
  }
  // Map lookup, not indexOf — the old per-ghost indexOf was O(attractors²)
  const srcIdx = new Map();
  for (let i = 0; i < src.length; i++) srcIdx.set(src[i], i);
  for (let i = 0; i < src.length; i++) {
    if (src[i].parent) atr[i].parentIdx = srcIdx.get(src[i].parent) ?? -1;
    const anchor = starAnchor(src[i]);
    if (anchor) atr[i].anchorIdx = srcIdx.get(anchor) ?? -1;
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
      parentGhost: h.parent ? atr[srcIdx.get(h.parent)] || null : null,
      anchorGhost: anchor ? atr[srcIdx.get(anchor)] || null : null,
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
    // Mirror of gravityAt's influence cutoffs: default muls = a loose-body
    // ghost (the held rock), which skips negligible far attractors exactly
    // like the real rock will; the ship path (muls ≠ 1) uses the wide ship
    // cutoff, exactly like the real ship.
    const loose = starMul === 1 && heavyMul === 1;
    for (const b of atr) {
      const dx = b.x - x, dy = b.y - y;
      const d2 = dx * dx + dy * dy + soft2;
      if (d2 > (loose ? b.cull2 : b.cull2Ship)) continue;
      let w = b.star ? starMul : b.weighted ? heavyMul : 1;
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
  // Prefilter (perf): the drawn ship path is length-capped at maxPathLen from
  // its start, so only attractors that can come within reach of that circle
  // over the whole horizon can ever be hit by it or rubber-band it. Ghost
  // speeds are sampled at build time with a generous margin (×2 + slack
  // covers elliptical rails and parent drift) — an over-full list only costs
  // a few extra distance tests, while the full-atr scans these replace were
  // two O(attractors) loops per forecast step.
  const hitAtr = [], rbAtr = [];
  const horizon = steps * dt;
  // Per-ghost advance shortlist for LIVE LOOSE attractors (heavy belt rocks
  // that cleared ATTRACT_MIN but aren't railed — the view-local field spawns
  // dozens at once): their sum is unweighted (the weighted branch below only
  // fires for celestials) and their gravity interest is tiny (cull2 reaches
  // ~1-2ku), so running the full O(attractors) inner loop per rock per step
  // made a fresh-spawn forecast cost MORE than the whole sim substep. One
  // build-time pass collects the few sources that can reach each rock over
  // the horizon; live CELESTIAL ghosts (rare) keep the full weighted sum.
  for (let bi = 0; bi < atr.length; bi++) {
    const b = atr[bi];
    if (b.star || b.railParent || b.weighted) continue;
    const list = [];
    const spdB = Math.hypot(b.vx, b.vy);
    for (const o of atr) {
      if (o === b) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (d < Math.sqrt(o.cull2) + (spdB + Math.hypot(o.vx, o.vy)) * horizon + 300) list.push(o);
    }
    b.adv = list;
  }
  if (ship) {
    // maxPathLen caps the path in the DISPLAY frame; the hit test runs in
    // inertial space, so the ship's own inertial drift over the horizon must
    // widen the reach too (co-moving with a fast inner-system ref body, the
    // inertial path travels much farther than the drawn one).
    const shipDrift = Math.hypot(ship.vx, ship.vy) * horizon;
    for (const b of atr) {
      const reach = maxPathLen + shipDrift + (Math.hypot(b.vx, b.vy) * 2 + 100) * horizon + 200;
      const d = Math.hypot(b.x - ship.x, b.y - ship.y);
      if (d < reach + b.radius + ship.r) hitAtr.push(b);
      if (b.rb && d < reach + b.radius * CFG.SHIP_BAND_RANGE + 300) rbAtr.push(b);
    }
  }
  for (let i = 0; i < steps; i++) {
    // Both forecasts finished (hit / path cap / horizon)? Every remaining
    // step would only advance attractor ghosts nobody reads — stop. At
    // gameplay zoom the ship path caps within a fraction of the horizon,
    // so this routinely skips most of the loop.
    if ((!ship || shipHit || shipEnd) && (!held || heldHit || i >= CFG.HELD_STEPS)) break;
    // Advance attractors (stars pinned) with the same hierarchical weighting
    // the real sim uses, so predicted planet positions match reality.
    for (let bi = 0; bi < atr.length; bi++) {
      const b = atr[bi];
      if (b.star) continue;
      if (b.railParent) {
        if (b.railEl) {
          // Elliptical GHOSTS advance every other step with 2·dt — Kepler is
          // analytic (one Newton solve covers any dt), so this simply halves
          // the solver bill; the ≤1-step position staleness (~10u on a fast
          // moon) is invisible to the forecast's gravity and hit tests. The
          // LIVE rails pass in step() still advances every substep, exactly.
          if (i & 1) {
            keplerStep(b.railEl, dt * 2);
            b.x = b.railParent.x + b.railEl.px;
            b.y = b.railParent.y + b.railEl.py;
          }
        } else {
          // incremental rotation (rotor precomputed at build — see above)
          const c = b.railC * b.railDc - b.railS * b.railDs;
          const s2 = b.railS * b.railDc + b.railC * b.railDs;
          b.railC = c; b.railS = s2;
          b.x = b.railParent.x + c * b.railR;
          b.y = b.railParent.y + s2 * b.railR;
        }
        continue;
      }
      let ax = 0, ay = 0;
      if (b.adv) {
        // live loose rock: unweighted sum over its build-time shortlist
        for (const o of b.adv) {
          const dx = o.x - b.x, dy = o.y - b.y;
          const d2 = dx * dx + dy * dy + soft2;
          if (d2 > o.cull2) continue;
          const inv = (CFG.G * o.mass) / (d2 * Math.sqrt(d2));
          ax += dx * inv; ay += dy * inv;
        }
      } else {
        // live celestial: full hierarchical weighting, like the real sim
        for (let k = 0; k < atr.length; k++) {
          const o = atr[k];
          if (o === b) continue;
          const dx = o.x - b.x, dy = o.y - b.y;
          const d2 = dx * dx + dy * dy + soft2;
          if (d2 > o.cull2) continue;   // negligible tug (never a star/parent — see gravityAt)
          let w = 1;
          if (b.weighted && b.parentIdx !== k && o.parentIdx !== bi) {
            if (o.star) w = (b.anchorIdx === -1 || b.anchorIdx === k) ? 1 : CFG.CROSS_STAR;
            else w = CFG.CROSS_GRAV;
          }
          const inv = (w * CFG.G * o.mass) / (d2 * Math.sqrt(d2));
          ax += dx * inv; ay += dy * inv;
        }
      }
      b.vx += ax * dt; b.vy += ay * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
    }

    if (ship && !shipHit && !shipEnd) {
      let [ax, ay] = accelAt(ship.x, ship.y, CFG.STAR_GRAV_SHIP, CFG.PLANET_GRAV_SHIP);
      ax *= CFG.SHIP_GRAV; ay *= CFG.SHIP_GRAV;
      // Mirror of the orbit rubber band (step) — same inward-only radial
      // damping, so the forecast bends into captures exactly like the ship
      for (const b of rbAtr) {
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
      if (!shipEnd) for (const b of hitAtr) {
        // Gas giants have no ship surface — the meaningful "hit" is the core.
        // Crystal worlds hit at the shard polygon (bounding test first).
        let hr = (b.gas ? b.radius * CFG.GAS_CORE : b.radius) + ship.r;
        const hd2 = (b.x - ship.x) ** 2 + (b.y - ship.y) ** 2;
        if (b.crystal) {
          const bnd = b.radius * CRYSTAL_REACH + ship.r;
          if (hd2 >= bnd * bnd) continue;
          hr = b.radius * crystalRadiusAt(b.cjag, Math.atan2(ship.y - b.y, ship.x - b.x) - b.rot) + ship.r;
        } else if (b.scars && !b.gas) {
          hr = b.radius * scarSurfaceAt(b.scars, b.radius,
            Math.atan2(ship.y - b.y, ship.x - b.x) - b.rot) + ship.r;
        }
        if (hd2 < hr * hr) { shipHit = { x: px, y: py }; break; }
      }
    }
    if (held && !heldHit && i < CFG.HELD_STEPS) {
      let ax, ay;
      if (held.weighted) {
        ax = 0; ay = 0;
        for (const o of atr) {
          const dx = o.x - held.x, dy = o.y - held.y;
          const d2 = dx * dx + dy * dy + soft2;
          if (d2 > o.cull2) continue;   // same influence cutoff as everywhere
          let w;
          if (o === held.parentGhost) w = 1;
          else if (o.star) w = (!held.anchorGhost || o === held.anchorGhost) ? 1 : CFG.CROSS_STAR;
          else w = CFG.CROSS_GRAV;
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
        let hr = b.radius + held.r;
        const hd2 = (b.x - held.x) ** 2 + (b.y - held.y) ** 2;
        if (b.crystal) {   // thrown-rock ✕ lands on the shard polygon
          const bnd = b.radius * CRYSTAL_REACH + held.r;
          if (hd2 >= bnd * bnd) continue;
          hr = b.radius * crystalRadiusAt(b.cjag, Math.atan2(held.y - b.y, held.x - b.x) - b.rot) + held.r;
        } else if (b.scars) {   // ...and inside a crater, not on the rim of one
          hr = b.radius * scarSurfaceAt(b.scars, b.radius,
            Math.atan2(held.y - b.y, held.x - b.x) - b.rot) + held.r;
        }
        if (hd2 < hr * hr) { heldHit = { x: held.x, y: held.y }; break; }
      }
    }
  }
  return { shipPts, heldPts, shipHit, heldHit };
}
