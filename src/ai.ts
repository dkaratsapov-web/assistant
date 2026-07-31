/** ИИ-помощник: запрос к YandexGPT (Yandex Cloud Foundation Models API) через fetch. */

const SYSTEM_PROMPT = `Ты — Сара, персональный ИИ-ассистент владельца (маркетолога). \
Ты полноценный помощник: ведёшь задачи, встречи (календарь), дни рождения и клиентов, \
а также помогаешь по маркетингу.

Специализация владельца: контекстная реклама (Яндекс Директ, Google Ads), \
таргетированная реклама (Telegram Ads, VK Реклама, Авито), разработка сайтов.

Ты — умный универсальный ассистент: отвечай на ЛЮБЫЕ вопросы (как обычный ИИ-помощник) — \
код, тексты, объяснения, идеи, расчёты, бытовые и рабочие вопросы. Маркетинг — твоя сильная сторона, \
но ты не ограничена им.

Добавление задач, встреч и контактов выполняет система автоматически ДО того, как ты отвечаешь. \
Поэтому если сообщение дошло до тебя — это вопрос или просьба по контенту: помоги по существу. \
ВАЖНО: не утверждай, что «добавила задачу/встречу/контакт» и не выдумывай, что что-то сохранила — \
этим занимается система, а не ты.

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
// Дешёвая модель для служебных задач (распознавание команд, парсинг) — экономит расход
export const ROUTER_MODEL = "claude-haiku-4-5-20251001";

/** Роль сообщения в диалоге. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * Низкоуровневый вызов Claude (Anthropic Messages API).
 * system-сообщения выносятся отдельно; первый (большой статичный) промпт кешируется
 * (prompt caching) — это резко снижает расход на повторных запросах.
 */
async function complete(
  apiKey: string,
  messages: ChatMessage[],
  model: string,
  maxTokens = 1500
): Promise<string> {
  try {
    const systemMsgs = messages.filter((m) => m.role === "system");
    const system = systemMsgs.map((m, i) =>
      i === 0
        ? { type: "text", text: m.text, cache_control: { type: "ephemeral" } }
        : { type: "text", text: m.text }
    );
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
      // temperature намеренно не передаём: модели Claude 5 его не принимают
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: msgs }),
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
  return complete(apiKey, [{ role: "system", text: SYSTEM_PROMPT }, ...messages], model);
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
  action:
    | "task" | "task_done" | "task_delete"
    | "event" | "event_delete"
    | "contact"
    | "client_add" | "client_delete" | "client_edit"
    | "note_add"
    | "none";
  title?: string;
  due?: string; // срок задачи словами
  at?: string; // время встречи словами
  scope?: "work" | "personal";
  name?: string; // имя контакта / клиента
  new_name?: string; // новое имя (переименование клиента)
  birthday?: string; // дата рождения
  location?: string; // место встречи
  platforms?: string; // площадки клиента
  budget?: string; // бюджет клиента
  fee?: string; // сумма оплаты за ведение
  pay_due?: string; // дедлайн оплаты ведения
}

const ROUTER_SYSTEM = `Ты — маршрутизатор команд ассистента Сары. По сообщению пользователя определи,
хочет ли он ВЫПОЛНИТЬ действие или просто задать вопрос/попросить текст.
Верни СТРОГО один JSON-объект без пояснений и markdown:
{"action":"task|task_done|task_delete|event|event_delete|contact|client_add|client_delete|client_edit|note_add|none","title":"","due":"","at":"","scope":"work|personal","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
ГЛАВНОЕ РАЗЛИЧЕНИЕ:
- Если пользователь просит СДЕЛАТЬ/ВЫПОЛНИТЬ работу ПРЯМО СЕЙЧАС — проанализировать, написать, составить, придумать,
  дать план/совет/идеи, «действуй как…», «помоги мне…» — это НЕ задача, это "none" (Сара ответит сама).
- "task" ставим ТОЛЬКО когда есть явный сигнал «напомнить/запланировать/внести в список дел на потом»:
  слова «напомни», «добавь задачу», «поставь задачу», «не забыть», «надо сделать к <дате>», указан конкретный срок.
  Просьба выполнить действие сейчас, даже в повелительном наклонении («проанализируй», «составь», «сделай контент-план») — это "none".

Правила:
- "task" — добавить задачу/напоминание/дело на потом («напомни», «добавь задачу», «поставь задачу», «к пятнице надо…»). title = суть без срока, due = срок. НЕ используй для просьб выполнить работу сейчас.
- "task_done" — отметить задачу выполненной («выполнил», «сделал», «задача … готова», «отметь … выполненной»). title = о какой задаче.
- "task_delete" — удалить задачу («удали задачу …», «убери задачу …»). title = о какой задаче.
- "event" — добавить встречу/созвон/событие («встреча», «созвон», «запланируй»). title = с кем/о чём, at = когда, location = место или "".
- "event_delete" — отменить/удалить встречу («отмени встречу …», «удали созвон …»). title = о какой встрече.
- "contact" — добавить контакт/человека или день рождения («запиши др», «добавь контакт»). name = имя, birthday = дата.
- "client_add" — добавить клиента/заказчика/проект. name = название, platforms = площадки/услуги или "", budget = рекл. бюджет или "", fee = сумма за ведение или "", pay_due = дедлайн оплаты (напр. «5 число») или "".
- "client_delete" — удалить клиента. name = название клиента.
- "client_edit" — переименовать/изменить клиента («переименуй клиента X в Y», «поменяй оплату ведения …», «оплата до 5 числа»). name = текущее название, new_name = новое (если переименование), platforms/budget/fee/pay_due — если меняются.
- "note_add" — сохранить заметку/идею («запиши идею», «заметка: …», «запомни, что …»). title = текст заметки.
- "none" — вопрос, консультация, просьба написать текст/заголовки/оффер/идеи — всё, что НЕ операция с записями.
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
"удали клиента Ромашка" → {"action":"client_delete","title":"","due":"","at":"","scope":"work","name":"Ромашка","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"переименуй клиента Ромашка в Лютик" → {"action":"client_edit","title":"","due":"","at":"","scope":"work","name":"Ромашка","new_name":"Лютик","birthday":"","location":"","platforms":"","budget":""}
"я позвонил клиенту, отметь задачу выполненной" → {"action":"task_done","title":"позвонить клиенту","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"удали задачу про отчёт" → {"action":"task_delete","title":"отчёт","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"отмени встречу с клиентом" → {"action":"event_delete","title":"встреча с клиентом","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"запиши идею: запустить акцию к 8 марта" → {"action":"note_add","title":"запустить акцию к 8 марта","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"напиши 3 заголовка для Директа" → {"action":"none","title":"","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"действуй как СММ, проанализируй тренды 2026 и дай контент-план для Telegram" → {"action":"none","title":"","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"составь контент-план на неделю" → {"action":"none","title":"","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}
"помоги придумать оффер для лендинга" → {"action":"none","title":"","due":"","at":"","scope":"work","name":"","new_name":"","birthday":"","location":"","platforms":"","budget":""}

Отвечай ТОЛЬКО одной строкой JSON, без markdown, без \`\`\`, без пояснений.`;

/** Определяет намерение (действие или обычный вопрос). Возвращает null при ошибке разбора. */
export async function routeAssistant(
  apiKey: string,
  text: string,
  nowStr: string,
  model = ROUTER_MODEL
): Promise<AssistantIntent | null> {
  const raw = await complete(
    apiKey,
    [
      { role: "system", text: ROUTER_SYSTEM }, // статичный — кешируется
      { role: "system", text: `Сейчас: ${nowStr}.` },
      { role: "user", text },
    ],
    model,
    400
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

export interface Nutrition {
  title: string;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
}

const NUTRITION_SYSTEM = `Ты — нутрициолог. По описанию съеденного оцени калорийность и БЖУ ВСЕЙ ПОРЦИИ (не на 100 г). \
Если размер порции не указан — прими обычную бытовую порцию. Ответь СТРОГО одним JSON без пояснений и markdown: \
{"title":"кратко что съедено","kcal":целое,"protein":целое,"fat":целое,"carbs":целое}. \
kcal — ккал всей еды; protein/fat/carbs — граммы. Только реалистичные числа. Только JSON.`;

/** Оценивает калории и БЖУ по описанию еды. Возвращает null при ошибке. */
export async function estimateNutrition(apiKey: string, text: string, model = ROUTER_MODEL): Promise<Nutrition | null> {
  const raw = await complete(
    apiKey,
    [
      { role: "system", text: NUTRITION_SYSTEM },
      { role: "user", text },
    ],
    model,
    200
  );
  const match = raw.replace(/```json/gi, "").replace(/```/g, "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[0]);
    return {
      title: String(o.title || text).slice(0, 120),
      kcal: Math.max(0, Math.round(+o.kcal || 0)),
      protein: Math.max(0, Math.round(+o.protein || 0)),
      fat: Math.max(0, Math.round(+o.fat || 0)),
      carbs: Math.max(0, Math.round(+o.carbs || 0)),
    };
  } catch {
    return null;
  }
}

/** Пытается извлечь задачу из произвольного текста (напр. распознанного голоса). */
export async function parseTaskFromText(
  apiKey: string,
  text: string,
  nowStr: string,
  model = ROUTER_MODEL
): Promise<ParsedTask | null> {
  const raw = await complete(
    apiKey,
    [
      { role: "system", text: TASK_PARSE_SYSTEM }, // статичный — кешируется
      { role: "system", text: `Сейчас: ${nowStr}.` },
      { role: "user", text },
    ],
    model,
    300
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
