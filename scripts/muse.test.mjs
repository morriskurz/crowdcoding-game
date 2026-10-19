// Run: node --test scripts/muse.test.mjs (part of `pnpm test:agent`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEvents, buildPrompt, strayFiles, appendUsage, museEnv, parseArgs, muse, MODEL } from "./muse.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, "fixtures", n), "utf8");

test("parseEvents sums tokens and cost over a real Muse event stream", () => {
  const ev = parseEvents(fixture("muse-ok.jsonl"));
  assert.equal(ev.sessionId, "ses_eaf7e3959fferOxl13bGDU5sJp");
  assert.equal(ev.steps, 4);
  // input + cache.read per step: (2585+7409)+(175+9969)+(180+10097)+(188+10225)
  assert.equal(ev.tokensIn, 40828);
  // output + reasoning: (78+8)+(59+5)+(99+12)+(23+5)
  assert.equal(ev.tokensOut, 289);
  assert.equal(ev.costUsd, 0.0004460);
  assert.deepEqual(ev.tools, ["read", "read", "edit"]);
  assert.deepEqual(ev.editedFiles, ["/work/repo/a.ts"]);
  assert.equal(ev.finishReason, "stop");
  assert.match(ev.text, /Changed `x` to 2/);
  assert.deepEqual(ev.errors, []);
});

test("parseEvents reports error events and ignores junk lines", () => {
  const ev = parseEvents("not json\n\n" + fixture("muse-error.jsonl"));
  assert.equal(ev.steps, 1);
  assert.equal(ev.tokensIn, 3000);
  assert.equal(ev.tokensOut, 100);
  assert.deepEqual(ev.errors, ["Unexpected server error. Check server logs for details."]);
  assert.deepEqual(parseEvents("").errors, []);
});

test("buildPrompt carries only the task and the file list", () => {
  const p = buildPrompt("Make pellets glow.", ["packages/games/g/assets.ts"]);
  assert.match(p, /Edit ONLY these files: packages\/games\/g\/assets\.ts\./);
  assert.match(p, /Task:\nMake pellets glow\.$/);
});

test("strayFiles flags new dirty files outside the targets", () => {
  assert.deepEqual(strayFiles(["x.ts"], ["x.ts", "a.ts", "b.ts", "usage-opencode.json"], ["a.ts"]), ["b.ts"]);
  assert.deepEqual(strayFiles([], ["./a.ts"], ["a.ts"]), []);
});

test("appendUsage appends to an array file, recovering from junk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-"));
  const f = path.join(dir, "u.json");
  fs.writeFileSync(f, "{oops");
  appendUsage(f, { a: 1 });
  appendUsage(f, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), [{ a: 1 }, { a: 2 }]);
  fs.rmSync(dir, { recursive: true });
});

test("museEnv strips secrets, sets placeholder key and deny config", () => {
  const e = museEnv({ PATH: "/bin", FEED_SECRET: "s", BOT_URL: "u", GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(Object.keys(e).sort(), ["OPENCODE_API_KEY", "OPENCODE_CONFIG_CONTENT", "PATH"]);
  assert.equal(e.OPENCODE_API_KEY, "placeholder");
  assert.equal(JSON.parse(e.OPENCODE_CONFIG_CONTENT).permission.bash, "deny");
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--files", "a.ts,b.ts", "--timeout", "9", "--", "do", "it"]), { files: ["a.ts", "b.ts"], timeoutS: 9, dryRun: false, prompt: "do it" });
});

// End to end against a fake `opencode` that replays the fixture, edits the target and one stray file.
function fakeRepo({ exitCode = 0, sleep = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-e2e-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "b.ts"), "export const y = 1;\n");
  g("add", "-A"); g("commit", "-qm", "base");
  const bin = path.join(dir, "fake-opencode.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "run" || !args.includes("--auto") || args[args.indexOf("-m") + 1] !== ${JSON.stringify(MODEL)}) process.exit(64);
if (!JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).permission) process.exit(65);
${sleep ? `await new Promise((r) => setTimeout(r, ${sleep}));` : ""}
fs.writeFileSync("a.ts", "export const x = 2;\\n");
if (args.at(-1).includes("STRAY")) fs.writeFileSync("b.ts", "export const y = 666;\\n"), fs.writeFileSync("c.ts", "new");
process.stdout.write(${JSON.stringify(fixture("muse-ok.jsonl"))});
process.exit(${exitCode});
`);
  fs.chmodSync(bin, 0o755);
  // keep the fake bin out of the dirty set
  fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "fake-opencode.mjs\n");
  return { dir, bin, read: (f) => fs.readFileSync(path.join(dir, f), "utf8"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("muse(): clean run edits target, meters usage", async () => {
  const r = fakeRepo();
  try {
    const res = await muse({ files: ["a.ts"], prompt: "set x to 2", cwd: r.dir, bin: r.bin });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(r.read("a.ts"), "export const x = 2;\n");
    const usage = JSON.parse(r.read("usage-opencode.json"));
    assert.equal(usage.length, 1);
    assert.deepEqual(Object.keys(usage[0]), ["at", "model", "tokensIn", "tokensOut", "costUsd", "ok"]);
    assert.equal(usage[0].tokensOut, 289);
    assert.equal(usage[0].ok, true);
  } finally { r.done(); }
});

test("muse(): stray edits are reverted and fail the run", async () => {
  const r = fakeRepo();
  try {
    const res = await muse({ files: ["a.ts"], prompt: "STRAY", cwd: r.dir, bin: r.bin });
    assert.equal(res.ok, false);
    assert.deepEqual(res.strayReverted.sort(), ["b.ts", "c.ts"]);
    assert.equal(r.read("b.ts"), "export const y = 1;\n");
    assert.ok(!fs.existsSync(path.join(r.dir, "c.ts")));
    assert.equal(JSON.parse(r.read("usage-opencode.json"))[0].ok, false);
  } finally { r.done(); }
});

test("muse(): timeout kills the process and records ok:false", async () => {
  const r = fakeRepo({ sleep: 5000 });
  try {
    const res = await muse({ files: ["a.ts"], prompt: "slow", cwd: r.dir, bin: r.bin, timeoutS: 0.5 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.equal(JSON.parse(r.read("usage-opencode.json"))[0].ok, false);
  } finally { r.done(); }
});

test("muse(): nonzero exit or missing binary is not ok", async () => {
  const r = fakeRepo({ exitCode: 1 });
  try {
    assert.equal((await muse({ files: ["a.ts"], prompt: "x", cwd: r.dir, bin: r.bin })).ok, false);
    const missing = await muse({ files: ["a.ts"], prompt: "x", cwd: r.dir, bin: path.join(r.dir, "nope") });
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, 127);
  } finally { r.done(); }
});

test("muse(): dry run spawns nothing", async () => {
  const res = await muse({ files: ["a.ts"], prompt: "x", dryRun: true });
  assert.equal(res.dryRun, true);
  await assert.rejects(muse({ files: [], prompt: "x" }), /--files/);
});
