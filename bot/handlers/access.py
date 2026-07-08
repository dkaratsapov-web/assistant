"""Доступ: /start, заявки на доступ, подтверждение владельцем, /users."""
from __future__ import annotations

from aiogram import Bot, F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, Message

from .. import db as dbmod
from .. import keyboards as kb
from ..config import Config
from ..db import Database
from ..utils import user_display

router = Router()

WELCOME = (
    "Привет! Я твой рабочий ассистент 🤝\n\n"
    "Помогаю держать под контролем задачи, дедлайны, клиентов и заметки, "
    "а ещё умею писать тексты объявлений и подкидывать идеи через ИИ.\n\n"
    "Пользуйся кнопками меню внизу. Полный список — /help."
)


@router.message(Command("start"))
async def cmd_start(message: Message, db: Database, config: Config, user, bot: Bot):
    uid = message.from_user.id

    # Владелец
    if uid == config.owner_id:
        await db.ensure_owner(uid)
        await db.upsert_user_profile(uid, message.from_user.username, message.from_user.full_name)
        await message.answer(WELCOME, reply_markup=kb.main_menu(is_owner=True))
        return

    # Уже известный пользователь
    if user is not None and user["role"] != dbmod.ROLE_PENDING:
        await message.answer(WELCOME, reply_markup=kb.main_menu())
        return

    # Уже ждёт подтверждения
    if user is not None and user["role"] == dbmod.ROLE_PENDING:
        await message.answer("⏳ Заявка уже отправлена. Ждём подтверждения владельца.")
        return

    # Новый пользователь — регистрируем заявку и уведомляем владельца
    await db.request_access(uid, message.from_user.username, message.from_user.full_name)
    await message.answer(
        "Заявка на доступ отправлена владельцу бота. Как подтвердит — я напишу 👌"
    )
    try:
        await bot.send_message(
            config.owner_id,
            f"🔔 Новая заявка на доступ:\n{user_display_from_msg(message)}\nID: <code>{uid}</code>",
            reply_markup=kb.pending_actions(uid),
        )
    except Exception:
        pass


def user_display_from_msg(message: Message) -> str:
    username = f" (@{message.from_user.username})" if message.from_user.username else ""
    return f"{message.from_user.full_name}{username}"


@router.callback_query(F.data.startswith("access:"))
async def on_access_decision(call: CallbackQuery, db: Database, config: Config, user, bot: Bot):
    # Только владелец может подтверждать
    if call.from_user.id != config.owner_id:
        await call.answer("Только владелец может управлять доступом.", show_alert=True)
        return

    _, action, uid_str = call.data.split(":")
    uid = int(uid_str)
    target = await db.get_user(uid)
    if target is None:
        await call.answer("Пользователь не найден.", show_alert=True)
        await call.message.edit_reply_markup(reply_markup=None)
        return

    if action == "member":
        await db.set_role(uid, dbmod.ROLE_MEMBER)
        note, notify = "Добавлен в команду ✅", "✅ Доступ выдан! Тебя добавили в команду. Нажми /start."
    elif action == "client":
        await db.set_role(uid, dbmod.ROLE_CLIENT)
        note, notify = "Добавлен как клиент 👤", "✅ Доступ выдан (роль: клиент). Нажми /start."
    else:  # reject
        await db.delete_user(uid)
        note, notify = "Заявка отклонена 🚫", None

    await call.message.edit_text(f"{call.message.text}\n\n→ {note}")
    if notify:
        try:
            await bot.send_message(uid, notify, reply_markup=kb.main_menu())
        except Exception:
            pass
    await call.answer(note)


@router.message(Command("users"))
async def cmd_users(message: Message, db: Database, config: Config, user):
    if user is None or user["role"] != dbmod.ROLE_OWNER:
        await message.answer("Команда доступна только владельцу.")
        return

    pending = await db.list_users(dbmod.ROLE_PENDING)
    members = await db.list_users(dbmod.ROLE_MEMBER)
    clients = await db.list_users(dbmod.ROLE_CLIENT)

    lines = ["👥 Пользователи\n"]
    lines.append("Владелец: ты")
    if members:
        lines.append("\n🧑‍💼 Команда:")
        lines += [f"  {user_display(u)} — /kick {u['user_id']}" for u in members]
    if clients:
        lines.append("\n👤 Клиенты:")
        lines += [f"  {user_display(u)} — /kick {u['user_id']}" for u in clients]
    if pending:
        lines.append("\n⏳ Ожидают (подтверди по кнопкам из заявки):")
        lines += [f"  {user_display(u)} — ID {u['user_id']}" for u in pending]
    if not (members or clients or pending):
        lines.append("\nПока только ты. Дай доступ команде — пусть напишут боту /start.")
    await message.answer("\n".join(lines))


@router.message(Command("kick"))
async def cmd_kick(message: Message, db: Database, config: Config, user):
    if user is None or user["role"] != dbmod.ROLE_OWNER:
        await message.answer("Команда доступна только владельцу.")
        return
    parts = message.text.split()
    if len(parts) != 2 or not parts[1].isdigit():
        await message.answer("Использование: /kick <ID пользователя>")
        return
    uid = int(parts[1])
    if uid == config.owner_id:
        await message.answer("Нельзя удалить владельца.")
        return
    await db.delete_user(uid)
    await message.answer(f"Пользователь {uid} удалён из доступа.")
