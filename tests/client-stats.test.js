// Статистика клиента: посещения, расход, время и средний чек по периодам.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

/** Закрытый сеанс клиента: начался daysAgo дней назад и длился minutes. */
function pastSession(db, sessionId, daysAgo, minutes) {
  const end = Date.now() - daysAgo * 24 * 3600 * 1000;
  const started = new Date(end - minutes * 60 * 1000).toISOString();
  db.prepare("UPDATE table_sessions SET started_at = ?, ended_at = ? WHERE id = ?").run(
    started,
    new Date(end).toISOString(),
    sessionId
  );
}

test("статистика клиента: посещения, расход, время, средний чек", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = (await admin.post("/api/clients").send({ name: "Пётр" })).body;

  // Три визита: сегодня час, три дня назад полчаса, 20 дней назад два часа.
  for (const [daysAgo, minutes] of [[0, 60], [3, 30], [20, 120]]) {
    const opened = await admin
      .post(`/api/tables/${table.id}/open`)
      .send({ tariff_id: tariff.id, client_id: client.id });
    const started = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
      started,
      opened.body.id
    );
    await admin.post(`/api/tables/${table.id}/close`).send({ payment_method: "cash" });
    pastSession(db, opened.body.id, daysAgo, minutes);
  }

  const res = await admin.get(`/api/clients/${client.id}/stats`);
  assert.equal(res.status, 200);
  const s = res.body;

  assert.equal(s.total.visits, 3, "всего три визита");
  assert.equal(s.total.seconds, (60 + 30 + 120) * 60, "суммарное время");
  assert.equal(s.total.spent, 600 + 300 + 1200, "суммарный расход");
  assert.equal(s.total.average, (600 + 300 + 1200) / 3, "средний расход за визит");

  assert.equal(s.day.visits, 1, "за сутки — один визит");
  assert.equal(s.day.spent, 600);
  assert.equal(s.week.visits, 2, "за неделю — два");
  assert.equal(s.week.spent, 900);
  assert.equal(s.month.visits, 3, "за месяц — все три");
  assert.ok(s.last_visit, "дата последнего визита есть");
});

test("клиент без визитов: нули, а не пустота", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const client = (await admin.post("/api/clients").send({ name: "Новичок" })).body;

  const s = (await admin.get(`/api/clients/${client.id}/stats`)).body;
  assert.equal(s.total.visits, 0);
  assert.equal(s.total.spent, 0);
  assert.equal(s.total.average, 0);
  assert.equal(s.total.seconds, 0);
  assert.equal(s.last_visit, null);
});

test("открытый сеанс в статистику не попадает", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const client = (await admin.post("/api/clients").send({ name: "Гость" })).body;
  await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.id });

  const s = (await admin.get(`/api/clients/${client.id}/stats`)).body;
  assert.equal(s.total.visits, 0, "считаются только закрытые сеансы");
});

test("статистика несуществующего клиента — 404", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  assert.equal((await admin.get("/api/clients/9999/stats")).status, 404);
});

test("любимые столы и тарифы: чаще всего играет — тот и наверху списка", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const tableA = await createTable(admin, "Стол А");
  const tableB = await createTable(admin, "Стол Б");
  const tariffX = await createTariff(admin, "Тариф X", 600);
  const tariffY = await createTariff(admin, "Тариф Y", 800);
  const client = (await admin.post("/api/clients").send({ name: "Марат" })).body;

  // Три визита за стол А по тарифу X, один визит за стол Б по тарифу Y.
  for (let i = 0; i < 3; i += 1) {
    await admin
      .post(`/api/tables/${tableA.id}/open`)
      .send({ tariff_id: tariffX.id, client_id: client.id });
    await admin.post(`/api/tables/${tableA.id}/close`).send({ payment_method: "cash" });
  }
  await admin
    .post(`/api/tables/${tableB.id}/open`)
    .send({ tariff_id: tariffY.id, client_id: client.id });
  await admin.post(`/api/tables/${tableB.id}/close`).send({ payment_method: "cash" });

  const s = (await admin.get(`/api/clients/${client.id}/stats`)).body;

  assert.equal(s.favorite_tables[0].name, "Стол А");
  assert.equal(s.favorite_tables[0].visits, 3);
  assert.equal(s.favorite_tables[1].name, "Стол Б");
  assert.equal(s.favorite_tables[1].visits, 1);

  assert.equal(s.favorite_tariffs[0].name, "Тариф X");
  assert.equal(s.favorite_tariffs[0].visits, 3);
  assert.equal(s.favorite_tariffs[1].name, "Тариф Y");
  assert.equal(s.favorite_tariffs[1].visits, 1);

  // Деньги и время тоже посчитаны (числами, а не отсутствуют).
  assert.equal(typeof s.favorite_tables[0].spent, "number");
  assert.equal(typeof s.favorite_tables[0].seconds, "number");
});

test("любимые столы: у клиента без визитов — пустые списки", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const client = (await admin.post("/api/clients").send({ name: "Новичок" })).body;

  const s = (await admin.get(`/api/clients/${client.id}/stats`)).body;
  assert.deepEqual(s.favorite_tables, []);
  assert.deepEqual(s.favorite_tariffs, []);
});
