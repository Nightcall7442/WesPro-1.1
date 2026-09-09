// Выдача из кассы и внесение в кассу: расчётные наличные должны
// сходиться с тем, что реально лежит в ящике.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

test("выдача из кассы уменьшает расчётные наличные, внесение — увеличивает", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 1000 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });
  // Гость отыграл весь оплаченный час — в кассе ровно 600.
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    opened.body.id
  );
  await admin.post(`/api/tables/${table.id}/close`).send({});

  const before = await admin.get("/api/shifts/current");
  assert.equal(before.body.expected_cash, 1000 + 600, "начало + наличная выручка");

  const out = await admin
    .post("/api/shifts/cash")
    .send({ kind: "out", amount: 500, reason: "закупка воды" });
  assert.equal(out.status, 201);
  assert.equal(out.body.cash_out, 500);
  assert.equal(out.body.expected_cash, 1100, "1600 − 500");

  const inc = await admin
    .post("/api/shifts/cash")
    .send({ kind: "in", amount: 200, reason: "размен" });
  assert.equal(inc.body.cash_in, 200);
  assert.equal(inc.body.expected_cash, 1300, "1100 + 200");

  // Касса сходится: в ящике ровно расчётная сумма.
  const closed = await admin.post("/api/shifts/close").send({ closing_cash: 1300 });
  assert.equal(closed.body.cash_discrepancy, 0, "касса сошлась");
  assert.equal(closed.body.cash_out, 500);
  assert.equal(closed.body.cash_in, 200);
});

test("движение денег видно списком и попадает в журнал", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const shift = await admin.post("/api/shifts/open").send({ opening_cash: 2000 });

  await admin
    .post("/api/shifts/cash")
    .send({ kind: "out", amount: 300, reason: "такси за товаром" });

  const moves = await admin.get(`/api/shifts/${shift.body.id}/cash`);
  assert.equal(moves.status, 200);
  assert.equal(moves.body.length, 1);
  assert.equal(moves.body[0].kind, "out");
  assert.equal(moves.body[0].amount, 300);
  assert.equal(moves.body[0].reason, "такси за товаром");

  const journal = await admin.get("/api/journal");
  assert.ok(
    journal.body.some((e) => /Выдано из кассы 300.00.*такси за товаром/.test(e.message)),
    "операция записана в журнал"
  );
});

test("кассу нельзя увести в минус и оставить без причины", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });

  const noShift = await admin
    .post("/api/shifts/cash")
    .send({ kind: "out", amount: 100, reason: "закупка" });
  assert.equal(noShift.status, 409);
  assert.match(noShift.body.detail, /смену/);

  await admin.post("/api/shifts/open").send({ opening_cash: 500 });

  const tooMuch = await admin
    .post("/api/shifts/cash")
    .send({ kind: "out", amount: 900, reason: "закупка" });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.body.detail, /выдать больше нельзя/);

  const noReason = await admin
    .post("/api/shifts/cash")
    .send({ kind: "out", amount: 100 });
  assert.equal(noReason.status, 409);

  const zero = await admin
    .post("/api/shifts/cash")
    .send({ kind: "out", amount: 0, reason: "просто так" });
  assert.equal(zero.status, 409);
});
