// The narrow phase for shaped rock: convex-hull SAT with a true MTV and a real
// contact manifold.
//
// WHAT THIS REPLACES AND WHY. The old collider sampled a per-body radial
// profile: a 256-entry LUT, a per-edge normal table, a 32-sector reach bound and
// a 7-sample penetration probe. It could not produce a minimum-translation
// vector even in principle — the DEPTH came from whichever sample happened to be
// deepest and the DIRECTION from a separately-looked-up face normal, and the two
// disagree by however far along a face the contact landed. A resting pair
// therefore never resolved: every substep it was pushed along an axis that was
// not the one it was overlapping on, so overlap accumulated the longer a pocket
// was played in (measured: 265 interpenetrating pairs after 600s idle).
//
// SAT hands back the MTV as a by-product of the separation test, so the depth
// and the axis are the same measurement by construction. That is the whole
// argument for this file.
//
// Shapes come from rockdata.js — baked, fixed, scale-invariant. See
// tools/bake-rocks.mjs and docs/rock-fracture.md.

import { ROCK_SHAPES, ROCK_ROOTS } from './rockdata.js';

// ---- Which shape a body wears ----------------------------------------------
// Keyed off the body id so it survives a reload and a headless re-run, exactly
// as the old per-id generation did. A body may also name one outright
// (`b.shapeId`), which is how a fracture piece keeps the identity the bake gave
// it rather than re-rolling into an unrelated silhouette.
//
// "SURVIVES A HEADLESS RE-RUN" IS A CLAIM ON entities.js, not just on this line:
// it holds only because `generateWorld` resets the id counter, so a seed's ids
// are a pure function of the seed. While `NEXT_ID` was session-monotonic this
// was quietly false — same layout, different rock, and therefore different
// reach, different SAT contacts and different collisions on the second run of
// the same seed. Don't make the counter monotonic again. (Issue #96.)
export function rockShapeOf(b) {
  if (b._rs) return b._rs;
  const id = b.shapeId || ROCK_ROOTS[Math.abs(b.id | 0) % ROCK_ROOTS.length];
  return (b._rs = ROCK_SHAPES[id] || ROCK_SHAPES[ROCK_ROOTS[0]]);
}

// ---- Per-shape hull metrics, computed once ----------------------------------
// A hull's centroid and its bounding-circle radius about that centroid are the
// two numbers the broad reject inside rockContacts runs on, and both are
// ROTATION-INVARIANT in the unit frame: the centroid merely turns with the body
// and `far` is a distance between two points of the same rigid hull, so it does
// not change at all. Deriving them once per SHAPE and rotating the centroid is
// what lets the world rebuild below drop its second pass — that pass was an
// n-vertex Math.hypot loop per hull per rebuild, recomputing a constant.
function hullMetrics(sh) {
  let m = sh._hm;
  if (m) return m;
  m = sh._hm = [];
  for (let h = 0; h < sh.hulls.length; h++) {
    const src = sh.hulls[h], n = src.length >> 1;
    let cx = 0, cy = 0, far = 0;
    for (let i = 0; i < n; i++) { cx += src[i * 2]; cy += src[i * 2 + 1]; }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(src[i * 2] - cx, src[i * 2 + 1] - cy);
      if (d > far) far = d;
    }
    m.push({ n, cx, cy, far });
  }
  return m;
}

// ---- World-space hull cache -------------------------------------------------
// A hull's world vertices are rebuilt only when the body has actually turned or
// resized since the last build. Translation is applied at read time (the cache
// stores vertices about the body's own centre), because a body that drifts
// without turning would otherwise dirty the cache every frame for no change in
// shape.
//
// THE KEY IS EXACT ROTATION, and there is no epsilon. There was one, at 1e-4,
// and it could never fire: `world.js` seeds a landmark's spin off the Body's
// ±0.3 rad/s scaled by `max(0.12, min(1, 55/r))`, so a 300-unit slab turns
// ~4.6e-4 rad per 1/120 substep — 4.6x the epsilon, and no spin in the seeded
// range sat under it. Every awake landmark took the rebuild path every substep
// while paying for a cache lookup as well. Raising the epsilon instead would
// buy hits with a stale hull: at a core rock's reach that is most of a unit of
// vertex error feeding a contact normal, on the file whose entire job is that
// the depth and the direction come from the SAME measurement. So the rebuild is
// made cheap enough not to need hiding — metrics hoisted per shape above,
// buffers allocated ONCE per body below — and the cache keeps the honest key,
// where it still hits for every settled or railed rock in the sky.
function hullsWorld(b) {
  const sh = rockShapeOf(b);
  const rot = b.rot || 0, r = b.radius;
  let c = b._hw;
  if (c && c.rot === rot && c.r === r && c.sh === sh) return c;
  const met = hullMetrics(sh);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  // Reuse the body's buffers. Hull count and vertex counts are fixed per shape,
  // so once the arrays exist for a shape they never need to grow — only a shape
  // swap (a fracture piece taking its baked child) reallocates.
  if (!c || c.sh !== sh) {
    const hulls = new Array(sh.hulls.length);
    for (let h = 0; h < sh.hulls.length; h++) {
      hulls[h] = { v: new Float64Array(met[h].n * 2), n: met[h].n, cx: 0, cy: 0, far: 0 };
    }
    c = b._hw = { rot: NaN, r: NaN, sh, hulls };
  }
  for (let h = 0; h < sh.hulls.length; h++) {
    const src = sh.hulls[h], mh = met[h], H = c.hulls[h], v = H.v, n = mh.n;
    for (let i = 0; i < n; i++) {
      const x = src[i * 2] * r, y = src[i * 2 + 1] * r;
      v[i * 2] = x * cs - y * sn; v[i * 2 + 1] = x * sn + y * cs;
    }
    const lx = mh.cx * r, ly = mh.cy * r;
    H.cx = lx * cs - ly * sn; H.cy = lx * sn + ly * cs;
    H.far = mh.far * r;
  }
  c.rot = rot; c.r = r;
  return c;
}

// ---- SAT --------------------------------------------------------------------
// One axis test, shared by both edge loops. Projects both hulls onto the axis
// and returns the overlap (negative = a separating axis, so we can stop).
function overlapOn(A, B, ax, ay, ox, oy) {
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
  for (let i = 0; i < A.n; i++) {
    const p = A.v[i * 2] * ax + A.v[i * 2 + 1] * ay;
    if (p < aMin) aMin = p;
    if (p > aMax) aMax = p;
  }
  const off = ox * ax + oy * ay;   // B's origin relative to A's, along the axis
  for (let i = 0; i < B.n; i++) {
    const p = B.v[i * 2] * ax + B.v[i * 2 + 1] * ay + off;
    if (p < bMin) bMin = p;
    if (p > bMax) bMax = p;
  }
  return Math.min(aMax - bMin, bMax - aMin);
}

// The deepest-penetration axis between two convex hulls, or null if they are
// apart. `ox/oy` is B's origin in A's frame. The returned normal points from A
// toward B, always — every caller downstream depends on that sign and getting
// it from "whichever way the loop happened to be facing" is how the old code
// ended up with a direction that disagreed with its own depth.
function satAxis(A, B, ox, oy) {
  let best = Infinity, bx = 0, by = 0, from = 0;
  for (let pass = 0; pass < 2; pass++) {
    const P = pass ? B : A;
    for (let i = 0; i < P.n; i++) {
      const j = (i + 1) % P.n;
      let ex = P.v[j * 2] - P.v[i * 2], ey = P.v[j * 2 + 1] - P.v[i * 2 + 1];
      const L = Math.hypot(ex, ey);
      if (L < 1e-9) continue;
      // Outward normal of a CCW edge.
      let ax = ey / L, ay = -ex / L;
      const ov = overlapOn(A, B, ax, ay, ox, oy);
      if (ov <= 0) return null;                       // separating axis — done
      if (ov < best) { best = ov; bx = ax; by = ay; from = pass; }
    }
  }
  // Orient A -> B using the centroid offset, which is unambiguous for convex
  // hulls and costs one dot product.
  const cx = ox + B.cx - A.cx, cy = oy + B.cy - A.cy;
  if (bx * cx + by * cy < 0) { bx = -bx; by = -by; }
  return { nx: bx, ny: by, depth: best, from };
}

// ---- Manifold ---------------------------------------------------------------
// The support point of a hull along an axis, and the face incident to it.
function incidentFace(P, ax, ay) {
  let bi = 0, bd = -Infinity;
  for (let i = 0; i < P.n; i++) {
    const d = P.v[i * 2] * ax + P.v[i * 2 + 1] * ay;
    if (d > bd) { bd = d; bi = i; }
  }
  // Of the two faces meeting at the support vertex, the one facing the axis most
  // squarely is the one actually in contact.
  const prev = (bi - 1 + P.n) % P.n, next = (bi + 1) % P.n;
  const faceDot = (i, j) => {
    const ex = P.v[j * 2] - P.v[i * 2], ey = P.v[j * 2 + 1] - P.v[i * 2 + 1];
    const L = Math.hypot(ex, ey) || 1;
    return (ey / L) * ax + (-ex / L) * ay;
  };
  return faceDot(bi, next) > faceDot(prev, bi) ? [bi, next] : [prev, bi];
}

// Two contact points where the rocks meet along a face, one where they meet at a
// corner. A SINGLE POINT IS NOT ENOUGH for a resting slab: with one contact the
// solver can satisfy the constraint and still leave the body free to rotate
// about it, so a big flat rock lands on another and then slowly rocks forever.
// Clipping the incident face against the reference face's side planes is what
// turns a face-face contact into the pair of points that pins it.
const MAX_POINTS = 2;

// EVERY OVERLAPPING HULL PAIR GETS ITS OWN MANIFOLD, and that is not a detail.
// A decomposed body has no single minimum-translation vector: two gnarled rocks
// can interlock at a corner AND rest on a face at the same time, and no one push
// clears both. Returning only the deepest pair's MTV and applying it left 46% of
// overlapping pairs still overlapping afterwards, with residuals up to twice the
// depth that was resolved — the same "push along an axis that isn't the one
// you're stuck on" failure as the collider this replaces, arriving by a
// different route.
//
// THIS FUNCTION'S CONTRACT IS THE WHOLE LIST. What the caller does with it is a
// separate decision, and physics.collideBodies deliberately resolves only cs[0]
// per substep — several impulses on one pair in one substep is how a contact
// turns into a launch — relying on 120 Hz iteration to converge instead
// (measured: 98% of realistic overlaps clear in one push, the rest in two).
// tools/test-rockshape.mjs walks the full list, which is what proves that.
//
// Deepest first, and capped: past a few contacts the extra pairs are shallow
// corners contributing nothing the first few have not already pinned.
const MAX_CONTACTS = 4;

export function rockContacts(a, b, out) {
  const CA = hullsWorld(a), CB = hullsWorld(b);
  const ox = b.x - a.x, oy = b.y - a.y;
  const list = out || [];
  list.length = 0;

  for (let i = 0; i < CA.hulls.length; i++) {
    const A = CA.hulls[i];
    for (let j = 0; j < CB.hulls.length; j++) {
      const B = CB.hulls[j];
      // Bounding-circle reject first. With a mean of 4 hulls a side this culls
      // most of the 16 pairs for a couple of adds, and it is the reason a
      // 12-hull monolith is affordable at all.
      const dx = ox + B.cx - A.cx, dy = oy + B.cy - A.cy;
      const rr = A.far + B.far;
      if (dx * dx + dy * dy > rr * rr) continue;
      const s = satAxis(A, B, ox, oy);
      if (!s) continue;
      const m = manifold(a, b, A, B, s, ox, oy);
      if (m) list.push(m);
    }
  }
  if (!list.length) return list;
  list.sort((p, q) => q.depth - p.depth);
  if (list.length > MAX_CONTACTS) list.length = MAX_CONTACTS;
  return list;
}

// The deepest single contact — for callers that only need "are they stuck, and
// which way out": the trajectory predictor and the ship, which is one hull's
// worth of body and never interlocks with anything.
export function rockContact(a, b) {
  const l = rockContacts(a, b);
  return l.length ? l[0] : null;
}

function manifold(a, b, hullA, hullB, best, ox, oy) {
  best.A = hullA; best.B = hullB;
  // Reference face on whichever hull owned the winning axis; incident face on
  // the other. Working in A's frame throughout, converting to world at the end.
  const flip = best.from === 1;
  const R = flip ? best.B : best.A;              // reference
  const I = flip ? best.A : best.B;              // incident
  const rOff = flip ? { x: ox, y: oy } : { x: 0, y: 0 };
  const iOff = flip ? { x: 0, y: 0 } : { x: ox, y: oy };
  // The reference normal in the frame we are clipping in, pointing at I.
  let rnx = best.nx, rny = best.ny;
  if (flip) { rnx = -rnx; rny = -rny; }

  const [i0, i1] = incidentFace(I, -rnx, -rny);
  let p0 = { x: I.v[i0 * 2] + iOff.x, y: I.v[i0 * 2 + 1] + iOff.y };
  let p1 = { x: I.v[i1 * 2] + iOff.x, y: I.v[i1 * 2 + 1] + iOff.y };

  // Find the reference face: the edge of R whose outward normal is rnx,rny.
  let rf = 0, rbest = -Infinity;
  for (let i = 0; i < R.n; i++) {
    const j = (i + 1) % R.n;
    const ex = R.v[j * 2] - R.v[i * 2], ey = R.v[j * 2 + 1] - R.v[i * 2 + 1];
    const L = Math.hypot(ex, ey) || 1;
    const d = (ey / L) * rnx + (-ex / L) * rny;
    if (d > rbest) { rbest = d; rf = i; }
  }
  const rj = (rf + 1) % R.n;
  const ra = { x: R.v[rf * 2] + rOff.x, y: R.v[rf * 2 + 1] + rOff.y };
  const rb = { x: R.v[rj * 2] + rOff.x, y: R.v[rj * 2 + 1] + rOff.y };
  const tx = rb.x - ra.x, ty = rb.y - ra.y;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl, uy = ty / tl;

  // Clip the incident segment to the reference face's span.
  const clip = (p, q, nx, ny, c) => {
    const dp = p.x * nx + p.y * ny - c, dq = q.x * nx + q.y * ny - c;
    if (dp >= 0 && dq >= 0) return [p, q];
    if (dp < 0 && dq < 0) return null;
    const t = dp / (dp - dq);
    const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    return dp >= 0 ? [p, m] : [m, q];
  };
  let seg = clip(p0, p1, ux, uy, ra.x * ux + ra.y * uy);
  if (seg) seg = clip(seg[0], seg[1], -ux, -uy, -(rb.x * ux + rb.y * uy));
  if (!seg) {
    // CORNER CONTACT: the incident face lies entirely off the end of the
    // reference face, so there is no clipped span. Slide the endpoints onto the
    // reference face rather than keeping them raw — a raw endpoint is a point on
    // the OTHER body, and at a grazing corner it sits outside this one entirely
    // (measured up to 11% beyond its reach). An impulse applied there acts on a
    // lever arm the rock does not have and spins it about a point it is not
    // touching.
    const onFace = (p) => {
      const t = Math.max(0, Math.min(tl, (p.x - ra.x) * ux + (p.y - ra.y) * uy));
      return { x: ra.x + ux * t, y: ra.y + uy * t };
    };
    seg = [onFace(p0), onFace(p1)];
  }

  // Keep only the points actually behind the reference face, and take their
  // depth from that face rather than from the SAT axis: per-point depth is what
  // lets the solver push a tilted slab straight instead of translating it.
  const rc = ra.x * rnx + ra.y * rny;
  const pts = [];
  for (const p of seg) {
    const d = rc - (p.x * rnx + p.y * rny);
    if (d < 0) continue;
    pts.push({ x: p.x + a.x, y: p.y + a.y, depth: d });
    if (pts.length === MAX_POINTS) break;
  }
  if (!pts.length) {
    // Degenerate clip (nearly parallel faces at a grazing angle). Fall back to
    // the deepest incident vertex so a contact is never silently dropped —
    // dropping one is how a rock ends up inside another with nothing to push it
    // out, which is the failure this file exists to end.
    //
    // PROJECTED ONTO THE REFERENCE FACE first: the raw incident vertex sits on
    // the other body and, at a grazing angle, can lie outside this one
    // altogether — a contact point that is not in the overlap region applies its
    // impulse at the wrong lever arm and spins the rock about a point it is not
    // actually touching.
    const d0 = rc - (p0.x * rnx + p0.y * rny), d1 = rc - (p1.x * rnx + p1.y * rny);
    const p = d0 > d1 ? p0 : p1;
    const t = Math.max(0, Math.min(tl, (p.x - ra.x) * ux + (p.y - ra.y) * uy));
    pts.push({ x: ra.x + ux * t + a.x, y: ra.y + uy * t + a.y, depth: Math.max(0, Math.max(d0, d1)) });
  }
  return { nx: best.nx, ny: best.ny, depth: best.depth, points: pts };
}

// ---- Picking a shape --------------------------------------------------------
// Grouped by tier once, so world.js can ask for "a giant-sized silhouette"
// without walking the table. A rock's tier is chosen from its SIZE CLASS, which
// is what makes the fracture read: break a monolith and the mids that come out
// look like the mid rocks already lying around it, because they are drawn from
// the same tier of the same library.
const BY_TIER = [[], [], []];
for (const [id, s] of Object.entries(ROCK_SHAPES)) BY_TIER[s.tier].push(id);

export function pickShapeId(u, tier) {
  const pool = BY_TIER[Math.max(0, Math.min(2, tier))];
  return pool[Math.min(pool.length - 1, Math.floor(u * pool.length))];
}

// ---- Directional reach ------------------------------------------------------
// The furthest the outline reaches within each of SECT_N sectors, each widened
// by half a sector so the value bounds EVERY bearing falling in it. Built lazily
// per shape and cached on the record — one Float32Array, shared by every body
// wearing that shape, which is the payoff of a fixed library over per-id
// generation (the old table was per BODY).
//
// This is a BOUND, used only for the packer's snugness scoring. The accept/
// reject decision is rockOverlap, which is exact. Mixing those up is what cost
// this packer several rounds: a conservative bound used as the decision strands
// the biggest rocks in their own clearings, and an exact test used for scoring
// is work spent to rank candidates that are all going to be rejected anyway.
// 32, NOT 16, and that is a measured number: the bound is the max over a sector
// WIDENED by half a sector on each side, so coarse sectors smear one long corner
// across a 45-degree arc and the biggest rocks pay for it in every direction.
// Under a single global reach the mean surface-to-surface gap to the nearest
// neighbour was ~30 units for every size class except 250+, which sat at 85 —
// stranded in its own clearing. Halving the arc measurably tightened that; the
// table is 32 floats built once per shape, so resolution here is nearly free.
const SECT_N = 32;
// BUILT BY WALKING THE EDGES, NOT BY BUCKETING THE VERTICES. Filling sectors
// from vertices alone is only a bound if every edge spans less than the widening
// — and the simplified small shapes carry as few as 10 vertices, so an edge can
// sweep four sectors and leave the middle ones reading ZERO. The packer accepts
// on this bound without an exact test whenever it says there is room, so a
// sector that under-reports is a rock placed inside its neighbour: 74
// interpenetrating pairs at seed, worst buried 88 units, on a pocket that had
// been clean.
//
// Sampling each edge at steps of 5% of reach keeps consecutive samples inside
// half a sector at any radius that matters, and the ±1 widening then covers the
// gaps between them. A segment's furthest point from the origin is always an
// endpoint, so max-over-samples cannot under-report the arc between two of them.
function sectors(sh) {
  if (sh._sect) return sh._sect;
  const raw = new Float32Array(SECT_N);
  const v = sh.v, n = v.length >> 1;
  const step = Math.max(1e-3, sh.reach * 0.05);
  const put = (x, y) => {
    const r = Math.hypot(x, y);
    let k = Math.floor(((Math.atan2(y, x) + TAU_) % TAU_) / TAU_ * SECT_N);
    k = ((k % SECT_N) + SECT_N) % SECT_N;
    if (r > raw[k]) raw[k] = r;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = v[i * 2], ay = v[i * 2 + 1];
    const bx = v[j * 2], by = v[j * 2 + 1];
    const segs = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 0; s <= segs; s++) {
      const u = s / segs;
      put(ax + (bx - ax) * u, ay + (by - ay) * u);
    }
  }
  const sect = new Float32Array(SECT_N);
  for (let k = 0; k < SECT_N; k++) {
    sect[k] = Math.max(raw[(k - 1 + SECT_N) % SECT_N], raw[k], raw[(k + 1) % SECT_N]);
  }
  return (sh._sect = sect);
}
const TAU_ = Math.PI * 2;

// `th` is a LOCAL bearing (callers subtract b.rot, as everywhere else); `half`
// widens the query over an arc. THE WINDOW IS NOT OPTIONAL WHEN BOTH BODIES ARE
// LARGE: two shaped rocks can clear along the line joining their centres and
// still interlock at a corner off it, so the bound has to cover the arc the
// other rock subtends — roughly +/- asin(otherReach / distance).
export function reachAt(shapeId, th, half = 0) {
  const sh = ROCK_SHAPES[shapeId];
  if (!sh) return 1;
  const sect = sectors(sh);
  if (!(half > 0)) {
    const k = Math.floor((th / TAU_) * SECT_N);
    return sect[((k % SECT_N) + SECT_N) % SECT_N];
  }
  const lo = Math.floor(((th - half) / TAU_) * SECT_N);
  const hi = Math.ceil(((th + half) / TAU_) * SECT_N);
  let m = 0;
  for (let k = lo; k <= hi; k++) {
    const v = sect[((k % SECT_N) + SECT_N) % SECT_N];
    if (v > m) m = v;
  }
  return m;
}

export const shapeReach = (shapeId) => (ROCK_SHAPES[shapeId] || ROCK_SHAPES[ROCK_ROOTS[0]]).reach;

// ---- Cheap tests the broad phase and the packer want ------------------------
// Furthest any vertex sits from the body centre, in world units. The one number
// the sweep needs to know a shaped rock is bigger than its nominal radius.
export function rockReach(b) { return b.radius * rockShapeOf(b).reach; }

// Do these two shaped bodies overlap at all? Same SAT, no manifold — used by
// world.js's packer, where it replaces the whole conservative-bound-versus-
// exact-probe arbitration with the actual answer.
export function rockOverlap(a, b) {
  const CA = hullsWorld(a), CB = hullsWorld(b);
  const ox = b.x - a.x, oy = b.y - a.y;
  for (let i = 0; i < CA.hulls.length; i++) {
    const A = CA.hulls[i];
    for (let j = 0; j < CB.hulls.length; j++) {
      const B = CB.hulls[j];
      const dx = ox + B.cx - A.cx, dy = oy + B.cy - A.cy;
      const rr = A.far + B.far;
      if (dx * dx + dy * dy > rr * rr) continue;
      if (satAxis(A, B, ox, oy)) return true;
    }
  }
  return false;
}

// Surface radius toward a world bearing — what render and the predictor ask for.
// Ray-marches the outline rather than the hulls: the drawn silhouette keeps
// every vertex the bake produced, and this is the query that has to agree with
// what the player can see.
// One ray march, two answers: how far the surface is along a bearing, and which
// EDGE the ray leaves through. Both callers want the same walk, and doing it
// once means the radius and the normal can never disagree about which face the
// contact is on — a disagreement that, in the collider this replaces, showed up
// as a rock skating sideways along a slab it should have stopped against.
let _edge = -1;
function march(b, th) {
  const sh = rockShapeOf(b);
  const v = sh.v, n = v.length >> 1;
  const a = th - (b.rot || 0);
  const dx = Math.cos(a), dy = Math.sin(a);
  let best = 0;
  _edge = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = v[i * 2], ay = v[i * 2 + 1];
    const ex = v[j * 2] - ax, ey = v[j * 2 + 1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den;          // along the ray
    if (t <= 0) continue;
    const u = (ax * dy - ay * dx) / den;          // along the edge
    if (u < 0 || u > 1) continue;
    if (t > best) { best = t; _edge = i; }
  }
  return best;
}

export function rockSurfAt(b, th) { return march(b, th) * b.radius; }

// THE OUTWARD NORMAL of whichever face the bearing leaves through, as a world
// angle. Used where one side of the contact is small enough to be a point — a
// pebble on a slab — so there is no second hull to run SAT against and the face
// the ray exits IS the face being hit. Two shaped rocks go through rockContacts
// instead, which derives the normal from the separating axis.
//
// NEVER GO BACK TO A SAMPLED NORMAL TABLE. The collider this replaced looked its
// normals up in a per-bearing table, and that indirection produced two real bugs
// the march cannot have. (1) Selecting the entry with ROUND instead of FLOOR
// handed the second half of every edge its NEIGHBOUR's normal: measured across
// 400 shapes, the two selectors disagreed by a mean of 1.8 degrees, by more than
// 5 degrees on 9.4% of bearings, and by up to 134 degrees at a corner — a
// contact resolving against the wrong face. (Caught in review on PR #67.)
// (2) At 256 samples over a 1/f-grained outline, neighbouring entries on a rough
// stretch pointed tens of degrees apart, so a rock grinding along a big one drew
// a new, unrelated normal every substep and caromed off differently each time —
// reported as rocks bouncing strangely off other rocks; it needed a 5-sample
// smoothing pass to stay usable. Here the ray reports the exact edge it left
// through and the baked outline is already faceted, so both are structural
// non-problems — reintroducing a table would reintroduce them with it.
export function rockNormalAt(b, th) {
  march(b, th);
  const sh = rockShapeOf(b), v = sh.v, n = v.length >> 1;
  if (_edge < 0) return th;                       // degenerate — fall back to radial
  const j = (_edge + 1) % n;
  const ex = v[j * 2] - v[_edge * 2], ey = v[j * 2 + 1] - v[_edge * 2 + 1];
  // Outward perpendicular of a CCW edge, taken back to world.
  return Math.atan2(-ex, ey) + (b.rot || 0);
}
