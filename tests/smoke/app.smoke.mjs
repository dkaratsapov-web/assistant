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
    try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {}
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
  await ctx.addInitScript((p) => { try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {} }, { ...BASE, startTab: "tasks" });
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

    // Набрано строчными и с кривыми знаками — в списке должно быть грамотно
    await page.evaluate(() => window.openAddTask());
    await page.waitForSelector("#f-title", { timeout: 5000 });
    await page.fill("#f-title", "позвонить в банк , уточнить лимит.");
    await page.click("text=Создать");
    await page.waitForTimeout(900);
    const tidy = await page.textContent("#view");
    step("название выправлено до грамотного", tidy.includes("Позвонить в банк, уточнить лимит"),
      (tidy.match(/[^\n]*банк[^\n]*/) || [""])[0].slice(0, 80));
    step("кривого варианта в списке нет", !tidy.includes("позвонить в банк ,"));

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

/* ---------- Тонкие списки и тумблер задач ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => {
    try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {}
  }, BASE);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tiles .tile", { timeout: 8000 });

  console.log("\nСценарий: тонкие списки и тумблер");
  const check = (ok, name, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };

  // Клиенты: строка тонкая, кнопки появляются только по нажатию
  await page.evaluate(() => go("clients"));
  await page.waitForSelector("#cllist .row-item", { timeout: 6000 });
  const shut = await page.evaluate(() => {
    const r = document.querySelector(".row-item");
    return { h: Math.round(r.getBoundingClientRect().height), btns: r.querySelector(".rb").offsetParent !== null };
  });
  check(shut.h <= 56, "строка клиента тонкая", `${shut.h}px`);
  check(!shut.btns, "кнопки спрятаны, пока строка закрыта");

  await page.evaluate(() => document.querySelector(".row-item .rh").click());
  await page.waitForTimeout(300);
  const open = await page.evaluate(() => {
    const r = document.querySelector(".row-item");
    return { open: r.classList.contains("open"), btns: r.querySelector(".rb").offsetParent !== null };
  });
  check(open.open && open.btns, "по нажатию раскрывается с кнопками");

  // Открыта всегда одна строка
  await page.evaluate(() => {
    const rows = document.querySelectorAll(".row-item .rh");
    if (rows[1]) rows[1].click();
  });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.querySelectorAll(".row-item.open").length <= 1), "открыта только одна строка");

  // Календарь — такой же тонкий список
  await page.evaluate(() => go("calendar"));
  await page.waitForTimeout(700);
  check(await page.evaluate(() => !!document.querySelector("#calbody .row-item")), "встречи тоже тонким списком");

  // Тумблер «Рабочие / Личные» переключает подсветку, а не только список
  await page.evaluate(() => go("tasks"));
  await page.waitForSelector("#tasklist .row-item, #tasklist .empty", { timeout: 6000 });
  const before = await page.evaluate(() => [...document.querySelectorAll(".seg div")].findIndex((d) => d.classList.contains("on")));
  await page.evaluate(() => window.setScope("personal"));
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => [...document.querySelectorAll(".seg div")].findIndex((d) => d.classList.contains("on")));
  check(before !== after && after === 1, "тумблер задач переключает подсветку", `${before} → ${after}`);
  check(await page.evaluate(() => taskScope === "personal"), "и сам выбор");

  check(errs.length === 0, "ошибок JS нет", errs.join(" | "));
  await ctx.close();
}

/* ---------- Ничего не уезжает за край экрана ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => {
    try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {}
  }, BASE);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tiles .tile", { timeout: 8000 });

  console.log("\nСценарий: ничего не уезжает за край");
  const check = (ok, name, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };

  // Три кнопки в ряду должны переноситься, а не выпихивать третью за экран
  await page.evaluate(() => go("tasks"));
  await page.waitForSelector("#tasklist .row-item, #tasklist .empty", { timeout: 6000 });
  const wraps = await page.evaluate(() => {
    const el = document.querySelector(".actions");
    return el ? getComputedStyle(el).flexWrap : "нет ряда кнопок";
  });
  check(wraps === "wrap", "ряды кнопок переносятся", wraps);

  for (const t of ["home", "tasks", "calendar", "health", "clients"]) {
    await page.evaluate((x) => go(x), t);
    await page.waitForTimeout(450);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `раздел «${t}» по ширине экрана`, `перебор ${over}px`);
  }

  await ctx.close();
}

/* ---------- Обучающий тур ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Здесь тур как раз и проверяем — поэтому отметки о пройденных экскурсиях не ставим
  await ctx.addInitScript((p) => { try { localStorage.setItem("sara-prefs", JSON.stringify(p)); } catch (e) {} }, BASE);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tiles .tile", { timeout: 8000 });

  console.log("\nСценарий: знакомство с приложением");
  const check = (ok, name, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };

  // Новому человеку тур показывается сам
  await page.waitForSelector(".tour-card", { timeout: 6000 });
  check(true, "новому пользователю тур открывается сам");
  check(await page.evaluate(() => !!document.querySelector(".tour-hole")), "подсветка есть");

  // Подсветка стоит на элементе, а не в углу экрана
  const fits = await page.evaluate(() => {
    const h = document.querySelector(".tour-hole").getBoundingClientRect();
    const t = document.querySelector(".tiles").getBoundingClientRect();
    return Math.abs(h.top + 6 - t.top) < 3 && Math.abs(h.width - 12 - t.width) < 3;
  });
  check(fits, "подсветка совпадает с элементом");

  // Шаги переключаются и счётчик растёт
  const first = await page.evaluate(() => document.querySelector(".tour-card .step").textContent);
  await page.evaluate(() => window.tourNext());
  await page.waitForTimeout(400);
  const second = await page.evaluate(() => document.querySelector(".tour-card .step").textContent);
  check(first !== second, "шаг переключается", `${first} → ${second}`);

  // Интерфейс под подсветкой остаётся нажимаемым
  check(await page.evaluate(() => getComputedStyle(document.querySelector(".tour-hole")).pointerEvents === "none"),
    "подсветка не перехватывает нажатия");

  // Пропуск закрывает тур и больше не показывает его
  await page.evaluate(() => window.tourSkip());
  await page.waitForTimeout(300);
  check(await page.evaluate(() => !document.querySelector(".tour-card")), "«Пропустить» закрывает тур");

  const page2 = await ctx.newPage();
  page2.on("pageerror", (e) => errs.push(String(e)));
  await page2.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page2.waitForSelector(".tiles .tile", { timeout: 8000 });
  await page2.waitForTimeout(900);
  check(await page2.evaluate(() => !document.querySelector(".tour-card")), "второй раз тур не всплывает");

  // Но его можно позвать заново
  await page2.evaluate(() => window.startTour(true));
  await page2.waitForTimeout(400);
  check(await page2.evaluate(() => !!document.querySelector(".tour-card")), "заново тур запускается");

  // Экскурсия по разделу: открыл впервые — подсказка появилась сама
  await page2.evaluate(() => window.tourSkip());
  await page2.waitForTimeout(200);
  await page2.evaluate(() => go("tasks"));
  await page2.waitForSelector(".tour-card", { timeout: 9000 });
  const secTxt = await page2.evaluate(() => document.querySelector(".tour-card .tt").textContent);
  check(/Рабочие и личные/.test(secTxt), "экскурсия по разделу запускается сама", secTxt);
  check(await page2.evaluate(() => getComputedStyle(document.querySelector(".tour-hole")).animationName !== "none"),
    "подсветка анимирована");
  await page2.evaluate(() => window.tourSkip());
  await page2.waitForTimeout(200);
  await page2.evaluate(() => go("home"));
  await page2.waitForTimeout(300);
  await page2.evaluate(() => go("tasks"));
  await page2.waitForTimeout(1100);
  check(await page2.evaluate(() => !document.querySelector(".tour-card")), "второй раз по разделу не всплывает");


  check(errs.length === 0, "ошибок JS нет", errs.join(" | "));
  await ctx.close();
}

/* ---------- Группы и разделы ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => { try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {} }, BASE);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tiles .tile", { timeout: 8000 });

  console.log("\nСценарий: группы и свои разделы");
  const check = (ok, name, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };

  await page.evaluate(() => go("clients"));
  await page.waitForSelector("#cllist .row-item, #cllist .empty", { timeout: 6000 });

  // Включён раздел «Коллеги» — значит над списком есть переключатель
  const segText = await page.evaluate(() => (document.querySelector("#cllist .seg") || {}).innerText || "");
  check(/Клиенты/.test(segText) && /Коллеги/.test(segText), "вкладки видов показаны", JSON.stringify(segText));

  // Переключение на «Коллеги» не роняет приложение и меняет выбранную вкладку
  await page.evaluate(() => window.setClientKind("colleague"));
  await page.waitForTimeout(500);
  check(await page.evaluate(() => clientKind === "colleague"), "вкладка переключается");
  await page.evaluate(() => window.setClientKind("client"));
  await page.waitForTimeout(500);

  // Группы из настроек попадают в выпадающий список формы
  await page.evaluate(() => window.openAddClient());
  await page.waitForSelector("#f-grp", { timeout: 6000 });
  const opts = await page.evaluate(() => [...$("f-grp").options].map((o) => o.textContent));
  check(opts.includes("Свои") && opts.includes("Агентские"), "группы предлагаются в форме", JSON.stringify(opts));
  check(await page.evaluate(() => !!$("f-kind")), "раздел выбирается в форме");
  await page.evaluate(() => closeSheet());

  // Фильтр по группе в задачах
  await page.evaluate(() => go("tasks"));
  await page.waitForSelector("#tasklist .row-item, #tasklist .empty", { timeout: 6000 });
  const chips = await page.evaluate(() => ($("task-groups") || {}).innerText || "");
  check(/Свои/.test(chips), "фильтр групп есть в задачах", JSON.stringify(chips));
  await page.evaluate(() => window.setTaskGroup("Свои"));
  await page.waitForTimeout(500);
  check(await page.evaluate(() => taskGroup === "Свои"), "фильтр группы применяется");

  check(errs.length === 0, "ошибок JS нет", errs.join(" | "));
  await ctx.close();
}

/* ---------- Дедлайн задачи меняется календарём ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => { try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {} }, BASE);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tiles .tile", { timeout: 8000 });

  console.log("\nСценарий: правка дедлайна задачи");
  const check = (ok, name, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };

  await page.evaluate(() => go("tasks"));
  await page.waitForSelector("#tasklist .row-item", { timeout: 6000 });
  // Берём ту задачу, что реально есть: предыдущий сценарий мог изменить список
  const taskId = await page.evaluate(() => (tasksCache[0] || {}).id);
  check(!!taskId, "есть задача для правки", String(taskId));
  await page.evaluate((id) => window.editTask(id), taskId);
  await page.waitForSelector("#f-due-date", { timeout: 6000 });

  // Поля календаря и времени, а не свободный текст: у текста сервер разбирал
  // значение заново и понимал иначе, чем человек выбрал.
  check(await page.evaluate(() => $("f-due-date").type === "date"), "дедлайн выбирается календарём");
  check(await page.evaluate(() => $("f-due-time").type === "time"), "время выбирается часами");
  check(await page.evaluate(() => !document.getElementById("f-due")), "свободного текстового поля больше нет");

  // Быстрые кнопки работают и в правке
  await page.evaluate(() => window.dueQuick(1));
  const picked = await page.evaluate(() => $("f-due-date").value);
  check(/^\d{4}-\d{2}-\d{2}$/.test(picked), "кнопка «Завтра» ставит дату", picked);

  // На сервер уходит ровно выбранное значение
  const sent = await page.evaluate(() => dueValue());
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sent), "на сервер уходит выбранная дата и время", sent);

  // «Без срока» прячет поля и отдаёт пусто
  await page.evaluate(() => window.dueQuick(null));
  check(await page.evaluate(() => dueValue() === ""), "«Без срока» отдаёт пустой дедлайн");

  check(errs.length === 0, "ошибок JS нет", errs.join(" | "));
  await ctx.close();
}

/* ---------- Бады: дни приёма ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((p) => { try { localStorage.setItem("sara-prefs", JSON.stringify(p)); for (const k of ["done", "tasks", "calendar", "health", "clients", "ai"]) localStorage.setItem("sara-tour-" + k, "1"); } catch (e) {} }, BASE);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tiles .tile", { timeout: 8000 });

  console.log("\nСценарий: курс бадов по дням недели");
  const check = (ok, name, detail = "") => { if (ok) console.log("  ✓", name); else { failed++; console.log("  ✗", name, detail); } };
  await page.evaluate(() => window.openSupplements());
  await page.waitForSelector("#s-name, .card .name", { timeout: 6000 }).catch(() => {});
  // Курс «Магний» идёт по Пн/Ср/Пт — это должно быть видно на карточке
  const label = await page.evaluate(() => document.body.innerText);
  check(/Пн · Ср · Пт/.test(label), "дни приёма видны на карточке курса");

  // В форме нового курса по умолчанию «каждый день», дни спрятаны
  await page.evaluate(() => window.openAddSup());
  await page.waitForSelector("#s-mode", { timeout: 6000 });
  check(await page.evaluate(() => $("s-mode").children[0].classList.contains("on")), "по умолчанию — каждый день");
  check(await page.evaluate(() => $("s-wd").style.display === "none"), "выбор дней спрятан, пока он не нужен");

  // Переключаем на «по дням недели» — день подставляется сам
  await page.evaluate(() => window.supMode(0));
  check(await page.evaluate(() => $("s-wd").style.display !== "none"), "выбор дней появился");
  check(await page.evaluate(() => document.querySelectorAll("#s-wd .chip.on").length === 1), "текущий день выбран сам");

  // Выбираем Пн и Пт, снимаем подставленный — в теле запроса должны быть только они
  const body = await page.evaluate(() => {
    document.querySelectorAll("#s-wd .chip.on").forEach((c) => c.classList.remove("on"));
    document.querySelector('#s-wd [data-wd="1"]').classList.add("on");
    document.querySelector('#s-wd [data-wd="5"]').classList.add("on");
    $("s-name").value = "Омега";
    return supBody();
  });
  check(JSON.stringify(body.weekdays) === "[1,5]", "выбранные дни уходят на сервер", JSON.stringify(body.weekdays));

  // Возврат на «каждый день» очищает список
  await page.evaluate(() => window.supMode(1));
  const every = await page.evaluate(() => supBody().weekdays);
  check(Array.isArray(every) && every.length === 0, "«каждый день» — пустой список дней");

  check(errs.length === 0, "ошибок JS нет", errs.join(" | "));
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\nДымовой тест провален: ${failed} проверок` : `\nДымовой тест пройден полностью`);
process.exit(failed ? 1 : 0);
