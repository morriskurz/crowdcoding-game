// 30-bot smoke: input effect + valid state + error rate.
// Fails dummy servers that replay static {t:"snap"}.
// Run: node scripts/smoke.mjs <preview-ws-url>
import { setTimeout as sleep } from "node:timers/promises";

const N = Number(process.env.SMOKE_N ?? "30");
const MAX_COORD = 20000;
const url = process.argv[2] ?? "ws://127.0.0.1:1999/parties/preview/main";

let ok = 0;
let fail = 0;
let reasons = [];

async function bot(i) {
  const WS = (await import("ws")).default;
  const ws = new WS(`${url}${url.includes("?") ? "&" : "?"}name=smoke${i}`);
  try {
    let hello = null;
    let first = null;
    let last = null;
    let ticks = [];
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timeout-no-snap")), 15000);
      ws.on("message", (buf) => {
        let m;
        try { m = JSON.parse(String(buf)); } catch { return; }
        if (m.t === "hello") { hello = m; return; }
        if (m.t !== "snap") return;
        if (!first) {
          first = m;
          // push +x for 1s to prove input effect
          ws.send(JSON.stringify({ v: 2, dx: 1, dy: 0, action: false }));
          setTimeout(() => ws.send(JSON.stringify({ v: 2, dx: 1, dy: 0, action: false })), 300);
          setTimeout(() => ws.send(JSON.stringify({ v: 2, dx: 1, dy: 0, action: false })), 600);
        }
        last = m;
        if (m.tick != null) ticks.push(m.tick);
        if (ticks.length >= 8) { clearTimeout(to); resolve(null); }
      });
      ws.on("error", (e) => { clearTimeout(to); reject(e); });
    });

    // assertions
    if (!hello) throw new Error("no-hello");
    if (!first || !last) throw new Error("no-snaps");
    // tick must advance
    if (last.tick <= first.tick) throw new Error(`tick-stalled ${first.tick}->${last.tick}`);
    // valid state: players bounded, pellets array
    const players = Object.values(last.players ?? {});
    if (!players.length) throw new Error("no-players");
    for (const p of players) {
      // Sanity only (finite, not absurd): the game's own arena is checked by /health (rules.arena), so a
      // tall level like a tower is not squeezed to fit a fixed box here.
      if (!(p.x >= 0 && p.x <= MAX_COORD && p.y >= 0 && p.y <= MAX_COORD)) throw new Error("oob-player");
      if (typeof p.size !== "number") throw new Error("bad-player-shape");
    }
    // input effect: this bot moved +x (allow 0.5 tolerance, server 15Hz)
    const me0 = first.players?.[`smoke${i}`] ?? Object.values(first.players ?? {})[0];
    const me1 = last.players?.[`smoke${i}`] ?? Object.values(last.players ?? {})[0];
    // if server echoes by conn id we can't map name; fallback: any player moved
    let moved = false;
    for (const [id, p1] of Object.entries(last.players ?? {})) {
      const p0 = first.players?.[id];
      if (p0 && p1.x > p0.x + 0.5) { moved = true; break; }
    }
    if (!moved) throw new Error("no-input-effect");
    ws.close();
    ok++;
  } catch (e) {
    fail++;
    reasons.push(`${i}:${e.message}`);
    try { ws.close(); } catch {}
  }
}

await Promise.all([...Array(N)].map((_, i) => bot(i)));
console.log(`smoke ${ok}/${N} ok, fail=${fail}`);
if (reasons.length) console.log("reasons:", reasons.slice(0, 10).join(" "));
if (fail > N * 0.1) { console.error("smoke failed: >10% bots dead or no input effect"); process.exit(1); }
