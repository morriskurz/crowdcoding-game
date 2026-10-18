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

// throttle to 15Hz, inputs-only
export function sendInput(ws: PartySocket, dx: number, dy: number): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ v: 2, dx: Math.max(-1, Math.min(1, dx)), dy: Math.max(-1, Math.min(1, dy)), action: false }));
}
