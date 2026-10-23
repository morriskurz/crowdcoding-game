import { Server, type Connection } from "partyserver";
import { InputAcks, InputSchema, createWorld, joinPlayer, leavePlayer, packInput, runTick, snapMessage, type Input, type PackedInput, type World } from "@tcg/shared";
import { CURRENT_SLUG, GAMES, gameForRoom, type Game } from "@tcg/games";
import { RateLimit } from "./ratelimit.js";
import { TickGuard } from "./tick.js";
import { Bots, botTarget, isBotId } from "./bots.js";

// One Durable Object = one room. Authoritative 15Hz on setInterval, never alarms (spec §3, §13 cost).
// The interval runs only while at least one player is connected: Durable Object duration is billed
// while the object is kept busy, so an empty room stops ticking and the next connect restarts it
// (the main room always has the stream overlay connected as a spectator, so it never stops).
// Spectators (`?spectate=1`) get snapshots but no player: they never join the world, send no
// input and do not count toward MAX_PLAYERS. They keep the room ticking like players do.
// The room's name picks its game (@tcg/games gameForRoom): "main" and test rooms run the current
// game; a room named after an older game's slug runs that game as an archive (still playable,
// flagged `archived` in hello, snapshots and /health). An archived room with players is filled up
// with server-side bots (bots.ts), removed again when the last player leaves.
const MAX_PLAYERS = 100;
const MAX_SPECTATORS = 200;
const TICK_MS = 1000 / 15;
const TICK_BUDGET_MS = 50; // spec §9: tick p95 > 50ms is a rollback trigger

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

  async onStart() {
    this.buildVersion = (this.env as any)?.BUILD_VERSION ?? "v1";
    const g = gameForRoom(this.name);
    this.game = GAMES[g.slug];
    this.archived = g.archived;
    this.game.rules.init?.(this.world);
    // No tick yet: the first connect starts it (a /health probe must not keep an empty room busy).
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
    // Bots (archived rooms only) get their input from the world before the step, like a client would.
    const all = this.bots.ids.length ? { ...this.inputs, ...this.bots.inputs(this.world, this.draining) } : this.inputs;
    runTick(this.world, this.game.rules, all);
    this.acks.ticked(Object.keys(this.inputs));
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
        tick: this.world.tick,
        draining: this.draining,
        game: this.game.slug,
        archived: this.archived,
        bots: this.bots.ids.length,
        spectators: this.spectators.size,
        ticking: this.tickTimer !== null,
        ticks: await this.tickGuard.stats(),
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
