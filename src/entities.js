import { CFG } from './config.js';
import { TAU } from './util.js';

let NEXT_ID = 1;

export function massToHp(mass) { return Math.max(4, mass * 0.012); }

// Scrap payout for fully destroying a body
export function scrapValue(body) {
  switch (body.type) {
    case 'asteroid': return (6 + body.mass * 0.006) * (body.core ? 3.5 : body.cache ? 2 : body.junk ? 3 : body.comet ? 4 : 1);
    case 'moon':     return 30 + body.mass * 0.004;
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
    this.ptype = o.ptype || '';   // planet archetype: lava | rocky | gas | ice
    this.parent = o.parent || null;   // moons orbit a planet; used for gravity weighting
    // Axial spin (rad/s). Planets and moons rotate gently — their surface
    // detail turns under the FIXED star-lit terminator (render.js), so a point
    // on the surface cycles through day and night. Planets are statelier
    // (~78-210s day), moons a touch faster (~45-126s); either sign, so some
    // worlds spin retrograde. Asteroids keep their faster tumble.
    const spinDir = Math.random() < 0.5 ? -1 : 1;
    this.spin = this.type === 'planet' ? spinDir * (0.03 + Math.random() * 0.05)
      : this.type === 'moon' ? spinDir * (0.05 + Math.random() * 0.09)
      : (Math.random() - 0.5) * 0.6;
    this.rot = Math.random() * 6.28;
    this.attractor = this.type === 'star' || o.mass >= CFG.ATTRACT_MIN;
    // Stations/nests override hp: light enough to grab, tough enough to matter.
    // PLANETS are their own durability CLASS — a flat base plus a gentle mass
    // slope, not the mass-scaled curve (CFG.PLANET_HP_* carries the full
    // rationale). It is what makes a world survive a moon thrown into it.
    this.maxHp = this.type === 'star' ? Infinity
      : (o.hp || (this.type === 'planet'
        ? CFG.PLANET_HP_BASE + massToHp(o.mass) * CFG.PLANET_HP_MUL
        : massToHp(o.mass)));
    this.hp = this.maxHp;
    this.alive = true;
    this.scars = [];         // impact craters {a: surface-local angle, s: size, t: time} — render draws them
    this.heldBy = null;      // 'player' | 'orbit' | alien ref | null
    this.thrownBy = null;    // 'player' | 'alien' | null
    this.thrownTimer = 0;
    this.catchCount = 0;     // repeat catches of the same rock grow the beam less
    this.onRails = false;    // riding a precomputed orbit (circular or ellipse)
    this.rail = null;        // circular {parent,r,w,ang} | ellipse {parent,e,a,...}
    this.liveT = 0;          // seconds since derailed (for re-railing)
    this.local = false;      // spawned by the view-local field (cullable)
  }
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
    this.mass = 10;
    this.hull = 67;
    this.shield = 33;        // recharging layer; absorbs damage before the hull
    this.shieldHitT = 0;
    this.alive = true;
    this.invuln = 0;
    this.thrusting = false;
    this.braking = false;
    this.engineOutT = 0;     // flare EMP: seconds of dead engines remaining
  }
}

export class Alien {
  constructor(x, y, kind = 'grabber') {
    this.id = NEXT_ID++;
    this.kind = kind;        // 'grabber' | 'wright' | 'golem'
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
