// TPP-style crowd input: chat votes direction each second, majority wins.
// Client merges local WASD + crowd vote (local wins if pressed).
const votes = new Map<string, number>();
let crowdDx = 0;
let crowdDy = 0;

export function feedChat(text: string, user: string): void {
  const m = text.trim().toLowerCase();
  const dir =
    m === "!u" || m === "up" ? [0, -1] :
    m === "!d" || m === "down" ? [0, 1] :
    m === "!l" || m === "left" ? [-1, 0] :
    m === "!r" || m === "right" ? [1, 0] : null;
  if (!dir) return;
  votes.set(user + dir.join(","), 1);
  // tally simple: count per dir in last window
  if (votes.size > 200) votes.clear();
}

export function crowdTick(): { dx: number; dy: number } {
  // called 1Hz: recompute from votes map keys
  const tally = new Map<string, number>();
  for (const k of votes.keys()) {
    const dir = k.slice(k.lastIndexOf("_") + 1) || k;
    tally.set(dir, (tally.get(dir) ?? 0) + 1);
  }
  let best = "0,0";
  let bestN = 0;
  for (const [d, n] of tally) if (n > bestN) { best = d; bestN = n; }
  const [x, y] = best.split(",").map(Number);
  crowdDx = Number.isFinite(x) ? x : 0;
  crowdDy = Number.isFinite(y) ? y : 0;
  votes.clear();
  return { dx: crowdDx, dy: crowdDy };
}
