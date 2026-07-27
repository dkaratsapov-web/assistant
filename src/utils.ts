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

/**
 * Разбор дедлайна из свободного текста → ISO UTC или null.
 * Понимает: сегодня/завтра/послезавтра, «через N дней/часов», дни недели,
 * ДД.ММ, ДД.ММ ЧЧ:ММ, ДД.ММ.ГГГГ.
 */
export function parseDue(text: string, tzOffset: number): string | null {
  let raw = text.trim().toLowerCase();
  if (!raw || ["-", "нет", "без", "без дедлайна", "skip", "пропустить"].includes(raw)) {
    return null;
  }

  const local = nowLocal(tzOffset);
  let hour = 10;
  let minute = 0;

  const timeMatch = raw.match(/(\d{1,2})[:.](\d{2})\s*$/);
  if (timeMatch) {
    hour = Math.min(parseInt(timeMatch[1], 10), 23);
    minute = Math.min(parseInt(timeMatch[2], 10), 59);
    raw = raw.slice(0, timeMatch.index).trim();
  }

  const atDay = (d: Date): string => {
    const dd = new Date(d);
    dd.setUTCHours(hour, minute, 0, 0);
    return localToUtcIso(dd.getTime(), tzOffset);
  };

  const addDays = (n: number): Date => new Date(local.getTime() + n * 86400_000);

  if (raw === "сегодня" || raw === "today") return atDay(local);
  if (raw === "завтра" || raw === "tomorrow") return atDay(addDays(1));
  if (raw === "послезавтра") return atDay(addDays(2));

  const rel = raw.match(/^через\s+(\d+)\s*(дн|дня|дней|день|час|часа|часов|ч)/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    if (unit.startsWith("ч")) {
      const dd = new Date(local.getTime() + n * 3600_000);
      dd.setUTCSeconds(0, 0);
      return localToUtcIso(dd.getTime(), tzOffset);
    }
    return atDay(addDays(n));
  }

  const weekdays: Record<string, number> = {
    пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0,
    понедельник: 1, вторник: 2, среда: 3, четверг: 4, пятница: 5, суббота: 6, воскресенье: 0,
  };
  if (raw in weekdays) {
    const target = weekdays[raw];
    let delta = (target - local.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return atDay(addDays(delta));
  }

  const dm = raw.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const month = parseInt(dm[2], 10) - 1;
    let year = dm[3] ? parseInt(dm[3], 10) : local.getUTCFullYear();
    if (year < 100) year += 2000;
    const dd = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
    if (!dm[3] && dd.getTime() < local.getTime()) {
      dd.setUTCFullYear(year + 1);
    }
    return localToUtcIso(dd.getTime(), tzOffset);
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
