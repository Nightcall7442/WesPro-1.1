// Пересадка гостей на другой стол: сеанс переезжает целиком —
// с оплатой, баром, клиентом и таймером.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

test("пересадка переносит сеанс со всей оплатой и баром", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const from = await createTable(admin, "Стол 1");
  const to = await createTable(admin, "Стол 2");
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = await admin.post("/api/clients").send({ name: "Пётр" });
  const item = await admin.post("/api/menu").send({ name: "Кофе", price: 150 });

  const opened = await admin.post(`/api/tables/${from.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.body.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });
  await admin
    .post(`/api/tables/${from.id}/orders`)
    .send({ menu_item_id: item.body.id });

  const moved = await admin
    .post(`/api/tables/${from.id}/move`)
    .send({ target_table_id: to.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.id, opened.body.id, "сеанс тот же самый");
  assert.equal(moved.body.table_id, to.id, "уже на новом столе");
  assert.equal(moved.body.prepaid_amount, 600, "оплата сохранилась");

  const dashboard = await admin.get("/api/dashboard");
  const before = dashboard.body.find((t) => t.id === from.id);
  const after = dashboard.body.find((t) => t.id === to.id);
  assert.equal(before.session, null, "старый стол освободился");
  assert.ok(after.session, "новый стол занят");
  assert.equal(after.session.client_name, "Пётр", "клиент переехал");
  assert.ok(after.session.remaining_seconds <= 3600, "таймер продолжается");

  const check = await admin.get(`/api/tables/${to.id}/check`);
  assert.equal(check.body.bar_cost, 150, "бар переехал вместе с сеансом");

  const journal = await admin.get("/api/journal");
  assert.ok(
    journal.body.some((e) => /пересажены со стола «Стол 1» на «Стол 2»/i.test(e.message)),
    "в журнале видно пересадку"
  );
});

test("пересадка на занятый стол и с пустого — отказ", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const first = await createTable(admin, "Стол 1");
  const second = await createTable(admin, "Стол 2");
  const tariff = await createTariff(admin);

  const empty = await admin
    .post(`/api/tables/${first.id}/move`)
    .send({ target_table_id: second.id });
  assert.equal(empty.status, 409);
  assert.match(empty.body.detail, /свободен/);

  await admin.post(`/api/tables/${first.id}/open`).send({ tariff_id: tariff.id });
  await admin.post(`/api/tables/${second.id}/open`).send({ tariff_id: tariff.id });

  const busy = await admin
    .post(`/api/tables/${first.id}/move`)
    .send({ target_table_id: second.id });
  assert.equal(busy.status, 409);
  assert.match(busy.body.detail, /занят/);

  const same = await admin
    .post(`/api/tables/${first.id}/move`)
    .send({ target_table_id: first.id });
  assert.equal(same.status, 409);

  const none = await admin.post(`/api/tables/${first.id}/move`).send({});
  assert.equal(none.status, 409);
  assert.match(none.body.detail, /Выберите стол/);
});

test("после пересадки стол закрывается как обычно", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const from = await createTable(admin, "Стол 1");
  const to = await createTable(admin, "Стол 2");
  const tariff = await createTariff(admin); // 600 ₽/час

  const opened = await admin.post(`/api/tables/${from.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    opened.body.id
  );
  await admin.post(`/api/tables/${from.id}/move`).send({ target_table_id: to.id });

  const check = await admin.get(`/api/tables/${to.id}/check`);
  assert.equal(check.body.total, 300, "считается всё время, а не с пересадки");
  assert.equal(check.body.change, 300, "сдача с оплаченного часа");

  const closed = await admin.post(`/api/tables/${to.id}/close`).send({});
  assert.equal(closed.status, 200);
  assert.equal(closed.body.total_cost, 300);
  assert.equal(closed.body.table_name, "Стол 2", "в истории — новый стол");
});
