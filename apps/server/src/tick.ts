// Tick wrapper (spec §4 B1b, §9). Every tick runs inside try/catch with a time budget.
// Per-minute counts go to DO storage so the rollback watcher can read them via /health.
//
// Workers clocks do not advance during synchronous execution, so the in-tick elapsed time
// is 0 in production. The real signal is the gap between tick starts: a slow tick delays
// the next interval callback. Cost of a tick = max(elapsed, gap - interval).

export interface MinuteStats {
  minute: number; // epoch minute (Date.now() / 60000, floored)
  ticks: number;
  exceptions: number;
  overruns: number; // ticks whose cost exceeded the budget
  maxMs: number;
  p95Ms: number;
}

export interface StatsStorage {
  put(key: string, value: MinuteStats): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: { prefix: string }): Promise<Map<string, unknown>>;
}

export const KEY_PREFIX = "tick:";
const KEEP_MINUTES = 60;
const EXCEPTION_FLUSH_MS = 1000;

const key = (minute: number) => `${KEY_PREFIX}${String(minute).padStart(10, "0")}`;

export function p95(samples: number[]): number {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

export class TickGuard {
  private cur: MinuteStats;
  private costs: number[] = [];
  private prevStart: number | null = null;
  private lastFlush = -Infinity;

  constructor(
    private storage: StatsStorage,
    readonly intervalMs: number,
    readonly budgetMs: number,
    private clock: () => number = () => Date.now(),
    private onError: (e: unknown) => void = (e) => console.error("tick exception", e),
  ) {
    this.cur = this.empty(this.minuteOf(this.clock()));
  }

  /** Runs one tick. Returns false if it threw. Never throws. */
  run(fn: () => void): boolean {
    const start = this.clock();
    this.rollover(start);
    const gap = this.prevStart === null ? this.intervalMs : start - this.prevStart;
    this.prevStart = start;

    let ok = true;
    try {
      fn();
    } catch (e) {
      ok = false;
      this.cur.exceptions++;
      try { this.onError(e); } catch { /* logging must not break the tick loop */ }
    }

    const cost = Math.max(this.clock() - start, gap - this.intervalMs);
    this.cur.ticks++;
    this.costs.push(cost);
    if (cost > this.budgetMs) this.cur.overruns++;
    if (cost > this.cur.maxMs) this.cur.maxMs = cost;

    // Exceptions are what the watcher acts on: persist them soon, not only at minute end.
    if (!ok && start - this.lastFlush >= EXCEPTION_FLUSH_MS) this.flush(start);
    return ok;
  }

  /** The tick loop stopped (empty room): the next run() is a fresh start, not one slow tick. */
  pause(): void {
    this.prevStart = null;
  }

  /** Current (in-memory) minute plus persisted previous minutes, newest first. */
  async stats(): Promise<{ current: MinuteStats; recent: MinuteStats[] }> {
    this.rollover(this.clock());
    const stored = await this.storage.list({ prefix: KEY_PREFIX });
    const recent = [...stored.values()]
      .map((v) => v as MinuteStats)
      .filter((m) => m.minute !== this.cur.minute && m.minute > this.cur.minute - KEEP_MINUTES)
      .sort((a, b) => b.minute - a.minute);
    return { current: this.snapshot(), recent };
  }

  private rollover(now: number) {
    const minute = this.minuteOf(now);
    if (minute === this.cur.minute) return;
    if (this.cur.ticks > 0) this.flush(now);
    this.cur = this.empty(minute);
    this.costs = [];
    // Prune the bucket that just fell out of the window.
    this.storage.delete(key(minute - KEEP_MINUTES)).catch(() => {});
  }

  private flush(now: number) {
    this.lastFlush = now;
    this.storage.put(key(this.cur.minute), this.snapshot()).catch((e) => console.error("tick stats flush failed", e));
  }

  private snapshot(): MinuteStats {
    return { ...this.cur, p95Ms: p95(this.costs) };
  }

  private minuteOf(t: number) { return Math.floor(t / 60000); }
  private empty(minute: number): MinuteStats {
    return { minute, ticks: 0, exceptions: 0, overruns: 0, maxMs: 0, p95Ms: 0 };
  }
}
