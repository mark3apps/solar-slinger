// Audio engine. EVERY sound is a real royalty-free recording/production from
// assets/audio/sfx/ (Kenney CC0 packs + CC0 OpenGameArt one-offs — see
// assets/audio/CREDITS.md), fetched + decoded lazily the moment the
// AudioContext exists. The small synth helpers at the bottom exist ONLY as
// fallbacks for the sub-second window before a sample finishes decoding (and
// they stay that way — the user explicitly rejected "old video game" synth
// blips as the primary voice). Continuous state (engine, tractor beam, corona
// fire, hull grind, volley charge) runs on LOOPING samples with gain/pitch
// driven from game state; the loop files are authored as seamless loops.
// music.js shares this module's AudioContext via getAudio() and streams the
// music beds through musicBus.
let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let enabled = true;
// User SFX level (settings slider, persisted). Defaults LOW on purpose: the
// sample packs are mastered hot while the ambient music is mastered quiet —
// at equal bus gains the SFX buried the soundtrack.
let sfxVol = 0.5;

// ---- sample bank (one-shots) ----------------------------------------------
// name -> list of interchangeable variant files (random pick per play).
const SFX_DIR = 'assets/audio/sfx/';
const BANK = {
  boom:      ['explosionCrunch_000.ogg', 'explosionCrunch_001.ogg', 'explosionCrunch_002.ogg', 'explosionCrunch_003.ogg', 'explosionCrunch_004.ogg'],
  deepBoom:  ['lowFrequency_explosion_000.ogg', 'lowFrequency_explosion_001.ogg'],
  hullHit:   ['impactMetal_000.ogg', 'impactMetal_001.ogg', 'impactMetal_002.ogg', 'impactMetal_003.ogg', 'impactMetal_004.ogg'],
  shield:    ['forceField_000.ogg', 'forceField_001.ogg', 'forceField_002.ogg', 'forceField_003.ogg'],
  grabZap:   ['forceField_002.ogg', 'forceField_003.ogg'],
  bolt:      ['laserSmall_000.ogg', 'laserSmall_001.ogg'],
  ignite:    ['thrusterFire_000.ogg', 'thrusterFire_001.ogg'],
  warpZap:   ['laserRetro_000.ogg'],
  whoosh:    ['swish-9.m4a', 'swish-7.m4a', 'swish-8.m4a'],
  uiDrop:    ['drop_001.ogg', 'drop_002.ogg'],
  alarm:     ['alarm_01.ogg'],
  alarmLow:  ['alarm_03.ogg'],
  sonar:     ['sonar_ping.mp3'],
  menuOpen:  ['doorOpen_001.ogg'],
  menuClose: ['doorClose_001.ogg'],
  click:     ['click_001.ogg', 'click_002.ogg'],
  confirm:   ['confirmation_001.ogg'],
  fanfare:   ['confirmation_002.ogg'],
  deny:      ['error_004.ogg'],
  glass:     ['glass_001.ogg', 'glass_002.ogg', 'glass_003.ogg', 'glass_004.ogg', 'glass_005.ogg', 'glass_006.ogg'],
  chime:     ['bong_001.ogg'],
};

// ---- sample loops (continuous state beds) ---------------------------------
// Each runs as a looping AudioBufferSourceNode whose gain (and sometimes
// playbackRate) is driven every frame from game state. `rate` = base pitch;
// `lowpass` inserts a filter (fire-1 through a 130 Hz lowpass IS the deep
// heat rumble — same recording, two voices). `lfo` adds free-running drift
// (two incommensurate rates beat against each other) so a loop that's on for
// minutes at a time — the engine — never sits statically.
const LOOPS = {
  thrust:    { file: 'spaceEngineLow_000.ogg', lfo: { rateHz: 0.17, rateDepth: 0.025 } },
  thrustMid: { file: 'spaceEngine_000.ogg', rate: 0.95,
               lfo: { rateHz: 0.29, rateDepth: 0.03, gainHz: 0.43, gainDepth: 0.16 } },
  thrustHi:  { file: 'engineCircular_001.ogg', rate: 1.12,
               lfo: { rateHz: 0.23, rateDepth: 0.02, gainHz: 0.31, gainDepth: 0.1 } },
  // Speed layers live OUTSIDE the engine-hum family on purpose: an extra hum
  // over three hums was inaudible. Wind = broadband air rush; strain = a
  // recorded rolling rumble pitched way down. (Space has no wind; the ship
  // does have a cockpit and a player who needs to FEEL fast.)
  speedWind:   { file: 'wind-whoosh-loop.ogg',
                 lfo: { rateHz: 0.19, rateDepth: 0.04, gainHz: 0.53, gainDepth: 0.18 } },
  speedStrain: { file: 'rolling.ogg', rate: 0.6 },
  // A real engine recording pitched UP into a jet scream. `trim` loops the
  // interior of the 20 s file, clear of any fade at the edges.
  speedJet:    { file: 'jet-engine.mp3', rate: 1.45, trim: [0.25, 0.85],
                 lfo: { rateHz: 0.27, rateDepth: 0.03 } },
  beam:      { file: 'engineCircular_000.ogg', rate: 0.9 },
  charge:    { file: 'engineCircular_002.ogg' },
  heat:      { file: 'fire-1.m4a' },
  heatLo:    { file: 'fire-1.m4a', lowpass: 130 },
  scrape:    { file: 'saw.ogg', rate: 0.8 },
  scrapeLo:  { file: 'rolling.ogg', rate: 0.45 },   // heavy body under the screech
};

const buffers = new Map();   // file -> AudioBuffer (missing/failed = synth fallback)

function loadSamples() {
  const want = new Set();
  for (const files of Object.values(BANK)) for (const f of files) want.add(f);
  for (const l of Object.values(LOOPS)) want.add(l.file);
  for (const f of want) {
    if (buffers.has(f)) continue;
    buffers.set(f, 'pending');
    // Relative path — identical over serve.py and the Electron app:// scheme.
    fetch(SFX_DIR + f)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => buffers.set(f, buf))
      .catch(() => buffers.delete(f));   // fall back to synth forever
  }
}

// Lazily attach a loop's source once its buffer has decoded. Returns the loop
// runtime ({ gain, src? }) or null before the context exists.
function ensureLoop(name) {
  if (!ctx) return null;
  const l = LOOPS[name];
  if (!l.gain) {
    l.gain = ctx.createGain();
    l.gain.gain.value = 0;
    l.gain.connect(sfxBus);
  }
  if (!l.src && buffers.get(l.file) instanceof AudioBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffers.get(l.file);
    src.loop = true;
    if (l.trim) {   // loop an interior slice (fractions of the buffer)
      src.loopStart = src.buffer.duration * l.trim[0];
      src.loopEnd = src.buffer.duration * l.trim[1];
    }
    src.playbackRate.value = l.rate || 1;
    let tail = src;
    if (l.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = l.lowpass;
      tail.connect(lp); tail = lp;
    }
    if (l.lfo) {
      // Pitch drift sums straight onto the playbackRate AudioParam...
      if (l.lfo.rateDepth) {
        const o = ctx.createOscillator();
        o.frequency.value = l.lfo.rateHz;
        const g = ctx.createGain(); g.gain.value = l.lfo.rateDepth;
        o.connect(g); g.connect(src.playbackRate); o.start();
      }
      // ...but level drift needs its own series node — adding an LFO onto
      // l.gain would hum audibly while the loop is meant to be OFF (gain 0).
      if (l.lfo.gainDepth) {
        const wob = ctx.createGain(); wob.gain.value = 1;
        const o = ctx.createOscillator();
        o.frequency.value = l.lfo.gainHz;
        const g = ctx.createGain(); g.gain.value = l.lfo.gainDepth;
        o.connect(g); g.connect(wob.gain); o.start();
        tail.connect(wob); tail = wob;
      }
    }
    tail.connect(l.gain);
    src.start();
    l.src = src;
  }
  return l;
}

// Play a one-shot sample variant. Returns false when no buffer is ready
// (caller then uses its synth fallback). `at` = seconds from now, for
// staggered phrases; `dur` truncates long files with a short fade-out.
function play(name, { vol = 1, rate = 1, at = 0, dur = 0 } = {}) {
  if (!ctx) return false;
  const files = BANK[name];
  if (!files) return false;
  const ready = files.filter((f) => buffers.get(f) instanceof AudioBuffer);
  if (!ready.length) return false;
  try {
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = buffers.get(ready[(Math.random() * ready.length) | 0]);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    src.connect(g); g.connect(sfxBus);
    if (dur > 0) {
      g.gain.setValueAtTime(vol, t0 + Math.max(0, dur - 0.18));
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.start(t0); src.stop(t0 + dur + 0.02);
    } else {
      src.start(t0);
    }
    return true;
  } catch (e) { return false; }
}

export function initAudio() {
  if (ctx || !enabled) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // Split buses so music can be toggled/ducked independently of the SFX.
    sfxBus = ctx.createGain();
    sfxBus.gain.value = sfxVol;
    sfxBus.connect(master);
    musicBus = ctx.createGain();   // level owned by music.js
    musicBus.connect(master);
    loadSamples();
  } catch (e) { enabled = false; }
}

// music.js hooks in here (null until the first user gesture builds the context)
export function getAudio() {
  return ctx ? { ctx, master, sfxBus, musicBus } : null;
}

// User SFX level (settings slider) — the whole SFX bus, one-shots and loops.
export function setSfxVolume(v) {
  sfxVol = Math.max(0, Math.min(1, v));
  if (sfxBus) sfxBus.gain.setTargetAtTime(sfxVol, ctx.currentTime, 0.05);
}

// Engine: THREE layers (deep rumble / brighter mid texture / harmonic cruise
// whine) with free-running LFO drift, an ignition burst on the rising edge,
// and a pitch spool-up from below — thrust is on for minutes at a time, so a
// single static loop reads flat. Only the WAKE-UP is on a clock (ignition +
// the mid texture blooming over the first ~2.5 s); everything after follows
// the SHIP, via `frac` = game.speedFrac (closeness to the speed ceiling):
//   accelerating hard (low frac)  — deep rumble dominates, engine laboring
//   approaching cruise (~35%+)    — the harmonic whine glides in
//   at the ceiling (~75%+)        — the SETTLE: rumble eases ~25% and the
//                                   whole stack lifts ~5% in pitch — the
//                                   governor has taken over, the engine
//                                   relaxes instead of shouting forever.
// So dragging a heavy rock against the flow stays a laboring roar however
// long it takes, and hitting top speed relaxes in seconds. Releasing thrust
// silences everything; Afterburner lifts gain AND pitch and re-ignites.
let thrustWasOn = false, thrustWasBoost = false, lastIgnite = -9, burnStart = 0;
export function setThrust(on, boost = false, frac = 0) {
  const lo = ensureLoop('thrust');
  if (!lo) return;
  const mid = ensureLoop('thrustMid');
  const hi = ensureLoop('thrustHi');
  const t = ctx.currentTime;
  const igniting = on && !thrustWasOn && t - lastIgnite > 0.3;
  const boosting = on && boost && !thrustWasBoost;
  if (on && !thrustWasOn) burnStart = t;
  if (igniting || boosting) {
    lastIgnite = t;
    play('ignite', { vol: boosting ? 0.34 : 0.26, rate: (boosting ? 1.1 : 0.9) + Math.random() * 0.2 });
    // Spool: drop the pitch below base so the setTargetAtTime below climbs it
    // into place — engines wind up, they don't snap on.
    if (lo.src) lo.src.playbackRate.setValueAtTime(0.82, t);
    if (mid.src) mid.src.playbackRate.setValueAtTime(0.78, t);
  }
  thrustWasOn = on;
  thrustWasBoost = on && boost;
  const burn = on ? t - burnStart : 0;
  const bloom = Math.max(0, Math.min(1, (burn - 0.4) / 2.2));     // wake-up (time)
  const cruise = Math.max(0, Math.min(1, (frac - 0.35) / 0.5));   // speed-driven
  const settle = Math.max(0, Math.min(1, (frac - 0.75) / 0.25));  // speed-driven
  lo.gain.gain.setTargetAtTime(
    on ? (boost ? 0.42 : 0.3 * (1 - 0.25 * settle)) : 0, t, on ? 0.09 : 0.16);
  mid.gain.gain.setTargetAtTime(
    on ? (boost ? 0.24 : 0.13 * (0.45 + 0.55 * bloom)) : 0, t, on ? 0.13 : 0.2);
  hi.gain.gain.setTargetAtTime(
    on ? (boost ? 0.13 : 0.1) * cruise : 0, t, on ? 0.3 : 0.2);
  const lift = 0.05 * settle;
  if (lo.src) lo.src.playbackRate.setTargetAtTime((on && boost ? 1.22 : 1) + lift, t, 0.22);
  if (mid.src) mid.src.playbackRate.setTargetAtTime(
    (on ? (boost ? 1.16 : 0.95) : 0.88) + lift + 0.04 * cruise, t, 0.28);
  if (hi.src) hi.src.playbackRate.setTargetAtTime(1.12 + lift * 2, t, 0.35);
}

// Speed voice, keyed to game.speedFrac (distance to the speed ceiling,
// measured relative to the local orbital flow — exactly like the governor).
// THREE layers, all timbrally alien to the engine hums so they cut through:
//   wind   — gusty air rush, in from ~45% of the cap, swelling in level and
//            pitch all the way to the limit (the LFO makes it gust)
//   jet    — a real engine recording pitched up into a turbine scream, in
//            from ~70% and screaming right at the cap
//   strain — deep rolling rumble, only in the last ~fifth before the cap:
//            the hull working at its limit
// The CALLER gates frac on thrust being applied (main.js passes 0 otherwise):
// every engine noise goes silent the moment the throttle is released.
export function setSpeed(frac) {
  const wind = ensureLoop('speedWind');
  if (!wind) return;
  const jet = ensureLoop('speedJet');
  const strain = ensureLoop('speedStrain');
  const t = ctx.currentTime;
  const w = Math.max(0, Math.min(1, (frac - 0.45) / 0.55));
  wind.gain.gain.setTargetAtTime(0.42 * w * w, t, 0.12);
  if (wind.src) wind.src.playbackRate.setTargetAtTime(0.85 + 0.45 * w, t, 0.2);
  const j = Math.max(0, Math.min(1, (frac - 0.7) / 0.3));
  jet.gain.gain.setTargetAtTime(0.3 * j * Math.sqrt(j), t, 0.14);
  if (jet.src) jet.src.playbackRate.setTargetAtTime(1.45 + 0.3 * j, t, 0.25);
  const st = Math.max(0, Math.min(1, (frac - 0.82) / 0.18));
  strain.gain.gain.setTargetAtTime(0.2 * st, t, 0.15);
  if (strain.src) strain.src.playbackRate.setTargetAtTime(0.6 + 0.12 * st, t, 0.2);
}

// Tractor beam: circular engine hum, low in the mix (it's held for seconds)
export function setBeam(on) {
  const l = ensureLoop('beam');
  if (!l) return;
  l.gain.gain.setTargetAtTime(on ? 0.1 : 0, ctx.currentTime, 0.05);
}

// Corona heat — x is game.heatT (0..1). The fire crackle squares in (only
// bites near the photosphere); its lowpassed twin is the deep rumble that
// warns from further out.
export function setHeat(x) {
  const hi = ensureLoop('heat');
  if (!hi) return;
  hi.gain.gain.setTargetAtTime(0.5 * x * x, ctx.currentTime, 0.15);
  const lo = ensureLoop('heatLo');
  lo.gain.gain.setTargetAtTime(0.45 * x, ctx.currentTime, 0.15);
}

// Surface grind — LOUD on purpose: scraping eats the hull, and the sound is
// the alarm. Three parts: the saw screech, a deep rumbling body under it,
// a bang on first contact, and irregular metal-tearing hits while it lasts.
let lastScrapeHit = 0, scrapeWas = 0;
export function setScrape(x) {
  const l = ensureLoop('scrape');
  if (!l) return;
  const lo = ensureLoop('scrapeLo');
  const t = ctx.currentTime;
  if (x > 0.6 && scrapeWas <= 0.1) play('hullHit', { vol: 0.55, rate: 0.75 });
  scrapeWas = x;
  l.gain.gain.setTargetAtTime(0.55 * x, t, 0.08);
  lo.gain.gain.setTargetAtTime(0.35 * x, t, 0.1);
  if (x > 0.3 && t - lastScrapeHit > 0.22 + Math.random() * 0.3) {
    lastScrapeHit = t;
    play('hullHit', { vol: 0.3 * x, rate: 1.05 + Math.random() * 0.5 });
  }
}

// Volley charge: engine whine spun up by the charge level
export function setCharge(x) {
  const l = ensureLoop('charge');
  if (!l) return;
  l.gain.gain.setTargetAtTime(0.13 * x, ctx.currentTime, 0.06);
  if (l.src) l.src.playbackRate.setTargetAtTime(0.62 + 0.9 * x * x, ctx.currentTime, 0.08);
}

// Loudness by distance from the ship, for world-positioned events — on-screen
// is full volume, a couple of screens out fades to silence. Keeps far-side
// belt collisions from spamming the mix.
export function distVol(game, x, y) {
  const s = game.ship;
  const r = Math.max(900, (game.viewR || 1200) * 1.15);
  return Math.max(0, Math.min(1, 1.15 - Math.hypot(x - s.x, y - s.y) / (r * 2)));
}

// ---- one-shots ------------------------------------------------------------

export function sfxGrab() {
  if (!play('grabZap', { vol: 0.24, rate: 1.35 })) blip(90, 0.25, 'sawtooth', 0.15, 220);
}

export function sfxFling() {
  if (!play('whoosh', { vol: 0.5, rate: 0.95 + Math.random() * 0.25 })) {
    blip(500, 0.3, 'square', 0.12, 90);
  }
}

export function sfxDrop() {
  if (!play('uiDrop', { vol: 0.35 })) blip(220, 0.15, 'sine', 0.1, 110);
}

export function sfxCollect() {
  if (!play('glass', { vol: 0.32, rate: 0.9 + Math.random() * 0.3 })) {
    blip(880, 0.09, 'sine', 0.14); blip(1320, 0.14, 'sine', 0.1);
  }
}

// Glow-pocket mote: like collect but smaller, rounder, higher
export function sfxMote() {
  if (!play('glass', { vol: 0.2, rate: 1.25 + Math.random() * 0.35 })) {
    blip(1100, 0.08, 'sine', 0.08);
  }
}

export function sfxUpgrade() {
  if (!play('confirm', { vol: 0.5 })) {
    blip(440, 0.12, 'square', 0.12); blip(660, 0.14, 'square', 0.1); blip(880, 0.2, 'square', 0.1);
  }
}

// Tier-up / spec choice: fanfare + rising glass arpeggio
export function sfxTierUp() {
  const ok = play('fanfare', { vol: 0.55 });
  play('glass', { vol: 0.3, rate: 1.0, at: 0.05 });
  play('glass', { vol: 0.3, rate: 1.26, at: 0.17 });
  play('glass', { vol: 0.3, rate: 1.5, at: 0.29 });
  if (!ok) { blip(440, 0.12, 'square', 0.12); blip(660, 0.14, 'square', 0.1); blip(880, 0.25, 'square', 0.1); }
}

export function sfxLife() {
  if (!play('fanfare', { vol: 0.5 })) blip(660, 0.2, 'sine', 0.12, 990);
  play('glass', { vol: 0.28, rate: 1.5, at: 0.12 });
}

export function sfxHit() {
  if (!play('hullHit', { vol: 0.5, rate: 0.9 + Math.random() * 0.25 })) {
    blip(140, 0.2, 'sawtooth', 0.2, 50);
  }
}

// Non-damaging contact clank. Bumping off a body used to be SILENT: the
// impact sound lived inside damageShip, and gentle hits do no damage BY
// DESIGN (physics invariant 3) — so a visible bounce made no noise. Every
// real bounce now clanks, scaled by closing speed and impactor mass, heavier
// and duller than the damage hit (rate 0.6-0.85 vs 0.9-1.15) with a deep
// layer on hard slams. Cooldown-throttled: contact repeats every substep.
let lastBump = 0;
export function sfxBump(strength) {
  if (!ctx) return;
  const x = Math.max(0, Math.min(1, strength));
  if (x < 0.05) return;
  const t = ctx.currentTime;
  if (t - lastBump < 0.18) return;
  lastBump = t;
  play('hullHit', { vol: 0.2 + 0.5 * x, rate: 0.6 + 0.25 * x + Math.random() * 0.1 });
  if (x > 0.55) play('deepBoom', { vol: 0.3 * x, rate: 0.9 });
}

// Shield absorbed the whole hit — energy zap, not metal
export function sfxShieldHit() {
  if (!play('shield', { vol: 0.35, rate: 1.05 + Math.random() * 0.15 })) {
    blip(900, 0.15, 'sine', 0.1, 300);
  }
}

// A rock snapping into the orbit shield
export function sfxOrbitCapture() {
  if (!play('shield', { vol: 0.28, rate: 1.25 })) sfxCollect();
}

export function sfxDenied() {
  if (!play('deny', { vol: 0.4 })) blip(160, 0.2, 'square', 0.1, 110);
}

export function sfxUiClick()   { play('click', { vol: 0.4 }); }
export function sfxMenuOpen()  { play('menuOpen', { vol: 0.35 }); }
export function sfxMenuClose() { play('menuClose', { vol: 0.35 }); }

// Discovery / survey / lore chime
export function sfxChime() {
  if (!play('chime', { vol: 0.35, rate: 1 + Math.random() * 0.06 })) {
    blip(1180, 0.4, 'sine', 0.09, 1170);
  }
}

// Bastion turret fire (call with distVol so far forts stay quiet)
export function sfxBolt(vol = 1) {
  if (vol < 0.05) return;
  play('bolt', { vol: 0.22 * vol, rate: 0.95 + Math.random() * 0.12 });
}

// Slipstream warp: retro zap + shimmer
export function sfxWarp() {
  if (!play('warpZap', { vol: 0.45, rate: 0.85 })) blip(180, 0.3, 'sine', 0.12, 1400);
  play('glass', { vol: 0.22, rate: 1.4, at: 0.08 });
}

// Evasion roll: a real recorded whoosh, pitched low and fast
export function sfxEvade() {
  if (!play('whoosh', { vol: 0.45, rate: 0.75 })) noiseSweep(0.28, 300, 2400, 0.16);
}

// Hazard klaxon (solar flare, meltdown, crush depth): a real alarm loop,
// played for ~1.6 s. Quiet on purpose — it's a warning, not a jump-scare.
export function sfxAlarm() {
  if (!play('alarm', { vol: 0.3, dur: 1.6 })) {
    blip(620, 0.14, 'square', 0.06);
    blip(470, 0.14, 'square', 0.06, null, 0.17);
  }
}

// Softer "contact" alert (aliens, storms, rogue sightings): the darker alarm
// loop, pitched down, shorter.
export function sfxWarnLow() {
  if (!play('alarmLow', { vol: 0.22, rate: 0.82, dur: 1.3 })) {
    blip(280, 0.5, 'sawtooth', 0.07, 150);
  }
}

// Ghost-ship sonar: a real submarine ping, louder the closer you are
export function sfxPing(vol = 0.5) {
  const v = Math.max(0.15, Math.min(1, vol));
  if (!play('sonar', { vol: 0.55 * v })) {
    blip(1180, 0.5, 'sine', 0.10 * v, 880);
    blip(590, 0.7, 'sine', 0.05 * v, 560);
  }
}

export function sfxBoom(size = 1, vol = 1) {
  if (vol < 0.04) return;
  let ok = play('boom', {
    vol: Math.min(1, 0.3 + size * 0.18) * vol,
    rate: Math.max(0.55, 1.15 - size * 0.16),   // bigger blast = deeper pitch
  });
  if (size >= 2) {
    ok = play('deepBoom', { vol: Math.min(1, 0.25 + size * 0.15) * vol, rate: Math.max(0.6, 1.05 - size * 0.1) }) || ok;
  }
  if (ok || !ctx) return;
  noiseSweep(Math.min(1.4, 0.35 + size * 0.25), 700 - Math.min(550, size * 120), 60,
    Math.min(0.6, 0.25 + size * 0.1) * vol);
}

// The ship coming apart must be UNMISTAKABLE — it used to be sfxBoom(3),
// which is the same explosion samples as any big rock shatter, so deaths
// vanished into battle noise. Now: a full layered sequence at the top of the
// mix — metal crack + blast + deep shock, scattering debris pings, a long
// falling whoosh, and the engine recording swept down to a stall. Nothing
// else in the game "powers down", so this reads as YOUR ship dying.
export function sfxShipDeath() {
  const ok = play('boom', { vol: 1, rate: 0.7 });
  play('hullHit', { vol: 0.7, rate: 0.8 });
  play('deepBoom', { vol: 1, rate: 0.62, at: 0.06 });
  play('whoosh', { vol: 0.6, rate: 0.5, at: 0.15 });
  play('hullHit', { vol: 0.35, rate: 1.3, at: 0.45 });   // debris pinging off
  play('hullHit', { vol: 0.22, rate: 1.5, at: 0.72 });
  if (!ok) { noiseSweep(1.2, 500, 50, 0.5); return; }
  // Engine stall: the jet recording falls from full spin to nothing
  try {
    const buf = buffers.get('jet-engine.mp3');
    if (buf instanceof AudioBuffer) {
      const t0 = ctx.currentTime + 0.1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.setValueAtTime(1.1, t0);
      src.playbackRate.exponentialRampToValueAtTime(0.3, t0 + 1.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.45, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.6);
      src.connect(g); g.connect(sfxBus);
      src.start(t0, buf.duration * 0.35);   // interior of the recording, past any fade-in
      src.stop(t0 + 1.7);
    }
  } catch (e) { /* best-effort */ }
}

// All lives gone: distant rumble under a slow, falling three-note bell
export function sfxGameOver() {
  play('deepBoom', { vol: 0.5, rate: 0.55 });
  const ok = play('chime', { vol: 0.35, rate: 1.0, at: 0.15 });
  play('chime', { vol: 0.35, rate: 0.84, at: 0.7 });
  play('chime', { vol: 0.38, rate: 0.63, at: 1.3 });
  if (!ok) {
    blip(294, 0.7, 'triangle', 0.12, null, 0.15);
    blip(220, 0.7, 'triangle', 0.12, null, 0.65);
    blip(147, 1.4, 'triangle', 0.13, null, 1.15);
  }
}

// ---- synth fallbacks ------------------------------------------------------
// ONLY reached in the sub-second window before a sample decodes (or if a
// sample file failed to load). Never make these the primary voice again.

function blip(freq, dur, type = 'sine', vol = 0.2, slideTo = null, at = 0) {
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(sfxBus);
    o.start(t0); o.stop(t0 + dur);
  } catch (e) { /* audio is best-effort */ }
}

function noiseSweep(dur, f0, f1, vol) {
  if (!ctx) return;
  try {
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(f0, ctx.currentTime);
    bp.frequency.exponentialRampToValueAtTime(Math.max(30, f1), ctx.currentTime + dur);
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(bp); bp.connect(g); g.connect(sfxBus);
    src.start();
  } catch (e) { /* best-effort */ }
}
