import {
  CFG, PROG, SPECS, newProgress, shipStats,
  addXp, owesPick, xpForPick, pickIsMilestone, tierChoices, rankChoices,
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
import { initInput, readControls, mouseWorld } from './input.js';
import { initAudio, setThrust, setSoundEnabled, sfxUpgrade, sfxCollect } from './sfx.js';
import { lerp } from './util.js';

const game = {
  time: 0,
  started: false,          // false → splash screen; the sim doesn't run until START
  paused: false,
  settingsOpen: false,     // settings overlay (over splash or pause); freezes the sim
  soundOn: true,           // front-end audio toggle (persisted; see loadSettings)
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
  upgradeKind: null,       // 'spec' | 'tier' (new ability) | 'upgrade' (rank-up)
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
  evadeT: 0,                            // Evasion Roll cooldown (scout)
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

game.st = shipStats(game.prog);
generateWorld(game);
game.cam.x = game.ship.x; game.cam.y = game.ship.y;

const canvas = document.getElementById('game');
const view = initRender(canvas);
hud.initHud(game);

// Persisted front-end settings. localStorage is host-agnostic (works the same
// over serve.py and inside the Electron shell), so src/ stays packaging-blind.
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('ss_settings') || '{}');
    if (typeof s.sound === 'boolean') game.soundOn = s.sound;
    if (typeof s.predict === 'boolean') game.predict = s.predict;
  } catch (e) { /* fall back to defaults */ }
}
function saveSettings() {
  try {
    localStorage.setItem('ss_settings', JSON.stringify({ sound: game.soundOn, predict: game.predict }));
  } catch (e) { /* private mode / disabled storage — settings just won't persist */ }
}
loadSettings();
// Only act on a persisted MUTE here — the default (on) must init lazily inside
// the first user gesture, or Web Audio starts suspended and never resumes.
if (!game.soundOn) setSoundEnabled(false);

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
const menuBlocking = () => !game.started || game.paused || game.settingsOpen || game.choosingUpgrade;

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
          hud.message('Captured into your orbit! It shields you. Hold RIGHT MOUSE to charge a shotgun — longer hold arms more rocks.', 5);
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
  // EVASION ROLL (scout): tap Space -> dash toward the cursor with brief i-frames.
  onEvade: () => {
    if (menuBlocking() || !game.ship.alive || !game.st.evasion || game.evadeT > 0) return;
    const s = game.ship;
    const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    const burst = 340 + 80 * game.st.evasion;
    s.vx += Math.cos(ang) * burst; s.vy += Math.sin(ang) * burst;
    s.invuln = Math.max(s.invuln, 0.35 + 0.1 * game.st.evasion);
    game.evadeT = Math.max(0.6, 1.7 - 0.25 * game.st.evasion);
    sfxCollect();
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
    sfxCollect();
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

// ---- Front-end shell: splash / pause / settings transitions ----
// The sim runs only while game.started && !paused && !settingsOpen (frame gate);
// these just flip those flags. hud.syncMenus derives the visible overlay from them.
let firstStart = true;
let tipTimer = null;

function startGame() {
  game.started = true;
  game.paused = false;
  game.settingsOpen = false;
  // Drop the splash's wide framing onto the ship; the sim's zoom ramp + the
  // clearing blur then read as a dive from the establishing shot into play.
  game.cam.x = game.ship.x; game.cam.y = game.ship.y;
  // The run OPENS on a SPECIALIZATION choice, which sets your starting kit and
  // gates your ability tree. openSpec freezes the sim behind the card; the flight
  // guidance fires once a spec is chosen (applyPick 'spec' branch). Headless soaks
  // drive window.tick, which bypasses startGame and auto-picks a default spec.
  if (!game.choosingUpgrade && !game.prog.spec) openSpec();
}
function pauseGame() { if (game.started) game.paused = true; }
function resumeGame() { game.paused = false; }
function openSettings() { game.settingsOpen = true; }
function closeSettings() { game.settingsOpen = false; saveSettings(); }
function toMainMenu() { game.paused = false; game.settingsOpen = false; game.started = false; }

// ESC / P: context-sensitive. Never dismiss an upgrade card (you must pick one).
function toggleMenu() {
  if (game.choosingUpgrade) return;
  if (game.settingsOpen) { closeSettings(); return; }
  // Nothing to toggle on the splash, or over the death / game-over panel (both
  // are centered .panels — a pause menu would stack on top of them).
  if (!game.started || game.gameOver || !game.ship.alive) return;
  if (game.paused) resumeGame(); else pauseGame();
}
function toggleSound() { game.soundOn = !game.soundOn; setSoundEnabled(game.soundOn); saveSettings(); }

function exitGame() {
  // Desktop (Electron): closes the app window → quits the app. In a plain
  // browser tab window.close() is a no-op (a tab the script didn't open can't
  // close itself); the game ships primarily as a desktop app, where Exit is
  // meaningful, and this keeps src/ host-agnostic (no Electron/Node calls).
  window.close();
}

// Living title backdrop. The sim is frozen on the splash, so nothing moves on
// its own — we keep it alive two cheap ways: advance the COSMETIC render clock
// (sun corona, star twinkle, ring spins all read game.time; the sim never runs,
// so bodies don't actually orbit) and fly a slow, wide establishing shot of the
// inner system. The camera orbits the sun (at the origin) well zoomed-out so the
// star and its nearest planets sweep through frame; the ship spawns way out in
// the belt, so it stays off-screen here (no title-screen HUD, no spawn blink).
// startGame snaps the camera back to the ship, so the sim's zoom ramp reads as a
// dive from this wide shot down into your ship.
const SPLASH_ZOOM = 0.17;   // zoomCur for the wide shot (gameplay tier-0 is ~1.15)
function driftSplash(dt) {
  game.time += dt;
  game.splashT = (game.splashT || 0) + dt;
  const t = game.splashT;
  game.zoomCur = SPLASH_ZOOM * (1 + 0.05 * Math.sin(t * 0.12));   // gentle breathing
  const a = t * 0.06;                                            // slow orbit of the sun
  game.cam.x = Math.cos(a) * 4400;
  game.cam.y = Math.sin(a) * 4400;
}

hud.initMenus({
  // The START / settings clicks are the user gesture that unlocks Web Audio.
  onStart: () => { initAudio(); startGame(); },
  onResume: resumeGame,
  onPause: pauseGame,
  onMainMenu: toMainMenu,
  onOpenSettings: openSettings,
  onCloseSettings: closeSettings,
  onExit: exitGame,
  onToggleSound: () => { initAudio(); toggleSound(); },
  onTogglePredict: () => { game.predict = !game.predict; saveSettings(); },
});

// Apply the chosen card (spec / tier-up ability / small rank-up), then unfreeze.
function applyPick(i) {
  if (!game.choosingUpgrade || !game.upgradeChoices) return;
  const choice = game.upgradeChoices[i];
  if (!choice) return;
  if (game.upgradeKind === 'spec') {
    // Free run-opener: lock the specialization, grant its starting kit, begin play.
    applySpec(game.prog, choice.id);
    game.st = shipStats(game.prog);
    beginRunGuidance(choice);
  } else if (game.upgradeKind === 'tier') {
    // Milestone: dividend + tier bump FIRST, then the chosen new ability comes in
    // fresh at rank 1 (so the dividend doesn't double-count it), plus a life.
    consumePickCost(game.prog);
    applyTierUp(game.prog);
    applyAbility(game.prog, choice.id);
    game.prog.lives = Math.min(PROG.MAX_LIVES, game.prog.lives + 1);
    game.st = shipStats(game.prog);
    game.lastTier = game.st.tier;
    hud.message(`TIER UP — ${game.st.label.toUpperCase()}. ${choice.name} acquired. +1 life.`, 6);
  } else {   // 'upgrade' — small pick: deepen an ability you already own
    consumePickCost(game.prog);
    applyAbility(game.prog, choice.id);
    game.prog.picksThisTier++;
    game.st = shipStats(game.prog);
    hud.message(`${choice.name.toUpperCase()} rank ${game.prog.upgrades[choice.id]}.`, 3.5);
  }
  sfxUpgrade();
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

// The next owed pick: a TIER-UP (choose a new spec ability) at a milestone,
// otherwise a SMALL pick (deepen an owned ability). Freezes the sim behind it.
function openUpgrade() {
  const prog = game.prog;
  if (!prog.spec) return;   // no picks until a spec is chosen
  if (pickIsMilestone(prog)) {
    game.upgradeKind = 'tier';
    game.upgradeChoices = tierChoices(prog, 2);
    if (!game.upgradeChoices.length) {   // spec pool exhausted -> tier up with no new ability
      consumePickCost(prog);
      applyTierUp(prog);
      game.prog.lives = Math.min(PROG.MAX_LIVES, game.prog.lives + 1);
      game.st = shipStats(game.prog);
      game.lastTier = game.st.tier;
      sfxUpgrade();
      hud.message(`TIER UP — ${game.st.label.toUpperCase()}. +1 life.`, 5);
      return;
    }
  } else {
    game.upgradeKind = 'upgrade';
    game.upgradeChoices = rankChoices(prog, 2);
    if (!game.upgradeChoices.length) {   // nothing left to deepen (all owned abilities maxed) —
      consumePickCost(prog);             // still advance toward the tier-up so it isn't stuck,
      prog.picksThisTier++;              // where a NEW ability (and fresh rank-up fodder) waits
      return;
    }
  }
  game.choosingUpgrade = true;
  hud.setUpgradeVisible(game, game.upgradeChoices, game.upgradeKind, applyPick);
}

// Game over -> fresh run: wipe the build, regenerate the world, restart.
// `seed` is a dev/test hook (window.freshRun): undefined = the default world.
function resetRun(seed) {
  game.prog = newProgress();
  game.st = shipStats(game.prog);
  game.aliens.length = 0; game.debris.length = 0; game.particles.length = 0;
  game.flares.length = 0; game.bolts.length = 0; game.glowPockets.length = 0;
  game.orbit.length = 0; game.held = null; game.held2 = null; game.pickups.length = 0;
  game.gameOver = false; game.deathShown = false; game.deathCause = '';
  game.lastTier = 0; game.alienKills = 0; game.lifeTimer = PROG.LIFE_RESPAWN;
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
  generateWorld(game, seed);   // rebuilds bodies (cleared first) + spawn, calls respawnShip
  game.st = shipStats(game.prog);
  game.cam.x = game.ship.x; game.cam.y = game.ship.y;
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
// table keeps the order of the if-chain it replaced.
const EVENT_MSGS = [
  { flag: 'alienWarn', tut: 'alienSeen',
    first: ['WARNING: alien grabbers inbound — they throw rocks. Your orbit shield can block them.', 5] },
  { flag: 'rogueIncoming',
    first: ['SENSOR ALERT: a rogue planet has entered the sector.', 4.5] },
  { flag: 'tetherShow', tut: 'tether',
    first: [(v) => `TETHER THROW ×${v.toFixed(2)} — boosting while flinging whip-cracks the rock with your momentum.`, 4.5],
    repeat: [(v) => `TETHER THROW! ×${v.toFixed(2)}`, 1.8] },
  { flag: 'cometWarn', tut: 'comet',
    first: ['COMET SHOWER — fast ice crossing your sector. Dangerous, but premium shield ammo and 4x scrap.', 5.5],
    repeat: ['COMET SHOWER inbound!', 3] },
  { flag: 'flareWarn', tut: 'flare',
    first: ['SOLAR FLARE — the sun is erupting at you. MOVE!', 4.5],
    repeat: ['SOLAR FLARE INBOUND!', 2.5] },
  { flag: 'magmaWarn', tut: 'magma',
    first: ['MAGMA EJECTION — lava worlds hurl molten rock. It cools into dense fling ammo.', 5] },
  { flag: 'geyserWarn', tut: 'geyser',
    first: ['Cryo-geyser! Ice worlds pop free shield ammo into low orbit.', 5] },
  { flag: 'comboShow',
    first: [(v) => `GRAVITY BILLIARDS ×${v}! +${8 * v} scrap`, 2] },
  { flag: 'coreFound', tut: 'core',
    first: ['MINERAL CORE exposed — dense salvage. Catch it to fatten your beam, or smash it for scrap.', 5.5] },
  { flag: 'cacheCracked', tut: 'cache',
    first: ['SALVAGE CACHE cracked — scrap and shield ammo. Watch the lanes for more canisters.', 5.5] },
  { flag: 'glowMsg', tut: 'glow',
    first: ['GLOW POCKET — fly through the motes to mend your hull. These pockets are the only place it heals.', 6] },
  { flag: 'nestKilled',
    first: ['ALIEN NEST DESTROYED — this region of space is quiet now.', 6] },
  { flag: 'wrightWarn', tut: 'wright',
    first: ['WRECKWRIGHT — a scavenger is harvesting your battle debris. Kill it before it finishes building.', 5.5],
    repeat: ['WRECKWRIGHT descending on the debris field!', 3] },
  { flag: 'golemWarn',
    first: ['SCRAP-GOLEM assembled — your leftovers are hunting you.', 4.5] },
  { flag: 'fortShieldDownName',
    first: [(v) => `FORTRESS SHIELD DOWN at ${v} — smash the turrets!`, 4] },
  { flag: 'fortLiberatedName',
    first: [(v) => `${v.toUpperCase()} LIBERATED — the Bastion fort is destroyed. Salvage is yours.`, 5] },
  { flag: 'emberWarn', tut: 'ember',
    first: ['EMBERKIN ARTILLERY — this world is colonized. Icy rocks smother the reefs.', 5.5] },
  { flag: 'emberSeededName',
    first: [(v) => `The Emberkin have seeded ${v} — the bloom is spreading.`, 5.5] },
  { flag: 'emberCleansedName',
    first: [(v) => `${v} cleansed — the Emberkin bloom is extinguished.`, 5] },
  // ---- discovery-layer events ----
  { flag: 'vesperWarn', tut: 'vesper',
    first: ['COMET VESPER — a long-period wanderer, falling sunward. Its tail blooms at perihelion. Catch it if you can.', 6] },
  { flag: 'visitorWarn',
    first: ['DEEP-SPACE CONTACT: an interstellar object is crossing the system. It will not come back.', 6] },
  { flag: 'visitorGone',
    first: ['The interstellar visitor has left the system — forever.', 5.5] },
  { flag: 'stormWarn', tut: 'storm',
    first: ['SOLAR STORM — the sun has loosed a charged wave across the whole system. Watch the skies of nearby worlds.', 6],
    repeat: ['SOLAR STORM — a charged wave is sweeping the system.', 3.5] },
  { flag: 'auroraName', tut: 'aurora',
    first: [(v) => `AURORA — the storm wave is lighting up ${v}'s sky.`, 5],
    repeat: [(v) => `AURORA over ${v}.`, 3] },
  { flag: 'eclipseName',
    first: [(v) => `MOONSHADOW — a lunar eclipse is sweeping across ${v}.`, 5] },
  { flag: 'surveyMsg', first: [(v) => v, 4.5] },
  { flag: 'echoMsg', first: [(v) => v, 7.5] },
  { flag: 'graveyardWarn', tut: 'graveyard',
    first: ['GRAVEYARD ORBIT — pre-collapse wreckage rings the sun. Rich salvage… but the sun is very close.', 6] },
  { flag: 'ghostWarn', tut: 'ghost',
    first: ['UNKNOWN CONTACT — a repeating signal, close by. Something old is out here.', 6] },
  { flag: 'ringDecayName',
    first: [(v) => `The shepherd moon is gone — ${v}'s ring is beginning to scatter.`, 6] },
  { flag: 'volcWarn', tut: 'volc',
    first: ['FORGE MOON — this moon is volcanically alive. Its ejecta cools into dense slinging rock.', 5.5] },
  { flag: 'heatWarn', tut: 'heat',
    first: ['MELTDOWN WARNING — the heat is liquefying your hull. Turn back!', 4.5] },
  { flag: 'gasDiveWarn', tut: 'gasdive',
    first: ['CRUSH DEPTH — the atmosphere is collapsing your hull. The core will finish the job. CLIMB!', 5] },
  { flag: 'flareHitWarn',
    first: ['FLARE STRIKE — the surge fries your engines! Half your shield rocks are blown loose.', 4.5] },
  { flag: 'scrapeWarn', tut: 'scrape',
    first: ["HULL SCRAPING — you're grinding along the surface. Pull up!", 4.5] },
];

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
    const { vw, vh } = view.getView();
    const m = mouseWorld(game, vw, vh);
    game.aim.x = m.x; game.aim.y = m.y;
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
    if (game.evadeT > 0) game.evadeT -= dtReal;             // Evasion Roll cooldown
    if (game.warpT > 0) game.warpT -= dtReal;               // Slipstream cooldown

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
    // only at glow pockets — glow.js). Delay/rate scale with Shield Regen.
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
    }
    if (!s.alive && game.deathCause && !game.deathShown) {
      game.deathShown = true;
      game.prog.lives--;   // a life is spent per death (upgrades are kept)
      if (game.prog.lives <= 0) {
        game.gameOver = true;
        hud.setGameOverVisible(true, game.deathCause);
      } else {
        hud.setDeathVisible(true, game.deathCause, game.prog.lives);
      }
    }
    if (s.alive && game.deathShown) game.deathShown = false;

    setThrust(s.alive && (s.thrusting || s.braking));

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
      if (game.prog.lives < PROG.MAX_LIVES) {
        game.prog.lives++;
        hud.message(`EXTRA LIFE recovered — ${game.prog.lives} lives.`, 4);
      } else {
        addXp(game, 200);
        hud.message('Life pod converted to XP — lives already full.', 3.5);
      }
      sfxCollect();
    }
  }
  game.lifeTimer -= dt;
  if (game.lifeTimer <= 0) {
    game.lifeTimer = PROG.LIFE_RESPAWN * (0.6 + Math.random() * 0.8);
    if (game.prog.lives < PROG.MAX_LIVES && game.pickups.length < PROG.LIFE_MAX_ACTIVE) {
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
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;

  // The sim freezes on the splash, while paused, while settings is open, or
  // while an upgrade card is open; rendering and the HUD keep running so the
  // frozen world sits as a living backdrop under whichever overlay is up.
  if (game.started && !game.paused && !game.settingsOpen && !game.choosingUpgrade) updateScaled(dtReal);
  else {
    setThrust(false);
    if (!game.started) driftSplash(dtReal);   // living title backdrop
    applyZoom();                              // a resize while frozen must still reframe
  }

  render(game);
  hud.updateHud(game);
}

requestAnimationFrame(frame);

// Debug/testing hooks: poke at state or step the sim from devtools
window.game = game;
window.tick = (seconds) => {
  game.started = true;   // headless soaks bypass the splash and run the sim
  // ...and bypass the spec modal: default to the first spec if none chosen, so
  // the ability tree + picks work headlessly (override game.prog.spec first to test others).
  if (!game.prog.spec) { applySpec(game.prog, SPECS[0].id); game.st = shipStats(game.prog); }
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) update(dt);
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
