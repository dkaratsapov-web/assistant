/** ИИ-помощник: запрос к YandexGPT (Yandex Cloud Foundation Models API) через fetch. */

const SYSTEM_PROMPT = `Ты — Сара, персональный ИИ-ассистент владельца (маркетолога). \
Ты полноценный помощник: ведёшь задачи, встречи (календарь), дни рождения и клиентов, \
а также помогаешь по маркетингу.

Специализация владельца: контекстная реклама (Яндекс Директ, Google Ads), \
таргетированная реклама (Telegram Ads, VK Реклама, Авито), разработка сайтов.

Ты умеешь по просьбе добавлять задачи, встречи и контакты — система выполняет это \
автоматически, поэтому НИКОГДА не отказывайся со словами «я не умею добавлять в календарь». \
Если пользователь просит что-то запланировать/напомнить/записать — считай, что это уже сделано, \
и коротко подтверди. По маркетингу — пиши тексты объявлений, офферы, идеи, разбирай лендинги.

Правила:
- Отвечай на русском, конкретно и применимо к российским площадкам.
- Учитывай ограничения площадок (лимиты символов Директа, модерацию VK и т.п.), когда уместно.
- Варианты объявлений давай пронумерованными.
- Без воды. Формат — обычный текст, без Markdown-таблиц. Списки — через тире или цифры.`;

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

/** Намерение пользователя, распознанное ассистентом. */
export interface AssistantIntent {
  action: "task" | "event" | "contact" | "none";
  title?: string;
  due?: string; // срок задачи словами
  at?: string; // время встречи словами
  scope?: "work" | "personal";
  name?: string; // имя контакта
  birthday?: string; // дата рождения
  location?: string; // место встречи
}

const ROUTER_SYSTEM = `Ты — маршрутизатор команд ассистента Сары. По сообщению пользователя определи,
хочет ли он ВЫПОЛНИТЬ действие или просто задать вопрос/попросить текст.
Верни СТРОГО один JSON-объект без пояснений и markdown:
{"action":"task|event|contact|none","title":"","due":"","at":"","scope":"work|personal","name":"","birthday":"","location":""}
Правила:
- "task" — добавить задачу, напоминание, дело («напомни», «добавь задачу», «нужно сделать»). title = суть без срока, due = срок словами или "".
- "event" — добавить встречу, созвон, событие в календарь («встреча», «созвон», «запланируй»). title = с кем/о чём, at = когда словами, location = место или "".
- "contact" — добавить контакт или день рождения («запиши др», «добавь контакт»). name = имя, birthday = дата (ГГГГ-ММ-ДД, ММ-ДД или словами).
- "none" — если это вопрос, консультация, просьба написать текст/заголовки/оффер/идеи — всё, что НЕ добавление задачи/встречи/контакта.
- scope: "personal" для личного (семья, здоровье, быт), иначе "work".
Верни только JSON.`;

/** Определяет намерение (действие или обычный вопрос). Возвращает null при ошибке разбора. */
export async function routeAssistant(
  apiKey: string,
  folderId: string,
  text: string,
  model = "yandexgpt/latest"
): Promise<AssistantIntent | null> {
  const raw = await complete(
    apiKey,
    folderId,
    [
      { role: "system", text: ROUTER_SYSTEM },
      { role: "user", text },
    ],
    model,
    0
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as AssistantIntent;
    if (!obj || !obj.action) return null;
    return obj;
  } catch {
    return null;
  }
}

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
