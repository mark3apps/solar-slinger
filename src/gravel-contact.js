// ---------------------------------------------------------------------------
// GRAIN-ON-GRAIN CONTACT — ONE implementation, two callers.
//
// This module exists specifically so the worker and the main-thread fallback
// cannot drift. Contact used to live inside gravel-worker.js, which meant a
// machine without SharedArrayBuffer (no cross-origin isolation, a worker that
// failed to start) ran a game where debris did not carom — physics depending on
// a host capability, which is exactly what the fallible-capability rule is meant
// to prevent. The functions here are PURE over the arrays they are handed, so
// `physics.stepGravel` and the worker call the same code over their own views of
// the same buffer.
//
// WHY A GRID WORKS HERE WHEN IT FAILED FOR BODIES. A uniform grid was built for
// the Body broad phase and reverted: it cut candidate pairs 3.6x and won nothing
// on wall clock, because every visit still chased a pointer into a ~50-field
// object scattered through the heap (docs/physics-invariants.md, "why it is
// still sweep-and-prune"). None of that applies to gravel — grains are in
// contiguous typed arrays, all small, sizes within one bucket of each other,
// which is the population a uniform grid is actually for. Read that note's
// REASONING, not its headline.
//
// THE CELL NEVER CLAMPS. Sizing a grid to a bounding box and clamping outliers
// into edge cells was a measured 35x regression: one flung rock stretched the
// extent, the dim cap saturated, and a whole blob collapsed into a single cell
// at O(n²). The cell OPENS UP instead — a larger cell costs candidate efficiency
// and nothing else — so the grid always covers the full span and nothing is ever
// clamped.
// ---------------------------------------------------------------------------

const FLAG_ALIVE = 1;
const GRID_DIM_MAX = 512;

// Scratch, allocated per call-site (the worker and the main thread each get
// their own) so the two never share mutable state across threads.
export function makeContactScratch() {
  return { head: null, next: null };
}

// Equal-and-opposite impulse plus mass-split positional separation.
// Deliberately plain: no damage, no scars, no credit, no splitting. A grain is
// anonymous rock, and everything that makes a collision an EVENT belongs to
// `Body`. This only has to make a pocket carom, which is the whole point of the
// dense fields ("a shoal plays like a pinball table", physics.js).
const RESTITUTION = 0.45;   // rock on rock: mostly inelastic

function resolve(a, i, j) {
  if (a.inertT[j] > 0) return;
  const dx = a.x[j] - a.x[i], dy = a.y[j] - a.y[i];
  const rr = a.radius[i] + a.radius[j];
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;
  const closing = (a.vx[j] - a.vx[i]) * nx + (a.vy[j] - a.vy[i]) * ny;
  const mi = a.mass[i], mj = a.mass[j], msum = mi + mj;
  // Separate FIRST, split by mass, or neighbours settle overlapping and grind —
  // the same failure the rigid halo rule exists to prevent.
  const push = rr - d;
  a.x[i] -= nx * push * (mj / msum); a.y[i] -= ny * push * (mj / msum);
  a.x[j] += nx * push * (mi / msum); a.y[j] += ny * push * (mi / msum);
  if (closing >= 0) return;   // already separating
  const imp = (-(1 + RESTITUTION) * closing) / (1 / mi + 1 / mj);
  a.vx[i] -= (imp * nx) / mi; a.vy[i] -= (imp * ny) / mi;
  a.vx[j] += (imp * nx) / mj; a.vy[j] += (imp * ny) / mj;
}

// `a` is {x, y, vx, vy, radius, mass, inertT, flags} — typed arrays, whichever
// thread's views they are. `top` is the store's high-water mark.
export function collideGrains(a, top, s) {
  const flags = a.flags, X = a.x, Y = a.y, R = a.radius;
  let n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 1;
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    n++;
    const px = X[i], py = Y[i];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (R[i] > maxR) maxR = R[i];
  }
  if (n < 2) return;
  const span = Math.max(maxX - minX, maxY - minY) + 1;
  // >= 2x the largest grain, so a 3x3 stencil is complete; opened up rather
  // than clamped when the span would otherwise need more than GRID_DIM_MAX.
  const cell = Math.max(2 * maxR, span / GRID_DIM_MAX);
  const dim = Math.min(GRID_DIM_MAX, Math.max(1, Math.ceil(span / cell) + 1));
  const cells = dim * dim;
  if (!s.head || s.head.length < cells) s.head = new Int32Array(cells);
  if (!s.next || s.next.length < top) s.next = new Int32Array(top);
  const head = s.head, next = s.next;
  head.fill(-1, 0, cells);
  const cellOf = (i) => {
    let cx = ((X[i] - minX) / cell) | 0, cy = ((Y[i] - minY) / cell) | 0;
    if (cx < 0) cx = 0; else if (cx >= dim) cx = dim - 1;
    if (cy < 0) cy = 0; else if (cy >= dim) cy = dim - 1;
    return cy * dim + cx;
  };
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    const c = cellOf(i);
    next[i] = head[c];
    head[c] = i;
  }
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    // A FRESH FRAGMENT PASSES THROUGH ITS SIBLINGS (CFG.CHUNK_INERT) — one of
    // invariant 7b's three brakes on the split cascade, and why a burst born
    // inside the volume its parent occupied does not eat itself on frame one.
    if (a.inertT[i] > 0) continue;
    const c = cellOf(i);
    const cx = c % dim, cy = (c / dim) | 0;
    // own cell forward, then (+1,-1) (+1,0) (+1,+1) (0,+1): the forward half of
    // the 3x3 ring, so each pair is generated exactly once and no dedup is needed
    for (let j = next[i]; j !== -1; j = next[j]) resolve(a, i, j);
    if (cx + 1 < dim) {
      const lo = cy > 0 ? cy - 1 : cy, hi = cy + 1 < dim ? cy + 1 : cy;
      for (let ny = lo; ny <= hi; ny++) {
        for (let j = head[ny * dim + cx + 1]; j !== -1; j = next[j]) resolve(a, i, j);
      }
    }
    if (cy + 1 < dim) {
      for (let j = head[(cy + 1) * dim + cx]; j !== -1; j = next[j]) resolve(a, i, j);
    }
  }
}
