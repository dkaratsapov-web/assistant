import { handleApi } from "./api";
import { createBot } from "./bot";
import { DB } from "./db";
import { telemostAuthUrl, telemostExchangeCode, telemostState } from "./telemost";
import { MaxClient, MaxUpdate } from "./max/client";
import { handleMaxUpdate } from "./max/bot";
import { CHANNEL_MAX } from "./max/ids";
import { buildDigest } from "./reports";
import { Env, ROLE_MEMBER, ROLE_OWNER, User } from "./types";
import { formatDue, formatEventTime, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf } from "./utils";

const MAX_UPDATE_TYPES = ["message_created", "message_callback", "bot_started"];

/** Метка сборки: видна на /version — по ней сразу ясно, какая версия сейчас в проде. */
const BUILD = "2026-09-02 max-diag2";

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

/**
 * Напоминание пользователю в его мессенджер: Telegram или MAX.
 * У пользователей MAX внутренний user_id виртуальный, поэтому пишем на ext_id
 * через MAX Bot API (и снимаем HTML-разметку — MAX её не понимает).
 */
async function notify(env: Env, user: User, text: string): Promise<void> {
  if ((user.channel ?? "tg") === CHANNEL_MAX) {
    if (!env.MAX_BOT_TOKEN || !user.ext_id) return;
    const plain = text.replace(/<[^>]+>/g, "");
    await new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL).sendMessage({ userId: user.ext_id }, plain);
    return;
  }
  await tgSend(env.BOT_TOKEN, user.user_id, text);
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
      await notify(env, u, `💧 Пора попить воды.\nСегодня: ${(total / 1000).toFixed(1)} / ${(goal / 1000).toFixed(1)} л`);
      await db.setSetting(`water_last:${u.user_id}`, String(nowMs));
    } catch (e) {
      console.error("water reminder failed", u.user_id, e);
    }
  }
}

/** Напоминания о приёме БАДов/фармы по времени курса. */
async function runSupplementReminders(env: Env, db: DB, tz: number): Promise<void> {
  const userCache = new Map<number, User | null>();
  const userOf = async (id: number) => {
    if (!userCache.has(id)) userCache.set(id, await db.getUser(id));
    return userCache.get(id) ?? null;
  };
  const now = new Date(Date.now() + tz * 3600_000);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.parse(startOfLocalDayIso(tz)) + tz * 3600_000).toISOString().slice(0, 10);
  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const courses = await db.allActiveSupplements();
  for (const c of courses) {
    try {
      if (c.start_date && today < c.start_date) continue;
      if (c.days && c.start_date && today >= addDays(c.start_date, c.days)) continue;
      const slots = JSON.parse(c.times || "[]") as string[];
      for (const slot of slots) {
        const [hh, mm] = slot.split(":").map(Number);
        const diff = nowMin - (hh * 60 + mm);
        if (diff < 0 || diff >= 5) continue; // попадаем в 5-минутное окно один раз
        if (await db.supTaken(c.user_id, c.id, today, slot)) continue;
        const u = await userOf(c.user_id);
        if (!u) continue;
        await notify(env, u, `💊 Время принять: <b>${c.name}</b>${c.dose ? ` (${c.dose})` : ""}\nОтметь: Здоровье → 💊 БАДы.`);
      }
    } catch (e) {
      console.error("supp reminder failed", c.id, e);
    }
  }
}

/**
 * Самонастройка каналов: раз в час проверяет, что webhook Telegram и подписка MAX
 * на месте, и восстанавливает их. Благодаря этому открывать /init и /max/init руками
 * не нужно — достаточно задать секреты, остальное бот делает сам.
 */
async function ensureWebhooks(env: Env, db: DB, origin: string): Promise<void> {
  // Telegram: setWebhook идемпотентен, но лишний раз не дёргаем — сверяем текущий адрес
  try {
    const want = `${origin}/webhook`;
    const info = (await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`)).json()) as {
      result?: { url?: string };
    };
    if (info.result?.url !== want) {
      const bot = createBot(env, origin);
      await bot.api.setWebhook(want, { secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
      await bot.api.setMyCommands(COMMANDS);
      await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "📲 Открыть", web_app: { url: origin } } });
      await db.setSetting("tg_init_at", new Date().toISOString());
    }
  } catch (e) {
    console.error("tg webhook ensure failed", e);
  }

  // MAX: подписываемся, если нашего адреса нет в списке подписок
  if (!env.MAX_BOT_TOKEN || !env.MAX_WEBHOOK_SECRET) return;
  try {
    const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
    const want = `${origin}/max/webhook`;
    const subs = (await client.getSubscriptions()) as { subscriptions?: { url?: string }[] };
    const has = (subs?.subscriptions ?? []).some((x) => x.url === want);
    if (!has) {
      await client.subscribe(want, env.MAX_WEBHOOK_SECRET, MAX_UPDATE_TYPES);
      await db.setSetting("max_init_at", new Date().toISOString());
      console.log("max webhook subscribed", want);
    }
  } catch (e) {
    console.error("max webhook ensure failed", e);
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

/** Служебные адреса MAX пускают по любому из двух секретов — что окажется под рукой. */
function maxAdminAllowed(url: URL, env: Env): boolean {
  const got = url.searchParams.get("secret") ?? "";
  return !!got && (got === env.WEBHOOK_SECRET || (!!env.MAX_WEBHOOK_SECRET && got === env.MAX_WEBHOOK_SECRET));
}

/** Настройка канала MAX: подписывает webhook на обновления. */
async function handleMaxInit(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  if (!maxAdminAllowed(url, env)) {
    return new Response("forbidden: добавь ?secret=WEBHOOK_SECRET (подойдёт и MAX_WEBHOOK_SECRET)", { status: 403 });
  }
  if (!env.MAX_BOT_TOKEN) return new Response("MAX_BOT_TOKEN не задан", { status: 400 });
  if (!env.MAX_WEBHOOK_SECRET) return new Response("MAX_WEBHOOK_SECRET не задан", { status: 400 });
  const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
  const db = new DB(env.DB);
  try {
    const me = await client.getMe();
    // старые подписки на этот же адрес мешают переподписке — снимаем и подписываемся заново
    await client.unsubscribe(`${origin}/max/webhook`).catch(() => {});
    await client.subscribe(`${origin}/max/webhook`, env.MAX_WEBHOOK_SECRET, MAX_UPDATE_TYPES);
    const subs = await client.getSubscriptions().catch(() => null);
    await db.setSetting("max_init_at", new Date().toISOString());
    return new Response(
      `OK ✅ MAX webhook подписан на ${origin}/max/webhook\nБот: ${me.name ?? me.user_id}\n\nПодписки сейчас:\n${JSON.stringify(subs, null, 2)}`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  } catch (e) {
    return new Response(`MAX init error: ${(e as Error).message}`, { status: 502 });
  }
}

/** Диагностика канала MAX: что настроено, какие подписки и приходили ли обновления. */
async function handleMaxStatus(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  if (!maxAdminAllowed(url, env)) {
    return new Response("forbidden: добавь ?secret=WEBHOOK_SECRET (подойдёт и MAX_WEBHOOK_SECRET)", { status: 403 });
  }
  const db = new DB(env.DB);
  const out: Record<string, unknown> = {
    webhookUrl: `${origin}/max/webhook`,
    hasBotToken: !!env.MAX_BOT_TOKEN,
    hasWebhookSecret: !!env.MAX_WEBHOOK_SECRET,
    maxOwnerId: env.MAX_OWNER_ID ?? null,
    ownerId: env.OWNER_ID ?? null,
    hasAiKey: !!(env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID),
    initAt: await db.getSetting("max_init_at"),
    lastUpdateAt: await db.getSetting("max_last_update_at"),
    lastUpdateType: await db.getSetting("max_last_update_type"),
    lastUpdateFrom: await db.getSetting("max_last_update_from"),
    lastRejectAt: await db.getSetting("max_last_reject_at"),
  };
  if (env.MAX_BOT_TOKEN) {
    const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
    out.me = await client.getMe().catch((e) => ({ error: (e as Error).message }));
    out.subscriptions = await client.getSubscriptions().catch((e) => ({ error: (e as Error).message }));
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Приём обновлений MAX по webhook. */
async function handleMaxWebhook(request: Request, env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
  const db = new DB(env.DB);
  const url = new URL(request.url);
  // Секрет MAX присылает заголовком; какой именно вариант имени — зависит от версии
  // платформы, поэтому принимаем несколько и допускаем передачу в query.
  const got =
    request.headers.get("X-Max-Bot-Api-Secret") ??
    request.headers.get("X-Max-Api-Secret") ??
    request.headers.get("X-Secret") ??
    url.searchParams.get("secret");
  if (env.MAX_WEBHOOK_SECRET && got != null && got !== env.MAX_WEBHOOK_SECRET) {
    // Секрет пришёл, но чужой — это уже не наш отправитель
    await db.setSetting("max_last_reject_at", new Date().toISOString());
    return new Response("forbidden", { status: 403 });
  }
  let update: MaxUpdate;
  try {
    update = (await request.json()) as MaxUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  // Отметка о приёме — по ней видно в /max/status, доходят ли обновления вообще
  ctx.waitUntil(
    (async () => {
      await db.setSetting("max_last_update_at", new Date().toISOString());
      await db.setSetting("max_last_update_type", update.update_type ?? "?");
      await db.setSetting(
        "max_last_update_from",
        String(update.message?.sender?.user_id ?? update.user?.user_id ?? update.callback?.user?.user_id ?? "")
      );
    })().catch(() => {})
  );
  // Обрабатываем в фоне, MAX ждёт 200 в течение 30 секунд
  ctx.waitUntil(handleMaxUpdate(update, env, origin).catch((e) => console.error("max update failed", e)));
  return new Response("ok");
}

/** Одноразовое подключение Телемоста: редирект на OAuth Яндекса. */
async function handleTelemostAuth(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden: добавь ?secret=WEBHOOK_SECRET", { status: 403 });
  }
  if (!env.TELEMOST_CLIENT_ID) return new Response("TELEMOST_CLIENT_ID не задан", { status: 400 });
  // Без своего redirect: Яндекс покажет код подтверждения — его нужно прислать боту командой /telemost <код>.
  // state нужен, если у OAuth-приложения задан redirect на /telemost/callback: колбэк примет код только со своим state.
  return Response.redirect(telemostAuthUrl(env.TELEMOST_CLIENT_ID, undefined, await telemostState(env.WEBHOOK_SECRET)), 302);
}

/** Колбэк OAuth Телемоста: меняем code на токены и сохраняем. */
async function handleTelemostCallback(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  // Колбэк открыт наружу, поэтому принимаем код только со своим state — иначе чужой
  // токен перезапишет сохранённый (CSRF).
  if (url.searchParams.get("state") !== (await telemostState(env.WEBHOOK_SECRET))) {
    return new Response("forbidden: неверный state", { status: 403 });
  }
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
    if (url.pathname === "/max/status") return handleMaxStatus(request, env, origin);
    if (url.pathname === "/telemost/auth") return handleTelemostAuth(request, env, origin);
    if (url.pathname === "/telemost/callback") return handleTelemostCallback(request, env, origin);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/version") {
      return new Response(BUILD, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    // Всё остальное — статика Mini App (index.html и т.д.).
    // HTML отдаём без кеша: webview Telegram и MAX иначе держат старую версию
    // приложения и после деплоя показывают вчерашний экран.
    const asset = await env.ASSETS.fetch(request);
    if ((asset.headers.get("content-type") ?? "").includes("text/html")) {
      const headers = new Headers(asset.headers);
      headers.set("cache-control", "no-cache, no-store, must-revalidate");
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    }
    return asset;
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = new DB(env.DB);
    const tz = tzOffsetOf(env);
    // настройки уведомлений и записи пользователей читаем один раз на пользователя за прогон крона
    const userCache = new Map<number, User | null>();
    const userOf = async (id: number) => {
      if (!userCache.has(id)) userCache.set(id, await db.getUser(id));
      return userCache.get(id) ?? null;
    };
    const notifCache = new Map<number, Awaited<ReturnType<DB["getNotif"]>>>();
    const notifOf = async (uid: number) => {
      let n = notifCache.get(uid);
      if (!n) {
        n = await db.getNotif(uid);
        notifCache.set(uid, n);
      }
      return n;
    };

    if (event.cron === "*/5 * * * *") {
      // Напоминания о наступивших дедлайнах задач (если включено у получателя)
      const tasks = await db.tasksDueForReminder(new Date().toISOString());
      for (const t of tasks) {
        const recipient = t.assignee_id ?? t.creator_id;
        try {
          const notif = await notifOf(recipient);
          if (!notif.tasks.on) { await db.markReminded(t.id); continue; }
          const u = await userOf(recipient);
          if (u) await notify(env, u, `⏰ Напоминание по задаче #${t.id}\n${t.title}\nДедлайн: ${formatDue(t.due_at, tz)}`);
          await db.markReminded(t.id);
        } catch (e) {
          console.error("reminder failed", t.id, e);
        }
      }
      // Напоминания о встречах (если включено)
      const events = await db.eventsDueForReminder(new Date().toISOString());
      for (const ev of events) {
        try {
          const notif = await notifOf(ev.user_id);
          if (!notif.events.on) { await db.markEventReminded(ev.id); continue; }
          const u = await userOf(ev.user_id);
          if (u) await notify(env, u, `📅 Скоро встреча: ${ev.title}\n🕒 ${formatEventTime(ev.starts_at, tz)}${ev.location ? `\n📍 ${ev.location}` : ""}`);
          await db.markEventReminded(ev.id);
        } catch (e) {
          console.error("event reminder failed", ev.id, e);
        }
      }
      // Напоминания пить воду
      await runWaterReminders(env, db, tz);
      // Напоминания о приёме БАДов/фармы
      await runSupplementReminders(env, db, tz);
    } else if (event.cron === "0 * * * *") {
      // каналы должны быть подписаны — проверяем и чиним сами
      await ensureWebhooks(env, db, `https://${env.PUBLIC_HOST || "assistant.d-karatsapov.workers.dev"}`);
      const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
      const nowLocal = new Date(Date.now() + tz * 3600_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const mmdd = `${pad(nowLocal.getUTCMonth() + 1)}-${pad(nowLocal.getUTCDate())}`;
      const year = nowLocal.getUTCFullYear();

      // Дни рождения — в утренний час пользователя, если включено
      const bdays = await db.birthdaysForReminder(mmdd, year);
      for (const c of bdays) {
        try {
          const notif = await notifOf(c.user_id);
          if (!notif.birthdays.on || notif.morning.hour !== localHour) continue;
          const u = await userOf(c.user_id);
          if (!u) continue;
          await notify(env, u, `🎂 Сегодня день рождения: <b>${c.name}</b>!\nНе забудь поздравить 🎉${c.phone ? `\n📞 ${c.phone}` : ""}`);
          await db.markBirthdayReminded(c.id, year);
        } catch (e) {
          console.error("birthday reminder failed", c.id, e);
        }
      }

      // Утренний брифинг + напоминания о приёмах пищи — в выбранные часы
      const recipients = [...(await db.listUsers(ROLE_OWNER)), ...(await db.listUsers(ROLE_MEMBER))];
      const start = startOfLocalDayIso(tz), end = startOfLocalDayOffsetIso(tz, 1);
      for (const u of recipients) {
        try {
          const notif = await notifOf(u.user_id);
          if (notif.morning.on && notif.morning.hour === localHour) {
            const text = await buildDigest(db, u.user_id, u.role, tz);
            await notify(env, u, "☀️ Доброе утро!\n\n" + text);
          }
          if (notif.meals.on) {
            const slot = notif.meals.breakfast === localHour ? "breakfast" : notif.meals.lunch === localHour ? "lunch" : notif.meals.dinner === localHour ? "dinner" : null;
            if (slot) {
              const food = await db.listFood(u.user_id, start, end);
              if (!food.some((f) => (f.meal || "") === slot)) {
                const ru = { breakfast: "завтрак", lunch: "обед", dinner: "ужин" }[slot];
                await notify(env, u, `🍽 Не забудь записать ${ru} — просто скажи «съел…» или пришли фото блюда.`);
              }
            }
          }
        } catch (e) {
          console.error("digest/meal failed", u.user_id, e);
        }
      }
    }
  },
};
