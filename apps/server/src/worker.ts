import { Room } from "./room.js";
import { getServerByName } from "partyserver";
import { isHtml, pageHeaders } from "./csp.js";
export { Room };

// One Worker `tcg-live`, no preview environment (spec §3).
// Rooms: /parties/<party>/<room>. The party segment is kept for partysocket URL compatibility
// but does not select an environment: every party name maps to the same live room.
// /health and /drain take ?room= (default "main").

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS?: Fetcher;
  BUILD_VERSION?: string;
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

function cleanRoom(raw: string | null | undefined): string {
  return (raw ?? "main").replace(/[^a-z0-9-_]/gi, "").slice(0, 32) || "main";
}

export function roomFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/parties\/[^/]+\/([^/]+)/);
  return m ? cleanRoom(m[1]) : null;
}

function room(env: Env, name: string) {
  return getServerByName(env.ROOM, name, { locationHint: LOCATION_HINT });
}

export function withCors(res: Response, url?: URL): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  // Strict CSP on the host page and the sandboxed game page (csp.ts).
  if (url && isHtml(res)) for (const [k, v] of Object.entries(pageHeaders(url))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      const name = cleanRoom(url.searchParams.get("room"));
      try {
        const stub = await room(env, name);
        const res = await stub.fetch(new Request("https://do/__health"));
        if (!res.ok) throw new Error(`room health ${res.status}`);
        return Response.json({ ok: true, version: env.BUILD_VERSION ?? "v1", now: Date.now(), room: name, ...(await res.json() as object) });
      } catch (e) {
        return Response.json({ ok: false, version: env.BUILD_VERSION ?? "v1", now: Date.now(), room: name, error: String(e) }, { status: 503 });
      }
    }
    if (url.pathname === "/drain") {
      const name = cleanRoom(url.searchParams.get("room"));
      const stub = await room(env, name);
      const res = await stub.fetch(new Request("https://do/__drain", { method: "POST" }));
      const drained = res.ok;
      return Response.json({ ok: drained, draining: drained, room: name });
    }
    const name = roomFromPath(url.pathname);
    if (name) {
      const stub = await room(env, name);
      const fwd = new Request(req);
      fwd.headers.set("x-partykit-room", name);
      return stub.fetch(fwd);
    }
    if (env.ASSETS) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return withCors(await env.ASSETS.fetch(req), url);
    }
    return new Response("not found", { status: 404 });
  },
};
