// Record one side of a presentation: start the sim server for a checkout, play the built client in
// headless Chrome, and write video.mp4 (+ audio), 3 screenshots, audio.wav and frames.json.
//
// Run: node scripts/present/record.mjs --root <checkout> --out <dir> [--scenario idle-crowd] [--seed 1337] [--secs 20]
// The checkout's client must be built with VITE_PARTY_HOST=127.0.0.1:<port> (see run.mjs).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VIEWPORT = { width: 1280, height: 720 };
export const TICK_HZ = 15;
// Screenshot ticks as fractions of the clip (start / middle / end of the action).
export const SHOT_AT = [0.2, 0.5, 0.9];

/** System Chrome if present, else Playwright's Chromium (installed by the workflow). */
export function findChrome() {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium"];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  throw new Error("no Chrome found: set CHROME_PATH or run `npx playwright-core install chromium`");
}

/** Start server.mjs for `root` in a child process (isolates the side's game modules). */
export async function startServerProcess({ root, port, seed, scenario }) {
  const child = spawn(process.execPath, [path.join(HERE, "server.mjs"), "--root", root, "--port", String(port), "--seed", String(seed), "--scenario", scenario], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = await new Promise((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("sim server did not start in 30s")), 30000);
    child.stdout.on("data", (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l.startsWith("{"));
      if (line) { clearTimeout(to); resolve(JSON.parse(line)); }
    });
    child.on("exit", (code) => { clearTimeout(to); reject(new Error(`sim server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    ...ready,
    base,
    hold: (at) => fetch(`${base}/__hold?at=${at ?? 0}`).then((r) => r.text()),
    state: () => fetch(`${base}/__state`).then((r) => r.json()),
    stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000); }),
  };
}

export function writeWav(file, rate, interleavedF32, channels = 2) {
  const data = Buffer.from(interleavedF32.buffer, interleavedF32.byteOffset, interleavedF32.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 4, 28);
  h.writeUInt16LE(channels * 4, 32); h.writeUInt16LE(32, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/** ffmpeg concat list covering [start, start + secs): each frame holds until the next one. */
export function concatList(frames, start, secs) {
  const end = start + secs;
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  // Last frame at or before the clip start shows first.
  let i = Math.max(0, sorted.findLastIndex((f) => f.t <= start));
  const lines = [];
  let t = start;
  for (; i < sorted.length && t < end; i++) {
    const next = Math.min(end, sorted[i + 1]?.t ?? end);
    if (next <= t) continue;
    lines.push(`file '${sorted[i].file}'`, `duration ${(next - t).toFixed(4)}`);
    t = next;
  }
  if (!lines.length) throw new Error("no video frames captured");
  // concat demuxer ignores the last duration unless the file is repeated
  lines.push(lines[lines.length - 2]);
  return lines.join("\n") + "\n";
}

export async function recordSide({ root, out, scenario = "idle-crowd", seed = 1337, secs = 20, port = 8787, chrome = findChrome(), log = console.log }) {
  fs.mkdirSync(out, { recursive: true });
  const raw = path.join(out, ".raw");
  fs.rmSync(raw, { recursive: true, force: true });
  const t0 = Date.now();
  const srv = await startServerProcess({ root, port, seed, scenario });
  const ticks = Math.round(secs * TICK_HZ);
  const shotTicks = SHOT_AT.map((f) => Math.round(f * ticks));
  const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await ctx.addInitScript({ path: path.join(HERE, "instrument.js") });
    const page = await ctx.newPage();
    // Video via CDP screencast + system ffmpeg (Playwright's recordVideo needs its own ffmpeg build).
    // Frames arrive only when the page changes, each with a wall-clock timestamp.
    fs.mkdirSync(raw, { recursive: true });
    const cdp = await ctx.newCDPSession(page);
    const shots = [];
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const file = path.join(raw, `f${String(shots.length).padStart(5, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      shots.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
    let tick = 0;
    let firstSnapWall = null;
    const waiters = [];
    page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || !payload.startsWith('{"t":"snap"')) return;
      const m = /"tick":(\d+)/.exec(payload);
      if (!m) return;
      tick = Number(m[1]);
      firstSnapWall ??= Date.now();
      for (const w of [...waiters]) if (tick >= w.at) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
    }));
    const untilTick = (at, ms = 30000) => tick >= at ? Promise.resolve() : Promise.race([
      new Promise((resolve) => waiters.push({ at, resolve })),
      sleep(ms).then(() => { throw new Error(`timed out waiting for tick ${at} (at ${tick})`); }),
    ]);
    page.on("pageerror", (e) => log(`[page error] ${e.message}`));

    await srv.hold(shotTicks[0]);
    await page.goto(`${srv.base}/?room=present&name=viewer`, { waitUntil: "domcontentloaded", timeout: 20000 });
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const screenshots = [];
    for (let k = 0; k < shotTicks.length; k++) {
      await untilTick(shotTicks[k]);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const file = path.join(out, `shot-${k + 1}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
      await srv.hold(shotTicks[k + 1] ?? 0);
    }
    // Run the clip to its full wall length from the first snapshot (holds included).
    const left = secs * 1000 + 500 - (Date.now() - firstSnapWall);
    if (left > 0) await sleep(left);

    await cdp.send("Page.stopScreencast").catch(() => {});
    const metrics = await page.evaluate(() => ({ frames: window.__present.frames, raf: window.__present.raf, calibMs: window.__present.calibrate() }));
    const audio = await page.evaluate(() => window.__present.audioDump());
    const banner = await page.evaluate(() => document.getElementById("banner")?.textContent ?? "");
    await ctx.close();
    const state = await srv.state();

    // Audio: float32 WAV, padded so sample 0 lines up with the start of the page.
    const wav = path.join(out, "audio.wav");
    const rate = audio.rate || 48000;
    const pcm = new Float32Array(Buffer.from(audio.b64, "base64").buffer.slice(0));
    const clipStart = firstSnapWall / 1000; // epoch seconds; video, audio and ticks all align to this
    const pad = audio.startMs === null ? 0 : Math.max(0, Math.round(((audio.startMs + timeOrigin) / 1000 - clipStart) * rate)) * 2;
    const skip = audio.startMs === null ? 0 : Math.max(0, Math.round((clipStart - (audio.startMs + timeOrigin) / 1000) * rate)) * 2;
    const body = pcm.subarray(Math.min(skip, pcm.length));
    const full = new Float32Array(Math.max(pad + body.length, Math.round(rate * secs) * 2));
    full.set(body, pad);
    writeWav(wav, rate, full);

    // Video: trim to the clip (from the first snapshot), mux the captured audio, H.264 for players.
    const list = concatList(shots, clipStart, secs);
    fs.writeFileSync(path.join(raw, "frames.txt"), list);
    const mp4 = path.join(out, "video.mp4");
    const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(raw, "frames.txt"), "-i", wav, "-t", String(secs),
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4], { stdio: "inherit" });
    if (ff.status !== 0) throw new Error("ffmpeg mux failed");
    fs.rmSync(raw, { recursive: true, force: true });

    const frames = { scenario: state.scenario, seed, ticks: state.tick, exceptions: state.exceptions, calibMs: metrics.calibMs, frameMs: metrics.frames, rafMs: metrics.raf, simMs: state.simCostsMs, banner, audioPeak: audio.peak, wallMs: Date.now() - t0 };
    fs.writeFileSync(path.join(out, "frames.json"), JSON.stringify(frames));
    log(`recorded ${root}: ${state.tick} ticks, ${metrics.frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { video: mp4, screenshots, audio: wav, frames: path.join(out, "frames.json"), shotTicks, scenario: state.scenario, exceptions: state.exceptions, wallMs: Date.now() - t0 };
  } finally {
    await browser.close().catch(() => {});
    await srv.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { root: { type: "string" }, out: { type: "string" }, scenario: { type: "string", default: "idle-crowd" }, seed: { type: "string", default: "1337" }, secs: { type: "string", default: "20" }, port: { type: "string", default: "8787" } } });
  if (!values.root || !values.out) { console.error("--root and --out required"); process.exit(2); }
  const r = await recordSide({ root: values.root, out: values.out, scenario: values.scenario, seed: Number(values.seed), secs: Number(values.secs), port: Number(values.port) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(0); // fetch keep-alive sockets would hold the process open
}
