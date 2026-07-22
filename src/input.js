import { clamp } from './util.js';
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
    if (e.code === 'KeyE') handlers.onToggleUpgrades();
    if (e.code === 'KeyP') handlers.onTogglePause();
    if (e.code === 'KeyR') handlers.onRespawn();
    if (e.code === 'KeyT') handlers.onTogglePredict();
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));
  window.addEventListener('blur', () => input.keys.clear());

  canvas.addEventListener('mousemove', (e) => {
    input.mouseX = e.clientX;
    input.mouseY = e.clientY;
  });
  canvas.addEventListener('mousedown', (e) => {
    initAudio();
    if (e.button === 0) { input.mouseDown = true; handlers.onGrab(); }
    if (e.button === 2) handlers.onDrop();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0 && input.mouseDown) {
      input.mouseDown = false;
      handlers.onFling();
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    handlers.onZoom(e.deltaY);
  }, { passive: false });
}

// W = thrust forward, S = brake, A/D = turn. Mouse aims the beam only.
export function readControls(game) {
  const k = input.keys;
  game.controls.f = k.has('KeyW') ? 1 : 0;
  game.controls.b = k.has('KeyS') ? 1 : 0;
  game.controls.l = k.has('KeyA') ? 1 : 0;
  game.controls.r = k.has('KeyD') ? 1 : 0;
}

// Mouse position in world coordinates given the current camera
export function mouseWorld(game, vw, vh) {
  const { cam } = game;
  return {
    x: (input.mouseX - vw / 2) / cam.zoom + cam.x,
    y: (input.mouseY - vh / 2) / cam.zoom + cam.y,
  };
}

export function zoomBy(game, deltaY) {
  game.cam.zoom = clamp(game.cam.zoom * Math.exp(-deltaY * 0.0011), 0.12, 2.2);
}
