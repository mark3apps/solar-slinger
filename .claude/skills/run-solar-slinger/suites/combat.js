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
// IF IT IS REPEATABLE. Five separate things used to make it not, all of them
// found by running `bench.mjs diff combat` against unmodified code several
// times and getting a different answer every time:
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
//   4. THE TARGET'S SPIN PHASE WAS RANDOM. Freezing the target's POSITION was
//      only half of freezing its geometry. `Body` draws `rot` from Math.random
//      (entities.js — cosmetic tumble, deliberately not seeded) and physics
//      integrates it every substep off `spin`, and a shaped collider is traced
//      in BODY-LOCAL space: physics.shaped() is true for `bigShape` rock and
//      crystal worlds UNGATED, and surfRadius solves at `ang - b.rot`. So the
//      shot met a different facet of the same rock on every run — measured
//      1, 254, 318, 348 on four identical runs against field monolith 4145,
//      and the full rotation sweep of that one rung runs 0 → 353. Nothing
//      about the world differed: same body id, same mass, same radius, same
//      position, ZERO scars. Only the angle it happened to be holding.
//   5. THE FLIGHT BUDGET WAS A STOPWATCH, not a distance. A flat 30 ticks is
//      200 units at the slowest rung, but a big rock's cleft sits ~270u INSIDE
//      its own nominal radius, so the rock was still in open space when the
//      budget ran out and a clean shot was booked as a miss. Whether it did
//      was itself a function of the random facet (contact ranged 63u to 190u
//      from the centre on the same rock), so `misses` flickered too.
//
// Fixing all five is what replaced "best of 5, take the max" — which was a way
// of hoping one attempt out of five was clean — with shots that are clean by
// construction. Note the distinction 4 forces: repeating an attempt at the SAME
// angle is the old superstition and buys nothing, but a shaped rock genuinely
// presents a different surface from every bearing, so the rungs that meet one
// are measured at four quarter-turns and averaged (see `probe`). That is a
// sample of real geometry, not a retry.
const { spawnAsteroid } = await import('/src/world.js');
const { mulberry32 } = await import('/src/util.js');

const g = window.game;
window.god(true);

// PIN THE DICE FOR THE WHOLE SUITE. World GENERATION is seeded off `?seed=`,
// but runtime is deliberately not (see the determinism note in CLAUDE.md), and
// a staged probe sits downstream of all of it:
//   - `Body` draws `rot` and `spin` from Math.random even during generation, so
//     the shaped colliders faced the shot at a random angle (failure 4);
//   - calve() draws the count and sizes of the crust a blow knocks off AND
//     bills a big rock's own mass for it, inside the same 1/60 window that
//     reports the damage (update runs two substeps per tick);
//   - replenish and AI churn the body list, so the gravity sum the projectile
//     integrates over is not even the same length run to run — worth ~1 point
//     on a 219-point rung, arriving through nothing but float ordering.
// Freezing the geometry (below) fixes the first and is the fix that MATTERS,
// because it is what makes the number mean something. This makes the rest of
// the suite bit-exact on top of it, which is what makes it worth diffing.
// Restored at the end; the game's randomness is deliberate in PLAY, and this
// only ever covers the harness.
const realRandom = Math.random;
Math.random = mulberry32(0x5ca1ab1e);

window.freshRun(0);
window.tick(1);

const TAU = Math.PI * 2;

// Gap between the projectile's leading edge and the target's nominal surface:
// far enough out that the rock is unambiguously clear of it on frame one, near
// enough that the flight is a handful of substeps.
const STANDOFF = 40;
// Flight budget in 1/60 ticks, sized off the DISTANCE the rock has to cover at
// the speed it is covering it — not a flat count (failure 5). Worst case is a
// surface recessed all the way to the centre, so budget the whole approach plus
// the target's radius, plus a margin for the substep quantum. A shot fired dead
// at a frozen target from just outside its surface always connects inside this;
// anything that doesn't is a real finding, which is what `misses` is for.
const flightTicks = (target, rock, speed) =>
  Math.ceil((((rock.x - target.x) + target.radius) / speed) * 60) + 6;

// Does this target's COLLIDER TURN WITH IT? Mirrors physics.shaped(): a big
// rock's slab/wedge outline and a crystal world's shard polygon are both traced
// in body-local space and solved at `ang - b.rot`, and a cratered world's scar
// profile is stored surface-local too. Everything else is the circle it always
// was, and presents the same silhouette from every bearing.
const turns = (b) => !!b.bigShape || b.ptype === 'crystal' || (b.scars && b.scars.length > 0);

// A rung that never connects is a FINDING, not a blank. These are reported at
// the top level so a change that starts causing misses shows up as an EXACT
// field moving off zero, instead of hiding inside a `null` that also means
// "this impact is harmless".
let misses = 0;
const noContact = [];

// Fire one rock of `mass` at `speed` into `target` AT A PINNED ORIENTATION and
// return the damage dealt. Uses the real path: a derailed, player-thrown body
// on a collision course.
function hit(target, mass, speed, rot, label) {
  const snap = {
    hp: target.hp, mass: target.mass, radius: target.radius, alive: target.alive,
    onRails: target.onRails, rail: target.rail, radiusT: target.radiusT,
    x: target.x, y: target.y, vx: target.vx, vy: target.vy,
    rot: target.rot, spin: target.spin,
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
  // ...AND FREEZE ITS ROTATION, which is the other half of the same sentence
  // (failure 4). `rot` is a Math.random draw at construction, so a shaped
  // collider faced the shot at a different angle on every run; `spin` has to go
  // with it or `rot` walks up to 0.14 rad during the flight, which is a third
  // of the way to the next facet. Nothing in the collision path reads `spin`
  // itself — surfRadius reads `rot` and physics integrates it — so zeroing it
  // removes drift and nothing else. Both are restored below.
  target.rot = rot; target.spin = 0;

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
  // put back anyway so nothing leaks into the next rung. It is set to OUTLAST
  // THE FLIGHT rather than to a flat second: physics decays it by dt every
  // substep, so a corridor pinned at 1 quietly reopens partway through a slow
  // rung's approach.
  const ticks = flightTicks(target, rock, speed);
  const corridor = (rock.x - target.x) + rock.radius + 120;
  const inert = [];
  for (const b of g.bodies) {
    if (b === target || b === rock || !b.alive || b.type !== 'asteroid') continue;
    const dx = b.x - target.x, dy = b.y - target.y;
    if (dx * dx + dy * dy > corridor * corridor) continue;
    inert.push([b, b.inertT]);
    b.inertT = ticks / 60 + 0.5;
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
  for (let i = 0; i < ticks && !struck && target.alive; i++) {
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

// ONE RUNG, ONE NUMBER — and for a target whose collider turns, that number is
// the mean of four QUARTER-TURNS rather than one arbitrary facet.
//
// Pinning the angle is what makes the row repeatable; averaging is what keeps
// it MEANINGFUL. A big rock is a slab, and its rotation sweep is not noise
// around a mean — it is real geometry, running 0 → 353 on one rung, with
// genuine dead spots where the shot slides into a cleft and lands almost
// nothing. Freezing one arbitrary facet would make the ladder a fact about
// whichever bearing happened to be pointing at us, and a later retune of the
// shape table could silently park that bearing on a dead spot and leave the
// row reporting 0 forever — failure 1 in a new dress. Four quadrants can't all
// be dead, so the row keeps signal through any shape change, and it still moves
// proportionally when the damage MATH moves, which is what it is here to catch.
// Circles are measured once: every bearing gives the same answer, and paying
// four flights to learn that is just slower.
function probe(target, mass, speed, label) {
  if (!turns(target)) return hit(target, mass, speed, 0, label);
  const got = [];
  for (let q = 0; q < 4; q++) {
    const d = hit(target, mass, speed, (q / 4) * TAU, `${label}@q${q}`);
    if (d !== null) got.push(d);
  }
  return got.length ? Math.round(got.reduce((a, b) => a + b, 0) / got.length) : null;
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
    // ONE SHOT PER ORIENTATION. The target is frozen, armoured and pristine and
    // the corridor is clear, so a second attempt at the same angle would only
    // re-measure the first — the only thing worth varying is the facet, which
    // is what `probe` does.
    const d = probe(t.b, r.mass, r.speed, `${t.cls}/${r.name}`);
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
    ? +(((probe(gas, 13000, 1400, 'caps/gas13000@1400') || 0) / gas.maxHp)).toFixed(3) : null,
};

window.god(false);
Math.random = realRandom;

// `misses` must be 0. It is deliberately an EXACT field: a rung that stops
// connecting is a regression in reach, geometry or the collision sweep, and it
// must never again be able to hide behind a null that reads as "harmless".
return { seed: g.worldSeed, misses, noContact, ladder, caps };
