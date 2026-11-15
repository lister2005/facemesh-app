// app.js -- the facemesh web app: start screen, main loop, touch + keyboard
// controls, status panel, gestures, head prediction, recording, settings.
import { DotField, PALETTES } from "./dots.js";
import { CameraSource, DemoSource, GESTURE_PINCH, GESTURE_OPEN_PALM } from "./pipeline.js";
import { Audio, Recorder, saveSong, loadSong, download } from "./recorder.js";

const $ = id => document.getElementById(id);
const canvas = $("view"), video = $("video"), hud = $("hud"), toast = $("toast");
const params = new URLSearchParams(location.search);
const phone = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 600;
let [gw, gh] = (params.get("grid") || (phone ? "160x120" : "240x180")).split("x").map(Number);
if (!(gw >= 8 && gw <= 480 && gh >= 8 && gh <= 360)) [gw, gh] = [240, 180];

const PINCH_ROTATE_GAIN = 4.0, SCATTER_HOLD = 0.6, PREDICT_MAX_AGE = 0.15, PREDICT_MAX_SPEED = 1.5;

const field = new DotField(canvas);
const audio = new Audio();
const recorder = new Recorder(canvas, audio);

// ---- settings (remembered on this device) ----
const SETTINGS_KEY = "facemesh.settings";
const settings = Object.assign(
  { colour: false, palette: 0, ascii: false, glow: false, trails: false, background: false, predict: true,
    voice: true, scatter: false, gestures: true, depthGain: 1.5, hud: true, recMic: true, songVolume: 0.15,
    useSong: true, facing: "user" },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }
function apply() { Object.assign(field.opts, settings); saveSettings(); refreshButtons(); }

let song = null;                                   // {name, blob}
loadSong().then(s => { song = s; refreshButtons(); });

function say(text) {
  toast.textContent = text; toast.classList.add("show");
  clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove("show"), 1800);
}

// ---- actions shared by buttons and keys ----
const actions = {
  colour: () => { settings.colour = !settings.colour; say(settings.colour ? "camera colour" : PALETTES[settings.palette]); },
  palette: () => { settings.palette = (settings.palette + 1) % PALETTES.length; settings.colour = false; say(PALETTES[settings.palette]); },
  ascii: () => { settings.ascii = !settings.ascii; say(settings.ascii ? "ASCII" : "dots"); },
  glow: () => { settings.glow = !settings.glow; say("glow " + (settings.glow ? "on" : "off")); },
  trails: () => { settings.trails = !settings.trails; say("trails " + (settings.trails ? "on" : "off")); },
  background: () => { settings.background = !settings.background; say("background " + (settings.background ? "on" : "off")); },
  predict: () => { settings.predict = !settings.predict; say("prediction " + (settings.predict ? "on" : "off")); },
  voice: async () => { settings.voice = !settings.voice; if (settings.voice) await audio.startMic(); say("voice ripple " + (settings.voice ? "on" : "off")); },
  scatter: () => { settings.scatter = !settings.scatter; say("palm scatter " + (settings.scatter ? "on" : "off")); },
  gestures: () => { settings.gestures = !settings.gestures; say("hand gestures " + (settings.gestures ? "on" : "off")); },
  recMic: () => { settings.recMic = !settings.recMic; say("record microphone " + (settings.recMic ? "on" : "off")); },
  useSong: () => { settings.useSong = !settings.useSong; say(song ? `song ${settings.useSong ? "on" : "off"}: ${song.name}` : "no song chosen"); },
  deeper: () => { settings.depthGain = Math.min(4, settings.depthGain * 1.25); say(`depth x${settings.depthGain.toFixed(2)}`); },
  flatter: () => { settings.depthGain = Math.max(0.5, settings.depthGain / 1.25); say(`depth x${settings.depthGain.toFixed(2)}`); },
  reset: () => { field.yaw = 0; field.pitch = 0; say("view reset"); },
  orbit: () => { orbit = !orbit; say("auto-orbit " + (orbit ? "on" : "off")); },
  hud: () => { settings.hud = !settings.hud; },
  help: () => $("help").classList.toggle("show"),
  fullscreen: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}),
  shot: () => canvas.toBlob(b => { download(b, "facemesh-" + Date.now() + ".png"); say("screenshot saved"); }),
  song: () => $("songfile").click(),
  flip: async () => {
    if (!(source instanceof CameraSource)) return;
    settings.facing = settings.facing === "user" ? "environment" : "user";
    try { await source.switchCamera(settings.facing); say(settings.facing === "user" ? "front camera" : "back camera"); }
    catch { say("no other camera"); }
  },
  record: async () => {
    if (recorder.recording) {
      const { blob, name } = await recorder.stop();
      download(blob, name);
      say("video saved: " + name);
    } else {
      await recorder.start({ mic: settings.recMic, song: settings.useSong ? song : null, volume: settings.songVolume });
      say("recording" + (settings.recMic ? " + mic" : "") + (settings.useSong && song ? " + " + song.name : ""));
    }
    refreshButtons();
  },
};
let orbit = false;

$("songfile").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  song = { name: f.name, blob: f };
  settings.useSong = true;
  await saveSong(f);
  say("background song: " + f.name);
  apply();
});

// ---- buttons ----
document.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async e => {
  e.stopPropagation();
  await actions[b.dataset.act]();
  apply();
}));
$("more").addEventListener("click", e => { e.stopPropagation(); $("menu").classList.toggle("show"); });
function refreshButtons() {
  const set = (act, on) => document.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.classList.toggle("on", !!on));
  for (const k of ["colour", "ascii", "glow", "trails", "background", "predict", "voice", "scatter", "gestures", "recMic", "useSong"]) set(k, settings[k]);
  set("record", recorder.recording);
  set("orbit", orbit);
  $("songname").textContent = song ? song.name : "none chosen";
}

// ---- keyboard (desktop browsers): same keys as the desktop engine ----
const KEYS = { c: "colour", k: "palette", a: "ascii", g: "glow", t: "trails", b: "background", l: "predict",
  v: "voice", p: "scatter", h: "gestures", x: "record", n: "song", s: "shot", f: "fullscreen", r: "reset",
  o: "orbit", i: "hud", "?": "help", "/": "help", "+": "deeper", "=": "deeper", "-": "flatter" };
addEventListener("keydown", async e => {
  if (e.key === "ArrowLeft") field.yaw -= 0.08;
  else if (e.key === "ArrowRight") field.yaw += 0.08;
  else if (e.key === "ArrowUp") field.pitch -= 0.08;
  else if (e.key === "ArrowDown") field.pitch += 0.08;
  else if (KEYS[e.key]) { await actions[KEYS[e.key]](); apply(); }
});

// ---- touch / mouse: drag turns the view, pinch changes depth, double-tap resets ----
const pointers = new Map();
let pinchStart = 0, gainStart = 1, lastTap = 0;
canvas.addEventListener("pointerdown", e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a[0] - b[0], a[1] - b[1]); gainStart = settings.depthGain;
  }
  const now = performance.now();
  if (pointers.size === 1 && now - lastTap < 300) actions.reset();
  lastTap = now;
  $("menu").classList.remove("show");
});
canvas.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) {
    field.yaw += (e.clientX - prev[0]) * 0.006;
    field.pitch = Math.max(-1.2, Math.min(1.2, field.pitch + (e.clientY - prev[1]) * 0.006));
  } else if (pointers.size === 2 && pinchStart > 0) {
    const [a, b] = [...pointers.values()];
    settings.depthGain = Math.max(0.5, Math.min(4, gainStart * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinchStart));
    field.opts.depthGain = settings.depthGain;
  }
});
const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) { pinchStart = 0; saveSettings(); } };
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", up);

// ---- start ----
let source = null;
const vendorUrl = "./vendor/tasks-vision/vision_bundle.mjs";
async function vendorPresent() {
  try { return (await fetch(vendorUrl, { method: "HEAD" })).ok; } catch { return false; }
}

async function start(demo) {
  $("start").classList.add("hidden");
  apply();
  try {
    if (demo) {
      source = new DemoSource({ gw, gh });
    } else {
      $("status").textContent = "loading models…";
      source = new CameraSource(video, { gw, gh });
      await source.start(settings.facing);
    }
  } catch (e) {
    console.error(e);
    $("start").classList.remove("hidden");
    $("status").textContent = "Could not start the camera: " + (e.message || e) +
      (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1"
        ? " (phones only allow the camera over https)" : "");
    return;
  }
  if (settings.voice && !demo) audio.startMic();
  requestAnimationFrame(loop);
}

(async () => {
  const have = await vendorPresent();
  $("go").disabled = !have;
  $("status").textContent = have ? "" :
    "MediaPipe for Web is not installed yet (web/vendor/tasks-vision). The demo works without it.";
  $("go").addEventListener("click", () => start(false));
  $("demo").addEventListener("click", () => start(true));
  if (params.has("demo")) start(true);
})();

// ---- main loop ----
let frame = null, lastFrameWall = 0, acc = 0, lastT = performance.now();
let face = null, faceV = [0, 0], lastFace = null;
let pinch = null, palmHeld = 0, frames = 0, draws = 0, statT = performance.now(), camFps = 0, drawFps = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;

  const f = source.next();
  if (f) {
    frame = f; frames++; lastFrameWall = now;
    // head speed for the prediction
    if (f.face && lastFace && f.t > lastFace.t && f.t - lastFace.t < 0.3) {
      const fdt = f.t - lastFace.t;
      faceV = [(f.face.cx - lastFace.cx) / fdt, (f.face.cy - lastFace.cy) / fdt];
      if (Math.hypot(faceV[0], faceV[1]) > PREDICT_MAX_SPEED) faceV = [0, 0];
    } else if (!f.face) faceV = [0, 0];
    lastFace = f.face ? Object.assign({ t: f.t }, f.face) : null;
    face = f.face;
    // gestures
    const [g, gx, gy] = settings.gestures ? f.gesture : [0, 0, 0];
    if (g === GESTURE_PINCH) {
      if (pinch) { field.yaw += (gx - pinch[0]) * PINCH_ROTATE_GAIN; field.pitch = Math.max(-1.2, Math.min(1.2, field.pitch + (gy - pinch[1]) * PINCH_ROTATE_GAIN)); }
      pinch = [gx, gy];
    } else pinch = null;
    frame.gestureNow = g;
  }
  const live = frame && now - lastFrameWall < 350;
  if (frame) {
    palmHeld = settings.scatter && live && frame.gestureNow === GESTURE_OPEN_PALM ? palmHeld + dt : 0;
    frame.scattering = palmHeld >= SCATTER_HOLD;
  }
  if (orbit) field.yaw = Math.sin(now / 1000 * 0.35) * 0.6;

  // physics at a fixed 60 Hz, like the desktop engine
  acc += dt;
  let steps = 0;
  const voice = frame && frame.demoVoice !== undefined ? frame.demoVoice : (settings.voice ? audio.sample() : 0);
  while (acc >= 1 / 60 && steps < 6) {
    let pred = null;
    if (frame && face && settings.predict) {
      const age = Math.min(PREDICT_MAX_AGE, Math.max(0, performance.now() / 1000 - frame.t));
      pred = { dx: faceV[0] * age, dy: faceV[1] * age };
    }
    field.step(frame, live, pred, voice);
    acc -= 1 / 60; steps++;
  }
  field.draw();
  draws++;

  if (now - statT > 500) {
    camFps = frames * 1000 / (now - statT); drawFps = draws * 1000 / (now - statT);
    frames = draws = 0; statT = now;
    const lines = [];
    if (settings.hud) {
      lines.push(source instanceof DemoSource ? `demo  ·  draw ${drawFps.toFixed(0)} fps` :
        `camera ${camFps.toFixed(0)} fps  ·  analysis ${source.stats.ms.toFixed(0)} ms  ·  draw ${drawFps.toFixed(0)} fps`);
      if (frame && frame.headCm > 1) lines.push(`head ${frame.headCm.toFixed(0)} cm  ·  ${settings.colour ? "camera colour" : PALETTES[settings.palette]}${settings.ascii ? "  ·  ascii" : ""}`);
      const g = frame && settings.gestures ? frame.gestureNow : 0;
      if (g === GESTURE_PINCH) lines.push("<b>pinch: move your hand to turn the view</b>");
      else if (g === GESTURE_OPEN_PALM && !settings.scatter) lines.push("open palm seen (scatter is off)");
      else if (g === GESTURE_OPEN_PALM && palmHeld < SCATTER_HOLD) lines.push(`<b>open palm: hold still ${(SCATTER_HOLD - palmHeld).toFixed(1)} s more</b>`);
      else if (frame && frame.scattering) lines.push("<b>scatter: close your hand to bring the dots back</b>");
      if (voice > 0.02) lines.push("voice " + "▮".repeat(Math.round(voice * 12)));
      if (recorder.recording) {
        const s = Math.floor((performance.now() - recorder.started) / 1000);
        lines.push(`<b class="rec">● REC ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}</b>`);
      }
    }
    hud.innerHTML = lines.join("<br>");
    hud.style.display = lines.length ? "block" : "none";
  }
}

// offline support / installable app
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(() => {});
