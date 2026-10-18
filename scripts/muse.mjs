// Muse Spark wrapper (OpenCode Go). Used by the muse-builder subagent for config.ts / assets.ts tweaks.
// Passes only the task prompt + target file list, never the viewer spec or repo context.
// Self-meters every call into usage-opencode.json (OpenCode has no usage API).
//
// Run: node scripts/muse.mjs --files packages/games/g/config.ts[,more] [--timeout 300] [--dry-run] -- "<task prompt>"
//      node scripts/muse.mjs --files ... --prompt-file task.txt
// Prints one JSON summary line; exit 0 only when the run finished cleanly and touched no stray files.
// The OpenCode key comes from the environment's network secret (proxy-injected); OPENCODE_API_KEY is a placeholder.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MODEL = process.env.MUSE_MODEL ?? "opencode-go/muse-spark-1.3-contributor";
export const USAGE_FILE = process.env.MUSE_USAGE_FILE ?? "usage-opencode.json";
const DEFAULT_TIMEOUT_S = 300;

// Muse edits files only. No shell, no web: explicit denies survive --auto.
export const OPENCODE_CONFIG = { permission: { bash: "deny", webfetch: "deny", edit: "allow" } };

// Secrets the Muse process never needs.
const ENV_DENY = /^(FEED_SECRET|BOT_URL|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_.*|CLAUDE_CODE_.*|CLOUDFLARE_.*)$/;

export function buildPrompt(task, files) {
  return [
    "You are editing a small TypeScript browser game.",
    `Edit ONLY these files: ${files.join(", ")}.`,
    "Do not create, delete or edit any other file. Do not add imports. Keep exports and types unchanged unless the task says otherwise.",
    "Keep the change minimal. When done, reply with one sentence describing the change.",
    "",
    "Task:",
    task.trim(),
  ].join("\n");
}

/** Parse the `opencode run --format json` event stream (one JSON object per line). */
export function parseEvents(text) {
  const out = { sessionId: null, tokensIn: 0, tokensOut: 0, costUsd: 0, steps: 0, tools: [], editedFiles: [], text: "", finishReason: null, errors: [] };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    out.sessionId ??= e.sessionID ?? null;
    const p = e.part ?? {};
    if (e.type === "step_finish") {
      const t = p.tokens ?? {};
      out.tokensIn += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      out.tokensOut += (t.output ?? 0) + (t.reasoning ?? 0);
      out.costUsd += typeof p.cost === "number" ? p.cost : 0;
      out.steps++;
      out.finishReason = p.reason ?? out.finishReason;
    } else if (e.type === "tool_use") {
      out.tools.push(p.tool);
      const fp = p.state?.input?.filePath;
      if (["edit", "write", "patch"].includes(p.tool) && fp && !out.editedFiles.includes(fp)) out.editedFiles.push(fp);
      if (p.state?.status === "error") out.errors.push(`${p.tool}: ${String(p.state.error ?? "error").slice(0, 200)}`);
    } else if (e.type === "text" && p.text) {
      out.text = p.text; // last assistant text wins
    } else if (e.type === "error") {
      out.errors.push(String(e.error?.data?.message ?? e.error?.name ?? "error").slice(0, 200));
    }
  }
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  return out;
}

export function appendUsage(file, entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (!Array.isArray(arr)) arr = [];
  arr.push(entry);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const gitLines = (cwd, args) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); }
  catch { return []; }
};
/** Paths changed vs HEAD plus untracked files, repo-relative. */
export function dirtyFiles(cwd) {
  return [...new Set([
    ...gitLines(cwd, ["diff", "--name-only", "HEAD"]),
    ...gitLines(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ])];
}

/** Files that became dirty during the run and are not targets (usage file excluded). */
export function strayFiles(before, after, targets, usageFile = USAGE_FILE) {
  const allowed = new Set([...targets.map((f) => path.normalize(f)), path.normalize(usageFile)]);
  return after.filter((f) => !before.includes(f) && !allowed.has(path.normalize(f)));
}

function revert(cwd, files) {
  const tracked = new Set(gitLines(cwd, ["ls-files"]));
  for (const f of files) {
    if (tracked.has(f)) execFileSync("git", ["checkout", "--", f], { cwd, stdio: "ignore" });
    else fs.rmSync(path.join(cwd, f), { force: true });
  }
}

export function museEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!ENV_DENY.test(k)) out[k] = v;
  out.OPENCODE_API_KEY ||= "placeholder";
  out.OPENCODE_CONFIG_CONTENT = JSON.stringify(OPENCODE_CONFIG);
  return out;
}

/** Run opencode; resolves { stdout, code, timedOut }. `bin` overridable for tests. */
export function runOpencode(prompt, { cwd, timeoutS, bin = process.env.OPENCODE_BIN ?? "opencode", model = MODEL }) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["run", "-m", model, "--format", "json", "--auto", prompt], { cwd, env: museEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutS * 1000);
    child.on("error", (e) => { clearTimeout(t); resolve({ stdout, stderr: String(e), code: 127, timedOut }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ stdout, stderr, code: code ?? 1, timedOut }); });
  });
}

export function parseArgs(argv) {
  const a = { files: [], timeoutS: DEFAULT_TIMEOUT_S, dryRun: false, prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--files") a.files.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (k === "--timeout") a.timeoutS = Number(argv[++i]);
    else if (k === "--prompt-file") a.prompt = fs.readFileSync(argv[++i], "utf8");
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--") { a.prompt = argv.slice(i + 1).join(" "); break; }
    else a.prompt = [a.prompt, k].filter(Boolean).join(" ");
  }
  return a;
}

export async function muse({ files, prompt, timeoutS = DEFAULT_TIMEOUT_S, dryRun = false, cwd = process.cwd(), usageFile = USAGE_FILE, bin }) {
  if (!files.length) throw new Error("muse: --files is required");
  if (!prompt.trim()) throw new Error("muse: empty task prompt");
  const full = buildPrompt(prompt, files);
  if (dryRun) return { ok: true, dryRun: true, model: MODEL, files, prompt: full };

  const before = dirtyFiles(cwd);
  const started = Date.now();
  const r = await runOpencode(full, { cwd, timeoutS, bin });
  const ev = parseEvents(r.stdout);
  const stray = strayFiles(before, dirtyFiles(cwd), files, usageFile);
  if (stray.length) revert(cwd, stray);
  const ok = r.code === 0 && !r.timedOut && ev.errors.length === 0 && ev.steps > 0 && stray.length === 0;

  appendUsage(path.resolve(cwd, usageFile), { at: new Date().toISOString(), model: MODEL, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, costUsd: ev.costUsd, ok });
  return {
    ok, model: MODEL, files, sessionId: ev.sessionId, seconds: Math.round((Date.now() - started) / 1000),
    tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, costUsd: ev.costUsd, steps: ev.steps, tools: ev.tools,
    editedFiles: ev.editedFiles.map((f) => path.relative(cwd, f)), strayReverted: stray, timedOut: r.timedOut, exitCode: r.code,
    errors: ev.errors, reply: ev.text.slice(0, 300), ...(ok || ev.errors.length ? {} : { stderr: r.stderr.slice(-300) }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const res = await muse(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(res));
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    process.exit(2);
  }
}
