/** Привязки и переменные окружения воркера (см. wrangler.toml). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Секреты (wrangler secret put ...)
  BOT_TOKEN: string;
  OWNER_ID: string;
  WEBHOOK_SECRET: string;
  BOT_USERNAME?: string;  // ник бота без @ (нужен grammy для разбора команд вида /tasks@bot)
  BOT_NAME?: string;      // отображаемое имя бота
  // ИИ-«мозги» и голос — Yandex Cloud (YandexGPT + SpeechKit), один API-ключ на оба сервиса
  YANDEX_API_KEY?: string;         // секрет: API-ключ сервисного аккаунта
  YANDEX_FOLDER_ID?: string;       // идентификатор каталога Yandex Cloud
  YANDEX_GPT_MODEL?: string;       // основная модель, по умолчанию "yandexgpt/latest"
  YANDEX_GPT_ROUTER_MODEL?: string;// дешёвая модель для разбора команд, по умолчанию "yandexgpt-lite/latest"
  YANDEX_VISION_MODEL?: string;    // мультимодальная модель для фото еды; пусто — разбор фото выключен
  TZ_OFFSET?: string;
  DIGEST_HOUR?: string;
  // Канал MAX (мессенджер MAX)
  MAX_BOT_TOKEN?: string;      // секрет: токен бота из @BotFather в MAX
  MAX_WEBHOOK_SECRET?: string; // секрет: проверка заголовка X-Max-Bot-Api-Secret
  MAX_OWNER_ID?: string;       // user_id владельца в MAX (приватный режим)
  MAX_API_URL?: string;        // базовый хост, по умолчанию https://platform-api.max.ru
  MAX_APP_NAME?: string;       // публичное имя мини-приложения в MAX (кнопка «Открыть» внутри мессенджера)
  // Интеграция Яндекс Телемост (видеовстречи)
  TELEMOST_CLIENT_ID?: string;     // секрет: Client ID OAuth-приложения
  TELEMOST_CLIENT_SECRET?: string; // секрет: Client Secret
  // Правки сайта в GitHub
  GITHUB_TOKEN?: string;   // секрет: PAT с доступом к репозиторию сайта
  SITE_REPO?: string;      // "owner/name"
  SITE_BRANCH?: string;    // ветка (по умолчанию — default_branch репо)
}

export const ROLE_OWNER = "owner";
export const ROLE_MEMBER = "member";
export const ROLE_CLIENT = "client";
export const ROLE_PENDING = "pending";

export const TASK_OPEN = "open";
export const TASK_IN_PROGRESS = "in_progress";
export const TASK_DONE = "done";
export const TASK_FAILED = "failed";

export const SCOPE_PERSONAL = "personal";
export const SCOPE_WORK = "work";

export const TASK_STATUS_LABELS: Record<string, string> = {
  open: "🔵 Открыта",
  in_progress: "🟡 В работе",
  done: "✅ Готово",
};

export const PLATFORMS: Record<string, string> = {
  direct: "Яндекс Директ",
  google: "Google Ads",
  tg: "Telegram Ads",
  vk: "VK Реклама",
  avito: "Авито",
  site: "Сайт",
};

export interface User {
  user_id: number;          // внутренний id: Telegram-id либо MAX_UID_BASE + id в MAX
  username: string | null;
  full_name: string | null;
  role: string;
  created_at: string;
  channel?: string;         // tg | max
  ext_id?: number | null;   // настоящий id пользователя в его мессенджере
}

export interface Client {
  id: number;
  name: string;
  platforms: string;
  status: string;
  budget: string;
  contact: string;
  notes: string;
  pay_amount: string;
  pay_due: string;
  metrika_counter: string;
  direct_login: string;
  created_at: string;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  scope: string;
  client_id: number | null;
  creator_id: number;
  assignee_id: number | null;
  status: string;
  priority: number;
  due_at: string | null;
  created_at: string;
  done_at: string | null;
  reminded_at: string | null;
}

export interface Note {
  id: number;
  user_id: number;
  text: string;
  tags: string;
  created_at: string;
}

export interface Event {
  id: number;
  user_id: number;
  title: string;
  starts_at: string;
  location: string;
  notes: string;
  remind_before_min: number;
  reminded_at: string | null;
  client_id: number | null;
  created_at: string;
}

export interface SupplementRow {
  id: number;
  user_id: number;
  name: string;
  dose: string;
  times: string; // JSON массив "HH:MM"
  start_date: string;
  days: number; // 0 = бессрочно
  notes: string;
  active: number;
  created_at: string;
}

export interface NotifSettings {
  morning: { on: boolean; hour: number };
  tasks: { on: boolean };
  events: { on: boolean; lead: number }; // lead — минут до встречи
  birthdays: { on: boolean };
  water: { on: boolean; everyHours: number; from: number; to: number };
  meals: { on: boolean; breakfast: number; lunch: number; dinner: number };
}

export interface ActivityRow {
  id: number;
  ts: string;
  title: string;
  kcal: number;
  type: string;
  duration_min: number;
}

export interface FoodEntry {
  id: number;
  user_id: number;
  ts: string;
  title: string;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  meal: string; // breakfast | lunch | dinner | snack | ""
}

/** Личный профиль пользователя — ИИ опирается на него в меню, тренировках, советах и др. */
export interface Profile {
  name: string;
  sex: string;          // "m" | "f" | ""
  birth_year: number;   // 0 — не указан
  height_cm: number;    // 0 — не указан
  activity: string;     // "low" | "medium" | "high" | ""
  goal: string;         // "lose" | "keep" | "gain" | ""
  target_weight: number;// 0 — не указан
  diet: string;         // тип питания (вегетарианец, кето, без свинины…)
  allergies: string;    // аллергии/непереносимость — ИСКЛЮЧАТЬ
  dislikes: string;     // не ест / не любит
  likes: string;        // любит / предпочитает
  conditions: string;   // здоровье/ограничения (гастрит, диабет…)
  about: string;        // свободная заметка о себе для ИИ
}

export const EMPTY_PROFILE: Profile = {
  name: "", sex: "", birth_year: 0, height_cm: 0, activity: "", goal: "",
  target_weight: 0, diet: "", allergies: "", dislikes: "", likes: "", conditions: "", about: "",
};

export interface Contact {
  id: number;
  user_id: number;
  name: string;
  birthday: string | null;
  phone: string;
  notes: string;
  tags: string;
  reminded_year: number | null;
  created_at: string;
}
