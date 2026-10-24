// Room lifecycle without workerd: partyserver's Server is replaced by a minimal stand-in, and the
// registry gets one extra (archived) game so archive rooms can be tested with today's single game.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Registry from "@tcg/games";
import { Room, SAVE_EVERY_TICKS, isSpectate } from "./room.js";
import { BOT_FILL, CURRENT_FILL } from "./bots.js";

vi.mock("partyserver", () => ({
  Server: class {
    ctx: unknown;
    env: unknown;
    name = "main";
    sent: string[] = [];
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
    broadcast(msg: string) { this.sent.push(msg); }
  },
}));

vi.mock("@tcg/games", async (importOriginal) => {
  const real = (await importOriginal()) as typeof Registry;
  const GAMES = { ...real.GAMES, oldgame: { ...real.GAMES[real.CURRENT_SLUG], slug: "oldgame", title: "old game" } };
  return { ...real, GAMES, gameForRoom: (room: string) => real.gameForRoom(room, real.CURRENT_SLUG, Object.keys(GAMES)) };
});

// (vi.mock calls are hoisted above the imports, so Room and bots see the stand-ins.)

function storage() {
  const m = new Map<string, unknown>();
  return {
    async get(k: string) { return m.get(k); },
    async put(k: string, v: unknown) { m.set(k, structuredClone(v)); },
    async delete(k: string) { return m.delete(k); },
    async list({ prefix }: { prefix: string }) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); },
  };
}

async function room(name: string, store = storage()) {
  const r = new Room({ storage: store } as any, {} as any);
  (r as any).name = name;
  await r.onStart();
  return r;
}

const conn = (id: string) => ({ id, send: vi.fn(), close: vi.fn() }) as any;
const req = (name: string) => ({ request: new Request(`http://x/?name=${name}`) });
const sec = (s: number) => vi.advanceTimersByTime(s * 1000);
const health = async (r: InstanceType<typeof Room>) => (await r.onRequest(new Request("https://do/__health"))).json() as Promise<any>;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Room tick lifecycle", () => {
  it("does not tick until someone connects, stops when the last one leaves, restarts on connect", async () => {
    const r = await room("main");
    expect(vi.getTimerCount()).toBe(0);
    expect(await health(r)).toMatchObject({ ticking: false, tick: 0 });
    sec(2);
    expect(r.world.tick).toBe(0); // a /health probe does not keep an empty room busy

    const a = conn("a");
    r.onConnect(a, req("alice"));
    expect(vi.getTimerCount()).toBe(1);
    sec(1);
    expect(r.world.tick).toBeGreaterThanOrEqual(14);
    expect(r.world.tick).toBeLessThanOrEqual(15);

    r.onClose(a);
    expect(vi.getTimerCount()).toBe(0);
    const stopped = r.world.tick;
    sec(5);
    expect(r.world.tick).toBe(stopped);
    expect(await health(r)).toMatchObject({ ticking: false, players: 0, humans: 0, bots: 0 });

    r.onConnect(conn("b"), req("bob"));
    expect(vi.getTimerCount()).toBe(1);
    sec(1);
    expect(r.world.tick).toBeGreaterThan(stopped);
    // the 5 s pause is not counted as one slow tick
    const h = await health(r);
    expect(h.ticks.current.overruns).toBe(0);
    expect(h).toMatchObject({ ticking: true, players: 1 + CURRENT_FILL - 1, humans: 1, bots: CURRENT_FILL - 1, archived: false });
  });

  it("keeps ticking while any player is still connected", async () => {
    const r = await room("main");
    const a = conn("a");
    r.onConnect(a, req("a"));
    r.onConnect(conn("b"), req("b"));
    r.onClose(a);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("archived room bots", () => {
  it("appear only while a real player is connected, fill to BOT_FILL, leave with the last player", async () => {
    const r = await room("oldgame");
    expect(r.archived).toBe(true);
    expect(Object.keys(r.world.names)).toEqual([]);
    sec(3);
    expect(r.world.tick).toBe(0); // no players: no bots, no tick

    const a = conn("a");
    r.onConnect(a, req("alice"));
    expect(r.bots.ids.length).toBe(BOT_FILL - 1);
    expect(Object.keys(r.world.names).length).toBe(BOT_FILL);
    const start = r.bots.ids.map((id) => [r.world.entities[id].x, r.world.entities[id].y]);
    sec(3);
    const moved = r.bots.ids.filter((id, i) => r.world.entities[id].x !== start[i][0] || r.world.entities[id].y !== start[i][1]);
    expect(moved.length).toBe(BOT_FILL - 1);
    // bots are ordinary players in the snapshot (names + entities), archive flags unchanged
    const snap = JSON.parse((r as any).sent.at(-1));
    expect(snap).toMatchObject({ t: "snap", archived: true, game: "oldgame" });
    expect(Object.keys(snap.players)).toContain("bot:1");
    expect(snap.inputs["bot:1"]).toBeDefined();
    expect(snap.acks["bot:1"]).toBeUndefined(); // acks are per connection
    expect(await health(r)).toMatchObject({ archived: true, bots: BOT_FILL - 1, players: BOT_FILL, ticking: true });

    const b = conn("b");
    r.onConnect(b, req("bob"));
    expect(r.bots.ids.length).toBe(BOT_FILL - 2);
    r.onClose(a);
    expect(r.bots.ids.length).toBe(BOT_FILL - 1);
    r.onClose(b);
    expect(r.bots.ids).toEqual([]);
    expect(Object.keys(r.world.names)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await health(r)).toMatchObject({ bots: 0, players: 0, ticking: false });
  });

  it("the current game's room gets a few bots, so the stream never shows an empty arena", async () => {
    const r = await room("main");
    const s = conn("s");
    r.onConnect(s, { request: new Request("http://x/?spectate=1") });
    expect(r.bots.ids.length).toBe(CURRENT_FILL);
    const a = conn("a");
    r.onConnect(a, req("a"));
    sec(1);
    expect(r.bots.ids.length).toBe(CURRENT_FILL - 1);
    expect(Object.keys(r.world.names)).toContain("a");
    expect(JSON.parse((r as any).sent.at(-1)).archived).toBeUndefined();
    r.onClose(a);
    r.onClose(s);
    expect(r.bots.ids).toEqual([]);
  });

  it("a client cannot take a bot's id", async () => {
    const r = await room("oldgame");
    r.onConnect(conn("a"), req("a"));
    const evil = conn("bot:1");
    r.onConnect(evil, req("evil"));
    expect(evil.close).toHaveBeenCalled();
    r.onClose(evil);
    expect(r.bots.ids).toContain("bot:1");
    expect(r.world.entities["bot:1"]).toBeDefined();
  });
});

const watch = (name = "") => ({ request: new Request(`http://x/?spectate=1${name ? `&name=${name}` : ""}`) });

describe("spectators", () => {
  it("parses ?spectate", () => {
    expect(isSpectate(new URL("http://x/?spectate=1"))).toBe(true);
    expect(isSpectate(new URL("http://x/?spectate"))).toBe(true);
    expect(isSpectate(new URL("http://x/?spectate=0"))).toBe(false);
    expect(isSpectate(new URL("http://x/?name=a"))).toBe(false);
  });

  it("get snapshots but no player, keep the room ticking, and their inputs are ignored", async () => {
    const r = await room("main");
    const s = conn("s");
    r.onConnect(s, watch("stream"));
    expect(Object.keys(r.world.names)).toEqual(r.bots.ids); // the spectator is no player; only the fill bots are
    expect(JSON.parse(s.send.mock.calls[0][0])).toMatchObject({ t: "hello", spectator: true, game: r.game.slug });
    expect(vi.getTimerCount()).toBe(1);
    sec(1);
    expect(r.world.tick).toBeGreaterThanOrEqual(14);
    await r.onMessage(s, JSON.stringify({ dx: 1, dy: 0 }));
    expect(r.inputs).toEqual({});
    expect(await health(r)).toMatchObject({ humans: 0, spectators: 1, ticking: true });

    const a = conn("a");
    r.onConnect(a, req("alice"));
    expect(Object.keys(r.world.names)).toContain("a");
    r.onClose(a);
    expect(vi.getTimerCount()).toBe(1); // the spectator is still watching
    r.onClose(s);
    expect(vi.getTimerCount()).toBe(0);
    expect(await health(r)).toMatchObject({ players: 0, spectators: 0, ticking: false });
  });

  it("an archived room watched by a spectator alone is filled with bots", async () => {
    const r = await room("oldgame");
    const s = conn("s");
    r.onConnect(s, watch());
    expect(r.bots.ids.length).toBe(BOT_FILL);
    r.onClose(s);
    expect(r.bots.ids).toEqual([]);
  });
});

describe("world persistence", () => {
  it("a restarted room of the same build continues the saved world, without the old connections", async () => {
    const store = storage();
    const r = await room("main", store);
    r.onConnect(conn("a"), req("alice"));
    sec(SAVE_EVERY_TICKS / 15 + 1);
    await Promise.resolve();
    const r2 = await room("main", store);
    expect(r2.world.tick).toBeGreaterThanOrEqual(SAVE_EVERY_TICKS);
    expect(Object.keys(r2.world.names)).toEqual([]);
    expect(r2.world.entities.a).toBeUndefined();
    expect(r2.world.tick % SAVE_EVERY_TICKS).toBe(0);
    expect(Object.values(r2.world.entities).some((e) => e.kind === "pellet")).toBe(true);
  });

  it("a new build starts a fresh world", async () => {
    const store = storage();
    const r = await room("main", store);
    r.onConnect(conn("a"), req("alice"));
    sec(SAVE_EVERY_TICKS / 15 + 1);
    await Promise.resolve();
    const r2 = new Room({ storage: store } as any, { BUILD_VERSION: "other" } as any);
    (r2 as any).name = "main";
    await r2.onStart();
    expect(r2.world.tick).toBe(0);
  });
});

describe("gameplay health", () => {
  it("reports entity kinds and oversized entities against the game's arena", async () => {
    const r = await room("main");
    const h = await health(r);
    expect(h.gameplay.arena).toBeTruthy();
    expect(h.gameplay.kinds.pellet.n).toBeGreaterThan(0);
    expect(h.gameplay.issues).toEqual([]);
    const any = Object.values(r.world.entities)[0];
    any.r = h.gameplay.arena.w;
    expect((await health(r)).gameplay.issues.join(" ")).toMatch(/oversized/);
  });
});
