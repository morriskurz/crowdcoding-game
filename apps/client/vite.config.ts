import { defineConfig } from "vite";
export default defineConfig({
  server: { port: 5173 },
  define: { __BUILD_VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? "v1") },
});
