import { CFG } from './config.js';

let NEXT_ID = 1;

export function massToHp(mass) { return Math.max(4, mass * 0.012); }

// Scrap payout for fully destroying a body
export function scrapValue(body) {
  switch (body.type) {
    case 'asteroid': return (6 + body.mass * 0.006) * (body.junk ? 3 : body.comet ? 4 : 1);
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
    this.spin = (Math.random() - 0.5) * 0.6;
    this.rot = Math.random() * 6.28;
    this.attractor = this.type === 'star' || o.mass >= CFG.ATTRACT_MIN;
    // Stations/nests override hp: light enough to grab, tough enough to matter.
    // Planets get a 0.4x factor — their bulk already throttles incoming damage
    // via mass dominance, so full mass-scaled hp made them nigh unkillable.
    this.maxHp = this.type === 'star' ? Infinity
      : (o.hp || massToHp(o.mass) * (this.type === 'planet' ? 0.4 : 1));
    this.hp = this.maxHp;
    this.alive = true;
    this.heldBy = null;      // 'player' | 'orbit' | alien ref | null
    this.thrownBy = null;    // 'player' | 'alien' | null
    this.thrownTimer = 0;
    this.catchCount = 0;     // repeat catches of the same rock grow the beam less
    this.onRails = false;    // riding a precomputed circular orbit
    this.rail = null;        // { parent, r, w, ang }
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
  const w = (dx * (b.vy - parent.vy) - dy * (b.vx - parent.vx)) / (r * r);
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

export class Ship {
  constructor() {
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.radius = 9;         // grows with progression (see shipStats)
    this.mass = 10;
    this.hull = 100;
    this.alive = true;
    this.invuln = 0;
    this.thrusting = false;
    this.braking = false;
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
