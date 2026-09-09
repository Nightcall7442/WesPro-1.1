// Экран для гостей: открыт без входа, но денег клуба и имён клиентов
// на нём быть не должно.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

test("экран для гостей открывается без входа", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await createTable(admin, "Стол у окна");
  await createTariff(admin, "Дневной", 400);

  const guest = supertest(app); // без cookie — никто не вошёл
  const page = await guest.get("/board");
  assert.equal(page.status, 200);

  const data = await guest.get("/api/board");
  assert.equal(data.status, 200);
  assert.equal(data.body.club_name, "Бильярдный клуб");
  assert.ok(data.body.tables.some((t) => t.name === "Стол у окна"));
  assert.ok(data.body.tariffs.some((t) => t.price_per_hour === 400));
});

test("на экране видно, свободен стол или занят", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const guest = supertest(app);

  const free = await guest.get("/api/board");
  assert.equal(free.body.tables.find((t) => t.id === table.id).free, true);

  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  const busy = await guest.get("/api/board");
  assert.equal(busy.body.tables.find((t) => t.id === table.id).free, false);
});

test("на экране нет ни денег клуба, ни имён клиентов", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const client = await admin.post("/api/clients").send({ name: "Секретный Гость" });
  await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.body.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });

  const data = await supertest(app).get("/api/board");
  const raw = JSON.stringify(data.body);
  assert.ok(!raw.includes("Секретный Гость"), "имени клиента на экране нет");
  assert.ok(!raw.includes("revenue"), "выручки на экране нет");
  assert.ok(!raw.includes("prepaid"), "чужих оплат на экране нет");
  assert.ok(!raw.includes("session"), "чужих сеансов на экране нет");
});

test("действующая акция показывается гостям", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.post("/api/promotions").send({
    name: "Счастливый час",
    discount_percent: 20,
    days: [1, 2, 3, 4, 5, 6, 7],
    start_minute: 0,
    end_minute: 1440,
  });

  const data = await supertest(app).get("/api/board");
  assert.equal(data.body.promotion.name, "Счастливый час");
  assert.equal(data.body.promotion.discount_percent, 20);
});

test("остальное API по-прежнему требует входа", async () => {
  const { app } = makeApp();
  await adminAgent(app);
  const guest = supertest(app);
  for (const path of ["/api/dashboard", "/api/clients", "/api/shifts", "/api/payroll"]) {
    const res = await guest.get(path);
    assert.equal(res.status, 401, `${path} закрыт от гостей`);
  }
});
