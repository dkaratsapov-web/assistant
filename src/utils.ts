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
/**
 * Границы слова для русского текста. Встроенные \b и \w в JavaScript считают буквами
 * только латиницу, поэтому шаблоны вида /\bвес\b/ на кириллице молча не срабатывают.
 * Здесь — класс «буква» с кириллицей и готовые края слова.
 */
const LETTER = "A-Za-zА-Яа-яЁё0-9_";
/** Начало слова: начало строки или любой не-буквенный символ. */
export const WB_START = `(?:^|[^${LETTER}])`;
/** Конец слова: дальше не должно идти буквы. */
export const WB_END = `(?![${LETTER}])`;
/** Регулярка со «словесными» краями, понимающими кириллицу. */
export function wordRe(body: string, flags = "i"): RegExp {
  return new RegExp(`${WB_START}(?:${body})${WB_END}`, flags);
}

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
  const rel = raw.match(/через\s+(полчаса|час|\d+)\s*(минут[а-яё]*|мин|час[а-яё]*|ч|дн[а-яё]*|день|недел[а-яё]*)?/);
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
  if (hour === null && /полноч/.test(raw)) { hour = 0; raw = raw.replace(/полноч[а-яё]*/, " "); }

  // 3) дата «15 марта»
  const months: Record<string, number> = {
    января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
    январь: 0, февраль: 1, март: 2, апрель: 3, май: 4, июнь: 5, июль: 6, август: 7, сентябрь: 8, октябрь: 9, ноябрь: 10, декабрь: 11,
  };
  let baseDate: Date | null = null;
  let baseNoYear = false;
  const mn = raw.match(new RegExp(`${WB_START}(\\d{1,2})\\s+([а-яё]+)${WB_END}`));
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
      raw.match(new RegExp(`${WB_START}(?:в|во|к|на)\\s+(\\d{1,2})\\s*(?:час[а-яё]*|ч)?\\s*(утра|дня|вечера|ночи)?${WB_END}`)) ||
      raw.match(new RegExp(`${WB_START}(\\d{1,2})\\s*(?:час[а-яё]*|ч)\\s*(утра|дня|вечера|ночи)?${WB_END}`));
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
      const re = wordRe(w, "");
      if (re.test(raw)) { hour = h; raw = raw.replace(re, " "); break; }
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

/** Тип приёма пищи из текста, иначе null. */
export function mealFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/завтрак/.test(t)) return "breakfast";
  if (/обед/.test(t)) return "lunch";
  if (/ужин/.test(t)) return "dinner";
  if (/перекус|снек|полдник/.test(t)) return "snack";
  return null;
}

/** Тип приёма пищи по часу (локальному). */
export function mealByHour(hour: number): string {
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

/** Если текст — про питьё воды, возвращает объём в мл, иначе null. */
export function matchWaterMl(text: string): number | null {
  const t = text.toLowerCase();
  const drink = /(вып(и|ь)|попил|попью|выпью|дринк)/.test(t);
  const waterNoun = /(вод[аыуёе]|стакан|\d+\s*мл|литр|бутыл)/.test(t) || wordRe("мл").test(t);
  if (drink && waterNoun) return parseWaterMl(t);
  if (/^\+?\s*(вода|воды|стакан)(?![а-яё])/.test(t)) return parseWaterMl(t);
  return null;
}

/** Дата/время события человекочитаемо (для чата/дайджеста). */
export function formatEventTime(iso: string, tzOffset: number): string {
  const local = new Date(new Date(iso).getTime() + tzOffset * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}


/* ---------- Повторяющиеся задачи ---------- */

/** Дни недели по-русски: понимаем «каждый вторник» и подписываем правило. */
const WEEKDAYS: [RegExp, number][] = [
  [/понедельник/i, 1], [/вторник/i, 2], [/сред[ауы]/i, 3], [/четверг/i, 4],
  [/пятниц/i, 5], [/суббот/i, 6], [/воскресень|воскресен/i, 7],
];
const WEEKDAY_RU = ["", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];

/**
 * Правило повтора из фразы: «каждый день», «по будням», «каждый вторник»,
 * «каждую неделю», «каждый месяц». Пустая строка — задача разовая.
 */
export function parseRepeat(text: string): string {
  const t = text.toLowerCase();
  if (/(по\s+будн|каждый\s+будний)/i.test(t)) return "weekdays";
  if (/кажд(ый|ую|ое)\s+(месяц|мес\b)/i.test(t) || /ежемесячно/i.test(t)) return "monthly";
  if (/ежедневно/i.test(t) || /кажд(ый|ые)\s+(день|дня)/i.test(t)) return "daily";
  for (const [re, n] of WEEKDAYS) {
    if (new RegExp(`кажд(ый|ую|ое)\\s+${re.source}`, "i").test(t)) return `w:${n}`;
  }
  if (/еженедельно/i.test(t) || /кажд(ую|ый)\s+недел/i.test(t)) return "weekly";
  return "";
}

/** Человеческая подпись правила — её видно на карточке задачи. */
export function repeatLabel(rule: string): string {
  if (rule === "daily") return "каждый день";
  if (rule === "weekdays") return "по будням";
  if (rule === "weekly") return "каждую неделю";
  if (rule === "monthly") return "каждый месяц";
  const m = rule.match(/^w:([1-7])$/);
  return m ? `каждый${m[1] === "3" ? "" : ""} ${WEEKDAY_RU[+m[1]]}`.replace("каждый среду", "каждую среду") : "";
}

/**
 * Следующий срок для повторяющейся задачи. Считаем в местном времени, чтобы
 * «каждый день в 10:00» не уползало на час при переводе в UTC.
 * Возвращает ISO или null, если правило пустое или незнакомое.
 */
export function nextDue(rule: string, fromIso: string, tz: number): string | null {
  if (!rule || !fromIso) return null;
  const base = new Date(fromIso);
  if (isNaN(base.getTime())) return null;
  const local = new Date(base.getTime() + tz * 3600_000);
  const add = (days: number) => new Date(local.getTime() + days * 86400_000);

  let next: Date | null = null;
  if (rule === "daily") next = add(1);
  else if (rule === "weekly") next = add(7);
  else if (rule === "weekdays") {
    const dow = local.getUTCDay();                 // 0 — воскресенье
    next = add(dow === 5 ? 3 : dow === 6 ? 2 : 1); // с пятницы прыгаем на понедельник
  } else if (rule === "monthly") {
    next = new Date(local.getTime());
    const day = next.getUTCDate();
    next.setUTCMonth(next.getUTCMonth() + 1);
    // 31 января + месяц: держим последний день месяца, а не уезжаем в март
    if (next.getUTCDate() !== day) next.setUTCDate(0);
  } else {
    const m = rule.match(/^w:([1-7])$/);
    if (!m) return null;
    const want = +m[1] % 7;                        // 7 (вс) → 0
    const dow = local.getUTCDay();
    let delta = (want - dow + 7) % 7;
    if (delta === 0) delta = 7;                    // тот же день — значит через неделю
    next = add(delta);
  }
  return new Date(next.getTime() - tz * 3600_000).toISOString();
}

/** Байты картинки в base64 — для мультимодальных запросов к модели. */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------- Поиск записи по словам человека ---------- */

/**
 * Служебные слова, которые человек говорит вокруг названия: «закрой ЗАДАЧУ ПРО отчёт».
 * Их надо выкинуть, иначе они перетянут совпадение на себя.
 */
const SKIP_WORDS = new Set([
  "задача", "задачу", "задачи", "задаче", "задачей", "дело", "дела", "делу", "встреча", "встречу", "встречи",
  "про", "по", "о", "об", "на", "в", "во", "с", "со", "у", "к", "и", "а", "же", "бы", "ли", "не",
  "это", "эту", "этот", "эта", "той", "ту", "тот", "та", "то", "мою", "мой", "моя", "мое", "моё", "мне",
  "все", "всю", "весь", "вся", "что", "чтобы", "как", "уже", "там", "вот", "ещё", "еще", "пожалуйста",
  "закрой", "закрыть", "закончил", "выполни", "выполнил", "выполнила", "выполнено", "выполненной",
  "сделал", "сделала", "сделай", "отметь", "отметить", "готово", "готова", "готов", "завершил", "завершить",
  "удали", "удалить", "убери", "убрать", "отмени", "отменить", "перенеси", "перенести", "поменяй",
  "измени", "изменить", "обнови", "обновить", "переименуй", "переименовать", "назови", "поставь",
  "возьми", "статус", "срок", "дедлайн", "работу", "работе", "работа", "сроком", "название", "назови",
]);

/**
 * Слова о времени. Нужны, чтобы отличить «перенеси НА ПЯТНИЦУ» (о чём речь —
 * понятно из предыдущей реплики) от «перенеси задачу про молоко» (задача названа,
 * и если её нет — надо честно сказать, а не трогать последнюю).
 */
const TIME_STEMS = [
  "сегодн", "завтр", "послезавтр", "вчер", "сейчас", "потом", "утр", "вечер", "ден", "дня", "днем",
  "ноч", "обед", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот", "воскресен",
  "недел", "месяц", "год", "час", "минут", "числ", "выходн", "будн", "начал", "конц", "серед",
  "январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр",
];

/** Только ли о времени это слово: «пятницу» — да, «отчёт» — нет. */
export function isTimeWord(w: string): boolean {
  if (/^\d+$/.test(w)) return true;
  return TIME_STEMS.some((st) => w.startsWith(st));
}

/** «Закрой задачу про отчёт» → ["отчет"]. Ё приводим к Е: люди пишут и так, и так. */
export function keyWords(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length > 1 && !SKIP_WORDS.has(w));
}

/**
 * Совпадают ли два слова с учётом русских окончаний: «отчёт» и «отчёты», «Ромашка» и «Ромашке».
 * Сравниваем по началу слова — сравнивать целиком бесполезно, падеж всё ломает.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const n = Math.min(a.length, b.length, 4);
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * Насколько название подходит под сказанное. Точное слово весит больше, чем
 * совпадение по началу: «отчёт» важнее, чем «отчаянный» под ту же основу.
 */
export function matchScore(title: string, words: string[]): number {
  if (!words.length) return 0;
  const has = keyWords(title);
  if (!has.length) return 0;
  let score = 0;
  for (const w of words) {
    if (has.includes(w)) score += 2;
    else if (has.some((h) => sameWord(h, w))) score += 1;
  }
  // Фраза целиком внутри названия — самый надёжный признак
  const low = String(title ?? "").toLowerCase().replace(/ё/g, "е");
  if (words.length > 1 && low.includes(words.join(" "))) score += 2;
  return score;
}

/**
 * Лучшее совпадение среди записей. `rivals` не пуст, когда несколько записей
 * подходят одинаково: тогда честнее переспросить, чем закрыть не ту задачу.
 */
export function bestMatch<T>(items: T[], title: (x: T) => string, query: string): { best: T | null; rivals: T[] } {
  const words = keyWords(query);
  if (!words.length) return { best: null, rivals: [] };
  const scored = items
    .map((item) => ({ item, score: matchScore(title(item), words) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { best: null, rivals: [] };
  const top = scored[0].score;
  const tied = scored.filter((x) => x.score === top);
  if (tied.length > 1) return { best: null, rivals: tied.map((x) => x.item) };
  return { best: scored[0].item, rivals: [] };
}

/* ---------- Отделение срока от названия ---------- */

/**
 * Куски текста, которые говорят о времени. Нужны, чтобы «напомни завтра
 * отправить отчёт» превратилось в задачу «Отправить отчёт» со сроком, а не в
 * задачу с названием «завтра отправить отчёт».
 *
 * Края слова берутся из WB_*, а не из \b: на кириллице \b молча не работает.
 */
const RU = "а-яa-z";
const WHEN_SOURCES = [
  `через\\s+(?:полчаса|полтора|час|\\d+|дв[ае]|три|четыре|пять|шесть|семь|восемь|девять|десять)\\s*(?:минут[${RU}]*|мин|час[${RU}]*|ч|дн[${RU}]*|день|недел[${RU}]*)?`,
  `(?:к|до|на|в|во)?\\s*(?:после)?завтра`,
  `сегодня`,
  `(?:к|до|в|во|на)\\s+(?:следующ[${RU}]+\\s+)?(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресен)[${RU}]*`,
  `(?:к|до|на)\\s+\\d{1,2}\\s+числ[${RU}]*`,
  `(?:в|во|к|до|на)\\s+\\d{1,2}[:.]\\d{2}`,
  `\\d{1,2}[:.]\\d{2}`,
  `(?:в|к|до|на)\\s+\\d{1,2}\\s*(?:час[${RU}]*|ч)?(?:\\s+(?:утра|дня|вечера|ночи))?`,
  `\\d{1,2}\\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[${RU}]*`,
  `\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?`,
  `(?:утром|днем|вечером|ночью|в\\s+обед|после\\s+обеда|полдень|полноч[${RU}]*)`,
];

/**
 * Делит фразу на название и срок: «отправить отчёт завтра в 15:00» →
 * {title: "Отправить отчёт", when: "завтра в 15:00"}.
 *
 * Название чистим от остатков предлогов и знаков, первую букву делаем большой.
 */
export function splitWhen(text: string): { title: string; when: string } {
  let title = ` ${String(text ?? "")} `;
  const found: string[] = [];
  for (const src of WHEN_SOURCES) {
    const re = new RegExp(`(^|[^${LETTER}])(${src})${WB_END}`, "gi");
    title = title.replace(re, (_m, before, hit) => {
      found.push(String(hit).trim());
      return `${before} `;
    });
  }
  const clean = title
    .replace(/\s+/g, " ")
    // после выреза срока рядом могли остаться два предлога: «в в офисе»
    .replace(/(^|\s)(в|во|к|на|до|с|со)\s+(?=(?:в|во|к|на|до|с|со)\s)/gi, "$1")
    .replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "")
    // висящие предлоги после выреза срока: «позвонить в» → «позвонить»
    .replace(new RegExp(`\\s+(?:в|во|к|на|до|с|со)$`, "i"), "")
    .trim();
  return {
    title: clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "",
    when: found.join(" ").replace(/\s+/g, " ").trim(),
  };
}

/** Личное это дело или рабочее — по словам. Ошибиться не страшно, поправимо. */
export function guessScope(text: string): "work" | "personal" {
  return /(врач|больниц|аптек|зуб|стоматолог|терапевт|окулист|массаж|стриж|парикмахер|семь|мам[аеуы]|пап[аеуы]|жен[аеы]|муж|дет[иям]|дом|квартир|магазин|продукт|покуп|зал|трениров|отпуск|подар|днюх|день рождения)/i.test(text)
    ? "personal"
    : "work";
}
