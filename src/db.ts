import {
  ActivityRow,
  AppPrefs,
  DEFAULT_PREFS,
  Client,
  Contact,
  Event,
  FoodEntry,
  NotifSettings,
  Note,
  Profile,
  EMPTY_PROFILE,
  SupplementRow,
  ROLE_OWNER,
  ROLE_PENDING,
  Task,
  TASK_DONE,
  TASK_IN_PROGRESS,
  TASK_OPEN,
  User,
} from "./types";

import { nextDue, tidyName, tidyTitle } from "./utils";

const nowIso = () => new Date().toISOString();

/**
 * Флаги «схема уже проверена» — на уровне модуля, а не экземпляра: DB создаётся заново
 * на каждый запрос, и поля экземпляра заставляли гонять DDL при каждом обращении.
 * Изолят Worker'а живёт между запросами, поэтому CREATE TABLE / ALTER выполняются один раз.
 */
const ready = { schema: false, ai: false, settings: false, supp: false, health: false, web: false, legacyClients: false };

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
    await this.claimLegacyClients(ownerId);
  }

  /**
   * База клиентов раньше была общей. Карточки без владельца достаются владельцу бота —
   * иначе после разделения они пропали бы у всех.
   */
  private async claimLegacyClients(ownerId: number): Promise<void> {
    if (ready.legacyClients) return;
    await this.ensureSchema();
    try {
      await this.d1.prepare("UPDATE clients SET owner_id = ? WHERE owner_id IS NULL").bind(ownerId).run();
      ready.legacyClients = true;
    } catch {
      // таблицы ещё нет — разберёмся на следующем запросе
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

  /**
   * Пользователь из внешнего канала (MAX): заводит запись при первом обращении.
   * `userId` — внутренний виртуальный id (см. maxUid в src/max/ids.ts), `extId` — настоящий id в канале.
   * Новый пользователь получает роль `pending` — доступ подтверждает владелец.
   */
  async ensureChannelUser(
    userId: number,
    channel: string,
    extId: number,
    username: string | null,
    fullName: string | null,
    roleIfNew = ROLE_PENDING
  ): Promise<User> {
    await this.ensureSchema();
    await this.d1
      .prepare(
        `INSERT INTO users (user_id, username, full_name, role, created_at, channel, ext_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           username = COALESCE(excluded.username, users.username),
           full_name = COALESCE(excluded.full_name, users.full_name),
           channel = excluded.channel,
           ext_id = excluded.ext_id`
      )
      .bind(userId, username, fullName, roleIfNew, nowIso(), channel, extId)
      .run();
    return (await this.getUser(userId))!;
  }

  /**
   * Приглашение: заранее выдаёт роль аккаунту канала по его внешнему id.
   * Пользователь получает доступ сразу, как только напишет боту — подтверждать не нужно.
   */
  async inviteChannelUser(userId: number, channel: string, extId: number, role: string, note?: string): Promise<User> {
    await this.ensureSchema();
    await this.d1
      .prepare(
        `INSERT INTO users (user_id, username, full_name, role, created_at, channel, ext_id)
         VALUES (?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET role = excluded.role`
      )
      .bind(userId, note ?? null, role, nowIso(), channel, extId)
      .run();
    return (await this.getUser(userId))!;
  }

  // ---------- Веб-сессии Mini App (для каналов без подписи initData, напр. MAX) ----------
  private async ensureWeb(): Promise<void> {
    if (ready.web) return;
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS web_session (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)")
      .run();
    ready.web = true;
  }

  /** Выдаёт токен доступа к Mini App для пользователя канала. */
  async createWebSession(userId: number, ttlDays = 180): Promise<string> {
    await this.ensureWeb();
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expires = new Date(Date.now() + ttlDays * 86400_000).toISOString();
    await this.d1
      .prepare("INSERT INTO web_session (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(token, userId, expires, nowIso())
      .run();
    // подчищаем протухшие, чтобы таблица не росла
    await this.d1.prepare("DELETE FROM web_session WHERE expires_at < ?").bind(nowIso()).run();
    return token;
  }

  /**
   * Действующий токен пользователя или новый, если подходящего нет.
   * Иначе каждое меню плодило бы новую сессию.
   */
  async webSessionFor(userId: number, ttlDays = 180): Promise<string> {
    await this.ensureWeb();
    const soon = new Date(Date.now() + 7 * 86400_000).toISOString(); // годен ещё хотя бы неделю
    const row = await this.d1
      .prepare("SELECT token FROM web_session WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
      .bind(userId, soon)
      .first<{ token: string }>();
    return row ? row.token : this.createWebSession(userId, ttlDays);
  }


  /**
   * Возвращает user_id по токену Mini App или null (нет токена / протух).
   * Срок жизни продлевается на ходу: пока человек пользуется приложением,
   * повторно входить не придётся.
   */
  async webSessionUid(token: string, ttlDays = 180): Promise<number | null> {
    if (!token) return null;
    await this.ensureWeb();
    const row = await this.d1
      .prepare("SELECT user_id, expires_at FROM web_session WHERE token = ? AND expires_at > ?")
      .bind(token, nowIso())
      .first<{ user_id: number; expires_at: string }>();
    if (!row) return null;
    const left = Date.parse(row.expires_at) - Date.now();
    if (left < (ttlDays / 2) * 86400_000) {
      const next = new Date(Date.now() + ttlDays * 86400_000).toISOString();
      await this.d1.prepare("UPDATE web_session SET expires_at = ? WHERE token = ?").bind(next, token).run();
    }
    return row.user_id;
  }

  async listUsers(role?: string): Promise<User[]> {
    const stmt = role
      ? this.d1.prepare("SELECT * FROM users WHERE role = ? ORDER BY created_at").bind(role)
      : this.d1.prepare("SELECT * FROM users ORDER BY created_at");
    const { results } = await stmt.all<User>();
    return results ?? [];
  }

  // ---------- Клиенты ----------

  async addClient(ownerId: number, name: string, platforms = "", budget = "", opts: { contact?: string; payAmount?: string; payDue?: string; grp?: string; kind?: string } = {}): Promise<number> {
    await this.ensureSchema();
    const res = await this.d1
      .prepare(
        `INSERT INTO clients (owner_id, name, platforms, status, budget, contact, notes, pay_amount, pay_due, grp, kind, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, '', ?, ?, ?, ?, ?)`
      )
      .bind(ownerId, tidyName(name), platforms, budget, opts.contact ?? "", opts.payAmount ?? "", opts.payDue ?? "", opts.grp ?? "", opts.kind ?? "client", nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  async getClient(id: number, ownerId: number): Promise<Client | null> {
    await this.ensureSchema();
    return await this.d1.prepare("SELECT * FROM clients WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Client>();
  }

  async listClients(ownerId: number): Promise<Client[]> {
    await this.ensureSchema();
    const { results } = await this.d1.prepare("SELECT * FROM clients WHERE owner_id = ? ORDER BY name").bind(ownerId).all<Client>();
    return results ?? [];
  }

  async updateClientStatus(id: number, status: string, ownerId: number): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.d1.prepare("UPDATE clients SET status = ? WHERE id = ? AND owner_id = ?").bind(status, id, ownerId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async deleteClient(id: number, ownerId: number): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.d1.prepare("DELETE FROM clients WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Поиск клиента по имени (для удаления/правки голосом) — только в своей базе. */
  async findClientByName(ownerId: number, name: string): Promise<Client | null> {
    await this.ensureSchema();
    const n = name.trim().toLowerCase();
    return await this.d1
      .prepare("SELECT * FROM clients WHERE owner_id = ? AND lower(name) LIKE ? ORDER BY (lower(name) = ?) DESC, name LIMIT 1")
      .bind(ownerId, `%${n}%`, n)
      .first<Client>();
  }

  /** Частичное обновление клиента. */
  async updateClient(
    id: number,
    ownerId: number,
    fields: { name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string; metrikaCounter?: string; directLogin?: string; notes?: string; grp?: string; kind?: string }
  ): Promise<boolean> {
    await this.ensureSchema();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(tidyName(fields.name)); }
    if (fields.platforms !== undefined) { sets.push("platforms = ?"); binds.push(fields.platforms); }
    if (fields.grp !== undefined) { sets.push("grp = ?"); binds.push(fields.grp); }
    if (fields.kind !== undefined) { sets.push("kind = ?"); binds.push(fields.kind); }
    if (fields.budget !== undefined) { sets.push("budget = ?"); binds.push(fields.budget); }
    if (fields.payAmount !== undefined) { sets.push("pay_amount = ?"); binds.push(fields.payAmount); }
    if (fields.payDue !== undefined) { sets.push("pay_due = ?"); binds.push(fields.payDue); }
    if (fields.metrikaCounter !== undefined) { sets.push("metrika_counter = ?"); binds.push(fields.metrikaCounter); }
    if (fields.directLogin !== undefined) { sets.push("direct_login = ?"); binds.push(fields.directLogin); }
    if (fields.notes !== undefined) { sets.push("notes = ?"); binds.push(fields.notes); }
    if (!sets.length) return false;
    binds.push(id, ownerId);
    const res = await this.d1.prepare(`UPDATE clients SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`).bind(...binds).run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Безопасная авто-миграция: добавляет колонку done_at, если базу создавали из старой схемы. */
  private async ensureSchema(): Promise<void> {
    if (ready.schema) return;
    const alters = [
      "ALTER TABLE tasks ADD COLUMN done_at TEXT",
      // правило повтора: "" — разовая задача
      "ALTER TABLE tasks ADD COLUMN repeat_rule TEXT DEFAULT ''",
      // владелец карточки клиента: база клиентов у каждого аккаунта своя
      "ALTER TABLE clients ADD COLUMN owner_id INTEGER",
      "ALTER TABLE clients ADD COLUMN pay_amount TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN pay_due TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN metrika_counter TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN direct_login TEXT DEFAULT ''",
      "ALTER TABLE contacts ADD COLUMN tags TEXT DEFAULT ''",
      "ALTER TABLE events ADD COLUMN client_id INTEGER",
      // канал, из которого пришёл пользователь (tg | max), и его настоящий id в этом канале
      "ALTER TABLE users ADD COLUMN channel TEXT DEFAULT 'tg'",
      "ALTER TABLE users ADD COLUMN ext_id INTEGER",
      // отметка «предупредили заранее»: отдельно от reminded_at, иначе
      // напоминание за час съедало бы напоминание в сам срок
      "ALTER TABLE tasks ADD COLUMN pre_reminded_at TEXT",
      // свои группы: «Свои», «Агентские» — названия придумывает пользователь.
      // Колонка названа grp, а не group: group — служебное слово SQL.
      "ALTER TABLE tasks ADD COLUMN grp TEXT DEFAULT ''",
      "ALTER TABLE clients ADD COLUMN grp TEXT DEFAULT ''",
      // вид карточки: обычный клиент, коллега, партнёр или сотрудник
      "ALTER TABLE clients ADD COLUMN kind TEXT DEFAULT 'client'",
      // дни недели приёма бада: "" — каждый день, иначе "1,3,5" (1=Пн..7=Вс)
      "ALTER TABLE supplement ADD COLUMN weekdays TEXT DEFAULT ''",
    ];
    for (const sql of alters) {
      try {
        await this.d1.prepare(sql).run();
      } catch {
        // колонка уже есть — игнорируем
      }
    }
    ready.schema = true;
  }

  // ---------- Задачи ----------

  async addTask(opts: {
    title: string;
    creatorId: number;
    description?: string;
    scope?: string;
    grp?: string;
    clientId?: number | null;
    assigneeId?: number | null;
    priority?: number;
    dueAt?: string | null;
    repeat?: string;
  }): Promise<number> {
    await this.ensureSchema();
    const res = await this.d1
      .prepare(
        `INSERT INTO tasks (title, description, scope, grp, client_id, creator_id, assignee_id, priority, due_at, repeat_rule, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .bind(
        tidyTitle(opts.title),
        tidyTitle(opts.description ?? ""),
        opts.scope ?? "work",
        opts.grp ?? "",
        opts.clientId ?? null,
        opts.creatorId,
        opts.assigneeId ?? null,
        opts.priority ?? 0,
        opts.dueAt ?? null,
        opts.repeat ?? "",
        nowIso()
      )
      .run();
    return res.meta.last_row_id as number;
  }

  /** Задача по id, только если она принадлежит пользователю (создана им или назначена ему). */
  async getTask(id: number, userId: number): Promise<Task | null> {
    return await this.d1
      .prepare("SELECT * FROM tasks WHERE id = ? AND (creator_id = ? OR assignee_id = ?)")
      .bind(id, userId, userId)
      .first<Task>();
  }

  /** Поиск активной задачи пользователя по названию (для «выполни/удали задачу …» голосом). */
  async findTaskByTitle(userId: number, title: string): Promise<Task | null> {
    const n = title.trim().toLowerCase();
    return await this.d1
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('open','in_progress') AND (creator_id = ? OR assignee_id = ?) AND lower(title) LIKE ?
         ORDER BY (lower(title) = ?) DESC, created_at DESC LIMIT 1`
      )
      .bind(userId, userId, `%${n}%`, n)
      .first<Task>();
  }

  /**
   * Список задач. `visibleTo` — обязательная граница видимости: пользователь видит
   * только свои задачи (созданные им или назначенные ему), включая владельца.
   * Личные аккаунты изолированы: чужие задачи не попадают ни в списки, ни в сводки.
   */
  async listTasks(opts: {
    statuses?: string[];
    visibleTo?: number | null;
    clientId?: number | null;
    scope?: string | null;
    grp?: string | null;
    orderByDone?: boolean;
    limit?: number;
  } = {}): Promise<Task[]> {
    await this.ensureSchema();
    const statuses = opts.statuses ?? [TASK_OPEN, TASK_IN_PROGRESS];
    let q = "SELECT * FROM tasks WHERE 1=1";
    const binds: unknown[] = [];
    if (statuses.length) {
      q += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      binds.push(...statuses);
    }
    if (opts.visibleTo != null) {
      q += " AND (assignee_id = ? OR creator_id = ?)";
      binds.push(opts.visibleTo, opts.visibleTo);
    }
    if (opts.clientId != null) {
      q += " AND client_id = ?";
      binds.push(opts.clientId);
    }
    if (opts.scope) {
      q += " AND scope = ?";
      binds.push(opts.scope);
    }
    if (opts.grp) {
      q += " AND grp = ?";
      binds.push(opts.grp);
    }
    q += opts.orderByDone
      ? " ORDER BY (done_at IS NULL), done_at DESC, created_at DESC"
      : " ORDER BY (due_at IS NULL), due_at, priority DESC, created_at";
    // Предел выборки: без него список рос вместе с историей, и раздел задач
    // открывался тем дольше, чем дольше человек пользуется ботом.
    if (opts.limit && opts.limit > 0) {
      q += " LIMIT ?";
      binds.push(opts.limit);
    }
    const { results } = await this.d1.prepare(q).bind(...binds).all<Task>();
    return results ?? [];
  }

  /** Смена статуса своей задачи. Возвращает false, если задача чужая или её нет. */
  async setTaskStatus(id: number, status: string, userId: number, tz = 3): Promise<boolean> {
    await this.ensureSchema();
    const doneAt = status === TASK_DONE ? nowIso() : null;
    const res = await this.d1
      .prepare("UPDATE tasks SET status = ?, done_at = ? WHERE id = ? AND (creator_id = ? OR assignee_id = ?)")
      .bind(status, doneAt, id, userId, userId)
      .run();
    const changed = (res.meta.changes ?? 0) > 0;
    if (changed && status === TASK_DONE) await this.repeatTask(id, userId, tz);
    return changed;
  }

  /**
   * Закрыли повторяющуюся задачу — сразу заводим следующую. Так список дел не
   * пустеет и не приходится каждый раз создавать одно и то же руками.
   * Возвращает id новой задачи или null.
   */
  private async repeatTask(id: number, userId: number, tz: number): Promise<number | null> {
    const t = await this.getTask(id, userId);
    if (!t || !t.repeat_rule) return null;
    const from = t.due_at || nowIso();
    const due = nextDue(t.repeat_rule, from, tz);
    if (!due) return null;
    return await this.addTask({
      title: t.title,
      description: t.description ?? "",
      scope: t.scope,
      clientId: t.client_id ?? null,
      creatorId: t.creator_id,
      assigneeId: t.assignee_id ?? null,
      priority: t.priority,
      dueAt: due,
      repeat: t.repeat_rule,
    });
  }

  /** Частичное обновление своей задачи (редактирование). */
  async updateTask(
    id: number,
    fields: { title?: string; description?: string; dueAt?: string | null; scope?: string; priority?: number; clientId?: number | null; repeat?: string; grp?: string },
    userId?: number
  ): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); binds.push(tidyTitle(fields.title)); }
    if (fields.description !== undefined) { sets.push("description = ?"); binds.push(tidyTitle(fields.description)); }
    if (fields.dueAt !== undefined) { sets.push("due_at = ?"); binds.push(fields.dueAt); }
    if (fields.scope !== undefined) { sets.push("scope = ?"); binds.push(fields.scope); }
    if (fields.priority !== undefined) { sets.push("priority = ?"); binds.push(fields.priority); }
    if (fields.clientId !== undefined) { sets.push("client_id = ?"); binds.push(fields.clientId); }
    if (fields.repeat !== undefined) { sets.push("repeat_rule = ?"); binds.push(fields.repeat); }
    if (fields.grp !== undefined) { sets.push("grp = ?"); binds.push(fields.grp); }
    if (!sets.length) return;
    binds.push(id);
    let where = "id = ?";
    if (userId != null) {
      where += " AND (creator_id = ? OR assignee_id = ?)";
      binds.push(userId, userId);
    }
    await this.d1.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE ${where}`).bind(...binds).run();
  }

  /** Удаление своей задачи. Возвращает false, если задача чужая или её нет. */
  async deleteTask(id: number, userId: number): Promise<boolean> {
    const res = await this.d1
      .prepare("DELETE FROM tasks WHERE id = ? AND (creator_id = ? OR assignee_id = ?)")
      .bind(id, userId, userId)
      .run();
    return (res.meta.changes ?? 0) > 0;
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

  /**
   * Задачи, у которых дедлайн ВПЕРЕДИ, но уже близко. Окно берём с запасом на
   * сутки: за сколько именно предупреждать, каждый решает сам в настройках,
   * и отбор по личному значению делает планировщик.
   */
  async tasksDueSoon(fromIsoStr: string, toIsoStr: string): Promise<Task[]> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('open','in_progress') AND due_at IS NOT NULL
           AND due_at > ? AND due_at <= ? AND pre_reminded_at IS NULL
         ORDER BY due_at`
      )
      .bind(fromIsoStr, toIsoStr)
      .all<Task>();
    return results ?? [];
  }

  /**
   * Числа для главного экрана одним запросом.
   *
   * Раньше ради трёх чисел выгружалась ВСЯ история выполненных задач — и первый
   * экран тем дольше открывался, чем дольше человек пользуется ботом. Считать
   * должна база, а не воркер.
   */
  async taskStats(userId: number, dayStartIso: string, weekAgoIso: string): Promise<{ doneToday: number; doneWeek: number; doneTotal: number }> {
    await this.ensureSchema();
    const row = await this.d1
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN done_at >= ? THEN 1 ELSE 0 END) AS today,
                SUM(CASE WHEN done_at >= ? THEN 1 ELSE 0 END) AS week
         FROM tasks
         WHERE status = 'done' AND (creator_id = ? OR assignee_id = ?)`
      )
      .bind(dayStartIso, weekAgoIso, userId, userId)
      .first<{ total: number; today: number; week: number }>();
    return { doneToday: row?.today ?? 0, doneWeek: row?.week ?? 0, doneTotal: row?.total ?? 0 };
  }

  /** Сколько активных задач по видам — тоже считаем запросом, а не перебором. */
  async activeTaskCounts(userId: number): Promise<{ work: number; personal: number }> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare(
        `SELECT scope, COUNT(*) AS c FROM tasks
         WHERE status IN ('open','in_progress') AND (creator_id = ? OR assignee_id = ?)
         GROUP BY scope`
      )
      .bind(userId, userId)
      .all<{ scope: string; c: number }>();
    let work = 0, personal = 0;
    for (const r of results ?? []) {
      if (r.scope === "personal") personal += r.c; else work += r.c;
    }
    return { work, personal };
  }

  /**
   * Задачи для повестки: просроченные и сегодняшние. Берём сразу нужные и
   * сразу немного — загружать все активные ради восьми строк незачем.
   */
  async tasksAgenda(userId: number, untilIso: string, limit = 8): Promise<Task[]> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at < ?
           AND (creator_id = ? OR assignee_id = ?)
         ORDER BY due_at LIMIT ?`
      )
      .bind(untilIso, userId, userId, limit)
      .all<Task>();
    return results ?? [];
  }

  async markPreReminded(id: number): Promise<void> {
    await this.d1.prepare("UPDATE tasks SET pre_reminded_at = ? WHERE id = ?").bind(nowIso(), id).run();
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

  async deleteNote(id: number, userId: number): Promise<boolean> {
    const res = await this.d1.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  // ---------- События / встречи ----------

  async addEvent(opts: {
    userId: number;
    title: string;
    startsAt: string;
    location?: string;
    notes?: string;
    remindBeforeMin?: number;
    clientId?: number | null;
  }): Promise<number> {
    await this.ensureSchema();
    const res = await this.d1
      .prepare(
        `INSERT INTO events (user_id, title, starts_at, location, notes, remind_before_min, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        opts.userId,
        tidyTitle(opts.title),
        opts.startsAt,
        tidyTitle(opts.location ?? ""),
        tidyTitle(opts.notes ?? ""),
        opts.remindBeforeMin ?? 30,
        opts.clientId ?? null,
        nowIso()
      )
      .run();
    return res.meta.last_row_id as number;
  }

  async listEvents(userId: number, fromIso: string): Promise<Event[]> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare("SELECT * FROM events WHERE user_id = ? AND starts_at >= ? ORDER BY starts_at LIMIT 100")
      .bind(userId, fromIso)
      .all<Event>();
    return results ?? [];
  }

  async deleteEvent(id: number, userId: number): Promise<boolean> {
    const res = await this.d1.prepare("DELETE FROM events WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Встречи клиента (последние + будущие). */
  async listEventsByClient(userId: number, clientId: number, limit = 20): Promise<Event[]> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare("SELECT * FROM events WHERE user_id = ? AND client_id = ? ORDER BY starts_at DESC LIMIT ?")
      .bind(userId, clientId, limit)
      .all<Event>();
    return results ?? [];
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
    fields: { title?: string; startsAt?: string; location?: string; notes?: string; clientId?: number | null }
  ): Promise<boolean> {
    await this.ensureSchema();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); binds.push(tidyTitle(fields.title)); }
    if (fields.startsAt !== undefined) { sets.push("starts_at = ?"); binds.push(fields.startsAt); }
    if (fields.location !== undefined) { sets.push("location = ?"); binds.push(tidyTitle(fields.location)); }
    if (fields.notes !== undefined) { sets.push("notes = ?"); binds.push(tidyTitle(fields.notes)); }
    if (fields.clientId !== undefined) { sets.push("client_id = ?"); binds.push(fields.clientId); }
    if (!sets.length) return false;
    binds.push(id, userId);
    const res = await this.d1.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    return (res.meta.changes ?? 0) > 0;
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
  ): Promise<boolean> {
    await this.ensureSchema();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name); }
    if (fields.birthday !== undefined) { sets.push("birthday = ?"); binds.push(fields.birthday); }
    if (fields.phone !== undefined) { sets.push("phone = ?"); binds.push(fields.phone); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); binds.push(fields.tags); }
    if (fields.notes !== undefined) { sets.push("notes = ?"); binds.push(fields.notes); }
    if (!sets.length) return false;
    binds.push(id, userId);
    const res = await this.d1.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async listContacts(userId: number): Promise<Contact[]> {
    await this.ensureSchema();
    const { results } = await this.d1
      .prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY name")
      .bind(userId)
      .all<Contact>();
    return results ?? [];
  }

  async deleteContact(id: number, userId: number): Promise<boolean> {
    const res = await this.d1.prepare("DELETE FROM contacts WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
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
  private async ensureAiTable(): Promise<void> {
    if (ready.ai) return;
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
    ready.ai = true;
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
  private async ensureSettings(): Promise<void> {
    if (ready.settings) return;
    await this.d1.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    ready.settings = true;
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

  // ---------- Личный профиль пользователя ----------
  async getProfile(userId: number): Promise<Profile> {
    const raw = await this.getSetting(`profile:${userId}`);
    if (!raw) return { ...EMPTY_PROFILE };
    try {
      return { ...EMPTY_PROFILE, ...(JSON.parse(raw) as Partial<Profile>) };
    } catch {
      return { ...EMPTY_PROFILE };
    }
  }

  async setProfile(userId: number, p: Profile): Promise<void> {
    await this.setSetting(`profile:${userId}`, JSON.stringify(p));
  }

  /**
   * Компактная сводка профиля (+ актуальный вес) для подстановки в промпты ИИ.
   * Пустая строка, если профиль не заполнен.
   */
  /**
   * Как Саре себя вести: имя, манера, обращение, эмодзи. Настраивается в
   * приложении по клику на её аватар и подмешивается к каждому ответу ИИ.
   */
  async personaContext(userId: number): Promise<string> {
    const p = await this.getPrefs(userId);
    const tone =
      p.tone === "business" ? "Говори по-деловому: сухо, по существу, без лишней теплоты."
      : p.tone === "brief" ? "Отвечай максимально коротко: одна-две фразы, только суть."
      : "Говори дружелюбно и живо, как хороший помощник, который давно с человеком работает.";
    const addr = p.address === "vy" ? "Обращайся на «вы»." : "Обращайся на «ты».";
    const emoji = p.emoji ? "Эмодзи уместны, но не больше одного-двух на ответ." : "Не используй эмодзи вообще.";
    const name = p.botName && p.botName !== "Сара" ? `Тебя зовут ${p.botName}.` : "Тебя зовут Сара.";
    const callMe = p.callMe ? ` К человеку обращайся по имени: ${p.callMe}.` : "";
    return `${name}${callMe} ${tone} ${addr} ${emoji}`;
  }

  async profileContext(userId: number): Promise<string> {
    const p = await this.getProfile(userId);
    const weights = await this.listWeights(userId, 1);
    const parts: string[] = [];
    if (p.name) parts.push(`имя: ${p.name}`);
    const sexRu = p.sex === "m" ? "мужской" : p.sex === "f" ? "женский" : "";
    if (sexRu) parts.push(`пол: ${sexRu}`);
    if (p.birth_year > 1900) parts.push(`возраст: ${new Date().getUTCFullYear() - p.birth_year}`);
    if (p.height_cm) parts.push(`рост: ${p.height_cm} см`);
    if (weights[0]) parts.push(`текущий вес: ${weights[0].kg} кг`);
    const actRu: Record<string, string> = { low: "низкая (сидячий образ жизни)", medium: "средняя", high: "высокая (активные тренировки)" };
    if (actRu[p.activity]) parts.push(`активность: ${actRu[p.activity]}`);
    const goalRu: Record<string, string> = { lose: "снижение веса", keep: "поддержание формы", gain: "набор массы" };
    if (goalRu[p.goal]) parts.push(`цель: ${goalRu[p.goal]}`);
    if (p.target_weight) parts.push(`целевой вес: ${p.target_weight} кг`);
    if (p.diet) parts.push(`тип питания: ${p.diet}`);
    if (p.allergies) parts.push(`аллергии/непереносимость (СТРОГО исключать): ${p.allergies}`);
    if (p.dislikes) parts.push(`не ест / не любит: ${p.dislikes}`);
    if (p.likes) parts.push(`любит / предпочитает: ${p.likes}`);
    if (p.conditions) parts.push(`здоровье / ограничения: ${p.conditions}`);
    if (p.about) parts.push(`о себе: ${p.about}`);
    if (!parts.length) return "";
    return (
      "Личный профиль пользователя — обязательно учитывай при персональных задачах " +
      "(меню, рацион, тренировки, советы по здоровью и т.п.). Аллергии и непереносимость исключай полностью. " +
      "Данные: " + parts.join("; ") + "."
    );
  }

  // ---------- БАДы / фарма (курсы приёма) ----------
  private async ensureSupp(): Promise<void> {
    if (ready.supp) return;
    await this.d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS supplement (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, dose TEXT DEFAULT '', times TEXT DEFAULT '[]', start_date TEXT DEFAULT '', days INTEGER DEFAULT 0, weekdays TEXT DEFAULT '', notes TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TEXT NOT NULL)"
      )
      .run();
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS supplement_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, sup_id INTEGER NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, created_at TEXT NOT NULL)")
      .run();
    ready.supp = true;
  }

  async addSupplement(userId: number, s: { name: string; dose?: string; times?: string[]; startDate?: string; days?: number; weekdays?: string; notes?: string }): Promise<number> {
    await this.ensureSupp();
    const res = await this.d1
      .prepare("INSERT INTO supplement (user_id, name, dose, times, start_date, days, weekdays, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .bind(userId, s.name, s.dose ?? "", JSON.stringify(s.times ?? []), s.startDate ?? "", s.days ?? 0, s.weekdays ?? "", s.notes ?? "", nowIso())
      .run();
    return res.meta.last_row_id as number;
  }

  async listSupplements(userId: number, activeOnly = true): Promise<SupplementRow[]> {
    await this.ensureSupp();
    const sql = activeOnly
      ? "SELECT * FROM supplement WHERE user_id = ? AND active = 1 ORDER BY name"
      : "SELECT * FROM supplement WHERE user_id = ? ORDER BY active DESC, name";
    const { results } = await this.d1.prepare(sql).bind(userId).all<SupplementRow>();
    return results ?? [];
  }

  /** Все активные курсы всех пользователей — для планировщика напоминаний. */
  async allActiveSupplements(): Promise<SupplementRow[]> {
    await this.ensureSupp();
    const { results } = await this.d1.prepare("SELECT * FROM supplement WHERE active = 1").all<SupplementRow>();
    return results ?? [];
  }

  async updateSupplement(id: number, userId: number, fields: { name?: string; dose?: string; times?: string[]; days?: number; weekdays?: string; notes?: string; active?: number }): Promise<boolean> {
    await this.ensureSupp();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); binds.push(fields.name); }
    if (fields.dose !== undefined) { sets.push("dose = ?"); binds.push(fields.dose); }
    if (fields.times !== undefined) { sets.push("times = ?"); binds.push(JSON.stringify(fields.times)); }
    if (fields.days !== undefined) { sets.push("days = ?"); binds.push(fields.days); }
    if (fields.weekdays !== undefined) { sets.push("weekdays = ?"); binds.push(fields.weekdays); }
    if (fields.notes !== undefined) { sets.push("notes = ?"); binds.push(fields.notes); }
    if (fields.active !== undefined) { sets.push("active = ?"); binds.push(fields.active); }
    if (!sets.length) return false;
    binds.push(id, userId);
    const res = await this.d1.prepare(`UPDATE supplement SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async deleteSupplement(id: number, userId: number): Promise<boolean> {
    await this.ensureSupp();
    const res = await this.d1.prepare("DELETE FROM supplement WHERE id = ? AND user_id = ?").bind(id, userId).run();
    await this.d1.prepare("DELETE FROM supplement_log WHERE sup_id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Переключить отметку приёма (принял/отменил). Возвращает true, если теперь принято. */
  async toggleSupLog(userId: number, supId: number, date: string, slot: string): Promise<boolean> {
    await this.ensureSupp();
    const existing = await this.d1
      .prepare("SELECT id FROM supplement_log WHERE user_id = ? AND sup_id = ? AND date = ? AND slot = ?")
      .bind(userId, supId, date, slot)
      .first<{ id: number }>();
    if (existing) {
      await this.d1.prepare("DELETE FROM supplement_log WHERE id = ?").bind(existing.id).run();
      return false;
    }
    await this.d1.prepare("INSERT INTO supplement_log (user_id, sup_id, date, slot, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, supId, date, slot, nowIso()).run();
    return true;
  }

  async supLogs(userId: number, dateFrom: string, dateTo: string): Promise<{ sup_id: number; date: string; slot: string }[]> {
    await this.ensureSupp();
    const { results } = await this.d1
      .prepare("SELECT sup_id, date, slot FROM supplement_log WHERE user_id = ? AND date >= ? AND date <= ?")
      .bind(userId, dateFrom, dateTo)
      .all<{ sup_id: number; date: string; slot: string }>();
    return results ?? [];
  }

  async supTaken(userId: number, supId: number, date: string, slot: string): Promise<boolean> {
    await this.ensureSupp();
    const r = await this.d1
      .prepare("SELECT id FROM supplement_log WHERE user_id = ? AND sup_id = ? AND date = ? AND slot = ?")
      .bind(userId, supId, date, slot)
      .first();
    return !!r;
  }

  // ---------- Настройки уведомлений (на пользователя) ----------
  async getNotif(userId: number): Promise<NotifSettings> {
    const raw = await this.getSetting(`notif:${userId}`);
    const def: NotifSettings = {
      morning: { on: true, hour: 9 },
      tasks: { on: true, lead: 60 },
      events: { on: true, lead: 30 },
      birthdays: { on: true },
      water: { on: false, everyHours: 2, from: 9, to: 21 },
      meals: { on: false, breakfast: 9, lunch: 14, dinner: 19 },
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
        meals: { ...def.meals, ...(p.meals || {}) },
      };
    } catch {
      return def;
    }
  }

  async setNotif(userId: number, s: NotifSettings): Promise<void> {
    await this.setSetting(`notif:${userId}`, JSON.stringify(s));
  }

  // ---------- Уроки: чему человек научил Сару ----------
  /**
   * Запоминаем исправление: «это была еда, а не задача». Такие пары уходят в
   * подсказку маршрутизатора, поэтому одна и та же ошибка не повторяется.
   * Держим последние двадцать — этого хватает, а подсказка не раздувается.
   */
  async addLesson(userId: number, phrase: string, action: string): Promise<void> {
    const clean = phrase.trim().slice(0, 200);
    if (!clean) return;
    const prev = await this.listLessons(userId);
    const next = [{ phrase: clean, action }, ...prev.filter((l) => l.phrase.toLowerCase() !== clean.toLowerCase())].slice(0, 20);
    await this.setSetting(`lessons:${userId}`, JSON.stringify(next));
  }

  async listLessons(userId: number): Promise<{ phrase: string; action: string }[]> {
    const raw = await this.getSetting(`lessons:${userId}`);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((l) => l && typeof l.phrase === "string" && typeof l.action === "string") : [];
    } catch {
      return [];
    }
  }

  // ---------- Внешний вид приложения (на пользователя) ----------
  async getPrefs(userId: number): Promise<AppPrefs> {
    const raw = await this.getSetting(`prefs:${userId}`);
    if (!raw) return { ...DEFAULT_PREFS };
    try {
      const p = JSON.parse(raw) as Partial<AppPrefs>;
      return {
        ...DEFAULT_PREFS,
        ...p,
        hidden: Array.isArray(p.hidden) ? p.hidden.filter((x) => typeof x === "string").slice(0, 8) : [],
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  async setPrefs(userId: number, p: AppPrefs): Promise<void> {
    await this.setSetting(`prefs:${userId}`, JSON.stringify(p));
  }

  // ---------- Здоровье: питание и вода ----------
  private async ensureHealth(): Promise<void> {
    if (ready.health) return;
    await this.d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS food_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, title TEXT NOT NULL, kcal INTEGER DEFAULT 0, protein INTEGER DEFAULT 0, fat INTEGER DEFAULT 0, carbs INTEGER DEFAULT 0)"
      )
      .run();
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS water_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, ml INTEGER NOT NULL)")
      .run();
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS weight_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, kg REAL NOT NULL)")
      .run();
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS health_note (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL)")
      .run();
    try {
      await this.d1.prepare("ALTER TABLE food_log ADD COLUMN meal TEXT DEFAULT ''").run();
    } catch {
      // колонка уже есть
    }
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts TEXT NOT NULL, title TEXT NOT NULL, kcal INTEGER DEFAULT 0)")
      .run();
    for (const a of ["ALTER TABLE activity_log ADD COLUMN type TEXT DEFAULT ''", "ALTER TABLE activity_log ADD COLUMN duration_min INTEGER DEFAULT 0"]) {
      try { await this.d1.prepare(a).run(); } catch { /* колонка есть */ }
    }
    await this.d1
      .prepare("CREATE TABLE IF NOT EXISTS wellbeing (user_id INTEGER NOT NULL, date TEXT NOT NULL, sleep REAL, mood TEXT, PRIMARY KEY (user_id, date))")
      .run();
    ready.health = true;
  }

  async addActivity(userId: number, title: string, kcal: number, type = "", durationMin = 0): Promise<number> {
    await this.ensureHealth();
    const res = await this.d1
      .prepare("INSERT INTO activity_log (user_id, ts, title, kcal, type, duration_min) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, nowIso(), title, kcal, type, durationMin)
      .run();
    return res.meta.last_row_id as number;
  }

  async listActivity(userId: number, startIso: string, endIso: string): Promise<ActivityRow[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT id, ts, title, kcal, type, duration_min FROM activity_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .bind(userId, startIso, endIso)
      .all<ActivityRow>();
    return results ?? [];
  }

  async deleteActivity(id: number, userId: number): Promise<boolean> {
    await this.ensureHealth();
    const res = await this.d1.prepare("DELETE FROM activity_log WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async lastActivity(userId: number): Promise<ActivityRow | null> {
    await this.ensureHealth();
    return await this.d1
      .prepare("SELECT id, ts, title, kcal, type, duration_min FROM activity_log WHERE user_id = ? ORDER BY ts DESC LIMIT 1")
      .bind(userId)
      .first<ActivityRow>();
  }

  /** Частые/недавние тренировки (уникальные по названию) для быстрого повтора. */
  async recentWorkouts(userId: number, sinceIso: string, limit = 6): Promise<ActivityRow[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT id, ts, title, kcal, type, duration_min FROM activity_log WHERE user_id = ? AND ts >= ? ORDER BY ts DESC")
      .bind(userId, sinceIso)
      .all<ActivityRow>();
    const seen = new Set<string>();
    const out: ActivityRow[] = [];
    for (const a of results ?? []) { const k = a.title.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(a); if (out.length >= limit) break; }
    return out;
  }

  async setWellbeing(userId: number, date: string, fields: { sleep?: number; mood?: string }): Promise<void> {
    await this.ensureHealth();
    const cur = await this.getWellbeing(userId, date);
    const sleep = fields.sleep !== undefined ? fields.sleep : cur?.sleep ?? null;
    const mood = fields.mood !== undefined ? fields.mood : cur?.mood ?? null;
    await this.d1
      .prepare("INSERT INTO wellbeing (user_id, date, sleep, mood) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET sleep = excluded.sleep, mood = excluded.mood")
      .bind(userId, date, sleep, mood)
      .run();
  }

  async getWellbeing(userId: number, date: string): Promise<{ sleep: number | null; mood: string | null } | null> {
    await this.ensureHealth();
    return await this.d1.prepare("SELECT sleep, mood FROM wellbeing WHERE user_id = ? AND date = ?").bind(userId, date).first<{ sleep: number | null; mood: string | null }>();
  }

  async lastFood(userId: number, startIso: string, endIso: string): Promise<FoodEntry | null> {
    await this.ensureHealth();
    return await this.d1
      .prepare("SELECT * FROM food_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1")
      .bind(userId, startIso, endIso)
      .first<FoodEntry>();
  }

  async addWeight(userId: number, kg: number): Promise<void> {
    await this.ensureHealth();
    await this.d1.prepare("INSERT INTO weight_log (user_id, ts, kg) VALUES (?, ?, ?)").bind(userId, nowIso(), kg).run();
  }

  async listWeights(userId: number, limit = 14): Promise<{ id: number; ts: string; kg: number }[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT id, ts, kg FROM weight_log WHERE user_id = ? ORDER BY ts DESC LIMIT ?")
      .bind(userId, limit)
      .all<{ id: number; ts: string; kg: number }>();
    return results ?? [];
  }

  async addHealthNote(userId: number, text: string): Promise<number> {
    await this.ensureHealth();
    const res = await this.d1.prepare("INSERT INTO health_note (user_id, ts, text) VALUES (?, ?, ?)").bind(userId, nowIso(), text).run();
    return res.meta.last_row_id as number;
  }

  async listHealthNotes(userId: number, startIso: string, endIso: string): Promise<{ id: number; ts: string; text: string }[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT id, ts, text FROM health_note WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .bind(userId, startIso, endIso)
      .all<{ id: number; ts: string; text: string }>();
    return results ?? [];
  }

  async deleteHealthNote(id: number, userId: number): Promise<boolean> {
    await this.ensureHealth();
    const res = await this.d1.prepare("DELETE FROM health_note WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async addFood(userId: number, f: { title: string; kcal: number; protein: number; fat: number; carbs: number; meal?: string }): Promise<number> {
    await this.ensureHealth();
    const res = await this.d1
      .prepare("INSERT INTO food_log (user_id, ts, title, kcal, protein, fat, carbs, meal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(userId, nowIso(), f.title, f.kcal, f.protein, f.fat, f.carbs, f.meal ?? "")
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

  async deleteFood(id: number, userId: number): Promise<boolean> {
    await this.ensureHealth();
    const res = await this.d1.prepare("DELETE FROM food_log WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Частые/недавние блюда (уникальные по названию), для быстрого повтора. */
  async recentFoods(userId: number, sinceIso: string, limit = 8): Promise<FoodEntry[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT * FROM food_log WHERE user_id = ? AND ts >= ? ORDER BY ts DESC")
      .bind(userId, sinceIso)
      .all<FoodEntry>();
    const seen = new Set<string>();
    const out: FoodEntry[] = [];
    for (const e of results ?? []) {
      const key = e.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  async addWater(userId: number, ml: number): Promise<void> {
    await this.ensureHealth();
    await this.d1.prepare("INSERT INTO water_log (user_id, ts, ml) VALUES (?, ?, ?)").bind(userId, nowIso(), ml).run();
  }

  async listWater(userId: number, startIso: string, endIso: string): Promise<{ ts: string; ml: number }[]> {
    await this.ensureHealth();
    const { results } = await this.d1
      .prepare("SELECT ts, ml FROM water_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .bind(userId, startIso, endIso)
      .all<{ ts: string; ml: number }>();
    return results ?? [];
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
