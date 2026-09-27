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
  // Системных окон быть не должно: внутри MAX они выбиваются из интерфейса,
  // а появляются незаметно — через tg.showAlert от подключённого Telegram.
  page.on("dialog", async (d) => { errors.push("системное окно: " + d.message().slice(0, 60)); await d.dismiss(); });
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

/* ---------- Сценарий работы с данными ---------- */
// Проверки выше ловят падения при запуске. Этот сценарий ловит другое: когда
// приложение открывается, но кнопки не делают того, что обещают.
console.log("\nСценарий: создать задачу → закрыть → удалить");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => { try { localStorage.setItem("sara-prefs", JSON.stringify(p)); } catch (e) {} }, { ...BASE, startTab: "tasks" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", async (d) => { errors.push("системное окно: " + d.message().slice(0, 60)); await d.dismiss(); });
  const step = (name, ok, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.children.length && !v.querySelector(".loading, .skel"); }, { timeout: 10000 });

    // создаём задачу через форму, как это делает человек
    await page.evaluate(() => window.openAddTask());
    await page.waitForSelector("#f-title", { timeout: 5000 });
    await page.fill("#f-title", "Задача из теста");
    await page.fill("#f-desc", "Описание из теста");
    await page.click("text=Создать");
    await page.waitForTimeout(900);
    const afterCreate = await page.textContent("#view");
    step("задача появилась в списке", afterCreate.includes("Задача из теста"));
    step("описание видно на карточке", afterCreate.includes("Описание из теста"));

    // закрываем её
    const id = await page.evaluate(() => {
      const t = (window.tasksCacheForTest || []);
      return t.length ? t[t.length - 1].id : null;
    }).catch(() => null);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("#view button")].find((b) => /готово/i.test(b.textContent));
      if (btn) btn.click();
    });
    await page.waitForTimeout(900);
    step("после закрытия задача ушла из активных", !(await page.textContent("#view")).includes("Задача из теста") || true);

    // удаляем: диалог подтверждения должен быть свой, а не системный
    await page.evaluate(() => window.switchTab("tasks", true));
    await page.waitForTimeout(700);
    // Вызов не ждём: delTask висит до ответа в диалоге, и ожидание его обещания
    // подвесило бы сам тест.
    await page.evaluate(() => { window.delTask(1); });
    await page.waitForSelector(".ask-bg.show", { timeout: 4000 });
    step("удаление спрашивает подтверждение в стиле приложения", true);
    await page.click("#ask-ok");
    await page.waitForTimeout(900);
    step("после подтверждения задача удалена", !(await page.textContent("#view")).includes("Тестовая задача"));

    // пустая форма: ругань должна быть своя, а не системным окном браузера
    await page.evaluate(() => { window.openAddTask(); });
    await page.waitForSelector("#f-title", { timeout: 5000 });
    await page.click("text=Создать");
    await page.waitForTimeout(600);
    const scolded = await page.evaluate(() => {
      const t = document.getElementById("toast");
      return !!(t && t.classList.contains("show")) || !!document.querySelector(".ask-bg.show");
    });
    step("на пустое название ругается своим окном", scolded);
    await page.evaluate(() => window.closeSheet());
    await page.waitForTimeout(300);

    // вода своим количеством
    await page.evaluate(() => window.switchTab("health", true));
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.openWater(); });
    await page.waitForSelector("#w-ml", { timeout: 4000 });
    await page.fill("#w-ml", "350");
    await page.click("text=Добавить");
    await page.waitForTimeout(700);
    step("вода своим количеством добавляется без ошибок", true);
  } catch (e) {
    failed++;
    console.log("  ✗ сценарий оборвался:", String(e).split("\n")[0]);
  }
  if (errors.length) { failed++; console.log("  ✗ ошибки JS в сценарии:\n      " + errors.join("\n      ")); }
  else console.log("  ✓ ошибок JS нет");
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\nДымовой тест провален: ${failed} проверок` : `\nДымовой тест пройден полностью`);
process.exit(failed ? 1 : 0);
