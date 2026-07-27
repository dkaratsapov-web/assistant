"""Клавиатуры: главное меню (reply) и инлайн-кнопки."""
from __future__ import annotations

from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardMarkup,
    KeyboardButton,
)
from aiogram.utils.keyboard import InlineKeyboardBuilder

from . import db as dbmod

# Тексты кнопок главного меню (используются и как триггеры в хендлерах)
BTN_TASKS = "📋 Задачи"
BTN_ADD_TASK = "➕ Задача"
BTN_CLIENTS = "👥 Клиенты"
BTN_NOTES = "📝 Заметки"
BTN_AI = "🤖 ИИ-помощник"
BTN_DIGEST = "📊 Сводка"
BTN_HELP = "❓ Помощь"


def main_menu(is_owner: bool = False) -> ReplyKeyboardMarkup:
    rows = [
        [KeyboardButton(text=BTN_ADD_TASK), KeyboardButton(text=BTN_TASKS)],
        [KeyboardButton(text=BTN_CLIENTS), KeyboardButton(text=BTN_NOTES)],
        [KeyboardButton(text=BTN_AI), KeyboardButton(text=BTN_DIGEST)],
        [KeyboardButton(text=BTN_HELP)],
    ]
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def task_actions(task_id: int, status: str) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    if status != dbmod.TASK_DONE:
        if status == dbmod.TASK_OPEN:
            kb.button(text="🟡 В работу", callback_data=f"task:progress:{task_id}")
        kb.button(text="✅ Готово", callback_data=f"task:done:{task_id}")
    else:
        kb.button(text="↩️ Вернуть", callback_data=f"task:reopen:{task_id}")
    kb.button(text="🗑 Удалить", callback_data=f"task:del:{task_id}")
    kb.adjust(2)
    return kb.as_markup()


def confirm_delete(entity: str, entity_id: int) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.button(text="✅ Да, удалить", callback_data=f"{entity}:delconfirm:{entity_id}")
    kb.button(text="Отмена", callback_data=f"{entity}:delcancel:{entity_id}")
    kb.adjust(2)
    return kb.as_markup()


def platforms_picker(selected: set[str]) -> InlineKeyboardMarkup:
    """Мультивыбор площадок при создании клиента."""
    kb = InlineKeyboardBuilder()
    for key, label in dbmod.PLATFORMS.items():
        mark = "✅ " if key in selected else ""
        kb.button(text=f"{mark}{label}", callback_data=f"plat:toggle:{key}")
    kb.button(text="Готово ▶️", callback_data="plat:done")
    kb.adjust(2, 2, 2, 1)
    return kb.as_markup()


def client_actions(client_id: int) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.button(text="📋 Задачи клиента", callback_data=f"client:tasks:{client_id}")
    kb.button(text="⏸ Пауза/актив", callback_data=f"client:togglestatus:{client_id}")
    kb.button(text="🗑 Удалить", callback_data=f"client:del:{client_id}")
    kb.adjust(1, 2)
    return kb.as_markup()


def pending_actions(user_id: int) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.button(text="✅ В команду", callback_data=f"access:member:{user_id}")
    kb.button(text="👤 Как клиента", callback_data=f"access:client:{user_id}")
    kb.button(text="🚫 Отклонить", callback_data=f"access:reject:{user_id}")
    kb.adjust(2, 1)
    return kb.as_markup()


def note_delete_button(note_id: int) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.button(text="🗑 Удалить заметку", callback_data=f"note:del:{note_id}")
    return kb.as_markup()
