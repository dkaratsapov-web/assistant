/**
 * Закрытый режим.
 *
 * Проверка не косметическая: если выключатель однажды пропустит кого-то, бот
 * откроется всем. Поэтому проверяем обе стороны — что чужих не пускает и что
 * владельца не задевает.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { locked, lockedFor, lockedForMax, LOCKED_TEXT } from "../.test-build/access.js";

const owner = { user_id: 1, role: "owner" };
const member = { user_id: 2, role: "member" };
const client = { user_id: 3, role: "client" };
const pending = { user_id: 4, role: "pending" };

test("выключен — не трогаем никого", () => {
  for (const env of [{}, { LOCKED: "" }, { LOCKED: "off" }, { LOCKED: "нет" }]) {
    assert.equal(locked(env), false, JSON.stringify(env));
    for (const u of [owner, member, client, pending, null]) {
      assert.equal(lockedFor(env, u), false);
    }
  }
});

test("включается только явным «on»", () => {
  assert.equal(locked({ LOCKED: "on" }), true);
  assert.equal(locked({ LOCKED: "ON" }), true);
  assert.equal(locked({ LOCKED: " on " }), true, "пробелы по краям не должны мешать");
  assert.equal(locked({ LOCKED: "1" }), false, "случайное значение включать не должно");
  assert.equal(locked({ LOCKED: "true" }), false);
});

test("включён — владелец работает, остальные видят заглушку", () => {
  const env = { LOCKED: "on" };
  assert.equal(lockedFor(env, owner), false, "владельца отрезать нельзя: он же и открывает доступ");
  for (const u of [member, client, pending, null]) {
    assert.equal(lockedFor(env, u), true, JSON.stringify(u));
  }
});

test("в MAX владельца узнают по id, а не по роли", () => {
  assert.equal(lockedForMax({ LOCKED: "on" }, true), false);
  assert.equal(lockedForMax({ LOCKED: "on" }, false), true);
  assert.equal(lockedForMax({}, false), false);
});

test("текст заглушки говорит, что делать дальше", () => {
  assert.match(LOCKED_TEXT, /администратор/i, "человек должен понять, к кому идти");
  assert.ok(LOCKED_TEXT.length > 40 && LOCKED_TEXT.length < 300);
});
