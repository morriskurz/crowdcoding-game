import { Server, type Connection } from "partyserver";
import { InputAcks, InputSchema, createWorld, joinPlayer, leavePlayer, packInput, runTick, snapMessage, type Input, type PackedInput, type World } from "@tcg/shared";
import { CURRENT_SLUG, GAMES, gameForRoom, type Game } from "@tcg/games";
import { RateLimit } from "./ratelimit.js";
import { TickGuard } from "./tick.js";
import { BOT_NAMES_MS, Bots, botTarget, fetchBotNames, isBotId } from "./bots.js";
import { gameplay } from "./gameplay.js";

// One Durable Object = one room. Authoritative 15Hz on setInterval, never alarms (spec §3, §13 cost).
// The interval runs only while at least one player is connected: Durable Object duration is billed
// while the object is kept busy, so an empty room stops ticking and the next connect restarts it
// (the main room always has the stream overlay connected as a spectator, so it never stops).
// Spectators (`?spectate=1`) get snapshots but no player: they never join the world, send no
// input and do not count toward MAX_PLAYERS. They keep the room ticking like players do.
// The room's name picks its game (@tcg/games gameForRoom): "main" and test rooms run the current
// game; a room named after an older game's slug runs that game as an archive (still playable,
// flagged `archived` in hello, snapshots and /health). A room with anyone connected is filled up with
// server-side bots (bots.ts: many for an archive, a few for the current game), removed again when the
// last connection leaves. Bots carry the names of the chat's top suggesters (CHAT_BOT service binding).
// The world is saved to DO storage every SAVE_EVERY_TICKS and restored on start when the build is the
// same, so an evicted or restarted object does not wipe the game (a deploy still starts fresh).
const MAX_PLAYERS = 100;
const MAX_SPECTATORS = 200;
const TICK_MS = 1000 / 15;
const TICK_BUDGET_MS = 50; // spec §9: tick p95 > 50ms is a rollback trigger
export const SAVE_EVERY_TICKS = 15 * 30;
const SAVE_KEY = "world";

export class Room extends Server {
  world: World = createWorld(crypto.getRandomValues(new Uint32Array(1))[0]);
  buckets = new Map<string, RateLimit>();
  // Clients send inputs only on change; the server holds the last one per player (spec §3).
  inputs: Record<string, Input> = {};
  // Which input seq each tick applied, echoed in snapshots for client reconciliation.
  acks = new InputAcks();
  buildVersion: string = "v1";
  tickTimer: ReturnType<typeof setInterval> | null = null;
  tickGuard = new TickGuard(this.ctx.storage, TICK_MS, TICK_BUDGET_MS);
  draining = false;
  game: Game = GAMES[CURRENT_SLUG];
  archived = false;
  bots = new Bots();
  spectators = new Set<string>();
  namesAt = -Infinity;

  async onStart() {
    this.buildVersion = (this.env as any)?.BUILD_VERSION ?? "v1";
    const g = gameForRoom(this.name);
    this.game = GAMES[g.slug];
    this.archived = g.archived;
    if (!(await this.restore())) this.game.rules.init?.(this.world);
    await this.refreshBotNames();
    // No tick yet: the first connect starts it (a /health probe must not keep an empty room busy).
  }

  /** The saved world of this build and game, without the players and bots of the old connections. */
  async restore(): Promise<boolean> {
    const saved = (await this.ctx.storage.get(SAVE_KEY).catch(() => undefined)) as { version: string; slug: string; world: World } | undefined;
    if (!saved || saved.version !== this.buildVersion || saved.slug !== this.game.slug || !saved.world?.entities) return false;
    this.world = saved.world;
    for (const id of Object.keys(this.world.names)) leavePlayer(this.world, this.game.rules, id);
    return true;
  }

  save() {
    this.ctx.storage.put(SAVE_KEY, { version: this.buildVersion, slug: this.game.slug, world: this.world }).catch(() => {});
  }

  /** Bots are named after the chat's top suggesters (tcg-bot via the CHAT_BOT service binding), at most every BOT_NAMES_MS. */
  async refreshBotNames(): Promise<void> {
    const now = Date.now();
    if (now - this.namesAt < BOT_NAMES_MS) return;
    this.namesAt = now;
    const names = await fetchBotNames((this.env as any)?.CHAT_BOT);
    if (names) this.bots.rename(this.world, names);
  }

  /** Real (WebSocket) players that joined; bots are not counted. */
  humans(): number {
    return Object.keys(this.inputs).length;
  }

  /** After every join/leave: bots for archived rooms, and tick only while somebody is connected. */
  syncRoom() {
    const humans = this.humans();
    const connected = humans + this.spectators.size;
    this.bots.sync(this.world, this.game.rules, botTarget(this.archived, humans, this.spectators.size));
    if (connected > 0) void this.refreshBotNames();
    if (connected > 0 && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.tickGuard.run(() => this.onTick()), TICK_MS);
    } else if (connected === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      this.tickGuard.pause();
    }
  }

  onConnect(conn: Connection, ctx: { request: Request }) {
    if (isBotId(conn.id)) { // client-chosen id (_pk) must not take over a bot
      conn.close();
      return;
    }
    const url = new URL(ctx.request?.url ?? "http://x/?name=anon");
    if (isSpectate(url)) {
      if (this.spectators.size >= MAX_SPECTATORS) {
        conn.send(JSON.stringify({ t: "full" }));
        conn.close();
        return;
      }
      this.spectators.add(conn.id);
      this.syncRoom();
      conn.send(JSON.stringify({ ...this.hello(), spectator: true }));
      return;
    }
    if (this.humans() >= MAX_PLAYERS) {
      conn.send(JSON.stringify({ t: "full" }));
      conn.close();
      return;
    }
    const raw = (url.searchParams.get("name") ?? conn.id).slice(0, 16);
    joinPlayer(this.world, this.game.rules, conn.id, raw);
    this.inputs[conn.id] = { dx: 0, dy: 0, action: false };
    this.acks.join(conn.id);
    this.syncRoom();
    conn.send(JSON.stringify(this.hello()));
  }

  hello() {
    return { t: "hello", version: this.buildVersion, tick: this.world.tick, draining: this.draining, game: this.game.slug, title: this.game.title, archived: this.archived };
  }

  onClose(conn: Connection) {
    this.buckets.delete(conn.id);
    if (this.spectators.delete(conn.id)) { this.syncRoom(); return; }
    if (!(conn.id in this.inputs)) return; // rejected (full, or a bot id): never joined
    leavePlayer(this.world, this.game.rules, conn.id);
    delete this.inputs[conn.id];
    this.acks.leave(conn.id);
    this.syncRoom();
  }

  async onMessage(sender: Connection, msg: string | ArrayBuffer | ArrayBufferView) {
    const b = this.buckets.get(sender.id) ?? new RateLimit();
    this.buckets.set(sender.id, b);
    if (!b.hit()) return;

    let parsed: unknown;
    try { parsed = JSON.parse(typeof msg === "string" ? msg : ""); } catch { return; }
    const r = InputSchema.safeParse(parsed);
    if (!r.success) return;
    if (!(sender.id in this.inputs) || this.draining) return;
    if (!this.acks.received(sender.id, r.data.seq)) return; // reordered: keep the newer input
    this.inputs[sender.id] = { dx: r.data.dx, dy: r.data.dy, action: r.data.action };
  }

  onTick() {
    // Bots get their input from the world before the step, like a client would.
    const all = this.bots.ids.length ? { ...this.inputs, ...this.bots.inputs(this.world, this.draining) } : this.inputs;
    runTick(this.world, this.game.rules, all);
    this.acks.ticked(Object.keys(this.inputs));
    if (this.world.tick % SAVE_EVERY_TICKS === 0) { this.save(); void this.refreshBotNames(); }
    const inputs: Record<string, PackedInput> = {};
    for (const id in all) inputs[id] = packInput(all[id]);
    this.broadcast(JSON.stringify(snapMessage(this.world, this.buildVersion, this.draining, { acks: this.acks.acks, inputs, ...this.archiveFlag() })));
  }

  // Snapshots of the current game stay byte-identical; archived rooms add {archived, game}.
  archiveFlag(): { archived?: true; game?: string } {
    return this.archived ? { archived: true, game: this.game.slug } : {};
  }

  // called by deploy pipeline: stop accepting inputs, let old room drain
  startDrain() {
    this.draining = true;
    for (const id of Object.keys(this.inputs)) this.inputs[id] = { dx: 0, dy: 0, action: false };
    this.broadcast(JSON.stringify({ t: "drain", version: this.buildVersion, draining: true }));
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__drain" && req.method === "POST") {
      this.startDrain();
      return Response.json({ ok: true, draining: this.draining });
    }
    if (url.pathname === "/__health") {
      return Response.json({
        version: this.buildVersion,
        players: Object.keys(this.world.names).length,
        humans: this.humans(),
        tick: this.world.tick,
        draining: this.draining,
        game: this.game.slug,
        archived: this.archived,
        bots: this.bots.ids.length,
        spectators: this.spectators.size,
        ticking: this.tickTimer !== null,
        ticks: await this.tickGuard.stats(),
        gameplay: gameplay(this.world, this.game.rules),
      });
    }
    return new Response("not found", { status: 404 });
  }
}

/** `?spectate=1` (or `true`, or a bare `?spectate`): watch without a player. */
export function isSpectate(url: URL): boolean {
  const v = url.searchParams.get("spectate");
  return v !== null && v !== "0" && v !== "false";
}
