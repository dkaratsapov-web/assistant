import {
  Client,
  Contact,
  Event,
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

  async addClient(name: string, platforms = "", budget = "", contact = ""): Promise<number> {
    const res = await this.d1
      .prepare(
        `INSERT INTO clients (name, platforms, status, budget, contact, notes, created_at)
         VALUES (?, ?, 'active', ?, ?, '', ?)`
      )
      .bind(name, platforms, budget, contact, nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  async getClient(id: number): Promise<Client | null> {
    return await this.d1.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first<Client>();
  }

  async listClients(): Promise<Client[]> {
    const { results } = await this.d1.prepare("SELECT * FROM clients ORDER BY name").all<Client>();
    return results ?? [];
  }

  async updateClientStatus(id: number, status: string): Promise<void> {
    await this.d1.prepare("UPDATE clients SET status = ? WHERE id = ?").bind(status, id).run();
  }

  async deleteClient(id: number): Promise<void> {
    await this.d1.prepare("DELETE FROM clients WHERE id = ?").bind(id).run();
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

  async listTasks(opts: {
    statuses?: string[];
    assigneeId?: number | null;
    clientId?: number | null;
    scope?: string | null;
  } = {}): Promise<Task[]> {
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
    q += " ORDER BY (due_at IS NULL), due_at, priority DESC, created_at";
    const { results } = await this.d1.prepare(q).bind(...binds).all<Task>();
    return results ?? [];
  }

  async setTaskStatus(id: number, status: string): Promise<void> {
    const doneAt = status === TASK_DONE ? nowIso() : null;
    await this.d1.prepare("UPDATE tasks SET status = ?, done_at = ? WHERE id = ?").bind(status, doneAt, id).run();
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
  }): Promise<number> {
    const res = await this.d1
      .prepare("INSERT INTO contacts (user_id, name, birthday, phone, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(opts.userId, opts.name, opts.birthday ?? null, opts.phone ?? "", opts.notes ?? "", nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  async listContacts(userId: number): Promise<Contact[]> {
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
}
