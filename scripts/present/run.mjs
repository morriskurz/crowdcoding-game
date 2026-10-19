// Whole presentation pipeline for one agent PR: build both clients, record before (main) and after
// (PR head) with the same seed and scenario, run the content gates on the after-run, and write
// <out>/index.json (+ report.json with gate details and timings). Exit 1 if any gate fails; the
// output is complete either way so CI can upload it.
//
// Run (both checkouts already `pnpm install`ed):
//   node scripts/present/run.mjs --before <main checkout> --after <PR checkout> --out presentation \
//     [--pr 12] [--head-sha <sha>] [--baseline frametime-baseline.json] [--seed 1337] [--secs 20]
//
// Trust: CI runs this file, the scenarios and the gates from the main checkout; only the game and the
// client come from the PR head. feature.json and captions.json are untrusted input.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { recordSide, findChrome } from "./record.mjs";
import { resolveScenario } from "../scenarios/index.mjs";
import { isGameSlug } from "../registry.mjs";
import { filterCaptions } from "../gates/wordlist.mjs";
import { flashGate } from "../gates/flash.mjs";
import { renderGate } from "../gates/render.mjs";
import { audioGate } from "../gates/audio.mjs";
import { ocrGate } from "../gates/ocr.mjs";
import { compare, frameTimeGate, summarize } from "../gates/frametime.mjs";

// Overridable for machines where 8787/8788 are taken (CI uses the defaults).
export const PORTS = { before: Number(process.env.PRESENT_PORT_BEFORE ?? 8787), after: Number(process.env.PRESENT_PORT_AFTER ?? 8788) };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * feature.json at the PR head: {id, spec, slug, game?, branch, status, scenario?, ...}. Untrusted.
 * `game` (written by orchestrate.mjs start) picks the game both sides present; a side whose checkout
 * lacks it (before-side of a bootstrap) presents its own current game.
 */
export function readFeature(root) {
  const f = readJson(path.join(root, "feature.json"));
  const ok = f && typeof f === "object" && !Array.isArray(f);
  const id = ok && (typeof f.id === "string" || typeof f.id === "number") ? String(f.id).slice(0, 64) : null;
  const game = ok && isGameSlug(f.game) ? f.game : null;
  return { featureId: id, game, scenario: resolveScenario(ok ? f.scenario : undefined).name, requestedScenario: ok && typeof f.scenario === "string" ? f.scenario.slice(0, 64) : null };
}

export function buildClient(root, port, log = console.log) {
  const t0 = Date.now();
  execFileSync("pnpm", ["--filter", "@tcg/client", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, VITE_PARTY_HOST: `127.0.0.1:${port}` } });
  log(`built client in ${root} (${Date.now() - t0} ms)`);
  return Date.now() - t0;
}

const rel = (out, p) => path.relative(out, p).split(path.sep).join("/");

function timed(timings, key, fn) {
  const t0 = Date.now();
  try { return fn(); } finally { timings[key] = Date.now() - t0; }
}

export async function runPresentation({ before, after, out, pr = null, headSha = null, baseline = null, seed = 1337, secs = 20, build = true, log = console.log }) {
  const t0 = Date.now();
  out = path.resolve(out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const timings = {};
  const errors = [];
  const feature = readFeature(after);
  const captions = filterCaptions(readJson(path.join(after, "captions.json")));
  headSha ??= (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: after, encoding: "utf8" }).trim(); } catch { return null; } })();
  const chrome = findChrome();
  log(`scenario ${feature.scenario}${feature.requestedScenario && feature.requestedScenario !== feature.scenario ? ` (requested "${feature.requestedScenario}" unknown)` : ""}, chrome ${chrome}`);

  const sides = {};
  for (const side of ["before", "after"]) {
    const root = side === "before" ? before : after;
    try {
      if (build) timings[`build_${side}`] = buildClient(root, PORTS[side], log);
      const t = Date.now();
      sides[side] = await recordSide({ root, out: path.join(out, side), scenario: feature.scenario, seed, secs, port: PORTS[side], game: feature.game, chrome, log });
      timings[`record_${side}`] = Date.now() - t;
    } catch (e) {
      errors.push(`${side}: ${e.message}`);
      log(`${side} failed: ${e.stack ?? e}`);
    }
  }

  // Gates judge what goes on stream: the after-run. A side that failed to record fails its gates.
  const a = sides.after;
  const details = {};
  const gate = (name, fn) => {
    if (!a) { details[name] = { result: "fail", error: "after-run not recorded" }; return "fail"; }
    try { details[name] = timed(timings, `gate_${name}`, fn); } catch (e) { details[name] = { result: "fail", error: e.message }; }
    return details[name].result;
  };
  const gates = {
    render: gate("render", () => renderGate(a.video, a.screenshots)),
    flash: gate("flash", () => flashGate(a.video)),
    audio: gate("audio", () => audioGate(a.audio)),
    ocr: gate("ocr", () => ocrGate(a.screenshots)),
    frameTime: gate("frameTime", () => frameTimeGate(a.frames, baseline)),
  };

  const media = (side) => sides[side] ? { video: rel(out, sides[side].video), screenshots: sides[side].screenshots.map((s) => rel(out, s)) } : { video: null, screenshots: [] };
  const index = {
    pr: pr === null || pr === undefined || pr === "" ? null : Number(pr),
    featureId: feature.featureId,
    game: { before: sides.before?.game ?? null, after: a?.game ?? null },
    headSha,
    scenario: feature.scenario,
    before: media("before"),
    after: media("after"),
    captions,
    gates,
  };
  timings.total = Date.now() - t0;
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  // Informational only: after vs before from this same runner (the gate uses the stored main baseline).
  let frameTimeSameRun = null;
  if (a && sides.before) {
    const sum = (s) => summarize(JSON.parse(fs.readFileSync(s.frames, "utf8")));
    const b = sum(sides.before);
    frameTimeSameRun = compare(sum(a), { sha: "before", scenarios: { [b.scenario]: b } });
  }
  const report = { index, seed, secs, frameTimeSameRun, shotTicks: a?.shotTicks ?? sides.before?.shotTicks ?? null, requestedScenario: feature.requestedScenario, simExceptions: { before: sides.before?.exceptions ?? null, after: a?.exceptions ?? null }, gates: details, timingsMs: timings, errors };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return { index, report, ok: errors.length === 0 && !Object.values(gates).includes("fail") };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values: v } = parseArgs({ options: {
    before: { type: "string" }, after: { type: "string" }, out: { type: "string", default: "presentation" },
    pr: { type: "string" }, "head-sha": { type: "string" }, baseline: { type: "string" },
    seed: { type: "string", default: "1337" }, secs: { type: "string", default: "20" }, "no-build": { type: "boolean", default: false },
  } });
  if (!v.before || !v.after) { console.error("--before <main checkout> --after <PR checkout> required"); process.exit(2); }
  const r = await runPresentation({ before: v.before, after: v.after, out: v.out, pr: v.pr ?? null, headSha: v["head-sha"] ?? null, baseline: v.baseline ?? null, seed: Number(v.seed), secs: Number(v.secs), build: !v["no-build"] });
  console.log(JSON.stringify(r.index, null, 2));
  console.log("timings (ms):", JSON.stringify(r.report.timingsMs));
  if (r.report.errors.length) console.error("errors:", r.report.errors.join("; "));
  for (const [k, g] of Object.entries(r.index.gates)) if (g === "fail") console.error(`gate ${k} failed: ${JSON.stringify(r.report.gates[k])}`);
  process.exit(r.ok ? 0 : 1);
}
