// ---------------------------------------------------------------------------
// THE GRAVEL WORKER — the debris sim, on another core.
//
// This is the ONLY part of the simulation that can leave the main thread today,
// and the reason is that gravel already satisfies the two conditions: its state
// lives in a SharedArrayBuffer rather than in an object graph, and its update is
// a pure function of (grain state, attractor snapshot, dt) that touches no
// `game` object, no DOM and no canvas.
//
// WHAT IT DOES *NOT* DO, deliberately: gravel-vs-ship, -alien and -celestial.
// Those read live game state and can damage the ship, so they stay on the main
// thread (physics.collideGravel). This worker advances grains — gravity, the
// world edge, the inert timer, the integrate — and resolves grain-on-grain
// contact.
//
// IT MIRRORS physics.stepGravel EXACTLY, and that is enforced structurally
// rather than by discipline: the motion loop below and stepGravel's are the
// same arithmetic, and CONTACT IS A SHARED MODULE (gravel-contact.js) both call.
// It used to be implemented only here, which meant a machine without
// SharedArrayBuffer ran a game where debris did not carom — physics depending on
// a host capability, which is the one thing the fallible-capability rule exists
// to prevent. If you change the motion rules in one, change them in both.
//
// The blocking Atomics.wait here is correct and is the point: a worker thread
// parked in wait() costs nothing, and it wakes on the notify from the dispatch.
// The main thread does the opposite (it spins briefly) because Atomics.wait
// throws on the main thread by design.
// ---------------------------------------------------------------------------

const CTRL_IDLE = 0, CTRL_WORK = 1, CTRL_DONE = 2;
const FLAG_ALIVE = 1;

let x, y, vx, vy, radius, mass, rot, spin, inertT, flags;
let ctrl, params;
let worldR2 = 0, G = 8, soft2 = 1600;

import { collideGrains, makeContactScratch } from './gravel-contact.js';

// Contact scratch is per-thread: the worker gets its own grid arrays so nothing
// mutable is shared with the main thread's copy.
const contactScratch = makeContactScratch();
let grains = null;   // the {x, y, ...} bundle gravel-contact operates on

self.onmessage = (e) => {
  const d = e.data;
  if (d.type !== 'init') return;
  const L = d.layout, b = d.buffer, n = L.slots;
  x = new Float64Array(b, L.x, n);
  y = new Float64Array(b, L.y, n);
  vx = new Float64Array(b, L.vx, n);
  vy = new Float64Array(b, L.vy, n);
  radius = new Float32Array(b, L.radius, n);
  mass = new Float32Array(b, L.mass, n);
  rot = new Float32Array(b, L.rot, n);
  spin = new Float32Array(b, L.spin, n);
  inertT = new Float32Array(b, L.inertT, n);
  flags = new Uint8Array(b, L.flags, n);
  grains = { x, y, vx, vy, radius, mass, inertT, flags };
  ctrl = new Int32Array(d.ctrlBuffer, 0, 4);
  params = new Float64Array(d.ctrlBuffer, 16, d.paramLen);
  worldR2 = d.worldR * d.worldR;
  G = d.G;
  soft2 = d.gravSoft * d.gravSoft;
  self.postMessage({ type: 'ready' });
  loop();
};

function loop() {
  for (;;) {
    // Park until the main thread posts work. A timeout is not needed: the only
    // way out of a run is a dispatch, and a dead main thread means a dead page.
    Atomics.wait(ctrl, 0, CTRL_IDLE);
    if (Atomics.load(ctrl, 0) !== CTRL_WORK) continue;   // spurious wake
    run();
    Atomics.store(ctrl, 0, CTRL_DONE);
    Atomics.notify(ctrl, 0);
  }
}

function run() {
  const top = Atomics.load(ctrl, 1);
  const attN = Atomics.load(ctrl, 2);
  const dt = params[0];
  for (let i = 0; i < top; i++) {
    if (!(flags[i] & FLAG_ALIVE)) continue;
    const px = x[i], py = y[i];
    let ax = 0, ay = 0;
    // Attractors arrive as a flat [x, y, mass, cullR2] quad per entry — the
    // shared shortlist physics built for the whole wake bubble, with the
    // per-grain cutoff still applied here so the answer matches gravityAt.
    for (let k = 0, o = 1; k < attN; k++, o += 4) {
      const dx = params[o] - px, dy = params[o + 1] - py;
      const d2 = dx * dx + dy * dy + soft2;
      if (d2 > params[o + 3]) continue;
      const inv = (G * params[o + 2]) / (d2 * Math.sqrt(d2));
      ax += dx * inv; ay += dy * inv;
    }
    // The world edge — gravel is never star-anchored, so it always applies.
    const r2 = px * px + py * py;
    if (r2 > worldR2) {
      const d = Math.sqrt(r2);
      const over = (d - Math.sqrt(worldR2)) / 1000;
      const k2 = 25 * (1 + over * over);
      ax += (-px / d) * k2; ay += (-py / d) * k2;
    }
    vx[i] += ax * dt; vy[i] += ay * dt;
    rot[i] += spin[i] * dt;
    if (inertT[i] > 0) inertT[i] -= dt;
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
  collideGrains(grains, top, contactScratch);
}
