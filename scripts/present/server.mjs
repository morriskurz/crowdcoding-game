// In-process sim server for presentations: the real game sim (createWorld/runTick/snapMessage from
// the checkout under test) behind the same /parties/<party>/<room> WebSocket path the client uses,
// plus the built client as static files. Replaces `wrangler dev` because the Durable Object seeds
// its world from crypto.getRandomValues, and a presentation needs before and after to start from
// the same seed and see the same bot inputs.
//
// Determinism: bots join before tick 1 and the tick loop starts only when the viewer (the browser)
// connects, so tick N is identical across runs for the same seed, scenario and game code. The viewer
// is a spectator: it gets snapshots, has no entity, and its inputs are ignored.
//
// Scenario: --scenario as given with --explicit (feature.json named it, or a baseline run). Without
// --explicit the name is a guess (inferred from the spec), and a game with its own bot (rules.bot)
// plays itself instead (scenario "play"): steering-only scenarios never jump, climb or race.
//
// Game: --game <slug> (feature.json `game`) if that checkout has it, else the checkout's current game
// (@tcg/games). / and /game serve that game, as the Worker does for the current one.
//
// Run: node scripts/present/server.mjs --root <checkout> --port 8787 [--seed 1337] [--scenario idle-crowd] [--explicit] [--game <slug>]
// Prints one JSON line {"ready":true,...} on stdout when listening.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { WebSocketServer } from "ws";
import { GAME_BOT_SCENARIO, SHOWCASE_SCENARIO, resolveScenario } from "../scenarios/index.mjs";
import { writeRegistry } from "../registry.mjs";

export const TICK_HZ = 15;
const TICK_MS = 1000 / TICK_HZ;

/**
 * Load @tcg/shared and a game exactly as the checkout's server resolves them: through the game
 * registry (@tcg/games), or, in a checkout from before the registry, the package room.ts imports.
 */
export async function loadGame(root, game = null) {
  const req = createRequire(path.join(path.resolve(root), "apps/server/package.json"));
  const load = (spec) => tsImport(pathToFileURL(req.resolve(spec)).href, import.meta.url);
  const shared = await load("@tcg/shared");
  if (fs.existsSync(path.join(root, "packages/registry"))) {
    // games.gen.ts is git-ignored and CI installs with --ignore-scripts: generate it for this checkout.
    writeRegistry(path.resolve(root), (m) => console.error(m));
    const { GAMES, CURRENT_SLUG } = await load("@tcg/games");
    const slug = typeof game === "string" && Object.hasOwn(GAMES, game) ? game : CURRENT_SLUG;
    return { shared, rules: GAMES[slug].rules, gamePkg: `@tcg/games:${slug}`, game: slug };
  }
  // room.ts imports `rules` from the game package; keep that coupling in one place.
  const roomSrc = fs.readFileSync(path.join(root, "apps/server/src/room.ts"), "utf8");
  const gamePkg = roomSrc.match(/import\s*\{[^}]*\brules\b[^}]*\}\s*from\s*["'](@tcg\/game-[\w-]+)["']/)?.[1] ?? "@tcg/game-template";
  const mod = await load(gamePkg);
  if (!mod.rules) throw new Error(`${gamePkg} exports no rules`);
  return { shared, rules: mod.rules, gamePkg, game: null };
}

/** A game bot's input, clamped like a client's; null when unusable (same rule as apps/server bots.ts). */
function cleanInput(i) {
  if (!i || typeof i !== "object") return null;
  const { dx, dy, action } = i;
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const c = (v) => Math.max(-1, Math.min(1, v));
  return { dx: c(dx), dy: c(dy), action: action === true };
}

/** Deterministic sim with scripted bots. Pure apart from rules; no IO. */
export function createSim(shared, rules, { seed, scenario, explicit = true }) {
  const gameBot = typeof rules.bot === "function" ? rules.bot : null;
  const showcase = typeof rules.showcase === "function" ? rules.showcase : null;
  const sc = resolveScenario(explicit ? scenario : showcase ? SHOWCASE_SCENARIO : gameBot ? GAME_BOT_SCENARIO : scenario);
  const world = shared.createWorld(seed);
  rules.init?.(world);
  const botIds = Array.from({ length: sc.bots }, (_, i) => `bot${i}`);
  for (const id of botIds) shared.joinPlayer(world, rules, id, id);
  const view = {
    get tick() { return world.tick; },
    get entities() { return Object.values(world.entities); },
    bot: (i) => world.entities[botIds[i]],
    // The game's own bot input for bot i (1-based number, as the live server numbers them); null without one.
    gameBot: (i) => {
      if (!gameBot) return null;
      try { return cleanInput(gameBot(world, botIds[i], i + 1)); } catch { return null; }
    },
    // The game's staged input for bot i (the hero), which the spectator camera follows; null without one.
    showcase: (i) => {
      const hero = world.entities[botIds[i]];
      if (hero) hero.data = { ...(hero.data ?? {}), showcase: true };
      if (!showcase) return null;
      try { return cleanInput(showcase(world, botIds[i], world.tick)); } catch { return null; }
    },
  };
  let exceptions = 0;
  return {
    world,
    scenario: sc,
    get exceptions() { return exceptions; },
    step() {
      const inputs = {};
      botIds.forEach((id, i) => {
        const inp = sc.input(world.tick, i, view) ?? {};
        inputs[id] = { dx: Number(inp.dx) || 0, dy: Number(inp.dy) || 0, action: !!inp.action };
      });
      try { shared.runTick(world, rules, inputs); } catch (e) { exceptions++; if (exceptions <= 3) console.error("tick exception", e); }
    },
  };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm" };

export async function startServer({ root, port, seed = 1337, scenario, explicit = true, version = "present", game = null }) {
  const { shared, rules, gamePkg, game: slug } = await loadGame(root, game);
  const sim = createSim(shared, rules, { seed, scenario, explicit });
  const dist = path.resolve(root, "apps/client/dist");
  const costs = [];
  let viewer = null;
  let timer = null;
  // The recorder freezes the sim at a tick to screenshot both sides at exactly the same state.
  let holdAt = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/__hold") {
      const at = Number(url.searchParams.get("at"));
      holdAt = Number.isFinite(at) && at > 0 ? at : null;
      res.end("ok");
      return;
    }
    if (url.pathname === "/__state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tick: sim.world.tick, started: !!timer, holdAt, exceptions: sim.exceptions, scenario: sim.scenario.name, seed, gamePkg, game: slug, simCostsMs: costs }));
      return;
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, "");
    let file = path.join(dist, rel || "index.html");
    // Game pages are built per game (dist/games/<slug>.html): /game and /<slug>/game serve the presented one.
    const page = slug && path.join(dist, "games", `${slug}.html`);
    if (page && fs.existsSync(page) && (/^\/game(\.html)?\/?$/.test(url.pathname) || url.pathname === `/${slug}/game`)) file = page;
    // Same routing as Workers Static Assets: /game -> game.html (the sandboxed game page).
    if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
    res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
    // Cross-origin isolation: performance.now() at 5us instead of 100us resolution, so sub-ms
    // frame costs are measurable.
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("cross-origin-embedder-policy", "require-corp");
    // The game page runs in <iframe sandbox="allow-scripts"> (opaque origin): its module scripts
    // are CORS requests and every resource must be embeddable under COEP, as in apps/server.
    res.setHeader("cross-origin-resource-policy", "cross-origin");
    res.setHeader("access-control-allow-origin", "*");
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!/^\/parties\/[^/]+\/[^/?]+/.test(req.url ?? "")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      // One viewer per run. A reconnect replaces the old socket without resetting the sim.
      if (viewer && viewer.readyState === viewer.OPEN) viewer.close();
      viewer = ws;
      ws.on("message", () => {}); // spectator: inputs ignored
      ws.send(JSON.stringify({ t: "hello", version, tick: sim.world.tick, draining: false }));
      if (!timer) {
        timer = setInterval(() => {
          if (holdAt !== null && sim.world.tick >= holdAt) return;
          const t0 = performance.now();
          sim.step();
          const msg = JSON.stringify(shared.snapMessage(sim.world, version, false));
          costs.push(+(performance.now() - t0).toFixed(3));
          if (viewer?.readyState === viewer.OPEN) viewer.send(msg);
        }, TICK_MS);
      }
    });
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    sim,
    gamePkg,
    game: slug,
    port: server.address().port,
    close: () => new Promise((r) => { clearInterval(timer); wss.close(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { root: { type: "string" }, port: { type: "string", default: "8787" }, seed: { type: "string", default: "1337" }, scenario: { type: "string" }, version: { type: "string", default: "present" }, game: { type: "string" }, explicit: { type: "boolean", default: false } } });
  if (!values.root) { console.error("--root <checkout> required"); process.exit(2); }
  const s = await startServer({ root: values.root, port: Number(values.port), seed: Number(values.seed), scenario: values.scenario, explicit: values.explicit, version: values.version, game: values.game ?? null });
  console.log(JSON.stringify({ ready: true, port: s.port, scenario: s.sim.scenario.name, gamePkg: s.gamePkg, game: s.game }));
  const stop = () => s.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
