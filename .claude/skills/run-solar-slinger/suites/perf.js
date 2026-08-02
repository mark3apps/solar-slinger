// Performance scenario matrix — run via the driver's `script` command:
//   script .claude/skills/run-solar-slinger/perf.js
//   script .claude/skills/run-solar-slinger/perf.js {"reps":9,"only":["dense-field"]}
//
// WHY A MATRIX AND NOT ONE NUMBER: a single "fps" figure hides which subsystem
// regressed. Each scenario below parks the ship somewhere that isolates ONE cost
// driver, so a change that only hurts (say) the gas-giant renderer shows up as
// one row moving while the rest hold.
//
// HOW SIM AND DRAW ARE SEPARATED (no rAF needed, so this is repeatable and works
// with the window hidden):
//   window.tick(0)  -> runs ZERO update() iterations and exactly ONE render(game)
//                      + updateHud. That IS the draw cost.
//   window.tick(1)  -> 60 update() calls plus one render.
//   sim per frame   = (tick(1) - tick(0)) / 60
// Medians, not means: these timings have fat tails and one GC pause otherwise
// moves the answer.
//
// HONEST LIMIT: canvas2d draw calls are recorded on the main thread and
// rasterised later, so `drawMs` measures DRAW-CALL SUBMISSION, not GPU raster.
// It tracks view complexity well (measured 0.1ms in open space at 129 awake
// bodies vs 0.6ms in a shoal at 1297) and is the right signal for "did my change
// add draw work". It is NOT a frame-budget figure — for that read
// game.perf.drawMs off a VISIBLE window, and see perf-profile's variance rules.
//
// ARGS: { reps=11, simReps=5, only=[names], seconds=1 }

const A = globalThis.ARGS || {};
const REPS = A.reps ?? 11;
const SIM_REPS = A.simReps ?? 5;
const ONLY = A.only ? new Set(A.only) : null;

const g = window.game;
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
// performance.now() is clamped to ~0.1ms in Electron, and a single render lands
// near that quantum — so timing ONE call reported 0.2 vs 0.3 on identical code,
// a one-tick difference that reads as +50%. Time a BATCH per sample and divide:
// resolution becomes 0.1/batch and the number is actually comparable.
const timeIt = (f, n, batch = 1) => {
  const s = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    for (let k = 0; k < batch; k++) f();
    s.push((performance.now() - t) / batch);
  }
  return med(s);
};

// ---- scenario setup -------------------------------------------------------
// Each returns a body/coords to park at, or null to SKIP (reported, never
// silently dropped — a scenario that vanished is itself information).
const pick = (fn) => g.bodies.find((b) => b.alive && fn(b)) || null;
const mostMoons = () => {
  let best = null, n = -1;
  for (const p of g.bodies) {
    if (!p.alive || p.type !== 'planet' || p.ptype === 'gas') continue;
    const c = g.bodies.filter((m) => m.alive && m.type === 'moon' && m.parent === p).length;
    if (c > n) { n = c; best = p; }
  }
  return best;
};

const SCENARIOS = [
  { name: 'open-space', what: 'floor cost — nothing nearby',
    setup: () => { window.goto(20000, 20000); return true; } },

  { name: 'dense-field', what: 'field LOD, rockgl instancing, minimap dot bake',
    setup: () => { const f = g.fields && g.fields[0]; if (!f) return false; window.goto(f.x, f.y); return true; } },

  { name: 'planet-system', what: 'attractors, moons, debris belt, near-ship crumble narrow phase',
    setup: () => { const p = mostMoons(); if (!p) return false; window.goto(p); return true; } },

  { name: 'gas-giant', what: 'gas render (bands, storms, wounds) + enclosed-mass gravity',
    setup: () => { const p = pick((b) => b.type === 'planet' && b.ptype === 'gas'); if (!p) return false; window.goto(p); return true; } },

  { name: 'crystal-world', what: 'the one non-circular collider — shard narrow phase in sim AND render',
    setup: () => { const p = pick((b) => b.type === 'planet' && b.ptype === 'crystal'); if (!p) return false; window.goto(p); return true; } },

  { name: 'solar-storm', what: 'sheath render + per-frame exposure/shelter resolve',
    setup: () => { window.goto(9000, 0); window.storm('here'); return true; },
    teardown: () => window.storm('off') },

  { name: 'alien-nest', what: 'AI state machines, fort turrets, alien collision loops',
    setup: () => {
      const n = pick((b) => b.type === 'nest'); if (!n) return false;
      window.goto(n);
      // A nest only hatches once the player is actually there, and the first
      // measurement of this row read aliens:0 — it was timing an empty sky and
      // calling it "AI cost". Hold position until the brood is out.
      window.god(true);
      for (let i = 0; i < 25 && g.aliens.length === 0; i++) { window.goto(n); window.tick(2); }
      return true;
    },
    teardown: () => window.god(false) },

  { name: 'debris-heavy', what: 'crust halo, chunk spray, calving, debris budget pressure',
    setup: () => {
      const p = mostMoons(); if (!p) return false;
      window.goto(p);
      window.god(true);
      window.tick(1);
      // Calve for REAL, through the real damage path: fling loose rock into the
      // world the way a player does. `thrownBy`/`thrownTimer` is what earns full
      // impulse and player credit (collisionCredit), which is what lets
      // calveCrust fire — a first cut here called a `game.__damage` hook that
      // does not exist, so the row silently measured an undamaged planet.
      // Angles are a fixed sweep, not Math.random, so an A/B run repeats.
      for (let i = 0; i < 40; i++) {
        const rock = g.bodies.find((b) => b.alive && b.type === 'asteroid' &&
          !b.fieldRock && !b.heldBy && !b.chunk && b.mass > 700 && b.thrownTimer <= 0);
        if (!rock) break;
        const ang = (i * 2.39996);                    // golden-angle sweep: even, deterministic
        rock.onRails = false; rock.rail = null; rock.liveT = 0;   // = derail()
        rock.x = p.x + Math.cos(ang) * (p.radius + 400);
        rock.y = p.y + Math.sin(ang) * (p.radius + 400);
        rock.vx = -Math.cos(ang) * 1100 + p.vx;
        rock.vy = -Math.sin(ang) * 1100 + p.vy;
        rock.thrownBy = 'player'; rock.thrownTimer = 3;
        window.tick(0.5);
      }
      window.goto(p);
      return true;
    },
    teardown: () => window.god(false) },
];

// ---- run ------------------------------------------------------------------
window.freshRun(0);
window.tick(2);

const rows = [];
for (const sc of SCENARIOS) {
  if (ONLY && !ONLY.has(sc.name)) continue;
  let ok = false;
  try { ok = sc.setup() !== false; } catch (e) { ok = false; }
  if (!ok) { rows.push({ scenario: sc.name, skipped: 'setup target not present on this seed' }); continue; }

  window.tick(1);                 // settle: LOD reclassify, camera, fog
  window.tick(0); window.tick(0); // warm the draw path

  const draw = timeIt(() => window.tick(0), REPS, 20);   // 20 renders per sample
  const full = timeIt(() => window.tick(1), SIM_REPS);
  const sim = Math.max(0, (full - draw) / 60);

  const reg = g.reg || {};
  rows.push({
    scenario: sc.name,
    isolates: sc.what,
    simMsPerFrame: +sim.toFixed(3),
    drawMsPerFrame: +draw.toFixed(3),
    totalMsPerFrame: +(sim + draw).toFixed(3),
    // The counts that EXPLAIN the timings — a row moving without these moving
    // is a real code regression; both moving together is a content change.
    awake: g.bodies._awake ? g.bodies._awake.length : null,
    bodies: g.bodies.length,
    nonField: reg.nonField ? reg.nonField.length : null,
    attractors: g.bodies.filter((b) => b.alive && b.attractor).length,   // hot loop is O(bodies x attractors)
    crust: g.bodies.filter((b) => b.alive && b.chunk).length,
    // The array is game.debris — there is no game.scrap, and reading the wrong
    // name reports null forever, which looks like "zero" at a glance.
    debris: g.debris ? g.debris.length : null,
    particles: g.particles ? g.particles.length : null,
    aliens: g.aliens ? g.aliens.length : null,
    flares: g.flares ? g.flares.length : null,
    bolts: g.bolts ? g.bolts.length : null,
    // DEBRIS_BUDGET is 1500 over reg.nonField. At 0 headroom, chunk spray,
    // spall, the death cloud and Cluster Rounds ALL become silent no-ops —
    // this exact thing shipped once and made them dead code for months.
    debrisHeadroom: reg.nonField ? 1500 - reg.nonField.length : null,
    substepsLastFrame: g.perf.steps,
    dtHz: g.perf.dtHz,
    droppedSimSeconds: +g.perf.dropped.toFixed(3),
  });

  if (sc.teardown) { try { sc.teardown(); } catch (e) { /* best effort */ } }
}

const timed = rows.filter((r) => r.totalMsPerFrame !== undefined);
timed.sort((a, b) => b.totalMsPerFrame - a.totalMsPerFrame);

return {
  seed: g.worldSeed,
  reps: { draw: REPS, sim: SIM_REPS },
  // A 120fps frame is 8.3ms; 60fps is 16.7ms. These are SUBMISSION-side numbers
  // (see the header) — compare them against a baseline run, not against a budget.
  // (the "worst 3" summary was removed — it reordered on every run and swamped
  // the diff; the rows below carry the same numbers with tolerances applied.)
  rows,
  skipped: rows.filter((r) => r.skipped).map((r) => r.scenario),
};
