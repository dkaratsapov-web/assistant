/**
 * Дымовой тест приложения: поднимаем страницу с РАЗНЫМИ сохранёнными настройками
 * и проверяем, что она открывается и в ней нет ошибок JS.
 *
 * Появился после боевого случая: приложение падало насмерть, если в настройках
 * был спрятан раздел. Ошибка жила в памяти устройства, поэтому повторялась при
 * каждом запуске, а свежий браузер её не показывал. Вывод: проверять надо не
 * только действие, но и состояние, которое оно оставляет.
 */
import { chromium } from "playwright-core";
import { startStubServer } from "./server.mjs";

/**
 * Где взять браузер: на CI его ставит `playwright install`, в песочнице он лежит
 * в /opt. Пробуем по очереди, чтобы тест запускался в обоих местах без правок.
 */
async function launch() {
  const tries = [];
  if (process.env.SMOKE_CHROME) tries.push(process.env.SMOKE_CHROME);
  tries.push(null); // даём playwright найти браузер самому
  tries.push("/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
  let last;
  for (const executablePath of tries) {
    try {
      return await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
    } catch (e) { last = e; }
  }
  throw last;
}
const BASE = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, haptic: true, startTab: "home", hidden: [], callMe: "", botName: "Сара" };

// Каждый набор — состояние, которое человек мог оставить в настройках
const CASES = [
  ["настройки по умолчанию", BASE],
  ["спрятан раздел", { ...BASE, hidden: ["health"] }],
  ["спрятано несколько разделов", { ...BASE, hidden: ["health", "clients", "calendar"] }],
  ["спрятан стартовый раздел", { ...BASE, startTab: "health", hidden: ["health"] }],
  ["другой стартовый экран", { ...BASE, startTab: "tasks" }],
  ["крупный масштаб и просторно", { ...BASE, scale: 130, density: "roomy", images: "large", corners: "soft" }],
  ["мелкий масштаб, без анимаций", { ...BASE, scale: 85, density: "compact", images: "small", corners: "sharp", motion: false, haptic: false }],
  ["тёмная тема принудительно", { ...BASE, theme: "dark" }],
  ["переименованный ассистент", { ...BASE, botName: "Ассистент", callMe: "Дмитрий" }],
  ["мусор в настройках", { ...BASE, density: "чепуха", images: null, hidden: "не массив", scale: "много" }],
];

const TABS = ["home", "tasks", "calendar", "health", "clients", "ai"];
let failed = 0;

const { server, port } = await startStubServer(BASE);
const browser = await launch();

for (const [name, prefs] of CASES) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => {
    try { localStorage.setItem("sara-prefs", JSON.stringify(p)); } catch (e) {}
  }, prefs);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => { const v = document.getElementById("view"); return v && v.children.length && !v.querySelector(".loading"); },
      { timeout: 10000 }
    );
    // проходим по всем видимым разделам — там тоже может рвануть
    for (const t of TABS) {
      const link = await page.$(`.nav a[data-tab="${t}"]`);
      if (!link || !(await link.isVisible())) continue;
      await link.click();
      await page.waitForTimeout(250);
    }
    // и открываем настройки — экран, с которого всё началось
    await page.click("#prefs-btn");
    await page.waitForSelector("text=Размер интерфейса", { timeout: 5000 });
    await page.click("text=Готово");
  } catch (e) {
    errors.push("не открылось: " + String(e).split("\n")[0]);
  }
  await ctx.close();
  if (errors.length) { failed++; console.log(`  ✗ ${name}\n      ${errors.join("\n      ")}`); }
  else console.log(`  ✓ ${name}`);
}

await browser.close();
server.close();
console.log(failed ? `\nДымовой тест провален: ${failed} из ${CASES.length}` : `\nДымовой тест пройден: ${CASES.length} из ${CASES.length}`);
process.exit(failed ? 1 : 0);
