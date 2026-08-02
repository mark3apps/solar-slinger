// ---------------------------------------------------------------------------
// GRAVEL — the structure-of-arrays store for the thousands of small rocks.
//
// WHY THIS EXISTS, in one measurement. A candidate pair visit in the collision
// scan cost 44.8ns against an arithmetic cost of 2-3ns; the gap was cache
// misses, because a `Body` carries ~50 fields and two rocks adjacent in the
// sweep are nowhere near each other in the heap. Moving just the four fields
// the scan reads into typed arrays took that to 20.9ns (physics.js, THE SWEEP
// SIDE-TABLE). The same shape measured on the integration loop is 4.2x, and on
// a pure arithmetic kernel 15x. The lever is DATA LAYOUT, not algorithms — a
// uniform collision grid cut candidate pairs 3.6x and won nothing, because it
// chased the same cold pointers.
//
// A side-table only pays where a body is read MANY times per frame (the scan
// reads each ~19 times, so one scattered read replaces nineteen). Integration
// touches each body ONCE, so mirroring in and out costs as much as it saves.
// That is why this is a STORE and not another side-table: the data has to LIVE
// here.
//
// WHAT IS GRAVEL. A rock that is numerous and individually anonymous. What is
// NOT gravel: anything the player can name, aim at, or be told about — worlds,
// moons, stations, big rock, quest objects. Those stay `Body`, where the
// per-body cost is irrelevant because there are only a few hundred of them.
// Measured in a shoal cascade, 1,879 of 1,981 awake bodies are anonymous rock.
//
// PROMOTION IS THE CONTRACT. "The crater you see is the crater you can fly
// into" is a design law, and gravel that could never be grabbed would break it.
// A gravel rock becomes a real `Body` the moment it stops being anonymous —
// the beam reaches for it, or it grows past the size threshold. Promotion is
// the reason gravel may be cheap: it is not a different KIND of rock, it is the
// same rock in a cheaper representation until the player touches it.
//
// SLOTS ARE STABLE AND REUSED. An index is a handle: `spawn` returns one, it
// stays valid until `kill`, and a killed slot goes on the free list for the
// next spawn. Nothing here ever compacts or reorders, because a moving index
// would invalidate every handle held elsewhere (a beam target, a promotion in
// flight, a render batch mid-build). Iterate with the ALIVE flag, never by
// assuming the live set is contiguous.
// ---------------------------------------------------------------------------

// FIXED CAPACITY, allocated once, and this is a SharedArrayBuffer decision.
//
// The store used to grow in steps. Growth is incompatible with handing the
// arrays to a worker: the moment they are reallocated the worker is holding
// views onto a dead buffer, and every grow would need a re-post plus a barrier
// to make sure the worker is not mid-pass on the old one. A fixed ceiling
// removes the whole class of problem, and the cost is one allocation of ~4MB
// that a cascade will actually use — measured 12,323 grains from a single
// bombardment at CFG.GRAVEL_SPRAY_MUL 10.
//
// `spawn` returns -1 when full rather than growing. The store has no population
// policy of its own (the debris budget and the field caps live with their
// owners), so a full store is the caller's problem, exactly as debrisRoom is.
export const MAX_SLOTS = 65536;

// THE SIZE CUT. Anything drawn bigger than this is not anonymous — the player
// tracks it, aims at it, and expects to grab it — so it stays a `Body`. It is
// pinned to the shard atlas's own bucket ceiling (render.SHARD_BUCKET_MAX ends
// at 14): a grain past that has no baked sprite and would fall through to the
// vector path it cannot reach from here. Keep the two numbers together.
export const GRAVEL_R_MAX = 14;

export const FLAG_ALIVE = 1;
export const FLAG_ICE = 2;
export const FLAG_CORED = 4;

// PALETTE. A grain stores a Uint8 INDEX, not a colour string — same reason
// every other field here is a typed array, and it lets the renderer keep a
// pre-parsed tint triple per entry instead of parsing '#rrggbb' per grain per
// frame. The entries are the materials config.worldDebris actually produces
// plus the plain belt tones; `tintIndexFor` falls back to belt grey, so an
// unlisted colour degrades to a plausible rock rather than throwing.
export const PALETTE = [
  '#8d8577', '#a3765c', '#cfe6f2', '#bfe3f2', '#8a4a30',
  '#5c453e', '#42352f', '#9d86c9', '#7a6ba3', '#93a6bc',
];
const paletteIndex = new Map(PALETTE.map((c, i) => [c, i]));
export function tintIndexFor(color) {
  const i = paletteIndex.get(color);
  return i === undefined ? 0 : i;
}
// NOTE there is deliberately no FLAG_INERT. The inert window (CFG.CHUNK_INERT —
// a fresh fragment passes through other debris, which is one of invariant 7b's
// three brakes on the split cascade) is expressed ONLY by the `inertT` timer,
// and `isInert` reads that. A flag beside the timer is two sources of truth for
// one fact, and they disagreed on the very first self-test: spawn took the flag
// and never set the timer, so the piece was permanently inert.

// Positions are Float64: world coordinates reach ~1e5 and the collision compares
// must agree with the f64 arithmetic the Body path does, or a pair is pruned in
// one place and overlapping in the other. Everything else is Float32 — a radius
// or an hp value has nowhere near that dynamic range, and halving those arrays
// is halving the cache traffic that this whole module exists to reduce.
// ONE BUFFER, shared when the host allows it. Cross-origin isolation
// (COOP/COEP — serve.py, electron/main.js and the run-solar-slinger driver all
// send the pair) is what makes SharedArrayBuffer exist at all; without it the
// constructor is undefined and this falls back to a plain ArrayBuffer, the
// worker is never started, and the gravel pass runs on the main thread exactly
// as it did before. Same contract as rockgl.js: every capability is fallible,
// and the fallback is the path that always worked.
const SHARED = typeof SharedArrayBuffer !== 'undefined';
const BYTES = MAX_SLOTS * (8 * 4 + 4 * 6 + 4);   // f64 x4, f32 x6, u8 x3 (padded to 4)
export const buffer = SHARED ? new SharedArrayBuffer(BYTES) : new ArrayBuffer(BYTES);
export const isShared = SHARED;

let off = 0;
const f64 = () => { const a = new Float64Array(buffer, off, MAX_SLOTS); off += MAX_SLOTS * 8; return a; };
const f32 = () => { const a = new Float32Array(buffer, off, MAX_SLOTS); off += MAX_SLOTS * 4; return a; };
const u8 = () => { const a = new Uint8Array(buffer, off, MAX_SLOTS); off += MAX_SLOTS; return a; };

const cap = MAX_SLOTS;
export const x = f64();
export const y = f64();
export const vx = f64();
export const vy = f64();
export const radius = f32();
export const mass = f32();
export const hp = f32();
export const rot = f32();
export const spin = f32();
export const inertT = f32();
export const arch = u8();      // shard archetype (render.SHARD_ARCHS)
export const tint = u8();      // palette index, not a colour string
export const flags = u8();
// Byte offsets, so the worker can rebuild identical views over the same buffer
// without duplicating the layout arithmetic — one source of truth for where
// each field lives.
export const LAYOUT = {
  slots: MAX_SLOTS,
  x: x.byteOffset, y: y.byteOffset, vx: vx.byteOffset, vy: vy.byteOffset,
  radius: radius.byteOffset, mass: mass.byteOffset, hp: hp.byteOffset,
  rot: rot.byteOffset, spin: spin.byteOffset, inertT: inertT.byteOffset,
  arch: arch.byteOffset, tint: tint.byteOffset, flags: flags.byteOffset,
};

// ---------------------------------------------------------------------------
// THE WORKER HANDSHAKE
//
// A tiny second shared buffer carries the control word and the per-substep
// parameters, so a dispatch costs two stores and a notify rather than a
// postMessage (which would copy, and which the fixed step cannot afford twice
// a frame).
//
// STATE: 0 idle, 1 work posted, 2 done. The worker blocks on Atomics.wait; the
// MAIN THREAD MUST NOT — Atomics.wait throws on the main thread in browsers, by
// design, because blocking the UI thread is exactly what it is there to
// prevent. The join therefore SPINS, which is affordable only because of the
// asymmetry it is built on: gravel is ~2ms of work dispatched at the top of a
// substep that then spends ~25ms on Body physics, so by the time anything reads
// gravel the worker has long finished and the spin does zero iterations. The
// spin is bounded anyway (see gravelJoin) and falls back to doing the pass
// inline, because a capability that can hang is not a capability.
export const CTRL_IDLE = 0, CTRL_WORK = 1, CTRL_DONE = 2;
const CTRL_INTS = 4;                 // [state, top, attractorCount, spare]
const MAX_ATT = 256;                 // attractors: x, y, mass, cullR2
const PARAM_F64 = 1 + MAX_ATT * 4;   // [dt, ...attractors]
const ctrlBytes = CTRL_INTS * 4 + PARAM_F64 * 8;
export const ctrlBuffer = SHARED ? new SharedArrayBuffer(ctrlBytes) : new ArrayBuffer(ctrlBytes);
export const ctrl = new Int32Array(ctrlBuffer, 0, CTRL_INTS);
export const params = new Float64Array(ctrlBuffer, CTRL_INTS * 4, PARAM_F64);
export const MAX_ATTRACTORS = MAX_ATT;

// `top` is the high-water mark, NOT the live count: slots below it may be dead.
// Every loop here runs to `top` and tests FLAG_ALIVE. Exported so the hot loops
// in physics/render can bound themselves without a function call.
export let top = 0;
let liveN = 0;
const freeList = [];

export function count() { return liveN; }
export function capacity() { return cap; }

// Returns a slot index, or -1 when the store is FULL. Callers may ignore the
// -1 (a grain that did not spawn is simply one fewer grain), but they must not
// index with it. The store has no population policy of its own —
// CFG.DEBRIS_BUDGET and the field caps live with their owners, as for Body.
export function spawn(px, py, pvx, pvy, r, m, archIdx, tintIdx, hpv, flagBits, inert) {
  let i;
  if (freeList.length) i = freeList.pop();
  else {
    if (top >= cap) return -1;   // full — the caller owns the population policy
    i = top++;
  }
  x[i] = px; y[i] = py; vx[i] = pvx; vy[i] = pvy;
  radius[i] = r; mass[i] = m; hp[i] = hpv;
  rot[i] = 0; spin[i] = 0; inertT[i] = inert || 0;
  arch[i] = archIdx; tint[i] = tintIdx;
  flags[i] = FLAG_ALIVE | (flagBits || 0);
  liveN++;
  return i;
}

export function isInert(i) { return inertT[i] > 0; }

export function kill(i) {
  if (!(flags[i] & FLAG_ALIVE)) return;
  flags[i] = 0;
  liveN--;
  freeList.push(i);
  // `top` is deliberately NOT walked back when the tail dies. Shrinking it
  // would be correct only if the tail slot were the last live one, and testing
  // that is a scan; the ALIVE test in every loop already costs one byte read.
}

export function alive(i) { return (flags[i] & FLAG_ALIVE) !== 0; }

// Drop everything. Called on world regen, for the same reason the awake list,
// the registries, the attractor shortlists and the packed halos are dropped
// there: stale state that outlives its world is the recurring bug in this file's
// neighbourhood.
export function reset() {
  flags.fill(0, 0, top);
  freeList.length = 0;
  top = 0;
  liveN = 0;
}

// Semi-implicit Euler over the whole store, in one contiguous pass. No gravity
// term: gravel is anonymous rock and anonymous rock is never an attractor, and
// the attractor shortlist made the pull itself 1.4% of sim — so the caller
// supplies acceleration only when it has one, rather than this loop reading two
// more arrays it would almost always find zero in.
export function integrate(dt) {
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    rot[i] += spin[i] * dt;
    if (inertT[i] > 0) inertT[i] -= dt;
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
}

// Retire anything that has left the world or drifted off the player's leash.
// Mirrors the Body leash (CFG.DEBRIS_LEASH / world.replenishWorld): loose rubble
// nobody will look at again is scenery, and scenery has a range.
export function cull(cx, cy, leash, worldR) {
  const l2 = leash * leash, w2 = worldR * worldR;
  let removed = 0;
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    const px = x[i], py = y[i];
    if (px * px + py * py > w2 || (px - cx) ** 2 + (py - cy) ** 2 > l2) { kill(i); removed++; }
  }
  return removed;
}

// Diagnostic readout, in the shape of render's rockPathStats / physics'
// broad-phase counters.
export function gravelStats() {
  // Must match the BYTES calculation the buffer was allocated with — the three
  // u8 fields are padded to 4, and reporting the unpadded 3 made the diagnostic
  // under-report by one byte per slot.
  return { live: liveN, top, capacity: cap, freeSlots: freeList.length,
           bytes: buffer.byteLength };
}
