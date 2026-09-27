/**
 * Поиск в интернете для ответов на вопросы о свежем.
 *
 * Своего доступа в сеть у YandexGPT нет: модель отвечает только тем, что
 * запомнила при обучении. Поэтому на вопросы вроде «кто выиграл турнир» она
 * честно отказывается. Здесь мы сами приносим ей выдержки из поиска, а она
 * отвечает уже по ним и называет источники.
 *
 * Провайдер — Yandex Search API. Ключ и адрес вынесены в переменные окружения:
 * если у API поменяется адрес или формат, это правится настройкой, а не кодом.
 */
import { DB } from "./db";
import { Env } from "./types";
import { nowContext, tzOffsetOf } from "./utils";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_URL = "https://yandex.ru/search/xml";

/** Ключ поиска: отдельный, если задан, иначе общий ключ Яндекса. */
export function searchKey(env: Env): string {
  return env.YANDEX_SEARCH_API_KEY || env.YANDEX_API_KEY || "";
}

export function searchFolder(env: Env): string {
  return env.YANDEX_SEARCH_FOLDER_ID || env.YANDEX_FOLDER_ID || "";
}

/** Настроен ли поиск. Без ключа Сара просто отвечает как раньше. */
export function searchConfigured(env: Env): boolean {
  return !!searchKey(env) && !!searchFolder(env) && env.WEB_SEARCH !== "off";
}

/**
 * Нужны ли для ответа свежие факты.
 *
 * Дешёвая проверка словами вместо лишнего обращения к модели: явная просьба
 * поискать — всегда да; вопрос о новостях, ценах, погоде, событиях и о том,
 * «кто/когда/сколько» вместе с приметой времени — тоже.
 */
export function needsSearch(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length < 5) return false;
  // прямая просьба
  if (/(погугл|загугл|поищ[иь]|найди\s+в\s+интернет|поиск\s+в\s+интернет|посмотри\s+в\s+интернет|что\s+пишут)/i.test(t)) return true;
  // о личных данных в интернет не ходим: это про бота, а не про мир
  if (/(мои|моя|мои[хм]|у меня|мне нужно|напомни|задач|встреч|календар|вес |калори|съел)/i.test(t)) return false;

  const fresh = /(сегодня|сейчас|вчера|на этой неделе|в этом году|последн|свеж|новост|актуальн|курс\s|погод|расписани|афиш|вышел|выйдет|релиз|обновлени|цена|стоит|сколько стоит|202\d|203\d)/i.test(t);
  const question = /(^|\s)(кто|что|где|когда|как|какой|какая|какие|сколько|почему|зачем)\s/i.test(t) || t.endsWith("?");
  const proper = /(чемпионат|турнир|олимпи|выбор|матч|компани|курс валют|биткоин|акци|закон|налог)/i.test(t);
  return (fresh && question) || (fresh && proper) || (question && proper);
}

/** Достаёт из XML-ответа поиска первые находки. */
export function parseSearchXml(xml: string, limit = 5): SearchHit[] {
  const hits: SearchHit[] = [];
  const docs = xml.match(/<doc>[\s\S]*?<\/doc>/g) ?? [];
  for (const doc of docs) {
    if (hits.length >= limit) break;
    const url = pick(doc, "url");
    if (!url) continue;
    const title = strip(pick(doc, "title"));
    // выдержка лежит либо в passage, либо в headline
    const passages = doc.match(/<passage>[\s\S]*?<\/passage>/g) ?? [];
    const snippet = strip(passages.map((p) => p.replace(/<\/?passage>/g, "")).join(" ") || pick(doc, "headline"));
    hits.push({ title: title || url, url, snippet: snippet.slice(0, 400) });
  }
  return hits;
}

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}

/** Убирает разметку подсветки и расшифровывает сущности. */
function strip(s: string): string {
  return s
    .replace(/<\/?hlword>/g, "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ищет в интернете. Бросает исключение с понятным текстом, если не вышло. */
export async function webSearch(env: Env, query: string, limit = 5): Promise<SearchHit[]> {
  const key = searchKey(env);
  const folder = searchFolder(env);
  if (!key || !folder) throw new Error("Поиск не настроен: нужны YANDEX_SEARCH_API_KEY и YANDEX_SEARCH_FOLDER_ID (или общие ключи Яндекса).");
  const base = env.YANDEX_SEARCH_URL || DEFAULT_URL;
  const url = `${base}?folderid=${encodeURIComponent(folder)}&query=${encodeURIComponent(query)}&l10n=ru&sortby=rlv&filter=moderate&groupby=${encodeURIComponent("attr=d.mode=deep.groups-on-page=" + limit + ".docs-in-group=1")}`;
  const res = await fetch(url, { headers: { Authorization: `Api-Key ${key}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Поиск ответил ${res.status}: ${body.slice(0, 200)}`);
  const err = body.match(/<error[^>]*>([\s\S]*?)<\/error>/);
  if (err) throw new Error(`Поиск отказал: ${strip(err[1]).slice(0, 200)}`);
  return parseSearchXml(body, limit);
}

/** Собирает найденное в кусок подсказки для модели. */
export function renderHits(hits: SearchHit[], nowStr: string): string {
  if (!hits.length) return "";
  const lines = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\nИсточник: ${h.url}`);
  return (
    `Ниже — выдержки из интернета на ${nowStr}. Отвечай по ним, а не по памяти.\n` +
    `Если в выдержках ответа нет — так и скажи, не придумывай.\n` +
    `В конце ответа перечисли использованные источники ссылками.\n\n${lines.join("\n\n")}`
  );
}

/**
 * Ищет в интернете, если вопрос того требует и поиск включён. Возвращает готовый
 * кусок подсказки или пустую строку. Ошибку поиска не роняем наружу: лучше
 * ответить без интернета, чем не ответить вовсе.
 */
export async function lookupWeb(env: Env, db: DB, uid: number, question: string): Promise<string> {
  if (!searchConfigured(env)) return "";
  const prefs = await db.getPrefs(uid);
  if (!prefs.search) return "";
  if (!needsSearch(question)) return "";
  try {
    const hits = await webSearch(env, question, 5);
    if (!hits.length) return "";
    return renderHits(hits, nowContext(tzOffsetOf(env)));
  } catch (e) {
    await db.setSetting("search_error", `${new Date().toISOString()} ${String((e as Error).message).slice(0, 300)}`);
    return "";
  }
}
