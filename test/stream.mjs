// The streamed pack: a fresh phone unlocks and builds without downloading the pack, and each step
// reports what it fetched. Then the character files: Save (one .json) and Save all (.zip), read
// back here and checked as fuse-mcp projects by the caller.
//   SITE=<url> node stream.mjs   (default http://localhost:8765/; password from ../secret/password.txt)
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const SITE = process.env.SITE ?? "http://localhost:8765/";
const SHOTS = new URL("./shots/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = readFileSync(new URL("../secret/password.txt", import.meta.url), "utf8").trim();
const profile = `${SHOTS}../.profile-stream`;
rmSync(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, acceptDownloads: true,
  args: ["--enable-unsafe-swiftshader"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 400)); });
page.on("pageerror", (e) => errors.push(String(e)));
const t0 = Date.now();
let last = { requests: 0, bytes: 0 };
const lap = async (s) => {
  const st = await page.evaluate(() => window.fuseBuilder?.ask({ cmd: "status" }).catch(() => null));
  const f = st?.pack?.fetched ?? { requests: 0, bytes: 0 };
  console.log(`${s.padEnd(34)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s   +${f.requests - last.requests} requests, ` +
              `+${((f.bytes - last.bytes) / 1e6).toFixed(1)} MB   (cached ${((st?.pack?.cached ?? 0) / 1e6).toFixed(0)} MB)`);
  last = f;
};
const settle = async () => {
  await page.waitForTimeout(400);
  await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 300000 });
  await page.waitForTimeout(400);
};

await page.goto(SITE);
await page.waitForSelector("#lock:not([hidden])");
await page.fill("#lock-pw", PASSWORD);
await page.tap("#lock-go");
await page.waitForSelector("#picker[open], #setup:not([hidden]), #boot-error:not([hidden])", { timeout: 300000 });
if (!await page.isVisible("#picker[open]")) throw new Error(`no picker: ${await page.textContent("body")}`.slice(0, 600));
await page.waitForTimeout(1500);
await lap("unlocked, started, body picker");
await page.tap("#picker-grid .tile:nth-child(10)");
await page.waitForSelector("#app:not([hidden])");
await settle();
await lap("first body built");
await page.screenshot({ path: `${SHOTS}stream-1-body.png` });

await page.tap(".tabs [data-tab=clothes]");
await page.waitForSelector("#cloth-grid .tile");
await page.waitForTimeout(3000);
await lap("clothes tab (visible thumbnails)");
await page.screenshot({ path: `${SHOTS}stream-2-clothes.png` });
for (const cat of ["Tops", "Bottoms", "Shoes", "Hair"]) {
  await page.tap(`#cloth-cats .chip:text-is("${cat}")`);
  await page.waitForTimeout(800);
  await page.tap("#cloth-grid .tile:nth-child(2)");
  await settle();
  await lap(`+ ${cat}`);
}
await page.screenshot({ path: `${SHOTS}stream-3-dressed.png` });

// Character files.
await page.tap(".tabs [data-tab=saved]");
const [one] = await Promise.all([page.waitForEvent("download"), page.click("#save-file")]);
await one.saveAs(`${SHOTS}stream-character.json`);
const [all] = await Promise.all([page.waitForEvent("download"), page.click("#save-all")]);
await all.saveAs(`${SHOTS}stream-characters.zip`);
console.log("saved:", one.suggestedFilename(), all.suggestedFilename());
await page.setInputFiles("#open-file", `${SHOTS}stream-characters.zip`);
await page.waitForTimeout(1500);
console.log("characters after opening the zip:", await page.$$eval("#saved-list .saved", (x) => x.length));
await page.screenshot({ path: `${SHOTS}stream-4-characters.png` });
console.log("errors:", errors);
await ctx.close();
