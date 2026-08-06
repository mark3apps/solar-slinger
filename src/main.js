import {
  CFG, PROG, SPECS, newProgress, shipStats, maxLives,
  addXp, owesPick, pickIsMilestone, tierChoices,
  consumePickCost, applyAbility, applySpec, applyTierUp, shelterR, stormClass,
  stormStrength,
} from './config.js';
import { Ship } from './entities.js';
import { generateWorld, respawnShip, replenishWorld, spawnLifePod } from './world.js';
import { step, updateFieldLOD, frameReg, clearDocks, dockReady } from './physics.js';
import { updateTractor, updateOrbit, updateTethers, updateLatch, cancelLatch, tryGrab, tryAutoSecond, releaseHeld, addToOrbit, stowFromCursor, absorbIntoRam, flingAllFromOrbit, retrieveFromOrbit, aimSolutions } from './tractor.js';
import { updateAliens } from './ai.js';
import { updateGlow } from './glow.js';
import {
  newAchState, updateAchievements, bump, best, noteDeath, noteHullGrant, ACH_EVENT_STATS,
} from './achievements.js';
import { initRender, render, setRenderScale } from './render.js';
import {
  chart, chartReset, chartPick, chartZoomAt, chartPanTo, chartDragEnd, chartEase, newRoute,
  addWaypoint, removeWaypoint, clearRoute, updateRoute,
} from './starmap.js';
import * as hud from './hud.js';
import { initInput, input, readControls, mouseWorld } from './input.js';
import * as sfx from './sfx.js';
import * as music from './music.js';
import * as zone from './zone.js';
import { lerp, shellModal, seedFrom, placeName } from './util.js';

// A run's progression record. config.newProgress builds the roguelite half;
// the achievement ledger is bolted on HERE rather than inside it because
// config.js is a leaf and must never import achievements.js (which imports
// config). Both halves are created and destroyed together, so `prog` stays the
// one thing a run is.
function freshProgress() {
  const p = newProgress();
  p.ach = newAchState();
  return p;
}

const game = {
  time: 0,
  started: false,          // false → splash screen; the sim doesn't run until START
  paused: false,
  settingsOpen: false,     // settings overlay (over splash or pause); freezes the sim
  controlsOpen: false,     // the control schematic — same shell rules (util.shellModal)
  creditsOpen: false,      // the credits panel  — same shell rules
  achievementsOpen: false, // the run's achievement log — same shell rules
  mapOpen: false,          // the sun-centred system chart — same shell rules (starmap.js)
  route: newRoute(),       // the plotted journey: an ordered list of stops the chart
                           //   sets and the radar flies you along. Run state, so
                           //   resetRun clears it; the chart's VIEW is not, and lives
                           //   on starmap.chart instead.
  musicVol: 0.85,          // volume sliders (persisted; zero = mute, there are no
  sfxVol: 0.5,             //   toggles) — music high / SFX low by default: quiet
                           //   ambient tracks vs hot sample packs
  seedText: '',            // world seed AS TYPED in settings (persisted); '' = roll a new one every run
  seedPin: null,           // that text resolved to a uint32, or null when it's blank
  worldSeed: 0,            // the seed the LIVE world was actually built from
  showFps: false,          // perf overlay toggles (persisted) — FPS line / full metrics block
  showPerf: false,
  renderScale: 1,          // RENDER SCALE setting (persisted): fraction of native device
                           //   pixels the world canvas is drawn at. This is a CEILING —
                           //   auto quality may step BELOW it, never above.
  autoScale: true,         // let a struggling frame drop below that ceiling (persisted)
  renderScaleEff: 1,       // the scale actually in force (setting minus auto notches);
                           //   surfaced in the perf overlay so a drop is never invisible
  version: '',             // build version for the credits panel (fetched from package.json)
  ship: new Ship(),
  bodies: [],
  aliens: [],
  glowPockets: [],         // healing glow-mote pockets, orbiting the sun (glow.js)
  debris: [],
  particles: [],
  flares: [],              // solar plasma in flight
  bolts: [],               // Bastion turret fire in flight
  prog: freshProgress(),   // roguelite build: xp / level / tier / upgrades / lives / achievements
  st: null,
  pickups: [],             // drifting life pods (world.js seeds/replenishes)
  // WHAT IS BEING OFFERED, and whether it holds the run up. The two Choices/Kind
  // fields carry every pick; choosingUpgrade is the FREEZE, and only the
  // run-opening spec card sets it. An ability pick ('tier'/'upgrade') is offered
  // in place on the pilot card and the sim keeps running under it.
  choosingUpgrade: false,  // sim frozen while the SPEC card is open
  upgradeChoices: null,    // the live cards — null when nothing is owed
  upgradeKind: null,       // 'spec' | 'tier' (milestone) | 'upgrade' — cards always offer NEW abilities
  rankUps: [],             // AUTOMATIC ability ranks landed since the last drain (config.growAbilities
                           //   pushes, update() drains into messages + the hull-gain heal)
  achQueue: [],            // achievements landed since the last drain — same event-flag shape
                           //   as rankUps; update() drains it into toasts + a sound
  gameOver: false,
  lifeTimer: PROG.LIFE_RESPAWN,
  held: null,
  held2: null,             // Twin Grip (hauler): a second held rock
  flingDelayT: 0,          // >0 briefly after a fling — holds the pick offer back so a
                           // threshold crossed mid-throw doesn't pop cards up mid-aim
  orbit: [],               // bodies circling the ship as a shield
  ramFx: [],               // brawler: rocks mid-crush into the ram (render only)
  tetherT: 0,              // Recovery Tether reload — seconds until a throw may arm the tether again
  stowEating: false,       // RMB held (hauler): the ring keeps stowing what the cursor crosses
  stowEatCd: 0,            // seconds until the stow sweep may seat another rock
  ramEating: false,        // RMB held: the ram keeps eating what the cursor crosses
  ramTierDropT: 0,         // >0 just after the barrier lost a density tier (render shudder)
  ramEatCd: 0,             // seconds until the held-button sweep may crush again
  orbitAngle: 0,
  aim: { x: 0, y: 0 },
  controls: { f: 0, b: 0, boost: 0 },   // boost = Afterburner (hold Shift)
  burnerFuel: 1,                        // Afterburner tank 0..1 (the BURN bar; refills slowly)
  burnerOn: false,                      // actually burning right now (physics reads this, not raw Shift)
  // ---- THE SOLAR WAVE (CFG.STORM_*). world.js owns the wave's geometry;
  // these are the SHIP's relationship to it, resolved once per frame in
  // updateStorm and read by physics/render/ai — never re-derived there.
  stormCls: null,          // the CFG.STORM_CLASSES row charging or in flight
  stormChargeT: 0,         // sun loading before the front fires (the telegraph)
  stormChargeMax: 0,       // …what it started at, so the telegraph can ramp 0->1
  stormExposed: false,     // in the sheath with no world between us and the sun
  stormShelter: null,      // the world whose lee we're in, when we are in one
  stormIonT: 0,            // seconds of sensor scramble left (outlives exposure)
  // …what stormIonT was last SET to (the class's `ion` scaled by the wave's
  // remaining strength, refreshed every exposed frame), NOT the class maximum.
  // It exists because stormIonT outlives the wave that set it, so render has to
  // normalise the wash against the thing that actually set it.
  stormIonMax: 0,
  stormBlind: false,       // alien senses are down system-wide (util.senseBlind)
  stormRode: 0,            // seconds ridden exposed this wave (capped payout)
  evadeT: 0,                            // Dash Jets cooldown (scout, A/D)
  dashT: 0,                             // brief side-jet flash after a dash (render)
  dashDir: 0,                           // which way the last dash went (-1 left / +1 right)
  autoEvadeT: 0,                        // Reflex Jink recharge (scout auto-dodge, physics.step)
  jinkT: 0,                             // brief flash ring after an auto-dodge (render)
  parryReadyT: 0,                       // one-shot bloom when the Deflector re-arms (render)
  warpT: 0,                             // Slipstream cooldown (scout)
  cam: { x: 0, y: 0, zoom: 1.15 },
  zoomCur: 1.15,           // animated camera zoom (no manual control)
  viewPin: null,           // {vw, vh} a HARNESS may pin the sim's view to (simView) — null in play
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
  // Beam grip, 0..1 — how far the tractor has spooled up on each held rock
  // (tractor.springHeld writes it, render.drawBeam is the only reader).
  heldGrip: 1,
  heldGrip2: 1,
  // The THROW-POWER readout for the rock in hand (tractor.springHeld writes all
  // four). heldCharged is the READY state — render turns the beam near-white
  // for it — and chargeFlashT is the one-shot bloom on the crossing;
  // heldChargeShow gates both to loads where the wind-up costs something.
  // heldCharge is the raw wind-up fraction: render no longer draws it (there is
  // deliberately no progress bar), but it is the measurable truth the test
  // harness reads to time "full power at".
  heldCharge: 0,
  heldCharged: false,
  heldChargeShow: false,
  chargeFlashT: 0,
  // One record per launch — the muzzle flash (tractor.pushLaunchFx writes,
  // render.drawLaunchFx draws, the dtReal block below ages and reaps).
  launchFx: [],
  // The WINCH in progress on a moon/world: { body, t, need } (tractor.updateLatch).
  latch: null,
  // ---- DOCKING (physics.updateDock owns all of it; util.padPos reads it) ----
  // A DOCK IS A STRUCTURE, NOT A STATE — see the section comment in physics.js.
  docks: [],               // every station standing (or half-built) this run:
                           //   { b, ang, rf, t }, t = build seconds banked.
  dock: null,              // the station the ship is BERTHED at right now, or null.
                           //   A REFERENCE into docks, never a copy — the build
                           //   clock ticks on the station itself.
  home: null,              // the station a respawn uses. Also a reference into docks.
  launch: null,            // { t } while the release sequence is running (CFG.LAUNCH_*)
  dockFlashT: 0,           // one-shot bloom on the pad as a station goes live (render)
  domeHitT: 0,             // …and a rim flare where the shield last threw something off
  domeHitA: 0,             //   (world bearing of that bite)
  dockT: 0,                // approach guidance, published per substep: latch fill 0..1,
  dockCand: null,          //   the world being landed on,
  dockGate: '',            //   and which gate is refusing ('' | 'level' | 'fast')
  lastTier: 0,
  oortWarnT: 0,
  volleyT: 0,
  volleySel: 0,            // how many orbiters the shotgun charge has armed
  volleyCharging: false,
  lockTarget: null,
  timeScale: 1,            // dev sim speed (window.speed / ?dev hotkeys); 1 = normal play
  speedActual: 1,          // achieved multiple when fast-forwarding (HUD badge honesty)
  tut: { grabbed: false, flung: false, orbited: false, alienSeen: false, glow: false, stormLee: false },
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
    // Snapped to a real step rather than clamped: a stored 0.6 would otherwise
    // survive as a scale the segmented control can never show as selected.
    if (typeof s.renderScale === 'number' && RENDER_STEPS.includes(s.renderScale)) game.renderScale = s.renderScale;
    if (typeof s.autoScale === 'boolean') game.autoScale = s.autoScale;
    if (typeof s.seedText === 'string') setSeedText(s.seedText);
  } catch (e) { /* fall back to defaults */ }
}
function saveSettings() {
  try {
    localStorage.setItem('ss_settings', JSON.stringify({
      musicVol: game.musicVol, sfxVol: game.sfxVol, predict: game.predict,
      showFps: game.showFps, showPerf: game.showPerf, seedText: game.seedText,
      renderScale: game.renderScale, autoScale: game.autoScale,
    }));
  } catch (e) { /* private mode / disabled storage — settings just won't persist */ }
}

// ---- Adaptive render scale --------------------------------------------------
// Draw cost is fill-bound (render.js: ~1.4ms fixed + ~0.18ms/megapixel on a
// FAST gpu; old integrated parts are far worse), and a Retina panel asks for 4x
// the pixels of a dpr-1 one. So the pixel count is the one quality knob worth
// having, and a machine that can't hold the frame gets it turned down for it.
//
// The steps run HIGH -> LOW; the player's setting is an index into them and
// `autoDrop` counts notches below it. Only three, deliberately: each is a
// visible softening, and a menu of eight is a menu nobody reads.
const RENDER_STEPS = [1, 0.75, 0.5];
// Thresholds are ASYMMETRIC and the dwell is long, because a resolution change
// is SEEN — a scale that hunts is worse than one that is simply too low.
const SCALE_DOWN_MS = 22;    // ~45 fps sustained: the frame is genuinely missing its budget
const SCALE_UP_MS = 17.5;    // ~57 fps: back inside a 60 fps budget
const SCALE_DWELL = 5;       // s a verdict must hold CONTINUOUSLY before ONE notch moves
const SCALE_WARMUP = 6;      // s of boot (world gen, shader/JIT warm-up) that always lie
let autoDrop = 0;
let scaleHold = 0;
let scaleWarm = SCALE_WARMUP;

// Effective scale = the setting, stepped down by however many notches auto
// quality has taken. Pushing it through render.setRenderScale re-runs the whole
// sizing path, so the zero-size guard and the radar's own sizing are always
// re-established from one place.
function applyRenderScale() {
  const base = Math.max(0, RENDER_STEPS.indexOf(game.renderScale));
  const eff = RENDER_STEPS[Math.min(RENDER_STEPS.length - 1, base + autoDrop)];
  if (eff === game.renderScaleEff) return;
  game.renderScaleEff = eff;
  setRenderScale(eff);
}

// One notch at a time, on a dwell timer. DOWN reads frameMs directly; UP cannot,
// because rAF is vsync-capped — frameMs can never read below ~16.7ms on a 60Hz
// panel however much headroom there is, so "16.7" answers "am I keeping up?" and
// says nothing about "can I afford more pixels?". The climb therefore PROJECTS
// the next notch's cost from the draw time actually being paid: draw is ~propor-
// tional to pixel count, so scaling by k multiplies the fill term by k². Treating
// ALL of drawMs as fill overestimates the step, which is the safe direction — it
// makes the climb reluctant, and a reluctant climb cannot oscillate.
function updateAutoScale(dtReal) {
  // Never while fast-forwarding: updateScaled deliberately burns a ~24ms budget
  // per frame, and that is a SIM cost — cutting pixels would not touch it.
  if (!game.autoScale || (game.timeScale || 1) !== 1) { scaleHold = 0; return; }
  if (scaleWarm > 0) { scaleWarm -= dtReal; return; }
  const cur = game.renderScaleEff || 1;
  const base = Math.max(0, RENDER_STEPS.indexOf(game.renderScale));
  const idx = Math.max(0, RENDER_STEPS.indexOf(cur));
  let want = 0;   // -1 = drop a notch, +1 = climb back toward the player's ceiling
  if (game.perf.frameMs > SCALE_DOWN_MS && idx < RENDER_STEPS.length - 1) want = -1;
  else if (game.perf.frameMs < SCALE_UP_MS && idx > base) {
    const up = RENDER_STEPS[idx - 1];
    const proj = game.perf.frameMs + game.perf.drawMs * ((up * up) / (cur * cur) - 1);
    if (proj < SCALE_DOWN_MS - 2) want = 1;   // and land clear of the down gate, not on it
  }
  if (!want) { scaleHold = 0; return; }
  scaleHold += dtReal;
  if (scaleHold < SCALE_DWELL) return;
  scaleHold = 0;   // also enforces >= SCALE_DWELL between two changes
  autoDrop = Math.max(0, autoDrop - want);
  applyRenderScale();
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
  if (game.ramFx) game.ramFx.length = 0;   // crush effects point at the old world's rocks
  game.held = null; game.held2 = null;
  sfx.setBeam(false);   // the hum is edge-triggered — a reset must drop it too
  // The dock and the home port pin to BODIES, so they die with the world the
  // way a chart route's stops do — and this has to happen BEFORE generateWorld,
  // which respawns the ship: a home port left pointing into the dead system
  // would place the fresh run's ship on a planet that no longer exists.
  clearDocks(game);
  game.worldSeed = seed ?? pickSeed();
  generateWorld(game, game.worldSeed);   // clears game.bodies itself, then respawns the ship
  game.cam.x = game.ship.x; game.cam.y = game.ship.y;
}

loadSettings();
applyRenderScale();   // before initRender: render.js's first resize() picks it up
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

// Arm the audio context on the FIRST user gesture anywhere on the page, not
// just on a shell button. Browsers refuse to build an AudioContext outside a
// gesture, and every other initAudio call site is a menu button — so on a cold
// load the title theme could only ever start on a click of SETTINGS / CONTROLS
// / CREDITS. A click on START armed audio and left the run, and the splash's
// own bed never played at all. pointerdown/keydown fire BEFORE the button's
// click handler, so the theme is already coming up as the panel is used.
// Passive + once: this costs nothing after the first event.
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => sfx.initAudio(), { once: true, passive: true });
}

// THE SIM'S VIEW SIZE, WHICH A HARNESS MAY PIN. The fair view below already
// makes game.viewR window-size-INDEPENDENT: viewR is hypot(vw,vh)/2/cam.zoom
// and cam.zoom carries the same hypot, so it reduces to VIEW_REF_DIAG/2/zoomCur
// and the window cancels. MEASURED: that cancellation is exact in float too —
// viewR is byte-identical (7867.525607436779) at 1024x736, 1440x868 and
// 1920x1018, and mechTest's whole report matches across all three WITHOUT this
// pin. So the pin fixes nothing observed; it makes the property STRUCTURAL.
// It is worth having because the thing it guards is sharp: viewR gates RNG
// DRAW COUNTS (world.replenishWorld's leash test skips the rng() draws behind
// it on a `continue`) and cam.zoom maps the parked cursor to a world distance,
// so if that float cancellation ever stopped being exact — a different zoomCur,
// a different machine — mechTest's bit-repeatability contract would break with
// no obvious cause. runMechTest pins game.viewPin for its duration (issue #104).
// SIM-CLOCK READERS ONLY. The chart's DOM handlers below deliberately keep the
// raw view.getView(): they map a REAL cursor into chart space, and a pinned
// width would put the hit test somewhere the user isn't pointing.
function simView() { return game.viewPin || view.getView(); }

// Fair view: fold the canvas-size normalization into cam.zoom itself —
// mouseWorld, viewR, render culling, and the /zoom UI-stroke idiom all read
// cam.zoom, so this one assignment keeps every consumer consistent.
function applyZoom() {
  const { vw, vh } = simView();
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
// in the pause menu, mid-settings, or while the spec card is open. An ability
// pick is deliberately NOT in here: it is offered on the pilot card and the run
// goes on around it, so it blocks nothing.
const menuBlocking = () => !game.started || game.paused || shellModal(game) || game.choosingUpgrade;
// A BERTHED SHIP IS PARKED, NOT FLYING. The clamps hold it, the engine answers
// to the launch sequence and nothing else, and the beam has stood down
// (tractor.standDown at the berth) — so the tractor, the orbit ring, the
// shotgun and the mobility abilities all refuse while docked, and update()
// skips their per-substep work entirely. Half-disabling them was the trap: a
// beam you can still fire from a pad would re-fill a ring the dock just
// emptied, and a warp would tear the hull off a station it is clamped into
// without ever running the release.
//
// Separate from menuBlocking on purpose — this blocks GAMEPLAY verbs, not the
// shell. H (home port), M (chart), V, P and R must all still work at a dock;
// standing at your own home port and being unable to open the chart would be
// absurd.
const dockBlocking = () => !!game.dock;

initInput(canvas, {
  onGrab: () => {
    if (menuBlocking() || dockBlocking() || !game.ship.alive) return;
    // tryGrab reports WHAT THE CLICK DID, not a boolean (see its doc comment).
    // The orbit-retrieve fallback below is for an EMPTY click only: a click the
    // beam answered — a winch it just started, or a refusal it just sounded —
    // must not also reach in and pull a rock back out of your own shield ring.
    const did = tryGrab(game);
    if (did === 'held') {
      // LEFT-CLICK IS THE BEAM, FULL STOP (user call, 2026-08). It used to
      // AUTO-STOW anything that fit the ring, which made one button mean two
      // things depending on the rock's mass — throw this pebble, silently pocket
      // that one — and left no way to THROW a stowable rock at all. The stow is
      // right-click now (onRmbDown), the same button and the same verb the
      // brawler uses to feed its ram.
      if (!game.tut.grabbed) {
        game.tut.grabbed = true;
        hud.message('Got it! RELEASE to FLING it toward the cursor. Good moves earn XP — level up to pick upgrades.', 5);
      }
    } else if (did === null && retrieveFromOrbit(game)) {
      if (!game.tut.retrieved) {
        game.tut.retrieved = true;
        hud.message('Rock pulled back from your orbit — release to fling it.', 4);
      }
    }
  },
  onFling: () => {
    // Letting go mid-winch abandons it — the winch is a HELD commitment, and
    // banking partial progress would turn "hold to take a moon" back into a
    // click you repeat.
    //
    // ABOVE THE MENU GATE, and it has to stay there. mouseup is a WINDOW
    // listener (input.js), so a release while paused / in settings / on the
    // spec card still clears input.mouseDown. Behind the gate that release was
    // banked: updateLatch never reads the mouse, so game.latch survived the
    // freeze and completed itself on resume, handing the player a moon they had
    // let go of. (The bug was found through the old freezing pick card, which
    // could land mid-winch — game.held is null while a winch runs. Ability
    // picks no longer freeze anything, but every other freeze still can.)
    cancelLatch(game);
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
    if (menuBlocking() || dockBlocking()) return;
    // BRAWLER: RIGHT-CLICK IS THE RAM, and it has exactly one meaning — eat the
    // rock you are pointing at. It is tried FIRST and before the held-rock
    // branch, because a rock already in the beam is the most obvious thing in
    // the world to want to crush. (Routing it through addToOrbit first was the
    // bug: the brawler has no ring, so a held rock went to a stow with zero
    // slots, failed, and got dropped on the floor.) There is NO release move on
    // this button and no way to throw the ram at all — it is a structure you
    // build and ride behind, spent only by ramming, and the one way to lose it
    // is to let something hit it.
    if (game.st.frontRam) {
      // HOLDING the button keeps eating: ramEating arms a per-substep sweep in
      // update() that crushes ANY rock the cursor passes over while the button
      // stays down — mow the cursor through a debris field and the ram hoovers
      // it up. The immediate call keeps a tap responsive (one click, one rock).
      game.ramEating = true;
      if (absorbIntoRam(game)) {
        // Arm the sweep's cooldown too: the immediate crush and the held-button
        // sweep share ONE cadence, or a single click absorbed twice inside the
        // 0.12s window — once here, once in update()'s sweep on the next frame.
        game.ramEatCd = 0.12;
        if (!game.tut.orbited) {
          game.tut.orbited = true;
          hud.message('Crushed into your ram! Rocks fuse into ONE mass riding ahead of your bow — the bigger it is, the harder you hit, and it eats head-on damage until it is gone. HOLD RIGHT MOUSE and sweep over rocks to keep feeding it.', 6);
        }
      }
      return;
    }
    if (game.held) {
      // Send the held rock (back) into your orbit; too big -> gentle drop
      if (!addToOrbit(game)) releaseHeld(game, false);
      return;
    }
    // HAULER: RIGHT-CLICK IS THE STOW (user call, 2026-08), exactly as it is the
    // ram for the brawler — one button, one meaning: "put that in my rack". It
    // used to happen as a SIDE EFFECT of a left-click grab (onGrab auto-stowed
    // anything that fit), which made the left button mean two different things
    // depending on the rock's mass: throw this pebble, but silently pocket that
    // one. You could not choose to THROW a stowable rock at all.
    // Pointing at a rock claims the press for the stow; pointing at nothing
    // leaves it to the shotgun below. The choice is COMMITTED for the whole
    // press (stowEating), so a sweep that starts on a rock and crosses empty
    // space keeps stowing instead of arming a volley mid-drag.
    if (!game.st.frontRam && game.st.maxOrbiters > 0 && stowFromCursor(game)) {
      game.stowEating = true;
      game.stowEatCd = 0.12;
      if (!game.tut.orbited) {
        game.tut.orbited = true;
        // DON'T PROMISE THE SHOTGUN. `hasVolley` is false for every reachable
        // build — Scattergun was deleted with the brawler's trailing rack and
        // nothing feeds the volley channel — so the old copy here ("hold RIGHT
        // MOUSE to charge a shotgun") described a move the player could never
        // make. LEFT-click on empty space is the real way rock comes back out
        // (main.onGrab -> retrieveFromOrbit), so that is what this says.
        hud.message('Stowed into your orbit ring! HOLD RIGHT MOUSE and sweep over rocks to keep filling it. LEFT-CLICK empty space to pull one back out and throw it.', 6);
      }
      return;
    }
    // The shotgun is an upgrade — no charge until the array is unlocked
    if (game.st.hasVolley && game.orbit.length) game.volleyCharging = true;
  },
  onRmbUp: () => {
    game.ramEating = false;
    game.stowEating = false;
    if (menuBlocking()) { game.volleyCharging = false; return; }
    // Release fires whatever the hold has armed (a tap = 1 rock). The brawler
    // never charges — its right-click is the ram absorb, and the ram cannot be
    // thrown or fired at all.
    if (game.volleyCharging && game.orbit.length && game.ship.alive) fireVolley();
    game.volleyCharging = false;
  },
  onMenuKey: () => toggleMenu(),
  onRespawn: () => {
    if (game.ship.alive) return;
    if (game.gameOver) { resetRun(); return; }
    // A life was already spent at the moment of death; upgrades are KEPT.
    respawnShip(game);
    bump(game, 'respawns');
    hud.setDeathVisible(false);
  },
  // V: the run's achievement log. Same context-sensitivity as the other shell
  // panels — it toggles, it never opens over an upgrade card, and it is
  // meaningless before START.
  onAchievements: () => {
    if (game.choosingUpgrade || !game.started) return;
    if (game.achievementsOpen) { closeShellPanel(); return; }
    openAchievements();
  },
  // M: the system chart. Same context-sensitivity as the achievement log —
  // it toggles, it never opens over an upgrade card, and a chart of a system
  // you haven't been dropped into yet says nothing.
  onMap: () => {
    if (game.choosingUpgrade || !game.started) return;
    if (game.mapOpen) { closeShellPanel(); return; }
    openMap();
  },
  onTogglePredict: () => { game.predict = !game.predict; saveSettings(); },
  onUpgradePick: (i) => pickFromUi(i),
  // DASH JETS (scout): tap A / D -> dart hard to the ship's left/right with
  // brief i-frames. Sideways relative to the NOSE (angle ± 90°), not the
  // cursor — a positioning twitch, not a lunge.
  onDash: (dir) => {
    if (menuBlocking() || dockBlocking() || !game.ship.alive || !game.st.evasion || game.evadeT > 0) return;
    const s = game.ship;
    const ang = s.angle + dir * Math.PI / 2;
    const burst = 380 + 35 * game.st.evasion;
    s.vx += Math.cos(ang) * burst; s.vy += Math.sin(ang) * burst;
    s.invuln = Math.max(s.invuln, 0.25 + 0.04 * game.st.evasion);
    game.evadeT = Math.max(0.45, 1.2 - 0.1 * game.st.evasion);
    game.dashT = 0.22; game.dashDir = dir;   // render: side-jet flash
    bump(game, 'dashes');
    sfx.sfxEvade();
  },
  // SLIPSTREAM (scout): tap F -> warp a fixed distance toward the cursor.
  onWarp: () => {
    if (menuBlocking() || dockBlocking() || !game.ship.alive || !game.st.slipstream || game.warpT > 0) return;
    const s = game.ship;
    const ang = Math.atan2(game.aim.y - s.y, game.aim.x - s.x);
    const dist = game.st.warpDist;
    s.x += Math.cos(ang) * dist; s.y += Math.sin(ang) * dist;
    game.cam.x = s.x; game.cam.y = s.y;   // snap the camera to the exit point
    // A WARP PAYS THE ROPE OUT; IT DOES NOT DRAG THE LOAD THROUGH THE JUMP.
    //
    // The ship just moved 950-1300 units in zero time. A held rock that is
    // already at full power has a LIVE rope (tractor.springHeld) sized to the
    // gap it engaged at, and the backstop there acts against that length — so
    // without this the next substep saw `over = d - lim` of several hundred
    // units and applied the whole warp as a one-frame position snap to the ship
    // and the rock both. That is precisely the bug b.ropeL was added to kill.
    // Clearing it re-seeds the rope at the new distance and hauls it in at the
    // bounded CFG.TETHER_REEL: light loads are back in the beam almost at once
    // (the spring outruns the reel), and a moon stays where it was and gets
    // TOWED, which is the honest answer — a warp is a ship ability, not free
    // transport for a world.
    if (game.held) game.held.ropeL = null;
    if (game.held2) game.held2.ropeL = null;
    s.invuln = Math.max(s.invuln, game.st.warpInvuln);
    game.warpT = game.st.warpCool;
    // Reclassify the field LOD at the exit point (dt 0 = no rail advance):
    // a ~1000u jump can outrun the wake bubble's guaranteed margin, and the
    // renderer skips dormant rocks outright — without this, a warp INTO a
    // shoal would show empty space for one frame.
    updateFieldLOD(game, 0);
    bump(game, 'warps');
    sfx.sfxWarp();
  },
  // HOME PORT (H): promote the pad the ship is currently docked at to the
  // run's respawn point. The DOCK is earned by flying (physics.updateDock);
  // making it home is a CHOICE, and a deliberate one — it is the only thing in
  // the game that moves where a death puts you back, so it must never happen
  // as a side effect of landing somewhere to patch the hull.
  onHome: () => {
    if (menuBlocking() || !game.ship.alive) return;
    const d = game.dock;
    if (!d) { game.homeNoDockWarn = true; return; }
    // Only a FINISHED station can be a home port — a respawn puts the ship on
    // a pad that has to actually be there and actually work.
    if (!dockReady(d)) { game.homeBuildingWarn = true; return; }
    if (game.home === d) { game.homeSameWarn = true; return; }
    // THE STATION ITSELF, not a copy of it. `home` and `dock` are both
    // references into game.docks, so promoting one is a pointer — a copy would
    // fork the build clock and leave the home port frozen at whatever progress
    // it happened to be at.
    game.home = d;
    game.homeSetName = placeName(d.b);
    game.dockFlashT = 0.9;
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
function pauseGame() {
  if (game.started && !game.paused) { game.paused = true; bump(game, 'pauses'); sfx.sfxMenuOpen(); }
}
function resumeGame() { if (game.paused) sfx.sfxMenuClose(); game.paused = false; }
// The three shell modals are mutually exclusive — each fully REPLACES the panel
// it was opened over, so opening one clears the others rather than stacking.
function closeShell() {
  game.settingsOpen = false; game.controlsOpen = false;
  game.creditsOpen = false; game.achievementsOpen = false;
  game.mapOpen = false;
}
function openSettings() { closeShell(); game.settingsOpen = true; bump(game, 'openSettings'); sfx.sfxMenuOpen(); }
function openControls() { closeShell(); game.controlsOpen = true; bump(game, 'openCtrl'); sfx.sfxMenuOpen(); }
function openCredits() { closeShell(); game.creditsOpen = true; bump(game, 'openCred'); sfx.sfxMenuOpen(); }
// The run's achievement log. Reachable from the pause menu, the game-over
// panel, and the V key — it is a RUN readout, so unlike the other three shell
// panels it says nothing useful before a run has started (the splash doesn't
// offer it). Opening it is itself an achievement; bump before the sweep runs.
function openAchievements() {
  closeShell();
  bump(game, 'openAch');
  // Sweep once BEFORE the panel opens. Opening it is itself an achievement, and
  // a shell modal freezes update() — without this the row it just earned would
  // sit unticked in the very list you are looking at, and only land on the way
  // out. (The toast still waits for the unfreeze; that part reads fine.)
  updateAchievements(game, 0);
  game.achievementsOpen = true;
  sfx.sfxMenuOpen();
}
// THE SYSTEM CHART. Always opens on the same view — sun-centred, whole system
// in frame (starmap.chartReset). That is the chart's one fixed promise, and a
// panel that reopened wherever the last session left it would break it: you
// would come back to an unlabelled patch of dark with no way to tell where.
// The route is deliberately NOT reset with it — a journey outlives the panel.
function openMap() {
  closeShell();
  chartReset(true);   // instant: the chart OPENS on the sun, it does not fly there
  game.mapOpen = true;
  sfx.sfxMenuOpen();
}
// Settings is the only one that owns persisted state, so it's the only one that saves.
function closeShellPanel() { if (game.settingsOpen) saveSettings(); closeShell(); sfx.sfxMenuClose(); }
// MAIN MENU out of a run ENDS the run. Backing out used to only flip `started`,
// so the splash sat over a paused, half-played world and START silently resumed
// it — the title screen has no notion of "continue", so that read as the menu
// having done nothing. Resetting HERE rather than in startGame is what makes the
// backdrop honest: the sky drifting behind the menu is the brand-new system
// (fresh seed via resetRun -> regenWorld -> pickSeed) that START drops you into,
// exactly as on a cold boot. The spec card is deliberately NOT opened — startGame
// does that on the way in; a pick card floating over the splash would be an
// upgrade modal with no run behind it.
function toMainMenu() {
  game.paused = false;
  closeShell();
  game.started = false;
  resetRun(undefined, false);
  // The dead run's last words go with it: the message slot's lifetime is
  // wall-clock, and the deferred grab tip is a pending setTimeout that would
  // otherwise pop behind the NEXT run's spec card.
  clearTimeout(tipTimer);
  hud.clearMessage();
  // Restart the establishing shot with the world it is establishing, so every
  // fresh title screen opens on the same framing (and the same breathing phase
  // as the boot animation) instead of picking up wherever the last one left off.
  // Applied HERE, not left to the next driftSplash: that frame may take zero
  // substeps and would render the dead run's camera first (see frameSplash).
  game.splashT = 0;
  splashAcc = 0;
  frameSplash(0);
}

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
// zoomCur for the wide shot (gameplay tier-0 is ~1.15). Pulled back from 0.205
// to ~1.5x wider: at the old framing the camera's orbit was about one view
// radius, so the sun sat on the frame edge and the shot read as "near a star"
// rather than as a system. Wider, the inner lanes and the first belt sweep
// through together — and the dive onto the ship at START has further to travel.
// HALVED AGAIN (0.14 → 0.07) when the sun doubled to 4800 (the 2026-08 growth
// pass), in lockstep with the orbit below: 2x radius x 1/2 zoom leaves the sun
// the same ~340px disc it was tuned at, and the inner lanes — which grew less
// than the sun did — sit a touch deeper inside the frame, which errs the shot
// toward "system", never toward "star". Move this and SPLASH_ORBIT together
// or the composition (sun size vs how far off-centre it swings) silently
// changes.
const SPLASH_ZOOM = 0.07;
// The camera's orbit around the sun. 8800 = the old 4400 doubled with the
// sun: at 4400 the camera now sat INSIDE the 4800-radius photosphere.
const SPLASH_ORBIT = 8800;
let splashAcc = 0;
// The establishing shot's framing at splash time t. Lifted OUT of the substep
// loop because the loop is not guaranteed to run: driftSplash takes zero
// substeps on any frame shorter than the sim step — a >120 Hz display, or the
// first frame after a reset zeroed the accumulator — and until this was its own
// function, such a frame rendered the world at whatever camera and zoom the
// previous state left behind (the dead run's ship at gameplay zoom on the way
// out of MAIN MENU, the spawn close-up at boot), then snapped wide. One frame,
// but a visible pop, and under the splash's blur it read as a glitch. Callers
// only set zoomCur; frame()'s splash branch runs applyZoom before every render.
function frameSplash(t) {
  game.zoomCur = SPLASH_ZOOM * (1 + 0.05 * Math.sin(t * 0.12));   // gentle breathing
  const a = t * 0.06;                                            // slow orbit of the sun
  game.cam.x = Math.cos(a) * SPLASH_ORBIT;
  game.cam.y = Math.sin(a) * SPLASH_ORBIT;
}
function driftSplash(dt) {
  game.time += dt;
  // The re-rail scan measures against the player's view, not the camera's — off
  // on the title screen it would re-rail rocks in shot. Keep it honest.
  // simView, not view.getView: viewR is only window-independent because the
  // hypot here cancels the one inside cam.zoom, so the two must always be read
  // through the same accessor (the title screen is not a harness path today —
  // this is here so a pinned run can never end up with a mismatched pair).
  const { vw, vh } = simView();
  game.viewR = Math.hypot(vw, vh) / 2 / game.cam.zoom;
  game.ship.invuln = Math.max(game.ship.invuln || 0, 1);
  // The solar wave can't reach the title screen. Backing out to the menu
  // mid-wave leaves game.storm live (replenishWorld doesn't run here, so it
  // never advances or expires), and updateStorm — the only thing that clears
  // these — is update()'s. Left standing they'd cook the parked ship and hold
  // the aliens deaf for as long as the menu stayed open.
  game.stormExposed = false; game.stormShelter = null;
  game.stormBlind = false; game.stormIonT = 0;

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
  // Same pacing law as the in-game loop (FRAME PACING): the live step, and the
  // same hard substep cap. The backdrop runs the FULL physics behind a menu —
  // ~8000 bodies — so it is exactly as capable of spiralling, and the old
  // 0.25s backlog ceiling here was worth up to 30 substeps in a single frame.
  splashAcc = Math.min(splashAcc + dt, 0.25);   // a backgrounded tab must not spiral
  const sdt = simDt;
  let splashSteps = 0;
  while (splashAcc >= sdt && splashSteps < CFG.SUBSTEP_MAX) {
    step(game, sdt);
    game.splashT = (game.splashT || 0) + sdt;
    frameSplash(game.splashT);
    splashAcc -= sdt;
    splashSteps++;
    perf.steps++;   // the title backdrop is a real sim — the overlay shouldn't read zero here
  }
  if (splashAcc >= sdt) { perf.dropped += splashAcc - (splashAcc % sdt); splashAcc %= sdt; }
  // The title backdrop pays the field LOD too (the dead ship routes the wake
  // bubble to the CAMERA): without this the splash simulated all ~8000 field
  // rocks at full price behind a menu — and dormant pockets would freeze
  // solid instead of orbiting, since update() never runs here.
  if (splashSteps) updateFieldLOD(game, splashSteps * sdt);
  for (const m of EVENT_MSGS) game[m.flag] = null;
  // ...and the automatic-rank queue with them: update() is what drains it, and
  // the title screen never runs update(), so anything banked here would fire as
  // a burst of rank messages the instant START ran.
  game.rankUps.length = 0;
}
// Arm the title framing before the FIRST frame ever renders. The boot world is
// built at module load, which leaves the camera on the ship at the gameplay
// zoomCur (1.15) — and the first frame's dt is the gap from module eval to the
// first rAF, which is routinely under one sim step, so driftSplash takes no
// substeps and the title opens on a close-up of the spawn. Down HERE rather
// than beside regenWorld() because SPLASH_ZOOM is a const declared above this
// line: calling frameSplash any earlier is a TDZ ReferenceError at load.
frameSplash(0);

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
  onOpenAchievements: ui(openAchievements),
  onOpenMap: ui(openMap),
  onCloseShell: ui(closeShellPanel),
  onClearRoute: ui(() => clearRoute(game)),
  onCentreChart: ui(chartReset),
  // (not wrapped in ui(): that wrapper takes no arguments, and this one needs
  // the row's index — so it does the click itself, like onRenderScale)
  onRemoveWaypoint: (i) => { sfx.initAudio(); sfx.sfxUiClick(); removeWaypoint(game, i); },
  // Clicking a card on the inline pick offer. Same index-carrying shape, and
  // applyPick brings its own sound (upgrade tick / tier-up fanfare), so this
  // one deliberately does NOT add the generic UI click on top.
  onUpgradePick: (i) => { sfx.initAudio(); pickFromUi(i); },
  onExit: exitGame,
  onTogglePredict: ui(() => { game.predict = !game.predict; saveSettings(); }),
  onToggleFps: ui(() => { game.showFps = !game.showFps; saveSettings(); }),
  onTogglePerf: ui(() => { game.showPerf = !game.showPerf; saveSettings(); }),
  // RENDER SCALE. Picking one clears any auto-degrade notches: an explicit
  // choice deserves a fresh trial at that ceiling, and a player who drops to
  // 75% to fix stutter must not be left silently sitting at 50% from before.
  // (not wrapped in ui(): that wrapper takes no arguments, and this one needs
  // the chosen value — so it does the initAudio/click itself, like the sliders)
  onRenderScale: (v) => {
    if (!RENDER_STEPS.includes(v)) return;
    sfx.initAudio(); sfx.sfxUiClick();
    game.renderScale = v; autoDrop = 0; scaleHold = 0;
    applyRenderScale(); saveSettings();
  },
  // Auto quality is defeatable on purpose: without it, a player who chose 100%
  // and got 50% would read the setting as broken rather than as a ceiling.
  // Turning it off restores that ceiling immediately.
  onToggleAutoScale: ui(() => {
    game.autoScale = !game.autoScale;
    if (!game.autoScale) { autoDrop = 0; scaleHold = 0; applyRenderScale(); }
    saveSettings();
  }),
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

// ---- The chart's pointer: pan, zoom, and the one click that plots a journey.
//
// A DRAG IS NOT A CLICK. Pressing to pan and releasing over a contact must not
// also drop a stop on it — starmap tracks whether the press actually moved
// (chart.dragged, with a 3px slop so a twitchy click still counts as a click)
// and the release only plots when it did not. Without that, panning across a
// crowded inner system litters the route with stops you never asked for.
hud.initChartInput({
  onDown: (sx, sy) => {
    chart.drag = { sx, sy, cx: chart.cx, cy: chart.cy };
    chart.dragged = false;
  },
  onMove: (sx, sy) => {
    const { vw, vh } = view.getView();
    chart.flash = null;   // the frozen sim has no clock — the next move IS the timer
    if (chart.drag) chartPanTo(sx, sy, vw, vh);
    // The hover is resolved on MOVE and cached, never per frame in the draw:
    // it costs a walk of the contact registry, and the picture behind it is
    // frozen anyway (the chart is a shell modal), so nothing can change under
    // a stationary cursor.
    chart.hover = chartPick(game, sx, sy, vw, vh);
  },
  onUp: (sx, sy) => {
    if (chartDragEnd()) return;   // it was a pan, not a click — and it coasts on
    const { vw, vh } = view.getView();
    const pick = chartPick(game, sx, sy, vw, vh);
    chart.hover = pick;
    sfx.initAudio();
    if (pick.kind === 'waypoint') { removeWaypoint(game, pick.i); sfx.sfxUiClick(); return; }
    const r = addWaypoint(game, pick);
    // A refusal has to SAY something, or a full route reads as a dead panel.
    if (r === 'added') { sfx.sfxChime(); return; }
    sfx.sfxWarnLow();
    chart.flash = r === 'full'
      ? `JOURNEY FULL — ${game.route.length} stops is the limit. Remove one to add another.`
      : 'THAT STOP IS ALREADY ON YOUR JOURNEY.';
  },
  onLeave: () => { chart.hover = null; },
  onWheel: (sx, sy, dy) => {
    const { vw, vh } = view.getView();
    chartZoomAt(sx, sy, dy < 0 ? 1.18 : 1 / 1.18, vw, vh);
    chart.hover = chartPick(game, sx, sy, vw, vh);
  },
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
    // Re-baseline the one stat this invalidates. A ceiling gain is a grant, not
    // a repair, and an automatic rank landing mid-flight must not disarm a
    // "Limped In" run in progress — see achievements.noteHullGrant.
    noteHullGrant(game);
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

// The one door every PLAYER-driven pick comes through — the 1/2/3 keys and a
// click on an offer card both land here. The spec card is a modal, so it IS the
// blocker and answers from anywhere; the inline offer is flight UI and answers
// only while the cockpit is live. The DOM already hides the cards behind a pause
// or a panel, but the keys are a window listener that fires regardless, and a
// digit must never reach into a paused run and spend a pick. Both paths are
// guarded rather than just the keys: two entry points with one rule between them
// is how the rule gets forgotten. Internal callers (window.freshRun, the
// headless autoUpgrade resolve) go straight to applyPick — they mean it.
const pickFromUi = (i) => {
  if (!game.choosingUpgrade && menuBlocking()) return;
  applyPick(i);
};

// Answers whatever is currently offered — the spec MODAL, or the inline offer
// on the pilot card. Both live on the same two fields (upgradeKind /
// upgradeChoices); `choosingUpgrade` says only whether the sim is frozen behind
// it, which is now the spec card's business alone.
function applyPick(i) {
  if (!game.upgradeChoices) return;
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
  const wasInline = !game.choosingUpgrade;
  game.choosingUpgrade = false;
  game.upgradeChoices = null;
  game.upgradeKind = null;
  hud.setUpgradeVisible(game, null, null, null);
  // NO CARD MAY LAND UNDER A CURSOR THAT JUST CLICKED ONE. Picks queue — bank a
  // pick's worth of XP while an offer sits unclaimed and the next one is owed
  // the moment this one is taken — and the offer always appears in the same
  // corner, so without this the second card materialises under a finger still
  // on the button and gets bought unread. flingDelayT is already the "hold the
  // owed pick back" timer (tractor.js arms it after a throw for the same
  // reason: don't put a card up at the exact moment the player is busy), so it
  // takes this too rather than growing a second clock beside it. Not headless:
  // there is no cursor to protect there, and a soak's pick pacing must stay
  // exactly what it was.
  if (wasInline && !game.autoUpgrade) game.flingDelayT = Math.max(game.flingDelayT, 0.8);
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
// ('tier') just also carries the tier bump and the life. Both empty-pool
// branches must keep progression MOVING: a spec whose offer pool is exhausted
// still tiers up / still banks the pick, or the ladder silently stalls for the
// rest of the run.
//
// AN ABILITY PICK NO LONGER FREEZES THE RUN (user call). It is OFFERED — the
// cards go to the head of the pilot card (hud.syncOffer) and simply wait there,
// through firefights and dives and whatever else, until the player answers
// them. `choosingUpgrade` therefore stays FALSE here; the only thing that still
// holds the sim is the spec card, which is answered before the run has started
// moving. Nothing else about the ladder changed: the pick stays owed
// (owesPick), the XP behind it keeps banking, and the next one queues up behind
// this one the instant it is taken.
function openUpgrade() {
  const prog = game.prog;
  if (!prog.spec) return;   // no picks until a spec is chosen
  const kind = pickIsMilestone(prog) ? 'tier' : 'upgrade';
  game.upgradeKind = kind;
  game.upgradeChoices = tierChoices(prog, 2);
  if (!game.upgradeChoices.length) {
    game.upgradeKind = null;             // nothing to offer — clear the state...
    game.upgradeChoices = null;          // ...or the offer would show two blanks
    consumePickCost(prog);
    if (kind === 'tier') {               // pool exhausted -> tier up with no new ability
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
  // A CHIME and nothing else (user call: "the window popping up is enough").
  // The cards ARE the notification — they arrive lit, breathing, and they stay
  // until answered, so a line across the top of the screen said the same thing
  // twice and stole the slot a real hazard warning needs. The sound stays
  // because the cards land in a corner: it is the one channel that reaches you
  // when you are looking somewhere else, and per the event grammar an
  // opportunity chimes. Skipped headless, where autoUpgrade answers the offer
  // in this same frame anyway.
  if (!game.autoUpgrade) sfx.sfxChime();
}

// Game over -> fresh run: wipe the build, regenerate the world, restart.
// `seed` forces a specific world (window.freshRun / mechTest); undefined lets
// pickSeed resolve one, so a normal new run lands on a brand-new random system
// unless the player has pinned a seed in Settings.
// `openCard` false resets everything but leaves the spec choice unopened — the
// MAIN MENU path, where the card must wait for START (see toMainMenu). Every
// other caller relies on the reset ENDING on that card: window.freshRun picks
// it immediately, and a game-over restart must open on it.
function resetRun(seed, openCard = true) {
  game.prog = freshProgress();   // ...including a blank achievement ledger + score
  game.st = shipStats(game.prog);
  game.aliens.length = 0; game.debris.length = 0; game.particles.length = 0;
  game.flares.length = 0; game.bolts.length = 0; game.glowPockets.length = 0;
  game.orbit.length = 0; game.held = null; game.held2 = null; game.pickups.length = 0;
  sfx.setBeam(false);   // the hum is edge-triggered — a reset must drop it too
  game.gameOver = false; game.deathShown = false; game.deathCause = '';
  game.lastTier = 0; game.alienKills = 0; game.lifeTimer = PROG.LIFE_RESPAWN;
  game.burnerFuel = 1; game.burnerOn = false;
  game.dashT = 0; game.autoEvadeT = 0; game.jinkT = 0;   // (evadeT/warpT reset below)
  game.tut = { grabbed: false, flung: false, orbited: false, alienSeen: false, glow: false, stormLee: false };
  // Run-scoped world state must reset with the world, or it leaks between
  // runs: time drives the alien first-wave peace window and the once-per-run
  // visitor gate; lastDamage must move with time or the shield-regen delta
  // goes negative; the event timers re-seed via their `?? default` idiom.
  game.time = 0; game.lastDamage = -99;
  // The whole solar wave, geometry AND the ship's relationship to it — an
  // exposure flag surviving into a fresh world would cook a ship with no wave
  // anywhere near it, and a stale stormBlind would leave the aliens deaf.
  game.storm = null; game.stormTimer = undefined; game.stormChargeT = 0;
  game.stormCls = null; game.stormChargeMax = 0; game.stormIonMax = 0;
  game.stormExposed = false; game.stormShelter = null; game.stormIonT = 0;
  game.stormBlind = false; game.stormRode = 0;
  game.visitor = null; game.visitorDone = false;
  game.vesperRespawnT = null; game.shepherdRespawnT = null; game.shepherdPlayerKilled = false;
  game.moonTimer = undefined;
  game.flareTimer = undefined; game.cometTimer = undefined; game.wrightTimer = undefined;
  game.alienTimer = 0; game.asteroidTimer = 10;
  game.ghostPing = null; game.sling = null; game.combo = 0; game.comboT = 0;
  game.predictRef = null; game.lock = null; game.lockTarget = null; game.tooHeavy = null;
  game.latch = null;
  game.heldCharged = false; game.heldCharge = 0; game.heldChargeShow = false; game.chargeFlashT = 0;
  game.launchFx.length = 0;
  game.heatT = 0; game.gasDiveT = 0; game.gasEnterT = 0; game.skimT = 0; game.scrapeT = 0;
  game.dockFlashT = 0; game.domeHitT = 0;   // (the stations go with the world — regenWorld)
  game.volleyT = 0; game.volleySel = 0; game.volleyCharging = false;
  game.evadeT = 0; game.warpT = 0; game.flingDelayT = 0; game.oortWarnT = 0;
  game.parry = null; game.parryCd = 0; game.parryReadyT = 0;   // a parry must never survive into a fresh world
  game.tetherT = 0;   // ...nor a Recovery Tether reload
  game.rankUps.length = 0;               // undrained ranks belong to the dead run
  game.achQueue.length = 0;              // ...and so do undrained achievement toasts
  // ...and so does the journey: every stop pins to a body in the world that is
  // about to be thrown away, so a route carried across would be eight stops
  // pointing at bodies from a system that no longer exists.
  game.route.length = 0;
  chartReset(true);                      // instant — there is nothing to glide away from
  zone.resetZone();                      // ...and so does the last run's cockpit accent
  regenWorld(seed);            // rebuilds bodies (cleared first) + spawn, calls respawnShip
  game.st = shipStats(game.prog);
  hud.setDeathVisible(false);
  hud.setGameOverVisible(false);
  firstStart = true;     // re-arm the flight guidance for the fresh run
  if (openCard) {
    openSpec();          // fresh run opens on a new specialization choice
  } else {
    // No card: the dead run's own pick state must go with it, or a stale
    // choosingUpgrade would freeze the title backdrop behind an invisible modal
    // — and a stale upgradeKind/Choices would hand the next run an offer drawn
    // against a spec and a tier that no longer exist.
    game.choosingUpgrade = false; game.upgradeChoices = null; game.upgradeKind = null;
    hud.setUpgradeVisible(game, null, '', applyPick);
  }
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
  // A gas giant stripped to its core (physics.shatter). Triumph, not alarm:
  // it is one of the biggest things the player can do to the sky, and what is
  // left behind is a new world rather than a hole.
  // The throes STARTING — an alarm, because a world coming apart around you is
  // the most dangerous place in the system for the next five seconds.
  { flag: 'gasCollapseName', tut: 'gasCollapse', snd: sfx.sfxAlarm,
    first: [(v) => `${v} IS COMING APART — its atmosphere is collapsing. Get clear.`, 5],
    repeat: [(v) => `${v} IS COMING APART!`, 3.5] },
  { flag: 'gasStrippedName', tut: 'gasStripped', snd: sfx.sfxLife,
    first: [(v) => `ATMOSPHERE STRIPPED — ${v} is gone. Its dense core is left on the same orbit.`, 5.5],
    repeat: [(v) => `${v} STRIPPED — only the core remains.`, 4] },
  { flag: 'alienWarn', tut: 'alienSeen', snd: sfx.sfxWarnLow,
    first: ['WARNING: alien grabbers inbound — they throw rocks. Your orbit shield can block them.', 5] },
  { flag: 'tetherShow', tut: 'tether', snd: sfx.sfxChime,
    first: [(v) => `TETHER THROW ×${v.toFixed(2)} — boosting while flinging whip-cracks the rock with your momentum.`, 4.5],
    repeat: [(v) => `TETHER THROW! ×${v.toFixed(2)}`, 1.8] },
  // The beam refused on CLASS, not weight (tractor.tryGrab). No `snd`: the
  // grab already played sfxDenied, and doubling it turns a refusal into an
  // event. Carries the class the body actually needs, so "what would lift
  // this?" is never a guess.
  { flag: 'beamClassWarn', tut: 'beamClass',
    first: [(v) => `BEAM CLASS TOO LOW — that is ${v.toUpperCase()}. Tier up your beam to take hold of it.`, 5],
    repeat: [(v) => `NEEDS A ${v.toUpperCase()} BEAM.`, 2.2] },
  // A gas giant is off the ladder entirely (config.liftClass) — no tier ever
  // lifts one. Says the WAY OUT, because "never" without a way out reads as a
  // bug: strip the atmosphere and the core it leaves behind is carryable.
  { flag: 'beamNoGripWarn', tut: 'beamNoGrip',
    first: [(v) => `NOTHING TO GRIP — ${v.toUpperCase()} IS ALL ATMOSPHERE. Strip it and carry the core.`, 5.5],
    repeat: [(v) => `${v.toUpperCase()} — nothing solid to grip.`, 2.2] },
  { flag: 'jinkWarn', tut: 'jink', snd: sfx.sfxChime,
    first: ['REFLEX JINK — your ship auto-dodged that rock. The jink recharges slowly.', 5] },
  { flag: 'deadStopWarn', tut: 'deadstop', snd: sfx.sfxChime,
    first: ['DEAD STOP — caught it mid-flight! The rock is primed: fling it back hard.', 5] },
  { flag: 'parryWarn', tut: 'parry', snd: sfx.sfxChime,
    first: ['DEFLECTED — the rock is frozen! It fires where your mouse points when the freeze ends.', 5] },
  { flag: 'wallSplatWarn', tut: 'wallsplat', snd: sfx.sfxChime,
    first: ['WALL SPLAT — smashed against the world. Nearby rocks scatter off the impact as yours.', 5] },
  // A worked-out shoal (config.fieldXp spent its run budget). The rocks still
  // shatter exactly as before — only the salvage is gone — so this has to SAY
  // so, or a payout that quietly stops reads as a bug. sfxWarnLow: bad news,
  // not danger. Carries the field's name, so "which one" is never a guess.
  { flag: 'fieldDryName', tut: 'fieldDry', snd: sfx.sfxWarnLow,
    first: [(v) => `${v.toUpperCase()} IS PICKED OVER — no salvage left in this shoal. The rocks are still good ammunition.`, 6],
    repeat: [(v) => `${v.toUpperCase()} is picked over — no salvage left here.`, 4] },
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
  { flag: 'fieldWarn', tut: 'field', snd: sfx.sfxChime,
    first: ['DENSE FIELD — a packed rock shoal. Rich pickings… and things live in the thick of it.', 6],
    repeat: ['Entering a dense asteroid field.', 3] },
  { flag: 'lurkerWarn', tut: 'lurker', snd: sfx.sfxWarnLow,
    first: ['SHOAL LURKER — one of the rocks is moving! It hunts in slash passes: watch your flanks.', 5.5],
    repeat: ['LURKER ambush — it was one of the rocks!', 3] },
  { flag: 'fieldClearWarn', snd: sfx.sfxChime,
    first: [(v) => `${v.toUpperCase()} is quiet — the lurker brood is destroyed. The rocks are yours.`, 5.5] },
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
  // ---- the solar wave: charge (telegraph) -> launch -> caught out -> receipt.
  // Alarm on the two that mean "act now", chime on the two that mean "you did".
  //
  // EVERY LINE NAMES THE CLASS, because the class IS the decision: a squall is
  // worth flying straight through and a CME is worth crossing the system to
  // hide from, and the telegraph is where a pilot finds out which one is
  // loading. These three carry the CFG.STORM_CLASSES row itself as their value
  // — the full `name` on the telegraph, the short `tag` for anything in flight
  // (radio traffic, not a title card), and the class's own `blurb` for what it
  // will actually do to you. Passing the row rather than a pre-baked string is
  // what keeps the wording of a class in ONE place with its numbers, so a
  // squall can never inherit the CME's promise of a system-wide blackout.
  { flag: 'stormChargeWarn', tut: 'stormCharge', snd: sfx.sfxAlarm,
    first: [(v) => `${v.name} — the sun is charging. Put a world between you and it, or ride it out in the open.`, 7],
    repeat: [(v) => `${v.name} CHARGING — the sun is loading another wave.`, 3.5] },
  { flag: 'stormWarn', tut: 'storm', snd: sfx.sfxAlarm,
    first: [(v) => `${v.tag} AWAY — a plasma front is sweeping outward: ${v.blurb}`, 6],
    repeat: [(v) => `${v.tag} AWAY — ${v.blurb}`, 3.5] },
  { flag: 'stormHitWarn', tut: 'stormHit', snd: sfx.sfxAlarm,
    first: ['ION WASH — sensors blind, engines choking, hull cooking. Break for a world\'s lee, or hold and take the charge!', 6.5],
    repeat: [(v) => `ION WASH — caught in the open, ${v.tag} passing.`, 3] },
  // "around IT", not "around the world": a moon's lee shelters you exactly as a
  // planet's does, and moons are the shelter you will usually reach first.
  { flag: 'stormLeeName', tut: 'stormLee', snd: sfx.sfxChime,
    first: [(v) => `IN THE LEE OF ${v} — the wave breaks around it. Nothing reaches you here.`, 5.5] },
  { flag: 'stormRideWarn', snd: sfx.sfxLife,
    first: [(v) => `WAVE RIDDEN — ${v}s in the open, and the banks are charged.`, 4] },
  { flag: 'auroraName', tut: 'aurora', snd: sfx.sfxChime,
    first: [(v) => `AURORA — the storm wave is lighting up ${v}'s sky.`, 5],
    repeat: [(v) => `AURORA over ${v}.`, 3] },
  { flag: 'eclipseName', snd: sfx.sfxChime,
    first: [(v) => `MOONSHADOW — a lunar eclipse is sweeping across ${v}.`, 5] },
  // ---- the plotted journey (starmap.js). Chime on the two that mean progress,
  // warnLow on the one that means the sky took a stop away from you.
  { flag: 'wpReachedName', snd: sfx.sfxChime,
    first: [(v) => `WAYPOINT REACHED: ${v}.`, 4] },
  { flag: 'routeDoneName', snd: sfx.sfxLife,
    first: [(v) => `JOURNEY COMPLETE: ${v} was your last stop.`, 5] },
  { flag: 'wpResolvedName', snd: sfx.sfxChime,
    first: [(v) => `SENSOR FIX — stop ${v} on your journey has resolved. The chart has its true position now.`, 4.5] },
  { flag: 'wpLostWarn', snd: sfx.sfxWarnLow,
    first: ['A stop on your journey is gone — the chart holds its last position.', 5] },
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
  { flag: 'cometVentWarn', tut: 'cometVent', snd: sfx.sfxChime,
    first: ['COMET MOON — at the low point of its swing it vents catchable ice. The chart knows its timetable.', 5.5] },
  { flag: 'pumiceWarn', tut: 'pumice', snd: sfx.sfxChime,
    first: ['PUMICE — featherweight froth rock. Throws bury instead of bouncing, and the crust crumbles fast.', 5.5] },
  // Hostile contact, not opportunity — the one moon job that bites back.
  { flag: 'huskWarn', tut: 'husk', snd: sfx.sfxWarnLow,
    first: ['HUSK MOON — the wreck-plating rang out. A wreckwright is descending on this moon.', 5.5],
    repeat: ['The husk moon is calling its wright down.', 3] },
  // Hostile SURFACES (physics skim venom) — bad news in progress, warn low.
  { flag: 'sulfurSkidWarn', tut: 'sulfurSkid', snd: sfx.sfxWarnLow,
    first: ['BRIMSTONE CRUST — this surface is poisonous. Skidding here eats the hull far faster.', 5.5] },
  { flag: 'moltenSkidWarn', tut: 'moltenSkid', snd: sfx.sfxWarnLow,
    first: ['MOLTEN CRUST — the rock under you is barely cooled magma. Skidding here sears the hull.', 5.5] },
  // ---- planet-archetype mechanics (terran/ocean/desert/shroud/crystal) ----
  { flag: 'atmoWarn', tut: 'atmo', snd: sfx.sfxChime,
    first: ['ATMOSPHERIC BURN-UP — small rocks flash to nothing in this sky. Only a heavyweight reaches the surface.', 5.5] },
  { flag: 'spoutWarn', tut: 'spout', snd: sfx.sfxChime,
    first: ['WATERSPOUT — the world-sea flings brine ice into low orbit. Free shield ammo.', 5.5] },
  { flag: 'duneWarn', tut: 'dune', snd: sfx.sfxChime,
    first: ['DUNE SKATING — skimming the dune seas pays double XP. Risky flying, rewarded.', 5.5] },
  { flag: 'shroudWarn', tut: 'shroudCloak', snd: sfx.sfxChime,
    first: ['CLOUD COVER — the shroud swallows your signature. Alien senses cannot find you in here.', 5.5] },
  { flag: 'shardWarn', tut: 'shard', snd: sfx.sfxChime,
    first: ['CRYSTAL RESONANCE — the impact rang a facet loose. A dense core shard is adrift — premium salvage.', 5.5] },
  { flag: 'ringDecayName', snd: sfx.sfxChime,
    first: [(v) => `The shepherd moon is gone — ${v}'s ring is beginning to scatter.`, 6] },
  // THE RAM (brawler). Losing it is BAD NEWS — sfxWarnLow, per the audio grammar
  // — because the ship that was immune to head-on hits a second ago no longer
  // is, and nothing else on screen says so as loudly as it needs to.
  { flag: 'ramLostWarn', tut: 'ramLost', snd: sfx.sfxWarnLow,
    first: ['RAM SHATTERED — it took that hit so your hull did not. You are bare-nosed now: RIGHT-CLICK rock to build a new one.', 5.5],
    repeat: ['Ram gone — head-on hits reach the hull again.', 3] },
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
  // ---- DOCKING. Three separate moments, because they mean three different
  // things and collapsing them into one message is how a ten-second build
  // reads as a hang. No `snd` on any of them: physics plays the mechanical
  // catch (sfxOrbitCapture) at the clamps and again when the station goes
  // live, and a chime layered on top turns a machine into a notification.
  //
  // BUILDING — the first landing has to TEACH the whole verb, because nothing
  // else in this game says a world is somewhere you can stop. It must also say
  // STAY, or a player who lifts off after two seconds never learns the feature
  // exists.
  { flag: 'dockBuildName', tut: 'dockBuild',
    first: [(v) => `BUILDING A DOCK ON ${v.toUpperCase()} — hold position. It takes ${CFG.DOCK_BUILD}s, and nothing protects you until it is up.`, 6],
    repeat: [(v) => `BUILDING A DOCK ON ${v.toUpperCase()} — hold position.`, 3] },
  // LIVE — the payoff, and the moment the H key first becomes worth knowing about.
  { flag: 'dockReadyName', tut: 'dockReady',
    first: [(v) => `DOCK LIVE ON ${v.toUpperCase()} — shielded and repairing. Press H to make it your home port. It stays here; come back any time.`, 7],
    repeat: [(v) => `DOCK LIVE ON ${v.toUpperCase()} — shielded and repairing.`, 3] },
  // RETURNING to a station you already built. Says the thing that makes the
  // build worth having: no wait this time.
  { flag: 'dockedName', tut: 'docked',
    first: [(v) => `BERTHED AT ${v.toUpperCase()} — your dock is still standing. Shielded and repairing at once.`, 5],
    repeat: [(v) => `BERTHED AT ${v.toUpperCase()} — shielded and repairing.`, 2.5] },
  { flag: 'dockRetiredName', snd: sfx.sfxWarnLow,
    first: [(v) => `OLDEST DOCK ABANDONED — you can keep ${CFG.DOCK_MAX} standing, and the one on ${v.toUpperCase()} was the oldest.`, 5] },
  { flag: 'launchName', tut: 'launch',
    first: ['LAUNCH — clamps releasing. The dock stays; fly back to it whenever you want.', 4.5] },
  // Choosing a home port is the one act that moves where a death puts you back.
  // sfxLife — it is the closest thing this game has to banking progress.
  { flag: 'homeSetName', snd: sfx.sfxLife,
    first: [(v) => `HOME PORT SET — ${v.toUpperCase()}. You will respawn here.`, 5] },
  // Two refusals for H, each naming the thing that is actually missing. No
  // `snd` on either: a key that did nothing is not an event.
  { flag: 'homeNoDockWarn', tut: 'homeNoDock',
    first: ['NO DOCK — land on a world rockets-down and come to a stop first, then press H.', 5],
    repeat: ['NO DOCK — you have to be berthed at a dock.', 2.5] },
  { flag: 'homeBuildingWarn',
    first: ['STILL BUILDING — wait for the dock to go live, then press H.', 3] },
  { flag: 'homeSameWarn',
    first: ['This is already your home port.', 2.5] },
  // Losing the home world is real bad news, and it must never be something the
  // player only finds out about by dying.
  { flag: 'homeLostName', snd: sfx.sfxWarnLow,
    first: [(v) => `HOME PORT LOST — ${v.toUpperCase()} is gone, and the dock with it. You respawn at your starting orbit.`, 6] },
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
const perf = { fps: 60, frameMs: 16.7, simMs: 0, drawMs: 0, steps: 0, dtHz: Math.round(1 / CFG.DT), dropped: 0 };
game.perf = perf;
const PERF_EMA = 0.1;

// ---- FRAME PACING (the substep budget) --------------------------------------
// The fixed-timestep accumulator has a nasty property: the number of substeps
// it runs RISES as the frame rate falls. At 60 fps a frame owes 2 substeps; at
// 15 fps it owes 6. So the machine that is already too slow is handed 3x the
// sim work for being slow — slow frame ⇒ more substeps ⇒ slower frame, and it
// compounds. Measured in a dense shoal on this laptop: sim 2.5ms at 1 substep
// vs 7.1ms at 6, against a draw that stays at ~1.7ms either way. The sim
// overtakes the draw exactly when you can least afford it.
//
// Two guards, deliberately both:
//   1. CFG.SUBSTEP_MAX caps substeps per frame. Past the cap the leftover
//      backlog is DROPPED, never carried — carrying it is what makes the loop
//      positive-feedback. The sim then runs slow (honest time dilation) rather
//      than expensive, which is the trade a frame that is already late wants.
//   2. simDt drops from CFG.DT to CFG.DT_COARSE when frames are persistently
//      slower than the cap can cover, which halves the sim cost instead of
//      dilating time. The cap alone would leave a 15 fps machine running the
//      world at ~40% speed; the coarse step buys the real time back.
// The cap alone is the safe half (it changes no physics); the coarse step is
// the half that costs integration accuracy, so it is strictly a relief valve —
// nothing changes on a machine that keeps up.
//
// simDt is the step the accumulator is USING; CFG.DT stays the reference the
// physics was tuned at. frame() is the ONLY place that may change it — every
// headless entry point (window.tick, mechTest's stepSim) re-pins the fine step
// first, so measured frame time can never leak into a harness that is supposed
// to be bit-repeatable.
let simDt = CFG.DT;
let paceT = 0;               // seconds the pacing verdict has disagreed with the live step
function pinFineStep() { simDt = CFG.DT; paceT = 0; perf.dtHz = Math.round(1 / CFG.DT); }

function updatePacing(rawMs) {
  // FAST-FORWARD PINS THE STEP. window.speed's own per-frame wall-clock budget
  // guarantees slow frames, so a sustained speed(10) would pace itself onto the
  // coarse step within the dwell — and speed() is the documented way to WATCH a
  // physics failure happen. A viewer that quietly changes the physics it is
  // showing you is a trap; the tool's contract is that only the step COUNT
  // changes at speed, never the semantics.
  if (game.timeScale !== 1) { pinFineStep(); return; }
  const isCoarse = simDt !== CFG.DT;
  // THE COARSE STEP IS DISARMED (CFG.PACE_COARSE_ENABLED — the measured
  // hit-registration table lives on that constant). The substep CAP is what
  // halves the sim cost and it changes no physics, so disarming here costs no
  // frame rate; it only means a frame slower than the cap's budget runs the
  // world slow instead of running it coarse. Kept as a live branch rather than
  // deleted machinery so re-arming after the swept narrow-phase fix is one
  // boolean, with the evidence for the decision sitting next to it.
  // The `isCoarse` exit path stays reachable on purpose: flipping the flag off
  // at runtime (or mid-session) must be able to walk an already-coarse loop
  // back to the fine step rather than stranding it there.
  const wantCoarse = !CFG.PACE_COARSE_ENABLED ? false : isCoarse
    // Already coarse: stay unless BOTH say the fine step is affordable again.
    // Work — 2x simMs, since halving the step doubles the substeps — is the
    // primary test, because a vsync-bound frame is mostly idle and a frame-time
    // test alone would strand a 60 Hz machine on the coarse step permanently.
    // Frame time is the second: an externally slow frame is one the fine cap
    // would dilate whatever our own cost is, and without this clause the switch
    // hunts (see PACE_FINE_MS). Each clause covers the other's blind spot.
    ? 2 * perf.simMs + perf.drawMs > CFG.PACE_FINE_WORK_MS || perf.frameMs > CFG.PACE_FINE_MS
    // Fine now: frames slower than the fine step's cap budget are ALREADY
    // being time-dilated by the cap, so the coarse step is a pure win there.
    : perf.frameMs > CFG.PACE_COARSE_MS;
  if (wantCoarse === isCoarse) { paceT = 0; return; }   // verdict agrees — nothing to do
  // A hitch is not a slow machine. The verdict has to hold CONTINUOUSLY for
  // PACE_DWELL (one alt-tab stall spikes the frame EMA for ~0.5s, well inside
  // this window) before the step actually moves. Counted in RAW wall seconds,
  // never dtReal: dtReal is clamped to 50ms, so on the 15 fps machine this
  // exists for, a dtReal dwell would take 2s of wall clock to open — the relief
  // valve would be slowest exactly where it is needed most.
  paceT += rawMs / 1000;
  if (paceT >= CFG.PACE_DWELL) {
    simDt = wantCoarse ? CFG.DT_COARSE : CFG.DT;
    perf.dtHz = Math.round(1 / simDt);
    paceT = 0;
  }
}

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
    // Tier-scaled, PLUS the ram: rock crushed onto the bow is real mass the
    // ship now carries, so everything that resolves by mass ratio — the taut
    // tether, and the collision-side effective mass in collideShipBody — feels
    // a loaded brawler as the freight train it is. 0.35 rather than 1.0
    // because the ram rides the field ahead of the hull, not inside it: the
    // coupling transmits most of the load's inertia, not all of it. At a full
    // rank-6 ram (~33k) that is ~+11.5k on a 375-mass tier-3 hull — the whole
    // point; an empty nose is exactly st.shipMass.
    game.ship.mass = game.st.shipMass + (game.ship.ram || 0) * 0.35;
    if (game.rankUps.length) drainRankUps(preRankHullMax);
    // Cinematic zoom: ease toward the level-driven target instead of
    // snapping — leveling up feels like slowly zooming out of the universe
    let zoomTarget = 1.15 / game.st.zoomOut;
    // THE BERTH VISTA (CFG.DOCK_VISTA): a FINISHED station widens the view so
    // a berth surveys its neighbourhood. dockReady — the same gate as the
    // shield and the repair — keeps the exposed build at flight zoom, and
    // !game.launch hands the dive back to the normal rate the frame the spool
    // starts, so the zoom-in overlaps the clamps releasing.
    const vista = dockReady(game.dock) && !game.launch;
    if (vista) zoomTarget /= CFG.DOCK_VISTA;
    game.zoomCur = lerp(game.zoomCur, zoomTarget,
      1 - Math.exp(-(vista ? CFG.DOCK_VISTA_K : 0.5) * dtReal));
    applyZoom();

    // Roguelite pick: XP crossing a threshold OFFERS a choice on the pilot card
    // (openUpgrade -> hud.syncOffer). It does not freeze anything and it does
    // not expire — it waits until the player answers it. In headless
    // (window.tick) there is nobody to answer, so window.autoUpgrade resolves it
    // in this same frame.
    // `!game.upgradeChoices` is the re-entry guard: an unanswered offer must not
    // be re-rolled every frame, or the two cards would shuffle sixty times a
    // second under the cursor. It also queues the NEXT pick honestly — the offer
    // clears in applyPick, and if the XP for another one is already banked it
    // opens on the following frame.
    // NOT while a rock is in the beam, nor for ~2s after a fling (flingDelayT):
    // mid-aim and mid-throw are the two moments the corner of the screen is the
    // last place you can look. The owed pick isn't lost — owesPick stays true
    // until consumed, so it arrives the moment the throw settles.
    if (!game.upgradeChoices && game.prog.spec && game.ship.alive && !game.held &&
        game.flingDelayT <= 0 && owesPick(game.prog)) {
      openUpgrade();
      if (game.autoUpgrade && game.upgradeChoices) applyPick(0);
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
    const { vw, vh } = simView();
    const m = mouseWorld(game, vw, vh);
    game.aim.x = m.x; game.aim.y = m.y;
    // World-space radius of the current view — the local asteroid spawner
    // keeps rocks in a ring just beyond this
    game.viewR = Math.hypot(vw, vh) / 2 / game.cam.zoom;
    // SOLAR WAVE exposure/shelter, resolved before BOTH consumers: updateAliens
    // reads game.stormBlind and the substeps below read game.stormExposed.
    updateStorm(dtReal);
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
    //
    // The step itself is simDt, NOT CFG.DT — see FRAME PACING above. It is read
    // ONCE into a local here so the whole loop, the camera constant and the LOD
    // advance below all agree about how long a substep was, even if frame()
    // repaces between calls.
    acc += dtReal;
    const dt = simDt;
    const camK = 1 - Math.exp(-6 * dt);
    let simSteps = 0;   // substeps taken THIS call — the field LOD advances by the same clock
    while (acc >= dt && simSteps < CFG.SUBSTEP_MAX) {
      // The winch on a moon/world — gameplay timing, so fixed-step. The button
      // goes in because the winch is a HELD commitment: onFling ends it on the
      // release, and this is the backstop for a release that never arrives as
      // one (see updateLatch).
      // THE BEAM IS OFF AT A BERTH. Everything the tractor owns — the winch,
      // the hold, the orbit ring, the Recovery Tether — is skipped outright
      // while docked rather than merely refusing input, because these run on
      // state the berth has already cleared (tractor.standDown) and a half-live
      // system is how a ring gets re-welded to a parked ship. The dock stands
      // the beam down; this is what keeps it down.
      if (!game.dock) {
        updateLatch(game, dt, input.mouseDown);
        // TWIN GRIP (hauler): with a rock in the beam and the button still down,
        // sweeping the cursor over another one picks it up as the second. This
        // is the ability's ONLY trigger — see tractor.tryAutoSecond for why it
        // is a sweep and not a second click. Gated on the button because the
        // sweep is part of one continuous press: releasing throws, so a grab
        // with nothing held down would have nothing to be the second OF.
        if (input.mouseDown) tryAutoSecond(game);
        updateTractor(game, dt);
        updateOrbit(game, dt);
        updateTethers(game, dt);   // Recovery Tether: thrown rocks curve home (hauler)
      }
      step(game, dt);
      game.cam.x = lerp(game.cam.x, game.ship.x, camK);
      game.cam.y = lerp(game.cam.y, game.ship.y, camK);
      acc -= dt;
      simSteps++;
      perf.steps++;   // frame() zeroes this; updateScaled calls update() several times, so it sums
    }
    // SUBSTEP CAP: whatever the frame still owed is DROPPED, never banked. A
    // carried backlog is the death spiral itself — the next frame would owe
    // even more substeps, cost even more, and fall further behind. Dropping it
    // makes the sim run slow instead of expensive, which is recoverable. Only
    // the WHOLE steps go; the sub-step remainder is kept (acc %= dt) so the
    // substep phase stays continuous and the motion doesn't judder on top of
    // the dilation. perf.dropped totals the sim seconds lost this way, and
    // perf.dtHz reports the live step — the dilation is a real cost, so it is
    // recorded on game.perf and readable from the console rather than being
    // something you can only infer. (Neither is on the HUD overlay: the metrics
    // line belongs to the numbers you watch every frame.)
    //
    // Dropping does mean the physics briefly lags the systems that ride dtReal
    // (game.time, the AI, the run's timers) instead of dilating WITH them, so
    // it is deliberately kept to a moment: the drop can only happen while the
    // step is fine AND frames are slower than 25ms — which is the very same
    // threshold that paces the loop onto the coarse step, where the cap covers
    // 3 x 1/60 = 50ms = the dtReal clamp exactly and nothing is ever dropped
    // again. The two guards are sized against each other on purpose; move one
    // and the other stops meeting it.
    if (acc >= dt) { perf.dropped += acc - (acc % dt); acc %= dt; }
    // Dense-field LOD: classify awake/dormant field rocks and group-advance
    // the dormant rails — ONCE per frame, by exactly the sim time the substep
    // loop just consumed, so dormant pockets never drift off the sim clock.
    // simSteps * dt, never simSteps * CFG.DT: on the coarse step those differ
    // by 2x, and ~7000 dormant rocks would silently drift off the sim clock.
    if (simSteps) updateFieldLOD(game, simSteps * dt);

    // The plotted journey: track the stops onto their moving bodies, collapse a
    // guess into a fix once the scan resolves it, and pop the head on arrival.
    // Once per frame AFTER the substeps, never inside them — arrival is a
    // generous proximity test against a 1,500-unit ring, so running it 2-6x a
    // frame would buy nothing and cost a hypot per stop each time.
    updateRoute(game);

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
          bump(game, 'slings');
          best(game, 'slingBest', gain);
          hud.message(`SLINGSHOT! +${gain} speed — clean flying earns XP.`, 3);
        }
        game.sling = null;
      }
    } else {
      game.sling = null;
    }

    // Shield recharges after a quiet spell; the hull mends only at glow pockets
    // (glow.js) and ON A DOCK. Scout's Phase Screen recharges faster
    // (spec-derived st.regen / st.regenDelay — see config.shipStats).
    if (s.alive && game.time - game.lastDamage > game.st.regenDelay && s.shield < game.st.shieldMax) {
      s.shield = Math.min(game.st.shieldMax, s.shield + game.st.regen * dtReal);
    }
    if (s.shieldHitT > 0) s.shieldHitT -= dtReal;
    if (s.ramHitT > 0) s.ramHitT -= dtReal;   // ram crush/impact slam (render)
    if (game.ramTierDropT > 0) game.ramTierDropT -= dtReal;   // pack-shudder window
    // HELD RIGHT MOUSE: the ram keeps eating. Every rock the cursor crosses is
    // crushed in, on a short cooldown — the throttle is for READABILITY, not
    // balance (each crush is its own flash + spring slam, and back-to-back on
    // the same frame they smear into one). absorbIntoRam itself re-checks every
    // gate per call, so this sweep can never take anything a single click
    // couldn't. Berthing mid-hold disarms it outright — a dock is where you
    // stop working, and a held button must not keep a system live through one.
    if (game.ramEatCd > 0) game.ramEatCd -= dtReal;
    if (game.ramEating && dockBlocking()) game.ramEating = false;
    if (game.ramEating && game.st.frontRam && s.alive) {
      if (game.ramEatCd <= 0 && absorbIntoRam(game)) game.ramEatCd = 0.12;
    }
    // HAULER's stow sweep — the exact mirror of the ram sweep above, on the same
    // cadence and with the same dock disarm. Hold right mouse and drag the
    // cursor across a debris field and the ring fills itself; filling 14 slots
    // by 14 separate clicks is the kind of tedium that makes a doubled ladder
    // read as a chore instead of a reward. stowFromCursor re-checks every gate
    // per call, so the sweep can never seat anything a single click couldn't.
    // RECOVERY TETHER's reload. Rides dtReal like the other ability cooldowns
    // (warpT etc): it gates whether a THROW arms the tether, never anything
    // inside the fixed step, so it has no quantized target to miss.
    if (game.tetherT > 0) game.tetherT -= dtReal;
    if (game.stowEatCd > 0) game.stowEatCd -= dtReal;
    if (game.stowEating && dockBlocking()) game.stowEating = false;
    if (game.stowEating && !game.st.frontRam && s.alive) {
      if (game.stowEatCd <= 0 && stowFromCursor(game)) game.stowEatCd = 0.12;
    }
    // The absorb-crush effects (render.drawShip). Cosmetic easing with no
    // quantized target, so dtReal is the right clock — and they are advanced
    // and retired HERE rather than in render, because render must stay a pure
    // read of state (a hidden pane stops drawing, and effects that aged on the
    // draw call would freeze mid-flight and never clear).
    if (game.ramFx && game.ramFx.length) {
      for (const fx of game.ramFx) fx.t += dtReal;
      game.ramFx = game.ramFx.filter((fx) => fx.t < fx.dur);
    }

    // DOCKED REPAIR — the second sanctioned exception to "the hull never
    // self-heals" (docs/design-laws.md). It is what makes putting the ship
    // down a real decision rather than a stunt: a dock is a place you stop
    // being in the fight to get the hull back. Rides dtReal like the shield
    // regen it sits beside — a heal has no quantized target to beat against.
    //
    // A FINISHED station only (dockReady), the same gate the shield dome uses:
    // the ten seconds spent building one are meant to be exposed, and a
    // building site that repaired you would pay the reward before the cost.
    if (s.alive && dockReady(game.dock)) {
      s.hull = Math.min(game.st.hullMax, s.hull + CFG.DOCK_HEAL * dtReal);
    }
    if (game.dockFlashT > 0) game.dockFlashT -= dtReal;
    if (game.domeHitT > 0) game.domeHitT -= dtReal;   // dome deflection flare

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
    // Cosmetic bloom with no quantized target — rides dtReal like the other
    // pure-decay timers here, not the fixed step.
    if (game.chargeFlashT > 0) game.chargeFlashT -= dtReal;
    // Launch flashes, same clock and the same reason. Reaped in place; the list
    // is capped at push time (CFG.LAUNCH_FX_MAX) so this stays trivially short.
    for (let i = game.launchFx.length - 1; i >= 0; i--) {
      const fx = game.launchFx[i];
      fx.t += dtReal;
      if (fx.t >= CFG.LAUNCH_FX) game.launchFx.splice(i, 1);
    }
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
      // ACHIEVEMENTS ride the same one-shot flags. Several discovery rows are
      // exactly "this event happened once", and this table already guarantees
      // exactly-once — so they read a counter fed from here rather than making
      // world.js/physics.js carry a second announcement. Bumped BEFORE the tut
      // gate below: a repeat firing is still a real event, even when the
      // message for it has already been shown.
      const stat = ACH_EVENT_STATS[e.flag];
      if (stat) bump(game, stat);
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
      noteDeath(game, game.deathCause);   // ends every streak the sweep is timing
      game.prog.lives--;   // a life is spent per death (upgrades are kept)
      if (game.prog.lives <= 0) {
        game.gameOver = true;
        sfx.sfxGameOver();
        hud.setGameOverVisible(true, game.deathCause, game.prog);
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
    // One whine loop, two sources — the shotgun charge and the beam winch. They
    // can overlap (RMB arming while LMB winches), so take the louder rather
    // than letting whichever ran last silence the other.
    sfx.setCharge(Math.max(
      game.volleyCharging ? 0.2 + 0.8 * Math.min(1, game.volleyT / CFG.VOLLEY_TIME) : 0,
      game.latch ? 0.2 + 0.8 * Math.min(1, game.latch.t / game.latch.need) : 0));

    // ACHIEVEMENTS: evaluated last, so a row that fires this frame is testing
    // the state the player actually ended the frame in (the tier they just
    // reached, the rock they just landed). Rides dtReal — its timers are
    // wall-clock streaks (untouched for five minutes, coasting for two), not
    // quantized gameplay quantities, so the fixed step buys them nothing.
    updateAchievements(game, dtReal);
    if (game.achQueue.length) drainAchievements();

    // Camera follows the ship inside the fixed-step loop above (see there);
    // only the cosmetic shake decay rides the variable frame time here.
    game.shake *= Math.exp(-7 * dtReal);
}

// Announce the achievements that landed this frame. Deliberately its OWN
// channel, not hud.message: the single message slot is the sim talking to you
// about the world ("SOLAR FLARE — MOVE!"), and a score notification must never
// be able to overwrite a warning — or be overwritten by one. Several can land
// together (a tier-up trips a handful of thresholds at once), so the toast
// stack takes them all and the sound fires once.
// This is also where achievements PAY: pts x XP_PER_ACH_POINT into the normal
// stream, so a row feeds the pick purse and every ability pool exactly like any
// other good play. It happens HERE, in the drain, and not in achievements.js
// `award` — the sweep stays a pure read over the game, the same split that
// keeps it out of the DOM and the audio engine.
function drainAchievements() {
  const q = game.achQueue;
  let loudest = 0;
  let xp = 0;
  for (const a of q) {
    hud.achToast(a);
    xp += a.pts;
    if (a.pts > loudest) loudest = a.pts;
  }
  q.length = 0;
  addXp(game, xp * PROG.XP_PER_ACH_POINT);
  // The audio grammar (CLAUDE.md): triumph. A big one gets the tier-up fanfare,
  // an ordinary one the quieter upgrade tick — the same split the pick modal uses.
  if (loudest >= 60) sfx.sfxTierUp(); else sfx.sfxUpgrade();
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
      bump(game, 'pods');
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

// ---- THE SOLAR WAVE: the ship's half of it (CFG.STORM_*) -------------------
// Which world, if any, is casting its lee over this point. The sun is pinned
// at the origin, so a shadow is just the cylinder running anti-sunward from a
// body: project onto the sun->body ray and you are sheltered if you are PAST
// the body, within config.shelterR of that ray, and not so far behind that the
// lee has thinned out. Deliberately forgiving — the shelter has to be somewhere
// a pilot can actually reach under pressure — and render feathers the wedge so
// the boundary never reads as a drawn line.
//
// PLANETS AND MOONS BOTH, and the moons are the point: STORM_SHADOW_MIN_R used
// to sit at 60, which quietly failed two thirds of the sky's moons, so "duck
// behind that moon" was a move that worked or didn't with nothing to tell you
// which. The floor is 24 now — every real moon casts a lee, the ring shepherd
// moonlet still doesn't — and shelterR's flat pad is what makes the small ones
// a pocket rather than a razor edge. Shelter geometry is a property of the BODY,
// deliberately NOT of the wave: all three classes break around the same lee, so
// what a pilot learns behind one world holds behind every world in every storm.
//
// Over reg.nonField (physics.frameReg), not game.bodies: nothing that casts a
// lee is field rock, so walking the pockets to reject ~15,000 rocks one at a
// time is the exact cost the frame registries exist to delete. One frame stale
// is fine here — worlds do not appear or vanish between the LOD pass and this
// one, and the b.alive check below covers the one that dies mid-frame. Called
// only on the frames a sheath is genuinely washing over the ship anyway.
function shelterBody(x, y) {
  for (const b of frameReg(game).nonField) {
    if (b.type !== 'planet' && b.type !== 'moon' && b.type !== 'rogue') continue;
    if (!b.alive || b.radius < CFG.STORM_SHADOW_MIN_R) continue;
    const br = Math.hypot(b.x, b.y) || 1;
    const ux = b.x / br, uy = b.y / br;
    const along = x * ux + y * uy;          // distance out along the sun->body ray
    const behind = along - br;
    if (behind < 0 || behind > b.radius * CFG.STORM_SHADOW_LEN) continue;
    const px = x - ux * along, py = y - uy * along;   // offset across the ray
    const rr = shelterR(b);
    if (px * px + py * py < rr * rr) return b;
  }
  return null;
}

// Resolved ONCE per frame, before the substeps, so physics and ai read a fresh
// flag rather than re-deriving one each (the same owner-split as the
// afterburner tank). Everything the wave does to the player hangs off here.
function updateStorm(dtReal) {
  const s = game.ship;
  const st = game.storm;
  // A live wave floods the whole system with noise — nothing can pick the ship
  // out of it. That blackout IS the wave's reward: for its ~60-second passage
  // every nest and lurker is deaf, so a storm is the window to move.
  //
  // ONLY THE BIG TWO (cls.blind). A squall is a ripple, not a flood, and it is
  // also the class that costs almost nothing — handing it the free blackout as
  // well would make the cheapest weather the best weather, and would push the
  // system's sense-blind duty cycle well past where the stealth layer was
  // balanced (see the BLINDING note on CFG.STORM_CLASSES).
  game.stormBlind = !!st && !!st.blind;

  const wasExposed = game.stormExposed;
  game.stormExposed = false;
  game.stormShelter = null;
  if (st && s.alive) {
    const hr = Math.hypot(s.x, s.y);
    const lead = st.r - hr;   // >0 once the shock has swept past us
    if (lead > -st.band && lead < st.tail) {
      game.stormShelter = shelterBody(s.x, s.y);
      game.stormExposed = !game.stormShelter;
      // The lesson has to survive sheltering behind an UNNAMED body, and now
      // that every moon casts a lee that is the common case — most moons carry
      // no name at all, and `game.stormLeeName = ''` is falsy, so the message
      // table would drop the one message that teaches the counterplay. Same
      // fallback shape starmap.contactLabel uses for a nameless moon.
      // Through placeName like every other place-printing flag: shelterBody
      // takes ANY planet over STORM_SHADOW_MIN_R, and the Wanderer's Star is a
      // planet of radius 70*PLANET_R_MUL — so its lee is real, reachable before
      // the relay, and was naming it.
      if (game.stormShelter && !game.tut.stormLee) {
        const b = game.stormShelter;
        const kin = b.type === 'moon' && b.parent && b.parent.name
          ? `a moon of ${placeName(b.parent)}` : null;
        // EVERY moon carries a name now (MOON_NAMES in world.js) — but names
        // are EARNED (the chart ladder): an uncharted moon shelters you as
        // kin of its host, not by a name you haven't read off it yet. Worlds
        // keep the behavior they always had. The no-chartKey arm mirrors
        // starmap.contactLevel's contract exactly: a runtime-spawned moon
        // (replenishWorld mints no chartKey) earns its name by being SEEN,
        // not by existing — `!b.chartKey` alone named it unconditionally.
        const earned = b.type !== 'moon' ||
          (b.chartKey ? (game.charted && game.charted[b.chartKey]) : b.seen);
        game.stormLeeName = earned ? placeName(b, kin) : (kin || 'this moon');
      }
    }
  }

  if (game.stormExposed) {
    // stormIonT outlives the wave that set it, so the scale it is read against
    // has to outlive the wave too — render normalises the wash by stormIonMax,
    // never by a CFG constant that may describe a different class entirely.
    // Scaled by st.k with everything else the wave does: a front shredding at
    // the end of its reach scrambles proportionally less. Both are written
    // together every exposed frame, so the ratio render reads stays honest.
    game.stormIonT = st.ion * st.k;
    game.stormIonMax = st.ion * st.k;
    if (!wasExposed) game.stormHitWarn = st;
    // Riding it out in the open is a wager that pays: XP per second exposed,
    // scaled by the class's own `pay` (a squall's sheath costs a tenth of a
    // CME's hull and must not pay a CME's rate), and CAPPED per wave (see
    // PROG.STORM_RIDE_MAX) so chasing the front outward to stretch the timer
    // can't turn weather into a farm.
    const pay = Math.min(dtReal, Math.max(0, PROG.STORM_RIDE_MAX - game.stormRode));
    if (pay > 0) {
      game.stormRode += pay;
      addXp(game, pay * PROG.XP_STORM_RIDE * st.pay * st.k);
    }
    bump(game, 'stormExposedT', dtReal);
  } else if (game.stormIonT > 0) {
    game.stormIonT = Math.max(0, game.stormIonT - dtReal);
  }
  if (game.stormShelter) bump(game, 'stormShelterT', dtReal);

  // Settle up when the WAVE ends, not when exposure does: ducking into a lee
  // and back out again is one ride, not two, and one wave owes one message.
  // (The XP itself was already paid per second above — this is the receipt.)
  if (!game.storm && game.stormRode > 0) {
    if (game.stormRode >= 3) {
      bump(game, 'stormRides');
      best(game, 'stormRideBest', game.stormRode);
      if (s.alive) game.stormRideWarn = Math.round(game.stormRode);
    }
    game.stormRode = 0;
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
// Each chunk is a normal update() call, so it gets its own CFG.SUBSTEP_MAX
// budget — the cap can never bite here (1/60 of sim is 2 fine substeps), and
// the wall-clock budget below stays the only ceiling. A long watch at a high
// multiple WILL drag the frame rate down far enough to pace the sim onto the
// coarse step, which is the intended behaviour: fast-forward is a viewing tool,
// and the harnesses that must not move (tick / soak / mechTest) pin the step.
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
  // 50ms floor = a 20 fps clamp, so a tab-switch stall can't dump seconds of
  // backlog into one frame. It is also, deliberately, exactly what
  // CFG.SUBSTEP_MAX covers on the coarse step (3 x 1/60), so the two guards
  // meet with nothing left over: below 20 fps the sim runs slow rather than
  // trying to catch up. That dilation is real — a 15 fps frame advances 50ms
  // of sim per 66ms of wall clock, i.e. ~75% speed — and perf.dropped exists so
  // it can be seen instead of merely suspected.
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
  // it needs dtReal for its own smoothing even while the sim holds still. The
  // locale director rides alongside it for the same reason: its crossfade is
  // cosmetic easing with no quantized target, so it belongs on the wall clock.
  music.updateMusic(game, dtReal);
  zone.updateZone(game, dtReal);
  // ...and the chart's view easing, for exactly the same reason: it is cosmetic
  // motion with no quantized target, and the sim it sits over is frozen, so
  // game.time is not a clock it could use even if it wanted one.
  if (game.mapOpen) chartEase(dtReal);

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
  // Repace LAST, off the freshly-smoothed timings, and only from here: frame()
  // is the one place that knows what the machine is actually managing, and the
  // one place a harness never runs through.
  //
  // PACING BEFORE RENDER SCALE, deliberately. Both relief valves read the same
  // frameMs, and pacing is the one that costs the player nothing to look at —
  // it changes no pixels, only how the sim is stepped. Its gate is higher
  // (25ms vs 22ms) but its dwell is far shorter (1.5s vs 5s), so on a frame
  // that blows both budgets the invisible correction lands first and the
  // visible one only follows if that wasn't enough. Running them the other way
  // round would soften the picture for a machine a cheaper step would have
  // rescued outright.
  updatePacing(raw);
  // Last, off the numbers this frame just produced. A resize here is safe: it
  // lands between two renders, never inside one.
  updateAutoScale(dtReal);
}

requestAnimationFrame(frame);

// Debug/testing hooks: poke at state or step the sim from devtools
window.game = game;
window.musicState = music.musicState;   // live mood vector + bed gains
window.zoneState = zone.zoneState;      // which locale owns the cockpit accent, and why
window.tick = (seconds) => {
  game.started = true;   // headless soaks bypass the splash and run the sim
  // ...and bypass the spec modal: default to the first spec if none chosen, so
  // the ability tree + picks work headlessly (override game.prog.spec first to test others).
  if (!game.prog.spec) { applySpec(game.prog, SPECS[0].id); game.st = shipStats(game.prog); }
  // PIN THE FINE STEP. tick is the balance harness (window.soak rides it) and
  // it has to mean the same thing on every machine — if the live adaptive step
  // leaked in here, a soak on a slow laptop would integrate at 1/60 and one on
  // a fast one at 1/120, and the two results would not be comparable. Re-pinned
  // per call rather than once, because frame() keeps repacing between console
  // evals whenever the pane is visible. dt = 1/60 x DT 1/120 = exactly 2
  // substeps per call, comfortably under CFG.SUBSTEP_MAX, so the cap never
  // bites headlessly either.
  pinFineStep();
  const dt = 1 / 60;
  // Music mood advances with the sim so soaks can assert on it (the rAF loop
  // is suspended in hidden tabs, where tick is the only clock).
  for (let t = 0; t < seconds; t += dt) {
    perf.steps = 0;   // frame() normally owns this; tick bypasses it, and a whole
    update(dt);       // tick's worth of substeps in the "per frame" slot would lie
    music.updateMusic(game, dt);
    zone.updateZone(game, dt);   // ...and the locale with it — the pane suspends rAF
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
  updateFieldLOD(game, 0);  // teleport = reclassify (see onWarp) so the arrival renders
  return { x: Math.round(s.x), y: Math.round(s.y) };
};

// window.god(true/false): the ship ignores ALL damage (damageShip early-out,
// physics.js). For poking at dangerous places — corona, forts, gas cores —
// without respawn loops resetting the scene under you.
window.god = (on = true) => { game.godMode = !!on; return game.godMode; };

// window.storm(where, cls): fire a SOLAR WAVE on demand instead of waiting out
// CFG.STORM_EVERY. 'charge' (default) starts at the telegraph, so you see the
// whole event; 'here' skips straight to a front already climbing toward the
// ship, which is how you check exposure/shelter without a 40-second wait;
// 'off' clears the wave outright. Returns the live wave state.
//
// `cls` picks the intensity — a CFG.STORM_CLASSES key ('squall'/'surge'/'cme')
// or an index — and defaults to a fair roll, exactly as the sky rolls one. Pin
// it when you are checking a class's own numbers or palette; a random draw is
// the wrong tool for "does the squall read as a squall".
window.storm = (where = 'charge', cls) => {
  if (where === 'off') {
    game.storm = null; game.stormChargeT = 0; game.stormCls = null;
    game.stormExposed = false; game.stormBlind = false; game.stormIonT = 0;
    return null;
  }
  const c = (typeof cls === 'number' ? CFG.STORM_CLASSES[cls]
    : cls ? CFG.STORM_CLASSES.find((k) => k.key === cls) : null) || stormClass(Math.random);
  game.stormChargeT = 0;
  game.stormCls = c;
  if (where === 'charge') {
    game.storm = null;
    game.stormChargeT = c.charge;
    game.stormChargeMax = c.charge;
    game.stormChargeWarn = c;
    return { charging: c.charge, cls: c.key };
  }
  // Park the shock just inside the ship so the sheath is about to arrive.
  const r0 = Math.max(game.homeStar.radius, Math.hypot(game.ship.x, game.ship.y) - 1200);
  game.storm = { r: r0, prevR: r0, seed: Math.random() * 1000, k: 1, ...c };
  game.storm.k = stormStrength(game.storm);
  game.stormWarn = c;
  // `k` and `reachR` in the return value because parking a class OUTSIDE its
  // reach is the easy way to waste ten minutes wondering why nothing happened:
  // a squall cannot exist past half the system, so asking for one out at the
  // ice worlds hands back a wave that is already spent (k 0) and expires on the
  // next frame. That is correct, and it is invisible unless it is reported.
  return {
    r: Math.round(r0), shipR: Math.round(Math.hypot(game.ship.x, game.ship.y)),
    cls: c.key, k: +game.storm.k.toFixed(2), reachR: Math.round(CFG.WORLD_R * c.reach),
  };
};

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
    // update path — picks, timers, glow, AI — not just raw physics. Pinned to
    // the fine step for the same reason window.tick is: the suite is
    // bit-repeatable by contract, and the live adaptive step is measured off
    // the machine's frame rate.
    stepSim: (seconds) => { pinFineStep(); const dt = 1 / 60; for (let t = 0; t < seconds; t += dt) update(dt); },
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
