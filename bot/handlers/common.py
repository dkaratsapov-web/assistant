"""Общие команды: помощь, сводка, меню."""
from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import Message

from .. import db as dbmod
from .. import keyboards as kb
from ..config import Config
from ..db import Database
from ..reports import build_digest

router = Router()

HELP_TEXT = """<b>Что я умею</b>

<b>📋 Задачи и дедлайны</b>
• «➕ Задача» или /addtask — добавить задачу (пошагово)
• «📋 Задачи» или /tasks — список активных задач
• Отмечай статусы кнопками под задачей

<b>👥 Клиенты и проекты</b>
• /addclient — новый клиент (площадки, бюджет, контакт)
• /clients — список клиентов
• /client &lt;номер&gt; — карточка клиента

<b>📝 Заметки и идеи</b>
• Просто пришли текст с «!» в начале — сохраню как заметку
• «📝 Заметки» или /notes — последние заметки
• /findnote &lt;слово&gt; — поиск по заметкам

<b>🤖 ИИ-помощник (Claude)</b>
• «🤖 ИИ-помощник» — режим диалога с ИИ
• /ai &lt;запрос&gt; — быстрый вопрос (напиши объявление, идею и т.п.)

<b>📊 Прочее</b>
• «📊 Сводка» или /digest — задачи и дедлайны на сегодня
• Утренний дайджест приходит автоматически

<b>Для владельца</b>
• /users — список пользователей и заявок
• /kick &lt;ID&gt; — убрать доступ

<i>Совет: дедлайн можно писать словами — «завтра», «пятница», «через 3 дня», «15.03 14:00».</i>"""


@router.message(Command("help"))
@router.message(F.text == kb.BTN_HELP)
async def cmd_help(message: Message):
    await message.answer(HELP_TEXT)


@router.message(Command("menu"))
async def cmd_menu(message: Message, user):
    is_owner = user is not None and user["role"] == dbmod.ROLE_OWNER
    await message.answer("Меню внизу 👇", reply_markup=kb.main_menu(is_owner))


@router.message(Command("digest"))
@router.message(F.text == kb.BTN_DIGEST)
async def cmd_digest(message: Message, db: Database, config: Config, user):
    if user is None:
        return
    text = await build_digest(db, config, message.from_user.id, user["role"])
    await message.answer(text)
