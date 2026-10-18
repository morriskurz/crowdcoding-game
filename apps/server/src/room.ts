import { Server, type Connection } from "partyserver";
import { InputAcks, InputSchema, createWorld, joinPlayer, leavePlayer, packInput, runTick, snapMessage, type Input, type PackedInput, type World } from "@tcg/shared";
import { rules } from "@tcg/game-template";
import { RateLimit } from "./ratelimit.js";
import { TickGuard } from "./tick.js";

// One Durable Object = one room. Authoritative 15Hz on setInterval, never alarms (spec §3, §13 cost).
const MAX_PLAYERS = 100;
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

  async onStart() {
    this.buildVersion = (this.env as any)?.BUILD_VERSION ?? "v1";
    rules.init?.(this.world);
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tickGuard.run(() => this.onTick()), TICK_MS);
    }
  }

  onConnect(conn: Connection, ctx: { request: Request }) {
    if (Object.keys(this.world.names).length >= MAX_PLAYERS) {
      conn.send(JSON.stringify({ t: "full" }));
      conn.close();
      return;
    }
    const url = new URL(ctx.request?.url ?? "http://x/?name=anon");
    const raw = (url.searchParams.get("name") ?? conn.id).slice(0, 16);
    joinPlayer(this.world, rules, conn.id, raw);
    this.inputs[conn.id] = { dx: 0, dy: 0, action: false };
    this.acks.join(conn.id);
    conn.send(JSON.stringify({ t: "hello", version: this.buildVersion, tick: this.world.tick, draining: this.draining }));
  }

  onClose(conn: Connection) {
    this.buckets.delete(conn.id);
    if (!(conn.id in this.world.names)) return; // rejected as full: never joined
    leavePlayer(this.world, rules, conn.id);
    delete this.inputs[conn.id];
    this.acks.leave(conn.id);
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
    runTick(this.world, rules, this.inputs);
    this.acks.ticked(Object.keys(this.inputs));
    const inputs: Record<string, PackedInput> = {};
    for (const id in this.inputs) inputs[id] = packInput(this.inputs[id]);
    this.broadcast(JSON.stringify(snapMessage(this.world, this.buildVersion, this.draining, { acks: this.acks.acks, inputs })));
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
        ticks: await this.tickGuard.stats(),
      });
    }
    return new Response("not found", { status: 404 });
  }
}
