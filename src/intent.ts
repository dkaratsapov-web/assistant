/**
 * Единая логика «ассистент выполняет команду»: распознаёт намерение (задача/встреча/контакт)
 * и создаёт запись в БД. Используется и в Mini App (/api/ai), и в боте (текст/голос),
 * чтобы поведение было одинаковым.
 */
import { aiConfig, AssistantIntent, estimateBurn, estimateNutrition, parseTaskFromText, routeAssistant } from "./ai";
import { DB } from "./db";
import { answerQuery, parseQuery } from "./queries";
import { parseAppearance, renderPrefsChange } from "./appearance";
import { CLIENT_FIELD_RU, hasFields, parseClientFields, parseTaskFields } from "./cards";
import { Env, Event, SCOPE_PERSONAL, SCOPE_WORK, Task, TASK_DONE, TASK_FAILED, TASK_IN_PROGRESS, TASK_OPEN } from "./types";
import { spellTitle } from "./spell";
import { tidyName, tidyTitle, formatDue, formatEventTime, matchWaterMl, mealByHour, mealFromText, nowContext, parseWaterMl, resolveWhen, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf, parseRepeat, repeatLabel, bestMatch, keyWords, isTimeWord, splitWhen, guessScope, stripClientName, WB_END, WB_START, wordRe } from "./utils";

export const MEAL_RU: Record<string, string> = { breakfast: "завтрак", lunch: "обед", dinner: "ужин", snack: "перекус" };

const FOOD_RE = /(съел[а-яё]*|поел[а-яё]*|скушал[а-яё]*|позавтракал[а-яё]*|пообедал[а-яё]*|поужинал[а-яё]*|перекусил[а-яё]*|на завтрак|на обед|на ужин|съесть)/i;

/** «добавь в еду», «запиши в рацион», «посчитай калории» — прямая просьба записать приём пищи. */
const FOOD_ADD_RE = /(?:добав[а-яё]*|запиш[а-яё]*|занес[а-яё]*|внес[а-яё]*|учт[а-яё]*|посчита[а-яё]*|подсчита[а-яё]*|расcчита[а-яё]*|рассчита[а-яё]*|плюс)[^.!?]{0,20}?\s(?:в\s+)?(?:еду|еде|ед[ыу]|рацион[а-яё]*|питани[а-яё]+|калори[а-яё]+|ккал|бжу)/i;

/** Похоже ли сообщение на запись еды. Вынесено отдельно — на этом месте ошибались. */
export function looksLikeFoodText(text: string): boolean {
  // «напомни купить еду», «встреча в обед», «добавь задачу» — это не про питание
  if (/(встреч|созвон|задач|клиент|напомни|перезвон|позвон|заплан|купи)/i.test(text)) return false;
  if (FOOD_ADD_RE.test(text)) return true;
  if (FOOD_RE.test(text)) return true;
  const hasMealWord = /(завтрак|обед|ужин|перекус|полдник)/i.test(text);
  return hasMealWord && /(добав|запиш|плюс|учти|засчита|занеси|внеси)/i.test(text);
}

/**
 * Ищет в тексте упоминание своего клиента: «встреча с айпапа» → карточка «АйПапа».
 * Короткие имена пропускаем — иначе «АП» найдётся в середине любого слова.
 */
export function mentionedClient<T extends { id: number; name: string }>(clients: T[], text: string): T | null {
  const low = text.toLowerCase();
  // «Ромашка» в тексте встретится как «ромашке» — сравниваем по основе слова
  const stem = (w: string) => w.replace(/[аяуюыиеёоэьъ]{1,2}$/i, "");
  let best: T | null = null;
  let bestLen = 0;
  for (const c of clients) {
    const n = (c.name || "").trim().toLowerCase();
    if (n.length < 3) continue;
    const st = stem(n);
    const hit = low.includes(n) ? n.length : st.length >= 4 && low.includes(st) ? st.length : 0;
    if (hit > bestLen) { best = c; bestLen = hit; }   // длиннее совпадение — точнее
  }
  return best;
}

/** Выполняет распознанное намерение. Возвращает подтверждение или null (если это не команда). */
export async function performIntent(
  intent: AssistantIntent | null,
  db: DB,
  uid: number,
  tz: number,
  rawText = ""
): Promise<string | null> {
  if (!intent || intent.action === "none") return null;
  // Копия в локальной переменной: разбор иногда уточняется по ходу — например,
  // «перенеси на пятницу» может относиться ко встрече, а не к задаче.
  let cmd: AssistantIntent = intent;

  /**
   * Чей это клиент. Сначала верим ИИ (он мог вытащить имя), иначе ищем имя
   * своего клиента прямо в исходной фразе: «встреча с айпапа» → карточка «АйПапа».
   */
  /** Что Сара только что создала: нужно, если человек скажет «не то, это еда». */
  const remember = async (kind: string, id: number) => {
    if (!rawText) return;
    await db.setSetting(`last:${uid}`, JSON.stringify({ phrase: rawText, kind, id }));
  };

  /**
   * Название по-человечески: заглавная буква, знаки, орфография.
   *
   * Голосом всё приходит строчными и без знаков — «созвонится с ромашкой по
   * оплате». В списке это выглядит неряшливо, поэтому правим до записи, чтобы
   * и в подтверждении человек увидел уже грамотный текст.
   */
  const nice = async (text: string): Promise<string> => {
    const t = String(text ?? "").trim();
    if (!t) return t;
    // Свои названия словарь не знает и норовит «исправить» — защищаем их
    return await spellTitle(t, (await db.listClients(uid)).map((c) => c.name));
  };

  const findClient = async (): Promise<{ id: number; name: string } | null> => {
    const named = (cmd.client ?? "").trim();
    if (named) {
      const byName = await db.findClientByName(uid, named);
      if (byName) return byName;
    }
    const where = `${rawText} ${cmd.title ?? ""}`.trim();
    if (!where) return null;
    return mentionedClient(await db.listClients(uid), where);
  };

  /**
   * Ищет СВОЮ активную задачу по словам человека: «закрой задачу про отчёт» →
   * «Сделать отчёт для Ромашки». Поиск одной строкой целиком тут не годится —
   * человек почти никогда не называет задачу ровно так, как она записана.
   *
   * Если одинаково подходят несколько — не угадываем. Закрыть не ту задачу
   * хуже, чем переспросить.
   */
  /**
   * О чём была речь в прошлый раз. Позволяет сказать просто «перенеси на пятницу»
   * сразу после того, как задача создана или упомянута.
   */
  const setFocus = async (kind: "task" | "event", id: number) => {
    await db.setSetting(`focus:${uid}`, JSON.stringify({ kind, id }));
  };
  const getFocusKind = async (): Promise<string | null> => {
    const raw = await db.getSetting(`focus:${uid}`);
    if (!raw) return null;
    try { return (JSON.parse(raw) as { kind?: string }).kind ?? null; } catch { return null; }
  };
  const getFocus = async (kind: "task" | "event"): Promise<number | null> => {
    const raw = await db.getSetting(`focus:${uid}`);
    if (!raw) return null;
    try {
      const f = JSON.parse(raw) as { kind?: string; id?: number };
      return f.kind === kind && f.id ? f.id : null;
    } catch {
      return null;
    }
  };

  /**
   * Названа ли запись вообще. «Перенеси на пятницу» — не названа (остались только
   * слова о времени), «перенеси задачу про молоко» — названа. Разница важна:
   * в первом случае берём то, о чём говорили, во втором честно ищем и можем
   * не найти. Иначе Сара молча меняла бы не ту запись.
   */
  const named = (q: string) => {
    const w = keyWords(q || rawText);
    return w.length > 0 && !w.every(isTimeWord);
  };

  /**
   * `includeClosed` нужен для правок: «верни отчёт в работу» говорят про уже
   * закрытую задачу, и без этого она просто не находилась. Закрытые смотрим
   * только вторым заходом — иначе старая выполненная задача могла бы
   * перебить активную с похожим названием.
   */
  /**
   * Имя клиента для поиска. Нужно потому, что из названия оно теперь вырезается
   * («Встреча с клиентом» вместо «Встреча с клиентом ДиАвто69»), и без этого
   * запись переставала находиться по клиенту: «перенеси встречу с ДиАвто69»
   * отвечало «не нашла».
   */
  let clientNames: Map<number, string> | null = null;
  const searchText = async (title: string, clientId: number | null | undefined): Promise<string> => {
    if (!clientId) return title;
    if (!clientNames) clientNames = new Map((await db.listClients(uid)).map((c) => [c.id, c.name]));
    const name = clientNames.get(clientId);
    return name ? `${title} ${name}` : title;
  };
  /** Записи с добавленным именем клиента — по ним и ищем. */
  const withClient = async <T extends { title: string; client_id?: number | null }>(list: T[]) =>
    Promise.all(list.map(async (x) => ({ item: x, text: await searchText(x.title, x.client_id) })));

  const findTask = async (q: string, includeClosed = false): Promise<{ task: Task | null; ask: string | null }> => {
    const active = await db.listTasks({ visibleTo: uid });
    const closed = includeClosed ? await db.listTasks({ statuses: [TASK_DONE, TASK_FAILED], visibleTo: uid }) : [];
    if (!named(q)) {
      const id = await getFocus("task");
      const prev = id ? [...active, ...closed].find((t) => t.id === id) : null;
      return { task: prev ?? null, ask: null };
    }
    const pool = await withClient(active);
    let { best, rivals } = bestMatch(pool, (x) => x.text, q || rawText);
    if (!best && !rivals.length && closed.length) {
      ({ best, rivals } = bestMatch(await withClient(closed), (x) => x.text, q || rawText));
    }
    if (best) return { task: best.item, ask: null };
    if (rivals.length) {
      const list = rivals.slice(0, 4).map((x) => `«${x.item.title}»`).join(", ");
      return { task: null, ask: `Под это подходит несколько задач: ${list}. Какую именно?` };
    }
    return { task: null, ask: null };
  };

  /** То же самое для встреч. Ищем среди предстоящих — прошедшие переносить незачем. */
  const findEvent = async (q: string): Promise<{ event: Event | null; ask: string | null }> => {
    const events = await db.listEvents(uid, startOfLocalDayIso(tz));
    if (!named(q)) {
      const id = await getFocus("event");
      const prev = id ? events.find((e) => e.id === id) : null;
      return { event: prev ?? null, ask: null };
    }
    const { best, rivals } = bestMatch(await withClient(events), (x) => x.text, q || rawText);
    if (best) return { event: best.item, ask: null };
    if (rivals.length) {
      const list = rivals.slice(0, 4).map((x) => `«${x.item.title}»`).join(", ");
      return { event: null, ask: `Под это подходит несколько встреч: ${list}. Какую именно?` };
    }
    return { event: null, ask: null };
  };

  if (cmd.action === "prefs") {
    const cur = await db.getPrefs(uid);
    const look = parseAppearance(rawText, cur);
    if (look) {
      await db.setPrefs(uid, { ...cur, ...look.changes });
      return renderPrefsChange(look);
    }
    // Модель поняла, что речь о настройках, а мы — какая именно. Честно
    // перечисляем, что умеем, вместо того чтобы менять наугад.
    return [
      "Могу поменять под тебя:",
      "• размер текста — «сделай шрифт крупнее»",
      "• тему — «включи тёмную тему»",
      "• расстановку — «сделай просторнее» / «компактнее»",
      "• картинки и углы — «картинки покрупнее», «углы круглее»",
      "• анимации и вибрацию — «отключи анимации»",
      "• стартовый экран — «открывай сразу задачи»",
      "• разделы меню — «спрячь раздел здоровье»",
      "• обращение — «называй меня Дмитрием», «обращайся на вы»",
      "• моё имя и манеру — «тебя зовут Аня», «отвечай покороче»",
      "",
      "Или скажи «верни настройки по умолчанию».",
    ].join("\n");
  }

  if (cmd.action === "query") {
    // Подробности вопроса разбираем сами: модель уже сказала, что это вопрос
    // о записях, а какие именно записи и за какой срок — надёжнее по словам.
    const ask = parseQuery(rawText, true);
    if (!ask) return null;
    return await answerQuery(db, uid, tz, ask, await findClient());
  }

  if (cmd.action === "task") {
    const title = (cmd.title ?? "").trim();
    if (!title) return null;
    const dueAt = cmd.due ? resolveWhen(cmd.due, tz, 10) : null;
    const scope = cmd.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
    const client = scope === SCOPE_PERSONAL ? null : await findClient();
    // «каждый вторник», «по будням» — задача должна возвращаться сама
    const repeat = parseRepeat(`${rawText} ${title}`);
    // Клиента человек называет, чтобы Сара поняла, о ком речь. В названии он не
    // нужен: рядом и так стоит ярлык с именем, и получается «Отчёт для Ромашки
    // · Ромашка».
    const clean = await nice(client ? stripClientName(title, client.name) : title);
    const id = await db.addTask({ title: clean, creatorId: uid, assigneeId: uid, scope, dueAt, clientId: client?.id ?? null, repeat });
    await remember("task", id);
    await setFocus("task", id);
    const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
    const sc = scope === SCOPE_PERSONAL ? "🙋 Личная" : "💼 Рабочая";
    const cl = client ? `\n🤝 ${client.name}` : "";
    const rp = repeat ? `\n🔁 ${repeatLabel(repeat)}` : "";
    return `✅ Добавила задачу\n«${clean}»\n${sc}${due}${cl}${rp}`;
  }

  if (cmd.action === "task_done") {
    const q = (cmd.title ?? "").trim();
    if (!q && !rawText) return null;
    const { task, ask } = await findTask(q);
    if (ask) return ask;
    if (!task) return `Не нашла активную задачу «${q}».`;
    await db.setTaskStatus(task.id, TASK_DONE, uid, tz);
    await setFocus("task", task.id);
    const again = task.repeat_rule ? `\n🔁 Вернётся: ${repeatLabel(task.repeat_rule)}` : "";
    return `✅ Задача «${task.title}» отмечена выполненной. Молодец!${again}`;
  }

  if (cmd.action === "task_delete") {
    const q = (cmd.title ?? "").trim();
    if (!q) return null;
    const { task, ask } = await findTask(q);
    if (ask) return ask;
    if (!task) return `Не нашла задачу «${q}».`;
    await db.deleteTask(task.id, uid);
    return `🗑 Задача «${task.title}» удалена.`;
  }

  // «Перенеси на пятницу» без названия: речь о том, о чём только что говорили.
  // Если это была встреча — правим встречу, а не ищем несуществующую задачу.
  if (cmd.action === "task_edit" && !named(cmd.title ?? "")) {
    if ((await getFocusKind()) === "event") {
      cmd = { ...cmd, action: "event_edit", at: (cmd.at ?? "") || (cmd.due ?? "") };
    }
  }

  if (cmd.action === "task_edit") {
    const q = (cmd.title ?? "").trim();
    const { task, ask } = await findTask(q, true);
    if (ask) return ask;
    if (!task) return `Не нашла активную задачу${q ? ` «${q}»` : ""}. Скажи пару слов из её названия.`;

    const fields: { title?: string; description?: string; dueAt?: string | null; scope?: string; priority?: number; clientId?: number | null; repeat?: string } = {};
    const done: string[] = [];

    const newTitle = await nice((cmd.new_name ?? "").trim());
    if (newTitle && newTitle.toLowerCase() !== task.title.toLowerCase()) {
      fields.title = newTitle;
      done.push(`название → «${newTitle}»`);
    }

    // «убери срок» надо отличать от «перенеси»: там срок снимают, а не двигают
    if (/(убер[иёи]\w*|сним\w*|без)\s+(срок\w*|дедлайн\w*|дат\w*)/i.test(rawText)) {
      fields.dueAt = null;
      done.push("срок снят");
    } else if ((cmd.due ?? "").trim()) {
      const dueAt = resolveWhen(cmd.due!, tz, 10);
      if (dueAt) {
        fields.dueAt = dueAt;
        done.push(`срок → ${formatDue(dueAt, tz)}`);
      }
    }

    if (cmd.scope === SCOPE_PERSONAL || cmd.scope === SCOPE_WORK) {
      if (cmd.scope !== task.scope) {
        fields.scope = cmd.scope;
        done.push(cmd.scope === SCOPE_PERSONAL ? "стала личной" : "стала рабочей");
      }
    }

    const client = await findClient();
    if (client && client.id !== task.client_id) {
      fields.clientId = client.id;
      done.push(`клиент → ${client.name}`);
    }

    const repeat = parseRepeat(rawText);
    if (repeat && repeat !== (task.repeat_rule ?? "")) {
      fields.repeat = repeat;
      done.push(`повтор → ${repeatLabel(repeat)}`);
    }

    // Внутренности задачи: описание и важность
    const inner = parseTaskFields(rawText);
    if (inner.description) {
      fields.description = await nice(inner.description);
      done.push("описание записано");
    }
    if (inner.priority !== undefined && inner.priority !== task.priority) {
      fields.priority = inner.priority;
      done.push(inner.priority ? "отмечена важной" : "важность снята");
    }

    if (Object.keys(fields).length) await db.updateTask(task.id, fields, uid);

    // Статус меняем отдельно: у него своя логика (повтор, дата выполнения)
    const status = (cmd.status ?? "").trim();
    if (status === TASK_DONE || status === TASK_IN_PROGRESS || status === TASK_OPEN) {
      if (status !== task.status) {
        await db.setTaskStatus(task.id, status, uid, tz);
        done.push(status === TASK_DONE ? "выполнена" : status === TASK_IN_PROGRESS ? "взята в работу" : "возвращена в работу");
      }
    }

    await setFocus("task", task.id);
    if (!done.length) return `Задача «${task.title}» — не поняла, что именно поменять. Скажи, например: «перенеси на пятницу» или «переименуй в …».`;
    return `✏️ Обновила задачу\n«${fields.title ?? task.title}»\n${done.join("\n")}`;
  }

  if (cmd.action === "event") {
    const title = (cmd.title ?? "").trim();
    if (!title) return null;
    const startsAt = cmd.at ? resolveWhen(cmd.at, tz, 12) : null;
    if (!startsAt) {
      // время не распозналось — не теряем задумку, заводим как задачу
      await db.addTask({ title: `Встреча: ${title}`, creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt: null });
      return `📝 Добавила как задачу «Встреча: ${title}» — не поняла точное время. Скажи время, и перенесу в календарь.`;
    }
    const client = await findClient();
    // То же самое, что и у задачи: имя клиента показывает ярлык, а не название
    const clean = await nice(client ? stripClientName(title, client.name) : title);
    const id = await db.addEvent({ userId: uid, title: clean, startsAt, location: cmd.location ?? "", notes: "", clientId: client?.id ?? null });
    await remember("event", id);
    await setFocus("event", id);
    const loc = cmd.location ? `\n📍 ${cmd.location}` : "";
    const cl = client ? `\n🤝 ${client.name}` : "";
    return `📅 Встреча добавлена\n«${clean}»\n🕒 ${formatEventTime(startsAt, tz)}${loc}${cl}`;
  }

  if (cmd.action === "event_edit") {
    const q = (cmd.title ?? "").trim();
    const { event, ask } = await findEvent(q);
    if (ask) return ask;
    if (!event) return `Не нашла встречу${q ? ` «${q}»` : ""}. Скажи пару слов из её названия.`;

    const fields: { title?: string; startsAt?: string; location?: string; clientId?: number | null } = {};
    const done: string[] = [];

    const newTitle = await nice((cmd.new_name ?? "").trim());
    if (newTitle && newTitle.toLowerCase() !== event.title.toLowerCase()) {
      fields.title = newTitle;
      done.push(`название → «${newTitle}»`);
    }
    // Для встречи новое время может прийти и в at, и в due — модель путает поля
    const whenText = (cmd.at ?? "").trim() || (cmd.due ?? "").trim();
    if (whenText) {
      const startsAt = resolveWhen(whenText, tz, 12);
      if (startsAt && startsAt !== event.starts_at) {
        fields.startsAt = startsAt;
        done.push(`время → ${formatEventTime(startsAt, tz)}`);
      }
    }
    const place = (cmd.location ?? "").trim();
    if (place && place !== event.location) {
      fields.location = place;
      done.push(`место → ${place}`);
    }
    const client = await findClient();
    if (client && client.id !== event.client_id) {
      fields.clientId = client.id;
      done.push(`клиент → ${client.name}`);
    }

    if (!done.length) return `Встреча «${event.title}» — не поняла, что именно поменять. Скажи, например: «перенеси на 16:00».`;
    await db.updateEvent(event.id, uid, fields);
    await setFocus("event", event.id);
    return `✏️ Обновила встречу\n«${fields.title ?? event.title}»\n${done.join("\n")}`;
  }

  if (cmd.action === "event_delete") {
    const q = (cmd.title ?? "").trim();
    if (!q) return null;
    const { event: ev, ask: evAsk } = await findEvent(q);
    if (evAsk) return evAsk;
    if (!ev) return `Не нашла встречу «${q}».`;
    await db.deleteEvent(ev.id, uid);
    return `🗑 Встреча «${ev.title}» отменена.`;
  }

  if (cmd.action === "contact") {
    const name = (cmd.name ?? cmd.title ?? "").trim();
    if (!name) return null;
    let birthday: string | null = (cmd.birthday ?? "").trim() || null;
    if (birthday && !/^\d{2}-\d{2}$/.test(birthday) && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
      const iso = resolveWhen(birthday, tz);
      if (iso) {
        const d = new Date(new Date(iso).getTime() + tz * 3600_000);
        birthday = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      } else {
        birthday = null;
      }
    }
    await db.addContact({ userId: uid, name, birthday, phone: "", notes: "" });
    const bd = birthday ? `\n🎂 ${birthday}` : "";
    return `👤 Контакт добавлен\n${name}${bd}`;
  }

  if (cmd.action === "client_add") {
    // Боевой случай: «добавь клиенту Таллер в карточке ведение 30000» заводило
    // НОВОГО клиента с названием из всей фразы. Отличает правку от создания не
    // формулировка, а факт: если такой клиент уже есть, речь о нём.
    const known = mentionedClient(await db.listClients(uid), rawText || (cmd.name ?? ""));
    if (known) {
      const fields = parseClientFields(rawText);
      if (hasFields(fields)) {
        await db.updateClient(known.id, uid, fields);
        const what = (Object.keys(fields) as (keyof typeof fields)[])
          .map((k) => `${CLIENT_FIELD_RU[k]} → ${fields[k]}`)
          .join("\n");
        return `✏️ Обновила карточку: ${known.name}\n${what}`;
      }
      return `Клиент ${known.name} уже есть. Скажи, что вписать: «ведение 30000», «бюджет 150000», «оплата до 5 числа».`;
    }
    // Имя клиента — с заглавных: голосом оно приходит строчными
    const name = tidyName((cmd.name ?? cmd.title ?? "").trim());
    if (!name) return null;
    await db.addClient(uid, name, (cmd.platforms ?? "").trim(), (cmd.budget ?? "").trim(), {
      payAmount: (cmd.fee ?? "").trim(),
      payDue: (cmd.pay_due ?? "").trim(),
    });
    const extra = [
      cmd.platforms,
      cmd.budget ? `бюджет ${cmd.budget}` : "",
      cmd.fee ? `ведение ${cmd.fee}` : "",
      cmd.pay_due ? `оплата ${cmd.pay_due}` : "",
    ].filter(Boolean).join(" · ");
    return `🤝 Клиент добавлен\n${name}${extra ? `\n${extra}` : ""}`;
  }

  if (cmd.action === "client_delete") {
    const name = (cmd.name ?? cmd.title ?? "").trim();
    if (!name) return null;
    const client = await db.findClientByName(uid, name);
    if (!client) return `Не нашла клиента «${name}». Проверь название — точнее: /clients в боте.`;
    await db.deleteClient(client.id, uid);
    return `🗑 Клиент удалён: ${client.name}`;
  }

  if (cmd.action === "client_edit") {
    // Поля читаем и из фразы: модель вытаскивает не всё, а сказать могут
    // «у Ромашки ведение 45 тыс и оплата до 5 числа» одной репликой.
    const spoken = parseClientFields(rawText);
    const name = (cmd.name ?? "").trim();
    // Имя может не прийти от модели: «у Ромашки ведение 45 тыс» — тогда
    // узнаём клиента прямо во фразе
    const client = (name ? await db.findClientByName(uid, name) : null)
      ?? mentionedClient(await db.listClients(uid), rawText);
    if (!client) return name ? `Не нашла клиента «${name}».` : null;
    const fields: {
      name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string;
      contact?: string; metrikaCounter?: string; directLogin?: string; notes?: string;
    } = {};
    if (cmd.new_name && cmd.new_name.trim()) fields.name = cmd.new_name.trim();
    if (cmd.platforms && cmd.platforms.trim()) fields.platforms = cmd.platforms.trim();
    if (cmd.budget && cmd.budget.trim()) fields.budget = cmd.budget.trim();
    if (cmd.fee && cmd.fee.trim()) fields.payAmount = cmd.fee.trim();
    if (cmd.pay_due && cmd.pay_due.trim()) fields.payDue = cmd.pay_due.trim();
    // Сказанное вслух дополняет разбор модели, но не затирает его
    if (spoken.fee && !fields.payAmount) fields.payAmount = spoken.fee;
    if (spoken.budget && !fields.budget) fields.budget = spoken.budget;
    if (spoken.payDue && !fields.payDue) fields.payDue = spoken.payDue;
    if (spoken.platforms && !fields.platforms) fields.platforms = spoken.platforms;
    if (spoken.contact) fields.contact = spoken.contact;
    if (spoken.metrikaCounter) fields.metrikaCounter = spoken.metrikaCounter;
    if (spoken.directLogin) fields.directLogin = spoken.directLogin;
    if (spoken.notes) fields.notes = spoken.notes;
    if (!Object.keys(fields).length) return `Что изменить у клиента «${client.name}»? Скажи, например: «ведение 30000», «бюджет 150000», «оплата до 5 числа», «площадки Директ и VK».`;
    await db.updateClient(client.id, uid, fields);
    const changes = [
      fields.name && `название → ${fields.name}`,
      fields.platforms && `площадки → ${fields.platforms}`,
      fields.budget && `бюджет → ${fields.budget}`,
      fields.payAmount && `ведение → ${fields.payAmount}`,
      fields.payDue && `оплата → ${fields.payDue}`,
      fields.contact && `контакт → ${fields.contact}`,
      fields.metrikaCounter && `счётчик Метрики → ${fields.metrikaCounter}`,
      fields.directLogin && `логин Директа → ${fields.directLogin}`,
      fields.notes && `заметка записана`,
    ].filter(Boolean).join("\n");
    return `✏️ Карточка обновлена: ${client.name}\n${changes}`;
  }

  if (cmd.action === "note_add") {
    const text = (cmd.title ?? "").trim();
    if (!text) return null;
    const id = await db.addNote(uid, text);
    await remember("note", id);
    return `📝 Заметка сохранена\n«${text}»`;
  }

  return null;
}

const ACTION_RE = /(добав|запланир|напомн|созда|запиш|поставь|встреч|созвон|перезвон|позвон|купить|заплан)/i;

/**
 * Локальный разбор частых команд БЕЗ обращения к ИИ (экономия расхода).
 * Возвращает намерение для однозначных шаблонов без дат, иначе null (тогда — YandexGPT).
 */

/**
 * Разбирает поправку человека: «не то, это еда», «это была встреча», «нет, заметка».
 * Возвращает, чем на самом деле была прошлая фраза, или null.
 *
 * Зачем: маршрутизатор иногда промахивается, и раньше человеку оставалось
 * только удалить запись и переписать фразу иначе. Теперь он говорит, как надо,
 * — Сара переделывает и запоминает урок на будущее.
 */
export function parseCorrection(text: string): "food" | "event" | "task" | "note" | "water" | null {
  const t = text.trim().toLowerCase();
  // Поправка — короткая реплика вида «нет, это …». Голое «не» в начале не годится:
  // под него попадает обычное «не забудь купить еду».
  // WB_END вместо \b: в JavaScript \b не считает кириллицу буквами, поэтому
  // «нет,» и «не то,» через \b не совпадали бы — на этом уже обжигались.
  const opener = new RegExp(
    `^(?:это|нет|не\\s+то|не\\s+так|не\\s+(?:задач|встреч|заметк|ед|вод)[а-яё]*|неправильно|ошиб[а-яё]+|(?:я\\s+)?имел[а-яё]*\\s+в\\s+виду)${WB_END}`,
    "i"
  );
  if (!opener.test(t)) return null;
  if (t.length > 80) return null;
  if (/(ед[аыуе]|питани|калори|рацион|бжу|блюд)/i.test(t)) return "food";
  if (/(встреч|созвон|событи|календар)/i.test(t)) return "event";
  if (/(задач|дело|напомин)/i.test(t)) return "task";
  if (/(заметк|запис[ька])/i.test(t)) return "note";
  if (/(вод[аыуе]|попил|выпил)/i.test(t)) return "water";
  return null;
}

/**
 * Разбор команд БЕЗ обращения к ИИ.
 *
 * Зачем он такой подробный. Если модель недоступна или медленно отвечает, без
 * этих правил бот не умеет вообще ничего — даже завести задачу, а это самая
 * частая команда. Поэтому здесь закрыты все основные действия и по нескольку
 * способов сказать каждое: люди говорят «напомни», «поставь задачу», «не забыть»
 * и «надо» об одном и том же.
 *
 * Границы слов — из utils: в JavaScript \b не считает кириллицу буквами.
 */
export function localRoute(text: string): AssistantIntent | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;

  /** Название + срок из хвоста фразы. */
  const task = (rest: string, extra: Partial<AssistantIntent> = {}): AssistantIntent | null => {
    const { title, when } = splitWhen(rest);
    if (!title || title.length < 2) return null;
    return { action: "task", title, due: when, scope: guessScope(rest), ...extra };
  };

  // ---------- Заметки ----------
  if (t.startsWith("!")) {
    const body = t.slice(1).trim();
    return body ? { action: "note_add", title: body } : null;
  }
  if ((m = t.match(/^(?:заметка|записка|запиши идею|запиши мысль|запомни|на заметку)[:\s]+(.+)/i)))
    return { action: "note_add", title: m[1].trim() };

  // ---------- Задачи: постановка ----------
  // «напоминай каждый вторник …» — повтор разбирается отдельно, в обработчике
  if ((m = t.match(/^(?:напоминай|напоминать)\s+(.+)$/i))) return task(m[1]);
  if ((m = t.match(/^(?:напомни|напомнить|напомните)\s+(?:мне\s+)?(.+)$/i))) return task(m[1]);
  if ((m = t.match(/^(?:поставь|постав|добавь|заведи|создай|запиши|внеси)\s+(?:нов[а-яё]+\s+)?(?:задач[а-яё]*|дело|напоминани[ея])[:\s]+(.+)$/i)))
    return task(m[1]);
  if ((m = t.match(/^(?:не\s+(?:забыть|забудь|забудьте))\s+(.+)$/i))) return task(m[1]);
  if ((m = t.match(/^(?:надо|нужно|необходимо|требуется)\s+(?:бы\s+)?(.+)$/i))) return task(m[1]);
  if ((m = t.match(/^(?:запланируй|планирую|хочу)\s+(.+)$/i)) && !/(встреч|созвон|планерк|планёрк)/i.test(t)) return task(m[1]);

  // ---------- Задачи: изменение ----------
  if ((m = t.match(/^(?:перенес(?:и|ти)|сдвин(?:ь|уть)|передвин(?:ь|уть))\s+на\s+(.+)$/i)))
    return { action: "task_edit", title: "", due: m[1].trim(), at: m[1].trim() };
  if ((m = t.match(/^(?:перенес(?:и|ти)|сдвин(?:ь|уть)|передвин(?:ь|уть))\s+(?:встреч[а-яё]*|созвон[а-яё]*|планерк[а-яё]*|планёрк[а-яё]*)\s*(.*?)\s+на\s+(.+)$/i)))
    return { action: "event_edit", title: m[1].trim(), at: m[2].trim() };
  if ((m = t.match(/^(?:перенес(?:и|ти)|сдвин(?:ь|уть)|передвин(?:ь|уть))\s+(?:задач[а-яё]*\s+)?(.+?)\s+на\s+(.+)$/i)))
    return { action: "task_edit", title: m[1].trim(), due: m[2].trim() };
  if ((m = t.match(/^(?:поменяй|измени|смени)\s+срок\s+(?:у\s+)?(?:задач[а-яё]*\s+)?(.+?)\s+на\s+(.+)$/i)))
    return { action: "task_edit", title: m[1].trim(), due: m[2].trim() };
  if ((m = t.match(/^(?:убер(?:и|ать)|сним(?:и|ать)|сбрось)\s+(?:срок|дедлайн|дату)\s+(?:у\s+)?(?:задач[а-яё]*\s+)?(.+)$/i)))
    return { action: "task_edit", title: m[1].trim() };
  if ((m = t.match(/^(?:переименуй|назови|переназови)\s+(?:встреч[а-яё]*|созвон[а-яё]*)\s+(.+?)\s+в\s+(.+)$/i)))
    return { action: "event_edit", title: m[1].trim(), new_name: m[2].trim() };
  if ((m = t.match(/^(?:переименуй|назови|переназови)\s+(?:клиент[а-яё]*)\s+(.+?)\s+в\s+(.+)$/i)))
    return { action: "client_edit", name: m[1].trim(), new_name: m[2].trim() };
  // «назови задачу лендинг «Лендинг под Директ»» — новое название в кавычках,
  // без слова «в». Кавычки тут единственная надёжная граница.
  if ((m = t.match(/^(?:переименуй|назови|переназови)\s+(?:задач[а-яё]*\s+)?(.+?)\s+[«"'](.+)[»"']$/i)))
    return { action: "task_edit", title: m[1].trim(), new_name: m[2].trim() };
  if ((m = t.match(/^(?:переименуй|назови|переназови)\s+(?:задач[а-яё]*\s+)?(.+?)\s+в\s+(.+)$/i)))
    return { action: "task_edit", title: m[1].trim(), new_name: m[2].trim() };
  if ((m = t.match(/^(?:возьм(?:и|у)|беру|взял[а-яё]*|начал[а-яё]*|приступил[а-яё]*|делаю)\s+(?:в\s+работу\s+)?(?:к\s+)?(?:делать\s+|заниматься\s+)?(?:задач[а-яё]*\s+)?(.+?)(?:\s+в\s+работу)?$/i)))
    return { action: "task_edit", title: m[1].trim(), status: "in_progress" };
  if ((m = t.match(/^(?:верн(?:и|уть)|открой|открыть|возобнови)\s+(?:задач[а-яё]*\s+)?(.+?)\s+в\s+работу$/i)))
    return { action: "task_edit", title: m[1].trim(), status: "open" };
  if ((m = t.match(/^(?:сделай|переведи|помести)\s+(?:задач[а-яё]*\s+)?(?:про\s+|по\s+)?(.+?)\s+(личн[а-яё]+|рабоч[а-яё]+)$/i)))
    return { action: "task_edit", title: m[1].trim(), scope: /личн/i.test(m[2]) ? SCOPE_PERSONAL : SCOPE_WORK };
  if ((m = t.match(/^(?:привяж(?:и|ать)|прикреп(?:и|ить)|отнеси)\s+(?:задач[а-яё]*\s+)?(?:про\s+|по\s+)?(.+?)\s+(?:к|на)\s+(.+)$/i)))
    return { action: "task_edit", title: m[1].trim(), client: m[2].trim() };

  // ---------- Задачи: выполнение ----------
  if ((m = t.match(/^(?:закрой|закрыть|заверш(?:и|ить)|выполни)\s+(?:задач[а-яё]*\s+)?(.+)$/i)))
    return { action: "task_done", title: m[1].trim() };
  if ((m = t.match(/^(?:выполнил[а-яё]*|сделал[а-яё]*|отметь|отметил[а-яё]*|закончил[а-яё]*)\s+(?:задач[а-яё]*\s+)?(.+?)(?:\s+выполненн[а-яё]+)?$/i)))
    return { action: "task_done", title: m[1].trim() };
  // «отчёт готов», «смета сделана»
  if ((m = t.match(/^(.+?)\s+(?:готов[аоы]?|сделан[аоы]?|законч(?:ен|ена|ено)|заверш(?:ен|ена|ено)|отправлен[аоы]?)$/i)))
    return { action: "task_done", title: m[1].trim() };
  // «с банком закончил», «по отчёту всё»
  if ((m = t.match(/^(?:с|по)\s+(.+?)\s+(?:закончил[а-яё]*|покончено|разобрал[а-яё]*|все|всё|готово)$/i)))
    return { action: "task_done", title: m[1].trim() };

  // ---------- Задачи и встречи: удаление ----------
  // «Отмени встречу с Ромашкой» → ищем по «с Ромашкой»: слово «встречу» тут
  // только тип. А в «отмени планёрку» это единственное название, и выбрасывать
  // его нельзя — иначе искать будет нечего и Сара удалит первую попавшуюся.
  if ((m = t.match(/^(?:удал(?:и|ить)|убер(?:и|ать)|отмен(?:и|ить))\s+(?:(?:встреч|созвон|планерк|планёрк|собрани)[а-яё]*\s+(.+)|((?:встреч|созвон|планерк|планёрк|собрани)[а-яё]*))$/i)))
    return { action: "event_delete", title: (m[1] || m[2] || "").trim() };
  if ((m = t.match(/^(?:удал(?:и|ить)|убер(?:и|ать))\s+(?:задач[а-яё]*|дело)\s+(.+)$/i)))
    return { action: "task_delete", title: m[1].trim() };
  if ((m = t.match(/^(?:удал(?:и|ить)|убер(?:и|ать))\s+клиент[а-яё]*\s+(.+)$/i)))
    return { action: "client_delete", name: m[1].trim() };
  if ((m = t.match(/^(?:удал(?:и|ить)|убер(?:и|ать))\s+(?:из\s+списка\s+)?(.+)$/i)) && !/(ед[уы]|воду|трениров|последн)/i.test(t))
    return { action: "task_delete", title: m[1].trim() };
  if ((m = t.match(/^отмен(?:и|ить)\s+(.+)$/i))) return { action: "event_delete", title: m[1].trim() };

  // ---------- Встречи ----------
  // Перемена места — ДО правила создания: иначе «встреча … будет в офисе»
  // попадёт в создание, там не найдётся времени, и фраза потеряется.
  if ((m = t.match(/^(?:встреча|встречу|созвон|планерка|планёрка)\s+(.+?)\s+буд(?:ет|ут)\s+(?:в|на)\s+(.+)$/i)))
    return { action: "event_edit", title: m[1].trim(), location: m[2].trim() };

  let kind = "";
  if ((m = t.match(/^((?:встреч|созвон|планерк|планёрк|собрани)[а-яё]*)\s+(.+)$/i)) && (kind = m[1])
    || ((m = t.match(/^(?:запланируй|назначь|поставь|добавь|заведи|создай)\s+((?:встреч|созвон|планерк|планёрк|собрани)[а-яё]*)\s+(.+)$/i)) && (kind = m[1]))) {
    const { title, when } = splitWhen(m[2]);
    if (!when) return null;                       // без времени это не встреча — пусть решает ИИ
    const place = title.match(/\s+(?:в|на)\s+(офисе|зуме|зале|кафе|переговорке|скайпе|телемосте)$/i);
    const clean = place ? title.slice(0, place.index).trim() : title;
    // «запланируй планёрку в 10» — название и есть тип встречи, иначе оно пропадёт
    const name = clean || kind.charAt(0).toUpperCase() + kind.slice(1);
    return { action: "event", title: name, at: when, location: place ? place[1] : "" };
  }

  // ---------- Клиенты ----------
  if ((m = t.match(/^(?:добавь|заведи|создай|внеси)\s+(?:нов[а-яё]+\s+)?клиент[а-яё]*[:\s]+(.+)$/i))) {
    const parts = m[1].split(/\s*,\s*/);
    const name = parts.shift()!.trim();
    if (!name) return null;
    const rest = parts.join(", ");
    const budget = rest.match(/бюджет\D{0,3}(\d[\d\s]*)/i);
    const fee = rest.match(/(?:ведени[ея]|оплата)\D{0,3}(\d[\d\s]*)/i);
    const platforms = parts.filter((x) => !/бюджет|ведени|оплата/i.test(x)).join(", ");
    return {
      action: "client_add",
      name,
      platforms: platforms.trim(),
      budget: budget ? budget[1].replace(/\s/g, "") : "",
      fee: fee ? fee[1].replace(/\s/g, "") : "",
    };
  }
  if ((m = t.match(/^(?:поменяй|измени|смени|постав(?:ь|ить))\s+(?:оплату|ведение|стоимость)\s+(?:ведения\s+)?(?:у\s+|для\s+)?(?:клиент[а-яё]*\s+)?(.+?)\s+на\s+(\d[\d\s]*)/i)))
    return { action: "client_edit", name: m[1].trim(), fee: m[2].replace(/\s/g, "") };
  if ((m = t.match(/^(?:поменяй|измени|смени|постав(?:ь|ить))\s+бюджет\s+(?:у\s+|для\s+)?(?:клиент[а-яё]*\s+)?(.+?)\s+на\s+(\d[\d\s]*)/i)))
    return { action: "client_edit", name: m[1].trim(), budget: m[2].replace(/\s/g, "") };

  // ---------- Контакты ----------
  if ((m = t.match(/^(?:запиши|добавь|запомни|внеси)\s+(?:день\s+рождения|др|днюху)\s+(.+?)\s+(\d{1,2}[\s.]+[а-яё]+|\d{1,2}\.\d{1,2})$/i)))
    return { action: "contact", name: m[1].trim(), birthday: m[2].trim() };
  if ((m = t.match(/^(?:добавь|заведи|запиши|внеси)\s+контакт[:\s]+(.+)$/i)))
    return { action: "contact", name: m[1].trim() };

  return null;
}

/**
 * Пытается выполнить команду из текста (задача/встреча/контакт). Возвращает подтверждение
 * или null, если это не команда (обычный вопрос — его должен обработать чат).
 * @param forceTask если true и намерение не распознано — принудительно создаёт задачу (для голоса).
 */
export async function tryPerformCommand(
  env: Env,
  db: DB,
  uid: number,
  text: string,
  forceTask = false
): Promise<string | null> {
  const tz = tzOffsetOf(env);
  const ai = aiConfig(env);
  const dayStart = startOfLocalDayIso(tz);
  const dayEnd = startOfLocalDayOffsetIso(tz, 1);

  // 0-fix) Поправка к прошлой фразе: «не то, это еда». Переделываем и запоминаем урок.
  const fix = parseCorrection(text);
  if (fix) {
    const applied = await applyCorrection(env, db, uid, tz, fix);
    if (applied) return applied;
  }

  // 0-health) Правки раздела «Здоровье» — локально, без ИИ
  // Цель по калориям
  if (/(цел|норм)/i.test(text) && /(калор|ккал)/i.test(text)) {
    const n = text.match(/(\d{3,5})/);
    if (n) { await db.setSetting(`hkcal:${uid}`, n[1]); return `🎯 Цель по калориям: ${n[1]} ккал/день.`; }
  }
  // Цель по воде
  if (/(цел|норм)/i.test(text) && /вод/i.test(text)) {
    const ml = parseWaterMl(text);
    await db.setSetting(`hwater:${uid}`, String(ml));
    return `🎯 Цель по воде: ${(ml / 1000).toFixed(1)} л/день.`;
  }
  // Удалить последнюю еду
  if (/(удал|убери|убрать)/i.test(text) && /(последн)/i.test(text) && /(ед[уаы]|блюд|приём|прием)/i.test(text)) {
    const last = await db.lastFood(uid, dayStart, dayEnd);
    if (!last) return "Сегодня ещё нет записей о еде.";
    await db.deleteFood(last.id, uid);
    return `🗑 Удалила: ${last.title} (−${last.kcal} ккал).`;
  }
  // Вес
  // «вес 82», «вес — 82,5», «взвесился 82.5»; начало слова проверяем явно, чтобы
  // не ловить «навес» и «привес»
  const weightRe = new RegExp(`${WB_START}вес[а-яё]*\\s*[—:\\-]?\\s*(\\d{2,3}(?:[.,]\\d)?)`, "i");
  const wM = text.match(weightRe) || text.match(/взвес[а-яё]+\D{0,6}(\d{2,3}(?:[.,]\d)?)/i);
  if (wM) {
    const kg = parseFloat(wM[1].replace(",", "."));
    if (kg >= 20 && kg <= 400) { await db.addWeight(uid, kg); return `⚖️ Записала вес: ${kg} кг.`; }
  }
  // Активность / сон / настроение
  const todayStr = new Date(Date.parse(dayStart) + tz * 3600_000).toISOString().slice(0, 10);
  let am: RegExpMatchArray | null;
  if ((am = text.match(/(\d{3,6})\s*шаг/i))) {
    const steps = parseInt(am[1], 10); const kc = Math.round(steps * 0.04);
    await db.addActivity(uid, `Шаги: ${steps}`, kc);
    return `🏃 Записала ${steps} шагов (~${kc} ккал).`;
  }
  if ((am = text.match(/(?:сж[её]г|сожгла|потратил[а-яё]*)\s*(\d{2,4})\s*ккал/i))) {
    const kc = parseInt(am[1], 10);
    await db.addActivity(uid, "Активность", kc);
    return `🔥 Записала −${kc} ккал (активность).`;
  }
  // Удалить последнюю тренировку
  if (/(удал|убери|убрать)/i.test(text) && /(последн)/i.test(text) && /(трениров|активност|пробежк|заняти)/i.test(text)) {
    const last = await db.lastActivity(uid);
    if (!last) return "Тренировок пока нет.";
    await db.deleteActivity(last.id, uid);
    return `🗑 Удалила тренировку: ${last.title} (−${last.kcal} ккал).`;
  }
  // Недельная цель по тренировкам
  if ((am = text.match(/цел[а-яё]*\D{0,15}(\d{1,2})\D{0,15}трениров/i)) || (am = text.match(/(\d{1,2})\s*трениров[а-яё]*\s*в\s*недел/i))) {
    const n = parseInt(am[1], 10);
    if (n >= 1 && n <= 21) { await db.setSetting(`wgoal:${uid}`, String(n)); return `🎯 Цель: ${n} трениров${n === 1 ? "ка" : n < 5 ? "ки" : "ок"} в неделю.`; }
  }
  // Тренировка/активность
  const looksLikeWorkout =
    /(трениров|пробежк|побегал|качал|йог|плавал|велосипед|отжим|присед|заняти|кардио|силов|растяж|планк)/i.test(text) ||
    wordRe("зал").test(text);
  if (looksLikeWorkout && ai) {
    const kc = (await estimateBurn(ai, text)) ?? 0;
    let dur = 0;
    let dm;
    if ((dm = text.match(/(\d{1,3})\s*(?:мин|минут)/i))) dur = parseInt(dm[1], 10);
    else if ((dm = text.match(/(\d{1,2})\s*(?:час[а-яё]*|ч)(?![а-яёa-z])/i))) dur = parseInt(dm[1], 10) * 60;
    const low = text.toLowerCase();
    const type = /(бег|пробежк|кардио|велосипед|плаван|ходьб)/.test(low) ? "кардио"
      : /(силов|качал|\bзал\b|штанг|жим|присед|отжим|турник)/.test(low) ? "силовая"
      : /(йог|растяж|стретч|планк)/.test(low) ? "растяжка"
      : "другое";
    await db.addActivity(uid, text.slice(0, 80), kc, type, dur);
    return `🏋️ Тренировка записана: ${text.slice(0, 60)}${dur ? ` · ${dur} мин` : ""}${kc ? ` · ~${kc} ккал` : ""}.`;
  }
  if ((am = text.match(/спал[а-яё]*\s*(\d{1,2}(?:[.,]\d)?)\s*час/i))) {
    const hrs = parseFloat(am[1].replace(",", "."));
    await db.setWellbeing(uid, todayStr, { sleep: hrs });
    return `😴 Записала сон: ${hrs} ч.`;
  }
  if ((am = text.match(/настроени[ея]\s+([а-яё]+)/i))) {
    await db.setWellbeing(uid, todayStr, { mood: am[1] });
    return `🙂 Настроение отмечено: ${am[1]}.`;
  }

  // 0a) Вода — локально, без ИИ
  const waterMl = matchWaterMl(text);
  if (waterMl) {
    await db.addWater(uid, waterMl);
    const total = await db.waterTotal(uid, startOfLocalDayIso(tz), startOfLocalDayOffsetIso(tz, 1));
    return `💧 +${waterMl} мл. Сегодня выпито: ${(total / 1000).toFixed(1)} л.`;
  }

  // 0b) Еда — оценка калорий через ИИ
  if (looksLikeFoodText(text)) {
    if (!ai) return null;
    const n = await estimateNutrition(ai, text);
    if (n) {
      const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
      const meal = mealFromText(text) || mealByHour(localHour);
      const foodId = await db.addFood(uid, { ...n, meal });
      await db.setSetting(`last:${uid}`, JSON.stringify({ phrase: text, kind: "food", id: foodId }));
      return `🍽 Записала (${MEAL_RU[meal]}): ${n.title}\n🔥 ${n.kcal} ккал · Б ${n.protein} · Ж ${n.fat} · У ${n.carbs} г`;
    }
  }

  // 0b2) Настройки приложения словами: «сделай шрифт крупнее», «тёмная тема»,
  // «спрячь раздел здоровье». Проверяем ДО вопросов: «покажи раздел здоровье»
  // иначе было бы принято за вопрос о делах.
  //
  // Сначала пробуем со стандартными настройками — это дёшево и отсеивает почти
  // все фразы. Настоящие настройки читаем, только если команда правда похожа:
  // шаг «крупнее» надо считать от текущего размера, а не от стандартного.
  if (parseAppearance(text)) {
    const cur = await db.getPrefs(uid);
    const look = parseAppearance(text, cur);
    if (look) {
      await db.setPrefs(uid, { ...cur, ...look.changes });
      return renderPrefsChange(look);
    }
  }

  // 0c) Вопрос о своих записях — отвечаем из базы, без ИИ.
  // Это самый частый вопрос к ассистенту, и выдуманный ответ тут недопустим.
  const ask = parseQuery(text);
  if (ask) {
    const client = mentionedClient(await db.listClients(uid), text);
    return await answerQuery(db, uid, tz, ask, client);
  }

  // 0) Локальный быстрый разбор — без ИИ (экономия). Частые команды без дат.
  const local = localRoute(text);
  if (local) {
    const a = await performIntent(local, db, uid, tz, text);
    if (a) return a;
  }

  if (!ai) return null;
  const now = nowContext(tz);

  // 1) Иначе — распознавание команды на дешёвой модели (yandexgpt-lite).
  // Дел может быть несколько: «завтра созвон в 12 и не забудь отправить смету».
  const intents = await routeAssistant(ai, text, now, await db.listLessons(uid));
  const answers: string[] = [];
  for (const one of intents) {
    const said = await performIntent(one, db, uid, tz, text);
    if (said) answers.push(said);
  }
  let action = answers.length ? answers.join("\n\n") : null;

  // Страховка: явная команда (или голос), но роутер промахнулся → создаём задачу
  if (!action && (forceTask || ACTION_RE.test(text))) {
    const p = await parseTaskFromText(ai, text, now);
    const title = tidyTitle((p?.title || text).trim());
    if (title) {
      const dueAt = p?.due ? resolveWhen(p.due, tz, 10) : resolveWhen(text, tz, 10);
      const scope = p?.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
      const id = await db.addTask({ title, creatorId: uid, assigneeId: uid, scope, dueAt });
      const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
      const sc = scope === SCOPE_PERSONAL ? "🙋 Личная" : "💼 Рабочая";
      action = `✅ Добавила задачу\n«${title}»\n${sc}${due}`;
    }
  }
  return action;
}

/**
 * Переделывает прошлую фразу так, как поправил человек, и запоминает урок.
 * Возвращает ответ или null, если переделывать нечего.
 */
async function applyCorrection(
  env: Env,
  db: DB,
  uid: number,
  tz: number,
  kind: "food" | "event" | "task" | "note" | "water"
): Promise<string | null> {
  const raw = await db.getSetting(`last:${uid}`);
  if (!raw) return "Не помню, что поправлять. Напиши фразу заново — разберу как надо.";
  let last: { phrase?: string; kind?: string; id?: number };
  try {
    last = JSON.parse(raw);
  } catch {
    return null;
  }
  const phrase = (last.phrase ?? "").trim();
  if (!phrase) return null;

  // убираем то, что создали по ошибке
  if (last.kind === "task" && last.id) await db.deleteTask(last.id, uid);
  if (last.kind === "event" && last.id) await db.deleteEvent(last.id, uid);
  if (last.kind === "note" && last.id) await db.deleteNote(last.id, uid);
  if (last.kind === "food" && last.id) await db.deleteFood(last.id, uid);
  await db.setSetting(`last:${uid}`, "");
  await db.addLesson(uid, phrase, kind);

  const learned = "\n\n🧠 Запомнила: такие фразы разбираю как " + KIND_RU[kind] + ".";
  // В подтверждении человек должен увидеть текст таким же, как он лёг в список
  const said = tidyTitle(phrase);

  if (kind === "water") {
    const ml = parseWaterMl(phrase) || 250;
    await db.addWater(uid, ml);
    const total = await db.waterTotal(uid, startOfLocalDayIso(tz), startOfLocalDayOffsetIso(tz, 1));
    return `💧 Исправила: +${ml} мл. Сегодня: ${(total / 1000).toFixed(1)} л.${learned}`;
  }
  if (kind === "note") {
    const id = await db.addNote(uid, said);
    return `📝 Исправила: заметка\n«${said}»${learned}`;
  }
  const ai = aiConfig(env);
  if (kind === "food") {
    if (!ai) return "Чтобы посчитать калории, нужен ИИ — добавь YANDEX_API_KEY и YANDEX_FOLDER_ID.";
    const n = await estimateNutrition(ai, phrase);
    if (!n) return "Не смогла разобрать блюдо. Напиши, что именно съел и сколько.";
    const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
    const meal = mealFromText(phrase) || mealByHour(localHour);
    const id = await db.addFood(uid, { ...n, meal });
    await db.setSetting(`last:${uid}`, JSON.stringify({ phrase, kind: "food", id }));
    return `🍽 Исправила (${MEAL_RU[meal]}): ${n.title}\n🔥 ${n.kcal} ккал · Б ${n.protein} · Ж ${n.fat} · У ${n.carbs} г${learned}`;
  }
  if (kind === "event") {
    const startsAt = resolveWhen(phrase, tz, 12);
    if (!startsAt) return `Понадобится время встречи. Скажи, например: «${phrase} завтра в 15:00».`;
    const clients = await db.listClients(uid);
    const client = mentionedClient(clients, phrase);
    const id = await db.addEvent({ userId: uid, title: said, startsAt, location: "", notes: "", clientId: client?.id ?? null });
    await db.setSetting(`last:${uid}`, JSON.stringify({ phrase, kind: "event", id }));
    const cl = client ? `\n🤝 ${client.name}` : "";
    return `📅 Исправила: встреча\n«${said}»\n🕒 ${formatEventTime(startsAt, tz)}${cl}${learned}`;
  }
  // задача
  const dueAt = resolveWhen(phrase, tz, 10);
  const clients = await db.listClients(uid);
  const client = mentionedClient(clients, phrase);
  const id = await db.addTask({ title: said, creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt, clientId: client?.id ?? null });
  await db.setSetting(`last:${uid}`, JSON.stringify({ phrase, kind: "task", id }));
  const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
  return `✅ Исправила: задача\n«${said}»${due}${learned}`;
}

const KIND_RU: Record<string, string> = {
  food: "запись еды",
  event: "встречу",
  task: "задачу",
  note: "заметку",
  water: "воду",
};
