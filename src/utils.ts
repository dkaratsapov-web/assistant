import { PLATFORMS } from "./types";

/** Текущее время с учётом смещения часового пояса (в мс, «локальные» эпох-мс). */
function nowLocal(tzOffset: number): Date {
  const now = new Date();
  return new Date(now.getTime() + tzOffset * 3600_000);
}

/** Преобразует «локальную» дату (в TZ) обратно в ISO UTC-строку. */
function localToUtcIso(localMs: number, tzOffset: number): string {
  return new Date(localMs - tzOffset * 3600_000).toISOString();
}

const WEEKDAY_NAMES = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** Строка текущих локальных даты/времени для контекста модели, напр. «2026-07-31 16:40, четверг». */
export function nowContext(tzOffset: number): string {
  const d = nowLocal(tzOffset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}, ${WEEKDAY_NAMES[d.getUTCDay()]}`;
}

/**
 * Резолвер даты: сперва пробует абсолютный формат «ГГГГ-ММ-ДД[ ЧЧ:ММ]» (его отдаёт модель),
 * иначе — свободный текст через parseDue. Возвращает ISO UTC или null.
 */
export function resolveWhen(text: string, tzOffset: number, defaultHour = 10): string | null {
  const s = (text || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const h = m[4] != null ? Math.min(+m[4], 23) : defaultHour;
    const mi = m[5] != null ? Math.min(+m[5], 59) : 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, 0, 0) - tzOffset * 3600_000).toISOString();
  }
  return parseDue(s, tzOffset);
}

/**
 * Разбор срока из свободного текста → ISO UTC или null. Понимает:
 * сегодня/завтра/послезавтра; «через N минут/часов/дней/недель», «через час/полчаса»;
 * «в 13 часов», «в 8 вечера», «в обед», «утром/днём/вечером/ночью», «полдень/полночь»;
 * ЧЧ:ММ; «15 марта»; ДД.ММ[.ГГГГ]; дни недели; только время → ближайшее.
 */
export function parseDue(text: string, tzOffset: number): string | null {
  let raw = (text || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
  if (!raw || ["-", "нет", "без", "без дедлайна", "skip", "пропустить", "не надо", "потом"].includes(raw)) {
    return null;
  }

  const local = nowLocal(tzOffset);
  const addDays = (n: number) => new Date(local.getTime() + n * 86400_000);
  const build = (base: Date, h: number, mi: number): string => {
    const dd = new Date(base);
    dd.setUTCHours(h, mi, 0, 0);
    return localToUtcIso(dd.getTime(), tzOffset);
  };

  // 1) «через …»
  const rel = raw.match(/через\s+(полчаса|час|\d+)\s*(минут\w*|мин|час\w*|ч|дн\w*|день|недел\w*)?/);
  if (rel) {
    const w = rel[1];
    const unit = rel[2] || "";
    let ms: number;
    if (w === "полчаса") ms = 30 * 60_000;
    else {
      const n = w === "час" ? 1 : parseInt(w, 10);
      if (/^мин/.test(unit)) ms = n * 60_000;
      else if (/недел/.test(unit)) ms = n * 7 * 86400_000;
      else if (/дн|день/.test(unit)) ms = n * 86400_000;
      else ms = n * 3600_000; // час/ч/по умолчанию — часы
    }
    const dd = new Date(local.getTime() + ms);
    dd.setUTCSeconds(0, 0);
    return localToUtcIso(dd.getTime(), tzOffset);
  }

  // 2) явное время ЧЧ:ММ / ЧЧ.ММ
  let hour: number | null = null;
  let minute = 0;
  let mt = raw.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (mt) {
    hour = Math.min(+mt[1], 23);
    minute = Math.min(+mt[2], 59);
    raw = raw.replace(mt[0], " ");
  }
  if (hour === null && /полдень/.test(raw)) { hour = 12; raw = raw.replace(/полдень/, " "); }
  if (hour === null && /полноч/.test(raw)) { hour = 0; raw = raw.replace(/полноч\w*/, " "); }

  // 3) дата «15 марта»
  const months: Record<string, number> = {
    января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
    январь: 0, февраль: 1, март: 2, апрель: 3, май: 4, июнь: 5, июль: 6, август: 7, сентябрь: 8, октябрь: 9, ноябрь: 10, декабрь: 11,
  };
  let baseDate: Date | null = null;
  let baseNoYear = false;
  const mn = raw.match(/\b(\d{1,2})\s+([а-я]+)\b/);
  if (mn && months[mn[2]] !== undefined) {
    baseDate = new Date(Date.UTC(local.getUTCFullYear(), months[mn[2]], parseInt(mn[1], 10)));
    baseNoYear = true;
    raw = raw.replace(mn[0], " ");
  }

  // 4) ДД.ММ[.ГГГГ]
  if (!baseDate) {
    const dm = raw.match(/\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b/);
    if (dm) {
      const day = +dm[1];
      const month = +dm[2] - 1;
      let year = dm[3] ? +dm[3] : local.getUTCFullYear();
      if (year < 100) year += 2000;
      baseDate = new Date(Date.UTC(year, month, day));
      baseNoYear = !dm[3];
      raw = raw.replace(dm[0], " ");
    }
  }

  // 5) время словами: «в 15 часов», «в 8 вечера», «в 15», «15 ч»
  if (hour === null) {
    const bh =
      raw.match(/\b(?:в|во|к|на)\s+(\d{1,2})\s*(?:час\w*|ч)?\s*(утра|дня|вечера|ночи)?\b/) ||
      raw.match(/\b(\d{1,2})\s*(?:час\w*|ч)\s*(утра|дня|вечера|ночи)?\b/);
    if (bh) {
      let h = parseInt(bh[1], 10);
      const suf = bh[2];
      if (suf === "вечера" && h < 12) h += 12;
      else if (suf === "дня" && h < 12) h += 12;
      else if (suf === "ночи" && h === 12) h = 0;
      else if (suf === "утра" && h === 12) h = 0;
      if (h <= 23) { hour = h; raw = raw.replace(bh[0], " "); }
    }
  }

  // 6) части суток словами
  if (hour === null) {
    const dayparts: Record<string, number> = { утром: 9, утра: 9, днем: 13, обед: 13, вечером: 19, вечера: 19, ночью: 23, ночи: 23 };
    for (const [w, h] of Object.entries(dayparts)) {
      if (new RegExp("\\b" + w + "\\b").test(raw)) { hour = h; raw = raw.replace(new RegExp("\\b" + w + "\\b"), " "); break; }
    }
  }

  const H = hour === null ? 10 : hour;

  // Абсолютная дата из «15 марта» / ДД.ММ
  if (baseDate) {
    const dd = new Date(baseDate);
    dd.setUTCHours(H, minute, 0, 0);
    if (baseNoYear && dd.getTime() < local.getTime()) dd.setUTCFullYear(dd.getUTCFullYear() + 1);
    return localToUtcIso(dd.getTime(), tzOffset);
  }

  raw = raw.trim();
  const has = (w: string) => new RegExp("(^|\\s)" + w + "(\\s|$)").test(raw);
  if (has("сегодня") || has("today")) return build(local, H, minute);
  if (has("завтра") || has("tomorrow")) return build(addDays(1), H, minute);
  if (has("послезавтра")) return build(addDays(2), H, minute);

  const weekdays: Record<string, number> = {
    пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0,
    понедельник: 1, вторник: 2, среда: 3, среду: 3, четверг: 4, пятница: 5, пятницу: 5, суббота: 6, субботу: 6, воскресенье: 0,
  };
  for (const [w, target] of Object.entries(weekdays)) {
    if (has(w)) {
      let delta = (target - local.getUTCDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return build(addDays(delta), H, minute);
    }
  }

  // Только время без дня → сегодня, а если уже прошло — завтра
  if (hour !== null) {
    const todayAt = build(local, H, minute);
    return new Date(todayAt).getTime() < Date.now() ? build(addDays(1), H, minute) : todayAt;
  }

  return null;
}

/** Человекочитаемый дедлайн с пометкой просрочки/сегодня. */
export function formatDue(dueIso: string | null, tzOffset: number): string {
  if (!dueIso) return "";
  const due = new Date(dueIso).getTime();
  const nowMs = Date.now();
  const dueLocal = new Date(due + tzOffset * 3600_000);
  const nowLocalMs = new Date(nowMs + tzOffset * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${pad(dueLocal.getUTCDate())}.${pad(dueLocal.getUTCMonth() + 1)} ${pad(dueLocal.getUTCHours())}:${pad(dueLocal.getUTCMinutes())}`;
  const dayDiff = Math.floor(dueLocal.getTime() / 86400_000) - Math.floor(nowLocalMs.getTime() / 86400_000);
  if (due < nowMs) return `⚠️ просрочено (${dateStr})`;
  if (dayDiff === 0) return `🔥 сегодня ${pad(dueLocal.getUTCHours())}:${pad(dueLocal.getUTCMinutes())}`;
  if (dayDiff === 1) return `завтра ${pad(dueLocal.getUTCHours())}:${pad(dueLocal.getUTCMinutes())}`;
  return dateStr;
}

export function platformsToText(platforms: string): string {
  if (!platforms) return "—";
  return platforms
    .split(",")
    .filter(Boolean)
    .map((k) => PLATFORMS[k] ?? k)
    .join(", ");
}

export function extractTags(text: string): string {
  const tags = [...text.matchAll(/#(\w+)/g)].map((m) => m[1]);
  return tags.join(",");
}

export function escapeHtml(s: string): string {
  return (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

export function tzOffsetOf(env: { TZ_OFFSET?: string }): number {
  return parseInt(env.TZ_OFFSET ?? "3", 10);
}

/** "YYYY-MM-DDTHH:MM" из datetime-local (локальное время) → ISO UTC. */
export function localInputToUtc(value: string, tzOffset: number): string | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const asUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, 0, 0);
  return new Date(asUtcMs - tzOffset * 3600_000).toISOString();
}

/** ISO-строка начала сегодняшнего локального дня (00:00 по TZ) в UTC. */
export function startOfLocalDayIso(tzOffset: number): string {
  const tzMs = tzOffset * 3600_000;
  const localDayStart = Math.floor((Date.now() + tzMs) / 86400_000) * 86400_000 - tzMs;
  return new Date(localDayStart).toISOString();
}

/** ISO начала локального дня со сдвигом на dayOffset дней (0 — сегодня). */
export function startOfLocalDayOffsetIso(tzOffset: number, dayOffset: number): string {
  return new Date(new Date(startOfLocalDayIso(tzOffset)).getTime() + dayOffset * 86400_000).toISOString();
}

/** Разбирает объём воды из текста. Стакан = 250 мл. По умолчанию 250. */
export function parseWaterMl(text: string): number {
  const t = text.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/(\d+[.,]?\d*)\s*(?:л|литр)/))) return Math.round(parseFloat(m[1].replace(",", ".")) * 1000);
  if ((m = t.match(/(\d+)\s*мл/))) return parseInt(m[1], 10);
  if (/(пол\s*стакан|полстакан|половин)/.test(t)) return 125;
  if ((m = t.match(/(\d+)\s*(?:стакан|чашк|кружк|бокал|бутыл)/))) return parseInt(m[1], 10) * 250;
  if (/(бутыл)/.test(t)) return 500;
  return 250;
}

/** Если текст — про питьё воды, возвращает объём в мл, иначе null. */
export function matchWaterMl(text: string): number | null {
  const t = text.toLowerCase();
  const drink = /(вып(и|ь)|попил|попью|выпью|дринк)/.test(t);
  const waterNoun = /(вод[аыуёе]|стакан|\bмл\b|\d+\s*мл|литр|бутыл)/.test(t);
  if (drink && waterNoun) return parseWaterMl(t);
  if (/^\+?\s*(вода|воды|стакан)\b/.test(t)) return parseWaterMl(t);
  return null;
}

/** Дата/время события человекочитаемо (для чата/дайджеста). */
export function formatEventTime(iso: string, tzOffset: number): string {
  const local = new Date(new Date(iso).getTime() + tzOffset * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}
