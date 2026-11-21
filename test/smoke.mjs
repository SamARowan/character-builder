// Worker smoke test: import the pack from the test server, start Python, build and preview.
//   node smoke.mjs   (with serve.py running on 8765)
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
                                        headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => console.log("[page]", m.text().slice(0, 4000)));
await page.goto("http://127.0.0.1:8765/manifest.webmanifest").catch(() => {});
await page.goto("http://127.0.0.1:8765/icon.svg").catch(() => {});
import { readFileSync } from "node:fs";
const PASSWORD = readFileSync(new URL("../secret/password.txt", import.meta.url), "utf8").trim();
const out = await page.evaluate(async (PASSWORD) => {
  const w = new Worker("/worker.js", { type: "module" });
  let n = 0;
  const pending = new Map();
  w.onmessage = (e) => {
    if (e.data.type === "progress") { if (!e.data.frac || Math.random() < 0.02) console.log("progress", e.data.text); return; }
    const p = pending.get(e.data.id); pending.delete(e.data.id);
    e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error));
  };
  const ask = (msg) => new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej }); w.postMessage({ id, ...msg }); });
  const log = [];
  const t = async (label, msg) => { const r = await ask(msg); log.push(`${label}: ${Math.round(r.ms)} ms`); return r.result; };
  let st = await t("status", { cmd: "status" });
  if (st.locked) await t("unlock", { cmd: "unlock", password: PASSWORD });
  if (!st.pack) await t("import", { cmd: "import", url: "/local-pack/fuse-content.fpk" });
  st = await t("status", { cmd: "status" });
  log.push(JSON.stringify(st.pack?.manifest));
  log.push(JSON.stringify(await t("start", { cmd: "start" })));
  const bodies = await t("body_types", { cmd: "call", name: "body_types" });
  const cl = await t("cloths", { cmd: "call", name: "cloths", args: { made_for: "MaleFitA" } });
  const pick = ["Top_", "Bottom_", "Shoes_", "Hair_"].map((p) => cl.cloths.find((c) => c.id.startsWith(p)).id);
  await t("new", { cmd: "call", name: "new", args: ["MaleFitA", pick, "Smoke"] });
  let pv = await t("preview cold", { cmd: "call", name: "preview" });
  const s = await t("sliders", { cmd: "call", name: "sliders", args: ["bicep"] });
  await t("set", { cmd: "call", name: "set_blendshapes", args: [{ [s[0].id]: 0.8 }] });
  pv = await t("preview warm", { cmd: "call", name: "preview" });
  const files = await t("read", { cmd: "read", paths: [pv.bin, ...pv.sections.map((x) => x.texture).filter(Boolean)] });
  log.push(`bin ${files[0].byteLength} bytes, ${files.length - 1} textures, sections ${pv.sections.length}`);
  const ex = await t("export glb", { cmd: "call", name: "export", args: ["glb"] });
  log.push(JSON.stringify(ex));
  return { log, bodies: bodies.length };
}, PASSWORD);
console.log(out.log.join("\n"), "\nbodies", out.bodies);
await browser.close();
