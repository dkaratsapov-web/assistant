/**
 * Регрессия на разбор русского текста.
 *
 * Ловушка, из-за которой эти проверки существуют: в JavaScript \b и \w считают
 * буквами только латиницу, поэтому /\bвес\b/ или /задач\w*\s+/ на кириллице молча
 * не срабатывают. Шаблоны с русскими словами должны пользоваться границами из utils.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseDue, matchWaterMl, mealFromText, wordRe, parseRepeat, nextDue, repeatLabel, keyWords, matchScore, bestMatch, stripClientName, splitWhen, guessScope } from "../.test-build/utils.js";
import { localRoute, looksLikeFoodText, mentionedClient, parseCorrection } from "../.test-build/intent.js";
import { PHRASES, pickExamples, pickLessons, renderExamples } from "../.test-build/phrases.js";
import { needsSearch, parseSearchXml, renderHits, decodeBase64 } from "../.test-build/search.js";
import { parseQuery } from "../.test-build/queries.js";
import { extractIntents } from "../.test-build/ai.js";
import { parseAppearance } from "../.test-build/appearance.js";
import { parseRpcBody, pickTool, fitArgs } from "../.test-build/yougile.js";

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
  const ACTIONS = new Set(["task", "task_done", "task_delete", "task_edit", "event", "event_edit", "query", "event_delete", "contact", "client_add", "client_delete", "client_edit", "note_add", "none"]);
  assert.ok(PHRASES.length >= 30, "примеров должно быть достаточно для подсказки");
  const seen = new Set();
  for (const p of PHRASES) {
    const obj = JSON.parse(p.json);                       // разбор не должен падать
    assert.ok(ACTIONS.has(obj.action), `неизвестное действие: ${obj.action} в «${p.text}»`);
    // Правка без названия — законный случай: «перенеси на пятницу» относится
    // к тому, о чём говорили в прошлой реплике, и названия в ней нет.
    const mayOmitTitle = obj.action === "task_edit" || obj.action === "event_edit";
    if (obj.action !== "none" && !mayOmitTitle) assert.ok(obj.title || obj.name, `пример без названия: «${p.text}»`);
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

test("правило повтора читается из фразы", () => {
  assert.equal(parseRepeat("платить за хостинг каждый месяц"), "monthly");
  assert.equal(parseRepeat("каждый день пить витамины"), "daily");
  assert.equal(parseRepeat("по будням планёрка в 10"), "weekdays");
  assert.equal(parseRepeat("каждый вторник созвон"), "w:2");
  assert.equal(parseRepeat("каждую среду отчёт"), "w:3");
  assert.equal(parseRepeat("каждую неделю подводить итоги"), "weekly");
  assert.equal(parseRepeat("еженедельно смотреть метрику"), "weekly");
  // разовые задачи правил не получают
  assert.equal(parseRepeat("позвонить в банк завтра"), "");
  assert.equal(parseRepeat("купить каждому подарок"), "");
});

test("следующий срок повтора считается верно", () => {
  const TZ3 = 3;
  const at = (iso) => nextDue.bind(null, iso);
  // среда 2026-09-30 10:00 по Москве = 07:00 UTC
  const wed = "2026-09-30T07:00:00.000Z";
  assert.equal(nextDue("daily", wed, TZ3), "2026-10-01T07:00:00.000Z");
  assert.equal(nextDue("weekly", wed, TZ3), "2026-10-07T07:00:00.000Z");
  assert.equal(nextDue("w:1", wed, TZ3), "2026-10-05T07:00:00.000Z", "со среды до понедельника — пять дней");
  assert.equal(nextDue("w:3", wed, TZ3), "2026-10-07T07:00:00.000Z", "тот же день недели — значит через неделю");
  // пятница по будням прыгает через выходные
  const fri = "2026-10-02T07:00:00.000Z";
  assert.equal(nextDue("weekdays", fri, TZ3), "2026-10-05T07:00:00.000Z");
  // конец месяца не должен уезжать: 31 января + месяц = 28 февраля
  assert.equal(nextDue("monthly", "2026-01-31T07:00:00.000Z", TZ3).slice(0, 10), "2026-02-28");
  // время дня сохраняется
  assert.ok(nextDue("daily", wed, TZ3).endsWith("07:00:00.000Z"));
  // мусор не ломает
  assert.equal(nextDue("", wed, TZ3), null);
  assert.equal(nextDue("непонятно", wed, TZ3), null);
  assert.equal(nextDue("daily", "не дата", TZ3), null);
});

test("правило повтора подписывается по-русски", () => {
  assert.equal(repeatLabel("daily"), "каждый день");
  assert.equal(repeatLabel("weekdays"), "по будням");
  assert.equal(repeatLabel("w:2"), "каждый вторник");
  assert.equal(repeatLabel("w:3"), "каждую среду");
  assert.equal(repeatLabel(""), "");
});

/* ---------- Поиск задачи по словам человека ---------- */

const T = (id, title) => ({ id, title });

test("служебные слова вокруг названия отбрасываются", () => {
  assert.deepEqual(keyWords("закрой задачу про отчёт"), ["отчет"]);
  assert.deepEqual(keyWords("перенеси встречу с Ромашкой"), ["ромашкой"]);
  assert.deepEqual(keyWords("отметь выполненной"), []);
});

test("задача находится по одному слову из названия", () => {
  const tasks = [T(1, "Сделать отчёт для Ромашки"), T(2, "Позвонить в банк")];
  assert.equal(bestMatch(tasks, (t) => t.title, "закрой задачу про отчёт").best.id, 1);
  assert.equal(bestMatch(tasks, (t) => t.title, "отчёт готов").best.id, 1);
  assert.equal(bestMatch(tasks, (t) => t.title, "позвонил в банк").best.id, 2);
});

test("падеж не мешает: «по Ромашке» находит «для Ромашки»", () => {
  const tasks = [T(1, "Отчёт для Ромашки"), T(2, "Счёт для Лютика")];
  assert.equal(bestMatch(tasks, (t) => t.title, "перенеси задачу по Ромашке").best.id, 1);
});

test("ё и е считаются одной буквой", () => {
  const tasks = [T(1, "Сделать отчет")];
  assert.equal(bestMatch(tasks, (t) => t.title, "отчёт сделал").best.id, 1);
});

test("две одинаково подходящие задачи — не угадываем, а переспрашиваем", () => {
  const tasks = [T(1, "Отчёт для Ромашки"), T(2, "Отчёт для Лютика")];
  const r = bestMatch(tasks, (t) => t.title, "закрой задачу про отчёт");
  assert.equal(r.best, null);
  assert.equal(r.rivals.length, 2);
});

test("более точное совпадение побеждает частичное", () => {
  const tasks = [T(1, "Отчёт для Ромашки"), T(2, "Отчётность за квартал")];
  assert.equal(bestMatch(tasks, (t) => t.title, "отчёт для Ромашки готов").best.id, 1);
});

test("ничего похожего — пустой результат, а не случайная задача", () => {
  const tasks = [T(1, "Позвонить в банк")];
  assert.equal(bestMatch(tasks, (t) => t.title, "купить молоко").best, null);
  assert.equal(matchScore("Позвонить в банк", keyWords("купить молоко")), 0);
});

/* ---------- Команды по задачам без обращения к ИИ ---------- */

test("«закрой задачу …» понимается без ИИ", () => {
  assert.deepEqual(localRoute("Закрой задачу по лендингу"), { action: "task_done", title: "по лендингу" });
  assert.deepEqual(localRoute("заверши отчёт"), { action: "task_done", title: "отчёт" });
});

test("«перенеси … на …» понимается без ИИ", () => {
  assert.deepEqual(localRoute("перенеси задачу отчёт на пятницу"), { action: "task_edit", title: "отчёт", due: "пятницу" });
});

test("«переименуй … в …» понимается без ИИ", () => {
  assert.deepEqual(localRoute("переименуй задачу отчёт в квартальный отчёт"),
    { action: "task_edit", title: "отчёт", new_name: "квартальный отчёт" });
});

test("«взял в работу …» понимается без ИИ", () => {
  assert.deepEqual(localRoute("взял в работу лендинг"), { action: "task_edit", title: "лендинг", status: "in_progress" });
  assert.deepEqual(localRoute("начал делать смету"), { action: "task_edit", title: "смету", status: "in_progress" });
});

test("обычная фраза не превращается в команду", () => {
  assert.equal(localRoute("что у меня на сегодня"), null);
  assert.equal(localRoute("напиши три заголовка для Директа"), null);
});

test("в базе формулировок есть примеры на изменение задачи", () => {
  const edits = PHRASES.filter((p) => p.json.includes('"task_edit"'));
  assert.ok(edits.length >= 8, `примеров task_edit мало: ${edits.length}`);
  assert.ok(edits.some((p) => p.text.includes("перенеси")));
  assert.ok(edits.some((p) => p.json.includes("in_progress")));
});

/* ---------- Вопросы о своих записях ---------- */

test("вопрос о повестке распознаётся с периодом", () => {
  assert.equal(parseQuery("что у меня сегодня?").kind, "agenda");
  assert.equal(parseQuery("что у меня сегодня?").period, "today");
  assert.equal(parseQuery("что у меня завтра").period, "tomorrow");
  assert.equal(parseQuery("что на этой неделе").period, "week");
});

test("вопрос про задачи, встречи, клиентов и заметки различается", () => {
  assert.equal(parseQuery("покажи задачи").kind, "tasks");
  assert.equal(parseQuery("какие встречи завтра").kind, "events");
  assert.equal(parseQuery("покажи клиентов").kind, "clients");
  assert.equal(parseQuery("покажи заметки").kind, "notes");
  assert.equal(parseQuery("что я сделал на этой неделе").kind, "stats");
});

test("просроченное узнаётся по разным словам", () => {
  assert.equal(parseQuery("что просрочено").period, "overdue");
  assert.equal(parseQuery("что горит?").period, "overdue");
});

test("личное и рабочее разделяются", () => {
  assert.equal(parseQuery("какие у меня личные задачи").scope, "personal");
  assert.equal(parseQuery("покажи рабочие задачи").scope, "work");
});

test("команда не принимается за вопрос", () => {
  assert.equal(parseQuery("закрой задачу про отчёт"), null);
  assert.equal(parseQuery("напомни завтра позвонить в банк"), null);
  assert.equal(parseQuery("встреча с Ромашкой завтра в 15:00"), null);
  assert.equal(parseQuery("добавь задачу отчёт"), null);
});

test("вопрос без слова-признака всё равно ловится по знаку вопроса", () => {
  assert.equal(parseQuery("задачи по Ромашке?").kind, "tasks");
});

test("force разбирает даже без признака вопроса — когда вопрос уже опознал ИИ", () => {
  assert.equal(parseQuery("мои задачи на завтра", true).kind, "tasks");
  assert.equal(parseQuery("мои задачи на завтра", true).period, "tomorrow");
});

/* ---------- Несколько дел в одной фразе ---------- */

test("массив намерений разбирается целиком", () => {
  const raw = '[{"action":"event","title":"Созвон"},{"action":"task","title":"Смета"}]';
  const got = extractIntents(raw);
  assert.equal(got.length, 2);
  assert.equal(got[0].action, "event");
  assert.equal(got[1].title, "Смета");
});

test("одиночный объект по-прежнему работает", () => {
  const got = extractIntents('{"action":"task","title":"Отчёт"}');
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "Отчёт");
});

test("обёртка markdown не мешает", () => {
  const got = extractIntents('```json\n[{"action":"task","title":"Раз"},{"action":"task","title":"Два"}]\n```');
  assert.equal(got.length, 2);
});

test("мусор и пустой ответ не роняют разбор", () => {
  assert.deepEqual(extractIntents("не понял"), []);
  assert.deepEqual(extractIntents(""), []);
  assert.deepEqual(extractIntents('[{"нет":"действия"}]'), []);
});

/* ---------- Настройки приложения словами ---------- */

const PREFS = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, haptic: true, startTab: "home", hidden: [], callMe: "", botName: "Сара", avatar: "", tone: "friendly", address: "ty", emoji: true, search: true };
const ap = (text, cur = PREFS) => parseAppearance(text, cur);

test("размер текста меняется шагом и точным числом", () => {
  assert.equal(ap("сделай шрифт крупнее").changes.scale, 110);
  assert.equal(ap("уменьши шрифт").changes.scale, 90);
  assert.equal(ap("поставь масштаб 130").changes.scale, 130);
  assert.equal(ap("сделай текст побольше", { ...PREFS, scale: 135 }).changes.scale, 140, "выше предела не уходим");
});

test("тема переключается", () => {
  assert.equal(ap("включи тёмную тему").changes.theme, "dark");
  assert.equal(ap("сделай светлый фон").changes.theme, "light");
  assert.equal(ap("тема как в системе").changes.theme, "auto");
});

test("плотность, картинки, углы", () => {
  assert.equal(ap("сделай просторнее").changes.density, "roomy");
  assert.equal(ap("сделай компактнее").changes.density, "compact");
  assert.equal(ap("картинки покрупнее").changes.images, "large");
  assert.equal(ap("сделай углы круглее").changes.corners, "soft");
});

test("анимации и вибрация выключаются", () => {
  assert.equal(ap("отключи анимации").changes.motion, false);
  assert.equal(ap("включи анимации").changes.motion, true);
  assert.equal(ap("убери вибрацию").changes.haptic, false);
});

test("стартовый экран и разделы меню", () => {
  assert.equal(ap("открывай сразу задачи").changes.startTab, "tasks");
  assert.deepEqual(ap("спрячь раздел здоровье").changes.hidden, ["health"]);
  assert.deepEqual(ap("верни раздел здоровье", { ...PREFS, hidden: ["health"] }).changes.hidden, []);
  assert.equal(ap("спрячь раздел главная"), null, "без главной приложение осиротеет");
});

test("обращение, имя и манера", () => {
  assert.equal(ap("называй меня Дмитрием").changes.callMe, "Дмитрием");
  assert.equal(ap("обращайся на вы").changes.address, "vy");
  assert.equal(ap("тебя зовут Аня").changes.botName, "Аня");
  assert.equal(ap("отвечай покороче").changes.tone, "brief");
  assert.equal(ap("говори по-деловому").changes.tone, "business");
  assert.equal(ap("не используй эмодзи").changes.emoji, false);
});

test("сброс возвращает стандартный вид", () => {
  const r = ap("верни настройки по умолчанию");
  assert.equal(r.changes.scale, 100);
  assert.equal(r.changes.theme, "auto");
  assert.deepEqual(r.changes.hidden, []);
});

test("обычные фразы настройки НЕ меняют", () => {
  // Каждая строка — реальная ловушка, а не выдуманная
  assert.equal(ap("напомни на выходных полить цветы"), null, "«на выходных» — не «на вы»");
  assert.equal(ap("перенеси на тысячу рублей"), null, "«на тысячу» — не «на ты»");
  assert.equal(ap("напомни про уборку в субботу"), null, "«уборку» — не «компактно»");
  assert.equal(ap("короче, напомни завтра позвонить"), null, "«короче» — слово-паразит");
  assert.equal(ap("найди в интернете погоду в Сочи"), null, "это поиск, а не настройка поиска");
  assert.equal(ap("я свободен в пятницу"), null);
  assert.equal(ap("переходи к следующей задаче"), null, "«переход» — не анимации");
  assert.equal(ap("называй меня по имени"), null, "«по» — не имя");
  assert.equal(ap("закрой задачу про отчёт"), null);
  assert.equal(ap("что у меня завтра"), null);
});

test("несколько настроек одной фразой", () => {
  const r = ap("сделай тёмную тему и шрифт крупнее");
  assert.equal(r.changes.theme, "dark");
  assert.equal(r.changes.scale, 110);
  assert.equal(r.said.length, 2);
});

/* ---------- Второй способ обращения к поиску (ответ в base64) ---------- */

test("кириллица из base64 не превращается в кракозябры", () => {
  // Ловушка: atob отдаёт БАЙТЫ, а не символы. Без пересборки через TextDecoder
  // «Погода в Сочи» приходит как «ÐÐ¾Ð³Ð¾Ð´Ð°».
  const xml = "<doc><url>https://ya.ru</url><title>Погода в Сочи</title><headline>Сегодня +22</headline></doc>";
  const b64 = Buffer.from(xml, "utf8").toString("base64");
  const back = decodeBase64(b64);
  assert.equal(back, xml);
  const hits = parseSearchXml(back, 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Погода в Сочи");
});

test("переносы строк внутри base64 не мешают", () => {
  const xml = "<doc><url>https://ya.ru</url><title>Тест</title></doc>";
  const b64 = Buffer.from(xml, "utf8").toString("base64").replace(/(.{10})/g, "$1\n");
  assert.equal(decodeBase64(b64), xml);
});

/* ---------- Имя клиента не дублируется в названии ---------- */

test("имя клиента убирается вместе с предлогом и словом «клиент»", () => {
  assert.equal(stripClientName("Встреча с клиентом Глобал стекло", "Глобал Стекло"), "Встреча");
  assert.equal(stripClientName("Встреча с Ромашкой", "Ромашка"), "Встреча");
  assert.equal(stripClientName("Созвон с клиентом ДиАвто69", "ДиАвто69"), "Созвон");
});

test("имя в любом падеже и в середине фразы", () => {
  assert.equal(stripClientName("По школа Дмитровский связаться узнать что решили по сайту", "Школа Дмитровский"),
    "Связаться узнать что решили по сайту");
  assert.equal(stripClientName("Отправить смету для Ромашки", "Ромашка"), "Отправить смету");
  assert.equal(stripClientName("Подготовить отчёт по Лютику", "Лютик"), "Подготовить отчёт");
});

test("чужие слова не трогаем", () => {
  assert.equal(stripClientName("Инфа по сайту", "Глобал Стекло"), "Инфа по сайту");
  assert.equal(stripClientName("Позвонить в банк", "Ромашка"), "Позвонить в банк");
});

test("имя без предлога — это объект действия, его оставляем", () => {
  // «Позвонить Ромашке» без имени превращается в бессмысленное «Позвонить»
  assert.equal(stripClientName("Позвонить Ромашке", "Ромашка"), "Позвонить Ромашке");
  assert.equal(stripClientName("Напомнить Лютику про акты", "Лютик"), "Напомнить Лютику про акты");
});

test("если от названия ничего не остаётся — оставляем как было", () => {
  assert.equal(stripClientName("Ромашка", "Ромашка"), "Ромашка");
  assert.equal(stripClientName("Глобал Стекло", "Глобал Стекло"), "Глобал Стекло");
});

test("короткое или пустое имя клиента ничего не ломает", () => {
  assert.equal(stripClientName("Встреча с АП", "АП"), "Встреча с АП");
  assert.equal(stripClientName("Встреча", ""), "Встреча");
});

/* ---------- MCP: разбор ответа и подбор инструмента ---------- */

test("обычный JSON-ответ разбирается", () => {
  const got = parseRpcBody('{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}', 3);
  assert.deepEqual(got.result, { tools: [] });
});

test("ответ потоком событий разбирается", () => {
  // Спецификация разрешает серверу отвечать потоком, и клиент обязан это понимать
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"create_task"}]}}',
    "",
  ].join("\n");
  const got = parseRpcBody(body, 3);
  assert.equal(got.result.tools[0].name, "create_task");
});

test("служебные строки потока не мешают", () => {
  const body = [": ping", "event: message", 'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}', "data: [DONE]"].join("\n");
  assert.equal(parseRpcBody(body, 7).result.ok, true);
});

test("мусор и пустое тело не роняют разбор", () => {
  assert.equal(parseRpcBody("", 1), null);
  assert.equal(parseRpcBody("не json", 1), null);
});

test("инструмент подбирается по словам в имени", () => {
  const tools = [{ name: "list_projects" }, { name: "create_task" }, { name: "create_task_comment" }];
  assert.equal(pickTool(tools, ["create", "task"]).name, "create_task", "берём самое короткое подходящее");
  assert.equal(pickTool(tools, ["project"]).name, "list_projects");
  assert.equal(pickTool(tools, ["нет", "такого"]), null);
});

test("аргументы подгоняются под объявленные сервером поля", () => {
  const tool = { name: "create_task", inputSchema: { properties: { name: {}, deadline: {} } } };
  const args = fitArgs(tool, { title: ["title", "name"], due: ["dueDate", "deadline"] }, { title: "Отчёт", due: "2026-10-01" });
  assert.deepEqual(args, { name: "Отчёт", deadline: "2026-10-01" });
});

test("чего сервер не объявил — того не шлём", () => {
  const tool = { name: "create_task", inputSchema: { properties: { title: {} } } };
  const args = fitArgs(tool, { title: ["title"], due: ["deadline"] }, { title: "Отчёт", due: "2026-10-01" });
  assert.deepEqual(args, { title: "Отчёт" }, "лишнее поле сервер отверг бы целиком");
});
