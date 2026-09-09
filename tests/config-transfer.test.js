// Перенос настройки клуба на другой компьютер: тарифы, акции, план зала
// и права переезжают, а история — нет.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

const ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 1440 };

test("настройка переезжает на чистую базу без истории", async () => {
  // Клуб-донор: настроен и поработал.
  const source = makeApp();
  const admin = await adminAgent(source.app);
  await admin.put("/api/settings").send({
    club_name: "Клуб на Ленина",
    currency: "₸",
    min_session_minutes: "30",
    bonus_every_hours: "5",
    receipt_width: "58",
  });
  const table = await createTable(admin, "Стол у окна");
  const tariff = await createTariff(admin, "Дневной", 400);
  await admin.post("/api/tariff-rules").send({
    tariff_id: tariff.id,
    days: [1, 2, 3],
    start_minute: 600,
    end_minute: 1080,
  });
  await admin
    .post("/api/promotions")
    .send({ name: "Утро дешевле", discount_percent: 25, ...ALL_DAY });
  const client = await admin.post("/api/clients").send({ name: "Постоянный гость" });
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  await admin.post(`/api/tables/${table.id}/close`).send({});

  const exported = await admin.get("/api/config/export");
  assert.equal(exported.status, 200);
  assert.match(exported.headers["content-disposition"], /nastroyki-.*\.json/);
  const config = JSON.parse(exported.text);
  assert.equal(config.format, 1);
  assert.equal(config.settings.club_name, "Клуб на Ленина");
  assert.ok(config.tariffs.some((t) => t.name === "Дневной"));
  assert.ok(config.promotions.some((p) => p.name === "Утро дешевле"));
  assert.ok(config.tables.some((t) => t.name === "Стол у окна"));

  // Истории и людей в файле быть не должно.
  const raw = JSON.stringify(config);
  assert.ok(!raw.includes("Постоянный гость"), "клиентов в файле нет");
  assert.ok(!raw.includes("password"), "паролей в файле нет");
  assert.ok(!config.sessions, "сеансов в файле нет");
  assert.ok(!config.shifts, "смен в файле нет");
  assert.equal(config.settings.telegram_bot_token, undefined, "токен не переносится");

  // Клуб-приёмник: чистая база.
  const target = makeApp();
  const admin2 = await adminAgent(target.app);
  const imported = await admin2.post("/api/config/import").send(config);
  assert.equal(imported.status, 200);
  assert.ok(imported.body.tariffs >= 1);

  const settings = await admin2.get("/api/settings");
  assert.equal(settings.body.club_name, "Клуб на Ленина");
  assert.equal(settings.body.min_session_minutes, "30");
  assert.equal(settings.body.receipt_width, "58");
  assert.equal(settings.body.bonus_every_hours, "5");

  const tariffs = await admin2.get("/api/tariffs");
  assert.ok(tariffs.body.some((t) => t.name === "Дневной" && t.price_per_hour === 400));

  const rules = await admin2.get("/api/tariff-rules");
  assert.ok(rules.body.some((r) => r.tariff_name === "Дневной" && r.start_minute === 600));

  const promos = await admin2.get("/api/promotions");
  assert.ok(promos.body.some((p) => p.name === "Утро дешевле" && p.discount_percent === 25));

  const tables = await admin2.get("/api/tables");
  assert.ok(tables.body.some((t) => t.name === "Стол у окна"));

  // История нового клуба пуста — она и не должна переезжать.
  const history = await admin2.get("/api/history");
  assert.equal(history.body.length, 0);
  const clients = await admin2.get("/api/clients");
  assert.equal(clients.body.length, 0);
});

test("повторная загрузка не плодит столы и тарифы", async () => {
  const source = makeApp();
  const admin = await adminAgent(source.app);
  await createTable(admin, "Стол 1");
  await createTariff(admin, "Дневной", 400);
  const config = JSON.parse((await admin.get("/api/config/export")).text);

  const target = makeApp();
  const admin2 = await adminAgent(target.app);
  await admin2.post("/api/config/import").send(config);
  await admin2.post("/api/config/import").send(config);

  const tables = await admin2.get("/api/tables");
  assert.equal(tables.body.filter((t) => t.name === "Стол 1").length, 1);
  const tariffs = await admin2.get("/api/tariffs");
  assert.equal(tariffs.body.filter((t) => t.name === "Дневной").length, 1);
});

test("чужой файл отклоняется с понятным объяснением", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const empty = await admin.post("/api/config/import").send({});
  assert.equal(empty.status, 409);
  assert.match(empty.body.detail, /формат/i);

  const wrongFormat = await admin
    .post("/api/config/import")
    .send({ format: 99, settings: {} });
  assert.equal(wrongFormat.status, 409);
  assert.match(wrongFormat.body.detail, /формата/);

  const noSettings = await admin.post("/api/config/import").send({ format: 1 });
  assert.equal(noSettings.status, 409);
  assert.match(noSettings.body.detail, /не тот файл/);
});

test("тариф с историей не удаляется, а выключается", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const oldTariff = await createTariff(admin, "Старый тариф", 300);
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: oldTariff.id });
  await admin.post(`/api/tables/${table.id}/close`).send({});

  await admin.post("/api/config/import").send({
    format: 1,
    settings: { club_name: "Новый клуб" },
    tariffs: [{ name: "Новый тариф", price_per_hour: 500, is_active: true }],
  });

  const kept = db.prepare("SELECT is_active FROM tariffs WHERE name = ?").get("Старый тариф");
  assert.ok(kept, "тариф с историей остался — иначе сломалась бы история");
  assert.equal(kept.is_active, 0, "но выключен");

  const history = await admin.get("/api/history");
  assert.equal(history.body[0].tariff_name, "Старый тариф", "история цела");
});

test("цена стола переезжает вместе с настройкой", async () => {
  // Клуб-донор: столу назначен свой тариф.
  const source = makeApp();
  const donor = await adminAgent(source.app);
  const table = await createTable(donor, "Стол у окна");
  const дневной = await createTariff(donor, "Дневной", 400);
  await createTariff(donor, "Ночной", 900);
  await donor.put(`/api/tables/${table.id}/tariffs`).send({ tariff_id: дневной.id });

  const config = (await donor.get("/api/config/export")).body;
  const exported = config.tables.find((t) => t.name === "Стол у окна");
  assert.deepEqual(exported.tariff_names, ["Дневной"], "тариф выгружен по имени");

  // Клуб-приёмник: чистая база.
  const target = makeApp();
  const receiver = await adminAgent(target.app);
  const imported = await receiver.post("/api/config/import").send(config);
  assert.equal(imported.status, 200);

  const dashboard = await receiver.get("/api/dashboard");
  const row = dashboard.body.find((t) => t.name === "Стол у окна");
  assert.equal(row.tariff.name, "Дневной", "у стола та же цена, что и в доноре");
  assert.equal(row.tariff.price_per_hour, 400);
  assert.equal(row.tariff.assigned, true, "тариф именно закреплён, а не подобран");
});
