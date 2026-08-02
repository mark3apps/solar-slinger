// ---------------------------------------------------------------------------
// THE GRAVEL WORKER — the debris sim, on another core.
//
// This is the ONLY part of the simulation that can leave the main thread today,
// and the reason is that gravel already satisfies the two conditions: its state
// lives in a SharedArrayBuffer rather than in an object graph, and its update is
// a pure function of (grain state, attractor snapshot, dt) that touches no
// `game` object, no DOM and no canvas.
//
// WHAT IT DOES *NOT* DO, deliberately: contact. Gravel-vs-ship, -alien and
// -celestial all read live game state and can damage the ship, so they stay on
// the main thread (physics.collideGravel). This worker only advances grains —
// gravity, the world edge, the inert timer, and the integrate.
//
// IT MIRRORS physics.stepGravel EXACTLY. The two must agree, because the
// fallback path (no SharedArrayBuffer, or a worker that failed to start) runs
// the main-thread version and the game may not behave differently depending on
// which one ran. If you change the motion rules in one, change them in both —
// that mirror rule is the same one predictPaths lives under.
//
// The blocking Atomics.wait here is correct and is the point: a worker thread
// parked in wait() costs nothing, and it wakes on the notify from the dispatch.
// The main thread does the opposite (it spins briefly) because Atomics.wait
// throws on the main thread by design.
// ---------------------------------------------------------------------------

const CTRL_IDLE = 0, CTRL_WORK = 1, CTRL_DONE = 2;
const FLAG_ALIVE = 1;

let x, y, vx, vy, radius, mass, rot, spin, inertT, flags;
let ctrl, params;
let worldR2 = 0, G = 8, soft2 = 1600;

// ---------------------------------------------------------------------------
// GRAIN-ON-GRAIN CONTACT — and why a grid works HERE when it failed for bodies.
//
// A uniform grid was built for the Body broad phase and reverted: it cut
// candidate pairs 3.6x and won nothing on wall clock, because every grid visit
// still chased a pointer into a ~50-field object scattered through the heap
// (docs/physics-invariants.md, "why it is still sweep-and-prune"). None of that
// applies to gravel. The grains are in contiguous typed arrays, they are all
// small, and their sizes are within one bucket of each other — which is exactly
// the population a uniform grid is for. The reason that experiment failed is
// absent here, so do not read its conclusion as covering this.
//
// It also runs on the WORKER, so it is off the frame budget entirely.
//
// THE CELL NEVER CLAMPS. Sizing a grid to a bounding box and clamping outliers
// into edge cells was the 35x regression in that same note: one flung rock
// stretched the extent, the dim cap saturated, and a whole blob collapsed into
// one cell at O(n²). So the cell OPENS UP instead — a larger cell costs
// candidate efficiency and nothing else, and the grid always covers the full
// span with no clamping at all.
const GRID_DIM_MAX = 512;
let gHead = null, gNext = null;
let gDim = 0, gCell = 32, gX0 = 0, gY0 = 0;

self.onmessage = (e) => {
  const d = e.data;
  if (d.type !== 'init') return;
  const L = d.layout, b = d.buffer, n = L.slots;
  x = new Float64Array(b, L.x, n);
  y = new Float64Array(b, L.y, n);
  vx = new Float64Array(b, L.vx, n);
  vy = new Float64Array(b, L.vy, n);
  radius = new Float32Array(b, L.radius, n);
  mass = new Float32Array(b, L.mass, n);
  rot = new Float32Array(b, L.rot, n);
  spin = new Float32Array(b, L.spin, n);
  inertT = new Float32Array(b, L.inertT, n);
  flags = new Uint8Array(b, L.flags, n);
  ctrl = new Int32Array(d.ctrlBuffer, 0, 4);
  params = new Float64Array(d.ctrlBuffer, 16, d.paramLen);
  worldR2 = d.worldR * d.worldR;
  G = d.G;
  soft2 = d.gravSoft * d.gravSoft;
  self.postMessage({ type: 'ready' });
  loop();
};

function loop() {
  for (;;) {
    // Park until the main thread posts work. A timeout is not needed: the only
    // way out of a run is a dispatch, and a dead main thread means a dead page.
    Atomics.wait(ctrl, 0, CTRL_IDLE);
    if (Atomics.load(ctrl, 0) !== CTRL_WORK) continue;   // spurious wake
    run();
    Atomics.store(ctrl, 0, CTRL_DONE);
    Atomics.notify(ctrl, 0);
  }
}

function run() {
  const top = Atomics.load(ctrl, 1);
  const attN = Atomics.load(ctrl, 2);
  const dt = params[0];
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    const px = x[i], py = y[i];
    let ax = 0, ay = 0;
    // Attractors arrive as a flat [x, y, mass, cullR2] quad per entry — the
    // shared shortlist physics built for the whole wake bubble, with the
    // per-grain cutoff still applied here so the answer matches gravityAt.
    for (let k = 0, o = 1; k < attN; k++, o += 4) {
      const dx = params[o] - px, dy = params[o + 1] - py;
      const d2 = dx * dx + dy * dy + soft2;
      if (d2 > params[o + 3]) continue;
      const inv = (G * params[o + 2]) / (d2 * Math.sqrt(d2));
      ax += dx * inv; ay += dy * inv;
    }
    // The world edge — gravel is never star-anchored, so it always applies.
    const r2 = px * px + py * py;
    if (r2 > worldR2) {
      const d = Math.sqrt(r2);
      const over = (d - Math.sqrt(worldR2)) / 1000;
      const k2 = 25 * (1 + over * over);
      ax += (-px / d) * k2; ay += (-py / d) * k2;
    }
    vx[i] += ax * dt; vy[i] += ay * dt;
    rot[i] += spin[i] * dt;
    if (inertT[i] > 0) inertT[i] -= dt;
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
  collideGrains(top);
}

// Build the grid over the live grains and resolve contacts. Half-stencil, so
// each pair is generated exactly once and no dedup pass is needed.
function collideGrains(top) {
  let n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 1;
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    n++;
    const px = x[i], py = y[i];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (radius[i] > maxR) maxR = radius[i];
  }
  if (n < 2) return;
  const span = Math.max(maxX - minX, maxY - minY) + 1;
  // >= 2 x the largest grain, so a 3x3 stencil is complete; opened up rather
  // than clamped if the span would need more than GRID_DIM_MAX cells.
  gCell = Math.max(2 * maxR, span / GRID_DIM_MAX);
  gDim = Math.min(GRID_DIM_MAX, Math.max(1, Math.ceil(span / gCell) + 1));
  gX0 = minX; gY0 = minY;
  const cells = gDim * gDim;
  if (!gHead || gHead.length < cells) gHead = new Int32Array(cells);
  if (!gNext || gNext.length < top) gNext = new Int32Array(top);
  gHead.fill(-1, 0, cells);
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    let cx = ((x[i] - gX0) / gCell) | 0, cy = ((y[i] - gY0) / gCell) | 0;
    if (cx < 0) cx = 0; else if (cx >= gDim) cx = gDim - 1;
    if (cy < 0) cy = 0; else if (cy >= gDim) cy = gDim - 1;
    const c = cy * gDim + cx;
    gNext[i] = gHead[c];
    gHead[c] = i;
  }
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    // A FRESH FRAGMENT PASSES THROUGH ITS SIBLINGS (CFG.CHUNK_INERT). This is
    // one of invariant 7b's three brakes on the split cascade, and it is why a
    // burst born inside the volume its parent occupied does not eat itself on
    // frame one.
    if (inertT[i] > 0) continue;
    let cx = ((x[i] - gX0) / gCell) | 0, cy = ((y[i] - gY0) / gCell) | 0;
    if (cx < 0) cx = 0; else if (cx >= gDim) cx = gDim - 1;
    if (cy < 0) cy = 0; else if (cy >= gDim) cy = gDim - 1;
    // own cell forward, then (+1,-1) (+1,0) (+1,+1) (0,+1)
    for (let j = gNext[i]; j !== -1; j = gNext[j]) resolve(i, j);
    if (cx + 1 < gDim) {
      const lo = cy > 0 ? cy - 1 : cy, hi = cy + 1 < gDim ? cy + 1 : cy;
      for (let ny = lo; ny <= hi; ny++) {
        for (let j = gHead[ny * gDim + cx + 1]; j !== -1; j = gNext[j]) resolve(i, j);
      }
    }
    if (cy + 1 < gDim) {
      for (let j = gHead[(cy + 1) * gDim + cx]; j !== -1; j = gNext[j]) resolve(i, j);
    }
  }
}

// Equal-and-opposite impulse plus positional separation. Deliberately simple:
// no damage, no scars, no credit, no splitting. A grain is anonymous rock, and
// everything that makes a collision an EVENT belongs to Body — this only has to
// make the pocket carom, which is the whole point of the dense fields
// ("a shoal plays like a pinball table").
function resolve(i, j) {
  if (inertT[j] > 0) return;
  const dx = x[j] - x[i], dy = y[j] - y[i];
  const rr = radius[i] + radius[j];
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;
  const rvx = vx[j] - vx[i], rvy = vy[j] - vy[i];
  const closing = rvx * nx + rvy * ny;
  const mi = mass[i], mj = mass[j], msum = mi + mj;
  // Separate first, split by mass, so neighbours cannot settle overlapping and
  // grind — the same failure the rigid halo rule exists to prevent.
  const push = (rr - d);
  x[i] -= nx * push * (mj / msum); y[i] -= ny * push * (mj / msum);
  x[j] += nx * push * (mi / msum); y[j] += ny * push * (mi / msum);
  if (closing >= 0) return;                 // already separating
  const e = 0.45;                           // rock on rock: mostly inelastic
  const imp = (-(1 + e) * closing) / (1 / mi + 1 / mj);
  vx[i] -= (imp * nx) / mi; vy[i] -= (imp * ny) / mi;
  vx[j] += (imp * nx) / mj; vy[j] += (imp * ny) / mj;
}
