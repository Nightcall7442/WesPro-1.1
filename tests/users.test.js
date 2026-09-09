// Управление сотрудниками: роль управляющего, редактирование и удаление
// с ограничениями (нельзя удалить себя, нельзя остаться без управленца,
// сотрудник с историей отключается, а не удаляется).

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, cashierAgent, makeApp } from "./helpers.js";
import { createUser } from "../src/services/users.js";

test("роль «управляющий» доступна и попадает в матрицу прав", async () => {
  const { app } = makeApp();
  // Первого владельца создаёт администратор (на свежей базе владельца нет),
  // дальше управленческие роли выдаёт уже он.
  const admin = await adminAgent(app);
  const ownerCreated = await admin.post("/api/users").send({
    login: "owner",
    name: "Владелец",
    password: "owner1",
    role: "owner",
  });
  assert.equal(ownerCreated.status, 201, "первого владельца создать можно");

  const owner = (await import("supertest")).default.agent(app);
  await owner.post("/api/auth/login").send({ login: "owner", password: "owner1" });

  const created = await owner.post("/api/users").send({
    login: "upravl",
    name: "Управляющий Пётр",
    password: "1234",
    role: "manager",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, "manager");

  const matrix = await owner.get("/api/permissions");
  assert.equal(matrix.status, 200);
  assert.ok(matrix.body.roles.includes("manager"), "управляющий есть в матрице");
  // По умолчанию управляющий может всё, кроме редактора самих прав.
  assert.equal(matrix.body.matrix.manager.manage_tables, true);
  assert.equal(matrix.body.matrix.manager.open_free_time, true);

  // Управляющий заходит и действительно управляет столами.
  const manager = (await import("supertest")).default.agent(app);
  const login = await manager
    .post("/api/auth/login")
    .send({ login: "upravl", password: "1234" });
  assert.equal(login.status, 200);
  assert.equal(login.body.permissions.manage_tables, true);
  assert.equal((await manager.post("/api/tables").send({ name: "Стол М" })).status, 201);
  // Но матрицу прав правит только владелец/разработчик.
  assert.equal((await manager.get("/api/permissions")).status, 403);
});

test("администратор не может выдать роль управляющего", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const res = await admin.post("/api/users").send({
    login: "upravl2",
    name: "Пётр",
    password: "1234",
    role: "manager",
  });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /владелец или разработчик/);
});

test("когда владелец уже есть, администратор не создаёт второго", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  assert.equal(
    (await admin.post("/api/users").send({
      login: "owner", name: "Владелец", password: "owner1", role: "owner",
    })).status,
    201
  );
  const second = await admin.post("/api/users").send({
    login: "owner2", name: "Второй владелец", password: "owner2", role: "owner",
  });
  assert.equal(second.status, 409, "поблажка действует только для первого");
});

test("редактирование сотрудника: логин, имя, роль, доступ", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  createUser(db, { login: "kassa1", name: "Кассир Первый", password: "1234", role: "cashier" });
  const users = (await admin.get("/api/users")).body;
  const target = users.find((u) => u.login === "kassa1");

  const updated = await admin.put(`/api/users/${target.id}`).send({
    login: "kassa-new",
    name: "Кассир Обновлённый",
    role: "admin",
    is_active: false,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.login, "kassa-new");
  assert.equal(updated.body.name, "Кассир Обновлённый");
  assert.equal(updated.body.role, "admin");
  assert.equal(updated.body.is_active, false);

  // Занятый логин не даём поставить.
  const clash = await admin.put(`/api/users/${target.id}`).send({ login: "admin" });
  assert.equal(clash.status, 409);
  assert.match(clash.body.detail, /занят/);
});

test("нельзя менять роль и отключать самого себя", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const me = (await admin.get("/api/auth/me")).body.user;

  const role = await admin.put(`/api/users/${me.id}`).send({ role: "cashier" });
  assert.equal(role.status, 409);

  const off = await admin.put(`/api/users/${me.id}`).send({ is_active: false });
  assert.equal(off.status, 409);
});

test("удаление сотрудника без истории — физическое", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  createUser(db, { login: "novyj", name: "Новичок", password: "1234", role: "cashier" });
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "novyj");

  const res = await admin.delete(`/api/users/${target.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);
  const rest = (await admin.get("/api/users")).body.map((u) => u.login);
  assert.ok(!rest.includes("novyj"), "аккаунт удалён из списка");
});

test("сотрудник с историей смен отключается, а не удаляется", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  // История: открытая и закрытая смена кассира.
  await cashier.post("/api/shifts/open").send({ opening_cash: 0 });
  await cashier.post("/api/shifts/close").send({ closing_cash: 0 });

  const target = (await admin.get("/api/users")).body.find((u) => u.login === "kassir");
  const res = await admin.delete(`/api/users/${target.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, false, "физически не удалён — за ним история");
  assert.equal(res.body.user.is_active, false, "но доступ закрыт");

  // Войти он больше не может.
  const relogin = await (await import("supertest")).default
    .agent(app)
    .post("/api/auth/login")
    .send({ login: "kassir", password: "1234" });
  assert.equal(relogin.status, 401);
});

test("нельзя удалить себя и последний управленческий аккаунт", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const me = (await admin.get("/api/auth/me")).body.user;

  const self = await admin.delete(`/api/users/${me.id}`);
  assert.equal(self.status, 409);
  assert.match(self.body.detail, /собственный аккаунт/);

  // Второй администратор: теперь первого удалить можно, а последнего — нет.
  createUser(db, { login: "admin2", name: "Второй", password: "1234", role: "admin" });
  const second = (await admin.get("/api/users")).body.find((u) => u.login === "admin2");
  assert.equal((await admin.delete(`/api/users/${second.id}`)).status, 200);

  // Остался один управленческий аккаунт — он же текущий, удалить нельзя.
  const users = (await admin.get("/api/users")).body;
  assert.equal(users.filter((u) => u.is_active && u.role === "admin").length, 1);
});

test("кассир не может ни редактировать, ни удалять сотрудников", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "admin");

  assert.equal((await cashier.put(`/api/users/${target.id}`).send({ name: "Хак" })).status, 403);
  assert.equal((await cashier.delete(`/api/users/${target.id}`)).status, 403);
});

test("первый запуск: администратор видит и настраивает права, пока владельца нет", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  // Признак для интерфейса: показывать владельческие блоки.
  const me = await admin.get("/api/auth/me");
  assert.equal(me.body.owner_setup_pending, true, "владельца ещё нет");
  assert.equal(me.body.owner_level, true, "владельческие блоки открыты");

  // Матрица прав доступна — иначе ограничения нельзя было бы настроить.
  const matrix = await admin.get("/api/permissions");
  assert.equal(matrix.status, 200);
  const saved = await admin.put("/api/permissions").send({
    entries: [{ role: "cashier", permission: "view_reports", allowed: true }],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.matrix.cashier.view_reports, true);
});

test("появился владелец — администратор теряет владельческий доступ", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  assert.equal((await admin.get("/api/permissions")).status, 200);

  const created = await admin.post("/api/users").send({
    login: "owner", name: "Владелец", password: "owner1", role: "owner",
  });
  assert.equal(created.status, 201, "первого владельца создаёт администратор");

  const me = await admin.get("/api/auth/me");
  assert.equal(me.body.owner_setup_pending, false);
  assert.equal(me.body.owner_level, false, "блоки скрыты");
  assert.equal((await admin.get("/api/permissions")).status, 403);
  assert.equal((await admin.put("/api/permissions").send({ entries: [] })).status, 403);

  // А владелец — работает.
  const owner = (await import("supertest")).default.agent(app);
  const login = await owner.post("/api/auth/login").send({ login: "owner", password: "owner1" });
  assert.equal(login.body.owner_level, true);
  assert.equal((await owner.get("/api/permissions")).status, 200);
});

test("кассиру владельческий доступ не даётся даже на свежей установке", async () => {
  const { app, db } = makeApp();
  const cashier = await cashierAgent(app, db);
  const me = await cashier.get("/api/auth/me");
  assert.equal(me.body.owner_setup_pending, true, "владельца нет");
  assert.equal(me.body.owner_level, false, "но кассиру это ничего не даёт");
  assert.equal((await cashier.get("/api/permissions")).status, 403);
});

test("отключённый владелец не блокирует настройку заново", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.post("/api/users").send({
    login: "owner", name: "Владелец", password: "owner1", role: "owner",
  });
  const owner = (await admin.get("/api/users")).body.find((u) => u.login === "owner");
  await admin.put(`/api/users/${owner.id}`).send({ is_active: false });

  // Активного владельца снова нет — администратор может создать нового.
  const me = await admin.get("/api/auth/me");
  assert.equal(me.body.owner_setup_pending, true);
  const again = await admin.post("/api/users").send({
    login: "owner2", name: "Новый владелец", password: "owner2", role: "owner",
  });
  assert.equal(again.status, 201);
});

test("логин сохраняется как введён, а входить можно в любом регистре", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const created = await admin.post("/api/users").send({
    login: "Vladelec", name: "Владелец Клуба", password: "vlad12", role: "owner",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.login, "Vladelec", "заглавная буква сохранилась");

  // Вход — в любом регистре.
  for (const variant of ["Vladelec", "vladelec", "VLADELEC"]) {
    const agent = (await import("supertest")).default.agent(app);
    const res = await agent
      .post("/api/auth/login")
      .send({ login: variant, password: "vlad12" });
    assert.equal(res.status, 200, `вход как «${variant}»`);
    assert.equal(res.body.user.login, "Vladelec", "показывается как создан");
  }

  // Тот же логин в другом регистре — уже занят.
  const dup = await admin.post("/api/users").send({
    login: "VLADELEC", name: "Двойник", password: "1234", role: "cashier",
  });
  assert.equal(dup.status, 409);
  assert.match(dup.body.detail, /занят/);
});
