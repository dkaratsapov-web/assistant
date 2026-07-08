"""ИИ-помощник: быстрый запрос /ai и режим диалога."""
from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message

from .. import keyboards as kb
from ..config import Config

router = Router()

AI_HINT = (
    "🤖 Режим ИИ-помощника включён.\n\n"
    "Спрашивай что угодно по маркетингу. Например:\n"
    "• «Напиши 5 заголовков для Директа: доставка цветов, срочно»\n"
    "• «Придумай оффер для таргета ВК: онлайн-курс по Python»\n"
    "• «Разбери структуру лендинга для стоматологии»\n\n"
    "Чтобы выйти — напиши «стоп» или /stop."
)


class AIChat(StatesGroup):
    active = State()


async def _reply_ai(message: Message, ai, prompt: str) -> None:
    if ai is None:
        await message.answer(
            "ИИ-помощник не настроен. Добавь ANTHROPIC_API_KEY в .env, чтобы включить."
        )
        return
    thinking = await message.answer("💭 Думаю…")
    answer = await ai.ask(prompt)
    try:
        await thinking.delete()
    except Exception:
        pass
    # Telegram ограничивает сообщение ~4096 символами — режем при необходимости
    for chunk in _split(answer):
        await message.answer(chunk)


def _split(text: str, limit: int = 4000) -> list[str]:
    if len(text) <= limit:
        return [text]
    chunks, current = [], ""
    for line in text.split("\n"):
        if len(current) + len(line) + 1 > limit:
            chunks.append(current)
            current = ""
        current += line + "\n"
    if current:
        chunks.append(current)
    return chunks


@router.message(Command("ai"))
async def ai_quick(message: Message, ai):
    prompt = message.text[len("/ai"):].strip()
    if not prompt:
        await message.answer("Использование: /ai <запрос>\nПример: /ai напиши объявление для Авито: ремонт ноутбуков")
        return
    await _reply_ai(message, ai, prompt)


@router.message(F.text == kb.BTN_AI)
async def ai_mode_start(message: Message, state: FSMContext, ai):
    if ai is None:
        await message.answer(
            "ИИ-помощник не настроен. Добавь ANTHROPIC_API_KEY в .env, чтобы включить."
        )
        return
    await state.set_state(AIChat.active)
    await message.answer(AI_HINT)


@router.message(Command("stop"))
async def ai_mode_stop(message: Message, state: FSMContext):
    current = await state.get_state()
    if current == AIChat.active.state:
        await state.clear()
        await message.answer("Вышел из режима ИИ. Меню внизу 👇", reply_markup=kb.main_menu())
    else:
        await message.answer("Ты не в режиме ИИ.")


@router.message(AIChat.active, F.text)
async def ai_mode_message(message: Message, state: FSMContext, ai):
    if message.text.lower() in ("стоп", "stop", "выход", "отмена"):
        await state.clear()
        await message.answer("Вышел из режима ИИ. Меню внизу 👇", reply_markup=kb.main_menu())
        return
    await _reply_ai(message, ai, message.text)
