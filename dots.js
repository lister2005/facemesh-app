// dots.js -- dot physics + WebGL2 renderer for the web version.
// Same behaviour as the desktop engine (engine.c / render_x11.c): one spring
// particle per grid cell, person-mask hysteresis, head prediction, open-palm
// scatter, voice ripple, depth shading, palettes, camera colour, ASCII mode,
// glow and trails. Dots are drawn as GPU point sprites, which keeps it fast on
// phones.

export const PALETTES = ["green", "amber", "ice", "white", "depth"];

const SCENE_SCALE = 3.0;          // frame width -> world units
const CAMERA_DISTANCE = 4.0;
const FOV = 50 * Math.PI / 180;
const NEAR = 0.5, FAR = 8.0;
const STIFFNESS = 1000, STIFFNESS_JITTER = 120, DAMPING = 0.45, DT = 1 / 60;
const ALPHA_ON = 0.6 * 255, ALPHA_OFF = 0.4 * 255;      // hysteresis: steadier edges
const SCATTER_Z = 2.5;            // vacated dots drift back this far while fading
const FADE_RATE = 30;             // brightness approach rate per second
const BLACK_POINT = 0.06;
const BG_DIM = 0.3;
const RADIUS_FRACTION = 0.62;     // max dot radius as a fraction of cell spacing
const SCATTER_RADIUS = 0.3, SCATTER_RATE = 6;
const PREDICT_MAX_AGE = 0.15, PREDICT_FALLOFF = 2.2;
const VOICE_DEPTH = 0.12, VOICE_RING_SPACING = 0.07, VOICE_RING_SPEED = 0.35, VOICE_GLOW = 0.6;

// 5x7 glyphs " .:-=+*#%@" (same as the desktop ASCII mode), bit 4 = leftmost column
const GLYPHS = [
  [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 4], [0, 4, 4, 0, 4, 4, 0], [0, 0, 0, 31, 0, 0, 0],
  [0, 0, 31, 0, 31, 0, 0], [0, 4, 4, 31, 4, 4, 0], [0, 21, 14, 31, 14, 21, 0],
  [10, 10, 31, 10, 31, 10, 10], [24, 25, 2, 4, 8, 19, 3], [14, 17, 23, 21, 23, 16, 14],
];

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aBright;
layout(location=2) in vec3 aColour;
uniform vec2 uView;            // yaw, pitch
uniform float uFocal;          // pixels per world unit at distance 1
uniform vec2 uViewport;
uniform float uRadius;         // max dot radius, world units
uniform float uSizeScale;      // glow pass draws bigger
uniform int uPalette;          // -1 = camera colour
uniform int uAscii;            // > 0: glyph size in cells
out vec3 vColour;
out float vGlyph;
vec3 paletteColour(int p, float zc) {
  if (p == 1) return vec3(1.0, 0.69, 0.16);
  if (p == 2) return vec3(0.47, 0.78, 1.0);
  if (p == 3) return vec3(0.92);
  if (p == 4) {
    float t = clamp((zc - (${CAMERA_DISTANCE.toFixed(1)} - 0.6)) / 1.2, 0.0, 1.0) * 4.0;
    vec3 s0 = vec3(1.0, 0.16, 0.16), s1 = vec3(1.0, 0.86, 0.16), s2 = vec3(0.24, 1.0, 0.35),
         s3 = vec3(0.16, 0.86, 1.0), s4 = vec3(0.24, 0.35, 1.0);
    if (t < 1.0) return mix(s0, s1, t);
    if (t < 2.0) return mix(s1, s2, t - 1.0);
    if (t < 3.0) return mix(s2, s3, t - 2.0);
    return mix(s3, s4, t - 3.0);
  }
  return vec3(0.0, 1.0, 0.61);
}
void main() {
  float cy = cos(uView.x), sy = sin(uView.x), cp = cos(uView.y), sp = sin(uView.y);
  vec3 p = aPos;
  float x1 = cy * p.x + sy * p.z, z1 = -sy * p.x + cy * p.z;
  float y2 = cp * p.y - sp * z1, z2 = sp * p.y + cp * z1;
  float zc = ${CAMERA_DISTANCE.toFixed(1)} - z2;              // distance from camera
  float ppu = uFocal / zc;
  gl_Position = vec4(x1 * ppu / (uViewport.x * 0.5), y2 * ppu / (uViewport.y * 0.5),
                     (zc - ${NEAR.toFixed(1)}) / (${FAR.toFixed(1)} - ${NEAR.toFixed(1)}) * 2.0 - 1.0, 1.0);
  if (aBright < 0.02 || zc < ${NEAR.toFixed(1)}) { gl_PointSize = 0.0; gl_Position = vec4(2.0); return; }
  float depthDim = 1.0 - clamp((zc - ${NEAR.toFixed(1)}) / ${(FAR - NEAR).toFixed(1)}, 0.0, 1.0) * 0.8;
  if (uAscii > 0) {
    gl_PointSize = uRadius / ${RADIUS_FRACTION} * float(uAscii) * ppu;
    vGlyph = clamp(floor(aBright * 9.99), 1.0, 9.0);
  } else {
    gl_PointSize = max(1.2, 2.0 * uRadius * ppu * sqrt(aBright)) * uSizeScale;
    vGlyph = -1.0;
  }
  float shade = depthDim * (uPalette < 0 ? 0.45 + 0.55 * aBright : 0.35 + 0.65 * aBright);
  vec3 c = uPalette < 0 ? aColour : paletteColour(uPalette, zc);
  if (uPalette == 4) shade = 0.35 + 0.65 * shade;
  vColour = c * shade;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 vColour;
in float vGlyph;
uniform sampler2D uGlyphs;     // 10 glyphs side by side, 6x8 each
uniform float uAlpha;
out vec4 outColour;
void main() {
  vec2 pc = gl_PointCoord;
  if (vGlyph >= 0.0) {
    vec2 uv = vec2((vGlyph * 6.0 + pc.x * 6.0) / 60.0, pc.y);
    if (texture(uGlyphs, uv).r < 0.5) discard;
  } else if (dot(pc - 0.5, pc - 0.5) > 0.25) {
    discard;
  }
  outColour = vec4(vColour, uAlpha);
}`;

const FADE_VERT = `#version 300 es
in vec2 aXY; void main() { gl_Position = vec4(aXY, 0.0, 1.0); }`;
const FADE_FRAG = `#version 300 es
precision mediump float; uniform float uKeep; out vec4 o; void main() { o = vec4(0.0, 0.0, 0.0, 1.0 - uKeep); }`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

export class DotField {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.prog = compile(gl, VERT, FRAG);
    this.fadeProg = compile(gl, FADE_VERT, FADE_FRAG);
    this.u = {};
    for (const n of ["uView", "uFocal", "uViewport", "uRadius", "uSizeScale", "uPalette", "uAscii", "uGlyphs", "uAlpha"])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.uKeep = gl.getUniformLocation(this.fadeProg, "uKeep");
    this.vao = gl.createVertexArray();
    this.bufPos = gl.createBuffer();
    this.bufBright = gl.createBuffer();
    this.bufColour = gl.createBuffer();
    this.fadeVao = gl.createVertexArray();
    gl.bindVertexArray(this.fadeVao);
    const fb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this._makeGlyphTexture();
    // view + options
    this.yaw = 0; this.pitch = 0;
    this.opts = { colour: false, palette: 0, ascii: false, glow: false, trails: false, background: false,
                  predict: true, voice: true, scatter: false, depthGain: 1.5 };
    this.gw = 0; this.gh = 0; this.n = 0;
    this.scatter = 0; this.voiceLevel = 0; this.voiceT = 0;
    this.visible = 0;
  }

  _makeGlyphTexture() {
    const gl = this.gl, w = 60, h = 8, data = new Uint8Array(w * h);
    GLYPHS.forEach((rows, g) => rows.forEach((bits, r) => {
      for (let c = 0; c < 5; c++) if (bits & (16 >> c)) data[r * w + g * 6 + c] = 255;
    }));
    this.glyphTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _resizeGrid(gw, gh) {
    this.gw = gw; this.gh = gh; this.n = gw * gh;
    const n = this.n;
    this.pos = new Float32Array(n * 3);          // starts at the centre: the first picture flies out
    this.vel = new Float32Array(n * 3);
    this.k = new Float32Array(n);
    this.bright = new Float32Array(n);
    this.drawBright = new Float32Array(n);
    this.on = new Uint8Array(n);
    this.scatterDir = new Float32Array(n * 3);
    this.colour = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.k[i] = STIFFNESS + (Math.random() * 2 - 1) * STIFFNESS_JITTER;
      // uniform point in a sphere
      let x, y, z;
      do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; } while (x * x + y * y + z * z > 1);
      this.scatterDir.set([x * SCATTER_RADIUS, y * SCATTER_RADIUS, z * SCATTER_RADIUS], i * 3);
    }
  }

  // One physics tick. frame: the latest grid from the pipeline (or null when
  // nothing arrives any more). pred: {dx, dy} head shift in frame units.
  step(frame, live, pred, voiceLevel) {
    if (!frame) return;
    if (frame.gw !== this.gw || frame.gh !== this.gh) this._resizeGrid(frame.gw, frame.gh);
    const o = this.opts, n = this.n, gw = this.gw, gh = this.gh;
    const aspect = frame.aspect || 0.75;
    const ease = Math.min(1, FADE_RATE * DT);
    const scatterWant = live && o.scatter && frame.scattering ? 1 : 0;
    this.scatter += (scatterWant - this.scatter) * Math.min(1, SCATTER_RATE * DT);
    this.voiceLevel += ((o.voice && live ? voiceLevel : 0) - this.voiceLevel) * 0.25;
    this.voiceT += DT;
    const face = frame.face;
    const usePred = o.predict && live && face && pred;
    const vcx = face ? face.cx : 0.5, vcy = face ? face.cy : 0.5;
    const { luma, alpha, depth, rgb } = frame;
    let maxB = 0;
    for (let i = 0; i < n; i++) {
      const a = alpha[i];
      const person = live && a >= (this.on[i] ? ALPHA_OFF : ALPHA_ON);
      this.on[i] = person ? 1 : 0;
      const shown = person || (live && o.background);
      const cx = i % gw, cyy = (i / gw) | 0;
      const u = (cx + 0.5) / gw, v = (cyy + 0.5) / gh, yy = 0.5 + (v - 0.5) * aspect;
      let tx = (u - 0.5) * SCENE_SCALE, ty = (0.5 - yy) * SCENE_SCALE;
      let tz = -depth[i] * SCENE_SCALE * o.depthGain;
      if (usePred && person) {
        const d = Math.hypot(u - face.cx, yy - face.cy) / face.r;
        const w = d <= 1 ? 1 : d >= PREDICT_FALLOFF ? 0 : (PREDICT_FALLOFF - d) / (PREDICT_FALLOFF - 1);
        tx += pred.dx * w * SCENE_SCALE; ty -= pred.dy * w * SCENE_SCALE;
      }
      if (this.scatter > 0.001) {
        tx += this.scatterDir[i * 3] * this.scatter; ty += this.scatterDir[i * 3 + 1] * this.scatter;
        tz += this.scatterDir[i * 3 + 2] * this.scatter;
      }
      let ring = 0;
      if (this.voiceLevel > 0.01 && person) {
        const d = Math.hypot(u - vcx, yy - vcy);
        ring = (0.5 + 0.5 * Math.sin((d - this.voiceT * VOICE_RING_SPEED) * (2 * Math.PI / VOICE_RING_SPACING))) * this.voiceLevel;
        tz += ring * VOICE_DEPTH;
      }
      let want = 0;
      if (shown) {
        want = Math.max(0, (luma[i] / 255 - BLACK_POINT) / (1 - BLACK_POINT)) * (person ? 1 : BG_DIM);
        if (ring > 0) want = Math.min(1, want * (1 + ring * VOICE_GLOW) + ring * 0.15);
      } else {
        tz -= SCATTER_Z;
      }
      const j = i * 3, kk = this.k[i];
      for (let c = 0; c < 3; c++) {
        const t = c === 0 ? tx : c === 1 ? ty : tz;
        this.vel[j + c] = (this.vel[j + c] + (t - this.pos[j + c]) * kk * DT) * DAMPING;
        this.pos[j + c] += this.vel[j + c] * DT;
      }
      this.bright[i] += (want - this.bright[i]) * ease;
      if (this.bright[i] > maxB) maxB = this.bright[i];
    }
    this.colour = rgb;
    this.visible = maxB;
  }

  draw() {
    const gl = this.gl, c = this.canvas, o = this.opts;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.floor(c.clientWidth * dpr), H = Math.floor(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    gl.viewport(0, 0, W, H);
    if (o.trails) {                                   // fade the previous frame instead of clearing it
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.fadeProg);
      gl.uniform1f(this.uKeep, 0.8);
      gl.bindVertexArray(this.fadeVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    } else {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    if (!this.n || this.visible < 0.01) return;

    // ASCII: one glyph per step x step block, brightness averaged over the block
    let bright = this.bright;
    const step = o.ascii ? (this.gw >= 200 ? 3 : 2) : 0;
    if (step) {
      bright = this.drawBright;
      bright.fill(0);
      const gw = this.gw, gh = this.gh;
      for (let y = 0; y < gh; y += step) for (let x = 0; x < gw; x += step) {
        let s = 0, m = 0;
        for (let dy = 0; dy < step && y + dy < gh; dy++) for (let dx = 0; dx < step && x + dx < gw; dx++) { s += this.bright[(y + dy) * gw + x + dx]; m++; }
        bright[y * gw + x] = s / m;
      }
    }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufBright);
    gl.bufferData(gl.ARRAY_BUFFER, bright, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColour);
    gl.bufferData(gl.ARRAY_BUFFER, this.colour, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uView, this.yaw, this.pitch);
    gl.uniform1f(this.u.uFocal, W * 0.5 / Math.tan(FOV / 2));
    gl.uniform2f(this.u.uViewport, W, H);
    gl.uniform1f(this.u.uRadius, RADIUS_FRACTION * SCENE_SCALE / this.gw);
    gl.uniform1i(this.u.uPalette, o.colour ? -1 : o.palette);
    gl.uniform1i(this.u.uAscii, step);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTex);
    gl.uniform1i(this.u.uGlyphs, 0);

    if (o.glow && !step) {                            // soft halo: big faint dots added underneath
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniform1f(this.u.uSizeScale, 4.0);
      gl.uniform1f(this.u.uAlpha, 0.06);
      gl.drawArrays(gl.POINTS, 0, this.n);
    }
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.uniform1f(this.u.uSizeScale, 1.0);
    gl.uniform1f(this.u.uAlpha, 1.0);
    gl.drawArrays(gl.POINTS, 0, this.n);
  }
}
