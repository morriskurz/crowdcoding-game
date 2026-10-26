// Look at your own result before calling it done. Records the same before/after the ship vote shows
// (scripts/present/run.mjs: same seed, same scenario, headless Chrome) for the working tree against
// origin/main, so builders and the reviewer can open the screenshots and judge what viewers will see.
// Crowdcoding feature #8 shipped "drifters" that ate "motes" and never met a player: every gate was
// green because no gate looked at the game. This is that look.
//
// Run:  node scripts/preview.mjs [--after-only] [--secs 12] [--out .orchestrator/preview]
//   --after-only  record only the working tree (quick look for a single visual task, ~20 s)
// Prints one JSON line: {ok, headSha, packagesTree, scenario, before: [png], after: [png], errors, gates}.
// The content gates are informational here (CI runs them for real); `ok` means both sides recorded.
// The before side is a worktree of origin/main at .orchestrator/preview-base (reused between runs).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_OUT = ".orchestrator/preview";
const BASE = ".orchestrator/preview-base";

const git = (args, cwd = process.cwd()) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Hash of what the game is made of: the packages/ and apps/ trees of the working tree (staged or not).
 * A review is only valid for the code it looked at; any later code edit changes this hash.
 */
export function codeTree(cwd = process.cwd()) {
  const idx = path.join(cwd, ".orchestrator", "preview.index");
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const run = (args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run(["read-tree", "HEAD"]);
  run(["add", "-A", "--", "packages", "apps"]);
  const tree = run(["write-tree"]);
  return execFileSync("git", ["rev-parse", `${tree}:packages`], { cwd, encoding: "utf8" }).trim() + "+" + execFileSync("git", ["rev-parse", `${tree}:apps`], { cwd, encoding: "utf8" }).trim();
}

/** origin/main as a worktree with dependencies, refreshed when main moved. */
function ensureBase(log) {
  const want = git(["rev-parse", "origin/main"]);
  if (fs.existsSync(path.join(BASE, ".git"))) {
    let have = null;
    try { have = git(["rev-parse", "HEAD"], BASE); } catch {}
    if (have === want) return path.resolve(BASE);
    spawnSync("git", ["worktree", "remove", "--force", BASE], { stdio: "ignore" });
  }
  fs.rmSync(BASE, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { stdio: "ignore" });
  git(["worktree", "add", "-q", "--detach", BASE, want]);
  const r = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], { cwd: BASE, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pnpm install in ${BASE} failed: ${(r.stderr ?? "").slice(-300)}`);
  spawnSync(process.execPath, ["scripts/registry.mjs"], { cwd: BASE, stdio: "ignore" });
  log(`preview base: origin/main ${want.slice(0, 7)}`);
  return path.resolve(BASE);
}

export async function preview({ afterOnly = false, secs = 12, out = DEFAULT_OUT, log = (m) => console.error(m) } = {}) {
  const after = process.cwd();
  const headSha = git(["rev-parse", "HEAD"]);
  const packagesTree = codeTree(after);
  // The pipeline is loaded from this checkout's scripts/present (frozen for agents, so it is main's).
  const { runPresentation, buildClient, readFeature, PORTS } = await import(pathToFileURL(path.join(after, "scripts/present/run.mjs")).href);
  const { recordSide, findChrome } = await import(pathToFileURL(path.join(after, "scripts/present/record.mjs")).href);
  const quiet = (m) => log(`[present] ${m}`);
  if (afterOnly) {
    const dir = path.resolve(out, "after");
    fs.rmSync(path.resolve(out), { recursive: true, force: true });
    const feature = readFeature(after);
    const errors = [];
    let side = null;
    try {
      buildClient(after, PORTS.after, quiet);
      side = await recordSide({ root: after, out: dir, scenario: feature.scenario, explicit: feature.explicit, secs, port: PORTS.after, game: feature.game, chrome: findChrome(), log: quiet });
    } catch (e) { errors.push(`after: ${e.message}`); }
    const res = { ok: Boolean(side) && !side.exceptions, headSha, packagesTree, scenario: side?.scenario ?? feature.scenario, before: [], after: side?.screenshots ?? [], video: side?.video ?? null, simExceptions: side?.exceptions ?? null, errors };
    fs.mkdirSync(path.resolve(out), { recursive: true });
    fs.writeFileSync(path.resolve(out, "preview.json"), JSON.stringify(res, null, 2) + "\n");
    return res;
  }
  const before = ensureBase(log);
  const r = await runPresentation({ before, after, out, headSha, secs, log: quiet });
  const abs = (p) => path.resolve(out, p);
  const res = {
    ok: r.index.after.screenshots.length > 0 && r.index.before.screenshots.length > 0,
    headSha, packagesTree, scenario: r.index.scenario,
    before: r.index.before.screenshots.map(abs), after: r.index.after.screenshots.map(abs),
    video: { before: r.index.before.video && abs(r.index.before.video), after: r.index.after.video && abs(r.index.after.video) },
    simExceptions: r.report.simExceptions, errors: r.report.errors, gates: r.index.gates,
  };
  fs.writeFileSync(path.resolve(out, "preview.json"), JSON.stringify(res, null, 2) + "\n");
  return res;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  try {
    const r = await preview({ afterOnly: argv.includes("--after-only"), secs: Number(val("--secs", "12")), out: val("--out", DEFAULT_OUT) });
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    process.exit(2);
  }
}
