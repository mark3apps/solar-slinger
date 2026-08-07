// Headless checks for src/rockshape.js.  node tools/test-rockshape.mjs
//
// THE ONE THAT MATTERS is "MTV separates": push a body by depth along the
// contact normal and the pair must come apart. The collider this replaces could
// not pass it even in principle — its depth and its direction were different
// measurements — and every symptom in the shoal (rocks resting inside each
// other, overlap accumulating the longer you played, pieces snapping apart when
// touched) was that one failure wearing different clothes.

import { rockContact, rockContacts, rockOverlap, rockShapeOf, rockReach, rockSurfAt, reachAt } from '../src/rockshape.js';
import { ROCK_SHAPES, ROCK_ROOTS } from '../src/rockdata.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg); } };

// A deterministic little rng so a failure is reproducible.
let s = 123456789;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const ids = Object.keys(ROCK_SHAPES);
const body = (id, x, y, rot, radius) => ({ id: 1, shapeId: id, x, y, rot, radius });

console.log('shapes in library:', ids.length);

// ---- 1. Far apart is never a contact ---------------------------------------
for (let i = 0; i < 400; i++) {
  const a = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 40 + rnd() * 300);
  const b = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 40 + rnd() * 300);
  const d = (rockReach(a) + rockReach(b)) * 1.05;
  const th = rnd() * Math.PI * 2;
  b.x = Math.cos(th) * d; b.y = Math.sin(th) * d;
  ok(!rockOverlap(a, b), `separated pair reported overlapping (${a.shapeId} vs ${b.shapeId})`);
  ok(rockContact(a, b) === null, `separated pair produced a contact`);
}
console.log(`separation: ${pass} ok`);

// ---- 2. The MTV separates ---------------------------------------------------
let mtvTested = 0, mtvBad = 0, worstResidual = 0, worstIters = 0;
const hist = new Array(13).fill(0);
for (let i = 0; i < 3000; i++) {
  const a = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 40 + rnd() * 300);
  const b = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 40 + rnd() * 300);
  // A REALISTIC overlap, not an arbitrary one. Bisect along the bearing for the
  // exact distance at which the two just touch, then push in by a few units.
  // Dropping bodies at a random fraction of combined reach instead puts one
  // monolith most of the way inside another, which no substep can produce: at
  // CFG.DT and a fast throw the deepest penetration a frame can create is ~17
  // units against rocks 40-400 across, and a resting contact is under one. A
  // suite that fails on configurations the sim cannot reach measures nothing.
  const th = rnd() * Math.PI * 2;
  const put = (d) => { b.x = Math.cos(th) * d; b.y = Math.sin(th) * d; b._hw = null; };
  let lo = 0, hi = rockReach(a) + rockReach(b);
  for (let k = 0; k < 34; k++) {
    const mid = (lo + hi) / 2;
    put(mid);
    if (rockOverlap(a, b)) lo = mid; else hi = mid;
  }
  put(Math.max(0, hi - (0.5 + rnd() * 18)));
  const c = rockContact(a, b);
  if (!c) continue;
  mtvTested++;
  ok(c.depth > 0, 'contact with non-positive depth');
  ok(Number.isFinite(c.nx) && Number.isFinite(c.ny), 'non-finite normal');
  ok(Math.abs(Math.hypot(c.nx, c.ny) - 1) < 1e-6, 'normal is not unit length');
  ok(c.points.length >= 1 && c.points.length <= 2, 'manifold has a bad point count');

  // NOTE there is deliberately no "the normal points from a toward b" check.
  // For a decomposed body that is simply not true: two gnarled rocks can catch
  // on a corner whose contact normal points back across the centre line, and
  // that is the behaviour shaped collision exists to have. Asserting it was a
  // test bug, and the old collider's habit of taking its normal from the
  // centre-to-centre line was the same mistake in the engine.

  // PUSH BY THE MTV AND THEY MUST COME APART — iterating, because a decomposed
  // pair has no single separating vector (see rockContacts). This is exactly
  // what the solver does, so the iteration count is a real budget, not a
  // convenience: if this needs many passes to converge, so will the game.
  let m = { ...b, _hw: null, _rs: null };
  let iters = 0;
  while (iters < 12) {
    const cs = rockContacts(a, m);
    if (!cs.length) break;
    iters++;
    m = { ...m, x: m.x + cs[0].nx * cs[0].depth * 1.02, y: m.y + cs[0].ny * cs[0].depth * 1.02, _hw: null };
  }
  worstIters = Math.max(worstIters, iters);
  hist[Math.min(iters, hist.length - 1)]++;
  // "Separated" means the residual is a rounding sliver, not literally zero
  // overlap: the separated state is exactly tangent, so a float comparison there
  // is a coin flip and the 1.02 push factor lands on either side of it at
  // random. A pair that is genuinely still stuck leaves a residual comparable to
  // what it started with; converged pairs leave a fraction of a percent.
  const c2 = rockContact(a, m);
  if (c2) {
    const res = c2.depth / Math.max(1e-9, c.depth);
    worstResidual = Math.max(worstResidual, res);
    if (res > 0.01) mtvBad++;
  }
}
console.log(`MTV: ${mtvTested} pairs, ${mtvBad} still stuck, worst residual ` +
  `${(worstResidual * 100).toFixed(2)}% of the original depth`);
console.log(`     iterations to separate: ` +
  hist.map((n, i) => (n ? `${i}:${n}` : null)).filter(Boolean).join('  '));
ok(mtvBad === 0, `${mtvBad} pairs did not separate`);
// The budget is on the TYPICAL case, not the tail. The solver is iterative and
// carries slop, so a rare configuration needing several passes just resolves
// over a few substeps; what would be fatal is the common case being slow.
const med = hist.findIndex((_, i) => hist.slice(0, i + 1).reduce((t, n) => t + n, 0) > mtvTested * 0.5);
ok(med <= 2, `median separation took ${med} iterations — too slow for the solver`);
ok(hist.slice(5).reduce((t, n) => t + n, 0) < mtvTested * 0.01,
  `${hist.slice(5).reduce((t, n) => t + n, 0)} pairs needed 5+ iterations`);

// ---- 3. Contact points lie on the overlap ----------------------------------
// MEASURED IN BOTH REGIMES, GATED ON ONE. A contact point must lie inside both
// bodies, or its impulse acts on a lever arm the rock does not have. That holds
// at the penetration depths a substep can actually produce; it degrades once
// one monolith is dropped most of the way inside another, because the manifold
// then has genuinely ambiguous faces to choose between. The deep number is
// reported rather than asserted — it is a property of a configuration the sim
// cannot reach, and gating on it would mean tuning the collider for a case that
// never occurs at the expense of the one that always does.
function pointExcess(deep) {
  let eA = 0, eB = 0;
  for (let i = 0; i < 600; i++) {
    const a = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 60 + rnd() * 200);
    const b = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 60 + rnd() * 200);
    const th = rnd() * Math.PI * 2;
    const put = (d) => { b.x = Math.cos(th) * d; b.y = Math.sin(th) * d; b._hw = null; };
    if (deep) {
      put((rockReach(a) + rockReach(b)) * (0.3 + rnd() * 0.4));
    } else {
      let lo = 0, hi = rockReach(a) + rockReach(b);
      for (let k = 0; k < 34; k++) { const m = (lo + hi) / 2; put(m); if (rockOverlap(a, b)) lo = m; else hi = m; }
      put(Math.max(0, hi - (0.5 + rnd() * 18)));
    }
    const c = rockContact(a, b);
    if (!c) continue;
    // A POINT IS A POSITION, NOT A DEPTH — the one depth in a manifold is the SAT
    // axis's, and it is checked HERE rather than per point (see the note in
    // rockshape.manifold; a per-point `depth` existed, was read by nothing, and
    // reported 0 on every corner contact by construction). Gated in the deep
    // regime as well as the realistic one: point PLACEMENT degrades when one
    // monolith is dropped inside another, but the axis depth must stay a real
    // positive number in both, or the push has no magnitude.
    ok(Number.isFinite(c.depth) && c.depth > 0, 'manifold depth is not a positive number');
    for (const p of c.points) {
      // No per-point `depth` any more — the manifold carries one depth for the pair.
      // What actually measures point PLACEMENT is finiteness plus the eA/eB reach
      // accumulation below; asserting on the dropped field only ever read undefined.
      ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'non-finite contact point');
      eA = Math.max(eA, Math.hypot(p.x - a.x, p.y - a.y) / rockReach(a));
      eB = Math.max(eB, Math.hypot(p.x - b.x, p.y - b.y) / rockReach(b));
    }
  }
  return [eA, eB];
}
const [rA, rB] = pointExcess(false);
const [dA, dB] = pointExcess(true);
console.log(`contact points, realistic depth: furthest ${rA.toFixed(3)} / ${rB.toFixed(3)} of reach`);
console.log(`                deep interlock:  furthest ${dA.toFixed(3)} / ${dB.toFixed(3)} of reach  (reported, not gated)`);
ok(rA < 1.02 && rB < 1.02, 'a contact point sat outside the bodies it belongs to');

// ---- 4. Scale invariance ----------------------------------------------------
// One baked decomposition has to serve a 20-unit chip and a 400-unit monolith.
// Uniform scale cannot break convexity, so the same configuration scaled up must
// give the same contact scaled up.
for (let i = 0; i < 300; i++) {
  const idA = ids[(rnd() * ids.length) | 0], idB = ids[(rnd() * ids.length) | 0];
  const rot1 = rnd() * 7, rot2 = rnd() * 7;
  const f = 7.3;
  const a1 = body(idA, 0, 0, rot1, 30), b1 = body(idB, 22, 9, rot2, 26);
  const a2 = body(idA, 0, 0, rot1, 30 * f), b2 = body(idB, 22 * f, 9 * f, rot2, 26 * f);
  const c1 = rockContact(a1, b1), c2 = rockContact(a2, b2);
  ok(!!c1 === !!c2, 'scale changed whether a contact exists');
  if (c1 && c2) {
    ok(Math.abs(c2.depth / f - c1.depth) < 1e-6 * Math.max(1, c1.depth), 'depth is not scale-linear');
    ok(Math.abs(c1.nx - c2.nx) < 1e-6 && Math.abs(c1.ny - c2.ny) < 1e-6, 'normal changed with scale');
  }
}

// ---- 5. Surface query agrees with the outline -------------------------------
for (let i = 0; i < 200; i++) {
  const b = body(ids[(rnd() * ids.length) | 0], 0, 0, rnd() * 7, 50 + rnd() * 150);
  const th = rnd() * Math.PI * 2;
  const r = rockSurfAt(b, th);
  ok(r > 0 && r <= rockReach(b) * 1.001, `surface radius ${r} out of range (reach ${rockReach(b)})`);
}

// ---- 6. The reach bound is actually a bound ---------------------------------
// world.js's packer ACCEPTS on reachAt without running an exact test whenever it
// reports room, so a sector that under-reports by a unit is a rock placed inside
// its neighbour. Built from vertices alone it under-reported badly on the
// simplified small shapes — an edge sweeping four sectors left the middle ones
// reading zero — and put 74 interpenetrating pairs into a freshly seeded pocket.
// Nothing else in the suite would have caught it: every SAT test passed, because
// SAT was never asked.
let bound = 0, boundBad = 0;
for (const id of ids) {
  const b = body(id, 0, 0, 0, 100);
  for (let i = 0; i < 720; i++) {
    const th = (i / 720) * Math.PI * 2;
    const surf = rockSurfAt(b, th) / 100;          // actual outline, in body radii
    const bnd = reachAt(id, th);
    if (surf > bnd + 1e-9) { boundBad++; bound = Math.max(bound, surf - bnd); }
  }
}
console.log(`reach bound: ${boundBad} bearings under-reported` +
  (boundBad ? `, worst by ${bound.toFixed(4)} body radii` : ''));
ok(boundBad === 0, `reachAt under-reported on ${boundBad} bearings — the packer trusts this`);

// ---- 7. Fracture bookkeeping ------------------------------------------------
for (const id of ids) {
  const sh = ROCK_SHAPES[id];
  if (!sh.kids.length) continue;
  const sum = sh.kids.reduce((a, k) => a + k.af, 0);
  ok(Math.abs(sum - 1) < 1e-5, `${id}: mass fractions sum to ${sum}`);
  // The area the pieces occupy must account for the parent — the property that
  // makes "the pieces match and line up" true rather than merely plausible.
  const cover = sh.kids.reduce((a, k) => a + ROCK_SHAPES[k.s].area * k.rs * k.rs, 0);
  ok(Math.abs(cover / sh.area - 1) < 0.04, `${id}: pieces cover ${(cover / sh.area).toFixed(3)} of the parent`);
}
ok(ROCK_ROOTS.every((r) => ROCK_SHAPES[r] && ROCK_SHAPES[r].tier === 0), 'a root is not a tier-0 shape');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
