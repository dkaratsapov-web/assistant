-- Схема базы данных Cloudflare D1 (SQLite).
-- Применяется командой: npm run db:init  (или через дашборд Cloudflare).

CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  username   TEXT,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'pending',   -- owner | member | client | pending
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  platforms  TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',      -- active | paused
  budget     TEXT DEFAULT '',
  contact    TEXT DEFAULT '',
  notes      TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  client_id   INTEGER,
  creator_id  INTEGER NOT NULL,
  assignee_id INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',        -- open | in_progress | done
  priority    INTEGER NOT NULL DEFAULT 0,
  due_at      TEXT,
  created_at  TEXT NOT NULL,
  done_at     TEXT,
  reminded_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  tags       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- Состояние пошаговых диалогов бота (FSM) — вместо памяти процесса
CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
