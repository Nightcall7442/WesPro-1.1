// Напоминания о бронях в Telegram. Настоящий Telegram в тестах не
// дёргаем — подменяем fetch и смотрим, что и куда отправляется.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, makeApp } from "./helpers.js";
import { remindUpcomingBookings } from "../src/services/telegram.js";

/** Подменяет fetch и собирает отправленные сообщения. */
function captureTelegram(t, { ok = true, description = "" } = {}) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok,
      status: ok ? 200 : 400,
      json: async () => (ok ? { ok: true } : { ok: false, description }),
    };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

/** Бронь через N минут от «сейчас». */
function inMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

test("без токена и чата напоминания просто выключены", async (t) => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Иван",
    starts_at: inMinutes(30),
    duration_minutes: 60,
  });

  const sent = captureTelegram(t);
  const result = await remindUpcomingBookings(db);
  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0, "в интернет никто не ходил");

  const status = await admin.get("/api/telegram/status");
  assert.equal(status.body.configured, false);
});

test("о ближайшей брони приходит одно сообщение с деталями", async (t) => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin, "Стол 5");
  await admin.put("/api/settings").send({
    telegram_bot_token: "123:AAA",
    telegram_chat_id: "-100500",
    telegram_before_minutes: "60",
  });
  await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Иван Петров",
    phone: "+7 900 111-22-33",
    starts_at: inMinutes(30),
    duration_minutes: 90,
    note: "день рождения",
  });

  const sent = captureTelegram(t);
  const first = await remindUpcomingBookings(db);
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/api\.telegram\.org\/bot123:AAA\/sendMessage$/);
  assert.equal(sent[0].body.chat_id, "-100500");
  assert.match(sent[0].body.text, /бронь: Стол 5/);
  assert.match(sent[0].body.text, /Иван Петров, \+7 900 111-22-33/);
  assert.match(sent[0].body.text, /день рождения/);
  assert.match(sent[0].body.text, /90 мин/);

  // Второй раз о той же брони не пишем.
  const second = await remindUpcomingBookings(db);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1, "повторного сообщения нет");
});

test("о дальней брони пока не напоминаем", async (t) => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  await admin.put("/api/settings").send({
    telegram_bot_token: "123:AAA",
    telegram_chat_id: "-100500",
    telegram_before_minutes: "60",
  });
  await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Пётр",
    starts_at: inMinutes(180), // через три часа
    duration_minutes: 60,
  });

  const sent = captureTelegram(t);
  const result = await remindUpcomingBookings(db);
  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0);
});

test("если сообщение не дошло — попробуем ещё раз позже", async (t) => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  await admin.put("/api/settings").send({
    telegram_bot_token: "123:AAA",
    telegram_chat_id: "-100500",
  });
  await admin.post("/api/bookings").send({
    table_id: table.id,
    client_name: "Ольга",
    starts_at: inMinutes(20),
    duration_minutes: 60,
  });

  captureTelegram(t, { ok: false, description: "chat not found" });
  const failed = await remindUpcomingBookings(db);
  assert.equal(failed.sent, 0, "не дошло — не считаем отправленным");

  const notMarked = db
    .prepare("SELECT reminded_at FROM bookings WHERE client_name = 'Ольга'")
    .get();
  assert.equal(notMarked.reminded_at, null, "отметка не поставлена — попробуем снова");
});

test("проверка связи объясняет, чего не хватает", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  captureTelegram(t);

  const notSet = await admin.post("/api/telegram/test");
  assert.equal(notSet.status, 409);
  assert.match(notSet.body.detail, /токен бота и номер чата/);

  await admin.put("/api/settings").send({
    telegram_bot_token: "123:AAA",
    telegram_chat_id: "-100500",
  });
  const ok = await admin.post("/api/telegram/test");
  assert.equal(ok.status, 200);

  const status = await admin.get("/api/telegram/status");
  assert.equal(status.body.configured, true);
  assert.equal(status.body.before_minutes, 60);
});

test("ошибка Telegram показывается человеческим текстом", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.put("/api/settings").send({
    telegram_bot_token: "123:AAA",
    telegram_chat_id: "-100500",
  });
  captureTelegram(t, { ok: false, description: "Unauthorized" });

  const res = await admin.post("/api/telegram/test");
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /Unauthorized/);
});
