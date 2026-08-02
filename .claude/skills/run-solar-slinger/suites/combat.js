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
//
// EVERY MEASUREMENT HERE IS STAGED, AND A STAGED IMPACT IS ONLY WORTH DIFFING
// IF IT IS REPEATABLE. Three separate things used to make it not, all of them
// found by running `bench.mjs diff combat` against unmodified code four times
// and getting four different answers:
//
//   1. THE TARGET DIED. A rung that killed the target left it dead, step()'s
//      cull spliced it out of game.bodies a few substeps later, and restoring
//      `alive = true` on the orphan did nothing — the object was no longer in
//      the world, so no later rung could ever hit it. Every remaining rung on
//      that target reported null. Any baseline taken then FROZE THAT ARTIFACT
//      IN as if it were a fact about the game (asteroid-2500 and moon both
//      carried null for their top rungs), and the flake was nothing more than
//      whether the boulder rung happened to land its kill on that run.
//   2. THE PROJECTILE WAS BORROWED from the world. Which body `find` returned
//      changed run to run (runtime spawns use Math.random by design, and the
//      cull compacts the array), and it arrived carrying its own damage.
//   3. THE WRECKAGE STAYED. Spall, calved crust and crystal shards from rung N
//      sat in front of the target for rung N+1 and intercepted it, and the
//      CRATERS from rung N are the collider (surfRadius reads b.scars), so
//      rung N+1 was fired at a different silhouette than rung N was.
//
// Fixing all three is what replaced "best of 5, take the max" — which was a
// way of hoping one attempt out of five was clean — with one clean shot.
const { spawnAsteroid } = await import('/src/world.js');

const g = window.game;
window.god(true);
window.freshRun(0);
window.tick(1);

// Gap between the projectile's leading edge and the target's nominal surface:
// far enough out that the rock is unambiguously clear of it on frame one, near
// enough that the flight is a handful of substeps.
const STANDOFF = 40;
// 0.5s at 1/60. Sized for the slowest rung (400 u/s) crossing the standoff plus
// the deepest crater a world can be carrying.
const FLIGHT_TICKS = 30;

// A rung that never connects is a FINDING, not a blank. These are reported at
// the top level so a change that starts causing misses shows up as an EXACT
// field moving off zero, instead of hiding inside a `null` that also means
// "this impact is harmless".
let misses = 0;
const noContact = [];

// Fire one rock of `mass` at `speed` into `target` and return the damage dealt.
// Uses the real path: a derailed, player-thrown body on a collision course.
function hit(target, mass, speed, label) {
  const snap = {
    hp: target.hp, mass: target.mass, radius: target.radius, alive: target.alive,
    onRails: target.onRails, rail: target.rail, radiusT: target.radiusT,
    x: target.x, y: target.y, vx: target.vx, vy: target.vy, rot: target.rot, spin: target.spin,
    // CRATERS ARE THE COLLIDER, NOT DECORATION (THE CRUMBLE — surfRadius reads
    // b.scars, and `shaped` switches the narrow phase on for anything carrying
    // one). Restore them or each rung is fired at the silhouette the rung
    // before it chewed. `rot` goes with them: scars are stored surface-local,
    // so a spinning world presents a different profile every attempt.
    scars: target.scars ? target.scars.slice() : null,
    sulfurCd: target.sulfurCd, shardCd: target.shardCd, stripT: target.stripT,
  };
  // Everything alive right now. Anything in g.bodies that ISN'T in here once
  // the shot is over was born from it — spall, calved crust, crystal shards —
  // and gets cleared, or the next rung is fired into this one's wreckage.
  const preexisting = new Set(g.bodies);

  // FREEZE THE TARGET for the measurement. It is normally railed and moving, so
  // the projectile arrived at a different angle every attempt — measured spreads
  // of 3466 vs 4936 on the same rung, and outright misses. Derailing it and
  // zeroing its velocity makes the impact geometry identical every time.
  target.onRails = false; target.rail = null;
  target.vx = 0; target.vy = 0;

  // ARMOUR THE TARGET so the blow can never be its last. This is a damage-per-
  // blow probe — hits-to-kill is arithmetic off maxHp, nothing here needs the
  // target to actually die, and a target that dies is a target that is GONE
  // (failure 1 above). Inflating `hp` and not `maxHp` is deliberate: every
  // number the collision path computes is derived from mass, closing speed and
  // maxHp, so the damage dealt is bit-identical to an unarmoured hit — the only
  // thing that changes is that `body.hp -= dmg` can't reach zero and call
  // shatter/beginGasStrip.
  const ARMOUR = target.maxHp * 1e6;
  target.hp = ARMOUR;

  // PIN THE TARGET'S ORIENTATION. A shaped target (`bigShape` rock, a crystal
  // world, a cratered limb) collides against its real silhouette, so the
  // distance from the muzzle to the SURFACE depends on which way it is facing —
  // and it is turning (`rot += spin * dt`). The projectile is spawned at a fixed
  // standoff from the DISC radius, so a different rotation phase means a
  // different flight, a different closing speed at contact, and a different
  // number. The phase at any rung depends on how much sim ran before it, which
  // is why only this row moved: `ladder[fieldRock]` picks a shoal MONOLITH
  // (bigShape, radius ~333) and measured 152, 262, 314, 352 on identical code.
  // Zeroing spin as well keeps it still for the flight itself. Both are restored
  // below with the rest of the snapshot, so nothing leaks into the next rung.
  target.rot = 0;
  target.spin = 0;

  // A DEDICATED PROJECTILE, spawned through the game's own path so it is a real
  // rock on the real mass/radius curve, with clean hp and no residue. Borrowing
  // a world body meant the measurement depended on which body the array handed
  // back, which is not stable across runs (failure 2 above).
  const rock = spawnAsteroid(g.bodies, target.x, target.y, 0, 0, mass);
  rock.x = target.x + target.radius + rock.radius + STANDOFF;
  rock.y = target.y;
  rock.vx = -speed; rock.vy = 0;
  rock.thrownBy = 'player'; rock.thrownTimer = 3; rock.chainN = 0;

  // CLEAR THE CORRIDOR. Loose rock between the muzzle and the target — the
  // target's own rubble halo, a dense field's neighbours, whatever the last
  // rung sprayed — used to eat the shot: measured 3526, null, 3528, null, 3323
  // on five identical attempts at a rocky world, the nulls being a projectile
  // stopped 100u short. `inertT` is the game's own "fresh fragment flies clear
  // of its siblings" gate (asteroid-vs-asteroid only, so the target still
  // connects whatever class it is) and it decays on its own; it is saved and
  // put back anyway so nothing leaks into the next rung.
  // CLEARING THE CORRIDOR IS NOT ENOUGH IN A DENSE FIELD. The corridor is only
  // ~300 units, but `struck` fires on the FIRST change to target.hp — from
  // ANY source — and the shoal is a maze of rock that is awake for a full
  // second across the goto, the settle and the flight. A neighbour drifting in
  // from off-corridor lands on the target and its damage is then attributed to
  // the projectile. That is what made `ladder[fieldRock]` nondeterministic:
  // measured 2, 30, 99, 146, 185, 265, 309, 345 on IDENTICAL code — a ~170x
  // spread on a row the whole baseline/diff workflow treats as exact.
  //
  // So the quiet zone is the target's whole NEIGHBOURHOOD, not the shot line.
  // Sized so nothing outside it can cross in: the flight is 0.5s and loose
  // field rock drifts at a few hundred u/s, so a rock 800 units out covers
  // ~100. Inerting more rock costs one extra walk per rung and cannot change
  // the measurement — `inertT` is asteroid-vs-asteroid only, and the projectile
  // is excluded, so the shot connects exactly as it did.
  const corridor = (rock.x - target.x) + rock.radius + 120;
  const quiet = Math.max(corridor, target.radius * 4 + 800);
  const inert = [];
  for (const b of g.bodies) {
    if (b === target || b === rock || !b.alive || b.type !== 'asteroid') continue;
    const dx = b.x - target.x, dy = b.y - target.y;
    if (dx * dx + dy * dy > quiet * quiet) continue;
    inert.push([b, b.inertT]);
    b.inertT = 1;
  }

  // CONTACT IS NOT THE SAME QUESTION AS DAMAGE, and conflating them is what
  // made a null ambiguous. collideBodies only calls damageBody when the blow
  // clears its own floor (`dmg > 0.5`), so a light rock against a dominant
  // target connects squarely and moves the hp not at all — a 600 at 400 into
  // 480,000 of field rock computes 0.24 and is dropped. That is a REAL RESULT
  // ("this cannot hurt it"), and it has to read as 0, not as a miss.
  //
  // So contact is read off the PROJECTILE, from either of two physical
  // outcomes, both of which need the corridor to be clear to be trustworthy:
  // it bounced (an immovable target returns it at ~0.75x, and gravity over a
  // flight this short can only ADD closing speed, never remove it), or it was
  // destroyed — the same mass dominance that throttles its damage to nothing
  // sends ~155,000 the other way, and no rock this class survives that.
  let struck = false, dealt = null;
  for (let i = 0; i < FLIGHT_TICKS && !struck && target.alive; i++) {
    window.tick(1 / 60);
    if (target.hp !== ARMOUR) { struck = true; dealt = Math.round(ARMOUR - target.hp); }
    else if (!rock.alive || rock.vx > -speed * 0.5) { struck = true; dealt = 0; }
  }
  if (!struck) { misses++; noContact.push(label); }

  for (const [b, t] of inert) b.inertT = t;
  // Restore the target so successive rungs are independent measurements.
  target.hp = snap.hp; target.mass = snap.mass; target.radius = snap.radius; target.alive = snap.alive;
  target.radiusT = snap.radiusT; target.onRails = snap.onRails; target.rail = snap.rail;
  target.x = snap.x; target.y = snap.y; target.vx = snap.vx; target.vy = snap.vy;
  target.rot = snap.rot; target.spin = snap.spin;
  target.sulfurCd = snap.sulfurCd; target.shardCd = snap.shardCd; target.stripT = snap.stripT;
  // In place, not a reassignment — render and the collider both read b.scars.
  if (target.scars && snap.scars) { target.scars.length = 0; for (const s of snap.scars) target.scars.push(s); }
  // ...and restore the WORLD: the projectile plus everything the impact minted.
  for (const b of g.bodies) if (!preexisting.has(b)) b.alive = false;
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
    // ONE SHOT PER RUNG. The target is frozen, armoured and pristine and the
    // corridor is clear, so a second attempt would only re-measure the first.
    const d = hit(t.b, r.mass, r.speed, `${t.cls}/${r.name}`);
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
  gasSingleHitFraction: gas
    ? +(((hit(gas, 13000, 1400, 'caps/gas13000@1400') || 0) / gas.maxHp)).toFixed(3) : null,
};

window.god(false);

// `misses` must be 0. It is deliberately an EXACT field: a rung that stops
// connecting is a regression in reach, geometry or the collision sweep, and it
// must never again be able to hide behind a null that reads as "harmless".
return { seed: g.worldSeed, misses, noContact, ladder, caps };
