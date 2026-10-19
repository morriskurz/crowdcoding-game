// One command for every gate the orchestrator runs after each task:
//   guard -> pnpm -r check -> pnpm -r test -> client build -> local smoke (wrangler dev + scripts/smoke.mjs)
// Prints one short JSON summary line on stdout; exit 0 only when every gate is green.
// Full step logs go to $GATES_LOG_DIR (default os.tmpdir()/gates); a failing step's tail is in the summary.
//
// Run: node scripts/gates.mjs [--skip smoke,build] [--all] [--keep-going]
//   --skip   comma list of step names to skip (reported as skipped, never as green)
//   --keep-going  run every step even after a failure
// Env: GATES_WRANGLER (default wrangler@4.115.0, same as deploy.yml), SMOKE_N (default 30).
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { writeRegistry } from "./registry.mjs";

export const STEPS = ["guard", "check", "test", "build", "smoke"];
const WRANGLER = process.env.GATES_WRANGLER ?? "wrangler@4.115.0";
const LOG_DIR = process.env.GATES_LOG_DIR ?? path.join(os.tmpdir(), "gates");
const TAIL_LINES = 12;

export function parseArgs(argv) {
  const a = { skip: [], keepGoing: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip") a.skip.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (argv[i] === "--keep-going" || argv[i] === "--all") a.keepGoing = true;
  }
  const bad = a.skip.filter((s) => !STEPS.includes(s));
  if (bad.length) throw new Error(`unknown step(s): ${bad.join(",")}`);
  return a;
}

export function tail(text, n = TAIL_LINES) {
  // drop ANSI colour codes; the first error-looking lines (what a builder needs) + the last few lines
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.trim());
  const errs = lines.filter((l) => /error|fail|assert|expected|GUARD|✗|×/i.test(l) && !/ERR_PNPM_RECURSIVE|ELIFECYCLE/.test(l)).slice(0, n - 4);
  const last = lines.slice(-Math.max(4, n - errs.length));
  return [...new Set([...errs, ...last])].map((l) => l.slice(0, 300)).join("\n");
}

/** Workerd in a pinned wrangler can be older than wrangler.jsonc's compatibility_date. */
export function maxCompatDate(log) {
  return log.match(/newest date supported by this server binary is "(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null;
}

/** Summary object from step results. */
export function summarize(results, branch) {
  const failed = results.find((r) => r.status === "fail");
  return {
    ok: !failed,
    complete: !failed && results.every((r) => r.status === "pass"),
    green: results.filter((r) => r.status === "pass").map((r) => r.name),
    skipped: results.filter((r) => r.status === "skip").map((r) => r.name),
    ...(failed ? { failed: failed.name, tail: failed.tail } : {}),
    branch,
    seconds: Math.round(results.reduce((s, r) => s + (r.ms ?? 0), 0) / 1000),
  };
}

function run(name, cmd, args, { env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `${name}.log`);
    const t0 = Date.now();
    const child = spawn(cmd, args, { env: { ...process.env, FORCE_COLOR: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => { out += `\n[gates] ${name} timed out after ${timeoutMs / 1000}s`; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { out += `\n${e}`; });
    child.on("close", (code) => {
      clearTimeout(t);
      fs.writeFileSync(logFile, out);
      resolve({ code: code ?? 1, out, ms: Date.now() - t0, logFile });
    });
  });
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitHealthy(port, child, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && child.exitCode === null) {
    try {
      const r = await globalThis.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startWrangler(port, compatDate) {
  const args = ["dlx", WRANGLER, "dev", "--port", String(port), "--ip", "127.0.0.1", "--log-level", "warn", "--show-interactive-dev-session=false"];
  if (compatDate) args.push("--compatibility-date", compatDate);
  // own process group, so the whole wrangler/workerd tree can be killed
  const child = spawn("pnpm", args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" } });
  child.log = "";
  child.stdout.on("data", (d) => { child.log += d; });
  child.stderr.on("data", (d) => { child.log += d; });
  child.stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000).unref(); };
  return child;
}

async function smoke() {
  const t0 = Date.now();
  const port = await freePort();
  let compat = null;
  let w = startWrangler(port, compat);
  let up = await waitHealthy(port, w, 90_000);
  if (!up && (compat = maxCompatDate(w.log))) {
    w.stop();
    await new Promise((r) => setTimeout(r, 1000));
    w = startWrangler(port, compat);
    up = await waitHealthy(port, w, 90_000);
  }
  let out = w.log;
  let code = 1;
  try {
    if (!up) out += "\n[gates] wrangler dev never became healthy";
    else {
      const room = `gates${Date.now().toString(36)}`;
      const r = await run("smoke-bots", process.execPath, ["scripts/smoke.mjs", `ws://127.0.0.1:${port}/parties/preview/${room}`], { timeoutMs: 60_000 });
      out = `${compat ? `[gates] local compatibility-date override ${compat}\n` : ""}${r.out}`;
      code = r.code;
    }
  } finally { w.stop(); }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, "smoke.log"), `${w.log}\n----\n${out}`);
  return { code, out, ms: Date.now() - t0 };
}

const STEP_IMPL = {
  guard: () => run("guard", process.execPath, ["scripts/guard.mjs"]),
  check: () => run("check", "pnpm", ["-r", "check"]),
  test: () => run("test", "pnpm", ["-r", "test"]),
  build: () => run("build", "pnpm", ["--filter", "@tcg/client", "build"]),
  smoke,
};

export async function gates({ skip = [], keepGoing = false } = {}) {
  // The game registry is generated from packages/games/*: refresh it so a game added on this branch
  // (bootstrap) is the one that gets checked, built and smoked. Warnings go to stderr.
  writeRegistry(process.cwd(), (m) => console.error(m));
  const results = [];
  let failed = false;
  for (const name of STEPS) {
    if (skip.includes(name) || (failed && !keepGoing)) { results.push({ name, status: "skip" }); continue; }
    const r = await STEP_IMPL[name]();
    const pass = r.code === 0;
    results.push({ name, status: pass ? "pass" : "fail", ms: r.ms, ...(pass ? {} : { tail: tail(r.out) }) });
    if (!pass) failed = true;
  }
  let branch = process.env.GITHUB_HEAD_REF || "";
  if (!branch) {
    const b = await run("branch", "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = b.out.trim();
  }
  return summarize(results, branch);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const s = await gates(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(s));
    process.exit(s.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    process.exit(2);
  }
}
