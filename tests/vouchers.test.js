// Чеки на остаток: остаток «чека на сумму» не возвращается деньгами, а
// выдаётся чеком, по которому можно доиграть в другой день.
//
// Отдельно проверяем деньги: оплата попадает в выручку сразу, а игра по
// чеку новой выручки не даёт — иначе одни и те же деньги посчитались бы
// дважды и касса не сошлась бы.

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

/** Открывает чек на сумму, «играет» minutes минут и закрывает. */
async function playByAmount(admin, db, table, tariff, { amount, minutes, clientId = null }) {
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: clientId,
    mode: "amount",
    amount,
    payment_method: "cash",
  });
  assert.equal(opened.status, 201, "чек на сумму открыт");
  playedFor(db, opened.body.id, minutes);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.status, 200, "стол закрыт");
  return closed.body;
}

test("остаток чека на сумму выдаётся чеком с кодом", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  // Заплатил 600 (час), поиграл 20 минут (200) — остаток 400.
  const closed = await playByAmount(admin, db, table, tariff, {
    amount: 600,
    minutes: 20,
  });
  const voucher = closed.issued_voucher;
  assert.ok(voucher, "чек выдан");
  assert.equal(voucher.amount, 400);
  assert.equal(voucher.balance, 400);
  assert.equal(voucher.status, "active");
  assert.match(voucher.code, /^Ч-\d{4}$/, "короткий код для бумажки");

  // Чек виден в списке действующих.
  const list = await admin.get("/api/vouchers");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].code, voucher.code);

  // И находится по коду — кассир вводит его с бумажки.
  const byCode = await admin.get(`/api/vouchers/by-code/${voucher.code}`);
  assert.equal(byCode.status, 200);
  assert.equal(byCode.body.balance, 400);
  // Код можно набрать и просто цифрами.
  const digits = voucher.code.replace(/\D/g, "");
  assert.equal((await admin.get(`/api/vouchers/by-code/${digits}`)).status, 200);
});

test("по чеку открывается время, новых денег не берут", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const first = await playByAmount(admin, db, table, tariff, {
    amount: 600,
    minutes: 20,
  });
  const code = first.issued_voucher.code;

  // Приходит в другой день и играет по чеку.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: code,
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.prepaid_amount, 400, "чек дал 400");
  assert.equal(opened.body.prepaid_seconds, 40 * 60, "400 ₽ = 40 минут");
  assert.equal(opened.body.prepaid_mode, "voucher");
  assert.equal(opened.body.voucher_code, code, "видно, каким чеком оплачено");
  assert.equal(opened.body.paid_by_voucher, 400);

  // Чек списан: второй раз им не сыграть.
  const used = await admin.get(`/api/vouchers/by-code/${code}`);
  assert.equal(used.body.status, "used");
  assert.equal(used.body.balance, 0);
  await admin.post(`/api/tables/${table.id}/close`).send({});
  const again = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: code,
  });
  assert.equal(again.status, 409);
  assert.match(again.body.detail, /использован/);
});

test("игра по чеку не создаёт выручку второй раз", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  // Визит 1: заплатил 600 наличными, поиграл 20 минут.
  const first = await playByAmount(admin, db, table, tariff, {
    amount: 600,
    minutes: 20,
  });
  assert.equal(first.total_cost, 600, "вся оплата — выручка визита");
  const code = first.issued_voucher.code;

  // Визит 2: играет по чеку (400) целиком.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: code,
  });
  playedFor(db, opened.body.id, 40); // ровно то, что дал чек
  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.paid_by_voucher, 400);
  assert.equal(check.body.total, 0, "новых денег нет");
  assert.equal(check.body.due, 0);
  assert.equal(check.body.change, 0);

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 0, "второй раз деньги не считаем");
  assert.equal(closed.body.payment_method, "voucher");

  // Итог: в отчёте одна выручка 600, а не 1000.
  const overview = await admin.get("/api/stats/overview");
  assert.equal(overview.body.month.revenue, 600, "выручка за месяц — только реальные деньги");
  assert.equal(overview.body.month.sessions, 2, "а сеансов при этом два");
});

test("касса сходится: оплата остаётся в ящике, чек её не удваивает", async () => {
  const { db, app } = makeApp();
  // Смену открываем сами, с наличными на начало.
  const admin = await adminAgent(app, { withShift: false });
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  await admin.post("/api/shifts/open").send({ opening_cash: 1000 });

  // Гость заплатил 600 наличными, поиграл 20 минут, получил чек на 400.
  const first = await playByAmount(admin, db, table, tariff, {
    amount: 600,
    minutes: 20,
  });
  const code = first.issued_voucher.code;

  // Тот же день: другой гость играет по чеку — денег в кассу не приносит.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: code,
  });
  playedFor(db, opened.body.id, 10);
  await admin.post(`/api/tables/${table.id}/close`).send({});

  // В ящике должно быть 1000 + 600. Столько и ждём.
  const closedShift = await admin.post("/api/shifts/close").send({ closing_cash: 1600 });
  assert.equal(closedShift.status, 200);
  assert.equal(closedShift.body.expected_cash, 1600, "расчётные наличные");
  assert.equal(closedShift.body.cash_discrepancy, 0, "касса сошлась");
  assert.equal(closedShift.body.cash, 600, "наличная выручка — только реальная оплата");
});

test("не догулял по чеку — выдаётся новый чек на остаток", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const first = await playByAmount(admin, db, table, tariff, {
    amount: 600,
    minutes: 0,
  });
  const firstCode = first.issued_voucher.code;
  assert.equal(first.issued_voucher.balance, 600, "не играл вовсе — весь чек");

  // Играет по чеку 10 минут из 60 — остаток снова в чек.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: firstCode,
  });
  playedFor(db, opened.body.id, 10);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.ok(closed.body.issued_voucher, "новый чек выдан");
  assert.equal(closed.body.issued_voucher.balance, 500, "600 − 100 за 10 минут");
  assert.notEqual(closed.body.issued_voucher.code, firstCode, "новый код");
  assert.equal(closed.body.total_cost, 0, "выручки нет — деньги были раньше");
});

test("засиделся по чеку — доплата за перебор", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  const item = await admin.post("/api/menu").send({ name: "Кофе", price: 150 });

  const first = await playByAmount(admin, db, table, tariff, {
    amount: 300,
    minutes: 0,
  });
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: first.issued_voucher.code,
  });
  await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id });
  playedFor(db, opened.body.id, 45); // чек давал 30 минут, играл 45

  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.overtime_seconds, 15 * 60);
  assert.equal(check.body.total, 150 + 150, "перебор 15 мин (150) + бар (150)");
  assert.equal(check.body.due, 300, "всё это доплачивает");
  assert.equal(check.body.voucher_out, 0, "остатка нет");

  const closed = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "card" });
  assert.equal(closed.body.total_cost, 300);
  assert.equal(closed.body.payment_method, "card");
  assert.equal(closed.body.issued_voucher, null);
});

test("чек привязывается к клиенту и виден в его чеках", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const client = (await admin.post("/api/clients").send({ name: "Пётр" })).body;

  const closed = await playByAmount(admin, db, table, tariff, {
    amount: 600,
    minutes: 10,
    clientId: client.id,
  });
  assert.equal(closed.issued_voucher.client_id, client.id);
  assert.equal(closed.issued_voucher.client_name, "Пётр");

  const list = await admin.get(`/api/vouchers?client_id=${client.id}`);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].code, closed.issued_voucher.code);
});

test("«на время» по-прежнему даёт сдачу деньгами, а не чек", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });
  playedFor(db, opened.body.id, 40);
  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.change, 200, "сдача деньгами");
  assert.equal(check.body.voucher_out, 0, "чек не выдаём");

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.issued_voucher, null);
});

test("неизвестный, отменённый и пустой код не пускают за стол", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const unknown = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id, mode: "voucher", voucher_code: "Ч-0000",
  });
  assert.equal(unknown.status, 409);
  assert.match(unknown.body.detail, /не найден/);

  const empty = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id, mode: "voucher", voucher_code: "  ",
  });
  assert.equal(empty.status, 409);
  assert.match(empty.body.detail, /код чека/i);

  // Отменённый чек тоже не годится.
  const first = await playByAmount(admin, db, table, tariff, { amount: 600, minutes: 0 });
  const voucher = first.issued_voucher;
  assert.equal((await admin.delete(`/api/vouchers/${voucher.id}`)).status, 200);
  const cancelled = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id, mode: "voucher", voucher_code: voucher.code,
  });
  assert.equal(cancelled.status, 409);
  assert.match(cancelled.body.detail, /отменён/);
});

test("использованный чек отменить нельзя, права на отмену — по настройкам", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const first = await playByAmount(admin, db, table, tariff, { amount: 600, minutes: 0 });
  const code = first.issued_voucher.code;
  await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id, mode: "voucher", voucher_code: code,
  });
  const used = (await admin.get(`/api/vouchers/by-code/${code}`)).body;
  const res = await admin.delete(`/api/vouchers/${used.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /использован/);

  // Кассиру отмена закрыта.
  const { cashierAgent } = await import("./helpers.js");
  const cashier = await cashierAgent(app, db);
  assert.equal((await cashier.delete(`/api/vouchers/${used.id}`)).status, 403);
});

test("чек можно продлить деньгами: остаток считается от всей суммы", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const first = await playByAmount(admin, db, table, tariff, { amount: 300, minutes: 0 });
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: first.issued_voucher.code,
  });
  assert.equal(opened.body.prepaid_amount, 300);

  // Доплатил 300 наличными — стало 600 (час).
  const extended = await admin.post(`/api/tables/${table.id}/extend`).send({
    amount: 300,
    payment_method: "cash",
  });
  assert.equal(extended.body.prepaid_amount, 600);
  assert.equal(extended.body.prepaid_seconds, 3600);

  // Поиграл 20 минут (200). Своих денег внёс 300 → выручка 300,
  // остаток 400 уходит в новый чек.
  playedFor(db, opened.body.id, 20);
  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.total, 300, "выручка — только доплата");
  assert.equal(check.body.voucher_out, 400, "остаток от всей суммы");
  assert.equal(check.body.due, 0, "доплата уже внесена при продлении");

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.issued_voucher.balance, 400);
});
