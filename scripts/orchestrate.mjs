// Orchestrator state machine. The Opus orchestrator (CLAUDE.md) drives a feature through these
// commands instead of hand-editing feature.json / tasks.json, so the formats and the escalation
// ladder stay exact. Every command prints one JSON line on stdout. Protocol: docs/ORCHESTRATOR.md.
//
//   start --payload <file>       validate payload, create/continue f/<featureId>-<slug>, write feature.json
//   bootstrap                    (bootstrap payloads only) copy packages/games/template -> packages/games/<slug>
//   plan --tasks <file> [--append]  validate + write tasks.json (array order = dependency order), commit
//   next                         next runnable task + the tier to use
//   begin <id> --tier <t> [--reest <min>]   start an attempt (records the start time locally)
//   verify <id> [--error <msg>] [--skip smoke]  run gates, record the attempt, done/retry/escalate/fail, commit
//   reset <id>                   restore the task's files to HEAD (before escalating to a new tier)
//   resplit <id> --tasks <file>  replace a failed task by smaller subtasks (ids <id>.1, <id>.2, ...)
//   finish                       final gates; status ready only when all tasks done and gates green
//   validate | show
//   dry-run [--scenario <file>] [--worktree <dir>]   whole flow on a toy spec, no LLM, no push
//
// Env: ORCH_NO_PUSH=1 commits without pushing (dry runs). ORCH_STATE (default .orchestrator/state.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentSlug, isGameSlug, listGames } from "./registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TIERS = ["muse", "sonnet", "opus"];
export const STATUSES = ["planning", "building", "gates", "ready", "failed"];
export const TRIES_PER_TIER = 2; // first try + 1 retry
const MUSE_FILES = /^(config|assets)\.ts$/;
const FEATURE = "feature.json";
const TASKS = "tasks.json";
const USAGE = "usage-opencode.json";

// ---------- pure helpers (unit tested) ----------

export function slugify(s) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

/** Validate a routine payload. The spec is data: stored verbatim, never interpreted. */
export function parsePayload(raw) {
  const p = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("payload must be an object");
  const featureId = String(p.featureId ?? "");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(featureId)) throw new Error("payload.featureId must match [A-Za-z0-9_-]{1,32}");
  if (typeof p.spec !== "string" || !p.spec.trim()) throw new Error("payload.spec must be a non-empty string");
  if (p.spec.length > 4000) throw new Error("payload.spec longer than 4000 chars");
  const slug = slugify(p.slug);
  if (!slug) throw new Error("payload.slug is empty after sanitising");
  const out = { featureId, spec: p.spec, slug, branch: `f/${featureId}-${slug}`, bootstrap: p.bootstrap === true };
  // A bootstrap slug becomes a URL (/<slug>) and a room name: it may not shadow a route.
  if (out.bootstrap && !isGameSlug(slug)) throw new Error(`payload.slug "${slug}" is reserved; pick another game name`);
  if (p.resumeFrom != null) out.resumeFrom = String(p.resumeFrom);
  if (p.game != null) {
    const g = slugify(p.game);
    if (!g) throw new Error("payload.game is empty after sanitising");
    out.game = g;
  }
  return out;
}

export function newFeature(pl, now = new Date()) {
  const f = { id: pl.featureId, spec: pl.spec, slug: pl.slug, ...(pl.game ? { game: pl.game } : {}), branch: pl.branch, status: "planning" };
  if (pl.resumeFrom) f.resumeFrom = pl.resumeFrom;
  f.updatedAt = now.toISOString();
  return f;
}

export function validateFeature(f) {
  const errs = [];
  const keys = ["id", "spec", "slug", "game", "branch", "status", "resumeFrom", "updatedAt"];
  for (const k of Object.keys(f ?? {})) if (!keys.includes(k)) errs.push(`feature.json: unknown key ${k}`);
  for (const k of ["id", "spec", "slug", "branch", "updatedAt"]) if (typeof f?.[k] !== "string") errs.push(`feature.json: ${k} must be a string`);
  if (!STATUSES.includes(f?.status)) errs.push(`feature.json: bad status ${f?.status}`);
  if (f?.resumeFrom != null && typeof f.resumeFrom !== "string") errs.push("feature.json: resumeFrom must be a string");
  if (f?.game != null && !isGameSlug(f.game)) errs.push("feature.json: game must be a game directory name");
  if (f?.branch && f.branch !== `f/${f.id}-${f.slug}`) errs.push("feature.json: branch must be f/<id>-<slug>");
  return errs;
}

const TASK_KEYS = ["id", "title", "tier", "files", "estMin", "agentReEst", "actualMin", "done", "failed", "error", "attempts"];

/**
 * Validate tasks.json. gameDir = "packages/games/<slug>/". Rules on top of the format:
 * ids unique; files under gameDir; a directory entry only on the bootstrap task;
 * other tasks touch one source file (+ its .test.ts); muse tasks only config.ts / assets.ts.
 */
export function validateTasks(tasks, gameDir) {
  const errs = [];
  if (!Array.isArray(tasks)) return ["tasks.json must be an array"];
  const ids = new Set();
  for (const [i, t] of tasks.entries()) {
    const at = `tasks[${i}]${t?.id ? ` (${t.id})` : ""}`;
    if (!t || typeof t !== "object") { errs.push(`${at}: not an object`); continue; }
    for (const k of Object.keys(t)) if (!TASK_KEYS.includes(k)) errs.push(`${at}: unknown key ${k}`);
    if (typeof t.id !== "string" || !/^(t\d+(\.\d+)*|bootstrap)$/.test(t.id)) errs.push(`${at}: id must be t<n>, t<n>.<m> or bootstrap`);
    if (ids.has(t.id)) errs.push(`${at}: duplicate id`);
    ids.add(t.id);
    if (typeof t.title !== "string" || !t.title.trim()) errs.push(`${at}: title required`);
    if (!TIERS.includes(t.tier)) errs.push(`${at}: tier must be muse|sonnet|opus`);
    if (typeof t.estMin !== "number" || !(t.estMin > 0)) errs.push(`${at}: estMin must be a positive number`);
    for (const k of ["agentReEst", "actualMin"]) if (t[k] != null && typeof t[k] !== "number") errs.push(`${at}: ${k} must be a number`);
    if (typeof t.done !== "boolean") errs.push(`${at}: done must be boolean`);
    if (t.failed != null && typeof t.failed !== "boolean") errs.push(`${at}: failed must be boolean`);
    if (t.error != null && typeof t.error !== "string") errs.push(`${at}: error must be a string`);
    if (t.attempts != null) {
      if (!Array.isArray(t.attempts) || t.attempts.some((a) => !TIERS.includes(a?.tier) || typeof a.ok !== "boolean" || typeof a.minutes !== "number" || Object.keys(a).length !== 3)) {
        errs.push(`${at}: attempts must be [{tier, ok, minutes}]`);
      }
    }
    if (!Array.isArray(t.files) || !t.files.length || t.files.some((f) => typeof f !== "string")) { errs.push(`${at}: files must be a non-empty string array`); continue; }
    const bad = t.files.filter((f) => !f.startsWith(gameDir) || f.includes("..") || f === gameDir && t.id !== "bootstrap");
    if (bad.length) errs.push(`${at}: files outside ${gameDir} (or dir entry on a non-bootstrap task): ${bad.join(",")}`);
    if (t.id === "bootstrap") {
      if (t.files.length !== 1 || t.files[0] !== gameDir) errs.push(`${at}: bootstrap task files must be exactly ["${gameDir}"]`);
      continue;
    }
    const names = t.files.map((f) => f.slice(gameDir.length));
    if (names.some((n) => n.endsWith("/"))) errs.push(`${at}: directory entries are for the bootstrap task only`);
    if (names.includes("package.json")) errs.push(`${at}: package.json (registry metadata) is written by bootstrap only`);
    const src = names.filter((n) => !n.endsWith(".test.ts"));
    const tests = names.filter((n) => n.endsWith(".test.ts"));
    if (src.length > 1 || tests.length > 1 || (src.length === 1 && tests.length === 1 && tests[0] !== src[0].replace(/\.ts$/, ".test.ts"))) {
      errs.push(`${at}: one source file (+ its .test.ts) per task; split it`);
    }
    if (t.tier === "muse" && !names.every((n) => MUSE_FILES.test(n))) errs.push(`${at}: muse tasks only edit config.ts / assets.ts`);
  }
  return errs;
}

/** Superseded = failed and replaced by subtasks via resplit. */
export const superseded = (t) => t.failed === true && typeof t.error === "string" && t.error.startsWith("re-split into ");

/** Tier for the next attempt, "done", or "exhausted" (opus already failed its retry). */
export function nextTier(t) {
  if (t.done) return "done";
  const atts = t.attempts ?? [];
  if (!atts.length) return t.tier;
  const last = atts[atts.length - 1];
  const fails = atts.filter((a) => a.tier === last.tier && !a.ok).length;
  if (fails < TRIES_PER_TIER) return last.tier;
  const i = TIERS.indexOf(last.tier) + 1;
  return i < TIERS.length ? TIERS[i] : "exhausted";
}

export function nextTask(tasks) {
  const t = tasks.find((x) => !x.done && !x.failed);
  return t ? { id: t.id, title: t.title, files: t.files, tier: nextTier(t), attempt: (t.attempts?.length ?? 0) + 1 } : null;
}

/** Record one attempt; mutates and returns the task plus what happens next. */
export function recordAttempt(t, { tier, ok, minutes, error }) {
  t.attempts = [...(t.attempts ?? []), { tier, ok, minutes: Math.max(0, Math.round(minutes * 10) / 10) }];
  if (ok) {
    t.done = true;
    delete t.failed; delete t.error;
    t.actualMin = Math.round(t.attempts.reduce((s, a) => s + a.minutes, 0) * 10) / 10;
    return { task: t, next: "done" };
  }
  if (error) t.error = String(error).slice(0, 500);
  const n = nextTier(t);
  if (n === "exhausted") {
    t.failed = true;
    t.actualMin = Math.round(t.attempts.reduce((s, a) => s + a.minutes, 0) * 10) / 10;
    return { task: t, next: t.id.includes(".") ? "feature-failed" : "resplit" };
  }
  return { task: t, next: n === tier ? "retry" : "escalate", tier: n };
}

/** Replace failed task `id` by subtasks <id>.1.. inserted right after it. */
export function resplit(tasks, id, subs) {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) throw new Error(`no task ${id}`);
  const t = tasks[i];
  if (!t.failed) throw new Error(`task ${id} has not failed; only failed tasks are re-split`);
  if (id.includes(".")) throw new Error(`task ${id} is already a re-split subtask; the feature fails instead`);
  if (!Array.isArray(subs) || !subs.length) throw new Error("resplit needs at least one subtask");
  const fresh = subs.map((s, k) => ({ id: `${id}.${k + 1}`, title: s.title, tier: s.tier, files: s.files, estMin: s.estMin, done: false }));
  t.error = `re-split into ${fresh.map((s) => s.id).join(",")}${t.error ? `; last error: ${t.error}` : ""}`.slice(0, 500);
  return [...tasks.slice(0, i + 1), ...fresh, ...tasks.slice(i + 1)];
}

export function allDone(tasks) {
  return tasks.length > 0 && tasks.every((t) => t.done || superseded(t));
}

/** Apply resumeFrom=<task id>: that task and every later one start over. */
export function applyResume(tasks, from) {
  const i = tasks.findIndex((t) => t.id === from);
  if (i < 0) return tasks;
  return tasks.map((t, k) => (k < i ? t : { id: t.id, title: t.title, tier: t.tier, files: t.files, estMin: t.estMin, ...(t.agentReEst != null ? { agentReEst: t.agentReEst } : {}), done: false }));
}

/**
 * Game dir to work in: the bootstrap slug, else payload.game, else the registry's current game
 * (scripts/registry.mjs). Archived games are frozen: a payload naming any game but the current one is
 * refused unless it is a bootstrap (which creates a new directory). scripts/guard.mjs enforces the same
 * on the branch diff. `resuming`: already on the feature branch, where a bootstrap's directory exists.
 */
export function resolveGame(pl, cwd = process.cwd(), { resuming = false } = {}) {
  const current = currentSlug(listGames(cwd, () => {}));
  if (pl.bootstrap) {
    if (!resuming && fs.existsSync(path.join(cwd, "packages/games", pl.slug))) {
      throw new Error(`bootstrap: packages/games/${pl.slug} already exists; a bootstrap creates a new game, pick a new slug`);
    }
    return pl.slug;
  }
  if (pl.game && current && pl.game !== current) {
    throw new Error(`payload.game "${pl.game}" is not the current game "${current}": archived games get no new features (they stay playable as they are); send features for "${current}", or bootstrap: true for a new game`);
  }
  return pl.game ?? current ?? "template";
}

// ---------- io ----------

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
const readInput = (f) => (f === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(f, "utf8"));
const statePath = () => process.env.ORCH_STATE ?? ".orchestrator/state.json";
function loadState() { try { return readJson(statePath()); } catch { return {}; } }
function saveState(s) { fs.mkdirSync(path.dirname(statePath()), { recursive: true }); writeJson(statePath(), s); }

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const gitOk = (...args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;

function loadFeature() { return readJson(FEATURE); }
function saveFeature(f, patch = {}) {
  Object.assign(f, patch, { updatedAt: new Date().toISOString() });
  const errs = validateFeature(f);
  if (errs.length) throw new Error(errs.join("; "));
  // keep the documented key order
  const { id, spec, slug, game, branch, status, resumeFrom, updatedAt } = f;
  writeJson(FEATURE, { id, spec, slug, ...(game ? { game } : {}), branch, status, ...(resumeFrom ? { resumeFrom } : {}), updatedAt });
}
function loadTasks() { try { return readJson(TASKS); } catch { return []; } }
function saveTasks(tasks) {
  const errs = validateTasks(tasks, gameDirOf());
  if (errs.length) throw new Error(errs.join("; "));
  writeJson(TASKS, tasks.map((t) => Object.fromEntries(TASK_KEYS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))));
}
function gameDirOf() {
  const s = loadState();
  if (!s.game) throw new Error("no game resolved; run `start` first");
  return `packages/games/${s.game}/`;
}

function push(branch) {
  if (process.env.ORCH_NO_PUSH === "1") return "skipped (ORCH_NO_PUSH)";
  for (const wait of [0, 2, 4, 8, 16]) {
    if (wait) spawnSync("sleep", [String(wait)]);
    if (gitOk("push", "-u", "origin", branch)) return "pushed";
  }
  return "push failed after 5 tries";
}

/** Stage only the plan's files + state files, commit, push. Anything else dirty is reported, not committed. */
function commit(message, files = []) {
  const paths = [FEATURE, TASKS, ...files];
  if (fs.existsSync(USAGE)) paths.push(USAGE);
  if (files.some((f) => f.endsWith("/"))) paths.push("pnpm-lock.yaml");
  git("add", "-A", "--", ...paths.filter((p) => fs.existsSync(p) || gitOk("ls-files", "--error-unmatch", p)));
  const staged = git("diff", "--cached", "--name-only");
  let sha = null;
  if (staged) {
    git("commit", "-q", "-m", message);
    sha = git("rev-parse", "--short", "HEAD");
  }
  const leftover = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => l.slice(3)).filter((p) => !p.startsWith(".orchestrator"));
  return { sha, push: sha ? push(git("rev-parse", "--abbrev-ref", "HEAD")) : "nothing to commit", ...(leftover.length ? { uncommitted: leftover } : {}) };
}

function runGates(extra = []) {
  const r = spawnSync(process.execPath, [path.join(HERE, "gates.mjs"), ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try { return JSON.parse(line); } catch { return { ok: false, complete: false, error: `gates printed no summary (exit ${r.status})` }; }
}

// ---------- commands ----------

export const commands = {
  start(args) {
    const pl = parsePayload(readInput(args.payload ?? "-"));
    const game = resolveGame(pl, process.cwd(), { resuming: git("rev-parse", "--abbrev-ref", "HEAD") === pl.branch });
    if (!args["no-fetch"]) spawnSync("git", ["fetch", "-q", "origin", "main", pl.branch], { stdio: "ignore" });
    let resumed = false;
    if (git("rev-parse", "--abbrev-ref", "HEAD") === pl.branch) resumed = fs.existsSync(FEATURE);
    else if (gitOk("rev-parse", "--verify", "-q", `refs/remotes/origin/${pl.branch}`)) { git("checkout", "-q", "-B", pl.branch, `origin/${pl.branch}`); resumed = true; }
    else if (gitOk("rev-parse", "--verify", "-q", `refs/heads/${pl.branch}`)) { git("checkout", "-q", pl.branch); resumed = true; }
    else git("checkout", "-q", "-b", pl.branch, gitOk("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "HEAD");
    saveState({ game, branch: pl.branch, bootstrap: pl.bootstrap });

    let feature;
    let tasks = loadTasks();
    if (resumed && fs.existsSync(FEATURE)) {
      feature = loadFeature();
      if (feature.id !== pl.featureId) throw new Error(`branch ${pl.branch} holds feature ${feature.id}, payload is ${pl.featureId}`);
      if (pl.resumeFrom) { feature.resumeFrom = pl.resumeFrom; tasks = applyResume(tasks, pl.resumeFrom); saveTasks(tasks); }
      // resumeFrom re-opens the feature; a plain re-fire keeps whatever state the branch is in
      const status = pl.resumeFrom && tasks.length ? "building" : feature.status === "planning" && tasks.length ? "building" : feature.status;
      saveFeature(feature, { status });
    } else {
      feature = newFeature({ ...pl, game });
      saveFeature(feature);
      tasks = [];
      writeJson(TASKS, tasks); // main's placeholder plan never carries into a feature branch
    }
    return { branch: pl.branch, game, gameDir: `packages/games/${game}/`, bootstrap: pl.bootstrap, resumed, status: loadFeature().status, tasks: tasks.length, next: nextTask(tasks) };
  },

  bootstrap() {
    const s = loadState();
    if (!s.bootstrap) throw new Error("bootstrap is only for payloads with bootstrap: true");
    const dest = path.join("packages/games", s.game);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
    fs.cpSync("packages/games/template", dest, { recursive: true, filter: (p) => !/(^|\/)(node_modules|dist)(\/|$)/.test(p) });
    const pkgFile = path.join(dest, "package.json");
    const pkg = readJson(pkgFile);
    pkg.name = `@tcg/game-${s.game}`;
    // Registry metadata (scripts/registry.mjs): the newest `created` is the current game, so this
    // game replaces last week's once it ships; the old one stays playable, archived, at /<old slug>.
    pkg.tcg = { title: s.game, created: new Date().toISOString() };
    writeJson(pkgFile, pkg);
    const r = spawnSync("pnpm", ["install", "--no-frozen-lockfile"], { encoding: "utf8" });
    return { created: dest, package: pkg.name, install: r.status === 0 ? "ok" : (r.stderr ?? "").slice(-300) };
  },

  plan(args) {
    const incoming = JSON.parse(readInput(args.tasks ?? "-"));
    const feature = loadFeature();
    const fresh = incoming.map((t) => ({ ...t, done: t.done ?? false }));
    const tasks = args.append ? [...loadTasks(), ...fresh] : fresh;
    saveTasks(tasks);
    saveFeature(feature, { status: "building" });
    return { tasks: tasks.length, next: nextTask(tasks), ...commit(`${feature.branch}: plan (${tasks.length} tasks)`) };
  },

  next() {
    const tasks = loadTasks();
    return { next: nextTask(tasks), allDone: allDone(tasks), status: loadFeature().status };
  },

  begin(args) {
    const [id] = args._;
    const tier = args.tier;
    if (!TIERS.includes(tier)) throw new Error("--tier muse|sonnet|opus required");
    const tasks = loadTasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no task ${id}`);
    if (args.reest != null) { t.agentReEst = Number(args.reest); saveTasks(tasks); }
    const s = loadState();
    s.current = { id, tier, startedAt: Date.now() };
    saveState(s);
    return { id, tier, files: t.files, expected: nextTier(t) };
  },

  verify(args) {
    const [id] = args._;
    const s = loadState();
    if (s.current?.id !== id) throw new Error(`no attempt in progress for ${id}; run begin first`);
    const gates = runGates(args.skip ? ["--skip", args.skip] : []);
    const ok = gates.ok === true && (gates.complete === true || Boolean(args.skip));
    const tasks = loadTasks();
    const t = tasks.find((x) => x.id === id);
    const minutes = (Date.now() - s.current.startedAt) / 60000;
    const error = ok ? undefined : args.error ?? `gates: ${gates.failed ?? gates.error ?? "red"}: ${(gates.tail ?? "").split("\n").slice(-3).join(" | ")}`;
    const res = recordAttempt(t, { tier: s.current.tier, ok, minutes, error });
    saveTasks(tasks);
    delete s.current;
    saveState(s);
    const feature = loadFeature();
    let committed = null;
    if (res.next === "done") saveFeature(feature);
    if (res.next === "done") committed = commit(`${feature.branch}: ${id} done (${t.attempts.map((a) => a.tier).join(">")})\n\n${t.title}`, t.files);
    else if (res.next === "resplit" || res.next === "feature-failed") {
      if (res.next === "feature-failed") saveFeature(feature, { status: "failed" });
      // the failed code stays out of history; only the plan records the failure
      commands.reset({ _: [id] });
      committed = commit(`${feature.branch}: ${id} failed at opus${res.next === "feature-failed" ? ", feature failed" : ", re-split next"}`);
    }
    return { id, ok, next: res.next, ...(res.tier ? { tier: res.tier } : {}), gates, attempts: t.attempts, ...(committed ? { commit: committed } : {}) };
  },

  reset(args) {
    const [id] = args._;
    const t = loadTasks().find((x) => x.id === id);
    if (!t) throw new Error(`no task ${id}`);
    for (const f of t.files) {
      if (gitOk("cat-file", "-e", `HEAD:${f.replace(/\/$/, "")}`)) git("checkout", "HEAD", "--", f);
      else fs.rmSync(f, { recursive: true, force: true });
      if (f.endsWith("/")) spawnSync("git", ["clean", "-fdq", "--", f]);
    }
    return { reset: t.files };
  },

  resplit(args) {
    const [id] = args._;
    const tasks = resplit(loadTasks(), id, JSON.parse(readInput(args.tasks ?? "-")));
    saveTasks(tasks);
    const feature = loadFeature();
    return { tasks: tasks.length, next: nextTask(tasks), ...commit(`${feature.branch}: re-split ${id}`) };
  },

  finish(args) {
    const feature = loadFeature();
    const tasks = loadTasks();
    if (!allDone(tasks)) return { ok: false, status: feature.status, reason: "tasks not all done", next: nextTask(tasks) };
    saveFeature(feature, { status: "gates" });
    const gates = runGates();
    const ready = gates.ok === true && gates.complete === true;
    saveFeature(feature, { status: ready ? "ready" : "building" });
    return { ok: ready, status: ready ? "ready" : "building", gates, ...commit(`${feature.branch}: ${ready ? "ready" : "final gates red"}`) };
  },

  validate() {
    const errs = [...validateFeature(loadFeature()), ...validateTasks(loadTasks(), gameDirOf())];
    return { ok: errs.length === 0, errors: errs };
  },

  show() {
    return { feature: loadFeature(), tasks: loadTasks(), state: loadState() };
  },

  "dry-run": (args) => dryRun(args),
};

// ---------- dry run: the whole protocol with canned "builders" ----------

function applyEdits(edits) {
  for (const e of edits) {
    if (e.content != null) { fs.mkdirSync(path.dirname(e.file), { recursive: true }); fs.writeFileSync(e.file, e.content); continue; }
    const src = fs.readFileSync(e.file, "utf8");
    if (!src.includes(e.find)) throw new Error(`dry-run edit: ${e.file} has no ${JSON.stringify(e.find.slice(0, 40))}`);
    fs.writeFileSync(e.file, src.replace(e.find, e.replace));
  }
}

function dryRun(args) {
  const scenario = readJson(args.scenario ?? path.join(HERE, "fixtures", "dry-run-glow.json"));
  const log = [];
  const step = (name, out) => { log.push({ step: name, ...out }); console.error(`[dry-run] ${name}: ${JSON.stringify(out).slice(0, 300)}`); return out; };
  process.env.ORCH_NO_PUSH = "1";
  const repo = process.cwd();
  const wt = path.resolve(args.worktree ?? fs.mkdtempSync(path.join(os.tmpdir(), "orch-dry-")));
  const branch = parsePayload(scenario.payload).branch;
  // clean slate: a previous dry run's branch and worktree
  spawnSync("git", ["worktree", "remove", "--force", wt], { stdio: "ignore" });
  spawnSync("git", ["branch", "-D", branch], { stdio: "ignore" });
  fs.rmSync(wt, { recursive: true, force: true });
  git("worktree", "add", "-q", "--detach", wt, gitOk("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "HEAD");
  process.chdir(wt);
  process.env.ORCH_STATE = path.join(wt, ".orchestrator", "state.json");
  fs.mkdirSync(path.join(wt, ".orchestrator"), { recursive: true });
  fs.appendFileSync(path.join(git("rev-parse", "--git-common-dir"), "info", "exclude"), "\n.orchestrator/\n");
  const inst = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { encoding: "utf8" });
  if (inst.status !== 0) throw new Error(`pnpm install in worktree failed: ${inst.stderr.slice(-300)}`);

  const payloadFile = path.join(wt, ".orchestrator", "payload.json");
  writeJson(payloadFile, scenario.payload);
  step("start", commands.start({ payload: payloadFile, "no-fetch": true }));
  const tasksFile = path.join(wt, ".orchestrator", "tasks.json");
  writeJson(tasksFile, scenario.tasks);
  step("plan", commands.plan({ tasks: tasksFile }));

  for (let guard = 0; guard < 50; guard++) {
    const { next } = commands.next();
    if (!next) break;
    const plan = scenario.attempts?.[next.id] ?? [];
    const edits = plan[next.attempt - 1] ?? plan[plan.length - 1] ?? [];
    step(`begin ${next.id}`, commands.begin({ _: [next.id], tier: next.tier }));
    // canned builders write whole edits, so every attempt starts from HEAD (a real builder fixes in place on retry)
    if (next.attempt > 1) commands.reset({ _: [next.id] });
    applyEdits(edits);
    const v = step(`verify ${next.id}`, commands.verify({ _: [next.id] }));
    if (v.next === "escalate") step(`reset ${next.id}`, commands.reset({ _: [next.id] }));
    if (v.next === "resplit" || v.next === "feature-failed") break;
  }
  const fin = step("finish", commands.finish({}));
  const val = step("validate", commands.validate());
  const guardRun = spawnSync(process.execPath, ["scripts/guard.mjs"], { encoding: "utf8", env: { ...process.env, GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "" } });
  step("guard", { exit: guardRun.status, out: (guardRun.stdout + guardRun.stderr).trim() });
  const history = git("log", "--oneline", `${git("merge-base", "HEAD", gitOk("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "HEAD")}..HEAD`);
  const diffstat = git("diff", "--stat", "HEAD~" + history.split("\n").length, "HEAD");
  process.chdir(repo);
  return {
    ok: fin.ok && val.ok && guardRun.status === 0,
    branch, worktree: wt, status: readJson(path.join(wt, FEATURE)).status,
    feature: readJson(path.join(wt, FEATURE)), tasks: readJson(path.join(wt, TASKS)),
    commits: history.split("\n"), diffstat, steps: log.map((l) => l.step),
  };
}

// ---------- cli ----------

export function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const name = k.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) a[name] = true;
      else { a[name] = v; i++; }
    } else a._.push(k);
  }
  return a;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) {
    console.log(JSON.stringify({ ok: false, error: `unknown command ${cmd}; one of ${Object.keys(commands).join(", ")}` }));
    process.exit(2);
  }
  try {
    const out = fn(parseArgs(rest));
    console.log(JSON.stringify(out));
    process.exit(out?.ok === false ? 1 : 0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    process.exit(2);
  }
}
