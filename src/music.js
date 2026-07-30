// Adaptive music director. Ten Scott Buckley tracks (assets/audio/music/ —
// CC-BY 4.0, see assets/audio/CREDITS.md + the settings-screen credit line;
// one composer ON PURPOSE so every mood stays in the same ethereal voice),
// grouped into four mood PLAYLISTS:
//   calm   — lost in deep space (the default)
//   world  — closing in on planets/moons/stations
//   sun    — dread as the star fills your sky
//   danger — combat, forts, heavy damage
// EXACTLY ONE track plays at a time — these are full unrelated mixes, and
// layering them (the first design) sounded like songs playing over each
// other. The mood vector picks a playlist with enter/exit hysteresis + a
// minimum dwell; switches CROSSFADE (~5s, fast ~2.5s into danger); a track
// that reaches its natural end rotates to a different track in the same
// playlist. Mood channels use fast-attack / slow-release smoothing.
//
// Tracks stream through <audio> elements (MediaElementSource), NOT
// decodeAudioData buffers — a 7-minute stereo track decodes to ~150 MB of
// raw PCM. updateMusic runs from frame() on dtReal EVERY frame, including
// while the sim is frozen (menus just duck the level — the duck rides
// musicBus, so per-track gains carry only the crossfade envelopes).
import { getAudio } from './sfx.js';
import { lerp } from './util.js';

const DIR = 'assets/audio/music/';
const PLAYLISTS = {
  calm:   { vol: 0.9,  files: ['adrift-among-infinite-stars', 'meanwhile', 'shadows-and-dust', 'permafrost'] },
  world:  { vol: 0.85, files: ['hymn-to-the-dawn', 'the-distant-sun'] },
  sun:    { vol: 1.0,  files: ['decoherence', 'incantation'] },
  danger: { vol: 0.85, files: ['machina', 'nightfall'] },
};
// User music level (settings slider, persisted). Defaults HIGH relative to the
// SFX bus (0.5): the ambient tracks are mastered quiet while the sample packs
// run hot — at equal gains the SFX buried the soundtrack.
let musicVol = 0.85;
const XFADE = 5;          // seconds; entering danger uses XFADE_HOT
const XFADE_HOT = 2.5;

// Playlist selection thresholds. ENTER to switch into a mood, the lower EXIT
// to stay in it — the gap stops flapping at a boundary. Priority when several
// qualify: danger > sun > world.
const ENTER = { danger: 0.45, sun: 0.4, world: 0.55 };
const EXIT  = { danger: 0.22, sun: 0.2, world: 0.3 };
const DWELL_OUT = 8;      // min seconds in a playlist before leaving it...
const DWELL_TO_DANGER = 1.5;   // ...except combat, which must answer fast

// Body types that count as "a world you're approaching" (never the sun —
// that's its own channel; never asteroids — the belt would pin the layer on).
const WORLD_TYPES = new Set(['planet', 'moon', 'rogue', 'gas', 'station', 'nest']);
// Alien states that mean it's actively working against you (ai.js machines)
const ENGAGED = new Set(['fetch', 'carry', 'harass', 'build']);

// There is no separate music toggle — the volume slider IS the control, and
// zero is the mute (streams pause entirely so a silent game isn't decoding).
const musicOn = () => musicVol >= 0.01;
const players = new Map();   // file -> { el, gain } (MediaElementSource is once-ever per element)
let current = null;          // file currently fading in / playing
let bucket = 'calm';
let bucketT = 0;             // seconds spent in the current playlist
let lastInBucket = {};       // bucket -> last file played (rotation avoids repeats)
let stopping = [];           // [{ file, at }] — fade-outs to pause once done
let duckCur = 0;
let retryT = 0;
const mood = { world: 0, sun: 0, danger: 0 };

function getPlayer(a, file) {
  let p = players.get(file);
  if (!p) {
    // Relative URL — identical over serve.py and the Electron app:// scheme.
    const el = new Audio(DIR + file + '.m4a');
    el.preload = 'auto';
    const gain = a.ctx.createGain();
    gain.gain.value = 0;
    a.ctx.createMediaElementSource(el).connect(gain);
    gain.connect(a.musicBus);
    // Natural end -> rotate to a DIFFERENT track in the current playlist
    el.addEventListener('ended', () => {
      if (current === file && musicOn()) switchTo(nextTrack(bucket), 2);
    });
    p = { el, gain };
    players.set(file, p);
  }
  return p;
}

function nextTrack(name) {
  const list = PLAYLISTS[name].files;
  const avoid = new Set([current, lastInBucket[name]]);
  const fresh = list.filter((f) => !avoid.has(f));
  const pool = fresh.length ? fresh : list.filter((f) => f !== current);
  return (pool.length ? pool : list)[(Math.random() * (pool.length || list.length)) | 0];
}

// Crossfade the current track out (if any) and `file` in over `fade` seconds.
function switchTo(file, fade) {
  const a = getAudio();
  if (!a || file === current) return;
  const t = a.ctx.currentTime;
  if (current) {
    const out = players.get(current);
    out.gain.gain.cancelScheduledValues(t);
    out.gain.gain.setValueAtTime(out.gain.gain.value, t);
    out.gain.gain.linearRampToValueAtTime(0, t + fade);
    stopping.push({ file: current, at: t + fade });
  }
  const p = getPlayer(a, file);
  try { p.el.currentTime = 0; } catch (e) { /* metadata not ready — plays from 0 anyway */ }
  p.el.play().catch(() => { /* retried from updateMusic */ });
  p.gain.gain.cancelScheduledValues(t);
  p.gain.gain.setValueAtTime(p.gain.gain.value, t);
  p.gain.gain.linearRampToValueAtTime(PLAYLISTS[bucket].vol, t + fade);
  current = file;
  lastInBucket[bucket] = file;
}

// User music level (settings slider). The level itself is applied per-frame
// in updateMusic (musicVol * duck); this only handles the mute edges — at
// zero the streams PAUSE (updateMusic early-returns while muted, so nothing
// else would stop them), and rising from zero resumes the current track.
export function setMusicVolume(v) {
  musicVol = Math.max(0, Math.min(1, v));
  const a = getAudio();
  if (!a) return;              // pre-gesture: the stored value is enough
  if (!musicOn()) {
    a.musicBus.gain.setTargetAtTime(0, a.ctx.currentTime, 0.1);
    for (const p of players.values()) p.el.pause();
  } else if (current && players.get(current).el.paused) {
    players.get(current).el.play().catch(() => {});
  }
}

// Asymmetric chase: intensity rises fast (the threat is HERE) and decays slow
// (the music breathes out after the moment passes).
function chase(cur, target, dt, up, down) {
  return lerp(cur, target, 1 - Math.exp(-(target > cur ? up : down) * dt));
}

function computeMood(game, dt) {
  const s = game.ship;
  let world = 0, sun = 0, danger = 0;
  if (game.started && !game.gameOver) {
    // Sun: musical envelope reaching ~3.5 radii out — wider than game.heatT
    // (the damage/visual envelope) so the dread precedes the burn, but with a
    // DEADZONE on the outer third: the spawn belt sits ~3.3R out, and without
    // it the layer brooded over every fresh run. heatT dominates close in so
    // music and hull alarm peak together.
    if (game.homeStar) {
      const d = Math.hypot(s.x - game.homeStar.x, s.y - game.homeStar.y);
      const R = game.homeStar.radius;
      const raw = Math.max(0, Math.min(1, 1 - (d - R) / (R * 3.5)));
      sun = Math.pow(Math.max(0, raw - 0.3) / 0.7, 1.5);
      sun = Math.max(sun, game.heatT || 0);
    }
    // Worlds: nearest planet/moon/etc, normalized by its own size so a small
    // moon must be hugged while a giant announces itself from far off.
    for (const b of game.bodies) {
      if (!b.alive || !WORLD_TYPES.has(b.type)) continue;
      const d = Math.hypot(b.x - s.x, b.y - s.y);
      const p = 1 - Math.max(0, d - b.radius) / (b.radius * 5 + 900);
      if (p > world) world = p;
      // An armed Bastion fort is a combat zone all by itself
      if (b.fort && b.fort.turrets.length && d < 2000) {
        danger = Math.max(danger, 0.75 * (1 - d / 2000) + 0.15);
      }
    }
    // Aliens: nearby presence simmers, actively-engaged presence boils
    for (const al of game.aliens) {
      const d = Math.hypot(al.x - s.x, al.y - s.y);
      if (d > 2800) continue;
      danger += (1 - d / 2800) * (ENGAGED.has(al.state) ? 0.65 : 0.3);
    }
    // Incoming turret fire
    for (const bo of game.bolts) {
      if (Math.hypot(bo.x - s.x, bo.y - s.y) < 1600) { danger += 0.2; break; }
    }
    // Taking hits keeps the danger floor up for a few seconds...
    const sinceHit = game.time - game.lastDamage;
    if (sinceHit < 6) danger = Math.max(danger, 0.85 * (1 - sinceHit / 6));
    // ...and a shredded hull never lets it fully settle.
    if (s.alive && s.hull < game.st.hullMax * 0.35) danger = Math.max(danger, 0.5);
    danger = Math.min(1, danger);
    world = Math.max(0, Math.min(1, world));
  }
  mood.world = chase(mood.world, world, dt, 1.4, 0.25);
  mood.sun = chase(mood.sun, sun, dt, 1.6, 0.3);
  mood.danger = chase(mood.danger, danger, dt, 2.5, 0.35);
}

// Which playlist does the mood ask for? EXIT threshold for the one we're in,
// ENTER for the others (hysteresis); fixed priority order.
function wantBucket() {
  const above = (k) => mood[k] >= (bucket === k ? EXIT[k] : ENTER[k]);
  if (above('danger')) return 'danger';
  if (above('sun')) return 'sun';
  if (above('world')) return 'world';
  return 'calm';
}

export function updateMusic(game, dt) {
  // Mood always advances — even with no AudioContext yet (pre-gesture) or
  // music toggled off — so headless window.tick soaks can assert on it and
  // the playlist choice is already right the instant audio does come up.
  computeMood(game, dt);
  bucketT += dt;
  if (!musicOn()) return;
  const a = getAudio();
  if (!a) return;                    // no gesture yet — nothing to drive

  // Playlist switching: dwell keeps it from flapping; danger answers fast.
  const want = wantBucket();
  if (want !== bucket && (want === 'danger' ? bucketT > DWELL_TO_DANGER : bucketT > DWELL_OUT)) {
    bucket = want;
    bucketT = 0;
    switchTo(nextTrack(bucket), want === 'danger' ? XFADE_HOT : XFADE);
  } else if (!current) {
    switchTo(nextTrack(bucket), 3);  // first start
  }

  // Menus duck the music instead of pausing it; death and game over sit low.
  // The duck rides musicBus so the per-track gains stay pure fade envelopes.
  const duckTo = !game.started ? 0.55
    : game.gameOver ? 0.3
    : (game.paused || game.settingsOpen || game.choosingUpgrade) ? 0.4
    : !game.ship.alive ? 0.4   // deep dip — give the death sequence the stage
    : 1;
  duckCur = lerp(duckCur, duckTo, 1 - Math.exp(-2.5 * dt));
  a.musicBus.gain.setTargetAtTime(musicVol * duckCur, a.ctx.currentTime, 0.1);

  // Pause finished fade-outs; nudge the current stream if a play() was denied.
  if (stopping.length) {
    stopping = stopping.filter((s) => {
      if (s.file === current) return false;
      if (a.ctx.currentTime < s.at) return true;
      const p = players.get(s.file);
      if (p) p.el.pause();
      return false;
    });
  }
  retryT -= dt;
  if (retryT <= 0) {
    retryT = 2;
    if (current) {
      const p = players.get(current);
      if (p.el.paused && !p.el.ended) p.el.play().catch(() => {});
    }
  }
}

// Debug/testing hook (window.musicState in main.js): mood, playlist, streams
export function musicState() {
  const out = {
    on: musicOn(), vol: musicVol, bucket, bucketT: +bucketT.toFixed(1), current,
    mood: { ...mood }, duck: duckCur, streams: {},
  };
  for (const [file, p] of players) {
    out.streams[file] = `${p.el.paused ? 'paused' : 'playing'}@${+p.gain.gain.value.toFixed(3)}`;
  }
  return out;
}
