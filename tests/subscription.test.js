// Связь программы клуба с центральным хабом сети WesPro (вкладка
// «Настройки» → «Подписка»). Настоящий хаб в тестах не дёргаем —
// подменяем fetch и смотрим, что и куда отправляется, как в telegram.test.js.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgent, cashierAgent, makeApp } from "./helpers.js";

/** Подменяет fetch фиксированным ответом хаба. */
function captureHub(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return respond(calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("без ключа проверка отвечает понятной ошибкой, в сеть не ходит", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const calls = captureHub(t, () => {
    throw new Error("не должны были сюда дойти");
  });

  const res = await admin.post("/api/subscription/check");
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /личном кабинете/);
  assert.equal(calls.length, 0);
});

test("с ключом программа отмечается на связи и получает статус", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.put("/api/settings").send({
    wespro_hub_url: "https://hub.example.com",
    wespro_club_key: "секретный-ключ",
  });

  const calls = captureHub(t, () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: "active",
      status_label: "активна",
      blocked: false,
      days_left: 12,
      plan_name: "Базовый",
    }),
  }));

  const res = await admin.post("/api/subscription/check");
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.days_left, 12);
  assert.equal(res.body.plan_name, "Базовый");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hub.example.com/hub/api/agent/ping");
  assert.equal(calls[0].headers["X-Club-Key"], "секретный-ключ");
});

test("неверный ключ (401 от хаба) — понятная ошибка, а не падение", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.put("/api/settings").send({ wespro_club_key: "не тот ключ" });
  captureHub(t, () => ({ ok: false, status: 401, json: async () => ({}) }));

  const res = await admin.post("/api/subscription/check");
  assert.equal(res.status, 200, "сетевая проверка не 500 — это ожидаемый исход");
  assert.equal(res.body.connected, false);
  assert.match(res.body.error, /не подош/);
});

test("хаб недоступен — программа не падает, просто говорит об этом", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.put("/api/settings").send({ wespro_club_key: "ключ" });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const res = await admin.post("/api/subscription/check");
  globalThis.fetch = original;

  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.ok(res.body.error);
});

test("кассиру карточка подписки недоступна", async (t) => {
  const { db, app } = makeApp();
  const cashier = await cashierAgent(app, db);
  captureHub(t, () => {
    throw new Error("не должны были сюда дойти");
  });
  const res = await cashier.post("/api/subscription/check");
  assert.equal(res.status, 403);
});

test("ключ клуба виден в /api/settings — как токен Telegram, тот же уровень доступа", async (t) => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  await admin.put("/api/settings").send({ wespro_club_key: "мой-ключ" });
  const settings = await admin.get("/api/settings");
  assert.equal(settings.body.wespro_club_key, "мой-ключ");
});
