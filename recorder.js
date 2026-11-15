// recorder.js -- microphone level (voice ripple) and video recording with
// sound: the canvas + microphone + an optional background song, mixed quietly
// under the voice, with a limiter. The chosen song is kept in the browser's
// storage (IndexedDB) so it is still chosen next time.

const DB = "facemesh", STORE = "songs";

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function saveSong(file) {          // file: File from <input type=file>, or null to clear
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    file ? tx.objectStore(STORE).put({ name: file.name, blob: file }, "current") : tx.objectStore(STORE).delete("current");
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

export async function loadSong() {              // -> {name, blob} or null
  try {
    const db = await idb();
    return await new Promise(res => {
      const r = db.transaction(STORE).objectStore(STORE).get("current");
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}

export class Audio {
  constructor() {
    this.ctx = null; this.micStream = null; this.level = 0; this.floor = null; this.peak = 0.02;
  }

  async startMic() {                             // must follow a tap/click (browser rule)
    if (this.micStream) return true;
    try {
      this.ctx = this.ctx || new AudioContext();
      await this.ctx.resume();
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.micNode = this.ctx.createMediaStreamSource(this.micStream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.micNode.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      return true;
    } catch (e) { console.warn("microphone unavailable", e); return false; }
  }

  // loudness 0..1, normalised against a slowly adapting noise floor and peak
  // (same rules as the desktop writer's --mic)
  sample() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) s += v * v;
    const rms = Math.sqrt(s / this.buf.length);
    this.floor = this.floor === null ? rms : Math.min(rms, this.floor + 0.002 * (rms - this.floor) + 1e-6);
    this.peak = Math.max(rms, this.peak * 0.999, this.floor * 4 + 1e-4);
    const target = Math.min(1, Math.max(0, (rms - this.floor * 1.5) / (this.peak - this.floor * 1.5 + 1e-9)));
    this.level += (target > this.level ? 0.5 : 0.08) * (target - this.level);
    return this.level;
  }
}

export class Recorder {
  constructor(canvas, audio) { this.canvas = canvas; this.audio = audio; this.rec = null; }

  get recording() { return !!this.rec; }

  // opts: {mic: bool, song: {name, blob} | null, volume: 0..1}
  async start(opts) {
    const a = this.audio;
    a.ctx = a.ctx || new AudioContext();
    await a.ctx.resume();
    const dest = a.ctx.createMediaStreamDestination();
    const limiter = a.ctx.createDynamicsCompressor();          // keeps a loud voice from clipping
    limiter.threshold.value = -3; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1;
    limiter.connect(dest);
    this.nodes = [limiter];
    if (opts.mic && (await a.startMic())) {
      a.micNode.connect(limiter);
      this.nodes.push({ disconnect: () => a.micNode.disconnect(limiter) });
    }
    if (opts.song) {
      const data = await opts.song.blob.arrayBuffer();
      const buffer = await a.ctx.decodeAudioData(data);
      const src = a.ctx.createBufferSource();
      src.buffer = buffer; src.loop = true;
      const gain = a.ctx.createGain();
      gain.gain.value = opts.volume;
      src.connect(gain).connect(limiter);
      src.start();
      this.nodes.push(src, gain);
    }
    const stream = new MediaStream([...this.canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
    this.mime = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    this.chunks = [];
    this.rec = new MediaRecorder(stream, this.mime ? { mimeType: this.mime, videoBitsPerSecond: 6e6 } : {});
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
    this.started = performance.now();
  }

  // -> {blob, name}
  stop() {
    return new Promise(resolve => {
      const rec = this.rec;
      rec.onstop = () => {
        for (const n of this.nodes) { try { n.stop && n.stop(); n.disconnect(); } catch {} }
        const ext = this.mime.startsWith("video/mp4") ? "mp4" : "webm";
        const d = new Date(), p = v => String(v).padStart(2, "0");
        const name = `facemesh-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
        resolve({ blob: new Blob(this.chunks, { type: this.mime || "video/webm" }), name });
      };
      rec.stop();
      this.rec = null;
    });
  }
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
