// Run: node --test scripts/feed-hook.test.mjs (part of `pnpm test:agent`).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toFeedEvent, post, redact, TIMEOUT_MS } from "./feed-hook.mjs";

const HOOK = fileURLToPath(new URL("./feed-hook.mjs", import.meta.url));

test("PostToolUse Edit -> repo-relative file", () => {
  const ev = toFeedEvent({ session_id: "s1", hook_event_name: "PostToolUse", cwd: "/r", tool_name: "Edit", tool_input: { file_path: "/r/packages/games/g/rules.ts" } });
  assert.deepEqual(ev, { sessionId: "s1", event: "PostToolUse", tool: "Edit", summary: "edited packages/games/g/rules.ts", file: "packages/games/g/rules.ts" });
});

test("PostToolUse Bash prefers description, summary capped at 200, secrets redacted", () => {
  const long = toFeedEvent({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi ".repeat(100) } });
  assert.ok(long.summary.length <= 200);
  assert.equal(long.file, undefined);
  const desc = toFeedEvent({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm -r test", description: "Run tests" } });
  assert.equal(desc.summary, "ran: Run tests");
  const sec = toFeedEvent({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "FEED_SECRET=abc123 curl -H 'Authorization: Bearer zzz' x" } });
  assert.doesNotMatch(sec.summary, /abc123|zzz/);
});

test("redact", () => {
  assert.equal(redact("OPENCODE_API_KEY=sk-123 ok"), "OPENCODE_API_KEY=*** ok");
  assert.equal(redact("ghp_abcdefghijklmnop"), "***");
  assert.equal(redact("Bearer abc"), "Bearer ***");
  assert.equal(redact("edited rules.ts"), "edited rules.ts");
});

test("Stop uses last message or default; unknown events send nothing", () => {
  assert.deepEqual(toFeedEvent({ session_id: "s", hook_event_name: "Stop" }), { sessionId: "s", event: "Stop", summary: "turn finished" });
  assert.equal(toFeedEvent({ session_id: "s", hook_event_name: "Stop", last_assistant_message: "t3 done, gates green" }).summary, "t3 done, gates green");
  assert.equal(toFeedEvent({ hook_event_name: "PreToolUse" }), null);
  assert.equal(toFeedEvent(null), null);
});

test("post: no BOT_URL -> no request", async () => {
  let called = false;
  assert.equal(await post({ a: 1 }, {}, async () => { called = true; }), false);
  assert.equal(called, false);
});

test("post: sends bearer + JSON body to /feed; swallows errors", async () => {
  let seen;
  const ok = await post({ sessionId: "s", event: "Stop", summary: "x" }, { BOT_URL: "https://bot.example/", FEED_SECRET: "sek" }, async (url, init) => {
    seen = { url, init };
    return { ok: true };
  });
  assert.equal(ok, true);
  assert.equal(seen.url, "https://bot.example/feed");
  assert.equal(seen.init.headers.authorization, "Bearer sek");
  assert.deepEqual(JSON.parse(seen.init.body), { sessionId: "s", event: "Stop", summary: "x" });
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.equal(await post({}, { BOT_URL: "http://x" }, async () => { throw new Error("down"); }), false);
});

function runHook(stdin, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    const t0 = Date.now();
    c.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
    c.stdin.end(stdin);
  });
}

test("process: POSTs to a live server and exits 0", async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => { b += d; });
    req.on("end", () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end("ok"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runHook(JSON.stringify({ session_id: "s9", hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "tasks.json" } }), { BOT_URL: `http://127.0.0.1:${srv.address().port}`, FEED_SECRET: "f" });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.deepEqual(got, [{ url: "/feed", auth: "Bearer f", body: { sessionId: "s9", event: "PostToolUse", tool: "Write", summary: "wrote tasks.json", file: "tasks.json" } }]);
  } finally { srv.close(); }
});

test("process: hanging server is cut at ~3 s, still exit 0", async () => {
  const srv = http.createServer(() => {}); // never responds
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runHook(JSON.stringify({ session_id: "s", hook_event_name: "Stop" }), { BOT_URL: `http://127.0.0.1:${srv.address().port}` });
    assert.equal(r.code, 0);
    assert.ok(r.ms >= TIMEOUT_MS - 200 && r.ms < TIMEOUT_MS + 2500, `took ${r.ms}ms`);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("process: unset BOT_URL, garbage stdin, unreachable host all exit 0", async () => {
  assert.equal((await runHook("{}", {})).code, 0);
  assert.equal((await runHook("not json", { BOT_URL: "http://127.0.0.1:9" })).code, 0);
  assert.equal((await runHook(JSON.stringify({ session_id: "s", hook_event_name: "Stop" }), { BOT_URL: "http://127.0.0.1:9" })).code, 0);
});
