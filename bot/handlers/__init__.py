"""Регистрация всех роутеров бота."""
from aiogram import Dispatcher

from . import access, ai_chat, clients, common, notes, tasks


def register_handlers(dp: Dispatcher) -> None:
    # Порядок важен: access ловит /start и заявки, common — меню и помощь.
    dp.include_router(access.router)
    dp.include_router(common.router)
    dp.include_router(tasks.router)
    dp.include_router(clients.router)
    dp.include_router(notes.router)
    dp.include_router(ai_chat.router)  # ai_chat последним — ловит свободный текст
