/**
 * Обработчик обновлений MAX Bot API. Переиспользует ту же бизнес-логику и БД (D1),
 * что и Telegram-бот: задачи, дайджест, ИИ (YandexGPT).
 *
 * На старте канал работает в режиме одного владельца (MAX_OWNER_ID). Данные общие
 * с Telegram: действия владельца в MAX пишутся под тем же OWNER_ID, поэтому список
 * задач и календарь одинаковы в обоих мессенджерах. Мультиарендность и роли для
 * MAX добавим на этапе подписок.
 */
import { askAI } from "../ai";
import { DB } from "../db";
import { buildDigest } from "../reports";
import {
  Env,
  SCOPE_WORK,
  TASK_DONE,
  TASK_IN_PROGRESS,
  TASK_OPEN,
  TASK_STATUS_LABELS,
} from "../types";
import { formatDue, parseDue, tzOffsetOf } from "../utils";
import { MaxButton, MaxClient, MaxUpdate } from "./client";

const HELP = `🤖 Sara — команды в MAX:

/tasks — активные задачи
/addtask <текст> — новая задача (пример: /addtask Позвонить клиенту завтра 15:00)
/digest — сводка на сегодня
/ai <запрос> — спросить ИИ по маркетингу
/help — помощь

Быстрая заметка — сообщение, начатое с «!».`;

function mainMenu(appUrl?: string): MaxButton[][] {
  const rows: MaxButton[][] = [
    [
      { type: "callback", text: "✅ Задачи", payload: "menu:tasks" },
      { type: "callback", text: "📊 Сводка", payload: "menu:digest" },
    ],
    [{ type: "callback", text: "🤖 Спросить ИИ", payload: "menu:ai" }],
  ];
  if (appUrl) rows.push([{ type: "link", text: "📲 Открыть приложение", url: appUrl }]);
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

/** Извлекает унифицированные поля из разных типов апдейтов MAX. */
function extract(update: MaxUpdate): {
  senderId?: number;
  chatId?: number;
  text?: string;
  callbackId?: string;
  callbackPayload?: string;
} {
  if (update.update_type === "bot_started") {
    return { senderId: update.user?.user_id, chatId: update.chat_id };
  }
  if (update.update_type === "message_callback") {
    return {
      senderId: update.callback?.user?.user_id,
      chatId: update.message?.recipient?.chat_id,
      callbackId: update.callback?.callback_id,
      callbackPayload: update.callback?.payload,
    };
  }
  // message_created и прочие с message
  return {
    senderId: update.message?.sender?.user_id,
    chatId: update.message?.recipient?.chat_id,
    text: update.message?.body?.text,
  };
}

export async function handleMaxUpdate(update: MaxUpdate, env: Env, appUrl?: string): Promise<void> {
  if (!env.MAX_BOT_TOKEN) return;
  const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
  const db = new DB(env.DB);
  const tz = tzOffsetOf(env);

  const { senderId, chatId, text, callbackId, callbackPayload } = extract(update);
  if (!chatId && !senderId) return;
  const reply = (t: string, kb?: MaxButton[][]) =>
    client.sendMessage({ chatId: chatId ?? undefined, userId: chatId ? undefined : senderId }, t, kb);

  // /whoami — доступно всем: помогает узнать свой user_id для MAX_OWNER_ID
  if ((text ?? "").trim().toLowerCase() === "/whoami") {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    return void (await reply(`Твой MAX user_id: ${senderId}`).catch(() => {}));
  }

  // Доступ: пока только владелец (общие данные с Telegram под OWNER_ID)
  const ownerMax = parseInt(env.MAX_OWNER_ID ?? "0", 10);
  if (!ownerMax || senderId !== ownerMax) {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    await reply("🔒 Доступ ограничен. Бот сейчас работает в приватном режиме.").catch(() => {});
    return;
  }
  const owner = parseInt(env.OWNER_ID, 10); // эффективный владелец данных

  // ===== Callback-кнопки =====
  if (callbackPayload) {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    const [action, arg] = callbackPayload.split(":");
    if (action === "menu") {
      if (arg === "tasks") return listTasks();
      if (arg === "digest") return sendDigest();
      if (arg === "ai") {
        await db.setState(senderId!, { step: "ai_mode" });
        return void (await reply("🤖 Режим ИИ включён. Спрашивай по маркетингу. Выход — «стоп»."));
      }
      if (arg === "help") return void (await reply(HELP));
    }
    if (action === "task_done") {
      await db.setTaskStatus(parseInt(arg, 10), TASK_DONE);
      return void (await reply(`✅ Задача #${arg} закрыта.`));
    }
    if (action === "task_del") {
      await db.deleteTask(parseInt(arg, 10));
      return void (await reply(`🗑 Задача #${arg} удалена.`));
    }
    return;
  }

  // ===== bot_started =====
  if (update.update_type === "bot_started") {
    return void (await reply(
      "👋 Привет! Я Sara — твой ИИ-ассистент.\nВыбери действие или напиши /help.",
      mainMenu(appUrl)
    ));
  }

  const raw = (text ?? "").trim();
  if (!raw) return;
  const low = raw.toLowerCase();

  // Режим ИИ (FSM по senderId — не пересекается с Telegram)
  const state = await db.getState(senderId!);
  if (state.step === "ai_mode") {
    if (low === "стоп" || low === "/stop") {
      await db.clearState(senderId!);
      return void (await reply("Вышел из режима ИИ.", mainMenu(appUrl)));
    }
    return replyAI(raw);
  }

  // Быстрая заметка
  if (raw.startsWith("!")) {
    const noteText = raw.slice(1).trim();
    if (noteText) {
      await db.addNote(owner, noteText);
      return void (await reply("📝 Заметка сохранена."));
    }
  }

  // Команды
  const [cmd, ...rest] = raw.split(/\s+/);
  const argText = rest.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "/start":
    case "начать":
      return void (await reply("👋 Sara на связи. Выбери действие:", mainMenu(appUrl)));
    case "/help":
      return void (await reply(HELP));
    case "/tasks":
      return listTasks();
    case "/digest":
      return sendDigest();
    case "/addtask": {
      if (!argText) return void (await reply("Напиши текст задачи: /addtask <что сделать> [когда]"));
      const dueAt = parseDue(argText, tz);
      const id = await db.addTask({
        title: argText,
        creatorId: owner,
        assigneeId: owner,
        scope: SCOPE_WORK,
        dueAt,
      });
      return void (await reply(
        `✅ Задача #${id} создана.${dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : ""}`,
        taskButtons(id)
      ));
    }
    case "/ai": {
      if (!argText) {
        await db.setState(senderId!, { step: "ai_mode" });
        return void (await reply("🤖 Режим ИИ включён. Спрашивай по маркетингу. Выход — «стоп»."));
      }
      return replyAI(argText);
    }
    default:
      return void (await reply("Не понял команду. Открой меню или /help.", mainMenu(appUrl)));
  }

  // ===== helpers =====
  async function listTasks() {
    const tasks = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], assigneeId: null });
    if (!tasks.length) return void (await reply("Активных задач нет. Добавь: /addtask <текст>"));
    await reply(`📋 Активные задачи: ${tasks.length}`);
    for (const t of tasks.slice(0, 15)) {
      const due = formatDue(t.due_at, tz);
      const status = TASK_STATUS_LABELS[t.status] ?? "";
      await reply(`#${t.id} ${t.title}${due ? `\n⏰ ${due}` : ""}\n${status}`, taskButtons(t.id));
    }
  }

  async function sendDigest() {
    const text = await buildDigest(db, owner, "owner", tz);
    await reply(text);
  }

  async function replyAI(prompt: string) {
    if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) {
      return void (await reply("ИИ не настроен: добавь YANDEX_API_KEY и YANDEX_FOLDER_ID."));
    }
    await reply("💭 Думаю…");
    const answer = await askAI(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, prompt, env.YANDEX_MODEL ?? "yandexgpt/latest");
    // MAX ограничивает длину сообщения — режем на части
    for (let i = 0; i < answer.length; i += 3800) await reply(answer.slice(i, i + 3800));
  }
}
