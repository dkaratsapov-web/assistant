"""Слой работы с SQLite (async, aiosqlite).

Хранит пользователей, клиентов/проекты, задачи и заметки.
Всё локально в одном файле — ничего внешнего настраивать не нужно.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

import aiosqlite

# Роли пользователей
ROLE_OWNER = "owner"      # владелец, полные права (задаётся через OWNER_ID)
ROLE_MEMBER = "member"    # команда: свои задачи, заметки, видит клиентов
ROLE_CLIENT = "client"    # клиент: только просмотр статуса своих проектов
ROLE_PENDING = "pending"  # запросил доступ, ждёт подтверждения владельца

# Статусы задач
TASK_OPEN = "open"
TASK_IN_PROGRESS = "in_progress"
TASK_DONE = "done"

TASK_STATUS_LABELS = {
    TASK_OPEN: "🔵 Открыта",
    TASK_IN_PROGRESS: "🟡 В работе",
    TASK_DONE: "✅ Готово",
}

# Площадки для клиентов (маркетинговые каналы)
PLATFORMS = {
    "direct": "Яндекс Директ",
    "google": "Google Ads",
    "tg": "Telegram Ads",
    "vk": "VK Реклама",
    "avito": "Авито",
    "site": "Сайт",
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: str):
        self.path = path
        self._db: Optional[aiosqlite.Connection] = None

    async def connect(self) -> None:
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._db = await aiosqlite.connect(self.path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA foreign_keys = ON")
        await self._init_schema()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("База данных не подключена. Вызови connect().")
        return self._db

    async def _init_schema(self) -> None:
        await self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id     INTEGER PRIMARY KEY,
                username    TEXT,
                full_name   TEXT,
                role        TEXT NOT NULL DEFAULT 'pending',
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS clients (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                platforms   TEXT DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'active',
                budget      TEXT DEFAULT '',
                contact     TEXT DEFAULT '',
                notes       TEXT DEFAULT '',
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                title        TEXT NOT NULL,
                description  TEXT DEFAULT '',
                client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
                creator_id   INTEGER NOT NULL,
                assignee_id  INTEGER,
                status       TEXT NOT NULL DEFAULT 'open',
                priority     INTEGER NOT NULL DEFAULT 0,
                due_at       TEXT,
                created_at   TEXT NOT NULL,
                done_at      TEXT,
                reminded_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS notes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                text        TEXT NOT NULL,
                tags        TEXT DEFAULT '',
                created_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
            CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
            """
        )
        await self.db.commit()

    # ---------- Пользователи ----------

    async def ensure_owner(self, owner_id: int) -> None:
        """Гарантирует, что владелец есть в базе с ролью owner."""
        row = await self._fetchone("SELECT role FROM users WHERE user_id = ?", (owner_id,))
        if row is None:
            await self.db.execute(
                "INSERT INTO users (user_id, role, created_at) VALUES (?, ?, ?)",
                (owner_id, ROLE_OWNER, _utcnow()),
            )
        elif row["role"] != ROLE_OWNER:
            await self.db.execute(
                "UPDATE users SET role = ? WHERE user_id = ?", (ROLE_OWNER, owner_id)
            )
        await self.db.commit()

    async def get_user(self, user_id: int) -> Optional[aiosqlite.Row]:
        return await self._fetchone("SELECT * FROM users WHERE user_id = ?", (user_id,))

    async def upsert_user_profile(
        self, user_id: int, username: str | None, full_name: str | None
    ) -> None:
        """Обновляет username/имя, не трогая роль. Не создаёт новых пользователей."""
        await self.db.execute(
            "UPDATE users SET username = ?, full_name = ? WHERE user_id = ?",
            (username, full_name, user_id),
        )
        await self.db.commit()

    async def request_access(
        self, user_id: int, username: str | None, full_name: str | None
    ) -> None:
        """Регистрирует нового пользователя со статусом pending."""
        await self.db.execute(
            """
            INSERT INTO users (user_id, username, full_name, role, created_at)
            VALUES (?, ?, ?, 'pending', ?)
            ON CONFLICT(user_id) DO UPDATE SET username = excluded.username,
                                               full_name = excluded.full_name
            """,
            (user_id, username, full_name, _utcnow()),
        )
        await self.db.commit()

    async def set_role(self, user_id: int, role: str) -> None:
        await self.db.execute(
            "UPDATE users SET role = ? WHERE user_id = ?", (role, user_id)
        )
        await self.db.commit()

    async def delete_user(self, user_id: int) -> None:
        await self.db.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
        await self.db.commit()

    async def list_users(self, role: str | None = None) -> list[aiosqlite.Row]:
        if role:
            return await self._fetchall(
                "SELECT * FROM users WHERE role = ? ORDER BY created_at", (role,)
            )
        return await self._fetchall("SELECT * FROM users ORDER BY created_at")

    # ---------- Клиенты ----------

    async def add_client(
        self,
        name: str,
        platforms: str = "",
        status: str = "active",
        budget: str = "",
        contact: str = "",
        notes: str = "",
    ) -> int:
        cur = await self.db.execute(
            """
            INSERT INTO clients (name, platforms, status, budget, contact, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (name, platforms, status, budget, contact, notes, _utcnow()),
        )
        await self.db.commit()
        return cur.lastrowid

    async def get_client(self, client_id: int) -> Optional[aiosqlite.Row]:
        return await self._fetchone("SELECT * FROM clients WHERE id = ?", (client_id,))

    async def list_clients(self, status: str | None = None) -> list[aiosqlite.Row]:
        if status:
            return await self._fetchall(
                "SELECT * FROM clients WHERE status = ? ORDER BY name", (status,)
            )
        return await self._fetchall("SELECT * FROM clients ORDER BY name")

    async def update_client_status(self, client_id: int, status: str) -> None:
        await self.db.execute(
            "UPDATE clients SET status = ? WHERE id = ?", (status, client_id)
        )
        await self.db.commit()

    async def delete_client(self, client_id: int) -> None:
        await self.db.execute("DELETE FROM clients WHERE id = ?", (client_id,))
        await self.db.commit()

    # ---------- Задачи ----------

    async def add_task(
        self,
        title: str,
        creator_id: int,
        description: str = "",
        client_id: int | None = None,
        assignee_id: int | None = None,
        priority: int = 0,
        due_at: str | None = None,
    ) -> int:
        cur = await self.db.execute(
            """
            INSERT INTO tasks
                (title, description, client_id, creator_id, assignee_id, priority, due_at, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
            """,
            (title, description, client_id, creator_id, assignee_id, priority, due_at, _utcnow()),
        )
        await self.db.commit()
        return cur.lastrowid

    async def get_task(self, task_id: int) -> Optional[aiosqlite.Row]:
        return await self._fetchone("SELECT * FROM tasks WHERE id = ?", (task_id,))

    async def list_tasks(
        self,
        *,
        statuses: tuple[str, ...] | None = (TASK_OPEN, TASK_IN_PROGRESS),
        assignee_id: int | None = None,
        client_id: int | None = None,
    ) -> list[aiosqlite.Row]:
        query = "SELECT * FROM tasks WHERE 1=1"
        params: list[Any] = []
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            query += f" AND status IN ({placeholders})"
            params.extend(statuses)
        if assignee_id is not None:
            query += " AND (assignee_id = ? OR creator_id = ?)"
            params.extend([assignee_id, assignee_id])
        if client_id is not None:
            query += " AND client_id = ?"
            params.append(client_id)
        # Сначала с дедлайном (ближайшие сверху), потом без; внутри — по приоритету
        query += " ORDER BY (due_at IS NULL), due_at, priority DESC, created_at"
        return await self._fetchall(query, tuple(params))

    async def set_task_status(self, task_id: int, status: str) -> None:
        done_at = _utcnow() if status == TASK_DONE else None
        await self.db.execute(
            "UPDATE tasks SET status = ?, done_at = ? WHERE id = ?",
            (status, done_at, task_id),
        )
        await self.db.commit()

    async def delete_task(self, task_id: int) -> None:
        await self.db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await self.db.commit()

    async def tasks_due_for_reminder(self, now_iso: str) -> list[aiosqlite.Row]:
        """Открытые задачи с наступившим дедлайном, по которым ещё не напоминали."""
        return await self._fetchall(
            """
            SELECT * FROM tasks
            WHERE status IN ('open', 'in_progress')
              AND due_at IS NOT NULL
              AND due_at <= ?
              AND reminded_at IS NULL
            ORDER BY due_at
            """,
            (now_iso,),
        )

    async def mark_reminded(self, task_id: int) -> None:
        await self.db.execute(
            "UPDATE tasks SET reminded_at = ? WHERE id = ?", (_utcnow(), task_id)
        )
        await self.db.commit()

    # ---------- Заметки ----------

    async def add_note(self, user_id: int, text: str, tags: str = "") -> int:
        cur = await self.db.execute(
            "INSERT INTO notes (user_id, text, tags, created_at) VALUES (?, ?, ?, ?)",
            (user_id, text, tags, _utcnow()),
        )
        await self.db.commit()
        return cur.lastrowid

    async def list_notes(self, user_id: int, limit: int = 20) -> list[aiosqlite.Row]:
        return await self._fetchall(
            "SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )

    async def search_notes(self, user_id: int, query: str) -> list[aiosqlite.Row]:
        like = f"%{query}%"
        return await self._fetchall(
            """
            SELECT * FROM notes
            WHERE user_id = ? AND (text LIKE ? OR tags LIKE ?)
            ORDER BY created_at DESC LIMIT 30
            """,
            (user_id, like, like),
        )

    async def delete_note(self, note_id: int, user_id: int) -> None:
        await self.db.execute(
            "DELETE FROM notes WHERE id = ? AND user_id = ?", (note_id, user_id)
        )
        await self.db.commit()

    # ---------- Служебное ----------

    async def _fetchone(self, query: str, params: tuple = ()) -> Optional[aiosqlite.Row]:
        async with self.db.execute(query, params) as cur:
            return await cur.fetchone()

    async def _fetchall(self, query: str, params: tuple = ()) -> list[aiosqlite.Row]:
        async with self.db.execute(query, params) as cur:
            return list(await cur.fetchall())
