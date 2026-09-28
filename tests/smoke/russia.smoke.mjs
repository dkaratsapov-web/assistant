/**
 * Проверка «как из России без VPN».
 *
 * Появился после боевого случая: на смартфоне в РФ приложение открывалось
 * только через VPN. Причина была не в сервере, а в трёх зарубежных адресах
 * внутри самой страницы — скрипт Telegram, шрифт Google и фото на CloudFront.
 * Заблокированный домен не отвечает ошибкой, он молчит: браузер честно ждёт
 * ответа и всё это время показывает белый экран.
 *
 * Здесь мы повторяем именно это: все зарубежные адреса «молчат», и приложение
 * обязано всё равно открыться за несколько секунд.
 */
import { chromium } from "playwright-core";
import { startStubServer } from "./server.mjs";

const FOREIGN = ["telegram.org", "fonts.googleapis.com", "fonts.gstatic.com", "cloudfront.net", "googleapis.com", "gstatic.com"];
const LIMIT_MS = 6000; // столько человек готов ждать; блокировка даёт десятки секунд

async function launch() {
  const tries = [];
  if (process.env.SMOKE_CHROME) tries.push(process.env.SMOKE_CHROME);
  tries.push(null);
  tries.push("/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
  let last;
  for (const executablePath of tries) {
    try {
      return await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
    } catch (e) { last = e; }
  }
  throw last;
}

const PREFS = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, haptic: true, startTab: "home", hidden: [], callMe: "", botName: "Сара" };

const { server, port } = await startStubServer(PREFS);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

let blocked = 0;
// Зарубежные адреса не отвечают ничем — именно так выглядит блокировка.
await ctx.route("**/*", async (route) => {
  const host = new URL(route.request().url()).hostname;
  if (FOREIGN.some((d) => host === d || host.endsWith("." + d))) {
    blocked++;
    return; // не отвечаем вовсе: запрос повиснет до таймаута
  }
  await route.continue();
});

const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));

const started = Date.now();
let failed = 0;
const check = (ok, name) => { console.log(`  ${ok ? "✓" : "✗"} ${name}`); if (!ok) failed++; };

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
// Ждём не загрузку страницы (она никогда не «догрузится» — висят зарубежные
// запросы), а то, ради чего человек её открыл: появился интерфейс.
await page.waitForSelector(".tiles .tile, #login", { timeout: LIMIT_MS });
const shown = Date.now() - started;

check(shown < LIMIT_MS, `интерфейс появился за ${shown} мс (предел ${LIMIT_MS})`);
check(blocked > 0, `зарубежные адреса действительно блокировались (${blocked})`);

// Кнопки должны работать, а не просто нарисоваться
await page.click('#nav [data-tab="tasks"]');
await page.waitForSelector("#tasklist .card, #tasklist .empty", { timeout: LIMIT_MS });
check(true, "раздел задач открывается");

// Лицо Сары не должно быть «битой» картинкой (сторож меняет её через 1.5 с)
await page.waitForTimeout(2200);
const faces = await page.evaluate(() => {
  const list = [...document.querySelectorAll("img")].filter((i) => /cloudfront|data:image\/svg/.test(i.src));
  return list.map((i) => ({ src: i.src.slice(0, 60), sara: i.getAttribute("data-sara"), where: i.parentElement && i.parentElement.className, ok: i.complete && i.naturalWidth > 0 }));
});
check(faces.every((f) => f.ok), `картинки ассистента отрисованы (${faces.length} шт.) ${JSON.stringify(faces.filter(f=>!f.ok))}`);

check(errors.length === 0, errors.length ? `ошибки JS: ${errors.join(" | ")}` : "ошибок JS нет");

await browser.close();
server.close();
console.log(failed ? `\nПровалено проверок: ${failed}` : "\nПриложение открывается без зарубежных доменов");
process.exit(failed ? 1 : 0);
