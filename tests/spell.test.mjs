/**
 * Проверка орфографии названий.
 *
 * Сеть в тестах не трогаем: подменяем fetch и смотрим, как разбирается ответ
 * Яндекс.Спеллера и работают предохранители. Главный из них — не доверять
 * подсказке, если она не похожа на исправление опечатки: свои названия
 * («Ромашка», «ДиАвто69») словарь не знает и предлагает «похожее».
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spellTitle } from "../.test-build/spell.js";

/** Заглушка сервиса: отдаёт заранее заданные подсказки. */
function fakeSpeller(hits, opts = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (opts.fail) throw new Error("сеть недоступна");
    return {
      ok: opts.status ? opts.status < 400 : true,
      json: async () => (opts.garbage ? { error: "нет" } : hits),
    };
  };
  return calls;
}

/** Позиция слова в тексте — как её считает сервис. */
const hit = (text, word, fix, code = 1) => ({
  code,
  pos: text.indexOf(word),
  len: word.length,
  word,
  s: [fix],
});

test("опечатка исправляется по словарю", async () => {
  const src = "Сделать атчёт для банка";
  fakeSpeller([hit(src, "атчёт", "отчёт")]);
  assert.equal(await spellTitle(src), "Сделать отчёт для банка");
});

test("несколько опечаток в одной фразе", async () => {
  const src = "Праверить цыфры в отчёте";
  fakeSpeller([hit(src, "Праверить", "Проверить"), hit(src, "цыфры", "цифры")]);
  assert.equal(await spellTitle(src), "Проверить цифры в отчёте");
});

test("имя клиента словарю не отдаём", async () => {
  const src = "Отчёт для Ромашки";
  fakeSpeller([hit(src, "Ромашки", "Ромашке")]);
  assert.equal(await spellTitle(src, ["Ромашка"]), "Отчёт для Ромашки");
});

test("чужое слово вместо похожего не подставляем", async () => {
  // Подсказка отличается слишком сильно — это не опечатка, а другое слово
  const src = "Созвон по Пиксибею";
  fakeSpeller([hit(src, "Пиксибею", "пикселю")]);
  assert.equal(await spellTitle(src), "Созвон по Пиксибею");
});

test("имя собственное не в начале не правим", async () => {
  const src = "Встреча с Таллером";
  fakeSpeller([hit(src, "Таллером", "Толлером")]);
  assert.equal(await spellTitle(src), "Встреча с Таллером");
});

test("строчная в начале поправится", async () => {
  const src = "Москва или питер";
  fakeSpeller([hit(src, "питер", "Питер", 3)]);
  assert.equal(await spellTitle(src), "Москва или Питер");
});

test("слово со цифрами и латиницей не трогаем", async () => {
  const src = "Настроить ДиАвто69 и Яндекс Директ";
  fakeSpeller([hit(src, "ДиАвто69", "Диавто69")]);
  assert.equal(await spellTitle(src), "Настроить ДиАвто69 и Яндекс Директ");
});

test("позиция не сошлась — ничего не меняем", async () => {
  // Если сервис отдал сдвинутую позицию, подстановка испортила бы текст
  const src = "Сделать отчёт по рекламе";
  fakeSpeller([{ code: 1, pos: 3, len: 5, word: "атчёт", s: ["отчёт"] }]);
  assert.equal(await spellTitle(src), "Сделать отчёт по рекламе");
});

test("сеть подвела — текст всё равно оформлен", async () => {
  fakeSpeller([], { fail: true });
  assert.equal(await spellTitle("позвонить в банк."), "Позвонить в банк");
});

test("ответ не тем форматом — не падаем", async () => {
  fakeSpeller([], { garbage: true });
  assert.equal(await spellTitle("позвонить в банк"), "Позвонить в банк");
});

test("сервис ответил ошибкой — текст всё равно оформлен", async () => {
  fakeSpeller([], { status: 500 });
  assert.equal(await spellTitle("позвонить в банк"), "Позвонить в банк");
});

test("короткое и нерусское словарю не отправляем", async () => {
  const calls = fakeSpeller([]);
  assert.equal(await spellTitle("зал"), "Зал");
  assert.equal(await spellTitle("CPA report"), "CPA report");
  assert.equal(calls.length, 0, "лишний запрос в сеть");
});

test("пустое остаётся пустым и в сеть не ходит", async () => {
  const calls = fakeSpeller([]);
  assert.equal(await spellTitle(""), "");
  assert.equal(calls.length, 0);
});
