/**
 * Снимки приложения для кейса на сайт.
 *
 * Данные здесь выдуманные и живут только в этом файле: настоящие задачи и
 * клиенты на публичную страницу выкладывать нельзя. Поднимаем свой маленький
 * сервер с демонстрационными ответами, открываем приложение в браузере с
 * экраном телефона и снимаем каждый раздел.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const ROOT = path.resolve("public");
const OUT = path.resolve("case/screens");
const PORT = 8911;
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };

/** Сегодня в нужный час — чтобы на снимках были живые, а не вчерашние даты. */
const at = (dayOffset, hour, min = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
};

const CLIENTS = [
  { id: 1, name: "Глобал Стекло", status: "active", platforms: "direct,vk", budget: "180 000", contact: "Ирина, +7 900 000-00-00", notes: "", pay_amount: "45 000", pay_due: "5 числа", grp: "Свои", kind: "client" },
  { id: 2, name: "ДиАвто69", status: "active", platforms: "direct", budget: "240 000", contact: "Сергей", notes: "", pay_amount: "60 000", pay_due: "10 числа", grp: "Свои", kind: "client" },
  { id: 3, name: "Школа в Дмитровском", status: "active", platforms: "vk", budget: "70 000", contact: "Анна", notes: "", pay_amount: "25 000", pay_due: "1 числа", grp: "Агентские", kind: "client" },
  { id: 4, name: "Ромашка", status: "paused", platforms: "direct", budget: "", contact: "", notes: "", pay_amount: "", pay_due: "", grp: "Агентские", kind: "client" },
];

const TASKS = [
  { id: 1, title: "Согласовать медиаплан на ноябрь", status: "in_progress", scope: "work", due_at: at(0, 18), client_id: 1, priority: 1, grp: "Свои", description: "Прислать на почту до конца дня" },
  { id: 2, title: "Подготовить отчёт по Директу", status: "open", scope: "work", due_at: at(1, 12), client_id: 2, priority: 0, grp: "Свои", description: "" },
  { id: 3, title: "Созвониться по оплате", status: "open", scope: "work", due_at: at(2, 11), client_id: 3, priority: 0, grp: "Агентские", description: "" },
  { id: 4, title: "Собрать новые креативы", status: "open", scope: "work", due_at: null, client_id: 1, priority: 0, grp: "Свои", description: "" },
  { id: 5, title: "Записаться к стоматологу", status: "open", scope: "personal", due_at: at(3, 10), client_id: null, priority: 0, grp: "", description: "" },
  { id: 6, title: "Купить подарок на день рождения", status: "open", scope: "personal", due_at: at(5, 19), client_id: null, priority: 0, grp: "", description: "" },
];

/** Через столько-то часов от текущего момента: на снимке встречи должны быть
 *  предстоящими, а не зачёркнутыми как прошедшие. */
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

const EVENTS = [
  { id: 1, title: "Планёрка с командой", starts_at: inHours(2), location: "Офис", notes: "", client_id: null },
  { id: 2, title: "Защита стратегии", starts_at: inHours(5), location: "Телемост", notes: "", client_id: 1 },
  { id: 3, title: "Показ отчёта", starts_at: at(1, 11, 30), location: "", notes: "", client_id: 2 },
  { id: 4, title: "Бриф по новому проекту", starts_at: at(2, 14), location: "Офис", notes: "", client_id: 3 },
];

const API = {
  "/api/me": { user_id: 1, role: "owner", channel: "max", telemost: true, voice: true, vision: true },
  "/api/home": {
    tasks: TASKS.filter((t) => t.due_at && t.scope === "work").slice(0, 3).map((t) => ({
      id: t.id, title: t.title, due_at: t.due_at, scope: t.scope,
      client: (CLIENTS.find((c) => c.id === t.client_id) || {}).name || null, overdue: false,
    })),
    events: EVENTS.slice(0, 2)
      .map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at, location: e.location,
        client: (CLIENTS.find((c) => c.id === e.client_id) || {}).name || null })),
    upcomingEvents: [{ id: 3, title: "Показ отчёта", starts_at: at(1, 11, 30), location: "", client: "ДиАвто69" }],
    birthdays: [{ name: "Ирина", date: "10-14", in_days: 3 }],
    counts: { work: 4, personal: 2 },
    stats: { doneToday: 3, doneWeek: 17, doneTotal: 184 },
  },
  "/api/tasks": { tasks: TASKS },
  "/api/events": { events: EVENTS },
  "/api/clients": { clients: CLIENTS },
  "/api/contacts": { contacts: [] },
  "/api/notes": { notes: [] },
  "/api/health": {
    kcal: { consumed: 1480, goal: 2200, protein: 86, fat: 52, carbs: 164, goalP: 165, goalF: 73, goalC: 220 },
    water: { ml: 1500, goal: 2500 },
    entries: [
      { id: 1, title: "Овсянка с бананом", kcal: 320, protein: 9, fat: 6, carbs: 55, meal: "breakfast" },
      { id: 2, title: "Борщ и котлета", kcal: 640, protein: 32, fat: 28, carbs: 48, meal: "lunch" },
      { id: 3, title: "Творог с мёдом", kcal: 240, protein: 28, fat: 5, carbs: 18, meal: "snack" },
    ],
    notes: [], weight: { latest: 78.4, history: [] }, week: {}, activity: [],
    supplements: [],
  },
  "/api/ai/history": { messages: [] },
  "/api/notifications": { morning: { on: true, hour: 9 }, tasks: { on: true, lead: 60 }, events: { on: true, lead: 30 }, birthdays: { on: true }, water: { on: true, everyHours: 2, from: 9, to: 21 }, meals: { on: false, breakfast: 9, lunch: 14, dinner: 19 } },
  "/api/supplements": {
    supplements: [{ id: 1, name: "Витамин D", dose: "5000 МЕ", times: ["09:00"], days: 0, weekdays: "", start_date: "", notes: "" }],
    today: { date: new Date().toISOString().slice(0, 10), items: [{ supId: 1, name: "Витамин D", dose: "5000 МЕ", slot: "09:00", taken: true }] },
    adherence: [],
  },
  "/api/groups": { groups: ["Свои", "Агентские"], kinds: [] },
  "/api/profile": { sex: "m", height: 182, weight: 78, birth_year: 1990, goal: "держать форму", allergies: "" },
};

const PREFS = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "dark",
  motion: false, haptic: false, startTab: "home", hidden: [], callMe: "Данил", botName: "Сара",
  avatar: "", tone: "friendly", address: "ty", emoji: true, search: true };
// Боевой аватар лежит на внешнем адресе, который демо-сервер не отдаёт, и на
// снимке вместо лица получалась битая картинка. Берём встроенное лицо.
PREFS.avatar = "face:nika";

function serve() {
  const s = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p.startsWith("/api/")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      // Тему отдаём текущую, а не зашитую в PREFS: приложение спрашивает
      // настройки у сервера и перебивает ими то, что лежит на устройстве, —
      // из-за этого «светлая» серия снималась тёмной.
      if (p === "/api/prefs") return res.end(JSON.stringify({ ...PREFS, theme: currentTheme }));
      // Фильтры приложение передаёт в адресе. Заглушка, которая их не
      // разбирает, покажет во вкладке «Рабочие» личные задачи — на снимке
      // для сайта это сразу бросается в глаза.
      if (p === "/api/tasks") {
        const q = new URLSearchParams(req.url.split("?")[1] || "");
        const scope = q.get("scope");
        const grp = q.get("grp");
        let list = TASKS;
        if (scope) list = list.filter((t) => t.scope === scope);
        if (grp) list = list.filter((t) => t.grp === grp);
        if (q.get("status") === "active") list = list.filter((t) => t.status !== "done");
        return res.end(JSON.stringify({ tasks: list }));
      }
      const hit = Object.keys(API).find((k) => p === k);
      return res.end(JSON.stringify(hit ? API[hit] : { ok: true }));
    }
    if (p === "/version") { res.setHeader("content-type", "text/plain"); return res.end("демо"); }
    const file = p === "/" || p === "/app" ? "/index.html" : p;
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.statusCode = 404; return res.end("нет"); }
    res.setHeader("content-type", TYPES[path.extname(full)] ?? "application/octet-stream");
    res.end(fs.readFileSync(full));
  });
  return new Promise((r) => s.listen(PORT, "127.0.0.1", () => r(s)));
}

/** Тема текущего прохода: её отдаёт и сервер настроек, и страница. */
let currentTheme = "dark";

const server = await serve();
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

const SHOTS = [
  ["01-glavnaya", "home", "Главный экран"],
  ["02-zadachi", "tasks", "Задачи"],
  ["03-kalendar", "calendar", "Календарь"],
  ["04-pitanie", "health", "Питание и здоровье"],
  ["05-klienty", "clients", "Клиенты"],
  ["06-sara", "ai", "Чат с Сарой"],
];

/** Один полный проход по разделам в заданной теме. */
async function shootTheme(theme) {
  const dir = path.join(OUT, theme === "light" ? "svetlaya" : "tyomnaya");
  fs.mkdirSync(dir, { recursive: true });
  currentTheme = theme;
  const prefs = { ...PREFS, theme };

  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  // Туры и вопрос про микрофон на снимках не нужны — они закрывают интерфейс
  await ctx.addInitScript((p) => {
    try {
      localStorage.setItem("sara-prefs", JSON.stringify(p));
      localStorage.setItem("sara-theme", p.theme);
      for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1");
      localStorage.setItem("sara-mic-asked", "1");
    } catch (e) {}
  }, prefs);

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("ОШИБКА СТРАНИЦЫ:", String(e).slice(0, 300)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.children.length && !v.querySelector(".loading, .skel"); }, { timeout: 15000 });

  console.log(`\n${theme === "light" ? "Светлая" : "Тёмная"} тема:`);
  for (const [file, tab, title] of SHOTS) {
    await page.evaluate((t) => window.go(t), tab);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(dir, `${file}.png`) });
    console.log("  ✓", title);
  }

  // Раскрытая карточка задачи: видно, что строки списка разворачиваются
  await page.evaluate(() => window.go("tasks"));
  await page.waitForTimeout(500);
  const row = await page.$("#tasklist .row-item .rh");
  if (row) {
    await row.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(dir, "07-kartochka-zadachi.png") });
    console.log("  ✓ Раскрытая карточка задачи");
  }

  // Форма постановки задачи
  await page.evaluate(() => window.openAddTask());
  await page.waitForSelector("#f-title", { timeout: 5000 });
  await page.fill("#f-title", "Подготовить отчёт по Директу");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, "08-novaya-zadacha.png") });
  console.log("  ✓ Постановка задачи");

  await ctx.close();
}

// Старые снимки убираем, иначе в папке смешаются два прогона
fs.rmSync(OUT, { recursive: true, force: true });
await shootTheme("dark");
await shootTheme("light");

await browser.close();
server.close();
console.log("\nГотово. Снимки в case/screens/tyomnaya и case/screens/svetlaya");
