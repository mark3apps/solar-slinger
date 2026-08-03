import {
  CFG, PROG, TIERS, LIFT_NEVER, addXp, fieldXp, canLift, canStow, liftClass, latchTime,
} from './config.js';
import { derail } from './entities.js';
import * as gravel from './gravel.js';
import { promoteGravel } from './physics.js';
import { clamp, angDiff } from './util.js';
import { bump, best, noteCatch } from './achievements.js';
import * as sfx from './sfx.js';

// Where the held object is pulled to: offset from the ship toward the cursor.
// angOff flanks a Twin Grip second rock to the side so the two don't overlap.
function holdPoint(game, body, angOff = 0) {
  const s = game.ship;
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x) + angOff;
  const d = s.radius + body.radius + 46;
  return { x: s.x + Math.cos(ang) * d, y: s.y + Math.sin(ang) * d };
}

// AIM ASSIST, inverted: the rock ALWAYS flies exactly at the cursor — the
// game never adjusts your angle. Instead it solves, for every entity in
// throw reach, WHERE you'd have to release for the straight-line paths to
// collide (|R + Vt| = speed*t, ship-relative), and hands those lead points
// to the UI as ✕ markers. The player's job is to let go on the ✕, not on
// the target. A solution whose angle the cursor currently satisfies (within
// the real angular width of the target) is "hot" — that release will hit.
export function aimSolutions(game) {
  const s = game.ship;
  const st = game.st;
  const held = game.held;
  const speed = flingSpeedFor(game, held ? held.mass : 600, held);
  const heldR = held ? held.radius : 6;
  // CRITICAL FRAME CHOICE: the rock launches from ITS OWN position (the hold
  // point, ~70 out from the ship, plus any spring lag) — not from the ship.
  // Solving from the ship puts the ✕ on a parallel-offset line and the shot
  // misses by the full offset. Origin = the actual launch point.
  const o = held || s;
  const cursorAng = Math.atan2(game.aim.y - o.y, game.aim.x - o.x);
  // Targeting Computer upgrade scales the solve reach (targetReach x LOCK_T)
  const lockT = CFG.LOCK_T * (st.targetReach || 1);
  const reach = Math.min(2600, speed * lockT);
  const sols = [];
  let hot = null;
  const consider = (e) => {
    const rx = e.x - o.x, ry = e.y - o.y;
    if (rx * rx + ry * ry > (reach + 400) ** 2) return;
    const vx = e.vx - s.vx, vy = e.vy - s.vy;
    const a = vx * vx + vy * vy - speed * speed;
    const bq = 2 * (rx * vx + ry * vy);
    const c = rx * rx + ry * ry;
    let t = 0;
    if (Math.abs(a) > 1e-6) {
      const disc = bq * bq - 4 * a * c;
      if (disc < 0) return;                       // target outruns the throw
      const sq = Math.sqrt(disc);
      const ts = [(-bq - sq) / (2 * a), (-bq + sq) / (2 * a)].filter((x) => x > 0.02);
      if (!ts.length) return;
      t = Math.min(...ts);
    } else if (bq < -1e-6) {
      t = -c / bq;
    } else return;
    if (t > lockT * 1.4) return;                  // meets beyond the throw line
    // Lead point: where the cursor must sit for this angle (launch frame,
    // so it stays correct even while the ship itself is moving)
    const mx = o.x + rx + vx * t, my = o.y + ry + vy * t;
    const ang = Math.atan2(ry + vy * t, rx + vx * t);
    const tol = Math.max(0.004, (e.radius + heldR * 0.8) / (speed * t));
    const sol = {
      target: e, t, mx, my,
      onLine: Math.abs(angDiff(cursorAng, ang)) <= tol,
      cursorD: Math.hypot(mx - game.aim.x, my - game.aim.y),
    };
    sols.push(sol);
    if (sol.onLine && (!hot || t < hot.t)) hot = sol;
  };
  for (const al of game.aliens) if (al.alive) consider(al);
  for (const b of game.bodies) {
    if (!b.alive || b.type === 'star' || b === held || b.heldBy) continue;
    consider(b);
  }
  sols.sort((x, y) => x.cursorD - y.cursorD);
  return { sols: sols.slice(0, st.targetMarkers || 6), hot };
}

// Fling speed for a given mass — heavier objects fling slower. TETHER THROW:
// at beam tier 2+, flinging while under forward thrust whip-cracks the rock
// with the ship's own momentum (up to +60% at high speed). The multiplier is
// stashed on game.tetherMul so releaseHeld can announce big cracks, and the
// same helper feeds the lead-marker solver so the ✕ stays honest — which is
// why it takes the BODY too: per-rock multipliers (Dead Stop's prime) must
// show in the solve, or the markers lie for exactly the shots that matter.
// THE BEAM'S GRIP ON A LOAD. One helper, because the HOLD and the THROW must
// never disagree about it. `heft` is the load as a fraction of your allowance
// (CFG.TRACTOR_HEFT); `spool` is how far the emitters have closed on it since
// the grab (CFG.TRACTOR_SPOOL / _MIN), on a squared ramp over a window that
// scales with heft — about a second on a pebble, the full window on a moon.
// `b.holdT` is NULL for anything not in the beam (the orbit ring, the trail
// rack, a rock in flight), and those are exempt by design.
function beamGrip(st, b) {
  const heft = clamp(b.mass / Math.max(1, st.capacity), 0, 1);
  // `f` is the RAW ramp fraction — the honest "how far through the wind-up am
  // I" number, and the one render draws as the charge ring. `spool` is that
  // eased into authority. f === 1 is exactly full throw power.
  const f = clamp((b.holdT || 0) / (CFG.TRACTOR_SPOOL * (0.3 + 0.7 * heft)), 0, 1);
  return { heft, f, spool: CFG.TRACTOR_SPOOL_MIN + (1 - CFG.TRACTOR_SPOOL_MIN) * f * f };
}

function flingSpeedFor(game, mass, body = null) {
  const st = game.st;
  const massFactor = clamp(Math.pow(st.capacity / (mass * 4), 0.25), 0.3, 1);
  let speed = st.fling * massFactor;
  // WIND-UP: the same grip the HOLD spends, spent on the THROW. Without it the
  // spool-up only governed how fast a rock swung into position and the hardest
  // throw in the game was grab-and-release on the same frame — worse, letting
  // go and re-grabbing handed you a fresh full-power throw every time, so
  // spamming the beam beat holding it.
  // Scaled by HEFT, so it bites only where the law is about: an ordinary rock
  // is at full power the instant you have it (heft ~0.05 -> ~0.97x on a
  // same-frame throw) and the belt loop is untouched, while a moon at the top
  // of your class leaves at ~40% until you have held it a beat and 100% once
  // the beam is fully closed. The lead-marker solver runs this same call every
  // frame, so the ✕ walks out as the throw charges instead of lying about it.
  if (body && body.holdT != null) {
    const g = beamGrip(st, body);
    speed *= 1 - g.heft * (1 - g.spool);
  }
  // BERSERKER (brawler): the lower your hull, the harder you throw — read the
  // ship's CURRENT hull fraction at release time, so it's a live risk/reward.
  if (st.berserk > 0 && game.ship.alive) {
    const hullFrac = clamp(game.ship.hull / Math.max(1, st.maxHull), 0, 1);
    speed *= 1 + st.berserk * 0.15 * (1 - hullFrac);
  }
  // DEAD STOP (hauler): a rock caught mid-alien-throw is primed — the
  // counterpunch flies far harder. Consumed on release (releaseHeld).
  if (body && body.primed && st.deadStop > 0) speed *= 1 + 0.15 * st.deadStop;
  game.tetherMul = 1;
  if (st.tier >= 2 && game.controls.f > 0 && game.ship.alive) {
    const sp = Math.hypot(game.ship.vx, game.ship.vy);
    const mul = 1 + Math.min(0.6, sp / 900);
    speed *= mul;
    game.tetherMul = mul;
  }
  // Hard cap the throw speed — Kinetic Sling 6 × tether × Berserker could reach
  // ~4900, fast enough to tunnel through small targets and inject absurd impulse.
  return Math.min(speed, 3000);
}

// The rock flies from ITS OWN position straight through the cursor point —
// matching the frame aimSolutions solves in, so releasing on a ✕ really
// connects. (If the cursor sits basically on the rock, fall back to the
// ship-nose angle.)
export function computeFlingVelocity(game, body) {
  const s = game.ship;
  const speed = flingSpeedFor(game, body.mass, body);
  const dx = game.aim.x - body.x, dy = game.aim.y - body.y;
  const ang = Math.hypot(dx, dy) > 25
    ? Math.atan2(dy, dx)
    : Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  return { vx: s.vx + Math.cos(ang) * speed, vy: s.vy + Math.sin(ang) * speed };
}

// PICKING UP A WORLD UNSTICKS ITS SKY.
//
// A world's family — moons, ring chunks, probe junk, its rubble shell — rides
// RAILS anchored to it, and the rails pass reads the parent's LIVE position
// every substep (physics.js). So a grabbed planet used to carry its entire
// system with it, welded: fifty bodies teleporting along at whatever speed the
// beam was swinging the planet, passing through anything in the way, and
// snapping back into perfect formation the instant you let go. A moon family is
// held by gravity, and the moment something else is holding the planet the
// gravity is no longer what is moving it.
//
// So the grab cuts every rail anchored to it. Each child keeps the velocity it
// already had (the rails pass writes a truthful one every substep), which is
// its real orbital velocity around the world it belonged to — left alone it
// simply keeps orbiting, and it re-rails on the ordinary scan once you have
// dropped the world and flown off. Haul the world away and its moons stay
// where their momentum left them, which is the point.
//
// Cheap enough to run on every grab: it is one pass over the body array per
// grab (not per frame), and the guard means a pebble never pays for it.
//
// THE GUARD ASKS WHAT CAN HAVE RAILS ANCHORED TO IT, not what is a world, and
// that is the whole reason `bigShape` is in it. A LANDMARK ROCK calves a real
// crust halo now (physics.calveCrust fires on body.bigShape), and
// physics.updateCrust rails the settled pieces to it with the same
// railBody(b, h) a planet's rubble gets. While the three world types were the
// whole test, grabbing a giant or a monolith left that shell welded to the
// beam — this function's exact failure mode, arriving by the one route
// updateCrust's own stand-down cannot cover: its host-held bail sits ABOVE the
// `b.onRails` check, so a piece that had already railed is never looked at
// again. Standing the assist down only stops NEW rails; cutting the live ones
// is this pass's job. The pieces resettle after the drop on the free window
// updateCrust holds open.
function unglue(game, host) {
  if (host.type !== 'planet' && host.type !== 'moon' && host.type !== 'rogue' &&
      !host.bigShape) return;
  for (const b of game.bodies) {
    if (b.alive && b.onRails && b.rail.parent === host) derail(b);
  }
}

// TWO STAGES OF "that one is already busy", and render.js's hover hint MIRRORS
// both; keep the trio in sync or the ring promises a grab the click won't make.
//   throwLocked — you launched it from the beam less than CFG.THROW_LOCKOUT ago
//                 and it is not a target AT ALL
//   isOwnShot   — it is still flying on your credit; grabbable, but it loses to
//                 literally everything else
// THE MUZZLE FLASH for a launch. Pure data — tractor decides that a throw
// happened and how big it was; render.drawLaunchFx owns every pixel of it, and
// main.js ages the records. (tractor cannot call physics.addParticles/addShake:
// physics imports THIS module, and the cycle would be real.)
// `charged` is passed in, never read from game here: releaseHeld clears the
// charge state near the top (it belongs to the rock that just left) and reading
// it at push time would make the flash silently order-dependent.
export function pushLaunchFx(game, b, vx, vy, charged) {
  if (!game.launchFx) return;
  game.launchFx.push({
    x: b.x, y: b.y,
    ang: Math.atan2(vy - game.ship.vy, vx - game.ship.vx),
    t: 0,
    r: b.radius,
    // How much of the beam this load was using — the flash scales with it, so
    // the spectacle tracks the effort rather than firing flat on every pebble.
    heft: clamp(b.mass / Math.max(1, game.st.capacity), 0.12, 1),
    charged: !!charged,
  });
  if (game.launchFx.length > CFG.LAUNCH_FX_MAX) game.launchFx.shift();
}

// EVERY PATH THAT TAKES A ROCK OUT OF THE BEAM CLEARS WHAT THE BEAM WROTE ON
// IT. That law already covered `extAx/extAy` (a hold accel left behind is a
// permanent phantom thrust — physics adds it every substep until somebody
// zeroes it); the wind-up added two more pieces of per-hold state to it:
//   b.holdT   — flingSpeedFor keys the throw wind-up off `holdT != null`, so a
//               rock that kept it would come back to the beam already charged
//   b.ropeL   — the taut tether's live length; a stale one would have the next
//               hold engage its rope at the last one's reach
//   the CHARGE readout — a stale READY paints a near-white beam on a rock that
//               is not charged, or on nothing at all
// Physics owns three of those paths (shatter, vaporize, the ship-death block)
// and none of them can go through releaseHeld, so they call this instead.
// It matters MORE since the tether became unbreakable at full power: springHeld's
// own auto-drop no longer fires on distance, so it cannot mop up a stranded rock.
export function clearHoldState(game, b) {
  if (b) { b.holdT = null; b.ropeL = null; b.extAx = 0; b.extAy = 0; }
  // The readout describes the rock that just left. springHeld rebuilds it on
  // the next substep for whatever is still in hand.
  game.heldCharged = false; game.heldCharge = 0; game.heldChargeShow = false;
}

export const throwLocked = (b) => b.throwLock > 0;
export const isOwnShot = (b) => b.thrownBy === 'player' && b.thrownTimer > 0;

// What the cursor is over, if the beam could reach it. Shared by tryGrab and
// the winch (updateLatch), which has to re-run the SAME test every substep to
// know the target is still in reach.
//
// YOUR OWN SHOT IS THE LOWEST-PRECEDENCE TARGET IN THE GAME (user design rule).
// The rapid-fire loop is click-to-retrieve, release-to-fling, click again — and
// the rock you just let go is still a beam-length away, dead centre under the
// crosshair, so the second click kept catching the first shot instead of
// launching the next one. Two stages:
//   - For CFG.THROW_LOCKOUT seconds after the launch it is skipped OUTRIGHT.
//     Demotion alone was not enough: out in open space your last shot is the
//     only thing under the cursor, so it still won the click.
//   - After that it is merely DEMOTED, never excluded — it wins again once
//     nothing else is in reach, so chasing down your own throw stays possible.
// Returns { best, ownThrow } — `ownThrow` means the only thing found was one of
// your own shots, which is what lets tryGrab hand the click to the stow ring.
function pickTarget(game) {
  const s = game.ship;
  const st = game.st;
  let best = null, bestD = Infinity;     // anything that is not your own shot
  let mine = null, mineD = Infinity;     // your own shots, ranked separately
  for (const b of game.bodies) {
    // Nests are a siege target, not cargo, and Bastion forts repel the beam;
    // the Tinker Barge is CREWED — the beam won't take a live friendly ship;
    // never re-grab a rock you're already holding.
    if (!b.alive || b.type === 'star' || b.type === 'nest' || b.fort || b.tinker ||
        b.heldBy === 'orbit' || b === game.held || b === game.held2 ||
        b.parryFrozen ||           // mid-parry rock belongs to the flick, not the beam
        throwLocked(b)) continue;  // just launched it — not a target at all yet
    const dCursor = Math.hypot(b.x - game.aim.x, b.y - game.aim.y);
    const dShip = Math.hypot(b.x - s.x, b.y - s.y);
    if (dCursor > b.radius + st.grabSlack) continue;
    if (dShip > st.range + b.radius) continue;
    if (isOwnShot(b)) { if (dCursor < mineD) { mine = b; mineD = dCursor; } continue; }
    if (dCursor < bestD) { best = b; bestD = dCursor; }
  }
  // GRAVEL is scanned last and on the same terms. A grain is a real rock in a
  // cheaper representation (see gravel.js), so the beam must be able to reach
  // one — "the crater you see is the crater you can fly into" does not have an
  // exception for debris the sim happened to store in a typed array.
  //
  // PROMOTION HAPPENS HERE AND ONLY HERE, once a grain has actually WON the
  // pick: it is the single point where the beam has committed to something, so
  // it is the only place where minting a Body is proportionate. Doing it in the
  // hover-ring pass instead would promote every grain the cursor swept over.
  // Own-shot ranking is skipped because a grain is never your own shot — gravel
  // cannot be thrown without first becoming a Body, at which point it is one.
  if (gravel.count()) {
    const gx = gravel.x, gy = gravel.y, gr = gravel.radius, gf = gravel.flags;
    let gi = -1, gd = bestD;
    for (let i = 0, n = gravel.top; i < n; i++) {
      if (!(gf[i] & gravel.FLAG_ALIVE)) continue;
      const dCursor = Math.hypot(gx[i] - game.aim.x, gy[i] - game.aim.y);
      if (dCursor >= gd) continue;
      if (dCursor > gr[i] + st.grabSlack) continue;
      if (Math.hypot(gx[i] - s.x, gy[i] - s.y) > st.range + gr[i]) continue;
      gi = i; gd = dCursor;
    }
    if (gi >= 0) {
      const b = promoteGravel(game, gi);
      if (b) return { best: b, ownThrow: false };
    }
  }
  return { best: best || mine, ownThrow: !best && !!mine };
}

// THE WINCH. A moon or a world does not snap into the beam — you hold the
// button on it and the emitters bite in over config.latchTime seconds (nothing
// below the moon rungs winches at all, so the belt loop is exactly as it was).
//
// ONCE THE BEAM HAS PICKED ITS TARGET, THE CURSOR IS FREE (user design rule).
// The winch holds as long as the button is down and the body is still in beam
// RANGE — it does NOT re-test the cursor. It used to, and that was wrong twice
// over: a moon is a moving target on a rail and the ship is moving too, so
// simply holding still lost the winch through no decision of the player's; and
// the cursor is also the AIM, so requiring it to stay parked on the load meant
// you could not line up the throw you were winching up for. Releasing the
// button is the only way to abandon it (main.onFling -> cancelLatch), and
// nothing is banked for next time.
//
// `btn` MAKES THAT CONTRACT LOAD-BEARING instead of assumed. The winch used to
// trust main.onFling alone to end it, and onFling sat behind the menu gate:
// mouseup is a WINDOW listener, so a release while paused / in settings / on an
// upgrade card cleared the button and never reached cancelLatch, while this
// function — which reads alive / heldBy / range and nothing about the mouse —
// carried the winch across the freeze and finished it with no button held.
// onFling is fixed, but the rule belongs where the winch lives too. Passed in
// rather than read here: tractor.js does not import input.js, and reaching into
// raw input state from the sim would be the wrong direction for that edge.
export function updateLatch(game, dt, btn = true) {
  const L = game.latch;
  if (!L) return;
  const b = L.body, s = game.ship, st = game.st;
  const canSecond = st.twinGrip && game.held && !game.held2;
  if (!btn || !b.alive || !s.alive || b.heldBy === 'orbit' || b.parryFrozen ||
      (game.held && !canSecond) || !canLift(st, b) ||
      Math.hypot(b.x - s.x, b.y - s.y) > st.range + b.radius) {
    cancelLatch(game);
    return;
  }
  L.t += dt;
  if (L.t < L.need) return;
  game.latch = null;
  // THE WINCH SECONDS CARRY INTO THE WIND-UP, they are not charged twice: from
  // the player's side this was one continuous press, and billing the full
  // beamGrip ramp again on top of the winch would put a hard throw on a moon
  // five seconds out from the click.
  grabBody(game, b, L.t);
}

export function cancelLatch(game) {
  if (!game.latch) return;
  game.latch = null;
  sfx.setCharge(0);
}

// WHAT THE CLICK DID, and it is NOT a boolean — the caller has to be able to
// tell "the cursor was over empty space" from "the beam answered you", because
// main.onGrab falls through to retrieveFromOrbit and that fallback must only
// ever fire on an EMPTY click.
//   'held'     — the rock is in the beam now
//   'winching' — a moon/world winch has started (updateLatch owns it from here)
//   'refused'  — something was there and the beam said no (too heavy / wrong
//                class / no grip); the denial sound and red ring already fired
//   null       — nothing under the cursor, or the beam is not free to take one
// Returning plain `false` for the middle two is what made clicking a moon yank
// a moon back OUT of the orbit ring instead: `tryGrab` reported "nothing
// happened" for a winch it had just started. Do NOT collapse this back to a
// boolean, and do not test it for truthiness — 'refused' is truthy too.
export function tryGrab(game) {
  if (!game.ship.alive) return null;
  // Twin Grip lets a SECOND rock go into game.held2; without it (or both full) no grab.
  const canSecond = game.st.twinGrip && game.held && !game.held2;
  if (game.held && !canSecond) return null;
  const st = game.st;
  const { best, ownThrow } = pickTarget(game);
  if (!best) return null;
  // AND WHEN THE STOW HAS ANYTHING IN IT, THE RING OUTRANKS YOUR OWN SHOT
  // OUTRIGHT. Demoting it inside pickTarget only helps when a DIFFERENT body is
  // also under the cursor; out in open space your last shot is alone out there
  // and would still win. Reporting `null` hands the click to main.onGrab's
  // retrieve fallback, which is exactly the next rock the player was reaching
  // for. With an empty ring there is nothing better to do, so the grab stands.
  if (ownThrow && game.orbit.length && !game.held) return null;
  // TWO GATES, one test (config.canLift): the CLASS rung your tier reaches, and
  // the mass allowance inside it. The class is why a planet is unliftable below
  // the top tier no matter how many catch ranks you stack, and why a moon is
  // unliftable below the moon rungs even when a boulder outweighs it. The hover
  // hint ring runs the same call, so the ring never promises a grab this
  // refuses.
  if (!canLift(st, best)) {
    game.tooHeavy = best;          // HUD shows "too heavy" feedback
    game.tooHeavyT = 1.2;
    // SAY WHY when it is the CLASS that refused, not the weight. A 5,800-mass
    // moon under a 6,000 allowance reads as a broken beam unless the game
    // admits it is the wrong KIND of thing. The over-weight case needs no
    // words — it is visibly the heaviest thing in sight and the red ring says
    // so — and main.js's event table shows these once, then tersely.
    const need = liftClass(best);
    if (need >= LIFT_NEVER) game.beamNoGripWarn = best.name || 'that';
    else if (need > st.tier) game.beamClassWarn = TIERS.labels[need];
    sfx.sfxDenied();
    return 'refused';
  }
  // Moons and worlds have to be winched (config.latchTime); everything else
  // takes hold on the click, exactly as it always did.
  const need = latchTime(best);
  if (need > 0) {
    game.latch = { body: best, t: 0, need };
    sfx.sfxGrab();
    return 'winching';
  }
  grabBody(game, best, 0);
  return 'held';
}

// Commit the grab. `carry` seeds the wind-up timer (see updateLatch). Its
// return value is unused — tryGrab and updateLatch report for it.
function grabBody(game, best, carry = 0) {
  const stolen = !!(best.heldBy && best.heldBy !== 'player');
  if (stolen) {
    // Steal it from an alien
    const al = best.heldBy;
    if (al.target === best) { al.target = null; al.state = 'cooldown'; al.cool = 2; }
  }
  // DEAD STOP (hauler): snatching a rock an alien threw AT you is the
  // counterpunch — the catch primes it (harder fling, flingSpeedFor). Checked
  // BEFORE heldBy/thrown state is cleared below, while the throw is still live.
  if (game.st.deadStop > 0 && best.thrownBy === 'alien' && best.thrownTimer > 0) {
    best.primed = true;
    game.deadStopWarn = true;   // main.js announces (first time only)
  }
  best.heldBy = 'player';
  // A piece of world crust stops being halo rubble the moment you take hold of
  // it: it is your ammunition now, and the halo assist (physics.updateCrust)
  // must never get a say in where it goes afterwards. Cleared HERE rather than
  // left to the assist's own heldBy check, so it is true from the grab itself
  // even when the throw follows in the same frame.
  best.crust = null;
  derail(best);
  unglue(game, best);
  // THE WINCH CREDITS THE WIND-UP BUT NEVER FINISHES IT (CFG.WINDUP_AFTER_LATCH).
  // Carried in full, a 4.0s winch covered the entire ramp and a world hit full
  // power the instant it latched — two mechanics collapsed into one number, and
  // the READY signal with nothing left to announce. Credit as much of the winch
  // as still leaves WINDUP_AFTER_LATCH to run.
  const heft = clamp(best.mass / Math.max(1, game.st.capacity), 0, 1);
  const windupWindow = CFG.TRACTOR_SPOOL * (0.3 + 0.7 * heft);
  best.holdT = Math.min(carry, Math.max(0, windupWindow - CFG.WINDUP_AFTER_LATCH));
  if (game.held) game.held2 = best; else game.held = best;   // Twin Grip: fill the open slot

  // XP: every catch pays. Heavy catches (relative to current capacity) pay
  // most; re-catching the same rock pays less each time so you can't farm one
  // pebble forever. Inside a dense field the same defence fails — there is
  // always a FRESH rock within a beam length — so shoal rock goes through
  // fieldXp (flat damp + the pocket's finite budget) on top of it.
  const w = clamp(best.mass / game.st.capacity, 0.1, 1) / (1 + 0.6 * best.catchCount);
  addXp(game, fieldXp(game, best, PROG.XP_CATCH + 20 * w));
  game.prog.catches++;
  best.catchCount++;
  // ACHIEVEMENTS: one call classifies the whole catch (mass, landmark flags,
  // body type, whether it was stolen out of an alien's beam).
  noteCatch(game, best, stolen);

  // Echo logs: derelicts and oddities carry a one-line lore fragment,
  // recovered the first time the beam touches them (main.js announces it)
  if (best.echo && !best.echoRead) {
    best.echoRead = true;
    game.echoMsg = best.echo;
  }

  sfx.sfxGrab();
  sfx.setBeam(true);
  return true;
}

export function releaseHeld(game, fling) {
  const b = game.held;
  if (!b) return;
  game.held = game.held2 || null;   // Twin Grip: the second rock becomes primary
  game.held2 = null;
  b.heldBy = null;
  b.extAx = 0; b.extAy = 0;
  // Remembered BEFORE anything is cleared — the launch flash is sized on it.
  const wasCharged = game.heldCharged;
  if (!game.held) sfx.setBeam(false);
  if (!b.alive) { clearHoldState(game, b); return; }
  if (fling) {
    // ORDER IS LOAD-BEARING: computeFlingVelocity reads b.primed AND b.holdT —
    // holdT IS the wind-up, and flingSpeedFor treats a null one as "not in the
    // beam", i.e. full power. Clearing before this line hands every throw the
    // full-power multiplier and quietly undoes the whole wind-up.
    const v = computeFlingVelocity(game, b);
    b.vx = v.vx; b.vy = v.vy;
    pushLaunchFx(game, b, v.vx, v.vy, wasCharged);   // muzzle flash
    clearHoldState(game, b);   // …only now
    // ACHIEVEMENTS: the release point is the sniper measuring stick (shatter
    // reads it back), and the prime flag is carried onto the throw so the kill
    // can credit the counterpunch that set it up.
    b.throwX = b.x; b.throwY = b.y;
    b.killedByPrimed = !!b.primed;
    bump(game, 'flings');
    if (game.held) bump(game, 'twinFling');   // held2 was promoted — a second rock is still in hand
    b.primed = false;   // Dead Stop prime is one shot — consumed by this fling
    b.thrownBy = 'player';
    // A rock the PLAYER launched gets the long leash (CFG.THROW_LEASH):
    // `thrownBy` is cleared a second later, so the debris cull needs a mark
    // that outlives the flight. A throw is a deliberate act, and a rock
    // vanishing out from under a shot in flight would be the cull making a
    // decision for the player.
    b.slung = true;
    b.thrownTimer = 4;
    b.throwLock = CFG.THROW_LOCKOUT;   // not a grab target at all until this runs out
    b.chainN = 0;   // YOUR throw is always link 0 (physics.chainOk) — even for a rock that ended a chain
    if (game.st.tether > 0) { b.tether = game.st.tether; b.tetherT = 0; }   // Recovery Tether: it comes home
    game.flingDelayT = 2;   // hold any owed upgrade pick back ~2s so it can't freeze the throw
    if (game.tetherMul > 1.15) game.tetherShow = game.tetherMul;   // main.js announces
    sfx.sfxFling();
  } else {
    b.primed = false;   // a gentle drop wastes the Dead Stop prime — no banking it
    clearHoldState(game, b);   // …and the wind-up with it: a drop is no place to park a charge
    bump(game, 'drops');
    sfx.sfxDrop();
  }
}

// Spring-damper pull toward the hold point; runs every physics substep. Twin Grip
// springs a second rock (game.held2) to a flanking hold point.
export function updateTractor(game, dt) {
  springHeld(game, game.held, dt, 0);
  if (game.held2) springHeld(game, game.held2, dt, 1);
}

function springHeld(game, b, dt, slot) {
  if (!b) return;
  const s = game.ship;
  const st = game.st;
  // HEFT + SPOOL (beamGrip — the same numbers the THROW reads, so the hold and
  // the throw can never disagree). The timer advances only while the rock is
  // actually in the beam, and is reset at the grab: letting go and re-grabbing
  // to dodge the ramp costs you the ramp again. Computed BEFORE the drop test,
  // because whether the beam is fully closed decides whether a drop is even
  // possible.
  b.holdT = (b.holdT || 0) + dt;
  const { heft, f, spool } = beamGrip(st, b);
  // ONCE THE BEAM IS AT FULL POWER THE TETHER CANNOT BE BROKEN (user design
  // law). A hold that has fully closed does not let go because you flew away —
  // it goes TAUT (the rope below) and the ship and the rock fight over the
  // momentum from there. Death still drops it; distance no longer can.
  const atFull = f >= 1;
  if (!b.alive || !s.alive ||
      (!atFull && Math.hypot(b.x - s.x, b.y - s.y) > st.range * 1.6 + b.radius)) {
    dropSlot(game, slot);
    return;
  }
  const hp = holdPoint(game, b, slot ? 0.5 : 0);
  const relX = hp.x - b.x, relY = hp.y - b.y;
  const desVx = relX * 7 + s.vx, desVy = relY * 7 + s.vy;
  let ax = (desVx - b.vx) * 5, ay = (desVy - b.vy) * 5;
  // Authority falls off with the SQUARE of heft, so belt rock handles exactly
  // as it always did and only a load near the top of your class fights you.
  const heftMul = 1 / (1 + CFG.TRACTOR_HEFT * heft * heft);
  // Twin Grip ranks spring the FLANKING rock harder (slot 1); the primary
  // hold is untouched, so ranking the ability never changes single-rock feel.
  const cap = st.force * heftMul * spool * (slot ? st.twinHold : 1) / b.mass;
  const am = Math.hypot(ax, ay);
  if (am > cap) { ax *= cap / am; ay *= cap / am; }
  b.extAx = ax; b.extAy = ay;
  // Render reads this for the beam's own grip cue (drawBeam) — the ramp is
  // invisible otherwise, and a mechanic the player cannot see reads as the beam
  // being broken.
  if (slot) game.heldGrip2 = heftMul * spool; else game.heldGrip = heftMul * spool;
  // THE CHARGE READOUT — a gradient is not a signal. The beam brightening as it
  // spools tells you SOMETHING is happening; it does not tell you the moment
  // your throw is actually at full power, which is the only instant that
  // matters when you are lining up a shot. So the wind-up gets an explicit
  // filling ring and a hard READY state (render.drawCharge).
  // ONLY FOR LOADS WHERE THE WIND-UP COSTS SOMETHING: below CHARGE_SHOW_HEFT a
  // rock is at full power almost immediately and the multiplier is within a few
  // percent of 1, so a ring and a flash on every belt pebble would be pure
  // noise on the loop the player spends most of the game in.
  if (!slot) {
    const wasCharged = game.heldCharged;
    game.heldChargeShow = heft >= CFG.CHARGE_SHOW_HEFT;
    game.heldCharge = f;
    game.heldCharged = game.heldChargeShow && f >= 1;
    // One-shot bloom on the CROSSING, not on the state — the flash is the event.
    if (game.heldCharged && !wasCharged) game.chargeFlashT = CFG.CHARGE_FLASH;
  }

  // Equal-and-opposite tug on the ship (capped so it stays flyable). With Twin
  // Grip both rocks tug, so halve the per-rock cap — combined stays at the 150
  // the design law allows. Twin Grip RANKS only ever shrink it further (down to
  // 0.7x at rank 6): the rig gets steadier, and the combined tug can never
  // climb back toward the cap the law sets.
  const fx = ax * b.mass, fy = ay * b.mass;
  let sax = -fx / 2500, say = -fy / 2500;
  const tugCap = game.held2 ? 75 * st.twinTug : 150;
  const sm = Math.hypot(sax, say);
  if (sm > tugCap) { sax *= tugCap / sm; say *= tugCap / sm; }
  s.vx += sax * dt; s.vy += say * dt;

  // THE ROPE — what an unbreakable tether does instead of snapping.
  //
  // Past CFG.TETHER_MAX_MUL x the beam ring (the ring the player can already
  // SEE, drawShipRings) the hold stops being a spring and becomes a CONSTRAINT:
  // the separating velocity is cancelled and the overshoot is divided between
  // the two by MASS. That is the "fight for momentum" — and against a moon the
  // ship loses it, decisively, because the ship masses 10 and the moon 9,000.
  // What the player then has is their ENGINES against the load's inertia: you
  // tow a boulder slowly and you do not tow a world at all, you swing around it.
  //
  // It can only ever REMOVE separating motion, never add any, so it cannot
  // become a slingshot and cannot inject energy into the sim. The positional
  // correction is bounded by one substep of travel (~6 units at the ship's
  // ceiling), so it can never teleport anything through anything.
  //
  // NOT a violation of the no-recoil law: that law is about the RELEASE — a
  // throw must never shove the ship. Being dragged by something you are still
  // holding is the opposite, and it is the point.
  // IT IS A RUBBER BAND, NOT A WALL (user design call). Arresting everything at
  // one exact radius jolted — you were free, then instantly you were not. So the
  // give lives INSIDE the stated limit rather than beyond it: the band starts to
  // bite at `soft` (CFG.TETHER_STRETCH back from the ceiling) and is fully taut
  // at `maxL`, which keeps "max length ~1.3x the beam ring" literally true while
  // the last stretch of it is spent easing you to a stop.
  //
  // `grab` — the fraction of the separating velocity the band takes this substep
  // — ramps QUADRATICALLY across that stretch. At first contact it takes almost
  // nothing (no jolt); deep in the stretch it takes essentially all of it. The
  // hard positional clamp at maxL then only ever catches the residue, so in
  // practice it does nothing at all.
  if (!atFull) {
    b.ropeL = null;   // no rope until the beam is fully closed
  } else {
    const maxL = st.range * CFG.TETHER_MAX_MUL + b.radius;
    const dx = b.x - s.x, dy = b.y - s.y;
    const d = Math.hypot(dx, dy) || 1;
    // THE ROPE PAYS OUT TO WHERE THE LOAD ALREADY IS, THEN REELS IN.
    //
    // Full power can easily arrive while the rock is ALREADY past the limit —
    // it lags behind during the wind-up, and the winch on a world runs for
    // seconds while you are flying. Sizing the rope at `maxL` on that first
    // substep snapped the load across the whole gap in one frame. So the rope's
    // length is state, seeded at whatever distance it engaged at and hauled in
    // at a bounded CFG.TETHER_REEL — you feel it take up the slack instead of
    // arriving already taut, and it still ends at the stated 1.3x.
    if (b.ropeL == null) b.ropeL = Math.max(maxL, d);
    else b.ropeL = Math.max(maxL, b.ropeL - CFG.TETHER_REEL * dt);
    const lim = b.ropeL;
    const soft = lim * (1 - CFG.TETHER_STRETCH);
    if (d > soft) {
      const nx = dx / d, ny = dy / d;
      const ms = Math.max(1, s.mass), mb = Math.max(1, b.mass);
      const t = clamp((d - soft) / (lim - soft), 0, 1);
      const grab = t * t;
      const sep = (b.vx - s.vx) * nx + (b.vy - s.vy) * ny;
      if (sep > 0) {                       // only while they are pulling APART
        const j = (grab * sep) / (1 / ms + 1 / mb);
        s.vx += (j / ms) * nx; s.vy += (j / ms) * ny;
        b.vx -= (j / mb) * nx; b.vy -= (j / mb) * ny;
      }
      if (d > lim) {
        // The backstop, and it acts against the LIVE rope length — never
        // against maxL, or it would be the instant snap all over again.
        // Heavier body moves less: the ship takes mb/(ms+mb).
        const over = d - lim;
        s.x += nx * over * (mb / (ms + mb)); s.y += ny * over * (mb / (ms + mb));
        b.x -= nx * over * (ms / (ms + mb)); b.y -= ny * over * (ms / (ms + mb));
      }
    }
  }
}

// Auto-drop the rock in the given slot (it died or drifted out of range).
function dropSlot(game, slot) {
  if (slot === 0) { releaseHeld(game, false); return; }   // drops held, promotes held2
  const b = game.held2;
  game.held2 = null;
  if (b) { b.heldBy = null; clearHoldState(game, b); }
}

// ---------- orbit shield ----------

// Ring assignment for the whole formation: orbiters are sorted by size and
// packed outward — smallest hugging the ship, largest patrolling the far
// edge. Each ring clears the previous rock's bulk, so a full orbit of mixed
// sizes stacks out to roughly 3x the old single-ring distance.
function orbiterRings(game) {
  const rings = new Map();
  const base = game.ship.radius + 40 + 12 * game.st.orbitLvl;
  let R = base;
  const sorted = [...game.orbit].sort((a, b) => a.radius - b.radius);
  for (const b of sorted) {
    R += b.radius * 1.6 + 14;
    rings.set(b, Math.min(R, base + 400));   // soft cap keeps the far edge sane
    R += b.radius;
  }
  return rings;
}

// Move the held object into your defensive orbit (if it's small enough).
export function addToOrbit(game) {
  const b = game.held;
  const st = game.st;
  if (!b || !b.alive || b.type === 'nest') return false;   // nests never orbit you
  // Same two-part gate as the beam, one class lower (config.canStow).
  if (!canStow(st, b) || game.orbit.length >= st.maxOrbiters) return false;
  game.held = game.held2 || null;   // Twin Grip: promote the second rock
  game.held2 = null;
  b.heldBy = 'orbit';
  b.thrownBy = null; b.thrownTimer = 0;
  b.primed = false;   // stowing wastes the Dead Stop prime — the ring can't bank it
  b.holdT = null;     // the ring is exempt from the wind-up (design law) — see beamGrip
  // The tractor capture spins the rock up — captured bodies visibly whirl
  // (ambient spin is a sleepy ±0.3 rad/s)
  b.spin = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.4);
  game.orbit.push(b);
  addXp(game, fieldXp(game, b, PROG.XP_ORBIT));   // stowing a rock into the shield pays XP (damped in a shoal)
  bump(game, 'stows');
  sfx.setBeam(false);
  sfx.sfxOrbitCapture();
  return true;
}

// RECOVERY TETHER (hauler): a rock you throw flies out, then curves back and
// drops into your orbit shield if a slot fits — a boomerang. Runs every substep.
export function updateTethers(game, dt) {
  const s = game.ship, st = game.st;
  if (!st.tether) return;   // no tethered rocks exist unless you have the ability
  for (const b of game.bodies) {
    if (!b.tether) continue;
    if (!b.alive || b.heldBy) { b.tether = 0; continue; }   // dead / re-grabbed / already orbited
    b.tetherT = (b.tetherT || 0) + dt;
    if (b.tetherT < 0.7) continue;                          // let it fly out first
    const dx = s.x - b.x, dy = s.y - b.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < s.radius + 90) {                                // home — capture into orbit if there's room
      b.tether = 0;
      if (s.alive && canStow(st, b) && game.orbit.length < st.maxOrbiters) {
        b.thrownBy = null; b.thrownTimer = 0; b.heldBy = 'orbit'; b.holdT = null;
        b.spin = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.4);
        game.orbit.push(b);
        bump(game, 'tetherBack');
        sfx.sfxOrbitCapture();
      }
      continue;                                             // no room -> it just drifts free
    }
    // Steer toward the ship at a BOUNDED return speed (spring-damper toward a
    // desired velocity, like the tractor hold) — it converges like a boomerang
    // and never accumulates speed, so a tether that never lands can't sandblast
    // the belt. Faster return with rank.
    const returnSpd = 300 + 60 * b.tether;
    const desVx = (dx / d) * returnSpd + s.vx, desVy = (dy / d) * returnSpd + s.vy;
    b.vx += (desVx - b.vx) * 3 * dt; b.vy += (desVy - b.vy) * 3 * dt;
    if (b.tetherT > 6) b.tether = 0;                        // give up eventually
  }
}

// LMB with nothing under the cursor: take the orbiter nearest your aim back
// into the beam — held and individually throwable again.
export function retrieveFromOrbit(game) {
  if (!game.orbit.length || !game.ship.alive || game.held) return false;
  const s = game.ship;
  const aimAng = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  let best = 0, bd = Infinity;
  game.orbit.forEach((b, i) => {
    const d = Math.abs(angDiff(Math.atan2(b.y - s.y, b.x - s.x), aimAng));
    if (d < bd) { bd = d; best = i; }
  });
  const b = game.orbit.splice(best, 1)[0];
  b.heldBy = 'player';
  b.orbitAng = undefined;
  b.holdT = 0;   // back in the beam is a fresh hold — it spools up again (springHeld)
  game.held = b;
  bump(game, 'retrieves');
  sfx.sfxGrab();
  sfx.setBeam(true);
  return true;
}

// Which orbiters leave first when the shotgun fires: the ones best lined up
// with the aim direction. Render uses this too, to highlight the armed set.
export function volleyPick(game, count) {
  const s = game.ship;
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
  return [...game.orbit].sort((x, y) =>
    Math.abs(angDiff(Math.atan2(x.y - s.y, x.x - s.x), ang)) -
    Math.abs(angDiff(Math.atan2(y.y - s.y, y.x - s.x), ang)))
    .slice(0, Math.min(count, game.orbit.length));
}

// SHOTGUN: fire `count` orbiters (default: everything) at the cursor in a
// tight spread. Holding RMB arms more of them; release pulls the trigger.
export function flingAllFromOrbit(game, count = Infinity) {
  if (!game.orbit.length || !game.ship.alive) return 0;
  const s = game.ship;
  const st = game.st;
  const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);   // straight at the cursor
  const rocks = volleyPick(game, count);
  game.orbit = game.orbit.filter((b) => !rocks.includes(b));
  const n = rocks.length;
  rocks.forEach((b, i) => {
    b.heldBy = null;
    b.orbitAng = undefined;
    b.extAx = 0; b.extAy = 0;
    const speed = flingSpeedFor(game, b.mass) * st.volleySpeed;
    const a = ang + (i - (n - 1) / 2) * st.volleySpread;
    b.vx = s.vx + Math.cos(a) * speed;
    b.vy = s.vy + Math.sin(a) * speed;
    // Every pellet gets its own muzzle flash — a volley should read as a volley,
    // and LAUNCH_FX_MAX is sized to hold a full seven-slot ring firing at once.
    pushLaunchFx(game, b, b.vx, b.vy, false);
    b.thrownBy = 'player';
    // A rock the PLAYER launched gets the long leash (CFG.THROW_LEASH):
    // `thrownBy` is cleared a second later, so the debris cull needs a mark
    // that outlives the flight. A throw is a deliberate act, and a rock
    // vanishing out from under a shot in flight would be the cull making a
    // decision for the player.
    b.slung = true;
    b.thrownTimer = 4;
    b.throwLock = CFG.THROW_LOCKOUT;  // same lockout as a single throw (see releaseHeld)
    b.chainN = 0;                     // link 0, like releaseHeld
    b.throwX = b.x; b.throwY = b.y;   // volley pellets can snipe too (see releaseHeld)
  });
  if (n) {
    game.flingDelayT = 2;   // same post-fling grace as a single throw (see releaseHeld)
    bump(game, 'volleys');
    best(game, 'volleyBest', n);
  }
  sfx.sfxFling();
  sfx.sfxBoom(1.5);
  return n;
}

// Spring each orbiter to its rotating slot; runs every physics substep.
export function updateOrbit(game, dt) {
  const s = game.ship;
  // Drop dead/stolen orbiters; release everything if the ship dies
  if (game.orbit.length) {
    game.orbit = game.orbit.filter((b) => {
      if (b.alive && b.heldBy === 'orbit' && s.alive) return true;
      if (b.heldBy === 'orbit') { b.heldBy = null; b.extAx = 0; b.extAy = 0; }
      b.orbitAng = undefined;
      return false;
    });
  }
  if (!game.orbit.length) return;

  const n = game.orbit.length;

  // BRAWLER TRAIL STOW (st.trailStow): captured rocks don't orbit — they hang
  // in a loose staggered pack BEHIND the ship, packed nose-to-tail down the
  // wake. It's an ammo train for the shotgun, NOT a shield: no interception
  // (the brawler's protection is its front-arc plating — though the pack does
  // incidentally eat shots that come in through the wake). Slots swing with
  // the nose; the bounded approach speed below makes the tail drag through
  // turns instead of snapping, which is the whole look.
  if (game.st.trailStow) {
    const bx = -Math.cos(s.angle), by = -Math.sin(s.angle);   // aft axis
    const px = -by, py = bx;                                  // lateral axis
    let dist = s.radius * 2 + 34;
    for (let i = 0; i < n; i++) {
      const b = game.orbit[i];
      const phase = b.id * 1.73;
      dist += b.radius;
      // Stagger alternate rocks either side of the wake, with a soft organic
      // sway (same breathing idiom as the ring slots).
      const side = i % 2 === 0 ? 1 : -1;
      const lat = side * (b.radius * 0.55 + 10) + Math.sin(game.time * 0.8 + phase) * 6;
      const sway = Math.sin(game.time * 0.6 + phase * 2.1) * 8;
      const tx = s.x + bx * (dist + sway) + px * lat;
      const ty = s.y + by * (dist + sway) + py * lat;
      dist += b.radius * 1.15 + 12;
      // Same bounded spring as the ring path: capped approach speed, then
      // capped acceleration authority scaled by the beam force vs rock mass.
      let dvx = (tx - b.x) * 4.5, dvy = (ty - b.y) * 4.5;
      const dm = Math.hypot(dvx, dvy);
      if (dm > 380) { dvx *= 380 / dm; dvy *= 380 / dm; }
      const desVx = dvx + s.vx, desVy = dvy + s.vy;
      let ax = (desVx - b.vx) * 3.5, ay = (desVy - b.vy) * 3.5;
      const cap = Math.min(900, Math.max(260, (game.st.force * 1.5) / b.mass));
      const am = Math.hypot(ax, ay);
      if (am > cap) { ax *= cap / am; ay *= cap / am; }
      b.extAx = ax; b.extAy = ay;
    }
    return;
  }

  const rings = orbiterRings(game);

  // Active interception: ANY loose rock closing on the ship gets met by the
  // nearest shield rock, which breaks formation and lunges. Alien throws are
  // engaged the moment they're closing; neutral rocks only when they're
  // coming in fast enough to matter (belt drift is harmless).
  let threat = null, bestTti = Infinity;
  for (const b of game.bodies) {
    if (!b.alive || b.heldBy) continue;
    if (b.type === 'star' || b.type === 'planet' || b.type === 'rogue' || b.mass > 9000) continue;
    if (b.thrownBy === 'player' && b.thrownTimer > 0) continue;   // our own shots
    const dx = b.x - s.x, dy = b.y - s.y;
    // Tight defense perimeter — the scan reruns every substep, so a threat
    // drifting back out of this radius releases its interceptor immediately.
    // (Cheap axis reject first: this loop runs over every body at 120Hz.)
    if (dx > 520 || dx < -520 || dy > 520 || dy < -520) continue;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 520) continue;
    const rvx = b.vx - s.vx, rvy = b.vy - s.vy;
    const closing = -(rvx * dx + rvy * dy) / (d || 1);
    const alienShot = b.thrownBy === 'alien' && b.thrownTimer > 0;
    if (closing < (alienShot ? 40 : 140)) continue;
    // Neutral rocks must actually be on a collision course, not just fast —
    // otherwise the shield spends all day chasing belt traffic that would miss
    const miss = Math.abs(dx * rvy - dy * rvx) / (Math.hypot(rvx, rvy) || 1);
    if (!alienShot && miss > 130) continue;
    const tti = d / closing;   // engage whatever hits soonest
    if (tti < bestTti) { threat = b; bestTti = tti; }
  }
  let interceptorIdx = -1;
  if (threat) {
    // Best blocker = the orbiter already nearest the threat's incoming LINE
    // (not nearest the rock itself) — with only a small allowed shift, a
    // defender on the wrong side of the formation can never reach the path.
    let bd = Infinity;
    const tvm = Math.hypot(threat.vx - s.vx, threat.vy - s.vy) || 1;
    const ux = (threat.vx - s.vx) / tvm, uy = (threat.vy - s.vy) / tvm;
    for (let i = 0; i < n; i++) {
      const px = game.orbit[i].x - threat.x, py = game.orbit[i].y - threat.y;
      const ahead = px * ux + py * uy > 0;
      const d = ahead ? Math.abs(px * uy - py * ux) : Math.hypot(px, py);
      if (d < bd) { bd = d; interceptorIdx = i; }
    }
  }

  for (let i = 0; i < n; i++) {
    const b = game.orbit[i];
    // Loose, organic slots: each rock breathes in and out and drifts around
    // its nominal position instead of sitting pinned on a rail.
    const phase = b.id * 1.73;
    const Ri = rings.get(b) * (1 + 0.13 * Math.sin(game.time * 0.7 + phase));
    // Each ring spins at its own rate so the SLOT's linear speed stays
    // constant — a shared angular speed makes outer slots move faster than
    // the approach cap and big rocks can never catch them. ROCKWALL (hauler)
    // spins the whole wall faster, so more of the sky is covered per second.
    const w = CFG.ORBIT_OMEGA * (1 + 0.11 * (game.st.rockwall || 0)) * Math.min(1, 80 / Ri);
    b.orbitAng = (b.orbitAng ?? Math.atan2(b.y - s.y, b.x - s.x)) + w * dt;
    const ang = b.orbitAng + 0.25 * Math.sin(game.time * 0.5 + phase * 2.1);
    let tx = s.x + Math.cos(ang) * Ri;
    let ty = s.y + Math.sin(ang) * Ri;
    if (i === interceptorIdx) {
      // BLOCK, don't chase: the defender only shifts a bounded distance
      // from its own slot toward the threat's incoming line — a shield
      // wall bracing, not a hunter leaving formation.
      const lx = threat.x + threat.vx * 0.12 - tx;
      const ly = threat.y + threat.vy * 0.12 - ty;
      const lm = Math.hypot(lx, ly) || 1;
      const lim = Math.min(lm, 80 + 25 * game.st.orbitLvl);
      tx += (lx / lm) * lim;
      ty += (ly / lm) * lim;
    }
    // Cap the approach speed — an uncapped spring slings new orbiters through
    // the belt at 1000+ u/s and they shatter on bystanders before settling.
    // Interceptors are allowed to move much faster.
    const intercepting = i === interceptorIdx;
    const maxApproach = intercepting ? 600 : 380;
    let dvx = (tx - b.x) * 4.5, dvy = (ty - b.y) * 4.5;
    const dm = Math.hypot(dvx, dvy);
    if (dm > maxApproach) { dvx *= maxApproach / dm; dvy *= maxApproach / dm; }
    const desVx = dvx + s.vx, desVy = dvy + s.vy;
    let ax = (desVx - b.vx) * (intercepting ? 10 : 3.5), ay = (desVy - b.vy) * (intercepting ? 10 : 3.5);
    // Holding a circle takes real centripetal authority (v²/R) on top of
    // formation-keeping — the floor must cover it or heavy rocks lag into
    // a trailing pursuit circle far inside their assigned ring.
    const cap = intercepting ? 1600
      : Math.min(900, Math.max(260, (game.st.force * 1.5) / b.mass));
    const am = Math.hypot(ax, ay);
    if (am > cap) { ax *= cap / am; ay *= cap / am; }
    b.extAx = ax; b.extAy = ay;
  }
}
