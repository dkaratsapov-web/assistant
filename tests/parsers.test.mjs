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
import { localRoute, looksLikeFoodText, mentionedClient, parseCorrection } from "../.test-build/intent.js";
import { PHRASES, pickExamples, pickLessons, renderExamples } from "../.test-build/phrases.js";
import { needsSearch, parseSearchXml, renderHits } from "../.test-build/search.js";

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

test("база формулировок цела и согласована с кодом", () => {
  const ACTIONS = new Set(["task", "task_done", "task_delete", "event", "event_delete", "contact", "client_add", "client_delete", "client_edit", "note_add", "none"]);
  assert.ok(PHRASES.length >= 30, "примеров должно быть достаточно для подсказки");
  const seen = new Set();
  for (const p of PHRASES) {
    const obj = JSON.parse(p.json);                       // разбор не должен падать
    assert.ok(ACTIONS.has(obj.action), `неизвестное действие: ${obj.action} в «${p.text}»`);
    if (obj.action !== "none") assert.ok(obj.title || obj.name, `пример без названия: «${p.text}»`);
    assert.ok(!seen.has(p.text), `повтор примера: «${p.text}»`);
    seen.add(p.text);
  }
  // действия, ради которых база и нужна, должны быть покрыты
  const covered = new Set(PHRASES.map((p) => JSON.parse(p.json).action));
  for (const a of ["task", "task_done", "event", "client_add", "note_add", "none"]) {
    assert.ok(covered.has(a), `в базе нет ни одного примера для «${a}»`);
  }
});

test("к фразе подбираются примеры по смыслу", () => {
  const forEvent = pickExamples("встреча с айпапа в пятницу в 12").map((p) => JSON.parse(p.json).action);
  assert.ok(forEvent.includes("event"), "для встречи не нашлось примера встречи");
  const forFood = pickExamples("добавь в еду гречку с курицей").map((p) => p.text);
  assert.ok(forFood.some((t) => /в еду|рацион|калори/i.test(t)), "для еды не нашлось примера про еду");
  // «не команда» подмешивается всегда — иначе модель всё считает задачей
  for (const q of ["напомни завтра позвонить", "встреча в среду", "удали клиента Ромашка"]) {
    const acts = pickExamples(q).map((p) => JSON.parse(p.json).action);
    assert.ok(acts.includes("none"), `для «${q}» не добавлен пример «не команда»`);
  }
  // подсказка не должна распухать
  assert.ok(pickExamples("напомни завтра позвонить в банк", 6).length <= 6);
});

test("примеры про еду не спорят с локальным разбором", () => {
  // Если база говорит «это еда» — гейт тоже обязан так считать, иначе фраза
  // уйдёт в маршрутизатор и снова станет задачей.
  const foodPhrases = PHRASES.filter((p) => /в еду|рацион|калори|съел/i.test(p.text)).map((p) => p.text);
  assert.ok(foodPhrases.length >= 3);
  for (const t of foodPhrases) assert.equal(looksLikeFoodText(t), true, `гейт не признал едой: «${t}»`);
});

test("поправка человека распознаётся, а обычные фразы — нет", () => {
  // человек поправляет Сару
  assert.equal(parseCorrection("не то, это еда"), "food");
  assert.equal(parseCorrection("нет, это была встреча"), "event");
  assert.equal(parseCorrection("это заметка"), "note");
  assert.equal(parseCorrection("неправильно, это задача"), "task");
  assert.equal(parseCorrection("я имел в виду воду"), "water");
  // а это обычные сообщения, их принимать за поправку нельзя
  assert.equal(parseCorrection("не забудь купить еду"), null);
  assert.equal(parseCorrection("встреча с клиентом завтра"), null);
  assert.equal(parseCorrection("добавь в еду рис"), null);
  assert.equal(parseCorrection("это интересная идея, распиши её подробнее и предложи варианты"), null);
  assert.equal(parseCorrection(""), null);
});

test("личные уроки подмешиваются в подсказку раньше общих примеров", () => {
  const lessons = [{ phrase: "накинь 200 риса", action: "food" }, { phrase: "созвон с подрядчиком", action: "event" }];
  const out = renderExamples("накинь 200 риса и котлету", 6, lessons);
  assert.ok(out.includes("уже поправлял тебя"), "нет блока с личными уроками");
  assert.ok(out.indexOf("накинь 200 риса") < out.indexOf("Похожие примеры"), "уроки должны идти перед общими примерами");
  // без уроков блока быть не должно
  assert.ok(!renderExamples("напомни позвонить", 6, []).includes("уже поправлял"));
  // похожий урок выбирается точнее случайного
  assert.equal(pickLessons("накинь 200 риса", lessons, 1)[0].phrase, "накинь 200 риса");
});

test("в интернет идём только когда это правда нужно", () => {
  // свежие факты — да
  assert.equal(needsSearch("кто выиграл Олимпию в 2026 году?"), true);
  assert.equal(needsSearch("какой сейчас курс доллара"), true);
  assert.equal(needsSearch("что пишут про новый закон о рекламе"), true);
  assert.equal(needsSearch("погугли расписание матчей"), true);
  assert.equal(needsSearch("найди в интернете отзывы о сервисе"), true);
  // про свои дела — никогда, это личные данные
  assert.equal(needsSearch("какие у меня задачи на сегодня"), false);
  assert.equal(needsSearch("напомни завтра позвонить в банк"), false);
  assert.equal(needsSearch("сколько я съел калорий сегодня"), false);
  // просьбы сочинить — тоже мимо, модель справится сама
  assert.equal(needsSearch("придумай пять заголовков"), false);
  assert.equal(needsSearch("привет"), false);
});

test("ответ поиска разбирается в выдержки", () => {
  const xml = `<yandexsearch><response><results><grouping>
    <group><doc>
      <url>https://example.com/a</url>
      <title>Заголовок <hlword>раз</hlword></title>
      <passages><passage>Первая <hlword>выдержка</hlword> текста.</passage></passages>
    </doc></group>
    <group><doc>
      <url>https://example.com/b</url>
      <title>Второй</title>
      <headline>Описание второго</headline>
    </doc></group>
  </grouping></results></response></yandexsearch>`;
  const hits = parseSearchXml(xml, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, "https://example.com/a");
  assert.equal(hits[0].title, "Заголовок раз", "подсветка должна убираться из заголовка");
  assert.equal(hits[0].snippet, "Первая выдержка текста.");
  assert.equal(hits[1].snippet, "Описание второго", "если нет выдержки — берём описание");
  // мусор не должен ронять разбор
  assert.deepEqual(parseSearchXml("", 5), []);
  assert.deepEqual(parseSearchXml("<yandexsearch></yandexsearch>", 5), []);
});

test("найденное уходит в подсказку со ссылками", () => {
  const out = renderHits([{ title: "Т", url: "https://e.com/x", snippet: "С" }], "2026-09-27 18:00, суббота");
  assert.ok(out.includes("https://e.com/x"), "источник должен быть в подсказке");
  assert.ok(/не придумывай/i.test(out), "модель надо прямо просить не выдумывать");
  assert.equal(renderHits([], "сейчас"), "", "без находок подсказка пустая");
});
