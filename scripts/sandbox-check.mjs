// Headless check of the sandboxed game iframe against a running Worker (wrangler dev or live):
//   - the game renders inside <iframe sandbox="allow-scripts"> with an opaque origin
//   - zero CSP violations on the host and game pages during normal play
//   - top.location = ... from the game page throws; storage/cookies are unavailable
//   - prediction is active and the own player moves with input
//   - the CSP really bites (inline script and eval are blocked and reported)
// Run: node scripts/sandbox-check.mjs [http://127.0.0.1:8787]   (CHROME_PATH=... to pick a browser)
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = (process.argv[2] ?? process.env.CHECK_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const SHOT = process.env.CHECK_SCREENSHOT;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const cands = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw)) if (/^chromium-\d+$/.test(d)) cands.push(`${pw}/${d}/chrome-linux/chrome`);
  const found = cands.find((p) => fs.existsSync(p));
  if (!found) throw new Error("no Chrome found: set CHROME_PATH");
  return found;
}

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  // Runs in every frame, sandboxed ones included, before page scripts.
  await ctx.addInitScript(() => {
    globalThis.__csp = [];
    addEventListener("securitypolicyviolation", (e) => globalThis.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const consoleCsp = [];
  const errors = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/?room=sandbox-check&name=checker`, { waitUntil: "load" });
  const iframe = await page.waitForSelector("iframe#game");
  check((await iframe.getAttribute("sandbox")) === "allow-scripts", 'iframe sandbox="allow-scripts" (no allow-same-origin, no allow-top-navigation)');
  const game = await iframe.contentFrame();
  check(!!game, "game frame attached");

  await game.waitForFunction(() => globalThis.__tcg?.snaps > 10 && globalThis.__tcg?.frames > 30, null, { timeout: 20000 });
  check(true, "game page receives snapshots via postMessage and renders frames");

  check((await game.evaluate(() => origin)) === "null", "game page has an opaque origin");
  const sandbox = await game.evaluate(() => {
    const r = {};
    try { top.location = "https://example.com/"; r.topNav = "allowed"; } catch (e) { r.topNav = `threw ${e.name}`; }
    try { top.location.href = "https://example.com/"; r.topHref = "allowed"; } catch (e) { r.topHref = `threw ${e.name}`; }
    try { void top.document; r.topDoc = "allowed"; } catch (e) { r.topDoc = `threw ${e.name}`; }
    try { void localStorage; r.storage = "allowed"; } catch (e) { r.storage = `threw ${e.name}`; }
    try { void document.cookie; r.cookie = "allowed"; } catch (e) { r.cookie = `threw ${e.name}`; }
    return r;
  });
  await page.waitForTimeout(300);
  check(sandbox.topNav.startsWith("threw"), `top.location = ... throws (${sandbox.topNav})`);
  check(sandbox.topHref.startsWith("threw"), `top.location.href = ... throws (${sandbox.topHref})`);
  check(sandbox.topDoc.startsWith("threw"), `top.document is inaccessible (${sandbox.topDoc})`);
  check(sandbox.storage.startsWith("threw") && sandbox.cookie.startsWith("threw"), `no storage/cookies (${sandbox.storage}, ${sandbox.cookie})`);
  check(page.url().startsWith(BASE), `host page did not navigate (${page.url()})`);

  // Own player responds to input with prediction on.
  const pos = () => game.evaluate(() => globalThis.__tcg.me);
  await iframe.click();
  const p0 = await pos();
  await page.keyboard.down("d");
  await page.waitForTimeout(1200);
  await page.keyboard.up("d");
  await page.waitForTimeout(300);
  const p1 = await pos();
  const st = await game.evaluate(() => ({ ...globalThis.__tcg }));
  check(st.predicted === true, `prediction active (pending=${st.pending}, corrections=${st.corrections})`);
  check(!!p0 && !!p1 && p1.x > p0.x + 20, `own player moved right (${p0?.x?.toFixed(1)} -> ${p1?.x?.toFixed(1)})`);

  // Something was drawn: the canvas is not a flat fill.
  const colors = await game.evaluate(() => {
    const c = document.getElementById("c");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
  check(colors > 20, `canvas has rendered content (${colors} distinct sampled colors)`);
  if (SHOT) await page.screenshot({ path: SHOT });

  const hostCsp = await page.evaluate(() => globalThis.__csp);
  const gameCsp = await game.evaluate(() => globalThis.__csp);
  check(hostCsp.length === 0 && gameCsp.length === 0 && consoleCsp.length === 0,
    `zero CSP violations during play (host ${hostCsp.length}, game ${gameCsp.length}, console ${consoleCsp.length})${[...hostCsp, ...gameCsp, ...consoleCsp].map((v) => `\n     ${v}`).join("")}`);
  check(errors.length === 0, `no page errors${errors.map((e) => `\n     ${e}`).join("")}`);

  // Negative controls: the policy is actually enforced inside the sandbox.
  const neg = await game.evaluate(async () => {
    const r = {};
    // CDP's Runtime.evaluate is exempt from unsafe-eval; a timer callback runs as page code.
    r.eval = await new Promise((res) => setTimeout(() => { try { res(String(eval("1 + 1"))); } catch (e) { res(`blocked ${e.name}`); } }, 0));
    globalThis.__inline = false;
    const s = document.createElement("script");
    s.textContent = "globalThis.__inline = true";
    document.body.appendChild(s);
    await new Promise((res) => setTimeout(res, 100));
    r.inline = globalThis.__inline ? "ran" : "blocked";
    r.violations = globalThis.__csp.length;
    return r;
  });
  check(neg.eval.startsWith("blocked") && neg.inline === "blocked" && neg.violations >= 2, `CSP enforced in the game frame (eval ${neg.eval}, inline script ${neg.inline}, ${neg.violations} reports)`);

  // Opened top-level, the game page is still sandboxed by the CSP header.
  const direct = await ctx.newPage();
  await direct.goto(`${BASE}/game`, { waitUntil: "load" });
  check((await direct.evaluate(() => origin)) === "null", "/game opened top-level is still sandboxed (opaque origin)");
  await direct.close();
} finally {
  await browser.close();
}

if (failures.length) { console.error(`sandbox check failed: ${failures.length}`); process.exit(1); }
console.log("sandbox check ok");
