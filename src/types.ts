/** Привязки и переменные окружения воркера (см. wrangler.toml). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Секреты (wrangler secret put ...)
  BOT_TOKEN: string;
  OWNER_ID: string;
  WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  // Переменные (wrangler.toml [vars])
  ANTHROPIC_MODEL?: string;
  TZ_OFFSET?: string;
  DIGEST_HOUR?: string;
}

export const ROLE_OWNER = "owner";
export const ROLE_MEMBER = "member";
export const ROLE_CLIENT = "client";
export const ROLE_PENDING = "pending";

export const TASK_OPEN = "open";
export const TASK_IN_PROGRESS = "in_progress";
export const TASK_DONE = "done";

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
  user_id: number;
  username: string | null;
  full_name: string | null;
  role: string;
  created_at: string;
}

export interface Client {
  id: number;
  name: string;
  platforms: string;
  status: string;
  budget: string;
  contact: string;
  notes: string;
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
  created_at: string;
}

export interface Contact {
  id: number;
  user_id: number;
  name: string;
  birthday: string | null;
  phone: string;
  notes: string;
  reminded_year: number | null;
  created_at: string;
}
