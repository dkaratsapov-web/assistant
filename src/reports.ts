import { DB } from "./db";
import { ROLE_OWNER, TASK_IN_PROGRESS, TASK_OPEN, Task } from "./types";
import { formatDue, formatEventTime, platformsToText, startOfLocalDayOffsetIso } from "./utils";

const MEAL_LABELS: [string, string][] = [
  ["breakfast", "🌅 Завтрак"],
  ["lunch", "☀️ Обед"],
  ["dinner", "🌙 Ужин"],
  ["snack", "🍎 Перекус"],
  ["", "🍽 Другое"],
];

/**
 * Текстовая сводка по питанию за день (dayOffset: 0 — сегодня, -1 — вчера).
 * Готова к пересылке тренеру.
 */
export async function buildNutritionSummary(db: DB, userId: number, tz: number, dayOffset: number): Promise<string> {
  const start = startOfLocalDayOffsetIso(tz, dayOffset);
  const end = startOfLocalDayOffsetIso(tz, dayOffset + 1);
  const local = new Date(new Date(start).getTime() + tz * 3600_000);
  const dateLabel = local.toLocaleDateString("ru-RU", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" });

  const entries = await db.listFood(userId, start, end);
  const water = await db.waterTotal(userId, start, end);
  const weights = await db.listWeights(userId, 30);
  const weightForDay = weights.find((w) => w.ts >= start && w.ts < end);

  const header = `🍽 Питание за ${dateLabel}`;
  if (!entries.length && !water) return `${header}\n\nЗа этот день записей нет.`;

  const kcal = entries.reduce((s, e) => s + e.kcal, 0);
  const p = entries.reduce((s, e) => s + e.protein, 0);
  const f = entries.reduce((s, e) => s + e.fat, 0);
  const c = entries.reduce((s, e) => s + e.carbs, 0);

  const lines = [header, ""];
  for (const [key, label] of MEAL_LABELS) {
    const items = entries.filter((e) => (e.meal || "") === key);
    if (!items.length) continue;
    const sub = items.reduce((s, e) => s + e.kcal, 0);
    lines.push(`${label} — ${sub} ккал`);
    items.forEach((e) => lines.push(`• ${e.title} — ${e.kcal} ккал`));
    lines.push("");
  }
  lines.push(`Итого: ${kcal} ккал · Б ${p} · Ж ${f} · У ${c} г`);
  lines.push(`💧 Вода: ${(water / 1000).toFixed(1)} л`);
  if (weightForDay) lines.push(`⚖️ Вес: ${weightForDay.kg} кг`);
  return lines.join("\n");
}

/** Утренняя сводка: просрочка, сегодня, ближайшие, без дедлайна. */
export async function buildDigest(db: DB, userId: number, role: string, tzOffset: number): Promise<string> {
  const nowLocal = new Date(Date.now() + tzOffset * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const header = `📊 Сводка на ${pad(nowLocal.getUTCDate())}.${pad(nowLocal.getUTCMonth() + 1)}.${nowLocal.getUTCFullYear()}\n`;

  // Сводка всегда личная: каждый видит только свои задачи, включая владельца
  const tasks = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], visibleTo: userId });

  if (!tasks.length) {
    return header + "\nНа сегодня активных задач нет. Отличный момент навести порядок 🙂";
  }

  const overdue: Task[] = [];
  const today: Task[] = [];
  const upcoming: Task[] = [];
  const noDue: Task[] = [];
  const nowMs = Date.now();
  const todayLocalDay = Math.floor(nowLocal.getTime() / 86400_000);

  for (const t of tasks) {
    if (!t.due_at) {
      noDue.push(t);
      continue;
    }
    const dueMs = new Date(t.due_at).getTime();
    const dueLocalDay = Math.floor((dueMs + tzOffset * 3600_000) / 86400_000);
    if (dueMs < nowMs) overdue.push(t);
    else if (dueLocalDay === todayLocalDay) today.push(t);
    else upcoming.push(t);
  }

  const lines: string[] = [header];
  const block = (title: string, items: Task[], limit = 10) => {
    if (!items.length) return;
    lines.push(`\n${title}`);
    for (const t of items.slice(0, limit)) {
      const due = formatDue(t.due_at, tzOffset);
      lines.push(`  #${t.id} ${t.title}${due ? ` — ${due}` : ""}`);
    }
    if (items.length > limit) lines.push(`  …и ещё ${items.length - limit}`);
  };

  block("⚠️ Просрочено:", overdue);
  block("🔥 Сегодня:", today);
  block("📅 Ближайшие:", upcoming, 5);
  block("📌 Без дедлайна:", noDue, 5);

  // Встречи на сегодня
  const events = await db.listEvents(userId, new Date().toISOString());
  const todaysEvents = events.filter((e) => {
    const dueLocalDay = Math.floor((new Date(e.starts_at).getTime() + tzOffset * 3600_000) / 86400_000);
    return dueLocalDay === todayLocalDay;
  });
  if (todaysEvents.length) {
    lines.push("\n🗓 Встречи сегодня:");
    for (const e of todaysEvents.slice(0, 8)) {
      lines.push(`  ${formatEventTime(e.starts_at, tzOffset)} — ${e.title}${e.location ? ` (${e.location})` : ""}`);
    }
  }

  lines.push(`\nВсего активных задач: ${tasks.length}`);
  return lines.join("\n");
}

export async function buildClientsOverview(db: DB): Promise<string> {
  const clients = await db.listClients();
  if (!clients.length) return "Клиентов пока нет. Добавь первого через /addclient.";
  const lines = [`👥 Клиенты (${clients.length})\n`];
  for (const c of clients.filter((c) => c.status === "active")) {
    lines.push(`🟢 #${c.id} ${c.name} — ${platformsToText(c.platforms)}`);
  }
  for (const c of clients.filter((c) => c.status !== "active")) {
    lines.push(`⏸ #${c.id} ${c.name} — ${platformsToText(c.platforms)}`);
  }
  lines.push("\nОткрыть карточку: /client <номер>");
  return lines.join("\n");
}
