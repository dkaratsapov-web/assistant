/**
 * Единая логика «ассистент выполняет команду»: распознаёт намерение (задача/встреча/контакт)
 * и создаёт запись в БД. Используется и в Mini App (/api/ai), и в боте (текст/голос),
 * чтобы поведение было одинаковым.
 */
import { AssistantIntent, parseTaskFromText, routeAssistant } from "./ai";
import { DB } from "./db";
import { Env, SCOPE_PERSONAL, SCOPE_WORK } from "./types";
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
  if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) return null;
  const tz = tzOffsetOf(env);
  const model = env.YANDEX_MODEL ?? "yandexgpt/latest";
  const now = nowContext(tz);

  const intent = await routeAssistant(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, text, now, model);
  let action = await performIntent(intent, db, uid, tz);

  // Страховка: явная команда (или голос), но роутер промахнулся → создаём задачу
  if (!action && (forceTask || ACTION_RE.test(text))) {
    const p = await parseTaskFromText(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, text, now, model);
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
