"""Интеграция с Claude API для маркетинговой ИИ-помощи."""
from __future__ import annotations

import anthropic

SYSTEM_PROMPT = """Ты — ИИ-ассистент маркетолога-практика с многолетним стажем. \
Специализация владельца: контекстная реклама (Яндекс Директ, Google Ads), \
таргетированная реклама (Telegram Ads, VK Реклама, Авито), а также разработка сайтов.

Твоя задача — помогать быстро и по делу: писать тексты объявлений и заголовков, \
предлагать офферы и УТП, генерировать идеи для кампаний, структурировать посадочные \
страницы, разбирать возражения и отвечать на маркетинговые вопросы.

Правила:
- Отвечай на русском, конкретно и применимо к российским площадкам.
- Учитывай ограничения площадок (лимиты символов Директа, модерацию VK и т.п.), когда это уместно.
- Если пишешь варианты объявлений — давай несколько вариантов, пронумерованных.
- Без воды и общих фраз. Сразу полезное.
- Формат — обычный текст (Telegram), без Markdown-таблиц. Списки — через тире или цифры."""


class AIClient:
    def __init__(self, api_key: str, model: str):
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._model = model

    async def ask(self, prompt: str, context: str | None = None) -> str:
        """Одиночный запрос к Claude. Возвращает текст ответа."""
        user_content = prompt
        if context:
            user_content = f"{context}\n\n{prompt}"
        try:
            response = await self._client.messages.create(
                model=self._model,
                max_tokens=2000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_content}],
            )
        except anthropic.APIStatusError as exc:
            return f"⚠️ Ошибка ИИ ({exc.status_code}): {exc.message}"
        except anthropic.APIConnectionError:
            return "⚠️ Не удалось связаться с Claude. Проверь сеть и повтори."
        except Exception as exc:  # на всякий случай, чтобы бот не падал
            return f"⚠️ Непредвиденная ошибка ИИ: {exc}"

        parts = [block.text for block in response.content if block.type == "text"]
        return "\n".join(parts).strip() or "ИИ вернул пустой ответ, попробуй переформулировать."
