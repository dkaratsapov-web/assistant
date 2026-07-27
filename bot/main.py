"""Точка входа: инициализация бота, БД, планировщика и запуск polling."""
from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand

from .ai import AIClient
from .config import load_config
from .db import Database
from .handlers import register_handlers
from .middlewares import AccessMiddleware
from .scheduler import setup_scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("assistant")


async def set_commands(bot: Bot) -> None:
    commands = [
        BotCommand(command="menu", description="Показать меню"),
        BotCommand(command="tasks", description="Активные задачи"),
        BotCommand(command="addtask", description="Новая задача"),
        BotCommand(command="clients", description="Клиенты"),
        BotCommand(command="addclient", description="Новый клиент"),
        BotCommand(command="notes", description="Заметки"),
        BotCommand(command="ai", description="Спросить ИИ"),
        BotCommand(command="digest", description="Сводка на сегодня"),
        BotCommand(command="help", description="Помощь"),
    ]
    await bot.set_my_commands(commands)


async def main() -> None:
    config = load_config()

    db = Database(config.db_path)
    await db.connect()
    await db.ensure_owner(config.owner_id)

    ai = AIClient(config.anthropic_api_key, config.anthropic_model) if config.ai_enabled else None
    if ai is None:
        logger.warning("ANTHROPIC_API_KEY не задан — ИИ-помощник отключён.")

    # Если хостинг режет доступ к Telegram (частая беда РФ-серверов), ходим в обход:
    # - TELEGRAM_API_URL: свой адрес Telegram Bot API (например, прокси на Cloudflare Workers)
    # - PROXY_URL: SOCKS5/HTTP прокси
    session_kwargs: dict = {}
    if config.telegram_api_url:
        session_kwargs["api"] = TelegramAPIServer.from_base(config.telegram_api_url)
        logger.info("Telegram API через: %s", config.telegram_api_url)
    if config.proxy_url:
        session_kwargs["proxy"] = config.proxy_url
        logger.info("Telegram через прокси: %s", config.proxy_url.split("@")[-1])
    session = AiohttpSession(**session_kwargs) if session_kwargs else None

    bot = Bot(
        token=config.bot_token,
        session=session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher(storage=MemoryStorage())

    access = AccessMiddleware(db, config, ai)
    dp.message.middleware(access)
    dp.callback_query.middleware(access)

    register_handlers(dp)

    scheduler = setup_scheduler(bot, db, config)
    scheduler.start()

    await set_commands(bot)
    logger.info("Бот запущен. Владелец: %s, модель ИИ: %s", config.owner_id, config.anthropic_model)

    try:
        await dp.start_polling(bot)
    finally:
        scheduler.shutdown(wait=False)
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logger.info("Остановлено.")
