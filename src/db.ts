import {
  Client,
  Contact,
  Event,
  FoodEntry,
  NotifSettings,
  Note,
  ROLE_OWNER,
  Task,
  TASK_DONE,
  TASK_IN_PROGRESS,
  TASK_OPEN,
  User,
} from "./types";

const nowIso = () => new Date().toISOString();

export class DB {
  constructor(private d1: D1Database) {}

  // ---------- Пользователи ----------

  async ensureOwner(ownerId: number): Promise<void> {
    const row = await this.d1.prepare("SELECT role FROM users WHERE user_id = ?").bind(ownerId).first<{ role: string }>();
    if (!row) {
      await this.d1
        .prepare("INSERT INTO users (user_id, role, created_at) VALUES (?, ?, ?)")
        .bind(ownerId, ROLE_OWNER, nowIso())
        .run();
    } else if (row.role !== ROLE_OWNER) {
      await this.d1.prepare("UPDATE users SET role = ? WHERE user_id = ?").bind(ROLE_OWNER, ownerId).run();
    }
  }

  async getUser(userId: number): Promise<User | null> {
    return await this.d1.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first<User>();
  }

  async updateProfile(userId: number, username: string | null, fullName: string | null): Promise<void> {
    await this.d1.prepare("UPDATE users SET username = ?, full_name = ? WHERE user_id = ?").bind(username, fullName, userId).run();
  }

  async requestAccess(userId: number, username: string | null, fullName: string | null): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO users (user_id, username, full_name, role, created_at)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, full_name = excluded.full_name`
      )
      .bind(userId, username, fullName, nowIso())
      .run();
  }

  async setRole(userId: number, role: string): Promise<void> {
    await this.d1.prepare("UPDATE users SET role = ? WHERE user_id = ?").bind(role, userId).run();
  }

  async deleteUser(userId: number): Promise<void> {
    await this.d1.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
  }

  async listUsers(role?: string): Promise<User[]> {
    const stmt = role
      ? this.d1.prepare("SELECT * FROM users WHERE role = ? ORDER BY created_at").bind(role)
      : this.d1.prepare("SELECT * FROM users ORDER BY created_at");
    const { results } = await stmt.all<User>();
    return results ?? [];
  }

  // ---------- Клиенты ----------

  async addClient(name: string, platforms = "", budget = "", opts: { contact?: string; payAmount?: string; payDue?: string } = {}): Promise<number> {
    await this.ensureSchema();
    const res = await this.d1
      .prepare(
        `INSERT INTO clients (name, platforms, status, budget, contact, notes, pay_amount, pay_due, created_at)
         VALUES (?, ?, 'active', ?, ?, '', ?, ?, ?)`
      )
      .bind(name, platforms, budget, opts.contact ?? "", opts.payAmount ?? "", opts.payDue ?? "", nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  async getClient(id: number): Promise<Client | null> {
    return await this.d1.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first<Client>();
  }

  async listClients(): Promise<Client[]> {
    await this.ensureSchema();
    const { results } = await this.d1.prepare("SELECT * FROM clients ORDER BY name").all<Client>();
    return results ?? [];
  }

  async updateClientStatus(id: number, status: string): Promise<void> {
    await this.d1.prepare("UPDATE clients SET status = ? WHERE id = ?").bind(status, id).run();
  }

  async deleteClient(id: number): Promise<void> {
    await this.d1.prepare("DELETE FROM clients WHERE id = ?").bind(id).run();
  }

  /** Поиск клиента по имени (для удаления/правки голосом). */
  async findClientByName(name: string): Promise<Client | null> {
    const n = name.trim().toLowerCase();
    return await this.d1
      .prepare("SELECT * FROM clients WHERE lower(name) LIKE ? ORDER BY (lower(name) = ?) DESC, name LIMIT 1")
      .bind(`%${n}%`, n)
      .first<Client>();
  }

  /** Частичное обновление клиента. */
  async updateClient(
    id: number,
    fields: { name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string; metrikaCounter?: string; directLogin?: string }
  ): Promise<void> {
    await this.ensureSchema();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name); }
    if (fields.platforms !== undefined) { sets.push("platforms = ?"); binds.push(fields.platforms); }
    if (fields.budget !== undefined) { sets.push("budget = ?"); binds.push(fields.budget); }
    if (fields.payAmount !== undefined) { sets.push("pay_amount = ?"); binds.push(fields.payAmount); }
    if (fields.payDue !== undefined) { sets.push("pay_due = ?"); binds.push(fields.payDue); }
    if (fields.metrikaCounter !== undefined) { sets.push("metrika_counter = ?"); binds.push(fields.metrikaCounter); }
    if (fields.directLogin !== undefined) { sets.push("direct_login = ?"); binds.push(fields.directLogin); }
    if (!sets.length) return;
    binds.push(id);
    await this.d1.prepare(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  }

  /** Безопасная авто-миграция: добавляет колонку done_at, если базу создавали из старой схемы. */
  private schemaReady = false;
  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const alters = [
      "ALTER TABLE tasks ADD COLUMN done_at TEXT",
      "ALTER TABLE clients ADD COLUMN pay_amount TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN pay_due TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN metrika_counter TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN direct_login TEXT DEFAULT ''",
      "ALTER TABLE contacts ADD COLUMN tags TEXT DEFAULT ''",
    ];
    for (const sql of alters) {
      try {
        await this.d1.prepare(sql).run();
      } catch {
        // колонка уже есть — игнорируем
      }
    }
    this.schemaReady = true;
  }

  // ---------- Задачи ----------

  async addTask(opts: {
    title: string;
    creatorId: number;
    description?: string;
    scope?: string;
    clientId?: number | null;
    assigneeId?: number | null;
    priority?: number;
    dueAt?: string | null;
  }): Promise<number> {
    const res = await this.d1
      .prepare(
        `INSERT INTO tasks (title, description, scope, client_id, creator_id, assignee_id, priority, due_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .bind(
        opts.title,
        opts.description ?? "",
        opts.scope ?? "work",
        opts.clientId ?? null,
        opts.creatorId,
        opts.assigneeId ?? null,
        opts.priority ?? 0,
        opts.dueAt ?? null,
        nowIso()
      )
      .run();
    return res.meta.last_row_id as number;
  }

  async getTask(id: number): Promise<Task | null> {
    return await this.d1.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>();
  }

  /** Поиск активной задачи по названию (для «выполни/удали задачу …» голосом). */
  async findTaskByTitle(title: string): Promise<Task | null> {
    const n = title.trim().toLowerCase();
    return await this.d1
      .prepare("SELECT * FROM tasks WHERE status IN ('open','in_progress') AND lower(title) LIKE ? ORDER BY (lower(title) = ?) DESC, created_at DESC LIMIT 1")
      .bind(`%${n}%`, n)
      .first<Task>();
  }

  async listTasks(opts: {
    statuses?: string[];
    assigneeId?: number | null;
    clientId?: number | null;
    scope?: string | null;
    orderByDone?: boolean;
  } = {}): Promise<Task[]> {
    await this.ensureSchema();
    const statuses = opts.statuses ?? [TASK_OPEN, TASK_IN_PROGRESS];
    let q = "SELECT * FROM tasks WHERE 1=1";
    const binds: unknown[] = [];
    if (statuses.length) {
      q += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      binds.push(...statuses);
    }
    if (opts.assigneeId != null) {
      q += " AND (assignee_id = ? OR creator_id = ?)";
      binds.push(opts.assigneeId, opts.assigneeId);
    }
    if (opts.clientId != null) {
      q += " AND client_id = ?";
      binds.push(opts.clientId);
    }
    if (opts.scope) {
      q += " AND scope = ?";
      binds.push(opts.scope);
    }
    q += opts.orderByDone
      ? " ORDER BY (done_at IS NULL), done_at DESC, created_at DESC"
      : " ORDER BY (due_at IS NULL), due_at, priority DESC, created_at";
    const { results } = await this.d1.prepare(q).bind(...binds).all<Task>();
    return results ?? [];
  }

  async setTaskStatus(id: number, status: string): Promise<void> {
    await this.ensureSchema();
    const doneAt = status === TASK_DONE ? nowIso() : null;
    await this.d1.prepare("UPDATE tasks SET status = ?, done_at = ? WHERE id = ?").bind(status, doneAt, id).run();
  }

  /** Частичное обновление задачи (редактирование). */
  async updateTask(id: number, fields: { title?: string; dueAt?: string | null; scope?: string; priority?: number }): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); binds.push(fields.title); }
    if (fields.dueAt !== undefined) { sets.push("due_at = ?"); binds.push(fields.dueAt); }
    if (fields.scope !== undefined) { sets.push("scope = ?"); binds.push(fields.scope); }
    if (fields.priority !== undefined) { sets.push("priority = ?"); binds.push(fields.priority); }
    if (!sets.length) return;
    binds.push(id);
    await this.d1.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  }

  async deleteTask(id: number): Promise<void> {
    await this.d1.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  }

  async tasksDueForReminder(nowIsoStr: string): Promise<Task[]> {
    const { results } = await this.d1
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('open','in_progress') AND due_at IS NOT NULL
           AND due_at <= ? AND reminded_at IS NULL
         ORDER BY due_at`
      )
      .bind(nowIsoStr)
      .all<Task>();
    return results ?? [];
  }

  async markReminded(id: number): Promise<void> {
    await this.d1.prepare("UPDATE tasks SET reminded_at = ? WHERE id = ?").bind(nowIso(), id).run();
  }

  // ---------- Заметки ----------

  async addNote(userId: number, text: string, tags = ""): Promise<number> {
    const res = await this.d1
      .prepare("INSERT INTO notes (user_id, text, tags, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, text, tags, nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  async listNotes(userId: number, limit = 50): Promise<Note[]> {
    const { results } = await this.d1
      .prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .bind(userId, limit)
      .all<Note>();
    return results ?? [];
  }

  async searchNotes(userId: number, query: string): Promise<Note[]> {
    const like = `%${query}%`;
    const { results } = await this.d1
      .prepare("SELECT * FROM notes WHERE user_id = ? AND (text LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT 30")
      .bind(userId, like, like)
      .all<Note>();
    return results ?? [];
  }

  async deleteNote(id: number, userId: number): Promise<void> {
    await this.d1.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(id, userId).run();
  }

  // ---------- События / встречи ----------

  async addEvent(opts: {
    userId: number;
    title: string;
    startsAt: string;
    location?: string;
    notes?: string;
    remindBeforeMin?: number;
  }): Promise<number> {
    const res = await this.d1
      .prepare(
        `INSERT INTO events (user_id, title, starts_at, location, notes, remind_before_min, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        opts.userId,
        opts.title,
        opts.startsAt,
        opts.location ?? "",
        opts.notes ?? "",
        opts.remindBeforeMin ?? 30,
        nowIso()
      )
      .run();
    return res.meta.last_row_id as number;
  }

  async listEvents(userId: number, fromIso: string): Promise<Event[]> {
    const { results } = await this.d1
      .prepare("SELECT * FROM events WHERE user_id = ? AND starts_at >= ? ORDER BY starts_at LIMIT 100")
      .bind(userId, fromIso)
      .all<Event>();
    return results ?? [];
  }

  async deleteEvent(id: number, userId: number): Promise<void> {
    await this.d1.prepare("DELETE FROM events WHERE id = ? AND user_id = ?").bind(id, userId).run();
  }

  /** Поиск ближайшей встречи по названию (для «отмени встречу …» голосом). */
  async findEventByTitle(userId: number, title: string): Promise<Event | null> {
    const n = title.trim().toLowerCase();
    return await this.d1
      .prepare("SELECT * FROM events WHERE user_id = ? AND lower(title) LIKE ? ORDER BY starts_at LIMIT 1")
      .bind(userId, `%${n}%`)
      .first<Event>();
  }

  /** Частичное обновление встречи (редактирование). */
  async updateEvent(
    id: number,
    userId: number,
    fields: { title?: string; startsAt?: string; location?: string; notes?: string }
  ): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); binds.push(fields.title); }
    if (fields.startsAt !== undefined) { sets.push("starts_at = ?"); binds.push(fields.startsAt); }
    if (fields.location !== undefined) { sets.push("location = ?"); binds.push(fields.location); }
    if (fields.notes !== undefined) { sets.push("notes = ?"); binds.push(fields.notes); }
    if (!sets.length) return;
    binds.push(id, userId);
    await this.d1.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  }

  async eventsDueForReminder(nowIso: string): Promise<Event[]> {
    // Напоминаем, когда до начала осталось <= remind_before_min и событие ещё не прошло
    const { results } = await this.d1
      .prepare(
        `SELECT * FROM events
         WHERE reminded_at IS NULL AND starts_at > ?
           AND datetime(starts_at, '-' || remind_before_min || ' minutes') <= ?
         ORDER BY starts_at`
      )
      .bind(nowIso, nowIso)
      .all<Event>();
    return results ?? [];
  }

  async markEventReminded(id: number): Promise<void> {
    await this.d1.prepare("UPDATE events SET reminded_at = ? WHERE id = ?").bind(nowIso(), id).run();
  }

  // ---------- Контакты / дни рождения ----------

  async addContact(opts: {
    userId: number;
    name: string;
    birthday?: string | null;
    phone?: string;
    notes?: string;
    tags?: string;
  }): Promise<number> {
    await this.ensureSchema();
    const res = await this.d1
      .prepare("INSERT INTO contacts (user_id, name, birthday, phone, notes, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(opts.userId, opts.name, opts.birthday ?? null, opts.phone ?? "", opts.notes ?? "", opts.tags ?? "", nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  /** Частичное обновление контакта. */
  async updateContact(
    id: number,
    userId: number,
    fields: { name?: string; birthday?: string | null; phone?: string; tags?: string; notes?: string }
  ): Promise<void> {
    await this.ensureSchema();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name); }
    if (fields.birthday !== undefined) { sets.push("birthday = ?"); binds.push(fields.birthday); }
    if (fields.phone !== undefined) { sets.push("phone = ?"); binds.push(fields.phone); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); binds.push(fields.tags); }
    if (fields.notes !== undefined) { sets.push("notes = ?"); binds.push(fields.notes); }
    if (!sets.length) return;
    binds.push(id, userId);
    await this.d1.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  }

  async listContacts(userId: number): Promise<Contact[]> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY name")
      .bind(userId)
      .all<Contact>();
    return results ?? [];
  }

  async deleteContact(id: number, userId: number): Promise<void> {
    await this.d1.prepare("DELETE FROM contacts WHERE id = ? AND user_id = ?").bind(id, userId).run();
  }

  /** Дни рождения на заданную дату MM-DD, по которым в этом году ещё не напоминали. */
  async birthdaysForReminder(monthDay: string, year: number): Promise<Contact[]> {
    const { results } = await this.d1
      .prepare(
        `SELECT * FROM contacts
         WHERE birthday IS NOT NULL AND substr(birthday, -5) = ?
           AND (reminded_year IS NULL OR reminded_year <> ?)`
      )
      .bind(monthDay, year)
      .all<Contact>();
    return results ?? [];
  }

  async markBirthdayReminded(id: number, year: number): Promise<void> {
    await this.d1.prepare("UPDATE contacts SET reminded_year = ? WHERE id = ?").bind(year, id).run();
  }

  // ---------- FSM-состояние диалогов ----------

  async getState(userId: number): Promise<Record<string, unknown>> {
    const row = await this.d1.prepare("SELECT data FROM sessions WHERE user_id = ?").bind(userId).first<{ data: string }>();
    if (!row) return {};
    try {
      return JSON.parse(row.data);
    } catch {
      return {};
    }
  }

  async setState(userId: number, data: Record<string, unknown>): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .bind(userId, JSON.stringify(data), Date.now())
      .run();
  }

  async clearState(userId: number): Promise<void> {
    await this.d1.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  }

  // ---------- История диалога с ИИ (кеш переписки) ----------
  private aiReady = false;
  private async ensureAiTable(): Promise<void> {
    if (this.aiReady) return;
    await this.d1
      .prepare(
        `CREATE TABLE IF NOT EXISTS ai_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id INTEGER NOT NULL,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`
      )
      .run();
    await this.d1.prepare("CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_messages(user_id, id)").run();
    this.aiReady = true;
  }

  async addAiMessage(userId: number, role: "user" | "assistant", content: string): Promise<void> {
    await this.ensureAiTable();
    await this.d1
      .prepare("INSERT INTO ai_messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, role, content, nowIso())
      .run();
  }

  /** Последние сообщения диалога в хронологическом порядке (старые → новые). */
  async listAiMessages(userId: number, limit = 50): Promise<{ role: string; content: string }[]> {
    await this.ensureAiTable();
    const res = await this.d1
      .prepare("SELECT role, content FROM ai_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .bind(userId, limit)
      .all<{ role: string; content: string }>();
    return (res.results ?? []).reverse();
  }

  async clearAiMessages(userId: number): Promise<void> {
    await this.ensureAiTable();
    await this.d1.prepare("DELETE FROM ai_messages WHERE user_id = ?").bind(userId).run();
  }

  // ---------- Настройки (ключ-значение): интеграции, токены и т.п. ----------
  private setReady = false;
  private async ensureSettings(): Promise<void> {
    if (this.setReady) return;
    await this.d1.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    this.setReady = true;
  }

  async getSetting(key: string): Promise<string | null> {
    await this.ensureSettings();
    const r = await this.d1.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return r ? r.value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.ensureSettings();
    await this.d1
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }

  // ---------- Настройки уведомлений (на пользователя) ----------
  async getNotif(userId: number): Promise<NotifSettings> {
    const raw = await this.getSetting(`notif:${userId}`);
    const def: NotifSettings = {
      morning: { on: true, hour: 9 },
      tasks: { on: true },
      events: { on: true, lead: 30 },
      birthdays: { on: true },
      water: { on: false, everyHours: 2, from: 9, to: 21 },
    };
    if (!raw) return def;
    try {
      const p = JSON.parse(raw);
      return {
        morning: { ...def.morning, ...(p.morning || {}) },
        tasks: { ...def.tasks, ...(p.tasks || {}) },
        events: { ...def.events, ...(p.events || {}) },
        birthdays: { ...def.birthdays, ...(p.birthdays || {}) },
        water: { ...def.water, ...(p.water || {}) },
      };
    } catch {
      return def;
    }
  }

  async setNotif(userId: number, s: NotifSettings): Promise<void> {
    await this.setSetting(`notif:${userId}`, JSON.stringify(s));
  }

  // ---------- Здоровье: питание и вода ----------
  private healthReady = false;
  private async ensureHealth(): Promise<void> {
    if (this.healthReady) return;
    await this.d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS food_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, title TEXT NOT NULL, kcal INTEGER DEFAULT 0, protein INTEGER DEFAULT 0, fat INTEGER DEFAULT 0, carbs INTEGER DEFAULT 0)"
      )
      .run();
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS water_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, ml INTEGER NOT NULL)")
      .run();
    this.healthReady = true;
  }

  async addFood(userId: number, f: { title: string; kcal: number; protein: number; fat: number; carbs: number }): Promise<number> {
    await this.ensureHealth();
    const res = await this.d1
      .prepare("INSERT INTO food_log (user_id, ts, title, kcal, protein, fat, carbs) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(userId, nowIso(), f.title, f.kcal, f.protein, f.fat, f.carbs)
      .run();
    return res.meta.last_row_id as number;
  }

  async listFood(userId: number, startIso: string, endIso: string): Promise<FoodEntry[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT * FROM food_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .bind(userId, startIso, endIso)
      .all<FoodEntry>();
    return results ?? [];
  }

  async deleteFood(id: number, userId: number): Promise<void> {
    await this.ensureHealth();
    await this.d1.prepare("DELETE FROM food_log WHERE id = ? AND user_id = ?").bind(id, userId).run();
  }

  async addWater(userId: number, ml: number): Promise<void> {
    await this.ensureHealth();
    await this.d1.prepare("INSERT INTO water_log (user_id, ts, ml) VALUES (?, ?, ?)").bind(userId, nowIso(), ml).run();
  }

  async waterTotal(userId: number, startIso: string, endIso: string): Promise<number> {
    await this.ensureHealth();
    const r = await this.d1
      .prepare("SELECT COALESCE(SUM(ml), 0) AS ml FROM water_log WHERE user_id = ? AND ts >= ? AND ts < ?")
      .bind(userId, startIso, endIso)
      .first<{ ml: number }>();
    return r?.ml ?? 0;
  }
}
