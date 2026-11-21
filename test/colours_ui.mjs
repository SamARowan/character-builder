// Sets body colours through the Colours tab's own inputs, as a person would, and shoots the body and face.
import { chromium } from "playwright-core";
import { readFileSync, rmSync } from "node:fs";
const SHOTS = new URL("./shots/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const PASSWORD = readFileSync(new URL("../secret/password.txt", import.meta.url), "utf8").trim();
const profile = `${SHOTS}../.profile-colours`;
rmSync(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-swiftshader"], viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
const page = ctx.pages()[0];
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
const settle = async () => {
  await page.waitForTimeout(700);
  await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 300000 });
  await page.waitForTimeout(1500);
};
await page.goto("http://localhost:8765/");
await page.fill("#lock-pw", PASSWORD); await page.click("#lock-go");
await page.waitForSelector("#picker[open]", { timeout: 300000 }); await page.waitForTimeout(800);
await page.click("#picker-grid .tile:nth-child(10)");
await page.waitForSelector("#app:not([hidden])"); await settle();
await page.click(".tabs [data-tab=colours]");
await page.waitForSelector("#colours .input-row", { state: "attached" }); await page.waitForTimeout(1500);
const shot = (n) => page.locator("#view").screenshot({ path: `${SHOTS}cui-${n}.png` });
await shot("0-start");
const colour = async (label, hex) => {
  const ok = await page.evaluate(([label, hex]) => {
    const row = [...document.querySelectorAll("#colours .input-row")].find((r) => r.querySelector(".lab")?.textContent === label);
    if (!row) return false;
    const c = row.querySelector("input");
    c.value = hex; c.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, [label, hex]);
  if (!ok) console.log("no control:", label);
};
const slider = async (label, v) => {
  const ok = await page.evaluate(([label, v]) => {
    const row = [...document.querySelectorAll("#colours .input-row")].find((r) => r.querySelector(".lab")?.textContent === label);
    if (!row) return false;
    const r = row.querySelector("input[type=range]"); r.value = v; r.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, [label, v]);
  if (!ok) console.log("no control:", label);
};
const step = async (name, f) => { const t = Date.now(); await f(); await settle(); console.log(name, ((Date.now() - t) / 1000).toFixed(1), "s"); await shot(name); };
await step("1-skin-blue", () => colour("Skin Color", "#3355ee"));
await step("2-iris-red", async () => { await colour("Iris Color", "#ee1111"); await colour("Iris Middle Ring Color", "#ee1111"); await colour("Iris Outer Ring Color", "#ee1111"); });
await step("3-lips-green", async () => { await colour("Lipstick Color", "#11ee22"); await slider("Lipstick Opacity", 1); });
await step("4-age", () => slider("Age", 1));
await step("5-hair-white", () => colour("Hair Color", "#ffffff"));
console.log("labels:", await page.$$eval("#colours .input-row .lab", (l) => l.map((x) => x.textContent).filter((t) => /Lip|Age|Hair|Skin Color|Iris Color/.test(t))));
console.log("errors:", errors);
await ctx.close();
