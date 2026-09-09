// Создание аккаунта с компьютера клуба (npm run add-user /
// create-developer.bat): нужно, чтобы завести разработчика и вернуть
// доступ, когда пароли забыты.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { addUser, generatePassword, parseArgs } from "../src/cli/add-user.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createUser } from "../src/services/users.js";

test("пароль генерируется длинный и без похожих знаков", () => {
  const password = generatePassword();
  assert.equal(password.length, 12);
  assert.doesNotMatch(password, /[0O1lI]/, "нет знаков, которые путают при вводе");
  assert.notEqual(generatePassword(), generatePassword(), "пароли разные");
});

test("аргументы командной строки разбираются", () => {
  const args = parseArgs(["--role", "developer", "--login", "dev", "--force"]);
  assert.equal(args.role, "developer");
  assert.equal(args.login, "dev");
  assert.equal(args.force, true);
});

test("создаёт разработчика с полным доступом на живой базе", async () => {
  const db = createDatabase(":memory:");
  createUser(db, { login: "admin", name: "Админ", password: "admin1", role: "admin" });
  const app = createApp(db);

  const result = addUser(db, { login: "dev", role: "developer" });
  assert.equal(result.created, true);
  assert.equal(result.role, "developer");
  assert.ok(result.password.length >= 12, "пароль выдан");

  // Аккаунт работает и получает все права.
  const agent = supertest.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ login: "dev", password: result.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "developer");
  assert.ok(
    Object.values(login.body.permissions).every(Boolean),
    "разрешено всё"
  );
  assert.equal(login.body.owner_level, true, "владельческие блоки открыты");
  // И редактор прав, который жёстко закрыт для остальных.
  assert.equal((await agent.get("/api/permissions")).status, 200);
});

test("роль разработчика создаётся даже когда владелец уже есть", async () => {
  // Через интерфейс администратор так сделать не может — в этом и смысл
  // запуска с компьютера клуба.
  const db = createDatabase(":memory:");
  createUser(db, { login: "owner", name: "Владелец", password: "owner1", role: "owner" }, {
    id: 1, name: "Сид", role: "developer",
  });
  const result = addUser(db, { login: "dev", role: "developer" });
  assert.equal(result.created, true);
  assert.equal(
    db.prepare("SELECT role FROM users WHERE login = 'dev'").get().role,
    "developer"
  );
});

test("занятый логин: аккаунт не дублируется, а возвращается доступ", async () => {
  const db = createDatabase(":memory:");
  createUser(db, { login: "dev", name: "Старый", password: "1234", role: "cashier" });
  db.prepare("UPDATE users SET is_active = 0 WHERE login = 'dev'").run();
  // Второй управленческий аккаунт: иначе система не даст менять роли.
  createUser(db, { login: "admin", name: "Админ", password: "admin1", role: "admin" });

  const result = addUser(db, { login: "dev", role: "developer", name: "Разработчик" });
  assert.equal(result.created, false, "существующий аккаунт обновлён");

  const row = db.prepare("SELECT * FROM users WHERE login = 'dev'").get();
  assert.equal(row.role, "developer", "роль поднята");
  assert.equal(row.is_active, 1, "вход снова разрешён");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE login = 'dev'").get().n,
    1,
    "второй аккаунт не появился"
  );

  const app = createApp(db);
  const login = await supertest(app)
    .post("/api/auth/login")
    .send({ login: "dev", password: result.password });
  assert.equal(login.status, 200, "новый пароль работает");
});

test("свой пароль принимается, неизвестная роль — нет", () => {
  const db = createDatabase(":memory:");
  createUser(db, { login: "admin", name: "Админ", password: "admin1", role: "admin" });

  const result = addUser(db, { login: "dev2", role: "developer", password: "мой-пароль-1" });
  assert.equal(result.password, "мой-пароль-1");

  assert.throws(
    () => addUser(db, { login: "kto", role: "король" }),
    /Неизвестная роль/
  );
  assert.throws(() => addUser(db, { login: "  ", role: "developer" }), /логин/i);
});

test("создание с компьютера попадает в журнал", () => {
  const db = createDatabase(":memory:");
  addUser(db, { login: "dev", role: "developer" });
  const entry = db
    .prepare("SELECT message FROM journal_entries ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(entry.message, /Разработчик/);
  assert.match(entry.message, /компьютере клуба/, "видно, что аккаунт создан локально");
});
