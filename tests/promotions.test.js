// Акции: «счастливый час» (скидка по дням и часам) и «каждый N-й час
// в подарок» (подарочный чек постоянному гостю).

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

/** Правило «весь день, все дни» — чтобы тест не зависел от часа прогона. */
const ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 1440 };

/** Сдвигает начало сеанса в прошлое. */
function playedFor(db, sessionId, minutes) {
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    new Date(Date.now() - minutes * 60 * 1000).toISOString(),
    sessionId
  );
}

test("счастливый час даёт скидку на время игры", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час

  const promo = await admin
    .post("/api/promotions")
    .send({ name: "Утро дешевле", discount_percent: 25, ...ALL_DAY });
  assert.equal(promo.status, 201);
  assert.equal(promo.body.discount_percent, 25);

  const active = await admin.get("/api/promotions/active");
  assert.equal(active.body.promotion.name, "Утро дешевле");

  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(opened.body.discount_percent, 25, "скидка зафиксирована в сеансе");
  assert.equal(opened.body.promo_name, "Утро дешевле");

  playedFor(db, opened.body.id, 60);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.total_cost, 450, "600 − 25%");
});

test("скидки клиента и акции не складываются — берётся бо́льшая", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const other = await createTable(admin, "Стол 2");
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = await admin.post("/api/clients").send({ name: "VIP" });
  await admin.put(`/api/clients/${client.body.id}`).send({ discount_percent: 40 });

  await admin
    .post("/api/promotions")
    .send({ name: "Счастливый час", discount_percent: 20, ...ALL_DAY });

  // У клиента скидка больше — она и действует, акция не добавляется.
  const vip = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.body.id });
  assert.equal(vip.body.discount_percent, 40);
  assert.equal(vip.body.promo_name, null, "скидку дал не «счастливый час»");
  playedFor(db, vip.body.id, 60);
  const vipClosed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(vipClosed.body.total_cost, 360, "600 − 40%, а не −60%");

  // У гостя без карты работает акция.
  const guest = await admin
    .post(`/api/tables/${other.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(guest.body.discount_percent, 20);
  assert.equal(guest.body.promo_name, "Счастливый час");
});

test("выключенная акция не действует, включённая — снова да", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const promo = await admin
    .post("/api/promotions")
    .send({ name: "Ночь", discount_percent: 30, ...ALL_DAY });

  await admin.put(`/api/promotions/${promo.body.id}`).send({ is_active: false });
  const off = await admin.get("/api/promotions/active");
  assert.equal(off.body.promotion, null, "выключенная акция не действует");

  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(opened.body.discount_percent, 0);
  await admin.post(`/api/tables/${table.id}/close`).send({});

  await admin.put(`/api/promotions/${promo.body.id}`).send({ is_active: true });
  const on = await admin.get("/api/promotions/active");
  assert.equal(on.body.promotion.name, "Ночь");

  await admin.delete(`/api/promotions/${promo.body.id}`);
  const gone = await admin.get("/api/promotions");
  assert.equal(gone.body.length, 0);
});

test("акция вне своего интервала не действует", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  // Интервал в одну минуту в прошлом/будущем — почти наверняка не «сейчас».
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const far = (minute + 300) % 1440;
  await admin.post("/api/promotions").send({
    name: "Не сейчас",
    discount_percent: 50,
    days: [1, 2, 3, 4, 5, 6, 7],
    start_minute: far,
    end_minute: (far + 1) % 1440,
  });
  const active = await admin.get("/api/promotions/active");
  assert.equal(active.body.promotion, null);
});

test("акция проверяет свои поля", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const noName = await admin
    .post("/api/promotions")
    .send({ name: "  ", discount_percent: 10, ...ALL_DAY });
  assert.equal(noName.status, 409);

  const badPercent = await admin
    .post("/api/promotions")
    .send({ name: "Акция", discount_percent: 0, ...ALL_DAY });
  assert.equal(badPercent.status, 409);

  const noDays = await admin
    .post("/api/promotions")
    .send({ name: "Акция", discount_percent: 10, days: [], start_minute: 0, end_minute: 60 });
  assert.equal(noDays.status, 409);
});

test("каждый N-й час игры дарит чек на бесплатный час", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = await admin.post("/api/clients").send({ name: "Постоянный" });
  await admin.put("/api/settings").send({ bonus_every_hours: "3" });

  // Два часа — подарка ещё нет.
  for (const minutes of [60, 60]) {
    const opened = await admin
      .post(`/api/tables/${table.id}/open`)
      .send({ tariff_id: tariff.id, client_id: client.body.id });
    playedFor(db, opened.body.id, minutes);
    const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
    assert.equal(closed.body.bonus_voucher, null, "рубеж не пройден");
  }

  // Третий час — подарок.
  const third = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.body.id });
  playedFor(db, third.body.id, 60);
  const gift = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.ok(gift.body.bonus_voucher, "подарочный чек выдан");
  assert.equal(gift.body.bonus_voucher.bonus_hours, 1);
  assert.equal(gift.body.bonus_voucher.balance, 600, "час по цене тарифа");
  assert.match(gift.body.bonus_voucher.code, /^Ч-\d{4}$/);
  assert.equal(gift.body.bonus_voucher.client_name, "Постоянный");

  // Четвёртый час — второй раз тот же подарок не выдаётся.
  const fourth = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.body.id });
  playedFor(db, fourth.body.id, 60);
  const again = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(again.body.bonus_voucher, null, "подарок за те же часы не повторяется");
});

test("подарочный чек не создаёт лишней выручки", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin); // 600 ₽/час
  const client = await admin.post("/api/clients").send({ name: "Гость" });
  await admin.put("/api/settings").send({ bonus_every_hours: "1" });

  const first = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.body.id, mode: "time", minutes: 60, payment_method: "cash" });
  playedFor(db, first.body.id, 60);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  const gift = closed.body.bonus_voucher;
  assert.ok(gift, "за час игры выдан подарочный чек");

  // Играем по подарочному чеку.
  const bonusSession = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, mode: "voucher", voucher_code: gift.code });
  assert.equal(bonusSession.status, 201);
  playedFor(db, bonusSession.body.id, 60);
  const bonusClosed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(bonusClosed.body.total_cost, 0, "подарок выручки не даёт");

  const shift = await admin.get("/api/shifts/current");
  assert.equal(shift.body.cash, 600, "в кассе только реальные деньги");
});

test("без настройки подарков акция не работает", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const client = await admin.post("/api/clients").send({ name: "Гость" });

  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id, client_id: client.body.id });
  playedFor(db, opened.body.id, 600);
  const closed = await admin.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closed.body.bonus_voucher, null);
});
