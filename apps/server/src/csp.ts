// Content-Security-Policy for the two HTML pages (spec §4). No unsafe-inline, no unsafe-eval.
// host page (/)    : owns the WebSocket, frames the game.
// game page (/game): agent-written code. Loaded in <iframe sandbox="allow-scripts">, and the
//                    `sandbox` directive keeps it sandboxed even when opened top-level.

// game page (/<slug>/game, built as /games/<slug>.html): one per game, same policy.

export const GAME_PATHS = new Set(["/game", "/game.html", "/game/"]);

export function isGamePage(pathname: string): boolean {
  return GAME_PATHS.has(pathname) || /^\/[a-z0-9][a-z0-9-]{0,39}\/game(\.html)?\/?$/.test(pathname) || /^\/games\//.test(pathname);
}

function base(url: URL): string[] {
  const ws = `${url.protocol === "http:" ? "ws" : "wss"}://${url.host}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src 'self' ${ws}`,
    "img-src 'self' blob: data:",
    "style-src 'self'",
    "media-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ];
}

export function hostCsp(url: URL): string {
  return [...base(url), "frame-src 'self'"].join("; ");
}

export function gameCsp(url: URL): string {
  return [...base(url), "frame-ancestors 'self'", "sandbox allow-scripts"].join("; ");
}

// Headers added to every HTML response.
export function pageHeaders(url: URL): Record<string, string> {
  return {
    "Content-Security-Policy": isGamePage(url.pathname) ? gameCsp(url) : hostCsp(url),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

export function isHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/html");
}
