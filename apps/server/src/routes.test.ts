import { describe, it, expect } from "vitest";
import { CURRENT_SLUG, GAMES } from "@tcg/games";
import { assetPath, cleanRoom, resolveRoom, roomFromPath } from "./routes.js";

// Two games: "snake" is this week's, "agar" an archive.
const CUR = "snake";
const SLUGS = ["agar", "snake"];

describe("room routing", () => {
  it("no slug = current game in room main (backward compatible)", () => {
    expect(roomFromPath("/parties/live/main", CUR, SLUGS)).toEqual({ room: "main", slug: "snake", archived: false });
    expect(resolveRoom(null, CUR, SLUGS)).toEqual({ room: "main", slug: "snake", archived: false });
    expect(resolveRoom("", CUR, SLUGS)).toEqual({ room: "main", slug: "snake", archived: false });
  });

  it("the current game's slug is an alias of main: one live room", () => {
    expect(roomFromPath("/parties/preview/snake", CUR, SLUGS)).toEqual({ room: "main", slug: "snake", archived: false });
    expect(resolveRoom("snake", CUR, SLUGS).room).toBe("main");
  });

  it("an older game's slug opens its archived room", () => {
    expect(roomFromPath("/parties/live/agar", CUR, SLUGS)).toEqual({ room: "agar", slug: "agar", archived: true });
    expect(resolveRoom("agar", CUR, SLUGS)).toEqual({ room: "agar", slug: "agar", archived: true });
  });

  it("any other room name runs the current game (test rooms, presentations)", () => {
    expect(roomFromPath("/parties/preview/gates1x2y", CUR, SLUGS)).toEqual({ room: "gates1x2y", slug: "snake", archived: false });
    expect(roomFromPath("/parties/preview/Ag<a>r", CUR, SLUGS)).toEqual({ room: "Agar", slug: "snake", archived: false });
  });

  it("non-party paths are not rooms; names are cleaned and capped", () => {
    expect(roomFromPath("/health", CUR, SLUGS)).toBeNull();
    expect(roomFromPath("/agar", CUR, SLUGS)).toBeNull();
    expect(cleanRoom("a/b?c".repeat(20))).toHaveLength(32);
  });

  it("defaults come from the generated registry", () => {
    expect(GAMES[CURRENT_SLUG]).toBeDefined();
    expect(resolveRoom(CURRENT_SLUG)).toEqual({ room: "main", slug: CURRENT_SLUG, archived: false });
    expect(resolveRoom("main").slug).toBe(CURRENT_SLUG);
  });
});

describe("asset routing", () => {
  it("/game is the current game's page", () => {
    for (const p of ["/game", "/game/", "/game.html"]) expect(assetPath(p, CUR, SLUGS)).toBe("/games/snake");
  });

  it("/<slug> is the host page, /<slug>/game that game's page", () => {
    expect(assetPath("/agar", CUR, SLUGS)).toBe("/");
    expect(assetPath("/agar/", CUR, SLUGS)).toBe("/");
    expect(assetPath("/agar/game", CUR, SLUGS)).toBe("/games/agar");
    expect(assetPath("/snake/game", CUR, SLUGS)).toBe("/games/snake");
  });

  it("everything else is served as is", () => {
    for (const p of ["/", "/assets/index-abc.js", "/games/agar", "/nope", "/nope/game", "/agar/game/x", "/AGAR"]) expect(assetPath(p, CUR, SLUGS)).toBeNull();
  });
});
