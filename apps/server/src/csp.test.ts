import { describe, it, expect } from "vitest";
import { gameCsp, hostCsp, isGamePage, pageHeaders } from "./csp.js";

const directives = (csp: string) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("csp", () => {
  const url = new URL("https://tcg-live.example.workers.dev/game");

  it("is strict on both pages: no inline, no eval, nothing but self", () => {
    for (const csp of [hostCsp(url), gameCsp(url)]) {
      const d = directives(csp);
      expect(d["default-src"]).toEqual(["'none'"]);
      expect(d["script-src"]).toEqual(["'self'"]);
      expect(d["style-src"]).toEqual(["'self'"]);
      expect(d["connect-src"]).toEqual(["'self'", "wss://tcg-live.example.workers.dev"]);
      expect(d["img-src"]).toEqual(["'self'", "blob:", "data:"]);
      expect(d["media-src"]).toEqual(["'self'", "blob:"]);
      expect(csp).not.toMatch(/unsafe-|\*/);
    }
  });

  it("host may frame the game; the game is sandboxed and frameable only by us", () => {
    expect(directives(hostCsp(url))["frame-src"]).toEqual(["'self'"]);
    const g = directives(gameCsp(url));
    expect(g.sandbox).toEqual(["allow-scripts"]);
    expect(g["frame-ancestors"]).toEqual(["'self'"]);
    expect(g["frame-src"]).toBeUndefined();
  });

  it("picks the policy by path and uses ws: for local http", () => {
    expect(isGamePage("/game") && isGamePage("/game.html") && !isGamePage("/") && !isGamePage("/gamex")).toBe(true);
    expect(pageHeaders(new URL("https://h/"))["Content-Security-Policy"]).toContain("frame-src");
    expect(pageHeaders(new URL("https://h/game"))["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(hostCsp(new URL("http://127.0.0.1:8787/"))).toContain("connect-src 'self' ws://127.0.0.1:8787");
  });

  it("every game's page is sandboxed, also when its built path is opened directly", () => {
    for (const p of ["/agar/game", "/agar/game/", "/week-2/game", "/games/agar", "/games/agar.html"]) {
      expect(isGamePage(p), p).toBe(true);
      expect(pageHeaders(new URL(`https://h${p}`))["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    }
    for (const p of ["/agar", "/agar/", "/agar/gamex", "/a/b/game"]) expect(isGamePage(p), p).toBe(false);
  });

  it("adds allowed overlay origins to frame-ancestors on both pages and drops malformed ones", () => {
    const url = new URL("https://tcg-live.example.workers.dev/");
    const extra = "http://127.0.0.1:5200 javascript:alert(1) 'unsafe-inline' https://overlay.example";
    for (const csp of [hostCsp(url, extra), gameCsp(url, extra)]) {
      expect(directives(csp)["frame-ancestors"]).toEqual(["'self'", "http://127.0.0.1:5200", "https://overlay.example"]);
    }
    expect(directives(hostCsp(url))["frame-ancestors"]).toEqual(["'self'"]);
  });
});
