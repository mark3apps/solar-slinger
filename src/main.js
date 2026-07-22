import { CFG, GROWTH, newProgress, shipStats } from './config.js';
import { Ship } from './entities.js';
import { generateWorld, respawnShip, replenishWorld } from './world.js';
import { step } from './physics.js';
import { updateTractor, updateOrbit, tryGrab, releaseHeld, addToOrbit, flingAllFromOrbit, retrieveFromOrbit, aimSolutions } from './tractor.js';
import { updateAliens } from './ai.js';
import { initRender, render } from './render.js';
import * as hud from './hud.js';
import { initInput, readControls, mouseWorld } from './input.js';
import { setThrust } from './sfx.js';
import { lerp } from './util.js';

const game = {
  time: 0,
  paused: false,
  ship: new Ship(),
  bodies: [],
  aliens: [],
  debris: [],
  particles: [],
  flares: [],              // solar plasma in flight
  bolts: [],               // Bastion turret fire in flight
  scrap: 0,
  prog: newProgress(),     // upgrades are automatic — this is the ship's growth
  st: null,
  held: null,
  orbit: [],               // bodies circling the ship as a shield
  orbitAngle: 0,
  aim: { x: 0, y: 0 },
  controls: { f: 0, b: 0 },
  cam: { x: 0, y: 0, zoom: 1.15 },
  zoomCur: 1.15,           // animated camera zoom (no manual control)
  shake: 0,
  predict: true,
  deathCause: '',
  spawn: null,
  homeStar: null,
  alienTimer: 0,
  alienWarn: 0,
  asteroidTimer: 10,
  alienKills: 0,
  lastDamage: -99,
  tooHeavy: null,
  tooHeavyT: 0,
  lastTier: 0,
  oortWarnT: 0,
  volleyT: 0,
  volleySel: 0,            // how many orbiters the shotgun charge has armed
  volleyCharging: false,
  lockTarget: null,
  tut: { grabbed: false, flung: false, orbited: false, alienSeen: false },
};

game.st = shipStats(game.prog);
generateWorld(game);
game.cam.x = game.ship.x; game.cam.y = game.ship.y;

const canvas = document.getElementById('game');
const view = initRender(canvas);
hud.initHud(game);

// Fire the shotgun: launches however many orbiters the charge has armed
function fireVolley() {
  const n = flingAllFromOrbit(game, game.volleySel || game.orbit.length);
  if (n) hud.message(`SHOTGUN — ${n} rock${n > 1 ? 's' : ''} away!`, 2);
  game.volleyT = 0;
  game.volleySel = 0;
  game.volleyCharging = false;
}

initInput(canvas, {
  onGrab: () => {
    if (game.paused || !game.ship.alive) return;
    if (tryGrab(game)) {
      // Anything that fits your orbit is captured into it automatically
      const b = game.held;
      if (b.mass <= game.st.orbitCap && game.orbit.length < game.st.maxOrbiters) {
        addToOrbit(game);
        if (!game.tut.orbited) {
          game.tut.orbited = true;
          hud.message('Captured into your orbit! It shields you. Hold RIGHT MOUSE to charge a shotgun — longer hold arms more rocks.', 5);
        }
      } else if (!game.tut.grabbed) {
        game.tut.grabbed = true;
        hud.message('Got it! RELEASE to FLING it toward the cursor. Every catch strengthens your beam.', 5);
      }
    } else if (retrieveFromOrbit(game)) {
      if (!game.tut.retrieved) {
        game.tut.retrieved = true;
        hud.message('Rock pulled back from your orbit — release to fling it.', 4);
      }
    }
  },
  onFling: () => {
    if (game.held) {
      releaseHeld(game, true);
      if (!game.tut.flung) {
        game.tut.flung = true;
        hud.message('Smash things to break them into golden scrap — it heals and toughens you.', 5);
      }
    }
  },
  onRmbDown: () => {
    if (game.held) {
      // Send the held rock (back) into your orbit; too big -> gentle drop
      if (!addToOrbit(game)) releaseHeld(game, false);
      return;
    }
    if (game.orbit.length) game.volleyCharging = true;
  },
  onRmbUp: () => {
    // Release fires whatever the hold has armed (a tap = 1 rock)
    if (game.volleyCharging && game.orbit.length && game.ship.alive) fireVolley();
    game.volleyCharging = false;
  },
  onTogglePause: () => {
    game.paused = !game.paused;
    hud.setPauseVisible(game.paused);
  },
  onRespawn: () => {
    if (!game.ship.alive) {
      // Death penalty: some toughness is lost with the wreck
      game.prog.maxHull = Math.max(100, game.prog.maxHull * 0.8);
      game.st = shipStats(game.prog);
      respawnShip(game);
      hud.setDeathVisible(false);
    }
  },
  onTogglePredict: () => { game.predict = !game.predict; },
});

// Opening guidance
setTimeout(() => hud.message('You are in orbit inside the belt. The ship follows your mouse — W forward, S reverse.', 6), 800);
setTimeout(() => {
  if (!game.tut.grabbed) hud.message('HOLD LEFT MOUSE near an asteroid to tractor-grab it.', 5);
}, 9000);

let last = performance.now();
let acc = 0;

function update(dtReal) {
    game.time += dtReal;

    // Derived stats track progression continuously; the hull grows with you,
    // and the camera pulls back so the system shrinks as you level.
    game.st = shipStats(game.prog);
    game.ship.radius = game.st.radius;
    // Cinematic zoom: ease toward the level-driven target instead of
    // snapping — leveling up feels like slowly zooming out of the universe
    const zoomTarget = 1.15 / game.st.zoomOut;
    game.zoomCur = lerp(game.zoomCur, zoomTarget, 1 - Math.exp(-0.5 * dtReal));
    game.cam.zoom = game.zoomCur;
    if (game.st.tier > game.lastTier) {
      game.lastTier = game.st.tier;
      const orbitNote = ` Your orbit now holds ${game.st.orbitLabel.toLowerCase()}.`;
      hud.message(`BEAM STRENGTHENED: you can now grab ${game.st.label.toUpperCase()}.${orbitNote}`, 6);
    }

    // Per-frame inputs & AI
    readControls(game);
    const { vw, vh } = view.getView();
    const m = mouseWorld(game, vw, vh);
    game.aim.x = m.x; game.aim.y = m.y;
    // World-space radius of the current view — the local asteroid spawner
    // keeps rocks in a ring just beyond this
    game.viewR = Math.hypot(vw, vh) / 2 / game.cam.zoom;
    updateAliens(game, dtReal);

    // Fixed-step physics
    acc += dtReal;
    while (acc >= CFG.DT) {
      updateTractor(game, CFG.DT);
      updateOrbit(game, CFG.DT);
      step(game, CFG.DT);
      acc -= CFG.DT;
    }

    const s = game.ship;

    // SLINGSHOT: pass through a planet's well without touching the throttle
    // and leave faster than you entered — clean flying feeds the engines.
    if (s.alive) {
      let inWell = null;
      for (const b of game.bodies) {
        if (!b.alive || b.type !== 'planet') continue;
        if (Math.hypot(b.x - s.x, b.y - s.y) < b.radius * 5 + 600) { inWell = b; break; }
      }
      const sp = Math.hypot(s.vx, s.vy);
      if (inWell) {
        if (!game.sling || game.sling.planet !== inWell) {
          game.sling = { planet: inWell, entry: sp, thrusted: false };
        }
        if (game.controls.f || game.controls.b) game.sling.thrusted = true;
      } else if (game.sling) {
        const gain = Math.round(sp - game.sling.entry);
        if (!game.sling.thrusted && gain > 50) {
          game.prog.dv += gain * 8;   // counts as delta-v earned, not spent
          game.prog.thrust = Math.min(GROWTH.THRUST_MAX,
            GROWTH.THRUST_BASE + GROWTH.THRUST_SCALE * Math.sqrt(game.prog.dv / GROWTH.THRUST_DIV));
          hud.message(`SLINGSHOT! +${gain} speed — the gravity assist feeds your engines.`, 3);
        }
        game.sling = null;
      }
    } else {
      game.sling = null;
    }

    // Hull regen after a quiet spell
    if (s.alive && game.time - game.lastDamage > CFG.SHIP_REGEN_DELAY && s.hull < game.st.maxHull) {
      s.hull = Math.min(game.st.maxHull, s.hull + CFG.SHIP_REGEN * dtReal);
    }

    replenishWorld(game, dtReal);

    // Oort cloud proximity warning
    if (game.oortWarnT > 0) game.oortWarnT -= dtReal;
    if (s.alive) {
      const rc = Math.hypot(s.x, s.y);
      if (rc > CFG.WORLD_R - CFG.OORT_WARN && game.oortWarnT <= 0) {
        game.oortWarnT = 12;
        hud.message(rc > CFG.WORLD_R
          ? 'HULL GRINDING — you are inside the Oort cloud. Turn back!'
          : 'WARNING: Oort cloud ahead — it will tear your ship apart.', 4.5);
      }
    }

    // Shotgun charge: the hold progressively ARMS orbiters (1 at a tap, all
    // at full charge); reaching full charge pulls the trigger automatically
    if (game.volleyCharging && game.orbit.length && s.alive) {
      game.volleyT += dtReal;
      game.volleySel = Math.max(1, Math.min(game.orbit.length,
        Math.ceil((game.volleyT / CFG.VOLLEY_TIME) * game.orbit.length)));
      if (game.volleyT >= CFG.VOLLEY_TIME) fireVolley();
    } else {
      game.volleyT = 0;
      game.volleySel = 0;
      if (!game.orbit.length) game.volleyCharging = false;
    }

    // Lead-point solve for the UI. The throw itself always goes at the
    // cursor — these are the ✕ markers showing where a release WOULD hit
    // each nearby mover, plus which one the current aim already satisfies.
    if (s.alive && (game.held || game.volleyCharging)) {
      game.lock = aimSolutions(game);
      game.lockTarget = game.lock.hot ? game.lock.hot.target : null;
    } else {
      game.lock = null;
      game.lockTarget = null;
    }

    // Timers & one-shot messages
    if (game.tooHeavyT > 0) game.tooHeavyT -= dtReal;
    if (game.alienWarn > 0) {
      if (!game.tut.alienSeen) {
        game.tut.alienSeen = true;
        hud.message('WARNING: alien grabbers inbound — they throw rocks. Your orbit shield can block them.', 5);
      }
      game.alienWarn = 0;
    }
    if (game.rogueIncoming) {
      game.rogueIncoming = 0;
      hud.message('SENSOR ALERT: a rogue planet has entered the sector.', 4.5);
    }
    if (game.tetherShow) {
      hud.message(game.tut.tether
        ? `TETHER THROW! ×${game.tetherShow.toFixed(2)}`
        : `TETHER THROW ×${game.tetherShow.toFixed(2)} — boosting while flinging whip-cracks the rock with your momentum.`,
      game.tut.tether ? 1.8 : 4.5);
      game.tut.tether = true;
      game.tetherShow = 0;
    }
    if (game.cometWarn) {
      game.cometWarn = false;
      hud.message(game.tut.comet
        ? 'COMET SHOWER inbound!'
        : 'COMET SHOWER — fast ice crossing your sector. Dangerous, but premium shield ammo and 4x scrap.',
      game.tut.comet ? 3 : 5.5);
      game.tut.comet = true;
    }
    if (game.flareWarn) {
      game.flareWarn = false;
      hud.message(game.tut.flare
        ? 'SOLAR FLARE INBOUND!'
        : 'SOLAR FLARE — the sun is erupting at you. MOVE!', game.tut.flare ? 2.5 : 4.5);
      game.tut.flare = true;
    }
    if (game.magmaWarn) {
      game.magmaWarn = false;
      if (!game.tut.magma) {
        game.tut.magma = true;
        hud.message('MAGMA EJECTION — lava worlds hurl molten rock. It cools into dense fling ammo.', 5);
      }
    }
    if (game.geyserWarn) {
      game.geyserWarn = false;
      if (!game.tut.geyser) {
        game.tut.geyser = true;
        hud.message('Cryo-geyser! Ice worlds pop free shield ammo into low orbit.', 5);
      }
    }
    if (game.skimT > 0 && !game.tut.skim) {
      game.tut.skim = true;
      hud.message("CLOUD SKIMMING — the cloud tops sling you forward. Don't dip too deep.", 5);
    }
    if (game.nestKilled) {
      game.nestKilled = false;
      hud.message('ALIEN NEST DESTROYED — this region of space is quiet now.', 6);
    }
    if (game.wrightWarn) {
      game.wrightWarn = false;
      hud.message(game.tut.wright
        ? 'WRECKWRIGHT descending on the debris field!'
        : 'WRECKWRIGHT — a scavenger is harvesting your battle debris. Kill it before it finishes building.',
      game.tut.wright ? 3 : 5.5);
      game.tut.wright = true;
    }
    if (game.golemWarn) {
      game.golemWarn = false;
      hud.message('SCRAP-GOLEM assembled — your leftovers are hunting you.', 4.5);
    }
    if (game.fortShieldDownName) {
      hud.message(`FORTRESS SHIELD DOWN at ${game.fortShieldDownName} — smash the turrets!`, 4);
      game.fortShieldDownName = null;
    }
    if (game.fortLiberatedName) {
      hud.message(`${game.fortLiberatedName.toUpperCase()} LIBERATED — the Bastion fort is destroyed. Salvage is yours.`, 5);
      game.fortLiberatedName = null;
    }
    if (game.emberWarn) {
      game.emberWarn = false;
      if (!game.tut.ember) {
        game.tut.ember = true;
        hud.message('EMBERKIN ARTILLERY — this world is colonized. Icy rocks smother the reefs.', 5.5);
      }
    }
    if (game.emberSeededName) {
      hud.message(`The Emberkin have seeded ${game.emberSeededName} — the bloom is spreading.`, 5.5);
      game.emberSeededName = null;
    }
    if (game.emberCleansedName) {
      hud.message(`${game.emberCleansedName} cleansed — the Emberkin bloom is extinguished.`, 5);
      game.emberCleansedName = null;
    }
    if (!s.alive && game.deathCause && !game.deathShown) {
      game.deathShown = true;
      hud.setDeathVisible(true, game.deathCause);
    }
    if (s.alive && game.deathShown) game.deathShown = false;

    setThrust(s.alive && (s.thrusting || s.braking));

    // Camera follows ship
    game.cam.x = lerp(game.cam.x, s.x, 1 - Math.exp(-6 * dtReal));
    game.cam.y = lerp(game.cam.y, s.y, 1 - Math.exp(-6 * dtReal));
    game.shake *= Math.exp(-7 * dtReal);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!game.paused) update(dtReal);
  else setThrust(false);

  render(game);
  hud.updateHud(game);
}

requestAnimationFrame(frame);

// Debug/testing hooks: poke at state or step the sim from devtools
window.game = game;
window.tick = (seconds) => {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) update(dt);
  render(game);
  hud.updateHud(game);
};
