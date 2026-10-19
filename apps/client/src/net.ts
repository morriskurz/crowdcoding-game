import PartySocket from "partysocket";

export interface ConnectOpts { env?: string; name?: string; }

export function connect(
  roomName: string,
  onSnap: (s: any) => void,
  onHello: (h: any) => void,
  opts: ConnectOpts = {}
): PartySocket {
  const party = opts.env === "live" ? "live" : "preview";
  const ws = new PartySocket({
    // Production: the Worker that serves the client also hosts the rooms, so use the same host.
    host: import.meta.env.VITE_PARTY_HOST ?? (import.meta.env.PROD ? location.host : "127.0.0.1:1999"),
    party,
    room: roomName,
    query: { name: (opts.name ?? "anon").slice(0, 16) },
  });
  ws.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "snap") onSnap(m);
    else if (m.t === "hello" || m.t === "drain") onHello(m);
  };
  return ws;
}

// Inputs only. Callers keep under the server's 10 msg/s limit (bridge.ts SendBudget).
// `seq` (protocol v4) is echoed back in snap.acks for prediction/reconciliation.
export function sendInput(ws: PartySocket, dx: number, dy: number, action = false, seq?: number): boolean {
  if (ws.readyState !== 1) return false;
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  const msg: Record<string, unknown> = { v: 2, dx: clamp(dx), dy: clamp(dy), action: action === true };
  if (seq !== undefined && Number.isInteger(seq) && seq >= 0) msg.seq = seq;
  ws.send(JSON.stringify(msg));
  return true;
}
