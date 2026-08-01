// ---------------------------------------------------------------------------
// MINIMAP DOT LAYER — baked off the main thread.
//
// The dense fields draw every in-range rock as a real radar return, which is
// ~1900 x (hypot + atan2 + fillRect). That was already cached at ~15Hz into an
// offscreen canvas (render.js), but the bake still ran ON the main thread, so
// one frame in eight carried the whole cost as a spike.
//
// Here it runs in a worker against an OffscreenCanvas, and the finished layer
// comes back as an ImageBitmap the compositor can blit straight into the dial.
// What the main thread still does is a tight copy loop — ship-relative dx/dy
// plus a giant flag into a reused Float32Array — with no trig at all; every
// sqrt, atan2 and fill happens over here.
//
// TWO CONTRACTS WITH render.js, and both matter:
//   1. The sweep math below MUST stay identical to drawMinimap's. These are
//      the same curves (sweepAge/sweepFlare/sweepPing/radarR) deliberately
//      duplicated rather than imported, because a worker that imported
//      render.js would drag the whole 2D renderer into a second thread. If
//      you retune the sweep, retune it in BOTH places or the cached dots will
//      fade on a different clock from the live blips drawn over them.
//   2. Positions arrive SHIP-RELATIVE. World coordinates run to ~46,000 and
//      these are Float32s — sending absolute positions would quantise a
//      1px dot's bearing at the far edge of the dial. dx/dy are bounded by
//      MINIMAP_FAR, where float32 has precision to spare.
//
// The buffer is handed back with the bitmap so render.js can refill and resend
// it — transferring neuters the sender's view, and allocating a fresh 96KB
// array 15 times a second is exactly the garbage this was meant to avoid.
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;

let cv = null;   // the OffscreenCanvas, kept across bakes and resized on demand
let c = null;

self.onmessage = (e) => {
  const d = e.data;
  const px = Math.max(1, Math.round(d.size * d.rdpr));
  if (!cv || cv.width !== px) {
    cv = new OffscreenCanvas(px, px);
    c = cv.getContext('2d');
  }
  c.setTransform(d.rdpr, 0, 0, d.rdpr, 0, 0);
  c.clearRect(0, 0, d.size, d.size);
  c.fillStyle = '#a2937d';   // belt-rock tan: terrain, not the blip palette

  const xy = new Float32Array(d.buf);
  const { n, cx, cy, near, far, mid, scale, sweepAng, sweepT, pingT } = d;

  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const dx = xy[o], dy = xy[o + 1], giant = xy[o + 2];
    const dist = Math.hypot(dx, dy) || 1;
    if (dist > far) continue;   // the main thread box-rejects; this is the true circle
    // Each rock pings on ITS OWN bearing as the sweep crosses it — one shared
    // age made a pocket this wide strobe as a single slab.
    let lag = sweepAng - Math.atan2(dy, dx);
    lag %= TAU; if (lag < 0) lag += TAU;
    const age = lag * sweepT / TAU;
    let aDot;
    if (dist > near) {                    // OUTER half: a scan, no persistence
      if (age >= pingT) continue;
      const k = 1 - age / pingT;
      aDot = k * k;
    } else {                              // INNER half: flare, then cool
      aDot = Math.min(1, 0.68 + 0.6 * Math.exp(-age * 2.24));
    }
    if (aDot <= 0.01) continue;
    c.globalAlpha = aDot * (giant ? 0.95 : 0.6);
    const rr = dist <= near ? dist * scale : mid + (dist - near) * scale * 0.5;
    const px2 = cx + (dx / dist) * rr, py = cy + (dy / dist) * rr;
    // giants read bigger — they're the landmarks you navigate the shoal by
    const sz = giant ? 2.6 : 1.2;
    c.fillRect(px2 - sz / 2, py - sz / 2, sz, sz);
  }
  c.globalAlpha = 1;

  const bitmap = cv.transferToImageBitmap();
  self.postMessage({ bitmap, buf: xy.buffer }, [bitmap, xy.buffer]);
};
