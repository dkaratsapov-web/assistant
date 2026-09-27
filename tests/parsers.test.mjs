/**
 * Регрессия на разбор русского текста.
 *
 * Ловушка, из-за которой эти проверки существуют: в JavaScript \b и \w считают
 * буквами только латиницу, поэтому /\bвес\b/ или /задач\w*\s+/ на кириллице молча
 * не срабатывают. Шаблоны с русскими словами должны пользоваться границами из utils.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseDue, matchWaterMl, mealFromText, wordRe } from "../.test-build/utils.js";
import { localRoute, looksLikeFoodText, mentionedClient } from "../.test-build/intent.js";

const TZ = 3;
/** Локальные часы/минуты из UTC-строки — чтобы проверять время без привязки к дате. */
const localHM = (iso) => {
  const d = new Date(new Date(iso).getTime() + TZ * 3600_000);
  return [d.getUTCHours(), d.getUTCMinutes()];
};

test("дедлайн словами разбирается", () => {
  for (const phrase of ["завтра", "в пятницу", "через 3 дня", "через час", "15 марта", "15.03 14:00"]) {
    assert.ok(parseDue(phrase, TZ), `не разобрано: ${phrase}`);
  }
});

test("время суток и часы попадают в результат", () => {
  assert.deepEqual(localHM(parseDue("в 13 часов", TZ)), [13, 0]);
  assert.deepEqual(localHM(parseDue("к 18 часам", TZ)), [18, 0]);
  assert.deepEqual(localHM(parseDue("в 9 утра", TZ)), [9, 0]);
  assert.deepEqual(localHM(parseDue("завтра в 15:00", TZ)), [15, 0]);
  assert.deepEqual(localHM(parseDue("утром", TZ)), [9, 0]);
  assert.deepEqual(localHM(parseDue("вечером", TZ)), [19, 0]);
  assert.deepEqual(localHM(parseDue("в обед", TZ)), [13, 0]);
});

test("дата с названием месяца не теряется", () => {
  const iso = parseDue("15 марта в 14:00", TZ);
  const d = new Date(new Date(iso).getTime() + TZ * 3600_000);
  assert.equal(d.getUTCMonth(), 2, "должен быть март");
  assert.equal(d.getUTCDate(), 15);
  assert.deepEqual(localHM(iso), [14, 0]);
});

test("вода: объём и быстрые формы", () => {
  assert.equal(matchWaterMl("выпил 300 мл"), 300);
  assert.equal(matchWaterMl("выпила стакан воды"), 250);
  assert.equal(matchWaterMl("+вода"), 250);
  assert.equal(matchWaterMl("купить молока"), null, "не про воду — не считаем");
});

test("приём пищи определяется по словам", () => {
  assert.equal(mealFromText("съел на завтрак кашу"), "breakfast");
  assert.equal(mealFromText("поужинал"), "dinner");
  assert.equal(mealFromText("перекусил яблоком"), "snack");
});

test("локальные команды понимают русские окончания", () => {
  assert.equal(localRoute("удали задачу отчёт")?.action, "task_delete");
  assert.equal(localRoute("удали задачу отчёт")?.title, "отчёт");
  assert.equal(localRoute("удали клиента Ромашка")?.name, "Ромашка");
  assert.equal(localRoute("сделала отчёт")?.action, "task_done");
  assert.equal(localRoute("выполнил задачу позвонить")?.title, "позвонить", "слово «задачу» не должно попадать в название");
  assert.equal(localRoute("!идея")?.action, "note_add");
});

test("границы слова знают кириллицу", () => {
  assert.ok(wordRe("зал").test("сходил в зал"));
  assert.ok(wordRe("зал").test("зал 40 минут"));
  assert.equal(wordRe("зал").test("оказался"), false, "внутри слова совпадать не должно");
});

test("«добавь в еду …» — это еда, а не задача", () => {
  // Из жизни: «добавь в еду - 200 гр риса и 1 куриная котлета» заводилось задачей,
  // потому что распознавались только «съел», «на обед» и подобные слова.
  assert.equal(looksLikeFoodText("добавь в еду - 200 гр риса и 1 куриная котлета"), true);
  assert.equal(looksLikeFoodText("запиши в еду овсянку"), true);
  assert.equal(looksLikeFoodText("посчитай калории: борщ и хлеб"), true);
  assert.equal(looksLikeFoodText("съел борщ"), true);
  assert.equal(looksLikeFoodText("на обед котлета с рисом"), true);
  // а это не еда
  assert.equal(looksLikeFoodText("добавь задачу купить рис"), false);
  assert.equal(looksLikeFoodText("встреча с клиентом в обед"), false);
  assert.equal(looksLikeFoodText("напомни купить еду"), false);
});

test("клиент узнаётся в тексте по своему имени", () => {
  const names = [{ id: 7, name: "АйПапа" }, { id: 9, name: "Ромашка" }];
  assert.equal(mentionedClient(names, "встреча с айпапа завтра в 13:00")?.id, 7);
  assert.equal(mentionedClient(names, "Встреча с АйПапа")?.id, 7);
  assert.equal(mentionedClient(names, "отправить счёт ромашке")?.id, 9);
  assert.equal(mentionedClient(names, "встреча с клиентом"), null);
  // слишком короткие имена не ловим — иначе «АП» найдётся в любом слове
  assert.equal(mentionedClient([{ id: 1, name: "АП" }], "напомни про апрель"), null);
});
