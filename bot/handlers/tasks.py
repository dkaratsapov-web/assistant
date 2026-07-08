"""Задачи: создание (пошагово), список, смена статуса, удаление."""
from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message
from aiogram.utils.keyboard import InlineKeyboardBuilder

from .. import db as dbmod
from .. import keyboards as kb
from ..config import Config
from ..db import Database
from ..utils import format_due, parse_due

router = Router()


class AddTask(StatesGroup):
    title = State()
    deadline = State()
    client = State()


def _task_line(task, client_name: str | None, tz: str) -> str:
    status = dbmod.TASK_STATUS_LABELS.get(task["status"], task["status"])
    due = format_due(task["due_at"], tz)
    parts = [f"<b>#{task['id']}</b> {task['title']}"]
    meta = [status]
    if due:
        meta.append(due)
    if client_name:
        meta.append(f"👥 {client_name}")
    parts.append(" · ".join(meta))
    if task["description"]:
        parts.append(f"<i>{task['description']}</i>")
    return "\n".join(parts)


# ---------- Создание задачи ----------

@router.message(Command("addtask"))
@router.message(F.text == kb.BTN_ADD_TASK)
async def add_task_start(message: Message, state: FSMContext):
    await state.set_state(AddTask.title)
    await message.answer("Что нужно сделать? Напиши название задачи.\n(«отмена» — прервать)")


@router.message(AddTask.title, F.text)
async def add_task_title(message: Message, state: FSMContext):
    if message.text.lower() == "отмена":
        await state.clear()
        await message.answer("Отменил.")
        return
    await state.update_data(title=message.text.strip())
    await state.set_state(AddTask.deadline)
    await message.answer(
        "Когда дедлайн?\n"
        "Можно словами: «завтра», «пятница», «через 3 дня», «15.03 14:00».\n"
        "Или «-», если без дедлайна."
    )


@router.message(AddTask.deadline, F.text)
async def add_task_deadline(message: Message, state: FSMContext, db: Database, config: Config):
    if message.text.lower() == "отмена":
        await state.clear()
        await message.answer("Отменил.")
        return

    due = parse_due(message.text, config.tz)
    if due is None and message.text.strip() not in ("-", "нет", "без"):
        # Не распознали — уточняем, но не блокируем: предложим сохранить без дедлайна
        await message.answer(
            "Не понял дату. Попробуй «завтра», «15.03», «через 2 дня» или «-» без дедлайна."
        )
        return
    await state.update_data(due=due)

    clients = await db.list_clients(status="active")
    builder = InlineKeyboardBuilder()
    builder.button(text="Без клиента", callback_data="taskclient:none")
    for c in clients[:20]:
        builder.button(text=c["name"], callback_data=f"taskclient:{c['id']}")
    builder.adjust(1)
    await state.set_state(AddTask.client)
    await message.answer("Привязать к клиенту?", reply_markup=builder.as_markup())


@router.callback_query(AddTask.client, F.data.startswith("taskclient:"))
async def add_task_client(call: CallbackQuery, state: FSMContext, db: Database, config: Config):
    _, value = call.data.split(":")
    client_id = None if value == "none" else int(value)
    data = await state.get_data()
    task_id = await db.add_task(
        title=data["title"],
        creator_id=call.from_user.id,
        client_id=client_id,
        assignee_id=call.from_user.id,
        due_at=data.get("due"),
    )
    await state.clear()

    due_txt = format_due(data.get("due"), config.tz)
    suffix = f"\nДедлайн: {due_txt}" if due_txt else ""
    if client_id:
        client = await db.get_client(client_id)
        suffix += f"\nКлиент: {client['name']}"
    await call.message.edit_text(f"✅ Задача #{task_id} создана: {data['title']}{suffix}")
    await call.answer("Готово")


# ---------- Список задач ----------

@router.message(Command("tasks"))
@router.message(F.text == kb.BTN_TASKS)
async def list_tasks(message: Message, db: Database, config: Config, user):
    if user is None:
        return
    assignee = None if user["role"] == dbmod.ROLE_OWNER else message.from_user.id
    tasks = await db.list_tasks(
        statuses=(dbmod.TASK_OPEN, dbmod.TASK_IN_PROGRESS), assignee_id=assignee
    )
    if not tasks:
        await message.answer("Активных задач нет. Добавь через «➕ Задача».")
        return

    await message.answer(f"📋 Активные задачи: {len(tasks)}")
    for t in tasks[:30]:
        client = await db.get_client(t["client_id"]) if t["client_id"] else None
        client_name = client["name"] if client else None
        await message.answer(
            _task_line(t, client_name, config.tz),
            reply_markup=kb.task_actions(t["id"], t["status"]),
        )


# ---------- Действия с задачей ----------

@router.callback_query(F.data.startswith("task:"))
async def task_action(call: CallbackQuery, db: Database, config: Config):
    _, action, task_id_str = call.data.split(":")
    task_id = int(task_id_str)
    task = await db.get_task(task_id)
    if task is None:
        await call.answer("Задача не найдена.", show_alert=True)
        await call.message.edit_reply_markup(reply_markup=None)
        return

    if action == "done":
        await db.set_task_status(task_id, dbmod.TASK_DONE)
        await call.answer("Готово ✅")
    elif action == "progress":
        await db.set_task_status(task_id, dbmod.TASK_IN_PROGRESS)
        await call.answer("В работе 🟡")
    elif action == "reopen":
        await db.set_task_status(task_id, dbmod.TASK_OPEN)
        await call.answer("Открыта заново")
    elif action == "del":
        await db.delete_task(task_id)
        await call.message.edit_text(f"🗑 Задача #{task_id} удалена.")
        await call.answer("Удалено")
        return

    task = await db.get_task(task_id)
    client = await db.get_client(task["client_id"]) if task["client_id"] else None
    client_name = client["name"] if client else None
    await call.message.edit_text(
        _task_line(task, client_name, config.tz),
        reply_markup=kb.task_actions(task_id, task["status"]),
    )
