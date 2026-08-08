import {
  CFG, PROG, SHIP_HIT_FRAC, fieldFrac, fieldLobe, FIELD_LOBE_MAX, PTYPE_LABELS,
  canLift, canStow, liftClass, shelterR, dockTier, dockPadR, dockDomeR, ramPlate,
  ramRows, ramPerRow, shipVis, seaPhase,
} from './config.js';
import { predictPaths, frameReg, PARRY_ARC, PARRY_READY_T, parryLive, dockReady } from './physics.js';
import * as gravel from './gravel.js';
import {
  chart, chartScale, CHART_R, isContact, plottable, contactLevel, contactPos, contactLabel,
  hasFix, ghostUnc, fieldOff, waypointPos, waypointLabel, arriveR,
} from './starmap.js';
import { volleyPick, isOwnShot, throwLocked } from './tractor.js';
import {
  TAU, angDiff, lerp, clamp, mulberry32, shellModal, senseBlind, crystalShards, scarSurfaceAt,
  rockJagRing, jagSamples, JAG_PEAK, padPos,
} from './util.js';
import { rockShapeOf, rockSurfAt } from './rockshape.js';
import {
  initRockGL, resizeRockGL, rockGLBegin, rockGLPush, rockGLFlush,
  rockGLCount, rockGLResetTextures, rockGLStats, rockGLAvailable,
} from './rockgl.js';

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
    // The instanced-rock buffer is composited 1:1 into the world canvas, so it
    // tracks the SCALED backing store — render scale reaches it exactly as it
    // reaches everything else drawn in world space.
    resizeRockGL(canvas.width, canvas.height);
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

// ---------------------------------------------------------------------------
// GL / 2D MODE. Instanced GL wins hugely in a shoal and LOSES in open space:
// compositing its canvas is one full-screen drawImage whatever it holds, so
// below a few hundred rocks the per-rock 2D blits are simply cheaper than the
// composite alone. The switch therefore runs off the PREVIOUS frame's count —
// blitRock cannot know the total until the loop it is being called from has
// finished, and a camera moves smoothly enough that a one-frame-old count is
// right essentially always. The hysteresis keeps a rock count hovering on the
// line from flapping between paths (which would flicker, since the two orders
// differ slightly).
//
// MEASURED, not guessed — same scene, paths interleaved, ms per rendered
// frame (forceRockPath is what makes that measurable):
//     rocks     2D      GL
//         3   0.400   0.454      <- 2D, the composite is pure overhead
//        22   0.437   0.512      <- 2D
//       111   0.716   0.621      <- GL
//       247   0.662   0.527      <- GL
//       474   0.930   0.710      <- GL, 1.31x
//      1710   2.570   1.440      <- GL, 1.78x
//      1849   2.880   1.700      <- GL, 1.69x
// So the composite costs ~0.06-0.08ms flat and break-even sits around 60-90
// rocks. ENTER is set just past that, with EXIT well below it: in the band
// between them the two paths are within ~0.1ms of each other, so the
// hysteresis is buying a stable picture for nothing. (An earlier guess of 260
// was ~3x too conservative and left the GL path dark through most of a shoal.)
//
// Rock counts in play: ~6 on screen at tier 0's tight zoom, ~40 at tier 2,
// ~270 at tier 5, and ~1800 on a wide zoomed-out shot — so this engages from
// mid-game onward and for every wide shot, which is exactly where it pays.
const GL_ENTER = 100;   // rocks needed to turn the GL path ON
const GL_EXIT = 60;     // ...and to fall back below (hysteresis)
let glReady = false;    // WebGL2 came up
let glOn = false;       // ...and this frame is using it
let frameRockN = 0;     // blit-eligible rocks seen this frame
let prevRockN = 0;      // last frame's, which decides the mode
// Pin the path for A/B measurement: 'gl' | '2d' | null (auto). The threshold
// above is only defensible against numbers, and the two paths have to be
// measured on the SAME scene to produce any — so this exists for the same
// reason window.god and window.speed do.
// `(await import('/src/render.js')).forceRockPath('2d')`
let glForce = null;
export function forceRockPath(mode) { glForce = mode === 'gl' || mode === '2d' ? mode : null; }

function beginFrame(game) {
  const { cam } = game;
  // Pick this frame's rock path from last frame's load (see the note above).
  if (!glReady) glReady = initRockGL(canvas.width, canvas.height);
  prevRockN = frameRockN;
  frameRockN = 0;
  // rockGLAvailable(), NOT the latched glReady: a lost context sets the module
  // dead AFTER a successful init, and glReady would still say yes. blitRock
  // would then push into a no-op and STILL return true (telling drawBody the
  // rock is handled) while the flush returned nothing to composite — every
  // atlas-eligible rock would silently vanish, permanently. The fallback is
  // the whole point of the dead flag; this is what actually honours it.
  glOn = rockGLAvailable() && (glForce
    ? glForce === 'gl'
    : (glOn ? prevRockN >= GL_EXIT : prevRockN >= GL_ENTER));
  if (glOn) rockGLBegin();
  // pad absorbs screen shake (±15px) and stroke widths
  const halfW = (vw / 2 + 80) / cam.zoom, halfH = (vh / 2 + 80) / cam.zoom;
  view.cx = cam.x; view.cy = cam.y;
  view.x0 = cam.x - halfW; view.x1 = cam.x + halfW;
  view.y0 = cam.y - halfH; view.y1 = cam.y + halfH;
  view.r = Math.hypot(halfW, halfH);
  // The frame's star list is now just the registry's (physics builds it in the
  // LOD's single walk) — this used to scan every body in the world once a
  // frame to find the sun. Copied rather than aliased so a mid-frame rebuild
  // cannot swap the array out from under nearestStar.
  frameStars.length = 0;
  for (const b of frameReg(game).stars) if (b.alive) frameStars.push(b);
  buildSeaWaves(game);
}

// View culling: true if any drawn element of this body can touch the screen.
// The margin covers the largest overdraw any sprite pass makes (glows, rings
// and halos reach ~3.2x radius; comet tails stream 9x). Railed moons/planets
// also paint faint orbit guides that can be on-screen while the body itself
// is not — those get their own geometric checks so nothing ever pops.
function bodyOnScreen(b) {
  // Vesper's anti-sunward tail reaches ~34x radius at full perihelion bloom.
  // A STAR gets its own margin: the generic 4x is a bound over every sprite
  // pass, but drawStar's envelope is known exactly (SUN_HALO), and at this
  // radius the difference is a ~2,000-unit shell of pure waste.
  const m = (b.type === 'star' ? b.radius * SUN_HALO
    : b.majorComet ? b.radius * 36 : b.comet ? b.radius * 10 : b.radius * 4) + 80;
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

// Circle-vs-view, for the passes INSIDE a body that are each their own little
// sprite — the sun's corona lobes and supergranules. bodyOnScreen answers "is
// this body worth drawing"; on a 4,800-unit star that question is far too
// coarse, because the answer is yes while nine tenths of its own detail sits
// off the far side of a disc bigger than the screen. Four compares against a
// createRadialGradient + arc + fill is a trade worth making every time.
function circleOnScreen(cx, cy, r) {
  return cx + r > view.x0 && cx - r < view.x1 && cy + r > view.y0 && cy - r < view.y1;
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
// per-body rotation, the exact per-body radius, and the fact that no two
// archetypes are the same rock: 24 of them read as "all different" even on a
// boulder. Big rock — giants, monoliths, the bodies you steer a shoal by — is
// EXEMPT (rockBucket returns -1 past the last bucket edge) and keeps a unique
// silhouette, because those are few and you get close enough to them to tell.
//
// WHAT an archetype is — lobes, stretch, grain, facets, bites — is
// util.rockOutline, the SAME generator and the same five kinds the landmark
// rocks are built from. A shoal is one material: the old split (a wobbly
// polygon down here, a shaped block up there) was visible the moment a giant
// sat among its own gravel.
//
// The archetype IS b.jag, not a parallel table: traceAsteroid, the damage
// crack clip and the scar edge sampler all read b.jag, so a shape that existed
// only inside the sprite would make cracks and bites sit off the drawn edge.
// ---------------------------------------------------------------------------
const ROCK_ARCHS = 24;   // silhouettes per size bucket. MUST stay a multiple of
                         // 3: the crater COUNT is `2 + (id % 3)` and the bake
                         // keys it off `arch % 3` instead, so every rock keeps
                         // exactly the pit count it has today.
// Upper radius edge / representative radius of each size bucket. The only
// thing radius feeds is the outline's SAMPLE COUNT, evaluated once per bucket
// at the representative radius instead of per rock. So a rock that CHIPS across
// an edge steps to a different archetype rather than easing — and that only
// lands on a real damage event, which is already a visible moment. That is the
// honest cost of bucketing, not a bug.
const ROCK_BUCKET_MAX = [3.5, 5.5, 8, 11];
const ROCK_BUCKET_R = [2.6, 4.5, 6.7, 9.4];
const archJags = [];   // [bucket * ROCK_ARCHS + arch] -> jag array
const ROCK_SIL_N = 128;
// Sentinel jag cache key for baked-shape landmarks — out of range of both the
// 0..3 bucket indices and the -1-jagSamples() unique-ring keys.
const JAG_KEY_SHAPED = -9999;   // samples for the radial profile the crack/scar decals index
// Screen size (world radius x zoom) below which the intricate surface skips
// its fine layers — they are sub-pixel there and cost more than they show.
// WHICH rocks get the pass at all is world.shapeBig's `b.bigShape`, never a
// radius here: that one flag is what keeps the drawn shape, the collider and
// the detail on the same set of bodies.
const BIG_FINE_PX = 26;

function rockBucket(r) {
  for (let i = 0; i < ROCK_BUCKET_MAX.length; i++) if (r <= ROCK_BUCKET_MAX[i]) return i;
  return -1;
}

// SHARED, never mutated: the returned array is handed to every body in the
// bucket as its b.jag. Writing through b.jag would reshape hundreds of rocks.
function archJag(arch, bk) {
  const i = bk * ROCK_ARCHS + arch;
  let j = archJags[i];
  if (!j) j = archJags[i] = rockJagRing(mulberry32(arch * 7919 + 13), ROCK_BUCKET_R[bk]);
  return j;
}

// ---------------------------------------------------------------------------
// SHARD SILHOUETTE ARCHETYPES — the same quantization, for the CHUNK family.
//
// A piece of a world (b.chunk) draws a different sprite from belt rock — split
// faces, a surviving crust strip, fault lines — and drawBody's `b.chunk` branch
// sits AHEAD of the asteroid one, so chunks never reached blitRock and the
// whole instanced path did not apply to them. That is exactly backwards for
// what the crumble produces: a cascade's output is chunks, in their thousands,
// and measured at 2000 on screen `rockPathStats().rocksLastFrame` reported 1.
//
// So chunks get their own archetype family. The cut is at 14 drawn units, which
// is where drawChunkSprite's SLAB layers (the lit facet wedge, the second fault
// line) switch on: above it a piece is big, rare, and something the player flies
// right up to, so it keeps a unique silhouette exactly as big rock does. Below
// it the sprite is four flat paths that bake perfectly. CHUNK_SPLIT_R (15) means
// a cascade terminates in pieces under that cut by construction, so the bulk of
// what a crumbling world produces lands inside the bucketed range.
//
// THE ARCHETYPE IS b.shard, not a parallel table — the same law the rock family
// runs on. drawBodyDamage's scar edge sampler reads `b.chunk ? b.shard : b.jag`
// to put a crater rim ON the drawn edge, so a shape that existed only inside
// the sprite would float every scar off the silhouette.
// ---------------------------------------------------------------------------
const SHARD_BUCKET_MAX = [3.5, 6, 9.5, 14];
const SHARD_BUCKET_R = [2.6, 4.8, 7.8, 11.8];
// The shard family gets its OWN sheet geometry, and that is the whole reason it
// can afford a tier the rock family cannot. Rocks need 24 archetypes x 20 rows
// (bucket x colour) — at a 32px bake radius that sheet is 12MB and blows
// ATLAS_BUDGET on its own. Shards are 12 archetypes x FOUR rows, because the
// tint removed the colour dimension entirely: 1.2MB at the same tier.
//
// AND THE SIZE CAP IS DIFFERENT IN KIND HERE. The rock cap (SPRITE_TIERS ends
// at 16) is a 2D-BLIT economic rule — past ~25px a rotated, filtered drawImage
// costs more raster than filling a small polygon. Instanced GL has no such
// crossover: 2,000 quads are one draw call whatever their size, and the raster
// is the GPU's. Measured at the game's own zoom (1.79), real crust debris sits
// at a P50 drawn radius of ~19px — right past the rock cap — so capping shards
// there would have rejected essentially the entire crumble layer, which is the
// exact population this whole path exists for. Hence tiers up to 32, GL only.
const SHARD_ARCHS = 12;
const SHARD_ROWS = SHARD_BUCKET_MAX.length;
const SHARD_TIERS = [8, 16, 32];
const shardArchs = [];   // arch -> { pts, crustAt, facetAt, faultAt }

function shardBucket(r) {
  for (let i = 0; i < SHARD_BUCKET_MAX.length; i++) if (r <= SHARD_BUCKET_MAX[i]) return i;
  return -1;
}

// SHARED, never mutated (see archJag). Vertex count and jag depth do not vary
// with radius inside the bucketed range — drawChunkSprite's own `R > 26` step is
// far above the cut — so ONE archetype set serves every shard bucket, and the
// bucket only picks the representative R for the size-dependent line widths.
function shardArch(arch) {
  let s = shardArchs[arch];
  if (!s) {
    const rng = mulberry32(arch * 3163 + 41);
    const n = 6 + Math.floor(rng() * 4);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(0.55 + rng() * 0.65);   // sharper than a tumbled rock
    s = {
      pts,
      crustAt: Math.floor(rng() * n),
      facetAt: Math.floor(rng() * n),
      faultAt: [Math.floor(rng() * n), Math.floor(rng() * n)],
    };
    shardArchs[arch] = s;
  }
  return s;
}

// Give a chunk its silhouette: the shared archetype inside the bucketed range,
// a unique per-id shape above it. ONE choke point, so the sprite, the bake and
// the scar sampler can never disagree about what shape a chunk is.
// Which shard archetype a chunk wears. `b.shardArch` is set by
// physics.promoteGravel so a grain keeps the silhouette it was already drawn
// with; everything else falls back to its id. ONE accessor, because the shape
// cache (chunkShape) and the atlas cell (blitChunk) must resolve identically —
// picking different sources would draw one shape and clip scars against another.
function shardArchOf(b) { return (b.shardArch !== undefined ? b.shardArch : b.id) % SHARD_ARCHS; }

function chunkShape(b) {
  const R = b.radius;
  if (b.shard && b.shardR === R) return;
  const bk = shardBucket(R);
  if (bk >= 0) {
    const s = shardArch(shardArchOf(b));
    b.shard = s.pts; b.shardR = R;
    b.crustAt = s.crustAt; b.facetAt = s.facetAt; b.faultAt = s.faultAt;
    return;
  }
  const rng = mulberry32(b.id * 3163 + 41);
  // Vertex count scales with SIZE. Six flat sides were authored for the
  // ~10-unit spray chunk; a crust slab is drawn as a fraction of the world it
  // came off (CFG.CRUST_R_*), so it arrives at 40-110 units where six sides
  // read as a paper cut-out. The array stays a plain list of radial factors
  // indexed by angle — the scar edge sampler in drawBodyDamage reads it that
  // way (vertex i lives at local angle i/n·TAU), so the contract can't change.
  const n = (R > 26 ? 8 : 6) + Math.floor(rng() * 4);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(0.55 + rng() * 0.65);
  b.shard = pts; b.shardR = R;
  b.crustAt = Math.floor(rng() * n);   // which run of edges keeps the old surface
  b.facetAt = Math.floor(rng() * n);   // which face catches the light
  b.faultAt = [Math.floor(rng() * n), Math.floor(rng() * n)];
}

// Asteroids are broken rock, not discs — see util.rockOutline for what that
// means and why it is not a roughened polygon. The ring is cached on the body
// and regenerated if the radius changes (chip damage shrinks rocks), which is
// also what re-buckets a rock that has shed its way down a size class.
// A LANDMARK IS DRAWN AS THE POLYGON IT IS COLLIDED AS — the same baked vertex
// list rockshape.js runs SAT over, not a resampling of it. That is the crumble
// law's "one profile feeds render and physics" made literal rather than merely
// kept in step: there is no second sampling to drift.
//
// It also deleted a cache. The old silhouette was resampled at ROCK_SIL_N
// bearings and invalidated on vertex count, newest scar and radius, because the
// outline WORE as the rock was hit. Scars are cosmetic decals now (a shaped rock
// expresses damage by breaking into pieces cut from its own outline — see
// docs/rock-fracture.md), so the outline is static per shape and there is
// nothing left to invalidate.
// COSMETIC ONLY — the drawn edge, not the collided one.
//
// The baked outline is simplified (the bake drops vertices that sit within 1.2%
// of the line through their neighbours), which is right for a collider and reads
// a little too CUT on screen: long dead-straight faces meeting at clean corners.
// This subdivides each face and walks it off the straight line by a hair, so an
// edge has grain without gaining a feature.
//
// THE AMPLITUDE IS THE WHOLE DESIGN. It is held at 0.8% of body radius, under
// the 1.2% the collision hulls were already simplified by — so the wobble stays
// inside a band where drawn and collided ALREADY disagree, and cannot open a gap
// the collider doesn't have. Anything bigger would be visible rock you fly
// through, or visible space you stop in, which is the one thing this outline
// exists to prevent.
//
// Cached on the SHAPE, not the body: 68 shapes serve ~1,600 rocks, so this is
// built a few dozen times per session and read every frame.
const COSM_AMP = 0.008, COSM_SUB = 3;
function cosmeticRing(sh) {
  if (sh._cosm) return sh._cosm;
  const v = sh.v, n = v.length >> 1, out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = v[i * 2], ay = v[i * 2 + 1];
    const bx = v[j * 2], by = v[j * 2 + 1];
    const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
    // Perpendicular, and a face gets more grain than a stub — a 2-unit sliver
    // between two real faces should not wobble as hard as a 200-unit slab side.
    const px = -ey / L, py = ex / L;
    const scale = Math.min(1, L / 0.35);
    out.push(ax, ay);
    for (let k = 1; k < COSM_SUB; k++) {
      const t = k / COSM_SUB;
      // Deterministic per (edge, step) — a rock must not shimmer between frames,
      // and two bodies wearing one shape must wear it identically.
      // fract(sin(seed) * K) — the multiply is OUTSIDE the sin, and the
      // fractional part is taken with FLOOR. Both matter: with the multiply
      // inside, `h` is already a sine in [-1,1], Math.trunc of it is always 0,
      // and `d` came out spanning -2.999..1.000 instead of [-1,1] — asymmetric,
      // and up to 3x the amplitude budget inward. That budget is the whole
      // design of this function (see COSM_AMP), so overshooting it is exactly
      // the visible-gap failure it exists to avoid.
      const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
      const d = (h - Math.floor(h)) * 2 - 1;
      out.push(ax + ex * t + px * d * COSM_AMP * scale,
               ay + ey * t + py * d * COSM_AMP * scale);
    }
  }
  return (sh._cosm = Float64Array.from(out));
}

function traceAsteroid(b) {
  if (b.bigShape) {
    const v = cosmeticRing(rockShapeOf(b)), n = v.length >> 1;
    const c = Math.cos(b.rot), sn = Math.sin(b.rot), r = b.radius;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = v[i * 2] * r, y = v[i * 2 + 1] * r;
      const px = b.x + x * c - y * sn, py = b.y + x * sn + y * c;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    // The crack clip and the scar edge sampler index b.jag as `i/n * TAU`, so
    // they still want a radial profile. Built once per shape+radius off the same
    // polygon, so the decals sit on the outline that is actually drawn.
    // ...and it MUST claim b.jagKey as well. The gravel path below caches on
    // that key alone; leaving it undefined meant its test never matched, so it
    // rebuilt b.jag as a 16-48 entry archetype ring over the 128-entry one this
    // path had just written, every frame, back and forth. The crack clip and the
    // scar edge sampler index b.jag as `i/n * TAU`, so they were reading an
    // array built at a different resolution than they assumed — which draws as
    // regular parallel rungs across the rock. JAG_KEY_SHAPED can never collide
    // with a bucket index or a -1-jagSamples() big-rock key.
    if (!b.jag || b.jagKey !== JAG_KEY_SHAPED || b.jagR !== b.radius || b.jagShape !== b.shapeId) {
      b.jag = new Array(ROCK_SIL_N);
      for (let i = 0; i < ROCK_SIL_N; i++) {
        b.jag[i] = rockSurfAt(b, (i / ROCK_SIL_N) * TAU + b.rot) / b.radius;
      }
      b.jagR = b.radius;
      b.jagShape = b.shapeId;
      b.jagKey = JAG_KEY_SHAPED;
    }
    return;
  }
  // CACHED ON WHAT THE RING ACTUALLY DEPENDS ON, which is not the radius. The
  // ring is a profile in units of the radius, so a rock that chips only needs a
  // new one when it changes ARCHETYPE — a different bucket, or (past the last
  // bucket edge, where the ring is unique per id) a different sample count.
  // Keying on b.radius rebuilt it on every point of chip damage, and a rebuild
  // is now real work: ~14-20us, against the ~2us the one-octave loop cost. In a
  // debris-heavy scene with a few hundred chipping rocks that was measurable in
  // the frame (+25% on that scenario) — the rebuild rate was the whole cost,
  // not the generator.
  // key: 0..3 a size bucket, -1 the carved stone, -1-n a unique big-rock ring.
  const bk = b.carved ? -2 : rockBucket(b.radius);
  const key = bk >= 0 ? bk : bk === -2 ? -1 : -1 - jagSamples(b.radius);
  if (!b.jag || b.jagKey !== key) {
    if (b.carved) {
      // The carved stone: a perfect hexagon — machined, not tumbled
      b.jag = [1, 1, 1, 1, 1, 1];
    } else if (bk >= 0) {
      b.jag = archJag(b.id % ROCK_ARCHS, bk);
    } else {
      // Big rock keeps a one-of-a-kind silhouette (see the header above): past
      // the last bucket edge there is no atlas row to share, so it draws its
      // own ring off its own id instead of an archetype. Same generator — a
      // rock that chips down across the edge changes which TABLE it reads,
      // never what kind of shape it is.
      //
      // The sample count keeps climbing with radius (rockJagRing's own ceiling
      // is the only stop) because this is the path a monolith drawn at 90+
      // world units takes — a rock you fly right up to. The old hard 16-vertex
      // cap rendered one as a crude polygon whose facets were each longer than
      // the ship.
      //
      // b.jag stays the ONE table: the crack clip and the scar edge sampler
      // both read it, so a shape that lived anywhere else would put cracks and
      // bites off the drawn edge.
      b.jag = rockJagRing(mulberry32(b.id * 7919 + 13), b.radius);
    }
    b.jagKey = key;
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
// Cell half-width in body radii. util.JAG_PEAK is the ceiling on a gravel
// ring's outermost point, so this is that plus headroom for the blit's own
// filtering — raise JAG_PEAK and this has to follow, or the bake clips the
// corners off every rock. The rings mean-normalise to 1 rather than
// peak-normalise (a rock draws the size it collides at), so the gap between
// mean and peak has to live in the cell.
const SPRITE_EXT = JAG_PEAK + 0.05;
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
  // CONTENT version, for the GL path's texture cache. Only a bake changes what
  // the sheet DEPICTS — the bake-less republish above is the Canvas2D rot
  // workaround (a fresh canvas holding identical pixels), and GL neither
  // suffers that rot nor needs to re-upload for it.
  if (bake) sh.ver++;
}

// Bake one SHARD row: every chunk archetype at one bucket, NEUTRAL — white
// base, black knock-down, white crust strip — so the per-instance tint in the
// GL shader multiplies it to whatever material that piece of world is made of.
//
// WHY NEUTRAL AND NOT A ROW PER COLOUR. Rock colours are a small fixed set
// (belt grey, boulder rust, cored, ice, junk), so bucket x colour fits one
// sheet. Chunk colour is the HOST WORLD'S OWN FACE (config.worldDebris returns
// hostColor for every solid archetype) — 21 worlds plus the ice/lava/crystal
// overrides is ~30 colours, which at four buckets is 120 rows, several sheets,
// and straight past ATLAS_BUDGET on the tier-16 cells alone. Baked neutral it
// is FOUR rows, total, for the entire crumble layer on every world in the sky.
//
// The multiply reproduces the sprite exactly, because every layer in the sub-14
// shard is already a scale of one colour: the face is `colour` knocked down by
// 34% black, the crust strip is `colour` at full, the fault line is 30% black
// over both. White x 0.66 x tint IS colour x 0.66. (The `R > 14` slab layers —
// the pale facet wedge — would NOT survive a multiply, which is a second reason
// the bucket cut sits exactly where those layers switch on.)
function bakeShardRow(c, sh, row, bk) {
  const px = sh.px, cell = sh.cell;
  const R = SHARD_BUCKET_R[bk];
  for (let arch = 0; arch < SHARD_ARCHS; arch++) {
    const s = shardArch(arch);
    const pts = s.pts, n = pts.length;
    const vx = (i) => Math.cos((((i % n) + n) % n / n) * TAU) * pts[((i % n) + n) % n];
    const vy = (i) => Math.sin((((i % n) + n) % n / n) * TAU) * pts[((i % n) + n) % n];
    c.save();
    c.translate(arch * cell + cell / 2, row * cell + cell / 2);
    c.scale(px, px);   // cell space == body-radius space (see bakeRow)
    const shard = () => {
      c.beginPath();
      c.moveTo(vx(0), vy(0));
      for (let i = 1; i < n; i++) c.lineTo(vx(i), vy(i));
      c.closePath();
    };
    c.fillStyle = '#fff';
    shard(); c.fill();
    c.fillStyle = 'rgba(0, 0, 0, 0.34)';   // fracture faces: the colour knocked down
    shard(); c.fill();
    c.save();
    shard(); c.clip();
    c.strokeStyle = '#fff';                // surviving crust along one edge run
    c.lineWidth = 0.42;
    c.lineCap = 'butt';
    c.beginPath();
    c.moveTo(vx(s.crustAt), vy(s.crustAt));
    c.lineTo(vx(s.crustAt + 1), vy(s.crustAt + 1));
    c.lineTo(vx(s.crustAt + 2), vy(s.crustAt + 2));
    c.stroke();
    c.strokeStyle = 'rgba(0, 0, 0, 0.3)';  // the fracture that freed it
    // The vector path floors this at 0.8 WORLD units, so in radius-normalized
    // space the floor is size-dependent — which is the one thing that still
    // varies across the buckets, and the only reason shards have buckets at all.
    c.lineWidth = Math.max(0.8 / R, 0.08);
    c.beginPath();
    c.moveTo(vx(s.crustAt) * 0.55, vy(s.crustAt) * 0.55);
    c.lineTo(vx(s.crustAt + Math.floor(n / 2)) * 0.85, vy(s.crustAt + Math.floor(n / 2)) * 0.85);
    c.stroke();
    c.restore();
    c.restore();
  }
}

// Claim a row on the open sheet for (tier, cols x rows) and bake into it. The
// GEOMETRY is part of the sheet's identity, not a constant: the rock family is
// 24 archetypes x 20 rows and the shard family is 12 x 4, and mixing them onto
// one sheet would force the smaller family to pay the larger one's width at
// every tier (see the SHARD_ARCHS note). Same-geometry callers still share.
function atlasRow(key, tier, cols, rows, bake, now) {
  let r = atlasRows.get(key);
  if (r) return r;
  // The open sheet is looked up PER TIER AND GEOMETRY: a shared "most recent
  // sheet" spawns a fresh one every time the zoom crosses a tier boundary and
  // back, and a shared-across-geometry one would mis-size every other row.
  const shKey = tier + 'x' + cols + 'x' + rows;
  let sh = openSheet.get(shKey);
  if (!sh || sh.next >= rows) {
    // Rows are (bucket x colour) and rock colours are a small fixed set, so in
    // practice one sheet per tier covers a run. A world that keeps minting new
    // ones would otherwise grow the atlas without limit: past the budget the
    // whole thing is dropped and rebuilt from what the next frames ask for —
    // a few row bakes, and the memory is bounded by construction.
    let bytes = 0;
    for (const s of atlasSheets) bytes += s.w * s.h * 4;
    if (bytes > ATLAS_BUDGET) {
      atlasSheets = []; openSheet = new Map(); atlasRows = new Map();
      // The GL textures are keyed to these sheet objects; dropping the sheets
      // without dropping them would strand real GPU memory (a WeakMap frees
      // the entry, never the texture).
      rockGLResetTextures();
    }
    const cell = Math.round(2 * tier * SPRITE_EXT);
    sh = { cv: null, px: tier, cell, w: cols * cell, h: rows * cell, next: 0, used: 0, ver: 0 };
    atlasSheets.push(sh);
    openSheet.set(shKey, sh);
  }
  const row = sh.next++;
  publishSheet(sh, (c) => bake(c, sh, row), now);
  // ext: the cell's half-width measured in body radii. Rounding `cell` to a
  // whole pixel moves it off SPRITE_EXT, and blitting at the nominal extent
  // would scale every rock by up to half a texel.
  r = { sh, cell: sh.cell, sy: row * sh.cell, ext: sh.cell / (2 * sh.px) };
  atlasRows.set(key, r);
  return r;
}

function rockRow(tier, bk, color, now) {
  return atlasRow(tier + '|' + bk + '|' + color, tier, ROCK_ARCHS, ATLAS_ROWS,
    (c, sh, row) => bakeRow(c, sh, row, bk, color), now);
}

// Shards carry no colour in the key — the tint supplies it (see bakeShardRow).
function shardRow(tier, bk, now) {
  return atlasRow(tier + '|S' + bk, tier, SHARD_ARCHS, SHARD_ROWS,
    (c, sh, row) => bakeShardRow(c, sh, row, bk), now);
}

// '#rgb'/'#rrggbb' -> the 0..1 triple the GL tint wants, memoized. Chunk colour
// is a small set per run (one per world material), so this settles immediately.
const tintCache = new Map();
function tintOf(color) {
  let t = tintCache.get(color);
  if (t) return t;
  let r = 1, g = 1, b = 1;
  if (typeof color === 'string' && color[0] === '#') {
    const h = color.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16) / 255; g = parseInt(h[1] + h[1], 16) / 255; b = parseInt(h[2] + h[2], 16) / 255;
    } else if (h.length >= 6) {
      r = parseInt(h.slice(0, 2), 16) / 255; g = parseInt(h.slice(2, 4), 16) / 255; b = parseInt(h.slice(4, 6), 16) / 255;
    }
  }
  t = [r, g, b];
  tintCache.set(color, t);
  return t;
}

// Atlas occupancy, for perf work — the sheet count and what they cost in
// backing store. Import it from the console
// (`(await import('/src/render.js')).rockCacheStats()`).
// Which rock path is live, and what the GL layer drew. Companion to
// rockCacheStats — `(await import('/src/render.js')).rockPathStats()`.
export function rockPathStats() {
  return {
    path: glOn ? 'webgl2-instanced' : (glReady ? '2d-blit (below GL_ENTER)' : '2d-blit (no webgl2)'),
    rocksLastFrame: prevRockN,
    queued: glOn ? rockGLCount() : 0,
    gl: rockGLStats(),
  };
}

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
// Does anything get drawn ON TOP of this rock inside drawBody? The GL layer
// composites AFTER the whole body loop, so a rock carrying an overlay has to
// stay on the inline 2D blit or the overlay would end up underneath it:
//   - cored     the vein twinkle (drawCoreGlint), painted over the sprite
//   - damage    the crack web / scar bites (drawBodyDamage)
//   - heldBy    the hold and orbit highlight rings, which sit between r and
//               ~1.15r — inside the sprite's opaque jag, not clear of it
// All three are a handful of bodies against a shoal's ~1900, so keeping them
// on the old path costs nothing and removes a whole class of z-order bug.
function rockNeedsOverlay(b) {
  return b.cored || !!b.heldBy || b.seaDim ||
    (b.maxHp !== Infinity && (b.hp < b.maxHp || (b.scars && b.scars.length)));
}

function blitRock(game, b) {
  // A shaped landmark is never bakeable: the atlas is a ring of 24 quantized
  // silhouettes, and the whole contract of b.bigShape is that the drawn edge is
  // the collided edge. It is also the flag physics keys off, so an atlas rock
  // here would put the picture and the hitbox on different tables — checked
  // BEFORE the bucket, since a chipped-down giant can fall inside one.
  if (b.bigShape) return false;
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
  frameRockN++;   // drives next frame's GL/2D decision (see beginFrame)
  // GL PATH: queue the instance and let the whole shoal go out as one draw
  // call after the body loop. Only rocks with NOTHING drawn on top of them
  // qualify — see rockNeedsOverlay.
  if (glOn && !rockNeedsOverlay(b)) {
    const w2 = b.radius * r.ext;   // half the drawn width, world units
    rockGLPush(sh, b.x, b.y, b.rot, w2,
      ((b.id % ROCK_ARCHS) * r.cell) / sh.w, r.sy / sh.h);
    return true;
  }
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

// Queue a chunk on the instanced path, or return false to let the caller draw
// the full vector sprite. GL-ONLY: the neutral bake needs the shader's tint to
// become its world's material, and Canvas2D has no cheap multiply-blit — so a
// machine without WebGL2 keeps exactly the sprite it has today, which is the
// same "every entry point is fallible" contract rockgl.js already runs on.
function blitChunk(game, b) {
  if (b.cored || b.heldBy) return false;   // glint / hold rings draw ON TOP (see rockNeedsOverlay)
  // A rock going under a gas giant fades out on ctx.globalAlpha, and an
  // instance carries no alpha of its own — it would stay solid all the way
  // down. A rock UNDER AN OCEAN dims on the same ambient alpha (b.seaDim), and
  // the instanced sheet also composites after the body loop, so it would draw
  // solid ON TOP of the sea — both stay on the 2D path.
  if (b.sinkT > 0 || b.seaDim) return false;
  const bk = shardBucket(b.radius);
  if (bk < 0) return false;                // slab: unique silhouette + the R>14 layers
  // A WOUNDED CHUNK KEEPS THE VECTOR SPRITE. The GL layer composites after the
  // whole body loop, so a crack web drawn in drawBody would end up UNDERNEATH
  // the sprite it marks — the same z-order rule rockNeedsOverlay enforces for
  // rocks. A size gate ("the wound is sub-pixel, skip it") was tried and
  // rejected: it makes the crack web POP INTO EXISTENCE as you fly closer and
  // the piece crosses back to vectors, and a wound on debris is a real signal —
  // it is how you read what you have already hit. Fresh crust is unwounded, so
  // the population this path exists for is covered either way.
  if (b.maxHp !== Infinity && (b.hp < b.maxHp || (b.scars && b.scars.length))) return false;
  const drawnPx = b.radius * game.cam.zoom * dpr;
  let tier = 0;
  const need = drawnPx * SPRITE_HEAD;
  for (const t of SHARD_TIERS) if (t >= need) { tier = t; break; }
  if (!tier) return false;                 // drawn too big: vectors (the size cap)
  // Counted BEFORE the glOn test, or the path could never switch itself on: a
  // frame showing nothing but chunks would report zero blit-eligible rocks,
  // leave glOn false next frame, and reject every chunk again forever.
  frameRockN++;
  if (!glOn) return false;
  chunkShape(b);
  const r = shardRow(tier, bk, wt.now);
  const t = tintOf(b.color);
  rockGLPush(r.sh, b.x, b.y, b.rot, b.radius * r.ext,
    (shardArchOf(b) * r.cell) / r.sh.w, r.sy / r.sh.h, t[0], t[1], t[2]);
  return true;
}

// The store's palette, pre-parsed to tint triples once. Parsing '#rrggbb' per
// grain per frame is exactly the kind of work this tier exists to delete.
const gravelTints = gravel.PALETTE.map((c) => tintOf(c));

// Queue every live grain into the instanced batch. No per-grain culling test
// beyond the screen box: at this size the test IS most of the cost, and the
// batch is one draw call whatever survives.
function drawGravel(game) {
  if (!glOn || !gravel.count()) return;
  const zoom = game.cam.zoom;
  // The frame's own view box (worldTransform computes it once), padded by the
  // biggest a grain can be — never a second, hand-rolled screen rectangle.
  const x0 = view.x0 - 40, x1 = view.x1 + 40, y0 = view.y0 - 40, y1 = view.y1 + 40;
  const gx = gravel.x, gy = gravel.y, gr = gravel.radius, grot = gravel.rot;
  const garch = gravel.arch, gtint = gravel.tint, gflags = gravel.flags;
  const top = gravel.top;
  for (let i = 0; i < top; i++) {
    if (!(gflags[i] & gravel.FLAG_ALIVE)) continue;
    const px = gx[i], py = gy[i];
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    const r = gr[i];
    const bk = shardBucket(r);
    if (bk < 0) continue;   // too big to be gravel at all — should never happen
    const drawnPx = r * zoom * dpr;
    let tier = 0;
    const need = drawnPx * SPRITE_HEAD;
    for (const t of SHARD_TIERS) if (t >= need) { tier = t; break; }
    if (!tier) continue;    // drawn huge: a grain this close should have promoted
    const row = shardRow(tier, bk, wt.now);
    const t = gravelTints[gtint[i]] || gravelTints[0];
    frameRockN++;
    rockGLPush(row.sh, px, py, grot[i], r * row.ext,
      ((garch[i] % SHARD_ARCHS) * row.cell) / row.sh.w, row.sy / row.sh.h, t[0], t[1], t[2]);
  }
}

// Draw an asteroid's body. Returns true when the crater pits are already on
// screen (baked into the sprite, or drawn inline here) so drawBody's pit pass
// can skip it. The carved stone returns false — it gets facet lines, not pits.
function drawRock(game, b) {
  if (b.carved) { traceAsteroid(b); ctx.fill(); return false; }
  if (blitRock(game, b)) return true;
  traceAsteroid(b);
  ctx.fill();
  // A LANDMARK gets the intricate surface instead of the pits. Gated on the
  // same b.bigShape the collider uses, so "detailed" and "shaped" are one set
  // of rocks and cannot drift apart. Same reuse of the just-filled path.
  if (b.bigShape) { drawBigRockDetail(game, b); return true; }
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

// ---------------------------------------------------------------------------
// THE LANDMARK SURFACE — what a b.bigShape rock wears instead of pits.
//
// Three flat dark dots are enough on a 10-unit boulder and nowhere near enough
// on a shoal giant (15-25 units) or a monolith (~90). At that size the old
// treatment read as a sticker: one flat colour, three circles, no light
// direction, on a body drawn wider than the ship is long that the player flies
// right up to and navigates a whole pocket by.
//
// Five layers, seeded off b.id and cached in the body's LOCAL frame so the
// stone is the same stone every frame and every session (the same discipline
// as worldSil and traceAsteroid — nothing here may be re-randomised per frame
// or the rock would boil):
//   1. BLOTCHES   broad tonal patches — the rock is not one colour
//   2. CRATERS    a bowl with a LIT far wall and a shadowed near wall, both
//                 keyed to the sun, so they read as depth instead of as paint
//   3. SEAMS      fracture lines — the structure you read the shape by
//   4. GRAIN      fine flecks; the texture that only exists close up
//   5. LIGHT      a sunward brightening and an anti-sunward shade
//
// Layers 3 and 4 are gated on DRAWN size, not world size: zoomed out they are
// sub-pixel and cost more than they show. Layer 5 is the one place a rock gets
// a terminator at all — drawBody's shading pass skips asteroids on purpose,
// because it is dead cost on a pebble, and that reasoning stops applying at
// exactly the size where a flat disc starts looking like a hole in the sky.
// It stays deliberately gentler than the world terminator (0.30 vs 0.5): a
// rock is small enough that the far limb should still be legible.
//
// Cost: ~72 bodies in the whole world are this big (4 shoals x 18), and only
// the ones near you are drawn at all.
// ---------------------------------------------------------------------------
function bigRockDetail(b) {
  // ROUNDED TO THE UNIT, for the same reason bigRockSil's key is quantized: the
  // integrate loop eases b.radius every substep for ~1.5s after any mass change,
  // so an exact key meant this entire build — up to 42 craters behind an O(n^2)
  // rejection loop, 70 grain dots, 7 seams and five fresh arrays — ran once per
  // drawn frame per recently-touched rock, allocating, inside a draw path. The
  // cost note below reasons about a build that happens ONCE per rock, and that
  // is only true if the key can actually hold still. Nothing stored here depends
  // on the exact radius: `r` is read by the three count expressions and nowhere
  // else, so a sub-unit chip cannot change the result and rounding makes it a
  // no-op. The counts read the rounded value, so the record stays a pure
  // function of its key.
  const r = Math.round(b.radius);
  let d = b._bigDet;
  if (d && d.r === r) return d;
  const rng = mulberry32(b.id * 2654435761 + 77);
  // Broad tonal variation, and it has to stay BROAD: the first cut ran these
  // at 0.13 alpha across 0.64r, which on a 98-unit monolith is a 60-unit
  // near-black disc — several of them stacking read as holes punched in the
  // rock, not as the rock being unevenly coloured.
  const blots = [];
  for (let i = 0, n = 3 + Math.round(rng() * 3); i < n; i++) {
    blots.push({ a: rng() * TAU, q: rng() * 0.62,
      br: 0.30 + rng() * 0.34, dark: rng() < 0.58 });
  }
  // MANY SMALL craters, not a few big ones — a landmark reads as intricate
  // because it is finely pocked, and a dozen 25-unit bowls at 0.24 alpha just
  // compound into one dark mass wherever they overlap. Placement rejects on
  // top of an existing bowl for the same reason (bounded tries; a near miss is
  // fine and welcome, a stack is not).
  const craters = [];
  for (let i = 0, n = 8 + Math.min(34, Math.round(r * 0.22)); i < n; i++) {
    let c = null;
    for (let t = 0; t < 5; t++) {
      // Size skewed hard to the small end and TONE varied per bowl. Uniform
      // size at uniform alpha is what made the first cut read as polka dots on
      // a 270-unit giant: real cratering is mostly small, occasionally huge,
      // and never all the same depth.
      const cand = { a: rng() * TAU, q: Math.sqrt(rng()) * 0.74,
        cr: 0.016 + Math.pow(rng(), 2.6) * 0.165,
        k: 0.55 + rng() * 0.75 };
      const cx = Math.cos(cand.a) * cand.q, cy = Math.sin(cand.a) * cand.q;
      let clash = false;
      for (const o of craters) {
        const ox = Math.cos(o.a) * o.q, oy = Math.sin(o.a) * o.q;
        if (Math.hypot(ox - cx, oy - cy) < (o.cr + cand.cr) * 0.85) { clash = true; break; }
      }
      c = cand;
      if (!clash) break;
    }
    craters.push(c);
  }
  // Seams are SHORT wandering fractures over the surface, not chords across
  // it: a long near-straight line at this size reads as a scratch on the lens.
  const seams = [];
  for (let i = 0, n = Math.min(7, 3 + Math.round(r / 26)); i < n; i++) {
    const a0 = rng() * TAU, q0 = Math.sqrt(rng()) * 0.7;
    const steps = 4 + Math.round(rng() * 3);
    const step = (0.26 + rng() * 0.34) / steps;
    let px = Math.cos(a0) * q0, py = Math.sin(a0) * q0;
    let dir = rng() * TAU;
    const pts = [px, py];
    for (let k = 0; k < steps; k++) {
      dir += (rng() - 0.5) * 1.1;
      px += Math.cos(dir) * step; py += Math.sin(dir) * step;
      pts.push(px, py);
    }
    seams.push(pts);
  }
  const grain = [];
  for (let i = 0, n = Math.min(70, Math.round(r * 0.8)); i < n; i++) {
    grain.push({ a: rng() * TAU, q: Math.sqrt(rng()) * 0.88,
      g: 0.012 + rng() * 0.020, lit: rng() < 0.45 });
  }
  d = b._bigDet = { r, blots, craters, seams, grain };
  return d;
}

// The caller has just filled the silhouette and left the path on the context —
// it is reused here for the clip, exactly as the pit pass does.
function drawBigRockDetail(game, b) {
  const d = bigRockDetail(b);
  const r = b.radius;
  const st = nearestStar(game, b.x, b.y);
  const sunA = st ? Math.atan2(st.y - b.y, st.x - b.x) : -2.2;
  const fine = r * game.cam.zoom > BIG_FINE_PX;   // drawn size, not world size

  ctx.save();
  ctx.clip();

  // 1. BLOTCHES — broad, soft tonal variation across the face. Kept very low
  // alpha: these are meant to be felt, not seen (see the note on the geometry).
  for (const bl of d.blots) {
    const a = bl.a + b.rot;
    ctx.fillStyle = bl.dark ? 'rgba(0,0,0,0.055)' : 'rgba(255,246,232,0.040)';
    ctx.beginPath();
    ctx.arc(b.x + Math.cos(a) * bl.q * r, b.y + Math.sin(a) * bl.q * r,
      bl.br * r, 0, TAU);
    ctx.fill();
  }

  // 2. CRATERS — a bowl, then the far wall lit and the near wall shadowed.
  // Light travels from sunA across the body, so inside a bowl it lands on the
  // wall OPPOSITE the sun; that pairing is the whole reason these read as
  // holes rather than as dark spots painted on.
  for (const c of d.craters) {
    const a = c.a + b.rot;
    const cx = b.x + Math.cos(a) * c.q * r, cy = b.y + Math.sin(a) * c.q * r;
    const cr = c.cr * r;
    ctx.fillStyle = `rgba(0,0,0,${(0.13 * c.k).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
    if (!fine) continue;
    ctx.lineWidth = cr * 0.32;
    ctx.strokeStyle = `rgba(255,244,226,${(0.16 * c.k).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(cx, cy, cr * 0.82, sunA + Math.PI - 1.0, sunA + Math.PI + 1.0);
    ctx.stroke();
    ctx.strokeStyle = `rgba(0,0,0,${(0.12 * c.k).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(cx, cy, cr * 0.82, sunA - 1.0, sunA + 1.0);
    ctx.stroke();
  }

  if (fine) {
    // 3. SEAMS — solid strokes; dashes are reserved for helper/aiming UI, and
    // in-world line widths are world units so they scale with the rock.
    const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
    ctx.lineWidth = Math.max(0.4, r * 0.013);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    for (const s of d.seams) {
      for (let i = 0; i < s.length; i += 2) {
        const x = b.x + (s[i] * cs - s[i + 1] * sn) * r;
        const y = b.y + (s[i] * sn + s[i + 1] * cs) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // 4. GRAIN
    for (const g of d.grain) {
      const a = g.a + b.rot;
      ctx.fillStyle = g.lit ? 'rgba(255,248,236,0.13)' : 'rgba(0,0,0,0.16)';
      ctx.beginPath();
      ctx.arc(b.x + Math.cos(a) * g.q * r, b.y + Math.sin(a) * g.q * r,
        g.g * r, 0, TAU);
      ctx.fill();
    }
  }

  // 5. LIGHT — a sunward brightening and the shade opposite it. Two offset
  // discs clipped to the silhouette, the same shape drawBody uses on worlds.
  ctx.fillStyle = 'rgba(255,243,225,0.06)';
  ctx.beginPath();
  ctx.arc(b.x + Math.cos(sunA) * r * 0.52, b.y + Math.sin(sunA) * r * 0.52, r * 0.92, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(2,4,14,0.26)';
  ctx.beginPath();
  ctx.arc(b.x - Math.cos(sunA) * r * 0.72, b.y - Math.sin(sunA) * r * 0.72, r * 1.06, 0, TAU);
  ctx.fill();

  ctx.restore();   // also puts fillStyle back to b.color for the passes below
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

// THE WORLD'S SILHOUETTE, with the wounds actually carved out of it.
//
// A world that has been hit is not a circle any more: every impact that broke a
// piece off takes a real notch out of the OUTLINE, so the starfield shows
// through the wound and the surface detail, the terminator and the crack web
// all simply end at its edge — there is nothing painted over the planet at all.
// (History: the bite used to be drawn afterwards as an opaque space-coloured
// blob sitting on the rim, fading in over a beat. It read as a black smear
// stuck to the planet rather than as missing material, and several overlapping
// ones merged into one flat void. The user's words: "a bad black thing that
// shows up".)
//
// The profile is a cosine bowl roughened per-vertex off the scar's own seed, so
// the wall is fractured rock rather than a machined scoop, and it is stable
// frame to frame like every other seeded geometry in this file. Points are
// cached in the body's LOCAL frame and rotated in with an incremental rotor —
// the outline rides b.rot exactly like the scars it is made of, and this path
// is traced up to five times per world per frame (fill, detail clip,
// terminator clip, damage clip, eclipse).
// The body size damage detail is authored against — see drawBodyDamage's dR.
const DETAIL_R = 260;
const SIL_N = 144;
function worldSil(b) {
  const scars = b.scars;
  const newest = scars.length ? scars[scars.length - 1].t : -1;
  let s = b._sil;
  if (!s || s.n !== scars.length || s.t !== newest || s.r !== b.radius) {
    s = b._sil = { n: scars.length, t: newest, r: b.radius, rr: new Float32Array(SIL_N) };
    // util.scarSurfaceAt is the ONE crater profile — physics.surfRadius
    // queries that same function for the COLLIDER, so the crater you can see
    // and the crater you can fly into are the same crater by construction.
    for (let i = 0; i < SIL_N; i++) s.rr[i] = scarSurfaceAt(scars, b.radius, (i / SIL_N) * TAU);
  }
  const step = TAU / SIL_N;
  const dc = Math.cos(step), ds = Math.sin(step);
  let c = Math.cos(b.rot), sn = Math.sin(b.rot);
  ctx.beginPath();
  for (let i = 0; i < SIL_N; i++) {
    const rr = s.rr[i] * b.radius;
    const px = b.x + c * rr, py = b.y + sn * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    const nc = c * dc - sn * ds;
    sn = sn * dc + c * ds;
    c = nc;
  }
  ctx.closePath();
}

// One entry point for "the shape this body actually is" — a crystal world's
// jagged facets, a wounded world's notched limb, a plain disc otherwise. Every
// fill and clip that means the BODY goes through here, so the drawn surface and
// the wounds in it can never disagree about where the edge is.
// **KEEP IN SYNC WITH physics.surfRadius** — that function is the collider and
// this one is the picture, and they must agree body-for-body about which shape
// each one is. Rocks are excluded from cratering in BOTH (they collide as
// circles and draw as their own jag silhouette); crystal worlds keep their
// facets in both, since carving notches into a shape that is already fractured
// fights the read instead of adding to it.
// THE SEA'S LIMB RIPPLES (user design call). A swell that only drew inside the
// silhouette left the world a perfect circle with rings painted on it — the one
// edge in the frame that would actually deform stayed rigid. So the crest
// DISPLACES the drawn outline as it rolls past, and because traceSurface backs
// the fill, the clip and every clipped detail pass, the whole world breathes
// with it for free.
//
// Baked ONCE per frame into seaRad, never per traceSurface call: the sea is
// traced five or six times a frame (disc, detail clip, specular, ripples,
// veil) and there can be OCEAN_RING_MAX live waves, so re-walking the hit list
// inside the trace is the one way to make an outline this cheap expensive.
// Only a sea with live waves gets a path at all — every other body, and a calm
// ocean, keeps the plain-arc fast path below.
const SEA_SEG = 96;
const seaRad = new Float32Array(SEA_SEG + 1);
let seaWaveBody = null;

// The wave's reach + signed strength at age u comes from config.seaPhase — it
// has three consumers (this limb, the drawn rings, and physics' chop damage)
// and they must never disagree about what the water is doing. See its header
// for the two-act shape and the three separate pops it exists to prevent.

function buildSeaWaves(game) {
  seaWaveBody = null;
  const oceans = frameReg(game).oceans;
  if (!oceans || !oceans.length) return;
  const T = CFG.OCEAN_RIPPLE_T;
  for (const b of oceans) {
    if (!b.alive || !b.seaHits || !b.seaHits.length) continue;
    const R = b.radius;
    let live = 0;
    for (let i = 0; i <= SEA_SEG; i++) seaRad[i] = R;
    for (const h of b.seaHits) {
      const age = game.time - h.t;
      if (age < 0 || age >= T) continue;
      live++;
      const u = age / T;
      const ang = h.a + b.rot;
      const { reach, env } = seaPhase(R, u, h.s);
      // SIGNED: negative during the cavity, so the limb dents inward at the
      // strike before the crest rolls out of it.
      const amp = R * CFG.OCEAN_WAVE_AMP * env * h.s;
      const w = R * 0.11;                       // crest half-width along the limb
      for (let i = 0; i <= SEA_SEG; i++) {
        // Arc distance from the wave's origin BEARING — the hit is stamped on
        // the surface, so its rings meet the limb at ±reach of arc either way.
        let d = (i / SEA_SEG) * TAU - ang;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const x = (Math.abs(d) * R - reach) / w;
        if (x > -3 && x < 3) {
          // A crest with troughs behind and ahead of it, not a lone bulge —
          // one-sided displacement reads as the world swelling, not as water.
          seaRad[i] += amp * Math.cos(x * 2.1) * Math.exp(-x * x);
        }
      }
    }
    if (live) { seaWaveBody = b; break; }   // one sea to a system
  }
}

function seaSurface(b) {
  ctx.beginPath();
  for (let i = 0; i < SEA_SEG; i++) {
    const th = (i / SEA_SEG) * TAU, rr = seaRad[i];
    const px = b.x + Math.cos(th) * rr, py = b.y + Math.sin(th) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function traceSurface(b) {
  if (b.type === 'asteroid') { traceAsteroid(b); return; }
  if (b.ptype === 'crystal') { traceCrystal(b); return; }
  if (b.scars.length) { worldSil(b); return; }
  if (b === seaWaveBody) { seaSurface(b); return; }
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, TAU);
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

// A ringed giant's band is a TILTED DISC the world sits inside, so it is drawn
// in TWO PASSES around the planet: the far half before the disc, the near half
// after it. One full-ellipse pass ahead of the planet put the WHOLE ring
// behind — the world occluded the near arc on every frame, which reads as a
// decal painted on the backdrop rather than a body wearing a ring.
//
// The split is taken in the ellipse's OWN parameter space, not screen space, so
// it follows the band's slow tilt (b.rot * 0.15) for free: the pre-rotation
// offset is (rx·cos t, ry·sin t), and canvas y grows downward — toward the
// viewer — so sin t > 0, i.e. t in [0, π], is the near arc. Defining it this
// way also means the near half rotates WITH the ring instead of snapping over
// to the other side when the tilt sweeps past an axis.
//
// The two arcs share their endpoints at the ellipse's extreme x, well outside
// the planet's limb, and are stroked identically, so they meet with no seam.
// They must not overlap: at globalAlpha 0.4 any double-stroked span would
// blend to 0.64 and print a bright pip at each tip.
function drawRing(game, b, near) {
  // ringDecay (shepherd stolen/smashed): the ring blurs outward and fades —
  // wider, dimmer strokes read as the lanes scattering
  const decay = b.ringDecay || 0;
  const a0 = near ? 0 : Math.PI;
  const a1 = near ? Math.PI : TAU;
  const tilt = b.rot * 0.15;
  ctx.globalAlpha = 0.4 * (1 - decay * 0.8);
  ctx.strokeStyle = b.color;
  if (b.ringGap) {
    // Shepherded ring: two crisp bands with a swept gap between them
    ctx.lineWidth = b.radius * 0.13 * (1 + decay * 2.2);
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, b.radius * 1.72, b.radius * 0.53, tilt, a0, a1);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, b.radius * 2.14, b.radius * 0.66, tilt, a0, a1);
    ctx.stroke();
  } else {
    ctx.lineWidth = b.radius * 0.34 * (1 + decay * 1.4);
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, b.radius * 2.0, b.radius * 0.62, tilt, a0, a1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ===========================================================================
// THE SUN — a place you fly to, not a light source painted on the backdrop
// ===========================================================================
// The star is 4,800 units across. It fills the screen from a lane away and
// keeps filling it all the way in, so the ONE question every pass here answers
// is: WHAT RESOLVES WHEN YOU GET CLOSER? A cream disc with four soft blobs on
// it reads as a flat sticker at every distance — the size never lands, because
// nothing on the surface has a size of its own for the eye to measure against.
//
// So the surface carries detail at THREE scales, each fading in at its own zoom:
//
//   SUPERGRANULES  live radial-gradient cells ~1,000 units across, in both
//                  signs — the churn you can see from outside the corona. These
//                  carry the COARSE scale on purpose: they are non-repeating and
//                  they evolve, and a tiled texture at that size reads as
//                  wallpaper.
//   GRANULATION    baked convection tiles drawn as PATTERNS at three world
//                  scales (cells ~129 / 43 / 14 units). Two fills per octave, no
//                  per-cell cost, and each octave fades out below ~8 screen
//                  pixels so a distant sun never dissolves into aliased hiss.
//   CHROMOSPHERE   the boiling fringe on the limb, ~50 units deep — about ten
//                  hull widths. This is the pass that actually SELLS the scale,
//                  because it is the only feature small enough to compare
//                  yourself to, which is exactly why it is worth its cost.
//
// NO SUNSPOTS. A full anatomy was built here — bipolar groups, irregular umbra,
// filamented penumbra, facular plage — and cut on sight: at this size a spot is
// a large dark object sitting ON a surface that is otherwise all light and
// motion, and it read as damage rather than as weather no matter how the tones
// were graded. The star is better off as a body that is uniformly, enormously
// alive. Don't re-add them without solving that read first.
//
// GRANULATION MUST BOIL, AND IT MUST NOT TILE. A pattern gets both wrong for
// free, and both were caught on sight: rigidly rotating one tile at ~1°/s is a
// STATIC texture, and a tile 1,500 units wide repeats three times across the
// disc, which the eye reads as wallpaper rather than as surface. So the tiles
// are (a) SMALL enough that repetition reads as grain instead of as pattern,
// and (b) THREE different bakes that each octave CROSS-FADES between on its own
// clock — cells dissolve where they were and appear where they weren't, which
// is what convection actually looks like. The octaves also shear over each
// other at different rates, so no two frames line up twice.
//
// COST IS BOUNDED BY THE SCREEN, NEVER BY THE SUN. The pattern fills clip to
// the photosphere and the canvas does the rest; the limb passes walk only the
// bearing window the camera can actually see, solved as a circle-circle
// intersection (`limbWindow`) rather than the storm wave's approximation —
// the camera can sit INSIDE this body, where an asin window is meaningless.
//
// THE SURFACE TURNS, and slowly: SUN_SPIN is a ~6-minute rotation, which puts
// the limb moving at ~85 units/s — a fraction of cruising speed, so you overtake
// it and it reads as a huge thing turning rather than a spinning top. Every
// surface feature is placed in that ROTATING FRAME, or the granulation would
// stream past stationary spots and the whole illusion would come apart.
const SUN_SPIN = 0.0175;         // rad/s — a full turn in ~6 minutes
// THE STAR'S DRAWN ENVELOPE, in radii — the corona gradient's outer stop, and
// the outermost thing drawStar paints. Every other pass is inside it: the
// corona lobes reach 3.02R (seated at <=1.62R with a <=1.40R tail), the
// prominences 1.23R, the limb smear 1.10R.
//
// THE CULL READS IT TOO, and that sharing is the point. bodyOnScreen's generic
// margin is 4R + 80, which for a 4,800-unit sun overshoots by ~2,000 units — a
// shell where the star paints literally nothing (measured: a framebuffer diff
// at 17,500 units came back zero) and still cost 0.13ms a frame, ~43% of the
// frame's whole draw. Two of the four inner worlds sit in that shell. Both the
// cull and the corona gradient below take their reach from this one constant,
// so the cull can never drift wider than what is actually painted. (Module
// scope, not an export — bodyOnScreen lives in this file.)
const SUN_HALO = 3.6;
const GRAN_PX = 256;             // baked tile resolution
const GRAN_CELLS = 7;            // cells per tile side
// Octave world spans. `span` is how wide one tile lands in world units, so a
// cell is span/GRAN_CELLS across; the rot offsets and the differing spin rates
// are what stop three copies of one tile from reading as three copies of one
// tile — they shear over each other, which also makes the surface look like it
// is boiling without a single per-frame cell.
// `boil` is seconds per cross-fade step — the smaller the cell, the shorter it
// lives, same as the real thing.
const GRAN_OCT = [
  { span: 900, alpha: 0.40, spin: 1.00, rot: 0.0, boil: 17, ph: 0.0 },
  { span: 300, alpha: 0.32, spin: 1.35, rot: 0.9, boil: 9, ph: 0.37 },
  { span: 100, alpha: 0.24, spin: 1.80, rot: 2.1, boil: 5, ph: 0.71 },
];
const GRAN_BAKES = 3;
const granTiles = [];
const granPats = [];
let granDead = false;
// Prominence ribbon bands: [width multiplier, colour]. Widest and coolest
// first — see the fill loop for why there are six of them and not one.
const PROM_BANDS = [
  [1.55, 'rgba(255, 104, 30, 0.032)'],
  [1.24, 'rgba(255, 120, 38, 0.036)'],
  [0.96, 'rgba(255, 142, 52, 0.040)'],
  [0.70, 'rgba(255, 166, 72, 0.044)'],
  [0.46, 'rgba(255, 194, 104, 0.048)'],
  [0.24, 'rgba(255, 226, 152, 0.055)'],
];
// Widest band's half-width, in radii — the inflation the prominence cull adds
// to the ribbon's control hull. Derived from the table rather than typed, so
// widening a band cannot leave the cull clipping the thing it widened.
const PROM_W_MAX = 0.05 * Math.max(...PROM_BANDS.map(([w]) => w)) + 0.002;

// Bake the convection tile once: a dark intergranular bed, cells ERASED out of
// it (so the lanes are what is left, the way granulation actually reads), then
// a faint bright kiss in each cell centre. Seamless — every cell is stamped at
// all nine wrap offsets, so the tile repeats without a seam.
function bakeGranTiles() {
  if (granTiles.length || granDead) return granTiles;
  try {
    for (let n = 0; n < GRAN_BAKES; n++) granTiles.push(bakeOneGranTile(9137 + n * 4271));
  } catch (e) {
    // Tiles we cannot bake cost the sun its granulation, nothing else — the
    // disc, the supergranules, the prominences and the limb all draw without it
    // (capability rule).
    granDead = true;
    granTiles.length = 0;
  }
  return granTiles;
}

function bakeOneGranTile(seed) {
  {
    const cv = document.createElement('canvas');
    cv.width = cv.height = GRAN_PX;
    const c = cv.getContext('2d');
    if (!c) throw new Error('no 2d context');
    const rng = mulberry32(seed);
    const N = GRAN_CELLS, sp = GRAN_PX / N;
    const cells = [];
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      cells.push({
        x: (ix + 0.5 + (rng() - 0.5) * 0.78) * sp,
        y: (iy + 0.5 + (rng() - 0.5) * 0.78) * sp,
        r: sp * (0.40 + rng() * 0.48),
        k: 0.45 + rng() * 0.55,
      });
    }
    const stamp = (fn) => {
      for (const cl of cells) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const x = cl.x + ox * GRAN_PX, y = cl.y + oy * GRAN_PX;
        if (x + cl.r < 0 || x - cl.r > GRAN_PX || y + cl.r < 0 || y - cl.r > GRAN_PX) continue;
        fn(x, y, cl);
      }
    };
    // The lane bed is AMBER, not brown. Real intergranular lanes are only a
    // fraction darker than the granules; taken too dark and too saturated the
    // whole star stops reading as white-hot and comes out looking like coral.
    c.fillStyle = 'rgba(158, 74, 16, 0.46)';
    c.fillRect(0, 0, GRAN_PX, GRAN_PX);
    c.globalCompositeOperation = 'destination-out';
    stamp((x, y, cl) => {
      const g = c.createRadialGradient(x, y, 0, x, y, cl.r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.58, 'rgba(0,0,0,0.95)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, cl.r, 0, TAU); c.fill();
    });
    c.globalCompositeOperation = 'source-over';
    stamp((x, y, cl) => {
      const g = c.createRadialGradient(x, y, 0, x, y, cl.r * 0.86);
      g.addColorStop(0, `rgba(255, 248, 220, ${0.20 * cl.k})`);
      g.addColorStop(0.55, `rgba(255, 226, 160, ${0.09 * cl.k})`);
      g.addColorStop(1, 'rgba(255, 226, 160, 0)');
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, cl.r * 0.86, 0, TAU); c.fill();
    });
    return cv;
  }
}

// The bearing window of a body's LIMB that the view can see, as a half-angle
// about the bearing from the body to the camera. Returns 0 when no part of the
// limb is on screen — which includes the camera being deep INSIDE the star, the
// case an asin(viewR/d) window gets wrong.
function limbWindow(bx, by, R) {
  const dx = view.cx - bx, dy = view.cy - by;
  const d = Math.hypot(dx, dy);
  const vr = view.r;
  if (d + vr < R || d - vr > R) return 0;     // view wholly inside, or wholly beyond
  if (d < 1e-6) return Math.PI;
  const c = (d * d + R * R - vr * vr) / (2 * d * R);
  if (c <= -1) return Math.PI;
  if (c >= 1) return 0;
  return Math.min(Math.PI, Math.acos(c) + 0.05);
}

// Deterministic 0..1 hash — spicules and streamers must be stable frame to
// frame or the limb strobes.
function sunHash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function drawStar(game, b) {
  const R = b.radius, t = game.time, px = game.cam.zoom;
  const rot = t * SUN_SPIN;
  const limbPx = R * px;

  // ---- CORONA. Many stops, not four: the old four-stop ramp printed visible
  // concentric BANDS across a body this large, which is a hard edge in world by
  // any other name. The falloff below is roughly exponential and reads smooth.
  const cg = ctx.createRadialGradient(b.x, b.y, R * 0.2, b.x, b.y, R * SUN_HALO);
  cg.addColorStop(0, b.color);
  cg.addColorStop(0.14, b.color + 'ee');
  cg.addColorStop(0.24, b.color + 'b0');
  cg.addColorStop(0.33, b.color + '76');
  cg.addColorStop(0.43, b.color + '4c');
  cg.addColorStop(0.55, b.color + '30');
  cg.addColorStop(0.68, b.color + '1c');
  cg.addColorStop(0.82, b.color + '0e');
  cg.addColorStop(1, 'transparent');
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(b.x, b.y, R * SUN_HALO, 0, TAU); ctx.fill();

  ctx.globalCompositeOperation = 'lighter';

  // EVERY PASS BELOW CULLS AGAINST THE VIEW. The limb pass (bottom of this
  // function) has always walked only the arc the camera can see; nothing else
  // did, so on a disc wider than the screen the star submitted its whole self —
  // fifteen corona lobes, sixty-six prominence polygons, twenty-six
  // supergranules and a full-disc pattern fill — however little of it landed.
  // Each pass now tests its own exact extent, which is cheaper and tighter than
  // one shared bearing window would be: they sit at very different radii.

  // ---- CORONAL STRUCTURE. The corona is not a fog, it is a SHAPE — it reaches
  // further where the field is open and hugs the limb where it is closed. Built
  // as a union of SOFT LOBES seated around the limb at varying reach, so the
  // halo comes out ragged and directional with nothing anywhere that is a
  // straight edge. Two shapes were tried before this and both broke that rule:
  // wedge streamers (a fan filled through a radial gradient) read as
  // searchlights, and a single lumpy ENVELOPE PATH printed its own outline —
  // the gradient still has alpha wherever the envelope dips inside its own
  // maximum, so the path boundary shows. A lobe that feathers to zero on its
  // own can't do either. They drift far slower than the surface, because the
  // field is anchored deep and the outer atmosphere visibly lagging the body it
  // belongs to is itself a scale cue.
  for (let i = 0; i < 15; i++) {
    const h = sunHash(i * 3.9 + b.id), h2 = sunHash(i * 8.1 + 3);
    const a = (i / 15) * TAU + h * 0.42 + rot * (0.18 + h2 * 0.12);
    const d = R * (0.95 + 0.55 * h2 + 0.12 * Math.sin(t * 0.06 + i));
    const br = R * (0.55 + 0.85 * h);
    const cx = b.x + Math.cos(a) * d, cy = b.y + Math.sin(a) * d;
    // A lobe IS a circle — (cx, cy, br) is its exact extent, since the gradient
    // reaches zero at br. So the cull is exact, not a bound, and from anywhere
    // outside the corona all fifteen of these fall out for four compares each.
    if (!circleOnScreen(cx, cy, br)) continue;
    // The tail has to fall off SMOOTHLY or the lobe prints its own circle: a
    // gradient that runs linearly to zero has a kink at its outer stop, and
    // where several overlap that kink reads as an arc drawn in the corona.
    const a0 = 0.040 + 0.040 * h;
    const eg = ctx.createRadialGradient(cx, cy, 0, cx, cy, br);
    eg.addColorStop(0, `rgba(255, 224, 162, ${a0})`);
    eg.addColorStop(0.30, `rgba(255, 214, 146, ${a0 * 0.55})`);
    eg.addColorStop(0.55, `rgba(255, 202, 122, ${a0 * 0.25})`);
    eg.addColorStop(0.76, `rgba(255, 190, 104, ${a0 * 0.09})`);
    eg.addColorStop(0.90, `rgba(255, 182, 94, ${a0 * 0.025})`);
    eg.addColorStop(1, 'rgba(255, 178, 88, 0)');
    ctx.fillStyle = eg;
    ctx.beginPath(); ctx.arc(cx, cy, br, 0, TAU); ctx.fill();
  }

  // ---- PROMINENCE LOOPS: plasma arcs that rise off the surface and dive BACK
  // IN — closed magnetic loops, the way real suns wear their fire. Each loop is
  // a TAPERED RIBBON, fat through the crown and pinched into the surface at both
  // footpoints, because a constant-width bright wire read as an antenna glued to
  // the limb — that is what made the old sun look like a cartoon rather than a
  // body. They are rooted in the ROTATING FRAME, so a loop belongs to a patch of
  // surface and travels with it.
  //
  // FILLED, never stroked segment by segment. A tapered stroke has to be walked
  // as N short strokes, and under 'lighter' every round cap overlaps its
  // neighbour and blends twice — at close range a loop came out as a visible
  // CHAIN OF DISCS. One closed polygon per band has no seams to print.
  const SEG = 14, NPROM = 11;
  for (let i = 0; i < NPROM; i++) {
    const hp = sunHash(i * 2.7 + b.id);
    const a0 = (i / NPROM) * TAU + b.id + rot + hp * 0.4 + Math.sin(t * 0.03 + i * 2.1) * 0.1;
    const span = 0.10 + 0.13 * hp + 0.06 * (0.5 + 0.5 * Math.sin(i * 1.9 + t * 0.045));
    const a1 = a0 + span;
    // Reach is deliberately SHORT and varied. Uniform tall loops read as a set
    // of handles glued to the limb; a ragged low fringe with the odd tall arch
    // reads as fire standing off a surface.
    const h = R * (0.03 + 0.15 * hp) * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * (0.06 + (i % 3) * 0.025) + i * 2.6)));
    const R0 = R * 0.93;
    const x0 = b.x + Math.cos(a0) * R0, y0 = b.y + Math.sin(a0) * R0;
    const x1 = b.x + Math.cos(a1) * R0, y1 = b.y + Math.sin(a1) * R0;
    const am = a0 + span / 2;
    const cxp = b.x + Math.cos(am) * (R0 + h * 2), cyp = b.y + Math.sin(am) * (R0 + h * 2);
    // SIX filled 30-point polygons hang off this loop, and on a body whose disc
    // is wider than the screen most of the eleven loops are round the back. A
    // quadratic Bezier is contained in the CONVEX HULL of its three control
    // points, so the hull's box inflated by the widest band is an exact bound —
    // no sampling, and it can never clip a ribbon it should have kept.
    const pw = R * PROM_W_MAX;
    if (Math.min(x0, x1, cxp) - pw > view.x1 || Math.max(x0, x1, cxp) + pw < view.x0
      || Math.min(y0, y1, cyp) - pw > view.y1 || Math.max(y0, y1, cyp) + pw < view.y0) continue;
    const at = (k) => {   // point on the quadratic at parameter k
      const m = 1 - k;
      return [m * m * x0 + 2 * m * k * cxp + k * k * x1, m * m * y0 + 2 * m * k * cyp + k * k * y1];
    };
    // SIX nested bands, not three, and each one faint. A filled ribbon has a
    // crisp boundary, and one wide band at a readable alpha prints that boundary
    // straight across the screen when you are close enough to fly through the
    // loop — the in-world hard edge again. Stacking thin bands additively is how
    // a fill gets a soft shoulder: the sum ramps up toward the core instead of
    // stepping there. The SHEATH still carries the read and the core is only the
    // hint inside it; the old draw inverted that, and a bright constant-width
    // wire on a limb this long is an antenna, not plasma.
    for (const [wMul, col] of PROM_BANDS) {
      ctx.fillStyle = col;
      ctx.beginPath();
      // out along one side of the ribbon, back along the other
      for (let s = 0; s <= SEG * 2 + 1; s++) {
        const back = s > SEG;
        const si = back ? SEG * 2 + 1 - s : s;
        const k = si / SEG, p = at(k);
        const d = at(Math.min(1, k + 0.02)), e = at(Math.max(0, k - 0.02));
        let nx = -(d[1] - e[1]), ny = d[0] - e[0];
        const m = Math.hypot(nx, ny) || 1; nx /= m; ny /= m;
        // sqrt taper: fat through the crown, pinched at both footpoints
        const w = (R * 0.05 * wMul * Math.sqrt(Math.sin(Math.PI * k)) + R * 0.002) * (back ? -1 : 1);
        const x = p[0] + nx * w, y = p[1] + ny * w;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  // ---- PHOTOSPHERE. NOT a perfect circle — a slow magma swell, three faint
  // radial harmonics breathing at different rates (subtle: <2% of radius)
  const surf = (th) => R * 0.94 * (1
    + 0.016 * Math.sin(th * 5 + t * 0.18)
    + 0.011 * Math.sin(th * 9 - t * 0.28)
    + 0.007 * Math.sin(th * 13 + t * 0.42));
  const tracePhotosphere = () => {
    ctx.beginPath();
    const N = 96;
    for (let i2 = 0; i2 <= N; i2++) {
      const th = (i2 / N) * TAU;
      const rr2 = surf(th);
      const px2 = b.x + Math.cos(th) * rr2, py2 = b.y + Math.sin(th) * rr2;
      if (i2 === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
    }
    ctx.closePath();
  };
  // The disc's own body is LIMB-DARKENED from the start — hot white at the
  // centre falling to a deep amber at the edge. This is the single cheapest
  // thing that makes a flat disc read as an enormous ball, and everything
  // painted on top of it inherits the shading for free.
  const bg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, R * 0.94);
  bg.addColorStop(0, '#fffdf4');
  bg.addColorStop(0.42, '#fff6da');
  bg.addColorStop(0.70, '#ffe9ae');
  bg.addColorStop(0.88, '#ffcf74');
  bg.addColorStop(1, '#f6ab3c');
  ctx.fillStyle = bg;
  tracePhotosphere(); ctx.fill();

  ctx.save();
  tracePhotosphere(); ctx.clip();

  // ---- GRANULATION. One baked tile, three world scales. Each octave fades out
  // below ~6 screen pixels per cell: past that it is not detail any more, it is
  // aliasing, and a distant star should be a clean disc.
  const tiles = bakeGranTiles();
  if (tiles.length) {
    if (!granPats.length) for (const tl of tiles) granPats.push(ctx.createPattern(tl, 'repeat'));
    for (let i = 0; i < GRAN_OCT.length; i++) {
      const o = GRAN_OCT[i];
      // Fade in SLOWLY with drawn cell size. Granulation that reaches full
      // strength at a few pixels per cell turns the whole disc into an even
      // speckle — orange peel — and an even speckle flattens a sphere just as
      // hard as no texture at all. Under ~8px the live supergranules carry the
      // surface on their own, which is the read that belongs at that distance.
      const cellPx = (o.span / GRAN_CELLS) * px;
      const k = clamp((cellPx - 8) / 14, 0, 1);
      if (k <= 0.02) continue;
      const s = o.span / GRAN_PX;
      const q = R / s + GRAN_PX;
      // THE BOIL: walk the bakes on this octave's own clock and cross-fade the
      // pair either side of the walk. `f` is smoothstepped so a cell dissolves
      // instead of switching, and the two alphas sum to one so the octave's
      // overall weight never pulses.
      const phase = t / o.boil + o.ph;
      const idx = Math.floor(phase);
      const fr = phase - idx;
      const f = fr * fr * (3 - 2 * fr);
      for (let n = 0; n < 2; n++) {
        const pat = granPats[(idx + n) % granPats.length];
        if (!pat) continue;
        // Each bake also gets its own bearing, so a cross-fade is never two
        // layouts sitting on the same spot fading into one another.
        const ang = rot * o.spin + o.rot + ((idx + n) % granPats.length) * 2.09;
        // THE RECT IS THE WHOLE DISC, AND THE DISC IS BIGGER THAN THE SCREEN.
        // -q..q spans the star; on the finest octave that is a 25,000-unit
        // square of pattern fill to cover a view a tenth as wide. So the rect
        // is cut down to the VIEW, mapped back through this bake's own
        // rotate+scale. The pattern is anchored to the TRANSFORM, not to the
        // rect, so a smaller rect shifts nothing — inside the photosphere clip
        // the pixels are identical, there are just far fewer tiles to lay.
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
        for (let ci = 0; ci < 4; ci++) {
          const wx = (ci & 1 ? view.x1 : view.x0) - b.x;
          const wy = (ci & 2 ? view.y1 : view.y0) - b.y;
          const lx = (wx * ca + wy * sa) / s, ly = (wy * ca - wx * sa) / s;
          if (lx < lx0) lx0 = lx;
          if (lx > lx1) lx1 = lx;
          if (ly < ly0) ly0 = ly;
          if (ly > ly1) ly1 = ly;
        }
        const rx0 = Math.max(-q, lx0), ry0 = Math.max(-q, ly0);
        const rx1 = Math.min(q, lx1), ry1 = Math.min(q, ly1);
        if (rx1 <= rx0 || ry1 <= ry0) continue;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(ang);
        ctx.scale(s, s);
        ctx.globalAlpha = o.alpha * k * (n ? f : 1 - f);
        ctx.fillStyle = pat;
        ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- SUPERGRANULES: the coarsest churn, and the pass that carries the whole
  // surface at any distance where a granule is under a few pixels. Live, so it
  // never repeats and never stops moving.
  //
  // BOTH SIGNS. They were additive-only at first, which meant the disc could
  // only ever get brighter in patches — mottling needs the dark half or the
  // surface reads as a clean sphere with lamps on it. The dark set is bigger,
  // slower and fainter than the bright set, the way a convective floor sits
  // under the cells rather than beside them.
  const cellCount = 13;
  for (let pass = 0; pass < 2; pass++) {
    const dark = pass === 0;
    ctx.globalCompositeOperation = dark ? 'source-over' : 'lighter';
    for (let i = 0; i < cellCount; i++) {
      const h = sunHash(i * 3.1 + b.id + (dark ? 41 : 0));
      const h2 = sunHash(i * 6.7 + (dark ? 17 : 5));
      const a = rot * (dark ? 0.82 : 1.0) + i * 2.39 + b.id + h * 1.7;
      const rr = R * (0.10 + 0.76 * h);
      // Each cell wanders on its own slow epicycle — the churn is the point
      const wob = Math.sin(t * (0.018 + h2 * 0.02) + i) * (dark ? 0.10 : 0.07);
      const bx = b.x + Math.cos(a + wob) * rr, by = b.y + Math.sin(a + wob) * rr;
      const swell = 0.5 + 0.5 * Math.sin(t * (0.03 + h2 * 0.03) + i * 2.1);
      const br = R * (dark ? 0.22 + 0.20 * h2 : 0.14 + 0.13 * h2) * (0.75 + 0.35 * swell);
      const al = (dark ? 0.13 : 0.26) * (0.45 + 0.55 * swell);
      // Exact, like the corona lobes: the gradient reaches zero at br, so a
      // cell that misses the view contributes nothing. Half of them are round
      // the back of the disc at any close range.
      if (!circleOnScreen(bx, by, br)) continue;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, dark ? `rgba(196, 96, 22, ${al})` : `rgba(255, 250, 226, ${al})`);
      g.addColorStop(0.5, dark ? `rgba(204, 108, 30, ${al * 0.5})` : `rgba(255, 208, 128, ${al * 0.5})`);
      g.addColorStop(0.78, dark ? `rgba(210, 118, 38, ${al * 0.16})` : `rgba(255, 196, 110, ${al * 0.16})`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
    }
  }
  // Back to source-over EXPLICITLY, and this line is load-bearing: the pass
  // below is the only one on the face that has to SUBTRACT light. Left on the
  // 'lighter' the supergranule loop ends in, it silently inverts into a warm
  // bloom over the outer disc — which still looks plausible, and is exactly why
  // that bug survived a playtest. Never let this be inherited from whatever
  // pass happened to run last.
  ctx.globalCompositeOperation = 'source-over';

  // ---- The limb-darkening pass proper, over everything painted on the face.
  // The base gradient shades the disc; this one shades the DETAIL, so a granule
  // near the edge dims with the surface it sits on instead of floating on it.
  const ld = ctx.createRadialGradient(b.x, b.y, R * 0.40, b.x, b.y, R * 0.95);
  ld.addColorStop(0, 'rgba(180, 70, 12, 0)');
  ld.addColorStop(0.55, 'rgba(184, 76, 14, 0.07)');
  ld.addColorStop(0.82, 'rgba(168, 62, 10, 0.17)');
  ld.addColorStop(1, 'rgba(140, 46, 6, 0.30)');
  ctx.fillStyle = ld;
  ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
  ctx.restore();

  // ---- THE LIMB. Everything past here is the edge of the star, and it only
  // walks the arc the camera can actually see — from a thousand units out that
  // is a few degrees of a body this size, so the fringe costs the same whether
  // you are outside the corona or skimming the surface.
  const halfA = limbWindow(b.x, b.y, R * 0.94);
  if (halfA > 0) {
    const midA = Math.atan2(view.cy - b.y, view.cx - b.x);
    // THE SMEAR — the pass that stops the biggest curve in the game from being a
    // drawn line, and the pass that makes the near-limb approach feel like the
    // sun instead of like a lit ball. The photosphere is a FILLED PATH, so
    // however softly it is shaded inside, it ENDS: a solid amber disc butts
    // straight against the corona behind it and the step between them reads as a
    // stroke the whole way round. Nothing painted on the face can fix that,
    // because the clip is exactly what makes it.
    //
    // So the disc's own limb colour is smeared OUTWARD past where the fill stops,
    // source-over and fading over ~0.14R, which puts photosphere colour on both
    // sides of the boundary and leaves nothing for the eye to lock onto.
    //
    // IT IS DELIBERATELY WIDE. A tight feather that hugged the outline was tried
    // and it does dissolve the seam more cheaply — but flying the limb then reads
    // as skimming a big warm object, and this is a STAR: at a few hundred units
    // off the surface the whole view should be drowning in its light. That is the
    // effect, not a side effect, so the width stays. Additive is still wrong
    // here: adding light AT the edge brightens the seam, which is the opposite
    // of dissolving it.
    const sm = ctx.createRadialGradient(b.x, b.y, R * 0.88, b.x, b.y, R * 1.10);
    sm.addColorStop(0, 'rgba(246, 171, 60, 0)');
    sm.addColorStop(0.28, 'rgba(246, 171, 60, 0.55)');
    sm.addColorStop(0.52, 'rgba(240, 148, 48, 0.34)');
    sm.addColorStop(0.76, 'rgba(226, 122, 40, 0.14)');
    sm.addColorStop(1, 'rgba(214, 104, 34, 0)');
    ctx.fillStyle = sm;
    ctx.beginPath(); ctx.arc(b.x, b.y, R * 1.10, 0, TAU); ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    // …then the hot chromospheric line the star actually ends on, kept faint and
    // wide, riding on top of the smear rather than replacing it.
    const ch = ctx.createRadialGradient(b.x, b.y, R * 0.84, b.x, b.y, R * 1.08);
    ch.addColorStop(0, 'rgba(255, 110, 40, 0)');
    ch.addColorStop(0.45, 'rgba(255, 128, 46, 0.07)');
    ch.addColorStop(0.70, 'rgba(255, 152, 60, 0.10)');
    ch.addColorStop(0.88, 'rgba(255, 180, 88, 0.05)');
    ch.addColorStop(1, 'rgba(255, 150, 60, 0)');
    ctx.fillStyle = ch;
    ctx.beginPath(); ctx.arc(b.x, b.y, R * 1.08, 0, TAU); ctx.fill();

    // THE BOIL ON THE EDGE. Up close the limb has to be doing something, or the
    // largest curve in the game is a smooth arc with a glow behind it. What it
    // must NOT be is strands: individual jets were drawn here first and every
    // one of them read as a HAIR — a stiff, separable, slightly comic fringe
    // that made the star look furry rather than molten.
    //
    // So the fringe is CELLS, not strands: soft blobs seated on the surface,
    // each feathering to nothing on its own, each swelling and subsiding on its
    // own clock. Overlapping at this density they merge into one ragged hot edge
    // that churns — no strand to pick out, and no boundary anywhere, which is
    // also what keeps the biggest edge in the game off the hard-edge list.
    if (limbPx > 90) {
      const arc = halfA * 2;
      // Density comes off the DRAWN arc, not the bearing window: how many cells
      // fit along an edge is a screen fact.
      const n = Math.min(220, Math.max(18, Math.round(arc * limbPx / 15)));
      for (let i = 0; i < n; i++) {
        const h = sunHash(i * 1.7 + b.id * 5);
        const h2 = sunHash(i * 4.3 + 11);
        const a = midA - halfA + (i + h * 0.9) / n * arc;
        const life = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * (0.45 + h2 * 0.7) + i * 2.7));
        const cr = R * (0.010 + 0.022 * h2) * (0.55 + 0.45 * life);
        if (cr * px < 2) continue;
        // STRADDLING the surface, never sitting above it. Cells set on a common
        // standoff put every feather at the same height and the fringe grows a
        // second edge of its own; scattered across the boundary they leave the
        // limb ragged instead, so there is no depth anyone could read off it.
        const rr = surf(a) + cr * (h - 0.62) * 0.9;
        const cx = b.x + Math.cos(a) * rr, cy = b.y + Math.sin(a) * rr;
        const al = (0.09 + 0.15 * life) * (0.6 + 0.4 * h);
        const cg2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
        cg2.addColorStop(0, `rgba(255, ${(178 + 46 * h) | 0}, ${(96 + 46 * h2) | 0}, ${al})`);
        cg2.addColorStop(0.45, `rgba(255, ${(140 + 40 * h) | 0}, 58, ${al * 0.5})`);
        cg2.addColorStop(1, 'rgba(255, 120, 44, 0)');
        ctx.fillStyle = cg2;
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
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

  if (b.type === 'star') { drawStar(game, b); return; }

  if (b.ring) drawRing(game, b, false);   // FAR half — the near half goes on
                                          // after the disc, see below

  // Lava worlds glow — visible even when zoomed way out
  if (b.ptype === 'lava') {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.5, b.x, b.y, b.radius * 2.2);
    g.addColorStop(0, 'rgba(255, 110, 40, 0.4)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 2.2, 0, TAU); ctx.fill();
  }

  // Terran worlds wear a VISIBLE atmosphere — the BURN DECK the sim charges
  // for (CFG.ATMO_IN..ATMO_ZONE), drawn as a band peaking mid-deck with clear
  // air legible beneath it. The gradient reaches a little past both mechanic
  // edges (fading from the 1.0r surface under the 1.14 floor, and out to
  // 1.58r over the 1.5 ceiling), so anywhere that looks clear IS clear — the
  // dust-halo rule for hazards.
  // Calm, steady, no motion: real object state (the burn itself shows on
  // whatever is burning — reentry streaks, the hull heat glow).
  if (b.ptype === 'terran') {
    const g = ctx.createRadialGradient(b.x, b.y, b.radius, b.x, b.y, b.radius * 1.58);
    g.addColorStop(0, 'rgba(120, 190, 255, 0)');
    g.addColorStop(0.17, 'rgba(140, 200, 255, 0.08)');
    g.addColorStop(0.52, 'rgba(165, 215, 255, 0.30)');
    g.addColorStop(0.83, 'rgba(120, 190, 255, 0.10)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.58, 0, TAU); ctx.fill();
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
      if (game.storm && game.storm.k > 0.35
          && Math.abs(dSun - game.storm.r) < game.storm.band * 1.4) boost = 1.7;
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
  // (5.0 vs CFG.DUST_HALO 4.15 — same ~1.2 overreach the original 2.9-vs-2.4
  // pair had) so the gradient IS the boundary read: no ring stroke at the
  // exact mechanic radius, no hard edges in-world.
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
    const R = b.radius * 5.0;
    const g = ctx.createRadialGradient(b.x, b.y, b.radius * 0.8, b.x, b.y, R);
    g.addColorStop(0, 'rgba(116, 109, 101, 0.16)');
    g.addColorStop(0.6, 'rgba(116, 109, 101, 0.10)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
    // Many FINE grains over the tripled area — dust, not gravel: the specks
    // ran radius*0.05 (5+ world units on a big moon) and read as orbiting
    // ROCKS (2026-08 user call). A third the size, 2.5x the count, two size
    // classes so the field has texture without any one grain reading as a body.
    ctx.fillStyle = 'rgba(150, 140, 128, 0.35)';
    for (let i = 0; i < 30; i++) {
      const a = b.id * 1.7 + i * 2.399 + game.time * (0.05 + (i % 3) * 0.02);
      const rr = b.radius * (1.2 + (((b.id + i * 13) % 20) / 20) * 3.3);
      const sz = Math.max(0.5, b.radius * (i % 2 ? 0.012 : 0.018));
      ctx.beginPath();
      ctx.arc(b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr, sz, 0, TAU);
      ctx.fill();
    }
  }

  // GOING UNDER (CFG.GAS_SINK): a rock swallowed by a gas giant fades out over
  // its sink window instead of blinking off the screen — the clouds close over
  // it. Restored at the end of the sprite block below.
  const sinking = b.sinkT > 0;
  if (sinking) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, b.sinkT / CFG.GAS_SINK)) ** 0.7;
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
    // Instanced when it can be (small, unwounded-at-this-zoom, GL live); the
    // full vector sprite otherwise. blitChunk returns false for cored pieces,
    // so the glint below still lands on a sprite that was actually drawn here.

    if (!blitChunk(game, b)) drawChunkSprite(b);
    // Cored chunks carry the reward, so they must carry the tell. config
    // worldDebris stamps `cored` on a crystal world's rubble (~22% of it) and
    // entities' chunk material application sets b.cored from it, so both a
    // seeded belt piece and the crust a wounded world calves can be cored —
    // and physics still pays out the core crystal on a player smash. This
    // branch is taken BEFORE the asteroid one below, so those pieces were the
    // only cored rocks in the game with no purple glint on them.
    if (b.cored) drawCoreGlint(game, b);   // the vein TWINKLES — never bakeable
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
  } else {
    // traceSurface: the crystal facet silhouette, a wounded world's notched
    // limb, or a plain disc. Craters are cut OUT of this path, so the wound is
    // a real absence of planet rather than something drawn over one.
    traceSurface(b);
    ctx.fill();
  }
  if (sinking) { ctx.restore(); return; }   // nothing else applies to a rock going under

  if (b.type === 'planet' && b.ptype) drawPlanetDetail(game, b);
  if (b.type === 'planet' && b.ptype === 'ocean' && b.seaHits) drawSeaRipples(game, b);
  if (b.molten > 0) drawMoltenCrust(game, b);
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
    // Clipped to the real silhouette so the night side shades a crystal
    // world's spikes too (an unshaded spike tip reads as a stray mark) and
    // never spills across an open crater.
    traceSurface(b);
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

  // OCEAN SPECULAR: the world-sea catches the sun as a soft sheen pooling on
  // the sunward limb — water answering light, the same slot in the pass the
  // crystal limb uses. Solid gradient, additive, clipped to the silhouette;
  // steady state, no motion (motion is for events).
  if (b.type === 'planet' && b.ptype === 'ocean' && st) {
    const sunA = Math.atan2(st.y - b.y, st.x - b.x);
    ctx.save();
    traceSurface(b);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const lx = b.x + Math.cos(sunA) * b.radius * 0.82;
    const ly = b.y + Math.sin(sunA) * b.radius * 0.82;
    const sg = ctx.createRadialGradient(lx, ly, 0, lx, ly, b.radius * 0.9);
    sg.addColorStop(0, 'rgba(210, 240, 255, 0.3)');
    sg.addColorStop(0.4, 'rgba(140, 200, 255, 0.12)');
    sg.addColorStop(1, 'transparent');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(lx, ly, b.radius * 0.9, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // MOONSHADOW eclipse: the world dims under its moon's shadow, with a warm
  // rim so it reads as an eclipse rather than damage
  // THE CRUMBLE: through traceSurface, never a full-radius arc. A raw arc at
  // b.radius strokes straight across the open mouth of any crater the crumble
  // carved — redrawing the nominal limb the wound exists to remove as a bright
  // rim over empty space, and filling the shade over the wound instead of
  // ending at it. It also bypassed traceCrystal, so a crystal world's eclipse
  // was a disc laid over a facet silhouette.
  if (b.eclipseT > 0) {
    const k = Math.min(1, b.eclipseT / 0.5);
    ctx.fillStyle = `rgba(2, 4, 14, ${0.42 * k})`;
    traceSurface(b); ctx.fill();
    ctx.strokeStyle = `rgba(255, 225, 170, ${0.3 * k})`;
    ctx.lineWidth = Math.max(1.2, 2 / game.cam.zoom);
    traceSurface(b); ctx.stroke();
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

  // Progressive damage. A GAS GIANT HAS NO CRUST TO CRACK: it took the same
  // fissure web every solid world uses, which drew stone fracture lines across
  // a ball of hydrogen. Its wound is weather instead — cyclones churning up out
  // of the bands (CFG.GAS_*).
  if (b.maxHp !== Infinity && (b.hp < b.maxHp || (b.scars && b.scars.length))) {
    if (b.ptype === 'gas') drawGasWound(game, b);
    else drawBodyDamage(game, b);
  }

  // NEAR half of the ring — the arc that passes in FRONT of the world, so it
  // goes over the surface, the terminator, the eclipse and the damage, and
  // only the helper-UI rings below outrank it.
  if (b.ring) drawRing(game, b, true);

  // Orbiting highlights.
  //
  // NOTHING IS DRAWN FOR heldBy === 'player' (user design call). There used to
  // be a dashed cyan ring here saying "this one is in your beam" — from a time
  // when the beam was a single thin line and needed the help. It does not any
  // more: the beam now braids, blooms where it grips the rim, and runs
  // near-white at full power, all of which say the same thing louder. The ring
  // was a second, older answer to a question already answered, and it crowded
  // the only spot on screen the player is actually looking at while aiming.
  if (b.heldBy === 'orbit') {
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

// ——— The planet face ————————————————————————————————————————————————————
//
// A lobed organic patch: two low radial harmonics over an ellipse, sampled
// once at build time. A bare ellipse reads as the primitive it is at any size
// (the rock law's lesson, applied to paint) — a couple of harmonics is enough
// to read as a landform, a cloud mass or a lava plate instead.
function mkBlob(rng, wob) {
  const n = 16, pts = new Float32Array(n);
  const p1 = 2 + ((rng() * 2) | 0), p2 = 4 + ((rng() * 3) | 0);
  const f1 = rng() * TAU, f2 = rng() * TAU;
  const a1 = wob * (0.45 + rng() * 0.35), a2 = wob * (0.15 + rng() * 0.2);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    pts[i] = Math.max(0.25, 1 + a1 * Math.sin(p1 * t + f1) + a2 * Math.sin(p2 * t + f2));
  }
  return pts;
}
// Trace a blob as a smooth closed path (quadratics through sample midpoints —
// 16 straight segments read as a polygon on a disc most of the screen wide).
// Module scratch, no per-frame allocation.
const _blx = new Float32Array(16), _bly = new Float32Array(16);
function blobPath(cx, cy, rx, ry, rot, pts) {
  const n = pts.length, cs = Math.cos(rot), sn = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU, k = pts[i];
    const ex = Math.cos(t) * rx * k, ey = Math.sin(t) * ry * k;
    _blx[i] = cx + ex * cs - ey * sn;
    _bly[i] = cy + ex * sn + ey * cs;
  }
  ctx.beginPath();
  ctx.moveTo((_blx[n - 1] + _blx[0]) / 2, (_bly[n - 1] + _bly[0]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ctx.quadraticCurveTo(_blx[i], _bly[i], (_blx[i] + _blx[j]) / 2, (_bly[i] + _bly[j]) / 2);
  }
  ctx.closePath();
}
// One wavy-edged latitude band, traced in the tilted band frame. Both edges
// carry their own low-frequency shear wave so the stripes read as weather
// rather than as ruled fills — the hard fillRect edges were invisible at 250
// units and unmissable at 1500. Geometry in fractions of R.
function bandTrace(bd, R) {
  const S = 18;
  ctx.beginPath();
  for (let i = 0; i <= S; i++) {
    const x = -1.04 + (2.08 * i) / S;
    const y = bd.y0 + Math.sin(x * bd.e0.f + bd.e0.p) * bd.e0.a;
    if (i === 0) ctx.moveTo(x * R, y * R); else ctx.lineTo(x * R, y * R);
  }
  for (let i = S; i >= 0; i--) {
    const x = -1.04 + (2.08 * i) / S;
    ctx.lineTo(x * R, (bd.y1 + Math.sin(x * bd.e1.f + bd.e1.p) * bd.e1.a) * R);
  }
  ctx.closePath();
}

// The face geometry, built ONCE per body (seeded off b.id — no Math.random,
// stable frame to frame) and drawn every frame as FRACTIONS of the live
// radius, so a world chipped smaller keeps its face and simply wears it
// smaller. The key catches the one legal ptype change — a stripped gas giant
// BECOMES its core in place — and rebuilds the face for the rock it now is.
// Feature COUNTS scale with the built radius (den): at PLANET_R_MUL 3 a world
// is most of the screen, and the four ellipses that dressed a 250-unit disc
// read as empty at 1500. Feature SIZES stay fractions — a continent is a
// fraction of its world; it is DAMAGE detail that clamps to DETAIL_R
// (drawBodyDamage), never the face.
function planetDetail(b) {
  // NOTE: completeGasStrip clears gasKind but leaves b.landmark, so a stripped
  // storm-landmark giant carries a stale 'storm' tag into its rocky rebuild.
  // Harmless today — the rocky branch only reads 'crater' — but if a landmark
  // ever grows a cross-archetype draw, gate it on ptype too.
  const key = b.ptype + '|' + (b.gasKind || '') + '|' + (b.landmark || '');
  if (b._pd && b._pd.key === key) return b._pd;
  const rng = mulberry32((b.id * 7349 + 401) >>> 0);
  const den = clamp(b.radius / DETAIL_R, 1, 5);
  const c = { key, den };
  const wave = (amp) => ({ a: amp * (0.6 + rng() * 0.8), f: 2 + rng() * 3.5, p: rng() * TAU });
  const scatter = (spread) => {
    const a = rng() * TAU, r = Math.sqrt(rng()) * spread;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  };
  if (b.ptype === 'gas') {
    const kind = c.kind = b.gasKind || 'amber';
    c.tilt = b.id % 2 ? 0.32 : -0.26;
    // A GIANT'S DETAIL SHRINKS AS THE WORLD GROWS (user call: "because they
    // are so incredibly big, the details need to be smaller"). fs divides
    // band heights, eddy sizes and wave amplitudes, so a 2,000-unit giant
    // wears many fine stripes and small storms instead of the same six bands
    // a 300-unit world wears — the landmark Great Eye alone stays big (it is
    // steered by). Counts already grow with den; fs is the size half.
    const fs = c.fs = Math.sqrt(c.den);
    const bands = c.bands = [], eddies = c.eddies = [];
    if (kind === 'azure') {
      // Ice giant: few wide soft bands under a bright polar hood — the calm,
      // near-featureless methane haze KEEPS its wide bands (calm is its
      // identity); only the cirrus and the storm fleck scale down.
      const n = 3 + (b.id % 2), h = 2 / n;
      for (let i = 0; i < n; i++) {
        bands.push({ y0: -1 + i * h, y1: -1 + i * h + h * 0.9, e0: wave(0.015), e1: wave(0.015),
          col: i % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(0,10,40,0.13)' });
      }
      c.streaks = [];
      for (let i = 0; i < Math.round(2 + 2 * fs); i++) {
        c.streaks.push({ x: -0.55 + rng() * 0.7, y: -0.6 + rng() * 1.2, l: (0.45 + rng() * 0.5) / fs,
          w: (0.014 + rng() * 0.016) / fs, bow: (rng() - 0.5) * 0.16 / fs });
      }
      for (let i = 0; i < 1 + (b.id % 2); i++) {
        eddies.push({ x: -0.45 + rng() * 0.9, y: -0.55 + rng() * 1.1, rx: (0.09 + rng() * 0.09) / fs,
          t: (rng() - 0.5) * 0.5, dark: true });
      }
    } else if (kind === 'violet') {
      // Exotic giant: irregular thin/thick stacking with harder shear, curl
      // hooks and eddy flecks — turbulent, alien
      let y = -1, i = 0;
      while (y < 1) {
        const h = (0.13 + rng() * 0.2) / fs;
        bands.push({ y0: y, y1: y + h * 0.82, e0: wave(0.045 / fs), e1: wave(0.055 / fs),
          col: i % 2 ? 'rgba(255,255,255,0.14)' : 'rgba(25,0,45,0.2)' });
        y += h; i++;
      }
      c.swirls = [];
      for (let j = 0; j < Math.round(2 + c.den); j++) {
        c.swirls.push({ x: -0.6 + rng() * 1.2, y: -0.65 + rng() * 1.3, r: (0.05 + rng() * 0.08) / fs,
          dir: rng() < 0.5 ? 1 : -1, ph: rng() * TAU });
      }
      for (let j = 0; j < Math.round(2.2 * c.den); j++) {
        eddies.push({ x: -0.75 + rng() * 1.5, y: -0.8 + rng() * 1.6, rx: (0.045 + rng() * 0.06) / fs,
          t: (rng() - 0.5) * 0.7, dark: rng() < 0.5 });
      }
    } else {
      // Amber giant: the busy classic — many sheared stripes in warm tones, a
      // rust lane every few rows, eddy trains riding the shear boundaries
      const n = Math.round((6 + (b.id % 3)) * fs), h = 2 / n;
      for (let i = 0; i < n; i++) {
        bands.push({ y0: -1 + i * h, y1: -1 + i * h + h * 0.8, e0: wave(0.025 / fs), e1: wave(0.03 / fs),
          col: i % 4 === 2 ? 'rgba(170,75,30,0.15)' : i % 2 ? 'rgba(255,242,208,0.13)' : 'rgba(64,30,10,0.17)' });
      }
      for (let j = 0; j < Math.round(2.6 * c.den); j++) {
        const bd = bands[(rng() * bands.length) | 0];
        eddies.push({ x: -0.8 + rng() * 1.6, y: bd.y1 + (rng() - 0.5) * 0.06, rx: (0.04 + rng() * 0.06) / fs,
          t: (rng() - 0.5) * 0.35, dark: rng() < 0.45 });
      }
    }
  } else if (b.ptype === 'lava') {
    // Cooled crust plates floating on the glow: the base colour IS the magma,
    // so the plates are cut dark and every gap between them reads lit.
    c.plates = [];
    const np = Math.round(5 + 4 * Math.sqrt(c.den));
    for (let i = 0; i < np; i++) {
      const p = scatter(0.8);
      c.plates.push({ x: p.x, y: p.y, rx: 0.15 + rng() * 0.2, k: 0.55 + rng() * 0.35,
        rot: rng() * TAU, pts: mkBlob(rng, 0.32), a: 0.3 + rng() * 0.18 });
    }
    c.rivers = [];
    const nr = Math.round(4 + 2.5 * c.den);
    for (let i = 0; i < nr; i++) {
      c.rivers.push({ a: rng() * TAU, r0: 0.1 + rng() * 0.3, drift: 0.5 + rng() * 0.7,
        reach: 0.75 + rng() * 0.22, w: 0.016 + rng() * 0.02 });
    }
    c.pools = [];
    for (let i = 0; i < 3 + (b.id % 3); i++) {
      const p = scatter(0.75);
      c.pools.push({ x: p.x, y: p.y, r: 0.06 + rng() * 0.09 });
    }
  } else if (b.ptype === 'ice') {
    c.plains = [];
    for (let i = 0; i < 4 + Math.round(c.den * 0.8); i++) {
      const p = scatter(0.7);
      c.plains.push({ x: p.x, y: p.y, rx: 0.16 + rng() * 0.16, k: 0.6 + rng() * 0.3,
        rot: rng() * TAU, pts: mkBlob(rng, 0.35) });
    }
    // Linea: long fracture lanes crossing the whole face — rust where brine
    // froze into the crack, blue-white where a ridge caught the light
    c.linea = [];
    for (let i = 0; i < Math.round(5 + 2.5 * c.den); i++) {
      const a0 = rng() * TAU;
      c.linea.push({ a0, a1: a0 + 1.2 + rng() * 2.6, bow: (rng() - 0.5) * 0.55,
        w: 0.007 + rng() * 0.011, rust: rng() < 0.45 });
    }
    c.cap = mkBlob(rng, 0.14);
    c.cap2 = mkBlob(rng, 0.14);
  } else if (b.ptype === 'terran') {
    c.conts = [];
    for (let i = 0; i < 3 + Math.round(c.den * 0.6); i++) {
      const p = scatter(0.6);
      c.conts.push({ x: p.x, y: p.y, rx: 0.18 + rng() * 0.16, k: 0.6 + rng() * 0.3,
        rot: rng() * TAU, pts: mkBlob(rng, 0.5),
        hx: (rng() - 0.5) * 0.5, hy: (rng() - 0.5) * 0.5, sandy: rng() < 0.35 });
    }
    c.isles = [];
    for (let i = 0; i < 2 + (b.id % 3); i++) {
      const p = scatter(0.75);
      c.isles.push({ x: p.x, y: p.y, ang: rng() * TAU, n: 3 + ((rng() * 3) | 0),
        step: 0.05 + rng() * 0.03, r: 0.016 + rng() * 0.02 });
    }
    c.clouds = [];
    for (let i = 0; i < Math.round(5 + 1.6 * c.den); i++) {
      const p = scatter(0.8);
      c.clouds.push({ x: p.x, y: p.y, rx: 0.14 + rng() * 0.2, k: 0.25 + rng() * 0.25,
        rot: rng() * TAU, pts: mkBlob(rng, 0.55) });
    }
    const cy = scatter(0.55);
    c.cyc = { x: cy.x, y: cy.y, r: 0.14 + rng() * 0.08, dir: rng() < 0.5 ? 1 : -1 };
    c.cap = mkBlob(rng, 0.18);
    c.cap2 = mkBlob(rng, 0.18);
  } else if (b.ptype === 'ocean') {
    c.deeps = [];
    for (let i = 0; i < 3 + (b.id % 2); i++) {
      const p = scatter(0.65);
      c.deeps.push({ x: p.x, y: p.y, rx: 0.22 + rng() * 0.2, k: 0.55 + rng() * 0.35,
        rot: rng() * TAU, pts: mkBlob(rng, 0.4) });
    }
    c.cur = [];
    const ncu = Math.round(5 + 1.8 * c.den);
    for (let i = 0; i < ncu; i++) {
      c.cur.push({ y: -0.8 + (i + 0.5) * (1.6 / ncu) + (rng() - 0.5) * 0.08, e: wave(0.1),
        w: 0.012 + rng() * 0.02, deep: rng() < 0.4 });
    }
    c.gyres = [];
    for (let i = 0; i < 1 + (b.id % 2); i++) {
      const p = scatter(0.55);
      c.gyres.push({ x: p.x, y: p.y, r: 0.12 + rng() * 0.1, dir: rng() < 0.5 ? 1 : -1,
        turns: 1.6 + rng() * 0.9, ph: rng() * TAU });
    }
    c.arcs = [];
    for (let i = 0; i < 2 + (b.id % 2); i++) {
      const p = scatter(0.7);
      c.arcs.push({ x: p.x, y: p.y, ang: rng() * TAU, n: 4 + ((rng() * 4) | 0),
        step: 0.05 + rng() * 0.025, r: 0.014 + rng() * 0.016, bend: (rng() - 0.5) * 0.5 });
    }
  } else if (b.ptype === 'desert') {
    c.ergs = [];
    for (let i = 0; i < 3; i++) {
      const p = scatter(0.7);
      c.ergs.push({ x: p.x, y: p.y, rx: 0.26 + rng() * 0.2, k: 0.6 + rng() * 0.3,
        rot: rng() * TAU, pts: mkBlob(rng, 0.4), light: i % 2 === 0 });
    }
    c.dunes = [];
    for (let i = 0; i < Math.round(4 + 1.6 * c.den); i++) {
      const p = scatter(0.72);
      c.dunes.push({ x: p.x, y: p.y, ang: rng() * TAU, n: 4 + ((rng() * 3) | 0),
        len: 0.18 + rng() * 0.16, gap: 0.032 + rng() * 0.02, bow: 0.03 + rng() * 0.04 });
    }
    // A canyon: one meandering seeded walk — the desert's long scar
    c.canyon = [];
    let cx2 = -0.7 + rng() * 0.3, cy2 = (rng() - 0.5) * 0.8, ca2 = (rng() - 0.5) * 0.8;
    for (let i = 0; i < 7; i++) {
      c.canyon.push({ x: cx2, y: cy2 });
      ca2 += (rng() - 0.5) * 0.9; cx2 += Math.cos(ca2) * 0.18; cy2 += Math.sin(ca2) * 0.18;
    }
    c.mesas = [];
    for (let i = 0; i < 3; i++) {
      const p = scatter(0.68);
      c.mesas.push({ x: p.x, y: p.y, rx: 0.1 + rng() * 0.08, k: 0.5 + rng() * 0.3,
        rot: rng() * TAU, pts: mkBlob(rng, 0.3) });
    }
    c.storms = [];
    for (let i = 0; i < 1 + (b.id % 2); i++) {
      const p = scatter(0.5);
      c.storms.push({ x: p.x, y: p.y, rx: 0.24 + rng() * 0.14, rot: rng() * TAU });
    }
  } else if (b.ptype === 'shroud') {
    c.decks = [];
    const nd = 6 + (b.id % 2);
    for (let i = 0; i < nd; i++) {
      c.decks.push({ rate: 0.45 + i * 0.24 + rng() * 0.12, ph: rng() * TAU,
        r: 0.2 + (i / nd) * 0.68 + rng() * 0.05, w: 0.1 + rng() * 0.1, span: 3.2 + rng() * 1.8,
        tone: i % 3 === 2 ? 'rgba(255,232,160,0.14)' : i % 2 ? 'rgba(255,250,220,0.2)' : 'rgba(120,100,40,0.18)' });
    }
    c.chevY = -0.18 - rng() * 0.15;
  } else if (b.ptype === 'crystal') {
    // The lattice itself derives LIVE from b.cjag (the same table the
    // silhouette is traced from); only the seeded dressing is cached here
    c.rings = [0.38 + rng() * 0.06, 0.62 + rng() * 0.06, 0.83 + rng() * 0.05];
    c.glints = [];
    for (let i = 0; i < 5 + Math.round(c.den); i++) {
      c.glints.push({ a: rng() * TAU, r: 0.25 + rng() * 0.55, s: 0.02 + rng() * 0.025 });
    }
  } else {  // rocky
    c.maria = [];
    for (let i = 0; i < 4 + Math.round(c.den * 0.8); i++) {
      const p = scatter(0.68);
      c.maria.push({ x: p.x, y: p.y, rx: 0.16 + rng() * 0.18, k: 0.55 + rng() * 0.35,
        rot: rng() * TAU, pts: mkBlob(rng, 0.45), light: rng() < 0.3 });
    }
    c.craters = [];
    for (let i = 0; i < Math.round(4 * c.den); i++) {
      const p = scatter(0.85);
      c.craters.push({ x: p.x, y: p.y, r: 0.025 + rng() * 0.05 });
    }
    c.ridges = [];
    for (let i = 0; i < 2 + (b.id % 2); i++) {
      const p = scatter(0.6);
      const n = 5 + ((rng() * 3) | 0), off = new Float32Array(n);
      // irregular per-vertex offsets — a strict zigzag reads as a drawn glyph
      for (let j = 0; j < n; j++) off[j] = (rng() - 0.5) * 0.07;
      c.ridges.push({ x: p.x, y: p.y, ang: rng() * TAU, n, off,
        step: 0.06 + rng() * 0.03 });
    }
  }
  b._pd = c;
  return c;
}

// Per-archetype surface detail, drawn clipped to the planet disc. This is
// what makes the planet TYPES readable: bands = gas (three gasKind looks),
// plates+glow = lava, caps+linea = ice, maria+craters = rocky, seas+clouds =
// terran, currents+gyres = ocean, dunes+canyon = desert, sheared decks =
// shroud, facet lattice = crystal.
// All geometry is seeded off b.id (stable frame to frame — no Math.random),
// and every ambient drift rides multiples of b.rot, never wall-clock time.
// Built in two registers: the big features that carry the zoomed-out read
// (bands, caps, continents, plates), and a mid-frequency layer (eddies,
// linea, ripples, craters) gated behind `fine` — at a dozen screen pixels the
// big reads are the whole story and the small ones are subpixel noise.
function drawPlanetDetail(game, b) {
  const c = planetDetail(b);
  const R = b.radius;
  const fine = R * game.cam.zoom > 24;
  ctx.save();
  // Clipped to the real silhouette: facet detail fills a crystal world's
  // spikes, and surface detail stops dead at the edge of a crater.
  traceSurface(b);
  ctx.clip();
  ctx.translate(b.x, b.y);
  // The surface turns under the fixed star-lit terminator (drawn after this in
  // drawBody) — that rotation IS the day/night cycle. Ice and terran caps are
  // polar, so those frames stay put (they rotate their surface internally);
  // everything else rides b.rot.
  if (b.ptype !== 'ice' && b.ptype !== 'terran') ctx.rotate(b.rot);

  if (b.ptype === 'gas') {
    ctx.rotate(c.tilt);
    const kind = c.kind;
    for (const bd of c.bands) { bandTrace(bd, R); ctx.fillStyle = bd.col; ctx.fill(); }
    if (kind === 'azure') {
      // the bright polar hood over the haze
      ctx.fillStyle = 'rgba(220, 245, 255, 0.22)';
      ctx.beginPath(); ctx.ellipse(0, -R * 0.8, R * 0.8, R * 0.3, 0, 0, TAU); ctx.fill();
      if (fine) {
        // thin cirrus streaks riding the upper deck
        ctx.strokeStyle = 'rgba(235, 250, 255, 0.2)';
        ctx.lineCap = 'round';
        for (const s of c.streaks) {
          ctx.lineWidth = Math.max(1, s.w * R);
          ctx.beginPath();
          ctx.moveTo(s.x * R, s.y * R);
          ctx.quadraticCurveTo((s.x + s.l * 0.5) * R, (s.y + s.bow) * R, (s.x + s.l) * R, s.y * R);
          ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
    }
    if (fine) {
      // Eddy trains: elongated oval storms with a bright sheared rim on the
      // upwind side. The dark tone follows the giant's own palette — a violet
      // smudge on a warm amber world reads as a bruise, not weather.
      const darkTone = kind === 'amber' ? 'rgba(70, 32, 10, 0.26)'
        : kind === 'azure' ? 'rgba(8, 18, 45, 0.3)' : 'rgba(30, 12, 45, 0.24)';
      for (const e of c.eddies) {
        ctx.fillStyle = e.dark ? darkTone : 'rgba(255, 248, 225, 0.2)';
        ctx.beginPath();
        ctx.ellipse(e.x * R, e.y * R, e.rx * R, e.rx * 0.45 * R, e.t, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 250, 230, 0.16)';
        ctx.lineWidth = Math.max(1, e.rx * R * 0.16);
        ctx.beginPath();
        ctx.ellipse(e.x * R, e.y * R, e.rx * R * 1.15, e.rx * 0.5 * R, e.t, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    }
    if (c.swirls && fine) {
      // Curl hooks: tight one-armed spirals where the violet bands roll up
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineCap = 'round';
      for (const s of c.swirls) {
        ctx.lineWidth = Math.max(1, s.r * R * 0.22);
        ctx.beginPath();
        for (let i = 0; i <= 14; i++) {
          const t = i / 14, a = s.ph + s.dir * t * 4.6, rr = s.r * R * (1 - 0.8 * t);
          const px = s.x * R + Math.cos(a) * rr, py = s.y * R + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    if (b.landmark === 'storm') {
      // THE GREAT EYE — the system's landmark storm, big enough to steer by
      ctx.fillStyle = 'rgba(200, 60, 40, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-R * 0.28, R * 0.2, R * 0.44, R * 0.21, 0.25, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 235, 215, 0.45)';
      ctx.lineWidth = Math.max(1.5, R * 0.025);
      ctx.beginPath();
      ctx.ellipse(-R * 0.28, R * 0.2, R * 0.5, R * 0.26, 0.25, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 190, 160, 0.5)';
      ctx.beginPath();
      ctx.ellipse(-R * 0.24, R * 0.18, R * 0.17, R * 0.08, 0.25, 0, TAU);
      ctx.fill();
    } else {
      // A great storm spot — dark on the hazy azure giant, bright elsewhere
      // (scaled down with the rest of the detail; only the landmark Eye is big)
      ctx.fillStyle = kind === 'azure' ? 'rgba(10, 25, 60, 0.4)' : 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.ellipse(R * 0.34, R * 0.3, R * 0.2 / c.fs, R * 0.1 / c.fs, 0.3, 0, TAU);
      ctx.fill();
    }
  } else if (b.ptype === 'lava') {
    // Cooled crust plates over the magma-coloured base — the glow BETWEEN the
    // plates is the body colour itself, so every gap reads as a lit channel
    for (const p of c.plates) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fillStyle = `rgba(26, 10, 6, ${p.a})`;
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    if (fine) {
      // thin magma seams tracing every plate edge
      ctx.strokeStyle = 'rgba(255, 140, 50, 0.22)';
      ctx.lineWidth = Math.max(1, R * 0.008);
      for (const p of c.plates) {
        blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
        ctx.stroke();
      }
    }
    // magma rivers arcing out toward the rim — the old signature, more of them
    ctx.strokeStyle = 'rgba(255, 165, 60, 0.72)';
    ctx.lineCap = 'round';
    for (const rv of c.rivers) {
      ctx.lineWidth = Math.max(1.5, rv.w * R);
      ctx.beginPath();
      ctx.moveTo(Math.cos(rv.a) * R * rv.r0, Math.sin(rv.a) * R * rv.r0);
      ctx.quadraticCurveTo(
        Math.cos(rv.a + rv.drift) * R * (rv.r0 + rv.reach) * 0.55,
        Math.sin(rv.a + rv.drift) * R * (rv.r0 + rv.reach) * 0.55,
        Math.cos(rv.a + rv.drift * 0.6) * R * rv.reach,
        Math.sin(rv.a + rv.drift * 0.6) * R * rv.reach);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    if (fine) {
      // caldera pools — steady glow, no boil (the world's own face is ambient
      // state; heat that MOVES is the molten-core cooldown's job)
      for (const p of c.pools) {
        const g = ctx.createRadialGradient(p.x * R, p.y * R, 0, p.x * R, p.y * R, p.r * R);
        g.addColorStop(0, 'rgba(255, 196, 108, 0.5)');
        g.addColorStop(0.55, 'rgba(255, 110, 40, 0.25)');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x * R, p.y * R, p.r * R, 0, TAU); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  } else if (b.ptype === 'ice') {
    // Scattered blue-white plains ride the spin (so the world visibly turns)…
    ctx.save();
    ctx.rotate(b.rot);
    ctx.fillStyle = 'rgba(190, 220, 242, 0.32)';
    for (const p of c.plains) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fill();
    }
    // …crossed by LINEA — long fracture lanes spanning the whole face, rust
    // where brine froze into the crack, blue-white where a ridge caught light
    // (the Europa read: what says "ice sheet" instead of "pale rock")
    if (fine) {
      ctx.lineCap = 'round';
      for (const l of c.linea) {
        const x0 = Math.cos(l.a0) * 0.96, y0 = Math.sin(l.a0) * 0.96;
        const x1 = Math.cos(l.a1) * 0.96, y1 = Math.sin(l.a1) * 0.96;
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        ctx.strokeStyle = l.rust ? 'rgba(196, 122, 104, 0.34)' : 'rgba(160, 200, 235, 0.42)';
        ctx.lineWidth = Math.max(1, l.w * R);
        ctx.beginPath();
        ctx.moveTo(x0 * R, y0 * R);
        ctx.quadraticCurveTo((mx - (y1 - y0) * l.bow) * R, (my + (x1 - x0) * l.bow) * R, x1 * R, y1 * R);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    ctx.restore();
    // …but the polar caps stay pinned to the poles (spin axis is vertical),
    // their edges ragged where the sheet breaks up
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    blobPath(0, -R * 0.84, R * 0.76, R * 0.3, 0, c.cap); ctx.fill();
    blobPath(0, R * 0.84, R * 0.76, R * 0.3, 0, c.cap2); ctx.fill();
  } else if (b.ptype === 'terran') {
    // Living world: lobed continents ride the spin, each rising off its own
    // shallow shelf so the coast reads as water getting deep…
    ctx.save();
    ctx.rotate(b.rot);
    for (const p of c.conts) {
      blobPath(p.x * R, p.y * R, p.rx * 1.3 * R, p.rx * p.k * 1.3 * R, p.rot, p.pts);
      ctx.fillStyle = 'rgba(24, 58, 118, 0.45)';
      ctx.fill();
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fillStyle = 'rgba(140, 195, 110, 0.62)';
      ctx.fill();
      if (fine) {
        // interior relief: a highland (or a dust-dry heart) per continent
        ctx.fillStyle = p.sandy ? 'rgba(206, 182, 116, 0.4)' : 'rgba(84, 130, 62, 0.45)';
        ctx.beginPath();
        ctx.ellipse((p.x + p.hx * p.rx) * R, (p.y + p.hy * p.rx * p.k) * R,
          p.rx * R * 0.42, p.rx * p.k * R * 0.3, p.rot, 0, TAU);
        ctx.fill();
      }
    }
    if (fine) {
      // island chains trailing off into the sea
      ctx.fillStyle = 'rgba(140, 195, 110, 0.55)';
      for (const ch of c.isles) {
        for (let i = 0; i < ch.n; i++) {
          const px = (ch.x + Math.cos(ch.ang) * ch.step * i) * R;
          const py = (ch.y + Math.sin(ch.ang) * ch.step * i) * R;
          ctx.beginPath();
          ctx.arc(px, py, ch.r * R * (1 - (i / (ch.n + 1)) * 0.5), 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.restore();
    // …under cloud masses that drift a touch FASTER than the surface (weather
    // shears past the ground — the multiple of b.rot is the drift, no clock)
    ctx.save();
    ctx.rotate(b.rot * 1.18);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (const p of c.clouds) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fill();
    }
    if (fine) {
      // one cyclone — a swirl with a clear eye, the weather's landmark
      ctx.strokeStyle = 'rgba(255,255,255,0.34)';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.2, c.cyc.r * R * 0.2);
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const t = i / 16, a = c.cyc.dir * t * 5.2, rr = c.cyc.r * R * (0.25 + 0.75 * t);
        const px = c.cyc.x * R + Math.cos(a) * rr, py = c.cyc.y * R + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
    ctx.restore();
    // …with small ragged polar caps pinned to the poles, like the ice worlds'
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    blobPath(0, -R * 0.87, R * 0.5, R * 0.18, 0, c.cap); ctx.fill();
    blobPath(0, R * 0.87, R * 0.5, R * 0.18, 0, c.cap2); ctx.fill();
  } else if (b.ptype === 'ocean') {
    // World-sea: deep basins shade the water first…
    ctx.fillStyle = 'rgba(8, 24, 66, 0.3)';
    for (const p of c.deeps) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fill();
    }
    // …bright current systems sweep the globe…
    ctx.lineCap = 'round';
    for (const cu of c.cur) {
      ctx.strokeStyle = cu.deep ? 'rgba(96, 156, 220, 0.34)' : 'rgba(180, 222, 255, 0.33)';
      ctx.lineWidth = Math.max(1.2, cu.w * R);
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const x = -1.02 + (2.04 * i) / 16;
        const y = cu.y + Math.sin(x * cu.e.f + cu.e.p) * cu.e.a;
        if (i === 0) ctx.moveTo(x * R, y * R); else ctx.lineTo(x * R, y * R);
      }
      ctx.stroke();
    }
    // …spinning up into gyres where they meet…
    if (fine) {
      ctx.strokeStyle = 'rgba(190, 228, 255, 0.3)';
      for (const gy of c.gyres) {
        ctx.lineWidth = Math.max(1.2, gy.r * R * 0.14);
        ctx.beginPath();
        for (let i = 0; i <= 16; i++) {
          const t = i / 16, a = gy.ph + gy.dir * t * gy.turns * TAU * 0.8;
          const rr = gy.r * R * (1 - 0.75 * t);
          const px = gy.x * R + Math.cos(a) * rr, py = gy.y * R + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    // …around low archipelago chains — land is the exception here
    if (fine) {
      ctx.fillStyle = 'rgba(122, 160, 108, 0.6)';
      for (const ch of c.arcs) {
        for (let i = 0; i < ch.n; i++) {
          const a2 = ch.ang + (i / Math.max(1, ch.n - 1) - 0.5) * ch.bend * 2;
          const px = (ch.x + Math.cos(a2) * ch.step * i) * R;
          const py = (ch.y + Math.sin(a2) * ch.step * i) * R;
          ctx.beginPath(); ctx.arc(px, py, ch.r * R, 0, TAU); ctx.fill();
        }
      }
    }
  } else if (b.ptype === 'desert') {
    // Dune seas in broad tonal sweeps…
    for (const p of c.ergs) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fillStyle = p.light ? 'rgba(255, 235, 190, 0.12)' : 'rgba(80, 45, 20, 0.1)';
      ctx.fill();
    }
    // …combed with ripple trains, each dune field blown its own way…
    if (fine) {
      ctx.strokeStyle = 'rgba(90, 55, 25, 0.25)';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, R * 0.008);
      for (const d of c.dunes) {
        const ca = Math.cos(d.ang), sa = Math.sin(d.ang);
        for (let i = 0; i < d.n; i++) {
          const off = (i - (d.n - 1) / 2) * d.gap;
          const cx2 = (d.x - sa * off) * R, cy2 = (d.y + ca * off) * R;
          ctx.beginPath();
          ctx.moveTo(cx2 - ca * d.len * R, cy2 - sa * d.len * R);
          ctx.quadraticCurveTo(cx2 - sa * d.bow * 2 * R, cy2 + ca * d.bow * 2 * R,
            cx2 + ca * d.len * R, cy2 + sa * d.len * R);
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
    }
    // …a canyon winding through the rimrock…
    if (fine) {
      ctx.strokeStyle = 'rgba(60, 32, 14, 0.4)';
      ctx.lineWidth = Math.max(1.2, R * 0.012);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < c.canyon.length; i++) {
        const p = c.canyon[i];
        if (i === 0) ctx.moveTo(p.x * R, p.y * R); else ctx.lineTo(p.x * R, p.y * R);
      }
      ctx.stroke();
      ctx.lineJoin = 'miter';
    }
    // …dark rimrock mesas…
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (const p of c.mesas) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fill();
    }
    // …and pale standing dust storms
    ctx.fillStyle = 'rgba(255, 235, 200, 0.28)';
    for (const s of c.storms) {
      ctx.beginPath();
      ctx.ellipse(s.x * R, s.y * R, s.rx * R, s.rx * 0.45 * R, s.rot, 0, TAU);
      ctx.fill();
    }
  } else if (b.ptype === 'shroud') {
    // Venusian shroud: total cloud cover, no surface ever visible. Each deck
    // turns at its own rate (multiples of b.rot on top of the base spin), so
    // the cover visibly shears without any wall-clock animation.
    for (const d of c.decks) {
      ctx.save();
      ctx.rotate(b.rot * d.rate + d.ph);
      ctx.strokeStyle = d.tone;
      ctx.lineWidth = d.w * R;
      ctx.beginPath();
      ctx.arc(0, 0, d.r * R, d.ph, d.ph + d.span);
      ctx.stroke();
      ctx.restore();
    }
    // pale and dark chevrons where the decks collide — the Y-cloud read
    ctx.fillStyle = 'rgba(255, 252, 230, 0.16)';
    ctx.beginPath();
    ctx.ellipse(R * 0.1, c.chevY * R, R * 0.5, R * 0.17, -0.4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(105, 88, 34, 0.14)';
    ctx.beginPath();
    ctx.ellipse(-R * 0.12, -c.chevY * R, R * 0.44, R * 0.15, 0.35, 0, TAU);
    ctx.fill();
  } else if (b.ptype === 'crystal') {
    // Faceted lattice, keyed to the REAL silhouette: traceSurface already
    // built b.cjag for the fill this detail is clipped to, so a wedge fills
    // each actual shard instead of inventing six of its own…
    const pts = (b.cjag ||= crystalShards(b.id)).pts;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.1)' : 'rgba(30, 10, 60, 0.16)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(p.a0) * R * p.ri, Math.sin(p.a0) * R * p.ri);
      ctx.lineTo(Math.cos(p.tip) * R * p.ro, Math.sin(p.tip) * R * p.ro);
      ctx.lineTo(Math.cos(q.a0) * R * q.ri, Math.sin(q.a0) * R * q.ri);
      ctx.closePath();
      ctx.fill();
    }
    // …with faint inner echoes of the outline — depth, looking INTO the mass…
    if (fine) {
      ctx.strokeStyle = 'rgba(230, 215, 255, 0.16)';
      ctx.lineWidth = Math.max(1, R * 0.012);
      for (const s of c.rings) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const vx = Math.cos(p.a0) * R * p.ri * s, vy = Math.sin(p.a0) * R * p.ri * s;
          if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
          ctx.lineTo(Math.cos(p.tip) * R * p.ro * s, Math.sin(p.tip) * R * p.ro * s);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    // …bright facet seams running core to every tip (solid strokes — machined
    // work, like the carved stone, never dashed)…
    ctx.strokeStyle = 'rgba(230, 210, 255, 0.45)';
    ctx.lineWidth = Math.max(1, R * 0.018);
    ctx.beginPath();
    for (const p of pts) {
      ctx.moveTo(Math.cos(p.tip) * R * 0.14, Math.sin(p.tip) * R * 0.14);
      ctx.lineTo(Math.cos(p.tip) * R * p.ro * 0.97, Math.sin(p.tip) * R * p.ro * 0.97);
    }
    ctx.stroke();
    // …and bright glint points where facets catch the light (seeded, static —
    // the cored-rock glint twinkles because it marks salvage; a world's
    // sparkle is ambient state, so it holds still)
    if (fine) {
      ctx.fillStyle = 'rgba(240, 225, 255, 0.55)';
      for (const g of c.glints) {
        ctx.beginPath();
        ctx.arc(Math.cos(g.a) * R * g.r, Math.sin(g.a) * R * g.r, Math.max(1, g.s * R), 0, TAU);
        ctx.fill();
      }
    }
  } else {  // rocky: mottled continents
    // dark maria and pale mineral highlands…
    for (const p of c.maria) {
      blobPath(p.x * R, p.y * R, p.rx * R, p.rx * p.k * R, p.rot, p.pts);
      ctx.fillStyle = p.light ? 'rgba(255, 240, 215, 0.1)' : 'rgba(0,0,0,0.16)';
      ctx.fill();
    }
    // …pocked with rimmed craters — the world's old face, not damage (wounds
    // belong to the crumble and drawBodyDamage)…
    if (fine) {
      for (const cr of c.craters) {
        const crr = cr.r * R;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.arc(cr.x * R, cr.y * R, crr, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath(); ctx.arc(cr.x * R - crr * 0.28, cr.y * R - crr * 0.28, crr * 0.62, 0, TAU); ctx.fill();
      }
    }
    // …and mountain chains: dark zigzag ranges crossing the highlands
    if (fine) {
      ctx.strokeStyle = 'rgba(30, 18, 8, 0.25)';
      ctx.lineWidth = Math.max(1, R * 0.012);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const rg of c.ridges) {
        const ca = Math.cos(rg.ang), sa = Math.sin(rg.ang);
        ctx.beginPath();
        for (let i = 0; i < rg.n; i++) {
          const wob = rg.off[i];
          const px = (rg.x + ca * rg.step * i - sa * wob) * R;
          const py = (rg.y + sa * rg.step * i + ca * wob) * R;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
    }
    if (b.landmark === 'crater') {
      // THE SCAR — a giant impact basin with bright ejecta rays
      const cx = R * 0.28, cy = -R * 0.24;
      ctx.fillStyle = 'rgba(235, 240, 250, 0.26)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.3, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(235, 240, 250, 0.3)';
      ctx.lineWidth = Math.max(1.2, R * 0.025);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.3;
        ctx.moveTo(cx + Math.cos(a) * R * 0.32, cy + Math.sin(a) * R * 0.32);
        ctx.lineTo(cx + Math.cos(a) * R * (0.6 + (i % 3) * 0.18),
          cy + Math.sin(a) * R * (0.6 + (i % 3) * 0.18));
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// SPLASH WAVES — an ocean world answers a hit with rings running across the
// face (physics stamps b.seaHits on splashdowns, seabed strikes and ship
// dives; an ocean never craters, so this is its whole damage read). Event-
// driven motion on game.time — the aurora/eclipse convention. Solid strokes,
// clipped to the silhouette, and surface-local (h.a + b.rot) so a wave rides
// the spin like every other feature.
// SIZED LIKE A SEA, NOT A SCRATCH (user design call): these rings ARE the
// world's damage read, on a body ~551 units across, so the crest is a wide
// swell with a soft shoulder behind it and the trailing fronts are spaced far
// enough apart to read as separate waves at flying zoom. Thin hairlines on a
// disc that big looked like a hairline crack, which is the one thing an ocean
// must never look like.
function drawSeaRipples(game, b) {
  const T = CFG.OCEAN_RIPPLE_T;
  const R = b.radius;
  let live = false;
  for (const h of b.seaHits) if (game.time - h.t < T) { live = true; break; }
  if (!live) return;
  ctx.save();
  traceSurface(b);
  ctx.clip();
  for (const h of b.seaHits) {
    const age = game.time - h.t;
    if (age < 0 || age >= T) continue;
    const u = age / T;
    const cx = b.x + Math.cos(h.a + b.rot) * R;
    const cy = b.y + Math.sin(h.a + b.rot) * R;
    const { reach, env } = seaPhase(R, u, h.s);   // SHARED with the limb
    // Off the wave's own envelope, so the rings attack from nothing and decay
    // with the crest instead of being drawn at full strength on frame one.
    // Absolute: the cavity act is a SHAPE (the limb dents), not an inside-out
    // ring, and during it the reach is ~0 so there is nothing to draw anyway.
    const fade = Math.abs(env) * h.s;
    const lw = Math.max(2.5, R * 0.055 * (1 - u * 0.45));
    // THE SWELL behind the crest — a broad soft band, so the leading wave has
    // water piled behind it instead of being a lone stroke on flat blue.
    ctx.lineWidth = lw * 3.4;
    ctx.strokeStyle = `rgba(150, 205, 245, ${0.20 * fade})`;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.1, reach - lw * 1.6), 0, TAU); ctx.stroke();
    // ...then the crest and ONE front trailing it. Four fronts per hit, times
    // every live hit, turned the face into concentric static (user call — "too
    // many wave pulses"): the read wanted fewer, bigger swells, not more rings.
    ctx.lineWidth = lw;
    for (let i = 0; i < 2; i++) {
      const rr = reach - i * R * 0.16;
      if (rr <= 0) continue;
      ctx.strokeStyle = `rgba(214, 240, 255, ${(0.62 - i * 0.20) * fade})`;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.stroke();
    }
  }
  ctx.restore();
}

// THE WATER CLOSES OVER THE SHIP. The hull is drawn after the world it is
// flying through, so inside an ocean it painted on TOP of the sea and read as
// sitting on a blue disc — the exact thing b.seaDim already fixes for rock, but
// rock is dimmed and the ship cannot be (drawShip owns its own alphas across a
// dozen passes, and an outer globalAlpha would be clobbered by the first one
// that sets its own). So the sea is painted back over the hull instead, which
// is both cheaper and physically what is happening: you are UNDER the water.
//
// Graded by DEPTH, not flat — deep water is darker and denser, the waterline
// barely tints — and the whole veil fades in on game.seaK, so the sea closes
// over the ship as it sinks rather than snapping on at the surface. Clipped to
// traceSurface, so the crumble silhouette (and a hit ocean's own limb) bounds
// it exactly like every other in-world pass on this body.
function drawSeaVeil(game) {
  const b = game.seaBody;
  const k = game.seaK || 0;
  // Ship alive too: seaBody/seaK are published from the environmental sweep,
  // which stops running on death, so a wreck would leave the last frame's water
  // painted over the world until the respawn cleared it.
  if (!b || !b.alive || k < 0.02 || !game.ship.alive) return;
  const R = b.radius;
  ctx.save();
  traceSurface(b);
  ctx.clip();
  // GOING UNDER DARKENS, IT NEVER BRIGHTENS (user call). An earlier grade put
  // its brightest stop at the waterline to keep the near-limb water from
  // reading as void, and it worked — by lighting the whole world up the moment
  // you touched it, which is backwards: entering water cannot make the planet
  // you are entering brighter. So every stop here is DARKER than the sea's own
  // blue (world.js ocean palette ~ 58,111,196) and the alpha is near zero at
  // the drawn edge, ramping in with depth. The near-limb water stays legible
  // for free — it is barely veiled — and the hiding work is done by the murk
  // lens below and by the screen overlay, where it belongs.
  // The stop positions follow the REAL water column (OCEAN_CORE), so the grade
  // deepens across the water rather than across the whole disc — the column is
  // 0.42r now, and a grade keyed to the disc put its dark end far below any
  // water there is.
  const core = CFG.OCEAN_CORE;
  const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, R);
  g.addColorStop(0, `rgba(3, 16, 48, ${0.80 * k})`);
  g.addColorStop(core, `rgba(4, 20, 56, ${0.68 * k})`);
  g.addColorStop(core + (1 - core) * 0.6, `rgba(5, 26, 68, ${0.44 * k})`);
  g.addColorStop(0.985, `rgba(8, 36, 86, ${0.20 * k})`);
  g.addColorStop(1, `rgba(10, 44, 100, ${0.06 * k})`);
  ctx.fillStyle = g;
  traceSurface(b);
  ctx.fill();

  // ...AND A COLUMN OF MURK OVER THE HULL. The disc wash is uniform, so the
  // ship stayed perfectly legible inside it; this is what actually hides it.
  // A dark, soft lens centred on the ship, dying off to nothing well inside the
  // disc so it never draws an edge of its own.
  //
  // NO CAUSTIC BANDS. Lit arcs stacked by depth were tried here and cut (user
  // call — "the weird curved horizontal lines look odd"): at planetary radius
  // any short arc is visually straight, so light in the water came out as a
  // stack of horizontal bars across the hull. Moving light belongs on the
  // screen overlay, where it is not fighting a 500-unit curve.
  const s = game.ship;
  if (s.alive) {
    // WIDE AND SOFT, NOT TIGHT AND STRONG. A hull-sized lens — and worse, a
    // bright haze sized to the hull — both came out as a legible DISC sitting
    // on the sea, which is a hard edge in-world and reads far worse than the
    // ship it was hiding. This pool is a third of the world across with no
    // stop steep enough to find, so what you register is that the water has
    // gone deep here, not that something round is drawn on it.
    //
    // And it hides by LOWERING CONTRAST, not by covering: the hull is dark ink
    // on a bright sea, so pulling the water down toward the hull's own value is
    // what makes it hard to pick out. Adding light did the exact opposite.
    // ...and it BACKS OFF WITH DEPTH. The murk exists to kill contrast against
    // BRIGHT water; deep water is already near-black from the submersion
    // overlay, so down there it has nothing left to hide and only subtracts the
    // last few values that let a pilot find their own hull. At the seabed the
    // scene is at its most dangerous and the ship must still be flyable.
    const mk = k * (1 - 0.55 * Math.min(1, game.seaDeep || 0));
    const lens = Math.max(s.radius * 22, R * 0.34);
    const mg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, lens);
    mg.addColorStop(0, `rgba(4, 18, 52, ${0.78 * mk})`);
    mg.addColorStop(0.35, `rgba(5, 22, 60, ${0.52 * mk})`);
    mg.addColorStop(0.7, `rgba(6, 28, 72, ${0.22 * mk})`);
    mg.addColorStop(1, 'transparent');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(s.x, s.y, lens, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// SUBMERSION OVERLAY — screen space, the corona-heat / Oort-frost slot and the
// same grammar: a wash plus a vignette whose depth tracks a 0..1 state, with a
// slow shimmer so the glass reads as water rather than as a coloured filter.
//
// This is the pass that actually says YOU ARE UNDER: the in-world veil tints
// the ship, and this tints the cockpit looking out at it. It also has to carry
// the LIFE, because everything in world space is either a still wash or a curve
// at planetary radius. Four layers, all on game.time — a deep wash, a breathing
// vignette, god-rays raking down from the surface, and suspended particulate
// drifting through them. The rays and the motes are what sell water; a flat
// blue filter reads as a colour grade.
//
// TWO AXES, NOT ONE. `k` (game.seaK) is how WET the hull is and decides whether
// this pass exists at all — it is 0.5 for a ship floating half submerged, so
// bobbing on the surface gets a light, pleasant wash. `d` (game.seaDeep) is how
// far down the water column it has been driven, and it is what turns that wash
// into somewhere you should not be: the light dies, the vignette closes, the
// colour drains toward black, and the water fills with fast-moving silt.
// Keeping them separate is the whole trick — depth alone would leave a surfaced
// ship un-tinted, and wetness alone would make the abyss look like a paddle.
function drawSeaScreen(game) {
  const k = game.seaK || 0;
  if (k < 0.02 || !game.ship.alive) return;
  const t = game.time;
  const d = Math.min(1, game.seaDeep || 0);
  const dd = d * d;                       // menace tracks the same curve the crush damage does
  const shim = 1 + 0.08 * Math.sin(t * 1.7) + 0.05 * Math.sin(t * 3.1);
  // 1. The water itself — deep, DARKER than what it covers, and draining of
  // colour as it gets deeper. Sea blue at the surface, near-black at the floor.
  const wr = Math.round(10 - 7 * dd), wg = Math.round(44 - 34 * dd), wb = Math.round(96 - 66 * dd);
  ctx.fillStyle = `rgba(${wr}, ${wg}, ${wb}, ${(0.26 + 0.42 * dd) * k * shim})`;
  ctx.fillRect(0, 0, vw, vh);
  // 2. Vignette. It BREATHES on a slow clock at the surface and CLOSES IN with
  // depth — the aperture shrinks toward a narrow tunnel, which is the single
  // strongest "you are too deep" cue available in screen space.
  const br = 1 + (0.05 + 0.05 * dd) * Math.sin(t * (0.9 + 1.5 * dd));
  const vg = ctx.createRadialGradient(vw / 2, vh / 2, vh * (0.48 - 0.16 * k - 0.30 * dd) * br,
    vw / 2, vh / 2, vh * 0.98);
  vg.addColorStop(0, 'transparent');
  vg.addColorStop(0.58, `rgba(6, 32, 78, ${(0.34 + 0.30 * dd) * k})`);
  vg.addColorStop(1, `rgba(${Math.round(2 - 1 * dd)}, ${Math.round(14 - 11 * dd)}, ${Math.round(44 - 38 * dd)}, ${(0.80 + 0.18 * dd) * k * shim})`);
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, vw, vh);
  // 3. GOD-RAYS from the surface — wide, tilted, and out of phase with each
  // other so the pattern never lands on a beat. Additive and few: narrow bright
  // bands would read as the scanline grammar the solar-storm overlay owns.
  // They DIE OFF with depth, because the reason the deep is frightening is that
  // the light does not reach it.
  const lightK = Math.max(0, 1 - d * 1.5);
  if (lightK > 0.01) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const ph = t * (0.11 + i * 0.027) + i * 2.3;
      const x = (0.5 + 0.46 * Math.sin(ph)) * vw;
      const tilt = vw * (0.10 + 0.06 * Math.sin(ph * 0.7 + i));
      const w = vw * (0.035 + 0.020 * Math.sin(ph * 1.3));
      const a = 0.075 * k * lightK * (0.55 + 0.45 * Math.sin(ph * 1.9 + i));
      const lg = ctx.createLinearGradient(x - w - tilt, 0, x + w + tilt, vh);
      lg.addColorStop(0, 'transparent');
      lg.addColorStop(0.5, `rgba(150, 212, 255, ${a})`);
      lg.addColorStop(1, 'transparent');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, vw, vh);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // 4. SUSPENDED PARTICULATE — the cue that costs least and reads hardest:
  // water you are looking THROUGH has things floating in it. Deterministic
  // positions off the index (no rng — the cosmetic streams are private and this
  // must not touch one), drifting up and wrapping, each on its own sway. With
  // depth it RISES FASTER and there is MORE of it, so the deep reads as a
  // current dragging past rather than as still water that merely went dark.
  const motes = 46 + Math.round(54 * dd);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < motes; i++) {
    const sx = ((i * 97.13) % 101) / 101;
    const sp = 0.4 + ((i * 31.7) % 17) / 17 * 0.8;
    const y = ((((i * 53.9) % 89) / 89) - t * (0.018 + 0.075 * dd) * sp) % 1;
    const px = (sx + Math.sin(t * 0.25 * sp + i) * 0.012) * vw;
    const py = (y < 0 ? y + 1 : y) * vh;
    const r = 0.8 + ((i * 7) % 5) * 0.5;
    ctx.fillStyle = `rgba(190, 226, 255, ${(0.20 + 0.14 * dd) * k * (0.35 + 0.65 * Math.sin(t * 0.8 + i) ** 2)})`;
    ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
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
  } else if (b.moonType === 'lodestar') {
    // Impossibly dense: the surface SAGS — a deep center darkening, short
    // compression striations at broken angles and radii, and one hard
    // off-center glint of bare compressed metal. NEVER full concentric rings
    // with a center pip: that's a bullseye, and target grammar belongs to the
    // aiming UI (2026-08 user call — "looks too much like a target"). The
    // bent trajectory forecast does the rest of the talking.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, 'rgba(8, 6, 16, 0.55)');
    g.addColorStop(0.7, 'rgba(8, 6, 16, 0.22)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(190, 185, 215, 0.26)';
    ctx.lineWidth = Math.max(0.8, R * 0.045);
    for (let i = 0; i < 5; i++) {
      const a0 = b.id * 1.9 + i * 2.63;
      const rr = R * (0.25 + (((b.id * 7 + i * 31) % 10) / 10) * 0.55);
      const span = 0.5 + ((b.id + i) % 4) * 0.28;
      ctx.beginPath(); ctx.arc(0, 0, rr, a0, a0 + span); ctx.stroke();
    }
    const ga = b.id * 0.9;
    ctx.fillStyle = 'rgba(240, 236, 255, 0.7)';
    ctx.beginPath();
    ctx.arc(Math.cos(ga) * R * 0.3, Math.sin(ga) * R * 0.3, Math.max(1.2, R * 0.06), 0, TAU);
    ctx.fill();
  } else if (b.moonType === 'geode') {
    craters(2);
    // The tell: a glinting crystal seam in the same purple the freed core
    // wears (#b98cff) — the cored-rock glint grammar at moon scale.
    const a0 = b.id * 2.1;
    ctx.strokeStyle = 'rgba(185, 140, 255, 0.55)';
    ctx.lineWidth = Math.max(1, R * 0.06);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * R * 0.85, Math.sin(a0) * R * 0.85);
    ctx.quadraticCurveTo(Math.cos(a0 + 1.8) * R * 0.3, Math.sin(a0 + 1.8) * R * 0.3,
      Math.cos(a0 + 2.9) * R * 0.8, Math.sin(a0 + 2.9) * R * 0.8);
    ctx.stroke();
  } else if (b.moonType === 'verdant') {
    // Moss beds in two greens, seeded biolum motes glinting between them —
    // the same healing green the glow pockets pop (150,255,190).
    for (let i = 0; i < 4; i++) {
      const a = b.id * 1.4 + i * 1.7;
      ctx.fillStyle = i % 2 ? 'rgba(60, 130, 90, 0.35)' : 'rgba(150, 220, 170, 0.22)';
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, R * 0.4, R * 0.26, a, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(150, 255, 190, 0.8)';
    for (let i = 0; i < 5; i++) {
      const a = b.id * 2.3 + i * 1.256;
      const d = (((b.id * 11 + i * 37) % 100) / 100) * 0.8;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * R * d, Math.sin(a) * R * d, Math.max(0.8, R * 0.03), 0, TAU);
      ctx.fill();
    }
  } else if (b.moonType === 'comet') {
    // Frost fields like the ice moon but sparser — the body is quiet; the
    // coma outside the clip (below) is where this type spends its look.
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 3; i++) {
      const a = b.id * 1.9 + i * 2.4;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, R * 0.3, R * 0.18, a, 0, TAU);
      ctx.fill();
    }
  } else if (b.moonType === 'husk') {
    craters(2);
    // A WRECK-YARD WELDED OVER ROCK: angular hull plates with riveted seams,
    // a snapped ring-girder, and hard little glints of bare metal — kin to
    // the graveyard (#9fb0c2), and unmistakably CONSTRUCTED, not geology
    // (2026-08 user call — "could be more visually interesting").
    for (let i = 0; i < 5; i++) {
      const a = b.id * 1.1 + i * 1.31;
      const d = R * (0.15 + (((b.id * 5 + i * 17) % 10) / 10) * 0.5);
      const w = R * (0.28 + ((b.id + i) % 3) * 0.1), h = w * 0.62;
      ctx.save();
      ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
      ctx.rotate(a * 1.7);
      ctx.fillStyle = i % 2 ? 'rgba(125, 133, 146, 0.34)' : 'rgba(84, 66, 48, 0.38)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      // riveted seam along the plate's top edge — the "built" tell
      ctx.fillStyle = 'rgba(200, 210, 224, 0.5)';
      const nr = 3 + (i % 3);
      for (let k = 0; k < nr; k++) {
        ctx.beginPath();
        ctx.arc(-w / 2 + (k + 0.5) * (w / nr), -h / 2 + h * 0.18, Math.max(0.6, R * 0.018), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    // The snapped ring-girder: an arc that runs, breaks, resumes — wreckage,
    // and deliberately NOT a closed ring (see the lodestar's bullseye note).
    ctx.strokeStyle = 'rgba(159, 176, 194, 0.55)';
    ctx.lineWidth = Math.max(1, R * 0.05);
    const ha = b.id * 2.2;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.62, ha, ha + 1.4); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.62, ha + 1.8, ha + 2.5); ctx.stroke();
    // bare-metal glints
    ctx.fillStyle = 'rgba(230, 238, 248, 0.75)';
    for (let i = 0; i < 3; i++) {
      const a = b.id * 3.1 + i * 2.1;
      const d = R * (0.2 + (((b.id + i * 7) % 10) / 10) * 0.55);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.8, R * 0.025), 0, TAU);
      ctx.fill();
    }
  } else if (b.moonType === 'pumice') {
    // Froth rock: vesicle stipple ONLY — the shared crater set is exactly
    // what made a pumice moon read as one more rock moon ("Shale and Curd
    // look too similar", 2026-08). Dense, fine, low-contrast pocks over
    // chalk-pale ground, plus two soft bright froth patches; nothing sharp,
    // nothing shared with the rock look.
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (let i = 0; i < 2; i++) {
      const a = b.id * 1.3 + i * 2.8;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4, R * 0.45, R * 0.3, a, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    for (let i = 0; i < 34; i++) {
      const a = b.id * 2.7 + i * 0.361;
      const d = (((b.id * 13 + i * 41) % 100) / 100) * 0.88;
      const rr = R * (0.022 + ((b.id + i) % 4) * 0.014);
      ctx.beginPath(); ctx.arc(Math.cos(a) * R * d, Math.sin(a) * R * d, rr, 0, TAU); ctx.fill();
    }
  } else if (b.moonType === 'molten') {
    // A COOLED BLACK CRUST OVER LIVE MAGMA — three layers (2026-08 second
    // pass; the first cut was flat black with zigzag scribbles):
    //   1. near-black ground with broad mottled crust plates,
    //   2. soft magma pools GLOWING THROUGH thin crust (the drawMoltenCrust
    //      convection cells, dimmer and fewer — heat under, not fire on top),
    //   3. smooth CURVED fissures: a wide soft under-glow beneath a hot
    //      hairline core, with short side-branches — cracks, not pipes.
    // All breathing on per-crack phases (the drawMoltenCrust precedent:
    // pulsing lava, not a blinking light). Additive passes reset after.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(70, 40, 32, 0.25)';
    for (let i = 0; i < 5; i++) {
      const a = b.id * 1.3 + i * 2.51;
      const d = R * (((b.id * 3 + i * 23) % 10) / 10) * 0.6;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, R * 0.38, R * 0.24, a * 2.1, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const a = b.id * 2.9 + i * 1.71;
      const d = R * (0.15 + (((b.id + i * 11) % 10) / 10) * 0.6);
      const sz = R * (0.16 + ((b.id + i) % 3) * 0.07);
      const boil = 0.55 + 0.45 * Math.sin(game.time * (0.5 + (i % 3) * 0.25) + i * 1.9 + b.id);
      const cx2 = Math.cos(a) * d, cy2 = Math.sin(a) * d;
      const pg = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, sz);
      pg.addColorStop(0, `rgba(255, 120, 45, ${0.18 * boil})`);
      pg.addColorStop(1, 'transparent');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(cx2, cy2, sz, 0, TAU); ctx.fill();
    }
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a0 = b.id * 1.7 + i * 1.047;
      const glow = 0.5 + 0.5 * Math.sin(game.time * (0.6 + (i % 3) * 0.3) + i * 2.1 + b.id);
      const pts = [];
      let px = Math.cos(a0) * R * 0.95, py = Math.sin(a0) * R * 0.95;
      let aa = a0 + Math.PI * (0.9 + Math.sin(b.id * 1.1 + i) * 0.12);
      // A standing per-crack drift plus a big per-step wobble: the first cut
      // wandered so gently it read as STRAIGHT lines ("too much like straight
      // lines", 2026-08) — shorter steps, harder turns, and a constant bias
      // so every fissure ARCS instead of shooting across the disc.
      const drift = Math.sin(b.id * 2.7 + i * 4.3) * 0.3;
      pts.push([px, py]);
      for (let k = 1; k <= 11; k++) {
        aa += drift + Math.sin(b.id * 3.3 + i * 7 + k * 2.7) * 0.85;
        px += Math.cos(aa) * R * 0.12; py += Math.sin(aa) * R * 0.12;
        pts.push([px, py]);
      }
      const trace = () => {
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length - 1; k++) {
          const mx = (pts[k][0] + pts[k + 1][0]) / 2, my = (pts[k][1] + pts[k + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[k][0], pts[k][1], mx, my);
        }
        ctx.stroke();
      };
      ctx.strokeStyle = `rgba(255, 90, 30, ${0.10 + 0.14 * glow})`;
      ctx.lineWidth = Math.max(1.5, R * 0.05);
      trace();
      ctx.strokeStyle = `rgba(255, 170, 80, ${0.35 + 0.4 * glow})`;
      ctx.lineWidth = Math.max(0.6, R * 0.011);
      trace();
      ctx.strokeStyle = `rgba(255, 130, 50, ${0.2 + 0.25 * glow})`;
      ctx.lineWidth = Math.max(0.6, R * 0.009);
      for (let k = 2; k <= 4; k += 2) {
        const ba = Math.atan2(pts[k][1] - pts[k - 1][1], pts[k][0] - pts[k - 1][0]) + (k % 4 ? 1 : -1) * 1.1;
        ctx.beginPath(); ctx.moveTo(pts[k][0], pts[k][1]);
        ctx.lineTo(pts[k][0] + Math.cos(ba) * R * 0.14, pts[k][1] + Math.sin(ba) * R * 0.14);
        ctx.stroke();
      }
      // HOT SPOTS: two seeded joints per fissure run WHITE-hot — a crack is
      // not uniformly warm, it has places where the crust is thinnest. Each
      // node breathes on its own faster phase, out of step with its crack.
      for (let n = 0; n < 2; n++) {
        const k = 2 + ((b.id * 5 + i * 3 + n * 7) % (pts.length - 4));
        const [hx2, hy2] = pts[k];
        const hot = 0.5 + 0.5 * Math.sin(game.time * (1.1 + (n % 2) * 0.5) + i * 3.7 + n * 2.3 + b.id * 1.9);
        const hr = R * (0.045 + 0.03 * hot);
        const hg = ctx.createRadialGradient(hx2, hy2, 0, hx2, hy2, hr);
        hg.addColorStop(0, `rgba(255, 235, 190, ${0.5 * hot})`);
        hg.addColorStop(0.45, `rgba(255, 150, 60, ${0.3 * hot})`);
        hg.addColorStop(1, 'transparent');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(hx2, hy2, hr, 0, TAU); ctx.fill();
      }
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  } else {
    craters(b.moonType === 'dust' ? 5 : 3);
  }
  ctx.restore();
  // COMET COMA — outside the clip, in the WORLD frame: the tail points away
  // from the sun, never with the spin. A real object, so no hard edge — one
  // soft additive breath, brightening as the moon nears the periapsis where it
  // vents (the same rail read world.js's vent gate uses).
  // NOT on a promoted landmark: the Forge Moon / shepherd keep the moonType
  // they rolled before promotion (world.js overrides name and job, not type),
  // and a volcanic moon wearing a comet's breath misreads as the wrong hazard.
  if (b.moonType === 'comet' && !b.volcanic && !b.shepherd && game.homeStar) {
    // e >= 0.15 mirrors world.js's vent-timetable gate: below it the moon
    // vents on the plain ice cadence, and a full-bright coma on a low-e comet
    // would promise a burst event the mechanic no longer delivers.
    let k = 0.4;
    const rail = b.rail;
    if (rail && rail.e >= 0.15 && rail.parent) {
      const dp = Math.hypot(b.x - rail.parent.x, b.y - rail.parent.y);
      const peri = rail.a * (1 - rail.e), apo = rail.a * (1 + rail.e);
      k = 0.25 + 0.75 * clamp(1 - (dp - peri) / Math.max(1, apo - peri), 0, 1);
    }
    const a = Math.atan2(b.y - game.homeStar.y, b.x - game.homeStar.x);
    const cx2 = b.x + Math.cos(a) * R, cy2 = b.y + Math.sin(a) * R;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(b.x, b.y, R * 0.8, cx2, cy2, R * 2.6);
    g.addColorStop(0, `rgba(190, 230, 240, ${0.2 * k})`);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx2, cy2, R * 2.6, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
  // Subtle tinted rim — dimmer than the old flat bright ring. A MOLTEN moon
  // takes a faint EMBER rim instead: the pale stroke that helps a lit moon
  // read against the sky turns into a bright outline against a near-black
  // crust ("looks off", 2026-08) — heat at the limb is the honest edge there.
  ctx.strokeStyle = b.moonType === 'molten'
    ? 'rgba(255, 120, 55, 0.16)' : 'rgba(210, 224, 245, 0.35)';
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
// A CORE STILL COOLING. Freshly stripped, it comes out red-hot and boiling and
// settles into ordinary rock over CFG.GAS_CORE_COOL — the body's own colour is
// already lerping (physics.coolColor), and this is the heat on top of it: a
// convection pattern of bright cells churning over the surface, and an outer
// glow bleeding off the limb. Both fade to nothing as `molten` runs out, so the
// world quietly becomes the rocky planet it will stay.
// Cells are seeded off the id and ride b.rot, so they never swim.
function drawMoltenCrust(game, b) {
  const m = b.molten;
  const R = b.radius;
  ctx.save();
  ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.clip();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  ctx.globalCompositeOperation = 'lighter';
  const rng = mulberry32(b.id * 9137 + 5);
  for (let i = 0; i < 14; i++) {
    const a = rng() * TAU;
    const rr = R * Math.sqrt(rng()) * 0.92;
    const sz = R * (0.1 + rng() * 0.2);
    // Each cell breathes on its own phase — convection, not a blinking light.
    const boil = 0.45 + 0.55 * Math.sin(game.time * (0.7 + (i % 4) * 0.25) + i * 1.9 + b.id);
    const k = m * m * boil;
    if (k < 0.02) continue;
    const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
    const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, sz);
    g2.addColorStop(0, `rgba(255, 196, 108, ${0.5 * k})`);
    g2.addColorStop(0.5, `rgba(255, 96, 34, ${0.26 * k})`);
    g2.addColorStop(1, 'transparent');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(cx, cy, sz, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  // Heat bleeding off the limb — drawn outside the clip so it reads as glow.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const hg = ctx.createRadialGradient(b.x, b.y, R * 0.82, b.x, b.y, R * 1.5);
  hg.addColorStop(0, `rgba(255, 118, 48, ${0.3 * m})`);
  hg.addColorStop(1, 'transparent');
  ctx.fillStyle = hg;
  ctx.beginPath(); ctx.arc(b.x, b.y, R * 1.5, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// A WOUNDED GAS GIANT STORMS. There is no crust here to fissure — everything a
// rock does to this world is done to its weather — so damage reads as cyclones
// boiling up out of the band pattern: more of them as it fails, each a tight
// dark spiral with a bright sheared edge where it drags against the band it sits
// in. Seeded off the body id so they never swim, and drawn in the SURFACE frame
// so they ride the rotation like every other feature.
// Clipped to the disc, solid strokes, no dashes — a real object.
function drawGasWound(game, b) {
  const dmg01 = 1 - b.hp / b.maxHp;
  const R = b.radius;

  // ---- ENTRY WOUNDS: what a rock going in actually looks like -------------
  // Pushed by physics on every swallow (surface-local, so they ride the spin).
  // Four beats, all off one age: a hot compression FLASH at the entry point, a
  // PLUME of cloud thrown back out along the bearing, a SHOCK RING running
  // outward through the bands, and a dark PUNCH-HOLE that swirls shut. This is
  // the whole answer to "a rock hit it and nothing happened".
  if (b.gasHits && b.gasHits.length) {
    ctx.save();
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.clip();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    for (let i = b.gasHits.length - 1; i >= 0; i--) {
      const h = b.gasHits[i];
      const age = game.time - h.t;
      if (age < 0) continue;
      if (age > CFG.GAS_HIT_FADE) { b.gasHits.splice(i, 1); continue; }
      const k = 1 - age / CFG.GAS_HIT_FADE;          // 1 -> 0 over the wound's life
      const hx = Math.cos(h.a) * R, hy = Math.sin(h.a) * R;
      const w = R * (0.05 + 0.11 * h.s);             // wound width, from the impactor
      // PUNCH-HOLE: opens fast, closes slowly, and rotates as it closes.
      const open = Math.min(1, age * 6);
      const sw = w * open * (0.45 + 0.55 * k);
      ctx.save();
      ctx.translate(hx * 0.94, hy * 0.94);
      ctx.rotate(h.a + age * 1.1);
      ctx.fillStyle = `rgba(18, 12, 24, ${0.5 * k})`;
      ctx.beginPath(); ctx.ellipse(0, 0, sw, sw * 0.55, 0, 0, TAU); ctx.fill();
      // torn cloud dragged around the hole
      ctx.strokeStyle = `rgba(255, 250, 240, ${0.2 * k})`;
      ctx.lineWidth = Math.max(0.8, sw * 0.16);
      ctx.beginPath(); ctx.ellipse(0, 0, sw * 1.5, sw * 0.62, 0, 0.5, 3.1); ctx.stroke();
      ctx.restore();
      // SHOCK RING: a band-parallel arc sweeping away from the entry point.
      const ring = age / CFG.GAS_HIT_FADE;
      if (ring < 0.75) {
        const rk = 1 - ring / 0.75;
        ctx.strokeStyle = `rgba(255, 236, 208, ${0.26 * rk * rk})`;
        ctx.lineWidth = Math.max(0.9, R * 0.012 * (0.4 + h.s));
        const spread = 0.25 + ring * 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, R * (0.99 - ring * 0.12), h.a - spread, h.a + spread);
        ctx.stroke();
      }
      // FLASH + PLUME: compression heat at the moment of entry, thrown back out
      // along the way it came in. Additive — this is light, briefly.
      if (age < 0.7) {
        const fk = 1 - age / 0.7;
        ctx.globalCompositeOperation = 'lighter';
        const g2 = ctx.createRadialGradient(hx, hy, 0, hx, hy, w * (1.4 + age * 5));
        g2.addColorStop(0, `rgba(255, 226, 176, ${0.75 * fk * fk})`);
        g2.addColorStop(0.5, `rgba(255, 150, 70, ${0.3 * fk * fk})`);
        g2.addColorStop(1, 'transparent');
        ctx.fillStyle = g2;
        ctx.beginPath(); ctx.arc(hx, hy, w * (1.4 + age * 5), 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.restore();
  }

  if (dmg01 < 0.02) return;
  const n = Math.max(1, Math.round(CFG.GAS_STORMS * dmg01));
  const rng = mulberry32(b.id * 4271 + 13);
  ctx.save();
  ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.clip();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  ctx.lineCap = 'round';
  for (let i = 0; i < CFG.GAS_STORMS; i++) {
    // Every storm's rolls are consumed in the same order every frame regardless
    // of how many are open, so the existing ones never move as new ones form.
    const a0 = rng() * TAU;
    const rr = R * (0.25 + rng() * 0.6);
    const sz = R * (0.1 + rng() * 0.12);
    const spin = rng() < 0.5 ? -1 : 1;
    const drift = 0.15 + rng() * 0.5;
    if (i >= n) continue;
    const grow = Math.min(1, n - i);
    // Cyclones are the one thing on a gas giant that MOVES under its own power
    // — they rotate against the band, slowly. Phase accumulates off game.time
    // at a fixed rate, so it cannot jump when the damage level changes.
    const ph = game.time * drift * spin;
    const cx = Math.cos(a0) * rr, cy = Math.sin(a0) * rr;
    const s = sz * grow;
    // dark eye + two trailing arms sheared out into the band
    ctx.fillStyle = `rgba(24, 16, 30, ${0.34 + 0.26 * dmg01})`;
    ctx.beginPath(); ctx.ellipse(cx, cy, s, s * 0.66, ph, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(12, 8, 18, ${0.3 + 0.3 * dmg01})`;
    ctx.lineWidth = Math.max(0.9, s * 0.3);
    for (let k = 0; k < 2; k++) {
      const st = ph + k * Math.PI;
      ctx.beginPath();
      ctx.ellipse(cx, cy, s * 1.75, s * 0.72, ph, st, st + 1.5);
      ctx.stroke();
    }
    // the bright shear line where the storm drags on the band beside it
    ctx.strokeStyle = `rgba(255, 245, 225, ${0.16 * grow})`;
    ctx.lineWidth = Math.max(0.8, s * 0.16);
    ctx.beginPath();
    ctx.ellipse(cx, cy, s * 1.28, s * 0.5, ph, 0.4, 2.6);
    ctx.stroke();
    // THE EYE GLOWS as the wound deepens. This is the damage READ — a solid
    // world leaks ember light from its deepest fissures past 55% damage, and
    // this is the same escalation for a world made of weather: you are seeing
    // down through a hole in the cloud deck to the hot interior. Without it a
    // wounded giant just looked like a giant with weather on it, and the player
    // had no way to tell one was being hurt at all.
    if (dmg01 > 0.4) {
      const heat = (dmg01 - 0.4) / 0.6;
      const breathe = 0.75 + 0.25 * Math.sin(game.time * 2.1 + i * 1.9 + b.id);
      ctx.globalCompositeOperation = 'lighter';
      const eg = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 1.5);
      eg.addColorStop(0, `rgba(255, 214, 150, ${0.5 * heat * breathe * grow})`);
      eg.addColorStop(0.45, `rgba(255, 124, 48, ${0.26 * heat * breathe * grow})`);
      eg.addColorStop(1, 'transparent');
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(cx, cy, s * 1.5, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.lineCap = 'butt';
  ctx.restore();

  // ---- THE COLLAPSE: the core burning through a thinning envelope ---------
  // While the throes run (physics.updateGasStrip) the world is falling in on
  // itself, and what the player should see is the reason: the hot core, closer
  // and brighter every second as the cloud above it goes. This is the scene the
  // strip is — five seconds of a world coming apart — rather than the instant
  // swap it replaced.
  if (b.stripT > 0) {
    const k = 1 - b.stripT / b.stripFor;             // 0 -> 1 across the collapse
    const flick = 0.8 + 0.2 * Math.sin(game.time * 13 + b.id);
    ctx.save();
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const cr = R * (0.32 + 0.5 * k);
    const cg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, cr);
    cg.addColorStop(0, `rgba(255, 244, 214, ${(0.28 + 0.6 * k) * flick})`);
    cg.addColorStop(0.35, `rgba(255, 176, 84, ${(0.2 + 0.45 * k) * flick})`);
    cg.addColorStop(1, 'transparent');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(b.x, b.y, cr, 0, TAU); ctx.fill();
    // Tearing seams opening through the cloud deck as it comes apart.
    ctx.strokeStyle = `rgba(255, 200, 130, ${0.4 * k * flick})`;
    ctx.lineWidth = Math.max(1.2, R * 0.02 * (0.4 + k));
    ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const sa = b.rot + b.id * 0.7 + i * 0.897;
      ctx.beginPath();
      ctx.moveTo(b.x + Math.cos(sa) * R * 0.15, b.y + Math.sin(sa) * R * 0.15);
      ctx.lineTo(b.x + Math.cos(sa) * R * (0.4 + 0.75 * k), b.y + Math.sin(sa) * R * (0.4 + 0.75 * k));
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // ---- VENTING: past CFG.GAS_VENT the envelope is visibly bleeding away ----
  // Drawn OUTSIDE the disc clip — this is atmosphere leaving the world, and it
  // is the promise the strip-to-core death pays off. Streamers trail anti-spin
  // and drift outward, seeded off the id so they don't swim.
  if (dmg01 > CFG.GAS_VENT) {
    const v = (dmg01 - CFG.GAS_VENT) / (1 - CFG.GAS_VENT);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const a0 = b.id * 1.7 + i * 0.897 + game.time * 0.09 * (b.spin < 0 ? -1 : 1);
      const reach = R * (0.12 + 0.5 * v) * (0.6 + ((b.id + i * 7) % 5) / 5);
      const flick = 0.5 + 0.5 * Math.sin(game.time * 1.3 + i * 2.2 + b.id);
      ctx.strokeStyle = `rgba(255, 214, 168, ${0.14 * v * flick})`;
      ctx.lineWidth = Math.max(1.2, R * 0.035 * v);
      ctx.beginPath();
      ctx.arc(b.x, b.y, R * 1.02 + reach * 0.5, a0 - 0.34, a0 + 0.34);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
}

// Solid strokes only — this is a real object, not helper UI.
function drawBodyDamage(game, b) {
  const dmg01 = 1 - b.hp / b.maxHp;
  const R = b.radius;
  // DETAIL REFERENCE RADIUS. Everything below — crack widths, crack lengths,
  // ember fissure glow, the fracture rays around a crater — was authored as a
  // fraction of R back when a body this system draws was at most ~250 units
  // across. Worlds are now built up to 3x their authored radius
  // (CFG.PLANET_R_MUL), and a plain fraction scales the DAMAGE with them: a
  // 686-unit planet drew 12-unit-wide fissures running 450 units across its
  // face, which read as canyons gouged in the surface rather than as cracking.
  // A crack does not get wider or longer because the planet is bigger, so the
  // detail is sized against a FIXED reference instead — bodies at or under it
  // are bit-identical to before, everything above shares one absolute look.
  // (Anchoring is still real-R: cracks start at the true rim, craters sit on
  // the true limb. Only the detail's own scale is clamped.)
  const dR = Math.min(R, DETAIL_R);
  ctx.save();
  if (b.type === 'asteroid') traceAsteroid(b);
  else traceSurface(b);   // cracks stop at the edge of an open crater
  ctx.clip();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);

  // Crack web: jagged fissures running INWARD from the rim (impacts fracture
  // from the surface, so chords across the middle read wrong). Geometry is
  // rebuilt each frame from the same seeded rolls — stable, never swims — and
  // shared with the ember pass below via crackPaths.
  const prog = (dmg01 - 0.04) * 14;   // hairlines from ~4% damage — wear shows early
  const cracks = prog > 0 ? crackPaths(b, R, dR, prog) : null;
  if (cracks && cracks.length) {
    ctx.strokeStyle = `rgba(0,0,0,${0.24 + 0.28 * dmg01})`;
    const cw = Math.max(0.8, dR * 0.028) * (0.7 + 0.5 * dmg01);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // TAPERED, in three passes from the rim inward. A fissure is widest where
    // the surface failed and runs out to nothing; drawn at one width the whole
    // length it reads as a stick laid across the planet — a decal — which is
    // the one part of a wounded world that still looked painted on after the
    // craters became real geometry. Three strokes, not a per-segment gradient:
    // the cost is three paths per body and the read is the same.
    for (let seg = 0; seg < 3; seg++) {
      ctx.lineWidth = cw * (1 - seg * 0.3);
      ctx.beginPath();
      for (const pts of cracks) {
        // Each pass covers a longer prefix of the crack at a thinner width, so
        // the strokes stack up near the rim and thin out toward the tip.
        const end = Math.max(1, Math.round(pts.length * (0.45 + seg * 0.275)));
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k <= end && k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      }
      ctx.stroke();
    }
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
    ctx.lineWidth = Math.max(1.5, dR * 0.055);
    glowPath(); ctx.stroke();
    ctx.strokeStyle = icy
      ? `rgba(200, 240, 255, ${0.7 * heat * breathe})`
      : `rgba(255, 205, 120, ${0.75 * heat * breathe})`;
    ctx.lineWidth = Math.max(0.8, dR * 0.02);
    glowPath(); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  // Crater surrounds. The crater ITSELF is not drawn here at all — it is cut
  // out of the body's silhouette (worldSil), so what is missing is missing and
  // the starfield shows straight through it. What is left to draw is the
  // ground around the wound: a rim of exposed interior just inside the notch
  // wall, and fracture rays running back into the surface. Both are clipped to
  // the silhouette, so they stop at the crater edge instead of hanging over it.
  if (b.scars && b.scars.length) {
    ctx.save();
    traceSurface(b);
    ctx.clip();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    for (const sc of b.scars) {
      const br = Math.max(2.2, R * 0.06 * sc.s);       // floor so pebble bites still read
      // Rocks aren't circles: sample the jag/shard silhouette at the scar's
      // local angle so the rim sits ON the edge (vertex i lives at local
      // angle i/n·TAU — same mapping as traceAsteroid/drawChunkSprite).
      let edge = 1;
      const poly = b.chunk ? b.shard : b.jag;
      if (b.type === 'asteroid' && poly) {
        let ai = sc.a % TAU; if (ai < 0) ai += TAU;
        edge = poly[Math.round((ai / TAU) * poly.length) % poly.length];
      }
      const cd = R * edge;
      const cxp = Math.cos(sc.a) * cd, cyp = Math.sin(sc.a) * cd;
      // Freshly exposed interior around the break — brighter than the weathered
      // surface, and clipped away wherever the notch actually removed material.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
      ctx.lineWidth = Math.max(0.9, br * 0.3);
      ctx.beginPath();
      ctx.arc(cxp, cyp, br * 1.02, 0, TAU);
      ctx.stroke();
      // fracture rays fanning inward from the wound
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.lineWidth = Math.max(0.8, dR * 0.022);
      ctx.beginPath();
      for (let r2 = 0; r2 < 3; r2++) {
        const ra = sc.a + Math.PI + (r2 - 1) * 0.5 + Math.sin(b.id * 3.3 + sc.t * 7.1 + r2 * 5.7) * 0.22;
        ctx.moveTo(cxp + Math.cos(ra) * br * 0.6, cyp + Math.sin(ra) * br * 0.6);
        ctx.lineTo(cxp + Math.cos(ra) * dR * (0.28 + 0.13 * r2) * sc.s,
          cyp + Math.sin(ra) * dR * (0.28 + 0.13 * r2) * sc.s);
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
function crackPaths(b, R, dR, prog) {
  const rng = mulberry32(b.id * 5077 + 7);
  const MAXC = 8;
  const out = [];
  for (let i = 0; i < MAXC; i++) {
    const a0 = rng() * TAU;
    const len = dR * (0.32 + rng() * 0.34);   // reach is absolute; the rim anchor below is real-R
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
  chunkShape(b);   // shared archetype under the bucket cut, unique above it
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
  // BROKEN VOLUME. At slab scale a shard needs interior structure or it draws
  // as a flat cut-out: one pale wedge running back from a rim face (the plane
  // the break left, catching the light) and a couple of dark fault lines
  // crossing the body. Cheap — three paths, only on pieces big enough to read
  // them, and they tumble with the rock because everything here is in its own
  // rotated frame.
  if (R > 14) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.11)';
    ctx.beginPath();
    ctx.moveTo(vx(b.facetAt) * 0.16, vy(b.facetAt) * 0.16);
    ctx.lineTo(vx(b.facetAt), vy(b.facetAt));
    ctx.lineTo(vx(b.facetAt + 1), vy(b.facetAt + 1));
    ctx.lineTo(vx(b.facetAt + 2) * 0.72, vy(b.facetAt + 2) * 0.72);
    ctx.closePath(); ctx.fill();
  }
  // dark split lines across the interior — the fractures that freed it
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = Math.max(0.8, R * 0.08);
  ctx.beginPath();
  ctx.moveTo(vx(b.crustAt) * 0.55, vy(b.crustAt) * 0.55);
  ctx.lineTo(vx(b.crustAt + Math.floor(n / 2)) * 0.85, vy(b.crustAt + Math.floor(n / 2)) * 0.85);
  if (R > 14) {
    const [f0, f1] = b.faultAt;
    ctx.moveTo(vx(f0) * 0.9, vy(f0) * 0.9);
    ctx.lineTo(vx(f1) * 0.62, vy(f1) * 0.62);
  }
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

// Approach indicator: nearing a planet (or rogue) fades in its name plate and
// a soft ring marking its domain, so you always know what you're flying into.
function drawApproach(game) {
  const s = game.ship;
  if (!s.alive) return;
  const z = game.cam.zoom;
  // Landmarks only — shoal rock never draws an approach plate, so this reads
  // the ~380-entry non-field registry instead of rejecting 15,000 rocks.
  for (const b of frameReg(game).nonField) {
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

// ---------------------------------------------------------------------------
// THE DOCK, on the world it is clamped to. A pad is a REAL OBJECT, not helper
// UI, so it obeys the object half of the visual grammar: solid strokes only, no
// dash, and its line widths are WORLD units that scale with the camera rather
// than the /zoom idiom the overlays use — it is a structure standing on a
// planet, and a structure whose girders stay 2 screen-pixels wide as you pull
// away is a HUD element pretending to be scenery.
//
// TWO COLOURS, and the second one is a FLAG, not a paint job. Every station's
// STRUCTURE is steel; a HOME PORT flies a lit spire and pennant in the lives
// ROSE (style.css #ff5c7a, the colour of the life pips) and changes in no other
// way, because a dock is the same building either way and repainting the whole
// thing said "a different kind of place" when the truth is "the same place, and
// it's yours". Reusing the lives hue rather than inventing a marker colour is
// the point: the two instruments already agree about what rose means — and they
// still mark home in it outright, which is their own grammar.
const DOCK_STEEL = '207, 228, 255';
const DOCK_HOME = '255, 92, 122';   // #ff5c7a — the life pip's own rose (style.css)

// THE STATION GROWS WITH THE SHIP. One row per beam tier (0-5), the same shape
// of table as the per-spec hull tables and read the same way — from `game.st.tier`, i.e. your
// CURRENT tier and not the tier the station was laid down at. A dock is
// infrastructure you keep improving, so tiering up refits every station you own
// rather than leaving your first pad looking like a shack forever.
//
// The progression is a silhouette, not a detail pass: a bare landing slab
// becomes a gantry, then a serviced berth, then a control block, then a proper
// port. Each row only ever ADDS, so the thing you learned to recognize at tier 0
// is still the thing in the middle at tier 5.
// `w` scales the whole structure, and it tracks WHAT IS STANDING ON THE DECK
// rather than growing for its own sake: a tier-0 pad is a narrow slab because a
// slab is all it is, and the deck widens exactly as the gantry, the blocks and
// the second clamp pair arrive to fill it. A deck sized for the top tier at
// tier 0 reads as a derelict apron with a toy in the middle of it.
// The table and the size maths live in config.js — the SHIELD DOME is a real
// collider now (physics.updateDomeShield repels rock and aliens off it), and a
// field whose drawn edge and pushing edge came from two different expressions
// would be the exact mirror-drift trap this codebase keeps warning about. One
// source, both readers.

// THE STATION IS BUILT FROM MATERIAL, NOT LIGHT. Three hull tones — near-
// opaque fills, dark to lit — carry the structure's mass; the ink colour
// (steel / home rose) is reserved for lit edges, markings, lamps and glass, so
// a home port still reads at a glance without the whole building being made of
// glow. An earlier pass drew everything as translucent ink strokes and the
// station read as a hologram parked on the world instead of a thing standing
// on it.
const HULL_DK = '11, 13, 24';    // sunk mass: caissons, undersides
const HULL_MD = '23, 28, 46';    // plating
const HULL_LT = '40, 50, 76';    // lit plating faces

// A station under construction is ASSEMBLED PIECE BY PIECE across the whole of
// CFG.DOCK_BUILD — foundations sunk, deck plates craned in one at a time,
// clamps unfolded, superstructure raised, then a commissioning pass that
// paints the markings and walks the lamps on. Each stage MOVES into place
// (slides, extends, unfolds) rather than fading in: ten seconds of opacity
// ramps reads as waiting for a bar, ten seconds of visible work reads as
// building. smoothstep, so pieces arrive with an ease-out instead of a pop.
function bstage(prog, a, b) {
  const t = clamp((prog - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// One station. `up` is the world bearing of the surface normal under it, which
// is also the bearing the ship parks along — so the pad is drawn in a frame
// where +y is DOWN into the crust and the whole sprite is authored upright.
//
// `release` (0..1) is the launch sequence swinging the clamps open; `dome` is
// the shield bubble's remaining CHARGE 0..1 (0 = don't draw it at all: not
// berthed, or the station isn't finished); `building` says the build clock is
// actually TICKING (berthed at an unfinished site) — the worksite fx gate on
// it, because an abandoned site's clock is paused.
function drawPad(game, pad, ink, home, flash, release, dome, building) {
  const p = padPos(pad);
  if (p.x < view.x0 - 500 || p.x > view.x1 + 500 ||
      p.y < view.y0 - 500 || p.y > view.y1 + 500) return;
  // Sized off the SHIP, not the world: a pad is a BERTH, and a berth is only
  // ever meaningful at the scale of the thing that parks in it. A world-scaled
  // pad would be a continent on a planet and a speck on a moonlet.
  //
  // THE ORIGIN IS WHERE THE SHIP'S CENTRE SAT WHEN THE CLAMPS BIT, which is the
  // constraint the whole sprite is composed around: the parked ship is drawn
  // ON TOP OF this point every frame, so anything put NEAR it is simply hidden.
  // The deck therefore sits BELOW the origin (down into the crust, which is
  // also what "seated" should look like) and the masts stand OUTBOARD of it, so
  // the berth frames the ship rather than fighting it. An earlier pass put a
  // beacon at the origin and it vanished under the hull.
  const T = dockTier(game.st);
  const R = dockPadR(game.st, pad.b.radius);
  const up = pad.ang + pad.b.rot;
  const prog = clamp(pad.t / CFG.DOCK_BUILD, 0, 1);
  const ready = prog >= 1;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(up + Math.PI / 2);   // +y now points down into the surface

  // WHERE THE GROUND IS, in this frame. The pad's origin is the ship's centre
  // at the moment the clamps bit, i.e. about a hull-radius ABOVE the crust, and
  // +y here runs down into it — so the surface is this far below the origin.
  // Everything that has to LOOK like it is standing on the planet (the deck's
  // pylons, the shield dome's foot) measures from here rather than from the
  // origin, which is what stops the structure floating over its own world.
  const groundY = pad.b.radius * (pad.rf - 1);

  // THE BUILD SCHEDULE — stage windows over the whole of CFG.DOCK_BUILD, in
  // construction order: sink the foundations, crane the deck in plate by
  // plate, unfold the clamps, raise the superstructure, then commission the
  // systems. Overlapping slightly so the site never goes still, and every
  // stage MOVES its piece into place (see bstage's note).
  const sFound = bstage(prog, 0.02, 0.26);
  const sDeck = bstage(prog, 0.24, 0.52);
  const sClamp = bstage(prog, 0.50, 0.68);
  const sSuper = bstage(prog, 0.66, 0.88);
  const sDish = bstage(prog, 0.84, 0.94);
  const sComm = bstage(prog, 0.90, 1.00);

  const deckY = R * 0.22;
  const deckTh = R * 0.24;               // slab thickness — depth is structure
  const baseTop = deckY, baseBot = groundY + R * 0.1;

  // FOUNDATION — a caisson RISING OUT OF THE CRUST, with splayed legs planted
  // either side and a truss bracing them. This is the visual mass of the
  // thing; without it the station is a line with sticks on it. Near-opaque
  // hull fills (see HULL_* above): material, never hologram.
  if (sFound > 0) {
    const top = lerp(baseBot, baseTop, sFound);
    ctx.fillStyle = `rgba(${HULL_DK}, 0.94)`;
    ctx.beginPath();
    ctx.moveTo(-R * 0.46, top); ctx.lineTo(R * 0.46, top);
    ctx.lineTo(R * 0.32, baseBot); ctx.lineTo(-R * 0.32, baseBot);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(${ink}, ${0.45 * sFound})`;
    ctx.lineWidth = R * 0.03;
    ctx.stroke();
    // Machinery ribs across the risen part of the block — seams, not glow.
    ctx.lineWidth = R * 0.02;
    ctx.strokeStyle = `rgba(${HULL_LT}, 0.9)`;
    for (let i = 1; i <= 3; i++) {
      const y = top + (baseBot - top) * (i / 4);
      const w = lerp(0.45, 0.33, i / 4);
      ctx.beginPath(); ctx.moveTo(-R * w, y); ctx.lineTo(R * w, y); ctx.stroke();
    }
    // A recessed service hatch on the caisson face.
    ctx.fillStyle = `rgba(${HULL_MD}, 0.95)`;
    ctx.fillRect(-R * 0.09, lerp(baseBot, baseTop + R * 0.08, sFound), R * 0.18, R * 0.1);
    ctx.strokeStyle = `rgba(${ink}, ${0.3 * sFound})`;
    ctx.lineWidth = R * 0.015;
    ctx.strokeRect(-R * 0.09, lerp(baseBot, baseTop + R * 0.08, sFound), R * 0.18, R * 0.1);
    // Splayed legs EXTENDING up from their footings as the stage runs, plus a
    // cross-brace truss once they stand — daylight under the deck with real
    // structure crossing it is most of what says "building".
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${HULL_LT}, ${0.95 * sFound})`;
    ctx.lineWidth = R * 0.055;
    for (const f of [-0.88, 0.88]) {
      const topX = f * R, topY = lerp(baseBot, deckY, sFound);
      ctx.beginPath();
      ctx.moveTo(f * R * 0.7, baseBot); ctx.lineTo(lerp(f * R * 0.7, topX, sFound), topY);
      ctx.stroke();
      // footing pad
      ctx.fillStyle = `rgba(${HULL_DK}, 0.95)`;
      ctx.fillRect(f * R * 0.7 - R * 0.06, baseBot - R * 0.02, R * 0.12, R * 0.05);
    }
    if (sFound > 0.7) {
      const bA = (sFound - 0.7) / 0.3;
      ctx.lineWidth = R * 0.028;
      ctx.strokeStyle = `rgba(${HULL_LT}, ${0.8 * bA})`;
      for (const f of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(f * R * 0.84, deckY + deckTh * 0.4);
        ctx.lineTo(f * R * 0.44, baseBot - R * 0.04);
        ctx.moveTo(f * R * 0.74, baseBot - R * 0.02);
        ctx.lineTo(f * R * 0.46, deckY + deckTh * 0.6);
        ctx.stroke();
      }
    }
  }

  // DECK — CRANED IN, PLATE BY PLATE. Five slab segments, each lowered into
  // place across its own slice of the deck stage: a solid body with thickness
  // and seams, not a stroke. The outermost segments carry the sloped end caps
  // so the finished slab keeps its trapezoid silhouette.
  const plates = 5;
  const pw = (2 * R) / plates;
  for (let i = 0; i < plates; i++) {
    // Centre-out order (2,1,3,0,4 -> plate above the caisson lands first): the
    // deck grows outward from the structure that carries it.
    const order = [2, 1, 3, 0, 4].indexOf(i);
    const pe = clamp(sDeck * (plates + 1.2) - order * 1.05, 0, 1);
    if (pe <= 0) continue;
    const e = pe * pe * (3 - 2 * pe);
    const x0 = -R + pw * i;
    const yo = -(1 - e) * R * 0.7;             // lowered in from above
    const a = 0.55 + 0.45 * e;
    ctx.fillStyle = `rgba(${HULL_MD}, ${0.96 * a})`;
    ctx.beginPath();
    if (i === 0) {
      ctx.moveTo(x0 + pw, deckY + yo); ctx.lineTo(x0 + pw, deckY + deckTh + yo);
      ctx.lineTo(x0 + R * 0.03, deckY + deckTh + yo); ctx.lineTo(x0 + R * 0.006, deckY + yo);
    } else if (i === plates - 1) {
      ctx.moveTo(x0, deckY + yo); ctx.lineTo(x0, deckY + deckTh + yo);
      ctx.lineTo(x0 + pw - R * 0.03, deckY + deckTh + yo); ctx.lineTo(x0 + pw - R * 0.006, deckY + yo);
    } else {
      ctx.rect(x0, deckY + yo, pw, deckTh);
    }
    ctx.closePath(); ctx.fill();
    // The lit working face — the top edge of THIS plate.
    ctx.strokeStyle = `rgba(${ink}, ${0.9 * a})`;
    ctx.lineWidth = R * 0.05;
    ctx.beginPath();
    ctx.moveTo(x0 + (i === 0 ? R * 0.006 : 0), deckY + yo);
    ctx.lineTo(x0 + pw - (i === plates - 1 ? R * 0.006 : 0), deckY + yo);
    ctx.stroke();
    // Seam against the previous plate, and the darker underside edge.
    ctx.strokeStyle = `rgba(${HULL_DK}, ${0.9 * a})`;
    ctx.lineWidth = R * 0.018;
    if (i > 0) { ctx.beginPath(); ctx.moveTo(x0, deckY + yo + R * 0.015); ctx.lineTo(x0, deckY + deckTh + yo); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(x0, deckY + deckTh + yo); ctx.lineTo(x0 + pw, deckY + deckTh + yo); ctx.stroke();
  }
  if (sDeck >= 1) {
    // Raised lips at each end — the slab's side silhouette — and a conduit run
    // along the deck face: the pipework detail that makes a surface read as
    // serviced rather than as a plate.
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${HULL_LT}, 0.95)`;
    ctx.lineWidth = R * 0.05;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * R, deckY); ctx.lineTo(sx * R * 0.99, deckY - R * 0.16);
      ctx.stroke();
    }
    ctx.lineWidth = R * 0.022;
    ctx.strokeStyle = `rgba(${HULL_LT}, 0.85)`;
    ctx.beginPath();
    ctx.moveTo(-R * 0.92, deckY + deckTh * 0.55);
    ctx.lineTo(R * 0.92, deckY + deckTh * 0.55);
    ctx.stroke();
    for (const f of [-0.6, -0.15, 0.35, 0.75]) {   // pipe brackets
      ctx.beginPath();
      ctx.moveTo(f * R, deckY + deckTh * 0.42); ctx.lineTo(f * R, deckY + deckTh * 0.68);
      ctx.stroke();
    }
  }
  // TOUCHDOWN MARKINGS — PAINTED ON during commissioning: the bullseye and the
  // hazard chevrons sweep in with sComm rather than fading, the one pass of
  // the build that is brushwork instead of steelwork. Framed by the parked
  // hull rather than hidden under it.
  if (sComm > 0) {
    const mA = ready ? 0.5 : 0.5 * sComm;
    ctx.lineCap = 'butt';
    ctx.lineWidth = R * 0.035;
    ctx.strokeStyle = `rgba(${ink}, ${mA})`;
    ctx.beginPath(); ctx.arc(0, deckY, R * 0.34, Math.PI * 1.08, Math.PI * (1.08 + 0.84 * sComm)); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, deckY, R * 0.2, Math.PI * 1.12, Math.PI * (1.12 + 0.76 * sComm)); ctx.stroke();
    ctx.lineWidth = R * 0.03;
    ctx.strokeStyle = `rgba(${ink}, ${0.65 * mA})`;
    const nCh = Math.round(9 * sComm);
    for (let i = -4; i < -4 + nCh; i++) {
      const x = i * R * 0.2;
      ctx.beginPath();
      ctx.moveTo(x - R * 0.05, deckY + R * 0.14); ctx.lineTo(x + R * 0.05, deckY + R * 0.05);
      ctx.stroke();
    }
  }

  // CLAMP ARMS: struts rising OUTBOARD of the berth and leaning in over it —
  // the thing that actually holds a ship down, and what makes the silhouette
  // read as a dock rather than as a platform. THE BUILD UNFOLDS THEM from flat
  // on the deck up over the berth (`sClamp`), and THE LAUNCH SWINGS THEM OPEN
  // (`release`) — the same joints working in both directions, which is what
  // makes them read as one mechanism.
  // THE DECK IS DIVIDED INTO ZONES and every tier's additions stay in theirs,
  // so a port that grows never turns into a pile: the CENTRE is the berth (the
  // ship is drawn there), the clamps are INBOARD of it, the gantry is the LEFT
  // outboard end and the control blocks are the RIGHT one. Everything lives
  // inside +/-1.0R, which is what lets the rings below enclose the structure at
  // every tier instead of slicing through it.
  ctx.lineCap = 'round';
  if (sClamp > 0) {
    for (let i = 0; i < T.pairs; i++) {
      const base = 0.5 + i * 0.22;                     // outer pairs step outward
      const h = 0.62 - i * 0.13;
      const armW = R * (0.1 - i * 0.018);
      for (const sx of [-1, 1]) {
        // Three poses, one path: STOWED flat on the deck -> CLOSED leaning in
        // over the berth (the build, sClamp) -> OPEN thrown wide (the launch,
        // release).
        const cTipX = sx * R * base * 0.72, cTipY = -R * h;
        const oTipX = sx * R * base * 1.75, oTipY = -R * h * 0.3;
        const sTipX = sx * R * (base + 0.3), sTipY = deckY - R * 0.05;
        let tipX = lerp(sTipX, cTipX, sClamp), tipY = lerp(sTipY, cTipY, sClamp);
        const cKx = sx * R * base * 1.12, cKy = -R * h * 0.55;
        let kx = lerp(sx * R * (base + 0.16), cKx, sClamp);
        let ky = lerp(deckY - R * 0.03, cKy, sClamp);
        if (release > 0) {
          tipX = lerp(cTipX, oTipX, release); tipY = lerp(cTipY, oTipY, release);
          kx = cKx; ky = cKy;
        }
        // Hydraulic ram from the deck to the elbow — the thin member offset
        // behind the arm that says these joints are DRIVEN.
        ctx.strokeStyle = `rgba(${HULL_LT}, ${0.9 * sClamp})`;
        ctx.lineWidth = armW * 0.45;
        ctx.beginPath();
        ctx.moveTo(sx * R * (base + 0.14), deckY);
        ctx.lineTo(kx, ky);
        ctx.stroke();
        // The arm itself, in ink — it is the working face of the whole machine.
        ctx.strokeStyle = `rgba(${ink}, ${0.85 * sClamp})`;
        ctx.lineWidth = armW;
        ctx.beginPath();
        ctx.moveTo(sx * R * base, deckY);
        ctx.lineTo(kx, ky);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        // A turret base plate, a JOINT at the elbow and a GRIP PAD at the tip —
        // an arm that is just a bent line is a stick; the nodes are what make
        // it read as a mechanism that could actually hold something down.
        ctx.fillStyle = `rgba(${HULL_MD}, ${0.96 * sClamp})`;
        ctx.beginPath();
        ctx.moveTo(sx * R * base - R * 0.09, deckY);
        ctx.lineTo(sx * R * base + R * 0.09, deckY);
        ctx.lineTo(sx * R * base + R * 0.06, deckY - R * 0.07);
        ctx.lineTo(sx * R * base - R * 0.06, deckY - R * 0.07);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = `rgba(${ink}, ${0.9 * sClamp})`;
        ctx.beginPath(); ctx.arc(kx, ky, R * 0.055, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(sx * R * base, deckY - R * 0.03, R * 0.045, 0, TAU); ctx.fill();
        ctx.save();
        ctx.translate(tipX, tipY);
        ctx.rotate(Math.atan2(tipY - ky, tipX - kx));
        ctx.fillRect(-R * 0.03, -R * 0.09, R * 0.06, R * 0.18);
        ctx.restore();
      }
    }
  }

  // GANTRY MAST + SERVICE BOOM — the left outboard end. The mast TELESCOPES up
  // out of the deck across its slice of the superstructure stage: a truss (two
  // rails and a zigzag web), not a stick, because an open frame is what a
  // gantry IS and the daylight through it is free depth.
  const mastUp = T.mast ? sSuper : 0;
  const mx = -R * 0.9;
  const mt = deckY - R * T.mast * mastUp;
  if (mastUp > 0) {
    const ra = R * 0.045;                             // rail half-spacing
    ctx.strokeStyle = `rgba(${HULL_LT}, ${0.95 * mastUp})`;
    ctx.lineWidth = R * 0.035;
    ctx.beginPath();
    ctx.moveTo(mx - ra, deckY); ctx.lineTo(mx - ra, mt);
    ctx.moveTo(mx + ra, deckY); ctx.lineTo(mx + ra, mt);
    ctx.stroke();
    ctx.lineWidth = R * 0.022;
    const segs = Math.max(2, Math.round(5 * mastUp));
    ctx.beginPath();
    for (let i = 0; i < segs; i++) {
      const y0 = deckY + (mt - deckY) * (i / segs);
      const y1 = deckY + (mt - deckY) * ((i + 1) / segs);
      ctx.moveTo(mx - ra, y0); ctx.lineTo(mx + ra, y1);
    }
    ctx.stroke();
    // Mast head block.
    ctx.fillStyle = `rgba(${HULL_MD}, ${0.96 * mastUp})`;
    ctx.fillRect(mx - R * 0.07, mt - R * 0.05, R * 0.14, R * 0.08);
    ctx.strokeStyle = `rgba(${ink}, ${0.5 * mastUp})`;
    ctx.lineWidth = R * 0.018;
    ctx.strokeRect(mx - R * 0.07, mt - R * 0.05, R * 0.14, R * 0.08);
    // A SERVICE BOOM reaches back over the berth from the mast head — the piece
    // that makes a gantry look like it is doing something to the ship. It
    // withdraws with the clamps on a launch.
    ctx.strokeStyle = `rgba(${ink}, ${0.7 * mastUp})`;
    ctx.lineWidth = R * 0.045;
    ctx.beginPath();
    ctx.moveTo(mx, mt + R * 0.02);
    ctx.lineTo(mx + R * lerp(0.5, 0.14, release) * mastUp, mt + R * 0.12);
    ctx.stroke();
    // FUEL TANKS at the mast's foot from tier 2 up — two squat cylinders with
    // end caps, strapped down outboard. Plumbing, not glow: a working port
    // stores something.
    if (T.pairs > 1) {
      for (let i = 0; i < 2; i++) {
        const tx = mx + R * (0.16 + i * 0.2), tw = R * 0.16, th2 = R * 0.1;
        const ty = deckY - th2;
        ctx.fillStyle = `rgba(${HULL_MD}, ${0.96 * mastUp})`;
        ctx.beginPath();
        ctx.moveTo(tx + th2 * 0.5, ty);
        ctx.lineTo(tx + tw - th2 * 0.5, ty);
        ctx.arc(tx + tw - th2 * 0.5, ty + th2 * 0.5, th2 * 0.5, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(tx + th2 * 0.5, ty + th2);
        ctx.arc(tx + th2 * 0.5, ty + th2 * 0.5, th2 * 0.5, Math.PI / 2, -Math.PI / 2);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = `rgba(${HULL_LT}, ${0.9 * mastUp})`;
        ctx.lineWidth = R * 0.02;
        ctx.stroke();
        // strap
        ctx.beginPath();
        ctx.moveTo(tx + tw * 0.5, ty - R * 0.008); ctx.lineTo(tx + tw * 0.5, ty + th2 + R * 0.008);
        ctx.stroke();
      }
    }
  }
  // CONTROL BLOCKS — the right outboard end, LOWERED INTO PLACE one after the
  // other. Solid cabins with a roof lip and an aerial; the lit windows are the
  // one thing on this structure that says CREWED, so they only come on with
  // the station.
  if (T.tower && sSuper > 0) {
    for (let i = 0; i < T.tower; i++) {
      const be = clamp(sSuper * (T.tower + 0.6) - i * 0.9, 0, 1);
      if (be <= 0) continue;
      const e = be * be * (3 - 2 * be);
      const bx = R * (0.52 + i * 0.26), by = deckY;
      const bw = R * 0.22, bh = R * (0.4 + i * 0.18);
      const yo = -(1 - e) * R * 0.5;
      ctx.fillStyle = `rgba(${HULL_MD}, ${0.96 * (0.6 + 0.4 * e)})`;
      ctx.fillRect(bx, by - bh + yo, bw, bh);
      ctx.strokeStyle = `rgba(${HULL_LT}, ${0.95 * e})`;
      ctx.lineWidth = R * 0.025;
      ctx.strokeRect(bx, by - bh + yo, bw, bh);
      // roof lip + aerial on the taller block
      ctx.strokeStyle = `rgba(${ink}, ${0.6 * e})`;
      ctx.lineWidth = R * 0.03;
      ctx.beginPath();
      ctx.moveTo(bx - R * 0.015, by - bh + yo); ctx.lineTo(bx + bw + R * 0.015, by - bh + yo);
      ctx.stroke();
      if (i === T.tower - 1) {
        ctx.lineWidth = R * 0.018;
        ctx.beginPath();
        ctx.moveTo(bx + bw * 0.75, by - bh + yo);
        ctx.lineTo(bx + bw * 0.75, by - bh + yo - R * 0.14);
        ctx.stroke();
      }
      // windows: glass slots, dark until the station is live
      ctx.fillStyle = ready ? `rgba(${ink}, 0.85)` : `rgba(${HULL_DK}, 0.9)`;
      for (let w = 0; w < 2; w++) {
        ctx.fillRect(bx + bw * 0.24, by - bh + yo + R * (0.08 + w * 0.14), bw * 0.22, R * 0.06);
      }
    }
  }
  // COMMS DISH, on the mast head — UNFOLDING across its own late slice.
  if (T.dish && sDish > 0) {
    ctx.strokeStyle = `rgba(${ink}, ${0.8 * sDish})`;
    ctx.lineWidth = R * 0.04;
    const span = 0.38 * sDish;                        // the bowl opens as it deploys
    ctx.beginPath();
    ctx.arc(mx, mt - R * 0.15, R * 0.17, Math.PI * (0.5 - span), Math.PI * (0.5 + span), true);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mx, mt); ctx.lineTo(mx, mt - R * 0.15); ctx.stroke();
    // feed horn
    ctx.lineWidth = R * 0.02;
    ctx.beginPath(); ctx.moveTo(mx, mt - R * 0.15); ctx.lineTo(mx, mt - R * 0.26); ctx.stroke();
  }

  // BEACONS: lamps along the deck edge, clear of where the hull sits. STEADY
  // once the station is live, never blinking — the calm rule the ship's own
  // shield rim obeys. The COMMISSIONING WALKS THEM ON one by one across the
  // last stage of the build (part of the build event, which is allowed to
  // move); from then on they hold. They are dark housings until their moment,
  // which is the single clearest read of "is this thing finished".
  // SMALL AND CRISP — a bright core with a tight halo. An earlier pass used wide
  // soft blooms and they washed out the whole structure they were meant to be
  // lighting: at close zoom the pad was two glowing blobs with some sticks
  // between them. A runway light is a POINT.
  ctx.lineCap = 'butt';
  if (sDeck > 0.8) {
    for (let i = 0; i < T.lights; i++) {
      const f = T.lights === 1 ? 0 : (i / (T.lights - 1)) * 2 - 1;   // -1..1 across the deck
      const lx = f * R * 0.88, ly = deckY - R * 0.06;
      const on = ready ? 1 : clamp(sComm * (T.lights + 0.5) - i, 0, 1);
      // The housing exists as soon as the deck does; the light is earned later.
      ctx.fillStyle = on > 0.3 ? `rgba(${ink}, ${0.6 + 0.35 * on})` : `rgba(${HULL_LT}, 0.95)`;
      ctx.beginPath(); ctx.arc(lx, ly, R * 0.05, 0, TAU); ctx.fill();
      if (on > 0.3) {
        ctx.globalCompositeOperation = 'lighter';
        const rr = R * 0.2;
        const lamp = ctx.createRadialGradient(lx, ly, 0, lx, ly, rr);
        // NOT modulated by `home`. The deck lamps used to burn 40% hotter at a
        // home port, which was compensation for the rose `ink`'s luminance back
        // when the whole building was recoloured. With the structure always
        // steel that is simply "the rest of the building changes when it's
        // home" — the thing the flag rule exists to forbid. `home` now has
        // exactly ONE reader on this pad: the flag block further down.
        lamp.addColorStop(0, `rgba(${ink}, ${0.5 * on})`);
        lamp.addColorStop(1, `rgba(${ink}, 0)`);
        ctx.fillStyle = lamp;
        ctx.beginPath(); ctx.arc(lx, ly, rr, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // THE BUILD IS A WORKSITE, NOT A LOADING SCREEN. Two layers say "work is
  // happening HERE, on THIS piece" for the whole of DOCK_BUILD:
  //   - a constructor drone hovering at the active stage's anchor (bobbing on
  //     game.time — the build is an event, so motion is sanctioned), and
  //   - weld glints where it is working: brief bright points flickering on the
  //     seam being joined. 'lighter' pass, tiny, reset after.
  // The solid progress arc is drawn FIRST, under them — the same helper-UI
  // idiom as the winch and the shotgun charge ring, and still the honest clock.
  //
  // GATED ON `building`, NOT on `!ready`: the build clock only ticks while
  // BERTHED (leaving pauses it), and an unfinished site persists in game.docks
  // — so a site abandoned at 40% must stand still, showing the arc and the
  // dark lamp housings, not a drone welding seams that are making no progress.
  // A paused build is not an event, and sparks over a stopped clock lie.
  if (!ready) {
    // The progress arc — the honest clock, closing over the berth. Drawn for
    // every unfinished site, working or paused.
    ctx.strokeStyle = `rgba(${ink}, 0.30)`;
    ctx.lineWidth = R * 0.06;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.2, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(${ink}, 0.95)`;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.2, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
    ctx.stroke();
  }
  if (building && !ready) {
    // Where the work is right now, in build order.
    let ax, ay;
    if (prog < 0.26) { ax = Math.sin(game.time * 1.7) * R * 0.5; ay = lerp(baseBot, deckY, sFound); }
    else if (prog < 0.52) {
      const idx = [2, 1, 3, 0, 4][Math.min(4, Math.floor(sDeck * 5))];
      ax = -R + pw * (idx + 0.5); ay = deckY;
    } else if (prog < 0.68) {
      const sx = Math.floor(game.time * 1.3) % 2 === 0 ? -1 : 1;
      ax = sx * R * 0.56; ay = deckY - R * 0.35 * sClamp;
    } else if (prog < 0.9) { ax = T.mast ? mx : R * 0.6; ay = T.mast ? mt : deckY - R * 0.3; }
    else { ax = Math.sin(game.time * 2.2) * R * 0.34; ay = deckY; }

    // The drone: a wedge of hull metal with a work light, riding a slow bob.
    const bob = Math.sin(game.time * 3.1) * R * 0.05;
    const dx2 = ax + Math.cos(game.time * 0.9) * R * 0.12;
    const dy2 = ay - R * 0.34 + bob;
    ctx.fillStyle = `rgba(${HULL_LT}, 0.95)`;
    ctx.beginPath();
    ctx.moveTo(dx2 - R * 0.055, dy2);
    ctx.lineTo(dx2 + R * 0.055, dy2);
    ctx.lineTo(dx2, dy2 + R * 0.07);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = `rgba(${ink}, 0.9)`;
    ctx.beginPath(); ctx.arc(dx2, dy2 + R * 0.02, R * 0.02, 0, TAU); ctx.fill();

    // Weld glints between drone and seam. Flicker off game.time; strictly an
    // event effect, gone the frame the station is live.
    const wk = Math.sin(game.time * 31) * Math.sin(game.time * 17.3);
    if (wk > -0.4) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(ax, ay, 0, ax, ay, R * 0.14);
      g.addColorStop(0, `rgba(255, 240, 200, ${0.55 + 0.35 * wk})`);
      g.addColorStop(1, 'rgba(255, 240, 200, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ax, ay, R * 0.14, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(255, 246, 220, ${0.8 + 0.2 * wk})`;
      ctx.lineWidth = R * 0.016;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = game.time * 13 + i * 2.1;
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + Math.cos(a) * R * 0.07, ay + Math.sin(a) * R * 0.07);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // A HOME PORT FLIES A BEACON, not a ring. It used to wear a full circle and
  // that was a mistake twice over: it sat concentric-ish with the shield dome
  // and the two read as a lens of overlapping circles rather than as a mark on
  // a structure, and a ring says nothing about WHAT a home port is. A lit spire
  // does — it is the thing you can see from orbit, it caps the gantry at the
  // tiers that have one, and it competes with nothing.
  // A HOME PORT IS A FLAG ON AN ORDINARY STATION (user call, 2026-08: "the only
  // part of it that should change is a flag shows up and it's a red flag, the
  // colour of the rest of it should not change"). The structure keeps its steel
  // at every station, home or not — a dock is the same building either way, and
  // repainting the whole thing said "different kind of place" when the truth is
  // "same place, and it's yours". So the ROSE lives entirely in this block: the
  // mast, the pennant and its glow, and nothing else on the pad ever reads it.
  // (The two INSTRUMENTS still mark home in rose — that is their own grammar,
  // where a colour is all a two-pixel blip has to work with.)
  if (home && ready) {
    const hx = T.mast ? mx : -R * 0.9;
    const hy = T.mast ? mt : deckY;
    const tip = hy - R * (T.mast ? 0.3 : 0.62);
    ctx.strokeStyle = `rgba(${DOCK_HOME}, 0.95)`;
    ctx.lineWidth = R * 0.05;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx, tip); ctx.stroke();
    // The pennant, so the mark has a SHAPE and not just a colour.
    ctx.fillStyle = `rgba(${DOCK_HOME}, 0.9)`;
    ctx.beginPath();
    ctx.moveTo(hx, tip); ctx.lineTo(hx + R * 0.34, tip + R * 0.11);
    ctx.lineTo(hx, tip + R * 0.22);
    ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    const bg = ctx.createRadialGradient(hx, tip, 0, hx, tip, R * 0.55);
    bg.addColorStop(0, `rgba(${DOCK_HOME}, 0.85)`);
    bg.addColorStop(1, `rgba(${DOCK_HOME}, 0)`);
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(hx, tip, R * 0.55, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // THE SHIELD DOME. Up only while the ship is berthed at a FINISHED station —
  // it is the thing the ten-second build bought, and it is what makes the berth
  // read as safe rather than merely occupied.
  //
  // IT STANDS ON THE GROUND, and getting that right is the whole job. Centred
  // on the SURFACE POINT under the pad (groundY), not on the pad origin, and
  // CLIPPED against the planet's own disc — so its foot follows the world's
  // curvature instead of cutting a straight chord across it. A dome sized in
  // pad units alone is fine on a big planet and wider than the whole body on a
  // moonlet; clipping is what makes one expression correct at both. (On a
  // crystal or heavily cratered world the true surface is not the mean disc, so
  // the foot can sit a hull-radius off the real ground — the pad's own rf is
  // measured from where the ship actually sat, which keeps that within a hull.)
  //
  // Calm and steady, exactly like the ship's own shield rim: no dashes, no idle
  // motion, because a protective field that pulses reads as an alarm. The
  // detail is STRUCTURE — ribs, bands, emitter nodes — never animation.
  if (dome > 0) {
    // THE DOME SHOWS WHAT IT HAS LEFT. Its charge is finite and never refills
    // (CFG.DOCK_SHIELD), so a field down to its last fifth must not look like a
    // fresh one — but the way to say that is INTENSITY, not motion and not
    // size. The geometry stays exactly dockDomeR because that is the real
    // collider (physics.updateDomeShield pushes off it): a dome drawn smaller
    // than it pushes would be the mirror-drift trap in visual form. So the
    // field simply gets thinner and dimmer as it is spent, keeping its calm.
    // Floored well above zero so the last of it still reads as a shield rather
    // than as a hairline that has already failed.
    //
    // The ramp is a POWER, not linear, so the eye leads the alarm: on a linear
    // ramp CFG.DOCK_SHIELD_WARN (0.2) still looked about half strength while the
    // cockpit bar was already red, and a warning the field contradicts is worse
    // than no warning. At 1.5 the warn line lands near a third — visibly spent.
    const chg = 0.3 + 0.7 * Math.pow(dome, 1.5);
    const Rc = pad.b.radius * pad.rf;            // body centre, in this frame
    // config.dockDomeR — the SAME expression physics.updateDomeShield pushes
    // things off. See the note on the table: drawn edge and pushing edge must
    // never be two expressions.
    const dr = dockDomeR(game.st, pad.b.radius, groundY);
    const box = dr * 2;
    ctx.save();
    // Clip to everything OUTSIDE the world: rect minus the planet disc.
    ctx.beginPath();
    ctx.rect(-box, groundY - box, box * 2, box * 2);
    ctx.arc(0, Rc, pad.b.radius, 0, TAU, true);
    ctx.clip();

    ctx.globalCompositeOperation = 'lighter';
    const g2 = ctx.createRadialGradient(0, groundY, dr * 0.2, 0, groundY, dr);
    g2.addColorStop(0, `rgba(110, 200, 255, ${0.015 * chg})`);
    g2.addColorStop(0.7, `rgba(120, 210, 255, ${0.06 * chg})`);
    g2.addColorStop(0.93, `rgba(150, 226, 255, ${0.16 * chg})`);
    g2.addColorStop(1, `rgba(190, 240, 255, ${0.30 * chg})`);
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(0, groundY, dr, 0, TAU); ctx.fill();
    // RIBS + BANDS: the field is panelled, which is what makes it read as
    // engineered rather than as a blur. Static geometry, never motion.
    ctx.strokeStyle = `rgba(168, 232, 255, ${0.13 * chg})`;
    ctx.lineWidth = R * 0.022;
    for (let i = 1; i < 6; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(Math.cos(a) * dr, groundY + Math.sin(a) * dr);
      ctx.stroke();
    }
    for (const f of [0.45, 0.75]) {
      ctx.beginPath(); ctx.arc(0, groundY, dr * f, Math.PI, TAU); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    // The rim: a hard bright edge over a softer inner line, so the field has a
    // definite SURFACE. A single hairline reads as a drawn circle; two weights
    // read as something with thickness that light is catching. The OUTER weight
    // is what thins as the charge goes — the surface stays, it just has less
    // behind it.
    ctx.strokeStyle = `rgba(120, 200, 240, ${0.3 * chg})`;
    ctx.lineWidth = R * 0.1 * chg;
    ctx.beginPath(); ctx.arc(0, groundY, dr * 0.985, 0, TAU); ctx.stroke();
    // The bright edge keeps its OWN floor rather than riding `chg`. Both the
    // alpha and the outer weight thinning together left a near-empty dome
    // resting on one 0.27-alpha hairline, which is fine over black sky and
    // marginal over a lava world's lit limb — and this stroke is the SURFACE.
    // The surface stays; what thins is everything behind it.
    ctx.strokeStyle = `rgba(206, 245, 255, ${0.45 + 0.45 * dome})`;
    ctx.lineWidth = R * 0.035;
    ctx.beginPath(); ctx.arc(0, groundY, dr, 0, TAU); ctx.stroke();
    // THE BITE. Where the field just threw something off, it flares — an EVENT,
    // which is the one thing this otherwise-calm surface is allowed to animate
    // for. Without it the dome silently deflects and the push reads as rocks
    // behaving oddly rather than as the shield doing its job.
    if ((game.domeHitT || 0) > 0) {
      const k = clamp(game.domeHitT / 0.3, 0, 1);
      const a = (game.domeHitA || 0) - up - Math.PI / 2;   // world bearing -> pad frame
      ctx.globalCompositeOperation = 'lighter';
      // SCALED BY THE CHARGE, and this one matters most: the bite is the only
      // in-world signal that the pool is draining, so a nearly-spent dome
      // flaring exactly as bright as a fresh one reads backwards — the field
      // looking healthiest at the moment it is being finished off.
      ctx.strokeStyle = `rgba(220, 248, 255, ${0.75 * k * chg})`;
      ctx.lineWidth = R * 0.09 * k;
      ctx.beginPath();
      ctx.arc(0, groundY, dr, a - 0.5 * (1 - k) - 0.18, a + 0.5 * (1 - k) + 0.18);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    // EMITTER POSTS: the dome has to come FROM something, so the field's feet
    // are short lit posts on the deck where the arc lands. Outside the clip —
    // they are hardware standing on the pad, not part of the field. Kept small
    // and cool: an earlier pass had them as wide hot blooms that washed out the
    // whole structure they were supposed to be standing on.
    for (const sx of [-1, 1]) {
      const ex = sx * R * 0.94;
      ctx.strokeStyle = 'rgba(178, 236, 255, 0.85)';
      ctx.lineWidth = R * 0.05;
      ctx.beginPath();
      ctx.moveTo(ex, deckY); ctx.lineTo(ex, deckY - R * 0.26);
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      const eg = ctx.createRadialGradient(ex, deckY - R * 0.26, 0, ex, deckY - R * 0.26, R * 0.2);
      eg.addColorStop(0, 'rgba(206, 245, 255, 0.55)');
      eg.addColorStop(1, 'rgba(206, 245, 255, 0)');
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(ex, deckY - R * 0.26, R * 0.2, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // THE CLAMPS BITING / THE STATION GOING LIVE — a one-shot bloom, which is an
  // EVENT and therefore the one place this structure is allowed to move.
  if (flash > 0) {
    const k = 1 - flash / 0.9;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(${ink}, ${0.6 * (1 - k)})`;
    ctx.lineWidth = R * 0.16 * (1 - k);
    ctx.beginPath(); ctx.arc(0, 0, R * (0.4 + 2.4 * k), 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

// Every station standing this run. At most CFG.DOCK_MAX of them and each is
// off-screen-culled inside drawPad, so this is a walk of a handful.
function drawDocks(game) {
  const docks = game.docks;
  if (!docks || !docks.length) return;
  const flash = game.dockFlashT || 0;
  const L = game.launch;
  // The release eases over the sequence's FIRST act (LAUNCH_HOLD): the clamps
  // are wide open before the engine lights, which is the order the sequence
  // has to happen in for it to read as machinery rather than as an effect.
  const release = L ? clamp(L.t / CFG.LAUNCH_HOLD, 0, 1) : 0;
  for (const d of docks) {
    if (!d.b.alive) continue;
    const berthed = game.dock === d;
    // ALWAYS STEEL. A home port is not a differently-coloured building, it is
    // an ordinary station flying a rose flag (see drawPad's home block).
    drawPad(game, d, DOCK_STEEL, game.home === d,
      berthed ? flash : 0,
      berthed ? release : 0,
      // The dome is up only at a FINISHED station you are berthed at, and it is
      // drawn at whatever charge is left in it (config.CFG.DOCK_SHIELD).
      // `dockReady`, never an inline `t >= DOCK_BUILD`: that predicate is what
      // the dome's PUSH, its draw and its cockpit gauge all key off, and a
      // private copy in each is the mirror-drift trap that put dockDomeR in
      // config.js in the first place.
      berthed && dockReady(d)
        ? clamp((d.hp ?? CFG.DOCK_SHIELD) / CFG.DOCK_SHIELD, 0, 1) : 0,
      berthed && !dockReady(d));
  }
}

// ---- THE APPROACH. A landing that silently declines to latch is this
// feature's worst failure mode: the player is doing something reasonable, the
// game is refusing, and nothing says why. So while the hull is on a dockable
// world, the berth shows its state right where the player is looking — a solid
// arc filling as the latch takes, and the name of the gate that is refusing.
//
// Helper UI, so it is drawn in SCREEN-CONSTANT widths (the /zoom idiom) unlike
// the station itself, which is a real structure. Suppressed the moment the
// berth takes: from then on the pad's own art is the readout.
function drawDockGuide(game) {
  const s = game.ship;
  if (!s.alive || game.dock) return;
  // AUTOLAND shows its hand: while a pad is flying the ship in, the guide runs
  // even before contact — a dashed approach line to the pad (helper/aiming UI,
  // so dashes are the correct grammar) plus the ring naming who has the helm.
  // A ship that starts steering itself with nothing on screen saying so reads
  // as a stuck control, not a feature.
  const auto = game.autoland && !game.dockCand ? game.autoland : null;
  if (!auto && !game.dockCand) return;
  const z = Math.max(game.cam.zoom, 0.25);
  const f = clamp(game.dockT || 0, 0, 1);
  const rr = s.radius * 2.6 + 10 / z;
  const gate = game.dockGate;
  const col = gate ? '255, 190, 120' : '150, 230, 255';   // amber = refusing, cyan = taking

  ctx.save();
  if (auto) {
    const p = padPos(auto);
    ctx.strokeStyle = `rgba(${col}, 0.5)`;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([7 / z, 6 / z]);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(${col}, 0.22)`;
  ctx.lineWidth = 2.5 / z;
  ctx.beginPath(); ctx.arc(s.x, s.y, rr, 0, TAU); ctx.stroke();
  if (f > 0) {
    ctx.strokeStyle = `rgba(${col}, 0.95)`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, rr, -Math.PI / 2, -Math.PI / 2 + TAU * f);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  // One short line, above the ship so the hull never sits on it. The wording is
  // an INSTRUCTION, not a diagnosis — "LEVEL OFF" tells you what to do; "bad
  // attitude" tells you what you did. 'crater' is the one no flying fixes, so
  // its instruction is to MOVE.
  const label = gate === 'small' ? 'NO ANCHORAGE — WORLD TOO SMALL FOR THIS CLASS'
    : gate === 'crater' ? 'CRATERED GROUND — FIND CLEAR SURFACE'
    // 'rubble': the station that stood here collapsed under the ship and the
    // hull never left the ground (physics.removeDock's eviction). No flying
    // fixes it either — the instruction is to LIFT, which is also the whole
    // condition for clearing it.
    : gate === 'rubble' ? 'STATION LOST — LIFT CLEAR TO REBUILD'
    : gate === 'level' ? 'LEVEL OFF — ROCKETS DOWN'
    : gate === 'fast' ? 'TOO FAST — SETTLE'
    : auto ? 'AUTOLAND — PAD HAS THE HELM'
    : 'DOCKING';
  const fs = 11 / z;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = `rgba(${col}, ${gate ? 0.9 : auto ? 0.85 : 0.5 + 0.5 * f})`;
  ctx.fillText(label, s.x, s.y - rr - fs * 0.7);
  ctx.textAlign = 'left';
  ctx.restore();
}

// DEFLECTOR PARRY: every frozen rock charges up. Aiming/helper UI, so DASHED
// strokes are correct here (design law): a charge ring contracting onto each
// rock over the window, and an aim arrow per rock showing where the volley
// is about to go. The energy glow itself is a solid additive gradient (event
// motion — the parry IS an event, so animation is allowed).
function drawParry(game) {
  const p = game.parry;
  if (!p || !p.rocks.length) return;
  const z = game.cam.zoom, s = game.ship;
  const prog = Math.min(1, p.t / Math.max(0.01, p.window));
  // Every rock launches along ship→cursor when the window closes — MIRROR
  // physics.updateParry, degenerate-cursor fallback included, or the arrow
  // promises a throw the sim won't make.
  const ax = game.aim.x - s.x, ay = game.aim.y - s.y;
  const am = Math.hypot(ax, ay);
  const aimed = am > 1;
  const adx = aimed ? ax / am : 0, ady = aimed ? ay / am : 0;

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

    // Aim arrow: where the volley goes when the window closes. The launch is
    // on the clock now, so the arrow LENGTHENS AND BRIGHTENS with the charge
    // — reaching full is the countdown, and there is no threshold to hunt.
    const dx = aimed ? adx : r.nx, dy = aimed ? ady : r.ny;
    const len = b.radius + 34 / z + prog * 30 / z;
    const tipX = b.x + dx * len, tipY = b.y + dy * len;
    ctx.strokeStyle = `rgba(159, 214, 255, ${0.45 + 0.5 * prog})`;
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
  // "Field armed" is physics.parryLive — rank, not berthed, not reloading. A
  // BERTHED field catches nothing (updateParry stands it down), and a circlet
  // saying "you can take this one" over a rock that then sails through the nose
  // reads as a broken ability, not a docked one.
  if (!parryLive(game) || !s.alive) return;
  if (game.parry && game.parry.rocks.length >= st.deflect) return;   // no free slot
  const z = game.cam.zoom;
  const pulse = 0.55 + 0.45 * Math.sin(game.time * 9);
  const RANGE = 520;
  // Awake list: RANGE is 520u, well inside the wake bubble.
  for (const b of (game.bodies._awake || game.bodies)) {
    const dx = b.x - s.x, dy = b.y - s.y;
    if (dx * dx + dy * dy > RANGE * RANGE) continue;
    if (!b.alive || b.type !== 'asteroid' || b.majorComet || b.heldBy || b.parryFrozen ||
        (b.thrownBy === 'player' && b.thrownTimer > 0) || b.mass > st.capacity * 1.5) continue;
    const d = Math.hypot(dx, dy) || 0.001;
    const nx = dx / d, ny = dy / d;
    if (-((b.vx - s.vx) * nx + (b.vy - s.vy) * ny) <= 60) continue;         // not incoming
    if (Math.abs(angDiff(Math.atan2(dy, dx), s.angle)) > PARRY_ARC) continue;   // not in the front arc
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
  if (game.st.hasCompass && mag > game.st.compassFloor) {
    // log scale: ~1.2 (barely felt) -> ~200 (deep well) saturates. The FLOOR
    // above is the ranked one (1.2 down to 0.6) — a ranked compass keeps
    // pointing at pulls an unranked one reads as nothing at all.
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

// ---- the tractor beam -------------------------------------------------------
//
// THE BEAM IS THE VERB. It is on screen for most of the game and it carries two
// live readouts, so it is drawn as a real emitter rather than a line:
//
//   GRIP (0..1) is the spool-up made visible (CFG.TRACTOR_HEFT / TRACTOR_SPOOL,
//   applied in tractor.springHeld/beamGrip). A beam that has just closed on a
//   heavy load runs thin, dim and unsteady and settles as the emitters take
//   hold — the wind-up governs the THROW too, so this is the player's only
//   sight of how hard the next fling will leave.
//
//   HEAVY (the moon/world rungs) splits the beam into three braided strands
//   that bow apart and converge on the load, with a brighter anchor bloom where
//   it bites. A pebble gets one clean strand. The difference is the point: the
//   sky should look like it is being fought, not clicked.
//
// Canvas discipline: additive passes are opened and closed here, `globalAlpha`
// is left at 1, and every width is divided by the zoom so the beam reads the
// same at tier 0 and tier 5. Solid strokes only — dashes are reserved for
// helper/aiming UI (design law), and the beam is a thing in the world.
const hexA = (a) => Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');

// THE BEAM GRIPS THE SIDES OF A BODY, NEVER ITS MIDDLE (user design rule). A
// strand that converges on the CENTRE reads as passing straight through the
// rock — and on a moon or a world, whose disc is most of the screen, it buries
// the whole effect under the sprite where none of it can be seen. So every
// strand lands on the RIM, spread either side of the bearing that faces the
// ship, and the glow lives at those contact points. `spread` is the half-angle
// of the grip; a bigger load is taken in a wider embrace.
// Returns world-space contact points, outermost first.
function gripPoints(game, fromX, fromY, obj, n, spread) {
  const base = Math.atan2(fromY - obj.y, fromX - obj.x);   // the bearing facing the ship
  const pts = [];
  for (let i = 0; i < n; i++) {
    // -1..1 across the spread, skipping dead centre on even counts — the point
    // is to take it by the sides.
    const t = n === 1 ? 0.6 : (i / (n - 1)) * 2 - 1;
    const a = base + t * spread + Math.sin(game.time * 0.8 + i * 1.9) * 0.05;
    pts.push({ x: obj.x + Math.cos(a) * obj.radius * 0.97,
               y: obj.y + Math.sin(a) * obj.radius * 0.97, a });
  }
  return { pts, base, spread };
}

function drawBeam(game, fromX, fromY, obj, color, grip = 1, heavy = 0, bite = true, widthMul = 1) {
  const g = clamp(grip, 0.15, 1);
  const z = Math.max(game.cam.zoom, 0.4);
  // A struggling emitter flutters; a settled one hums. Same breath either way,
  // faster and deeper the less grip there is.
  const pulse = 1 + Math.sin(game.time * (16 + 26 * (1 - g))) * (0.18 + 0.4 * (1 - g));
  // widthMul fattens every stroke together (envelope and strands both derive
  // from w) — the ram's per-stone rigs use it, drawn small enough that the
  // standard gauge read as thread at gameplay zoom.
  const w = (1.4 + 2.1 * g) * pulse * widthMul / z;
  const n = heavy > 0 ? 4 : 2;
  const { pts, base, spread } = gripPoints(game, fromX, fromY, obj, n, 0.5 + 0.75 * heavy);
  // The axis runs to the NEAR RIM, not the centre — everything that travels
  // down the beam stops where the beam actually ends.
  const rimX = obj.x + Math.cos(base) * obj.radius, rimY = obj.y + Math.sin(base) * obj.radius;
  const dx = rimX - fromX, dy = rimY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, px = -uy, py = ux;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([]);   // solid always — see drawCharge on inheriting a dash
  // 1. THE ENVELOPE — a wide, soft, additive wash the strands ride inside. This
  //    is what stops the beam reading as a hairline at low zoom.
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createLinearGradient(fromX, fromY, rimX, rimY);
  halo.addColorStop(0, color + hexA(0.20 + 0.16 * g));
  halo.addColorStop(0.55, color + hexA(0.08 + 0.10 * g));
  halo.addColorStop(1, color + hexA(0.03 + 0.06 * g));
  ctx.strokeStyle = halo;
  ctx.lineWidth = w * (3.4 + 2.6 * heavy);
  ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(rimX, rimY); ctx.stroke();

  // 2. THE STRANDS — two for a rock, four for a world, each fanning out from the
  //    emitter to its own point on the rim. Each bows on its own slow phase so
  //    the rig looks like it is under load; the bow collapses at the endpoints,
  //    which is what keeps them anchored instead of floating.
  const core = ctx.createLinearGradient(fromX, fromY, rimX, rimY);
  core.addColorStop(0, color + hexA(0.55 + 0.35 * g));
  core.addColorStop(1, color + hexA(0.18 + 0.35 * g));
  ctx.strokeStyle = core;
  pts.forEach((p, i) => {
    const bow = Math.sin(game.time * (2.2 + 0.5 * i) + i * 2.1) * (5 + 16 * heavy) * (1.15 - g) / z;
    ctx.lineWidth = w * (0.6 + 0.4 * (1 - Math.abs((i / Math.max(1, n - 1)) * 2 - 1)));
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.quadraticCurveTo(fromX + ux * len * 0.55 + px * bow, fromY + uy * len * 0.55 + py * bow, p.x, p.y);
    ctx.stroke();
  });

  // 3. CHARGE RUNNING DOWN THE BEAM — bright nodes travelling emitter-to-rim,
  //    faster and more of them as the grip closes. Round nodes, never a dash
  //    pattern: this is a real effect, not helper UI.
  const nodes = 2 + Math.round(3 * g) + (heavy > 0 ? 2 : 0);
  const travel = (game.time * (0.5 + 0.9 * g)) % 1;
  ctx.fillStyle = color + hexA(0.35 + 0.5 * g);
  for (let i = 0; i < nodes; i++) {
    const f = (travel + i / nodes) % 1;
    const r = (1.1 + 1.7 * g) * (0.45 + 0.55 * Math.sin(f * Math.PI)) / z;
    ctx.beginPath();
    ctx.arc(fromX + dx * f, fromY + dy * f, r, 0, TAU);
    ctx.fill();
  }

  // 4. THE BITE — where the beam actually has hold: a glow at each contact point
  //    on the rim, plus a bright arc running the span between them. On a world
  //    this is the whole read, and it sits on the limb where you can see it
  //    against the sprite rather than lost inside it.
  for (const p of pts) {
    const r = (5 + 11 * heavy) * (0.5 + 0.6 * g) / z + obj.radius * 0.06;
    const bloom = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    bloom.addColorStop(0, color + hexA(0.42 * g + 0.14));
    bloom.addColorStop(1, color + '00');
    ctx.fillStyle = bloom;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
  }
  // The rim arc between the grip points — skippable (`bite`): on the brawler's
  // ram the slab is a jagged pack, not a disc, and an arc drawn at its nominal
  // radius floated as a stray "half energy circle" in open space.
  if (bite) {
    ctx.strokeStyle = color + hexA(0.12 + 0.30 * g);
    ctx.lineWidth = (1 + 2.4 * g) / z;
    ctx.beginPath();
    ctx.arc(obj.x, obj.y, obj.radius * 0.97, base - spread, base + spread);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// THE LAUNCH. A throw is the loudest thing the player does and it used to happen
// in visual silence — the rock simply changed velocity and left. This is the
// muzzle flash, drawn from the records tractor.pushLaunchFx leaves behind:
//   - a RING thrown off the launch point, expanding and fading
//   - a CONE opening along the throw bearing, so the flash points where the
//     rock went and a launch never reads as an explosion
//   - SPEED LINES raking back along the axis, the recoil the ship never takes
// Everything scales with `heft` (how much of the beam that load was using) and
// gets a hotter, wider kick when it went out at full power, so the spectacle
// tracks the effort: a charged moon leaves a crater of light, a pebble a blip.
function drawLaunchFx(game) {
  if (!game.launchFx.length) return;
  const z = Math.max(game.cam.zoom, 0.4);
  ctx.save();
  ctx.setLineDash([]);   // solid — see drawCharge on inheriting a dash
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const fx of game.launchFx) {
    const k = clamp(1 - fx.t / CFG.LAUNCH_FX, 0, 1);   // 1 at the instant of release
    const grow = 1 - k;
    const big = fx.heft * (fx.charged ? 1.35 : 1);
    const col = fx.charged ? '255, 245, 215' : '190, 232, 255';
    const cx = fx.x, cy = fx.y;
    const ux = Math.cos(fx.ang), uy = Math.sin(fx.ang), px = -uy, py = ux;
    // 1. The ring off the launch point.
    ctx.strokeStyle = `rgba(${col}, ${k * 0.75})`;
    ctx.lineWidth = (0.8 + 4 * big) * k / z;
    ctx.beginPath();
    ctx.arc(cx, cy, fx.r * 0.7 + grow * (30 + 90 * big) / z, 0, TAU);
    ctx.stroke();
    // 2. The cone, opening along the bearing the rock left on.
    const reach = (fx.r + (26 + 120 * big) / z) * (0.35 + grow);
    const spread = 0.34 + 0.5 * grow;
    ctx.strokeStyle = `rgba(${col}, ${k * 0.6})`;
    ctx.lineWidth = (0.8 + 2.6 * big) * k / z;
    for (const sgn of [-1, 1]) {
      const a = fx.ang + sgn * spread;
      ctx.beginPath();
      ctx.moveTo(cx + ux * fx.r * 0.5, cy + uy * fx.r * 0.5);
      ctx.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
      ctx.stroke();
    }
    // 3. Speed lines raking BACK down the axis — the kick the ship never takes
    //    (flinging has no recoil; this is where that force visibly goes).
    ctx.strokeStyle = `rgba(${col}, ${k * 0.45})`;
    ctx.lineWidth = (0.6 + 1.6 * big) * k / z;
    for (let i = -1; i <= 1; i++) {
      const off = i * (fx.r * 0.55 + 7 / z);
      const bx = cx - ux * fx.r * 0.3 + px * off, by = cy - uy * fx.r * 0.3 + py * off;
      const len = (18 + 70 * big) * (0.3 + grow) / z;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - ux * len, by - uy * len);
      ctx.stroke();
    }
    // 4. The flash at the muzzle itself, gone fastest of all.
    const fr = (fx.r * 1.1 + (10 + 40 * big) / z) * k;
    if (fr > 0.5) {
      const gl = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr);
      gl.addColorStop(0, `rgba(${col}, ${k * k * 0.7})`);
      gl.addColorStop(1, `rgba(${col}, 0)`);
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(cx, cy, fr, 0, TAU); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  ctx.globalAlpha = 1;
}

// FULL POWER IS A COLOUR AND A POP, NOT A PROGRESS BAR (user design call).
// The instant that matters is the one where the throw goes live; watching a
// meter creep toward it is not information the player wants mid-fight, and a
// filling ring on every heavy grab was clutter around the thing you are aiming
// at. So the readout is exactly two things and nothing else:
//   - the BEAM RUNS HOT the whole time it is charged (drawBeam's colour arg) —
//     the steady state, readable in peripheral vision
//   - a one-shot BLOOM thrown outward on the CROSSING — the event
// Both gated on CFG.CHARGE_SHOW_HEFT, because a pebble is at full power almost
// at once and a pop on every belt rock would be noise on the loop the player
// spends most of the game in.
function drawCharge(game, b) {
  if (!(game.chargeFlashT > 0)) return;
  const k = clamp(game.chargeFlashT / CFG.CHARGE_FLASH, 0, 1);
  const z = Math.max(game.cam.zoom, 0.4);
  ctx.save();
  // EXPLICITLY SOLID. save()/restore() stops this function leaking a dash OUT,
  // but it does not stop it inheriting one set before the save — and an earlier
  // pass in this frame legitimately leaves patterns set. The pop drawn in
  // inherited dashes reads as helper/aiming UI, which is what dashes are for.
  ctx.setLineDash([]);
  ctx.globalCompositeOperation = 'lighter';
  // A ring thrown outward once, fading as it expands, so the moment is
  // impossible to miss even while you are looking at the target instead.
  ctx.strokeStyle = `rgba(255, 238, 190, ${k * 0.95})`;
  ctx.lineWidth = (1 + 5 * k) / z;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.radius + (1 - k) * (44 + b.radius * 0.8) / z, 0, TAU);
  ctx.stroke();
  // …over a brief flare on the rock itself, so the pop reads as coming FROM the
  // load rather than as a ring that happens to be centred on it.
  const flare = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.radius * 1.5);
  flare.addColorStop(0, `rgba(255, 245, 215, ${k * 0.45})`);
  flare.addColorStop(1, 'rgba(255, 245, 215, 0)');
  ctx.fillStyle = flare;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.5, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  ctx.globalAlpha = 1;
}

// THE WINCH, before the beam has hold of anything (tractor.updateLatch): a moon
// or a world has to be worked at for seconds before the emitters bite. It has
// to look like EFFORT and it has to show progress, or a press that appears to
// do nothing reads as a dead button.
//
// Three searching strands whip and re-seat against the target while it builds,
// and a solid arc closes around the body as the winch fills — that arc is the
// same helper-UI idiom as the shotgun charge ring, solid, never dashed. On
// completion the caller's beam takes over in the same frame, so the two read as
// one continuous action.
function drawLatch(game, fromX, fromY) {
  const L = game.latch;
  const b = L.body;
  const f = clamp(L.t / L.need, 0, 1);
  const z = Math.max(game.cam.zoom, 0.4);
  // ONE GRAMMAR, BOTH WINCHES: the hue says which BUTTON is doing this, exactly
  // as the hover hint rings do (cyan = left/hold, green = right/stow). A ring
  // winch drawn in the beam's cyan would promise a hold that is not coming —
  // this rock is going straight into the rack, and the strands hand over to the
  // seat rather than to drawBeam.
  const col = L.stow ? '#78ffb4' : '#5ac8ff';
  // THE EFFECT AMPS UP WITH THE WINCH — it must start at almost nothing and
  // build, because the ramp IS the readout. `amp` is the eased fill everything
  // below is scaled by; at f=0 the strands are the faintest thread the emitter
  // can throw and by f=1 they are as strong as a real hold, so the winch hands
  // straight over to drawBeam with no visual step.
  const amp = 0.10 + 0.90 * f * f;
  // Same side-grip law as the beam: the strands reach for the RIM, and they
  // reach WIDE at the start and close down onto the final grip as it fills.
  const { pts, base, spread } = gripPoints(game, fromX, fromY, b, 4, (1.5 - 0.7 * f));
  const rimX = b.x + Math.cos(base) * b.radius, rimY = b.y + Math.sin(base) * b.radius;
  const len = Math.hypot(rimX - fromX, rimY - fromY) || 1;
  const ux = (rimX - fromX) / len, uy = (rimY - fromY) / len, px = -uy, py = ux;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([]);   // solid always — see drawCharge on inheriting a dash
  ctx.globalCompositeOperation = 'lighter';
  // A soft envelope that only really arrives at the end of the winch.
  ctx.strokeStyle = col + hexA(0.16 * amp);
  ctx.lineWidth = (2 + 12 * amp) / z;
  ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(rimX, rimY); ctx.stroke();
  // Searching strands: loose and whipping at the start, drawn tight and bright
  // as the emitters find purchase.
  pts.forEach((p, i) => {
    const bow = Math.sin(game.time * (5.5 - 2.4 * f) + i * 2.1) * (54 * (1 - f) + 6) / z;
    ctx.strokeStyle = col + hexA(0.10 + 0.62 * amp);
    ctx.lineWidth = (0.5 + 2.2 * amp) / z;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.quadraticCurveTo(fromX + ux * len * 0.55 + px * bow, fromY + uy * len * 0.55 + py * bow, p.x, p.y);
    ctx.stroke();
  });
  // Charge starts running down the beam only once it is really biting.
  const nodes = Math.round(5 * amp);
  const travel = (game.time * (0.4 + 1.1 * f)) % 1;
  ctx.fillStyle = col + hexA(0.55 * amp);
  for (let i = 0; i < nodes; i++) {
    const t = (travel + i / Math.max(1, nodes)) % 1;
    const r = (0.8 + 2 * amp) * (0.45 + 0.55 * Math.sin(t * Math.PI)) / z;
    ctx.beginPath();
    ctx.arc(fromX + (rimX - fromX) * t, fromY + (rimY - fromY) * t, r, 0, TAU);
    ctx.fill();
  }
  // The bite building at each contact point on the rim — never at the centre.
  for (const p of pts) {
    const r = Math.max(1, (4 + 9 * amp) / z + b.radius * 0.05 * amp);
    const bloom = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    bloom.addColorStop(0, col + hexA(0.5 * amp));
    bloom.addColorStop(1, col + '00');
    ctx.fillStyle = bloom;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = col + hexA(0.30 * amp);
  ctx.lineWidth = (0.8 + 2 * amp) / z;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.radius * 0.97, base - spread, base + spread);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';

  // Progress ring around the load — helper UI, so it is drawn flat and solid
  // and sized in screen pixels, not world units. Full brightness from the first
  // instant: this is the one element that must be legible before the effect is.
  ctx.strokeStyle = L.stow
    ? `rgba(150, 255, 200, ${0.55 + 0.45 * f})`
    : `rgba(140, 215, 255, ${0.55 + 0.45 * f})`;
  ctx.lineWidth = 2.6 / z;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.radius + 13 / z, -Math.PI / 2, -Math.PI / 2 + f * TAU);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
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

// THE HULL IS SPEC DNA. Each specialization flies a visibly different ship,
// and the difference says what that spec DOES before any HUD does:
//   HAULER  — ring arms with orb pods. The arms ARE the orbit rock rack.
//   SCOUT   — long thin swept wings, left BARE, on a needle fuselage carrying a
//             slewing sensor gimbal. Grows by LENGTH and sensor gear.
//   BRAWLER — a front-heavy wedge behind a ram prow and hinged deflector
//             slabs, with a conspicuously BARE TAIL: the spec has no shield at
//             all and its one layer (the War Rack ram) is welded to the bow, so
//             the weakness is drawn, not just tuned.
// Keep the three silhouettes disjoint — ring arms are the hauler's signature
// and reading the spec at a glance is the whole point of splitting them.
//
// Per-tier anatomy. Lengths are in units of u = r * s (collision radius x
// per-tier visual scale); arc angles are for the top half (-y) and mirrored
// at draw time. Each tier is a DISTINCT design, not just a bigger wedge.
// The tier size ladder lives in config.js SHIP_RADIUS (read by shipStats).
// The COLLISION circle is a uniform SHIP_HIT_FRAC of the drawn footprint on
// every tier, so the art is normalized to the FOOTPRINT (u = r / (frac ×
// reach)), NOT to the body disc — the drawn size never moves when the
// hitbox fraction is tuned.
//
// ACROSS SPECS that reach normalization is then multiplied by config.SHIP_VIS,
// because equal REACH is not equal SIZE: a ladder whose reach comes from one
// outlier (this scout's nose, this brawler's deflector brow) gets its whole body
// shrunk to pay for it. The tables below are therefore the RAW art — read them
// as shapes, not as sizes, and let SHIP_VIS do the matching. If you change one,
// re-run render.measureShipArt(game) and re-bake SHIP_VIS from its `raw` column.
//
// HAULER — the original ladder:
//   0 SKIFF       bare wedge, tail fins
//   1 FIGHTER     swept wing pods, twin engine bells
//   2 CORVETTE    first ring arms bracketing the nose
//   3 CRUISER     four arms, armor collar, hull windows
//   4 DREADNOUGHT near-closed ring, strut spokes, triple bell
//   5 TITAN       double ring, five pod pairs, spokes everywhere
const HAULER_TIERS = [
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

// SCOUT — a winged SENSOR platform on a needle fuselage. The silhouette reads
// bow to stern: gimballed sensor head -> intake maw -> hopper -> feed conduits
// out the wing roots -> clean, bare wings.
//
// THE WINGS ARE BARE (2026-08 user call: "drop the guns on its wings"). The
// pod-and-barrel hardpoints are gone, and with them `hard`, `coils` and
// `longBarrel`. The class was already documented as escalating GUIDANCE rather
// than armament — its kit is Nav Plotter, Lead Computer, Impact Warning and
// Reflex Jink, and the gun count was frozen at four from tier 2 on — so the
// hardware that actually carries the ladder (gimbal, dishes, fire-control
// arrays, sensor booms, the crescent sail) is untouched, as is the evolving wing
// planform that carries the silhouette.
//
// LOOSE END, kept visible rather than quietly papered over: the intake maw and
// the hopper are still drawn, and they now feed NOTHING. "It arms itself by
// swallowing rock" was this class's fiction and no longer has an endpoint. Either
// give the swallowed rock a new destination or retire the intake — don't leave a
// third reading where it is decoration.
//
// THE SCOUT GROWS LONGER, NOT WIDER (user design rule). Length runs 2.2 -> 4.4
// while span only runs 1.6 -> 2.5, so the class sharpens into a needle instead
// of spreading into a bat — a wingspan-led ladder made the late tiers read as
// the widest thing in the sky, which is the hauler's job. `bR` deliberately
// grows slower than length for the same reason: the fuselage gets thinner in
// proportion every tier.
//
// Layout inside drawScoutHull is expressed in fractions of the hull's LENGTH,
// not in fixed multiples of u, so a nose that nearly doubles across the ladder
// stretches the fuselage instead of overrunning the gear mounted on it. `reach`
// is the nose on every tier — the wingtip never out-reaches it, which is the
// rule that keeps this class long.
//   0 SPLINTER  bare wings, one bell — a frame with nothing on it yet
//   1 DART      rangefinder vanes, twin bells
//   2 STILETTO  spotter dish, feed conduits, the gimbal appears
//   3 LONGSHOT  fire-control arrays, emitter posts, chin, split drive
//   4 FARSIGHT  twin hoppers, two dishes, four arrays, sensor booms, nacelles
//   5 ORACLE    crescent fire-control sail, mast, winglets, blades
// THE LADDER ESCALATES GUIDANCE, NOT ARMAMENT (user design rule). Its kit is Nav
// Plotter, Lead Computer, Impact Warning and Reflex Jink, so what each rung buys
// is a better view: a scout that grew by bolting on more barrels was telling you
// it was a gunship, which is the brawler's job. That rule long predates the guns
// coming off, and is the reason removing them cost the ladder nothing.
//
// The gimmick is the GIMBAL: a sensor head on the nose that physically slews to
// wherever you are aiming, independent of where the hull is pointing. It is the
// one moving part on the class, it says "computer guidance" at a glance, and it
// is disjoint from the hauler's spinning ring arms (which are big, structural,
// and turn at a constant rate rather than tracking anything).
//
// `wing` is the PLANFORM, and it evolves so the silhouette changes tier to
// tier instead of the same wing carrying more junk: a short straight taper at
// T0, a cranked leading edge from T2, a root extension from T4, and a long
// raked scythe at T5. `tipChord` shrinks the whole way — the wing gets more
// slender as it gets longer, which is what "refined" reads as.
const SCOUT_TIERS = [
  { bR: 0.26, nose: 1.25, rear: 0.95, span: 0.80, sweep: 0.26,
    wing: { le: 0.52, root: 0.18, tipChord: 0.080 },
    eng: 1, core: 0, dish: 0, arrays: 0, hopper: 1, reach: 1.25 },
  { bR: 0.28, nose: 1.50, rear: 1.05, span: 0.92, sweep: 0.27,
    wing: { le: 0.53, root: 0.19, tipChord: 0.084 },
    eng: 2, core: 1, dish: 0, arrays: 0, hopper: 1, vanes: true, reach: 1.50 },
  { bR: 0.30, nose: 1.78, rear: 1.18, span: 1.02, sweep: 0.28,
    wing: { le: 0.54, root: 0.20, kink: 0.55, kinkSweep: 0.05, tipChord: 0.088 },
    eng: 2, core: 1, dish: 1, arrays: 0, hopper: 1, vanes: true,
    conduit: true, gimbal: 1, reach: 1.78 },
  { bR: 0.32, nose: 2.08, rear: 1.32, span: 1.14, sweep: 0.30,
    wing: { le: 0.56, root: 0.22, kink: 0.50, kinkSweep: 0.07, tipChord: 0.094 },
    eng: 2, core: 2, dish: 1, arrays: 2, hopper: 1, vanes: true,
    conduit: true, gimbal: 1, chin: true, split: true, reach: 2.08 },
  { bR: 0.34, nose: 2.40, rear: 1.48, span: 1.28, sweep: 0.32,
    wing: { le: 0.58, root: 0.25, kink: 0.45, kinkSweep: 0.09, tipChord: 0.100, lerx: true },
    eng: 3, core: 2, dish: 2, arrays: 4, hopper: 2, vanes: true,
    conduit: true, gimbal: 2, chin: true, split: true,
    booms: true, nacelles: true, reach: 2.40 },
  { bR: 0.36, nose: 2.75, rear: 1.65, span: 1.44, sweep: 0.34,
    wing: { le: 0.60, root: 0.27, kink: 0.40, kinkSweep: 0.12, tipChord: 0.108, lerx: true, rake: true },
    eng: 3, core: 2, dish: 2, arrays: 4, hopper: 2, vanes: true,
    conduit: true, gimbal: 3, chin: true, blades: true,
    sail: true, split: true, booms: true, nacelles: true,
    winglets: true, mast: true, bigSail: true, reach: 2.75 },
];

// BRAWLER — a fist. Mass piles toward the bow: a chisel ram prow, then hinged
// deflector slabs standing OFF the hull in front of it, and armour that thins
// visibly toward the stern. `slabs` is the deflector count (0 at tier 0, then
// 1/1/3/5/7) sitting on an arc of radius `slabR`, which is what sets `reach`
// once it exists. The bare tail is drawn on EVERY tier — the spec has no
// shield and its one layer (the ram) is welded to the bow, so a fully-plated
// brawler would be the art lying about the sim.
//   0 BRUISER   blunt prow, one bell, no deflector yet
//   1 MAULER    single curved deflector plate on two hinges, twin bells
//   2 BREAKER   toothed prow, impact ribs, kinetic sling rails
//   3 BULWARK   three slabs, buttresses, hull windows, core slot
//   4 RAMPART   five slabs, outboard sponsons, cyan kinetic slot, triple bell
//   5 COLOSSUS  seven slabs in two layers, hammerhead prow, quad bell
// A BRAWLER IS STILL AN ARROW. The first cut of this table ran bR 0.72-1.08
// against a nose of 0.95-1.32, and once the hull was normalized against the
// standoff deflector radius the result read as a disc with a fence around it —
// "front-heavy" is about where the MASS sits, not about being as wide as it is
// long. Length now runs 2.25 -> 3.47 against a width of 1.20 -> 1.68, so every
// tier is close to twice as long as it is wide, and the deflector is a BROW
// across the bow (half-angle 0.60) rather than an arc wrapping the whole nose.
// A TIER MUST CHANGE THE OUTLINE, NOT JUST THE DETAIL (user design rule, and
// the reason the hauler ladder works — bare wedge, then wing pods, then ring
// arms, then a closed ring). The first cut of this table varied only surface
// flags (ribs, rails, windows) over one fixed wedge, so the six tiers read as
// ONE ship photographed at six sizes. Every row below adds a part that changes
// the SILHOUETTE, and each is called out by the flag that carries it:
//   0 BRUISER   no prow block at all — the hull itself is the wedge. One bell.
//   1 MAULER    +prow block, +a single standoff deflector bar, twin bells
//   2 BREAKER   +toothed prow, +flank sling rails widening the outline
//   3 BULWARK   +shoulder buttress plates, deflector splits into three bars
//   4 RAMPART   +outboard sponsons (a three-lobed outline), five-bar brow
//   5 COLOSSUS  +HAMMERHEAD prow wider than the hull, +engine outriggers,
//               seven bars in two staggered layers
// THE RAM IS THE CLASS. It has to be the first thing you read and the thing
// that looks like it hurts, so `prowW` is >= 1 on every tier — the prow is at
// least as wide as the hull behind it — and it occupies the front ~44% of the
// length (pBase at 0.56). Two earlier passes had it as a small cap on the nose
// with the deflector hung in front of it, which put the class's whole identity
// behind a fence. The deflector is deliberately thinner and narrower now: it
// FRAMES the ram, it does not compete with it.
//
// Tier 0 has one too. War Rack is in the brawler's STARTING KIT (config.js
// SPECS) and the fused ram is its frame-one identity, so a tier-0 hull with no
// prow was the art contradicting the kit. (This used to cite `ramProw`, a
// separate ability that was deleted when the ram became War Rack's fused rock
// prow — the art is unchanged and still right: the hull prow is the MOUNT the
// rocks pack onto, drawn whether or not anything is fused to it yet.)
// `prowW` is a multiple of the HULL half-width, so it is literally "how many
// times wider than the ship is the ram". It never drops below 1.20 — the ram
// overhangs the hull on BOTH sides at every tier, including tier 0, because a
// prow flush with the hull line stops being a ram and becomes a nose.
//
// The T0 -> T5 gap is deliberately extreme. Tier 0 is `plain`: hull, ram, one
// bell, bridge, nothing else — no cheek plates, no keel, no core, no ribs,
// rails or windows. Tier 5 carries eleven systems tier 0 does not. A ladder
// whose ends look like the same ship at two sizes is the failure mode here, so
// each rung adds a NAMED system rather than another decal:
//   0 BRUISER   plain hull + ram + one bell                     (0 extras)
//   1 MAULER    +deflector bar, twin bells, cheeks, keel        (4)
//   2 BREAKER   +core, impact ribs, sling rails                 (7)
//   3 BULWARK   +3-bar deflector, buttresses, windows, spine    (11)
//   4 RAMPART   +sponsons, trusses, blisters, kinetic slot,
//               5-bar brow, triple bell, core ticks             (17)
//   5 COLOSSUS  +hammerhead, outriggers, 2nd slab layer,
//               double jaw, quad bells                          (22)
const BRAWLER_TIERS = [
  { bR: 0.50, nose: 1.34, rear: 0.95, prowW: 1.20, slabs: 0, teeth: 2,
    plain: true, eng: 1, core: 0, reach: 1.49 },
  { bR: 0.55, nose: 1.46, rear: 1.02, prowW: 1.28, slabs: 1, slabR: 1.66, teeth: 3,
    eng: 2, core: 0, reach: 1.70 },
  { bR: 0.61, nose: 1.58, rear: 1.10, prowW: 1.36, slabs: 1, slabR: 1.80, teeth: 3,
    eng: 2, core: 1, ribs: true, rails: true, reach: 1.84 },
  { bR: 0.73, nose: 1.70, rear: 1.20, prowW: 1.46, slabs: 3, slabR: 1.98, teeth: 4,
    eng: 2, core: 1, ribs: true, rails: true, windows: true, buttress: true,
    spine: true, reach: 2.05 },
  { bR: 0.78, nose: 1.86, rear: 1.30, prowW: 1.58, slabs: 5, slabR: 2.18, teeth: 4,
    eng: 3, core: 2, ribs: true, rails: true, windows: true, buttress: true,
    spine: true, sponsons: true, trusses: true, blisters: true, kslot: true,
    reach: 2.27 },
  { bR: 0.84, nose: 2.05, rear: 1.42, prowW: 1.75, slabs: 7, slabR: 2.50, teeth: 5,
    eng: 3, core: 2, ribs: true, rails: true, windows: true, buttress: true,
    spine: true, sponsons: true, trusses: true, blisters: true, kslot: true,
    layer2: true, quad: true, hammer: true, outrigger: true, doubleJaw: true,
    reach: 2.56 },
];

// Which ladder the ship is flying. `game.prog.spec` is the source of truth —
// shipStats doesn't carry it, and render must not assume one exists (the very
// first frames of a run are before the spec modal is answered).
function shipTierTable(game) {
  const spec = game.prog && game.prog.spec;
  return spec === 'scout' ? SCOUT_TIERS : spec === 'brawler' ? BRAWLER_TIERS : HAULER_TIERS;
}

// A tier design's art-space reach: how far the drawn shape extends from
// center, in the same units as bR/nose/armR (the footprint before scaling).
// Scout and brawler carry it EXPLICITLY (a swept wingtip and a standoff
// deflector arc aren't derivable from the hauler's nose/arm/fin formula); the
// hauler keeps the derived expression so its geometry is untouched.
function shipReach(t) {
  if (t.reach) return t.reach;
  return Math.max(t.nose, (t.armR || 0) + 0.20, t.bR + (t.fins ? 0.42 : 0.2));
}

// The size-match factor for the ladder currently being flown (config.SHIP_VIS):
// what the reach normalization has to be multiplied by for this spec to read
// the same SIZE as the hauler rather than merely the same outer reach. 1 on
// the hauler, and 1 before a spec is chosen.
function shipVisOf(game, tier) {
  return shipVis(game.prog && game.prog.spec, tier);
}

// How far the DRAWN ship reaches from its center (world units). The shield
// bubble and any effect that should wrap the art uses this, NOT the (smaller)
// collision radius — a titan's bubble must clear its outer ring and nose.
// Since the collision radius is SHIP_HIT_FRAC of the footprint, the footprint
// is r / SHIP_HIT_FRAC — identical for every TIER by construction, but no
// longer for every SPEC: the size match scales the art past that, so the
// scout's needle and the brawler's brow genuinely reach further out than the
// hauler's ring does. Anything wrapping the art must ask here, not divide by
// SHIP_HIT_FRAC itself.
function shipVisualR(game, tier, r) {
  return (r / SHIP_HIT_FRAC) * shipVisOf(game, tier);
}

// ---- shared hull pieces (all three specs) -----------------------------------

// A tapered engine bell in the ship's local frame. Caller owns fill/stroke.
function bellQuad(x0, x1, w0, w1, off) {
  ctx.beginPath();
  ctx.moveTo(x0, off - w0); ctx.lineTo(x1, off - w1);
  ctx.lineTo(x1, off + w1); ctx.lineTo(x0, off + w0);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// Reactor core: dark well, cyan glow ring, bright center. core 2 adds an outer
// graduated ring with tick marks — the big-hull reactor look.
// `wRef` is the body reference the ring widths were originally tuned against
// (the hauler's body disc). Pass cR / 0.46 on a spec whose core isn't sized
// off a body disc, so the ring weights stay in the same proportion to the core
// rather than drifting per hull.
function drawShipCore(t, x, cR, wRef, lw) {
  ctx.fillStyle = '#141b28';
  ctx.beginPath(); ctx.arc(x, 0, cR, 0, TAU); ctx.fill();
  ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.10 * wRef;
  ctx.beginPath(); ctx.arc(x, 0, cR, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(90, 200, 255, 0.35)'; ctx.lineWidth = 0.17 * wRef;
  ctx.beginPath(); ctx.arc(x, 0, cR * 0.65, 0, TAU); ctx.stroke();
  ctx.strokeStyle = SHIP_CYAN; ctx.lineWidth = 0.07 * wRef;
  ctx.beginPath(); ctx.arc(x, 0, cR * 0.65, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#e8f7ff';
  ctx.beginPath(); ctx.arc(x, 0, cR * 0.28, 0, TAU); ctx.fill();
  if (t.core === 2) {
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.6)';
    ctx.lineWidth = lw * 0.7;
    ctx.beginPath(); ctx.arc(x, 0, cR * 1.35, 0, TAU); ctx.stroke();
    for (const a of [0.785, 2.356, -0.785, -2.356]) {
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * cR * 1.1, Math.sin(a) * cR * 1.1);
      ctx.lineTo(x + Math.cos(a) * cR * 1.35, Math.sin(a) * cR * 1.35);
      ctx.stroke();
    }
  }
}

// Damage overlay: scorch gouges with rust streaks trailing aft, and (major
// only) dark bites out of the hull rim. The seeded scar list is shared across
// specs, but WHERE it lands is not: scars scatter over an ellipse (ex, ey)
// sized to that spec's actual body, or a scout's would fall in the empty air
// beside its thin fuselage. `ss` scales the marks themselves — a scout's body
// half-width is a third of a hauler's, so tying scar size to it would make
// the same damage level invisible on one hull and lurid on another.
function drawShipScars(tier, dmg, cx, ex, ey, ss) {
  for (const sc of shipScars(tier, dmg)) {
    if (sc.bite) {
      ctx.fillStyle = '#0c0f16';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(sc.a) * ex, Math.sin(sc.a) * ey, sc.sz * 0.18 * ss, 0, TAU);
      ctx.fill();
      continue;
    }
    const x = cx + Math.cos(sc.a) * sc.d * ex, y = Math.sin(sc.a) * sc.d * ey;
    const sz = sc.sz * 0.16 * ss;
    ctx.fillStyle = 'rgba(122, 74, 34, 0.7)';
    ctx.beginPath();
    ctx.moveTo(x, y - sz * 0.3);
    ctx.lineTo(x - sc.streak * ss, y + sc.jit * ss);
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
}

// Dispatch on the run's spec. TWO normalizations, in this order:
//   1. to the FOOTPRINT (r / SHIP_HIT_FRAC), not the body disc — which is what
//      keeps the collision circle a uniform fraction of the drawn reach across
//      the six TIERS of any one ladder, so the hitbox feel never changes as you
//      climb;
//   2. then by config.SHIP_VIS, so the three SPECS read the same SIZE as each
//      other and not merely the same outer reach. See the SHIP_VIS comment for
//      why reach alone was the wrong match and what it cost the scout/brawler.
function drawShipHull(game, tier, dmg, r) {
  const table = shipTierTable(game);
  const t = table[tier];
  const u = r * shipVisOf(game, tier) / (SHIP_HIT_FRAC * shipReach(t));
  // ONE stroke for every spec — see outlineW. `u` still differs per spec (it is
  // that ladder's art scale and always was); the LINE WEIGHT no longer does.
  const lw = outlineW(tier, r);
  ctx.lineJoin = 'round';
  if (table === SCOUT_TIERS) drawScoutHull(game, t, tier, dmg, u, lw);
  else if (table === BRAWLER_TIERS) drawBrawlerHull(game, t, tier, dmg, u, lw);
  else drawHaulerHull(game, t, tier, dmg, u, lw);
  ctx.lineJoin = 'miter';  // back to the canvas default other draws assume
}

// ONE STROKE WEIGHT, SHARED BY ALL THREE SPECS, AND IT IS THE HAULER'S (2026-08
// user call: "the outlines of the scout and brawler seem larger than the
// hauler, which looks good" — said twice, because the first fix did not go far
// enough).
//
// The bug was never the coefficient, it was the UNIT. Every spec's stroke was
// `k x u`, and `u` is an ART-SPACE unit — `r x vis / (SHIP_HIT_FRAC x reach)` —
// so it means something different on each ladder: the reaches run 1.85 (hauler),
// 2.75 (scout) and 2.56 (brawler) at tier 5, and SHIP_VIS scales two of them up
// on top of that. Equal coefficients over unequal units are unequal strokes.
// Dropping 0.085 -> 0.07 narrowed it and could not close it: the brawler still
// drew 1.20-1.29x the hauler's line at tiers 3-5 and the scout 1.07-1.16x at
// 2-4.
//
// So the stroke stops being derived per spec at all. It is computed ONCE off the
// HAULER's art unit for that tier and handed to whichever hull is drawing, which
// is both the literal reading of the note above and the only version with no
// residual: all three hulls are matched to the same apparent size by SHIP_VIS,
// so one line weight is the correct line weight for all of them.
//
// The hauler's own expression is reproduced EXACTLY, floor included, so its
// shipped art does not move by a pixel. That 1.1 is a WORLD-unit floor and it
// binds on the first three tiers — a known wart, kept deliberately: it is what
// the hauler has always drawn and what the user is calling correct.
function outlineW(tier, r) {
  const u = r / (SHIP_HIT_FRAC * shipReach(HAULER_TIERS[tier]));
  return Math.max(1.1, 0.07 * u);
}

// Draw one spec's hull into SOMEBODY ELSE'S context, in that context's current
// transform, at collision radius `r`. The module owns a single `ctx` that every
// draw helper closes over, so borrowing it means swapping it and putting it back
// on the way out — `finally`, because a throw mid-hull would otherwise leave the
// whole renderer pointed at a scratch canvas and the game would go black.
// Dev-only (measureShipArt and the size-comparison sheet); the frame loop never
// calls it. `game.prog.spec` picks the ladder, so callers set it and restore it.
export function drawShipHullTo(target, game, tier, r, dmg = 0) {
  const saveCanvas = canvas, saveCtx = ctx;
  canvas = target.canvas; ctx = target;
  try { drawShipHull(game, tier, dmg, r); }
  finally { canvas = saveCanvas; ctx = saveCtx; }
}

// THE DERIVATION TOOL BEHIND config.SHIP_VIS. Draws all three ladders off-screen
// at a fixed collision radius and measures the INK each hull actually lays down,
// so the size-match constants are measured rather than felt.
//
// THE METRIC IS THE RADIUS OF GYRATION of the ink: the RMS distance of drawn
// material from the hull's own ink centroid. Two simpler metrics were measured
// and rejected against a side-by-side of all three ladders:
//   BOUNDING BOX (geometric mean of w,h) over-inflates the brawler — the
//     hauler's box is mostly the AIR inside its ring arms while the brawler's is
//     solid, so matching boxes made the brawler read as the biggest ship by far.
//   INK AREA (sqrt of painted pixels) over-stretches the scout — a needle with
//     little ink has to grow enormously to match a ring-armed hauler's pixel
//     count, and at T3 it came out half again as long as anything else.
// Gyration sits between them and, tellingly, AGREES with ink area on the solid
// brawler (1.27 vs 1.26 at T5) while refusing to blow the thin scout up. It is
// also the principled reading of "apparent size": how far a shape's substance
// spreads from its own centre.
//
// Returns per spec and tier: `size` (gyration AS CURRENTLY DRAWN), `raw` (that
// with the live SHIP_VIS divided back out), plus the ink box and pixel count for
// context. BAKE FROM `raw`, READ `size` TO CHECK YOUR WORK — raw is the
// un-matched art and does not move when SHIP_VIS does, so
// SHIP_VIS[spec][tier] = hauler.raw / spec.raw is a fixed point re-derivable from
// any state, while `size` should come out EQUAL across specs once the table is
// right. Dev-only — nothing in the frame loop calls it. Re-run and re-bake
// whenever a tier table changes:
//   copy(JSON.stringify(render.measureShipArt(game)))
export function measureShipArt(game) {
  const R = 100, N = 900;
  // Fail LEGIBLY. This is driven by hand from devtools, so the two ways it can
  // go wrong — called before the game object exists, or a browser that won't
  // hand out another 2D context — should say which rather than surfacing as a
  // TypeError from somewhere deep in a hull draw.
  if (!game || !game.prog) throw new Error('measureShipArt: needs the live game object (try window.game)');
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const mctx = cv.getContext('2d', { willReadFrequently: true });
  if (!mctx) throw new Error('measureShipArt: could not get a 2D context for the scratch canvas');
  const spec0 = game.prog.spec;
  const out = {};
  try {
    for (const spec of ['hauler', 'scout', 'brawler']) {
      game.prog.spec = spec;
      out[spec] = [];
      for (let tier = 0; tier < 6; tier++) {
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.clearRect(0, 0, N, N);
        mctx.save();
        mctx.translate(N / 2, N / 2);
        // The hull draws in the ship's local frame at world scale; at r = 100 a
        // reach of ~3 fits the 900px sheet with room to spare on every tier.
        drawShipHullTo(mctx, game, tier, R);
        mctx.restore();
        const px = mctx.getImageData(0, 0, N, N).data;
        let x0 = N, y0 = N, x1 = -1, y1 = -1, ink = 0, sx = 0, sy = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            // Alpha 24/255: ignore the faint outer haze of a glow so the box is
            // the SHIP, not its bloom.
            if (px[(y * N + x) * 4 + 3] < 24) continue;
            ink++; sx += x; sy += y;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        // Second pass for the gyration: the centroid has to exist first, and it
        // is the INK's centroid, not the origin — a hull whose mass sits forward
        // of its own pivot (every brawler) would otherwise read as larger for
        // being off-centre, which is a position, not a size.
        const cx = sx / ink, cy = sy / ink;
        let s2 = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            if (px[(y * N + x) * 4 + 3] < 24) continue;
            s2 += (x - cx) * (x - cx) + (y - cy) * (y - cy);
          }
        }
        const size = Math.sqrt(s2 / ink);
        out[spec].push({
          tier, w: x1 - x0 + 1, h: y1 - y0 + 1,
          size: +size.toFixed(2),
          raw: +(size / shipVis(spec, tier)).toFixed(2), ink,
          reach: +(Math.max(x1 - N / 2, N / 2 - x0, y1 - N / 2, N / 2 - y0)).toFixed(1),
        });
      }
    }
  } finally {
    game.prog.spec = spec0;
  }
  return out;
}

// ---- SCOUT: winged gun platform ---------------------------------------------
// THE SPLIT HULL (tier 3+). From the moment the scout can afford real gravitic
// hardware it stops being one body: the DRIVE SECTION flies loose behind the
// forward hull, the two held together by a gravity tether rather than a spar.
// Two things drive it, and both are read off the sim so the effect is never
// decorative:
//   THRUST COMPRESSES a spring. The coupling is a COMPRESSION SPRING, not a
//   linear ease: it only ever PUSHES the drive against the forward hull, never
//   pulls it back, so the drive drives. Under power the gap collapses toward
//   SPLIT_MIN and the spring fights it; release and it springs back OUT to its
//   free length, overshooting and settling rather than gliding home. Two hard
//   stops give it the character: it binds solid at SPLIT_MIN (with a bounce off
//   the bind) and it cannot extend past its free length, because a compression
//   spring has nothing to pull with. It never reaches zero — the halves must
//   never touch, or the conceit collapses into a normal hull with a seam.
//   TURN RATE leads the nose. The forward hull swings ahead of the drive by a
//   fraction of how fast you are actually turning, so the tail whips after it.
// Cached per frame so drawShip's engine-flame anchors and drawScoutHull agree
// on one number — they draw in different passes, and two independent
// evaluations of a speed-dependent value drift apart within a frame.
const SPLIT_CUT = 0.30;                  // station line the hull parts at
const SPLIT_MIN = 0.075, SPLIT_MAX = 0.26;   // stand-off, as a fraction of length
let splitGap = 0.26, splitVel = 0, splitLead = 0, splitAng = 0;
let splitT = -1, splitStamp = -1, splitStrain = 0;
function scoutSplit(game, len) {
  if (game.time !== splitStamp) {
    splitStamp = game.time;
    const sh = game.ship;
    // Eased on game.time, the same clock the tier morph uses — so it freezes
    // with the sim when paused instead of racing on while the world is still.
    const dt = splitT < 0 ? 0 : Math.max(0, Math.min(0.1, game.time - splitT));
    splitT = game.time;
    const k = 1 - Math.exp(-7 * dt);
    // Thrust is a boolean plus the burner, so it reads as three settings:
    // coasting, burning, and the afterburner compressing it hardest.
    const th = sh.thrusting ? (game.burnerOn ? 1 : 0.72) : 0;
    const target = SPLIT_MAX - (SPLIT_MAX - SPLIT_MIN) * th;
    // Sub-stepped spring-damper. Deliberately UNDER-damped so it overshoots and
    // rings; a stiff spring integrated at a 0.1s frame would go unstable, hence
    // the fixed inner step rather than one big jump.
    const steps = Math.max(1, Math.ceil(dt / 0.016));
    const h = dt / steps;
    for (let n = 0; n < steps; n++) {
      splitVel += ((target - splitGap) * 62 - splitVel * 7.5) * h;
      splitGap += splitVel * h;
      if (splitGap > SPLIT_MAX) {          // free length: nothing to pull with
        splitGap = SPLIT_MAX;
        if (splitVel > 0) splitVel = 0;
      } else if (splitGap < SPLIT_MIN) {   // coil bind: kick back off the stop
        splitGap = SPLIT_MIN;
        if (splitVel < 0) splitVel = -splitVel * 0.4;
      }
    }
    // 0 at free length, 1 at bind — drives how hard the field is struggling.
    splitStrain = 1 - (splitGap - SPLIT_MIN) / (SPLIT_MAX - SPLIT_MIN);
    // Turn rate from the heading delta. Wrapped into -PI..PI or a pass through
    // +-PI would read as a full-speed spin for one frame.
    let dA = sh.angle - splitAng;
    while (dA > Math.PI) dA -= TAU;
    while (dA < -Math.PI) dA += TAU;
    splitAng = sh.angle;
    const rate = dt > 0 ? dA / dt : 0;
    splitLead = lerp(splitLead, Math.max(-0.22, Math.min(0.22, rate * 0.05)), k);
  }
  return { gap: splitGap * len, lead: splitLead, strain: splitStrain };
}

function drawScoutHull(game, t, tier, dmg, u, lw) {
  const bR = t.bR * u, nose = t.nose * u, rear = -t.rear * u;
  // LAY THE HULL OUT IN FRACTIONS OF ITS OWN LENGTH. The nose more than doubles
  // across the ladder, so anything mounted at a fixed multiple of u would slide
  // off the fuselage by tier 5 (or bunch up at tier 0). `at(p)` is the station
  // line: p 0 is the tail, p 1 is the nose tip.
  const len = nose - rear;
  const at = (p) => rear + p * len;
  const sp = t.split ? scoutSplit(game, len) : { gap: 0, lead: 0 };
  const gap = sp.gap, lead = sp.lead, strain = sp.strain || 0;
  const cut = at(SPLIT_CUT);

  const tipY = t.span * u;
  const wLE = (t.wing && t.wing.le) || 0.52;
  const wRoot = (t.wing && t.wing.root) || 0.18;
  const leX0 = at(wLE), leY0 = bR * 0.82;                // wing leading edge, root
  const leX1 = at(wLE - t.sweep), leY1 = tipY;            // ...and tip
  const teX0 = at(wLE - wRoot);                           // root trailing edge

  // ======================= DRIVE SECTION (trails aft) =======================
  ctx.save();
  ctx.translate(-gap, 0);

  ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  const bx = at(0.13);
  if (t.eng === 1) bellQuad(bx, rear, 0.46 * bR, 0.30 * bR, 0);
  else if (t.eng === 2) {
    bellQuad(bx, rear, 0.28 * bR, 0.18 * bR, -0.46 * bR);
    bellQuad(bx, rear, 0.28 * bR, 0.18 * bR, 0.46 * bR);
  } else {
    bellQuad(bx, rear, 0.38 * bR, 0.25 * bR, 0);
    bellQuad(at(0.11), at(0.03), 0.20 * bR, 0.14 * bR, -0.78 * bR);
    bellQuad(at(0.11), at(0.03), 0.20 * bR, 0.14 * bR, 0.78 * bR);
  }
  ctx.fillStyle = 'rgba(122, 220, 255, 0.8)';
  ctx.fillRect(rear, -0.16 * bR, 0.02 * len, 0.32 * bR);

  // Drive hull
  ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(at(0.04), -bR * 0.46);
  ctx.lineTo(at(0.16), -bR * 0.94);
  ctx.lineTo(at(0.24), -bR);
  ctx.lineTo(cut, -bR * 0.97);
  ctx.lineTo(cut, bR * 0.97);
  ctx.lineTo(at(0.24), bR);
  ctx.lineTo(at(0.16), bR * 0.94);
  ctx.lineTo(at(0.04), bR * 0.46);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // RADIATOR FINS: swept panels shedding drive heat, flanking the block.
  ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.9;
  for (const m of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(at(0.13), m * bR * 0.86);
    ctx.lineTo(at(0.27), m * bR * 1.42);
    ctx.lineTo(at(0.29), m * bR * 1.30);
    ctx.lineTo(at(0.17), m * bR * 0.74);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(43, 52, 68, 0.45)'; ctx.lineWidth = lw * 0.8;
  for (const m of [1, -1]) {
    for (let k = 1; k <= 3; k++) {
      const f = k / 4;
      ctx.beginPath();
      ctx.moveTo(lerp(at(0.13), at(0.27), f), m * lerp(bR * 0.86, bR * 1.42, f));
      ctx.lineTo(lerp(at(0.17), at(0.29), f), m * lerp(bR * 0.74, bR * 1.30, f));
      ctx.stroke();
    }
  }
  // COOLANT TANKS: a pair of cylinders slung along the drive flanks.
  if (t.dish >= 1) {
    for (const m of [1, -1]) {
      ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.9;
      ctx.beginPath();
      ctx.ellipse(at(0.16), m * bR * 0.60, 0.055 * len, bR * 0.20, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(43, 52, 68, 0.5)'; ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      ctx.moveTo(at(0.16), m * bR * 0.42); ctx.lineTo(at(0.16), m * bR * 0.78);
      ctx.stroke();
    }
  }
  // ENGINE COWL: a shroud ring around the bell cluster on the top tier.
  if (t.eng === 3) {
    ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.10 * u;
    ctx.beginPath(); ctx.arc(at(0.09), 0, bR * 1.02, -1.95, 1.95); ctx.stroke();
    ctx.strokeStyle = SHIP_MID; ctx.lineWidth = 0.05 * u;
    ctx.beginPath(); ctx.arc(at(0.09), 0, bR * 1.02, -1.95, 1.95); ctx.stroke();
  }

  // DRIVE NACELLES: outboard pods on pylons, so the drive section itself grows
  // a new outline at the top tiers instead of just gaining surface detail.
  if (t.nacelles) {
    for (const m of [1, -1]) {
      ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.09 * u;
      ctx.beginPath();
      ctx.moveTo(at(0.18), m * bR * 0.80); ctx.lineTo(at(0.18), m * bR * 1.62);
      ctx.stroke();
      ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(at(0.17), m * bR * 1.82, 0.075 * len, bR * 0.30, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(122, 220, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(at(0.10), m * bR * 1.82, 0.036 * u, 0, TAU); ctx.fill();
    }
  }

  // Spotter dishes ride the drive section
  for (let i = 0; i < (t.dish || 0); i++) {
    const dx = at(0.22 - i * 0.07);
    ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.9;
    ctx.beginPath(); ctx.arc(dx, 0, bR * 0.58, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.5)'; ctx.lineWidth = lw * 0.75;
    ctx.beginPath(); ctx.arc(dx, 0, bR * 0.34, 0, TAU); ctx.stroke();
    ctx.fillStyle = SHIP_DARK;
    ctx.beginPath(); ctx.arc(dx, 0, bR * 0.12, 0, TAU); ctx.fill();
  }
  // The coupling face: an emitter plate the tether springs from
  if (t.split) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    ctx.rect(cut - 0.022 * len, -bR * 0.66, 0.022 * len, bR * 1.32);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = SHIP_CYAN;
    for (const m of [1, -1]) {
      ctx.beginPath(); ctx.arc(cut - 0.011 * len, m * bR * 0.46, 0.026 * u, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();

  // ============== THE COUPLING FIELD — braided and UNSTABLE ================
  // Same language as the tractor beam (render.drawBeam): braided strands that
  // bow apart, additive, solid strokes, and a flutter that gets faster and
  // deeper the harder the field is working. Under compression it is being
  // FOUGHT, so the strands whip, the bloom flares and arcs jump between them.
  // Math.random is fine here — this is per-frame VFX, not sim state.
  if (t.split && gap > 0.001) {
    const ca = Math.cos(lead), sa = Math.sin(lead);
    const ax = cut - gap;
    // Flutter: the strained field breathes faster and wider, exactly as a
    // low-grip beam does.
    const puls = 1 + Math.sin(game.time * (15 + 30 * strain)) * (0.16 + 0.42 * strain);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const STRANDS = [0, -0.42, 0.42, -0.80, 0.80];
    const n = 3 + (strain > 0.45 ? 2 : 0);   // it frays as it is squeezed
    for (let i = 0; i < n; i++) {
      const off = STRANDS[i];
      const core = off === 0;
      const fy = off * bR;
      const fxr = cut * ca - fy * sa, fyr = cut * sa + fy * ca;
      // Per-frame jitter, scaled by strain: a settled field is nearly steady,
      // a compressed one cannot hold its shape.
      const jit = (Math.random() - 0.5) * bR * (0.10 + 0.75 * strain);
      const bow = off * bR * (0.55 + 0.5 * strain) * puls + jit;
      ctx.strokeStyle = core
        ? `rgba(170, 238, 255, ${0.62 + 0.34 * strain})`
        : `rgba(110, 200, 255, ${0.20 + 0.30 * strain})`;
      ctx.lineWidth = (core ? 0.05 : 0.026) * u * puls;
      ctx.beginPath();
      ctx.moveTo(ax, off * bR * 0.6);
      ctx.quadraticCurveTo((ax + fxr) / 2, (off * bR * 0.6 + fyr) / 2 + bow, fxr, fyr);
      ctx.stroke();
    }
    // Arcs jumping across the gap once the field is genuinely strained
    if (strain > 0.3) {
      ctx.strokeStyle = `rgba(200, 245, 255, ${0.30 + 0.5 * strain})`;
      ctx.lineWidth = 0.022 * u;
      const arcs = 1 + (Math.random() * 3 * strain | 0);
      for (let i = 0; i < arcs; i++) {
        const f0 = Math.random(), f1 = f0 + 0.18 + Math.random() * 0.3;
        const y0 = (Math.random() - 0.5) * bR * 1.5, y1 = (Math.random() - 0.5) * bR * 1.5;
        ctx.beginPath();
        ctx.moveTo(lerp(ax, cut, f0), y0);
        ctx.lineTo(lerp(ax, cut, Math.min(1, f1)), y1);
        ctx.stroke();
      }
    }
    // Bloom at each coupling face, flaring with the strain
    for (const [gx, gy] of [[ax, 0], [cut * ca, cut * sa]]) {
      const R = bR * (0.8 + 0.5 * strain) * puls;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, R);
      g.addColorStop(0, `rgba(170, 238, 255, ${0.40 + 0.35 * strain})`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(gx, gy, R, 0, TAU); ctx.fill();
    }
    ctx.lineCap = 'butt';
    ctx.restore();              // closes the additive pass
    ctx.globalAlpha = 1;
  }

  // ==================== FORWARD HULL (leads the turn) ======================
  ctx.save();
  ctx.rotate(lead);

  // The wing root sits BEHIND midships so a long clean nose runs out ahead of
  // it. Mounted forward, the wings became the whole read and the hull looked
  // wide no matter how long it actually was.
  const wg = t.wing || {};
  ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  for (const m of [1, -1]) {
    ctx.beginPath();
    // LERX: a root extension running forward along the fuselage. It is what
    // turns a plain swept wing into a compound planform on the late tiers.
    if (wg.lerx) {
      ctx.moveTo(at(0.72), m * bR * 0.50);
      ctx.lineTo(leX0, m * leY0 * 1.06);
    } else {
      ctx.moveTo(leX0, m * leY0);
    }
    // CRANK: the leading edge bends aft partway out, so the wing reads as a
    // scythe rather than a triangle — and the bend gets sharper every tier.
    if (wg.kink) {
      ctx.lineTo(lerp(leX0, leX1, wg.kink) - wg.kinkSweep * len,
        m * lerp(leY0, leY1, wg.kink));
    }
    ctx.lineTo(leX1, m * leY1);
    ctx.lineTo(leX1 - (wg.tipChord || 0.07) * len, m * (wg.rake ? tipY * 0.97 : tipY));
    ctx.lineTo(teX0, m * bR * 0.95);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  // Feed conduits: a seam down each wing root, carrying the hopper's line out
  // into the wing. (It used to terminate at the wing guns, which is what tied
  // the intake and the armament into one system; the guns are gone — see below —
  // so it now reads as structural plumbing, which is all it ever drew.)
  if (t.conduit) {
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.55)'; ctx.lineWidth = lw * 0.8;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(at(0.40), m * bR * 0.7);
      ctx.lineTo(lerp(leX0, leX1, 0.55), m * lerp(leY0, leY1, 0.55) * 0.92);
      ctx.stroke();
    }
  }

  // THE WINGS CARRY NOTHING (2026-08 user call: "for the scout drop the guns on
  // its wings"). There were pod-and-barrel hardpoints here — a rail barrel with
  // coil rings, a mount pod and a lit muzzle, two per wing from tier 2, and bare
  // nubs at tier 0 standing in as empty mounts.
  //
  // The class survives losing them, and arguably reads truer for it: the ladder
  // was ALREADY documented as escalating GUIDANCE rather than armament (gimbal,
  // dishes, fire-control arrays, sensor booms, the crescent sail), with the gun
  // count deliberately frozen at four from tier 2 on. What changed the
  // silhouette tier to tier was never the pods; it was the wing planform — the
  // cranked leading edge, the root extension, the raked scythe — and all of that
  // is untouched. The wing is now a clean aerofoil, which is what makes the
  // sensor gear on it read.

  // SENSOR BOOMS: long slim spars reaching forward off the wing roots, each
  // ending in a lit pod well ahead of the leading edge. They stretch the
  // outline forward and outward — the single loudest change at tier 4.
  if (t.booms) {
    for (const m of [1, -1]) {
      ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.075 * u;
      ctx.beginPath();
      ctx.moveTo(at(0.50), m * bR * 1.30); ctx.lineTo(at(0.86), m * bR * 1.62);
      ctx.stroke();
      ctx.strokeStyle = SHIP_GREY; ctx.lineWidth = 0.038 * u;
      ctx.beginPath();
      ctx.moveTo(at(0.50), m * bR * 1.30); ctx.lineTo(at(0.86), m * bR * 1.62);
      ctx.stroke();
      ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(at(0.88), m * bR * 1.64, 0.048 * len, bR * 0.20, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = SHIP_CYAN;
      ctx.beginPath();
      ctx.arc(at(0.93), m * bR * 1.64, 0.030 * u, 0, TAU); ctx.fill();
    }
  }
  // WINGLETS: blades standing off each wingtip, breaking the clean swept line.
  if (t.winglets) {
    for (const m of [1, -1]) {
      ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(leX1 + 0.01 * len, m * tipY * 0.99);
      ctx.lineTo(leX1 - 0.16 * len, m * tipY * 1.20);
      ctx.lineTo(leX1 - 0.22 * len, m * tipY * 1.16);
      ctx.lineTo(leX1 - 0.09 * len, m * tipY * 0.96);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  // DORSAL MAST: a stacked array tower on the spine, the top-tier signature.
  if (t.mast) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.rect(at(0.46), -bR * 0.30, 0.14 * len, bR * 0.60);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = SHIP_MID;
    for (const k of [0.02, 0.06, 0.10]) {
      ctx.beginPath();
      ctx.rect(at(0.46) + k * len, -bR * 0.56, 0.022 * len, bR * 1.12);
      ctx.fill(); ctx.stroke();
    }
  }

  // Forward canards, drawn as FILLED fins rooted in the hull. Bare struts with
  // a lamp on the end read as sticks floating beside the ship; a fin with a
  // root chord cannot float.
  if (t.vanes) {
    ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(at(0.68), m * bR * 0.55);
      ctx.lineTo(at(0.74), m * bR * 1.55);
      ctx.lineTo(at(0.62), m * bR * 1.50);
      ctx.lineTo(at(0.58), m * bR * 0.70);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  // Crescent fire-control sail — the tier 5 signature, curving forward. Kept
  // INSIDE the wingspan: a sail wider than the wings would put the width back.
  if (t.sail) {
    const sR = (t.bigSail ? 0.54 : 0.42) * len, sC = at(0.46) - sR * 0.55;
    ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = 0.20 * u;
    const sHalf = t.bigSail ? 1.30 : 1.05;
    ctx.beginPath(); ctx.arc(sC, 0, sR, -sHalf, sHalf); ctx.stroke();
    ctx.strokeStyle = SHIP_MID; ctx.lineWidth = 0.11 * u;
    ctx.beginPath(); ctx.arc(sC, 0, sR, -sHalf, sHalf); ctx.stroke();
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.45)'; ctx.lineWidth = lw * 0.75;
    for (let i = -3; i <= 3; i++) {
      const a = i * 0.28;
      ctx.beginPath();
      ctx.moveTo(sC + Math.cos(a) * (sR - 0.09 * u), Math.sin(a) * (sR - 0.09 * u));
      ctx.lineTo(sC + Math.cos(a) * (sR + 0.09 * u), Math.sin(a) * (sR + 0.09 * u));
      ctx.stroke();
    }
  }

  // Forward hull: a BLADE — a long near-parallel run, then the nose taper.
  ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(cut, -bR * 0.97);
  ctx.lineTo(at(0.64), -bR * 0.88);
  ctx.quadraticCurveTo(at(0.86), -bR * 0.52, nose, 0);
  ctx.quadraticCurveTo(at(0.86), bR * 0.52, at(0.64), bR * 0.88);
  ctx.lineTo(cut, bR * 0.97);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // Matching coupling face on the forward hull
  if (t.split) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    ctx.rect(cut, -bR * 0.66, 0.022 * len, bR * 1.32);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = SHIP_CYAN;
    for (const m of [1, -1]) {
      ctx.beginPath(); ctx.arc(cut + 0.011 * len, m * bR * 0.46, 0.026 * u, 0, TAU);
      ctx.fill();
    }
  }

  // Intake maw: the rock goes in HERE. A SLOT, not a box.
  ctx.fillStyle = '#141b28';
  ctx.fillRect(at(0.66), -bR * 0.20, 0.030 * len, bR * 0.40);
  if (tier >= 3) {
    ctx.fillStyle = SHIP_GREY;
    for (let i = -1; i <= 1; i++) {
      ctx.fillRect(at(0.667), i * bR * 0.13 - bR * 0.03, 0.016 * len, bR * 0.06);
    }
  }

  // MANOEUVRING THRUSTERS — read off the LIVE kit, not the tier. Retro Jets are
  // in the scout's starting kit; Dash Jets are a card it may or may not take,
  // so the hull says which it actually has. Seated INSIDE the hull line: at the
  // edge they read as loose dashes rather than ports cut into the plating.
  const st = game.st;
  const nozzle = (x, y, dx, dy, w) => {
    const mx = x + dx * w * 1.7, my = y + dy * w * 1.7;   // mouth centre
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    ctx.moveTo(x - dy * w, y + dx * w);
    ctx.lineTo(mx - dy * w * 1.8, my + dx * w * 1.8);
    ctx.lineTo(mx + dy * w * 1.8, my - dx * w * 1.8);
    ctx.lineTo(x + dy * w, y - dx * w);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(122, 220, 255, 0.85)';
    ctx.beginPath();
    ctx.moveTo(mx - dy * w * 1.5, my + dx * w * 1.5);
    ctx.lineTo(mx + dy * w * 1.5, my - dx * w * 1.5);
    ctx.lineTo(mx + dx * w * 0.35 + dy * w * 1.5, my + dy * w * 0.35 - dx * w * 1.5);
    ctx.lineTo(mx + dx * w * 0.35 - dy * w * 1.5, my + dy * w * 0.35 + dx * w * 1.5);
    ctx.closePath(); ctx.fill();
  };
  if (st && st.hasReverse) {
    for (const m of [1, -1]) nozzle(at(0.50), m * bR * 0.62, 1, 0, 0.070 * u);
  }
  if (st && st.evasion > 0) {
    for (const m of [1, -1]) {
      nozzle(at(0.44), m * bR * 0.70, 0, m, 0.062 * u);
      nozzle(at(0.37), m * bR * 0.70, 0, m, 0.062 * u);
    }
  }

  // Ammunition hopper(s): segmented drum with loaded rock showing through
  const hopY = t.hopper === 2 ? [-bR * 0.46, bR * 0.46] : [0];
  for (const hy of hopY) {
    const hw = t.hopper === 2 ? bR * 0.34 : bR * 0.62;
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.9;
    ctx.beginPath();
    ctx.rect(at(0.34), hy - hw, 0.10 * len, hw * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#6c6a63';
    for (const k of [0.28, 0.72]) {
      ctx.beginPath();
      ctx.arc(at(0.34) + 0.10 * len * k, hy, hw * 0.44, 0, TAU);
      ctx.fill();
    }
  }
  // Cockpit blister doubling as the targeting optic
  ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.ellipse(at(0.56), 0, 0.045 * len, bR * 0.46, 0, 0, TAU);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = SHIP_CYAN;
  ctx.beginPath(); ctx.arc(at(0.572), 0, 0.042 * u, 0, TAU); ctx.fill();

  // Fire-control array panels, ruled with fine seams
  if (t.arrays) {
    const rows = t.arrays === 4 ? [0.44, 0.34] : [0.40];
    for (const ap of rows) {
      for (const m of [1, -1]) {
        ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
        ctx.beginPath();
        ctx.rect(at(ap), m * bR * 0.62, 0.065 * len, m * bR * 0.34);
        ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(43, 52, 68, 0.45)'; ctx.lineWidth = lw * 0.8;
        for (let i = 1; i <= 3; i++) {
          ctx.beginPath();
          ctx.moveTo(at(ap) + 0.0163 * len * i, m * bR * 0.62);
          ctx.lineTo(at(ap) + 0.0163 * len * i, m * bR * 0.96);
          ctx.stroke();
        }
      }
    }
  }

  // Forward guidance blades: thin fixed vanes flanking the sensor head.
  if (t.blades) {
    ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(at(0.80), m * bR * 0.30);
      ctx.lineTo(at(0.99), m * bR * 0.62);
      ctx.lineTo(at(0.96), m * bR * 0.20);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  // Chin sensor block ahead of the gimbal
  if (t.chin) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    ctx.rect(at(0.90), -bR * 0.17, 0.05 * len, bR * 0.34);
    ctx.fill(); ctx.stroke();
  }
  // THE GIMBAL — this class's one moving part. A sensor head in nested rings
  // that SLEWS TO THE AIM, independent of where the hull is pointing: the Lead
  // Computer and the tracking kit made visible. We are inside rotate(s.angle)
  // AND the forward hull's lead rotation, so both come off the world bearing.
  if (t.gimbal) {
    const sh = game.ship;
    const gx = at(0.80), gr = (0.075 + 0.022 * t.gimbal) * u;
    const aimA = game.aim
      ? Math.atan2(game.aim.y - sh.y, game.aim.x - sh.x) - sh.angle - lead : 0;
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(gx, 0, gr, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.55)'; ctx.lineWidth = lw * 0.8;
    for (let k = 1; k <= t.gimbal; k++) {
      ctx.beginPath(); ctx.arc(gx, 0, gr * (1 - k * 0.19), 0, TAU); ctx.stroke();
    }
    ctx.save();
    ctx.translate(gx, 0); ctx.rotate(aimA);
    ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(0, 0, gr * 0.56, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = SHIP_CYAN;
    ctx.beginPath(); ctx.arc(gr * 0.40, 0, gr * 0.24, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // Nose slit, drawn straight onto the hull.
  ctx.strokeStyle = SHIP_CYAN; ctx.lineWidth = Math.max(0.5 / game.cam.zoom, 0.024 * u);
  ctx.beginPath(); ctx.moveTo(at(0.965), 0); ctx.lineTo(at(0.80), 0); ctx.stroke();
  if (tier >= 3) {
    ctx.fillStyle = '#e8f7ff';
    ctx.beginPath(); ctx.arc(nose * 0.97, 0, 0.035 * u, 0, TAU); ctx.fill();
  }

  if (t.core > 0) drawShipCore(t, at(0.42), bR * 0.50, bR * 1.09, lw);
  drawShipScars(tier, dmg, at(0.46), 0.28 * len, bR * 0.85, bR * 1.5);
  ctx.restore();
}

// ---- BRAWLER: ram prow, hinged deflector, bare tail --------------------------
function drawBrawlerHull(game, t, tier, dmg, u, lw) {
  const bR = t.bR * u, nose = t.nose * u, rear = -t.rear * u;
  // Same station-line trick the scout uses: everything is placed in fractions
  // of the hull's own length, so a nose that grows 1.30 -> 2.05 stretches the
  // wedge instead of sliding its furniture off the front.
  const len = nose - rear;
  const at = (p) => rear + p * len;
  const pw = t.prowW * bR, pBase = at(0.56);

  // Deflector slabs stand OFF the hull on hinges — the gap is the point, it is
  // what makes them read as armour plates rather than a thicker nose. Half
  // angle 0.60 keeps it a BROW across the bow: wrap it further and the ship
  // reads as a disc in a cage, whatever the hull underneath is doing.
  const slabArc = (R, n, half, wOut, wIn) => {
    const step = (half * 2) / n, gap = step * 0.16;
    for (let i = 0; i < n; i++) {
      const a0 = -half + i * step + gap * 0.5, a1 = a0 + step - gap;
      ctx.beginPath(); ctx.arc(0, 0, R, a0, a1);
      ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = wOut; ctx.stroke();
      ctx.strokeStyle = SHIP_MID; ctx.lineWidth = wIn; ctx.stroke();
      for (const a of [a0, a1]) {          // hinge pivots back to the hull
        ctx.strokeStyle = SHIP_GREY; ctx.lineWidth = 0.055 * u;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.lineTo(Math.cos(a) * (R - 0.16 * u), Math.sin(a) * (R - 0.16 * u));
        ctx.stroke();
      }
    }
  };
  // Engine bells, then the hull over their mouths
  ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  const bx = at(0.26);
  // Engine deck: the block the bells are mounted on. Without it the nozzles sit
  // in open space behind the hull and read as loose parts trailing the ship.
  ctx.beginPath();
  ctx.rect(at(0.10), -bR * 0.52, 0.22 * len, bR * 1.04);
  ctx.fill(); ctx.stroke();
  if (t.eng === 1) bellQuad(bx, rear, 0.40 * bR, 0.26 * bR, 0);
  else if (t.eng === 2) {
    bellQuad(bx, rear, 0.22 * bR, 0.14 * bR, -0.36 * bR);
    bellQuad(bx, rear, 0.22 * bR, 0.14 * bR, 0.36 * bR);
  } else if (t.quad) {
    bellQuad(bx, rear, 0.19 * bR, 0.12 * bR, -0.22 * bR);
    bellQuad(bx, rear, 0.19 * bR, 0.12 * bR, 0.22 * bR);
    // OUTRIGGERS: the outboard pair hangs off booms clear of the hull, so the
    // stern silhouette forks instead of just gaining another nozzle inside the
    // same outline.
    if (t.outrigger) {
      ctx.strokeStyle = SHIP_GREY; ctx.lineWidth = 0.10 * u;
      for (const m of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(at(0.22), m * bR * 0.60);
        ctx.lineTo(at(0.12), m * bR * 1.18);
        ctx.stroke();
      }
      ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    }
    bellQuad(at(0.14), at(0.01), 0.15 * bR, 0.10 * bR,
      -(t.outrigger ? 1.18 : 0.56) * bR);
    bellQuad(at(0.14), at(0.01), 0.15 * bR, 0.10 * bR,
      (t.outrigger ? 1.18 : 0.56) * bR);
  } else {
    bellQuad(bx, rear, 0.30 * bR, 0.20 * bR, 0);
    bellQuad(at(0.12), at(0.03), 0.15 * bR, 0.10 * bR, -0.54 * bR);
    bellQuad(at(0.12), at(0.03), 0.15 * bR, 0.10 * bR, 0.54 * bR);
  }
  ctx.fillStyle = 'rgba(122, 220, 255, 0.8)';
  ctx.fillRect(rear, -0.14 * bR, 0.018 * len, 0.28 * bR);

  // Outboard armour sponsons bulging from the shoulders
  if (t.sponsons) {
    ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    for (const m of [1, -1]) {
      ctx.beginPath();
      // Strut FIRST — a pod hanging in space beside the hull reads as debris.
      ctx.beginPath();
      ctx.rect(at(0.36), m * bR * 0.55, 0.12 * len, m * bR * 0.60);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(at(0.42), m * bR * 1.12, 0.105 * len, 0.16 * u, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
    }
  }

  // Shoulder buttress plates: angled slabs bracing the bow back into the hull.
  // They stand PROUD of the hull line, so the tier that gains them gains a
  // visibly different outline rather than another decal on the same one.
  if (t.buttress) {
    ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(at(0.52), m * bR * 0.80);
      ctx.lineTo(at(0.46), m * bR * 1.32);
      ctx.lineTo(at(0.30), m * bR * 1.20);
      ctx.lineTo(at(0.32), m * bR * 0.80);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  // Hull: a front-heavy wedge — widest at the shoulders, tapering to a thin
  // tail. Front-heavy is about where the mass SITS, so the shoulder line is
  // well forward of midships and the stern is genuinely narrow.
  ctx.fillStyle = SHIP_HULL; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  // The shoulder line has to stay AFT of the prow base (pBase is at 0.56 now
  // that the ram owns the front 44%), or the outline doubles back on itself.
  ctx.moveTo(pBase, -pw * 0.92);
  ctx.lineTo(at(0.48), -bR);
  ctx.lineTo(at(0.24), -bR * 0.84);
  ctx.lineTo(at(0.13), -bR * 0.40);
  ctx.lineTo(at(0.13), bR * 0.40);
  ctx.lineTo(at(0.24), bR * 0.84);
  ctx.lineTo(at(0.48), bR);
  ctx.lineTo(pBase, pw * 0.92);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // THE BARE TAIL. The brawler carries no shield and its only layer — the War
  // Rack ram — is welded to the bow, so the stern is drawn as exposed frame on
  // every tier: the spec's weakness is visible from the hull alone.
  // The fill has to read as EXPOSED FRAME, not as a hole. At rgba(20,26,38) it
  // was within a few points of empty space, so on the small tiers — where the
  // tail is most of the ship — the stern vanished into the background and its
  // frame ribs were left hanging in the void as loose floating bars.
  ctx.fillStyle = '#4c576f';
  ctx.beginPath();
  ctx.moveTo(at(0.28), -bR * 0.85);
  ctx.lineTo(at(0.13), -bR * 0.40);
  ctx.lineTo(at(0.13), bR * 0.40);
  ctx.lineTo(at(0.28), bR * 0.85);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(140, 156, 186, 0.8)'; ctx.lineWidth = lw * 0.8;
  for (const k of [0.28, 0.58, 0.86]) {
    const fx = lerp(at(0.30), at(0.13), k);
    const fy = lerp(bR * 0.85, bR * 0.40, k);
    ctx.beginPath(); ctx.moveTo(fx, -fy); ctx.lineTo(fx, fy); ctx.stroke();
  }
  // Re-close the silhouette: the tail overlay paints over the hull's own dark
  // outline, and an unstroked stern edge is what lets the ship leak into space.
  ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(at(0.28), -bR * 0.85);
  ctx.lineTo(at(0.13), -bR * 0.40);
  ctx.lineTo(at(0.13), bR * 0.40);
  ctx.lineTo(at(0.28), bR * 0.85);
  ctx.stroke();

  // THE RAM. Drawn heavy: a darker under-shadow first so it reads as a slab of
  // mass rather than a flat cap, then the plate, then a bright leading edge —
  // the eye lands on the edge that does the damage.
  // A BLADE that overhangs the hull on both sides and carries its teeth across
  // the FULL width of the front face. A forward taper was tried and reads
  // softer — this squarer, full-width jaw is the one that looks like it hits
  // things, so keep the front face at +-pw.
  const prowPath = () => {
    ctx.beginPath();
    ctx.moveTo(pBase, -pw);
    if (t.teeth) {
      const n = t.teeth, span = pw * 2;
      for (let k = 0; k < n; k++) {
        const y0 = -pw + span * (k / n), y1 = -pw + span * ((k + 0.5) / n);
        ctx.lineTo(nose, y0); ctx.lineTo(at(0.86), y1);
      }
      ctx.lineTo(nose, pw);
    } else {
      ctx.lineTo(nose, -pw * 0.55); ctx.lineTo(nose, pw * 0.55);
    }
    ctx.lineTo(pBase, pw);
    ctx.closePath();
  };
  // Cheek plates tying the ram back into the shoulders, so a prow this wide
  // still reads as part of the ship rather than a plough bolted to the nose.
  if (!t.plain) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(pBase + 0.02 * len, m * pw * 0.98);
      ctx.lineTo(at(0.40), m * bR * 0.86);
      ctx.lineTo(at(0.40), m * bR * 0.30);
      ctx.lineTo(pBase + 0.02 * len, m * pw * 0.42);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  ctx.fillStyle = SHIP_DARK;
  ctx.save(); ctx.translate(-0.025 * len, 0); prowPath(); ctx.fill(); ctx.restore();
  ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 1.5;
  prowPath(); ctx.fill(); ctx.stroke();
  // Keel down the ram's spine + a lit leading edge
  if (!t.plain) {
    ctx.strokeStyle = 'rgba(43, 52, 68, 0.55)'; ctx.lineWidth = lw * 0.9;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(pBase + 0.02 * len, m * pw * 0.55);
      ctx.lineTo(at(0.92), m * pw * 0.22);
      ctx.stroke();
    }
  }
  // DOUBLE JAW: a second, inset tooth row behind the first. Top tier only —
  // it is the one feature that changes the ram's own outline rather than its
  // scale, so it reads instantly as "this one bites twice".
  if (t.doubleJaw) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    const n = t.teeth, iw = pw * 0.74, span = iw * 2;
    ctx.beginPath();
    ctx.moveTo(at(0.72), -iw);
    for (let k = 0; k < n; k++) {
      const y0 = -iw + span * (k / n), y1 = -iw + span * ((k + 0.5) / n);
      ctx.lineTo(at(0.85), y0); ctx.lineTo(at(0.75), y1);
    }
    ctx.lineTo(at(0.85), iw);
    ctx.lineTo(at(0.72), iw);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(220, 230, 242, 0.85)'; ctx.lineWidth = lw * 1.1;
  ctx.beginPath();
  ctx.moveTo(at(0.90), -pw * 0.86);
  ctx.lineTo(nose, -pw * 0.16);
  ctx.lineTo(nose, pw * 0.16);
  ctx.lineTo(at(0.90), pw * 0.86);
  ctx.stroke();
  // Cyan kinetic slot down the prow centreline
  if (t.kslot) {
    ctx.strokeStyle = SHIP_CYAN;
    ctx.lineWidth = Math.max(0.6 / game.cam.zoom, 0.055 * u);
    ctx.beginPath(); ctx.moveTo(at(0.60), 0); ctx.lineTo(at(0.97), 0); ctx.stroke();
  } else {
    ctx.fillStyle = SHIP_CYAN;
    ctx.fillRect(at(0.62), -bR * 0.07, 0.05 * len, bR * 0.14);
  }
  // A hammerhead needs its own neck, or it floats off the front of the hull
  if (t.hammer) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.rect(at(0.46), -bR * 0.50, 0.12 * len, bR * 1.00);
    ctx.fill(); ctx.stroke();
  }

  // DEFLECTOR, drawn after the ram and on real pylons. Standing the slabs off
  // the hull is the point of the design, but a standoff with nothing spanning
  // the gap is just a bar floating in front of a ship. It is deliberately
  // THINNER and NARROWER than the ram it sits in front of — it frames the ram,
  // it does not compete with it.
  if (t.slabs) {
    const R = t.slabR * u, half = 0.50;
    ctx.lineCap = 'round';
    for (const pass of [[SHIP_DARK, 0.12 * u], [SHIP_GREY, 0.06 * u]]) {
      ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
      for (const m of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(at(0.90), m * pw * 0.60);
        ctx.lineTo(Math.cos(half) * R, m * Math.sin(half) * R);
        ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(nose, 0); ctx.lineTo(R, 0); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    if (t.layer2) slabArc(R * 0.91, t.slabs, 0.40, 0.11 * u, 0.055 * u);
    slabArc(R, t.slabs, half, 0.15 * u, 0.075 * u);
  }

  // Armoured bridge. Every tier has one, because a hull with no cockpit reads
  // as debris however good its outline is.
  ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(at(0.50), -bR * 0.24);
  ctx.lineTo(at(0.38), -bR * 0.42);
  ctx.lineTo(at(0.38), bR * 0.42);
  ctx.lineTo(at(0.50), bR * 0.24);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(122, 220, 255, 0.9)';
  ctx.beginPath();
  ctx.moveTo(at(0.487), -bR * 0.22);
  ctx.lineTo(at(0.405), -bR * 0.32);
  ctx.lineTo(at(0.405), bR * 0.32);
  ctx.lineTo(at(0.487), bR * 0.22);
  ctx.closePath(); ctx.fill();

  // DORSAL SPINE: a stepped armour ridge down the hull's centreline.
  if (t.spine) {
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.9;
    for (const sp of [0.20, 0.28, 0.36]) {
      ctx.beginPath();
      ctx.rect(at(sp), -bR * 0.16, 0.05 * len, bR * 0.32);
      ctx.fill(); ctx.stroke();
    }
  }
  // TRUSSES: open lattice tying the sponsons back to the hull. Solid struts
  // would just read as a wider hull; a lattice reads as added STRUCTURE.
  if (t.trusses) {
    ctx.strokeStyle = SHIP_GREY; ctx.lineWidth = lw * 1.2;
    for (const m of [1, -1]) {
      for (const k of [0.36, 0.44]) {
        ctx.beginPath();
        ctx.moveTo(at(k), m * bR * 0.70);
        ctx.lineTo(at(k + 0.06), m * bR * 1.12);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(at(0.38), m * bR * 1.02);
      ctx.lineTo(at(0.50), m * bR * 1.02);
      ctx.stroke();
    }
  }
  // BLISTERS: turret pods on the ram's cheeks.
  if (t.blisters) {
    for (const m of [1, -1]) {
      ctx.fillStyle = SHIP_MID; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(at(0.62), m * pw * 0.74, 0.075 * u, 0, TAU);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = SHIP_DARK;
      ctx.beginPath();
      ctx.arc(at(0.62), m * pw * 0.74, 0.032 * u, 0, TAU); ctx.fill();
      ctx.fillStyle = SHIP_CYAN;
      ctx.beginPath();
      ctx.arc(at(0.665), m * pw * 0.74, 0.018 * u, 0, TAU); ctx.fill();
    }
  }

  // Impact ribs raking back from the prow along both shoulders
  if (t.ribs) {
    ctx.strokeStyle = SHIP_GREY; ctx.lineWidth = 0.085 * u;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(at(0.54), m * pw * 0.70);
      ctx.lineTo(at(0.34), m * bR * 0.78);
      ctx.stroke();
    }
  }
  // Kinetic sling rails along the flanks, cyan emitter block at the front
  if (t.rails) {
    for (const m of [1, -1]) {
      ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      ctx.rect(at(0.22), m * bR * 0.56, 0.24 * len, m * bR * 0.13);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = SHIP_CYAN;
      ctx.beginPath();
      ctx.arc(at(0.44), m * bR * 0.625, 0.038 * u, 0, TAU);
      ctx.fill();
    }
  }
  // Plate seams — the big bow plate must not read as one blank slab
  // Seams RAKE with the wedge. Drawn dead vertical they read as the stripes on
  // a loaf of bread, which is most of why the small tiers looked like junk.
  ctx.strokeStyle = 'rgba(43, 52, 68, 0.32)'; ctx.lineWidth = lw * 0.75;
  for (const k of [0.28, 0.42]) {
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(at(k), 0); ctx.lineTo(at(k - 0.10), m * bR * 0.92);
      ctx.stroke();
    }
  }
  // Lit hull windows along the flanks
  if (t.windows) {
    ctx.fillStyle = 'rgba(122, 220, 255, 0.9)';
    for (const m of [1, -1]) {
      for (const wp of [0.24, 0.34, 0.44]) {
        ctx.beginPath();
        ctx.arc(at(wp), m * bR * 0.36, 0.028 * u, 0, TAU);
        ctx.fill();
      }
    }
  }

  if (t.core > 0) {
    // The core sits in an armoured slot, not open on the plating
    ctx.fillStyle = SHIP_GREY; ctx.strokeStyle = SHIP_DARK; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(at(0.34), 0, bR * 0.44, 0, TAU); ctx.fill(); ctx.stroke();
    drawShipCore(t, at(0.34), bR * 0.32, bR * 0.70, lw);
  }
  drawShipScars(tier, dmg, at(0.34), 0.24 * len, bR * 0.78, bR * 0.80);
}

// ---- HAULER: the original ring-armed ladder ---------------------------------
function drawHaulerHull(game, t, tier, dmg, u, lw) {
  const bR = t.bR * u, nose = t.nose * u, rear = -t.rear * u;
  const cx = -0.12 * u;                   // body circle sits a touch aft

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

  // Scar geometry scales with the BODY, not the collision radius — the same
  // damage level should look equally beat-up at every tier.
  drawShipCore(t, 0, (t.core === 0 ? 0.34 : 0.46) * bR, bR, lw);
  drawShipScars(tier, dmg, cx, bR, bR, bR);
}

// Tier-morph state (render-local, cosmetic): when the tier changes, the new
// hull scales in from the old silhouette's size over MORPH_T seconds with a
// flash ring, masking the hard art swap. Driven by game.time so it freezes
// with the sim when paused.
const MORPH_T = 0.9;
let morphTierSeen = -1, morphStart = -1e9, morphFromVisR = 0, morphLastVisR = 0;

// THE RAM's spring + rubber-band + rocklet state (see the ram block in
// drawShip). Spring: gap fraction, 1 = free length — the scoutSplit shape.
let ramSprGap = 1, ramSprVel = 0, ramSprStamp = -1, ramHitPrev = 0, ramDropPrev = 0;
// THE RUBBER BAND: the slab's offset from the ship, kept in WORLD AXES and
// eased toward the nose anchor in CARTESIAN space. This is the whole
// difference from the old bearing-lag model: easing an ANGLE swings the slab
// along an arc centred on the ship — a fulcrum — while easing the offset
// VECTOR cuts the chord, which is what an elastic coupling actually does when
// its far end is dragged sideways. The slab's facing comes from the offset
// direction, so it noses along the band rather than staying parallel-parked.
let ramOffX = null, ramOffY = null;
// The field's colour walks cyan -> near-white as the ram fills, the same
// "full power is a COLOUR" ramp the throw charge uses. Hex because the beam
// pass concatenates alpha (hexA) onto it.
function ramFieldColor(fill) {
  const mix = (a, b) => Math.round(a + (b - a) * fill);
  const h = (v) => v.toString(16).padStart(2, '0');
  // Deep blue at empty, brightening as it fills but STOPPING WELL SHORT OF
  // WHITE — the previous ramp topped out at #d8ecff, so a near-full ram wore
  // beams that read white, not blue (user design pass: "more blue"). The top
  // is now a saturated sky blue; fullness still reads in the brightening,
  // just inside the blue family the whole way.
  return '#' + h(mix(0x3d, 0x86)) + h(mix(0x8e, 0xc2)) + 'ff';
}
// THE TWELVE BARRIER TIERS (config.RAM_TIERS — TWO PER RANK), as rocklets — and
// the tier is DENSITY, not rank
// (config.ramTier): feed the ram and the pack visibly climbs from loose
// rubble toward a fused wall; let hits spend it and it comes back apart. War
// Rack's rank only caps how high the ladder goes. Same fixed-seed discipline
// as everything else the ram draws: one seed per tier, cached on the
// quantized frame, identical every frame and session.
//
// The cache also carries the MATTRESS: per-rocklet spring state (pos/vel along
// the nose axis, plus a scheduled-kick queue), so a hit ripples across the
// pack rock by rock instead of the whole thing moving as one — the impact
// point gives first, its neighbours follow a beat later, and the ring-back is
// each rocklet's own. Fresh arrays on every rebuild; the rebuild jolt below
// seeds them ringing, which is the tier-change animation in both directions.
let ramRocksCache = null, ramRocksKey = '';
function ramTierRocks(tier, halfW, depth, stone) {
  const key = tier + ':' + ((halfW * 4) | 0) + ':' + ((depth * 4) | 0);
  if (ramRocksCache && ramRocksKey === key) return ramRocksCache;
  const rng = mulberry32(0x52414d00 + tier);
  // ROWS DEEP, NOT ROCKS BIG (user design rule). A higher tier packs MORE
  // rocks in MORE rows — one row of rubble at tiers 1-4, a double course at
  // 5-8, a triple wall at 9-12. Depth already grows with tier in
  // config.ramPlate, which is what gives the extra rows room without the pack
  // outgrowing its physics footprint.
  //
  // THE STONE IS GIVEN, NOT SOLVED FOR (user design law: *a ram is smashed
  // together, at the expense of width*). `stone` is `depth x RAM_STONE` off the
  // plate, and config solved `halfW` so that `perRow` of them sit shoulder to
  // shoulder at `ramPack` spacing — so the layout here only has to place them.
  // It used to be the other way round: the radius was `min(depth/2, a slot
  // term)` against an independently-ramped width, so on a wide slab the depth
  // cap won, the stones came out far smaller than their slots and the pack hung
  // apart with daylight through it. Nothing here may re-derive the size from the
  // width again, and the ONLY per-stone freedom is the jitter below — which is
  // deliberately bounded at +-10% and paid for by `ramPack`'s margin, so even
  // the two smallest neighbours still touch.
  //
  // TWELVE BANDS, SAME ENDPOINTS (config.RAM_TIERS). Every ramp below was
  // rewritten to reach at tier 12 exactly what it used to reach at tier 6, so a
  // maxed ram is the wall it always was and the extra granularity is entirely in
  // the steps between. perRow steps every OTHER band on purpose — a stone count
  // that ticked up twelve times would put 14 across the bow; the in-between bands
  // are read in the packing, the courses and the slab's own growth instead.
  // The consequence worth knowing: the EVEN bands reproduce the old six-band
  // ladder exactly (2->old 1, 4->old 2, ... 12->old 6), so every rank still tops
  // out on the build it always did and the odd bands are pure new ground — the
  // same course, looser packed and on a slightly smaller slab.
  //
  // BAND 1 IS A PAIR (2026-08 user call: "the lowest visual level should be just
  // 2 rocks"). It is the only count the old ladder never had a rung for — the
  // emptiest a ram can be while still being a ram — and it is what makes the
  // bottom of the ladder read as two boulders you dragged onto the nose rather
  // than as a thin course of something. Everything above it lands on the old
  // rungs: the ramp is anchored at 2 and 8 over eleven steps, which puts the six
  // even bands on exactly 3/4/5/6/7/8.
  const rows = ramRows(tier);
  const perRow = ramPerRow(tier);              // 2 at band 1 -> 8 at 12
  const slot = (halfW * 2) / perRow;
  const rocks = [];
  for (let row = 0; row < rows; row++) {
    // Front row leads; each course behind sits deeper along the nose axis,
    // brick-offset by half a slot so the wall bonds instead of gridding.
    const rowX = depth * (0.28 - row * (0.56 / Math.max(1, rows - 1) || 0));
    const shift = (row % 2) * slot * 0.5;
    // Back rows lose a stone: the brick offset walks them inward, and a full
    // course back there would poke past the pack's shoulders.
    const inRow = perRow - (row % 2);
    for (let i = 0; i < inRow; i++) {
      const t = inRow === 1 ? 0 : (i / (inRow - 1)) * 2 - 1;   // -1..1 across
      const r = stone * (0.9 + rng() * 0.2);
      rocks.push({
        // The SLIGHT ARC (user design call): the course bows around the bow —
        // centre stones lead, the wings sweep back — so the wall reads as a
        // plough curved to the ship rather than a fence nailed across it. The
        // 1.7 exponent keeps the middle flat and folds only the outer stones.
        x: rowX + (rng() - 0.5) * depth * 0.18
          - Math.pow(Math.abs(t), 1.7) * depth * 0.55,
        // The inset rides the BASE stone, not this stone's jittered radius —
        // it is the same term config solved `halfW` against, and reading the
        // jitter here would walk the seats apart by up to a tenth of a stone.
        y: t * (halfW - stone * 0.7) + (t === 0 ? shift * 0.4 : shift * (t > 0 ? -1 : 1) * 0.4),
        r,
        rot: rng() * TAU,
        ring: rockJagRing(rng, Math.max(6, r)),
        // A stone TONE per rocklet plus a fixed shade bearing — neighbouring
        // rocks must not be the same swatch, or the fill-only pack (no
        // outlines, by design) melts into one pastel blob. Four tones, seeded,
        // spanning dark-cold to pale-dry; the crescent drawn at `shade` gives
        // each stone a modelled dark side without reintroducing an edge line.
        tone: ['#57504a', '#645a51', '#6f645a', '#79706b'][(rng() * 4) | 0],
        shade: rng() * TAU,
      });
    }
  }
  ramRocksKey = key;
  const n = rocks.length;
  ramRocksCache = {
    rocks,
    pos: new Float64Array(n),
    vel: new Float64Array(n),
    kickT: new Float64Array(n).fill(-1),
    kickV: new Float64Array(n),
  };
  // THE REBUILD JOLT: the pack just reorganised (a tier crossed, or the frame
  // grew), so every rocklet arrives ringing. Deterministic velocities — no
  // draw from any RNG stream — alternating sign so the pack visibly shuffles
  // rather than breathing in unison.
  for (let i = 0; i < n; i++) {
    ramRocksCache.vel[i] = ((i % 2 === 0 ? 1 : -1) * (0.6 + ((i * 37) % 5) / 5)) * depth * 5;
  }
  return ramRocksCache;
}

function drawShip(game) {
  const s = game.ship;
  if (!s.alive) return;
  if (s.invuln > 0 && Math.floor(game.time * 10) % 2 === 0) return;  // respawn blink

  const lv = game.st.levels;
  const r = s.radius;
  const table = shipTierTable(game);
  const tier = Math.min(game.st.tier, table.length - 1);
  const tG = table[tier];
  // Art normalization and the split stand-off, computed ONCE up here: the
  // shield bubble, the tier-morph scale and the engine-flame anchors all need
  // them, and re-deriving a speed/thrust-dependent value per pass lets the
  // passes disagree inside a single frame.
  // Same two normalizations drawShipHull applies, in the same order — the
  // footprint, then the spec size match. They MUST agree: this is the scale the
  // bubble and the flame anchors are laid out in, and drawShipHull is the scale
  // the hull is actually drawn in.
  const uG = r * shipVisOf(game, tier) / (SHIP_HIT_FRAC * shipReach(tG));
  const splitX = tG.split ? scoutSplit(game, (tG.nose + tG.rear) * uG).gap : 0;
  // THE BUBBLE HAS TO WRAP THE WHOLE SHIP, and on a split hull the drive
  // section is trailing outside the footprint the un-split art occupied. Add
  // the stand-off, or the drive flies naked behind its own shield.
  const visR = shipVisualR(game, tier, r) + splitX;   // how far the drawn art reaches

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
    // A PARTIAL shield (st.shieldArc < PI) confines every visual — glow,
    // recharge sweep, absorb ripple — to the covered wedge, so a bare tail
    // reads at a glance. No live ability produces one: SCOUT's Phase Screen is
    // the only shield in the catalog and it is a full wrap, and BRAWLER's
    // front-arc War Plating is deleted. The wedge path stays because it is the
    // drawn half of `st.shieldArc`, which physics still honours.
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

  // THE CRUSH: absorbed rocks flying into the bow. Drawn BEFORE the ram itself
  // so the incoming piece slides UNDER the growing mass and is swallowed by it,
  // which is the read we want — the ram eats the rock — rather than the rock
  // landing on top of the thing it is becoming part of.
  // Rides `dtReal` (main.js decays it): it is pure cosmetic easing with no
  // quantized target, which is exactly the case the fixed-step rule exempts.
  if (game.ramFx && game.ramFx.length) {
    const z = game.cam.zoom;
    // Where the crush lands: ON THE SLAB — the rubber band's current position,
    // so the rock is seen slamming into the mass it is about to become part of
    // (and the slab visibly recoils on the same frame, because the crush pulsed
    // s.ramHitT and the spring reads that).
    const pl = ramPlate(game.st, s.ram);
    const tipD = pl ? pl.back + pl.gap * ramSprGap + pl.depth * 0.5 : s.radius * 1.1;
    const tx = ramOffX !== null ? s.x + ramOffX : s.x + Math.cos(s.angle) * tipD;
    const ty = ramOffY !== null ? s.y + ramOffY : s.y + Math.sin(s.angle) * tipD;
    ctx.save();
    for (const fx of game.ramFx) {
      const k = Math.min(1, fx.t / fx.dur);          // 0 -> 1
      const ease = 1 - Math.pow(1 - k, 3);           // cubic ease-out: snaps in, settles
      const px = fx.x + (tx - fx.x) * ease;
      const py = fx.y + (ty - fx.y) * ease;
      // FLATTENED ALONG THE TRAVEL as it lands — a rock being crushed onto a
      // hull is squashed, not shrunk uniformly, and the squash is what sells it
      // as compaction rather than a pickup vanishing into a bag.
      const squash = 1 - 0.75 * ease;
      const grow = 1 - 0.35 * ease;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(s.angle);
      ctx.scale(squash, grow);
      ctx.rotate(fx.spin * fx.t);
      ctx.beginPath();
      // A rough eight-sided lump, deterministic off the rock's own id — render
      // must never draw from the sim's RNG stream (determinism law).
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const wob = 0.78 + 0.30 * (((fx.id * 37 + i * 61) % 17) / 17);
        const rr = fx.r * wob;
        const qx = Math.cos(a) * rr, qy = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(150, 138, 128, ${0.95 - 0.25 * ease})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(205, 192, 178, ${0.7 * (1 - ease)})`;
      ctx.lineWidth = 1.2 / z;
      ctx.stroke();
      ctx.restore();
      // The impact spark, only as it actually arrives.
      if (ease > 0.55) {
        const f = (ease - 0.55) / 0.45;
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255, 226, 180, ${0.75 * (1 - f)})`;
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        ctx.arc(tx, ty, fx.r * (0.6 + f * 1.9), 0, TAU);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.restore();
  }

  // THE BRAWLER'S RAM: a barrier of crushed rock RIDING AHEAD OF THE BOW on an
  // elastic energy coupling. Four machines in one block, all on game.time so
  // they freeze with the sim:
  //   SPRING   the coupling's length — compresses under thrust, slams on hits
  //   BAND     the slab's position — eased in Cartesian space, so a turn drags
  //            it across the chord like a stretched rubber band, never swings
  //            it on an arc like a fulcrum
  //   TIERS    density picks the build (config.ramTier -> ramTierRocks):
  //            loose rubble when it is nearly spent, a fused wall when packed
  //   MATTRESS per-rocklet springs — a hit lands at a point and RIPPLES
  //            outward, each rocklet giving and ringing back on its own beat,
  //            never the whole pack moving as one
  // The hit response is deliberately ALL MOTION, no colour: the pack does not
  // light up when struck (user design rule) — it shudders, and on a density
  // tier lost, physics spalls real rock loose alongside the shudder.
  {
    const plate = ramPlate(game.st, s.ram);
    if (plate) {
      const z = game.cam.zoom;
      const { back, gap, depth, halfW, stone, fill, tier } = plate;
      const rocksC = ramTierRocks(tier, halfW, depth, stone);
      // ---- spring + band + mattress, one clock ----
      if (game.time !== ramSprStamp) {
        const dt = ramSprStamp < 0 ? 0 : Math.max(0, Math.min(0.1, game.time - ramSprStamp));
        ramSprStamp = game.time;
        const freshHit = s.ramHitT > 0.2 && ramHitPrev <= 0.05;
        if (freshHit) ramSprVel = Math.min(ramSprVel, -10);
        ramHitPrev = s.ramHitT;
        const freshDrop = (game.ramTierDropT || 0) > 0.4 && ramDropPrev <= 0.1;
        ramDropPrev = game.ramTierDropT || 0;
        // Thrust drives the spring's TARGET (the scout split-drive's three
        // settings): coasting rides free, burning presses to ~2/3, the
        // afterburner hardest. Impact slams stack on top; only they reach the
        // 0.12 coil bind.
        const th = s.thrusting ? (game.burnerOn ? 1 : 0.72) : 0;
        const target = 1 - 0.42 * th;
        const steps = Math.max(1, Math.ceil(dt / 0.016));
        const h = dt / steps;
        for (let n = 0; n < steps; n++) {
          ramSprVel += ((target - ramSprGap) * 240 - ramSprVel * 8.5) * h;
          ramSprGap += ramSprVel * h;
          if (ramSprGap < 0.12) {
            ramSprGap = 0.12;
            if (ramSprVel < 0) ramSprVel = -ramSprVel * 0.45;
          } else if (ramSprGap > 1.30) {
            ramSprGap = 1.30;
            if (ramSprVel > 0) ramSprVel = 0;
          }
        }
        // THE BAND (see the state block for why Cartesian, not angular).
        const anchorD = back + gap * ramSprGap + depth * 0.5;
        const tx = Math.cos(s.angle) * anchorD, ty = Math.sin(s.angle) * anchorD;
        if (ramOffX === null) { ramOffX = tx; ramOffY = ty; }
        else {
          const k = 1 - Math.exp(-7.5 * dt);
          ramOffX += (tx - ramOffX) * k;
          ramOffY += (ty - ramOffY) * k;
          const len = Math.hypot(ramOffX, ramOffY) || 1;
          const cl = clamp(len, back + depth * 0.4, anchorD * 1.28);
          let ba = Math.atan2(ramOffY, ramOffX);
          const trail = angDiff(ba, s.angle);   // angDiff(a,b)=b-a: nose minus band
          if (trail > 0.5) ba = s.angle - 0.5;
          else if (trail < -0.5) ba = s.angle + 0.5;
          ramOffX = Math.cos(ba) * cl; ramOffY = Math.sin(ba) * cl;
        }
        // THE MATTRESS. A fresh hit schedules a kick for every rocklet, delayed
        // by its distance from the impact point — the wave crosses the pack at
        // a readable speed — and sized down with that distance, so the far end
        // stirs where the near end slams. A tier drop is the same wave from
        // the centre, harder: the shudder that goes with the spalled rock.
        const bandAng = Math.atan2(ramOffY ?? Math.sin(s.angle), ramOffX ?? Math.cos(s.angle));
        if (freshHit || freshDrop) {
          const hitA = s.ramHitAng ?? s.angle;
          const impY = freshDrop ? 0
            : clamp(Math.sin(angDiff(bandAng, hitA)) * (back + gap + depth), -halfW, halfW);
          const mag = depth * (freshDrop ? 13 : 8);
          const { rocks, kickT, kickV } = rocksC;
          for (let i = 0; i < rocks.length; i++) {
            const d = Math.abs(rocks[i].y - impY);
            kickT[i] = d / (halfW * 7 + 1);
            kickV[i] = mag / (1 + d / (halfW * 0.5 + 1));
          }
        }
        // Fire due kicks, then integrate each rocklet's own little spring.
        {
          const { pos, vel, kickT, kickV } = rocksC;
          for (let i = 0; i < pos.length; i++) {
            if (kickT[i] >= 0) {
              kickT[i] -= dt;
              if (kickT[i] < 0) { vel[i] -= kickV[i]; kickV[i] = 0; }
            }
            for (let n = 0; n < steps; n++) {
              vel[i] += (-pos[i] * 260 - vel[i] * 7) * h;
              pos[i] += vel[i] * h;
            }
          }
        }
      }
      const strain = clamp(1.35 * (1 - ramSprGap), 0, 1);
      const col = ramFieldColor(fill);
      const slabX = s.x + (ramOffX ?? Math.cos(s.angle) * (back + gap + depth * 0.5));
      const slabY = s.y + (ramOffY ?? Math.sin(s.angle) * (back + gap + depth * 0.5));
      const slabAng = Math.atan2(slabY - s.y, slabX - s.x);

      // ---- the coupling: THE TRACTOR BEAM, PER STONE (user design call:
      // "more like the tractor beam effect but each rock gets its own"). No
      // hand-rolled effect at all any more — three custom couplings were
      // built and none read right — each gripped stone simply gets its own
      // drawBeam call, the SAME function the held-rock beam runs: envelope,
      // side-gripping strands, travelling charge, blooms at the bite. Aiming
      // drawBeam at the whole pack failed earlier because its grip points
      // ride the target's disc and the pack is a ragged wall; a single
      // ROCKLET genuinely is its little disc, so every grip point lands on
      // real stone. The rim arc stays off (bite=false — the "half circle").
      //   - roots spread across the bow in the stones' own lateral order, so
      //     the rigs fan without crossing
      //   - rear-row stones only (nearest the ship), 4 + tier of them
      {
        const glow = clamp(0.5 + 0.3 * fill + 0.3 * strain, 0, 1);
        const r0x = s.x + Math.cos(s.angle) * back * 0.95;
        const r0y = s.y + Math.sin(s.angle) * back * 0.95;
        const wpx = -Math.sin(s.angle), wpy = Math.cos(s.angle);
        const { rocks: bR, pos: bP } = rocksC;
        const ca = Math.cos(slabAng), sa = Math.sin(slabAng);
        // 70% of the old 4 + tier count (user design pass: at gameplay scale
        // a rig per rear stone was too busy at the top tiers) — 4 rigs low,
        // 7 at the top of the ladder, floored so the low tiers keep a real fan.
        // Halved per band with config.RAM_TIERS at twelve, so the endpoints are
        // the ones that were tuned.
        const nPick = Math.max(3, Math.round((4 + tier * 0.5) * 0.7));
        const picks = bR.map((_, i) => i)
          .sort((a, b) => (bR[a].x + bP[a]) - (bR[b].x + bP[b]))
          .slice(0, Math.min(bR.length, nPick))
          .sort((a, b) => bR[a].y - bR[b].y);
        picks.forEach((ri, k) => {
          const rk = bR[ri];
          const sxL = rk.x + bP[ri], syL = rk.y;
          const stone = {
            x: slabX + sxL * ca - syL * sa,
            y: slabY + sxL * sa + syL * ca,
            radius: rk.r,
          };
          const t = picks.length === 1 ? 0 : (k / (picks.length - 1)) * 2 - 1;
          drawBeam(game,
            r0x + wpx * t * s.radius * 0.55,
            r0y + wpy * t * s.radius * 0.55,
            stone, col, glow, 0, false, 1.5);
        });
      }

      // ---- the barrier: this tier's rocklets, each on its own spring ----
      // The rim-light each stone wears (see the loop) shares the zone's colour
      // and master intensity, computed once out here.
      const ramLitCol = col;
      // Brightness up, reach still tight (user design pass: "more glowy", after
      // "much tighter"): the rim stays a narrow band on the ship-facing edge —
      // the falloff only runs a third into the stone — but within that band it
      // genuinely BURNS, saturating toward the 0.85 ceiling as the ram fills.
      // ...AND IT FLICKERS WITH THE BEAMS (user design call): this is drawBeam's
      // own pulse expression, fed the same grip value the ram's rigs pass in,
      // on the same clock — so the stones brighten and dim exactly in phase
      // with the strands feeding them, one breathing system. If drawBeam's
      // pulse formula is ever retuned, retune this copy with it.
      const litGrip = clamp(0.5 + 0.3 * fill + 0.3 * strain, 0.15, 1);
      const litPulse = 1 + Math.sin(game.time * (16 + 26 * (1 - litGrip)))
        * (0.18 + 0.4 * (1 - litGrip));
      const ramLitA0 = hexA(Math.min(0.85,
        (0.38 + 0.3 * fill) * (0.6 + 0.4 * fill + 0.25 * strain) * (0.62 + 0.38 * litPulse)));
      const { rocks, pos } = rocksC;
      ctx.save();
      ctx.translate(slabX, slabY);
      ctx.rotate(slabAng);
      for (let i = 0; i < rocks.length; i++) {
        const rk = rocks[i];
        ctx.save();
        ctx.translate(rk.x + pos[i], rk.y);
        ctx.rotate(rk.rot);
        ctx.beginPath();
        const m = rk.ring.length;
        for (let j = 0; j < m; j++) {
          const a = (j / m) * TAU;
          const rr = rk.ring[j] * rk.r;
          if (j === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        // FILL ONLY — no outline (user design call): the stones read by
        // silhouette, tone and shadow, and an edge stroke on two dozen small
        // overlapping rocklets turned the pack into a wireframe. The per-rock
        // TONE plus the shade crescent below are what keep the outline-less
        // pack from reading as one flat pastel blob.
        ctx.fillStyle = rk.tone;
        ctx.fill();
        ctx.save();
        ctx.clip();
        // The dark side: a big offset disc clipped to the stone, at the rock's
        // own fixed bearing — cheap modelling, never an edge.
        ctx.fillStyle = 'rgba(20, 16, 12, 0.28)';
        ctx.beginPath();
        ctx.arc(Math.cos(rk.shade) * rk.r * 0.75, Math.sin(rk.shade) * rk.r * 0.75,
          rk.r * 0.95, 0, TAU);
        ctx.fill();
        if (rk.r > stone) {
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.beginPath();
          ctx.arc(rk.r * 0.3, -rk.r * 0.2, rk.r * 0.3, 0, TAU);
          ctx.fill();
        }
        // THE FIELD LIGHTS THE STONE (user design call: the rocks themselves
        // must light up, or the energy and the pack read as two unrelated
        // drawings). Additive rim-light on the SHIP-FACING side of every
        // stone — the side the field actually strikes. In this stone's local
        // frame the ship direction is (-1, 0) in slab space rotated back by
        // the stone's own rot; alpha rides the same master glow as the zone,
        // so the whole assembly brightens and dims as ONE thing.
        {
          const gdx = -Math.cos(rk.rot), gdy = Math.sin(rk.rot);
          const lit = ctx.createLinearGradient(gdx * rk.r, gdy * rk.r, -gdx * rk.r, -gdy * rk.r);
          lit.addColorStop(0, ramLitCol + ramLitA0);
          lit.addColorStop(0.34, ramLitCol + '00');
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = lit;
          ctx.fillRect(-rk.r, -rk.r, rk.r * 2, rk.r * 2);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
        ctx.restore();
      }
      ctx.restore();
    } else if (ramSprGap !== 1 || ramSprVel !== 0 || ramOffX !== null) {
      // No slab: settle everything so the next build starts clean.
      ramSprGap = 1; ramSprVel = 0; ramSprStamp = -1; ramHitPrev = 0; ramDropPrev = 0;
      ramOffX = null; ramOffY = null;
      ramRocksCache = null; ramRocksKey = '';
    }
  }

  // DEFLECTOR ARMED RAIL: a thin bracketed arc across the nose, spanning the
  // exact wedge the parry field scans (PARRY_ARC). This is the reload tell,
  // and it is a STATE, not a meter — no bar, no sweep, no countdown to read.
  // Present = the field can catch; ABSENT ENTIRELY while it reloads, while
  // every slot is full, or while BERTHED (a dock stands the field down, and
  // physics.parryLive is the ONE definition of "can catch" so the rail cannot
  // outlive the field it advertises) — the downed-shield law: the bare nose IS
  // the indicator. It is ship hardware, not aiming UI, so the stroke is SOLID
  // (dashes stay reserved for helper/aiming overlays) and it never moves
  // while it just sits there. The one piece of motion is the POP on the
  // frame it re-arms — one bloom that expands and fades, so "good to go"
  // lands in peripheral vision the way the throw-charge bloom does.
  if (game.st.deflect > 0 && s.invuln <= 0) {
    const z = game.cam.zoom;
    const armed = parryLive(game) &&
      !(game.parry && game.parry.rocks.length >= game.st.deflect);
    if (armed) {
      const pop = game.parryReadyT > 0 ? game.parryReadyT / PARRY_READY_T : 0;   // 1 -> 0
      // THE RAIL IS THE FIELD EDGE, not decoration near it. updateParry
      // catches at s.radius + b.radius + deflectReach, so drawing the rail at
      // s.radius + deflectReach means a rock's own SURFACE meets the rail on
      // exactly the frame the sim freezes it — the rock stops AT the line
      // instead of hanging in space short of it. It also makes every rank-up
      // of the catch bubble something you can see on the ship.
      // The floor keeps the rail off the drawn art: the sprite reaches
      // further than the collision radius, so at rank 1 (field AT the hull,
      // by design) an honest radius would bury the tell inside the hull.
      const R = Math.max(s.radius + game.st.deflectReach, visR * morphScale * 1.06 + 3 / z);
      const a0 = s.angle - PARRY_ARC, a1 = s.angle + PARRY_ARC;
      ctx.strokeStyle = `rgba(159, 214, 255, ${0.5 + 0.45 * pop})`;
      ctx.lineWidth = (1.6 + 2.4 * pop) / z;
      ctx.beginPath(); ctx.arc(s.x, s.y, R, a0, a1); ctx.stroke();
      // End ticks — they turn the arc into a piece of equipment instead of
      // yet another bubble around the ship.
      const tick = 3 / z + R * 0.12;
      for (const a of [a0, a1]) {
        const cx = Math.cos(a), cy = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(s.x + cx * (R - tick * 0.5), s.y + cy * (R - tick * 0.5));
        ctx.lineTo(s.x + cx * (R + tick * 0.5), s.y + cy * (R + tick * 0.5));
        ctx.stroke();
      }
      if (pop > 0) {   // the re-arm bloom, expanding outward as it dies
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(205, 240, 255, ${0.8 * pop})`;
        ctx.lineWidth = 2.5 / z;
        ctx.beginPath();
        ctx.arc(s.x, s.y, R * (1 + (1 - pop) * 0.55), a0, a1);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
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
  const bodyR = tG.bR * uG;   // the drawn body disc radius
  // A SPLIT SCOUT's exhaust rides its DRIVE SECTION, not the origin the whole
  // hull used to share — otherwise the flame hangs in the gap between halves.
  const rearX = -tG.rear * uG - splitX, noseX = tG.nose * uG;
  if (s.thrusting) {
    const burner = !!game.burnerOn;
    // The afterburner plume is nearly twice the flame — the burn should LOOK
    // like an event (it's spending a slow-refilling tank, not a free hold).
    // The whole flame rides the engine SPOOL (physics' s.spool): it grows in
    // over the ramp instead of appearing full-length on the first frame, so
    // the exhaust and the thrust the ship actually has agree.
    const spool = 0.35 + 0.65 * Math.min(1, Math.abs(s.spool ?? 1));
    const f = (1 + Math.sin(game.time * 40) * 0.3) * (1 + lv.thrust * 0.15) * (burner ? 1.9 : 1) * spool;
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

  // GUARD SLING: a beam onto every orbiter currently lunging to block, so the
  // interception reads as the SHIP slinging the rock into the path rather than
  // the rock swimming there under its own power (user design rule, 2026-08).
  // Drawn BEFORE the held beams so a held rock's beam lands on top — the thing
  // in your hand is the thing you are steering, and it should own the fore-
  // ground. Each emitter roots on the bearing to its own defender, the same way
  // the winch roots on its target rather than on the cursor.
  // Iterates game.orbit, never a flag on loose bodies: a rock that has left the
  // ring is never consulted, so a stale guardBeam cannot paint a beam into
  // empty space.
  if (game.orbit.length) {
    for (const b of game.orbit) {
      if (!b.guardBeam) continue;
      const ga = Math.atan2(b.y - s.y, b.x - s.x);
      // GOLD, NOT CYAN (user call, 2026-08). It shipped the same cyan as the
      // hold beam on the reasoning that it is the same tractor doing the same
      // job — but the two fire at once (you are holding a rock exactly when the
      // screen is working for you), and two cyan beams off one hull read as one
      // confused effect rather than two systems. Hue is the only channel free to
      // separate them: they share an emitter, a width band and a moment.
      // CYAN IS WHAT YOU ARE STEERING, GOLD IS WHAT THE SHIP IS DOING FOR YOU —
      // the same split the hover rings already make (cyan = the left button's
      // promise, warm = the right button's).
      // Dimmer and thinner than the hold beam still: the bite is suppressed (the
      // rock is being shoved, not gripped for a throw) and the width runs narrow
      // so a full ring of four defenders does not wash out the cockpit view.
      drawBeam(game, s.x + Math.cos(ga) * bodyR, s.y + Math.sin(ga) * bodyR, b,
        '#ffcf4d', 0.55, 0, false, 0.6);
    }
  }
  if (game.held || game.latch) {
    // Beams sprout from the DRAWN hull edge (bodyR), not the larger hitbox
    const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    // `heavy` is the moon/world read (config.liftClass rungs 3+) — it braids the
    // beam and blooms the bite, so taking a world never looks like taking a rock.
    if (game.held) {
      // THE BEAM RUNS HOT AT FULL POWER, and with the progress ring gone this
      // colour IS the steady-state readout — so it is a real shift (cyan to
      // near-white), not a tint you have to hunt for.
      drawBeam(game, s.x + Math.cos(ang) * bodyR, s.y + Math.sin(ang) * bodyR, game.held,
        game.heldCharged ? '#dcf8ff' : '#5ac8ff', game.heldGrip, beamHeavy(game.held));
      if (game.heldChargeShow) drawCharge(game, game.held);
    }
    // Twin Grip: a second beam to the flanking second rock
    if (game.held2) {
      drawBeam(game, s.x + Math.cos(ang + 0.5) * bodyR, s.y + Math.sin(ang + 0.5) * bodyR, game.held2,
        '#5ac8ff', game.heldGrip2, beamHeavy(game.held2));
    }
    // The winch, when one is running — it has no rock in hand yet. Its emitter
    // roots on the bearing to the TARGET, not to the cursor: once the beam has
    // picked its load the cursor is free to go aim the throw (tractor.updateLatch),
    // and a beam sprouting from the far side of the hull would read as broken.
    if (game.latch) {
      const la = Math.atan2(game.latch.body.y - s.y, game.latch.body.x - s.x);
      drawLatch(game, s.x + Math.cos(la) * bodyR, s.y + Math.sin(la) * bodyR);
    }
  }
}

// 0 for belt rock, ramping to 1 across the moon/world rungs — the one knob that
// makes a big load's beam look like a big load's beam.
function beamHeavy(b) {
  return clamp((liftClass(b) - 2) / 3, 0, 1);
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
    // CFG.LURKER_DRAW holds the on-screen size across the collider bump that
    // made the hitbox match this silhouette — see the note on LURKER_RADIUS.
    // The sprite reaches r*1.7 forward and r*1.3 back, so it must be scaled
    // here or a lurker would simply have grown 30%.
    const r = al.radius * CFG.LURKER_DRAW;
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
  // sim is frozen behind any overlay (splash, shell panel, pause, SPEC card).
  // `choosingUpgrade` is the FREEZE flag and nothing else now — an inline
  // ability offer on the pilot card leaves the sim running, so the forecast
  // keeps drawing under it, which is right: you are still flying.
  if (!game.predict || !game.started || game.paused || shellModal(game) ||
      game.choosingUpgrade || !game.st.hasPredict) return;
  // ION WASH: a solar wave scrambles the forecast outright (the class's `ion`).
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
// Scratch layer for the world discs' scan half — see drawWorldDiscs. Sized to
// the radar's backing store and reused, never per-frame allocated.
let discCv = null, discCx = null;
const RADAR_SIZE = 200;   // CSS px of the #radar canvas (positioned + tilted by style.css)
// Offscreen cache for the dense-field dot layer (see the bake in drawMinimap)
let dotCanvas = null, dotCtx = null, dotBakeT = -1, dotBakeFx = 0, dotBakeFy = 0, dotBakeSeen = 0;

// ---------------------------------------------------------------------------
// THE DOT LAYER'S BAKER: a worker where the platform has one, inline otherwise.
//
// The bake was already cached at ~15Hz, but it still ran on the main thread —
// so one frame in eight paid for ~1900 x (hypot + atan2 + fillRect) all at
// once, which is a periodic hitch rather than a cost the average hides.
// minimap-worker.js does that arithmetic on another thread and hands back a
// finished ImageBitmap; all this side does is fill a reused Float32Array with
// ship-relative dx/dy and post it.
//
// THE FALLBACK IS NOT OPTIONAL. `src/` has to run identically under serve.py
// and inside Electron, and must never assume a capability — if Worker or
// OffscreenCanvas is missing, or the worker fails to construct or throws at
// runtime, dotWorkerDead latches and the original inline bake takes over for
// the rest of the session. The picture is identical either way; only which
// thread drew it changes.
//
// ONE BAKE IS IN FLIGHT AT A TIME. The buffer is TRANSFERRED (neutering this
// side's view), so while it is away there is nothing to fill — a bake that
// lands in that window is simply skipped and the previous bitmap is composited
// again. At 15Hz against a sub-millisecond bake that window is almost never
// open, and a dot layer one extra frame stale is imperceptible (it is already
// deliberately up to 66ms behind).
// ---------------------------------------------------------------------------
let dotWorker = null;        // null until first use, and again if it dies
let dotWorkerDead = false;   // latched: never retry a platform that said no
let dotBitmap = null;        // the last finished layer, composited every frame
let dotBuf = null;           // the ping-pong buffer; null exactly while in flight
// Rock capacity of one post. MINIMAP_FAR (7800) can cover about one whole
// pocket plus the edge of a neighbour, so ~1900-3800 is the realistic load and
// this carries 2x headroom over that. Overflow drops the tail of the walk
// rather than growing the buffer mid-frame — the dropped rocks would be the
// far-edge ones, and the layer visibly stops at a range the dial can't
// resolve anyway.
const DOT_CAP = 8192;
// Per-field "can this pocket reach the dial at all" flags, reused every bake.
const _fieldNear = [];
let dotLastN = 0;   // rocks in the last posted bake (minimapStats)

// Force the inline bake, for exercising the fallback on a platform that has
// workers. That path is the host-agnostic guarantee and would otherwise never
// run on any browser this actually ships to — so it needs a way to be tested:
// `(await import('/src/render.js')).forceMinimapInline(true)`.
let dotForceInline = false;
export function forceMinimapInline(on) {
  dotForceInline = !!on;
  if (!on) { dotWorkerDead = false; return; }   // allow re-arming on the next frame
  if (dotWorker) { dotWorker.terminate(); dotWorker = null; }
  if (dotBitmap) { dotBitmap.close(); dotBitmap = null; }
  dotBuf = null;
  dotWorkerDead = true;
  dotBakeT = -1;   // force a rebake through the inline path
}

// Dot-layer state, for perf work and for proving which path is live. Import it
// from the console like rockCacheStats:
// `(await import('/src/render.js')).minimapStats()`.
export function minimapStats() {
  return {
    path: dotWorker ? 'worker' : (dotWorkerDead ? 'inline (unsupported)' : 'inline (not yet started)'),
    haveBitmap: !!dotBitmap,
    inFlight: dotWorker ? dotBuf === null : false,
    lastPosted: dotLastN,
  };
}

function initDotWorker() {
  if (dotWorker || dotWorkerDead) return;
  if (dotForceInline || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    dotWorkerDead = true;
    return;
  }
  try {
    // import.meta.url, never a page-relative path: it resolves the same under
    // serve.py's http origin and Electron's app:// scheme, which is the whole
    // host-agnostic rule for src/.
    dotWorker = new Worker(new URL('./minimap-worker.js', import.meta.url), { type: 'module' });
    dotWorker.onmessage = (e) => {
      if (dotBitmap) dotBitmap.close();   // an ImageBitmap holds GPU memory until closed
      dotBitmap = e.data.bitmap;
      dotBuf = new Float32Array(e.data.buf);
    };
    // The stale bitmap MUST go with the worker. The composite below prefers
    // dotBitmap over the inline canvas, so a worker that dies after delivering
    // even one bake would pin that frozen layer forever — the inline path
    // would dutifully rebake into dotCanvas and nothing would ever draw it,
    // leaving the dots stuck in space while every other blip tracked the ship.
    dotWorker.onerror = () => {
      dotWorkerDead = true;
      dotWorker = null;
      dotBuf = null;
      if (dotBitmap) { dotBitmap.close(); dotBitmap = null; }
      dotBakeT = -1;   // force the inline path to bake immediately
    };
    dotBuf = new Float32Array(DOT_CAP * 3);
  } catch {
    dotWorkerDead = true;
    dotWorker = null;
  }
}
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
  // A BODY THAT OVERRUNS THE DIAL FADES OUT, IT DOES NOT GET GUILLOTINED.
  // Big discs (the sun, and now every world at true size) routinely reach past
  // the rim, and the dial clip alone ends them on a hard circular cut — which
  // reads as the body having a straight edge there rather than as the RADAR
  // running out of range. This paints them through a radial ramp centred on
  // the dial, so what is in range shows at full strength and only the last
  // sliver softens away. Same reason the world boundary is weather and not a
  // stroke: the instrument's limit is not a feature of the thing it is showing.
  // The same warped circle as a reusable Path2D — a world's disc is now filled
  // MANY times per frame (once per sweep wedge, below), and rebuilding a
  // 97-point path for each of those is the whole cost of the effect.
  const HAS_PATH2D = typeof Path2D === 'function';
  const worldCirclePath2D = (wx, wy, wr) => {
    const p = new Path2D();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * TAU;
      const dx = wx + Math.cos(a) * wr - fx, dy = wy + Math.sin(a) * wr - fy;
      const d = Math.hypot(dx, dy) || 1;
      const rr = radarR(d);
      const x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    return p;
  };
  const DISC_SOLID = 0.86;              // fraction of the rim that stays full
  const discFill = (c2, col, a) => {
    const [tr, tg, tb] = tintOf(col);
    const rgb = `${Math.round(tr * 255)},${Math.round(tg * 255)},${Math.round(tb * 255)}`;
    const gr = c2.createRadialGradient(cx, cy, 0, cx, cy, rim);
    gr.addColorStop(0, `rgba(${rgb},${a})`);
    gr.addColorStop(DISC_SOLID, `rgba(${rgb},${a})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    return gr;
  };
  // Worlds whose SCAN half still has to be painted — filled by the contact
  // loop, drained by drawWorldDiscs below.
  const discQueue = [];

  // Dark well with a faint lit horizon toward the top
  const bg = ctx.createRadialGradient(cx, cy - r * 0.6, r * 0.2, cx, cy, r);
  bg.addColorStop(0, 'rgba(20, 12, 40, 0.82)');
  bg.addColorStop(1, 'rgba(8, 4, 18, 0.88)');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

  // THE DIAL'S OWN CHROME takes the locale accent (zone.js -> game.zone), for
  // the same reason the DOM chrome does — the top-right is ONE instrument, and
  // a radar still lit violet inside a gold or ice-blue cockpit reads as a bug,
  // not as a choice. Grid, scale break, sensor bubble and sweep only: every
  // BLIP below keeps its semantic colour, because a blip's colour is what it IS.
  const zc = game.zone ? game.zone.rgb : [176, 112, 255];
  const acc = (a) => `rgba(${zc[0]}, ${zc[1]}, ${zc[2]}, ${a})`;

  // Grid: range rings + cross axes, barely-there
  ctx.strokeStyle = acc(0.10);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, mid * 0.5, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, mid + rim * 0.25, 0, TAU); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
  ctx.stroke();
  // …and the SCALE BREAK itself, dashed (helper-UI grammar) so the jump in
  // scale is something the eye can see rather than a lie about distance.
  ctx.strokeStyle = acc(0.28);
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
    ctx.fillStyle = acc(0.05);
    ctx.beginPath(); ctx.arc(cx, cy, seeR, 0, TAU); ctx.fill();
    ctx.strokeStyle = acc(0.22);
    ctx.beginPath(); ctx.arc(cx, cy, seeR, 0, TAU); ctx.stroke();
  }

  // The sun sits at the world origin: the wave and the world edge both circle
  // it, sampled through the warp (the clip discards whatever falls outside).
  const dSun = Math.hypot(fx, fy);
  if (game.storm) {
    // The SHEATH, not just the shock — the dial has to show the thing you can
    // actually be caught in, and the shock alone is a hairline. Three rings
    // stepping back through the tail read as depth without a fill (which the
    // radial warp would distort into a lie about where the tail ends). Both the
    // depth and the colour are the WAVE'S: the instrument has to say which of
    // the three is out there, and a squall's sheath is genuinely a thinner band
    // on the dial because it is a thinner band in the sky.
    // …and it fades with the wave (st.k), so the dial shows a front SPENDING
    // ITSELF rather than one that is fine right up until it disappears.
    const st = game.storm, kk = st.k ?? 1;
    for (let i = 3; i >= 1; i--) {
      const rr = st.r - st.tail * (i / 3.4);
      if (rr <= 0) continue;
      ctx.strokeStyle = `rgba(${st.warm}, ${(0.06 + 0.04 * (3 - i)) * kk})`;
      ctx.lineWidth = 5;
      worldCirclePath(0, 0, rr); ctx.stroke();
    }
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(${st.shock}, ${0.16 * kk})`;
    worldCirclePath(0, 0, st.r); ctx.stroke();
    ctx.strokeStyle = `rgba(${st.core}, ${0.7 * kk})`;
    ctx.lineWidth = 1.5;
    worldCirclePath(0, 0, st.r); ctx.stroke();
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
    // Registry, not a find: cheap only while the sun happens to sit at index 0,
    // and a full ~15,600-body walk per frame the moment it does not.
    const sun = frameReg(game).stars.find(b => b.alive);
    if (sun && dSun - sun.radius < MINIMAP_FAR) {
      // No rim stroke (user call): an outline is an ANNOTATION, and it drew a
      // hard edge exactly where the dial's own limit was already cutting the
      // disc — so the sun read as a bordered token laid on the radar rather
      // than as light the scan is picking up. The wash alone is the body.
      ctx.fillStyle = discFill(ctx, '#ffc869', 0.28);
      worldCirclePath(sun.x, sun.y, sun.radius); ctx.fill();
    }
  }

  // Radar sweep: a trailing glow wedge behind a bright leading edge, spinning
  // around the ship. Runs on game.time, so it freezes with the sim behind menus.
  const sweepAng = (game.time * TAU / MINIMAP_SWEEP_T) % TAU;
  if (ctx.createConicGradient) {
    const sweep = ctx.createConicGradient(sweepAng, cx, cy);
    sweep.addColorStop(0, acc(0));
    sweep.addColorStop(0.8, acc(0));
    sweep.addColorStop(1, acc(0.20));
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
  // ...AND THE SAME THING FOR A BODY THAT IS A REGION RATHER THAN A POINT.
  // A contact drawn at true size SUBTENDS AN ARC, and asking when the beam
  // "touched it" has to mean when the beam touched ANY of it. Reading the
  // centre bearing alone is the identical mistake the dense-field loop below
  // documents — "one shared age made a pocket this wide strobe as a single
  // slab" — and on a world it is worse, because the disc is one object: parked
  // beside a giant that spans 120° of the dial, the whole thing blinked on
  // only as the beam crossed its CENTRE, and showed nothing while the beam was
  // physically sitting on its near edge.
  //
  // So the age is measured from the arc, not the point: it is ZERO for as long
  // as the sweep is anywhere within the body's own angular span, and only then
  // starts counting from the span's trailing edge. A point-like body has a span
  // of ~0 and comes out exactly where sweepAge left it, which is why this can
  // safely serve the whole contact loop.
  const sweepAgeOf = (dx, dy, radius) => {
    let lag = sweepAng - Math.atan2(dy, dx);
    lag %= TAU; if (lag < 0) lag += TAU;
    let half = 0;
    if (radius > 0) {
      const d = Math.hypot(dx, dy) || 1;
      // Guard before the asin: under ~1.1° of arc this is a pip and the whole
      // correction is below a pixel, so the trig is skipped for almost every
      // contact on the dial. Inside the body (radius >= d) the ship is under it
      // and every bearing is its bearing.
      if (radius >= d) half = Math.PI;
      else if (radius > d * 0.02) half = Math.asin(radius / d);
    }
    if (half > 0 && lag >= TAU - half) return 0;   // beam already inside the leading edge
    const a = lag - half;
    return a <= 0 ? 0 : a * MINIMAP_SWEEP_T / TAU;
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
    initDotWorker();
    const worker = dotWorker;
    // ROUNDED on both sides. canvas.width truncates to an integer, so an
    // un-rounded comparison against a fractional rdpr (200 * 1.1 is
    // 220.00000000000003 at 110% display scaling) is true EVERY frame — the
    // canvas is rebuilt and the whole layer rebaked once per frame, which is
    // the exact cost this cache exists to avoid. The worker path already
    // rounds (minimap-worker.js); this is the same expression.
    const dotPx = Math.max(1, Math.round(RADAR_SIZE * rdpr));
    if (!worker && (!dotCanvas || dotCanvas.width !== dotPx)) {
      dotCanvas = document.createElement('canvas');
      dotCanvas.width = dotCanvas.height = dotPx;
      dotCtx = dotCanvas.getContext('2d');
      dotBakeT = -1;
    }
    let seenMask = 0;
    for (let i = 0; i < game.fields.length; i++) if (game.fields[i].seen) seenMask |= 1 << i;
    // WHOLE-FIELD REJECT, ahead of the per-rock walk. A pocket whose centre is
    // further than the dial's reach plus its own longest lobe cannot put a
    // single rock on the dial — and testing that once per FIELD replaces a
    // hypot per ROCK for every shoal you are nowhere near. With four fields
    // and one of them in range that is ~5700 hypots a bake that simply stop
    // happening; it is also what keeps the cost flat as fields are added.
    const reach = MINIMAP_FAR + CFG.FIELD_LEN * (FIELD_LOBE_MAX * 1.35);
    const near = _fieldNear;
    near.length = game.fields.length;
    for (let i = 0; i < game.fields.length; i++) {
      const f = game.fields[i];
      near[i] = f.seen && Math.hypot(f.x - fx, f.y - fy) < reach;
    }
    if (game.time < dotBakeT || game.time - dotBakeT > 0.066 ||
        seenMask !== dotBakeSeen || Math.hypot(fx - dotBakeFx, fy - dotBakeFy) > 60) {
      if (worker) {
        // Worker path: fill the ping-pong buffer with ship-relative positions
        // and hand it over. Skipped outright while a bake is in flight (dotBuf
        // null) — the last bitmap simply composites again.
        const buf = dotBuf;
        if (buf) {
          dotBakeT = game.time; dotBakeFx = fx; dotBakeFy = fy; dotBakeSeen = seenMask;
          let n = 0;
          for (const b of game.bodies) {
            const fi = b.field;
            if (fi == null || !near[fi] || !b.alive) continue;
            const dx = b.x - fx, dy = b.y - fy;
            // Box reject: the worker does the true circle test, so this side
            // never pays a sqrt.
            if (dx > MINIMAP_FAR || dx < -MINIMAP_FAR ||
                dy > MINIMAP_FAR || dy < -MINIMAP_FAR) continue;
            const o = n * 3;
            buf[o] = dx; buf[o + 1] = dy; buf[o + 2] = b.giant ? 1 : 0;
            if (++n >= DOT_CAP) break;
          }
          dotLastN = n;
          dotBuf = null;   // transferred: neutered here until the worker returns it
          worker.postMessage({
            buf: buf.buffer, n, size: RADAR_SIZE, rdpr, cx, cy,
            near: MINIMAP_NEAR, far: MINIMAP_FAR, mid, scale,
            sweepAng, sweepT: MINIMAP_SWEEP_T, pingT: MINIMAP_PING_T,
          }, [buf.buffer]);
        }
      } else {
        dotBakeT = game.time; dotBakeFx = fx; dotBakeFy = fy; dotBakeSeen = seenMask;
        const dc = dotCtx;
        dc.setTransform(rdpr, 0, 0, rdpr, 0, 0);
        dc.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
        dc.fillStyle = '#a2937d';   // belt-rock tan: terrain, not the blip palette
        for (const b of game.bodies) {
          const fi = b.field;
          if (fi == null || !near[fi] || !b.alive) continue;   // fog is field-level, like the scan
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
    }
    // Composite inside the dial clip; the source (worker bitmap or inline
    // canvas) is at RADAR_SIZE x rdpr either way, so it lands in the dpr
    // transform identically. Nothing to draw on the first frames while the
    // worker's first bake is still in flight.
    const layer = dotBitmap || (worker ? null : dotCanvas);
    if (layer) ctx.drawImage(layer, 0, 0, RADAR_SIZE, RADAR_SIZE);
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

  // ION WASH: a solar wave doesn't dim the radar, it EATS it.
  // Returns drop out at random and the survivors smear off their true bearing,
  // so the dial is actively lying rather than politely fading — losing the
  // instrument you navigate by is the point of being caught in a wave.
  // Math.random per blip on purpose: the dropout has to boil, and this is
  // render, which is downstream of the sim and owes it no determinism.
  // Normalised against the class that SET it (game.stormIonMax), not a CFG
  // constant: stormIonT outlives its wave, so a fixed divisor would read a
  // squall's 2s scramble as 40% of a CME's and start the dial half-eaten.
  const ion = Math.min(1, (game.stormIonT || 0) / (game.stormIonMax || 1));

  // Blips glow — shadowBlur is fine at these counts (a few dozen, once/frame)
  ctx.shadowBlur = 5;
  // Non-field registry: shoal rock is TERRAIN and has its own cached dot layer
  // above — it was reaching this loop only to be rejected by the fog test, one
  // hypot at a time, ~15,000 times a frame.
  for (const b of frameReg(game).nonField) {
    if (b.type === 'star') continue;               // drawn as a real disc, above
    if (ion > 0 && Math.random() < ion * 0.82) continue;
    const dx = b.x - fx, dy = b.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    // RANGE IS TO THE NEAREST EDGE, NOT THE CENTRE — for anything drawn at true
    // size. A world is up to 1,935 units across, so culling on its centre made
    // a giant POP out of the dial while a third of its disc was still solidly
    // inside radar range (user call: the part that is over the line "should
    // show fully"). The sun's own draw above has always measured this way; this
    // is the same rule, now that worlds are discs too. Everything still drawn
    // as a pip keeps the plain centre test.
    // A WORLD IS A REGION ON EVERY TEST THE DIAL MAKES, not just this one: its
    // range is to the NEAREST EDGE (here and for the inner/outer band below),
    // and its sweep age is taken over its whole arc (sweepAgeOf). Reading any
    // one of the three off the centre puts a planet in the wrong half of the
    // dial, or pops it out of range, or strobes it — all while the disc the
    // player is looking at plainly straddles the line in question.
    const edge = b.type === 'planet' ? Math.max(0, d - b.radius) : d;
    if (edge > MINIMAP_FAR) continue;              // beyond radar range
    const outer = edge > MINIMAP_NEAR;
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
    const age = sweepAgeOf(dx, dy, b.type === 'planet' ? b.radius : 0);
    // A DISC STRADDLES THE SCALE BREAK, SO IT TAKES BOTH RULES AT ONCE (user
    // call). The dial is two instruments sharing one face: inside MINIMAP_NEAR
    // it is a chart and a contact PERSISTS, outside it is a scan and a contact
    // exists only for MINIMAP_PING_T after the beam touches it. A point can
    // only ever be in one of those halves, so a single alpha was always enough
    // — but a world at true size is routinely in BOTH, and picking one rule for
    // the whole body is wrong at one end of it no matter which rule you pick:
    // the near half blinks out with the ping, or the far half never fades.
    // So the disc is drawn twice under complementary clips, each half taking
    // its own half's rule. `outer` still decides everything a PIP does.
    const aIn = sweepFlare(age), aOut = sweepPing(age);
    const asDisc = b.type === 'planet' && b.seen &&
      (radarR(d + b.radius) - radarR(Math.max(0, d - b.radius))) / 2 >= 2.5;
    const alpha = outer ? aOut : aIn;
    // A disc reaching inside the break always has something to show (the flare
    // has a floor), so it is only skippable when it is wholly in the scan half
    // AND that half has gone dark.
    if (asDisc ? (outer && aOut <= 0.01) : alpha <= 0.01) continue;
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
      // A WORLD IS DRAWN AT ITS TRUE SIZE (2026-08 user call), exactly like the
      // sun above and for the same reason: a flat 2.5px pip said a 359-unit
      // rock and a 1,935-unit giant were the same object. That was survivable
      // when a world was a place you flew past; it is not now that its RADIUS
      // is what decides whether you can land on it, take off from it again, or
      // whip around it — SURFACE WEIGHT keys the whole ladder off size, so the
      // one instrument you fly the approach on has to show it. Range 5200 over
      // a 91px dial makes this genuinely legible: Pyrris reads ~6px, Corve ~20,
      // Vashtar ~34.
      // Sampled through the piecewise warp (worldCirclePath), so a disc
      // straddling the scale break is drawn pinched, as the dial's own geometry
      // says it must be — and the dial clip keeps an over-rim world from
      // spilling, which is what preserves "the scan shows nothing past its rim".
      if (asDisc && HAS_PATH2D) {
        // A WASH, NOT A DISC WITH A BORDER (user call — same reasoning as the
        // sun above). A filled blob would also bury every contact drawn over
        // it, which is the other half of why the alpha stays low.
        const disc = worldCirclePath2D(b.x, b.y, b.radius);
        // THE INNER HALF IS A CHART: it persists, so it is one fill at the
        // region flare — the beam brightens it as it crosses but never takes
        // it away. Nothing is drawn if the world does not reach inside the
        // break; the clip decides that, so no geometry test is needed.
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, mid, 0, TAU); ctx.clip();
        ctx.globalAlpha = aIn;
        ctx.fillStyle = discFill(ctx, col, 0.34);
        ctx.fill(disc);
        ctx.restore();
        // ...and the SCAN half is deferred to one masked pass (drawWorldDiscs,
        // after this loop) so the beam wipes across it per PIXEL.
        if (!outer || aOut > 0.0001) discQueue.push({ path: disc, col, aOut });
        ctx.globalAlpha = alpha;
        ctx.fillStyle = col;                  // restore for the fort marker below
      } else {
        // Floor: out in the half-scale band a small world would sink under the
        // blip size and read as a moon. The pip IS the old behaviour.
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
      }
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

  // THE SCAN HALF OF EVERY WORLD DISC, IN ONE MASKED PASS.
  //
  // The beam has to wipe ACROSS a world rather than light all of it at once —
  // a giant spans up to 77° of the dial from close range, so the beam is
  // physically on its near edge for most of a second before it reaches the far
  // one. The dense-field loop learned the same thing ("one shared age made a
  // pocket this wide strobe as a single slab") and answered it per rock,
  // because a field IS many objects. A world is one object, so the answer is a
  // MASK (user call): the sweep carries its own alpha ramp, and the disc's own
  // alpha is multiplied by it.
  //
  // Done as a composite rather than as angular wedges — which is what this
  // first was — for three reasons: it is per-PIXEL instead of per-4°, it costs
  // one mask and one blit for the WHOLE sky instead of ~20 clipped fills per
  // world, and the disc keeps its radial rim fade, which a conic fillStyle
  // could not have carried at the same time.
  // THE MASK IS THE FEATURE, SO ITS ABSENCE IS A FALLBACK AND NOT A NO-OP.
  // Without createConicGradient there is nothing to multiply the sweep into the
  // discs, and blitting them anyway would leave the scan half PERMANENTLY lit —
  // a world that never fades is the one thing the outer band must never show,
  // since "the dial forgets the moment the sweep passes" is what buys its
  // doubled reach. Caught in review. So on that path the layer is skipped
  // entirely and each disc is drawn straight into the annulus at its own
  // whole-body ping instead: coarser (the world lights at once rather than
  // wiping in), correct on the rule that matters, and exactly what this drew
  // before the mask existed.
  const canMask = HAS_PATH2D && typeof ctx.createConicGradient === 'function';
  if (discQueue.length && HAS_PATH2D && !canMask) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.arc(cx, cy, mid, 0, TAU, true);
    ctx.clip();
    for (const q of discQueue) {
      if (q.aOut <= 0.01) continue;
      ctx.globalAlpha = q.aOut;
      ctx.fillStyle = discFill(ctx, q.col, 0.34);
      ctx.fill(q.path);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  if (discQueue.length && canMask) {
    const px = Math.max(1, Math.round(RADAR_SIZE * rdpr));
    if (!discCv || discCv.width !== px) {
      discCv = document.createElement('canvas');
      discCv.width = discCv.height = px;
      discCx = discCv.getContext('2d');
    }
    if (discCx) {
      discCx.setTransform(rdpr, 0, 0, rdpr, 0, 0);
      discCx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
      // 1. the discs, at their own (radially faded) alpha
      for (const q of discQueue) {
        discCx.fillStyle = discFill(discCx, q.col, 0.34);
        discCx.fill(q.path);
      }
      // 2. multiply in the SWEEP'S OWN alpha ramp. The conic runs from the beam
      // (t=0) the whole way round, so a bearing's parameter t maps to an age of
      // (1-t) x SWEEP_T — bright just BEHIND the beam, dark everywhere the beam
      // has not reached since. The stops walk sweepPing's own k² curve so the
      // mask and the pip fade are the same function, not two that resemble
      // each other.
      let masked = false;
      if (discCx.createConicGradient) {
        const m = discCx.createConicGradient(sweepAng, cx, cy);
        const t0 = 1 - MINIMAP_PING_T / MINIMAP_SWEEP_T;   // where the tail dies
        m.addColorStop(0, 'rgba(0,0,0,0)');
        m.addColorStop(t0, 'rgba(0,0,0,0)');
        for (let i = 1; i <= 4; i++) {
          const u = i / 4;                                  // 0..1 along the tail
          m.addColorStop(t0 + (1 - t0) * u, `rgba(0,0,0,${(u * u).toFixed(3)})`);
        }
        discCx.globalCompositeOperation = 'destination-in';
        discCx.fillStyle = m;
        discCx.fillRect(0, 0, RADAR_SIZE, RADAR_SIZE);
        discCx.globalCompositeOperation = 'source-over';
        masked = true;
      }
      // 3. blit, clipped to the scan annulus — the chart half was already
      // painted inline and must not be masked. Gated on the mask having
      // ACTUALLY been applied: an unmasked blit is the persistent-contact bug
      // the fallback above exists to avoid, and skipping the blit is the safe
      // side of that choice (a missing return, never a lying one).
      if (masked) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.arc(cx, cy, mid, 0, TAU, true);        // reversed winding = hole
        ctx.clip();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(discCv, 0, 0);
        ctx.setTransform(rdpr, 0, 0, rdpr, 0, 0);
        ctx.restore();
      }
    }
  }

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
    for (const b of frameReg(game).stations) {
      if (!b.alive) continue;
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

  // YOUR DOCKS, on the dial. They break the radar's forgetting rule the way the
  // rescue dock and the journey do, and for the same reason: a station is not a
  // CONTACT, it is a place you built, and a bearing home that blinked out with
  // every sweep would be useless. RIM-PINNED past the dial's reach — the whole
  // value of the mark is "which way is it from here", and it is usually well
  // outside 7,800 units.
  //
  // The HOME PORT is loud (rose, labelled, matching the pad sprite and the life
  // pips — see DOCK_HOME); every other station is a small steel berth glyph, so
  // the dial says "you have somewhere to go" without four docks competing with
  // the one that matters. Drawn before the journey so an active route's next
  // stop stays the loudest thing on the instrument.
  if (game.docks) for (const dk of game.docks) {
    // Same `b.hidden` rule as the chart: a rim-pinned bearing leaks less than a
    // sun-centred plot, but "nothing, ever" has no instrument exceptions.
    if (!dk.b.alive || dk.b.hidden) continue;
    const isHome = game.home === dk;
    const done = dockReady(dk);
    const p = padPos(dk);
    const dx = p.x - fx, dy = p.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    const rr = Math.min(radarR(d), r - 9);
    const x = cx + (dx / d) * rr, y = cy + (dy / d) * rr;
    const ink = isHome ? DOCK_HOME : DOCK_STEEL;
    // The berth glyph, not a blip: a ring under a roof, solid — a real
    // structure on the map draws like one. Dim while it is still going up.
    const a = done ? 1 : 0.4;
    const sc = isHome ? 1 : 0.72;
    ctx.strokeStyle = `rgba(${ink}, ${0.95 * a})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 3.4 * sc, 0, TAU); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 4.6 * sc, y + 1.4 * sc); ctx.lineTo(x, y - 3 * sc);
    ctx.lineTo(x + 4.6 * sc, y + 1.4 * sc);
    ctx.stroke();
    if (!isHome) continue;                                 // only home is worth a word
    const lx = x - (dx / d) * 13, ly = y - (dy / d) * 13;  // tag pulled inward, never clipped
    ctx.font = '600 7px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(${ink}, 0.8)`;
    ctx.fillText('HOME', lx, ly + 2.5);
    ctx.textAlign = 'left';
  }

  // THE JOURNEY, on the dial. The chart is where a route is PLOTTED; the radar
  // is where it is FLOWN, so the dial has to carry it without the panel open.
  // The whole path is drawn faint and the NEXT stop is the loud one — the same
  // "one live marker, the rest is context" shape as the rescue display above.
  //
  // A stop past the dial's reach PINS TO THE RIM (like the Wanderer's Star and
  // the dock): a bearing you can fly is the entire point, and a marker that
  // simply vanishes at 7,800 units would drop the route exactly when you are
  // furthest from it and need it most. It rides the radial warp everywhere
  // inside that, so its range on the dial is honest.
  if (game.route && game.route.length) {
    const legs = [{ x: cx, y: cy }];
    for (const wp of game.route) {
      const p = waypointPos(game, wp);
      const dx = p.x - fx, dy = p.y - fy;
      const d = Math.hypot(dx, dy) || 1;
      const rr = Math.min(radarR(d), r - 9);
      legs.push({ x: cx + (dx / d) * rr, y: cy + (dy / d) * rr, pinned: radarR(d) > r - 9 });
    }
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${INK}, 0.34)`;
    ctx.beginPath();
    ctx.moveTo(legs[0].x, legs[0].y);
    for (let i = 1; i < legs.length; i++) ctx.lineTo(legs[i].x, legs[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = legs.length - 1; i >= 1; i--) {   // next stop drawn LAST = on top
      const p = legs[i];
      const next = i === 1;
      const d = next ? 4.5 : 3;
      if (next) {
        const k = (game.time * 0.9) % 1;
        ctx.strokeStyle = `rgba(${INK_HOT}, ${0.1 + 0.4 * k})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 12 - 8 * k, 0, TAU); ctx.stroke();
      }
      ctx.fillStyle = `rgba(${next ? INK_HOT : INK}, ${next ? 0.95 : 0.6})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d, p.y); ctx.lineTo(p.x, p.y + d); ctx.lineTo(p.x - d, p.y);
      ctx.closePath(); ctx.fill();
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
  ctx.strokeStyle = acc(0.55);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
  ctx.strokeStyle = acc(0.12);
  ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(cx, cy, r + 2.5, 0, TAU); ctx.stroke();
  ctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const cardinal = i % 6 === 0;
    const len = cardinal ? 7 : 3.5;
    ctx.strokeStyle = cardinal ? 'rgba(235, 218, 255, 0.8)' : acc(0.35);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
    ctx.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1));
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// THE SYSTEM CHART. starmap.js owns the model — the projection, the knowledge
// ladder, the route; this paints it. Its own canvas at NATIVE dpr, for exactly
// the reason the radar has one: the chart is an instrument made of hairlines
// and 2px marks, and render scale must soften the picture, never the readouts.
//
// The whole thing is drawn only while the panel is open, and the panel is a
// shell modal, so the sim behind it is frozen: this is the one draw in the file
// that can spend freely. It still culls, because a chart at zoom 60 has most of
// the system off screen and there is no reason to path it.
//
// CHART INK is the chrome family, and deliberately not any instrument's colour
// (hull green, shield cyan, lives rose, alarm ember, the gold score and lead
// ✕). A route is a UI CONSTRUCT — a thing you decided, not a thing that is out
// there — and painting a plan in an instrument's colour would make a journey
// read as a warning.
const INK = '198, 170, 255';
const INK_HOT = '236, 222, 255';
let mapCanvas = null, mctx = null;

// The chart's own star dust: seeded ONCE, at module load, so the field behind
// the system is the same sky every time the panel opens. Re-rolling it per
// frame would be static hissing over an instrument; re-rolling it per open
// would quietly say the stars had moved.
const chartDust = (() => {
  const rng = mulberry32(90210);
  const out = [];
  for (let i = 0; i < 260; i++) {
    out.push({
      x: rng() * 22, y: rng() * 14,
      b: 0.05 + rng() * rng() * 0.4,
      s: rng() < 0.86 ? 1 : 1.8,
    });
  }
  return out;
})();

// Class colours MIRROR the radar's blip palette on purpose: a moon must not be
// one colour on the dial and another on the chart, or the two instruments stop
// being the same machine. A planet keeps its own colour, which is what makes a
// charted sky read as a sky rather than as a legend.
function contactColor(b) {
  if (b.tinker) return '#ffcf8a';
  if (b.ghost) return '#8ea0b8';
  if (b.type === 'planet' || b.type === 'rogue') return b.dark ? '#b89aff' : b.color;
  if (b.type === 'moon') return '#9fb6cc';
  if (b.type === 'nest') return '#7ec95f';
  if (b.type === 'station') return '#c9d6e4';
  if (b.visitor) return '#ffd9a8';
  if (b.comet) return '#8fe8ff';
  return '#aab6c8';
}

// '#rrggbb' -> 'r, g, b', memoised. The chart builds a radial gradient per
// contact per frame and every stop needs that colour at its own alpha — a fresh
// parseInt triple for each of ~85 marks is pure repeat work over a palette of
// maybe a dozen colours.
const rgbCache = new Map();
function hexRgb(hex) {
  let v = rgbCache.get(hex);
  if (v === undefined) {
    v = `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
    rgbCache.set(hex, v);
  }
  return v;
}

// Does this contact print its OWN name on the chart? Worlds always; the smaller
// landmarks only once the chart is zoomed in enough to have room for the words
// (at the fit scale a RELAY STATION plate lands straight on top of the world it
// orbits); moons never — they are icons, and their host names them.
//
// One predicate, because the ROUTE reads it too: a stop pinned to a body that
// is already labelled must not print the same word a second time three pixels
// below it.
const POI_LABEL_ZOOM = 2.5;
// Zoom at which a charted world's moon lanes START to appear (they fade in over
// the next 5). Deliberately well past the zoom that makes the moons themselves
// legible: the moons say "this world has a household", which is worth knowing
// from a distance; the lanes say "and here is each one's orbit", which is only
// worth drawing once they read as separate rings.
const MOON_LANE_ZOOM = 4;
function labelsItself(game, b) {
  if (contactLevel(game, b) !== 'charted') return false;
  if (b.type === 'planet' || b.type === 'rogue') return true;
  if (b.type === 'moon') return false;
  return chart.zoom >= POI_LABEL_ZOOM;
}

// The 1-2-5 ladder: the nearest round number at or above `target`. Both the
// range rings and the scale bar go through it, so the bar always measures a
// whole number of rings — a fixed 10k step would be a wall of rings at the fit
// scale and none at all once you are inside one planet's family, and a bar that
// disagreed with the rings would make the chart lie to itself.
function niceStep(target) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
  const n = Math.max(1, target) / mag;
  return mag * (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10);
}

export function drawStarMap(game) {
  if (!mapCanvas) mapCanvas = document.getElementById('starmap');
  if (!mapCanvas) return;
  if (!mctx) mctx = mapCanvas.getContext('2d');
  const ctx = mctx;   // shadow the module ctx for this function's scope, like the radar
  // Sized here rather than in resize(): the chart is a full-window backing
  // store and there is no reason to hold one before the panel has ever been
  // opened. Rounded on both sides for the same reason the dot cache is — a
  // fractional dpr makes an un-rounded compare true every frame.
  const pxW = Math.max(1, Math.round(vw * rdpr)), pxH = Math.max(1, Math.round(vh * rdpr));
  if (mapCanvas.width !== pxW || mapCanvas.height !== pxH) {
    mapCanvas.width = pxW; mapCanvas.height = pxH;
  }
  ctx.setTransform(rdpr, 0, 0, rdpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);

  const s = chartScale(vw, vh);
  const toX = (wx) => vw / 2 + (wx - chart.cx) * s;
  const toY = (wy) => vh / 2 + (wy - chart.cy) * s;
  const sunX = toX(0), sunY = toY(0);
  const scrR = Math.hypot(vw, vh) / 2;          // screen "radius" for ring culling
  const sunD = Math.hypot(sunX - vw / 2, sunY - vh / 2);
  const zc = game.zone ? game.zone.rgb : [176, 112, 255];
  const acc = (a) => `rgba(${zc[0]}, ${zc[1]}, ${zc[2]}, ${a})`;

  // ---- THE BED. Not a black rectangle: a lit instrument with space behind it.
  // Four layers, cheapest first — the panel is a shell modal so the sim under
  // it is frozen and this is the one draw in the file that can spend freely.
  ctx.fillStyle = '#04050e';
  ctx.fillRect(0, 0, vw, vh);
  // 1. Star dust, parallaxed with the view. Seeded once and reused, so the
  //    field is the SAME sky every time the chart opens rather than static
  //    hissing over the top of it. It rides the pan at a fraction of the rate,
  //    which is what makes the chart feel like a window rather than a page.
  {
    const par = 0.06;
    const ox = -chart.cx * s * par, oy = -chart.cy * s * par;
    const cell = 190;
    ctx.globalCompositeOperation = 'lighter';
    for (const d of chartDust) {
      let x = (d.x * cell + ox) % (vw + cell); if (x < 0) x += vw + cell;
      let y = (d.y * cell + oy) % (vh + cell); if (y < 0) y += vh + cell;
      ctx.fillStyle = `rgba(198, 206, 255, ${d.b})`;
      ctx.fillRect(x - cell / 2, y - cell / 2, d.s, d.s);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // 2. The star's light pooling through the whole inner system.
  {
    const g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, Math.max(80, CHART_R * s * 0.62));
    g.addColorStop(0, 'rgba(255, 186, 90, 0.2)');
    g.addColorStop(0.35, 'rgba(150, 90, 200, 0.09)');
    g.addColorStop(1, 'transparent');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
    ctx.globalCompositeOperation = 'source-over';
  }
  // 3. Scanlines — the panel kit's own texture, so the chart reads as the same
  //    machine as every slab of chrome sitting on it.
  ctx.fillStyle = 'rgba(180, 150, 255, 0.022)';
  for (let y = 0; y < vh; y += 3) ctx.fillRect(0, y, vw, 1);
  // 4. Vignette: the glass is lit from the middle, and the corners fall away.
  {
    const g = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.3,
      vw / 2, vh / 2, Math.hypot(vw, vh) * 0.62);
    g.addColorStop(0, 'transparent');
    g.addColorStop(1, 'rgba(2, 2, 8, 0.75)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }

  // ---- Range rings from the star, dashed (helper-UI grammar) with their range
  // printed on the ring itself. This is what makes the chart a chart: "how far
  // out is that?" is the question a system map exists to answer.
  const spanW = Math.min(vw, vh) / s;
  // FEW rings (user call). ~2-3 out from the star across the view: they are
  // there to give the eye a sense of scale, not to divide the system into
  // bands — at one ring per 10% of the span the chart was a target, and the
  // system inside it stopped being the thing you were looking at.
  const step = niceStep(spanW / 5);
  ctx.lineWidth = 1;
  ctx.font = '500 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (let r = step; r <= CHART_R * 1.25; r += step) {
    const rp = r * s;
    if (rp < 26 || rp - sunD > scrR || sunD - rp > scrR) continue;
    ctx.strokeStyle = acc(0.17);
    ctx.setLineDash([2, 6]);
    ctx.beginPath(); ctx.arc(sunX, sunY, rp, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    // Label up-and-right of the star, where the ring is least likely to be
    // crossing a busy lane of marks.
    const lx = sunX + rp * 0.707, ly = sunY - rp * 0.707;
    if (lx > -40 && lx < vw + 40 && ly > 0 && ly < vh) {
      ctx.fillStyle = acc(0.5);
      ctx.fillText(r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `${r | 0}`, lx + 5, ly - 4);
    }
  }

  // ---- The world edge: the Oort wall's icy band with the kill line at its
  // foot. Same reading as the dial and as the sky itself.
  {
    const rp = CFG.WORLD_R * s;
    if (rp - sunD < scrR && sunD - rp < scrR) {
      ctx.strokeStyle = 'rgba(150, 200, 255, 0.13)';
      ctx.lineWidth = Math.max(6, 240 * s);
      ctx.beginPath(); ctx.arc(sunX, sunY, rp + 240 * s, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 130, 120, 0.42)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sunX, sunY, rp, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // ---- A live solar wave. The chart is where you can actually SEE which side
  // of the system a front has reached, which the ship-centred dial cannot say.
  if (game.storm) {
    const st = game.storm, kk = st.k ?? 1;
    const rp = st.r * s;
    if (rp - sunD < scrR) {
      ctx.strokeStyle = `rgba(${st.warm}, ${0.14 * kk})`;
      ctx.lineWidth = Math.max(3, st.tail * s);
      ctx.beginPath(); ctx.arc(sunX, sunY, rp - st.tail * s * 0.5, 0, TAU); ctx.stroke();
      ctx.strokeStyle = `rgba(${st.core}, ${0.8 * kk})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sunX, sunY, rp, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  const reg = frameReg(game);

  // ---- Orbit lanes, for CHARTED bodies only. A lane is knowledge: you learn
  // where a world goes by reading its plate, not by catching a glimpse of it.
  // Skipped below a few pixels across — a moon's lane at the fit scale is a dot
  // on a dot, and drawing 59 of them is how a chart turns into a smudge.
  // `zk` is the chart's LOD knob — 0 at the fit scale, 1 by zoom 4. The contact
  // marks below ride it: small contacts grow into real marks as you close in
  // rather than smearing the inner system at the width where the chart's job is
  // to show the system's SHAPE, not its contents.
  const zk = clamp((chart.zoom - 1) / 3, 0, 1);
  // A MOON'S LANE HAS ITS OWN, LATER THRESHOLD (user call). It rides `mk`, not
  // `zk`: a family's lanes are only worth drawing once they are separate rings
  // rather than a smudge around the disc, and that is several zoom steps past
  // the point where the moons themselves become legible pips.
  const mk = clamp((chart.zoom - MOON_LANE_ZOOM) / 5, 0, 1);
  ctx.lineWidth = 1.2;
  ctx.globalCompositeOperation = 'lighter';
  for (const b of reg.nonField) {
    if (!isContact(b) || contactLevel(game, b) !== 'charted') continue;
    const rail = b.rail;
    const p = rail && rail.parent;
    if (!p || !p.alive) continue;
    const moon = b.type === 'moon';
    if (moon && mk <= 0.01) continue;
    // A LANE IS BRIGHTEST WHERE THE BODY IS, and fades away around the ring.
    // Drawn flat it was a hoop of equal weight everywhere, which says "this
    // whole circle is equally the subject" — the body is the subject, and the
    // lane is context that should thin out the further it gets from it.
    //
    // One conic gradient centred on the parent, its start angle pinned to the
    // body's own bearing, so the falloff is symmetric and costs one stroke
    // rather than forty short ones. createConicGradient is feature-checked for
    // the same host-agnostic reason drawMinimap checks it: `src/` may never
    // assume a capability, and a flat stroke is a perfectly honest fallback.
    const peak = moon ? 0.34 * mk : 0.42;
    if (ctx.createConicGradient) {
      const cg = ctx.createConicGradient(Math.atan2(b.y - p.y, b.x - p.x), toX(p.x), toY(p.y));
      cg.addColorStop(0, acc(peak));
      cg.addColorStop(0.1, acc(peak * 0.42));
      cg.addColorStop(0.42, acc(peak * 0.06));
      cg.addColorStop(0.58, acc(peak * 0.06));
      cg.addColorStop(0.9, acc(peak * 0.42));
      cg.addColorStop(1, acc(peak));
      ctx.strokeStyle = cg;
    } else {
      ctx.strokeStyle = acc(peak * 0.4);
    }
    if (rail.a !== undefined) {
      // Elliptical rail: the focus is the parent, so the ellipse's centre sits
      // a*e back along the apsidal line (see entities.keplerStep's frame).
      const ap = rail.a * s;
      if (ap < 8) continue;
      const ox = -rail.a * rail.e;
      ctx.save();
      ctx.translate(toX(p.x + ox * rail.ca), toY(p.y + ox * rail.sa));
      ctx.rotate(Math.atan2(rail.sa, rail.ca));
      ctx.beginPath(); ctx.ellipse(0, 0, ap, rail.smin * s, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    } else {
      const rp = rail.r * s;
      if (rp < 5) continue;
      ctx.beginPath(); ctx.arc(toX(p.x), toY(p.y), rp, 0, TAU); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = 1;

  // ---- Dense fields. A shoal is a REGION, not a point, and it has no edge —
  // so it is stippled, never outlined. Same law the dial's dot layer obeys: a
  // boundary ring would claim a hard edge the pocket does not have. The stipple
  // is seeded off the field's lane radius, so a given shoal has the same grain
  // every time you open the chart.
  for (const f of game.fields || []) {
    const off = fieldOff(f);
    const fx = f.x + off.x, fy = f.y + off.y;
    const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
    const reach = CFG.FIELD_LEN * FIELD_LOBE_MAX * s;
    const px = toX(fx), py = toY(fy);
    if (px + reach < 0 || px - reach > vw || py + reach < 0 || py - reach > vh) continue;
    // A soft bloom under the grain, so a shoal reads as a THING at the fit
    // scale rather than as speckle you have to hunt for. Tan for one you have
    // found, cold and dimmer for one that is still a guess — the same
    // charted/unexplored split every contact obeys.
    ctx.globalCompositeOperation = 'lighter';
    const bg2 = ctx.createRadialGradient(px, py, 0, px, py, reach);
    bg2.addColorStop(0, f.seen ? 'rgba(214, 178, 120, 0.2)' : 'rgba(150, 162, 200, 0.12)');
    bg2.addColorStop(1, 'transparent');
    ctx.fillStyle = bg2;
    ctx.beginPath(); ctx.arc(px, py, reach, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const rng = mulberry32(Math.round(f.r));
    const n = f.seen ? 90 : 34;
    ctx.fillStyle = f.seen ? 'rgba(226, 202, 158, 0.62)' : 'rgba(164, 176, 210, 0.3)';
    for (let i = 0; i < n; i++) {
      // Rejection-free placement: draw a bearing, then a radius inside the
      // lobe at that bearing (sqrt keeps the scatter even rather than
      // clustering at the heart).
      const th = rng() * TAU;
      const q = Math.sqrt(rng()) * fieldLobe(f, th);
      const tan = Math.cos(th) * q * CFG.FIELD_LEN, rad = Math.sin(th) * q * CFG.FIELD_SPREAD;
      const wx = fx + rad * ca - tan * sa, wy = fy + rad * sa + tan * ca;
      const sz = f.seen ? 1.6 : 1.2;
      ctx.fillRect(toX(wx) - sz / 2, toY(wy) - sz / 2, sz, sz);
    }
    if (f.seen && reach > 30) {
      ctx.font = '600 9.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(10, 4, 26, 0.9)';
      ctx.fillStyle = 'rgba(232, 214, 178, 0.72)';
      ctx.fillText(f.name.toUpperCase(), px, py - reach * 0.42);
      ctx.shadowBlur = 0;
      ctx.textAlign = 'left';
    }
  }

  // ---- The star, at its true size. It is the one thing on this chart that is
  // never in doubt, and it is what the whole view is centred on.
  {
    const sun = reg.stars.find((b) => b.alive);
    if (sun) {
      const rp = Math.max(3.5, sun.radius * s);
      // Two additive coronae — a wide soft one and a tight hot one — plus a
      // white core. It is the brightest thing on the chart because it is the
      // brightest thing in the system, and every range ring is measured from it.
      ctx.globalCompositeOperation = 'lighter';
      for (const [k, a0, a1] of [[7.5, 0.3, 0.05], [2.6, 0.85, 0.3]]) {
        const g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, rp * k);
        g.addColorStop(0, `rgba(255, 216, 140, ${a0})`);
        g.addColorStop(0.35, `rgba(255, 172, 70, ${a1})`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(sunX, sunY, rp * k, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(255, 246, 214, 0.98)';
      ctx.beginPath(); ctx.arc(sunX, sunY, rp, 0, TAU); ctx.fill();
    }
  }

  // ---- CONTACTS, by the knowledge ladder (starmap.contactLevel).
  let marks = 0;
  ctx.textAlign = 'center';
  for (const b of reg.nonField) {
    if (!isContact(b) || !plottable(game, b)) continue;
    const lvl = contactLevel(game, b);
    marks++;
    const p = contactPos(game, b);
    const x = toX(p.x), y = toY(p.y);
    if (x < -60 || x > vw + 60 || y < -60 || y > vh + 60) continue;

    if (lvl === 'unknown') {
      // UNEXPLORED, drawn as unexplored: a soft cold bloom with the error circle
      // around it once that circle is big enough to read. No class colour, no
      // size, no name — everything the chart does not know, it does not say.
      // (Zooming in does not sharpen a guess; the widening ring is the honest
      // reason why.) Only WORLDS reach here — see starmap.plottable.
      // A sensor fix does not make a world EXPLORED — the mark stays exactly
      // this mark — but it does mean the position is the truth, so the bloom
      // tightens onto it and the error circle goes away. That is the only thing
      // the fix changes here; there is no third mark to learn.
      const fix = hasFix(game, b);
      const unc = fix ? 0 : ghostUnc(b) * s;
      const rr = fix ? Math.max(6, b.radius * s * 2.2) : clamp(unc, 5, 26);
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, 'rgba(184, 198, 232, 0.62)');
      g.addColorStop(0.3, 'rgba(150, 162, 206, 0.16)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // The error circle is DETAIL, so it waits for the zoom that can use it —
      // at the fit scale it is a second ring around every unexplored world and
      // the chart turns into a page of circles.
      if (unc > 30) {
        ctx.strokeStyle = 'rgba(168, 182, 220, 0.24)';
        ctx.setLineDash([2, 6]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, Math.min(unc, 240), 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
      continue;
    }

    const col = contactColor(b);
    const rgb = hexRgb(col);
    const drawn = b.radius * s;
    const big = b.type === 'planet' || b.type === 'rogue';
    // A SMALL CONTACT IS SMALL UNTIL YOU CLOSE IN. Drawn at a flat 2px with a
    // wide halo, fifty-odd moons and installations made the inner system one
    // continuous smear at the fit scale — the very zoom where the chart's job
    // is to show you the shape of the system, not its contents. They grow into
    // real marks on the same `zk` ramp the moon lanes arrive on.
    const rr = big ? Math.max(3.2, drawn) : Math.max(1.3 + 1.1 * zk, drawn);

    // THE BLOOM, additive, under the mark. This is most of what makes the chart
    // read as a lit instrument rather than a diagram: a body is a light source.
    // TIGHT, though — a wide soft halo on every contact is a fog bank, not a
    // glow. Small radius, hot core, fast falloff.
    ctx.globalCompositeOperation = 'lighter';
    const halo = rr * (big ? 3.8 : 2.7);
    const hg = ctx.createRadialGradient(x, y, 0, x, y, halo);
    hg.addColorStop(0, `rgba(${rgb}, ${big ? 1 : 0.9})`);
    hg.addColorStop(0.3, `rgba(${rgb}, ${big ? 0.34 : 0.26})`);
    hg.addColorStop(1, 'transparent');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(x, y, halo, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // CHARTED: a clean lit disc. NO OUTLINE — it carried a white rim, and on a
    // world drawn at any real size that reads as a thick ring bolted round the
    // planet rather than as a light. The bloom already separates it from the
    // bed; a stroke on top of a glow is one edge too many.
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    // ...and a hot core over it, additive: a charted world is a LIGHT on this
    // chart, and a flat fill of its own colour is the one thing that reads as
    // paint rather than as something switched on.
    ctx.globalCompositeOperation = 'lighter';
    const cg2 = ctx.createRadialGradient(x, y, 0, x, y, rr);
    cg2.addColorStop(0, `rgba(255, 255, 255, ${big ? 0.42 : 0.3})`);
    cg2.addColorStop(0.55, `rgba(${rgb}, 0.3)`);
    cg2.addColorStop(1, 'transparent');
    ctx.fillStyle = cg2;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    if (b.ring && drawn > 3) {           // a ringed giant wears its band on the chart too
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(1, drawn * 0.22);
      ctx.beginPath(); ctx.ellipse(x, y, drawn * 1.9, drawn * 0.6, 0.4, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
    if (b.fort) {                        // a Bastion fort: the same blue box as the dial
      ctx.strokeStyle = '#78c8ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - rr - 2.5, y - rr - 2.5, (rr + 2.5) * 2, (rr + 2.5) * 2);
    }
    // NAMES: worlds and landmarks only. MOONS ARE ICONS — they DO carry
    // individual names now (MOON_NAMES in world.js), but a zoomed-in family printing
    // four name labels in a ring around a disc already labelled OSSIA is the
    // clutter this rule exists to prevent. The readout strip names them on
    // demand (labelsItself keys off TYPE, so naming moons can't leak in here).
    if (labelsItself(game, b)) {
      ctx.font = `600 ${big ? 11 : 9.5}px system-ui, sans-serif`;
      ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(10, 4, 26, 0.9)';
      ctx.fillStyle = big ? 'rgba(232, 238, 255, 0.92)' : 'rgba(198, 212, 234, 0.72)';
      ctx.fillText(contactLabel(game, b), x, y - rr - 6);
      ctx.shadowBlur = 0;
    }
  }
  ctx.textAlign = 'left';
  chart.marks = marks;

  // ---- YOUR DOCKS. A chart is the instrument that REMEMBERS, so the places in
  // the system you have BUILT belong on it — and unlike every other mark here
  // they are not contacts at all: they are decisions, like a journey. They ride
  // their world's TRUE position — a station is a decision, not a contact, so it
  // owes the knowledge ladder no ghost offset — and they are drawn UNDER the
  // route so an active journey's next stop stays the loudest thing on screen.
  //
  // `b.hidden` is the ONE exception, and it is absolute. Landing does not chart
  // a hidden world (world.js's survey skips `b.hidden` however close you get),
  // so the Wanderer's Star — an ordinary landable planet as far as the dock code
  // is concerned — would otherwise print a berth glyph, and HOME PORT in rose,
  // on a chart that draws nothing else there. The powered relay stays the only
  // way to learn it exists.
  //
  // Rose for HOME, and deliberately against this file's "a UI construct is
  // painted in chrome ink" note: HOME already means rose on the dial, and on the
  // pad it is the colour of the flag the station flies — one meaning wearing
  // three colours across three instruments is worse than one construct
  // borrowing a semantic hue. The instruments mark home in rose OUTRIGHT, unlike
  // the pad's structure, because a two-pixel blip has only its colour to work
  // with. Other stations get the steel ring with no label — findable, not
  // shouting.
  if (game.docks) for (const dk of game.docks) {
    if (!dk.b.alive || dk.b.hidden) continue;   // hidden shows NOTHING, chart included
    const isHome = game.home === dk;
    const hb = dk.b;
    const hx = toX(hb.x), hy = toY(hb.y);
    const rr = Math.max(isHome ? 9 : 7, hb.radius * s + 5);
    const ink = isHome ? DOCK_HOME : DOCK_STEEL;
    ctx.strokeStyle = `rgba(${ink}, ${isHome ? 0.8 : 0.42})`;
    ctx.lineWidth = isHome ? 1.4 : 1;
    ctx.beginPath(); ctx.arc(hx, hy, rr, 0, TAU); ctx.stroke();
    // The same roof-over-a-berth glyph the dial uses, seated on the ring.
    ctx.beginPath();
    ctx.moveTo(hx - 5, hy - rr - 2.5); ctx.lineTo(hx, hy - rr - 7);
    ctx.lineTo(hx + 5, hy - rr - 2.5);
    ctx.stroke();
    if (!isHome) continue;
    ctx.font = '600 8.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(10, 4, 26, 0.9)';
    ctx.fillStyle = `rgba(${ink}, 0.9)`;
    ctx.fillText('HOME PORT', hx, hy + rr + 12);
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';
  }

  drawChartRoute(game, ctx, s, toX, toY);

  // ---- The ship: a heading chevron, ringed so it is findable on a chart this
  // wide. Drawn last of the marks — where you are outranks everything.
  if (game.ship.alive || game.started) {
    const sx = toX(game.ship.x), sy = toY(game.ship.y);
    const pulse = (game.time % 2) / 2;
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 26);
    sg.addColorStop(0, 'rgba(226, 240, 255, 0.55)');
    sg.addColorStop(1, 'transparent');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(sx, sy, 26, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.45 * (1 - pulse)})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sx, sy, 5 + pulse * 13, 0, TAU); ctx.stroke();
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(game.ship.angle);
    ctx.shadowBlur = 7; ctx.shadowColor = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(-4.5, 4.5); ctx.lineTo(-1.8, 0); ctx.lineTo(-4.5, -4.5);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // ---- Hover bracket. The READOUT is in the DOM footer (the same
  // query-the-console idiom as the CONTROLS schematic and the achievement
  // list); all the canvas owes it is a mark saying "this one".
  const hov = chart.hover;
  if (hov && hov.kind !== 'point') {
    const hx = toX(hov.x), hy = toY(hov.y);
    const rr = hov.kind === 'field' ? Math.max(16, CFG.FIELD_LEN * 0.6 * s)
      : Math.max(9, (hov.b ? hov.b.radius * s : 9) + 5);
    ctx.strokeStyle = `rgba(${INK_HOT}, 0.85)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let q = 0; q < 4; q++) {
      const a0 = q * Math.PI / 2 + 0.34;
      ctx.moveTo(hx + Math.cos(a0) * rr, hy + Math.sin(a0) * rr);
      ctx.arc(hx, hy, rr, a0, a0 + 0.55);
    }
    ctx.stroke();
  }

  // ---- Scale bar. A map without one is a picture.
  // Sits in a row with the RECENTRE button (style.css `.mapreset`, 28px at
  // left:20 / bottom:96) — both read the VIEW rather than the system, so they
  // share a line. Move one and move the other.
  {
    const unit = niceStep(150 / s);   // the same ladder the rings use — see niceStep
    const barW = unit * s;
    const bx = 58, by = vh - 102;
    ctx.strokeStyle = acc(0.5);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + barW, by); ctx.lineTo(bx + barW, by - 4);
    ctx.stroke();
    ctx.font = '500 10px system-ui, sans-serif';
    ctx.fillStyle = acc(0.62);
    ctx.fillText(unit >= 1000 ? `${(unit / 1000).toFixed(unit >= 10000 ? 0 : 1)}k units` : `${unit | 0} units`, bx, by - 8);
  }

  drawChartPortrait(game);
}

// ---------------------------------------------------------------------------
// THE PORTRAIT — the little live picture in the chart's readout strip.
//
// It answers "do we have imagery of this place?" without saying the words: a
// CHARTED world turns under its own banded weather with its moons going round,
// and an UNEXPLORED one gets sensor static. That is the knowledge ladder again,
// on a third channel after the mark and the name — and the one channel a player
// reads without having to learn a key first.
//
// It runs on `chart.t`, the panel's own clock (chartEase advances it): the sim
// behind a shell modal is frozen, so `game.time` cannot animate anything here.
// Everything procedural is seeded off `b.id`, like every other generated
// geometry in this file, so a world's face is ITS face every time you point at
// it rather than a fresh scribble.
const PORTRAIT = 76;
let portCanvas = null, pctx = null;
function drawChartPortrait(game) {
  if (!portCanvas) portCanvas = document.getElementById('mapPortrait');
  if (!portCanvas) return;
  if (!pctx) pctx = portCanvas.getContext('2d');
  const ctx = pctx;
  const px = Math.max(1, Math.round(PORTRAIT * rdpr));
  if (portCanvas.width !== px) portCanvas.width = portCanvas.height = px;
  ctx.setTransform(rdpr, 0, 0, rdpr, 0, 0);
  ctx.clearRect(0, 0, PORTRAIT, PORTRAIT);
  const cx = PORTRAIT / 2, cy = PORTRAIT / 2, R = PORTRAIT / 2 - 3;
  const t = chart.t;
  const zc = game.zone ? game.zone.rgb : [176, 112, 255];
  const acc = (a) => `rgba(${zc[0]}, ${zc[1]}, ${zc[2]}, ${a})`;
  const hov = chart.hover;

  // The instrument's own well + frame, whatever is in it.
  ctx.fillStyle = 'rgba(6, 4, 16, 0.92)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R - 1, 0, TAU); ctx.clip();

  const body = hov && hov.kind === 'body' ? hov.b
    : hov && hov.kind === 'waypoint' ? (game.route[hov.i] && game.route[hov.i].b) : null;
  const field = hov && hov.kind === 'field' ? hov.field
    : hov && hov.kind === 'waypoint' ? (game.route[hov.i] && game.route[hov.i].field) : null;

  if (body && contactLevel(game, body) === 'charted') {
    portraitBody(ctx, game, body, cx, cy, t);
  } else if (field && field.seen) {
    portraitShoal(ctx, field, cx, cy, t);
  } else if (body || field) {
    portraitStatic(ctx, cx, cy, R, t);          // no imagery — we have not been
  } else {
    portraitIdle(ctx, cx, cy, R, t, acc);       // nothing under the cursor
  }
  ctx.restore();

  // Frame: a bright rim with quarter ticks, so it reads as a viewport rather
  // than as a hole cut in the panel.
  ctx.strokeStyle = acc(0.55);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  ctx.strokeStyle = acc(0.16);
  ctx.beginPath(); ctx.arc(cx, cy, R + 1.5, 0, TAU); ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    ctx.strokeStyle = acc(0.6);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4));
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
  }
}

// A charted body's face: a lit sphere with banded weather turning under a fixed
// star, its ring if it has one, and its family going round outside it.
function portraitBody(ctx, game, b, cx, cy, t) {
  const col = b.type === 'moon' ? '#9fb6cc' : contactColor(b);
  const rgb = hexRgb(col);
  const moon = b.type === 'moon';
  const small = b.type === 'station' || b.type === 'nest' || b.tinker || b.ghost ||
    b.visitor || b.comet;
  const R = small ? 12 : moon ? 15 : 20;
  const rng = mulberry32(b.id * 2654435761 >>> 0);

  // The disc, then its bands scrolling under the terminator. Clipped to the
  // sphere so the bands cannot spill past the limb.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
  ctx.fillStyle = col;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  if (!small) {
    const bands = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < bands; i++) {
      const w = R * (0.16 + rng() * 0.3);
      const drift = (rng() - 0.5) * 0.16;
      const y = cy - R + ((rng() * 2 * R + t * 3 * (0.4 + drift)) % (R * 2.4)) - R * 0.2;
      ctx.fillStyle = rng() < 0.5 ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.16)';
      ctx.fillRect(cx - R, y, R * 2, w);
    }
  }
  // Terminator: one fixed light, from the upper left, exactly as the world view
  // lights its bodies.
  const sh = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  sh.addColorStop(0, 'rgba(255, 248, 230, 0.28)');
  sh.addColorStop(0.4, 'transparent');
  sh.addColorStop(0.72, 'rgba(0, 0, 8, 0.5)');
  sh.addColorStop(1, 'rgba(0, 0, 8, 0.82)');
  ctx.fillStyle = sh;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();

  // Atmosphere bloom on the lit limb
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.5);
  g.addColorStop(0, `rgba(${rgb}, 0.3)`);
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  if (b.ring) {
    ctx.strokeStyle = `rgba(${rgb}, 0.75)`;
    ctx.lineWidth = 2.5;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.42);
    ctx.beginPath(); ctx.ellipse(0, 0, R * 1.75, R * 0.42, 0, 0, TAU); ctx.stroke();
    ctx.restore();
  }
  if (b.fort) {   // the Bastion box, same blue it wears everywhere else
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - R - 5, cy - R - 5, (R + 5) * 2, (R + 5) * 2);
  }

  // The household, going round. Count only — their real orbits are on the chart
  // itself; this is a portrait, and it says "this world has four moons".
  if (!moon && !small) {
    let n = 0;
    for (const m of game.bodies) {
      if (m.alive && m.type === 'moon' && m.parent === b && plottable(game, m)) n++;
      if (n >= 5) break;
    }
    for (let i = 0; i < n; i++) {
      const rr = R + 7 + i * 3.2;
      const a = t * (0.5 - i * 0.06) + i * 2.3;
      ctx.fillStyle = 'rgba(200, 214, 235, 0.9)';
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.42, 1.6, 0, TAU);
      ctx.fill();
    }
  }
}

// A shoal: its rock, tumbling slowly. Same tan the chart and the dial use.
function portraitShoal(ctx, f, cx, cy, t) {
  const rng = mulberry32(Math.round(f.r));
  ctx.fillStyle = 'rgba(226, 202, 158, 0.85)';
  for (let i = 0; i < 46; i++) {
    const a = rng() * TAU + t * 0.12;
    const d = Math.sqrt(rng()) * 27;
    const sz = 1 + rng() * 2.2;
    ctx.globalAlpha = 0.35 + rng() * 0.6;
    ctx.fillRect(cx + Math.cos(a) * d - sz / 2, cy + Math.sin(a) * d * 0.7 - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;
}

// NO IMAGERY. Rolling scan bars and speckle over an empty well — the same
// vocabulary the ion wash uses on the radar, which is where a player has
// already learned that this pattern means "the instrument has nothing".
function portraitStatic(ctx, cx, cy, R, t) {
  ctx.fillStyle = 'rgba(150, 162, 200, 0.1)';
  for (let i = 0; i < 4; i++) {
    const y = ((t * (14 + i * 9) + i * 23) % (R * 2 + 14)) - 7;
    ctx.fillRect(cx - R, cy - R + y, R * 2, 2 + (i % 2));
  }
  const rng = mulberry32(Math.floor(t * 9) + 1);
  ctx.fillStyle = 'rgba(180, 192, 226, 0.5)';
  for (let i = 0; i < 34; i++) {
    ctx.fillRect(cx - R + rng() * R * 2, cy - R + rng() * R * 2, 1.4, 1.4);
  }
  ctx.font = '700 9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(196, 208, 240, 0.75)';
  ctx.fillText('NO', cx, cy - 1);
  ctx.fillText('IMAGERY', cx, cy + 9);
  ctx.textAlign = 'left';
}

// Nothing under the cursor: a slow reticle, idling.
function portraitIdle(ctx, cx, cy, R, t, acc) {
  ctx.strokeStyle = acc(0.3);
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath(); ctx.arc(cx, cy, R * (i / 3.2), 0, TAU); ctx.stroke();
  }
  const a = t * 0.6;
  ctx.strokeStyle = acc(0.65);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  ctx.stroke();
  ctx.fillStyle = acc(0.8);
  ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, TAU); ctx.fill();
}

// The plotted journey, on the chart. Ship → stop → stop, dashed the whole way
// (it is a plan, not a thing that exists), with the NEXT stop lit and carrying
// the arrival ring that says how close counts.
function drawChartRoute(game, ctx, s, toX, toY) {
  const route = game.route;
  if (!route || !route.length) return;
  const pts = [];
  if (game.ship.alive) pts.push({ x: toX(game.ship.x), y: toY(game.ship.y) });
  for (const wp of route) {
    const p = waypointPos(game, wp);
    pts.push({ x: toX(p.x), y: toY(p.y), wp });
  }
  // Two passes: a wide additive bloom along the whole leg, then the dashed line
  // itself on top. The bloom is what keeps a route legible where it crosses the
  // lit inner system, and it makes the plan read as something switched ON.
  const legPath = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  };
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `rgba(${INK}, 0.12)`;
  ctx.lineWidth = 7;
  legPath(); ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `rgba(${INK}, 0.7)`;
  legPath(); ctx.stroke();
  ctx.setLineDash([]);

  ctx.textAlign = 'center';
  for (let i = 0; i < route.length; i++) {
    const p = pts[pts.length - route.length + i];
    const next = i === 0;
    const a = next ? 1 : 0.72;
    if (next) {
      const rr = arriveR(route[i]) * s;
      if (rr > 5) {
        ctx.strokeStyle = `rgba(${INK}, 0.3)`;
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
      const k = (game.time * 0.9) % 1;    // converging pulse — the same "go here"
      ctx.strokeStyle = `rgba(${INK_HOT}, ${0.12 + 0.42 * k})`;   // grammar as the rescue dock
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 20 - 12 * k, 0, TAU); ctx.stroke();
    }
    // The node: a diamond, which nothing else on this chart is — a mark you put
    // there must never be mistakable for a mark that was already there. Lit
    // from underneath like every other mark, brightest on the one you are
    // flying to.
    ctx.globalCompositeOperation = 'lighter';
    const ng = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, next ? 26 : 17);
    ng.addColorStop(0, `rgba(${INK}, ${next ? 0.62 : 0.34})`);
    ng.addColorStop(1, 'transparent');
    ctx.fillStyle = ng;
    ctx.beginPath(); ctx.arc(p.x, p.y, next ? 26 : 17, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${next ? INK_HOT : INK}, ${a})`;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x + 7, p.y); ctx.lineTo(p.x, p.y + 7); ctx.lineTo(p.x - 7, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#120a24';
    ctx.font = '700 8px system-ui, sans-serif';
    ctx.fillText(String(i + 1), p.x, p.y + 3);
    // ...and its name, UNLESS the contact under it already printed it — see
    // labelsItself. The numbered diamond is what says "this is a stop"; the
    // word underneath is only there for the stops that would otherwise be
    // anonymous (a moon, an unexplored world, a point in open space).
    if (!(route[i].b && labelsItself(game, route[i].b))) {
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(10, 4, 26, 0.9)';
      ctx.fillStyle = `rgba(${INK_HOT}, ${a * 0.95})`;
      ctx.fillText(waypointLabel(game, route[i]), p.x, p.y + 21);
      ctx.shadowBlur = 0;
    }
  }
  ctx.textAlign = 'left';
}

// The next stop, in the WORLD — the arrival ring you actually fly through, with
// the marker and its name at the centre. A route plotted on the chart has to be
// flyable without the panel open, and the radar alone leaves the last thousand
// units to guesswork.
//
// TWO CULLS, and they are not the same cull. The RING is arrival-sized (a
// planet's is ~1,200 units against a view about 760 across, so it is routinely
// bigger than the screen) — it is drawn whenever the ring could CROSS the view,
// which is what makes it sweep in from the edge as you close and read as a
// boundary you pass through. The MARKER is a point, so it is drawn only when
// that point is in frame. Culling both on the centre — the first version —
// meant the ring only ever appeared once you were already inside it, i.e. after
// the stop had popped: the whole thing was dead code that nothing errored on.
//
// Helper UI: dashed, and every width and radius divided by zoom so it holds its
// size on screen.
function drawRouteWorld(game) {
  const route = game.route;
  if (!route || !route.length || !game.ship.alive) return;
  const wp = route[0];
  const p = waypointPos(game, wp);
  const z = game.cam.zoom;
  const rr = Math.max(arriveR(wp), 40 / z);
  const d2 = (p.x - view.cx) ** 2 + (p.y - view.cy) ** 2;
  if (d2 > (view.r + rr) ** 2) return;            // the ring cannot reach the view at all
  const pulse = 0.55 + 0.45 * Math.sin(game.time * 3);
  ctx.strokeStyle = `rgba(${INK}, ${0.22 + 0.2 * pulse})`;
  ctx.lineWidth = 2 / z;
  ctx.setLineDash([10 / z, 9 / z]);
  ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  if (p.x < view.x0 - 60 || p.x > view.x1 + 60 || p.y < view.y0 - 60 || p.y > view.y1 + 60) return;
  // The diamond, at the plotted point itself — for an uncharted return that is
  // the GUESS, exactly as the chart drew it. The guidance is never sharper than
  // the chart that made it.
  const d = 11 / z;
  ctx.fillStyle = `rgba(${INK_HOT}, ${0.5 + 0.35 * pulse})`;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d, p.y); ctx.lineTo(p.x, p.y + d); ctx.lineTo(p.x - d, p.y);
  ctx.closePath(); ctx.fill();
  const fs = 13 / z;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = `rgba(${INK_HOT}, 0.8)`;
  ctx.fillText(waypointLabel(game, wp), p.x, p.y + d + fs * 1.3);
  ctx.textAlign = 'left';
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
// The wave's palette arrives as [r,g,b] triples on its CFG.STORM_CLASSES row
// (see there). mixc is what the filament heat ramp needs — a class is a PAIR of
// colours to travel between, not one colour to fade — and rgba spares every
// call site an `| 0` on a lerped channel.
const mixc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
function drawStormWave(game) {
  const hs = game.homeStar;
  if (!hs) return;
  const st = game.storm;
  const t = game.time;

  // ---- the CHARGE: the sun loading before it fires. This is the telegraph
  // the whole mechanic is fair because of, so it is deliberately loud — the
  // corona swells, prominences whip, and the light hardens toward white.
  //
  // HOW HARD IT SWELLS IS THE CLASS. The sun has to look like it is loading a
  // squall or loading a CME, because that is the one thing worth knowing while
  // there is still time to fly somewhere: `dens` scales the swell, the
  // prominence count and their reach, and the class's `core`/`warm` tones carry
  // the colour, so a squall barely flexes and a CME visibly winds up to throw.
  if (game.stormChargeT > 0) {
    const cl = game.stormCls || CFG.STORM_CLASSES[CFG.STORM_CLASSES.length - 1];
    const k = 1 - game.stormChargeT / (game.stormChargeMax || cl.charge);   // 0 -> 1 as it loads
    const dCamS = Math.hypot(view.cx - hs.x, view.cy - hs.y);
    // Kept TIGHT to the limb (~2x radius). A wide corona gradient is a flat
    // additive wash over the entire view at any normal flying distance — it
    // whited the game out instead of reading as the sun swelling. The far-field
    // half of the telegraph is the screen pulse in render(), not this.
    if (dCamS - view.r < hs.radius * 2.4) {
      ctx.globalCompositeOperation = 'lighter';
      const puls = 1 + 0.10 * Math.sin(t * (5 + 16 * k)) + 0.05 * Math.sin(t * 27);
      const rr = hs.radius * (1.12 + 0.95 * k * cl.dens) * puls;
      const cg = ctx.createRadialGradient(hs.x, hs.y, hs.radius * 0.92, hs.x, hs.y, rr);
      cg.addColorStop(0, `rgba(${cl.core}, ${0.4 * k})`);
      cg.addColorStop(0.35, `rgba(${cl.warm}, ${0.22 * k})`);
      cg.addColorStop(0.75, `rgba(${cl.sheath}, ${0.09 * k})`);
      cg.addColorStop(1, 'transparent');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(hs.x, hs.y, rr, 0, TAU); ctx.fill();
      // Prominences: loops of plasma standing off the limb, reaching further
      // and whipping faster the closer it gets to firing. A weaker class throws
      // FEWER of them, not fainter ones — the same rule the sheath's filaments
      // follow, and the reason a squall reads as sparse rather than as a CME
      // with the brightness turned down.
      ctx.lineCap = 'round';
      const nProm = Math.max(3, Math.round(7 * cl.dens));
      for (let i = 0; i < nProm; i++) {
        const a = (i / nProm) * TAU + t * 0.35 + i * 1.7;
        const reach = hs.radius * (0.18 + 0.75 * k * cl.dens) * (0.6 + 0.6 * Math.abs(Math.sin(t * 2.1 + i)));
        const x0 = hs.x + Math.cos(a) * hs.radius * 0.98, y0 = hs.y + Math.sin(a) * hs.radius * 0.98;
        const bow = a + 0.34;
        ctx.strokeStyle = `rgba(${cl.warm}, ${0.5 * k})`;
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
  // Every dimension below is the WAVE'S OWN (it carries its CFG.STORM_CLASSES
  // row), never a CFG constant: the plasma on screen has to be the plasma the
  // sim is charging you for, and a global would describe whichever class was
  // authored last rather than the one actually washing over the ship.
  const tail = st.r - st.tail, lead = st.r + st.band;
  // …and `kk` is HOW MUCH OF ITSELF THE WAVE HAS LEFT (world.js resolves it once
  // per frame from the class's reach). It multiplies EVERY alpha below and
  // nothing else: a wave spending itself has to visibly shred over its last ~10
  // seconds, because the alternative — full-strength plasma that blinks out at
  // an exact radius — is the geometric in-world edge the house style forbids.
  // The sim scales its bite by the same number, so what you see is what it does.
  const kk = st.k ?? 1;
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
  // …and scaled by the class: a thin front is a less ragged one. Kept a partial
  // scale (0.5 + 0.5*dens), not the raw `dens` — take the wobble to zero and the
  // squall's shock comes out a PERFECT CIRCLE, which is the geometric in-world
  // edge this whole draw exists to avoid.
  const rag = 0.5 + 0.5 * st.dens;
  const wob = (a) => rag * (250 * Math.sin(a * 3 + sd) + 140 * Math.sin(a * 7 - sd * 1.7)
    + 80 * Math.sin(a * 13 + sd * 0.6) + 55 * Math.sin(a * 5 + t * 0.7));
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
  // Over reg.nonField, not game.bodies: nothing that casts a lee is field
  // rock, so walking the pocket to reject ~15,000 rocks one at a time is the
  // exact cost the registries exist to delete.
  const lees = [];
  for (const b of frameReg(game).nonField) {
    if (b.type !== 'planet' && b.type !== 'moon' && b.type !== 'rogue') continue;
    if (!b.alive || b.radius < CFG.STORM_SHADOW_MIN_R) continue;
    const br = Math.hypot(b.x, b.y) || 1;
    const ux = b.x / br, uy = b.y / br;
    const along = view.cx * ux + view.cy * uy;
    const behind = along - br;
    if (behind < -vR || behind > b.radius * CFG.STORM_SHADOW_LEN + vR) continue;
    const px = view.cx - ux * along, py = view.cy - uy * along;
    const reach = shelterR(b) * 1.4 + vR;
    if (px * px + py * py > reach * reach) continue;
    lees.push({ b, ux, uy });
  }

  // A teardrop: full width at the limb, bulging a little in the near wake,
  // then closing as the plasma folds back in behind the world. Shared by the
  // clip and the edge spill below so the two can never drift apart.
  // (shelterR is the SIM's own half-width — config owns the one definition, and
  // the 0.9 here is the documented shrink, not a second opinion about the shape.
  // It is also what makes a MOON'S lee draw at all: shelterR's flat pad is most
  // of a small moon's shadow, and a bare radius multiple would paint a slit a
  // pilot cannot see to aim at.)
  const leePath = ({ b, ux, uy }) => {
    const w = shelterR(b) * 0.9;
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
    const shockAt = st.tail / (st.tail + st.band);
    const g = ctx.createRadialGradient(hs.x, hs.y, Math.max(0, tail), hs.x, hs.y, lead);
    g.addColorStop(0, rgba(st.haze, 0));
    g.addColorStop(0.45, rgba(st.haze, 0.045 * kk));
    g.addColorStop(0.78, rgba(st.sheath, 0.06 * kk));
    g.addColorStop(shockAt * 0.985, rgba(st.shock, 0.10 * kk));
    g.addColorStop(shockAt, rgba(mixc(st.shock, st.core, 0.5), 0.14 * kk));
    g.addColorStop(1, rgba(st.core, 0));
    ctx.fillStyle = g;
    ctx.fillRect(view.x0 - 40, view.y0 - 40, view.x1 - view.x0 + 80, view.y1 - view.y0 + 80);
  }

  // ---- 2. FILAMENTS: plasma streaming radially, scattered through the part
  // of the sheath the camera can actually see and STREAMING OUTWARD past it.
  // Sized off the view, so they read as driving rain whether you are inside
  // the wave or watching it cross the system. `flow` walks each streak
  // outward and wraps it, which is the whole sense of motion — the sheath
  // itself only creeps at ~1000 u/s and would otherwise look static up close.
  //
  // COUNT is what carries the class, not alpha: 72 streaks for a CME down to 32
  // for a squall. Fading them instead would just grey the wave out — see the
  // SATURATED note below, which is the same failure from the other direction.
  {
    const near = Math.max(tail, dCam - vR * 1.3);
    const far = Math.min(lead, dCam + vR * 1.3);
    if (far > near) {
      const span = far - near;
      const flow = t * 620;
      ctx.lineCap = 'round';
      // Thinned by kk as well as dimmed, exactly as `dens` thins a weak class:
      // a spent wave is a SPARSER one, and fading alone would leave a full grid
      // of ghost streaks that reads as a screen effect rather than as plasma
      // coming apart.
      const nFil = Math.round(72 * st.dens * (0.35 + 0.65 * kk));
      for (let i = 0; i < nFil; i++) {
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
        const heat = Math.max(0, Math.min(1, 1 - (st.r - rr) / st.tail));
        const fg = ctx.createLinearGradient(x0, y0, x1, y1);
        // BOTH TIPS FADE TO NOTHING. Starting at full alpha put a hard chop
        // across the leading end of every streak, and a field of hard-topped
        // radial bars reads as architecture — the "columns" look — not as
        // plasma blowing past. The peak sits just behind the tip.
        // filLo -> filHi IS the class: amber for a CME, rose for a surge, blue
        // for a squall, each ramping the same way from tail to shock.
        fg.addColorStop(0, rgba(st.filHi, 0));
        fg.addColorStop(0.16, rgba(mixc(st.filLo, st.filHi, heat), (0.10 + 0.34 * heat) * flick * kk));
        fg.addColorStop(0.5, rgba(st.sheath, 0.09 * heat * flick * kk));
        fg.addColorStop(1, rgba(st.haze, 0));
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
    // Brightness rides `dens` alongside the colour: a squall's edge is not just
    // bluer than a CME's, it is a fainter line in the sky. Kept a partial scale
    // so the weakest class still reads as a FRONT — the shock is the one part
    // of a wave you have to be able to see coming.
    const bri = (0.55 + 0.45 * st.dens) * kk;
    ctx.strokeStyle = rgba(st.shock, 0.17 * bri);
    ctx.lineWidth = st.band * 0.34;
    trace(0); ctx.stroke();
    // The incandescent leading edge, riding a little ahead of the glow, with
    // a hot bloom under it. Sized off the view so it stays a bright LINE at
    // any zoom rather than vanishing zoomed out or becoming a slab zoomed in.
    const edge = st.band * 0.24;
    ctx.strokeStyle = rgba(st.filLo, (0.3 + 0.1 * Math.sin(t * 9)) * bri);
    ctx.lineWidth = Math.max(30, vR * 0.13);
    trace(edge); ctx.stroke();
    ctx.strokeStyle = rgba(mixc(st.shock, st.core, 0.5), (0.45 + 0.12 * Math.sin(t * 9)) * bri);
    ctx.lineWidth = Math.max(14, vR * 0.055);
    trace(edge); ctx.stroke();
    ctx.strokeStyle = rgba(st.core, (0.6 + 0.15 * Math.sin(t * 13)) * bri);
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
      ctx.fillStyle = rgba(st.core, 0.8 * kk);
      const nMote = Math.round(STORM_MOTES * st.dens * (0.35 + 0.65 * kk));
      for (let i = 0; i < nMote; i++) {
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
      if (rel < -st.band || rel > st.tail) continue;
      const k = rel < 0 ? 1 : 1 - rel / st.tail;
      // Widths ride shelterR, not the bare radius: on a small MOON a
      // radius-scaled stroke is thinner than the pad that makes its lee usable,
      // so the soft edge fell inside the shadow and left the cut showing as the
      // hard line this pass exists to erase.
      const lw = shelterR(lee.b);
      ctx.strokeStyle = rgba(mixc(st.sheath, st.core, 0.35), 0.13 * k * kk);
      ctx.lineWidth = lw * 0.6;
      ctx.beginPath(); leePath(lee); ctx.stroke();
      ctx.strokeStyle = rgba(mixc(st.warm, st.core, 0.35), 0.11 * k * kk);
      ctx.lineWidth = lw * 0.21;
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
    if (rel < -st.band || rel > st.tail) continue;
    const k = rel < 0 ? 1 : 1 - rel / st.tail;
    const sunAng = Math.atan2(-uy, -ux);   // bearing from the body back to the sun
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(mixc(st.shock, st.core, 0.5), 0.5 * k * kk);
    ctx.lineWidth = b.radius * 0.1;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius * 1.06, sunAng - 1.15, sunAng + 1.15);
    ctx.stroke();
    ctx.strokeStyle = rgba(st.core, 0.35 * k * kk);
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
    for (const b of frameReg(game).planets) {
      if (!b.alive) continue;
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
  // The awake list, not the array: dormancy is already the culling decision,
  // so walking 15,000 bodies to `continue` past the dormant ones was work the
  // LOD had already done. The dormant guard stays for the null-list fallback.
  for (const b of (game.bodies._awake || game.bodies)) {
    if (b.alive && !b.dormant && bodyOnScreen(b)) {
      // SUBMERGED bodies dim: a rock inside an ocean's water column (physics
      // stamps b.seaDim) draws at half strength, so it reads as under the sea
      // instead of floating on a blue disc. The alpha is restored either way.
      // seaDim, NOT the physical b.inSea — the beam's load stays legible, and
      // the split is what keeps a release underwater from re-billing a splash.
      if (b.seaDim) {
        ctx.globalAlpha = 0.5;
        drawBody(game, b);
        ctx.globalAlpha = 1;
      } else {
        drawBody(game, b);
      }
    }
  }
  // GRAVEL draws into the SAME instanced batch as the rocks, right before the
  // flush. It is the whole reason the tier is affordable to LOOK at: thousands
  // of grains cost one more draw call, not one blit each — the shard family and
  // its per-instance tint (Pitch 2) already do exactly this job, so gravel gets
  // the win for free by reusing them rather than growing a second path.
  drawGravel(game);
  // THE INSTANCED ROCK LAYER lands here — one composite for what would have
  // been ~1900 individual blits. It sits above the bodies drawn in the loop,
  // which is where plain rock already was: the shoals are seeded LAST in
  // generateWorld, so field rock has always drawn over the worlds it passes.
  // Restoring wt by hand rather than save/restore, exactly as blitRock does —
  // every pass after this must see the world matrix it expects.
  if (glOn) {
    const glcv = rockGLFlush(wt.k, wt.e, wt.f);
    if (glcv) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(glcv, 0, 0);
      ctx.setTransform(wt.k, 0, 0, wt.k, wt.e, wt.f);
    }
  }
  drawGlow(game);
  drawDocks(game);
  drawDockGuide(game);
  drawApproach(game);
  drawRouteWorld(game);
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
  // Muzzle flashes go UNDER the ship and its beam: the launch happens out at the
  // hold point and the ship should never be lost inside its own effect.
  drawLaunchFx(game);
  drawShip(game);
  // ...and the sea goes back over it: the one pass that has to land AFTER the
  // hull, or the ship is on top of the ocean instead of in it.
  drawSeaVeil(game);

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
    let mine = null, mineD2 = Infinity;
    // Awake list: the cursor is on screen, and the screen is inside the bubble.
    for (const b of (game.bodies._awake || game.bodies)) {
      if (!b.alive || b.type === 'star' || b.type === 'nest' || b.heldBy) continue;
      const gr = b.radius + st.grabSlack;
      const d2 = (b.x - game.aim.x) ** 2 + (b.y - game.aim.y) ** 2;
      if (d2 > gr * gr) continue;
      // MIRRORS tractor.pickTarget — a rock you just launched is no target at
      // all for CFG.THROW_LOCKOUT, and after that it is merely demoted (a loaded
      // stow ring still beats it). Keep the pair in sync: this ring is a promise
      // about what the next click does, and highlighting a rock the click will
      // ignore is worse than highlighting nothing.
      if (throwLocked(b)) continue;
      if (isOwnShot(b)) { if (d2 < mineD2) { mine = b; mineD2 = d2; } continue; }
      if (d2 < hovD2) { hov = b; hovD2 = d2; }
    }
    if (!hov && mine && !(game.orbit.length && !game.held)) hov = mine;
    if (hov && hov !== game.held) {
      // The SAME calls the beam itself runs (config.canLift/canStow) — the ring
      // is a promise about what the next click does, so a hand-rolled mass test
      // here would lie the moment the class gate refused a light planet.
      const canOrbit = canStow(st, hov) && game.orbit.length < st.maxOrbiters && !hov.fort;
      // RAM FOOD (brawler): right-click would crush this rock into the ram.
      // Its own hue — the armed-amber the game already uses for "this rock is
      // ammunition" — because for this spec the green STOW promise is never true
      // (no ring) and cyan only promises a HOLD. Same gate the absorb itself
      // runs (canStow + room in the ram), so the ring can't promise a crush that
      // absorbIntoRam would refuse.
      // GREEN AND AMBER ARE NOW THE SAME BUTTON — since the stow moved to
      // right-click (2026-08) both hues promise what RIGHT mouse does with this
      // rock, and cyan promises what LEFT mouse does. Keep it that way: the two
      // spec-specific hues reading as one grammar is what makes the ring
      // legible without a legend.
      const canRam = st.frontRam && st.ramCap > 0 && game.ship.ram < st.ramCap
        && canStow(st, hov) && !hov.fort;
      const canGrab = canLift(st, hov) && !hov.fort;
      const inRange = Math.hypot(hov.x - game.ship.x, hov.y - game.ship.y) <= st.range + hov.radius;
      const pulse = 1 + Math.sin(game.time * 6) * 0.18;
      const alpha = (inRange ? 0.85 : 0.3) * (0.7 + 0.3 * Math.sin(game.time * 6));
      const rr = hov.radius + (7 + 4 * pulse) / game.cam.zoom;
      ctx.lineWidth = 2 / game.cam.zoom;
      if (canRam) ctx.strokeStyle = `rgba(255, 200, 90, ${alpha})`;
      else if (canOrbit) ctx.strokeStyle = `rgba(120, 255, 180, ${alpha})`;
      else if (canGrab) ctx.strokeStyle = `rgba(90, 200, 255, ${alpha})`;
      else ctx.strokeStyle = `rgba(255, 95, 80, ${alpha})`;
      ctx.setLineDash(canGrab ? [] : [5 / game.cam.zoom, 5 / game.cam.zoom]);
      ctx.beginPath(); ctx.arc(hov.x, hov.y, rr, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      if (canRam) {
        // Crush chevrons: two short ticks biting inward at the ring's sides —
        // "this gets COMPRESSED", pointed at the rock rather than away like the
        // grab ring's glow. Solid strokes; the ring above is already the shape.
        for (const m of [0, Math.PI]) {
          ctx.beginPath();
          ctx.moveTo(hov.x + Math.cos(m) * (rr + 6 / game.cam.zoom), hov.y + Math.sin(m) * (rr + 6 / game.cam.zoom));
          ctx.lineTo(hov.x + Math.cos(m) * (rr - 2 / game.cam.zoom), hov.y + Math.sin(m) * (rr - 2 / game.cam.zoom));
          ctx.stroke();
        }
      }
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
  // The chart, on its own canvas above everything. Only while its panel is up —
  // and the panel is a shell modal, so the world under it is frozen. The world
  // pass above still runs and is then covered: the chart's bed is opaque, so
  // there is nothing to see through it, and an early-out here would be a
  // special case in the one function every other draw hangs off.
  if (game.mapOpen) drawStarMap(game);

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
    const cl = game.stormCls || CFG.STORM_CLASSES[CFG.STORM_CLASSES.length - 1];
    const k = 1 - game.stormChargeT / (game.stormChargeMax || cl.charge);
    const beat = 0.5 + 0.5 * Math.sin(game.time * (3 + 12 * k));
    // THE PULSE IS THE CLASS, at the one moment the player can still act on it:
    // its COLOUR is the class's warm tone (cool blue for a squall through to the
    // CME's amber) and its strength scales with `dens`, so the telegraph says
    // how hard to run before the message line has finished typing.
    ctx.fillStyle = `rgba(${cl.warm}, ${(0.02 + 0.055 * k * beat) * (0.5 + 0.5 * cl.dens)})`;
    ctx.fillRect(0, 0, vw, vh);
  }

  // 2) THE ION WASH, while a wave is actually on you (stormIonT outlives the
  //    exposure itself, so the sensors stay rattled for a beat after you make
  //    the lee — the relief lands a moment late, which is what sells it).
  //    Bright charged haze, scan-line tearing, and a hard edge vignette;
  //    everything scales with `wash`, so ducking into shelter visibly calms it
  //    instead of switching it off.
  if (game.stormIonT > 0 && game.ship.alive) {
    const ionK = Math.min(1, game.stormIonT / (game.stormIonMax || 1));
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

  // UNDER THE SEA: the whole view goes through water before anything else
  // environmental lands on it — heat and frost are things happening OUTSIDE
  // the glass, and they should read through the water, not under it.
  drawSeaScreen(game);

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

// ---- SHIP SYSTEMS cluster icons --------------------------------------------
// hud.js owns the nodes; this owns the ink (render.js is where canvas drawing
// lives). The GRAB/STOW instruments say "the biggest thing the beam can take"
// as a PICTURE — the beam-class ladder as sprites, sized up the rungs so the
// ramp itself is the reading. The rock rungs come off util.rockJagRing, the
// ONE outline generator (the icon of a rock is still not a perturbed
// primitive), seeded FIXED per rung: an emblem, never a re-roll. Repainted
// only when a class or tier changes — hud.js guards the calls.
// Neutral pale-violet ink on a dark well, like the shell's own glyphs: the
// icons are chrome, not instruments, but a canvas can't spend a CSS var, so
// they hold the house hue rather than chasing the locale accent.
const ICON_INK = '#ded2f7';
const ICON_WELL = 'rgba(16, 8, 34, .85)';
export function drawStatIcon(cv, kind, idx) {
  const c = cv.getContext('2d');
  const S = cv.width, h = S / 2;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, S, S);
  c.translate(h, h);
  c.lineWidth = 2;
  c.strokeStyle = ICON_INK;
  c.fillStyle = ICON_WELL;
  c.shadowColor = 'rgba(176, 112, 255, .8)';
  c.shadowBlur = 5;
  if (kind === 'ship') {
    // The hull grows radius 4 -> 44 across the tiers; the glyph rides a tamed
    // version of that ramp so tier 5 still fits the cell.
    const r = 7 + idx * 2.2;
    c.beginPath();
    c.moveTo(0, -r);                       // nose
    c.lineTo(r * 0.78, r * 0.72);          // starboard wingtip
    c.lineTo(0, r * 0.34);                 // tail notch
    c.lineTo(-r * 0.78, r * 0.72);         // port wingtip
    c.closePath();
    c.fill(); c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = ICON_INK;
    c.beginPath(); c.arc(0, -r * 0.3, 1.6, 0, TAU); c.fill();
  } else {
    const rung = Math.max(0, Math.min(5, idx));
    const r = [6, 8.5, 11, 13.5, 16.5, 20][rung];
    if (rung <= 2) {
      // Pebble / belt rock / boulder: a real rock silhouette.
      const ring = rockJagRing(mulberry32(0xC0FFEE + rung * 7919), r * 3);
      const n = ring.length;
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const rr = r * ring[i];
        if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath();
      c.fill(); c.stroke();
    } else if (rung <= 4) {
      // Small / large moon: a cratered disc.
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); c.stroke();
      c.shadowBlur = 0;
      c.lineWidth = 1.2;
      const craters = rung === 3 ? [[-0.35, -0.2, 0.3], [0.3, 0.35, 0.22]]
        : [[-0.4, -0.25, 0.28], [0.35, 0.3, 0.2], [0.05, -0.5, 0.16]];
      for (const [cx, cy, cr] of craters) {
        c.beginPath(); c.arc(cx * r, cy * r, cr * r, 0, TAU); c.stroke();
      }
    } else {
      // A world: banded disc — the bands clipped to the disc, like drawBody's
      // gas banding at glyph scale.
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); c.stroke();
      c.shadowBlur = 0;
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.clip();
      c.lineWidth = 1.4;
      c.globalAlpha = 0.75;
      for (const y of [-0.42, -0.05, 0.38]) {
        c.beginPath();
        c.moveTo(-r, y * r); c.quadraticCurveTo(0, y * r + r * 0.14, r, y * r);
        c.stroke();
      }
      c.globalAlpha = 1;
    }
  }
  c.restore();
}
