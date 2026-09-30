/**
 * Проверка орфографии названий через Яндекс.Спеллер.
 *
 * Почему именно он: словарь русского языка у него настоящий, ключ не нужен,
 * сервис российский — значит доступен и без VPN, в отличие от зарубежных
 * проверялок. Нашу собственную чистку (tidyTitle) он не заменяет, а дополняет:
 * заглавные и знаки расставляем сами, а вот «атчёт» на «отчёт» без словаря не
 * поправить.
 *
 * Правило безопасности: сеть может не ответить или ответить мусором. В этом
 * случае возвращаем текст как есть — лучше запись с опечаткой, чем потерянная
 * запись. Ждём не дольше секунды с небольшим, чтобы постановка задачи голосом
 * не начала подтормаживать.
 */

import { sameWord, tidyTitle } from "./utils";

const ENDPOINT = "https://speller.yandex.net/services/spellservice.json/checkText";
/** 4 — не трогать ссылки, 2 — не трогать числа, 16 — не трогать латиницу, 512 — римские цифры. */
const OPTIONS = 4 + 2 + 16 + 512;
const TIMEOUT_MS = 1200;

type SpellHit = { code: number; pos: number; len: number; word: string; s?: string[] };

/** Сколько правок нужно, чтобы превратить одно слово в другое (с потолком). */
function distance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
    if (Math.min(...cur) > cap) return cap + 1;
  }
  return prev[b.length];
}

/**
 * Стоит ли доверять подсказке.
 *
 * Своё имя клиента, название сервиса или просто редкое слово словарь не знает и
 * предложит «похожее» — от такой помощи название испортится. Поэтому берём
 * подсказку только если она отличается от слова на одну-две буквы (то есть это
 * опечатка, а не другое слово) либо отличается лишь регистром.
 */
function trustworthy(hit: SpellHit, first: boolean, keep: string[]): boolean {
  const word = String(hit.word ?? "");
  const fix = String(hit.s?.[0] ?? "");
  if (!word || !fix || fix === word) return false;
  if (/[0-9_A-Za-z]/.test(word)) return false;
  // Имена собственные словарь не знает: «Ромашка», «ДиАвто» — не трогаем.
  // Кроме первого слова: его с большой буквы пишем мы сами.
  if (!first && /^[А-ЯЁ]/.test(word)) return false;
  // Клиентов и их падежи защищаем отдельно, по основе слова
  if (keep.some((k) => k.split(/\s+/).some((part) => part.length >= 3 && sameWord(part, word)))) return false;
  if (fix.toLowerCase() === word.toLowerCase()) return true;
  if (word.length < 4) return false;
  return distance(word.toLowerCase(), fix.toLowerCase(), 2) <= 2;
}

/**
 * Приводит название к грамотному виду: сначала наша чистка, затем словарь.
 *
 * `keep` — имена, которые править нельзя (клиенты пользователя).
 */
export async function spellTitle(raw: string, keep: string[] = []): Promise<string> {
  const base = tidyTitle(raw);
  // Короткое или нерусское проверять незачем — только лишний запрос
  if (base.length < 5 || !/[а-яё]{4}/i.test(base)) return base;

  let hits: SpellHit[];
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch(`${ENDPOINT}?lang=ru&options=${OPTIONS}&text=${encodeURIComponent(base)}`, {
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return base;
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return base;
    hits = body as SpellHit[];
  } catch {
    // Сеть подвела — отдаём хотя бы аккуратно оформленный текст
    return base;
  }

  // Правим с конца, иначе сдвинутся позиции следующих подсказок
  const sorted = hits
    .filter((h) => h && typeof h.pos === "number" && typeof h.len === "number")
    .sort((a, b) => b.pos - a.pos);

  let out = base;
  for (const hit of sorted) {
    if (!trustworthy(hit, hit.pos === 0, keep)) continue;
    const before = out.slice(0, hit.pos);
    const after = out.slice(hit.pos + hit.len);
    if (out.slice(hit.pos, hit.pos + hit.len) !== hit.word) continue;
    out = `${before}${hit.s![0]}${after}`;
  }
  // После подстановки первая буква могла снова стать строчной
  return tidyTitle(out);
}

/** То же для имени клиента: имя пишем с заглавных, а вот словарю его не доверяем. */
export { tidyName as spellName } from "./utils";
