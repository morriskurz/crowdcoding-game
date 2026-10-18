// Injected into the page before any client code (Playwright addInitScript). Plain browser JS.
// 1. Audio tap: every AudioContext's `destination` becomes a gain node that feeds the speakers and
//    a ScriptProcessor recording every sample, so the audio gate sees exactly what would be played.
// 2. Frame cost: every WebSocket "message" listener (the client renders inside it) is timed, with
//    a 1px canvas readback so deferred Canvas2D rasterization is counted inside the frame.
// 3. rAF intervals, as a secondary signal.
(() => {
  const P = (window.__present = { frames: [], raf: [], audio: { rate: 0, startMs: null, chunks: [], peak: 0 } });

  // --- audio ---
  const destGetter = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "destination").get;
  const Orig = window.AudioContext;
  if (Orig) {
    const Patched = function (...args) {
      const ctx = new Orig(...args);
      const real = destGetter.call(ctx);
      const tap = ctx.createGain();
      const rec = ctx.createScriptProcessor(4096, 2, 2);
      tap.connect(real);
      tap.connect(rec);
      rec.connect(real); // must be connected to run; its output buffer stays silent
      P.audio.rate = ctx.sampleRate;
      rec.onaudioprocess = (ev) => {
        const b = ev.inputBuffer;
        if (P.audio.startMs === null) P.audio.startMs = performance.now() - (b.duration * 1000);
        const l = b.getChannelData(0);
        const r = b.numberOfChannels > 1 ? b.getChannelData(1) : l;
        const out = new Float32Array(l.length * 2);
        for (let i = 0; i < l.length; i++) {
          out[2 * i] = l[i];
          out[2 * i + 1] = r[i];
          const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
          if (a > P.audio.peak) P.audio.peak = a;
        }
        P.audio.chunks.push(out);
      };
      Object.defineProperty(ctx, "destination", { get: () => tap });
      return ctx;
    };
    Patched.prototype = Orig.prototype;
    window.AudioContext = Patched;
    window.webkitAudioContext = Patched;
  }
  P.audioDump = () => {
    const n = P.audio.chunks.reduce((s, c) => s + c.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of P.audio.chunks) { all.set(c, o); o += c.length; }
    const bytes = new Uint8Array(all.buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { rate: P.audio.rate, startMs: P.audio.startMs, peak: P.audio.peak, b64: btoa(s) };
  };

  // --- frame cost ---
  const flush = () => {
    const c = document.querySelector("canvas");
    const g = c && c.getContext("2d");
    if (g) g.getImageData(0, 0, 1, 1);
  };
  const wrapped = new WeakMap();
  const add = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, fn, opts) {
    if (type !== "message" || typeof fn !== "function") return add.call(this, type, fn, opts);
    let w = wrapped.get(fn);
    if (!w) {
      w = function (ev) {
        const t0 = performance.now();
        try { return fn.call(this, ev); } finally { flush(); P.frames.push(performance.now() - t0); }
      };
      wrapped.set(fn, w);
    }
    return add.call(this, type, w, opts);
  };
  const rem = WebSocket.prototype.removeEventListener;
  WebSocket.prototype.removeEventListener = function (type, fn, opts) {
    return rem.call(this, type, (type === "message" && wrapped.get(fn)) || fn, opts);
  };

  let last = null;
  const loop = (t) => { if (last !== null) P.raf.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  // Fixed Canvas2D workload in the same browser: the unit frame cost is normalized against, so a
  // baseline recorded on one runner compares with a PR recorded on another.
  P.calibrate = () => {
    const c = document.createElement("canvas");
    c.width = 800; c.height = 600;
    const g = c.getContext("2d");
    const runs = [];
    for (let k = 0; k < 40; k++) {
      const t0 = performance.now();
      g.clearRect(0, 0, 800, 600);
      for (let i = 0; i < 1500; i++) {
        g.fillStyle = i % 2 ? "#7dd3fc" : "#ffd54a";
        g.beginPath();
        g.arc((i * 37) % 800, (i * 91) % 600, 4 + (i % 9), 0, Math.PI * 2);
        g.fill();
      }
      JSON.parse(JSON.stringify({ a: Array.from({ length: 300 }, (_, i) => ({ x: i, y: i * 2, k: "pellet" })) }));
      g.getImageData(0, 0, 1, 1);
      runs.push(performance.now() - t0);
    }
    // Minimum, not median: interference (other processes, GC) only ever adds time.
    return Math.min(...runs.slice(5));
  };
})();
