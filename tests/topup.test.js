// Пополнение счёта клиента (вкладка «Касса»): касса берёт деньги
// заранее и выдаёт чек с кодом — им можно расплатиться за любой стол
// позже, так же как обычным чеком на остаток.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, cashierAgent, createTable, createTariff, makeApp } from "./helpers.js";

test("пополнение наличными выдаёт чек и кладёт деньги в кассу", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const client = (await admin.post("/api/clients").send({ name: "Пётр" })).body;

  const res = await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 1000, payment_method: "cash" });
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, "topup");
  assert.equal(res.body.balance, 1000);
  assert.equal(res.body.client_id, client.id);
  assert.ok(res.body.code);

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash_in, 1000, "наличные пополнения кладутся в кассу");

  const vouchers = await admin.get(`/api/vouchers?client_id=${client.id}`);
  assert.equal(vouchers.body.length, 1);
  assert.equal(vouchers.body[0].code, res.body.code);
});

test("пополнение картой или переводом чек выдаёт, но кассу не трогает", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const client = (await admin.post("/api/clients").send({ name: "Игорь" })).body;

  const res = await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 500, payment_method: "card" });
  assert.equal(res.status, 201);

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash_in, 0, "оплата картой в наличные не попадает");
});

test("выданным чеком на пополнение можно расплатиться за стол", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = (await admin.post("/api/clients").send({ name: "Марат" })).body;

  const topup = await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 600, payment_method: "cash" });

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: topup.body.code,
  });
  assert.equal(opened.status, 201, "чек пополнения принят как обычный чек на остаток");
});

test("без открытой смены пополнить счёт нельзя (кассир)", async () => {
  const { db, app } = makeApp();
  await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const client = (await cashier.post("/api/clients").send({ name: "Клиент" })).body;

  const res = await cashier
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 300, payment_method: "cash" });
  assert.equal(res.status, 409);
});

test("сумма пополнения должна быть больше нуля", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const client = (await admin.post("/api/clients").send({ name: "Клиент" })).body;

  const res = await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 0, payment_method: "cash" });
  assert.equal(res.status, 409);
});

test("пополнение отмечается в журнале", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const client = (await admin.post("/api/clients").send({ name: "Айгуль" })).body;

  await admin.post(`/api/clients/${client.id}/topup`).send({ amount: 1200, payment_method: "cash" });

  const journal = await admin.get("/api/journal");
  assert.ok(
    journal.body.some(
      (e) => e.event === "client_topup" && /Айгуль/.test(e.message) && /1200/.test(e.message)
    ),
    "в журнале видно, кому и на сколько пополнили счёт"
  );
});
