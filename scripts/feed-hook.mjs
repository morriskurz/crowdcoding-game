// Agent feed hook (PostToolUse + Stop). Streams what the agent is doing to the stream overlay bot.
// Reads the Claude Code hook JSON on stdin, POSTs {sessionId, event, tool?, file?, summary<=200}
// to $BOT_URL/feed with `Authorization: Bearer $FEED_SECRET`, 3 s timeout.
// Never fails the hook: always exits 0, prints nothing. No-op when BOT_URL is unset.
// Behind the cloud egress proxy Node's fetch needs NODE_USE_ENV_PROXY=1 (set in .claude/settings.json).
import { pathToFileURL } from "node:url";

export const TIMEOUT_MS = 3000;
const MAX = 200;

// The feed is shown on stream: scrub anything secret-shaped before it leaves the box.
export function redact(s) {
  return String(s ?? "")
    .replace(/\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)=\S+/gi, "$1=***")
    .replace(/\b(authorization:)\s*(?:bearer\s+)?\S+/gi, "$1 ***")
    .replace(/\b(bearer)\s+\S+/gi, "$1 ***")
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9_-]{8,}/g, "***")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "***");
}

const clip = (s, n = MAX) => {
  const one = redact(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

function relFile(p, cwd) {
  if (typeof p !== "string" || !p) return undefined;
  const base = (cwd ?? "").replace(/\/$/, "");
  return base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
}

/** Map a hook payload to a feed event, or null to send nothing. */
export function toFeedEvent(h) {
  if (!h || typeof h !== "object") return null;
  const event = h.hook_event_name;
  const sessionId = String(h.session_id ?? "unknown");
  if (event === "Stop" || event === "SubagentStop") {
    return { sessionId, event, summary: clip(h.last_assistant_message || (event === "Stop" ? "turn finished" : "subagent finished")) };
  }
  if (event !== "PostToolUse") return null;
  const tool = String(h.tool_name ?? "");
  const inp = h.tool_input ?? {};
  const file = relFile(inp.file_path ?? inp.notebook_path ?? inp.path, h.cwd);
  let summary;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) summary = `${tool === "Write" ? "wrote" : "edited"} ${file ?? "a file"}`;
  else if (tool === "Bash") summary = `ran: ${inp.description || inp.command || ""}`;
  else if (tool === "Agent" || tool === "Task") summary = `subagent ${inp.subagent_type ?? ""}: ${inp.description ?? ""}`;
  else if (/^(Read|Grep|Glob)$/.test(tool)) summary = `${tool.toLowerCase()} ${file ?? inp.pattern ?? ""}`;
  else summary = tool;
  const ev = { sessionId, event, tool, summary: clip(summary) };
  if (file) ev.file = file;
  return ev;
}

export async function post(ev, env = process.env, fetchImpl = globalThis.fetch) {
  if (!env.BOT_URL || !ev) return false;
  try {
    const res = await fetchImpl(`${env.BOT_URL.replace(/\/$/, "")}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.FEED_SECRET ?? ""}` },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function readStdin(limitMs = 1000) {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let s = "";
    const t = setTimeout(() => resolve(s), limitMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => { clearTimeout(t); resolve(s); });
    process.stdin.on("error", () => { clearTimeout(t); resolve(s); });
  });
}

export async function main(env = process.env) {
  try {
    if (!env.BOT_URL) return;
    const raw = await readStdin();
    let h = null;
    try { h = JSON.parse(raw); } catch { return; }
    await post(toFeedEvent(h), env);
  } catch {}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().finally(() => process.exit(0));
}
