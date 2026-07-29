import { initAudio } from './sfx.js';

export const input = {
  keys: new Set(),
  mouseX: 0, mouseY: 0,     // screen (CSS px)
  mouseDown: false,
};

export function initInput(canvas, handlers) {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    initAudio();
    input.keys.add(e.code);
    if (e.code === 'Escape' || e.code === 'KeyP') handlers.onMenuKey();
    if (e.code === 'KeyR') handlers.onRespawn();
    if (e.code === 'KeyT') handlers.onTogglePredict();
    // Upgrade-card selection (only acts while the choice modal is open)
    if (e.code === 'Digit1') handlers.onUpgradePick(0);
    if (e.code === 'Digit2') handlers.onUpgradePick(1);
    if (e.code === 'Digit3') handlers.onUpgradePick(2);
    // SCOUT mobility: tap A / D to dart sideways (Dash Jets), F to warp
    // (Slipstream). All no-op unless the ability is owned + off cooldown
    // (main.js gates them).
    if (e.code === 'KeyA') handlers.onDash(-1);
    if (e.code === 'KeyD') handlers.onDash(1);
    if (e.code === 'KeyF') handlers.onWarp();
    if (['KeyW', 'KeyS', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));
  // Missed keyups (focus loss, tab switches, replayed events) must never
  // leave a control stuck on
  window.addEventListener('blur', () => input.keys.clear());
  document.addEventListener('visibilitychange', () => input.keys.clear());

  canvas.addEventListener('mousemove', (e) => {
    input.mouseX = e.clientX;
    input.mouseY = e.clientY;
  });
  canvas.addEventListener('mousedown', (e) => {
    initAudio();
    if (e.button === 0) { input.mouseDown = true; handlers.onGrab(); }
    if (e.button === 2) handlers.onRmbDown();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0 && input.mouseDown) {
      input.mouseDown = false;
      handlers.onFling();
    }
    if (e.button === 2) handlers.onRmbUp();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // No manual zoom: the camera is cinematic-only, pulling back as you level
  canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
}

// W = thrust forward, S = thrust backward. The mouse steers the nose.
export function readControls(game) {
  const k = input.keys;
  game.controls.f = k.has('KeyW') ? 1 : 0;
  game.controls.b = k.has('KeyS') ? 1 : 0;
  game.controls.boost = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1 : 0;   // Afterburner (scout)
}

// Mouse position in world coordinates given the current camera
export function mouseWorld(game, vw, vh) {
  const { cam } = game;
  return {
    x: (input.mouseX - vw / 2) / cam.zoom + cam.x,
    y: (input.mouseY - vh / 2) / cam.zoom + cam.y,
  };
}

