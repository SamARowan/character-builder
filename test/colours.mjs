// Body colours: lists the body's inputs, then sets skin, eyes and lips through the Colours tab's own
// path (set_substance_inputs) and shoots the face before and after each change.
//   SITE=<url> node colours.mjs [list]
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const SITE = process.env.SITE ?? "http://localhost:8765/";
const SHOTS = new URL("./shots/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = readFileSync(new URL("../secret/password.txt", import.meta.url), "utf8").trim();
const profile = `${SHOTS}../.profile-colours`;
rmSync(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--enable-unsafe-swiftshader"], viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 400)); });
page.on("pageerror", (e) => errors.push(String(e)));
const settle = async () => {
  await page.waitForTimeout(500);
  await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 300000 });
  await page.waitForTimeout(1200);
};

await page.goto(SITE);
await page.waitForSelector("#lock:not([hidden])");
await page.fill("#lock-pw", PASSWORD);
await page.click("#lock-go");
await page.waitForSelector("#picker[open]", { timeout: 300000 });
await page.waitForTimeout(1000);
await page.click(`#picker-grid .tile:nth-child(${process.env.BODY ?? 10})`);
await page.waitForSelector("#app:not([hidden])");
await settle();

const view = await page.evaluate(() => window.fuseBuilder.call("substance", ["body"]));
console.log("body inputs:");
for (const i of view.inputs) console.log(`  ${i.name.padEnd(28)} ${String(i.type).padEnd(7)} ${JSON.stringify(i.value)}  ${i.label ?? ""}`);
console.log("materials:", view.materials.map((m) => m.filestem));
if (process.argv[2] === "list") { await ctx.close(); process.exit(0); }

// Zoom the viewer onto the face.
const box = await page.locator("#view").boundingBox();
const face = async (name) => {
  await page.waitForTimeout(800);
  await page.locator("#view").screenshot({ path: `${SHOTS}colours-${name}.png` });
};
await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2);
for (let k = 0; k < 12; k++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
await face("0-start");

const steps = JSON.parse(process.env.STEPS ?? "[]");
for (const [name, values] of steps) {
  const t = Date.now();
  await page.evaluate(async (v) => {
    await window.fuseBuilder.call("set_substance_inputs", ["body", v]);
    window.fuseBuilder.state.info = await window.fuseBuilder.call("info");
  }, values);
  // The tab's own refresh: same as queueColour.
  await page.evaluate(() => window.fuseBuilder.setTab("colours"));
  await page.evaluate(() => window.fuseBuilder.setTab("body"));
  await settle();
  console.log(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  await face(name);
}
console.log("errors:", errors);
await ctx.close();
