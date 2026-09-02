import { aiConfig, askAIChat, ChatMessage, estimateNutrition, estimateBurn } from "./ai";
import { DB } from "./db";
import { tryPerformCommand } from "./intent";
import { telemostConnected, telemostCreate, telemostAuthUrl, telemostExchangeCode, telemostState, metrikaStats } from "./telemost";
import { transcribeVoice } from "./speech";
import { validateMaxInitData } from "./max/auth";
import { CHANNEL_MAX, maxUid } from "./max/ids";
import { MaxClient } from "./max/client";
import { buildNutritionSummary } from "./reports";
import {
  Env,
  NotifSettings,
  ROLE_CLIENT,
  ROLE_MEMBER,
  Profile,
  EMPTY_PROFILE,
  ROLE_OWNER,
  ROLE_PENDING,
  SCOPE_PERSONAL,
  SCOPE_WORK,
  TASK_DONE,
  TASK_FAILED,
  TASK_IN_PROGRESS,
  TASK_OPEN,
} from "./types";
import { localInputToUtc, mealByHour, mealFromText, parseDue, startOfLocalDayIso, startOfLocalDayOffsetIso, tzOffsetOf } from "./utils";

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

/**
 * Рекомендуемая суточная калорийность и БЖУ по профилю (Миффлин–Сан Жеор).
 * Возвращает null, если данных недостаточно (нет веса/роста/возраста/пола).
 */
function suggestKcal(p: Profile, weightKg: number | null): { kcal: number; protein: number; fat: number; carbs: number } | null {
  const w = weightKg ?? p.target_weight;
  const age = p.birth_year > 1900 ? new Date().getUTCFullYear() - p.birth_year : 0;
  if (!w || !p.height_cm || !age || (p.sex !== "m" && p.sex !== "f")) return null;
  const bmr = 10 * w + 6.25 * p.height_cm - 5 * age + (p.sex === "m" ? 5 : -161);
  const factor = p.activity === "high" ? 1.725 : p.activity === "medium" ? 1.45 : 1.2;
  let kcal = bmr * factor;
  if (p.goal === "lose") kcal *= 0.85;
  else if (p.goal === "gain") kcal *= 1.1;
  kcal = Math.round(kcal / 10) * 10;
  const protein = Math.round((kcal * 0.3) / 4);
  const fat = Math.round((kcal * 0.3) / 9);
  const carbs = Math.round((kcal * 0.4) / 4);
  return { kcal, protein, fat, carbs };
}

/** Обрабатывает /api/* с проверкой доступа. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const db = new DB(env.DB);
  const url = new URL(request.url);
  const path = url.pathname;
  const tz = tzOffsetOf(env);
  const ai = aiConfig(env);

  // ---------- Публичные эндпоинты входа (до проверки авторизации) ----------

  // POST /api/auth/max {initData} — вход внутри мини-приложения MAX по подписи
  if (path === "/api/auth/max" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { initData?: string };
    const mu = await validateMaxInitData(body.initData ?? "", env.MAX_BOT_TOKEN ?? "");
    if (!mu) return json({ error: "bad_signature" }, 401);
    const muid = maxUid(mu.id);
    const mUser = await db.ensureChannelUser(muid, CHANNEL_MAX, mu.id, mu.username ?? null, mu.name ?? null);
    if (mUser.role === ROLE_PENDING) return json({ error: "no_access" }, 403);
    return json({ token: await db.webSessionFor(muid), role: mUser.role });
  }

  // POST /api/auth/code {code} — вход по одноразовому коду из чата с ботом
  if (path === "/api/auth/code" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { code?: string };
    const codeUid = await db.redeemLoginCode(body.code ?? "");
    if (!codeUid) return json({ error: "bad_code" }, 400);
    const codeUser = await db.getUser(codeUid);
    if (!codeUser || codeUser.role === ROLE_PENDING) return json({ error: "no_access" }, 403);
    return json({ token: await db.webSessionFor(codeUid), role: codeUser.role });
  }

  // Два способа входа: подпись Telegram initData либо токен сессии, выданный ботом
  // в другом канале (MAX) — там подписи Telegram нет.
  const tgUser = await validateInitData(request.headers.get("X-Telegram-Init-Data") ?? "", env.BOT_TOKEN);
  let authUid: number | null = null;
  if (tgUser) {
    if (tgUser.id === parseInt(env.OWNER_ID, 10)) await db.ensureOwner(tgUser.id);
    authUid = tgUser.id;
  } else {
    authUid = await db.webSessionUid(request.headers.get("X-Max-Session") ?? "");
  }
  if (!authUid) return json({ error: "unauthorized" }, 401);

  const user = await db.getUser(authUid);
  if (!user || user.role === ROLE_PENDING) return json({ error: "no_access" }, 403);

  const isOwner = user.role === ROLE_OWNER;
  const uid = user.user_id;

  // GET /api/me
  if (path === "/api/me" && request.method === "GET") {
    return json({ user_id: uid, role: user.role, channel: user.channel ?? "tg", telemost: await telemostConnected(db), voice: !!(env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID) });
  }

  // ---------- Админка владельца ----------
  // Здесь только управление доступами: список аккаунтов, роли, приглашения.
  // Содержимое чужих аккаунтов (задачи, здоровье, заметки) сюда не попадает —
  // личные пространства остаются закрытыми даже для владельца.
  if (path.startsWith("/api/admin/")) {
    if (!isOwner) return json({ error: "forbidden" }, 403);

    if (path === "/api/admin/users" && request.method === "GET") {
      const users = await db.listUsers();
      return json({
        users: users.map((u) => ({
          user_id: u.user_id,
          channel: u.channel ?? "tg",
          ext_id: u.ext_id ?? null,
          name: u.full_name,
          username: u.username,
          role: u.role,
          created_at: u.created_at,
          is_me: u.user_id === uid,
        })),
      });
    }

    const roleMatch = path.match(/^\/api\/admin\/users\/(\d+)\/role$/);
    if (roleMatch && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { role?: string };
      const role = body.role ?? "";
      if (![ROLE_MEMBER, ROLE_CLIENT].includes(role)) return json({ error: "bad_role" }, 400);
      const target = parseInt(roleMatch[1], 10);
      if (target === uid) return json({ error: "self" }, 400);
      await db.setRole(target, role);
      return json({ ok: true });
    }

    const userDel = path.match(/^\/api\/admin\/users\/(\d+)$/);
    if (userDel && request.method === "DELETE") {
      const target = parseInt(userDel[1], 10);
      if (target === uid) return json({ error: "self" }, 400);
      await db.deleteUser(target);
      return json({ ok: true });
    }

    // Состояние канала MAX — без секретов: владелец уже подтверждён подписью Mini App
    if (path === "/api/admin/max-status" && request.method === "GET") {
      const origin = url.origin;
      const out: Record<string, unknown> = {
        webhookUrl: `${origin}/max/webhook`,
        hasBotToken: !!env.MAX_BOT_TOKEN,
        hasWebhookSecret: !!env.MAX_WEBHOOK_SECRET,
        maxOwnerId: env.MAX_OWNER_ID || (await db.getSetting("max_owner_id")) || null,
        hasAi: !!(env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID),
        initAt: await db.getSetting("max_init_at"),
        lastUpdateAt: await db.getSetting("max_last_update_at"),
        lastUpdateType: await db.getSetting("max_last_update_type"),
        lastUpdateFrom: await db.getSetting("max_last_update_from"),
        lastRejectAt: await db.getSetting("max_last_reject_at"),
      };
      if (env.MAX_BOT_TOKEN) {
        const mc = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
        out.bot = await mc.getMe().catch((e) => ({ error: (e as Error).message }));
        out.subscriptions = await mc.getSubscriptions().catch((e) => ({ error: (e as Error).message }));
      }
      return json(out);
    }

    // Переподписать webhook MAX одной кнопкой из админки
    if (path === "/api/admin/max-subscribe" && request.method === "POST") {
      if (!env.MAX_BOT_TOKEN) return json({ error: "no_bot_token" }, 400);
      if (!env.MAX_WEBHOOK_SECRET) return json({ error: "no_webhook_secret" }, 400);
      const target = `${url.origin}/max/webhook`;
      const mc = new MaxClient(env.MAX_BOT_TOKEN, env.MAX_API_URL);
      try {
        await mc.unsubscribe(target).catch(() => {});
        await mc.subscribe(target, env.MAX_WEBHOOK_SECRET, ["message_created", "message_callback", "bot_started"]);
        await db.setSetting("max_init_at", new Date().toISOString());
        const subs = await mc.getSubscriptions().catch(() => null);
        return json({ ok: true, url: target, subscriptions: subs });
      } catch (e) {
        return json({ error: "subscribe_failed", message: (e as Error).message }, 502);
      }
    }

    // Свой аккаунт в MAX: владелец указывает его id прямо в админке,
    // чтобы не лезть в переменные окружения ради MAX_OWNER_ID
    if (path === "/api/admin/max-owner" && request.method === "GET") {
      return json({ id: (await db.getSetting("max_owner_id")) || env.MAX_OWNER_ID || "" });
    }
    if (path === "/api/admin/max-owner" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { id?: number | string };
      const maxId = parseInt(String(body.id ?? ""), 10);
      if (!maxId) return json({ error: "bad_id" }, 400);
      await db.setSetting("max_owner_id", String(maxId));
      return json({ ok: true, id: maxId });
    }

    // Пригласить конкретный аккаунт: доступ откроется сразу, как он напишет боту
    if (path === "/api/admin/invite" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { channel?: string; id?: number | string; role?: string; note?: string };
      const extId = parseInt(String(body.id ?? ""), 10);
      if (!extId) return json({ error: "bad_id" }, 400);
      const role = body.role === ROLE_CLIENT ? ROLE_CLIENT : ROLE_MEMBER;
      const channel = body.channel === CHANNEL_MAX ? CHANNEL_MAX : "tg";
      const inviteUid = channel === CHANNEL_MAX ? maxUid(extId) : extId;
      const invited = await db.inviteChannelUser(inviteUid, channel, extId, role, (body.note ?? "").trim() || undefined);
      return json({ ok: true, user_id: invited.user_id, role: invited.role });
    }

    return json({ error: "not_found" }, 404);
  }

  // Клиентская база — рабочий инструмент владельца и команды.
  // Личным аккаунтам (роль client) она не видна.
  if ((path.startsWith("/api/clients") || path === "/api/reports/metrika") && user.role === ROLE_CLIENT) {
    return json({ error: "forbidden" }, 403);
  }

  // ---------- БАДы / фарма ----------
  if (path.startsWith("/api/supplements")) {
    const tzs = tzOffsetOf(env);
    const dStr = (off: number) => new Date(Date.parse(startOfLocalDayOffsetIso(tzs, off)) + tzs * 3600_000).toISOString().slice(0, 10);
    const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
    const activeOn = (c: { start_date: string; days: number }, d: string) => {
      if (c.start_date && d < c.start_date) return false;
      if (c.days && c.start_date && d >= addDays(c.start_date, c.days)) return false;
      return true;
    };

    // GET /api/supplements — курсы + чек-лист на сегодня + адхеренс за 7 дней
    if (path === "/api/supplements" && request.method === "GET") {
      const today = dStr(0);
      const list = await db.listSupplements(uid, true);
      const logs = await db.supLogs(uid, dStr(-6), today);
      const has = (sup: number, date: string, slot: string) => logs.some((l) => l.sup_id === sup && l.date === date && l.slot === slot);
      const items: { supId: number; name: string; dose: string; slot: string; taken: boolean }[] = [];
      for (const c of list) {
        if (!activeOn(c, today)) continue;
        for (const slot of JSON.parse(c.times || "[]") as string[]) items.push({ supId: c.id, name: c.name, dose: c.dose, slot, taken: has(c.id, today, slot) });
      }
      items.sort((a, b) => a.slot.localeCompare(b.slot));
      const adherence: { date: string; taken: number; total: number }[] = [];
      for (let o = -6; o <= 0; o++) {
        const d = dStr(o);
        let total = 0, taken = 0;
        for (const c of list) {
          if (!activeOn(c, d)) continue;
          const slots = JSON.parse(c.times || "[]") as string[];
          total += slots.length;
          taken += slots.filter((s) => has(c.id, d, s)).length;
        }
        adherence.push({ date: d, taken, total });
      }
      return json({ supplements: list.map((c) => ({ id: c.id, name: c.name, dose: c.dose, times: JSON.parse(c.times || "[]"), days: c.days, start_date: c.start_date, notes: c.notes })), today: { date: today, items }, adherence });
    }

    // POST /api/supplements — добавить курс
    if (path === "/api/supplements" && request.method === "POST") {
      const b = (await request.json()) as { name?: string; dose?: string; times?: string[]; days?: number; notes?: string };
      const name = (b.name ?? "").trim();
      if (!name) return json({ error: "empty_name" }, 400);
      const times = (Array.isArray(b.times) ? b.times : []).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).map((t) => t.padStart(5, "0"));
      const id = await db.addSupplement(uid, { name, dose: (b.dose ?? "").trim(), times, startDate: dStr(0), days: Math.max(0, Math.round(+(b.days ?? 0) || 0)), notes: (b.notes ?? "").trim() });
      return json({ ok: true, id });
    }

    // POST /api/supplements/check — отметить/снять приём
    if (path === "/api/supplements/check" && request.method === "POST") {
      const b = (await request.json()) as { supId?: number; slot?: string; date?: string };
      if (!b.supId || !b.slot) return json({ error: "bad_args" }, 400);
      const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : dStr(0);
      const taken = await db.toggleSupLog(uid, b.supId, date, b.slot);
      return json({ ok: true, taken });
    }

    // POST /api/supplements/{id} — изменить / пауза
    const supEdit = path.match(/^\/api\/supplements\/(\d+)$/);
    if (supEdit && request.method === "POST") {
      const b = (await request.json()) as { name?: string; dose?: string; times?: string[]; days?: number; notes?: string; active?: number };
      const fields: { name?: string; dose?: string; times?: string[]; days?: number; notes?: string; active?: number } = {};
      if (b.name !== undefined) fields.name = b.name.trim();
      if (b.dose !== undefined) fields.dose = b.dose;
      if (b.times !== undefined) fields.times = (Array.isArray(b.times) ? b.times : []).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).map((t) => t.padStart(5, "0"));
      if (b.days !== undefined) fields.days = Math.max(0, Math.round(+b.days || 0));
      if (b.notes !== undefined) fields.notes = b.notes;
      if (b.active !== undefined) fields.active = b.active ? 1 : 0;
      await db.updateSupplement(parseInt(supEdit[1], 10), uid, fields);
      return json({ ok: true });
    }

    // DELETE /api/supplements/{id}
    const supDel = path.match(/^\/api\/supplements\/(\d+)$/);
    if (supDel && request.method === "DELETE") {
      await db.deleteSupplement(parseInt(supDel[1], 10), uid);
      return json({ ok: true });
    }
  }

  // ---------- Настройки уведомлений ----------
  if (path === "/api/notifications" && request.method === "GET") {
    return json(await db.getNotif(uid));
  }
  if (path === "/api/notifications" && request.method === "POST") {
    const b = (await request.json()) as Partial<NotifSettings>;
    const cur = await db.getNotif(uid);
    const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    const next: NotifSettings = {
      morning: { on: !!(b.morning?.on ?? cur.morning.on), hour: clamp(b.morning?.hour, 0, 23, cur.morning.hour) },
      tasks: { on: !!(b.tasks?.on ?? cur.tasks.on) },
      events: { on: !!(b.events?.on ?? cur.events.on), lead: clamp(b.events?.lead, 0, 1440, cur.events.lead) },
      birthdays: { on: !!(b.birthdays?.on ?? cur.birthdays.on) },
      water: {
        on: !!(b.water?.on ?? cur.water.on),
        everyHours: clamp(b.water?.everyHours, 1, 12, cur.water.everyHours),
        from: clamp(b.water?.from, 0, 23, cur.water.from),
        to: clamp(b.water?.to, 0, 23, cur.water.to),
      },
      meals: {
        on: !!(b.meals?.on ?? cur.meals.on),
        breakfast: clamp(b.meals?.breakfast, 0, 23, cur.meals.breakfast),
        lunch: clamp(b.meals?.lunch, 0, 23, cur.meals.lunch),
        dinner: clamp(b.meals?.dinner, 0, 23, cur.meals.dinner),
      },
    };
    await db.setNotif(uid, next);
    return json({ ok: true, settings: next });
  }

  // ---------- Здоровье: питание и вода ----------
  if (path === "/api/profile" && request.method === "GET") {
    const profile = await db.getProfile(uid);
    const weights = await db.listWeights(uid, 1);
    const weight = weights[0]?.kg ?? null;
    return json({ profile, weight, suggested: suggestKcal(profile, weight) });
  }

  if (path === "/api/profile" && request.method === "POST") {
    const body = (await request.json()) as Partial<Profile>;
    const s = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const num = (v: unknown, min: number, max: number) => {
      const n = Math.round(+(v as number) || 0);
      return n >= min && n <= max ? n : 0;
    };
    const profile: Profile = {
      ...EMPTY_PROFILE,
      name: s(body.name, 80),
      sex: body.sex === "m" || body.sex === "f" ? body.sex : "",
      birth_year: num(body.birth_year, 1900, new Date().getUTCFullYear()),
      height_cm: num(body.height_cm, 50, 260),
      activity: ["low", "medium", "high"].includes(body.activity as string) ? (body.activity as string) : "",
      goal: ["lose", "keep", "gain"].includes(body.goal as string) ? (body.goal as string) : "",
      target_weight: num(body.target_weight, 0, 500),
      diet: s(body.diet, 200),
      allergies: s(body.allergies, 300),
      dislikes: s(body.dislikes, 300),
      likes: s(body.likes, 300),
      conditions: s(body.conditions, 300),
      about: s(body.about, 800),
    };
    await db.setProfile(uid, profile);
    const weights = await db.listWeights(uid, 1);
    return json({ ok: true, suggested: suggestKcal(profile, weights[0]?.kg ?? null) });
  }

  if (path === "/api/health" && request.method === "GET") {
    const tzh = tzOffsetOf(env);
    const u = new URL(request.url);
    const dateStr = u.searchParams.get("date"); // YYYY-MM-DD (локальная дата) или пусто = сегодня
    let start: string, end: string;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const startMs = Date.parse(`${dateStr}T00:00:00Z`) - tzh * 3600_000;
      start = new Date(startMs).toISOString();
      end = new Date(startMs + 86400_000).toISOString();
    } else {
      start = startOfLocalDayIso(tzh);
      end = startOfLocalDayOffsetIso(tzh, 1);
    }
    const entries = await db.listFood(uid, start, end);
    const kcal = entries.reduce((s, e) => s + e.kcal, 0);
    const protein = entries.reduce((s, e) => s + e.protein, 0);
    const fat = entries.reduce((s, e) => s + e.fat, 0);
    const carbs = entries.reduce((s, e) => s + e.carbs, 0);
    const water = await db.waterTotal(uid, start, end);
    const kcalGoal = parseInt((await db.getSetting(`hkcal:${uid}`)) ?? "", 10) || 2000;
    const waterGoal = parseInt((await db.getSetting(`hwater:${uid}`)) ?? "", 10) || 2000;
    const pGoal = parseInt((await db.getSetting(`hprot:${uid}`)) ?? "", 10) || Math.round((kcalGoal * 0.3) / 4);
    const fGoal = parseInt((await db.getSetting(`hfat:${uid}`)) ?? "", 10) || Math.round((kcalGoal * 0.3) / 9);
    const cGoal = parseInt((await db.getSetting(`hcarb:${uid}`)) ?? "", 10) || Math.round((kcalGoal * 0.4) / 4);
    const notes = await db.listHealthNotes(uid, start, end);
    const weights = await db.listWeights(uid, 14);
    const activity = await db.listActivity(uid, start, end);
    const burned = activity.reduce((s, a) => s + a.kcal, 0);
    const wb = await db.getWellbeing(uid, dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : new Date(Date.parse(start) + tzh * 3600_000).toISOString().slice(0, 10));

    // Недельная сводка (последние 7 локальных дней)
    const wkStart = startOfLocalDayOffsetIso(tzh, -6);
    const wkFood = await db.listFood(uid, wkStart, end);
    const wkWater = await db.listWater(uid, wkStart, end);
    const dayOf = (ts: string) => Math.floor((new Date(ts).getTime() + tzh * 3600_000) / 86400_000);
    const kcalByDay: Record<number, number> = {};
    wkFood.forEach((e) => { kcalByDay[dayOf(e.ts)] = (kcalByDay[dayOf(e.ts)] || 0) + e.kcal; });
    const waterByDay: Record<number, number> = {};
    wkWater.forEach((e) => { waterByDay[dayOf(e.ts)] = (waterByDay[dayOf(e.ts)] || 0) + e.ml; });
    const avgKcal = Math.round(Object.values(kcalByDay).reduce((s, v) => s + v, 0) / 7);
    const avgWater = Math.round(Object.values(waterByDay).reduce((s, v) => s + v, 0) / 7);
    const daysOnWater = Object.values(waterByDay).filter((v) => v >= waterGoal).length;
    const weightDelta = weights.length > 1 ? Math.round((weights[0].kg - weights[weights.length - 1].kg) * 10) / 10 : null;

    // Стрик — сколько дней подряд (заканчивая сегодня) ведётся дневник еды
    const streakFood = await db.listFood(uid, startOfLocalDayOffsetIso(tzh, -29), end);
    const daysWithFood = new Set(streakFood.map((e) => dayOf(e.ts)));
    const todayNum = Math.floor((Date.now() + tzh * 3600_000) / 86400_000);
    let streak = 0;
    while (daysWithFood.has(todayNum - streak)) streak++;

    return json({
      kcal: { consumed: kcal, goal: kcalGoal, protein, fat, carbs, goalP: pGoal, goalF: fGoal, goalC: cGoal },
      water: { ml: water, goal: waterGoal },
      entries,
      notes,
      weight: { latest: weights[0]?.kg ?? null, history: weights },
      week: { avgKcal, avgWater, daysOnWater, weightDelta },
      streak,
      activity: { entries: activity, burned },
      balance: kcal - burned,
      wellbeing: { sleep: wb?.sleep ?? null, mood: wb?.mood ?? null },
    });
  }

  if (path === "/api/health/weight" && request.method === "POST") {
    const body = (await request.json()) as { kg?: number };
    const kg = Math.round((+(body.kg ?? 0) || 0) * 10) / 10;
    if (kg <= 0 || kg > 500) return json({ error: "bad_weight" }, 400);
    await db.addWeight(uid, kg);
    return json({ ok: true });
  }

  if (path === "/api/health/note" && request.method === "POST") {
    const body = (await request.json()) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return json({ error: "empty" }, 400);
    const id = await db.addHealthNote(uid, text.slice(0, 500));
    return json({ ok: true, id });
  }

  const hnoteDel = path.match(/^\/api\/health\/note\/(\d+)$/);
  if (hnoteDel && request.method === "DELETE") {
    await db.deleteHealthNote(parseInt(hnoteDel[1], 10), uid);
    return json({ ok: true });
  }

  if (path === "/api/health/advice" && request.method === "POST") {
    if (!ai) return json({ error: "ai_not_configured" }, 400);
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
    const weights = await db.listWeights(uid, 2);
    const prompt =
      `Данные питания за сегодня. Калории: ${kcal} из ${kcalGoal}. Белки ${protein} г, жиры ${fat} г, углеводы ${carbs} г. ` +
      `Вода: ${(water / 1000).toFixed(1)} из ${(waterGoal / 1000).toFixed(1)} л. ` +
      (weights[0] ? `Вес: ${weights[0].kg} кг. ` : "") +
      `Съедено: ${entries.map((e) => e.title).join(", ") || "ничего не записано"}. ` +
      `Дай короткую (3-5 пунктов) практичную рекомендацию по питанию и воде на остаток дня. Дружелюбно, по-русски, без воды и дисклеймеров.`;
    const ctx = await db.profileContext(uid);
    const msgs: ChatMessage[] = ctx ? [{ role: "system", text: ctx }, { role: "user", text: prompt }] : [{ role: "user", text: prompt }];
    try {
      const advice = await askAIChat(ai, msgs);
      return json({ advice });
    } catch (e) {
      return json({ error: "advice_failed", message: (e as Error).message }, 502);
    }
  }

  if (path === "/api/health/food" && request.method === "POST") {
    const body = (await request.json()) as { title?: string; kcal?: number; protein?: number; fat?: number; carbs?: number; meal?: string };
    const title = (body.title ?? "").trim();
    if (!title) return json({ error: "empty" }, 400);
    let n: { title: string; kcal: number; protein: number; fat: number; carbs: number } = { title, kcal: 0, protein: 0, fat: 0, carbs: 0 };
    if (body.kcal != null) {
      n = { title, kcal: Math.max(0, Math.round(+body.kcal || 0)), protein: Math.max(0, Math.round(+(body.protein ?? 0))), fat: Math.max(0, Math.round(+(body.fat ?? 0))), carbs: Math.max(0, Math.round(+(body.carbs ?? 0))) };
    } else {
      if (!ai) return json({ error: "ai_not_configured" }, 400);
      const est = await estimateNutrition(ai, title);
      if (!est) return json({ error: "estimate_failed" }, 502);
      n = est;
    }
    const validMeals = ["breakfast", "lunch", "dinner", "snack"];
    const localHour = new Date(Date.now() + tzOffsetOf(env) * 3600_000).getUTCHours();
    const meal = validMeals.includes(body.meal ?? "") ? (body.meal as string) : (mealFromText(title) || mealByHour(localHour));
    const id = await db.addFood(uid, { ...n, meal });
    return json({ ok: true, id, entry: { id, ...n, meal } });
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
    const body = (await request.json()) as { kcal?: number; water?: number; protein?: number; fat?: number; carbs?: number };
    const set = async (k: string, v: number | undefined) => { if (v != null) await db.setSetting(`${k}:${uid}`, String(Math.max(0, Math.round(+v || 0)))); };
    await set("hkcal", body.kcal);
    await set("hwater", body.water);
    await set("hprot", body.protein);
    await set("hfat", body.fat);
    await set("hcarb", body.carbs);
    return json({ ok: true });
  }

  if (path === "/api/health/activity" && request.method === "POST") {
    const b = (await request.json()) as { title?: string; kcal?: number; steps?: number; type?: string; duration?: number };
    let title = (b.title ?? "").trim();
    let kcal = 0;
    if (b.steps != null && +b.steps > 0) { const st = Math.round(+b.steps); title = title || `Шаги: ${st}`; kcal = Math.round(st * 0.04); }
    else if (b.kcal != null) { kcal = Math.max(0, Math.round(+b.kcal || 0)); }
    else if (title && ai) { kcal = (await estimateBurn(ai, title)) ?? 0; }
    if (!title) return json({ error: "empty" }, 400);
    const type = (b.type ?? "").slice(0, 30);
    const duration = Math.max(0, Math.round(+(b.duration ?? 0) || 0));
    const id = await db.addActivity(uid, title, kcal, type, duration);
    return json({ ok: true, id, kcal });
  }

  if (path === "/api/health/workout-goal" && request.method === "POST") {
    const b = (await request.json()) as { count?: number };
    await db.setSetting(`wgoal:${uid}`, String(Math.max(0, Math.min(21, Math.round(+(b.count ?? 0) || 0)))));
    return json({ ok: true });
  }
  if (path === "/api/health/workouts" && request.method === "GET") {
    const tzh = tzOffsetOf(env);
    const u = new URL(request.url);
    const days = Math.min(90, Math.max(1, parseInt(u.searchParams.get("days") ?? "30", 10)));
    const start = startOfLocalDayOffsetIso(tzh, -(days - 1)), end = startOfLocalDayOffsetIso(tzh, 1);
    const entries = await db.listActivity(uid, start, end);
    const total = entries.reduce((s, a) => s + a.kcal, 0);
    const week = await db.listActivity(uid, startOfLocalDayOffsetIso(tzh, -6), end);
    const weekTotal = week.reduce((s, a) => s + a.kcal, 0);
    const weekMin = week.reduce((s, a) => s + (a.duration_min || 0), 0);
    const weekGoal = parseInt((await db.getSetting(`wgoal:${uid}`)) ?? "", 10) || 3;
    const byType: Record<string, number> = {};
    entries.forEach((a) => { const t = a.type || "другое"; byType[t] = (byType[t] || 0) + 1; });
    const recent = await db.recentWorkouts(uid, startOfLocalDayOffsetIso(tzh, -60), 6);
    return json({
      entries: entries.reverse(), total, count: entries.length,
      weekTotal, weekCount: week.length, weekMin, weekGoal, byType,
      recent: recent.map((a) => ({ title: a.title, kcal: a.kcal, type: a.type, duration: a.duration_min })),
    });
  }
  const actDel = path.match(/^\/api\/health\/activity\/(\d+)$/);
  if (actDel && request.method === "DELETE") {
    await db.deleteActivity(parseInt(actDel[1], 10), uid);
    return json({ ok: true });
  }
  if (path === "/api/health/wellbeing" && request.method === "POST") {
    const b = (await request.json()) as { sleep?: number; mood?: string };
    const tzh = tzOffsetOf(env);
    const today = new Date(Date.parse(startOfLocalDayIso(tzh)) + tzh * 3600_000).toISOString().slice(0, 10);
    const fields: { sleep?: number; mood?: string } = {};
    if (b.sleep != null) fields.sleep = Math.max(0, Math.min(24, +b.sleep || 0));
    if (b.mood != null) fields.mood = String(b.mood).slice(0, 40);
    await db.setWellbeing(uid, today, fields);
    return json({ ok: true });
  }

  if (path === "/api/health/menu" && request.method === "POST") {
    if (!ai) return json({ error: "ai_not_configured" }, 400);
    const kcalGoal = parseInt((await db.getSetting(`hkcal:${uid}`)) ?? "", 10) || 2000;
    const pGoal = parseInt((await db.getSetting(`hprot:${uid}`)) ?? "", 10) || Math.round((kcalGoal * 0.3) / 4);
    const fGoal = parseInt((await db.getSetting(`hfat:${uid}`)) ?? "", 10) || Math.round((kcalGoal * 0.3) / 9);
    const cGoal = parseInt((await db.getSetting(`hcarb:${uid}`)) ?? "", 10) || Math.round((kcalGoal * 0.4) / 4);
    const prompt =
      `Составь меню на день под цель ${kcalGoal} ккал (белки ${pGoal} г, жиры ${fGoal} г, углеводы ${cGoal} г). ` +
      `Четыре приёма: завтрак, обед, ужин, перекус — для каждого укажи блюда и примерные калории, в конце итог по калориям. ` +
      `Простые доступные продукты, по-русски, компактно, без вступлений и дисклеймеров.`;
    const ctx = await db.profileContext(uid);
    const msgs: ChatMessage[] = ctx ? [{ role: "system", text: ctx }, { role: "user", text: prompt }] : [{ role: "user", text: prompt }];
    try {
      const menu = await askAIChat(ai, msgs);
      return json({ menu });
    } catch (e) {
      return json({ error: "menu_failed", message: (e as Error).message }, 502);
    }
  }

  if (path === "/api/health/summary" && request.method === "GET") {
    const u = new URL(request.url);
    const off = parseInt(u.searchParams.get("offset") ?? "-1", 10);
    const dayOffset = Number.isFinite(off) ? Math.min(0, Math.max(-31, off)) : -1;
    const text = await buildNutritionSummary(db, uid, tzOffsetOf(env), dayOffset);
    return json({ text });
  }

  if (path === "/api/health/recent" && request.method === "GET") {
    const tzh = tzOffsetOf(env);
    const recent = await db.recentFoods(uid, startOfLocalDayOffsetIso(tzh, -30), 8);
    return json({ recent: recent.map((e) => ({ title: e.title, kcal: e.kcal, protein: e.protein, fat: e.fat, carbs: e.carbs, meal: e.meal })) });
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
    return json({ url: telemostAuthUrl(env.TELEMOST_CLIENT_ID, undefined, await telemostState(env.WEBHOOK_SECRET)) });
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
      filter === "done" ? [TASK_DONE]
      : filter === "failed" ? [TASK_FAILED]
      : filter === "open" ? [TASK_OPEN]
      : filter === "in_progress" ? [TASK_IN_PROGRESS]
      : filter === "all" ? [TASK_OPEN, TASK_IN_PROGRESS, TASK_DONE, TASK_FAILED]
      : [TASK_OPEN, TASK_IN_PROGRESS];
    const tasks = await db.listTasks({ statuses, visibleTo: uid, scope, orderByDone: filter === "done" });
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
    if (![TASK_OPEN, TASK_IN_PROGRESS, TASK_DONE, TASK_FAILED].includes(body.status ?? "")) return json({ error: "bad_status" }, 400);
    const task = await db.getTask(parseInt(statusMatch[1], 10), uid);
    if (!task) return json({ error: "not_found" }, 404);
    await db.setTaskStatus(task.id, body.status!, uid);
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
    await db.updateTask(parseInt(editMatch[1], 10), fields, uid);
    return json({ ok: true });
  }

  // DELETE /api/tasks/{id}
  const delMatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (delMatch && request.method === "DELETE") {
    if (!(await db.deleteTask(parseInt(delMatch[1], 10), uid))) return json({ error: "not_found" }, 404);
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

  // GET /api/clients/{id} — полная карточка клиента
  const clGet = path.match(/^\/api\/clients\/(\d+)$/);
  if (clGet && request.method === "GET") {
    const id = parseInt(clGet[1], 10);
    const c = await db.getClient(id);
    if (!c) return json({ error: "not_found" }, 404);
    const tasks = await db.listTasks({ clientId: id, statuses: [TASK_OPEN, TASK_IN_PROGRESS, TASK_DONE, TASK_FAILED] });
    const events = await db.listEventsByClient(uid, id, 20);
    const counts = { open: 0, in_progress: 0, done: 0, failed: 0 } as Record<string, number>;
    tasks.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });
    return json({
      client: {
        id: c.id, name: c.name, platforms: c.platforms, status: c.status, budget: c.budget,
        pay_amount: c.pay_amount, pay_due: c.pay_due, metrika_counter: c.metrika_counter, direct_login: c.direct_login,
        notes: c.notes, created_at: c.created_at,
      },
      counts,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, due_at: t.due_at, done_at: t.done_at, priority: t.priority })),
      events: events.map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at, location: e.location })),
    });
  }

  // POST /api/clients/{id} — редактировать клиента
  const clEdit = path.match(/^\/api\/clients\/(\d+)$/);
  if (clEdit && request.method === "POST") {
    const body = (await request.json()) as { name?: string; platforms?: string; budget?: string; pay_amount?: string; pay_due?: string; metrika_counter?: string; direct_login?: string; notes?: string };
    const fields: { name?: string; platforms?: string; budget?: string; payAmount?: string; payDue?: string; metrikaCounter?: string; directLogin?: string; notes?: string } = {};
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
    if (body.notes !== undefined) fields.notes = body.notes;
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

  // POST /api/ai — диалог с ИИ (YandexGPT); история хранится на сервере
  if (path === "/api/ai" && request.method === "POST") {
    if (!ai) return json({ error: "ai_not_configured" }, 400);
    const body = (await request.json()) as { messages?: { role?: string; content?: string }[]; prompt?: string };
    let userText = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!userText && Array.isArray(body.messages)) {
      const last = [...body.messages].reverse().find((m) => m?.role === "user" && typeof m.content === "string");
      userText = (last?.content ?? "").trim();
    }
    if (!userText) return json({ error: "empty" }, 400);

    // 1) Команда (создать задачу/встречу/контакт) или обычный вопрос?
    let reply: string;
    const action = await tryPerformCommand(env, db, uid, userText, false);
    if (action) {
      reply = action;
    } else {
      // 2) Обычный диалог с историей
      const history = await db.listAiMessages(uid, 20);
      const ctx = await db.profileContext(uid);
      const msgs: ChatMessage[] = [
        ...(ctx ? [{ role: "system" as const, text: ctx }] : []),
        ...history
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", text: m.content })),
        { role: "user", text: userText },
      ];
      reply = await askAIChat(ai, msgs);
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
    const active = await db.listTasks({ statuses: [TASK_OPEN, TASK_IN_PROGRESS], visibleTo: uid });
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
    const clientsForEv = await db.listClients();
    const cName = (id: number | null) => (id ? clientsForEv.find((c) => c.id === id)?.name ?? null : null);
    const evDay = (e: { starts_at: string }) => Math.floor((new Date(e.starts_at).getTime() + tz * 3600_000) / 86400_000);
    const mapEv = (e: { id: number; title: string; starts_at: string; location: string; client_id: number | null }) => ({
      id: e.id, title: e.title, starts_at: e.starts_at, location: e.location, client: cName(e.client_id),
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
    const done = await db.listTasks({ statuses: [TASK_DONE], visibleTo: uid, orderByDone: true });
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
    const out = [];
    for (const e of events) {
      const client = e.client_id ? await db.getClient(e.client_id) : null;
      out.push({ id: e.id, title: e.title, starts_at: e.starts_at, location: e.location, notes: e.notes, client_id: e.client_id, client: client?.name ?? null });
    }
    return json({ events: out });
  }

  // POST /api/events
  if (path === "/api/events" && request.method === "POST") {
    const body = (await request.json()) as { title?: string; at?: string; location?: string; notes?: string; telemost?: boolean; client_id?: number | null };
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
    const id = await db.addEvent({ userId: uid, title, startsAt, location, notes, clientId: body.client_id ?? null });
    return json({ ok: true, id, link });
  }

  // POST /api/events/{id} — редактирование встречи
  const evEdit = path.match(/^\/api\/events\/(\d+)$/);
  if (evEdit && request.method === "POST") {
    const body = (await request.json()) as { title?: string; at?: string; location?: string; notes?: string; client_id?: number | null };
    const fields: { title?: string; startsAt?: string; location?: string; notes?: string; clientId?: number | null } = {};
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
    if (body.client_id !== undefined) fields.clientId = body.client_id;
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
