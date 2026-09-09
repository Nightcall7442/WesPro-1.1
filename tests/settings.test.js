// Тесты вкладки «Настройки»: сохранение подключения Tuya и привязка
// столов к реле — всё через API, без правки файлов.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, cashierAgent, createTable, developerAgent, makeApp } from "./helpers.js";

test("настройки по умолчанию: драйвер mock", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  const res = await request.get("/api/settings");
  assert.equal(res.status, 200);
  assert.equal(res.body.lighting_driver, "mock");
  assert.equal(res.body.driver_active, "mock");
});

test("сохранение настроек: значения возвращаются обратно", async () => {
  const { db, app } = makeApp();
  const request = await developerAgent(app, db);

  const res = await request.put("/api/settings").send({
    lighting_driver: "mock",
    tuya_access_id: "my-id",
    tuya_access_secret: "my-secret",
    tuya_api_host: "https://openapi.tuyaeu.com",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.tuya_access_id, "my-id");
  assert.equal(res.body.driver_active, "mock");

  const again = await request.get("/api/settings");
  assert.equal(again.body.tuya_access_id, "my-id");
});

test("ключи Tuya не видны никому, кроме разработчика", async () => {
  const { db, app } = makeApp();
  const dev = await developerAgent(app, db);
  await dev.put("/api/settings").send({
    tuya_access_id: "my-id",
    tuya_access_secret: "my-secret",
  });

  const admin = await adminAgent(app);
  const seen = await admin.get("/api/settings");
  assert.equal(seen.status, 200);
  assert.equal(seen.body.tuya_access_id, "", "Access ID скрыт от не-разработчика");
  assert.equal(seen.body.tuya_access_secret, "", "Access Secret скрыт от не-разработчика");

  const devSees = await dev.get("/api/settings");
  assert.equal(devSees.body.tuya_access_id, "my-id", "разработчику ключи видны");
});

test("драйвер tuya без ключей: сервер остаётся на mock и сообщает причину", async () => {
  const { db, app } = makeApp();
  const request = await developerAgent(app, db);

  const res = await request.put("/api/settings").send({
    lighting_driver: "tuya",
    tuya_access_id: "",
    tuya_access_secret: "",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.driver_active, "mock");
  assert.match(res.body.driver_error, /Access/);
});

test("недопустимый драйвер отклоняется", async () => {
  const { db, app } = makeApp();
  const request = await developerAgent(app, db);

  const res = await request
    .put("/api/settings")
    .send({ lighting_driver: "zigbee" });
  assert.equal(res.status, 409);
});

test("привязка стола к устройству сохраняется и видна в списке столов", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);

  const res = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ device_id: "bf-device-1", switch_code: "switch_2" });
  assert.equal(res.status, 200);
  assert.equal(res.body.tuya_device_id, "bf-device-1");
  assert.equal(res.body.tuya_switch_code, "switch_2");

  const list = await admin.get("/api/tables");
  assert.equal(list.body[0].tuya_device_id, "bf-device-1");

  // Отвязка.
  const cleared = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ device_id: null });
  assert.equal(cleared.body.tuya_device_id, null);
  assert.equal(cleared.body.tuya_switch_code, null);
});

test("недопустимый канал реле отклоняется", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);

  const res = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ device_id: "bf-1", switch_code: "switch_9" });
  assert.equal(res.status, 409);
});

test("список устройств без настроенного Tuya — понятная ошибка", async () => {
  const { db, app } = makeApp();
  const request = await developerAgent(app, db);

  const res = await request.get("/api/settings/devices");
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /не настроено/);
});

test("настройка реле в общих настройках закрыта от не-разработчика", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);

  for (const agent of [admin, cashier]) {
    const patch = await agent
      .put("/api/settings")
      .send({ lighting_driver: "tuya", tuya_access_id: "x", tuya_access_secret: "y" });
    assert.equal(patch.status, 403, "ключи Tuya не сохранить без роли разработчика");

    const devices = await agent.get("/api/settings/devices");
    assert.equal(devices.status, 403);
  }

  // Обычные настройки клуба при этом по-прежнему доступны администратору.
  const clubOnly = await admin.put("/api/settings").send({ club_name: "Клуб" });
  assert.equal(clubOnly.status, 200, "название клуба и другие настройки — не про реле");
});

test("ручной тест реле включает и выключает свет", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);

  const on = await request
    .post(`/api/tables/${table.id}/light`)
    .send({ on: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.light_on, true);

  const off = await request
    .post(`/api/tables/${table.id}/light`)
    .send({ on: false });
  assert.equal(off.body.light_on, false);
});

test("логотип клуба: сохраняется, отдаётся на странице входа и убирается", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  // 1x1 прозрачный PNG.
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
    "YPjPAAACAgEAqiqeJwAAAABJRU5ErkJggg==";

  const saved = await admin.put("/api/settings").send({ club_logo: png });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.club_logo, png);

  // Логотип и название доступны до входа — их показывает страница входа.
  const brand = await supertest(app).get("/api/brand");
  assert.equal(brand.status, 200);
  assert.equal(brand.body.club_logo, png);
  assert.ok(brand.body.club_name);

  // И приходят вошедшему сотруднику — для шапки.
  const me = await admin.get("/api/auth/me");
  assert.equal(me.body.club_logo, png);

  // Убрать логотип — пустая строка.
  const cleared = await admin.put("/api/settings").send({ club_logo: "" });
  assert.equal(cleared.body.club_logo, "");
});

test("логотипом можно поставить только картинку", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  for (const bad of [
    "https://example.com/logo.png",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "<script>alert(1)</script>",
  ]) {
    const res = await admin.put("/api/settings").send({ club_logo: bad });
    assert.equal(res.status, 409, `отклонено: ${bad.slice(0, 30)}`);
  }
});

test("масштаб логотипа: сохраняется и проверяется на разумность", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const saved = await admin.put("/api/settings").send({ club_logo_height: "48" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.club_logo_height, "48");

  // Высота приходит и на страницу входа (там логотип тоже показывается).
  const brand = await admin.get("/api/brand");
  assert.equal(brand.body.club_logo_height, 48);
  assert.equal((await admin.get("/api/auth/me")).body.club_logo_height, 48);

  for (const bad of ["0", "5", "500", "не число"]) {
    const res = await admin.put("/api/settings").send({ club_logo_height: bad });
    assert.equal(res.status, 409, `отклонено: ${bad}`);
  }
});

test("предупреждение о конце времени: минуты и звук настраиваются", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const before = await admin.get("/api/settings");
  assert.equal(before.body.warn_before_minutes, "5", "по умолчанию 5 минут");
  assert.equal(before.body.warn_sound, "1", "звук включён");

  const saved = await admin
    .put("/api/settings")
    .send({ warn_before_minutes: "10", warn_sound: "0" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.warn_before_minutes, "10");

  const me = await admin.get("/api/auth/me");
  assert.equal(me.body.warn_before_minutes, 10, "страница получает число");
  assert.equal(me.body.warn_sound, false);

  const off = await admin.put("/api/settings").send({ warn_before_minutes: "0" });
  assert.equal(off.status, 200, "0 — предупреждать не надо");

  const bad = await admin.put("/api/settings").send({ warn_before_minutes: "999" });
  assert.equal(bad.status, 409);
  const badSound = await admin.put("/api/settings").send({ warn_sound: "да" });
  assert.equal(badSound.status, 409);
});

test("ширина чековой ленты настраивается", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const before = await admin.get("/api/settings");
  assert.equal(before.body.receipt_width, "80", "по умолчанию лента 80 мм");

  const narrow = await admin.put("/api/settings").send({ receipt_width: "58" });
  assert.equal(narrow.status, 200);
  assert.equal(narrow.body.receipt_width, "58");

  const me = await admin.get("/api/auth/me");
  assert.equal(me.body.receipt_width, "58", "страница знает ширину ленты");

  const a4 = await admin.put("/api/settings").send({ receipt_width: "a4" });
  assert.equal(a4.status, 200);

  const bad = await admin.put("/api/settings").send({ receipt_width: "100" });
  assert.equal(bad.status, 409);
});
