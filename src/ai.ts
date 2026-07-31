/** ИИ-помощник: запрос к YandexGPT (Yandex Cloud Foundation Models API) через fetch. */

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

interface YandexResponse {
  result?: {
    alternatives?: { message?: { role?: string; text?: string }; status?: string }[];
  };
  // формат ошибки Yandex Cloud
  error?: { message?: string };
  message?: string;
  code?: number;
}

/** Роль сообщения в диалоге. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Многоходовой диалог с YandexGPT (с историей переписки).
 * @param apiKey   API-ключ сервисного аккаунта (роль ai.languageModels.user). Секрет.
 * @param folderId Идентификатор каталога Yandex Cloud.
 * @param messages История диалога (без system — он добавляется автоматически).
 * @param model    Имя модели, напр. "yandexgpt/latest" или "yandexgpt-lite/latest".
 */
export async function askAIChat(
  apiKey: string,
  folderId: string,
  messages: ChatMessage[],
  model = "yandexgpt/latest"
): Promise<string> {
  try {
    const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Api-Key ${apiKey}`,
        "x-folder-id": folderId,
      },
      body: JSON.stringify({
        modelUri: `gpt://${folderId}/${model}`,
        completionOptions: { stream: false, temperature: 0.6, maxTokens: "2000" },
        messages: [{ role: "system", text: SYSTEM_PROMPT }, ...messages],
      }),
    });

    const data = (await res.json()) as YandexResponse;
    if (!res.ok) {
      const msg = data.error?.message ?? data.message ?? "неизвестная";
      return `⚠️ Ошибка ИИ (${res.status}): ${msg}`;
    }
    const text = (data.result?.alternatives ?? [])
      .map((a) => a.message?.text ?? "")
      .join("\n")
      .trim();
    return text || "ИИ вернул пустой ответ, попробуй переформулировать.";
  } catch (e) {
    return `⚠️ Не удалось связаться с YandexGPT: ${(e as Error).message}`;
  }
}

/** Однократный запрос к YandexGPT (обёртка над askAIChat). */
export function askAI(apiKey: string, folderId: string, prompt: string, model = "yandexgpt/latest"): Promise<string> {
  return askAIChat(apiKey, folderId, [{ role: "user", text: prompt }], model);
}
