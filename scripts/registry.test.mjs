// Run: node --test scripts/registry.test.mjs (wired into @tcg/games' test script and pnpm test:agent).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listGames, currentSlug, writeRegistry, registrySource, isGameSlug, RESERVED } from "./registry.mjs";

function repo(games) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  fs.mkdirSync(path.join(root, "packages/registry"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/client"), { recursive: true });
  for (const [slug, tcg, files = ["index.ts", "package.json"]] of games) {
    const d = path.join(root, "packages/games", slug);
    fs.mkdirSync(d, { recursive: true });
    if (files.includes("index.ts")) fs.writeFileSync(path.join(d, "index.ts"), "export {};\n");
    if (files.includes("package.json")) fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: `@tcg/game-${slug}`, ...(tcg ? { tcg } : {}) }));
  }
  return root;
}

test("listGames: oldest first by tcg.created, newest is current, ties by slug", () => {
  const root = repo([
    ["template", { title: "agar", created: "2026-10-18" }],
    ["snake", { title: "Snake", created: "2026-10-25T10:00:00Z" }],
    ["tron", { created: "2026-10-25T10:00:00Z" }],
    ["nodate", null],
  ]);
  const games = listGames(root, () => {});
  assert.deepEqual(games.map((g) => g.slug), ["nodate", "template", "snake", "tron"]);
  assert.equal(currentSlug(games), "tron");
  assert.equal(games.find((g) => g.slug === "tron").title, "tron"); // title defaults to the slug
  assert.equal(games.find((g) => g.slug === "snake").title, "Snake");
  assert.equal(currentSlug([]), null);
});

test("listGames: skips reserved, malformed and incomplete directories with a warning", () => {
  const root = repo([
    ["template", { created: "2026-10-18" }],
    ["main", { created: "2027-01-01" }],
    ["games", { created: "2027-01-01" }],
    ["Bad_Name", { created: "2027-01-01" }],
    ["noindex", { created: "2027-01-01" }, ["package.json"]],
    ["nopkg", null, ["index.ts"]],
  ]);
  const warnings = [];
  const games = listGames(root, (m) => warnings.push(m));
  assert.deepEqual(games.map((g) => g.slug), ["template"]);
  assert.equal(warnings.length, 5);
  for (const r of ["game", "games", "assets", "parties", "health", "main"]) assert.ok(RESERVED.has(r) && !isGameSlug(r), r);
  assert.ok(isGameSlug("week-2") && !isGameSlug("-x") && !isGameSlug("x".repeat(41)));
});

test("writeRegistry: server registry + one sandboxed page per game, stale pages removed, idempotent", () => {
  const root = repo([["template", { title: "agar", created: "2026-10-18" }], ["snake", { title: "Sn<a>ke", created: "2026-10-25" }]]);
  fs.mkdirSync(path.join(root, "apps/client/games"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/client/games/gone.html"), "old");
  const r = writeRegistry(root, () => {});
  assert.equal(r.current, "snake");
  const gen = fs.readFileSync(path.join(root, "packages/registry/games.gen.ts"), "utf8");
  assert.equal(gen, registrySource(r.games));
  assert.match(gen, /import \* as g0 from "\.\.\/games\/template\/index\.js";/);
  assert.match(gen, /export const CURRENT_SLUG = "snake";/);
  assert.deepEqual(fs.readdirSync(path.join(root, "apps/client/games")).sort(), ["snake.html", "snake.ts", "template.html", "template.ts"]);
  const html = fs.readFileSync(path.join(root, "apps/client/games/snake.html"), "utf8");
  assert.match(html, /<script type="module" src="\.\/snake\.ts"><\/script>/);
  assert.match(html, /<title>Snake<\/title>/); // markup stripped from titles
  assert.doesNotMatch(html, /<script>[^<]/); // no inline script: CSP script-src 'self'
  assert.match(fs.readFileSync(path.join(root, "apps/client/games/snake.ts"), "utf8"), /from "\.\.\/\.\.\/\.\.\/packages\/games\/snake\/index\.js"/);
  assert.deepEqual(writeRegistry(root, () => {}).changed, []);
});
