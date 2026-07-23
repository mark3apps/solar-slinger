// Tiny synthesized sound effects — no audio assets needed.
let ctx = null;
let master = null;
let thrustGain = null;
let beamGain = null;
let enabled = true;

export function initAudio() {
  if (ctx || !enabled) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    // Looping filtered noise for the engine
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 240;
    thrustGain = ctx.createGain(); thrustGain.gain.value = 0;
    noise.connect(lp); lp.connect(thrustGain); thrustGain.connect(master);
    noise.start();

    // Humming oscillator for the tractor beam
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth'; osc.frequency.value = 55;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine'; osc2.frequency.value = 110.7;
    beamGain = ctx.createGain(); beamGain.gain.value = 0;
    osc.connect(beamGain); osc2.connect(beamGain); beamGain.connect(master);
    osc.start(); osc2.start();
  } catch (e) { enabled = false; }
}

export function setThrust(on) {
  if (!thrustGain) return;
  thrustGain.gain.setTargetAtTime(on ? 0.16 : 0, ctx.currentTime, 0.06);
}

export function setBeam(on) {
  if (!beamGain) return;
  beamGain.gain.setTargetAtTime(on ? 0.05 : 0, ctx.currentTime, 0.05);
}

function blip(freq, dur, type = 'sine', vol = 0.2, slideTo = null) {
  if (!ctx) return;
  try {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch (e) { /* audio is best-effort */ }
}

export function sfxGrab()    { blip(90, 0.25, 'sawtooth', 0.15, 220); }
export function sfxFling()   { blip(500, 0.3, 'square', 0.12, 90); }
export function sfxDrop()    { blip(220, 0.15, 'sine', 0.1, 110); }
export function sfxCollect() { blip(880, 0.09, 'sine', 0.14); blip(1320, 0.14, 'sine', 0.1); }
export function sfxUpgrade() { blip(440, 0.12, 'square', 0.12); blip(660, 0.14, 'square', 0.1); blip(880, 0.2, 'square', 0.1); }
export function sfxHit()     { blip(140, 0.2, 'sawtooth', 0.2, 50); }
export function sfxDenied()  { blip(160, 0.2, 'square', 0.1, 110); }

// Ghost-ship sonar: two soft descending sines, louder the closer you are
export function sfxPing(vol = 0.5) {
  const v = Math.max(0.15, Math.min(1, vol));
  blip(1180, 0.5, 'sine', 0.10 * v, 880);
  blip(590, 0.7, 'sine', 0.05 * v, 560);
}

export function sfxBoom(size = 1) {
  if (!ctx) return;
  try {
    const dur = Math.min(1.4, 0.35 + size * 0.25);
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900 - Math.min(700, size * 150);
    const g = ctx.createGain(); g.gain.value = Math.min(0.6, 0.25 + size * 0.1);
    src.connect(lp); lp.connect(g); g.connect(master);
    src.start();
  } catch (e) { /* best-effort */ }
}
