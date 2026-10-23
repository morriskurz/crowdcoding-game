// Spectator camera ("director"): picks what to show when nobody is "me" (?spectate=1, the stream
// overlay, or a player who pressed V). Game-agnostic: it only looks at what every game has, the
// entities in the snapshots and which of them are players (ids in `names`). Per snapshot every
// player collects "heat" for things happening around them; heat decays, and the camera follows
// the hottest player, framing nearby hot players too. A switch needs a clearly hotter player and a
// minimum time on the current one, so the view does not flicker between two equal fights.
import type { Entity } from "@tcg/shared";

type Ents = Readonly<Record<string, Entity>>;

export interface DirectorOptions {
  /** Heat halves every this many seconds. */
  halfLife: number;
  /** Seconds the camera stays on a player before it may switch. */
  minDwell: number;
  /** A challenger needs this much more heat than the current focus (ratio). */
  switchRatio: number;
  /** World px: events and other players this close count for a player; hot players this close are framed together. */
  reach: number;
}

const DEFAULTS: DirectorOptions = { halfLife: 2, minDwell: 3, switchRatio: 1.3, reach: 160 };

// Heat weights per snapshot. Movement alone is the weakest signal; things appearing, vanishing,
// growing or shrinking (eating, pickups, hits, kills, respawns) and players meeting are action.
const W_MOVE = 0.02; // per px moved
const W_SIZE = 1.5; // per px of radius change
const W_EVENT = 3; // per entity spawned/despawned within reach
const W_NEAR = 0.5; // per other player within reach
const JUMP = 200; // px in one snapshot: a respawn/teleport, an event, not movement

export class Director {
  readonly opts: DirectorOptions;
  heat = new Map<string, number>();
  focus: string | null = null;
  private since = 0; // time the current focus was picked
  private time = 0;
  private prev: Ents | null = null;
  // Last camera target: kept when there is nobody to follow.
  x = 0;
  y = 0;

  constructor(opts: Partial<DirectorOptions> = {}, center?: { x: number; y: number }) {
    this.opts = { ...DEFAULTS, ...opts };
    if (center) { this.x = center.x; this.y = center.y; }
  }

  /** Feed one authoritative snapshot; `dt` = seconds since the previous one. */
  observe(next: Ents, names: Readonly<Record<string, string>>, dt: number): void {
    this.time += dt;
    const decay = Math.pow(0.5, dt / this.opts.halfLife);
    for (const [id, h] of this.heat) this.heat.set(id, h * decay);

    const players = Object.values(next).filter((e) => e.id in names);
    const ids = new Set(players.map((p) => p.id));
    for (const id of [...this.heat.keys()]) if (!ids.has(id)) this.heat.delete(id);

    const prev = this.prev;
    const reach2 = this.opts.reach ** 2;
    const add = (id: string, v: number) => this.heat.set(id, (this.heat.get(id) ?? 0) + v);
    const nearest = (x: number, y: number): Entity | null => {
      let best: Entity | null = null, bd = Infinity;
      for (const p of players) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2 - p.r * p.r;
        if (d < bd) { bd = d; best = p; }
      }
      return best && bd <= reach2 ? best : null;
    };

    for (const p of players) {
      if (!this.heat.has(p.id)) this.heat.set(p.id, 0);
      const was = prev?.[p.id];
      if (was) {
        const moved = Math.hypot(p.x - was.x, p.y - was.y);
        add(p.id, moved > JUMP ? W_EVENT : moved * W_MOVE);
        add(p.id, Math.abs(p.r - was.r) * W_SIZE);
      }
      for (const q of players) if (q !== p && (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= reach2) add(p.id, W_NEAR);
    }
    if (prev) {
      // Non-player entities that vanished or appeared: credit the nearest player, if close.
      for (const id in prev) if (!next[id] && !(id in names)) { const p = nearest(prev[id].x, prev[id].y); if (p) add(p.id, W_EVENT); }
      for (const id in next) if (!prev[id] && !(id in names)) { const p = nearest(next[id].x, next[id].y); if (p) add(p.id, W_EVENT * 0.5); }
    }
    this.prev = next;
    this.pick(players);
  }

  private pick(players: Entity[]): void {
    if (!players.length) { this.focus = null; return; }
    let best = players[0];
    for (const p of players) {
      const hp = this.heat.get(p.id) ?? 0, hb = this.heat.get(best.id) ?? 0;
      // Nothing happening anywhere: the biggest player is the most interesting one.
      if (hp > hb || (hp === hb && p.r > best.r)) best = p;
    }
    const cur = this.focus && players.find((p) => p.id === this.focus);
    if (!cur) { this.setFocus(best.id); return; }
    if (best.id === cur.id || this.time - this.since < this.opts.minDwell) return;
    const hc = this.heat.get(cur.id) ?? 0, hb = this.heat.get(best.id) ?? 0;
    if (hb > hc * this.opts.switchRatio + 0.5) this.setFocus(best.id);
  }

  private setFocus(id: string): void {
    this.focus = id;
    this.since = this.time;
  }

  /**
   * Camera target for this frame, from the entities being drawn (interpolated): the focused player,
   * pulled toward hot players within reach so a fight stays in frame. Null focus: last target.
   */
  target(list: readonly Entity[]): { x: number; y: number } {
    const f = this.focus ? list.find((e) => e.id === this.focus) : undefined;
    if (!f) return { x: this.x, y: this.y };
    let sx = 0, sy = 0, sw = 0;
    const reach2 = this.opts.reach ** 2;
    for (const e of list) {
      const h = this.heat.get(e.id);
      if (h === undefined || (e.x - f.x) ** 2 + (e.y - f.y) ** 2 > reach2) continue;
      const w = e.id === f.id ? Math.max(h, 1) * 2 : h;
      sx += e.x * w; sy += e.y * w; sw += w;
    }
    this.x = sw > 0 ? sx / sw : f.x;
    this.y = sw > 0 ? sy / sw : f.y;
    return { x: this.x, y: this.y };
  }
}
