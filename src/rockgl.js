// ---------------------------------------------------------------------------
// INSTANCED ROCK RENDERER (WebGL2)
//
// The sprite atlas in render.js already reduced a rock to "one blit from one
// sheet". This takes the last step: a shoal's ~1900 blits become ONE
// instanced draw call per sheet. Canvas2D has to walk the display list and
// build a transform per drawImage; the GPU wants exactly what the atlas
// already produces — one texture, one quad, a transform per instance.
//
// IT DRAWS TO ITS OWN CANVAS AND IS COMPOSITED BACK INTO THE 2D CONTEXT.
// A canvas has ONE context type for life, so the world canvas cannot be both.
// Layering a second canvas in the DOM was rejected: rocks sit in the MIDDLE of
// the draw order (after the prediction paths, before glow/particles/ship), and
// a stacked canvas can only be entirely above or entirely below the other.
// Compositing costs one full-screen drawImage, which is why the caller only
// engages this path past a batch size that pays for it (see GL_MIN in
// render.js) and falls back to per-rock 2D blits below that.
//
// PREMULTIPLIED END TO END, AND IT IS MULTIPLIED EXACTLY ONCE. The atlas is a
// Canvas2D sheet, so its backing store is ALREADY premultiplied; the context
// is created premultipliedAlpha:true and blends ONE / ONE_MINUS_SRC_ALPHA,
// which also wants premultiplied source. So the texture is uploaded as-is
// (UNPACK_PREMULTIPLY_ALPHA_WEBGL false — do not "fix" this to true) and the
// shader passes it straight through.
//
// The first cut multiplied by alpha in the shader as well, on the assumption
// that the texture was straight. That squares alpha on every partially
// transparent texel — which on a jagged antialiased sprite is most of its
// EDGE — and the whole shoal rendered visibly dimmer: total rock ink measured
// at 0.65-0.95 of the 2D path's across a zoom sweep. If the sprites ever look
// dim or dark-fringed against the starfield, this pair is the first thing to
// check. The regression test is a same-frame A/B: forceRockPath('2d') vs
// ('gl') and compare total ink (it should sit within a couple of percent).
//
// EVERY ENTRY POINT IS FALLIBLE BY DESIGN. src/ must run identically under
// serve.py and inside Electron and must never assume a capability: if WebGL2
// is missing, the context is lost, or a shader fails to compile, `dead`
// latches and render.js keeps using the 2D blit path it has always had. There
// is no visual difference between the two — only how many draw calls it took.
// ---------------------------------------------------------------------------

const VERT = `#version 300 es
layout(location=0) in vec2 aCorner;   // unit quad corner, -0.5..0.5
layout(location=1) in vec2 aPos;      // world position of the rock
layout(location=2) in float aRot;     // rock rotation (radians)
layout(location=3) in float aHalf;    // half the drawn width, in world units
layout(location=4) in vec2 aUV;       // top-left of this rock's atlas cell
layout(location=5) in vec3 aTint;     // per-instance multiply tint (1,1,1 = as baked)
uniform vec3 uXf;        // world->device: k, e, f (render.js's wt)
uniform vec2 uViewport;  // device pixels
uniform vec2 uCell;      // atlas cell size in UV
out vec2 vUV;
out vec3 vTint;
void main() {
  vTint = aTint;
  // Same composition as the 2D path's setTransform(cs, sn, -sn, cs, ...):
  // a CCW rotation in a y-DOWN frame, then the uniform world scale+translate.
  float c = cos(aRot), s = sin(aRot);
  vec2 l = aCorner * (aHalf * 2.0);
  vec2 w = aPos + vec2(l.x * c - l.y * s, l.x * s + l.y * c);
  vec2 d = vec2(uXf.x * w.x + uXf.y, uXf.x * w.y + uXf.z);
  gl_Position = vec4(d.x / uViewport.x * 2.0 - 1.0, 1.0 - d.y / uViewport.y * 2.0, 0.0, 1.0);
  // v increases downward, matching the un-flipped canvas upload (row 0 -> t=0)
  vUV = aUV + (aCorner + 0.5) * uCell;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec3 vTint;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  // The texture arrives ALREADY PREMULTIPLIED (it is uploaded from a Canvas2D
  // sheet, whose backing store is premultiplied), and the blend below expects
  // premultiplied source — so this passes it straight through. Multiplying by
  // alpha here as well squares it on every partially-transparent texel, which
  // on a jagged antialiased sprite means most of its EDGE: measured at 0.65-0.95
  // of the 2D path's total rock ink, i.e. a visibly dimmer shoal.
  //
  // THE TINT IS A MULTIPLY, and it is correct on premultiplied source without
  // touching alpha: premultiplied rgb is (colour x a), so (colour x a) x tint
  // is the premultiplied form of (colour x tint). Scaling alpha too would
  // square it, which is the same double-premultiply bug described above.
  // Rock instances pass 1,1,1 and are bit-identical to the untinted path; the
  // CHUNK family is baked neutral once and tinted to its host world's material
  // here, which is what keeps a per-world debris colour from costing a whole
  // atlas row each (see render.js's shard bake).
  outColor = texture(uTex, vUV) * vec4(vTint, 1.0);
}`;

const FLOATS = 9;      // x, y, rot, half, u0, v0, tint r, g, b
const CAP = 16384;     // instances per batch before it flushes early

let cv = null, gl = null, prog = null, vao = null, instBuf = null;
let uXf = null, uViewport = null, uCell = null;
let dead = false;
let pendingTexReset = false;   // atlas reset, applied at the next frame start
// Atlas sheet -> { tex, ver }. A STRONG Map on purpose: a WeakMap would drop
// the entry when the atlas discards a sheet but leave the GL texture itself
// allocated, and only deleteTexture frees GPU memory. Sheets number two to
// four, so holding them costs nothing and rockGLResetTextures can enumerate.
let texes = null;
let batches = [];      // { sh, data: Float32Array, n } — one per live sheet
let drawCalls = 0, lastInstances = 0;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Solar Slinger: rock shader failed —', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

// Bring up the GL canvas. Returns false (permanently) on any platform that
// cannot give us WebGL2 — the caller then keeps its 2D blit path forever.
export function initRockGL(w, h) {
  if (gl) return true;
  if (dead) return false;
  try {
    cv = document.createElement('canvas');
    cv.width = Math.max(1, w); cv.height = Math.max(1, h);
    gl = cv.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false,
      depth: false, stencil: false, preserveDrawingBuffer: false,
    });
    if (!gl) { dead = true; cv = null; return false; }
    // A lost context is recoverable in principle, but a half-drawn frame is
    // not worth the state machine: latch dead and let the 2D path take over.
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); dead = true; gl = null; });

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { dead = true; gl = null; cv = null; return false; }
    prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('Solar Slinger: rock program link failed —', gl.getProgramInfoLog(prog));
      dead = true; gl = null; cv = null; return false;
    }
    uXf = gl.getUniformLocation(prog, 'uXf');
    uViewport = gl.getUniformLocation(prog, 'uViewport');
    uCell = gl.getUniformLocation(prog, 'uCell');

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    // The unit quad: two triangles, shared by every instance.
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CAP * FLOATS * 4, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    const attr = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      gl.vertexAttribDivisor(loc, 1);   // one value per INSTANCE, not per vertex
    };
    attr(1, 2, 0);    // aPos
    attr(2, 1, 8);    // aRot
    attr(3, 1, 12);   // aHalf
    attr(4, 2, 16);   // aUV
    attr(5, 3, 24);   // aTint
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied source
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    texes = new Map();
    return true;
  } catch (err) {
    console.warn('Solar Slinger: WebGL2 rock path unavailable —', err);
    dead = true; gl = null; cv = null;
    return false;
  }
}

export function rockGLAvailable() { return !!gl && !dead; }

// Drop every uploaded sheet. Called when render.js discards the atlas (its
// memory-budget reset) — the sheet objects those textures are keyed to are
// about to become garbage, and deleteTexture is the only thing that returns
// their GPU memory.
//
// DEFERRED TO THE NEXT FRAME, deliberately. The atlas reset fires from
// rockRow, which runs from blitRock, which runs MID-BODY-LOOP — clearing the
// batches there would discard instances already queued this frame, and
// blitRock has told drawBody it handled them, so those rocks would simply be
// missing for a frame. The outgoing sheets stay valid draw sources until then
// (nothing mutates their canvases), so finishing the frame on them is safe.
export function rockGLResetTextures() {
  if (!gl || dead || !texes) return;
  pendingTexReset = true;
}

function flushTexReset() {
  if (!pendingTexReset) return;
  pendingTexReset = false;
  for (const e of texes.values()) gl.deleteTexture(e.tex);
  texes.clear();
  batches = [];
}

export function resizeRockGL(w, h) {
  if (!gl || dead) return;
  cv.width = Math.max(1, w); cv.height = Math.max(1, h);
}

// Upload (or re-upload) a sheet. The atlas grows a row at a time and swaps in
// a fresh canvas each time it does, so the texture is keyed to the sheet's
// content VERSION — a republish that only refreshes the 2D backing store
// (render.js's rot workaround, which GL does not suffer) leaves ver alone and
// costs nothing here.
function texFor(sh) {
  let e = texes.get(sh);
  if (e && e.ver === sh.ver) return e.tex;
  if (!e) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // MIPMAPS, for MINIFICATION QUALITY — not for brightness. (The dimming
    // this was first reached for turned out to be the double-premultiply in
    // the fragment shader; see its note. Mipmaps did not fix that and are not
    // what makes the two paths match — they are here on their own merits.)
    //
    // blitRock picks the smallest sheet TIER at or above the drawn size, so a
    // rock drawn at ~1px legitimately comes off the tier-8 sheet's 20px cells:
    // measured minification runs to 16x. Canvas2D's drawImage area-averages
    // that; GL_LINEAR reads four texels wherever the sample lands, so a shoal
    // of minified sprites would CRAWL as it moved — every rock resampling a
    // different arbitrary texel each frame. Mipmaps make that stable.
    //
    // MAX_LEVEL caps how far the chain may go, because deeper mips blur a cell
    // into its NEIGHBOURS and the cells carry only ~4% transparent margin.
    // Horizontal bleed is benign — a row is one bucket in one colour across 24
    // archetypes, so it mixes a rock with another rock of the same colour —
    // but the chain blurs VERTICALLY too, and rows are (bucket x colour): deep
    // enough, a grey belt rock starts picking up tint from an ice or cored row.
    // Level 2 is the compromise: it covers the common minification and stops
    // short of cross-row contamination. Residual aliasing past it lands only
    // on 2-3px rocks, which is a far better failure than wrong colour.
    // If bakeRow ever grows a transparent gutter between rows, this can go
    // deeper — and if the atlas layout changes, re-check it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 2);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    e = { tex, ver: -1 };
    texes.set(sh, e);
  }
  gl.bindTexture(gl.TEXTURE_2D, e.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sh.cv);
  gl.generateMipmap(gl.TEXTURE_2D);   // see the MIN_FILTER note above
  e.ver = sh.ver;
  return e.tex;
}

// Start a frame. Clears to fully transparent so the composite is a no-op
// everywhere no rock landed.
export function rockGLBegin() {
  if (!gl || dead) return;
  flushTexReset();   // the atlas reset, deferred out of the body loop
  for (const b of batches) b.n = 0;
  drawCalls = 0; lastInstances = 0;
}

// Queue one rock. `sh` is the atlas sheet it blits from; u0/v0 are its cell's
// top-left in UV; half is half the drawn width in WORLD units. tr/tg/tb are the
// multiply tint — 1,1,1 draws the cell exactly as baked, which is what every
// rock passes; the chunk family passes its host world's material colour.
export function rockGLPush(sh, x, y, rot, half, u0, v0, tr = 1, tg = 1, tb = 1) {
  if (!gl || dead) return;
  let b = null;
  for (const q of batches) if (q.sh === sh) { b = q; break; }
  if (!b) { b = { sh, data: new Float32Array(CAP * FLOATS), n: 0 }; batches.push(b); }
  if (b.n >= CAP) return;   // absurd overflow — drop rather than grow mid-frame
  const o = b.n * FLOATS;
  b.data[o] = x; b.data[o + 1] = y; b.data[o + 2] = rot;
  b.data[o + 3] = half; b.data[o + 4] = u0; b.data[o + 5] = v0;
  b.data[o + 6] = tr; b.data[o + 7] = tg; b.data[o + 8] = tb;
  b.n++;
}

export function rockGLCount() {
  let n = 0;
  for (const b of batches) n += b.n;
  return n;
}

// Draw everything queued and return the canvas to composite, or null if there
// was nothing to draw (or GL died mid-frame — the caller then draws nothing,
// having already decided this batch was going the GL route).
// `k, e, f` are render.js's world matrix; they already include dpr.
export function rockGLFlush(k, e, f) {
  if (!gl || dead) return null;
  const total = rockGLCount();
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!total) return null;
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  gl.uniform3f(uXf, k, e, f);
  gl.uniform2f(uViewport, cv.width, cv.height);
  gl.activeTexture(gl.TEXTURE0);
  for (const b of batches) {
    if (!b.n || !b.sh.cv) continue;
    texFor(b.sh);
    gl.uniform2f(uCell, b.sh.cell / b.sh.w, b.sh.cell / b.sh.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * FLOATS);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.n);
    drawCalls++;
  }
  gl.bindVertexArray(null);
  lastInstances = total;
  return cv;
}

// Perf/debug readout, in the shape of render.js's rockCacheStats.
export function rockGLStats() {
  return {
    available: !!gl && !dead,
    dead,
    sheets: batches.length,
    instances: lastInstances,
    drawCalls,
    size: cv ? `${cv.width}x${cv.height}` : null,
  };
}
