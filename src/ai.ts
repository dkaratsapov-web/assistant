/** ИИ-помощник: запрос к Claude API (Anthropic Messages API) через fetch. */

const SYSTEM_PROMPT = `Ты — ИИ-ассистент маркетолога-практика с многолетним стажем. \
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
- Формат — обычный текст (Telegram), без Markdown-таблиц. Списки — через тире или цифры.`;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

export async function askAI(apiKey: string, model: string, prompt: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = (await res.json()) as AnthropicResponse;
    if (!res.ok) {
      return `⚠️ Ошибка ИИ (${res.status}): ${data.error?.message ?? "неизвестная"}`;
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    return text || "ИИ вернул пустой ответ, попробуй переформулировать.";
  } catch (e) {
    return `⚠️ Не удалось связаться с Claude: ${(e as Error).message}`;
  }
}
