export const TAU = Math.PI * 2;

// Is a full-screen shell modal up? Settings / Controls / Credits / Achievements
// are separate flags because each is its own panel, but every gate in the game
// treats them identically — the sim freezes, player input is blocked, the music
// ducks, the trajectory forecast hides. Kept here (a leaf) so main, hud, music
// and render can all ask without importing each other.
export const shellModal = (g) =>
  !!(g.settingsOpen || g.controlsOpen || g.creditsOpen || g.achievementsOpen);

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
// Surface reach (fraction of radius) along a LOCAL bearing (body frame —
// callers subtract b.rot). Polar interpolation of the straight polygon edge
// between the bracketing vertices, so the queried surface IS the drawn edge.
export function crystalRadiusAt(shards, ang) {
  const v = shards.verts;
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
