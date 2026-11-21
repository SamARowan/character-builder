// The password flow, as on the site: a fresh phone is locked, a wrong password is refused, the right
// one downloads and decrypts the pack from pack/*.bin, the builder runs, and a reload stays unlocked.
//   node lock.mjs   (serve.py on 8765; the password comes from ../secret/password.txt)
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const SHOTS = new URL("./shots/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = readFileSync(new URL("../secret/password.txt", import.meta.url), "utf8").trim();
const profile = `${SHOTS}../.profile-lock`;
rmSync(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--enable-unsafe-swiftshader"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = [], fetched = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text().slice(0, 400)); });
page.on("pageerror", (e) => errors.push(String(e)));
ctx.on("request", (r) => fetched.push(new URL(r.url()).pathname));
const shot = (name) => page.screenshot({ path: `${SHOTS}lock-${name}.png` });
const t0 = Date.now();
const lap = (s) => console.log(`${s} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await page.goto(process.env.SITE ?? "http://localhost:8765/");
await page.waitForSelector("#lock:not([hidden])");
await shot("1-locked");
await page.fill("#lock-pw", "not-the-password");
await page.tap("#lock-go");
await page.waitForSelector("#lock-error:not([hidden])", { timeout: 30000 });
console.log("wrong password:", await page.textContent("#lock-error"));
await shot("2-wrong");
await page.fill("#lock-pw", PASSWORD);
await page.tap("#lock-go");
await page.waitForSelector("#setup:not([hidden]) #pack-site:not([hidden])", { timeout: 30000 });
lap("unlocked");
console.log("button:", await page.textContent("#pack-site"));
await shot("3-setup");
await page.tap("#pack-site");
await page.waitForTimeout(1500);
await page.waitForTimeout(20000);
await shot("4-downloading");
console.log("progress after 20 s:", await page.textContent("#setup-progress span"));
await page.waitForSelector("#picker[open]", { timeout: 1200000 });
lap("pack downloaded and decrypted, builder started");
await page.tap("#picker-grid .tile:nth-child(10)");
await page.waitForSelector("#app:not([hidden])");
await page.waitForTimeout(300);
await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 120000 });
lap("first character built");
await page.waitForTimeout(800);
await shot("5-built");

await page.waitForFunction(async () => {   // the autosave has landed
  const db = await new Promise((r) => { const q = indexedDB.open("fuse-builder"); q.onsuccess = () => r(q.result); });
  return new Promise((r) => { const q = db.transaction("characters").objectStore("characters").count(); q.onsuccess = () => r(q.result > 0); });
}, null, { timeout: 120000, polling: 500 });
lap("autosaved");
console.log("before reload:", await page.evaluate(() => { const s = window.fuseBuilder.state; return { current: s.current, open: s.info?.open, name: s.info?.name }; }));
await page.reload();
await page.waitForSelector("#app:not([hidden]), #lock:not([hidden]), #setup:not([hidden])", { timeout: 120000 });
const after = await page.evaluate(() => ["#lock", "#setup", "#app"].find((s) => !document.querySelector(s).hidden));
lap(`after reload: ${after}`);
console.log("stored:", await page.evaluate(async () => {
  const db = await new Promise((r) => { const q = indexedDB.open("fuse-builder"); q.onsuccess = () => r(q.result); });
  const all = await new Promise((r) => { const q = db.transaction("characters").objectStore("characters").getAll(); q.onsuccess = () => r(q.result); });
  return { last: localStorage.getItem("fb.last"), saved: all.map((c) => [c.id, c.name]) };
}), "errors so far:", errors);
await page.waitForTimeout(300);
await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 120000 });
await page.waitForTimeout(800);
await shot("6-reloaded");

// Forget the password: back to the lock screen, the pack stays.
await page.tap(".tabs [data-tab=saved]");
await page.tap(".pack-info summary");
page.once("dialog", (d) => d.accept());
await page.tap("#lock-device");
await page.waitForSelector("#lock:not([hidden])", { timeout: 30000 });
lap("forgot the password: locked again");

const plain = fetched.filter((p) => /py\.zip$|\.fpk$/.test(p));
console.log("pack parts fetched:", fetched.filter((p) => p.includes("/pack/")).length, "plain files fetched:", plain);
console.log("errors:", errors);
await ctx.close();
