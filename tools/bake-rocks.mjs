// Bakes src/rockdata.js — the fixed asteroid shape library and its fracture tree.
//
// RUN BY HAND, output committed:  node tools/bake-rocks.mjs
// Deliberately NOT a build step. The no-build edit-reload loop is the reason
// this project is fast to work on (see CLAUDE.md), so the bake writes a plain ES
// module of arrays and nothing at runtime knows this script exists.
//
// WHY A LIBRARY AT ALL: util.rockShape generated a star-shaped radial polygon
// per body id and the collider sampled it live — a 256-entry LUT, a per-edge
// normal table, a 32-sector reach bound, a 7-sample penetration probe, and an
// exact-vs-conservative arbitration in the packer. That machinery could never
// produce a true minimum-translation vector: depth came from the deepest sample
// and direction from a separate face normal, and the two disagree. Resting
// contacts therefore never resolved, and overlap accumulated during play.
//
// WHY A TREE, AND WHY CUT RATHER THAN AUTHOR: a giant breaks into mids, a mid
// into smalls, a small into ordinary asteroids. The pieces have to MATCH the
// parent they came from, which is only guaranteed if they are a PARTITION of
// it. So every child is produced by cutting its parent and is literally a
// sub-polygon of it. They tile by construction, their areas sum to the parent's
// exactly, and nothing has to be hand-fitted.
//
// The leaf tier is not baked. A small's children are ordinary asteroids, which
// already exist, collide as circles and draw from the sprite atlas — the tree
// stops where a polygon collider stops paying for itself.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rockOutline, ROCK_KINDS, rockKind, mulberry32, rand, TAU } from '../src/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'rockdata.js');

// ---- Tiers -----------------------------------------------------------------
// Vertex counts fall with the tier because a piece is physically smaller: a
// giant's outline at 72 samples has ~5-unit edges at 400 drawn units, and its
// grandchild inherits that density at a third the size, which is tessellation
// nobody can see paid for on every SAT axis. Children are simplified to their
// OWN scale after cutting (see simplify).
const TIERS = [
  { name: 'giant', verts: 72, kids: [3, 4] },
  { name: 'mid',   verts: 52, kids: [2, 3] },
  { name: 'small', verts: 38, kids: [0, 0] },   // leaves — children are ordinary asteroids
];
const N_ROOTS = 5;
const SEED = 20260802;

// ---- Polygon primitives ----------------------------------------------------
// Points are {x, y}. Every polygon that leaves this file is CCW.

const area2 = (p) => {                       // twice the signed area
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
};
const polyArea = (p) => Math.abs(area2(p)) / 2;
const ccw = (p) => (area2(p) < 0 ? p.slice().reverse() : p);

function centroid(p) {
  const a2 = area2(p);
  if (Math.abs(a2) < 1e-12) {                // degenerate: fall back to the mean
    let x = 0, y = 0;
    for (const q of p) { x += q.x; y += q.y; }
    return { x: x / p.length, y: y / p.length };
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], f = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * f; cy += (a.y + b.y) * f;
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

// Polar second moment about the CENTROID at unit density. The solver needs a
// real inertia or angular response is a fudge factor again.
function inertia(p) {
  const c = centroid(p);
  let num = 0, den = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = { x: p[i].x - c.x, y: p[i].y - c.y };
    const b = { x: p[(i + 1) % n].x - c.x, y: p[(i + 1) % n].y - c.y };
    const cr = Math.abs(a.x * b.y - b.x * a.y);
    num += cr * (a.x * a.x + a.x * b.x + b.x * b.x + a.y * a.y + a.y * b.y + b.y * b.y);
    den += cr;
  }
  // Returned NORMALISED by area, so runtime scales it as mass * I * r^2.
  return den > 1e-12 ? num / (6 * den) : 0;
}

const perimeter = (p) => {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) s += Math.hypot(p[(i + 1) % n].x - p[i].x, p[(i + 1) % n].y - p[i].y);
  return s;
};
// 1 for a disc, →0 for a sliver. The one number that catches a bad cut.
const compactness = (p) => (4 * Math.PI * polyArea(p)) / Math.max(1e-9, perimeter(p) ** 2);

// Andrew's monotone chain — only ever used to measure SOLIDITY, below.
function convexHull(p) {
  const s = p.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (arr) => {
    const h = [];
    for (const q of arr) {
      while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return half(s).concat(half(s.reverse()));
}
// Area over convex-hull area. 1 = convex = "a shape", which is the complaint
// util.rockOutline's whole gouge/bite/guard apparatus exists to answer. Low is
// gnarled: somewhere the surface falls away from its own hull.
const solidity = (p) => polyArea(p) / Math.max(1e-9, polyArea(convexHull(p)));

const reachOf = (p, c = { x: 0, y: 0 }) => {
  let m = 0;
  for (const q of p) m = Math.max(m, Math.hypot(q.x - c.x, q.y - c.y));
  return m;
};

function segHit(a, b, c, d) {               // proper segment intersection
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;   // parallel — treat as a miss
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  // Endpoints excluded by a hair: a crossing exactly ON a vertex produces a
  // doubled hit and the "exactly 2" test below then rejects a perfectly good
  // cut. Nudging the interval is cheaper than special-casing it.
  if (t < 1e-9 || t > 1 - 1e-9 || u < 1e-9 || u > 1 - 1e-9) return null;
  return { t, u, x: a.x + r.x * t, y: a.y + r.y * t };
}

// Self-intersection test. O(n^2) and run on every candidate piece, because a
// polygon that crosses itself decomposes into garbage and the failure would
// only surface as a collider that behaves strangely at one bearing.
function simple(p) {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;  // adjacent through the wrap
      if (segHit(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
    }
  }
  return true;
}

// Drop vertices that are collinear-to-tolerance with their neighbours, and any
// that duplicate. Tolerance is ABSOLUTE and the caller passes it scaled to the
// piece's own size, which is the point: a fragment inherits its parent's vertex
// density and would otherwise stay tessellated for a body three times bigger.
function simplify(p, tol) {
  let out = p.filter((q, i) => {
    const r = p[(i + 1) % p.length];
    return Math.hypot(q.x - r.x, q.y - r.y) > tol * 0.5;
  });
  if (out.length < 4) return p;
  let changed = true;
  while (changed && out.length > 8) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const ax = c.x - a.x, ay = c.y - a.y, L = Math.hypot(ax, ay) || 1;
      const dev = Math.abs((b.x - a.x) * ay - (b.y - a.y) * ax) / L;
      if (dev < tol) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

// ---- The cut ---------------------------------------------------------------
// A jagged polyline spanning well past the polygon, both ends outside it.
// STRAIGHT CUTS READ AS KNIFE SLICES — a fracture face is rough, and the
// roughness is also what makes two separated pieces still look like they were
// once one rock.
function makeCut(poly, rng, ang, off, jag) {
  const c = centroid(poly), R = reachOf(poly, c) * 1.4;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const nx = -dy, ny = dx;
  const SEG = 9;
  const k1 = 1 + Math.floor(rng() * 2), k2 = 3 + Math.floor(rng() * 3);
  const p1 = rng() * TAU, p2 = rng() * TAU;
  const pts = [];
  for (let i = 0; i <= SEG; i++) {
    const t = (i / SEG) * 2 - 1;                       // -1 .. 1
    const w = jag * R * (Math.sin(k1 * t * Math.PI + p1) * 0.65 + Math.sin(k2 * t * Math.PI + p2) * 0.35);
    const s = off + w;
    pts.push({ x: c.x + dx * t * R + nx * s, y: c.y + dy * t * R + ny * s });
  }
  return pts;
}

// Split `poly` by `cut`. Returns [A, B] or null.
//
// EXACTLY TWO CROSSINGS OR NOTHING. A concave outline can be crossed four or
// six times by one line, and every general-purpose way of handling that (walking
// a planar subdivision, tracking parity) is machinery to get one piece where
// three were produced. Offline we can simply throw the cut away and try another,
// so the split stays a dozen lines and is exactly right when it succeeds.
function splitPoly(poly, cut) {
  const hits = [];
  for (let s = 0; s < cut.length - 1; s++) {
    for (let e = 0; e < poly.length; e++) {
      const h = segHit(cut[s], cut[s + 1], poly[e], poly[(e + 1) % poly.length]);
      if (h) hits.push({ seg: s, t: h.t, edge: e, u: h.u, pt: { x: h.x, y: h.y } });
    }
  }
  if (hits.length !== 2) return null;
  hits.sort((a, b) => (a.seg - b.seg) || (a.t - b.t));
  const [X0, X1] = hits;

  // Boundary from one crossing forward to the other, endpoints included.
  const walk = (from, to) => {
    const out = [{ ...from.pt }];
    let e = (from.edge + 1) % poly.length;
    for (let g = 0; g < poly.length; g++) {
      if (e === (to.edge + 1) % poly.length) break;
      out.push({ ...poly[e] });
      e = (e + 1) % poly.length;
    }
    out.push({ ...to.pt });
    return out;
  };
  // The cut vertices strictly between the two crossings.
  const spine = cut.slice(X0.seg + 1, X1.seg + 1).map((q) => ({ ...q }));

  const A = walk(X0, X1).concat(spine.slice().reverse());
  const B = walk(X1, X0).concat(spine);

  for (const p of [A, B]) {
    if (p.length < 3) return null;
    if (polyArea(p) < 1e-4) return null;
    if (!simple(p)) return null;
  }
  // Areas must account for the parent: the whole point of cutting rather than
  // authoring. A drift here means the walk lost a vertex.
  if (Math.abs(polyArea(A) + polyArea(B) - polyArea(poly)) > polyArea(poly) * 1e-6) return null;
  return [ccw(A), ccw(B)];
}

// Best of many candidate cuts. Scored on area balance and on both pieces being
// chunky rather than slivers — a fracture that shears a rind off the side is a
// worse-looking break than one that halves it, and a sliver also decomposes
// into a stack of thin hulls the collider then pays for forever.
function bestSplit(poly, rng, tries = 220) {
  const c = centroid(poly), R = reachOf(poly, c);
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < tries; i++) {
    const cut = makeCut(poly, rng, rng() * TAU, (rng() * 2 - 1) * R * 0.22, rand(rng, 0.05, 0.14));
    const r = splitPoly(poly, cut);
    if (!r) continue;
    const [A, B] = r;
    const aA = polyArea(A), aB = polyArea(B), frac = Math.min(aA, aB) / (aA + aB);
    if (frac < 0.22) continue;               // never shear off a rind
    const comp = Math.min(compactness(A), compactness(B));
    if (comp < 0.30) continue;               // never produce a sliver
    const score = frac * 2 + comp;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

// Cut `poly` into `k` pieces by repeatedly splitting the largest one.
function fracture(poly, rng, k) {
  let parts = [poly];
  let guard = 0;
  while (parts.length < k && guard++ < 40) {
    parts.sort((a, b) => polyArea(b) - polyArea(a));
    const r = bestSplit(parts[0], rng);
    if (!r) break;
    parts = r.concat(parts.slice(1));
  }
  return parts;
}

// ---- Convex decomposition --------------------------------------------------
// Ear clip to triangles, then Hertel-Mehlhorn: dissolve any diagonal whose two
// neighbouring pieces merge into something still convex. Done once, offline;
// at runtime the hull list is the entire narrow phase and SAT hands back a true
// MTV, which is the whole reason for this file.
//
// Indices, not points. A shared edge is then an integer comparison instead of a
// float one, and "is this diagonal original boundary or introduced?" is exact.

function earClip(poly) {
  const V = poly.map((_, i) => i);
  const P = poly;
  const cross = (o, a, b) => (P[a].x - P[o].x) * (P[b].y - P[o].y) - (P[a].y - P[o].y) * (P[b].x - P[o].x);
  const inTri = (a, b, c, p) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const tris = [];
  let guard = 0;
  while (V.length > 3 && guard++ < poly.length * poly.length + 50) {
    let cut = false;
    for (let i = 0; i < V.length; i++) {
      const a = V[(i - 1 + V.length) % V.length], b = V[i], c = V[(i + 1) % V.length];
      if (cross(a, b, c) <= 1e-12) continue;                 // reflex or degenerate
      let ok = true;
      for (const v of V) {
        if (v === a || v === b || v === c) continue;
        if (inTri(a, b, c, v)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push([a, b, c]);
      V.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;                                          // degenerate input
  }
  if (V.length === 3) tris.push([V[0], V[1], V[2]]);
  return tris;
}

function hertelMehlhorn(poly, tris) {
  // Original boundary edges, undirected, as "min,max" keys.
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const border = new Set();
  for (let i = 0; i < poly.length; i++) border.add(key(i, (i + 1) % poly.length));

  let parts = tris.map((t) => t.slice());
  const isConvex = (idx) => {
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      const o = poly[idx[i]], a = poly[idx[(i + 1) % n]], b = poly[idx[(i + 2) % n]];
      if ((a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) < -1e-9) return false;
    }
    return true;
  };
  // Merge across the shared edge (u,v): splice B's far side into A at that edge.
  const merge = (A, B, u, v) => {
    const ia = A.indexOf(u), ib = B.indexOf(v);
    if (ia < 0 || ib < 0) return null;
    if (A[(ia + 1) % A.length] !== v) return null;            // A must run u->v
    if (B[(ib + 1) % B.length] !== u) return null;            // B must run v->u
    // A from v the long way round to u, then B from u the long way round to v.
    const seq = [];
    for (let i = 0; i < A.length - 1; i++) seq.push(A[(ia + 1 + i) % A.length]); // v .. u-1
    seq.push(u);
    const seq2 = [];
    for (let i = 1; i < B.length - 1; i++) seq2.push(B[(ib + 1 + i) % B.length]);
    return seq.concat(seq2);
  };

  let changed = true, guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    outer:
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const A = parts[i], B = parts[j];
        for (let a = 0; a < A.length; a++) {
          const u = A[a], v = A[(a + 1) % A.length];
          if (border.has(key(u, v))) continue;                // never dissolve real boundary
          if (B.indexOf(v) < 0 || B.indexOf(u) < 0) continue;
          const m = merge(A, B, u, v);
          if (!m || m.length < 3) continue;
          if (new Set(m).size !== m.length) continue;         // merge folded back on itself
          if (!isConvex(m)) continue;
          parts.splice(j, 1); parts[i] = m;
          changed = true;
          break outer;
        }
      }
    }
  }
  return parts.map((idx) => idx.map((k) => ({ ...poly[k] })));
}

function decompose(poly) {
  const tris = earClip(poly);
  if (!tris.length) return [poly.slice()];
  return hertelMehlhorn(poly, tris);
}

// ---- Build one family ------------------------------------------------------

const shapes = {};                            // id -> record
let idSeq = 0;

// Store a polygon in its OWN frame and return its id.
//
// The scale contract, which everything downstream depends on:
//   a child's radius  = parent.radius * sqrt(child area / parent area)
//   a child's origin  = parent origin + rot(child centroid * parent.radius)
// so the stored child, scaled by its own radius, reproduces the piece exactly
// where it was. Mass then splits by area fraction and CONSERVES EXACTLY, which
// asteroidRadius (r ~ cbrt(mass)) could not do — a fracture family runs on
// r ~ sqrt(mass) because the pieces are a 2D partition. The shoal already
// decouples drawn radius from asteroidRadius via FIELD_GIANT_R_MUL, so this is
// not a new departure.
function store(poly, tier, kind, rootIdx) {
  const id = `${'gms'[tier]}${rootIdx}_${idSeq++}`;
  const c = centroid(poly);
  const local = poly.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
  // THE COLLISION MESH IS COARSER THAN THE DRAWN ONE, on purpose. Hertel-
  // Mehlhorn produces one hull per few reflex vertices, so decomposing the full
  // 72-sample giant gave 24 hulls — 576 hull pairs against another of its kind,
  // to represent grain a contact cannot express anyway. Simplifying first drops
  // it to a handful with a silhouette unchanged to the eye.
  // `v` (drawn) keeps every vertex; `hulls` (collided) does not.
  //
  // 1.2%, not 2%: simplification only ever removes area, so the collision mesh
  // sits INSIDE the drawn one and the gap is a place the player visibly clips
  // into rock. At 2% a giant's hulls covered 95.8% of its outline — a 4% skin
  // of ghost rock all the way round. This is the same tolerance the children
  // are simplified at, which is not a coincidence: both are "as coarse as you
  // can go before the shape moves".
  const hulls = decompose(ccw(simplify(local, reachOf(local) * 0.012)));
  shapes[id] = {
    id, tier, kind,
    v: local,
    hulls,
    area: polyArea(local),
    I: inertia(local),
    reach: reachOf(local),
    kids: [],
  };
  return { id, centroid: c, rec: shapes[id] };
}

const profToPoly = (prof) => {
  const p = [];
  for (let i = 0; i < prof.length; i++) {
    const a = (i / prof.length) * TAU;
    p.push({ x: Math.cos(a) * prof[i], y: Math.sin(a) * prof[i] });
  }
  return p;
};

// THE ONE SUBJECTIVE STEP, MADE OBJECTIVE. Taking the first five draws gave two
// giants that were near-convex plates — the machined-block failure design-laws
// forbids outright ("a rock is never a perturbed primitive, and never convex").
// rockOutline's own guard only promises SOME dent; a giant is the most looked-at
// rock in the game and has to be dramatic, not merely legal.
//
// So: draw a crowd, score by solidity, and pick along a SPREAD of it rather
// than taking the gnarliest five — which is util.rockOutline's own stated rule
// arriving one level up ("what carries a pocket is a handful of dramatic ones
// among the merely irregular"). Sorting by gnarl and taking the top gave two
// extreme bowties joined at a thin neck: dramatic, but five of them is as
// monotonous as five plates, and a monolith held together by a narrow waist is
// a strange thing to build a whole shoal out of.
//
// A cap per kind on top, because the kind is the other axis of variety and the
// gnarl ranking correlates with it (cleft always wins).
const SOL_TARGETS = [0.72, 0.78, 0.82, 0.86, 0.89];
function pickRoots(rng, want) {
  const KIND_CAP = 2;
  const cand = [];
  for (let i = 0; i < 200; i++) {
    const kind = rockKind(rng());
    const prof = rockOutline(rng, TIERS[0].verts, ROCK_KINDS[kind]);
    const poly = ccw(profToPoly(prof));
    const sol = solidity(poly);
    if (sol > 0.92) continue;                 // too close to its own hull
    if (compactness(poly) < 0.34) continue;   // a splinter, not a monolith
    cand.push({ kind, poly, sol });
  }
  const out = [], perKind = {}, used = new Set();
  for (let t = 0; t < want; t++) {
    const target = SOL_TARGETS[t % SOL_TARGETS.length];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < cand.length; i++) {
      if (used.has(i)) continue;
      if ((perKind[cand[i].kind] || 0) >= KIND_CAP) continue;
      const d = Math.abs(cand[i].sol - target);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) break;
    used.add(best);
    perKind[cand[best].kind] = (perKind[cand[best].kind] || 0) + 1;
    out.push(cand[best]);
  }
  return out;
}

function buildFamily(rootIdx, rng, cand) {
  const kind = cand.kind;
  const root = cand.poly;
  // RECENTRED ON ITS CENTROID BEFORE ANYTHING IS CUT FROM IT. rockOutline is a
  // radial profile about the ORIGIN, and a rock with offset lobes has its
  // centroid well away from that origin — but `store` files every polygon in
  // its own centroid frame. Leaving the root uncentred measured child offsets
  // in one frame and the parent outline in another, so every giant's pieces
  // reassembled displaced by the root's own centroid.
  const c0 = centroid(ccw(root));
  const rootPoly = ccw(root).map((p) => ({ x: p.x - c0.x, y: p.y - c0.y }));
  const top = store(rootPoly, 0, kind, rootIdx);

  const recurse = (parent, parentPoly, tier) => {
    const T = TIERS[tier];
    if (tier >= TIERS.length - 1) return;
    const k = T.kids[0] + Math.floor(rng() * (T.kids[1] - T.kids[0] + 1));
    const pieces = fracture(parentPoly, rng, k);
    if (pieces.length < 2) return;            // could not cut it — a valid leaf

    const pArea = polyArea(parentPoly);
    const kept = [];
    for (const raw of pieces) {
      const a = polyArea(raw);
      const rs = Math.sqrt(a / pArea);        // child radius / parent radius
      const c = centroid(raw);
      // Into the child's own frame, then simplified at the child's own scale.
      const local = raw.map((p) => ({ x: (p.x - c.x) / rs, y: (p.y - c.y) / rs }));
      const tol = reachOf(local) * 0.012;
      const simp = ccw(simplify(local, tol));
      if (simp.length < 3 || !simple(simp)) continue;
      kept.push({ poly: simp, cx: c.x, cy: c.y, area: a });
    }
    if (kept.length < 2) return;

    // Area fractions are renormalised over what was KEPT and taken after
    // simplification, so mass conservation is exact against the polygons that
    // actually ship rather than against the ones before the vertices moved.
    const tot = kept.reduce((s, q) => s + q.area, 0);
    for (const q of kept) {
      const child = store(q.poly, tier + 1, parent.rec.kind, rootIdx);
      parent.rec.kids.push({
        s: child.id,
        ox: q.cx, oy: q.cy,             // centroid in the PARENT's unit frame
        rs: Math.sqrt(q.area / pArea),  // radius ratio
        af: q.area / tot,               // mass fraction (sums to 1)
      });
      // CUT EXACTLY WHAT WAS STORED. A grandchild's offsets are measured in
      // whatever polygon gets passed here, and the parent it will be placed
      // against is `rec.v` — so if those two differ by so much as a
      // simplification pass, the pieces stop lining up one level down.
      recurse(child, ccw(q.poly), tier + 1);
    }
  };
  recurse(top, rootPoly, 0);
  return top.id;
}

// ---- Verify ----------------------------------------------------------------
// The bake asserts its own output. A silently wrong hull would surface only as
// a collider that misbehaves at one bearing on one rock, which is exactly the
// class of bug this whole exercise exists to end.
function verify() {
  const problems = [];
  for (const s of Object.values(shapes)) {
    if (!simple(s.v)) problems.push(`${s.id}: outline self-intersects`);
    if (area2(s.v) < 0) problems.push(`${s.id}: outline is CW`);
    let hullArea = 0;
    for (const h of s.hulls) {
      if (h.length < 3) { problems.push(`${s.id}: degenerate hull`); continue; }
      if (area2(h) < 0) problems.push(`${s.id}: hull is CW`);
      hullArea += polyArea(h);
      for (let i = 0; i < h.length; i++) {
        const o = h[i], a = h[(i + 1) % h.length], b = h[(i + 2) % h.length];
        if ((a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) < -1e-7) {
          problems.push(`${s.id}: hull is not convex`); break;
        }
      }
    }
    // The collision mesh is the simplified outline, so this is a closeness
    // check, not an identity one — but a hull set that has drifted several
    // percent from the silhouette means a merge folded and swallowed area.
    if (Math.abs(hullArea - s.area) > s.area * 0.04) {
      problems.push(`${s.id}: hulls cover ${(hullArea / s.area).toFixed(4)} of the outline`);
    }
    if (s.kids.length) {
      const sum = s.kids.reduce((a, k) => a + k.af, 0);
      if (Math.abs(sum - 1) > 1e-9) problems.push(`${s.id}: mass fractions sum to ${sum}`);
      // THE PIECES MUST LINE UP WITH THE ROCK THEY CAME FROM. Tested on the
      // actual transformed vertices, not on |offset| + childReach: that sum is
      // a triangle-inequality bound which only binds when the child's furthest
      // corner points straight out along the offset, so it reports violations
      // on perfectly nested pieces. Transform each child vertex into the
      // parent's frame exactly as the runtime break will, and measure.
      for (const k of s.kids) {
        let far = 0;
        for (const q of shapes[k.s].v) {
          far = Math.max(far, Math.hypot(k.ox + q.x * k.rs, k.oy + q.y * k.rs));
        }
        if (far > s.reach * 1.02) {
          problems.push(`${s.id}: child ${k.s} reaches ${far.toFixed(3)} vs parent ${s.reach.toFixed(3)}`);
        }
      }
      // ...and they must ACCOUNT for it: the areas of the pieces, placed back
      // in the parent's frame, sum to the parent's own area. This is the check
      // that proves they are a partition rather than merely a plausible set.
      const cover = s.kids.reduce((a, k) => a + shapes[k.s].area * k.rs * k.rs, 0);
      if (Math.abs(cover - s.area) > s.area * 0.03) {
        problems.push(`${s.id}: pieces cover ${(cover / s.area).toFixed(4)} of the parent`);
      }
    }
  }
  return problems;
}

// ---- Emit ------------------------------------------------------------------
const rnd = (v) => Math.round(v * 1000) / 1000;
const flat = (p) => `[${p.map((q) => `${rnd(q.x)},${rnd(q.y)}`).join(',')}]`;

function emit(roots) {
  const L = [];
  L.push('// GENERATED by tools/bake-rocks.mjs — do not edit by hand.');
  L.push('// Re-bake with:  node tools/bake-rocks.mjs');
  L.push('//');
  L.push('// The fixed asteroid shape library and its fracture tree. Every child is a');
  L.push('// sub-polygon of its parent (they were CUT from it, not authored separately), so');
  L.push('// the pieces tile the parent silhouette and their areas sum to it exactly.');
  L.push('//');
  L.push('// Per shape:');
  L.push('//   v      outline, CCW, flat [x,y,...], in a frame where the body radius is 1');
  L.push('//   hulls  convex decomposition of v — the entire narrow phase');
  L.push('//   area   polygon area at radius 1 (mass splits are area ratios)');
  L.push('//   I      polar second moment about the centroid, normalised by area:');
  L.push('//          a body\'s real inertia is mass * I * radius^2');
  L.push('//   reach  furthest vertex from the centroid, in body radii');
  L.push('//   kids   the pieces it breaks into. ox/oy is the piece centroid in THIS');
  L.push('//          shape\'s frame; rs is childRadius/parentRadius; af is the mass');
  L.push('//          fraction (sums to 1). A `small` has none — its children are');
  L.push('//          ordinary asteroids.');
  L.push('');
  L.push('export const ROCK_TIERS = ' + JSON.stringify(TIERS.map((t) => t.name)) + ';');
  L.push('');
  L.push('export const ROCK_SHAPES = {');
  for (const s of Object.values(shapes)) {
    L.push(`  ${s.id}: {`);
    L.push(`    tier: ${s.tier}, kind: '${s.kind}', area: ${rnd(s.area)}, I: ${rnd(s.I)}, reach: ${rnd(s.reach)},`);
    L.push(`    v: ${flat(s.v)},`);
    L.push(`    hulls: [${s.hulls.map(flat).join(',')}],`);
    // MASS FRACTIONS ARE ROUNDED, THEN MADE TO SUM TO ONE EXACTLY. Emitting
    // each at 3 decimals independently left families summing to 0.999 or 1.001,
    // which is a mass leak every time a rock breaks — small, but it compounds
    // down three tiers and it is free to not have.
    const af = s.kids.map((k) => rnd(k.af));
    if (af.length) {
      let big = 0;
      for (let i = 1; i < af.length; i++) if (af[i] > af[big]) big = i;
      af[big] = Math.round((1 - af.reduce((t, v, i) => (i === big ? t : t + v), 0)) * 1e6) / 1e6;
    }
    L.push(`    kids: [${s.kids.map((k, i) => `{s:'${k.s}',ox:${rnd(k.ox)},oy:${rnd(k.oy)},rs:${rnd(k.rs)},af:${af[i]}}`).join(',')}],`);
    L.push('  },');
  }
  L.push('};');
  L.push('');
  L.push('// The roots — one per family. Everything else is reachable through `kids`.');
  L.push('export const ROCK_ROOTS = ' + JSON.stringify(roots) + ';');
  L.push('');
  return L.join('\n');
}

// ---- Go --------------------------------------------------------------------
const rng = mulberry32(SEED);
const picked = pickRoots(rng, N_ROOTS);
if (picked.length < N_ROOTS) {
  console.error(`only ${picked.length} of ${N_ROOTS} roots cleared the gnarl bar — loosen it or draw more`);
  process.exit(1);
}
const roots = picked.map((c, i) => buildFamily(i, rng, c));
console.log('roots: ' + picked.map((c) => `${c.kind} sol=${c.sol.toFixed(2)}`).join(', '));

const problems = verify();
const byTier = [0, 0, 0];
let hullTot = 0, vertTot = 0;
for (const s of Object.values(shapes)) {
  byTier[s.tier]++; hullTot += s.hulls.length; vertTot += s.v.length;
}
const n = Object.keys(shapes).length;
console.log(`shapes: ${n}  (giants ${byTier[0]}, mids ${byTier[1]}, smalls ${byTier[2]})`);
console.log(`mean hulls/shape ${(hullTot / n).toFixed(1)}   mean verts/shape ${(vertTot / n).toFixed(1)}`);
console.log(`max hulls ${Math.max(...Object.values(shapes).map((s) => s.hulls.length))}`);

if (problems.length) {
  console.error(`\nFAILED ${problems.length} check(s):`);
  for (const p of problems.slice(0, 25)) console.error('  ' + p);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
const src = emit(roots);
writeFileSync(OUT, src);
console.log(`\nwrote ${OUT}  (${(src.length / 1024).toFixed(1)} KB)`);
