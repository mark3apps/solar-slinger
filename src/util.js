export const TAU = Math.PI * 2;

// Is a full-screen shell modal up? Settings, Controls, Credits, Achievements
// and the system Chart each get their own flag because each is its own panel,
// but every gate in the game treats them identically — the sim freezes, player
// input is blocked, the music ducks, the trajectory forecast hides. Kept here
// (a leaf) so main, hud, music and render can all ask without importing each
// other.
//
// The CHART is in the set for a reason worth stating: it is a full-screen
// instrument you read and plot on, and reading it under fire — while a wave
// climbs at you and the sky keeps moving — would make it a thing you daren't
// open. Freezing is also what lets it be a chart at all rather than a live
// display: the positions you click are the positions you saw.
export const shellModal = (g) =>
  !!(g.settingsOpen || g.controlsOpen || g.creditsOpen || g.achievementsOpen || g.mapOpen);

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
// Lowered from 0.34 to let a gouge actually bite: at 0.34 the deep notches
// bottomed out on the floor and came back as flat-bottomed dishes, all the
// same depth. This is as close to the middle as any surface may come — and the
// star-shaped representation is what bounds it, because a ray from the centre
// crosses the outline exactly once. That is also the honest limit of what this
// can express: a rock may be notched, waisted, hollowed, cut most of the way
// through — but never HOOKED, because an overhang would put two surfaces on one
// bearing and the collider's whole narrow phase is a single radial query.
const OUTLINE_FLOOR = 0.19;

// cos/sin at each of `n` even bearings, built once per sample count and shared.
// Everything below walks the same bearings — the outline's own loop, the facet
// cuts, the bites, the dent measure — and computing them inline cost more than
// the shape maths did (the dent measure alone wanted 4,600 trig calls a rock).
const trigTables = new Map();
function bearings(n) {
  let t = trigTables.get(n);
  if (!t) {
    t = { c: new Float64Array(n), s: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      t.c[i] = Math.cos(a); t.s[i] = Math.sin(a);
    }
    trigTables.set(n, t);
  }
  return t;
}

// THE DEEPEST DENT in the outline, as a fraction of the straight line drawn
// across it — 0 for anything convex, and it rises with how far the surface
// falls away from its own hull. Cheaper than a hull (one pass, no sort) and it
// measures the thing that actually matters: whether there is somewhere the rock
// is missing a piece. Used as the guard in rockOutline; also the number the
// presets are tuned against, because SOLIDITY (area over hull area) is a bad
// proxy here — a notch cut most of the way to the centre removes very little
// AREA, so a set of properly notched rocks still measures 0.87 solid.
// Measured at THREE window widths, because one window only sees dents of about
// its own size: a chord drawn across a narrow window sits inside a wide bay and
// reports it as flat, which had the guard firing on exactly the rocks that
// least needed it.
function chordDeficit(prof, n) {
  const { c, s } = bearings(n);
  let worst = 0;
  for (const frac of [12, 6, 3.5]) {
    const w = Math.max(2, Math.round(n / frac));
    for (let i = 0; i < n; i++) {
      const ia = (i - w + n) % n, ib = (i + w) % n;
      const axp = c[ia] * prof[ia], ayp = s[ia] * prof[ia];
      const bxp = c[ib] * prof[ib], byp = s[ib] * prof[ib];
      // Where the ray at bearing i crosses the chord from a to b.
      const den = (byp - ayp) * c[i] - (bxp - axp) * s[i];
      if (den > -1e-9 && den < 1e-9) continue;
      const rc = (axp * byp - ayp * bxp) / den;
      if (rc > 0 && prof[i] < rc) {
        const d = 1 - prof[i] / rc;
        if (d > worst) worst = d;
      }
    }
  }
  return worst;
}
const CONCAVE_MIN = 0.10;   // every rock must dent at least this much

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
// `gougeP` is the chance of ONE dominant concave feature on top of the ordinary
// bites — a notch cut most of the way to the middle, deep enough that the rock
// reads as hollowed rather than nibbled. It is a CHANCE and not a term every
// rock gets, because a field where everything is gouged reads as uniform again;
// what carries a pocket is a handful of dramatic ones among the merely
// irregular. Landmarks are gouged more often than gravel because you fly up to
// them and can fly INTO the result.
export const ROCK_KINDS = {
  slab:  { lobes: [2, 3], off: [0.35, 0.62], lobeR: [0.62, 0.90], wander: 0.18, taper: 0,
           elong: [0.10, 0.22], grain: 0.10, facets: [2, 4], cut: [0.70, 0.92],
           bites: [0, 2], biteW: [0.20, 0.50], biteD: [0.06, 0.16],
           gougeP: 0.34, gougeW: [0.45, 0.95], gougeD: [0.45, 0.72], gougeTwin: 0.25 },
  wedge: { lobes: [2, 4], off: [0.30, 0.70], lobeR: [0.45, 0.85], wander: 0.22, taper: 0.55,
           elong: [0.08, 0.20], grain: 0.12, facets: [2, 4], cut: [0.70, 0.92],
           bites: [0, 2], biteW: [0.20, 0.50], biteD: [0.06, 0.18],
           gougeP: 0.34, gougeW: [0.42, 0.90], gougeD: [0.45, 0.72], gougeTwin: 0.25 },
  shard: { lobes: [3, 5], off: [0.45, 0.78], lobeR: [0.40, 0.70], wander: 0.10, taper: 0.35,
           elong: [0.26, 0.40], grain: 0.11, facets: [2, 4], cut: [0.68, 0.92],
           bites: [0, 2], biteW: [0.18, 0.45], biteD: [0.06, 0.16],
           gougeP: 0.26, gougeW: [0.30, 0.70], gougeD: [0.40, 0.66], gougeTwin: 0.35 },
  // The CLEFT is the concave kind and always carries one: widely separated
  // lobes for a deep natural waist, and a gouge on top of it.
  cleft: { lobes: [2, 3], off: [0.55, 0.86], lobeR: [0.48, 0.80], wander: 0.30, taper: 0.10,
           elong: [0.04, 0.16], grain: 0.11, facets: [1, 3], cut: [0.70, 0.92],
           bites: [1, 3], biteW: [0.28, 0.62], biteD: [0.14, 0.34],
           gougeP: 1, gougeW: [0.55, 1.15], gougeD: [0.60, 0.92], gougeTwin: 0.55 },
  lump:  { lobes: [2, 5], off: [0.28, 0.66], lobeR: [0.50, 0.88], wander: 0.32, taper: 0.15,
           elong: [0.04, 0.18], grain: 0.11, facets: [2, 5], cut: [0.70, 0.92],
           bites: [1, 3], biteW: [0.22, 0.55], biteD: [0.08, 0.22],
           gougeP: 0.40, gougeW: [0.48, 1.00], gougeD: [0.48, 0.80], gougeTwin: 0.35 },
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
  const { c: bc, s: bs } = bearings(n);
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU;
    let r = 0;
    for (let k = 0; k < lcx.length; k++) {
      const d = discReach(lcx[k], lcy[k], lr[k], bc[i], bs[i]);
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
    const fi = Math.floor(rng() * n);
    const p = prof[fi] * rand(rng, P.cut[0], P.cut[1]);
    for (let i = 0; i < n; i++) {
      // cos(theta_i - psi) off the table, both being sample bearings.
      const c = bc[i] * bc[fi] + bs[i] * bs[fi];
      // Past ~83 degrees off the facet normal the line runs away to infinity and
      // stops constraining anything; skipping it there also keeps p/c finite.
      if (c > 0.12) { const lim = p / c; if (lim < prof[i]) prof[i] = lim; }
    }
  }
  // ---- BITES: cosine scallops taken out of the outline.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n;
  const cuts = [];
  const nB = P.bites[0] + Math.floor(rng() * (P.bites[1] - P.bites[0] + 1));
  for (let b = 0; b < nB; b++) {
    cuts.push({ th: rng() * TAU, hw: rand(rng, P.biteW[0], P.biteW[1]),
      dep: rand(rng, P.biteD[0], P.biteD[1]) * mean, big: false });
  }
  const gouge = (th, hw, dep) => ({ th, hw, dep, big: true });
  // THE GOUGE — one dominant concave feature, WIDE as well as deep. Width is
  // the half of it that matters and the half that is easy to get wrong: a
  // narrow notch removes almost no area however deep it goes, so it reads as a
  // crack, not as a rock with a piece missing. Measured as solidity (area over
  // convex-hull area), narrow-and-deep left the whole set above 0.90 — which is
  // to say convex, which is to say "a shape".
  const gth = rng() * TAU, ghw = rand(rng, P.gougeW[0], P.gougeW[1]);
  const gdep = rand(rng, P.gougeD[0], P.gougeD[1]) * mean;
  const gtwin = rng() < P.gougeTwin;
  if (rng() < P.gougeP) {
    cuts.push(gouge(gth, ghw, gdep));
    // ...and sometimes its opposite number, which is what makes a WAIST rather
    // than a bay: cut from both sides and the rock is a dumbbell held together
    // at the middle. That is a real asteroid silhouette (Kleopatra, Itokawa)
    // and, at monolith scale, a place you can fly through.
    if (gtwin) cuts.push(gouge(gth + Math.PI, ghw * 0.9, gdep * 0.85));
  }
  const applyCuts = (list) => {
    for (const c of list) {
      // Walked in SAMPLE steps rather than radians: the wrap is then an integer
      // fixup instead of an atan2 per sample per cut, and the half-sample it
      // costs in placement is under half a degree.
      const ci = ((Math.round((c.th / TAU) * n) % n) + n) % n;
      const hw = (c.hw / TAU) * n;
      for (let i = 0; i < n; i++) {
        let d = i - ci;
        if (d > n / 2) d -= n; else if (d < -n / 2) d += n;
        if (d > hw || d < -hw) continue;
        const bowl = 0.5 * (1 + Math.cos((d / hw) * Math.PI));
        // A raised cosine for an ordinary bite. A gouge takes the 0.7 power of
        // it, which flattens the floor and steepens the walls — a wide shallow
        // dish reads as a dent, and the walls are what read as a notch. NOT
        // sqrt: that has infinite slope at the rim, and a vertical wall between
        // two adjacent samples is a step the collider feels as an edge.
        prof[i] -= c.dep * (c.big ? Math.pow(bowl, 0.7) : bowl);
      }
    }
  };
  applyCuts(cuts);
  // ---- THE CONVEXITY GUARD. Facets are a `min` against a line, so enough of
  // them landing well spread out IS a convex polygon — the machined-block
  // failure the half-plane-only version had, arriving by the back door. It is
  // rare but it is not acceptable at any rate: a rock that comes out convex is
  // "a shape", which is the whole complaint. So measure the deepest DENT the
  // outline actually has and, if there isn't one, cut a gouge — every rock
  // ships with somewhere the surface falls away from its own hull.
  // The guard's own cut is MODEST on purpose — enough that the rock has a piece
  // missing, not enough to make it a dramatic one. The dramatic ones are meant
  // to come from `gougeP` landing, so that a pocket reads as a few striking
  // rocks among many merely irregular ones; if the guard cut deep, the kinds
  // that come out convex most often (slab, wedge) would be the most chewed.
  // ---- NORMALISE to a mean radius of 1 — MEAN, not peak, so a body draws the
  // size it collides at whether it came out knobbly or smooth — then hold the
  // floor and the broad-phase ceiling.
  const finish = () => {
    let m = 0;
    for (let i = 0; i < n; i++) m += prof[i];
    m /= n;
    const k = m > 1e-6 ? 1 / m : 1;
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
  };
  finish();
  // ---- THE CONVEXITY GUARD, measured on the FINISHED profile. Facets are a
  // `min` against a line, so enough of them landing well spread out IS a convex
  // polygon — the machined-block failure the half-plane-only version had,
  // arriving by the back door. It is rare, and it is not acceptable at any
  // rate: a rock that comes out convex is "a shape", which is the whole
  // complaint. So measure the deepest DENT the outline actually has and, if
  // there isn't one, cut a gouge — every rock ships with somewhere the surface
  // falls away from its own hull.
  //
  // It has to run after the floor, not before: a notch that bottoms out ON the
  // floor is shallower afterwards than the cut that made it, so measuring the
  // pre-floor profile passed rocks that came out flat. Cheap enough to pay for
  // (three windows over a 256-sample array, once per body id).
  //
  // The guard's own cut is MODEST on purpose — enough that the rock has a piece
  // missing, not enough to make it a dramatic one. The dramatic ones are meant
  // to come from `gougeP` landing, so that a pocket reads as a few striking
  // rocks among many merely irregular ones; if the guard cut deep, the kinds
  // that come out convex most often (slab, wedge) would end up the most chewed.
  // Depth is a fraction of the LOCAL surface, not an absolute: an absolute cut
  // landing on a tall lobe barely dents it, which is how the first version of
  // this guard left 6% of rocks still measuring flat. Bounded retry, walking
  // the bearing on, so the invariant holds rather than nearly holding.
  for (let g = 0; g < 3 && chordDeficit(prof, n) < CONCAVE_MIN; g++) {
    const th = gth + (gtwin ? 1.7 : 0.9) + g * 2.1;
    const gi = ((Math.round((th / TAU) * n) % n) + n) % n;
    applyCuts([gouge(th, 0.34, 0.40 * prof[gi])]);
    finish();
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
// Outermost point a gravel ring may reach. It is a RASTER cost as much as a
// memory one: the sprite quad is sized from it, so every blit in a shoal pays
// for the margin in pixels whether the rock fills it or not (the old
// near-circular ring wanted only 1.25, and 1.38 is 1.31x the raster of that).
// Held at the value where the rings do NOT clamp, because clamping shrinks the
// rock: at 1.30 the gravel's mean radius fell to 0.91 of the body radius it
// collides at, and a rock drawing 9% small is a worse bug than a wider quad.
export const JAG_PEAK = 1.38;
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
// ...and gravel's CONCAVE features are pulled back for a related reason. A
// gouge is sized against the body, so on an 18-sample ring drawn at 6 px it is
// most of the rock: the deep ones came out as little hearts and bowties, which
// is a silhouette, which is the complaint again from the other end. Landmarks
// keep the extremes, because that is where you can see one — and fly into it.
// The convexity guard still applies at both scales; it is the DRAMA that
// scales, not the rule.
const GRAVEL_SQUAT = 0.5, GRAVEL_OFF = 0.7;
const GRAVEL_GOUGE_P = 0.5, GRAVEL_GOUGE_D = 0.6, GRAVEL_GOUGE_TWIN = 0.4;
// Sample count for a gravel ring: rises with radius, so a facet is a face and a
// bite is a bite rather than one stray vertex, and bounded above. Exported
// because it is the ONLY way a gravel ring depends on the radius — the profile
// itself is in units of it — which is what lets render cache on the count
// instead of rebuilding every time a rock chips.
export function jagSamples(r) { return Math.min(ROCK_JAG_MAX, 16 + Math.round(r * 0.7)); }
export function rockJagRing(rng, r) {
  const n = jagSamples(r);
  const K = ROCK_KINDS[rockKind(rng())];
  const prof = rockOutline(rng, n, {
    ...K,
    elong: [K.elong[0] * GRAVEL_SQUAT, K.elong[1] * GRAVEL_SQUAT],
    off: [K.off[0] * GRAVEL_OFF, K.off[1] * GRAVEL_OFF],
    gougeP: K.gougeP * GRAVEL_GOUGE_P,
    gougeD: [K.gougeD[0] * GRAVEL_GOUGE_D, K.gougeD[1] * GRAVEL_GOUGE_D],
    gougeTwin: K.gougeTwin * GRAVEL_GOUGE_TWIN,
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
//
// FLOOR, NOT ROUND, and the indexing contract is the whole reason: `nlx[i]` is
// the normal of the edge from sample i to sample i+1, so a bearing lies on edge
// FLOOR(u) for its entire span. Rounding hands the second half of every edge
// its NEIGHBOUR's normal — which is nearly harmless along a smooth stretch and
// badly wrong exactly where the outline turns, i.e. at the facet corners the
// shape exists to have. Measured across 400 shapes before the fix: the two
// selectors disagreed by a mean of 1.8 degrees, by more than 5 degrees on 9.4%
// of bearings, and by up to 134 degrees at a corner — a contact resolving
// against the wrong face. (Caught in review by Copilot on PR #67. It was
// inherited from when this table was sampled at bearings rather than built per
// edge, where a half-cell slip only moved a discontinuity by 0.7 degrees.)
export function rockNormalAt(shape, th) {
  const i = ((Math.floor((th / TAU) * LUT_N) % LUT_N) + LUT_N) % LUT_N;
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
