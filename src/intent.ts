/**
 * Единая логика «ассистент выполняет команду»: распознаёт намерение (задача/встреча/контакт)
 * и создаёт запись в БД. Используется и в Mini App (/api/ai), и в боте (текст/голос),
 * чтобы поведение было одинаковым.
 */
import { aiConfig, AssistantIntent, estimateBurn, estimateNutrition, parseTaskFromText, routeAssistant } from "./ai";
import { DB } from "./db";
import { Env, SCOPE_PERSONAL, SCOPE_WORK, TASK_DONE } from "./types";
import { formatDue, formatEventTime, matchWaterMl, mealByHour, mealFromText, nowContext, parseWaterMl, resolveWhen, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf, parseRepeat, repeatLabel, WB_END, WB_START, wordRe } from "./utils";

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

  /**
   * Чей это клиент. Сначала верим ИИ (он мог вытащить имя), иначе ищем имя
   * своего клиента прямо в исходной фразе: «встреча с айпапа» → карточка «АйПапа».
   */
  /** Что Сара только что создала: нужно, если человек скажет «не то, это еда». */
  const remember = async (kind: string, id: number) => {
    if (!rawText) return;
    await db.setSetting(`last:${uid}`, JSON.stringify({ phrase: rawText, kind, id }));
  };

  const findClient = async (): Promise<{ id: number; name: string } | null> => {
    const named = (intent.client ?? "").trim();
    if (named) {
      const byName = await db.findClientByName(uid, named);
      if (byName) return byName;
    }
    const where = `${rawText} ${intent.title ?? ""}`.trim();
    if (!where) return null;
    return mentionedClient(await db.listClients(uid), where);
  };

  if (intent.action === "task") {
    const title = (intent.title ?? "").trim();
    if (!title) return null;
    const dueAt = intent.due ? resolveWhen(intent.due, tz, 10) : null;
    const scope = intent.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
    const client = scope === SCOPE_PERSONAL ? null : await findClient();
    // «каждый вторник», «по будням» — задача должна возвращаться сама
    const repeat = parseRepeat(`${rawText} ${title}`);
    const id = await db.addTask({ title, creatorId: uid, assigneeId: uid, scope, dueAt, clientId: client?.id ?? null, repeat });
    await remember("task", id);
    const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
    const sc = scope === SCOPE_PERSONAL ? "🙋 Личная" : "💼 Рабочая";
    const cl = client ? `\n🤝 ${client.name}` : "";
    const rp = repeat ? `\n🔁 ${repeatLabel(repeat)}` : "";
    return `✅ Добавила задачу\n«${title}»\n${sc}${due}${cl}${rp}`;
  }

  if (intent.action === "task_done") {
    const q = (intent.title ?? "").trim();
    if (!q) return null;
    const task = await db.findTaskByTitle(uid, q);
    if (!task) return `Не нашла активную задачу «${q}».`;
    await db.setTaskStatus(task.id, TASK_DONE, uid, tz);
    return `✅ Задача «${task.title}» отмечена выполненной. Молодец!`;
  }

  if (intent.action === "task_delete") {
    const q = (intent.title ?? "").trim();
    if (!q) return null;
    const task = await db.findTaskByTitle(uid, q);
    if (!task) return `Не нашла задачу «${q}».`;
    await db.deleteTask(task.id, uid);
    return `🗑 Задача «${task.title}» удалена.`;
  }

  if (intent.action === "event") {
    const title = (intent.title ?? "").trim();
    if (!title) return null;
    const startsAt = intent.at ? resolveWhen(intent.at, tz, 12) : null;
    if (!startsAt) {
      // время не распозналось — не теряем задумку, заводим как задачу
      await db.addTask({ title: `Встреча: ${title}`, creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt: null });
      return `📝 Добавила как задачу «Встреча: ${title}» — не поняла точное время. Скажи время, и перенесу в календарь.`;
    }
    const client = await findClient();
    const id = await db.addEvent({ userId: uid, title, startsAt, location: intent.location ?? "", notes: "", clientId: client?.id ?? null });
    await remember("event", id);
    const loc = intent.location ? `\n📍 ${intent.location}` : "";
    const cl = client ? `\n🤝 ${client.name}` : "";
    return `📅 Встреча добавлена\n«${title}»\n🕒 ${formatEventTime(startsAt, tz)}${loc}${cl}`;
  }

  if (intent.action === "event_delete") {
    const q = (intent.title ?? "").trim();
    if (!q) return null;
    const ev = await db.findEventByTitle(uid, q);
    if (!ev) return `Не нашла встречу «${q}».`;
    await db.deleteEvent(ev.id, uid);
    return `🗑 Встреча «${ev.title}» отменена.`;
  }

  if (intent.action === "contact") {
    const name = (intent.name ?? intent.title ?? "").trim();
    if (!name) return null;
    let birthday: string | null = (intent.birthday ?? "").trim() || null;
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

  if (intent.action === "client_add") {
    const name = (intent.name ?? intent.title ?? "").trim();
    if (!name) return null;
    await db.addClient(uid, name, (intent.platforms ?? "").trim(), (intent.budget ?? "").trim(), {
      payAmount: (intent.fee ?? "").trim(),
      payDue: (intent.pay_due ?? "").trim(),
    });
    const extra = [
      intent.platforms,
      intent.budget ? `бюджет ${intent.budget}` : "",
      intent.fee ? `ведение ${intent.fee}` : "",
      intent.pay_due ? `оплата ${intent.pay_due}` : "",
    ].filter(Boolean).join(" · ");
    return `🤝 Клиент добавлен\n${name}${extra ? `\n${extra}` : ""}`;
  }

  if (intent.action === "client_delete") {
    const name = (intent.name ?? intent.title ?? "").trim();
    if (!name) return null;
    const client = await db.findClientByName(uid, name);
    if (!client) return `Не нашла клиента «${name}». Проверь название — точнее: /clients в боте.`;
    await db.deleteClient(client.id, uid);
    return `🗑 Клиент удалён: ${client.name}`;
  }

  if (intent.action === "client_edit") {
    const name = (intent.name ?? "").trim();
    if (!name) return null;
    const client = await db.findClientByName(uid, name);
    if (!client) return `Не нашла клиента «${name}».`;
    const fields: { name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string } = {};
    if (intent.new_name && intent.new_name.trim()) fields.name = intent.new_name.trim();
    if (intent.platforms && intent.platforms.trim()) fields.platforms = intent.platforms.trim();
    if (intent.budget && intent.budget.trim()) fields.budget = intent.budget.trim();
    if (intent.fee && intent.fee.trim()) fields.payAmount = intent.fee.trim();
    if (intent.pay_due && intent.pay_due.trim()) fields.payDue = intent.pay_due.trim();
    if (!Object.keys(fields).length) return `Что изменить у клиента «${client.name}»? Укажи название, площадки, бюджет, сумму ведения или дедлайн оплаты.`;
    await db.updateClient(client.id, uid, fields);
    const changes = [
      fields.name && `название → ${fields.name}`,
      fields.platforms && `площадки → ${fields.platforms}`,
      fields.budget && `бюджет → ${fields.budget}`,
      fields.payAmount && `ведение → ${fields.payAmount}`,
      fields.payDue && `оплата → ${fields.payDue}`,
    ].filter(Boolean).join(", ");
    return `✏️ Клиент обновлён: ${client.name}\n${changes}`;
  }

  if (intent.action === "note_add") {
    const text = (intent.title ?? "").trim();
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

export function localRoute(text: string): AssistantIntent | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;

  // Заметки
  if (t.startsWith("!")) {
    const body = t.slice(1).trim();
    return body ? { action: "note_add", title: body } : null;
  }
  if ((m = t.match(/^(?:заметка|запиши идею|запомни)[:\s]+(.+)/i))) return { action: "note_add", title: m[1].trim() };

  // Задачи: удалить / выполнить (без дат — можно локально)
  if ((m = t.match(/^удал(?:и|ить)\s+задач[а-яё]*\s+(.+)/i))) return { action: "task_delete", title: m[1].trim() };
  if ((m = t.match(/^(?:выполнил[а-яё]*|сделал[а-яё]*|отметь)\s+(?:задач[а-яё]*\s+)?(.+?)(?:\s+выполненн[а-яё]+)?$/i)))
    return { action: "task_done", title: m[1].trim() };

  // Клиенты: удалить (только имя — безопасно локально)
  if ((m = t.match(/^удал(?:и|ить)\s+клиент[а-яё]*\s+(.+)/i))) return { action: "client_delete", name: m[1].trim() };

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

  // 0) Локальный быстрый разбор — без ИИ (экономия). Частые команды без дат.
  const local = localRoute(text);
  if (local) {
    const a = await performIntent(local, db, uid, tz, text);
    if (a) return a;
  }

  if (!ai) return null;
  const now = nowContext(tz);

  // 1) Иначе — распознавание команды на дешёвой модели (yandexgpt-lite)
  const intent = await routeAssistant(ai, text, now, await db.listLessons(uid));
  let action = await performIntent(intent, db, uid, tz, text);

  // Страховка: явная команда (или голос), но роутер промахнулся → создаём задачу
  if (!action && (forceTask || ACTION_RE.test(text))) {
    const p = await parseTaskFromText(ai, text, now);
    const title = (p?.title || text).trim();
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

  if (kind === "water") {
    const ml = parseWaterMl(phrase) || 250;
    await db.addWater(uid, ml);
    const total = await db.waterTotal(uid, startOfLocalDayIso(tz), startOfLocalDayOffsetIso(tz, 1));
    return `💧 Исправила: +${ml} мл. Сегодня: ${(total / 1000).toFixed(1)} л.${learned}`;
  }
  if (kind === "note") {
    const id = await db.addNote(uid, phrase);
    return `📝 Исправила: заметка\n«${phrase}»${learned}`;
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
    const id = await db.addEvent({ userId: uid, title: phrase, startsAt, location: "", notes: "", clientId: client?.id ?? null });
    await db.setSetting(`last:${uid}`, JSON.stringify({ phrase, kind: "event", id }));
    const cl = client ? `\n🤝 ${client.name}` : "";
    return `📅 Исправила: встреча\n«${phrase}»\n🕒 ${formatEventTime(startsAt, tz)}${cl}${learned}`;
  }
  // задача
  const dueAt = resolveWhen(phrase, tz, 10);
  const clients = await db.listClients(uid);
  const client = mentionedClient(clients, phrase);
  const id = await db.addTask({ title: phrase, creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt, clientId: client?.id ?? null });
  await db.setSetting(`last:${uid}`, JSON.stringify({ phrase, kind: "task", id }));
  const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
  return `✅ Исправила: задача\n«${phrase}»${due}${learned}`;
}

const KIND_RU: Record<string, string> = {
  food: "запись еды",
  event: "встречу",
  task: "задачу",
  note: "заметку",
  water: "воду",
};
