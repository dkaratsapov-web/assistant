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

/** Отдаёт находки или бросает исключение с понятным текстом. */
async function searchXmlGet(env: Env, key: string, folder: string, query: string, limit: number): Promise<SearchHit[]> {
  const base = env.YANDEX_SEARCH_URL || DEFAULT_URL;
  const url = `${base}?folderid=${encodeURIComponent(folder)}&query=${encodeURIComponent(query)}&l10n=ru&sortby=rlv&filter=moderate&groupby=${encodeURIComponent("attr=d.mode=deep.groups-on-page=" + limit + ".docs-in-group=1")}`;
  const res = await fetch(url, { headers: { Authorization: `Api-Key ${key}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  const err = body.match(/<error[^>]*>([\s\S]*?)<\/error>/);
  if (err) throw new Error(strip(err[1]).slice(0, 200));
  return parseSearchXml(body, limit);
}

/**
 * Второй способ обращения к поиску Яндекса: POST с JSON, ответ приходит
 * XML-ом в base64. Держим оба, потому что у разных аккаунтов включён разный,
 * а проверить, какой именно, можно только живым запросом.
 */
async function searchJsonPost(env: Env, key: string, folder: string, query: string, limit: number): Promise<SearchHit[]> {
  const url = env.YANDEX_SEARCH_URL_V2 || "https://searchapi.api.cloud.yandex.net/v2/web/search";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Api-Key ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: { searchType: "SEARCH_TYPE_RU", queryText: query },
      folderId: folder,
      responseFormat: "FORMAT_XML",
      groupSpec: { groupsOnPage: String(limit), docsInGroup: "1" },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  let xml = text;
  try {
    const obj = JSON.parse(text) as { rawData?: string };
    if (obj.rawData) xml = decodeBase64(obj.rawData);
  } catch {
    // пришёл не JSON — пробуем разобрать как есть
  }
  const err = xml.match(/<error[^>]*>([\s\S]*?)<\/error>/);
  if (err) throw new Error(strip(err[1]).slice(0, 200));
  return parseSearchXml(xml, limit);
}

/** base64 → текст с поддержкой кириллицы (atob отдаёт байты, не символы). */
export function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Ищет в интернете. Пробует оба способа обращения к API: у разных аккаунтов
 * Яндекса включён разный, и заранее это не выяснить. Если не вышло ни одним —
 * в ошибке будут обе причины, чтобы не гадать, что чинить.
 */
export async function webSearch(env: Env, query: string, limit = 5): Promise<SearchHit[]> {
  const key = searchKey(env);
  const folder = searchFolder(env);
  if (!key || !folder) throw new Error("Поиск не настроен: нужны YANDEX_SEARCH_API_KEY и YANDEX_SEARCH_FOLDER_ID (или общие ключи Яндекса).");
  const order = env.YANDEX_SEARCH_API === "v2" ? [searchJsonPost, searchXmlGet] : [searchXmlGet, searchJsonPost];
  const names = env.YANDEX_SEARCH_API === "v2" ? ["POST-JSON", "XML-GET"] : ["XML-GET", "POST-JSON"];
  const errors: string[] = [];
  for (let i = 0; i < order.length; i++) {
    try {
      return await order[i](env, key, folder, query, limit);
    } catch (e) {
      errors.push(`${names[i]} → ${(e as Error).message}`);
    }
  }
  throw new Error(`Поиск не ответил. ${errors.join(" | ")}`);
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
