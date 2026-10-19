import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick } from "@tcg/shared";
import { CURRENT_SLUG, GAMES, MAIN_ROOM, gameForRoom } from "./index.js";

describe("@tcg/games registry", () => {
  it("has the current game and every entry is a complete game", () => {
    expect(GAMES[CURRENT_SLUG]).toBeDefined();
    for (const [slug, g] of Object.entries(GAMES)) {
      expect(g.slug).toBe(slug);
      expect(g.title.length).toBeGreaterThan(0);
      expect(typeof g.rules.step).toBe("function");
      expect(typeof g.assets.drawEntity).toBe("function");
      expect(typeof g.config).toBe("object");
    }
  });

  it("the template game is registered and its rules run", () => {
    const g = GAMES.template;
    expect(g.title).toBe("agar");
    const w = createWorld(1);
    g.rules.init?.(w);
    joinPlayer(w, g.rules, "a", "alice");
    runTick(w, g.rules, { a: { dx: 1, dy: 0, action: false } });
    expect(w.tick).toBe(1);
  });

  it("the current game is the newest", () => {
    const newest = Object.values(GAMES).reduce((a, b) => (b.created.localeCompare(a.created) || b.slug.localeCompare(a.slug)) > 0 ? b : a);
    expect(newest.slug).toBe(CURRENT_SLUG);
  });

  it("gameForRoom: main/current alias, archived slugs, other rooms", () => {
    const slugs = ["agar", "snake", "tron"];
    expect(gameForRoom(MAIN_ROOM, "tron", slugs)).toEqual({ room: "main", slug: "tron", archived: false });
    expect(gameForRoom("tron", "tron", slugs)).toEqual({ room: "main", slug: "tron", archived: false });
    expect(gameForRoom("agar", "tron", slugs)).toEqual({ room: "agar", slug: "agar", archived: true });
    expect(gameForRoom("snake", "tron", slugs)).toEqual({ room: "snake", slug: "snake", archived: true });
    expect(gameForRoom("smoke42", "tron", slugs)).toEqual({ room: "smoke42", slug: "tron", archived: false });
  });
});
