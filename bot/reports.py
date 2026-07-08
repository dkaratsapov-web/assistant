"""Формирование текстовых сводок (дайджест на день, статус клиента)."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from . import db as dbmod
from .config import Config
from .db import Database
from .utils import format_due, platforms_to_text


async def build_digest(db: Database, config: Config, user_id: int, role: str) -> str:
    """Утренняя сводка: задачи на сегодня, просрочка, ближайшие дедлайны."""
    tz = ZoneInfo(config.tz)
    now = datetime.now(tz)
    header = f"📊 Сводка на {now.strftime('%d.%m.%Y')}\n"

    # Владелец видит все задачи, остальные — только свои/назначенные
    assignee = None if role == dbmod.ROLE_OWNER else user_id
    tasks = await db.list_tasks(
        statuses=(dbmod.TASK_OPEN, dbmod.TASK_IN_PROGRESS), assignee_id=assignee
    )

    if not tasks:
        return header + "\nНа сегодня активных задач нет. Отличный момент навести порядок 🙂"

    overdue, today, upcoming, no_due = [], [], [], []
    for t in tasks:
        if not t["due_at"]:
            no_due.append(t)
            continue
        due = datetime.fromisoformat(t["due_at"]).astimezone(tz)
        if due < now:
            overdue.append(t)
        elif due.date() == now.date():
            today.append(t)
        else:
            upcoming.append(t)

    lines = [header]

    def block(title: str, items: list) -> None:
        if not items:
            return
        lines.append(f"\n{title}")
        for t in items[:10]:
            due = format_due(t["due_at"], config.tz)
            due_part = f" — {due}" if due else ""
            lines.append(f"  #{t['id']} {t['title']}{due_part}")
        if len(items) > 10:
            lines.append(f"  …и ещё {len(items) - 10}")

    block("⚠️ Просрочено:", overdue)
    block("🔥 Сегодня:", today)
    block("📅 Ближайшие:", upcoming[:5] if upcoming else [])
    block("📌 Без дедлайна:", no_due[:5] if no_due else [])

    total = len(tasks)
    lines.append(f"\nВсего активных задач: {total}")
    return "\n".join(lines)


async def build_clients_overview(db: Database) -> str:
    clients = await db.list_clients()
    if not clients:
        return "Клиентов пока нет. Добавь первого через /addclient."
    active = [c for c in clients if c["status"] == "active"]
    paused = [c for c in clients if c["status"] != "active"]
    lines = [f"👥 Клиенты ({len(clients)})\n"]
    for c in active:
        lines.append(f"🟢 #{c['id']} {c['name']} — {platforms_to_text(c['platforms'])}")
    for c in paused:
        lines.append(f"⏸ #{c['id']} {c['name']} — {platforms_to_text(c['platforms'])}")
    lines.append("\nОткрыть карточку: /client <номер>")
    return "\n".join(lines)
