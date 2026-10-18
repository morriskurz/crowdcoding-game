// Frame-time baseline for main: record every scenario once and write frametime-baseline.json
// (uploaded by present-baseline.yml as artifact `frametime-baseline`, read by gates/frametime.mjs).
//
// Run: node scripts/present/baseline.mjs --root <main checkout> --out baseline [--sha <sha>]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { buildClient, PORTS } from "./run.mjs";
import { recordSide, findChrome } from "./record.mjs";
import { SCENARIOS } from "../scenarios/index.mjs";
import { makeBaseline } from "../gates/frametime.mjs";

const { values: v } = parseArgs({ options: { root: { type: "string", default: "." }, out: { type: "string", default: "baseline" }, sha: { type: "string" }, seed: { type: "string", default: "1337" }, secs: { type: "string", default: "20" } } });
const out = path.resolve(v.out);
fs.mkdirSync(out, { recursive: true });
const sha = v.sha ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: v.root, encoding: "utf8" }).trim();
const chrome = findChrome();
buildClient(v.root, PORTS.after);
const files = [];
for (const name of Object.keys(SCENARIOS)) {
  const r = await recordSide({ root: v.root, out: path.join(out, name), scenario: name, seed: Number(v.seed), secs: Number(v.secs), port: PORTS.after, chrome });
  files.push(r.frames);
}
const baseline = makeBaseline(sha, files);
fs.writeFileSync(path.join(out, "frametime-baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
console.log(JSON.stringify(baseline, null, 2));
process.exit(0);
