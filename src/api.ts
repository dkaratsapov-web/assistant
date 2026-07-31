import { askAIChat, ChatMessage } from "./ai";
import { DB } from "./db";
import {
  Env,
  ROLE_OWNER,
  ROLE_PENDING,
  SCOPE_PERSONAL,
  SCOPE_WORK,
  TASK_DONE,
  TASK_IN_PROGRESS,
  TASK_OPEN,
} from "./types";
import { formatDue, localInputToUtc, parseDue, tzOffsetOf } from "./utils";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyData: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyData as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}

/** Проверка подписи Telegram WebApp initData. Возвращает user или null. */
export async function validateInitData(
  initData: string,
  botToken: string,
  maxAge = 86400
): Promise<{ id: number; [k: string]: unknown } | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");

  const pairs: string[] = [];
  [...params.keys()].sort().forEach((k) => pairs.push(`${k}=${params.get(k)}`));
  const dcs = pairs.join("\n");

  const secretKey = await hmac(enc.encode("WebAppData"), botToken);
  const calc = toHex(await hmac(secretKey, dcs));
  if (calc !== receivedHash) return null;

  const authDate = parseInt(params.get("auth_date") ?? "0", 10);
  if (maxAge && Date.now() / 1000 - authDate > maxAge) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "{}");
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Обрабатывает /api/* с проверкой доступа. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const db = new DB(env.DB);
  const url = new URL(request.url);
  const path = url.pathname;
  const tz = tzOffsetOf(env);

  const initData = request.headers.get("X-Telegram-Init-Data") ?? "";
  const tgUser = await validateInitData(initData, env.BOT_TOKEN);
  if (!tgUser) return json({ error: "unauthorized" }, 401);

  if (tgUser.id === parseInt(env.OWNER_ID, 10)) await db.ensureOwner(tgUser.id);
  const user = await db.getUser(tgUser.id);
  if (!user || user.role === ROLE_PENDING) return json({ error: "no_access" }, 403);

  const isOwner = user.role === ROLE_OWNER;
  const uid = user.user_id;

  // GET /api/me
  if (path === "/api/me" && request.method === "GET") {
    return json({ user_id: uid, role: user.role });
  }

  // GET /api/tasks
  if (path === "/api/tasks" && request.method === "GET") {
    const filter = url.searchParams.get("status") ?? "active";
    const scopeParam = url.searchParams.get("scope");
    const scope = scopeParam === SCOPE_PERSONAL || scopeParam === SCOPE_WORK ? scopeParam : null;
    const statuses =
      filter === "done" ? [TASK_DONE] : filter === "all" ? [TASK_OPEN, TASK_IN_PROGRESS, TASK_DONE] : [TASK_OPEN, TASK_IN_PROGRESS];
    const tasks = await db.listTasks({ statuses, assigneeId: isOwner ? null : uid, scope });
    const out = [];
    for (const t of tasks) {
      const client = t.client_id ? await db.getClient(t.client_id) : null;
      out.push({
        id: t.id, title: t.title, description: t.description, scope: t.scope,
        status: t.status, priority: t.priority, due_at: t.due_at, client: client?.name ?? null,
      });
    }
    return json({ tasks: out });
  }

  // POST /api/tasks
  if (path === "/api/tasks" && request.method === "POST") {
    const body = (await request.json()) as {
      title?: string; due?: string; client_id?: number | null; scope?: string; priority?: number;
    };
    const title = (body.title ?? "").trim();
    if (!title) return json({ error: "empty_title" }, 400);
    const dueAt = body.due ? parseDue(body.due, tz) : null;
    const scope = body.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
    const id = await db.addTask({
      title, creatorId: uid, assigneeId: uid, scope,
      clientId: body.client_id ?? null, priority: body.priority ? 1 : 0, dueAt,
    });
    return json({ ok: true, id });
  }

  // POST /api/tasks/{id}/status
  const statusMatch = path.match(/^\/api\/tasks\/(\d+)\/status$/);
  if (statusMatch && request.method === "POST") {
    const body = (await request.json()) as { status?: string };
    if (![TASK_OPEN, TASK_IN_PROGRESS, TASK_DONE].includes(body.status ?? "")) return json({ error: "bad_status" }, 400);
    const task = await db.getTask(parseInt(statusMatch[1], 10));
    if (!task) return json({ error: "not_found" }, 404);
    await db.setTaskStatus(task.id, body.status!);
    return json({ ok: true });
  }

  // DELETE /api/tasks/{id}
  const delMatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (delMatch && request.method === "DELETE") {
    await db.deleteTask(parseInt(delMatch[1], 10));
    return json({ ok: true });
  }

  // GET /api/clients
  if (path === "/api/clients" && request.method === "GET") {
    const clients = await db.listClients();
    return json({ clients: clients.map((c) => ({ id: c.id, name: c.name, platforms: c.platforms, status: c.status, budget: c.budget })) });
  }

  // POST /api/ai — диалог с ИИ (YandexGPT) с историей
  if (path === "/api/ai" && request.method === "POST") {
    if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) return json({ error: "ai_not_configured" }, 400);
    const body = (await request.json()) as { messages?: { role?: string; content?: string }[]; prompt?: string };
    let msgs: ChatMessage[] = [];
    if (Array.isArray(body.messages)) {
      msgs = body.messages
        .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
        .slice(-20)
        .map((m) => ({ role: m.role as "user" | "assistant", text: m.content as string }));
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      msgs = [{ role: "user", text: body.prompt.trim() }];
    }
    if (!msgs.length) return json({ error: "empty" }, 400);
    const reply = await askAIChat(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, msgs, env.YANDEX_MODEL ?? "yandexgpt/latest");
    return json({ reply });
  }

  // GET /api/notes
  if (path === "/api/notes" && request.method === "GET") {
    const notes = await db.listNotes(uid, 50);
    return json({ notes: notes.map((n) => ({ id: n.id, text: n.text, tags: n.tags })) });
  }

  // GET /api/home — агенда: сегодня/просрочка, ближайшие встречи и ДР
  if (path === "/api/home" && request.method === "GET") {
    const assignee = isOwner ? null : uid;
    const active = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], assigneeId: assignee });
    const nowMs = Date.now();
    const todayLocalDay = Math.floor((nowMs + tz * 3600_000) / 86400_000);
    const agendaTasks = active
      .filter((t) => {
        if (!t.due_at) return false;
        const dueMs = new Date(t.due_at).getTime();
        const dueDay = Math.floor((dueMs + tz * 3600_000) / 86400_000);
        return dueMs < nowMs || dueDay === todayLocalDay;
      })
      .slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, scope: t.scope, status: t.status, due_at: t.due_at, overdue: new Date(t.due_at!).getTime() < nowMs }));

    const events = (await db.listEvents(uid, new Date().toISOString())).slice(0, 5).map((e) => ({
      id: e.id, title: e.title, starts_at: e.starts_at, location: e.location,
    }));

    // Ближайшие дни рождения (14 дней)
    const contacts = await db.listContacts(uid);
    const upcomingBirthdays: { id: number; name: string; date: string; in_days: number }[] = [];
    const nowLocal = new Date(nowMs + tz * 3600_000);
    for (const c of contacts) {
      if (!c.birthday) continue;
      const mmdd = c.birthday.slice(-5); // MM-DD
      const [mo, d] = mmdd.split("-").map((x) => parseInt(x, 10));
      if (!mo || !d) continue;
      let next = Date.UTC(nowLocal.getUTCFullYear(), mo - 1, d);
      const todayUtc0 = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate());
      if (next < todayUtc0) next = Date.UTC(nowLocal.getUTCFullYear() + 1, mo - 1, d);
      const inDays = Math.round((next - todayUtc0) / 86400_000);
      if (inDays <= 14) upcomingBirthdays.push({ id: c.id, name: c.name, date: mmdd, in_days: inDays });
    }
    upcomingBirthdays.sort((a, b) => a.in_days - b.in_days);

    return json({
      tasks: agendaTasks,
      events,
      birthdays: upcomingBirthdays,
      counts: {
        personal: active.filter((t) => t.scope === SCOPE_PERSONAL).length,
        work: active.filter((t) => t.scope === SCOPE_WORK).length,
      },
    });
  }

  // GET /api/events
  if (path === "/api/events" && request.method === "GET") {
    const events = await db.listEvents(uid, new Date().toISOString());
    return json({ events: events.map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at, location: e.location, notes: e.notes })) });
  }

  // POST /api/events
  if (path === "/api/events" && request.method === "POST") {
    const body = (await request.json()) as { title?: string; at?: string; location?: string; notes?: string };
    const title = (body.title ?? "").trim();
    if (!title) return json({ error: "empty_title" }, 400);
    const startsAt = body.at ? localInputToUtc(body.at, tz) : null;
    if (!startsAt) return json({ error: "bad_date" }, 400);
    const id = await db.addEvent({ userId: uid, title, startsAt, location: body.location ?? "", notes: body.notes ?? "" });
    return json({ ok: true, id });
  }

  // DELETE /api/events/{id}
  const evDel = path.match(/^\/api\/events\/(\d+)$/);
  if (evDel && request.method === "DELETE") {
    await db.deleteEvent(parseInt(evDel[1], 10), uid);
    return json({ ok: true });
  }

  // GET /api/contacts (дни рождения)
  if (path === "/api/contacts" && request.method === "GET") {
    const contacts = await db.listContacts(uid);
    return json({ contacts: contacts.map((c) => ({ id: c.id, name: c.name, birthday: c.birthday, phone: c.phone, notes: c.notes })) });
  }

  // POST /api/contacts
  if (path === "/api/contacts" && request.method === "POST") {
    const body = (await request.json()) as { name?: string; birthday?: string; phone?: string; notes?: string };
    const name = (body.name ?? "").trim();
    if (!name) return json({ error: "empty_name" }, 400);
    let birthday = (body.birthday ?? "").trim() || null; // ожидаем MM-DD или YYYY-MM-DD
    if (birthday && !/^\d{2}-\d{2}$/.test(birthday) && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) birthday = null;
    const id = await db.addContact({ userId: uid, name, birthday, phone: body.phone ?? "", notes: body.notes ?? "" });
    return json({ ok: true, id });
  }

  // DELETE /api/contacts/{id}
  const cDel = path.match(/^\/api\/contacts\/(\d+)$/);
  if (cDel && request.method === "DELETE") {
    await db.deleteContact(parseInt(cDel[1], 10), uid);
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}
