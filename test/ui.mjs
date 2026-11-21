// Drives the page like a person would, on a phone-sized touch screen and on a laptop, and
// screenshots each step into test/shots/.   node ui.mjs [phone|desktop|both]   (serve.py on 8765)
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const PACK = "F:/REA/fuse-web/dist-content/fuse-content.fpk";
const SHOTS = new URL("./shots/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
mkdirSync(SHOTS, { recursive: true });
const which = process.argv[2] ?? "both";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function run(kind) {
  const profile = `${SHOTS}../.profile-${kind}`;
  rmSync(profile, { recursive: true, force: true });
  const opts = kind === "phone"
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } };
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true,
    acceptDownloads: true, args: ["--enable-unsafe-swiftshader"], ...opts });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 400)); });
  page.on("pageerror", (e) => errors.push(String(e)));
  let n = 0;
  const shot = async (name) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}${kind}-${String(++n).padStart(2, "0")}-${name}.png` });
  };
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 120000 });
    await page.waitForTimeout(500);
  };
  const tap = (sel) => (kind === "phone" ? page.tap(sel) : page.click(sel));
  const t0 = Date.now();
  const lap = (label) => console.log(`${kind}: ${label} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await page.goto("http://localhost:8765/");
  await page.waitForSelector("#setup:not([hidden]), #lock:not([hidden])");
  if (await page.isVisible("#lock")) {
    await page.fill("#lock-pw", readFileSync(new URL("../secret/password.txt", import.meta.url), "utf8").trim());
    await tap("#lock-go");
  }
  await page.waitForSelector("#setup:not([hidden])");
  await shot("setup");
  await page.setInputFiles("#pack-file", PACK);
  await page.waitForSelector("#picker[open]", { timeout: 300000 });
  lap("pack loaded and builder started");
  await shot("pick-body");
  await tap("#picker-grid .tile[title='Male Fit A'], #picker-grid .tile:nth-child(10)");
  await page.waitForSelector("#app:not([hidden])");
  await settle();
  lap("first character built");
  await shot("body");

  // Body: open a group and drag a slider.
  await tap("#slider-search");
  await page.fill("#slider-search", "nose");
  await page.waitForTimeout(200);
  await shot("slider-search");
  await page.evaluate(() => {
    const r = document.querySelector("#sliders input[type=range]");
    r.value = 0.9;
    r.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  lap("slider rebuilt");
  await page.fill("#slider-search", "");
  await page.evaluate(() => { const r = [...document.querySelectorAll("#sliders summary")].find((s) => /Torso|Body|Arms/i.test(s.textContent)); r?.click(); });
  await page.evaluate(() => {
    for (const r of [...document.querySelectorAll("#sliders details[open] input[type=range]")].slice(0, 3)) {
      r.value = r.min < 0 ? -0.8 : 0.8;
      r.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await settle();
  await shot("sliders");

  // Clothes: one from each of a few categories.
  await tap(".tabs [data-tab=clothes]");
  await page.waitForSelector("#cloth-grid .tile");
  await shot("clothes");
  for (const cat of ["Tops", "Bottoms", "Shoes", "Hair"]) {
    await tap(`#cloth-cats .chip:text-is("${cat}")`);
    await tap("#cloth-grid .tile:nth-child(2)");
    await settle();
  }
  lap("four clothes on");
  await tap(`#cloth-cats .chip:text-is("All")`);
  await shot("dressed");

  // Colours: the top's first colour.
  await tap("#worn .pill:first-child button[title=Colours]");
  await page.waitForSelector("#colours .mat");
  await shot("colours");
  await page.evaluate(() => {
    const c = document.querySelector("#colours input[type=color]");
    c.value = "#c0392b";
    c.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  lap("colour repainted");
  await shot("recoloured");
  // Change a material through the picker.
  const change = await page.$("#colours .mat .btn");
  if (change) {
    await change.click();
    await page.waitForSelector("#picker[open] .tile");
    await shot("material-picker");
    await tap("#picker-grid .tile:nth-child(5)");
    await settle();
    await shot("material-changed");
  }

  // Undo, then the viewer's turn button.
  await tap("#undo");
  await settle();
  await tap("#turn");
  await page.waitForTimeout(900);
  await shot("turned");

  // Export a GLB.
  await tap(".tabs [data-tab=export]");
  await shot("export");
  const dl = page.waitForEvent("download", { timeout: 180000 });
  await tap("#ex-go");
  const d = await dl;
  await d.saveAs(`${SHOTS}${kind}-${d.suggestedFilename()}`);
  lap(`exported ${d.suggestedFilename()}`);
  await shot("exported");

  // Characters: the autosave shows up; reload reopens it.
  await page.waitForTimeout(1500);
  await tap(".tabs [data-tab=saved]");
  await page.waitForSelector("#saved-list .saved");
  await shot("characters");
  await page.reload();
  await page.waitForSelector("#app:not([hidden])", { timeout: 120000 });
  await settle();
  lap("reopened after reload");
  await shot("reloaded");
  console.log(`${kind}: errors`, errors);
  await ctx.close();
}

for (const k of which === "both" ? ["phone", "desktop"] : [which]) await run(k);
