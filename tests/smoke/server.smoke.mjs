/**
 * Дымовой тест сборки для своего сервера.
 *
 * Проверяет не код по кусочкам, а то, что собранный dist/server.mjs реально
 * поднимается и отвечает. Падения здесь ловятся самые обидные — те, что видны
 * только при запуске: grammy собран под CommonJS и внутри зовёт require, и в
 * ESM-сборке процесс умирал на старте ещё до первого запроса.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 8800 + Math.floor(Math.random() * 500);
let failed = 0;
const check = (ok, name, detail = "") => {
  if (ok) console.log("  ✓", name);
  else { failed++; console.log("  ✗", name, detail); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-srv-"));
fs.writeFileSync(path.join(dir, ".env"), "BOT_TOKEN=111:test\nOWNER_ID=1\nWEBHOOK_SECRET=s3cret\nTZ_OFFSET=3\n");

const child = spawn(process.execPath, [path.join(ROOT, "dist", "server.mjs")], {
  env: {
    ...process.env,
    APP_ROOT: ROOT,
    ENV_FILE: path.join(dir, ".env"),
    DB_FILE: path.join(dir, "app.db"),
    PORT: String(PORT),
    // Явно гасим часть окружения, чтобы тест не ходил в настоящие сервисы
    PUBLIC_HOST: "",
    MAX_BOT_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));

const base = `http://127.0.0.1:${PORT}`;
const get = async (p, opts) => await fetch(base + p, opts);

/** Ждём, пока сервер поднимется, но не бесконечно. */
async function waitUp(limitMs = 15000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    try {
      const r = await get("/health");
      if (r.ok) return true;
    } catch {
      // ещё не слушает
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

console.log("Сценарий: сборка для своего сервера");
try {
  const up = await waitUp();
  check(up, "сервер поднялся", log.slice(-600));
  if (!up) throw new Error("не поднялся");

  check((await (await get("/health")).text()) === "ok", "проверка живости отвечает");

  const version = await (await get("/version")).text();
  check(version.length > 5 && !version.includes("Ошибка"), "метка сборки отдаётся", version);

  const html = await (await get("/")).text();
  check(html.includes("<!DOCTYPE html>"), "интерфейс Mini App отдаётся с диска");
  check(html.includes("Сара") || html.includes("sara"), "это именно наше приложение");

  const asset = await get("/manifest.webmanifest").catch(() => null);
  check(asset !== null, "запрос за файлом не роняет сервер");

  // Неизвестный путь — одностраничное приложение, отдаём index.html, а не 404
  const deep = await get("/clients/123");
  check(deep.status === 200, "внутренняя ссылка не даёт 404", String(deep.status));

  // Без входа API должно отказывать, а не пускать
  check((await get("/api/me")).status === 401, "API без входа отвечает «нельзя»");
  check((await get("/api/tasks")).status === 401, "список задач без входа закрыт");

  // Вебхук без правильного секрета принимать нельзя
  const hook = await get("/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(hook.status === 403, "вебхук без секрета отклоняется", String(hook.status));

  const hookOk = await get("/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
    body: JSON.stringify({ update_id: 1 }),
  });
  check(hookOk.status === 200, "вебхук с секретом принимается", String(hookOk.status));

  // Служебные адреса без секрета закрыты
  check((await get("/diag/spell")).status === 403, "диагностика без секрета закрыта");

  // База действительно создалась файлом
  check(fs.existsSync(path.join(dir, "app.db")), "файл базы создан");

  check(!/Error:|не поднялся/.test(log), "в журнале нет ошибок", log.slice(-400));
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log(`\nНе прошло проверок: ${failed}`);
  process.exit(1);
}
console.log("\nСборка для своего сервера работает");
