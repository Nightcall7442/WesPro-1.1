// Личные ограничения сотрудника: сильнее прав его роли. Нужны, когда
// двум людям с одной ролью положено разное — иначе пришлось бы плодить
// роли под каждого человека.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, cashierAgent, makeApp } from "./helpers.js";
import { createUser } from "../src/services/users.js";

/** Кассир с личным разрешением/запретом и вошедший им агент. */
async function makeCashier(app, db, login = "kassa2") {
  createUser(db, { login, name: "Кассир Второй", password: "1234", role: "cashier" });
  const agent = supertest.agent(app);
  const res = await agent.post("/api/auth/login").send({ login, password: "1234" });
  assert.equal(res.status, 200, `вход ${login}`);
  return agent;
}

test("личное разрешение открывает доступ, которого нет у роли", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "kassir");

  // По роли кассиру скидки клиентов запрещены.
  assert.equal((await cashier.get("/api/auth/me")).body.permissions.manage_clients, false);
  assert.equal((await cashier.put("/api/clients/1").send({ discount_percent: 10 })).status, 403);

  // Разрешаем лично.
  const saved = await admin
    .put(`/api/users/${target.id}/permissions`)
    .send({ permissions: { manage_clients: true } });
  assert.equal(saved.status, 200);
  const row = saved.body.permissions.find((p) => p.key === "manage_clients");
  assert.equal(row.by_role, false, "по роли — запрещено");
  assert.equal(row.own, true, "лично — разрешено");
  assert.equal(row.effective, true, "итог — разрешено");

  // Кассир сразу получает доступ.
  assert.equal((await cashier.get("/api/auth/me")).body.permissions.manage_clients, true);
  const client = await cashier.post("/api/clients").send({ name: "Гость" });
  assert.equal(client.status, 201);
  const upd = await cashier
    .put(`/api/clients/${client.body.id}`)
    .send({ discount_percent: 10 });
  assert.equal(upd.status, 200, "скидку теперь ставить можно");
});

test("личный запрет закрывает доступ, который даёт роль", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const second = await makeCashier(app, db, "kassa2");
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "kassa2");

  // Разрешим роли кассира тарифы, а этому человеку — запретим лично.
  await admin.put("/api/permissions").send({
    entries: [{ role: "cashier", permission: "manage_tariffs", allowed: true }],
  });
  assert.equal((await second.get("/api/auth/me")).body.permissions.manage_tariffs, true);

  await admin
    .put(`/api/users/${target.id}/permissions`)
    .send({ permissions: { manage_tariffs: false } });

  const me = await second.get("/api/auth/me");
  assert.equal(me.body.permissions.manage_tariffs, false, "лично запрещено");
  const res = await second.post("/api/tariffs").send({ name: "Свой", price_per_hour: 100 });
  assert.equal(res.status, 403, "сервер тоже не пускает");
});

test("два кассира с одной ролью получают разные права", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const first = await cashierAgent(app, db);
  const second = await makeCashier(app, db, "kassa2");
  const users = (await admin.get("/api/users")).body;

  await admin
    .put(`/api/users/${users.find((u) => u.login === "kassir").id}/permissions`)
    .send({ permissions: { view_reports: true } });

  assert.equal((await first.get("/api/auth/me")).body.permissions.view_reports, true);
  assert.equal((await second.get("/api/auth/me")).body.permissions.view_reports, false);
  assert.equal((await first.get("/api/stats/overview")).status, 200);
  assert.equal((await second.get("/api/stats/overview")).status, 403);
});

test("«по роли» возвращает право обратно под роль", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "kassir");

  await admin
    .put(`/api/users/${target.id}/permissions`)
    .send({ permissions: { view_reports: true } });
  assert.equal((await cashier.get("/api/auth/me")).body.permissions.view_reports, true);

  // null — «как у роли».
  const reset = await admin
    .put(`/api/users/${target.id}/permissions`)
    .send({ permissions: { view_reports: null } });
  assert.equal(
    reset.body.permissions.find((p) => p.key === "view_reports").own,
    null
  );
  assert.equal((await cashier.get("/api/auth/me")).body.permissions.view_reports, false);
});

test("в списке сотрудников видно, у кого права отличаются от роли", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  await cashierAgent(app, db);
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "kassir");
  assert.equal(target.custom_limits, false, "сначала отличий нет");

  await admin
    .put(`/api/users/${target.id}/permissions`)
    .send({ permissions: { view_reports: true } });
  const after = (await admin.get("/api/users")).body.find((u) => u.login === "kassir");
  assert.equal(after.custom_limits, true, "отметка появилась");
});

test("себе ограничения менять нельзя", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const me = (await admin.get("/api/auth/me")).body.user;
  const res = await admin
    .put(`/api/users/${me.id}/permissions`)
    .send({ permissions: { manage_users: false } });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /собственного аккаунта/);
});

test("ограничения владельца и управляющего меняет только владелец", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  // Первого владельца создаёт администратор (свежая установка).
  await admin.post("/api/users").send({
    login: "owner", name: "Владелец", password: "owner1", role: "owner",
  });
  const owner = (await admin.get("/api/users")).body.find((u) => u.login === "owner");

  const denied = await admin
    .put(`/api/users/${owner.id}/permissions`)
    .send({ permissions: { manage_settings: false } });
  assert.equal(denied.status, 403, "администратор владельца не урежет");

  const ownerAgent = supertest.agent(app);
  await ownerAgent.post("/api/auth/login").send({ login: "owner", password: "owner1" });
  // Владелец может ограничить управляющего.
  const managerCreated = await ownerAgent.post("/api/users").send({
    login: "upravl", name: "Управляющий", password: "1234", role: "manager",
  });
  assert.equal(managerCreated.status, 201);
  const allowed = await ownerAgent
    .put(`/api/users/${managerCreated.body.id}/permissions`)
    .send({ permissions: { manage_users: false } });
  assert.equal(allowed.status, 200);
});

test("разработчика личные ограничения не касаются", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  createUser(
    db,
    { login: "dev", name: "Разработчик", password: "dev123", role: "developer" },
    { id: null, name: "Настройка", role: "developer" }
  );
  const dev = (await admin.get("/api/users")).body.find((u) => u.login === "dev");

  const view = await admin.get(`/api/users/${dev.id}/permissions`);
  assert.equal(view.body.ignored, true, "редактор честно говорит, что не применится");

  // Даже с записанным запретом доступ остаётся полным.
  const owner = supertest.agent(app);
  await admin.post("/api/users").send({
    login: "owner", name: "Владелец", password: "owner1", role: "owner",
  });
  await owner.post("/api/auth/login").send({ login: "owner", password: "owner1" });
  await owner
    .put(`/api/users/${dev.id}/permissions`)
    .send({ permissions: { manage_settings: false } });

  const devAgent = supertest.agent(app);
  const login = await devAgent.post("/api/auth/login").send({ login: "dev", password: "dev123" });
  assert.equal(login.body.permissions.manage_settings, true, "у разработчика всё равно всё");
  assert.equal((await devAgent.get("/api/settings")).status, 200);
});

test("кассир не может настраивать чужие ограничения", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "admin");

  assert.equal((await cashier.get(`/api/users/${target.id}/permissions`)).status, 403);
  assert.equal(
    (await cashier.put(`/api/users/${target.id}/permissions`).send({ permissions: {} })).status,
    403
  );
});

test("личное ограничение переживает смену роли и удаляется с аккаунтом", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  await cashierAgent(app, db);
  const target = (await admin.get("/api/users")).body.find((u) => u.login === "kassir");
  await admin
    .put(`/api/users/${target.id}/permissions`)
    .send({ permissions: { open_free_time: true } });

  // Роль сменилась — личное решение остаётся (оно про человека, не про роль).
  await admin.put(`/api/users/${target.id}`).send({ role: "admin" });
  const after = await admin.get(`/api/users/${target.id}/permissions`);
  assert.equal(after.body.permissions.find((p) => p.key === "open_free_time").own, true);

  // Аккаунт удалён — записи прав уходят вместе с ним (ON DELETE CASCADE).
  await admin.delete(`/api/users/${target.id}`);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = ?").get(target.id).n,
    0
  );
});
