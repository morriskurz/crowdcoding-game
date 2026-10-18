import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Deterministic guard (spec §4, §8). A fast-fail lint, not the security boundary.
// 1. Content: banned APIs + import allowlist in game, client and server sources.
// 2. Agent branches (f/*) only: diff vs GUARD_BASE (default origin/main) changes no frozen file,
//    and every changed file under packages/games/ is listed in the committed task plan
//    (tasks.json at HEAD). Branch = GITHUB_HEAD_REF, else GITHUB_REF_NAME, else git HEAD.

export const ROOTS = ["packages/games", "apps/client/src", "apps/server/src"];

// bare fetch( banned (agents have no legit use). stub.fetch / env.ASSETS.fetch allowed (dot before).
export const DENY = [
  /(^|[^.\w])fetch\s*\(/,           // fetch(url), fetch(target) — any arg
  /eval\s*\(/,
  /new\s+Function/,
  /\.innerHTML\s*=/,
  /\bimport\s*\(/,                  // every dynamic import, any argument (spec §4, §12)
  /["'`]cloudflare:/,               // cloudflare:workers, cloudflare:sockets, ... (spec §4)
  /require\s*\(/,
  /child_process/,
  /node:/,                          // node:fs, node:child, etc.
  /\bfrom\s+["']fs["']/,            // bare 'fs'
  /\bfrom\s+["'](ws|net|http|https|dgram|cluster)["']/,
];
export const ALLOW_IMPORT = [/^@tcg\/shared/, /^@tcg\/kit$/, /^@tcg\/game-template/, /^partyserver/, /^partysocket/, /^\.\//, /^\.\.\//, /^tmi\.js$/, /^ws$/, /^vitest$/];

// Frozen paths (spec §8). Entries ending in "/" are directory prefixes.
export const FROZEN = [
  "packages/shared/src/",
  "packages/kit/",
  "apps/server/src/room.ts",
  "apps/client/src/net.ts",
  "apps/streamer/",
  ".github/",
];

const matches = (entry, file) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry);
const norm = (p) => p.replace(/^\.\//, "");

/** Content check for one source file. Returns error strings. */
export function scanSource(file, src) {
  const errors = [];
  // `from "x"`, `export ... from "x"` and side-effect `import "x"`
  for (const m of src.matchAll(/(?:\bfrom|^\s*import)\s*["']([^"']+)["']/gm)) {
    if (!ALLOW_IMPORT.some((re) => re.test(m[1]))) errors.push(`GUARD ${file}: blocked import ${m[1]}`);
  }
  // worker entry `async fetch(req` is a method definition, not a call
  const scrubbed = src.replace(/^\s*async\s+fetch\s*\(/gm, "METHOD_DEF(");
  for (const re of DENY) {
    if (re.test(scrubbed)) errors.push(`GUARD ${file}: blocked pattern ${re}`);
  }
  return errors;
}

/** Files listed in the task plan: tasks.json is an array of tasks with optional `files: string[]`. */
export function planFiles(tasksJson) {
  const tasks = JSON.parse(tasksJson);
  if (!Array.isArray(tasks)) throw new Error("tasks.json must be an array of tasks");
  return tasks.flatMap((t) => (Array.isArray(t?.files) ? t.files.filter((f) => typeof f === "string").map(norm) : []));
}

/** Diff check: frozen files and plan coverage. `plan` is null when tasks.json is missing at HEAD. */
export function checkDiff(changed, plan) {
  const errors = [];
  const frozen = changed.filter((f) => FROZEN.some((e) => matches(e, f)));
  if (frozen.length) errors.push(`GUARD changed frozen: ${frozen.join(",")}`);
  const games = changed.filter((f) => f.startsWith("packages/games/"));
  const unplanned = games.filter((f) => !(plan ?? []).some((e) => matches(e, f)));
  if (unplanned.length) {
    errors.push(`GUARD changed files not in committed tasks.json plan: ${unplanned.join(",")}${plan ? "" : " (no tasks.json at HEAD)"}`);
  }
  return errors;
}

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.name === "node_modules" || e.name === "dist") return [];
    if (e.isDirectory()) return walk(p);
    return p.endsWith(".ts") || p.endsWith(".js") ? [p] : [];
  });
}

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Frozen + plan-diff checks apply to agent feature branches only (spec §8: one feature = f/<id>-slug).
// Owner infra branches and main skip them; content checks run everywhere.
export const isAgentBranch = (branch) => /^f\//.test(branch);

export function currentBranch(env = process.env) {
  return env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git("rev-parse --abbrev-ref HEAD").trim();
}

function main() {
  const errors = [];
  for (const r of ROOTS) {
    if (!fs.existsSync(r)) continue;
    for (const f of walk(r)) errors.push(...scanSource(f, fs.readFileSync(f, "utf8")));
  }

  const branch = currentBranch();
  const base = process.env.GUARD_BASE ?? "origin/main";
  let hasRef = true;
  try { git(`rev-parse --verify ${base}`); } catch { hasRef = false; }
  if (!isAgentBranch(branch)) console.log(`guard: branch "${branch}" is not an agent branch (f/*), skipping frozen + plan-diff checks`);
  else if (!hasRef) console.log(`guard: no base ref ${base}, skipping diff checks`);
  else {
    const changed = git(`diff --name-only ${base}...HEAD`).split("\n").filter(Boolean);
    let plan = null;
    try { plan = planFiles(git("show HEAD:tasks.json")); }
    catch (e) { if (!/does not exist|exists on disk, but not in/.test(String(e.stderr ?? e))) throw e; }
    errors.push(...checkDiff(changed, plan));
  }

  for (const e of errors) console.error(e);
  if (errors.length) { console.error("guard failed"); process.exit(1); }
  console.log("guard ok");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
