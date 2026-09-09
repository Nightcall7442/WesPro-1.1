// Диагностика: причина внутренней ошибки должна попадать и в ответ
// сервера, и в журнал ошибок — иначе «Внутренняя ошибка сервера» в
// браузере не даёт ни малейшей подсказки, что случилось.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { ROOT_DIR } from "../src/config.js";
import { diagnostics, logServerError, readRecentErrors } from "../src/services/diagnostics.js";
import { adminAgent, cashierAgent, developerAgent, makeApp } from "./helpers.js";

const LOG_PATH = path.join(ROOT_DIR, "logs", "errors.log");

test("состояние базы: целостность, права на запись, размеры", () => {
  const { db } = makeApp();
  const info = diagnostics(db);
  assert.ok(info.version, "версия программы известна");
  assert.equal(info.database.integrity, "ok", "база цела");
  assert.equal(typeof info.database.folder_writable, "boolean");
  assert.equal(typeof info.uptime_seconds, "number");
  assert.ok(Array.isArray(info.errors));
});

test("ошибка попадает в журнал с запросом и пользователем", () => {
  const marker = `проверочная ошибка ${Date.now()}`;
  logServerError(new Error(marker), {
    method: "PUT",
    originalUrl: "/api/plan",
    user: { login: "kassir", role: "cashier" },
  });

  // Свежая запись — первая в списке (журнал отдаётся новыми сверху).
  const entry = readRecentErrors(5)[0];
  assert.ok(entry, "журнал не пуст");
  assert.match(entry, /PUT \/api\/plan/, "видно, какой запрос упал");
  assert.match(entry, /kassir \(cashier\)/, "видно, кто работал");
  assert.match(entry, new RegExp(marker), "видно саму ошибку");
});

test("500 возвращает причину, а не только «внутренняя ошибка»", async () => {
  // Ломаем базу так, как это может случиться на живой установке
  // (файл повреждён, таблица недоступна) — и смотрим, что ответ говорит,
  // ЧТО именно случилось, а не просто «внутренняя ошибка сервера».
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  assert.equal((await admin.get("/api/plan")).status, 200, "до поломки план читается");

  db.exec("DROP TABLE plan_elements");

  const res = await admin.get("/api/plan");
  assert.equal(res.status, 500);
  assert.match(res.body.detail, /plan_elements/, "в ответе видно, что не так");
  assert.ok(res.body.reason, "причина отдана отдельным полем");

  // И та же ошибка легла в журнал — её видно в «Настройки → Диагностика».
  assert.match(readRecentErrors(5)[0], /plan_elements/);
  assert.match(readRecentErrors(5)[0], /GET \/api\/plan/);
});

test("GET /api/diagnostics: доступно только разработчику", async () => {
  const { app, db } = makeApp();
  const developer = await developerAgent(app, db);
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);

  const res = await developer.get("/api/diagnostics");
  assert.equal(res.status, 200);
  assert.equal(res.body.database.integrity, "ok");
  assert.ok(res.body.version);
  assert.ok(Array.isArray(res.body.errors));

  assert.equal((await admin.get("/api/diagnostics")).status, 403, "владельцу/админу закрыто");
  assert.equal((await cashier.get("/api/diagnostics")).status, 403);
});

test("журнал ошибок не растёт бесконечно", () => {
  // Пишем много записей и проверяем, что файл остаётся в разумных
  // пределах (лог подрезается сам).
  for (let i = 0; i < 400; i += 1) {
    logServerError(new Error(`шум ${i} ${"x".repeat(200)}`), {
      method: "GET",
      originalUrl: "/api/plan",
    });
  }
  const size = fs.statSync(LOG_PATH).size;
  assert.ok(size < 1024 * 1024, `размер журнала ${size} байт — в пределах разумного`);
});
