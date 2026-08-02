// AREA: combat — the damage ladder. Fires a standard set of (mass, speed)
// impacts at each target CLASS through the real collision path and reports
// damage per hit plus hits-to-kill.
//
// Why a ladder and not a single number: damage is QUADRATIC in closing speed and
// linear in mass, spanning three orders of magnitude, and mass dominance scales
// it by target. The intended shape (invariants 8/9) is
//   rock chips a planet -> moon wounds it -> a thrown PLANET is the killing blow
// and that shape is only visible as a table. One row moving is a re-tune; the
// whole column moving is a regression in the damage math.

const g = window.game;
window.god(true);
window.freshRun(0);
window.tick(1);

// Fire one rock of `mass` at `speed` into `target` and return the damage dealt.
// Uses the real path: a derailed, player-thrown body on a collision course.
function hit(target, mass, speed) {
  const rock = g.bodies.find((b) => b.alive && b.type === 'asteroid' && !b.fieldRock &&
    !b.heldBy && !b.chunk && b.thrownTimer <= 0 && b !== target);
  if (!rock) return null;

  // `alive` MUST be restored too: a rung that kills the target leaves it dead,
  // and every later rung then reports 0 damage — which reads as "this impact is
  // harmless" when it actually means "nothing was there to hit".
  const snap = { hp: target.hp, mass: target.mass, radius: target.radius, alive: target.alive,
                 onRails: target.onRails, rail: target.rail, radiusT: target.radiusT,
                 x: target.x, y: target.y, vx: target.vx, vy: target.vy };
  const m0 = rock.mass, r0 = rock.radius;
  rock.mass = mass;
  rock.radius = Math.max(3, Math.cbrt(mass) * 0.6);
  rock.onRails = false; rock.rail = null; rock.liveT = 0;
  rock.x = target.x + target.radius + rock.radius + 40;
  rock.y = target.y;
  rock.vx = -speed + (target.vx || 0);
  rock.vy = target.vy || 0;
  rock.thrownBy = 'player'; rock.thrownTimer = 3;

  // FREEZE THE TARGET for the measurement. It is normally railed and moving, so
  // the projectile arrived at a different angle every attempt — measured spreads
  // of 3466 vs 4936 on the same rung, and outright misses. Derailing it and
  // zeroing its velocity makes the impact geometry identical every time, which
  // is what turns this from a flaky probe into something diffable. Everything
  // here is restored from `snap` below.
  target.onRails = false; target.rail = null;
  target.vx = 0; target.vy = 0;
  rock.vx = -speed; rock.vy = 0;

  const before = target.hp;
  let contacted = false;
  for (let i = 0; i < 30 && !contacted && rock.alive; i++) {
    window.tick(1 / 60);
    if (target.hp !== before || !target.alive) contacted = true;
  }
  // null (not 0) when the projectile never connected — a miss and a harmless
  // hit are completely different findings and must not look alike in the diff.
  const dealt = contacted ? Math.round(before - (target.alive ? target.hp : 0)) : null;

  // Restore the target so successive rungs are independent measurements.
  target.hp = snap.hp; target.mass = snap.mass; target.radius = snap.radius; target.alive = snap.alive;
  target.radiusT = snap.radiusT; target.onRails = snap.onRails; target.rail = snap.rail;
  target.x = snap.x; target.y = snap.y; target.vx = snap.vx; target.vy = snap.vy;
  if (rock.alive) { rock.mass = m0; rock.radius = r0; rock.alive = false; }
  return dealt;
}

const find = (fn) => g.bodies.find((b) => b.alive && fn(b)) || null;
const targets = [
  { cls: 'asteroid-2500', b: find((b) => b.type === 'asteroid' && !b.fieldRock && b.mass > 2000 && b.mass < 4000) },
  { cls: 'fieldRock', b: find((b) => b.fieldRock && b.mass > 400) },
  { cls: 'moon', b: find((b) => b.type === 'moon') },
  { cls: 'planet-rocky', b: find((b) => b.type === 'planet' && b.ptype === 'rocky') },
  { cls: 'planet-crystal', b: find((b) => b.type === 'planet' && b.ptype === 'crystal') },
  { cls: 'planet-gas', b: find((b) => b.type === 'planet' && b.ptype === 'gas') },
];

// The rungs: a pebble, a boulder, a moon-class mass — at a mid and a fast
// throw. These bracket what the player can actually put on target.
const RUNGS = [
  { name: 'rock600@400', mass: 600, speed: 400 },
  { name: 'rock2500@700', mass: 2500, speed: 700 },
  { name: 'boulder6000@700', mass: 6000, speed: 700 },
  { name: 'moon13000@900', mass: 13000, speed: 900 },
];

const ladder = [];
for (const t of targets) {
  if (!t.b) { ladder.push({ target: t.cls, absent: true }); continue; }
  // The ship must be AT the target: dormant bodies are skipped by the collision
  // sweep entirely, so a staged impact on far-away field rock silently never
  // happens (it reported 0 damage on every rung — a miss dressed as a result).
  window.goto(t.b);
  window.tick(0.5);
  const row = { target: t.cls, hp: Math.round(t.b.maxHp), mass: Math.round(t.b.mass) };
  for (const r of RUNGS) {
    // BEST OF N. The target is railed and moving, so a staged projectile can
    // arrive glancing (or miss entirely) — measured spreads of 601 vs 2 on the
    // same rung. A glancing blow UNDER-reports, so the maximum clean contact is
    // the true head-on value; taking it makes the row stable enough to diff.
    let d = null;
    for (let k = 0; k < 5; k++) {
      const v = hit(t.b, r.mass, r.speed);
      if (v !== null) d = Math.max(d ?? 0, v);
    }
    row[r.name] = d;
    row[`${r.name}_hits`] = d && d > 0 ? Math.ceil(t.b.maxHp / d) : null;
  }
  ladder.push(row);
}

// ---- per-hit caps ---------------------------------------------------------
// Each of these bounds ONE blow so the number of blows stops depending on how
// hard the player happens to be able to throw (invariant-3 idiom).
const gas = find((b) => b.type === 'planet' && b.ptype === 'gas');
const caps = {
  // A gas giant must survive 6-10 moons however fast they arrive.
  gasSingleHitFraction: gas ? +(((hit(gas, 13000, 1400) || 0) / gas.maxHp)).toFixed(3) : null,
};

window.god(false);

return { seed: g.worldSeed, ladder, caps };
