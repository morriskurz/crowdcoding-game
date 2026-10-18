// Loud-audio gate: sample peak of the captured game audio (WebAudio tap, see present/instrument.js)
// must stay at or below -1 dBFS. Any file ffmpeg reads works; it is decoded to float32 so peaks
// above full scale are seen, not clipped.
//
// Run: node scripts/gates/audio.mjs <audio-or-video>   (prints JSON, exit 1 on fail)
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_DBFS = -1;

export const toDbfs = (peak) => (peak > 0 ? 20 * Math.log10(peak) : -Infinity);

export function peakOf(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${r.stderr}`);
  const buf = r.stdout;
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  let peak = 0;
  for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
  return { peak, samples: f.length };
}

export function audioGate(file, maxDbfs = MAX_DBFS) {
  const { peak, samples } = peakOf(file);
  const dbfs = toDbfs(peak);
  return { result: dbfs > maxDbfs ? "fail" : "pass", peakDbfs: Number.isFinite(dbfs) ? +dbfs.toFixed(2) : null, limitDbfs: maxDbfs, samples, silent: peak === 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = audioGate(process.argv[2]);
  console.log(JSON.stringify(r));
  process.exit(r.result === "pass" ? 0 : 1);
}
