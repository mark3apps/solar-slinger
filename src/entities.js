import { CFG } from './config.js';
import { TAU, CRYSTAL_REACH } from './util.js';

// A body's id is not just an identity — it is a SEED. rockshape.rockShapeOf
// picks the baked silhouette off `b.id % ROCK_ROOTS.length`, and render.js
// seeds the shard arch, the jag ring, the crystal shards and half a dozen
// sprite details off it too. So the counter has to restart with the world, or
// two runs of the same seed are not the same sky: the rock at a given position
// wears a different shape on the second run (the counter had advanced ~4,400),
// which changes its reach, its SAT contacts and therefore which ambient
// collisions happen. Measured: window.mechTest's own contract is to be
// bit-repeatable, and freshRun(0, seed) + tick(0.5) — identical worldgen
// checksum in — landed on 4,409 / 4,410 / 4,411 live bodies across four
// consecutive in-session runs, purely from this. RESET WITH THE WORLD, in the
// same block as gravel.reset() and the registries (world.js) — it is the same
// family of bug: state that outlives its world. (Issue #96.)
let NEXT_ID = 1;
export function resetBodyIds() { NEXT_ID = 1; }

export function massToHp(mass) { return Math.max(4, mass * 0.012); }

// Scrap payout for fully destroying a body
export function scrapValue(body) {
  switch (body.type) {
    case 'asteroid': return (6 + body.mass * 0.006) * (body.core ? 3.5 : body.cache ? 2 : body.junk ? 3 : body.comet ? 4 : 1);
    // A husk moon is plated in salvage — richer than bare rock (the junk-rock
    // precedent, milder: the moon's base value is already large).
    case 'moon':     return (30 + body.mass * 0.004) * (body.moonType === 'husk' ? 1.8 : 1);
    case 'planet':   return 90 + body.mass * 0.0012;
    case 'rogue':    return 400;
    case 'station':  return 350;   // derelict salvage jackpot
    case 'nest':     return 500;   // hard to crack, well worth it
    default:         return 5;
  }
}

// Celestial body: star, planet, moon, rogue planet, or asteroid.
export class Body {
  constructor(o) {
    this.id = NEXT_ID++;
    this.type = o.type;
    this.name = o.name || '';
    this.x = o.x; this.y = o.y;
    this.vx = o.vx || 0; this.vy = o.vy || 0;
    this.ax = 0; this.ay = 0;          // gravity accel (per substep)
    this.extAx = 0; this.extAy = 0;    // tractor / alien-carry accel (per frame)
    this.mass = o.mass;
    this.radius = o.radius;
    this.baseMass = o.mass;
    this.baseRadius = o.radius;
    this.color = o.color || '#888';
    this.ring = o.ring || false;
    this.ptype = o.ptype || '';   // planet archetype: lava | rocky | gas | ice | terran | ocean | desert | shroud | crystal (each carries one mechanic — see world.js PTYPE comment)
    this.parent = o.parent || null;   // moons orbit a planet; used for gravity weighting
    // Axial spin (rad/s). Planets and moons rotate gently — their surface
    // detail turns under the FIXED star-lit terminator (render.js), so a point
    // on the surface cycles through day and night. Either sign, so some worlds
    // spin retrograde. Asteroids keep their faster tumble.
    //
    // A PLANET'S DAY GETS LONGER THE BIGGER IT IS (CFG.PLANET_SPIN_*): the flat
    // slowdown applies to every world, and the size falloff on top of it only
    // bites past PLANET_SPIN_REF, so small worlds are slowed but never sped up.
    // ~314-838s for a 180-unit world, 18-50 MINUTES for a 1,290-unit giant.
    // Moons keep their own quicker turn (~90-252s) — it is part of reading as
    // a small body next to a world — halved same as planets per the same
    // user request.
    const spinDir = Math.random() < 0.5 ? -1 : 1;
    this.spin = this.type === 'planet'
      ? spinDir * (0.03 + Math.random() * 0.05) * CFG.PLANET_SPIN_SLOW
        * Math.pow(CFG.PLANET_SPIN_REF / Math.max(CFG.PLANET_SPIN_REF, o.radius), CFG.PLANET_SPIN_POW)
      : this.type === 'moon' ? spinDir * (0.025 + Math.random() * 0.045)
      : (Math.random() - 0.5) * 0.6;
    this.rot = Math.random() * TAU;
    this.attractor = this.type === 'star' || o.mass >= CFG.ATTRACT_MIN;
    // Stations/nests override hp: light enough to grab, tough enough to matter.
    // PLANETS are their own durability CLASS — a flat base plus a gentle mass
    // slope, not the mass-scaled curve (CFG.PLANET_HP_* carries the full
    // rationale). It is what makes a world survive a moon thrown into it.
    this.maxHp = this.type === 'star' ? Infinity
      : (o.hp || (this.type === 'planet'
        ? CFG.PLANET_HP_BASE + massToHp(o.mass) * CFG.PLANET_HP_MUL
        : this.type === 'moon'
          ? CFG.MOON_HP_BASE + massToHp(o.mass) * CFG.MOON_HP_MUL
          : massToHp(o.mass)));
    this.hp = this.maxHp;
    this.alive = true;
    this.scars = [];         // impact craters {a: surface-local angle, s: size, t: time} — render draws them
    this.heldBy = null;      // 'player' | 'orbit' | alien ref | null
    this.thrownBy = null;    // 'player' | 'alien' | null
    this.thrownTimer = 0;
    this.throwLock = 0;      // seconds left in which YOUR beam may not re-grab it (CFG.THROW_LOCKOUT)
    this.holdT = null;       // seconds in the beam — the wind-up (tractor.beamGrip); null = not held
    this.ropeL = null;       // live length of a taut tether (tractor.springHeld); null = no rope
    this.catchCount = 0;     // repeat catches of the same rock grow the beam less
    this.onRails = false;    // riding a precomputed orbit (circular or ellipse)
    this.rail = null;        // circular {parent,r,w,ang} | ellipse {parent,e,a,...}
    this.liveT = 0;          // seconds since derailed (for re-railing)
    this.local = false;      // spawned by the view-local field (cullable)
  }
}

// Dress a freshly spawned asteroid as A PIECE OF A WORLD. One function behind
// all four sources of crust — the debris belts worldgen hangs on every planet
// (world.seedDebrisBelts), the pieces a wounded world calves under fire
// (physics.calveCrust), the cloud a dying world comes apart into, and the
// cascade when a big piece is itself broken up — so those four can never drift
// apart in look or in physics. Callers set MASS from config.crustMass(R).
export function makeChunk(b, R, mat) {
  b.chunk = true;                    // render's crust-shard sprite
  b.radius = b.baseRadius = R;       // SIZE comes from the parent world, not from mass
  b.color = mat.color;
  if (mat.ice) b.ice = true;
  if (mat.cored) { b.cored = true; b.color = '#7d7566'; }
  // A slab is a real target, not a pebble that pops on the first bump: hp
  // follows the drawn size, because that is what the player is aiming at.
  b.maxHp = b.hp = massToHp(b.mass) * CFG.CRUST_HP_MUL;
  // DEBRIS IS NEVER AN ATTRACTOR, at any mass — the rule dense-field rock runs
  // on, for both of its reasons. A rubble halo must not tug on the rails around
  // its own world, and 26 pieces per world across every world the player works
  // over would join the O(bodies x attractors) hot loop for nothing.
  b.attractor = false;
  return b;
}

// The RIGID angular rate of a world's rubble shell — one rate for everything
// orbiting inside CFG.CRUST_BAND_*, shared by the debris belts worldgen hangs
// on a planet and the crust it calves under fire. Same law as a dense-field
// pocket's shared rail.w, and for the same reason: with per-radius Keplerian
// rates neighbouring pieces catch up with each other and grind, and a railed
// body shoved apart by contact resolution snaps back on the next rail advance,
// which reads as a shell that vibrates. Rigid, the rubble keeps the shape the
// impacts gave it. Signed with the host's spin, so it turns the way the surface
// it came off does. Cached on the host.
export function chunkHaloW(host) {
  if (host.haloW === undefined) {
    // Crystal worlds measure from the SPIKE reach, never the mean disc — the
    // same law (and the same shared constant) world.seedDebrisBelts uses to
    // float a crystal world's junk ring clear of the turning spikes. Read from
    // util.CRYSTAL_REACH, never copied: a hard-coded 1.32 here would silently
    // stop tracking the spikes the first time they are retuned, and the halo
    // would settle down inside them.
    const reach = host.ptype === 'crystal' ? host.radius * CRYSTAL_REACH : host.radius;
    const r = reach * (CFG.CRUST_BAND_LO + CFG.CRUST_BAND_HI) * 0.5;
    const vC = Math.sqrt((CFG.G * host.mass * r * r) / Math.pow(r * r + CFG.GRAV_SOFT ** 2, 1.5));
    host.haloW = (vC / r) * (host.spin < 0 ? -1 : 1);
  }
  return host.haloW;
}

// Put a body on a precomputed circular orbit around parent, derived from its
// current position and velocity. Railed bodies cost no gravity math and can
// never drift, decay, or get pumped — they move on rails until disturbed.
export function railBody(b, parent) {
  const dx = b.x - parent.x, dy = b.y - parent.y;
  const r = Math.hypot(dx, dy) || 1;
  let w = (dx * (b.vy - parent.vy) - dy * (b.vx - parent.vx)) / (r * r);
  // SUN-ANCHORED orbits aren't a perfectly rigid disc: a small deterministic
  // per-body factor (±~4%, hashed off the id so it's stable AND seed-safe)
  // nudges each one a touch faster/slower. Kept subtle on purpose — a bigger
  // spread lets same-radius rocks catch up and grind each other. Callers always
  // pass an exact-circular velocity (spawn / re-rail reset), so w is derived
  // clean and the jitter never compounds. Moons/installations stay exact.
  if (parent.type === 'star') w *= 1 + Math.sin(b.id * 12.9898) * 0.04;
  b.onRails = true;
  b.rail = { parent, r, w, ang: Math.atan2(dy, dx) };
  b.homeR = r;   // installations use this to fly back after a knock
  b.liveT = 0;
}

export function derail(b) {
  if (!b.onRails) return;
  b.onRails = false;
  b.rail = null;
  b.liveT = 0;
}

// Put a body on a precomputed ELLIPTICAL Kepler orbit around parent. Like the
// circular rail this is ANALYTIC — the mean anomaly M advances linearly and we
// solve Kepler's equation each step, so there is ZERO energy drift and the orbit
// can never decay or pump (the whole point of rails). a = semi-major axis,
// e = eccentricity, arg = argument of periapsis (ellipse orientation), M0 =
// starting mean anomaly (phase), dir = +1 prograde / -1 retrograde. Re-railing
// only ever produces CIRCULAR rails, so a knocked-loose ellipse re-rails round.
export function railEllipse(b, parent, a, e, arg, M0, dir = 1) {
  // A ZERO-ECCENTRICITY ELLIPSE IS A CIRCLE, and the two rails are different
  // OBJECTS: an ellipse carries a/e/n/M/smin, a circular rail carries r/w/ang.
  // The physics rail advance picks its branch on `rail.e > 0`, so a degenerate
  // e === 0 ellipse is advanced as a circle, reads the r/w/ang it does not
  // have, and is NaN on its first substep — the tripwire then culls the body
  // (a moon quietly vanishing seconds into the run). spawnMoon legitimately
  // clamps e to 0 whenever a sibling slot is too tight to allow ANY radial
  // excursion, so build the honest circle rather than the degenerate ellipse.
  // At e = 0 the eccentric anomaly equals the mean anomaly, so arg + dir*M0 is
  // exactly where the elliptical path would have put it — same seeded world.
  if (!(e > 0)) {
    const th = arg + M0 * dir;
    b.x = parent.x + Math.cos(th) * a;
    b.y = parent.y + Math.sin(th) * a;
    const soft2 = CFG.GRAV_SOFT * CFG.GRAV_SOFT;
    const sp = Math.sqrt(((CFG.G * parent.mass * a) / Math.pow(a * a + soft2, 1.5)) * a) * dir;
    b.vx = parent.vx - Math.sin(th) * sp;
    b.vy = parent.vy + Math.cos(th) * sp;
    railBody(b, parent);   // sets onRails / rail / homeR / liveT
    return;
  }
  const mu = CFG.G * parent.mass;
  const rail = {
    parent, e, a, arg,
    smin: a * Math.sqrt(1 - e * e),        // semi-minor axis
    n: Math.sqrt(mu / (a * a * a)),        // mean motion (rad/s)
    M: M0, dir,
    ca: Math.cos(arg), sa: Math.sin(arg),  // cached rotation for the apsidal line
  };
  b.onRails = true;
  b.rail = rail;
  b.homeR = a;
  b.liveT = 0;
  keplerStep(rail, 0);                      // seed rail.px/py/vpx/vpy
  b.x = parent.x + rail.px; b.y = parent.y + rail.py;
  b.vx = parent.vx + rail.vpx; b.vy = parent.vy + rail.vpy;
}

// Advance an elliptical rail by dt and stash the parent-relative position and
// velocity offsets on the rail object (rail.px/py/vpx/vpy). Pure w.r.t. the
// parent — the caller adds the parent's live position/velocity. Used by the
// physics step AND (on a throwaway copy) by predictPaths, so it must not read
// anything but the rail's own elements.
export function keplerStep(rail, dt) {
  rail.M += rail.n * dt;
  let M = rail.M % TAU; if (M < 0) M += TAU;
  const e = rail.e;
  // Newton solve of Kepler's equation M = E - e sin E (5 iters is exact to
  // float precision for the modest e we spawn)
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 5; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const denom = 1 - e * cosE;
  // perifocal position/velocity (apsidal line = +x), direction-reflected in y
  const px0 = rail.a * (cosE - e);
  const py0 = rail.smin * sinE * rail.dir;
  const edot = rail.n / denom;             // dE/dt
  const vpx0 = -rail.a * sinE * edot;
  const vpy0 = rail.smin * cosE * edot * rail.dir;
  // rotate perifocal frame into world by the argument of periapsis
  const ca = rail.ca, sa = rail.sa;
  rail.px = px0 * ca - py0 * sa;
  rail.py = px0 * sa + py0 * ca;
  rail.vpx = vpx0 * ca - vpy0 * sa;
  rail.vpy = vpx0 * sa + vpy0 * ca;
}

export class Ship {
  constructor() {
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.radius = 9;         // grows with progression (see shipStats)
    this.mass = 10;          // tier-0 seed; main.js keeps it at st.shipMass (CFG SHIP_MASS)
    this.hull = 67;
    this.shield = 33;        // recharging layer; absorbs damage before the hull
    this.shieldHitT = 0;
    // BRAWLER's ram: absorbed rock MASS, welded to the nose as one structure.
    // Not a rank and not a pool that refills — you build it by eating rocks
    // (tractor.absorbIntoRam) and it is spent taking hits (physics.spendRam).
    this.ram = 0;
    this.ramHitT = 0;        // one-shot pulse on a crush or an impact (render)
    this.ramHitAng = 0;      // world bearing of the last hit — the ripple's origin
    this.alive = true;
    this.invuln = 0;
    this.thrusting = false;
    this.braking = false;
    this.engineOutT = 0;     // flare EMP: seconds of dead engines remaining
    // SLING CREDIT (physics.js speed governor, CFG.SLING_*): extra ceiling
    // earned when WORLD gravity does positive work on the over-ceiling
    // deviation — a slingshot rides above maxSpeed and decays on its own
    // slow clock instead of being bled off like thrust overspeed.
    this.slingSpd = 0;
  }
}

export class Alien {
  constructor(x, y, kind = 'grabber') {
    this.id = NEXT_ID++;
    this.kind = kind;        // 'grabber' | 'wright' | 'golem' | 'lurker'
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.radius = CFG.ALIEN_RADIUS;
    this.hp = CFG.ALIEN_HP;
    this.alive = true;
    this.state = 'seek';     // grabber: seek -> fetch -> carry -> cooldown
    this.target = null;      // rock being fetched/carried
    this.cool = 0;
    this.thrustX = 0; this.thrustY = 0;
    this.wobble = Math.random() * 6.28;
    if (kind === 'wright') {         // necro-mechanic: harvests debris, builds golems
      this.radius = 17; this.hp = 70;
      this.state = 'approach';
      this.anchor = null;            // debris field it descends on
      this.hoard = 0;                // scrap value consumed (refunded on kill)
      this.buildT = 0;
    } else if (kind === 'golem') {   // welded from your leftovers; only rams
      this.radius = 21; this.hp = 150;
      this.contactDmg = 40;
      this.hoard = 0;
    } else if (kind === 'lurker') {  // dense-field ambusher: fast, frail, hit-and-run
      this.radius = CFG.LURKER_RADIUS; this.hp = CFG.LURKER_HP;
      this.contactDmg = CFG.LURKER_DMG;
      this.state = 'stalk';          // lurker: stalk -> pounce -> slip (ai.js)
      this.field = 0;                // index into game.fields — its home shoal
      this.slipDir = 1;              // which way the next break-off curls
    }
  }
}

// Collectible scrap chunk
export function makeScrap(x, y, vx, vy, value) {
  return {
    x, y, vx, vy, value,
    radius: 3 + Math.min(4, value * 0.35),
    life: CFG.DEBRIS_LIFE,
    phase: Math.random() * 6.28,
  };
}
