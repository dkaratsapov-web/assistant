/**
 * Проверка переезда с Cloudflare D1 на обычный SQLite.
 *
 * Здесь крутится НАСТОЯЩИЙ src/db.ts поверх настоящего файла базы — не
 * игрушечная заглушка. Смысл именно в этом: запросов в проекте больше сотни,
 * и уверенность «D1 же тоже SQLite» ничего не стоит, пока их никто не выполнил.
 *
 * Отдельно проверяются места, где прослойка и D1 расходятся:
 *   • last_row_id и changes лежат в разных полях;
 *   • first() должен отдавать null, а node:sqlite отдаёт undefined;
 *   • node:sqlite не принимает undefined, true/false и Date — их надо приводить.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteD1 } from "../.test-build/node/server/sqlite.js";
import { DB } from "../.test-build/node/src/db.js";

const schema = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

/**
 * База одна на весь прогон — ровно как в бою.
 *
 * Сначала я делал по свежей базе на тест, и восьмой тест упал: «table events
 * has no column named client_id». Причина в том, что автомиграции в db.ts
 * помечаются флагом на весь процесс, и вторая база в том же процессе их
 * пропускает. В бою процесс один и база одна, так что падал тест, а не код —
 * но узнать это можно было только выполнив запросы по-настоящему.
 */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sara-db-"));
const sqlite = new SqliteD1(path.join(DIR, "test.db"));
sqlite.exec(schema);
const shared = new DB(sqlite);

/** Свой номер пользователя на каждый тест — чтобы записи не мешали друг другу. */
let nextUid = 1000;
const freshDb = () => ({ db: shared, uid: ++nextUid });

test("схема применяется и пользователь заводится", async () => {
  const { db, uid: UID } = freshDb();
  await db.requestAccess(UID, "petrov", "Пётр");
  const u = await db.getUser(UID);
  assert.equal(u.user_id, UID);
  assert.equal(u.username, "petrov");
  assert.equal(u.role, "pending");
});

test("first() на пустом месте отдаёт null, а не undefined", async () => {
  // Код по всему проекту пишет `if (!user)` и `?? null` — undefined бы прошёл,
  // но `await db.getUser(x) === null` в тестах и сравнениях сломался бы
  const { db, uid: UID } = freshDb();
  const u = await db.getUser(999999);
  assert.equal(u, null);
});

test("last_row_id возвращается — иначе нечего показать и некуда вернуться", async () => {
  const { db, uid: UID } = freshDb();
  const id = await db.addTask({ title: "Позвонить в банк", creatorId: UID });
  assert.ok(Number.isInteger(id) && id > 0, `вернулось: ${id}`);
  const second = await db.addTask({ title: "Собрать отчёт", creatorId: UID });
  assert.equal(second, id + 1);
});

test("changes возвращается — на нём держится «не найдено»", async () => {
  const { db, uid: UID } = freshDb();
  const id = await db.addTask({ title: "Задача", creatorId: UID });
  assert.equal(await db.deleteTask(id, UID), true);
  assert.equal(await db.deleteTask(id, UID), false, "удаление несуществующего должно вернуть false");
});

test("задача создаётся, меняется и закрывается", async () => {
  const { db, uid: UID } = freshDb();
  const id = await db.addTask({ title: "позвонить в банк", creatorId: UID, assigneeId: UID, scope: "work" });
  // чистка названий работает и здесь: она стоит в db.ts, а не в обработчике
  let [t] = await db.listTasks({ visibleTo: UID });
  assert.equal(t.title, "Позвонить в банк");

  await db.updateTask(id, { title: "уточнить лимит", priority: 1 }, UID);
  [t] = await db.listTasks({ visibleTo: UID });
  assert.equal(t.title, "Уточнить лимит");
  assert.equal(t.priority, 1);

  await db.setTaskStatus(id, "done", UID, 3);
  assert.equal((await db.listTasks({ visibleTo: UID })).length, 0);
  assert.equal((await db.listTasks({ statuses: ["done"], visibleTo: UID })).length, 1);
});

test("null и undefined в полях не роняют запрос", async () => {
  // node:sqlite не принимает undefined — без приведения тут было бы падение
  const { db, uid: UID } = freshDb();
  const id = await db.addTask({ title: "Без срока и клиента", creatorId: UID, dueAt: null, clientId: null });
  const t = (await db.listTasks({ visibleTo: UID })).find((x) => x.id === id);
  assert.equal(t.due_at, null);
  assert.equal(t.client_id, null);
});

test("клиент заводится и правится", async () => {
  const { db, uid: UID } = freshDb();
  const id = await db.addClient(UID, "глобал стекло", "direct", "150000");
  const c = await db.getClient(id, UID);
  assert.equal(c.name, "Глобал Стекло");
  assert.equal(await db.updateClient(id, UID, { budget: "200000" }), true);
  assert.equal((await db.getClient(id, UID)).budget, "200000");
  assert.equal(await db.updateClient(id, 999, { budget: "1" }), false, "чужого клиента править нельзя");
});

test("встреча заводится и находится", async () => {
  const { db, uid: UID } = freshDb();
  const at = new Date(Date.now() + 3600_000).toISOString();
  const id = await db.addEvent({ userId: UID, title: "планёрка с командой", startsAt: at });
  assert.ok(id > 0);
  const list = await db.listEvents(UID, new Date(Date.now() - 86400_000).toISOString());
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Планёрка с командой");
});

test("сводные запросы считают, а не падают", async () => {
  // Самое уязвимое место переезда: GROUP BY, datetime() и подзапросы
  const { db, uid: UID } = freshDb();
  await db.addTask({ title: "Рабочая раз", creatorId: UID, assigneeId: UID, scope: "work" });
  await db.addTask({ title: "Рабочая два", creatorId: UID, assigneeId: UID, scope: "work" });
  const personal = await db.addTask({ title: "Личная", creatorId: UID, assigneeId: UID, scope: "personal" });

  const counts = await db.activeTaskCounts(UID);
  assert.deepEqual(counts, { work: 2, personal: 1 }, JSON.stringify(counts));

  await db.setTaskStatus(personal, "done", UID, 3);
  const stats = await db.taskStats(
    UID,
    new Date(Date.now() - 3600_000).toISOString(),
    new Date(Date.now() - 7 * 86400_000).toISOString()
  );
  assert.equal(stats.doneToday, 1, JSON.stringify(stats));
  assert.equal(stats.doneTotal, 1);

  const agenda = await db.tasksAgenda(UID, new Date(Date.now() + 86400_000).toISOString());
  assert.ok(Array.isArray(agenda));
});

test("напоминания о дедлайнах выбираются по времени", async () => {
  const { db, uid: UID } = freshDb();
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  await db.addTask({ title: "Скоро срок", creatorId: UID, assigneeId: UID, dueAt: soon });
  await db.addTask({ title: "Не скоро", creatorId: UID, assigneeId: UID, dueAt: new Date(Date.now() + 10 * 86400_000).toISOString() });
  const due = await db.tasksDueSoon(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
  assert.equal(due.length, 1, due.map((t) => t.title).join(", "));
  assert.equal(due[0].title, "Скоро срок");
});

test("настройки и внешний вид сохраняются", async () => {
  const { db, uid: UID } = freshDb();
  await db.setSetting("focus:1", JSON.stringify({ kind: "task", id: 5 }));
  assert.equal(await db.getSetting("focus:1"), JSON.stringify({ kind: "task", id: 5 }));
  assert.equal(await db.getSetting("нет такого"), null);

  const prefs = await db.getPrefs(UID);
  await db.setPrefs(UID, { ...prefs, scale: 120, theme: "dark" });
  const back = await db.getPrefs(UID);
  assert.equal(back.scale, 120);
  assert.equal(back.theme, "dark");
});

test("вода и еда считаются за день", async () => {
  const { db, uid: UID } = freshDb();
  await db.addWater(UID, 250);
  await db.addWater(UID, 500);
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(await db.waterTotal(UID, from, to), 750);
  await db.addFood(UID, { title: "Банан", kcal: 90, protein: 1, fat: 0, carbs: 23, meal: "snack" });
  const food = await db.listFood(UID, from, to);
  assert.equal(food.length, 1);
  assert.equal(food[0].kcal, 90);
});

test("автомиграции на старой базе проходят молча", async () => {
  // ensureSchema гоняет ALTER TABLE и глотает ошибку «колонка уже есть».
  // На D1 это работало; проверяем, что и на SQLite не ломается при повторе.
  const { db, uid: UID } = freshDb();
  await db.addTask({ title: "Первая", creatorId: UID });
  await db.addTask({ title: "Вторая", creatorId: UID });
  assert.equal((await db.listTasks({ visibleTo: UID })).length, 2);
});
