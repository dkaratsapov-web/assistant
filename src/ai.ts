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
  role: "user" | "assistant" | "system";
  text: string;
}

/** Низкоуровневый вызов YandexGPT: messages передаются как есть (включая system). */
async function complete(
  apiKey: string,
  folderId: string,
  messages: ChatMessage[],
  model: string,
  temperature: number
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
        completionOptions: { stream: false, temperature, maxTokens: "2000" },
        messages,
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

/**
 * Многоходовой диалог с YandexGPT (с историей переписки). System-промпт ассистента
 * добавляется автоматически.
 */
export function askAIChat(
  apiKey: string,
  folderId: string,
  messages: ChatMessage[],
  model = "yandexgpt/latest"
): Promise<string> {
  return complete(apiKey, folderId, [{ role: "system", text: SYSTEM_PROMPT }, ...messages], model, 0.6);
}

/** Однократный запрос к YandexGPT (обёртка над askAIChat). */
export function askAI(apiKey: string, folderId: string, prompt: string, model = "yandexgpt/latest"): Promise<string> {
  return askAIChat(apiKey, folderId, [{ role: "user", text: prompt }], model);
}

/** Извлечённая из текста задача. */
export interface ParsedTask {
  title: string;
  due: string; // срок словами ("завтра 15:00") или пусто
  scope: "work" | "personal";
}

const TASK_PARSE_SYSTEM = `Ты — парсер задач. На вход даётся распознанный из голоса текст.
Верни СТРОГО один JSON-объект без пояснений и без markdown:
{"title": "...", "due": "...", "scope": "work|personal"}
Правила:
- title: краткая суть задачи в повелительном наклонении, без упоминания срока.
- due: срок словами как в тексте (например "завтра", "в пятницу 15:00", "25.12 10:00"). Если срока нет — пустая строка "".
- scope: "personal" для личного (семья, здоровье, быт, покупки), иначе "work".`;

/** Пытается извлечь задачу из произвольного текста (напр. распознанного голоса). */
export async function parseTaskFromText(
  apiKey: string,
  folderId: string,
  text: string,
  model = "yandexgpt/latest"
): Promise<ParsedTask | null> {
  const raw = await complete(
    apiKey,
    folderId,
    [
      { role: "system", text: TASK_PARSE_SYSTEM },
      { role: "user", text },
    ],
    model,
    0.2
  );
  // Вырезаем JSON из ответа (на случай code-fence или лишнего текста)
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Partial<ParsedTask>;
    const title = (obj.title ?? "").toString().trim();
    if (!title) return null;
    return {
      title,
      due: (obj.due ?? "").toString().trim(),
      scope: obj.scope === "personal" ? "personal" : "work",
    };
  } catch {
    return null;
  }
}
