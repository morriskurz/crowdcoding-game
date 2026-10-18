import fs from "node:fs";
// Real gameplay clip: headless Chrome plays the live client against the real sim.
// No X needed (headless + Playwright video). Proves shipped features in motion:
// double growth (size jumps) + magnet pellets (drift toward player).
import { chromium } from "playwright-core";

const GAME = process.env.GAME_URL ?? "http://127.0.0.1:5173/?room=run&env=preview&name=demo";
const SECS = Number(process.env.DEMO_SECS ?? "20");
const OUT = process.env.DEMO_OUT ?? "demos/demo-gameplay.mp4";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "demos/.raw", size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await page.goto(GAME, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForFunction(() => document.getElementById("banner")?.textContent?.startsWith("live"), null, { timeout: 15000 });
console.log("playing:", await page.evaluate(() => document.getElementById("banner")?.textContent));
// lawnmower pattern to eat pellets across the arena
const t0 = Date.now();
const moves: Array<[string, number]> = [["d", 2500], ["s", 2500], ["a", 2500], ["s", 2500], ["d", 2500], ["w", 2500], ["d", 2500], ["s", 2500]];
let i = 0;
while (Date.now() - t0 < SECS * 1000) {
  const [key, ms] = moves[i++ % moves.length];
  await page.keyboard.down(key);
  await page.waitForTimeout(Math.min(ms, SECS * 1000 - (Date.now() - t0)));
  await page.keyboard.up(key);
}
const size = await page.evaluate(() => (window as any).__lastSnapSize ?? null).catch(() => null);
console.log("player size grew to:", size);
await ctx.close();
await browser.close();
// raw webm listing + mp4 export for easy playback
const raws = fs.readdirSync("demos/.raw").filter((f) => f.endsWith(".webm")).map((f) => `demos/.raw/${f}`);
console.log("raw clips:", raws.join(", "));
if (raws.length > 0 && OUT.endsWith(".mp4")) {
  const { spawnSync } = await import("node:child_process");
  const newest = raws.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
  const r = spawnSync("ffmpeg", ["-y", "-i", newest, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", OUT], { stdio: "inherit" });
  if (r.status === 0) console.log("mp4:", OUT, fs.statSync(OUT).size, "bytes");
}
