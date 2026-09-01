-- Схема базы данных Cloudflare D1 (SQLite).
-- Применяется: npm run db:init (или вставкой в консоль D1).

CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,              -- Telegram-id либо 10^12 + id пользователя MAX
  username   TEXT,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'pending',   -- owner | member | client | pending
  created_at TEXT NOT NULL,
  channel    TEXT DEFAULT 'tg',                 -- tg | max
  ext_id     INTEGER                            -- настоящий id пользователя в его мессенджере
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

-- ---------------------------------------------------------------------------
-- Ниже — таблицы, которые бот умеет создавать сам при первом обращении
-- (CREATE TABLE IF NOT EXISTS в src/db.ts). Держим их и здесь, чтобы схему
-- можно было развернуть целиком одной командой и видеть структуру базы.
-- ---------------------------------------------------------------------------

-- Ключ-значение: токены интеграций, цели по калориям/воде, служебные отметки
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Дневник питания
CREATE TABLE IF NOT EXISTS food_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  title   TEXT NOT NULL,
  kcal    INTEGER DEFAULT 0,
  protein INTEGER DEFAULT 0,
  fat     INTEGER DEFAULT 0,
  carbs   INTEGER DEFAULT 0,
  meal    TEXT DEFAULT ''      -- breakfast | lunch | dinner | snack | ''
);

-- Вода (мл за приём)
CREATE TABLE IF NOT EXISTS water_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  ml      INTEGER NOT NULL
);

-- Вес
CREATE TABLE IF NOT EXISTS weight_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  kg      REAL NOT NULL
);

-- Заметки по здоровью (самочувствие, симптомы)
CREATE TABLE IF NOT EXISTS health_note (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  text    TEXT NOT NULL
);

-- Тренировки и активность
CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  title        TEXT NOT NULL,
  kcal         INTEGER DEFAULT 0,
  type         TEXT DEFAULT '',      -- кардио | силовая | растяжка | другое
  duration_min INTEGER DEFAULT 0
);

-- Сон и настроение (одна запись на день)
CREATE TABLE IF NOT EXISTS wellbeing (
  user_id INTEGER NOT NULL,
  date    TEXT NOT NULL,             -- YYYY-MM-DD (местная дата)
  sleep   REAL,
  mood    TEXT,
  PRIMARY KEY (user_id, date)
);

-- Курсы БАДов/фармы и отметки приёма
CREATE TABLE IF NOT EXISTS supplement (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  dose       TEXT DEFAULT '',
  times      TEXT DEFAULT '[]',      -- JSON-массив "HH:MM"
  start_date TEXT DEFAULT '',
  days       INTEGER DEFAULT 0,      -- 0 = бессрочно
  notes      TEXT DEFAULT '',
  active     INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplement_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  sup_id     INTEGER NOT NULL,
  date       TEXT NOT NULL,
  slot       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_food_user ON food_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_water_user ON water_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_weight_user ON weight_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_supp_user ON supplement(user_id, active);
CREATE INDEX IF NOT EXISTS idx_supplog_user ON supplement_log(user_id, date);

-- Сессии Mini App для каналов без подписи initData (MAX): бот выдаёт токен ссылкой
CREATE TABLE IF NOT EXISTS web_session (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_session_user ON web_session(user_id);
