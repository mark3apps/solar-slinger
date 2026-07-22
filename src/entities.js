import { CFG } from './config.js';

let NEXT_ID = 1;

export function massToHp(mass) { return Math.max(4, mass * 0.012); }

// Scrap payout for fully destroying a body
export function scrapValue(body) {
  switch (body.type) {
    case 'asteroid': return 6 + body.mass * 0.006;
    case 'moon':     return 30 + body.mass * 0.004;
    case 'planet':   return 90 + body.mass * 0.0012;
    case 'rogue':    return 400;
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
    this.parent = o.parent || null;   // moons orbit a planet; used for gravity weighting
    this.spin = (Math.random() - 0.5) * 0.6;
    this.rot = Math.random() * 6.28;
    this.attractor = this.type === 'star' || o.mass >= CFG.ATTRACT_MIN;
    this.maxHp = this.type === 'star' ? Infinity : massToHp(o.mass);
    this.hp = this.maxHp;
    this.alive = true;
    this.heldBy = null;      // 'player' | 'orbit' | alien ref | null
    this.thrownBy = null;    // 'player' | 'alien' | null
    this.thrownTimer = 0;
    this.catchCount = 0;     // repeat catches of the same rock grow the beam less
    this.onRails = false;    // riding a precomputed circular orbit
    this.rail = null;        // { parent, r, w, ang }
    this.liveT = 0;          // seconds since derailed (for re-railing)
  }
}

// Put a body on a precomputed circular orbit around parent, derived from its
// current position and velocity. Railed bodies cost no gravity math and can
// never drift, decay, or get pumped — they move on rails until disturbed.
export function railBody(b, parent) {
  const dx = b.x - parent.x, dy = b.y - parent.y;
  const r = Math.hypot(dx, dy) || 1;
  const w = (dx * (b.vy - parent.vy) - dy * (b.vx - parent.vx)) / (r * r);
  b.onRails = true;
  b.rail = { parent, r, w, ang: Math.atan2(dy, dx) };
  b.liveT = 0;
}

export function derail(b) {
  if (!b.onRails) return;
  b.onRails = false;
  b.rail = null;
  b.liveT = 0;
}

export class Ship {
  constructor() {
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.radius = 14;        // grows with progression (see shipStats)
    this.mass = 10;
    this.hull = 100;
    this.alive = true;
    this.invuln = 0;
    this.thrusting = false;
    this.braking = false;
  }
}

export class Alien {
  constructor(x, y) {
    this.id = NEXT_ID++;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.radius = CFG.ALIEN_RADIUS;
    this.hp = CFG.ALIEN_HP;
    this.alive = true;
    this.state = 'seek';     // seek -> fetch -> carry -> cooldown
    this.target = null;      // rock being fetched/carried
    this.cool = 0;
    this.thrustX = 0; this.thrustY = 0;
    this.wobble = Math.random() * 6.28;
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
