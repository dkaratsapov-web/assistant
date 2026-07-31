import { askAIChat, ChatMessage, DEFAULT_MODEL, estimateNutrition } from "./ai";
import { DB } from "./db";
import { tryPerformCommand } from "./intent";
import { telemostConnected, telemostCreate, telemostAuthUrl, telemostExchangeCode, metrikaStats } from "./telemost";
import { transcribeVoice } from "./speech";
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
import { localInputToUtc, parseDue, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf } from "./utils";

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
    return json({ user_id: uid, role: user.role, telemost: await telemostConnected(db), voice: !!(env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID) });
  }

  // ---------- Здоровье: питание и вода ----------
  if (path === "/api/health" && request.method === "GET") {
    const tzh = tzOffsetOf(env);
    const start = startOfLocalDayIso(tzh), end = startOfLocalDayOffsetIso(tzh, 1);
    const entries = await db.listFood(uid, start, end);
    const kcal = entries.reduce((s, e) => s + e.kcal, 0);
    const protein = entries.reduce((s, e) => s + e.protein, 0);
    const fat = entries.reduce((s, e) => s + e.fat, 0);
    const carbs = entries.reduce((s, e) => s + e.carbs, 0);
    const water = await db.waterTotal(uid, start, end);
    const kcalGoal = parseInt((await db.getSetting(`hkcal:${uid}`)) ?? "", 10) || 2000;
    const waterGoal = parseInt((await db.getSetting(`hwater:${uid}`)) ?? "", 10) || 2000;
    return json({ kcal: { consumed: kcal, goal: kcalGoal, protein, fat, carbs }, water: { ml: water, goal: waterGoal }, entries });
  }

  if (path === "/api/health/food" && request.method === "POST") {
    const body = (await request.json()) as { title?: string; kcal?: number; protein?: number; fat?: number; carbs?: number };
    const title = (body.title ?? "").trim();
    if (!title) return json({ error: "empty" }, 400);
    let n = { title, kcal: 0, protein: 0, fat: 0, carbs: 0 };
    if (body.kcal != null) {
      n = { title, kcal: Math.max(0, Math.round(+body.kcal || 0)), protein: Math.max(0, Math.round(+(body.protein ?? 0))), fat: Math.max(0, Math.round(+(body.fat ?? 0))), carbs: Math.max(0, Math.round(+(body.carbs ?? 0))) };
    } else {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "ai_not_configured" }, 400);
      const est = await estimateNutrition(env.ANTHROPIC_API_KEY, title);
      if (!est) return json({ error: "estimate_failed" }, 502);
      n = est;
    }
    const id = await db.addFood(uid, n);
    return json({ ok: true, id, entry: { id, ...n } });
  }

  const foodDel = path.match(/^\/api\/health\/food\/(\d+)$/);
  if (foodDel && request.method === "DELETE") {
    await db.deleteFood(parseInt(foodDel[1], 10), uid);
    return json({ ok: true });
  }

  if (path === "/api/health/water" && request.method === "POST") {
    const body = (await request.json()) as { ml?: number };
    const ml = Math.max(1, Math.round(+(body.ml ?? 250) || 250));
    await db.addWater(uid, ml);
    const tzh = tzOffsetOf(env);
    const total = await db.waterTotal(uid, startOfLocalDayIso(tzh), startOfLocalDayOffsetIso(tzh, 1));
    return json({ ok: true, total });
  }

  if (path === "/api/health/goals" && request.method === "POST") {
    const body = (await request.json()) as { kcal?: number; water?: number };
    if (body.kcal != null) await db.setSetting(`hkcal:${uid}`, String(Math.max(0, Math.round(+body.kcal || 0))));
    if (body.water != null) await db.setSetting(`hwater:${uid}`, String(Math.max(0, Math.round(+body.water || 0))));
    return json({ ok: true });
  }

  // GET /api/reports/metrika?client=ID&days=N — сводка Метрики по клиенту
  if (path === "/api/reports/metrika" && request.method === "GET") {
    const u = new URL(request.url);
    const clientId = parseInt(u.searchParams.get("client") ?? "", 10);
    const days = Math.min(365, Math.max(1, parseInt(u.searchParams.get("days") ?? "30", 10)));
    const client = clientId ? await db.getClient(clientId) : null;
    if (!client) return json({ error: "not_found" }, 404);
    if (!client.metrika_counter) return json({ error: "no_counter" }, 400);
    if (!(await telemostConnected(db))) return json({ error: "yandex_not_connected" }, 400);
    const tz = tzOffsetOf(env);
    const nowL = new Date(Date.now() + tz * 3600_000);
    const ymd = (dt: Date) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    const date2 = ymd(nowL);
    const date1 = ymd(new Date(nowL.getTime() - (days - 1) * 86400_000));
    try {
      const report = await metrikaStats(env, db, client.metrika_counter, date1, date2);
      return json({ client: client.name, days, date1, date2, report });
    } catch (e) {
      return json({ error: "metrika_failed", message: (e as Error).message }, 502);
    }
  }

  // GET /api/telemost/auth-url — ссылка на вход в Яндекс (owner)
  if (path === "/api/telemost/auth-url" && request.method === "GET") {
    if (user.role !== ROLE_OWNER) return json({ error: "forbidden" }, 403);
    if (!env.TELEMOST_CLIENT_ID) return json({ error: "no_client_id" }, 400);
    return json({ url: telemostAuthUrl(env.TELEMOST_CLIENT_ID) });
  }

  // POST /api/telemost/connect {code} — обменять код на токены (owner)
  if (path === "/api/telemost/connect" && request.method === "POST") {
    if (user.role !== ROLE_OWNER) return json({ error: "forbidden" }, 403);
    const body = (await request.json()) as { code?: string };
    const code = (body.code ?? "").trim();
    if (!code) return json({ error: "empty_code" }, 400);
    try {
      await telemostExchangeCode(env, db, code);
      return json({ ok: true });
    } catch (e) {
      return json({ error: "connect_failed", message: (e as Error).message }, 502);
    }
  }

  // POST /api/voice — распознать речь (PCM 16кГц из вебапа) → текст
  if (path === "/api/voice" && request.method === "POST") {
    if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) return json({ error: "stt_not_configured" }, 400);
    const audio = await request.arrayBuffer();
    if (!audio || audio.byteLength < 800) return json({ error: "empty_audio" }, 400);
    try {
      const text = await transcribeVoice(env.YANDEX_API_KEY, env.YANDEX_FOLDER_ID, audio, { format: "lpcm", sampleRateHertz: 16000 });
      return json({ text });
    } catch (e) {
      return json({ error: "stt_failed", message: (e as Error).message }, 502);
    }
  }

  // GET /api/tasks
  if (path === "/api/tasks" && request.method === "GET") {
    const filter = url.searchParams.get("status") ?? "active";
    const scopeParam = url.searchParams.get("scope");
    const scope = scopeParam === SCOPE_PERSONAL || scopeParam === SCOPE_WORK ? scopeParam : null;
    const statuses =
      filter === "done" ? [TASK_DONE] : filter === "all" ? [TASK_OPEN, TASK_IN_PROGRESS, TASK_DONE] : [TASK_OPEN, TASK_IN_PROGRESS];
    const tasks = await db.listTasks({ statuses, assigneeId: isOwner ? null : uid, scope, orderByDone: filter === "done" });
    const out = [];
    for (const t of tasks) {
      const client = t.client_id ? await db.getClient(t.client_id) : null;
      out.push({
        id: t.id, title: t.title, description: t.description, scope: t.scope,
        status: t.status, priority: t.priority, due_at: t.due_at, done_at: t.done_at, client: client?.name ?? null,
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

  // POST /api/tasks/{id} — редактирование задачи
  const editMatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (editMatch && request.method === "POST") {
    const body = (await request.json()) as { title?: string; due?: string; scope?: string; priority?: number };
    const fields: { title?: string; dueAt?: string | null; scope?: string; priority?: number } = {};
    if (body.title !== undefined) {
      const t = body.title.trim();
      if (!t) return json({ error: "empty_title" }, 400);
      fields.title = t;
    }
    if (body.due !== undefined) fields.dueAt = body.due.trim() ? parseDue(body.due, tz) : null;
    if (body.scope !== undefined) fields.scope = body.scope === SCOPE_PERSONAL ? SCOPE_PERSONAL : SCOPE_WORK;
    if (body.priority !== undefined) fields.priority = body.priority ? 1 : 0;
    await db.updateTask(parseInt(editMatch[1], 10), fields);
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
    return json({ clients: clients.map((c) => ({ id: c.id, name: c.name, platforms: c.platforms, status: c.status, budget: c.budget, pay_amount: c.pay_amount, pay_due: c.pay_due, metrika_counter: c.metrika_counter, direct_login: c.direct_login })) });
  }

  // POST /api/clients — добавить клиента
  if (path === "/api/clients" && request.method === "POST") {
    const body = (await request.json()) as { name?: string; platforms?: string; budget?: string; pay_amount?: string; pay_due?: string };
    const name = (body.name ?? "").trim();
    if (!name) return json({ error: "empty_name" }, 400);
    const id = await db.addClient(name, (body.platforms ?? "").trim(), (body.budget ?? "").trim(), {
      payAmount: (body.pay_amount ?? "").trim(),
      payDue: (body.pay_due ?? "").trim(),
    });
    return json({ ok: true, id });
  }

  // POST /api/clients/{id}/status — пауза/актив
  const clStatus = path.match(/^\/api\/clients\/(\d+)\/status$/);
  if (clStatus && request.method === "POST") {
    const body = (await request.json()) as { status?: string };
    const status = body.status === "paused" ? "paused" : "active";
    await db.updateClientStatus(parseInt(clStatus[1], 10), status);
    return json({ ok: true });
  }

  // POST /api/clients/{id} — редактировать клиента
  const clEdit = path.match(/^\/api\/clients\/(\d+)$/);
  if (clEdit && request.method === "POST") {
    const body = (await request.json()) as { name?: string; platforms?: string; budget?: string; pay_amount?: string; pay_due?: string; metrika_counter?: string; direct_login?: string };
    const fields: { name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string; metrikaCounter?: string; directLogin?: string } = {};
    if (body.name !== undefined) {
      const n = body.name.trim();
      if (!n) return json({ error: "empty_name" }, 400);
      fields.name = n;
    }
    if (body.platforms !== undefined) fields.platforms = body.platforms;
    if (body.budget !== undefined) fields.budget = body.budget;
    if (body.pay_amount !== undefined) fields.payAmount = body.pay_amount;
    if (body.pay_due !== undefined) fields.payDue = body.pay_due;
    if (body.metrika_counter !== undefined) fields.metrikaCounter = body.metrika_counter;
    if (body.direct_login !== undefined) fields.directLogin = body.direct_login;
    await db.updateClient(parseInt(clEdit[1], 10), fields);
    return json({ ok: true });
  }

  // DELETE /api/clients/{id}
  const clDel = path.match(/^\/api\/clients\/(\d+)$/);
  if (clDel && request.method === "DELETE") {
    await db.deleteClient(parseInt(clDel[1], 10));
    return json({ ok: true });
  }

  // GET /api/ai/history — кеш переписки с Сарой
  if (path === "/api/ai/history" && request.method === "GET") {
    const messages = await db.listAiMessages(uid, 60);
    return json({ messages });
  }

  // DELETE /api/ai/history — очистить переписку
  if (path === "/api/ai/history" && request.method === "DELETE") {
    await db.clearAiMessages(uid);
    return json({ ok: true });
  }

  // POST /api/ai — диалог с ИИ (Claude); история хранится на сервере
  if (path === "/api/ai" && request.method === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "ai_not_configured" }, 400);
    const body = (await request.json()) as { messages?: { role?: string; content?: string }[]; prompt?: string };
    let userText = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!userText && Array.isArray(body.messages)) {
      const last = [...body.messages].reverse().find((m) => m?.role === "user" && typeof m.content === "string");
      userText = (last?.content ?? "").trim();
    }
    if (!userText) return json({ error: "empty" }, 400);

    const model = env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    // 1) Команда (создать задачу/встречу/контакт) или обычный вопрос?
    let reply: string;
    const action = await tryPerformCommand(env, db, uid, userText, false);
    if (action) {
      reply = action;
    } else {
      // 2) Обычный диалог с историей
      const history = await db.listAiMessages(uid, 20);
      const msgs: ChatMessage[] = [
        ...history
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", text: m.content })),
        { role: "user", text: userText },
      ];
      reply = await askAIChat(env.ANTHROPIC_API_KEY, msgs, model);
    }
    // Сохраняем в кеш (даже если это сообщение об ошибке — чтобы диалог был честным)
    await db.addAiMessage(uid, "user", userText);
    await db.addAiMessage(uid, "assistant", reply);
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

    const evAll = await db.listEvents(uid, startOfLocalDayIso(tz));
    const evDay = (e: { starts_at: string }) => Math.floor((new Date(e.starts_at).getTime() + tz * 3600_000) / 86400_000);
    const mapEv = (e: { id: number; title: string; starts_at: string; location: string }) => ({
      id: e.id, title: e.title, starts_at: e.starts_at, location: e.location,
    });
    const todayEvents = evAll.filter((e) => evDay(e) === todayLocalDay).slice(0, 5).map(mapEv);
    const upcomingEvents = evAll.filter((e) => evDay(e) > todayLocalDay).slice(0, 5).map(mapEv);

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

    // Статистика по выполненным задачам
    const done = await db.listTasks({ statuses: [TASK_DONE], assigneeId: assignee, orderByDone: true });
    const weekAgo = nowMs - 7 * 86400_000;
    const stats = {
      doneToday: done.filter((t) => t.done_at && Math.floor((new Date(t.done_at).getTime() + tz * 3600_000) / 86400_000) === todayLocalDay).length,
      doneWeek: done.filter((t) => t.done_at && new Date(t.done_at).getTime() >= weekAgo).length,
      doneTotal: done.length,
    };

    return json({
      tasks: agendaTasks,
      events: todayEvents,
      upcomingEvents,
      birthdays: upcomingBirthdays,
      counts: {
        personal: active.filter((t) => t.scope === SCOPE_PERSONAL).length,
        work: active.filter((t) => t.scope === SCOPE_WORK).length,
      },
      stats,
    });
  }

  // GET /api/events
  if (path === "/api/events" && request.method === "GET") {
    const events = await db.listEvents(uid, startOfLocalDayIso(tz));
    return json({ events: events.map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at, location: e.location, notes: e.notes })) });
  }

  // POST /api/events
  if (path === "/api/events" && request.method === "POST") {
    const body = (await request.json()) as { title?: string; at?: string; location?: string; notes?: string; telemost?: boolean };
    const title = (body.title ?? "").trim();
    if (!title) return json({ error: "empty_title" }, 400);
    const startsAt = body.at ? localInputToUtc(body.at, tz) : null;
    if (!startsAt) return json({ error: "bad_date" }, 400);
    let location = body.location ?? "";
    let link: string | null = null;
    if (body.telemost) {
      try {
        link = await telemostCreate(env, db);
        if (!location) location = link;
      } catch (e) {
        return json({ error: "telemost_failed", message: (e as Error).message }, 502);
      }
    }
    const notes = link ? `${body.notes ? body.notes + "\n" : ""}🎥 Телемост: ${link}` : body.notes ?? "";
    const id = await db.addEvent({ userId: uid, title, startsAt, location, notes });
    return json({ ok: true, id, link });
  }

  // POST /api/events/{id} — редактирование встречи
  const evEdit = path.match(/^\/api\/events\/(\d+)$/);
  if (evEdit && request.method === "POST") {
    const body = (await request.json()) as { title?: string; at?: string; location?: string; notes?: string };
    const fields: { title?: string; startsAt?: string; location?: string; notes?: string } = {};
    if (body.title !== undefined) {
      const t = body.title.trim();
      if (!t) return json({ error: "empty_title" }, 400);
      fields.title = t;
    }
    if (body.at !== undefined) {
      const s = localInputToUtc(body.at, tz);
      if (!s) return json({ error: "bad_date" }, 400);
      fields.startsAt = s;
    }
    if (body.location !== undefined) fields.location = body.location;
    if (body.notes !== undefined) fields.notes = body.notes;
    await db.updateEvent(parseInt(evEdit[1], 10), uid, fields);
    return json({ ok: true });
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
    return json({ contacts: contacts.map((c) => ({ id: c.id, name: c.name, birthday: c.birthday, phone: c.phone, notes: c.notes, tags: c.tags })) });
  }

  // POST /api/contacts
  if (path === "/api/contacts" && request.method === "POST") {
    const body = (await request.json()) as { name?: string; birthday?: string; phone?: string; notes?: string; tags?: string };
    const name = (body.name ?? "").trim();
    if (!name) return json({ error: "empty_name" }, 400);
    let birthday = (body.birthday ?? "").trim() || null; // ожидаем MM-DD или YYYY-MM-DD
    if (birthday && !/^\d{2}-\d{2}$/.test(birthday) && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) birthday = null;
    const id = await db.addContact({ userId: uid, name, birthday, phone: body.phone ?? "", notes: body.notes ?? "", tags: (body.tags ?? "").trim() });
    return json({ ok: true, id });
  }

  // POST /api/contacts/{id} — редактировать контакт
  const ctEdit = path.match(/^\/api\/contacts\/(\d+)$/);
  if (ctEdit && request.method === "POST") {
    const body = (await request.json()) as { name?: string; birthday?: string; phone?: string; tags?: string };
    const fields: { name?: string; birthday?: string | null; phone?: string; tags?: string } = {};
    if (body.name !== undefined) {
      const n = body.name.trim();
      if (!n) return json({ error: "empty_name" }, 400);
      fields.name = n;
    }
    if (body.birthday !== undefined) {
      let bd = body.birthday.trim() || null;
      if (bd && !/^\d{2}-\d{2}$/.test(bd) && !/^\d{4}-\d{2}-\d{2}$/.test(bd)) bd = null;
      fields.birthday = bd;
    }
    if (body.phone !== undefined) fields.phone = body.phone;
    if (body.tags !== undefined) fields.tags = body.tags.trim();
    await db.updateContact(parseInt(ctEdit[1], 10), uid, fields);
    return json({ ok: true });
  }

  // DELETE /api/contacts/{id}
  const cDel = path.match(/^\/api\/contacts\/(\d+)$/);
  if (cDel && request.method === "DELETE") {
    await db.deleteContact(parseInt(cDel[1], 10), uid);
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}
