import { CFG, PROG, SHIP_HIT_FRAC, fieldFrac } from './config.js';
import { predictPaths, PARRY_FLICK } from './physics.js';
import { volleyPick } from './tractor.js';
import { TAU, angDiff, lerp, mulberry32, shellModal, senseBlind, crystalShards } from './util.js';

let canvas, ctx, vw, vh, dpr, rdpr;
let radarCanvas, rctx;   // the radar draws into its own canvas so CSS can tilt it in 3D
// RENDER SCALE: the world canvas's backing store as a fraction of native device
// pixels. Draw cost is fill-bound — measured ~1.4ms fixed + ~0.18ms per
// megapixel on a fast GPU, far worse on old integrated parts — and #game is
// CSS-stretched to the window (style.css), so shrinking the backing store only
// SOFTENS the image while cutting the fill term quadratically. main.js owns the
// value (a persisted setting, plus auto-degrade); this is just where it lands.
let renderScale = 1;
let resizeCanvas = null;   // initRender's resize(), re-runnable when the scale moves
let armedSet = null;   // orbiters the shotgun charge has armed this frame
const starLayers = [];   // parallax background stars
const oortShards = [];   // tumbling ice shards in banded shells beyond the world edge

export function initRender(cv) {
  canvas = cv;
  // alpha:false — the first fill each frame paints the whole canvas opaque,
  // so an opaque backbuffer is visually identical and skips compositor blending
  ctx = canvas.getContext('2d', { alpha: false });
  const resize = () => {
    rdpr = Math.min(2, window.devicePixelRatio || 1);   // native, capped
    dpr = rdpr * renderScale;                           // what the WORLD is drawn at
    // A zero-sized window (hidden pane, minimized-at-launch shell) must never
    // reach the math: vw=vh=0 makes cam.zoom 0 and mouseWorld 0/0 -> NaN aim,
    // which NaN-poisons the ship and then (via the ship-anchored local
    // spawner) the whole sim. Fall back to a nominal size until a real one.
    vw = window.innerWidth || 1280; vh = window.innerHeight || 720;
    // vw/vh stay CSS pixels — cam.zoom, viewR, mouseWorld and every /zoom UI
    // stroke are derived from them, so render scale can never reach the sim.
    // Rounded (and floored at 1) because a fractional scale yields fractional
    // backing sizes and a 0-wide canvas is the NaN trap above wearing a hat.
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
    // THE RADAR DELIBERATELY STAYS AT NATIVE dpr. It is 200x200 CSS px — under
    // 2% of the world canvas's pixels even at dpr 2 — so scaling it saves
    // nothing measurable, while its content is 1px dots and hairline ticks that
    // are the first thing to turn to mush. Downscale the picture, not the
    // instruments. (This is also why nothing has to invalidate the dot cache
    // below on a scale change: its resolution never moves.)
    radarCanvas.width = radarCanvas.height = RADAR_SIZE * rdpr;
  };
  radarCanvas = document.getElementById('radar');
  rctx = radarCanvas.getContext('2d');   // alpha kept: the world shows through around the disc
  resizeCanvas = resize;
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

// Set the world canvas's backing-store fraction (1 = native). Re-runs the whole
// sizing path rather than poking canvas.width directly, so every derived thing
// (the zero-size guard, the radar's own sizing) is re-established from one
// place. Safe to call BEFORE initRender — the first resize() picks it up.
export function setRenderScale(s) {
  const v = Math.max(0.25, Math.min(1, +s || 1));
  if (v === renderScale) return;
  renderScale = v;
  if (resizeCanvas) resizeCanvas();
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

// The frame's world matrix, kept as three numbers (it is always a uniform
// scale + translate — no rotation, no skew). blitRock composes a body's
// rotate/translate straight into a single setTransform off these instead of
// paying save/translate/rotate/restore per rock, then restores the world
// matrix from the same numbers. Written ONLY here, so a later change to the
// projection (dpr, a render-scale factor) can never leave the blit stale.
// `now` rides along because the atlas needs a wall clock and blitRock runs
// ~1800 times a frame — sampling performance.now() per rock is real money.
const wt = { k: 1, e: 0, f: 0, now: 0 };

function worldTransform(game, shakeX, shakeY) {
  const { cam } = game;
  wt.k = dpr * cam.zoom;
  wt.e = dpr * (vw / 2 - cam.x * cam.zoom + shakeX);
  wt.f = dpr * (vh / 2 - cam.y * cam.zoom + shakeY);
  wt.now = performance.now() / 1000;
  ctx.setTransform(wt.k, 0, 0, wt.k, wt.e, wt.f);
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

// ---------------------------------------------------------------------------
// ROCK SILHOUETTE ARCHETYPES
//
// Rock shapes USED to be unique per body (mulberry32 off b.id), which meant
// ~8000 distinct polygons and nothing that could ever be cached: in a dense
// shoal the renderer rebuilt a 7-16 vertex path TWICE per rock (once to fill,
// once to clip the crater pits inside) — measured at ~31 canvas calls and
// ~7.5us of pure submission per rock, with clip the most expensive of them.
//
// Small rocks now draw from a BOUNDED set of shapes so they can be baked into
// the sprite atlas below. The quantization is deliberate and it is the only
// fidelity cost of the whole optimization. It applies to EVERY rock under the
// last bucket edge AT ANY ZOOM, including the ones the atlas declines and the
// vector path draws — a silhouette that changed as you flew in would morph,
// and the crack clip and the scar edge sampler both read b.jag, so there can
// only be one shape per rock. What carries it is not small drawn size but the
// per-body rotation, the exact per-body radius, and how shallow the jag is
// (amplitude 0.06-0.13 of the radius): 24 archetypes read as "all different"
// even on a boulder. Big rock — giants, monoliths, the bodies you steer a
// shoal by — is EXEMPT (rockBucket returns -1 past the last bucket edge) and
// keeps a unique silhouette, because those are few and you get close enough
// to them to tell.
//
// The archetype IS b.jag, not a parallel table: traceAsteroid, the damage
// crack clip and the scar edge sampler all read b.jag, so a shape that existed
// only inside the sprite would make cracks and bites sit off the drawn edge.
// ---------------------------------------------------------------------------
const ROCK_ARCHS = 24;   // silhouettes per size bucket. MUST stay a multiple of
                         // 3: the crater COUNT is `2 + (id % 3)` and the bake
                         // keys it off `arch % 3` instead, so every rock keeps
                         // exactly the pit count it has today.
// Upper radius edge / representative radius of each size bucket. The original
// shape math (vertex count, jag amplitude) is a continuous function of radius;
// it is evaluated once per bucket at the representative radius instead. So a
// rock that CHIPS across an edge steps its silhouette instead of easing it
// (amplitude 0.060/0.077/0.101/0.131, vertices 8/9/10/11) — the steps are
// under 0.03r and only land on a real damage event, which is already a
// visible moment. That is the honest cost of bucketing, not a bug.
const ROCK_BUCKET_MAX = [3.5, 5.5, 8, 11];
const ROCK_BUCKET_R = [2.6, 4.5, 6.7, 9.4];
const archJags = [];   // [bucket * ROCK_ARCHS + arch] -> jag array

function rockBucket(r) {
  for (let i = 0; i < ROCK_BUCKET_MAX.length; i++) if (r <= ROCK_BUCKET_MAX[i]) return i;
  return -1;
}

// SHARED, never mutated: the returned array is handed to every body in the
// bucket as its b.jag. Writing through b.jag would reshape hundreds of rocks.
function archJag(arch, bk) {
  const i = bk * ROCK_ARCHS + arch;
  let j = archJags[i];
  if (!j) {
    const R = ROCK_BUCKET_R[bk];
    const t = Math.min(1, Math.max(0, (R - 3) / 27));   // 0 pebble -> 1 boulder
    const n = 7 + Math.min(9, Math.round(R * 0.45));
    const amp = 0.06 + 0.3 * t;
    const rng = mulberry32(arch * 7919 + 13);
    j = [];
    for (let k = 0; k < n; k++) j.push(1 - amp + rng() * amp * 2);
    archJags[i] = j;
  }
  return j;
}

// Asteroids are jagged polygons, not discs — and the bigger the rock, the
// craggier the silhouette (pebbles stay nearly round, boulders are gnarled).
// The vertex offsets are cached on the body and regenerated if the radius
// changes (chip damage shrinks rocks), which is also what re-buckets a rock
// that has shed its way down a size class.
function traceAsteroid(b) {
  if (!b.jag || b.jagR !== b.radius) {
    let bk;
    if (b.carved) {
      // The carved stone: a perfect hexagon — machined, not tumbled
      b.jag = [1, 1, 1, 1, 1, 1];
    } else if ((bk = rockBucket(b.radius)) >= 0) {
      b.jag = archJag(b.id % ROCK_ARCHS, bk);
    } else {
      // Big rock keeps a one-of-a-kind silhouette (see the header above)
      const t = Math.min(1, Math.max(0, (b.radius - 3) / 27));
      const n = 7 + Math.min(9, Math.round(b.radius * 0.45));
      const amp = 0.06 + 0.3 * t;
      const rng = mulberry32(b.id * 7919 + 13);
      const pts = [];
      for (let i = 0; i < n; i++) pts.push(1 - amp + rng() * amp * 2);
      b.jag = pts;
    }
    b.jagR = b.radius;
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

// ---------------------------------------------------------------------------
// ROCK SPRITE ATLAS
//
// Small rocks are pre-baked — silhouette WITH ITS CRATER PITS ALREADY IN THE
// PIXELS — and drawn with one blit: setTransform + drawImage + setTransform,
// 3 canvas calls instead of ~31, no path build and no clip. In a dense shoal
// that is 71.6k canvas calls a frame down to 9.3k.
//
// IT MUST BE ONE SHEET PER TIER, NOT A CANVAS PER SPRITE, AND THE SHEET MUST
// BE KEPT YOUNG. Both rules are worth more than the optimization itself, and
// each was a measured catastrophe first:
//   - The first cut cached ~240 individual little canvases and it was a 2x
//     REGRESSION. In the shoal, 1778 blits cost 22ms from separate canvases
//     against 2.4ms from a single source. One sheet, one texture, one upload.
//   - A canvas that has sat unused goes rotten AS A DRAW SOURCE. Idle the
//     sheet for three seconds (fly close in, where the size cap puts rocks
//     back on vectors) and the next wide shot costs 582ms instead of 42 —
//     every blit re-uploads the whole sheet. Copying the sheet into a FRESH
//     canvas restores it completely (7.7ms, against 13.2 for vectors), so a
//     sheet is re-published the first frame it is used after a GAP.
//     ImageBitmap does NOT fix it (601ms — measured); a fresh canvas does.
//   - A published sheet is never written to again, for the same reason: adding
//     a row to the canvas rocks are already blitting FROM took the frame from
//     8ms to 375ms. New rows are baked into the incoming copy instead. Rows
//     hold the SHEET, not its canvas, so a swap reaches every one of them.
//
// SIZE CAP. Sprites are used only while a rock draws SMALL — up to
// SPRITE_TIERS' last tier over the headroom. Above that the vector path is
// measurably FASTER (a rotated, filtered blit costs more raster than filling a
// small polygon: at ~25px radius, 25us a rock against 4us), the rock count on
// screen is low enough not to matter, and a sheet with cells that big would
// cost tens of MB. So: many tiny rocks blit, few big rocks keep the exact old
// path — which is also where zoom would expose a sprite. Nothing ever goes
// mushy: past the cap you are on vectors.
//
// The tier is chosen from the DRAWN device size, so cam.zoom and dpr are both
// baked into which sheet gets asked for. A dpr change (retina, or a runtime
// render-scale setting) simply asks for a different tier — there is no stale
// state to invalidate.
// ---------------------------------------------------------------------------
const SPRITE_HEAD = 1.2;     // resolution headroom over the drawn size
// Bake radii in device px; the last one sets the size cap. TWO tiers, not
// more: a third small tier would cut the minification on 1-2px pebbles (they
// come off the 8 sheet), but a wide shot spans both tiers at once, so it buys
// a second live source for a difference that is invisible in a shoal — before
// and after screenshots of the same 1845-rock frame are indistinguishable.
const SPRITE_TIERS = [8, 16];
const SPRITE_EXT = 1.25;     // cell half-width in body radii (the jag peaks at ~1.15)
// Rows are bucket x colour. Four buckets against the handful of small-rock
// colours (belt grey, boulder rust, cored, ice, junk) already fills 16, and
// the whole win rests on one sheet per tier — so this carries real headroom
// rather than sitting exactly on the count a mixed scene needs.
const ATLAS_ROWS = 20;
const ATLAS_REFRESH = 0.25;  // a gap this long in a sheet's use re-publishes it
const ATLAS_BUDGET = 8 << 20;// hard ceiling on sheet backing store (see rockRow)
let atlasSheets = [];        // live sheets — 2 tiers x 0.6/2.5 MB in practice
let openSheet = new Map();   // tier -> the sheet still taking rows
let atlasRows = new Map();   // 'tier|bucket|colour' -> the row descriptor below

// Bake one row: every archetype of one (bucket, colour) at one tier, laid out
// left to right so the blit's source x is just arch * cell.
function bakeRow(c, sh, row, bk, color) {
  const px = sh.px, cell = sh.cell;
  for (let arch = 0; arch < ROCK_ARCHS; arch++) {
    const jag = archJag(arch, bk);
    const n = jag.length;
    c.save();
    c.translate(arch * cell + cell / 2, row * cell + cell / 2);
    c.scale(px, px);   // cell space == body-radius space: the bake is resolution-agnostic
    const trace = () => {
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const x = Math.cos(a) * jag[i], y = Math.sin(a) * jag[i];
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
    };
    c.fillStyle = color;
    trace(); c.fill();
    // The pits, clipped to the silhouette — the same geometry the vector path
    // draws, paid once per sheet instead of once per rock per frame.
    c.save();
    trace(); c.clip();
    c.fillStyle = 'rgba(0,0,0,0.25)';
    // arch stands in for b.id here. ROCK_ARCHS is a multiple of 3, so
    // `arch % 3` IS `id % 3` and every rock keeps its own pit count.
    const cn = 2 + (arch % 3);
    for (let i = 0; i < cn; i++) {
      const a = i * 2.4 + arch;
      c.beginPath();
      c.arc(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.22, 0, TAU);
      c.fill();
    }
    c.restore();
    c.restore();
  }
}

// Publish a new copy of the sheet: a BRAND NEW canvas takes a copy of the
// outgoing one, `bake` (if any) adds to it, and the sheet swaps. The live
// canvas is therefore only ever WRITTEN while it is not yet live, and it is
// always young. The canvas really must be new — recycling a spare that was
// live a moment ago carries the rot straight back (measured: ping-ponging two
// canvases left the frame at 812ms, a fresh one at 8ms), so whatever Chromium
// drops here belongs to the canvas OBJECT, not to its pixels.
function publishSheet(sh, bake, now) {
  const cv = document.createElement('canvas');
  cv.width = sh.w; cv.height = sh.h;
  const c = cv.getContext('2d');
  if (sh.cv) c.drawImage(sh.cv, 0, 0);
  if (bake) bake(c);
  sh.cv = cv; sh.used = now;
}

function rockRow(tier, bk, color, now) {
  const key = tier + '|' + bk + '|' + color;
  let r = atlasRows.get(key);
  if (r) return r;
  // The open sheet is looked up PER TIER: a shared "most recent sheet" spawns a
  // fresh one every time the zoom crosses a tier boundary and back.
  let sh = openSheet.get(tier);
  if (!sh || sh.next >= ATLAS_ROWS) {
    // Rows are (bucket x colour) and rock colours are a small fixed set, so in
    // practice one sheet per tier covers a run. A world that keeps minting new
    // ones would otherwise grow the atlas without limit: past the budget the
    // whole thing is dropped and rebuilt from what the next frames ask for —
    // a few row bakes, and the memory is bounded by construction.
    let bytes = 0;
    for (const s of atlasSheets) bytes += s.w * s.h * 4;
    if (bytes > ATLAS_BUDGET) { atlasSheets = []; openSheet = new Map(); atlasRows = new Map(); }
    const cell = Math.round(2 * tier * SPRITE_EXT);
    sh = { cv: null, px: tier, cell, w: ROCK_ARCHS * cell, h: ATLAS_ROWS * cell, next: 0, used: 0 };
    atlasSheets.push(sh);
    openSheet.set(tier, sh);
  }
  const row = sh.next++;
  publishSheet(sh, (c) => bakeRow(c, sh, row, bk, color), now);
  // ext: the cell's half-width measured in body radii. Rounding `cell` to a
  // whole pixel moves it off SPRITE_EXT, and blitting at the nominal extent
  // would scale every rock by up to half a texel.
  r = { sh, cell: sh.cell, sy: row * sh.cell, ext: sh.cell / (2 * sh.px) };
  atlasRows.set(key, r);
  return r;
}

// Atlas occupancy, for perf work — the sheet count and what they cost in
// backing store. Import it from the console
// (`(await import('/src/render.js')).rockCacheStats()`).
export function rockCacheStats() {
  let bytes = 0;
  for (const sh of atlasSheets) bytes += sh.w * sh.h * 4;
  return { sheets: atlasSheets.length, rows: atlasRows.size, bytes };
}

// Blit a baked rock, or return false to let the caller draw it as vectors.
// One setTransform composes the world matrix with the body's translate+rotate;
// the second puts the world matrix back, so every pass after this sees exactly
// the transform it did before (the save/restore pairing rule, met by restoring
// the matrix we own rather than pushing a state we would have to pop).
// PRECONDITION: the caller is already in the world matrix. This restores `wt`,
// not whatever matrix it was handed, and `wt` is only valid once
// worldTransform has run for the frame.
function blitRock(game, b) {
  const bk = rockBucket(b.radius);
  if (bk < 0) return false;                  // big rock keeps its unique silhouette
  const need = b.radius * game.cam.zoom * dpr * SPRITE_HEAD;
  let tier = 0;
  for (const t of SPRITE_TIERS) if (t >= need) { tier = t; break; }
  if (!tier) return false;                   // drawn too big: vectors (see the size cap)
  // WALL clock (stamped once a frame in worldTransform), not game.time: this
  // guards a canvas-backing lifetime, which keeps ticking while the sim is
  // frozen behind a menu. The re-publish is triggered by a GAP in use, not by
  // a timer — a sheet drawn from every frame stays hot and pays nothing, and
  // one that went quiet (flew in close, or sat behind a menu) is renewed once
  // on the frame it comes back.
  const now = wt.now;
  const r = rockRow(tier, bk, b.color, now);
  const sh = r.sh;
  if (now - sh.used > ATLAS_REFRESH) publishSheet(sh, null, now);
  sh.used = now;
  const k = wt.k;
  const cs = Math.cos(b.rot) * k, sn = Math.sin(b.rot) * k;
  ctx.setTransform(cs, sn, -sn, cs, k * b.x + wt.e, k * b.y + wt.f);
  const w = 2 * b.radius * r.ext;
  ctx.drawImage(r.sh.cv, (b.id % ROCK_ARCHS) * r.cell, r.sy, r.cell, r.cell, -w / 2, -w / 2, w, w);
  ctx.setTransform(k, 0, 0, k, wt.e, wt.f);
  return true;
}

// Draw an asteroid's body. Returns true when the crater pits are already on
// screen (baked into the sprite, or drawn inline here) so drawBody's pit pass
// can skip it. The carved stone returns false — it gets facet lines, not pits.
function drawRock(game, b) {
  if (b.carved) { traceAsteroid(b); ctx.fill(); return false; }
  if (blitRock(game, b)) return true;
  traceAsteroid(b);
  ctx.fill();
  // Pits clipped to the silhouette. fill() does not consume the path, so the
  // polygon just filled is reused for the clip — the old code traced the same
  // 7-16 vertices a second time to get it.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  // The pit ANGLES must be the ones the sheet baked, or the same rock crossing
  // the size cap (a tier-up zoom ramp, or chipping down a size class) visibly
  // re-shuffles its craters while its outline stays put — the silhouette is
  // seamless across the crossover, which would make the pit hop the only tell.
  // bakeRow keys them off the archetype, so a bucketed rock does the same here.
  // Big rock is never baked and keeps its own id, exactly as it always has.
  // The pit COUNT already agrees: ROCK_ARCHS is a multiple of 3.
  const seed = rockBucket(b.radius) >= 0 ? b.id % ROCK_ARCHS : b.id;
  const n = 2 + (b.id % 3);
  for (let i = 0; i < n; i++) {
    const a = b.rot + (i * 2.4) + seed;
    ctx.beginPath();
    ctx.arc(b.x + Math.cos(a) * b.radius * 0.45, b.y + Math.sin(a) * b.radius * 0.45,
      b.radius * 0.22, 0, TAU);
    ctx.fill();
  }
  ctx.restore();   // also puts fillStyle back to b.color for the passes below
  return true;
}

// CRYSTAL WORLDS are jagged, not round: the seeded shard polygon
// (util.crystalShards — SHARED with physics, which collides against the same
// table) stands in for the disc everywhere the silhouette matters (base
// fill, surface-detail clip, terminator clip), so shading and detail follow
// the spikes — and what you see IS what rocks and the ship bounce off.
function traceCrystal(b) {
  const sh = (b.cjag ||= crystalShards(b.id));
  ctx.beginPath();
  for (let i = 0; i < sh.pts.length; i++) {
    const p = sh.pts[i];
    const vx = b.x + Math.cos(b.rot + p.a0) * b.radius * p.ri;
    const vy = b.y + Math.sin(b.rot + p.a0) * b.radius * p.ri;
    if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
    ctx.lineTo(b.x + Math.cos(b.rot + p.tip) * b.radius * p.ro,
      b.y + Math.sin(b.rot + p.tip) * b.radius * p.ro);
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
  let pitsDone = false;   // set by drawRock — see the pit pass further down
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

  // Terran worlds carry a thin sunlit atmosphere — a calm, steady blue rim
  // (real object state → solid gradient, no motion; same idiom as lava's glow)
  if (b.ptype === 'terran') {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.85, b.x, b.y, b.radius * 1.45);
    g.addColorStop(0, 'rgba(120, 190, 255, 0)');
    g.addColorStop(0.25, 'rgba(120, 190, 255, 0.25)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.45, 0, TAU); ctx.fill();
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

  // RE-ENTRY: a rock burning in a terran atmosphere streams fire opposite its
  // motion through the air (physics stamps reentryT/reentryAng each substep
  // it burns; the timer fades once clear). The comet-tail idiom: solid
  // gradient stroke + head glow, no dashes.
  if (b.reentryT > 0) {
    // time fade x DEPTH fade (reentryK) — the streak grows with the burn, so
    // there is no visible switch-on at the shell's outer radius
    const k = Math.min(1, b.reentryT / 0.22) * (b.reentryK ?? 1);
    const len = b.radius * (2 + 4 * (b.reentryK ?? 1));
    const tx = b.x - Math.cos(b.reentryAng) * len;
    const ty = b.y - Math.sin(b.reentryAng) * len;
    const tg = ctx.createLinearGradient(b.x, b.y, tx, ty);
    tg.addColorStop(0, `rgba(255, 190, 90, ${0.65 * k})`);
    tg.addColorStop(1, 'transparent');
    ctx.strokeStyle = tg;
    ctx.lineWidth = b.radius * 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.lineCap = 'butt';
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.3, b.x, b.y, b.radius * 2.2);
    g.addColorStop(0, `rgba(255, 160, 60, ${0.5 * k})`);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.2, 0, TAU); ctx.fill();
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

  // DUST MOONS trail their concealing halo — a soft brown gradient with slow
  // drifting specks seeded off the id. Drawn WIDER than the stealth radius
  // (2.9 vs CFG.DUST_HALO 2.4) so the gradient IS the boundary read: no ring
  // stroke at the exact mechanic radius, no hard edges in-world.
  // SHROUD PLANETS trail their concealing cloud haze — the dust-moon read at
  // planet scale: the gradient reaches 2.1x, WIDER than the cloak mechanic
  // (CFG.SHROUD_HALO 1.7), so the fade IS the boundary; no ring at the edge.
  if (b.type === 'planet' && b.ptype === 'shroud') {
    const R = b.radius * 2.1;
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.9, b.x, b.y, R);
    g.addColorStop(0, 'rgba(201, 189, 122, 0.13)');
    g.addColorStop(0.6, 'rgba(201, 189, 122, 0.08)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
  }

  if (b.type === 'moon' && b.moonType === 'dust') {
    const R = b.radius * 2.9;
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.8, b.x, b.y, R);
    g.addColorStop(0, 'rgba(116, 109, 101, 0.16)');
    g.addColorStop(0.6, 'rgba(116, 109, 101, 0.10)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(150, 140, 128, 0.35)';
    for (let i = 0; i < 7; i++) {
      const a = b.id * 1.7 + i * 2.399 + game.time * (0.05 + (i % 3) * 0.02);
      const rr = b.radius * (1.3 + (((b.id + i * 13) % 10) / 10) * 1.3);
      ctx.beginPath();
      ctx.arc(b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr, Math.max(0.8, b.radius * 0.05), 0, TAU);
      ctx.fill();
    }
  }

  ctx.fillStyle = b.color;
  if (b.visitor) {
    drawVisitorSprite(b);
  } else if (b.cache) {
    drawCacheSprite(game, b);
  } else if (b.core) {
    drawCoreSprite(game, b);
  } else if (b.pod) {
    drawPodSprite(game, b);
  } else if (b.chunk) {
    drawChunkSprite(b);
  } else if (b.type === 'asteroid') {
    // drawRock draws the pits too (baked into the sprite, or clipped inline),
    // so the pit pass further down is told to stand off.
    pitsDone = drawRock(game, b);
    if (b.cored) drawCoreGlint(game, b);   // the vein TWINKLES — never bakeable
  } else if (b.ghost) {
    drawGhostSprite(game, b);
  } else if (b.tinker) {
    drawBargeSprite(game, b);
  } else if (b.type === 'station') {
    drawStationSprite(b);
  } else if (b.type === 'nest') {
    drawNestSprite(game, b);
  } else if (b.dark) {
    drawDarkStarSprite(b);
  } else if (b.type === 'planet' && b.ptype === 'crystal') {
    traceCrystal(b);   // jagged facet silhouette instead of a disc
    ctx.fill();
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
  } else if (b.type === 'asteroid' && !b.visitor && !b.pod && !b.chunk && !pitsDone) {
    // Only the asteroid-typed bodies that drew a DIFFERENT sprite reach here —
    // salvage caches and freed cores, which have always worn a pit overlay
    // clipped to an asteroid silhouette they never drew. Plain rock is handled
    // inside drawRock (pitsDone), where the pits are baked or share its path.
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

  // Day/night shading away from the nearest star. The dark star is exempt:
  // a sun-facing terminator on "a hole in the starfield" contradicts its
  // uniform absorption-rim read.
  const st = nearestStar(game, b.x, b.y);
  if (st && b.type !== 'asteroid' && b.type !== 'station' && b.type !== 'nest' && !b.dark) {
    const ang = Math.atan2(b.y - st.y, b.x - st.x);
    ctx.save();
    // Crystal worlds clip to their jagged silhouette so the night side
    // shades the spikes too (an unshaded spike tip reads as a stray mark)
    if (b.ptype === 'crystal') traceCrystal(b);
    else { ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); }
    ctx.clip();
    ctx.fillStyle = 'rgba(2, 4, 14, 0.5)';
    ctx.beginPath();
    // 1.2 on crystal: the shade disc reaches for the tall shard tips (a tip
    // near the terminator may escape it — a crystal edge catching stray
    // light reads as intended, not as a bug)
    ctx.arc(b.x + Math.cos(ang) * b.radius * 0.55, b.y + Math.sin(ang) * b.radius * 0.55,
      b.radius * (b.ptype === 'crystal' ? 1.2 : 1.05), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // CRYSTAL LIGHTING: the jagged worlds catch the sun. Two additive layers,
  // both clipped to the shard silhouette: a lit sunward LIMB (steady rim
  // light), and per-shard facet SHEENS that brighten as their tip swings
  // through the sun line and shimmer softly — light playing across facets,
  // not sparkle sprites (the four-point crosses read as UI, and were cut).
  if (b.type === 'planet' && b.ptype === 'crystal' && st) {
    const sunA = Math.atan2(st.y - b.y, st.x - b.x);   // toward the star
    ctx.save();
    traceCrystal(b);   // also (re)builds the cached b.cjag shard table
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    // Lit limb: a soft gradient hugging the sunward edge
    const lx = b.x + Math.cos(sunA) * b.radius, ly = b.y + Math.sin(sunA) * b.radius;
    const rim = ctx.createRadialGradient(lx, ly, 0, lx, ly, b.radius * 1.5);
    rim.addColorStop(0, 'rgba(235, 220, 255, 0.32)');
    rim.addColorStop(0.45, 'rgba(190, 160, 255, 0.12)');
    rim.addColorStop(1, 'transparent');
    ctx.fillStyle = rim;
    ctx.beginPath(); ctx.arc(lx, ly, b.radius * 1.5, 0, TAU); ctx.fill();
    // Facet sheen: alignment (facet toward sun, cubed for a tight highlight)
    // x a slow shimmer — as the world turns, the flare walks shard to shard
    for (let i = 0; i < b.cjag.pts.length; i++) {
      const p2 = b.cjag.pts[i];
      const ta = b.rot + p2.tip;
      const align = Math.max(0, Math.cos(ta - sunA));
      if (align < 0.25) continue;
      const shim = 0.55 + 0.45 * Math.sin(game.time * 1.3 + i * 2.1 + b.id);
      const k = align * align * align * shim;
      if (k < 0.05) continue;
      const gx = b.x + Math.cos(ta) * b.radius * p2.ro * 0.8;
      const gy = b.y + Math.sin(ta) * b.radius * p2.ro * 0.8;
      const gr = b.radius * 0.34;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      g.addColorStop(0, `rgba(240, 228, 255, ${0.5 * k})`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(gx, gy, gr, 0, TAU); ctx.fill();
    }
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

  // Progressive damage: crack web + impact scars + near-death ember fissures
  if (b.maxHp !== Infinity && (b.hp < b.maxHp || (b.scars && b.scars.length))) {
    drawBodyDamage(game, b);
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
// what makes the planet TYPES readable: bands = gas (three gasKind looks),
// cracks+glow = lava, caps = ice, continents = rocky, seas+clouds = terran,
// currents = ocean, dunes = desert, sheared decks = shroud, facets = crystal.
// All geometry is seeded off b.id (stable frame to frame — no Math.random),
// and every ambient drift rides multiples of b.rot, never wall-clock time.
function drawPlanetDetail(b) {
  ctx.save();
  // Crystal worlds clip to the jagged silhouette so facet detail fills the spikes
  if (b.ptype === 'crystal') traceCrystal(b);
  else { ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU); }
  ctx.clip();
  ctx.translate(b.x, b.y);
  // The surface turns under the fixed star-lit terminator (drawn after this in
  // drawBody) — that rotation IS the day/night cycle. Ice and terran caps are
  // polar, so those frames stay put (they rotate their surface internally);
  // everything else rides b.rot.
  if (b.ptype !== 'ice' && b.ptype !== 'terran') ctx.rotate(b.rot);

  if (b.ptype === 'gas') {
    ctx.rotate(b.id % 2 ? 0.32 : -0.26);
    const kind = b.gasKind || 'amber';
    if (kind === 'azure') {
      // Ice giant: few wide soft bands under a bright polar hood — the calm,
      // featureless read of a methane haze (vs the amber giant's busy stripes)
      const n = 3 + (b.id % 2);
      const bandH = (2 * b.radius) / n;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(0,10,40,0.13)';
        ctx.fillRect(-b.radius, -b.radius + i * bandH, b.radius * 2, bandH * 0.85);
      }
      ctx.fillStyle = 'rgba(220, 245, 255, 0.22)';
      ctx.beginPath(); ctx.ellipse(0, -b.radius * 0.8, b.radius * 0.8, b.radius * 0.3, 0, 0, TAU); ctx.fill();
    } else if (kind === 'violet') {
      // Exotic giant: irregular thin/thick band stacking — turbulent, alien
      let yy = -b.radius, i = 0;
      while (yy < b.radius) {
        const h = b.radius * (0.14 + (((b.id + i) % 4) / 4) * 0.22);
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.14)' : 'rgba(25,0,45,0.2)';
        ctx.fillRect(-b.radius, yy, b.radius * 2, h * 0.78);
        yy += h; i++;
      }
    } else {
      const n = 5 + (b.id % 3);
      const bandH = (2 * b.radius) / n;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.17)';
        ctx.fillRect(-b.radius, -b.radius + i * bandH, b.radius * 2, bandH * 0.72);
      }
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
      // A great storm spot — dark on the hazy azure giant, bright elsewhere
      ctx.fillStyle = kind === 'azure' ? 'rgba(10, 25, 60, 0.4)' : 'rgba(255,255,255,0.22)';
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
  } else if (b.ptype === 'terran') {
    // Living world: green continents ride the spin…
    ctx.save();
    ctx.rotate(b.rot);
    ctx.fillStyle = 'rgba(140, 195, 110, 0.6)';
    const n = 4 + (b.id % 3);
    for (let i = 0; i < n; i++) {
      const a = b.id * 2.1 + i * 2.4;
      const rr = b.radius * (0.2 + ((b.id + i) % 4) * 0.08);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * b.radius * 0.5, Math.sin(a) * b.radius * 0.5, rr, rr * 0.62, a, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // …under cloud decks that drift a touch FASTER than the surface (weather
    // shears past the ground — the multiple of b.rot is the drift, no clock)
    ctx.save();
    ctx.rotate(b.rot * 1.18);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (let i = 0; i < 5; i++) {
      const a = b.id * 1.3 + i * 2.7;
      const rr = b.radius * (0.3 + ((b.id + i) % 3) * 0.12);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * b.radius * 0.45, Math.sin(a) * b.radius * 0.45, rr, rr * 0.3, a + 0.5, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // …with small polar caps pinned to the poles, like the ice worlds'
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.ellipse(0, -b.radius * 0.86, b.radius * 0.55, b.radius * 0.2, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, b.radius * 0.86, b.radius * 0.55, b.radius * 0.2, 0, 0, TAU); ctx.fill();
  } else if (b.ptype === 'ocean') {
    // World-sea: bright current bands sweep the globe…
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.28)';
    ctx.lineWidth = Math.max(1.2, b.radius * 0.05);
    for (let i = 0; i < 4; i++) {
      const yy = -b.radius * 0.66 + i * b.radius * 0.44;
      ctx.beginPath();
      ctx.moveTo(-b.radius, yy);
      ctx.quadraticCurveTo(0, yy + b.radius * 0.18 * (i % 2 ? 1 : -1), b.radius, yy);
      ctx.stroke();
    }
    // …around a scatter of low archipelago flecks — land is the exception here
    ctx.fillStyle = 'rgba(120, 160, 110, 0.6)';
    const n = 5 + (b.id % 4);
    for (let i = 0; i < n; i++) {
      const a = b.id * 1.7 + i * 2.4;
      const rr = b.radius * (0.05 + ((b.id + i) % 3) * 0.03);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * b.radius * 0.55, Math.sin(a) * b.radius * 0.55, rr, rr * 0.7, a, 0, TAU);
      ctx.fill();
    }
  } else if (b.ptype === 'desert') {
    // Dune seas: long wind-carved bands…
    ctx.strokeStyle = 'rgba(90, 55, 25, 0.22)';
    ctx.lineWidth = Math.max(1.5, b.radius * 0.07);
    for (let i = 0; i < 5; i++) {
      const yy = -b.radius * 0.7 + i * b.radius * 0.35;
      ctx.beginPath();
      ctx.moveTo(-b.radius, yy);
      ctx.quadraticCurveTo(0, yy + b.radius * 0.14 * (i % 2 ? 1 : -1), b.radius, yy + b.radius * 0.06);
      ctx.stroke();
    }
    // …dark rimrock mesas…
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    for (let i = 0; i < 3; i++) {
      const a = b.id * 2.3 + i * 2.1;
      const rr = b.radius * (0.14 + ((b.id + i) % 3) * 0.06);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * b.radius * 0.6, Math.sin(a) * b.radius * 0.6, rr, rr * 0.55, a, 0, TAU);
      ctx.fill();
    }
    // …and one pale standing dust storm
    ctx.fillStyle = 'rgba(255, 235, 200, 0.3)';
    const sa = b.id * 1.3;
    ctx.beginPath();
    ctx.ellipse(Math.cos(sa) * b.radius * 0.35, Math.sin(sa) * b.radius * 0.35, b.radius * 0.34, b.radius * 0.16, sa, 0, TAU);
    ctx.fill();
  } else if (b.ptype === 'shroud') {
    // Venusian shroud: total cloud cover, no surface ever visible. Each deck
    // turns at its own rate (multiples of b.rot on top of the base spin), so
    // the cover visibly shears without any wall-clock animation.
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.rotate(b.rot * (0.55 + i * 0.3) + b.id * 1.7 + i * 2.1);
      ctx.strokeStyle = i % 2 ? 'rgba(255, 250, 220, 0.2)' : 'rgba(120, 100, 40, 0.18)';
      ctx.lineWidth = b.radius * (0.16 + (i % 3) * 0.05);
      ctx.beginPath();
      ctx.arc(0, 0, b.radius * (0.28 + i * 0.2), b.id + i, b.id + i + 4.2);
      ctx.stroke();
      ctx.restore();
    }
    // a pale chevron where the decks collide
    ctx.fillStyle = 'rgba(255, 252, 230, 0.16)';
    ctx.beginPath();
    ctx.ellipse(b.radius * 0.1, -b.radius * 0.2, b.radius * 0.5, b.radius * 0.18, -0.4, 0, TAU);
    ctx.fill();
  } else if (b.ptype === 'crystal') {
    // Faceted lattice: alternating light/dark shard wedges from the core…
    // (reach 1.4r — past the tallest ~1.32r shard tips, so the clip decides
    // the edge)
    for (let i = 0; i < 6; i++) {
      const a = b.id * 1.9 + i * (TAU / 6) + ((b.id + i) % 3) * 0.3;
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.12)' : 'rgba(30, 10, 60, 0.18)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * b.radius * 1.4, Math.sin(a) * b.radius * 1.4);
      ctx.lineTo(Math.cos(a + 0.7) * b.radius * 1.4, Math.sin(a + 0.7) * b.radius * 1.4);
      ctx.closePath();
      ctx.fill();
    }
    // …with bright facet seams (solid strokes — machined work, like the
    // carved stone, never dashed)…
    ctx.strokeStyle = 'rgba(230, 210, 255, 0.5)';
    ctx.lineWidth = Math.max(1, b.radius * 0.035);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = b.id * 2.3 + i * 1.26;
      ctx.moveTo(Math.cos(a) * b.radius * 0.2, Math.sin(a) * b.radius * 0.2);
      ctx.lineTo(Math.cos(a + 0.4) * b.radius * 1.3, Math.sin(a + 0.4) * b.radius * 1.3);
    }
    ctx.stroke();
    // …and a few bright glint points where facets catch the light (seeded,
    // static — the cored-rock glint twinkles because it marks salvage; a
    // world's sparkle is ambient state, so it holds still)
    ctx.fillStyle = 'rgba(240, 225, 255, 0.55)';
    for (let i = 0; i < 4; i++) {
      const a = b.id * 1.3 + i * 1.9;
      const rr = b.radius * (0.3 + ((b.id + i) % 3) * 0.22);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, Math.max(1, b.radius * 0.035), 0, TAU);
      ctx.fill();
    }
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

// Progressive damage, drawn in the SURFACE frame (translate + rotate b.rot) so
// wounds ride the day/night spin, clipped to the silhouette. Three layers:
//  - a seeded crack web whose count/length/width grow with lost hp — the rng
//    sequence is consumed identically every frame, so cracks never swim, and
//    each new crack eases in (grow) instead of popping;
//  - persistent impact craters (b.scars, minted by physics.damageBody when a
//    hit sheds chunks): a dark bite at the rim with fracture rays fanning
//    inward, fading in over a beat;
//  - past 55% damage, ember light leaks from the deepest cracks (icy worlds
//    leak cold blue instead) — the crust is failing.
// Solid strokes only — this is a real object, not helper UI.
function drawBodyDamage(game, b) {
  const dmg01 = 1 - b.hp / b.maxHp;
  const R = b.radius;
  ctx.save();
  if (b.type === 'asteroid') traceAsteroid(b);
  else { ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); }
  ctx.clip();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);

  // Crack web: jagged fissures running INWARD from the rim (impacts fracture
  // from the surface, so chords across the middle read wrong). Geometry is
  // rebuilt each frame from the same seeded rolls — stable, never swims — and
  // shared with the ember pass below via crackPaths.
  const prog = (dmg01 - 0.04) * 14;   // hairlines from ~4% damage — wear shows early
  const cracks = prog > 0 ? crackPaths(b, R, prog) : null;
  if (cracks && cracks.length) {
    ctx.strokeStyle = `rgba(0,0,0,${0.24 + 0.28 * dmg01})`;
    ctx.lineWidth = Math.max(0.8, R * 0.028) * (0.7 + 0.5 * dmg01);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const pts of cracks) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    }
    ctx.stroke();
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  }

  // Near death the deepest fissures glow from within (same geometry as the
  // dark pass — the light leaks from inside the cracks, not beside them)
  if (dmg01 > 0.55 && cracks && cracks.length) {
    const icy = b.ptype === 'ice' || b.moonType === 'ice';
    const heat = (dmg01 - 0.55) / 0.45;
    const breathe = 0.85 + 0.15 * Math.sin(game.time * 1.8 + b.id);
    // more fissures ignite as death approaches
    const nGlow = Math.max(2, Math.ceil(cracks.length * (0.3 + 0.7 * heat)));
    const glowPath = () => {
      ctx.beginPath();
      for (let i = 0; i < Math.min(cracks.length, nGlow); i++) {
        const pts = cracks[i];
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      }
    };
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // soft halo first, bright core inside it — light leaking FROM the crack
    ctx.strokeStyle = icy
      ? `rgba(110, 190, 255, ${0.3 * heat * breathe})`
      : `rgba(255, 110, 40, ${0.34 * heat * breathe})`;
    ctx.lineWidth = Math.max(1.5, R * 0.055);
    glowPath(); ctx.stroke();
    ctx.strokeStyle = icy
      ? `rgba(200, 240, 255, ${0.7 * heat * breathe})`
      : `rgba(255, 205, 120, ${0.75 * heat * breathe})`;
    ctx.lineWidth = Math.max(0.8, R * 0.02);
    glowPath(); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  // Scar bites — drawn UNCLIPPED so each crater visibly punches a chunk out
  // of the silhouette: an opaque space-toned jagged blob straddling the rim
  // (the missing material), a pale cliff-face lip on its inner edge, and
  // fracture rays fanning into the body. Angles are surface-local, so bites
  // ride the day/night spin like everything else.
  if (b.scars && b.scars.length) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    for (const sc of b.scars) {
      const k = Math.min(1, (game.time - sc.t) * 3);   // quick fade-in
      const br = Math.max(2.2, R * 0.06 * sc.s);       // floor so pebble bites still read
      // Rocks aren't circles: sample the jag/shard silhouette at the scar's
      // local angle so the bite sits ON the edge (vertex i lives at local
      // angle i/n·TAU — same mapping as traceAsteroid/drawChunkSprite).
      let edge = 1;
      const poly = b.chunk ? b.shard : b.jag;
      if (b.type === 'asteroid' && poly) {
        let ai = sc.a % TAU; if (ai < 0) ai += TAU;
        edge = poly[Math.round((ai / TAU) * poly.length) % poly.length];
      }
      // centered a hair OUTSIDE the rim so it reads as a notch eaten out of
      // the edge, never a blob floating on the face
      const cd = R * edge + br * 0.15;
      const cxp = Math.cos(sc.a) * cd, cyp = Math.sin(sc.a) * cd;
      // organic bite mouth — two sin harmonics per vertex, stable per scar
      const NV = 10;
      ctx.fillStyle = `rgba(4, 6, 13, ${k})`;          // the space behind shows through
      ctx.beginPath();
      for (let v = 0; v < NV; v++) {
        const va = (v / NV) * TAU;
        const h = Math.sin(b.id * 7.7 + sc.t * 13.3 + v * 2.1) * 0.14
          + Math.sin(sc.t * 5.9 + v * 4.7) * 0.08;
        const vr = br * (0.92 + h);
        const px = cxp + Math.cos(va) * vr, py = cyp + Math.sin(va) * vr;
        if (v === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      // pale exposed cliff face along the bite's inner edge
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.14 * k})`;
      ctx.lineWidth = Math.max(0.8, br * 0.18);
      ctx.beginPath();
      ctx.arc(cxp, cyp, br * 0.95, sc.a + Math.PI - 1.0, sc.a + Math.PI + 1.0);
      ctx.stroke();
      // fracture rays fanning inward from the wound
      ctx.strokeStyle = `rgba(0, 0, 0, ${0.3 * k})`;
      ctx.lineWidth = Math.max(0.8, R * 0.022);
      ctx.beginPath();
      for (let r2 = 0; r2 < 3; r2++) {
        const ra = sc.a + Math.PI + (r2 - 1) * 0.5 + Math.sin(b.id * 3.3 + sc.t * 7.1 + r2 * 5.7) * 0.22;
        ctx.moveTo(cxp + Math.cos(ra) * br * 0.6, cyp + Math.sin(ra) * br * 0.6);
        ctx.lineTo(cxp + Math.cos(ra) * R * (0.28 + 0.13 * r2) * sc.s,
          cyp + Math.sin(ra) * R * (0.28 + 0.13 * r2) * sc.s);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

// Build the seeded crack polylines for a body at damage progress `prog`
// (fractional crack count). Every crack's rolls are consumed in the same order
// every frame regardless of prog, so existing cracks never move as new ones
// open; the newest crack eases outward (grow) instead of popping. Points are
// SURFACE-LOCAL (caller has translated/rotated into the body frame). Each
// fissure starts at the rim and stress-walks inward with angular jitter, with
// a short side-branch once it's fully open.
function crackPaths(b, R, prog) {
  const rng = mulberry32(b.id * 5077 + 7);
  const MAXC = 8;
  const out = [];
  for (let i = 0; i < MAXC; i++) {
    const a0 = rng() * TAU;
    const len = R * (0.32 + rng() * 0.34);
    const drift = (rng() - 0.5) * 1.1;
    const j1 = rng() - 0.5, j2 = rng() - 0.5, j3 = rng() - 0.5;
    const brSide = rng() < 0.5 ? -1 : 1, brAt = 0.35 + rng() * 0.3;
    if (i >= prog) continue;                       // rolled but not yet open
    const grow = Math.min(1, prog - i);
    const jags = [0, j1, j2, j3];
    const pts = [];
    for (let k = 0; k <= 3; k++) {
      const t = (k / 3) * grow;
      const r = R * 0.985 - len * t;
      const a = a0 + drift * t * 0.35 + jags[k] * 0.22;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    out.push(pts);
    if (grow >= 1) {                               // side-branch off the midline
      const t = brAt;
      const r = R * 0.985 - len * t;
      const a = a0 + drift * t * 0.35;
      const ba = a + brSide * (0.5 + Math.abs(j2) * 0.5);
      const br2 = r - len * 0.3;
      out.push([[Math.cos(a) * r, Math.sin(a) * r], [Math.cos(ba) * br2, Math.sin(ba) * br2]]);
    }
  }
  return out;
}

// A PLANET CHUNK: a shard of a wounded or destroyed world. Reads as a piece of
// that world, not a belt rock: sharp angular fracture faces (darker than the
// surface — freshly split interior), with a bright strip of the old crust
// surviving along one edge in the world's own color. Shape is seeded off b.id
// and cached like the asteroid jag.
function drawChunkSprite(b) {
  const R = b.radius;
  if (!b.shard || b.shardR !== R) {
    const rng = mulberry32(b.id * 3163 + 41);
    const n = 6 + Math.floor(rng() * 3);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(0.55 + rng() * 0.65);   // sharper than a tumbled rock
    b.shard = pts; b.shardR = R;
    b.crustAt = Math.floor(rng() * n);   // which run of edges keeps the old surface
  }
  const n = b.shard.length;
  const vx = (i) => Math.cos((i / n) * TAU) * R * b.shard[((i % n) + n) % n];
  const vy = (i) => Math.sin((i / n) * TAU) * R * b.shard[((i % n) + n) % n];
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  const shard = () => {
    ctx.beginPath();
    ctx.moveTo(vx(0), vy(0));
    for (let i = 1; i < n; i++) ctx.lineTo(vx(i), vy(i));
    ctx.closePath();
  };
  // fracture faces: the world's color, knocked down — split rock, not surface
  ctx.fillStyle = b.color;
  shard(); ctx.fill();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  shard(); ctx.fill();
  // surviving crust: a bright strip of the old surface along one edge run
  ctx.save();
  shard(); ctx.clip();
  ctx.strokeStyle = b.color;
  ctx.lineWidth = R * 0.42;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(vx(b.crustAt), vy(b.crustAt));
  ctx.lineTo(vx(b.crustAt + 1), vy(b.crustAt + 1));
  ctx.lineTo(vx(b.crustAt + 2), vy(b.crustAt + 2));
  ctx.stroke();
  // one dark split line across the interior — the fracture that freed it
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = Math.max(0.8, R * 0.08);
  ctx.beginPath();
  ctx.moveTo(vx(b.crustAt) * 0.55, vy(b.crustAt) * 0.55);
  ctx.lineTo(vx(b.crustAt + Math.floor(n / 2)) * 0.85, vy(b.crustAt + Math.floor(n / 2)) * 0.85);
  ctx.stroke();
  ctx.restore();
  ctx.restore();
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

// A mayday escape pod: a REAL little spacecraft, not a UI token — a gumdrop
// re-entry capsule with a charred ablative shield, panel seams, a dark
// viewport, orange rescue striping (paint on the hull, not interface), and a
// beacon mast that tumbles WITH the hull. The strobe's blink RATE rises as
// the air runs out — the urgency read lives on the object itself.
function drawPodSprite(game, b) {
  const r = b.radius;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  const hull = () => {
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, -r * 0.7);
    ctx.quadraticCurveTo(r * 0.5, -r * 0.6, r * 0.95, -r * 0.16);
    ctx.quadraticCurveTo(r * 1.04, 0, r * 0.95, r * 0.16);
    ctx.quadraticCurveTo(r * 0.5, r * 0.6, -r * 0.6, r * 0.7);
    ctx.closePath();
  };
  hull();
  ctx.fillStyle = '#aab3bd';
  ctx.fill();
  ctx.save();
  hull();
  ctx.clip();
  // belly shade — a lit 3D body, not a flat disc
  ctx.fillStyle = 'rgba(20, 28, 40, 0.35)';
  ctx.fillRect(-r, r * 0.12, r * 2.2, r);
  // orange rescue striping near the stern — real-spacecraft paint
  ctx.fillStyle = 'rgba(226, 128, 64, 0.85)';
  ctx.save();
  ctx.rotate(-0.18);
  ctx.fillRect(-r * 0.5, -r, r * 0.16, r * 2);
  ctx.fillRect(-r * 0.18, -r, r * 0.16, r * 2);
  ctx.restore();
  // panel seams
  ctx.strokeStyle = 'rgba(60, 72, 86, 0.55)';
  ctx.lineWidth = Math.max(0.6, r * 0.06);
  ctx.beginPath();
  ctx.moveTo(r * 0.16, -r * 0.6); ctx.lineTo(r * 0.16, r * 0.6);
  ctx.moveTo(r * 0.62, -r * 0.42); ctx.lineTo(r * 0.62, r * 0.42);
  ctx.stroke();
  ctx.restore();
  // hull rim so it pops against space
  hull();
  ctx.strokeStyle = 'rgba(210, 220, 235, 0.5)';
  ctx.lineWidth = Math.max(0.7, r * 0.06);
  ctx.stroke();
  // charred ablative shield capping the stern
  ctx.fillStyle = '#463e37';
  ctx.beginPath(); ctx.ellipse(-r * 0.62, 0, r * 0.22, r * 0.72, 0, 0, TAU); ctx.fill();
  // viewport: dark glass, thin bright rim
  ctx.fillStyle = '#141e2a';
  ctx.beginPath(); ctx.arc(r * 0.42, -r * 0.06, r * 0.24, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(220, 235, 245, 0.6)';
  ctx.lineWidth = Math.max(0.6, r * 0.07);
  ctx.beginPath(); ctx.arc(r * 0.42, -r * 0.06, r * 0.24, 0, TAU); ctx.stroke();
  // beacon mast + strobe (rate = urgency; same idiom as the ghost heartbeat)
  ctx.strokeStyle = '#6d7683';
  ctx.lineWidth = Math.max(0.8, r * 0.08);
  ctx.beginPath(); ctx.moveTo(r * 0.85, -r * 0.22); ctx.lineTo(r * 1.22, -r * 0.5); ctx.stroke();
  const urgency = 1 - Math.max(0, Math.min(1, (b.podT || 0) / 120));
  const rate = 1.5 + urgency * 6;
  if (Math.sin(game.time * TAU * rate * 0.5) > 0) {
    ctx.fillStyle = 'rgba(120, 255, 170, 0.25)';
    ctx.beginPath(); ctx.arc(r * 1.22, -r * 0.5, r * 0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8affc0';
    ctx.beginPath(); ctx.arc(r * 1.22, -r * 0.5, Math.max(1, r * 0.16), 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// The Wanderer's Star: a hole in the starfield — near-black disc, a deep
// violet rim, and an absorption halo DARKER than space. Deliberately no glow:
// this is the one body drawn by what it swallows.
function drawDarkStarSprite(b) {
  const R = b.radius;
  const halo = ctx.createRadialGradient(b.x, b.y, R * 0.8, b.x, b.y, R * 2.6);
  halo.addColorStop(0, 'rgba(4, 2, 10, 0.85)');
  halo.addColorStop(1, 'transparent');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(b.x, b.y, R * 2.6, 0, TAU); ctx.fill();
  ctx.fillStyle = '#241f2e';
  ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(120, 90, 200, 0.35)';
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.stroke();
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
  if (b.awake) {
    // Resolved (a wreck delivered): lights returned deck by deck — a steady
    // warm lamp and a row of lit portholes. Solid fills, and deliberately NO
    // idle motion: the calm steadiness IS the "alive again" read.
    ctx.fillStyle = '#ffd98a';
    ctx.beginPath(); ctx.arc(r * 0.9, 0, Math.max(2, r * 0.12), 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255, 214, 140, 0.75)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath(); ctx.arc(i * r * 0.5, r * 0.02, Math.max(1.2, r * 0.07), 0, TAU); ctx.fill();
    }
  } else {
    // slow heartbeat running light (matches the audible ping cadence loosely)
    const lit = Math.sin(game.time * 1.8) > 0.92;
    ctx.fillStyle = lit ? '#ff6a5a' : '#4a2e2c';
    ctx.beginPath(); ctx.arc(r * 0.9, 0, Math.max(2, r * 0.12), 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// The Tinker Barge: a boxy crewed tug — warm lit windows against the dead
// grey derelicts are the "this one is alive" tell — with its current want
// held up as a little glyph over the hull. All solid strokes: a real object.
function drawBargeSprite(game, b) {
  const r = b.radius;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  // hull block + forward wheelhouse + cargo pods aft
  ctx.fillStyle = '#8a7350';
  ctx.fillRect(-r * 1.5, -r * 0.55, r * 2.6, r * 1.1);
  ctx.fillStyle = '#c9a86a';
  ctx.fillRect(r * 0.7, -r * 0.75, r * 0.9, r * 1.5);
  ctx.fillStyle = '#6e5c42';
  for (let i = 0; i < 3; i++) ctx.fillRect(-r * 1.4 + i * r * 0.75, -r * 0.95, r * 0.55, r * 0.4);
  ctx.strokeStyle = '#e8d9b8';
  ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.strokeRect(-r * 1.5, -r * 0.55, r * 2.6, r * 1.1);
  // warm crew windows
  ctx.fillStyle = '#ffd98a';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath(); ctx.arc(-r * 0.9 + i * r * 0.62, 0, Math.max(1, r * 0.09), 0, TAU); ctx.fill();
  }
  ctx.restore();
  drawBargeWant(game, b);
}

// The want glyph bobbing over the barge: purple crystal / pale ice hex / grey
// wreck slab / satellite cross. Hidden while the barge rests between trades.
function drawBargeWant(game, b) {
  const want = game.tinkerWant;
  if (!want || game.tinkerCd > 0) return;
  const z = game.cam.zoom;
  const s = Math.max(6, b.radius * 0.55);
  const gx = b.x, gy = b.y - b.radius * 2.2 + Math.sin(game.time * 1.6) * 3;
  ctx.save();
  ctx.translate(gx, gy);
  ctx.lineWidth = 2 / z;
  if (want.id === 'crystal') {
    ctx.fillStyle = 'rgba(185, 140, 255, 0.9)';
    ctx.beginPath();
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.7, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.7, 0);
    ctx.closePath(); ctx.fill();
  } else if (want.id === 'ice') {
    ctx.strokeStyle = 'rgba(191, 227, 242, 0.95)';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU - Math.PI / 2;
      const px = Math.cos(a) * s * 0.8, py = Math.sin(a) * s * 0.8;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.stroke();
  } else if (want.id === 'wreck') {
    ctx.fillStyle = 'rgba(159, 176, 194, 0.9)';
    ctx.fillRect(-s, -s * 0.35, s * 2, s * 0.7);
    ctx.strokeStyle = 'rgba(159, 176, 194, 0.9)';
    ctx.beginPath(); ctx.moveTo(-s, s * 0.35); ctx.lineTo(-s * 1.4, s * 0.8); ctx.stroke();
  } else {   // junk: a dead satellite — body box + solar panels
    ctx.fillStyle = 'rgba(159, 176, 194, 0.9)';
    ctx.fillRect(-s * 0.3, -s * 0.3, s * 0.6, s * 0.6);
    ctx.fillRect(-s * 1.1, -s * 0.18, s * 0.7, s * 0.36);
    ctx.fillRect(s * 0.4, -s * 0.18, s * 0.7, s * 0.36);
  }
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

const PTYPE_LABELS = {
  lava: 'LAVA WORLD', rocky: 'ROCKY WORLD', gas: 'GAS GIANT', ice: 'ICE WORLD',
  terran: 'TERRAN WORLD', ocean: 'OCEAN WORLD', desert: 'DESERT WORLD',
  shroud: 'SHROUDED WORLD', crystal: 'CRYSTAL WORLD',
};

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
      : b.tinker ? ('TINKER BARGE' + (game.tinkerWant && !(game.tinkerCd > 0)
        ? ' — WANTS ' + game.tinkerWant.label.toUpperCase() : ''))
      : (b.majorComet || b.visitor || b.shepherd || b.volcanic) ? (b.name || '').toUpperCase()
      : b.fort ? `BASTION FORTRESS${b.name ? ' — ' + b.name.toUpperCase() : ''}`
      : b.type === 'rogue' ? 'ROGUE PLANET'
      : b.type === 'station' ? (b.name || 'Derelict Station').toUpperCase()
      : b.type === 'nest' ? 'ALIEN NEST'
      : b.dark ? (b.hidden ? 'UNRESOLVED MASS — SENSOR NULL' : `${b.name.toUpperCase()} — DWARF STAR`)
      : `${(b.name || 'PLANET').toUpperCase()} — ${b.gasKind === 'azure' ? 'ICE GIANT' : PTYPE_LABELS[b.ptype] || 'PLANET'}`
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
    // BRAWLER's War Plating covers the FRONT ARC only (st.shieldArc < PI), so
    // every shield visual — glow, recharge sweep, absorb ripple — is confined
    // to the covered wedge and the bare tail reads at a glance.
    //
    // THE EDGES MUST FEATHER, NOT CUT. A single pie clip ended the glow on two
    // dead-straight radial lines, which read as a UI mask laid over the ship —
    // the in-world design law is that boundaries are organic, never geometric
    // (same reason WORLD_R has no drawn edge). Instead the visuals are drawn
    // inside NESTED wedges: every layer shares the nose bearing, the widest
    // reaches the true coverage edge and the narrowest covers the core, so the
    // accumulated alpha is flat across the middle and ramps to nothing exactly
    // AT the mechanical edge. The fade never claims coverage the sim doesn't
    // give — it just stops announcing it with a straight line.
    const arc = game.st.shieldArc ?? Math.PI;
    const partial = arc < Math.PI - 0.01;
    // Layer count is a SMOOTHNESS knob, not a look knob: each layer boundary is
    // a step in the angular alpha, and at 8 they were faintly visible as
    // banding when zoomed right in. 16 puts each step near the limit of what
    // 8-bit alpha can show. Cost stays trivial because the gradient is hoisted.
    const LAYERS = partial ? 16 : 1;
    // Fraction of the wedge that stays at full strength before the feather
    // begins; the rest ramps out to the edge.
    const CORE = 0.4;
    // Stacking N layers at 1/N alpha with source-over lands at 1-(1-1/N)^N,
    // not 1 — without this the plate would read ~35% dimmer than a full wrap.
    const layerComp = partial ? 1 / (1 - Math.pow(1 - 1 / LAYERS, LAYERS)) : 1;
    // Hoisted out of the layer loop: the gradient depends on the ship position,
    // not the wedge, so building it once keeps the feather nearly free.
    let glowGrad = null;
    if (sf > 0.02) {
      const col = sf > 0.6 ? '130, 225, 255' : sf > 0.3 ? '150, 190, 255' : '205, 150, 255';
      let a = (0.12 + 0.30 * sf) * layerComp;
      if (sf < 0.3) a *= 0.6 + 0.4 * Math.sin(game.time * 26);
      glowGrad = ctx.createRadialGradient(s.x, s.y, R * 0.7, s.x, s.y, R * 1.1);
      glowGrad.addColorStop(0, 'transparent');
      glowGrad.addColorStop(0.8, `rgba(${col}, ${a * 0.8})`);
      glowGrad.addColorStop(1, 'transparent');
    }
    // (Shield down = nothing drawn at all: a naked hull IS the indicator.
    // The HUD bar's blinking SHLD label carries the alarm.)
    // st.regenDelay, not the CFG base: Rapid Recharge shortens the delay, and
    // the sweep must appear the moment the recharge actually starts (hud.js
    // gates its charging shimmer on the same stat).
    const charging = s.alive && sf < 1 &&
      game.time - game.lastDamage > game.st.regenDelay;
    const sweepT = (game.time % 0.8) / 0.8;
    const hitK = s.shieldHitT > 0 ? 1 - s.shieldHitT / 0.35 : -1;
    for (let li = 0; li < LAYERS; li++) {
      ctx.save();
      if (partial) {
        // Widest layer last-but-one to first — every layer is centred on the
        // nose, so they nest and the overlap count IS the angular falloff.
        const half = arc * (CORE + (1 - CORE) * ((li + 1) / LAYERS));
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.arc(s.x, s.y, R * 2.6, s.angle - half, s.angle + half);
        ctx.closePath();
        ctx.clip();
        ctx.globalAlpha = 1 / LAYERS;
      }
      // A calm, steady bubble: just a soft volumetric rim glow. No dashes
      // (that's helper-UI language) and no moving parts (distracting) —
      // motion is reserved for EVENTS: recharge sweeps and absorb ripples.
      if (glowGrad) {
        ctx.fillStyle = glowGrad;
        ctx.beginPath(); ctx.arc(s.x, s.y, R * 1.1, 0, TAU); ctx.fill();
      }
      if (charging) {
        ctx.strokeStyle = `rgba(140, 230, 255, ${0.5 * sweepT * layerComp})`;
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath(); ctx.arc(s.x, s.y, R * (1.7 - 0.7 * sweepT), 0, TAU); ctx.stroke();
      }
      if (hitK >= 0) {
        ctx.strokeStyle = `rgba(220, 245, 255, ${(1 - hitK) * 0.9 * layerComp})`;
        ctx.lineWidth = 3 / z;
        ctx.beginPath(); ctx.arc(s.x, s.y, R * (1 + hitK * 0.55), 0, TAU); ctx.stroke();
        ctx.fillStyle = `rgba(150, 225, 255, ${(1 - hitK) * 0.16 * layerComp})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
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

  // Shoal lurker: a rock-toned splinter — camouflage is the whole trick, so
  // at a prowl it reads as just another field rock (belt-rock greys, dull
  // outline). On the hunt the carapace seams and eye slit light up crimson.
  if (al.kind === 'lurker') {
    // "Hunting" must MIRROR ai.js updateLurker's engaged test (ship distance
    // to the field anchor + alive + can it be sensed at all) — measuring the
    // LURKER's own anchor distance lit the crimson eye during the camouflaged
    // prowl (it orbits the anchor, trivially inside territory), and kept it
    // lit at a cloaked ship the AI had actually lost. senseBlind covers BOTH
    // blinding causes (dust/shroud halo and a live solar wave), which is
    // exactly why it's a shared leaf helper — the eye must go dark for both.
    const f = game.fields && game.fields[al.field];
    const s = game.ship;
    const hunting = !f || (s.alive && !senseBlind(game) && fieldFrac(f, s.x, s.y) < 1.15);
    const r = al.radius;
    ctx.save();
    ctx.translate(al.x, al.y);
    // Nose along the velocity — it swims, it doesn't hover
    const sp = Math.hypot(al.vx, al.vy);
    ctx.rotate(sp > 4 ? Math.atan2(al.vy, al.vx) : al.angle);
    ctx.fillStyle = '#7d7566';
    ctx.strokeStyle = hunting ? '#d15a4a' : '#5f594e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r * 1.7, 0);                       // nose spike
    ctx.lineTo(r * 0.35, -r * 0.85);
    ctx.lineTo(-r * 0.5, -r * 1.05);              // dorsal spine
    ctx.lineTo(-r * 1.1, -r * 0.35);
    ctx.lineTo(-r * 1.3, 0);                      // tail
    ctx.lineTo(-r * 1.1, r * 0.35);
    ctx.lineTo(-r * 0.5, r * 1.05);               // ventral spine
    ctx.lineTo(r * 0.35, r * 0.85);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    if (hunting) {
      // Eye slit, pulsing hot while it hunts
      ctx.fillStyle = `rgba(255, 90, 70, ${0.6 + 0.4 * Math.sin(game.time * 9 + al.id)})`;
      ctx.fillRect(r * 0.45, -r * 0.22, r * 0.7, r * 0.44);
    }
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
  // ION WASH: a solar wave scrambles the forecast outright (CFG.STORM_ION).
  // Losing the plotter mid-wave is most of what makes being caught out in one
  // frightening — you are suddenly flying a gravity field you can't read.
  if (game.stormIonT > 0) return;
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

// The minimap is a SHIP-CENTERED RADAR: it shows the local neighborhood, not
// the whole system — worlds drift across it as you fly. Neon rim with bearing
// ticks, a slow rotating sweep and locator ping centered on you, your sensor
// bubble, and glowing blips. Fog of war (b.seen) still decides what is
// IDENTIFIED; the sun is an ordinary object on the map, drawn where it is at
// the size it is (never pinned to the rim — a fake sun in a direction you
// can't actually reach is a lie the pilot then flies by).
//
// TWO SCALES, one radius. The INNER half of the dial is the tactical picture
// at 1:1 with the old radar (MINIMAP_NEAR world units); the OUTER half is
// zoomed out 2x, so it covers TWICE the world span it used to (MINIMAP_RANGE
// more, out to MINIMAP_FAR) in the same pixels. Everything positional goes
// through radarR() — and because a radial warp turns world-space circles into
// non-circles, every ring around the sun is SAMPLED through it (worldCirclePath)
// instead of drawn with ctx.arc.
//
// The outer band is a SCAN, not a chart: blips there exist only for the second
// or so after the sweep line crosses them, and an unexplored contact shows as
// an anonymous gray dot — a return, not an identification. Fly closer (into
// the inner half) and it becomes a real, persistent blip.
const MINIMAP_RANGE = 5200;
const MINIMAP_NEAR = MINIMAP_RANGE / 2;              // inner half, unchanged scale
const MINIMAP_FAR = MINIMAP_NEAR + MINIMAP_RANGE;    // outer half at half scale
const MINIMAP_SWEEP_T = 7;                           // seconds per sweep revolution
const MINIMAP_PING_T = 1.1;                          // how long an outer contact lingers
const RADAR_SIZE = 200;   // CSS px of the #radar canvas (positioned + tilted by style.css)
// Offscreen cache for the dense-field dot layer (see the bake in drawMinimap)
let dotCanvas = null, dotCtx = null, dotBakeT = -1, dotBakeFx = 0, dotBakeFy = 0, dotBakeSeen = 0;
function drawMinimap(game) {
  // The radar has its OWN canvas so the DOM can tilt it on the 3D canopy —
  // shadow the module ctx with the radar context for this function's scope.
  const ctx = rctx;
  ctx.setTransform(rdpr, 0, 0, rdpr, 0, 0);   // native dpr: the dial never downscales
  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  const cx = RADAR_SIZE / 2, cy = RADAR_SIZE / 2;
  const r = 95;
  const rim = r - 4;                    // usable dial radius
  const mid = rim / 2;                  // the scale break, halfway out
  const scale = rim / MINIMAP_RANGE;    // inner-half px-per-world-unit (the old scale)
  // Radar origin: the ship, or the camera while the wreck drifts
  const fx = game.ship.alive ? game.ship.x : game.cam.x;
  const fy = game.ship.alive ? game.ship.y : game.cam.y;

  // The piecewise dial: 1x out to MINIMAP_NEAR, then half scale (MINIMAP_FAR
  // lands exactly on the rim). It stays CONTINUOUS past the rim rather than
  // clamping — a clamped sample smears along the rim as a false arc, whereas an
  // over-rim one just falls outside the clip. Range culling is done by distance.
  const radarR = (d) => d <= MINIMAP_NEAR ? d * scale
    : mid + (d - MINIMAP_NEAR) * scale * 0.5;
  // A world-space circle is NOT a circle once the radius is warped — sample it
  // and push every point through radarR so the ring says where the edge truly is.
  const worldCirclePath = (wx, wy, wr) => {
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * TAU;
      const dx = wx + Math.cos(a) * wr - fx, dy = wy + Math.sin(a) * wr - fy;
      const d = Math.hypot(dx, dy) || 1;
      const rr = radarR(d);
      const x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  };

  // Dark well with a faint lit horizon toward the top
  const bg = ctx.createRadialGradient(cx, cy - r * 0.6, r * 0.2, cx, cy, r);
  bg.addColorStop(0, 'rgba(20, 12, 40, 0.82)');
  bg.addColorStop(1, 'rgba(8, 4, 18, 0.88)');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // Grid: range rings + cross axes, barely-there
  ctx.strokeStyle = 'rgba(176, 112, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, mid * 0.5, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, mid + rim * 0.25, 0, TAU); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
  ctx.stroke();
  // …and the SCALE BREAK itself, dashed (helper-UI grammar) so the jump in
  // scale is something the eye can see rather than a lie about distance.
  ctx.strokeStyle = 'rgba(176, 112, 255, 0.28)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(cx, cy, mid, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);

  // Sensor bubble: how far the scan actually reveals (mirrors replenishWorld).
  // Centered on the ship = the radar center.
  if (game.ship.alive) {
    let seeW = Math.max(2600, (game.viewR || 1200) * 1.25) * (game.st.sensorMul || 1);
    // Awake-Herald beacon boost — MIRRORS the fog scan in world.js; the bubble
    // must not lie about the actual reveal radius.
    const gh = game.ghost;
    if (gh && gh.alive && gh.awake &&
        Math.hypot(gh.x - game.ship.x, gh.y - game.ship.y) < 6000) seeW *= 1.5;
    const seeR = radarR(seeW);
    ctx.fillStyle = 'rgba(176, 112, 255, 0.05)';
    ctx.beginPath(); ctx.arc(cx, cy, seeR, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(176, 112, 255, 0.22)';
    ctx.beginPath(); ctx.arc(cx, cy, seeR, 0, TAU); ctx.stroke();
  }

  // The sun sits at the world origin: the wave and the world edge both circle
  // it, sampled through the warp (the clip discards whatever falls outside).
  const dSun = Math.hypot(fx, fy);
  if (game.storm) {
    // The SHEATH, not just the shock — the dial has to show the thing you can
    // actually be caught in, and the shock alone is a hairline. Three rings
    // stepping back through the tail read as depth without a fill (which the
    // radial warp would distort into a lie about where the tail ends).
    for (let i = 3; i >= 1; i--) {
      const rr = game.storm.r - CFG.STORM_TAIL * (i / 3.4);
      if (rr <= 0) continue;
      ctx.strokeStyle = `rgba(255, 170, 90, ${0.06 + 0.04 * (3 - i)})`;
      ctx.lineWidth = 5;
      worldCirclePath(0, 0, rr); ctx.stroke();
    }
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 180, 80, 0.16)';
    worldCirclePath(0, 0, game.storm.r); ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 214, 130, 0.7)';
    ctx.lineWidth = 1.5;
    worldCirclePath(0, 0, game.storm.r); ctx.stroke();
    ctx.lineWidth = 1;
  }
  if (Math.abs(dSun - CFG.WORLD_R) < MINIMAP_FAR * 1.2) {
    // world edge: the icy band of the Oort wall with the ember kill line
    // at its foot — matches the wall's in-world reading
    ctx.strokeStyle = 'rgba(150, 200, 255, 0.18)';
    ctx.lineWidth = 7;
    worldCirclePath(0, 0, CFG.WORLD_R + 240); ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 130, 120, 0.5)';
    ctx.lineWidth = 1.5;
    worldCirclePath(0, 0, CFG.WORLD_R); ctx.stroke();
    ctx.lineWidth = 1;
  }
  // THE SUN, as a body and not a compass rose: drawn only when it is actually
  // within radar reach, at its true radius. (History: it used to pin to the rim
  // from anywhere as a homeward marker, which put a sun-coloured dot in a
  // direction where there was no sun.) Sampled through the warp like the rings —
  // straddling the scale break, its disc genuinely is pinched.
  {
    const sun = game.bodies.find(b => b.type === 'star' && b.alive);
    if (sun && dSun - sun.radius < MINIMAP_FAR) {
      ctx.fillStyle = 'rgba(255, 200, 105, 0.28)';
      worldCirclePath(sun.x, sun.y, sun.radius); ctx.fill();
      ctx.strokeStyle = 'rgba(255, 226, 150, 0.75)';
      ctx.lineWidth = 1.5;
      worldCirclePath(sun.x, sun.y, sun.radius); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // Radar sweep: a trailing glow wedge behind a bright leading edge, spinning
  // around the ship. Runs on game.time, so it freezes with the sim behind menus.
  const sweepAng = (game.time * TAU / MINIMAP_SWEEP_T) % TAU;
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
  // How far BEHIND the sweep line a bearing sits, in seconds since it was last
  // swept — the one time base both the inner flare and the outer ping read from.
  const sweepAge = (dx, dy) => {
    let lag = sweepAng - Math.atan2(dy, dx);
    lag %= TAU; if (lag < 0) lag += TAU;
    return lag * MINIMAP_SWEEP_T / TAU;
  };
  // INNER half: a blip FLARES as the beam crosses its bearing, then cools until
  // the next pass — the radar reads as actively scanning, not as a static chart.
  const sweepFlare = (age) => Math.min(1, 0.68 + 0.6 * Math.exp(-age * 2.24));
  // OUTER half: no persistence at all. A contact exists for MINIMAP_PING_T after
  // the beam touches it and then it's gone — out there the radar is a scan, not
  // a chart, which is what buys the doubled reach without the dial turning into
  // a wall of dots.
  const sweepPing = (age) => {
    if (age >= MINIMAP_PING_T) return 0;
    const k = 1 - age / MINIMAP_PING_T;
    return k * k;
  };

  // DENSE FIELDS: every field rock in radar range is a REAL return — the
  // dial shows the actual rocks (their true bearings and ranges, strays
  // included), not an artist's impression of the footprint. Still terrain,
  // not contacts: dim tan 1px squares, no glow, no boundary ring (a hard
  // outline would claim an edge the pocket doesn't have — the no-hard-edges
  // law read across to the dial). Each rock pings on ITS OWN bearing as the
  // sweep crosses it — one shared age made a pocket this wide strobe as a
  // single slab, and the beam physically reaches the near edge well before
  // the far one. Cost: one pass over bodies with an early `field == null`
  // reject (same shape as the blip loop below) and cheap fillRects — no
  // arcs, no shadowBlur.
  if (game.fields) {
    // THE DOT LAYER IS CACHED: ~1900 in-range rocks x (hypot + atan2 +
    // fillRect) per frame measured ~0.3-0.6ms, and a radar dot being a
    // fifteenth of a second stale is imperceptible — so the layer bakes into
    // an offscreen canvas at ~15Hz (or when the origin jumps, or a field's
    // fog flips, or the sim clock rewinds = resetRun) and composites here
    // for the price of one drawImage. The bright sweep LINE stays live below,
    // so the radar still reads as actively scanning; only the dots' fade
    // steps at bake rate. game.time drives the throttle so a paused sim
    // reuses the bake forever instead of rebaking a frozen picture.
    // Sized off rdpr, like the dial it composites into — mismatch it with the
    // world canvas's scaled dpr and a scale change would leave a bitmap baked
    // at one resolution being drawn through a transform built for another.
    if (!dotCanvas || dotCanvas.width !== RADAR_SIZE * rdpr) {
      dotCanvas = document.createElement('canvas');
      dotCanvas.width = dotCanvas.height = RADAR_SIZE * rdpr;
      dotCtx = dotCanvas.getContext('2d');
      dotBakeT = -1;
    }
    let seenMask = 0;
    for (let i = 0; i < game.fields.length; i++) if (game.fields[i].seen) seenMask |= 1 << i;
    if (game.time < dotBakeT || game.time - dotBakeT > 0.066 ||
        seenMask !== dotBakeSeen || Math.hypot(fx - dotBakeFx, fy - dotBakeFy) > 60) {
      dotBakeT = game.time; dotBakeFx = fx; dotBakeFy = fy; dotBakeSeen = seenMask;
      const dc = dotCtx;
      dc.setTransform(rdpr, 0, 0, rdpr, 0, 0);
      dc.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
      dc.fillStyle = '#a2937d';   // belt-rock tan: terrain, not the blip palette
      for (const b of game.bodies) {
        if (b.field == null || !b.alive) continue;
        const f = game.fields[b.field];
        if (!f || !f.seen) continue;   // fog of war: field-level, like the scan
        const dx = b.x - fx, dy = b.y - fy;
        const d = Math.hypot(dx, dy) || 1;
        if (d > MINIMAP_FAR) continue;
        const aDot = d > MINIMAP_NEAR ? sweepPing(sweepAge(dx, dy)) : sweepFlare(sweepAge(dx, dy));
        if (aDot <= 0.01) continue;
        dc.globalAlpha = aDot * (b.giant ? 0.95 : 0.6);
        const rr = radarR(d);
        const px = cx + (dx / d) * rr, py = cy + (dy / d) * rr;
        // giants read bigger — they're the landmarks you navigate the shoal by
        const sz = b.giant ? 2.6 : 1.2;
        dc.fillRect(px - sz / 2, py - sz / 2, sz, sz);
      }
      dc.globalAlpha = 1;
    }
    // Composite inside the dial clip; both canvases share the dpr transform.
    ctx.drawImage(dotCanvas, 0, 0, RADAR_SIZE, RADAR_SIZE);
    // Unexplored fields: one anonymous return out in the scan band and
    // nothing on the chart half — the same fog rule every contact obeys.
    // Four iterations — stays live, not worth baking.
    ctx.fillStyle = '#8a8f9c';
    for (const f of game.fields) {
      if (f.seen) continue;
      const fdx = f.x - fx, fdy = f.y - fy;
      const fd = Math.hypot(fdx, fdy) || 1;
      if (fd <= MINIMAP_NEAR || fd > MINIMAP_FAR) continue;
      const a0 = sweepPing(sweepAge(fdx, fdy));
      if (a0 <= 0.01) continue;
      const rr0 = radarR(fd);
      ctx.globalAlpha = a0 * 0.5;
      ctx.beginPath();
      ctx.arc(cx + (fdx / fd) * rr0, cy + (fdy / fd) * rr0, 1.5, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ION WASH (CFG.STORM_ION): a solar wave doesn't dim the radar, it EATS it.
  // Returns drop out at random and the survivors smear off their true bearing,
  // so the dial is actively lying rather than politely fading — losing the
  // instrument you navigate by is the point of being caught in a wave.
  // Math.random per blip on purpose: the dropout has to boil, and this is
  // render, which is downstream of the sim and owes it no determinism.
  const ion = Math.min(1, (game.stormIonT || 0) / CFG.STORM_ION);

  // Blips glow — shadowBlur is fine at these counts (a few dozen, once/frame)
  ctx.shadowBlur = 5;
  for (const b of game.bodies) {
    if (b.type === 'star') continue;               // drawn as a real disc, above
    if (ion > 0 && Math.random() < ion * 0.82) continue;
    const dx = b.x - fx, dy = b.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    if (d > MINIMAP_FAR) continue;                 // beyond radar range
    const outer = d > MINIMAP_NEAR;
    // Fog of war: a body is IDENTIFIED once it has come within sensor range
    // (b.seen, set by the replenishWorld scan). Unexplored contacts have no
    // place on the chart half of the dial at all; in the scan half they come
    // back as an anonymous return — something is out there, that's all. That
    // return is offered only for the kinds of thing the scan itself considers
    // findable — the type list MIRRORS world.js's fog scan, so belt rock never
    // fills the outer band with gray confetti, and b.hidden (the sensor-null
    // dark dwarf) still returns nothing at all: the relay's breadcrumb stays
    // the ONLY way to learn it exists.
    if (!b.seen && (!outer || b.hidden ||
      (b.type !== 'planet' && b.type !== 'moon' && b.type !== 'rogue' &&
        b.type !== 'station' && b.type !== 'nest' && !b.comet && !b.visitor))) continue;
    const alpha = outer ? sweepPing(sweepAge(dx, dy)) : sweepFlare(sweepAge(dx, dy));
    if (alpha <= 0.01) continue;
    const rr = radarR(d);
    let x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
    if (ion > 0) {   // the survivors smear off their true bearing
      x += (Math.random() - 0.5) * ion * 9;
      y += (Math.random() - 0.5) * ion * 9;
    }
    if (!b.seen) {
      // Unidentified return: gray, faint, uniform — never the body's own colour
      // or shape, or the scan would be charting what you haven't explored.
      ctx.globalAlpha = alpha * 0.5;
      ctx.shadowColor = '#8a8f9c';
      ctx.fillStyle = '#8a8f9c';
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, TAU); ctx.fill();
      continue;
    }
    ctx.globalAlpha = alpha;
    if (b.type === 'rogue') {
      ctx.shadowColor = '#b07aff';
      ctx.fillStyle = '#b07aff';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    } else if (b.type === 'planet') {
      // the dark star's own color is near-black — invisible on the radar well
      const col = b.dark ? '#b89aff'
        : b.ember > 0.01 && Math.sin(game.time * 4) > 0 ? '#ff8040' : b.color;
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
    } else if (b.tinker) {
      // the one friendly blip on the map — warm amber, matching its windows
      ctx.shadowColor = '#ffcf8a';
      ctx.fillStyle = '#ffcf8a';
      ctx.fillRect(x - 2, y - 2, 4, 4);
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
  // Aliens: hot red deltas. Hostiles obey the same two-scale law as everything
  // else — a steady contact once they're inside the tactical half, a ping-only
  // return while they're still out in the scan band.
  ctx.shadowColor = '#ff4a4a';
  ctx.fillStyle = '#ff4a4a';
  for (const al of game.aliens) {
    const dx = al.x - fx, dy = al.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    if (d > MINIMAP_FAR) continue;
    const age = sweepAge(dx, dy);
    const alpha = d > MINIMAP_NEAR ? sweepPing(age) : sweepFlare(age);
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    const rr = radarR(d);
    const x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
    ctx.beginPath();
    ctx.moveTo(x, y - 2.6); ctx.lineTo(x + 2.4, y + 2); ctx.lineTo(x - 2.4, y + 2);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // The revealed-but-uncharted Wanderer's Star pins to the rim like the sun
  // does — the relay's promise, pointing the pilgrimage. Retires once charted
  // (in range it's an ordinary seen-planet dot from the loop above).
  {
    const dk = game.darkStar;
    if (dk && dk.alive && dk.seen && !(game.charted && game.charted.wanderer)) {
      const dx = dk.x - fx, dy = dk.y - fy;
      const d = Math.hypot(dx, dy) || 1;
      if (d > MINIMAP_FAR) {
        const x = cx + (dx / d) * (r - 9), y = cy + (dy / d) * (r - 9);
        ctx.fillStyle = '#b89aff';
        ctx.beginPath();
        ctx.moveTo(x, y - 4); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 3, y);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  // Mayday pod: a blinking rescue cross with a tiny POD tag, rim-pinned when
  // out of range — the ping found it by ear; the radar keeps the bearing.
  // HIDDEN while the pod rides the player's beam: a marker for the thing
  // you're already carrying is noise, and the dock is all that matters then.
  if (game.mayday && game.mayday.alive && game.mayday.heldBy !== 'player') {
    const dx = game.mayday.x - fx, dy = game.mayday.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    const rr = Math.min(radarR(d), r - 9);
    const x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
    // mint-white, not nest-green: friendly-rescue must not share a hue with
    // the hostile-source blips
    if (Math.sin(game.time * 6) > -0.2) {
      ctx.strokeStyle = '#d8ffe8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
      ctx.stroke();
    }
    const lx = x - (dx / d) * 13, ly = y - (dy / d) * 13;   // tag pulled inward, never clipped
    ctx.font = '600 7px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(216, 255, 232, 0.75)';
    ctx.fillText('POD', lx, ly + 2.5);
    ctx.textAlign = 'left';
  }
  // …and the DROP-OFF: while the rescue is live, the radar runs a full
  // mission display for it — a guide line from the ship to the nearest
  // station, a pulsing ring converging on the marker, and a literal DOCK tag
  // (nothing is clearer than the word). Prefer a dock the player has
  // actually charted; if none is seen yet the pod's beacon vectors an unseen
  // one — a bearing only, never a map reveal (the station blip stays fogged).
  if (game.mayday && game.mayday.alive) {
    let dock = null, dd = Infinity, dockSeen = false;
    for (const b of game.bodies) {
      if (!b.alive || b.type !== 'station') continue;
      const d = Math.hypot(b.x - fx, b.y - fy);
      const seen = !!b.seen;
      if (dock && dockSeen && !seen) continue;   // never trade a seen dock for an unseen one
      if (!dock || (seen && !dockSeen) || d < dd) { dock = b; dd = d; dockSeen = seen; }
    }
    if (dock) {
      const dx = dock.x - fx, dy = dock.y - fy;
      const d = Math.hypot(dx, dy) || 1;
      const rr = Math.min(radarR(d), r - 9);
      const x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
      // guide line: "fly this way" — dim so the marker stays the star
      ctx.strokeStyle = 'rgba(216, 255, 232, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      // converging pulse pulls the eye into the marker
      const k = (game.time * 0.9) % 1;
      ctx.strokeStyle = `rgba(216, 255, 232, ${0.1 + 0.4 * k})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 13 - 9 * k, 0, TAU); ctx.stroke();
      // the dock itself: a bold ring + landing cross
      ctx.strokeStyle = '#d8ffe8';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 2.5, y); ctx.lineTo(x + 2.5, y);
      ctx.moveTo(x, y - 2.5); ctx.lineTo(x, y + 2.5);
      ctx.stroke();
      const lx = x - (dx / d) * 17, ly = y - (dy / d) * 17;   // tag pulled inward, never clipped
      ctx.font = '600 7px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(216, 255, 232, 0.95)';
      ctx.fillText('DOCK', lx, ly + 2.5);
      ctx.textAlign = 'left';
    }
  }

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

  // …and the noise the wave floods the dial with, over everything inside the
  // clip: rolling scan bars plus speckle. Drawn LAST so it sits on top of the
  // returns it is drowning, and still under the rim (the instrument's chrome
  // is intact — it's the signal that's gone).
  if (ion > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255, 190, 120, ${0.05 + 0.07 * ion})`;
    for (let i = 0; i < 3; i++) {
      const yy = ((game.time * (70 + i * 43) + i * 91) % (RADAR_SIZE + 40)) - 20;
      ctx.fillRect(0, yy, RADAR_SIZE, 3 + i);
    }
    ctx.fillStyle = `rgba(255, 226, 190, ${0.5 * ion})`;
    for (let i = 0; i < 34; i++) {
      if (Math.random() > ion) continue;
      ctx.fillRect(Math.random() * RADAR_SIZE, Math.random() * RADAR_SIZE, 1.5, 1.5);
    }
    ctx.globalCompositeOperation = 'source-over';
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

// ---------------------------------------------------------------------------
// THE SOLAR WAVE (CFG.STORM_*) — a shock front dragging a deep plasma sheath,
// drawn in world space over the bodies (the plasma is in FRONT of the sky).
//
// NO HARD EDGES, and this is the rule the old draw broke. The front is a clean
// circle in the SIM, and has to be — "am I in it?" must have a plain answer —
// but nothing here is drawn at one exact radius: the shock is displaced by
// three low harmonics of bearing plus a slow churn, the sheath dissolves over
// thousands of units, and the filaments are stochastic. What shipped before
// was literally ctx.arc at storm.r with a 90px stroke, which is the geometric
// in-world edge the house style forbids — and it read as decoration precisely
// because a perfect ring reads as UI.
//
// Cost is bounded by construction: nothing runs unless the sheath crosses the
// view, and every pass is clipped to the bearing window the camera can see —
// at a normal zoom that is a few degrees of a 40,000-unit circle.
const STORM_MOTES = 40;
function drawStormWave(game) {
  const hs = game.homeStar;
  if (!hs) return;
  const st = game.storm;
  const t = game.time;

  // ---- the CHARGE: the sun loading before it fires. This is the telegraph
  // the whole mechanic is fair because of, so it is deliberately loud — the
  // corona swells, prominences whip, and the light hardens toward white.
  if (game.stormChargeT > 0) {
    const k = 1 - game.stormChargeT / CFG.STORM_CHARGE;    // 0 -> 1 as it loads
    const dCamS = Math.hypot(view.cx - hs.x, view.cy - hs.y);
    // Kept TIGHT to the limb (~2x radius). A wide corona gradient is a flat
    // additive wash over the entire view at any normal flying distance — it
    // whited the game out instead of reading as the sun swelling. The far-field
    // half of the telegraph is the screen pulse in render(), not this.
    if (dCamS - view.r < hs.radius * 2.4) {
      ctx.globalCompositeOperation = 'lighter';
      const puls = 1 + 0.10 * Math.sin(t * (5 + 16 * k)) + 0.05 * Math.sin(t * 27);
      const rr = hs.radius * (1.12 + 0.95 * k) * puls;
      const cg = ctx.createRadialGradient(hs.x, hs.y, hs.radius * 0.92, hs.x, hs.y, rr);
      cg.addColorStop(0, `rgba(255, 252, 240, ${0.4 * k})`);
      cg.addColorStop(0.35, `rgba(255, 205, 120, ${0.22 * k})`);
      cg.addColorStop(0.75, `rgba(255, 120, 70, ${0.09 * k})`);
      cg.addColorStop(1, 'transparent');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(hs.x, hs.y, rr, 0, TAU); ctx.fill();
      // Prominences: loops of plasma standing off the limb, reaching further
      // and whipping faster the closer it gets to firing.
      ctx.lineCap = 'round';
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + t * 0.35 + i * 1.7;
        const reach = hs.radius * (0.18 + 0.75 * k) * (0.6 + 0.6 * Math.abs(Math.sin(t * 2.1 + i)));
        const x0 = hs.x + Math.cos(a) * hs.radius * 0.98, y0 = hs.y + Math.sin(a) * hs.radius * 0.98;
        const bow = a + 0.34;
        ctx.strokeStyle = `rgba(255, 210, 150, ${0.5 * k})`;
        ctx.lineWidth = hs.radius * 0.05;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(
          hs.x + Math.cos(a + 0.17) * (hs.radius + reach * 1.5),
          hs.y + Math.sin(a + 0.17) * (hs.radius + reach * 1.5),
          hs.x + Math.cos(bow) * hs.radius * 0.98,
          hs.y + Math.sin(bow) * hs.radius * 0.98);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  if (!st) return;
  const dCam = Math.hypot(view.cx - hs.x, view.cy - hs.y);
  const vR = view.r;
  const tail = st.r - CFG.STORM_TAIL, lead = st.r + CFG.STORM_BAND;
  // Whole view already swept clean, or the front hasn't reached it yet
  if (dCam + view.r < tail || dCam - view.r > lead) return;

  // The bearing window the camera can actually see, padded a touch so a
  // filament never pops in at the screen edge. Sun on screen => all of it.
  const sunClose = dCam <= view.r * 1.05;
  const midA = Math.atan2(view.cy - hs.y, view.cx - hs.x);
  const halfA = sunClose ? Math.PI
    : Math.min(Math.PI, Math.asin(Math.min(1, view.r / dCam)) + 0.14);
  const sd = st.seed || 0;
  // Bearing displacement of the shock — three harmonics plus a slow churn, in
  // ABSOLUTE units so the front stays equally ragged near the sun and out at
  // the rim (a fraction-of-radius wobble would be invisible early and wild late).
  const wob = (a) => 250 * Math.sin(a * 3 + sd) + 140 * Math.sin(a * 7 - sd * 1.7)
    + 80 * Math.sin(a * 13 + sd * 0.6) + 55 * Math.sin(a * 5 + t * 0.7);
  // Cheap deterministic hash for the filament/mote scatter — seeded off the
  // wave so no two look alike, and stable frame to frame so nothing strobes.
  const hash = (n) => {
    const x = Math.sin(n * 127.1 + sd * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  // ---- SHELTER, drawn. The wave BREAKS around worlds: each sheltering body's
  // lee is punched out of the plasma with an even-odd clip, so the shadow is
  // not painted ON the sky — the plasma simply is not there. That is the
  // counterplay made visible, and it is how the mechanic teaches itself
  // without a line of UI.
  //
  // The drawn lee is deliberately NARROWER and SHORTER than the mechanical
  // one (main.shelterBody): anywhere that LOOKS sheltered is sheltered, with
  // forgiving margin beyond the visible dark. Same safe-direction rule the
  // dust halo uses, and it keeps the boundary from reading as a drawn line.
  //
  // Culled on whether the LEE can touch the view, NOT on whether the body can
  // (bodyOnScreen reaches ~4 radii; a lee reaches STORM_SHADOW_LEN=30). Using
  // the body's own test left a pilot sheltering well behind a world safe with
  // plasma drawn right over them — protected, with nothing on screen saying
  // why. Same projection as main.shelterBody, widened by the view radius.
  const lees = [];
  for (const b of game.bodies) {
    if (b.type !== 'planet' && b.type !== 'moon' && b.type !== 'rogue') continue;
    if (!b.alive || b.radius < CFG.STORM_SHADOW_MIN_R) continue;
    const br = Math.hypot(b.x, b.y) || 1;
    const ux = b.x / br, uy = b.y / br;
    const along = view.cx * ux + view.cy * uy;
    const behind = along - br;
    if (behind < -vR || behind > b.radius * CFG.STORM_SHADOW_LEN + vR) continue;
    const px = view.cx - ux * along, py = view.cy - uy * along;
    const reach = b.radius * CFG.STORM_SHADOW * 1.4 + vR;
    if (px * px + py * py > reach * reach) continue;
    lees.push({ b, ux, uy });
  }

  // A teardrop: full width at the limb, bulging a little in the near wake,
  // then closing as the plasma folds back in behind the world. Shared by the
  // clip and the edge spill below so the two can never drift apart.
  const leePath = ({ b, ux, uy }) => {
    const w = b.radius * CFG.STORM_SHADOW * 0.9;
    const L = b.radius * CFG.STORM_SHADOW_LEN * 0.8;
    const px = -uy, py = ux;   // across the sun->body ray
    ctx.moveTo(b.x + px * w, b.y + py * w);
    ctx.quadraticCurveTo(
      b.x + ux * L * 0.45 + px * w * 1.3, b.y + uy * L * 0.45 + py * w * 1.3,
      b.x + ux * L, b.y + uy * L);
    ctx.quadraticCurveTo(
      b.x + ux * L * 0.45 - px * w * 1.3, b.y + uy * L * 0.45 - py * w * 1.3,
      b.x - px * w, b.y - py * w);
    ctx.closePath();
  };

  ctx.save();
  if (lees.length) {
    ctx.beginPath();
    ctx.rect(view.x0 - 40, view.y0 - 40, view.x1 - view.x0 + 80, view.y1 - view.y0 + 80);
    for (const lee of lees) leePath(lee);
    ctx.clip('evenodd');
  }

  ctx.globalCompositeOperation = 'lighter';

  // TWO SCALES, and getting this wrong is what made the first pass unreadable.
  // The sheath is 9200 units deep and the shock band 1400 across, but a
  // gameplay view is ~900 units WIDE — so from inside the wave, every feature
  // sized in wave units is bigger than the screen and collapses into a flat
  // wash (the first cut drew 220-unit-wide filaments: screen-filling columns).
  // So the STRUCTURE (front position, sheath falloff) is in wave units, and
  // the TEXTURE — filaments, motes — is sized off view.r, which is what makes
  // it read as weather streaming past you at any zoom. (vR is hoisted above,
  // beside dCam — the lee cull needs it too.)

  // ---- 1. the SHEATH: everything from the shock back through the tail. One
  // gradient fill over the view rect (not a 50,000-unit disc — same picture,
  // a fraction of the raster). Hot and packed at the shock, cooling to a
  // violet haze as the tail dissolves. Kept LOW: this covers the entire screen
  // when you are inside it, and the texture passes are what carry the drama.
  {
    const shockAt = CFG.STORM_TAIL / (CFG.STORM_TAIL + CFG.STORM_BAND);
    const g = ctx.createRadialGradient(hs.x, hs.y, Math.max(0, tail), hs.x, hs.y, lead);
    g.addColorStop(0, 'rgba(110, 50, 200, 0)');
    g.addColorStop(0.45, 'rgba(120, 55, 210, 0.045)');
    g.addColorStop(0.78, 'rgba(215, 70, 160, 0.06)');
    g.addColorStop(shockAt * 0.985, 'rgba(255, 130, 50, 0.10)');
    g.addColorStop(shockAt, 'rgba(255, 220, 170, 0.14)');
    g.addColorStop(1, 'rgba(190, 235, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(view.x0 - 40, view.y0 - 40, view.x1 - view.x0 + 80, view.y1 - view.y0 + 80);
  }

  // ---- 2. FILAMENTS: plasma streaming radially, scattered through the part
  // of the sheath the camera can actually see and STREAMING OUTWARD past it.
  // Sized off the view, so they read as driving rain whether you are inside
  // the wave or watching it cross the system. `flow` walks each streak
  // outward and wraps it, which is the whole sense of motion — the sheath
  // itself only creeps at 950 u/s and would otherwise look static up close.
  {
    const near = Math.max(tail, dCam - vR * 1.3);
    const far = Math.min(lead, dCam + vR * 1.3);
    if (far > near) {
      const span = far - near;
      const flow = t * 620;
      ctx.lineCap = 'round';
      for (let i = 0; i < 72; i++) {
        const a = midA + (hash(i * 1.7) * 2 - 1) * halfA;
        const len = vR * (0.12 + 0.5 * hash(i * 3.1 + 5));
        // wrap through the visible depth, offset per streak
        const rr = near + ((hash(i * 5.9 + 2) * span + flow) % span);
        const flick = 0.5 + 0.5 * Math.sin(t * (4 + hash(i + 7) * 7) + i * 2.7);
        const x0 = hs.x + Math.cos(a) * rr, y0 = hs.y + Math.sin(a) * rr;
        const x1 = hs.x + Math.cos(a) * (rr - len), y1 = hs.y + Math.sin(a) * (rr - len);
        if (Math.max(x0, x1) < view.x0 || Math.min(x0, x1) > view.x1 ||
            Math.max(y0, y1) < view.y0 || Math.min(y0, y1) > view.y1) continue;
        // Hottest right at the shock, cooling through orange to violet deep in
        // the tail. CLAMPED: ahead of the shock (rr > st.r, inside the leading
        // band) the raw term runs past 1 and pushed every channel to white —
        // the whole wave came out grey, which is what a low-alpha additive
        // near-white over black looks like. Plasma has to stay SATURATED.
        const heat = Math.max(0, Math.min(1, 1 - (st.r - rr) / CFG.STORM_TAIL));
        const fg = ctx.createLinearGradient(x0, y0, x1, y1);
        // BOTH TIPS FADE TO NOTHING. Starting at full alpha put a hard chop
        // across the leading end of every streak, and a field of hard-topped
        // radial bars reads as architecture — the "columns" look — not as
        // plasma blowing past. The peak sits just behind the tip.
        fg.addColorStop(0, 'rgba(255, 190, 130, 0)');
        fg.addColorStop(0.16, `rgba(255, ${(105 + 95 * heat) | 0}, ${(55 + 70 * heat) | 0}, ${(0.10 + 0.34 * heat) * flick})`);
        fg.addColorStop(0.5, `rgba(220, 90, 170, ${0.09 * heat * flick})`);
        fg.addColorStop(1, 'rgba(130, 60, 215, 0)');
        ctx.strokeStyle = fg;
        ctx.lineWidth = vR * (0.006 + 0.03 * hash(i * 7.3 + 1));
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
  }

  // ---- 3. the SHOCK itself: a broad hot glow with a thin incandescent core
  // riding on it, both sampled through wob() so neither is ever a circle. This
  // is the WALL you see coming — from outside it's the whole event, and from
  // inside it's already behind you, so it stays cheap either way.
  {
    const n = sunClose ? 180 : 72;
    const trace = (dr) => {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = midA + ((i / n) * 2 - 1) * halfA;
        const rr = st.r + wob(a) + dr;
        const x = hs.x + Math.cos(a) * rr, y = hs.y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    };
    // (No wider glow pass than this: a STORM_BAND-scale stroke is ~900 screen
    // px across at gameplay zoom, i.e. a full-screen fill, and the sheath
    // gradient above already peaks at exactly this radius. Pure fill-rate for
    // a picture that was already there.)
    ctx.strokeStyle = 'rgba(255, 185, 105, 0.17)';
    ctx.lineWidth = CFG.STORM_BAND * 0.34;
    trace(0); ctx.stroke();
    // The incandescent leading edge, riding a little ahead of the glow, with
    // a hot bloom under it. Sized off the view so it stays a bright LINE at
    // any zoom rather than vanishing zoomed out or becoming a slab zoomed in.
    const edge = CFG.STORM_BAND * 0.24;
    ctx.strokeStyle = `rgba(255, 140, 40, ${0.3 + 0.1 * Math.sin(t * 9)})`;
    ctx.lineWidth = Math.max(30, vR * 0.13);
    trace(edge); ctx.stroke();
    ctx.strokeStyle = `rgba(255, 205, 130, ${0.45 + 0.12 * Math.sin(t * 9)})`;
    ctx.lineWidth = Math.max(14, vR * 0.055);
    trace(edge); ctx.stroke();
    ctx.strokeStyle = `rgba(255, 250, 240, ${0.6 + 0.15 * Math.sin(t * 13)})`;
    ctx.lineWidth = Math.max(4, vR * 0.014);
    trace(edge); ctx.stroke();
  }

  // ---- 4. MOTES: charged grains caught in the wave, twinkling as they ride
  // it past you. Cheap sparkle that keeps the sheath from reading as a
  // painted gradient — and they only exist where you can see them.
  {
    const near = Math.max(tail, dCam - vR * 1.2);
    const far = Math.min(lead, dCam + vR * 1.2);
    if (far > near) {
      const span = far - near;
      const flow = t * 780;
      ctx.fillStyle = 'rgba(255, 240, 210, 0.8)';
      for (let i = 0; i < STORM_MOTES; i++) {
        const a = midA + (hash(i * 2.7) * 2 - 1) * halfA;
        const rr = near + ((hash(i * 5.1 + 1) * span + flow) % span);
        const tw = Math.sin(t * (7 + 9 * hash(i + 31)) + i * 2.3);
        if (tw < 0.1) continue;
        const x = hs.x + Math.cos(a) * rr, y = hs.y + Math.sin(a) * rr;
        if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
        ctx.globalAlpha = tw;
        ctx.beginPath(); ctx.arc(x, y, vR * (0.004 + 0.006 * hash(i * 3.3)), 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();   // drops the shadow clip

  // ---- 5. the LEE EDGE. A clip cuts with a knife, and a hard geometric
  // boundary in the world is the one thing the house style will not have — so
  // the outline is re-stroked wide and soft, additive, scattering light back
  // across the cut in both directions. The shelter still ends exactly where it
  // ends; it just no longer announces the fact with a drawn line.
  if (lees.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (const lee of lees) {
      const rel = st.r - Math.hypot(lee.b.x, lee.b.y);
      if (rel < -CFG.STORM_BAND || rel > CFG.STORM_TAIL) continue;
      const k = rel < 0 ? 1 : 1 - rel / CFG.STORM_TAIL;
      ctx.strokeStyle = `rgba(230, 140, 210, ${0.13 * k})`;
      ctx.lineWidth = lee.b.radius * 0.85;
      ctx.beginPath(); leePath(lee); ctx.stroke();
      ctx.strokeStyle = `rgba(255, 190, 140, ${0.11 * k})`;
      ctx.lineWidth = lee.b.radius * 0.3;
      ctx.beginPath(); leePath(lee); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- 6. the BOW SHOCK on each sheltering world: while the sheath is over
  // it, its sunward limb burns where the plasma piles up and parts. Drawn
  // AFTER the clip is released — this is light on the world, not plasma in
  // the lee behind it.
  for (const { b, ux, uy } of lees) {
    // …so this one DOES want bodyOnScreen: the bow shock is light on the world
    // itself, unlike the lee, which is a shadow cast far past it.
    if (!bodyOnScreen(b)) continue;
    const br = Math.hypot(b.x, b.y);
    const rel = st.r - br;
    if (rel < -CFG.STORM_BAND || rel > CFG.STORM_TAIL) continue;
    const k = rel < 0 ? 1 : 1 - rel / CFG.STORM_TAIL;
    const sunAng = Math.atan2(-uy, -ux);   // bearing from the body back to the sun
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255, 218, 170, ${0.5 * k})`;
    ctx.lineWidth = b.radius * 0.1;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius * 1.06, sunAng - 1.15, sunAng + 1.15);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 255, 245, ${0.35 * k})`;
    ctx.lineWidth = b.radius * 0.03;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius * 1.1, sunAng - 0.85, sunAng + 0.85);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
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
  // Dormant field rocks can NEVER be on screen: dormancy requires being
  // outside a wake bubble of 2.2x viewR + 600 around the ship/camera, and the
  // screen edge sits at 1.0x viewR — a >1.2x-viewR guaranteed margin. So the
  // ~7000 dormants skip even the bodyOnScreen test. (Teleports — warp, dev
  // goto — could break the invariant for one frame; main.js reclassifies the
  // LOD immediately after a warp for exactly that reason.)
  for (const b of game.bodies) if (b.alive && !b.dormant && bodyOnScreen(b)) drawBody(game, b);
  drawGlow(game);
  drawApproach(game);
  drawDeflectable(game);
  drawParry(game);

  // Scrap debris — glinting gold, except what a solar wave has IONIZED: that
  // burns charged blue-white and is worth more (PROG.ION_SCRAP_MUL). The
  // colour IS the price tag, so it has to be unmistakable at a glance.
  for (const d of game.debris) {
    if (d.x < view.x0 - 20 || d.x > view.x1 + 20 || d.y < view.y0 - 20 || d.y > view.y1 + 20) continue;
    const tw = 0.6 + Math.sin(game.time * 6 + d.phase) * 0.4;
    const fade = Math.min(1, d.life / 4);
    if (d.ion) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(150, 220, 255, ${0.3 * tw * fade})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.radius * 3.2, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(226, 246, 255, ${(0.7 + tw * 0.3) * fade})`;
    } else {
      ctx.fillStyle = `rgba(255, 210, 90, ${(0.55 + tw * 0.45) * fade})`;
    }
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

  drawStormWave(game);

  // The powered relay's bearing beam: a fading solid gradient line from the
  // dish toward the revealed dark star — a ~12s one-shot cue, not standing UI.
  if (game.relayBeamT > 0 && game.relay && game.relay.alive && game.darkStar) {
    const rl = game.relay, dk = game.darkStar;
    const a = Math.min(1, game.relayBeamT / 12) * 0.5;
    const ang = Math.atan2(dk.y - rl.y, dk.x - rl.x);
    const bx = rl.x + Math.cos(ang) * 2600, by = rl.y + Math.sin(ang) * 2600;
    const g = ctx.createLinearGradient(rl.x, rl.y, bx, by);
    g.addColorStop(0, `rgba(185, 154, 255, ${a})`);
    g.addColorStop(1, 'transparent');
    ctx.strokeStyle = g;
    ctx.lineWidth = 3 / game.cam.zoom;
    ctx.beginPath(); ctx.moveTo(rl.x, rl.y); ctx.lineTo(bx, by); ctx.stroke();
  }

  // Sonar rings: the visible face of the audible pings (solid — a real
  // emission from a real object, not helper UI). The ghost ship's is mournful
  // red until the Herald wakes; friendly pings (the awakened Herald, the
  // Tinker Barge) render warm green.
  for (const gp of [game.ghostPing, game.tinkerPing, game.maydayPing]) {
    if (!gp) continue;
    // each ping expands from ITS OWN lifetime (t0), so a short urgent ping
    // still blooms from the hull instead of popping in mid-expansion
    const k = 1 - gp.t / (gp.t0 || 1.6);
    ctx.strokeStyle = gp.friendly
      ? `rgba(190, 255, 210, ${(1 - k) * 0.4})`
      : `rgba(255, 150, 120, ${(1 - k) * 0.45})`;
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
  // (…and the lead solver goes with it while a wave is washing over you —
  // same targeting computer, same blackout as the forecast above.)
  if ((game.held || game.volleyCharging) && game.lock && !(game.stormIonT > 0)) {
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

  // SOLAR WAVE — the whole sky answers to it, wherever in the system you are.
  //
  // 1) THE CHARGE. A rising warm pulse over everything: the telegraph has to
  //    reach a pilot who is 40,000 units out with the sun behind a gas giant,
  //    and the message line alone can be missed. It quickens as it loads.
  if (game.stormChargeT > 0) {
    const k = 1 - game.stormChargeT / CFG.STORM_CHARGE;
    const beat = 0.5 + 0.5 * Math.sin(game.time * (3 + 12 * k));
    ctx.fillStyle = `rgba(255, 170, 90, ${0.02 + 0.055 * k * beat})`;
    ctx.fillRect(0, 0, vw, vh);
  }

  // 2) THE ION WASH, while a wave is actually on you (stormIonT outlives the
  //    exposure itself, so the sensors stay rattled for a beat after you make
  //    the lee — the relief lands a moment late, which is what sells it).
  //    Bright charged haze, scan-line tearing, and a hard edge vignette;
  //    everything scales with `wash`, so ducking into shelter visibly calms it
  //    instead of switching it off.
  if (game.stormIonT > 0 && game.ship.alive) {
    const ionK = Math.min(1, game.stormIonT / CFG.STORM_ION);
    const wash = game.stormExposed ? ionK : ionK * 0.35;
    const jit = 1 + 0.25 * Math.sin(game.time * 31) + 0.15 * Math.sin(game.time * 67);
    // A flat full-screen haze is nearly all cost and no signal: laid over the
    // warm world layer it just desaturates the wave to grey. Kept to a whisper
    // — the TEARING and the edge burn are what read as an instrument failing.
    ctx.fillStyle = `rgba(190, 215, 255, ${0.018 * wash * jit})`;
    ctx.fillRect(0, 0, vw, vh);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const yy = ((game.time * (150 + i * 90) + i * 137) % (vh + 120)) - 60;
      const h = 2 + (i % 3) * 4;
      ctx.fillStyle = `rgba(210, 240, 255, ${0.07 * wash})`;
      ctx.fillRect(0, yy, vw, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    // Edge burn: the plasma is coming past the canopy, not through the middle
    const ig = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.3, vw / 2, vh / 2, vh * 0.85);
    ig.addColorStop(0, 'transparent');
    ig.addColorStop(0.6, `rgba(255, 170, 110, ${0.09 * wash})`);
    ig.addColorStop(1, `rgba(255, 215, 175, ${0.28 * wash * jit})`);
    ctx.fillStyle = ig;
    ctx.fillRect(0, 0, vw, vh);
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
