import { CFG, SPECS, ABILITIES, shipStats, xpForPick, owesPick, addXp,
  abilityById, abilityRankCost, tierChoices, tierFloorFor,
  stormStrength, stormSpent, shelterR, SHIP_RADIUS } from './config.js';
import { ACHIEVEMENTS } from './achievements.js';
import { spawnAsteroid, respawnShip } from './world.js';
import { Alien } from './entities.js';
import { updateAliens } from './ai.js';
import { damageShip, parryLive } from './physics.js';
import { tryGrab, releaseHeld, addToOrbit, flingAllFromOrbit } from './tractor.js';
import { updateGlow } from './glow.js';
import { setDeathVisible, updateHud } from './hud.js';
import { setSfxVolume } from './sfx.js';
import { mulberry32, surfaceVel, scarSurfaceAt, padPos, TAU } from './util.js';
import { ROCK_SHAPES } from './rockdata.js';
import { rockCircleQuery } from './rockshape.js';
import { input } from './input.js';

// DEV MECHANICS SUITE — window.mechTest() lazy-loads this module, so normal
// play never imports it. It scripts a fixed set of player actions against a
// FIXED-SEED fresh run and asserts each core mechanic (and several design
// laws) still behaves. Repeatability: the world seed is fixed AND
// Math.random is swapped for a seeded mulberry32 for the duration (runtime
// spawns/spall/AI intentionally use Math.random in normal play — the swap
// makes the whole suite bit-identical run to run, and the finally-restore
// keeps that convention intact afterward). This is a MECHANICS smoke suite;
// long-horizon stability/balance is window.soak + the balance-test skill.
//
// TWO THINGS HAD TO BE TRUE FOR "bit-identical run to run" TO ACTUALLY HOLD,
// and neither was, until issue #96 (both are fixed at the source, not here):
//   1. Nothing outside the sim may draw from the swapped stream. sfx.js took
//      a wildly variable number of draws depending on whether an AudioContext
//      existed and whether samples had decoded — so a single real keydown in
//      the suite moved a later pick onto a different ability. sfx/music/hud
//      now own private streams.
//   2. Nothing seeded off a body id may outlive its world. `NEXT_ID` was
//      session-monotonic while rockshape.rockShapeOf keys the baked silhouette
//      off it, so a re-run built the same layout wearing DIFFERENT rock and
//      diverged within half a second. world.generateWorld resets it.
//   3. The VIEW may not reach the sim (issue #104) — LATENT, not observed.
//      game.viewR sizes the spawn ring and the leash in world.replenishWorld,
//      and the `continue` past that leash SKIPS the rng() draws behind it — so
//      viewR gates draw COUNTS; cam.zoom carries the same dependence into
//      game.aim. But main.js's fair view cancels the window out of viewR, and
//      MEASURED that cancellation is exact in float, not just in algebra:
//      viewR is byte-identical (7867.525607436779) at 1024x736, 1440x868 and
//      1920x1018, and this suite's whole report — every `draws` column and
//      every detail string — matches across all three with NO pin. So unlike
//      1 and 2, nothing was caught misbehaving here. VIEW_PIN below makes the
//      window-independence structural instead of inherited from that float
//      coincidence, restored in the finally beside Math.random.
// `draws` on every result is the tripwire for a recurrence: it is the RNG
// draw count at that test's boundary, and two runs of the same seed must
// produce the same sequence of them — on any machine, at any window size. A
// drifting draws column localises the culprit to one test in a single diff,
// which is how 1 and 2 were both found.

// The view the whole suite runs at. 1920x1080 is CFG.VIEW_REF_DIAG's own
// basis, so a pinned run sits EXACTLY at the fair-view reference: the
// normalization ratio is 1, cam.zoom === zoomCur, and viewR is exactly
// VIEW_REF_DIAG/2/zoomCur — no rounding to differ about. It is also an
// ordinary full-screen play window, so the suite exercises what people fly.
const VIEW_PIN = { vw: 1920, vh: 1080 };

// THE SPEAKERS ARE NOT PART OF ANY ASSERTION, so they may not be able to fail
// the suite. setSfxVolume reaches sfxBus.gain.setTargetAtTime, which throws
// InvalidStateError on a closed AudioContext — and there may be no audio graph
// at all, since one is only built on a user gesture. Two distinct failures come
// off that, both real:
//   - at SETUP a throw aborts the whole run, so a headless or gesture-less
//     session simply cannot run mechTest;
//   - in the TEARDOWN it is worse. The restore sits in the middle of the
//     finally, so a throw there skips every restore BELOW it — godMode,
//     started, the cursor and the held keys — which is precisely the leak the
//     teardown exists to prevent, reintroduced through the teardown itself.
// Swallowed on purpose: muting is a courtesy to whoever is listening, and a
// courtesy must not be load-bearing.
const hushAudio = (v) => { try { setSfxVolume(v); } catch { /* no audio graph — carry on */ } };

// Assertion helper: numbers land in the detail string so a failure is
// diagnosable straight from the report, without re-running.
let draws = 0;   // RNG draws taken so far this run (see the note above)
function makeT(results) {
  return (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, pass: true, detail: detail == null ? '' : String(detail), draws });
    } catch (e) {
      results.push({ name, pass: false, detail: String((e && e.message) || e), draws });
    }
  };
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

const census = (game) => {
  const c = {};
  for (const b of game.bodies) if (b.alive) c[b.type] = (c[b.type] || 0) + 1;
  return c;
};

// Order-stable fingerprint of the generated world (positions + masses of the
// first bodies) — two identical seeds must produce the identical value.
function worldChecksum(game) {
  let h = 0;
  const n = Math.min(60, game.bodies.length);
  for (let i = 0; i < n; i++) {
    const b = game.bodies[i];
    h = (h * 31 + (Math.round(b.x * 10) | 0)) | 0;
    h = (h * 31 + (Math.round(b.y * 10) | 0)) | 0;
    h = (h * 31 + (Math.round(b.mass) | 0)) | 0;
  }
  return h;
}

// Every positive distance at which a ray from a shape's own origin crosses its
// DRAWN outline, sorted. Written out here rather than borrowed from rockshape
// on purpose: this is the independent reading of the picture that the collider
// is being checked against, so it must not share code with it.
function rayCrossings(v, dx, dy) {
  const n = v.length >> 1, ts = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = v[i * 2], ay = v[i * 2 + 1];
    const ex = v[j * 2] - ax, ey = v[j * 2 + 1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den;          // along the ray
    if (t <= 0) continue;
    const u = (ax * dy - ay * dx) / den;          // along the edge
    if (u < 0 || u > 1) continue;
    ts.push(t);
  }
  return ts.sort((p, q) => p - q);
}

// Park the ship somewhere quiet with zeroed motion — each test starts from a
// known kinematic state instead of inheriting the previous test's drama.
function parkShip(game, x, y) {
  const s = game.ship;
  s.x = x; s.y = y; s.vx = 0; s.vy = 0;
  s.invuln = 0;
  game.cam.x = x; game.cam.y = y;
}

export function runMechTest(game, hooks, opts = {}) {
  const seed = opts.seed ?? 20260721;   // the default world — same layout as normal play
  const results = [];
  const t = makeT(results);
  const wall0 = performance.now();

  // ---- determinism + quiet: seeded RNG swap, sound off, picks auto-resolved
  // CAPTURE EVERYTHING FIRST, MUTATE NOTHING UNTIL INSIDE THE TRY. Every
  // restore below lives in the finally, so any mutation made BEFORE `try` is
  // unprotected: the audio mute was the one that actually bit — a throw there
  // left Math.random permanently stubbed and the view permanently pinned, i.e.
  // exactly the leak this teardown exists to prevent, reached through the
  // teardown's own setup. That call is belt-and-braces now (hushAudio swallows
  // it), but the ORDERING is the rule and it holds for every mutation added
  // here later, guarded or not. T23's comment states the same convention.
  const realRandom = Math.random;
  const rng = mulberry32(seed ^ 0x5f3759df);
  const wasAuto = game.autoUpgrade;
  // PAUSE IS SHARED STATE TOO. T23 forces `paused = false` to prove a digit
  // cannot be spent into a paused run, and main.js's frame loop gates the sim
  // update on `game.paused` — so running the suite from the console while
  // paused would resume the run under the player's hands on the very next rAF.
  // Restored in the finally beside Math.random and input.keys.
  const wasPaused = game.paused;
  // THE INPUT DEVICE IS SHARED STATE, and the suite drives it: the docking and
  // pilot-card cases park the cursor (input.mouseX/Y feed game.aim every frame)
  // and hold KeyW. Left behind, that state is the NEXT run's starting
  // condition, and a second mechTest() in the same session stops matching the
  // first — measured: the delivery check paid +95 xp on one run and +83 on the
  // next, purely off a stale cursor. Restored in the finally beside
  // Math.random, for exactly the same reason.
  const wasMouseX = input.mouseX, wasMouseY = input.mouseY;
  const wasKeys = new Set(input.keys);
  // THE WINDOW IS SHARED STATE TOO, and it is not the suite's to inherit — see
  // note 3 above. main.js's simView() honours this for every SIM reader of the
  // view (applyZoom, and update()'s viewR + mouseWorld); the chart's DOM
  // handlers keep the real one, which the suite never touches.
  const wasViewPin = game.viewPin;
  // GOD MODE AND `started` ARE SHARED STATE, and the suite was FORCING them
  // rather than restoring them: the old finally set `game.godMode = false`
  // outright, so running mechTest() under window.god(true) silently disarmed
  // it, and hooks.freshRun sets `game.started = true` and never put it back, so
  // running from the splash returned you a live run playing behind the overlay.
  const wasGod = game.godMode;
  const wasStarted = game.started;

  try {
    draws = 0;
    Math.random = () => { draws++; return rng(); };
    game.autoUpgrade = true;
    // FORCE GOD MODE OFF, THEN RESTORE IT — the finally puts wasGod back
    // (issue #151), but an ambient window.god(true) left ON here silently
    // disarms damageShip's early-out for the whole suite, which the shield
    // case then mis-attributes as its own failure (#186) instead of a
    // known debugging hook being live.
    game.godMode = false;
    game.viewPin = VIEW_PIN;
    // PARK THE CURSOR AT THE PINNED CENTRE. The suite restored input.mouseX/Y
    // but never INITIALISED them, and update() rebuilds game.aim from them
    // every frame — so every case before the docking block (grab, fling, orbit,
    // picks, shield, glow, death, delivery, chart) ran on wherever the player's
    // real cursor happened to be. That is the +95-vs-+83 delivery XP wobble the
    // note above records, and it is also why the view pin alone was not enough:
    // pre-pin the offset was (mouseX - realVw/2)/zoom, so a centred cursor gave
    // exactly zero on ANY window; post-pin it became (mouseX - 960)/zoom, which
    // for that same centred cursor varies WITH the window. Pinning the cursor
    // to the pinned view's centre restores the zero and closes both halves.
    input.mouseX = VIEW_PIN.vw / 2;
    input.mouseY = VIEW_PIN.vh / 2;
    // Mute the SFX bus for the scripted burst (there are no audio toggles any
    // more — the volume slider IS the control; game.sfxVol still holds the
    // user's level to restore). Via hushAudio — see its note.
    hushAudio(0);
    game.collisionLog = [];
    game.deathLog = [];
    game.nanEvents = 0;

    // T0 — the achievement catalog is id-unique. The whole track is id-keyed:
    // `award` returns early on `st.got[a.id]`, so a duplicate id silently
    // forfeits the second row's points and XP while the panel — keyed the same
    // way — renders BOTH rows as earned off one predicate. It cost a real row
    // ('homebody', duplicated by the docking batch) and nothing surfaced it, so
    // it is asserted mechanically rather than left to a QA pass.
    t('achievement ids are unique', () => {
      const seen = new Map(), dupes = [];
      for (const a of ACHIEVEMENTS) {
        if (seen.has(a.id)) dupes.push(`${a.id} ("${seen.get(a.id)}" / "${a.name}")`);
        else seen.set(a.id, a.name);
      }
      expect(dupes.length === 0, `duplicate achievement id(s): ${dupes.join(', ')}`);
      return `${ACHIEVEMENTS.length} rows, all ids unique`;
    });

    // T0b — A LANDMARK COLLIDES AS THE ROCK IT IS DRAWN AS. Pure geometry over
    // the baked library: no world, no RNG (the `draws` column must not move),
    // so it sits up here with the other catalog checks.
    //
    // The design law is "the crater you SEE is the crater you can fly into —
    // one profile feeds render, physics and both predict mirrors", and for
    // shaped rock the seam is between render.traceAsteroid (which draws the
    // TRUE polygon, concavities and all) and the collider. This asserts they
    // agree to render.js's own budget: its cosmetic wobble is held at 0.8% of
    // body radius precisely so drawn and collided stay inside one band, so 0.8%
    // is the tolerance the collider has to clear too.
    //
    // WHAT THIS CATCHES, AND WHY IT IS NOT A FORMALITY (issue #102). Until the
    // circle-vs-outline query landed, the collider asked for one radius per
    // bearing (physics.surfRadius -> rockshape.rockSurfAt), which takes the
    // OUTERMOST ray/outline crossing. That is the surface only while the
    // outline is a radial function. util.rockOutline is one by construction,
    // but the BAKE cuts children out of parents and a piece lands with its own
    // centroid — so a concave bite can sit between that centroid and the far
    // wall. 17 of the 68 baked shapes have such bearings (s2_34 worst at 1.40
    // body radii, m2_31 over 6.7% of its circumference), and on them the
    // collider sat a whole body radius outside the rock: the hull stopped and
    // bounced in open space. Pointed at rockSurfAt this exact case reports 148
    // disagreements across 14 of the 68 shapes (the other three offenders have
    // arcs too narrow for 180 bearings to land in); pointed at the circle query
    // the boundary agrees to ~4e-12 radii, against a 8e-3 budget.
    t('shaped rock: collider agrees with the drawn outline', () => {
      const BUD = 0.008;          // render.js's cosmetic wobble, in body radii
      const N = 180;              // bearings per shape per placement
      // Two placements, because the query has to be right in WORLD space: a
      // unit rock at the origin and a 137-unit rock turned 0.7 rad and parked
      // far out would both pass a frame-confused implementation only by luck.
      const PLACE = [{ r: 1, rot: 0 }, { r: 137, rot: 0.7 }];
      let flips = 0, gaps = 0, worst = 0, multi = 0;
      const bad = [];
      for (const [id, sh] of Object.entries(ROCK_SHAPES)) {
        let shapeMulti = false;
        for (const p of PLACE) {
          const b = { x: 41000, y: -25000, rot: p.rot, radius: p.r, shapeId: id };
          for (let k = 0; k < N; k++) {
            const th = (k + 0.5) / N * TAU;             // shape-local bearing
            const ts = rayCrossings(sh.v, Math.cos(th), Math.sin(th));
            // An even crossing count means the ray started OUTSIDE the polygon
            // — no "near surface" to check against from here.
            if (!ts.length || ts.length % 2 === 0 || ts[0] < 4 * BUD) continue;
            const wth = th + p.rot;
            const at = (r) => rockCircleQuery(b,
              b.x + Math.cos(wth) * r * p.r, b.y + Math.sin(wth) * r * p.r).d / p.r;
            // The collider's verdict must FLIP at the drawn near surface: a
            // hair inside is inside, a hair outside is outside. Skipped where
            // the outline is thinner than the budget, which no tolerance can
            // resolve either way.
            if (!(ts.length > 1 && ts[1] - ts[0] < 4 * BUD)) {
              flips++;
              const dIn = at(ts[0] - BUD), dOut = at(ts[0] + BUD);
              if (!(dIn < 0 && dOut > 0)) bad.push(`${id} @${th.toFixed(2)} flip ${dIn.toFixed(4)}/${dOut.toFixed(4)}`);
              worst = Math.max(worst, Math.abs(at(ts[0])));
            }
            // ...and the GAP: a bearing whose ray leaves the rock and re-enters
            // it has real empty space in between. That gap is what the player
            // flies into, and reporting it as solid is the whole of issue #102.
            if (ts.length > 1) {
              shapeMulti = true;
              gaps++;
              const d = at((ts[0] + ts[1]) / 2);
              if (!(d > 0)) bad.push(`${id} @${th.toFixed(2)} gap reported solid (${d.toFixed(4)})`);
            }
          }
        }
        if (shapeMulti) multi++;
      }
      expect(bad.length === 0,
        `${bad.length} disagreement(s) with the drawn outline: ${bad.slice(0, 4).join('; ')}`);
      expect(worst <= BUD, `boundary error ${worst.toFixed(5)} radii exceeds the ${BUD} budget`);
      return `${Object.keys(ROCK_SHAPES).length} shapes, ${flips} boundary flips + ${gaps} concavity probes, ` +
        `${multi} non-radial shapes, worst boundary error ${worst.toExponential(1)} radii`;
    });

    // T1 — world generation is deterministic for a fixed seed
    let sum1 = 0;
    t('world-gen deterministic', () => {
      hooks.freshRun(0, seed);            // spec 0 = BRAWLER
      sum1 = worldChecksum(game);
      const n1 = game.bodies.length;
      hooks.freshRun(0, seed);
      expect(worldChecksum(game) === sum1, `checksums differ across regenerations`);
      expect(game.bodies.length === n1, `body count differs: ${game.bodies.length} vs ${n1}`);
      return `bodies=${n1} checksum=${sum1}`;
    });
    const skyBefore = census(game);

    // T2 — tractor grab: in-range rock under the cursor is taken, pays XP,
    // and comes OFF its rail (the derail-on-grab trigger)
    let rock = null;
    t('grab + derail + catch XP', () => {
      const s = game.ship;
      parkShip(game, s.x, s.y);
      rock = spawnAsteroid(game.bodies, s.x + 120, s.y, 0, 0, 100);
      rock.onRails = true; rock.rail = {};   // fake a rail: tryGrab must clear it
      game.aim.x = rock.x; game.aim.y = rock.y;
      const xp0 = game.prog.xp;
      // tryGrab returns 'held' | 'winching' | 'refused' | null — compare, never
      // test truthiness: 'refused' is truthy and would pass a bare expect().
      expect(tryGrab(game) === 'held', 'tryGrab refused an in-range rock');
      expect(game.held === rock, 'held is not the grabbed rock');
      expect(!rock.onRails, 'grab did not derail the rock');
      expect(game.prog.xp > xp0, 'catch paid no XP');
      return `mass=${rock.mass} xp+${(game.prog.xp - xp0).toFixed(1)}`;
    });

    // T3 — DESIGN LAWS: the throw flies exactly at the cursor FROM THE ROCK'S
    // OWN POSITION, and flinging imparts zero recoil on the ship
    t('fling at cursor, no recoil', () => {
      const s = game.ship;
      expect(game.held === rock, 'setup: rock not held');
      game.aim.x = rock.x + 3000; game.aim.y = rock.y + 4000;   // known 3-4-5 direction
      const svx = s.vx, svy = s.vy;
      releaseHeld(game, true);
      expect(s.vx === svx && s.vy === svy, 'fling recoiled the ship');
      const rvx = rock.vx - svx, rvy = rock.vy - svy;           // throw is ship-relative
      const sp = Math.hypot(rvx, rvy);
      const dot = (rvx * 0.6 + rvy * 0.8) / sp;                 // vs the (0.6, 0.8) aim unit
      expect(dot > 0.999, `throw off-axis: cos=${dot.toFixed(5)}`);
      expect(rock.thrownBy === 'player', 'thrownBy not credited to player');
      return `speed=${Math.round(sp)} cos=${dot.toFixed(5)}`;
    });

    // T4 — orbit shield: it's ABILITY-gated (orbit channel rank 0 = no ring
    // at all), then with a rank it captures, and the shotgun launches it.
    // PROBED AS A HAULER: the ring is that spec's machinery now — a BRAWLER's
    // orbit ability feeds its ram instead and shipStats pins its maxOrbiters
    // to 0 outright, so on the suite's own spec this gate is trivially closed
    // and proves nothing. The spec and the orbit upgrades are restored after,
    // because every later test assumes the brawler build.
    t('orbit gate, capture + shotgun fling', () => {
      const s = game.ship;
      const r2 = spawnAsteroid(game.bodies, s.x + 100, s.y - 40, 0, 0, 60);
      game.aim.x = r2.x; game.aim.y = r2.y;
      expect(tryGrab(game) === 'held', 'setup: second grab failed');
      const wasSpec = game.prog.spec;
      // Strip EVERY orbit-channel rank (the brawler kit's own War Rack included
      // — channels sum across specs, so a leftover rank would open slots).
      const hadRack = game.prog.upgrades.bulwarkRing || 0;
      const hadSling = game.prog.upgrades.orbitalSling || 0;
      delete game.prog.upgrades.bulwarkRing;
      delete game.prog.upgrades.orbitalSling;
      game.prog.spec = 'hauler';
      game.st = shipStats(game.prog);
      expect(game.st.maxOrbiters === 0, 'setup: orbit channel not actually empty');
      expect(!addToOrbit(game), 'orbit accepted a rock with NO orbit ability (gate broken)');
      game.prog.upgrades.orbitalSling = 1;       // HAULER's orbit-channel ability
      game.st = shipStats(game.prog);
      expect(game.st.maxOrbiters > 0, 'orbit rank opened no slots');
      expect(addToOrbit(game), 'addToOrbit refused a light rock with the ability owned');
      expect(game.orbit.length === 1 && game.held === null, 'orbit bookkeeping off after capture');
      const n = flingAllFromOrbit(game, 1);
      expect(n === 1, `shotgun launched ${n} rocks, wanted 1`);
      expect(game.orbit.length === 0, 'orbit not empty after shotgun');
      expect(r2.thrownBy === 'player', 'shotgun rock not player-credited');
      // Put the brawler build back exactly as it was.
      game.prog.spec = wasSpec;
      if (hadRack) game.prog.upgrades.bulwarkRing = hadRack;
      if (hadSling) game.prog.upgrades.orbitalSling = hadSling;
      else delete game.prog.upgrades.orbitalSling;
      game.st = shipStats(game.prog);
      return 'capture -> launch OK (probed as hauler; ring is not a brawler system)';
    });

    // T5 — DESIGN LAW: an owed pick is DEFERRED while flingDelayT runs, then
    // consumed (never lost). The fling above armed the ~2s grace window.
    t('pick deferred by fling, then consumed', () => {
      expect(game.flingDelayT > 0, 'setup: no post-fling grace running');
      game.prog.xp = xpForPick(game.prog) + 1;
      const lvl0 = game.prog.level;
      hooks.stepSim(0.5);
      expect(game.prog.level === lvl0, 'pick fired inside the fling grace window');
      expect(owesPick(game.prog), 'owed pick was lost during the deferral');
      hooks.stepSim(2.2);
      expect(game.prog.level > lvl0, 'deferred pick was never consumed');
      // An ability pick is an OFFER now, not a freeze — upgradeChoices is what
      // stands until it is answered, so that is what autoUpgrade has to clear
      // (choosingUpgrade is the spec card's flag and never moves here at all).
      expect(!game.upgradeChoices, 'autoUpgrade left the offer standing');
      expect(!game.choosingUpgrade, 'an ability pick froze the sim');
      return `level ${lvl0} -> ${game.prog.level}`;
    });

    // T5b — AUTOMATIC RANKS: XP feeds every owned ability's own pool, ranks
    // land with NO card, thresholds RISE per rank, and the pick purse is a
    // separate accumulator (ranking up must never spend it).
    t('abilities rank up automatically off XP', () => {
      const prog = game.prog;
      const id = 'kineticSling';                 // BRAWLER kit, max 6
      const a = abilityById(id);
      const was = prog.upgrades[id];             // the probe is restored at the end —
      prog.upgrades[id] = 1; prog.abilXp[id] = 0;   //   later tests keep the real build
      const cost1 = abilityRankCost(a, 1), cost2 = abilityRankCost(a, 2);
      expect(cost2 > cost1, `threshold did not rise: rank1 ${cost1}, rank2 ${cost2}`);
      const xp0 = prog.xp;
      addXp(game, cost1 - 1);                    // one XP short — must NOT rank
      expect(prog.upgrades[id] === 1, 'ranked up below its threshold');
      expect(prog.xp === xp0 + cost1 - 1, 'ability growth ate the pick purse');
      addXp(game, 1);                            // ...and now it does
      expect(prog.upgrades[id] === 2, 'crossing the threshold did not rank up');
      expect(!game.choosingUpgrade && !game.upgradeChoices, 'an automatic rank opened a card');
      expect(game.rankUps.some((r) => r.id === id), 'the rank was never queued for the HUD');
      // A fat award crosses several thresholds in one call
      addXp(game, cost2 * 6);
      const landed = prog.upgrades[id];
      expect(landed > 3, `one fat award landed only rank ${landed}`);
      // Unwind the probe: the XP it poured in would otherwise owe a pile of
      // picks that fire (and tier the run up) inside the NEXT test's stepSim.
      game.rankUps.length = 0;
      prog.xp = xp0; prog.upgrades[id] = was; prog.abilXp[id] = 0;
      game.st = shipStats(prog);
      return `rank1 costs ${cost1}, rank2 ${cost2}, one award reached rank ${landed}`;
    });

    // T5c — DESIGN LAW: ability thresholds always RISE, and no two abilities
    // in a spec's starting kit rank up at the same moment. Kit abilities are
    // the only ones learned simultaneously, so their pools stay equal forever
    // and only the cost ladder keeps them apart: kit rows are SPACED by their
    // position in the kit (config.ladderScale) inside a band ABIL_XP_SPREAD
    // wide, with ABIL_XP_WOBBLE nudging each rank. This is a pure catalog
    // property — no sim needed.
    t('ability thresholds rise, and kits never rank in lockstep', () => {
      for (const a of ABILITIES) {
        let prev = 0;
        for (let r = 1; r < a.max; r++) {
          const c = abilityRankCost(a, r);
          expect(c > prev, `${a.id} rank ${r} costs ${c}, not more than the previous ${prev}`);
          prev = c;
        }
      }
      let worst = Infinity, where = '';
      for (const s of SPECS) {
        const pts = [];
        for (const id of s.start) {
          const a = abilityById(id);
          let cum = 0;
          for (let r = 1; r < a.max; r++) { cum += abilityRankCost(a, r); pts.push({ id, cum }); }
        }
        pts.sort((x, y) => x.cum - y.cum);
        for (let i = 1; i < pts.length; i++) {
          const d = pts[i].cum - pts[i - 1].cum;
          if (d < worst) { worst = d; where = `${s.id}: ${pts[i - 1].id}@${pts[i - 1].cum} vs ${pts[i].id}@${pts[i].cum}`; }
        }
      }
      // 40 XP is a few seconds of play even early — below that two ranks land
      // as one event and the stagger has failed.
      expect(worst >= 40, `kit rank-ups only ${worst} XP apart — ${where}`);
      return `all ladders rise; tightest kit gap ${worst} XP (${where})`;
    });

    // T5d — DESIGN LAW: an ability that is INERT without another is never
    // OFFERED without it (`needs` -> config.prereqMet, filtered in
    // tierChoices). Three properties, and the third is the one that bites: a
    // gate that no reachable card can open turns a dead card into a dead
    // BRANCH, which is strictly worse. Pure catalog + draw — no sim.
    t('prerequisite abilities gate their dependents', () => {
      const draw = (spec, tier, upgrades, n = 3000) => {
        const prog = { tier, spec, upgrades };
        const seen = new Set();
        for (let i = 0; i < n; i++) for (const a of tierChoices(prog, 2)) seen.add(a.id);
        return seen;
      };
      const gated = ABILITIES.filter((a) => a.needs);
      expect(gated.length > 0, 'no ability carries a `needs` — the gate is unwired');
      // 1. With an EMPTY build, nothing gated can be drawn, at any tier.
      for (const s of SPECS) {
        for (let tier = 0; tier <= 5; tier++) {
          const seen = draw(s.id, tier, {}, 800);
          for (const a of gated) {
            expect(!seen.has(a.id), `${s.id} tier ${tier} was offered ${a.id} with no ${a.needs}`);
          }
        }
      }
      // 2. Owning ANY provider of the needed channel opens the gate — the
      //    prereq names a channel, not an id, so any feeder must satisfy it.
      let opened = 0;
      for (const a of gated) {
        for (const p of ABILITIES.filter((x) => x.channel === a.needs)) {
          for (const s of SPECS) {
            const floor = Math.max(tierFloorFor(a, s.id), tierFloorFor(p, s.id));
            if (!isFinite(floor)) continue;   // this spec can be offered neither
            const seen = draw(s.id, 5, { [p.id]: 1 }, 2500);
            expect(seen.has(a.id), `${s.id} owns ${p.id} (${a.needs}) but ${a.id} stayed locked`);
            opened++;
          }
        }
      }
      // 3. NO DEAD BRANCHES: from each spec's real starting kit, greedily
      //    taking every card on offer must eventually reach every ability that
      //    spec can be offered at all. A gate whose provider is itself gated
      //    (or floored out of reach) would strand its dependent here.
      const stranded = [];
      for (const s of SPECS) {
        const upgrades = {};
        for (const id of s.start) upgrades[id] = 1;
        const prog = { tier: 5, spec: s.id, upgrades };
        for (let i = 0; i < 200; i++) {
          const c = tierChoices(prog, 2);
          if (!c.length) break;
          for (const a of c) upgrades[a.id] = 1;
        }
        for (const a of ABILITIES) {
          if (!isFinite(tierFloorFor(a, s.id))) continue;
          if (!(upgrades[a.id] > 0)) stranded.push(`${s.id}:${a.id}`);
        }
      }
      expect(!stranded.length, `unreachable from the starting kit: ${stranded.join(', ')}`);
      return `${gated.length} gated rows locked on an empty build, ${opened} provider/spec pairs unlock them, 0 stranded`;
    });

    // T6 — shield ability: rank>0 unlocks a pool that absorbs BEFORE the hull.
    //
    // PROBED AS A SCOUT, and this is the DESIGN LAW half of the test: the
    // shield is SCOUT-ONLY. Phase Screen is the sole shield-channel row in the
    // catalog — BRAWLER's front-arc War Plating is deleted and HAULER never had
    // one — so a brawler-spec probe would be asserting against a build no run
    // can reach. The spec is restored after; every later test wants the brawler.
    //
    // The second half is the ARC law, which physics.damageShip still honours
    // even though nothing in the catalog produces a partial wedge today: a hit
    // outside the coverage arc skips the shield entirely, and DIRECTIONLESS
    // damage (heat, gas crush, Oort grind) is soaked only in the arc's COVERAGE
    // SHARE. It is exercised against an EXPLICIT wedge written onto game.st,
    // not against an ability's number, so the mechanism cannot rot unnoticed
    // while it sits between users.
    t('shield unlocks and absorbs first', () => {
      const s = game.ship;
      const wasSpec = game.prog.spec;
      game.prog.spec = 'scout';
      game.prog.upgrades.phaseScreen = 3;        // SCOUT's shield channel
      game.st = shipStats(game.prog);
      expect(game.st.shieldMax > 0, 'shield rank did not unlock a pool');
      expect(game.st.shieldArc >= Math.PI, 'Phase Screen is a FULL WRAP, not a wedge');
      const pool = game.st.shieldMax;
      s.shield = pool; s.invuln = 0;
      let hull0 = s.hull, sh0 = s.shield;
      damageShip(game, 10, 'suite: absorb probe', s.angle);   // straight up the nose
      expect(s.hull === hull0, 'damage leaked past a full shield');
      expect(Math.abs(sh0 - s.shield - 10) < 1e-9, `shield absorbed ${sh0 - s.shield}, wanted 10`);
      // ...and a full wrap has no bare bearing: the same hit from behind is
      // soaked exactly as the frontal one was.
      s.shield = pool; s.invuln = 0;
      hull0 = s.hull; sh0 = s.shield;
      damageShip(game, 10, 'suite: rear probe', s.angle + Math.PI);
      expect(s.hull === hull0, 'a full wrap let a rear hit through to the hull');
      expect(Math.abs(sh0 - s.shield - 10) < 1e-9, 'a full wrap soaked the wrong amount from behind');
      // ARC MECHANISM, forced: a narrow nose wedge eats a frontal hit whole,
      // ignores one from behind, and takes only shieldArc / PI of an all-over
      // effect. The share is DERIVED from the wedge rather than hardcoded, so
      // retuning the angle here can't silently invert the assertion.
      const wedge = Math.PI * 0.35;
      game.st.shieldArc = wedge;
      const share = wedge / Math.PI;
      s.shield = pool; s.invuln = 0;
      hull0 = s.hull; sh0 = s.shield;
      damageShip(game, 10, 'suite: wedge rear probe', s.angle + Math.PI);
      expect(s.shield === sh0, 'the front arc soaked a hit from behind');
      expect(Math.abs(hull0 - s.hull - 10) < 1e-9, 'a rear hit did not go straight to hull');
      s.shield = pool; s.invuln = 0;
      hull0 = s.hull; sh0 = s.shield;
      damageShip(game, 10, 'suite: directionless probe');
      expect(Math.abs(sh0 - s.shield - 10 * share) < 1e-9,
        `the wedge soaked ${sh0 - s.shield} of 10 directionless, wanted ${10 * share}`);
      expect(Math.abs(hull0 - s.hull - 10 * (1 - share)) < 1e-9, 'the rest never reached the hull');
      // Put the brawler build back exactly as it was — including the hull/shield
      // split, which shipStats rebuilds from the (now shieldless) spec.
      game.prog.spec = wasSpec;
      delete game.prog.upgrades.phaseScreen;
      game.st = shipStats(game.prog);
      expect(game.st.shieldMax === 0, 'BRAWLER came back carrying a shield pool');
      s.shield = game.st.shieldMax;
      s.hull = Math.min(s.hull, game.st.hullMax);
      return `pool=${Math.round(pool)} (probed as scout; the shield is scout-only)`;
    });

    // T7 — window.god: the damageShip choke point ignores everything
    t('god mode blocks damage', () => {
      const s = game.ship;
      s.invuln = 0;
      const hull0 = s.hull, sh0 = s.shield;
      game.godMode = true;
      damageShip(game, 500, 'suite: god probe');
      game.godMode = false;
      expect(s.hull === hull0 && s.shield === sh0, 'god mode leaked damage');
      return 'blocked 500 dmg';
    });

    // T8 — DESIGN LAW: the hull never self-heals (glow pockets only)
    // The law's ONE sanctioned exception has to be allowed for here: a pick or
    // an automatic RANK that raises hullMax heals the gain +20%
    // (main.healOnHullGain). Achievements pay XP now, so a row landing during
    // these three seconds can rank a hull track mid-probe — that heal is the
    // rule working, not the law breaking, so the budget below is exactly it.
    t('hull does not self-heal', () => {
      const s = game.ship;
      parkShip(game, 0, -26000);                 // quiet space, far from pockets
      s.hull = game.st.hullMax * 0.5;
      const hull0 = s.hull, max0 = game.st.hullMax;
      hooks.stepSim(3);
      const sanctioned = Math.max(0, game.st.hullMax - max0) * 1.2;
      expect(s.hull <= hull0 + sanctioned + 1e-6,
        `hull rose ${s.hull - hull0} with no glow pocket (hull-gain heal allowed ${sanctioned})`);
      return sanctioned > 0
        ? `held at ${Math.round(hull0)} + ${Math.round(sanctioned)} hull-gain heal`
        : `held at ${Math.round(hull0)}/${game.st.hullMax}`;
    });

    // T9 — the shield DOES recharge after the quiet delay. Probed as a SCOUT
    // for the same reason T6 is: the shield is scout-only now, so the suite's
    // own brawler build has no pool for a regen tick to fill. Restored after.
    //
    // This one STEPS THE SIM for a second, so it strips the brawler's War Rack
    // across the swap the same way T4 does — channels sum across specs, and a
    // leftover orbit rank would run that second with a scout holding an open
    // ring slot AND a loaded ram it no longer has the capacity for. T6 gets
    // away without it because it only calls damageShip directly.
    t('shield recharges after quiet time', () => {
      const s = game.ship;
      const wasSpec = game.prog.spec;
      const hadRack = game.prog.upgrades.bulwarkRing || 0;
      const hadRam = s.ram || 0;
      delete game.prog.upgrades.bulwarkRing;
      s.ram = 0;
      game.prog.spec = 'scout';
      game.prog.upgrades.phaseScreen = 3;
      game.st = shipStats(game.prog);
      s.hull = Math.min(s.hull, game.st.hullMax);
      s.shield = 0;
      game.lastDamage = game.time - (game.st.regenDelay + 1);
      hooks.stepSim(1);
      const gained = s.shield;
      expect(gained > 0, 'shield did not recharge after the quiet delay');
      // Put the brawler build back exactly as it was.
      game.prog.spec = wasSpec;
      delete game.prog.upgrades.phaseScreen;
      if (hadRack) game.prog.upgrades.bulwarkRing = hadRack;
      game.st = shipStats(game.prog);
      s.ram = hadRam;
      s.shield = 0;
      return `+${gained.toFixed(1)} in 1s`;
    });

    // T10 — speed governor: an absurd velocity bleeds back toward the local
    // flow ceiling (loose bound — flow+cap is far below this everywhere).
    // God-wrapped: at 6000 u/s the probe sweeps a long arc, and a chance
    // planet clip must not turn a governor test into a death test.
    t('speed governor bleeds overspeed', () => {
      const s = game.ship;
      parkShip(game, 0, -26000);
      s.vx = 0; s.vy = 6000;
      game.godMode = true;
      hooks.stepSim(1);
      game.godMode = false;
      const sp = Math.hypot(s.vx, s.vy);
      expect(sp < 2500, `speed still ${Math.round(sp)} after 1s (cap chain broken?)`);
      return `6000 -> ${Math.round(sp)}`;
    });

    // T11 — glow pocket heals the hull (the ONLY mid-life heal)
    t('glow mote heals hull', () => {
      const s = game.ship;
      const p = game.glowPockets[0];
      expect(p && p.motes.length, 'no glow pockets in the world');
      const m = p.motes[0];
      parkShip(game, p.cx + m.lx, p.cy + m.ly);  // stand on the mote
      s.hull = game.st.hullMax * 0.4;
      const hull0 = s.hull;
      // Half a second of glow ticks: the pocket drifts on its rail, but the
      // capture-and-home ramp guarantees the mote closes on a parked ship
      for (let i = 0; i < 30 && s.hull === hull0; i++) updateGlow(game, 1 / 60);
      expect(s.hull > hull0, 'standing on a glow mote healed nothing');
      return `+${(s.hull - hull0).toFixed(1)} hull`;
    });

    // T12 — death spends a life, keeps the build; respawn restores the ship
    t('death spends life, respawn keeps build', () => {
      const s = game.ship;
      parkShip(game, 0, -26000);
      const lives0 = game.prog.lives;
      const build = JSON.stringify(game.prog.upgrades);
      s.shield = 0; s.invuln = 0;
      damageShip(game, 999999, 'suite: scripted kill');
      expect(!s.alive, 'kill probe did not kill');
      hooks.stepSim(1 / 60);                     // update() runs the death bookkeeping
      expect(game.prog.lives === lives0 - 1, `lives ${lives0} -> ${game.prog.lives}, wanted -1`);
      respawnShip(game);
      setDeathVisible(false);                    // clear the panel the bookkeeping raised
      expect(s.alive && s.hull > 0, 'respawn left the ship dead');
      expect(JSON.stringify(game.prog.upgrades) === build, 'respawn changed the build');
      return `lives ${lives0} -> ${game.prog.lives}, build kept`;
    });

    // T13 — NaN tripwire: a poisoned body is culled and counted, and the
    // poison does not spread to the rest of the system
    t('NaN tripwire contains poison', () => {
      const s = game.ship;
      parkShip(game, 0, -26000);
      const bad = spawnAsteroid(game.bodies, s.x + 500, s.y, 0, 0, 50);
      bad.x = NaN;
      const nan0 = game.nanEvents;
      hooks.stepSim(2 / 60);
      expect(!bad.alive, 'non-finite body survived the tripwire');
      expect(game.nanEvents > nan0, 'tripwire did not count the cull');
      expect(isFinite(s.x + s.y + s.vx + s.vy), 'ship went non-finite');
      for (const b of game.bodies) {
        if (b.alive) expect(isFinite(b.x + b.y + b.vx + b.vy), `body ${b.type}#${b.id} went non-finite`);
      }
      const counted = game.nanEvents - nan0;
      game.nanEvents = nan0;   // scrub the DELIBERATE injection from the report tally,
                               // so logs.nanEvents is 0 unless something REAL leaked
      return `culled, tripwire counted ${counted}`;
    });

    // T15 — EXPEDITION: the shared delivery verb — a wreck brought into the
    // Herald's catch radius is CONSUMED (a handover, not a kill: no shatter,
    // no scrap) and wakes it, paying XP
    t('delivery: wreck wakes the Herald', () => {
      const gh = game.ghost;
      expect(gh && gh.alive, 'no Herald in the world');
      expect(!gh.awake, 'Herald started awake');
      parkShip(game, gh.x + 600, gh.y);
      const w = spawnAsteroid(game.bodies, gh.x + 200, gh.y, gh.vx, gh.vy, 300);
      w.wreck = true;
      const xp0 = game.prog.xp;
      hooks.stepSim(2 / 60);   // updateDeliveries runs per-frame in replenishWorld
      expect(gh.awake, 'delivered wreck did not wake the Herald');
      expect(!w.alive, 'delivered wreck was not consumed');
      expect(game.prog.xp > xp0, 'the wake paid no XP');
      return `awake, +${(game.prog.xp - xp0).toFixed(0)} xp`;
    });

    // T16 — EXPEDITION: charting pays exactly once per key, the hidden dark
    // star stays out of the denominator, and 100% fires MASTER CHART (whose
    // reward reads through shipStats.sensorMul)
    t('chart pays once; master chart at 100%', () => {
      expect(game.darkStar && game.darkStar.hidden, 'dark star not hidden at start');
      let lastMoon = null;
      for (const b of game.bodies) {
        if (!b.alive || !b.chartKey || b.hidden) continue;
        if (!lastMoon && b.type === 'moon' && !b.fort) { lastMoon = b; continue; }
        if (!game.charted[b.chartKey]) { game.charted[b.chartKey] = true; game.prog.surveyed++; }
      }
      expect(lastMoon, 'no moon left to chart');
      parkShip(game, lastMoon.x + lastMoon.radius + 60, lastMoon.y);
      const surveyed0 = game.prog.surveyed;
      hooks.stepSim(1.2);   // > the 0.5s scan throttle
      expect(game.charted[lastMoon.chartKey], 'the last moon did not chart');
      expect(game.prog.surveyed === surveyed0 + 1,
        `surveyed ${surveyed0} -> ${game.prog.surveyed}, wanted exactly +1`);
      expect(game.prog.masterChart, 'MASTER CHART did not fire at 100%');
      expect(game.st.sensorMul >= 1.25, `sensorMul ${game.st.sensorMul} — master-chart bonus missing`);
      hooks.stepSim(0.6);
      expect(game.prog.surveyed === surveyed0 + 1, 'a charted key paid again');
      return `surveyed=${game.prog.surveyed}, masterChart fired, hidden star excluded`;
    });

    // ---- DOCKING ------------------------------------------------------------
    // The whole mechanic was shipped untested by this suite, and two real bugs
    // (Reflex Jink and the parry both live at a berth, the falsely-awardable
    // "Limped In") got through review because nothing here exercised it.
    //
    // `setDown` is the shared approach: put the hull on a world at the surface
    // velocity and aim the nose straight up, which is what the three gates want.
    // The aim matters — `s.angle` chases `game.aim`, so without pointing it
    // outward the level gate refuses and a berth never forms.
    // Cursor 300 screen-px along `bearing` from the view centre. input.mouseX/Y
    // carry CSS px and update() maps them back through the same view width, so
    // the same numbers go straight back in — as long as both halves agree about
    // how wide the view is. They read VIEW_PIN rather than the real window on
    // purpose: unpinned, 300px is a different world distance on every monitor
    // (it is divided by cam.zoom), and the suite is bit-repeatable by contract.
    const aimAt = (bearing) => {
      input.mouseX = VIEW_PIN.vw / 2 + Math.cos(bearing) * 300;
      input.mouseY = VIEW_PIN.vh / 2 + Math.sin(bearing) * 300;
    };
    // THE MOUSE IS THE HELM. `s.angle` chases `game.aim`, and update() rebuilds
    // `game.aim` from `input.mouseX/Y` every frame — so setting game.aim here
    // would be overwritten within one step and the nose would swing back off
    // the arc. Park the cursor instead: the camera is ship-centred and the
    // world axes are the screen axes, so +x on screen is bearing 0 in world.
    // SEAT IT PROPERLY, not on the contact boundary. This used to place the hull
    // 0.5 units into the surface, which is less than the ship drifts outward
    // while the settle runs: the contact gate then came down to whether the last
    // substep happened to leave it a fraction inside or a fraction outside, and
    // outside means updateDock finds no candidate and names NO gate at all —
    // which reads as "the gate logic broke" when the gate logic was never
    // reached. It survived only by luck of one exact trajectory, so any change
    // that perturbed the sim at all failed four docking tests at once with a
    // symptom pointing nowhere near the cause.
    // A radius-proportional seat is deep enough that 0.4s of gravity and surface
    // friction cannot lift the hull clear, at every tier, so contact is a
    // CONSTANT of these tests and the thing under test is the gate.
    const setDown = (world, upOff = 0) => {
      // ONE PRIMING FRAME FIRST — the hull must be staged against LIVE state,
      // not worldgen's. Straight off freshRun the ship is still the factory
      // hull (entities.Ship radius 9) until update() snaps it to st.radius
      // (4 at tier 0), and a railed moon's generated vx/vy are one frame
      // stale against the rail that owns it from the first substep. Staged
      // against either, the 0.5-unit overlap below became a ~4.5-unit GAP one
      // frame later and the approach started AIRBORNE — the tests then passed
      // or failed on whether local gravity happened to re-land the hull
      // inside the assertion window, which is how a content-only world change
      // (PR #132's asteroidMass) broke four dock tests without touching the
      // moon, the ship or any dock code. stepSim is the suite's own
      // deterministic primitive, so repeatability only gains: it shifts the
      // draws columns once, it does not loosen them.
      hooks.stepSim(1 / 60);
      const s = game.ship;
      s.x = world.x + (world.radius + s.radius - Math.max(1.5, s.radius * 0.35));
      s.y = world.y;
      const sv = surfaceVel(world, s.x, s.y);
      s.vx = sv.vx; s.vy = sv.vy; s.spin = 0; s.alive = true;
      s.angle = upOff;                       // 0 = straight up off this contact point
      game.cam.x = s.x; game.cam.y = s.y;
      aimAt(upOff);
    };
    // HOLD IT DOWN while the gates are read, instead of seating it once and
    // hoping. Seating alone puts the hull just inside the surface and the
    // contact resolver immediately pushes it back out to exactly the boundary,
    // so whether any given substep sees CONTACT is a floating-point coin flip —
    // and contact is not one gate among three, it is the carrier for the other
    // two: `landing.gate` is recomputed and cleared every single updateDock
    // (only the LAST substep survives into game.dockGate), and the latch drains
    // at DOCK_DRAIN x off-surface, so a flickering contact both reports no gate
    // at all and can never fill. That is a fixture on a knife edge, not a test:
    // it passed on one exact trajectory and any unrelated change tipped it,
    // failing four docking tests with a symptom that pointed at the gate logic
    // rather than at the seating. Re-seating each substep is also the honest
    // model of the thing being tested — a pilot holds the ship against the
    // surface on thrust — and it stops at the berth, because from there the
    // clamps own the hull and that is exactly what the next tests check.
    const holdDown = (world, upOff, seconds) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        if (!game.dock) setDown(world, upOff);
        hooks.stepSim(1 / 60);
      }
    };
    // Put the ship well off the world and let the landing latch drain, so the
    // berth is genuinely lost rather than re-formed on the next substep.
    const liftClear = (world) => {
      const s = game.ship;
      const put = () => {
        s.x = world.x + 6000; s.y = world.y + 6000;
        s.vx = world.vx; s.vy = world.vy; s.spin = 0;
        game.cam.x = s.x; game.cam.y = s.y;
      };
      put();
      game.dock = null;
      hooks.stepSim(1);
      put();                          // gravity pulls it back over that second
      hooks.stepSim(1 / 60);
    };
    // radius >= 40: comfortably above config.dockHostOk's tier-0 line (~33) —
    // a moonlet offers no anchorage at all now, so the dock tests must stage
    // on a moon that can actually host one.
    const aWorld = () => game.bodies.find((b) => b.type === 'moon' && b.alive && b.radius >= 40);

    // T15 — the three gates, and that a berth actually forms
    t('dock: three gates latch a berth', () => {
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      const w = aWorld();
      // Attitude wrong (nose along the surface, well outside DOCK_ARC 1.0):
      // contact and stillness hold, so the refusal must be named as 'level'.
      holdDown(w, Math.PI / 2, 0.4);
      expect(!game.dock, 'berthed with the nose off the arc');
      // Contact first, gate second: if the staging itself ever comes unstuck
      // again, fail saying THAT — "gate was ''" reads as a dock bug when the
      // hull simply is not touching anything.
      expect(game.dockCand === w, 'staging lost contact — the hull is not on the moon at all');
      expect(game.dockGate === 'level', `refusing gate was "${game.dockGate}", wanted "level"`);
      // Now rockets down, held past DOCK_TIME.
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, `no berth after ${CFG.DOCK_TIME + 0.6}s of all three gates`);
      expect(game.dock.b === w, 'berthed to the wrong body');
      expect(game.docks.length === 1, `docks=${game.docks.length}, wanted 1`);
      return `gate refused as "level", then latched to ${w.name || 'a moon'}`;
    });

    // T16 — the build window gives NOTHING, and the finished station gives
    // immunity + DOCK_HEAL. Those ten exposed seconds ARE the price.
    t('dock: build window is unprotected, finished berth heals', () => {
      const s = game.ship;
      expect(game.dock && game.dock.t < 10, 'test needs a fresh, unfinished berth');
      // Zeroed defensively: damageShip spends the shield pool first, so any
      // pool at all would absorb the probe and read exactly like the immunity
      // this test is trying to prove is ABSENT. The suite's brawler build
      // carries none now (the shield is scout-only), but the earlier probes
      // borrow the scout's, and this must not depend on them cleaning up.
      s.shield = 0; game.godMode = false; s.invuln = 0;
      s.hull = game.st.hullMax * 0.5;
      const hurt0 = s.hull;
      damageShip(game, 40, 'test');
      expect(s.hull < hurt0, 'an unfinished dock granted immunity it has not earned');
      const mid = s.hull;
      hooks.stepSim(1);
      expect(s.hull <= mid + 0.001, `hull healed ${(s.hull - mid).toFixed(2)} during the build`);
      // Finish it by winding the STATION'S clock on rather than simulating ten
      // more seconds. The build timer is a plain accumulator on the dock and
      // what is under test is what a finished berth GIVES — and every second of
      // scripted sim is a second in which a stray rAF frame can consume the
      // suite's seeded RNG and cost the whole run its bit-repeatability.
      game.dock.t = CFG.DOCK_BUILD;
      hooks.stepSim(1 / 60);
      expect(game.dock && game.dock.t >= CFG.DOCK_BUILD, 'the build did not complete while berthed');
      s.shield = 0; s.invuln = 0;
      const before = s.hull;
      damageShip(game, 40, 'test');
      expect(s.hull >= before, 'a finished dock let damage through');
      hooks.stepSim(1);
      expect(s.hull > before, `no DOCK_HEAL at a finished berth (${before} -> ${s.hull})`);
      return `build: took damage, no heal; finished: immune, +${(s.hull - before).toFixed(1)} hull/s`;
    });

    // T17 — A DOCK IS WHERE YOU STOP WORKING. Both non-input-driven abilities
    // must be inert at a berth: Reflex Jink (issue #87/#90) and the parry
    // (#94). Neither is reachable by main.dockBlocking, so only this catches a
    // regression. The parry also must not leave a rock WELDED to the hull, and
    // its TELLS must go dark with it (#103) — an armed rail and a "you can take
    // this one" circlet over a field that has stood down read as a broken
    // ability, so the render gates and the sim gate are one predicate.
    t('dock: jink and parry are inert while berthed, tells included', () => {
      const s = game.ship;
      expect(game.dock, 'test needs a live berth');
      // Reflex Jink: grant it, then put a heavy rock on a collision course.
      game.prog.upgrades.autoEvade = 3;
      game.st = shipStats(game.prog);
      game.autoEvadeT = 0; s.invuln = 0;
      const rock = spawnAsteroid(game.bodies, s.x + 400, s.y, s.vx - 700, s.vy, 3000);
      hooks.stepSim(0.3);
      expect(game.autoEvadeT === 0, `Reflex Jink fired at a berth (cooldown ${game.autoEvadeT})`);
      rock.alive = false;
      // Parry: hand it a live session and require it to be STOOD DOWN, not
      // abandoned — an early return would pin the rock at the hull forever.
      const pr = spawnAsteroid(game.bodies, s.x + 20, s.y, s.vx, s.vy, 200);
      pr.rail = null; pr.onRails = false;
      pr.parryFrozen = true;
      game.parry = { t: 0, window: 0.5, rocks: [{ b: pr, nx: 1, ny: 0, hold: 20 }] };
      game.parryCd = 0;
      hooks.stepSim(1 / 60);
      expect(!game.parry, 'a parry session survived the clamps');
      expect(!pr.parryFrozen, 'a parried rock stayed WELDED to the hull at a berth');
      expect(game.parryCd === 0, `the parry spent its cooldown at a berth (${game.parryCd})`);
      // THE TELLS. `physics.parryLive` is what render.drawDeflectable and the
      // armed nose rail both gate on, so asserting it here covers the drawn
      // state without a canvas. Both directions: false with a rank and a clear
      // cooldown purely BECAUSE of the berth, true again the moment the berth
      // is gone — a predicate that is merely always-false would pass one half.
      //
      // PROBED AS A SCOUT — the same rule as the orbit-gate case, which probes
      // the ring as a HAULER. This comment used to say "the rank is read,
      // never granted: spec 0 is BRAWLER and the deflector is in its kit", and
      // that premise died with the loadout rework: the parry is SCOUT hardware
      // now, and a brawler can never earn the rank, so faking one onto the
      // brawler build would test a loadout that cannot exist (user design
      // call). Instead the build BECOMES a scout for the probe — the rank set
      // here is exactly what applySpec seeds a scout's kit with — and is put
      // back rank-and-spec together, so the next case inherits the untouched
      // brawler run.
      const wasSpec = game.prog.spec;
      const hadDeflector = game.prog.upgrades.deflector || 0;
      game.prog.spec = 'scout';
      game.prog.upgrades.deflector = Math.max(1, hadDeflector);
      game.st = shipStats(game.prog);
      expect(game.st.deflect > 0, 'setup: no deflector rank to advertise');
      expect(!parryLive(game),
        'the armed tell stayed lit at a berth — render advertises a parry that cannot fire');
      const dk = game.dock;                  // borrowed, not dropped: T18 needs this berth
      game.dock = null;
      const freeAgain = parryLive(game);
      game.dock = dk;
      expect(freeAgain, 'the parry read dead off the pad too — the tell would never come back');
      pr.alive = false;
      game.prog.spec = wasSpec;
      if (hadDeflector) game.prog.upgrades.deflector = hadDeflector;
      else delete game.prog.upgrades.deflector;
      game.st = shipStats(game.prog);
      return 'jink cooldown untouched, parry stood down and unfrozen, tells dark at the berth';
    });

    // T18 — LEAVING IS A SEQUENCE, and the station STANDS once built.
    t('dock: launch releases, and the station persists', () => {
      const s = game.ship;
      expect(game.dock, 'test needs a live berth');
      const station = game.dock;
      // The KEY, not game.controls — readControls rebuilds controls from
      // input.keys every frame, so a field poked here is gone within one step.
      // HELD IN A finally, not released mid-body: the `expect` between the two
      // steps throws, makeT catches it and carries on, and the key stayed down
      // — so T19b then ran with thrust held, the ship flew off the pad, and all
      // four of its dock assertions failed pointing at dock logic instead of at
      // a stuck key. Same convention as T23.
      input.keys.add('KeyW');
      try {
        hooks.stepSim(0.1);
        expect(game.launch, 'thrust at a berth did not start a launch sequence');
        hooks.stepSim(2.0);                       // > LAUNCH_TIME
      } finally {
        input.keys.delete('KeyW');
      }
      expect(!game.dock, 'still berthed after the launch sequence finished');
      expect(game.docks.includes(station), 'the station vanished when the ship left it');
      expect(station.t >= 10, 'the finished station lost its build progress');
      hooks.stepSim(0.5);
      return `launched; ${game.docks.length} station still standing at t=${Math.round(station.t)}s`;
    });

    // T18c — THE DOCK GROUND RULES (2026-08): a standing station AUTOLANDS a
    // hands-off return; blasting the ground under a station COLLAPSES it; the
    // same wound refuses a fresh berth ('crater'); and a world too small for
    // the ship class offers no anchorage at all ('small'). Each is exactly the
    // kind of rule main.dockBlocking can't see and only this suite guards.
    t('dock: autoland, ground collapse, crater + host-size gates', () => {
      const s = game.ship;
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      // A moon big enough to host tier 0 but NOT tier 5, so both host-size
      // verdicts in this test are structural rather than luck of the seed.
      const w = game.bodies.find((b) => b.type === 'moon' && b.alive
        && b.radius >= 40 && b.radius < 200);
      expect(w, 'no mid-size moon to stage on');
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'setup: no berth on clean ground');
      game.dock.t = CFG.DOCK_BUILD;          // wind the build on — see T16's note
      hooks.stepSim(1 / 60);
      // AUTOLAND: lift clear, then park hands-off inside the capture radius
      // with the nose deliberately off-axis. The pad must take the helm, fly
      // the approach and berth through the ordinary three gates — no input.
      liftClear(w);
      expect(!game.dock, 'setup: still berthed after lifting clear');
      const dk = game.docks[0];
      game.autolandCd = 0;
      const a = dk.ang + dk.b.rot;
      const pr = dk.b.radius * dk.rf;
      s.x = dk.b.x + Math.cos(a) * (pr + 300); s.y = dk.b.y + Math.sin(a) * (pr + 300);
      s.vx = dk.b.vx; s.vy = dk.b.vy; s.spin = 0; s.angle = a + 1.0;
      game.cam.x = s.x; game.cam.y = s.y;
      hooks.stepSim(0.2);
      expect(game.autoland === dk, 'a hands-off return inside the capture radius was not taken');
      hooks.stepSim(8);
      expect(game.dock === dk, 'the autoland never berthed the ship');
      // COLLAPSE: blast the ground under the standing station. The station
      // must break — before this rule it floated on its build-time standoff
      // over the hole (the pad knows only the NOMINAL radius).
      w.scars.push({ a: dk.ang, s: 2.5, t: game.time });
      hooks.stepSim(2 / 60);
      expect(!game.docks.includes(dk), 'a station survived losing its ground');
      expect(!game.dock, 'the berth survived the collapse');
      // CRATER GATE: a fresh landing ON THE WOUND ITSELF refuses, and names
      // itself. Seated against the CRATERED floor (scarSurfaceAt — the same
      // profile the collider reads), not the nominal radius: the wound is
      // deeper than setDown's seat, so a nominal seat would hover over the
      // hole with no contact and the test would pass for the wrong reason
      // (no gate at all instead of 'crater').
      {
        const scarA = w.scars[0].a;                    // ride the spin with it
        for (let t = 0; t < CFG.DOCK_TIME + 0.6; t += 1 / 60) {
          if (!game.dock) {
            const ang = scarA + w.rot;
            const surf = w.radius * scarSurfaceAt(w.scars, w.radius, scarA);
            const d = surf + s.radius - Math.max(1.5, s.radius * 0.35);
            s.x = w.x + Math.cos(ang) * d; s.y = w.y + Math.sin(ang) * d;
            const sv = surfaceVel(w, s.x, s.y);
            s.vx = sv.vx; s.vy = sv.vy; s.spin = 0;
            s.angle = ang;                             // rockets down on the radial
            game.cam.x = s.x; game.cam.y = s.y;
          }
          hooks.stepSim(1 / 60);
        }
      }
      expect(!game.dock, 'berthed inside a crater');
      expect(game.dockGate === 'crater', `refusing gate was "${game.dockGate}", wanted "crater"`);
      w.scars.length = 0;
      // HOST SIZE: the same clean moon refuses a tier-5 hull outright —
      // config.dockHostOk, the line the refit sweep also decommissions across.
      // Restored spec-and-tier together below; T19b then does its own freshRun.
      const wasTier = game.prog.tier;
      game.prog.tier = 5;
      game.st = shipStats(game.prog);
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(!game.dock, 'a titan berthed on a world too small for its class');
      expect(game.dockGate === 'small', `refusing gate was "${game.dockGate}", wanted "small"`);
      game.prog.tier = wasTier;
      game.st = shipStats(game.prog);
      return `autoland berthed at ${Math.round(pr + 300)}u out; collapse, crater and host-size gates all hold`;
    });

    // T18d — THE AUTOLAND FLIES A STRAIGHT LINE, so it must only take a ship
    // that HAS one. Parked on the far side of the pad's own world, inside the
    // capture radius and perfectly hands-off, it must refuse — engaging there
    // would drive the ship through the world it is trying to land on.
    t('dock: autoland refuses a blocked approach', () => {
      const s = game.ship;
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      // Small enough that the far side is INSIDE CFG.AUTOLAND_R — otherwise the
      // distance gate would refuse first and this would pass for the wrong
      // reason, proving nothing about line of sight.
      const w = game.bodies.find((b) => b.type === 'moon' && b.alive
        && b.radius >= 40 && b.radius * 2 + 60 < CFG.AUTOLAND_R);
      expect(w, `no moon small enough for the far side to sit inside AUTOLAND_R ${CFG.AUTOLAND_R}`);
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'setup: no berth');
      game.dock.t = CFG.DOCK_BUILD;
      hooks.stepSim(1 / 60);
      const dk = game.docks[0];
      liftClear(w);
      game.autolandCd = 0;
      // THE FAR SIDE: same distance band as T18c's successful capture, but with
      // the whole moon in the way.
      const a = dk.ang + dk.b.rot + Math.PI;
      const out = dk.b.radius + 40;
      s.x = dk.b.x + Math.cos(a) * out; s.y = dk.b.y + Math.sin(a) * out;
      s.vx = dk.b.vx; s.vy = dk.b.vy; s.spin = 0; s.angle = a;
      game.cam.x = s.x; game.cam.y = s.y;
      const pp = padPos(dk);
      const gap = Math.hypot(pp.x - s.x, pp.y - s.y);
      expect(gap < CFG.AUTOLAND_R,
        `staging put the pad ${Math.round(gap)}u away, outside AUTOLAND_R ${CFG.AUTOLAND_R} — the distance gate would refuse first`);
      hooks.stepSim(0.3);
      expect(!game.autoland, 'the autoland engaged straight through the world it is standing on');
      return `refused a pad ${Math.round(gap)}u away with ${Math.round(w.radius)}u of moon in the way`;
    });

    // T18e — THE DOME IS FINITE, NEVER REFILLS, AND ITS DEATH IS THE STATION'S.
    // A berth used to be total immunity; it is a pool now (CFG.DOCK_SHIELD).
    // Three things have to hold together or the feature is a lie: damage lands
    // on the POOL and not the hull, the pool does NOT come back, and the
    // overflow of the killing blow reaches the hull on that SAME call (the
    // ram's own no-free-frame rule).
    t('dock: the dome is a finite pool and takes the station with it', () => {
      const s = game.ship;
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      const w = game.bodies.find((b) => b.type === 'moon' && b.alive
        && b.radius >= 40 && b.radius < 200);
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'setup: no berth');
      const dk = game.dock;
      expect(dk.hp === CFG.DOCK_SHIELD, `a fresh station carries hp ${dk.hp}, wanted ${CFG.DOCK_SHIELD}`);
      dk.t = CFG.DOCK_BUILD;
      hooks.stepSim(1 / 60);
      s.shield = 0; s.invuln = 0; game.godMode = false;
      s.hull = game.st.hullMax;
      const hull0 = s.hull;
      damageShip(game, 40, 'test');
      expect(s.hull === hull0, `the dome let ${(hull0 - s.hull).toFixed(1)} through to the hull`);
      expect(Math.abs(dk.hp - (CFG.DOCK_SHIELD - 40)) < 0.001,
        `the dome absorbed but banked ${dk.hp}, wanted ${CFG.DOCK_SHIELD - 40}`);
      // NO RECHARGE — not over time, not at a berth. A full second of berthed
      // sim must leave the pool exactly where the hit left it.
      const spent = dk.hp;
      hooks.stepSim(1);
      expect(dk.hp <= spent + 0.001, `the dome recharged ${(dk.hp - spent).toFixed(2)} in a second`);
      // THE KILLING BLOW: 10 left, 60 arrives. The dome eats 10, dies, takes the
      // station with it, and the remaining 50 lands on the hull NOW.
      dk.hp = 10;
      s.hull = game.st.hullMax;
      const before = s.hull;
      damageShip(game, 60, 'test');
      expect(!game.docks.includes(dk), 'the station survived its dome collapsing');
      expect(!game.dock, 'still berthed at a station that no longer exists');
      const through = before - s.hull;
      expect(Math.abs(through - 50) < 0.001,
        `the hull took ${through.toFixed(1)} of the 60-point blow, wanted the 50 the dome could not cover`);
      return `pool ${CFG.DOCK_SHIELD}, no recharge, collapse passed 50 of 60 straight through`;
    });

    // T18f — A COLLAPSED DOME IS A LOSS, NOT AN INTERRUPTION. The landing latch
    // is module scratch that outlives the station it filled, so a dome breaking
    // under a berthed ship used to lay a FRESH site on the same spot on the
    // very next substep — a brand-new CFG.DOCK_SHIELD pool for a player who
    // never left the ground, which is the opposite of "a place you can lose".
    // Clearing the latch alone would only have delayed that by DOCK_TIME
    // (0.5s), so the site is EVICTED until the hull actually leaves. Both
    // halves are asserted: no rebuild in the rubble, AND the honest rebuild
    // after leaving and coming back still works — that one is sanctioned, and
    // it still costs the full DOCK_BUILD exposed.
    t('dock: a collapsed station cannot rebuild under the ship', () => {
      const s = game.ship;
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      const w = game.bodies.find((b) => b.type === 'moon' && b.alive
        && b.radius >= 40 && b.radius < 200);
      expect(w, 'no mid-size moon to stage on');
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'setup: no berth');
      const dk = game.dock;
      dk.t = CFG.DOCK_BUILD;                 // wind the build on — see T16's note
      hooks.stepSim(1 / 60);
      s.shield = 0; s.invuln = 0; game.godMode = false;
      s.hull = game.st.hullMax;
      dk.hp = 5;                             // one blow from the dome's death
      damageShip(game, 20, 'test');
      expect(!game.docks.includes(dk), 'setup: the dome survived a killing blow');
      expect(!game.dock, 'setup: still berthed after the collapse');
      // STILL ON THE GROUND, every gate held, for three times DOCK_TIME. The
      // ship never lifts — so nothing may be built here.
      holdDown(w, 0, CFG.DOCK_TIME + 1.0);
      expect(game.docks.length === 0,
        `${game.docks.length} station(s) rebuilt in their own rubble without the ship ever leaving`);
      expect(!game.dock, 'berthed at a station rebuilt in its own rubble');
      // …and it SAYS SO. A latch that fills and then silently declines to lay a
      // station is this feature's worst failure mode (drawDockGuide's rule).
      expect(game.dockGate === 'rubble', `refusing gate was "${game.dockGate}", wanted "rubble"`);
      // A BOUNCE IS NOT A DEPARTURE — and this is the case that matters, not
      // the quiet hold above. A dome only ever dies while the ground and the
      // hull are being hit, so contact breaking for a frame or two (debris off
      // the collapse, the next shot landing, a scar opening under the pad) is
      // the COMMON case there. holdDown re-seats the hull every substep, so it
      // can only ever exercise perfect contact; this lifts the ship clear for
      // one frame at a time — well inside the DOCK_TIME/DOCK_DRAIN grace a
      // BERTH itself survives — and the eviction has to survive it too, or the
      // rebuild comes back for 16ms of air.
      const hop = () => {
        const a = Math.atan2(s.y - w.y, s.x - w.x);
        const off = w.radius + s.radius + 30;          // clear of contact, barely
        s.x = w.x + Math.cos(a) * off; s.y = w.y + Math.sin(a) * off;
        const sv = surfaceVel(w, s.x, s.y);
        s.vx = sv.vx; s.vy = sv.vy; s.spin = 0;
        game.cam.x = s.x; game.cam.y = s.y;
        hooks.stepSim(1 / 60);
      };
      for (let i = 0; i < 3; i++) { hop(); holdDown(w, 0, CFG.DOCK_TIME + 0.4); }
      expect(game.docks.length === 0,
        `${game.docks.length} station(s) rebuilt after a momentary bounce — a frame off the surface is not a departure`);
      expect(!game.dock, 'a bounce off the rubble handed the berth back');
      // THE LEGITIMATE REBUILD: leave, come back, build again — a NEW station
      // with a full pool and a build clock that starts at zero.
      liftClear(w);
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'a rebuild after genuinely lifting clear was refused too — the eviction never lifts');
      expect(game.dock.hp === CFG.DOCK_SHIELD,
        `the rebuilt station carries hp ${game.dock.hp}, wanted a fresh ${CFG.DOCK_SHIELD}`);
      expect(game.dock.t < CFG.DOCK_BUILD, 'the rebuilt station arrived already finished');
      return 'no rebuild in the rubble, bounces included; rebuild after lifting clear still pays DOCK_BUILD';
    });

    // T18g — THE AUTOLAND MUST NOT CAPTURE A SHIP THAT IS WORKING. `handsOn`
    // only sees the THROTTLE, but the beam, the winch and the ring are all
    // mouse-driven — so mining the world your own pad is on, from inside
    // AUTOLAND_R, reads as a hands-off return. The berth then calls standDown
    // and the whole load is dropped for nothing. Both directions, because a
    // gate that merely never engages would pass the first half.
    t('dock: autoland refuses a ship with a load in the beam', () => {
      const s = game.ship;
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      const w = game.bodies.find((b) => b.type === 'moon' && b.alive
        && b.radius >= 40 && b.radius < 200);
      expect(w, 'no mid-size moon to stage on');
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'setup: no berth');
      game.dock.t = CFG.DOCK_BUILD;          // wind the build on — see T16's note
      hooks.stepSim(1 / 60);
      const dk = game.docks[0];
      liftClear(w);
      game.autolandCd = 0;
      // The SAME park T18c is captured from — hands off, slow, well inside the
      // capture radius — so the only difference between the two halves below is
      // what the ship is carrying.
      const park = () => {
        const a = dk.ang + dk.b.rot;
        const pr = dk.b.radius * dk.rf;
        s.x = dk.b.x + Math.cos(a) * (pr + 300); s.y = dk.b.y + Math.sin(a) * (pr + 300);
        s.vx = dk.b.vx; s.vy = dk.b.vy; s.spin = 0; s.angle = a + 1.0;
        game.cam.x = s.x; game.cam.y = s.y;
      };
      park();
      const r = spawnAsteroid(game.bodies, s.x + 60, s.y, s.vx, s.vy, 100);
      game.aim.x = r.x; game.aim.y = r.y;
      expect(tryGrab(game) === 'held', 'setup: the staged rock was not taken by the beam');
      hooks.stepSim(0.3);
      expect(!game.autoland, 'the pad took the helm off a ship with a rock in the beam');
      expect(!game.dock, 'a working ship was berthed by the autoland');
      expect(game.held === r, 'the load was dropped without a berth ever forming');
      // DROP IT (never a throw — this is not what T3 is about). THE BRAWLER'S
      // WHOLE WORK LOOP is the line after: right mouse held, sweeping rock into
      // the ram. It populates neither the beam, the winch nor the ring (this
      // spec's maxOrbiters is 0), so it is invisible to every other term in the
      // gate — and a berth would disarm the button the player is still holding.
      releaseHeld(game, false);
      r.alive = false;
      park();
      // ZEROED FIRST, or this probes nothing: the phase above stood the pad
      // down, and a leftover cooldown refuses the capture on its own — the
      // sweep would then read as protected whether or not the gate has ever
      // heard of it. (Measured: without this the case passes with the ram term
      // deleted outright.)
      game.autolandCd = 0;
      game.ramEating = true;                 // exactly what main.js sets on RMB-down
      hooks.stepSim(0.3);
      expect(!game.autoland, 'the pad took the helm off a brawler mid ram-sweep');
      game.ramEating = false;
      // …AND WORKING STANDS THE PAD DOWN FOR AUTOLAND_CD — the launch's own
      // price, and for the same reason. Mining is a cycle whose gaps are
      // fractions of a second, so a bare refusal would let the pad dart in
      // between every release and the next grab: nose dragged round, guide
      // blinking, never finishing.
      expect(game.autolandCd > 0, 'working never stood the pad down — it would tug in every mining gap');
      park();
      hooks.stepSim(0.3);
      expect(!game.autoland, 'the pad engaged inside its own stand-down');
      // …and once that runs out the IDENTICAL park is taken, so none of the
      // above can be passing merely because the autoland never engages at all.
      for (let i = 0; i < 15 && !game.autoland; i++) { park(); hooks.stepSim(0.3); }
      expect(game.autoland === dk, 'a genuinely hands-off, empty-handed return was never taken');
      return `refused a load and a ram sweep, stood down ${CFG.AUTOLAND_CD}s, then took the identical park`;
    });

    // T19b — "Limped In" must mean what it says. The arm is set at a berth
    // under 15% hull and only pays on a repair to FULL *there*; healing to full
    // anywhere else (a glow pocket) has to cancel it, or berthing later for any
    // unrelated reason scores a save on the first frame.
    t('dock: a save needs the repair to happen AT the dock', () => {
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      const s = game.ship, st = game.prog.ach.stats;
      const w = aWorld();
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock, 'setup: no berth');
      // The save bookkeeping only runs at a FINISHED station — the whole block
      // sits behind `dk.t >= DOCK_BUILD` — so the build has to complete first.
      game.dock.t = CFG.DOCK_BUILD;          // wind the build on — see T16's note
      hooks.stepSim(1 / 60);
      expect(game.dock && game.dock.t >= CFG.DOCK_BUILD, 'setup: the build never finished');
      st.dockSaves = 0; st.dockHurt = 0; st.dockHurtHull = undefined;
      s.shield = 0; s.invuln = 0;
      s.hull = game.st.hullMax * 0.10;
      hooks.stepSim(0.2);
      expect(st.dockHurt === 1, 'limping in under 15% did not arm the save');
      // GENUINELY off the pad, then healed to full elsewhere. Clearing
      // game.dock alone is not leaving: the hull is still touching and the
      // landing latch is still full, so updateDock re-berths within one
      // substep and the off-pad branch never gets a frame to run.
      liftClear(w);
      expect(!game.dock, 'setup: still berthed after lifting clear');
      s.hull = game.st.hullMax;
      hooks.stepSim(0.2);
      expect(!st.dockHurt, 'the arm survived a repair that happened away from the dock');
      expect((st.dockSaves || 0) === 0, 'a save scored for a repair that never happened at a dock');
      // …and the genuine article still pays: limp in, repair AT the berth.
      // Re-berths at the station just built, so this costs no second build.
      holdDown(w, 0, CFG.DOCK_TIME + 0.6);
      expect(game.dock && game.dock.t >= CFG.DOCK_BUILD, 'setup: no re-berth at the built station');
      st.dockHurt = 0; st.dockHurtHull = undefined; st.dockSaves = 0;
      s.hull = game.st.hullMax * 0.10;
      hooks.stepSim(0.2);
      expect(st.dockHurt === 1, 'setup: not armed on the re-berth');
      // Let the dock do the last of the repair itself — the point is that the
      // heal happened HERE, not how many seconds it took.
      s.hull = game.st.hullMax - CFG.DOCK_HEAL * 0.5;
      for (let i = 0; i < 8 && !(st.dockSaves > 0); i++) hooks.stepSim(0.5);
      expect((st.dockSaves || 0) === 1,
        `a genuine limp-in-and-repair scored ${st.dockSaves || 0} saves, wanted 1`);
      return 'off-pad heal cancels the arm; an at-berth repair still scores';
    });

    // ---- SOLAR WAVE CLASSES (PR #79) ---------------------------------------
    // T20 — a wave's REACH is its geography, and its taper is what stops it
    // being a hard edge. All pure functions of the class row, so this asserts
    // the geography directly rather than flying a wave across the sky.
    t('storm: three classes, graded reach and a real taper', () => {
      const cs = CFG.STORM_CLASSES;
      expect(cs.length === 3, `expected 3 storm classes, got ${cs.length}`);
      const R = CFG.WORLD_R;
      const seen = [];
      for (const c of cs) {
        expect(c.fade < 1, `${c.key}: fade ${c.fade} >= 1 collapses the taper — at 1 the wave blinks out at a hard radius, above 1 stormStrength returns k > 1`);
        const reachR = R * c.reach, fadeR = reachR * c.fade;
        expect(stormStrength({ ...c, r: fadeR }) === 1, `${c.key}: not full strength at its fade radius`);
        expect(stormStrength({ ...c, r: reachR }) === 0, `${c.key}: still biting at its reach limit`);
        const mid = stormStrength({ ...c, r: fadeR + (reachR - fadeR) / 2 });
        expect(mid > 0.3 && mid < 0.7, `${c.key}: taper is not gradual (mid=${mid.toFixed(2)})`);
        expect(!stormSpent({ ...c, r: reachR * 0.99 }), `${c.key}: spent before reaching its limit`);
        expect(stormSpent({ ...c, r: reachR * 1.01 }), `${c.key}: never expires past its limit`);
        seen.push(Math.round(reachR));
      }
      // Graded: squall stays inner-system, cme crosses the whole sky.
      expect(seen[0] < seen[1] && seen[1] < seen[2], `reaches not graded: ${seen.join(' < ')}`);
      expect(seen[0] < R, 'the squall reaches the world edge — it is meant to be inner-system only');
      expect(seen[2] > R, 'the cme does not cross the whole sky');
      // Only the big two blind alien senses.
      expect(!cs[0].blind && cs[1].blind && cs[2].blind, 'the blind flags are not squall-off / surge-on / cme-on');
      return `reaches ${seen.join(' / ')} vs WORLD_R ${Math.round(R)}`;
    });

    // T21 — EVERY MOON SHELTERS. STORM_SHADOW_MIN_R was 60 and silently failed
    // 40 of the 59 moons; it is 24 now. This is the assertion that would have
    // caught that, so it counts real moons rather than trusting the constant.
    t('storm: every moon casts a lee', () => {
      const moons = game.bodies.filter((b) => b.type === 'moon' && b.alive);
      expect(moons.length > 0, 'no moons to check');
      const dark = moons.filter((b) => b.radius < CFG.STORM_SHADOW_MIN_R);
      // The RING SHEPHERD MOONLET is the one documented exception (see the
      // shelterBody note in main.js) — it is a chip of a thing holding a ring
      // gap open, not a place you duck behind. Everything else must shelter,
      // and the count is what matters: the floor was 60 and quietly failed 40
      // of 59, which is exactly the shape of regression this catches.
      const unexpected = dark.filter((b) => !b.shepherd);
      expect(unexpected.length === 0,
        `${unexpected.length}/${moons.length} moons besides the shepherd are under `
        + `STORM_SHADOW_MIN_R ${CFG.STORM_SHADOW_MIN_R} and cast no lee `
        + `(radii ${unexpected.map((b) => b.radius.toFixed(1)).join(', ')})`);
      // The flat pad is what makes a small moon's lee a pocket, not a razor
      // edge — and the pad is measured in SHIP-widths (a TITAN must fit in the
      // slot the radius multiple alone would not leave), so the assertion is
      // lee minus moon against the biggest hull, NOT a multiple of the moon's
      // own radius. The old `> 2x radius` form was that multiple, calibrated
      // when the smallest moon was ~25 units; the 2026-08 moon growth made it
      // fail on moons whose lee is proportionally MORE generous than ever.
      const small = moons.filter((b) => !b.shepherd)
        .reduce((a, b) => (b.radius < a.radius ? b : a));
      expect(shelterR(small) - small.radius > SHIP_RADIUS[5],
        `a small moon's lee (${shelterR(small).toFixed(1)}) leaves only `
        + `${(shelterR(small) - small.radius).toFixed(1)} over the moon (${small.radius.toFixed(1)}) `
        + `— a TITAN (${SHIP_RADIUS[5]}) does not fit; the flat pad is missing`);
      return `${moons.length - dark.length}/${moons.length} moons shelter `
        + `(${dark.length} shepherd exempt); smallest r=${small.radius.toFixed(1)}, lee=${shelterR(small).toFixed(1)}`;
    });

    // ---- DEFLECTOR AIM (PR #81) --------------------------------------------
    // T22 — the riposte leaves along ship->cursor, not back along the rock's
    // own capture bearing. That direction IS the feature; nothing else asserts it.
    t('parry: the riposte flies at the cursor', () => {
      // Spec 2 = SCOUT, whose kit carries the Deflector — the rank comes from
      // applySpec like any real run's, never granted by the test (user design
      // rule: a build the game cannot produce proves nothing). T23 after this
      // stages its own fresh brawler, so leaving a scout run behind is fine.
      hooks.freshRun(2, seed);
      const s = game.ship;
      parkShip(game, s.x, s.y);
      game.dock = null; game.docks = [];
      const rank = game.st.deflect;
      expect(rank > 0, 'the scout kit did not seed a deflector rank');
      // Rock captured on the +x bearing; cursor put at 90 degrees to it, so a
      // riposte along the capture bearing and one along the aim are 90 apart
      // and cannot be confused.
      const b = spawnAsteroid(game.bodies, s.x + 30, s.y, s.vx, s.vy, 200);
      b.rail = null; b.onRails = false; b.parryFrozen = true;
      game.parry = { t: 0, window: game.st.deflectWindow, rocks: [{ b, nx: 1, ny: 0, hold: 30 }] };
      game.parryCd = 0;
      aimAt(-Math.PI / 2);                       // screen-up = world -y
      hooks.stepSim(game.st.deflectWindow + 0.1);
      expect(!game.parry, 'the parry window never closed');
      expect(!b.parryFrozen, 'the rock stayed frozen after the window');
      const vx = b.vx - s.vx, vy = b.vy - s.vy;   // the launch is ship-relative
      const sp = Math.hypot(vx, vy);
      expect(sp > 1, 'the riposte launched with no speed');
      expect(vy < 0 && Math.abs(vx) < Math.abs(vy),
        `riposte went (${vx.toFixed(0)}, ${vy.toFixed(0)}) — not along the cursor`);
      expect(b.thrownBy === 'player', 'the riposte is not credited as your shot');
      return `rank ${rank}, launched at ${Math.round(sp)} u/s toward the cursor`;
    });

    // ---- PILOT CARD (PR #82) ------------------------------------------------
    // T23 — the inline offer, answered through the REAL UI paths. Everything
    // else in this suite runs with `autoUpgrade` on, so `applyPick` is only
    // ever reached by the headless resolve: until this case, neither the digit
    // keys, nor the #offerBox click delegate, nor the guard that stops a digit
    // spending a pick into a paused run was touched by anything at all.
    //
    // THIS CASE IS WHY sfx.js AND music.js DRAW FROM THEIR OWN STREAMS. A real
    // keydown brings the AudioContext up (input.js calls initAudio on ANY key),
    // and sfx's synth fallback burns ~29,000 draws per noiseSweep in the window
    // where a context exists but the samples have not decoded — three different
    // draw counts for the same gameplay, chosen by a user gesture and a fetch.
    // On the shared stream that moved a later pick onto a different ability and
    // the suite stopped being repeatable, which is why this case was written,
    // reverted once, and only now lands. If it ever drifts again, do NOT delete
    // it: check first that nothing new has started drawing gameplay randoms off
    // an initialise-once capability, and read the `draws` column to find where.
    t('pilot card: keydown, click, and the paused-run guard', () => {
      hooks.freshRun(0, seed);
      // This case turns OFF the auto-resolver the whole suite runs under and
      // synthesises a keydown with no matching keyup, so its cleanup belongs in
      // a finally, not mid-body: makeT catches and continues, and a failed
      // assertion halfway down would otherwise hand the NEXT test a run with
      // picks unresolved and Digit1 still held.
      game.autoUpgrade = false;
      try {
        const offer = () => {
          game.flingDelayT = 0;   // the post-fling deferral is T5's subject, not this one
          game.prog.xp = xpForPick(game.prog) + 1;
          hooks.stepSim(0.2);
        };
        const digit = (code) =>
          window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));

        offer();
        expect(game.upgradeChoices && game.upgradeChoices.length >= 2,
          'no inline offer stood up with autoUpgrade off');
        expect(!game.choosingUpgrade,
          'an ability offer froze the sim — only the spec card is a modal');

        // The markup the delegate reads. It routes off `data-i`, so a card that
        // lost its index is a dead card that silently swallows the click.
        updateHud(game);
        const rows = [...document.querySelectorAll('#offerBox .ofrow')];
        expect(rows.length === game.upgradeChoices.length,
          `offer drew ${rows.length} cards for ${game.upgradeChoices.length} choices`);
        expect(rows.every((r, i) => +r.dataset.i === i), 'offer card data-i is not 0..n-1');
        expect(rows[0].textContent.includes(game.upgradeChoices[0].name),
          'the drawn card does not name the choice it stands for');

        // GUARD: the digits are a WINDOW listener and fire whatever is on screen,
        // so a pick must not be spendable into a paused run.
        const want0 = game.upgradeChoices[0].id;
        game.paused = true;
        digit('Digit1');
        game.paused = false;
        expect(game.upgradeChoices, 'a digit spent the pick while the run was paused');
        expect(!game.prog.upgrades[want0], `paused Digit1 still granted ${want0}`);

        // KEYDOWN answers it...
        digit('Digit1');
        input.keys.delete('Digit1');   // no keyup is dispatched; do not leave it held
        expect(!game.upgradeChoices, 'the offer survived the keypress');
        expect(game.prog.upgrades[want0] >= 1, `Digit1 did not grant ${want0}`);
        // ...and an answered INLINE offer holds the next card back, so it cannot
        // land under a finger still on the button (the flingDelayT reuse).
        expect(game.flingDelayT >= 0.8, 'answering an inline offer armed no deferral');

        // CLICK answers the next one, through the delegate rather than the key.
        offer();
        expect(game.upgradeChoices && game.upgradeChoices.length >= 2,
          'no second offer to answer by mouse');
        const want1 = game.upgradeChoices[1].id;
        updateHud(game);
        const row1 = document.querySelector('#offerBox .ofrow[data-i="1"]');
        expect(row1, 'the second offer drew no card at data-i=1');
        row1.click();
        expect(!game.upgradeChoices, 'the offer survived the click');
        expect(game.prog.upgrades[want1] >= 1, `the click did not grant ${want1}`);

        return `key -> ${want0}, click -> ${want1}, paused digit refused`;
      } finally {
        game.autoUpgrade = true;
        input.keys.delete('Digit1');
      }
    });

    // ---- ALIEN AVOIDANCE ----------------------------------------------------
    // T24 — ai.avoidWorlds casts its look-ahead in the WORLD'S OWN FRAME, the
    // same law as util.surfaceVel's and for the same reason: worlds ORBIT. The
    // moons in this sky carry 33-95 u/s and the planets 41-130, so a ray aimed
    // at where a world is NOW arrives 50-200 units behind it over the function's
    // 1.6s horizon — as much as its whole `clear` band for a moon.
    //
    // The rig makes that error a SIGN, not a magnitude, so it cannot pass by
    // luck. A golem flies at 350 u/s straight down the normal to a moon's own
    // track, aimed 40 units to the LEADING side of its centre. Read absolutely
    // that is a near dead-on hit passing AHEAD of the moon, so the old whisker
    // veered forward, +u, INTO the path of the thing it was dodging — precisely
    // the moon-pancaking the function exists to stop. Read in the moon's frame
    // the alien passes behind it (the moon has moved on by then), so the only
    // correct veer is aft, -u. Measured: +87 u/s^2 forward before the fix, -92
    // aft after it.
    //
    // Everything else is arranged to contribute exactly zero along u, so the
    // whisker is the only thing the assertion can be reading: the moon is the
    // most isolated in the sky (asserted — no other world is within its own
    // avoidance reach of the alien, and the star is far outside avoidStars' shell),
    // the alien sits OUTSIDE the surface push's band so the radial term is zero
    // (asserted), and the ship is parked 1200 back along -v, which puts steer()
    // purely on v and is beyond the 700 at which the landed-ship exemption
    // could switch avoidance off altogether.
    t('alien avoidance: the whisker is cast in the world\'s own frame', () => {
      hooks.freshRun(0, seed);
      const nAliens = game.aliens.length;
      let al = null;
      try {
        // The most isolated moon that is actually MOVING — a slow one would
        // make the two frames agree and the case would prove nothing.
        const worlds = game.bodies.filter((b) => b.alive && (b.type === 'planet' || b.type === 'moon'));
        let m = null, iso = -1;
        for (const c of worlds) {
          if (c.type !== 'moon' || Math.hypot(c.vx, c.vy) < 60) continue;
          let near = Infinity;
          for (const b of worlds) {
            if (b === c) continue;
            near = Math.min(near, Math.hypot(b.x - c.x, b.y - c.y) - b.radius);
          }
          if (near > iso) { iso = near; m = c; }
        }
        expect(m, 'no moon in this sky is moving fast enough to tell the two frames apart');

        const R = 350;    // the alien's closing speed, under steer()'s own clamp
        const E = 40;     // aimed this far to the moon's LEADING side of centre
        const K = 1200;   // ship stand-off: > 700, so the attack-run exemption is off
        // One frame first, so physics has rebuilt the awake list avoidWorlds
        // walks — with the ship already in the neighbourhood, or the moon is
        // dormant and the function never looks at it at all.
        parkShip(game, m.x, m.y - 2000);
        hooks.stepSim(1 / 60);

        const W = Math.hypot(m.vx, m.vy);
        const ux = m.vx / W, uy = m.vy / W;          // the moon's own heading
        const vx = -uy, vy = ux;                     // and its normal
        al = new Alien(0, 0, 'golem');
        const clear = m.radius + al.radius + 90;
        const D = clear + 150;                       // outside the surface push's band
        al.x = m.x + vx * D + ux * E;
        al.y = m.y + vy * D + uy * E;
        al.vx = -R * vx; al.vy = -R * vy;            // straight in at the moon
        parkShip(game, al.x - vx * K, al.y - vy * K);
        game.aliens.push(al);

        // Setup gates: nothing but the whisker may be pushing along u.
        const d = Math.hypot(m.x - al.x, m.y - al.y);
        expect(d > clear + 120,
          `the alien is inside the surface push's band (${d.toFixed(0)} < ${(clear + 120).toFixed(0)}) — that radial term would swamp the whisker`);
        const star = game.bodies.find((b) => b.alive && b.type === 'star');
        expect(Math.hypot(al.x - star.x, al.y - star.y) > star.radius * 1.6 + 400,
          'the rig sits inside avoidStars\' shell — its push would land on u too');
        for (const b of worlds) {
          if (b === m) continue;
          const reach = b.radius + al.radius + 90 + 120 + (R + Math.hypot(b.vx, b.vy)) * 1.6;
          expect(Math.hypot(b.x - al.x, b.y - al.y) > reach,
            `${b.type} ${b.name || b.id} is inside its own avoidance reach of the rig — it would contribute too`);
        }
        // steer() clamps thrustX and thrustY INDEPENDENTLY, in WORLD axes — so
        // it only stays off u while its unclamped magnitude fits inside
        // ALIEN_ACCEL. Let that margin close (a bump to ALIEN_SPEED, to the
        // golem's 0.85, to ALIEN_ACCEL, or to R here) and the clamp rotates the
        // steer vector toward the world diagonal and spills ~15 u/s^2 of either
        // sign onto u — small against the -92 measured, but it would quietly
        // stop being true that the whisker is the ONLY thing this reads.
        expect(Math.abs(R - CFG.ALIEN_SPEED * 0.85) * 2.2 < CFG.ALIEN_ACCEL,
          `steer() clamps at this R (${R} vs golem cruise ${(CFG.ALIEN_SPEED * 0.85).toFixed(0)}, `
          + `accel ${CFG.ALIEN_ACCEL}) — its residual would land on u and pollute the reading`);
        // The wake list avoidWorlds walks was built by the step above, from the
        // ship's position THEN. It comfortably covers the moon today, but a
        // dormant `m` would read as a zero veer — i.e. this case would fail
        // claiming the whisker went the wrong way when the truth is it never
        // looked. Name that failure instead of inheriting it.
        expect((game.bodies._awake || game.bodies).includes(m),
          'the moon is not on the awake list — avoidWorlds never sees it, and a zero veer would misreport as a wrong one');

        updateAliens(game, 1 / 60);
        const along = al.thrustX * ux + al.thrustY * uy;
        expect(along < -20,
          `the veer went ${along.toFixed(0)} u/s^2 along the moon's own heading — a positive value steers the alien `
          + `into the path of a moon moving at ${W.toFixed(0)} u/s, which is the absolute-frame whisker aiming at where the moon USED to be`);
        return `${m.name || 'moon'} at ${W.toFixed(0)} u/s, alien ${d.toFixed(0)} out (clear ${clear.toFixed(0)}): veer ${along.toFixed(0)} u/s^2 aft`;
      } finally {
        if (al) al.alive = false;
        game.aliens.length = nAliens;
      }
    });

    // T25 — THE HARNESS VIEW IS PINNED, so the report cannot depend on the
    // window it ran in (issue #104). Everything above this line integrates
    // through game.viewR — the spawn ring and both leashes in
    // world.replenishWorld, the wake bubble, the glow field — and steers
    // through cam.zoom (the parked cursor becomes game.aim every frame). Both
    // derive from the view size. Today the fair view cancels the window out of
    // viewR exactly — measured identical across a 2x window range — so this
    // case guards a LATENT dependency, not a live bug: it fails the moment
    // something stops routing the sim's view through simView().
    // Asserted with === on purpose: at VIEW_PIN the fair-view ratio is exactly
    // 1, so cam.zoom is EXACTLY zoomCur and viewR exactly VIEW_REF_DIAG/2/
    // zoomCur — an unpinned run only lands there if the real window happens to
    // be 1920x1080. Takes no step of its own, so it disturbs nothing
    // downstream: it reads the view the last stepSim above left behind.
    t('harness view is pinned', () => {
      expect(game.viewPin === VIEW_PIN, 'the view pin is not in force');
      expect(game.cam.zoom === game.zoomCur,
        `cam.zoom ${game.cam.zoom} != zoomCur ${game.zoomCur} — the sim is reading the real window`);
      const want = CFG.VIEW_REF_DIAG / 2 / game.zoomCur;
      expect(game.viewR === want, `viewR ${game.viewR} != ${want}`);
      return `${VIEW_PIN.vw}x${VIEW_PIN.vh}, zoom=${game.cam.zoom.toFixed(4)}, viewR=${game.viewR.toFixed(1)}`;
    });

    // T26 — the suite's own drama must not have shredded the sky
    t('sky intact after suite', () => {
      const now = census(game);
      expect((now.planet || 0) === (skyBefore.planet || 0),
        `planets ${skyBefore.planet} -> ${now.planet}`);
      expect((now.moon || 0) === (skyBefore.moon || 0),
        `moons ${skyBefore.moon} -> ${now.moon}`);
      return `planets ${now.planet}, moons ${now.moon}`;
    });
  } finally {
    Math.random = realRandom;
    game.viewPin = wasViewPin;
    game.autoUpgrade = wasAuto;
    game.paused = wasPaused;
    hushAudio(game.sfxVol);
    // RESTORE, never force — see the capture note above.
    game.godMode = wasGod;
    game.started = wasStarted;
    input.mouseX = wasMouseX; input.mouseY = wasMouseY;
    input.keys.clear();
    for (const k of wasKeys) input.keys.add(k);
  }

  const report = {
    seed,
    wallMs: Math.round(performance.now() - wall0),
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
    logs: {
      deaths: game.deathLog.slice(),
      collisions: game.collisionLog.slice(),
      nanEvents: game.nanEvents,
      sky: census(game),
    },
  };

  // Leave a clean, deterministic world behind (opt out to inspect the aftermath)
  if (opts.reset !== false) hooks.freshRun(0, seed);

  window.lastMechReport = report;
  // eslint-style side channel for humans watching the console; the report
  // object is the machine-readable truth
  // `draws` rides in the table, not just the report: it is the documented
  // determinism tripwire (docs/testing.md, the mechanics-test skill), and a
  // reviewer diffing two runs by eye reads THIS, not window.lastMechReport.
  // The `detail` strings often do not move first, which is the whole reason
  // the column exists.
  console.table(results.map((r) => ({ test: r.name, pass: r.pass, draws: r.draws, detail: r.detail })));

  if (opts.download) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mech-report-${seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return report;
}
