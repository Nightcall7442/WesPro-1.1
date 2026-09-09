// Тесты функций кассы: способы оплаты, пересдача кассы, бар, скидки,
// брони, тарифные расписания, настройки клуба, отчёт по выручке, чек.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import {
  adminAgent,
  cashierAgent,
  createTable,
  createTariff,
  makeApp,
} from "./helpers.js";

// --- Способ оплаты и разбивка смены ---------------------------------------

test("способ оплаты сохраняется в сеансе и в разбивке смены", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  await admin.post("/api/shifts/open").send({ opening_cash: 1000 });
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  const closed = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "card" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.payment_method, "card");

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.sessions_count, 1);
  assert.equal(shift.body.card, closed.body.total_cost);
  assert.equal(shift.body.cash, 0);
});

test("недопустимый способ оплаты отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });

  const res = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "crypto" });
  assert.equal(res.status, 409);
});

test("пересдача кассы: расчётные наличные и расхождение", async () => {
  const { db, app } = makeApp();
  // Смену тест открывает сам — с наличными на начало.
  const admin = await adminAgent(app, { withShift: false });
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  await admin.post("/api/shifts/open").send({ opening_cash: 500 });
  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  // Час назад, чтобы был заметный итог (600 ₽ наличными).
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    hourAgo,
    opened.body.id
  );
  await admin.post(`/api/tables/${table.id}/close`).send({ payment_method: "cash" });

  const closed = await admin.post("/api/shifts/close").send({ closing_cash: 1000 });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.opening_cash, 500);
  // Ожидаем в кассе 500 + ~600; сдали 1000 -> недостача около -100.
  assert.ok(Math.abs(closed.body.expected_cash - 1100) < 1);
  assert.ok(closed.body.cash_discrepancy < -99 && closed.body.cash_discrepancy > -101);
});

// --- Бар -------------------------------------------------------------------

test("бар: заказ входит в чек и в итог сеанса", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const item = await admin
    .post("/api/menu")
    .send({ name: "Кофе", price: 150, category: "Напитки" });
  assert.equal(item.status, 201);

  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  const order = await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id, quantity: 2 });
  assert.equal(order.status, 201);
  assert.equal(order.body.bar_total, 300);

  const check = await admin.get(`/api/tables/${table.id}/check`);
  assert.equal(check.body.bar_cost, 300);
  assert.equal(check.body.orders.length, 1);

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.bar_cost, 300);
  assert.ok(closed.body.total_cost >= 300);
});

test("бар: позицию нельзя добавить на свободный стол и удалить после закрытия", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const item = await admin.post("/api/menu").send({ name: "Чай", price: 100 });

  const onFree = await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id });
  assert.equal(onFree.status, 409);

  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  const order = await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id });
  await admin.post(`/api/tables/${table.id}/close`).send({});
  const del = await admin.delete(`/api/orders/${order.body.orders[0].id}`);
  assert.equal(del.status, 409);
});

test("меню: создание и правка — только администратор", async () => {
  const { db, app } = makeApp();
  const cashier = await cashierAgent(app, db);
  assert.equal(
    (await cashier.post("/api/menu").send({ name: "X", price: 10 })).status,
    403
  );
  assert.equal((await cashier.get("/api/menu")).status, 200);
});

// --- Клиенты и скидки ------------------------------------------------------

test("скидка клиента применяется к времени, но не к бару", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = await admin
    .post("/api/clients")
    .send({ name: "Постоянный", phone: "+7 900 000-00-00" });
  await admin.put(`/api/clients/${client.body.id}`).send({ discount_percent: 50 });
  const item = await admin.post("/api/menu").send({ name: "Кофе", price: 100 });

  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.body.id });
  assert.equal(opened.body.client_name, "Постоянный");
  assert.equal(opened.body.discount_percent, 50);

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    hourAgo,
    opened.body.id
  );
  await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id });

  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  // Время ~600 ₽ со скидкой 50% = ~300 ₽, бар 100 ₽ без скидки -> ~400 ₽.
  assert.ok(Math.abs(closed.body.total_cost - 400) < 1, String(closed.body.total_cost));
});

test("кассир не может менять скидку клиента", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const client = await admin.post("/api/clients").send({ name: "К" });
  const cashier = await cashierAgent(app, db);
  const res = await cashier
    .put(`/api/clients/${client.body.id}`)
    .send({ discount_percent: 90 });
  assert.equal(res.status, 403);
});

// --- Настройки клуба -------------------------------------------------------

test("округление итога и минимальное время сеанса", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  await admin.put("/api/settings").send({
    rounding_step_kopecks: "1000", // до 10 ₽
    min_session_minutes: "30",
  });

  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  // Закрываем почти сразу: минимальные 30 минут по 600 ₽/час = 300 ₽.
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 300);
  assert.equal(closed.body.total_cost % 10, 0);
});

test("недопустимые значения настроек клуба отклоняются", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  assert.equal(
    (await admin.put("/api/settings").send({ rounding_step_kopecks: "7" })).status,
    409
  );
  assert.equal(
    (await admin.put("/api/settings").send({ min_session_minutes: "999" })).status,
    409
  );
  assert.equal(
    (await admin.put("/api/settings").send({ club_name: "" })).status,
    409
  );
});

// --- Брони -----------------------------------------------------------------

test("бронь: создание, пересечение, отмена, подсветка на дашборде", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);

  const inHour = new Date(Date.now() + 3600 * 1000).toISOString();
  const booking = await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Сергей",
    starts_at: inHour,
    duration_minutes: 60,
  });
  assert.equal(booking.status, 201);

  // Пересечение с той же бронью.
  const overlap = await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Другой",
    starts_at: new Date(Date.now() + 90 * 60000).toISOString(),
    duration_minutes: 60,
  });
  assert.equal(overlap.status, 409);

  const dashboard = await admin.get("/api/dashboard");
  const row = dashboard.body.find((t) => t.id === table.id);
  assert.equal(row.booking.client_name, "Сергей");
  // Конец брони считает сервер — по нему кассир видит, до какого часа
  // стол занят и когда снова свободен.
  assert.equal(
    row.booking.ends_at,
    new Date(Date.parse(inHour) + 60 * 60000).toISOString(),
    "конец брони = начало + длительность"
  );

  const cancelled = await admin.post(`/api/bookings/${booking.body.id}/cancel`);
  assert.equal(cancelled.body.status, "cancelled");
  const after = await admin.get("/api/bookings");
  assert.equal(after.body.length, 0);
});

test("бронь в прошлом отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const res = await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Некто",
    starts_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    duration_minutes: 60,
  });
  assert.equal(res.status, 409);
});

// --- Тарифные расписания ---------------------------------------------------

test("тарифное расписание подставляет тариф по времени", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await createTable(admin);
  const day = await createTariff(admin, "Дневной", 400);
  const night = await createTariff(admin, "Ночной", 300);

  // Круглосуточные правила на все дни: день 8:00–22:00, ночь 22:00–8:00.
  const allDays = [1, 2, 3, 4, 5, 6, 7];
  await admin.post("/api/tariff-rules").send({
    tariff_id: day.id,
    days: allDays,
    start_minute: 8 * 60,
    end_minute: 22 * 60,
  });
  await admin.post("/api/tariff-rules").send({
    tariff_id: night.id,
    days: allDays,
    start_minute: 22 * 60,
    end_minute: 8 * 60, // через полночь
  });

  const auto = await admin.get("/api/tariffs/auto");
  assert.equal(auto.status, 200);
  // В любой момент суток должно найтись одно из двух правил.
  assert.ok([day.id, night.id].includes(auto.body.tariff_id));

  const rules = await admin.get("/api/tariff-rules");
  assert.equal(rules.body.length, 2);
  const del = await admin.delete(`/api/tariff-rules/${rules.body[0].id}`);
  assert.equal(del.status, 200);
});

test("правило с некорректными днями отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const tariff = await createTariff(admin);
  const res = await admin.post("/api/tariff-rules").send({
    tariff_id: tariff.id,
    days: [0, 8],
    start_minute: 0,
    end_minute: 60,
  });
  assert.equal(res.status, 409);
});

// --- Отчёт по выручке и чек ------------------------------------------------

test("отчёт по выручке: дни и пиковые часы", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  await admin.post(`/api/tables/${table.id}/close`).send({ payment_method: "card" });

  const report = await admin.get("/api/stats/revenue?days=7");
  assert.equal(report.status, 200);
  assert.equal(report.body.hours.length, 24);
  const totalSessions = report.body.days.reduce((n, d) => n + d.sessions_count, 0);
  assert.equal(totalSessions, 1);
  assert.equal(
    report.body.hours.reduce((n, h) => n + h.sessions_count, 0),
    1
  );
});

test("чек сеанса: полные данные с позициями бара", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const item = await admin.post("/api/menu").send({ name: "Кофе", price: 150 });

  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  await admin
    .post(`/api/tables/${table.id}/orders`)
    .send({ menu_item_id: item.body.id, quantity: 2 });
  const closed = await admin
    .post(`/api/tables/${table.id}/close`)
    .send({ payment_method: "cash" });

  const receipt = await admin.get(`/api/sessions/${closed.body.id}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.orders.length, 1);
  assert.equal(receipt.body.orders[0].quantity, 2);
  assert.equal(receipt.body.payment_method, "cash");
  assert.ok(receipt.body.club_name);
});

// --- Касса обязательна ------------------------------------------------------

test("без открытой смены стол не открыть — кроме владельца", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  // Администратор без смены — нельзя.
  const denied = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(denied.status, 409);
  assert.match(denied.body.detail, /кассовую смену/);

  // Открыл смену — можно.
  await admin.post("/api/shifts/open").send({});
  const allowed = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(allowed.status, 201);
  await admin.post(`/api/tables/${table.id}/close`).send({});

  // Кассиру — тоже нельзя без смены.
  const cashier = await cashierAgent(app, db);
  const cashierDenied = await cashier
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(cashierDenied.status, 409);

  // Владельцу смена не нужна.
  await admin.post("/api/users").send({
    login: "Vladelec", name: "Владелец", password: "owner1", role: "owner",
  });
  const owner = supertest.agent(app);
  await owner.post("/api/auth/login").send({ login: "vladelec", password: "owner1" });
  assert.equal((await owner.get("/api/auth/me")).body.shift, null, "смены нет");
  const ownerOpen = await owner
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(ownerOpen.status, 201, "владелец открывает без смены");
});

test("без смены нельзя ни закрыть стол, ни продлить чек", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id, mode: "time", minutes: 60, payment_method: "cash",
  });

  // Закрываем смену — стол остался открытым.
  await admin.post("/api/shifts/close").send({});

  const closeDenied = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closeDenied.status, 409);
  const extendDenied = await admin
    .post(`/api/tables/${table.id}/extend`)
    .send({ minutes: 30, payment_method: "cash" });
  assert.equal(extendDenied.status, 409);
});
