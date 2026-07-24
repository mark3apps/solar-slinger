import { TAU } from './util.js';

// BELT SHOALS — bioluminescent drifters, pure living-world flavor. No mass, no
// collisions, no scrap: they never touch the sim. They flee the ship's thrust
// (and its bulk up close), drift on gentle currents, and creep toward a lit
// tractor beam out of curiosity. Kept as a small pool near the player and
// culled once left far behind, exactly like the view-local asteroid field.
// Cosmetic, so this runs on dtReal (main.js), never inside the fixed step.
export function updateCritters(game, dt) {
  const cr = game.critters;
  const s = game.ship;
  const viewR = game.viewR || 1000;

  for (let i = cr.length - 1; i >= 0; i--) {
    if (Math.hypot(cr[i].x - s.x, cr[i].y - s.y) > viewR * 2.3) cr.splice(i, 1);
  }
  const target = s.alive ? 26 : 0;
  while (cr.length < target) {
    const th = Math.random() * TAU;
    const d = viewR * (0.55 + Math.random() * 0.95);
    cr.push({
      x: s.x + Math.cos(th) * d, y: s.y + Math.sin(th) * d, vx: 0, vy: 0,
      ph: Math.random() * TAU, sz: 0.7 + Math.random() * 1.0, hue: 155 + Math.random() * 90,
    });
  }

  const beamOn = !!game.held;
  const thrusting = s.thrusting || s.braking;
  for (const c of cr) {
    c.ph += dt * (1.4 + c.sz);
    // gentle idle wander
    let ax = Math.cos(c.ph * 0.7 + c.hue) * 7, ay = Math.sin(c.ph * 0.9) * 7;
    const dx = c.x - s.x, dy = c.y - s.y;
    const d = Math.hypot(dx, dy) || 1;
    // flee the ship — hard when it's under thrust, a soft avoidance otherwise
    if (d < 440) {
      const f = (1 - d / 440) * (thrusting ? 320 : 90);
      ax += (dx / d) * f; ay += (dy / d) * f;
    }
    // ...but a lit beam draws them in from a bit farther out
    if (beamOn && d < 900 && d > 130) { ax -= (dx / d) * 46; ay -= (dy / d) * 46; }
    c.vx = (c.vx + ax * dt) * 0.93;
    c.vy = (c.vy + ay * dt) * 0.93;
    const sp = Math.hypot(c.vx, c.vy);
    if (sp > 240) { c.vx *= 240 / sp; c.vy *= 240 / sp; }
    c.x += c.vx * dt; c.y += c.vy * dt;
  }
}
