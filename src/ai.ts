/**
 * ИИ-помощник: Yandex Foundation Models (YandexGPT) через fetch.
 *
 * Текст  — POST https://llm.api.cloud.yandex.net/foundationModels/v1/completion
 * Фото   — OpenAI-совместимый эндпоинт /v1/chat/completions (нужна мультимодальная
 *          модель из Model Gallery, задаётся переменной YANDEX_VISION_MODEL).
 *
 * Авторизация — тот же API-ключ сервисного аккаунта, что и у SpeechKit
 * (YANDEX_API_KEY + YANDEX_FOLDER_ID), роль `ai.languageModels.user`.
 */
import { Env } from "./types";

const COMPLETION_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";
const OPENAI_URL = "https://llm.api.cloud.yandex.net/v1/chat/completions";

/** Модели по умолчанию (переопределяются переменными окружения). */
export const DEFAULT_MODEL = "yandexgpt/latest";
export const ROUTER_MODEL = "yandexgpt-lite/latest";

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

/** Настройки доступа к YandexGPT — собираются из окружения один раз на запрос. */
export interface AiConfig {
  apiKey: string;
  folderId: string;
  model: string;       // основная модель (диалог, тексты, документы)
  router: string;      // дешёвая модель для служебных задач (разбор команд, калории)
  vision: string;      // мультимодальная модель для фото; "" — фото выключены
}

/** Возвращает конфигурацию ИИ или null, если ключ/каталог не заданы. */
export function aiConfig(env: Env): AiConfig | null {
  if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) return null;
  return {
    apiKey: env.YANDEX_API_KEY,
    folderId: env.YANDEX_FOLDER_ID,
    model: env.YANDEX_GPT_MODEL || DEFAULT_MODEL,
    router: env.YANDEX_GPT_ROUTER_MODEL || ROUTER_MODEL,
    vision: env.YANDEX_VISION_MODEL || "",
  };
}

/** Полный URI модели: короткое имя дополняется каталогом, готовый `gpt://…` берётся как есть. */
function modelUri(cfg: AiConfig, model: string): string {
  return model.includes("://") ? model : `gpt://${cfg.folderId}/${model}`;
}

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

/**
 * Низкоуровневый вызов YandexGPT. Сообщения передаются как есть (включая system).
 * Возвращает текст ответа либо понятное сообщение об ошибке (бот не должен падать).
 */
async function complete(
  cfg: AiConfig,
  messages: ChatMessage[],
  model: string,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  try {
    const res = await fetch(COMPLETION_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Api-Key ${cfg.apiKey}`,
        "x-folder-id": cfg.folderId,
      },
      body: JSON.stringify({
        modelUri: modelUri(cfg, model),
        completionOptions: {
          stream: false,
          temperature: opts.temperature ?? 0.6,
          maxTokens: String(opts.maxTokens ?? 2000),
        },
        messages,
      }),
    });

    const data = (await res.json()) as YandexResponse;
    if (!res.ok) {
      return `⚠️ Ошибка ИИ (${res.status}): ${data.error?.message ?? data.message ?? "неизвестная"}`;
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
export function askAIChat(cfg: AiConfig, messages: ChatMessage[]): Promise<string> {
  return complete(cfg, [{ role: "system", text: SYSTEM_PROMPT }, ...messages], cfg.model);
}

/** Однократный запрос к YandexGPT (обёртка над askAIChat). */
export function askAI(cfg: AiConfig, prompt: string): Promise<string> {
  return askAIChat(cfg, [{ role: "user", text: prompt }]);
}

/** Вырезает JSON-объект из ответа модели (на случай code-fence или лишнего текста). */
function extractJson(raw: string): any | null {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
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
export async function routeAssistant(cfg: AiConfig, text: string, nowStr: string): Promise<AssistantIntent | null> {
  const raw = await complete(
    cfg,
    [
      { role: "system", text: `${ROUTER_SYSTEM}\nСейчас: ${nowStr}.` },
      { role: "user", text },
    ],
    cfg.router,
    { maxTokens: 400, temperature: 0 }
  );
  const obj = extractJson(raw) as AssistantIntent | null;
  return obj && obj.action ? obj : null;
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

/** Приводит ответ модели к Nutrition. */
function toNutrition(o: any, fallbackTitle: string): Nutrition {
  return {
    title: String(o.title || fallbackTitle).slice(0, 120),
    kcal: Math.max(0, Math.round(+o.kcal || 0)),
    protein: Math.max(0, Math.round(+o.protein || 0)),
    fat: Math.max(0, Math.round(+o.fat || 0)),
    carbs: Math.max(0, Math.round(+o.carbs || 0)),
  };
}

/** Оценивает калории и БЖУ по описанию еды. Возвращает null при ошибке. */
export async function estimateNutrition(cfg: AiConfig, text: string): Promise<Nutrition | null> {
  const raw = await complete(
    cfg,
    [
      { role: "system", text: NUTRITION_SYSTEM },
      { role: "user", text },
    ],
    cfg.router,
    { maxTokens: 200, temperature: 0 }
  );
  const o = extractJson(raw);
  return o ? toNutrition(o, text) : null;
}

/** Оценивает сожжённые ккал по описанию активности. Возвращает число или null. */
export async function estimateBurn(cfg: AiConfig, text: string): Promise<number | null> {
  const raw = await complete(
    cfg,
    [
      { role: "system", text: "Оцени, сколько примерно килокалорий сжигает описанная физическая активность (для взрослого ~75 кг). Ответь СТРОГО одним целым числом — только ккал, без слов." },
      { role: "user", text },
    ],
    cfg.router,
    { maxTokens: 20, temperature: 0 }
  );
  const m = raw.match(/\d+/);
  return m ? Math.min(5000, parseInt(m[0], 10)) : null;
}

/** Поддерживается ли разбор фото (задана мультимодальная модель). */
export function visionEnabled(cfg: AiConfig | null): boolean {
  return !!cfg?.vision;
}

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * Оценивает калории/БЖУ по ФОТО еды через OpenAI-совместимый эндпоинт AI Studio.
 * Требует мультимодальной модели (YANDEX_VISION_MODEL); без неё возвращает null.
 */
export async function estimateNutritionFromImage(
  cfg: AiConfig,
  base64: string,
  mediaType: string,
  caption = ""
): Promise<Nutrition | null> {
  if (!cfg.vision) return null;
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Api-Key ${cfg.apiKey}`,
        "x-folder-id": cfg.folderId,
      },
      body: JSON.stringify({
        model: modelUri(cfg, cfg.vision),
        max_tokens: 250,
        temperature: 0,
        messages: [
          { role: "system", content: NUTRITION_SYSTEM },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
              {
                type: "text",
                text:
                  (caption ? `Подпись пользователя: "${caption}". ` : "") +
                  "На фото — еда. Определи блюдо и оцени калорийность и БЖУ ВСЕЙ порции на фото.",
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OpenAiResponse;
    const o = extractJson(data.choices?.[0]?.message?.content ?? "");
    return o ? toNutrition(o, caption || "Блюдо с фото") : null;
  } catch {
    return null;
  }
}

/** Пытается извлечь задачу из произвольного текста (напр. распознанного голоса). */
export async function parseTaskFromText(cfg: AiConfig, text: string, nowStr: string): Promise<ParsedTask | null> {
  const raw = await complete(
    cfg,
    [
      { role: "system", text: `${TASK_PARSE_SYSTEM}\nСейчас: ${nowStr}.` },
      { role: "user", text },
    ],
    cfg.router,
    { maxTokens: 300, temperature: 0 }
  );
  const obj = extractJson(raw) as Partial<ParsedTask> | null;
  const title = (obj?.title ?? "").toString().trim();
  if (!title) return null;
  return {
    title,
    due: (obj?.due ?? "").toString().trim(),
    scope: obj?.scope === "personal" ? "personal" : "work",
  };
}
