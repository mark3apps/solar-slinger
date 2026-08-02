#!/usr/bin/env node
// Run the test suites, save a baseline, and DIFF against it.
//
//   node .claude/skills/run-solar-slinger/bench.mjs run            # run all, print
//   node .claude/skills/run-solar-slinger/bench.mjs save           # run all, save as baseline
//   node .claude/skills/run-solar-slinger/bench.mjs diff           # run all, show what moved
//   node .claude/skills/run-solar-slinger/bench.mjs diff stability perf
//   node .claude/skills/run-solar-slinger/bench.mjs diff --seeds 20260721,111222333
//
// Suites run as separate Electron processes IN PARALLEL — each is single
// threaded, so N suites cost about what the slowest one costs alone.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BASE = path.join(HERE, 'baseline');

// Each suite declares its own default seeds and args. `sim: false` marks the
// ones that need no simulation — those are near-instant.
const SUITES = {
  worldgen:    { seeds: ['20260721', '3827467762'], args: null, sim: false,
                 covers: 'world.js generation — lanes, moon clearance, fields, landmarks' },
  progression: { seeds: ['20260721'], args: null, sim: false,
                 covers: 'config.js economy — XP curve, ability ladders, kits, pick pools, shipStats' },
  combat:      { seeds: ['20260721'], args: null, sim: true,
                 covers: 'damage ladder per target class, per-hit caps' },
  stability:   { seeds: ['20260721', '3827467762', '111222333', '987654321'],
                 args: { seconds: 600, strip: true }, sim: true,
                 covers: 'physics.js — rails, drift, deaths, integrity over 600 sim-seconds' },
  perf:        { seeds: ['20260721'], args: null, sim: true,
                 covers: 'hot paths — 8 scenarios, sim/draw split with explaining counts' },
};

const argv = process.argv.slice(2);
const cmd = argv[0] || 'run';
const seedOverride = (() => { const i = argv.indexOf('--seeds'); return i === -1 ? null : argv[i + 1].split(','); })();
const picked = argv.slice(1).filter((a) => !a.startsWith('--') && SUITES[a]);
const names = picked.length ? picked : Object.keys(SUITES);

// ---------------------------------------------------------------- running --
function runOne(suite, seed) {
  return new Promise((resolve) => {
    const s = SUITES[suite];
    const script = path.join(HERE, 'suites', `${suite}.js`);
    const args = s.args ? ` ${JSON.stringify(s.args)}` : '';
    const stdin = `waitfor window.game 45000\nscript ${script}${args}\n`;
    const p = spawn('npx', ['electron', path.join(HERE, 'driver.mjs'),
      '--url', `app://game/index.html?seed=${seed}`], { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    // KEEP stderr. Discarding it made every failure report the same useless
    // "no JSON returned" and hid the actual cause completely.
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ suite, seed, error: `spawn failed: ${e.message}` }));
    p.on('close', () => {
      const line = out.trim().split('\n').filter((l) => l.startsWith('{') || l.startsWith('[')).pop();
      if (!line) return resolve({ suite, seed,
        error: (err.trim().split('\n').filter((l) => !/Security Warning|^\s*$/.test(l)).slice(-3).join(' | ')
                || out.trim().split('\n').slice(-2).join(' | ') || 'no output at all') });
      try { resolve({ suite, seed, data: JSON.parse(line) }); }
      catch (e) { resolve({ suite, seed, error: `unparseable: ${e.message}` }); }
    });
    p.stdin.end(stdin);
  });
}

async function runAll() {
  const jobs = [];
  for (const n of names) for (const seed of (seedOverride || SUITES[n].seeds)) jobs.push(runOne(n, seed));
  const t0 = Date.now();
  const res = await Promise.all(jobs);
  return { res, wallMs: Date.now() - t0 };
}

// ----------------------------------------------------------------- diffing --
// TOLERANCE POLICY — the thing that decides whether this tool is useful or just
// noise. Worldgen is seeded and progression is pure math, so those are EXACT.
// But runtime spawns, spall and AI all use Math.random on purpose, so live
// counts genuinely wobble between identical runs: measured on an unchanged
// build, particles moved 173→44 and aliens 2→1 while timings swung ~20%.
// Diffing those exactly produced 109 "changes" for a no-op, which trains you to
// ignore the output — the exact failure this tool exists to prevent.
//
// Three classes, most permissive first:
//   VOLATILE — never compared. Pure run-to-run chaff.
//   banded   — compared with a percentage and/or absolute tolerance.
//   EXACT    — everything else. Structure, integrity, economy: one moon or one
//              NaN moving is the entire point of the check.
const VOLATILE = [
  /\.particles$/, /\.aliens$/, /\.flares$/, /\.bolts$/,
  /droppedSimSeconds$/, /substepsLastFrame$/,
  /^wallMs$/, /^xRealtime$/, /wallMs$/, /xRealtime$/,
  /worstPlanetDriftPct\.name$/,          // arbitrary when every drift is ~0
  /\.isolates$/, /^seed$/, /^reps\./,
  // The pre-sorted "worst 3" strings reorder whenever the top scenarios sit
  // within noise of each other, which is most runs. The rows carry the same
  // numbers with tolerances applied, so the summary is pure diff churn.
  /^worst\[/,
];
const BANDS = [
  // timings: submission-side, fat-tailed, and machine-load dependent
  [/(MsPerFrame|Ms)$/, { pct: 35, abs: 0.2 }],    // abs covers the timer quantum
  // live population: replenish/spall/AI churn
  // Spall/calving debris is the most chaotic count in the game — a staged
  // bombardment measured 486 vs 354 pieces on identical code.
  [/(\.debris|debrisCount)$/, { pct: 45, abs: 40 }],
  [/(awake|bodies|nonField|crust|attractors|debrisHeadroom|peak|rocks|giants)$/, { pct: 20, abs: 40 }],
  // Population bookkeeping on the stability suite: replenish and the leash both
  // move these every run.
  [/^world\.(field|stripped|ran|bodies)$/, { pct: 10, abs: 40 }],
  [/^bodyGrowth\./, { pct: 10, abs: 40 }],
  // A celestial can be transiently loose at the sampling instant; a real
  // regression shows several, not one.
  [/^looseCelestials$/, { abs: 1 }],
  // per-cause death tallies: small integers with real variance
  [/^nonAsteroidDeaths\./, { abs: 4 }],
  [/(minDebrisHeadroom|worstInstallDriftPct|firstWorldLossAt)$/, { pct: 25, abs: 60 }],
  // Staged-impact probes (combat's damage ladder — `ladderTotals`/
  // `ladderLawViolations` in progression carry no bracket and stay EXACT).
  // These are BIT-EXACT now: the suite freezes the target's rotation and pins
  // the RNG for its own run, so five consecutive runs agree on all 69 fields.
  // The 20%/3 band this replaces was sized for a measurement that swung 170x
  // on unchanged code, and it was wide enough to hide a whole re-tune of the
  // damage curve — a +5% DMG_BODY moved nearly every rung and still diffed
  // green. Kept one point off `exact` only because the shaped rows report a
  // MEAN of four quarter-turns, so a rounding can tip either way if anything
  // upstream of the probe ever shifts.
  [/^ladder\[/, { pct: 2, abs: 1 }],
  [/worstPlanetDriftPct\.pct$/, { abs: 0.5 }],
];
const policyFor = (k) => {
  if (VOLATILE.some((r) => r.test(k))) return null;
  for (const [r, p] of BANDS) if (r.test(k)) return p;
  return { exact: true };
};

function flatten(o, prefix = '', out = {}) {
  if (o === null || typeof o !== 'object') { out[prefix] = o; return out; }
  if (Array.isArray(o)) {
    // Arrays of objects key by their own identifying field so rows stay
    // comparable even if order shifts.
    o.forEach((v, i) => {
      const id = v && typeof v === 'object' ? (v.scenario ?? v.target ?? v.spec ?? v.field ?? v.i ?? i) : i;
      flatten(v, `${prefix}[${id}]`, out);
    });
    return out;
  }
  for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function diffOne(before, after) {
  const A = flatten(before), B = flatten(after);
  const rows = [];
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = A[k], b = B[k];
    if (a === undefined) { rows.push({ k, a: '—', b, note: 'NEW' }); continue; }
    if (b === undefined) { rows.push({ k, a, b: '—', note: 'GONE' }); continue; }
    if (a === b) continue;
    const pol = policyFor(k);
    if (!pol) continue;                                   // VOLATILE — never compared
    if (typeof a === 'number' && typeof b === 'number') {
      const pct = a === 0 ? (b === 0 ? 0 : Infinity) : ((b - a) / Math.abs(a)) * 100;
      if (!pol.exact) {
        // Inside EITHER band is within tolerance — the absolute band is what
        // keeps small integers (2 deaths -> 3) from reading as "+50%".
        const okPct = pol.pct !== undefined && Math.abs(pct) <= pol.pct;
        const okAbs = pol.abs !== undefined && Math.abs(b - a) <= pol.abs;
        if (okPct || okAbs) continue;
      }
      rows.push({ k, a, b, delta: b - a, pct, banded: !pol.exact });
    } else rows.push({ k, a, b });
  }
  return rows;
}

const C = { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' };
// Anything that got past a band is already outside tolerance; an EXACT field
// moving at all is the loudest thing this tool can say.
function severity(r) { return r.note ? C.yel : (r.banded ? C.yel : C.red); }

function printDiff(all) {
  let total = 0;
  for (const { suite, seed, rows } of all) {
    if (!rows.length) { console.log(`${C.grn}✓${C.off} ${suite}/${seed} ${C.dim}— no change${C.off}`); continue; }
    console.log(`\n${suite}/${seed} ${C.dim}(${rows.length} changed)${C.off}`);
    for (const r of rows.slice(0, 40)) {
      const col = severity(r);
      const pct = r.pct !== undefined && Number.isFinite(r.pct) ? ` ${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%` : '';
      console.log(`  ${col}${r.k}${C.off}  ${r.a} → ${r.b}${pct}${r.note ? ' ' + r.note : ''}`);
    }
    if (rows.length > 40) console.log(`  ${C.dim}… ${rows.length - 40} more${C.off}`);
    total += rows.length;
  }
  console.log(`\n${total ? `${C.yel}${total} field(s) changed${C.off}` : `${C.grn}nothing changed${C.off}`}`);
  return total;
}

// -------------------------------------------------------------------- main --
mkdirSync(BASE, { recursive: true });
const { res, wallMs } = await runAll();
const failed = res.filter((r) => r.error);
for (const f of failed) console.error(`${C.red}✗ ${f.suite}/${f.seed}: ${f.error}${C.off}`);
console.error(`${C.dim}ran ${res.length} suite-runs in ${(wallMs / 1000).toFixed(1)}s${C.off}`);

const ok = res.filter((r) => r.data);
// A failed RUN is not "no change" — reporting a green diff when nothing
// executed is the worst possible lie this tool could tell.
if (failed.length) {
  console.error(`${C.red}${failed.length} of ${res.length} suite-runs FAILED — results below are incomplete${C.off}`);
  process.exitCode = 2;
}
if (!ok.length) { console.error(`${C.red}nothing ran; aborting${C.off}`); process.exit(2); }

if (cmd === 'save') {
  for (const r of ok) writeFileSync(path.join(BASE, `${r.suite}.${r.seed}.json`), JSON.stringify(r.data, null, 1));
  console.log(`${C.grn}saved ${ok.length} baseline file(s)${C.off} → ${path.relative(ROOT, BASE)}`);
} else if (cmd === 'diff') {
  const all = [];
  for (const r of ok) {
    const f = path.join(BASE, `${r.suite}.${r.seed}.json`);
    if (!existsSync(f)) { console.log(`${C.yel}? ${r.suite}/${r.seed} — no baseline, run \`bench.mjs save\` first${C.off}`); continue; }
    all.push({ suite: r.suite, seed: r.seed, rows: diffOne(JSON.parse(readFileSync(f, 'utf8')), r.data) });
  }
  process.exitCode = printDiff(all) ? 1 : 0;
} else {
  for (const r of ok) { console.log(`\n=== ${r.suite}/${r.seed} ===`); console.log(JSON.stringify(r.data, null, 1)); }
}
