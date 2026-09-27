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
import { aiConfig, askAIChat, ChatMessage, estimateNutritionFromImage, visionEnabled } from "../ai";
import { lookupWeb } from "../search";
import { DB } from "../db";
import { MEAL_RU, tryPerformCommand } from "../intent";
import { buildDigest } from "../reports";
import { sttKey, transcribeVoice } from "../speech";
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
import { formatDue, mealByHour, mealFromText, parseDue, tzOffsetOf } from "../utils";
import {
  onboardingAnswer,
  onboardingDone,
  onboardingStart,
  onboardingState,
  OnbQuestion,
} from "../onboarding";
import { bytesToBase64 } from "../utils";
import { CHANNEL_MAX, maxUid } from "./ids";
import { MaxButton, MaxClient, MaxUpdate } from "./client";

const HELP = `🤖 Сара — команды в MAX:

/tasks — активные задачи
/addtask <текст> — новая задача (пример: /addtask Позвонить клиенту завтра 15:00)
/digest — сводка на сегодня
/app — открыть приложение (задачи, календарь, здоровье)
/id — узнать свой ID в MAX
/setup — пройти знакомство заново
/ai <запрос> — спросить ИИ
/help — помощь

Пришли фото тарелки — посчитаю калории по нему.

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

/** Вопрос брифинга: текст с прогрессом и кнопки вариантов. */
function onbView(q: OnbQuestion): { text: string; keyboard?: MaxButton[][] } {
  const rows: MaxButton[][] = [];
  if (q.options?.length) {
    for (let i = 0; i < q.options.length; i += 2) {
      rows.push(q.options.slice(i, i + 2).map((o) => ({ type: "callback" as const, text: o.label, payload: `onb:${o.value}` })));
    }
  }
  if (q.skippable) rows.push([{ type: "callback", text: "Пропустить", payload: "onb:" }]);
  return { text: `${q.block}\n\n${q.text}`, keyboard: rows.length ? rows : undefined };
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
  imageUrl?: string;
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
  const attachments = update.message?.body?.attachments ?? [];
  const audio = attachments.find((a) => a.type === "audio");
  // фото еды: в MAX вложение приходит ссылкой, забираем её и отдаём модели
  const image = attachments.find((a) => a.type === "image" || a.type === "photo");
  return {
    senderId: update.message?.sender?.user_id,
    chatId: update.message?.recipient?.chat_id,
    text: update.message?.body?.text,
    name: update.message?.sender?.name,
    username: update.message?.sender?.username,
    audioUrl: audio?.payload?.url,
    imageUrl: image?.payload?.url,
  };
}

export async function handleMaxUpdate(update: MaxUpdate, env: Env, appUrl?: string): Promise<void> {
  if (!env.MAX_BOT_TOKEN) return;
  const client = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
  const db = new DB(env.DB);
  const tz = tzOffsetOf(env);
  const ai = aiConfig(env);

  const { senderId, chatId, text, name, username, audioUrl, imageUrl, callbackId, callbackPayload } = extract(update);
  if (!senderId && !chatId) return;
  const reply = async (t: string, kb?: MaxButton[][]) => {
    const to = { chatId: chatId ?? undefined, userId: chatId ? undefined : senderId };
    try {
      return await client.sendMessage(to, t, kb);
    } catch (e) {
      // Платформа может отклонить кнопку мини-приложения. Сообщение важнее кнопки:
      // убираем спорный ряд и отправляем снова, а не теряем ответ целиком.
      const safe = (kb ?? []).filter((row) => !row.some((b) => b.type === "open_app"));
      if (kb && safe.length !== kb.length) {
        await db.setSetting("max_kb_button", "").catch(() => {});
        return await client.sendMessage(to, t, safe.length ? safe : undefined);
      }
      throw e;
    }
  };

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
  /**
   * Кнопки приложения. Платформа может не принять open_app — тогда отваливается
   * только она, а рабочие кнопки (ссылка и код) остаются: сообщение без единой
   * кнопки хуже, чем без одной.
   */
  /**
   * Кнопка приложения для обычных меню. Берём ту форму, которую платформа уже приняла:
   * иначе одно отклонённое вложение уронило бы всё сообщение.
   */
  async function appButtons(): Promise<MaxButton[]> {
    const sets = await appButtonSets();
    const okRaw = await db.getSetting("max_kb_button");
    if (okRaw != null) {
      if (!okRaw) return sets[sets.length - 1]; // платформа не принимает open_app — только ссылка
      try {
        const saved = JSON.parse(okRaw) as MaxButton;
        const match = sets.find((set) => set[0] && set[0].type === "open_app" && sameAppButton(set[0], saved));
        if (match) return match;
      } catch {
        // настройка испортилась — падаем на общий путь
      }
    }
    return sets[0];
  }

  /** Совпадение по форме ссылки на мини-приложение: токен в payload у них разный. */
  function sameAppButton(a: MaxButton, b: MaxButton): boolean {
    return a.web_app === b.web_app && a.contact_id === b.contact_id;
  }

  /** Варианты клавиатуры от полной к простой — пробуем по очереди. */
  async function appButtonSets(): Promise<MaxButton[][]> {
    if (!appUrl) return [[]];
    const token = await db.webSessionFor(uid);
    // запасной путь — та же личная ссылка, вход по ней тоже без кода
    const base: MaxButton[] = [{ type: "link", text: "📲 Открыть приложение", url: `${appUrl}/app?max=${token}` }];

    // open_app открывает приложение внутри мессенджера и передаёт токен в payload.
    // Какую именно ссылку на мини-приложение ждёт MAX — зависит от настроек бота,
    // поэтому перебираем все разумные формы: имя из настроек, логин бота, URL, id бота.
    const me = await maxMe();
    const candidates: MaxButton[] = [];
    const seen = new Set<string>();
    const addApp = (b: MaxButton) => {
      const key = JSON.stringify(b);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(b);
    };
    const uname = me?.username?.replace(/^@/, "");
    if (env.MAX_APP_NAME) addApp({ type: "open_app", text: "📲 Открыть", web_app: env.MAX_APP_NAME, payload: token });
    if (uname) {
      addApp({ type: "open_app", text: "📲 Открыть", web_app: uname, payload: token });
      addApp({ type: "open_app", text: "📲 Открыть", web_app: `@${uname}`, payload: token });
    }
    if (appUrl) addApp({ type: "open_app", text: "📲 Открыть", web_app: appUrl, payload: token });
    if (me?.user_id) addApp({ type: "open_app", text: "📲 Открыть", contact_id: me.user_id, payload: token });

    // одна кнопка на сообщение: запасная ссылка нужна, только если open_app не принят
    const variants: MaxButton[][] = candidates.map((b) => [b]);
    variants.push(base);
    return variants;
  }

  /**
   * Отправляет сообщение с кнопками приложения, перебирая варианты сверху вниз.
   * Текст ошибки платформы сохраняем — по нему видно, почему open_app не принят.
   */
  async function replyWithApp(text: string): Promise<void> {
    const sets = await appButtonSets();
    const to = { chatId: chatId ?? undefined, userId: chatId ? undefined : senderId };
    const errors: string[] = [];
    for (let i = 0; i < sets.length; i++) {
      const label = describeAppButton(sets[i][0]);
      try {
        await client.sendMessage(to, text, sets[i].length ? [sets[i]] : undefined);
        await db.setSetting("max_kb_used", `${i + 1} из ${sets.length} — ${label}`);
        const winner = sets[i][0];
        await db.setSetting("max_kb_button", winner && winner.type === "open_app" ? JSON.stringify(winner) : "");
        if (errors.length) await db.setSetting("max_kb_error", `${new Date().toISOString()}\n${errors.join("\n")}`);
        else await db.setSetting("max_kb_error", "");
        return;
      } catch (e) {
        errors.push(`${label}: ${String((e as Error).message).slice(0, 200)}`);
      }
    }
    await db.setSetting("max_kb_error", `${new Date().toISOString()}\n${errors.join("\n")}`);
    await client.sendMessage(to, text).catch(() => {});
  }

  /** Человеческое имя варианта клавиатуры — чтобы отказ платформы было с чем сопоставить. */
  function describeAppButton(b: MaxButton | undefined): string {
    if (!b || b.type !== "open_app") return "только ссылка";
    if (b.contact_id) return `open_app contact_id=${b.contact_id}`;
    return `open_app web_app=${b.web_app}`;
  }

  /** Карточка бота в MAX — нужна кнопке open_app; спрашиваем один раз и держим в настройках. */
  async function maxMe(): Promise<{ user_id: number; username?: string } | null> {
    const cachedId = parseInt((await db.getSetting("max_bot_id")) ?? "", 10);
    const cachedName = (await db.getSetting("max_bot_username")) ?? "";
    // «-» означает «спросили, логина нет» — иначе ходили бы в API на каждый /app
    if (cachedId && cachedName) return { user_id: cachedId, username: cachedName === "-" ? undefined : cachedName };
    try {
      const me = await client.getMe();
      if (me?.user_id) {
        await db.setSetting("max_bot_id", String(me.user_id));
        await db.setSetting("max_bot_username", me.username || "-");
        return { user_id: me.user_id, username: me.username };
      }
    } catch {
      // не критично: останется ссылка в браузер
    }
    return null;
  }

  /** Один ход брифинга: применяем ответ и задаём следующий вопрос. */
  async function onbStep(answer: string): Promise<void> {
    const st = onboardingState(await db.getState(uid));
    if (!st) return;
    const r = await onboardingAnswer(db, uid, st, answer, tz);
    if (r.reply) await reply(r.reply);
    if (r.question) {
      const v = onbView(r.question);
      await reply(v.text, v.keyboard);
    } else if (r.summary) {
      await reply(r.summary, mainMenu(await appButtons()));
    }
  }

  // ===== Callback-кнопки =====
  if (callbackPayload) {
    if (callbackId) await client.answerCallback(callbackId).catch(() => {});
    if (callbackPayload.startsWith("onb:")) return onbStep(callbackPayload.slice(4));
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
        .sendMessage({ userId: targetMax }, "Готово, доступ открыт. Напиши мне «привет» — познакомимся за минуту, и я подстроюсь под тебя.")
        .catch(() => {});
      return;
    }
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
      const ok = await db.setTaskStatus(parseInt(arg, 10), TASK_DONE, uid, tz);
      return void (await reply(ok ? `✅ Задача закрыта.` : "Не нашла такую задачу."));
    }
    if (action === "task_del") {
      const ok = await db.deleteTask(parseInt(arg, 10), uid);
      return void (await reply(ok ? `🗑 Задача удалена.` : "Не нашла такую задачу."));
    }
    return;
  }

  // ===== bot_started =====
  if (update.update_type === "bot_started") {
    if (!(await onboardingDone(db, uid))) {
      await reply("Привет! Я Сара — помню дела за тебя, напоминаю вовремя и считаю калории, если нужно.\n\nПознакомимся за минуту — несколько коротких вопросов, любой можно пропустить.");
      const q = await onboardingStart(db, uid);
      const v = onbView(q);
      return void (await reply(v.text, v.keyboard));
    }
    return void (await reply("Привет! Что нужно не забыть?", mainMenu(await appButtons())));
  }

  // ===== Фото еды =====
  if (imageUrl) {
    if (!ai) return void (await reply("ИИ не настроен: добавь YANDEX_API_KEY и YANDEX_FOLDER_ID."));
    if (!visionEnabled(ai)) {
      return void (await reply("📷 Счёт калорий по фото ещё дорабатываю — скоро включу.\n\nПока опиши блюдо словами или наговори голосовое: «съел борщ с хлебом» — посчитаю не хуже."));
    }
    await reply("📷 Смотрю, что на тарелке…");
    try {
      const resp = await fetch(imageUrl);
      const bytes = await resp.arrayBuffer();
      const mediaType = resp.headers.get("content-type") || "image/jpeg";
      const caption = (text ?? "").trim();
      const n = await estimateNutritionFromImage(ai, bytesToBase64(bytes), mediaType, caption);
      if (!n) return void (await reply("Не смогла разобрать еду на фото 🤔 Опиши словами — посчитаю."));
      const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
      const meal = mealFromText(caption) || mealByHour(localHour);
      await db.addFood(uid, { ...n, meal });
      return void (await reply(`🍽 Записала (${MEAL_RU[meal]}) по фото: ${n.title}\n🔥 ${n.kcal} ккал · Б ${n.protein} · Ж ${n.fat} · У ${n.carbs} г`));
    } catch (e) {
      return void (await reply(`⚠️ Не получилось обработать фото: ${(e as Error).message}`));
    }
  }

  // ===== Голосовое сообщение =====
  let raw = (text ?? "").trim();
  if (!raw && audioUrl) {
    if (!sttKey(env) || !env.YANDEX_FOLDER_ID) {
      return void (await reply("Голосовой ввод не настроен: добавь YANDEX_API_KEY и YANDEX_FOLDER_ID."));
    }
    try {
      const audio = await (await fetch(audioUrl)).arrayBuffer();
      raw = (await transcribeVoice(sttKey(env), env.YANDEX_FOLDER_ID, audio)).trim();
    } catch (e) {
      return void (await reply(`⚠️ Не удалось распознать голос: ${(e as Error).message}`));
    }
    if (!raw) return void (await reply("🤷 Не расслышала. Попробуй записать ещё раз, поближе к микрофону."));
    await reply(`🎤 «${raw}»`);
  }
  if (!raw) return;
  const low = raw.toLowerCase();

  // Идёт брифинг — любой текст и голос считаем ответом на текущий вопрос
  if (onboardingState(await db.getState(uid)) && !/^\/(start|help|setup|id)/i.test(raw)) {
    return onbStep(raw);
  }

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
      return void (await reply(`📝 Заметка сохранена.`));
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
    case "/app":
      return replyWithApp("📲 Приложение: задачи, календарь, клиенты и здоровье.");
    case "/stop":
      await db.clearState(uid);
      return void (await reply("Ок, вышла из режима ИИ.", mainMenu(await appButtons())));
    case "/setup": {
      const q = await onboardingStart(db, uid);
      const v = onbView(q);
      return void (await reply(v.text, v.keyboard));
    }
    case "/diag":
      return sendDiag();
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
      return void (await reply(`✅ Задача создана.${dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : ""}`, taskButtons(id)));
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

  /** Короткий отчёт о том, почему кнопка «Открыть» могла не появиться. */
  async function sendDiag() {
    if (!isOwner) return void (await reply("Команда доступна владельцу."));
    const me = await maxMe();
    const lines = [
      "🩺 Диагностика MAX",
      `бот: id ${me?.user_id ?? "—"}, логин ${me?.username ?? "—"}`,
      `адрес приложения: ${appUrl || "не задан"}`,
      `MAX_APP_NAME: ${env.MAX_APP_NAME || "не задан"}`,
      `сработал вариант клавиатуры: ${(await db.getSetting("max_kb_used")) ?? "первый"}`,
      `последний отказ платформы:\n${(await db.getSetting("max_kb_error")) || "нет"}`,
      await bridgeLine(),
      await clientErrorsLine(),
      `поля подписи мини-приложения: ${(await db.getSetting("max_initdata_keys")) || "не приходила"}`,
    ];
    return void (await reply(lines.join("\n")));
  }

  /** Последние падения приложения у людей — приходят с их устройств сами. */
  async function clientErrorsLine(): Promise<string> {
    const raw = await db.getSetting("client_errors");
    if (!raw) return "падений приложения: нет";
    const lines = raw.split("\n").filter(Boolean);
    return `падений приложения: ${lines.length}\n  ${lines[0].slice(0, 220)}`;
  }

  /** Что мессенджер передал мини-приложению при последнем запуске — ключ к входу без кода. */
  async function bridgeLine(): Promise<string> {
    const at = await db.getSetting("bridge_report_at");
    if (!at) return "запуск приложения: отчётов ещё не было";
    let r: Record<string, unknown> = {};
    try {
      r = JSON.parse((await db.getSetting("bridge_report")) || "{}") as Record<string, unknown>;
    } catch {
      return `запуск приложения: ${at}, отчёт нечитаем`;
    }
    const sp = typeof r.startParam === "string" ? r.startParam : "";
    const initData = typeof r.initData === "string" ? r.initData : "";
    const bridges = r.bridges && typeof r.bridges === "object" ? Object.keys(r.bridges as object) : [];
    const params = r.params && typeof r.params === "object" ? Object.keys(r.params as object) : [];
    return [
      `запуск приложения: ${at}`,
      `  токен из кнопки: ${sp ? `есть, ${sp.length} симв.` : "НЕ ПРИШЁЛ"}`,
      `  подпись мини-приложения: ${initData ? `есть, ${initData.length} симв.` : "нет"}`,
      `  мосты: ${bridges.length ? bridges.join(", ") : "не найдены"}`,
      `  параметры адреса: ${params.length ? params.join(", ") : "нет"}`,
    ].join("\n");
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
    const persona = await db.personaContext(uid);
    const found = await lookupWeb(env, db, uid, prompt);
    const msgs: ChatMessage[] = [
      { role: "system" as const, text: persona },
      ...(found ? [{ role: "system" as const, text: found }] : []),
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
