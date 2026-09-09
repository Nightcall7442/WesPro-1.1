// Учёт рабочих часов и начислений: часы берутся из кассовых смен,
// начисление = часы × ставка + выручка смен × процент.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, cashierAgent, createTable, createTariff, makeApp } from "./helpers.js";

/** Сдвигает время открытия смены в прошлое — «отработал N часов». */
function workedFor(db, shiftId, hours) {
  db.prepare("UPDATE shifts SET opened_at = ? WHERE id = ?").run(
    new Date(Date.now() - hours * 3600 * 1000).toISOString(),
    shiftId
  );
}

test("ставка и процент сохраняются в карточке сотрудника", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const created = await admin.post("/api/users").send({
    login: "Kassir1",
    name: "Кассир Один",
    password: "pass12",
    role: "cashier",
  });
  assert.equal(created.body.hourly_rate, 0, "по умолчанию ставки нет");

  const saved = await admin
    .put(`/api/users/${created.body.id}`)
    .send({ hourly_rate: 250.5, revenue_percent: 5 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.hourly_rate, 250.5);
  assert.equal(saved.body.revenue_percent, 5);

  const badRate = await admin
    .put(`/api/users/${created.body.id}`)
    .send({ hourly_rate: -10 });
  assert.equal(badRate.status, 409);

  const badPercent = await admin
    .put(`/api/users/${created.body.id}`)
    .send({ revenue_percent: 150 });
  assert.equal(badPercent.status, 409);
});

test("часы считаются по сменам, начисление — по ставке и проценту", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const me = await admin.get("/api/auth/me");
  await admin
    .put(`/api/users/${me.body.user.id}`)
    .send({ hourly_rate: 200, revenue_percent: 10 });

  const shift = await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  workedFor(db, shift.body.id, 8); // отработал 8 часов

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "time",
    minutes: 60,
    payment_method: "cash",
  });
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    opened.body.id
  );
  await admin.post(`/api/tables/${table.id}/close`).send({});

  const report = await admin.get("/api/payroll?days=30");
  assert.equal(report.status, 200);
  const person = report.body.people.find((p) => p.user_id === me.body.user.id);
  assert.ok(person, "сотрудник в отчёте есть");
  assert.equal(person.shifts_count, 1);
  assert.ok(person.hours >= 8 && person.hours < 8.05, `часы: ${person.hours}`);
  assert.equal(person.revenue, 600, "выручка его смены");
  // Секунда-другая на прогон теста даёт копейки сверху — сравниваем с
  // допуском, а не «символ в символ».
  assert.ok(
    Math.abs(person.pay_for_hours - 1600) < 1,
    `8 ч × 200 = ~1600, получилось ${person.pay_for_hours}`
  );
  assert.equal(person.pay_for_revenue, 60, "10% от 600");
  assert.ok(
    Math.abs(person.pay_total - 1660) < 1,
    `итого ~1660, получилось ${person.pay_total}`
  );
});

test("без ставки и процента начисления нулевые, но часы видны", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const shift = await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  workedFor(db, shift.body.id, 5);

  const report = await admin.get("/api/payroll?days=30");
  const me = await admin.get("/api/auth/me");
  const person = report.body.people.find((p) => p.user_id === me.body.user.id);
  assert.ok(person.hours >= 5 && person.hours < 5.05);
  assert.equal(person.pay_total, 0);
});

test("открытая смена считается до текущего момента", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const shift = await admin.post("/api/shifts/open").send({ opening_cash: 0 });
  workedFor(db, shift.body.id, 3);

  const report = await admin.get("/api/payroll?days=30");
  const me = await admin.get("/api/auth/me");
  const person = report.body.people.find((p) => p.user_id === me.body.user.id);
  assert.ok(person.hours >= 3 && person.hours < 3.05, `смена ещё открыта: ${person.hours} ч`);
});

test("отчёт по зарплате закрыт от того, кому не видны отчёты", async () => {
  const { db, app } = makeApp();
  await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const res = await cashier.get("/api/payroll");
  assert.equal(res.status, 403);
});
