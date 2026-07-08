"""Клиенты/проекты: карточки, площадки, статусы, задачи клиента."""
from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from .. import db as dbmod
from .. import keyboards as kb
from ..config import Config
from ..db import Database
from ..reports import build_clients_overview
from ..utils import format_due, platforms_to_text

router = Router()


class AddClient(StatesGroup):
    name = State()
    platforms = State()
    budget = State()
    contact = State()


def _client_card(client, tz: str) -> str:
    status = "🟢 активен" if client["status"] == "active" else "⏸ на паузе"
    lines = [
        f"<b>#{client['id']} {client['name']}</b>",
        f"Статус: {status}",
        f"Площадки: {platforms_to_text(client['platforms'])}",
    ]
    if client["budget"]:
        lines.append(f"Бюджет: {client['budget']}")
    if client["contact"]:
        lines.append(f"Контакт: {client['contact']}")
    if client["notes"]:
        lines.append(f"Заметки: {client['notes']}")
    return "\n".join(lines)


# ---------- Список ----------

@router.message(Command("clients"))
@router.message(F.text == kb.BTN_CLIENTS)
async def list_clients(message: Message, db: Database):
    text = await build_clients_overview(db)
    await message.answer(text + "\n\nДобавить: /addclient")


@router.message(Command("client"))
async def show_client(message: Message, db: Database, config: Config):
    parts = message.text.split()
    if len(parts) != 2 or not parts[1].isdigit():
        await message.answer("Использование: /client <номер>. Список — /clients")
        return
    client = await db.get_client(int(parts[1]))
    if client is None:
        await message.answer("Клиент не найден.")
        return
    await message.answer(
        _client_card(client, config.tz), reply_markup=kb.client_actions(client["id"])
    )


# ---------- Создание ----------

@router.message(Command("addclient"))
async def add_client_start(message: Message, state: FSMContext, user):
    if user is None or user["role"] == dbmod.ROLE_CLIENT:
        await message.answer("Добавлять клиентов может только команда.")
        return
    await state.set_state(AddClient.name)
    await message.answer("Название клиента / проекта? («отмена» — прервать)")


@router.message(AddClient.name, F.text)
async def add_client_name(message: Message, state: FSMContext):
    if message.text.lower() == "отмена":
        await state.clear()
        await message.answer("Отменил.")
        return
    await state.update_data(name=message.text.strip(), platforms=set())
    await state.set_state(AddClient.platforms)
    await message.answer(
        "Какие площадки ведём? Отметь нужные и нажми «Готово».",
        reply_markup=kb.platforms_picker(set()),
    )


@router.callback_query(AddClient.platforms, F.data.startswith("plat:"))
async def add_client_platforms(call: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    selected: set[str] = data.get("platforms", set())
    _, action, *rest = call.data.split(":")

    if action == "toggle":
        key = rest[0]
        selected.symmetric_difference_update({key})
        await state.update_data(platforms=selected)
        await call.message.edit_reply_markup(reply_markup=kb.platforms_picker(selected))
        await call.answer()
        return

    # done
    await state.set_state(AddClient.budget)
    await call.message.edit_text(
        f"Площадки: {platforms_to_text(','.join(selected))}"
    )
    await call.message.answer("Месячный бюджет? (например «50 000 ₽» или «-»)")
    await call.answer()


@router.message(AddClient.budget, F.text)
async def add_client_budget(message: Message, state: FSMContext):
    budget = "" if message.text.strip() in ("-", "нет") else message.text.strip()
    await state.update_data(budget=budget)
    await state.set_state(AddClient.contact)
    await message.answer("Контакт клиента? (телефон/@ник/email или «-»)")


@router.message(AddClient.contact, F.text)
async def add_client_contact(message: Message, state: FSMContext, db: Database, config: Config):
    contact = "" if message.text.strip() in ("-", "нет") else message.text.strip()
    data = await state.get_data()
    client_id = await db.add_client(
        name=data["name"],
        platforms=",".join(sorted(data.get("platforms", set()))),
        budget=data.get("budget", ""),
        contact=contact,
    )
    await state.clear()
    client = await db.get_client(client_id)
    await message.answer("✅ Клиент добавлен:\n\n" + _client_card(client, config.tz))


# ---------- Действия ----------

@router.callback_query(F.data.startswith("client:"))
async def client_action(call: CallbackQuery, db: Database, config: Config):
    _, action, client_id_str = call.data.split(":")
    client_id = int(client_id_str)
    client = await db.get_client(client_id)
    if client is None:
        await call.answer("Клиент не найден.", show_alert=True)
        return

    if action == "tasks":
        tasks = await db.list_tasks(
            statuses=(dbmod.TASK_OPEN, dbmod.TASK_IN_PROGRESS), client_id=client_id
        )
        if not tasks:
            await call.message.answer(f"У «{client['name']}» нет активных задач.")
        else:
            lines = [f"📋 Задачи «{client['name']}»:\n"]
            for t in tasks:
                due = format_due(t["due_at"], config.tz)
                due_part = f" — {due}" if due else ""
                lines.append(f"  #{t['id']} {t['title']}{due_part}")
            await call.message.answer("\n".join(lines))
        await call.answer()

    elif action == "togglestatus":
        new_status = "paused" if client["status"] == "active" else "active"
        await db.update_client_status(client_id, new_status)
        client = await db.get_client(client_id)
        await call.message.edit_text(
            _client_card(client, config.tz), reply_markup=kb.client_actions(client_id)
        )
        await call.answer("Статус изменён")

    elif action == "del":
        await call.message.edit_text(
            f"Удалить клиента «{client['name']}»? Задачи останутся, но отвяжутся.",
            reply_markup=kb.confirm_delete("client", client_id),
        )
        await call.answer()

    elif action == "delconfirm":
        await db.delete_client(client_id)
        await call.message.edit_text(f"🗑 Клиент «{client['name']}» удалён.")
        await call.answer("Удалено")

    elif action == "delcancel":
        await call.message.edit_text(
            _client_card(client, config.tz), reply_markup=kb.client_actions(client_id)
        )
        await call.answer("Отменено")
