// THE LOCALE DIRECTOR — the cockpit's accent colour, chosen by WHERE THE SHIP IS.
//
// Deliberately built like music.js, because it is the same problem: a handful
// of buckets, a per-frame presence score for each, ENTER/EXIT hysteresis so a
// boundary can't flap, a minimum DWELL so a fly-through can't strobe the HUD,
// and a CROSSFADE between the results instead of a cut. Read that file first —
// the two directors are meant to stay recognisably the same machine.
//
// What it is for: the console used to be ONE violet everywhere, and the only
// thing that moved it was the mood tint, which blended TOWARD the local sky —
// near the star it went corona amber over an amber sky, which is the lowest-
// contrast thing it could possibly have done. Every accent below is picked to
// sit OPPOSITE its region's sky, so the chrome reads HARDEST exactly where the
// sky behind it is busiest:
//
//   deep    blue-black, near empty        -> violet   (the house chrome)
//   world   dark + the planet's own blush -> gold     (highest luminance; "somewhere")
//   corona  hot amber, the star's fire    -> ice blue (the cold instrument in the fire)
//   shoal   grey/rust rock, cluttered     -> orchid   (nothing in a shoal is magenta)
//   fringe  the Oort's dim pale-blue bank -> glacial  (the colourless cold out there)
//
// The palette is ALSO picked around the instruments, which is the constraint
// that actually decides it: mint green, shield cyan, lives rose and alarm ember
// are spoken for, and a chrome that lands on one of them makes the instrument
// stop reading. Acid lime was tried for the shoal first and was wrong for
// exactly that reason — a lime cockpit sits four inches from a green hull bar.
// The fringe is the one deliberately DESATURATED accent: saturation is the
// second axis, and it is what keeps it apart from the corona's ice blue.
//
// CHROME ONLY, exactly as the mood tint was: hull green, shield blue, lives
// pink and the gold ★ score are semantic and never take the zone accent, or
// the instruments stop reading at a glance. The `lowhull` / `heat` alarm
// classes still override `--fr` outright in CSS — an alarm outranks a locale.
//
// This is a LOCATION channel, not a threat channel. Combat is not a place: it
// stays with the mood vector (which still drives the wash INTENSITY) and with
// the alarm classes. Adding a danger zone here would just paint a second red
// layer under the one #fx already owns.
import { CFG, fieldFrac } from './config.js';
import { lerp } from './util.js';

// name is for the debug hook + docs; rgb is the accent, written to the HUD as
// a comma triplet so CSS can spend it at any alpha (`rgba(var(--zone-rgb), a)`).
export const ZONES = {
  deep:   { name: 'Deep space',  rgb: [176, 112, 255] },   // --chrome, unchanged
  world:  { name: 'World',       rgb: [255, 201, 100] },   // --gold, promoted to lead
  corona: { name: 'Corona',      rgb: [110, 205, 255] },
  shoal:  { name: 'Shoal',       rgb: [255, 106, 213] },
  fringe: { name: 'Fringe',      rgb: [198, 226, 255] },
};

// Body types that count as "a world you are AT". Same set music.js uses for its
// world channel — never the sun (its own zone), never asteroids (the belt would
// pin the accent on for half the system).
const WORLD_TYPES = new Set(['planet', 'moon', 'rogue', 'gas', 'station', 'nest']);

// Presence thresholds, same shape as music.js's: ENTER to switch INTO a zone,
// the lower EXIT to stay in it. The gap is what stops a boundary flapping.
const ENTER = { corona: 0.45, shoal: 0.55, fringe: 0.45, world: 0.50 };
const EXIT  = { corona: 0.22, shoal: 0.25, fringe: 0.20, world: 0.28 };
// Fixed precedence when several qualify. Being INSIDE a shoal outranks being
// near the outer wall — the Farshoal sits inside the fringe band, and it is a
// shoal first. `deep` is the fallthrough and never scores.
const ORDER = ['corona', 'shoal', 'fringe', 'world'];

const DWELL_OUT = 3;      // min seconds in a zone before leaving it...
const DWELL_HOT = 1;      // ...except the two that can kill you, which answer fast
const HOT = new Set(['corona', 'fringe']);
// Colour crossfade rate. ~1.5s to settle: slow enough that skimming a moon's
// domain is a wash rather than a flash, fast enough that it has finished by the
// time you have finished arriving.
const FADE_K = 1.6;

let zone = 'deep';
let zoneT = 0;            // seconds spent in the current zone
const live = [176, 112, 255];   // the crossfading accent actually published
const pres = { corona: 0, shoal: 0, fringe: 0, world: 0 };

// How far into each zone the ship is, 0..1. Pure geometry — no threat, no
// timers, nothing but position — so the answer is the same on any seed and a
// headless tick can assert on it.
function presence(game) {
  const s = game.ship;
  pres.corona = pres.shoal = pres.fringe = pres.world = 0;
  if (!game.started || game.gameOver || !s) return;

  // CORONA: the star filling your sky. Deliberately TIGHTER than music.js's
  // dread envelope (R * 3.5, which reaches past the 8000 belt) — this one is
  // about where you ARE, and the whole inner system is not the corona. At
  // R * 1.4 the ENTER edge lands around r 4250, so the innermost lava world
  // (3600) is IN the fire and its neighbour (5000) is a world you visit.
  if (game.homeStar) {
    const R = game.homeStar.radius;
    const d = Math.hypot(s.x - game.homeStar.x, s.y - game.homeStar.y);
    pres.corona = Math.max(0, Math.min(1, 1 - (d - R) / (R * 1.4)));
  }

  // SHOAL: inside a dense field's own footprint. fieldFrac is THE containment
  // test every field-scoped system shares (leash, wake, entry announce), so the
  // accent can never disagree with the field about where the field ends. Its
  // 1.1 / 1.6 announce hysteresis is roughly what the ENTER/EXIT pair below
  // reproduces on this ramp.
  if (game.fields) {
    for (const f of game.fields) {
      const p = (1.6 - fieldFrac(f, s.x, s.y)) / 0.7;
      if (p > pres.shoal) pres.shoal = Math.max(0, Math.min(1, p));
    }
  }

  // FRINGE: the Oort approach. Onset at the last planet lane (42600), full at
  // the grind radius. The band is the warning, not the wall — the wall itself
  // is #fx's business.
  const r = Math.hypot(s.x, s.y);
  pres.fringe = Math.max(0, Math.min(1, (r - (CFG.WORLD_R - 3400)) / 3400));

  // WORLD: the nearest thing you'd call a place, normalized by its OWN size —
  // same formula as music.js's world channel, so the accent and the score agree
  // about what "arriving" means. A giant announces itself from far out; a small
  // moon has to be hugged.
  for (const b of game.bodies) {
    if (!b.alive || !WORLD_TYPES.has(b.type)) continue;
    const d = Math.hypot(b.x - s.x, b.y - s.y);
    const p = 1 - Math.max(0, d - b.radius) / (b.radius * 5 + 900);
    if (p > pres.world) pres.world = p;
  }
  pres.world = Math.max(0, Math.min(1, pres.world));
}

// Which zone do we want? EXIT threshold for the one we're in, ENTER for the
// others (hysteresis); fixed priority order; `deep` when nothing qualifies.
function wantZone() {
  for (const k of ORDER) {
    if (pres[k] >= (zone === k ? EXIT[k] : ENTER[k])) return k;
  }
  return 'deep';
}

// Runs from frame() on dtReal, every frame, frozen or not — the accent is
// cosmetic easing with no quantized target, so it rides the presentation clock
// (see the architecture doc). Published on the game object; hud.js reads it
// without importing this module, exactly as it reads game.mood.
export function updateZone(game, dt) {
  presence(game);
  zoneT += dt;
  const want = wantZone();
  const ready = zoneT > (HOT.has(want) ? DWELL_HOT : DWELL_OUT);
  if (want !== zone && ready) { zone = want; zoneT = 0; }

  const target = ZONES[zone].rgb;
  const k = 1 - Math.exp(-FADE_K * dt);
  for (let i = 0; i < 3; i++) live[i] = lerp(live[i], target[i], k);

  const z = game.zone || (game.zone = { key: zone, name: '', rgb: [0, 0, 0] });
  z.key = zone;
  z.name = ZONES[zone].name;
  z.rgb[0] = Math.round(live[0]);
  z.rgb[1] = Math.round(live[1]);
  z.rgb[2] = Math.round(live[2]);
}

// A new run must not inherit the last one's locale — respawning at the spawn
// belt with the cockpit still lit corona-blue reads as a bug.
export function resetZone() {
  zone = 'deep';
  zoneT = 0;
  live[0] = ZONES.deep.rgb[0];
  live[1] = ZONES.deep.rgb[1];
  live[2] = ZONES.deep.rgb[2];
}

// Debug/testing hook (window.zoneState in main.js): which zone, how long, and
// every presence score — the whole switch decision in one object.
export function zoneState() {
  const out = { zone, name: ZONES[zone].name, zoneT: +zoneT.toFixed(1), want: wantZone(), pres: {}, rgb: live.map(Math.round) };
  for (const k of ORDER) out.pres[k] = +pres[k].toFixed(3);
  return out;
}
