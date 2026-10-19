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
// Run: node scripts/present/server.mjs --root <checkout> --port 8787 [--seed 1337] [--scenario idle-crowd]
// Prints one JSON line {"ready":true,...} on stdout when listening.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { WebSocketServer } from "ws";
import { resolveScenario } from "../scenarios/index.mjs";

export const TICK_HZ = 15;
const TICK_MS = 1000 / TICK_HZ;

/** Load @tcg/shared and the game package exactly as the checkout's server resolves them. */
export async function loadGame(root) {
  const req = createRequire(path.join(path.resolve(root), "apps/server/package.json"));
  const load = (spec) => tsImport(pathToFileURL(req.resolve(spec)).href, import.meta.url);
  const shared = await load("@tcg/shared");
  // room.ts imports `rules` from the game package; keep that coupling in one place.
  const roomSrc = fs.readFileSync(path.join(root, "apps/server/src/room.ts"), "utf8");
  const gamePkg = roomSrc.match(/import\s*\{[^}]*\brules\b[^}]*\}\s*from\s*["'](@tcg\/game-[\w-]+)["']/)?.[1] ?? "@tcg/game-template";
  const game = await load(gamePkg);
  if (!game.rules) throw new Error(`${gamePkg} exports no rules`);
  return { shared, rules: game.rules, gamePkg };
}

/** Deterministic sim with scripted bots. Pure apart from rules; no IO. */
export function createSim(shared, rules, { seed, scenario }) {
  const sc = resolveScenario(scenario);
  const world = shared.createWorld(seed);
  rules.init?.(world);
  const botIds = Array.from({ length: sc.bots }, (_, i) => `bot${i}`);
  for (const id of botIds) shared.joinPlayer(world, rules, id, id);
  const view = {
    get tick() { return world.tick; },
    get entities() { return Object.values(world.entities); },
    bot: (i) => world.entities[botIds[i]],
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

export async function startServer({ root, port, seed = 1337, scenario, version = "present" }) {
  const { shared, rules, gamePkg } = await loadGame(root);
  const sim = createSim(shared, rules, { seed, scenario });
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
      res.end(JSON.stringify({ tick: sim.world.tick, started: !!timer, holdAt, exceptions: sim.exceptions, scenario: sim.scenario.name, seed, gamePkg, simCostsMs: costs }));
      return;
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, "");
    let file = path.join(dist, rel || "index.html");
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
    port: server.address().port,
    close: () => new Promise((r) => { clearInterval(timer); wss.close(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { root: { type: "string" }, port: { type: "string", default: "8787" }, seed: { type: "string", default: "1337" }, scenario: { type: "string" }, version: { type: "string", default: "present" } } });
  if (!values.root) { console.error("--root <checkout> required"); process.exit(2); }
  const s = await startServer({ root: values.root, port: Number(values.port), seed: Number(values.seed), scenario: values.scenario, version: values.version });
  console.log(JSON.stringify({ ready: true, port: s.port, scenario: s.sim.scenario.name, gamePkg: s.gamePkg }));
  const stop = () => s.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
