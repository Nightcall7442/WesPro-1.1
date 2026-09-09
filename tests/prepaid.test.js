// Тесты предоплаченных сеансов: «на время», «чек на сумму», сдача при
// раннем уходе, доплата за перебор и продление открытого чека.
//
// Время в тестах «прокручиваем», сдвигая started_at в базе: так видно
// расчёт за фактически проведённое время, а не за ноль секунд.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

/** Сдвигает начало сеанса в прошлое — как будто гость уже поиграл. */
function playedFor(db, sessionId, minutes) {
  const started = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    started,
    sessionId
  );
}

test("предоплата на время: фиксированная сумма и способ оплаты", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "card",
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.prepaid_seconds, 3600);
  assert.equal(opened.body.prepaid_amount, 600);
  assert.equal(opened.body.payment_method, "card");

  const dashboard = await admin.get("/api/dashboard");
  const row = dashboard.body.find((t) => t.id === table.id);
  assert.equal(row.session.prepaid, true);
  assert.ok(row.session.remaining_seconds <= 3600);
  assert.equal(row.session.expired, false);
});

test("ушёл раньше — считается сдача с оплаченного времени", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });
  playedFor(db, opened.body.id, 40); // оплатил час, поиграл 40 минут

  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.status, 200);
  assert.equal(check.body.prepaid, true);
  assert.equal(check.body.prepaid_amount, 600, "в кассе уже 600");
  assert.equal(check.body.total, 400, "40 минут по 600 ₽/час = 400");
  assert.equal(check.body.change, 200, "сдача — 200");
  assert.equal(check.body.due, 0, "доплачивать нечего");
  assert.equal(check.body.unused_seconds, 20 * 60, "не догуляли 20 минут");

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 400, "в выручку идёт фактическое время");
});

test("засиделся — считается доплата за перебор", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 30,
    payment_method: "cash",
  });
  playedFor(db, opened.body.id, 45); // оплатил 30 минут, поиграл 45

  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.prepaid_amount, 300);
  assert.equal(check.body.total, 450, "45 минут = 450");
  assert.equal(check.body.due, 150, "доплата 150");
  assert.equal(check.body.change, 0);
  assert.equal(check.body.overtime_seconds, 15 * 60);
});

test("чек на сумму: время по тарифу, остаток уходит в чек, а не в сдачу", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 300,
    payment_method: "cash",
  });
  assert.equal(opened.body.prepaid_amount, 300);
  assert.equal(opened.body.prepaid_seconds, 1800); // полчаса по 600 ₽/час
  assert.equal(opened.body.prepaid_mode, "amount");

  playedFor(db, opened.body.id, 10);
  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.change, 0, "деньгами не возвращаем");
  assert.equal(check.body.voucher_out, 200, "остаток 200 уйдёт в чек");
  assert.equal(check.body.total, 300, "клуб оставляет всю оплату");
  assert.equal(check.body.due, 0, "доплачивать нечего");

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 300, "в выручку идёт вся оплата");
  assert.ok(closed.body.issued_voucher, "чек на остаток выдан");
  assert.equal(closed.body.issued_voucher.balance, 200);
  assert.match(closed.body.issued_voucher.code, /^Ч-\d{4}$/);
});

test("предоплата на сумму со скидкой клиента даёт больше времени", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = await admin.post("/api/clients").send({ name: "VIP" });
  await admin.put(`/api/clients/${client.body.id}`).send({ discount_percent: 50 });

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.body.id,
    mode: "amount",
    amount: 300,
    payment_method: "cash",
  });
  // Со скидкой 50% эффективная цена 300 ₽/час: 300 ₽ хватает на час.
  assert.equal(opened.body.prepaid_seconds, 3600);
});

test("предоплата без способа оплаты отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const res = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
  });
  assert.equal(res.status, 409);
});

test("бар добавляется к предоплате при закрытии", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const item = await admin.post("/api/menu").send({ name: "Кофе", price: 150 });

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 30,
    payment_method: "cash",
  });
  await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id });
  playedFor(db, opened.body.id, 30); // всё оплаченное время использовано

  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.total, 300 + 150);
  assert.equal(check.body.change, 0);
  assert.equal(check.body.due, 150, "бар остаётся доплатить");

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 300 + 150);
});

// --- Продление открытого чека ---------------------------------------------

test("продление на минуты добавляет время и сумму", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });

  const extended = await admin.post(`/api/tables/${table.id}/extend`).send({
    minutes: 30,
    payment_method: "cash",
  });
  assert.equal(extended.status, 200);
  assert.equal(extended.body.prepaid_seconds, 90 * 60, "стало 1,5 часа");
  assert.equal(extended.body.prepaid_amount, 900, "600 + 300");

  const row = (await admin.get("/api/dashboard")).body.find((t) => t.id === table.id);
  assert.ok(row.session.remaining_seconds > 3600, "таймер учёл продление");
});

test("продление на сумму пересчитывается в минуты", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 300,
    payment_method: "cash",
  });
  const extended = await admin.post(`/api/tables/${table.id}/extend`).send({
    amount: 600,
    payment_method: "card",
  });
  assert.equal(extended.body.prepaid_amount, 900);
  assert.equal(extended.body.prepaid_seconds, 1800 + 3600);
  assert.equal(extended.body.payment_method, "card", "последний способ оплаты");
});

test("продление с истёкшим временем работает (стол мигает «время вышло»)", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 30,
    payment_method: "cash",
  });
  playedFor(db, opened.body.id, 40); // время вышло 10 минут назад
  const before = (await admin.get("/api/dashboard")).body.find((t) => t.id === table.id);
  assert.equal(before.session.expired, true);

  const extended = await admin.post(`/api/tables/${table.id}/extend`).send({
    minutes: 30,
    payment_method: "cash",
  });
  assert.equal(extended.status, 200);
  const after = (await admin.get("/api/dashboard")).body.find((t) => t.id === table.id);
  assert.equal(after.session.expired, false, "таймер снова идёт");
});

test("продлевать нечего: свободный стол, постоплата, бесплатное время", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  // Свободный стол.
  const free = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 30, payment_method: "cash" });
  assert.equal(free.status, 409);
  assert.match(free.body.detail, /свободен/);

  // Постоплата — время не кончается.
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  const postpaid = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 30, payment_method: "cash" });
  assert.equal(postpaid.status, 409);
  assert.match(postpaid.body.detail, /без ограничения времени/);
});

test("продление требует способ оплаты и разумных значений", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });

  const noMethod = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 30 });
  assert.equal(noMethod.status, 409);

  const tooShort = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 1, payment_method: "cash" });
  assert.equal(tooShort.status, 409);

  const both = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 30, amount: 100, payment_method: "cash" });
  assert.equal(both.status, 409, "либо минуты, либо сумма");
});
