import { Bot, Context, InlineKeyboard, InputFile, Keyboard } from "grammy";
import { askAI, DEFAULT_MODEL, estimateNutritionFromImage } from "./ai";
import { buildDocx } from "./docx";
import { buildNutritionSummary } from "./reports";
import { tryPerformCommand } from "./intent";
import { telemostExchangeCode, metrikaStats, MetrikaReport } from "./telemost";
import { transcribeVoice } from "./speech";
import { DB } from "./db";
import { buildClientsOverview, buildDigest } from "./reports";
import {
  Env,
  PLATFORMS,
  ROLE_CLIENT,
  ROLE_MEMBER,
  ROLE_OWNER,
  ROLE_PENDING,
  TASK_DONE,
  TASK_IN_PROGRESS,
  TASK_OPEN,
  TASK_STATUS_LABELS,
  User,
} from "./types";
import { escapeHtml, extractTags, formatDue, mealByHour, mealFromText, parseDue, platformsToText, tzOffsetOf } from "./utils";

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return btoa(bin);
}

export type MyContext = Context & {
  db: DB;
  env: Env;
  origin: string;
  ownerId: number;
  appUser: User | null;
};

// Кнопки главного меню (текст = триггер)
const BTN_TASKS = "📋 Задачи";
const BTN_ADD_TASK = "➕ Задача";
const BTN_CLIENTS = "👥 Клиенты";
const BTN_NOTES = "📝 Заметки";
const BTN_AI = "🤖 ИИ-помощник";
const BTN_DIGEST = "📊 Сводка";
const BTN_HELP = "❓ Помощь";
const BTN_APP = "📲 Приложение";

const WELCOME =
  "Привет! Я твой рабочий ассистент 🤝\n\n" +
  "Помогаю держать под контролем задачи, дедлайны, клиентов и заметки, " +
  "а ещё умею писать тексты объявлений и подкидывать идеи через ИИ.\n\n" +
  "Пользуйся кнопками меню внизу. Полный список — /help.";

const HELP_TEXT = `<b>Что я умею</b>

<b>📋 Задачи и дедлайны</b>
• «➕ Задача» или /addtask — добавить задачу (пошагово)
• «📋 Задачи» или /tasks — список активных задач
• «📲 Приложение» — доска задач в удобном интерфейсе

<b>👥 Клиенты и проекты</b>
• /addclient — новый клиент
• /clients — список; /client &lt;номер&gt; — карточка

<b>📝 Заметки и идеи</b>
• Пришли текст с «!» в начале — сохраню как заметку
• /notes — заметки; /findnote &lt;слово&gt; — поиск

<b>🤖 ИИ-помощник</b>
• «🤖 ИИ-помощник» — режим диалога; /ai &lt;запрос&gt; — быстрый вопрос

<b>📊 Прочее</b>
• «📊 Сводка» или /digest — задачи на сегодня; утренний дайджест приходит сам

<b>Владелец:</b> /users, /kick &lt;ID&gt;

<i>Дедлайн можно писать словами: «завтра», «пятница», «через 3 дня», «15.03 14:00».</i>`;

function mainMenu(origin: string): Keyboard {
  return new Keyboard()
    .text(BTN_ADD_TASK).text(BTN_TASKS).row()
    .text(BTN_CLIENTS).text(BTN_NOTES).row()
    .text(BTN_AI).text(BTN_DIGEST).row()
    .webApp(BTN_APP, origin).text(BTN_HELP).row()
    .resized();
}

function taskActions(id: number, status: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (status !== TASK_DONE) {
    if (status === TASK_OPEN) kb.text("🟡 В работу", `task:progress:${id}`);
    kb.text("✅ Готово", `task:done:${id}`);
  } else {
    kb.text("↩️ Вернуть", `task:reopen:${id}`);
  }
  kb.text("🗑 Удалить", `task:del:${id}`);
  return kb;
}

function platformsPicker(selected: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const entries = Object.entries(PLATFORMS);
  entries.forEach(([key, label], i) => {
    kb.text(`${selected.includes(key) ? "✅ " : ""}${label}`, `plat:toggle:${key}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("Готово ▶️", "plat:done");
  return kb;
}

function clientActions(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Задачи клиента", `client:tasks:${id}`).row()
    .text("⏸ Пауза/актив", `client:togglestatus:${id}`)
    .text("🗑 Удалить", `client:del:${id}`);
}

function pendingActions(uid: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ В команду", `access:member:${uid}`)
    .text("👤 Как клиента", `access:client:${uid}`).row()
    .text("🚫 Отклонить", `access:reject:${uid}`);
}

function taskLine(t: { id: number; title: string; description: string; status: string; due_at: string | null }, clientName: string | null, tzOffset: number): string {
  const status = TASK_STATUS_LABELS[t.status] ?? t.status;
  const due = formatDue(t.due_at, tzOffset);
  const meta = [status];
  if (due) meta.push(due);
  if (clientName) meta.push(`👥 ${escapeHtml(clientName)}`);
  let s = `<b>#${t.id}</b> ${escapeHtml(t.title)}\n${meta.join(" · ")}`;
  if (t.description) s += `\n<i>${escapeHtml(t.description)}</i>`;
  return s;
}

function userDisplay(u: User): string {
  const name = u.full_name || "Без имени";
  return `${name}${u.username ? ` (@${u.username})` : ""}`;
}

const HTML = { parse_mode: "HTML" as const };

export function createBot(env: Env, origin: string): Bot<MyContext> {
  // botInfo задаём вручную (id берём из токена), чтобы grammy не звал getMe
  // на каждый webhook — на serverless это лишний сетевой вызов.
  const botId = Number(env.BOT_TOKEN.split(":")[0]) || 0;
  const botInfo = {
    id: botId,
    is_bot: true as const,
    first_name: "Assistant",
    username: "assistant_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const bot = new Bot<MyContext>(env.BOT_TOKEN, { botInfo });
  const db = new DB(env.DB);
  const ownerId = parseInt(env.OWNER_ID, 10);
  const tz = tzOffsetOf(env);

  // --- Контекст + контроль доступа ---
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.env = env;
    ctx.origin = origin;
    ctx.ownerId = ownerId;
    const from = ctx.from;
    if (!from) {
      ctx.appUser = null;
      return;
    }

    if (from.id === ownerId) await db.ensureOwner(ownerId);
    let user = await db.getUser(from.id);
    ctx.appUser = user;

    if (user) {
      const fn = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
      if (user.username !== (from.username ?? null) || user.full_name !== fn) {
        await db.updateProfile(from.id, from.username ?? null, fn);
      }
    }

    const isKnown = user && user.role !== ROLE_PENDING;
    const text = ctx.message?.text ?? "";
    const isStart = text.startsWith("/start");

    if (isKnown || isStart) return next();

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
      return;
    }
    if (user && user.role === ROLE_PENDING) {
      await ctx.reply("⏳ Заявка на доступ отправлена. Ждём подтверждения владельца.");
    } else {
      await ctx.reply("Нет доступа. Нажми /start, чтобы отправить заявку владельцу бота.");
    }
  });

  // --- /start и доступ ---
  bot.command("start", async (ctx) => {
    const from = ctx.from!;
    if (from.id === ownerId) {
      await ctx.reply(WELCOME, { reply_markup: mainMenu(origin) });
      return;
    }
    const user = ctx.appUser;
    if (user && user.role !== ROLE_PENDING) {
      await ctx.reply(WELCOME, { reply_markup: mainMenu(origin) });
      return;
    }
    if (user && user.role === ROLE_PENDING) {
      await ctx.reply("⏳ Заявка уже отправлена. Ждём подтверждения владельца.");
      return;
    }
    const fn = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
    await db.requestAccess(from.id, from.username ?? null, fn);
    await ctx.reply("Заявка на доступ отправлена владельцу бота. Как подтвердит — я напишу 👌");
    const disp = `${from.first_name}${from.username ? ` (@${from.username})` : ""}`;
    try {
      await ctx.api.sendMessage(ownerId, `🔔 Новая заявка на доступ:\n${disp}\nID: <code>${from.id}</code>`, {
        ...HTML,
        reply_markup: pendingActions(from.id),
      });
    } catch {}
  });

  bot.callbackQuery(/^access:(member|client|reject):(\d+)$/, async (ctx) => {
    if (ctx.from!.id !== ownerId) {
      await ctx.answerCallbackQuery({ text: "Только владелец управляет доступом.", show_alert: true });
      return;
    }
    const action = ctx.match![1];
    const uid = parseInt(ctx.match![2], 10);
    const target = await db.getUser(uid);
    if (!target) {
      await ctx.answerCallbackQuery({ text: "Пользователь не найден.", show_alert: true });
      await ctx.editMessageReplyMarkup();
      return;
    }
    let note: string;
    let notify: string | null;
    if (action === "member") {
      await db.setRole(uid, ROLE_MEMBER);
      note = "Добавлен в команду ✅";
      notify = "✅ Доступ выдан! Тебя добавили в команду. Нажми /start.";
    } else if (action === "client") {
      await db.setRole(uid, ROLE_CLIENT);
      note = "Добавлен как клиент 👤";
      notify = "✅ Доступ выдан (роль: клиент). Нажми /start.";
    } else {
      await db.deleteUser(uid);
      note = "Заявка отклонена 🚫";
      notify = null;
    }
    await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ""}\n\n→ ${note}`);
    if (notify) {
      try {
        await ctx.api.sendMessage(uid, notify, { reply_markup: mainMenu(origin) });
      } catch {}
    }
    await ctx.answerCallbackQuery({ text: note });
  });

  // --- Помощь / меню / приложение ---
  bot.command("help", async (ctx) => ctx.reply(HELP_TEXT, HTML));
  bot.command("menu", async (ctx) => ctx.reply("Меню внизу 👇", { reply_markup: mainMenu(origin) }));
  bot.command("app", async (ctx) => {
    await ctx.reply("Открой доску задач в удобном интерфейсе:", {
      reply_markup: new InlineKeyboard().webApp("📲 Открыть приложение", origin),
    });
  });

  // --- Задачи ---
  bot.command(["addtask"], async (ctx) => startAddTask(ctx));
  bot.command("tasks", async (ctx) => listTasks(ctx));
  bot.command("digest", async (ctx) => {
    const text = await buildDigest(db, ctx.from!.id, ctx.appUser!.role, tz);
    await ctx.reply(text);
  });

  // --- Клиенты ---
  bot.command("clients", async (ctx) => {
    const text = await buildClientsOverview(db);
    await ctx.reply(text + "\n\nДобавить: /addclient");
  });
  bot.command("client", async (ctx) => {
    const id = parseInt(ctx.match.trim(), 10);
    if (!id) {
      await ctx.reply("Использование: /client <номер>. Список — /clients");
      return;
    }
    const c = await db.getClient(id);
    if (!c) {
      await ctx.reply("Клиент не найден.");
      return;
    }
    await ctx.reply(clientCard(c), { ...HTML, reply_markup: clientActions(c.id) });
  });
  bot.command("addclient", async (ctx) => {
    if (!ctx.appUser || ctx.appUser.role === ROLE_CLIENT) {
      await ctx.reply("Добавлять клиентов может только команда.");
      return;
    }
    await db.setState(ctx.from!.id, { step: "addclient_name" });
    await ctx.reply("Название клиента / проекта? («отмена» — прервать)");
  });

  // --- Заметки ---
  bot.command("notes", async (ctx) => {
    const notes = await db.listNotes(ctx.from!.id);
    if (!notes.length) {
      await ctx.reply(
        "Заметок пока нет.\nСовет: пришли сообщение, начав с «!» — сохраню как заметку.\nНапример: <code>!идея: тест креативов для VK</code>",
        HTML
      );
      return;
    }
    const lines = ["📝 Последние заметки:\n"];
    for (const n of notes) lines.push(`#${n.id} · ${escapeHtml(n.text)}${n.tags ? `  🏷 ${n.tags}` : ""}`);
    lines.push("\nУдалить: /delnote <номер>   Поиск: /findnote <слово>");
    await ctx.reply(lines.join("\n"), HTML);
  });
  bot.command("findnote", async (ctx) => {
    const q = ctx.match.trim();
    if (!q) {
      await ctx.reply("Использование: /findnote <слово>");
      return;
    }
    const notes = await db.searchNotes(ctx.from!.id, q);
    if (!notes.length) {
      await ctx.reply(`По запросу «${q}» ничего не нашёл.`);
      return;
    }
    const lines = [`🔍 Найдено (${notes.length}):\n`];
    for (const n of notes) lines.push(`#${n.id} · ${escapeHtml(n.text)}`);
    await ctx.reply(lines.join("\n"), HTML);
  });
  bot.command("delnote", async (ctx) => {
    const id = parseInt(ctx.match.trim(), 10);
    if (!id) {
      await ctx.reply("Использование: /delnote <номер>");
      return;
    }
    await db.deleteNote(id, ctx.from!.id);
    await ctx.reply("🗑 Заметка удалена (если была твоей).");
  });
  bot.command("note", async (ctx) => {
    const payload = ctx.match.trim();
    if (payload) {
      const id = await db.addNote(ctx.from!.id, payload, extractTags(payload));
      await ctx.reply("📝 Сохранил.", { reply_markup: new InlineKeyboard().text("🗑 Удалить заметку", `note:del:${id}`) });
      return;
    }
    await db.setState(ctx.from!.id, { step: "note_text" });
    await ctx.reply("Напиши заметку одним сообщением. (можно с #тегами)");
  });

  // --- ИИ ---
  bot.command("ai", async (ctx) => {
    const prompt = ctx.match.trim();
    if (!prompt) {
      await ctx.reply("Использование: /ai <запрос>\nПример: /ai напиши объявление для Авито: ремонт ноутбуков");
      return;
    }
    await replyAI(ctx, prompt);
  });
  bot.command("doc", async (ctx) => {
    const desc = ctx.match.trim();
    if (!desc) {
      await ctx.reply("Использование: /doc <что нужно>\nПример: /doc коммерческое предложение по настройке Яндекс Директ");
      return;
    }
    await makeAndSendDoc(ctx, desc);
  });
  bot.command("stop", async (ctx) => {
    await db.clearState(ctx.from!.id);
    await ctx.reply("Вышел из режима ИИ. Меню внизу 👇", { reply_markup: mainMenu(origin) });
  });
  bot.command("foodexport", async (ctx) => {
    const days = Math.min(31, Math.max(1, parseInt(ctx.match.trim(), 10) || 7));
    const tz = Number(env.TZ_OFFSET ?? 3) || 3;
    const status = await ctx.reply(`📄 Собираю дневник питания за ${days} дн…`);
    const parts: string[] = [];
    for (let o = -(days - 1); o <= 0; o++) {
      const t = await buildNutritionSummary(db, ctx.from!.id, tz, o);
      if (t.includes("Итого:")) parts.push(t);
    }
    try { await ctx.api.deleteMessage(ctx.chat!.id, status.message_id); } catch {}
    if (!parts.length) { await ctx.reply("За выбранный период нет записей о питании."); return; }
    const bytes = buildDocx(`Дневник питания — ${days} дн.`, parts.join("\n\n———\n\n"));
    await ctx.replyWithDocument(new InputFile(bytes, "Дневник питания.docx"), { caption: "📄 Дневник питания" });
  });
  bot.command("foodreport", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const off = /сегодня/.test(arg) ? 0 : -1;
    const tz = Number(env.TZ_OFFSET ?? 3) || 3;
    const text = await buildNutritionSummary(db, ctx.from!.id, tz, off);
    await ctx.reply(text + "\n\n↪️ Перешли это сообщение тренеру.");
  });
  bot.command("report", async (ctx) => {
    const name = ctx.match.trim();
    if (!name) { await ctx.reply("Использование: /report <клиент>\nПример: /report Ромашка"); return; }
    const client = await db.findClientByName(name);
    if (!client) { await ctx.reply(`Клиент «${name}» не найден.`); return; }
    await sendMetrikaReport(ctx, client);
  });
  bot.command("telemost", async (ctx) => {
    if (ctx.from!.id !== ownerId) return;
    const code = ctx.match.trim();
    if (!code) {
      await ctx.reply("Подключение Телемоста:\n1) Открой ссылку /telemost/auth (см. инструкцию), войди Яндексом.\n2) Пришли код: /telemost <код с экрана Яндекса>");
      return;
    }
    try {
      await telemostExchangeCode(env, db, code);
      await ctx.reply("✅ Телемост подключён! При создании встречи можно добавить ссылку на видеовстречу.");
    } catch (e) {
      await ctx.reply("Не удалось подключить Телемост: " + (e as Error).message);
    }
  });

  // --- Владелец: пользователи ---
  bot.command("users", async (ctx) => {
    if (ctx.appUser?.role !== ROLE_OWNER) {
      await ctx.reply("Команда доступна только владельцу.");
      return;
    }
    const [members, clients, pending] = [
      await db.listUsers(ROLE_MEMBER),
      await db.listUsers(ROLE_CLIENT),
      await db.listUsers(ROLE_PENDING),
    ];
    const lines = ["👥 Пользователи\n", "Владелец: ты"];
    if (members.length) {
      lines.push("\n🧑‍💼 Команда:");
      members.forEach((u) => lines.push(`  ${userDisplay(u)} — /kick ${u.user_id}`));
    }
    if (clients.length) {
      lines.push("\n👤 Клиенты:");
      clients.forEach((u) => lines.push(`  ${userDisplay(u)} — /kick ${u.user_id}`));
    }
    if (pending.length) {
      lines.push("\n⏳ Ожидают:");
      pending.forEach((u) => lines.push(`  ${userDisplay(u)} — ID ${u.user_id}`));
    }
    if (!members.length && !clients.length && !pending.length) {
      lines.push("\nПока только ты. Дай доступ команде — пусть напишут боту /start.");
    }
    await ctx.reply(lines.join("\n"));
  });
  bot.command("kick", async (ctx) => {
    if (ctx.appUser?.role !== ROLE_OWNER) {
      await ctx.reply("Команда доступна только владельцу.");
      return;
    }
    const uid = parseInt(ctx.match.trim(), 10);
    if (!uid) {
      await ctx.reply("Использование: /kick <ID пользователя>");
      return;
    }
    if (uid === ownerId) {
      await ctx.reply("Нельзя удалить владельца.");
      return;
    }
    await db.deleteUser(uid);
    await ctx.reply(`Пользователь ${uid} удалён из доступа.`);
  });

  // --- Callback-и задач ---
  bot.callbackQuery(/^task:(done|progress|reopen|del):(\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const id = parseInt(ctx.match![2], 10);
    const task = await db.getTask(id);
    if (!task) {
      await ctx.answerCallbackQuery({ text: "Задача не найдена.", show_alert: true });
      await ctx.editMessageReplyMarkup();
      return;
    }
    if (action === "del") {
      await db.deleteTask(id);
      await ctx.editMessageText(`🗑 Задача #${id} удалена.`);
      await ctx.answerCallbackQuery({ text: "Удалено" });
      return;
    }
    const map: Record<string, string> = { done: TASK_DONE, progress: TASK_IN_PROGRESS, reopen: TASK_OPEN };
    await db.setTaskStatus(id, map[action]);
    const updated = (await db.getTask(id))!;
    const client = updated.client_id ? await db.getClient(updated.client_id) : null;
    await ctx.editMessageText(taskLine(updated, client?.name ?? null, tz), { ...HTML, reply_markup: taskActions(id, updated.status) });
    await ctx.answerCallbackQuery({ text: action === "done" ? "Готово ✅" : "Обновлено" });
  });

  // Привязка задачи к клиенту (шаг создания)
  bot.callbackQuery(/^taskclient:(none|\d+)$/, async (ctx) => {
    const state = await db.getState(ctx.from!.id);
    if (state.step !== "addtask_client") {
      await ctx.answerCallbackQuery();
      return;
    }
    const draft = (state.draft ?? {}) as { title: string; due: string | null };
    const clientId = ctx.match![1] === "none" ? null : parseInt(ctx.match![1], 10);
    const taskId = await db.addTask({
      title: draft.title,
      creatorId: ctx.from!.id,
      assigneeId: ctx.from!.id,
      clientId,
      dueAt: draft.due,
    });
    await db.clearState(ctx.from!.id);
    const dueTxt = formatDue(draft.due, tz);
    let suffix = dueTxt ? `\nДедлайн: ${dueTxt}` : "";
    if (clientId) {
      const c = await db.getClient(clientId);
      if (c) suffix += `\nКлиент: ${c.name}`;
    }
    await ctx.editMessageText(`✅ Задача #${taskId} создана: ${escapeHtml(draft.title)}${suffix}`);
    await ctx.answerCallbackQuery({ text: "Готово" });
  });

  // --- Callback-и клиентов ---
  bot.callbackQuery(/^plat:(toggle|done):?(\w+)?$/, async (ctx) => {
    const state = await db.getState(ctx.from!.id);
    if (state.step !== "addclient_platforms") {
      await ctx.answerCallbackQuery();
      return;
    }
    const draft = (state.draft ?? { name: "", platforms: [] }) as { name: string; platforms: string[] };
    if (ctx.match![1] === "toggle") {
      const key = ctx.match![2]!;
      draft.platforms = draft.platforms.includes(key)
        ? draft.platforms.filter((p) => p !== key)
        : [...draft.platforms, key];
      await db.setState(ctx.from!.id, { step: "addclient_platforms", draft });
      await ctx.editMessageReplyMarkup({ reply_markup: platformsPicker(draft.platforms) });
      await ctx.answerCallbackQuery();
      return;
    }
    // done
    await db.setState(ctx.from!.id, { step: "addclient_budget", draft });
    await ctx.editMessageText(`Площадки: ${platformsToText(draft.platforms.join(","))}`);
    await ctx.reply("Месячный бюджет? (например «50 000 ₽» или «-»)");
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^client:(tasks|togglestatus|del|delconfirm|delcancel):(\d+)$/, async (ctx) => {
    const action = ctx.match![1];
    const id = parseInt(ctx.match![2], 10);
    const c = await db.getClient(id);
    if (!c) {
      await ctx.answerCallbackQuery({ text: "Клиент не найден.", show_alert: true });
      return;
    }
    if (action === "tasks") {
      const tasks = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], clientId: id });
      if (!tasks.length) await ctx.reply(`У «${c.name}» нет активных задач.`);
      else {
        const lines = [`📋 Задачи «${c.name}»:\n`];
        for (const t of tasks) {
          const due = formatDue(t.due_at, tz);
          lines.push(`  #${t.id} ${t.title}${due ? ` — ${due}` : ""}`);
        }
        await ctx.reply(lines.join("\n"));
      }
    } else if (action === "togglestatus") {
      await db.updateClientStatus(id, c.status === "active" ? "paused" : "active");
      const updated = (await db.getClient(id))!;
      await ctx.editMessageText(clientCard(updated), { ...HTML, reply_markup: clientActions(id) });
    } else if (action === "del") {
      await ctx.editMessageText(`Удалить клиента «${c.name}»? Задачи останутся, но отвяжутся.`, {
        reply_markup: new InlineKeyboard().text("✅ Да, удалить", `client:delconfirm:${id}`).text("Отмена", `client:delcancel:${id}`),
      });
    } else if (action === "delconfirm") {
      await db.deleteClient(id);
      await ctx.editMessageText(`🗑 Клиент «${c.name}» удалён.`);
    } else if (action === "delcancel") {
      await ctx.editMessageText(clientCard(c), { ...HTML, reply_markup: clientActions(id) });
    }
    await ctx.answerCallbackQuery();
  });

  // --- Callback удаления заметки ---
  bot.callbackQuery(/^note:del:(\d+)$/, async (ctx) => {
    await db.deleteNote(parseInt(ctx.match![1], 10), ctx.from!.id);
    await ctx.editMessageText("🗑 Заметка удалена.");
    await ctx.answerCallbackQuery({ text: "Удалено" });
  });

  // --- Свободный текст: шаги FSM, заметки, кнопки меню, ИИ ---
  // Голосовые сообщения: распознаём речь и создаём задачу (или отвечаем в режиме ИИ)
  // Фото еды → оценка калорий/БЖУ и запись в дневник
  bot.on("message:photo", async (ctx) => {
    if (!env.ANTHROPIC_API_KEY) { await ctx.reply("ИИ не настроен."); return; }
    const status = await ctx.reply("📷 Оцениваю блюдо по фото…");
    const done = async (t: string) => { try { await ctx.api.editMessageText(ctx.chat!.id, status.message_id, t, HTML); } catch { await ctx.reply(t, HTML); } };
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      if (!file.file_path) throw new Error("нет файла");
      const buf = await (await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`)).arrayBuffer();
      const caption = ctx.message.caption ?? "";
      const n = await estimateNutritionFromImage(env.ANTHROPIC_API_KEY, bytesToBase64(buf), "image/jpeg", caption);
      if (!n) { await done("Не смогла распознать еду на фото 🤔 Опиши текстом — например «съел борщ с хлебом»."); return; }
      const tz = Number(env.TZ_OFFSET ?? 3) || 3;
      const meal = mealFromText(caption) || mealByHour(new Date(Date.now() + tz * 3600_000).getUTCHours());
      const mealRu: Record<string, string> = { breakfast: "завтрак", lunch: "обед", dinner: "ужин", snack: "перекус" };
      await db.addFood(ctx.from!.id, { ...n, meal });
      await done(`🍽 Записала (${mealRu[meal]}) по фото: <b>${escapeHtml(n.title)}</b>\n🔥 ${n.kcal} ккал · Б ${n.protein} · Ж ${n.fat} · У ${n.carbs} г`);
    } catch (e) {
      await done("⚠️ Не удалось обработать фото: " + escapeHtml((e as Error).message));
    }
  });

  bot.on("message:voice", async (ctx) => {
    if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) {
      await ctx.reply("Голосовой ввод не настроен: добавь YANDEX_API_KEY и YANDEX_FOLDER_ID.");
      return;
    }
    const status = await ctx.reply("🎧 Слушаю голосовое…");
    const finish = async (text: string, extra: any = {}) => {
      try {
        return await ctx.api.editMessageText(ctx.chat!.id, status.message_id, text, extra);
      } catch {
        return await ctx.reply(text, extra);
      }
    };

    let transcript = "";
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("нет файла");
      const audio = await (await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`)).arrayBuffer();
      transcript = await transcribeVoice(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, audio);
    } catch (e) {
      const msg = (e as Error).message || "";
      const hint = /403|permission|forbidden|unauthorized|denied/i.test(msg)
        ? "\n\nПохоже, у сервисного аккаунта нет прав на распознавание речи. Добавь ему роль <b>ai.speechkit-stt.user</b> в Yandex Cloud."
        : "";
      await finish(`⚠️ Не удалось распознать голос: ${escapeHtml(msg)}${hint}`, HTML);
      return;
    }
    if (!transcript) {
      await finish("🤷 Не расслышал. Попробуй записать ещё раз, ближе к микрофону (до 30 секунд).");
      return;
    }

    // Сначала пробуем выполнить команду (задача/встреча/контакт/клиент).
    // В режиме ИИ не форсируем задачу — вопрос уйдёт в чат; вне режима голос всегда что-то создаёт.
    const state = await db.getState(ctx.from!.id);
    const aiMode = state.step === "ai_mode";
    const action = await tryPerformCommand(env, db, ctx.from!.id, transcript, !aiMode);
    if (action) {
      await finish(`🎤 Распознал: «${escapeHtml(transcript)}»\n\n${action}`, HTML);
      return;
    }
    // Не команда — в режиме ИИ отвечаем как в чате
    await finish(`🎤 «${escapeHtml(transcript)}»`, HTML);
    if (aiMode) return replyAI(ctx, transcript);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const state = await db.getState(ctx.from!.id);
    const step = state.step as string | undefined;

    if (step) return handleStep(ctx, step, state, text);

    if (text.startsWith("!")) {
      const body = text.slice(1).trim();
      if (!body) {
        await ctx.reply("Пустая заметка. Напиши текст после «!».");
        return;
      }
      const id = await db.addNote(ctx.from!.id, body, extractTags(body));
      await ctx.reply("📝 Сохранил заметку.", { reply_markup: new InlineKeyboard().text("🗑 Удалить заметку", `note:del:${id}`) });
      return;
    }

    switch (text) {
      case BTN_ADD_TASK: return startAddTask(ctx);
      case BTN_TASKS: return listTasks(ctx);
      case BTN_CLIENTS: {
        const t = await buildClientsOverview(db);
        await ctx.reply(t + "\n\nДобавить: /addclient");
        return;
      }
      case BTN_NOTES: return ctx.reply("Заметки: /notes\nБыстро сохранить — пришли текст с «!» в начале.");
      case BTN_DIGEST: {
        const t = await buildDigest(db, ctx.from!.id, ctx.appUser!.role, tz);
        await ctx.reply(t);
        return;
      }
      case BTN_HELP: return ctx.reply(HELP_TEXT, HTML);
      case BTN_AI: {
        if (!env.ANTHROPIC_API_KEY) {
          await ctx.reply("ИИ-помощник не настроен. Добавь ANTHROPIC_API_KEY, чтобы включить.");
          return;
        }
        await db.setState(ctx.from!.id, { step: "ai_mode" });
        await ctx.reply(
          "🤖 Режим ИИ включён.\nСпрашивай что угодно по маркетингу — напишу объявления, офферы, идеи.\nВыйти — «стоп» или /stop."
        );
        return;
      }
      default:
        await ctx.reply("Не понял. Открой меню кнопками или /help.");
    }
  });

  // ===== Вспомогательные обработчики шагов =====

  async function startAddTask(ctx: MyContext) {
    await db.setState(ctx.from!.id, { step: "addtask_title" });
    await ctx.reply("Что нужно сделать? Напиши название задачи.\n(«отмена» — прервать)");
  }

  async function listTasks(ctx: MyContext) {
    const role = ctx.appUser!.role;
    const assignee = role === ROLE_OWNER ? null : ctx.from!.id;
    const tasks = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], assigneeId: assignee });
    if (!tasks.length) {
      await ctx.reply("Активных задач нет. Добавь через «➕ Задача» или открой «📲 Приложение».");
      return;
    }
    await ctx.reply(`📋 Активные задачи: ${tasks.length}`);
    for (const t of tasks.slice(0, 12)) {
      const client = t.client_id ? await db.getClient(t.client_id) : null;
      await ctx.reply(taskLine(t, client?.name ?? null, tz), { ...HTML, reply_markup: taskActions(t.id, t.status) });
    }
    if (tasks.length > 12) await ctx.reply(`…и ещё ${tasks.length - 12}. Полный список — в приложении «📲».`);
  }

  async function replyAI(ctx: MyContext, prompt: string) {
    if (!env.ANTHROPIC_API_KEY) {
      await ctx.reply("ИИ-помощник не настроен. Добавь ANTHROPIC_API_KEY, чтобы включить.");
      return;
    }
    const thinking = await ctx.reply("💭 Думаю…");
    const answer = await askAI(env.ANTHROPIC_API_KEY, prompt, env.ANTHROPIC_MODEL ?? DEFAULT_MODEL);
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id);
    } catch {}
    for (const chunk of splitText(answer)) await ctx.reply(chunk);
  }

  async function makeAndSendDoc(ctx: MyContext, request: string) {
    if (!env.ANTHROPIC_API_KEY) {
      await ctx.reply("ИИ не настроен. Добавь ANTHROPIC_API_KEY, чтобы формировать документы.");
      return;
    }
    const thinking = await ctx.reply("📝 Готовлю документ…");
    const content = await askAI(
      env.ANTHROPIC_API_KEY,
      `Составь готовый деловой документ по запросу: "${request}". ` +
        `Первая строка — краткий заголовок документа. Далее — содержание. ` +
        `Обычный текст (без markdown-разметки, без ** и #), абзацы — с новой строки.`,
      env.ANTHROPIC_MODEL ?? DEFAULT_MODEL
    );
    try { await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id); } catch {}
    if (content.startsWith("⚠️")) { await ctx.reply(content); return; }
    const lines = content.split(/\r?\n/);
    const title = (lines[0] || "Документ").trim().slice(0, 60);
    const body = lines.slice(1).join("\n").trim() || content;
    const bytes = buildDocx(title, body);
    const fname = (title.replace(/[^\wа-яё0-9 -]/gi, "").trim() || "Документ") + ".docx";
    await ctx.replyWithDocument(new InputFile(bytes, fname), { caption: "Готово ✅ Можно открыть в Word и при необходимости экспортировать в PDF." });
  }

  const DOC_RE = /(сделай|сформируй|подготовь|состав|напиши|сгенерируй)[^.]*(документ|файл|ворд|word|docx|\.doc|коммерческ|\bкп\b|договор|бриф|отч[её]т в ворд)/i;
  const REPORT_RE = /(отч[её]т|статистик|метрик|посещаемост|трафик|сколько.*(визит|посет))/i;

  function metrikaReportText(name: string, r: MetrikaReport, date1: string, date2: string): { tg: string; body: string } {
    const dur = `${Math.floor(r.avgDuration / 60)} мин ${r.avgDuration % 60} сек`;
    const lines = [
      `Период: ${date1} — ${date2}`,
      "",
      `Визиты: ${r.visits}`,
      `Посетители: ${r.users}`,
      `Просмотры страниц: ${r.pageviews}`,
      `Отказы: ${r.bounceRate}%`,
      `Среднее время на сайте: ${dur}`,
    ];
    if (r.sources.length) {
      lines.push("", "Источники трафика:");
      r.sources.forEach((s) => lines.push(`• ${s.name}: ${s.visits}`));
    }
    const body = lines.join("\n");
    return { tg: `📊 Отчёт Метрики — ${name}\n\n${body}`, body };
  }

  async function sendMetrikaReport(ctx: MyContext, client: { name: string; metrika_counter: string }) {
    if (!client.metrika_counter) {
      await ctx.reply(`У клиента «${client.name}» не указан счётчик Метрики. Добавь его в карточке клиента (приложение → Клиенты → Изменить).`);
      return;
    }
    const status = await ctx.reply("📊 Собираю отчёт Метрики за 30 дней…");
    const tz = Number(env.TZ_OFFSET ?? 3) || 3;
    const nowL = new Date(Date.now() + tz * 3600_000);
    const ymd = (dt: Date) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    const date2 = ymd(nowL);
    const date1 = ymd(new Date(nowL.getTime() - 29 * 86400_000));
    try {
      const r = await metrikaStats(env, db, client.metrika_counter, date1, date2);
      const { tg, body } = metrikaReportText(client.name, r, date1, date2);
      try { await ctx.api.editMessageText(ctx.chat!.id, status.message_id, tg); } catch { await ctx.reply(tg); }
      const bytes = buildDocx(`Отчёт Метрики — ${client.name}`, body);
      await ctx.replyWithDocument(new InputFile(bytes, `Отчёт ${client.name}.docx`.replace(/[^\wа-яё0-9 .-]/gi, "")));
    } catch (e) {
      const msg = (e as Error).message || "";
      const hint = /не подключ/i.test(msg) ? "\n\nПодключи Яндекс в приложении: Календарь → «Подключить Телемост» (тот же вход даёт и Метрику)." : "";
      try { await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `⚠️ Не удалось собрать отчёт: ${msg}${hint}`); } catch { await ctx.reply(`⚠️ ${msg}`); }
    }
  }

  async function handleStep(ctx: MyContext, step: string, state: Record<string, unknown>, text: string) {
    const low = text.toLowerCase();
    if (low === "отмена" && step !== "ai_mode") {
      await db.clearState(ctx.from!.id);
      await ctx.reply("Отменил.");
      return;
    }

    if (step === "addtask_title") {
      await db.setState(ctx.from!.id, { step: "addtask_deadline", draft: { title: text.trim() } });
      await ctx.reply("Когда дедлайн?\nСловами: «завтра», «пятница», «через 3 дня», «15.03 14:00». Или «-» без дедлайна.");
      return;
    }
    if (step === "addtask_deadline") {
      const due = parseDue(text, tz);
      if (due === null && !["-", "нет", "без"].includes(low.trim())) {
        await ctx.reply("Не понял дату. Попробуй «завтра», «15.03», «через 2 дня» или «-» без дедлайна.");
        return;
      }
      const draft = { ...(state.draft as object), due };
      await db.setState(ctx.from!.id, { step: "addtask_client", draft });
      const clients = await db.listClients();
      const kb = new InlineKeyboard().text("Без клиента", "taskclient:none").row();
      clients.filter((c) => c.status === "active").slice(0, 20).forEach((c) => kb.text(c.name, `taskclient:${c.id}`).row());
      await ctx.reply("Привязать к клиенту?", { reply_markup: kb });
      return;
    }
    if (step === "addclient_name") {
      await db.setState(ctx.from!.id, { step: "addclient_platforms", draft: { name: text.trim(), platforms: [] } });
      await ctx.reply("Какие площадки ведём? Отметь нужные и нажми «Готово».", { reply_markup: platformsPicker([]) });
      return;
    }
    if (step === "addclient_budget") {
      const draft = state.draft as { name: string; platforms: string[] };
      const budget = ["-", "нет"].includes(low.trim()) ? "" : text.trim();
      await db.setState(ctx.from!.id, { step: "addclient_contact", draft: { ...draft, budget } });
      await ctx.reply("Контакт клиента? (телефон/@ник/email или «-»)");
      return;
    }
    if (step === "addclient_contact") {
      const draft = state.draft as { name: string; platforms: string[]; budget: string };
      const contact = ["-", "нет"].includes(low.trim()) ? "" : text.trim();
      const id = await db.addClient(draft.name, [...draft.platforms].sort().join(","), draft.budget ?? "", { contact });
      await db.clearState(ctx.from!.id);
      const c = (await db.getClient(id))!;
      await ctx.reply("✅ Клиент добавлен:\n\n" + clientCard(c), HTML);
      return;
    }
    if (step === "note_text") {
      await db.clearState(ctx.from!.id);
      const id = await db.addNote(ctx.from!.id, text.trim(), extractTags(text));
      await ctx.reply("📝 Сохранил.", { reply_markup: new InlineKeyboard().text("🗑 Удалить заметку", `note:del:${id}`) });
      return;
    }
    if (step === "ai_mode") {
      if (["стоп", "stop", "выход", "отмена"].includes(low)) {
        await db.clearState(ctx.from!.id);
        await ctx.reply("Вышел из режима ИИ. Меню внизу 👇", { reply_markup: mainMenu(origin) });
        return;
      }
      // Сводка по питанию (для тренера)
      if (/(сводк|отч[её]т)[^.]{0,25}(пита|еде|калор)|питани[ея]\s+за\s+(вчера|сегодня)|тренеру/i.test(text)) {
        const off = /сегодня/i.test(text) ? 0 : -1;
        const tz = Number(env.TZ_OFFSET ?? 3) || 3;
        const summary = await buildNutritionSummary(db, ctx.from!.id, tz, off);
        await ctx.reply(summary + "\n\n↪️ Перешли это сообщение тренеру.");
        return;
      }
      // Запрос отчёта по клиенту → сводка Метрики
      if (REPORT_RE.test(text)) {
        const clients = await db.listClients();
        const low2 = text.toLowerCase();
        const client = clients.find((c) => c.name && low2.includes(c.name.toLowerCase()));
        if (client) return sendMetrikaReport(ctx, client);
        // клиент не распознан — пусть ответит ИИ (уточнит, по кому отчёт)
      }
      // Запрос на файл/документ → формируем .docx
      if (DOC_RE.test(text)) return makeAndSendDoc(ctx, text);
      // Сначала пробуем выполнить команду; если это не команда — отвечаем как в чате
      const action = await tryPerformCommand(env, db, ctx.from!.id, text, false);
      if (action) {
        await ctx.reply(action);
        return;
      }
      await replyAI(ctx, text);
      return;
    }
  }

  function clientCard(c: { id: number; name: string; status: string; platforms: string; budget: string; contact: string; notes: string }): string {
    const status = c.status === "active" ? "🟢 активен" : "⏸ на паузе";
    const lines = [`<b>#${c.id} ${escapeHtml(c.name)}</b>`, `Статус: ${status}`, `Площадки: ${platformsToText(c.platforms)}`];
    if (c.budget) lines.push(`Бюджет: ${escapeHtml(c.budget)}`);
    if (c.contact) lines.push(`Контакт: ${escapeHtml(c.contact)}`);
    if (c.notes) lines.push(`Заметки: ${escapeHtml(c.notes)}`);
    return lines.join("\n");
  }

  bot.catch((err) => console.error("Bot error:", err));
  return bot;
}

function splitText(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  }
  if (current) chunks.push(current);
  return chunks;
}
