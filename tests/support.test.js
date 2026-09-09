// Инструменты поддержки: пакет диагностики, доктор данных, журнал запросов.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, cashierAgent, createTable, createTariff, developerAgent, makeApp } from "./helpers.js";

test("пакет диагностики отдаётся файлом и содержит нужные разделы", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  await createTable(admin, "Стол у окна");
  await admin.put("/api/settings").send({ telegram_bot_token: "123:SECRET" });

  const res = await dev.get("/api/support/report");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/plain/);
  assert.match(res.headers["content-disposition"], /attachment; filename="diagnostika-.*\.txt"/);

  const text = res.text;
  for (const title of [
    "ПАКЕТ ДИАГНОСТИКИ",
    "ПРОГРАММА",
    "БАЗА ДАННЫХ",
    "СКОЛЬКО ЗАПИСЕЙ В ТАБЛИЦАХ",
    "НАСТРОЙКИ КЛУБА",
    "СОТРУДНИКИ",
    "ЖУРНАЛ СОБЫТИЙ",
    "ЖУРНАЛ ОШИБОК",
  ]) {
    assert.ok(text.includes(title), `в отчёте есть раздел «${title}»`);
  }
  assert.ok(/tables: 1/.test(text), "число записей по таблицам посчитано");
  assert.ok(
    text.includes("Создан стол «Стол у окна»"),
    "журнал событий вошёл в отчёт — по нему и восстанавливают картину"
  );
});

test("секреты в пакет диагностики не попадают", async () => {
  const { db, app } = makeApp();
  // Ключи Tuya настраивает только разработчик — см. tests/settings.test.js.
  const dev = await developerAgent(app, db);
  await dev.put("/api/settings").send({
    telegram_bot_token: "123:SUPERSECRET",
    tuya_access_secret: "TUYASECRET",
    tuya_access_id: "TUYAID",
  });

  const text = (await dev.get("/api/support/report")).text;
  assert.ok(!text.includes("SUPERSECRET"), "токен Telegram скрыт");
  assert.ok(!text.includes("TUYASECRET"), "ключ Tuya скрыт");
  assert.ok(!text.includes("TUYAID"), "Access ID скрыт");
  assert.ok(text.includes("(задано, скрыто)"), "но видно, что значение задано");
  assert.ok(!/password_hash|scrypt|\$2[aby]\$/.test(text), "хэшей паролей нет");
});

test("доктор данных находит и чинит расхождение по столу", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);

  const clean = await dev.get("/api/support/checkup");
  assert.equal(clean.body.healthy, true, "на свежей базе всё в порядке");

  // Портим данные так, как это делает аварийное выключение компьютера.
  db.prepare("UPDATE tables SET status = 'busy' WHERE id = ?").run(table.id);

  const found = await dev.get("/api/support/checkup");
  assert.equal(found.body.healthy, false);
  const issue = found.body.issues.find((i) => i.code === "table-busy-no-session");
  assert.ok(issue, "нестыковка найдена");
  assert.equal(issue.count, 1);
  assert.equal(issue.fixable, true);

  const fixed = await dev
    .post("/api/support/fix")
    .send({ code: "table-busy-no-session" });
  assert.equal(fixed.body.total, 1);

  const after = await dev.get("/api/support/checkup");
  assert.equal(after.body.healthy, true, "починено");

  // Стол снова можно открыть.
  const tariff = await createTariff(admin);
  const opened = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(opened.status, 201);
});

test("доктор чинит чеки с несогласованным остатком", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);

  const opened = await admin.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 600,
    payment_method: "cash",
  });
  await admin.post(`/api/tables/${table.id}/close`).send({});
  const voucher = db.prepare("SELECT id, code FROM vouchers LIMIT 1").get();
  assert.ok(voucher, "чек на остаток выдан");

  // Портим: чек активен, но остаток нулевой.
  db.prepare("UPDATE vouchers SET balance_kopecks = 0 WHERE id = ?").run(voucher.id);

  const found = await dev.get("/api/support/checkup");
  const issue = found.body.issues.find((i) => i.code === "voucher-active-empty");
  assert.ok(issue, "пустой действующий чек найден");

  await dev.post("/api/support/fix").send({});
  const status = db.prepare("SELECT status FROM vouchers WHERE id = ?").get(voucher.id);
  assert.equal(status.status, "used", "чек помечен использованным");
  assert.ok(opened.body.id);
});

test("то, что решает человек, доктор не трогает", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });

  // Второй открытый сеанс на том же столе — так бывает после сбоя.
  db.prepare(
    `INSERT INTO table_sessions (table_id, tariff_id, price_per_hour_snapshot, started_at)
     VALUES (?, ?, ?, ?)`
  ).run(table.id, tariff.id, 600, new Date().toISOString());

  const found = await dev.get("/api/support/checkup");
  const issue = found.body.issues.find((i) => i.code === "two-open-sessions");
  assert.ok(issue, "два открытых сеанса найдены");
  assert.equal(issue.fixable, false, "автоматически не чиним");

  const attempt = await dev.post("/api/support/fix").send({ code: "two-open-sessions" });
  assert.match(attempt.body.note, /вручную/);
  const still = db
    .prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE ended_at IS NULL")
    .get().n;
  assert.equal(still, 2, "сеансы на месте — данные не потеряны");
});

test("журнал запросов пишет обращения и умеет чиститься", async () => {
  const { db, app } = makeApp();
  const dev = await developerAgent(app, db);
  await dev.get("/api/clients");
  await dev.get("/api/nope-not-found");

  const log = await dev.get("/api/support/requests");
  assert.equal(log.status, 200);
  const paths = log.body.requests.map((r) => r.path);
  assert.ok(paths.includes("/api/clients"), "обычный запрос записан");
  assert.ok(
    log.body.requests.every((r) => typeof r.ms === "number"),
    "время ответа замерено"
  );
  assert.ok(
    log.body.requests.some((r) => r.user?.includes("dev")),
    "видно, кто делал запрос"
  );
  assert.ok(
    !paths.includes("/api/dashboard"),
    "частый опрос дашборда журнал не забивает"
  );

  const errorsOnly = await dev.get("/api/support/requests?only_errors=true");
  assert.ok(
    errorsOnly.body.requests.every((r) => r.status >= 400),
    "фильтр по ошибкам работает"
  );

  await dev.delete("/api/support/requests");
  const afterClear = await dev.get("/api/support/requests");
  assert.ok(afterClear.body.requests.length <= 1, "журнал очищен");
});

test("инструменты поддержки закрыты от кассира и от гостей", async () => {
  const { db, app } = makeApp();
  await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const guest = supertest(app);

  for (const path of ["/api/support/report", "/api/support/checkup", "/api/support/requests"]) {
    assert.equal((await cashier.get(path)).status, 403, `${path} закрыт от кассира`);
    assert.equal((await guest.get(path)).status, 401, `${path} закрыт от гостей`);
  }
  assert.equal((await cashier.post("/api/support/fix").send({})).status, 403);
});

test("перезапуск программы доступен разработчику и записывается в журнал", async (t) => {
  const { db, app } = makeApp();
  const dev = await developerAgent(app, db);

  // Настоящий process.exit в тестах вызывать нельзя — подменяем.
  const original = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
  };
  t.after(() => {
    process.exit = original;
  });

  const res = await dev.post("/api/system/restart");
  assert.equal(res.status, 200);
  assert.match(res.body.note, /перезапускается/i);

  const journal = await dev.get("/api/journal");
  assert.ok(
    journal.body.some((e) => /Перезапуск программы из интерфейса/.test(e.message)),
    "перезапуск виден в журнале"
  );

  // Выход происходит с задержкой, чтобы ответ успел уйти в браузер.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(exitCode, 7, "выход кодом 7 — его ловит run-server.bat");
});

test("перезапуск закрыт от кассира", async () => {
  const { db, app } = makeApp();
  await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  assert.equal((await cashier.post("/api/system/restart")).status, 403);
});

test("версия схемы базы записана и видна в диагностике", async () => {
  const { db, app } = makeApp();
  const dev = await developerAgent(app, db);

  const stored = db
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get();
  assert.ok(stored, "версия схемы записана в саму базу");

  const diag = await dev.get("/api/diagnostics");
  assert.equal(
    diag.body.database.schema_version,
    diag.body.database.schema_version_expected,
    "свежая база совпадает с программой"
  );
  assert.ok(
    diag.body.database.schema_history.length > 0,
    "видно, что появлялось в каждой версии"
  );

  const report = (await dev.get("/api/support/report")).text;
  assert.ok(report.includes("ЧТО ПОЯВЛЯЛОСЬ В СХЕМЕ"), "история схемы попала в отчёт");
});
