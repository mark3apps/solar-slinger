// AREA: progression — the XP curve, ability ladders, spec kits and pick pools.
// PURE CONFIG MATH: no simulation at all, so it is the cheapest suite to run
// and the right one to check after any config.js edit.
//
// The numbers here are the economy. When one moves, the diff tells you which
// part of the climb you re-priced.

const cfg = await import('/src/config.js');
const { SPECS, ABILITIES, PROG, TIERS, newProgress, shipStats, abilityRankCost, tierChoices, abilityById } = cfg;

// ---- the XP climb ---------------------------------------------------------
// Front-loaded on purpose; per-tier totals are the shape of the whole game.
// xpForPick reads prog.LEVEL (total pick-events taken), not tier — a first cut
// here set tier/picksThisTier and got a flat 210 per tier, which is the curve
// not being exercised at all. Each tier is PICKS_PER_TIER picks PLUS the
// milestone, so tier t spans levels [t*n, t*n + n) where n = PICKS_PER_TIER + 1.
const { xpForPick } = cfg;
const perLevel = [];
{
  const p = newProgress();
  for (let lvl = 0; lvl < 12; lvl++) { p.level = lvl; perLevel.push(Math.round(xpForPick(p))); }
}
const N = PROG.PICKS_PER_TIER + 1;
const perTier = [0, 1, 2, 3, 4].map((t) => perLevel.slice(t * N, t * N + N).reduce((a, b) => a + b, 0));

// ---- ability ladders ------------------------------------------------------
// TWO LAWS (devtest T5c asserts both): thresholds always RISE, and no two
// abilities in a spec's STARTING KIT rank up together. Kit abilities are the
// only ones learned at the same instant, so only the cost stagger separates
// them — ABIL_XP_SPREAD/ABIL_XP_WOBBLE were SEARCHED to maximise the tightest
// kit gap. A shrinking gap here is the early warning.
// abilityRankCost(ABILITY_OBJECT, rank) — passing an id returns Infinity for
// every call, which silently reported 77 "law violations" and empty kit gaps.
const ladders = {};
let nonRising = 0;
for (const a of ABILITIES) {
  const steps = [];
  for (let r = 1; r < a.max; r++) steps.push(Math.round(abilityRankCost(a, r)));
  for (let i = 1; i < steps.length; i++) if (steps[i] <= steps[i - 1]) nonRising++;
  ladders[a.id] = { max: a.max, total: steps.reduce((s, v) => s + v, 0), steps };
}

const kitGaps = SPECS.map((s) => {
  // Cumulative XP at which each kit ability reaches each rank, interleaved.
  const events = [];
  for (const id of s.start) {
    let acc = 0;
    const a = abilityById(id);
    for (let r = 1; r < a.max; r++) { acc += Math.round(abilityRankCost(a, r)); events.push({ id, r, acc }); }
  }
  events.sort((x, y) => x.acc - y.acc);
  let tightest = Infinity, pair = null;
  for (let i = 1; i < events.length; i++) {
    const d = events[i].acc - events[i - 1].acc;
    if (d < tightest) { tightest = d; pair = `${events[i - 1].id}r${events[i - 1].r}/${events[i].id}r${events[i].r}`; }
  }
  return { spec: s.id, kit: s.start.length,
           rankable: s.start.filter((id) => abilityById(id).max > 1).length,   // every row is 6 ranks now
           tightestRankGapXp: tightest === Infinity ? null : tightest, at: pair };
});

// ---- pick pools -----------------------------------------------------------
// How many NEW abilities each spec can be offered at each tier. A pool that
// empties early means picks stop meaning anything.
const pools = SPECS.map((s) => {
  const p = newProgress(); p.spec = s.id;
  for (const id of s.start) p.upgrades[id] = 1;
  const byTier = [];
  for (let t = 0; t <= 5; t++) { p.tier = t; byTier.push(tierChoices(p, 99).length); }
  return { spec: s.id, offerableByTier: byTier };
});

// ---- derived ship stats ---------------------------------------------------
// The shape of each spec at the start and at full build. These are what every
// consumer reads, so a change here is a change to how the ship feels.
const statKeys = ['hullMax', 'shieldMax', 'shieldFrac', 'shieldArc', 'maxSpeed', 'thrust',
                  'grabRange', 'grabMass', 'flingSpeed', 'orbitCap', 'maxOrbiters', 'radius'];
const specStats = SPECS.map((s) => {
  const mk = (tier, maxed) => {
    const p = newProgress(); p.spec = s.id; p.tier = tier;
    for (const id of s.start) p.upgrades[id] = maxed ? abilityById(id).max : 1;
    if (maxed) for (const a of ABILITIES) if (a.spec === s.id) p.upgrades[a.id] = a.max;
    const st = shipStats(p);
    const out = {};
    for (const k of statKeys) if (st[k] !== undefined) out[k] = +(+st[k]).toFixed(3);
    out.totalLevel = st.totalLevel;
    return out;
  };
  return { spec: s.id, tier0: mk(0, false), tier5maxed: mk(5, true) };
});

return {
  catalog: { abilities: ABILITIES.length, specs: SPECS.length,
             withNeeds: ABILITIES.filter((a) => a.needs).length,
             withAlso: ABILITIES.filter((a) => a.also).length,
             withXpMul: ABILITIES.filter((a) => a.xpMul).length,
             max1: ABILITIES.filter((a) => a.max === 1).length,   // must be 0 — every ability is six ranks
             notSix: ABILITIES.filter((a) => a.max !== 6).length,
             withChMul: ABILITIES.filter((a) => a.chMul).length },
  xp: { perTier, climbTotal: perTier.reduce((s, v) => s + v, 0),
        abilXpTotal: PROG.ABIL_XP_TOTAL, perAchPoint: PROG.XP_PER_ACH_POINT,
        fieldMul: PROG.XP_FIELD_MUL, fieldBudget: PROG.FIELD_XP_BUDGET },
  ladderLawViolations: nonRising,          // must be 0 — thresholds always rise
  kitGaps,                                 // rankable must be >= 3; gap must stay wide
  pools,
  specStats,
  ladderTotals: Object.fromEntries(Object.entries(ladders).map(([k, v]) => [k, v.total])),
};
