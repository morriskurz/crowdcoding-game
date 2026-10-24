import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { currentSlug, gameEntry, sortGames } from "./registry.mjs";

// Deterministic guard (spec §4, §8). A fast-fail lint, not the security boundary.
// 1. Content: banned APIs + import allowlist in game, client and server sources.
// 2. Agent branches (f/*) only: diff vs GUARD_BASE (default origin/main) changes no frozen file,
//    and every changed file under packages/games/ is listed in the committed task plan
//    (tasks.json at HEAD), and no changed file is in an archived game: every game directory that
//    exists at the base except the current one (newest tcg.created at the base, same rule as
//    scripts/registry.mjs) is frozen. A bootstrap adds a new directory, so it is still allowed.
//    Branch = GITHUB_HEAD_REF, else GITHUB_REF_NAME, else git HEAD.

export const ROOTS = ["packages/games", "packages/registry", "packages/kit/src", "packages/shared/src", "apps/client/src", "apps/server/src"];

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
export const ALLOW_IMPORT = [/^@tcg\/shared/, /^@tcg\/kit$/, /^@tcg\/games$/, /^partyserver/, /^partysocket/, /^\.\//, /^\.\.\//, /^tmi\.js$/, /^ws$/, /^vitest$/, /^zod$/];

// Frozen paths (spec §8). Entries ending in "/" are directory prefixes.
// The engine (packages/shared, packages/kit, the client renderer) is not frozen since 2026-10-24 (owner
// decision): an agent may change it through an engine task that lists the file (ENGINE below).
export const FROZEN = [
  "apps/server/src/room.ts",
  "apps/client/src/net.ts",
  // Game registry: generated from packages/games/* (scripts/registry.mjs), so a new game needs no edit here.
  "packages/registry/",
  "scripts/registry.mjs",
  "apps/streamer/",
  ".github/",
  // Presentation pipeline: CI runs it from main, so a PR cannot weaken the gates that judge it;
  // freezing it also keeps a gate-weakening change from reaching main through a ship vote.
  "scripts/present/",
  "scripts/gates/",
  "scripts/scenarios/",
];

const GAME_PKG = /^packages\/games\/[^/]+\/package\.json$/;
// Engine paths an agent branch may change only when the committed plan lists the file.
export const ENGINE = ["packages/shared/", "packages/kit/", "apps/client/src/game/"];
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
  const games = changed.filter((f) => f.startsWith("packages/games/") || ENGINE.some((e) => f.startsWith(e)));
  const unplanned = games.filter((f) => !(plan ?? []).some((e) => matches(e, f)));
  if (unplanned.length) {
    errors.push(`GUARD changed files not in committed tasks.json plan: ${unplanned.join(",")}${plan ? "" : " (no tasks.json at HEAD)"}`);
  }
  // A game's package.json carries registry metadata (tcg.created picks the current game): only the
  // bootstrap task, whose plan entry is the whole new directory, may write it.
  const meta = games.filter((f) => GAME_PKG.test(f) && !unplanned.includes(f) && !(plan ?? []).some((e) => e.endsWith("/") && matches(e, f)));
  if (meta.length) errors.push(`GUARD game package.json changes only via the bootstrap task (directory plan entry): ${meta.join(",")}`);
  return errors;
}

/**
 * Archived games are frozen for agents: no new features for an old week's game. `baseDirs` are the
 * game directories at the base ref, `current` the base's current game (null: check skipped).
 */
export function checkArchived(changed, baseDirs, current) {
  if (!current) return [];
  const archived = new Set(baseDirs.filter((d) => d !== current));
  const hits = changed.filter((f) => archived.has(f.match(/^packages\/games\/([^/]+)\//)?.[1]));
  return hits.length ? [`GUARD changed archived game (only the current game "${current}" or a new bootstrap game may change): ${hits.join(",")}`] : [];
}

/** Game directories and the current game at a git ref, computed like scripts/registry.mjs. */
export function gamesAt(ref, gitFn = git) {
  const dirs = gitFn(`ls-tree -d --name-only ${ref} packages/games/`).split("\n").filter(Boolean).map((p) => p.slice("packages/games/".length)).filter((d) => d !== "node_modules");
  const games = [];
  for (const d of dirs) {
    const files = gitFn(`ls-tree --name-only ${ref} packages/games/${d}/`).split("\n").map((p) => p.split("/").pop());
    let pkg = null;
    if (files.includes("package.json")) pkg = gitFn(`show ${ref}:packages/games/${d}/package.json`);
    const g = gameEntry(d, files.includes("index.ts"), pkg);
    if (g) games.push(g);
  }
  return { dirs, current: currentSlug(sortGames(games)) };
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
    const at = gamesAt(base);
    errors.push(...checkArchived(changed, at.dirs, at.current));
  }

  for (const e of errors) console.error(e);
  if (errors.length) { console.error("guard failed"); process.exit(1); }
  console.log("guard ok");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
