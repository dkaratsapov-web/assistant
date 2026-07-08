"""Фоновые задачи: напоминания о дедлайнах и утренний дайджест."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from aiogram import Bot
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from . import db as dbmod
from .config import Config
from .db import Database
from .reports import build_digest
from .utils import format_due

logger = logging.getLogger(__name__)


async def _check_reminders(bot: Bot, db: Database, config: Config) -> None:
    """Раз в N минут: шлём напоминания по задачам с наступившим дедлайном."""
    now_iso = datetime.now(timezone.utc).isoformat()
    tasks = await db.tasks_due_for_reminder(now_iso)
    for task in tasks:
        recipient = task["assignee_id"] or task["creator_id"]
        due_txt = format_due(task["due_at"], config.tz)
        text = f"⏰ Напоминание по задаче #{task['id']}\n{task['title']}\nДедлайн: {due_txt}"
        try:
            await bot.send_message(recipient, text)
            await db.mark_reminded(task["id"])
        except Exception as exc:
            logger.warning("Не удалось отправить напоминание по задаче %s: %s", task["id"], exc)


async def _send_digest(bot: Bot, db: Database, config: Config) -> None:
    """Утром: рассылаем сводку владельцу и команде."""
    recipients = await db.list_users(dbmod.ROLE_OWNER)
    recipients += await db.list_users(dbmod.ROLE_MEMBER)
    for u in recipients:
        try:
            text = await build_digest(db, config, u["user_id"], u["role"])
            await bot.send_message(u["user_id"], "☀️ Доброе утро!\n\n" + text)
        except Exception as exc:
            logger.warning("Не удалось отправить дайджест %s: %s", u["user_id"], exc)


def setup_scheduler(bot: Bot, db: Database, config: Config) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=config.tz)
    scheduler.add_job(
        _check_reminders,
        IntervalTrigger(minutes=5),
        args=(bot, db, config),
        id="reminders",
        replace_existing=True,
    )
    scheduler.add_job(
        _send_digest,
        CronTrigger(hour=config.digest_hour, minute=0),
        args=(bot, db, config),
        id="digest",
        replace_existing=True,
    )
    return scheduler
