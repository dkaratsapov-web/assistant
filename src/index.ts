import { handleApi } from "./api";
import { createBot } from "./bot";
import { DB } from "./db";
import { telemostAuthUrl, telemostExchangeCode } from "./telemost";
import { MaxClient, MaxUpdate } from "./max/client";
import { handleMaxUpdate } from "./max/bot";
import { buildDigest } from "./reports";
import { Env, ROLE_MEMBER, ROLE_OWNER } from "./types";
import { formatDue, formatEventTime, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf } from "./utils";

const MAX_UPDATE_TYPES = ["message_created", "message_callback", "bot_started"];

const COMMANDS = [
  { command: "menu", description: "Показать меню" },
  { command: "app", description: "Открыть приложение (доска задач)" },
  { command: "tasks", description: "Активные задачи" },
  { command: "addtask", description: "Новая задача" },
  { command: "clients", description: "Клиенты" },
  { command: "addclient", description: "Новый клиент" },
  { command: "notes", description: "Заметки" },
  { command: "ai", description: "Спросить ИИ" },
  { command: "digest", description: "Сводка на сегодня" },
  { command: "help", description: "Помощь" },
];

/** Отправка сообщения в Telegram напрямую (для cron — без grammy). */
async function tgSend(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

/** Напоминания пить воду: с учётом окна, интервала и дневной цели пользователя. */
async function runWaterReminders(env: Env, db: DB, tz: number): Promise<void> {
  const nowMs = Date.now();
  const localHour = new Date(nowMs + tz * 3600_000).getUTCHours();
  const users = [...(await db.listUsers(ROLE_OWNER)), ...(await db.listUsers(ROLE_MEMBER))];
  for (const u of users) {
    try {
      const { water } = await db.getNotif(u.user_id);
      if (!water.on) continue;
      if (localHour < water.from || localHour >= water.to) continue; // вне активного окна
      const last = parseInt((await db.getSetting(`water_last:${u.user_id}`)) ?? "0", 10) || 0;
      if (nowMs - last < water.everyHours * 3600_000) continue; // ещё рано
      const goal = parseInt((await db.getSetting(`hwater:${u.user_id}`)) ?? "", 10) || 2000;
      const total = await db.waterTotal(u.user_id, startOfLocalDayIso(tz), startOfLocalDayOffsetIso(tz, 1));
      if (total >= goal) continue; // цель достигнута — не беспокоим
      await tgSend(env.BOT_TOKEN, u.user_id, `💧 Пора попить воды.\nСегодня: ${(total / 1000).toFixed(1)} / ${(goal / 1000).toFixed(1)} л`);
      await db.setSetting(`water_last:${u.user_id}`, String(nowMs));
    } catch (e) {
      console.error("water reminder failed", u.user_id, e);
    }
  }
}

/** Одноразовая настройка: регистрирует webhook, команды и кнопку Mini App. */
async function handleInit(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden: добавь ?secret=WEBHOOK_SECRET", { status: 403 });
  }
  const bot = createBot(env, origin);
  await bot.api.setWebhook(`${origin}/webhook`, {
    secret_token: env.WEBHOOK_SECRET,
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query"],
  });
  await bot.api.setMyCommands(COMMANDS);
  await bot.api.setChatMenuButton({
    menu_button: { type: "web_app", text: "📲 Открыть", web_app: { url: origin } },
  });
  return new Response(`OK ✅ Webhook и меню настроены.\nБот готов, а Mini App доступен по адресу: ${origin}`);
}

/** Настройка канала MAX: подписывает webhook на обновления. */
async function handleMaxInit(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden: добавь ?secret=WEBHOOK_SECRET", { status: 403 });
  }
  if (!env.MAX_BOT_TOKEN) return new Response("MAX_BOT_TOKEN не задан", { status: 400 });
  if (!env.MAX_WEBHOOK_SECRET) return new Response("MAX_WEBHOOK_SECRET не задан", { status: 400 });
  const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
  try {
    const me = await client.getMe();
    await client.subscribe(`${origin}/max/webhook`, env.MAX_WEBHOOK_SECRET, MAX_UPDATE_TYPES);
    return new Response(`OK ✅ MAX webhook подписан на ${origin}/max/webhook\nБот: ${me.name ?? me.user_id}`);
  } catch (e) {
    return new Response(`MAX init error: ${(e as Error).message}`, { status: 502 });
  }
}

/** Приём обновлений MAX по webhook. */
async function handleMaxWebhook(request: Request, env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
  // Проверка секрета webhook (заголовок X-Max-Bot-Api-Secret)
  const got = request.headers.get("X-Max-Bot-Api-Secret");
  if (env.MAX_WEBHOOK_SECRET && got !== env.MAX_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let update: MaxUpdate;
  try {
    update = (await request.json()) as MaxUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  // Обрабатываем в фоне, MAX ждёт 200 в течение 30 секунд
  ctx.waitUntil(handleMaxUpdate(update, env, origin).catch((e) => console.error("max update failed", e)));
  return new Response("ok");
}

/** Одноразовое подключение Телемоста: редирект на OAuth Яндекса. */
function handleTelemostAuth(request: Request, env: Env, origin: string): Response {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden: добавь ?secret=WEBHOOK_SECRET", { status: 403 });
  }
  if (!env.TELEMOST_CLIENT_ID) return new Response("TELEMOST_CLIENT_ID не задан", { status: 400 });
  // Без своего redirect: Яндекс покажет код подтверждения — его нужно прислать боту командой /telemost <код>
  return Response.redirect(telemostAuthUrl(env.TELEMOST_CLIENT_ID), 302);
}

/** Колбэк OAuth Телемоста: меняем code на токены и сохраняем. */
async function handleTelemostCallback(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response(`Ошибка авторизации: ${url.searchParams.get("error") ?? "нет кода"}`, { status: 400 });
  const db = new DB(env.DB);
  try {
    await telemostExchangeCode(env, db, code, `${origin}/telemost/callback`);
    return new Response("✅ Телемост подключён! Можно закрыть страницу и создавать встречи со ссылкой.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Ошибка подключения Телемоста: ${(e as Error).message}`, { status: 502 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/webhook" && request.method === "POST") {
      // Быстро подтверждаем приём (200), тяжёлую обработку — в фон, чтобы Telegram не слал повторы
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update: unknown;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const bot = createBot(env, origin);
      ctx.waitUntil(bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]));
      return new Response("ok");
    }
    if (url.pathname === "/init") return handleInit(request, env, origin);
    if (url.pathname === "/max/webhook" && request.method === "POST") return handleMaxWebhook(request, env, origin, ctx);
    if (url.pathname === "/max/init") return handleMaxInit(request, env, origin);
    if (url.pathname === "/telemost/auth") return handleTelemostAuth(request, env, origin);
    if (url.pathname === "/telemost/callback") return handleTelemostCallback(request, env, origin);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    // Всё остальное — статика Mini App (index.html и т.д.)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = new DB(env.DB);
    const tz = tzOffsetOf(env);

    if (event.cron === "*/5 * * * *") {
      // Напоминания о наступивших дедлайнах задач (если включено у получателя)
      const tasks = await db.tasksDueForReminder(new Date().toISOString());
      for (const t of tasks) {
        const recipient = t.assignee_id ?? t.creator_id;
        try {
          const notif = await db.getNotif(recipient);
          if (!notif.tasks.on) { await db.markReminded(t.id); continue; }
          await tgSend(env.BOT_TOKEN, recipient, `⏰ Напоминание по задаче #${t.id}\n${t.title}\nДедлайн: ${formatDue(t.due_at, tz)}`);
          await db.markReminded(t.id);
        } catch (e) {
          console.error("reminder failed", t.id, e);
        }
      }
      // Напоминания о встречах (если включено)
      const events = await db.eventsDueForReminder(new Date().toISOString());
      for (const ev of events) {
        try {
          const notif = await db.getNotif(ev.user_id);
          if (!notif.events.on) { await db.markEventReminded(ev.id); continue; }
          await tgSend(env.BOT_TOKEN, ev.user_id, `📅 Скоро встреча: ${ev.title}\n🕒 ${formatEventTime(ev.starts_at, tz)}${ev.location ? `\n📍 ${ev.location}` : ""}`);
          await db.markEventReminded(ev.id);
        } catch (e) {
          console.error("event reminder failed", ev.id, e);
        }
      }
      // Напоминания пить воду
      await runWaterReminders(env, db, tz);
    } else if (event.cron === "0 * * * *") {
      const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
      const nowLocal = new Date(Date.now() + tz * 3600_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const mmdd = `${pad(nowLocal.getUTCMonth() + 1)}-${pad(nowLocal.getUTCDate())}`;
      const year = nowLocal.getUTCFullYear();

      // Дни рождения — в утренний час пользователя, если включено
      const bdays = await db.birthdaysForReminder(mmdd, year);
      for (const c of bdays) {
        try {
          const notif = await db.getNotif(c.user_id);
          if (!notif.birthdays.on || notif.morning.hour !== localHour) continue;
          await tgSend(env.BOT_TOKEN, c.user_id, `🎂 Сегодня день рождения: <b>${c.name}</b>!\nНе забудь поздравить 🎉${c.phone ? `\n📞 ${c.phone}` : ""}`);
          await db.markBirthdayReminded(c.id, year);
        } catch (e) {
          console.error("birthday reminder failed", c.id, e);
        }
      }

      // Утренний брифинг — в час, выбранный пользователем
      const recipients = [...(await db.listUsers(ROLE_OWNER)), ...(await db.listUsers(ROLE_MEMBER))];
      for (const u of recipients) {
        try {
          const notif = await db.getNotif(u.user_id);
          if (!notif.morning.on || notif.morning.hour !== localHour) continue;
          const text = await buildDigest(db, u.user_id, u.role, tz);
          await tgSend(env.BOT_TOKEN, u.user_id, "☀️ Доброе утро!\n\n" + text);
        } catch (e) {
          console.error("digest failed", u.user_id, e);
        }
      }
    }
  },
};
