/**
 * Запуск ассистента на обычном сервере вместо Cloudflare Workers.
 *
 * Зачем: приложение и бот жили на домене workers.dev. В России до него не
 * всегда доходит — в MAX бот открывался только с VPN. Сам интерфейс от
 * зарубежных доменов уже очищен (на это есть отдельный тест), но адрес
 * оставался cloudflare-ский, и это чинится только переездом.
 *
 * Логика не переписана: это тот же src/index.ts. Здесь только подменены три
 * вещи, которых на своём сервере нет:
 *   • D1          → SQLite файлом (server/sqlite.ts);
 *   • env.ASSETS  → отдача public/ с диска;
 *   • cron-триггеры → таймеры внутри процесса.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { Env } from "../src/types";
import worker from "../src/index";
import { SqliteD1 } from "./sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT || path.resolve(HERE, "..");

/* ---------- Настройки ---------- */

/**
 * Читает .env рядом с приложением.
 *
 * Разбор нарочно свой и простой: лишняя зависимость ради пятнадцати строк —
 * плохой обмен, а секреты на сервере лежат в файле с правами 600.
 */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let value = s.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(process.env.ENV_FILE || path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DB_FILE = process.env.DB_FILE || path.join(ROOT, "data", "assistant.db");
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(ROOT, "public");

/* ---------- База ---------- */

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const sqlite = new SqliteD1(DB_FILE);

// Схему применяем при каждом запуске: все CREATE написаны с IF NOT EXISTS,
// поэтому на существующей базе это пустая операция, а на новой — создаёт её.
const schemaFile = path.join(ROOT, "schema.sql");
if (fs.existsSync(schemaFile)) {
  try {
    sqlite.exec(fs.readFileSync(schemaFile, "utf8"));
  } catch (e) {
    console.error("схема не применилась:", (e as Error).message);
  }
}

/* ---------- Статика ---------- */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Отдаёт файлы Mini App — замена env.ASSETS.
 *
 * Как и у Cloudflare, неизвестный путь отдаёт index.html: приложение
 * одностраничное, и переход по внутренней ссылке не должен давать 404.
 */
const assets = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rel = url.pathname === "/" || url.pathname === "/app" ? "/index.html" : url.pathname;
    let full = path.join(PUBLIC_DIR, decodeURIComponent(rel));
    // Защита от выхода за пределы папки: «/../../etc/passwd»
    if (!full.startsWith(PUBLIC_DIR)) full = path.join(PUBLIC_DIR, "index.html");
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(PUBLIC_DIR, "index.html");
    if (!fs.existsSync(full)) return new Response("not found", { status: 404 });
    const type = TYPES[path.extname(full)] ?? "application/octet-stream";
    return new Response(fs.readFileSync(full), { status: 200, headers: { "content-type": type } });
  },
};

/* ---------- Окружение ---------- */

const env = {
  ...process.env,
  DB: sqlite,
  ASSETS: assets,
} as unknown as Env;

/**
 * Замена ExecutionContext.
 *
 * На Cloudflare waitUntil держит воркер живым, пока фоновая работа не
 * закончится. Обычный процесс никто не замораживает, поэтому достаточно не
 * потерять ошибку: без перехвата необработанное отклонение роняет весь сервер.
 */
const ctx = {
  waitUntil(promise: Promise<unknown>) {
    Promise.resolve(promise).catch((e) => console.error("фоновая задача упала:", e));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

/* ---------- HTTP ---------- */

/** Запрос Node → запрос Fetch, с которым умеет работать воркер. */
async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  // За nginx настоящий протокол и хост приходят заголовками. Без этого воркер
  // сочтёт себя доступным по http://127.0.0.1:8787 и пропишет такой адрес
  // вебхука — Telegram и MAX его не примут.
  const proto = headers.get("x-forwarded-proto") || (process.env.PUBLIC_HOST ? "https" : "http");
  const host = process.env.PUBLIC_HOST || headers.get("x-forwarded-host") || headers.get("host") || `${HOST}:${PORT}`;
  const url = `${proto}://${host}${req.url ?? "/"}`;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? Buffer.concat(await toChunks(req)) : undefined;
  return new Request(url, { method: req.method, headers, body });
}

async function toChunks(req: http.IncomingMessage): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks;
}

/** Ответ Fetch → ответ Node. */
async function send(res: http.ServerResponse, out: Response): Promise<void> {
  res.statusCode = out.status;
  for (const [k, v] of out.headers) {
    // set-cookie может быть несколько — Headers склеивает их в одну строку
    if (k.toLowerCase() === "set-cookie") continue;
    res.setHeader(k, v);
  }
  const cookies = typeof (out.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (out.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [];
  if (cookies.length) res.setHeader("set-cookie", cookies);

  if (!out.body) return void res.end();
  Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const out = await worker.fetch(await toRequest(req), env, ctx);
    await send(res, out);
  } catch (e) {
    console.error("запрос упал:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }
    res.end(`Ошибка на сервере\n${(e as Error)?.message ?? String(e)}`);
  }
});

/* ---------- Фоновые задачи ---------- */

/**
 * Замена cron-триггеров Cloudflare (`*​/5 * * * *` и `0 * * * *`).
 *
 * Привязываемся к стенке часов, а не к моменту запуска: иначе после перезапуска
 * «ежечасная» задача начинала бы ходить, например, в 13:47, и утренний дайджест
 * приходил бы не в девять.
 */
function everyAlignedMinutes(minutes: number, cron: string): void {
  const period = minutes * 60_000;
  const tick = async () => {
    try {
      await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
    } catch (e) {
      console.error(`фоновая задача ${cron} упала:`, e);
    }
  };
  const schedule = () => {
    const wait = period - (Date.now() % period);
    setTimeout(() => {
      void tick();
      schedule();
    }, wait).unref?.();
  };
  schedule();
}

/* ---------- Старт ---------- */

server.listen(PORT, HOST, () => {
  console.log(`Сара слушает http://${HOST}:${PORT}`);
  console.log(`База: ${DB_FILE}`);
  console.log(`Интерфейс: ${PUBLIC_DIR}`);
  console.log(`Публичный адрес: ${process.env.PUBLIC_HOST || "(не задан — вебхуки не настроятся)"}`);
  everyAlignedMinutes(5, "*/5 * * * *");
  everyAlignedMinutes(60, "0 * * * *");
});

/** Остановка по-человечески: дописать базу и закрыть соединения. */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig}: останавливаюсь`);
    server.close(() => {
      sqlite.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// Без этого одна потерянная ошибка в фоне роняет весь процесс и бот замолкает
process.on("unhandledRejection", (e) => console.error("необработанная ошибка:", e));
