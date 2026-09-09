// Демо-данные: наполнить базу «как настоящий клуб» и стереть обратно,
// не задев рабочие данные.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";
import { createUser } from "../src/services/users.js";
import supertest from "supertest";

/** Вход разработчиком: демо-данные доступны только ему. */
async function developerAgent(app, db) {
  createUser(db, {
    login: "dev",
    name: "Разработчик",
    password: "dev123",
    role: "developer",
  });
  const agent = supertest.agent(app);
  const res = await agent.post("/api/auth/login").send({ login: "dev", password: "dev123" });
  if (res.status !== 200) throw new Error(`developer login: ${res.status}`);
  return agent;
}

test("демо-данные наполняют базу и стираются полностью", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  // Рабочие данные, которые трогать нельзя.
  const realTable = await createTable(admin, "Стол 1");
  const realTariff = await createTariff(admin, "Рабочий тариф", 400);
  const realClient = await admin.post("/api/clients").send({ name: "Настоящий гость" });

  const dev = await developerAgent(app, db);
  const before = await dev.get("/api/demo");
  assert.equal(before.body.present, false);

  const filled = await dev.post("/api/demo").send({ days: 7 });
  assert.equal(filled.status, 201);
  assert.equal(filled.body.tables, 4, "добавлены демо-столы");
  assert.equal(filled.body.clients, 5, "добавлены демо-клиенты");
  assert.ok(filled.body.sessions > 20, `сеансов за неделю: ${filled.body.sessions}`);
  assert.equal(filled.body.shifts, 7, "по смене на каждый день");

  const present = await dev.get("/api/demo");
  assert.equal(present.body.present, true);

  // Отчёты стали непустыми — ради этого всё и делалось.
  const revenue = await admin.get("/api/stats/revenue?days=7");
  assert.ok(
    revenue.body.days.some((d) => d.total > 0),
    "в отчёте по выручке появились данные"
  );

  const cleared = await dev.delete("/api/demo");
  assert.ok(cleared.body.sessions > 0);
  assert.equal(cleared.body.tables, 4);
  assert.equal(cleared.body.clients, 5);

  const after = await dev.get("/api/demo");
  assert.equal(after.body.present, false, "демо-данных не осталось");

  // Рабочие данные на месте.
  const tables = await admin.get("/api/tables");
  assert.ok(tables.body.some((t) => t.id === realTable.id), "рабочий стол цел");
  const tariffs = await admin.get("/api/tariffs");
  assert.ok(tariffs.body.some((t) => t.id === realTariff.id), "рабочий тариф цел");
  const clients = await admin.get("/api/clients");
  assert.ok(
    clients.body.some((c) => c.id === realClient.body.id),
    "настоящий клиент цел"
  );
});

test("повторное наполнение не плодит столы и клиентов", async () => {
  const { db, app } = makeApp();
  await adminAgent(app);
  const dev = await developerAgent(app, db);

  await dev.post("/api/demo").send({ days: 3 });
  const second = await dev.post("/api/demo").send({ days: 3 });
  assert.equal(second.body.tables, 0, "столы уже есть — заново не создаются");
  assert.equal(second.body.clients, 0);

  const count = db.prepare("SELECT COUNT(*) AS n FROM tables WHERE name LIKE 'Демо%'").get().n;
  assert.equal(count, 4);
  await dev.delete("/api/demo");
});

test("демо-данные закрыты от всех, кроме разработчика", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app); // роль admin
  assert.equal((await admin.get("/api/demo")).status, 403);
  assert.equal((await admin.post("/api/demo").send({})).status, 403);
  assert.equal((await admin.delete("/api/demo")).status, 403);
});
