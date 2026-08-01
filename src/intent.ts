/**
 * Единая логика «ассистент выполняет команду»: распознаёт намерение (задача/встреча/контакт)
 * и создаёт запись в БД. Используется и в Mini App (/api/ai), и в боте (текст/голос),
 * чтобы поведение было одинаковым.
 */
import { AssistantIntent, estimateBurn, estimateNutrition, parseTaskFromText, routeAssistant } from "./ai";
import { DB } from "./db";
import { Env, SCOPE_PERSONAL, SCOPE_WORK, TASK_DONE } from "./types";
import { formatDue, formatEventTime, matchWaterMl, mealByHour, mealFromText, nowContext, parseWaterMl, resolveWhen, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf } from "./utils";

const MEAL_RU: Record<string, string> = { breakfast: "завтрак", lunch: "обед", dinner: "ужин", snack: "перекус" };

const FOOD_RE = /(съел\w*|поел\w*|скушал\w*|позавтракал\w*|пообедал\w*|поужинал\w*|перекусил\w*|на завтрак|на обед|на ужин|съесть)/i;

/** Выполняет распознанное намерение. Возвращает подтверждение или null (если это не команда). */
export async function performIntent(
  intent: AssistantIntent | null,
  db: DB,
  uid: number,
  tz: number
): Promise<string | null> {
  if (!intent || intent.action === "none") return null;

  if (intent.action === "task") {
    const title = (intent.title ?? "").trim();
    if (!title) return null;
    const dueAt = intent.due ? resolveWhen(intent.due, tz, 10) : null;
    const scope = intent.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
    const id = await db.addTask({ title, creatorId: uid, assigneeId: uid, scope, dueAt });
    const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
    const sc = scope === SCOPE_PERSONAL ? "🙋 Личная" : "💼 Рабочая";
    return `✅ Добавила задачу #${id}\n«${title}»\n${sc}${due}`;
  }

  if (intent.action === "task_done") {
    const q = (intent.title ?? "").trim();
    if (!q) return null;
    const task = await db.findTaskByTitle(q);
    if (!task) return `Не нашла активную задачу «${q}».`;
    await db.setTaskStatus(task.id, TASK_DONE);
    return `✅ Задача #${task.id} «${task.title}» отмечена выполненной. Молодец!`;
  }

  if (intent.action === "task_delete") {
    const q = (intent.title ?? "").trim();
    if (!q) return null;
    const task = await db.findTaskByTitle(q);
    if (!task) return `Не нашла задачу «${q}».`;
    await db.deleteTask(task.id);
    return `🗑 Задача #${task.id} «${task.title}» удалена.`;
  }

  if (intent.action === "event") {
    const title = (intent.title ?? "").trim();
    if (!title) return null;
    const startsAt = intent.at ? resolveWhen(intent.at, tz, 12) : null;
    if (!startsAt) {
      // время не распозналось — не теряем задумку, заводим как задачу
      const id = await db.addTask({ title: `Встреча: ${title}`, creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt: null });
      return `📝 Добавила как задачу #${id}: «Встреча: ${title}» — не поняла точное время. Скажи время, и перенесу в календарь.`;
    }
    const id = await db.addEvent({ userId: uid, title, startsAt, location: intent.location ?? "", notes: "" });
    const loc = intent.location ? `\n📍 ${intent.location}` : "";
    return `📅 Встреча добавлена (#${id})\n«${title}»\n🕒 ${formatEventTime(startsAt, tz)}${loc}`;
  }

  if (intent.action === "event_delete") {
    const q = (intent.title ?? "").trim();
    if (!q) return null;
    const ev = await db.findEventByTitle(uid, q);
    if (!ev) return `Не нашла встречу «${q}».`;
    await db.deleteEvent(ev.id, uid);
    return `🗑 Встреча #${ev.id} «${ev.title}» отменена.`;
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
    const id = await db.addContact({ userId: uid, name, birthday, phone: "", notes: "" });
    const bd = birthday ? `\n🎂 ${birthday}` : "";
    return `👤 Контакт добавлен (#${id})\n${name}${bd}`;
  }

  if (intent.action === "client_add") {
    const name = (intent.name ?? intent.title ?? "").trim();
    if (!name) return null;
    const id = await db.addClient(name, (intent.platforms ?? "").trim(), (intent.budget ?? "").trim(), {
      payAmount: (intent.fee ?? "").trim(),
      payDue: (intent.pay_due ?? "").trim(),
    });
    const extra = [
      intent.platforms,
      intent.budget ? `бюджет ${intent.budget}` : "",
      intent.fee ? `ведение ${intent.fee}` : "",
      intent.pay_due ? `оплата ${intent.pay_due}` : "",
    ].filter(Boolean).join(" · ");
    return `🤝 Клиент добавлен (#${id})\n${name}${extra ? `\n${extra}` : ""}`;
  }

  if (intent.action === "client_delete") {
    const name = (intent.name ?? intent.title ?? "").trim();
    if (!name) return null;
    const client = await db.findClientByName(name);
    if (!client) return `Не нашла клиента «${name}». Проверь название — точнее: /clients в боте.`;
    await db.deleteClient(client.id);
    return `🗑 Клиент удалён: ${client.name} (#${client.id})`;
  }

  if (intent.action === "client_edit") {
    const name = (intent.name ?? "").trim();
    if (!name) return null;
    const client = await db.findClientByName(name);
    if (!client) return `Не нашла клиента «${name}».`;
    const fields: { name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string } = {};
    if (intent.new_name && intent.new_name.trim()) fields.name = intent.new_name.trim();
    if (intent.platforms && intent.platforms.trim()) fields.platforms = intent.platforms.trim();
    if (intent.budget && intent.budget.trim()) fields.budget = intent.budget.trim();
    if (intent.fee && intent.fee.trim()) fields.payAmount = intent.fee.trim();
    if (intent.pay_due && intent.pay_due.trim()) fields.payDue = intent.pay_due.trim();
    if (!Object.keys(fields).length) return `Что изменить у клиента «${client.name}»? Укажи название, площадки, бюджет, сумму ведения или дедлайн оплаты.`;
    await db.updateClient(client.id, fields);
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
    return `📝 Заметка сохранена (#${id})\n«${text}»`;
  }

  return null;
}

const ACTION_RE = /(добав|запланир|напомн|созда|запиш|поставь|встреч|созвон|перезвон|позвон|купить|заплан)/i;

/**
 * Локальный разбор частых команд БЕЗ обращения к ИИ (экономия расхода).
 * Возвращает намерение для однозначных шаблонов без дат, иначе null (тогда — Claude).
 */
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
  if ((m = t.match(/^удал(?:и|ить)\s+задач\w*\s+(.+)/i))) return { action: "task_delete", title: m[1].trim() };
  if ((m = t.match(/^(?:выполнил\w*|сделал\w*|отметь)\s+(?:задач\w*\s+)?(.+?)(?:\s+выполненн\w+)?$/i)))
    return { action: "task_done", title: m[1].trim() };

  // Клиенты: удалить (только имя — безопасно локально)
  if ((m = t.match(/^удал(?:и|ить)\s+клиент\w*\s+(.+)/i))) return { action: "client_delete", name: m[1].trim() };

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
  const dayStart = startOfLocalDayIso(tz);
  const dayEnd = startOfLocalDayOffsetIso(tz, 1);

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
  const wM = text.match(/\bвес\w*\s*[—:\-]?\s*(\d{2,3}(?:[.,]\d)?)/i) || text.match(/взвес\w+\D{0,6}(\d{2,3}(?:[.,]\d)?)/i);
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
  if ((am = text.match(/(?:сж[её]г|сожгла|потратил\w*)\s*(\d{2,4})\s*ккал/i))) {
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
  if ((am = text.match(/цел\w*\D{0,15}(\d{1,2})\D{0,15}трениров/i)) || (am = text.match(/(\d{1,2})\s*трениров\w*\s*в\s*недел/i))) {
    const n = parseInt(am[1], 10);
    if (n >= 1 && n <= 21) { await db.setSetting(`wgoal:${uid}`, String(n)); return `🎯 Цель: ${n} трениров${n === 1 ? "ка" : n < 5 ? "ки" : "ок"} в неделю.`; }
  }
  // Тренировка/активность
  if (/(трениров|пробежк|побегал|качал|\bзал\b|йог|плавал|велосипед|отжим|присед|заняти|кардио|силов|растяж|планк)/i.test(text) && env.ANTHROPIC_API_KEY) {
    const kc = (await estimateBurn(env.ANTHROPIC_API_KEY, text)) ?? 0;
    let dur = 0;
    let dm;
    if ((dm = text.match(/(\d{1,3})\s*(?:мин|минут)/i))) dur = parseInt(dm[1], 10);
    else if ((dm = text.match(/(\d{1,2})\s*(?:час|ч)\b/i))) dur = parseInt(dm[1], 10) * 60;
    const low = text.toLowerCase();
    const type = /(бег|пробежк|кардио|велосипед|плаван|ходьб)/.test(low) ? "кардио"
      : /(силов|качал|\bзал\b|штанг|жим|присед|отжим|турник)/.test(low) ? "силовая"
      : /(йог|растяж|стретч|планк)/.test(low) ? "растяжка"
      : "другое";
    await db.addActivity(uid, text.slice(0, 80), kc, type, dur);
    return `🏋️ Тренировка записана: ${text.slice(0, 60)}${dur ? ` · ${dur} мин` : ""}${kc ? ` · ~${kc} ккал` : ""}.`;
  }
  if ((am = text.match(/спал\w*\s*(\d{1,2}(?:[.,]\d)?)\s*час/i))) {
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
  const hasMealWord = /(завтрак|обед|ужин|перекус|полдник)/i.test(text);
  const notOtherEntity = !/(встреч|созвон|задач|клиент|напомни|перезвон|позвон|заплан)/i.test(text);
  const looksLikeFood = notOtherEntity && (FOOD_RE.test(text) || (hasMealWord && /(добав|запиш|плюс|учти|засчита|занеси|внеси)/i.test(text)));
  if (looksLikeFood) {
    if (!env.ANTHROPIC_API_KEY) return null;
    const n = await estimateNutrition(env.ANTHROPIC_API_KEY, text);
    if (n) {
      const localHour = new Date(Date.now() + tz * 3600_000).getUTCHours();
      const meal = mealFromText(text) || mealByHour(localHour);
      await db.addFood(uid, { ...n, meal });
      return `🍽 Записала (${MEAL_RU[meal]}): ${n.title}\n🔥 ${n.kcal} ккал · Б ${n.protein} · Ж ${n.fat} · У ${n.carbs} г`;
    }
  }

  // 0) Локальный быстрый разбор — без ИИ (экономия). Частые команды без дат.
  const local = localRoute(text);
  if (local) {
    const a = await performIntent(local, db, uid, tz);
    if (a) return a;
  }

  if (!env.ANTHROPIC_API_KEY) return null;
  const now = nowContext(tz);

  // 1) Иначе — распознавание команды на дешёвой модели (ROUTER_MODEL)
  const intent = await routeAssistant(env.ANTHROPIC_API_KEY, text, now);
  let action = await performIntent(intent, db, uid, tz);

  // Страховка: явная команда (или голос), но роутер промахнулся → создаём задачу
  if (!action && (forceTask || ACTION_RE.test(text))) {
    const p = await parseTaskFromText(env.ANTHROPIC_API_KEY, text, now);
    const title = (p?.title || text).trim();
    if (title) {
      const dueAt = p?.due ? resolveWhen(p.due, tz, 10) : resolveWhen(text, tz, 10);
      const scope = p?.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
      const id = await db.addTask({ title, creatorId: uid, assigneeId: uid, scope, dueAt });
      const due = dueAt ? `\n⏰ ${formatDue(dueAt, tz)}` : "";
      const sc = scope === SCOPE_PERSONAL ? "🙋 Личная" : "💼 Рабочая";
      action = `✅ Добавила задачу #${id}\n«${title}»\n${sc}${due}`;
    }
  }
  return action;
}
