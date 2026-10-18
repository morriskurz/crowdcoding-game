import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two pages: index.html = host (WebSocket + postMessage bridge), game.html = the sandboxed game.
// In production the Worker serves game.html at /game (Cloudflare assets drop the .html).
export default defineConfig({
  server: { port: 5173 },
  appType: "mpa",
  define: { __BUILD_VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? "v1") },
  build: {
    // No inline <script>/<style>, no data: modules: everything must pass script-src/style-src 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: { input: { index: resolve(__dirname, "index.html"), game: resolve(__dirname, "game.html") } },
  },
  plugins: [{
    name: "game-path",
    configureServer(s) {
      s.middlewares.use((req, _res, next) => { if (req.url === "/game" || req.url?.startsWith("/game?")) req.url = "/game.html" + req.url.slice(5); next(); });
    },
  }],
});
