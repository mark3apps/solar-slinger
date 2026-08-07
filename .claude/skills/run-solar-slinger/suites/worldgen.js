// AREA: worldgen — static structure of a freshly generated sky.
//
// RUNS NO SIMULATION AT ALL, and must stay that way — this is the fastest
// suite there is (boot + one regen, ~1s) and bench.mjs treats every field it
// returns as EXACT, with no tolerance band.
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
// REGENERATE FIRST, THEN MEASURE — never measure the sky the driver booted.
// The splash screen is NOT a still image: main.js `driftSplash` runs the FULL
// physics behind the title menu, and `waitfor window.game` returns after an
// unbounded, wall-clock-dependent slice of it (measured 0.07-0.09s idle, and
// it grows with machine load). physics.step then CULLS dead and escaped
// bodies out of game.bodies entirely, so ambient belt collisions during boot
// permanently SHRINK the array — 8325 asteroids at 0.09s of splash, 8323 at
// 12s, and worse on a loaded machine. `byType.asteroid` and
// `totals.fieldRock` are EXACT-diffed, so that surfaced as red on unmodified
// code in run after run: the one thing this tool must never do, because a
// diff that cries wolf trains you to stop reading it. It had already spoiled
// stored data too — the saved 3827467762 baseline was captured 86 asteroids
// into that erosion (8219/7514 where generation gives 8305/7600), so the
// suite was diffing an eroded sky against an eroded record. (Those counts are
// from the 1,900-rock pocket era; a pocket is CFG.FIELD_ROCKS 920 now and the
// world censuses 4,415 / 3,643. The failure mode is what matters here, not the
// absolutes.)
//
// `window.freshRun(0, seed)` rebuilds the world through the game's own
// regenWorld path and returns with ZERO sim time on it, on the same seed the
// driver booted. The census below runs in the same synchronous turn, so
// nothing — not a substep, not a rAF — can advance the sky between generation
// and measurement, no matter how slow the boot was. That is what makes these
// counts a property of GENERATION rather than of survival.
//
// THE INVARIANT THAT KEEPS THIS TRUE: every metric below must be a property
// of generation — rail parameters (a/e/r/w), radii, masses, and counts of
// generated content. Nothing may read a survival state or a live position
// that drifts once bodies advance. If you add a metric, keep it that way, or
// it will diff against itself.

// Rebuild the sky before reading a single number out of it (see above).
window.freshRun(0, window.game.worldSeed);

const g = window.game;
const star = g.homeStar;
// The GENERATED population, not the surviving one. `g.bodies` immediately
// after a regen IS exactly what generateWorld built — no `.alive` filter,
// because filtering on survival is the bug this suite had.
const gen = g.bodies;
const peri = (b) => (b.rail ? (b.rail.e > 0 ? b.rail.a * (1 - b.rail.e) : b.rail.r) : 0);
const apo = (b) => (b.rail ? (b.rail.e > 0 ? b.rail.a * (1 + b.rail.e) : b.rail.r) : 0);

// ---- population by type ---------------------------------------------------
const byType = {};
for (const b of gen) byType[b.type] = (byType[b.type] || 0) + 1;
const byPtype = {};
for (const b of gen) if (b.ptype) byPtype[b.ptype] = (byPtype[b.ptype] || 0) + 1;

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
const planets = gen.filter((b) => b.type === 'planet' && b.parent === star)
  .map((p) => ({ p, lane: laneOf(p) }))
  .sort((a, b) => a.lane - b.lane || (a.p.name < b.p.name ? -1 : 1));

// CO-ORBITAL PAIRS share one lane by design (2026-08 seeded-layout pass):
// same radius means the same rail |w| and the sky turns one way, so their
// angular separation is FIXED and they can never conjunct — a surface-gap
// reading between them would be a large negative number describing a
// collision that cannot happen. They are skipped from the gap scan and
// counted instead, so a layout change that mints more (or loses) them shows.
let minSurfaceGap = Infinity, minSurfacePair = null, coOrbitalPairs = 0;
for (let i = 0; i < planets.length - 1; i++) {
  const a = planets[i], b = planets[i + 1];
  if (b.lane - a.lane < 1) { coOrbitalPairs++; continue; }
  const gap = (b.lane - a.lane) - a.p.radius - b.p.radius;
  if (gap < minSurfaceGap) { minSurfaceGap = gap; minSurfacePair = `${a.p.name}->${b.p.name}`; }
}

// ---- moon systems ---------------------------------------------------------
// Perihelion clearance: spawnMoon's eCap guarantees a moon's closest approach
// clears its primary's surface by 60u. Anything at or below 0 is a moon born
// inside its planet.
let minPeriClear = Infinity, minPeriMoon = null;
const moons = gen.filter((b) => b.type === 'moon' && b.parent);
for (const m of moons) {
  const c = peri(m) - m.parent.radius - m.radius;
  if (c < minPeriClear) { minPeriClear = c; minPeriMoon = m.parent.name; }
}

// MOONS LOST TO FLOATING POINT, NOT TO GEOMETRY (issue #200). `byType.moon`
// already moves when this breaks (67 vs 72 on this seed) — but a census that
// moved tells you THAT the sky changed, never WHY, and "the moon count is 5
// lower" is indistinguishable from a real clearance regression. This field is
// the why: it counts lanes where addPlanet's family cap threw away a whole
// moon for a rounding error and nothing else.
//
// The clip is `Math.floor((maxR - minR) / moonSlot())`, and the common case is
// that quotient landing EXACTLY on an integer by construction — buildLayout
// opens each span until it equals what the family wants, generateWorld's lane
// pass divides that same span back by the same proportions, and familyReach
// multiplies by (1 + MOON_E_MAX) where moonZone's laneRoom divides by it
// again. Exact in real arithmetic, not one of them exact in binary, so the
// quotient arrives ~1 ulp UNDER its integer (13 as 12.999999999999993) and the
// floor drops a moon. A lane is counted here when the epsilon would have
// rescued a moon AND the family generated at the un-rescued count — i.e. the
// rounding, not the geometry, is what ended it. Each such lane loses exactly
// one moon, so this number RECONCILES with the census: without the epsilon it
// reads 5 on seed 20260721 (byType.moon 67 vs 72) and 10 on 3827467762 (64 vs
// 74), and with it, 0 on both. A non-zero reading here and an unexplained
// byType.moon drop are the same event; a byType.moon drop with 0 here is a
// genuine geometry change and wants reading as one.
//
// THE ZONE MATH IS MIRRORED HERE BECAUSE world.js EXPORTS NONE OF IT
// (moonZone / moonSlot / moonFloor are module-private). Keep this block in
// step with them: it reads the SAME inputs off the generated bodies —
// p.moonRoom is stamped by the lane pass, the lane comes off the rail
// parameter for the reason laneOf above documents — so a drift shows up as
// this count going non-zero on unmodified code, not as a silent wrong answer.
// Deterministic: pure arithmetic over generated values, no survival state, no
// live position. The 1-ulp round trip through rail.r moves the quotient by
// ~1e-14, four orders under the 1e-9 the test uses.
const { CFG: cfg } = await import('/src/config.js');
const MOON_SLOT = 220 * cfg.MOON_R_MUL;
const moonFloorOf = (p) => Math.max(p.radius + 90 * cfg.MOON_R_MUL,
  p.radius * (p.ring ? 2.5 : p.ptype === 'terran' ? 1.75 : p.ptype === 'crystal' ? 1.6 : 1.45));
let roundingClippedLanes = 0;
for (const { p, lane } of planets) {
  const hill = lane * Math.cbrt(p.mass / (3 * star.mass));
  const room = Math.max(0, cfg.WORLD_R - lane) / (1 + cfg.MOON_E_MAX);
  const laneRoom = (p.moonRoom ?? Infinity) / (1 + cfg.MOON_E_MAX);
  const minR = moonFloorOf(p);
  const maxR = Math.min(hill * cfg.MOON_ZONE_MUL, room, laneRoom);
  const q = (maxR - minR) / MOON_SLOT;
  if (!(Math.floor(q + 1e-9) > Math.floor(q))) continue;   // not a rounding case at all
  // The ring shepherd is pinned to its lane by spawnShepherd and never comes
  // out of this clamp, so it must not count toward the family it sits in.
  const got = moons.filter((m) => m.parent === p && !m.shepherd).length;
  if (got === Math.floor(q)) roundingClippedLanes++;
}

// Neighbouring families overlapping radially is EXPECTED and allowed (the
// railed-conjunction pass-through in physics.collideBodies is what makes it
// safe). Tracked as a number so a worldgen change that suddenly makes them
// overlap far more — or not at all — is visible.
let overlappingPairs = 0, worstOverlap = 0;
const reach = (p) => Math.max(p.radius, ...moons.filter((m) => m.parent === p).map((m) => apo(m) + m.radius), 0);
for (let i = 0; i < planets.length - 1; i++) {
  if (planets[i + 1].lane - planets[i].lane < 1) continue;   // co-orbital: fixed separation, never conjuncts
  const need = reach(planets[i].p) + reach(planets[i + 1].p);
  const gap = planets[i + 1].lane - planets[i].lane;
  if (need > gap) { overlappingPairs++; worstOverlap = Math.max(worstOverlap, Math.round(need - gap)); }
}

// ---- dense fields ---------------------------------------------------------
// The three field laws, asserted structurally: census near CFG.FIELD_ROCKS,
// never an attractor at ANY mass, and ONE shared rail.w (a pocket with mixed
// angular speeds shears itself apart).
// MEMBERSHIP IS STRUCTURAL, NEVER GEOMETRIC. This read used to be
// `Math.hypot(b.x - f.x, b.y - f.y) < 6000`, which broke the suite's own
// time-invariance contract above: f.x/f.y are written ONLY by ai.updateFields,
// and updateAliens is deliberately excluded from the splash backdrop — but
// driftSplash does call step(), so the shoals advance on their rails while the
// anchor stays frozen at its worldgen value. The census radius was therefore
// measured from a point drifting away from the pocket at ~100u/s, with the
// outermost rocks already sitting at ~5.4-5.6k against the 6,000 cutoff. It
// never showed red only because bench.mjs bands these fields at 20%/abs-40.
// world.markFieldRock stamps b.field = fi (world.js), physics.shatter carries
// it onto every shard, and ai.js already selects a pocket's rocks this way.
// The regen above independently pins x/y to their generation values, but do
// NOT let that tempt anyone back to a distance test: these two guards cover
// different failure modes, and the anchor drift is the one a regen can't fix.
const fields = (g.fields || []).map((f, i) => {
  const rocks = gen.filter((b) => b.fieldRock && b.field === i);
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
  vesper: gen.some((b) => b.majorComet),
  vesperRailed: (gen.find((b) => b.majorComet) || {}).onRails ?? null,   // must be false
  darkStar: gen.filter((b) => b.hidden).length,
  tinker: gen.filter((b) => b.tinker).length,
  shepherd: gen.filter((b) => b.shepherd).length,
  wrecks: gen.filter((b) => b.wreck).length,
  glowPockets: (g.glowPockets || []).length,
  echoes: gen.filter((b) => b.echo).length,
  chartable: gen.filter((b) => b.chartKey).length,
  // BASTIONS. The hostile-installation achievements are scoped to the
  // population the sky actually generates (achievements.js killNest3 / fort3 /
  // nest5 all read 2), so that population is load-bearing and moving it
  // silently rescopes three rows. Nests already have their tripwire —
  // `byType.nest` is EXACT-diffed above, so counting them again here would
  // only print the same change twice. Forts had none: an emplacement is a
  // field on an ordinary planet or moon, invisible to a census by type.
  forts: gen.filter((b) => b.fort).length,
};

return {
  seed: g.worldSeed,
  totals: { bodies: gen.length, attractors: gen.filter((b) => b.attractor).length,
            fieldRock: gen.filter((b) => b.fieldRock).length,
            nonField: gen.filter((b) => !b.fieldRock).length },
  byType,
  byPtype,
  planetLanes: { count: planets.length, minSurfaceGap: Math.round(minSurfaceGap), at: minSurfacePair,
                 coOrbitalPairs },
  moonSystems: { count: moons.length, minPeriClearance: Math.round(minPeriClear), at: minPeriMoon,
                 overlappingNeighbourPairs: overlappingPairs, worstOverlap,
                 roundingClippedLanes },
  fields,
  landmarks,
};
