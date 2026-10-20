import { Room } from "./room.js";
import { getServerByName } from "partyserver";
import { isHtml, pageHeaders } from "./csp.js";
import { assetPath, resolveRoom, roomFromPath } from "./routes.js";
export { Room };

// One Worker `tcg-live`, no preview environment (spec §3).
// Rooms: /parties/<party>/<room>. The party segment is kept for partysocket URL compatibility
// but does not select an environment: every party name maps to the same live room.
// /health and /drain take ?room= (default "main").
// Several games live side by side (routes.ts): room "main" and /, /game play the current game;
// room <slug> and /<slug>, /<slug>/game play an archived game.

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS?: Fetcher;
  BUILD_VERSION?: string;
  FRAME_ANCESTORS?: string; // stream overlay origin(s) allowed to embed the pages
}

// Rooms live in western Europe, close to the stream box (spec §3).
const LOCATION_HINT: DurableObjectLocationHint = "weur";

// Game assets load inside <iframe sandbox="allow-scripts">: opaque origin, so requests carry
// `Origin: null` and need a wildcard CORS grant (spec §3, §4). No credentials are involved.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function room(env: Env, name: string) {
  return getServerByName(env.ROOM, name, { locationHint: LOCATION_HINT });
}

export function withCors(res: Response, url?: URL, frameAncestors = ""): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  // Strict CSP on the host page and the sandboxed game page (csp.ts).
  if (url && isHtml(res)) for (const [k, v] of Object.entries(pageHeaders(url, frameAncestors))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      const name = resolveRoom(url.searchParams.get("room")).room;
      try {
        const stub = await room(env, name);
        const res = await stub.fetch(new Request("https://do/__health"));
        if (!res.ok) throw new Error(`room health ${res.status}`);
        // The Worker version wins: a long-lived room keeps the version it started with (roomVersion),
        // and deploy.yml waits for `version` to equal the deployed commit.
        const roomHealth = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...roomHealth, ok: true, version: env.BUILD_VERSION ?? "v1", roomVersion: roomHealth.version, now: Date.now(), room: name });
      } catch (e) {
        return Response.json({ ok: false, version: env.BUILD_VERSION ?? "v1", now: Date.now(), room: name, error: String(e) }, { status: 503 });
      }
    }
    if (url.pathname === "/drain") {
      const name = resolveRoom(url.searchParams.get("room")).room;
      const stub = await room(env, name);
      const res = await stub.fetch(new Request("https://do/__drain", { method: "POST" }));
      const drained = res.ok;
      return Response.json({ ok: drained, draining: drained, room: name });
    }
    const name = roomFromPath(url.pathname)?.room;
    if (name) {
      const stub = await room(env, name);
      const fwd = new Request(req);
      fwd.headers.set("x-partykit-room", name);
      return stub.fetch(fwd);
    }
    if (env.ASSETS) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const rewrite = assetPath(url.pathname);
      const asset = rewrite ? new Request(new URL(rewrite, url), req) : req;
      // Headers (CSP) follow the URL the browser asked for: /<slug>/game gets the sandboxed game policy.
      return withCors(await env.ASSETS.fetch(asset), url, env.FRAME_ANCESTORS);
    }
    return new Response("not found", { status: 404 });
  },
};
