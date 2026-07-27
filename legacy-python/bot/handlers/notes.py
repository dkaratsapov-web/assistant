"""Быстрые заметки и идеи: сохранение, просмотр, поиск."""
from __future__ import annotations

import re

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from .. import keyboards as kb
from ..db import Database

router = Router()


class AddNote(StatesGroup):
    text = State()


def _extract_tags(text: str) -> str:
    """Собирает #теги из текста заметки в строку через запятую."""
    tags = re.findall(r"#(\w+)", text)
    return ",".join(tags)


# Быстрое сохранение: сообщение, начинающееся с "!" — это заметка.
@router.message(F.text.startswith("!"))
async def quick_note(message: Message, db: Database):
    text = message.text[1:].strip()
    if not text:
        await message.answer("Пустая заметка. Напиши текст после «!».")
        return
    note_id = await db.add_note(message.from_user.id, text, _extract_tags(text))
    await message.answer("📝 Сохранил заметку.", reply_markup=kb.note_delete_button(note_id))


@router.message(Command("note"))
async def note_via_command(message: Message, state: FSMContext, db: Database):
    payload = message.text[len("/note"):].strip()
    if payload:
        note_id = await db.add_note(message.from_user.id, payload, _extract_tags(payload))
        await message.answer("📝 Сохранил.", reply_markup=kb.note_delete_button(note_id))
        return
    await state.set_state(AddNote.text)
    await message.answer("Напиши заметку одним сообщением. (можно с #тегами)")


@router.message(AddNote.text, F.text)
async def note_save(message: Message, state: FSMContext, db: Database):
    await state.clear()
    text = message.text.strip()
    note_id = await db.add_note(message.from_user.id, text, _extract_tags(text))
    await message.answer("📝 Сохранил.", reply_markup=kb.note_delete_button(note_id))


@router.message(Command("notes"))
@router.message(F.text == kb.BTN_NOTES)
async def list_notes(message: Message, db: Database):
    notes = await db.list_notes(message.from_user.id)
    if not notes:
        await message.answer(
            "Заметок пока нет.\nСовет: пришли сообщение, начав с «!» — сохраню как заметку.\n"
            "Например: <code>!идея: тест новых креативов для VK</code>"
        )
        return
    lines = ["📝 Последние заметки:\n"]
    for n in notes:
        tags = f"  🏷 {n['tags']}" if n["tags"] else ""
        lines.append(f"#{n['id']} · {n['text']}{tags}")
    lines.append("\nУдалить: /delnote <номер>   Поиск: /findnote <слово>")
    await message.answer("\n".join(lines))


@router.message(Command("findnote"))
async def find_notes(message: Message, db: Database):
    query = message.text[len("/findnote"):].strip()
    if not query:
        await message.answer("Использование: /findnote <слово>")
        return
    notes = await db.search_notes(message.from_user.id, query)
    if not notes:
        await message.answer(f"По запросу «{query}» ничего не нашёл.")
        return
    lines = [f"🔍 Найдено ({len(notes)}):\n"]
    for n in notes:
        lines.append(f"#{n['id']} · {n['text']}")
    await message.answer("\n".join(lines))


@router.message(Command("delnote"))
async def del_note_cmd(message: Message, db: Database):
    parts = message.text.split()
    if len(parts) != 2 or not parts[1].isdigit():
        await message.answer("Использование: /delnote <номер>")
        return
    await db.delete_note(int(parts[1]), message.from_user.id)
    await message.answer("🗑 Заметка удалена (если была твоей).")


@router.callback_query(F.data.startswith("note:del:"))
async def del_note_button(call: CallbackQuery, db: Database):
    note_id = int(call.data.split(":")[2])
    await db.delete_note(note_id, call.from_user.id)
    await call.message.edit_text("🗑 Заметка удалена.")
    await call.answer("Удалено")
