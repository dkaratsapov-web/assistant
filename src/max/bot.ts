/**
 * Обработчик обновлений MAX Bot API. Переиспользует ту же бизнес-логику и БД (D1),
 * что и Telegram-бот: задачи, встречи, клиенты, заметки, здоровье, ИИ (YandexGPT).
 *
 * Аккаунты MAX независимы от Telegram: пользователь получает внутренний uid из
 * своего диапазона (см. ids.ts), поэтому у него собственные задачи, календарь и
 * здоровье. Исключение — владелец: если задан MAX_OWNER_ID, его сообщения пишутся
 * под OWNER_ID, чтобы данные владельца в обоих мессенджерах оставались общими.
 *
 * Доступ такой же, как в Telegram: новый пользователь попадает в `pending`,
 * владелец подтверждает роль кнопкой.
 */
import { aiConfig, askAIChat, ChatMessage } from "../ai";
import { DB } from "../db";
import { tryPerformCommand } from "../intent";
import { buildDigest } from "../reports";
import { transcribeVoice } from "../speech";
import {
  Env,
  ROLE_CLIENT,
  ROLE_MEMBER,
  ROLE_OWNER,
  ROLE_PENDING,
  SCOPE_WORK,
  TASK_DONE,
  TASK_IN_PROGRESS,
  TASK_OPEN,
  TASK_STATUS_LABELS,
  User,
} from "../types";
import { formatDue, parseDue, tzOffsetOf } from "../utils";
import { CHANNEL_MAX, maxUid } from "./ids";
import { MaxButton, MaxClient, MaxUpdate } from "./client";

const HELP = `🤖 Сара — команды в MAX:

/tasks — активные задачи
/addtask <текст> — новая задача (пример: /addtask Позвонить клиенту завтра 15:00)
/digest — сводка на сегодня
/app — открыть приложение (задачи, календарь, здоровье)
/code — код для входа в приложение
/id — узнать свой ID в MAX
/ai <запрос> — спросить ИИ
/help — помощь

Можно просто писать словами: «напомни завтра отправить отчёт», «встреча с клиентом
в пятницу в 15:00», «съел борщ», «выпил 300 мл». Голосовые тоже понимаю.
Быстрая заметка — сообщение, начатое с «!».`;

/** Меню бота. Ссылка на приложение выдаётся персонально — её собирает handleMaxUpdate. */
function mainMenu(appButtons: MaxButton[]): MaxButton[][] {
  const rows: MaxButton[][] = [
    [
      { type: "callback", text: "✅ Задачи", payload: "menu:tasks" },
      { type: "callback", text: "📊 Сводка", payload: "menu:digest" },
    ],
    [{ type: "callback", text: "🤖 Спросить ИИ", payload: "menu:ai" }],
  ];
  if (appButtons.length) rows.push(appButtons);
  return rows;
}

function taskButtons(id: number): MaxButton[][] {
  return [
    [
      { type: "callback", text: "✅ Готово", payload: `task_done:${id}` },
      { type: "callback", text: "🗑 Удалить", payload: `task_del:${id}` },
    ],
  ];
}

/** Кнопки подтверждения доступа — приходят владельцу. */
function accessButtons(maxId: number): MaxButton[][] {
  return [
    [
      { type: "callback", text: "✅ В команду", payload: `access:member:${maxId}` },
      { type: "callback", text: "👤 Клиент", payload: `access:client:${maxId}` },
    ],
    [{ type: "callback", text: "🚫 Отказать", payload: `access:reject:${maxId}` }],
  ];
}

/** Извлекает унифицированные поля из разных типов апдейтов MAX. */
function extract(update: MaxUpdate): {
  senderId?: number;
  chatId?: number;
  text?: string;
  name?: string;
  username?: string;
  audioUrl?: string;
  callbackId?: string;
  callbackPayload?: string;
} {
  if (update.update_type === "bot_started") {
    return { senderId: update.user?.user_id, chatId: update.chat_id, name: update.user?.name, username: update.user?.username };
  }
  if (update.update_type === "message_callback") {
    return {
      senderId: update.callback?.user?.user_id,
      chatId: update.message?.recipient?.chat_id,
      name: update.callback?.user?.name,
      username: update.callback?.user?.username,
      callbackId: update.callback?.callback_id,
      callbackPayload: update.callback?.payload,
    };
  }
  const audio = (update.message?.body?.attachments ?? []).find((a) => a.type === "audio");
  return {
    senderId: update.message?.sender?.user_id,
    chatId: update.message?.recipient?.chat_id,
    text: update.message?.body?.text,
    name: update.message?.sender?.name,
    username: update.message?.sender?.username,
    audioUrl: audio?.payload?.url,
  };
}

export async function handleMaxUpdate(update: MaxUpdate, env: Env, appUrl?: string): Promise<void> {
  if (!env.MAX_BOT_TOKEN) return;
  const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
  const db = new DB(env.DB);
  const tz = tzOffsetOf(env);
  const ai = aiConfig(env);

  const { senderId, chatId, text, name, username, audioUrl, callbackId, callbackPayload } = extract(update);
  if (!senderId && !chatId) return;
  const reply = (t: string, kb?: MaxButton[][]) =>
    client.sendMessage({ chatId: chatId ?? undefined, userId: chatId ? undefined : senderId }, t, kb);

  // Узнать свой user_id — доступно всем: нужно для MAX_OWNER_ID и для приглашений
  if (["/id", "/whoami", "/whois", "id"].includes((text ?? "").trim().toLowerCase())) {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    return void (await reply(`Твой ID в MAX: ${senderId}\n\nПередай его владельцу — он выдаст доступ.`).catch(() => {}));
  }
  if (!senderId) return;

  // ---------- Пользователь и доступ ----------
  // id владельца в MAX: из переменной окружения либо из настроек (задаётся в админке)
  const ownerMax = parseInt(env.MAX_OWNER_ID || (await db.getSetting("max_owner_id")) || "0", 10);
  const isOwnerMax = !!ownerMax && senderId === ownerMax;
  // Владелец в MAX работает с данными владельца Telegram, остальные — со своими
  const uid = isOwnerMax ? parseInt(env.OWNER_ID, 10) : maxUid(senderId);

  let user: User;
  if (isOwnerMax) {
    await db.ensureOwner(uid);
    user = (await db.getUser(uid))!;
  } else {
    user = await db.ensureChannelUser(uid, CHANNEL_MAX, senderId, username ?? null, name ?? null);
  }

  const isOwner = user.role === ROLE_OWNER;

  // Заявка на доступ: новичок ждёт подтверждения владельца
  if (user.role === ROLE_PENDING) {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    if (!ownerMax) {
      await reply("🔒 Бот ещё не настроен: не задан владелец (MAX_OWNER_ID). Подтвердить доступ пока некому.").catch(() => {});
      return;
    }
    await reply("⏳ Заявка на доступ отправлена владельцу. Как только подтвердит — всё заработает.").catch(() => {});
    {
      const who = [name, username ? `@${username}` : "", `id ${senderId}`].filter(Boolean).join(" · ");
      await client
        .sendMessage({ userId: ownerMax }, `🔐 Запрос доступа в MAX:\n${who}`, accessButtons(senderId))
        .catch(() => {});
    }
    return;
  }

  /** Кнопки открытия Mini App: персональная ссылка с токеном сессии. */
  async function appButtons(): Promise<MaxButton[]> {
    if (!appUrl) return [];
    const token = await db.webSessionFor(uid);
    const link = `${appUrl}?max=${token}`;
    const buttons: MaxButton[] = [];
    // Если мини-приложение зарегистрировано в кабинете MAX — открываем внутри мессенджера
    if (env.MAX_APP_NAME) buttons.push({ type: "open_app", text: "📲 Открыть", web_app: env.MAX_APP_NAME, payload: token });
    buttons.push({ type: "link", text: buttons.length ? "🔗 В браузере" : "📲 Открыть приложение", url: link });
    buttons.push({ type: "callback", text: "🔑 Код входа", payload: "login:code" });
    return buttons;
  }

  // ===== Callback-кнопки =====
  if (callbackPayload) {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    const [action, arg, arg2] = callbackPayload.split(":");

    if (action === "access") {
      if (!isOwner) return;
      const targetMax = parseInt(arg2, 10);
      const targetUid = maxUid(targetMax);
      if (arg === "reject") {
        await db.deleteUser(targetUid);
        await reply("🚫 Отказано в доступе.");
        await client.sendMessage({ userId: targetMax }, "🚫 Владелец отклонил заявку на доступ.").catch(() => {});
        return;
      }
      const role = arg === "client" ? ROLE_CLIENT : ROLE_MEMBER;
      await db.setRole(targetUid, role);
      await reply(`✅ Доступ выдан (${role === ROLE_CLIENT ? "клиент" : "команда"}).`);
      await client
        .sendMessage({ userId: targetMax }, "✅ Доступ открыт! Напиши /help или просто скажи, что нужно сделать.", mainMenu(await appButtons()))
        .catch(() => {});
      return;
    }
    if (action === "login" && arg === "code") return sendLoginCode();
    if (action === "menu") {
      if (arg === "tasks") return listTasks();
      if (arg === "digest") return sendDigest();
      if (arg === "ai") {
        await db.setState(uid, { step: "ai_mode" });
        return void (await reply("🤖 Режим ИИ включён. Спрашивай что угодно. Выход — «стоп»."));
      }
      if (arg === "help") return void (await reply(HELP));
    }
    if (action === "task_done") {
      const ok = await db.setTaskStatus(parseInt(arg, 10), TASK_DONE, uid);
      return void (await reply(ok ? `✅ Задача #${arg} закрыта.` : "Не нашла такую задачу."));
    }
    if (action === "task_del") {
      const ok = await db.deleteTask(parseInt(arg, 10), uid);
      return void (await reply(ok ? `🗑 Задача #${arg} удалена.` : "Не нашла такую задачу."));
    }
    return;
  }

  // ===== bot_started =====
  if (update.update_type === "bot_started") {
    return void (await reply(
      "👋 Привет! Я Сара — твой ИИ-ассистент.\nСтавь задачи словами или голосом, а приложение откроет календарь, клиентов и здоровье.",
      mainMenu(await appButtons())
    ));
  }

  // ===== Голосовое сообщение =====
  let raw = (text ?? "").trim();
  if (!raw && audioUrl) {
    if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) {
      return void (await reply("Голосовой ввод не настроен: добавь YANDEX_API_KEY и YANDEX_FOLDER_ID."));
    }
    try {
      const audio = await (await fetch(audioUrl)).arrayBuffer();
      raw = (await transcribeVoice(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, audio)).trim();
    } catch (e) {
      return void (await reply(`⚠️ Не удалось распознать голос: ${(e as Error).message}`));
    }
    if (!raw) return void (await reply("🤷 Не расслышала. Попробуй записать ещё раз, поближе к микрофону."));
    await reply(`🎤 «${raw}»`);
  }
  if (!raw) return;
  const low = raw.toLowerCase();

  // Режим ИИ (FSM по внутреннему uid)
  const state = await db.getState(uid);
  const aiMode = state.step === "ai_mode";
  if (aiMode && (low === "стоп" || low === "/stop")) {
    await db.clearState(uid);
    return void (await reply("Вышла из режима ИИ.", mainMenu(await appButtons())));
  }

  // Быстрая заметка
  if (raw.startsWith("!")) {
    const noteText = raw.slice(1).trim();
    if (noteText) {
      const id = await db.addNote(uid, noteText);
      return void (await reply(`📝 Заметка сохранена (#${id}).`));
    }
  }

  // Команды
  const [cmd, ...rest] = raw.split(/\s+/);
  const argText = rest.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "/start":
    case "начать":
      return void (await reply("👋 Сара на связи. Выбери действие:", mainMenu(await appButtons())));
    case "/help":
      return void (await reply(HELP));
    case "/app": {
      const buttons = await appButtons();
      if (!buttons.length) return void (await reply("Адрес приложения не определён."));
      return void (await reply("📲 Приложение: задачи, календарь, клиенты и здоровье.", [buttons]));
    }
    case "/stop":
      await db.clearState(uid);
      return void (await reply("Ок, вышла из режима ИИ.", mainMenu(await appButtons())));
    case "/code":
      return sendLoginCode();
    case "/tasks":
      return listTasks();
    case "/digest":
      return sendDigest();
    case "/users":
      return listUsers();
    case "/addtask": {
      if (!argText) return void (await reply("Напиши текст задачи: /addtask <что сделать> [когда]"));
      const dueAt = parseDue(argText, tz);
      const id = await db.addTask({ title: argText, creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt });
      return void (await reply(`✅ Задача #${id} создана.${dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : ""}`, taskButtons(id)));
    }
    case "/ai": {
      if (!argText) {
        await db.setState(uid, { step: "ai_mode" });
        return void (await reply("🤖 Режим ИИ включён. Спрашивай что угодно. Выход — «стоп»."));
      }
      return replyAI(argText);
    }
    default: {
      // Свободный текст: сначала пробуем выполнить команду, иначе отвечает Сара
      const action = await tryPerformCommand(env, db, uid, raw, false);
      if (action) return void (await reply(action));
      return replyAI(raw);
    }
  }

  // ===== helpers =====
  async function listTasks() {
    const tasks = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], visibleTo: uid });
    if (!tasks.length) return void (await reply("Активных задач нет. Добавь: /addtask <текст>"));
    await reply(`📋 Активные задачи: ${tasks.length}`);
    for (const t of tasks.slice(0, 15)) {
      const due = formatDue(t.due_at, tz);
      const status = TASK_STATUS_LABELS[t.status] ?? "";
      await reply(`#${t.id} ${t.title}${due ? `\n⏰ ${due}` : ""}\n${status}`, taskButtons(t.id));
    }
  }

  /** Код для входа в мини-приложение, когда оно открыто кнопкой MAX (без персональной ссылки). */
  async function sendLoginCode() {
    const code = await db.createLoginCode(uid);
    await reply(`🔑 Код для входа в приложение:\n\n${code}\n\nВведи его в окне «Нужен вход». Код действует 10 минут и работает один раз.`);
  }

  async function sendDigest() {
    await reply(await buildDigest(db, uid, user.role, tz));
  }

  async function listUsers() {
    if (!isOwner) return void (await reply("Команда доступна владельцу."));
    const users = await db.listUsers();
    const lines = users.map((u) => {
      const who = u.full_name || u.username || String(u.ext_id ?? u.user_id);
      return `${u.role === ROLE_OWNER ? "👑" : u.role === ROLE_MEMBER ? "🧑‍💻" : u.role === ROLE_CLIENT ? "👤" : "⏳"} ${who} — ${u.role} (${u.channel ?? "tg"})`;
    });
    return void (await reply(lines.length ? `Пользователи:\n${lines.join("\n")}` : "Пользователей нет."));
  }

  async function replyAI(prompt: string) {
    if (!ai) return void (await reply("ИИ не настроен: добавь YANDEX_API_KEY и YANDEX_FOLDER_ID."));
    await reply("💭 Думаю…");
    const history = await db.listAiMessages(uid, 20);
    const pctx = await db.profileContext(uid);
    const msgs: ChatMessage[] = [
      ...(pctx ? [{ role: "system" as const, text: pctx }] : []),
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", text: m.content })),
      { role: "user", text: prompt },
    ];
    const answer = await askAIChat(ai, msgs);
    await db.addAiMessage(uid, "user", prompt);
    await db.addAiMessage(uid, "assistant", answer);
    // MAX ограничивает длину сообщения — режем на части
    for (let i = 0; i < answer.length; i += 3800) await reply(answer.slice(i, i + 3800));
  }
}
