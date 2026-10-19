// Frame-time gate. Headless Chrome (SwiftShader) frame costs are not absolute but repeat within a few
// percent, so this compares the PR's after-run with a baseline recorded from main by
// present-baseline.yml (artifact `frametime-baseline`), same scenario and seed.
//
// Frame cost = time spent in the client's snapshot handler incl. a canvas readback (present/
// instrument.js). Compared: p95 raw, and p95 divided by a fixed Canvas2D calibration workload run in
// the same browser (normalizes a faster or slower runner). The gate fails if BOTH are more than 20 %
// slower than the baseline: a real regression shows in both, runner speed only moves the raw one and
// calibration noise only the normalized one. "no-baseline" when there is none for the scenario.
//
// Run: node scripts/gates/frametime.mjs <after frames.json> [baseline.json]
//      node scripts/gates/frametime.mjs --make-baseline <out.json> <sha> <frames.json>...
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_SLOWDOWN = 0.2;

export function p95(samples) {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

/** Summary of one recorded side (frames.json from present/record.mjs). */
export function summarize(frames) {
  const p = p95(frames.frameMs);
  return { scenario: frames.scenario, seed: frames.seed, samples: frames.frameMs.length, p95Ms: +p.toFixed(4), calibMs: +frames.calibMs.toFixed(4), norm: +(p / frames.calibMs).toFixed(5) };
}

export function compare(after, baseline, maxSlowdown = MAX_SLOWDOWN) {
  const base = baseline?.scenarios?.[after.scenario];
  if (!base || base.seed !== after.seed || !(base.p95Ms > 0)) return { result: "no-baseline", after, baselineSha: baseline?.sha ?? null };
  const rawRatio = after.p95Ms / base.p95Ms;
  const normRatio = after.norm / base.norm;
  const ratio = Math.min(rawRatio, normRatio);
  return {
    result: ratio > 1 + maxSlowdown ? "fail" : "pass",
    ratio: +ratio.toFixed(4),
    rawRatio: +rawRatio.toFixed(4),
    normRatio: +normRatio.toFixed(4),
    limit: 1 + maxSlowdown,
    after,
    baseline: base,
    baselineSha: baseline.sha,
  };
}

export function frameTimeGate(afterFramesFile, baselineFile) {
  const after = summarize(JSON.parse(fs.readFileSync(afterFramesFile, "utf8")));
  let baseline = null;
  if (baselineFile && fs.existsSync(baselineFile)) {
    try { baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")); } catch { baseline = null; }
  }
  return compare(after, baseline);
}

export function makeBaseline(sha, framesFiles) {
  const scenarios = {};
  for (const f of framesFiles) {
    const s = summarize(JSON.parse(fs.readFileSync(f, "utf8")));
    scenarios[s.scenario] = s;
  }
  return { sha, recordedAt: new Date().toISOString(), scenarios };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args[0] === "--make-baseline") {
    const [, out, sha, ...files] = args;
    fs.writeFileSync(out, JSON.stringify(makeBaseline(sha, files), null, 2) + "\n");
    console.log(fs.readFileSync(out, "utf8"));
  } else {
    const r = frameTimeGate(args[0], args[1]);
    console.log(JSON.stringify(r));
    process.exit(r.result === "fail" ? 1 : 0);
  }
}
