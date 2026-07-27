import { DB } from "./db";
import { ROLE_OWNER, TASK_IN_PROGRESS, TASK_OPEN, Task } from "./types";
import { formatDue, platformsToText } from "./utils";

/** Утренняя сводка: просрочка, сегодня, ближайшие, без дедлайна. */
export async function buildDigest(db: DB, userId: number, role: string, tzOffset: number): Promise<string> {
  const nowLocal = new Date(Date.now() + tzOffset * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const header = `📊 Сводка на ${pad(nowLocal.getUTCDate())}.${pad(nowLocal.getUTCMonth() + 1)}.${nowLocal.getUTCFullYear()}\n`;

  const assignee = role === ROLE_OWNER ? null : userId;
  const tasks = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], assigneeId: assignee });

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
