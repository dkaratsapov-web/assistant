/** ИИ-помощник: запрос к YandexGPT (Yandex Cloud Foundation Models API) через fetch. */

const SYSTEM_PROMPT = `Ты — Сара, персональный ИИ-ассистент владельца (маркетолога). \
Ты полноценный помощник: ведёшь задачи, встречи (календарь), дни рождения и клиентов, \
а также помогаешь по маркетингу.

Специализация владельца: контекстная реклама (Яндекс Директ, Google Ads), \
таргетированная реклама (Telegram Ads, VK Реклама, Авито), разработка сайтов.

Добавление задач, встреч и контактов выполняет система автоматически ДО того, как ты отвечаешь. \
Поэтому если сообщение дошло до тебя — это вопрос или просьба по контенту (тексты, идеи, консультация): \
помоги по существу. ВАЖНО: не утверждай, что «добавила задачу/встречу/контакт» и не выдумывай, что что-то \
сохранила — этим занимается система, а не ты. По маркетингу — пиши тексты объявлений, офферы, идеи, разбирай лендинги.

Правила:
- Отвечай на русском, конкретно и применимо к российским площадкам.
- Учитывай ограничения площадок (лимиты символов Директа, модерацию VK и т.п.), когда уместно.
- Варианты объявлений давай пронумерованными.
- Без воды. Формат — обычный текст, без Markdown-таблиц. Списки — через тире или цифры.`;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

export const DEFAULT_MODEL = "claude-sonnet-5";

/** Роль сообщения в диалоге. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

/** Низкоуровневый вызов Claude (Anthropic Messages API). system-сообщения выносятся отдельно. */
async function complete(
  apiKey: string,
  messages: ChatMessage[],
  model: string,
  temperature: number
): Promise<string> {
  try {
    const system = messages.filter((m) => m.role === "system").map((m) => m.text).join("\n\n");
    const msgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.text }));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 2000, temperature, system, messages: msgs }),
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
    return `⚠️ Не удалось связаться с ИИ: ${(e as Error).message}`;
  }
}

/**
 * Многоходовой диалог с Claude (с историей переписки). System-промпт ассистента
 * добавляется автоматически.
 */
export function askAIChat(apiKey: string, messages: ChatMessage[], model = DEFAULT_MODEL): Promise<string> {
  return complete(apiKey, [{ role: "system", text: SYSTEM_PROMPT }, ...messages], model, 0.6);
}

/** Однократный запрос к Claude (обёртка над askAIChat). */
export function askAI(apiKey: string, prompt: string, model = DEFAULT_MODEL): Promise<string> {
  return askAIChat(apiKey, [{ role: "user", text: prompt }], model);
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
- due: срок в АБСОЛЮТНОМ формате "ГГГГ-ММ-ДД ЧЧ:ММ" (если время не названо — только "ГГГГ-ММ-ДД"). Если срока нет — "".
- scope: "personal" для личного (семья, здоровье, быт, покупки), иначе "work".`;

/** Намерение пользователя, распознанное ассистентом. */
export interface AssistantIntent {
  action: "task" | "event" | "contact" | "client_add" | "client_delete" | "none";
  title?: string;
  due?: string; // срок задачи словами
  at?: string; // время встречи словами
  scope?: "work" | "personal";
  name?: string; // имя контакта / клиента
  birthday?: string; // дата рождения
  location?: string; // место встречи
  platforms?: string; // площадки клиента
  budget?: string; // бюджет клиента
}

const ROUTER_SYSTEM = `Ты — маршрутизатор команд ассистента Сары. По сообщению пользователя определи,
хочет ли он ВЫПОЛНИТЬ действие или просто задать вопрос/попросить текст.
Верни СТРОГО один JSON-объект без пояснений и markdown:
{"action":"task|event|contact|client_add|client_delete|none","title":"","due":"","at":"","scope":"work|personal","name":"","birthday":"","location":"","platforms":"","budget":""}
Правила:
- "task" — добавить задачу, напоминание, дело («напомни», «добавь задачу», «нужно сделать»). title = суть без срока, due = срок.
- "event" — добавить встречу, созвон, событие в календарь («встреча», «созвон», «запланируй»). title = с кем/о чём, at = когда, location = место или "".
- "contact" — добавить контакт/человека или день рождения («запиши др», «добавь контакт»). name = имя, birthday = дата.
- "client_add" — добавить клиента/заказчика/проект («добавь клиента», «новый клиент/проект»). name = название, platforms = площадки/услуги или "", budget = бюджет или "".
- "client_delete" — удалить клиента («удали клиента», «убери клиента»). name = название клиента.
- "none" — вопрос, консультация, просьба написать текст/заголовки/оффер/идеи — всё, что НЕ добавление/удаление записи.
- scope: "personal" для личного (семья, здоровье, быт), иначе "work".
ВАЖНО про даты: все относительные сроки («сегодня», «завтра», «через час», «в пятницу», «в 13 часов», «в обед»)
переведи в АБСОЛЮТНЫЙ формат: due и at → "ГГГГ-ММ-ДД ЧЧ:ММ" (если время не названо — только "ГГГГ-ММ-ДД");
birthday → "ГГГГ-ММ-ДД" или "ММ-ДД". Если срок не указан — пустая строка.

Примеры (при "Сейчас: 2026-07-31 16:00, четверг"):
"Добавь на завтра встречу с клиентом в 13 часов" → {"action":"event","title":"Встреча с клиентом","due":"","at":"2026-08-01 13:00","scope":"work","name":"","birthday":"","location":""}
"напомни в пятницу отправить отчёт" → {"action":"task","title":"Отправить отчёт","due":"2026-08-01 10:00","at":"","scope":"work","name":"","birthday":"","location":""}
"через час позвонить маме" → {"action":"task","title":"Позвонить маме","due":"2026-07-31 17:00","at":"","scope":"personal","name":"","birthday":"","location":""}
"запиши день рождения Иры 15 марта" → {"action":"contact","title":"","due":"","at":"","scope":"personal","name":"Ира","birthday":"03-15","location":"","platforms":"","budget":""}
"добавь клиента Ромашка, Директ и VK, бюджет 100000" → {"action":"client_add","title":"","due":"","at":"","scope":"work","name":"Ромашка","birthday":"","location":"","platforms":"Директ, VK","budget":"100000"}
"удали клиента Ромашка" → {"action":"client_delete","title":"","due":"","at":"","scope":"work","name":"Ромашка","birthday":"","location":"","platforms":"","budget":""}
"напиши 3 заголовка для Директа" → {"action":"none","title":"","due":"","at":"","scope":"work","name":"","birthday":"","location":"","platforms":"","budget":""}

Отвечай ТОЛЬКО одной строкой JSON, без markdown, без \`\`\`, без пояснений.`;

/** Определяет намерение (действие или обычный вопрос). Возвращает null при ошибке разбора. */
export async function routeAssistant(
  apiKey: string,
  text: string,
  nowStr: string,
  model = DEFAULT_MODEL
): Promise<AssistantIntent | null> {
  const raw = await complete(
    apiKey,
    [
      { role: "system", text: `${ROUTER_SYSTEM}\nСейчас: ${nowStr}.` },
      { role: "user", text },
    ],
    model,
    0
  );
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
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
  text: string,
  nowStr: string,
  model = DEFAULT_MODEL
): Promise<ParsedTask | null> {
  const raw = await complete(
    apiKey,
    [
      { role: "system", text: `${TASK_PARSE_SYSTEM}\nСейчас: ${nowStr}.` },
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
