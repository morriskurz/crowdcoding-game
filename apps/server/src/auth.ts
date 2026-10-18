// Real Twitch token validation. No stub: without TWITCH_CLIENT_ID we fail closed,
// except tests which inject a fetcher. Watch-time is enforced by the bot (first-seen),
// the game server only binds a validated user_id to the connection.
export interface Viewer { id: string; login: string; scopes: string[]; }

export async function verifyViewer(
  token: string | null,
  clientId: string | null = process.env.TWITCH_CLIENT_ID ?? null,
  fetcher: typeof fetch = fetch
): Promise<Viewer | null> {
  if (!token || !token.startsWith("oauth:")) return null;
  if (!clientId) return null; // fail closed in prod; tests pass a fetcher + id
  const res = await fetcher("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token.replace(/^oauth:/, "")}` },
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  if (!j?.user_id || !j?.login) return null;
  return { id: String(j.user_id), login: String(j.login), scopes: j.scopes ?? [] };
}
