/** Снимок экрана заглушки — как его увидит закрытый пользователь. */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { startStubServer } from "../tests/smoke/server.mjs";

const OUT = path.resolve("case/screens");
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "dark",
  motion: false, haptic: false, startTab: "home", hidden: [], callMe: "Данил", botName: "Сара",
  avatar: "face:nika", tone: "friendly", address: "ty", emoji: true, search: true };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
let port = 8931;
for (const theme of ["dark", "light"]) {
  const srv = await startStubServer({ ...BASE, theme }, port++, { locked: true });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((p) => {
    try {
      localStorage.setItem("sara-prefs", JSON.stringify(p));
      localStorage.setItem("sara-theme", p.theme);
      for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1");
    } catch (e) {}
  }, { ...BASE, theme });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#locked-screen", { timeout: 10000 });
  await page.waitForTimeout(400);
  const dir = path.join(OUT, theme === "light" ? "svetlaya" : "tyomnaya");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "09-dostup-zakryt.png");
  await page.screenshot({ path: file });
  console.log("  ✓", theme === "light" ? "светлая" : "тёмная", "→", file);
  await ctx.close();
  srv.server.close();
}
await browser.close();
