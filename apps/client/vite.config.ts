import { defineConfig } from "vite";
import { resolve } from "node:path";
// @ts-ignore plain .mjs owner script, no type declarations
import { writeRegistry } from "../../scripts/registry.mjs";

// Pages: index.html = host (WebSocket + postMessage bridge), games/<slug>.html = one sandboxed game
// page per game, generated from packages/games/* by scripts/registry.mjs (regenerated here, so a
// build always matches the game directories). The Worker serves games/<slug>.html at /<slug>/game
// and the current game's at /game (apps/server/src/routes.ts).
const { games, current } = writeRegistry(resolve(__dirname, "../.."), (m: string) => console.warn(m)) as { games: { slug: string }[]; current: string };
const slugs = new Set(games.map((g) => g.slug));

export default defineConfig({
  server: { port: 5173 },
  appType: "mpa",
  define: { __BUILD_VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? "v1") },
  build: {
    // No inline <script>/<style>, no data: modules: everything must pass script-src/style-src 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        ...Object.fromEntries(games.map((g) => [`game-${g.slug}`, resolve(__dirname, `games/${g.slug}.html`)])),
      },
    },
  },
  plugins: [{
    name: "game-path",
    // Dev server: same routes as the Worker.
    configureServer(s) {
      s.middlewares.use((req, _res, next) => {
        const [path, query = ""] = (req.url ?? "/").split("?");
        const qs = query ? `?${query}` : "";
        const m = /^\/([a-z0-9][a-z0-9-]{0,39})(\/game)?\/?$/.exec(path);
        if (/^\/game(\.html)?\/?$/.test(path)) req.url = `/games/${current}.html${qs}`;
        else if (m && slugs.has(m[1])) req.url = m[2] ? `/games/${m[1]}.html${qs}` : `/index.html${qs}`;
        next();
      });
    },
  }],
});
