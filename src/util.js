export const TAU = Math.PI * 2;

// Is a full-screen shell modal up? Settings / Controls / Credits / Achievements
// are separate flags because each is its own panel, but every gate in the game
// treats them identically — the sim freezes, player input is blocked, the music
// ducks, the trajectory forecast hides. Kept here (a leaf) so main, hud, music
// and render can all ask without importing each other.
export const shellModal = (g) =>
  !!(g.settingsOpen || g.controlsOpen || g.creditsOpen || g.achievementsOpen);

// Can anything alien find the ship right now? Two unrelated causes, one
// answer: the dust/shroud cloak (a LOCAL hiding place, computed with release
// hysteresis in ai.js) and a live solar wave (a SYSTEM-WIDE blackout for its
// whole passage — main.js sets stormBlind, and the deafness is what makes a
// wave worth wanting). Kept here, a leaf, for the same reason as shellModal:
// ai.js's gates and render.js's hunting-eye mirror must never disagree about
// whether the ship is visible, and render must not import ai.
export const senseBlind = (g) => !!(g.dustCloak || g.stormBlind);

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Smallest signed angle from a to b, in (-PI, PI]
export function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// Deterministic seeded RNG so the world layout is stable per seed
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turn a user-typed seed into the uint32 mulberry32 wants. Plain digits stay
// themselves so a shared numeric seed round-trips EXACTLY (the number a player
// reads off the settings note is the number that regenerates their world);
// anything else is FNV-1a hashed, so a world can be named ("banana") instead of
// numbered. Never returns 0 — mulberry32 is fine with it, but a 0 reads as
// "unset" everywhere else in the seed plumbing.
export function seedFrom(text) {
  const s = String(text).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n <= 0xffffffff) return (n >>> 0) || 1;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

export function rand(rng, a, b) { return a + rng() * (b - a); }
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

// ---- IMPACT CRATER profile ----
// How much of its radius a world still HAS at a given surface-local bearing,
// once the craters its impacts carved are taken out of it.
//
// Shared by render (the drawn silhouette, `worldSil`) and physics (the felt
// one, `surfRadius`) — the same law crystal worlds run on below, and for the
// same reason: a crater you can see but cannot fly into is a hole in the
// picture only, and rocks visibly stop in mid-air across its mouth. One
// function, both consumers.
//
// `scars` are `{a, s, t}` in the body's own frame (physics.damageBody stores
// the angle minus b.rot so a crater rides the spin), so callers working in
// world bearings subtract b.rot exactly as they do for crystal shards. The
// profile is a cosine bowl WIDER and DEEPER than the piece that came out of it
// — rock does not part along a neat hemisphere — roughened by two harmonics
// seeded off the scar's own timestamp so the wall is fractured rather than
// machined, and stable frame to frame like every other seeded geometry here.
export const SCAR_MAX_CUT = 0.38;   // floor on what is left: a bite, never a hole to the core
export function scarSurfaceAt(scars, radius, th) {
  let cut = 0;
  for (let i = 0; i < scars.length; i++) {
    const sc = scars[i];
    const br = Math.max(2.2, radius * 0.06 * sc.s);
    const hw = Math.min(1.2, (br / radius) * 2.2);
    let d = th - sc.a;
    d = Math.atan2(Math.sin(d), Math.cos(d));   // wrapped angular distance
    if (d > hw || d < -hw) continue;
    const rough = 1 + 0.26 * Math.sin(sc.t * 21.7 + th * 9.3)
      + 0.16 * Math.sin(sc.t * 13.1 + th * 21.7);
    const c = (br / radius) * 0.75 * (1 + Math.cos((d / hw) * Math.PI)) * rough;
    if (c > cut) cut = c;
  }
  return cut > 0 ? 1 - Math.min(SCAR_MAX_CUT, cut) : 1;
}

// ---- CRYSTAL WORLD shard geometry ----
// Shared by render (the drawn silhouette) and physics (the polygon COLLIDER):
// both read the SAME table or the drawn surface and the felt surface disagree
// — which is exactly the mismatch this replaced. Unitless (fractions of body
// radius), seeded off the body id, deliberately irregular: shards claim
// uneven angular slots, tips sit off-center in their slot, and a few run
// huge. `verts` is the flattened polar vertex ring crystalRadiusAt walks.
// Spike reach never exceeds CRYSTAL_REACH (the broad-phase bound).
// GUARD: world.js floats a crystal world's railed junk ring at 1.45r + 80
// specifically to clear these spikes — raise CRYSTAL_REACH past ~1.4 and the
// turning spikes grind the railed probes every rotation (collision → damage
// → derail, a perpetual on-screen churn). Keep the two in ratio.
export const CRYSTAL_REACH = 1.32;
export function crystalShards(id) {
  const rng = mulberry32(id * 6151 + 7);
  const n = 9 + Math.floor(rng() * 4);
  const shares = [];
  let tot = 0;
  for (let i = 0; i < n; i++) { const w = 0.5 + rng() * 1.1; shares.push(w); tot += w; }
  const pts = [];
  let a = 0;
  for (let i = 0; i < n; i++) {
    const w = (shares[i] / tot) * TAU;
    const big = rng() < 0.3;   // a few dominant shards tower over the rest
    pts.push({
      a0: a,
      tip: a + w * (0.25 + rng() * 0.5),
      ro: big ? 1.16 + rng() * 0.16 : 1.05 + rng() * 0.08,
      ri: 1.0 + rng() * 0.05,
    });
    a += w;
  }
  const verts = [];
  for (const p of pts) { verts.push({ a: p.a0, r: p.ri }, { a: p.tip, r: p.ro }); }
  return { pts, verts };
}
// Surface reach along a LOCAL bearing for ANY polar vertex ring — the polygon
// edge between the two bracketing vertices, solved exactly, so the queried
// surface IS the drawn straight edge rather than a chord approximation.
// Shared by crystal worlds and big rock: both are rings, and one walker means
// they cannot drift apart in how they read one.
export function ringRadiusAt(v, ang) {
  let th = ang % TAU;
  if (th < 0) th += TAU;
  let i = 0;
  while (i < v.length && v[i].a <= th) i++;
  const hi = v[i % v.length], lo = v[(i + v.length - 1) % v.length];
  const aa = i === 0 ? lo.a - TAU : lo.a;
  const ab = i === v.length ? hi.a + TAU : hi.a;
  const denom = hi.r * Math.sin(ab - th) + lo.r * Math.sin(th - aa);
  return denom > 1e-9 ? (lo.r * hi.r * Math.sin(ab - aa)) / denom : Math.min(lo.r, hi.r);
}
export function crystalRadiusAt(shards, ang) { return ringRadiusAt(shards.verts, ang); }

// ---- THE ROCK OUTLINE ----
// ONE generator, for every rock in the game: the shoal's gravel, the belt's
// pebbles, and the landmark slabs and monoliths a pocket is navigated by. It
// returns r(theta) sampled at EVEN bearings — a radial function, which is what
// `b.jag` has always been and what the collider queries.
//
// WHY IT IS NOT A PERTURBED PRIMITIVE. Both silhouettes used to be a base
// shape plus noise: gravel was a regular polygon with a wobble, and a landmark
// was a rectangle, a triangle or a splinter with its edges roughened. The user
// rejected that twice — first "triangles, perfect rectangles, that's not at all
// how that'd look", and then, after the corners had been chamfered and the
// faces broken, "they just look like shapes, like a kids block toy". That is a
// verdict on the METHOD, not on the amount of noise: rounding a rectangle's
// corners leaves a rounded rectangle, and the primitive reads through whatever
// you do to it. So there is no primitive. Five terms, in this order:
//
//   LOBES    2-5 overlapping discs offset along a body axis. This is not
//            decoration, it IS the shape. Where one lobe's reach overtakes
//            another's the profile creases, and that crease is the neck that
//            makes a rock read as something broken off something bigger —
//            Itokawa and every other contact binary is two lobes and a waist.
//   STRETCH  a 2-lobe elongation. Real rock is rarely equant.
//   GRAIN    six harmonics at 1/f amplitude. One octave is a wobble; a
//            SPECTRUM is what reads as stone at every distance, because the
//            feature you notice changes with how close you are.
//   FACETS   0-5 half-plane cuts. A `min` against a line is a genuinely FLAT
//            face with two real corners, and noise cannot produce one at any
//            amplitude — this is what keeps a slab a slab and stops the whole
//            set drifting into potatoes. (An early version of this file built
//            the shape as an intersection of half-planes and NOTHING else, and
//            that drew as a machined block, because convex. The lesson was that
//            flats are a good ingredient and a terrible base.)
//   BITES    0-4 concave scallops — craters, in the silhouette, and the deepest
//            concave features a real rock has.
//
// Every term is a radial function about one origin, so the composition is one
// too. Two things fall out of that and both are load-bearing:
//   - The outline CANNOT self-intersect, however hard the terms are driven, and
//     there is no vertex sort. The previous build sorted by bearing, and a
//     point pushed past its neighbour came back as a hairline sliver — a radius
//     discontinuity the collider felt as a spike the picture barely showed.
//     That failure mode is now unreachable rather than merely bounded.
//   - The sampled profile IS the LUT physics.surfRadius reads, with no
//     resampling step in between, so the drawn edge and the collided edge are
//     the same numbers.
const GRAIN_K = [2, 3, 5, 7, 11, 17];
// Ceiling on the outermost point of any rock profile, in body radii. Physics
// broad-phases landmark rock at `b.radius * shape.reach`, so this bounds that.
export const ROCK_REACH_MAX = 1.62;
// Floor on the profile as a fraction of its own mean. Bites and facets are cut
// against this: a waist is a feature, a pinch to nothing is a shape whose
// collider has a hole in it.
const OUTLINE_FLOOR = 0.34;

// Reach of a disc at (cx, cy) radius R along a bearing, measured FROM THE
// ORIGIN — 0 when the ray misses it. Every preset keeps its lobes overlapping
// the unit core (|c| - R stays well inside it), so a ray can never skip a gap
// and spike out to a detached lobe.
function discReach(cx, cy, R, ux, uy) {
  const t = cx * ux + cy * uy;
  const disc = R * R - (cx * cx + cy * cy - t * t);
  if (disc <= 0) return 0;
  const far = t + Math.sqrt(disc);
  return far > 0 ? far : 0;
}

// The five kinds are PARAMETER PRESETS now, not five different constructions.
// They still mean what they meant, because the pocket is navigated by them and
// the docs promise them: a SLAB has long flat faces you route along, a WEDGE
// tapers to a point, a SHARD is a splinter with a narrow waist, a CLEFT has a
// notch deep enough to fly into, a LUMP is the gnarled general case.
export const ROCK_KINDS = {
  slab:  { lobes: [2, 3], off: [0.35, 0.62], lobeR: [0.62, 0.90], wander: 0.18, taper: 0,
           elong: [0.10, 0.22], grain: 0.10, facets: [3, 5], cut: [0.66, 0.90],
           bites: [0, 2], biteW: [0.20, 0.50], biteD: [0.06, 0.16] },
  wedge: { lobes: [2, 4], off: [0.30, 0.70], lobeR: [0.45, 0.85], wander: 0.22, taper: 0.55,
           elong: [0.08, 0.20], grain: 0.12, facets: [2, 5], cut: [0.66, 0.90],
           bites: [0, 2], biteW: [0.20, 0.50], biteD: [0.06, 0.18] },
  shard: { lobes: [3, 5], off: [0.45, 0.78], lobeR: [0.40, 0.70], wander: 0.10, taper: 0.35,
           elong: [0.26, 0.40], grain: 0.11, facets: [2, 4], cut: [0.68, 0.92],
           bites: [0, 2], biteW: [0.18, 0.45], biteD: [0.06, 0.16] },
  cleft: { lobes: [2, 3], off: [0.40, 0.72], lobeR: [0.55, 0.88], wander: 0.28, taper: 0.10,
           elong: [0.04, 0.16], grain: 0.11, facets: [2, 4], cut: [0.70, 0.92],
           bites: [2, 4], biteW: [0.28, 0.62], biteD: [0.14, 0.30] },
  lump:  { lobes: [2, 5], off: [0.28, 0.60], lobeR: [0.50, 0.88], wander: 0.32, taper: 0.15,
           elong: [0.04, 0.18], grain: 0.11, facets: [2, 5], cut: [0.70, 0.92],
           bites: [1, 3], biteW: [0.22, 0.55], biteD: [0.08, 0.22] },
};
// The kind mix, unchanged from when the kinds were five separate constructions.
export function rockKind(roll) {
  return roll < 0.24 ? 'slab' : roll < 0.44 ? 'wedge'
    : roll < 0.60 ? 'shard' : roll < 0.76 ? 'cleft' : 'lump';
}

// `n` samples at even bearings, mean radius normalised to 1. Cost is one pass
// of (lobes + 6 sines) per sample plus a pass per facet and per bite, paid ONCE
// per body id (physics and render both cache it on the body) or once per
// archetype for gravel.
export function rockOutline(rng, n, P) {
  const prof = new Float64Array(n);
  // ---- LOBES: a core disc plus companions strung along a body axis.
  const axis = rng() * TAU, ax = Math.cos(axis), ay = Math.sin(axis);
  const nL = P.lobes[0] + Math.floor(rng() * (P.lobes[1] - P.lobes[0] + 1));
  const lcx = [0], lcy = [0], lr = [1];
  for (let i = 1; i < nL; i++) {
    const s = rand(rng, P.off[0], P.off[1]) * (rng() < 0.5 ? -1 : 1);
    const w = (rng() * 2 - 1) * P.wander;
    // Taper shrinks a lobe with its distance out the axis — the difference
    // between a lump and something that comes to a point.
    const R = rand(rng, P.lobeR[0], P.lobeR[1]) * (1 - P.taper * Math.abs(s));
    lcx.push(ax * s - ay * w); lcy.push(ay * s + ax * w); lr.push(R);
  }
  // ---- STRETCH and GRAIN, evaluated per sample with the lobes.
  const elong = rand(rng, P.elong[0], P.elong[1]);
  const amp = [], ph = [];
  for (let j = 0; j < GRAIN_K.length; j++) {
    // Amplitude falls as 1/k^0.85 — the 1/f slope that makes the roughness read
    // the same at every zoom — jittered per harmonic so two rocks with the same
    // preset never wear the same texture.
    amp.push((P.grain / Math.pow(GRAIN_K[j], 0.85)) * (0.5 + rng()));
    ph.push(rng() * TAU);
  }
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU, ux = Math.cos(th), uy = Math.sin(th);
    let r = 0;
    for (let k = 0; k < lcx.length; k++) {
      const d = discReach(lcx[k], lcy[k], lr[k], ux, uy);
      if (d > r) r = d;
    }
    let g = 1;
    for (let j = 0; j < GRAIN_K.length; j++) g += amp[j] * Math.sin(GRAIN_K[j] * th + ph[j]);
    prof[i] = r * (1 + elong * Math.cos(2 * (th - axis))) * g;
  }
  // ---- FACETS: min against a line through a point at `cut` of the current
  // reach in that direction. The cut is taken AFTER the grain so the face comes
  // out genuinely flat, with the two corners that make it read as fracture.
  const nF = P.facets[0] + Math.floor(rng() * (P.facets[1] - P.facets[0] + 1));
  for (let f = 0; f < nF; f++) {
    const fi = Math.floor(rng() * n), psi = (fi / n) * TAU;
    const p = prof[fi] * rand(rng, P.cut[0], P.cut[1]);
    for (let i = 0; i < n; i++) {
      const c = Math.cos((i / n) * TAU - psi);
      // Past ~83 degrees off the facet normal the line runs away to infinity and
      // stops constraining anything; skipping it there also keeps p/c finite.
      if (c > 0.12) { const lim = p / c; if (lim < prof[i]) prof[i] = lim; }
    }
  }
  // ---- BITES: cosine scallops taken out of the outline.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n;
  const nB = P.bites[0] + Math.floor(rng() * (P.bites[1] - P.bites[0] + 1));
  for (let b = 0; b < nB; b++) {
    const bth = rng() * TAU;
    const hw = rand(rng, P.biteW[0], P.biteW[1]);
    const dep = rand(rng, P.biteD[0], P.biteD[1]) * mean;
    for (let i = 0; i < n; i++) {
      let d = (i / n) * TAU - bth;
      d = Math.atan2(Math.sin(d), Math.cos(d));   // wrapped angular distance
      if (d > hw || d < -hw) continue;
      prof[i] -= dep * 0.5 * (1 + Math.cos((d / hw) * Math.PI));
    }
  }
  // ---- NORMALISE to a mean radius of 1 — MEAN, not peak, so a body draws the
  // size it collides at whether it came out knobbly or smooth — then hold the
  // floor and the broad-phase ceiling.
  mean = 0;
  for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n;
  const k = mean > 1e-6 ? 1 / mean : 1;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = prof[i] * k;
    prof[i] = v < OUTLINE_FLOOR ? OUTLINE_FLOOR : v;
    if (prof[i] > peak) peak = prof[i];
  }
  if (peak > ROCK_REACH_MAX) {
    const s = ROCK_REACH_MAX / peak;
    for (let i = 0; i < n; i++) prof[i] *= s;
  }
  return prof;
}

// ---- GRAVEL ----
// The ring every rock that is NOT a shaped landmark draws: render.js's bucketed
// archetypes and the unique ring a big-but-unshaped rock builds off its id.
// Callers index it as `i / n * TAU`, so the bearings are implicit and the array
// is the whole shape.
//
// Same generator and the same five kinds as the landmarks, at a coarser sample
// count — a shoal should be made of ONE material, and the old split (potatoes
// down here, blocks up there) was visible as soon as a giant sat among its own
// gravel. Small rock collides as a CIRCLE of b.radius (only b.bigShape gets a
// polygon narrow phase), so none of this is load-bearing for physics.
export const JAG_PEAK = 1.38;   // outermost point a gravel ring may reach
export const ROCK_JAG_MAX = 48; // vertex ceiling (a rock that grows without
                                // bound must not take the path build with it)
// Gravel is drawn SQUATTER than a landmark of the same kind: the elongation and
// the lobe offsets are pulled toward the middle. Not a fudge — it is what the
// sprite cell costs. The cell has to span the ring's longest axis, so the
// atlas pays for the peak-to-mean ratio in memory (a full-strength ring wants
// SPRITE_EXT ~1.63 and 6.2 MB of the 8 MB budget against 5.0 at 1.46), and a
// 1.7:1 splinter drawn at 8 px is three pixels wide — it reads as a speck, not
// as a splinter. The extremes cost real memory exactly where they cannot be
// seen. Landmarks, which you fly up to, keep theirs in full.
const GRAVEL_SQUAT = 0.5, GRAVEL_OFF = 0.7;
export function rockJagRing(rng, r) {
  // Sample count rises with radius: enough that a facet is a face and a bite is
  // a bite rather than one stray vertex, and bounded above.
  const n = Math.min(ROCK_JAG_MAX, 16 + Math.round(r * 0.7));
  const K = ROCK_KINDS[rockKind(rng())];
  const prof = rockOutline(rng, n, {
    ...K,
    elong: [K.elong[0] * GRAVEL_SQUAT, K.elong[1] * GRAVEL_SQUAT],
    off: [K.off[0] * GRAVEL_OFF, K.off[1] * GRAVEL_OFF],
  });
  // Held under JAG_PEAK because the sprite atlas bakes this ring into a cell
  // SPRITE_EXT body-radii wide — a ring reaching past it would have its
  // outermost corners clipped off in the bake. Scaling (rather than clipping)
  // keeps the shape and only ever shrinks the knobbliest few percent.
  let peak = 0;
  for (let i = 0; i < n; i++) if (prof[i] > peak) peak = prof[i];
  const ring = new Array(n);
  const k = peak > JAG_PEAK ? JAG_PEAK / peak : 1;
  for (let i = 0; i < n; i++) ring[i] = prof[i] * k;
  return ring;
}

// ---- BIG ROCK geometry ----
// The shape a landmark rock is BOTH drawn as and collided as. Same law as the
// crystal shards above and the crater profile above that, and it fixed the same
// complaint: the big rocks are visibly irregular — slabs, wedges, gnarled
// lumps — and every one of them collided as a plain circle, so you bounced off
// empty space beside a wedge's point and flew through the corner of a slab.
//
// Only rocks flagged b.bigShape (world.shapeBig) carry one. A pocket holds
// thousands of pebbles a few units across; giving those a polygon narrow phase
// would cost the collision sweep dearly to fix something no player can see.
// That split is the same one crystal worlds make against every other world.
const LUT_N = 256;    // profile / normal samples per shape

// A shape is its profile plus the tables physics indexes.
//
// THE TABLES ARE A PERFORMANCE FIX. The collider queries a shape once per
// contact test, and walking a vertex ring for the bracketing pair is a linear
// scan; with rock actually flying through a pocket of 125 landmark rocks that
// showed up as 10ms+ frames the moment a shoal was disturbed. Sampled at even
// bearings, the query is an index. At LUT_N the worst radius error against the
// drawn polygon is under a tenth of a unit on a 400-unit giant.
//
// The normal table is sampled NEAREST, never interpolated: a face normal is
// piecewise constant, and blending across an edge boundary would round off the
// corners the whole shape exists to have.
export function rockShape(id) {
  const rng = mulberry32(id * 2246822519 + 31);
  const kind = rockKind(rng());
  const lut = rockOutline(rng, LUT_N, ROCK_KINDS[kind]);
  const verts = new Array(LUT_N), ring = new Array(LUT_N);
  let reach = 0;
  for (let i = 0; i < LUT_N; i++) {
    const a = (i / LUT_N) * TAU, r = lut[i];
    verts[i] = { a, r };
    ring[i] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    if (r > reach) reach = r;
  }
  // THE OUTWARD SURFACE NORMAL of each edge — the perpendicular of the polygon
  // EDGE, not the direction from the centre. That difference is a slab you
  // bounce off against a slab you SLIDE along: the resolver takes its normal
  // from the centre-to-centre line, which is correct for a circle and wrong by
  // however far along a flat face you hit it, and the contact then reads as the
  // ship skating sideways down the rock. Built straight off the even-bearing
  // ring, so it is one pass rather than a search per sample.
  const nlx = new Float32Array(LUT_N), nly = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const p = ring[i], q = ring[(i + 1) % LUT_N];
    let nx = q.y - p.y, ny = -(q.x - p.x);
    // Of the edge's two perpendiculars, take the one pointing away from the
    // centre. The ring is wound by increasing bearing, so this is stable.
    if (nx * (p.x + q.x) + ny * (p.y + q.y) < 0) { nx = -nx; ny = -ny; }
    const m = Math.hypot(nx, ny) || 1;
    nlx[i] = nx / m; nly[i] = ny / m;
  }
  return { kind, verts, ring, reach, lut, nlx, nly };
}

// Surface reach (fraction of body radius) along a LOCAL bearing — callers
// subtract b.rot exactly as they do for crystal shards and craters. A plain
// index plus a lerp, because the profile is already sampled at even bearings:
// the search crystalRadiusAt has to do does not exist here.
export function rockSurfAt(shape, th) {
  const u = (th / TAU) * LUT_N;
  const i = Math.floor(u), fr = u - i;
  const a = shape.lut[((i % LUT_N) + LUT_N) % LUT_N];
  const b = shape.lut[((i + 1) % LUT_N + LUT_N) % LUT_N];
  return a + (b - a) * fr;
}

// THE OUTWARD SURFACE NORMAL at a local bearing — the perpendicular of the
// polygon EDGE the contact lands on, not the direction from the centre. Built
// in rockShape; see the note there for why the difference matters.
// Returns the normal's angle in the body frame; callers add b.rot.
export function rockNormalAt(shape, th) {
  const i = ((Math.round((th / TAU) * LUT_N) % LUT_N) + LUT_N) % LUT_N;
  return Math.atan2(shape.nly[i], shape.nlx[i]);
}

// THE BIG-ROCK SURFACE — its broken outline with its impact craters taken out
// of it. This is the one profile render and physics both read, so a landmark
// rock obeys the CRUMBLE law the worlds do: the crater you can see is the
// crater you can fly into.
//
// Composition, not replacement: the shape ring says what the rock IS, and
// scarSurfaceAt (the SAME crater profile moons and planets wear) says what has
// since been knocked out of it. Multiplying keeps craters proportional on a
// wedge's thin point as well as on a slab's broad face — an additive cut would
// punch straight through the narrow parts.
// physics.damageBody already records b.scars on rocks ("wear is universal");
// until this, nothing on a rock ever read them back.
export function bigRockSurfAt(shape, scars, radius, th) {
  const base = rockSurfAt(shape, th);
  if (!scars || !scars.length) return base;
  return base * scarSurfaceAt(scars, radius, th);
}
