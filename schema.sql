-- Схема базы данных Cloudflare D1 (SQLite).
-- Применяется: npm run db:init (или вставкой в консоль D1).

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
  pay_amount TEXT DEFAULT '',   -- сумма оплаты за ведение
  pay_due    TEXT DEFAULT '',   -- дедлайн оплаты (напр. «5 число» или дата)
  metrika_counter TEXT DEFAULT '', -- номер счётчика Яндекс Метрики
  direct_login    TEXT DEFAULT '', -- логин аккаунта Яндекс Директ
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'work',        -- personal | work
  client_id   INTEGER,
  creator_id  INTEGER NOT NULL,
  assignee_id INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',         -- open | in_progress | done
  priority    INTEGER NOT NULL DEFAULT 0,           -- 0 обычный, 1 важный
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

-- Встречи и события календаря
CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  title             TEXT NOT NULL,
  starts_at         TEXT NOT NULL,                  -- ISO UTC
  location          TEXT DEFAULT '',
  notes             TEXT DEFAULT '',
  remind_before_min INTEGER NOT NULL DEFAULT 30,    -- за сколько минут напомнить
  reminded_at       TEXT,
  created_at        TEXT NOT NULL
);

-- Контакты и дни рождения
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  birthday      TEXT,                               -- MM-DD (или YYYY-MM-DD)
  phone         TEXT DEFAULT '',
  notes         TEXT DEFAULT '',
  reminded_year INTEGER,                            -- год последнего напоминания о ДР
  created_at    TEXT NOT NULL
);

-- Состояние пошаговых диалогов бота (FSM)
CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

-- Кеш переписки с ИИ-ассистентом (создаётся также автоматически при первом обращении)
CREATE TABLE IF NOT EXISTS ai_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_messages(user_id, id);
