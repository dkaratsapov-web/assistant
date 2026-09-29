/**
 * Ответы на вопросы о СВОИХ записях: «что у меня завтра?», «какие задачи по
 * Ромашке?», «что просрочено?», «что я сделал на этой неделе?».
 *
 * Зачем отдельно. Раньше такие вопросы уходили в свободный чат, и Сара отвечала,
 * не заглядывая в базу — то есть придумывала. Это первое, что спрашивают у
 * ассистента, и хуже выдуманного ответа тут ничего нет.
 *
 * Ответ собирается из базы кодом, а не моделью: на одних и тех же данных он
 * всегда одинаковый и всегда правдивый.
 */
import { DB } from "./db";
import { Event, SCOPE_PERSONAL, SCOPE_WORK, Task, TASK_DONE, TASK_IN_PROGRESS, TASK_OPEN } from "./types";
import { formatDue, formatEventTime, startOfLocalDayOffsetIso, WB_END } from "./utils";

export type AskKind = "agenda" | "tasks" | "events" | "clients" | "notes" | "stats";
export type AskPeriod = "" | "today" | "tomorrow" | "week" | "month" | "overdue";

export interface Ask {
  kind: AskKind;
  period: AskPeriod;
  client?: string;
  scope?: string;
}

/**
 * Это вопрос, а не команда? «покажи задачи» — да, «закрой задачу» — нет.
 *
 * Граница слова берётся из utils, а не \b: в JavaScript \b не считает кириллицу
 * буквами, поэтому /покажи\b/ на «покажи задачи» молча не срабатывает.
 */
const QUESTION_RE = new RegExp(
  `^(?:что|чего|чем|какие|какая|какой|каких|сколько|когда|где|кто|покажи|показать|список|выведи|скинь|дай|перечисли|остал[оа]сь|есть\\s+ли)${WB_END}`,
  "i"
);

/**
 * Разбирает вопрос без обращения к ИИ. Возвращает null, если это не вопрос о
 * записях — тогда фраза пойдёт дальше обычным путём.
 */
export function parseQuery(text: string, force = false): Ask | null {
  const t = String(text ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (!t) return null;
  // Без `force` требуем явный признак вопроса: иначе «закрой задачу» тоже
  // считалось бы вопросом про задачи. `force` включают, когда вопрос уже
  // распознал ИИ и переспрашивать формулировку незачем.
  if (!force && !(QUESTION_RE.test(t) || t.endsWith("?"))) return null;

  const period: AskPeriod =
    /(просроч|горит|проспал|опазд|задолжал)/.test(t) ? "overdue"
      : /послезавтра/.test(t) ? "week"
      : /завтра/.test(t) ? "tomorrow"
      : /(сегодня|на сегодня|на день)/.test(t) ? "today"
      : /(недел|7 дней|семь дней)/.test(t) ? "week"
      : /(месяц|30 дней)/.test(t) ? "month"
      : "";

  const kind: AskKind =
    /(сделал|закрыл|успел|итог|статистик|выполнил|прогресс)/.test(t) ? "stats"
      : /(клиент|заказчик)/.test(t) && !/(задач|встреч)/.test(t) ? "clients"
        : /заметк/.test(t) ? "notes"
          : /(встреч|созвон|календар|событи)/.test(t) && !/задач/.test(t) ? "events"
            : /(задач|дел[аое]|дела|тудушк)/.test(t) ? "tasks"
              : period ? "agenda"
                : "agenda";

  // «что у меня вообще есть» без периода — покажем ближайшее
  const scope = /(личн)/.test(t) ? SCOPE_PERSONAL : /(рабоч|по работе)/.test(t) ? SCOPE_WORK : undefined;
  return { kind, period, scope };
}

/** Границы периода в UTC: [от, до). Пустой период — ближайшие 7 дней. */
function bounds(period: AskPeriod, tz: number): { from: string; to: string } {
  const day = (n: number) => startOfLocalDayOffsetIso(tz, n);
  if (period === "today") return { from: day(0), to: day(1) };
  if (period === "tomorrow") return { from: day(1), to: day(2) };
  if (period === "week") return { from: day(0), to: day(7) };
  if (period === "month") return { from: day(0), to: day(31) };
  return { from: day(0), to: day(7) };
}

const PERIOD_RU: Record<AskPeriod, string> = {
  "": "на ближайшие дни",
  today: "на сегодня",
  tomorrow: "на завтра",
  week: "на неделю",
  month: "на месяц",
  overdue: "просроченные",
};

const taskLine = (t: Task, tz: number) => {
  const due = t.due_at ? ` — ${formatDue(t.due_at, tz)}` : "";
  const mark = t.status === TASK_IN_PROGRESS ? "🔸" : "•";
  return `${mark} ${t.title}${due}`;
};

const eventLine = (e: Event, tz: number) => `• ${e.title} — ${formatEventTime(e.starts_at, tz)}${e.location ? ` · ${e.location}` : ""}`;

/**
 * Собирает ответ. `clientName` — если вопрос про конкретного клиента
 * («какие задачи по Ромашке»): его определяет вызывающий код, он же знает
 * про клиентов пользователя.
 */
export async function answerQuery(
  db: DB,
  uid: number,
  tz: number,
  ask: Ask,
  client: { id: number; name: string } | null = null
): Promise<string> {
  const { from, to } = bounds(ask.period, tz);
  const now = new Date().toISOString();
  const forClient = client ? ` по клиенту ${client.name}` : "";

  if (ask.kind === "clients") {
    const clients = await db.listClients(uid);
    if (!clients.length) return "Клиентов пока нет. Скажи «добавь клиента …» — заведу карточку.";
    const lines = clients.map((c) => `• ${c.name}${c.platforms ? ` — ${c.platforms}` : ""}`);
    return `🤝 Клиентов: ${clients.length}\n${lines.join("\n")}`;
  }

  if (ask.kind === "notes") {
    const notes = await db.listNotes(uid, 10);
    if (!notes.length) return "Заметок пока нет. Скажи «запиши идею: …» — сохраню.";
    return `📝 Последние заметки:\n${notes.map((n) => `• ${n.text}`).join("\n")}`;
  }

  if (ask.kind === "stats") {
    const done = (await db.listTasks({ statuses: [TASK_DONE], visibleTo: uid }))
      .filter((t) => t.done_at && t.done_at >= from && t.done_at < to);
    const open = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], visibleTo: uid });
    const overdue = open.filter((t) => t.due_at && t.due_at < now);
    const word = PERIOD_RU[ask.period] === "просроченные" ? "за последнее время" : PERIOD_RU[ask.period];
    if (!done.length) return `Закрытых задач ${word} пока нет. В работе — ${open.length}.`;
    const lines = done.slice(0, 10).map((t) => `✅ ${t.title}`);
    const more = done.length > 10 ? `\n…и ещё ${done.length - 10}` : "";
    return `📊 Сделано ${word}: ${done.length}\n${lines.join("\n")}${more}\n\nВ работе: ${open.length}${overdue.length ? ` · просрочено: ${overdue.length}` : ""}`;
  }

  if (ask.kind === "events") {
    let events = await db.listEvents(uid, from);
    events = events.filter((e) => e.starts_at < to);
    if (client) events = events.filter((e) => e.client_id === client.id);
    if (!events.length) return `Встреч ${PERIOD_RU[ask.period]}${forClient} нет.`;
    return `📅 Встречи ${PERIOD_RU[ask.period]}${forClient}: ${events.length}\n${events.map((e) => eventLine(e, tz)).join("\n")}`;
  }

  // Задачи и общая повестка считают задачи одинаково
  let tasks = await db.listTasks({
    statuses: [TASK_OPEN, TASK_IN_PROGRESS],
    visibleTo: uid,
    scope: ask.scope ?? null,
    clientId: client?.id ?? null,
  });

  if (ask.period === "overdue") {
    tasks = tasks.filter((t) => t.due_at && t.due_at < now);
    if (!tasks.length) return `Просроченного нет${forClient}. Всё по плану ✦`;
    return `⚠️ Просрочено${forClient}: ${tasks.length}\n${tasks.map((t) => taskLine(t, tz)).join("\n")}`;
  }

  if (ask.kind === "tasks") {
    // Вопрос про клиента или без периода — показываем все активные, а не только срочные
    const byPeriod = ask.period ? tasks.filter((t) => t.due_at && t.due_at >= from && t.due_at < to) : tasks;
    const list = byPeriod.length ? byPeriod : tasks;
    if (!list.length) return `Задач${forClient} ${ask.period ? PERIOD_RU[ask.period] : ""} нет.`.replace(/\s+/g, " ");
    const head = ask.period && byPeriod.length ? `✅ Задачи ${PERIOD_RU[ask.period]}${forClient}` : `✅ Активные задачи${forClient}`;
    const overdue = list.filter((t) => t.due_at && t.due_at < now).length;
    const tail = overdue ? `\n\n⚠️ Из них просрочено: ${overdue}` : "";
    return `${head}: ${list.length}\n${list.slice(0, 15).map((t) => taskLine(t, tz)).join("\n")}${tail}`;
  }

  // agenda — задачи и встречи вместе
  const dueSoon = tasks.filter((t) => t.due_at && t.due_at >= from && t.due_at < to);
  const overdue = tasks.filter((t) => t.due_at && t.due_at < now);
  let events = await db.listEvents(uid, from);
  events = events.filter((e) => e.starts_at < to);
  if (client) events = events.filter((e) => e.client_id === client.id);

  const parts: string[] = [];
  if (overdue.length && ask.period !== "tomorrow") parts.push(`⚠️ Просрочено: ${overdue.length}\n${overdue.map((t) => taskLine(t, tz)).join("\n")}`);
  if (events.length) parts.push(`📅 Встречи\n${events.map((e) => eventLine(e, tz)).join("\n")}`);
  if (dueSoon.length) parts.push(`✅ Задачи\n${dueSoon.map((t) => taskLine(t, tz)).join("\n")}`);
  if (!parts.length) {
    const free = ask.period === "tomorrow" ? "Завтра" : ask.period === "today" ? "Сегодня" : "В ближайшие дни";
    return `${free} ничего не запланировано. Свободно ✦${tasks.length ? `\n\nБез срока висит задач: ${tasks.length}` : ""}`;
  }
  return `Что ${PERIOD_RU[ask.period]}${forClient}:\n\n${parts.join("\n\n")}`;
}
