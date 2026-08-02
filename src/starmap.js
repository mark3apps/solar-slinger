// THE SYSTEM CHART — the whole sky on one screen, and the journey you plot on it.
//
// The radar is a SHIP-CENTRED SCAN: it shows the local neighbourhood, it forgets
// the moment the sweep passes, and past its rim there is nothing. This is the
// other instrument — a SUN-CENTRED CHART. It never moves, it remembers, and it
// is allowed to plot things the dial refuses to: a contact the scan has never
// swept still gets a mark here, because a chart's job is to carry an old, vague
// plot rather than a live return. That difference is the whole reason the two
// exist side by side, and it is what the knowledge ladder below encodes.
//
// This file is the chart's MODEL: the projection, what each contact is allowed
// to say about itself, and the route. It draws nothing — render.drawStarMap
// paints it, hud.js carries the DOM chrome, main.js owns the open/close flag
// exactly as it owns the other shell modals.
//
// THE KNOWLEDGE LADDER (contactLevel). Three tiers plus a floor, and every draw
// decision on the chart hangs off it:
//
//   charted — game.charted[b.chartKey]: you flew up and read the nameplate.
//             Name, class, true position, its orbit lane, its family.
//   seen    — b.seen: the fog scan found it, you never went. True position and
//             class, NO name and NO lane. "SOMETHING IS THERE, and it's a moon."
//   unknown — neither: a soft bloom at a GUESSED position with an uncertainty
//             ring around it. No name, no class, no size, no lane — and ONLY
//             for a world or a shoal (see plottable): an unknown mark says no
//             more than "something is roughly there", and 59 moons' worth of
//             that is not a chart, it is fog with dots in it.
//   null    — b.hidden (the Wanderer's Star). NOTHING, ever. The powered relay
//             stays the only way to learn it exists, and a chart that leaked it
//             would gut the questline as surely as a minimap blip would.
//
// The guess is DETERMINISTIC (ghostOff, hashed off b.id) and that is not a
// detail: a plotted position that re-rolled every frame would boil, and a
// boiling mark reads as a rendering bug rather than as uncertainty. It also has
// to be the same offset the flight guidance uses, or the chart and the radar
// would disagree about where you are being sent.
import { CFG, fieldLobe, PTYPE_LABELS } from './config.js';
import { TAU, clamp } from './util.js';
import { frameReg } from './physics.js';

// The chart's own view state. Deliberately NOT on `game`: it is where the
// player is LOOKING, not part of the run — it survives a death, it means
// nothing to a soak, and resetRun has no business clearing it (chartReset does,
// on open). The route is the opposite and lives on game, because it IS run state.
export const chart = {
  // RENDERED view — what is actually on screen this frame.
  cx: 0, cy: 0,      // world point sitting under the centre of the view
  zoom: 1,           // multiplier over the fit scale (1 = the whole system fits)
  // TARGET view — what the pointer has asked for. The rendered one eases toward
  // it every frame (chartEase), so the chart has WEIGHT: it lags a drag
  // slightly, glides to a stop after one, and slides between zoom levels
  // instead of cutting. A view that tracked the cursor exactly felt like
  // dragging a picture; this feels like swinging an instrument around.
  tx: 0, ty: 0, tz: 1,
  vx: 0, vy: 0,      // world units/sec of coast left after a released drag
  t: 0,              // the chart's OWN clock, seconds, advanced by chartEase.
                     // game.time is frozen behind a shell modal, so anything on
                     // this panel that has to keep moving — the readout's
                     // portrait, above all — has no other clock to ride.
  hover: null,       // what the cursor is over: { kind, b|field|i, x, y } or null
  drag: null,        // { sx, sy, cx, cy } while panning, else null
  dragged: false,    // did this drag actually move? (a drag must not also click)
  flash: null,       // a one-line refusal ("journey full") for the readout strip.
                     // NOT hud.message: the #msg slot is hidden under a shell
                     // modal by design, and a chart is where the player is
                     // already looking. Cleared by the next pointer move, which
                     // is the only clock a frozen sim has.
  marks: 0,          // contacts plotted last draw — the header's CONTACTS stat.
                     // Tallied by the draw rather than re-walked by hud: render
                     // already visits every one of them, and a second pass over
                     // the registry to count what was just counted is waste.
};

// The chart frames the WHOLE system: the Oort wall plus a margin, so the world
// boundary sits inside the view rather than exactly on its edge.
export const CHART_R = CFG.WORLD_R * 1.07;
const ZOOM_MIN = 0.85;    // a little wider than the fit, for context
const ZOOM_MAX = 60;      // enough that a moon family separates into moons
export const MAX_WAYPOINTS = 8;

// ---------------------------------------------------------------------------
// Projection. One scale for both axes (a chart with a warped aspect is a lie
// about bearings), so everything positional is `centre + (world - chart.c) * s`.
// Kept as a bare scale rather than a project(x,y) helper on purpose: the draw
// walks a few hundred contacts a frame and should not allocate a point each.
// ---------------------------------------------------------------------------
export function chartFit(vw, vh) {
  return (Math.min(vw, vh) * 0.5 * 0.9) / CHART_R;
}
export function chartScale(vw, vh) {
  return chartFit(vw, vh) * chart.zoom;
}
export function screenToWorld(sx, sy, vw, vh) {
  const s = chartScale(vw, vh);
  return { x: chart.cx + (sx - vw / 2) / s, y: chart.cy + (sy - vh / 2) / s };
}

// Recentre on the sun at the fit scale — the view the chart always OPENS on.
// "Centred on the sun" is the chart's one fixed promise; every session of
// panning and zooming has to be one button away from it.
//
// `instant` is the difference between OPENING and RECENTRING. Opening must land
// on the sun view already composed — easing in from wherever the last session
// was left would be a fly-through from a place the player is no longer looking
// at. RECENTRE is the opposite: gliding home is how you keep your bearings on
// the way, so it moves only the target and lets the ease carry it.
export function chartReset(instant = false) {
  chart.tx = 0; chart.ty = 0; chart.tz = 1;
  chart.vx = 0; chart.vy = 0;
  if (instant) { chart.cx = 0; chart.cy = 0; chart.zoom = 1; }
  chart.hover = null; chart.drag = null; chart.dragged = false;
  chart.flash = null;
}

// Zoom about the CURSOR, not the centre: the thing you are pointing at is the
// thing you want to keep. Zooming about the centre makes picking a single moon
// out of a family a chase — the target slides off screen as you close in.
//
// Anchored in TARGET space, not rendered space. Correcting the rendered centre
// against a zoom that is itself still easing chases its own tail: each wheel
// notch would re-anchor to a view that had moved since the last one, and the
// point under the cursor would walk away as you spun the wheel.
export function chartZoomAt(sx, sy, factor, vw, vh) {
  const fit = chartFit(vw, vh);
  const z0 = chart.tz;
  const z1 = clamp(z0 * factor, ZOOM_MIN, ZOOM_MAX);
  if (z1 === z0) return;
  // The world point under the cursor, per the TARGET view, must not move.
  const ox = sx - vw / 2, oy = sy - vh / 2;
  chart.tx += ox / (fit * z0) - ox / (fit * z1);
  chart.ty += oy / (fit * z0) - oy / (fit * z1);
  chart.tz = z1;
  clampCentre();
}

export function chartPanTo(sx, sy, vw, vh) {
  const d = chart.drag;
  if (!d) return;
  const s = chartFit(vw, vh) * chart.tz;
  chart.tx = d.cx - (sx - d.sx) / s;
  chart.ty = d.cy - (sy - d.sy) / s;
  chart.vx = 0; chart.vy = 0;
  if (Math.abs(sx - d.sx) > 3 || Math.abs(sy - d.sy) > 3) chart.dragged = true;
  clampCentre();
}

// End of a drag; returns whether it actually moved, so the caller can tell a
// pan from a click.
//
// THE LAG IS THE THROW. The rendered view always trails the target while you
// drag, and how far it trails is exactly how fast you were dragging — so the
// residual becomes the coast velocity, and no clock, timestamp or pointer-
// velocity history is needed for it. Flick and it glides; drag slowly to a
// stop and it stops with you.
const RELEASE_GAIN = 3.4;    // coast speed per unit of drag lag
export function chartDragEnd() {
  const moved = chart.dragged;
  if (moved) {
    chart.vx = (chart.tx - chart.cx) * RELEASE_GAIN;
    chart.vy = (chart.ty - chart.cy) * RELEASE_GAIN;
  }
  chart.drag = null; chart.dragged = false;
  return moved;
}

// Per-frame view easing — what gives the chart its weight. Rides dtReal, NOT
// the sim clock: the chart is a shell modal, so game.time does not advance at
// all while it is up. It is also purely cosmetic motion with no quantized
// target, which is the test every other dtReal easing in this game passes.
const PAN_K = 11;     // how hard the rendered centre chases the target
const ZOOM_K = 10;
const COAST_K = 4.2;  // friction on a released drag
export function chartEase(dt) {
  chart.t += dt;
  if (!chart.drag && (chart.vx || chart.vy)) {
    chart.tx += chart.vx * dt;
    chart.ty += chart.vy * dt;
    const f = Math.exp(-COAST_K * dt);
    chart.vx *= f; chart.vy *= f;
    if (Math.abs(chart.vx) + Math.abs(chart.vy) < 1) { chart.vx = 0; chart.vy = 0; }
    clampCentre();
  }
  const k = 1 - Math.exp(-PAN_K * dt);
  chart.cx += (chart.tx - chart.cx) * k;
  chart.cy += (chart.ty - chart.cy) * k;
  // Zoom eases in LOG space. Lerped linearly the same 1.18x notch crawls at 40x
  // and snaps at 1x — the eye reads the RATIO, not the difference.
  const kz = 1 - Math.exp(-ZOOM_K * dt);
  const lz = Math.log(chart.zoom);
  chart.zoom = Math.exp(lz + (Math.log(chart.tz) - lz) * kz);
}

// You cannot pan the system off the chart. Without this a stray drag at high
// zoom leaves you staring at empty space with no landmark to navigate back by,
// and the RECENTRE button becomes the only way out. Clamps the TARGET — the
// rendered centre eases to it, so it can never be left outside either.
function clampCentre() {
  const lim = CHART_R;
  chart.tx = clamp(chart.tx, -lim, lim);
  chart.ty = clamp(chart.ty, -lim, lim);
}

// ---------------------------------------------------------------------------
// What the chart knows
// ---------------------------------------------------------------------------

// Is this body a PLACE, or is it gravel? The chart plots destinations — worlds,
// moons, installations, the wanderers — and deliberately not belt rock: at
// system scale a few hundred anonymous asteroid marks would bury the ~80 marks
// that mean something, which is the same reason the dial draws shoal rock as a
// separate dim terrain layer instead of as contacts. The dense fields are on
// the chart as REGIONS (they are named places); their individual rocks are not.
export function isContact(b) {
  if (!b.alive) return false;
  const t = b.type;
  return t === 'planet' || t === 'moon' || t === 'station' || t === 'nest' ||
    t === 'rogue' || !!b.comet || !!b.visitor || !!b.tinker || !!b.ghost;
}

// TWO STATES AND A FLOOR (user call). This used to have a third tier between
// them — `seen`, "the fog scan found it but you never went" — drawn as a hollow
// ring. It was one distinction too many: the player only ever acts on "have I
// been there or not", and a chart with three marks to learn is a chart you read
// instead of glance at.
export function contactLevel(game, b) {
  if (b.hidden) return 'null';
  if (b.chartKey && game.charted && game.charted[b.chartKey]) return 'charted';
  return 'unknown';
}

// Do we have a sensor FIX on this body — i.e. is its plotted position the truth
// rather than a guess? This is not a third tier and it never changes a mark's
// look beyond how tight the bloom is: an unexplored world is unexplored whether
// or not the scan has swept it. It exists because the ROUTE needs it. A stop
// pinned to an unexplored world tracks its plotted position, and that guess can
// sit up to 3,400 units off the truth — further than the world's own arrival
// radius — so a route flown to a pure guess would land you in empty space with
// the stop never popping and the world never charting. The scan reaches 2,600
// units, comfortably outside that radius, so tying the collapse to `b.seen`
// means the fix always lands before you arrive.
export function hasFix(game, b) {
  return !!b.seen || contactLevel(game, b) === 'charted';
}

// Does this contact get a mark at all? The `unknown` tier is deliberately
// narrow: only WORLDS and (via the field pass) SHOALS are plotted before you
// have found them. Everything else — moons, installations, nests, comets, the
// barge — appears the moment the scan picks it up and not a second before.
//
// The reason is that an unknown mark carries no information beyond "something
// is roughly there", and 59 moons' worth of that is not a chart, it is fog with
// dots in it. Worlds and shoals are the things you set out toward; the rest is
// what you find when you get there, which is the whole shape of the discovery
// layer. ONE predicate, shared by the draw and the hit test, so the chart can
// never show a mark that cannot be clicked or answer a click on a mark that was
// never drawn.
export function plottable(game, b) {
  const lvl = contactLevel(game, b);
  if (lvl === 'null') return false;
  if (lvl === 'unknown') return b.type === 'planet' || b.type === 'rogue';
  // A MOON IS ITS HOST'S. Nothing hangs off a world you have not found yet, no
  // matter what the fog scan happened to catch on the way past — a family of
  // pips orbiting an unexplored bloom claims you know the system's shape while
  // still refusing to name the world at the middle of it, which is the one
  // thing the ladder must never do. Charting the world is what reveals its
  // household.
  if (b.type === 'moon' && b.parent) {
    const host = contactLevel(game, b.parent);
    if (host === 'unknown' || host === 'null') return false;
  }
  return true;
}

// mulberry32's mixing step, used as a plain integer hash. Two draws off one id
// give a stable direction and a stable magnitude for a body's plotted guess.
function hash01(n) {
  let t = (n + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// How far off an UNCHARTED plot may be, in world units. Scaled off the body's
// distance from the sun — a guess about the outer band is worth less than a
// guess about the inner system — and floored so a mark near the star is still
// visibly a guess rather than a pin.
export function ghostUnc(b) {
  return clamp(Math.hypot(b.x, b.y) * 0.03, 650, 3400);
}

// The plotted offset of an unknown contact: the same vector every frame, and
// exactly zero the moment the body is identified. Writes into `out` — this runs
// per contact per frame inside the draw.
const _off = { x: 0, y: 0 };
export function ghostOff(game, b, out = _off) {
  if (hasFix(game, b)) { out.x = 0; out.y = 0; return out; }
  const a = hash01(b.id) * TAU;
  const k = 0.35 + 0.65 * hash01(b.id + 9973);   // never dead-centre, never at the rim
  const u = ghostUnc(b) * k;
  out.x = Math.cos(a) * u; out.y = Math.sin(a) * u;
  return out;
}

// Where the chart DRAWS a body — true position once identified, the guess until
// then. Everything that points at a contact (the chart, the route, the radar's
// waypoint marker) goes through this one function, so they can never disagree.
export function contactPos(game, b, out = { x: 0, y: 0 }) {
  const o = ghostOff(game, b, _off);
  out.x = b.x + o.x; out.y = b.y + o.y;
  return out;
}

// The name a contact is allowed to give. NAMES ARE EARNED: reading the
// nameplate is what charts a body (world.js's chart scan), so a contact the fog
// scan merely found reports its class and nothing else. The ladder is the whole
// point of exploring, and leaking a name here would pay the survey XP's reward
// without the flight.
//
// Used by the readout strip and the journey rail — NOT by the chart's marks:
// moons draw as icons only (see drawStarMap), because moons carry no individual
// names in this game and a zoomed-in family printed four identical MOON OF
// OSSIA labels in a ring around a disc already labelled OSSIA.
export function contactLabel(game, b) {
  const lvl = contactLevel(game, b);
  // Plain words. This said "UNCHARTED RETURN" — a "return" is radar jargon for
  // an echo, which is precise, wrong for a CHART (a chart carries plots, not
  // returns), and meaningless to anyone who has not worked a radar. It is also
  // only ever a world now (see plottable), so it can just say so.
  if (lvl === 'unknown') return 'UNEXPLORED WORLD';
  if (b.name) return b.name.toUpperCase();
  if (b.type === 'nest') return 'ALIEN NEST';
  if (b.type === 'station') return 'DERELICT STATION';
  if (b.type === 'moon') {
    return b.parent && b.parent.name ? `MOON OF ${b.parent.name.toUpperCase()}` : 'MOON';
  }
  return b.type.toUpperCase();
}

// The one-line description under a contact's name in the chart's readout. It
// tracks the ladder too: an unvisited contact reports its CLASS, and a world's
// archetype (the thing that decides what it does to you) is knowledge you only
// get from the nameplate, which is exactly what charting it buys.
export function contactClass(game, b) {
  const lvl = contactLevel(game, b);
  if (lvl === 'unknown') {
    return 'A world nobody has been to. Its position here is a rough estimate — fly out and look.';
  }
  if (b.type === 'star') return 'The system primary. Everything here orbits it.';
  if (b.tinker) return 'The Tinker Barge — the system\'s one crewed trader.';
  if (b.ghost) return 'A derelict hulk, running a repeating signal.';
  if (b.type === 'nest') return 'An alien nest. It breeds hostiles until it is destroyed.';
  if (b.type === 'station') return 'A derelict installation. Rich salvage, and a rescue dock.';
  if (b.visitor) return 'An interstellar object, crossing once and never returning.';
  if (b.comet) return 'A comet on a long fall toward the star.';
  if (b.type === 'moon') {
    const host = b.parent && b.parent.name ? ` of ${b.parent.name}` : '';
    return `${b.fort ? 'A fortified moon' : 'A moon'}${host}.`;
  }
  if (b.dark) return 'A cold dwarf star, far out in the dark.';
  const kind = b.gasKind === 'azure' ? 'ICE GIANT' : PTYPE_LABELS[b.ptype] || 'WORLD';
  return `${kind.charAt(0) + kind.slice(1).toLowerCase()}${b.ring ? ', ringed' : ''}${b.fort ? ' — Bastion fortress' : ''}.`;
}

// A free point on the chart names itself by where it is: bearing from the sun
// and range in thousands. A waypoint in open space still has to be findable in
// a list of eight.
export function pointLabel(x, y) {
  const brg = Math.round(((Math.atan2(y, x) * 180 / Math.PI) + 450) % 360);
  const rng = Math.hypot(x, y) / 1000;
  return `BEARING ${String(brg).padStart(3, '0')}° · ${rng.toFixed(1)}k`;
}

// ---------------------------------------------------------------------------
// Picking. Screen-space radii throughout: at the fit scale a whole planet is
// under a pixel across, so a world-space hit test would make the chart
// unclickable exactly where it is most useful.
// ---------------------------------------------------------------------------
const PICK_PX = 11;          // grab radius around a contact's mark
const PICK_WP_PX = 14;       // ...and around an existing waypoint (it wins ties)

export function chartPick(game, sx, sy, vw, vh) {
  const s = chartScale(vw, vh);
  const toX = (wx) => vw / 2 + (wx - chart.cx) * s;
  const toY = (wy) => vh / 2 + (wy - chart.cy) * s;
  let best = null, bestD2 = Infinity;

  // 1. Waypoints first, and by a wider radius: clicking one REMOVES it, and a
  //    stop you cannot get rid of because the contact under it keeps winning
  //    the hit test is worse than a slightly greedy target.
  const route = game.route || [];
  for (let i = 0; i < route.length; i++) {
    const p = waypointPos(game, route[i]);
    const dx = toX(p.x) - sx, dy = toY(p.y) - sy;
    const d2 = dx * dx + dy * dy;
    if (d2 < PICK_WP_PX * PICK_WP_PX && d2 < bestD2) {
      best = { kind: 'waypoint', i, x: p.x, y: p.y }; bestD2 = d2;
    }
  }
  if (best) return best;

  // 2. Contacts, by their DRAWN position (the guess, for an unknown one) — you
  //    can only click what you can see.
  for (const b of frameReg(game).nonField) {
    if (!isContact(b) || !plottable(game, b)) continue;
    const p = contactPos(game, b);
    const dx = toX(p.x) - sx, dy = toY(p.y) - sy;
    const d2 = dx * dx + dy * dy;
    // A big charted world takes its whole disc, so a zoomed-in chart lets you
    // click the planet rather than hunting for its centre.
    const rr = Math.max(PICK_PX, b.radius * s);
    if (d2 < rr * rr && d2 < bestD2) { best = { kind: 'body', b, x: p.x, y: p.y }; bestD2 = d2; }
  }
  if (best) return best;

  // 3. The sun — the one contact that is never in doubt.
  const sun = frameReg(game).stars.find((b) => b.alive);
  if (sun) {
    const dx = toX(sun.x) - sx, dy = toY(sun.y) - sy;
    const rr = Math.max(PICK_PX, sun.radius * s);
    if (dx * dx + dy * dy < rr * rr) return { kind: 'body', b: sun, x: sun.x, y: sun.y };
  }

  // 4. Dense fields, as regions. Picked by their footprint, not a point.
  for (const f of game.fields || []) {
    const o = fieldOff(f);
    const dx = toX(f.x + o.x) - sx, dy = toY(f.y + o.y) - sy;
    const rr = Math.max(PICK_PX, CFG.FIELD_LEN * 0.9 * s);
    const d2 = dx * dx + dy * dy;
    if (d2 < rr * rr && d2 < bestD2) {
      best = { kind: 'field', field: f, x: f.x + o.x, y: f.y + o.y }; bestD2 = d2;
    }
  }
  if (best) return best;

  // 5. Empty space is a valid destination — "go and look over there" is half of
  //    what a route is for.
  const w = screenToWorld(sx, sy, vw, vh);
  return { kind: 'point', x: w.x, y: w.y };
}

// A dense field gets the same treatment as a body: exact once its anchor has
// been inside sensor range, a stable guess before that.
export function fieldOff(f) {
  if (f.seen) return { x: 0, y: 0 };
  const id = Math.round(f.r);   // fields have no id; their lane radius is unique and stable
  const a = hash01(id) * TAU;
  const u = clamp(f.r * 0.03, 650, 3400) * (0.35 + 0.65 * hash01(id + 9973));
  return { x: Math.cos(a) * u, y: Math.sin(a) * u };
}

// ---------------------------------------------------------------------------
// THE ROUTE — an ordered journey, not a single destination.
//
// A waypoint is PINNED TO ITS BODY wherever there is one, and that is the
// load-bearing decision in this file: everything on this chart is in motion, so
// a stop stored as a pair of coordinates is stale before you have finished
// plotting the next one. It carries a fallback position for the one case a pin
// cannot survive — the body being destroyed — because a stop that silently
// vanishes from the list reads as the route having lost your work.
// ---------------------------------------------------------------------------

export function newRoute() { return []; }

export function addWaypoint(game, pick) {
  const route = game.route;
  if (route.length >= MAX_WAYPOINTS) return 'full';
  if (pick.kind === 'body') {
    if (route.some((w) => w.b === pick.b)) return 'dupe';
    route.push({ b: pick.b, field: null, x: pick.x, y: pick.y, lost: false, known: knownNow(game, pick.b) });
  } else if (pick.kind === 'field') {
    if (route.some((w) => w.field === pick.field)) return 'dupe';
    route.push({ b: null, field: pick.field, x: pick.x, y: pick.y, lost: false, known: !!pick.field.seen });
  } else {
    route.push({ b: null, field: null, x: pick.x, y: pick.y, lost: false, known: true });
  }
  return 'added';
}

export function removeWaypoint(game, i) {
  if (i >= 0 && i < game.route.length) game.route.splice(i, 1);
}
export function clearRoute(game) { game.route.length = 0; }

// A stop is "known" once its position is a FIX rather than a guess — see
// hasFix. Not the same test as the chart's mark, deliberately: the mark asks
// "have you been there", the route asks "do we know where there is".
const knownNow = (game, b) => hasFix(game, b);

// The live position of a stop. Free points are already absolute; pinned ones
// track their body through the same guess the chart plots it at, so the route
// is never MORE precise than the chart that drew it — walk toward an uncharted
// return and you are walking toward the blob, not toward a secret exact fix.
export function waypointPos(game, wp, out = { x: 0, y: 0 }) {
  if (wp.b && wp.b.alive) return contactPos(game, wp.b, out);
  if (wp.field) {
    const o = fieldOff(wp.field);
    out.x = wp.field.x + o.x; out.y = wp.field.y + o.y;
    return out;
  }
  out.x = wp.x; out.y = wp.y;
  return out;
}

export function waypointLabel(game, wp) {
  if (wp.lost) return 'LOST CONTACT';
  if (wp.b) return contactLabel(game, wp.b);
  if (wp.field) return wp.field.seen ? wp.field.name.toUpperCase() : 'UNEXPLORED SHOAL';
  return pointLabel(wp.x, wp.y);
}

// How close counts as ARRIVED. These are world.js's own CHART-SCAN zones, to
// the number: a stop ticks over at the moment the place you flew to names
// itself, which is the only arrival the game already had a definition for.
// Sizing it independently made the two disagree — a moon's stop popped ~200
// units before its nameplate faded up, so the confirmation arrived before the
// thing being confirmed.
//
// The Recon Drone's reach is deliberately NOT included even though the chart
// scan grants it: a drone charts from far off, but ARRIVING has to mean you
// went. Nor does the guess-vs-fix distinction need handling — the fog scan
// reaches at least 2,600 units, wider than any zone here, so an uncharted
// stop's plotted guess has always collapsed to a true fix before you are
// close enough for this test to pass.
export function arriveR(wp) {
  const b = wp.b;
  if (b && b.alive) {
    return b.type === 'planet' ? b.radius * 5 + 600
      : b.type === 'moon' ? b.radius * 5 + 300
      : b.type === 'star' ? b.radius * 2.2 : 1400;
  }
  if (wp.field) return CFG.FIELD_LEN * 0.75;
  return 1600;   // a point in open space names nothing, so it needs a wide target
}

// Per-frame route upkeep: track, resolve, arrive. Called from main.update, so
// it freezes with the sim behind a menu like every other piece of gameplay.
//
// ARRIVAL POPS THE HEAD ONLY. Dropping every stop you happen to pass would be
// forgiving right up until a route doubles back past an earlier stop and eats
// the two you still wanted — a journey is ORDERED, and the predictable version
// is the one you can plan against.
export function updateRoute(game) {
  const route = game.route;
  if (!route || !route.length) return;
  for (let i = 0; i < route.length; i++) {
    const wp = route[i];
    if (wp.b) {
      if (!wp.b.alive) {
        // The pin's last known position becomes a plain point. The stop stays
        // in the list, flagged, so the loss is something you are told about
        // rather than something you notice by counting.
        waypointPos(game, wp, wp);
        wp.b = null; wp.lost = true;
        game.wpLostWarn = true;
      } else if (!wp.known && knownNow(game, wp.b)) {
        // The guess collapses to a fix the moment the scan reaches it — the
        // route sharpens as you explore, which is the reward for flying it.
        // Announced by STOP NUMBER, not by name: a contact that has only just
        // been resolved is still nameless (contactLabel gives it "CONTACT —
        // MOON"), so naming it here would read as a non-answer.
        wp.known = true;
        game.wpResolvedName = String(i + 1);
      }
    } else if (wp.field && !wp.known && wp.field.seen) {
      wp.known = true;
      game.wpResolvedName = String(i + 1);
    }
  }
  const s = game.ship;
  if (!s.alive) return;
  const wp = route[0];
  const p = waypointPos(game, wp);
  const r = arriveR(wp);
  if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 > r * r) return;
  // The label is composed HERE rather than in main's message table because a
  // contact's own label can already contain an em dash ("CONTACT — WORLD"), and
  // a template that adds two more produces a sentence with three of them.
  const name = waypointLabel(game, wp);
  route.shift();
  if (route.length) {
    game.wpReachedName = `${name} · ${route.length} stop${route.length === 1 ? '' : 's'} left`;
  } else {
    game.routeDoneName = name;
  }
}
