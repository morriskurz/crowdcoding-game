import { describe, it, expect } from "vitest";
import { verifyViewer } from "./auth.js";

const okFetch = (async () => ({
  ok: true,
  json: async () => ({ user_id: "123", login: "alice", scopes: ["chat:read"] }),
})) as unknown as typeof fetch;

describe("auth", () => {
  it("rejects without token or client id", async () => {
    expect(await verifyViewer(null, "cid", okFetch)).toBeNull();
    expect(await verifyViewer("oauth:x", null, okFetch)).toBeNull();
    expect(await verifyViewer("bad", "cid", okFetch)).toBeNull();
  });
  it("validates via twitch", async () => {
    expect(await verifyViewer("oauth:x", "cid", okFetch)).toEqual({ id: "123", login: "alice", scopes: ["chat:read"] });
    const bad = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await verifyViewer("oauth:x", "cid", bad)).toBeNull();
  });
});
