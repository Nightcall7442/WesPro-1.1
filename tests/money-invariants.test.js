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

// --- Счёт клиента ---------------------------------------------------------
//
// Пополнение — это ещё не выручка: гость просто отдал деньги в кассу
// заранее. Выручкой они становятся в ДЕНЬ ИГРЫ, когда гость на них
// действительно поиграл. Поэтому в кассе такие деньги считаются один раз
// (при пополнении, движением «внесено»), а в выручке — один раз (в день
// игры). Двойного счёта быть не должно ни там, ни там.

/** Остаток счёта клиента (только пополнения), в рублях. */
function accountBalance(db, clientId) {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(balance_kopecks), 0) AS total FROM vouchers
          WHERE client_id = ? AND kind = 'topup' AND status = 'active'`
      )
      .get(clientId).total / 100
  );
}

async function makeClient(agent, name = "Гость Счётный") {
  const res = await agent.post("/api/clients").send({ name });
  if (res.status !== 201) throw new Error(`createClient: ${res.status}`);
  return res.body;
}

test("пополнение — это не выручка: деньги признаются в день игры", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  // Гость кладёт 1000 наличными.
  const topup = await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 1000, payment_method: "cash" });
  assert.equal(topup.status, 201);

  let shift = await admin.get("/api/shifts/current");
  assert.equal(recognisedRevenue(db), 0, "пополнение выручкой ещё не стало");
  assert.equal(shift.body.cash_in, 1000, "деньги легли в кассу движением «внесено»");
  assert.equal(shift.body.revenue, 0, "выручки смены пополнение не добавило");
  assert.equal(shift.body.expected_cash, 1000, "в ящике должна быть тысяча");

  // Играет постоплатой на 600 — деньги должны уйти со счёта сами.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
  });
  assert.equal(opened.status, 201);
  playedFor(db, opened.body.id, 60);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.status, 200);

  assert.equal(closed.body.total_cost, 600, "сыграно на 600");
  assert.equal(closed.body.payment_method, "balance", "оплачено со счёта, а не деньгами");
  assert.equal(accountBalance(db, client.id), 400, "на счету осталось 400");
  assert.equal(recognisedRevenue(db), 600, "выручка признана в день игры");

  shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 0, "наличной выручки нет — деньги пришли раньше");
  assert.equal(shift.body.account, 600, "оплата со счёта видна отдельной строкой");
  assert.equal(shift.body.revenue, 600, "выручка смены — ровно сыгранное");
  assert.equal(
    shift.body.expected_cash,
    1000,
    "в ящике по-прежнему тысяча: со счёта деньги повторно не берутся"
  );
});

test("счёта не хватило — разницу гость доплачивает деньгами, и только её", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 300, payment_method: "cash" });

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
  });
  playedFor(db, opened.body.id, 60);

  // Кассир видит разбивку заранее — иначе возьмёт с гостя лишнее.
  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.due, 600);
  assert.equal(check.body.due_from_account, 300, "300 уйдёт со счёта");
  assert.equal(check.body.due_money, 300, "300 берём деньгами");

  const closed = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "cash" });
  assert.equal(closed.body.total_cost, 600);
  assert.equal(closed.body.payment_method, "cash", "часть взяли деньгами");
  assert.equal(accountBalance(db, client.id), 0, "счёт израсходован до нуля");

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 300, "в наличных только доплата");
  assert.equal(shift.body.account, 300, "остальное — со счёта");
  assert.equal(shift.body.revenue, 600, "выручка целиком");
  assert.equal(
    shift.body.expected_cash,
    600,
    "в ящике 300 от пополнения плюс 300 доплаты"
  );
});

test("оплатил час со счёта, доиграл полчаса — разница возвращается на счёт", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 1000, payment_method: "cash" });

  // Час вперёд — способ оплаты не нужен, счёт закрывает всю сумму.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
    mode: "time",
    minutes: 60,
  });
  assert.equal(opened.status, 201, "деньги за предоплату брать не надо");
  assert.equal(accountBalance(db, client.id), 400, "со счёта сразу списан час");

  playedFor(db, opened.body.id, 30);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 300, "сыграно полчаса");
  assert.equal(
    accountBalance(db, client.id),
    700,
    "недоигранные 300 вернулись на счёт, а не выданы из кассы"
  );

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 0, "из кассы сдачу не выдавали");
  assert.equal(shift.body.revenue, 300, "выручка — только сыгранное");
  assert.equal(
    shift.body.expected_cash,
    1000,
    "в ящике та же тысяча: сдача ушла на счёт клиента"
  );
});

test("деньги клиента не пропадают: пополнено = сыграно + остаток на счету", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 1000, payment_method: "cash" });

  // Три визита подряд по 10 минут (по 100 за визит).
  for (const визит of [1, 2, 3]) {
    const opened = await admin.post(`/api/tables/${table.id}/open`).send({
      tariff_id: tariff.id,
      client_id: client.id,
    });
    assert.equal(opened.status, 201, `визит ${визит}: стол открыт`);
    playedFor(db, opened.body.id, 10);
    const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
    assert.equal(closed.status, 200, `визит ${визит}: стол закрыт`);
  }

  assert.equal(
    recognisedRevenue(db) + accountBalance(db, client.id),
    1000,
    "сыгранное плюс остаток счёта = внесённое, ни копейкой больше"
  );
  assert.equal(accountBalance(db, client.id), 700, "с трёх визитов ушло 300");
});

test("кассир может не трогать счёт: гость платит деньгами", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 1000, payment_method: "cash" });

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
  });
  playedFor(db, opened.body.id, 60);
  const closed = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "cash", use_balance: false });

  assert.equal(closed.body.payment_method, "cash");
  assert.equal(accountBalance(db, client.id), 1000, "счёт остался нетронутым");

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 600, "все 600 взяли наличными");
  assert.equal(shift.body.expected_cash, 1600, "в ящике пополнение плюс оплата");
});

test("чек на остаток сам не списывается — гость называет его код", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  // Гость оставил недоигранное — на остаток выдан чек с кодом.
  const first = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
    mode: "amount",
    amount: 600,
    payment_method: "cash",
  });
  playedFor(db, first.body.id, 10);
  const closed1 = await admin.post(`/api/tables/${table.id}/close`).send({});
  const code = closed1.body.issued_voucher.code;
  assert.equal(closed1.body.issued_voucher.balance, 500);

  // Следующий визит постоплатой: чек на остаток трогать нельзя — он у
  // гостя на руках, и он сам решает, когда им играть.
  const second = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
  });
  playedFor(db, second.body.id, 10);
  const closed2 = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "cash" });

  assert.equal(closed2.body.payment_method, "cash", "взяли деньгами, чек не тронули");
  const voucher = await admin.get(`/api/vouchers/by-code/${code}`);
  assert.equal(voucher.body.balance, 500, "остаток чека не изменился");
  assert.equal(voucher.body.status, "active");
});

test("продление тоже идёт со счёта клиента", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);
  const client = await makeClient(admin);

  await admin
    .post(`/api/clients/${client.id}/topup`)
    .send({ amount: 1000, payment_method: "cash" });

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    client_id: client.id,
    mode: "time",
    minutes: 30,
  });
  assert.equal(opened.status, 201);
  assert.equal(accountBalance(db, client.id), 700, "полчаса — 300 со счёта");

  // Способ оплаты не указываем: на счету хватает.
  const extended = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 30 });
  assert.equal(extended.status, 200);
  assert.equal(accountBalance(db, client.id), 400, "продление тоже ушло со счёта");

  playedFor(db, opened.body.id, 60);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 600, "сыгран целый час");
  assert.equal(closed.body.payment_method, "balance");

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 0);
  assert.equal(shift.body.revenue, 600);
  assert.equal(shift.body.expected_cash, 1000, "в ящике только пополнение");
});

test("без клиента ничего не списывается — обычная оплата деньгами", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);

  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  playedFor(db, opened.body.id, 60);
  const closed = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "cash" });

  assert.equal(closed.body.payment_method, "cash");
  assert.equal(closed.body.paid_from_account, 0);
  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 600);
  assert.equal(shift.body.account, 0);
});
