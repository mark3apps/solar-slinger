import { CFG, SPECS, ABILITIES, shipStats, xpForPick, owesPick, addXp,
  abilityById, abilityRankCost, tierChoices, tierFloorFor,
  stormStrength, stormSpent, shelterR } from './config.js';
import { ACHIEVEMENTS } from './achievements.js';
import { spawnAsteroid, respawnShip } from './world.js';
import { damageShip } from './physics.js';
import { tryGrab, releaseHeld, addToOrbit, flingAllFromOrbit } from './tractor.js';
import { updateGlow } from './glow.js';
import { setDeathVisible } from './hud.js';
import { setSfxVolume } from './sfx.js';
import { mulberry32, surfaceVel } from './util.js';
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
  // THE INPUT DEVICE IS SHARED STATE, and the suite drives it: the docking and
  // pilot-card cases park the cursor (input.mouseX/Y feed game.aim every frame)
  // and hold KeyW. Left behind, that state is the NEXT run's starting
  // condition, and a second mechTest() in the same session stops matching the
  // first — measured: the delivery check paid +95 xp on one run and +83 on the
  // next, purely off a stale cursor. Restored in the finally beside
  // Math.random, for exactly the same reason.
  const wasMouseX = input.mouseX, wasMouseY = input.mouseY;
  const wasKeys = new Set(input.keys);
  // Mute the SFX bus for the scripted burst (there are no audio toggles any
  // more — the volume slider IS the control; game.sfxVol still holds the
  // user's level to restore).
  setSfxVolume(0);
  game.collisionLog = [];
  game.deathLog = [];
  game.nanEvents = 0;

  try {
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

    // ---- DOCKING ------------------------------------------------------------
    // The whole mechanic was shipped untested by this suite, and two real bugs
    // (Reflex Jink and the parry both live at a berth, the falsely-awardable
    // "Limped In") got through review because nothing here exercised it.
    //
    // `setDown` is the shared approach: put the hull on a world at the surface
    // velocity and aim the nose straight up, which is what the three gates want.
    // The aim matters — `s.angle` chases `game.aim`, so without pointing it
    // outward the level gate refuses and a berth never forms.
    // Cursor 300 screen-px along `bearing` from the view centre. render.js
    // sizes the view off window.innerWidth/Height in CSS px, which is exactly
    // what input.mouseX/Y carry, so the same numbers go straight back in.
    const aimAt = (bearing) => {
      const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
      input.mouseX = vw / 2 + Math.cos(bearing) * 300;
      input.mouseY = vh / 2 + Math.sin(bearing) * 300;
    };
    // THE MOUSE IS THE HELM. `s.angle` chases `game.aim`, and update() rebuilds
    // `game.aim` from `input.mouseX/Y` every frame — so setting game.aim here
    // would be overwritten within one step and the nose would swing back off
    // the arc. Park the cursor instead: the camera is ship-centred and the
    // world axes are the screen axes, so +x on screen is bearing 0 in world.
    const setDown = (world, upOff = 0) => {
      const s = game.ship;
      s.x = world.x + (world.radius + s.radius - 0.5);
      s.y = world.y;
      const sv = surfaceVel(world, s.x, s.y);
      s.vx = sv.vx; s.vy = sv.vy; s.spin = 0; s.alive = true;
      s.angle = upOff;                       // 0 = straight up off this contact point
      game.cam.x = s.x; game.cam.y = s.y;
      aimAt(upOff);
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
    const aWorld = () => game.bodies.find((b) => b.type === 'moon' && b.alive);

    // T15 — the three gates, and that a berth actually forms
    t('dock: three gates latch a berth', () => {
      hooks.freshRun(0, seed);
      game.docks = []; game.dock = null; game.home = null;
      const w = aWorld();
      // Attitude wrong (nose along the surface, well outside DOCK_ARC 1.0):
      // contact and stillness hold, so the refusal must be named as 'level'.
      setDown(w, Math.PI / 2);
      hooks.stepSim(0.4);
      expect(!game.dock, 'berthed with the nose off the arc');
      expect(game.dockGate === 'level', `refusing gate was "${game.dockGate}", wanted "level"`);
      // Now rockets down, held past DOCK_TIME.
      setDown(w, 0);
      hooks.stepSim(CFG.DOCK_TIME + 0.6);
      expect(game.dock, `no berth after ${CFG.DOCK_TIME + 0.6}s of all three gates`);
      expect(game.dock.b === w, 'berthed to the wrong body');
      expect(game.docks.length === 1, `docks=${game.docks.length}, wanted 1`);
      return `gate refused as "level", then latched to ${w.name || 'a moon'} in <=${CFG.DOCK_TIME + 0.6}s`;
    });

    // T16 — the build window gives NOTHING, and the finished station gives
    // immunity + DOCK_HEAL. Those ten exposed seconds ARE the price.
    t('dock: build window is unprotected, finished berth heals', () => {
      const s = game.ship;
      expect(game.dock && game.dock.t < 10, 'test needs a fresh, unfinished berth');
      // The suite has already granted a shield by now, and damageShip spends
      // that first — an unzeroed pool would absorb the probe and read exactly
      // like the immunity this test is trying to prove is ABSENT.
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
    // regression. The parry also must not leave a rock WELDED to the hull.
    t('dock: jink and parry are inert while berthed', () => {
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
      pr.alive = false;
      return 'jink cooldown untouched, parry stood down and unfrozen';
    });

    // T18 — LEAVING IS A SEQUENCE, and the station STANDS once built.
    t('dock: launch releases, and the station persists', () => {
      const s = game.ship;
      expect(game.dock, 'test needs a live berth');
      const station = game.dock;
      // The KEY, not game.controls — readControls rebuilds controls from
      // input.keys every frame, so a field poked here is gone within one step.
      input.keys.add('KeyW');
      hooks.stepSim(0.1);
      expect(game.launch, 'thrust at a berth did not start a launch sequence');
      hooks.stepSim(2.0);                       // > LAUNCH_TIME
      input.keys.delete('KeyW');
      expect(!game.dock, 'still berthed after the launch sequence finished');
      expect(game.docks.includes(station), 'the station vanished when the ship left it');
      expect(station.t >= 10, 'the finished station lost its build progress');
      hooks.stepSim(0.5);
      return `launched; ${game.docks.length} station still standing at t=${Math.round(station.t)}s`;
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
      setDown(w, 0);
      hooks.stepSim(CFG.DOCK_TIME + 0.6);
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
      setDown(w, 0);
      hooks.stepSim(CFG.DOCK_TIME + 0.6);
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
        expect(c.fade < 1, `${c.key}: fade ${c.fade} >= 1 would make stormStrength divide by zero`);
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
      // The flat pad is what makes a small moon's lee a pocket, not a razor edge.
      const small = moons.filter((b) => !b.shepherd)
        .reduce((a, b) => (b.radius < a.radius ? b : a));
      expect(shelterR(small) > small.radius * 2,
        `a small moon's lee (${shelterR(small).toFixed(1)}) is barely wider than the moon `
        + `(${small.radius.toFixed(1)}) — the flat pad is missing`);
      return `${moons.length - dark.length}/${moons.length} moons shelter `
        + `(${dark.length} shepherd exempt); smallest r=${small.radius.toFixed(1)}, lee=${shelterR(small).toFixed(1)}`;
    });

    // ---- DEFLECTOR AIM (PR #81) --------------------------------------------
    // T22 — the riposte leaves along ship->cursor, not back along the rock's
    // own capture bearing. That direction IS the feature; nothing else asserts it.
    t('parry: the riposte flies at the cursor', () => {
      hooks.freshRun(0, seed);
      const s = game.ship;
      parkShip(game, s.x, s.y);
      game.dock = null; game.docks = [];
      game.prog.upgrades.deflector = 1;
      game.st = shipStats(game.prog);
      const rank = game.st.deflect;
      expect(rank > 0, 'the deflector ability did not grant a rank');
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

    // ---- PILOT CARD (PR #82) — DELIBERATELY NOT COVERED HERE ---------------
    // Issue #96 asked for a scripted case that drives an inline offer with
    // `autoUpgrade` off and answers it through the real UI paths. It was
    // written, it passed, and it was REMOVED, because it cost the suite the
    // one property the whole thing rests on: bit-repeatability.
    //
    // Measured, on this file with nothing else changed. A case that merely
    // OPENS an inline offer is repeatable across five consecutive
    // `window.mechTest()` calls. Add the one line that ANSWERS it — a real
    // `Digit1` keydown into `pickFromUi` — and consecutive runs stop matching:
    // the delivery check drifts (+95 / +83 / +107 xp) because an earlier
    // auto-pick is handed a different ability, i.e. the seeded stream has
    // shifted. HEAD is stable over the same five runs, and stays stable with
    // 2.6s of idle inserted between them, so it is not wall-clock or stray
    // frames — answering a pick through the UI leaves something behind that
    // `resetRun` does not clear.
    //
    // Two known contributors, neither of which is the whole story:
    //   * the offerBox click delegate routes to hud's `onUpgradePick`, which
    //     calls `sfx.initAudio()`; `sfx.play()` draws a Math.random() to pick a
    //     sample variant, but ONLY once a context exists and a buffer has
    //     decoded — so bringing audio up mid-suite silently shifts every later
    //     draw. (Headless, audio never comes up, which is why the suite is
    //     deterministic today largely by accident.)
    //   * the keydown path alone still drifts, with audio never initialised.
    //
    // A suite that quietly stopped being repeatable would be worse than this
    // gap, so the gap is documented instead. Root-causing the second one is
    // tracked separately; do not re-add a case that answers a pick until it is
    // fixed and five consecutive runs compare equal.

    // T19 — the suite's own drama must not have shredded the sky
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
