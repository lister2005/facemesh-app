// pipeline.js -- camera -> MediaPipe -> dot grid, in the browser.
// The web counterpart of facemesh_writer.py: same steps (person mask, face
// mesh depth, body slab, hand depth, auto-levels, steady colour, One-Euro
// smoothing, gestures, face centre for prediction), adapted for speed in
// JavaScript. Two sources produce the same grid format:
//   CameraSource -- live camera + MediaPipe for Web (needs web/vendor/tasks-vision)
//   DemoSource   -- a synthetic turning sphere, for trying the app without MediaPipe

export const GESTURE_NONE = 0, GESTURE_PINCH = 1, GESTURE_OPEN_PALM = 2;

const BODY_BEHIND_CM = 2.0, BODY_ROUND_CM = 6.5, FACE_WIDTH_CM = 14.0;
const BODY_Z = 0.03, BODY_ROUNDNESS = 0.10, BACKGROUND_Z = 0.45;
const LEVELS_EASE = 0.1, COLOUR_EASE = 0.05;
// MediaPipe face-mesh outline (silhouette of the face)
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

// ---------------------------------------------------------------- helpers

class OneEuro {               // same filter as the writer: smooth when still, quick when moving
  constructor(minCutoff = 1.5, beta = 25, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (!this.x || this.x.length !== x.length || t <= this.t) { this.x = Float32Array.from(x); this.dx = new Float32Array(x.length); this.t = t; return this.x; }
    const dt = t - this.t; this.t = t;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    for (let i = 0; i < x.length; i++) {
      const d = (x[i] - this.x[i]) / dt;
      this.dx[i] += ad * (d - this.dx[i]);
      const a = OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx[i]), dt);
      this.x[i] += a * (x[i] - this.x[i]);
    }
    return this.x;
  }
}

function boxBlur(src, w, h, r, tmp) {          // separable box blur, in place via tmp
  for (let y = 0; y < h; y++) {
    let acc = 0, cnt = 0;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) { acc += src[y * w + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / cnt;
      const xo = x - r, xi = x + r + 1;
      if (xo >= 0) { acc -= src[y * w + xo]; cnt--; }
      if (xi < w) { acc += src[y * w + xi]; cnt++; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, cnt = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) { acc += tmp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc / cnt;
      const yo = y - r, yi = y + r + 1;
      if (yo >= 0) { acc -= tmp[yo * w + x]; cnt--; }
      if (yi < h) { acc += tmp[yi * w + x]; cnt++; }
    }
  }
}

function fillPolygon(ctx, pts, w, h, pad = 0) {   // rasterise a polygon on a small 2D canvas
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  if (pad > 0) { ctx.lineWidth = pad * 2; ctx.strokeStyle = "#fff"; ctx.lineJoin = "round"; ctx.stroke(); }
  return ctx.getImageData(0, 0, w, h).data;
}

function convexHull(points) {                      // monotone chain
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function detectGesture(hand, aspect) {      // hand: Float32Array 21*3 (mirrored)
  const P = i => [hand[i * 3], hand[i * 3 + 1] * aspect];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const palm = dist(P(9), P(0));
  if (palm < 1e-4) return [GESTURE_NONE, 0, 0];
  if (dist(P(4), P(8)) < 0.35 * palm) {
    const m = [(P(4)[0] + P(8)[0]) / 2, (P(4)[1] + P(8)[1]) / 2];
    return [GESTURE_PINCH, m[0], m[1] / aspect];
  }
  const extended = [[8, 5], [12, 9], [16, 13], [20, 17]].every(([t, m]) => dist(P(t), P(0)) > 1.6 * dist(P(m), P(0)));
  if (extended && dist(P(4), P(5)) > 0.6 * palm) {
    const c = [0, 5, 9, 13, 17].reduce((s, i) => [s[0] + P(i)[0] / 5, s[1] + P(i)[1] / 5], [0, 0]);
    return [GESTURE_OPEN_PALM, c[0], c[1] / aspect];
  }
  return [GESTURE_NONE, 0, 0];
}

// ---------------------------------------------------------------- grid builder

export class GridBuilder {
  constructor(gw, gh) {
    this.gw = gw; this.gh = gh;
    const n = gw * gh;
    this.canvas = new OffscreenCanvas(gw, gh);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.polyCanvas = new OffscreenCanvas(gw, gh);
    this.polyCtx = this.polyCanvas.getContext("2d", { willReadFrequently: true });
    this.f1 = new Float32Array(n); this.f2 = new Float32Array(n); this.f3 = new Float32Array(n);
    this.levels = null; this.slowColour = null;
    this.depthFilter = new OneEuro();
  }

  // video: <video> element; mask: {data: Float32Array, w, h} person confidence or null;
  // faces/hands: arrays of Float32Array (x, y, z per landmark, already mirrored)
  build(video, mask, faces, hands, cmPerUnit, t) {
    const { gw, gh, ctx } = this, n = gw * gh;
    const aspect = (video.videoHeight || 3) / (video.videoWidth || 4);
    ctx.save(); ctx.translate(gw, 0); ctx.scale(-1, 1);                // mirror
    ctx.drawImage(video, 0, 0, gw, gh); ctx.restore();
    const px = ctx.getImageData(0, 0, gw, gh).data;
    const luma = new Uint8Array(n), alpha = new Uint8Array(n), rgb = new Uint8Array(n * 3);
    const depth = new Float32Array(n);

    // person mask (mirrored), or everything when there is no segmenter
    if (mask) {
      for (let y = 0; y < gh; y++) {
        const my = Math.min(mask.h - 1, ((y + 0.5) / gh * mask.h) | 0);
        for (let x = 0; x < gw; x++) {
          const mx = Math.min(mask.w - 1, ((1 - (x + 0.5) / gw) * mask.w) | 0);
          alpha[y * gw + x] = Math.min(255, mask.data[my * mask.w + mx] * 255);
        }
      }
    } else alpha.fill(255);

    // brightness with auto-levels over the person (histogram percentiles, eased)
    const hist = new Uint32Array(256); let cnt = 0;
    for (let i = 0; i < n; i++) {
      const l = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) | 0;
      luma[i] = l;
      if (alpha[i] > 127) { hist[l]++; cnt++; }
    }
    if (cnt > 200) {
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cnt * 0.02) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cnt * 0.02) { hi = v; break; } }
      if (!this.levels) this.levels = [lo, hi];
      else { this.levels[0] += LEVELS_EASE * (lo - this.levels[0]); this.levels[1] += LEVELS_EASE * (hi - this.levels[1]); }
    }
    let lo = 0, scale = 1;
    if (this.levels) { lo = this.levels[0]; scale = 255 / Math.max(20, this.levels[1] - lo); }
    // steady colour: hold the person's mean colour against camera white-balance pulsing
    const mean = [0, 0, 0]; let mc = 0;
    for (let i = 0; i < n; i++) if (alpha[i] > 127) { mean[0] += px[i * 4]; mean[1] += px[i * 4 + 1]; mean[2] += px[i * 4 + 2]; mc++; }
    let gain = [1, 1, 1];
    if (mc > 500) {
      const cur = mean.map(m => m / mc);
      this.slowColour = this.slowColour ? this.slowColour.map((s, k) => s + COLOUR_EASE * (cur[k] - s)) : cur;
      gain = this.slowColour.map((s, k) => Math.min(1.4, Math.max(0.7, s / Math.max(1, cur[k]))));
    }
    for (let i = 0; i < n; i++) {
      luma[i] = Math.max(0, Math.min(255, (luma[i] - lo) * scale));
      for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.max(0, Math.min(255, (px[i * 4 + k] - lo) * scale * gain[k]));
    }

    // body: rounded slab -- a blurred copy of the mask stands in for the
    // distance to the silhouette edge (centre near, edges curving back)
    const bz = cmPerUnit > 0 ? Math.min(0.2, BODY_BEHIND_CM / cmPerUnit) : BODY_Z;
    const br = cmPerUnit > 0 ? Math.min(0.4, Math.max(0.02, BODY_ROUND_CM / cmPerUnit)) : BODY_ROUNDNESS;
    const solid = this.f1;
    for (let i = 0; i < n; i++) solid[i] = alpha[i] > 127 ? 1 : 0;
    const r = Math.max(2, Math.round(gw / 24));
    boxBlur(solid, gw, gh, r, this.f2); boxBlur(solid, gw, gh, r, this.f2);
    for (let i = 0; i < n; i++) {
      if (alpha[i] > 127) {
        const inner = Math.min(1, Math.max(0, (solid[i] - 0.5) * 2));
        depth[i] = bz + br * (1 - Math.sqrt(inner));
      } else depth[i] = BACKGROUND_Z;
    }

    // face: mesh depth by normalised convolution, inside the face outline
    for (const f of faces) {
      const num = this.f2, wt = this.f3;
      num.fill(0); wt.fill(0);
      for (let k = 0; k < f.length / 3; k++) {
        const x = Math.round(f[k * 3] * gw - 0.5), y = Math.round(f[k * 3 + 1] * gh - 0.5);
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        num[y * gw + x] += f[k * 3 + 2]; wt[y * gw + x] += 1;
      }
      const br2 = Math.max(1, Math.round(gw / 240));
      boxBlur(num, gw, gh, br2, this.f1); boxBlur(wt, gw, gh, br2, this.f1);
      const outline = fillPolygon(this.polyCtx, FACE_OVAL.map(k => [f[k * 3] * gw, f[k * 3 + 1] * gh]), gw, gh);
      for (let i = 0; i < n; i++) if (outline[i * 4 + 3] > 127 && wt[i] > 1e-4) {
        depth[i] = num[i] / wt[i]; alpha[i] = 255;
      }
    }

    // hands: depth from apparent size against the face, nearer only
    for (const hd of hands) {
      const P = k => [hd[k * 3], hd[k * 3 + 1]];
      const handLen = Math.hypot((P(12)[0] - P(0)[0]), (P(12)[1] - P(0)[1]) * aspect);
      let z = BODY_Z;
      if (faces.length && handLen > 1e-4) {
        const f = faces[0];
        let ymin = 1, ymax = 0, zs = 0;
        for (let k = 0; k < f.length / 3; k++) { ymin = Math.min(ymin, f[k * 3 + 1]); ymax = Math.max(ymax, f[k * 3 + 1]); zs += f[k * 3 + 2]; }
        const faceLen = (ymax - ymin) * aspect;
        z = zs / (f.length / 3) + (faceLen / handLen - 1) * 0.5;
      }
      const hull = convexHull(Array.from({ length: 21 }, (_, k) => [P(k)[0] * gw, P(k)[1] * gh]));
      const region = fillPolygon(this.polyCtx, hull, gw, gh, Math.max(1, handLen * gw * 0.18));
      for (let i = 0; i < n; i++) if (region[i * 4 + 3] > 127 && alpha[i] > 127) depth[i] = Math.min(depth[i], z);
    }

    const smoothDepth = this.depthFilter.filter(depth, t);
    return { gw, gh, aspect, luma, alpha, depth: Float32Array.from(smoothDepth), rgb };
  }
}

// ---------------------------------------------------------------- sources

export class CameraSource {
  constructor(video, opts) { this.video = video; this.opts = opts; this.ready = false; this.stats = { fps: 0, ms: 0 }; }

  async start(facingMode = "user") {
    const vendor = "./vendor/tasks-vision";
    const vision = await import(`${vendor}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${vendor}/wasm`);
    const base = path => ({ modelAssetPath: path, delegate: "GPU" });
    this.face = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: base("models/face_landmarker.task"), runningMode: "VIDEO", numFaces: 1,
      outputFacialTransformationMatrixes: true });
    this.seg = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: base("models/selfie_segmenter.tflite"), runningMode: "VIDEO",
      outputConfidenceMasks: true, outputCategoryMask: false });
    try {
      this.hand = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: base("models/hand_landmarker.task"), runningMode: "VIDEO", numHands: 1 });
    } catch (e) { this.hand = null; console.warn("hand model unavailable", e); }
    await this.switchCamera(facingMode);
    this.builder = new GridBuilder(this.opts.gw, this.opts.gh);
    this.faceFilter = new OneEuro(); this.handFilter = new OneEuro();
    this.lastHandT = 0; this.hands = []; this.handId = 0;
    this.cmPerUnit = 0; this.headCm = 0;
    this.ready = true;
  }

  async switchCamera(facingMode) {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play();
    this.facing = facingMode;
  }

  // One frame, or null if the camera has nothing new yet.
  next() {
    const v = this.video;
    if (!this.ready || v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    const t0 = performance.now(), ts = t0, tSec = t0 / 1000;
    const faceRes = this.face.detectForVideo(v, ts);
    let mask = null;
    this.seg.segmentForVideo(v, ts, res => {
      const m = res.confidenceMasks && res.confidenceMasks[0];
      if (m) mask = { data: m.getAsFloat32Array(), w: m.width, h: m.height };
    });
    if (this.hand && t0 - this.lastHandT > 100) {          // hands ~10 times a second, like the writer
      const hr = this.hand.detectForVideo(v, ts);
      this.hands = (hr.landmarks || []).map(l => mirror(l));
      this.handId++; this.lastHandT = t0;
    }
    let faces = (faceRes.faceLandmarks || []).map(l => mirror(l));
    if (faces.length) faces = [Float32Array.from(this.faceFilter.filter(faces[0], tSec))];
    const hands = this.hands.length ? [Float32Array.from(this.handFilter.filter(this.hands[0], tSec))] : [];
    const aspect = (v.videoHeight || 3) / (v.videoWidth || 4);

    // head distance + metric scale (as the writer's HeadMetrics)
    let face = null;
    if (faces.length) {
      const f = faces[0];
      const width = Math.abs(f[454 * 3] - f[234 * 3]);
      if (width > 0.01) { const c = FACE_WIDTH_CM / width; this.cmPerUnit = this.cmPerUnit ? this.cmPerUnit + 0.2 * (c - this.cmPerUnit) : c; }
      const m = faceRes.facialTransformationMatrixes && faceRes.facialTransformationMatrixes[0];
      if (m && m.data) {
        const d = m.data, cand = [Math.hypot(d[12], d[13], d[14]), Math.hypot(d[3], d[7], d[11])].filter(x => x > 10 && x < 500);
        if (cand.length) { const dd = Math.max(...cand); this.headCm = this.headCm ? this.headCm + 0.2 * (dd - this.headCm) : dd; }
      }
      let cx = 0, cy = 0; const nPts = f.length / 3;
      for (let k = 0; k < nPts; k++) { cx += f[k * 3]; cy += 0.5 + (f[k * 3 + 1] - 0.5) * aspect; }
      cx /= nPts; cy /= nPts;
      let r = 0;
      for (let k = 0; k < nPts; k++) r = Math.max(r, Math.hypot(f[k * 3] - cx, 0.5 + (f[k * 3 + 1] - 0.5) * aspect - cy));
      face = { cx, cy, r };
    }
    const grid = this.builder.build(v, mask, faces, hands, this.cmPerUnit, tSec);
    const gesture = hands.length ? detectGesture(hands[0], aspect) : [GESTURE_NONE, 0, 0];
    const ms = performance.now() - t0;
    this.stats.ms += 0.1 * (ms - this.stats.ms);
    return Object.assign(grid, { t: tSec, face, gesture, handId: this.handId, headCm: this.headCm });
  }

  stop() { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); }
}

function mirror(landmarks) {           // MediaPipe landmark list -> Float32Array, x mirrored
  const a = new Float32Array(landmarks.length * 3);
  landmarks.forEach((p, i) => { a[i * 3] = 1 - p.x; a[i * 3 + 1] = p.y; a[i * 3 + 2] = p.z; });
  return a;
}

export class DemoSource {              // synthetic subject: turning sphere, gestures, "talking"
  constructor(opts) { this.opts = opts; this.ready = true; this.t0 = performance.now(); this.last = 0; this.stats = { fps: 30, ms: 0 }; }
  async start() {}
  next() {
    const now = performance.now();
    if (now - this.last < 1000 / 30) return null;
    this.last = now;
    const t = (now - this.t0) / 1000, { gw, gh } = this.opts, n = gw * gh, aspect = 0.75;
    const luma = new Uint8Array(n), alpha = new Uint8Array(n), depth = new Float32Array(n), rgb = new Uint8Array(n * 3);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x, u = (x + 0.5) / gw - 0.5, v = ((y + 0.5) / gh - 0.5) * aspect;
      const r2 = (u * u + v * v) / 0.09, inside = r2 < 1, zr = inside ? Math.sqrt(1 - r2) : 0;
      const lon = Math.atan2(u, zr) + t * 0.8, band = 0.5 + 0.5 * Math.cos(lon * 6);
      luma[i] = inside ? 40 + 215 * band * (0.4 + 0.6 * zr) : 0;
      alpha[i] = inside ? 255 : 0;
      depth[i] = inside ? -0.09 * zr : BACKGROUND_Z;
      rgb[i * 3] = 127 + 127 * Math.sin(lon); rgb[i * 3 + 1] = 127 + 127 * Math.sin(lon + 2.1); rgb[i * 3 + 2] = 127 + 127 * Math.sin(lon + 4.2);
    }
    const phase = Math.floor(t / 3) % 3;
    const gesture = [phase === 1 ? GESTURE_PINCH : phase === 2 ? GESTURE_OPEN_PALM : GESTURE_NONE, 0.5 + 0.2 * Math.sin(t * 2), 0.5];
    return { gw, gh, aspect, luma, alpha, depth, rgb, t, face: { cx: 0.5, cy: 0.5, r: 0.12 }, gesture,
             handId: Math.floor(t * 10), headCm: 60, demoVoice: 0.5 + 0.5 * Math.sin(t * 3) };
  }
  stop() {}
}
