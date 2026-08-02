import { SPECS, ABILITIES, shipStats, xpForPick, owesPick, addXp,
  abilityById, abilityRankCost, tierChoices, tierFloorFor } from './config.js';
import { spawnAsteroid, respawnShip } from './world.js';
import { damageShip } from './physics.js';
import { tryGrab, releaseHeld, addToOrbit, flingAllFromOrbit } from './tractor.js';
import { updateGlow } from './glow.js';
import { setDeathVisible } from './hud.js';
import { setSfxVolume } from './sfx.js';
import { mulberry32 } from './util.js';

// DEV MECHANICS SUITE — window.mechTest() lazy-loads this module, so normal
// play never imports it. It scripts a fixed set of player actions against a
// FIXED-SEED fresh run and asserts each core mechanic (and several design
// laws) still behaves. Repeatability: the world seed is fixed AND
// Math.random is swapped for a seeded mulberry32 for the duration (runtime
// spawns/spall/AI intentionally use Math.random in normal play — the swap
// makes the whole suite bit-identical run to run, and the finally-restore
// keeps that convention intact afterward). This is a MECHANICS smoke suite;
// long-horizon stability/balance is window.soak + the balance-test skill.

// Assertion helper: numbers land in the detail string so a failure is
// diagnosable straight from the report, without re-running.
function makeT(results) {
  return (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, pass: true, detail: detail == null ? '' : String(detail) });
    } catch (e) {
      results.push({ name, pass: false, detail: String((e && e.message) || e) });
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
  const realRandom = Math.random;
  const rng = mulberry32(seed ^ 0x5f3759df);
  Math.random = () => rng();
  const wasAuto = game.autoUpgrade;
  game.autoUpgrade = true;
  // Mute the SFX bus for the scripted burst (there are no audio toggles any
  // more — the volume slider IS the control; game.sfxVol still holds the
  // user's level to restore).
  setSfxVolume(0);
  game.collisionLog = [];
  game.deathLog = [];
  game.nanEvents = 0;

  try {
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
    // at all), then with a rank it captures, and the shotgun launches it
    t('orbit gate, capture + shotgun fling', () => {
      const s = game.ship;
      const r2 = spawnAsteroid(game.bodies, s.x + 100, s.y - 40, 0, 0, 60);
      game.aim.x = r2.x; game.aim.y = r2.y;
      expect(tryGrab(game) === 'held', 'setup: second grab failed');
      expect(!addToOrbit(game), 'orbit accepted a rock with NO orbit ability (gate broken)');
      game.prog.upgrades.bulwarkRing = 1;        // BRAWLER's orbit-channel ability
      game.st = shipStats(game.prog);
      expect(game.st.maxOrbiters > 0, 'orbit rank opened no slots');
      expect(addToOrbit(game), 'addToOrbit refused a light rock with the ability owned');
      expect(game.orbit.length === 1 && game.held === null, 'orbit bookkeeping off after capture');
      const n = flingAllFromOrbit(game, 1);
      expect(n === 1, `shotgun launched ${n} rocks, wanted 1`);
      expect(game.orbit.length === 0, 'orbit not empty after shotgun');
      expect(r2.thrownBy === 'player', 'shotgun rock not player-credited');
      return 'capture -> launch OK';
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
      expect(!game.choosingUpgrade, 'autoUpgrade left the card open');
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
      expect(!game.choosingUpgrade, 'an automatic rank opened a card');
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
    // Also the ARC law — BRAWLER's War Plating covers the front only, so it
    // eats a frontal hit whole, ignores one from behind, and soaks just its
    // COVERAGE SHARE (half) of directionless damage: heat, gas crush, Oort.
    t('shield unlocks and absorbs first', () => {
      const s = game.ship;
      game.prog.upgrades.warPlating = 3;         // BRAWLER's shield channel
      game.st = shipStats(game.prog);
      expect(game.st.shieldMax > 0, 'shield rank did not unlock a pool');
      s.shield = game.st.shieldMax; s.invuln = 0;
      let hull0 = s.hull, sh0 = s.shield;
      damageShip(game, 10, 'suite: absorb probe', s.angle);   // straight up the nose
      expect(s.hull === hull0, 'damage leaked past a full shield');
      expect(Math.abs(sh0 - s.shield - 10) < 1e-9, `shield absorbed ${sh0 - s.shield}, wanted 10`);
      // ...from BEHIND the front arc it soaks nothing — the tail is bare
      s.shield = game.st.shieldMax; s.invuln = 0;
      hull0 = s.hull; sh0 = s.shield;
      damageShip(game, 10, 'suite: rear probe', s.angle + Math.PI);
      expect(s.shield === sh0, 'the front arc soaked a hit from behind');
      expect(Math.abs(hull0 - s.hull - 10) < 1e-9, 'a rear hit did not go straight to hull');
      // ...and DIRECTIONLESS damage splits by COVERAGE SHARE (shieldArc / PI),
      // derived rather than hardcoded: the brawler wedge is deliberately under
      // half (see shipStats), so a literal 5 here would just re-break every
      // time that angle is tuned.
      s.shield = game.st.shieldMax; s.invuln = 0;
      hull0 = s.hull; sh0 = s.shield;
      const share = game.st.shieldArc / Math.PI;
      damageShip(game, 10, 'suite: directionless probe');
      expect(Math.abs(sh0 - s.shield - 10 * share) < 1e-9,
        `the wedge soaked ${sh0 - s.shield} of 10 directionless, wanted ${10 * share}`);
      expect(Math.abs(hull0 - s.hull - 10 * (1 - share)) < 1e-9, 'the rest never reached the hull');
      s.shield = game.st.shieldMax;
      return `pool=${Math.round(game.st.shieldMax)}`;
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

    // T9 — the shield DOES recharge after the quiet delay
    t('shield recharges after quiet time', () => {
      const s = game.ship;
      s.shield = 0;
      game.lastDamage = game.time - (game.st.regenDelay + 1);
      hooks.stepSim(1);
      expect(s.shield > 0, 'shield did not recharge after the quiet delay');
      return `+${s.shield.toFixed(1)} in 1s`;
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

    // T14 — the suite's own drama must not have shredded the sky
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
    game.autoUpgrade = wasAuto;
    setSfxVolume(game.sfxVol);
    game.godMode = false;
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
  console.table(results.map((r) => ({ test: r.name, pass: r.pass, detail: r.detail })));

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
