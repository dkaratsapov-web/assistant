/**
 * Проверка самих сценариев, а не только разбора текста.
 *
 * Разборщик может вернуть правильное намерение, а обработчик всё равно изменить
 * не ту запись или промолчать. Поэтому здесь крутится игрушечная база в памяти
 * и проверяется результат: что именно поменялось в задаче или встрече.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { performIntent } from "../.test-build/intent.js";

const TZ = 3;
const iso = (dayOffset, hour = 12) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

/** Минимальная база в памяти: только то, чем пользуется обработчик команд. */
const DEFAULT_PREFS = { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, haptic: true, startTab: "home", hidden: [], callMe: "", botName: "Сара", avatar: "", tone: "friendly", address: "ty", emoji: true, search: true };

function fakeDb({ tasks = [], events = [], clients = [], notes = [] } = {}) {
  const settings = new Map();
  let prefs = null;
  let seq = 100;
  return {
    store: { tasks, events, clients, notes, settings, get prefs() { return prefs; } },
    async listTasks({ statuses = ["open", "in_progress"], visibleTo = null, scope = null, clientId = null } = {}) {
      return tasks.filter(
        (t) =>
          statuses.includes(t.status) &&
          (visibleTo == null || t.creator_id === visibleTo) &&
          (scope == null || t.scope === scope) &&
          (clientId == null || t.client_id === clientId)
      );
    },
    async listEvents(_uid, fromIso) { return events.filter((e) => e.starts_at >= fromIso).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); },
    async listClients() { return clients; },
    async listNotes() { return notes; },
    async findClientByName(_uid, name) { return clients.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null; },
    async setSetting(k, v) { settings.set(k, v); },
    async getPrefs() { return { ...DEFAULT_PREFS, ...(prefs ?? {}) }; },
    async setPrefs(_uid, p) { prefs = p; },
    async getSetting(k) { return settings.get(k) ?? null; },
    async addTask(o) { const t = { id: ++seq, status: "open", scope: o.scope ?? "work", client_id: o.clientId ?? null, due_at: o.dueAt ?? null, creator_id: o.creatorId, title: o.title, repeat_rule: o.repeat ?? "" }; tasks.push(t); return t.id; },
    async updateTask(id, f) {
      const t = tasks.find((x) => x.id === id); if (!t) return;
      if (f.title !== undefined) t.title = f.title;
      if (f.dueAt !== undefined) t.due_at = f.dueAt;
      if (f.scope !== undefined) t.scope = f.scope;
      if (f.clientId !== undefined) t.client_id = f.clientId;
      if (f.repeat !== undefined) t.repeat_rule = f.repeat;
    },
    async setTaskStatus(id, status) { const t = tasks.find((x) => x.id === id); if (!t) return false; t.status = status; t.done_at = status === "done" ? new Date().toISOString() : null; return true; },
    async deleteTask(id) { const i = tasks.findIndex((x) => x.id === id); if (i < 0) return false; tasks.splice(i, 1); return true; },
    async addEvent(o) { const e = { id: ++seq, user_id: o.userId, title: o.title, starts_at: o.startsAt, location: o.location ?? "", client_id: o.clientId ?? null }; events.push(e); return e.id; },
    async updateEvent(id, _uid, f) {
      const e = events.find((x) => x.id === id); if (!e) return false;
      if (f.title !== undefined) e.title = f.title;
      if (f.startsAt !== undefined) e.starts_at = f.startsAt;
      if (f.location !== undefined) e.location = f.location;
      if (f.clientId !== undefined) e.client_id = f.clientId;
      return true;
    },
    async deleteEvent(id) { const i = events.findIndex((x) => x.id === id); if (i < 0) return false; events.splice(i, 1); return true; },
  };
}

const task = (id, title, extra = {}) => ({ id, title, status: "open", scope: "work", client_id: null, due_at: null, creator_id: 1, repeat_rule: "", ...extra });

/* ---------- Отметка выполнения ---------- */

test("«закрой задачу по лендингу» закрывает именно её", async () => {
  const db = fakeDb({ tasks: [task(1, "Сделать лендинг для Ромашки"), task(2, "Позвонить в банк")] });
  const said = await performIntent({ action: "task_done", title: "лендинг" }, db, 1, TZ, "закрой задачу по лендингу");
  assert.match(said, /выполненной/);
  assert.equal(db.store.tasks.find((t) => t.id === 1).status, "done");
  assert.equal(db.store.tasks.find((t) => t.id === 2).status, "open");
});

test("две похожие задачи — переспрашивает и ничего не трогает", async () => {
  const db = fakeDb({ tasks: [task(1, "Отчёт для Ромашки"), task(2, "Отчёт для Лютика")] });
  const said = await performIntent({ action: "task_done", title: "отчёт" }, db, 1, TZ, "закрой задачу про отчёт");
  assert.match(said, /несколько задач/);
  assert.ok(db.store.tasks.every((t) => t.status === "open"), "ни одна задача не должна закрыться");
});

/* ---------- Обновление задачи ---------- */

test("перенос задачи меняет срок, а не создаёт новую", async () => {
  const db = fakeDb({ tasks: [task(1, "Сделать отчёт")] });
  const said = await performIntent({ action: "task_edit", title: "отчёт", due: "завтра" }, db, 1, TZ, "перенеси отчёт на завтра");
  assert.match(said, /Обновила задачу/);
  assert.equal(db.store.tasks.length, 1, "новых задач появиться не должно");
  assert.ok(db.store.tasks[0].due_at, "срок должен появиться");
});

test("переименование и статус применяются", async () => {
  const db = fakeDb({ tasks: [task(1, "Лендинг")] });
  await performIntent({ action: "task_edit", title: "лендинг", new_name: "Лендинг под Директ" }, db, 1, TZ, "переименуй");
  assert.equal(db.store.tasks[0].title, "Лендинг под Директ");
  await performIntent({ action: "task_edit", title: "лендинг", status: "in_progress" }, db, 1, TZ, "взял в работу");
  assert.equal(db.store.tasks[0].status, "in_progress");
});

test("привязка к клиенту и перевод в личные", async () => {
  const db = fakeDb({ tasks: [task(1, "Отчёт")], clients: [{ id: 7, name: "Ромашка" }] });
  await performIntent({ action: "task_edit", title: "отчёт", client: "Ромашка" }, db, 1, TZ, "привяжи задачу по отчёту к Ромашке");
  assert.equal(db.store.tasks[0].client_id, 7);
  await performIntent({ action: "task_edit", title: "отчёт", scope: "personal" }, db, 1, TZ, "сделай личной");
  assert.equal(db.store.tasks[0].scope, "personal");
});

test("несуществующую задачу не трогаем и говорим об этом", async () => {
  const db = fakeDb({ tasks: [task(1, "Отчёт")] });
  const said = await performIntent({ action: "task_edit", title: "молоко", due: "завтра" }, db, 1, TZ, "перенеси задачу про молоко на завтра");
  assert.match(said, /Не нашла/);
  assert.equal(db.store.tasks[0].due_at, null);
});

test("закрытую задачу можно вернуть в работу", async () => {
  // Раньше не работало: правка искала только среди активных задач,
  // а закрытая в этот список не попадала.
  const db = fakeDb({ tasks: [task(1, "Сделать отчёт", { status: "done" })] });
  const said = await performIntent({ action: "task_edit", title: "отчёт", status: "open" }, db, 1, TZ, "верни отчёт в работу");
  assert.match(said, /возвращена в работу/);
  assert.equal(db.store.tasks[0].status, "open");
});

/* ---------- Встречи ---------- */

test("встреча переносится на новое время", async () => {
  const db = fakeDb({ events: [{ id: 5, user_id: 1, title: "Созвон с Ромашкой", starts_at: iso(1, 9), location: "", client_id: null }] });
  const said = await performIntent({ action: "event_edit", title: "Ромашка", at: "завтра 16:00" }, db, 1, TZ, "перенеси встречу с Ромашкой на 16:00");
  assert.match(said, /Обновила встречу/);
  assert.notEqual(db.store.events[0].starts_at, iso(1, 9));
});

/* ---------- Опора на предыдущую реплику ---------- */

test("«перенеси на пятницу» относится к тому, о чём только что говорили", async () => {
  const db = fakeDb({ tasks: [task(1, "Сделать отчёт"), task(2, "Позвонить в банк")] });
  await performIntent({ action: "task_done", title: "отчёт" }, db, 1, TZ, "закрой отчёт");
  await performIntent({ action: "task_edit", title: "отчёт", status: "open" }, db, 1, TZ, "верни в работу");
  // Названия нет — должна взяться задача из предыдущей реплики
  const said = await performIntent({ action: "task_edit", title: "", due: "завтра" }, db, 1, TZ, "перенеси на завтра");
  assert.match(said, /Обновила задачу/);
  assert.ok(db.store.tasks.find((t) => t.id === 1).due_at, "срок должен встать у задачи из прошлой реплики");
  assert.equal(db.store.tasks.find((t) => t.id === 2).due_at, null, "соседнюю задачу трогать нельзя");
});

test("после разговора о встрече «перенеси на 16:00» правит встречу, а не задачу", async () => {
  const db = fakeDb({
    tasks: [task(1, "Сделать отчёт")],
    events: [{ id: 5, user_id: 1, title: "Планёрка", starts_at: iso(1, 9), location: "", client_id: null }],
  });
  await performIntent({ action: "event_edit", title: "планёрка", location: "офис" }, db, 1, TZ, "встреча будет в офисе");
  const said = await performIntent({ action: "task_edit", title: "", due: "завтра 16:00", at: "завтра 16:00" }, db, 1, TZ, "перенеси на 16:00");
  assert.match(said, /Обновила встречу/);
  assert.equal(db.store.tasks[0].due_at, null, "задачу трогать нельзя");
});

/* ---------- Вопросы о своих записях ---------- */

test("«что у меня завтра» отвечает из базы", async () => {
  const db = fakeDb({
    tasks: [task(1, "Отправить смету", { due_at: iso(1, 10) })],
    events: [{ id: 5, user_id: 1, title: "Созвон с Ромашкой", starts_at: iso(1, 9), location: "", client_id: null }],
  });
  const said = await performIntent({ action: "query" }, db, 1, TZ, "что у меня завтра?");
  assert.match(said, /Созвон с Ромашкой/);
  assert.match(said, /Отправить смету/);
});

test("вопрос про клиента показывает только его задачи", async () => {
  const db = fakeDb({
    tasks: [task(1, "Отчёт", { client_id: 7 }), task(2, "Чужая задача", { client_id: 9 })],
    clients: [{ id: 7, name: "Ромашка" }],
  });
  const said = await performIntent({ action: "query", client: "Ромашка" }, db, 1, TZ, "какие задачи по Ромашке?");
  assert.match(said, /Отчёт/);
  assert.doesNotMatch(said, /Чужая задача/);
});

test("«что просрочено» показывает только просроченное", async () => {
  const db = fakeDb({ tasks: [task(1, "Старое дело", { due_at: iso(-3) }), task(2, "Будущее дело", { due_at: iso(5) })] });
  const said = await performIntent({ action: "query" }, db, 1, TZ, "что просрочено?");
  assert.match(said, /Старое дело/);
  assert.doesNotMatch(said, /Будущее дело/);
});

test("пустой день — честный ответ, а не выдуманные дела", async () => {
  const db = fakeDb({});
  const said = await performIntent({ action: "query" }, db, 1, TZ, "что у меня завтра?");
  assert.match(said, /ничего не запланировано/);
});

/* ---------- Настройки приложения словами ---------- */

test("«сделай шрифт крупнее» правда меняет настройку", async () => {
  const db = fakeDb({});
  const said = await performIntent({ action: "prefs" }, db, 1, TZ, "сделай шрифт крупнее");
  assert.match(said, /Размер текста: 110/);
  assert.equal(db.store.prefs.scale, 110);
});

test("тёмная тема и спрятанный раздел сохраняются вместе", async () => {
  const db = fakeDb({});
  await performIntent({ action: "prefs" }, db, 1, TZ, "включи тёмную тему");
  assert.equal(db.store.prefs.theme, "dark");
  await performIntent({ action: "prefs" }, db, 1, TZ, "спрячь раздел здоровье");
  assert.deepEqual(db.store.prefs.hidden, ["health"]);
  assert.equal(db.store.prefs.theme, "dark", "прошлая настройка не должна потеряться");
});

test("шаг размера считается от текущего, а не от стандартного", async () => {
  const db = fakeDb({});
  await performIntent({ action: "prefs" }, db, 1, TZ, "сделай шрифт крупнее");
  await performIntent({ action: "prefs" }, db, 1, TZ, "ещё крупнее шрифт");
  assert.equal(db.store.prefs.scale, 120);
});

test("непонятную настройку не угадываем, а показываем список", async () => {
  const db = fakeDb({});
  const said = await performIntent({ action: "prefs" }, db, 1, TZ, "сделай покрасивее");
  assert.match(said, /Могу поменять/);
  assert.equal(db.store.prefs, null, "ничего меняться не должно");
});
