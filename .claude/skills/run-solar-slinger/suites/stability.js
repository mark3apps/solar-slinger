// Sky-stability soak payload — run via the driver's `script` command:
//   script .claude/skills/run-solar-slinger/soak.js {"seconds":600,"strip":true}
//
// Why this exists instead of window.soak():
//   * soak() reports the moon count as a LIVE CENSUS, which re-accretion makes
//     wobble (it can go UP between readings), so it can't tell a regression from
//     normal churn. This reports CUMULATIVE deaths grouped by cause instead.
//   * The classic failure — a world spiralling into the sun — shows as radial
//     drift long before anything dies. soak() never looked at drift, so a 600s
//     run could pass while a planet was visibly on its way out.
//   * soak()'s `deaths` are pre-formatted strings, which don't aggregate.
//
// ARGS: { seconds=600, strip=true, chunk=60 }
//   strip:true removes DORMANT FIELD ROCK before running. Those 2,960 rocks are
//   gravity-free in both directions and can never touch a planet, but they cost
//   ~64% of an idle soak's runtime in pure LOD + rail bookkeeping. Stripping them
//   is a ~2.8x speedup that provably does not change the sky verdict (measured
//   seed 20260721, 300s: 4,390ms stripped vs 12,322ms intact, verdicts
//   identical). Use strip:false when the field itself is what you changed.

const A = globalThis.ARGS || {};
const seconds = A.seconds ?? 600;
const chunk = A.chunk ?? 60;
const strip = A.strip !== false;

const g = window.game;
g.ship.alive = false;          // idle sky = the cleanest stability signal, and
g.ship.invuln = 1e9;           // costs no life (deathCause stays empty)
g.deathLog = [];
g.collisionLog = [];
// ARM THE NaN TALLY. physics.js counts with `(game.nanEvents || 0) + 1`, so the
// field stays `undefined` until a tripwire actually fires — and JSON.stringify
// DROPS undefined keys, so bypassing window.soak() (which arms it at
// main.js:1817) silently deleted the single most load-bearing assertion in the
// report. It read as "no data" and looked like a pass.
g.nanEvents = 0;

// Baseline BEFORE any stripping, so counts are honest about the real world.
const born = {
  bodies: g.bodies.length,
  field: g.bodies.filter((b) => b.fieldRock).length,
};

let stripped = 0;
if (strip) {
  const keep = g.bodies.filter((b) => !b.fieldRock);
  stripped = g.bodies.length - keep.length;
  g.bodies = keep;
  g.bodies._awake = null;      // force the LOD to rebuild against the new array
  g.fields = [];               // stop replenishWorld reknitting the pockets back
}

// Drift must be measured against the body's OWN anchor, not the sun. Ymir B is
// a binary companion (parent: Ymir, rail.r 1904) sitting ~18,700 from the sun,
// so a sun-relative reading showed it drifting -20% every run — pure orbital
// motion around its primary, reported as a deorbit. Anchor-relative reads 0.
const anchorOf = (b) => (b.parent && b.parent.type !== 'star' ? b.parent : null);
const radiusOf = (b) => {
  const a = anchorOf(b);
  return a ? Math.hypot(b.x - a.x, b.y - a.y) : Math.hypot(b.x, b.y);
};

// Snapshot every planet's starting lane so drift is measured against where it
// STARTED, not against a rail it may have been knocked off.
const planet0 = new Map();
for (const b of g.bodies) {
  if (b.alive && b.type === 'planet') planet0.set(b.id, radiusOf(b));
}
const moons0 = g.bodies.filter((b) => b.alive && b.type === 'moon').length;

const bodies0 = g.bodies.length;

const t0 = performance.now();
let firstLoss = null;
// Sampled ACROSS the run, not just at the end — a budget that saturates mid-run
// and recovers, or a body count that spikes, is invisible in an end-state read.
let minDebrisHeadroom = Infinity;
let maxBodies = bodies0;
for (let t = 0; t < seconds; t += chunk) {
  window.tick(Math.min(chunk, seconds - t));
  if (firstLoss === null) {
    const d = g.deathLog.find((x) => x.type === 'planet' || x.type === 'moon');
    if (d) firstLoss = Math.round(d.t);
  }
  const nf = g.reg && g.reg.nonField ? g.reg.nonField.length : null;
  if (nf !== null) minDebrisHeadroom = Math.min(minDebrisHeadroom, 1500 - nf);
  maxBodies = Math.max(maxBodies, g.bodies.length);
}
const wallMs = Math.round(performance.now() - t0);

// ---- verdict ------------------------------------------------------------
const planets = g.bodies.filter((b) => b.alive && b.type === 'planet');
const moons = g.bodies.filter((b) => b.alive && b.type === 'moon');

let worst = { name: null, pct: 0 };
for (const p of planets) {
  const r0 = planet0.get(p.id);
  if (!r0) continue;                                  // spawned mid-run
  const pct = (radiusOf(p) - r0) / r0 * 100;
  if (Math.abs(pct) > Math.abs(worst.pct)) worst = { name: p.name || p.id, pct: +pct.toFixed(2) };
}

// Cumulative, cause-classified — this is the signal the live census can't give.
const causes = {};
for (const d of g.deathLog) {
  if (d.type === 'asteroid') continue;                // belt churn is expected
  const k = `${d.type}:${d.how}`;
  causes[k] = (causes[k] || 0) + 1;
}

// ---- integrity checks -----------------------------------------------------
// Each of these guards a documented past failure that the planet/moon census
// cannot see. Anything false/non-zero here is a real finding.
const alive = g.bodies.filter((b) => b.alive);

// A DEGENERATE ELLIPSE (e === 0 carrying `a`) is advanced as a circle, reads the
// r/w/ang it does not have, and is NaN on its first substep — a moon quietly
// vanishing seconds into the run. railEllipse builds an honest circular rail
// when e <= 0, so any survivor here means that choke point was bypassed.
const degenerateRails = alive.filter((b) => b.rail && b.rail.a !== undefined && !(b.rail.e > 0)).length;

// Celestials that never made it back onto a rail. Rails are the architecture;
// a permanently loose world is a deorbit waiting to happen.
const looseCelestials = alive.filter((b) => (b.type === 'planet' || b.type === 'moon') && !b.onRails).length;

// Installations station-keep to homeR and must NEVER wander.
const installs = alive.filter((b) => b.type === 'station' || b.type === 'nest' || b.fort);
const worstInstallDrift = installs.reduce((w, b) => {
  if (!b.homeR) return w;
  const r = Math.hypot(b.x - (b.parent ? b.parent.x : 0), b.y - (b.parent ? b.parent.y : 0));
  const pct = Math.abs(r - b.homeR) / b.homeR * 100;
  return pct > w ? +pct.toFixed(1) : w;
}, 0);

// Landmarks the expedition layer depends on. Vesper must be ALIVE and NEVER
// RAILED (rails are circular-only; railing it would freeze a long-period comet
// onto a circle forever).
const vesper = alive.find((b) => b.majorComet);
const landmarks = {
  vesperAlive: !!vesper,
  // Always a boolean: `vesper ? … : null` flapped null<->false whenever the
  // comet was mid-respawn, which is churn. The assertion that matters is
  // that it is NEVER true — rails are circular-only.
  vesperRailed: !!(vesper && vesper.onRails),          // must be false
  darkStarAlive: alive.some((b) => b.hidden),
  tinkerAlive: alive.some((b) => b.tinker),
  shepherdAlive: alive.some((b) => b.shepherd),
  wrecks: alive.filter((b) => b.wreck).length,
};

// FIELD POCKET INTEGRITY — only meaningful when the fields were not stripped.
// Three rules from the design laws: field rock never attracts (at ANY mass,
// giants included), the pocket is RIGID (one shared rail.w — mixed rates shear
// it apart), and the reknit holds the census near CFG.FIELD_ROCKS (740).
let fieldChecks = null;
if (!strip && g.fields && g.fields.length) {
  fieldChecks = g.fields.map((f, i) => {
    const rocks = alive.filter((b) => b.fieldRock && Math.hypot(b.x - f.x, b.y - f.y) < 6000);
    const railed = rocks.filter((b) => b.onRails && b.rail);
    return {
      field: i,
      rocks: rocks.length,                                        // want ~740
      anyAttractor: rocks.some((b) => b.attractor),               // must be false
      wMismatch: railed.filter((b) => Math.abs(b.rail.w - f.w) > 1e-9).length,  // must be 0
    };
  });
}

return {
  seed: g.worldSeed,
  simSeconds: seconds,
  wallMs,
  xRealtime: +(seconds * 1000 / wallMs).toFixed(1),
  world: { ...born, stripped, ran: g.bodies.length },

  // ---- integrity (all guard a documented past failure) ----
  degenerateRails,          // must be 0 — NaN on first substep
  looseCelestials,          // must be 0 — permanently off-rail world
  worstInstallDriftPct: worstInstallDrift,   // stations/nests must not wander
  landmarks,                // vesperRailed must be false; alive flags true
  minDebrisHeadroom: minDebrisHeadroom === Infinity ? null : minDebrisHeadroom,
  // ^ if this ever reaches 0, chunk spray / spall / the death cloud / Cluster
  //   Rounds ALL become silent no-ops. That shipped once and was dead code for
  //   months, because the budget was compared against game.bodies.length.
  bodyGrowth: { start: bodies0, peak: maxBodies, end: g.bodies.length },
  //   ^ a steadily climbing count means the leash or a cull regressed.
  attractors: alive.filter((b) => b.attractor).length,   // hot loop is O(bodies x attractors)
  fieldChecks,

  // PASS/FAIL signals, most load-bearing first.
  nanEvents: g.nanEvents ?? -1,                       // must be 0; -1 = never armed, treat as FAILED
  planetsAlive: planets.length,
  planetsOffRail: planets.filter((p) => !p.onRails).length,   // must be 0
  worstPlanetDriftPct: worst,                         // deorbit, seen early
  moonsAlive: moons.length,
  moonsAtStart: moons0,
  nonAsteroidDeaths: causes,                          // cumulative, by cause
  firstWorldLossAt: firstLoss,                        // seconds, null if none
};
