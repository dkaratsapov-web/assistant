"""Middleware: контроль доступа и проброс зависимостей в хендлеры."""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware
from aiogram.types import CallbackQuery, Message, TelegramObject

from . import db as dbmod
from .config import Config
from .db import Database


class AccessMiddleware(BaseMiddleware):
    """Пропускает только известных пользователей.

    Незарегистрированные видят только /start (обрабатывается в access-хендлере).
    Пользователи со статусом pending не получают доступа к функциям.
    В data пробрасываются: db, config, ai, user (строка из БД).
    """

    def __init__(self, database: Database, config: Config, ai: Any):
        self.db = database
        self.config = config
        self.ai = ai

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        data["db"] = self.db
        data["config"] = self.config
        data["ai"] = self.ai

        tg_user = data.get("event_from_user")
        if tg_user is None:
            return await handler(event, data)

        user_row = await self.db.get_user(tg_user.id)
        data["user"] = user_row

        # Обновляем профиль (имя/username) для известных пользователей
        if user_row is not None:
            full_name = tg_user.full_name
            if user_row["username"] != tg_user.username or user_row["full_name"] != full_name:
                await self.db.upsert_user_profile(tg_user.id, tg_user.username, full_name)

        is_known = user_row is not None and user_row["role"] != dbmod.ROLE_PENDING

        # Разрешаем всегда: /start и колбэки доступа обрабатываются отдельно
        text = getattr(event, "text", None)
        is_start = isinstance(event, Message) and text and text.startswith("/start")

        if is_known or is_start:
            return await handler(event, data)

        # Неизвестный/pending пользователь — вежливо тормозим
        if isinstance(event, Message):
            if user_row is not None and user_row["role"] == dbmod.ROLE_PENDING:
                await event.answer("⏳ Заявка на доступ отправлена. Ждём подтверждения владельца.")
            else:
                await event.answer(
                    "Нет доступа. Нажми /start, чтобы отправить заявку владельцу бота."
                )
        elif isinstance(event, CallbackQuery):
            await event.answer("Нет доступа.", show_alert=True)
        return None
