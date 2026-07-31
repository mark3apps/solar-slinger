import { CFG, PROG, SHIP_HIT_FRAC } from './config.js';
import { predictPaths, PARRY_FLICK } from './physics.js';
import { volleyPick } from './tractor.js';
import { TAU, angDiff, lerp, mulberry32, shellModal } from './util.js';

let canvas, ctx, vw, vh, dpr;
let radarCanvas, rctx;   // the radar draws into its own canvas so CSS can tilt it in 3D
let armedSet = null;   // orbiters the shotgun charge has armed this frame
const starLayers = [];   // parallax background stars
const oortShards = [];   // tumbling ice shards in banded shells beyond the world edge

export function initRender(cv) {
  canvas = cv;
  // alpha:false — the first fill each frame paints the whole canvas opaque,
  // so an opaque backbuffer is visually identical and skips compositor blending
  ctx = canvas.getContext('2d', { alpha: false });
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    // A zero-sized window (hidden pane, minimized-at-launch shell) must never
    // reach the math: vw=vh=0 makes cam.zoom 0 and mouseWorld 0/0 -> NaN aim,
    // which NaN-poisons the ship and then (via the ship-anchored local
    // spawner) the whole sim. Fall back to a nominal size until a real one.
    vw = window.innerWidth || 1280; vh = window.innerHeight || 720;
    canvas.width = vw * dpr; canvas.height = vh * dpr;
    radarCanvas.width = radarCanvas.height = RADAR_SIZE * dpr;
  };
  radarCanvas = document.getElementById('radar');
  rctx = radarCanvas.getContext('2d');   // alpha kept: the world shows through around the disc
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
  // Oort hero shards, seeded once and animated in drawOort (drift along the
  // shell + tumble in place — both pure functions of game.time, no update
  // pass). These are only the LANDMARK layer: glinting crystals, craggy
  // bergs, and huge dim ghost masses deep in the fog. The bulk of the cloud
  // is the procedural hashed dust in drawOortDust — a seeded array can never
  // be dense enough over a 264k-unit ring without a monster count.
  const shardBand = (count, r0, r1, s0, s1, kind) => {
    for (let i = 0; i < count; i++) {
      const verts = [];
      const n = 5 + Math.floor(rng() * 4);
      for (let j = 0; j < n; j++) verts.push(0.55 + rng() * 0.5);
      oortShards.push({
        th: rng() * TAU,
        r: r0 + rng() * (r1 - r0),
        w: (rng() - 0.5) * 0.0022,   // slow shell drift, both directions
        size: s0 + rng() * rng() * (s1 - s0),
        verts, kind,
        rot: rng() * TAU,
        spin: (rng() - 0.5) * (kind === 'crystal' ? 0.7 : 0.1),
        b: 0.3 + rng() * 0.45,
        gp: rng() * TAU, gs: 0.6 + rng() * 1.4,   // glint phase / speed
      });
    }
  };
  shardBand(900, CFG.WORLD_R + 60, CFG.WORLD_R + 1800, 4, 13, 'crystal');
  shardBand(420, CFG.WORLD_R + 250, CFG.WORLD_R + 2400, 24, 90, 'berg');
  shardBand(260, CFG.WORLD_R + 1400, CFG.WORLD_R + 3400, 90, 220, 'ghost');
  return { getView: () => ({ vw, vh }) };
}

// Per-frame view rectangle (world space, padded) + the frame's star list —
// both rebuilt at the top of render() so the draw passes can cull cheaply
// instead of pathing every one of ~400 bodies for the canvas to clip.
const view = { x0: 0, y0: 0, x1: 0, y1: 0, cx: 0, cy: 0, r: 0 };
const frameStars = [];

function beginFrame(game) {
  const { cam } = game;
  // pad absorbs screen shake (±15px) and stroke widths
  const halfW = (vw / 2 + 80) / cam.zoom, halfH = (vh / 2 + 80) / cam.zoom;
  view.cx = cam.x; view.cy = cam.y;
  view.x0 = cam.x - halfW; view.x1 = cam.x + halfW;
  view.y0 = cam.y - halfH; view.y1 = cam.y + halfH;
  view.r = Math.hypot(halfW, halfH);
  frameStars.length = 0;
  for (const b of game.bodies) if (b.alive && b.type === 'star') frameStars.push(b);
}

// View culling: true if any drawn element of this body can touch the screen.
// The margin covers the largest overdraw any sprite pass makes (glows, rings
// and halos reach ~3.2x radius; comet tails stream 9x). Railed moons/planets
// also paint faint orbit guides that can be on-screen while the body itself
// is not — those get their own geometric checks so nothing ever pops.
function bodyOnScreen(b) {
  // Vesper's anti-sunward tail reaches ~34x radius at full perihelion bloom
  const m = (b.majorComet ? b.radius * 36 : b.comet ? b.radius * 10 : b.radius * 4) + 80;
  if (b.x + m > view.x0 && b.x - m < view.x1 && b.y + m > view.y0 && b.y - m < view.y1) return true;
  if (b.onRails && b.rail && b.rail.parent.alive) {
    if (b.type === 'moon') {
      // whisper orbit ring centered on the parent: annulus-vs-view test.
      // For an ellipse the apoapsis a(1+e) is the outermost reach.
      const p = b.rail.parent;
      const rr = b.rail.e > 0 ? b.rail.a * (1 + b.rail.e) : b.rail.r;
      const d = Math.hypot(view.cx - p.x, view.cy - p.y);
      if (Math.abs(d - rr) < view.r + 20) return true;
    } else if (b.type === 'planet') {
      // short orbit arc reaching ~0.22*r along the orbit from the planet
      const reach = b.rail.r * 0.23 + 80;
      if (b.x + reach > view.x0 && b.x - reach < view.x1 &&
          b.y + reach > view.y0 && b.y - reach < view.y1) return true;
    }
  }
  return false;
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
  ctx.fillStyle = '#cdd8ff';
  for (const layer of starLayers) {
    const ox = cam.x * layer.parallax, oy = cam.y * layer.parallax;
    for (const p of layer.pts) {
      const x = ((p.x - ox) % 4000 + 4000) % 4000 - (4000 - vw) / 2;
      const y = ((p.y - oy) % 4000 + 4000) % 4000 - (4000 - vh) / 2;
      if (x < -10 || x > vw + 10 || y < -10 || y > vh + 10) continue;
      ctx.globalAlpha = p.b * 0.8;
      ctx.fillRect(x, y, p.s, p.s);
    }
  }
  ctx.globalAlpha = 1;
}

// Procedural ice dust: hashed world-grid grains — the only way to fill a
// 264k-unit ring densely at every zoom without a monster array. The layer
// samples its grid in a slowly ROTATING frame (rotate the view into the
// frame, iterate those cells, rotate points back out), so the whole field
// drifts; two layers counter-rotate so the cloud shimmers with parallax
// instead of reading as one rigid disc. Grains fade in across the wall's
// face (flurries begin inside the warning band) and sink into the fog with
// depth. isShards draws sparser tumbling diamonds instead of fine grains.
function drawOortDust(game, cell, omega, isShards) {
  const phi = omega * game.time;
  const c = Math.cos(phi), s = Math.sin(phi);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [wx, wy] of [[view.x0, view.y0], [view.x1, view.y0], [view.x0, view.y1], [view.x1, view.y1]]) {
    const rx = wx * c + wy * s, ry = -wx * s + wy * c;
    if (rx < bx0) bx0 = rx; if (rx > bx1) bx1 = rx;
    if (ry < by0) by0 = ry; if (ry > by1) by1 = ry;
  }
  const ix0 = Math.floor(bx0 / cell) - 1, ix1 = Math.ceil(bx1 / cell) + 1;
  const iy0 = Math.floor(by0 / cell) - 1, iy1 = Math.ceil(by1 / cell) + 1;
  const inner = CFG.WORLD_R - 420;
  for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
    let h = (ix * 73856093) ^ (iy * 19349663);
    h = ((h ^ (h >> 13)) * 1274126177) & 0x7fffffff;
    if ((h % 8) > (isShards ? 2 : 4)) continue;
    const px = (ix + (h % 89) / 89) * cell, py = (iy + ((h >> 6) % 89) / 89) * cell;
    const rr = Math.hypot(px, py);
    if (rr < inner) continue;
    const wx = px * c - py * s, wy = px * s + py * c;
    if (wx < view.x0 - 12 || wx > view.x1 + 12 || wy < view.y0 - 12 || wy > view.y1 + 12) continue;
    // density rises across the grind radius on a smoothstep (a hard step
    // multiplier at WORLD_R read as a drawn front): with no boundary line,
    // this gradual thickening of stochastic dust is what marks the wall
    const face = Math.min(1, Math.max(0, (rr - CFG.WORLD_R + 200) / 400));
    const aIn = Math.min(1, (rr - inner) / 600) * (0.55 + 0.45 * face * face * (3 - 2 * face));
    const aDeep = 1 / (1 + Math.max(0, rr - CFG.WORLD_R) / 2600);
    const al = (0.14 + ((h >> 8) & 3) * 0.09) * aIn * aDeep;
    if (isShards) {
      const sz = 3.5 + ((h >> 10) & 7) * 0.95;
      const ra = ((h >> 4) & 255) / 255 * TAU + game.time * (((h >> 12) & 1) ? 0.35 : -0.28);
      const cr = Math.cos(ra) * sz, sr = Math.sin(ra) * sz;
      ctx.fillStyle = `rgba(196, 222, 255, ${al})`;
      ctx.beginPath();
      ctx.moveTo(wx + cr, wy + sr);
      ctx.lineTo(wx - sr, wy + cr);
      ctx.lineTo(wx - cr, wy - sr);
      ctx.lineTo(wx + sr, wy - cr);
      ctx.closePath(); ctx.fill();
    } else {
      const sz = 0.9 + ((h >> 10) & 7) * 0.32;
      ctx.fillStyle = `rgba(205, 228, 255, ${al})`;
      ctx.fillRect(wx - sz / 2, wy - sz / 2, sz, sz);
    }
  }
}

// ─── The Oort cloud ─────────────────────────────────────────────────────────
// The world edge is a towering glacial wall, not a dotted line: a deep haze
// bank thickening outward, aurora curtains hanging off its inner face, banded
// shells of tumbling ice (seeded in initRender), and a crisp ember kill line
// at the exact grind radius (physics starts damaging at WORLD_R — the line IS
// the gameplay boundary, so it must sit exactly there). Everything here is
// render-only, same law as the solar storms: it never touches bodies, rails,
// or velocities. All motion is a pure function of game.time, so the wall
// freezes with the sim behind menus like the rest of the world.
function drawOort(game) {
  const t = game.time;
  const camR = Math.hypot(game.cam.x, game.cam.y);

  // Deep haze: a radial fog annulus centered on the origin — transparent at
  // the wall's foot, thickening fast into the pale bank the ice sinks into.
  // Compressed on purpose: at gameplay zoom you only ever see ~600u past the
  // line before the grind kills you, so the fog must close in within that.
  const g = ctx.createRadialGradient(0, 0, Math.max(0, CFG.WORLD_R - 900), 0, 0, CFG.WORLD_R + 2600);
  g.addColorStop(0, 'rgba(150, 195, 255, 0)');
  g.addColorStop(0.26, 'rgba(150, 195, 255, 0.03)');
  g.addColorStop(0.45, 'rgba(160, 200, 255, 0.08)');
  g.addColorStop(0.7, 'rgba(170, 208, 255, 0.15)');
  g.addColorStop(1, 'rgba(190, 220, 255, 0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);

  // Aurora curtains: slow drapery of light on the wall's inner face. Only the
  // visible arc is drawn — the angular window the view subtends from the
  // origin (the full ring would be thousands of segments). Fat overlapping
  // radial strokes at low alpha blend into one continuous band whose length
  // and brightness breathe along the ring; the hue slides cyan<->violet.
  // Each stroke fades to nothing along its length (per-segment gradient) so
  // curtains dissolve upward instead of ending in hard-capped bars.
  {
    const a0 = Math.atan2(view.cy, view.cx);
    const span = (view.r >= camR ? Math.PI : Math.asin(view.r / camR)) + 0.02;
    // ~34u segments: neighbors differ so little in alpha that no seam shows
    // (90u steps drew visible Mach-band stripes); capped at ~120 segments
    const step = Math.max(34 / CFG.WORLD_R, span / 60);
    ctx.globalCompositeOperation = 'lighter';
    // width EXACTLY abuts adjacent strokes: any overlap double-brightens
    // under 'lighter' and bands the curtain into stripes; the rays diverge
    // outward but the gradient tips hide those hairline gaps
    ctx.lineWidth = step * CFG.WORLD_R;
    // Foot alpha is CONSTANT along the arc (it breathes in time only): any
    // per-segment alpha step reads as a Mach-band stripe between the flat
    // 50px bars. All spatial variation lives in curtain LENGTH — the
    // gradient falloff turns smooth length waves into smooth brightness
    // waves at every height, with nothing left to band.
    const alpha = 0.13 + 0.03 * Math.sin(t * 0.37);
    // snap the first segment to the step grid: segments must be
    // world-anchored, or the per-frame re-quantization of the wave field
    // crawls visibly as the camera pans along the wall
    const aStart = Math.floor((a0 - span) / step) * step;
    for (let a = aStart; a <= a0 + span; a += step) {
      // wave periods tuned to the ~400u arc a gameplay screen spans —
      // curtain heights must visibly vary across ONE screen of wall
      const n = 0.5 + 0.5 * Math.sin(a * 430 + t * 0.5) * Math.sin(a * 127 - t * 0.21 + 1.7);
      const mix = 0.5 + 0.5 * Math.sin(a * 160 + t * 0.13);
      // rare tall pillars: a shaft of light reaching deep into the fog —
      // a landmark you can steer by, maybe one per few screens of wall
      const p = Math.max(0, Math.sin(a * 37 + t * 0.07) - 0.86) / 0.14;
      // ragged feet: each curtain roots at its OWN radius, weaving in and
      // out across the warning band, and its alpha rises from ZERO at the
      // foot. A shared exact start radius (even at soft constant alpha)
      // reads as a hard drawn line — the user rejected that twice.
      // foot weave is LOW frequency and the alpha rise is LONG (peak at a
      // third of the stroke): neighbors must agree closely on brightness at
      // every radius, or the steep rise region stair-steps between segments
      const fw = 0.5 * Math.sin(a * 130 + t * 0.09) + 0.5 * Math.sin(a * 47 - t * 0.05 + 0.9);
      const foot = CFG.WORLD_R - 180 + 260 * fw;
      const len = 420 + 900 * n + 1400 * p;
      const cr = Math.round(lerp(140, 185, mix));
      const cg = Math.round(lerp(215, 160, mix));
      const ca = Math.cos(a), sa = Math.sin(a);
      const fx = ca * foot, fy = sa * foot;
      const tx = ca * (foot + len), ty = sa * (foot + len);
      // smooth rise-and-fall profile: peaks land at different radii per
      // segment (foot and length both vary), so no coherent bright ridge —
      // and no Mach contour, the slope never breaks hard
      const lg = ctx.createLinearGradient(fx, fy, tx, ty);
      lg.addColorStop(0, `rgba(${cr}, ${cg}, 255, 0)`);
      lg.addColorStop(0.32, `rgba(${cr}, ${cg}, 255, ${alpha * 0.75})`);
      lg.addColorStop(0.55, `rgba(${cr}, ${cg}, 255, ${alpha * 0.5})`);
      lg.addColorStop(0.78, `rgba(${cr}, ${cg}, 255, ${alpha * 0.2})`);
      lg.addColorStop(1, `rgba(${cr}, ${cg}, 255, 0)`);
      ctx.strokeStyle = lg;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1;   // the fat curtain width must not leak downstream
  }

  // The dust field — the body of the cloud (two counter-drifting layers:
  // fine grains + tumbling small shards)
  drawOortDust(game, 34, 0.0011, false);
  drawOortDust(game, 90, -0.0007, true);

  // There is deliberately NO drawn boundary line — and no shared edge of
  // any kind at WORLD_R: a crisp stroke read as a UI ring, and even a soft
  // glow starting at one exact radius read as a hard line (the user
  // rejected both — don't reintroduce either). The grind radius is legible
  // from natural cues only: curtain feet weaving through the warning band,
  // dust density smoothstepping up across it, flurries starting early, and
  // the frost vignette + OORT warnings carrying the gameplay alarm.

  // Hero shards: drift along their shells, tumble in place. Ghost masses are
  // dim silhouettes in the deep fog; bergs get a rim and a kiss of sunlight
  // on their inner face; crystals throw a rare glint.
  for (const p of oortShards) {
    const a = p.th + p.w * t;
    const x = Math.cos(a) * p.r, y = Math.sin(a) * p.r;
    const m = p.size * 2 + 8;
    if (x < view.x0 - m || x > view.x1 + m || y < view.y0 - m || y > view.y1 + m) continue;
    const rot = p.rot + p.spin * t;
    const n = p.verts.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const va = rot + (i / n) * TAU;
      const vr = p.size * p.verts[i];
      const px = x + Math.cos(va) * vr, py = y + Math.sin(va) * vr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (p.kind === 'ghost') {
      ctx.fillStyle = `rgba(140, 175, 225, ${p.b * 0.28})`;
      ctx.fill();
      continue;
    }
    ctx.fillStyle = `rgba(196, 222, 255, ${p.b * 0.8})`;
    ctx.fill();
    if (p.kind === 'berg') {
      ctx.strokeStyle = `rgba(228, 242, 255, ${p.b * 0.55})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      // sunward kiss: the inner face catches the far sun
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255, 236, 200, ${p.b * 0.1})`;
      ctx.beginPath();
      ctx.arc(x - Math.cos(a) * p.size * 0.45, y - Math.sin(a) * p.size * 0.45, p.size * 0.62, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else if (p.kind === 'crystal') {
      const tw = Math.sin(t * p.gs + p.gp);
      if (tw > 0.98) {   // a crystal catching the light for a blink
        const k = (tw - 0.98) / 0.02;
        const gl = p.size * (1.5 + k * 2);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(230, 246, 255, ${k * 0.8})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x - gl, y); ctx.lineTo(x + gl, y);
        ctx.moveTo(x, y - gl); ctx.lineTo(x, y + gl);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // Inside the wall the grind becomes visible: ice grains on a hashed world
  // grid streak past, smeared opposite the ship's motion — billboard smears,
  // not objects. Fades in over the last stretch of the approach.
  const s = game.ship;
  if (s.alive) {
    const depth = Math.min(1, (Math.hypot(s.x, s.y) - CFG.WORLD_R + 150) / 900);
    const spd = Math.hypot(s.vx, s.vy);
    if (depth > 0 && spd > 40) {
      const cell = 130;
      const sm = Math.min(64, spd * 0.07);
      const ux = -s.vx / spd * sm, uy = -s.vy / spd * sm;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 2;
      const ix0 = Math.floor(view.x0 / cell), ix1 = Math.ceil(view.x1 / cell);
      const iy0 = Math.floor(view.y0 / cell), iy1 = Math.ceil(view.y1 / cell);
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
        let h = (ix * 73856093) ^ (iy * 19349663);
        h = ((h ^ (h >> 13)) * 1274126177) & 0x7fffffff;
        if ((h & 7) > 2) continue;   // ~3/8 of cells hold a grain
        const gx = (ix + (h % 97) / 97) * cell, gy = (iy + ((h >> 7) % 97) / 97) * cell;
        ctx.strokeStyle = `rgba(210, 235, 255, ${depth * (0.1 + ((h >> 3) & 3) * 0.05)})`;
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + ux, gy + uy); ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

// Asteroids are jagged polygons, not discs — and the bigger the rock, the
// craggier the silhouette (pebbles stay nearly round, boulders are gnarled).
// The vertex offsets are generated once per body, keyed off its id, and
// regenerated if the radius changes (chip damage shrinks rocks).
function traceAsteroid(b) {
  if (!b.jag || b.jagR !== b.radius) {
    if (b.carved) {
      // The carved stone: a perfect hexagon — machined, not tumbled
      b.jag = [1, 1, 1, 1, 1, 1];
      b.jagR = b.radius;
    } else {
      const t = Math.min(1, Math.max(0, (b.radius - 3) / 27));   // 0 pebble -> 1 boulder
      const n = 7 + Math.min(9, Math.round(b.radius * 0.45));
      const amp = 0.06 + 0.3 * t;
      const rng = mulberry32(b.id * 7919 + 13);
      const pts = [];
      for (let i = 0; i < n; i++) pts.push(1 - amp + rng() * amp * 2);
      b.jag = pts; b.jagR = b.radius;
    }
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
  // frameStars is rebuilt each frame in beginFrame — looping all bodies here
  // made this O(bodies) per drawn body
  let best = null, bestD2 = Infinity;
  for (const b of frameStars) {
    const d2 = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (d2 < bestD2) { best = b; bestD2 = d2; }
  }
  return best;
}

function drawBody(game, b) {
  // Moons announce themselves: a whisper-faint orbit circle around their
  // planet and a bright icy outline — no more confusing them with asteroids.
  // Only while actually riding the rail: a captured or knocked-loose moon
  // isn't following that circle anymore, so it gets no ring.
  if (b.type === 'moon' && b.onRails && b.parent && b.parent.alive) {
    const rl = b.rail;
    ctx.strokeStyle = 'rgba(180, 200, 255, 0.045)';
    ctx.lineWidth = 1.5 / game.cam.zoom;
    ctx.beginPath();
    if (rl.e > 0) {
      // ellipse guide: the parent sits at a focus, so the traced ellipse is
      // offset from it by c = a*e along the apsidal line
      const c = rl.a * rl.e;
      ctx.ellipse(rl.parent.x - c * rl.ca, rl.parent.y - c * rl.sa, rl.a, rl.smin, rl.arg, 0, TAU);
    } else {
      ctx.arc(rl.parent.x, rl.parent.y, rl.r, 0, TAU);
    }
    ctx.stroke();
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
    // Intense layered corona — the glow itself warns of the heat zone
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.2, b.x, b.y, b.radius * 3.6);
    g.addColorStop(0, b.color);
    g.addColorStop(0.24, b.color + 'dd');
    g.addColorStop(0.4, b.color + '44');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 3.6, 0, TAU); ctx.fill();
    // PROMINENCE LOOPS: plasma arcs that rise off the surface and dive
    // BACK IN — closed magnetic loops, the way real suns wear their fire.
    // Each loop breathes slowly on its own rhythm (see "way slower" note).
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const a0 = (i / 7) * TAU + b.id + Math.sin(game.time * 0.03 + i * 2.1) * 0.1;
      const span = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(i * 1.9 + game.time * 0.045));
      const a1 = a0 + span;
      const h = b.radius * (0.08 + 0.24 * (0.5 + 0.5 * Math.sin(game.time * (0.06 + (i % 3) * 0.025) + i * 2.6)));
      const R0 = b.radius * 0.93;
      const x0 = b.x + Math.cos(a0) * R0, y0 = b.y + Math.sin(a0) * R0;
      const x1 = b.x + Math.cos(a1) * R0, y1 = b.y + Math.sin(a1) * R0;
      const am = a0 + span / 2;
      const cxp = b.x + Math.cos(am) * (R0 + h * 2), cyp = b.y + Math.sin(am) * (R0 + h * 2);
      // soft wide halo of the arc, then the bright filament inside it
      ctx.strokeStyle = 'rgba(255, 150, 60, 0.2)';
      ctx.lineWidth = b.radius * 0.045;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cxp, cyp, x1, y1); ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 220, 140, 0.38)';
      ctx.lineWidth = b.radius * 0.016;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cxp, cyp, x1, y1); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';

    // Photosphere: NOT a perfect circle — a slow magma swell, three faint
    // radial harmonics breathing at different rates (subtle: <2% of radius)
    const surf = (th) => b.radius * 0.94 * (1
      + 0.016 * Math.sin(th * 5 + game.time * 0.18)
      + 0.011 * Math.sin(th * 9 - game.time * 0.28)
      + 0.007 * Math.sin(th * 13 + game.time * 0.42));
    const tracePhotosphere = () => {
      ctx.beginPath();
      const N = 64;
      for (let i2 = 0; i2 <= N; i2++) {
        const th = (i2 / N) * TAU;
        const rr2 = surf(th);
        const px2 = b.x + Math.cos(th) * rr2, py2 = b.y + Math.sin(th) * rr2;
        if (i2 === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
      }
      ctx.closePath();
    };
    // Feathered rim: a screen-space shadow glow softens the surface edge
    // into the corona instead of a hard vector cut (reset immediately)
    ctx.shadowColor = '#fff3d0';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#fff3d0';
    tracePhotosphere(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save();
    tracePhotosphere(); ctx.clip();
    // LAVA-LAMP convection: bright cells churning slowly across the face —
    // each drifts on its own slow epicycle, swelling and shrinking
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const a = game.time * (0.016 + (i % 3) * 0.008) + i * 2.39 + b.id;
      const rr = b.radius * (0.18 + 0.5 * (0.5 + 0.5 * Math.sin(game.time * 0.022 + i * 1.7)));
      const bx = b.x + Math.cos(a) * rr, by = b.y + Math.sin(a * 0.83 + i) * rr;
      const br = b.radius * (0.24 + 0.1 * Math.sin(game.time * 0.035 + i * 2.1));
      const cg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      cg.addColorStop(0, 'rgba(255, 246, 214, 0.5)');
      cg.addColorStop(0.6, 'rgba(255, 196, 110, 0.26)');
      cg.addColorStop(1, 'transparent');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    // Sunspots: dark blemishes wandering the photosphere
    for (let j = 0; j < 4; j++) {
      const a = game.time * (0.01 + j * 0.0035) + j * 1.83 + b.id * 3;
      const rr = b.radius * (0.25 + 0.45 * (0.5 + 0.5 * Math.sin(j * 2.7 + game.time * 0.016)));
      const px = b.x + Math.cos(a) * rr, py = b.y + Math.sin(a * 1.13 + j * 0.9) * rr;
      const sr = b.radius * (0.1 + 0.09 * (j % 3));
      const sg = ctx.createRadialGradient(px, py, 0, px, py, sr);
      sg.addColorStop(0, 'rgba(120, 55, 20, 0.5)');
      sg.addColorStop(0.55, 'rgba(160, 80, 30, 0.28)');
      sg.addColorStop(1, 'transparent');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(px, py, sr, 0, TAU); ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (b.ring) {
    // ringDecay (shepherd stolen/smashed): the ring blurs outward and fades —
    // wider, dimmer strokes read as the lanes scattering
    const decay = b.ringDecay || 0;
    ctx.globalAlpha = 0.4 * (1 - decay * 0.8);
    ctx.strokeStyle = b.color;
    if (b.ringGap) {
      // Shepherded ring: two crisp bands with a swept gap between them
      const lw = b.radius * 0.13 * (1 + decay * 2.2);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.radius * 1.72, b.radius * 0.53, b.rot * 0.15, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.radius * 2.14, b.radius * 0.66, b.rot * 0.15, 0, TAU);
      ctx.stroke();
    } else {
      ctx.lineWidth = b.radius * 0.34 * (1 + decay * 1.4);
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.radius * 2.0, b.radius * 0.62, b.rot * 0.15, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Lava worlds glow — visible even when zoomed way out
  if (b.ptype === 'lava') {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.5, b.x, b.y, b.radius * 2.2);
    g.addColorStop(0, 'rgba(255, 110, 40, 0.4)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.2, 0, TAU); ctx.fill();
  }

  // Comets stream an icy tail behind them. Comet Vesper instead grows a
  // physically-honest ANTI-SUNWARD tail that blooms as it falls toward
  // perihelion (and flares brighter when a solar storm front washes over it).
  if (b.comet) {
    let tx, ty, alpha = 0.55, width = b.radius * 1.4;
    if (b.majorComet) {
      const sun = nearestStar(game, b.x, b.y);
      const dx = b.x - (sun ? sun.x : 0), dy = b.y - (sun ? sun.y : 0);
      const dSun = Math.hypot(dx, dy) || 1;
      const heat = Math.max(0.05, 1 - dSun / 15000);
      let boost = 1;
      if (game.storm && Math.abs(dSun - game.storm.r) < CFG.STORM_BAND * 1.4) boost = 1.7;
      const len = b.radius * (5 + 29 * heat) * boost;
      tx = b.x + (dx / dSun) * len; ty = b.y + (dy / dSun) * len;
      alpha = (0.3 + 0.5 * heat) * Math.min(1, boost);
      width = b.radius * (1.4 + 1.6 * heat);
      // Coma: the bright head halo that makes it read as THE comet
      const cg = ctx.createRadialGradient(b.x, b.y, b.radius * 0.4, b.x, b.y, b.radius * (2.5 + 3.5 * heat));
      cg.addColorStop(0, `rgba(220, 245, 255, ${0.4 + 0.3 * heat})`);
      cg.addColorStop(1, 'transparent');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * (2.5 + 3.5 * heat), 0, TAU); ctx.fill();
    } else {
      const vm = Math.hypot(b.vx, b.vy) || 1;
      tx = b.x - (b.vx / vm) * b.radius * 9; ty = b.y - (b.vy / vm) * b.radius * 9;
    }
    const tg = ctx.createLinearGradient(b.x, b.y, tx, ty);
    tg.addColorStop(0, `rgba(170, 235, 255, ${alpha})`);
    tg.addColorStop(1, 'transparent');
    ctx.strokeStyle = tg;
    ctx.lineWidth = width;
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

  // DEAD STOP prime (hauler): a caught counterpunch rock smolders — a steady
  // ember halo (real object state -> solid/gradient, never dashed) that reads
  // "this one is loaded" until the fling consumes it.
  if (b.primed) {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.6, b.x, b.y, b.radius * 2.2);
    g.addColorStop(0, 'rgba(255, 170, 90, 0.45)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.2, 0, TAU); ctx.fill();
  }

  // The Forge Moon smolders — a small lava-style glow so it reads as alive
  if (b.volcanic) {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.5, b.x, b.y, b.radius * 2.0);
    g.addColorStop(0, 'rgba(255, 120, 45, 0.35)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.0, 0, TAU); ctx.fill();
  }

  ctx.fillStyle = b.color;
  if (b.visitor) {
    drawVisitorSprite(b);
  } else if (b.cache) {
    drawCacheSprite(game, b);
  } else if (b.core) {
    drawCoreSprite(game, b);
  } else if (b.type === 'asteroid') {
    traceAsteroid(b);
    ctx.fill();
    if (b.cored) drawCoreGlint(game, b);
  } else if (b.ghost) {
    drawGhostSprite(game, b);
  } else if (b.type === 'station') {
    drawStationSprite(b);
  } else if (b.type === 'nest') {
    drawNestSprite(game, b);
  } else {
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.fill();
  }

  if (b.type === 'planet' && b.ptype) drawPlanetDetail(b);
  if (b.landmark === 'geysers') drawGeyserPlumes(game, b);
  if (b.ember > 0.01) drawEmberReef(game, b);
  if (b.fort) drawFort(game, b);

  if (b.type === 'moon') drawMoonDetail(game, b);

  // Asteroid texture: darker pits keyed off the id, clipped to the silhouette
  // (the carved stone gets clean facet lines instead — no pits on machined work)
  if (b.type === 'asteroid' && b.carved) {
    ctx.strokeStyle = 'rgba(225, 235, 245, 0.4)';
    ctx.lineWidth = Math.max(0.8, b.radius * 0.06);
    ctx.beginPath();
    for (let i = 0; i < 6; i += 2) {
      const a = b.rot + (i / 6) * TAU;
      ctx.moveTo(b.x + Math.cos(a) * b.radius, b.y + Math.sin(a) * b.radius);
      ctx.lineTo(b.x - Math.cos(a) * b.radius, b.y - Math.sin(a) * b.radius);
    }
    ctx.stroke();
  } else if (b.type === 'asteroid' && !b.visitor) {
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

  // MOONSHADOW eclipse: the world dims under its moon's shadow, with a warm
  // rim so it reads as an eclipse rather than damage
  if (b.eclipseT > 0) {
    const k = Math.min(1, b.eclipseT / 0.5);
    ctx.fillStyle = `rgba(2, 4, 14, ${0.42 * k})`;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(255, 225, 170, ${0.3 * k})`;
    ctx.lineWidth = Math.max(1.2, 2 / game.cam.zoom);
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.stroke();
  }

  // AURORA: solid shimmering rim arcs on the night side while a solar-storm
  // front washes over the world. Event-driven motion — it fades in seconds.
  if (b.auroraT > 0 && st) {
    const k = Math.min(1, b.auroraT / 2) * (0.7 + 0.3 * Math.sin(game.time * 2.3 + b.id));
    const ang = Math.atan2(b.y - st.y, b.x - st.x);   // night side faces away
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const rr = b.radius * (1.06 + i * 0.055);
      ctx.strokeStyle = i === 1
        ? `rgba(150, 255, 200, ${0.30 * k})`
        : `rgba(110, 220, 255, ${0.22 * k})`;
      ctx.lineWidth = Math.max(1.5, b.radius * 0.045);
      const wob = Math.sin(game.time * 1.7 + i * 2 + b.id) * 0.18;
      ctx.beginPath(); ctx.arc(b.x, b.y, rr, ang - 0.85 + wob, ang + 0.85 + wob); ctx.stroke();
    }
    ctx.lineCap = 'butt';
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
    if (armedSet && armedSet.has(b)) {
      // Armed for the shotgun: hot amber, pulsing
      const pulse = 0.6 + 0.4 * Math.sin(game.time * 9);
      ctx.strokeStyle = `rgba(255, 200, 90, ${0.5 + 0.4 * pulse})`;
      ctx.lineWidth = 2 / game.cam.zoom;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 6 / game.cam.zoom, 0, TAU); ctx.stroke();
    } else {
      // Barely-there by default; brightens as the cursor approaches so you
      // can see which orbiter a click would pull back
      const dc = Math.hypot(b.x - game.aim.x, b.y - game.aim.y);
      const near = Math.max(0, 1 - dc / 420);
      ctx.strokeStyle = `rgba(130, 255, 200, ${0.12 + 0.5 * near})`;
      ctx.lineWidth = 1.5 / game.cam.zoom;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 5 / game.cam.zoom, 0, TAU); ctx.stroke();
    }
  }
}

// Per-archetype surface detail, drawn clipped to the planet disc. This is
// what makes the planet TYPES readable: bands = gas, cracks+glow = lava,
// caps = ice, continents = rocky.
function drawPlanetDetail(b) {
  ctx.save();
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.clip();
  ctx.translate(b.x, b.y);
  // The surface turns under the fixed star-lit terminator (drawn after this in
  // drawBody) — that rotation IS the day/night cycle. Ice caps are polar, so
  // they stay put; everything else rides b.rot.
  if (b.ptype !== 'ice') ctx.rotate(b.rot);

  if (b.ptype === 'gas') {
    ctx.rotate(b.id % 2 ? 0.32 : -0.26);
    const n = 5 + (b.id % 3);
    const bandH = (2 * b.radius) / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.17)';
      ctx.fillRect(-b.radius, -b.radius + i * bandH, b.radius * 2, bandH * 0.72);
    }
    if (b.landmark === 'storm') {
      // THE GREAT EYE — the system's landmark storm, big enough to steer by
      ctx.fillStyle = 'rgba(200, 60, 40, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-b.radius * 0.28, b.radius * 0.2, b.radius * 0.44, b.radius * 0.21, 0.25, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 235, 215, 0.45)';
      ctx.lineWidth = Math.max(1.5, b.radius * 0.025);
      ctx.beginPath();
      ctx.ellipse(-b.radius * 0.28, b.radius * 0.2, b.radius * 0.5, b.radius * 0.26, 0.25, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 190, 160, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-b.radius * 0.24, b.radius * 0.18, b.radius * 0.17, b.radius * 0.08, 0.25, 0, TAU);
      ctx.fill();
    } else {
      // A great storm spot
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.ellipse(b.radius * 0.34, b.radius * 0.3, b.radius * 0.2, b.radius * 0.1, 0.3, 0, TAU);
      ctx.fill();
    }
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
    // Scattered blue-white plains ride the spin (so the world visibly turns)…
    ctx.save();
    ctx.rotate(b.rot);
    ctx.fillStyle = 'rgba(180, 215, 240, 0.35)';
    for (let i = 0; i < 4; i++) {
      const a = b.id * 1.7 + i * 1.9;
      const rr = b.radius * (0.22 + ((b.id + i) % 3) * 0.09);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * b.radius * 0.45, Math.sin(a) * b.radius * 0.45, rr, rr * 0.7, a, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // …but the polar caps stay pinned to the poles (spin axis is vertical)
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
    if (b.landmark === 'crater') {
      // THE SCAR — a giant impact basin with bright ejecta rays
      const cx = b.radius * 0.28, cy = -b.radius * 0.24;
      ctx.fillStyle = 'rgba(235, 240, 250, 0.26)';
      ctx.beginPath(); ctx.arc(cx, cy, b.radius * 0.3, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(235, 240, 250, 0.3)';
      ctx.lineWidth = Math.max(1.2, b.radius * 0.025);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.3;
        ctx.moveTo(cx + Math.cos(a) * b.radius * 0.32, cy + Math.sin(a) * b.radius * 0.32);
        ctx.lineTo(cx + Math.cos(a) * b.radius * (0.6 + (i % 3) * 0.18),
          cy + Math.sin(a) * b.radius * (0.6 + (i % 3) * 0.18));
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Per-archetype moon surface, drawn clipped to the disc and seeded off b.id so
// it's stable frame to frame. Keyed off b.moonType (world.js MOON_TYPES): ice
// fractures, iron sheen, sulfur mottle, banded stripes, else cratered rock —
// this is what makes a moon family read as distinct little worlds.
function drawMoonDetail(game, b) {
  const R = b.radius;
  ctx.save();
  ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.clip();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);   // surface turns under the fixed terminator → day/night
  const craters = (n) => {
    for (let i = 0; i < n; i++) {
      const a = b.id * 1.3 + i * 2.399;
      const dist = (((b.id * 7 + i * 53) % 100) / 100) * 0.72;
      const cr = R * (0.12 + ((b.id + i) % 4) * 0.055);
      const cx = Math.cos(a) * R * dist, cy = Math.sin(a) * R * dist;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath(); ctx.arc(cx - cr * 0.25, cy - cr * 0.25, cr * 0.7, 0, TAU); ctx.fill();
    }
  };
  if (b.moonType === 'ice') {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (let i = 0; i < 3; i++) {
      const a = b.id * 1.7 + i * 2.2;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4, R * 0.34, R * 0.22, a, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(180,220,255,0.5)';
    ctx.lineWidth = Math.max(0.8, R * 0.05);
    for (let i = 0; i < 3; i++) {
      const a = b.id + i * 2.1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9);
      ctx.lineTo(-Math.cos(a + 0.4) * R * 0.9, -Math.sin(a + 0.4) * R * 0.9);
      ctx.stroke();
    }
  } else if (b.moonType === 'iron') {
    craters(2);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.ellipse(-R * 0.3, -R * 0.3, R * 0.5, R * 0.28, -0.6, 0, TAU); ctx.fill();
  } else if (b.moonType === 'sulfur') {
    for (let i = 0; i < 5; i++) {
      const a = b.id * 1.9 + i * 1.6;
      const rr = R * (0.2 + ((b.id + i) % 3) * 0.1);
      ctx.fillStyle = i % 2 ? 'rgba(120,70,20,0.30)' : 'rgba(255,220,120,0.22)';
      ctx.beginPath(); ctx.ellipse(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, rr, rr * 0.7, a, 0, TAU); ctx.fill();
    }
  } else if (b.moonType === 'banded') {
    ctx.rotate(b.id % 2 ? 0.3 : -0.24);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)';
      ctx.fillRect(-R, -R + i * R * 0.7, R * 2, R * 0.5);
    }
  } else {
    craters(b.moonType === 'dust' ? 5 : 3);
  }
  ctx.restore();
  // Subtle tinted rim — dimmer than the old flat bright ring
  ctx.strokeStyle = 'rgba(210, 224, 245, 0.35)';
  ctx.lineWidth = Math.max(0.8, 1.1 / game.cam.zoom);
  ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.stroke();
}

// A cored rock: a mineral vein glinting through the shell so prospectors can
// spot which rocks are worth cracking.
function drawCoreGlint(game, b) {
  const a = b.rot * 0.5 + b.id;
  const gx = b.x + Math.cos(a) * b.radius * 0.35, gy = b.y + Math.sin(a) * b.radius * 0.35;
  const tw = 0.55 + 0.45 * Math.sin(game.time * 3 + b.id);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(190,150,255,${0.5 * tw})`;
  ctx.beginPath(); ctx.arc(gx, gy, Math.max(0.8, b.radius * 0.24), 0, TAU); ctx.fill();
  ctx.restore();
}

// The freed core: a glowing faceted crystal — clearly premium salvage
function drawCoreSprite(game, b) {
  const r = b.radius;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
  g.addColorStop(0, 'rgba(185,140,255,0.5)'); g.addColorStop(1, 'rgba(185,140,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 2.6, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.rotate(b.rot);
  ctx.fillStyle = b.color; ctx.strokeStyle = 'rgba(232,214,255,0.9)'; ctx.lineWidth = Math.max(0.6, r * 0.12);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU, rr = r * (i % 2 ? 0.72 : 1.12);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = Math.max(0.5, r * 0.06);
  ctx.beginPath(); ctx.moveTo(0, -r * 1.0); ctx.lineTo(0, r * 0.72); ctx.moveTo(-r * 0.9, 0); ctx.lineTo(r * 0.9, 0); ctx.stroke();
  ctx.restore();
}

// Derelict cargo canister with a pulsing amber salvage light
function drawCacheSprite(game, b) {
  const r = b.radius;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot * 0.4);
  ctx.fillStyle = b.color;
  ctx.strokeStyle = 'rgba(40,55,72,0.9)'; ctx.lineWidth = Math.max(0.6, r * 0.14);
  const w = r * 1.5, h = r * 1.05;
  ctx.beginPath(); ctx.rect(-w, -h, w * 2, h * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(40,55,72,0.7)'; ctx.lineWidth = Math.max(0.5, r * 0.1);
  ctx.beginPath();
  ctx.moveTo(-w * 0.4, -h); ctx.lineTo(-w * 0.4, h);
  ctx.moveTo(w * 0.4, -h); ctx.lineTo(w * 0.4, h); ctx.stroke();
  const tw = 0.5 + 0.5 * Math.sin(game.time * 2.5 + b.id);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(255,190,90,${0.4 + 0.4 * tw})`;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, TAU); ctx.fill();
  ctx.restore();
}

// Glow pockets (glow.js): sun-orbiting clusters of HEALING motes. A faint green
// pool marks a pocket from range (the only mid-life heal — worth spotting); each
// mote is an additive biolum spark with a soft corona. Healing-green palette so
// it reads as "mend here". Additive pass, closed by save/restore (canvas rule).
function drawGlow(game) {
  const pockets = game.glowPockets;
  if (!pockets || !pockets.length) return;
  const m = PROG.GLOW_SPREAD + 80;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of pockets) {
    if (!p.motes.length) continue;
    if (p.cx < view.x0 - m || p.cx > view.x1 + m || p.cy < view.y0 - m || p.cy > view.y1 + m) continue;
    // Cluster halo — a soft green pool that marks the pocket from afar. Constant
    // breathe speed, so time*speed is safe here (no phase teleport).
    const breathe = 0.5 + 0.5 * Math.sin(game.time * 1.3 + p.ang * 7);
    const R = PROG.GLOW_SPREAD * 1.15;
    const pool = ctx.createRadialGradient(p.cx, p.cy, 0, p.cx, p.cy, R);
    pool.addColorStop(0, `rgba(120, 255, 175, ${0.08 + 0.05 * breathe})`);
    pool.addColorStop(1, 'rgba(120, 255, 175, 0)');
    ctx.fillStyle = pool;
    ctx.beginPath(); ctx.arc(p.cx, p.cy, R, 0, TAU); ctx.fill();
    for (const c of p.motes) {
      const cx = p.cx + c.lx;
      const cy = p.cy + c.ly;
      const pulse = 0.55 + 0.45 * Math.sin(c.ph);
      const r = c.sz * (1.4 + 0.4 * pulse);
      const col = `hsla(${c.hue | 0}, 90%, 70%,`;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 5);
      g.addColorStop(0, col + (0.5 * pulse) + ')'); g.addColorStop(1, col + '0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r * 5, 0, TAU); ctx.fill();
      ctx.fillStyle = col + '0.95)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

// The interstellar visitor: an elongated reddish shard, clearly no local rock
function drawVisitorSprite(b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  const r = b.radius;
  ctx.fillStyle = b.color;
  ctx.beginPath();
  ctx.moveTo(r * 2.3, 0);
  ctx.lineTo(r * 0.7, -r * 0.75);
  ctx.lineTo(-r * 1.9, -r * 0.5);
  ctx.lineTo(-r * 2.3, 0);
  ctx.lineTo(-r * 1.6, r * 0.6);
  ctx.lineTo(r * 0.9, r * 0.7);
  ctx.closePath();
  ctx.fill();
  // metallic sheen along the sunning edge
  ctx.strokeStyle = 'rgba(255, 220, 180, 0.5)';
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.beginPath();
  ctx.moveTo(r * 2.1, -r * 0.06);
  ctx.lineTo(r * 0.7, -r * 0.68);
  ctx.lineTo(-r * 1.8, -r * 0.44);
  ctx.stroke();
  ctx.restore();
}

// The ghost ship: a long dead hull with a snapped keel and one slow
// heartbeat light — the thing the sonar ping belongs to
function drawGhostSprite(game, b) {
  const r = b.radius;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  ctx.fillStyle = '#39414c';
  ctx.beginPath();
  ctx.moveTo(r * 1.6, 0);
  ctx.lineTo(r * 0.3, -r * 0.55);
  ctx.lineTo(-r * 1.5, -r * 0.35);
  ctx.lineTo(-r * 1.2, r * 0.15);
  ctx.lineTo(-r * 1.7, r * 0.5);
  ctx.lineTo(r * 0.4, r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#6b7684';
  ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.beginPath();
  for (let i = -1; i <= 1; i++) {
    ctx.moveTo(i * r * 0.5, -r * 0.45);
    ctx.lineTo(i * r * 0.5, r * 0.45);
  }
  ctx.stroke();
  // slow heartbeat running light (matches the audible ping cadence loosely)
  const lit = Math.sin(game.time * 1.8) > 0.92;
  ctx.fillStyle = lit ? '#ff6a5a' : '#4a2e2c';
  ctx.beginPath(); ctx.arc(r * 0.9, 0, Math.max(2, r * 0.12), 0, TAU); ctx.fill();
  ctx.restore();
}

// Cryo-geyser plumes on the geyser landmark world: fixed vents, breathing
// slowly — drawn OUTSIDE the planet clip so the plumes reach into space
function drawGeyserPlumes(game, b) {
  for (let i = 0; i < 3; i++) {
    const a = b.rot * 0.3 + b.id + i * 2.1;
    const puff = 0.5 + 0.5 * Math.sin(game.time * 0.9 + i * 2.4);
    if (puff < 0.18) continue;
    const len = b.radius * (0.35 + 0.5 * puff);
    const bx = b.x + Math.cos(a) * b.radius, by = b.y + Math.sin(a) * b.radius;
    const tx = b.x + Math.cos(a) * (b.radius + len), ty = b.y + Math.sin(a) * (b.radius + len);
    const g = ctx.createLinearGradient(bx, by, tx, ty);
    g.addColorStop(0, `rgba(230, 250, 255, ${0.45 * puff})`);
    g.addColorStop(1, 'transparent');
    ctx.strokeStyle = g;
    ctx.lineWidth = b.radius * (0.1 + 0.08 * puff);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.lineCap = 'butt';
  }
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

// Bastion fortifications: the mech race has built OVER the world — armor
// plating and hazard lights on the surface, aimed twin-barrel gatling
// turrets, and an unmissable energy shield bubble.
function drawFort(game, b) {
  const f = b.fort;
  const s = game.ship;

  // Mechanized surface: armor girdle, panel seams, blinking hazard lights
  ctx.save();
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); ctx.clip();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot * 0.3);
  ctx.fillStyle = 'rgba(38, 46, 58, 0.85)';
  ctx.fillRect(-b.radius, -b.radius * 0.22, b.radius * 2, b.radius * 0.44);
  ctx.strokeStyle = 'rgba(120, 140, 165, 0.45)';
  ctx.lineWidth = Math.max(1, b.radius * 0.02);
  for (let i = -3; i <= 3; i++) {
    const x = i * b.radius * 0.3;
    ctx.beginPath(); ctx.moveTo(x, -b.radius); ctx.lineTo(x, b.radius); ctx.stroke();
  }
  for (let j = -2; j <= 2; j++) {
    const y = j * b.radius * 0.38;
    ctx.beginPath(); ctx.moveTo(-b.radius, y); ctx.lineTo(b.radius, y); ctx.stroke();
  }
  ctx.fillStyle = Math.sin(game.time * 3) > 0 ? '#ffb35c' : '#7a5828';
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.arc(i * b.radius * 0.42, 0, Math.max(1.5, b.radius * 0.035), 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // Gatling turrets: mounted on the surface, heads TRACK the ship
  const inRange = s.alive && Math.hypot(s.x - b.x, s.y - b.y) < 1900;
  for (const t of f.turrets) {
    const a = b.rot + t.ang;
    const tx = b.x + Math.cos(a) * b.radius * 0.98;
    const ty = b.y + Math.sin(a) * b.radius * 0.98;
    const aim = inRange ? Math.atan2(s.y - ty, s.x - tx) : a;
    const tr = Math.max(6, b.radius * 0.16);
    ctx.save();
    ctx.translate(tx, ty);
    // mount base
    ctx.fillStyle = '#242c38';
    ctx.beginPath(); ctx.arc(0, 0, tr * 0.85, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#4a5768';
    ctx.lineWidth = Math.max(1, tr * 0.12);
    ctx.stroke();
    // rotating twin-barrel head
    ctx.rotate(aim);
    ctx.fillStyle = '#4d5a6e';
    ctx.fillRect(0, -tr * 0.42, tr * 1.7, tr * 0.28);
    ctx.fillRect(0, tr * 0.14, tr * 1.7, tr * 0.28);
    ctx.fillStyle = '#141a24';
    ctx.beginPath(); ctx.arc(0, 0, tr * 0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffb35c';
    ctx.beginPath(); ctx.arc(0, 0, tr * 0.2, 0, TAU); ctx.fill();
    if (t.fireT > 0) {   // muzzle flash
      ctx.fillStyle = `rgba(255, 220, 140, ${t.fireT * 6})`;
      ctx.beginPath(); ctx.arc(tr * 1.85, 0, tr * 0.55, 0, TAU); ctx.fill();
    }
    // Breaking down: damaged turrets spark and gutter
    if (t.maxHp && t.hp < t.maxHp * 0.6 && Math.sin(game.time * 17 + t.ang * 9) > 0.2) {
      ctx.fillStyle = 'rgba(255, 120, 60, 0.85)';
      ctx.beginPath();
      ctx.arc(tr * (0.3 + Math.sin(game.time * 23) * 0.4), -tr * 0.3, tr * 0.22, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Shield: a volumetric bubble with a bright rim, counter-rotating hex
  // rings, and an expanding ripple on every hit
  if (f.shield > 0) {
    const frac = f.shield / f.maxShield;
    const flash = Math.max(0, f.hitT) * 2.2;
    const R = b.radius * 1.3;
    const g2 = ctx.createRadialGradient(b.x, b.y, R * 0.55, b.x, b.y, R);
    g2.addColorStop(0, 'rgba(90, 170, 255, 0.02)');
    g2.addColorStop(0.82, `rgba(100, 190, 255, ${0.10 + 0.10 * frac + flash * 0.2})`);
    g2.addColorStop(1, `rgba(150, 220, 255, ${0.28 + 0.30 * frac + flash * 0.4})`);
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
    ctx.lineWidth = Math.max(2, b.radius * 0.045);
    ctx.strokeStyle = `rgba(140, 210, 255, ${0.45 + 0.35 * frac + flash})`;
    ctx.setLineDash([b.radius * 0.28, b.radius * 0.1]);
    ctx.lineDashOffset = game.time * b.radius * 0.6;
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(120, 190, 255, ${0.25 + 0.25 * frac})`;
    ctx.setLineDash([b.radius * 0.14, b.radius * 0.18]);
    ctx.lineDashOffset = -game.time * b.radius * 0.9;
    ctx.beginPath(); ctx.arc(b.x, b.y, R * 1.05, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;   // animated offset must not leak into helper dashes
    if (f.hitT > 0) {
      const rip = 1 - f.hitT / 0.35;
      ctx.strokeStyle = `rgba(200, 240, 255, ${(1 - rip) * 0.8})`;
      ctx.lineWidth = Math.max(2, b.radius * 0.05);
      ctx.beginPath(); ctx.arc(b.x, b.y, R * (1 + rip * 0.25), 0, TAU); ctx.stroke();
    }
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
    const isPOI = b.type === 'station' || b.type === 'nest' || (b.fort && b.type === 'moon') ||
      b.majorComet || b.visitor || b.shepherd || b.volcanic;
    if (!isWorld && !isPOI) continue;
    const zone = isPOI && !isWorld ? (b.shepherd || b.volcanic ? 900 : 1400) : b.radius * 5 + 600;
    const d2 = (b.x - s.x) ** 2 + (b.y - s.y) ** 2;
    if (d2 > zone * zone) continue;
    const d = Math.sqrt(d2);
    const t = 1 - Math.max(0, (d - b.radius) / (zone - b.radius));  // 0 edge -> 1 surface
    const a = 0.15 + 0.55 * t;

    if (isWorld) {
      ctx.strokeStyle = `rgba(200, 220, 255, ${0.05 + 0.07 * t})`;
      ctx.lineWidth = 1.5 / z;
      ctx.beginPath(); ctx.arc(b.x, b.y, zone, 0, TAU); ctx.stroke();
    }

    const label = b.ghost ? (b.name || 'UNKNOWN HULK').toUpperCase()
      : (b.majorComet || b.visitor || b.shepherd || b.volcanic) ? (b.name || '').toUpperCase()
      : b.fort ? `BASTION FORTRESS${b.name ? ' — ' + b.name.toUpperCase() : ''}`
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

// DEFLECTOR PARRY: every frozen rock charges up. Aiming/helper UI, so DASHED
// strokes are correct here (design law): a charge ring contracting onto each
// rock over the window, and a flick arrow per rock showing the current hurl
// direction. The energy glow itself is a solid additive gradient (event
// motion — the parry IS an event, so animation is allowed).
function drawParry(game) {
  const p = game.parry;
  if (!p || !p.rocks.length) return;
  const z = game.cam.zoom;
  const prog = Math.min(1, p.t / Math.max(0.01, p.window));
  const fx = (game.mouseSX ?? 0) - p.mx0, fy = (game.mouseSY ?? 0) - p.my0;
  const mag = Math.hypot(fx, fy);
  const flicked = mag > 12;   // matches updateParry's aim dead-zone

  for (const r of p.rocks) {
    const b = r.b;
    if (!b.alive) continue;

    // Energy glow, swelling as the charge builds
    ctx.globalCompositeOperation = 'lighter';
    const gr = b.radius * (1.6 + 0.7 * prog);
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.3, b.x, b.y, gr);
    g.addColorStop(0, `rgba(159, 214, 255, ${0.25 + 0.3 * prog})`);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, gr, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Charge ring: contracts onto the rock as the window runs out
    const ringR = b.radius * (2.6 - 1.45 * prog);
    ctx.strokeStyle = 'rgba(159, 214, 255, 0.85)';
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([6 / z, 5 / z]);
    ctx.beginPath(); ctx.arc(b.x, b.y, ringR, 0, TAU); ctx.stroke();

    // Flick arrow: where THIS rock goes right now (flick = all together;
    // no flick = back out along its own capture bearing)
    const dx = flicked ? fx / mag : r.nx, dy = flicked ? fy / mag : r.ny;
    // Arrow length fills toward the REAL launch threshold — the player can
    // see how close their motion is to firing the throw.
    const len = b.radius + 34 / z + (Math.min(mag, PARRY_FLICK) / PARRY_FLICK) * 30 / z;
    const tipX = b.x + dx * len, tipY = b.y + dy * len;
    ctx.strokeStyle = flicked ? 'rgba(159, 214, 255, 0.95)' : 'rgba(159, 214, 255, 0.45)';
    ctx.lineWidth = 2.5 / z;
    ctx.setLineDash([8 / z, 6 / z]);
    ctx.beginPath();
    ctx.moveTo(b.x + dx * b.radius, b.y + dy * b.radius);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.setLineDash([]);
    // chevron head (solid — it's the arrow's tip, tiny)
    const side = 7 / z, ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(ang - 0.5) * side, tipY - Math.sin(ang - 0.5) * side);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(ang + 0.5) * side, tipY - Math.sin(ang + 0.5) * side);
    ctx.stroke();
  }
}

// DEFLECTABLE INDICATOR: a rock the parry field could catch — incoming on
// the nose, right mass class, field armed — carries a pulsing cyan circlet
// (dashed = helper UI) so the player knows "this one, you can take". The
// eligibility mirror of physics.parryEligible + the closing test; keep them
// in sync or the hint lies. Range is a readable notice bubble, far wider
// than the field itself, so the tell arrives BEFORE the catch.
function drawDeflectable(game) {
  const st = game.st, s = game.ship;
  if (!st.deflect || !s.alive || game.parryCd > 0) return;
  if (game.parry && game.parry.rocks.length >= st.deflect) return;   // no free slot
  const z = game.cam.zoom;
  const pulse = 0.55 + 0.45 * Math.sin(game.time * 9);
  const RANGE = 520;
  for (const b of game.bodies) {
    const dx = b.x - s.x, dy = b.y - s.y;
    if (dx * dx + dy * dy > RANGE * RANGE) continue;
    if (!b.alive || b.type !== 'asteroid' || b.majorComet || b.heldBy || b.parryFrozen ||
        (b.thrownBy === 'player' && b.thrownTimer > 0) || b.mass > st.capacity * 1.5) continue;
    const d = Math.hypot(dx, dy) || 0.001;
    const nx = dx / d, ny = dy / d;
    if (-((b.vx - s.vx) * nx + (b.vy - s.vy) * ny) <= 60) continue;         // not incoming
    if (Math.abs(angDiff(Math.atan2(dy, dx), s.angle)) > 1.05) continue;    // not in the front arc (PARRY_ARC)
    ctx.strokeStyle = `rgba(159, 214, 255, ${0.25 + 0.45 * pulse})`;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([4 / z, 4 / z]);
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 5 / z, 0, TAU); ctx.stroke();
  }
  ctx.setLineDash([]);
}

// Life pods: drifting extra-life collectibles (roguelite lives). A real object,
// so SOLID strokes — a soft green halo around a pulsing "+" cross.
function drawPickups(game) {
  if (!game.pickups || !game.pickups.length) return;
  const z = game.cam.zoom;
  for (const p of game.pickups) {
    if (p.x < view.x0 - 80 || p.x > view.x1 + 80 || p.y < view.y0 - 80 || p.y > view.y1 + 80) continue;
    const pulse = 0.7 + 0.3 * Math.sin(game.time * 4 + (p.phase || 0));
    const R = 26;
    const halo = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, R * 1.7);
    halo.addColorStop(0, `rgba(120, 255, 170, ${0.32 * pulse})`);
    halo.addColorStop(1, 'transparent');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(p.x, p.y, R * 1.7, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(150, 255, 190, ${0.7 + 0.3 * pulse})`;
    ctx.lineWidth = 2.5 / z;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.stroke();
    // "+" cross
    const a = R * 0.5;
    ctx.lineWidth = 3.5 / z;
    ctx.beginPath();
    ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y);
    ctx.moveTo(p.x, p.y - a); ctx.lineTo(p.x, p.y + a);
    ctx.stroke();
  }
}

function drawShipRings(game) {
  const s = game.ship;
  if (!s.alive) return;
  const z = game.cam.zoom;

  ctx.strokeStyle = 'rgba(90, 180, 255, 0.14)';
  ctx.lineWidth = 1.5 / z;
  ctx.setLineDash([5 / z, 11 / z]);
  ctx.beginPath(); ctx.arc(s.x, s.y, game.st.range, 0, TAU); ctx.stroke();

  ctx.setLineDash([]);

  // GRAVITY COMPASS: chevrons flowing away from the ship along the net
  // pull of WORLDS (the sun is excluded at the source — physics.js). Reads
  // the smoothed vector from main.js so the arrow can't whip or flicker.
  // Helper UI: screen-constant stroke, violet-blue so it can't be confused
  // with the cyan beam ring.
  // Gravity Compass is an upgrade — no chevrons until it's unlocked
  const gx = game.compassX || 0, gy = game.compassY || 0;
  const mag = Math.hypot(gx, gy);
  if (game.st.hasCompass && mag > 1.2) {
    // log scale: ~1.2 (barely felt) -> ~200 (deep well) saturates
    const t = Math.min(1, Math.max(0, (Math.log10(mag) - 0.08) / 2.2));
    const ang = Math.atan2(gy, gx);
    const gap = 15 / z;
    const r0 = s.radius * 1.9 + 12 / z;
    const drift = game.compassPhase || 0;   // accumulated in main.js — calm, strength-paced flow
    ctx.lineWidth = 2 / z;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const frac = (i + drift) / 3;
      const d = r0 + frac * gap * 3;
      const a = (0.16 + 0.5 * t) * (1 - frac * 0.7);
      ctx.strokeStyle = `rgba(160, 175, 255, ${a})`;
      const wr = (6 + 4 * t) / z;
      const tx = s.x + Math.cos(ang) * (d + wr), ty = s.y + Math.sin(ang) * (d + wr);
      ctx.beginPath();
      ctx.moveTo(tx - Math.cos(ang - 0.55) * wr * 2, ty - Math.sin(ang - 0.55) * wr * 2);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - Math.cos(ang + 0.55) * wr * 2, ty - Math.sin(ang + 0.55) * wr * 2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
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

// ---- Player-ship hull: procedural vector art --------------------------------
// Vector remake of the AI sprite sheet (6 tiers x 3 damage states): the same
// silhouette language — delta nose over a round segmented body, glowing cyan
// core, arc ring-arms with orb pods on the big tiers — but canvas paths, so it
// stays crisp at every zoom and matches the game's vector look. Drawn in the
// ship's local frame, nose along +x, sized off the collision radius r.
const SHIP_HULL = '#dce6f2', SHIP_MID = '#9fb0c6', SHIP_DARK = '#2b3444',
  SHIP_GREY = '#57637a', SHIP_CYAN = '#7adcff';

// Damage scars are seeded per (tier, dmg) so they never flicker frame to frame.
// Stored in unit space (fractions of body radius) and scaled at draw time.
const scarCache = new Map();
function shipScars(tier, dmg) {
  const key = tier * 3 + dmg;
  let list = scarCache.get(key);
  if (!list) {
    const rng = mulberry32(0xC0FFEE + key * 977);
    list = [];
    const n = dmg === 0 ? 0 : dmg * 2 + (tier >> 1);
    for (let i = 0; i < n; i++) {
      list.push({
        a: rng() * TAU, d: 0.2 + rng() * 0.65,
        sz: (0.5 + rng() * 0.5) * (dmg === 2 ? 1.4 : 1),
        rot: rng() * TAU, streak: 0.25 + rng() * 0.4, jit: (rng() - 0.5) * 0.3,
      });
    }
    // Major damage also bites chunks out of the hull rim
    if (dmg === 2) {
      for (let i = 0; i < 2; i++) {
        list.push({ bite: true, a: rng() * TAU, sz: 0.6 + rng() * 0.4 });
      }
    }
    scarCache.set(key, list);
  }
  return list;
}

// Per-tier anatomy. Lengths are in units of u = r * s (collision radius x
// per-tier visual scale); arc angles are for the top half (-y) and mirrored
// at draw time. Each tier is a DISTINCT design, not just a bigger wedge:
//   0 SCOUT       bare wedge, tail fins
//   1 FIGHTER     swept wing pods, twin engine bells
//   2 CORVETTE    first ring arms bracketing the nose
//   3 CRUISER     four arms, armor collar, hull windows
//   4 DREADNOUGHT near-closed ring, strut spokes, triple bell
//   5 TITAN       double ring, five pod pairs, spokes everywhere — a class
//                 above everything else
// The tier size ladder lives in config.js SHIP_RADIUS (read by shipStats).
// The COLLISION circle is a uniform SHIP_HIT_FRAC of the drawn footprint on
// every tier, so the art is normalized to the FOOTPRINT (u = r / (frac ×
// reach)), NOT to the body disc — the drawn size never moves when the
// hitbox fraction is tuned.
const SHIP_TIERS = [
  { bR: 0.58, nose: 1.35, rear: 1.00, fins: true, core: 0, eng: 1 },
  { bR: 0.68, nose: 1.32, rear: 1.08, fins: true, wings: true, core: 1, eng: 2 },
  // Corvette's arms deliberately bracket the nose and DON'T spin — the
  // rotating machinery is a bigger-class privilege (spin: true, tiers 3+).
  { bR: 0.78, nose: 1.42, rear: 1.12, armR: 1.20, core: 1, eng: 1,
    arms: [[-1.45, -0.40]], pods: [-1.45, -0.40] },
  { bR: 0.88, nose: 1.55, rear: 1.22, armR: 1.32, core: 2, eng: 1,
    arms: [[-1.50, -0.45], [-2.75, -1.90]], pods: [-1.50, -0.45, -2.75],
    collar: true, windows: true, spin: true },
  { bR: 0.98, nose: 1.68, rear: 1.34, armR: 1.44, core: 2, eng: 3,
    arms: [[-1.62, -0.30], [-2.95, -1.78]], pods: [-0.30, -1.05, -1.78, -2.50],
    spokes: [-0.90, -2.20], collar: true, windows: true, spin: true },
  { bR: 1.05, nose: 1.85, rear: 1.45, armR: 1.58, armR2: 1.26, core: 2, eng: 3,
    arms: [[-2.90, -0.25]], arms2: [[-2.35, -1.85], [-1.25, -0.65]],
    pods: [-0.45, -1.02, -1.57, -2.12, -2.68],
    spokes: [-0.55, -1.57, -2.60], collar: true, windows: true, spin: true },
];

// A tier design's art-space reach: how far the drawn shape extends from
// center, in the same units as bR/nose/armR (the footprint before scaling).
function shipReach(t) {
  return Math.max(t.nose, (t.armR || 0) + 0.20, t.bR + (t.fins ? 0.42 : 0.2));
}

// How far the DRAWN ship reaches from its center (world units). The shield
// bubble and any effect that should wrap the art uses this, NOT the (smaller)
// collision radius — a titan's bubble must clear its outer ring and nose.
// Since the collision radius is SHIP_HIT_FRAC of the footprint, the footprint
// is simply r / SHIP_HIT_FRAC — identical for every tier by construction.
function shipVisualR(tier, r) {
  void tier;
  return r / SHIP_HIT_FRAC;
}

function drawShipHull(game, tier, dmg, r) {
  const t = SHIP_TIERS[tier];
  // Normalize the art to the FOOTPRINT (r / SHIP_HIT_FRAC), not the body
  // disc: the collision circle covers SHIP_HIT_FRAC of the drawn reach.
  const u = r / (SHIP_HIT_FRAC * shipReach(t));
  const bR = t.bR * u, nose = t.nose * u, rear = -t.rear * u;
  const lw = Math.max(1.1, 0.07 * u);
  const cx = -0.12 * u;                   // body circle sits a touch aft
  ctx.lineJoin = 'round';

  // The ring assemblies ROTATE (tiers flagged spin: true), in the same
  // +angle direction the orbit shield spins (CFG.ORBIT_OMEGA > 0) but
  // statelier; the inner ring turns slower for parallax. We're drawing
  // inside rotate(s.angle), so subtract the heading to anchor the spin in
  // WORLD space — otherwise every aim twitch would slew the rings.
  const spinA = t.spin ? game.time * 0.35 - game.ship.angle : 0;
  const spinB = t.spin ? game.time * 0.20 - game.ship.angle : 0;

  // Dark-outlined light arc, mirrored top/bottom — ring arms + armor collar
  const arcPass = (R, list, wOut, wIn) => {
    ctx.lineCap = 'round';
    for (const [a0, a1] of list) {
      for (const m of [1, -1]) {
        ctx.beginPath();
        ctx.arc(0, 0, R, m > 0 ? a0 : -a1, m > 0 ? a1 : -a0);
        ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = wOut; ctx.stroke();
        ctx.strokeStyle = SHIP_MID; ctx.lineWidth = wIn; ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  };

  // Outer ring assembly — spokes, arms and pods spin as one rigid wheel
  // around the stationary core.
  if (t.arms || t.spokes) {
    ctx.save();
    ctx.rotate(spinA);
    if (t.spokes) {
      ctx.strokeStyle = SHIP_GREY; ctx.lineWidth = 0.13 * u;
      for (const a of t.spokes) {
        for (const m of [1, -1]) {
          ctx.beginPath();
          ctx.moveTo(Math.cos(a * m) * bR * 0.9, Math.sin(a * m) * bR * 0.9);
          ctx.lineTo(Math.cos(a * m) * t.armR * u, Math.sin(a * m) * t.armR * u);
          ctx.stroke();
        }
      }
    }
    if (t.arms) arcPass(t.armR * u, t.arms, 0.30 * u, 0.14 * u);
    if (t.pods) {
      for (const a of t.pods) {
        for (const m of [1, -1]) {
          const px = Math.cos(a * m) * t.armR * u, py = Math.sin(a * m) * t.armR * u;
          ctx.fillStyle = SHIP_HULL;
          ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
          ctx.beginPath(); ctx.arc(px, py, 0.17 * u, 0, TAU); ctx.fill(); ctx.stroke();
          ctx.fillStyle = SHIP_CYAN;
          ctx.beginPath(); ctx.arc(px, py, 0.09 * u, 0, TAU); ctx.fill();
        }
      }
    }
    ctx.restore();
  }
  // Inner ring (titan): same direction, slower — depth through parallax
  if (t.arms2) {
    ctx.save();
    ctx.rotate(spinB);
    arcPass(t.armR2 * u, t.arms2, 0.20 * u, 0.09 * u);
    ctx.restore();
  }

  // Tail fins (scout/fighter — the ring arms take over the silhouette later)
  if (t.fins) {
    ctx.fillStyle = SHIP_MID;
    ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(-0.15 * u, m * bR * 0.7);
      ctx.lineTo(-0.85 * u, m * (bR + 0.35 * u));
      ctx.lineTo(-0.62 * u, m * bR * 0.5);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  // Fighter wing pods: swept struts ending in cyan-orbed nacelles
  if (t.wings) {
    for (const m of [1, -1]) {
      const wx = -0.5 * u, wy = m * (bR + 0.42 * u);
      ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.22 * u; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-0.05 * u, m * bR * 0.7); ctx.lineTo(wx, wy); ctx.stroke();
      ctx.strokeStyle = SHIP_MID; ctx.lineWidth = 0.11 * u;
      ctx.beginPath(); ctx.moveTo(-0.05 * u, m * bR * 0.7); ctx.lineTo(wx, wy); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = SHIP_HULL;
      ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(wx, wy, 0.16 * u, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = SHIP_CYAN;
      ctx.beginPath(); ctx.arc(wx, wy, 0.08 * u, 0, TAU); ctx.fill();
    }
  }

  // Engine bells: 1 = single trapezoid, 2 = twin, 3 = big bell + outboards
  ctx.fillStyle = SHIP_GREY;
  ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  const bell = (x0, x1, w0, w1, off) => {
    ctx.beginPath();
    ctx.moveTo(x0, off - w0); ctx.lineTo(x1, off - w1);
    ctx.lineTo(x1, off + w1); ctx.lineTo(x0, off + w0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  };
  if (t.eng === 1) bell(-bR * 0.72, rear, 0.36 * bR, 0.24 * bR, 0);
  else if (t.eng === 2) {
    bell(-bR * 0.62, rear, 0.20 * bR, 0.13 * bR, -0.34 * bR);
    bell(-bR * 0.62, rear, 0.20 * bR, 0.13 * bR, 0.34 * bR);
  } else {
    bell(-bR * 0.72, rear, 0.30 * bR, 0.20 * bR, 0);
    bell(-bR * 0.58, rear * 0.86, 0.15 * bR, 0.10 * bR, -0.60 * bR);
    bell(-bR * 0.58, rear * 0.86, 0.15 * bR, 0.10 * bR, 0.60 * bR);
  }
  // Cyan glow at the main bell mouth
  ctx.fillStyle = 'rgba(122, 220, 255, 0.8)';
  ctx.fillRect(rear, -0.14 * bR, 0.05 * u, 0.28 * bR);

  // Hull: round rear body + delta nose in one path
  ctx.fillStyle = SHIP_HULL;
  ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, 0, bR, 1.05, -1.05);
  ctx.quadraticCurveTo(0.55 * u, -0.68 * bR, nose, 0);
  ctx.quadraticCurveTo(0.55 * u, 0.68 * bR, cx + bR * Math.cos(1.05), bR * Math.sin(1.05));
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // Armor collar: heavy plate arcs hugging the rear rim
  if (t.collar) arcPass(bR * 1.04, [[-2.45, -1.75]], 0.28 * u, 0.15 * u);

  // Panel seams: a concentric ring plus diagonal radials keep the big
  // disc from reading as a blank plate
  ctx.strokeStyle = 'rgba(43, 52, 68, 0.30)';
  ctx.lineWidth = lw * 0.6;
  ctx.beginPath(); ctx.arc(cx, 0, bR * 0.72, 0, TAU); ctx.stroke();
  for (const a of [0.7, 2.2, -0.7, -2.2]) {
    ctx.beginPath();
    ctx.moveTo(cx + bR * 0.52 * Math.cos(a), bR * 0.52 * Math.sin(a));
    ctx.lineTo(cx + bR * 0.94 * Math.cos(a), bR * 0.94 * Math.sin(a));
    ctx.stroke();
  }
  // Lit hull windows along the mid-deck ring
  if (t.windows) {
    ctx.fillStyle = 'rgba(122, 220, 255, 0.9)';
    for (const a of [0.55, 1.15, 2.05, -0.55, -1.15, -2.05]) {
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * bR * 0.55, Math.sin(a) * bR * 0.55, 0.035 * u, 0, TAU);
      ctx.fill();
    }
  }

  // Dark nose spine with a cyan slit and tip light
  ctx.fillStyle = SHIP_GREY;
  ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
  ctx.beginPath();
  ctx.moveTo(nose * 0.97, 0);
  ctx.lineTo(0.45 * bR, -0.16 * bR);
  ctx.lineTo(0.45 * bR, 0.16 * bR);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = SHIP_CYAN; ctx.lineWidth = Math.max(1, 0.05 * u);
  ctx.beginPath(); ctx.moveTo(nose * 0.88, 0); ctx.lineTo(0.6 * bR, 0); ctx.stroke();
  if (tier >= 3) {
    ctx.fillStyle = '#e8f7ff';
    ctx.beginPath(); ctx.arc(nose * 0.96, 0, 0.045 * u, 0, TAU); ctx.fill();
  }

  // Core: dark well, cyan glow ring, bright center. core 2 adds an outer
  // graduated ring with tick marks — the reference's big-hull reactor look.
  const cR = (t.core === 0 ? 0.34 : 0.46) * bR;
  ctx.fillStyle = '#141b28';
  ctx.beginPath(); ctx.arc(0, 0, cR, 0, TAU); ctx.fill();
  ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.10 * bR;
  ctx.beginPath(); ctx.arc(0, 0, cR, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(90, 200, 255, 0.35)'; ctx.lineWidth = 0.17 * bR;
  ctx.beginPath(); ctx.arc(0, 0, cR * 0.65, 0, TAU); ctx.stroke();
  ctx.strokeStyle = SHIP_CYAN; ctx.lineWidth = 0.07 * bR;
  ctx.beginPath(); ctx.arc(0, 0, cR * 0.65, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#e8f7ff';
  ctx.beginPath(); ctx.arc(0, 0, cR * 0.28, 0, TAU); ctx.fill();
  if (t.core === 2) {
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.6)';
    ctx.lineWidth = lw * 0.7;
    ctx.beginPath(); ctx.arc(0, 0, cR * 1.35, 0, TAU); ctx.stroke();
    for (const a of [0.785, 2.356, -0.785, -2.356]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * cR * 1.1, Math.sin(a) * cR * 1.1);
      ctx.lineTo(Math.cos(a) * cR * 1.35, Math.sin(a) * cR * 1.35);
      ctx.stroke();
    }
  }

  // Damage overlay: scorch gouges with rust streaks trailing aft, and (major
  // only) dark bites out of the hull rim
  for (const sc of shipScars(tier, dmg)) {
    if (sc.bite) {
      ctx.fillStyle = '#0c0f16';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(sc.a) * bR, Math.sin(sc.a) * bR, sc.sz * 0.18 * bR, 0, TAU);
      ctx.fill();
      continue;
    }
    // Scar geometry scales with the BODY, not the collision radius — the same
    // damage level should look equally beat-up on a scout and a titan.
    const x = cx + Math.cos(sc.a) * sc.d * bR, y = Math.sin(sc.a) * sc.d * bR;
    const sz = sc.sz * 0.16 * bR;
    ctx.fillStyle = 'rgba(122, 74, 34, 0.7)';
    ctx.beginPath();
    ctx.moveTo(x, y - sz * 0.3);
    ctx.lineTo(x - sc.streak * bR, y + sc.jit * bR);
    ctx.lineTo(x, y + sz * 0.3);
    ctx.closePath(); ctx.fill();
    ctx.save();
    ctx.translate(x, y); ctx.rotate(sc.rot);
    ctx.fillStyle = '#241c12';
    ctx.beginPath();
    ctx.moveTo(-sz, 0); ctx.lineTo(-0.2 * sz, -0.8 * sz);
    ctx.lineTo(sz, -0.15 * sz); ctx.lineTo(0.3 * sz, 0.7 * sz);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.lineJoin = 'miter';  // back to the canvas default other draws assume
}

// Tier-morph state (render-local, cosmetic): when the tier changes, the new
// hull scales in from the old silhouette's size over MORPH_T seconds with a
// flash ring, masking the hard art swap. Driven by game.time so it freezes
// with the sim when paused.
const MORPH_T = 0.9;
let morphTierSeen = -1, morphStart = -1e9, morphFromVisR = 0, morphLastVisR = 0;

function drawShip(game) {
  const s = game.ship;
  if (!s.alive) return;
  if (s.invuln > 0 && Math.floor(game.time * 10) % 2 === 0) return;  // respawn blink

  const lv = game.st.levels;
  const r = s.radius;
  const tier = Math.min(game.st.tier, SHIP_TIERS.length - 1);
  const tG = SHIP_TIERS[tier];
  const visR = shipVisualR(tier, r);   // how far the drawn art reaches

  if (tier !== morphTierSeen) {
    // First frame ever doesn't morph; every later tier change (up OR down —
    // demo tools flip both ways) blends from the previous drawn size.
    if (morphTierSeen >= 0) { morphStart = game.time; morphFromVisR = morphLastVisR; }
    morphTierSeen = tier;
  }
  morphLastVisR = visR;
  const mk = (game.time - morphStart) / MORPH_T;   // 0..1 during a morph
  const morphing = mk >= 0 && mk < 1;
  const morphScale = morphing
    ? lerp(morphFromVisR / visR, 1, 1 - Math.pow(1 - mk, 3))   // cubic ease-out
    : 1;

  // The tier hull designs carry the ship's visual growth; the only extra
  // stage FX kept is the dreadnought+ gravity-well halo dimming space around
  // the hull (it layers under the art instead of duplicating its geometry).
  const stage = game.st.totalLevel >= 16 ? 3 : game.st.totalLevel >= 9 ? 2 : game.st.totalLevel >= 4 ? 1 : 0;
  if (stage >= 2) {
    const R = r * (stage >= 3 ? 3.8 : 2.8);
    const strength = stage >= 3 ? 0.5 : 0.35;
    const hg = ctx.createRadialGradient(s.x, s.y, R * 0.25, s.x, s.y, R);
    hg.addColorStop(0, `rgba(4, 2, 16, ${strength})`);
    hg.addColorStop(0.75, `rgba(30, 20, 70, ${strength * 0.4})`);
    hg.addColorStop(1, 'transparent');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.fill();
  }

  // Personal shield (DESIGN LAW — see CLAUDE.md): a calm, steady volumetric
  // rim glow. No dashes, no idle motion. Color/alpha track shield fraction
  // (low = strained violet flicker); shield DOWN draws nothing at all — the
  // naked hull is the indicator, the blinking SHLD HUD label is the alarm.
  // Motion is reserved for EVENTS: the recharge sweep and the absorb ripple.
  if (game.st.shieldMax > 0) {
    const z = game.cam.zoom;
    const sf = Math.max(0, s.shield / game.st.shieldMax);
    // The bubble wraps the DRAWN hull (rings, nose tower and all), not the
    // collision radius — on a titan those differ by almost 2x. It tracks the
    // tier-morph scale so it grows with the art instead of snapping.
    const R = visR * morphScale * 1.08 + 5 / z;
    // BRAWLER's War Plating covers the FRONT ARC only (st.shieldArc < PI):
    // clip every shield visual — glow, recharge sweep, absorb ripple — to
    // the covered wedge so the bare tail reads at a glance. The wedge tracks
    // the nose, so the calm-rim design law still holds within it.
    const arc = game.st.shieldArc ?? Math.PI;
    const partial = arc < Math.PI - 0.01;
    if (partial) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.arc(s.x, s.y, R * 2.6, s.angle - arc, s.angle + arc);
      ctx.closePath();
      ctx.clip();
    }
    if (sf > 0.02) {
      const col = sf > 0.6 ? '130, 225, 255' : sf > 0.3 ? '150, 190, 255' : '205, 150, 255';
      let a = 0.12 + 0.30 * sf;
      if (sf < 0.3) a *= 0.6 + 0.4 * Math.sin(game.time * 26);
      // A calm, steady bubble: just a soft volumetric rim glow. No dashes
      // (that's helper-UI language) and no moving parts (distracting) —
      // motion is reserved for EVENTS: recharge sweeps and absorb ripples.
      const g2 = ctx.createRadialGradient(s.x, s.y, R * 0.7, s.x, s.y, R * 1.1);
      g2.addColorStop(0, 'transparent');
      g2.addColorStop(0.8, `rgba(${col}, ${a * 0.8})`);
      g2.addColorStop(1, 'transparent');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(s.x, s.y, R * 1.1, 0, TAU); ctx.fill();
    }
    // (Shield down = nothing drawn at all: a naked hull IS the indicator.
    // The HUD bar's blinking SHLD label carries the alarm.)
    // st.regenDelay, not the CFG base: Rapid Recharge shortens the delay, and
    // the sweep must appear the moment the recharge actually starts (hud.js
    // gates its charging shimmer on the same stat).
    const charging = s.alive && sf < 1 &&
      game.time - game.lastDamage > game.st.regenDelay;
    if (charging) {
      const t = (game.time % 0.8) / 0.8;
      ctx.strokeStyle = `rgba(140, 230, 255, ${0.5 * t})`;
      ctx.lineWidth = 1.5 / z;
      ctx.beginPath(); ctx.arc(s.x, s.y, R * (1.7 - 0.7 * t), 0, TAU); ctx.stroke();
    }
    if (s.shieldHitT > 0) {
      const k = 1 - s.shieldHitT / 0.35;
      ctx.strokeStyle = `rgba(220, 245, 255, ${(1 - k) * 0.9})`;
      ctx.lineWidth = 3 / z;
      ctx.beginPath(); ctx.arc(s.x, s.y, R * (1 + k * 0.55), 0, TAU); ctx.stroke();
      ctx.fillStyle = `rgba(150, 225, 255, ${(1 - k) * 0.16})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.fill();
    }
    if (partial) ctx.restore();
  }

  // REFLEX JINK flash: one expanding mint ring the instant the auto-dodge
  // fires — EVENT motion, like the absorb ripple (game.jinkT, main.js decay).
  if (game.jinkT > 0) {
    const k = 1 - game.jinkT / 0.3;
    ctx.strokeStyle = `rgba(160, 255, 230, ${(1 - k) * 0.85})`;
    ctx.lineWidth = 2.5 / game.cam.zoom;
    ctx.beginPath(); ctx.arc(s.x, s.y, visR * (1 + k * 1.6), 0, TAU); ctx.stroke();
  }

  // Corona/lava heat: the hull glows toward melting (game.heatT 0..1, set
  // in physics) — a flickering furnace aura that IS the danger meter
  if (game.heatT > 0.03) {
    const h = game.heatT;
    ctx.globalCompositeOperation = 'lighter';
    const hg2 = ctx.createRadialGradient(s.x, s.y, r * 0.3, s.x, s.y, r * (2.1 + h * 1.2));
    hg2.addColorStop(0, `rgba(255, 190, 90, ${h * (0.35 + 0.1 * Math.sin(game.time * 17))})`);
    hg2.addColorStop(0.6, `rgba(255, 110, 40, ${0.25 * h})`);
    hg2.addColorStop(1, 'transparent');
    ctx.fillStyle = hg2;
    ctx.beginPath(); ctx.arc(s.x, s.y, r * (2.1 + h * 1.2), 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // Tier-morph flash: a bright pulse + one expanding ring sweeping from the
  // old silhouette size to the new — EVENT motion, like the absorb ripple.
  if (morphing) {
    const z = game.cam.zoom;
    const pulse = Math.sin(Math.PI * Math.min(1, mk * 1.15));
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, visR * morphScale * 1.5);
    fg.addColorStop(0, `rgba(190, 240, 255, ${pulse * 0.4})`);
    fg.addColorStop(0.6, `rgba(110, 200, 255, ${pulse * 0.18})`);
    fg.addColorStop(1, 'transparent');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(s.x, s.y, visR * morphScale * 1.5, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(170, 235, 255, ${(1 - mk) * 0.8})`;
    ctx.lineWidth = 2.5 / z;
    ctx.beginPath();
    ctx.arc(s.x, s.y, lerp(morphFromVisR, visR * 1.35, 1 - Math.pow(1 - mk, 3)), 0, TAU);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  // The whole local-frame group (flames, sputter, hull) rides the morph
  // scale, so the swap reads as the ship growing into its new class.
  ctx.scale(morphScale, morphScale);

  // Flames anchor to the tier's actual engine mouth / nose tip. Since the
  // hitbox change, r (collision) is LARGER than the drawn body disc — art
  // anchors must use the same footprint normalization as drawShipHull, and
  // art-proportional sizes scale off the DRAWN disc (bodyR), never r.
  const uG = r / (SHIP_HIT_FRAC * shipReach(tG));
  const bodyR = tG.bR * uG;   // the drawn body disc radius
  const rearX = -tG.rear * uG, noseX = tG.nose * uG;
  if (s.thrusting) {
    const burner = !!game.burnerOn;
    // The afterburner plume is nearly twice the flame — the burn should LOOK
    // like an event (it's spending a slow-refilling tank, not a free hold).
    const f = (1 + Math.sin(game.time * 40) * 0.3) * (1 + lv.thrust * 0.15) * (burner ? 1.9 : 1);
    const g = ctx.createLinearGradient(rearX, 0, rearX - bodyR * 1.9 * f, 0);
    g.addColorStop(0, burner ? 'rgba(160, 220, 255, 0.95)' : 'rgba(120, 200, 255, 0.9)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(rearX * 0.92, -5 - lv.thrust);
    ctx.lineTo(rearX - bodyR * 1.9 * f, 0);
    ctx.lineTo(rearX * 0.92, 5 + lv.thrust);
    ctx.closePath(); ctx.fill();
    if (burner) {
      // White-hot core lance + shock diamonds down the plume
      const core = ctx.createLinearGradient(rearX, 0, rearX - bodyR * 1.4 * f, 0);
      core.addColorStop(0, 'rgba(240, 252, 255, 0.95)');
      core.addColorStop(1, 'transparent');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.moveTo(rearX * 0.95, -2.5 - lv.thrust * 0.5);
      ctx.lineTo(rearX - bodyR * 1.4 * f, 0);
      ctx.lineTo(rearX * 0.95, 2.5 + lv.thrust * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(225, 245, 255, 0.85)';
      for (let i = 1; i <= 3; i++) {
        const px = rearX - bodyR * (0.5 * i + 0.25) * f;
        const dz = Math.max(0.8, bodyR * 0.1) * (1.1 - i * 0.24);
        ctx.beginPath();
        ctx.moveTo(px + dz * 1.6, 0); ctx.lineTo(px, -dz);
        ctx.lineTo(px - dz * 1.6, 0); ctx.lineTo(px, dz);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  if (s.braking) {
    // Retro puffs firing forward
    ctx.fillStyle = 'rgba(255, 190, 120, 0.7)';
    const f = 1 + Math.sin(game.time * 50) * 0.4;
    ctx.beginPath();
    ctx.moveTo(noseX * 0.92, -4);
    ctx.lineTo(noseX + bodyR * (0.45 + 0.3 * f), 0);
    ctx.lineTo(noseX * 0.92, 4);
    ctx.closePath(); ctx.fill();
  }

  // DASH JETS flash (A/D dart): three quick puffs firing off the side the
  // ship dashed AWAY from — exhaust opposite the dart (game.dashT, main.js).
  if (game.dashT > 0) {
    const k = game.dashT / 0.22;
    const side = -(game.dashDir || 1);   // local +y is the ship's right
    ctx.fillStyle = `rgba(150, 235, 255, ${0.75 * k})`;
    const jy = side * bodyR * 0.85;
    for (const jx of [rearX * 0.45, 0, noseX * 0.45]) {
      ctx.beginPath();
      ctx.moveTo(jx - bodyR * 0.16, jy);
      ctx.lineTo(jx, jy + side * bodyR * (0.7 + 0.5 * k));
      ctx.lineTo(jx + bodyR * 0.16, jy);
      ctx.closePath(); ctx.fill();
    }
  }

  // Flare EMP: dead engines don't flame — they SPUTTER, arcing little
  // shorts at the stern until the surge clears (anchored to the tier's
  // actual engine bell, like the flames above)
  if (s.engineOutT > 0) {
    if (Math.sin(game.time * 29) > -0.3) {
      ctx.fillStyle = `rgba(255, 205, 130, ${0.3 + 0.5 * Math.random()})`;
      ctx.beginPath();
      ctx.arc(rearX * (0.9 + Math.random() * 0.25), (Math.random() - 0.5) * bodyR * 0.8,
        Math.max(1.2, bodyR * 0.09), 0, TAU);
      ctx.fill();
    }
  }

  // Hull art: tier picks the design (the ship visibly growing is the whole
  // progression fantasy), hull fraction picks the damage state.
  const hullFrac = s.hull / game.st.hullMax;
  const dmg = hullFrac > 0.66 ? 0 : hullFrac > 0.33 ? 1 : 2;
  drawShipHull(game, tier, dmg, r);

  ctx.restore();

  if (game.held) {
    // Beams sprout from the DRAWN hull edge (bodyR), not the larger hitbox
    const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    drawBeam(game, s.x + Math.cos(ang) * bodyR, s.y + Math.sin(ang) * bodyR, game.held, '#5ac8ff');
    // Twin Grip: a second beam to the flanking second rock
    if (game.held2) drawBeam(game, s.x + Math.cos(ang + 0.5) * bodyR, s.y + Math.sin(ang + 0.5) * bodyR, game.held2, '#5ac8ff');
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
  // The Trajectory Plotter is an upgrade; the throw line also hides while the
  // sim is frozen behind any overlay (splash, shell panel, pause, upgrade card)
  if (!game.predict || !game.started || game.paused || shellModal(game) ||
      game.choosingUpgrade || !game.st.hasPredict) return;
  const { shipPts, heldPts, shipHit, heldHit } = predictPaths(game);
  const z = game.cam.zoom;

  // Collision ✕ marks are a SEPARATE upgrade (Collision Alert)
  const drawHitMark = (hit) => {
    if (!hit || !game.st.hasCrashWarn) return;
    ctx.strokeStyle = '#ff6a5c';
    ctx.lineWidth = 2 / z;
    const r = 10 / z;
    ctx.beginPath();
    ctx.moveTo(hit.x - r, hit.y - r); ctx.lineTo(hit.x + r, hit.y + r);
    ctx.moveTo(hit.x + r, hit.y - r); ctx.lineTo(hit.x - r, hit.y + r);
    ctx.stroke();
  };
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
    drawHitMark(hit);
  };
  // Ship path fades toward its end: the forecast dissolves into the
  // unknown instead of just stopping (length is capped in predictPaths)
  const drawPathFaded = (pts, hit, r2, g2, b2, baseA) => {
    if (pts.length < 2) return;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([5 / z, 7 / z]);
    const chunks = 6;
    const per = Math.max(2, Math.ceil(pts.length / chunks));
    for (let c = 0; c < chunks; c++) {
      const start = c * per;
      if (start >= pts.length - 1) break;
      const end = Math.min(pts.length - 1, start + per);
      ctx.strokeStyle = `rgba(${r2}, ${g2}, ${b2}, ${baseA * Math.pow(1 - c / chunks, 1.3)})`;
      ctx.beginPath();
      ctx.moveTo(pts[start].x, pts[start].y);
      for (let i = start + 1; i <= end; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    drawHitMark(hit);
  };
  drawPathFaded(shipPts, shipHit, 120, 210, 255, 0.45);
  drawPath(heldPts, heldHit, 'rgba(255, 200, 90, 0.55)');
}

// The minimap is a SHIP-CENTERED RADAR: it shows the local neighborhood
// (MINIMAP_RANGE world units to the rim), not the whole system — worlds drift
// across it as you fly. Neon rim with bearing ticks, a slow rotating sweep and
// locator ping centered on you, your sensor bubble, and glowing blips. Same
// data rules as ever — fog of war (b.seen) decides what exists; the sun is
// pinned to the rim when out of range so you can always fly home by the map.
const MINIMAP_RANGE = 5200;
const RADAR_SIZE = 200;   // CSS px of the #radar canvas (positioned + tilted by style.css)
function drawMinimap(game) {
  // The radar has its OWN canvas so the DOM can tilt it on the 3D canopy —
  // shadow the module ctx with the radar context for this function's scope.
  const ctx = rctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  const cx = RADAR_SIZE / 2, cy = RADAR_SIZE / 2;
  const r = 95;
  const scale = (r - 4) / MINIMAP_RANGE;
  // Radar origin: the ship, or the camera while the wreck drifts
  const fx = game.ship.alive ? game.ship.x : game.cam.x;
  const fy = game.ship.alive ? game.ship.y : game.cam.y;

  // Dark well with a faint lit horizon toward the top
  const bg = ctx.createRadialGradient(cx, cy - r * 0.6, r * 0.2, cx, cy, r);
  bg.addColorStop(0, 'rgba(20, 12, 40, 0.82)');
  bg.addColorStop(1, 'rgba(8, 4, 18, 0.88)');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // Grid: two range rings + cross axes, barely-there
  ctx.strokeStyle = 'rgba(176, 112, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r * (1 / 3), 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r * (2 / 3), 0, TAU); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Sensor bubble: how far the scan actually reveals (mirrors replenishWorld).
  // Centered on the ship = the radar center.
  if (game.ship.alive) {
    const seeR = Math.max(2600, (game.viewR || 1200) * 1.25) * (game.st.sensorMul || 1) * scale;
    ctx.fillStyle = 'rgba(176, 112, 255, 0.05)';
    ctx.beginPath(); ctx.arc(cx, cy, seeR, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(176, 112, 255, 0.22)';
    ctx.beginPath(); ctx.arc(cx, cy, seeR, 0, TAU); ctx.stroke();
  }

  // The sun sits at the world origin: storm front + world edge both circle it,
  // drawn in ship-relative space (the clip discards whatever falls outside).
  const sunX = cx - fx * scale, sunY = cy - fy * scale;
  if (game.storm) {
    ctx.strokeStyle = 'rgba(255, 200, 90, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sunX, sunY, game.storm.r * scale, 0, TAU); ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 180, 80, 0.15)';
    ctx.beginPath(); ctx.arc(sunX, sunY, game.storm.r * scale, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1;
  }
  {
    const dSun = Math.hypot(fx, fy);
    if (Math.abs(dSun - CFG.WORLD_R) < MINIMAP_RANGE * 1.2) {
      // world edge: the icy band of the Oort wall with the ember kill line
      // at its foot — matches the wall's in-world reading
      ctx.strokeStyle = 'rgba(150, 200, 255, 0.18)';
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.arc(sunX, sunY, CFG.WORLD_R * scale + 4, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 130, 120, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sunX, sunY, CFG.WORLD_R * scale, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // Radar sweep: a trailing glow wedge behind a bright leading edge, spinning
  // around the ship. Runs on game.time, so it freezes with the sim behind menus.
  const sweepAng = (game.time * TAU / 7) % TAU;
  if (ctx.createConicGradient) {
    const sweep = ctx.createConicGradient(sweepAng, cx, cy);
    sweep.addColorStop(0, 'rgba(176, 112, 255, 0)');
    sweep.addColorStop(0.8, 'rgba(176, 112, 255, 0)');
    sweep.addColorStop(1, 'rgba(176, 112, 255, 0.20)');
    ctx.fillStyle = sweep;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(235, 218, 255, 0.5)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepAng) * r, cy + Math.sin(sweepAng) * r);
    ctx.stroke();
  }
  // A blip FLARES as the beam crosses its bearing, then cools until the next
  // pass — the radar reads as actively scanning, not as a static chart.
  const sweepFlare = (dx, dy) => {
    let lag = sweepAng - Math.atan2(dy, dx);
    lag %= TAU; if (lag < 0) lag += TAU;
    return Math.min(1, 0.68 + 0.6 * Math.exp(-lag * 2.5));
  };

  // Blips glow — shadowBlur is fine at these counts (a few dozen, once/frame)
  ctx.shadowBlur = 5;
  for (const b of game.bodies) {
    // Fog of war: only the sun is visible from anywhere; everything else
    // appears once it has come within sensor range (b.seen, set by the
    // replenishWorld scan) — the map fills in as you actually explore.
    if (b.type !== 'star' && !b.seen) continue;
    const dx = b.x - fx, dy = b.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    if (b.type !== 'star' && d > MINIMAP_RANGE * 1.05) continue;   // beyond radar range
    ctx.globalAlpha = sweepFlare(dx, dy);
    let x = cx + dx * scale, y = cy + dy * scale;
    if (b.type === 'star') {
      // Off-range the sun pins to the rim as a homeward direction marker
      const pinned = d * scale > r - 9;
      if (pinned) { x = cx + (dx / d) * (r - 9); y = cy + (dy / d) * (r - 9); }
      ctx.shadowColor = '#ffd76a';
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(x, y, pinned ? 3 : 4.5, 0, TAU); ctx.fill();
    } else if (b.type === 'rogue') {
      ctx.shadowColor = '#b07aff';
      ctx.fillStyle = '#b07aff';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    } else if (b.type === 'planet') {
      const col = b.ember > 0.01 && Math.sin(game.time * 4) > 0 ? '#ff8040' : b.color;
      ctx.shadowColor = col;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
      if (b.fort) { ctx.strokeStyle = '#78c8ff'; ctx.lineWidth = 1; ctx.strokeRect(x - 4, y - 4, 8, 8); }
    } else if (b.type === 'moon' && b.fort) {
      ctx.shadowColor = '#78c8ff';
      ctx.strokeStyle = '#78c8ff'; ctx.lineWidth = 1;
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
    } else if (b.type === 'moon') {
      ctx.shadowColor = '#9fb6cc';
      ctx.fillStyle = '#9fb6cc';
      ctx.beginPath(); ctx.arc(x, y, 1.4, 0, TAU); ctx.fill();
    } else if (b.type === 'nest') {
      ctx.shadowColor = '#7ec95f';
      ctx.fillStyle = '#7ec95f';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    } else if (b.type === 'station') {
      ctx.shadowColor = '#c9d6e4';
      ctx.fillStyle = '#c9d6e4';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    } else if (b.visitor) {
      ctx.shadowColor = '#ffd9a8';
      ctx.fillStyle = '#ffd9a8';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    } else if (b.comet) {
      ctx.shadowColor = '#8fe8ff';
      ctx.fillStyle = '#8fe8ff';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
  // Aliens: hot red deltas
  ctx.shadowColor = '#ff4a4a';
  ctx.fillStyle = '#ff4a4a';
  for (const al of game.aliens) {
    const dx = al.x - fx, dy = al.y - fy;
    if (Math.hypot(dx, dy) > MINIMAP_RANGE * 1.05) continue;
    ctx.globalAlpha = sweepFlare(dx, dy);
    const x = cx + dx * scale, y = cy + dy * scale;
    ctx.beginPath();
    ctx.moveTo(x, y - 2.6); ctx.lineTo(x + 2.4, y + 2); ctx.lineTo(x - 2.4, y + 2);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // The ship: a heading chevron at the radar's heart, with a locator ping
  if (game.ship.alive) {
    const ping = (game.time % 2.4) / 2.4;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 * (1 - ping)})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 3 + ping * 10, 0, TAU); ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(game.ship.angle);
    ctx.shadowBlur = 6; ctx.shadowColor = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(4.5, 0); ctx.lineTo(-3, 3); ctx.lineTo(-1.2, 0); ctx.lineTo(-3, -3);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  ctx.restore();

  // Rim: bright ring + halo + bearing ticks (cardinals heavier), outside the clip
  ctx.strokeStyle = 'rgba(176, 112, 255, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(176, 112, 255, 0.12)';
  ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(cx, cy, r + 2.5, 0, TAU); ctx.stroke();
  ctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const cardinal = i % 6 === 0;
    const len = cardinal ? 7 : 3.5;
    ctx.strokeStyle = cardinal ? 'rgba(235, 218, 255, 0.8)' : 'rgba(176, 112, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
    ctx.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1));
    ctx.stroke();
  }
}

export function render(game) {
  beginFrame(game);
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

  // Oort cloud: only drawn when the view can actually reach the wall — deep
  // in the system every part of it is guaranteed off-screen. The margin
  // covers the approach haze and the inner stray grains (WORLD_R - 600).
  if (Math.hypot(game.cam.x, game.cam.y) + view.r > CFG.WORLD_R - 900) drawOort(game);

  armedSet = (game.volleyCharging && game.volleySel > 0)
    ? new Set(volleyPick(game, game.volleySel)) : null;

  drawShipRings(game);
  drawPrediction(game);
  for (const b of game.bodies) if (b.alive && bodyOnScreen(b)) drawBody(game, b);
  drawGlow(game);
  drawApproach(game);
  drawDeflectable(game);
  drawParry(game);

  // Scrap debris — glinting gold
  for (const d of game.debris) {
    if (d.x < view.x0 - 20 || d.x > view.x1 + 20 || d.y < view.y0 - 20 || d.y > view.y1 + 20) continue;
    const tw = 0.6 + Math.sin(game.time * 6 + d.phase) * 0.4;
    ctx.fillStyle = `rgba(255, 210, 90, ${(0.55 + tw * 0.45) * Math.min(1, d.life / 4)})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.radius, 0, TAU); ctx.fill();
  }

  drawPickups(game);

  // Particles (additive glow)
  ctx.globalCompositeOperation = 'lighter';
  for (const p of game.particles) {
    if (p.x < view.x0 - 20 || p.x > view.x1 + 20 || p.y < view.y0 - 20 || p.y > view.y1 + 20) continue;
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife) * 0.8;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // Solar flares — living plasma: a wide dark-orange wake under a white-hot
  // core streak, a pulsing heart, and crackling wisps that writhe around it
  if (game.flares && game.flares.length) {
    ctx.globalCompositeOperation = 'lighter';
    let fi = 0;
    for (const f of game.flares) {
      fi++;
      ctx.globalAlpha = Math.min(1, f.life);   // fizzle out, don't pop
      const sm = Math.hypot(f.vx, f.vy) || 1;
      const ux = f.vx / sm, uy = f.vy / sm;
      const pulse = 1 + 0.14 * Math.sin(game.time * 21 + fi * 2.4);
      // Wide soft wake
      const wx = f.x - ux * f.radius * 9, wy = f.y - uy * f.radius * 9;
      const wake = ctx.createLinearGradient(f.x, f.y, wx, wy);
      wake.addColorStop(0, 'rgba(255, 130, 40, 0.4)');
      wake.addColorStop(0.5, 'rgba(210, 70, 20, 0.18)');
      wake.addColorStop(1, 'transparent');
      ctx.strokeStyle = wake;
      ctx.lineWidth = f.radius * 1.7;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(wx, wy); ctx.stroke();
      // Narrow white-hot core streak
      const cx2 = f.x - ux * f.radius * 4.5, cy2 = f.y - uy * f.radius * 4.5;
      const core = ctx.createLinearGradient(f.x, f.y, cx2, cy2);
      core.addColorStop(0, 'rgba(255, 240, 200, 0.9)');
      core.addColorStop(1, 'transparent');
      ctx.strokeStyle = core;
      ctx.lineWidth = f.radius * 0.55;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(cx2, cy2); ctx.stroke();
      ctx.lineCap = 'butt';
      // Pulsing heart
      const g2 = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius * 2.4 * pulse);
      g2.addColorStop(0, 'rgba(255, 250, 235, 0.95)');
      g2.addColorStop(0.3, 'rgba(255, 180, 80, 0.65)');
      g2.addColorStop(0.65, 'rgba(255, 110, 40, 0.25)');
      g2.addColorStop(1, 'transparent');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.radius * 2.4 * pulse, 0, TAU); ctx.fill();
      // Crackling wisps writhing around the heart
      ctx.fillStyle = 'rgba(255, 225, 160, 0.8)';
      for (let j = 0; j < 3; j++) {
        const a = game.time * (9 + j * 2.7) + fi * 2.1 + j * 2.4;
        const wr = f.radius * (0.9 + 0.5 * Math.sin(game.time * 6 + j * 1.9));
        ctx.beginPath();
        ctx.arc(f.x + Math.cos(a) * wr, f.y + Math.sin(a) * wr, f.radius * 0.22, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Solar storm front: a soft charged annulus expanding from the sun.
  // Cheap: skipped entirely unless the front actually crosses the view.
  if (game.storm && game.homeStar) {
    const hs = game.homeStar;
    const dCam = Math.hypot(view.cx - hs.x, view.cy - hs.y);
    if (Math.abs(dCam - game.storm.r) < view.r + CFG.STORM_BAND * 1.6) {
      const r = game.storm.r;
      const band = CFG.STORM_BAND;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(hs.x, hs.y, Math.max(0, r - band), hs.x, hs.y, r + band);
      g.addColorStop(0, 'transparent');
      g.addColorStop(0.5, 'rgba(140, 200, 255, 0.09)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(hs.x, hs.y, r + band, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(175, 225, 255, 0.14)';
      ctx.lineWidth = 90;
      ctx.beginPath(); ctx.arc(hs.x, hs.y, r, 0, TAU); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // Ghost-ship sonar: the visible ring of the audible ping (solid — it's a
  // real emission from a real object, not helper UI)
  if (game.ghostPing) {
    const gp = game.ghostPing;
    const k = 1 - gp.t / 1.6;
    ctx.strokeStyle = `rgba(255, 150, 120, ${(1 - k) * 0.45})`;
    ctx.lineWidth = 2 / game.cam.zoom;
    ctx.beginPath(); ctx.arc(gp.x, gp.y, 40 + k * 900, 0, TAU); ctx.stroke();
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

  // Surface-scrape feedback: a hot friction glow at the contact point while
  // the hull is grinding (sparks come from physics.js particles)
  if (game.scrapeT > 0 && game.ship.alive) {
    const k = Math.min(1, game.scrapeT / 0.18);
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createRadialGradient(game.scrapeX, game.scrapeY, 0, game.scrapeX, game.scrapeY, 14);
    sg.addColorStop(0, `rgba(255, 220, 150, ${0.75 * k})`);
    sg.addColorStop(0.5, `rgba(255, 150, 60, ${0.4 * k})`);
    sg.addColorStop(1, 'transparent');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(game.scrapeX, game.scrapeY, 14, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // Hover hint: what would happen if you grabbed the thing under the cursor?
  // green = auto-orbits, cyan = holdable, red = too heavy. Dim when out of
  // beam range.
  if (game.ship.alive) {
    const st = game.st;
    let hov = null, hovD2 = Infinity;
    for (const b of game.bodies) {
      if (!b.alive || b.type === 'star' || b.type === 'nest' || b.heldBy) continue;
      const gr = b.radius + st.grabSlack;
      const d2 = (b.x - game.aim.x) ** 2 + (b.y - game.aim.y) ** 2;
      if (d2 > gr * gr) continue;
      if (d2 < hovD2) { hov = b; hovD2 = d2; }
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

  if (game.started) drawMinimap(game);   // no HUD on the splash — just the backdrop

  // Screen-space overlays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // GAS DIVE — the ship is INSIDE the planet, and the screen says so:
  // a full wash of the giant's own air, cloud decks streaming past at
  // different speeds, darkness building with depth, pressure closing in
  if (game.gasDiveT > 0 && game.ship.alive && game.gasDiveBody) {
    const depth = game.gasDiveDepth || 0;
    const col = game.gasDiveBody.color;
    const vr = parseInt(col.slice(1, 3), 16), vg2 = parseInt(col.slice(3, 5), 16), vb = parseInt(col.slice(5, 7), 16);
    const k = Math.min(1, game.gasDiveT / 0.2);
    // 1) submerged: everything sits behind the giant's air
    ctx.fillStyle = `rgba(${vr}, ${vg2}, ${vb}, ${k * (0.22 + 0.33 * depth)})`;
    ctx.fillRect(0, 0, vw, vh);
    // 2) cloud decks scrolling past at different speeds (parallax layers)
    for (let i = 0; i < 3; i++) {
      const bandH = vh * (0.16 + i * 0.05);
      const y = ((game.time * (30 + i * 45) + i * 217) % (vh + bandH)) - bandH;
      const bg = ctx.createLinearGradient(0, y, 0, y + bandH);
      bg.addColorStop(0, 'transparent');
      bg.addColorStop(0.5, `rgba(255, 255, 255, ${k * (0.05 + 0.09 * depth)})`);
      bg.addColorStop(1, 'transparent');
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, vw, bandH);
    }
    // 3) the deeps are DARK, and the pressure closes in at the edges
    ctx.fillStyle = `rgba(2, 4, 12, ${k * 0.4 * depth})`;
    ctx.fillRect(0, 0, vw, vh);
    const vgrad = ctx.createRadialGradient(vw / 2, vh / 2, vh * Math.max(0.12, 0.45 - 0.3 * depth), vw / 2, vh / 2, vh * 0.8);
    vgrad.addColorStop(0, 'transparent');
    vgrad.addColorStop(1, `rgba(${vr >> 1}, ${vg2 >> 1}, ${vb >> 1}, ${k * (0.3 + 0.45 * depth)})`);
    ctx.fillStyle = vgrad;
    ctx.fillRect(0, 0, vw, vh);
  }

  // GAS ENTRY: punching through the cloud tops — a white flash and two
  // shock rings expanding across the whole screen (gasEnterT 0.8 -> 0)
  if (game.gasEnterT > 0 && game.ship.alive) {
    const k = Math.min(1, game.gasEnterT / 0.8);   // 1 at impact -> 0
    ctx.fillStyle = `rgba(255, 255, 255, ${0.4 * k * k})`;
    ctx.fillRect(0, 0, vw, vh);
    ctx.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      const prog = (1 - k) * (1.15 + i * 0.35);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.55 * k * (1 - i * 0.35)})`;
      ctx.lineWidth = 10 * k + 2;
      ctx.beginPath();
      ctx.arc(vw / 2, vh / 2, Math.max(6, vh * prog), 0, TAU);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // CORONA HEAT vignette: the screen edges catch fire and flicker as the
  // exponential ramp climbs — subtle warmth far out, wall of flame up close
  if (game.heatT > 0.05 && game.ship.alive) {
    const h = game.heatT;
    const flick = 1 + 0.12 * Math.sin(game.time * 13) + 0.06 * Math.sin(game.time * 29);
    const ha = Math.min(0.75, Math.pow(h, 1.6) * 0.7 * flick);
    const hgrad = ctx.createRadialGradient(vw / 2, vh / 2, vh * (0.55 - 0.25 * h), vw / 2, vh / 2, vh * 0.85);
    hgrad.addColorStop(0, 'transparent');
    hgrad.addColorStop(0.7, `rgba(255, 90, 20, ${ha * 0.55})`);
    hgrad.addColorStop(1, `rgba(255, 160, 60, ${ha})`);
    ctx.fillStyle = hgrad;
    ctx.fillRect(0, 0, vw, vh);
  }

  // OORT FROST vignette: ice creeps in from the screen edges across the
  // warning band, then whites out with depth once the grind begins — the
  // cold mirror of the corona-heat vignette (fire at the core, ice at the rim)
  if (game.ship.alive) {
    const rc = Math.hypot(game.ship.x, game.ship.y);
    const appr = Math.min(1, Math.max(0, (rc - (CFG.WORLD_R - CFG.OORT_WARN)) / CFG.OORT_WARN));
    const f = Math.min(1, appr * 0.3 + Math.max(0, (rc - CFG.WORLD_R) / 1500));
    if (f > 0.03) {
      const shimmer = 1 + 0.1 * Math.sin(game.time * 11) + 0.05 * Math.sin(game.time * 23);
      const fa = Math.min(0.8, f * 0.75 * shimmer);
      const fg = ctx.createRadialGradient(vw / 2, vh / 2, vh * (0.62 - 0.3 * f), vw / 2, vh / 2, vh * 0.9);
      fg.addColorStop(0, 'transparent');
      fg.addColorStop(0.65, `rgba(140, 190, 255, ${fa * 0.45})`);
      fg.addColorStop(1, `rgba(225, 240, 255, ${fa})`);
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, vw, vh);
    }
  }

  // Low-hull vignette
  const hullFrac = game.ship.hull / game.st.hullMax;
  if (game.ship.alive && hullFrac < 0.35) {
    const a = (0.35 - hullFrac) * 1.4 * (0.7 + Math.sin(game.time * 5) * 0.3);
    const g = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.35, vw / 2, vh / 2, vh * 0.75);
    g.addColorStop(0, 'transparent');
    g.addColorStop(1, `rgba(200, 20, 20, ${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }
}
