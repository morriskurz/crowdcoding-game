// Photosensitive flash gate. Per-frame mean luma (ffmpeg signalstats YAVG); a "flash" is a
// frame-to-frame jump of more than 20/255. Fails if any 1 s window holds more than 3 flashes
// (WCAG 2.3.1-style "three flashes" threshold, applied to whole-frame luminance).
//
// Run: node scripts/gates/flash.mjs <video>   (prints JSON, exit 1 on fail)
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const JUMP = 20;
export const MAX_PER_SECOND = 3;

/** [{t, y}] per frame. */
export function lumaSeries(video) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg signalstats failed: ${r.stderr}`);
  const out = [];
  let t = null;
  for (const line of r.stdout.split("\n")) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) t = Number(m[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && t !== null) out.push({ t, y: Number(y[1]) });
  }
  return out;
}

/** Pure analysis of a luma series. */
export function analyzeFlashes(series, { jump = JUMP, maxPerSecond = MAX_PER_SECOND } = {}) {
  const flashes = [];
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(series[i].y - series[i - 1].y);
    if (d > jump) flashes.push({ t: series[i].t, d: +d.toFixed(2) });
  }
  let worst = 0;
  let worstAt = null;
  for (let i = 0, j = 0; j < flashes.length; j++) {
    while (flashes[j].t - flashes[i].t >= 1) i++;
    if (j - i + 1 > worst) { worst = j - i + 1; worstAt = flashes[i].t; }
  }
  return { result: worst > maxPerSecond ? "fail" : "pass", frames: series.length, flashes: flashes.length, maxFlashesIn1s: worst, worstAt, maxJump: +Math.max(0, ...series.slice(1).map((s, i) => Math.abs(s.y - series[i].y))).toFixed(2) };
}

export const flashGate = (video) => analyzeFlashes(lumaSeries(video));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = flashGate(process.argv[2]);
  console.log(JSON.stringify(r));
  process.exit(r.result === "pass" ? 0 : 1);
}
