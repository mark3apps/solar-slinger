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
  if (b.type === 'moon' && b.parent && b.parent.alive) {
    const orbR = b.onRails ? b.rail.r : Math.hypot(b.x - b.parent.x, b.y - b.parent.y);
    ctx.strokeStyle = 'rgba(180, 200, 255, 0.045)';
    ctx.lineWidth = 1.5 / game.cam.zoom;
    ctx.beginPath(); ctx.arc(b.parent.x, b.parent.y, orbR, 0, TAU); ctx.stroke();
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

  ctx.fillStyle = b.color;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.fill();

  if (b.type === 'planet' && b.ptype) drawPlanetDetail(b);

  if (b.type === 'moon') {
    ctx.strokeStyle = 'rgba(225, 235, 255, 0.85)';
    ctx.lineWidth = Math.max(1.2, 1.5 / game.cam.zoom);
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.stroke();
  }

  // Asteroid texture: a couple of darker pits keyed off the id
  if (b.type === 'asteroid') {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const n = 2 + (b.id % 3);
    for (let i = 0; i < n; i++) {
      const a = b.rot + (i * 2.4) + b.id;
      ctx.beginPath();
      ctx.arc(b.x + Math.cos(a) * b.radius * 0.45, b.y + Math.sin(a) * b.radius * 0.45, b.radius * 0.22, 0, TAU);
      ctx.fill();
    }
  }

  // Day/night shading away from the nearest star
  const st = nearestStar(game, b.x, b.y);
  if (st && b.type !== 'asteroid') {
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

const PTYPE_LABELS = { lava: 'LAVA WORLD', rocky: 'ROCKY WORLD', gas: 'GAS GIANT', ice: 'ICE WORLD' };

// Approach indicator: nearing a planet (or rogue) fades in its name plate and
// a soft ring marking its domain, so you always know what you're flying into.
function drawApproach(game) {
  const s = game.ship;
  if (!s.alive) return;
  const z = game.cam.zoom;
  for (const b of game.bodies) {
    if (!b.alive || (b.type !== 'planet' && b.type !== 'rogue')) continue;
    const zone = b.radius * 5 + 600;
    const d = Math.hypot(b.x - s.x, b.y - s.y);
    if (d > zone) continue;
    const t = 1 - Math.max(0, (d - b.radius) / (zone - b.radius));  // 0 edge -> 1 surface
    const a = 0.15 + 0.55 * t;

    ctx.strokeStyle = `rgba(200, 220, 255, ${0.05 + 0.07 * t})`;
    ctx.lineWidth = 1.5 / z;
    ctx.beginPath(); ctx.arc(b.x, b.y, zone, 0, TAU); ctx.stroke();

    const label = b.type === 'rogue' ? 'ROGUE PLANET'
      : `${(b.name || 'PLANET').toUpperCase()} — ${PTYPE_LABELS[b.ptype] || 'PLANET'}`;
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
      ctx.fillStyle = b.color;
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

  for (const al of game.aliens) if (al.alive) drawAlien(game, al);
  drawShip(game);

  // Hover hint: what would happen if you grabbed the thing under the cursor?
  // green = auto-orbits, cyan = holdable, red = too heavy. Dim when out of
  // beam range.
  if (game.ship.alive) {
    const st = game.st;
    let hov = null, hovD = Infinity;
    for (const b of game.bodies) {
      if (!b.alive || b.type === 'star' || b.heldBy) continue;
      const d = Math.hypot(b.x - game.aim.x, b.y - game.aim.y);
      if (d > b.radius + st.grabSlack) continue;
      if (d < hovD) { hov = b; hovD = d; }
    }
    if (hov && hov !== game.held) {
      const canOrbit = hov.mass <= st.orbitCap && game.orbit.length < st.maxOrbiters;
      const canGrab = hov.mass <= st.capacity;
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

  // (No lock reticle — lock-on shows itself as the throw line shifting.)

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
