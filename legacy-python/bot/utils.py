"""Вспомогательные функции: парсинг дедлайнов и форматирование."""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import db as dbmod


def parse_due(text: str, tz_name: str) -> str | None:
    """Разбирает дедлайн из свободного текста в ISO-строку (UTC).

    Поддерживает: 'сегодня', 'завтра', 'послезавтра', 'через 3 дня',
    'через 2 часа', 'пн'..'вс', 'ДД.ММ', 'ДД.ММ ЧЧ:ММ', 'ДД.ММ.ГГГГ'.
    Возвращает None, если распознать не удалось.
    """
    tz = ZoneInfo(tz_name)
    now = datetime.now(tz)
    raw = text.strip().lower()
    if not raw or raw in ("-", "нет", "без", "без дедлайна", "skip", "пропустить"):
        return None

    # Время в конце строки (ЧЧ:ММ или ЧЧ.ММ), по умолчанию 10:00
    hour, minute = 10, 0
    time_match = re.search(r"(\d{1,2})[:.](\d{2})\s*$", raw)
    if time_match:
        hour = min(int(time_match.group(1)), 23)
        minute = min(int(time_match.group(2)), 59)
        raw = raw[: time_match.start()].strip()

    def at(day: datetime) -> str:
        dt = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return dt.astimezone(ZoneInfo("UTC")).isoformat()

    if raw in ("сегодня", "today"):
        return at(now)
    if raw in ("завтра", "tomorrow"):
        return at(now + timedelta(days=1))
    if raw in ("послезавтра",):
        return at(now + timedelta(days=2))

    # "через N дней/часов"
    m = re.match(r"через\s+(\d+)\s*(дн|дня|дней|день|час|часа|часов|ч)", raw)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if unit.startswith("ч") or unit.startswith("час"):
            dt = now + timedelta(hours=n)
            return dt.replace(second=0, microsecond=0).astimezone(ZoneInfo("UTC")).isoformat()
        return at(now + timedelta(days=n))

    # Дни недели
    weekdays = {
        "пн": 0, "вт": 1, "ср": 2, "чт": 3, "пт": 4, "сб": 5, "вс": 6,
        "понедельник": 0, "вторник": 1, "среда": 2, "четверг": 3,
        "пятница": 4, "суббота": 5, "воскресенье": 6,
    }
    if raw in weekdays:
        target = weekdays[raw]
        delta = (target - now.weekday()) % 7
        delta = delta or 7  # ближайший будущий, не сегодня
        return at(now + timedelta(days=delta))

    # ДД.ММ или ДД.ММ.ГГГГ
    m = re.match(r"(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$", raw)
    if m:
        day, month = int(m.group(1)), int(m.group(2))
        year = m.group(3)
        if year:
            year_i = int(year)
            if year_i < 100:
                year_i += 2000
        else:
            year_i = now.year
        try:
            dt = now.replace(
                year=year_i, month=month, day=day,
                hour=hour, minute=minute, second=0, microsecond=0,
            )
        except ValueError:
            return None
        # Если дата без года уже прошла — переносим на следующий год
        if not year and dt < now:
            dt = dt.replace(year=year_i + 1)
        return dt.astimezone(ZoneInfo("UTC")).isoformat()

    return None


def format_due(due_iso: str | None, tz_name: str) -> str:
    """Человекочитаемый дедлайн с пометкой о просрочке/сегодня."""
    if not due_iso:
        return ""
    tz = ZoneInfo(tz_name)
    dt = datetime.fromisoformat(due_iso).astimezone(tz)
    now = datetime.now(tz)
    date_str = dt.strftime("%d.%m %H:%M")
    days = (dt.date() - now.date()).days
    if dt < now:
        return f"⚠️ просрочено ({date_str})"
    if days == 0:
        return f"🔥 сегодня {dt.strftime('%H:%M')}"
    if days == 1:
        return f"завтра {dt.strftime('%H:%M')}"
    return date_str


def platforms_to_text(platforms: str) -> str:
    if not platforms:
        return "—"
    keys = [p for p in platforms.split(",") if p]
    return ", ".join(dbmod.PLATFORMS.get(k, k) for k in keys)


def user_display(row) -> str:
    """Отображаемое имя пользователя для списков."""
    name = row["full_name"] or "Без имени"
    username = f" (@{row['username']})" if row["username"] else ""
    return f"{name}{username}"
