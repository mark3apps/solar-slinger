// AREA: worldgen — static structure of a freshly generated sky.
//
// RUNS NO SIMULATION AT ALL, and must stay that way — this is the fastest
// suite there is (boot only, ~1s) and bench.mjs treats every field it returns
// as EXACT, with no tolerance band.
//
// DO NOT ADD A TICK. An earlier cut opened with `window.tick(0.1)`, which is
// not the no-op it looks like: tick's loop is `for (t = 0; t < seconds;
// t += 1/60)`, so 0.1s is SIX real `update()` calls — spawns, AI, replenish
// timers, damage — and `window.tick` also sets `game.started = true`. That
// contradicts the suite's own contract and is exactly the kind of thing that
// turns an EXACT-diffed suite into a source of phantom changes. (Verified
// removable: output is byte-identical with and without it, and identical
// across three consecutive runs either way.)
//
// THE INVARIANT THAT KEEPS THIS TRUE: every metric below is time-INVARIANT —
// rail parameters (a/e/r/w), radii, masses, and counts of generated content.
// Nothing reads a live position in a way that drifts as bodies advance, which
// is why the sky having already been advanced by the splash backdrop before
// the script runs cannot move a number. If you add a metric, keep it that way
// or it will diff against itself.

const g = window.game;
const star = g.homeStar;
const alive = g.bodies.filter((b) => b.alive);
const peri = (b) => (b.rail ? (b.rail.e > 0 ? b.rail.a * (1 - b.rail.e) : b.rail.r) : 0);
const apo = (b) => (b.rail ? (b.rail.e > 0 ? b.rail.a * (1 + b.rail.e) : b.rail.r) : 0);

// ---- population by type ---------------------------------------------------
const byType = {};
for (const b of alive) byType[b.type] = (byType[b.type] || 0) + 1;
const byPtype = {};
for (const b of alive) if (b.ptype) byPtype[b.ptype] = (byPtype[b.ptype] || 0) + 1;

// ---- planet lanes ---------------------------------------------------------
// PLANET_LANE_GAP caps each grown disc by what its neighbours leave free, so
// no two planet SURFACES should come within 400 units at conjunction.
// Lane comes from the RAIL PARAMETER, not from hypot(position). A circular
// rail's radius is constant, but `r * cos(ang)` / `r * sin(ang)` recombined
// through hypot() carries float noise that varies WITH THE ANGLE — so a
// position-derived lane wobbles in its last bits as the sky turns. That was
// enough to flip `minSurfaceGap.at` between Pell->Sable and Nerev->Tantal
// across runs, because several pairs tie at exactly CFG.PLANET_LANE_GAP (400)
// and the tie-break landed differently. Reading rail.r is bit-identical
// forever, which is what an EXACT-diffed field requires.
const laneOf = (b) => (b.rail ? (b.rail.e > 0 ? b.rail.a : b.rail.r) : Math.hypot(b.x - star.x, b.y - star.y));
const planets = alive.filter((b) => b.type === 'planet' && b.parent === star)
  .map((p) => ({ p, lane: laneOf(p) }))
  .sort((a, b) => a.lane - b.lane || (a.p.name < b.p.name ? -1 : 1));

let minSurfaceGap = Infinity, minSurfacePair = null;
for (let i = 0; i < planets.length - 1; i++) {
  const a = planets[i], b = planets[i + 1];
  const gap = (b.lane - a.lane) - a.p.radius - b.p.radius;
  if (gap < minSurfaceGap) { minSurfaceGap = gap; minSurfacePair = `${a.p.name}->${b.p.name}`; }
}

// ---- moon systems ---------------------------------------------------------
// Perihelion clearance: spawnMoon's eCap guarantees a moon's closest approach
// clears its primary's surface by 60u. Anything at or below 0 is a moon born
// inside its planet.
let minPeriClear = Infinity, minPeriMoon = null;
const moons = alive.filter((b) => b.type === 'moon' && b.parent);
for (const m of moons) {
  const c = peri(m) - m.parent.radius - m.radius;
  if (c < minPeriClear) { minPeriClear = c; minPeriMoon = m.parent.name; }
}

// Neighbouring families overlapping radially is EXPECTED and allowed (the
// railed-conjunction pass-through in physics.collideBodies is what makes it
// safe). Tracked as a number so a worldgen change that suddenly makes them
// overlap far more — or not at all — is visible.
let overlappingPairs = 0, worstOverlap = 0;
const reach = (p) => Math.max(p.radius, ...moons.filter((m) => m.parent === p).map((m) => apo(m) + m.radius), 0);
for (let i = 0; i < planets.length - 1; i++) {
  const need = reach(planets[i].p) + reach(planets[i + 1].p);
  const gap = planets[i + 1].lane - planets[i].lane;
  if (need > gap) { overlappingPairs++; worstOverlap = Math.max(worstOverlap, Math.round(need - gap)); }
}

// ---- dense fields ---------------------------------------------------------
// The three field laws, asserted structurally: census near CFG.FIELD_ROCKS,
// never an attractor at ANY mass, and ONE shared rail.w (a pocket with mixed
// angular speeds shears itself apart).
const fields = (g.fields || []).map((f, i) => {
  const rocks = alive.filter((b) => b.fieldRock && Math.hypot(b.x - f.x, b.y - f.y) < 6000);
  const railed = rocks.filter((b) => b.onRails && b.rail);
  return {
    i,
    rocks: rocks.length,
    attractors: rocks.filter((b) => b.attractor).length,          // must be 0
    wMismatch: railed.filter((b) => Math.abs(b.rail.w - f.w) > 1e-9).length,  // must be 0
    giants: rocks.filter((b) => b.mass > 3000).length,
  };
});

// ---- landmarks the expedition layer depends on ----------------------------
const landmarks = {
  vesper: alive.some((b) => b.majorComet),
  vesperRailed: (alive.find((b) => b.majorComet) || {}).onRails ?? null,   // must be false
  darkStar: alive.filter((b) => b.hidden).length,
  tinker: alive.filter((b) => b.tinker).length,
  shepherd: alive.filter((b) => b.shepherd).length,
  wrecks: alive.filter((b) => b.wreck).length,
  glowPockets: (g.glowPockets || []).length,
  echoes: alive.filter((b) => b.echo).length,
  chartable: alive.filter((b) => b.chartKey).length,
};

return {
  seed: g.worldSeed,
  totals: { bodies: alive.length, attractors: alive.filter((b) => b.attractor).length,
            fieldRock: alive.filter((b) => b.fieldRock).length,
            nonField: alive.filter((b) => !b.fieldRock).length },
  byType,
  byPtype,
  planetLanes: { count: planets.length, minSurfaceGap: Math.round(minSurfaceGap), at: minSurfacePair },
  moonSystems: { count: moons.length, minPeriClearance: Math.round(minPeriClear), at: minPeriMoon,
                 overlappingNeighbourPairs: overlappingPairs, worstOverlap },
  fields,
  landmarks,
};
