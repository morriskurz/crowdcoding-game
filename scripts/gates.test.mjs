// Run: node --test scripts/gates.test.mjs (part of `pnpm test:agent`). Pure helpers only; `pnpm gates` is the e2e.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, tail, maxCompatDate, summarize } from "./gates.mjs";

test("parseArgs", () => {
  assert.deepEqual(parseArgs([]), { skip: [], keepGoing: false });
  assert.deepEqual(parseArgs(["--skip", "smoke,build", "--keep-going"]), { skip: ["smoke", "build"], keepGoing: true });
  assert.throws(() => parseArgs(["--skip", "lint"]), /unknown step/);
});

test("tail strips ANSI and blank lines", () => {
  assert.equal(tail("a\n\n\x1b[31mb\x1b[0m\nc\n", 2), "b\nc");
});

test("maxCompatDate reads workerd's newest supported date", () => {
  const log = 'This Worker requires compatibility date "2026-08-01", but the newest date supported by this server binary is "2026-07-29".';
  assert.equal(maxCompatDate(log), "2026-07-29");
  assert.equal(maxCompatDate("ready on http://127.0.0.1:8787"), null);
});

test("summarize: ok vs complete", () => {
  const all = summarize([{ name: "guard", status: "pass", ms: 1000 }, { name: "smoke", status: "pass", ms: 2000 }], "f/1-x");
  assert.deepEqual(all, { ok: true, complete: true, green: ["guard", "smoke"], skipped: [], branch: "f/1-x", seconds: 3 });
  const skipped = summarize([{ name: "guard", status: "pass", ms: 1 }, { name: "smoke", status: "skip" }], "b");
  assert.equal(skipped.ok, true);
  assert.equal(skipped.complete, false);
  const failed = summarize([{ name: "guard", status: "pass", ms: 1 }, { name: "test", status: "fail", ms: 1, tail: "boom" }, { name: "build", status: "skip" }], "b");
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, "test");
  assert.equal(failed.tail, "boom");
});
