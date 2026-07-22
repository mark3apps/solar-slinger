import { CFG } from './config.js';
import { predictPaths } from './physics.js';
import { TAU, mulberry32 } from './util.js';

let canvas, ctx, vw, vh, dpr;
const starLayers = [];   // parallax background stars
const oortSpecks = [];   // icy debris ring marking the world edge

export function initRender(cv) {
  canvas = cv;
  ctx = canvas.getContext('2d');
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = vw * dpr; canvas.height = vh * dpr;
  };
  resize();
  window.addEventListener('resize', resize);

  const rng = mulberry32(777);
  for (const [parallax, count, size] of [[0.15, 220, 1.1], [0.35, 140, 1.7]]) {
    const pts = [];
    for (let i = 0; i < count; i++) {
      pts.push({ x: rng() * 4000, y: rng() * 4000, b: 0.25 + rng() * 0.75, s: size * (0.5 + rng()) });
    }
    starLayers.push({ parallax, pts });
  }
  for (let i = 0; i < 420; i++) {
    const th = rng() * TAU;
    const r = CFG.WORLD_R + 150 + rng() * rng() * 3200;
    oortSpecks.push({ x: Math.cos(th) * r, y: Math.sin(th) * r, s: 2 + rng() * 7, b: 0.25 + rng() * 0.5 });
  }
  return { getView: () => ({ vw, vh }) };
}

function worldTransform(game, shakeX, shakeY) {
  const { cam } = game;
  ctx.setTransform(
    dpr * cam.zoom, 0, 0, dpr * cam.zoom,
    dpr * (vw / 2 - cam.x * cam.zoom + shakeX),
    dpr * (vh / 2 - cam.y * cam.zoom + shakeY),
  );
}

function drawStarfield(game) {
  const { cam } = game;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const layer of starLayers) {
    const ox = cam.x * layer.parallax, oy = cam.y * layer.parallax;
    for (const p of layer.pts) {
      const x = ((p.x - ox) % 4000 + 4000) % 4000 - (4000 - vw) / 2;
      const y = ((p.y - oy) % 4000 + 4000) % 4000 - (4000 - vh) / 2;
      if (x < -10 || x > vw + 10 || y < -10 || y > vh + 10) continue;
      ctx.globalAlpha = p.b * 0.8;
      ctx.fillStyle = '#cdd8ff';
      ctx.fillRect(x, y, p.s, p.s);
    }
  }
  ctx.globalAlpha = 1;
}

// Asteroids are jagged polygons, not discs — and the bigger the rock, the
// craggier the silhouette (pebbles stay nearly round, boulders are gnarled).
// The vertex offsets are generated once per body, keyed off its id, and
// regenerated if the radius changes (chip damage shrinks rocks).
function traceAsteroid(b) {
  if (!b.jag || b.jagR !== b.radius) {
    const t = Math.min(1, Math.max(0, (b.radius - 3) / 27));   // 0 pebble -> 1 boulder
    const n = 7 + Math.min(9, Math.round(b.radius * 0.45));
    const amp = 0.06 + 0.3 * t;
    const rng = mulberry32(b.id * 7919 + 13);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(1 - amp + rng() * amp * 2);
    b.jag = pts; b.jagR = b.radius;
  }
  const n = b.jag.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = b.rot + (i / n) * TAU;
    const r = b.radius * b.jag[i];
    const x = b.x + Math.cos(a) * r, y = b.y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function nearestStar(game, x, y) {
  let best = null, bestD = Infinity;
  for (const b of game.bodies) {
    if (b.type !== 'star') continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD) { best = b; bestD = d; }
  }
  return best;
}

function drawBody(game, b) {
  // Moons announce themselves: a whisper-faint orbit circle around their
  // planet and a bright icy outline — no more confusing them with asteroids.
  // Only while actually riding the rail: a captured or knocked-loose moon
  // isn't following that circle anymore, so it gets no ring.
  if (b.type === 'moon' && b.onRails && b.parent && b.parent.alive) {
    ctx.strokeStyle = 'rgba(180, 200, 255, 0.045)';
    ctx.lineWidth = 1.5 / game.cam.zoom;
    ctx.beginPath(); ctx.arc(b.parent.x, b.parent.y, b.rail.r, 0, TAU); ctx.stroke();
  }

  // Planets show a short stretch of their orbital path around the sun
  if (b.type === 'planet' && b.onRails) {
    const rl = b.rail;
    ctx.strokeStyle = 'rgba(190, 210, 255, 0.06)';
    ctx.lineWidth = 1.5 / game.cam.zoom;
    const span = 0.22;
    ctx.beginPath();
    ctx.arc(rl.parent.x, rl.parent.y, rl.r, rl.ang - span, rl.ang + span);
    ctx.stroke();
  }

  if (b.type === 'star') {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.2, b.x, b.y, b.radius * 3.2);
    g.addColorStop(0, b.color);
    g.addColorStop(0.28, b.color + 'cc');
    g.addColorStop(0.45, b.color + '33');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 3.2, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fffef0';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 0.92, 0, TAU); ctx.fill();
    return;
  }

  if (b.ring) {
    ctx.strokeStyle = b.color + '66';
    ctx.lineWidth = b.radius * 0.34;
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, b.radius * 2.0, b.radius * 0.62, b.rot * 0.15, 0, TAU);
    ctx.stroke();
  }

  // Lava worlds glow — visible even when zoomed way out
  if (b.ptype === 'lava') {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.5, b.x, b.y, b.radius * 2.2);
    g.addColorStop(0, 'rgba(255, 110, 40, 0.4)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.2, 0, TAU); ctx.fill();
  }

  // Comets stream an icy tail behind them
  if (b.comet) {
    const vm = Math.hypot(b.vx, b.vy) || 1;
    const tx = b.x - (b.vx / vm) * b.radius * 9, ty = b.y - (b.vy / vm) * b.radius * 9;
    const tg = ctx.createLinearGradient(b.x, b.y, tx, ty);
    tg.addColorStop(0, 'rgba(170, 235, 255, 0.55)');
    tg.addColorStop(1, 'transparent');
    ctx.strokeStyle = tg;
    ctx.lineWidth = b.radius * 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // Hot magma bombs glow until they cool
  if (b.magma > 0) {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.4, b.x, b.y, b.radius * 2.6);
    g.addColorStop(0, 'rgba(255, 140, 50, 0.55)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.6, 0, TAU); ctx.fill();
  }

  ctx.fillStyle = b.color;
  if (b.type === 'asteroid') {
    traceAsteroid(b);
    ctx.fill();
  } else if (b.type === 'station') {
    drawStationSprite(b);
  } else if (b.type === 'nest') {
    drawNestSprite(game, b);
  } else {
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.fill();
  }

  if (b.type === 'planet' && b.ptype) drawPlanetDetail(b);
  if (b.ember > 0.01) drawEmberReef(game, b);
  if (b.fort) drawFort(game, b);

  if (b.type === 'moon') {
    ctx.strokeStyle = 'rgba(225, 235, 255, 0.85)';
    ctx.lineWidth = Math.max(1.2, 1.5 / game.cam.zoom);
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.stroke();
  }

  // Asteroid texture: darker pits keyed off the id, clipped to the silhouette
  if (b.type === 'asteroid') {
    ctx.save();
    traceAsteroid(b);
    ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const n = 2 + (b.id % 3);
    for (let i = 0; i < n; i++) {
      const a = b.rot + (i * 2.4) + b.id;
      ctx.beginPath();
      ctx.arc(b.x + Math.cos(a) * b.radius * 0.45, b.y + Math.sin(a) * b.radius * 0.45, b.radius * 0.22, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Day/night shading away from the nearest star
  const st = nearestStar(game, b.x, b.y);
  if (st && b.type !== 'asteroid' && b.type !== 'station' && b.type !== 'nest') {
    const ang = Math.atan2(b.y - st.y, b.x - st.x);
    ctx.save();
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(2, 4, 14, 0.5)';
    ctx.beginPath();
    ctx.arc(b.x + Math.cos(ang) * b.radius * 0.55, b.y + Math.sin(ang) * b.radius * 0.55, b.radius * 1.05, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Damage cracks
  if (b.hp < b.maxHp * 0.6 && b.maxHp !== Infinity) {
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = Math.max(1, b.radius * 0.05);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = b.id * 1.7 + i * 2.1;
      ctx.moveTo(b.x + Math.cos(a) * b.radius * 0.2, b.y + Math.sin(a) * b.radius * 0.2);
      ctx.lineTo(b.x + Math.cos(a + 0.5) * b.radius * 0.9, b.y + Math.sin(a + 0.5) * b.radius * 0.9);
    }
    ctx.stroke();
  }

  // Held / orbiting highlights
  if (b.heldBy === 'player') {
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.8)';
    ctx.lineWidth = 2 / game.cam.zoom;
    ctx.setLineDash([6 / game.cam.zoom, 5 / game.cam.zoom]);
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 8 / game.cam.zoom, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  } else if (b.heldBy === 'orbit') {
    ctx.strokeStyle = 'rgba(130, 255, 200, 0.55)';
    ctx.lineWidth = 1.5 / game.cam.zoom;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 5 / game.cam.zoom, 0, TAU); ctx.stroke();
  }
}

// Per-archetype surface detail, drawn clipped to the planet disc. This is
// what makes the planet TYPES readable: bands = gas, cracks+glow = lava,
// caps = ice, continents = rocky.
function drawPlanetDetail(b) {
  ctx.save();
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.clip();
  ctx.translate(b.x, b.y);

  if (b.ptype === 'gas') {
    ctx.rotate(b.id % 2 ? 0.32 : -0.26);
    const n = 5 + (b.id % 3);
    const bandH = (2 * b.radius) / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.17)';
      ctx.fillRect(-b.radius, -b.radius + i * bandH, b.radius * 2, bandH * 0.72);
    }
    // A great storm spot
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(b.radius * 0.34, b.radius * 0.3, b.radius * 0.2, b.radius * 0.1, 0.3, 0, TAU);
    ctx.fill();
  } else if (b.ptype === 'lava') {
    ctx.strokeStyle = 'rgba(255, 150, 50, 0.75)';
    ctx.lineWidth = Math.max(1.5, b.radius * 0.05);
    for (let i = 0; i < 4; i++) {
      const a = b.id * 2.3 + i * 1.7;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * b.radius * 0.15, Math.sin(a) * b.radius * 0.15);
      ctx.quadraticCurveTo(
        Math.cos(a + 0.8) * b.radius * 0.55, Math.sin(a + 0.8) * b.radius * 0.55,
        Math.cos(a + 0.5) * b.radius * 0.95, Math.sin(a + 0.5) * b.radius * 0.95);
      ctx.stroke();
    }
  } else if (b.ptype === 'ice') {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.ellipse(0, -b.radius * 0.82, b.radius * 0.75, b.radius * 0.32, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, b.radius * 0.82, b.radius * 0.75, b.radius * 0.32, 0, 0, TAU); ctx.fill();
  } else {  // rocky: mottled continents
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    const n = 4 + (b.id % 3);
    for (let i = 0; i < n; i++) {
      const a = b.id * 1.9 + i * 2.4;
      const rr = b.radius * (0.25 + ((b.id + i) % 4) * 0.09);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * b.radius * 0.55, Math.sin(a) * b.radius * 0.55,
        rr, rr * 0.65, a, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Derelict station: tumbling hub ring with dead solar panels
function drawStationSprite(b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  ctx.fillStyle = '#3d5a78';
  ctx.fillRect(-b.radius * 2.4, -b.radius * 0.32, b.radius * 1.5, b.radius * 0.64);
  ctx.fillRect(b.radius * 0.9, -b.radius * 0.32, b.radius * 1.5, b.radius * 0.64);
  ctx.strokeStyle = b.color;
  ctx.lineWidth = b.radius * 0.28;
  ctx.beginPath(); ctx.arc(0, 0, b.radius * 0.72, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#c9d6e4';
  ctx.beginPath(); ctx.arc(0, 0, b.radius * 0.4, 0, TAU); ctx.fill();
  ctx.restore();
}

// Alien nest: pulsing organic mass ringed with green pods
function drawNestSprite(game, b) {
  const pulse = 1 + Math.sin(game.time * 2 + b.id) * 0.08;
  const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.3, b.x, b.y, b.radius * 2.4);
  g.addColorStop(0, 'rgba(120, 220, 90, 0.3)');
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.4, 0, TAU); ctx.fill();
  ctx.fillStyle = '#3f5e36';
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * pulse, 0, TAU); ctx.fill();
  ctx.fillStyle = '#7ec95f';
  for (let i = 0; i < 6; i++) {
    const a = b.rot + (i / 6) * TAU;
    ctx.beginPath();
    ctx.arc(b.x + Math.cos(a) * b.radius * 0.75, b.y + Math.sin(a) * b.radius * 0.75,
      b.radius * 0.28 * pulse, 0, TAU);
    ctx.fill();
  }
}

// Emberkin bloom: coral crust glowing on the rim + a heat halo scaling
// with infestation depth
function drawEmberReef(game, b) {
  const e = b.ember;
  const g2 = ctx.createRadialGradient(b.x, b.y, b.radius, b.x, b.y, b.radius * 2.2);
  g2.addColorStop(0, `rgba(255, 120, 40, ${0.18 * e})`);
  g2.addColorStop(1, 'transparent');
  ctx.fillStyle = g2;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.2, 0, TAU); ctx.fill();
  ctx.strokeStyle = `rgba(255, 140, 60, ${0.35 + 0.55 * e})`;
  ctx.lineWidth = Math.max(1.5, b.radius * 0.09);
  for (let i = 0; i < 7; i++) {
    const a0 = b.id * 1.3 + i * 0.9 + Math.sin(game.time * 0.6 + i) * 0.05;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius * 1.02, a0, a0 + 0.14 + 0.35 * e);
    ctx.stroke();
  }
}

// Bastion fortifications: an energy shield bubble (flashing when struck)
// and turret blocks riding the surface
function drawFort(game, b) {
  const f = b.fort;
  const z = game.cam.zoom;
  if (f.shield > 0) {
    const frac = f.shield / f.maxShield;
    const flash = f.hitT > 0 ? f.hitT * 1.6 : 0;
    ctx.strokeStyle = `rgba(120, 200, 255, ${0.25 + 0.35 * frac + flash})`;
    ctx.lineWidth = 2.5 / z + b.radius * 0.03;
    ctx.setLineDash([b.radius * 0.4, b.radius * 0.12]);
    ctx.lineDashOffset = game.time * b.radius * 0.5;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.3, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(120, 200, 255, ${0.05 + flash * 0.15})`;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.3, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = '#3a4654';
  ctx.strokeStyle = '#ffb35c';
  ctx.lineWidth = Math.max(1, b.radius * 0.03);
  for (const t of f.turrets) {
    const a = b.rot + t.ang;
    const tx = b.x + Math.cos(a) * b.radius, ty = b.y + Math.sin(a) * b.radius;
    const tr = Math.max(4, b.radius * 0.13);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(a);
    ctx.fillRect(-tr * 0.6, -tr * 0.7, tr * 1.2, tr * 1.4);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tr * 1.5, 0); ctx.stroke();
    ctx.restore();
  }
}

const PTYPE_LABELS = { lava: 'LAVA WORLD', rocky: 'ROCKY WORLD', gas: 'GAS GIANT', ice: 'ICE WORLD' };

// Approach indicator: nearing a planet (or rogue) fades in its name plate and
// a soft ring marking its domain, so you always know what you're flying into.
function drawApproach(game) {
  const s = game.ship;
  if (!s.alive) return;
  const z = game.cam.zoom;
  for (const b of game.bodies) {
    if (!b.alive) continue;
    const isWorld = b.type === 'planet' || b.type === 'rogue';
    const isPOI = b.type === 'station' || b.type === 'nest' || (b.fort && b.type === 'moon');
    if (!isWorld && !isPOI) continue;
    const zone = isPOI && !isWorld ? 1400 : b.radius * 5 + 600;
    const d = Math.hypot(b.x - s.x, b.y - s.y);
    if (d > zone) continue;
    const t = 1 - Math.max(0, (d - b.radius) / (zone - b.radius));  // 0 edge -> 1 surface
    const a = 0.15 + 0.55 * t;

    if (isWorld) {
      ctx.strokeStyle = `rgba(200, 220, 255, ${0.05 + 0.07 * t})`;
      ctx.lineWidth = 1.5 / z;
      ctx.beginPath(); ctx.arc(b.x, b.y, zone, 0, TAU); ctx.stroke();
    }

    const label = b.fort ? `BASTION FORTRESS${b.name ? ' — ' + b.name.toUpperCase() : ''}`
      : b.type === 'rogue' ? 'ROGUE PLANET'
      : b.type === 'station' ? 'DERELICT STATION'
      : b.type === 'nest' ? 'ALIEN NEST'
      : `${(b.name || 'PLANET').toUpperCase()} — ${PTYPE_LABELS[b.ptype] || 'PLANET'}`
        + (b.ember > 0.01 ? ' ⚠ EMBERKIN' : '');
    const fs = Math.max(13 / z, b.radius * 0.16);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(210, 228, 255, ${a})`;
    ctx.fillText(label, b.x, b.y - b.radius - fs * 0.9);
    ctx.textAlign = 'left';
  }
}

// Faint hints: beam reach (blue) and the shield-orbit ring (green)
function drawShipRings(game) {
  const s = game.ship;
  if (!s.alive) return;
  const z = game.cam.zoom;

  ctx.strokeStyle = 'rgba(90, 180, 255, 0.14)';
  ctx.lineWidth = 1.5 / z;
  ctx.setLineDash([5 / z, 11 / z]);
  ctx.beginPath(); ctx.arc(s.x, s.y, game.st.range, 0, TAU); ctx.stroke();

  ctx.setLineDash([]);
}

function drawBeam(game, fromX, fromY, obj, color) {
  const grad = ctx.createLinearGradient(fromX, fromY, obj.x, obj.y);
  grad.addColorStop(0, color + 'cc');
  grad.addColorStop(1, color + '22');
  ctx.strokeStyle = grad;
  const pulse = 1 + Math.sin(game.time * 18) * 0.25;
  ctx.lineWidth = 3.5 * pulse / Math.max(game.cam.zoom, 0.4);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(obj.x, obj.y);
  ctx.stroke();
}

function drawShip(game) {
  const s = game.ship;
  if (!s.alive) return;
  if (s.invuln > 0 && Math.floor(game.time * 10) % 2 === 0) return;  // respawn blink

  const lv = game.st.levels;
  const r = s.radius;

  // GRAVITY-SHIP: four stages, each projecting a bigger sense of scale.
  //   0 SCOUT       (lvl <4):  bare wedge — a speck among the rocks
  //   1 CRUISER     (4-8):     field ring + swept vanes
  //   2 DREADNOUGHT (9-15):    counter-rotating rings, singularity core,
  //                            and a dark gravity-well halo around the hull
  //   3 TITAN       (16+):     third ring, five orbiting field nodes,
  //                            lensing arcs — space itself bends around you
  const stage = game.st.totalLevel >= 16 ? 3 : game.st.totalLevel >= 9 ? 2 : game.st.totalLevel >= 4 ? 1 : 0;
  const drawRing = (R, dash, gap, speed, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([r * dash, r * gap]);
    ctx.lineDashOffset = game.time * r * speed;
    ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.stroke();
  };
  const drawHalo = (R, strength) => {
    // The drive's captive well dims space around the ship
    const hg = ctx.createRadialGradient(s.x, s.y, R * 0.25, s.x, s.y, R);
    hg.addColorStop(0, `rgba(4, 2, 16, ${strength})`);
    hg.addColorStop(0.75, `rgba(30, 20, 70, ${strength * 0.4})`);
    hg.addColorStop(1, 'transparent');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.fill();
  };
  if (stage >= 2) drawHalo(r * (stage >= 3 ? 3.8 : 2.8), stage >= 3 ? 0.5 : 0.35);
  if (stage >= 1) drawRing(r * 1.6, 0.5, 0.35, -1.6, 'rgba(140, 170, 255, 0.5)');
  if (stage >= 2) drawRing(r * 2.25, 0.32, 0.26, 2.1, 'rgba(190, 140, 255, 0.42)');
  if (stage >= 3) {
    drawRing(r * 3.1, 0.2, 0.42, -2.8, 'rgba(120, 230, 255, 0.38)');
    ctx.setLineDash([]);
    // Five field nodes riding the outermost ring
    ctx.fillStyle = '#9fd0ff';
    for (let i = 0; i < 5; i++) {
      const a = game.time * 1.2 + (i * TAU) / 5;
      ctx.beginPath();
      ctx.arc(s.x + Math.cos(a) * r * 3.1, s.y + Math.sin(a) * r * 3.1, Math.max(2, r * 0.11), 0, TAU);
      ctx.fill();
    }
    // Gravitational lensing: two bright thin arcs where light slips past
    ctx.strokeStyle = 'rgba(210, 230, 255, 0.3)';
    ctx.lineWidth = 1.2;
    const la = game.time * 0.35;
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 3.55, la, la + 0.9); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 3.55, la + Math.PI, la + Math.PI + 0.9); ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);

  if (s.thrusting) {
    const f = (1 + Math.sin(game.time * 40) * 0.3) * (1 + lv.thrust * 0.15);
    const g = ctx.createLinearGradient(-r, 0, -r * 2.6 * f, 0);
    g.addColorStop(0, 'rgba(120, 200, 255, 0.9)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, -5 - lv.thrust);
    ctx.lineTo(-r * 2.6 * f, 0);
    ctx.lineTo(-r * 0.7, 5 + lv.thrust);
    ctx.closePath(); ctx.fill();
  }
  if (s.braking) {
    // Retro puffs firing forward
    ctx.fillStyle = 'rgba(255, 190, 120, 0.7)';
    const f = 1 + Math.sin(game.time * 50) * 0.4;
    ctx.beginPath();
    ctx.moveTo(r * 0.9, -4);
    ctx.lineTo(r * (1.5 + 0.4 * f), 0);
    ctx.lineTo(r * 0.9, 4);
    ctx.closePath(); ctx.fill();
  }

  // ENGINES augment: side pods, bigger with level
  if (lv.thrust >= 1) {
    const pr = 2 + lv.thrust * 0.8;
    ctx.fillStyle = '#8aa8c8';
    ctx.beginPath(); ctx.arc(-r * 0.55, -r * 0.62, pr, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(-r * 0.55, r * 0.62, pr, 0, TAU); ctx.fill();
  }

  // HULL augment: armor shell outline, thicker with level
  if (lv.hull >= 1) {
    ctx.strokeStyle = 'rgba(160, 190, 220, 0.55)';
    ctx.lineWidth = 1.5 + lv.hull * 0.8;
    ctx.beginPath();
    ctx.moveTo(r * 1.12, 0);
    ctx.lineTo(-r * 0.9, -r * 0.85);
    ctx.lineTo(-r * 0.5, 0);
    ctx.lineTo(-r * 0.9, r * 0.85);
    ctx.closePath(); ctx.stroke();
  }

  // Field-vane fins fill out the silhouette once the gravity drive matures
  if (stage >= 1) {
    ctx.fillStyle = '#b8cee6';
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, -r * 0.6); ctx.lineTo(-r * 1.15, -r * 1.05); ctx.lineTo(-r * 0.75, -r * 0.35);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, r * 0.6); ctx.lineTo(-r * 1.15, r * 1.05); ctx.lineTo(-r * 0.75, r * 0.35);
    ctx.closePath(); ctx.fill();
  }
  // Dreadnought-class rear vanes: a second, broader pair behind the first
  if (stage >= 2) {
    ctx.fillStyle = '#93aecb';
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.45); ctx.lineTo(-r * 1.6, -r * 0.75); ctx.lineTo(-r * 1.05, -r * 0.15);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, r * 0.45); ctx.lineTo(-r * 1.6, r * 0.75); ctx.lineTo(-r * 1.05, r * 0.15);
    ctx.closePath(); ctx.fill();
  }
  // Titan crown: forward prongs bracketing the nose
  if (stage >= 3) {
    ctx.strokeStyle = '#cfe0f4';
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.beginPath();
    ctx.moveTo(r * 0.55, -r * 0.5); ctx.lineTo(r * 1.45, -r * 0.72);
    ctx.moveTo(r * 0.55, r * 0.5); ctx.lineTo(r * 1.45, r * 0.72);
    ctx.moveTo(r * 0.9, 0); ctx.lineTo(r * 1.7, 0);
    ctx.stroke();
  }

  // Main hull
  ctx.fillStyle = '#dce8f8';
  ctx.strokeStyle = '#6aa8e8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.75, -r * 0.7);
  ctx.lineTo(-r * 0.35, 0);
  ctx.lineTo(-r * 0.75, r * 0.7);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Singularity core: the drive's captive gravity well, dark with a violet rim
  if (stage >= 2) {
    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.55);
    cg.addColorStop(0, 'rgba(10, 6, 24, 0.95)');
    cg.addColorStop(0.7, 'rgba(120, 80, 220, 0.5)');
    cg.addColorStop(1, 'transparent');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, TAU); ctx.fill();
  }
  // Titan accretion ring: matter spiraling into the core, glowing warm
  if (stage >= 3) {
    ctx.strokeStyle = 'rgba(255, 190, 110, 0.65)';
    ctx.lineWidth = Math.max(1.2, r * 0.06);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.62, r * 0.24, game.time * 0.9, 0, TAU);
    ctx.stroke();
  }

  // FLING DRIVE augment: amber accelerator coils across the body
  if (lv.fling >= 1) {
    ctx.strokeStyle = 'rgba(255, 200, 90, 0.75)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < Math.min(3, lv.fling); i++) {
      const cx = r * (0.15 - i * 0.28);
      ctx.beginPath(); ctx.arc(cx, 0, r * (0.34 - i * 0.05), -1.9, 1.9); ctx.stroke();
    }
  }

  // BEAM augment: emitter prongs on the nose, glowing with tier
  if (lv.beam >= 1) {
    ctx.strokeStyle = '#5ac8ff';
    ctx.lineWidth = 1.6;
    const pl = r * (0.3 + lv.beam * 0.09);
    ctx.beginPath();
    ctx.moveTo(r * 0.7, -r * 0.28); ctx.lineTo(r * 0.7 + pl, -r * 0.34);
    ctx.moveTo(r * 0.7, r * 0.28); ctx.lineTo(r * 0.7 + pl, r * 0.34);
    ctx.stroke();
  }
  ctx.fillStyle = lv.beam >= 1 ? '#7adcff' : '#2c6ac8';
  ctx.beginPath(); ctx.arc(r * 0.25, 0, 3.5 + lv.beam * 0.5, 0, TAU); ctx.fill();

  ctx.restore();

  if (game.held) {
    const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    drawBeam(game, s.x + Math.cos(ang) * r, s.y + Math.sin(ang) * r, game.held, '#5ac8ff');
  }
}

function drawAlien(game, al) {
  // Wreckwright: spindly crane-ship with amber work-lights; beams debris
  // in while it builds
  if (al.kind === 'wright') {
    ctx.save();
    ctx.translate(al.x, al.y);
    ctx.fillStyle = '#5a5044';
    ctx.strokeStyle = '#ffb35c';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-al.radius, -al.radius * 0.4, al.radius * 2, al.radius * 0.8);
    ctx.beginPath();
    ctx.moveTo(-al.radius * 0.6, -al.radius * 0.4); ctx.lineTo(-al.radius * 1.3, -al.radius * 1.4);
    ctx.moveTo(al.radius * 0.6, -al.radius * 0.4); ctx.lineTo(al.radius * 1.3, -al.radius * 1.4);
    ctx.stroke();
    const blink = Math.sin(game.time * (al.state === 'build' ? 14 : 5)) > 0;
    ctx.fillStyle = blink ? '#ffd25a' : '#8a6a30';
    ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, TAU); ctx.fill();
    ctx.restore();
    if (al.state === 'build') {   // work aura while assembling
      ctx.strokeStyle = `rgba(255, 210, 90, ${0.25 + 0.2 * Math.sin(game.time * 10)})`;
      ctx.lineWidth = 1.5 / game.cam.zoom;
      ctx.beginPath(); ctx.arc(al.x, al.y, al.radius + 14 / game.cam.zoom, 0, TAU); ctx.stroke();
    }
    return;
  }
  // Scrap-golem: a jagged welded mass with glowing amber seams
  if (al.kind === 'golem') {
    ctx.save();
    ctx.translate(al.x, al.y);
    ctx.rotate(game.time * 0.7 + al.id);
    ctx.fillStyle = '#8b939c';
    ctx.beginPath();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU;
      const r = al.radius * (0.75 + ((al.id + i) % 3) * 0.18);
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(255, 170, 70, ${0.5 + 0.3 * Math.sin(game.time * 6)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = al.id * 1.9 + i * 2.1;
      ctx.moveTo(Math.cos(a) * al.radius * 0.2, Math.sin(a) * al.radius * 0.2);
      ctx.lineTo(Math.cos(a + 0.7) * al.radius * 0.85, Math.sin(a + 0.7) * al.radius * 0.85);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.translate(al.x, al.y);
  const bob = Math.sin(al.wobble) * 2;
  // Saucer
  ctx.fillStyle = '#4a6a52';
  ctx.strokeStyle = '#8aff6a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, bob, al.radius * 1.5, al.radius * 0.62, 0, 0, TAU);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#b8ffd0';
  ctx.beginPath();
  ctx.ellipse(0, bob - al.radius * 0.42, al.radius * 0.62, al.radius * 0.5, 0, Math.PI, 0);
  ctx.fill();
  // Eye glow
  ctx.fillStyle = '#ff5a5a';
  ctx.beginPath(); ctx.arc(0, bob - al.radius * 0.35, 2.5, 0, TAU); ctx.fill();
  ctx.restore();

  if (al.target && al.target.heldBy === al) drawBeam(game, al.x, al.y, al.target, '#7aff5a');
}

function drawPrediction(game) {
  if (!game.predict || game.paused) return;
  const { shipPts, heldPts, shipHit, heldHit } = predictPaths(game);
  const z = game.cam.zoom;

  const drawPath = (pts, hit, color) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([5 / z, 7 / z]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (hit) {
      ctx.strokeStyle = '#ff6a5c';
      ctx.lineWidth = 2 / z;
      const r = 10 / z;
      ctx.beginPath();
      ctx.moveTo(hit.x - r, hit.y - r); ctx.lineTo(hit.x + r, hit.y + r);
      ctx.moveTo(hit.x + r, hit.y - r); ctx.lineTo(hit.x - r, hit.y + r);
      ctx.stroke();
    }
  };
  drawPath(shipPts, shipHit, 'rgba(120, 210, 255, 0.4)');
  drawPath(heldPts, heldHit, 'rgba(255, 200, 90, 0.55)');
}

function drawMinimap(game) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const size = 190, pad = 14;
  const mx = vw - size - pad, my = pad;
  const scale = size / (CFG.WORLD_R * 2.15);
  const cx = mx + size / 2, cy = my + size / 2;

  ctx.fillStyle = 'rgba(6, 10, 24, 0.75)';
  ctx.strokeStyle = 'rgba(110, 180, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, TAU); ctx.fill(); ctx.stroke();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, TAU); ctx.clip();

  for (const b of game.bodies) {
    const x = cx + b.x * scale, y = cy + b.y * scale;
    if (b.type === 'star') {
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
    } else if (b.type === 'rogue') {
      ctx.fillStyle = '#b07aff';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    } else if (b.type === 'planet') {
      ctx.fillStyle = b.ember > 0.01 && Math.sin(game.time * 4) > 0 ? '#ff8040' : b.color;
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      if (b.fort) { ctx.strokeStyle = '#78c8ff'; ctx.lineWidth = 1; ctx.strokeRect(x - 3, y - 3, 6, 6); }
    } else if (b.type === 'moon' && b.fort) {
      ctx.strokeStyle = '#78c8ff'; ctx.lineWidth = 1;
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
    } else if (b.type === 'nest') {
      ctx.fillStyle = '#7ec95f';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    } else if (b.type === 'station') {
      ctx.fillStyle = '#c9d6e4';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    } else if (b.comet) {
      ctx.fillStyle = '#8fe8ff';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
  ctx.fillStyle = '#ff4a4a';
  for (const al of game.aliens) {
    const x = cx + al.x * scale, y = cy + al.y * scale;
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
  if (game.ship.alive) {
    ctx.fillStyle = '#ffffff';
    const x = cx + game.ship.x * scale, y = cy + game.ship.y * scale;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

export function render(game) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#04060d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Nearby-planet ambience: inside a planet's domain, space itself blushes
  // faintly toward the planet's color — you can FEEL that a world is close
  {
    let tint = null, tintT = 0;
    const s = game.ship;
    for (const b of game.bodies) {
      if (!b.alive || b.type !== 'planet') continue;
      const zone = b.radius * 5 + 600;
      const d = Math.hypot(b.x - s.x, b.y - s.y);
      if (d > zone) continue;
      const t = 1 - Math.max(0, (d - b.radius) / (zone - b.radius));
      if (t > tintT) { tintT = t; tint = b; }
    }
    if (tint) {
      const rr = parseInt(tint.color.slice(1, 3), 16);
      const gg = parseInt(tint.color.slice(3, 5), 16);
      const bb = parseInt(tint.color.slice(5, 7), 16);
      ctx.fillStyle = `rgba(${rr}, ${gg}, ${bb}, ${0.05 + 0.08 * tintT})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  drawStarfield(game);

  const shakeX = (Math.random() - 0.5) * game.shake;
  const shakeY = (Math.random() - 0.5) * game.shake;
  worldTransform(game, shakeX, shakeY);

  // Oort cloud: icy fog band + speck field beyond the world edge
  ctx.strokeStyle = 'rgba(150, 190, 255, 0.05)';
  ctx.lineWidth = 3400;
  ctx.beginPath(); ctx.arc(0, 0, CFG.WORLD_R + 1750, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(170, 120, 120, 0.22)';
  ctx.lineWidth = 26;
  ctx.beginPath(); ctx.arc(0, 0, CFG.WORLD_R, 0, TAU); ctx.stroke();
  ctx.fillStyle = 'rgba(190, 215, 255, 0.5)';
  for (const p of oortSpecks) {
    ctx.globalAlpha = p.b;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawShipRings(game);
  drawPrediction(game);
  for (const b of game.bodies) if (b.alive) drawBody(game, b);
  drawApproach(game);

  // Scrap debris — glinting gold
  for (const d of game.debris) {
    const tw = 0.6 + Math.sin(game.time * 6 + d.phase) * 0.4;
    ctx.fillStyle = `rgba(255, 210, 90, ${(0.55 + tw * 0.45) * Math.min(1, d.life / 4)})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.radius, 0, TAU); ctx.fill();
  }

  // Particles (additive glow)
  ctx.globalCompositeOperation = 'lighter';
  for (const p of game.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife) * 0.8;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // Solar flares — searing plasma blobs with trailing streaks
  if (game.flares && game.flares.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (const f of game.flares) {
      ctx.globalAlpha = Math.min(1, f.life);   // fizzle out, don't pop
      const sm = Math.hypot(f.vx, f.vy) || 1;
      const tx = f.x - (f.vx / sm) * f.radius * 6, ty = f.y - (f.vy / sm) * f.radius * 6;
      const streak = ctx.createLinearGradient(f.x, f.y, tx, ty);
      streak.addColorStop(0, 'rgba(255, 190, 90, 0.55)');
      streak.addColorStop(1, 'transparent');
      ctx.strokeStyle = streak;
      ctx.lineWidth = f.radius * 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.lineCap = 'butt';
      const g2 = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius * 2.2);
      g2.addColorStop(0, 'rgba(255, 245, 220, 0.95)');
      g2.addColorStop(0.35, 'rgba(255, 170, 70, 0.6)');
      g2.addColorStop(1, 'transparent');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.radius * 2.2, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Bastion turret bolts — hot tracer rounds
  if (game.bolts && game.bolts.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (const bo of game.bolts) {
      const bm = Math.hypot(bo.vx, bo.vy) || 1;
      ctx.strokeStyle = 'rgba(255, 170, 80, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(bo.x, bo.y);
      ctx.lineTo(bo.x - (bo.vx / bm) * 26, bo.y - (bo.vy / bm) * 26);
      ctx.stroke();
      ctx.fillStyle = '#ffe0a8';
      ctx.beginPath(); ctx.arc(bo.x, bo.y, 3.2, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  for (const al of game.aliens) if (al.alive) drawAlien(game, al);
  drawShip(game);

  // Hover hint: what would happen if you grabbed the thing under the cursor?
  // green = auto-orbits, cyan = holdable, red = too heavy. Dim when out of
  // beam range.
  if (game.ship.alive) {
    const st = game.st;
    let hov = null, hovD = Infinity;
    for (const b of game.bodies) {
      if (!b.alive || b.type === 'star' || b.type === 'nest' || b.heldBy) continue;
      const d = Math.hypot(b.x - game.aim.x, b.y - game.aim.y);
      if (d > b.radius + st.grabSlack) continue;
      if (d < hovD) { hov = b; hovD = d; }
    }
    if (hov && hov !== game.held) {
      const canOrbit = hov.mass <= st.orbitCap && game.orbit.length < st.maxOrbiters && !hov.fort;
      const canGrab = hov.mass <= st.capacity && !hov.fort;
      const inRange = Math.hypot(hov.x - game.ship.x, hov.y - game.ship.y) <= st.range + hov.radius;
      const pulse = 1 + Math.sin(game.time * 6) * 0.18;
      const alpha = (inRange ? 0.85 : 0.3) * (0.7 + 0.3 * Math.sin(game.time * 6));
      const rr = hov.radius + (7 + 4 * pulse) / game.cam.zoom;
      ctx.lineWidth = 2 / game.cam.zoom;
      if (canOrbit) ctx.strokeStyle = `rgba(120, 255, 180, ${alpha})`;
      else if (canGrab) ctx.strokeStyle = `rgba(90, 200, 255, ${alpha})`;
      else ctx.strokeStyle = `rgba(255, 95, 80, ${alpha})`;
      ctx.setLineDash(canGrab ? [] : [5 / game.cam.zoom, 5 / game.cam.zoom]);
      ctx.beginPath(); ctx.arc(hov.x, hov.y, rr, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      if (!canGrab) {   // slash it: clearly beyond the beam
        ctx.beginPath();
        ctx.moveTo(hov.x - rr * 0.7, hov.y + rr * 0.7);
        ctx.lineTo(hov.x + rr * 0.7, hov.y - rr * 0.7);
        ctx.stroke();
      }
    }
  }

  // Volley charge arc around the ship
  if (game.volleyT > 0 && game.ship.alive) {
    const s = game.ship;
    const frac = Math.min(1, game.volleyT / CFG.VOLLEY_TIME);
    ctx.strokeStyle = `rgba(255, 200, 90, ${0.5 + frac * 0.5})`;
    ctx.lineWidth = 4 / game.cam.zoom;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.radius + 16 / game.cam.zoom, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
    ctx.stroke();
  }

  // Lead-point markers: while holding ammo, every nearby mover shows a ✕ at
  // the spot you'd have to RELEASE toward for the paths to collide. The
  // throw always goes straight at the cursor — put the cursor on a ✕ to
  // hit. Markers fade in as the cursor nears them; the "hot" one (current
  // aim already hits) locks bright with brackets on its source target.
  if ((game.held || game.volleyCharging) && game.lock) {
    const z = game.cam.zoom;
    const pulse = 0.65 + 0.35 * Math.sin(game.time * 7);
    const fadeR = 520;
    for (const sol of game.lock.sols) {
      const hot = sol === game.lock.hot;
      if (!hot && sol.cursorD > fadeR) continue;
      const tg = sol.target;
      const lead = Math.hypot(sol.mx - tg.x, sol.my - tg.y);
      const a = hot ? 0.55 + 0.4 * pulse : 0.5 * (1 - sol.cursorD / fadeR);
      // The ✕ (skip when the lead point sits on the target itself — aiming
      // straight at a near-stationary thing needs no marker)
      if (lead > tg.radius * 0.6) {
        const xr = (hot ? 8 : 6) / z;
        ctx.strokeStyle = `rgba(255, 214, 100, ${a})`;
        ctx.lineWidth = (hot ? 2.5 : 1.5) / z;
        ctx.beginPath();
        ctx.moveTo(sol.mx - xr, sol.my - xr); ctx.lineTo(sol.mx + xr, sol.my + xr);
        ctx.moveTo(sol.mx + xr, sol.my - xr); ctx.lineTo(sol.mx - xr, sol.my + xr);
        ctx.stroke();
        // Faint tie back to the rock it belongs to
        ctx.setLineDash([3 / z, 7 / z]);
        ctx.strokeStyle = `rgba(255, 214, 100, ${a * 0.5})`;
        ctx.lineWidth = 1.2 / z;
        ctx.beginPath(); ctx.moveTo(tg.x, tg.y); ctx.lineTo(sol.mx, sol.my); ctx.stroke();
        ctx.setLineDash([]);
      }
      // Hot lock: rotating brackets on the target that will be hit
      if (hot) {
        const rr = tg.radius + 9 / z;
        ctx.strokeStyle = `rgba(140, 255, 170, ${0.5 + 0.4 * pulse})`;
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        for (let q = 0; q < 4; q++) {
          const a0 = q * Math.PI / 2 + game.time * 1.2;
          ctx.moveTo(tg.x + Math.cos(a0) * rr, tg.y + Math.sin(a0) * rr);
          ctx.arc(tg.x, tg.y, rr, a0, a0 + 0.55);
        }
        ctx.stroke();
      }
    }
  }

  // "Too heavy" indicator on a failed grab
  if (game.tooHeavyT > 0 && game.tooHeavy) {
    const b = game.tooHeavy;
    ctx.strokeStyle = `rgba(255, 90, 70, ${Math.min(1, game.tooHeavyT)})`;
    ctx.lineWidth = 2.5 / game.cam.zoom;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 12 / game.cam.zoom, 0, TAU); ctx.stroke();
  }

  drawMinimap(game);

  // Low-hull vignette
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const hullFrac = game.ship.hull / game.st.maxHull;
  if (game.ship.alive && hullFrac < 0.35) {
    const a = (0.35 - hullFrac) * 1.4 * (0.7 + Math.sin(game.time * 5) * 0.3);
    const g = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.35, vw / 2, vh / 2, vh * 0.75);
    g.addColorStop(0, 'transparent');
    g.addColorStop(1, `rgba(200, 20, 20, ${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }
}
