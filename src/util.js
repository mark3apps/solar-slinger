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

// ---- GRAVEL geometry ----
// The ring of radius multipliers, at EVEN bearings, that every rock which is
// NOT a shaped landmark draws: render.js's bucketed archetypes and the unique
// ring a big-but-unshaped rock builds off its id both come from here. Callers
// index it as `i / n * TAU`, so the bearings are implicit and the array is the
// whole shape. It lives in util (a leaf) rather than render because it is
// geometry, and because being importable outside a DOM is what makes it
// checkable.
//
// WHY IT IS NOT ONE OCTAVE. The ring used to be `n` independent samples of
// `1 - amp + rng() * 2 * amp`, amp 0.06-0.13 — which is a REGULAR POLYGON with
// a wobble on it, and at the sizes a shoal is made of it read as exactly that:
// octagons and decagons. Three terms replace it, and each does something the
// other two cannot:
//   ELONGATION  a 2-lobe stretch. Real rock is rarely equant, and this is the
//               single most asteroid-like thing on the list — it is what stops
//               a silhouette being "a circle with events on it".
//   LOBES       3-5 smoothstepped control points: the humps and hollows you
//               read the shape by, and the only term that survives being
//               minified into a 6px sprite.
//   CHIP        a per-vertex bite, mostly INWARD, so the outline is nibbled
//               rather than spiked. This is the term the old ring had.
// Small rock collides as a CIRCLE of b.radius (only b.bigShape gets a polygon
// narrow phase), so none of this is load-bearing for physics — it is the
// picture, and the picture is all it has to be.
export const JAG_PEAK = 1.15;   // outermost point, in body radii. See below.
export const ROCK_JAG_MAX = 46; // vertex ceiling (a rock that grows without
                                // bound must not take the path build with it)
export function rockJagRing(rng, r) {
  const t = clamp((r - 3) / 27, 0, 1);   // 0 pebble -> 1 boulder
  const n = Math.min(ROCK_JAG_MAX, 12 + Math.round(r * 0.55));
  // Every amplitude is a RANGE, not a value: a bucket of rocks that all wobble
  // by the same amount is its own kind of uniform, and the old ring's real
  // tell was that every rock in a shoal was the same rock. Drawn per archetype,
  // these span near-equant pebble to gnarled 1.7:1 boulder.
  const elong = 0.04 + rng() * (0.13 + 0.09 * t);
  const eAng = rng() * TAU;
  const nL = 3 + Math.floor(rng() * 3);
  const lAmp = 0.10 + 0.07 * t + rng() * (0.09 + 0.07 * t);
  const cAmp = 0.04 + 0.04 * t;
  const lobes = [];
  for (let k = 0; k < nL; k++) lobes.push(1 + (rng() * 2 - 1) * lAmp);
  const ring = new Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const u = (i / n) * nL, k = Math.floor(u), fr = u - k;
    const sm = fr * fr * (3 - 2 * fr);   // smoothstep: humps, not spikes
    const l0 = lobes[k % nL], l1 = lobes[(k + 1) % nL];
    const chip = rng() < 0.68 ? -rng() * cAmp : rng() * cAmp * 0.5;
    const v = (l0 + (l1 - l0) * sm) * (1 + elong * Math.cos(2 * (a - eAng))) + chip;
    ring[i] = v;
    if (v > peak) peak = v;
  }
  // NORMALISE THE PEAK, always. The sprite atlas bakes this ring into a cell
  // SPRITE_EXT body-radii wide, so a ring that reached past it would have its
  // outermost corners clipped off in the bake — and pinning the outermost
  // point also keeps every rock's drawn extent a fixed multiple of the radius
  // it collides at, which the old +-amp ring got for free by being round.
  const k = JAG_PEAK / peak;
  for (let i = 0; i < n; i++) ring[i] *= k;
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
//
// THE REPRESENTATION IS A POLAR VERTEX RING, exactly like crystalShards, and
// that is a correction worth recording. The first cut built each shape as an
// intersection of HALF-PLANES, which is convex, which made the collider a
// trivially cheap exact min — and drew as a machined block. Convex is the
// problem: broken rock reads broken because it has notches, and a convex hull
// cannot have one. Worse, closely-spaced facets swallow each other (two planes
// 0.08 rad apart only both survive if their distances agree to ~0.1%), so
// adding roughness to the half-plane form collapsed straight back to a handful
// of long flat faces. A star-shaped ring has no such trouble: every ray from
// the centre crosses the boundary exactly once, so the radial query stays a
// single interpolation, and the outline can chip inward as much as it likes.
//
// Three kinds, seeded off the body id so a rock is the same rock forever:
//   SLAB   a broken rectangle — the maze's masonry, long faces you route along
//   WEDGE  a broken triangle — points and flat backs
//   LUMP   the gnarled irregular polygon big rock always drew
// The kind sets the BASE polygon; the roughening is what makes it stone.
export const ROCK_REACH_MAX = 1.62;   // ceiling on shape.reach (broad-phase bound)
const LUT_N = 256;    // surface/normal samples per shape — see the tables in rockShape
// ROUGHNESS IS RELATIVE TO THE SEGMENT, NOT THE BODY. The first cut displaced
// each point by a fraction of its distance from the CENTRE, which on a
// 485-unit slab meant +-60-unit teeth along what reads as one flat face. The
// silhouette looked plausible and the surface was a sawtooth: the face normal
// swung ~25 degrees from one segment to the next, so the ship bouncing off a
// long flat side got kicked sideways and walked along it — the reported slide.
// Scaling to segment length instead bounds the normal deviation at
// ~atan(2 * chip), i.e. about 12 degrees, whatever size the rock is.
const EDGE_SEG = 62;    // world-ish units of edge per subdivision, at r = 1 scale
const CHIP_IN = 0.11;   // inward bite, as a fraction of the SEGMENT's length
const CHIP_OUT = 0.05;  // ...and outward
// CORNER CHAMFER depth, as a fraction of the SHORTER of the corner's two
// edges — so a cut can never eat a whole short face, and two chamfers sharing
// an edge (2 x 0.30 < 1) can never cross.
const CORNER_MIN = 0.11, CORNER_MAX = 0.30, CORNER_CAP = 0.35;
// COARSE FACET amplitude, as a fraction of the spacing between control points
// along a face. This is the mid-scale term; see the walk in `bow` below.
const FACE_BOW = 0.14;
// LONG-FACE SPLIT. A base edge longer than this (in body radii) is broken into
// sub-faces with a kink between them, of up to FACE_KINK of the edge length.
const FACE_SPLIT = 0.62, FACE_KINK = 0.09;
// ...and only on a face that runs CLEAR of the centre. A face with an end this
// close to the origin (a shard's waist) is nearly radial: its drawn radius
// already races from 0.08 to 0.9 across a few degrees of bearing, and putting
// a kink in the middle of it turns that ramp into a step. Those are the ONLY
// faces the split has to skip — a slab's or a wedge's sit at 0.7-1.0.
const FACE_SPLIT_R = 0.35;
// AND THE CAP THAT KEEPS ALL OF IT STAR-SHAPED. Every displacement above is
// bounded by an EDGE length, which says nothing about how close to the centre
// that edge runs — and near a thin part (a wedge's point, a shard's nose) a
// push that is small against the face is enormous against the local radius. It
// shoves the point past its neighbour IN BEARING, and since the ring is sorted
// by bearing the outline comes back with a hairline SLIVER in it: a radius
// discontinuity between adjacent samples, which the collider reads as a spike
// the picture barely shows. Capping displacement at a fraction of the smaller
// endpoint radius costs nothing on a fat face (it never binds there) and binds
// hard exactly where the geometry is thin. Measured over 3000 ids, this holds
// the worst adjacent-sample jump at or under what the shape family had before
// any of this was added.
const DISP_CAP = 0.16;
export function rockShape(id) {
  const rng = mulberry32(id * 2246822519 + 31);
  const roll = rng();
  const spin = rng() * TAU;
  let kind;
  let base = [];
  if (roll < 0.24) {
    kind = 'slab';
    const h = 0.30 + rng() * 0.32;
    // Corners knocked off square, so even the base is not a drawn rectangle
    for (const [sx, sy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
      base.push({ x: sx * (0.86 + rng() * 0.14), y: sy * h * (0.82 + rng() * 0.36) });
    }
  } else if (roll < 0.44) {
    kind = 'wedge';
    let a = 0;
    for (let i = 0; i < 3; i++) {
      a += (TAU / 3) * (0.74 + rng() * 0.52);
      const rr = 0.72 + rng() * 0.34;
      base.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
    }
  } else if (roll < 0.60) {
    kind = 'shard';
    // A long splinter, pointed at both ends — the piece something bigger came
    // apart along. Its narrow waist is a real navigation feature at 300 units.
    const w = 0.13 + rng() * 0.16;
    base.push({ x: 1, y: 0 });
    base.push({ x: 0.16 * (rng() - 0.5), y: w * (0.7 + rng() * 0.6) });
    base.push({ x: -0.92 - rng() * 0.08, y: w * (0.2 + rng() * 0.5) });
    base.push({ x: -0.86 - rng() * 0.14, y: -w * (0.2 + rng() * 0.5) });
    base.push({ x: 0.16 * (rng() - 0.5), y: -w * (0.7 + rng() * 0.6) });
  } else if (roll < 0.76) {
    kind = 'cleft';
    // A SPLIT boulder — round, with a deep notch bitten out of one side. This
    // one is the reason the shape moved to a star-shaped ring at all: it is
    // properly concave, and the old half-plane form could not express it.
    // The notch is a passage feature, not decoration: at giant scale you can
    // fly into a cleft and find it does not go through.
    const n = 11;
    const cut = Math.floor(rng() * n);
    const depth = 0.34 + rng() * 0.22;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const near = Math.min(Math.abs(i - cut), n - Math.abs(i - cut));
      const rr = near <= 1 ? (0.92 - depth * (near === 0 ? 1 : 0.45)) : 0.82 + rng() * 0.20;
      base.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
    }
  } else {
    kind = 'lump';
    const n = 6 + Math.floor(rng() * 4);
    let a = 0;
    for (let i = 0; i < n; i++) {
      a += (TAU / n) * (0.68 + rng() * 0.64);
      const rr = 0.74 + rng() * 0.30;
      base.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
    }
  }
  // Rotate the base into the rock's resting orientation
  const cs = Math.cos(spin), sn = Math.sin(spin);
  for (const p of base) {
    const x = p.x * cs - p.y * sn, y = p.x * sn + p.y * cs;
    p.x = x; p.y = y;
  }
  // SPLIT THE LONG FACES. The base kinds are named for shapes with long flat
  // sides, and a long flat side is what reads as drawn-with-a-ruler: at the 300+
  // units a monolith spans, one unbroken face IS the whole silhouette. So any
  // base edge past FACE_SPLIT becomes 2-3 sub-faces with a real kink between
  // them — ONE large deviation at a low slope, which is the only way to bend a
  // face by something you can see without turning it into a sawtooth. (The
  // per-segment chip below cannot do this: its displacement is bounded by the
  // SEGMENT, so on a long face it can only ever add fuzz to a straight line.)
  // It runs BEFORE the chamfer, so a kink gets its corner broken like any
  // other; and the slab stays a slab, because a face bent by 9% still reads as
  // one face you can route along.
  const split = [];
  for (let i = 0; i < base.length; i++) {
    const p = base[i], q = base[(i + 1) % base.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const len = Math.hypot(ex, ey) || 1;
    split.push(p);
    if (len < FACE_SPLIT || Math.min(Math.hypot(p.x, p.y), Math.hypot(q.x, q.y)) < FACE_SPLIT_R) continue;
    const nSub = Math.min(3, 1 + Math.floor(len / FACE_SPLIT));
    for (let k = 1; k < nSub; k++) {
      const t = (k + (rng() - 0.5) * 0.5) / nSub;
      const bx = p.x + ex * t, by = p.y + ey * t;
      const cap = DISP_CAP * Math.hypot(bx, by);
      const d = clamp((rng() * 2 - 1) * FACE_KINK * len, -cap, cap);
      split.push({ x: bx + (ey / len) * d, y: by - (ex / len) * d });
    }
  }
  base = split;
  // KNOCK THE CORNERS OFF — and this is the pass that stops a slab drawing as
  // a rectangle and a wedge as a triangle. A base polygon's CORNERS are its
  // most geometric feature: chip the faces between them all you like and four
  // right angles still read as a drawn rectangle, three points still read as a
  // drawn triangle. Nothing that has actually been broken off something bigger
  // keeps its corners — they are the first thing to go.
  //
  // Every corner becomes three points: a cut back along each of its two edges,
  // and a middle point riding between the flat cut and where the corner used
  // to be (rng() * rng() is drawn low and wide, so most corners come off blunt
  // and a few stay proud). A slab leaves here as a 12-gon, a wedge as a 9-gon.
  // Depth is measured against the SHORTER adjacent edge so a cut can never eat
  // a whole short face — which is what keeps a shard's nose a nose.
  const corners = [];
  for (let i = 0; i < base.length; i++) {
    const p = base[i];
    const pv = base[(i + base.length - 1) % base.length], nx2 = base[(i + 1) % base.length];
    const dpx = pv.x - p.x, dpy = pv.y - p.y;
    const dnx = nx2.x - p.x, dny = nx2.y - p.y;
    const lp = Math.hypot(dpx, dpy) || 1, ln = Math.hypot(dnx, dny) || 1;
    // Depth is capped by the corner's own RADIUS as well as by its edges — see
    // DISP_CAP. A shard's waist corner sits ~0.08 from the centre with metre-
    // long edges either side, and cutting it back by a third of an EDGE would
    // move it clean past its neighbours in bearing.
    const d = Math.min((CORNER_MIN + rng() * (CORNER_MAX - CORNER_MIN)) * Math.min(lp, ln),
                       CORNER_CAP * Math.hypot(p.x, p.y));
    const ax = p.x + (dpx / lp) * d, ay = p.y + (dpy / lp) * d;
    const bx = p.x + (dnx / ln) * d, by = p.y + (dny / ln) * d;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const k = rng() * rng();
    corners.push({ x: ax, y: ay });
    corners.push({ x: mx + (p.x - mx) * k, y: my + (p.y - my) * k });
    corners.push({ x: bx, y: by });
  }
  base = corners;
  // BREAK THE EDGES, AT TWO SCALES. Each edge is cut into segments and every
  // interior point is pushed along the edge normal — mostly INWARD, which is
  // the bit convexity could never give: a bitten-out edge is what makes rock
  // look fractured rather than cut. Displacement is kept well under the local
  // radius so the outline stays star-shaped about the centre and the radial
  // query stays single-valued.
  //
  // The COARSE term (`bow`) is what was missing and what made a face read as
  // drawn-with-a-ruler: a random WALK along a handful of control points,
  // de-trended so both ends stay pinned to the corners the chamfer put there.
  // Independent per-control offsets would not do — they cannot wander, so the
  // face stays on its chord and only gets fuzzy. A walk breaks the face into
  // 2-4 FACETS that each go their own way, by up to ~0.06 of the face length.
  //
  // It does not reopen the sawtooth bug the segment-relative rule above fixed,
  // because the metric that bug is about is the normal swing between ADJACENT
  // segments. Inside a facet the bow is a constant slope and adds none; it
  // spends its whole budget at the 1-3 facet breaks per face, which is a
  // corner, which is a thing this shape already has. Per-step slope is bounded
  // at 2 * FACE_BOW (~13 degrees) by construction: the step is a fraction of
  // the control SPACING, and the de-trend can only add another one of those.
  const pts = [];
  for (let i = 0; i < base.length; i++) {
    const p = base[i], q = base[(i + 1) % base.length];
    const ex = q.x - p.x, ey = q.y - p.y;
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len, ny = -ex / len;
    const segs = Math.max(2, Math.min(9, Math.round(len * EDGE_SEG / 10)));
    const seg = len / segs;
    // Same near-radial faces the split skips, and for the same reason: a
    // mid-face displacement there is a step in the radial profile, not a bend.
    const bowAmp = Math.min(Math.hypot(p.x, p.y), Math.hypot(q.x, q.y)) < FACE_SPLIT_R ? 0 : FACE_BOW;
    const nB = Math.max(1, Math.min(4, Math.round(segs / 2.5)));
    const ctrl = [0];
    for (let k = 1; k <= nB; k++) ctrl.push(ctrl[k - 1] + (rng() * 2 - 1) * bowAmp * (len / nB));
    const drift = ctrl[nB];
    for (let k = 1; k <= nB; k++) ctrl[k] -= drift * (k / nB);   // pin the far corner back
    pts.push({ x: p.x, y: p.y });
    for (let k = 1; k < segs; k++) {
      const t = k / segs + (rng() - 0.5) * 0.18 / segs;
      const bx = p.x + ex * t, by = p.y + ey * t;
      const u = t * nB, ci = Math.min(nB - 1, Math.floor(u));
      // LINEAR between controls, never smoothstepped: rock is faceted, and a
      // smooth blend would hand back the rounded, eroded look this is fixing.
      const bow = ctrl[ci] + (ctrl[ci + 1] - ctrl[ci]) * (u - ci);
      const cap = DISP_CAP * Math.hypot(bx, by);
      const push = clamp(bow + (rng() < 0.68 ? -CHIP_IN * rng() : CHIP_OUT * rng()) * seg, -cap, cap);
      pts.push({ x: bx + nx * push, y: by + ny * push });
    }
  }
  // To the polar ring the radial query walks. Sorting by bearing is what makes
  // the ring valid for interpolation; a point that has been chipped past a
  // neighbour would break monotonicity, so the sort is not cosmetic.
  const verts = pts.map((p) => ({ a: Math.atan2(p.y, p.x), r: Math.hypot(p.x, p.y) }));
  for (const v of verts) if (v.a < 0) v.a += TAU;
  verts.sort((u, v) => u.a - v.a);
  let reach = 0;
  for (const v of verts) if (v.r > reach) reach = v.r;
  if (reach > ROCK_REACH_MAX) {
    const k = ROCK_REACH_MAX / reach;
    for (const v of verts) v.r *= k;
    reach = ROCK_REACH_MAX;
  }
  // Cartesian ring for the renderer, rebuilt FROM the sorted polar ring so the
  // drawn outline is the queried one vertex for vertex.
  const ring = verts.map((v) => ({ x: Math.cos(v.a) * v.r, y: Math.sin(v.a) * v.r }));
  // ---- THE LOOKUP TABLES. This is a PERFORMANCE fix, not a modelling one.
  //
  // The collider queries this shape once per contact test, and the honest
  // walker (ringRadiusAt) is a LINEAR SCAN for the bracketing vertex — ~15
  // iterations on a 30-vertex ring. Steady state that is invisible; with rock
  // actually flying through a pocket of 125 landmark rocks it is the sim, and
  // it showed up as 10ms+ frames the moment a shoal was disturbed.
  // Sampled at even bearings once per shape, the query becomes an index. At
  // LUT_N the worst radius error is r * (1 - cos(pi/LUT_N)) — about a tenth of
  // a unit on a 400-unit giant, i.e. far below anything the collider resolves.
  // The normal table is sampled NEAREST, never interpolated: a face normal is
  // piecewise constant and blending across an edge boundary would round off the
  // corners the whole shape exists to have.
  const lut = new Float32Array(LUT_N);
  const nlx = new Float32Array(LUT_N), nly = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const th = (i / LUT_N) * TAU;
    lut[i] = ringRadiusAt(verts, th);
    const na = edgeNormalAt(verts, th);
    nlx[i] = Math.cos(na); nly[i] = Math.sin(na);
  }
  return { kind, verts, ring, reach, lut, nlx, nly };
}

// Surface reach (fraction of body radius) along a LOCAL bearing — callers
// subtract b.rot exactly as they do for crystal shards and craters. Same polar
// edge interpolation as crystalRadiusAt, so the queried surface IS the drawn
// straight edge between two ring vertices rather than a chord approximation.
export function rockSurfAt(shape, th) {
  const u = (th / TAU) * LUT_N;
  const i = Math.floor(u), fr = u - i;
  const a = shape.lut[((i % LUT_N) + LUT_N) % LUT_N];
  const b = shape.lut[((i + 1) % LUT_N + LUT_N) % LUT_N];
  return a + (b - a) * fr;
}

// THE OUTWARD SURFACE NORMAL at a local bearing — the perpendicular of the
// polygon EDGE the contact lands on, not the direction from the centre.
//
// This is the difference between a slab you bounce off and a slab you SLIDE
// along. The collision resolver takes its normal from the centre-to-centre
// line, which is correct for a circle and roughly correct for a crystal
// world's radial spikes — but on a long flat face, radial and perpendicular
// diverge by however far along the face you hit. The resolver then pushes you
// partly ALONG the face, and the contact reads as the ship skating sideways
// down the rock instead of stopping against it.
// Returns the normal's angle in the body frame; callers add b.rot.
export function rockNormalAt(shape, th) {
  const i = ((Math.round((th / TAU) * LUT_N) % LUT_N) + LUT_N) % LUT_N;
  return Math.atan2(shape.nly[i], shape.nlx[i]);
}

// The honest walker the tables are built from. Kept because the tables have to
// come from somewhere, and because it is the readable statement of what the
// surface normal IS.
function edgeNormalAt(v, th) {
  let t = th % TAU;
  if (t < 0) t += TAU;
  let i = 0;
  while (i < v.length && v[i].a <= t) i++;
  const hi = v[i % v.length], lo = v[(i + v.length - 1) % v.length];
  const x0 = Math.cos(lo.a) * lo.r, y0 = Math.sin(lo.a) * lo.r;
  const x1 = Math.cos(hi.a) * hi.r, y1 = Math.sin(hi.a) * hi.r;
  const ex = x1 - x0, ey = y1 - y0;
  // Of the edge's two perpendiculars, take the one pointing away from the
  // centre. The ring is wound by increasing bearing, so this is stable.
  let nx = ey, ny = -ex;
  if (nx * (x0 + x1) + ny * (y0 + y1) < 0) { nx = -nx; ny = -ny; }
  return Math.atan2(ny, nx);
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
// It reads the LUT, not the honest walker. This is the collider's per-contact
// query (physics.surfRadius) and render's silhouette rebuild, i.e. the two
// callers the tables were built for — the normal half already indexed them
// while the radius half was still doing the linear scan they were meant to
// replace. It matters more now the outline carries the corner and facet passes
// above: those roughly double the vertex count, and a scan is O(verts) where
// an index is not.
export function bigRockSurfAt(shape, scars, radius, th) {
  const base = rockSurfAt(shape, th);
  if (!scars || !scars.length) return base;
  return base * scarSurfaceAt(scars, radius, th);
}
