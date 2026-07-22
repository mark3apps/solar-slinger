import { CFG, shipStats } from './config.js';
import { Ship } from './entities.js';
import { generateWorld, respawnShip, replenishAsteroids } from './world.js';
import { step } from './physics.js';
import { updateTractor, tryGrab, releaseHeld } from './tractor.js';
import { updateAliens } from './ai.js';
import { initRender, render } from './render.js';
import * as hud from './hud.js';
import { input, initInput, readControls, mouseWorld, zoomBy } from './input.js';
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
  scrap: 0,
  up: { capacity: 0, power: 0, engine: 0, hull: 0 },
  st: null,
  held: null,
  aim: { x: 0, y: 0 },
  controls: { f: 0, b: 0, l: 0, r: 0 },
  cam: { x: 0, y: 0, zoom: 0.7 },
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
  upOpen: false,
  tooHeavy: null,
  tooHeavyT: 0,
  tut: { grabbed: false, flung: false, upgraded: false, alienSeen: false },
};

game.st = shipStats(game.up);
generateWorld(game);
game.cam.x = game.ship.x; game.cam.y = game.ship.y;

const canvas = document.getElementById('game');
const view = initRender(canvas);
hud.initHud(game);

initInput(canvas, {
  onGrab: () => {
    if (game.paused || !game.ship.alive) return;
    if (tryGrab(game) && !game.tut.grabbed) {
      game.tut.grabbed = true;
      hud.message('Got it! RELEASE the mouse button to FLING it, right-click to drop gently.', 5);
    }
  },
  onFling: () => {
    if (game.held) {
      releaseHeld(game, true);
      if (!game.tut.flung) {
        game.tut.flung = true;
        hud.message('Smash things together to break them into golden scrap — fly close to collect it.', 5);
      }
    }
  },
  onDrop: () => releaseHeld(game, false),
  onZoom: (dy) => zoomBy(game, dy),
  onToggleUpgrades: () => hud.toggleUpgrades(game),
  onTogglePause: () => {
    game.paused = !game.paused;
    hud.setPauseVisible(game.paused);
  },
  onRespawn: () => {
    if (!game.ship.alive) {
      game.scrap = Math.floor(game.scrap * 0.75);
      respawnShip(game);
      hud.setDeathVisible(false);
    }
  },
  onTogglePredict: () => { game.predict = !game.predict; },
});

// Opening guidance
setTimeout(() => hud.message('You are in orbit. W A S D to fly, mouse to aim. The dotted line is your future path.', 6), 800);
setTimeout(() => {
  if (!game.tut.grabbed) hud.message('HOLD LEFT MOUSE near an asteroid to tractor-grab it.', 5);
}, 9000);

let last = performance.now();
let acc = 0;

function update(dtReal) {
    game.time += dtReal;

    // Per-frame inputs & AI
    readControls(game);
    const m = mouseWorld(game, view.getView().vw, view.getView().vh);
    game.aim.x = m.x; game.aim.y = m.y;
    updateAliens(game, dtReal);

    // Fixed-step physics
    acc += dtReal;
    while (acc >= CFG.DT) {
      updateTractor(game, CFG.DT);
      step(game, CFG.DT);
      acc -= CFG.DT;
    }

    // Hull regen after a quiet spell
    const s = game.ship;
    if (s.alive && game.time - game.lastDamage > CFG.SHIP_REGEN_DELAY && s.hull < game.st.maxHull) {
      s.hull = Math.min(game.st.maxHull, s.hull + CFG.SHIP_REGEN * dtReal);
    }

    replenishAsteroids(game, dtReal);

    // Timers & one-shot messages
    if (game.tooHeavyT > 0) game.tooHeavyT -= dtReal;
    if (game.alienWarn > 0) {
      if (!game.tut.alienSeen) {
        game.tut.alienSeen = true;
        hud.message('WARNING: alien grabbers inbound — they throw rocks. Throw back harder.', 5);
      }
      game.alienWarn = 0;
    }
    if (!game.tut.upgraded && game.scrap >= 50) {
      game.tut.upgraded = true;
      hud.message('Press E to open SHIP UPGRADES — bigger tractors grab moons, then planets.', 5);
    }
    if (!s.alive && game.deathCause && !game.deathShown) {
      game.deathShown = true;
      hud.setDeathVisible(true, game.deathCause);
    }
    if (s.alive && game.deathShown) game.deathShown = false;

    setThrust(s.alive && s.thrusting);

    // Camera follows ship
    game.cam.x = lerp(game.cam.x, s.x, 1 - Math.exp(-6 * dtReal));
    game.cam.y = lerp(game.cam.y, s.y, 1 - Math.exp(-6 * dtReal));
    game.shake *= Math.exp(-7 * dtReal);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!game.paused && !game.upOpen) update(dtReal);
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
