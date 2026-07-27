import { webhookCallback } from "grammy";
import { handleApi } from "./api";
import { createBot } from "./bot";
import { DB } from "./db";
import { buildDigest } from "./reports";
import { Env, ROLE_MEMBER, ROLE_OWNER } from "./types";
import { formatDue, formatEventTime, tzOffsetOf } from "./utils";

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/webhook" && request.method === "POST") {
      const bot = createBot(env, origin);
      const handle = webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET });
      return handle(request);
    }
    if (url.pathname === "/init") return handleInit(request, env, origin);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    // Всё остальное — статика Mini App (index.html и т.д.)
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = new DB(env.DB);
    const tz = tzOffsetOf(env);

    if (event.cron === "*/5 * * * *") {
      // Напоминания о наступивших дедлайнах задач
      const tasks = await db.tasksDueForReminder(new Date().toISOString());
      for (const t of tasks) {
        const recipient = t.assignee_id ?? t.creator_id;
        const text = `⏰ Напоминание по задаче #${t.id}\n${t.title}\nДедлайн: ${formatDue(t.due_at, tz)}`;
        try {
          await tgSend(env.BOT_TOKEN, recipient, text);
          await db.markReminded(t.id);
        } catch (e) {
          console.error("reminder failed", t.id, e);
        }
      }
      // Напоминания о встречах
      const events = await db.eventsDueForReminder(new Date().toISOString());
      for (const ev of events) {
        const text = `📅 Скоро встреча: ${ev.title}\n🕒 ${formatEventTime(ev.starts_at, tz)}${ev.location ? `\n📍 ${ev.location}` : ""}`;
        try {
          await tgSend(env.BOT_TOKEN, ev.user_id, text);
          await db.markEventReminded(ev.id);
        } catch (e) {
          console.error("event reminder failed", ev.id, e);
        }
      }
    } else if (event.cron === "0 * * * *") {
      const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
      if (localHour !== parseInt(env.DIGEST_HOUR ?? "9", 10)) return;

      // Напоминания о днях рождения (раз в день, в час дайджеста)
      const nowLocal = new Date(Date.now() + tz * 3600_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const mmdd = `${pad(nowLocal.getUTCMonth() + 1)}-${pad(nowLocal.getUTCDate())}`;
      const year = nowLocal.getUTCFullYear();
      const bdays = await db.birthdaysForReminder(mmdd, year);
      for (const c of bdays) {
        try {
          await tgSend(env.BOT_TOKEN, c.user_id, `🎂 Сегодня день рождения: <b>${c.name}</b>!\nНе забудь поздравить 🎉${c.phone ? `\n📞 ${c.phone}` : ""}`);
          await db.markBirthdayReminded(c.id, year);
        } catch (e) {
          console.error("birthday reminder failed", c.id, e);
        }
      }

      // Утренний дайджест
      const recipients = [...(await db.listUsers(ROLE_OWNER)), ...(await db.listUsers(ROLE_MEMBER))];
      for (const u of recipients) {
        try {
          const text = await buildDigest(db, u.user_id, u.role, tz);
          await tgSend(env.BOT_TOKEN, u.user_id, "☀️ Доброе утро!\n\n" + text);
        } catch (e) {
          console.error("digest failed", u.user_id, e);
        }
      }
    }
  },
};
