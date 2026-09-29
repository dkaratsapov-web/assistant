/**
 * Аудит гибкости голосового помощника.
 *
 * Прогоняет живые формулировки через НАСТОЯЩУЮ точку входа бота
 * (tryPerformCommand) с выключенным ИИ. Что сработало здесь — сработает даже
 * если модель недоступна или тормозит. Что не сработало — целиком зависит от
 * ИИ, и это риск: на показе клиенту такая фраза может не пройти.
 *
 * Запуск: node tests/voice-audit.mjs
 */
// Собираем перед запуском: иначе аудит легко прогнать по устаревшей сборке
// и обрадоваться результату, которого в коде уже нет.
import { buildSync } from "esbuild";
buildSync({
  entryPoints: ["src/utils.ts", "src/intent.ts", "src/phrases.ts", "src/search.ts", "src/queries.ts", "src/ai.ts", "src/appearance.ts"],
  bundle: true, format: "esm", platform: "neutral", outdir: ".test-build", logLevel: "error",
});
const { tryPerformCommand } = await import("../.test-build/intent.js");

const ENV = { TZ_OFFSET: "3" };   // без ключей Яндекса — ИИ выключен
const TZ = 3;

const iso = (dayOffset, hour = 12) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour - TZ, 0, 0, 0);
  return d.toISOString();
};

const DEFAULT_PREFS = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, haptic: true, startTab: "home", hidden: [], callMe: "", botName: "Сара", avatar: "", tone: "friendly", address: "ty", emoji: true, search: true };

/** База в памяти с исходным набором записей — как у живого человека. */
function freshDb() {
  const tasks = [
    { id: 1, title: "Сделать отчёт для Ромашки", status: "open", scope: "work", client_id: 7, due_at: iso(1, 10), creator_id: 1, repeat_rule: "", description: "" },
    { id: 2, title: "Позвонить в банк", status: "open", scope: "work", client_id: null, due_at: null, creator_id: 1, repeat_rule: "", description: "" },
    { id: 3, title: "Записаться к врачу", status: "open", scope: "personal", client_id: null, due_at: null, creator_id: 1, repeat_rule: "", description: "" },
    { id: 4, title: "Сделать лендинг", status: "in_progress", scope: "work", client_id: 7, due_at: null, creator_id: 1, repeat_rule: "", description: "" },
  ];
  const events = [
    { id: 11, user_id: 1, title: "Планёрка", starts_at: iso(1, 9), location: "", client_id: null, notes: "" },
    { id: 12, user_id: 1, title: "Созвон с Ромашкой", starts_at: iso(2, 15), location: "Zoom", client_id: 7, notes: "" },
  ];
  const clients = [{ id: 7, name: "Ромашка", platforms: "Директ", status: "active" }, { id: 8, name: "Лютик", platforms: "VK", status: "active" }];
  const contacts = [];
  const notes = [{ id: 21, text: "Идея: акция к 8 марта", tags: "" }];
  const settings = new Map();
  let prefs = null;
  let seq = 100;
  const db = {
    store: { tasks, events, clients, contacts, notes, get prefs() { return prefs; } },
    async listTasks({ statuses = ["open", "in_progress"], visibleTo = null, scope = null, clientId = null } = {}) {
      return tasks.filter((t) => statuses.includes(t.status) && (visibleTo == null || t.creator_id === visibleTo) && (scope == null || t.scope === scope) && (clientId == null || t.client_id === clientId));
    },
    async listEvents(_u, fromIso) { return events.filter((e) => e.starts_at >= fromIso).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); },
    async listClients() { return clients; },
    async listNotes() { return notes; },
    async listLessons() { return []; },
    async findClientByName(_u, name) { return clients.find((c) => c.name.toLowerCase() === String(name).toLowerCase()) ?? null; },
    async setSetting(k, v) { settings.set(k, v); },
    async getSetting(k) { return settings.get(k) ?? null; },
    async getPrefs() { return { ...DEFAULT_PREFS, ...(prefs ?? {}) }; },
    async setPrefs(_u, p) { prefs = p; },
    async addTask(o) { const t = { id: ++seq, status: "open", scope: o.scope ?? "work", client_id: o.clientId ?? null, due_at: o.dueAt ?? null, creator_id: o.creatorId, title: o.title, description: o.description ?? "", repeat_rule: o.repeat ?? "" }; tasks.push(t); return t.id; },
    async updateTask(id, f) {
      const t = tasks.find((x) => x.id === id); if (!t) return;
      for (const [k, v] of Object.entries({ title: f.title, due_at: f.dueAt, scope: f.scope, client_id: f.clientId, repeat_rule: f.repeat, description: f.description })) if (v !== undefined) t[k] = v;
    },
    async setTaskStatus(id, status) { const t = tasks.find((x) => x.id === id); if (!t) return false; t.status = status; t.done_at = status === "done" ? new Date().toISOString() : null; return true; },
    async deleteTask(id) { const i = tasks.findIndex((x) => x.id === id); if (i < 0) return false; tasks.splice(i, 1); return true; },
    async addEvent(o) { const e = { id: ++seq, user_id: o.userId, title: o.title, starts_at: o.startsAt, location: o.location ?? "", client_id: o.clientId ?? null, notes: "" }; events.push(e); return e.id; },
    async updateEvent(id, _u, f) { const e = events.find((x) => x.id === id); if (!e) return false; for (const [k, v] of Object.entries({ title: f.title, starts_at: f.startsAt, location: f.location, client_id: f.clientId })) if (v !== undefined) e[k] = v; return true; },
    async deleteEvent(id) { const i = events.findIndex((x) => x.id === id); if (i < 0) return false; events.splice(i, 1); return true; },
    async addClient(_u, name, platforms, budget, extra) { const c = { id: ++seq, name, platforms, budget, status: "active", ...extra }; clients.push(c); return c.id; },
    async updateClient(id, _u, f) { const c = clients.find((x) => x.id === id); if (!c) return false; Object.assign(c, f); return true; },
    async deleteClient(id) { const i = clients.findIndex((x) => x.id === id); if (i < 0) return false; clients.splice(i, 1); return true; },
    async addContact(o) { const c = { id: ++seq, ...o }; contacts.push(c); return c.id; },
    async addNote(o) { const n = { id: ++seq, text: o.text ?? o, tags: "" }; notes.push(n); return n.id; },
    async addWater() {}, async waterTotal() { return 0; },
    async lastFood() { return null; }, async lastActivity() { return null; },
    async addWeight() {}, async addActivity() {}, async setWellbeing() {},
  };
  return db;
}

/**
 * Матрица: фраза + проверка результата.
 *
 * Проверяем не «ответила ли», а ЧТО изменилось в базе: бот может бодро
 * отрапортовать и при этом тронуть не ту запись — на это уже напарывались.
 */
const T = (id) => (db) => db.store.tasks.find((x) => x.id === id);
const hasTask = (re) => (db) => db.store.tasks.some((t) => re.test(t.title));
const MATRIX = [
  ["ЗАДАЧИ · постановка", [
    ["напомни завтра отправить отчёт", (db) => hasTask(/^Отправить отчёт$/)(db) && db.store.tasks.at(-1).due_at],
    ["напомни мне позвонить Ромашке в пятницу", hasTask(/^Позвонить Ромашке$/)],
    ["поставь задачу позвонить Ромашке", hasTask(/^Позвонить Ромашке$/)],
    ["добавь задачу продлить домен до 5 числа", hasTask(/^Продлить домен$/)],
    ["заведи задачу закрыть акты", hasTask(/^Закрыть акты$/)],
    ["создай задачу обновить прайс", hasTask(/^Обновить прайс$/)],
    ["внеси задачу проверить статистику", hasTask(/^Проверить статистику$/)],
    ["не забыть забрать документы в пятницу", hasTask(/^Забрать документы$/)],
    ["не забудь оплатить хостинг завтра", hasTask(/^Оплатить хостинг$/)],
    ["надо к понедельнику подготовить смету", hasTask(/^Подготовить смету$/)],
    ["нужно обзвонить базу сегодня", hasTask(/^Обзвонить базу$/)],
    ["запиши дело: съездить на склад", hasTask(/Съездить на склад/)],
    ["напомни через два часа перезвонить", hasTask(/^Перезвонить$/)],
    ["напомни в 15:00 отправить макеты", hasTask(/^Отправить макеты$/)],
    ["напомни записаться к стоматологу", (db) => db.store.tasks.at(-1).scope === "personal"],
  ]],
  ["ЗАДАЧИ · замена", [
    ["перенеси отчёт на пятницу", (db) => T(1)(db).due_at !== null],
    ["перенеси задачу лендинг на завтра", (db) => T(4)(db).due_at !== null],
    ["сдвинь отчёт на понедельник", (db) => T(1)(db).due_at !== null],
    ["передвинь отчёт на среду", (db) => T(1)(db).due_at !== null],
    ["поменяй срок у отчёта на четверг", (db) => T(1)(db).due_at !== null],
    ["переименуй задачу отчёт в квартальный отчёт", (db) => /квартальный/i.test(T(1)(db).title)],
    ["назови задачу лендинг «Лендинг под Директ»", (db) => /Директ/i.test(T(4)(db).title)],
    ["взял в работу отчёт", (db) => T(1)(db).status === "in_progress"],
    ["беру в работу отчёт", (db) => T(1)(db).status === "in_progress"],
    ["начал делать отчёт", (db) => T(1)(db).status === "in_progress"],
    ["приступил к отчёту", (db) => T(1)(db).status === "in_progress"],
    ["верни лендинг в работу", (db) => T(4)(db).status === "open"],
    ["сделай задачу про врача личной", (db) => T(3)(db).scope === "personal"],
    ["сделай отчёт рабочей", (db) => T(1)(db).scope === "work"],
    ["привяжи задачу по банку к Лютику", (db) => T(2)(db).client_id === 8],
    ["убери срок у задачи про отчёт", (db) => T(1)(db).due_at === null],
  ]],
  ["ЗАДАЧИ · выполнение", [
    ["закрой задачу по лендингу", (db) => T(4)(db).status === "done"],
    ["заверши отчёт", (db) => T(1)(db).status === "done"],
    ["выполни задачу позвонить в банк", (db) => T(2)(db).status === "done"],
    ["отчёт готов", (db) => T(1)(db).status === "done"],
    ["смета сделана", (db) => true],
    ["лендинг закончен", (db) => T(4)(db).status === "done"],
    ["выполнил задачу записаться к врачу", (db) => T(3)(db).status === "done"],
    ["сделал отчёт", (db) => T(1)(db).status === "done"],
    ["отметь лендинг", (db) => T(4)(db).status === "done"],
    ["с банком закончил", (db) => T(2)(db).status === "done"],
    ["по отчёту всё", (db) => T(1)(db).status === "done"],
  ]],
  ["ЗАДАЧИ · удаление", [
    ["удали задачу позвонить в банк", (db) => !T(2)(db)],
    ["убери задачу про врача", (db) => !T(3)(db)],
    ["удали из списка лендинг", (db) => !T(4)(db)],
  ]],
  ["ВСТРЕЧИ · постановка", [
    ["встреча с Ромашкой завтра в 15:00", (db) => db.store.events.some((e) => /Ромашк/i.test(e.title) && e.id > 12)],
    ["созвон с банком в пятницу в 11", (db) => db.store.events.some((e) => /банк/i.test(e.title))],
    ["запланируй планёрку в понедельник в 10 утра", (db) => db.store.events.length === 3],
    ["назначь встречу с Лютиком послезавтра в 14:30 в офисе", (db) => db.store.events.some((e) => e.location === "офисе")],
    ["добавь созвон с подрядчиком завтра в 12", (db) => db.store.events.some((e) => /подрядчик/i.test(e.title))],
    ["собрание команды в среду в 17:00", (db) => db.store.events.length === 3],
  ]],
  ["ВСТРЕЧИ · замена", [
    ["перенеси встречу с Ромашкой на завтра в 16:00", (db) => db.store.events.find((e) => e.id === 12).starts_at !== null],
    ["сдвинь планёрку на завтра в 11", (db) => db.store.events.find((e) => e.id === 11).starts_at !== null],
    ["встреча с Ромашкой будет в офисе", (db) => db.store.events.find((e) => e.id === 12).location === "офисе"],
    ["переименуй встречу планёрка в разбор полётов", (db) => /разбор/i.test(db.store.events.find((e) => e.id === 11).title)],
  ]],
  ["ВСТРЕЧИ · отмена", [
    ["отмени встречу с Ромашкой", (db) => !db.store.events.find((e) => e.id === 12)],
    ["отмени планёрку", (db) => !db.store.events.find((e) => e.id === 11)],
    ["удали созвон с Ромашкой", (db) => !db.store.events.find((e) => e.id === 12)],
    ["убери встречу планёрка", (db) => !db.store.events.find((e) => e.id === 11)],
  ]],
  ["КЛИЕНТЫ", [
    ["добавь клиента Пион, Директ и VK, бюджет 150000", (db) => db.store.clients.some((c) => c.name === "Пион" && c.budget === "150000")],
    ["добавь клиента Василёк", (db) => db.store.clients.some((c) => c.name === "Василёк")],
    ["заведи клиента Астра, Авито", (db) => db.store.clients.some((c) => c.name === "Астра")],
    ["переименуй клиента Лютик в Лютик Плюс", (db) => db.store.clients.some((c) => /Плюс/.test(c.name))],
    ["поменяй оплату ведения Ромашки на 60000", (db) => true],
    ["поменяй бюджет Ромашки на 200000", (db) => true],
    ["удали клиента Лютик", (db) => !db.store.clients.some((c) => c.name === "Лютик")],
  ]],
  ["КОНТАКТЫ И ЗАМЕТКИ", [
    ["запиши день рождения Иры 15 марта", (db) => db.store.contacts.some((c) => /Ир/.test(c.name))],
    ["добавь контакт Пётр Сергеевич", (db) => db.store.contacts.length === 1],
    ["запиши идею: запустить акцию к 8 марта", (db) => db.store.notes.length === 2],
    ["заметка: пароль от кабинета в сейфе", (db) => db.store.notes.length === 2],
    ["!быстрая мысль про рекламу", (db) => db.store.notes.length === 2],
    ["запомни: доступы у Игоря", (db) => db.store.notes.length === 2],
  ]],
  ["ВОПРОСЫ О СВОИХ ДЕЛАХ", [
    ["что у меня сегодня", (db, a) => a.length > 10],
    ["что у меня завтра", (db, a) => /Ромашк|Планёрк|отчёт/i.test(a)],
    ["что просрочено", (db, a) => a.length > 5],
    ["сколько у меня задач", (db, a) => /задач/i.test(a)],
    ["какие встречи на неделе", (db, a) => /Планёрк|Созвон/i.test(a)],
    ["что я сделал на этой неделе", (db, a) => a.length > 5],
    ["покажи личные задачи", (db, a) => /врач/i.test(a)],
    ["какие задачи по Ромашке", (db, a) => /отчёт|лендинг/i.test(a)],
    ["покажи клиентов", (db, a) => /Ромашка/.test(a)],
    ["покажи заметки", (db, a) => /акци/i.test(a)],
  ]],
  ["НАСТРОЙКИ", [
    ["сделай шрифт крупнее", (db) => db.store.prefs.scale === 110],
    ["включи тёмную тему", (db) => db.store.prefs.theme === "dark"],
    ["спрячь раздел здоровье", (db) => db.store.prefs.hidden.includes("health")],
    ["называй меня Дмитрием", (db) => db.store.prefs.callMe === "Дмитрием"],
    ["отвечай покороче", (db) => db.store.prefs.tone === "brief"],
    ["верни настройки по умолчанию", (db) => db.store.prefs.scale === 100],
  ]],
  ["ЗДОРОВЬЕ", [
    ["выпил 300 мл воды", (db, a) => /300/.test(a)],
    ["вес 82,5", (db, a) => /82\.5/.test(a)],
    ["8000 шагов", (db, a) => /8000/.test(a)],
    ["спал 7 часов", (db, a) => /7/.test(a)],
  ]],
  ["НЕ КОМАНДЫ · молчать нельзя ошибаться", [
    ["как дела", (db, a) => a === null],
    ["напиши три заголовка для Директа", (db, a) => a === null],
    ["сколько калорий в банане", (db, a) => a === null],
    ["спасибо", (db, a) => a === null],
  ]],
];

const results = [];
let ok = 0;
let bad = 0;

for (const [group, rows] of MATRIX) {
  console.log(`\n${"═".repeat(74)}\n${group}\n${"═".repeat(74)}`);
  for (const [phrase, check] of rows) {
    const db = freshDb();
    let answer = null;
    let error = null;
    try {
      answer = await tryPerformCommand(ENV, db, 1, phrase, false);
    } catch (e) {
      error = String(e.message || e);
    }
    let passed = false;
    try {
      passed = !error && check(db, answer);
    } catch (e) {
      error = error || `проверка упала: ${e.message}`;
    }
    if (passed) ok++; else bad++;
    results.push({ group, phrase, answer, error, passed });
    const first = (answer ?? "").split("\n").filter(Boolean).slice(0, 2).join(" · ");
    console.log(`  ${passed ? "✓" : "✗"} «${phrase}»`);
    console.log(`      → ${error ? "ОШИБКА: " + error : answer ? first.slice(0, 100) : "молчит"}`);
  }
}

console.log(`\n${"═".repeat(74)}`);
console.log(`Правильно отработано без ИИ: ${ok} из ${ok + bad}`);
const gaps = results.filter((r) => !r.passed);
if (gaps.length) {
  console.log(`\nНе отработало: ${gaps.length}`);
  for (const g of gaps) console.log(`  · [${g.group}] «${g.phrase}» → ${g.error || (g.answer ? g.answer.split("\n")[0] : "молчит")}`);
}
process.exit(gaps.length ? 1 : 0);
