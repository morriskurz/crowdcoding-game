// Render sanity gate. The other gates only judge what is on screen; a blank or frozen recording
// passes them trivially. This gate fails when the after-run shows no motion (mean frame-to-frame
// luma difference, ffmpeg signalstats YDIF) or when its screenshots are byte-identical.
// A real 20 s recording of the template game measured mean YDIF 0.35; a page stuck on
// "connecting…" is ~0.
//
// Run: node scripts/gates/render.mjs <video> <shot1> [shot2 …]   (prints JSON, exit 1 on fail)
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MIN_MEAN_YDIF = 0.05;

export function meanYdif(video) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg signalstats failed: ${r.stderr}`);
  const vals = [...r.stdout.matchAll(/YDIF=([\d.]+)/g)].map((m) => Number(m[1]));
  if (!vals.length) throw new Error("no frames in video");
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/** Pure decision, testable without ffmpeg. */
export function judgeRender({ meanYdif, shotHashes }, { minMeanYdif = MIN_MEAN_YDIF } = {}) {
  const reasons = [];
  if (!(meanYdif >= minMeanYdif)) reasons.push(`no motion: mean YDIF ${meanYdif.toFixed(3)} < ${minMeanYdif}`);
  if (shotHashes.length > 1 && new Set(shotHashes).size === 1) reasons.push("all screenshots identical");
  return { result: reasons.length ? "fail" : "pass", meanYdif, reasons };
}

export function renderGate(video, screenshots) {
  const shotHashes = screenshots.map((f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"));
  return judgeRender({ meanYdif: meanYdif(video), shotHashes });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [video, ...shots] = process.argv.slice(2);
  const r = renderGate(video, shots);
  console.log(JSON.stringify(r));
  process.exit(r.result === "pass" ? 0 : 1);
}
