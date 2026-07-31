import {
  CFG, PROG, SPECS, newProgress, shipStats, maxLives,
  addXp, owesPick, xpForPick, pickIsMilestone, tierChoices,
  consumePickCost, applyAbility, applySpec, applyTierUp,
} from './config.js';
import { Ship } from './entities.js';
import { generateWorld, respawnShip, replenishWorld, spawnLifePod } from './world.js';
import { step } from './physics.js';
import { updateTractor, updateOrbit, updateTethers, tryGrab, releaseHeld, addToOrbit, flingAllFromOrbit, retrieveFromOrbit, aimSolutions } from './tractor.js';
import { updateAliens } from './ai.js';
import { updateGlow } from './glow.js';
import { initRender, render } from './render.js';
import * as hud from './hud.js';
import { initInput, input, readControls, mouseWorld } from './input.js';
import * as sfx from './sfx.js';
import * as music from './music.js';
import { lerp, shellModal, seedFrom } from './util.js';

const game = {
  time: 0,
  started: false,          // false → splash screen; the sim doesn't run until START
  paused: false,
  settingsOpen: false,     // settings overlay (over splash or pause); freezes the sim
  controlsOpen: false,     // the control schematic — same shell rules (util.shellModal)
  creditsOpen: false,      // the credits panel  — same shell rules
  musicVol: 0.85,          // volume sliders (persisted; zero = mute, there are no
  sfxVol: 0.5,             //   toggles) — music high / SFX low by default: quiet
                           //   ambient tracks vs hot sample packs
  seedText: '',            // world seed AS TYPED in settings (persisted); '' = roll a new one every run
  seedPin: null,           // that text resolved to a uint32, or null when it's blank
  worldSeed: 0,            // the seed the LIVE world was actually built from
  showFps: false,          // perf overlay toggles (persisted) — FPS line / full metrics block
  showPerf: false,
  version: '',             // build version for the credits panel (fetched from package.json)
  ship: new Ship(),
  bodies: [],
  aliens: [],
  glowPockets: [],         // healing glow-mote pockets, orbiting the sun (glow.js)
  debris: [],
  particles: [],
  flares: [],              // solar plasma in flight
  bolts: [],               // Bastion turret fire in flight
  prog: newProgress(),     // roguelite build: xp / level / tier / upgrades / lives
  st: null,
  pickups: [],             // drifting life pods (world.js seeds/replenishes)
  choosingUpgrade: false,  // sim frozen while a spec/ability card is open
  upgradeChoices: null,
  upgradeKind: null,       // 'spec' | 'tier' (milestone) | 'upgrade' — cards always offer NEW abilities
  rankUps: [],             // AUTOMATIC ability ranks landed since the last drain (config.growAbilities
                           //   pushes, update() drains into messages + the hull-gain heal)
  gameOver: false,
  lifeTimer: PROG.LIFE_RESPAWN,
  held: null,
  held2: null,             // Twin Grip (hauler): a second held rock
  flingDelayT: 0,          // >0 briefly after a fling — holds the upgrade modal back so a
                           // pick threshold crossed mid-throw doesn't freeze the sim mid-aim
  orbit: [],               // bodies circling the ship as a shield
  orbitAngle: 0,
  aim: { x: 0, y: 0 },
  controls: { f: 0, b: 0, boost: 0 },   // boost = Afterburner (hold Shift)
  burnerFuel: 1,                        // Afterburner tank 0..1 (the BURN bar; refills slowly)
  burnerOn: false,                      // actually burning right now (physics reads this, not raw Shift)
  evadeT: 0,                            // Dash Jets cooldown (scout, A/D)
  dashT: 0,                             // brief side-jet flash after a dash (render)
  dashDir: 0,                           // which way the last dash went (-1 left / +1 right)
  autoEvadeT: 0,                        // Reflex Jink recharge (scout auto-dodge, physics.step)
  jinkT: 0,                             // brief flash ring after an auto-dodge (render)
  warpT: 0,                             // Slipstream cooldown (scout)
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
  timeScale: 1,            // dev sim speed (window.speed / ?dev hotkeys); 1 = normal play
  speedActual: 1,          // achieved multiple when fast-forwarding (HUD badge honesty)
  tut: { grabbed: false, flung: false, orbited: false, alienSeen: false, glow: false },
};

// Dev mode (?dev=1) unlocks the sim-speed hotkeys. A plain query param works
// identically over serve.py and the Electron app:// origin, so src/ stays
// host-agnostic; the console hooks at the bottom work with or without it.
game.devMode = new URLSearchParams(location.search).has('dev');

// Persisted front-end settings. localStorage is host-agnostic (works the same
// over serve.py and inside the Electron shell), so src/ stays packaging-blind.
// LOAD ORDER MATTERS: this runs BEFORE the world is generated, because a
// pinned seed has to reach the very first world — load it after and the boot
// world is always random no matter what the settings say.
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('ss_settings') || '{}');
    if (typeof s.musicVol === 'number') game.musicVol = Math.max(0, Math.min(1, s.musicVol));
    if (typeof s.sfxVol === 'number') game.sfxVol = Math.max(0, Math.min(1, s.sfxVol));
    if (typeof s.predict === 'boolean') game.predict = s.predict;
    if (typeof s.showFps === 'boolean') game.showFps = s.showFps;
    if (typeof s.showPerf === 'boolean') game.showPerf = s.showPerf;
    if (typeof s.seedText === 'string') setSeedText(s.seedText);
  } catch (e) { /* fall back to defaults */ }
}
function saveSettings() {
  try {
    localStorage.setItem('ss_settings', JSON.stringify({
      musicVol: game.musicVol, sfxVol: game.sfxVol, predict: game.predict,
      showFps: game.showFps, showPerf: game.showPerf, seedText: game.seedText,
    }));
  } catch (e) { /* private mode / disabled storage — settings just won't persist */ }
}

// ---- World seed -------------------------------------------------------------
// Every fresh run rolls a NEW world unless a seed is pinned. Precedence:
// ?seed= on the URL (reproducible soaks and bug reports — it also overrides the
// stored setting, so a pinned player can still be handed a repro link), then the
// persisted Settings field, then random. generateWorld's own 20260721 default
// stays put on purpose: devtest.js leans on it for its fixed baseline world.
const urlSeed = new URLSearchParams(location.search).get('seed');
function setSeedText(text) {
  game.seedText = text;
  game.seedPin = text.trim() ? seedFrom(text) : null;
}
function pickSeed() {
  if (urlSeed) return seedFrom(urlSeed);
  if (game.seedPin != null) return game.seedPin;
  return (Math.random() * 0xffffffff) >>> 0;
}
// Build (or rebuild) the world. `seed` undefined = resolve one through pickSeed;
// pass one explicitly to force a specific world (window.freshRun / mechTest).
// The transient arrays are cleared first — everything holds them by reference,
// so leftovers from the old world would drift through the new one.
function regenWorld(seed) {
  game.aliens.length = 0; game.debris.length = 0; game.particles.length = 0;
  game.flares.length = 0; game.bolts.length = 0; game.glowPockets.length = 0;
  game.orbit.length = 0; game.pickups.length = 0;
  game.held = null; game.held2 = null;
  game.worldSeed = seed ?? pickSeed();
  generateWorld(game, game.worldSeed);   // clears game.bodies itself, then respawns the ship
  game.cam.x = game.ship.x; game.cam.y = game.ship.y;
}

loadSettings();
game.st = shipStats(game.prog);
regenWorld();

const canvas = document.getElementById('game');
const view = initRender(canvas);
hud.initHud(game);

// Build version for the CREDITS panel. A RELATIVE fetch keeps src/ host-
// agnostic — it resolves identically under serve.py and the Electron app://
// scheme (registered supportFetchAPI). Accurate only on a release build: in a
// dev checkout package.json lags the newest v* tag, which is the real source of
// truth (CLAUDE.md → Desktop packaging).
fetch('package.json').then((r) => r.json())
  .then((j) => { game.version = j.version || ''; })
  .catch(() => { /* no version line rather than a broken one */ });

// Volume levels are safe pre-gesture — both modules just store them (the audio
// context itself still only ever gets built inside a user gesture: initAudio).
sfx.setSfxVolume(game.sfxVol);
music.setMusicVolume(game.musicVol);

// Fair view: fold the canvas-size normalization into cam.zoom itself —
// mouseWorld, viewR, render culling, and the /zoom UI-stroke idiom all read
// cam.zoom, so this one assignment keeps every consumer consistent.
function applyZoom() {
  const { vw, vh } = view.getView();
  game.cam.zoom = game.zoomCur * (Math.hypot(vw, vh) / CFG.VIEW_REF_DIAG);
}
applyZoom();

// Fire the shotgun: launches however many orbiters the charge has armed
function fireVolley() {
  const n = flingAllFromOrbit(game, game.volleySel || game.orbit.length);
  if (n) hud.message(`SHOTGUN — ${n} rock${n > 1 ? 's' : ''} away!`, 2);
  game.volleyT = 0;
  game.volleySel = 0;
  game.volleyCharging = false;
}

// The player may only touch the sim while actually flying — not on the splash,
// in the pause menu, mid-settings, or while an upgrade card is open.
const menuBlocking = () => !game.started || game.paused || shellModal(game) || game.choosingUpgrade;

initInput(canvas, {
  onGrab: () => {
    if (menuBlocking() || !game.ship.alive) return;
    if (tryGrab(game)) {
      // Anything that fits your orbit is captured into it automatically — but a
      // Twin Grip SECOND grab (held2 filled) is a big rock held alongside, kept in hand.
      const b = game.held;
      if (!game.held2 && b.mass <= game.st.orbitCap && game.orbit.length < game.st.maxOrbiters) {
        addToOrbit(game);
        if (!game.tut.orbited) {
          game.tut.orbited = true;
          hud.message(game.st.trailStow
            ? 'Racked in your wake! Trailing rocks are shotgun ammo. Hold RIGHT MOUSE to charge — longer hold arms more rocks.'
            : 'Captured into your orbit! It shields you. Hold RIGHT MOUSE to charge a shotgun — longer hold arms more rocks.', 5);
        }
      } else if (!game.tut.grabbed) {
        game.tut.grabbed = true;
        hud.message('Got it! RELEASE to FLING it toward the cursor. Good moves earn XP — level up to pick upgrades.', 5);
      }
    } else if (retrieveFromOrbit(game)) {
      if (!game.tut.retrieved) {
        game.tut.retrieved = true;
        hud.message('Rock pulled back from your orbit — release to fling it.', 4);
      }
    }
  },
  onFling: () => {
    if (menuBlocking()) return;
    if (game.held) {
      releaseHeld(game, true);
      if (!game.tut.flung) {
        game.tut.flung = true;
        hud.message('Smash things to break them into golden scrap — it heals and toughens you.', 5);
      }
    }
  },
  onRmbDown: () => {
    if (menuBlocking()) return;
    if (game.held) {
      // Send the held rock (back) into your orbit; too big -> gentle drop
      if (!addToOrbit(game)) releaseHeld(game, false);
      return;
    }
    // The shotgun is an upgrade — no charge until the array is unlocked
    if (game.st.hasVolley && game.orbit.length) game.volleyCharging = true;
  },
  onRmbUp: () => {
    if (menuBlocking()) { game.volleyCharging = false; return; }
    // Release fires whatever the hold has armed (a tap = 1 rock)
    if (game.volleyCharging && game.orbit.length && game.ship.alive) fireVolley();
    game.volleyCharging = false;
  },
  onMenuKey: () => toggleMenu(),
  onRespawn: () => {
    if (game.ship.alive) return;
    if (game.gameOver) { resetRun(); return; }
    // A life was already spent at the moment of death; upgrades are KEPT.
    respawnShip(game);
    hud.setDeathVisible(false);
  },
  onTogglePredict: () => { game.predict = !game.predict; saveSettings(); },
  onUpgradePick: (i) => applyPick(i),
  // DASH JETS (scout): tap A / D -> dart hard to the ship's left/right with
  // brief i-frames. Sideways relative to the NOSE (angle ± 90°), not the
  // cursor — a positioning twitch, not a lunge.
  onDash: (dir) => {
    if (menuBlocking() || !game.ship.alive || !game.st.evasion || game.evadeT > 0) return;
    const s = game.ship;
    const ang = s.angle + dir * Math.PI / 2;
    const burst = 380 + 70 * game.st.evasion;
    s.vx += Math.cos(ang) * burst; s.vy += Math.sin(ang) * burst;
    s.invuln = Math.max(s.invuln, 0.25 + 0.08 * game.st.evasion);
    game.evadeT = Math.max(0.45, 1.2 - 0.2 * game.st.evasion);
    game.dashT = 0.22; game.dashDir = dir;   // render: side-jet flash
    sfx.sfxEvade();
  },
  // SLIPSTREAM (scout): tap F -> warp a fixed distance toward the cursor.
  onWarp: () => {
    if (menuBlocking() || !game.ship.alive || !game.st.slipstream || game.warpT > 0) return;
    const s = game.ship;
    const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    s.x += Math.cos(ang) * 950; s.y += Math.sin(ang) * 950;
    game.cam.x = s.x; game.cam.y = s.y;   // snap the camera to the exit point
    s.invuln = Math.max(s.invuln, 0.5);
    game.warpT = 3.5;
    sfx.sfxWarp();
  },
  // DEV sim-speed hotkeys (?dev=1 only): [-] halve, [=] double, [0] reset to
  // 1x. They only set the multiplier — updateScaled applies it — so they're
  // harmless to press anywhere, menus included.
  onSpeedAdjust: (dir) => {
    if (!game.devMode) return;
    const cur = game.timeScale || 1;
    game.timeScale = dir === 0 ? 1 : Math.min(50, Math.max(0.25, dir > 0 ? cur * 2 : cur / 2));
  },
});

// ---- Front-end shell: splash / pause / settings / controls / credits ----
// The sim runs only while game.started && !paused && !shellModal (frame gate);
// these just flip those flags. hud.syncMenus derives the visible overlay from them.
let firstStart = true;
let tipTimer = null;

function startGame() {
  game.started = true;
  game.paused = false;
  closeShell();
  // Drop the splash's wide framing onto the ship; the sim's zoom ramp + the
  // clearing blur then read as a dive from the establishing shot into play.
  game.cam.x = game.ship.x; game.cam.y = game.ship.y;
  // The run OPENS on a SPECIALIZATION choice, which sets your starting kit and
  // gates your ability tree. openSpec freezes the sim behind the card; the flight
  // guidance fires once a spec is chosen (applyPick 'spec' branch). Headless soaks
  // drive window.tick, which bypasses startGame and auto-picks a default spec.
  if (!game.choosingUpgrade && !game.prog.spec) openSpec();
}
function pauseGame() { if (game.started && !game.paused) { game.paused = true; sfx.sfxMenuOpen(); } }
function resumeGame() { if (game.paused) sfx.sfxMenuClose(); game.paused = false; }
// The three shell modals are mutually exclusive — each fully REPLACES the panel
// it was opened over, so opening one clears the others rather than stacking.
function closeShell() { game.settingsOpen = false; game.controlsOpen = false; game.creditsOpen = false; }
function openSettings() { closeShell(); game.settingsOpen = true; sfx.sfxMenuOpen(); }
function openControls() { closeShell(); game.controlsOpen = true; sfx.sfxMenuOpen(); }
function openCredits() { closeShell(); game.creditsOpen = true; sfx.sfxMenuOpen(); }
// Settings is the only one that owns persisted state, so it's the only one that saves.
function closeShellPanel() { if (game.settingsOpen) saveSettings(); closeShell(); sfx.sfxMenuClose(); }
function toMainMenu() { game.paused = false; closeShell(); game.started = false; }

// ESC / P: context-sensitive. Never dismiss an upgrade card (you must pick one).
function toggleMenu() {
  if (game.choosingUpgrade) return;
  if (shellModal(game)) { closeShellPanel(); return; }
  // Nothing to toggle on the splash, or over the death / game-over panel (both
  // are centered .panels — a pause menu would stack on top of them).
  if (!game.started || game.gameOver || !game.ship.alive) return;
  if (game.paused) resumeGame(); else pauseGame();
}

function exitGame() {
  // Desktop (Electron): closes the app window → quits the app. In a plain
  // browser tab window.close() is a no-op (a tab the script didn't open can't
  // close itself); the game ships primarily as a desktop app, where Exit is
  // meaningful, and this keeps src/ host-agnostic (no Electron/Node calls).
  window.close();
}

// Living title backdrop: the world behind the splash actually ORBITS. We fly a
// slow, wide establishing shot of the inner system — the camera orbits the sun
// (at the origin) well zoomed-out so the star and its nearest planets sweep
// through frame — while the physics runs underneath it, so planets ride their
// rails, moons swing, and the belt grinds. The ship spawns way out in the belt,
// so it stays off-screen here (no title-screen HUD, no spawn blink). startGame
// snaps the camera back to the ship, so the sim's zoom ramp reads as a dive from
// this wide shot down into your ship.
//
// It runs the PHYSICS ONLY — never the full update(). update() is the player's
// loop, and a title screen must not be able to spend a life, bank XP, or queue
// a message. replenishWorld stays out for the same reason even though it would
// top the belt back up on a long idle: its survey scan pays XP_SURVEY and sets
// b.seen, so idling on the menu would bank progress and burn off the minimap
// fog before the run even started. updateAliens stays out too — nests are far
// from this establishing shot, and alien fire has consequences.
// Two guards keep the splash consequence-free:
//   - the ship is pinned invulnerable, so a stray belt hit can't kill it and
//     charge prog.lives for a run that hasn't started;
//   - event flags step() raises (heat, storms, auroras…) are cleared each frame
//     instead of drained, or they'd all fire as messages the moment START ran.
const SPLASH_ZOOM = 0.205;   // zoomCur for the wide shot (gameplay tier-0 is ~1.15)
let splashAcc = 0;
function driftSplash(dt) {
  game.time += dt;
  // The re-rail scan measures against the player's view, not the camera's — off
  // on the title screen it would re-rail rocks in shot. Keep it honest.
  const { vw, vh } = view.getView();
  game.viewR = Math.hypot(vw, vh) / 2 / game.cam.zoom;
  game.ship.invuln = Math.max(game.ship.invuln || 0, 1);

  // NO SCREEN SHAKE on the title screen. step() pumps game.shake on every
  // impact (physics.addShake, capped at 30) but its decay lives in update(),
  // which never runs here — so the moment the backdrop went live, ambient belt
  // crunches pegged it at the cap and render's ±15px random jitter shook the
  // whole sky forever. Zeroed rather than decayed on purpose: an establishing
  // shot lurching from an off-screen collision you can't even see at this zoom
  // is noise behind a menu, not drama.
  game.shake = 0;

  // The camera rides the PHYSICS clock, inside the substep loop — the same law
  // as the in-game follow cam, and for the same reason. The backdrop advances
  // in quantized CFG.DT chunks and the substeps-per-frame count wobbles
  // (2, 2, 3, 2, …); a camera eased on dtReal beats against that quantization.
  // One clock for both keeps the drift glass-smooth. (Before the world was
  // live this couldn't show — nothing moved for the camera to beat against.)
  splashAcc = Math.min(splashAcc + dt, 0.25);   // a backgrounded tab must not spiral
  while (splashAcc >= CFG.DT) {
    step(game, CFG.DT);
    game.splashT = (game.splashT || 0) + CFG.DT;
    const t = game.splashT;
    game.zoomCur = SPLASH_ZOOM * (1 + 0.05 * Math.sin(t * 0.12));   // gentle breathing
    const a = t * 0.06;                                            // slow orbit of the sun
    game.cam.x = Math.cos(a) * 4400;
    game.cam.y = Math.sin(a) * 4400;
    splashAcc -= CFG.DT;
    perf.steps++;   // the title backdrop is a real sim — the overlay shouldn't read zero here
  }
  for (const m of EVENT_MSGS) game[m.flag] = null;
  // ...and the automatic-rank queue with them: update() is what drains it, and
  // the title screen never runs update(), so anything banked here would fire as
  // a burst of rank messages the instant START ran.
  game.rankUps.length = 0;
}

// Every menu button is a user gesture — init Web Audio first so the very
// click that unlocks the context also gets its tick.
const ui = (fn) => () => { sfx.initAudio(); sfx.sfxUiClick(); fn(); };
hud.initMenus({
  onStart: ui(startGame),
  onResume: ui(resumeGame),
  onPause: ui(pauseGame),
  onMainMenu: ui(toMainMenu),
  onOpenSettings: ui(openSettings),
  onOpenControls: ui(openControls),
  onOpenCredits: ui(openCredits),
  onCloseShell: ui(closeShellPanel),
  onExit: exitGame,
  onTogglePredict: ui(() => { game.predict = !game.predict; saveSettings(); }),
  onToggleFps: ui(() => { game.showFps = !game.showFps; saveSettings(); }),
  onTogglePerf: ui(() => { game.showPerf = !game.showPerf; saveSettings(); }),
  // WORLD SEED. Typing only records the pin (regenerating per keystroke would
  // rebuild the system on every character); the COMMIT — blur or Enter — is what
  // re-rolls, and only from the title screen, where the splash backdrop is a
  // live sim so the new world can be seen before START. Mid-run it's a no-op:
  // yanking the world out from under a run in progress would be a disaster, so
  // it waits for the next one (the note line says so).
  onSeedInput: (text) => { setSeedText(text); saveSettings(); },
  onSeedCommit: () => { if (!game.started) regenWorld(); },
  // "I like this world" — pin whatever is currently loaded.
  onSeedPin: ui(() => { setSeedText(String(game.worldSeed)); saveSettings(); }),
  // Volume sliders: live on drag (a drag is a gesture, so initAudio is safe);
  // the release preview tick lets the SFX level be judged from the menu.
  onMusicVol: (v) => { sfx.initAudio(); game.musicVol = v; music.setMusicVolume(v); saveSettings(); },
  onSfxVol: (v) => { sfx.initAudio(); game.sfxVol = v; sfx.setSfxVolume(v); saveSettings(); },
  onSfxPreview: () => sfx.sfxUiClick(),
});

// Apply the chosen card (spec / milestone ability / between-tier ability), then
// unfreeze. Every non-spec card is a NEW ability — ranks are automatic (config
// .growAbilities), so nothing here ever deepens what you already own.
//
// HULL UPGRADE HEAL (user design rule): any pick that RAISES hullMax also
// heals the ship by the gain +20% — an upgrade should feel immediately good,
// not just widen an empty bar. The one sanctioned mid-life hull gain besides
// glow pockets (the split-health law notes this exception). Clamped to the
// new max; a shield pick that CARVES hullMax down never hurts (gain <= 0 no-op).
function healOnHullGain(oldHullMax) {
  const gain = game.st.hullMax - oldHullMax;
  if (gain > 0 && game.ship.alive) {
    game.ship.hull = Math.min(game.st.hullMax, game.ship.hull + gain * 1.2);
  }
}

// AUTOMATIC RANKS. config.growAbilities banks XP into every owned ability and
// queues each rank it lands; this announces them. Called from update() right
// after the st rebuild, so `preHullMax` is the ceiling from BEFORE the ranks —
// a hull rank owes the same heal a hull PICK does (the hull-gain rule above).
// Deliberately quiet compared with a pick: one sound, one line, no freeze —
// this fires mid-flight and must never read as an interruption. Several ranks
// can land in one frame (a fat survey/master-chart award), so the line
// collapses past two.
function drainRankUps(preHullMax) {
  const ups = game.rankUps;
  const text = ups.length === 1
    ? `${ups[0].name.toUpperCase()} rank ${ups[0].rank}.`
    : ups.length === 2
      ? `${ups[0].name.toUpperCase()} rank ${ups[0].rank} · ${ups[1].name.toUpperCase()} rank ${ups[1].rank}.`
      : `${ups.length} ABILITY RANKS GAINED.`;
  ups.length = 0;
  healOnHullGain(preHullMax);
  sfx.sfxUpgrade();
  hud.message(text, 2.6);
}

function applyPick(i) {
  if (!game.choosingUpgrade || !game.upgradeChoices) return;
  const choice = game.upgradeChoices[i];
  if (!choice) return;
  const oldHullMax = game.st.hullMax;   // healOnHullGain reads the pre-pick ceiling
  if (game.upgradeKind === 'spec') {
    // Free run-opener: lock the specialization, grant its starting kit, begin play.
    applySpec(game.prog, choice.id);
    game.st = shipStats(game.prog);
    healOnHullGain(oldHullMax);   // a kit hull track must not open the run below full
    sfx.sfxTierUp();
    beginRunGuidance(choice);
  } else if (game.upgradeKind === 'tier') {
    // Milestone: tier bump FIRST, then the chosen new ability comes in fresh at
    // rank 1 with an empty xp pool, plus a life.
    consumePickCost(game.prog);
    applyTierUp(game.prog);
    applyAbility(game.prog, choice.id);
    game.prog.lives = Math.min(maxLives(game.prog), game.prog.lives + 1);
    game.st = shipStats(game.prog);
    healOnHullGain(oldHullMax);   // the tier bump usually raises hullMax — heal the gain
    game.lastTier = game.st.tier;
    sfx.sfxTierUp();
    hud.message(`TIER UP — ${game.st.label.toUpperCase()}. ${choice.name} acquired. +1 life.`, 6);
  } else {   // 'upgrade' — the between-tier pick. Also a NEW ability: ranks
             // arrive on their own now, so no card ever deepens what you own.
    consumePickCost(game.prog);
    applyAbility(game.prog, choice.id);
    game.prog.picksThisTier++;
    game.st = shipStats(game.prog);
    healOnHullGain(oldHullMax);
    sfx.sfxUpgrade();
    hud.message(`${choice.name.toUpperCase()} acquired.`, 3.5);
  }
  game.choosingUpgrade = false;
  game.upgradeChoices = null;
  game.upgradeKind = null;
  hud.setUpgradeVisible(game, null, null, null);
}

// Run start: choose a specialization. Freezes the sim behind the card.
function openSpec() {
  game.upgradeKind = 'spec';
  game.upgradeChoices = SPECS.slice();
  game.choosingUpgrade = true;
  hud.setUpgradeVisible(game, game.upgradeChoices, 'spec', applyPick);
}

// One-shot flight guidance, fired the first time a spec is chosen.
function beginRunGuidance(spec) {
  if (!firstStart) return;
  firstStart = false;
  hud.message(`${spec.name} — ${spec.desc} Hold W to thrust; hold LEFT MOUSE near a rock to grab and fling.`, 7);
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (game.started && !game.paused && !game.tut.grabbed) {
      hud.message('HOLD LEFT MOUSE near an asteroid to tractor-grab it.', 5);
    }
  }, 9000);
}

// The next owed pick. BOTH kinds now draw the same way — NEW abilities you
// don't own yet (tierChoices) — because deepening is automatic; the milestone
// ('tier') just also carries the tier bump and the life. Freezes the sim behind
// the card. Both empty-pool branches must keep progression MOVING: a spec whose
// offer pool is exhausted still tiers up / still banks the pick, or the ladder
// silently stalls for the rest of the run.
function openUpgrade() {
  const prog = game.prog;
  if (!prog.spec) return;   // no picks until a spec is chosen
  game.upgradeKind = pickIsMilestone(prog) ? 'tier' : 'upgrade';
  game.upgradeChoices = tierChoices(prog, 2);
  if (!game.upgradeChoices.length) {
    consumePickCost(prog);
    if (game.upgradeKind === 'tier') {   // pool exhausted -> tier up with no new ability
      applyTierUp(prog);
      game.prog.lives = Math.min(maxLives(prog), game.prog.lives + 1);
      game.st = shipStats(game.prog);
      game.lastTier = game.st.tier;
      sfx.sfxTierUp();
      hud.message(`TIER UP — ${game.st.label.toUpperCase()}. +1 life.`, 5);
    } else {
      prog.picksThisTier++;              // ...still advance toward the milestone
    }
    return;
  }
  game.choosingUpgrade = true;
  hud.setUpgradeVisible(game, game.upgradeChoices, game.upgradeKind, applyPick);
}

// Game over -> fresh run: wipe the build, regenerate the world, restart.
// `seed` forces a specific world (window.freshRun / mechTest); undefined lets
// pickSeed resolve one, so a normal new run lands on a brand-new random system
// unless the player has pinned a seed in Settings.
function resetRun(seed) {
  game.prog = newProgress();
  game.st = shipStats(game.prog);
  game.aliens.length = 0; game.debris.length = 0; game.particles.length = 0;
  game.flares.length = 0; game.bolts.length = 0; game.glowPockets.length = 0;
  game.orbit.length = 0; game.held = null; game.held2 = null; game.pickups.length = 0;
  game.gameOver = false; game.deathShown = false; game.deathCause = '';
  game.lastTier = 0; game.alienKills = 0; game.lifeTimer = PROG.LIFE_RESPAWN;
  game.burnerFuel = 1; game.burnerOn = false;
  game.dashT = 0; game.autoEvadeT = 0; game.jinkT = 0;   // (evadeT/warpT reset below)
  game.tut = { grabbed: false, flung: false, orbited: false, alienSeen: false, glow: false };
  // Run-scoped world state must reset with the world, or it leaks between
  // runs: time drives the alien first-wave peace window and the once-per-run
  // visitor gate; lastDamage must move with time or the shield-regen delta
  // goes negative; the event timers re-seed via their `?? default` idiom.
  game.time = 0; game.lastDamage = -99;
  game.storm = null; game.stormTimer = undefined;
  game.visitor = null; game.visitorDone = false;
  game.vesperRespawnT = null; game.shepherdRespawnT = null; game.shepherdPlayerKilled = false;
  game.rogueTimer = undefined; game.moonTimer = undefined;
  game.flareTimer = undefined; game.cometTimer = undefined; game.wrightTimer = undefined;
  game.alienTimer = 0; game.asteroidTimer = 10;
  game.ghostPing = null; game.sling = null; game.combo = 0; game.comboT = 0;
  game.predictRef = null; game.lock = null; game.lockTarget = null; game.tooHeavy = null;
  game.heatT = 0; game.gasDiveT = 0; game.gasEnterT = 0; game.skimT = 0; game.scrapeT = 0;
  game.volleyT = 0; game.volleySel = 0; game.volleyCharging = false;
  game.evadeT = 0; game.warpT = 0; game.flingDelayT = 0; game.oortWarnT = 0;
  game.parry = null; game.parryCd = 0;   // a parry must never survive into a fresh world
  game.rankUps.length = 0;               // undrained ranks belong to the dead run
  regenWorld(seed);            // rebuilds bodies (cleared first) + spawn, calls respawnShip
  game.st = shipStats(game.prog);
  hud.setDeathVisible(false);
  hud.setGameOverVisible(false);
  firstStart = true;     // re-arm the flight guidance for the fresh run
  openSpec();            // fresh run opens on a new specialization choice
}

// One-shot event messages — the "Event-flag messaging" convention (CLAUDE.md):
// a subsystem sets game[flag] (true, or a payload like a world name) and
// update() drains it here exactly once per firing. `tut` names a game.tut
// boolean: with only `first` the message shows a single time ever; with
// `repeat` too, later firings get the shorter wording. Each entry is
// [text, seconds]; text may be a function of the drained payload. When two
// events fire the same frame the LAST entry wins the single HUD slot, so the
// table keeps the order of the if-chain it replaced. `snd` (optional) plays
// with the message — the audio grammar is: sfxAlarm = the ship itself is in
// danger NOW; sfxWarnLow = hostile contact / bad news; sfxChime = discovery,
// lore, or opportunity; sfxLife = triumph.
const EVENT_MSGS = [
  { flag: 'alienWarn', tut: 'alienSeen', snd: sfx.sfxWarnLow,
    first: ['WARNING: alien grabbers inbound — they throw rocks. Your orbit shield can block them.', 5] },
  { flag: 'rogueIncoming', snd: sfx.sfxWarnLow,
    first: ['SENSOR ALERT: a rogue planet has entered the sector.', 4.5] },
  { flag: 'tetherShow', tut: 'tether', snd: sfx.sfxChime,
    first: [(v) => `TETHER THROW ×${v.toFixed(2)} — boosting while flinging whip-cracks the rock with your momentum.`, 4.5],
    repeat: [(v) => `TETHER THROW! ×${v.toFixed(2)}`, 1.8] },
  { flag: 'jinkWarn', tut: 'jink', snd: sfx.sfxChime,
    first: ['REFLEX JINK — your ship auto-dodged that rock. The jink recharges slowly.', 5] },
  { flag: 'deadStopWarn', tut: 'deadstop', snd: sfx.sfxChime,
    first: ['DEAD STOP — caught it mid-flight! The rock is primed: fling it back hard.', 5] },
  { flag: 'parryWarn', tut: 'parry', snd: sfx.sfxChime,
    first: ['DEFLECTED — the rock is frozen! Flick your mouse to hurl it that way.', 5] },
  { flag: 'wallSplatWarn', tut: 'wallsplat', snd: sfx.sfxChime,
    first: ['WALL SPLAT — smashed against the world. Nearby rocks scatter off the impact as yours.', 5] },
  { flag: 'cometWarn', tut: 'comet', snd: sfx.sfxWarnLow,
    first: ['COMET SHOWER — fast ice crossing your sector. Dangerous, but premium shield ammo and 4x scrap.', 5.5],
    repeat: ['COMET SHOWER inbound!', 3] },
  { flag: 'flareWarn', tut: 'flare', snd: sfx.sfxAlarm,
    first: ['SOLAR FLARE — the sun is erupting at you. MOVE!', 4.5],
    repeat: ['SOLAR FLARE INBOUND!', 2.5] },
  { flag: 'magmaWarn', tut: 'magma', snd: sfx.sfxWarnLow,
    first: ['MAGMA EJECTION — lava worlds hurl molten rock. It cools into dense fling ammo.', 5] },
  { flag: 'geyserWarn', tut: 'geyser', snd: sfx.sfxChime,
    first: ['Cryo-geyser! Ice worlds pop free shield ammo into low orbit.', 5] },
  { flag: 'comboShow', snd: sfx.sfxChime,
    first: [(v) => `GRAVITY BILLIARDS ×${v}! +${8 * v} scrap`, 2] },
  { flag: 'coreFound', tut: 'core', snd: sfx.sfxChime,
    first: ['MINERAL CORE exposed — dense salvage. Catch it to fatten your beam, or smash it for scrap.', 5.5] },
  { flag: 'cacheCracked', tut: 'cache', snd: sfx.sfxChime,
    first: ['SALVAGE CACHE cracked — scrap and shield ammo. Watch the lanes for more canisters.', 5.5] },
  { flag: 'glowMsg', tut: 'glow', snd: sfx.sfxChime,
    first: ['GLOW POCKET — fly through the motes to mend your hull. These pockets are the only place it heals.', 6] },
  { flag: 'nestKilled',
    first: ['ALIEN NEST DESTROYED — this region of space is quiet now.', 6] },
  { flag: 'wrightWarn', tut: 'wright', snd: sfx.sfxWarnLow,
    first: ['WRECKWRIGHT — a scavenger is harvesting your battle debris. Kill it before it finishes building.', 5.5],
    repeat: ['WRECKWRIGHT descending on the debris field!', 3] },
  { flag: 'golemWarn', snd: sfx.sfxWarnLow,
    first: ['SCRAP-GOLEM assembled — your leftovers are hunting you.', 4.5] },
  { flag: 'fortShieldDownName', snd: sfx.sfxWarnLow,
    first: [(v) => `FORTRESS SHIELD DOWN at ${v} — smash the turrets!`, 4] },
  { flag: 'fortLiberatedName', snd: sfx.sfxLife,
    first: [(v) => `${v.toUpperCase()} LIBERATED — the Bastion fort is destroyed. Salvage is yours.`, 5] },
  { flag: 'emberWarn', tut: 'ember', snd: sfx.sfxWarnLow,
    first: ['EMBERKIN ARTILLERY — this world is colonized. Icy rocks smother the reefs.', 5.5] },
  { flag: 'emberSeededName', snd: sfx.sfxWarnLow,
    first: [(v) => `The Emberkin have seeded ${v} — the bloom is spreading.`, 5.5] },
  { flag: 'emberCleansedName', snd: sfx.sfxChime,
    first: [(v) => `${v} cleansed — the Emberkin bloom is extinguished.`, 5] },
  // ---- discovery-layer events ----
  { flag: 'vesperWarn', tut: 'vesper', snd: sfx.sfxChime,
    first: ['COMET VESPER — a long-period wanderer, falling sunward. Its tail blooms at perihelion. Catch it if you can.', 6] },
  { flag: 'visitorWarn', snd: sfx.sfxChime,
    first: ['DEEP-SPACE CONTACT: an interstellar object is crossing the system. It will not come back.', 6] },
  { flag: 'visitorGone',
    first: ['The interstellar visitor has left the system — forever.', 5.5] },
  { flag: 'stormWarn', tut: 'storm', snd: sfx.sfxAlarm,
    first: ['SOLAR STORM — the sun has loosed a charged wave across the whole system. Watch the skies of nearby worlds.', 6],
    repeat: ['SOLAR STORM — a charged wave is sweeping the system.', 3.5] },
  { flag: 'auroraName', tut: 'aurora', snd: sfx.sfxChime,
    first: [(v) => `AURORA — the storm wave is lighting up ${v}'s sky.`, 5],
    repeat: [(v) => `AURORA over ${v}.`, 3] },
  { flag: 'eclipseName', snd: sfx.sfxChime,
    first: [(v) => `MOONSHADOW — a lunar eclipse is sweeping across ${v}.`, 5] },
  { flag: 'surveyMsg', snd: sfx.sfxChime, first: [(v) => v, 4.5] },
  { flag: 'echoMsg', snd: sfx.sfxChime, first: [(v) => v, 7.5] },
  { flag: 'masterChartWarn', snd: sfx.sfxLife,
    first: ['MASTER CHART COMPLETE — every world logged. Deep-sky calibration: sensors and forecast permanently sharpened.', 6.5] },
  { flag: 'graveyardWarn', tut: 'graveyard', snd: sfx.sfxChime,
    first: ['GRAVEYARD ORBIT — pre-collapse wreckage rings the sun. Rich salvage… but the sun is very close.', 6] },
  { flag: 'ghostWarn', tut: 'ghost', snd: sfx.sfxWarnLow,
    first: ['UNKNOWN CONTACT — a repeating signal, close by. Something old is out here.', 6] },
  { flag: 'heraldWakeWarn', snd: sfx.sfxLife,
    first: ['THE HERALD ANSWERS — lights returning deck by deck. Its beacon now watches this reach of space.', 6.5] },
  { flag: 'tinkerWantWarn', tut: 'tinker', snd: sfx.sfxChime,
    first: [(v) => `TINKER BARGE — a crewed trader! It wants ${v}: fling one into its catch ring for payment.`, 6.5],
    repeat: [(v) => `The Tinker Barge wants ${v}.`, 3.5] },
  { flag: 'tinkerPaidWarn', snd: sfx.sfxLife,
    first: [(v) => `TRADE COMPLETE — payment delivered: ${v}.`, 4.5] },
  { flag: 'relayWarn', snd: sfx.sfxChime,
    first: ['THE RELAY POWERS UP — its dish grinds around and locks a bearing. There IS a star out there. New contact on the map rim.', 7] },
  { flag: 'maydayWarn', tut: 'mayday', snd: sfx.sfxWarnLow,
    first: [(v) => `MAYDAY — an escape pod is adrift to the ${v}, air failing. Tow it to any station — the dock is marked on your radar.`, 6.5],
    repeat: [(v) => `MAYDAY — pod adrift to the ${v}, air failing.`, 4.5] },
  { flag: 'maydaySavedWarn', snd: sfx.sfxLife,
    first: ['PILOT RESCUED — they made it.', 4] },
  // Deliberately silent: the quiet IS the message.
  { flag: 'maydayLostWarn',
    first: ['The pod has gone quiet.', 5] },
  // ---- moons-with-jobs discoveries (all sfxChime: opportunity, not threat) ----
  { flag: 'ironWarn', tut: 'iron', snd: sfx.sfxChime,
    first: ['MAGNETIC MOON — this iron moon gathers loose salvage. Let your scrap pool here, then sweep it up.', 5.5] },
  { flag: 'sulfurWarn', tut: 'sulfur', snd: sfx.sfxChime,
    first: ['SULFUR POPS — the crust is venting! A hard smash fountains loose sling rock.', 5.5] },
  { flag: 'dustWarn', tut: 'dust', snd: sfx.sfxChime,
    first: ['DUST SHROUD — inside this halo, alien senses cannot find you. Pursuers lose their lock.', 5.5] },
  { flag: 'bandedWarn', tut: 'banded', snd: sfx.sfxChime,
    first: ["BANDED SKIMMING — grinding this moon's bands pays triple XP. Risky flying, rewarded.", 5.5] },
  { flag: 'ringDecayName', snd: sfx.sfxChime,
    first: [(v) => `The shepherd moon is gone — ${v}'s ring is beginning to scatter.`, 6] },
  { flag: 'volcWarn', tut: 'volc', snd: sfx.sfxChime,
    first: ['FORGE MOON — this moon is volcanically alive. Its ejecta cools into dense slinging rock.', 5.5] },
  { flag: 'heatWarn', tut: 'heat', snd: sfx.sfxAlarm,
    first: ['MELTDOWN WARNING — the heat is liquefying your hull. Turn back!', 4.5] },
  { flag: 'gasDiveWarn', tut: 'gasdive', snd: sfx.sfxAlarm,
    first: ['CRUSH DEPTH — the atmosphere is collapsing your hull. The core will finish the job. CLIMB!', 5] },
  { flag: 'flareHitWarn', snd: sfx.sfxAlarm,
    first: ['FLARE STRIKE — the surge fries your engines! Half your shield rocks are blown loose.', 4.5] },
  { flag: 'scrapeWarn', tut: 'scrape', snd: sfx.sfxWarnLow,
    first: ["HULL SCRAPING — you're grinding along the surface. Pull up!", 4.5] },
];

let last = performance.now();
let acc = 0;

// ---- Perf sampling (the FPS / metrics overlay) ------------------------------
// Frame time is measured from the RAW rAF delta, never dtReal: dtReal is
// clamped to a 20 fps floor (tab-switch protection), so it would flatline at
// 50ms and lie exactly when the overlay matters most. The three timings are
// EMA-smoothed — unsmoothed digits strobe too fast to read — while the counts
// stay instantaneous, since they don't jitter. Costs nothing when the overlay
// is off: it's four multiply-adds and hud.js early-outs before formatting.
const perf = { fps: 60, frameMs: 16.7, simMs: 0, drawMs: 0, steps: 0 };
game.perf = perf;
const PERF_EMA = 0.1;

function update(dtReal) {
    game.time += dtReal;

    // Derived stats track progression continuously; the hull grows with you,
    // and the camera pulls back so the system shrinks as you level.
    // The PREVIOUS frame's ceiling is captured first: ability ranks land inside
    // the substeps (config.addXp -> growAbilities), so this rebuild is where an
    // automatic rank first reaches st — and the hull-gain heal has to measure
    // against the ceiling from before it.
    const preRankHullMax = game.st.hullMax;
    game.st = shipStats(game.prog);
    game.ship.radius = game.st.radius;
    if (game.rankUps.length) drainRankUps(preRankHullMax);
    // Cinematic zoom: ease toward the level-driven target instead of
    // snapping — leveling up feels like slowly zooming out of the universe
    const zoomTarget = 1.15 / game.st.zoomOut;
    game.zoomCur = lerp(game.zoomCur, zoomTarget, 1 - Math.exp(-0.5 * dtReal));
    applyZoom();

    // Roguelite pick: XP crossing a threshold opens the choice modal, which
    // freezes the sim (frame() gate) until the player picks. In headless
    // (window.tick) there is no input, so window.autoUpgrade auto-resolves.
    // NOT while a rock is in the beam, nor for ~2s after a fling (flingDelayT):
    // freezing the sim mid-aim/mid-throw feels awful. The owed pick isn't lost —
    // owesPick stays true until consumed, so it opens the moment the throw settles.
    if (!game.choosingUpgrade && game.prog.spec && game.ship.alive && !game.held &&
        game.flingDelayT <= 0 && owesPick(game.prog)) {
      openUpgrade();
      if (game.autoUpgrade && game.choosingUpgrade) applyPick(0);
    }

    // Per-frame inputs & AI
    readControls(game);
    // AFTERBURNER fuel (scout): a slow-refilling tank — the BURN bar. Engaging
    // needs a quarter tank (hysteresis, so an empty tank doesn't stutter the
    // burn on/off at the threshold); once lit it burns down to dry. Physics
    // reads game.burnerOn, never raw Shift, so thrust and tank always agree.
    if (game.st.afterburner > 0) {
      const want = game.controls.boost && game.ship.alive && game.ship.engineOutT <= 0;
      if (game.burnerOn && (!want || game.burnerFuel <= 0)) game.burnerOn = false;
      else if (!game.burnerOn && want && game.burnerFuel > 0.25) game.burnerOn = true;
      game.burnerFuel = game.burnerOn
        ? Math.max(0, game.burnerFuel - dtReal / game.st.burnTime)
        : Math.min(1, game.burnerFuel + dtReal * game.st.burnRefill);
    } else {
      game.burnerOn = false;
    }
    const { vw, vh } = view.getView();
    const m = mouseWorld(game, vw, vh);
    game.aim.x = m.x; game.aim.y = m.y;
    // Raw SCREEN mouse, stashed for the Deflector parry's flick read
    // (physics.updateParry): world-space aim deltas are contaminated by the
    // camera chasing the ship, so the flick must come from screen deltas.
    game.mouseSX = input.mouseX; game.mouseSY = input.mouseY;
    // World-space radius of the current view — the local asteroid spawner
    // keeps rocks in a ring just beyond this
    game.viewR = Math.hypot(vw, vh) / 2 / game.cam.zoom;
    updateAliens(game, dtReal);

    // Fixed-step physics. The camera follows the ship INSIDE this loop, on
    // the same fixed DT time-base, ON PURPOSE. Easing it on the variable
    // dtReal (the tidy idiom) while the ship advances in quantized DT chunks
    // makes the ship<->camera gap BEAT: the substeps-per-frame count wobbles
    // (2, 2, 3, 2, ...), so a dtReal-chased camera over/under-shoots each
    // frame and the ship visibly jerks back and forth around screen centre
    // (worse the more zoomed-in you are). Phase-locked here, ship and camera
    // share one clock and the gap stays rock-steady. Cosmetic-only easing
    // (shake decay, the zoom ramp) still rides dtReal above — those have no
    // quantized target to beat against.
    acc += dtReal;
    const camK = 1 - Math.exp(-6 * CFG.DT);
    while (acc >= CFG.DT) {
      updateTractor(game, CFG.DT);
      updateOrbit(game, CFG.DT);
      updateTethers(game, CFG.DT);   // Recovery Tether: thrown rocks curve home (hauler)
      step(game, CFG.DT);
      game.cam.x = lerp(game.cam.x, game.ship.x, camK);
      game.cam.y = lerp(game.cam.y, game.ship.y, camK);
      acc -= CFG.DT;
      perf.steps++;   // frame() zeroes this; updateScaled calls update() several times, so it sums
    }

    const s = game.ship;

    // Gravity-compass smoothing (display only): the raw per-substep pull
    // vector whips around during fast flybys and flips near field nulls —
    // vector-lerping it calms the arrow without lying about the trend.
    {
      const k = 1 - Math.exp(-5 * dtReal);
      game.compassX = lerp(game.compassX ?? 0, game.shipGx || 0, k);
      game.compassY = lerp(game.compassY ?? 0, game.shipGy || 0, k);
      // Chevron flow phase must ACCUMULATE (+= speed * dt). The old
      // time * speed form made the phase teleport by (time * dSpeed) whole
      // cycles whenever field strength moved — the "insanely fast" strobe.
      // Flow speed depends ONLY on smoothed field strength, nothing else.
      const mag = Math.hypot(game.compassX, game.compassY);
      const t = Math.min(1, Math.max(0, (Math.log10(Math.max(1e-6, mag)) - 0.08) / 2.2));
      game.compassPhase = ((game.compassPhase || 0) + (0.25 + 0.5 * t) * dtReal) % 1;
    }
    // Glow pockets — proximity-collected like life pods, so dtReal (see glow.js)
    updateGlow(game, dtReal);

    // GRAVITY BILLIARDS combo: the window ticks down on real time; when it
    // lapses the chain resets (the count itself is racked up in physics.shatter)
    if (game.comboT > 0) { game.comboT -= dtReal; if (game.comboT <= 0) game.combo = 0; }

    if (game.scrapeT > 0) game.scrapeT -= dtReal;
    if (game.gasDiveT > 0) game.gasDiveT -= dtReal;
    if (game.gasEnterT > 0) game.gasEnterT -= dtReal;
    if (game.flingDelayT > 0) game.flingDelayT -= dtReal;   // post-fling grace before the pick modal
    if (game.evadeT > 0) game.evadeT -= dtReal;             // Dash Jets cooldown
    if (game.dashT > 0) game.dashT -= dtReal;               // dash side-jet flash
    if (game.autoEvadeT > 0) game.autoEvadeT -= dtReal;     // Reflex Jink recharge
    if (game.jinkT > 0) game.jinkT -= dtReal;               // jink flash ring
    if (game.warpT > 0) game.warpT -= dtReal;               // Slipstream cooldown
    if (game.relayBeamT > 0) game.relayBeamT -= dtReal;     // relay bearing-beam cue

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
        // Bar raised from 50 and reward cut from x8: long-arm wells made
        // modest assists routine, and the old numbers inflated low-level
        // engine growth into a runaway
        if (!game.sling.thrusted && gain > 90) {
          addXp(game, gain * PROG.XP_SLING);   // clean flying earns XP
          hud.message(`SLINGSHOT! +${gain} speed — clean flying earns XP.`, 3);
        }
        game.sling = null;
      }
    } else {
      game.sling = null;
    }

    // Shield recharges after a quiet spell; the hull never self-heals (it mends
    // only at glow pockets — glow.js). Scout's Phase Screen recharges faster
    // (spec-derived st.regen / st.regenDelay — see config.shipStats).
    if (s.alive && game.time - game.lastDamage > game.st.regenDelay && s.shield < game.st.shieldMax) {
      s.shield = Math.min(game.st.shieldMax, s.shield + game.st.regen * dtReal);
    }
    if (s.shieldHitT > 0) s.shieldHitT -= dtReal;

    replenishWorld(game, dtReal);
    updateLifePods(dtReal);

    // Oort cloud proximity warning
    if (game.oortWarnT > 0) game.oortWarnT -= dtReal;
    if (s.alive) {
      const rc = Math.hypot(s.x, s.y);
      if (rc > CFG.WORLD_R - CFG.OORT_WARN && game.oortWarnT <= 0) {
        game.oortWarnT = 12;
        sfx.sfxAlarm();
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
    if (s.alive && game.st.hasTargeting && (game.held || game.volleyCharging)) {
      game.lock = aimSolutions(game);
      game.lockTarget = game.lock.hot ? game.lock.hot.target : null;
    } else {
      game.lock = null;
      game.lockTarget = null;
    }

    // Timers & one-shot event messages (drained from the EVENT_MSGS table)
    if (game.tooHeavyT > 0) game.tooHeavyT -= dtReal;
    // skimT is a decaying timer set in physics, not a drain-once flag — the
    // one event condition that doesn't fit the table's shape.
    if (game.skimT > 0 && !game.tut.skim) {
      game.tut.skim = true;
      hud.message("CLOUD SKIMMING — the cloud tops sling you forward. Don't dip too deep.", 5);
    }
    for (const e of EVENT_MSGS) {
      const v = game[e.flag];
      if (!v) continue;
      game[e.flag] = null;
      let m = e.first;
      if (e.tut) {
        if (game.tut[e.tut]) {
          if (!e.repeat) continue;   // first-time-only event, already shown
          m = e.repeat;
        }
        game.tut[e.tut] = true;
      }
      hud.message(typeof m[0] === 'function' ? m[0](v) : m[0], m[1]);
      if (e.snd) e.snd();
    }
    if (!s.alive && game.deathCause && !game.deathShown) {
      game.deathShown = true;
      game.prog.lives--;   // a life is spent per death (upgrades are kept)
      if (game.prog.lives <= 0) {
        game.gameOver = true;
        sfx.sfxGameOver();
        hud.setGameOverVisible(true, game.deathCause);
      } else {
        hud.setDeathVisible(true, game.deathCause, game.prog.lives);
      }
    }
    if (s.alive && game.deathShown) game.deathShown = false;

    // Continuous ambience loops ride live game state every frame. The speed
    // voice gates on the throttle too — with no thrust applied EVERY engine
    // noise stops, even at full coasting speed.
    const engineOn = s.alive && (s.thrusting || s.braking);
    // Boost sound follows game.burnerOn (the fuel-gated truth physics thrusts
    // with), never raw Shift — an empty tank must not SOUND boosted.
    sfx.setThrust(engineOn, !!game.burnerOn, game.speedFrac || 0);
    sfx.setSpeed(engineOn ? (game.speedFrac || 0) : 0);
    sfx.setHeat(s.alive ? (game.heatT || 0) : 0);
    sfx.setScrape(s.alive && game.scrapeT > 0 ? 1 : (s.alive && game.skimT > 0 ? 0.5 : 0));
    sfx.setCharge(game.volleyCharging
      ? 0.2 + 0.8 * Math.min(1, game.volleyT / CFG.VOLLEY_TIME) : 0);

    // Camera follows the ship inside the fixed-step loop above (see there);
    // only the cosmetic shake decay rides the variable frame time here.
    game.shake *= Math.exp(-7 * dtReal);
}

// Life pods: sparse drifting collectibles. Fly into one for +1 life; when the
// buffer is full they cash out as scrap instead. A slow timer trickles new
// pods in while you're below MAX_LIVES (world.js places them beyond the view).
function updateLifePods(dt) {
  const s = game.ship;
  for (let i = game.pickups.length - 1; i >= 0; i--) {
    const p = game.pickups[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.phase = (p.phase || 0) + dt;
    if (s.alive && Math.hypot(p.x - s.x, p.y - s.y) < PROG.LIFE_R + s.radius) {
      game.pickups.splice(i, 1);
      if (game.prog.lives < maxLives(game.prog)) {
        game.prog.lives++;
        hud.message(`EXTRA LIFE recovered — ${game.prog.lives} lives.`, 4);
      } else {
        addXp(game, 200);
        hud.message('Life pod converted to XP — lives already full.', 3.5);
      }
      sfx.sfxLife();
    }
  }
  game.lifeTimer -= dt;
  if (game.lifeTimer <= 0) {
    game.lifeTimer = PROG.LIFE_RESPAWN * (0.6 + Math.random() * 0.8);
    if (game.prog.lives < maxLives(game.prog) && game.pickups.length < PROG.LIFE_MAX_ACTIVE) {
      spawnLifePod(game);
    }
  }
}

// Dev time-scale (window.speed / the ?dev hotkeys): run the sim at
// game.timeScale × real time by calling update() several times per frame in
// 1x-sized chunks — the window.tick idiom — so everything riding dtReal
// (AI, timers, glow, cosmetic easing) sees the same per-step dt it does at
// 1x; only the step COUNT changes. A wall-clock budget drops the remainder
// when the machine can't keep up (a 20x ask on a heavy scene degrades to
// "as fast as this machine goes" instead of freezing the tab); speedActual
// records the achieved multiple so the HUD badge never lies about it.
function updateScaled(dtReal) {
  const scale = game.timeScale > 0 ? game.timeScale : 1;
  if (scale === 1) { update(dtReal); game.speedActual = 1; return; }
  let simLeft = dtReal * scale;
  let done = 0;
  const t0 = performance.now();
  while (simLeft > 1e-9) {
    const d = Math.min(simLeft, 1 / 60);
    update(d);
    done += d; simLeft -= d;
    if (performance.now() - t0 > 24) break;   // keep the frame interactive
  }
  game.speedActual = lerp(game.speedActual || 1, done / dtReal, 0.2);
}

function frame(now) {
  requestAnimationFrame(frame);
  const raw = now - last;   // honest frame time — sampled BEFORE the 20 fps clamp below
  const dtReal = Math.min(0.05, raw / 1000);
  last = now;
  perf.steps = 0;
  const t0 = performance.now();

  // The sim freezes on the splash, while paused, while settings is open, or
  // while an upgrade card is open; rendering and the HUD keep running so the
  // frozen world sits as a living backdrop under whichever overlay is up.
  if (game.started && !game.paused && !shellModal(game) && !game.choosingUpgrade) updateScaled(dtReal);
  else {
    // The sim is frozen — every state-driven loop must fall silent with it
    sfx.setThrust(false);
    sfx.setSpeed(0);
    sfx.setHeat(0);
    sfx.setScrape(0);
    sfx.setCharge(0);
    if (!game.started) driftSplash(dtReal);   // living title backdrop
    applyZoom();                              // a resize while frozen must still reframe
  }

  const t1 = performance.now();

  // The music director runs EVERY frame, frozen or not — menus duck it, and
  // it needs dtReal for its own smoothing even while the sim holds still.
  music.updateMusic(game, dtReal);

  render(game);
  hud.updateHud(game);

  // Sampled last so the overlay reports the frame it just finished. The badge
  // itself is written one frame behind (updateHud ran above) — nobody can see
  // a 16ms lag in a 5 Hz readout, and bracketing it here keeps the draw cost
  // honest instead of excluding the HUD from its own measurement.
  const t2 = performance.now();
  perf.frameMs = lerp(perf.frameMs, raw, PERF_EMA);
  perf.fps = lerp(perf.fps, raw > 0 ? 1000 / raw : 0, PERF_EMA);
  perf.simMs = lerp(perf.simMs, t1 - t0, PERF_EMA);
  perf.drawMs = lerp(perf.drawMs, t2 - t1, PERF_EMA);
}

requestAnimationFrame(frame);

// Debug/testing hooks: poke at state or step the sim from devtools
window.game = game;
window.musicState = music.musicState;   // live mood vector + bed gains
window.tick = (seconds) => {
  game.started = true;   // headless soaks bypass the splash and run the sim
  // ...and bypass the spec modal: default to the first spec if none chosen, so
  // the ability tree + picks work headlessly (override game.prog.spec first to test others).
  if (!game.prog.spec) { applySpec(game.prog, SPECS[0].id); game.st = shipStats(game.prog); }
  const dt = 1 / 60;
  // Music mood advances with the sim so soaks can assert on it (the rAF loop
  // is suspended in hidden tabs, where tick is the only clock).
  for (let t = 0; t < seconds; t += dt) {
    perf.steps = 0;   // frame() normally owns this; tick bypasses it, and a whole
    update(dt);       // tick's worth of substeps in the "per frame" slot would lie
    music.updateMusic(game, dt);
  }
  render(game);
  hud.updateHud(game);
};

// window.speed(n): run the LIVE game at n× real time (0.25–50; 1 = normal).
// The watchable counterpart to window.tick — tick teleports the sim forward
// headlessly, speed lets you WATCH a long stretch play out fast (or slow-mo a
// collision at 0.25). Rendering still happens once per display frame; the HUD
// badge shows the target and, when the machine can't keep up, the achieved
// rate (the per-frame wall-clock budget in updateScaled is the real ceiling —
// for truly unbounded fast-forward use window.tick / window.soak, which skip
// rendering entirely).
window.speed = (n = 1) => {
  game.timeScale = Math.min(50, Math.max(0.25, +n || 1));
  return game.timeScale;
};

// window.locate('vesper' | 'rogue'): first live body whose name contains the
// string (else whose type equals it). Handy with window.goto and for poking
// a specific body's state from the console.
window.locate = (q) => {
  q = String(q).toLowerCase();
  const alive = game.bodies.filter((b) => b.alive);
  return alive.find((b) => (b.name || '').toLowerCase().includes(q)) ||
         alive.find((b) => b.type === q) || null;
};

// window.goto('vesper') / window.goto(x, y): teleport the ship beside a named
// body — matching its velocity, parked just outside its radius — or to raw
// coordinates. Snaps the camera and grants brief invulnerability so the
// arrival isn't instantly punished. Doesn't resurrect a dead ship.
window.goto = (target, y) => {
  const s = game.ship;
  if (typeof target === 'number') {
    s.x = target; s.y = +y || 0; s.vx = 0; s.vy = 0;
  } else {
    const b = typeof target === 'string' ? window.locate(target) : target;
    if (!b) return null;
    s.x = b.x + b.radius + s.radius + 220; s.y = b.y;
    s.vx = b.vx || 0; s.vy = b.vy || 0;
  }
  s.invuln = Math.max(s.invuln, 2);
  game.cam.x = s.x; game.cam.y = s.y;
  game.predictRef = null;   // let the frame-relative trajectory re-pick its anchor
  return { x: Math.round(s.x), y: Math.round(s.y) };
};

// window.god(true/false): the ship ignores ALL damage (damageShip early-out,
// physics.js). For poking at dangerous places — corona, forts, gas cores —
// without respawn loops resetting the scene under you.
window.god = (on = true) => { game.godMode = !!on; return game.godMode; };

// window.freshRun(specIdx, seed): repeatable fresh run for dev/testing — a
// full resetRun on the given world seed (undefined = the default world) with
// the spec auto-picked (index into SPECS) and the sim armed. World layout is
// bit-identical for a given seed; runtime spawns still use Math.random unless
// window.mechTest's seeded-RNG swap is active.
window.freshRun = (specIdx = 0, seed) => {
  resetRun(seed);
  applyPick(specIdx);   // resetRun ends on the spec card; this picks it
  game.started = true;
  return game.prog;
};

// window.mechTest({seed, reset, download}): the scripted MECHANICS suite
// (devtest.js, lazy-loaded so normal play never pays for it). Fixed-seed
// world + Math.random swapped for a seeded RNG for the duration, so a run is
// repeatable end-to-end. Returns { passed, failed, results, logs } — also
// stashed on window.lastMechReport; {download: true} saves the JSON.
window.mechTest = async (opts = {}) => {
  const { runMechTest } = await import('./devtest.js');
  return runMechTest(game, {
    freshRun: window.freshRun,
    // The whole-game step (the tick idiom) so suite steps exercise the real
    // update path — picks, timers, glow, AI — not just raw physics.
    stepSim: (seconds) => { const dt = 1 / 60; for (let t = 0; t < seconds; t += dt) update(dt); },
  }, opts);
};

// window.soak(seconds, {idle}): one-call balance/stability soak. Arms the
// death/collision logs and the NaN counter, fast-forwards headlessly via
// window.tick (autoUpgrade forced on so picks never stall it), and returns
// the summary the balance-test skill judges against its pass criteria.
// {idle: true} kills the ship first — the cleanest sky-stability signal
// (no deathCause is set, so no life is spent and no death panel opens).
window.soak = (seconds = 600, opts = {}) => {
  if (opts.idle) game.ship.alive = false;
  const wasAuto = game.autoUpgrade;
  game.autoUpgrade = true;
  game.collisionLog = []; game.deathLog = []; game.nanEvents = 0;
  const census = () => {
    const c = {};
    for (const b of game.bodies) if (b.alive) c[b.type] = (c[b.type] || 0) + 1;
    return c;
  };
  const before = census();
  const t0 = performance.now();
  window.tick(seconds);
  const wallMs = Math.round(performance.now() - t0);
  const after = census();
  const frac = (t) => `${after[t] || 0}/${before[t] || 0}`;
  const deaths = game.deathLog.map((d) => `${d.type} ${d.how} @${d.t}s (m=${d.mass})`);
  game.autoUpgrade = wasAuto;
  return {
    simSeconds: seconds, wallMs,
    planets: frac('planet'), moons: frac('moon'),
    ship: game.ship.alive ? `alive, hull ${Math.round(game.ship.hull)}` : `dead${game.deathCause ? ` (${game.deathCause})` : ' (idle soak)'}`,
    lives: game.prog.lives, tier: game.prog.tier,
    deaths: deaths.length > 40 ? deaths.slice(0, 40).concat(`…+${deaths.length - 40} more`) : deaths,
    impacts: game.collisionLog.length,
    nanEvents: game.nanEvents,
  };
};
