// Канарейка на деньги. Эти проверки не про конкретную функцию, а про то,
// что клуб не теряет и не выдумывает деньги, когда гость играет по чеку
// несколько раз подряд.
//
// Денежная модель клуба (важно понимать, прежде чем что-то менять):
// • выручка признаётся В МОМЕНТ ОПЛАТЫ, а не когда гость доиграл. Заплатил
//   600 за «чек на сумму» — вся 600 сразу в выручке смены;
// • неиспользованный остаток не возвращается деньгами, а висит чеком —
//   это обязательство клуба, а не минус из выручки;
// • игра по чеку новой выручки НЕ даёт: эти деньги посчитали в прошлый раз
//   (в computeCheck остаток чека вычитается как booked).
//
// Отсюда два инварианта, которые обязаны держаться всегда:
//   1. живые деньги, полученные от гостя = сумма выручки по его сеансам;
//   2. потрачено по чеку + остаток на чеке = то, что за чек заплатили.

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

/** Сумма остатков всех действующих чеков в базе. */
function activeVoucherBalance(db) {
  return (
    db
      .prepare(
        "SELECT COALESCE(SUM(balance_kopecks), 0) AS total FROM vouchers WHERE status = 'active'"
      )
      .get().total / 100
  );
}

/** Суммарная признанная выручка по всем закрытым сеансам. */
function recognisedRevenue(db) {
  return (
    db
      .prepare(
        "SELECT COALESCE(SUM(total_cost_kopecks), 0) AS total FROM table_sessions WHERE ended_at IS NOT NULL"
      )
      .get().total / 100
  );
}

test("три круга игры по чеку: деньги не теряются и не удваиваются", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600); // 600/час → 100 за 10 минут

  // Круг 1: гость платит 600 живыми деньгами и играет 10 минут.
  const first = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 600,
    payment_method: "cash",
  });
  assert.equal(first.status, 201);
  playedFor(db, first.body.id, 10);
  const closed1 = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed1.status, 200);

  const ЖИВЫЕ_ДЕНЬГИ = 600;
  assert.equal(
    recognisedRevenue(db),
    ЖИВЫЕ_ДЕНЬГИ,
    "вся полученная сумма сразу признана выручкой"
  );
  assert.equal(activeVoucherBalance(db), 500, "недоигранное висит чеком");

  // Круги 2 и 3: играет по чеку, живых денег больше не вносит.
  let code = closed1.body.issued_voucher.code;
  for (const круг of [2, 3]) {
    const opened = await admin.post(`/api/tables/${table.id}/open`).send({
      tariff_id: tariff.id,
      mode: "voucher",
      voucher_code: code,
    });
    assert.equal(opened.status, 201, `круг ${круг}: стол открыт по чеку`);
    playedFor(db, opened.body.id, 10);
    const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
    assert.equal(closed.status, 200, `круг ${круг}: стол закрыт`);
    assert.equal(closed.body.total_cost, 0, `круг ${круг}: игра по чеку выручки не даёт`);
    code = closed.body.issued_voucher.code;
  }

  // ИНВАРИАНТ 1: выручка равна живым деньгам — ни копейкой больше.
  assert.equal(
    recognisedRevenue(db),
    ЖИВЫЕ_ДЕНЬГИ,
    "три круга игры не добавили клубу выручки из воздуха"
  );

  // ИНВАРИАНТ 2: потрачено + остаток = уплачено.
  const остаток = activeVoucherBalance(db);
  const потрачено = 3 * 100; // три круга по 10 минут при 600/час
  assert.equal(
    потрачено + остаток,
    ЖИВЫЕ_ДЕНЬГИ,
    "сколько сыграно плюс сколько осталось — ровно столько, сколько заплатили"
  );
  assert.equal(остаток, 300, "остаток уменьшался ровно на сыгранное");
});

test("касса смены видит живые деньги один раз, а не на каждый круг", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);

  const first = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 600,
    payment_method: "cash",
  });
  playedFor(db, first.body.id, 10);
  const closed1 = await admin.post(`/api/tables/${table.id}/close`).send({});

  const opened2 = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "voucher",
    voucher_code: closed1.body.issued_voucher.code,
  });
  playedFor(db, opened2.body.id, 10);
  await admin.post(`/api/tables/${table.id}/close`).send({});

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 600, "в наличных ровно то, что гость принёс");
  assert.equal(shift.body.revenue, 600, "выручка смены не удвоилась от игры по чеку");
  assert.equal(
    shift.body.expected_cash,
    600,
    "в ящике должно быть ровно 600 — сдачи по чеку не бывает"
  );
});

test("остаток чека никогда не превышает уплаченного за него", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);

  // Гость заплатил 600 и не играл вовсе — весь чек должен вернуться, но
  // ни копейкой больше.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 600,
    payment_method: "cash",
  });
  assert.equal(opened.status, 201);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});

  assert.ok(
    closed.body.issued_voucher.balance <= 600,
    "чек не может стоить больше, чем за него заплатили"
  );
  // Сколько сыграно — столько и списано с чека, остальное вернулось.
  const сыграно = closed.body.time_cost;
  assert.equal(
    activeVoucherBalance(db) + сыграно,
    600,
    "остаток чека плюс сыгранное = уплаченное"
  );
  assert.equal(recognisedRevenue(db), 600, "выручка — вся полученная сумма");
});
