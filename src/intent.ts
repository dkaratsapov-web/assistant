/**
 * Единая логика «ассистент выполняет команду»: распознаёт намерение (задача/встреча/контакт)
 * и создаёт запись в БД. Используется и в Mini App (/api/ai), и в боте (текст/голос),
 * чтобы поведение было одинаковым.
 */
import { AssistantIntent, parseTaskFromText, routeAssistant } from "./ai";
import { DB } from "./db";
import { Env, SCOPE_PERSONAL, SCOPE_WORK, TASK_DONE } from "./types";
import { formatDue, formatEventTime, nowContext, resolveWhen, tzOffsetOf } from "./utils";

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
    const id = await db.addClient(name, (intent.platforms ?? "").trim(), (intent.budget ?? "").trim());
    const extra = [intent.platforms, intent.budget ? `бюджет ${intent.budget}` : ""].filter(Boolean).join(" · ");
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
    const fields: { name?: string; platforms?: string; budget?: string } = {};
    if (intent.new_name && intent.new_name.trim()) fields.name = intent.new_name.trim();
    if (intent.platforms && intent.platforms.trim()) fields.platforms = intent.platforms.trim();
    if (intent.budget && intent.budget.trim()) fields.budget = intent.budget.trim();
    if (!Object.keys(fields).length) return `Что изменить у клиента «${client.name}»? Укажи новое название, площадки или бюджет.`;
    await db.updateClient(client.id, fields);
    const changes = [fields.name && `название → ${fields.name}`, fields.platforms && `площадки → ${fields.platforms}`, fields.budget && `бюджет → ${fields.budget}`].filter(Boolean).join(", ");
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
  if (!env.ANTHROPIC_API_KEY) return null;
  const tz = tzOffsetOf(env);
  const now = nowContext(tz);

  // Распознавание команды — на дешёвой модели (ROUTER_MODEL по умолчанию)
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
