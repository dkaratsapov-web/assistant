/**
 * Кнопка голоса должна РЕАГИРОВАТЬ на звук, а не просто краснеть.
 *
 * Проверяем на поддельном микрофоне Chromium: он выдаёт тон, значит уровень
 * громкости обязан стать больше нуля и меняться. Без этой проверки легко
 * поверить, что анимация работает, глядя на неподвижную картинку.
 */
import { chromium } from "playwright-core";
import { startStubServer } from "./server.mjs";

const PREFS = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, haptic: true, startTab: "home", hidden: [], callMe: "", botName: "Сара", avatar: "", tone: "friendly", address: "ty", emoji: true, search: true };

async function launch() {
  const args = [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",      // разрешение выдаётся само
    "--use-fake-device-for-media-stream",  // микрофон выдаёт тон
    "--autoplay-policy=no-user-gesture-required",
  ];
  const tries = [process.env.SMOKE_CHROME, null, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].filter((x) => x !== undefined);
  let last;
  for (const executablePath of tries) {
    try { return await chromium.launch({ ...(executablePath ? { executablePath } : {}), args }); } catch (e) { last = e; }
  }
  throw last;
}

const { server, port } = await startStubServer(PREFS);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] });
await ctx.addInitScript(() => {
  try { localStorage.setItem("sara-mic-asked", "1"); } catch (e) {}   // согласие уже дано
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failed = 0;
const check = (ok, name, extra = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` ${extra}` : ""}`); if (!ok) failed++; };

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tiles .tile", { timeout: 8000 });

// Кнопка голоса есть и в покое не размечена как записывающая
const mic = page.locator("#fab-mic");
check(await mic.count() === 1, "кнопка голоса на месте");

// Размер и выравнивание: голосовая кнопка заметно крупнее «плюса», но
// их центры по вертикальной оси совпадают — иначе столбик кнопок кривой.
// Меряем в «Задачах»: на главной «плюса» нет, добавлять там нечего.
await page.evaluate(() => go("tasks"));
await page.waitForSelector("#tasklist .card, #tasklist .empty", { timeout: 6000 });
const geom = await page.evaluate(() => {
  const m = document.getElementById("fab-mic").getBoundingClientRect();
  const p = document.getElementById("fab").getBoundingClientRect();
  return { mic: Math.round(m.width), plus: Math.round(p.width), micMid: Math.round(m.left + m.width / 2), plusMid: Math.round(p.left + p.width / 2), gap: Math.round(p.top - m.bottom) };
});
check(geom.mic >= 56, "кнопка голоса крупная", `${geom.mic}px`);
check(geom.mic > geom.plus, "крупнее «плюса»", `${geom.mic} против ${geom.plus}`);
check(Math.abs(geom.micMid - geom.plusMid) <= 2, "центры кнопок совпадают", `${geom.micMid} и ${geom.plusMid}`);
check(geom.gap >= 6, "кнопки не слипаются", `зазор ${geom.gap}px`);
check(!(await mic.evaluate((el) => el.classList.contains("rec"))), "в покое запись не идёт");

// Начинаем запись
await page.evaluate(() => window.voiceCommand());
await page.waitForFunction(() => document.getElementById("fab-mic").classList.contains("rec"), { timeout: 8000 });
check(true, "запись началась");

// Снимаем уровень несколько раз: он должен быть больше нуля и не стоять на месте
const levels = [];
for (let i = 0; i < 12; i++) {
  levels.push(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("fab-mic")).getPropertyValue("--lvl")) || 0));
  await page.waitForTimeout(120);
}
const max = Math.max(...levels);
const uniq = new Set(levels.map((v) => v.toFixed(3))).size;
check(max > 0.01, "кнопка слышит звук", `(максимум ${max.toFixed(3)})`);
check(uniq > 2, "уровень меняется, а не замер", `(${uniq} разных значений из ${levels.length})`);

// Кольцо действительно масштабируется от уровня
const scaled = await page.evaluate(() => {
  const el = document.getElementById("fab-mic");
  const t = getComputedStyle(el, "::before").transform;
  return t && t !== "none";
});
check(scaled, "кольцо вокруг кнопки масштабируется");

// Заканчиваем: уровень должен быть снят, чтобы кнопка не осталась раздутой
await page.evaluate(() => window.voiceCommand());
await page.waitForTimeout(600);
const after = await page.evaluate(() => document.getElementById("fab-mic").style.getPropertyValue("--lvl"));
check(after === "", "после записи уровень сброшен", `(осталось "${after}")`);

check(errors.length === 0, "ошибок JS нет", errors.join(" | "));

await browser.close();
server.close();
console.log(failed ? `\nПровалено проверок: ${failed}` : "\nКнопка голоса реагирует на звук");
process.exit(failed ? 1 : 0);
