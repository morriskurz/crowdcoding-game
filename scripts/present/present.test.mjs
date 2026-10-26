// Tests for the presentation pipeline: gates on synthetic media, caption filter, scenarios, sim
// determinism. Needs ffmpeg (and tesseract for the OCR test). Run: node --test scripts/present/present.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeFlashes, flashGate } from "../gates/flash.mjs";
import { audioGate } from "../gates/audio.mjs";
import { checkText, ocrGate } from "../gates/ocr.mjs";
import { compare, summarize } from "../gates/frametime.mjs";
import { filterCaptions, findSlurs, loadHashes } from "../gates/wordlist.mjs";
import { SCENARIOS, inferScenario, resolveScenario, DEFAULT_SCENARIO } from "../scenarios/index.mjs";
import { createSim, loadGame } from "./server.mjs";
import { concatList } from "./record.mjs";
import { readFeature } from "./run.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "present-test-"));
const ff = (...args) => {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  assert.equal(r.status, 0, String(r.stderr));
};
const has = (bin) => spawnSync(bin, ["-version"]).status === 0;
const TEST_WORD = "zorblax";
const testHashes = () => loadHashes({ SLUR_TEST_WORDS: TEST_WORD });

test("flash: series analysis counts jumps per 1 s window", () => {
  const steady = Array.from({ length: 50 }, (_, i) => ({ t: i / 25, y: 40 + (i % 2) }));
  assert.equal(analyzeFlashes(steady).result, "pass");
  // 3 flashes in a second is allowed, 4 is not
  const three = steady.map((s, i) => ({ ...s, y: [5, 10, 15].includes(i) ? 200 : s.y }));
  assert.equal(analyzeFlashes(three).maxFlashesIn1s, 6); // each spike is an up and a down jump
  const two = steady.map((s, i) => ({ ...s, y: i >= 5 && i < 15 ? 200 : s.y }));
  assert.equal(analyzeFlashes(two).result, "pass");
  const slow = steady.map((s, i) => ({ ...s, y: Math.floor(i / 13) % 2 ? 200 : 40 })); // ~2 Hz
  assert.equal(analyzeFlashes(slow).result, "pass");
  const fast = steady.map((s, i) => ({ ...s, y: Math.floor(i / 3) % 2 ? 200 : 40 })); // ~4 Hz
  assert.equal(analyzeFlashes(fast).result, "fail");
});

test("flash: real video, 5 Hz black/white strobe fails, gentle fade passes", { skip: !has("ffmpeg") }, () => {
  const strobe = path.join(tmp, "strobe.mp4");
  ff("-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=3", "-vf", "geq=lum='if(lt(mod(T*10,2),1),235,16)':cb=128:cr=128", "-pix_fmt", "yuv420p", strobe);
  assert.equal(flashGate(strobe).result, "fail");
  const fade = path.join(tmp, "fade.mp4");
  ff("-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=3", "-vf", "geq=lum='16+T*60':cb=128:cr=128", "-pix_fmt", "yuv420p", fade);
  assert.equal(flashGate(fade).result, "pass");
});

test("audio: full-scale tone fails, -6 dBFS passes, silence passes", { skip: !has("ffmpeg") }, () => {
  const loud = path.join(tmp, "loud.wav");
  ff("-f", "lavfi", "-i", "sine=f=440:d=1", "-af", "volume=10", "-c:a", "pcm_f32le", loud);
  const l = audioGate(loud);
  assert.equal(l.result, "fail");
  assert.ok(l.peakDbfs > -1);
  const quiet = path.join(tmp, "quiet.wav");
  ff("-f", "lavfi", "-i", "sine=f=440:d=1", "-af", "volume=4", "-c:a", "pcm_f32le", quiet);
  const q = audioGate(quiet);
  assert.equal(q.result, "pass");
  assert.ok(q.peakDbfs < -5 && q.peakDbfs > -7, String(q.peakDbfs));
  const silent = path.join(tmp, "silent.wav");
  ff("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1", "-c:a", "pcm_f32le", silent);
  assert.deepEqual([audioGate(silent).result, audioGate(silent).silent], ["pass", true]);
});

test("wordlist: hashed list matches, leet and repeats, no plain words committed", () => {
  const h = testHashes();
  assert.deepEqual(findSlurs(`hello ${TEST_WORD} there`, h), [TEST_WORD]);
  assert.equal(findSlurs("Z0RBL4X!", h).length, 1);
  assert.equal(findSlurs("zorrrblaaax", h).length, 1);
  assert.equal(findSlurs("zorbla x", h).length, 0);
  assert.equal(findSlurs("Niger river con man Japan cocktail scrapbook", loadHashes({})).length, 0);
  const doc = JSON.parse(fs.readFileSync(new URL("../gates/slur-hashes.json", import.meta.url), "utf8"));
  assert.ok(doc.sha256.length > 20 && doc.sha256.every((x) => /^[0-9a-f]{64}$/.test(x)));
});

test("captions: strings only, slurs dropped, control chars stripped, 140 char cap", () => {
  const h = testHashes();
  const out = filterCaptions(["ok one", 42, null, `bad ${TEST_WORD}`, "x".repeat(300), "a‮b\nc", "   "], h);
  assert.deepEqual(out, ["ok one", "x".repeat(140), "a b c"]);
  assert.deepEqual(filterCaptions({ not: "array" }, h), []);
});

test("ocr: text check counts hits and spaced-out letters", () => {
  const h = testHashes();
  assert.equal(checkText("score 12\nlive build", h).hits, 0);
  assert.ok(checkText(`player ${TEST_WORD}`, h).hits > 0);
  assert.ok(checkText("z o r b l a x", h).hits > 0);
});

test("ocr: tesseract reads a rendered word", { skip: !has("ffmpeg") || spawnSync("tesseract", ["--version"]).status !== 0 }, () => {
  const img = path.join(tmp, "word.png");
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=640x160", "-vf", `drawtext=text='${TEST_WORD.toUpperCase()} WINS':fontsize=72:fontcolor=black:x=20:y=40`, "-frames:v", "1", img]);
  if (r.status !== 0) return; // ffmpeg without drawtext/fontconfig
  process.env.SLUR_TEST_WORDS = TEST_WORD;
  try { assert.equal(ocrGate([img]).result, "fail"); } finally { delete process.env.SLUR_TEST_WORDS; }
  assert.equal(ocrGate([img]).result, "pass");
});

test("frametime: pass, fail only when raw and normalized both regress, no-baseline", () => {
  const side = (p95Ms, calibMs, scenario = "idle-crowd", seed = 1337) => ({ scenario, seed, samples: 300, p95Ms, calibMs, norm: p95Ms / calibMs });
  const baseline = { sha: "abc", scenarios: { "idle-crowd": side(1.0, 4.0) } };
  assert.equal(compare(side(1.1, 4.0), baseline).result, "pass");
  assert.equal(compare(side(1.3, 4.0), baseline).result, "fail");
  assert.equal(compare(side(1.3, 5.2), baseline).result, "pass"); // slower runner: calibration slower too
  assert.equal(compare(side(1.1, 3.0), baseline).result, "pass"); // calibration noise alone
  assert.equal(compare(side(1.0, 4.0, "chase"), baseline).result, "no-baseline");
  assert.equal(compare(side(1.0, 4.0, "idle-crowd", 7), baseline).result, "no-baseline");
  assert.equal(compare(side(1.0, 4.0), null).result, "no-baseline");
  const s = summarize({ scenario: "chase", seed: 1, frameMs: Array.from({ length: 100 }, (_, i) => i / 100), calibMs: 2 });
  assert.equal(s.p95Ms, 0.94);
});

test("scenarios: fixed list, untrusted names fall back to the default", () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), ["chase", "collect", "idle-crowd", "play"]);
  for (const bad of [undefined, 3, "nope", "__proto__", "constructor", "toString"]) assert.equal(resolveScenario(bad).name, DEFAULT_SCENARIO);
  assert.equal(resolveScenario("chase").name, "chase");
});

test("feature.json: id and scenario parsed defensively", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "feat-"));
  assert.deepEqual(readFeature(dir), { featureId: null, game: null, scenario: DEFAULT_SCENARIO, explicit: false, requestedScenario: null });
  fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({ id: 7, slug: "x", game: "snake", scenario: "chase" }));
  assert.deepEqual(readFeature(dir), { featureId: "7", game: "snake", scenario: "chase", explicit: true, requestedScenario: "chase" });
  for (const game of ["../x", "main", "A", 5]) {
    fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({ id: 7, game }));
    assert.equal(readFeature(dir).game, null, String(game));
  }
  fs.writeFileSync(path.join(dir, "feature.json"), "[1,2]");
  assert.equal(readFeature(dir).featureId, null);
  // No (or an unknown) scenario: inferred from the spec; a known one always wins.
  fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({ id: 5, spec: "a burst of particles when a player scores, for all players" }));
  assert.equal(readFeature(dir).scenario, "collect");
  fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({ id: 5, spec: "a burst of particles when a player scores", scenario: "nope" }));
  assert.deepEqual(readFeature(dir), { featureId: "5", game: null, scenario: "collect", explicit: false, requestedScenario: "nope" });
  fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({ id: 5, spec: "a burst of particles when a player scores", scenario: "idle-crowd" }));
  assert.equal(readFeature(dir).scenario, "idle-crowd");
});

test("scenarios: inferred from the spec by keyword", () => {
  assert.equal(inferScenario("a burst of particles when a player scores, for all players"), "collect");
  assert.equal(inferScenario("pellets glow for all players"), "collect");
  assert.equal(inferScenario("Computer-controlled enemies added for all players to compete against"), "chase");
  assert.equal(inferScenario("players leave a trail of sparks"), "chase");
  assert.equal(inferScenario("the arena background turns purple at night"), DEFAULT_SCENARIO);
  for (const bad of [undefined, null, 5, {}]) assert.equal(inferScenario(bad), DEFAULT_SCENARIO);
});

test("loadGame: registry game by slug, unknown slug falls back to the current game", async () => {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const cur = await loadGame(root);
  assert.ok(cur.game && typeof cur.rules.step === "function", JSON.stringify(cur.gamePkg));
  assert.equal((await loadGame(root, "template")).game, "template");
  assert.equal((await loadGame(root, "no-such-game")).game, cur.game);
});

test("sim: same seed + scenario => identical world; different seed differs", async () => {
  const { shared, rules } = await loadGame(path.resolve(new URL("../..", import.meta.url).pathname));
  for (const name of Object.keys(SCENARIOS)) {
    const run = (seed) => {
      const sim = createSim(shared, rules, { seed, scenario: name });
      for (let i = 0; i < 300; i++) sim.step();
      assert.equal(sim.exceptions, 0);
      return JSON.stringify(sim.world);
    };
    assert.equal(run(1337), run(1337), name);
    assert.notEqual(run(1337), run(1338), name);
  }
});

test("sim: a game with its own bot plays itself unless the scenario was named", async () => {
  const { shared, rules } = await loadGame(path.resolve(new URL("../..", import.meta.url).pathname));
  const fake = { ...rules, bot: () => ({ dx: 5, dy: 0, action: true }) };
  assert.equal(createSim(shared, fake, { seed: 1, scenario: "chase", explicit: false }).scenario.name, "play");
  assert.equal(createSim(shared, fake, { seed: 1, scenario: "chase", explicit: true }).scenario.name, "chase");
  const { bot: _none, ...botless } = rules;
  assert.equal(createSim(shared, botless, { seed: 1, scenario: "chase", explicit: false }).scenario.name, "chase");
  // play: the game bot's input, clamped; a throwing or broken bot falls back to the idle crowd.
  const inputs = [];
  const spy = { ...fake, step(w, inp) { inputs.push(inp); return rules.step(w, inp); } };
  createSim(shared, spy, { seed: 1, scenario: "play" }).step();
  assert.deepEqual(inputs[0].bot0, { dx: 1, dy: 0, action: true });
  inputs.length = 0;
  createSim(shared, { ...spy, bot: () => { throw new Error("x"); } }, { seed: 1, scenario: "play" }).step();
  assert.equal(inputs[0].bot0.action, false);
});

test("video: concat list covers exactly the clip", () => {
  const frames = [0.5, 0.9, 1.0, 1.7, 2.6].map((t, i) => ({ file: `f${i}.jpg`, t: 100 + t }));
  const list = concatList(frames, 100.8, 1.5).trim().split("\n");
  assert.equal(list[0], "file 'f0.jpg'"); // last frame before the clip start
  const total = list.filter((l) => l.startsWith("duration")).reduce((s, l) => s + Number(l.split(" ")[1]), 0);
  assert.ok(Math.abs(total - 1.5) < 1e-3, String(total));
});

test("render gate fails a frozen or blank recording", async () => {
  const { judgeRender } = await import("../gates/render.mjs");
  assert.equal(judgeRender({ meanYdif: 0.35, shotHashes: ["a", "b", "c"] }).result, "pass");
  assert.equal(judgeRender({ meanYdif: 0.0, shotHashes: ["a", "b", "c"] }).result, "fail");
  assert.equal(judgeRender({ meanYdif: 0.35, shotHashes: ["a", "a", "a"] }).result, "fail");
  assert.equal(judgeRender({ meanYdif: NaN, shotHashes: ["a", "b"] }).result, "fail");
});
